import * as FileAudio from "@pva/audio-file"
import * as PipeWire from "@pva/audio-pipewire"
import { type AudioInput, type AudioOutput, Llm, type LlmError, type Stt, type SttError, type Tts, type TtsError, type TtsVoices } from "@pva/core"
import { AnthropicLlm } from "@pva/llm-anthropic"
import { accountLayer as openAiAccountLayer } from "@pva/llm-openai-compatible"
import * as DeepgramStt from "@pva/stt-deepgram"
import * as SherpaStt from "@pva/stt-sherpa"
import * as CartesiaTts from "@pva/tts-cartesia"
import * as ElevenLabsTts from "@pva/tts-elevenlabs"
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
  anthropic: AnthropicLlm.layerConfig,
  // OpenAI-compatible accounts from the flat settings (OPENROUTER_*, HOME_MODEL_*: key, address, MODEL, MAX_TOKENS,
  // TIMEOUT_MS, WARM_UP), for the CLI modes and `bench --live` (the app's pool builds them per assistant).
  openrouter: openAiAccountLayer("openrouter"),
  "home-model": openAiAccountLayer("home-model"),
  // The language model is the claude-subscription agent module (Claude Code with the owner's login), chosen per
  // turn from the running modules; this offline stand-in answers, with a notice, while that module is not running.
  "claude-subscription": FakeLlm.layer
}

/**
 * The language-model accounts serve mode's resource pool builds instances of (docs/ASSISTANTS.md §3.2,
 * `serve/Resources.ts`): one layer per account, read from a `ConfigProvider` that carries the assistant's own `llm`
 * fields (`ANTHROPIC_MODEL`, …) over the shared settings (the account's key and address). `claude-subscription` is the
 * offline stand-in that answers while the agent module is not running (the agent itself is the module's, WP-13a).
 * `openrouter` and `home-model` are `llm-openai-compatible`'s `accountLayer` (WP-13b): the shared key and address,
 * and the assistant's `OPENROUTER_MODEL` / `HOME_MODEL_MODEL`, …; an account that is not set up fails the build.
 * An instance is returned once its warm-up has ended (`awaitWarmUp`), so it is warm when it becomes ready.
 */
export const llmAccountLayers = {
  offline: llmProviders.fake,
  anthropic: Layer.effect(Llm, Effect.flatMap(AnthropicLlm.config, (options) => AnthropicLlm.make({ ...options, awaitWarmUp: true }))),
  openrouter: openAiAccountLayer("openrouter", true),
  "home-model": openAiAccountLayer("home-model", true),
  "claude-subscription": llmProviders["claude-subscription"]
} satisfies Record<string, Layer.Layer<Llm, Config.ConfigError | LlmError>>
export type LlmAccountWithLayer = keyof typeof llmAccountLayers
export const hasLlmAccountLayer = (account: string): account is LlmAccountWithLayer => Object.hasOwn(llmAccountLayers, account)

/** `sherpa` runs on this machine (models in `models/`); `deepgram` is hosted. */
const sttProviders = {
  sherpa: SherpaStt.layerConfig,
  deepgram: DeepgramStt.layerConfig
}

/**
 * The voice providers (docs/VOICE-PROVIDERS.md): one `Tts` layer per provider, built for one voice at a time (the
 * provider's voice setting, `ttsProviderInfo[...].voiceSetting`, is set to the voice's id; `voiceSelection.ts`).
 * Engines declare their own sample rate; whoever needs another rate resamples (`makeResampler` in core).
 */
export const ttsProviders = {
  sherpa: SherpaTts.layerConfig(),
  cartesia: CartesiaTts.layerConfig,
  elevenlabs: ElevenLabsTts.layerConfig
} satisfies Record<string, Layer.Layer<Tts, TtsError | Config.ConfigError>>
export type TtsProviderName = keyof typeof ttsProviders
export const ttsProviderNames = Object.keys(ttsProviders) as Array<TtsProviderName>
export const isTtsProvider = (provider: string): provider is TtsProviderName => Object.hasOwn(ttsProviders, provider)

