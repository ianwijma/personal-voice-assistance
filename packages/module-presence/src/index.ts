import {
  CurrentTurn,
  defineAction,
  defineModule,
  type HostView,
  makeTool,
  type ModuleDefinition,
  type PeopleService,
  Param,
  type PresentHandle,
  type Presentation,
  People,
  type Person,
  Privacy,
  Setting
} from "@pva/core"
import { type ClockTime, type LocalDate, speakMoment, speakTime } from "@pva/language"
import { type HaChange, type HaConnection, type HaEntity, type HaPerson, HomeAssistant, homeLanguage, isLine, providerOffText, say, StoredText, useService } from "@pva/module-contracts"
import { Clock, Effect, type Fiber, Option, type Scope, Schema, Stream } from "effect"
import { texts } from "./texts.ts"

export { texts }

type Lang = ReturnType<typeof homeLanguage>

/** The most people one answer names (the household is small; the rest is "and N more"). */
const MAX_NAMED = 4
/** The most people the module follows: one record per Home Assistant person. */
const MAX_LINKS = 20
/** How soon a stream that ended is subscribed again, and how long a missing provider is waited for before looking again. */
const RETRY_MS = 2_000
const PROVIDER_WAIT_MS = 5_000

const PERSON_ENTITY = /^person\.[a-z0-9_]{1,60}$/
/** A Members id, as the core's privacy rule accepts one. */
const MEMBER_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/

const explainEntity = (v: string): string | undefined =>
  PERSON_ENTITY.test(v) ? undefined : "A Home Assistant person looks like person.sam (lower case letters, digits and _)."

const explainMember = (v: string): string | undefined =>
  MEMBER_ID.test(v) ? undefined : "A household member is given by their id (p-sam), as listed under Household members, not by their name."

/** Each Home Assistant person and each member (by id: ids are the members' lasting names) is linked at most once. */
const explainLinks = (items: ReadonlyArray<{ readonly haPerson: string; readonly member: string }>): string | undefined => {
  const entities = new Set<string>()
  const members = new Set<string>()
  for (const item of items) {
    const bad = explainMember(item.member)
    if (bad !== undefined) return bad
    if (entities.has(item.haPerson)) return `${item.haPerson} is linked twice.`
    if (members.has(item.member)) return `${item.member} is linked twice.`
    entities.add(item.haPerson)
    members.add(item.member)
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
      member: Setting.text({
        label: "Household member's id",
        description: "The member's id (not the name), as listed under Household members below.",
        placeholder: "p-sam",
        maxLength: 40,
        check: explainMember
      })
    },
    check: explainLinks
  }),
  members: Setting.info({ label: "Household members", description: "Each member with the id a link uses, and any link to someone who is no longer a member." }),
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

/** The member a link names, by id, looked up now: a link whose id is not a current member names nobody. */
const memberOf = (people: PeopleService | undefined, link: Link): Person | undefined => people?.get(link.member)

const isNoise = (state: string): boolean => state === "unknown" || state === "unavailable"
/** A known state that is not home: `not_home` or a zone. */
const isAway = (state: string | undefined): state is string => state !== undefined && state !== "home" && !isNoise(state)

interface LocalParts {
  readonly date: LocalDate
  readonly time: ClockTime
}

const localParts = (t: number, zone: string): LocalParts => {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  const o: Record<string, string> = {}
  for (const p of f.formatToParts(t)) o[p.type] = p.value
  return { date: { year: Number(o.year), month: Number(o.month), day: Number(o.day) }, time: { hour: Number(o.hour), minute: Number(o.minute) } }
}

const pad = (n: number) => String(n).padStart(2, "0")
const sameDay = (a: LocalDate, b: LocalDate) => a.year === b.year && a.month === b.month && a.day === b.day

/** A moment as the model words it: the time in the household's zone, with the date when it is not today. */
const sinceText = (at: number, now: number, zone: string): string => {
  const a = localParts(at, zone)
  const time = `${pad(a.time.hour)}:${pad(a.time.minute)}`
  return sameDay(a.date, localParts(now, zone).date) ? time : `${a.date.year}-${pad(a.date.month)}-${pad(a.date.day)} ${time}`
}

