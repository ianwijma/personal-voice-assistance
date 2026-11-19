// GPT review round 5: catch up before selecting the next ring; admit the resulting timers and first alarm instant.
import { assert, it } from "@effect/vitest"
import { StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { alarms, alarmsModule, timers, timersModule } from "../src/index.ts"
import { hooked, makeHooks } from "./support.ts"

const MIN = 60_000
const DAY = 24 * 60 * MIN
const device = "kitchen-display"
const hall = { device: "hall-screen", conversationId: "c-hall" }
const busy = () => new StoreError({ reason: "busy", message: "one failed due write" })

for (const settled of [false, true]) it.effect(`1: skip-next catches up a restarted daily alarm ${settled ? "after" : "before"} its job runs`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01", name: "Tea" })
  yield* kit.stop
  yield* kit.advance(3 * DAY + 30_000)
  yield* kit.start
  if (settled) yield* kit.advance(0)
  const beforeList = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  const listed = yield* kit.action("list", {}, hall)
  assert.strictEqual((yield* kit.moduleStore().collection(alarms).get(beforeList.id))?.rev, beforeList.rev, "a speculative list must not write")
  const skipped = yield* kit.action("cancel", { which: "10:01", scope: "next" }, hall)
  assert.isTrue(listed.ok)
  assert.isTrue(skipped.ok)
  assert.include(listed.say!, "today at ten oh one")
  assert.notInclude(listed.say!, "Tea")
  assert.include(skipped.say!, "today at ten oh one in the morning is skipped")
  assert.include(skipped.say!, "tomorrow at ten oh one")
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.next?.date, "2026-11-22")
  yield* kit.advance(30_000)
  assert.strictEqual(kit.notify.engine.ringingOn(device).length, 0)
  yield* kit.advance(DAY)
  assert.strictEqual(kit.notify.engine.ringingOn(device).length, 1)
  assert.strictEqual(kit.notify.engine.ringingOn(hall.device).length, 0)
}))

for (const late of [5, 17]) it.effect(`1: skip-next preserves the late rule after a restart ${late} minutes past ten`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01", name: "Tea" })
  yield* kit.stop
  yield* kit.advance(3 * DAY + late * MIN)
  yield* kit.start
  const skipped = yield* kit.action("cancel", { which: "10:01", scope: "next" }, hall)
  assert.isTrue(skipped.ok)
  assert.include(skipped.say!, late === 5 ? "today at ten oh one" : "tomorrow at ten oh one in the morning is skipped")
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.next?.date, late === 5 ? "2026-11-22" : "2026-11-23")
  yield* kit.advance(0)
  assert.strictEqual(kit.notify.engine.ringingOn(device).length, 0)
  if (late === 17) {
    assert.isTrue((yield* kit.notify.all).some((n) => n.key?.startsWith("alarm-missed:") === true), "the expired occurrence still gets its missed card")
    yield* kit.advance(DAY)
    assert.strictEqual(kit.notify.engine.ringingOn(device).length, 0)
  }
}))

it.effect("1: caught-up alarm lists sort by the next ring, not an expired delivery", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01", name: "Tea" })
  yield* kit.action("set", { when: "21 November at eleven" })
  yield* kit.stop
  yield* kit.advance(3 * DAY + 17 * MIN)
  yield* kit.start
  const listed = yield* kit.action("list", {}, hall)
  assert.isTrue(listed.ok)
  assert.include(listed.say!, "today at eleven")
  assert.include(listed.say!, "tomorrow at ten oh one")
  assert.isBelow(listed.say!.indexOf("today at eleven"), listed.say!.indexOf("tomorrow at ten oh one"))
}))

it.effect("2: rearming an overdue row counts the resulting 50 timers, not 51", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(timersModule, hooks))
  for (let i = 0; i < 49; i++) {
    yield* kit.action("start", { duration: "1 hour", name: `long${i}` })
    yield* kit.action("pause", { name: `long${i}` })
  }
  yield* kit.action("start", { duration: "1 minute", name: "Tea" })
  hooks.txFail = { times: 1, failure: busy() }
  yield* kit.advance(62_000)
  assert.strictEqual(hooks.txFail.times, 0)
  const adjusted = yield* kit.action("adjust", { amount: "5 minutes", name: "Tea", change: "add" })
  assert.isTrue(adjusted.ok)
  assert.include(adjusted.say!, "runs again: 5 minutes")
  const full = yield* kit.action("start", { duration: "3 minutes", name: "extra" })
  assert.isFalse(full.ok, "49 paused plus the rearmed timer fill all 50 places")
  yield* kit.advance(5 * MIN)
  assert.strictEqual(kit.notify.engine.ringingOn(device).length, 1)
}))

