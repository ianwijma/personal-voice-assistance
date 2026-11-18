import {
  ActionError,
  CurrentTurn,
  defineAction,
  defineModule,
  type HostView,
  makeTool,
  type ModuleDefinition,
  type PeopleService,
  Param,
  People,
  type Person,
  Privacy,
  Setting,
  ToolError
} from "@pva/core"
import { type HaPerson, HomeAssistant, homeLanguage, isLine, providerOffText, say, StoredText } from "@pva/module-contracts"
import { Clock, Effect, Schema, Stream } from "effect"
import { texts } from "./texts.ts"

export { texts }

type Lang = ReturnType<typeof homeLanguage>

/** The most people one answer names (the household is small; the rest is "and N more"). */
const MAX_NAMED = 4
/** The most people the module follows: one record per Home Assistant person. */
const MAX_LINKS = 20
/** How soon after a person is seen leaving the next poll of the stream may be retried, and how long a missing provider is waited for. */
const RETRY_MS = 2_000
const PROVIDER_WAIT_MS = 5_000

const PERSON_ENTITY = /^person\.[a-z0-9_]{1,60}$/

const explainEntity = (v: string): string | undefined =>
  PERSON_ENTITY.test(v) ? undefined : "A Home Assistant person looks like person.sam (lower case letters, digits and _)."

const explainLinks = (items: ReadonlyArray<{ readonly haPerson: string; readonly member: string }>): string | undefined => {
  const entities = new Set<string>()
  const members = new Set<string>()
  for (const item of items) {
    if (item.member.trim() === "" || !isLine(item.member, 60)) return "Every person needs the name of a household member, on one line."
    if (entities.has(item.haPerson)) return `${item.haPerson} is linked twice.`
    const key = item.member.trim().toLowerCase()
    if (members.has(key)) return `${item.member.trim()} is linked twice.`
    entities.add(item.haPerson)
    members.add(key)
  }
  return undefined
}

const settings = {
  people: Setting.records({
    label: "People",
    description: "Which Home Assistant person is which household member. Only linked people are followed, and where they are is said only as the privacy rule allows.",
    itemLabel: "person",
    titleKey: "haPerson",
    maxItems: MAX_LINKS,
    item: {
      haPerson: Setting.text({ label: "Home Assistant person", placeholder: "person.sam", maxLength: 70, check: explainEntity }),
      member: Setting.text({ label: "Household member", description: "The member's name as in Members.", maxLength: 60 })
    },
    check: explainLinks
  }),
  departureDelayMinutes: Setting.number({
    label: "Departure delay",
    description: "How long someone must stay away before they count as having left (a walk to the car is not leaving).",
    default: 3,
    integer: true,
    min: 0,
    max: 60,
    unit: "minutes"
  })
}

type Link = { readonly haPerson: string; readonly member: string }

/** A member by id or by the name the owner typed; an ambiguous or unknown name is nobody. Looked up at each use. */
const memberOf = (people: PeopleService, ref: string): Person | undefined => {
  const byId = people.get(ref)
  if (byId !== undefined) return byId
  const found = people.find(ref)
  return found.kind === "found" ? found.person : undefined
}

const isNoise = (state: string): boolean => state === "unknown" || state === "unavailable"

