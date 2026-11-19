// GPT review round 6: cancel matches current times or device-local names, never a stale snooze or a time-like label.
import { assert, it } from "@effect/vitest"
import { NotifyError, StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { alarms, alarmsModule } from "../src/index.ts"
import { hooked, makeHooks, makeRegistered } from "./support.ts"

const MIN = 60_000
const device = "kitchen-display"
const hall = { device: "hall-screen", conversationId: "c-hall" }

for (const scope of ["next", "all"]) for (const settled of [false, true]) it.effect(`1: expired snooze time cannot cancel ${scope} ${settled ? "after" : "before"} the recovery job`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01", name: "Tea" })
  yield* kit.advance(MIN)
  yield* kit.notify.press(kit.notify.engine.ringingOn(device)[0]!.id, "more", { device })
  yield* kit.stop
  yield* kit.advance(21 * MIN)
  yield* kit.start
  if (settled) yield* kit.advance(0)
  const listed = yield* kit.action("list", {}, hall)
  assert.isTrue(listed.ok)
  assert.include(listed.say!, "tomorrow at ten oh one")
  const reply = yield* kit.action("cancel", { which: "10:06", scope }, hall)
  assert.isTrue(reply.ok)
  assert.strictEqual(reply.say, "There is no alarm at ten oh six in the morning.")
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.phase, "set")
  assert.strictEqual(row.value.next?.date, "2026-11-19")
  assert.strictEqual(row.value.next?.time, "10:01")
}))

for (const expired of [false, true]) it.effect(`1: owed snooze time matches ${expired ? "only through" : "at"} the inclusive fifteen-minute deadline`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01" })
  yield* kit.advance(MIN)
  yield* kit.notify.press(kit.notify.engine.ringingOn(device)[0]!.id, "more", { device })
  yield* kit.stop
  yield* kit.advance(20 * MIN + (expired ? 1 : 0))
  yield* kit.start
  const reply = yield* kit.action("cancel", { which: "10:06", scope: "next" }, hall)
  assert.isTrue(reply.ok)
  assert.include(reply.say!, expired ? "There is no alarm" : "snoozed alarm is cancelled")
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.next?.date, "2026-11-19")
}))


it.effect("1: an open snooze with a lost outcome still matches after its delivery deadline", () => Effect.gen(function*() {
  let armed = false, failures = 0, failSnooze = false
  const kit = yield* startTestModule({ ...alarmsModule, shared: (ctx) => alarmsModule.shared!({
    ...ctx,
    notify: { ...ctx.notify, send: (request) => Effect.tap(ctx.notify.send(request), () => Effect.sync(() => {
      if (failSnooze && request.priority === "ring" && failures === 0) armed = true
    })) },
    store: { ...ctx.store, transaction: (f) => Effect.suspend(() => {
      if (!armed) return ctx.store.transaction(f)
      armed = false
      failures++
      return Effect.sleep(2).pipe(Effect.andThen(Effect.fail(new StoreError({ reason: "busy", message: "one delayed outcome write failed" }))))
    }) }
  }) }, { settings: { ringMinutes: 120 } })
  yield* kit.action("set", { when: "every day at 10:01" })
  yield* kit.advance(MIN)
  yield* kit.notify.press(kit.notify.engine.ringingOn(device)[0]!.id, "more", { device })
  yield* kit.stop
  yield* kit.advance(20 * MIN - 1)
  yield* kit.start
  failSnooze = true
  yield* kit.advance(2)
  assert.strictEqual(failures, 1)
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.isTrue(row.value.owed?.snoozed)
  assert.isAbove((yield* kit.now) - row.value.owed!.at, 15 * MIN)
  assert.strictEqual(kit.notify.engine.ringingOn(device).length, 1)
  const reply = yield* kit.action("cancel", { which: "10:06", scope: "next" }, hall)
  assert.isTrue(reply.ok)
  assert.include(reply.say!, "snoozed alarm is cancelled")
  assert.strictEqual((yield* kit.moduleStore().collection(alarms).get(row.id))!.value.next?.date, "2026-11-19")
  yield* kit.advance(0)
  assert.strictEqual(kit.notify.engine.ringingOn(device).length, 0)
}))

