// What review round 1 found (docs/modules/timers.md and alarms.md, "Review"), one test or more per finding, through the
// real kit with a test's own wrapper of the store, the notification service and the Presenter (support.ts).
import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { CurrentJob, type JobRow, type ModuleStore, type Row, StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Timers, type TimersService } from "@pva/module-contracts"
import { Deferred, Effect, Fiber } from "effect"
import { type Alarm, alarms, alarmsModule, type Timer, timers, timersModule } from "../src/index.ts"
import { busyFailure, hooked, type Hooks, limitFailure, makeHooks, makeRegistered, presentFailure, type Registered } from "./support.ts"

vi.setConfig({ testTimeout: 30_000 })

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)
const MIN = 60_000
const HOUR = 60 * MIN
// The kit's clock starts on Wednesday 18 November 2026, 10:00 in Amsterdam (09:00 UTC).
const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 1, minute)
const storeBusy = () => new StoreError({ reason: "busy", message: "test: busy" })

const timerRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(timers).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 13 })
const alarmRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(alarms).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 10 })
const liveDue = (kit: { jobs: Effect.Effect<ReadonlyArray<JobRow>> }) => Effect.map(kit.jobs, (jobs) => jobs.filter((j) => j.handler === "due" && (j.state === "scheduled" || j.state === "running")))
const timerKit = (hooks: Hooks, registered?: Registered) => startTestModule(hooked(timersModule, hooks, registered))
const alarmKit = (hooks: Hooks, registered?: Registered, options?: Parameters<typeof startTestModule>[1]) => startTestModule(hooked(alarmsModule, hooks, registered), options)
const ringing = (kit: { notify: { engine: { ringingOn: (d: string) => ReadonlyArray<{ readonly id: string; readonly title: string }> } } }, device = "kitchen-display") => kit.notify.engine.ringingOn(device)

describe("finding 1: ten rings open and one more", () => {
  it.effect("timers: the eleventh stays owed (listed as waiting), across a restart, and rings once a place comes free", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      for (let i = 0; i < 10; i++) yield* kit.action("start", { duration: "1 minute", name: `t${i}` })
      yield* kit.action("start", { duration: "2 minutes", name: "eleven" })
      yield* kit.advance(2 * MIN)
      assert.strictEqual(ringing(kit).length, 10)
      assert.strictEqual(said(yield* kit.action("list", { name: "eleven" })), "Eleven timer is done; its ring could not be sent yet, and I keep trying.")
      // Its job is kept, tried every 30 seconds; a restart does not lose it.
      const eleven = (yield* timerRows(kit)).find((r) => r.value.name === "eleven")!
      assert.isTrue((yield* liveDue(kit)).some((j) => j.key === `timer:${eleven.id}`))
      yield* kit.restart
      yield* kit.advance(2 * MIN)
      assert.strictEqual(ringing(kit).length, 10)
      // A place comes free: one of the ten is stopped. Within 30 seconds the eleventh rings, saying how late.
      assert.isTrue((yield* kit.notify.press(ringing(kit)[0]!.id, "stop", { device: "kitchen-display" })).ok)
      yield* kit.advance(30_000)
      const eleventh = (yield* kit.notify.all).filter((n) => n.title === "Eleven timer is done")
      assert.strictEqual(eleventh.length, 1)
      assert.strictEqual(eleventh[0]!.text, "The 2 minutes timer ended two and a half minutes ago, while I couldn't ring.")
      assert.strictEqual(ringing(kit).length, 10)
    }))

  it.effect("timers: refused for its whole ring time, it is recorded missed with a Health issue, and nothing is left owed", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.configure({ ringMinutes: 2 })
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.sendFail = limitFailure()
      yield* kit.advance(MIN + 3 * MIN)
      const row = (yield* timerRows(kit))[0]!
      assert.isUndefined(row.value.owed)
      assert.isFalse(row.value.pending)
      assert.isTrue((yield* kit.jobs).some((j) => j.handler === "trouble" && j.state === "failed"))
      const issues = yield* kit.checkHealth
      assert.isTrue(issues.some((i) => JSON.stringify(i).includes("could not ring")))
    }))

  it.effect("alarms: the repeating series moves on although its ring is refused, and the ring comes once a place is free", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* alarmKit(hooks)
      for (let i = 0; i < 10; i++) yield* kit.action("set", { when: "10:01", name: `a${i}` }, { conversationId: `c${i}` })
      yield* kit.action("set", { when: "every day at 10:02", name: "daily" })
      yield* kit.advance(3 * MIN)
      assert.strictEqual(ringing(kit).length, 10)
      const daily = (yield* alarmRows(kit)).find((r) => r.value.name === "daily")!
      // The series is planned for tomorrow already, with today's ring owed.
      assert.strictEqual(daily.value.next?.at, at(19, 10, 2))
      assert.strictEqual(daily.value.owed?.at, at(18, 10, 2))
      yield* kit.restart
      assert.isTrue((yield* kit.notify.press(ringing(kit)[0]!.id, "stop", { device: "kitchen-display" })).ok)
      yield* kit.advance(30_000)
      assert.isTrue((yield* kit.notify.all).some((n) => n.title === "Daily alarm" && n.state === "open"))
      // Tomorrow it rings again: the series was never lost.
      for (const r of ringing(kit)) yield* kit.notify.press(r.id, "stop", { device: "kitchen-display" })
      yield* kit.advance(at(19, 10, 2) - (yield* kit.now))
      assert.deepStrictEqual(ringing(kit).map((r) => r.title), ["Daily alarm"])
    }))
})

