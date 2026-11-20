// GPT review round 3: stopped and ringing snoozes, and one lost outcome at the delivery deadline.
import { assert, it } from "@effect/vitest"
import { StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { alarms, alarmsModule, timers, timersModule } from "../src/index.ts"

const MIN = 60_000
const device = "kitchen-display"
const hall = { device: "hall-screen", conversationId: "c-hall" }
const ringing = (kit: { notify: { engine: { ringingOn: (device: string) => ReadonlyArray<{ readonly id: string }> } } }) => kit.notify.engine.ringingOn(device)

for (const another of [false, true]) it.effect(`1: a stopped snooze's time ${another ? "selects only the real alarm at that time" : "does not select tomorrow's series"}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01", name: "Tea" })
  yield* kit.advance(MIN)
  yield* kit.notify.press(ringing(kit)[0]!.id, "snooze", { device })
  yield* kit.advance(9 * MIN)
  yield* kit.notify.press(ringing(kit)[0]!.id, "stop", { device })
  yield* kit.advance(1000)
  if (another) yield* kit.action("set", { when: "tomorrow at 10:10", name: "Train" })
  const listed = yield* kit.action("list", {}, hall)
  assert.isTrue(listed.ok)
  assert.notInclude(listed.say!, "ringing")
  const cancelled = yield* kit.action("cancel", { which: "10:10", scope: "all" }, hall)
  assert.isTrue(cancelled.ok)
  assert.include(cancelled.say!, another ? "cancelled" : "no alarm")
  const rows = yield* kit.moduleStore().collection(alarms).list({ limit: 10 })
  assert.strictEqual(rows.find((r) => r.value.name === "Tea")!.value.next?.date, "2026-11-19")
  assert.strictEqual(rows.filter((r) => r.value.phase === "set").length, 1)
}))

for (const snooze of [true, false]) it.effect(`2: cancel-next by ${snooze ? "the ringing snooze time stops it and preserves tomorrow" : "the regular time skips tomorrow and keeps today's snooze"}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01", name: "Tea" })
  yield* kit.advance(MIN)
  yield* kit.notify.press(ringing(kit)[0]!.id, "snooze", { device })
  yield* kit.advance(9 * MIN)
  const notification = ringing(kit)[0]!.id
  const cancelled = yield* kit.action("cancel", { which: snooze ? "10:10" : "10:01", scope: "next" }, hall)
  yield* kit.advance(0)
  assert.isTrue(cancelled.ok)
  assert.include(cancelled.say!, snooze ? "snoozed" : "skipped")
  assert.strictEqual(ringing(kit).length, snooze ? 0 : 1)
  if (!snooze) assert.strictEqual(ringing(kit)[0]!.id, notification)
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.next?.date, snooze ? "2026-11-19" : "2026-11-20")
}))

for (const timer of [false, true]) it.effect(`3: ${timer ? "timer" : "alarm"} recovers its live ring after one delayed outcome write fails across the deadline`, () => Effect.gen(function*() {
  const base = timer ? timersModule : alarmsModule
  let armed = false, failures = 0
  const kit = yield* startTestModule({ ...base, shared: (ctx) => base.shared!({
    ...ctx,
    notify: { ...ctx.notify, send: (request) => Effect.tap(ctx.notify.send(request), () => Effect.sync(() => {
      if (request.priority === "ring" && failures === 0) armed = true
    })) },
    store: { ...ctx.store, transaction: (f) => Effect.suspend(() => {
      if (!armed) return ctx.store.transaction(f)
      armed = false
      failures++
      return Effect.sleep(2).pipe(Effect.andThen(Effect.fail(new StoreError({ reason: "busy", message: "one outcome write took 2ms and failed" }))))
    }) }
  }) }, { settings: { ringMinutes: timer ? 2 : 120 } })
  yield* kit.action(timer ? "start" : "set", timer ? { duration: "1 minute", name: "Tea" } : { when: "10:01", name: "Tea" })
  yield* kit.stop
  yield* kit.advance((timer ? 3 : 16) * MIN - 1)
  yield* kit.start
  yield* kit.advance(6010)
  assert.strictEqual(failures, 1)
  assert.strictEqual(ringing(kit).length, 1)
  const notification = (yield* kit.notify.all).find((n) => n.priority === "ring")!
  const row = timer
    ? (yield* kit.moduleStore().collection(timers).list({ limit: 1 }))[0]!
    : (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.ring?.notification, notification.id)
  assert.strictEqual(row.value.ring?.until, notification.expiresAt, "recovery preserves the original expiry")
  assert.isUndefined(row.value.owed)
  assert.isTrue(row.value.pending)
  assert.isFalse((yield* kit.notify.all).some((n) => n.key?.startsWith("alarm-missed:")))
  assert.isFalse((yield* kit.jobs).some((j) => j.handler === "trouble"))
  const cancelled = yield* kit.action("cancel", timer ? { name: "Tea" } : { which: "10:01" }, timer ? undefined : hall)
  yield* kit.advance(0)
  assert.isTrue(cancelled.ok)
  assert.strictEqual(ringing(kit).length, 0)
}))
