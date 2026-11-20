// GPT review round 1: regressions for the numbered correctness findings.
import { assert, it } from "@effect/vitest"
import { type ModuleScheduler, type ModuleStore, StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Timers, type TimersService } from "@pva/module-contracts"
import { Effect } from "effect"
import { vi } from "vitest"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { type Alarm, alarms, alarmsModule, timers, timersModule } from "../src/index.ts"
import { listOf, scan } from "../src/common.ts"
import { busyFailure, hooked, makeHooks, makeRegistered, presentFailure } from "./support.ts"

const recurrence = vi.hoisted(() => ({ stops: [] as Array<number>, limits: [] as Array<number> }))
vi.mock("@pva/language", async (original) => {
  const actual = await original<typeof import("@pva/language")>()
  return {
    ...actual,
    occurrencesAfter: (...args: Parameters<typeof actual.occurrencesAfter>) => {
      recurrence.limits.push(args[2] ?? 1)
      const start = performance.now()
      try { return actual.occurrencesAfter(...args) } finally { recurrence.stops.push(performance.now() - start) }
    },
    nextOccurrence: (...args: Parameters<typeof actual.nextOccurrence>) => {
      const start = performance.now()
      try { return actual.nextOccurrence(...args) } finally { recurrence.stops.push(performance.now() - start) }
    }
  }
})
vi.setConfig({ testTimeout: 30_000 })
const MIN = 60_000
const DAY = 24 * 60 * MIN
const busy = () => new StoreError({ reason: "busy", message: "test: busy" })
const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => r.ok ? r.say! : r.message!
const hall = { device: "hall-screen", conversationId: "c-hall" }
const timerRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(timers).list({ limit: 12 })
const alarmRows = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(alarms).list({ limit: 10 })
const ringing = (kit: { notify: { engine: { ringingOn: (d: string) => ReadonlyArray<{ readonly id: string }> } } }) => kit.notify.engine.ringingOn("kitchen-display")

it.effect("1: recovery keeps today's occurrence ahead of yesterday's expired snooze", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01" })
  yield* kit.advance(MIN)
  yield* kit.notify.press(ringing(kit)[0]!.id, "snooze", { device: "kitchen-display" })
  yield* kit.stop
  yield* kit.advance(DAY + 2 * MIN)
  yield* kit.start
  yield* kit.advance(0)
  assert.strictEqual(ringing(kit).length, 1)
  const row = (yield* alarmRows(kit))[0]!
  assert.strictEqual(row.value.ring?.date, "2026-11-19")
  assert.strictEqual(row.value.next?.date, "2026-11-20")
  assert.isFalse((yield* kit.notify.all).some((n) => n.key?.startsWith("alarm-missed:")))
}))

it.effect("3: supplied empty-normalization timer names never select an unrelated timer; duplicates are invalid", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "30 minutes", name: "bread" })
  assert.include(said(yield* kit.action("cancel", { name: "A" })), "don't know")
  assert.include(said(yield* kit.action("list", { name: "A" })), "don't know")
  const service = kit.service(Timers) as TimersService
  const a = yield* kit.asTurn(service.start({ durationMs: MIN, label: "A" }))
  assert.strictEqual((yield* Effect.flip(kit.asTurn(service.start({ durationMs: MIN, label: "A" })))).reason, "invalid")
  assert.include(said(yield* kit.action("list", { name: "A" })), "A timer")
  yield* kit.action("cancel", { name: "A" })
  assert.strictEqual((yield* timerRows(kit)).find((r) => r.id === a.id)?.value.state, "cancelled")
  assert.strictEqual((yield* timerRows(kit)).find((r) => r.value.name === "bread")?.value.state, "running")
}))

it.effect("3: supplied empty-normalization alarm names respect exact names and device privacy", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "10:01", name: "bread" })
  const unknown = said(yield* kit.action("cancel", { which: "A" }, hall))
  assert.include(unknown, "?")
  assert.notInclude(unknown, "bread")
  yield* kit.action("set", { when: "10:02", name: "A" })
  assert.include(said(yield* kit.action("cancel", { which: "A" })), "cancelled")
  assert.strictEqual((yield* alarmRows(kit)).find((r) => r.value.name === "bread")?.value.phase, "set")
}))

