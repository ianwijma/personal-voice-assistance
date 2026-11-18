import type { HaEntity } from "@pva/module-contracts"
import { Effect } from "effect"
import { type HomeAssistantClient, HomeAssistantError } from "./client.ts"
import {
  type Area,
  CHOICE_KINDS,
  type ChoiceKind,
  decodePage,
  type Domain,
  type Entity,
  type House,
  HOUSE_LIMITS,
  keepChars,
  type Kind,
  KIND_DOMAINS,
  namedIds,
  ownerAliasesOf,
  PAGE_TEMPLATE,
  type PageVariables,
  SENSOR_CLASSES,
  type TemperatureUnit,
  toAreas,
  toEntity
} from "./house.ts"
import { sanitize, type Secrets } from "./redact.ts"
import { toHaEntity } from "./service.ts"

/** A house as read, with what the `HomeAssistant` service exposes of it, each entity with its JSON (for comparing). */
export interface ReadHouse {
  readonly house: House
  /** People and the kinds exposed (the shared `domains` when the read started), by id in id order. */
  readonly exposed: ReadonlyArray<{ readonly entity: HaEntity; readonly json: string }>
}

export interface ReadOptions {
  readonly client: HomeAssistantClient
  readonly secrets: Secrets
  readonly aliases: string
  /** The kinds the service exposes (the shared `domains`): read right after people, before the module's other kinds. */
  readonly exposed: ReadonlySet<ChoiceKind>
  readonly limitMs: number
  readonly now: number
  readonly temperatureUnit: TemperatureUnit | undefined
}

const domainsOf = (kinds: ReadonlyArray<Kind>): Array<Domain> => kinds.flatMap((k) => [...KIND_DOMAINS[k]])

/**
 * Read the house in pages: people, then the exposed kinds, then the module's other kinds, then the scenes the owner
 * named, at most `HOUSE_LIMITS.supported` entities in all (scenes apart). Each page is one request of at most
 * `HOUSE_LIMITS.pageBytes` (a page that is larger is asked again in eighths) and is decoded on its own, with a real
 * yield after it, so the main thread is never held for the whole house. Everything within `limitMs`.
 */
