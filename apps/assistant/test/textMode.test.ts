import { assert, it } from "@effect/vitest"
import { Conversation, makeToolRegistry, readOnlyPersistence, ToolRegistry, TurnTrace } from "@pva/core"
import { makeScriptedLlm, textDelta } from "@pva/core/testing"
import { Effect, Layer, Stream } from "effect"
import { FakeLlm } from "../src/FakeLlm.ts"
import { startCliModules } from "../src/modules.ts"
import { runTextTurns } from "../src/text.ts"

// The module catalog through the host, with nothing saved (the test never reads data/).
const Modules = Layer.effect(ToolRegistry, Effect.map(startCliModules({ persistence: readOnlyPersistence() }), (s) => s.registry))

it.live("text turn: fake LLM → clock tool → spoken-style answer", () =>
  Effect.gen(function*() {
    const conversation = yield* Conversation
    const reply = (yield* Stream.runCollect(conversation.textTurn("what time is it"))).join("")
    assert.match(reply, /^It is \d{2}:\d{2} on .+ in .+\.$/)
    const echo = (yield* Stream.runCollect(conversation.textTurn("hello"))).join("")
    assert.strictEqual(echo, "You said: hello")
    assert.strictEqual((yield* conversation.history).length, 6)
  }).pipe(Effect.provide(
    Conversation.layer({ systemPrompt: "test" }).pipe(
      Layer.provide(Layer.mergeAll(FakeLlm.layer, Modules, TurnTrace.layer()))
    )
  )))

it.live("text mode prints the reply as the model wrote it, a newline after each turn", () => {
  const llm = makeScriptedLlm([[textDelta("Jingle bells, "), textDelta("jingle all the way!")], [textDelta("Plain [answer].")]])
  return Effect.gen(function*() {
    const written: Array<string> = []
    yield* runTextTurns(Stream.make("sing", "and now?"), (text) => written.push(text))
    assert.strictEqual(written.join(""), "Jingle bells, jingle all the way!\nPlain [answer].\n")
  }).pipe(Effect.provide(
    Conversation.layer({ systemPrompt: "test" }).pipe(
      Layer.provide(Layer.mergeAll(llm.layer, Layer.succeed(ToolRegistry, makeToolRegistry([])), TurnTrace.layer()))
    )
  ))
})

it.live("the fake LLM can simulate a hosted model's time to first token and token rate", () =>
  Effect.gen(function*() {
    const llm = FakeLlm.make({ firstTokenMs: 120, tokensPerSecond: 100 })
    const start = performance.now()
    const times: Array<number> = []
    yield* llm.stream({ system: "", messages: [{ role: "user", content: "one two three" }], tools: [] }).pipe(
      Stream.runForEach(() => Effect.sync(() => times.push(performance.now() - start)))
    )
    // "You said: one two three" = 5 words, then Done.
    assert.strictEqual(times.length, 6)
    assert.isAtLeast(times[0]!, 115)
    assert.isBelow(times[0]!, 200)
    assert.isAtLeast(times[4]! - times[0]!, 4 * 10 - 5)
  }))
