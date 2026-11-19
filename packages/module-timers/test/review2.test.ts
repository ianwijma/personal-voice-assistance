// What the deciding review (review round 2) found, one test or more per finding, through the real kit with a test's own
// wrapper of the store, the notification service, the scheduler and the Presenter (support.ts). Findings 1, 6 and 7 went
// with `alarms_change` (U1); alarms.test.ts pins that it is gone.
import { assert, describe, it } from "@effect/vitest"
import { type JobRow, type ModuleStore, NotifyError, StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Timers, type TimersService } from "@pva/module-contracts"
import { Effect } from "effect"
import { vi } from "vitest"
import { alarms, alarmsModule, timers, timersModule } from "../src/index.ts"
import { busyFailure, hooked, type Hooks, limitFailure, makeHooks, makeRegistered, presentFailure, type Registered, schedulerFailure } from "./support.ts"

vi.setConfig({ testTimeout: 30_000 })

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)
const MIN = 60_000
// The kit's clock starts on Wednesday 18 November 2026, 10:00 in Amsterdam (09:00 UTC).
const storeBusy = () => new StoreError({ reason: "busy", message: "test: busy" })
const timerRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(timers).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 13 })
const alarmRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(alarms).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 10 })
const liveDue = (kit: { jobs: Effect.Effect<ReadonlyArray<JobRow>> }) => Effect.map(kit.jobs, (jobs) => jobs.filter((j) => j.handler === "due" && (j.state === "scheduled" || j.state === "running")))
const timerKit = (hooks: Hooks, registered?: Registered, options?: Parameters<typeof startTestModule>[1]) => startTestModule(hooked(timersModule, hooks, registered), options)
const alarmKit = (hooks: Hooks, registered?: Registered, options?: Parameters<typeof startTestModule>[1]) => startTestModule(hooked(alarmsModule, hooks, registered), options)
const ringing = (kit: { notify: { engine: { ringingOn: (d: string) => ReadonlyArray<{ readonly id: string; readonly title: string }> } } }, device = "kitchen-display") => kit.notify.engine.ringingOn(device)
const hall = { device: "hall-screen", conversationId: "c-hall" }

describe("finding 2 (U3): more time for a ring that was sent but not recorded", () => {
  it.effect("the old card is found by its key and taken away; a cancel after it leaves nothing, also after a restart", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.blockAfterSend = storeBusy()
      yield* kit.advance(MIN)
      assert.isUndefined((yield* timerRows(kit))[0]!.value.ring)
      assert.strictEqual(ringing(kit).length, 1)
      hooks.writesFail = undefined
      assert.strictEqual(said(yield* kit.action("adjust", { name: "tea", amount: "2 minutes" })), "Tea timer runs again: 2 minutes.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
      assert.strictEqual(said(yield* kit.action("cancel", { name: "tea" })), "Tea timer cancelled.")
      yield* kit.restart
      yield* kit.advance(3 * MIN)
      assert.deepStrictEqual(ringing(kit), [])
      const row = (yield* timerRows(kit))[0]!
      assert.isUndefined(row.value.withdraw)
      assert.isFalse(row.value.pending)
    }))
})