export const readHouse = (o: ReadOptions): Effect.Effect<ReadHouse, HomeAssistantError> => {
  const secrets = o.secrets.filter((s): s is string => typeof s === "string" && s.length > 0)
  const owner = ownerAliasesOf(o.aliases)
  const named = namedIds(o.aliases)
  const namedScenes = new Set(named.scenes)
  const keep = keepChars(secrets)
  const invalid = (problem: string) =>
    new HomeAssistantError(sanitize(secrets, { message: "Home Assistant sent a room list this module cannot read.", kind: "invalid", detail: `POST /api/template: ${problem}` }))

  const page = (vars: PageVariables) =>
    o.client.renderTemplate(PAGE_TEMPLATE, vars as unknown as Readonly<Record<string, unknown>>, { timeoutMs: o.limitMs, maxBytes: HOUSE_LIMITS.pageBytes }).pipe(
      Effect.flatMap((text) => {
        const decoded = decodePage(text, secrets)
        return decoded.ok ? Effect.succeed(decoded) : Effect.fail(invalid(decoded.problem))
      })
    )

  /** One page, asked again with fewer rows while its answer is too large (a row is never larger than a page). */
  const pageFitting = (vars: PageVariables): Effect.Effect<Extract<ReturnType<typeof decodePage>, { ok: true }>, HomeAssistantError> =>
    Effect.catchIf(page(vars), (e) => e.kind === "invalid" && e.detail.includes("bytes") && vars.size > 1, () => pageFitting({ ...vars, size: Math.max(1, Math.floor(vars.size / 8)) }))

  const run = Effect.gen(function*() {
    const passes: ReadonlyArray<{ readonly kinds: ReadonlyArray<Kind> }> = [
      { kinds: ["person"] },
      { kinds: CHOICE_KINDS.filter((k) => o.exposed.has(k)) },
      { kinds: CHOICE_KINDS.filter((k) => !o.exposed.has(k)) }
    ]
    let budget: number = HOUSE_LIMITS.supported
    let areaRows: Array<{ id: string; name: string }> | undefined
    let areaIds = new Set<string>()
    let areas: Array<Area> = []
    let leftOut = 0
    let secretDropped = 0
    const incomplete = new Set<Kind>()
    const entities: Array<Entity> = []
    const seen = new Set<string>()
    const exposed: Array<{ entity: HaEntity; json: string }> = []
    const base = { keep, classes: SENSOR_CLASSES as ReadonlyArray<string>, max_areas: HOUSE_LIMITS.areas + 1, max_members: HOUSE_LIMITS.sceneMembers + 1 }

    for (const [index, pass] of passes.entries()) {
      if (pass.kinds.length === 0) continue
      const domains = domainsOf(pass.kinds)
      let after = ""
      for (;;) {
        const size = Math.min(HOUSE_LIMITS.pageRows, budget)
        const got = yield* pageFitting({ ...base, domains, after, size, with_areas: areaRows === undefined, ids: null })
        if (areaRows === undefined) {
          areaRows = [...(got.areas ?? [])]
          const shaped = toAreas(areaRows, owner)
          areas = shaped.areas
          leftOut += shaped.leftOut
          areaIds = new Set(areas.map((a) => a.id))
        }
        leftOut += got.leftOut
        secretDropped += got.secretDropped
        for (const row of got.rows) {
          // A row of another kind than the page asked for, or one that came already: not what was asked, left out.
          if (!domains.includes(row.domain) || seen.has(row.id)) {
            leftOut++
            continue
          }
          seen.add(row.id)
          const e = toEntity(row, owner, areaIds, namedScenes)
          entities.push(e)
          if (index < 2) {
            const ha = toHaEntity(e)
            exposed.push({ entity: ha, json: JSON.stringify(ha) })
          }
        }
        budget -= got.rows.length
        // A real yield after each page: the main thread is free between them, whatever the network did.
        yield* Effect.yieldNow
        if (!got.more) break
        if (budget <= 0) {
          for (const k of pass.kinds) incomplete.add(k)
          break
        }
        if (got.last === undefined || got.last <= after) return yield* Effect.fail(invalid("a page did not move on"))
        after = got.last
      }
    }
    if (named.scenes.length > 0) {
      const got = yield* pageFitting({ ...base, domains: ["scene"], after: "", size: named.scenes.length, with_areas: false, ids: named.scenes })
      leftOut += got.leftOut
      secretDropped += got.secretDropped
      for (const row of got.rows) {
        if (row.domain !== "scene" || !namedScenes.has(row.id) || seen.has(row.id)) continue
        seen.add(row.id)
        entities.push(toEntity(row, owner, areaIds, namedScenes))
      }
      yield* Effect.yieldNow
    }
    entities.sort((x, y) => (x.entityId < y.entityId ? -1 : x.entityId > y.entityId ? 1 : 0))
    exposed.sort((x, y) => (x.entity.entityId < y.entity.entityId ? -1 : x.entity.entityId > y.entity.entityId ? 1 : 0))
    const house: House = {
      areas,
      entities,
      byId: new Map(entities.map((e) => [e.entityId, e])),
      incomplete,
      leftOut,
      secretDropped,
      temperatureUnit: o.temperatureUnit,
      fetchedAt: o.now
    }
    return { house, exposed }
  })

  return run.pipe(
    Effect.timeoutOrElse({
      duration: o.limitMs,
      orElse: () => Effect.fail(new HomeAssistantError({ message: "Home Assistant didn't answer in time.", kind: "timeout", detail: `POST /api/template: the house was not read within ${o.limitMs} ms` }))
    })
  )
}
