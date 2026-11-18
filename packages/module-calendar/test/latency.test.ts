// Every test of the calendar module that asserts how long the main thread stops (docs/MODULES.md §15 "Latency
// tests"): this file imports `bound` from packages/store-sqlite/test/latencyBound.ts, so it runs in the latency project,
// alone. Refresh and turn reads are measured on the store the server runs (SQLite, here in memory) rather than the kit's
// in-memory test store, whose every list reads all of a collection's rows (fine for a test, not a latency to measure);
// the reviewer's refresh inputs also in the kit, as the module runs there.
import { assert, describe, it } from "@effect/vitest"
import type { ModuleHostApi } from "@pva/core"
import { makeOfflineNet, offThreadWorkers } from "@pva/core/testing"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { makeSqliteStore } from "../../store-sqlite/src/index.ts"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { ANSWER_BATCH, encodeAnswer, readAnswer } from "../src/answer.ts"
import type { Occ } from "../src/expand.ts"
import { calendarModule, occurrences, sources } from "../src/index.ts"
import { ICS_MAX_BYTES, LIMITS } from "../src/provider.ts"
import { makeReader } from "../src/read.ts"
import { makeRefresh } from "../src/refresh.ts"
import { makeTools } from "../src/tools.ts"
import { advanceAndRefresh, AMS, calendar, FAMILY, familyOnly, heartbeat, ics, served, startCalendar } from "./fixtures.ts"

const bench = (line: string) => {
  if (process.env.CALENDAR_BENCH === "1") process.stderr.write(`${line}\n`)
}

const stateOf = (kit: Effect.Success<ReturnType<typeof startCalendar>>["kit"]) =>
  Effect.map(kit.moduleStore().collection(sources).list({}), (rows) => rows.find((r) => r.value.name === "Family")?.value)
const eventsOf = (value: unknown) => ((value as { events?: Array<{ title: string; time?: string }> }).events ?? []).map((e) => `${e.title}${e.time !== undefined ? ` ${e.time}` : ""}`)
const countRows = (kit: Effect.Success<ReturnType<typeof startCalendar>>["kit"]) =>
  Effect.gen(function*() {
    const store = kit.moduleStore().collection(occurrences)
    let n = 0
    let after: Effect.Success<ReturnType<typeof store.list>>[number] | undefined
    for (;;) {
      const page = yield* store.list({ orderBy: { field: "start" }, limit: 20, ...(after !== undefined ? { after } : {}) })
      n += page.length
      if (page.length < 20) return n
      after = page.at(-1)
    }
  })

/** A calendar module's store on SQLite in memory, its refresh and its tools (as `shared` and `start` make them). */
const onSqlite = (body: () => string) =>
  Effect.gen(function*() {
    yield* TestClock.setTime(Date.UTC(2026, 10, 18, 9, 0))
    const sqlite = yield* makeSqliteStore({ filename: ":memory:" })
    yield* sqlite.prepare([{ id: "calendar", storage: calendarModule.storage! }])
    const store = sqlite.forModule("calendar")
    const net = makeOfflineNet({ "https://cal.example.org/family.ics": () => served(body()) })
    const host = { view: () => ({ home: { HOME_TIME_ZONE: AMS } }), service: () => undefined } as unknown as ModuleHostApi
    const settings = { calendars: [calendar("Family", "https://cal.example.org/family.ics") as never] }
    const refresh = yield* makeRefresh({ store, host, settings }, { resolver: net.resolver, connector: net.connector })
    const { tools, actions } = makeTools(makeReader({ host, store, settings: () => settings, language: () => "en" }))
    return { store, refresh, tools, actions }
  })

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
      let body = large(2_900, "First")
      const { store, refresh } = yield* onSqlite(() => body)
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
      bench(`calendar (SQLite): longest stop per refresh ${results.map((r) => r.toFixed(1)).join(", ")} ms (the last: the largest answer, ${46 * 63} rows)`)
      for (const r of results) assert.isBelow(r, bound(10), `a refresh held the main thread ${r.toFixed(1)} ms`)
      assert.strictEqual(offThreadWorkers().running, 0)
    })), 120_000)
})

