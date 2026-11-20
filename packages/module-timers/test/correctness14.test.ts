// Round 14: identical alarms are admitted once, and legacy duplicates remain cancellable.
import { assert, it } from "@effect/vitest"
import { type ModuleHarness, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { type Alarm, alarms, alarmsModule } from "../src/index.ts"

const MIN = 60_000
const DAY = 24 * 60 * MIN
const device = "kitchen-display"
const setRows = (kit: ModuleHarness) => kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })
const dueJobs = (kit: ModuleHarness) => Effect.map(kit.jobs, (jobs) => jobs.filter((j) => j.handler === "due" && (j.state === "scheduled" || j.state === "running")))

it.effect("1: setting an identical alarm twice keeps one row and job, also across restart", () => Effect.gen(function*() {
  for (const nl of [false, true]) for (const repeat of [false, true]) {
    const kit = yield* startTestModule(alarmsModule, nl ? { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } } : {})
    const when = repeat ? (nl ? "elke dag om 10:01" : "every day at 10:01") : "10:01"
    for (const name of [undefined, "Tea"]) {
      const first = yield* kit.action("set", { when, name })
      assert.isTrue(first.ok)
      const before = yield* setRows(kit)
      const jobs = yield* dueJobs(kit)
      const repeated = yield* kit.action("set", { when, name })
      assert.isTrue(repeated.ok)
      assert.include(repeated.say!, nl ? "staat al" : "already set")
      assert.deepStrictEqual(yield* setRows(kit), before)
      yield* kit.restart
      const duplicate = yield* kit.action("set", { when, name })
      assert.isTrue(duplicate.ok)
      assert.include(duplicate.say!, nl ? "staat al" : "already set")
      assert.include(duplicate.say!, nl ? "tien" : "ten oh one")
      assert.deepStrictEqual(yield* setRows(kit), before)
      assert.deepStrictEqual(yield* dueJobs(kit), jobs)
      const cancelled = yield* kit.action("cancel", { which: "10:01", scope: "all" })
      assert.isTrue(cancelled.ok)
      assert.notInclude(cancelled.say!, "?")
      assert.deepStrictEqual(yield* setRows(kit), [])
    }
    yield* kit.advance(MIN + DAY)
    assert.deepStrictEqual(kit.notify.engine.ringingOn(device), [])
    assert.deepStrictEqual(yield* dueJobs(kit), [])
  }
  // A difference in time, name, repetition, date or device still creates another alarm.
  const kit = yield* startTestModule(alarmsModule)
  for (const params of [
    { when: "every day at 10:01" }, { when: "every day at 10:02" },
    { when: "every day at 10:01", name: "Tea" }, { when: "every weekday at 10:01" },
    { when: "10:01" }, { when: "tomorrow at 10:01" }
  ]) assert.isTrue((yield* kit.action("set", params)).ok)
  yield* kit.action("set", { when: "every day at 10:01" }, { device: "hall-screen", conversationId: "c-hall" })
  assert.strictEqual((yield* setRows(kit)).length, 7)
  // Insert an old duplicate at the write boundary: an admission read outside the transaction would miss it.
  let legacy: Alarm | undefined
  const raced = yield* startTestModule({ ...alarmsModule, shared: (ctx) => alarmsModule.shared!({ ...ctx, store: {
    ...ctx.store,
    transaction: (f) => ctx.store.transaction((tx) => {
      if (legacy !== undefined) {
        tx.collection(alarms).insert(legacy)
        legacy = undefined
      }
      return f(tx)
    })
  } }) })
  yield* raced.action("set", { when: "every day at 10:01" })
  const [original] = yield* setRows(raced)
  yield* raced.action("cancel", { which: "10:01", scope: "all" })
  legacy = original!.value
  const reply = yield* raced.action("set", { when: "every day at 10:01" })
  assert.isTrue(reply.ok)
  assert.include(reply.say!, "already set")
  assert.strictEqual((yield* setRows(raced)).length, 1)
  yield* raced.restart
  yield* raced.advance(0)
  assert.strictEqual((yield* dueJobs(raced)).length, 1)
}), { timeout: 60_000 })