describe("findings 3 and 5 (U2): one open ring per row", () => {
  it.effect("timers: repeated lost-outcome handoffs with resolving refused: never two cards; a cancel stops it, also after a restart", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const registered = makeRegistered()
      const kit = yield* timerKit(hooks, registered)
      yield* kit.configure({ ringMinutes: 120 })
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      hooks.resolveFail = busyFailure()
      for (let i = 0; i < 4; i++) {
        const row = (yield* timerRows(kit))[0]!
        const [card] = ringing(kit)
        // The handler commits "five more minutes"; the service never records the outcome: the card stays open.
        yield* registered.presses.get("timer")!.run({ notificationId: card!.id, actionId: "more", key: `timer:${row.id}:${row.value.n}`, deviceId: "kitchen-display" })
        yield* kit.advance(5 * MIN)
        yield* kit.notify.settle
        assert.strictEqual(ringing(kit).length, 1, `handoff ${i}`)
      }
      hooks.resolveFail = undefined
      yield* kit.advance(30_000)
      yield* kit.notify.settle
      assert.strictEqual(ringing(kit).length, 1)
      assert.strictEqual(said(yield* kit.action("cancel", { name: "tea" })), "Tea timer stopped.")
      yield* kit.restart
      yield* kit.advance(10 * MIN)
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
      assert.isUndefined((yield* timerRows(kit))[0]!.value.withdraw)
    }))

  it.effect("alarms: the same with snooze", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const registered = makeRegistered()
      const kit = yield* alarmKit(hooks, registered)
      yield* kit.configure({ ringMinutes: 120 })
      yield* kit.action("set", { when: "10:01", name: "tea" })
      yield* kit.advance(MIN)
      hooks.resolveFail = busyFailure()
      for (let i = 0; i < 4; i++) {
        const row = (yield* alarmRows(kit))[0]!
        const [card] = ringing(kit)
        yield* registered.presses.get("alarm")!.run({ notificationId: card!.id, actionId: "snooze", key: `alarm:${row.id}:${row.value.n}`, deviceId: "kitchen-display" })
        yield* kit.advance(9 * MIN)
        yield* kit.notify.settle
        assert.strictEqual(ringing(kit).length, 1, `handoff ${i}`)
      }
      hooks.resolveFail = undefined
      yield* kit.advance(30_000)
      yield* kit.notify.settle
      assert.strictEqual(ringing(kit).length, 1)
      assert.strictEqual(said(yield* kit.action("cancel", { which: "tea" })), "The alarm's ring is stopped now.")
      yield* kit.restart
      yield* kit.advance(20 * MIN)
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
    }))

  it.effect("a new ring waits while the old one cannot be taken away, and is sent once it is gone", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const registered = makeRegistered()
      const kit = yield* timerKit(hooks, registered)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      const row = (yield* timerRows(kit))[0]!
      const [first] = ringing(kit)
      yield* registered.presses.get("timer")!.run({ notificationId: first!.id, actionId: "more", key: `timer:${row.id}:1`, deviceId: "kitchen-display" })
      hooks.resolveFail = busyFailure()
      yield* kit.advance(5 * MIN)
      yield* kit.restart
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit).map((r) => r.id), [first!.id])
      assert.strictEqual(said(yield* kit.action("list", { name: "tea" })), "Tea timer is done; its ring could not be sent yet, and I keep trying.")
      hooks.resolveFail = undefined
      yield* kit.advance(30_000)
      yield* kit.notify.settle
      const now = ringing(kit)
      assert.strictEqual(now.length, 1)
      assert.notStrictEqual(now[0]!.id, first!.id)
    }))
})

