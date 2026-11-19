import { normalizeTimeZone } from "@pva/language"
import type ICALModule from "ical.js"
import { createHash } from "node:crypto"
import { addDays, dateOf, dayNumber, daysBetween, instantOf, type LocalDate, startOfDay } from "./time.ts"

/**
 * Reading an ICS file (RFC 5545) into the occurrences of a time window. **A pure function, run off the main thread**
 * (`ics.task.ts` through `offThread`, with a real time limit, a memory limit and a bounded answer): nothing here
 * yields, and nothing here needs to.
 *
 * The calendar arithmetic is `ical.js`'s own: its parser, `ICAL.Event` with its exceptions (`RECURRENCE-ID`, also
 * `RANGE=THISANDFUTURE`), its recurrence iterator (`RRULE`, `RDATE`, `EXDATE`) and `getOccurrenceDetails`, and the
 * file's own `VTIMEZONE` definitions. Where the library needs help, that is done first, before anything is computed:
 *
 * - **Zones.** A `TZID` the file does not define is tried as an IANA zone name and registered with the library's time
 *   zone service; floating times are the household's (its zone registered the same way). A `TZID` that is neither is
 *   unresolved: the event is left out and counted, never read as another zone.
 * - **Period `RDATE`s** (`RDATE;VALUE=PERIOD:start/end`), which the library's iterator cannot expand: their starts are
 *   given to it as plain `RDATE`s and their own ends are kept for them.
 * - **Recurrence ids** are matched by their instant too (a `RECURRENCE-ID` in UTC for a zoned series).
 * - **Durations**: hours, minutes and seconds of a `DURATION` are elapsed time, days and weeks calendar days (the
 *   library adds both to the wall clock); an instance of a series with a `DTEND` lasts exactly as long as the first.
 * - **Moved instances** are found by their real times: the series is followed past the window as far as its latest
 *   moved instance, so one moved into the window from beyond it is there.
 *
 * **Nothing is guessed.** An event whose zone cannot be resolved, whose times cannot be read, that names a rule the
 * module does not apply (`EXRULE`), whose schedule line is over the line bound, or that the library cannot expand is
 * left out and counted in `unreadable`. A file that is not a well-formed calendar (not `BEGIN:VCALENDAR`, components
 * not closed, cut off) is `not-calendar`, and one over a limit (events, occurrences, rows) is `too-many`: the refresh
 * keeps the last good read in both cases.
 *
 * Titles and places are one bounded line; descriptions, alarms and attachments are never read. Text that contains the
 * private link the calendar was read from, or a secret part of it, is dropped (a title becomes empty, an event whose
 * UID holds it is left out).
 */

export type ICAL = typeof ICALModule

export interface ExpandLimits {
  /** Events (`VEVENT`s) in the file. */
  readonly events: number
  /** Occurrences in the window. */
  readonly occurrences: number
  /** Rows they make: one per local day each covers in the window. */
  readonly rows: number
  /** Steps of one series' iterator before it is left out. */
  readonly seriesSteps: number
  readonly titleChars: number
  readonly placeChars: number
}

export interface ExpandInput {
  readonly text: string
  /** Epoch ms: occurrences that end at or before `from`, or start at or after `to`, are left out. */
  readonly from: number
  readonly to: number
  /** The household's IANA zone (floating times and all-day events are in it). */
  readonly zone: string
  /** Lower-case text no title, place or UID may contain (`secretPartsOf`). */
  readonly forbidden: ReadonlyArray<string>
  readonly limits: ExpandLimits
}

/** One occurrence, as the refresh writes it. */
export interface Occ {
  /** Identity: a hash of the event's UID and the occurrence's recurrence id (24 hex digits). */
  readonly key: string
  /** Epoch ms; an all-day event's local midnight in the household's zone. */
  readonly start: number
  /** Epoch ms, exclusive. */
  readonly end: number
  readonly allDay: boolean
  /** The first and last local days (`YYYYMMDD`) of the window it covers. */
  readonly first: number
  readonly last: number
  /** It goes on after the window. */
  readonly beyond: boolean
  readonly title: string
  readonly location?: string
  readonly busy: boolean
}

export type ExpandOutput =
  | { readonly ok: true; readonly occurrences: ReadonlyArray<Occ>; readonly unreadable: number }
  | { readonly ok: false; readonly reason: "not-calendar" | "too-many" }

const MAX_LINE_CHARS = 8_000
const MAX_TIMEZONES = 40
const MAX_TIMEZONE_LINES = 1_000
/** The household's zone, as the library knows it: floating times are given this `TZID`. */
const HOME_TZID = "X-PVA-HOUSEHOLD"

