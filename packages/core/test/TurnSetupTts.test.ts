// `TurnSetup.tts` (docs/ASSISTANTS.md §3.2, WP-10): a spoken turn is synthesised with the voice its setup named at
// the turn's start (every clause of every round) and played at that voice's rate; a voice published mid-turn applies
// from the next turn; a `Say` uses the setup's voice; absent = the voice loop's.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Conversation } from "../src/Conversation.ts"
import type { ConversationInput, TurnSetup } from "../src/ConversationEvents.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { type Sleep, sleep, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, scripted, testTurnTraceLayer, textDelta } from "../src/testing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

describe("TurnSetup.tts", () => {
  it.effect("each turn is spoken with the voice of its setup, at its rate; a voice published mid-turn applies from the next turn; a Say uses the setup's voice; absent = the loop's", () => {
    const llm = makeScriptedLlm([[textDelta("one.")], [textDelta("two.")], [textDelta("three.")]])
    const loop = makeMarkerTts({ label: "loop", sampleRate: 16_000 })
    const piper = makeMarkerTts({ label: "piper", sampleRate: 22_050 })
    const kokoro = makeMarkerTts({ label: "kokoro", sampleRate: 24_000 })
    const out = makeRecordingAudioOutput({ chunkMillis: 10 })
    let current: ReturnType<typeof makeMarkerTts>["service"] | undefined = piper.service
    const setup = Effect.sync((): TurnSetup => ({ system: "sys", registry: makeToolRegistry([]), tts: current }))
    const conversation = Conversation.layerWithSetup({ setup }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer)))
    const layer = Layer.mergeAll(conversation, loop.layer, out.layer)
    const text = (t: string): ConversationInput => ({ _tag: "TextInput", text: t, speak: true })
    return Effect.gen(function*() {
      const c = yield* Conversation
      const steps: Array<ConversationInput | Sleep> = [text("first")]
      const fiber = yield* Effect.forkChild(c.voice(scripted(steps)))
      yield* advance(500)
      assert.deepStrictEqual(out.probe.chunks.map((x) => x.text), ["<piper:one.>"])
      assert.deepStrictEqual(out.probe.sampleRates, [22_050])
      yield* Fiber.interrupt(fiber)

      // The voice changes: the next turn (a new voice loop run reads it from its setup) speaks with it.
      current = kokoro.service
      const second = yield* Effect.forkChild(c.voice(scripted([text("second"), sleep(300), { _tag: "Say", text: "Said aloud." } as const])))
      yield* advance(500)
      assert.deepStrictEqual(out.probe.chunks.map((x) => x.text), ["<piper:one.>", "<kokoro:two.>", "<kokoro:Said aloud.>"])
      assert.deepStrictEqual(out.probe.sampleRates, [22_050, 24_000, 24_000])
      yield* Fiber.interrupt(second)

      // No voice in the setup: the loop's.
      current = undefined
      const third = yield* Effect.forkChild(c.voice(scripted([text("third")])))
      yield* advance(500)
      assert.deepStrictEqual(out.probe.chunks.map((x) => x.text).at(-1), "<loop:three.>")
      assert.strictEqual(out.probe.sampleRates.at(-1), 16_000)
      yield* Fiber.interrupt(third)
    }).pipe(Effect.provide(layer))
  })
})
