import type { ClockTime, LocalDate, LocalDateTime } from "./Result.ts"

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The zone itself when this machine knows it, otherwise "UTC" (the parsers never throw). */
export const knownZone = (timeZone: string): string => {
  if (formatters.has(timeZone)) return timeZone
  try {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
    }))
    return timeZone
  } catch {
    return "UTC"
  }
}

/** The offset (zone minus UTC) in milliseconds at an instant. */
export const offsetAt = (instant: number, timeZone: string): number => {
  const parts = formatters.get(knownZone(timeZone))!.formatToParts(new Date(instant))
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
 * The instant of a wall-clock time in a zone. A time that does not exist (the clocks jumped over it) moves forward by the jump
 * (02:30 on the spring day is 03:30); a time that happens twice (autumn) is the first one.
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

/** "2026-11-18T09:00" or "20261118T090000" → parts. */
export const parseLocalIso = (s: string): LocalDateTime | undefined => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):?(\d{2})(?::?(\d{2}))?)?$/.exec(s.trim())
  if (m === null) return undefined
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0) }
}
export const pad = (n: number, w = 2): string => String(n).padStart(w, "0")