/** The same moment as it is said (`@pva/language`): "seven o'clock", "yesterday at eight o'clock"; `undefined` when it cannot be. */
const sinceSpoken = (at: number, now: number, zone: string, lang: Lang): string | undefined => {
  const a = localParts(at, zone)
  const today = localParts(now, zone).date
  return sameDay(a.date, today) ? speakTime(a.time, lang) : speakMoment(a, lang, today)
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
  /** Epoch ms: when the module knows the start of the person's time at home or away (see `awaySince`). */
  readonly since?: number
  readonly owner: string
}

type Gathered =
  | { readonly kind: "spoken"; readonly text: string }
  | { readonly kind: "rows"; readonly rows: ReadonlyArray<Row>; readonly withheld: number; readonly stale: boolean; readonly now: number; readonly zone: string }

/** What the module knows of one Home Assistant person, in memory only (nothing of it is stored or scheduled). */
interface Tracked {
  readonly state: string
  /** Home Assistant's `lastChanged` when the module last saw it. */
  readonly lastChanged: number
  /** When the module itself saw this person go from home to away; kept across a change between two away zones. */
  readonly awaySince?: number
}

/** The most devices whose "who is home" list is remembered (one handle each), and the most turns remembered as shown. */
const MAX_HANDLES = 32
const MAX_SEEN = 64
/** The most items of a list presentation, the longest name shown in one, and its longest spoken fallback. */
const LIST_ITEMS = 12
const NAME_CHARS = 30
const SPOKEN_CHARS = 300

