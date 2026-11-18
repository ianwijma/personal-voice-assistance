// What the scheduler costs the main thread (which also frames audio) on SQLite, at its documented limits: `schedule` (the
// only part on a turn's path: one synchronous transaction) with a 2,000-character payload, a key of 200 and a key that
// replaces a live job; one loop pass with 50 published handlers and 1,000 jobs (nothing due, and claiming as many as
// it may at once); and the retention steps (BULK_STEP_ROWS finished rows of the largest size each). The numbers are
// printed (docs/SCHEDULING.md "Latency" quotes them).
import { assert, describe, it } from "@effect/vitest"
import { BULK_STEP_ROWS, makeIssueRegistry, makeSchedulerEngine, MAX_LIVE_JOBS, MAX_PAYLOAD_CHARS, SCHEDULER_OWNER, jobs, schedulerStorage, withIndexes, type CoreOwner, type SchedulerEngineOptions } from "@pva/core"
import { Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"

/** The longest gap between ticks of a 1 ms timer while `effect` runs (what audio framing would see). */
const longestStop = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 1)
    try {
      const value = yield* effect
      return { value, worst: Math.max(worst, performance.now() - last) }
    } finally {
      clearInterval(timer)
    }
  })

const OWNERS = 5
const HANDLERS_PER_OWNER = 10
const DAY = 24 * 60 * 60 * 1000
const id200 = (s: string) => s.padStart(200, "x")

describe("scheduler latency on SQLite at the limits", () => {
  it.live("schedule is one short transaction; a loop pass over 50 handlers and 1,000 jobs and a retention step hold the main thread briefly", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: join(mkdtempSync(join(tmpdir(), "pva-scheduler-latency-")), "household.db") })
      yield* store.prepare([], [schedulerStorage])
      const passes: Array<{ ms: number; claimed: number }> = []
      const steps: Array<{ ms: number; removed: number }> = []
      const observe: SchedulerEngineOptions["observe"] = (e) => void (e.kind === "pass" ? passes.push({ ms: e.ms, claimed: e.claimed }) : steps.push({ ms: e.ms, removed: e.removed }))
      const engine = yield* makeSchedulerEngine({ store, issues: makeIssueRegistry(), maintenanceMs: 60 * 60 * 1000, observe })
      const owners = Array.from({ length: OWNERS }, (_, o) => engine.forCore(`core.lat${o}` as CoreOwner))
      for (const core of owners) {
        for (let h = 0; h < HANDLERS_PER_OWNER; h++) yield* core.handle(`h${h}`, { payload: Schema.Unknown, run: () => Effect.void })
      }
      const payload = { s: "p".repeat(MAX_PAYLOAD_CHARS - 8) }
      const origin = { assistantId: id200("a"), deviceId: id200("d"), person: { id: id200("p"), how: "device-default" as const } }
      // 1,000 jobs at the limits (200 per owner, the most), due tomorrow; each `schedule` timed (synchronous: its time is
      // how long the main thread is held).
      const times: Array<number> = []
      for (const [o, core] of owners.entries()) {
        for (let i = 0; i < MAX_LIVE_JOBS; i++) {
          const t0 = performance.now()
          yield* core.schedule({ handler: `h${i % HANDLERS_PER_OWNER}`, payload, key: id200(`k${o}.${i}`), origin, inMs: DAY + i })
          times.push(performance.now() - t0)
        }
      }
      const warm = times.slice(50)
      const scheduleWorst = Math.max(...warm)
      const scheduleMedian = [...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)]!
      // Replacing a live job of the same key: the key read, the old job cancelled, the new one written, one transaction.
      const replace: Array<number> = []
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now()
        yield* owners[0]!.schedule({ handler: "h0", payload, key: id200(`k0.${i}`), origin, inMs: DAY + i })
        replace.push(performance.now() - t0)
      }
      const replaceWorst = Math.max(...replace.slice(1))
      yield* engine.settled
      // A pass with nothing due: one indexed read per published handler.
      passes.length = 0
      const idle = yield* longestStop(Effect.gen(function*() {
        for (let i = 0; i < 20; i++) {
          engine.wake()
          yield* engine.settled
        }
      }))
      const idlePasses = passes.filter((p) => p.claimed === 0).map((p) => p.ms)
      // A pass that claims: 40 jobs made due now; it claims as many as may run at once (32) and the rest follow.
      for (const core of owners.slice(0, 2)) {
        const page = yield* core.list({ limit: 20 })
        for (const job of page) yield* core.reschedule(job.id, { inMs: 0 })
      }
      passes.length = 0
      const busy = yield* longestStop(Effect.gen(function*() {
        engine.wake()
        yield* engine.settled
        yield* Effect.sleep(20)
        yield* engine.settled
      }))
      const claiming = passes.filter((p) => p.claimed > 0)
      // Retention: 400 finished rows of the largest size, older than seven days, removed in steps.
      yield* store.transaction((htx) => {
        const c = htx.forCore(SCHEDULER_OWNER).collection(jobs)
        for (let i = 0; i < 400; i++) {
          c.insert(withIndexes({
            module: "core.lat0",
            handler: "h0",
            key: id200(`old${i}`),
            payload,
            state: "failed",
            dueAt: 0,
            late: "run",
            origin,
            attempt: 1,
            lastError: "x".repeat(300),
            failedAt: 0,
            finishedAt: Date.now() - 8 * DAY
          }), { actor: { kind: "admin" } })
        }
      })
      steps.length = 0
      const retention = yield* longestStop(Effect.gen(function*() {
        engine.maintainSoon()
        yield* engine.settled
        yield* Effect.sleep(1_200)
        yield* engine.settled
      }))
      const stepWorst = Math.max(...steps.map((s) => s.ms))
      const lines = [
        `schedule (2,000-character payload, key of 200, ids of 200), ${warm.length} calls: median ${scheduleMedian.toFixed(2)} ms, worst ${scheduleWorst.toFixed(2)} ms`,
        `schedule replacing the live job of its key, 29 calls: worst ${replaceWorst.toFixed(2)} ms`,
        `loop pass, 50 handlers, 1,000 jobs, nothing due, ${idlePasses.length} passes: worst ${Math.max(...idlePasses).toFixed(2)} ms wall (yielding between handlers); longest stop of the event loop ${idle.worst.toFixed(2)} ms`,
        `loop pass claiming ${claiming.map((p) => p.claimed).join(" + ")} of 40 due jobs: worst ${Math.max(...claiming.map((p) => p.ms)).toFixed(2)} ms wall; longest stop ${busy.worst.toFixed(2)} ms`,
        `retention, ${steps.reduce((n, s) => n + s.removed, 0)} rows in ${steps.length} steps of ${BULK_STEP_ROWS}: worst step ${stepWorst.toFixed(2)} ms; longest stop ${retention.worst.toFixed(2)} ms`
      ]
      console.log(`Scheduler latency:\n  ${lines.join("\n  ")}`)
      assert.isTrue(steps.reduce((n, s) => n + s.removed, 0) === 400)
      assert.isTrue(claiming.reduce((n, p) => n + p.claimed, 0) === 40)
      // Bounds with room for a shared machine; the printed numbers are what the docs quote.
      assert.isBelow(scheduleWorst, 15)
      assert.isBelow(replaceWorst, 15)
      assert.isBelow(idle.worst, 15)
      assert.isBelow(busy.worst, 20)
      assert.isBelow(stepWorst, 15)
    })), { timeout: 120_000 })
})
