// `TurnSetup.llm` (docs/ASSISTANTS.md §3.2, WP-9): a single-model conversation answers each turn from the model its
// setup named at the turn's start, for every round of that turn's tool loop, even when a newer model is published
// while it runs.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { Conversation } from "../src/Conversation.ts"
import type { TurnSetup } from "../src/ConversationEvents.ts"
import { makeTool } from "../src/Module.ts"
import { Llm } from "../src/Services.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { makeScriptedLlm, testTurnTraceLayer, textDelta, toolCall } from "../src/testing.ts"

const registry = makeToolRegistry([{
  name: "t",
  tools: [makeTool({ name: "look", description: "look", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("seen") })]
}])

describe("TurnSetup.llm", () => {
  it.effect("each turn uses the model of its setup; a model published mid-turn applies from the next turn; absent = the conversation's", () => {
    const fallback = makeScriptedLlm([[textDelta("from the default")]])
    // A: round 1 asks for a tool; round 2 must still be A although B is published during the tool call.
    const a = makeScriptedLlm([[toolCall("c1", "look", {})], [textDelta("a done")]])
    const b = makeScriptedLlm([[textDelta("b answers")]])
    const llmOf = (layer: Layer.Layer<Llm>) => Effect.runSync(Effect.provide(Effect.service(Llm), layer))
    let current: Llm["Service"] | undefined = llmOf(a.layer)
    const lookThenSwitch = makeToolRegistry([{
      name: "t",
      tools: [makeTool({
        name: "look",
        description: "look",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () =>
          Effect.sync(() => {
            current = llmOf(b.layer)
            return "seen"
          })
      })]
    }])
    const setup = Effect.sync((): TurnSetup => ({ system: "sys", registry: current === undefined ? registry : lookThenSwitch, llm: current }))
    const layer = Conversation.layerWithSetup({ setup }).pipe(Layer.provideMerge(Layer.mergeAll(fallback.layer, testTurnTraceLayer)))
    return Effect.gen(function*() {
      const conversation = yield* Conversation
      const text = (s: string) => Stream.runCollect(conversation.textTurn(s)).pipe(Effect.map((parts) => parts.join("")))
      assert.strictEqual(yield* text("one"), "a done")
      assert.strictEqual(a.probe.requests.length, 2, "both rounds of the first turn went to A")
      assert.strictEqual(b.probe.requests.length, 0)
      assert.strictEqual(yield* text("two"), "b answers")
      assert.strictEqual(b.probe.requests.length, 1, "the next turn went to B")
      current = undefined
      assert.strictEqual(yield* text("three"), "from the default")
      assert.strictEqual(fallback.probe.requests.length, 1)
    }).pipe(Effect.provide(layer))
  })
})
