import ICAL from "ical.js"
import type { ClockTime, Language, LocalDate, LocalDateTime } from "./Result.ts"
import { speakNumber, speakTime } from "./Speak.ts"
import { monthNames, numberToWords, ordinalToWords, weekdayNames } from "./Words.ts"
import { isoWeekday, isValidLocal, localParts, normalizeTimeZone, pad, zonedToInstant } from "./Zoned.ts"

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
export type Freq = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
export const weekdayCodes: ReadonlyArray<Weekday> = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

export interface RuleDay {
  readonly weekday: Weekday
  /** 1–5 or -1…-5 in a month ("the second Tuesday", "the last Friday"); 1–53 or -1…-53 in a year. Only for monthly and yearly rules. */
  readonly nth?: number
}

/** The part of RFC 5545 `RRULE` this package reads, writes and expands. */
export interface RecurrenceRule {
  readonly freq: Freq
  readonly interval: number
  readonly byDay: ReadonlyArray<RuleDay>
  /** 1–31 or -1…-31 (from the end of the month). */
  readonly byMonthDay: ReadonlyArray<number>
  /** 1–12. */
  readonly byMonth: ReadonlyArray<number>
  /** 0–23. */
  readonly byHour?: ReadonlyArray<number>
  /** 0–59. */
  readonly byMinute?: ReadonlyArray<number>
  /** 1–366 or -1…-366; only with MONTHLY or WEEKLY (or YEARLY with one BYMONTH), and with another BY part. */
  readonly bySetPos?: ReadonlyArray<number>
  /** The first day of the week; matters only to WEEKLY rules with an INTERVAL above 1. Absent means MO. */
  readonly wkst?: Weekday
  readonly count?: number
  /** As written in the rule: "20271231", "20271231T230000" or "20271231T230000Z". */
  readonly until?: string
}

const freqs: ReadonlySet<string> = new Set(["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
const weekdaySet: ReadonlySet<string> = new Set(weekdayCodes)
/** The most days a month can have (February counted with 29). */
const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const intList = (value: string, min: number, max: number, zero = false): Array<number> | undefined => {
  const out: Array<number> = []
  for (const d of value.split(",")) {
    if (!/^[+-]?\d{1,3}$/.test(d)) return undefined
    const n = Number(d)
    if (n < min || n > max || (!zero && n === 0)) return undefined
    if (out.includes(n)) return undefined
    out.push(n)
  }
  return out
}

const validUntil = (value: string): boolean => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value)
  if (m === null) return false
  return isValidLocal({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), ...(m[4] !== undefined ? { hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) } : {}) })
}

/**
 * Read an `RRULE` value ("FREQ=WEEKLY;BYDAY=MO,WE") or line ("RRULE:FREQ=…"), strictly by RFC 5545 §3.3.10: every part once,
 * digits only for numbers, ordinals in range and only where the frequency allows them (`BYDAY=2TU` is not a weekly rule, `0MO` is
 * nothing), not `COUNT` and `UNTIL` together, no `BYMONTHDAY` in a weekly rule, `BYSETPOS` only with another BY part.
 * `undefined` for anything else, and for parts this package does not expand: SECONDLY, BYSECOND, BYWEEKNO, BYYEARDAY, X- parts,
 * BYSETPOS other than in a MONTHLY or WEEKLY rule (or a YEARLY one with a single BYMONTH), a year-relative ordinal weekday
 * (`FREQ=YEARLY;BYDAY=20MO`) together with BYMONTHDAY, BYHOUR, BYMINUTE or BYSETPOS, and a weekday together with both a month and
 * a day of the month (`BYMONTH=10;BYMONTHDAY=13;BYDAY=FR`) in a monthly or yearly rule. A rule that can never occur
 * (`BYMONTH=2;BYMONTHDAY=30`, `FREQ=MONTHLY;BYDAY=6MO`) is `undefined` too. Review round 1, findings 18 and 19.
 */