export interface TtsProviderInfo {
  /** For people: "On this machine", "Cartesia". */
  readonly label: string
  readonly location: "local" | "hosted"
  /** The setting that holds its key (hosted providers). */
  readonly keyEnv?: string
  /** The provider's setting that names the voice its `Tts` speaks with. */
  readonly voiceSetting: string
  /** The voice it speaks with when nothing names one. */
  readonly defaultVoice: string
  /** What choosing it means, for people. */
  readonly implication?: string
}

export const ttsProviderInfo: Readonly<Record<TtsProviderName, TtsProviderInfo>> = {
  sherpa: { label: "On this machine", location: "local", voiceSetting: "TTS_SHERPA_PRESET", defaultVoice: SherpaTts.DEFAULT_PRESET },
  cartesia: {
    label: "Cartesia",
    location: "hosted",
    keyEnv: "CARTESIA_API_KEY",
    voiceSetting: "CARTESIA_VOICE",
    defaultVoice: CartesiaTts.DEFAULT_VOICE,
    implication: "Replies are sent to Cartesia to be spoken."
  },
  elevenlabs: {
    label: "ElevenLabs",
    location: "hosted",
    keyEnv: "ELEVENLABS_API_KEY",
    voiceSetting: "ELEVENLABS_VOICE",
    defaultVoice: ElevenLabsTts.DEFAULT_VOICE,
    implication: "Replies are sent to ElevenLabs to be spoken."
  }
}

/**
 * The hosted providers' voice lists and previews (`TtsVoices`), configured from the settings (their key is
 * required). The local provider's is built by serve mode, which decides which engine a preview uses.
 */
export const hostedTtsVoices = {
  cartesia: CartesiaTts.voicesConfig,
  elevenlabs: ElevenLabsTts.voicesConfig
} satisfies Partial<Record<TtsProviderName, Effect.Effect<TtsVoices["Service"], Config.ConfigError>>>

/** The hosted voice services: their name for people, and the setting that holds their key. */
export const hostedTts = {
  cartesia: { label: "Cartesia", keyEnv: "CARTESIA_API_KEY" },
  elevenlabs: { label: "ElevenLabs", keyEnv: "ELEVENLABS_API_KEY" }
} as const satisfies Partial<Record<TtsProviderName, { readonly label: string; readonly keyEnv: string }>>
export type HostedTtsName = keyof typeof hostedTts
export const isHostedTts = (provider: string): provider is HostedTtsName => Object.hasOwn(hostedTts, provider)

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

/** `LLM_PROVIDER`: `fake` (default, offline) | `anthropic` | `openrouter` | `home-model` | `claude-subscription` (see `subscription.ts`). */
export const LlmLayer: Layer.Layer<Llm, Config.ConfigError | LlmError> = Layer.unwrap(choose("LLM_PROVIDER", llmProviders, "fake"))

/** `STT_PROVIDER`: `sherpa` (default, local) | `deepgram`. A local model is loaded when the layer is built. */
export const SttLayer: Layer.Layer<Stt, SttError | Config.ConfigError> = Layer.unwrap(choose("STT_PROVIDER", sttProviders, "sherpa"))

/** `AUDIO_BACKEND`: `pipewire` (default) | `file`. */
export const AudioLayer: Layer.Layer<AudioInput | AudioOutput, Config.ConfigError> = Layer.unwrap(
  choose("AUDIO_BACKEND", audioBackends, "pipewire")
)

/** `AUDIO_BACKEND`, speaker only. */
export const AudioOutputLayer: Layer.Layer<AudioOutput, Config.ConfigError> = Layer.unwrap(
  choose("AUDIO_BACKEND", audioOutputBackends, "pipewire")
)
