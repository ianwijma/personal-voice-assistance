// GPT review round 4: one failed due write and one lost snooze-send outcome.
import { assert, it } from "@effect/vitest"
import { type ActionRunResult, StoreError } from "@pva/core"
import { type ModuleHarness, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { alarms, alarmsModule, timers, timersModule } from "../src/index.ts"
import { hooked, makeHooks } from "./support.ts"

const MIN = 60_000
const device = "kitchen-display"
const hall = { device: "hall-screen", conversationId: "c-hall" }
const busy = () => new StoreError({ reason: "busy", message: "one failed write" })
const ringing = (kit: ModuleHarness) => kit.notify.engine.ringingOn(device)

for (const named of [false, true]) it.effect(`1: overdue timer ${named ? "named" : "unnamed"} reads and pause preserve delivery after one failed due write`, () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(timersModule, hooks))
  yield* kit.action("start", { duration: "1 minute", name: "Tea" })
  hooks.txFail = { times: 1, failure: busy() }
  yield* kit.advance(62_000)
  assert.strictEqual(hooks.txFail.times, 0)
  const input = named ? { name: "Tea" } : {}
  const listed = yield* kit.action("list", input)
  const paused = yield* kit.action("pause", input)
  assert.isTrue(listed.ok)
  assert.isTrue(paused.ok)
  assert.include(listed.say!, "could not be sent yet")
  assert.include(paused.say!, "could not be sent yet")
  const row = (yield* kit.moduleStore().collection(timers).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.state, "done")
  assert.isDefined(row.value.owed)
  assert.isTrue(row.value.pending)
  yield* kit.advance(15_000)
  assert.strictEqual(ringing(kit).length, 1)
  assert.strictEqual((yield* kit.notify.all).filter((n) => n.priority === "ring").length, 1)
}))

for (const fault of [false, true]) for (const snooze of [false, true]) it.effect(`2: cancel-next by ${snooze ? "snooze" : "regular"} time selects the same occurrence ${fault ? "after one lost outcome" : "without a fault"}`, () => Effect.gen(function*() {
  const hooks = makeHooks()
  const base = hooked(alarmsModule, hooks)
  let armed = false, captured = false
  let observed: { listed: ActionRunResult; cancelled: ActionRunResult; notification: string; owed: boolean } | undefined
  const observe = () => Effect.gen(function*() {
    const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
    const notification = ringing(kit)[0]!.id
    const listed = yield* kit.action("list", {}, hall)
    const cancelled = yield* kit.action("cancel", { which: snooze ? "10:10" : "10:01", scope: "next" }, hall)
    observed = { listed, cancelled, notification, owed: row.value.owed?.snoozed === true }
  })
  // Observe before the retry enters the module lock, while the successful send is still unrecorded.
  const kit: ModuleHarness = yield* startTestModule({ ...base, shared: (ctx) => base.shared!({ ...ctx, scheduler: {
    ...ctx.scheduler,
    handle: (name, handler) => ctx.scheduler.handle(name, { ...handler, run: (...args) => Effect.gen(function*() {
      if (name === "due" && armed && !captured && hooks.txFail?.times === 0) {
        captured = true
        yield* observe()
      }
      return yield* handler.run(...args)
    }) })
  } }) })
  yield* kit.action("set", { when: "every day at 10:01", name: "Tea" })
  yield* kit.advance(MIN)
  yield* kit.notify.press(ringing(kit)[0]!.id, "snooze", { device })
  if (fault) { armed = true; hooks.failAfterSend = busy() }
  yield* kit.advance(9 * MIN)
  if (!fault) yield* observe()
  yield* kit.advance(6_000)
  assert.strictEqual(captured, fault)
  assert.isDefined(observed)
  assert.strictEqual(observed!.owed, fault)
  assert.isTrue(observed!.listed.ok)
  assert.isTrue(observed!.cancelled.ok)
  if (!observed!.listed.ok || !observed!.cancelled.ok) return
  assert.include(observed!.listed.say!, "ringing now")
  assert.notInclude(observed!.listed.say!, "Tea", "the hall must not receive the kitchen's private label")
  assert.include(observed!.cancelled.say!, snooze ? "snoozed" : "skipped")
  assert.strictEqual(ringing(kit).length, snooze ? 0 : 1)
  if (!snooze) assert.strictEqual(ringing(kit)[0]!.id, observed!.notification)
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.next?.date, snooze ? "2026-11-19" : "2026-11-20")
}))