it.effect("4: cancel-next by an owed snooze's effective time cancels it and keeps tomorrow", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(alarmsModule, hooks))
  yield* kit.action("set", { when: "every day at 10:01", name: "tea" })
  yield* kit.advance(MIN)
  yield* kit.notify.press(ringing(kit)[0]!.id, "snooze", { device: "kitchen-display" })
  hooks.sendFailRing = busyFailure()
  yield* kit.advance(9 * MIN)
  const next = (yield* alarmRows(kit))[0]!.value.next
  assert.include(said(yield* kit.action("cancel", { which: "10:10", scope: "next" }, hall)), "snoozed alarm is cancelled")
  assert.deepStrictEqual((yield* alarmRows(kit))[0]!.value.next, next)
  assert.isUndefined((yield* alarmRows(kit))[0]!.value.owed)
  hooks.sendFailRing = undefined
  yield* kit.advance(MIN)
  assert.strictEqual(ringing(kit).length, 0)
}))

it.effect("4: repeating cancel-next finishes a snooze withdrawal before skipping another occurrence", () => Effect.gen(function*() {
  const hooks = makeHooks(), registered = makeRegistered()
  const kit = yield* startTestModule(hooked(alarmsModule, hooks, registered))
  yield* kit.action("set", { when: "every day at 10:01", name: "tea" })
  yield* kit.advance(MIN)
  const row = (yield* alarmRows(kit))[0]!
  yield* registered.presses.get("alarm")!.run({ notificationId: ringing(kit)[0]!.id, key: `alarm:${row.id}:1`, actionId: "snooze", deviceId: "kitchen-display" })
  hooks.resolveFail = busyFailure()
  const first = said(yield* kit.action("cancel", { which: "tea", scope: "next" }))
  assert.notMatch(first, /^The alarm is cancelled;/)
  assert.include(first, "snoozed")
  hooks.resolveFail = undefined
  const second = said(yield* kit.action("cancel", { which: "tea", scope: "next" }))
  assert.include(second, "stopped")
  assert.deepStrictEqual((yield* alarmRows(kit))[0]!.value.next, row.value.next)
  yield* kit.notify.settle
  assert.strictEqual(ringing(kit).length, 0)
}))

for (const timer of [true, false]) {
  it.effect(`5: ${timer ? "timer" : "alarm"} cancel finds the live follow-up after its outcome write fails`, () => Effect.gen(function*() {
    const hooks = makeHooks()
    const kit = yield* startTestModule(hooked(timer ? timersModule : alarmsModule, hooks))
    yield* kit.action(timer ? "start" : "set", timer ? { duration: "1 minute", name: "tea" } : { when: "10:01", name: "tea" })
    yield* kit.advance(MIN)
    yield* kit.notify.press(ringing(kit)[0]!.id, "more", { device: "kitchen-display" })
    hooks.blockAfterSend = busy()
    yield* kit.advance(5 * MIN)
    assert.strictEqual(ringing(kit).length, 1)
    hooks.writesFail = undefined
    const result = yield* kit.action("cancel", timer ? { name: "tea" } : { which: "10:01" })
    assert.isTrue(result.ok)
    yield* kit.notify.settle
    assert.strictEqual(ringing(kit).length, 0)
    yield* kit.restart
    yield* kit.advance(MIN)
    assert.strictEqual(ringing(kit).length, 0)
  }))
}

it.effect("7: a committed adjustment confirms success despite the countdown outcome write failing", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(timersModule, hooks))
  yield* kit.action("start", { duration: "10 minutes", name: "tea" })
  hooks.failAfterShow = busy()
  assert.strictEqual(said(yield* kit.action("adjust", { name: "tea", amount: "2 minutes", change: "add" })), "Tea timer: 12 minutes left.")
  assert.strictEqual((yield* timerRows(kit))[0]!.value.dueAt, (yield* kit.now) + 12 * MIN)
  yield* kit.restart
  yield* kit.advance(12 * MIN)
  assert.strictEqual(ringing(kit).length, 1)
}))

