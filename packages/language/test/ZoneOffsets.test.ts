// Review round 3, decision 6: the one helper the recurrence reference may share with the engine is the zone-offset lookup, so it
// gets its own exhaustive test. The package's `offsetAt` (Intl's wall clock read back) is compared with the tests' `offsetRef`
// (Intl's "GMT+01:00" offset name) over 2000–2199: a scan every day finds every transition (none here is less than a day from the
// next), and at each the instants a second and an hour either side are compared; `zonedInstants` (wall clock → instants) against the
// tests' own search at every quarter hour within 90 minutes of each.
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
      if (zone === "Europe/Amsterdam") expect(transitions).toBe(400)
      if (zone === "UTC" || zone === "Asia/Kathmandu") expect(transitions).toBe(0)
    })
  }
})
const k = (t: number) => Math.floor((t - from) / (24 * H))