/** A text cut to at most `max` UTF-16 units at a code point boundary (an emoji is never split), with "…" when cut. */
export const cutText = (s: string, max: number): string => {
  if (s.length <= max) return s
  let out = ""
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out}…`
}

/** Text from outside as one plain line: control, line and bidirectional characters become spaces (it is never markup). */
const oneLine = (s: string): string => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd").replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu, " ").replace(/ {2,}/g, " ").trim()

/** What the shared part offers the instances. */
interface Shared {
  /** The "who is home" lists on screen, by device: kept so that the next answer or a change of the data withdraws them. */
  readonly shown: Map<string, PresentHandle>
  /** The turns whose answer was already shown (a replay of one shows nothing twice). */
  readonly seen: Set<string>
  /** Takes every list down (the data changed or its stream broke). */
  readonly withdrawAll: Effect.Effect<void>
  /** When the person went away, if the module saw it happen and the person is still away: else `undefined`. */
  readonly awaySince: (entityId: string, liveState: string) => number | undefined
}

/**
 * The module, made fresh for each use (`catalog` holds the production one). Its `health` names links to someone who is
 * no longer a member: `health()` is given no services, so the running shared part lends it the one question it asks of
 * Members, and takes it back when it closes.
 */
export const makePresenceModule = () => {
  let isMemberNow: ((id: string) => boolean) | undefined

  return defineModule({
    apiVersion: 2,
    id: "presence",
    name: "Presence",
    description: "Who is home, and who has just arrived or left, from Home Assistant's people.",
    enabledByDefault: false,
    uses: ["home-assistant"],
    settings,
    // Nothing is stored and nothing is scheduled: where a person is lives in Home Assistant, and a pending departure
    // is a fiber in memory.
    health: ({ settings: s, running }) =>
      Effect.sync(() => {
        const links = s?.people ?? []
        if (links.length === 0) {
          return [{
            id: "presence.no-people",
            severity: "info" as const,
            title: "No people linked",
            detail: "Link each Home Assistant person to a household member in the module's settings, or nobody's whereabouts are known."
          }]
        }
        const check = running ? isMemberNow : undefined
        if (check === undefined) return []
        let stale: ReadonlyArray<Link>
        try {
          stale = links.filter((l) => !check(l.member))
        } catch {
          return [] // the part closed meanwhile
        }
        return stale.length === 0 ? [] : [{
          id: "presence.not-members",
          severity: "warning" as const,
          title: "A link names someone who is not a member",
          detail: `${stale.map((l) => `${l.haPerson} (${l.member})`).join(", ")}: no such member now, so ${stale.length === 1 ? "it is" : "they are"} ignored. Link the person to a member's id, or remove the link.`
        }]
      }),
    shared: (ctx) =>
      Effect.gen(function*() {
        const scope: Scope.Scope = yield* Effect.scope
        const links = (): ReadonlyArray<Link> => ctx.settings.people ?? []
        const delayMs = (ctx.settings.departureDelayMinutes ?? 3) * 60_000
        const linkOf = (entityId: string): Link | undefined => links().find((l) => l.haPerson === entityId)
        const memberFor = (entityId: string): Person | undefined => {
          const link = linkOf(entityId)
          return link === undefined ? undefined : memberOf(ctx.host.service(People), link)
        }

        const mine = (id: string) => ctx.host.service(People)?.get(id) !== undefined
        isMemberNow = mine
        yield* Effect.addFinalizer(() => Effect.sync(() => void (isMemberNow === mine && (isMemberNow = undefined))))

        // What the module knows, in memory: every person entity's last state, and the departures waiting out the delay.
        const tracked = new Map<string, Tracked>()
        // The lists on screen (in memory; a restart of the module takes its transient presentations down with it).
        const shown = new Map<string, PresentHandle>()
        const seen = new Set<string>()
        const quietly = (e: Effect.Effect<unknown, unknown>): Effect.Effect<void> => e.pipe(Effect.ignore, Effect.catchDefect(() => Effect.void))
        /** The data a list shows changed or can no longer be trusted: every list comes down (none is rewritten out of a turn). */
        const withdrawAll = Effect.suspend(() => {
          const handles = [...shown.values()]
          shown.clear()
          return Effect.forEach(handles, (h) => quietly(h.dismiss), { discard: true })
        })
        const pending = new Map<string, { readonly token: object; readonly fiber: Fiber.Fiber<void> }>()

        /** Calls a waiting departure off, at once; true when there was one. */
        const cancel = (entityId: string): boolean => {
          const p = pending.get(entityId)
          if (p === undefined) return false
          pending.delete(entityId)
          p.fiber.interruptUnsafe()
          return true
        }
        const cancelAll = () => {
          for (const id of [...pending.keys()]) cancel(id)
        }

        const publish = (type: "arrived" | "left", entityId: string, at: number) =>
          Effect.gen(function*() {
            const member = memberFor(entityId)
            // A person who is not (or no longer) a member is revealed nowhere, not even by an event.
            if (member !== undefined) yield* ctx.events.publish(type, { person: member.id, at })
          })

        /**
         * When the delay is over: a departure only if Home Assistant is live now and says this person is still away,
         * on the same time away the module saw begin. Anything that called it off has already removed it.
         */
        const confirm = (entityId: string, at: number, token: object) =>
          Effect.gen(function*() {
            if (pending.get(entityId)?.token !== token) return
            pending.delete(entityId)
            const live = yield* useService(ctx.host, HomeAssistant, (ha) => Effect.sync(() => ({ connection: ha.connection(), entity: ha.entity(entityId) }))).pipe(Effect.option)
            if (Option.isNone(live) || live.value.connection !== "connected") return
            const known = tracked.get(entityId)
            if (!isAway(live.value.entity?.state) || !isAway(known?.state) || known.awaySince !== at) return
            yield* publish("left", entityId, at)
          })

        const arm = (entityId: string, at: number) =>
          Effect.gen(function*() {
            cancel(entityId)
            const token = {}
            const fiber = yield* Effect.forkIn(Effect.andThen(Effect.sleep(delayMs), Effect.suspend(() => confirm(entityId, at, token))), scope)
            pending.set(entityId, { token, fiber })
          })

        const onChanged = (entity: HaEntity, previous: HaEntity | undefined) =>
          Effect.gen(function*() {
            const id = entity.entityId
            const known = previous === undefined ? undefined : tracked.get(id)
            const before = known?.state
            const now = entity.state
            if (now === "home") {
              const wasPending = cancel(id)
              tracked.set(id, { state: now, lastChanged: entity.lastChanged })
              // Back within the delay: they never left, so there is nothing to announce.
              if (isAway(before) && !wasPending) yield* publish("arrived", id, entity.lastChanged)
            } else if (isAway(now)) {
              if (before === "home") {
                tracked.set(id, { state: now, lastChanged: entity.lastChanged, awaySince: entity.lastChanged })
                if (linkOf(id) === undefined) return
                if (delayMs === 0) yield* publish("left", id, entity.lastChanged)
                else yield* arm(id, entity.lastChanged)
              } else if (isAway(before)) {
                // From one zone to another: still the same time away.
                tracked.set(id, { state: now, lastChanged: entity.lastChanged, ...(known?.awaySince !== undefined ? { awaySince: known.awaySince } : {}) })
              } else {
                // From unknown, unavailable or nothing known: not a departure, and when it began is not known.
                cancel(id)
                tracked.set(id, { state: now, lastChanged: entity.lastChanged })
              }
            } else {
              // Unknown or unavailable: what was known is broken off.
              cancel(id)
              tracked.set(id, { state: now, lastChanged: entity.lastChanged })
            }
          })

        const onChange = (change: HaChange) =>
          Effect.gen(function*() {
            switch (change._tag) {
              case "snapshot": {
                // A snapshot is a state, not news: it calls off every waiting departure and announces nothing. A person
                // whose state and last change are exactly as the module knew them keeps when they went away.
                cancelAll()
                yield* withdrawAll
                const before = new Map(tracked)
                tracked.clear()
                for (const e of change.entities) {
                  if (e.domain !== "person") continue
                  const was = before.get(e.entityId)
                  const same = was !== undefined && was.state === e.state && was.lastChanged === e.lastChanged && change.connection === "connected"
                  tracked.set(e.entityId, { state: e.state, lastChanged: e.lastChanged, ...(same && was.awaySince !== undefined ? { awaySince: was.awaySince } : {}) })
                }
                return
              }
              case "connection":
                if (change.connection !== "connected") cancelAll()
                yield* withdrawAll
                return
              case "removed":
                cancel(change.entityId)
                yield* withdrawAll
                tracked.delete(change.entityId)
                return
              case "changed":
                // A change with no previous entity is one new to Home Assistant's cache: what it is now is not news.
                if (change.entity.domain === "person") {
                  yield* withdrawAll
                  yield* onChanged(change.entity, change.previous)
                }
                return
            }
          })

        /** The stream ended (the provider stopped or was replaced): nothing pending survives, and the next snapshot is the baseline. */
        const reset = Effect.suspend(() => {
          cancelAll()
          tracked.clear()
          return withdrawAll
        })

        // Home Assistant's changes, for as long as this part lives. The provider is looked up again each time the
        // stream ends: after its restart it is a new provider, and its stream starts with a snapshot.
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function*() {
              const stream = yield* useService(ctx.host, HomeAssistant, (ha) => Effect.sync(() => ha.changes())).pipe(Effect.option)
              if (Option.isNone(stream)) return yield* Effect.sleep(PROVIDER_WAIT_MS)
              yield* Stream.runForEach(stream.value, onChange).pipe(Effect.catchCause(() => Effect.void), Effect.ensuring(reset))
              yield* Effect.sleep(RETRY_MS)
            })
          )
        )

        const shared: Shared = {
          shown,
          seen,
          withdrawAll,
          awaySince: (entityId, liveState) => {
            const known = tracked.get(entityId)
            return isAway(liveState) && isAway(known?.state) ? known.awaySince : undefined
          }
        }
        return { value: shared }
      }),
    start: (ctx) =>
      Effect.sync(() => {
        const view = () => ctx.host.view()

        /** Who the answer is about and what may be said of them on the asking device, at this moment. */
        const gather = (lang: Lang, asked: string | undefined): Effect.Effect<Gathered> =>
          Effect.gen(function*() {
            const turn = yield* CurrentTurn
            const people = ctx.host.service(People)
            if (people === undefined) return { kind: "spoken", text: say(texts, lang, "unreadable") } as const
            // Every read of Home Assistant goes through useService: off, or stopping during the call, is ProviderOff.
            const ha = yield* useService(ctx.host, HomeAssistant, (s) => Effect.sync(() => ({ connection: s.connection() as HaConnection, people: s.people() }))).pipe(Effect.option)
            if (Option.isNone(ha)) return { kind: "spoken", text: providerOffText(lang, "Home Assistant") } as const
            const links = ctx.settings.people
            if (links.length === 0) return { kind: "spoken", text: say(texts, lang, "notSet") } as const
            const { connection } = ha.value
            if (connection === "unknown") return { kind: "spoken", text: say(texts, lang, "noState") } as const
            let only: Person | undefined
            if (asked !== undefined) {
              const byId = people.get(asked)
              const match = byId !== undefined ? { kind: "found", person: byId } as const : people.find(asked)
              if (match.kind === "none") return { kind: "spoken", text: say(texts, lang, "unknownPerson", { name: asked }) } as const
              if (match.kind === "ambiguous") return { kind: "spoken", text: say(texts, lang, "which", { names: match.people.map((p) => p.name).join(", ") }) } as const
              only = match.person
            }
            const haPeople = new Map<string, HaPerson>(ha.value.people.map((p) => [p.entityId, p]))
            const now = yield* Clock.currentTimeMillis
            const zone = zoneOf(view())
            const privacy = ctx.host.service(Privacy)
            const rows: Array<Row> = []
            let withheld = 0
            let tracked = 0
            for (const link of links) {
              const member = memberOf(people, link)
              if (member === undefined) continue
              if (only !== undefined && member.id !== only.id) continue
              tracked++
              // Where a person is, is personal: asked now, for the device that will speak it, before anything is
              // looked at, so that what Home Assistant lacks says nothing about a person who may not be told about.
              if (privacy?.mayReveal(member.id, turn) !== true) {
                withheld++
                continue
              }
              const person = haPeople.get(link.haPerson)
              if (person === undefined || isNoise(person.state)) {
                rows.push({ name: member.name, at: "unknown", owner: member.id })
              } else if (person.state === "home") {
                rows.push({ name: member.name, at: "home", owner: member.id, since: person.since })
              } else {
                const since = ctx.shared.awaySince(link.haPerson, person.state)
                rows.push({ name: member.name, at: "out", owner: member.id, ...(since !== undefined ? { since } : {}) })
              }
            }
            if (only !== undefined) {
              if (tracked === 0) return { kind: "spoken", text: say(texts, lang, "notTracked", { name: only.name }) } as const
              if (withheld > 0) return { kind: "spoken", text: say(texts, lang, "denied") } as const
            } else if (rows.length === 0) {
              if (withheld > 0) return { kind: "spoken", text: say(texts, lang, "denied") } as const
              return { kind: "spoken", text: say(texts, lang, "nobodyLinked") } as const
            }
            return { kind: "rows", rows, withheld, stale: connection === "reconnecting", now, zone } as const
          })

        /** The same answer as sentences, for a typed action (no model words it); times by `@pva/language`. */
        const sentences = (lang: Lang, g: Gathered, maxNamed: number = MAX_NAMED): string => {
          if (g.kind === "spoken") return g.text
          const named = g.rows.slice(0, maxNamed).map((r) => {
            if (r.at === "unknown") return say(texts, lang, "unknown", { name: r.name })
            const when = r.since === undefined ? undefined : sinceSpoken(r.since, g.now, g.zone, lang)
            if (when === undefined) return say(texts, lang, r.at === "home" ? "home" : "away", { name: r.name })
            return say(texts, lang, r.at === "home" ? "homeSince" : "awaySince", { name: r.name, when })
          })
          const parts = [...named]
          if (g.rows.length > maxNamed) parts.push(say(texts, lang, "moreHidden", { count: g.rows.length - maxNamed }) + ".")
          if (g.withheld > 0) parts.push(say(texts, lang, "withheld", { count: g.withheld }))
          if (g.stale) parts.push(say(texts, lang, "stale"))
          return parts.join(" ")
        }

        /** What the list says of one person, in a line (the name cut, the time as `HH:MM` or with its date, as the tool gives it). */
        const rowLine = (lang: Lang, g: Extract<Gathered, { kind: "rows" }>, r: Row): string => {
          const name = cutText(oneLine(r.name), NAME_CHARS)
          if (r.at === "unknown") return say(texts, lang, "rowUnknown", { name })
          if (r.since === undefined) return say(texts, lang, r.at === "home" ? "rowHome" : "rowOut", { name })
          return say(texts, lang, r.at === "home" ? "rowHomeSince" : "rowOutSince", { name, when: sinceText(r.since, g.now, g.zone) })
        }

        /**
         * The same answer as a list: one line per person the answer named (never anyone it withheld), then the honest notes
         * ("and 2 more", how many are not said here, "last heard"). Personal to the first person named, so the Presenter asks
         * `Privacy.mayReveal` again for the device that would show it whenever it reconciles.
         */
        const listOf = (lang: Lang, g: Extract<Gathered, { kind: "rows" }>): Presentation => {
          const notes = (g.withheld > 0 ? 1 : 0) + (g.stale ? 1 : 0)
          const room = LIST_ITEMS - notes
          const shownRows = g.rows.length <= room ? g.rows : g.rows.slice(0, room - 1)
          const items: Array<{ readonly id: string; readonly text: string }> = shownRows.map((r) => ({ id: r.owner, text: rowLine(lang, g, r) }))
          if (shownRows.length < g.rows.length) items.push({ id: ":more", text: say(texts, lang, "moreHidden", { count: g.rows.length - shownRows.length }) })
          if (g.withheld > 0) items.push({ id: ":withheld", text: cutText(say(texts, lang, "withheld", { count: g.withheld }), 80) })
          if (g.stale) items.push({ id: ":stale", text: cutText(say(texts, lang, "stale"), 80) })
          // The fallback is the answer's own sentences, with fewer names until it fits (never cut in the middle of one).
          let spoken = ""
          for (let n = Math.min(MAX_NAMED, g.rows.length); n >= 0 && spoken === ""; n--) {
            const text = oneLine(sentences(lang, g, n))
            if (text.length <= SPOKEN_CHARS) spoken = text
          }
          return {
            kind: "list",
            title: say(texts, lang, "listTitle"),
            style: "bullets",
            items,
            spoken,
            sensitivity: { personal: g.rows[0]!.owner }
          }
        }

        /**
         * Shows the answer on the asking device, as a transient list, and keeps its handle: the next answer from that device
         * takes it down first (and shows nothing when it has nothing to show, also after an empty answer), and a change of
         * the data takes every list down. A device that cannot show it changes nothing about the answer; the same turn on
         * the same device is shown once.
         */
        const showAnswer = (lang: Lang, g: Gathered): Effect.Effect<void> =>
          Effect.gen(function*() {
            const turn = yield* CurrentTurn
            const device = turn?.deviceId
            if (turn === undefined || device === undefined) return
            const identity = JSON.stringify([turn.assistantId, turn.conversationId, turn.turnId, device])
            if (ctx.shared.seen.has(identity)) return
            ctx.shared.seen.add(identity)
            if (ctx.shared.seen.size > MAX_SEEN) ctx.shared.seen.delete(ctx.shared.seen.values().next().value!)
            const before = ctx.shared.shown.get(device)
            ctx.shared.shown.delete(device)
            if (before !== undefined) yield* before.dismiss.pipe(Effect.ignore, Effect.catchDefect(() => Effect.void))
            if (g.kind !== "rows") return
            const handle = yield* ctx.present.show("origin", listOf(lang, g)).pipe(Effect.option, Effect.catchDefect(() => Effect.succeed(Option.none<PresentHandle>())))
            if (Option.isNone(handle) || !handle.value.outcome.devices.some((d) => d.shown)) return
            ctx.shared.shown.set(device, handle.value)
            if (ctx.shared.shown.size > MAX_HANDLES) {
              const oldest = ctx.shared.shown.keys().next().value!
              const old = ctx.shared.shown.get(oldest)!
              ctx.shared.shown.delete(oldest)
              yield* old.dismiss.pipe(Effect.ignore, Effect.catchDefect(() => Effect.void))
            }
          })

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
                people: g.rows.slice(0, MAX_NAMED * 2).map((r) => ({ name: r.name, at: r.at, ...(r.since !== undefined ? { since: sinceText(r.since, g.now, g.zone) } : {}) })),
                ...(g.rows.length > MAX_NAMED * 2 ? { more: g.rows.length - MAX_NAMED * 2 } : {}),
                ...(g.withheld > 0 ? { withheld: say(texts, lang, "withheld", { count: g.withheld }) } : {}),
                ...(g.stale ? { stale: say(texts, lang, "stale") } : {}),
                owner: g.rows[0]!.owner
              }
            })
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
              const followed = new Set(ctx.settings.people.map((l) => memberOf(people, l)?.id))
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
          // Fixed phrases only: the person is a runtime list, so it cannot be a slot ("is Sam home" goes to the model).
          phrases: {
            en: ["who is home", "who is at home", "who's home", "is anyone home"],
            nl: ["wie is er thuis", "wie is thuis", "is er iemand thuis"]
          },
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
              const g = yield* gather(lang, person)
              yield* showAnswer(lang, g)
              return { say: sentences(lang, g) }
            })
        })

        /** The members with their ids, for the owner writing a link, and the links that name no member now. */
        const membersInfo = (): string => {
          const people = ctx.host.service(People)
          const members = people?.list() ?? []
          const listed = members.length === 0 ? "No members yet (add them under Members)." : members.map((m) => `${m.name}: ${m.id}`).join(" · ")
          const stale = ctx.settings.people.filter((l) => memberOf(people, l) === undefined)
          return stale.length === 0 ? listed : `${listed} — Not a member now, ignored: ${stale.map((l) => `${l.haPerson} → ${l.member}`).join(", ")}`
        }

        return { tools: [where, list], actions: [whereAction], info: () => ({ members: membersInfo() }) }
      })
  })
}

export const presenceModule = makePresenceModule()

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [presenceModule]