it.effect("8: a daily series restored 1002 occurrences late rings the latest due day", () => Effect.gen(function*() {
  const now = Date.UTC(2029, 7, 16, 8, 3)
  const kit = yield* startTestModule(alarmsModule, { startAt: now })
  const next = { date: "2026-11-18", time: "10:01", at: Date.UTC(2026, 10, 18, 9, 1) }
  yield* kit.moduleStore().collection(alarms).insert({ deviceId: "kitchen-display", timeZone: "Europe/Amsterdam", rrule: "FREQ=DAILY", dtstart: "DTSTART;TZID=Europe/Amsterdam:20261118T100100", n: 0, next, phase: "set", pending: true, nextAt: next.at, endedAt: 0 })
  yield* kit.restart
  yield* kit.advance(1000)
  assert.strictEqual(ringing(kit).length, 1)
  const row = (yield* alarmRows(kit))[0]!
  assert.strictEqual(row.value.ring?.date, "2029-08-16")
  assert.strictEqual(row.value.next?.date, "2029-08-17")
}))

it.effect("9: a timer card cannot reactivate a name already running", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "1 minute", name: "tea" })
  yield* kit.advance(MIN)
  const card = ringing(kit)[0]!
  yield* kit.action("start", { duration: "10 minutes", name: "tea" })
  assert.include((yield* kit.notify.press(card.id, "more", { device: "kitchen-display" })).say!, "already")
  assert.strictEqual(ringing(kit).length, 1)
  assert.strictEqual((yield* kit.moduleStore().collection(timers).list({ where: { phase: "active" } })).length, 1)
}))

it.effect("9: an alarm card cannot exceed the 50-set limit", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "10:01" })
  yield* kit.advance(MIN)
  const card = ringing(kit)[0]!
  for (let i = 0; i < 50; i++) yield* kit.action("set", { when: "11:00", name: `alarm ${i}` })
  assert.include((yield* kit.notify.press(card.id, "snooze", { device: "kitchen-display" })).say!, "already 50")
  assert.strictEqual(ringing(kit).length, 1)
  const set = yield* scan<Alarm>((q) => kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, ...q }), 10, 60)
  assert.strictEqual(set.rows.length, 50)
}))

for (const timer of [true, false]) for (const restart of [false, true]) {
  it.effect(`10: ${timer ? "timer" : "alarm"} a different button replay reports the committed nine-minute deadline (${restart ? "after restart" : "without restart"})`, () => Effect.gen(function*() {
    const registered = makeRegistered()
    const kit = yield* startTestModule(hooked(timer ? timersModule : alarmsModule, makeHooks(), registered), { settings: { snoozeMinutes: 9 } })
    yield* kit.action(timer ? "start" : "set", timer ? { duration: "1 minute", name: "tea" } : { when: "10:01" })
    yield* kit.advance(MIN)
    const row = timer ? (yield* timerRows(kit))[0]! : (yield* alarmRows(kit))[0]!
    const card = ringing(kit)[0]!
    const prefix = timer ? "timer" : "alarm"
    yield* registered.presses.get(prefix)!.run({ notificationId: card.id, key: `${prefix}:${row.id}:1`, actionId: "snooze", deviceId: "kitchen-display" })
    if (restart) yield* kit.restart
    assert.include((yield* kit.notify.press(card.id, "more", { device: "kitchen-display" })).say!, "9 minutes")
    yield* kit.advance(5 * MIN)
    assert.strictEqual(ringing(kit).length, 0)
    yield* kit.advance(4 * MIN)
    assert.strictEqual(ringing(kit).length, 1)
  }))
}

it.effect("11: elsewhere ringing one-offs list and ask with their nominal times and no names", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "10:01", name: "tea" })
  yield* kit.action("set", { when: "10:02", name: "bread" })
  yield* kit.advance(2 * MIN)
  for (const action of ["list", "cancel"]) {
    const text = said(yield* kit.action(action, {}, hall))
    assert.include(text, "ten oh one")
    assert.include(text, "ten oh two")
    assert.notInclude(text, "tea")
    assert.notInclude(text, "bread")
  }
}))