describe("finding 1: an alarm refused past its late rule", () => {
  it.effect("is not rung; the missed card is sent; if that is refused too, the Health page says so; the series goes on", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* alarmKit(hooks)
      yield* kit.action("set", { when: "every day at 10:01" })
      hooks.sendFail = limitFailure()
      yield* kit.advance(MIN + 16 * MIN)
      const row = (yield* alarmRows(kit))[0]!
      assert.isUndefined(row.value.owed)
      assert.strictEqual(row.value.next?.at, at(19, 10, 1))
      assert.isTrue((yield* kit.jobs).some((j) => j.handler === "trouble" && j.state === "failed"))
      assert.isTrue((yield* kit.checkHealth).some((i) => JSON.stringify(i).includes("could not ring")))
      hooks.sendFail = undefined
      yield* kit.advance(at(19, 10, 1) - (yield* kit.now))
      assert.strictEqual(ringing(kit).length, 1)
    }))
})

describe("finding 1 (its fix): an owed ring is sent only on the timer's own device", () => {
  it.effect("while a ring is refused, other devices' requests do not send it to them; it rings on its device once it can", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" }, { device: "robins-phone", conversationId: "c-robin" })
      yield* kit.action("start", { duration: "1 hour", name: "bread" }, { device: "hall-screen", conversationId: "c-hall" })
      hooks.sendFail = limitFailure()
      yield* kit.advance(MIN)
      assert.strictEqual(said(yield* kit.action("list", {}, { device: "hall-screen", conversationId: "c-hall" })), "2 timers: tea timer is done and waiting to ring and bread timer with 59 minutes left.")
      yield* kit.action("adjust", { amount: "1 minute", name: "bread" }, { device: "hall-screen", conversationId: "c-hall" })
      hooks.sendFail = undefined
      yield* kit.advance(30_000)
      assert.strictEqual(ringing(kit, "robins-phone").length, 1)
      assert.deepStrictEqual(ringing(kit, "hall-screen"), [])
      assert.isTrue(kit.notify.decisions.filter((d) => d.decision.deliver).every((d) => d.deviceId === "robins-phone"))
    }))
})

