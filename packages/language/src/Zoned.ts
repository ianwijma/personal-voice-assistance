import { maxYear, minYear } from "./Domain.ts"
import type { ClockTime, LocalDate, LocalDateTime } from "./Result.ts"

export { maxYear, minYear }

const formatters = new Map<string, Intl.DateTimeFormat>()
const canonical = new Map<string, string | undefined>()

/** An IANA zone name ("Europe/Amsterdam", "UTC", "Etc/GMT-1"), not a fixed offset such as "+01:00" (review round 2, finding 24). */
const ianaName = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/

/**
 * The IANA zone `timeZone` names, in its canonical spelling ("europe/amsterdam " → "Europe/Amsterdam"), or `undefined` when this
 * machine does not know it or it is a fixed offset ("+01:00", "+0100", "-05"): those are not zone names, cannot be written as a
 * `TZID` and are not accepted anywhere in this package. Surrounding spaces are ignored (the Home section stores what was typed).
 * Never substitutes another zone: a parser given an unknown zone answers `not-understood`, and `nextOccurrence` answers `undefined`.
 */
export const normalizeTimeZone = (timeZone: string): string | undefined => {
  if (typeof timeZone !== "string" || timeZone.length > 64) return undefined
  if (canonical.has(timeZone)) return canonical.get(timeZone)
  const trimmed = timeZone.trim()
  let found: string | undefined
  if (trimmed !== "" && ianaName.test(trimmed)) {
    try {
      const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone
      if (ianaName.test(resolved)) {
        found = resolved
        if (!formatters.has(resolved)) {
          formatters.set(resolved, new Intl.DateTimeFormat("en-US", {
            timeZone: resolved, hourCycle: "h23", era: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
          }))
        }
      }
    } catch {
      found = undefined
    }
  }
  if (canonical.size > 1000) canonical.clear()
  canonical.set(timeZone, found)
  return found
}

const formatterOf = (timeZone: string): Intl.DateTimeFormat => {
  const zone = normalizeTimeZone(timeZone)
  if (zone === undefined) throw new RangeError(`Unknown time zone: ${JSON.stringify(timeZone)}`)
  return formatters.get(zone)!
}

// ---- civil calendar arithmetic (proleptic Gregorian, any year; no Date.UTC, which reads years 0–99 as 1900–1999) ----------------

/** Days since 1970-01-01 of a calendar date (H. Hinnant's `days_from_civil`). */
export const dayNumber = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = (month + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146_097 + doe - 719_468
}

/** The calendar date of a day number (`civil_from_days`). */
export const dateOfDay = (n: number): LocalDate => {
  const z = n + 719_468
  const era = Math.floor(z / 146_097)
  const doe = z - era * 146_097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day }
}

const dayMs = 86_400_000
/** Milliseconds since the epoch of a wall-clock reading taken as UTC. */
const wallMs = (t: LocalDate & Partial<ClockTime> & { readonly second?: number }): number =>
  dayNumber(t.year, t.month, t.day) * dayMs + ((t.hour ?? 0) * 3600 + (t.minute ?? 0) * 60 + (t.second ?? 0)) * 1000