/** The properties of an event the module reads; every other one is dropped before parsing. */
const KEPT = new Set(["UID", "DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXDATE", "EXRULE", "RECURRENCE-ID", "SUMMARY", "LOCATION", "STATUS", "TRANSP"])
const TEXT_PROPS = new Set(["SUMMARY", "LOCATION"])
const TIME_PROPS = new Set(["DTSTART", "DTEND", "RDATE", "EXDATE", "RECURRENCE-ID"])

class NotCalendar extends Error {}
class TooMany extends Error {}

/** A content line: its name, its parameters (from the first `;`, raw) and its value; `undefined` when it has no `:`. */
const splitLine = (line: string): { readonly name: string; readonly params: string; readonly value: string } | undefined => {
  let quoted = false
  let nameEnd = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "\"") quoted = !quoted
    else if (!quoted && ch === ";" && nameEnd < 0) nameEnd = i
    else if (!quoted && ch === ":") {
      const end = nameEnd < 0 ? i : nameEnd
      return { name: line.slice(0, end).toUpperCase(), params: line.slice(end, i), value: line.slice(i + 1) }
    }
  }
  return undefined
}

const paramOf = (params: string, name: string): string | undefined => {
  const m = new RegExp(`;${name}=("([^"]*)"|[^;:]*)`, "i").exec(params)
  return m === null ? undefined : (m[2] ?? m[1])
}

const OFFSET = /^[+-]\d{4}(?:\d{2})?$/

/**
 * Whether a VTIMEZONE can be used: at least one STANDARD or DAYLIGHT observance with a local DTSTART and both offsets
 * (`TZOFFSETFROM`, `TZOFFSETTO`). An empty or broken definition is not one: its name is then tried as an IANA zone,
 * and failing that its events cannot be read (an empty definition would otherwise read as UTC).
 */
const usableZone = (lines: ReadonlyArray<string>): boolean => {
  let inObservance = false
  let start = false
  let from = false
  let to = false
  for (const l of lines) {
    const p = splitLine(l)
    if (p === undefined) continue
    const value = p.value.trim()
    if (p.name === "BEGIN" && (value.toUpperCase() === "STANDARD" || value.toUpperCase() === "DAYLIGHT")) {
      inObservance = true
      start = from = to = false
    } else if (p.name === "END" && inObservance) {
      if (start && from && to) return true
      inObservance = false
    } else if (inObservance) {
      if (p.name === "DTSTART" && /^\d{8}T\d{6}$/.test(value) && checkDateTime(value) !== undefined) start = true
      else if (p.name === "TZOFFSETFROM" && OFFSET.test(value)) from = true
      else if (p.name === "TZOFFSETTO" && OFFSET.test(value)) to = true
    }
  }
  return false
}

const daysIn = (year: number, month: number) => [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!

/** A DATE (`YYYYMMDD`) of a real day, or `undefined`. */
const checkDate = (v: string): string | undefined => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (m === null) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo) ? v : undefined
}

/** A DATE-TIME (`YYYYMMDDTHHMMSS`, `Z` or not) of a real day and time, a leap second read as 59; or `undefined`. */
const checkDateTime = (v: string): string | undefined => {
  const m = /^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v)
  if (m === null || checkDate(m[1]!) === undefined) return undefined
  const [h, mi, se] = [Number(m[2]), Number(m[3]), Number(m[4])]
  if (h > 23 || mi > 59 || se > 60) return undefined
  return se === 60 ? `${m[1]}T${m[2]}${m[3]}59${m[5]}` : v
}