describe("finding 4 (U4): Stop and a press for the same ring at the same moment", () => {
  it.effect("timers: the press's follow-up stands (the stated limit); a later cancel stops everything, also after a restart", () =>
    Effect.gen(function*() {
      const registered = makeRegistered()
      const kit = yield* timerKit(makeHooks(), registered)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      const row = (yield* timerRows(kit))[0]!
      const [card] = ringing(kit)
      // Stop is recorded by the service; the press's own handler committed its follow-up for the same ring.
      assert.deepStrictEqual(yield* registered.presses.get("timer")!.run({ notificationId: card!.id, actionId: "more", key: `timer:${row.id}:1`, deviceId: "kitchen-display" }), { say: "Tea timer: five more minutes." })
      assert.isTrue((yield* kit.notify.press(card!.id, "stop", { device: "kitchen-display" })).ok)
      assert.strictEqual(said(yield* kit.action("list", {})), "Tea timer: 5 minutes left.")
      assert.strictEqual(said(yield* kit.action("cancel", {})), "Tea timer cancelled.")
      yield* kit.restart
      yield* kit.advance(10 * MIN)
      assert.deepStrictEqual(ringing(kit), [])
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("alarms: the same with snooze", () =>
    Effect.gen(function*() {
      const registered = makeRegistered()
      const kit = yield* alarmKit(makeHooks(), registered)
      yield* kit.action("set", { when: "10:01", name: "tea" })
      yield* kit.advance(MIN)
      const row = (yield* alarmRows(kit))[0]!
      const [card] = ringing(kit)
      yield* registered.presses.get("alarm")!.run({ notificationId: card!.id, actionId: "snooze", key: `alarm:${row.id}:1`, deviceId: "kitchen-display" })
      assert.isTrue((yield* kit.notify.press(card!.id, "stop", { device: "kitchen-display" })).ok)
      assert.strictEqual(said(yield* kit.action("cancel", { which: "tea" })), "The snoozed alarm is cancelled.")
      yield* kit.restart
      yield* kit.advance(20 * MIN)
      assert.deepStrictEqual(ringing(kit), [])
    }))
})

describe("finding 8 (U5): a ring remembers the time it was set for", () => {
  it.effect("a ringing one-off is cancelled by its time from another device, also after a restart", () =>
    Effect.gen(function*() {
      const kit = yield* alarmKit(makeHooks())
      yield* kit.action("set", { when: "10:01", name: "tea" })
      yield* kit.advance(MIN)
      assert.strictEqual(ringing(kit).length, 1)
      yield* kit.restart
      assert.strictEqual(said(yield* kit.action("cancel", { which: "10:01" }, hall)), "The alarm's ring is stopped now.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
    }))

  it.effect("rung late: still known by the time it was set for", () =>
    Effect.gen(function*() {
      const kit = yield* alarmKit(makeHooks())
      yield* kit.action("set", { when: "10:01" })
      yield* kit.stop
      yield* kit.advance(5 * MIN)
      yield* kit.start
      yield* kit.advance(0)
      assert.strictEqual(ringing(kit).length, 1)
      assert.strictEqual(said(yield* kit.action("cancel", { which: "10:01" }, hall)), "The alarm's ring is stopped now.")
    }))

  it.effect("next to a daylight-saving change: in Amsterdam's spring gap, and in Nuuk's gap across midnight, by the nominal time", () =>
    Effect.gen(function*() {
      const spring = yield* alarmKit(makeHooks(), undefined, { startAt: Date.UTC(2026, 2, 28, 12, 0) })
      yield* spring.action("set", { when: "every Sunday at 2:30 am" })
      yield* spring.advance(Date.UTC(2026, 2, 29, 1, 30) - (yield* spring.now))
      assert.strictEqual(ringing(spring).length, 1)
      assert.strictEqual((yield* alarmRows(spring))[0]!.value.ring?.time, "02:30")
      assert.strictEqual(said(yield* spring.action("cancel", { which: "2:30 am", scope: "all" }, hall)), "The alarm every Sunday is cancelled.")
      const nuuk = yield* alarmKit(makeHooks(), undefined, { household: { home: { HOME_LANGUAGE: "en-GB", HOME_TIME_ZONE: "America/Nuuk" } }, startAt: Date.UTC(2026, 2, 28, 12, 0) })
      yield* nuuk.action("set", { when: "every Saturday at 11:30 pm" })
      assert.strictEqual((yield* alarmRows(nuuk))[0]!.value.next?.date, "2026-03-28")
      yield* nuuk.advance(Date.UTC(2026, 2, 29, 1, 31) - (yield* nuuk.now))
      yield* nuuk.notify.settle
      assert.strictEqual((yield* nuuk.notify.all).filter((n) => n.state === "open").length, 1)
      assert.strictEqual(said(yield* nuuk.action("cancel", { which: "11:30 pm", scope: "all" }, hall)), "The alarm every Saturday is cancelled.")
    }))
})

describe("finding 9 (U6): cancelling again finishes the clean-up", () => {
  it.effect("timers: by name, and cancel-all, after a refused take-away; also after a restart", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      yield* kit.advance(MIN)
      hooks.resolveFail = busyFailure()
      assert.strictEqual(said(yield* kit.action("cancel", { name: "tea" })), "Tea timer cancelled; its ring is still being stopped, and I keep trying.")
      // Not listed as a timer that runs.
      assert.strictEqual(said(yield* kit.action("list", {})), "No timers are running.")
      yield* kit.restart
      hooks.resolveFail = undefined
      assert.strictEqual(said(yield* kit.action("cancel", { name: "tea" })), "Tea timer is stopped now.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
      // Cancel-all includes such a timer.
      yield* kit.action("start", { duration: "1 minute", name: "eggs" })
      yield* kit.advance(MIN)
      hooks.resolveFail = busyFailure()
      yield* kit.action("cancel", { name: "eggs" })
      hooks.resolveFail = undefined
      assert.strictEqual(said(yield* kit.action("cancel", { all: true })), "Cancelled 1 timers.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
    }))

  it.effect("timers: a countdown still to be taken off the screen", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.action("start", { duration: "1 hour", name: "bread" })
      hooks.dismissFail = presentFailure()
      assert.strictEqual(said(yield* kit.action("cancel", { name: "bread" })), "Bread timer cancelled; its countdown is still being taken off the screen, and I keep trying.")
      yield* kit.restart
      hooks.dismissFail = undefined
      assert.strictEqual(said(yield* kit.action("cancel", { name: "bread" })), "Bread timer is stopped now.")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("alarms: by name on its device and by time from another, after a refused take-away; lists do not show it", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* alarmKit(hooks)
      yield* kit.action("set", { when: "10:01", name: "tea" })
      yield* kit.action("set", { when: "10:02", name: "rice" })
      yield* kit.advance(2 * MIN)
      hooks.resolveFail = busyFailure()
      assert.strictEqual(said(yield* kit.action("cancel", { which: "tea" })), "The alarm is cancelled; its ring is still being stopped, and I keep trying.")
      assert.strictEqual(said(yield* kit.action("cancel", { which: "rice" })), "The alarm is cancelled; its ring is still being stopped, and I keep trying.")
      assert.strictEqual(said(yield* kit.action("list", {})), "No alarms are set.")
      hooks.resolveFail = undefined
      assert.strictEqual(said(yield* kit.action("cancel", { which: "tea" })), "The alarm's ring is stopped now.")
      assert.strictEqual(said(yield* kit.action("cancel", { which: "tea" }, hall)), "I don't know an alarm called tea here.")
      assert.strictEqual(said(yield* kit.action("cancel", { which: "10:02" }, hall)), "The alarm's ring is stopped now.")
      yield* kit.notify.settle
      assert.deepStrictEqual(ringing(kit), [])
    }))
})

describe("finding 10 (U7): a start that was committed is a success", () => {
  it.effect("the write after the countdown's show fails: Timers.start answers the timer, which rings; nothing half-done", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      const service = kit.service(Timers) as TimersService
      hooks.failAfterShow = storeBusy()
      const info = yield* kit.asTurn(service.start({ durationMs: MIN, label: "tea" }))
      assert.strictEqual(info.label, "tea")
      assert.strictEqual((yield* timerRows(kit)).length, 1)
      assert.strictEqual((yield* liveDue(kit)).length, 1)
      hooks.failAfterShow = storeBusy()
      assert.strictEqual(said(yield* kit.action("start", { duration: "2 minutes", name: "rice" })), "Rice timer, 2 minutes.")
      yield* kit.advance(MIN)
      assert.strictEqual(ringing(kit).length, 1)
      // busy and failed mean nothing was started (a failure after the first row write rolls it back).
      hooks.throwAtWrite = { n: 1, failure: storeBusy() }
      assert.strictEqual((yield* Effect.flip(kit.asTurn(service.start({ durationMs: MIN, label: "eggs" })))).reason, "busy")
      assert.strictEqual((yield* timerRows(kit)).length, 2)
    }))
})

describe("finding 11 (U8): a countdown is owed before it is shown", () => {
  it.effect("shown, its record refused; cancel and restart: it is taken away", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      hooks.blockAfterShow = storeBusy()
      assert.strictEqual(said(yield* kit.action("start", { duration: "1 hour", name: "tea" })), "Tea timer, 1 hour.")
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      assert.isDefined((yield* timerRows(kit))[0]!.value.screen)
      hooks.writesFail = undefined
      yield* kit.restart
      assert.strictEqual(said(yield* kit.action("cancel", { name: "tea" })), "Tea timer cancelled.")
      yield* kit.restart
      yield* kit.advance(2 * MIN)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.isFalse((yield* timerRows(kit))[0]!.value.pending)
    }))
})