it.effect("12: lists name three items even at four or beyond the language helper's input bound", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  for (const name of ["tea", "eggs", "rice", "bread"]) {
    yield* kit.action("start", { duration: "5 minutes", name })
    yield* kit.advance(1)
  }
  const four = said(yield* kit.action("list", {}))
  assert.include(four, "1 more")
  assert.notInclude(four, "bread")
  for (const language of ["en", "nl"] as const) {
    const text = listOf(Array.from({ length: 101 }, (_, i) => `item${i}`), language)
    assert.notInclude(text, "item3")
    assert.include(text, "98")
    assert.isBelow(text.length, 100)
  }
}))

it.effect("13: cancel-all uses one open-card snapshot for 100 timers and keeps the writes atomic", () => Effect.gen(function*() {
  const hooks = makeHooks()
  let lists = 0
  const base = hooked(timersModule, hooks)
  const kit = yield* startTestModule({ ...base, shared: (ctx) => base.shared!({ ...ctx, notify: { ...ctx.notify, list: () => Effect.suspend(() => { lists++; return ctx.notify.list() }) } }) })
  for (let batch = 0; batch < 2; batch++) {
    for (let i = 0; i < 50; i++) yield* kit.action("start", { duration: "1 minute", name: `b${batch}n${i}` })
    yield* kit.advance(MIN)
  }
  lists = 0
  hooks.throwAtWrite = { n: 2, failure: busy() }
  assert.isFalse((yield* kit.action("cancel", { all: true, bulk: "timers" })).ok)
  assert.strictEqual(lists, 1)
  assert.strictEqual(ringing(kit).length, 10)
  lists = 0
  assert.include(said(yield* kit.action("cancel", { all: true, bulk: "timers" })), "100 timers")
  assert.strictEqual(lists, 1)
  assert.strictEqual(ringing(kit).length, 0)
}))

it.effect("14: waiting and countdown-only cleanup replies describe the actual outstanding work", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(timersModule, hooks))
  yield* kit.action("start", { duration: "1 minute", name: "tea" })
  hooks.sendFailRing = busyFailure()
  yield* kit.advance(MIN)
  assert.include(said(yield* kit.action("pause", { name: "tea" })), "could not be sent yet")
  assert.include(said(yield* kit.action("resume", { name: "tea" })), "could not be sent yet")
  assert.strictEqual(ringing(kit).length, 0)
  yield* kit.action("cancel", { name: "tea" })
  yield* kit.action("start", { duration: "1 hour", name: "bread" })
  hooks.dismissFail = presentFailure()
  yield* kit.action("cancel", { name: "bread" })
  assert.include(said(yield* kit.action("cancel", { name: "bread" })), "countdown")
}))

it.effect("14: a missed timer after downtime reports no invented notification refusal", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, { settings: { ringMinutes: 1 } })
  yield* kit.action("start", { duration: "1 minute" })
  yield* kit.stop
  yield* kit.advance(4 * MIN)
  yield* kit.start
  yield* kit.advance(0)
  assert.deepStrictEqual(yield* kit.notify.all, [])
  const report = (yield* kit.jobs).find((j) => j.handler === "trouble")!
  assert.include(JSON.stringify(report.payload), "could not ring")
  assert.notInclude(JSON.stringify(report.payload), "refused")
}))

it.effect("15: the calendar-year anniversary is allowed; one minute beyond and a distant date write no row or job", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  assert.include(said(yield* kit.action("set", { when: "18 November 2027 at 10:00" })), "Alarm set")
  for (const when of ["18 November 2027 at 10:01", "19 November 2027 at 09:59", "1 January 2029 at noon"]) {
    assert.strictEqual(said(yield* kit.action("set", { when })), "I set alarms up to a year ahead.")
    assert.strictEqual((yield* alarmRows(kit)).length, 1)
    assert.strictEqual((yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled").length, 1)
  }
}))

