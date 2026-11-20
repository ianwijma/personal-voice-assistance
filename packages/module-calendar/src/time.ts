import type { HostView } from "@pva/core"
import { normalizeTimeZone } from "@pva/language"

/**
 * Local dates and wall-clock times in a time zone, on `Intl` (the household's zone, and the IANA zone an ICS file
 * names without a VTIMEZONE). Bounded, synchronous and cheap: one cached formatter per zone.
 */

export interface LocalDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

export interface WallTime extends LocalDate {
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** The household's zone: `HOME_TIME_ZONE`, and when it is empty (the default) or unknown, this machine's. */
export const homeZone = (view: Pick<HostView, "home">): string => {
  const zone = view.home.HOME_TIME_ZONE
  const given = typeof zone === "string" && zone.trim() !== "" ? normalizeTimeZone(zone.trim()) : undefined
  return given ?? Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The formatters, one per zone (a household has one zone; an ICS file names a few). */
const formatters = new Map<string, Intl.DateTimeFormat>()
const MAX_FORMATTERS = 64

const formatterOf = (zone: string): Intl.DateTimeFormat => {
  let f = formatters.get(zone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    })
    if (formatters.size >= MAX_FORMATTERS) formatters.clear()
    formatters.set(zone, f)
  }
  return f
}

/** The wall-clock time of an instant in `zone`. */
export const wallTimeOf = (instant: number, zone: string): WallTime => {
  const parts: Record<string, number> = {}
  for (const p of formatterOf(zone).formatToParts(instant)) if (p.type !== "literal") parts[p.type] = Number(p.value)
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! }
}

/** The zone's offset from UTC at an instant, in ms. */
const offsetAt = (instant: number, zone: string): number => {
  const w = wallTimeOf(instant, zone)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(instant / 1000) * 1000
}

/**
 * The instant of a wall-clock time in `zone`. A time that does not exist (the hour skipped in spring) is read with the
 * offset before the change; one that happens twice (autumn) is its first.
 */
export const instantOf = (t: LocalDate & { readonly hour?: number; readonly minute?: number; readonly second?: number }, zone: string): number => {
  const asUtc = Date.UTC(t.year, t.month - 1, t.day, t.hour ?? 0, t.minute ?? 0, t.second ?? 0)
  // The offsets a day either side cover any change of the zone's offset in between (zones change at most twice a year).
  const before = offsetAt(asUtc - 86_400_000, zone)
  const after = offsetAt(asUtc + 86_400_000, zone)
  const fits = [asUtc - before, asUtc - after].filter((i) => i + offsetAt(i, zone) === asUtc)
  return fits.length > 0 ? Math.min(...fits) : asUtc - before
}

export const dateOf = (instant: number, zone: string): LocalDate => {
  const w = wallTimeOf(instant, zone)
  return { year: w.year, month: w.month, day: w.day }
}

export const dayNumber = (d: LocalDate): number => d.year * 10_000 + d.month * 100 + d.day

export const dateOfDayNumber = (n: number): LocalDate => ({ year: Math.floor(n / 10_000), month: Math.floor(n / 100) % 100, day: n % 100 })

export const addDays = (d: LocalDate, n: number): LocalDate => {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n))
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

/** Whole days from `a` to `b`. */
export const daysBetween = (a: LocalDate, b: LocalDate): number => Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000)

/** The local midnight that starts `d`. */
export const startOfDay = (d: LocalDate, zone: string): number => instantOf(d, zone)

/** `YYYY-MM-DD`, for an ISO date a model passes. */
export const parseIsoDate = (text: string): LocalDate | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (m === null) return undefined
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  const check = addDays(d, 0)
  return check.year === d.year && check.month === d.month && check.day === d.day && d.year >= 1900 && d.year <= 2999 ? d : undefined
}

/** `HH:MM` (24 hours), for the bounds of a free-time question. */
export const parseClock = (text: string): { readonly hour: number; readonly minute: number } | undefined => {
  const m = /^([01]?\d|2[0-4]):([0-5]\d)$/.exec(text.trim())
  if (m === null) return undefined
  const hour = Number(m[1])
  const minute = Number(m[2])
  return hour === 24 && minute !== 0 ? undefined : { hour, minute }
}