/** The offset (zone minus UTC) in milliseconds at an instant. Throws a `RangeError` for a zone this machine does not know. */
export const offsetAt = (instant: number, timeZone: string): number => {
  const parts = formatterOf(timeZone).formatToParts(new Date(instant))
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const bc = parts.find((p) => p.type === "era")?.value === "BC"
  const year = bc ? 1 - get("year") : get("year")
  const asUtc = wallMs({ year, month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") })
  return asUtc - Math.floor(instant / 1000) * 1000
}

export interface ZonedParts extends LocalDateTime {
  readonly second: number
  /** 1 = Monday … 7 = Sunday. */
  readonly weekday: number
}

/** 1 = Monday … 7 = Sunday, of a day number. */
export const weekdayOfDay = (n: number): number => ((((n + 3) % 7) + 7) % 7) + 1

export const isoWeekday = (d: LocalDate): number => weekdayOfDay(dayNumber(d.year, d.month, d.day))

/** The wall-clock reading of an instant in a zone. */
export const localParts = (instant: number, timeZone: string): ZonedParts => {
  const local = instant + offsetAt(instant, timeZone)
  const n = Math.floor(local / dayMs)
  const d = dateOfDay(n)
  const s = Math.floor((local - n * dayMs) / 1000)
  return { ...d, hour: Math.floor(s / 3600), minute: Math.floor((s % 3600) / 60), second: s % 60, weekday: weekdayOfDay(n) }
}

/**
 * Every instant at which a wall-clock time happens in a zone, earliest first: one, two when the clocks go back over it (autumn), or
 * — when the clocks jump over it — the one read with the UTC offset from before the jump (RFC 5545 §3.3.5: "a nonexistent local
 * time ... is interpreted using the UTC offset before the gap"), so 02:30 on the spring day in Amsterdam is 03:30.
 */
export const zonedInstants = (t: LocalDate & Partial<ClockTime> & { readonly second?: number }, timeZone: string): Array<number> => {
  const wall = wallMs(t)
  const before = offsetAt(wall - dayMs, timeZone)
  const after = offsetAt(wall + dayMs, timeZone)
  const valid = [...new Set([before, after])].filter((o) => offsetAt(wall - o, timeZone) === o)
  if (valid.length === 0) return [wall - before]
  return valid.map((o) => wall - o).sort((a, b) => a - b)
}

/**
 * The instant of a wall-clock time in a zone: the first of `zonedInstants`. A time that does not exist moves forward by the jump; a
 * time that happens twice is the first one. RFC 5545 §3.3.10 applies the same reading to recurrence instances. Throws a `RangeError`
 * for a zone this machine does not know.
 */
export const zonedToInstant = (t: LocalDate & Partial<ClockTime> & { readonly second?: number }, timeZone: string): number => zonedInstants(t, timeZone)[0]!

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
export const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (isLeap(year) ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31

export const addDays = (d: LocalDate, n: number): LocalDate => dateOfDay(dayNumber(d.year, d.month, d.day) + n)

export const addMonths = (d: LocalDate, n: number): { year: number; month: number } => {
  const idx = d.year * 12 + (d.month - 1) + n
  return { year: Math.floor(idx / 12), month: ((idx % 12) + 12) % 12 + 1 }
}

/** Calendar days from `a` to `b`. */
export const dayDiff = (a: LocalDate, b: LocalDate): number => dayNumber(b.year, b.month, b.day) - dayNumber(a.year, a.month, a.day)

export const sameDate = (a: LocalDate, b: LocalDate): boolean => a.year === b.year && a.month === b.month && a.day === b.day

/**
 * A real calendar date and wall-clock reading in the supported years (`minYear`–`maxYear`, four digits): month 1–12, the day exists in
 * that month, hour 0–23, minute and second 0–59. A year this package cannot represent is refused, never shifted (review round 2,
 * finding 22).
 */
export const isValidLocal = (t: LocalDate & Partial<ClockTime> & { readonly second?: number }): boolean =>
  Number.isInteger(t.year) && t.year >= minYear && t.year <= maxYear && Number.isInteger(t.month) && t.month >= 1 && t.month <= 12 &&
  Number.isInteger(t.day) && t.day >= 1 && t.day <= daysInMonth(t.year, t.month) &&
  (t.hour === undefined || (Number.isInteger(t.hour) && t.hour >= 0 && t.hour <= 23)) &&
  (t.minute === undefined || (Number.isInteger(t.minute) && t.minute >= 0 && t.minute <= 59)) &&
  (t.second === undefined || (Number.isInteger(t.second) && t.second >= 0 && t.second <= 59))

export const pad = (n: number, w = 2): string => String(n).padStart(w, "0")

/** The first and the last day of the supported years, as day numbers. */
export const firstDay = dayNumber(minYear, 1, 1)
export const lastDay = dayNumber(maxYear, 12, 31)

/** A calendar date in the supported years (the day exists). */
export const inRange = (d: LocalDate): boolean => isValidLocal(d)

/** The largest instant a JavaScript Date holds. */
const maxInstant = 8.64e15

/**
 * `now` as an instant whose local date in `zone` is in the supported years, or `undefined`: a number that is not finite or not a
 * Date's instant, an invalid Date, anything else (review round 3, findings 3 and 14).
 */
export const instantIn = (now: unknown, zone: string): { readonly instant: number; readonly parts: ZonedParts } | undefined => {
  const instant = typeof now === "number" ? now : now instanceof Date ? now.getTime() : Number.NaN
  if (!Number.isFinite(instant) || Math.abs(instant) > maxInstant) return undefined
  const parts = localParts(instant, zone)
  return inRange(parts) ? { instant, parts } : undefined
}
/** An instant whose local date in `zone` is in the supported years. */
export const instantInRange = (instant: number, zone: string): boolean => instantIn(instant, zone) !== undefined
