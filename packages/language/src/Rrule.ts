import type { ClockTime, Language, LocalDate, LocalDateTime } from "./Result.ts"
import { speakNumber, speakTime } from "./Speak.ts"
import { monthNames, numberToWords, ordinalToWords, weekdayNames } from "./Words.ts"
import { addDays, addMonths, daysInMonth, isoWeekday, localParts, pad, parseLocalIso, zonedToInstant } from "./Zoned.ts"

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
export type Freq = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
export const weekdayCodes: ReadonlyArray<Weekday> = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

export interface RuleDay {
  readonly weekday: Weekday
  /** 1–5 or -1 (the last): "the second Tuesday". Only for monthly and yearly rules. */
  readonly nth?: number
}

/** The part of RFC 5545 `RRULE` this package builds, reads and expands. */
export interface RecurrenceRule {
  readonly freq: Freq
  readonly interval: number
  readonly byDay: ReadonlyArray<RuleDay>
  /** 1–31 or -1 (the last day). */
  readonly byMonthDay: ReadonlyArray<number>
  /** 1–12. */
  readonly byMonth: ReadonlyArray<number>
  readonly count?: number
  /** As written in the rule: "20271231", "20271231T230000" or "20271231T230000Z". */
  readonly until?: string
}

const freqs: ReadonlySet<string> = new Set(["MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"])

/** Read an `RRULE` value ("FREQ=WEEKLY;BYDAY=MO,WE") or line ("RRULE:FREQ=…"). Parts this package does not expand (BYSETPOS, BYYEARDAY, …) make it `undefined`. */
export const parseRRule = (text: string): RecurrenceRule | undefined => {
  const body = text.trim().replace(/^RRULE:/i, "")
  if (body === "") return undefined
  let freq: Freq | undefined
  let interval = 1
  const byDay: Array<RuleDay> = []
  const byMonthDay: Array<number> = []
  const byMonth: Array<number> = []
  let count: number | undefined
  let until: string | undefined
  for (const part of body.split(";")) {
    const eq = part.indexOf("=")
    if (eq < 0) return undefined
    const key = part.slice(0, eq).toUpperCase()
    const value = part.slice(eq + 1)
    switch (key) {
      case "FREQ": if (!freqs.has(value.toUpperCase())) return undefined; freq = value.toUpperCase() as Freq; break
      case "INTERVAL": interval = Number(value); if (!Number.isInteger(interval) || interval < 1) return undefined; break
      case "COUNT": count = Number(value); if (!Number.isInteger(count) || count < 1) return undefined; break
      case "UNTIL": if (!/^\d{8}(T\d{6}Z?)?$/.test(value)) return undefined; until = value; break
      case "BYDAY":
        for (const d of value.split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(d)
          if (m === null) return undefined
          byDay.push({ weekday: m[2]!.toUpperCase() as Weekday, ...(m[1] !== undefined ? { nth: Number(m[1]) } : {}) })
        }
        break
      case "BYMONTHDAY":
        for (const d of value.split(",")) { const n = Number(d); if (!Number.isInteger(n) || n === 0 || n < -31 || n > 31) return undefined; byMonthDay.push(n) }
        break
      case "BYMONTH":
        for (const d of value.split(",")) { const n = Number(d); if (!Number.isInteger(n) || n < 1 || n > 12) return undefined; byMonth.push(n) }
        break
      case "WKST": if (value.toUpperCase() !== "MO") return undefined; break
      default: return undefined
    }
  }
  if (freq === undefined) return undefined
  return { freq, interval, byDay, byMonthDay, byMonth, ...(count !== undefined ? { count } : {}), ...(until !== undefined ? { until } : {}) }
}

