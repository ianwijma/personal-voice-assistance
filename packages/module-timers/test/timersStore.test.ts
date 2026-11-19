// The timers module's data, jobs and service: a restart between two steps, a ring found late after an outage, one
// change at a time (a tool, a press and the ring job), a store that is busy or fails part-way, the `Timers` service
// against its contract, paging past one store page, the ambient line, invalid settings, the daily clean-up, and that
// timers are household data on every kind of device.
import { assert, describe, it } from "@effect/vitest"
import { type ModuleStore, type NotifyActionHandler, type Row, StoreError, type StoreFailure } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Timers, TIMERS_LIMITS, type TimersService } from "@pva/module-contracts"
import { Effect, Fiber } from "effect"
import { type Timer, timers, timersModule } from "../src/index.ts"

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)
const MIN = 60_000

/** What a test does to the store underneath the module (a test's own wrapper of `ctx.store`). */
interface Hooks {
  /** Every write (a transaction, an insert, an update, a remove) fails with this, writing nothing. */
  writesFail?: StoreFailure | undefined
  /** The `n`-th row write inside one transaction throws this: the transaction rolls back after a write. */
  throwAtWrite?: { readonly n: number; readonly failure: StoreFailure } | undefined
  /** Updates outside a transaction fail with this, this many times. */
  updatesFail?: { times: number; readonly failure: StoreFailure } | undefined
}

const hookStore = (raw: ModuleStore, hooks: Hooks): ModuleStore => ({
  moduleId: raw.moduleId,
  readOnly: raw.readOnly,
  collection: (c) => {
    const h = raw.collection(c)
    const write = <A, E>(effect: () => Effect.Effect<A, E>): Effect.Effect<A, E | StoreFailure> =>
      Effect.suspend((): Effect.Effect<A, E | StoreFailure> => (hooks.writesFail !== undefined ? Effect.fail(hooks.writesFail) : effect()))
    return {
      ...h,
      insert: (v, o) => write(() => h.insert(v, o)),
      remove: (id, o) => write(() => h.remove(id, o)),
      update: (id, f, o) =>
        write(() => {
          const u = hooks.updatesFail
          if (u !== undefined && u.times > 0) {
            u.times--
            return Effect.fail(u.failure)
          }
          return h.update(id, f, o)
        })
    } as typeof h
  },
  transaction: (f) =>
    Effect.suspend(() => {
      if (hooks.writesFail !== undefined) return Effect.fail(hooks.writesFail)
      const at = hooks.throwAtWrite
      if (at === undefined) return raw.transaction(f)
      let writes = 0
      const count = () => {
        if (++writes === at.n) throw at.failure
      }
      return raw.transaction((tx) =>
        f({
          ...tx,
          collection: (c: any) => {
            const t = tx.collection(c)
            return {
              ...t,
              insert: (v: any, o: any) => (count(), t.insert(v, o)),
              update: (id: string, g: any, o: any) => (count(), t.update(id, g, o))
            }
          }
        } as typeof tx)
      )
    })
})

/** The action handlers the module registered, as it registered them (a test's own record). */
type Handlers = Map<string, NotifyActionHandler>

const hooked = (hooks: Hooks, notifyDelayMs = 0, handlers?: Handlers): typeof timersModule => ({
  ...timersModule,
  shared: (ctx) =>
    timersModule.shared!({
      ...ctx,
      store: hookStore(ctx.store, hooks),
      notify: {
        ...ctx.notify,
        ...(notifyDelayMs === 0 ? {} : { send: (r: Parameters<typeof ctx.notify.send>[0]) => Effect.andThen(Effect.sleep(notifyDelayMs), ctx.notify.send(r)) }),
        handle: (name: string, handler: NotifyActionHandler) => Effect.andThen(Effect.sync(() => void handlers?.set(name, handler)), ctx.notify.handle(name, handler))
      }
    })
})

const activeRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(timers).list({ where: { phase: "active" } })
const liveRingJobs = (kit: { jobs: Effect.Effect<ReadonlyArray<{ readonly handler: string; readonly state: string }>> }) =>
  Effect.map(kit.jobs, (jobs) => jobs.filter((j) => j.handler === "ring" && (j.state === "scheduled" || j.state === "running")))

