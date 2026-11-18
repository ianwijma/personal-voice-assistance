import { Devices, type ModuleHostApi, type ModuleStore, People, Privacy, type Row, type TurnContext } from "@pva/core"
import { numberToWords, parseDateTime, speakDate, speakList, speakMoment, speakNumber, speakTime } from "@pva/language"
import { type Language, say } from "@pva/module-contracts"
import { Clock, Data, Effect } from "effect"
import { yieldToLoop } from "./answer.ts"
import { addressOf, type CalendarConfig, type CalendarSettings, type OwnerOf, ownerOf } from "./config.ts"
import { WINDOW_DAYS } from "./refresh.ts"
import { allStates, batchOf, linkPrint, type Occurrence, occurrences, ownerKey, ROWS_PAGE, type SourceState, sources } from "./store.ts"
import { texts } from "./texts.ts"
import { dateOf, dateOfDayNumber, dayNumber, daysBetween, homeZone, type LocalDate, parseIsoDate, wallTimeOf } from "./time.ts"

/**
 * Reading the cache for a turn (docs/MODULES.md §5, §7, §15): bounded indexed reads of the store, nothing from the
 * network.
 *
 * **One accepted read per calendar.** An answer reads the calendars' states, its rows, and the states again, and reads
 * again when a refresh published a generation in between (`consistent`). It uses only the rows of each calendar's
 * current generation, and only while the generation was read from the address, for the owner and in the zone the
 * settings have now.
 *
 * **Decided after the last read.** Who may hear what (`Privacy`, `People`, `Devices`) is looked up once every read of
 * the answer is done, synchronously (`view`), for the asking turn: membership and the device's place are never held
 * across a wait.
 *
 * **Privacy** (docs/MODULES-PLAN.md §2 row 8; docs/modules/calendar.md, "Privacy"). An event of a household calendar
 * is shown everywhere. An event of a member's calendar is shown where `Privacy.mayReveal(owner, turn)` says yes; on a
 * known `shared` device, for a member, one that blocks time is reduced to "Robin is busy from two to three" (no title,
 * place or calendar name); anything else is withheld and only counted. Searching by text never looks at an event that
 * is not shown.
 *
 * **Honest about what it covers** (`coverage`): every answer says, beside its events, which calendars could not be
 * refreshed and since when, which were read incompletely (so many events could not be read), which have not been
 * read, that its scan was cut, how many personal events were withheld, and that an event goes on after the days kept.
 */

export const DAY_ROWS = 200
export const FIND_ROWS = 1_000
export const NEXT_ROWS = 1_000

export type Visibility = "show" | "reduce" | "withhold"

export type Who =
  | { readonly kind: "all" }
  | { readonly kind: "household" }
  | { readonly kind: "person"; readonly id: string; readonly name: string }

/** A question or refusal instead of an answer: spoken as it is. */
export interface Spoken {
  readonly spoken: string
}

export const isSpoken = (u: unknown): u is Spoken => typeof u === "object" && u !== null && "spoken" in u && Object.keys(u).length === 1

const ALL_WORDS = new Set(["everyone", "everybody", "all", "anyone", "iedereen", "allemaal", "alle"])
const HOUSEHOLD_WORDS = new Set(["household", "family", "home", "the family", "the household", "huishouden", "gezin", "familie", "het gezin", "de familie", "het huishouden"])
const ME_WORDS = new Set(["me", "my", "mine", "myself", "i", "ik", "mij", "mijn", "mezelf"])

export const capital = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

/** The answer could not be read as one version of the calendars (they kept changing while it read). */
export class Unsettled extends Data.TaggedError("Unsettled")<{}> {}

export interface ReadEnv {
  readonly host: ModuleHostApi
  readonly store: ModuleStore
  readonly settings: () => CalendarSettings
  readonly language: () => Language
}

/** What a read needs about now that holds no decision about people: the clock, the zone, the language, the settings. */
export interface Moment {
  readonly now: number
  readonly zone: string
  readonly lang: Language
  readonly today: LocalDate
  readonly turn: TurnContext | undefined
  readonly settings: CalendarSettings
  readonly configs: ReadonlyArray<CalendarConfig>
}

/** A configured calendar as an answer sees it. */
export interface Cal {
  readonly config: CalendarConfig
  readonly name: string
  readonly owner: OwnerOf
  readonly state: SourceState | undefined
  /** Its current generation was read from what the settings say now (address, owner, zone). */
  readonly usable: boolean
  readonly batch: string | undefined
}