for (const open of [false, true]) it.effect(`1: withdrawal ${open ? "matches" : "does not match"} the snooze time with its notification ${open ? "open" : "stopped"}`, () => Effect.gen(function*() {
  const hooks = makeHooks(), registered = makeRegistered()
  const kit = yield* startTestModule(hooked(alarmsModule, hooks, registered))
  yield* kit.action("set", { when: "every day at 10:01", name: "Tea" })
  yield* kit.advance(MIN)
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  const card = kit.notify.engine.ringingOn(device)[0]!
  // Keep the source card open, as when the notification service has not recorded the press outcome yet.
  yield* registered.presses.get("alarm")!.run({ notificationId: card.id, key: `alarm:${row.id}:1`, actionId: "more", deviceId: device })
  hooks.resolveFail = new NotifyError({ reason: "busy", message: "withdrawal refused" })
  yield* kit.action("cancel", { which: "Tea", scope: "next" })
  assert.isDefined((yield* kit.moduleStore().collection(alarms).get(row.id))!.value.withdraw)
  if (!open) yield* kit.notify.press(card.id, "stop", { device })
  const reply = yield* kit.action("cancel", { which: "10:06", scope: "all" }, hall)
  assert.isTrue(reply.ok)
  assert.include(reply.say!, open ? "still being stopped" : "There is no alarm")
  assert.strictEqual((yield* kit.moduleStore().collection(alarms).get(row.id))!.value.next?.date, open ? undefined : "2026-11-19")
  if (!open) {
    hooks.resolveFail = undefined
    const cleanup = yield* kit.action("cancel", { which: "10:01", scope: "next" }, hall)
    assert.isTrue(cleanup.ok)
    assert.include(cleanup.say!, "stopped")
    assert.strictEqual((yield* kit.moduleStore().collection(alarms).get(row.id))!.value.next?.date, "2026-11-19")
  }
}))

for (const here of [undefined, hall]) it.effect(`2: noon selects the noon occurrence despite an 11:55 alarm named Noon ${here ? "elsewhere" : "locally"}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "11:55", name: "Noon" })
  yield* kit.action("set", { when: "noon", name: "Lunch" })
  const reply = yield* kit.action("cancel", { which: "noon" }, here)
  assert.isTrue(reply.ok)
  assert.strictEqual(reply.say, "The alarm for today at noon is cancelled.")
  const rows = yield* kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })
  assert.deepStrictEqual(rows.map((r) => r.value.next?.time), ["11:55"])
}))

it.effect("2: a time request with no matching time never falls back to a local name", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "11:55", name: "Noon" })
  const reply = yield* kit.action("cancel", { which: "noon" })
  assert.isTrue(reply.ok)
  assert.strictEqual(reply.say, "There is no alarm at noon.")
  assert.strictEqual((yield* kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })).length, 1)
}))

for (const byTime of [false, true]) it.effect(`2: multiple ${byTime ? "time" : "local name"} matches ask and leave both alarms set`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "noon", name: byTime ? "Noon" : "Tea" })
  yield* kit.action("set", { when: byTime ? "tomorrow at noon" : "11:55", name: "Tea" })
  const reply = yield* kit.action("cancel", { which: byTime ? "noon" : "Tea" })
  assert.isTrue(reply.ok)
  assert.include(reply.say!, "Which one?")
  assert.strictEqual((yield* kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })).length, 2)
}))

it.effect("2: a non-time name stays local to its device", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "11:55", name: "Tea" })
  const elsewhere = yield* kit.action("cancel", { which: "Tea" }, hall)
  assert.isTrue(elsewhere.ok)
  assert.strictEqual(elsewhere.say, "Which alarm do you mean? Say its clock time and date, or say \"named\" followed by its name.")
  const local = yield* kit.action("cancel", { which: "Tea" })
  assert.isTrue(local.ok)
  assert.include(local.say!, "cancelled")
  assert.strictEqual((yield* kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })).length, 0)
}))