describe("restarts and outages", () => {
  it.effect("a timer outlives a restart of the module: it rings after it, and its countdown is taken down by its key", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      yield* kit.action("start", { duration: "20 minutes", name: "rice" })
      yield* kit.restart
      yield* kit.present.settle
      // Pinned countdowns stay through the restart.
      assert.strictEqual(kit.present.shown("kitchen-display").length, 2)
      // The new part never showed rice's countdown: cancelling it still takes it down.
      assert.strictEqual(said(yield* kit.action("cancel", { name: "rice" })), "Rice timer cancelled.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => (p.content.kind === "timer" ? p.content.label : "")), ["Pasta timer"])
      yield* kit.advance(10 * MIN)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display")[0]?.title, "Pasta timer is done")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("a timer due while the module was off rings when it is back, saying how late", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      const due = (yield* kit.now) + 10 * MIN
      yield* kit.stop
      yield* kit.advance(13 * MIN)
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      yield* kit.start
      yield* kit.advance(0)
      const sent = (yield* kit.notify.all).filter((n) => n.key?.startsWith("timer:"))
      assert.strictEqual(sent.length, 1)
      assert.strictEqual(sent[0]!.text, "The 10 minutes timer ended 3 minutes ago, while I couldn't ring.")
      assert.strictEqual(sent[0]!.sentAt - due, 3 * MIN)
    }))
})

describe("one change at a time", () => {
  it.effect("a cancel made while the ring job is sending waits for it, then stops the ring it sent", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(hooked({}, 2_000))
      yield* kit.action("start", { duration: "1 minute", name: "eggs" })
      // The job starts at its due time and waits inside its send; the cancel comes meanwhile.
      yield* kit.advance(MIN + 500)
      const cancel = yield* Effect.forkChild(kit.action("cancel", {}))
      yield* kit.advance(2_000)
      const answer = yield* Fiber.join(cancel)
      assert.strictEqual(said(answer), "Eggs timer stopped.")
      yield* kit.notify.settle
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.strictEqual((yield* kit.moduleStore().collection(timers).list({}))[0]?.value.state, "rang")
    }))

  it.effect("a job called off before it runs finds the row changed and does nothing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "1 minute", name: "eggs" })
      const job = (yield* liveRingJobs(kit))[0] as unknown as { readonly id: string }
      yield* kit.action("pause", {})
      // Run the old job by hand: the row is paused and names no job, so nothing rings.
      yield* kit.runJob(job.id).pipe(Effect.ignore)
      yield* kit.notify.settle
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      assert.strictEqual((yield* activeRows(kit))[0]?.value.state, "paused")
    }))

  it.effect("two adjusts at once from two devices: both apply, one after the other", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "10 minutes", name: "pasta" })
      const [a, b] = yield* Effect.all([
        kit.action("adjust", { amount: "1 minute" }, { device: "kitchen-display" }),
        kit.action("adjust", { amount: "2 minutes" }, { device: "robins-phone", conversationId: "c-robin" })
      ], { concurrency: "unbounded" })
      assert.sameMembers([said(a), said(b)], ["Pasta timer: 11 minutes left.", "Pasta timer: 13 minutes left."])
      assert.strictEqual(said(yield* kit.action("list", {})), "Pasta timer: 13 minutes left.")
      assert.strictEqual((yield* liveRingJobs(kit)).length, 1)
    }))

  it.effect("a press handled once per notification: after a store failure it runs again; run twice, it changes nothing twice", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const handlers: Handlers = new Map()
      const kit = yield* startTestModule(hooked(hooks, 0, handlers))
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      const [ring] = kit.notify.engine.ringingOn("kitchen-display")
      // The handler's write fails: the card stays, with the busy sentence.
      hooks.writesFail = new StoreError({ reason: "busy", message: "test: busy" })
      assert.deepStrictEqual(yield* kit.notify.press(ring!.id, "more", { device: "kitchen-display" }), { ok: true, say: "The timers are busy just now; try again in a moment." })
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
      hooks.writesFail = undefined
      assert.deepStrictEqual(yield* kit.notify.press(ring!.id, "more", { device: "kitchen-display" }), { ok: true, say: "Tea timer: five more minutes." })
      const after = (yield* activeRows(kit))[0]!
      const jobs = yield* liveRingJobs(kit)
      // The same press's handler run again (as after its outcome could not be written): the same answer, no change.
      const press = { notificationId: ring!.id, actionId: "more", key: `timer:${after.id}`, deviceId: "kitchen-display" }
      assert.deepStrictEqual(yield* handlers.get("timer")!.run(press), { say: "Tea timer: five more minutes." })
      assert.deepStrictEqual(yield* handlers.get("timer")!.run({ ...press, actionId: "snooze" }), { say: "Tea timer rings again in 5 minutes." })
      assert.strictEqual((yield* activeRows(kit))[0]!.rev, after.rev)
      assert.deepStrictEqual(yield* liveRingJobs(kit), jobs)
      // A notification that is not the timer's (an old card, a made-up id): nothing changes either.
      assert.deepStrictEqual(yield* handlers.get("timer")!.run({ ...press, notificationId: "n-other" }), { say: "Tea timer: five more minutes." })
      assert.deepStrictEqual(yield* handlers.get("timer")!.run({ ...press, key: "timer:gone" }), { say: "That timer is gone." })
      assert.strictEqual((yield* activeRows(kit))[0]!.rev, after.rev)
    }))
})