describe("finding 2: a failure between the send and the write that records it (delivery at least once)", () => {
  it.effect("timers: a restart there records the open ring by its key: one ring", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.blockAfterSend = storeBusy()
      yield* kit.advance(MIN)
      assert.isUndefined((yield* timerRows(kit))[0]!.value.ring)
      hooks.writesFail = undefined
      yield* kit.restart
      yield* kit.advance(10_000)
      const sent = (yield* kit.notify.all).filter((n) => n.key?.startsWith("timer:"))
      assert.strictEqual(sent.length, 1)
      assert.strictEqual((yield* timerRows(kit))[0]!.value.ring?.notification, sent[0]!.id)
    }))

  it.effect("timers: Stop there, then the retry: the ring sounds a second time (the stated limit), and is recorded", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      // The store stays busy after the send until Stop has been pressed: nothing can record the ring before that.
      hooks.blockAfterSend = storeBusy()
      yield* kit.advance(MIN)
      const [first] = ringing(kit)
      assert.isTrue((yield* kit.notify.press(first!.id, "stop", { device: "kitchen-display" })).ok)
      hooks.writesFail = undefined
      yield* kit.advance(40_000)
      const sent = (yield* kit.notify.all).filter((n) => n.key?.startsWith("timer:"))
      assert.deepStrictEqual(sent.map((n) => n.key), [sent[0]!.key, sent[0]!.key])
      assert.strictEqual((yield* timerRows(kit))[0]!.value.ring?.notification, sent[1]!.id)
    }))

  it.effect("timers: Snooze there is answered that the ring has ended, never 'rings again'; it schedules nothing", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.blockAfterSend = storeBusy()
      yield* kit.advance(MIN)
      const [first] = ringing(kit)
      assert.deepStrictEqual(yield* kit.notify.press(first!.id, "snooze", { device: "kitchen-display" }), { ok: true, say: "That ring has ended." })
      hooks.writesFail = undefined
      const row = (yield* timerRows(kit))[0]!
      assert.strictEqual(row.value.state, "done")
      assert.isUndefined(row.value.snoozed)
    }))

  it.effect("timers: cancel there withdraws the ring it finds by its key", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.blockAfterSend = storeBusy()
      yield* kit.advance(MIN)
      assert.strictEqual(ringing(kit).length, 1)
      assert.isUndefined((yield* timerRows(kit))[0]!.value.ring)
      hooks.writesFail = undefined
      assert.strictEqual(said(yield* kit.action("cancel", {})), "Tea timer stopped.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
      yield* kit.advance(MIN)
      assert.deepStrictEqual(ringing(kit), [])
      assert.strictEqual((yield* kit.notify.all).length, 1)
    }))

  it.effect("alarms: a restart there records the open ring by its key: one ring", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* alarmKit(hooks)
      yield* kit.action("set", { when: "10:01" })
      hooks.blockAfterSend = storeBusy()
      yield* kit.advance(MIN)
      assert.isUndefined((yield* alarmRows(kit))[0]!.value.ring)
      hooks.writesFail = undefined
      yield* kit.restart
      yield* kit.advance(10_000)
      const sent = (yield* kit.notify.all).filter((n) => n.key?.startsWith("alarm:"))
      assert.strictEqual(sent.length, 1)
      assert.strictEqual((yield* alarmRows(kit))[0]!.value.ring?.notification, sent[0]!.id)
    }))

  it.effect("alarms: cancel between the send and its record withdraws the ring by its key", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* alarmKit(hooks)
      yield* kit.action("set", { when: "10:01" })
      hooks.blockAfterSend = storeBusy()
      yield* kit.advance(MIN)
      assert.strictEqual(ringing(kit).length, 1)
      assert.isUndefined((yield* alarmRows(kit))[0]!.value.ring)
      hooks.writesFail = undefined
      assert.strictEqual(said(yield* kit.action("cancel", {})), "The alarm's ring is stopped now.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
      yield* kit.advance(MIN)
      assert.strictEqual((yield* kit.notify.all).length, 1)
    }))
})