for (const timer of [true, false]) {
  it.effect(`16: ${timer ? "timer" : "alarm"} hourly sweep replaces its lost keyed delivery job and rings on time`, () => Effect.gen(function*() {
    let scheduler: ModuleScheduler | undefined
    const base = timer ? timersModule : alarmsModule
    const kit = yield* startTestModule({ ...base, shared: (ctx) => { scheduler = ctx.scheduler; return base.shared!(ctx) } })
    yield* kit.action(timer ? "start" : "set", timer ? { duration: "40 minutes", name: "tea" } : { when: "10:40", name: "tea" })
    const original = (yield* kit.jobs).find((j) => j.handler === "due" && j.state === "scheduled")!
    yield* scheduler!.cancel({ key: original.key! })
    assert.strictEqual((yield* kit.jobs).filter((j) => j.key === original.key && j.state === "scheduled").length, 0)
    yield* kit.advance(25 * MIN)
    const repaired = (yield* kit.jobs).filter((j) => j.key === original.key && j.state === "scheduled")
    assert.strictEqual(repaired.length, 1)
    assert.notStrictEqual(repaired[0]!.id, original.id)
    assert.strictEqual(repaired[0]!.dueAt, original.dueAt)
    yield* kit.advance(15 * MIN)
    assert.strictEqual(ringing(kit).length, 1)
    assert.strictEqual((yield* kit.notify.all).find((n) => n.priority === "ring")?.sentAt, original.dueAt)
  }))
}

it.effect("8: on-time daily alarms do bounded recurrence work below the main-thread budget", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01" })
  recurrence.stops.length = 0
  recurrence.limits.length = 0
  const delivered = new Set<string>()
  for (let round = 0; round < 5; round++) {
    yield* kit.advance(round === 0 ? MIN : DAY)
    assert.strictEqual(ringing(kit).length, 1)
    delivered.add(ringing(kit)[0]!.id)
  }
  assert.strictEqual(delivered.size, 5)
  assert.isAbove(recurrence.stops.length, 0)
  console.log(`alarms: longest synchronous recurrence call over five on-time deliveries: ${Math.max(...recurrence.stops).toFixed(2)} ms; largest requested expansion: ${Math.max(1, ...recurrence.limits)}`)
  assert.isAtMost(Math.max(1, ...recurrence.limits), 2)
  assert.isBelow(Math.max(...recurrence.stops), bound(10))
}))

it.effect("3: service duplicate detection includes the exact fallback label A", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  const service = kit.service(Timers) as TimersService
  yield* kit.asTurn(service.start({ durationMs: MIN, label: "A" }))
  assert.strictEqual((yield* Effect.flip(kit.asTurn(service.start({ durationMs: MIN, label: "A" })))).reason, "invalid")
  assert.strictEqual((yield* timerRows(kit)).length, 1)
}))

it.effect("14: repeated countdown-only cancellation never claims a ring is being stopped", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(timersModule, hooks))
  yield* kit.action("start", { duration: "1 hour", name: "bread" })
  hooks.dismissFail = presentFailure()
  yield* kit.action("cancel", { name: "bread" })
  const again = said(yield* kit.action("cancel", { name: "bread" }))
  assert.include(again, "countdown")
  assert.notInclude(again, "ring")
}))

it.effect("15: leap-day year horizon clamps to the next February's last day in the Home zone", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, { startAt: Date.UTC(2024, 1, 29, 9) })
  assert.include(said(yield* kit.action("set", { when: "28 February 2025 at 10:00" })), "Alarm set")
  assert.strictEqual(said(yield* kit.action("set", { when: "28 February 2025 at 10:01" })), "I set alarms up to a year ahead.")
  assert.strictEqual((yield* alarmRows(kit)).length, 1)
  assert.strictEqual((yield* kit.jobs).filter((j) => j.handler === "due" && j.state === "scheduled").length, 1)
}))

it.effect("11: elsewhere waiting and withdrawing one-offs retain distinct nominal times", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(alarmsModule, hooks))
  for (const [when, name] of [["10:01", "tea"], ["10:02", "bread"]]) yield* kit.action("set", { when, name })
  hooks.sendFailRing = busyFailure()
  yield* kit.advance(2 * MIN)
  const waiting = said(yield* kit.action("list", {}, hall))
  assert.include(waiting, "ten oh one")
  assert.include(waiting, "ten oh two")
  hooks.sendFailRing = undefined
  yield* kit.advance(30_000)
  hooks.resolveFail = busyFailure()
  for (const which of ["10:01", "10:02"]) yield* kit.action("cancel", { which }, hall)
  const question = said(yield* kit.action("cancel", {}, hall))
  assert.include(question, "ten oh one")
  assert.include(question, "ten oh two")
  assert.notInclude(question, "tea")
  assert.notInclude(question, "bread")
}))