describe("a store that is busy or fails", () => {
  it.effect("busy: the busy sentence, and nothing is stored or scheduled", () =>
    Effect.gen(function*() {
      const hooks: Hooks = { writesFail: new StoreError({ reason: "busy", message: "test: busy" }) }
      const kit = yield* startTestModule(hooked(hooks))
      assert.deepStrictEqual(yield* kit.action("start", { duration: "10 minutes" }), { ok: false, code: "failed", message: "The timers are busy just now; try again in a moment." })
      assert.deepStrictEqual(yield* kit.moduleStore().collection(timers).list({}), [])
      assert.deepStrictEqual(yield* liveRingJobs(kit), [])
      hooks.writesFail = new StoreError({ reason: "failed", message: "test: failed" })
      assert.deepStrictEqual(yield* kit.action("start", { duration: "10 minutes" }), { ok: false, code: "failed", message: "That didn't work with the timers; try again." })
    }))

  it.effect("a failure part-way through a transaction: cancel all changes nothing at all", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(hooked(hooks))
      for (const name of ["a", "b", "c"]) yield* kit.action("start", { duration: "10 minutes", name })
      hooks.throwAtWrite = { n: 2, failure: new StoreError({ reason: "failed", message: "test: mid-write" }) }
      assert.strictEqual(said(yield* kit.action("cancel", { all: true })), "That didn't work with the timers; try again.")
      hooks.throwAtWrite = undefined
      assert.strictEqual((yield* activeRows(kit)).length, 3)
      assert.strictEqual((yield* liveRingJobs(kit)).length, 3)
      // A start whose row write fails after its job was prepared: neither the row nor the job.
      hooks.throwAtWrite = { n: 1, failure: new StoreError({ reason: "busy", message: "test: busy" }) }
      assert.strictEqual(said(yield* kit.action("start", { duration: "1 minute", name: "d" })), "The timers are busy just now; try again in a moment.")
      hooks.throwAtWrite = undefined
      assert.strictEqual((yield* activeRows(kit)).length, 3)
      assert.strictEqual((yield* liveRingJobs(kit)).length, 3)
    }))

  it.effect("the ring job whose row write fails is run again: one notification, rung once", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(hooked(hooks))
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.updatesFail = { times: 1, failure: new StoreError({ reason: "busy", message: "test: busy" }) }
      yield* kit.advance(MIN)
      // Its first run sent the ring and could not mark the row; the retry finds the ring open by its key.
      yield* kit.advance(10_000)
      const sent = (yield* kit.notify.all).filter((n) => n.key?.startsWith("timer:"))
      assert.strictEqual(sent.length, 1)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
      assert.strictEqual((yield* kit.moduleStore().collection(timers).list({}))[0]?.value.notification, sent[0]!.id)
    }))
})