describe("finding 3: a press whose outcome the notification service lost", () => {
  it.effect("timers: the next ring has its own key; the old card is withdrawn; a press on the new card after a restart works", () =>
    Effect.gen(function*() {
      const registered = makeRegistered()
      const kit = yield* timerKit(makeHooks(), registered)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      const [first] = ringing(kit)
      const row = (yield* timerRows(kit))[0]!
      // The handler commits; the service never records the outcome: N1 stays open.
      assert.deepStrictEqual(yield* registered.presses.get("timer")!.run({ notificationId: first!.id, actionId: "more", key: `timer:${row.id}:1`, deviceId: "kitchen-display" }), {
        say: "Tea timer: five more minutes."
      })
      yield* kit.restart
      yield* kit.advance(5 * MIN)
      yield* kit.notify.settle
      const open = ringing(kit)
      assert.strictEqual(open.length, 1)
      assert.notStrictEqual(open[0]!.id, first!.id)
      assert.strictEqual((yield* kit.notify.all).find((n) => n.id === first!.id)?.state, "resolved")
      yield* kit.restart
      assert.deepStrictEqual(yield* kit.notify.press(open[0]!.id, "more", { device: "kitchen-display" }), { ok: true, say: "Tea timer: five more minutes." })
      yield* kit.advance(5 * MIN)
      assert.strictEqual(ringing(kit).length, 1)
    }))

  it.effect("alarms: the same", () =>
    Effect.gen(function*() {
      const registered = makeRegistered()
      const kit = yield* alarmKit(makeHooks(), registered)
      yield* kit.action("set", { when: "10:01" })
      yield* kit.advance(MIN)
      const [first] = ringing(kit)
      const row = (yield* alarmRows(kit))[0]!
      assert.deepStrictEqual(yield* registered.presses.get("alarm")!.run({ notificationId: first!.id, actionId: "more", key: `alarm:${row.id}:1`, deviceId: "kitchen-display" }), { say: "Five more minutes." })
      yield* kit.restart
      yield* kit.advance(5 * MIN)
      yield* kit.notify.settle
      const open = ringing(kit)
      assert.strictEqual(open.length, 1)
      assert.notStrictEqual(open[0]!.id, first!.id)
      yield* kit.restart
      assert.deepStrictEqual(yield* kit.notify.press(open[0]!.id, "snooze", { device: "kitchen-display" }), { ok: true, say: "It rings again in 9 minutes." })
      yield* kit.advance(9 * MIN)
      assert.strictEqual(ringing(kit).length, 1)
    }))
})

// Finding 4's check after a press, and its compensation, were removed in review round 2 (U4); review2.test.ts pins the
// stated limit instead.

