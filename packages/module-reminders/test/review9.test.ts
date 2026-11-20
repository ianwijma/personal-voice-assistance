import { assert, describe, it, vi } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { noteKey } from "../src/index.ts"
import { assertJob, DAY, faulty, jobOf, nofaults, openNotes, SAM, spoken, theRow } from "./helpers.ts"

vi.setConfig({ testTimeout: 180_000 })
const as = { device: SAM }

describe("GPT review Round 7", () => {
  it.effect.each(["name", "button"] as const)("1: rescheduling after Done starts an occurrence answerable by %s", (by) => Effect.gen(function*() {
    const f = nofaults(), k = yield* startTestModule(faulty(f))
    yield* k.tool("reminders_set", { text: "call mum", when: "every day at 11 am", scope: "household" }, as)
    const first = (yield* theRow(k)).value.dueAt!
    yield* k.advance(first - (yield* k.now) + 1_000)
    const [old] = yield* openNotes(k)
    assert.isDefined(old)
    assert.isTrue((yield* k.notify.press(old!.id, "done", as)).ok)
    assert.strictEqual((yield* theRow(k)).value.stop?.cardAt, first)

    // Edit before the five-second closure check, failing only its inline resolve.
    f.resolveFails = 1
    yield* k.tool("reminders_change", { which: "call mum", when: "in ten minutes" }, as)
    const edited = yield* theRow(k)
    const at = edited.value.dueAt!
    assert.strictEqual(f.resolveFails, 0)
    assert.deepStrictEqual(edited.value.stop?.notes, [first], "old notification cleanup remains owed")
    assert.strictEqual(edited.value.stop?.attempts, 1)
    yield* assertJob(k, edited.id, { future: true })

    if (by === "name") {
      const reply = spoken(yield* k.tool("reminders_done", { which: "call mum" }, as))
      assert.include(reply, "Done.")
      assert.notInclude(reply, "already done")
    } else {
      yield* k.advance(at - (yield* k.now) + 1_000)
      const [fresh] = yield* openNotes(k)
      assert.isDefined(fresh)
      assert.strictEqual(fresh!.key, noteKey(edited.id, at))
      const reply = yield* k.notify.press(fresh!.id, "done", as)
      assert.isTrue(reply.ok)
      assert.strictEqual(reply.say, "Done.")
    }
    assert.strictEqual((yield* theRow(k)).value.state, "done")
    assert.isUndefined(edited.value.handled)
    assert.isUndefined(edited.value.stop?.cardAt, "the time-edit write clears the old answer's scope")
    yield* k.advance(at + DAY - (yield* k.now))
    assert.deepStrictEqual(yield* openNotes(k), [])
    assert.deepStrictEqual(yield* jobOf(k, edited.id), [])
  }))
})