describe("the Timers service", () => {
  it.effect("start: the turn's device, or the one given; the bounds; the errors of the contract", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      const service = kit.service(Timers) as TimersService
      const info = yield* kit.asTurn(service.start({ durationMs: 8 * MIN, label: "Rice, step 4" }), { device: "robins-phone" })
      assert.strictEqual(info.label, "Rice, step 4")
      assert.strictEqual(info.durationMs, 8 * MIN)
      assert.deepStrictEqual(info.ringOn, { deviceId: "robins-phone" })
      assert.strictEqual(info.dueAt, (yield* kit.now) + 8 * MIN)
      const other = yield* kit.asTurn(service.start({ durationMs: MIN, ringOn: { deviceId: "hall-screen" } }), { device: "robins-phone" })
      assert.strictEqual(other.label, "timer")
      // It is a timer like any other: listed, and it rings where it was asked to.
      assert.strictEqual(said(yield* kit.action("list", { name: "Rice, step 4" })), "Rice, step 4 timer: 8 minutes left.")
      yield* kit.advance(MIN)
      assert.strictEqual(kit.notify.engine.ringingOn("hall-screen").length, 1)
      assert.deepStrictEqual(kit.notify.engine.ringingOn("robins-phone"), [])
      const reason = (request: Parameters<TimersService["start"]>[0], as?: { device: string }) =>
        Effect.map(Effect.flip(as === undefined ? service.start(request) : kit.asTurn(service.start(request), as)), (e) => e.reason)
      assert.strictEqual(yield* reason({ durationMs: 999 }, { device: "robins-phone" }), "invalid")
      assert.strictEqual(yield* reason({ durationMs: TIMERS_LIMITS.maxMs + 1 }, { device: "robins-phone" }), "invalid")
      assert.strictEqual(yield* reason({ durationMs: 1_000.5 }, { device: "robins-phone" }), "invalid")
      assert.strictEqual(yield* reason({ durationMs: MIN, label: "" }, { device: "robins-phone" }), "invalid")
      assert.strictEqual(yield* reason({ durationMs: MIN, label: "a\nb" }, { device: "robins-phone" }), "invalid")
      assert.strictEqual(yield* reason({ durationMs: MIN, label: "x".repeat(61) }, { device: "robins-phone" }), "invalid")
      assert.strictEqual(yield* reason({ durationMs: MIN, ringOn: { deviceId: "bad id" } }, { device: "robins-phone" }), "invalid")
      assert.strictEqual(yield* reason({ durationMs: MIN }), "no_device")
      assert.strictEqual(yield* reason({ durationMs: MIN, ringOn: { deviceId: "nobodys-device" } }, { device: "robins-phone" }), "unknown_device")
    }))

  it.effect("at most 50 running timers: the 51st is limit, by the service and by voice; the list reads past one store page", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      const service = kit.service(Timers) as TimersService
      for (let i = 0; i < TIMERS_LIMITS.running; i++) yield* kit.asTurn(service.start({ durationMs: (i + 1) * MIN, label: `t${i}` }))
      assert.strictEqual((yield* Effect.flip(kit.asTurn(service.start({ durationMs: MIN })))).reason, "limit")
      assert.strictEqual(said(yield* kit.action("start", { duration: "1 minute" })), "There are already 50 timers running, the most I keep. Cancel one first.")
      // 50 rows: past one store page (16 a page), every one counted.
      assert.strictEqual(said(yield* kit.action("list", {})), "50 timers: t0 timer with 1 minute left, t1 timer with 2 minutes left, t2 timer with 3 minutes left and 47 more.")
      // The last one, by name, past the first pages.
      assert.strictEqual(said(yield* kit.action("list", { name: "t49" })), "T49 timer: 50 minutes left.")
      assert.strictEqual(said(yield* kit.action("cancel", { all: true })), "Cancelled 50 timers.")
      assert.deepStrictEqual(yield* liveRingJobs(kit), [])
    }))

  it.effect("the provider stopped: the service is gone", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      assert.isDefined(kit.service(Timers))
      yield* kit.stop
      assert.isUndefined(kit.service(Timers))
    }))
})

