import * as FileAudio from "@pva/audio-file"
import * as PipeWire from "@pva/audio-pipewire"
import type { AudioInput, AudioOutput, Llm, Stt, SttError, Tts, TtsError } from "@pva/core"
import { AnthropicLlm } from "@pva/llm-anthropic"
import * as DeepgramStt from "@pva/stt-deepgram"
import * as SherpaStt from "@pva/stt-sherpa"
import * as CartesiaTts from "@pva/tts-cartesia"
import * as SherpaTts from "@pva/tts-sherpa"
import { Config, Effect, Layer, Option } from "effect"
import { resolve } from "node:path"
import { userCwd } from "./env.ts"
import { FakeLlm } from "./FakeLlm.ts"

/**
 * The single place where implementations are chosen: one map per stage, keyed
 * by the value of its environment variable. Adding a provider = one line in
 * the relevant map. Only the selected entry is ever built, so the settings
 * (API keys, ...) of providers that are not selected are never read.
 */
const llmProviders = {
  // Untimed, unless BENCH_LLM_FIRST_TOKEN_MS is set: then it stands in for a hosted model of that speed
  // (as in `bench --live`), so serve mode can be measured the same way.
  fake: Layer.unwrap(Effect.gen(function*() {
    const firstTokenMs = yield* Config.Int("BENCH_LLM_FIRST_TOKEN_MS").pipe(Config.option)
    if (Option.isNone(firstTokenMs)) return FakeLlm.layer
    const tokensPerSecond = yield* Config.Finite("BENCH_LLM_TOKENS_PER_S").pipe(Config.withDefault(60))
    return FakeLlm.layerTimed({ firstTokenMs: firstTokenMs.value, tokensPerSecond })
  })),
  anthropic: AnthropicLlm.layerConfig
}

/** `sherpa` runs on this machine (models in `models/`); `deepgram` is hosted. */
const sttProviders = {
  sherpa: SherpaStt.layerConfig,
  deepgram: DeepgramStt.layerConfig
}

/**
 * Each entry is also usable as a voice (see `voices.ts`): its settings are then
 * read with a `VOICE_<NAME>_` prefix first, so two voices can share a provider
 * with different settings. Engines declare their own sample rate; whoever
 * needs another rate resamples (`makeResampler` in core).
 */
export const ttsProviders = {
  sherpa: SherpaTts.layerConfig(),
  cartesia: CartesiaTts.layerConfig
} satisfies Record<string, Layer.Layer<Tts, TtsError | Config.ConfigError>>
export type TtsProviderName = keyof typeof ttsProviders
export const ttsProviderNames = Object.keys(ttsProviders) as Array<TtsProviderName>

const audioBackends = {
  pipewire: PipeWire.layerConfig,
  file: Layer.unwrap(Effect.gen(function*() {
    const options = yield* FileAudioConfig
    return Layer.mergeAll(
      FileAudio.layerInput({ path: options.inputFile, trailingSilenceMs: options.trailingSilenceMs, noiseFloor: true }),
      FileAudio.layerOutput({ directory: options.outputDir })
    )
  }))
}

/** Output only (for `say`): no microphone is opened and no input file is needed. */
const audioOutputBackends = {
  pipewire: Layer.unwrap(Effect.map(PipeWire.PipeWireConfig, PipeWire.layerOutput)),
  file: Layer.unwrap(Effect.suspend(() => Effect.map(OutputDirConfig, (directory) => FileAudio.layerOutput({ directory }))))
}

const OutputDirConfig = Config.String("AUDIO_OUTPUT_DIR").pipe(Config.withDefault("audio-out"), Config.map((p) => resolve(userCwd, p)))

/** Settings of the `file` audio backend (paths relative to where the command was run). */
export const FileAudioConfig = Config.all({
  inputFile: Config.String("AUDIO_INPUT_FILE").pipe(Config.map((p) => resolve(userCwd, p))),
  trailingSilenceMs: Config.Int("AUDIO_INPUT_TRAILING_SILENCE_MS").pipe(Config.withDefault(3000)),
  outputDir: OutputDirConfig
})

/** The entry of `providers` named by environment variable `name` (or `fallback` when unset). */
export const choose = <M extends Record<string, unknown>>(name: string, providers: M, fallback: keyof M & string) =>
  Config.Literals(Object.keys(providers) as Array<keyof M & string>, name).pipe(
    Config.withDefault(fallback),
    Config.map((key) => providers[key]!)
  )

/** `LLM_PROVIDER`: `fake` (default, offline) | `anthropic`. */
export const LlmLayer: Layer.Layer<Llm, Config.ConfigError> = Layer.unwrap(choose("LLM_PROVIDER", llmProviders, "fake"))

/** `STT_PROVIDER`: `sherpa` (default, local) | `deepgram`. A local model is loaded when the layer is built. */
export const SttLayer: Layer.Layer<Stt, SttError | Config.ConfigError> = Layer.unwrap(choose("STT_PROVIDER", sttProviders, "sherpa"))

/** Default of `TTS_PROVIDER` (the engine of voices that do not name one). */
export const defaultTtsProvider: TtsProviderName = "sherpa"

/** `TTS_PROVIDER`: `sherpa` (default, local) | `cartesia`. The engine starts / the connection opens when the layer is built. */
export const TtsLayer: Layer.Layer<Tts, TtsError | Config.ConfigError> = Layer.unwrap(
  choose("TTS_PROVIDER", ttsProviders, defaultTtsProvider)
)

/** `AUDIO_BACKEND`: `pipewire` (default) | `file`. */
export const AudioLayer: Layer.Layer<AudioInput | AudioOutput, Config.ConfigError> = Layer.unwrap(
  choose("AUDIO_BACKEND", audioBackends, "pipewire")
)

/** `AUDIO_BACKEND`, speaker only. */
export const AudioOutputLayer: Layer.Layer<AudioOutput, Config.ConfigError> = Layer.unwrap(
  choose("AUDIO_BACKEND", audioOutputBackends, "pipewire")
)
