import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { formatSayReport, parseSayArgs } from "../src/say.ts"
import { assistantVoice, resolveAssistantVoice } from "../src/voiceSelection.ts"

/** The resolved voice key for these settings (or the problem). */
const resolve = (env: Record<string, string>) => {
  const r = resolveAssistantVoice((key) => env[key])
  return "problem" in r ? r.problem : `${r.source} ${r.ref.provider}:${r.ref.voiceId}`
}
const notes = (env: Record<string, string>) => {
  const r = resolveAssistantVoice((key) => env[key])
  return "problem" in r ? [] : r.notes
}

describe("the assistant's voice (docs/VOICE-PROVIDERS.md §6.2)", () => {
  it("nothing set: the voice on this machine", () => {
    assert.strictEqual(resolve({}), "default sherpa:en_US-lessac-medium")
    assert.deepStrictEqual(notes({}), [])
  })

  it("ASSISTANT_VOICE wins over every old setting", () => {
    assert.strictEqual(
      resolve({ ASSISTANT_VOICE: "elevenlabs:EXAVITQu4vr4xnSDxMaL", DEFAULT_VOICE: "natural", TTS_PROVIDER: "cartesia" }),
      "setting elevenlabs:EXAVITQu4vr4xnSDxMaL"
    )
  })

  it("an ASSISTANT_VOICE that is not a voice is a problem, not a silent fallback", () => {
    assert.match(resolve({ ASSISTANT_VOICE: "standard" }), /is not a voice/)
    assert.match(resolve({ ASSISTANT_VOICE: "polly:joanna" }), /unknown voice provider "polly"/)
  })

  it("old installs: TTS_PROVIDER and the provider's voice setting choose the standard voice", () => {
    assert.strictEqual(resolve({ TTS_SHERPA_PRESET: "nl_NL-pim-medium" }), "migrated sherpa:nl_NL-pim-medium")
    assert.strictEqual(resolve({ TTS_PROVIDER: "cartesia" }), "migrated cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")
    assert.strictEqual(resolve({ TTS_PROVIDER: "cartesia", CARTESIA_VOICE: "a0e99841-438c-4a64-b679-ae501e7d6091" }), "migrated cartesia:a0e99841-438c-4a64-b679-ae501e7d6091")
    assert.strictEqual(resolve({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_VOICE: "JBFqnCBsd6RMkjVDRZzb" }), "migrated elevenlabs:JBFqnCBsd6RMkjVDRZzb")
  })

  it("old installs: DEFAULT_VOICE picks the old voice with its own provider and preset", () => {
    assert.strictEqual(resolve({ DEFAULT_VOICE: "natural" }), "migrated sherpa:kokoro-af_heart")
    assert.strictEqual(resolve({ DEFAULT_VOICE: "Natural", TTS_SHERPA_PRESET: "nl_NL-pim-medium" }), "migrated sherpa:kokoro-af_heart")
    assert.strictEqual(resolve({ DEFAULT_VOICE: "expressive", TTS_PROVIDER: "sherpa" }), "migrated cartesia:db6b0ed5-d5d3-463d-ae85-518a07d3c2b4")
  })

  it("old installs: VOICE_<NAME>_ overrides of the provider and the voice are honoured", () => {
    assert.strictEqual(resolve({ DEFAULT_VOICE: "expressive", VOICE_EXPRESSIVE_PROVIDER: "elevenlabs" }), "migrated elevenlabs:EXAVITQu4vr4xnSDxMaL")
    assert.strictEqual(
      resolve({ DEFAULT_VOICE: "expressive", VOICE_EXPRESSIVE_PROVIDER: "elevenlabs", VOICE_EXPRESSIVE_ELEVENLABS_VOICE: "JBFqnCBsd6RMkjVDRZzb" }),
      "migrated elevenlabs:JBFqnCBsd6RMkjVDRZzb"
    )
    assert.strictEqual(resolve({ VOICE_STANDARD_TTS_SHERPA_PRESET: "kokoro-af_heart" }), "migrated sherpa:kokoro-af_heart")
    assert.strictEqual(resolve({ DEFAULT_VOICE: "natural", VOICE_NATURAL_TTS_SHERPA_PRESET: "en_US-lessac-medium" }), "migrated sherpa:en_US-lessac-medium")
  })

  it("old installs never fail to start: unknown names and providers fall back, with a note", () => {
    assert.strictEqual(resolve({ DEFAULT_VOICE: "opera" }), "migrated sherpa:en_US-lessac-medium")
    assert.isTrue(notes({ DEFAULT_VOICE: "opera" }).some((n) => n.includes("\"opera\" was not a voice")))
    assert.strictEqual(resolve({ TTS_PROVIDER: "polly" }), "migrated sherpa:en_US-lessac-medium")
    assert.isTrue(notes({ TTS_PROVIDER: "polly" }).some((n) => n.includes("\"polly\" does not exist")))
  })

  it("VOICES and per-voice overrides that are no longer read are named in a note", () => {
    const n = notes({ VOICES: "standard,expressive,natural", VOICE_EXPRESSIVE_CARTESIA_MODEL: "sonic-3.5" })
    assert.isTrue(n.some((x) => x.includes("VOICES is no longer used: expressive, natural are not spoken with any more")))
    assert.isTrue(n.some((x) => x.includes("VOICE_EXPRESSIVE_CARTESIA_MODEL")))
  })

  it.effect("reads the settings through the ConfigProvider (environment over saved values)", () =>
    Effect.gen(function*() {
      const r = yield* assistantVoice.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ DEFAULT_VOICE: "natural" }))
      )
      assert.isFalse("problem" in r)
      if ("problem" in r) return
      assert.deepStrictEqual(r.ref, { provider: "sherpa", voiceId: "kokoro-af_heart" })
    }))
})

describe("say", () => {
  it("parses --voice (a voice key), --out and the text", () => {
    assert.deepStrictEqual(parseSayArgs(["--voice", "sherpa:kokoro-af_heart", "Ho", "ho", "--out", "x.wav"]), {
      voice: { provider: "sherpa", voiceId: "kokoro-af_heart" },
      out: "x.wav",
      text: "Ho ho"
    })
    assert.deepStrictEqual(parseSayArgs(["hello"]), { voice: undefined, out: undefined, text: "hello" })
    assert.match(parseSayArgs([]) as string, /^Usage: say/)
    assert.match(parseSayArgs(["--voice"]) as string, /--voice needs a value/)
    assert.match(parseSayArgs(["--voice", "expressive", "hi"]) as string, /is not a voice/)
  })

  it("reports first audio, synthesis time, audio length, real-time factor", () => {
    assert.strictEqual(
      formatSayReport({ voice: "sherpa:x", clauses: 2, startedAt: 0, firstAudioAt: 80, endedAt: 300, audioSeconds: 1.5 }),
      "sherpa:x: first audio 80 ms, synthesis 300 ms, audio 1.50 s, real-time factor 0.20 (2 clauses)"
    )
    assert.strictEqual(formatSayReport({ voice: "x", clauses: 0, startedAt: 0, firstAudioAt: undefined, endedAt: 1, audioSeconds: 0 }), "no audio was produced")
  })
})
