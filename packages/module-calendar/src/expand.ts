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
          if (zone.length <= MAX_TIMEZONE_LINES && zones.size < MAX_TIMEZONES && !zones.has(id)) zones.set(id, zone.join("\r\n"))
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

  // ---- Each event's lines made ready for the library: zones resolved, floating times the household's.
  const ready: Array<{ readonly text: string; readonly zones: ReadonlyArray<string> }> = []
  for (const ev of blocks.events) {
    if (ev.bad) {
      unreadable++
      continue
    }
    const out: Array<string> = []
    const named = new Set<string>()
    let ok = true
    for (const l of ev.lines) {
      const p = splitLine(l)!
      if (p.name === "EXRULE") {
        ok = false
        break
      }
      if (!TIME_PROPS.has(p.name)) {
        out.push(l)
        continue
      }
      const tzid = paramOf(p.params, "TZID")
      const isDate = (paramOf(p.params, "VALUE") ?? "").toUpperCase() === "DATE" || /^\d{8}$/.test(p.value.trim())
      if (tzid !== undefined) {
        if (!zoneOf(tzid)) {
          ok = false
          break
        }
        if (blocks.zones.has(tzid)) named.add(tzid)
        out.push(l)
        continue
      }
      if (isDate) {
        out.push(l)
        continue
      }
      // A date-time without a TZID: UTC when every value ends in Z, floating (the household's) when none does.
      const values = p.value.split(",").flatMap((v) => v.split("/").slice(0, 1))
      const utc = values.filter((v) => /z$/i.test(v.trim())).length
      if (utc === values.length) out.push(l)
      else if (utc === 0) out.push(`${p.name};TZID=${HOME_TZID}${p.params}:${p.value}`)
      else {
        ok = false
        break
      }
    }
    if (!ok) {
      unreadable++
      continue
    }
    ready.push({ text: out.join("\r\n"), zones: [...named] })
  }

  // ---- Parsed one by one (one malformed event never fails the file), with the time zones it names.
  const parsed: Array<{ readonly c: Component; readonly i: number }> = []
  for (let i = 0; i < ready.length; i++) {
    const r = ready[i]!
    try {
      const root = new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", "VERSION:2.0", ...r.zones.map((z) => blocks.zones.get(z)!), r.text, "END:VCALENDAR"].join("\r\n")))
      const vevent = root.getFirstSubcomponent("vevent")
      if (vevent === null) {
        unreadable++
        continue
      }
      // A cancelled instance needs no start: its RECURRENCE-ID is enough to take it out (RFC 5546 tombstones).
      const tombstone = vevent.getFirstProperty("recurrence-id") !== null && String(vevent.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED"
      if (vevent.getFirstProperty("dtstart") === null && !tombstone) {
        unreadable++
        continue
      }
      parsed.push({ c: vevent, i })
    } catch {
      unreadable++
    }
  }

  // ---- Grouped by UID: the series (or single event) and its exceptions.
  const groups = new Map<string, { master?: Component; exceptions: Array<Component> }>()
  for (const { c, i } of parsed) {
    const uidValue = c.getFirstPropertyValue("uid")
    const uid = typeof uidValue === "string" && uidValue !== "" ? uidValue : `\u0000no-uid-${i}`
    const g = groups.get(uid) ?? { exceptions: [] }
    if (c.getFirstProperty("recurrence-id") !== null) g.exceptions.push(c)
    else if (g.master === undefined) g.master = c
    else unreadable++ // two events of one UID, neither an exception: which is meant is not known
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
        expandSeries(uid, g.master, g.exceptions, mine)
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

  function expandSeries(uid: string, masterC: Component, exceptionCs: ReadonlyArray<Component>, into: Array<Occ>) {
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
    const iterator = event.iterator()
    let count = 0
    for (let steps = 0; ; steps++) {
      if (steps >= limits.seriesSteps) throw new Unreadable()
      const t = iterator.next()
      if (t === undefined || t === null) break
      const nominal = instant(t)
      if (nominal >= horizon) break
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
