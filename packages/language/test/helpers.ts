import type { Parsed } from "../src/Result.ts"
import { zonedToInstant } from "../src/Zoned.ts"

export const AMS = "Europe/Amsterdam"
/** An instant from an Amsterdam wall-clock time. */
export const ams = (year: number, month: number, day: number, hour = 0, minute = 0): number => zonedToInstant({ year, month, day, hour, minute }, AMS)
/** Wednesday 18 November 2026, 10:00 in Amsterdam. */
export const NOW = ams(2026, 11, 18, 10, 0)

export const value = <T>(p: Parsed<T>): T => {
  if (p.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(p)}`)
  return p.value
}
export const hm = (t: { hour: number; minute: number }): string => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`
export const iso = (instant: number): string => {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: AMS, dateStyle: "short", timeStyle: "short" }).format(instant)
  return p.replace(" ", "T")
}
