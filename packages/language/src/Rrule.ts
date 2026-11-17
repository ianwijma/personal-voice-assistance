import { guarded, isLanguage, isOptions, maxYear, minYear } from "./Domain.ts"
import type { ClockTime, Language, LocalDate, LocalDateTime } from "./Result.ts"
import { speakTime } from "./Speak.ts"
import { monthNames, numberToWords, ordinalToWords, weekdayNames } from "./Words.ts"
import {
  dateOfDay, dayNumber, daysInMonth, isValidLocal, lastDay, localParts, normalizeTimeZone, pad, weekdayOfDay, zonedToInstant
} from "./Zoned.ts"

/** The longest RRULE or DTSTART text read. */
const maxRuleText = 500

/**
 * Recurrence rules as a person says them, and their next occurrences. This is a small, closed part of RFC 5545 (§3.3.10 RRULE,
 * §3.8.5.3 DTSTART), not a general iCalendar engine: calendar events from elsewhere are the calendar module's, with its own library.
 * The supported shapes (README, "Recurrence"):
 *   FREQ=DAILY
 *   FREQ=WEEKLY  [BYDAY=<plain weekdays>]                       default: DTSTART's weekday
 *   FREQ=MONTHLY [BYMONTHDAY=<1–31 or -1, one or more> | BYDAY=<one ordinal weekday: 1–5 or -1, e.g. 2TU, -1FR>]   default: DTSTART's day
 *   FREQ=YEARLY  [BYMONTH=<one month> [BYMONTHDAY=<one day 1–31>]]                                               default: DTSTART's
 * each with INTERVAL (1–999), optionally COUNT (1–1000) or UNTIL (a UTC date-time, as RFC 5545 requires with a zoned DTSTART), and
 * WKST only as MO. DTSTART is `DTSTART;TZID=<the series' zone>:YYYYMMDDTHHMMSS` and must itself be an instance. Anything else is
 * `unsupported` (valid RFC 5545 this package does not expand: HOURLY, BYSETPOS, BYHOUR, several BYMONTHs, a date-only or UTC
 * DTSTART, …) or `invalid` (not RFC 5545). Expansion is our own date arithmetic over local calendar days, then one conversion to an
 * instant per instance; it jumps straight to the period of `after`, so it costs the same however far `after` is from DTSTART.
 */
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
export const weekdayCodes: ReadonlyArray<Weekday> = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

export interface RuleDay {
  readonly weekday: Weekday
  /** Only in a MONTHLY rule, and then always: 1–5 or -1 ("the second Tuesday", "the last Friday"). */
  readonly nth?: number
}

/** A rule of the supported set. Lists are kept sorted (weekdays Monday first; days of the month ascending, -1 last). */
export interface RecurrenceRule {
  readonly freq: Freq
  /** 1–999. */
  readonly interval: number
  readonly byDay: ReadonlyArray<RuleDay>
  /** MONTHLY: 1–31 or -1 (the last day). YEARLY: at most one, 1–31, and only with `byMonth`. */
  readonly byMonthDay: ReadonlyArray<number>
  /** YEARLY only: at most one, 1–12. */
  readonly byMonth: ReadonlyArray<number>
  /** 1–1000. Not with `until`. */
  readonly count?: number
  /** A UTC date-time as written in the rule: "20271231T230000Z". Not with `count`. */
  readonly until?: string
}

export const maxInterval = 999
export const maxCount = 1000

/** What `parseRRule` and `readSeries` say. `unsupported`: valid RFC 5545 outside the set above. `invalid`: not RFC 5545. */
export type RRuleRead =
  | { readonly kind: "ok"; readonly rule: RecurrenceRule }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }

const weekdayIndex = (d: Weekday): number => weekdayCodes.indexOf(d) + 1
const unsupported = (reason: string) => ({ kind: "unsupported", reason }) as const
const invalidRule = (reason: string) => ({ kind: "invalid", reason }) as const

/** The most days a month can have (February counted with 29). */
const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const rfcParts: ReadonlySet<string> = new Set(["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST"])
const notExpanded: ReadonlySet<string> = new Set(["BYSECOND", "BYMINUTE", "BYHOUR", "BYYEARDAY", "BYWEEKNO", "BYSETPOS"])

const intList = (value: string, min: number, max: number): Array<number> | undefined => {
  const out: Array<number> = []
  for (const d of value.split(",")) {
    if (!/^[+-]?\d{1,3}$/.test(d)) return undefined
    const n = Number(d)
    if (n < min || n > max || n === 0 || out.includes(n)) return undefined
    out.push(n)
  }
  return out
}

const untilPattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
const untilParts = (value: string): LocalDateTime | undefined => {
  const m = untilPattern.exec(value)
  if (m === null) return undefined
  const t = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) }
  return isValidLocal(t) ? t : undefined
}
/** The UTC instant of an UNTIL value of the supported form. */
const untilInstant = (value: string): number => {
  const u = untilParts(value)!
  return Date.UTC(u.year, u.month - 1, u.day, u.hour, u.minute, u.second)
}
/** A real date-time, whatever its year: told apart from one outside the supported years. */
const realDateTime = (value: string): boolean => {
  const m = untilPattern.exec(value)
  if (m === null) return false
  const year = Number(m[1])
  const t = { year: 2000 + (((year % 400) + 400) % 400), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) }
  return isValidLocal(t)
}

const sortDays = (days: ReadonlyArray<RuleDay>): Array<RuleDay> => [...days].sort((a, b) => weekdayIndex(a.weekday) - weekdayIndex(b.weekday))
const sortMonthDays = (days: ReadonlyArray<number>): Array<number> => [...days].sort((a, b) => (a < 0 ? 100 : a) - (b < 0 ? 100 : b))

/** Why a rule object is outside the supported set, or `undefined` when it is inside. */
const shapeProblem = (rule: RecurrenceRule): RRuleRead | undefined => {
  const { freq, interval, byDay, byMonthDay, byMonth, count, until } = rule
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return unsupported(`FREQ=${String(freq)} is not supported`)
  if (!Number.isInteger(interval) || interval < 1) return invalidRule("INTERVAL must be a whole number from 1")
  if (interval > maxInterval) return unsupported(`INTERVAL above ${maxInterval} is not supported`)
  if (count !== undefined && until !== undefined) return invalidRule("COUNT and UNTIL together")
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) return invalidRule("COUNT must be a whole number from 1")
  if (count !== undefined && count > maxCount) return unsupported(`COUNT above ${maxCount} is not supported`)
  if (until !== undefined && (typeof until !== "string" || untilParts(until) === undefined)) return unsupported(`UNTIL must be a UTC date-time, YYYYMMDDTHHMMSSZ, in ${minYear}–${maxYear}`)
  if (!Array.isArray(byDay) || !Array.isArray(byMonthDay) || !Array.isArray(byMonth)) return invalidRule("BY parts must be lists")
  const days = new Set<string>()
  for (const d of byDay) {
    if (!weekdayCodes.includes(d.weekday)) return invalidRule(`"${String(d.weekday)}" is not a weekday`)
    if (d.nth !== undefined && (!Number.isInteger(d.nth) || d.nth === 0 || Math.abs(d.nth) > 53)) return invalidRule("A BYDAY ordinal must be 1–53 or -1…-53")
    const key = `${d.nth ?? ""}${d.weekday}`
    if (days.has(key)) return invalidRule("A BYDAY entry is given twice")
    days.add(key)
  }
  for (const d of byMonthDay) if (!Number.isInteger(d) || d === 0 || Math.abs(d) > 31) return invalidRule("BYMONTHDAY must be 1–31 or -1…-31")
  if (new Set(byMonthDay).size !== byMonthDay.length) return invalidRule("A BYMONTHDAY value is given twice")
  for (const m of byMonth) if (!Number.isInteger(m) || m < 1 || m > 12) return invalidRule("BYMONTH must be 1–12")
  if (new Set(byMonth).size !== byMonth.length) return invalidRule("A BYMONTH value is given twice")
  const ordinal = byDay.some((d) => d.nth !== undefined)
  if (ordinal && freq !== "MONTHLY" && freq !== "YEARLY") return invalidRule("A BYDAY ordinal is only allowed in MONTHLY and YEARLY rules")
  if (freq === "WEEKLY" && byMonthDay.length > 0) return invalidRule("BYMONTHDAY is not allowed in a WEEKLY rule")
  switch (freq) {
    case "DAILY":
      if (byDay.length + byMonthDay.length + byMonth.length > 0) return unsupported("A DAILY rule takes no BY parts here")
      break
    case "WEEKLY":
      if (byMonth.length > 0) return unsupported("BYMONTH in a WEEKLY rule is not supported")
      break
    case "MONTHLY":
      if (byMonth.length > 0) return unsupported("BYMONTH in a MONTHLY rule is not supported")
      if (byDay.length > 0 && byMonthDay.length > 0) return unsupported("BYDAY with BYMONTHDAY is not supported")
      if (byDay.length > 1) return unsupported("Only one BYDAY entry in a MONTHLY rule is supported")
      if (byDay.length === 1) {
        const nth = byDay[0]!.nth
        if (nth === undefined) return unsupported("A plain weekday in a MONTHLY rule is not supported")
        if (Math.abs(nth) > 5) return invalidRule("A month has at most five of a weekday")
        if (nth < -1) return unsupported("Only -1 (the last) of the ordinals from the end is supported")
      }
      if (byMonthDay.some((d) => d < -1)) return unsupported("Only -1 of the days from the end of the month is supported")
      break
    case "YEARLY":
      if (byDay.length > 0) return unsupported("BYDAY in a YEARLY rule is not supported")
      if (byMonth.length > 1) return unsupported("Only one BYMONTH in a YEARLY rule is supported")
      if (byMonthDay.length > 1) return unsupported("Only one BYMONTHDAY in a YEARLY rule is supported")
      if (byMonthDay.some((d) => d < 0)) return unsupported("A day from the end of the month in a YEARLY rule is not supported")
      // RFC 5545 expands BYMONTHDAY without BYMONTH in a YEARLY rule to that day of every month: not a yearly date.
      if (byMonthDay.length === 1 && byMonth.length === 0) return unsupported("BYMONTHDAY in a YEARLY rule needs BYMONTH here")
      if (byMonth.length === 1 && byMonthDay.length === 1 && byMonthDay[0]! > maxDays[byMonth[0]! - 1]!) return invalidRule("That month never has that day")
      break
  }
  return undefined
}

/**
 * Read an `RRULE` value ("FREQ=WEEKLY;BYDAY=MO,WE") or line ("RRULE:FREQ=…") by RFC 5545 §3.3.10: every part once, digits only for
 * numbers, ordinals in range and only where the frequency allows them. `ok` with the rule (lists sorted), `unsupported` with the
 * reason for valid rules outside the supported set (see the top of this file), `invalid` for anything that is not an RRULE.
 */
export const parseRRule: (text: string) => RRuleRead = guarded((text: string): RRuleRead => {
  if (typeof text !== "string") return invalidRule("Not text")
  if (text.length > maxRuleText) return unsupported(`An RRULE longer than ${maxRuleText} characters is not read`)
  const body = text.trim().replace(/^RRULE:/i, "")
  if (body === "") return invalidRule("Empty")
  const seen = new Set<string>()
  let freq: string | undefined
  let interval = 1
  const byDay: Array<RuleDay> = []
  let byMonthDay: Array<number> = []
  let byMonth: Array<number> = []
  let count: number | undefined
  let until: string | undefined
  let unsupportedPart: string | undefined
  for (const part of body.split(";")) {
    const eq = part.indexOf("=")
    if (eq <= 0) return invalidRule(`"${part}" is not NAME=VALUE`)
    const key = part.slice(0, eq).toUpperCase()
    const value = part.slice(eq + 1).toUpperCase()
    if (value === "") return invalidRule(`${key} has no value`)
    if (seen.has(key)) return invalidRule(`${key} is given twice`)
    seen.add(key)
    if (key.startsWith("X-")) { unsupportedPart ??= `${key} is not supported`; continue }
    if (!rfcParts.has(key)) return invalidRule(`${key} is not an RRULE part`)
    if (notExpanded.has(key)) { unsupportedPart ??= `${key} is not supported`; continue }
    switch (key) {
      case "FREQ":
        if (!["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(value)) return invalidRule(`FREQ=${value} is not a frequency`)
        freq = value
        break
      case "INTERVAL":
        if (!/^\d{1,9}$/.test(value) || Number(value) < 1) return invalidRule("INTERVAL must be a whole number from 1")
        interval = Number(value)
        break
      case "COUNT":
        if (!/^\d{1,9}$/.test(value) || Number(value) < 1) return invalidRule("COUNT must be a whole number from 1")
        count = Number(value)
        break
      case "UNTIL":
        if (untilPattern.test(value)) {
          if (!realDateTime(value)) return invalidRule("UNTIL is not a real date-time")
          if (untilParts(value) === undefined) unsupportedPart ??= `UNTIL outside ${minYear}–${maxYear} is not supported`
          until = value
        }
        else if (/^\d{8}(T\d{6})?$/.test(value)) { unsupportedPart ??= "UNTIL must be a UTC date-time (YYYYMMDDTHHMMSSZ) with a zoned DTSTART"; until = value }
        else return invalidRule("UNTIL is not a date or date-time")
        break
      case "WKST":
        if (!weekdayCodes.includes(value as Weekday)) return invalidRule(`WKST=${value} is not a weekday`)
        if (value !== "MO") unsupportedPart ??= "Only WKST=MO is supported"
        break
      case "BYDAY":
        for (const d of value.split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d)
          if (m === null) return invalidRule(`"${d}" is not a BYDAY entry`)
          const nth = m[1] === undefined ? undefined : Number(m[1])
          byDay.push({ weekday: m[2] as Weekday, ...(nth !== undefined ? { nth } : {}) })
        }
        break
      case "BYMONTHDAY": { const l = intList(value, -31, 31); if (l === undefined) return invalidRule("BYMONTHDAY must be 1–31 or -1…-31, each once"); byMonthDay = l; break }
      case "BYMONTH": { const l = intList(value, 1, 12); if (l === undefined || value.includes("-") || value.includes("+")) return invalidRule("BYMONTH must be 1–12, each once"); byMonth = l; break }
    }
  }
  if (freq === undefined) return invalidRule("No FREQ")
  if (count !== undefined && until !== undefined) return invalidRule("COUNT and UNTIL together")
  if (freq === "SECONDLY" || freq === "MINUTELY" || freq === "HOURLY") return unsupported(`FREQ=${freq} is not supported (use a scheduler job)`)
  const rule: RecurrenceRule = {
    freq: freq as Freq, interval, byDay: sortDays(byDay), byMonthDay: sortMonthDays(byMonthDay), byMonth: [...byMonth].sort((a, b) => a - b),
    ...(count !== undefined ? { count } : {}), ...(until !== undefined ? { until } : {})
  }
  if (unsupportedPart !== undefined) {
    const problem = shapeProblem({ ...rule, ...(until !== undefined && untilParts(until) === undefined ? { until: undefined } : {}) } as RecurrenceRule)
    return problem?.kind === "invalid" ? problem : unsupported(unsupportedPart)
  }
  return shapeProblem(rule) ?? { kind: "ok", rule }
}, invalidRule("Not an RRULE"))

/** The `RRULE` value of a rule of the supported set ("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU"); `undefined` for any other rule. */
export const formatRRule: (rule: RecurrenceRule) => string | undefined = guarded((rule: RecurrenceRule): string | undefined => {
  if (typeof rule !== "object" || rule === null || shapeProblem(rule) !== undefined) return undefined
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byMonth.length > 0) parts.push(`BYMONTH=${[...rule.byMonth].sort((a, b) => a - b).join(",")}`)
  if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${sortMonthDays(rule.byMonthDay).join(",")}`)
  if (rule.byDay.length > 0) parts.push(`BYDAY=${sortDays(rule.byDay).map((d) => (d.nth !== undefined ? d.nth : "") + d.weekday).join(",")}`)
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
  if (rule.until !== undefined) parts.push(`UNTIL=${rule.until}`)
  return parts.join(";")
}, undefined)

export interface Dtstart {
  /** The wall-clock reading as written, seconds kept. */
  readonly start: LocalDateTime & { readonly second: number }
  /** The TZID, canonical ("Europe/Amsterdam"). */
  readonly timeZone: string
}

const dtstartPattern = /^DTSTART;TZID=([^:;"]+):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/i

/**
 * Read a DTSTART line of the supported form, `DTSTART;TZID=Europe/Amsterdam:20261120T090000`: a local date-time with an IANA zone.
 * `undefined` for anything else (a UTC, floating or date-only DTSTART, other parameters, a date or time that does not exist, a zone
 * this machine does not know).
 */
export const parseDtstart: (text: string) => Dtstart | undefined = guarded((text: string): Dtstart | undefined => {
  if (typeof text !== "string" || text.length > maxRuleText) return undefined
  const m = dtstartPattern.exec(text.trim())
  if (m === null) return undefined
  const timeZone = normalizeTimeZone(m[1]!)
  const start = { year: Number(m[2]), month: Number(m[3]), day: Number(m[4]), hour: Number(m[5]), minute: Number(m[6]), second: Number(m[7]) }
  if (timeZone === undefined || !isValidLocal(start)) return undefined
  return { start, timeZone }
}, undefined)

/** "DTSTART;TZID=Europe/Amsterdam:20261120T090000" (seconds kept); `undefined` for a zone that is not an IANA name this machine knows, or a date that does not exist. */
export const formatDtstart: (start: LocalDateTime, timeZone: string) => string | undefined = guarded((start: LocalDateTime, timeZone: string): string | undefined => {
  const zone = normalizeTimeZone(timeZone)
  if (zone === undefined || typeof start !== "object" || start === null) return undefined
  const t = { year: start.year, month: start.month, day: start.day, hour: start.hour, minute: start.minute, second: start.second ?? 0 }
  if (!isValidLocal(t) || t.hour === undefined || t.minute === undefined) return undefined
  return `DTSTART;TZID=${zone}:${pad(t.year, 4)}${pad(t.month)}${pad(t.day)}T${pad(t.hour)}${pad(t.minute)}${pad(t.second)}`
}, undefined)

/** A stored recurrence: the `RRULE` value, the DTSTART line, and the zone the series is in (the Home time zone). */
export interface RecurrenceSpec {
  readonly rrule: string
  readonly dtstart: string
  readonly timeZone: string
}

/** A series ready to expand. */
export interface Series {
  readonly rule: RecurrenceRule
  readonly start: LocalDateTime & { readonly second: number }
  readonly timeZone: string
}
export type SeriesRead = { readonly kind: "ok"; readonly series: Series } | { readonly kind: "unsupported" | "invalid"; readonly reason: string }

// ---- the calendar of a series ------------------------------------------------------------------------------------------------------

/** Monday-to-Sunday weeks, numbered from the week of 1970-01-01. */
const weekOf = (n: number): number => Math.floor((n + 3) / 7)
const mondayOfWeek = (w: number): number => w * 7 - 3
const monthIndexOf = (d: LocalDate): number => d.year * 12 + d.month - 1

/** The day number of the nth (from the end when -1) weekday `wd` of a month, or undefined when there is none. */
const nthWeekday = (year: number, month: number, wd: number, nth: number): number | undefined => {
  const first = dayNumber(year, month, 1)
  const dim = daysInMonth(year, month)
  if (nth > 0) {
    const offset = (wd - weekdayOfDay(first) + 7) % 7 + 7 * (nth - 1)
    return offset < dim ? first + offset : undefined
  }
  const last = first + dim - 1
  return last - ((weekdayOfDay(last) - wd + 7) % 7) - 7 * (-nth - 1)
}

const periodOf = (rule: RecurrenceRule, n: number): number => {
  switch (rule.freq) {
    case "DAILY": return n
    case "WEEKLY": return weekOf(n)
    case "MONTHLY": return monthIndexOf(dateOfDay(n))
    case "YEARLY": return dateOfDay(n).year
  }
}

/** The days of period `p` (a day, a week, a month or a year, by FREQ) that the rule selects, ascending, before DTSTART's bound. */
const daysOfPeriod = (s: Series, p: number): Array<number> => {
  const { rule, start } = s
  switch (rule.freq) {
    case "DAILY": return [p]
    case "WEEKLY": {
      const wds = rule.byDay.length > 0 ? rule.byDay.map((d) => weekdayIndex(d.weekday)) : [weekdayOfDay(dayNumber(start.year, start.month, start.day))]
      return wds.map((wd) => mondayOfWeek(p) + wd - 1).sort((a, b) => a - b)
    }
    case "MONTHLY": {
      const year = Math.floor(p / 12)
      const month = p - year * 12 + 1
      const dim = daysInMonth(year, month)
      if (rule.byDay.length === 1) {
        const d = nthWeekday(year, month, weekdayIndex(rule.byDay[0]!.weekday), rule.byDay[0]!.nth!)
        return d === undefined ? [] : [d]
      }
      const wanted = rule.byMonthDay.length > 0 ? rule.byMonthDay : [start.day]
      const days = [...new Set(wanted.map((v) => (v === -1 ? dim : v)).filter((v) => v <= dim))].sort((a, b) => a - b)
      return days.map((d) => dayNumber(year, month, d))
    }
    case "YEARLY": {
      const month = rule.byMonth[0] ?? start.month
      const day = rule.byMonthDay[0] ?? start.day
      return day <= daysInMonth(p, month) ? [dayNumber(p, month, day)] : []
    }
  }
}

/** After this many in-phase periods without an instance there is none any more: the Gregorian calendar repeats every 400 years. */
const emptyBound = (freq: Freq): number => (freq === "MONTHLY" ? 4800 : freq === "YEARLY" ? 400 : 2)
const lastPeriod = (freq: Freq): number => (freq === "DAILY" ? lastDay : freq === "WEEKLY" ? weekOf(lastDay) : freq === "MONTHLY" ? maxYear * 12 + 11 : maxYear)

/**
 * Visit the instance days of a series from day `fromDay` on, ascending, up to the last supported day; `visit` returns false to stop.
 * Starts at the first in-phase period at or after `fromDay`'s (arithmetic, not a walk from DTSTART), so the cost does not grow with
 * the distance to DTSTART. Says whether it stopped because the supported years end (decision 2) rather than because the series has no
 * more days or `visit` stopped it.
 */
const eachDay = (s: Series, fromDay: number, visit: (day: number) => boolean): "visit" | "series" | "range" => {
  const { rule } = s
  const startDay = dayNumber(s.start.year, s.start.month, s.start.day)
  const from = Math.max(fromDay, startDay)
  const p0 = periodOf(rule, startDay)
  const steps = Math.ceil((periodOf(rule, from) - p0) / rule.interval)
  const end = lastPeriod(rule.freq)
  let empty = 0
  for (let p = p0 + Math.max(0, steps) * rule.interval; p <= end; p += rule.interval) {
    const days = daysOfPeriod(s, p).filter((d) => d >= from)
    // A Monday-to-Sunday week can run past 31 December of the last year: its later days are outside the supported years (finding 15).
    if (days.some((d) => d > lastDay)) {
      for (const d of days) if (d <= lastDay && !visit(d)) return "visit"
      return "range"
    }
    if (days.length === 0) {
      if (++empty > emptyBound(rule.freq)) return "series"
      continue
    }
    empty = 0
    for (const d of days) if (!visit(d)) return "visit"
  }
  return "range"
}

const instantOf = (s: Series, day: number): number => zonedToInstant({ ...dateOfDay(day), hour: s.start.hour, minute: s.start.minute, second: s.start.second }, s.timeZone)

/**
 * Read and check a stored recurrence: the rule (`parseRRule`), the DTSTART (`parseDtstart`), its TZID equal to `timeZone`, DTSTART an
 * instance of the rule, and an UNTIL not before DTSTART (DTSTART is the first instance, so an UNTIL before it leaves none: `invalid`;
 * an UNTIL at DTSTART is that one instance; review round 3, finding 16).
 */
export const readSeries: (spec: RecurrenceSpec) => SeriesRead = guarded((spec: RecurrenceSpec): SeriesRead => {
  if (typeof spec !== "object" || spec === null) return { kind: "invalid", reason: "No spec" }
  const rule = parseRRule(spec.rrule)
  if (rule.kind !== "ok") return rule
  const dt = parseDtstart(spec.dtstart)
  if (dt === undefined) {
    const line = typeof spec.dtstart === "string" ? spec.dtstart.trim() : ""
    return /^DTSTART[;:]/i.test(line) || /^\d{4}-?\d{2}-?\d{2}/.test(line)
      ? { kind: "unsupported", reason: `DTSTART must be DTSTART;TZID=<IANA zone>:YYYYMMDDTHHMMSS in ${minYear}–${maxYear} (no UTC, floating or date-only start)` }
      : { kind: "invalid", reason: "Not a DTSTART" }
  }
  const zone = normalizeTimeZone(spec.timeZone)
  if (zone === undefined) return { kind: "invalid", reason: `Unknown time zone ${JSON.stringify(spec.timeZone)}` }
  if (dt.timeZone !== zone) return { kind: "invalid", reason: `DTSTART is in ${dt.timeZone}, the series in ${zone}` }
  const series: Series = { rule: rule.rule, start: dt.start, timeZone: zone }
  const startDay = dayNumber(dt.start.year, dt.start.month, dt.start.day)
  if (!daysOfPeriod(series, periodOf(series.rule, startDay)).includes(startDay)) return { kind: "invalid", reason: "DTSTART is not an instance of the rule" }
  if (rule.rule.until !== undefined && untilInstant(rule.rule.until) < instantOf(series, startDay)) return { kind: "invalid", reason: "UNTIL is before DTSTART, the first instance" }
  return { kind: "ok", series }
}, { kind: "invalid", reason: "Not a series" })

/** What an expansion found, and why it found no more. */
export interface Occurrences {
  /** Strictly after `after`, increasing, no instant twice. */
  readonly instants: ReadonlyArray<number>
  /**
   * Why there are no more: `limit` (as many as were asked for), `series` (COUNT or UNTIL reached, or the rule has no further day), or
   * `range` (the supported years end on 31 December ${maxYear}; the series itself may go on).
   */
  readonly stop: "limit" | "series" | "range"
}

/** The instances of a series strictly after `after`, at most `limit` (a whole number 1–10 000; default 1), in increasing order, no instant twice. */
export const seriesAfter: (s: Series, after: number, limit?: number) => Occurrences = guarded((s: Series, after: number, limit = 1): Occurrences => {
  if (typeof after !== "number" || Number.isNaN(after) || !Number.isInteger(limit) || limit < 1 || limit > 10_000) return { instants: [], stop: "limit" }
  if (typeof s !== "object" || s === null || formatRRule(s.rule) === undefined || typeof s.timeZone !== "string" || normalizeTimeZone(s.timeZone) !== s.timeZone ||
    typeof s.start !== "object" || s.start === null || !isValidLocal(s.start) || !Number.isInteger(s.start.second)) return { instants: [], stop: "series" }
  const until = s.rule.until === undefined ? Infinity : untilInstant(s.rule.until)
  const startDay = dayNumber(s.start.year, s.start.month, s.start.day)
  // Instances strictly after `after` lie on its local day or later, less two days for any offset change around it.
  const lowest = instantOf(s, startDay)
  const afterDay = after < lowest ? startDay : after > 8.64e15 ? lastDay + 1 : (() => { const p = localParts(after, s.timeZone); return dayNumber(p.year, p.month, p.day) - 2 })()
  const out: Array<number> = []
  let last = -Infinity
  let counted = 0
  let ended = false
  // COUNT counts instances, not days: a day a zone skips altogether (Pacific/Apia, 30 December 2011) lands on the next day's instant,
  // and that instant is one instance, counted once (finding 6). So with COUNT every instance from DTSTART is converted and counted.
  const take = (day: number): boolean => {
    if (s.rule.count === undefined && day < afterDay) return true
    const instant = instantOf(s, day)
    if (instant > until) { ended = true; return false }
    if (instant <= last) return true
    last = instant
    counted++
    if (s.rule.count !== undefined && counted > s.rule.count) { ended = true; return false }
    if (instant > after) out.push(instant)
    return out.length < limit
  }
  const why = eachDay(s, s.rule.count === undefined ? afterDay : startDay, take)
  return { instants: out, stop: out.length >= limit ? "limit" : ended || why === "series" ? "series" : why === "range" ? "range" : "series" }
}, { instants: [], stop: "series" })

/**
 * The occurrences of a stored recurrence strictly after an instant, up to `limit` (default 1, a whole number to 10 000), in increasing
 * order with no instant twice, and why there are no more. Instances are local date-times in the series' zone (09:00 stays 09:00
 * across daylight saving); a time the clocks skip is taken at the UTC offset from before the gap, a time that happens twice is the
 * first (RFC 5545 §3.3.10 with §3.3.5). `undefined` when `readSeries` does not accept the spec.
 */
export const occurrencesAfter: (spec: RecurrenceSpec, after: number, limit?: number) => Occurrences | undefined = guarded((spec: RecurrenceSpec, after: number, limit = 1): Occurrences | undefined => {
  const read = readSeries(spec)
  return read.kind === "ok" ? seriesAfter(read.series, after, limit) : undefined
}, undefined)

/** The next occurrence strictly after `after` (epoch milliseconds or a Date), or `undefined`. See `occurrencesAfter`. */
export const nextOccurrence: (spec: RecurrenceSpec, after: number | Date) => number | undefined = guarded((spec: RecurrenceSpec, after: number | Date): number | undefined =>
  occurrencesAfter(spec, typeof after === "number" ? after : after instanceof Date ? after.getTime() : Number.NaN, 1)?.instants[0], undefined)

/** Whether `day` (a local date) is an instance day of a rule taken with interval 1, the given defaults standing in for DTSTART's. */
export const ruleSelects = (rule: RecurrenceRule, defaults: LocalDate, day: LocalDate): boolean => {
  const s: Series = { rule: { ...rule, interval: 1 }, start: { ...defaults, hour: 0, minute: 0, second: 0 }, timeZone: "UTC" }
  const n = dayNumber(day.year, day.month, day.day)
  return daysOfPeriod(s, periodOf(s.rule, n)).includes(n)
}

// ---- in words ---------------------------------------------------------------------------------------------------------------------

const smallNumber = (n: number, language: Language): string => (n <= 10 ? numberToWords(n, language)! : String(n))

const dayList = (days: ReadonlyArray<number>, language: Language): string => {
  const names = days.map((d) => weekdayNames[language][d - 1]!)
  const and = language === "en" ? "and" : "en"
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} ${and} ${names[names.length - 1]}`
}
const ordList = (days: ReadonlyArray<number>, language: Language): string => {
  const the = language === "en" ? "the " : "de "
  const and = language === "en" ? "and" : "en"
  const words = days.map((d) => (d === -1 ? (language === "en" ? "last day" : "laatste dag") : ordinalToWords(d, language)!))
  return words.length === 1 ? `${the}${words[0]}` : `${the}${words.slice(0, -1).join(`, ${the}`)} ${and} ${the}${words[words.length - 1]}`
}

export interface DescribeOptions {
  /** The time of day, said after the rule ("at half past nine in the morning"). */
  readonly time?: ClockTime
  /**
   * DTSTART's date: says what the rule leaves to it — the weekday of a plain "every week", the day of a plain "every month", the date
   * of a plain "every year". Without it such a rule is not described (`undefined`): the words would leave that day to whoever reads
   * them (review round 3, findings 7 and 8).
   */
  readonly start?: LocalDate
  /** The series' zone: needed to say an UNTIL (a UTC moment) as a local date and time. */
  readonly timeZone?: string
}

/**
 * A rule of the supported set in words: "every day", "every weekday", "every Monday and Wednesday", "every second Tuesday", "every
 * three weeks on Monday", "on the first of every month", "the last Friday of every month", "every year on the third of March";
 * Dutch "elke dag", "elke werkdag", "elke tweede dinsdag", "op de eerste van elke maand". For a rule without COUNT and UNTIL the words
 * are in `parseRecurrence`'s grammar and read back (with `time`, and `now` before the first occurrence) to the same occurrences; a
 * COUNT is said after them (", 5 times" / ", 5 keer") and an UNTIL with `timeZone` (", until 31 December 2027 at 23:00" / ", tot 31
 * december 2027 om 23:00"): those two are not read back. `undefined` for a rule outside the supported set, a plain weekly, monthly or
 * yearly rule without `start`, a `start` the rule does not select, an UNTIL without `timeZone`, or a time that is not a clock time.
 */
export const describeRRule: (rrule: string | RecurrenceRule, language: Language, options?: DescribeOptions) => string | undefined = guarded((rrule: string | RecurrenceRule, language: Language, options: DescribeOptions = {}): string | undefined => {
  if (!isLanguage(language) || !isOptions(options)) return undefined
  const read = typeof rrule === "string" ? parseRRule(rrule) : (() => { const f = formatRRule(rrule); return f === undefined ? undefined : parseRRule(f) })()
  if (read === undefined || read.kind !== "ok") return undefined
  const rule = read.rule
  const start = options.start
  if (start !== undefined && (typeof start !== "object" || start === null || !isValidLocal(start))) return undefined
  const en = language === "en"
  const every = en ? "every" : "elke"
  const n = rule.interval
  const unitPhrase = (one: string, many: string, everyOther: string, oneNl = one) =>
    n === 1 ? `${en ? "every" : (oneNl === "jaar" ? "elk" : "elke")} ${en ? one : oneNl}` : n === 2 ? everyOther : `${every} ${smallNumber(n, language)} ${many}`
  // A plain rule takes its day from DTSTART: said from `start`, or not described.
  const startWd = start === undefined ? undefined : weekdayOfDay(dayNumber(start.year, start.month, start.day))
  const days = rule.byDay.length > 0 ? rule.byDay.map((d) => weekdayIndex(d.weekday)) : rule.freq === "WEEKLY" && startWd !== undefined ? [startWd] : []
  let text: string
  switch (rule.freq) {
    case "DAILY":
      text = unitPhrase("day", en ? "days" : "dagen", en ? "every other day" : "om de dag", "dag")
      break
    case "WEEKLY": {
      if (days.length === 0) return undefined
      const weeks = unitPhrase("week", en ? "weeks" : "weken", en ? "every other week" : "om de week", "week")
      if (n === 1 && days.join() === "1,2,3,4,5") text = en ? "every weekday" : "elke werkdag"
      else if (n === 1 && days.join() === "6,7") text = en ? "every weekend" : "elk weekend"
      else if (n === 1) text = `${every} ${dayList(days, language)}`
      else if (n <= 5 && days.length === 1) text = `${every} ${ordinalToWords(n, language)!} ${weekdayNames[language][days[0]! - 1]}`
      else text = `${weeks} ${en ? "on" : "op"} ${dayList(days, language)}`
      break
    }
    case "MONTHLY": {
      const months = unitPhrase("month", en ? "months" : "maanden", en ? "every other month" : "om de maand", "maand")
      const ofEvery = en ? "of every month" : "van elke maand"
      const monthDays = rule.byMonthDay.length > 0 ? rule.byMonthDay : rule.byDay.length === 0 && start !== undefined ? [start.day] : []
      if (rule.byDay.length === 1) {
        const d = rule.byDay[0]!
        const nth = `${d.nth === -1 ? (en ? "last" : "laatste") : ordinalToWords(d.nth!, language)!} ${weekdayNames[language][weekdayIndex(d.weekday) - 1]}`
        text = n === 1 ? (en ? `the ${nth} ${ofEvery}` : `de ${nth} ${ofEvery}`) : `${months} ${en ? "on the" : "op de"} ${nth}`
      } else if (monthDays.length > 0) {
        text = n === 1 ? `${en ? "on" : "op"} ${ordList(monthDays, language)} ${ofEvery}` : `${months} ${en ? "on" : "op"} ${ordList(monthDays, language)}`
      } else return undefined
      break
    }
    case "YEARLY": {
      const years = unitPhrase("year", en ? "years" : "jaar", en ? "every other year" : "elke twee jaar", "jaar")
      const month = rule.byMonth[0] ?? start?.month
      const day = rule.byMonthDay[0] ?? start?.day
      if (month === undefined || day === undefined) return undefined
      text = en ? `${years} on the ${ordinalToWords(day, "en")!} of ${monthNames.en[month - 1]}` : `${years} op ${day} ${monthNames.nl[month - 1]}`
      break
    }
  }
  // The start must be an instance of the rule as described (a plain rule's day comes from it).
  if (start !== undefined) {
    const s: Series = { rule, start: { ...start, hour: 0, minute: 0, second: 0 }, timeZone: "UTC" }
    const day = dayNumber(start.year, start.month, start.day)
    if (!daysOfPeriod(s, periodOf(rule, day)).includes(day)) return undefined
  }
  if (options.time !== undefined) {
    const t = options.time
    if (typeof t !== "object" || t === null || !Number.isInteger(t.hour) || !Number.isInteger(t.minute) || t.hour < 0 || t.hour > 23 || t.minute < 0 || t.minute > 59) return undefined
    // Midnight is said as "00:00": "every Friday at midnight" could be the start of Friday or its end.
    const said = t.hour === 0 && t.minute === 0 ? "00:00" : speakTime(t, language, { period: true })!
    text += ` ${en ? "at" : "om"} ${said}`
  }
  const tail = countAndUntil(rule, language, options.timeZone)
  return tail === undefined ? undefined : text + tail
}, undefined)

/** ", 5 times" / ", until 31 December 2027 at 23:00": what a description says after the rule; "" without COUNT and UNTIL; `undefined` for an UNTIL without a zone. */
const countAndUntil = (rule: RecurrenceRule, language: Language, timeZone: string | undefined): string | undefined => {
  const en = language === "en"
  if (rule.count !== undefined) return en ? `, ${rule.count} ${rule.count === 1 ? "time" : "times"}` : `, ${rule.count} keer`
  if (rule.until === undefined) return ""
  const zone = timeZone === undefined ? undefined : normalizeTimeZone(timeZone)
  if (zone === undefined) return undefined
  const p = localParts(untilInstant(rule.until), zone)
  const clock = `${pad(p.hour)}:${pad(p.minute)}${p.second === 0 ? "" : `:${pad(p.second)}`}`
  return en ? `, until ${p.day} ${monthNames.en[p.month - 1]} ${p.year} at ${clock}` : `, tot ${p.day} ${monthNames.nl[p.month - 1]} ${p.year} om ${clock}`
}