describe("finding 5: withdrawing a ring that fails", () => {
  it.effect("timers: more time while ringing, with resolve failing: said as still being stopped; finished later, also after a restart", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      hooks.resolveFail = busyFailure()
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "2 minutes" })), "Tea timer runs again: 2 minutes. Its old ring is still being stopped.")
      assert.strictEqual(ringing(kit).length, 1)
      yield* kit.restart
      hooks.resolveFail = undefined
      yield* kit.advance(MIN)
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
      // Its new ring, at the new time, has its own key and is not swallowed.
      yield* kit.advance(MIN)
      assert.strictEqual(ringing(kit).length, 1)
    }))

  it.effect("timers: cancel all with resolve failing says so; a second cancel finishes the clean-up", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.action("start", { duration: "5 minutes", name: "rice" })
      yield* kit.advance(MIN)
      hooks.resolveFail = busyFailure()
      assert.strictEqual(said(yield* kit.action("cancel", { all: true })), "Cancelled 2 timers; a ring or a countdown is still being taken away, and I keep trying.")
      assert.strictEqual(ringing(kit).length, 1)
      yield* kit.restart
      hooks.resolveFail = undefined
      assert.strictEqual(said(yield* kit.action("cancel", {})), "Tea timer is stopped now.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
    }))

  it.effect("alarms: cancel with resolve failing says so; it is finished by the job, also after a restart; a second cancel finishes it", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* alarmKit(hooks)
      yield* kit.action("set", { when: "every day at 10:01" })
      yield* kit.advance(MIN)
      hooks.resolveFail = busyFailure()
      assert.strictEqual(said(yield* kit.action("cancel", { scope: "all" })), "The alarm is cancelled; its ring is still being stopped, and I keep trying.")
      assert.strictEqual(said(yield* kit.action("cancel", {})), "The alarm is cancelled; its ring is still being stopped, and I keep trying.")
      yield* kit.restart
      hooks.resolveFail = undefined
      assert.strictEqual(said(yield* kit.action("cancel", {})), "The alarm's ring is stopped now.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
      assert.deepStrictEqual(yield* liveDue(kit), [])
    }))

  it.effect("alarms: left alone, the job withdraws it a minute later after a restart", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* alarmKit(hooks)
      yield* kit.action("set", { when: "10:01" })
      yield* kit.advance(MIN)
      hooks.resolveFail = busyFailure()
      yield* kit.action("cancel", {})
      yield* kit.restart
      hooks.resolveFail = undefined
      yield* kit.advance(MIN)
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
    }))
})

describe("finding 6: the countdown when showing or taking it down fails", () => {
  it.effect("dismissal fails on pause: said; the row keeps it owed; after a restart it is taken down by its key", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 hour", name: "bread" })
      hooks.dismissFail = presentFailure()
      assert.strictEqual(said(yield* kit.action("pause", {})), "Bread timer paused with 1 hour left; its countdown is still being taken off the screen.")
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      // Paused again: the clean-up is tried again, and still said.
      assert.strictEqual(said(yield* kit.action("pause", {})), "Bread timer paused with 1 hour left; its countdown is still being taken off the screen.")
      yield* kit.restart
      hooks.dismissFail = undefined
      yield* kit.advance(MIN)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.isUndefined((yield* timerRows(kit))[0]!.value.screen)
    }))

  it.effect("dismissal fails when it rings: the countdown is taken down by the job later", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.dismissFail = presentFailure()
      yield* kit.advance(MIN)
      assert.strictEqual(ringing(kit).length, 1)
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      hooks.dismissFail = undefined
      yield* kit.advance(MIN)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("replacement fails after an adjust: tried again; after three tries the old countdown is taken down instead", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 hour", name: "bread" })
      hooks.showFail = presentFailure()
      assert.strictEqual(said(yield* kit.action("adjust", { amount: "10 minutes" })), "Bread timer: 1 hour 10 minutes left.")
      yield* kit.present.settle
      const shown = () => kit.present.shown("kitchen-display").map((p) => (p.content.kind === "timer" ? p.content.endsAt : 0))
      const start = yield* kit.now
      assert.deepStrictEqual(shown(), [start + HOUR - 0])
      yield* kit.advance(3 * MIN)
      yield* kit.present.settle
      // Never a countdown to the old instant left: none now, and the timer still rings at the new one.
      assert.deepStrictEqual(shown(), [])
      hooks.showFail = undefined
      yield* kit.advance(HOUR + 7 * MIN)
      assert.strictEqual(ringing(kit).length, 1)
    }))

  it.effect("showing fails at the start: tried again a minute later and shown", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      hooks.showFail = presentFailure()
      yield* kit.action("start", { duration: "1 hour", name: "bread" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      hooks.showFail = undefined
      yield* kit.restart
      yield* kit.advance(MIN)
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
    }))
})

