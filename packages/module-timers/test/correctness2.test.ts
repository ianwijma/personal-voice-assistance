// GPT review round 2: the review's single-fault sequences and ordinary boundary cases.
import { assert, it } from "@effect/vitest"
import { type ModuleDefinition, type ModuleStore, StoreError } from "@pva/core"
import { type ModuleHarness, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { alarms, alarmsModule, timers, timersModule } from "../src/index.ts"
import { busyFailure, hooked, makeHooks } from "./support.ts"

vi.setConfig({ testTimeout: 30_000 })
const MIN = 60_000
const hall = { device: "hall-screen", conversationId: "c-hall" }
const busy = () => new StoreError({ reason: "busy", message: "test: busy" })
const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => r.ok ? r.say! : r.message!
const alarmRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(alarms).list({ limit: 10 })
const timerRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(timers).list({ limit: 12 })
const ringing = (kit: { notify: { engine: { ringingOn: (device: string) => ReadonlyArray<{ readonly id: string }> } } }) => kit.notify.engine.ringingOn("kitchen-display")

/** The actions select with lists; their first get is reconciliation after the successful commit. Fail just that read. */
const readFault = <M extends ModuleDefinition<any>>(base: M) => {
  const fault = { armed: false, failed: 0, reads: 0 }
  return { fault, module: { ...base, shared: (ctx) => base.shared!({ ...ctx, store: {
    ...ctx.store,
    collection: (c) => {
      const store = ctx.store.collection(c)
      return { ...store, get: (id) => Effect.suspend(() => {
        fault.reads++
        if (fault.armed) { fault.armed = false; fault.failed++; return Effect.fail(busy()) }
        return store.get(id)
      }) }
    }
  } }) } as M }
}

it.effect("1: a committed cancel-next confirms the skipped day after one reconciliation read fails", () => Effect.gen(function*() {
  const { module, fault } = readFault(alarmsModule)
  const kit = yield* startTestModule(module)
  yield* kit.action("set", { when: "every day at 11:00", name: "tea" })
  fault.armed = true
  const reply = yield* kit.action("cancel", { which: "tea", scope: "next" })
  assert.strictEqual(fault.failed, 1)
  assert.isTrue(reply.ok)
  assert.include(said(reply), "today")
  assert.include(said(reply), "tomorrow")
  assert.notInclude(said(reply), "try again")
  assert.strictEqual((yield* alarmRows(kit))[0]!.value.next?.date, "2026-11-19")
  yield* kit.advance(25 * 60 * MIN)
  assert.strictEqual(ringing(kit).length, 1)
}))

it.effect("2: a committed cancel-all confirms its batch and continues cleanup after one row read fails", () => Effect.gen(function*() {
  const { module, fault } = readFault(timersModule)
  const kit = yield* startTestModule(module)
  for (const name of ["tea", "rice"]) yield* kit.action("start", { duration: "5 minutes", name })
  fault.reads = 0
  fault.armed = true
  const reply = yield* kit.action("cancel", { all: true, bulk: "timers" })
  assert.strictEqual(fault.failed, 1)
  assert.strictEqual(fault.reads, 2, "cleanup continues with the other row")
  assert.isTrue(reply.ok)
  assert.include(said(reply), "Cancelled 2 timers")
  assert.include(said(reply), "still being taken away")
  assert.notInclude(said(reply), "try again")
  const rows = yield* timerRows(kit)
  assert.isTrue(rows.every((r) => r.value.state === "cancelled"))
  assert.strictEqual(rows.filter((r) => r.value.screen !== undefined).length, 1)
  yield* kit.action("start", { duration: "10 minutes", name: "bread" }, hall)
  assert.strictEqual((yield* timerRows(kit)).find((r) => r.value.name === "bread")?.value.state, "running")
  yield* kit.advance(0)
  assert.isTrue((yield* timerRows(kit)).filter((r) => r.value.name !== "bread").every((r) => r.value.screen === undefined))
}))

it.effect("3: Santiago's midnight gap retains Sunday's nominal date when skipping the next occurrence", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, { startAt: Date.UTC(2026, 8, 5, 4, 25), household: { home: { HOME_TIME_ZONE: "America/Santiago", HOME_LANGUAGE: "en" } } })
  yield* kit.action("set", { when: "every day at 00:30", name: "tea" })
  yield* kit.advance(5 * MIN)
  const next = (yield* alarmRows(kit))[0]!.value.next!
  assert.strictEqual(next.at, Date.UTC(2026, 8, 6, 4, 30))
  assert.strictEqual(next.date, "2026-09-06")
  assert.strictEqual(next.time, "00:30")
  assert.include(said(yield* kit.action("cancel", { which: "tea", scope: "next" })), "for tomorrow")
}))

