import { Devices, type ModuleHostApi, type ModuleStore, People, Privacy, type Row, type TurnContext } from "@pva/core"
import { parseDateTime, speakDate, speakList, speakMoment, speakTime } from "@pva/language"
import { type Language, say } from "@pva/module-contracts"
import { Clock, Effect } from "effect"
import { type CalendarConfig, type CalendarSettings, ownerOf, sameName } from "./config.ts"
import { WINDOW_DAYS } from "./refresh.ts"
import { type Occurrence, occurrences, type SourceState, sources } from "./store.ts"
import { texts } from "./texts.ts"
import { dateOf, dayNumber, daysBetween, homeZone, type LocalDate, parseIsoDate, startOfDay, wallTimeOf } from "./time.ts"

/**
 * Reading the cache for a turn (docs/MODULES.md §5, §7, §15): bounded indexed reads of the store, nothing from the
 * network, and privacy decided per event at the moment of answering, on the device that asked.
 *
 * **Bounds.** A day is one indexed range (`[day, start]`) read page by page, at most `DAY_ROWS` rows; a search reads
 * at most `FIND_ROWS` rows in start order; "next" at most `NEXT_ROWS` rows over the days ahead. Each says when it was
 * cut short.
 *
 * **Privacy** (docs/MODULES-PLAN.md §2 row 8; docs/modules/calendar.md, "Privacy"). An event of a household calendar
 * is shown everywhere. An event of a member's calendar is shown where `Privacy.mayReveal(owner, turn)` says yes now;
 * on a known `shared` device, for a member, it is reduced to "Robin is busy from two to three" (no title, no place, no
 * calendar name); anywhere else it is withheld and only counted. Searching by text never looks at an event that is
 * not shown (a match would tell what it is called).
 */

export const DAY_ROWS = 200
export const FIND_ROWS = 1_000
export const NEXT_ROWS = 1_000
const PAGE = 20

export type Visibility = "show" | "reduce" | "withhold"

export type Who =
  | { readonly kind: "all" }
  | { readonly kind: "household" }
  | { readonly kind: "person"; readonly id: string; readonly name: string; readonly reduced: boolean }

/** A question or refusal instead of an answer: spoken as it is. */
export interface Spoken {
  readonly spoken: string
}

export const isSpoken = (u: unknown): u is Spoken => typeof u === "object" && u !== null && "spoken" in u && Object.keys(u).length === 1

const ALL_WORDS = new Set(["everyone", "everybody", "all", "anyone", "iedereen", "allemaal", "alle"])
const HOUSEHOLD_WORDS = new Set(["household", "family", "home", "the family", "the household", "huishouden", "gezin", "familie", "het gezin", "de familie", "het huishouden"])
const ME_WORDS = new Set(["me", "my", "mine", "myself", "i", "ik", "mij", "mijn", "mezelf"])

const capital = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

export interface ReadEnv {
  readonly host: ModuleHostApi
  readonly store: ModuleStore
  readonly settings: () => CalendarSettings
  readonly language: () => Language
}

