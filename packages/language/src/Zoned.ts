import type { ClockTime, LocalDate, LocalDateTime } from "./Result.ts"

const formatters = new Map<string, Intl.DateTimeFormat>()
const canonical = new Map<string, string | undefined>()

/**
 * The IANA zone `timeZone` names, in its canonical spelling ("europe/amsterdam " → "Europe/Amsterdam"), or `undefined` when this
 * machine does not know it. Surrounding spaces are ignored (the Home section stores what was typed). Never substitutes another
 * zone: a parser given an unknown zone answers `not-understood`, and `nextOccurrence` answers `undefined` (review round 1, finding 21).
 */
export const normalizeTimeZone = (timeZone: string): string | undefined => {
  if (typeof timeZone !== "string") return undefined
  if (canonical.has(timeZone)) return canonical.get(timeZone)
  const trimmed = timeZone.trim()
  let found: string | undefined
  if (trimmed !== "") {
    try {
      const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone
      found = resolved
      if (!formatters.has(resolved)) {
        formatters.set(resolved, new Intl.DateTimeFormat("en-US", {
          timeZone: resolved, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
        }))
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

/** The offset (zone minus UTC) in milliseconds at an instant. Throws a `RangeError` for a zone this machine does not know. */
export const offsetAt = (instant: number, timeZone: string): number => {
  const parts = formatterOf(timeZone).formatToParts(new Date(instant))
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
  return asUtc - Math.floor(instant / 1000) * 1000
}

export interface ZonedParts extends LocalDateTime {
  readonly second: number
  /** 1 = Monday … 7 = Sunday. */
  readonly weekday: number
}

export const isoWeekday = (d: LocalDate): number => {
  const w = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()
  return w === 0 ? 7 : w
}

/** The wall-clock reading of an instant in a zone. */
export const localParts = (instant: number, timeZone: string): ZonedParts => {
  const local = new Date(instant + offsetAt(instant, timeZone))
  const d = { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() }
  return { ...d, hour: local.getUTCHours(), minute: local.getUTCMinutes(), second: local.getUTCSeconds(), weekday: isoWeekday(d) }
}

/**
 * The instant of a wall-clock time in a zone. A time that does not exist (the clocks jumped over it) is read with the UTC offset
 * from before the jump, so it moves forward by the jump (02:30 on the spring day in Amsterdam is 03:30). That is RFC 5545 §3.3.5
 * ("a nonexistent local time ... is interpreted using the UTC offset before the gap"), which §3.3.10 applies to recurrence
 * instances too, and it is what a household wants from an alarm. A time that happens twice (autumn) is the first one. Throws a
 * `RangeError` for a zone this machine does not know.
 */
export const zonedToInstant = (t: LocalDate & Partial<ClockTime> & { readonly second?: number }, timeZone: string): number => {
  const wall = Date.UTC(t.year, t.month - 1, t.day, t.hour ?? 0, t.minute ?? 0, t.second ?? 0)
  const before = offsetAt(wall - 86_400_000, timeZone)
  const after = offsetAt(wall + 86_400_000, timeZone)
  const valid = [...new Set([before, after])].filter((o) => offsetAt(wall - o, timeZone) === o)
  if (valid.length === 0) return wall - before
  return wall - Math.max(...valid)
}

export const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

export const addDays = (d: LocalDate, n: number): LocalDate => {
  const x = new Date(Date.UTC(d.year, d.month - 1, d.day + n))
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() }
}

export const addMonths = (d: LocalDate, n: number): { year: number; month: number } => {
  const idx = d.year * 12 + (d.month - 1) + n
  return { year: Math.floor(idx / 12), month: (idx % 12 + 12) % 12 + 1 }
}

/** Calendar days from `a` to `b`. */
export const dayDiff = (a: LocalDate, b: LocalDate): number =>
  Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000)

export const sameDate = (a: LocalDate, b: LocalDate): boolean => a.year === b.year && a.month === b.month && a.day === b.day

/** A real calendar date and wall-clock reading: month 1–12, the day exists in that month, hour 0–23, minute and second 0–59. */
export const isValidLocal = (t: LocalDate & Partial<ClockTime> & { readonly second?: number }): boolean =>
  Number.isInteger(t.year) && t.year >= 1 && t.year <= 9999 && Number.isInteger(t.month) && t.month >= 1 && t.month <= 12 &&
  Number.isInteger(t.day) && t.day >= 1 && t.day <= daysInMonth(t.year, t.month) &&
  (t.hour === undefined || (Number.isInteger(t.hour) && t.hour >= 0 && t.hour <= 23)) &&
  (t.minute === undefined || (Number.isInteger(t.minute) && t.minute >= 0 && t.minute <= 59)) &&
  (t.second === undefined || (Number.isInteger(t.second) && t.second >= 0 && t.second <= 59))

/**
 * "2026-11-18T09:00", "2026-11-18T09:00:30", "20261118T090030" or "20261118" → parts, seconds kept. One spelling per value
 * (both separators or neither); a date or time that does not exist ("2026-02-30", "25:00") is `undefined`, never normalised into
 * another one. A UTC "Z" suffix is not accepted here (see `parseDtstart`).
 */
export const parseLocalIso = (s: string): LocalDateTime | undefined => {
  const text = s.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text) ?? /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/.exec(text)
  if (m === null) return undefined
  const t = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0) }
  return isValidLocal(t) ? t : undefined
}
export const pad = (n: number, w = 2): string => String(n).padStart(w, "0")
