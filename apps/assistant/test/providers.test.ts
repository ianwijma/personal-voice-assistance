import { assert, describe, it } from "@effect/vitest"
import { Stt, SttError, Tts, TtsError } from "@pva/core"
import { makeToneTts } from "@pva/core/testing"
import * as SherpaTts from "@pva/tts-sherpa"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseWav } from "@pva/audio-file"
import { parseLiveArgs } from "../src/bench/live.ts"
import { makeBenchWavs } from "../src/bench/makeWavs.ts"
import { buildProviders, describeStartFailure } from "../src/startup.ts"
import { voiceConfigProvider } from "../src/voiceSelection.ts"

const presetFor = (env: Record<string, string>, voiceId: string) =>
  Effect.runSync(
    SherpaTts.config().pipe(
      Effect.map((o) => o.preset),
      Effect.provideService(ConfigProvider.ConfigProvider, voiceConfigProvider(ConfigProvider.fromEnvRecord(env), { provider: "sherpa", voiceId }))
    )
  )

describe("a voice's provider settings", () => {
  it("the voice's id replaces the provider's own voice setting", () => {
    assert.strictEqual(presetFor({}, "kokoro-af_heart"), "kokoro-af_heart")
    assert.strictEqual(presetFor({ TTS_SHERPA_PRESET: "nl_NL-pim-medium" }, "en_US-lessac-medium"), "en_US-lessac-medium")
  })

  it("other settings still come from the provider's settings", () => {
    const threads = Effect.runSync(
      SherpaTts.config().pipe(
        Effect.map((o) => o.threads),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          voiceConfigProvider(ConfigProvider.fromEnvRecord({ TTS_SHERPA_THREADS: "3" }), { provider: "sherpa", voiceId: "kokoro-af_heart" })
        )
      )
    )
    assert.strictEqual(threads, 3)
  })
})

describe("startup", () => {
  it.effect("a provider that fails to start (missing model) is reported with its stage, next to missing settings", () =>
    Effect.gen(function*() {
      const error = yield* buildProviders([
        { stage: "voice (ASSISTANT_VOICE)", layer: Layer.effect(Tts, new TtsError({ message: "Model file missing. Run: download" })) },
        { stage: "speech-to-text (STT_PROVIDER)", layer: Layer.effect(Stt, new SttError({ message: "Speech model file not found" })) },
        { stage: "language model (LLM_PROVIDER)", layer: Layer.effect(Tts, Effect.flatMap(Config.String("SOME_KEY"), () => Effect.die("unreachable"))) }
      ]).pipe(Effect.scoped, Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})), Effect.flip)
      assert.strictEqual(
        error.message,
        [
          "Cannot start (settings go in the environment or in .env; see .env.example):",
          "  voice (ASSISTANT_VOICE): Model file missing. Run: download",
          "  speech-to-text (STT_PROVIDER): Speech model file not found",
          "  language model (LLM_PROVIDER): SOME_KEY is not set"
        ].join("\n")
      )
      assert.strictEqual(describeStartFailure(new TtsError({ message: "x" })), "x")
    }))
})

describe("bench", () => {
  it("parses --rounds, --sessions, --stagger and --llm-per-session", () => {
    assert.deepStrictEqual(parseLiveArgs(["a", "--rounds", "3", "b"]), { rounds: 3, sessions: 1, staggerMs: 0, llmPerSession: false, paths: ["a", "b"] })
    assert.deepStrictEqual(parseLiveArgs(["a"]), { rounds: 1, sessions: 1, staggerMs: 0, llmPerSession: false, paths: ["a"] })
    assert.deepStrictEqual(parseLiveArgs(["--sessions", "3", "--stagger", "300", "a"]), { rounds: 1, sessions: 3, staggerMs: 300, llmPerSession: false, paths: ["a"] })
    assert.deepStrictEqual(parseLiveArgs(["--sessions", "2", "--llm-per-session", "a"]), { rounds: 1, sessions: 2, staggerMs: 0, llmPerSession: true, paths: ["a"] })
    assert.match(parseLiveArgs(["--sessions", "9"]) as string, /1 to 8/)
    assert.match(parseLiveArgs(["--rounds", "0"]) as string, /positive whole number/)
  })

  it.live("--make-wavs resamples the engine's audio to 16 kHz", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "pva-wavs-"))
      const [path] = yield* makeBenchWavs(dir, ["One clause."])
      const wav = parseWav(readFileSync(path!))
      assert.strictEqual(wav.sampleRate, 16_000)
      // The tone TTS makes 100 ms per clause at 22050 Hz: 1600 samples at 16 kHz (the resampler drops the last one).
      assert.approximately(wav.data.length / 2, 1600, 2)
    }).pipe(Effect.provide(makeToneTts({ sampleRate: 22_050, millisPerClause: 100 }).layer)))
})