const DURATION = /^[+-]?P(?:\d+W|(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/

/**
 * Every value of a time property checked for its exact syntax and real ranges (month, the day of that month and
 * year, hour 0 to 23, minute and second 0 to 59; a leap second read as 59), before the library could normalise one
 * (it reads 30 February as 2 March, hour 25 as the next day): the values as they are to be read, or `undefined`.
 */
const checkValues = (p: { readonly name: string; readonly params: string; readonly value: string }): string | undefined => {
  const kind = (paramOf(p.params, "VALUE") ?? "").toUpperCase()
  const values = p.value.trim().split(",")
  if (values.length === 0 || ((p.name === "DTSTART" || p.name === "DTEND" || p.name === "RECURRENCE-ID") && values.length !== 1)) return undefined
  const out: Array<string> = []
  for (const v of values) {
    let c: string | undefined
    if (kind === "PERIOD" || v.includes("/")) {
      if (p.name !== "RDATE" || (kind !== "PERIOD" && kind !== "")) return undefined
      const [a, b, ...rest] = v.split("/")
      const from = checkDateTime(a ?? "")
      const to = b === undefined || rest.length > 0 ? undefined : DURATION.test(b) ? b : checkDateTime(b)
      c = from !== undefined && to !== undefined ? `${from}/${to}` : undefined
    } else if (kind === "DATE") c = checkDate(v)
    else if (kind === "" || kind === "DATE-TIME") c = checkDateTime(v)
    if (c === undefined) return undefined
    out.push(c)
  }
  return out.join(",")
}

/** A rule's `UNTIL`, when it has one, is a real date or date-time. */
const untilIsValid = (rule: string): boolean => {
  const until = /(?:^|;)UNTIL=([^;]*)/i.exec(rule)?.[1]
  return until === undefined || checkDate(until) !== undefined || checkDateTime(until) !== undefined
}

/**
 * A YEARLY rule without BYMONTHDAY, BYDAY, BYYEARDAY or BYWEEKNO gets its start's day (and month, unless BYMONTH is
 * given); a MONTHLY one without BYMONTHDAY or BYDAY its start's day: what RFC 5545 leaves implicit, made explicit, so
 * the library skips a month or year that does not have the day (29 February, the 31st) instead of moving it.
 */
const explicitDay = (rule: string, start: string): { readonly rule: string; readonly implicit: { readonly day: number; readonly month?: number } } | undefined => {
  const parts = rule.split(";").filter((x) => x !== "")
  const has = (key: string) => parts.some((x) => x.toUpperCase().startsWith(`${key}=`))
  const freq = parts.find((x) => x.toUpperCase().startsWith("FREQ="))?.slice(5).toUpperCase()
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(start)
  if (m === null) return undefined
  const month = Number(m[2])
  const day = Number(m[3])
  if (freq === "YEARLY" && !has("BYMONTHDAY") && !has("BYDAY") && !has("BYYEARDAY") && !has("BYWEEKNO")) {
    const withMonth = has("BYMONTH")
    return { rule: [...parts, ...(withMonth ? [] : [`BYMONTH=${month}`]), `BYMONTHDAY=${day}`].join(";"), implicit: withMonth ? { day } : { day, month } }
  }
  if (freq === "MONTHLY" && !has("BYMONTHDAY") && !has("BYDAY")) return { rule: [...parts, `BYMONTHDAY=${day}`].join(";"), implicit: { day } }
  return undefined
}

/** RFC 5545 text unescaped (`\,`, `\;`, `\\`, `\n`). */
const unescapeText = (s: string) => s.replace(/\\([,;\\nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c))

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** One line, trimmed, single-spaced, without control characters, at most `max`. */
export const cleanLine = (text: string, max: number): string =>
  text
    .replace(LONE_SURROGATE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/[\ud800-\udbff]$/, "")
    .trim()

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

interface RawEvent {
  readonly lines: Array<string>
  bad: boolean
}

interface Blocks {
  readonly events: ReadonlyArray<RawEvent>
  /** VTIMEZONE texts by TZID (whole definitions only). */
  readonly zones: ReadonlyMap<string, string>
  /** TZIDs whose definitions were not kept (over a bound): not resolved by the file. */
  readonly droppedZones: ReadonlySet<string>
}

/**
 * The file's structure checked and its events and time zones taken out: lines unfolded; every component closed, in
 * order, by its own `END`; nothing after the calendar's `END`. Of an event only the kept properties at its own level
 * (nested alarms dropped). An event whose schedule line is over the bound, or that has a line that is not a content
 * line, is marked bad (left out and counted).
 */
const splitBlocks = (text: string, limits: ExpandLimits, tainted: (s: string) => boolean): Blocks => {
  const raw = text.replace(/^\ufeff/, "").split(/\r\n|\n|\r/)
  const lines: Array<string> = []
  for (const l of raw) {
    if ((l.startsWith(" ") || l.startsWith("\t")) && lines.length > 0) {
      const last = lines[lines.length - 1]!
      // A line that has grown past the bound is not grown further: it is over the bound either way.
      if (last.length <= MAX_LINE_CHARS + 1) lines[lines.length - 1] = last + l.slice(1)
      continue
    }
    lines.push(l)
  }
  let i = 0
  while (i < lines.length && lines[i]!.trim() === "") i++
  if (i >= lines.length || lines[i]!.trim().toUpperCase() !== "BEGIN:VCALENDAR") throw new NotCalendar()
  const stack: Array<string> = []
  const events: Array<RawEvent> = []
  const zones = new Map<string, string>()
  const droppedZones = new Set<string>()
  let event: RawEvent | undefined
  let zone: Array<string> | undefined
  let closed = false
  for (; i < lines.length; i++) {
    const l = lines[i]!
    if (closed) {
      if (l.trim() !== "") throw new NotCalendar()
      continue
    }
    if (l.trim() === "") continue
    const p = splitLine(l)
    if (p === undefined || p.name === "") {
      // Not a content line: the event it is in cannot be read; elsewhere it is ignored.
      if (event !== undefined && stack.length === 2) event.bad = true
      continue
    }
    if (p.name === "BEGIN") {
      const what = p.value.trim().toUpperCase()
      if (what === "") throw new NotCalendar()
      if (stack.length === 0 && what !== "VCALENDAR") throw new NotCalendar()
      stack.push(what)
      if (stack.length === 2 && what === "VEVENT") {
        if (events.length >= limits.events) throw new TooMany()
        event = { lines: ["BEGIN:VEVENT"], bad: false }
        events.push(event)
      } else if (stack.length === 2 && what === "VTIMEZONE") zone = ["BEGIN:VTIMEZONE"]
      else if (zone !== undefined) zone.push(l)
      continue
    }
    if (p.name === "END") {
      const what = p.value.trim().toUpperCase()
      if (stack.length === 0 || stack[stack.length - 1] !== what) throw new NotCalendar()
      stack.pop()
      if (stack.length === 0) closed = true
      else if (stack.length === 1 && what === "VEVENT" && event !== undefined) {
        event.lines.push("END:VEVENT")
        event = undefined
      } else if (stack.length === 1 && what === "VTIMEZONE" && zone !== undefined) {
        zone.push("END:VTIMEZONE")
        const id = zone.map(splitLine).find((z) => z?.name === "TZID")?.value.trim()
        if (id !== undefined && id !== "") {
          // Kept only when it can be used: within the bounds, with at least one observance that has its offsets.
          if (zone.length <= MAX_TIMEZONE_LINES && zones.size < MAX_TIMEZONES && !zones.has(id) && usableZone(zone)) zones.set(id, zone.join("\r\n"))
          else if (!zones.has(id)) droppedZones.add(id)
        }
        zone = undefined
      } else if (zone !== undefined) zone.push(l)
      continue
    }
    if (zone !== undefined) {
      zone.push(l)
      continue
    }
    if (event === undefined || stack.length !== 2 || !KEPT.has(p.name)) continue
    if (TEXT_PROPS.has(p.name)) {
      // A text over the bound, or one holding the private link, is dropped; the event is still read.
      if (l.length <= MAX_LINE_CHARS && !tainted(p.value)) event.lines.push(l)
    } else if (l.length > MAX_LINE_CHARS) event.bad = true
    else if (p.name === "UID" && tainted(p.value)) event.bad = true
    else event.lines.push(l)
  }
  if (!closed) throw new NotCalendar()
  return { events, zones, droppedZones }
}

/** The household's zone, or an IANA zone a `TZID` names, for `ical.js`: its offset at a wall-clock time, from `Intl`. */
const ianaZone = (ICAL: ICAL, tzid: string, iana: string) => {
  const offsets = new Map<string, number>()
  class IanaZone extends ICAL.Timezone {
    override utcOffset(tt: InstanceType<ICAL["Time"]>): number {
      const key = `${tt.year}-${tt.month}-${tt.day}T${tt.hour}:${tt.minute}`
      let off = offsets.get(key)
      if (off === undefined) {
        const asUtc = Date.UTC(tt.year, tt.month - 1, tt.day, tt.hour, tt.minute, 0)
        off = Math.round((asUtc - instantOf({ year: tt.year, month: tt.month, day: tt.day, hour: tt.hour, minute: tt.minute, second: 0 }, iana)) / 1000)
        if (offsets.size > 200_000) offsets.clear()
        offsets.set(key, off)
      }
      return off
    }
  }
  return new IanaZone({ tzid })
}

type Time = InstanceType<ICAL["Time"]>
type Component = InstanceType<ICAL["Component"]>
type Event = InstanceType<ICAL["Event"]>
type Duration = InstanceType<ICAL["Duration"]>

class Unreadable extends Error {}

export const expandCalendar = (ICAL: ICAL, input: ExpandInput): ExpandOutput => {
  const { limits, zone: home } = input
  const forbidden = input.forbidden.map((f) => f.toLowerCase()).filter((f) => f.length > 0)
  const tainted = (s: string) => {
    if (forbidden.length === 0) return false
    const forms = [s, unescapeText(s), decoded(s), decoded(unescapeText(s))].map((f) => f.toLowerCase())
    return forms.some((f) => forbidden.some((x) => f.includes(x)))
  }
  let blocks: Blocks
  try {
    blocks = splitBlocks(input.text, limits, tainted)
  } catch (e) {
    if (e instanceof TooMany) return { ok: false, reason: "too-many" }
    return { ok: false, reason: "not-calendar" }
  }
  let unreadable = 0

  // ---- Zones: the file's own definitions; then each TZID it does not define, as an IANA zone; the household's.
  ICAL.TimezoneService.reset()
  ICAL.TimezoneService.register(ianaZone(ICAL, HOME_TZID, home), HOME_TZID)
  const resolved = new Set<string>([HOME_TZID, "UTC", "Z", "GMT", ...blocks.zones.keys()])
  const unresolved = new Set<string>()
  const zoneOf = (tzid: string): boolean => {
    if (resolved.has(tzid)) return true
    if (unresolved.has(tzid)) return false
    // A TZID the file does not define (or whose definition was over a bound): tried as an IANA zone name.
    const iana = normalizeTimeZone(tzid)
    if (iana === undefined) {
      unresolved.add(tzid)
      return false
    }
    ICAL.TimezoneService.register(ianaZone(ICAL, tzid, iana), tzid)
    resolved.add(tzid)
    return true
  }

  // ---- Each event's lines made ready for the library: every schedule value checked, zones resolved, floating times
  // the household's, a rule's implicit day made explicit. What cannot be read is left out and counted; an override that
  // cannot be read still takes out the instance it replaces (a cancellation by its recurrence id), and one whose
  // recurrence id cannot be read takes out its whole series.
  interface Ready {
    readonly text: string
    readonly zones: ReadonlyArray<string>
    readonly uid: string | undefined
    /** A cancellation to use instead when this event turns out unreadable later (its parse fails): an override's. */
    readonly fallback: { readonly text: string; readonly zones: ReadonlyArray<string> } | "poison" | undefined
    /** The day (and month) a rule's implicit day was made explicit with: every instance must fall on it. */
    readonly implicit: { readonly day: number; readonly month?: number } | undefined
  }
  const ready: Array<Ready> = []
  /** Series left out whole: their UIDs; counted once each. */
  const poisoned = new Set<string>()

  /** One time property's line made ready, or why not: `event` (the event cannot be read), `series` (nor its series). */
  const prepareTime = (l: string, p: { readonly name: string; readonly params: string; readonly value: string }, named: Set<string>): string | "event" | "series" => {
    const fails = p.name === "EXDATE" || p.name === "RDATE" ? "series" : "event"
    const checked = checkValues(p)
    if (checked === undefined) return fails
    const line = checked === p.value ? l : `${p.name}${p.params}:${checked}`
    const tzid = paramOf(p.params, "TZID")
    const isDate = (paramOf(p.params, "VALUE") ?? "").toUpperCase() === "DATE"
    if (tzid !== undefined) {
      if (!zoneOf(tzid)) return fails
      if (blocks.zones.has(tzid)) named.add(tzid)
      return line
    }
    if (isDate) return line
    // A date-time without a TZID: UTC when every value ends in Z, floating (the household's) when none does.
    const values = checked.split(",").map((v) => v.split("/")[0]!)
    const utcCount = values.filter((v) => /z$/i.test(v)).length
    if (utcCount === values.length) return line
    if (utcCount === 0) return `${p.name};TZID=${HOME_TZID}${p.params}:${checked}`
    return fails
  }

  for (const ev of blocks.events) {
    const lines = ev.lines.map((l) => ({ l, p: splitLine(l)! }))
    const uidLine = lines.find((x) => x.p.name === "UID")
    const uid = uidLine !== undefined && uidLine.p.value !== "" ? unescapeText(uidLine.p.value) : undefined
    const ridLine = lines.find((x) => x.p.name === "RECURRENCE-ID")
    /** The cancellation that stands in for an unreadable override, or `poison` when its recurrence id cannot be read. */
    const standIn = (): Ready["fallback"] => {
      if (ridLine === undefined) return undefined
      if (uid === undefined || /THISANDFUTURE/i.test(paramOf(ridLine.p.params, "RANGE") ?? "")) return "poison"
      const named = new Set<string>()
      const rid = prepareTime(ridLine.l, ridLine.p, named)
      if (rid === "event" || rid === "series") return "poison"
      return { text: ["BEGIN:VEVENT", uidLine!.l, rid, "STATUS:CANCELLED", "END:VEVENT"].join("\r\n"), zones: [...named] }
    }
    /** This event cannot be read: counted once; an override still takes out its instance. */
    const leaveOut = (series: boolean) => {
      const stand = series ? "poison" : standIn()
      if (stand === "poison" && uid !== undefined) poisoned.add(uid)
      else {
        unreadable++
        if (stand !== undefined && stand !== "poison") ready.push({ ...stand, uid, fallback: undefined, implicit: undefined })
      }
    }
    if (ev.bad) {
      leaveOut(false)
      continue
    }
    const out: Array<string> = []
    const named = new Set<string>()
    let failure: "event" | "series" | undefined
    let start: string | undefined
    for (const { l, p } of lines) {
      if (p.name === "EXRULE") {
        failure = "series"
        break
      }
      if (p.name === "RRULE") {
        if (!untilIsValid(p.value)) {
          failure = "series"
          break
        }
        out.push(l)
        continue
      }
      if (!TIME_PROPS.has(p.name)) {
        out.push(l)
        continue
      }
      const line = prepareTime(l, p, named)
      if (line === "event" || line === "series") {
        failure = failure === "series" ? "series" : line
        if (line === "series") break
        continue
      }
      if (p.name === "DTSTART") start = splitLine(line)!.value
      out.push(line)
    }
    if (failure !== undefined) {
      leaveOut(failure === "series")
      continue
    }
    // A YEARLY or MONTHLY rule's implicit day (and month) made explicit, so a day a month or year does not have is
    // skipped (RFC 5545 §3.3.10), never moved to the next one by the library.
    let implicit: Ready["implicit"]
    const text = out.map((l) => {
      const p = splitLine(l)!
      if (p.name !== "RRULE" || start === undefined) return l
      const made = explicitDay(p.value, start)
      if (made === undefined) return l
      implicit = made.implicit
      return `RRULE${p.params}:${made.rule}`
    })
    ready.push({ text: text.join("\r\n"), zones: [...named], uid, fallback: standIn(), implicit })
  }

  // ---- Parsed one by one (one malformed event never fails the file), with the time zones it names.
  const parsed: Array<{ readonly c: Component; readonly i: number; readonly implicit: Ready["implicit"] }> = []
  const parse = (r: { readonly text: string; readonly zones: ReadonlyArray<string> }) => {
    const root = new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", "VERSION:2.0", ...r.zones.map((z) => blocks.zones.get(z)!), r.text, "END:VCALENDAR"].join("\r\n")))
    return root.getFirstSubcomponent("vevent")
  }
  for (let i = 0; i < ready.length; i++) {
    const r = ready[i]!
    let vevent: Component | null = null
    try {
      vevent = parse(r)
    } catch {
      vevent = null
    }
    // A cancelled instance needs no start: its RECURRENCE-ID is enough to take it out (RFC 5546 tombstones).
    const tombstone = vevent !== null && vevent.getFirstProperty("recurrence-id") !== null && String(vevent.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED"
    if (vevent !== null && (vevent.getFirstProperty("dtstart") !== null || tombstone)) {
      parsed.push({ c: vevent, i, implicit: r.implicit })
      continue
    }
    // It cannot be read after all: counted, and an override still takes out its instance.
    if (r.fallback === "poison" && r.uid !== undefined) {
      poisoned.add(r.uid)
      continue
    }
    unreadable++
    if (r.fallback !== undefined && r.fallback !== "poison") {
      try {
        const stand = parse(r.fallback)
        if (stand !== null) parsed.push({ c: stand, i, implicit: undefined })
        else if (r.uid !== undefined) poisoned.add(r.uid)
      } catch {
        if (r.uid !== undefined) poisoned.add(r.uid)
      }
    }
  }
  unreadable += poisoned.size

  // ---- Grouped by UID: the series (or single event) and its exceptions; a series left out whole is not grouped.
  const groups = new Map<string, { master?: Component; exceptions: Array<Component>; implicit?: Ready["implicit"] }>()
  for (const { c, i, implicit } of parsed) {
    const uidValue = c.getFirstPropertyValue("uid")
    const uid = typeof uidValue === "string" && uidValue !== "" ? uidValue : `\u0000no-uid-${i}`
    if (poisoned.has(uid)) continue
    const g = groups.get(uid) ?? { exceptions: [] }
    if (c.getFirstProperty("recurrence-id") !== null) g.exceptions.push(c)
    else if (g.master === undefined) {
      g.master = c
      if (implicit !== undefined) g.implicit = implicit
    } else unreadable++ // two events of one UID, neither an exception: which is meant is not known
    groups.set(uid, g)
  }

  const utc = ICAL.Timezone.utcTimezone
  /** The instant of a library time; a date is the household's local midnight. */
  const instant = (t: Time): number => {
    if (t.isDate) return startOfDay({ year: t.year, month: t.month, day: t.day }, home)
    if (t.zone === ICAL.Timezone.localTimezone) throw new Unreadable() // an unresolved zone reached the library
    return t.toUnixTime() * 1000
  }
  /** `t` plus a duration: days and weeks on the calendar (the wall clock in `t`'s zone), the rest elapsed. */
  const plus = (t: Time, d: Duration): number => {
    if (d.isNegative) throw new Unreadable()
    const days = d.weeks * 7 + d.days
    const rest = d.hours * 3_600 + d.minutes * 60 + d.seconds
    if (t.isDate) {
      if (rest !== 0) throw new Unreadable()
      return startOfDay(addDays({ year: t.year, month: t.month, day: t.day }, days), home)
    }
    const moved = t.clone()
    if (days !== 0) moved.adjust(days, 0, 0, 0)
    return instant(moved) + rest * 1_000
  }
  /** How long one occurrence of `item` lasts from `start`, as its own DTEND or DURATION says (RFC 5545 §3.8.5.3). */
  const endOf = (item: Event, startTime: Time, start: number, own: boolean): number => {
    const c = item.component
    const duration = c.getFirstPropertyValue("duration")
    if (duration !== null && duration !== undefined) return plus(startTime, duration as Duration)
    if (c.getFirstProperty("dtend") !== null) {
      const s = item.startDate
      const e = item.endDate
      if (s.isDate !== e.isDate) throw new Unreadable()
      if (own) return instant(e)
      if (s.isDate) return startOfDay(addDays({ year: startTime.year, month: startTime.month, day: startTime.day }, daysBetween(s, e)), home)
      return start + (instant(e) - instant(s))
    }
    return startTime.isDate ? startOfDay(addDays({ year: startTime.year, month: startTime.month, day: startTime.day }, 1), home) : start
  }
  const ridOf = (t: Time) => (t.isDate ? t.toString() : t.convertToZone(utc).toString())
  const textOf = (item: Event, master: Event | undefined, name: "summary" | "location"): string => {
    const own = item.component.getFirstPropertyValue(name)
    const v = typeof own === "string" ? own : master !== undefined ? master.component.getFirstPropertyValue(name) : ""
    return typeof v === "string" ? v : ""
  }
  const statusOf = (c: Component) => String(c.getFirstPropertyValue("status") ?? "").toUpperCase()
  const transpOf = (c: Component) => String(c.getFirstPropertyValue("transp") ?? "").toUpperCase()

  const out: Array<Occ> = []
  let rows = 0

  /** One occurrence into the result when it overlaps the window. */
  const emit = (uid: string, rid: string, item: Event, master: Event | undefined, start: number, end: number, allDay: boolean, into: Array<Occ>) => {
    if (end < start) throw new Unreadable()
    const overlaps = end > start ? end > input.from && start < input.to : start >= input.from && start < input.to
    if (!overlaps) return
    const title = cleanLine(textOf(item, master, "summary"), limits.titleChars)
    const location = cleanLine(textOf(item, master, "location"), limits.placeChars)
    // The days of the window it covers (an event ending at midnight does not cover the day that midnight starts).
    const first = dateOf(Math.max(start, input.from), home)
    const last = dateOf(Math.min(end > start ? end - 1 : start, input.to - 1), home)
    into.push({
      key: createHash("sha256").update(`${uid}\u0000${rid}`).digest("hex").slice(0, 24),
      start,
      end,
      allDay,
      first: dayNumber(first),
      last: dayNumber(last),
      beyond: end > input.to,
      title,
      ...(location !== "" ? { location } : {}),
      busy: !allDay && transpOf(item.component) !== "TRANSPARENT"
    })
  }

  for (const [uid, g] of groups) {
    const mine: Array<Occ> = []
    try {
      if (g.master === undefined) {
        // Exceptions whose series is not in the file are events of their own.
        for (const c of g.exceptions) {
          if (statusOf(c) === "CANCELLED") continue
          const e = new ICAL.Event(c)
          const start = instant(e.startDate)
          emit(uid, ridOf(e.recurrenceId), e, undefined, start, endOf(e, e.startDate, start, true), e.startDate.isDate, mine)
        }
      } else if (statusOf(g.master) !== "CANCELLED") {
        expandSeries(uid, g.master, g.exceptions, g.implicit, mine)
      }
    } catch (e) {
      if (e instanceof TooMany) return { ok: false, reason: "too-many" }
      unreadable++
      continue
    }
    for (const o of mine) {
      rows += daysBetween(dateOfNumber(o.first), dateOfNumber(o.last)) + 1
      out.push(o)
    }
    if (out.length > limits.occurrences || rows > limits.rows) return { ok: false, reason: "too-many" }
  }

  function expandSeries(uid: string, masterC: Component, exceptionCs: ReadonlyArray<Component>, implicit: Ready["implicit"], into: Array<Occ>) {
    // Period RDATEs: the library's iterator gets their starts; their own ends are kept by start.
    const periodEnds = new Map<number, number>()
    for (const prop of masterC.getAllProperties("rdate")) {
      const values = prop.getValues() as ReadonlyArray<unknown>
      if (!values.some((v) => v instanceof ICAL.Period)) continue
      const starts: Array<Time> = []
      for (const v of values) {
        if (v instanceof ICAL.Period) {
          const s = v.start!
          const e = v.duration !== null && v.duration !== undefined ? plus(s, v.duration) : instant(v.end!)
          periodEnds.set(instant(s), e)
          starts.push(s)
        } else starts.push(v as Time)
      }
      prop.resetType("date-time")
      prop.setValues(starts)
    }
    // A series of RDATEs only: the library does not count its DTSTART as the first instance (RFC 5545 §3.8.5.2 does).
    if (masterC.getFirstProperty("rrule") === null && masterC.getFirstProperty("rdate") !== null) {
      const first = new ICAL.Property("rdate", masterC)
      const dtstart = masterC.getFirstPropertyValue("dtstart") as Time
      first.resetType(dtstart.isDate ? "date" : "date-time")
      first.setValue(dtstart.clone())
      masterC.addProperty(first)
    }
    // Cancelled instances are kept out of the library (it reads every exception's end, and a cancellation may have
    // no start): an instance is taken out by its recurrence id, and a cancelled range takes out every later one too.
    const cancelled = new Set<string>()
    let cancelledFrom = Number.POSITIVE_INFINITY
    const related: Array<Component> = []
    for (const c of exceptionCs) {
      if (statusOf(c) !== "CANCELLED") {
        related.push(c)
        continue
      }
      const rid = c.getFirstPropertyValue("recurrence-id") as Time
      const prop = c.getFirstProperty("recurrence-id")
      if (String(prop?.getParameter("range") ?? "").toUpperCase() === "THISANDFUTURE") cancelledFrom = Math.min(cancelledFrom, instant(rid))
      else cancelled.add(ridOf(rid))
    }
    const event = new ICAL.Event(masterC, { exceptions: related })
    // Recurrence ids by their instant too: a RECURRENCE-ID in UTC (or another zone) for a zoned series.
    const exceptions = Object.values(event.exceptions) as Array<Event>
    const byId = event.exceptions as unknown as Record<string, Event>
    for (const x of exceptions) byId[ridOf(x.recurrenceId)] = x
    const visited = new Set<Event>()
    let horizon = input.to
    for (const x of exceptions) {
      const rid = instant(x.recurrenceId)
      if (x.modifiesFuture()) {
        // A range change may move later instances earlier: follow the series further by as much.
        if (x.component.getFirstProperty("dtstart") !== null) horizon = Math.max(horizon, input.to + Math.max(0, rid - instant(x.startDate)))
      } else horizon = Math.max(horizon, rid + 1)
    }
    // The instances that do not come from the rule (DTSTART, RDATEs) are not checked against its implicit day.
    const fromDates = new Set<number>([instant(event.startDate)])
    for (const prop of masterC.getAllProperties("rdate")) for (const v of prop.getValues() as ReadonlyArray<Time>) fromDates.add(instant(v))
    const iterator = event.iterator()
    let count = 0
    for (let steps = 0; ; steps++) {
      if (steps >= limits.seriesSteps) throw new Unreadable()
      const t = iterator.next()
      if (t === undefined || t === null) break
      const nominal = instant(t)
      if (nominal >= horizon) break
      // Every instance of a rule whose day was implicit falls on that day: one the library moved is not guessed at.
      if (implicit !== undefined && !fromDates.has(nominal) && (t.day !== implicit.day || (implicit.month !== undefined && t.month !== implicit.month))) throw new Unreadable()
      if (nominal >= cancelledFrom || cancelled.has(ridOf(t))) continue
      const d = event.getOccurrenceDetails(t)
      const item = d.item as Event
      visited.add(item)
      if (statusOf(item.component) === "CANCELLED") continue
      if (d.startDate === null || d.startDate === undefined) throw new Unreadable()
      const startTime = d.startDate as Time
      const start = instant(startTime)
      const own = item !== event && startTime === item.startDate
      const period = item === event ? periodEnds.get(nominal) : undefined
      const end = period ?? endOf(item, startTime, start, own)
      const before = into.length
      emit(uid, ridOf(t), item, event, start, end, startTime.isDate, into)
      if (into.length > before && ++count > limits.occurrences) throw new TooMany()
    }
    // A moved instance of an instance the series does not have is not guessed at.
    for (const x of exceptions) {
      if (visited.has(x) || x.modifiesFuture() || statusOf(x.component) === "CANCELLED" || x.component.getFirstProperty("dtstart") === null) continue
      const s = instant(x.startDate)
      const e = endOf(x, x.startDate, s, true)
      if (e > input.from && s < input.to) unreadable++
    }
  }

  out.sort((a, b) => a.start - b.start || a.end - b.end || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { ok: true, occurrences: out, unreadable }
}

const dateOfNumber = (n: number): LocalDate => ({ year: Math.floor(n / 10_000), month: Math.floor(n / 100) % 100, day: n % 100 })
