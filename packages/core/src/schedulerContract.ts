/**
 * The scheduler's contract tests (docs/SCHEDULING.md): one case per promise of that page, run on the in-memory store
 * (`packages/core/test/SchedulerContract.test.ts`) and on SQLite in memory and on a file
 * (`packages/store-sqlite/test/schedulerContract.test.ts`), on the test clock. A case's title names the promise.
 *
 * Besides the promises: the crash and failure boundaries (a fault-injecting store, `faultyStore`, and reopening the
 * store between the claim and the outcome), module stop and restart through the real module host, more jobs than one
 * page wherever something lists, and a randomised comparison of the engine with a small model of its states.
 */
import { assert, describe, it } from "@effect/vitest"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeEventBus } from "./EventBus.ts"
import { defineCollection, type HostTx, type HouseholdStore, type ModuleStore, StoreError, type StoredModule } from "./HouseholdStore.ts"
import { type IssueRegistry, makeIssueRegistry } from "./Issues.ts"
import { isModuleStopped } from "./ModuleApi.ts"
import { defineAction } from "./Actions.ts"
import { defineModule, type ModuleDefinition, ModuleStartError } from "./ModuleDefinition.ts"
import { makeModuleHost, type ModuleHostOptions, readOnlyPersistence } from "./ModuleHost.ts"
import {
  type DueInfo,
  type JobRow,
  MAX_ERROR_CHARS,
  MAX_LIVE_JOBS,
  MAX_PAYLOAD_CHARS,
  type ModuleScheduler,
  SCHEDULER_OWNER,
  SchedulerError
} from "./Scheduler.ts"
import {
  type CoreScheduler,
  MAX_ADMIN_JOB_PAGE,
  MAX_JOB_ISSUES,
  makeSchedulerEngine,
  RETENTION_ROWS_PER_PASS,
  RETENTION_STEP_ROWS,
  type SchedulerEngine,
  type SchedulerEngineOptions
} from "./SchedulerEngine.ts"
import { JOB_MAX_CHARS, jobCounts, jobs, MAX_JOB_PAGE, schedulerStorage, storedError, withIndexes } from "./SchedulerJobs.ts"
import { CurrentJob, CurrentTurn, type JobOrigin, type TurnContext } from "./TurnContext.ts"

/** A store for one case; `reopen` closes it and opens the same data again (in memory: the same store). */
export interface ContractStore {
  readonly store: HouseholdStore
  readonly reopen: Effect.Effect<HouseholdStore, unknown>
}
export type OpenStore = () => Effect.Effect<ContractStore, unknown, Scope.Scope>

const SECOND = 1_000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE

export const Note = Schema.Struct({ text: Schema.String })
export const notes = defineCollection({ name: "notes", scope: "household", schema: Note })
const Ping = Schema.Struct({ n: Schema.Number })

/** Prepare the store for the scheduler and these modules. */
const prepared = (store: HouseholdStore, modules: ReadonlyArray<StoredModule> = []) => Effect.as(store.prepare(modules, [schedulerStorage]), store)

/**
 * An engine in a scope of its own (closing it is a server stop), with fast retries and the test clock. Its scope is a
 * child of the case's: closed with the case at the latest (before the store the case opened earlier).
 */
export const engineOn = (store: HouseholdStore, options: Partial<SchedulerEngineOptions> = {}) =>
  Effect.gen(function*() {
    const scope = yield* Scope.fork(yield* Effect.scope)
    const issues = options.issues ?? makeIssueRegistry()
    const engine = yield* Scope.provide(scope)(makeSchedulerEngine({ retryBaseMs: SECOND, outcomeRetryMs: [100, 200], ...options, store, issues }))
    const advance = (ms: number) => Effect.andThen(Effect.andThen(engine.settled, TestClock.adjust(ms)), engine.settled)
    return { engine, issues, advance, stop: Scope.close(scope, Exit.void), scope }
  })

/** Register a core handler in a scope of its own (closing it withdraws the handler; the case's scope closes it at the latest). */
const coreHandler = <P, I>(core: CoreScheduler, name: string, handler: Parameters<CoreScheduler["handle"]>[1] & { readonly payload: Schema.Codec<P, I> }) =>
  Effect.gen(function*() {
    const scope = yield* Scope.fork(yield* Effect.scope)
    yield* Scope.provide(scope)(core.handle(name, handler))
    return { withdraw: Scope.close(scope, Exit.void) }
  })

/** Calls of a handler, with what it was told. */
const recorder = () => {
  const calls: Array<{ readonly payload: unknown; readonly due: DueInfo; readonly job: JobOrigin | undefined }> = []
  return {
    calls,
    run: (payload: unknown, due: DueInfo) => Effect.flatMap(CurrentJob, (job) => Effect.sync(() => void calls.push({ payload, due, job })))
  }
}

const failureOf = <A>(exit: Exit.Exit<A, unknown>): unknown => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)

const turn = (over: Partial<TurnContext> = {}): TurnContext => ({ turnId: 1, conversationId: "c1", source: "voice", assistantId: "jev", deviceId: "kitchen", person: { id: "sam", how: "device-default" }, ...over })

/**
 * A store that fails the writes moving a `running` job on (an outcome, a recovery, a cancel of a running job) while
 * `faults.running` is above 0 (each failure counts it down; `Infinity`: always), with `StoreError` `busy`; and the reads
 * of the scheduler's jobs outside a transaction (`list`: the Health issues, the recovery rule, the admin list) while
 * `faults.reads` is above 0 (counted in `faults.readsFailed`).
 */
export const faultyStore = (inner: HouseholdStore) => {
  const faults = { running: 0, failed: 0, reads: 0, readsFailed: 0 }
  const wrap = (htx: HostTx): HostTx => ({
    ...htx,
    forCore: (owner) => {
      const t = htx.forCore(owner)
      if (owner !== SCHEDULER_OWNER) return t
      return {
        ...t,
        collection: (c) => {
          const col = t.collection(c)
          if (c.name !== jobs.name) return col
          return {
            ...col,
            update: (id, f, o) => {
              const before = col.get(id) as { readonly value: { readonly state: string } } | undefined
              if (before?.value.state === "running" && faults.running > 0) {
                faults.running--
                faults.failed++
                throw new StoreError({ reason: "busy", message: "injected: the store is busy" })
              }
              return col.update(id, f, o)
            }
          }
        }
      }
    }
  })
  const forCore: HouseholdStore["forCore"] = (owner) => {
    const own = inner.forCore(owner)
    if (owner !== SCHEDULER_OWNER) return own
    return {
      ...own,
      collection: (c) => {
        const col = own.collection(c)
        if (c.name !== jobs.name) return col
        return {
          ...col,
          list: (query) =>
            Effect.suspend(() => {
              if (faults.reads <= 0) return col.list(query)
              faults.reads--
              faults.readsFailed++
              return Effect.fail(new StoreError({ reason: "busy", message: "injected: a read failed" }))
            })
        }
      }
    }
  }
  const store: HouseholdStore = { ...inner, forCore, transaction: (f) => inner.transaction((htx) => f(wrap(htx))) }
  return { store, faults }
}

/** A version 2 module whose shared part registers handlers and keeps its context. */
const kitModule = (id: string, register: (scheduler: ModuleScheduler) => Effect.Effect<void, SchedulerError>, held: { scheduler?: ModuleScheduler; store?: unknown }) =>
  defineModule({
    apiVersion: 2,
    id,
    name: `Kit ${id}`,
    description: "Test",
    storage: { collections: [notes] },
    shared: (ctx) =>
      Effect.gen(function*() {
        held.scheduler = ctx.scheduler
        held.store = ctx.store
        yield* register(ctx.scheduler).pipe(Effect.mapError((e) => new ModuleStartError({ message: e.message })))
        return { value: undefined }
      }),
    start: () => Effect.succeed({})
  })

/** A module host over `store` with the engine as its scheduler (and as the engine's gateway). */
const hostOn = (store: HouseholdStore, catalog: ReadonlyArray<ModuleDefinition<any>>, engine: SchedulerEngine, options: Partial<ModuleHostOptions> = {}) =>
  makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {}, household: { store, events: makeEventBus() }, scheduler: engine, graceMs: 0, ...options })

const issueIds = (issues: IssueRegistry) => issues.all().map((i) => i.id)
/** The Health issue shown, besides the newest `MAX_JOB_ISSUES` failures, when there are more (it gives no number). */
const MORE_FAILED_TITLE = "More scheduled jobs have failed than are listed here"