describe("finding 12 (U9): missed work is reported or still owed", () => {
  it.effect("timers: the Health job cannot be prepared: the ring stays owed; once it can, the job and the giving-up go together", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.configure({ ringMinutes: 1 })
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.sendFail = limitFailure()
      hooks.prepareFail = { handler: "trouble", failure: schedulerFailure() }
      yield* kit.advance(3 * MIN)
      const owing = (yield* timerRows(kit))[0]!
      assert.isDefined(owing.value.owed)
      assert.isTrue(owing.value.pending)
      assert.isFalse((yield* kit.jobs).some((j) => j.handler === "trouble"))
      yield* kit.restart
      hooks.prepareFail = undefined
      yield* kit.advance(MIN)
      assert.isUndefined((yield* timerRows(kit))[0]!.value.owed)
      assert.isTrue((yield* kit.jobs).some((j) => j.handler === "trouble" && j.state === "failed"))
      assert.isTrue((yield* kit.checkHealth).some((i) => JSON.stringify(i).includes("could not ring")))
    }))

  it.effect("timers: the giving-up write fails: no Health job without it, and it is tried again", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* timerKit(hooks)
      yield* kit.configure({ ringMinutes: 1 })
      yield* kit.action("start", { duration: "1 minute", name: "tea" })
      hooks.sendFail = limitFailure()
      yield* kit.advance(MIN + 50_000)
      hooks.writesFail = storeBusy()
      yield* kit.advance(20_000)
      assert.isFalse((yield* kit.jobs).some((j) => j.handler === "trouble"))
      assert.isDefined((yield* timerRows(kit))[0]!.value.owed)
      hooks.writesFail = undefined
      yield* kit.advance(2 * MIN)
      assert.isTrue((yield* kit.jobs).some((j) => j.handler === "trouble" && j.state === "failed"))
      assert.isUndefined((yield* timerRows(kit))[0]!.value.owed)
    }))

  it.effect("alarms: the missed card refused and the Health job not preparable: still owed; then reported", () =>
    Effect.gen(function*() {
      const hooks = makeHooks()
      const kit = yield* alarmKit(hooks)
      yield* kit.action("set", { when: "10:01" })
      hooks.sendFail = limitFailure()
      hooks.prepareFail = { handler: "trouble", failure: schedulerFailure() }
      yield* kit.advance(18 * MIN)
      assert.isDefined((yield* alarmRows(kit))[0]!.value.owed)
      yield* kit.restart
      hooks.prepareFail = undefined
      yield* kit.advance(MIN)
      assert.isUndefined((yield* alarmRows(kit))[0]!.value.owed)
      assert.isTrue((yield* kit.jobs).some((j) => j.handler === "trouble" && j.state === "failed"))
    }))
})

describe("finding 13 (U10): the missed card says what is known", () => {
  it.effect("refused while running, past the late rule: the card names no cause, in English and in Dutch", () =>
    Effect.gen(function*() {
      for (const [language, text] of [
        ["en-GB", "The alarm for today at ten oh one in the morning could not ring."],
        ["nl-NL", "De wekker voor vandaag om tien uur een 's ochtends kon niet afgaan."]
      ] as const) {
        const hooks = makeHooks()
        const kit = yield* alarmKit(hooks, undefined, { household: { home: { HOME_LANGUAGE: language, HOME_TIME_ZONE: "Europe/Amsterdam" } } })
        yield* kit.action("set", { when: language === "en-GB" ? "10:01" : "om 10:01" })
        hooks.sendFailRing = new NotifyError({ reason: "limit", message: "test: limit" })
        yield* kit.advance(18 * MIN)
        const missed = (yield* kit.notify.all).filter((n) => n.key?.startsWith("alarm-missed:"))
        assert.strictEqual(missed.length, 1, language)
        assert.strictEqual(missed[0]!.text, text)
      }
    }))
})
