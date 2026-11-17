/**
 * The contract every scheduler passes (`@pva/core/scheduler-contract`): the test double (`makeTestScheduler`, on the
 * in-memory store) and serve mode's (the same engine on the SQLite store's `core_scheduler__jobs`) run the same tests,
 * on the test clock. Test-only: imports vitest.
 */
import { assert, describe, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Exit, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { defineCollection, type HouseholdStore, type ModuleStorage } from "./HouseholdStore.ts"
import { makeIssueRegistry } from "./Issues.ts"
import type { JobTable } from "./JobTable.ts"
import type { JobRow, NotificationDelivery, NotificationRequest } from "./Scheduler.ts"
import { makeTestScheduler } from "./testing.ts"
import { CurrentTurn } from "./TurnContext.ts"

/** A fresh store (prepared for `CONTRACT_MODULES`) and the job table on it. */
export type MakeJobStore = () => Effect.Effect<{ readonly store: HouseholdStore; readonly table: JobTable }, unknown, Scope.Scope>

const Timer = Schema.Struct({ label: Schema.String })
export const timers = defineCollection({ name: "timers", scope: "household", schema: Timer })
export const CONTRACT_MODULES: ReadonlyArray<{ readonly id: string; readonly storage: ModuleStorage }> = [
  { id: "tm", storage: { collections: [timers] } },
  { id: "other", storage: { collections: [] } }
]

const MIN = 60_000
const HOUR = 60 * MIN
const settle = Effect.repeat(Effect.yieldNow, { times: 50 })
const advance = (ms: number) => Effect.andThen(settle, Effect.andThen(TestClock.adjust(ms), settle))

const ring = (title: string): NotificationRequest => ({ kind: "timer", priority: "high", content: { title } })

const Payload = Schema.Struct({ n: Schema.Finite })

export const schedulerContract = (name: string, make: MakeJobStore) =>
  describe(`Scheduler contract: ${name}`, () => {
    /** An engine in its own scope (closed to simulate a crash or a restart). */
    const engine = (table: JobTable, extra: { readonly delivery?: NotificationDelivery; readonly timeZone?: string; readonly jumpCheckMs?: number } = {}) =>
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const issues = makeIssueRegistry()
        const made = yield* makeTestScheduler({ table, issues, jumpCheckMs: 5 * MIN, modules: () => [{ id: "tm", name: "Timers" }, { id: "other", name: "Other" }], ...extra }).pipe(Scope.provide(scope))
        return { ...made, issues, scope, tm: made.scheduler.forModule("tm"), close: Scope.close(scope, Exit.void) }
      })

    it.effect("a notify job fires at its due time, not before, and is recorded on its row", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const job = yield* s.tm.schedule({ kind: "timer", key: "timer:pasta", label: "Pasta", when: { inMs: 10 * MIN }, onDue: { notify: ring("Pasta is done") } })
        assert.strictEqual(job.state, "scheduled")
        assert.strictEqual(job.dueAt, 10 * MIN)
        yield* advance(10 * MIN - 1)
        assert.strictEqual(s.deliveries.length, 0)
        yield* advance(1)
        assert.strictEqual(s.deliveries.length, 1)
        assert.strictEqual(s.deliveries[0]!.info.notificationId, `${job.id}@${10 * MIN}`)
        assert.strictEqual(s.deliveries[0]!.info.lateByMs, 0)
        assert.deepStrictEqual(s.deliveries[0]!.request.source, { module: "tm", jobId: job.id })
        const after = yield* s.tm.get(job.id)
        assert.strictEqual(after?.state, "done")
        assert.strictEqual(after?.delivered?.notificationId, `${job.id}@${10 * MIN}`)
        yield* s.close
      }))

    it.effect("several jobs due together fire in due-time order, each once", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        yield* s.tm.schedule({ kind: "timer", when: { at: 3 * MIN }, onDue: { notify: ring("c") } })
        yield* s.tm.schedule({ kind: "timer", when: { at: 1 * MIN }, onDue: { notify: ring("a") } })
        yield* s.tm.schedule({ kind: "timer", when: { at: 2 * MIN }, onDue: { notify: ring("b") } })
        yield* s.close
        // Down past all three; the next start fires them in order.
        yield* TestClock.adjust(4 * MIN)
        const again = yield* engine(table)
        yield* settle
        assert.deepStrictEqual(again.deliveries.map((d) => d.request.content.title), ["a", "b", "c"])
        yield* advance(HOUR)
        assert.strictEqual(again.deliveries.length, 3)
        yield* again.close
      }))

    it.effect("scheduling the same key again replaces the live job", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const first = yield* s.tm.schedule({ kind: "timer", key: "timer:tea", when: { inMs: MIN }, onDue: { notify: ring("first") } })
        const second = yield* s.tm.schedule({ kind: "timer", key: "timer:tea", when: { inMs: 2 * MIN }, onDue: { notify: ring("second") } })
        assert.strictEqual((yield* s.tm.get(first.id))?.state, "cancelled")
        const live = yield* s.tm.list({ key: "timer:tea" })
        assert.deepStrictEqual(live.map((j) => j.id), [second.id])
        // Another module's key is its own.
        yield* s.scheduler.forModule("other").schedule({ kind: "timer", key: "timer:tea", when: { inMs: MIN }, onDue: { notify: ring("other") } })
        assert.strictEqual((yield* s.tm.list()).length, 1)
        yield* advance(3 * MIN)
        assert.deepStrictEqual(s.deliveries.map((d) => d.request.content.title).sort(), ["other", "second"])
        yield* s.close
      }))

    it.effect("a handler that schedules its own successor under its key (an RRULE's next occurrence) finishes done", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const seen: Array<number> = []
        yield* s.tm.handle("remind", Payload, (p, due) =>
          Effect.andThen(
            Effect.sync(() => seen.push(due.dueAt)),
            Effect.asVoid(s.tm.schedule({ kind: "reminder", key: "reminder:r1", when: { at: due.dueAt + HOUR }, onDue: { handler: "remind", payload: p }, idempotent: true }))
          )).pipe(Scope.provide(s.scope))
        const first = yield* s.tm.schedule({ kind: "reminder", key: "reminder:r1", when: { at: HOUR }, onDue: { handler: "remind", payload: { n: 1 } }, idempotent: true })
        yield* advance(3 * HOUR)
        assert.deepStrictEqual(seen, [HOUR, 2 * HOUR, 3 * HOUR])
        const done = yield* s.tm.get(first.id)
        assert.strictEqual(done?.state, "done")
        assert.strictEqual(done?.key, undefined)
        const live = yield* s.tm.list({ key: "reminder:r1" })
        assert.deepStrictEqual(live.map((j) => [j.state, j.dueAt]), [["scheduled", 4 * HOUR]])
        yield* s.close
      }))

    it.effect("pause keeps the time left; resume, reschedule and cancel", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const job = yield* s.tm.schedule({ kind: "timer", when: { inMs: 10 * MIN }, onDue: { notify: ring("t") } })
        yield* advance(4 * MIN)
        const paused = yield* s.tm.pause(job.id)
        assert.strictEqual(paused.state, "paused")
        assert.strictEqual(paused.remainingMs, 6 * MIN)
        assert.strictEqual(paused.dueAt, undefined)
        yield* advance(HOUR)
        assert.strictEqual(s.deliveries.length, 0)
        const resumed = yield* s.tm.resume(job.id)
        assert.strictEqual(resumed.dueAt, 4 * MIN + HOUR + 6 * MIN)
        // "Add five minutes".
        const moved = yield* s.tm.reschedule(job.id, { at: resumed.dueAt! + 5 * MIN })
        assert.strictEqual(moved.dueAt, 4 * MIN + HOUR + 11 * MIN)
        yield* advance(10 * MIN)
        assert.strictEqual(s.deliveries.length, 0)
        yield* advance(MIN)
        assert.strictEqual(s.deliveries.length, 1)
        // A job that fired can be scheduled again; a cancelled one does not fire.
        const again = yield* s.tm.reschedule(job.id, { inMs: MIN })
        assert.strictEqual(again.state, "scheduled")
        yield* s.tm.cancel(job.id)
        yield* advance(2 * MIN)
        assert.strictEqual(s.deliveries.length, 1)
        assert.strictEqual((yield* s.tm.get(job.id))?.state, "cancelled")
        // Errors a module can word.
        const notMine = yield* Effect.flip(s.scheduler.forModule("other").cancel(job.id))
        assert.strictEqual(notMine.reason, "not_found")
        const resumeLive = yield* Effect.flip(s.tm.resume((yield* s.tm.schedule({ kind: "timer", when: { inMs: MIN }, onDue: { notify: ring("x") } })).id))
        assert.strictEqual(resumeLive.reason, "state")
        const bad = yield* Effect.flip(s.tm.schedule({ kind: "alarm", when: { cron: "61 7 * * *" }, onDue: { notify: ring("x") } }))
        assert.strictEqual(bad.reason, "invalid")
        yield* s.close
      }))

    it.effect("a transaction that rolls back takes its job with it; one that commits keeps both", () =>
      Effect.gen(function*() {
        const { store, table } = yield* make()
        const s = yield* engine(table)
        const data = store.forModule("tm")
        const failed = yield* Effect.exit(data.transaction(Effect.gen(function*() {
          yield* data.collection(timers).insert({ label: "pasta" })
          yield* s.tm.schedule({ kind: "timer", key: "timer:pasta", when: { inMs: MIN }, onDue: { notify: ring("pasta") } })
          return yield* Effect.fail("the module changed its mind")
        })))
        assert.isTrue(Exit.isFailure(failed))
        assert.strictEqual((yield* data.collection(timers).list()).length, 0)
        assert.strictEqual((yield* s.tm.list({ states: "all" })).length, 0)
        yield* data.transaction(Effect.gen(function*() {
          yield* data.collection(timers).insert({ label: "rice" })
          yield* s.tm.schedule({ kind: "timer", key: "timer:rice", when: { inMs: MIN }, onDue: { notify: ring("rice") } })
        }))
        assert.strictEqual((yield* data.collection(timers).list()).length, 1)
        assert.strictEqual((yield* s.tm.list()).length, 1)
        yield* advance(MIN)
        assert.deepStrictEqual(s.deliveries.map((d) => d.request.content.title), ["rice"])
        yield* s.close
      }))

    it.effect("every missed policy across a restart, and a recurring job that missed several occurrences", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const at = { at: MIN }
        const late = yield* s.tm.schedule({ kind: "timer", label: "fire-late", when: at, onDue: { notify: ring("fire-late") }, missed: "fire-late" })
        const within = yield* s.tm.schedule({ kind: "alarm", label: "within", when: at, onDue: { notify: ring("within") }, missed: { fireIfWithinMs: HOUR } })
        const tooLate = yield* s.tm.schedule({ kind: "alarm", label: "too-late", when: at, onDue: { notify: ring("too-late") }, missed: { fireIfWithinMs: 15 * MIN } })
        const toInbox = yield* s.tm.schedule({ kind: "alarm", label: "otherwise", when: at, onDue: { notify: ring("otherwise") }, missed: { fireIfWithinMs: 15 * MIN, otherwise: "inbox" } })
        const skip = yield* s.tm.schedule({ kind: "deferred", label: "skip", when: at, onDue: { notify: ring("skip") }, missed: "skip" })
        const inbox = yield* s.tm.schedule({ kind: "reminder", label: "inbox", when: at, onDue: { notify: ring("inbox") }, missed: "inbox" })
        const every = yield* s.tm.schedule({ kind: "recurring", label: "every 5", when: { cron: "*/5 * * * *", timeZone: "UTC" }, onDue: { notify: ring("every") } })
        assert.strictEqual(every.dueAt, 5 * MIN)
        yield* s.close
        yield* TestClock.adjust(31 * MIN)
        const again = yield* engine(table)
        yield* settle
        const byTitle = new Map(again.deliveries.map((d) => [d.request.content.title, d]))
        assert.deepStrictEqual([...byTitle.keys()].sort(), ["every", "fire-late", "inbox", "otherwise", "within"])
        assert.strictEqual(byTitle.get("fire-late")!.info.lateByMs, 30 * MIN)
        assert.isFalse(byTitle.get("fire-late")!.info.inbox)
        assert.isTrue(byTitle.get("inbox")!.info.inbox)
        assert.isTrue(byTitle.get("otherwise")!.info.inbox)
        const state = (j: JobRow) => Effect.map(again.tm.get(j.id), (r) => r?.state)
        assert.strictEqual(yield* state(late), "done")
        assert.strictEqual(yield* state(within), "done")
        assert.strictEqual(yield* state(tooLate), "missed")
        assert.strictEqual(yield* state(toInbox), "missed")
        assert.strictEqual(yield* state(skip), "missed")
        assert.strictEqual(yield* state(inbox), "missed")
        // The recurring job ran its last missed occurrence (30 min) once and moved on to 35 min.
        assert.strictEqual(byTitle.get("every")!.info.notificationId, `${every.id}@${30 * MIN}`)
        assert.strictEqual(byTitle.get("every")!.info.lateByMs, MIN)
        const moved = yield* again.tm.get(every.id)
        assert.strictEqual(moved?.state, "scheduled")
        assert.strictEqual(moved?.dueAt, 35 * MIN)
        assert.strictEqual(moved?.skipped, 5)
        yield* advance(4 * MIN)
        assert.strictEqual(again.deliveries.filter((d) => d.request.content.title === "every").length, 2)
        yield* again.close
      }))

    it.effect("a recurring job with skip does not run a missed occurrence and moves on", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const job = yield* s.tm.schedule({ kind: "recurring", when: { cron: "0 * * * *", timeZone: "UTC" }, onDue: { notify: ring("hourly") }, missed: "skip" })
        yield* s.close
        yield* TestClock.adjust(5 * HOUR + 30 * MIN)
        const again = yield* engine(table)
        yield* settle
        assert.strictEqual(again.deliveries.length, 0)
        assert.strictEqual((yield* again.tm.get(job.id))?.dueAt, 6 * HOUR)
        yield* advance(30 * MIN)
        assert.strictEqual(again.deliveries.length, 1)
        yield* again.close
      }))

    it.effect("a crash between claim and completion: an idempotent handler runs again, another fails, a notification is redelivered under its id", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const stuck: NotificationDelivery = { deliver: () => Effect.never }
        const s = yield* engine(table, { delivery: stuck })
        const started: Array<string> = []
        yield* s.tm.handle("ramp", Payload, (p, due) => Effect.andThen(Effect.sync(() => started.push(`${p.n}:${due.attempt}`)), Effect.never)).pipe(Scope.provide(s.scope))
        const idem = yield* s.tm.schedule({ kind: "alarm", when: { inMs: MIN }, onDue: { handler: "ramp", payload: { n: 1 } }, idempotent: true })
        const once = yield* s.tm.schedule({ kind: "alarm", when: { inMs: MIN }, onDue: { handler: "ramp", payload: { n: 2 } } })
        const note = yield* s.tm.schedule({ kind: "timer", when: { inMs: MIN }, onDue: { notify: ring("note") } })
        yield* advance(MIN)
        assert.deepStrictEqual(started.sort(), ["1:1", "2:1"])
        assert.strictEqual((yield* s.tm.get(idem.id))?.state, "running")
        assert.strictEqual((yield* s.tm.get(note.id))?.state, "running")
        yield* s.close
        // The next start.
        const again = yield* engine(table)
        const ran: Array<string> = []
        yield* again.tm.handle("ramp", Payload, (p, due) => Effect.sync(() => ran.push(`${p.n}:${due.attempt}:${due.occurrenceKey}`))).pipe(Scope.provide(again.scope))
        yield* settle
        assert.deepStrictEqual(ran, [`1:2:${idem.id}@${MIN}`])
        assert.strictEqual((yield* again.tm.get(idem.id))?.state, "done")
        const failed = yield* again.tm.get(once.id)
        assert.strictEqual(failed?.state, "failed")
        assert.match(failed?.lastError ?? "", /restart/)
        assert.isTrue(again.issues.all().some((i) => i.id === `core.scheduler.failed.${once.id}` && i.module === "tm"))
        assert.deepStrictEqual(again.deliveries.map((d) => d.info.notificationId), [`${note.id}@${MIN}`])
        assert.strictEqual((yield* again.tm.get(note.id))?.state, "done")
        yield* again.close
      }))

    it.effect("a failing idempotent handler is retried with back-off up to its limit; any other fails at once", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const runs: Array<number> = []
        yield* s.tm.handle("flaky", Payload, () => Effect.andThen(Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => runs.push(t))), Effect.fail(new Error("no network")))).pipe(Scope.provide(s.scope))
        const idem = yield* s.tm.schedule({ kind: "deferred", when: { at: MIN }, onDue: { handler: "flaky", payload: { n: 1 } }, idempotent: true, retryLimit: 2 })
        yield* advance(MIN)
        assert.deepStrictEqual(runs, [MIN])
        const retrying = yield* s.tm.get(idem.id)
        assert.strictEqual(retrying?.state, "scheduled")
        assert.strictEqual(retrying?.occurrenceAt, MIN)
        assert.strictEqual(retrying?.lastError, "no network")
        yield* advance(5_000)
        yield* advance(10_000)
        assert.deepStrictEqual(runs, [MIN, MIN + 5_000, MIN + 15_000])
        const failed = yield* s.tm.get(idem.id)
        assert.strictEqual(failed?.state, "failed")
        assert.strictEqual(failed?.attempts, 3)
        yield* advance(HOUR)
        assert.strictEqual(runs.length, 3)
        runs.length = 0
        const once = yield* s.tm.schedule({ kind: "deferred", when: { inMs: MIN }, onDue: { handler: "flaky", payload: { n: 2 } } })
        yield* advance(HOUR)
        assert.strictEqual(runs.length, 1)
        assert.strictEqual((yield* s.tm.get(once.id))?.state, "failed")
        assert.isTrue(s.issues.all().some((i) => i.id === `core.scheduler.failed.${once.id}`))
        // A payload that does not match the handler's schema fails without a retry.
        const bad = yield* s.tm.schedule({ kind: "deferred", when: { inMs: MIN }, onDue: { handler: "flaky", payload: { n: "x" } }, idempotent: true })
        yield* advance(HOUR)
        assert.strictEqual(runs.length, 1)
        assert.match((yield* s.tm.get(bad.id))?.lastError ?? "", /schema/)
        // The admin page dismisses a failed job.
        assert.isTrue(yield* s.scheduler.cancelAny(once.id))
        yield* settle
        assert.isFalse(s.issues.all().some((i) => i.id === `core.scheduler.failed.${once.id}`))
        yield* s.close
      }))

    it.effect("a recurring job whose handler fails moves on to its next occurrence and shows the failure", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        let fail = true
        yield* s.tm.handle("refresh", Payload, () => (fail ? Effect.fail(new Error("feed down")) : Effect.void)).pipe(Scope.provide(s.scope))
        const job = yield* s.tm.schedule({ kind: "recurring", when: { cron: "*/15 * * * *", timeZone: "UTC" }, onDue: { handler: "refresh", payload: { n: 0 } } })
        yield* advance(15 * MIN)
        const after = yield* s.tm.get(job.id)
        assert.strictEqual(after?.state, "scheduled")
        assert.strictEqual(after?.dueAt, 30 * MIN)
        assert.strictEqual(after?.lastError, "feed down")
        assert.isTrue(s.issues.all().some((i) => i.id === `core.scheduler.failed.${job.id}`))
        fail = false
        yield* advance(15 * MIN)
        assert.strictEqual((yield* s.tm.get(job.id))?.lastFailedAt, undefined)
        assert.isFalse(s.issues.all().some((i) => i.id === `core.scheduler.failed.${job.id}`))
        yield* s.close
      }))

    it.effect("a handler registered late: the job waits (shown), then fires subject to its missed policy", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const soon = yield* s.tm.schedule({ kind: "alarm", label: "soon", when: { inMs: MIN }, onDue: { handler: "ring", payload: { n: 1 } } })
        const strict = yield* s.tm.schedule({ kind: "alarm", label: "strict", when: { inMs: MIN }, onDue: { handler: "ring", payload: { n: 2 } }, missed: { fireIfWithinMs: 2 * MIN } })
        const note = yield* s.tm.schedule({ kind: "timer", when: { inMs: MIN }, onDue: { notify: ring("still rings") } })
        yield* advance(MIN)
        assert.isTrue((yield* s.tm.get(soon.id))?.waiting)
        assert.strictEqual((yield* s.tm.get(note.id))?.state, "done")
        assert.isTrue(s.issues.all().some((i) => i.id === "core.scheduler.waiting.tm"))
        const counts = yield* s.scheduler.counts
        assert.strictEqual(counts.waiting, 2)
        yield* advance(5 * MIN)
        const ran: Array<{ n: number; late: number }> = []
        yield* s.tm.handle("ring", Payload, (p, due) => Effect.sync(() => ran.push({ n: p.n, late: due.lateByMs }))).pipe(Scope.provide(s.scope))
        yield* settle
        assert.deepStrictEqual(ran, [{ n: 1, late: 5 * MIN }])
        assert.strictEqual((yield* s.tm.get(strict.id))?.state, "missed")
        assert.isFalse(s.issues.all().some((i) => i.id === "core.scheduler.waiting.tm"))
        yield* s.close
      }))

    it.effect("a new generation of a shared part replaces a handler without a double fire", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const calls: Array<string> = []
        const gen1 = yield* Scope.make()
        yield* s.tm.handle("ring", Payload, () => Effect.sync(() => calls.push("gen1"))).pipe(Scope.provide(gen1))
        const gen2 = yield* Scope.make()
        yield* s.tm.handle("ring", Payload, () => Effect.sync(() => calls.push("gen2"))).pipe(Scope.provide(gen2))
        yield* s.tm.schedule({ kind: "alarm", when: { inMs: MIN }, onDue: { handler: "ring", payload: { n: 1 } } })
        yield* advance(MIN)
        // The old generation retires after its grace period: nothing it registered is live any more.
        yield* Scope.close(gen1, Exit.void)
        yield* s.tm.schedule({ kind: "alarm", when: { inMs: MIN }, onDue: { handler: "ring", payload: { n: 2 } } })
        yield* advance(MIN)
        assert.deepStrictEqual(calls, ["gen2", "gen2"])
        yield* Scope.close(gen2, Exit.void)
        yield* s.close
      }))

    it.effect("a wall-clock jump forwards fires what is now due; a jump back delays it to its wall-clock time", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const base = (yield* Effect.clockWith(Effect.succeed)) as TestClock.TestClock
        // The test clock moved directly (`TestClock.adjust` would find the wrapper below).
        const move = (ms: number) => Effect.andThen(settle, Effect.andThen(base.adjust(ms), settle))
        const offset = { ms: 0 }
        const jumpy: Clock.Clock = {
          currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() + offset.ms,
          currentTimeMillis: Effect.sync(() => base.currentTimeMillisUnsafe() + offset.ms),
          currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe() + BigInt(offset.ms) * 1_000_000n,
          currentTimeNanos: Effect.sync(() => base.currentTimeNanosUnsafe() + BigInt(offset.ms) * 1_000_000n),
          monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: base.monotonicTimeNanos,
          sleep: (d) => base.sleep(d)
        }
        yield* Effect.gen(function*() {
          const s = yield* engine(table, { jumpCheckMs: 10_000 })
          yield* s.tm.schedule({ kind: "timer", when: { at: HOUR }, onDue: { notify: ring("forward") } })
          yield* move(MIN)
          offset.ms = HOUR // NTP set the clock an hour forward
          yield* move(10_000)
          assert.deepStrictEqual(s.deliveries.map((d) => d.request.content.title), ["forward"])
          const back = yield* s.tm.schedule({ kind: "timer", when: { inMs: 10 * MIN }, onDue: { notify: ring("back") } })
          offset.ms = 0 // and back again
          yield* move(10 * MIN)
          assert.strictEqual(s.deliveries.length, 1)
          assert.strictEqual((yield* s.tm.get(back.id))?.state, "scheduled")
          yield* move(HOUR)
          assert.strictEqual(s.deliveries.length, 2)
          yield* s.close
        }).pipe(Effect.provideService(Clock.Clock, jumpy))
      }))

    it.effect("a cron job keeps 7:00 in Europe/Amsterdam across both daylight-saving changes", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        yield* TestClock.setTime(Date.parse("2026-03-27T12:00:00Z"))
        const s = yield* engine(table, { timeZone: "Europe/Amsterdam" })
        const fired: Array<string> = []
        yield* s.tm.handle("wake", Payload, (_p, due) => Effect.sync(() => fired.push(new Date(due.dueAt).toISOString()))).pipe(Scope.provide(s.scope))
        const job = yield* s.tm.schedule({ kind: "alarm", when: { cron: "0 7 * * *" }, onDue: { handler: "wake", payload: { n: 0 } } })
        assert.strictEqual(job.timeZone, undefined) // HOME_TIME_ZONE, read at each computation
        yield* advance(3 * 24 * HOUR)
        assert.deepStrictEqual(fired, ["2026-03-28T06:00:00.000Z", "2026-03-29T05:00:00.000Z", "2026-03-30T05:00:00.000Z"])
        // An explicit zone works the same; the server is down from March to October.
        yield* s.tm.reschedule(job.id, { cron: "0 7 * * *", timeZone: "Europe/Amsterdam" })
        yield* s.close
        yield* TestClock.setTime(Date.parse("2026-10-23T12:00:00Z"))
        const again = yield* engine(table)
        const later: Array<string> = []
        yield* again.tm.handle("wake", Payload, (_p, due) => Effect.sync(() => later.push(new Date(due.dueAt).toISOString()))).pipe(Scope.provide(again.scope))
        yield* advance(3 * 24 * HOUR)
        // The last missed occurrence once, then 7:00 CEST, 7:00 CET on the day the clocks go back, 7:00 CET.
        assert.deepStrictEqual(later, ["2026-10-23T05:00:00.000Z", "2026-10-24T05:00:00.000Z", "2026-10-25T06:00:00.000Z", "2026-10-26T06:00:00.000Z"])
        yield* again.close
      }))

    it.effect("tasks: two run at once and the rest queue; cancel interrupts; the result is recorded", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const gates = [yield* Deferred.make<string, Error>(), yield* Deferred.make<string, Error>(), yield* Deferred.make<string, Error>()]
        const tasks: Array<JobRow> = []
        for (const [i, gate] of gates.entries()) {
          tasks.push(yield* s.tm.runTask({ label: `research ${i}`, work: Deferred.await(gate), onDone: (a) => ({ kind: "result", priority: "normal", content: { title: a } }) }))
        }
        yield* settle
        const states = () => Effect.forEach(tasks, (t) => Effect.map(s.tm.get(t.id), (r) => r?.state))
        assert.deepStrictEqual(yield* states(), ["running", "running", "scheduled"])
        assert.strictEqual((yield* s.scheduler.counts).tasksRunning, 2)
        yield* s.tm.cancel(tasks[0]!.id)
        yield* settle
        assert.deepStrictEqual(yield* states(), ["cancelled", "running", "running"])
        yield* Deferred.succeed(gates[1]!, "found three sources")
        yield* settle
        const done = yield* s.tm.get(tasks[1]!.id)
        assert.strictEqual(done?.state, "done")
        assert.strictEqual(done?.result, "found three sources")
        assert.deepStrictEqual(s.deliveries.map((d) => [d.request.content.title, d.info.notificationId]), [["found three sources", `${tasks[1]!.id}@done`]])
        yield* Deferred.fail(gates[2]!, new Error("search quota reached"))
        yield* settle
        const failed = yield* s.tm.get(tasks[2]!.id)
        assert.strictEqual(failed?.state, "failed")
        assert.strictEqual(failed?.lastError, "search quota reached")
        yield* s.close
      }))

    it.effect("a task running (or queued) at a restart is marked interrupted", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const a = yield* s.tm.runTask({ label: "a", work: Effect.never })
        const b = yield* s.tm.runTask({ label: "b", work: Effect.never })
        const c = yield* s.tm.runTask({ label: "c", work: Effect.never })
        yield* settle
        yield* s.close
        const again = yield* engine(table)
        const row = (j: JobRow) => again.tm.get(j.id)
        assert.strictEqual((yield* row(a))?.state, "failed")
        assert.strictEqual((yield* row(a))?.lastError, "Interrupted by a restart")
        assert.strictEqual((yield* row(b))?.state, "failed")
        assert.strictEqual((yield* row(c))?.lastError, "Interrupted by a restart before it started")
        yield* again.close
      }))

    it.effect("the engine never waits for a slow handler", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const fired: Array<number> = []
        yield* s.tm.handle("slow", Payload, () => Effect.never, { timeoutMs: 10 * HOUR }).pipe(Scope.provide(s.scope))
        yield* s.tm.handle("fast", Payload, () => Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => fired.push(t)))).pipe(Scope.provide(s.scope))
        yield* s.tm.schedule({ kind: "deferred", when: { at: MIN }, onDue: { handler: "slow", payload: { n: 0 } } })
        yield* s.tm.schedule({ kind: "deferred", when: { at: MIN }, onDue: { handler: "fast", payload: { n: 0 } } })
        yield* s.tm.schedule({ kind: "deferred", when: { at: 2 * MIN }, onDue: { handler: "fast", payload: { n: 0 } } })
        yield* advance(2 * MIN)
        assert.deepStrictEqual(fired, [MIN, 2 * MIN])
        yield* s.close
      }))

    it.effect("origin from CurrentTurn, scope, and namespacing", () =>
      Effect.gen(function*() {
        const { table } = yield* make()
        const s = yield* engine(table)
        const job = yield* s.tm.schedule({ kind: "reminder", scope: { kind: "person", id: "sam" }, when: { inMs: MIN }, onDue: { notify: ring("call mum") } }).pipe(
          Effect.provideService(CurrentTurn, { turnId: 3, conversationId: "c1", source: "voice", assistantId: "jev", deviceId: "kitchen", person: { id: "sam", how: "device-default" } })
        )
        assert.deepStrictEqual(job.origin, { deviceId: "kitchen", assistantId: "jev", conversationId: "c1", person: "sam" })
        assert.strictEqual((yield* s.tm.list({ scope: { kind: "person", id: "sam" } })).length, 1)
        assert.strictEqual((yield* s.tm.list({ scope: { kind: "household" } })).length, 0)
        assert.strictEqual((yield* s.scheduler.forModule("other").list()).length, 0)
        assert.strictEqual((yield* s.scheduler.forModule("other").get(job.id)), undefined)
        const views = yield* s.scheduler.listAll()
        assert.deepStrictEqual(views.map((v) => [v.moduleName, v.orphaned]), [["Timers", false]])
        // A job of a module no longer in the catalogue is listed for the owner and raised on Health.
        yield* s.scheduler.forModule("gone").schedule({ kind: "timer", when: { inMs: HOUR }, onDue: { notify: ring("orphan") } })
        yield* s.scheduler.refreshIssues
        assert.isTrue((yield* s.scheduler.listAll()).some((v) => v.orphaned && v.job.module === "gone"))
        assert.isTrue(s.issues.all().some((i) => i.id === "core.scheduler.orphaned.gone"))
        yield* s.close
      }))
  })
