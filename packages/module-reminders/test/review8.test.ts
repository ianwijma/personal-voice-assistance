import { assert, describe, it, vi } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { noteKey } from "../src/index.ts"
import { nextOf } from "../src/model.ts"
import { assertJob, DAY, faulty, H, MIN, nofaults, openNotes, SAM, spoken, theRow, type Kit } from "./helpers.ts"

vi.setConfig({ testTimeout: 180_000 })
const as = { device: SAM }
const daily = (k: Kit, late = 0) => Effect.gen(function*() {
  yield* k.tool("reminders_set", { text: "call mum", when: "every day at 11 am", scope: "household" }, as)
  const first = (yield* theRow(k)).value.dueAt!
  if (late > 0) yield* k.stop
  yield* k.advance(first + late - (yield* k.now) + 1_000)
  if (late > 0) { yield* k.start; yield* k.advance(1_000) }
  return first
})

describe("GPT review Round 6", () => {
  for (const old of ["expired", "open"]) it.effect(`1: named Done answers the newer open attempt with yesterday's notification ${old}`, () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: old === "open" ? "normal" : "ring" } })
    const first = yield* daily(k, old === "open" ? H : 0)
    yield* k.advance(first + DAY - 1_000 - (yield* k.now))
    assert.strictEqual((yield* openNotes(k)).length, old === "open" ? 1 : 0)
    f.afterSend = () => { f.afterSend = undefined; f.failTransactions = 1 }
    yield* k.advance(2_000)
    const before = yield* theRow(k)
    assert.strictEqual(before.value.ring?.at, first)
    assert.strictEqual(before.value.owed?.at, first + DAY)
    assert.strictEqual(before.value.owed?.attempts, 1)
    assert.isTrue((yield* openNotes(k)).some(n => n.key === noteKey(before.id, first + DAY)))

    const reply = spoken(yield* k.tool("reminders_done", { which: "call mum" }, as))
    assert.include(reply, "Done. The next one is tomorrow")
    assert.deepStrictEqual(yield* openNotes(k), [])
    const after = yield* theRow(k)
    assert.isUndefined(after.value.ring)
    assert.isUndefined(after.value.owed)
    assert.strictEqual(after.value.dueAt, first + 2 * DAY)
    yield* assertJob(k, after.id, { future: true })
    yield* k.advance(MIN)
    assert.deepStrictEqual(yield* openNotes(k), [], "the failed ring write must not leave a delivery retry")
    assert.strictEqual((yield* theRow(k)).value.dueAt, first + 2 * DAY)
  }))

  it.effect("1: named Done preserves a newer attempted delivery whose notification has not arrived", () => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f), { settings: { priority: "normal" } })
    const first = yield* daily(k, H)
    f.sendFails = 1
    yield* k.advance(first + DAY + 1_000 - (yield* k.now))
    const before = yield* theRow(k)
    assert.strictEqual(before.value.owed?.attempts, 1)
    assert.strictEqual((yield* openNotes(k)).length, 1)
    const reply = spoken(yield* k.tool("reminders_done", { which: "call mum" }, as))
    assert.include(reply, "Done.")
    assert.notInclude(reply, "tomorrow")
    assert.deepStrictEqual((yield* theRow(k)).value.owed, before.value.owed)
    assert.isUndefined((yield* theRow(k)).value.ring)
    yield* assertJob(k, before.id, { future: true })
    yield* k.advance(MIN)
    assert.deepStrictEqual((yield* openNotes(k)).map(n => n.key), [noteKey(before.id, first + DAY)])
  }))

  for (const repeat of [false, true]) for (const failedResolve of [false, true]) {
    it.effect(`2: named Done answers a rescheduled ${repeat ? "repeat" : "one-off"} after ${failedResolve ? "one failed" : "successful"} cleanup`, () => Effect.gen(function*() {
      const f = nofaults(), k = yield* startTestModule(faulty(f))
      yield* k.tool("reminders_set", { text: "call mum", when: repeat ? "every day at 11 am" : "in a minute", scope: "household" }, as)
      yield* k.advance((yield* theRow(k)).value.dueAt! - (yield* k.now) + 1_000)
      assert.strictEqual((yield* openNotes(k)).length, 1)
      f.resolveFails = Number(failedResolve)
      // Keeping the repeat's rule still edits its time: tomorrow is now the next unanswered occurrence.
      yield* k.tool("reminders_change", { which: "call mum", when: repeat ? "every day at 11 am" : "in ten minutes" }, as)
      const edited = yield* theRow(k)
      assert.strictEqual(edited.value.stop !== undefined, failedResolve)
      assert.isUndefined(edited.value.ring)
      const at = edited.value.dueAt!
      const next = nextOf(edited.value, at)
      const reply = spoken(yield* k.tool("reminders_done", { which: "call mum" }, as))
      assert.notInclude(reply, "already done")
      assert.include(reply, repeat ? "skip the one" : "Done.")
      const after = yield* theRow(k)
      assert.strictEqual(after.value.state, repeat ? "open" : "done")
      assert.strictEqual(after.value.dueAt, next)
      assert.deepStrictEqual(yield* openNotes(k), [], "the old notification is cleaned up inline")
      yield* assertJob(k, after.id, { future: true })
      yield* k.advance(at + 1_000 - (yield* k.now))
      assert.deepStrictEqual(yield* openNotes(k), [], "the occurrence just answered must not ring at its edited time")
      yield* assertJob(k, after.id, { future: true })
    }))
  }
})