it.effect("5: a late ring's withdrawal does not match its send time; cancellation still knows its nominal time", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(alarmsModule, hooks))
  yield* kit.action("set", { when: "10:01", name: "tea" })
  yield* kit.stop
  yield* kit.advance(5 * MIN)
  yield* kit.start
  yield* kit.advance(0)
  hooks.resolveFail = busyFailure()
  yield* kit.action("cancel", { which: "10:01" }, hall)
  hooks.resolveFail = undefined
  assert.strictEqual(said(yield* kit.action("list", {}, hall)), "No alarms are set.")
  yield* kit.action("set", { when: "tomorrow at 10:05", name: "bread" })
  const reply = yield* kit.action("cancel", { which: "10:05" }, hall)
  assert.include(said(reply), "is cancelled")
  assert.notInclude(said(reply), "Which one")
  assert.strictEqual((yield* alarmRows(kit)).find((r) => r.value.name === "bread")?.value.phase, "ended")
  assert.isDefined((yield* alarmRows(kit)).find((r) => r.value.name === "tea")?.value.withdraw)
  assert.include(said(yield* kit.action("cancel", { which: "10:01" }, hall)), "stopped now")
}))

for (const health of [false, true]) it.effect(`6: a missed snooze reports its 10:10 due time in the ${health ? "Health fallback" : "silent card"}`, () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(alarmsModule, hooks))
  yield* kit.action("set", { when: "10:01", name: "private" })
  yield* kit.advance(MIN)
  assert.include((yield* kit.notify.all)[0]!.text, "ten oh one")
  yield* kit.notify.press(ringing(kit)[0]!.id, "snooze", { device: "kitchen-display" })
  yield* kit.stop
  yield* kit.advance(26 * MIN)
  if (health) hooks.sendFail = busyFailure()
  yield* kit.start
  yield* kit.advance(0)
  const text = health ? JSON.stringify((yield* kit.jobs).find((j) => j.handler === "trouble")!.payload) : (yield* kit.notify.all).find((n) => n.key?.startsWith("alarm-missed:"))!.text
  assert.include(text, health ? "2026-11-18 10:10" : "ten past ten")
  assert.notInclude(text, health ? "10:01" : "ten oh one")
  assert.notInclude(text, "private")
}))