it.effect("1: indistinguishable legacy alarms cancel together with a count, also across restart", () => Effect.gen(function*() {
  for (const nl of [false, true]) for (const repeat of [false, true]) for (const which of [undefined, "10:01", "named Tea"]) {
    const kit = yield* startTestModule(alarmsModule, nl ? { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } } : {})
    yield* kit.action("set", { when: repeat ? (nl ? "elke dag om 10:01" : "every day at 10:01") : "10:01", ...(which === "named Tea" ? { name: "Tea" } : {}) })
    const [original] = yield* setRows(kit)
    assert.isDefined(original)
    // Seed the rows made by older versions; each receives its job during restart repair.
    yield* kit.moduleStore().collection(alarms).insert(original!.value)
    yield* kit.restart
    yield* kit.advance(0)
    const cancelled = yield* kit.action("cancel", { which, scope: "all" })
    assert.isTrue(cancelled.ok)
    assert.include(cancelled.say!, "2")
    assert.include(cancelled.say!, nl ? "geannuleerd" : "cancelled")
    assert.notInclude(cancelled.say!, "?")
    assert.deepStrictEqual(yield* setRows(kit), [])
    yield* kit.advance(MIN + DAY)
    assert.deepStrictEqual(kit.notify.engine.ringingOn(device), [])
    assert.deepStrictEqual(yield* dueJobs(kit), [])
  }
  // Time cancellation must still ask when a name, repetition, date or device distinguishes the candidates.
  for (const variant of ["name", "repetition", "date", "device"] as const) {
    const kit = yield* startTestModule(alarmsModule)
    yield* kit.action("set", { when: variant === "date" ? "10:01" : "every day at 10:01" })
    yield* kit.action("set", { when: variant === "repetition" ? "every weekday at 10:01" : variant === "date" ? "tomorrow at 10:01" : "every day at 10:01", ...(variant === "name" ? { name: "Tea" } : {}) }, variant === "device" ? { device: "hall-screen", conversationId: "c-hall" } : {})
    const before = yield* setRows(kit)
    assert.strictEqual(before.length, 2)
    const reply = yield* kit.action("cancel", { which: "10:01", scope: "all" })
    assert.isTrue(reply.ok)
    assert.include(reply.say!, "?")
    assert.deepStrictEqual(yield* setRows(kit), before)
  }
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "every day at 10:01" })
  yield* kit.action("set", { when: "every day at 10:02" })
  yield* kit.action("cancel", { which: "10:01", scope: "all" })
  assert.deepStrictEqual((yield* setRows(kit)).map((r) => r.value.next?.time), ["10:02"])
  const [remaining] = yield* setRows(kit)
  yield* kit.moduleStore().collection(alarms).insert(remaining!.value)
  yield* kit.restart
  yield* kit.advance(0)
  const before = yield* setRows(kit)
  const question = yield* kit.action("cancel", { which: "10:02" })
  assert.isTrue(question.ok)
  assert.include(question.say!, "Only the next one, or all")
  assert.deepStrictEqual(yield* setRows(kit), before)
  const skipped = yield* kit.action("cancel", { which: "10:02", scope: "next" })
  assert.isTrue(skipped.ok)
  assert.include(skipped.say!, "2")
  assert.include(skipped.say!, "skipped")
  assert.deepStrictEqual((yield* setRows(kit)).map((r) => r.value.next?.date), ["2026-11-19", "2026-11-19"])
  yield* kit.advance(2 * MIN)
  assert.deepStrictEqual(kit.notify.engine.ringingOn(device), [])
  yield* kit.action("cancel", { which: "10:02", scope: "all" })
  yield* kit.advance(DAY)
  assert.deepStrictEqual(kit.notify.engine.ringingOn(device), [])
}), { timeout: 60_000 })
