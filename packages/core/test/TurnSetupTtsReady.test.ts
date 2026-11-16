// `TurnSetup.ttsReady` (docs/ASSISTANTS.md §3.2, WP-10): a voice still being built is waited for inside the spoken
// turn, just before it plays (its sample rate is final then), never while the setup is read: Stop interrupts the wait,
// a typed reply that is not spoken never waits, and a turn waiting plays at the final rate once the voice is ready.
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Conversation } from "../src/Conversation.ts"
import type { ConversationEvent, ConversationInput, TurnSetup } from "../src/ConversationEvents.ts"
import type { Tts } from "../src/Services.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { type Sleep, sleep, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, scripted, testTurnTraceLayer, textDelta } from "../src/testing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

describe("TurnSetup.ttsReady", () => {
  it.effect("a spoken turn waits for its voice before it plays, and Stop interrupts the wait; an unspoken typed turn does not wait", () => {
    const llm = makeScriptedLlm([[textDelta("one.")], [textDelta("two.")], [textDelta("three.")]])
    const loop = makeMarkerTts({ label: "loop", sampleRate: 16_000 })
    const piper = makeMarkerTts({ label: "piper", sampleRate: 22_050 })
    const out = makeRecordingAudioOutput({ chunkMillis: 10 })
    // A voice being built: its rate is not known until it is ready.
    let built = false
    const gate = Deferred.makeUnsafe<void>()
    const starting: Tts["Service"] = {
      get sampleRate() {
        return built ? 22_050 : 0
      },
      synthesize: piper.service.synthesize
    }
    const setup = Effect.sync((): TurnSetup => ({ system: "sys", registry: makeToolRegistry([]), tts: starting, ttsReady: Deferred.await(gate) }))
    const events: Array<ConversationEvent> = []
    const conversation = Conversation.layerWithSetup({ setup, onEvent: (event) => events.push(event) }).pipe(
      Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer))
    )
    const layer = Layer.mergeAll(conversation, loop.layer, out.layer)
    const outcomes = () => events.flatMap((e) => (e._tag === "TurnEnded" ? [e.outcome] : []))
    return Effect.gen(function*() {
      const c = yield* Conversation
      const steps: Array<ConversationInput | Sleep> = [
        { _tag: "TextInput", text: "first", speak: true },
        sleep(200),
        { _tag: "Interrupt" },
        sleep(100),
        { _tag: "TextInput", text: "typed", speak: false },
        sleep(500),
        { _tag: "TextInput", text: "third", speak: true },
        sleep(10_000)
      ]
      const fiber = yield* Effect.forkChild(c.voice(scripted(steps)))

      // The first turn waits for the voice: nothing plays.
      yield* advance(150)
      assert.deepStrictEqual(out.probe.sampleRates, [])
      assert.deepStrictEqual(outcomes(), [])

      // Stop ends it while the voice is still being built; the typed reply that is not spoken completes meanwhile.
      yield* advance(200)
      yield* advance(10)
      assert.deepStrictEqual(outcomes(), ["interrupted", "completed"])
      assert.deepStrictEqual(out.probe.sampleRates, [])

      // The third turn waits too, then plays at the voice's final rate once it is ready.
      yield* advance(500)
      yield* advance(10)
      assert.deepStrictEqual(out.probe.sampleRates, [])
      built = true
      yield* Deferred.succeed(gate, undefined)
      yield* advance(500)
      assert.deepStrictEqual(out.probe.chunks.map((x) => x.text), ["<piper:three.>"])
      assert.deepStrictEqual(out.probe.sampleRates, [22_050])
      assert.deepStrictEqual(outcomes(), ["interrupted", "completed", "completed"])
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(layer))
  })
})