describe("finding 7: a snoozed or ringing alarm is listed and can be cancelled", () => {
  it.effect("a one-off snoozed: listed with when it rings again, from another device without its name, cancelled after a restart", () =>
    Effect.gen(function*() {
      const kit = yield* alarmKit(makeHooks())
      yield* kit.action("set", { when: "10:01", name: "tea" })
      yield* kit.advance(MIN)
      assert.strictEqual(said(yield* kit.action("list", {})), "One alarm: tea, ringing now.")
      const [ring] = ringing(kit)
      yield* kit.notify.press(ring!.id, "snooze", { device: "kitchen-display" })
      assert.strictEqual(said(yield* kit.action("list", {})), "One alarm: tea, ringing again today at ten past ten in the morning.")
      assert.strictEqual(said(yield* kit.action("list", {}, { device: "hall-screen", conversationId: "c-hall" })), "One alarm: the alarm on Kitchen display, ringing again today at ten past ten in the morning.")
      yield* kit.restart
      assert.strictEqual(said(yield* kit.action("cancel", {}, { device: "hall-screen", conversationId: "c-hall" })), "The snoozed alarm is cancelled.")
      yield* kit.advance(20 * MIN)
      assert.deepStrictEqual(ringing(kit), [])
      assert.strictEqual(said(yield* kit.action("list", {})), "No alarms are set.")
    }))

  it.effect("a repeating one snoozed: 'only the next' cancels the snooze; the series goes on", () =>
    Effect.gen(function*() {
      const kit = yield* alarmKit(makeHooks())
      yield* kit.action("set", { when: "every day at 10:01" })
      yield* kit.advance(MIN)
      yield* kit.notify.press(ringing(kit)[0]!.id, "more", { device: "kitchen-display" })
      assert.strictEqual(said(yield* kit.action("list", {})), "One alarm: tomorrow at ten oh one in the morning, every day, ringing again today at ten oh six in the morning.")
      assert.strictEqual(said(yield* kit.action("cancel", { scope: "next" })), "The snoozed alarm is cancelled; the next one is tomorrow at ten oh one in the morning.")
      yield* kit.advance(10 * MIN)
      assert.deepStrictEqual(ringing(kit), [])
      yield* kit.advance(at(19, 10, 1) - (yield* kit.now))
      assert.strictEqual(ringing(kit).length, 1)
    }))
})

// Finding 8's change tests went with `alarms_change` (review round 2, U1); the nominal date is pinned in review2.test.ts.

describe("finding 9: a Home zone accepted with spaces around it", () => {
  it.effect("sets, lists and rings without a crash; exactly one alarm is stored", () =>
    Effect.gen(function*() {
      const kit = yield* alarmKit(makeHooks(), undefined, { household: { home: { HOME_LANGUAGE: "en-GB", HOME_TIME_ZONE: " Europe/Amsterdam " } } })
      assert.strictEqual(said(yield* kit.action("set", { when: "every day at seven" })), "Alarm set every day; the first one is tomorrow at seven o'clock in the morning.")
      assert.strictEqual((yield* alarmRows(kit)).length, 1)
      assert.strictEqual((yield* alarmRows(kit))[0]!.value.timeZone, "Europe/Amsterdam")
      assert.strictEqual(said(yield* kit.action("list", {})), "One alarm: tomorrow at seven o'clock in the morning, every day.")
      yield* kit.advance(at(19, 7) - (yield* kit.now))
      assert.strictEqual(ringing(kit).length, 1)
    }))
})

