import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { chunkClauses } from "../src/ClauseChunker.ts"

const run = (deltas: ReadonlyArray<string>, options?: Parameters<typeof chunkClauses>[0]) =>
  Stream.fromIterable(deltas).pipe(chunkClauses(options), Stream.runCollect)

describe("chunkClauses", () => {
  it.effect("splits at sentence and clause punctuation across deltas", () =>
    Effect.gen(function*() {
      const out = yield* run(["Hel", "lo there. How", " are you? Fine; ", "thanks: good!"])
      assert.deepStrictEqual(out, ["Hello there.", "How are you?", "Fine;", "thanks:", "good!"])
    }))

  it.effect("waits for whitespace after punctuation, so decimals are not split", () =>
    Effect.gen(function*() {
      const out = yield* run(["It is 3.", "5 degrees. Nice"])
      assert.deepStrictEqual(out, ["It is 3.5 degrees.", "Nice"])
    }))

  it.effect("emits a clause as soon as the next delta shows the boundary", () =>
    Effect.gen(function*() {
      // Emissions per input element, to check nothing waits for the end of the stream.
      const out = yield* Stream.fromIterable(["Sure.", " Then", " more"]).pipe(
        chunkClauses(),
        Stream.map((clause) => clause),
        Stream.runCollect
      )
      assert.deepStrictEqual(out, ["Sure.", "Then more"])
    }))

  it.effect("splits on a comma only past the minimum length; first clause has a shorter minimum", () =>
    Effect.gen(function*() {
      const out = yield* run(
        ["Well, ", "honestly speaking, I think so, ", "and this second part is long enough, to split here, ok"],
        { firstMinLength: 12, minLength: 30 }
      )
      assert.deepStrictEqual(out, [
        "Well, honestly speaking,",
        "I think so, and this second part is long enough,",
        "to split here, ok"
      ])
    }))

  it.effect("newline forces a flush; empty clauses are dropped", () =>
    Effect.gen(function*() {
      const out = yield* run(["Let me check", "\n", "\n", "It is noon.\n", "  "])
      assert.deepStrictEqual(out, ["Let me check", "It is noon."])
    }))

  it.effect("flushes the remainder at the end", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* run(["no punctuation at all"]), ["no punctuation at all"])
      assert.deepStrictEqual(yield* run(["Ends with a period."]), ["Ends with a period."])
      assert.deepStrictEqual(yield* run([]), [])
    }))
})