export const schedulerContract = (name: string, open: OpenStore) =>
  describe(`Scheduler contract: ${name}`, () => {
    const setup = (options: Partial<SchedulerEngineOptions> = {}) =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const e = yield* engineOn(store, options)
        const core = e.engine.forCore("core.test")
        return { ...e, store, core, opened }
      })

    // ---- Due times

    it.effect("a job runs once at its time (at, inMs), and is done; the handler is told dueAt, lateMs and attempt", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        yield* core.handle("ping", { payload: Ping, run: r.run })
        const a = yield* core.schedule({ handler: "ping", payload: { n: 1 }, inMs: 10 * SECOND })
        const b = yield* core.schedule({ handler: "ping", payload: { n: 2 }, at: 20 * SECOND })
        assert.strictEqual(a.state, "scheduled")
        assert.strictEqual(a.dueAt, 10 * SECOND)
        yield* advance(9 * SECOND)
        assert.strictEqual(r.calls.length, 0)
        yield* advance(SECOND)
        assert.deepStrictEqual(r.calls.map((c) => [c.payload, c.due.dueAt, c.due.lateMs, c.due.attempt, c.due.jobId]), [[{ n: 1 }, 10 * SECOND, 0, 1, a.id]])
        yield* advance(30 * SECOND)
        assert.strictEqual(r.calls.length, 2)
        const done = yield* core.get(b.id)
        assert.strictEqual(done?.state, "done")
        assert.strictEqual(done?.finishedAt, 20 * SECOND)
        assert.strictEqual(done?.attempt, 1)
      }))

    it.effect("a time in the past is due now (and late by that much); a negative inMs or no time at all is invalid", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        yield* TestClock.adjust(MINUTE)
        const r = recorder()
        yield* core.handle("ping", { payload: Ping, run: r.run })
        yield* core.schedule({ handler: "ping", payload: { n: 1 }, at: 10 * SECOND })
        yield* advance(0)
        assert.strictEqual(r.calls[0]?.due.lateMs, 50 * SECOND)
        for (const bad of [{ inMs: -1 }, {}, { at: 1, inMs: 1 }, { at: Number.NaN }] as const) {
          const e = failureOf(yield* Effect.exit(core.schedule({ handler: "ping", ...bad } as never)))
          assert.instanceOf(e, SchedulerError)
          assert.strictEqual((e as SchedulerError).reason, "invalid")
        }
      }))

    it.effect("unknown fields, bad handler names, bad keys and bad origins are refused (invalid)", () =>
      Effect.gen(function*() {
        const { core } = yield* setup()
        for (const bad of [
          { handler: "ping", inMs: 1, when: 3 },
          { handler: "Ping!", inMs: 1 },
          { handler: "ping", inMs: 1, key: "has space" },
          { handler: "ping", inMs: 1, origin: { deviceId: "a b" } },
          { handler: "ping", inMs: 1, late: { withinMs: -1 } },
          { handler: "ping", inMs: 1, timeZone: "UTC" }
        ]) {
          const e = failureOf(yield* Effect.exit(core.schedule(bad as never)))
          assert.strictEqual((e as SchedulerError).reason, "invalid", JSON.stringify(bad))
        }
      }))

    // ---- Payloads

    it.effect("a payload is JSON of at most 1,000 characters; it is decoded by the handler's schema", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        yield* core.handle("ping", { payload: Schema.Struct({ s: Schema.String }), run: r.run })
        const fits = "x".repeat(MAX_PAYLOAD_CHARS - '{"s":""}'.length)
        const ok = yield* core.schedule({ handler: "ping", payload: { s: fits }, inMs: 0 })
        assert.strictEqual(JSON.stringify(ok.payload).length, MAX_PAYLOAD_CHARS)
        const long = failureOf(yield* Effect.exit(core.schedule({ handler: "ping", payload: { s: `${fits}x` }, inMs: 0 })))
        assert.strictEqual((long as SchedulerError).reason, "invalid")
        const big = failureOf(yield* Effect.exit(core.schedule({ handler: "ping", payload: { n: 1n }, inMs: 0 })))
        assert.strictEqual((big as SchedulerError).reason, "invalid")
        yield* advance(0)
        assert.deepStrictEqual(r.calls[0]?.payload, { s: fits })
      }))

    it.effect("a payload the handler's schema does not decode fails the job, and it is not retried", () =>
      Effect.gen(function*() {
        const { advance, core, issues } = yield* setup()
        const r = recorder()
        yield* core.handle("ping", { payload: Ping, idempotent: true, run: r.run })
        const job = yield* core.schedule({ handler: "ping", payload: { n: "not a number" }, inMs: 0 })
        yield* advance(MINUTE)
        const after = yield* core.get(job.id)
        assert.strictEqual(after?.state, "failed")
        assert.strictEqual(after?.attempt, 1)
        assert.match(after?.lastError ?? "", /payload/)
        assert.strictEqual(r.calls.length, 0)
        assert.include(issueIds(issues), `core.scheduler.failed.${job.id}`)
      }))

    // ---- Keys and the limit

    it.effect("one live job per key: scheduling the same key again replaces the live one (cancelled)", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        yield* core.handle("ping", { payload: Ping, run: r.run })
        const first = yield* core.schedule({ handler: "ping", payload: { n: 1 }, key: "timer:pasta", inMs: 10 * SECOND })
        const second = yield* core.schedule({ handler: "ping", payload: { n: 2 }, key: "timer:pasta", inMs: 20 * SECOND })
        assert.strictEqual((yield* core.get(first.id))?.state, "cancelled")
        assert.deepStrictEqual((yield* core.list({ key: "timer:pasta" })).map((j) => j.id), [second.id])
        yield* advance(30 * SECOND)
        assert.deepStrictEqual(r.calls.map((c) => c.payload), [{ n: 2 }])
        // Finished, the key is free: a new job of it is the only live one.
        const third = yield* core.schedule({ handler: "ping", payload: { n: 3 }, key: "timer:pasta", inMs: 5 * SECOND })
        assert.deepStrictEqual((yield* core.list({ key: "timer:pasta" })).map((j) => j.id), [third.id])
      }))

    it.effect("at most 200 live jobs per owner (limit); a replaced key does not count twice; a finished job frees its place", () =>
      Effect.gen(function*() {
        const { advance, core, engine } = yield* setup()
        yield* core.handle("ping", { payload: Ping, run: () => Effect.void })
        for (let i = 0; i < MAX_LIVE_JOBS; i++) yield* core.schedule({ handler: "ping", payload: { n: i }, key: `k${i}`, inMs: (i === 0 ? 1 : 60) * MINUTE })
        const over = failureOf(yield* Effect.exit(core.schedule({ handler: "ping", payload: { n: 0 }, inMs: MINUTE })))
        assert.strictEqual((over as SchedulerError).reason, "limit")
        // Another owner is not affected.
        const other = engine.forCore("core.other")
        yield* other.schedule({ handler: "ping", inMs: MINUTE })
        yield* core.schedule({ handler: "ping", payload: { n: 7 }, key: "k7", inMs: 30 * MINUTE })
        yield* advance(2 * MINUTE)
        yield* core.schedule({ handler: "ping", payload: { n: 1 }, inMs: MINUTE })
        const again = failureOf(yield* Effect.exit(core.schedule({ handler: "ping", payload: { n: 2 }, inMs: MINUTE })))
        assert.strictEqual((again as SchedulerError).reason, "limit")
        // Cancelling frees a place too.
        assert.isTrue(yield* core.cancel({ key: "k3" }))
        yield* core.schedule({ handler: "ping", payload: { n: 3 }, inMs: MINUTE })
      }))

    // ---- Cron

    it.effect("cron: a job runs at every occurrence and stays scheduled for the next", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        yield* core.handle("tick", { payload: Schema.Unknown, run: r.run })
        const job = yield* core.schedule({ handler: "tick", cron: "*/10 * * * * *", timeZone: "UTC" })
        assert.strictEqual(job.dueAt, 10 * SECOND)
        yield* advance(35 * SECOND)
        assert.deepStrictEqual(r.calls.map((c) => c.due.dueAt), [10 * SECOND, 20 * SECOND, 30 * SECOND])
        const now = yield* core.get(job.id)
        assert.strictEqual(now?.state, "scheduled")
        assert.strictEqual(now?.dueAt, 40 * SECOND)
        assert.strictEqual(now?.attempt, 0)
      }))

    it.effect("cron: an expression that does not parse, or never fires, is refused when scheduled (invalid, not a defect)", () =>
      Effect.gen(function*() {
        const { core } = yield* setup()
        for (const cron of ["not a cron", "61 * * * *", "* * * * * * *"]) {
          const exit = yield* Effect.exit(core.schedule({ handler: "tick", cron, timeZone: "UTC" }))
          assert.isTrue(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)._tag === "Some", cron)
          assert.strictEqual((failureOf(exit) as SchedulerError).reason, "invalid", cron)
        }
        const zone = failureOf(yield* Effect.exit(core.schedule({ handler: "tick", cron: "0 7 * * *", timeZone: "Mars/Olympus" })))
        assert.strictEqual((zone as SchedulerError).reason, "invalid")
      }))

    it.effect("cron is for system jobs: a day of month or a month is refused (invalid: a one-off job rescheduled from its handler)", () =>
      Effect.gen(function*() {
        const { core } = yield* setup()
        // Among them the costliest for Cron.next: a date that comes every few years, and one that never comes.
        for (const cron of ["0 0 31 2 *", "0 0 29 2 */7", "0 7 1 * *", "0 7 * 1 *", "0 0 7 1-12 *", "0 0 0 */2 * *", "0 0 0 * JAN *"]) {
          const e = failureOf(yield* Effect.exit(core.schedule({ handler: "tick", cron, timeZone: "Europe/Amsterdam" })))
          assert.strictEqual((e as SchedulerError).reason, "invalid", cron)
          assert.match((e as SchedulerError).message, /day of month and month must be \*.*one-off job/, cron)
        }
        // Minute, hour and day-of-week patterns, with or without seconds, are accepted.
        for (const cron of ["*/15 * * * *", "0 7 * * 1-5", "30 2 * * SUN", "*/10 * * * * *", "0 0,30 6-22 * * MON-FRI"]) {
          assert.strictEqual((yield* core.schedule({ handler: "tick", cron, timeZone: "Europe/Amsterdam" })).state, "scheduled", cron)
        }
      }))

    it.effect("cron without a zone: the household's zone each time it is planned; a planned occurrence does not move", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const zone = { now: "Europe/Amsterdam" }
        const { advance, engine } = yield* engineOn(store, { timeZone: () => zone.now })
        const core = engine.forCore("core.test")
        const r = recorder()
        yield* core.handle("alarm", { payload: Schema.Unknown, run: r.run })
        // 1970-01-01 is winter: Amsterdam is UTC+1, New York UTC−5.
        const job = yield* core.schedule({ handler: "alarm", cron: "0 7 * * *" })
        assert.strictEqual(job.dueAt, 6 * 60 * MINUTE)
        assert.isUndefined(job.timeZone)
        zone.now = "America/New_York"
        // Already planned for 06:00Z; it stays there.
        assert.strictEqual((yield* core.get(job.id))?.dueAt, 6 * 60 * MINUTE)
        yield* advance(7 * 60 * MINUTE)
        assert.deepStrictEqual(r.calls.map((c) => c.due.dueAt), [6 * 60 * MINUTE])
        // The next one is planned in New York's zone: 07:00 there is 12:00Z.
        assert.strictEqual((yield* core.get(job.id))?.dueAt, 12 * 60 * MINUTE)
      }))

    // ---- Late jobs

    it.effect('late "run" (the default): a job found late runs once, however late, and is told how late', () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        const job = yield* core.schedule({ handler: "ping", payload: { n: 1 }, inMs: SECOND })
        yield* advance(DAY)
        assert.strictEqual((yield* core.get(job.id))?.state, "scheduled")
        yield* core.handle("ping", { payload: Ping, run: r.run })
        yield* advance(0)
        assert.strictEqual(r.calls.length, 1)
        assert.strictEqual(r.calls[0]!.due.lateMs, DAY - SECOND)
        assert.strictEqual((yield* core.get(job.id))?.state, "done")
      }))

    it.effect("late { withinMs }: at most that late runs; later is missed and the handler is not called (no other grace)", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        const on = yield* core.schedule({ handler: "ping", payload: { n: 1 }, at: 10 * SECOND, late: { withinMs: 5 * SECOND } })
        const edge = yield* core.schedule({ handler: "ping", payload: { n: 2 }, at: 15 * SECOND, late: { withinMs: 5 * SECOND } })
        const over = yield* core.schedule({ handler: "ping", payload: { n: 3 }, at: 14 * SECOND, late: { withinMs: 5 * SECOND } })
        const zero = yield* core.schedule({ handler: "ping", payload: { n: 4 }, at: 19 * SECOND, late: { withinMs: 0 } })
        yield* advance(20 * SECOND)
        yield* core.handle("ping", { payload: Ping, run: r.run })
        yield* advance(0)
        // Found at 20 s: 10 s late (missed), 5 s late (runs), 6 s late (missed), 1 s late with withinMs 0 (missed).
        assert.deepStrictEqual(r.calls.map((c) => c.payload), [{ n: 2 }])
        assert.strictEqual((yield* core.get(on.id))?.state, "missed")
        assert.strictEqual((yield* core.get(edge.id))?.state, "done")
        assert.strictEqual((yield* core.get(over.id))?.state, "missed")
        assert.strictEqual((yield* core.get(zero.id))?.state, "missed")
        assert.strictEqual((yield* core.get(over.id))?.finishedAt, 20 * SECOND)
      }))

    it.effect("a repeating job found late runs once, for the latest occurrence at or before now, and continues after now", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        const job = yield* core.schedule({ handler: "tick", cron: "*/10 * * * * *", timeZone: "UTC" })
        yield* advance(SECOND)
        // Down from 1 s to 2 min 5 s: occurrences 10 s … 120 s were missed.
        yield* TestClock.adjust(124 * SECOND)
        yield* core.handle("tick", { payload: Schema.Unknown, run: r.run })
        yield* advance(0)
        assert.deepStrictEqual(r.calls.map((c) => [c.due.dueAt, c.due.lateMs]), [[120 * SECOND, 5 * SECOND]])
        assert.strictEqual((yield* core.get(job.id))?.dueAt, 130 * SECOND)
        // Sub-minute lateness is handled the same way: 2 s late, the latest occurrence is the planned one.
        yield* TestClock.adjust(7 * SECOND)
        yield* advance(0)
        assert.deepStrictEqual(r.calls.map((c) => c.due.dueAt), [120 * SECOND, 130 * SECOND])
      }))

    it.effect("a repeating job later than withinMs is not run and moves on to its next occurrence", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        const job = yield* core.schedule({ handler: "tick", cron: "*/10 * * * * *", timeZone: "UTC", late: { withinMs: 2 * SECOND } })
        yield* advance(SECOND)
        yield* TestClock.adjust(14 * SECOND)
        yield* core.handle("tick", { payload: Schema.Unknown, run: r.run })
        yield* advance(0)
        assert.strictEqual(r.calls.length, 0)
        const now = yield* core.get(job.id)
        assert.strictEqual(now?.state, "scheduled")
        assert.strictEqual(now?.dueAt, 20 * SECOND)
        yield* advance(10 * SECOND)
        assert.deepStrictEqual(r.calls.map((c) => [c.due.dueAt, c.due.lateMs]), [[20 * SECOND, 0]])
      }))

    // ---- Handlers that are not published

    it.effect("a job whose handler is not published stays scheduled (no waiting state) and runs when it is published", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        const job = yield* core.schedule({ handler: "later", inMs: SECOND })
        yield* advance(HOUR_MS)
        const waiting = yield* core.get(job.id)
        assert.strictEqual(waiting?.state, "scheduled")
        assert.strictEqual(waiting?.attempt, 0)
        const h = yield* coreHandler(core, "later", { payload: Schema.Unknown, run: r.run })
        yield* advance(0)
        assert.strictEqual(r.calls.length, 1)
        yield* h.withdraw
        // Withdrawn again: a new job waits.
        const next = yield* core.schedule({ handler: "later", inMs: SECOND })
        yield* advance(MINUTE)
        assert.strictEqual((yield* core.get(next.id))?.state, "scheduled")
      }))

    // ---- Failures

    it.effect("a handler that fails: not idempotent → failed and a Health issue, until it is cancelled", () =>
      Effect.gen(function*() {
        const { advance, core, issues } = yield* setup()
        let calls = 0
        yield* core.handle("bad", { payload: Schema.Unknown, run: () => Effect.suspend(() => (calls++, Effect.fail(new Error("Home Assistant did not answer")))) })
        const job = yield* core.schedule({ handler: "bad", inMs: 0 })
        yield* advance(MINUTE)
        const after = yield* core.get(job.id)
        assert.strictEqual(after?.state, "failed")
        assert.strictEqual(after?.lastError, "Home Assistant did not answer")
        assert.strictEqual(calls, 1)
        assert.include(issueIds(issues), `core.scheduler.failed.${job.id}`)
        assert.isTrue(yield* core.cancel(job.id))
        yield* advance(0)
        assert.strictEqual((yield* core.get(job.id))?.state, "cancelled")
        assert.notInclude(issueIds(issues), `core.scheduler.failed.${job.id}`)
      }))

    it.effect("an idempotent handler is retried with back-off up to its retries, then failed", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const times: Array<[number, number]> = []
        yield* core.handle("flaky", {
          payload: Schema.Unknown,
          idempotent: true,
          retries: 2,
          run: (_p, due) => Effect.flatMap(Effect.clockWith((c) => Effect.sync(() => c.currentTimeMillisUnsafe())), (t) => (times.push([t, due.attempt]), Effect.fail("no")))
        })
        const job = yield* core.schedule({ handler: "flaky", inMs: 0 })
        yield* advance(MINUTE)
        // Back-off 1 s, then 2 s (retryBaseMs 1 s in these tests).
        assert.deepStrictEqual(times, [[0, 1], [SECOND, 2], [3 * SECOND, 3]])
        const after = yield* core.get(job.id)
        assert.strictEqual(after?.state, "failed")
        assert.strictEqual(after?.attempt, 3)
      }))

    it.effect("a repeating job always moves on: its failed occurrence is a Health issue until a later one succeeds", () =>
      Effect.gen(function*() {
        const { advance, core, issues } = yield* setup()
        let fail = true
        yield* core.handle("tick", { payload: Schema.Unknown, run: () => (fail ? Effect.die(new Error("boom")) : Effect.void) })
        const job = yield* core.schedule({ handler: "tick", cron: "*/10 * * * * *", timeZone: "UTC" })
        yield* advance(10 * SECOND)
        const failed = yield* core.get(job.id)
        assert.strictEqual(failed?.state, "scheduled")
        assert.strictEqual(failed?.dueAt, 20 * SECOND)
        assert.match(failed?.lastError ?? "", /boom/)
        assert.include(issueIds(issues), `core.scheduler.failed.${job.id}`)
        fail = false
        yield* advance(10 * SECOND)
        assert.isUndefined((yield* core.get(job.id))?.lastError)
        assert.notInclude(issueIds(issues), `core.scheduler.failed.${job.id}`)
      }))

    it.effect("the time limit fails a run (it covers decoding the payload); a defect and a self-interruption fail it too", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const Slow = Schema.Unknown.pipe(Schema.middlewareDecoding(() => Effect.never))
        yield* core.handle("slowdecode", { payload: Slow, timeoutMs: 2 * SECOND, run: () => Effect.void })
        yield* core.handle("slowrun", { payload: Schema.Unknown, timeoutMs: 2 * SECOND, run: () => Effect.never })
        yield* core.handle("dies", { payload: Schema.Unknown, run: () => Effect.sync(() => { throw new Error("thrown") }) })
        yield* core.handle("quits", { payload: Schema.Unknown, run: () => Effect.interrupt })
        const a = yield* core.schedule({ handler: "slowdecode", inMs: 0 })
        const b = yield* core.schedule({ handler: "slowrun", inMs: 0 })
        const c = yield* core.schedule({ handler: "dies", inMs: 0 })
        const d = yield* core.schedule({ handler: "quits", inMs: 0 })
        yield* advance(SECOND)
        yield* advance(SECOND)
        yield* advance(SECOND)
        for (const [job, text] of [[a, /did not finish within 2 s/], [b, /did not finish within 2 s/], [c, /thrown/], [d, /interrupted/]] as const) {
          const row = yield* core.get(job.id)
          assert.strictEqual(row?.state, "failed", job.handler)
          assert.match(row?.lastError ?? "", text, job.handler)
        }
      }))

    // ---- Cancel and reschedule

    it.effect("cancel: a scheduled job is cancelled and never runs; by id or by key; a finished one answers false", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        yield* core.handle("ping", { payload: Ping, run: r.run })
        const a = yield* core.schedule({ handler: "ping", payload: { n: 1 }, inMs: SECOND })
        const b = yield* core.schedule({ handler: "ping", payload: { n: 2 }, inMs: SECOND, key: "b" })
        assert.isTrue(yield* core.cancel(a.id))
        assert.isTrue(yield* core.cancel({ key: "b" }))
        assert.isFalse(yield* core.cancel(a.id))
        assert.isFalse(yield* core.cancel({ key: "b" }))
        assert.isFalse(yield* core.cancel("job_nothing"))
        yield* advance(MINUTE)
        assert.strictEqual(r.calls.length, 0)
        assert.strictEqual((yield* core.get(b.id))?.state, "cancelled")
        assert.strictEqual((yield* core.get(b.id))?.finishedAt, 0)
      }))

    it.effect("cancel a running job: the run is not interrupted, and what it reports is ignored", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const gate = yield* Deferred.make<void>()
        let finished = false
        yield* core.handle("hold", { payload: Schema.Unknown, run: () => Effect.andThen(Deferred.await(gate), Effect.sync(() => void (finished = true))) })
        const job = yield* core.schedule({ handler: "hold", inMs: 0 })
        yield* advance(0)
        assert.strictEqual((yield* core.get(job.id))?.state, "running")
        assert.isTrue(yield* core.cancel(job.id))
        yield* Deferred.succeed(gate, undefined)
        yield* advance(0)
        assert.isTrue(finished)
        assert.strictEqual((yield* core.get(job.id))?.state, "cancelled")
      }))

    it.effect("reschedule: a scheduled job moves; a running one is scheduled again and its present run's outcome is ignored", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const gate = yield* Deferred.make<void>()
        const runs: Array<number> = []
        yield* core.handle("hold", { payload: Schema.Unknown, run: (_p, due) => Effect.andThen(Effect.sync(() => void runs.push(due.dueAt)), due.dueAt === 0 ? Deferred.await(gate) : Effect.void) })
        const a = yield* core.schedule({ handler: "hold", inMs: 5 * SECOND })
        const moved = yield* core.reschedule(a.id, { inMs: 10 * SECOND })
        assert.strictEqual(moved?.dueAt, 10 * SECOND)
        const b = yield* core.schedule({ handler: "hold", inMs: 0 })
        yield* advance(0)
        assert.strictEqual((yield* core.get(b.id))?.state, "running")
        // The same due time again (0 s from now), while it runs: a new claim, and the old run's outcome is dropped.
        const again = yield* core.reschedule(b.id, { inMs: 0 })
        assert.strictEqual(again?.state, "scheduled")
        assert.strictEqual(again?.attempt, 0)
        yield* advance(0)
        yield* Deferred.succeed(gate, undefined)
        yield* advance(20 * SECOND)
        assert.deepStrictEqual(runs, [0, 0, 10 * SECOND])
        assert.strictEqual((yield* core.get(b.id))?.state, "done")
        assert.strictEqual((yield* core.get(b.id))?.attempt, 1)
        const missing = yield* core.reschedule("job_nothing", { inMs: 1 })
        assert.isUndefined(missing)
        const finished = failureOf(yield* Effect.exit(core.reschedule(b.id, { inMs: 1 })))
        assert.strictEqual((finished as SchedulerError).reason, "state")
      }))

    it.effect("a reschedule during an outcome write that fails: the late outcome is still dropped (the claim's rev)", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const base = yield* prepared(opened.store)
        const { faults, store } = faultyStore(base)
        const { advance, engine } = yield* engineOn(store)
        const core = engine.forCore("core.test")
        const gate = yield* Deferred.make<void>()
        yield* core.handle("hold", { payload: Schema.Unknown, run: (_p, due) => (due.attempt === 1 && due.dueAt === 0 ? Deferred.await(gate) : Effect.void) })
        const job = yield* core.schedule({ handler: "hold", inMs: 0 })
        yield* advance(0)
        faults.running = 1
        yield* Deferred.succeed(gate, undefined)
        yield* engine.settled
        // The first outcome write failed (busy); before its retry, the job is moved.
        yield* core.reschedule(job.id, { inMs: 30 * SECOND })
        yield* advance(SECOND)
        assert.strictEqual((yield* core.get(job.id))?.state, "scheduled")
        assert.strictEqual((yield* core.get(job.id))?.dueAt, 30 * SECOND)
      }))

    // ---- get and list

    it.effect("get and list see only the owner's jobs; list is live jobs by due time, a page at a time with after", () =>
      Effect.gen(function*() {
        const { advance, core, engine } = yield* setup()
        const other = engine.forCore("core.other")
        const mine: Array<string> = []
        for (let i = 0; i < 2 * MAX_JOB_PAGE + 5; i++) mine.push((yield* core.schedule({ handler: "ping", inMs: (100 - 3 * i) * SECOND })).id)
        const theirs = yield* other.schedule({ handler: "ping", inMs: SECOND })
        assert.isUndefined(yield* core.get(theirs.id))
        assert.isFalse(yield* core.cancel(theirs.id))
        assert.isUndefined(yield* core.reschedule(theirs.id, { inMs: 1 }))
        const seen: Array<JobRow> = []
        let after: JobRow | undefined
        for (;;) {
          const page = yield* core.list({ limit: MAX_JOB_PAGE, ...(after !== undefined ? { after } : {}) })
          seen.push(...page)
          if (page.length < MAX_JOB_PAGE) break
          after = page[page.length - 1]
        }
        assert.strictEqual(seen.length, mine.length)
        assert.deepStrictEqual(seen.map((j) => j.dueAt), [...seen.map((j) => j.dueAt)].sort((a, b) => a - b))
        assert.isTrue(seen.every((j) => j.module === "core.test"))
        const tooMany = failureOf(yield* Effect.exit(core.list({ limit: MAX_JOB_PAGE + 1 })))
        assert.strictEqual((tooMany as SchedulerError).reason, "invalid")
        // The default page is the most (a list of `jobs` reads at most MAX_JOB_PAGE rows).
        assert.strictEqual((yield* core.list()).length, MAX_JOB_PAGE)
        const copy = failureOf(yield* Effect.exit(core.list({ after: { ...seen[0]! } })))
        assert.strictEqual((copy as SchedulerError).reason, "invalid")
        const otherQuery = failureOf(yield* Effect.exit(core.list({ key: "x", after: seen[0]! })))
        assert.strictEqual((otherQuery as SchedulerError).reason, "invalid")
        // A finished job leaves the list (and get still finds it).
        yield* core.handle("ping", { payload: Schema.Unknown, run: () => Effect.void })
        yield* advance(50 * SECOND)
        const live = yield* core.list({ limit: MAX_JOB_PAGE })
        assert.isTrue(live.every((j) => j.state === "scheduled" && j.dueAt > 50 * SECOND))
        assert.strictEqual((yield* core.get(mine[mine.length - 1]!))?.state, "done")
      }))

    // ---- Scheduling inside a transaction

    it.effect("prepare + writeIn: a job written in the caller's own transaction commits or rolls back with its writes", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const held: { scheduler?: ModuleScheduler } = {}
        const { advance, engine } = yield* engineOn(store)
        const r = recorder()
        const kit = kitModule("kit", (s) => s.handle("ring", { payload: Schema.Struct({ note: Schema.String }), run: r.run }), held)
        const host = yield* hostOn(store, [kit], engine)
        yield* host.startEnabled
        const ctxStore = store.forModule("kit")
        const job = yield* held.scheduler!.prepare({ handler: "ring", payload: { note: "pasta" }, inMs: SECOND })
        const row = yield* ctxStore.transaction((tx) => {
          const note = tx.collection(notes).insert({ text: "pasta timer" })
          job.writeIn(tx)
          return note
        })
        assert.strictEqual((yield* held.scheduler!.get(job.id))?.state, "scheduled")
        // Rolled back: neither the note nor the job.
        const lost = yield* held.scheduler!.prepare({ handler: "ring", payload: { note: "gone" }, inMs: SECOND })
        const exit = yield* Effect.exit(ctxStore.transaction((tx) => {
          tx.collection(notes).insert({ text: "never" })
          lost.writeIn(tx)
          throw new StoreError({ reason: "failed", message: "the module changed its mind" })
        }))
        assert.isTrue(Exit.isFailure(exit))
        assert.isUndefined(yield* held.scheduler!.get(lost.id))
        assert.strictEqual((yield* ctxStore.collection(notes).list()).length, 1)
        // A handle used after its function is refused.
        let kept: Parameters<typeof job.writeIn>[0] | undefined
        yield* ctxStore.transaction((tx) => void (kept = tx))
        const late = yield* held.scheduler!.prepare({ handler: "ring", payload: { note: "late" }, inMs: SECOND })
        assert.throws(() => late.writeIn(kept!))
        assert.isUndefined(yield* held.scheduler!.get(late.id))
        yield* advance(2 * SECOND)
        assert.deepStrictEqual(r.calls.map((c) => c.payload), [{ note: "pasta" }])
        assert.strictEqual(row.value.text, "pasta timer")
      }))

    it.effect("writeIn at the limit throws a StoreError (invalid) inside the transaction: rolled back unless caught", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const { engine } = yield* engineOn(store)
        const core = engine.forCore("core.test")
        for (let i = 0; i < MAX_LIVE_JOBS; i++) yield* core.schedule({ handler: "ping", inMs: MINUTE })
        const job = yield* core.prepare({ handler: "ping", inMs: MINUTE })
        const kit = store.forModule("kit")
        const exit = yield* Effect.exit(kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "a" })
          job.writeIn(tx)
          return 1
        }))
        const error = failureOf(exit)
        assert.instanceOf(error, StoreError)
        assert.strictEqual((error as StoreError).reason, "invalid")
        assert.strictEqual((yield* kit.collection(notes).list()).length, 0)
        const caught = yield* kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "b" })
          try {
            job.writeIn(tx)
            return "written"
          } catch (e) {
            return (e as StoreError).reason
          }
        })
        assert.strictEqual(caught, "invalid")
        assert.strictEqual((yield* kit.collection(notes).list()).length, 1)
        assert.isUndefined(yield* core.get(job.id))
      }))

    // ---- Origin and principal

    it.effect("origin: the turn's device, assistant and person unless given; a job scheduled in a handler inherits its job's", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        const followed: Array<JobRow> = []
        yield* core.handle("first", { payload: Schema.Unknown, run: () => Effect.map(core.schedule({ handler: "second", inMs: SECOND }), (j) => void followed.push(j)).pipe(Effect.orDie) })
        yield* core.handle("second", { payload: Schema.Unknown, run: r.run })
        const fromTurn = yield* core.schedule({ handler: "first", inMs: 0 }).pipe(Effect.provideService(CurrentTurn, turn()))
        assert.deepStrictEqual(fromTurn.origin, { assistantId: "jev", deviceId: "kitchen", person: { id: "sam", how: "device-default" } })
        const given = yield* core.schedule({ handler: "second", inMs: 10 * SECOND, origin: { deviceId: "hall" } }).pipe(Effect.provideService(CurrentTurn, turn()))
        assert.deepStrictEqual(given.origin, { deviceId: "hall" })
        const none = yield* core.schedule({ handler: "second", inMs: 10 * SECOND })
        assert.deepStrictEqual(none.origin, {})
        yield* advance(2 * SECOND)
        assert.deepStrictEqual(followed[0]?.origin, fromTurn.origin)
        // The handler ran with its job as the principal: CurrentJob carries the origin.
        assert.deepStrictEqual(r.calls[0]?.job, { jobId: followed[0]!.id, moduleId: "core.test", assistantId: "jev", deviceId: "kitchen", person: { id: "sam", how: "device-default" } })
        yield* advance(10 * SECOND)
        assert.deepStrictEqual(r.calls.find((c) => c.due.jobId === given.id)?.job, { jobId: given.id, moduleId: "core.test", deviceId: "hall" })
      }))

    it.effect("a job principal the gateway refuses (a person no longer in Members) fails the job with that reason", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const ref: { gateway?: SchedulerEngineOptions["gateway"] } = {}
        const { advance, engine } = yield* engineOn(store, { gateway: () => ref.gateway?.() })
        const held: { scheduler?: ModuleScheduler } = {}
        const r = recorder()
        const kit = kitModule("kit", (s) => s.handle("ring", { payload: Schema.Unknown, run: r.run }), held)
        const host = yield* hostOn(store, [kit], engine, {
          access: {
            moduleOn: () => true,
            toolOff: () => false,
            principalProblem: (p) => (p._tag === "job" && p.job.person?.id === "gone" ? "the person is not in Members." : undefined)
          }
        })
        ref.gateway = () => host.gateway
        yield* host.startEnabled
        const refused = yield* held.scheduler!.schedule({ handler: "ring", inMs: 0, origin: { person: { id: "gone", how: "device-default" } } })
        const fine = yield* held.scheduler!.schedule({ handler: "ring", inMs: 0, origin: { person: { id: "sam", how: "device-default" } } })
        yield* advance(SECOND)
        assert.strictEqual((yield* held.scheduler!.get(refused.id))?.state, "failed")
        assert.strictEqual((yield* held.scheduler!.get(refused.id))?.lastError, "Not run: the person is not in Members.")
        assert.strictEqual((yield* held.scheduler!.get(fine.id))?.state, "done")
        assert.deepStrictEqual(r.calls.map((c) => c.due.jobId), [fine.id])
      }))

    // ---- Handlers belong to their part

    it.effect("a module's handlers are published with it and withdrawn with it; jobs wait while it is down", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const { advance, engine } = yield* engineOn(store)
        const held: { scheduler?: ModuleScheduler } = {}
        const r = recorder()
        const kit = kitModule("kit", (s) => s.handle("ring", { payload: Schema.Unknown, run: r.run }), held)
        const host = yield* hostOn(store, [kit], engine)
        yield* host.startEnabled
        const due = yield* held.scheduler!.schedule({ handler: "ring", inMs: 5 * SECOND })
        yield* host.disable("kit")
        yield* advance(10 * SECOND)
        assert.strictEqual(r.calls.length, 0)
        assert.strictEqual((yield* engine.forCore("core.peek").get(due.id)), undefined)
        // A job arriving while the module is down (scheduled by another way in) waits too.
        const arriving = yield* store.transaction((htx) => {
          const row = htx.forCore(SCHEDULER_OWNER).collection(jobs).insert(
            withIndexes({ module: "kit", handler: "ring", payload: null, state: "scheduled", dueAt: 0, late: "run", origin: {}, attempt: 0 }),
            { id: "job_arriving", actor: { kind: "admin" } }
          )
          return row.id
        })
        yield* advance(10 * SECOND)
        assert.strictEqual(r.calls.length, 0)
        yield* host.enable("kit")
        yield* advance(0)
        assert.deepStrictEqual(r.calls.map((c) => c.due.jobId).sort(), [due.id, arriving].sort())
        // The old context answers ModuleStopped once its part has closed.
        const old = held.scheduler!
        yield* host.disable("kit")
        for (const call of [old.list(), old.get("x"), old.schedule({ handler: "ring", inMs: 0 }), old.cancel("x"), old.handle("ring", { payload: Schema.Unknown, run: () => Effect.void })]) {
          const stopped = yield* Effect.exit(call as Effect.Effect<unknown, unknown>)
          assert.isTrue(Exit.isFailure(stopped) && isModuleStopped(Cause.squash(stopped.cause)))
        }
      }))

    it.effect("two handlers of one module with the same name refuse its start; handle after the start is refused (state)", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "twice", storage: { collections: [notes] } }, { id: "kit", storage: { collections: [notes] } }])
        const { engine } = yield* engineOn(store)
        const held: { scheduler?: ModuleScheduler } = {}
        const twice = defineModule({
          apiVersion: 2,
          id: "twice",
          name: "Twice",
          description: "Test",
          storage: { collections: [notes] },
          shared: (ctx) => Effect.as(ctx.scheduler.handle("ring", { payload: Schema.Unknown, run: () => Effect.void }).pipe(Effect.orDie), { value: undefined }),
          start: (ctx) => Effect.as(ctx.scheduler.handle("ring", { payload: Schema.Unknown, run: () => Effect.void }).pipe(Effect.orDie), {})
        })
        const kit = kitModule("kit", () => Effect.void, held)
        const host = yield* hostOn(store, [twice, kit], engine)
        yield* host.startEnabled
        const info = host.modules().find((m) => m.id === "twice")!
        assert.strictEqual(info.state, "error")
        assert.match(String(info.error ?? ""), /Two job handlers/)
        const late = failureOf(yield* Effect.exit(held.scheduler!.handle("ring", { payload: Schema.Unknown, run: () => Effect.void })))
        assert.strictEqual((late as SchedulerError).reason, "state")
      }))

    it.effect("module stop with a job running: the run gets the grace period, then it is interrupted and stays running; at the restart the recovery rule decides", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const { advance, engine } = yield* engineOn(store)
        const held: { scheduler?: ModuleScheduler } = {}
        const started: Array<string> = []
        let quick = false
        const kit = kitModule("kit", (s) =>
          Effect.andThen(
            s.handle("once", { payload: Schema.Unknown, run: (_p, due) => Effect.andThen(Effect.sync(() => void started.push(`once:${due.attempt}`)), Effect.sleep(MINUTE)) }),
            s.handle("again", {
              payload: Schema.Unknown,
              idempotent: true,
              run: (_p, due) => Effect.andThen(Effect.sync(() => void started.push(`again:${due.attempt}`)), quick ? Effect.void : Effect.sleep(MINUTE))
            })
          ), held)
        const host = yield* hostOn(store, [kit], engine, { graceMs: 5 * SECOND })
        yield* host.startEnabled
        const once = yield* held.scheduler!.schedule({ handler: "once", inMs: 0 })
        const again = yield* held.scheduler!.schedule({ handler: "again", inMs: 0 })
        yield* advance(0)
        const stopping = yield* Effect.forkChild(host.disable("kit"))
        yield* advance(SECOND)
        // In the grace period: still running.
        assert.strictEqual((yield* engine.forCore("core.x").get(once.id)), undefined)
        yield* advance(5 * SECOND)
        yield* Fiber.join(stopping)
        const rows = (yield* store.forCore(SCHEDULER_OWNER).collection(jobs).list({ where: { state: "running" }, orderBy: { field: "at" } })).map((r) => r.id).sort()
        assert.deepStrictEqual(rows, [once.id, again.id].sort())
        quick = true
        yield* host.enable("kit")
        yield* advance(0)
        const s = held.scheduler!
        // Not idempotent: failed, not run again. Idempotent: run again (attempt 2), done.
        assert.strictEqual((yield* s.get(once.id))?.state, "failed")
        assert.match((yield* s.get(once.id))?.lastError ?? "", /without telling/)
        assert.strictEqual((yield* s.get(again.id))?.state, "done")
        assert.deepStrictEqual(started.sort(), ["again:1", "again:2", "once:1"])
      }))

    it.effect("a run that ends in the grace period of a stop is recorded normally", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const { advance, engine } = yield* engineOn(store)
        const held: { scheduler?: ModuleScheduler } = {}
        const kit = kitModule("kit", (s) => s.handle("short", { payload: Schema.Unknown, run: () => Effect.sleep(2 * SECOND) }), held)
        const host = yield* hostOn(store, [kit], engine, { graceMs: 5 * SECOND })
        yield* host.startEnabled
        const job = yield* held.scheduler!.schedule({ handler: "short", inMs: 0 })
        yield* advance(0)
        const stopping = yield* Effect.forkChild(host.disable("kit"))
        yield* advance(3 * SECOND)
        yield* Fiber.join(stopping)
        assert.strictEqual((yield* engine.forCore("core.x").get(job.id)), undefined)
        const row = yield* store.forCore(SCHEDULER_OWNER).collection(jobs).get(job.id)
        assert.strictEqual(row?.value.state, "done")
      }))

    // ---- Crash and failure boundaries

    it.effect("crash after the claim, before the run: not idempotent → failed without a call; idempotent → run again", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        // A claim committed by a process that stopped right after it: the row is running, attempt 1.
        yield* store.transaction((htx) => {
          const c = htx.forCore(SCHEDULER_OWNER).collection(jobs)
          for (const [id, handler] of [["job_once", "once"], ["job_again", "again"]] as const) {
            c.insert(withIndexes({ module: "core.test", handler, payload: null, state: "running", dueAt: 0, occurrenceAt: 0, late: "run", origin: {}, attempt: 1 }), { id, actor: { kind: "admin" } })
          }
        })
        const reopened = yield* prepared(yield* opened.reopen)
        const { advance, engine, issues } = yield* engineOn(reopened)
        const core = engine.forCore("core.test")
        const r1 = recorder()
        const r2 = recorder()
        yield* core.handle("once", { payload: Schema.Unknown, run: r1.run })
        yield* core.handle("again", { payload: Schema.Unknown, idempotent: true, run: r2.run })
        yield* advance(0)
        assert.strictEqual(r1.calls.length, 0)
        assert.strictEqual((yield* core.get("job_once"))?.state, "failed")
        assert.include(issueIds(issues), "core.scheduler.failed.job_once")
        assert.deepStrictEqual(r2.calls.map((c) => c.due.attempt), [2])
        assert.strictEqual((yield* core.get("job_again"))?.state, "done")
      }))

    it.effect("crash during the run (the server stops): the row stays running; the next start applies the recovery rule", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const first = yield* engineOn(store)
        const core1 = first.engine.forCore("core.test")
        const started: Array<number> = []
        yield* core1.handle("tick", { payload: Schema.Unknown, run: (_p, due) => Effect.andThen(Effect.sync(() => void started.push(due.dueAt)), Effect.never) })
        const job = yield* core1.schedule({ handler: "tick", cron: "*/10 * * * * *", timeZone: "UTC" })
        yield* first.advance(10 * SECOND)
        assert.deepStrictEqual(started, [10 * SECOND])
        yield* first.stop
        const reopened = yield* prepared(yield* opened.reopen)
        assert.strictEqual((yield* reopened.forCore(SCHEDULER_OWNER).collection(jobs).get(job.id))?.value.state, "running")
        const second = yield* engineOn(reopened)
        const core2 = second.engine.forCore("core.test")
        yield* TestClock.adjust(3 * SECOND)
        yield* core2.handle("tick", { payload: Schema.Unknown, run: () => Effect.void })
        yield* second.advance(0)
        // Not idempotent, repeating: that occurrence is not run again; the job moves on (with the issue).
        const row = yield* core2.get(job.id)
        assert.strictEqual(row?.state, "scheduled")
        assert.strictEqual(row?.dueAt, 20 * SECOND)
        assert.match(row?.lastError ?? "", /without telling/)
        assert.include(issueIds(second.issues), `core.scheduler.failed.${job.id}`)
      }))

    it.effect("after the run, before the outcome: an outcome that cannot be written is tried again, then left running; recovery decides", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const base = yield* prepared(opened.store)
        const { faults, store } = faultyStore(base)
        const { advance, engine } = yield* engineOn(store, { maintenanceMs: 10 * MINUTE })
        const core = engine.forCore("core.test")
        let calls = 0
        yield* core.handle("once", { payload: Schema.Unknown, run: () => Effect.sync(() => void calls++) })
        yield* core.handle("again", { payload: Schema.Unknown, idempotent: true, run: () => Effect.sync(() => void calls++) })
        // Once: the retry writes it.
        faults.running = 1
        const a = yield* core.schedule({ handler: "once", inMs: 0 })
        yield* advance(0)
        yield* advance(SECOND)
        assert.strictEqual((yield* core.get(a.id))?.state, "done")
        assert.strictEqual(faults.failed, 1)
        // Always (while the store fails): left running; when it works again, the maintenance pass applies the rule.
        faults.running = Infinity
        const b = yield* core.schedule({ handler: "once", inMs: 0 })
        const c = yield* core.schedule({ handler: "again", inMs: 0 })
        yield* advance(0)
        yield* advance(SECOND)
        assert.strictEqual((yield* core.get(b.id))?.state, "running")
        assert.strictEqual((yield* core.get(c.id))?.state, "running")
        assert.strictEqual(engine.runsInFlight(), 0)
        faults.running = 0
        yield* advance(10 * MINUTE)
        assert.strictEqual((yield* core.get(b.id))?.state, "failed")
        assert.strictEqual((yield* core.get(c.id))?.state, "done")
        assert.strictEqual(calls, 4)
      }))

    it.effect("a store reopened between the claim and the outcome: the next process recovers the row", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const first = yield* engineOn(store)
        const gate = yield* Deferred.make<void>()
        yield* first.engine.forCore("core.test").handle("again", { payload: Schema.Unknown, idempotent: true, run: () => Deferred.await(gate) })
        const job = yield* first.engine.forCore("core.test").schedule({ handler: "again", inMs: 0 })
        yield* first.advance(0)
        yield* first.stop
        const reopened = yield* prepared(yield* opened.reopen)
        const second = yield* engineOn(reopened)
        const r = recorder()
        yield* second.engine.forCore("core.test").handle("again", { payload: Schema.Unknown, idempotent: true, run: r.run })
        yield* second.advance(0)
        assert.deepStrictEqual(r.calls.map((c) => c.due.attempt), [2])
        assert.strictEqual((yield* second.engine.forCore("core.test").get(job.id))?.state, "done")
      }))

    it.effect("a core handler withdrawn while it runs: interrupted, the row stays running, and the rule applies when it is registered again", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const h = yield* coreHandler(core, "hold", { payload: Schema.Unknown, run: () => Effect.never })
        const job = yield* core.schedule({ handler: "hold", inMs: 0 })
        yield* advance(0)
        yield* h.withdraw
        yield* advance(SECOND)
        assert.strictEqual((yield* core.get(job.id))?.state, "running")
        const r = recorder()
        yield* coreHandler(core, "hold", { payload: Schema.Unknown, run: r.run })
        yield* advance(0)
        assert.strictEqual((yield* core.get(job.id))?.state, "failed")
        assert.strictEqual(r.calls.length, 0)
      }))

    // ---- Retention and issues

    it.effect("finished rows are removed seven days after they finished, also when nothing is due: 200 a pass in transactions of RETENTION_STEP_ROWS, the rest a second later", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        // 231 rows that finished eight days ago (the first one failed: a Health issue), before the engine starts.
        yield* TestClock.adjust(8 * DAY)
        const n = RETENTION_ROWS_PER_PASS + 31
        yield* store.transaction((htx) => {
          const c = htx.forCore(SCHEDULER_OWNER).collection(jobs)
          for (let i = 0; i < n; i++) {
            const failed = i === 0
            c.insert(withIndexes({ module: "core.test", handler: "none", payload: null, state: failed ? "failed" : "cancelled", dueAt: i, late: "run", origin: {}, attempt: failed ? 1 : 0, finishedAt: i, ...(failed ? { failedAt: i, lastError: "no" } : {}) }), { id: `job_old${String(i).padStart(3, "0")}`, actor: { kind: "admin" } })
          }
        })
        const steps: Array<number> = []
        const issues = makeIssueRegistry()
        issues.set("scheduler", [{ id: "core.scheduler.failed.job_old000", severity: "warning", title: "t", detail: "d" }])
        const { advance, engine } = yield* engineOn(store, { issues, observe: (e) => void (e.kind === "retention-step" && steps.push(e.removed)) })
        const finished = Effect.gen(function*() {
          let count = 0
          let cursor: string | undefined = "finished"
          while (cursor !== undefined) {
            const page: { readonly jobs: ReadonlyArray<unknown>; readonly next?: string } = yield* engine.listAll({ cursor })
            count += page.jobs.length
            cursor = page.next
          }
          return count
        })
        // The first pass (nothing advanced): exactly RETENTION_ROWS_PER_PASS, in transactions of RETENTION_STEP_ROWS.
        yield* engine.settled
        assert.strictEqual(yield* finished, 31)
        assert.deepStrictEqual(steps, Array.from({ length: RETENTION_ROWS_PER_PASS / RETENTION_STEP_ROWS }, () => RETENTION_STEP_ROWS))
        assert.notInclude(issueIds(issues), "core.scheduler.failed.job_old000")
        // The rest a second later, not before.
        yield* advance(999)
        assert.strictEqual(yield* finished, 31)
        yield* advance(1)
        assert.strictEqual(yield* finished, 0)
        assert.strictEqual(steps.reduce((x, y) => x + y, 0), n)
        assert.isTrue(steps.every((k) => k <= RETENTION_STEP_ROWS))
        // A row is kept for seven days.
        const core = engine.forCore("core.test")
        const fresh = yield* core.schedule({ handler: "none", inMs: DAY })
        yield* core.cancel(fresh.id)
        yield* advance(7 * DAY - SECOND)
        assert.strictEqual((yield* core.get(fresh.id))?.state, "cancelled")
        yield* advance(11 * MINUTE)
        assert.isUndefined(yield* core.get(fresh.id))
      }))

    it.effect("Health issues: the 48 newest failures by failure time, and one issue saying there are more (no number) only when there are", () =>
      Effect.gen(function*() {
        for (const n of [MAX_JOB_ISSUES - 1, MAX_JOB_ISSUES, MAX_JOB_ISSUES + 1, MAX_JOB_ISSUES + 12]) {
          const opened = yield* open()
          const store = yield* prepared(opened.store)
          // Failed rows written at one instant in id order, the oldest failure last: an order by update time, creation
          // time or id would keep the oldest failure and leave out the newest.
          yield* store.transaction((htx) => {
            const c = htx.forCore(SCHEDULER_OWNER).collection(jobs)
            for (let i = 0; i < n; i++) {
              c.insert(withIndexes({ module: "core.test", handler: "bad", payload: null, state: "failed", dueAt: 0, late: "run", origin: {}, attempt: 1, finishedAt: n - i, failedAt: n - i, lastError: "no" }), { id: `job_f${String(i).padStart(3, "0")}`, actor: { kind: "admin" } })
            }
          })
          const { advance, core, issues } = yield* engineOn(store).pipe(Effect.map((e) => ({ ...e, core: e.engine.forCore("core.test") })))
          yield* advance(0)
          const ids = issueIds(issues).filter((id) => id.startsWith("core.scheduler."))
          const newest = Array.from({ length: Math.min(n, MAX_JOB_ISSUES) }, (_, i) => `core.scheduler.failed.job_f${String(i).padStart(3, "0")}`)
          const more = issues.all().find((i) => i.id === "core.scheduler.failed.more")
          assert.deepStrictEqual(ids.filter((id) => id !== "core.scheduler.failed.more").sort(), newest.sort(), `${n}`)
          if (n <= MAX_JOB_ISSUES) assert.isUndefined(more, `${n}`)
          else {
            assert.strictEqual(more?.title, MORE_FAILED_TITLE, `${n}`)
            assert.strictEqual(more?.fix?.value, "#settings/diagnostics/scheduled")
          }
          // Dismissing one: the next newest takes its place, and the number follows at once.
          assert.isTrue(yield* core.cancel("job_f000"))
          yield* advance(0)
          const after = issueIds(issues).filter((id) => id.startsWith("core.scheduler."))
          assert.notInclude(after, "core.scheduler.failed.job_f000")
          if (n > MAX_JOB_ISSUES) assert.include(after, `core.scheduler.failed.job_f${String(MAX_JOB_ISSUES).padStart(3, "0")}`)
          const left = issues.all().find((i) => i.id === "core.scheduler.failed.more")
          if (n - 1 <= MAX_JOB_ISSUES) assert.isUndefined(left, `${n} - 1`)
          else assert.strictEqual(left?.title, MORE_FAILED_TITLE, `${n} - 1`)
        }
      }))

    it.effect("a repeating job's failure stays a Health issue through a missed occurrence; only a success clears it", () =>
      Effect.gen(function*() {
        const { advance, core, engine, issues } = yield* setup()
        let fail = true
        const handler = { payload: Schema.Unknown, run: () => (fail ? Effect.fail(new Error("boom")) : Effect.void) }
        const h = yield* coreHandler(core, "tick", handler)
        const job = yield* core.schedule({ handler: "tick", cron: "*/10 * * * * *", timeZone: "UTC", late: { withinMs: 2 * SECOND } })
        yield* advance(10 * SECOND)
        assert.include(issueIds(issues), `core.scheduler.failed.${job.id}`)
        // Down from 10 s to 25 s: the 20 s occurrence is found 5 s late and missed.
        yield* h.withdraw
        yield* advance(15 * SECOND)
        fail = false
        yield* coreHandler(core, "tick", handler)
        yield* advance(0)
        const missed = yield* core.get(job.id)
        assert.strictEqual(missed?.dueAt, 30 * SECOND)
        assert.strictEqual(missed?.lastError, "boom")
        assert.strictEqual(missed?.failedAt, 10 * SECOND)
        yield* engine.refreshIssues
        assert.include(issueIds(issues), `core.scheduler.failed.${job.id}`)
        // The 30 s occurrence succeeds: now it is cleared.
        yield* advance(5 * SECOND)
        assert.isUndefined((yield* core.get(job.id))?.lastError)
        assert.notInclude(issueIds(issues), `core.scheduler.failed.${job.id}`)
      }))

    it.effect("replacing a failed repeating job by its key clears its Health issue at once (schedule and writeIn)", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const { advance, engine, issues } = yield* engineOn(store, { maintenanceMs: DAY })
        const core = engine.forCore("core.test")
        yield* core.handle("tick", { payload: Schema.Unknown, run: () => Effect.fail("no") })
        const a = yield* core.schedule({ handler: "tick", key: "a", cron: "*/10 * * * * *", timeZone: "UTC" })
        const b = yield* core.schedule({ handler: "tick", key: "b", cron: "*/10 * * * * *", timeZone: "UTC" })
        yield* advance(10 * SECOND)
        assert.includeMembers(issueIds(issues), [`core.scheduler.failed.${a.id}`, `core.scheduler.failed.${b.id}`])
        yield* core.schedule({ handler: "tick", key: "a", inMs: DAY })
        yield* advance(0)
        assert.notInclude(issueIds(issues), `core.scheduler.failed.${a.id}`)
        const job = yield* core.prepare({ handler: "tick", key: "b", inMs: DAY })
        yield* store.forModule("kit").transaction((tx) => void job.writeIn(tx))
        yield* advance(0)
        assert.notInclude(issueIds(issues), `core.scheduler.failed.${b.id}`)
      }))

    // ---- The admin list

    it.effect("the admin list reads page by page: live jobs by due time, then finished ones newest first; cancel any job", () =>
      Effect.gen(function*() {
        const { advance, core, engine } = yield* setup({ modules: () => [{ id: "core.test", name: "Test" }] })
        yield* core.handle("ping", { payload: Schema.Unknown, run: () => Effect.void })
        for (let i = 0; i < MAX_JOB_PAGE + 3; i++) yield* core.schedule({ handler: "ping", inMs: i * SECOND })
        yield* advance(MAX_JOB_PAGE * SECOND)
        for (let i = 0; i < MAX_JOB_PAGE + 2; i++) yield* core.schedule({ handler: "later", inMs: (100 + i) * SECOND })
        const all: Array<JobRow> = []
        let cursor: string | undefined
        let pages = 0
        for (;;) {
          const page = yield* engine.listAll({ limit: 10, ...(cursor !== undefined ? { cursor } : {}) })
          pages++
          all.push(...page.jobs.map((v) => v.job))
          assert.isTrue(page.jobs.length <= 10)
          if (page.next === undefined) break
          cursor = page.next
        }
        assert.strictEqual(all.length, 2 * MAX_JOB_PAGE + 5)
        assert.strictEqual(pages, Math.ceil(all.length / 10))
        assert.strictEqual(new Set(all.map((j) => j.id)).size, all.length)
        // The most a page holds: two reads of MAX_JOB_PAGE (the default); one more is invalid.
        const big = yield* engine.listAll()
        assert.strictEqual(big.jobs.length, MAX_ADMIN_JOB_PAGE)
        assert.deepStrictEqual(big.jobs.map((v) => v.job.id), all.slice(0, MAX_ADMIN_JOB_PAGE).map((j) => j.id))
        const over = failureOf(yield* Effect.exit(engine.listAll({ limit: MAX_ADMIN_JOB_PAGE + 1 })))
        assert.strictEqual((over as SchedulerError).reason, "invalid")
        const live = all.filter((j) => j.state === "scheduled")
        const finished = all.filter((j) => j.state === "done")
        assert.strictEqual(all.indexOf(finished[0]!), live.length)
        assert.deepStrictEqual(live.map((j) => j.dueAt), [...live.map((j) => j.dueAt)].sort((a, b) => a - b))
        assert.deepStrictEqual(finished.map((j) => j.finishedAt), [...finished.map((j) => j.finishedAt!)].sort((a, b) => b - a))
        const expired = failureOf(yield* Effect.exit(engine.listAll({ cursor: "live.zzzz" })))
        assert.strictEqual((expired as SchedulerError).reason, "invalid")
        assert.isTrue(yield* engine.cancelAny(live[0]!.id))
        assert.isFalse(yield* engine.cancelAny(finished[0]!.id))
        assert.strictEqual((yield* core.get(live[0]!.id))?.state, "cancelled")
      }))

    // ---- Wake-ups

    it.effect("the loop wakes for a job scheduled earlier than the one it sleeps for, and after a jump of the wall clock", () =>
      Effect.gen(function*() {
        // A clock whose wall time can jump while its monotonic time goes on (NTP setting a Pi's clock after boot).
        const base = yield* Clock.Clock
        let offset = 0
        const jumpy: Clock.Clock = {
          currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe() + offset,
          currentTimeMillis: Effect.sync(() => base.currentTimeMillisUnsafe() + offset),
          currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n,
          currentTimeNanos: Effect.sync(() => base.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n),
          monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: base.monotonicTimeNanos,
          sleep: (d) => base.sleep(d)
        }
        const lines: Array<string> = []
        const { advance, core } = yield* setup({ log: (l) => void lines.push(l), jumpCheckMs: 10 * SECOND }).pipe(Effect.provideService(Clock.Clock, jumpy))
        const r = recorder()
        yield* core.handle("ping", { payload: Ping, run: r.run })
        yield* core.schedule({ handler: "ping", payload: { n: 1 }, inMs: HOUR_MS }).pipe(Effect.provideService(Clock.Clock, jumpy))
        yield* advance(SECOND)
        yield* core.schedule({ handler: "ping", payload: { n: 2 }, inMs: SECOND }).pipe(Effect.provideService(Clock.Clock, jumpy))
        yield* advance(SECOND)
        assert.deepStrictEqual(r.calls.map((c) => c.payload), [{ n: 2 }])
        // The wall clock jumps forward two hours: seen within one sleep (10 s), the job is due and runs.
        offset = 2 * HOUR_MS
        yield* advance(10 * SECOND)
        assert.deepStrictEqual(r.calls.map((c) => c.payload), [{ n: 2 }, { n: 1 }])
        assert.isTrue(lines.some((l) => l.includes("wall clock jumped forward")), lines.join("\n"))
        assert.isTrue(r.calls[1]!.due.lateMs > HOUR_MS - 20 * SECOND)
      }))

    // ---- More promises of the page

    it.effect("an action a handler runs through host.actions.run is admitted for the job's principal (its assistant's choices)", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }, { id: "lights", storage: undefined }])
        const ref: { gateway?: SchedulerEngineOptions["gateway"] } = {}
        const { advance, engine } = yield* engineOn(store, { gateway: () => ref.gateway?.() })
        const results: Array<string> = []
        const held: { scheduler?: ModuleScheduler } = {}
        const kit = defineModule({
          apiVersion: 2,
          id: "kit",
          name: "Kit",
          description: "Test",
          storage: { collections: [notes] },
          shared: (ctx) =>
            Effect.gen(function*() {
              held.scheduler = ctx.scheduler
              yield* ctx.scheduler.handle("switch", {
                payload: Schema.Unknown,
                run: () => Effect.map(ctx.host.actions.run({ moduleId: "lights", actionId: "on", params: {} }), (r) => void results.push(r.ok ? "ran" : `refused: ${r.message}`))
              }).pipe(Effect.orDie)
              return { value: undefined }
            }),
          start: () => Effect.succeed({})
        })
        const lights = defineModule({
          apiVersion: 2,
          id: "lights",
          name: "Lights",
          description: "Test",
          start: () => Effect.succeed({ actions: [defineAction({ id: "on", label: "On", description: "", params: {}, run: () => Effect.succeed({ say: "On." }) })] })
        })
        const host = yield* hostOn(store, [kit, lights], engine, {
          access: { moduleOn: (assistantId, moduleId) => moduleId !== "lights" || assistantId === "jev", toolOff: () => false }
        })
        ref.gateway = () => host.gateway
        yield* host.startEnabled
        yield* held.scheduler!.schedule({ handler: "switch", inMs: 0, origin: { assistantId: "jev" } })
        yield* advance(SECOND)
        yield* held.scheduler!.schedule({ handler: "switch", inMs: 0, origin: { assistantId: "guest" } })
        yield* advance(SECOND)
        assert.strictEqual(results[0], "ran")
        assert.match(results[1] ?? "", /^refused: .*lights module is not on/)
      }))

    it.effect("a retry is late by how long after its occurrence it runs (withinMs applies to it)", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const attempts: Array<number> = []
        yield* core.handle("flaky", { payload: Schema.Unknown, idempotent: true, retries: 5, run: (_p, due) => (attempts.push(due.attempt), Effect.fail("no")) })
        const job = yield* core.schedule({ handler: "flaky", inMs: 0, late: { withinMs: 1_500 } })
        yield* advance(MINUTE)
        // At 0 s and 1 s (1 s late); the retry at 3 s is 3 s after its occurrence: missed.
        assert.deepStrictEqual(attempts, [1, 2])
        assert.strictEqual((yield* core.get(job.id))?.state, "missed")
      }))

    it.effect("reschedule a repeating job: it runs at the new time, then continues from its cron", () =>
      Effect.gen(function*() {
        const { advance, core } = yield* setup()
        const r = recorder()
        yield* core.handle("tick", { payload: Schema.Unknown, run: r.run })
        const job = yield* core.schedule({ handler: "tick", cron: "*/10 * * * * *", timeZone: "UTC" })
        yield* core.reschedule(job.id, { at: 13 * SECOND })
        yield* advance(25 * SECOND)
        assert.deepStrictEqual(r.calls.map((c) => c.due.dueAt), [13 * SECOND, 20 * SECOND])
        assert.strictEqual((yield* core.get(job.id))?.dueAt, 30 * SECOND)
      }))

    it.effect("daylight saving: Cron puts 02:30 of the spring gap at 03:30, and runs the repeated 02:30 of autumn once", () =>
      Effect.gen(function*() {
        // The date is set before the engine sleeps (the test clock steps through every sleeper on its way).
        yield* TestClock.setTime(Date.parse("2026-03-28T12:00:00Z"))
        const { advance, core } = yield* setup({ jumpCheckMs: HOUR_MS })
        const r = recorder()
        yield* core.handle("night", { payload: Schema.Unknown, run: r.run })
        const spring = yield* core.schedule({ handler: "night", cron: "30 2 * * *", timeZone: "Europe/Amsterdam" })
        assert.strictEqual(new Date(spring.dueAt).toISOString(), "2026-03-29T01:30:00.000Z")
        yield* core.cancel(spring.id)
        const t = yield* Clock.currentTimeMillis
        // Autumn: rescheduled to 2026-10-24 12:00Z, it then runs at the first 02:30 of the 25th (00:30Z), then the 26th.
        const autumn = yield* core.schedule({ handler: "night", cron: "30 2 * * *", timeZone: "Europe/Amsterdam" })
        yield* core.reschedule(autumn.id, { at: Date.parse("2026-10-24T12:00:00Z") })
        yield* advance(Date.parse("2026-10-24T12:00:00Z") - t)
        yield* advance(2 * DAY)
        const runs = r.calls.map((c) => new Date(c.due.dueAt).toISOString())
        assert.deepStrictEqual(runs, ["2026-10-24T12:00:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"])
      }), { timeout: 30_000 })

    it.effect("at most maxRuns runs at once: the loop claims the next job when a run ends", () =>
      Effect.gen(function*() {
        const { advance, core, engine } = yield* setup({ maxRuns: 2 })
        const started: Array<string> = []
        yield* core.handle("hold", { payload: Schema.Unknown, run: (_p, due) => Effect.andThen(Effect.sync(() => void started.push(due.jobId)), Effect.sleep(10 * SECOND)) })
        const ids: Array<string> = []
        for (let i = 0; i < 3; i++) ids.push((yield* core.schedule({ handler: "hold", inMs: 0 })).id)
        yield* advance(0)
        assert.strictEqual(started.length, 2)
        assert.strictEqual(engine.runsInFlight(), 2)
        yield* advance(10 * SECOND)
        assert.strictEqual(started.length, 3)
        yield* advance(10 * SECOND)
        for (const id of ids) assert.strictEqual((yield* core.get(id))?.state, "done")
      }))

    it.effect("a prepared job is written once; a handler name that does not fit is refused (invalid)", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const { engine } = yield* engineOn(store)
        const core = engine.forCore("core.test")
        const job = yield* core.prepare({ handler: "ping", inMs: MINUTE })
        yield* store.forModule("kit").transaction((tx) => job.writeIn(tx))
        const twice = yield* Effect.exit(store.forModule("kit").transaction((tx) => job.writeIn(tx)))
        assert.strictEqual((failureOf(twice) as StoreError).reason, "invalid")
        assert.strictEqual((yield* core.list()).length, 1)
        const bad = failureOf(yield* Effect.exit(core.handle("Not A Name", { payload: Schema.Unknown, run: () => Effect.void })))
        assert.strictEqual((bad as SchedulerError).reason, "invalid")
        const retries = failureOf(yield* Effect.exit(core.handle("ok", { payload: Schema.Unknown, retries: 11, run: () => Effect.void })))
        assert.strictEqual((retries as SchedulerError).reason, "invalid")
      }))

    // ---- The state machine against a model

    it.effect("random schedules, clock steps, stops, crashes, cancels and reschedules: the engine agrees with a small model", () =>
      Effect.gen(function*() {
        for (let scenario = 0; scenario < MODEL_SCENARIOS; scenario++) yield* modelScenario(open, 0x5eed + scenario)
      }), { timeout: 120_000 })

    it.effect("the worst legal row fits maxChars: every field at its longest, with the costliest JSON characters in every free-text field", () =>
      Effect.gen(function*() {
        // The payload: exactly MAX_PAYLOAD_CHARS of JSON, nearly all of it unpaired surrogates (six characters each).
        let text = ""
        while (JSON.stringify({ s: `${text}\ud800` }).length <= MAX_PAYLOAD_CHARS) text += "\ud800"
        const payload = { s: text.padEnd(text.length + MAX_PAYLOAD_CHARS - JSON.stringify({ s: text }).length, "x") }
        assert.strictEqual(JSON.stringify(payload).length, MAX_PAYLOAD_CHARS)
        // The costliest failure text: quotes, backslashes, unpaired surrogates and control characters, well past the bound.
        const failure = storedError(`${'"\\'.repeat(300)}${"\ud800\udc00".repeat(50)}${"\udfff\u0001".repeat(300)}`)
        assert.isAtMost(JSON.stringify(failure).length - 2, MAX_ERROR_CHARS)
        const id = "x".repeat(64)
        const own = {
          module: "m".repeat(40),
          handler: `h${"h".repeat(63)}`,
          key: "k".repeat(100),
          payload,
          dueAt: 8.64e15,
          cron: `${"0,".repeat(48)}0 * * * *`.slice(0, 100),
          timeZone: "z".repeat(48),
          late: { withinMs: 8.64e15 },
          origin: { assistantId: id, deviceId: id, person: { id, how: "device-default" as const, confidence: -1.2345678901234567e-300 } },
          attempt: 11,
          lastError: failure,
          failedAt: 8.64e15
        }
        // Live: a retry of an occurrence after an earlier one failed (every live field). Finished: every finished one.
        const rows = [
          withIndexes({ ...own, state: "scheduled", occurrenceAt: 8.64e15 }),
          withIndexes({ ...own, state: "running", occurrenceAt: 8.64e15 }),
          ...(["done", "failed", "cancelled", "missed"] as const).map((state) => withIndexes({ ...own, state, finishedAt: 8.64e15 }))
        ]
        for (const v of rows) assert.isAtMost(JSON.stringify(v).length, JOB_MAX_CHARS, v.state)
        assert.strictEqual(MAX_JOB_PAGE, Math.min(100, Math.floor(25_000 / JOB_MAX_CHARS)))
      }))

    it.effect("a failure text of unpaired surrogates and quotes is stored bounded: a repeating job at every limit moves on, with its issue", () =>
      Effect.gen(function*() {
        const { advance, core, issues } = yield* setup()
        const id = "x".repeat(64)
        let text = ""
        while (JSON.stringify({ s: `${text}\ud800` }).length <= MAX_PAYLOAD_CHARS) text += "\ud800"
        yield* core.handle(`h${"h".repeat(63)}`, { payload: Schema.Unknown, run: () => Effect.fail(new Error(`${"\ud800".repeat(300)}${'"'.repeat(300)}`)) })
        const job = yield* core.schedule({
          handler: `h${"h".repeat(63)}`,
          payload: { s: text },
          key: "k".repeat(100),
          cron: "*/10 * * * * *",
          timeZone: "America/Argentina/ComodRivadavia",
          late: { withinMs: 8.64e15 },
          origin: { assistantId: id, deviceId: id, person: { id, how: "chosen", confidence: 0.123456789 } }
        })
        yield* advance(10 * SECOND)
        const after = yield* core.get(job.id)
        assert.strictEqual(after?.state, "scheduled")
        assert.strictEqual(after?.dueAt, 20 * SECOND)
        assert.isAtMost(JSON.stringify(after?.lastError).length - 2, MAX_ERROR_CHARS)
        assert.match(after?.lastError ?? "", /^\ufffd{199}…$/)
        assert.include(issueIds(issues), `core.scheduler.failed.${job.id}`)
      }))

    // ---- Review round 1 of the rebuild

    it.effect("writeIn refuses before it writes: a caught refusal (the limit, an id in use) leaves the key's live job and the count as they were", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const ids = ["job_a", "job_b", "job_a"]
        const { engine } = yield* engineOn(store, { newId: () => ids.shift() ?? `job_${Math.random().toString(36).slice(2)}` })
        const core = engine.forCore("core.test")
        const counted = Effect.map(store.forCore(SCHEDULER_OWNER).collection(jobCounts).get("core.test"), (r) => r?.value.live)
        yield* core.schedule({ handler: "ping", inMs: MINUTE })
        const keyed = yield* core.schedule({ handler: "ping", key: "k", inMs: MINUTE })
        const kit = store.forModule("kit")
        // An id in use (job_a): refused before the key's live job is cancelled.
        const reused = yield* core.prepare({ handler: "ping", key: "k", inMs: MINUTE })
        const first = yield* kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "kept" })
          try {
            reused.writeIn(tx)
            return "written"
          } catch (e) {
            return (e as StoreError).reason
          }
        })
        assert.strictEqual(first, "invalid")
        assert.strictEqual((yield* core.get(keyed.id))?.state, "scheduled")
        assert.strictEqual(yield* counted, 2)
        // At the limit: refused before anything is written.
        for (let i = 2; i < MAX_LIVE_JOBS; i++) yield* core.schedule({ handler: "ping", inMs: MINUTE })
        const over = yield* core.prepare({ handler: "ping", key: "other", inMs: MINUTE })
        const second = yield* kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "kept too" })
          try {
            over.writeIn(tx)
            return "written"
          } catch (e) {
            return (e as StoreError).reason
          }
        })
        assert.strictEqual(second, "invalid")
        assert.strictEqual((yield* core.get(keyed.id))?.state, "scheduled")
        assert.strictEqual(yield* counted, MAX_LIVE_JOBS)
        assert.strictEqual((yield* kit.collection(notes).list()).length, 2)
        // The key's job is still replaced normally.
        const replacing = yield* core.prepare({ handler: "ping", key: "k", inMs: MINUTE })
        yield* kit.transaction((tx) => void replacing.writeIn(tx))
        assert.strictEqual((yield* core.get(keyed.id))?.state, "cancelled")
        assert.strictEqual(yield* counted, MAX_LIVE_JOBS)
      }))

    it.effect("the maintenance pass recounts each module's live jobs: a wrong counter (too high or too low) is repaired", () =>
      Effect.gen(function*() {
        const { advance, core, engine, store } = yield* setup()
        for (let i = 0; i < 2 * MAX_JOB_PAGE + 3; i++) yield* core.schedule({ handler: "ping", inMs: DAY })
        const counts = store.forCore(SCHEDULER_OWNER).collection(jobCounts)
        for (const planted of [5, 2 * MAX_JOB_PAGE + 40]) {
          yield* counts.update("core.test", () => ({ live: planted }))
          engine.maintainSoon()
          yield* advance(0)
          assert.strictEqual((yield* counts.get("core.test"))?.value.live, 2 * MAX_JOB_PAGE + 3, `${planted}`)
        }
        // Right counters are left alone.
        const rev = (yield* counts.get("core.test"))?.rev
        engine.maintainSoon()
        yield* advance(0)
        assert.strictEqual((yield* counts.get("core.test"))?.rev, rev)
      }))

    it.effect("fairness: a handler with many due jobs does not keep another's waiting; the next free run goes to the next handler", () =>
      Effect.gen(function*() {
        const { advance, engine } = yield* setup({ maxRuns: 2 })
        const started: Array<[string, number]> = []
        const slow = (name: string) => ({
          payload: Schema.Unknown,
          run: () => Effect.andThen(Effect.flatMap(Clock.currentTimeMillis, (t) => Effect.sync(() => void started.push([name, t]))), Effect.sleep(10 * SECOND))
        })
        const a = engine.forCore("core.a")
        const b = engine.forCore("core.b")
        yield* a.handle("work", slow("a"))
        yield* b.handle("work", slow("b"))
        for (let i = 0; i < MAX_LIVE_JOBS; i++) yield* a.schedule({ handler: "work", inMs: 0 })
        yield* b.schedule({ handler: "work", inMs: 5 * SECOND })
        yield* advance(0)
        assert.deepStrictEqual(started, [["a", 0], ["a", 0]])
        // Due at 5 s while both runs are taken; at 10 s two runs end: b's job takes the first free one.
        yield* advance(10 * SECOND)
        assert.deepStrictEqual(started.slice(2), [["b", 10 * SECOND], ["a", 10 * SECOND]])
        assert.strictEqual(engine.runsInFlight(), 2)
      }))

    it.effect("a pass is one round: a job that becomes due, and a handler published, while a quick handler keeps a backlog each run within two passes", () =>
      Effect.gen(function*() {
        let passes = 0
        const { advance, engine } = yield* setup({ maxRuns: 100, maintenanceMs: DAY, observe: (e) => void (e.kind === "pass" && passes++) })
        const a = engine.forCore("core.a")
        const b = engine.forCore("core.b")
        const c = engine.forCore("core.c")
        // When something became runnable and when it ran: A's runs so far, and the passes so far.
        const marks: Record<string, { readonly aRuns: number; readonly passes: number }> = {}
        const mark = (what: string) => void (marks[what] = { aRuns, passes })
        let aRuns = 0
        const cScope = yield* Scope.fork(yield* Effect.scope)
        yield* coreHandler(b, "work", { payload: Schema.Unknown, run: () => Effect.sync(() => mark("b ran")) })
        // C's job waits for C's handler, which A's sixth run publishes.
        yield* c.schedule({ handler: "work", inMs: 0 })
        // A is quick: every run schedules its successor at once (inMs 0), and a few are due from the start, so A always
        // has a due job (its backlog never runs dry, however its runs and the loop interleave) for 60 runs.
        yield* coreHandler(a, "work", {
          payload: Schema.Unknown,
          run: () =>
            Effect.gen(function*() {
              aRuns++
              if (aRuns === 3) {
                yield* b.schedule({ handler: "work", inMs: 0 })
                mark("b due")
              }
              if (aRuns === 6) {
                yield* Scope.provide(cScope)(c.handle("work", { payload: Schema.Unknown, run: () => Effect.sync(() => mark("c ran")) }))
                mark("c published")
              }
              if (aRuns < 60) yield* a.schedule({ handler: "work", inMs: 0 })
            })
        })
        for (let i = 0; i < 3; i++) yield* a.schedule({ handler: "work", inMs: 0 })
        yield* advance(0)
        assert.isAtLeast(aRuns, 60)
        for (const [due, ran] of [["b due", "b ran"], ["c published", "c ran"]] as const) {
          assert.isDefined(marks[ran], ran)
          // A pass takes at most one job of A: within two passes, A ran at most twice more.
          assert.isAtMost(marks[ran]!.aRuns - marks[due]!.aRuns, 2, `${ran}: A's runs since ${due}`)
          assert.isAtMost(marks[ran]!.passes - marks[due]!.passes, 2, `${ran}: passes since ${due}`)
        }
      }))

    it.effect("a prepared job kept across a restart of its module is refused with ModuleStopped, even in a live transaction of the new part", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const { advance, engine } = yield* engineOn(store)
        const held: { scheduler?: ModuleScheduler; store?: unknown } = {}
        const r = recorder()
        const kit = kitModule("kit", (s) => s.handle("ring", { payload: Schema.Unknown, run: r.run }), held)
        const host = yield* hostOn(store, [kit], engine)
        yield* host.startEnabled
        const live = yield* held.scheduler!.schedule({ handler: "ring", key: "pasta", inMs: MINUTE })
        const kept = yield* held.scheduler!.prepare({ handler: "ring", key: "pasta", inMs: SECOND })
        yield* host.disable("kit")
        yield* host.enable("kit")
        const now = held.store as ModuleStore
        const exit = yield* Effect.exit(now.transaction((tx) => {
          tx.collection(notes).insert({ text: "with the old job" })
          kept.writeIn(tx)
        }))
        assert.isTrue(Exit.isFailure(exit) && isModuleStopped(Cause.squash(exit.cause)))
        // Nothing was written: not the job, not the note; the key's live job is still the one of before.
        assert.isUndefined(yield* held.scheduler!.get(kept.id))
        assert.strictEqual((yield* now.collection(notes).list()).length, 0)
        assert.deepStrictEqual((yield* held.scheduler!.list({ key: "pasta" })).map((j) => [j.id, j.state]), [[live.id, "scheduled"]])
        // A job the new part prepares is written as before.
        const fresh = yield* held.scheduler!.prepare({ handler: "ring", inMs: SECOND })
        yield* now.transaction((tx) => void fresh.writeIn(tx))
        yield* advance(2 * SECOND)
        assert.deepStrictEqual(r.calls.map((call) => call.due.jobId), [fresh.id])
      }))

    it.effect("a Health read that fails is tried again by the loop's back-off: a failed job shows, and a cancelled one goes, without maintenance", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const { faults, store } = faultyStore(yield* prepared(opened.store))
        const { advance, engine, issues } = yield* engineOn(store, { maintenanceMs: DAY })
        const core = engine.forCore("core.test")
        yield* core.handle("bad", { payload: Schema.Unknown, run: () => Effect.fail(new Error("no")) })
        yield* advance(0)
        const job = yield* core.schedule({ handler: "bad", inMs: SECOND })
        faults.reads = 1
        yield* advance(SECOND)
        assert.strictEqual((yield* core.get(job.id))?.state, "failed")
        assert.strictEqual(faults.readsFailed, 1)
        // Read again after the loop's back-off (5 s; or sooner, when something wakes the loop), not at maintenance.
        yield* advance(5 * SECOND)
        assert.include(issueIds(issues), `core.scheduler.failed.${job.id}`)
        faults.reads = 1
        assert.isTrue(yield* core.cancel(job.id))
        yield* advance(0)
        assert.strictEqual(faults.readsFailed, 2)
        yield* advance(5 * SECOND)
        assert.notInclude(issueIds(issues), `core.scheduler.failed.${job.id}`)
      }))

    it.effect("the contract's helpers: an engine and a core handler made in a case are closed with the case's scope", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const caseScope = yield* Scope.fork(yield* Effect.scope)
        let interrupted = 0
        const { advance, engine } = yield* Scope.provide(caseScope)(engineOn(store))
        const core = engine.forCore("core.test")
        yield* Scope.provide(caseScope)(coreHandler(core, "hold", { payload: Schema.Unknown, run: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted++))) }))
        yield* core.schedule({ handler: "hold", inMs: 0 })
        yield* advance(0)
        assert.strictEqual(engine.runsInFlight(), 1)
        yield* Scope.close(caseScope, Exit.void)
        assert.strictEqual(interrupted, 1)
        assert.strictEqual(engine.runsInFlight(), 0)
      }))

    it.effect("closing the engine interrupts every run, a core handler's too; closing a handler's registration interrupts its runs", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        // The registration outlives the engine (as a core service registered in a longer scope).
        const outer = yield* Scope.make()
        const first = yield* engineOn(store)
        const gate = yield* Deferred.make<void>()
        let interrupted = 0
        let effectAfter = false
        const hold = { payload: Schema.Unknown, run: () => Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => void (effectAfter = true))), Effect.onInterrupt(() => Effect.sync(() => void interrupted++))) }
        yield* Scope.provide(outer)(first.engine.forCore("core.test").handle("hold", hold))
        const job = yield* first.engine.forCore("core.test").schedule({ handler: "hold", inMs: 0 })
        yield* first.advance(0)
        assert.strictEqual(first.engine.runsInFlight(), 1)
        yield* first.stop
        assert.strictEqual(interrupted, 1)
        assert.strictEqual(first.engine.runsInFlight(), 0)
        yield* Deferred.succeed(gate, undefined)
        for (let i = 0; i < 100; i++) yield* Effect.yieldNow
        assert.isFalse(effectAfter)
        assert.strictEqual((yield* store.forCore(SCHEDULER_OWNER).collection(jobs).get(job.id))?.value.state, "running")
        yield* Scope.close(outer, Exit.void)
        // A registration closing while its handler runs: interrupted, and nothing is left running in this process.
        const second = yield* engineOn(store)
        const gate2 = yield* Deferred.make<void>()
        const reg = yield* Scope.make()
        yield* Scope.provide(reg)(second.engine.forCore("core.test").handle("hold2", { payload: Schema.Unknown, run: () => Deferred.await(gate2).pipe(Effect.onInterrupt(() => Effect.sync(() => void interrupted++))) }))
        yield* second.engine.forCore("core.test").schedule({ handler: "hold2", inMs: 0 })
        yield* second.advance(0)
        assert.strictEqual(second.engine.runsInFlight(), 1)
        yield* Scope.close(reg, Exit.void)
        assert.strictEqual(interrupted, 2)
        assert.strictEqual(second.engine.runsInFlight(), 0)
      }))

    it.effect("ctx.scheduler of a host without an engine: every call, handle too, stops with ModuleStopped once the part has closed", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store, [{ id: "kit", storage: { collections: [notes] } }])
        const held: { scheduler?: ModuleScheduler } = {}
        const kit = kitModule("kit", (s) => s.handle("ring", { payload: Schema.Unknown, run: () => Effect.void }), held)
        const host = yield* makeModuleHost({ catalog: [kit], persistence: readOnlyPersistence(), env: {}, household: { store, events: makeEventBus() }, graceMs: 0 })
        yield* host.startEnabled
        const live = failureOf(yield* Effect.exit(held.scheduler!.list()))
        assert.strictEqual((live as SchedulerError).reason, "unavailable")
        const old = held.scheduler!
        yield* host.disable("kit")
        for (const call of [old.handle("ring", { payload: Schema.Unknown, run: () => Effect.void }), old.list(), old.get("x"), old.schedule({ handler: "ring", inMs: 0 }), old.prepare({ handler: "ring", inMs: 0 }), old.cancel("x"), old.reschedule("x", { inMs: 0 })]) {
          const stopped = yield* Effect.exit(call as Effect.Effect<unknown, unknown>)
          assert.isTrue(Exit.isFailure(stopped) && isModuleStopped(Cause.squash(stopped.cause)))
        }
      }))

    it.effect("admin cursors belong to their engine: one from before a restart is refused, even after the new engine gave out others", () =>
      Effect.gen(function*() {
        const opened = yield* open()
        const store = yield* prepared(opened.store)
        const first = yield* engineOn(store)
        for (let i = 0; i < 12; i++) yield* first.engine.forCore("core.test").schedule({ handler: "ping", inMs: (i + 1) * MINUTE })
        const saved = (yield* first.engine.listAll({ limit: 2 })).next!
        yield* first.stop
        const second = yield* engineOn(store)
        for (let i = 0; i < 20; i++) yield* second.engine.listAll({ limit: 2 + (i % 6) })
        const old = failureOf(yield* Effect.exit(second.engine.listAll({ cursor: saved })))
        assert.strictEqual((old as SchedulerError).reason, "invalid")
        // A cursor of this engine continues where its page ended.
        const page1 = yield* second.engine.listAll({ limit: 2 })
        const page2 = yield* second.engine.listAll({ limit: 2, cursor: page1.next! })
        assert.deepStrictEqual(page2.jobs.map((v) => v.job.dueAt), [3 * MINUTE, 4 * MINUTE])
      }))
  })

