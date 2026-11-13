import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { formatTrace, makeTurnTrace } from "../src/TurnTrace.ts"

describe("TurnTrace", () => {
  it.effect("records first marks only, formats deltas from endOfTurn and keeps the last N", () =>
    Effect.gen(function*() {
      let t = 1000
      const tt = makeTurnTrace({ keep: 2, now: () => t })
      const trace = tt.begin("voice", true)
      t = 1010
      tt.mark(trace, "llmRequestSent")
      t = 1100
      tt.mark(trace, "endOfTurn")
      t = 1300
      tt.mark(trace, "llmFirstToken")
      t = 1400
      tt.mark(trace, "llmFirstToken")
      trace.tools.push({ name: "clock", ms: 2 })
      t = 1500
      tt.mark(trace, "playbackStart")
      yield* tt.finish(trace, "completed")

      assert.strictEqual(trace.marks.llmFirstToken, 1300)
      assert.strictEqual(
        formatTrace(trace),
        "turn #1 voice (speculative) completed llmRequestSent=-90ms llmFirstToken=200ms (+290ms) playbackStart=400ms (+200ms) tools: clock 2ms total=400ms"
      )

      for (let i = 0; i < 3; i++) yield* tt.finish(tt.begin("text"), "completed")
      const recent = yield* tt.recent
      assert.deepStrictEqual(recent.map((r) => r.id), [3, 4])
    }))
})