describe("data", () => {
  it.effect("a row with every indexed field at its largest is stored", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      const largest: Timer = {
        name: "\"".repeat(60),
        durationMs: TIMERS_LIMITS.maxMs,
        state: "cancelled",
        phase: "active",
        snoozed: true,
        dueAt: 8_640_000_000_000_000,
        leftMs: TIMERS_LIMITS.maxMs,
        deviceId: "\\".repeat(64),
        room: "\"".repeat(60),
        job: "\"".repeat(64),
        notification: "\"".repeat(64),
        press: "\"".repeat(64),
        endedAt: 8_640_000_000_000_000
      }
      yield* kit.moduleStore().collection(timers).insert(largest)
      yield* kit.moduleStore().collection(timers).insert({ ...largest, phase: "ended" })
      assert.strictEqual((yield* kit.moduleStore().collection(timers).list({ where: { phase: "ended" }, orderBy: { field: "endedAt" } })).length, 1)
      assert.strictEqual((yield* activeRows(kit)).length, 1)
    }))

  it.effect("the daily clean-up removes ended timers older than a day, as the job, across a restart", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      yield* kit.action("start", { duration: "1 minute", name: "old" })
      yield* kit.action("cancel", {})
      yield* kit.advance(25 * 3_600_000)
      yield* kit.action("start", { duration: "1 minute", name: "fresh" })
      yield* kit.action("cancel", {})
      yield* kit.action("start", { duration: "2 hours", name: "running" })
      yield* kit.restart
      const job = (yield* kit.jobs).find((j) => j.handler === "cleanup" && j.state === "scheduled")
      assert.strictEqual(job?.cron, "17 4 * * *")
      yield* kit.runJob(job!.id)
      const names = (yield* kit.moduleStore().collection(timers).list({})).map((r) => r.value.name).sort()
      assert.deepStrictEqual(names, ["fresh", "running"])
      // The removal is written as the job.
      assert.isTrue(kit.events.some((e) => e.type === "timers.timers.changed" && e.actor?.kind === "job" && e.actor.jobId === job!.id))
    }))

  it.effect("the ambient line: at most three running timers of the rows read, never a claim about the rest", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule)
      for (const name of ["pasta", "eggs", "rice", "bread"]) {
        yield* kit.action("start", { duration: "10 minutes", name })
        yield* kit.advance(1_000)
      }
      yield* kit.action("pause", { name: "rice" })
      const rows = yield* kit.moduleStore().collection(timers).list({ limit: 10 })
      const now = yield* kit.now
      const line = timers.ambient!(rows as ReadonlyArray<Row<Timer>>, { now, turn: undefined })
      assert.strictEqual(line, "Timers running (most recently changed): rice timer paused with 9 minutes 58 seconds left, bread timer with 9 minutes 59 seconds left, eggs timer with 9 minutes 57 seconds left, and 1 more.")
      assert.isUndefined(timers.ambient!([], { now, turn: undefined }))
      yield* kit.action("cancel", { all: true })
      assert.isUndefined(timers.ambient!((yield* kit.moduleStore().collection(timers).list({ limit: 10 })) as ReadonlyArray<Row<Timer>>, { now, turn: undefined }))
    }))

  it.effect("invalid settings: the module does not run with them; a good change applies", () =>
    Effect.gen(function*() {
      for (const bad of [{ snoozeMinutes: 0 }, { snoozeMinutes: 31 }, { snoozeMinutes: 1.5 }, { ringMinutes: 0 }, { ringMinutes: 121 }]) {
        const kit = yield* startTestModule(timersModule, { settings: bad })
        assert.notStrictEqual(kit.info()?.state, "running", JSON.stringify(bad))
        assert.isFalse((yield* kit.action("list", {})).ok)
      }
      const kit = yield* startTestModule(timersModule)
      yield* kit.configure({ ringMinutes: 1 })
      assert.strictEqual(kit.info()?.state, "running")
      yield* kit.action("start", { duration: "1 minute" })
      yield* kit.advance(MIN)
      assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
      // It stops ringing by itself after the minute the setting gives it.
      yield* kit.advance(MIN)
      yield* kit.notify.settle
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
    }))

  it.effect("household data: every device hears the same, whatever its privacy, with or without a default person", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(timersModule, {
        household: {
          devices: [
            { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
            { id: "robins-phone", name: "Robin's phone", privacy: "private", defaultPerson: "p-robin" },
            { id: "hall-screen", name: "Hall screen", privacy: "public", defaultPerson: null },
            { id: "porch-screen", name: "Porch screen", privacy: "public", defaultPerson: "p-alex" },
            { id: "living-room-speaker", name: "Living room", privacy: "shared", defaultPerson: null }
          ]
        }
      })
      yield* kit.action("start", { duration: "10 minutes", name: "pills" }, { device: "robins-phone" })
      for (const device of ["kitchen-display", "robins-phone", "hall-screen", "porch-screen", "living-room-speaker"]) {
        assert.strictEqual(said(yield* kit.action("list", {}, { device })), "Pills timer: 10 minutes left.", device)
      }
      // A device without a room: its countdown shows on that device only.
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("robins-phone").length, 1)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // Nothing it stores names a person.
      const rows = JSON.stringify((yield* kit.moduleStore().collection(timers).list({})).map((r) => r.value))
      for (const person of ["p-sam", "p-robin", "p-alex"]) assert.notInclude(rows, person)
    }))
})
