import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { makeResampler } from "../src/Resample.ts"
import { makeToneTts } from "../src/testing.ts"
import { CurrentTurnTrace, type Trace } from "../src/TurnTrace.ts"
import { isVoiceRef, parseVoiceKey, sameVoice, synthesizeText, voiceKey, withTraceVoice } from "../src/VoiceRef.ts"

describe("voice keys", () => {
  it("round-trip and split at the first colon", () => {
    const ref = { provider: "sherpa", voiceId: "en_US-lessac-medium" }
    assert.strictEqual(voiceKey(ref), "sherpa:en_US-lessac-medium")
    assert.deepStrictEqual(parseVoiceKey("sherpa:en_US-lessac-medium"), ref)
    assert.isTrue(sameVoice(parseVoiceKey(voiceKey(ref))!, ref))
  })

  it("refuse what is not well formed", () => {
    for (const bad of ["", "sherpa", ":x", "Sherpa:x", "sherpa:", "sherpa:a b", "sherpa:../x", "sherpa:a:b", `x:${"a".repeat(129)}`]) {
      assert.isUndefined(parseVoiceKey(bad), bad)
    }
    assert.isFalse(isVoiceRef({ provider: "cartesia", voiceId: "-x" }))
    assert.isTrue(isVoiceRef({ provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL" }))
  })
})

describe("withTraceVoice", () => {
  it.effect("names the voice in the turn's trace once", () =>
    Effect.gen(function*() {
      const tone = makeToneTts({ sampleRate: 16_000, chunks: 1 })
      const tts = withTraceVoice(tone.service, "sherpa:x")
      const trace = { voices: [] as Array<string> } as unknown as Trace
      yield* Stream.runDrain(tts.synthesize(Stream.make("One.", "Two."))).pipe(Effect.provideService(CurrentTurnTrace, trace))
      yield* Stream.runDrain(tts.synthesize(Stream.make("Three."))).pipe(Effect.provideService(CurrentTurnTrace, trace))
      assert.deepStrictEqual(trace.voices, ["sherpa:x"])
      assert.strictEqual(tts.sampleRate, 16_000)
    }))
})

describe("synthesizeText", () => {
  it.effect("collects the audio of every clause", () =>
    Effect.gen(function*() {
      const tone = makeToneTts({ sampleRate: 10_000, millisPerClause: 100, chunks: 2 })
      const audio = yield* synthesizeText(tone.service, "Hello there. How are you?", 100_000)
      assert.deepStrictEqual(tone.probe.clauses, ["Hello there.", "How are you?"])
      assert.strictEqual(audio.sampleRate, 10_000)
      assert.strictEqual(audio.pcm.length, 2 * 2 * 1_000)
    }))

  it.effect("stops at the sample limit", () =>
    Effect.gen(function*() {
      const tone = makeToneTts({ sampleRate: 10_000, millisPerClause: 100, chunks: 4 })
      const audio = yield* synthesizeText(tone.service, "One. Two. Three. Four.", 1_500)
      assert.strictEqual(audio.pcm.length, 3_000)
      assert.isBelow(tone.probe.clauses.length, 4)
    }))
})

describe("makeResampler", () => {
  it("doubles the samples from 24 to 48 kHz", () => {
    const resample = makeResampler(24_000, 48_000)
    const out = resample(new Uint8Array(2 * 2_400))
    assert.isTrue(Math.abs(out.length / 2 - 4_800) <= 2)
  })
})