describe("finding 10: a missed alarm is worded from the day it is told", () => {
  it.effect("a one-off of Wednesday told on Friday says Wednesday", () =>
    Effect.gen(function*() {
      const kit = yield* alarmKit(makeHooks())
      yield* kit.action("set", { when: "10:01" })
      yield* kit.stop
      yield* kit.advance(at(20, 10) - (yield* kit.now))
      yield* kit.start
      yield* kit.advance(0)
      const missed = (yield* kit.notify.all).filter((n) => n.key?.startsWith("alarm-missed:"))
      assert.strictEqual(missed.length, 1)
      assert.strictEqual(missed[0]!.text, "The alarm for Wednesday the eighteenth of November 2026 at ten oh one in the morning could not ring.")
    }))

  it.effect("a repeating one: the latest occurrence missed, said from today (yesterday's)", () =>
    Effect.gen(function*() {
      const kit = yield* alarmKit(makeHooks())
      yield* kit.action("set", { when: "every day at 7" })
      yield* kit.stop
      yield* kit.advance(at(20, 6) - (yield* kit.now))
      yield* kit.start
      yield* kit.advance(0)
      const missed = (yield* kit.notify.all).filter((n) => n.key?.startsWith("alarm-missed:"))
      assert.strictEqual(missed.length, 1)
      assert.strictEqual(missed[0]!.text, "The alarm for yesterday at seven o'clock in the morning could not ring.")
      assert.strictEqual((yield* alarmRows(kit))[0]!.value.next?.at, at(20, 7))
    }))
})

describe("finding 11: who did it", () => {
  it.effect("a button's write is the pressing device's; a service call under a job is the job's", () =>
    Effect.gen(function*() {
      const kit = yield* timerKit(makeHooks())
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      yield* kit.notify.press(ringing(kit)[0]!.id, "more", { device: "kitchen-display" })
      assert.deepStrictEqual((yield* timerRows(kit))[0]!.updatedBy, { kind: "ui", deviceId: "kitchen-display" })
      const alarmsKit = yield* alarmKit(makeHooks())
      yield* alarmsKit.action("set", { when: "10:01" })
      yield* alarmsKit.advance(MIN)
      yield* alarmsKit.notify.press(ringing(alarmsKit)[0]!.id, "snooze", { device: "kitchen-display" })
      assert.deepStrictEqual((yield* alarmRows(alarmsKit))[0]!.updatedBy, { kind: "ui", deviceId: "kitchen-display" })
    }))

  it.effect("a Timers call from a job without ringOn: the job's device, its origin, the countdown in that device's room, the job as actor; ringOn wins", () =>
    Effect.gen(function*() {
      const kit = yield* timerKit(makeHooks())
      const service = kit.service(Timers) as TimersService
      const job = { jobId: "job_consumer", moduleId: "routines", deviceId: "robins-phone" }
      const info = yield* Effect.provideService(service.start({ durationMs: 8 * MIN, label: "rice" }), CurrentJob, job)
      assert.deepStrictEqual(info.ringOn, { deviceId: "robins-phone" })
      const row = (yield* timerRows(kit)).find((r) => r.id === info.id)!
      assert.deepStrictEqual(row.updatedBy, { kind: "job", jobId: "job_consumer" })
      assert.strictEqual(row.value.room, "Bedroom")
      assert.strictEqual((yield* liveDue(kit)).find((j) => j.key === `timer:${info.id}`)?.origin.deviceId, "robins-phone")
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("robins-phone").length, 1)
      const other = yield* Effect.provideService(service.start({ durationMs: MIN, ringOn: { deviceId: "hall-screen" } }), CurrentJob, job)
      assert.deepStrictEqual(other.ringOn, { deviceId: "hall-screen" })
    }))
})