describe("calendar: the main thread while a turn reads the calendars, on SQLite (deciding review, finding 7)", () => {
  /** The reviewer's workload: 2,900 half-hour events, 200 a day from 19 November. */
  const workload = ics(Array.from({ length: 2_900 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 19 + Math.floor(i / 200)))
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`
    return { uid: String(i), summary: `Slot ${i}`, start: `${ymd}T090000Z`, end: `${ymd}T093000Z` }
  }))

  it.effect("the agenda over 14 days, 'next' with words that are never found, a search and free time: no stop over the bound", () =>
    Effect.scoped(Effect.gen(function*() {
      const { refresh, tools, actions } = yield* onSqlite(() => workload)
      yield* refresh.run({ kind: "job", jobId: "test" }, true)
      const tool = (name: string) => tools.find((t) => t.name === name)!
      const cases: Array<readonly [string, Effect.Effect<unknown, unknown, never>]> = [
        ["calendar_agenda over 14 days", tool("calendar_agenda").execute({ day: "tomorrow", days: 14 } as never) as never],
        ["calendar_next with words never found", tool("calendar_next").execute({ match: "Never" } as never) as never],
        ["calendar_find", tool("calendar_find").execute({ text: "Never" } as never) as never],
        ["calendar_free", tool("calendar_free").execute({ day: "tomorrow" } as never) as never],
        ["the tomorrow action", actions.find((a) => a.id === "tomorrow")!.run({} as never) as never]
      ]
      const worst = new Map<string, Array<number>>()
      for (let run = 0; run < 4; run++) {
        for (const [name, effect] of cases) {
          const { value, longest } = yield* heartbeat(effect)
          if (name.startsWith("calendar_agenda")) assert.strictEqual((value as { more: number }).more, 2_800 - 12)
          if (name.startsWith("calendar_next")) assert.include((value as { spoken: string }).spoken, "I found nothing called Never up to")
          worst.set(name, [...(worst.get(name) ?? []), longest])
        }
      }
      for (const [name, times] of worst) bench(`calendar (SQLite, turn): ${name}: longest stop ${times.map((t) => t.toFixed(1)).join(", ")} ms`)
      for (const [name, times] of worst) for (const t of times) assert.isBelow(t, bound(10), `${name} held the main thread ${t.toFixed(1)} ms`)
    })), 120_000)
})

describe("calendar: the main thread while the reading task's answer is read", () => {
  const occ = (i: number): Occ => ({
    key: i.toString(16).padStart(24, "0"),
    start: 1_795_000_000_000 + i * 60_000,
    end: 1_795_000_000_000 + i * 60_000 + 1_800_000,
    allDay: false,
    first: 20261119,
    last: 20261119,
    beyond: false,
    // Two-byte text at the bounds: the largest a line can be.
    title: "ŝ".repeat(LIMITS.titleChars),
    location: "ĝ".repeat(LIMITS.placeChars),
    busy: true
  })
  it.effect("the largest legal answer (3,000 occurrences of the longest lines) is read whole, in batches, holding the main thread under the bound", () =>
    Effect.gen(function*() {
      const occurrences = Array.from({ length: LIMITS.occurrences }, (_, i) => occ(i))
      const text = encodeAnswer({ ok: true, occurrences, unreadable: 2 })
      // A two-byte string: twice its length as the helper counts it, under its 4 MiB.
      assert.isAbove(text.length * 2, 2 * 1024 * 1024)
      assert.isBelow(text.length * 2, 4 * 1024 * 1024)
      const timings: Array<number> = []
      for (let k = 0; k < 3; k++) {
        const { value, longest } = yield* heartbeat(readAnswer(text, LIMITS))
        assert.deepStrictEqual(value, { ok: true, occurrences, unreadable: 2 })
        timings.push(longest)
      }
      bench(`calendar: reading ${LIMITS.occurrences} lines (${(text.length * 2 / 1024 / 1024).toFixed(2)} MiB as counted) in batches of ${ANSWER_BATCH}: longest stop ${timings.map((t) => t.toFixed(1)).join(", ")} ms`)
      for (const t of timings) assert.isBelow(t, bound(10), `reading held the main thread ${t.toFixed(1)} ms`)
    }), 60_000)
})

describe("calendar: the main thread while a calendar is read (finding 1)", () => {
  const limit = bound(10)
  it.effect("the reviewer's 1 MiB file of 6,000 events: refused off the main thread, which is never held over the bound", () =>
    Effect.gen(function*() {
      // The author's shape: 6,000 events, one in ten repeating, cut at the size limit (so in the middle of an event).
      const reviewer = ics(Array.from({ length: 6_000 }, (_, i) => ({
        uid: `e${i}`,
        summary: `Event ${i}`,
        start: `202612${String(1 + (i % 28)).padStart(2, "0")}T${String(8 + (i % 10)).padStart(2, "0")}0000`,
        end: `202612${String(1 + (i % 28)).padStart(2, "0")}T${String(9 + (i % 10)).padStart(2, "0")}0000`,
        tz: AMS,
        ...(i % 10 === 0 ? { rrule: "FREQ=DAILY;COUNT=30" } : {}),
        extra: ["DESCRIPTION:" + "d".repeat(60)]
      }))).slice(0, ICS_MAX_BYTES)
      let body = FAMILY
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, familyOnly)
      body = reviewer
      const refused = yield* heartbeat(advanceAndRefresh(kit, 3_600_000))
      // Cut at the size limit in the middle of an event: not a well-formed calendar; the last generation is kept.
      assert.strictEqual((yield* stateOf(kit))!.error, "not-calendar")
      assert.strictEqual(yield* countRows(kit), 12)
      // The whole file (over the size limit) is refused by the fetch; at the size limit but whole, by the event limit.
      body = ics(Array.from({ length: 5_001 }, (_, i) => ({ uid: `e${i}`, summary: `E${i}`, start: "20261201T080000Z" })))
      const many = yield* heartbeat(advanceAndRefresh(kit, 3_600_000))
      assert.strictEqual((yield* stateOf(kit))!.error, "too-many")
      bench(`calendar (kit): longest stop ${refused.longest.toFixed(1)} ms (6,000 events cut off), ${many.longest.toFixed(1)} ms (5,001 events)`)
      assert.isBelow(refused.longest, limit, `the main thread was held ${refused.longest.toFixed(1)} ms`)
      assert.isBelow(many.longest, limit, `the main thread was held ${many.longest.toFixed(1)} ms`)
      assert.strictEqual(offThreadWorkers().running, 0)
    }), 120_000)

  it.effect("the reviewer's impossible rule (30 February every year) runs into the reading's real time limit; the main thread is never held", () =>
    Effect.gen(function*() {
      let body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T140000", end: "20261118T150000", tz: AMS }])
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, { ...familyOnly, deps: { readTimeoutMs: 1_500 } })
      body = ics([{ uid: "never", summary: "Never", start: "20261118T090000Z", rrule: "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30" }])
      const started = performance.now()
      const run = yield* heartbeat(advanceAndRefresh(kit, 3_600_000))
      const took = performance.now() - started
      const state = (yield* stateOf(kit))!
      bench(`calendar: impossible rule ${state.error ?? `read, ${state.unreadable} unreadable`} after ${took.toFixed(0)} ms, longest stop ${run.longest.toFixed(1)} ms`)
      // The library never returns from the rule: the worker is ended at the time limit, the last generation stays.
      assert.strictEqual(state.error, "too-slow")
      const today = (yield* kit.tool("calendar_agenda", {})).value as { stale?: string }
      assert.deepStrictEqual(eventsOf(today), ["Dentist two o'clock"])
      assert.include(today.stale!, "could not be refreshed")
      // Two tries (the job's one retry), each ended at its limit.
      assert.isBelow(took, 2 * (1_500 + bound(500)))
      assert.isBelow(run.longest, limit, `the main thread was held ${run.longest.toFixed(1)} ms`)
      assert.strictEqual(offThreadWorkers().running, 0)
    }), 60_000)
})

