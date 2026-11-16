// `TurnSetup.maxToolRounds`: a turn runs with the tool-round limit its setup named at the turn's start (serve mode: the
// assistant's `toolRounds`, read with the rest of the setup that the turn's configuration snapshot also comes from), so
// a changed limit applies from the next turn of the same conversation. Absent: the conversation's `maxToolRounds`.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { Conversation } from "../src/Conversation.ts"
import type { TurnSetup } from "../src/ConversationEvents.ts"
import { makeTool } from "../src/Module.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { makeScriptedLlm, testTurnTraceLayer, toolCall } from "../src/testing.ts"

describe("TurnSetup.maxToolRounds", () => {
  it.effect("each turn uses the limit of its setup; a changed limit applies from the next turn; absent = the conversation's", () => {
    // The model asks for the tool on every call, so a turn makes exactly its limit + 1 model calls.
    const llm = makeScriptedLlm((_, index) => [toolCall(`c${index}`, "look", {})])
    const registry = makeToolRegistry([{
      name: "t",
      tools: [makeTool({ name: "look", description: "look", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("seen") })]
    }])
    let rounds: number | undefined = 3
    const setup = Effect.sync((): TurnSetup => ({ system: "sys", registry, ...(rounds !== undefined ? { maxToolRounds: rounds } : {}) }))
    const layer = Conversation.layerWithSetup({ setup, maxToolRounds: 1 }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer)))
    return Effect.gen(function*() {
      const conversation = yield* Conversation
      const turn = (s: string) => Stream.runDrain(conversation.textTurn(s))
      yield* turn("one")
      assert.strictEqual(llm.probe.requests.length, 4, "three tool rounds and one more model call")
      rounds = 0
      yield* turn("two")
      assert.strictEqual(llm.probe.requests.length, 5, "the next turn of the same conversation: no tool round")
      rounds = undefined
      yield* turn("three")
      assert.strictEqual(llm.probe.requests.length, 7, "no limit in the setup: the conversation's one round")
    }).pipe(Effect.provide(layer))
  })
})