export const parseRRule = (text: string): RecurrenceRule | undefined => {
  if (typeof text !== "string") return undefined
  const body = text.trim().replace(/^RRULE:/i, "")
  if (body === "") return undefined
  const seen = new Set<string>()
  let freq: Freq | undefined
  let interval = 1
  let byDay: Array<RuleDay> = []
  let byMonthDay: Array<number> = []
  let byMonth: Array<number> = []
  let byHour: Array<number> | undefined
  let byMinute: Array<number> | undefined
  let bySetPos: Array<number> | undefined
  let wkst: Weekday | undefined
  let count: number | undefined
  let until: string | undefined
  for (const part of body.split(";")) {
    const eq = part.indexOf("=")
    if (eq <= 0) return undefined
    const key = part.slice(0, eq).toUpperCase()
    const value = part.slice(eq + 1).toUpperCase()
    if (value === "" || seen.has(key)) return undefined
    seen.add(key)
    switch (key) {
      case "FREQ": if (!freqs.has(value)) return undefined; freq = value as Freq; break
      case "INTERVAL": if (!/^\d{1,4}$/.test(value) || Number(value) < 1) return undefined; interval = Number(value); break
      case "COUNT": if (!/^\d{1,7}$/.test(value) || Number(value) < 1 || Number(value) > 1_000_000) return undefined; count = Number(value); break
      case "UNTIL": if (!validUntil(value)) return undefined; until = value; break
      case "BYDAY":
        for (const d of value.split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d)
          if (m === null) return undefined
          const nth = m[1] === undefined ? undefined : Number(m[1])
          if (nth !== undefined && (nth === 0 || Math.abs(nth) > 53)) return undefined
          if (byDay.some((x) => x.weekday === m[2] && x.nth === nth)) return undefined
          byDay.push({ weekday: m[2] as Weekday, ...(nth !== undefined ? { nth } : {}) })
        }
        break
      case "BYMONTHDAY": { const l = intList(value, -31, 31); if (l === undefined) return undefined; byMonthDay = l; break }
      case "BYMONTH": { const l = intList(value, 1, 12); if (l === undefined) return undefined; byMonth = l; break }
      case "BYHOUR": { const l = intList(value, 0, 23, true); if (l === undefined || value.includes("-") || value.includes("+")) return undefined; byHour = l; break }
      case "BYMINUTE": { const l = intList(value, 0, 59, true); if (l === undefined || value.includes("-") || value.includes("+")) return undefined; byMinute = l; break }
      case "BYSETPOS": { const l = intList(value, -366, 366); if (l === undefined) return undefined; bySetPos = l; break }
      case "WKST": if (!weekdaySet.has(value)) return undefined; wkst = value as Weekday; break
      default: return undefined
    }
  }
  if (freq === undefined) return undefined
  if (count !== undefined && until !== undefined) return undefined
  const ordinals = byDay.filter((d) => d.nth !== undefined)
  // Ordinal weekdays only in monthly and yearly rules; a month has at most five of each weekday.
  if (ordinals.length > 0 && freq !== "MONTHLY" && freq !== "YEARLY") return undefined
  if (ordinals.some((d) => Math.abs(d.nth!) > 5) && (freq === "MONTHLY" || byMonth.length > 0)) return undefined
  if (freq === "WEEKLY" && byMonthDay.length > 0) return undefined
  if (bySetPos !== undefined) {
    const others = byDay.length + byMonthDay.length + byMonth.length + (byHour?.length ?? 0) + (byMinute?.length ?? 0)
    if (others === 0) return undefined
    if (!(freq === "MONTHLY" || freq === "WEEKLY" || (freq === "YEARLY" && byMonth.length === 1))) return undefined
  }
  if (freq === "YEARLY" && byMonth.length === 0 && ordinals.length > 0 && (byMonthDay.length > 0 || byHour !== undefined || byMinute !== undefined || bySetPos !== undefined)) return undefined
  if ((freq === "MONTHLY" || freq === "YEARLY") && byDay.length > 0 && byMonthDay.length > 0 && (byMonth.length > 0 || ordinals.length > 0)) return undefined
  // A month and a day of the month that never meet.
  if (byMonth.length > 0 && byMonthDay.length > 0 && !byMonth.some((m) => byMonthDay.some((d) => Math.abs(d) <= maxDays[m - 1]!))) return undefined
  return {
    freq, interval, byDay, byMonthDay, byMonth,
    ...(byHour !== undefined ? { byHour } : {}), ...(byMinute !== undefined ? { byMinute } : {}), ...(bySetPos !== undefined ? { bySetPos } : {}),
    ...(wkst !== undefined ? { wkst } : {}), ...(count !== undefined ? { count } : {}), ...(until !== undefined ? { until } : {})
  }
}