/** What must be said beside an answer's events (each a sentence, or absent). */
export interface Notes {
  readonly withheld?: string
  readonly stale?: string
  readonly notRead?: string
  readonly incomplete?: string
  readonly cut?: string
  readonly continues?: string
  readonly notSearched?: string
}

/** The notes in the order they are said. */
export const noteList = (n: Notes): Array<string> =>
  [n.notSearched, n.withheld, n.stale, n.notRead, n.incomplete, n.cut, n.continues].filter((s): s is string => s !== undefined)

/** A day's rows: in start order (or, from `now`, the ones that have not ended), how many were read, and whether there were more. */
export interface DayRead {
  readonly rows: ReadonlyArray<Row<Occurrence>>
  readonly read: number
  readonly cut: boolean
}

export const makeReader = (env: ReadEnv) => {
  const rowsC = env.store.collection(occurrences)
  const statesC = env.store.collection(sources)

  const moment = (turn: TurnContext | undefined, language?: Language) =>
    Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const zone = homeZone(env.host.view())
      const settings = env.settings()
      return { now, zone, lang: language ?? env.language(), today: dateOf(now, zone), turn, settings, configs: settings.calendars ?? [] } satisfies Moment
    })

  /**
   * `read` between two reads of the calendars' states; again (at most three times) when a calendar's current
   * generation changed meanwhile, so what was read is of one generation per calendar.
   */
  const consistent = <A, E>(read: (states: ReadonlyArray<Row<SourceState>>) => Effect.Effect<A, E>) =>
    Effect.gen(function*() {
      const gens = (s: ReadonlyArray<Row<SourceState>>) => s.map((r) => `${r.id}:${r.value.gen ?? ""}`).sort().join(",")
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = yield* allStates((q) => statesC.list(q))
        const value = yield* read(before)
        const after = yield* allStates((q) => statesC.list(q))
        if (gens(before) === gens(after)) return { states: after, value }
      }
      return yield* Effect.fail(new Unsettled())
    })

  /** One day's rows, page by page, at most `DAY_ROWS`; `fromNow`: only those that have not ended (by end, newest first). */
  const readDay = (d: LocalDate, fromNow?: number) =>
    Effect.gen(function*() {
      const day = dayNumber(d)
      const order = fromNow !== undefined ? { field: "end" as const, direction: "desc" as const } : { field: "start" as const }
      const out: Array<Row<Occurrence>> = []
      let after: Row<Occurrence> | undefined
      let read = 0
      // A real turn of the event loop before each day read, and between its pages.
      yield* yieldToLoop
      for (;;) {
        const page = yield* rowsC.list({ where: { day }, orderBy: order, limit: ROWS_PAGE, ...(after !== undefined ? { after } : {}) })
        read += page.length
        for (const r of page) if (fromNow === undefined || r.value.end > fromNow) out.push(r)
        // From now: past the first row that has ended, every one has.
        if (page.length < ROWS_PAGE || (fromNow !== undefined && page.some((r) => r.value.end <= fromNow))) return { rows: sortRows(out), read, cut: false } satisfies DayRead
        after = page.at(-1)
        if (read >= DAY_ROWS) break
        // A real turn of the event loop between pages: a turn's reads never hold it for more than a page.
        yield* yieldToLoop
      }
      const beyond = yield* rowsC.list({ where: { day }, orderBy: order, limit: 1, after: after! })
      return { rows: sortRows(out), read, cut: beyond.length > 0 && (fromNow === undefined || beyond[0]!.value.end > fromNow) } satisfies DayRead
    })

  /**
   * Everything about people and calendars an answer decides, looked up now (after the answer's last read) for the
   * asking turn, with the calendars' states that read gave. Synchronous: nothing it decides is held across a wait.
   */
  const view = (m: Moment, states: ReadonlyArray<Row<SourceState>>) => {
    const people = env.host.service(People)
    const privacy = env.host.service(Privacy)
    const devices = env.host.service(Devices)
    const cals = new Map<string, Cal>()
    for (const c of m.configs) {
      const name = c.name.trim()
      const state = states.find((s) => s.value.name.trim().toLowerCase() === name.toLowerCase())?.value
      const owner = ownerOf(c, people)
      const address = addressOf(c, m.settings)
      const usable = state?.gen !== undefined && owner.kind !== "unknown" && address !== undefined && state.link === linkPrint(address) && state.owner === ownerKey(owner) &&
        state.zone === m.zone
      cals.set(name.toLowerCase(), { config: c, name, owner, state, usable, batch: state?.gen !== undefined ? batchOf(name, state.gen) : undefined })
    }
    const calOf = (r: Row<Occurrence>) => cals.get(r.value.source.trim().toLowerCase())
    /** A row of its calendar's current generation, read from what the settings say now, of the calendar's owner. */
    const ok = (r: Row<Occurrence>) => {
      const c = calOf(r)
      if (c === undefined || !c.usable || r.value.batch !== c.batch) return false
      return c.owner.kind === "household" ? r.value.owner === undefined : c.owner.kind === "person" && r.value.owner === c.owner.id
    }
    const mayReveal = (owner: string) => privacy?.mayReveal(owner, m.turn) === true
    /** On a known shared device, for an owner who is a member now. */
    const mayReduce = (owner: string) => {
      if (m.turn?.deviceId === undefined || people?.get(owner) === undefined) return false
      return devices?.get(m.turn.deviceId)?.place.privacy === "shared"
    }
    const visibility = (r: Row<Occurrence>): Visibility => {
      const owner = r.value.owner
      if (owner === undefined || mayReveal(owner)) return "show"
      // Only time that is really blocked is said to be busy: an all-day or transparent event is only counted.
      return r.value.busy && mayReduce(owner) ? "reduce" : "withhold"
    }
    const nameOf = (owner: string) => people?.get(owner)?.name ?? ""

    /** Who a request means: everyone (default), the household's calendars, the asking person, or a member by name. */
    const who = (text: string | undefined): Who | Spoken => {
      const t = (text ?? "").trim().toLowerCase()
      if (t === "" || ALL_WORDS.has(t)) return { kind: "all" }
      if (HOUSEHOLD_WORDS.has(t)) return { kind: "household" }
      if (ME_WORDS.has(t)) {
        const person = m.turn?.person?.id
        if (person === undefined) return { spoken: say(texts, m.lang, "whose") }
        if (!mayReveal(person)) return { spoken: say(texts, m.lang, "notHere") }
        return { kind: "person", id: person, name: nameOf(person) }
      }
      const found = people?.find(text!.trim()) ?? { kind: "none" as const }
      if (found.kind === "ambiguous") return { spoken: say(texts, m.lang, "whoWhich", { list: speakList(found.people.map((p) => p.name), m.lang, { max: 6 }) ?? "" }) }
      if (found.kind === "none") return { spoken: say(texts, m.lang, "whoUnknown", { name: text!.trim() }) }
      const p = found.person
      if (mayReveal(p.id) || mayReduce(p.id)) return { kind: "person", id: p.id, name: p.name }
      return { spoken: say(texts, m.lang, "notHere") }
    }

    /** Whether a row is one `who` asks about (`withHousehold`: free time counts the household's events too). */
    const meant = (w: Who, r: Row<Occurrence>, withHousehold = false) =>
      w.kind === "all" || (w.kind === "household" ? r.value.owner === undefined : r.value.owner === w.id || (withHousehold && r.value.owner === undefined))

    /** The calendars an answer for `who` covers. */
    const relevant = (w: Who, withHousehold = false): ReadonlyArray<Cal> =>
      [...cals.values()].filter((c) =>
        w.kind === "all" || (w.kind === "household"
          ? c.owner.kind === "household"
          : (c.owner.kind === "person" && c.owner.id === w.id) || (withHousehold && c.owner.kind === "household"))
      )

    /** The answer before any event: no calendars at all, or none of those it covers read yet. */
    const precheck = (covered: ReadonlyArray<Cal>): Spoken | undefined => {
      if (m.configs.length === 0) return { spoken: say(texts, m.lang, "noCalendars") }
      if (covered.length > 0 && !covered.some((c) => c.usable)) return { spoken: say(texts, m.lang, "notRead") }
      return undefined
    }

    /** Calendars named where their events could be shown here; the others only counted ("2 personal calendars"). */
    const namesOf = (list: ReadonlyArray<Cal>) => {
      const named = list.filter((c) => c.owner.kind === "household" || (c.owner.kind === "person" && mayReveal(c.owner.id))).map((c) => c.name)
      const hidden = list.length - named.length
      const all = hidden > 0 ? [...named, say(texts, m.lang, "personalCalendars", { count: hidden })] : named
      return speakList(all, m.lang, { max: 4 }) ?? ""
    }

    /**
     * What must be said beside an answer about `covered` calendars: the one function every tool, action and the
     * briefing asks, so no answer leaves any of it out.
     */
    const coverage = (covered: ReadonlyArray<Cal>, extra: { readonly cut?: boolean; readonly withheld?: number; readonly continuesAfter?: LocalDate; readonly notSearched?: boolean } = {}): Notes => {
      const stale = covered.filter((c) => c.usable && c.state?.error !== undefined)
      const notRead = covered.filter((c) => !c.usable)
      const incomplete = covered.filter((c) => c.usable && (c.state?.unreadable ?? 0) > 0)
      const out: { -readonly [K in keyof Notes]: Notes[K] } = {}
      if (extra.notSearched === true) out.notSearched = say(texts, m.lang, "notSearched")
      if ((extra.withheld ?? 0) > 0) out.withheld = say(texts, m.lang, "withheld", { count: extra.withheld! })
      if (stale.length > 0) {
        const oldest = Math.min(...stale.map((c) => c.state!.okAt ?? c.state!.triedAt))
        out.stale = say(texts, m.lang, "stale", { names: namesOf(stale), time: momentWords(oldest) })
      }
      if (notRead.length > 0) out.notRead = say(texts, m.lang, "neverRead", { names: namesOf(notRead) })
      if (incomplete.length > 0) {
        const count = incomplete.reduce((n, c) => n + (c.state?.unreadable ?? 0), 0)
        out.incomplete = say(texts, m.lang, "incomplete", { names: namesOf(incomplete), count })
      }
      if (extra.cut === true) out.cut = say(texts, m.lang, "cut")
      if (extra.continuesAfter !== undefined) out.continues = say(texts, m.lang, "continues", { day: dayWords(extra.continuesAfter) })
      return out
    }

    /** Whether some calendar `who` covers is personal and cannot be shown here (a search does not look at it). */
    const unsearched = (covered: ReadonlyArray<Cal>) => covered.some((c) => c.owner.kind !== "household" && !(c.owner.kind === "person" && mayReveal(c.owner.id)))

    /** The last day the row's generation keeps, when the row goes on after it. */
    const beyondDay = (r: Row<Occurrence>): LocalDate | undefined => {
      if (!r.value.beyond) return undefined
      const last = calOf(r)?.state?.lastDay
      return last !== undefined ? dateOfDayNumber(last) : undefined
    }

    // ---- Words (times and dates by @pva/language)
    const timeOf = (instant: number) => {
      const w = wallTimeOf(instant, m.zone)
      return speakTime({ hour: w.hour, minute: w.minute }, m.lang) ?? `${w.hour}:${String(w.minute).padStart(2, "0")}`
    }
    const dayWords = (d: LocalDate) => speakDate(d, m.lang, m.today) ?? `${d.year}-${d.month}-${d.day}`
    const momentWords = (instant: number) => {
      const d = dateOf(instant, m.zone)
      const w = wallTimeOf(instant, m.zone)
      return speakMoment({ date: d, time: { hour: w.hour, minute: w.minute } }, m.lang, m.today) ?? `${dayWords(d)} ${timeOf(instant)}`
    }
    /** A start or end on day `d`: its time when it is on `d` (an end at midnight after `d` too), else its moment. */
    const onDay = (instant: number, d: LocalDate, isEnd = false) => {
      const at = dateOf(isEnd ? instant - 1 : instant, m.zone)
      return daysBetween(at, d) === 0 ? timeOf(instant) : momentWords(instant)
    }
    const titleOf = (r: Row<Occurrence>, max = 120) => (r.value.title === "" ? say(texts, m.lang, "untitled") : r.value.title.slice(0, max))
    const calendarOf = (r: Row<Occurrence>) => calOf(r)?.name ?? r.value.source

    /** The local days an occurrence covers, first and last. */
    const span = (r: Row<Occurrence>) => {
      const v = r.value
      return { first: dateOf(v.start, m.zone), last: dateOf(v.end > v.start ? v.end - 1 : v.start, m.zone) }
    }

    /** When an event is, for a tool result: its real start and end (dates of an all-day one), and that it goes on. */
    const whenOf = (r: Row<Occurrence>) => {
      const v = r.value
      const { first, last } = span(r)
      const beyond = beyondDay(r)
      const sameDay = daysBetween(first, last) === 0
      const goesOn = beyond !== undefined ? { continuesAfter: dayWords(beyond) } : {}
      if (v.allDay) return sameDay && beyond === undefined ? { allDay: true } : { allDay: true, from: dayWords(first), ...(beyond === undefined ? { to: dayWords(last) } : goesOn) }
      if (sameDay && beyond === undefined) return { time: timeOf(v.start), until: timeOf(v.end) }
      return { from: momentWords(v.start), ...(beyond === undefined ? { until: momentWords(v.end) } : goesOn) }
    }

    /** An event as a tool result shows it (the model words it). */
    const shown = (r: Row<Occurrence>) => ({
      title: titleOf(r),
      ...whenOf(r),
      calendar: calendarOf(r),
      ...(r.value.location !== undefined ? { place: r.value.location } : {})
    })

    /** A reduced event on day `d`: whose, and when they are busy; nothing else. */
    const reduced = (d: LocalDate, r: Row<Occurrence>) => {
      const beyond = beyondDay(r)
      return {
        busy: nameOf(r.value.owner!),
        from: onDay(r.value.start, d),
        to: beyond !== undefined ? say(texts, m.lang, "afterDay", { day: dayWords(beyond) }) : onDay(r.value.end, d, true)
      }
    }

    /** An event as a spoken item on day `d`: "standup at half past nine", "trip, all day from Saturday to Monday". */
    const item = (d: LocalDate, r: Row<Occurrence>, max = 120) => {
      const title = titleOf(r, max)
      const v = r.value
      const { first, last } = span(r)
      const beyond = beyondDay(r)
      if (v.allDay) {
        if (beyond !== undefined) return say(texts, m.lang, "allDayAfter", { title, from: dayWords(first), day: dayWords(beyond) })
        return daysBetween(first, last) === 0 ? say(texts, m.lang, "allDay", { title }) : say(texts, m.lang, "allDayFromTo", { title, from: dayWords(first), to: dayWords(last) })
      }
      if (beyond !== undefined) return say(texts, m.lang, "fromAfter", { title, from: momentWords(v.start), day: dayWords(beyond) })
      if (daysBetween(first, last) === 0 && daysBetween(first, d) === 0) return say(texts, m.lang, "at", { title, time: timeOf(v.start) })
      return say(texts, m.lang, "fromUntil", { title, from: onDay(v.start, d), to: onDay(v.end, d, true) })
    }

    /** A list as it is said, its true total counted: "a, b, c, d and 196 more". */
    const listOf = (items: ReadonlyArray<string>, total: number, max: number) => {
      if (total <= max) return speakList(items.slice(0, total), m.lang, { max }) ?? ""
      const more = total - (max - 1)
      const count = more <= 20 ? (numberToWords(more, m.lang) ?? String(more)) : (speakNumber(more, m.lang) ?? String(more))
      return speakList([...items.slice(0, max - 1), say(texts, m.lang, "nMore", { count })], m.lang, { max }) ?? ""
    }

    return {
      m,
      cals,
      ok,
      visibility,
      mayReveal,
      nameOf,
      who,
      meant,
      relevant,
      precheck,
      coverage,
      unsearched,
      beyondDay,
      timeOf,
      dayWords,
      momentWords,
      titleOf,
      calendarOf,
      shown,
      reduced,
      item,
      listOf
    }
  }

  return { moment, consistent, readDay, view, rows: rowsC }
}

/** Rows in start order (then end, then identity): the order every answer uses. */
const sortRows = (rows: Array<Row<Occurrence>>) => rows.sort((a, b) => a.value.start - b.value.start || a.value.end - b.value.end || (a.value.key < b.value.key ? -1 : a.value.key > b.value.key ? 1 : 0))

/** An occurrence's identity across its day rows: its calendar and its key (UID and recurrence id). */
export const identityOf = (r: Row<Occurrence>) => `${r.value.source.trim().toLowerCase()}\u0000${r.value.key}`

/** The day a phrase or ISO date means (default today), or the question to ask. */
export const resolveDay = (m: Moment, text: string | undefined): LocalDate | Spoken => {
  const t = (text ?? "").trim()
  let date: LocalDate | undefined = t === "" ? m.today : parseIsoDate(t)
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

export type Reader = ReturnType<typeof makeReader>
export type View = ReturnType<Reader["view"]>
