import type { HaEntity } from "@pva/module-contracts"
import { Effect } from "effect"
import { type HomeAssistantClient, HomeAssistantError } from "./client.ts"
import {
  type Area,
  BRIGHTNESS_MODES,
  CHOICE_KINDS,
  type ChoiceKind,
  type DecodedPage,
  decodePage,
  type Domain,
  type Entity,
  type House,
  HOUSE_LIMITS,
  HVAC_MODES,
  keepChars,
  type Kind,
  KIND_DOMAINS,
  namedIds,
  ownerAliasesOf,
  PAGE_TEMPLATE,
  type PageVariables,
  pageRows,
  SENSOR_CLASSES,
  type TemperatureUnit,
  toAreas,
  toEntity
} from "./house.ts"
import { sanitize, type Secrets } from "./redact.ts"
import { secretForms } from "./secrets.ts"
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

/** Home Assistant's answer when a rendered template is over its own limit (`TemplateError` of the template API, HTTP 400). */
export const TEMPLATE_TOO_LARGE = "Template output exceeded maximum size"

/**
 * Read the house in pages: the areas (pages of their own), people, then the exposed kinds, then the module's other
 * kinds, at most `HOUSE_LIMITS.supported` entities in all, then the scenes the owner named (every one of them, in pages,
 * none twice). Each page asks for as many rows as the worst legal row lets fit Home Assistant's template limit
 * (`pageRows`); one that still meets the limit (Home Assistant's exact 400 answer), or the reader's byte limit, is
 * asked again in eighths, and no other failure is. Each page is decoded on its own, with a real yield after it, so the
 * main thread is never held for the whole house; nothing is published until every page was read. Within `limitMs`.
 */
export const readHouse = (o: ReadOptions): Effect.Effect<ReadHouse, HomeAssistantError> => {
  const forms = secretForms(o.secrets)
  const owner = ownerAliasesOf(o.aliases)
  const named = namedIds(o.aliases)
  const namedScenes = new Set(named.scenes)
  const keep = keepChars(forms)
  const invalid = (problem: string) =>
    new HomeAssistantError(sanitize(o.secrets, { message: "Home Assistant sent a room list this module cannot read.", kind: "invalid", detail: `POST /api/template: ${problem}` }))

  const page = (vars: PageVariables) =>
    o.client.renderTemplate(PAGE_TEMPLATE, vars as unknown as Readonly<Record<string, unknown>>, { timeoutMs: o.limitMs, maxBytes: HOUSE_LIMITS.pageBytes }).pipe(
      Effect.flatMap((text) => {
        const decoded = decodePage(text, forms, vars.mode)
        return decoded.ok ? Effect.succeed(decoded) : Effect.fail(invalid(decoded.problem))
      })
    )

  /** Too large for one page: Home Assistant's own template limit, or more bytes than the reader takes. Nothing else. */
  const tooLarge = (e: HomeAssistantError) =>
    (e.kind === "http" && e.status === 400 && e.detail.includes(TEMPLATE_TOO_LARGE)) || (e.kind === "invalid" && e.detail.includes("more than") && e.detail.includes("bytes"))

  /** One page, asked again with fewer rows while it is too large (one row always fits: `worstRow`). */
  const pageFitting = (vars: PageVariables): Effect.Effect<Extract<DecodedPage, { ok: true }>, HomeAssistantError> =>
    Effect.catchIf(page(vars), (e) => tooLarge(e) && vars.size > 1, () => pageFitting({ ...vars, size: Math.max(1, Math.floor(vars.size / 8)) }))

  const base = { keep, classes: SENSOR_CLASSES as ReadonlyArray<string>, hvac: HVAC_MODES as ReadonlyArray<string>, dim_modes: BRIGHTNESS_MODES as ReadonlyArray<string>, max_members: HOUSE_LIMITS.sceneMembers + 1 }

  const run = Effect.gen(function*() {
    let leftOut = 0
    let secretDropped = 0
    const incomplete = new Set<Kind>()
    const entities: Array<Entity> = []
    const exposed: Array<{ entity: HaEntity; json: string }> = []
    const seen = new Set<string>()

    // The areas, in pages of their own: their size does not depend on the entity pages (a long list of long names).
    const areaRows: Array<{ id: string; name: string }> = []
    let areaAfter = ""
    for (;;) {
      const got = yield* pageFitting({ ...base, mode: "areas", domains: [], ids: null, after: areaAfter, size: Math.min(pageRows("area", keep), HOUSE_LIMITS.areas + 1 - areaRows.length) })
      leftOut += got.leftOut
      secretDropped += got.secretDropped
      areaRows.push(...(got.areas ?? []))
      yield* Effect.yieldNow
      if (!got.more || areaRows.length > HOUSE_LIMITS.areas) break
      if (got.last === undefined || got.last <= areaAfter) return yield* Effect.fail(invalid("a page of areas did not move on"))
      areaAfter = got.last
    }
    const shaped = toAreas(areaRows, owner)
    const areas: Array<Area> = shaped.areas
    leftOut += shaped.leftOut
    const areaIds = new Set(areas.map((a) => a.id))

    const passes: ReadonlyArray<{ readonly kinds: ReadonlyArray<Kind> }> = [
      { kinds: ["person"] },
      { kinds: CHOICE_KINDS.filter((k) => o.exposed.has(k)) },
      { kinds: CHOICE_KINDS.filter((k) => !o.exposed.has(k)) }
    ]
    let budget: number = HOUSE_LIMITS.supported
    for (const [index, pass] of passes.entries()) {
      if (pass.kinds.length === 0) continue
      const domains = domainsOf(pass.kinds)
      let after = ""
      for (;;) {
        const size = Math.min(pageRows("entity", keep), budget)
        const got = yield* pageFitting({ ...base, mode: "entities", domains, ids: null, after, size })
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

    // Every named scene, in pages after the last one seen: a page that had to shrink is followed by the rest.
    let sceneAfter = ""
    while (named.scenes.length > 0) {
      const got = yield* pageFitting({ ...base, mode: "entities", domains: ["scene"], ids: named.scenes, after: sceneAfter, size: Math.min(pageRows("scene", keep), named.scenes.length) })
      leftOut += got.leftOut
      secretDropped += got.secretDropped
      for (const row of got.rows) {
        if (row.domain !== "scene" || !namedScenes.has(row.id) || seen.has(row.id)) continue
        seen.add(row.id)
        entities.push(toEntity(row, owner, areaIds, namedScenes))
      }
      yield* Effect.yieldNow
      if (!got.more) break
      if (got.last === undefined || got.last <= sceneAfter) return yield* Effect.fail(invalid("a page of scenes did not move on"))
      sceneAfter = got.last
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