export const makeReader = (env: ReadEnv) => {
  const rowsC = env.store.collection(occurrences)
  const statesC = env.store.collection(sources)

  /** Everything a read needs about now, looked up at the moment of reading (never kept). */
  const moment = (turn: TurnContext | undefined, language?: Language) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const zone = homeZone(env.host.view())
      const lang = language ?? env.language()
      const today = dateOf(now, zone)
      const people = env.host.service(People)
      const privacy = env.host.service(Privacy)
      const devices = env.host.service(Devices)
      const configs = env.settings().calendars ?? []
      // Whose each configured calendar is now: a row is used only when its owner is still its calendar's.
      const owners = new Map(configs.map((c) => [c.name.trim().toLowerCase(), ownerOf(c, people)]))
      const valid = (r: Row<Occurrence>) => {
        const o = owners.get(r.value.source.toLowerCase())
        if (o === undefined || o.kind === "unknown") return false
        return o.kind === "household" ? r.value.owner === undefined : r.value.owner === o.id
      }
      const mayReveal = (owner: string) => privacy?.mayReveal(owner, turn) === true
      /** Reduced ("Robin is busy …") only on a known shared device, for an owner who is a member now. */
      const mayReduce = (owner: string) => {
        if (turn?.deviceId === undefined || people?.get(owner) === undefined) return false
        return devices?.get(turn.deviceId)?.place.privacy === "shared"
      }
      const visibility = (r: Row<Occurrence>): Visibility => {
        const owner = r.value.owner
        if (owner === undefined) return "show"
        if (mayReveal(owner)) return "show"
        return mayReduce(owner) ? "reduce" : "withhold"
      }
      const nameOf = (owner: string) => people?.get(owner)?.name ?? ""
      return { now, zone, lang, today, people, configs, valid, visibility, nameOf, mayReveal, mayReduce, turn }
    })

  type Moment = Effect.Success<ReturnType<typeof moment>>

  /** Who a request means: everyone (default), the household's calendars, the asking person, or a member by name. */
  const resolveWho = (m: Moment, who: string | undefined): Who | Spoken => {
    const text = (who ?? "").trim().toLowerCase()
    if (text === "" || ALL_WORDS.has(text)) return { kind: "all" }
    if (HOUSEHOLD_WORDS.has(text)) return { kind: "household" }
    if (ME_WORDS.has(text)) {
      const person = m.turn?.person?.id
      if (person === undefined) return { spoken: say(texts, m.lang, "whose") }
      if (!m.mayReveal(person)) return { spoken: say(texts, m.lang, "notHere") }
      return { kind: "person", id: person, name: m.nameOf(person), reduced: false }
    }
    const found = m.people?.find(who!.trim()) ?? { kind: "none" as const }
    if (found.kind === "ambiguous") return { spoken: say(texts, m.lang, "whoWhich", { list: speakList(found.people.map((p) => p.name), m.lang, { max: 6 }) ?? "" }) }
    if (found.kind === "none") return { spoken: say(texts, m.lang, "whoUnknown", { name: who!.trim() }) }
    const p = found.person
    if (m.mayReveal(p.id)) return { kind: "person", id: p.id, name: p.name, reduced: false }
    if (m.mayReduce(p.id)) return { kind: "person", id: p.id, name: p.name, reduced: true }
    return { spoken: say(texts, m.lang, "notHere") }
  }

  /** Whether a row is one `who` asks about (`withHousehold`: free time counts the household's events too). */
  const meant = (who: Who, r: Row<Occurrence>, withHousehold = false) =>
    who.kind === "all" || (who.kind === "household" ? r.value.owner === undefined : r.value.owner === who.id || (withHousehold && r.value.owner === undefined))

  /** A day's rows in start order, at most `DAY_ROWS`, and whether there were more. */
  const readDay = (d: LocalDate) =>
    Effect.gen(function*() {
      const out: Array<Row<Occurrence>> = []
      let after: Row<Occurrence> | undefined
      while (out.length < DAY_ROWS) {
        const page = yield* rowsC.list({ where: { day: dayNumber(d) }, orderBy: { field: "start" }, limit: PAGE, ...(after !== undefined ? { after } : {}) })
        out.push(...page)
        if (page.length < PAGE) return { rows: out, cut: false }
        after = page.at(-1)
      }
      const beyond = yield* rowsC.list({ where: { day: dayNumber(d) }, orderBy: { field: "start" }, limit: 1, after: after! })
      return { rows: out, cut: beyond.length > 0 }
    })

  /** The day a phrase or ISO date means (default today), or the question to ask. */
  const resolveDay = (m: Moment, text: string | undefined): LocalDate | Spoken => {
    const t = (text ?? "").trim()
    let date: LocalDate | undefined
    if (t === "") date = m.today
    else date = parseIsoDate(t)
    if (date === undefined) {
      for (const lang of m.lang === "nl" ? (["nl", "en"] as const) : (["en", "nl"] as const)) {
        const p = parseDateTime(t, lang, { now: m.now, timeZone: m.zone })
        if (p.kind === "ok") {
          date = p.value.date
          break
        }
        if (p.kind === "ambiguous") {
          const days = p.candidates.map((c) => speakDate(c.date, m.lang, m.today)).filter((s): s is string => s !== undefined)
          return { spoken: say(texts, m.lang, "whichOf", { list: days.join(m.lang === "nl" ? " of " : " or ") }) }
        }
      }
    }
    if (date === undefined) return { spoken: say(texts, m.lang, "whichDay", { day: t }) }
    const offset = daysBetween(m.today, date)
    if (offset < -1 || offset > WINDOW_DAYS) return { spoken: say(texts, m.lang, "outOfRange", { days: WINDOW_DAYS }) }
    return date
  }

  const timeOf = (m: Moment, instant: number) => {
    const w = wallTimeOf(instant, m.zone)
    return speakTime({ hour: w.hour, minute: w.minute }, m.lang) ?? `${w.hour}:${String(w.minute).padStart(2, "0")}`
  }
  const dayWords = (m: Moment, d: LocalDate) => speakDate(d, m.lang, m.today) ?? `${d.year}-${d.month}-${d.day}`
  const titleOf = (m: Moment, r: Row<Occurrence>, max = 120) => (r.value.title === "" ? say(texts, m.lang, "untitled") : r.value.title.slice(0, max))
  /** The source's name as the owner typed it. */
  const calendarOf = (m: Moment, r: Row<Occurrence>) => m.configs.find((c) => sameName(c.name, r.value.source))?.name.trim() ?? r.value.source

  /** An event as a tool result shows it (the model words it). */
  const shown = (m: Moment, d: LocalDate, r: Row<Occurrence>) => {
    const dayStart = startOfDay(d, m.zone)
    const v = r.value
    return {
      title: titleOf(m, r),
      ...(v.allDay ? { allDay: true } : v.start < dayStart ? { until: timeOf(m, v.end) } : { time: timeOf(m, v.start), until: timeOf(m, v.end) }),
      calendar: calendarOf(m, r),
      ...(v.location !== undefined ? { place: v.location } : {})
    }
  }
  /** A reduced event: whose, and when they are busy; nothing else. */
  const reduced = (m: Moment, d: LocalDate, r: Row<Occurrence>) => {
    const dayStart = startOfDay(d, m.zone)
    return { busy: m.nameOf(r.value.owner!), from: r.value.start < dayStart ? timeOf(m, dayStart) : timeOf(m, r.value.start), to: timeOf(m, r.value.end) }
  }

  /** An event as a spoken item: "standup at half past nine", "holiday, all day", "conference, until five o'clock". */
  const item = (m: Moment, d: LocalDate, r: Row<Occurrence>, max = 120) => {
    const title = titleOf(m, r, max)
    if (r.value.allDay) return say(texts, m.lang, "allDay", { title })
    if (r.value.start < startOfDay(d, m.zone)) return say(texts, m.lang, "until", { title, time: timeOf(m, r.value.end) })
    return say(texts, m.lang, "at", { title, time: timeOf(m, r.value.start) })
  }

  /** The sentence about calendars that could not be read (from their state now), or `undefined`. */
  const staleNote = (m: Moment) =>
    Effect.gen(function*() {
      if (m.configs.length === 0) return undefined
      const states = yield* statesC.list({ limit: 35 })
      const stateOf = (c: CalendarConfig): SourceState | undefined => states.find((s) => sameName(s.value.name, c.name))?.value
      const never = m.configs.filter((c) => stateOf(c)?.okAt === undefined).map((c) => c.name.trim())
      const failed = m.configs.filter((c) => {
        const s = stateOf(c)
        return s?.okAt !== undefined && s.error !== undefined
      })
      const parts: Array<string> = []
      if (failed.length > 0) {
        const oldest = Math.min(...failed.map((c) => stateOf(c)!.okAt!))
        const d = dateOf(oldest, m.zone)
        const w = wallTimeOf(oldest, m.zone)
        const time = daysBetween(d, m.today) === 0
          ? timeOf(m, oldest)
          : speakMoment({ date: d, time: { hour: w.hour, minute: w.minute } }, m.lang, m.today) ?? timeOf(m, oldest)
        parts.push(say(texts, m.lang, "stale", { names: speakList(failed.map((c) => c.name.trim()), m.lang, { max: 4 }) ?? "", time }))
      }
      if (never.length > 0 && never.length < m.configs.length) parts.push(say(texts, m.lang, "neverRead", { names: speakList(never, m.lang, { max: 4 }) ?? "" }))
      return parts.length === 0 ? undefined : parts.join(" ")
    })

  /** Whether no configured calendar has ever been read (there is nothing to answer from yet). */
  const nothingRead = (m: Moment) =>
    Effect.gen(function*() {
      const states = yield* statesC.list({ limit: 35 })
      return !m.configs.some((c) => states.some((s) => sameName(s.value.name, c.name) && s.value.okAt !== undefined))
    })

  /** The answer before any reading: no calendars, or none read yet. */
  const precheck = (m: Moment) =>
    Effect.gen(function*() {
      if (m.configs.length === 0) return { spoken: say(texts, m.lang, "noCalendars") } as Spoken
      if (yield* nothingRead(m)) return { spoken: say(texts, m.lang, "notRead") } as Spoken
      return undefined
    })

  /** Distinct occurrences (a long event has a row on each day). */
  const keyOf = (r: Row<Occurrence>) => `${r.value.source}\u0000${r.value.start}\u0000${r.value.end}\u0000${r.value.title}`

  /** One day's events for `who`: shown, reduced, the count withheld, and whether the read was cut short. */
  const dayEvents = (m: Moment, d: LocalDate, who: Who, options: { readonly withHousehold?: boolean; readonly fromNow?: boolean } = {}) =>
    Effect.gen(function*() {
      const read = yield* readDay(d)
      const show: Array<Row<Occurrence>> = []
      const reduce: Array<Row<Occurrence>> = []
      const withheldKeys = new Set<string>()
      const withheldRows: Array<Row<Occurrence>> = []
      for (const r of read.rows) {
        if (!m.valid(r) || !meant(who, r, options.withHousehold)) continue
        if (options.fromNow === true && r.value.end <= m.now) continue
        const v = who.kind === "person" && who.reduced ? (r.value.owner === undefined ? "show" : "reduce") : m.visibility(r)
        if (v === "show") show.push(r)
        else if (v === "reduce" && !r.value.allDay) reduce.push(r)
        else if (!withheldKeys.has(keyOf(r))) {
          withheldKeys.add(keyOf(r))
          withheldRows.push(r)
        }
      }
      return { show, reduce, withheld: withheldKeys.size, withheldKeys, withheldRows, cut: read.cut }
    })

  return { moment, resolveWho, resolveDay, readDay, dayEvents, staleNote, precheck, shown, reduced, item, timeOf, dayWords, titleOf, calendarOf, keyOf, meant, rows: rowsC }
}

export type Reader = ReturnType<typeof makeReader>
export { capital }
