// What the scheduler costs the main thread (which also frames audio) on SQLite, at its documented limits (docs/SCHEDULING.md
// "Latency" quotes the printed numbers). Two kinds of number:
//
// - **longest stop**: the longest gap between ticks of a 1 ms timer while something runs. Whatever holds the main thread
//   in that window (a `schedule`, the only part on a turn's path; a retention transaction; the short holds of a loop
//   pass, which yields between handlers) holds it for at most this long, so it is the bound asserted for blocked time.
//   It also includes garbage collection and whatever else the machine was doing.
// - **wall**: the time around one call or one transaction. It includes waits that do not block: a transaction whose
//   BEGIN finds the write lock taken (the store's checkpoint worker) waits on timers and tries again. Printed, not
//   asserted, except Cron planning, which is pure synchronous work timed directly.
//
// Rows are at the legal maximum: payloads of MAX_PAYLOAD_CHARS of JSON made of unpaired surrogates (six characters
// each), keys of 100, origin ids of 64; the retention rows also carry the costliest failure text, a cron of 100 and a
// zone of 48. Bounds come from `bound()` (a multiple of them on CI).
import { assert, describe, it } from "@effect/vitest"
import {
  type CoreOwner,
  type JobRow,
  jobs,
  makeIssueRegistry,
  makeSchedulerEngine,
  MAX_LIVE_JOBS,
  MAX_PAYLOAD_CHARS,
  RETENTION_STEP_ROWS,
  SCHEDULER_OWNER,
  type SchedulerEngineOptions,
  schedulerStorage,
  storedError,
  withIndexes
} from "@pva/core"
import { Cron, Effect, Result, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"
import { bound } from "./latencyBound.ts"

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
const id64 = (s: string) => s.padStart(64, "x")
const key100 = (s: string) => s.padStart(100, "k")

/** A payload of exactly MAX_PAYLOAD_CHARS of JSON, nearly all unpaired surrogates. */
const worstPayload = () => {
  let text = ""
  while (JSON.stringify({ s: `${text}\ud800` }).length <= MAX_PAYLOAD_CHARS) text += "\ud800"
  return { s: text.padEnd(text.length + MAX_PAYLOAD_CHARS - JSON.stringify({ s: text }).length, "x") }
}

/** The accepted cron expressions that cost `Cron.next` the most (sparse: weekly), and frequent ones, in zones with DST. */
const CRONS = ["59 59 23 * * 6", "59 23 * * 0", "30 2 * * 0", "0 2 * * SUN", "0,15,30,45 0,6,12,18 * * 1-5", "*/10 * * * * *", "0 7 * * 1-5", "30 2 * * *"]
const ZONES = ["Europe/Amsterdam", "America/New_York", "Australia/Lord_Howe", "Pacific/Chatham"]
/** Planning from ordinary days and from just before the spring and autumn changes. */
const FROMS = ["2026-11-18T12:00:00Z", "2026-03-29T00:59:59Z", "2026-10-25T00:59:00Z", "2026-04-05T01:00:00Z", "2026-09-27T01:30:00Z"].map(Date.parse)

describe("scheduler latency on SQLite at the limits", () => {
  it.live("schedule is one short transaction; a loop pass over 50 handlers and 1,000 jobs and a retention step hold the main thread briefly", () =>
    Effect.scoped(Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: join(mkdtempSync(join(tmpdir(), "pva-scheduler-latency-")), "household.db") })
      yield* store.prepare([], [schedulerStorage])
      const passes: Array<{ ms: number; claimed: number; handlers: number }> = []
      const steps: Array<{ ms: number; removed: number }> = []
      const observe: SchedulerEngineOptions["observe"] = (e) => void (e.kind === "pass" ? passes.push({ ms: e.ms, claimed: e.claimed, handlers: e.handlers }) : steps.push({ ms: e.ms, removed: e.removed }))
      const engine = yield* makeSchedulerEngine({ store, issues: makeIssueRegistry(), maintenanceMs: 60 * 60 * 1000, observe })
      const owners = Array.from({ length: OWNERS }, (_, o) => engine.forCore(`core.lat${o}` as CoreOwner))
      for (const core of owners) {
        for (let h = 0; h < HANDLERS_PER_OWNER; h++) yield* core.handle(`h${h}`, { payload: Schema.Unknown, run: () => Effect.void })
      }
      const payload = worstPayload()
      const origin = { assistantId: id64("a"), deviceId: id64("d"), person: { id: id64("p"), how: "device-default" as const, confidence: 0.123456789 } }
      // 1,000 jobs at the limits (200 per owner, the most), due tomorrow; each `schedule` timed. The first 50 warm up
      // (code paths compiled, the codecs built) outside the timed window.
      const WARM_UP = 50
      const times: Array<number> = []
      const scheduleOne = (o: number, i: number) =>
        Effect.gen(function*() {
          const t0 = performance.now()
          yield* owners[o]!.schedule({ handler: `h${i % HANDLERS_PER_OWNER}`, payload, key: key100(`k${o}.${i}`), origin, inMs: DAY + i })
          times.push(performance.now() - t0)
          // A turn's schedule comes between other work: let the timer tick (the stop is then this call's).
          yield* Effect.yieldNow
        })
      for (let i = 0; i < WARM_UP; i++) yield* scheduleOne(0, i)
      const scheduling = yield* longestStop(Effect.gen(function*() {
        for (let o = 0; o < OWNERS; o++) {
          for (let i = o === 0 ? WARM_UP : 0; i < MAX_LIVE_JOBS; i++) yield* scheduleOne(o, i)
        }
      }))
      const warm = times.slice(WARM_UP)
      const scheduleWorst = Math.max(...warm)
      const scheduleMedian = [...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)]!
      // Replacing a live job of the same key: the key read, the old job cancelled, the new one written, one transaction.
      const replace: Array<number> = []
      const replacing = yield* longestStop(Effect.gen(function*() {
        for (let i = 0; i < 30; i++) {
          const t0 = performance.now()
          yield* owners[0]!.schedule({ handler: "h0", payload, key: key100(`k0.${i}`), origin, inMs: DAY + i })
          replace.push(performance.now() - t0)
          yield* Effect.yieldNow
        }
      }))
      const replaceWorst = Math.max(...replace.slice(1))
      // Cron planning (Cron.next, inside `schedule`): the worst accepted expressions, from dates at the DST changes,
      // warmed first; then `schedule` with each of them in each zone (another owner, cancelled again).
      const plan: Array<number> = []
      for (let round = 0; round < 2; round++) {
        for (const expr of CRONS) {
          for (const zone of ZONES) {
            const cron = Cron.parse(expr, zone)
            assert.isTrue(Result.isSuccess(cron), `${expr} ${zone}`)
            for (const from of FROMS) {
              const t0 = performance.now()
              Cron.next((cron as Result.Success<Cron.Cron, never>).success, new Date(from))
              Cron.prev((cron as Result.Success<Cron.Cron, never>).success, new Date(from))
              if (round === 1) plan.push(performance.now() - t0)
            }
          }
        }
      }
      const planWorst = Math.max(...plan)
      const cronOwner = engine.forCore("core.cron")
      const cronSchedule: Array<number> = []
      for (let round = 0; round < 2; round++) {
        for (const expr of CRONS) {
          for (const zone of ZONES) {
            const t0 = performance.now()
            const job = yield* cronOwner.schedule({ handler: "none", payload, key: key100(`${expr}${zone}`.replace(/[^A-Za-z0-9]/g, "")), origin, cron: expr, timeZone: zone })
            if (round === 1) cronSchedule.push(performance.now() - t0)
            yield* cronOwner.cancel(job.id)
          }
        }
      }
      const cronWorst = Math.max(...cronSchedule)
      // A refused date expression costs nothing: it is refused before it is parsed.
      const refusedT0 = performance.now()
      const refused = yield* Effect.exit(cronOwner.schedule({ handler: "none", cron: "0 0 31 2 *", timeZone: "Europe/Amsterdam" }))
      const refusedMs = performance.now() - refusedT0
      assert.strictEqual(refused._tag, "Failure")
      yield* engine.settled
      // Passes with nothing due: one indexed read per published handler.
      passes.length = 0
      const idle = yield* longestStop(Effect.gen(function*() {
        for (let i = 0; i < 20; i++) {
          engine.wake()
          yield* engine.settled
        }
      }))
      const idlePasses = passes.filter((p) => p.claimed === 0)
      // Every wake made a pass over all 50 handlers (a public `wake` that did nothing would leave this empty).
      assert.isAtLeast(idlePasses.length, 20)
      assert.isTrue(idlePasses.every((p) => p.handlers === OWNERS * HANDLERS_PER_OWNER && Number.isFinite(p.ms)))
      const idleWorst = Math.max(...idlePasses.map((p) => p.ms))
      // A pass that claims: 40 jobs made due now; it claims as many as may run at once (32) and the rest follow.
      for (const core of owners.slice(0, 2)) {
        let after: JobRow | undefined
        for (let n = 0; n < 20;) {
          const page = yield* core.list(after !== undefined ? { after } : {})
          for (const job of page.slice(0, 20 - n)) yield* core.reschedule(job.id, { inMs: 0 })
          n += page.length
          after = page[page.length - 1]
        }
      }
      passes.length = 0
      const busy = yield* longestStop(Effect.gen(function*() {
        engine.wake()
        yield* engine.settled
        yield* Effect.sleep(20)
        yield* engine.settled
      }))
      const claiming = passes.filter((p) => p.claimed > 0)
      // Retention: 400 failed rows with the payload, key, ids, cron, zone and failure text at their longest, older than
      // seven days, removed in steps. (Not quite the largest finished row: a cancelled retry also keeps its occurrence
      // time, and a person's confidence can be a longer number.)
      const failure = storedError(`${'"\\'.repeat(300)}${"\udfff".repeat(300)}`)
      const fixture = withIndexes({
        module: "m".repeat(40),
        handler: `h${"h".repeat(63)}`,
        key: key100("old"),
        payload,
        state: "failed",
        dueAt: 8.64e15,
        cron: `${"0,".repeat(47)}0 * * * *`.slice(0, 100),
        timeZone: "z".repeat(48),
        late: { withinMs: 8.64e15 },
        origin,
        attempt: 11,
        lastError: failure,
        failedAt: 8.64e15,
        finishedAt: Date.now() - 8 * DAY
      })
      const fixtureChars = JSON.stringify(fixture).length
      yield* store.transaction((htx) => {
        const c = htx.forCore(SCHEDULER_OWNER).collection(jobs)
        for (let i = 0; i < 400; i++) c.insert({ ...fixture, key: key100(`old${i}`) }, { actor: { kind: "admin" } })
      })
      steps.length = 0
      const retention = yield* longestStop(Effect.gen(function*() {
        engine.maintainSoon()
        yield* engine.settled
        yield* Effect.sleep(1_200)
        yield* engine.settled
      }))
      const removing = steps.filter((s) => s.removed > 0)
      const stepWorst = Math.max(...removing.map((s) => s.ms))
      const lines = [
        `schedule (payload of ${MAX_PAYLOAD_CHARS} JSON characters of escapes, key of 100, ids of 64), ${warm.length} calls after ${WARM_UP} to warm up: longest stop ${scheduling.worst.toFixed(2)} ms; wall per call median ${scheduleMedian.toFixed(2)} ms, worst ${scheduleWorst.toFixed(2)} ms`,
        `schedule replacing the live job of its key, 30 calls: longest stop ${replacing.worst.toFixed(2)} ms; wall worst ${replaceWorst.toFixed(2)} ms`,
        `cron planning (Cron.next and Cron.prev, ${CRONS.length} expressions x ${ZONES.length} zones x ${FROMS.length} dates), synchronous: worst ${planWorst.toFixed(3)} ms; schedule with a cron, ${cronSchedule.length} calls: wall worst ${cronWorst.toFixed(2)} ms; a refused date ${refusedMs.toFixed(2)} ms`,
        `loop pass, 50 handlers, 1,000 jobs, nothing due, ${idlePasses.length} passes: worst ${idleWorst.toFixed(2)} ms wall (yielding between handlers); longest stop ${idle.worst.toFixed(2)} ms`,
        `loop pass claiming ${claiming.map((p) => p.claimed).join(" + ")} of 40 due jobs: worst ${Math.max(...claiming.map((p) => p.ms)).toFixed(2)} ms wall; longest stop ${busy.worst.toFixed(2)} ms`,
        `retention, ${removing.reduce((n, s) => n + s.removed, 0)} failed rows of ${fixtureChars} characters (every text field at its longest) in ${removing.length} transactions of ${RETENTION_STEP_ROWS}: longest stop over the passes (with the recovery rule, the recount and the issues) ${retention.worst.toFixed(2)} ms; wall per transaction worst ${stepWorst.toFixed(2)} ms`
      ]
      console.log(`Scheduler latency:\n  ${lines.join("\n  ")}`)
      assert.isAtLeast(fixtureChars, 2_100)
      assert.strictEqual(removing.reduce((n, s) => n + s.removed, 0), 400)
      assert.isTrue(removing.every((s) => s.removed <= RETENTION_STEP_ROWS))
      assert.strictEqual(claiming.reduce((n, p) => n + p.claimed, 0), 40)
      // Blocked time, bounded by the longest stop of each window (which also holds GC and the machine's other work), and
      // Cron planning on its own.
      assert.isBelow(planWorst, bound(2))
      for (const [what, stop] of [["schedule", scheduling.worst], ["replace", replacing.worst], ["idle", idle.worst], ["claiming", busy.worst], ["retention", retention.worst]] as const) {
        assert.isBelow(stop, bound(15), what)
      }
    })), { timeout: 120_000 })
})