/** The `RRULE` value: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU". */
export const formatRRule = (rule: RecurrenceRule): string => {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(",")}`)
  if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`)
  if (rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.map((d) => (d.nth !== undefined ? d.nth : "") + d.weekday).join(",")}`)
  if (rule.byHour !== undefined && rule.byHour.length > 0) parts.push(`BYHOUR=${rule.byHour.join(",")}`)
  if (rule.byMinute !== undefined && rule.byMinute.length > 0) parts.push(`BYMINUTE=${rule.byMinute.join(",")}`)
  if (rule.bySetPos !== undefined && rule.bySetPos.length > 0) parts.push(`BYSETPOS=${rule.bySetPos.join(",")}`)
  if (rule.wkst !== undefined && rule.wkst !== "MO") parts.push(`WKST=${rule.wkst}`)
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
  if (rule.until !== undefined) parts.push(`UNTIL=${rule.until}`)
  return parts.join(";")
}

/** "DTSTART;TZID=Europe/Amsterdam:20261120T090000" (seconds kept). */
export const formatDtstart = (start: LocalDateTime, timeZone: string): string =>
  `DTSTART;TZID=${timeZone}:${pad(start.year, 4)}${pad(start.month)}${pad(start.day)}T${pad(start.hour)}${pad(start.minute)}${pad(start.second ?? 0)}`

export interface Dtstart {
  /** The wall-clock reading as written (seconds kept). For a UTC DTSTART it is the UTC reading. */
  readonly start: LocalDateTime
  /** The TZID of the line, as written. */
  readonly timeZone?: string
  /** The value ended in "Z": the series runs in UTC. */
  readonly utc?: true
  /** `VALUE=DATE` or a bare date: the series is of days (each at 00:00). */
  readonly dateOnly?: true
}

/**
 * Read a DTSTART line or a bare value: "DTSTART;TZID=Europe/Amsterdam:20261120T090030", "DTSTART:20261120T080000Z" (UTC),
 * "DTSTART;VALUE=DATE:20261120", "20261120T090000", "2026-11-20T09:00", "2026-11-20T09:00:30Z". Seconds are kept; a date or time that
 * does not exist ("2026-02-30T09:00") is `undefined`, never moved to another day; a TZID together with "Z" is `undefined`.
 */
export const parseDtstart = (text: string): Dtstart | undefined => {
  if (typeof text !== "string") return undefined
  const line = /^DTSTART((?:;[A-Z-]+=[^:;]+)*):(.+)$/i.exec(text.trim())
  let value = line === null ? text.trim() : line[2]!.trim()
  let timeZone: string | undefined
  let valueType: "DATE" | "DATE-TIME" | undefined
  if (line !== null) {
    const seen = new Set<string>()
    for (const p of line[1]!.split(";").filter((x) => x !== "")) {
      const [k, v] = [p.slice(0, p.indexOf("=")).toUpperCase(), p.slice(p.indexOf("=") + 1)]
      if (seen.has(k)) return undefined
      seen.add(k)
      if (k === "TZID") timeZone = v
      else if (k === "VALUE" && (v.toUpperCase() === "DATE" || v.toUpperCase() === "DATE-TIME")) valueType = v.toUpperCase() as "DATE" | "DATE-TIME"
      else return undefined
    }
  }
  const utc = /Z$/i.test(value)
  if (utc) value = value.slice(0, -1)
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value) ?? /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/.exec(value)
  if (m === null) return undefined
  const dateOnly = m[4] === undefined
  if ((valueType === "DATE" && !dateOnly) || (valueType === "DATE-TIME" && dateOnly)) return undefined
  if ((utc && (timeZone !== undefined || dateOnly)) || (dateOnly && timeZone !== undefined)) return undefined
  const start = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0) }
  if (!isValidLocal(start)) return undefined
  return { start, ...(timeZone !== undefined ? { timeZone } : {}), ...(utc ? { utc: true as const } : {}), ...(dateOnly ? { dateOnly: true as const } : {}) }
}

/**
 * A stored recurrence: the `RRULE` value, its first occurrence, and the zone. `dtstart` is a DTSTART line or a bare value (see
 * `parseDtstart`); a floating one is in `timeZone`, a TZID must name the same zone as `timeZone` (else there is no occurrence: the
 * two disagree), and a UTC one runs in UTC.
 */
export interface RecurrenceSpec {
  readonly rrule: string
  readonly dtstart: string
  readonly timeZone: string
}

const weekdayIndex = (d: Weekday): number => weekdayCodes.indexOf(d) + 1

/** A wall-clock date-time in floating (zone-less) arithmetic. */
interface Wall {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}
const wallKey = (w: Wall): number => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
const wallOf = (ms: number): Wall => {
  const d = new Date(ms)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }
}
const icalTime = (w: Wall) => ICAL.Time.fromDateTimeString(`${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`)

/** The candidates of a rule, in order, as wall-clock readings; DTSTART first (RFC 5545 §3.8.5.3: it is always the first instance). */
type Candidates = Generator<Wall, void, undefined>

/** Expand with ical.js, on floating wall-clock times, optionally keeping only every `yearEvery`-th year from DTSTART's. */
function* viaIcal(rule: string, start: Wall, yearEvery = 1): Candidates {
  const iterator = ICAL.Recur.fromString(rule).iterator(icalTime(start))
  for (let t = iterator.next(); t; t = iterator.next()) {
    if (yearEvery > 1 && (t.year - start.year) % yearEvery !== 0) continue
    yield { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }
  }
}

/** The nth (from the end when negative) weekday `wd` of a year, as a date, or undefined when the year has no such day. */
const nthWeekdayOfYear = (year: number, wd: number, nth: number): LocalDate | undefined => {
  const days = Date.UTC(year + 1, 0, 1) / 86_400_000 - Date.UTC(year, 0, 1) / 86_400_000
  const jan1 = isoWeekday({ year, month: 1, day: 1 })
  const first = (wd - jan1 + 7) % 7 // day index (0 = 1 January) of the first such weekday
  const count = Math.floor((days - 1 - first) / 7) + 1
  const index = nth > 0 ? nth - 1 : count + nth
  if (index < 0 || index >= count) return undefined
  const d = new Date(Date.UTC(year, 0, 1 + first + 7 * index))
  return { year, month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/**
 * YEARLY with year-relative ordinal weekdays ("BYDAY=20MO", "BYDAY=1MO,-1FR"): ical.js 2.2.1 reads `20MO` as every Monday, so
 * this case is expanded here (review round 1, finding 15).
 */
function* yearlyOrdinals(rule: RecurrenceRule, start: Wall): Candidates {
  yield start
  const startKey = wallKey(start)
  for (let year = start.year; year <= 9999; year += rule.interval) {
    const dates: Array<LocalDate> = []
    for (const d of rule.byDay) {
      const wd = weekdayIndex(d.weekday)
      if (d.nth !== undefined) {
        const x = nthWeekdayOfYear(year, wd, d.nth)
        if (x !== undefined) dates.push(x)
      } else {
        for (let k = 1; ; k++) {
          const x = nthWeekdayOfYear(year, wd, k)
          if (x === undefined) break
          dates.push(x)
        }
      }
    }
    const keys = [...new Set(dates.map((d) => Date.UTC(d.year, d.month - 1, d.day, start.hour, start.minute, start.second)))].sort((a, b) => a - b)
    for (const k of keys) if (k > startKey) yield wallOf(k)
  }
}

/** HOURLY and MINUTELY without BY parts run in elapsed time: DTSTART plus whole steps, counted as they come. */
function* steps(stepMs: number, startInstant: number, fromStep: number): Generator<number, void, undefined> {
  for (let k = fromStep; ; k++) yield startInstant + k * stepMs
}

/** A safety bound on candidates looked at per call, for a rule too sparse to expand quickly; ordinary rules stay far below it. */
const candidateBound = 3_000_000

const unitMs = { MINUTELY: 60_000, HOURLY: 3_600_000 } as const

/**
 * The occurrences of a stored recurrence after an instant (strictly), up to `limit` (default 1). Expansion is ical.js on wall-clock
 * times in the zone, then each time is turned into an instant (`zonedToInstant`): 09:00 stays 09:00 across daylight-saving changes.
 * A time the clocks skip is read with the offset before the gap, so a daily 02:30 in Europe/Amsterdam rings at 03:30 on the day the
 * clocks go forward (RFC 5545 §3.3.10: such an instance "is interpreted in the same manner as an explicit DATE-TIME value", and
 * §3.3.5 reads a nonexistent local time with the UTC offset before the gap); a time that happens twice is the first one, and two
 * candidates that land on the same instant are one occurrence. HOURLY and MINUTELY rules without BY parts run in elapsed time (every
 * two hours is two real hours across a jump); with BY parts they follow the wall clock. DTSTART is always the first occurrence
 * (RFC 5545 §3.8.5.3). `[]` when the rule or the start is unreadable, the zone is unknown, a TZID disagrees with `timeZone`, or there
 * is no further occurrence. Long-running series are cheap: an unbounded HOURLY or MINUTELY rule starts its expansion just before `after`.
 */
export const occurrencesAfter = (spec: RecurrenceSpec, after: number, limit = 1): Array<number> => {
  const rule = parseRRule(spec.rrule)
  const dt = parseDtstart(spec.dtstart)
  if (rule === undefined || dt === undefined || !Number.isFinite(after) || !(limit >= 1)) return []
  const want = Math.min(Math.floor(limit), 10_000)
  let zone: string
  if (dt.utc === true) zone = "UTC"
  else {
    const z = normalizeTimeZone(spec.timeZone)
    if (z === undefined) return []
    if (dt.timeZone !== undefined && normalizeTimeZone(dt.timeZone) !== z) return []
    zone = z
  }
  const start: Wall = { year: dt.start.year, month: dt.start.month, day: dt.start.day, hour: dt.start.hour, minute: dt.start.minute, second: dt.start.second ?? 0 }
  const startInstant = zonedToInstant(start, zone)
  const until = rule.until === undefined ? Infinity : untilInstant(rule.until, zone)
  const out: Array<number> = []
  let produced = 0
  let last = Number.NaN
  /** "stop" ends the series (COUNT reached, past UNTIL, or enough found). */
  const take = (instant: number): "stop" | "go" => {
    produced++
    if (rule.count !== undefined && produced > rule.count) return "stop"
    if (instant > until) return "stop"
    if (instant === last) return "go"
    last = instant
    if (instant > after) out.push(instant)
    return out.length >= want ? "stop" : "go"
  }

  const plain = rule.byDay.length + rule.byMonthDay.length + rule.byMonth.length === 0 && rule.byHour === undefined && rule.byMinute === undefined && rule.bySetPos === undefined
  if ((rule.freq === "HOURLY" || rule.freq === "MINUTELY") && plain) {
    // Elapsed time: the k-th occurrence is DTSTART + k steps, so the expansion can start right before `after`, COUNT included.
    const step = unitMs[rule.freq] * rule.interval
    const from = Math.max(0, Math.floor((after - startInstant) / step))
    produced = from
    for (const instant of steps(step, startInstant, from)) if (take(instant) === "stop") break
    return out
  }

  const candidates = plan(rule, start, after, zone)
  if (candidates === undefined) return []
  let looked = 0
  for (const wall of candidates.walls) {
    if (++looked > candidateBound) break
    if (candidates.skipFirst && looked === 1) { produced++; continue }
    if (take(zonedToInstant(wall, zone)) === "stop") break
  }
  return out
}

const untilInstant = (until: string, zone: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until)!
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (m[4] === undefined) return zonedToInstant({ year: y, month: mo, day: d, hour: 23, minute: 59, second: 59 }, zone)
  if (m[7] === "Z") return Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6]))
  return zonedToInstant({ year: y, month: mo, day: d, hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) }, zone)
}

/**
 * How a rule is expanded. Most rules go to ical.js as they are. YEARLY rules are rewritten first, because ical.js 2.2.1 expands
 * several of them wrongly (checked against RFC 5545): `FREQ=YEARLY;BYMONTHDAY=1` only in DTSTART's month, `BYDAY=20MO` as every
 * Monday, a plain YEARLY rule from 29 February on 1 March, and `BYMONTH=2;BYMONTHDAY=30` on 2 March. The rewrites are exact:
 *   YEARLY with BYMONTH                → MONTHLY with the same BY parts, every `INTERVAL`-th year kept;
 *   YEARLY, no BY part                 → MONTHLY;BYMONTH=<DTSTART's month>;BYMONTHDAY=<DTSTART's day>, likewise;
 *   YEARLY with BYMONTHDAY (no BYMONTH) → MONTHLY with the same BY parts, likewise;
 *   YEARLY with plain weekdays only    → WEEKLY with them, likewise;
 *   YEARLY with year-relative ordinals → `yearlyOrdinals` above.
 * An unbounded wall-clock HOURLY or MINUTELY rule starts at DTSTART moved forward by whole intervals to just before `after`; ical.js
 * yields that start first whether it matches or not, so it is dropped (`skipFirst`), and nothing before `after` is returned anyway.
 */
const plan = (rule: RecurrenceRule, start: Wall, after: number, zone: string): { walls: Candidates; skipFirst: boolean } | undefined => {
  const { count: _count, until: _until, ...unbounded } = rule
  const rest = formatRRule({ ...unbounded, interval: 1 }).replace(/^FREQ=[A-Z]+;?/, "")
  const withFreq = (freq: Freq, interval: number, extra = rest) => `FREQ=${freq}${interval > 1 ? `;INTERVAL=${interval}` : ""}${extra === "" ? "" : `;${extra}`}`
  if (rule.freq !== "YEARLY") {
    // A monthly rule that takes its day from DTSTART and has no such day in any of its months never occurs.
    if (rule.freq === "MONTHLY" && rule.byDay.length === 0 && rule.byMonthDay.length === 0 && rule.byMonth.length > 0 && !rule.byMonth.some((m) => start.day <= maxDays[m - 1]!)) return undefined
    if ((rule.freq === "HOURLY" || rule.freq === "MINUTELY") && rule.count === undefined) {
      const stepMin = (rule.freq === "HOURLY" ? 60 : 1) * rule.interval
      const afterWall = localParts(after, zone)
      const gap = (wallKey({ ...afterWall, second: afterWall.second }) - wallKey(start)) / 60_000
      const k = Math.floor(gap / stepMin) - 2
      if (k > 0) {
        const moved = wallOf(wallKey(start) + k * stepMin * 60_000)
        return { walls: viaIcal(withFreq(rule.freq, rule.interval), moved), skipFirst: true }
      }
    }
    return { walls: viaIcal(withFreq(rule.freq, rule.interval), start), skipFirst: false }
  }
  const ordinals = rule.byDay.some((d) => d.nth !== undefined)
  if (rule.byMonth.length > 0) {
    if (rule.byDay.length === 0 && rule.byMonthDay.length === 0 && !rule.byMonth.some((m) => start.day <= maxDays[m - 1]!)) return undefined
    return { walls: viaIcal(withFreq("MONTHLY", 1), start, rule.interval), skipFirst: false }
  }
  if (ordinals) return { walls: yearlyOrdinals(rule, start), skipFirst: false }
  if (rule.byMonthDay.length > 0) return { walls: viaIcal(withFreq("MONTHLY", 1), start, rule.interval), skipFirst: false }
  if (rule.byDay.length > 0) return { walls: viaIcal(withFreq("WEEKLY", 1), start, rule.interval), skipFirst: false }
  const own = `BYMONTH=${start.month};BYMONTHDAY=${start.day}${rest === "" ? "" : `;${rest}`}`
  return { walls: viaIcal(withFreq("MONTHLY", 1, own), start, rule.interval), skipFirst: false }
}

/** The next occurrence strictly after `after` (epoch milliseconds), or `undefined`. See `occurrencesAfter`. */
export const nextOccurrence = (spec: RecurrenceSpec, after: number | Date): number | undefined =>
  occurrencesAfter(spec, typeof after === "number" ? after : after instanceof Date ? after.getTime() : Number.NaN, 1)[0]

// ---- in words ---------------------------------------------------------------------------------------------------------------------

const smallNumber = (n: number, language: Language): string => (n <= 10 ? numberToWords(n, language) : speakNumber(n, language))

const dayList = (days: ReadonlyArray<number>, language: Language): string => {
  const names = days.map((d) => weekdayNames[language][d - 1]!)
  const and = language === "en" ? "and" : "en"
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`
}
const ordList = (days: ReadonlyArray<number>, language: Language): string => {
  const the = language === "en" ? "the " : "de "
  const and = language === "en" ? "and" : "en"
  const words = days.map((d) => (d === -1 ? (language === "en" ? "last day" : "laatste dag") : ordinalToWords(d, language)))
  return words.length === 1 ? `${the}${words[0]}` : `${the}${words.slice(0, -1).join(", ")} ${and} ${the}${words[words.length - 1]}`
}

