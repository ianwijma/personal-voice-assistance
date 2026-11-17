// Review round 3, decision 6: the one helper the recurrence reference may share with the engine is the zone-offset lookup, so it
// gets its own exhaustive test. The package's `offsetAt` (Intl's wall clock read back) is compared with the tests' `offsetRef`
// (Intl's "GMT+01:00" offset name) over 2000–2199: a scan every day finds every transition (none here is less than a day from the
// next), and at each the instants a second and an hour either side are compared; `zonedInstants` (wall clock → instants) against the
// tests' own search at every quarter hour within 90 minutes of each, and against plain arithmetic for wall-clock times made directly
// across every gap and fold (round 4, finding 23).
import { describe, expect, it } from "@effect/vitest"
import { offsetAt, zonedInstants } from "../src/Zoned.ts"
import { instantsOf, offsetRef, wallOf } from "./support/Zone.ts"

const zones = ["Europe/Amsterdam", "Australia/Sydney", "Pacific/Apia", "Australia/Lord_Howe", "Africa/Casablanca", "Pacific/Chatham", "UTC"]
const H = 3_600_000
const from = Date.UTC(2000, 0, 1) - 14 * H
const to = Date.UTC(2200, 0, 1) + 14 * H

/** The instant (to the second) where the offset changes, between `a` (old offset) and `b` (new). */
const transitionBetween = (a: number, b: number, zone: string): number => {
  const old = offsetRef(a, zone)
  let lo = a
  let hi = b
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000
    if (offsetRef(mid, zone) === old) lo = mid
    else hi = mid
  }
  return hi
}

describe("the zone offset lookup over the supported years", () => {
  for (const zone of zones) {
    it(`${zone}: every transition, to the second, and a sample every 10 days elsewhere`, () => {
      let transitions = 0
      let compared = 0
      let gaps = 0
      let previous = offsetRef(from, zone)
      for (let t = from; t <= to; t += 24 * H) {
        const now = offsetRef(t, zone)
        if (k(t) % 10 === 0) { compared++; if (offsetAt(t, zone) !== now) throw new Error(`${zone} ${new Date(t).toISOString()}: ${offsetAt(t, zone)} vs ${now}`) }
        if (now !== previous) {
          const at = transitionBetween(t - 24 * H, t, zone)
          transitions++
          for (const x of [at - 3600_000, at - 1000, at - 1, at, at + 1, at + 3600_000]) {
            compared++
            if (offsetAt(x, zone) !== offsetRef(x, zone)) throw new Error(`${zone} near ${new Date(at).toISOString()}: at ${new Date(x).toISOString()} ${offsetAt(x, zone)} vs ${offsetRef(x, zone)}`)
          }
          // Civil wall-clock times made by arithmetic, not images of real instants (review round 4, finding 23): across the times the
          // transition skips (a gap: one instant, read with the offset from before it) or repeats (a fold: two), from either side,
          // every five minutes from half an hour before to half an hour after, and a second either side of each edge.
          const old = offsetRef(at - 1, zone)
          const next = offsetRef(at, zone)
          const lo = at + Math.min(old, next)
          const hi = at + Math.max(old, next)
          const walls = new Set<number>()
          for (let w = lo - 30 * 60_000; w <= hi + 30 * 60_000; w += 5 * 60_000) walls.add(w)
          for (const edge of [lo, hi]) for (const d of [-1000, 0, 1000]) walls.add(edge + d)
          for (const w of walls) {
            const d = new Date(w)
            const civil = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }
            const inside = w >= lo && w < hi
            const want = !inside ? [w < lo ? w - old : w - next] : next > old ? [w - old] : [w - old, w - next]
            const ours = zonedInstants(civil, zone)
            compared++
            if (inside && next > old) gaps++
            if (JSON.stringify(ours) !== JSON.stringify(want)) throw new Error(`${zone} ${JSON.stringify(civil)} (${next > old ? "gap" : "fold"}): ${ours.map((i) => new Date(i).toISOString())} vs ${want.map((i) => new Date(i).toISOString())}`)
          }
          // Every quarter hour of wall clock within 90 minutes of the transition: the same instants.
          for (let q = -6; q <= 6; q++) {
            const w = wallOf(at + q * 15 * 60_000, zone)
            const theirs = instantsOf(w, zone)
            const ours = zonedInstants(w, zone)
            compared++
            if (JSON.stringify(ours) !== JSON.stringify(theirs)) throw new Error(`${zone} ${JSON.stringify(w)}: ${ours.map((i) => new Date(i).toISOString())} vs ${theirs.map((i) => new Date(i).toISOString())}`)
          }
        }
        previous = now
      }
      expect(compared).toBeGreaterThan(7000)
      // Every zone with transitions has nonexistent wall times, and they were tried.
      if (zone !== "UTC") expect(gaps).toBeGreaterThan(50)
      if (zone === "Europe/Amsterdam") expect(transitions).toBe(400)
      if (zone === "UTC" || zone === "Asia/Kathmandu") expect(transitions).toBe(0)
    })
  }
})
const k = (t: number) => Math.floor((t - from) / (24 * H))

describe("a gap after a zero offset (round 4, finding 23)", () => {
  it("Casablanca, 22 March 2026: 02:30 does not exist and is read with the offset before the gap, +00:00", async () => {
    const { parseDateTime } = await import("../src/Dates.ts")
    const r = parseDateTime("22 March 2026 at 02:30", "en", { now: Date.parse("2026-03-21T12:00Z"), timeZone: "Africa/Casablanca" })
    expect(r.kind === "ok" ? r.value.instant : r.kind).toBe(1_774_146_600_000)
    expect(zonedInstants({ year: 2026, month: 3, day: 22, hour: 2, minute: 30, second: 0 }, "Africa/Casablanca")).toEqual([Date.UTC(2026, 2, 22, 2, 30)])
  })
})