/** The `RRULE` value: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU". */
export const formatRRule = (rule: RecurrenceRule): string => {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(",")}`)
  if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`)
  if (rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.map((d) => (d.nth !== undefined ? d.nth : "") + d.weekday).join(",")}`)
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
  if (rule.until !== undefined) parts.push(`UNTIL=${rule.until}`)
  return parts.join(";")
}

/** "DTSTART;TZID=Europe/Amsterdam:20261120T090000" */
export const formatDtstart = (start: LocalDateTime, timeZone: string): string =>
  `DTSTART;TZID=${timeZone}:${pad(start.year, 4)}${pad(start.month)}${pad(start.day)}T${pad(start.hour)}${pad(start.minute)}00`

/** Read a DTSTART line or a bare local date-time ("DTSTART;TZID=…:20261120T090000", "20261120T090000", "2026-11-20T09:00"). */
export const parseDtstart = (text: string): { readonly start: LocalDateTime; readonly timeZone?: string } | undefined => {
  const m = /^DTSTART(?:;TZID=([^:;]+))?:(.+)$/i.exec(text.trim())
  const start = parseLocalIso(m === null ? text : m[2]!)
  if (start === undefined) return undefined
  return { start, ...(m?.[1] !== undefined ? { timeZone: m[1] } : {}) }
}

/** A stored recurrence: the `RRULE` value, the first occurrence as a local date-time ("20261120T090000" or "2026-11-20T09:00"), and the zone. */
export interface RecurrenceSpec {
  readonly rrule: string
  readonly dtstart: string
  readonly timeZone: string
}

const weekdayIndex = (d: Weekday): number => weekdayCodes.indexOf(d) + 1

const lastWeekdayOf = (year: number, month: number, wd: number): number => {
  const last = daysInMonth(year, month)
  const diff = (isoWeekday({ year, month, day: last }) - wd + 7) % 7
  return last - diff
}
const nthWeekdayOf = (year: number, month: number, wd: number, nth: number): number | undefined => {
  if (nth < 0) {
    const d = lastWeekdayOf(year, month, wd) + 7 * (nth + 1)
    return d >= 1 ? d : undefined
  }
  const first = 1 + ((wd - isoWeekday({ year, month, day: 1 }) + 7) % 7)
  const d = first + 7 * (nth - 1)
  return d <= daysInMonth(year, month) ? d : undefined
}
const allWeekdaysOf = (year: number, month: number, wd: number): Array<number> => {
  const out: Array<number> = []
  for (let d = 1 + ((wd - isoWeekday({ year, month, day: 1 }) + 7) % 7); d <= daysInMonth(year, month); d += 7) out.push(d)
  return out
}

/** Days of one month matching the rule's BYMONTHDAY / BYDAY (default: `defaultDay`). */
const monthDays = (rule: RecurrenceRule, year: number, month: number, defaultDay: number | undefined): Array<number> => {
  const last = daysInMonth(year, month)
  const byDate = rule.byMonthDay.map((d) => (d < 0 ? last + d + 1 : d)).filter((d) => d >= 1 && d <= last)
  const byWeekday: Array<number> = []
  for (const d of rule.byDay) {
    const wd = weekdayIndex(d.weekday)
    if (d.nth !== undefined) {
      const x = nthWeekdayOf(year, month, wd, d.nth)
      if (x !== undefined) byWeekday.push(x)
    } else byWeekday.push(...allWeekdaysOf(year, month, wd))
  }
  let days: Array<number>
  if (rule.byMonthDay.length > 0 && rule.byDay.length > 0) days = byDate.filter((d) => byWeekday.includes(d))
  else if (rule.byMonthDay.length > 0) days = byDate
  else if (rule.byDay.length > 0) days = byWeekday
  else days = defaultDay !== undefined && defaultDay <= last ? [defaultDay] : []
  return [...new Set(days)].sort((x, y) => x - y)
}

const parseUntil = (until: string, timeZone: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until)!
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (m[4] === undefined) return zonedToInstant({ year: y, month: mo, day: d, hour: 23, minute: 59, second: 59 }, timeZone)
  if (m[7] === "Z") return Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6]))
  return zonedToInstant({ year: y, month: mo, day: d, hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]) }, timeZone)
}

const iterationLimit = 6000

/**
 * The occurrences of a stored recurrence after an instant (strictly), up to `limit` (default 1). The wall-clock time of DTSTART is kept
 * across daylight-saving changes (09:00 stays 09:00); a time the clocks skip moves forward by the jump, a time that happens twice is the
 * first one. Supports DAILY, WEEKLY, MONTHLY, YEARLY (and HOURLY, MINUTELY in elapsed time) with INTERVAL, BYDAY (with ordinals), BYMONTHDAY
 * (negative counts from the end), BYMONTH, COUNT and UNTIL. A month without the day (the 31st) is skipped. `[]` when the rule is unreadable
 * or has no further occurrence.
 */
export const occurrencesAfter = (spec: RecurrenceSpec, after: number, limit = 1): Array<number> => {
  const rule = parseRRule(spec.rrule)
  const dt = parseDtstart(spec.dtstart)
  if (rule === undefined || dt === undefined) return []
  const zone = spec.timeZone
  const start = dt.start
  const startInstant = zonedToInstant(start, zone)
  const until = rule.until === undefined ? Infinity : parseUntil(rule.until, zone)
  const out: Array<number> = []
  let produced = 0
  const accept = (instant: number): "stop" | "continue" => {
    if (instant < startInstant) return "continue"
    if (instant > until) return "stop"
    produced++
    if (rule.count !== undefined && produced > rule.count) return "stop"
    if (instant > after) out.push(instant)
    return out.length >= limit ? "stop" : "continue"
  }
  const startDate: LocalDate = start
  const counted = rule.count !== undefined
  const wallTime = (d: LocalDate) => zonedToInstant({ ...d, hour: start.hour, minute: start.minute }, zone)
  const afterLocal = localParts(after, zone)
  if (rule.freq === "HOURLY" || rule.freq === "MINUTELY") {
    const step = rule.interval * (rule.freq === "HOURLY" ? 3_600_000 : 60_000)
    let k = counted ? 0 : Math.max(0, Math.floor((after - startInstant) / step))
    for (let n = 0; n < iterationLimit; n++, k++) {
      const t = startInstant + k * step
      const day = localParts(t, zone)
      const okMonth = rule.byMonth.length === 0 || rule.byMonth.includes(day.month)
      const okDay = rule.byDay.length === 0 || rule.byDay.some((d) => weekdayIndex(d.weekday) === day.weekday)
      if (!okMonth || !okDay) continue
      if (accept(t) === "stop") break
    }
    return out
  }
  const perDay = (d: LocalDate): boolean => {
    const okMonth = rule.byMonth.length === 0 || rule.byMonth.includes(d.month)
    const last = daysInMonth(d.year, d.month)
    const okDate = rule.byMonthDay.length === 0 || rule.byMonthDay.some((x) => (x < 0 ? last + x + 1 : x) === d.day)
    const okWeekday = rule.byDay.length === 0 || rule.byDay.some((x) => weekdayIndex(x.weekday) === isoWeekday(d))
    return okMonth && okDate && okWeekday
  }
  const diffDays = Math.round((Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day) - Date.UTC(start.year, start.month - 1, start.day)) / 86_400_000)
  if (rule.freq === "DAILY") {
    let k = counted ? 0 : Math.max(0, Math.floor(diffDays / rule.interval) - 1)
    for (let n = 0; n < iterationLimit; n++, k++) {
      const d = addDays(startDate, k * rule.interval)
      if (!perDay(d)) continue
      if (accept(wallTime(d)) === "stop") break
    }
    return out
  }
  if (rule.freq === "WEEKLY") {
    const monday0 = addDays(startDate, -(isoWeekday(startDate) - 1))
    const days = rule.byDay.length > 0 ? rule.byDay.map((d) => weekdayIndex(d.weekday)).sort((a, b) => a - b) : [isoWeekday(startDate)]
    let k = counted ? 0 : Math.max(0, Math.floor(diffDays / 7 / rule.interval) - 1)
    for (let n = 0; n < iterationLimit; n++, k++) {
      const monday = addDays(monday0, 7 * rule.interval * k)
      let stop = false
      for (const wd of [...new Set(days)]) {
        const d = addDays(monday, wd - 1)
        if (rule.byMonth.length > 0 && !rule.byMonth.includes(d.month)) continue
        if (accept(wallTime(d)) === "stop") { stop = true; break }
      }
      if (stop) break
    }
    return out
  }
  if (rule.freq === "MONTHLY") {
    const monthsFrom = (afterLocal.year - start.year) * 12 + afterLocal.month - start.month
    let k = counted ? 0 : Math.max(0, Math.floor(monthsFrom / rule.interval) - 1)
    for (let n = 0; n < iterationLimit; n++, k++) {
      const m = addMonths(startDate, k * rule.interval)
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(m.month)) continue
      let stop = false
      for (const day of monthDays(rule, m.year, m.month, start.day)) {
        if (accept(wallTime({ ...m, day })) === "stop") { stop = true; break }
      }
      if (stop) break
    }
    return out
  }
  // YEARLY
  let k = counted ? 0 : Math.max(0, Math.floor((afterLocal.year - start.year) / rule.interval) - 1)
  for (let n = 0; n < iterationLimit; n++, k++) {
    const year = start.year + k * rule.interval
    const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [start.month]
    let stop = false
    for (const month of months) {
      for (const day of monthDays(rule, year, month, start.day)) {
        if (accept(wallTime({ year, month, day })) === "stop") { stop = true; break }
      }
      if (stop) break
    }
    if (stop) break
  }
  return out
}

/** The next occurrence strictly after `after` (epoch milliseconds), or `undefined`. See `occurrencesAfter`. */
export const nextOccurrence = (spec: RecurrenceSpec, after: number | Date): number | undefined =>
  occurrencesAfter(spec, typeof after === "number" ? after : after.getTime(), 1)[0]

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
 * "every second Tuesday", "on the first of every month", "the last Friday of every month"; Dutch "elke dag", "elke werkdag",
 * "elke tweede dinsdag", "op de eerste van elke maand". `undefined` when the rule cannot be read.
 */
export const describeRRule = (rrule: string | RecurrenceRule, language: Language, options: DescribeOptions = {}): string | undefined => {
  const rule = typeof rrule === "string" ? parseRRule(rrule) : rrule
  if (rule === undefined) return undefined
  const en = language === "en"
  const every = en ? "every" : "elke"
  const n = rule.interval
  const days = [...new Set(rule.byDay.map((d) => weekdayIndex(d.weekday)))].sort((a, b) => a - b)
  const plain = rule.byDay.every((d) => d.nth === undefined)
  let text: string
  switch (rule.freq) {
    case "MINUTELY": text = n === 1 ? (en ? "every minute" : "elke minuut") : `${every} ${smallNumber(n, language)} ${en ? "minutes" : "minuten"}`; break
    case "HOURLY": text = n === 1 ? (en ? "every hour" : "elk uur") : `${every} ${smallNumber(n, language)} ${en ? "hours" : "uur"}`; break
    case "DAILY":
      if (days.join() === "1,2,3,4,5" && n === 1) text = en ? "every weekday" : "elke werkdag"
      else if (days.join() === "6,7" && n === 1) text = en ? "every weekend" : "elk weekend"
      else if (n === 1) text = en ? "every day" : "elke dag"
      else if (n === 2) text = en ? "every other day" : "om de dag"
      else text = `${every} ${smallNumber(n, language)} ${en ? "days" : "dagen"}`
      if (days.length > 0 && !(["1,2,3,4,5", "6,7"].includes(days.join()) && n === 1)) text += (en ? " on " : " op ") + dayList(days, language)
      break
    case "WEEKLY":
      if (days.length === 0) text = n === 1 ? `${every} ${en ? "week" : "week"}` : n === 2 ? (en ? "every other week" : "om de week") : `${every} ${smallNumber(n, language)} ${en ? "weeks" : "weken"}`
      else if (n === 1 && days.join() === "1,2,3,4,5") text = en ? "every weekday" : "elke werkdag"
      else if (n === 1 && days.join() === "6,7") text = en ? "every weekend" : "elk weekend"
      else if (n === 1) text = `${every} ${dayList(days, language)}`
      else if (n === 2 && days.length === 1) text = `${every} ${ordinalToWords(2, language)} ${weekdayNames[language][days[0]! - 1]}`
      else text = `${n === 2 ? (en ? "every other week" : "om de week") : `${every} ${smallNumber(n, language)} ${en ? "weeks" : "weken"}`} ${en ? "on" : "op"} ${dayList(days, language)}`
      break
    case "MONTHLY": {
      const monthly = n === 1 ? (en ? "every month" : "elke maand") : `${every} ${smallNumber(n, language)} ${en ? "months" : "maanden"}`
      const ofMonth = n === 1 ? (en ? "of every month" : "van elke maand") : `${en ? "of" : "van"} ${monthly}`
      if (rule.byDay.length > 0 && !plain) {
        const parts = rule.byDay.map((d) => `${d.nth === -1 ? (en ? "last" : "laatste") : ordinalToWords(d.nth ?? 1, language)} ${weekdayNames[language][weekdayIndex(d.weekday) - 1]}`)
        const and = en ? "and" : "en"
        const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} ${and} ${parts[parts.length - 1]}`
        text = en ? `the ${joined} ${ofMonth}` : `${every} ${joined} ${ofMonth}`
      } else if (rule.byMonthDay.length > 0) text = `${en ? "on" : "op"} ${ordList(rule.byMonthDay, language)} ${ofMonth}`
      else if (days.length > 0) text = `${every} ${dayList(days, language)}`
      else text = options.start !== undefined ? `${en ? "on" : "op"} ${ordList([options.start.day], language)} ${ofMonth}` : monthly
      break
    }
    case "YEARLY": {
      const yearly = n === 1 ? (en ? "every year" : "elk jaar") : `${every} ${smallNumber(n, language)} ${en ? "years" : "jaar"}`
      const month = rule.byMonth[0] ?? options.start?.month
      const day = rule.byMonthDay[0] ?? options.start?.day
      if (month !== undefined && day !== undefined && day > 0) text = en ? `${yearly} on the ${ordinalToWords(day, "en")} of ${monthNames.en[month - 1]}` : `${yearly} op ${day} ${monthNames.nl[month - 1]}`
      else text = yearly
      break
    }
  }
  if (rule.count !== undefined) text += en ? `, ${rule.count} times` : `, ${rule.count} keer`
  if (rule.until !== undefined) {
    const u = /^(\d{4})(\d{2})(\d{2})/.exec(rule.until)!
    const [y, m, d] = [Number(u[1]), Number(u[2]), Number(u[3])]
    text += en ? `, until the ${ordinalToWords(d, "en")} of ${monthNames.en[m - 1]} ${y}` : `, tot ${d} ${monthNames.nl[m - 1]} ${y}`
  }
  if (options.time !== undefined) text += ` ${en ? "at" : "om"} ${speakTime(options.time, language, { period: true })}`
  return text
}