describe("finding 12: an old job's handler, run itself, does nothing", () => {
  it.effect("timers: after a pause, a cancel and a replacement, the captured handler runs with its original identity and changes nothing", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const registered = makeRegistered()
      const kit = yield* timerKit(hooks, registered)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      const original = (yield* liveDue(kit))[0]!
      const due = { jobId: original.id, key: original.key!, dueAt: original.dueAt, lateMs: 0, attempt: 1 }
      const runOld = (when: number) =>
        Effect.gen(function*() {
          yield* kit.advance(when)
          const before = (yield* timerRows(kit))[0]!
          const runs = hooks.runs.get("due") ?? 0
          yield* registered.jobs.get("due")!.run(original.payload, due)
          assert.strictEqual(hooks.runs.get("due"), runs + 1)
          const after = (yield* timerRows(kit))[0]!
          assert.strictEqual(after.rev, before.rev)
          assert.deepStrictEqual(yield* kit.notify.all, [])
        })
      yield* kit.action("pause", {})
      yield* runOld(MIN)
      yield* kit.action("resume", {})
      yield* kit.action("adjust", { amount: "10 minutes" })
      yield* runOld(MIN)
      yield* kit.action("cancel", {})
      yield* runOld(MIN)
    }))

  it.effect("alarms: after a skipped occurrence and a cancelled snooze, the captured handler changes nothing", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const registered = makeRegistered()
      const kit = yield* alarmKit(hooks, registered)
      yield* kit.action("set", { when: "every day at 10:01" })
      const original = (yield* liveDue(kit))[0]!
      const due = { jobId: original.id, key: original.key!, dueAt: original.dueAt, lateMs: 0, attempt: 1 }
      yield* kit.action("cancel", { scope: "next" })
      yield* kit.advance(2 * MIN)
      const before = (yield* alarmRows(kit))[0]!
      yield* registered.jobs.get("due")!.run(original.payload, due)
      assert.strictEqual((yield* alarmRows(kit))[0]!.rev, before.rev)
      assert.deepStrictEqual(yield* kit.notify.all, [])
      // Tomorrow's rings; snoozed; the snooze cancelled: the old job again changes nothing.
      yield* kit.advance(at(19, 10, 1) - (yield* kit.now))
      yield* kit.notify.press(ringing(kit)[0]!.id, "snooze", { device: "kitchen-display" })
      const snoozeJob = (yield* liveDue(kit))[0]!
      yield* kit.action("cancel", { scope: "next" })
      yield* kit.advance(10 * MIN)
      const quiet = (yield* alarmRows(kit))[0]!
      yield* registered.jobs.get("due")!.run(snoozeJob.payload, { jobId: snoozeJob.id, key: snoozeJob.key!, dueAt: snoozeJob.dueAt, lateMs: 0, attempt: 1 })
      assert.strictEqual((yield* alarmRows(kit))[0]!.rev, quiet.rev)
      assert.strictEqual(hooks.runs.get("due")! >= 2, true)
      assert.deepStrictEqual(ringing(kit), [])
    }))
})

describe("finding 14 and note 15: the Timers service's own failures and decisions", () => {
  it.effect("busy and failed: the contract's reasons, and nothing half-written", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      const service = kit.service(Timers) as TimersService
      const reason = () => Effect.map(Effect.flip(kit.asTurn(service.start({ durationMs: MIN }))), (e) => e.reason)
      hooks.writesFail = storeBusy()
      assert.strictEqual(yield* reason(), "busy")
      hooks.writesFail = new StoreError({ reason: "failed", message: "test: failed" })
      assert.strictEqual(yield* reason(), "failed")
      hooks.writesFail = undefined
      hooks.throwAtWrite = { n: 1, failure: new StoreError({ reason: "failed", message: "test: mid-write" }) }
      assert.strictEqual(yield* reason(), "failed")
      assert.deepStrictEqual(yield* timerRows(kit), [])
      assert.deepStrictEqual(yield* liveDue(kit), [])
    }))

  it.effect("a label that runs already is invalid", () =>
    Effect.gen(function*() {
      const kit = yield* timerKit(makeHooks())
      const service = kit.service(Timers) as TimersService
      yield* kit.asTurn(service.start({ durationMs: MIN, label: "Rice, step 4" }))
      const e = yield* Effect.flip(kit.asTurn(service.start({ durationMs: 2 * MIN, label: "rice, step 4" })))
      assert.strictEqual(e.reason, "invalid")
      assert.strictEqual((yield* timerRows(kit)).length, 1)
    }))
})

void (null as unknown as Row<Timer> | Row<Alarm>)