it.effect("2: starting at capacity frees an overdue place and preserves its owed ring", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(timersModule, hooks))
  for (let i = 0; i < 49; i++) {
    yield* kit.action("start", { duration: "1 hour", name: `long${i}` })
    yield* kit.action("pause", { name: `long${i}` })
  }
  yield* kit.action("start", { duration: "1 minute", name: "Tea" })
  const tea = (yield* kit.moduleStore().collection(timers).list({ where: { pending: true }, orderBy: { field: "nextAt", direction: "asc" }, limit: 1 }))[0]!
  assert.strictEqual(tea.value.name, "Tea")
  hooks.txFail = { times: 1, failure: busy() }
  yield* kit.advance(62_000)
  assert.strictEqual(hooks.txFail.times, 0)
  const started = yield* kit.action("start", { duration: "3 minutes", name: "extra" })
  assert.isTrue(started.ok)
  const overdue = yield* kit.moduleStore().collection(timers).get(tea.id)
  assert.strictEqual(overdue?.value.state, "done")
  assert.isDefined(overdue?.value.owed)
  assert.isTrue(overdue!.value.pending)
  yield* kit.advance(15_000)
  assert.strictEqual(kit.notify.engine.ringingOn(device).length, 1)
}))

it.effect("2: an overdue timer no longer reserves its name or reports time left in ambient context", () => Effect.gen(function*() {
  const hooks = makeHooks()
  const kit = yield* startTestModule(hooked(timersModule, hooks))
  yield* kit.action("start", { duration: "1 minute", name: "Tea" })
  hooks.txFail = { times: 1, failure: busy() }
  yield* kit.advance(62_000)
  assert.strictEqual(hooks.txFail.times, 0)
  const rows = yield* kit.moduleStore().collection(timers).list({ limit: 1 })
  const ambient = timers.ambient!(rows, { now: yield* kit.now, turn: undefined })
  yield* kit.action("list", { name: "Tea" })
  assert.strictEqual((yield* kit.moduleStore().collection(timers).get(rows[0]!.id))?.rev, rows[0]!.rev, "a speculative list must not write")
  const started = yield* kit.action("start", { duration: "3 minutes", name: "Tea" })
  assert.isTrue(started.ok)
  assert.strictEqual(started.say, "Tea timer, 3 minutes.")
  assert.notInclude(ambient ?? "", "1 second left")
  yield* kit.advance(15_000)
  assert.strictEqual(kit.notify.engine.ringingOn(device).length, 1)
}))

it.effect("3: repeating alarms obey the same first-ring horizon as one-off alarms", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  for (const when of ["29 February 2028 at seven", "every February 29th at seven"]) {
    const refused = yield* kit.action("set", { when })
    assert.isTrue(refused.ok)
    assert.strictEqual(refused.say, "I set alarms up to a year ahead.")
    assert.strictEqual((yield* kit.moduleStore().collection(alarms).list({ limit: 10 })).length, 0)
  }
  const accepted = yield* kit.action("set", { when: "every 2 years at seven" })
  assert.isTrue(accepted.ok)
  assert.include(accepted.say!, "Alarm set")
  const row = (yield* kit.moduleStore().collection(alarms).list({ limit: 1 }))[0]!
  assert.strictEqual(row.value.next?.date, "2027-11-18")
  yield* kit.stop
  // Start a fresh harness just before the accepted first ring, with that persisted series as the fixture.
  const future = yield* startTestModule(alarmsModule, { startAt: row.value.next!.at - MIN })
  const restored = yield* future.moduleStore().collection(alarms).insert(row.value)
  yield* future.advance(MIN)
  assert.strictEqual(future.notify.engine.ringingOn(device).length, 1)
  const later = yield* future.moduleStore().collection(alarms).get(restored.id)
  assert.strictEqual(later?.value.next?.date, "2029-11-18", "later occurrences of an accepted series are not capped")
}))