export interface DescribeOptions {
  /** The time of day, said after the rule ("at half past nine in the morning"). */
  readonly time?: ClockTime
  /** The first occurrence; fills in what the rule leaves to it ("every month" on the 16th). */
  readonly start?: LocalDate
}

/**
 * An `RRULE` in words, in the same words `parseRecurrence` reads: "every day", "every weekday", "every Monday and Wednesday",
 * "every second Tuesday", "on the first of every month", "the last Friday of every month", "every year on the third of March";
 * Dutch "elke dag", "elke werkdag", "elke tweede dinsdag", "op de eerste van elke maand". Every constraint of the rule is in the
 * words, or the answer is `undefined`: a rule with a part this cannot say (BYHOUR, BYMINUTE, BYSETPOS, a month restriction on a daily
 * or weekly rule, plain weekdays in a monthly rule with an interval, several months or days in a yearly rule, an UNTIL with a time)
 * is not described with that part left out (review round 1, finding 20).
 */
export const describeRRule = (rrule: string | RecurrenceRule, language: Language, options: DescribeOptions = {}): string | undefined => {
  const rule = typeof rrule === "string" ? parseRRule(rrule) : parseRRule(formatRRule(rrule))
  if (rule === undefined) return undefined
  if (rule.byHour !== undefined || rule.byMinute !== undefined || rule.bySetPos !== undefined) return undefined
  const en = language === "en"
  const every = en ? "every" : "elke"
  const n = rule.interval
  const days = [...new Set(rule.byDay.map((d) => weekdayIndex(d.weekday)))].sort((a, b) => a - b)
  const plain = rule.byDay.every((d) => d.nth === undefined)
  const ordinal = rule.byDay.every((d) => d.nth !== undefined)
  // The week start changes a rule only when it is weekly, every few weeks, on more than one day.
  if (rule.wkst !== undefined && rule.wkst !== "MO" && rule.freq === "WEEKLY" && n > 1 && days.length > 1) return undefined
  let text: string
  switch (rule.freq) {
    case "MINUTELY":
    case "HOURLY":
      if (rule.byDay.length + rule.byMonthDay.length + rule.byMonth.length > 0) return undefined
      text = rule.freq === "MINUTELY"
        ? n === 1 ? (en ? "every minute" : "elke minuut") : `${every} ${smallNumber(n, language)} ${en ? "minutes" : "minuten"}`
        : n === 1 ? (en ? "every hour" : "elk uur") : `${every} ${smallNumber(n, language)} ${en ? "hours" : "uur"}`
      break
    case "DAILY":
      if (rule.byMonth.length > 0 || rule.byMonthDay.length > 0 || (days.length > 0 && n > 1)) return undefined
      if (days.join() === "1,2,3,4,5") text = en ? "every weekday" : "elke werkdag"
      else if (days.join() === "6,7") text = en ? "every weekend" : "elk weekend"
      else if (days.length > 0) text = `${every} ${dayList(days, language)}`
      else if (n === 1) text = en ? "every day" : "elke dag"
      else if (n === 2) text = en ? "every other day" : "om de dag"
      else text = `${every} ${smallNumber(n, language)} ${en ? "days" : "dagen"}`
      break
    case "WEEKLY":
      if (rule.byMonth.length > 0) return undefined
      if (days.length === 0) text = n === 1 ? `${every} week` : n === 2 ? (en ? "every other week" : "om de week") : `${every} ${smallNumber(n, language)} ${en ? "weeks" : "weken"}`
      else if (n === 1 && days.join() === "1,2,3,4,5") text = en ? "every weekday" : "elke werkdag"
      else if (n === 1 && days.join() === "6,7") text = en ? "every weekend" : "elk weekend"
      else if (n === 1) text = `${every} ${dayList(days, language)}`
      else if (n === 2 && days.length === 1) text = `${every} ${ordinalToWords(2, language)} ${weekdayNames[language][days[0]! - 1]}`
      else text = `${n === 2 ? (en ? "every other week" : "om de week") : `${every} ${smallNumber(n, language)} ${en ? "weeks" : "weken"}`} ${en ? "on" : "op"} ${dayList(days, language)}`
      break
    case "MONTHLY": {
      if (rule.byMonth.length > 0) return undefined
      if (rule.byDay.length > 0 && rule.byMonthDay.length > 0) return undefined
      const monthly = n === 1 ? (en ? "every month" : "elke maand") : `${every} ${smallNumber(n, language)} ${en ? "months" : "maanden"}`
      const ofMonth = n === 1 ? (en ? "of every month" : "van elke maand") : `${en ? "of" : "van"} ${monthly}`
      if (rule.byDay.length > 0 && ordinal) {
        // "the last Friday" is said; "the second to last Friday" is not.
        if (rule.byDay.some((d) => d.nth! < -1)) return undefined
        const parts = rule.byDay.map((d) => `${d.nth === -1 ? (en ? "last" : "laatste") : ordinalToWords(d.nth!, language)} ${weekdayNames[language][weekdayIndex(d.weekday) - 1]}`)
        const and = en ? "and" : "en"
        const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} ${and} ${parts[parts.length - 1]}`
        text = en ? `the ${joined} ${ofMonth}` : `${every} ${joined} ${ofMonth}`
      } else if (rule.byDay.length > 0) {
        // Every Monday of every month is every Monday; of every other month it is not.
        if (!plain || n !== 1) return undefined
        text = `${every} ${dayList(days, language)}`
      } else if (rule.byMonthDay.length > 0) {
        if (rule.byMonthDay.some((d) => d < -1)) return undefined
        text = `${en ? "on" : "op"} ${ordList(rule.byMonthDay, language)} ${ofMonth}`
      } else text = options.start !== undefined ? `${en ? "on" : "op"} ${ordList([options.start.day], language)} ${ofMonth}` : monthly
      break
    }
    case "YEARLY": {
      const yearly = n === 1 ? (en ? "every year" : "elk jaar") : `${every} ${smallNumber(n, language)} ${en ? "years" : "jaar"}`
      if (rule.byMonth.length > 1 || rule.byMonthDay.length > 1 || rule.byDay.length > 1) return undefined
      const monthName = (m: number) => monthNames[language][m - 1]!
      const onDate = (m: number, d: number) => (en ? `${yearly} on the ${ordinalToWords(d, "en")} of ${monthName(m)}` : `${yearly} op ${d} ${monthName(m)}`)
      if (rule.byDay.length === 1) {
        // "every year on the second Sunday of May": an ordinal weekday of one month.
        const d = rule.byDay[0]!
        if (rule.byMonth.length !== 1 || rule.byMonthDay.length > 0 || d.nth === undefined || d.nth < -1) return undefined
        const nth = d.nth === -1 ? (en ? "last" : "laatste") : ordinalToWords(d.nth, language)
        const wd = weekdayNames[language][weekdayIndex(d.weekday) - 1]
        text = en ? `${yearly} on the ${nth} ${wd} of ${monthName(rule.byMonth[0]!)}` : `${yearly} op de ${nth} ${wd} van ${monthName(rule.byMonth[0]!)}`
      } else if (rule.byMonth.length === 1 && rule.byMonthDay.length === 1) {
        if (rule.byMonthDay[0]! < 1) return undefined
        text = onDate(rule.byMonth[0]!, rule.byMonthDay[0]!)
      } else if (rule.byMonth.length === 1) {
        // The day comes from the start.
        if (options.start === undefined) return undefined
        text = onDate(rule.byMonth[0]!, options.start.day)
      } else if (rule.byMonthDay.length === 1) return undefined // that day of every month: not a yearly sentence
      else text = options.start !== undefined ? onDate(options.start.month, options.start.day) : yearly
      break
    }
  }
  if (rule.count !== undefined) text += en ? `, ${rule.count} times` : `, ${rule.count} keer`
  if (rule.until !== undefined) {
    if (rule.until.length !== 8) return undefined // an end with a time of day is not said
    const u = /^(\d{4})(\d{2})(\d{2})$/.exec(rule.until)!
    const [y, m, d] = [Number(u[1]), Number(u[2]), Number(u[3])]
    text += en ? `, until the ${ordinalToWords(d, "en")} of ${monthNames.en[m - 1]} ${y}` : `, tot ${d} ${monthNames.nl[m - 1]} ${y}`
  }
  if (options.time !== undefined) text += ` ${en ? "at" : "om"} ${speakTime(options.time, language, { period: true })}`
  return text
}