/** A moment as the model words it: the time in the household's zone, with the date when it is not today. */
const sinceText = (at: number, now: number, zone: string): string => {
  const parts = (t: number) => {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    const o: Record<string, string> = {}
    for (const p of f.formatToParts(t)) o[p.type] = p.value
    return { day: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}` }
  }
  const a = parts(at)
  return a.day === parts(now).day ? a.time : `${a.day} ${a.time}`
}

const zoneOf = (view: Pick<HostView, "home">): string => {
  const wanted = view.home.HOME_TIME_ZONE
  const machine = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (typeof wanted !== "string" || wanted.trim() === "") return machine
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: wanted })
    return wanted
  } catch {
    return machine
  }
}

interface Row {
  readonly name: string
  readonly at: "home" | "out" | "unknown"
  readonly since?: string
  readonly owner: string
}

type Gathered =
  | { readonly kind: "spoken"; readonly text: string }
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<Row>; readonly withheld: number; readonly stale: boolean }

export const presenceModule = defineModule({
  apiVersion: 2,
  id: "presence",
  name: "Presence",
  description: "Who is home, and who has just arrived or left, from Home Assistant's people.",
  enabledByDefault: false,
  uses: ["home-assistant"],
  settings,
  // Nothing is stored: where a person is lives in Home Assistant, and a pending departure is a job.
  health: ({ settings: s }) =>
    Effect.succeed(
      s === undefined || s.people.length === 0
        ? [{
          id: "presence.no-people",
          severity: "info" as const,
          title: "No people linked",
          detail: "Link each Home Assistant person to a household member in the module's settings, or nobody's whereabouts are known."
        }]
        : []
    ),
  shared: (ctx) =>
    Effect.gen(function*() {
      const links = (): ReadonlyArray<Link> => ctx.settings.people ?? []
      const delayMs = (ctx.settings.departureDelayMinutes ?? 3) * 60_000
      const linkOf = (entityId: string): Link | undefined => links().find((l) => l.haPerson === entityId)
      const memberFor = (entityId: string): Person | undefined => {
        const link = linkOf(entityId)
        const people = ctx.host.service(People)
        return link === undefined || people === undefined ? undefined : memberOf(people, link.member)
      }
      const left = (entityId: string, at: number) =>
        Effect.gen(function*() {
          const member = memberFor(entityId)
          // A person who is not (or no longer) a member is revealed nowhere, not even by an event.
          if (member !== undefined) yield* ctx.events.publish("left", { person: member.id, at })
        })

      // The departure, a delay after it was seen: a job, so a restart in between does not lose it. When it runs the
      // person must still be away; one who came back (or whom Home Assistant no longer knows) did not leave.
      yield* ctx.scheduler.handle("left", {
        payload: Schema.Struct({ entityId: Schema.String.check(Schema.isMaxLength(80)), at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })) }),
        // Publishing twice would announce the departure twice: never retried.
        idempotent: false,
        retries: 0,
        run: ({ entityId, at }) =>
          Effect.gen(function*() {
            const entity = ctx.host.service(HomeAssistant)?.entity(entityId)
            if (entity === undefined || entity.state === "home" || isNoise(entity.state)) return
            yield* left(entityId, at)
          })
      }).pipe(Effect.orDie)

      const onChange = (change: import("@pva/module-contracts").HaChange) =>
        Effect.gen(function*() {
          // A snapshot is a state, not news: after a reconnect, an overflow or the first load nobody has just arrived.
          if (change._tag !== "changed" || change.entity.domain !== "person") return
          const now = change.entity.state
          const before = change.previous?.state
          if (before === undefined) return
          const entityId = change.entity.entityId
          if (linkOf(entityId) === undefined) return
          const wasAway = before !== "home" && !isNoise(before)
          const nowAway = now !== "home" && !isNoise(now)
          const key = `left:${entityId}`
          if (before === "home" && nowAway) {
            if (delayMs === 0) return yield* left(entityId, change.entity.lastChanged)
            yield* ctx.scheduler.schedule({ handler: "left", key, payload: { entityId, at: change.entity.lastChanged }, inMs: delayMs }).pipe(
              // A departure that cannot be scheduled is dropped rather than announced early; the log has the reason.
              Effect.catch((e) => Effect.logWarning(`presence: departure of ${entityId} not scheduled: ${e.message}`))
            )
          } else if (wasAway && now === "home") {
            // Back within the delay: they never left, so there is nothing to announce.
            const pending = yield* ctx.scheduler.cancel({ key }).pipe(Effect.catch(() => Effect.succeed(false)))
            const member = memberFor(entityId)
            if (!pending && member !== undefined) yield* ctx.events.publish("arrived", { person: member.id, at: change.entity.lastChanged })
          }
        })

      // Home Assistant's changes, for as long as this part lives. The provider is looked up again each time the
      // stream ends: after its restart it is a new provider.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function*() {
            const ha = ctx.host.service(HomeAssistant)
            if (ha === undefined) return yield* Effect.sleep(PROVIDER_WAIT_MS)
            yield* Stream.runForEach(ha.changes(), onChange).pipe(Effect.catchCause(() => Effect.void))
            yield* Effect.sleep(RETRY_MS)
          })
        )
      )
      return { value: undefined }
    }),
  start: (ctx) =>
    Effect.sync(() => {
      const view = () => ctx.host.view()

      /** Who the answer is about and what may be said of them on the asking device, at this moment. */
      const gather = (lang: Lang, asked: string | undefined): Effect.Effect<Gathered, never, never> =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const ha = ctx.host.service(HomeAssistant)
          const people = ctx.host.service(People)
          if (ha === undefined) return { kind: "spoken", text: providerOffText(lang, "Home Assistant") } as const
          if (people === undefined) return { kind: "spoken", text: say(texts, lang, "unreadable") } as const
          const links = ctx.settings.people
          if (links.length === 0) return { kind: "spoken", text: say(texts, lang, "notSet") } as const
          const connection = ha.connection()
          if (connection === "unknown") return { kind: "spoken", text: say(texts, lang, "noState") } as const
          let only: Person | undefined
          if (asked !== undefined) {
            const byId = people.get(asked)
            const match = byId !== undefined ? { kind: "found", person: byId } as const : people.find(asked)
            if (match.kind === "none") return { kind: "spoken", text: say(texts, lang, "unknownPerson", { name: asked }) } as const
            if (match.kind === "ambiguous") return { kind: "spoken", text: say(texts, lang, "which", { names: match.people.map((p) => p.name).join(", ") }) } as const
            only = match.person
          }
          const haPeople = new Map<string, HaPerson>(ha.people().map((p) => [p.entityId, p]))
          const now = yield* Clock.currentTimeMillis
          const zone = zoneOf(view())
          const privacy = ctx.host.service(Privacy)
          const rows: Array<Row> = []
          let withheld = 0
          let tracked = 0
          for (const link of links) {
            const member = memberOf(people, link.member)
            if (member === undefined) continue
            if (only !== undefined && member.id !== only.id) continue
            tracked++
            const person = haPeople.get(link.haPerson)
            if (person === undefined) continue
            // Where a person is, is personal: asked now, for the device that will speak it.
            if (privacy?.mayReveal(member.id, turn) !== true) {
              withheld++
              continue
            }
            const at = person.state === "home" ? "home" : isNoise(person.state) ? "unknown" : "out"
            rows.push({ name: member.name, at, owner: member.id, ...(at === "unknown" ? {} : { since: sinceText(person.since, now, zone) }) })
          }
          if (only !== undefined) {
            if (tracked === 0) return { kind: "spoken", text: say(texts, lang, "notTracked", { name: only.name }) } as const
            if (withheld > 0) return { kind: "spoken", text: say(texts, lang, "denied") } as const
          } else if (rows.length === 0) {
            if (withheld > 0) return { kind: "spoken", text: say(texts, lang, "denied") } as const
            return { kind: "spoken", text: say(texts, lang, "nobodyFound") } as const
          }
          if (rows.length === 0) return { kind: "spoken", text: say(texts, lang, "nobodyFound") } as const
          return { kind: "rows", rows, withheld, stale: connection === "reconnecting" } as const
        })

      /** The same answer as sentences, for a typed action (no model words it). */
      const sentences = (lang: Lang, g: Gathered): string => {
        if (g.kind === "spoken") return g.text
        const named = g.rows.slice(0, MAX_NAMED).map((r) => say(texts, lang, r.at === "home" ? "home" : r.at === "out" ? "away" : "unknown", { name: r.name }))
        const parts = [...named]
        if (g.rows.length > MAX_NAMED) parts.push(say(texts, lang, "moreHidden", { count: g.rows.length - MAX_NAMED }) + ".")
        if (g.withheld > 0) parts.push(say(texts, lang, "withheld", { count: g.withheld }))
        if (g.stale) parts.push(say(texts, lang, "stale"))
        return parts.join(" ")
      }

      const where = makeTool({
        name: "presence_where",
        description: "Say whether a household member is home (or out) according to Home Assistant, or who is home when no name is given. Where people are is personal: it is only told on a device that may reveal it.",
        parameters: Schema.Struct({
          person: Schema.optionalKey(
            StoredText(60).check(Schema.makeFilter((t: string) => isLine(t, 60) || "one line")).annotate({ description: "The person's name; leave out to ask about everyone" })
          )
        }),
        speculative: true,
        latency: "instant",
        sensitivity: (result) => {
          const owner = (result as { readonly owner?: string }).owner
          return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
        },
        execute: ({ person }) =>
          Effect.gen(function*() {
            const lang = homeLanguage(view())
            const g = yield* gather(lang, person)
            if (g.kind === "spoken") return { spoken: g.text }
            return {
              people: g.rows.slice(0, MAX_NAMED * 2).map((r) => ({ name: r.name, at: r.at, ...(r.since !== undefined ? { since: r.since } : {}) })),
              ...(g.rows.length > MAX_NAMED * 2 ? { more: g.rows.length - MAX_NAMED * 2 } : {}),
              ...(g.withheld > 0 ? { withheld: say(texts, lang, "withheld", { count: g.withheld }) } : {}),
              ...(g.stale ? { stale: say(texts, lang, "stale") } : {}),
              owner: g.rows[0]!.owner
            }
          }).pipe(Effect.mapError(() => new ToolError({ message: say(texts, homeLanguage(view()), "unreadable") })))
      })

      const list = makeTool({
        name: "people_list",
        description: "List the members of the household and say which of them are followed by presence (linked to a Home Assistant person). It never says where anyone is.",
        parameters: Schema.Struct({}),
        speculative: true,
        latency: "instant",
        execute: () =>
          Effect.sync(() => {
            const lang = homeLanguage(view())
            const people = ctx.host.service(People)
            const members = people?.list() ?? []
            if (members.length === 0) return { spoken: say(texts, lang, "noMembers") }
            const followed = new Set(ctx.settings.people.map((l) => (people === undefined ? undefined : memberOf(people, l.member)?.id)))
            return {
              members: members.slice(0, 20).map((m) => ({ name: m.name, followed: followed.has(m.id) })),
              ...(members.length > 20 ? { more: members.length - 20 } : {})
            }
          })
      })

      const whereAction = defineAction({
        id: "who_is_home",
        label: "Who is home",
        // The model has presence_where; this action exists to run without it.
        offerAsTool: false,
        description: "Say who is home, or whether one household member is.",
        examples: [
          "who is home",
          "who's home",
          "is anyone home",
          "is Sam home",
          "is Robin at home",
          "where is Sam",
          "wie is er thuis",
          "is er iemand thuis",
          "is Sam thuis",
          "waar is Robin"
        ],
        params: {
          person: Param.dynamic({
            label: "Person",
            optional: true,
            options: () => (ctx.host.service(People)?.list() ?? []).map((p) => ({ value: p.id, label: p.name, aliases: p.aliases }))
          })
        },
        risk: "read",
        run: ({ person }) =>
          Effect.gen(function*() {
            const lang = homeLanguage(view())
            return { say: sentences(lang, yield* gather(lang, person)) }
          }).pipe(Effect.mapError(() => new ActionError({ message: say(texts, homeLanguage(view()), "unreadable") })))
      })

      return { tools: [where, list], actions: [whereAction] }
    })
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [presenceModule]
