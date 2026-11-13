import { assert, it } from "@effect/vitest"
import { Conversation, ToolRegistry, TurnTrace } from "@pva/core"
import { makeScriptedLlm, textDelta } from "@pva/core/testing"
import { Effect, Layer, Stream } from "effect"
import { FakeLlm } from "../src/FakeLlm.ts"
import { modules } from "../src/modules.ts"
import { runTextTurns } from "../src/text.ts"

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
      Layer.provide(Layer.mergeAll(FakeLlm.layer, ToolRegistry.layer(modules), TurnTrace.layer()))
    )
  )))

it.live("text mode never prints voice markers, even split across deltas; history keeps them", () => {
  const llm = makeScriptedLlm([
    [textDelta("[voi"), textDelta("ce:expressive] Jingle bells, "), textDelta("jingle all the way! [voice:standard]"), textDelta(" Anything else?")],
    [textDelta("Plain [answer].")]
  ])
  return Effect.gen(function*() {
    const written: Array<string> = []
    yield* runTextTurns(Stream.make("sing", "and now?"), (text) => written.push(text))
    assert.strictEqual(written.join(""), "Jingle bells, jingle all the way! Anything else?\nPlain [answer].\n")
    const history = yield* Effect.flatMap(Effect.service(Conversation), (c) => c.history)
    assert.deepStrictEqual(history[1], {
      role: "assistant",
      content: "[voice:expressive] Jingle bells, jingle all the way! [voice:standard] Anything else?"
    })
  }).pipe(Effect.provide(
    Conversation.layer({ systemPrompt: "test" }).pipe(
      Layer.provide(Layer.mergeAll(llm.layer, ToolRegistry.layer(modules), TurnTrace.layer()))
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