for (const timer of [true, false]) it.effect(`7: ${timer ? "timer" : "alarm"} lists its open occurrence as ringing after exactly one lost send-outcome write`, () => Effect.gen(function*() {
  const base = timer ? timersModule : alarmsModule
  let fail = false, failures = 0, observed = false
  let openCount = 0, listed = "", paused = ""
  const kit: ModuleHarness = yield* startTestModule({ ...base, shared: (ctx) => base.shared!({
    ...ctx,
    scheduler: { ...ctx.scheduler, handle: (name, handler) => ctx.scheduler.handle(name, { ...handler, run: (...args) => Effect.gen(function*() {
      if (name === "due" && failures === 1 && !observed) {
        observed = true
        openCount = ringing(kit).length
        listed = said(yield* kit.action("list", timer ? { name: "tea" } : {}, hall))
        if (timer) paused = said(yield* kit.action("pause", { name: "tea" }))
      }
      return yield* handler.run(...args)
    }) }) },
    notify: { ...ctx.notify, send: (request) => Effect.tap(ctx.notify.send(request), () => Effect.sync(() => { if (request.priority === "ring" && failures === 0) fail = true })) },
    store: { ...ctx.store, transaction: (f) => Effect.suspend(() => {
      if (fail) { fail = false; failures++; return Effect.fail(busy()) }
      return ctx.store.transaction(f)
    }) }
  }) })
  yield* kit.action(timer ? "start" : "set", timer ? { duration: "1 minute", name: "tea" } : { when: "10:01", name: "tea" })
  yield* kit.advance(MIN + 30_000)
  assert.strictEqual(failures, 1)
  assert.isTrue(observed, "the retry must observe the unrecorded live card")
  assert.strictEqual(openCount, 1)
  assert.include(listed, "ringing")
  if (timer) assert.include(paused, "is ringing")
}))

for (const language of ["en", "nl"] as const) it.effect(`8: ${language} recurring ringing and snoozed lists describe today's occurrence from the hall`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, { household: { home: { HOME_LANGUAGE: language, HOME_TIME_ZONE: "Europe/Amsterdam" } } })
  yield* kit.action("set", { when: language === "en" ? "every weekday at 10:01" : "elke werkdag om 10:01", name: "private" })
  yield* kit.advance(MIN)
  const current = said(yield* kit.action("list", {}, hall))
  assert.include(current, language === "en" ? "today" : "vandaag")
  assert.include(current, language === "en" ? "ringing now" : "gaat nu af")
  assert.notInclude(current, language === "en" ? "tomorrow" : "morgen")
  assert.notInclude(current, "private")
  yield* kit.notify.press(ringing(kit)[0]!.id, "snooze", { device: "kitchen-display" })
  const snoozed = said(yield* kit.action("list", {}, hall))
  assert.include(snoozed, language === "en" ? "ringing again today" : "gaat weer af vandaag")
  assert.notInclude(snoozed, language === "en" ? "tomorrow" : "morgen")
  assert.notInclude(snoozed, "private")
  assert.strictEqual((yield* alarmRows(kit))[0]!.value.next?.date, "2026-11-19")
}))

it.effect("9: taking time off a capacity-blocked timer reports waiting, never ringing", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  for (let i = 0; i < 10; i++) yield* kit.action("start", { duration: "1 minute", name: `first${i}` })
  yield* kit.advance(MIN)
  yield* kit.action("start", { duration: "1 minute", name: "tea" })
  yield* kit.advance(MIN)
  const reply = said(yield* kit.action("adjust", { name: "tea", amount: "1 minute", change: "remove" }))
  assert.include(reply, "could not be sent yet")
  assert.notInclude(reply, "is ringing")
  assert.isDefined((yield* timerRows(kit)).find((r) => r.value.name === "tea")?.value.owed)
}))

for (const timer of [true, false]) for (const language of ["en", "nl"] as const) it.effect(`10: ${language} ${timer ? "timer" : "alarm"} announces a recovered ring's 30-second lateness`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timer ? timersModule : alarmsModule, { household: { home: { HOME_LANGUAGE: language, HOME_TIME_ZONE: "Europe/Amsterdam" } } })
  yield* kit.action(timer ? "start" : "set", timer ? { duration: language === "en" ? "1 minute" : "1 minuut" } : { when: "10:01" })
  yield* kit.stop
  yield* kit.advance(1.5 * MIN)
  yield* kit.start
  yield* kit.advance(0)
  assert.strictEqual(ringing(kit).length, 1)
  assert.include((yield* kit.notify.all).find((n) => n.priority === "ring")!.text, language === "en" ? "30 seconds" : "30 seconden")
}))