const HOUR_MS = 60 * MINUTE

// ---------------------------------------------------------------------------------------------------------------------
// The model

const MODEL_SCENARIOS = 12
const MODEL_STEPS = 40

/** A small seeded generator (mulberry32). */
const randomFrom = (seed: number) => {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)]! }
}

type ModelHandler = "ok" | "bad" | "flaky" | "hold" | "holdi"
const HOLD_MS = 3 * SECOND
const EVERY_MS = 5 * SECOND

/** One job as the model sees it. Independent of the engine: only these rules. */
interface ModelJob {
  state: "scheduled" | "running" | "done" | "failed" | "cancelled" | "missed"
  dueAt: number
  attempt: number
  occurrenceAt: number | undefined
  readonly cron: boolean
  readonly handler: ModelHandler
  readonly withinMs: number | undefined
  readonly key: string | undefined
  calls: number
  /** The end of the current claim's run (hold handlers), while it is alive. */
  runEnd: number | undefined
}

const idempotentOf = (h: ModelHandler) => h === "flaky" || h === "holdi"
const RETRIES = 1

const modelScenario = (open: OpenStore, seed: number) =>
  Effect.scoped(Effect.gen(function*() {
    const rnd = randomFrom(seed)
    const opened = yield* open()
    let store = yield* prepared(opened.store)
    const calls = new Map<string, number>()
    const count = (due: DueInfo) => Effect.sync(() => void calls.set(due.jobId, (calls.get(due.jobId) ?? 0) + 1))
    const handlers = (core: CoreScheduler) =>
      Effect.gen(function*() {
        const scope = yield* Scope.make()
        const reg = <P, I>(name: ModelHandler, h: Parameters<CoreScheduler["handle"]>[1] & { readonly payload: Schema.Codec<P, I> }) => Scope.provide(scope)(core.handle(name, h))
        yield* reg("ok", { payload: Schema.Unknown, run: (_p, due) => count(due) })
        yield* reg("bad", { payload: Schema.Unknown, run: (_p, due) => Effect.andThen(count(due), Effect.fail("bad")) })
        yield* reg("flaky", { payload: Schema.Unknown, idempotent: true, retries: RETRIES, run: (_p, due) => Effect.andThen(count(due), due.attempt === 1 ? Effect.fail("flaky") : Effect.void) })
        yield* reg("hold", { payload: Schema.Unknown, run: (_p, due) => Effect.andThen(count(due), Effect.sleep(HOLD_MS)) })
        yield* reg("holdi", { payload: Schema.Unknown, idempotent: true, retries: RETRIES, run: (_p, due) => Effect.andThen(count(due), Effect.sleep(HOLD_MS)) })
        return Scope.close(scope, Exit.void)
      })
    let e = yield* engineOn(store, { retryBaseMs: SECOND })
    let core = e.engine.forCore("core.model")
    let withdraw: Effect.Effect<void> | undefined = yield* handlers(core)
    const model = new Map<string, ModelJob>()
    let t = yield* Clock.currentTimeMillis

    const next5 = (at: number) => (Math.floor(at / EVERY_MS) + 1) * EVERY_MS
    const last5 = (at: number) => Math.floor(at / EVERY_MS) * EVERY_MS
    const moveOn = (j: ModelJob, from: number) => {
      j.state = "scheduled"
      j.dueAt = next5(from)
      j.attempt = 0
      j.occurrenceAt = undefined
      j.runEnd = undefined
    }
    const finalFailure = (j: ModelJob, at: number) => {
      if (j.cron) moveOn(j, Math.max(at, j.occurrenceAt ?? j.dueAt))
      else {
        j.state = "failed"
        j.occurrenceAt = undefined
        j.runEnd = undefined
      }
    }
    const succeed = (j: ModelJob, at: number) => {
      if (j.cron) moveOn(j, Math.max(at, j.occurrenceAt ?? j.dueAt))
      else {
        j.state = "done"
        j.occurrenceAt = undefined
        j.runEnd = undefined
      }
    }
    const fail = (j: ModelJob, at: number) => {
      if (idempotentOf(j.handler) && j.attempt <= RETRIES) {
        j.state = "scheduled"
        j.dueAt = at + SECOND * 2 ** Math.max(0, j.attempt - 1)
        j.runEnd = undefined
      } else finalFailure(j, at)
    }
    /** Everything due at `t` while the handlers are published, until nothing changes. */
    const runDue = (up: boolean) => {
      for (let changed = true; changed;) {
        changed = false
        for (const j of model.values()) {
          if (j.state === "running" && j.runEnd !== undefined && j.runEnd <= t) {
            j.runEnd = undefined
            succeed(j, t)
            changed = true
          }
          if (!up || j.state !== "scheduled" || j.dueAt > t) continue
          const occurrence = j.occurrenceAt ?? (j.cron ? Math.max(j.dueAt, last5(t)) : j.dueAt)
          if (j.withinMs !== undefined && t - occurrence > j.withinMs) {
            if (j.cron) moveOn(j, t)
            else {
              j.state = "missed"
              j.occurrenceAt = undefined
            }
            changed = true
            continue
          }
          j.state = "running"
          j.attempt++
          j.occurrenceAt = occurrence
          j.dueAt = occurrence
          j.calls++
          changed = true
          if (j.handler === "ok") succeed(j, t)
          else if (j.handler === "bad") fail(j, t)
          else if (j.handler === "flaky") j.attempt === 1 ? fail(j, t) : succeed(j, t)
          else j.runEnd = t + HOLD_MS
        }
      }
    }
    /** The recovery rule, for every running row without a run (after a stop or a crash, once published again). */
    const recover = () => {
      for (const j of model.values()) {
        if (j.state !== "running" || j.runEnd !== undefined) continue
        if (idempotentOf(j.handler) && j.attempt <= RETRIES) {
          j.state = "scheduled"
          j.dueAt = t
        } else finalFailure(j, t)
      }
    }
    const killRuns = () => {
      for (const j of model.values()) j.runEnd = undefined
    }
    const where = (step: number, what: string) => `seed ${seed}, step ${step} (${what}), t=${t}`
    const compare = (step: number, what: string) =>
      Effect.gen(function*() {
        for (const [id, j] of model) {
          const row = yield* core.get(id)
          const at = where(step, what)
          assert.strictEqual(row?.state, j.state, `${at}: ${id} (${j.handler}${j.cron ? ", cron" : ""}) state`)
          assert.strictEqual(row?.attempt, j.attempt, `${at}: ${id} attempt`)
          if (j.state === "scheduled" || j.state === "running") assert.strictEqual(row?.dueAt, j.dueAt, `${at}: ${id} dueAt`)
          assert.strictEqual(calls.get(id) ?? 0, j.calls, `${at}: ${id} handler calls`)
        }
      })

    let up = true
    for (let step = 0; step < MODEL_STEPS; step++) {
      const op = rnd.int(10)
      let what = "advance"
      const live = [...model.entries()].filter(([, j]) => j.state === "scheduled" || j.state === "running")
      if (op <= 3 && live.length < 16) {
        const handler = rnd.pick<ModelHandler>(["ok", "bad", "flaky", "hold", "holdi"])
        const cron = rnd.int(4) === 0
        const withinMs = rnd.int(3) === 0 ? 2 * SECOND : undefined
        const key = rnd.int(4) === 0 ? rnd.pick(["a", "b"]) : undefined
        const inMs = rnd.int(4) * SECOND
        what = `schedule ${handler}${cron ? " cron" : ` in ${inMs}`}${key !== undefined ? ` key ${key}` : ""}`
        const job = yield* core.schedule({
          handler,
          ...(cron ? { cron: "*/5 * * * * *", timeZone: "UTC" } : { inMs }),
          ...(withinMs !== undefined ? { late: { withinMs } } : {}),
          ...(key !== undefined ? { key } : {})
        })
        if (key !== undefined) {
          for (const j of model.values()) {
            if (j.key === key && (j.state === "scheduled" || j.state === "running")) {
              j.state = "cancelled"
              j.runEnd = undefined
            }
          }
        }
        model.set(job.id, { state: "scheduled", dueAt: job.dueAt, attempt: 0, occurrenceAt: undefined, cron, handler, withinMs, key, calls: 0, runEnd: undefined })
        runDue(up)
      } else if (op === 4 && model.size > 0) {
        const [id, j] = rnd.pick([...model.entries()])
        what = `cancel ${id}`
        const was = j.state
        const done = yield* core.cancel(id)
        assert.strictEqual(done, was === "scheduled" || was === "running" || was === "failed", where(step, what))
        if (done) {
          j.state = "cancelled"
          j.runEnd = undefined
        }
      } else if (op === 5 && live.length > 0) {
        const [id, j] = rnd.pick(live)
        const inMs = rnd.int(3) * SECOND
        what = `reschedule ${id} in ${inMs}`
        yield* core.reschedule(id, { inMs })
        j.state = "scheduled"
        j.dueAt = t + inMs
        j.attempt = 0
        j.occurrenceAt = undefined
        j.runEnd = undefined
        runDue(up)
      } else if (op === 6) {
        what = up ? "stop" : "start"
        if (up) {
          yield* withdraw!
          withdraw = undefined
          killRuns()
        } else {
          withdraw = yield* handlers(core)
          recover()
        }
        up = !up
        runDue(up)
      } else if (op === 7) {
        what = "crash"
        yield* e.stop
        killRuns()
        store = yield* prepared(yield* opened.reopen)
        e = yield* engineOn(store, { retryBaseMs: SECOND })
        core = e.engine.forCore("core.model")
        withdraw = up ? yield* handlers(core) : undefined
        if (up) recover()
        runDue(up)
      }
      yield* e.engine.settled
      if (globalThis.process?.env.PVA_MODEL_TRACE !== undefined) console.log(where(step, what), up)
      yield* compare(step, what)
      yield* e.advance(SECOND)
      t += SECOND
      runDue(up)
      yield* compare(step, `${what}, then 1 s`)
    }
    yield* e.stop
  }))
