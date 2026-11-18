// How long a refresh holds the main thread (finding 1), on the store the server runs (SQLite, here in memory) rather
// than the kit's in-memory test store, whose every list reads all of a collection's rows (fine for a test, not a
// latency to measure). The refresh itself, as its job runs it: the fetch, the worker, the new generation's rows written
// 25 per transaction, the old generation's removed a page per transaction, with a yield between each.
import { assert, describe, it } from "@effect/vitest"
import type { ModuleHostApi } from "@pva/core"
import { makeOfflineNet, offThreadWorkers } from "@pva/core/testing"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { makeSqliteStore } from "../../store-sqlite/src/index.ts"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { calendarModule, occurrences, sources } from "../src/index.ts"
import { makeRefresh } from "../src/refresh.ts"
import { AMS, calendar, heartbeat, ics, served } from "./fixtures.ts"

/** 1 MiB of events, each half an hour on one day, padded with descriptions (which are never read). */
const large = (count: number, prefix: string) =>
  ics(Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 19 + (i % 29)))
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`
    const h = String(8 + (i % 10)).padStart(2, "0")
    return { uid: `${prefix}${i}`, summary: `${prefix} ${i}`, start: `${ymd}T${h}0000`, end: `${ymd}T${h}3000`, tz: AMS, extra: ["DESCRIPTION:" + "d".repeat(180)] }
  }))

describe("calendar: the main thread during a refresh, on SQLite (finding 1)", () => {
  it.effect("2,900 rows written and 2,900 removed, from a 1 MiB file: no stop over the bound", () =>
    Effect.scoped(Effect.gen(function*() {
      yield* TestClock.setTime(Date.UTC(2026, 10, 18, 9, 0))
      const sqlite = yield* makeSqliteStore({ filename: ":memory:" })
      yield* sqlite.prepare([{ id: "calendar", storage: calendarModule.storage! }])
      const store = sqlite.forModule("calendar")
      let body = large(2_900, "First")
      const net = makeOfflineNet({ "https://cal.example.org/family.ics": () => served(body) })
      const host = { view: () => ({ home: { HOME_TIME_ZONE: AMS } }), service: () => undefined } as unknown as ModuleHostApi
      const refresh = yield* makeRefresh({ store, host, settings: { calendars: [calendar("Family", "https://cal.example.org/family.ics") as never] } }, { resolver: net.resolver, connector: net.connector })
      const actor = { kind: "job", jobId: "test" } as const
      yield* refresh.run(actor, true)
      const results: Array<number> = []
      for (const prefix of ["Second", "Third", "Fourth"]) {
        body = large(2_900, prefix)
        yield* TestClock.adjust(3_600_000)
        const { longest } = yield* heartbeat(refresh.run(actor, true))
        results.push(longest)
        const [state] = yield* store.collection(sources).list({})
        assert.strictEqual(state?.value.rows, 2_900)
        assert.isUndefined(state?.value.old)
        const rows = yield* store.collection(occurrences).list({ where: { day: 20261119 }, orderBy: { field: "start" }, limit: 20 })
        assert.isTrue(rows.every((r) => r.value.title.startsWith(prefix)))
      }
      // The largest answer a calendar may give: 46 daily series of the longest two-byte titles and places, 2,898
      // occurrences, about 2 MiB of text as the helper counts it, read in batches, written, and the last one removed.
      body = ics(Array.from({ length: 46 }, (_, i) => ({ uid: `s${i}`, summary: `${"ŝ".repeat(110)} ${i}`, location: "ĝ".repeat(80), start: "20261118T100000", end: "20261118T103000", tz: AMS, rrule: "FREQ=DAILY" })))
      yield* TestClock.adjust(3_600_000)
      const largest = yield* heartbeat(refresh.run(actor, true))
      const [after] = yield* store.collection(sources).list({})
      assert.strictEqual(after?.value.rows, 46 * 63)
      assert.isUndefined(after?.value.error)
      results.push(largest.longest)
      if (process.env.CALENDAR_BENCH === "1") process.stderr.write(`calendar (SQLite): longest stop per refresh ${results.map((r) => r.toFixed(1)).join(", ")} ms (the last: the largest answer, ${46 * 63} rows)\n`)
      for (const r of results) assert.isBelow(r, bound(10), `a refresh held the main thread ${r.toFixed(1)} ms`)
      assert.strictEqual(offThreadWorkers().running, 0)
    })), 120_000)
})
