// The tests' own calendar and time-zone arithmetic (review round 3, decision 6): JavaScript's Date for civil dates, and Intl for zones —
// the offset from the "GMT+01:00" offset name, the wall clock from formatToParts. Nothing here comes from the package. The package's
// own offset lookup is tested against `offsetRef` over the supported years (ZoneOffsets.test.ts).

export interface Day { readonly year: number; readonly month: number; readonly day: number }
export interface Wall extends Day { readonly hour: number; readonly minute: number; readonly second: number }

const DAY = 86_400_000
export const utcOfDay = (d: Day): number => Date.UTC(d.year, d.month - 1, d.day)
export const dayOfUtc = (ms: number): Day => { const t = new Date(ms); return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() } }
export const plusDays = (d: Day, n: number): Day => dayOfUtc(utcOfDay(d) + n * DAY)
export const weekdayOf = (d: Day): number => { const w = new Date(utcOfDay(d)).getUTCDay(); return w === 0 ? 7 : w }
export const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()
export const sameDay = (a: Day, b: Day): boolean => a.year === b.year && a.month === b.month && a.day === b.day
export const dayKey = (d: Day): number => d.year * 10_000 + d.month * 100 + d.day
export const inYears = (d: Day): boolean => d.year >= 2000 && d.year <= 2199

const offsetFormat = new Map<string, Intl.DateTimeFormat>()
/** Zone minus UTC in milliseconds at an instant, from Intl's long offset name ("GMT+05:45"). */
export const offsetRef = (instant: number, zone: string): number => {
  let f = offsetFormat.get(zone)
  if (f === undefined) { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }); offsetFormat.set(zone, f) }
  const name = f.formatToParts(instant).find((p) => p.type === "timeZoneName")!.value
  const m = /GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(name)!
  if (m[1] === undefined) return 0
  return (m[1] === "-" ? -1 : 1) * ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000
}

const wallFormat = new Map<string, Intl.DateTimeFormat>()
/** The wall clock of an instant in a zone, read from formatToParts. */
export const wallOf = (instant: number, zone: string): Wall & { readonly weekday: number } => {
  let f = wallFormat.get(zone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    wallFormat.set(zone, f)
  }
  const parts = Object.fromEntries(f.formatToParts(instant).map((p) => [p.type, p.value]))
  const d = { year: Number(parts["year"]), month: Number(parts["month"]), day: Number(parts["day"]) }
  return { ...d, hour: Number(parts["hour"]), minute: Number(parts["minute"]), second: Number(parts["second"]), weekday: weekdayOf(d) }
}

const instantsCache = new Map<string, ReadonlyArray<number>>()
/**
 * Every instant at which a wall-clock time happens in a zone, earliest first: each distinct offset seen within two days of it is
 * tried and kept when the wall clock at that instant is the time asked for. None (a time the clocks skip): the time read with the
 * offset in force just before the jump (RFC 5545 §3.3.5), found by scanning for the jump.
 */
export const instantsOf = (w: Wall, zone: string): ReadonlyArray<number> => {
  const key = `${zone}|${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}:${w.second}`
  const cached = instantsCache.get(key)
  if (cached !== undefined) return cached
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  const offsets = new Set<number>()
  for (let t = wall - 2 * DAY; t <= wall + 2 * DAY; t += 3 * 3_600_000) offsets.add(offsetRef(t, zone))
  const valid = [...offsets].map((o) => wall - o).filter((i) => {
    const x = wallOf(i, zone)
    return x.year === w.year && x.month === w.month && x.day === w.day && x.hour === w.hour && x.minute === w.minute && x.second === w.second
  }).sort((a, b) => a - b)
  let out: ReadonlyArray<number> = valid
  if (valid.length === 0) {
    // The jump: the last instant before `wall - before` whose offset is still the earlier one.
    const before = offsetRef(wall - 2 * DAY, zone)
    out = [wall - before]
  }
  if (instantsCache.size > 100_000) instantsCache.clear()
  instantsCache.set(key, out)
  return out
}

/**
 * Whether a local day happens at all in a zone: some quarter hour of the instants that could be on it (UTC −15 h to +39 h of its
 * midnight) is on it by the wall clock. False only for a day the clocks jump over (Pacific/Apia, 30 December 2011); a gap that pushes
 * a late time past midnight (America/Nuuk, 28 March 2026) leaves the day (review round 5, finding 1).
 */
export const dayHappensRef = (d: Day, zone: string): boolean => {
  for (let t = utcOfDay(d) - 15 * 3_600_000; t <= utcOfDay(d) + 39 * 3_600_000; t += 900_000) if (sameDay(wallOf(t, zone), d)) return true
  return false
}

/** The zone's canonical name as this machine's Intl spells it ("America/Nuuk" may be "America/Godthab"), as a TZID is written. */
export const canonicalZone = (zone: string): string => new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone
