/**
 * Local CPU text to speech with sherpa-onnx: Piper (fast default) and Kokoro
 * (higher quality). Each engine instance runs in its own child process.
 */
import { Tts, TtsError } from "@pva/core"
import { Config, Effect, Layer, Option, type Scope } from "effect"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defaultJoinOptions, type JoinOptions } from "./Pcm.ts"
import {
  DEFAULT_PRESET,
  defaultModelDir,
  downloadHint,
  engineConfig,
  type Preset,
  presetFiles,
  presets
} from "./Presets.ts"
import { makeEngineTts } from "./SherpaTts.ts"
import { makeVoicesWith, type SherpaVoicesOptions, temporaryEngine } from "./voices.ts"

export { defaultJoinOptions, type JoinOptions } from "./Pcm.ts"
export { DEFAULT_PRESET, defaultModelDir, type EngineKind, type Preset, presetFiles, presetLabel, presets, sizeMb } from "./Presets.ts"
export { listVoices, type SherpaVoicesOptions } from "./voices.ts"
export { cleanPartials, deletePreset, DownloadError, type DownloadProgress, downloadPreset, isInstalled, presetArchive } from "./download.ts"

export interface SherpaTtsOptions {
  /** Name of an entry of `presets`. Default `en_US-lessac-medium`. */
  readonly preset?: string
  /** Where model archives are unpacked. Default `<repo>/models`. */
  readonly modelDir?: string
  /** ONNX runtime threads. Default: the preset's (Piper 4, Kokoro 8). */
  readonly threads?: number
  /** Speaking rate, 1 = normal. */
  readonly speed?: number
  /** Silence trimming, pauses between clauses and chunk size. */
  readonly join?: Partial<JoinOptions>
}

const hostScript = fileURLToPath(new URL("./engine-host.mjs", import.meta.url))

const resolvePreset = (name: string): Effect.Effect<Preset, TtsError> => {
  const preset = presets[name]
  return preset !== undefined
    ? Effect.succeed(preset)
    : Effect.fail(new TtsError({ message: `Unknown sherpa TTS preset "${name}". Known: ${Object.keys(presets).join(", ")}` }))
}

/** Like `make`, but also returns the engine (its child pid), for measurements. */
export const makeWithEngine = (options: SherpaTtsOptions = {}) =>
  Effect.gen(function*() {
    const preset = yield* resolvePreset(options.preset ?? DEFAULT_PRESET)
    const modelDir = options.modelDir ?? defaultModelDir
    const missing = Object.values(presetFiles(preset, modelDir)).find((file) => !existsSync(file))
    if (missing !== undefined) {
      return yield* new TtsError({
        message: `Model file for TTS preset "${preset.name}" is missing: ${missing}. ${downloadHint(preset.name)}`
      })
    }
    const { module, config } = engineConfig(preset, modelDir, options.threads ?? preset.threads)
    return yield* makeEngineTts(
      { hostScript, init: { type: "init", module, config, speaker: preset.speaker, speed: options.speed ?? 1 } },
      { ...defaultJoinOptions, ...options.join }
    )
  })

/** `Tts` service; the model is loaded now and the engine stops when the scope closes. */
export const make = (options: SherpaTtsOptions = {}): Effect.Effect<Tts["Service"], TtsError, Scope.Scope> =>
  Effect.map(makeWithEngine(options), ({ tts }) => tts)

/** `Tts` from explicit options (one per named voice if the app runs several). */
export const layer = (options: SherpaTtsOptions = {}): Layer.Layer<Tts, TtsError> => Layer.effect(Tts, make(options))

const optional = <A>(config: Config.Config<A>) => Config.option(config).pipe(Config.map(Option.getOrUndefined))
/** Drops `undefined` fields (`exactOptionalPropertyTypes`). */
const defined = <T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as any

/**
 * Options from config, every key under `prefix` (default `TTS_SHERPA_`):
 * `PRESET`, `MODEL_DIR`, `THREADS`, `SPEED`, `TRIM_SILENCE`, `CLAUSE_PAUSE_MS`,
 * `SENTENCE_PAUSE_MS`, `PAD_MS`, `CHUNK_MS`. Unset keys keep the defaults.
 */
export const config = (prefix = "TTS_SHERPA_"): Config.Config<SherpaTtsOptions> =>
  Config.all({
    preset: Config.String(`${prefix}PRESET`).pipe(Config.withDefault(DEFAULT_PRESET)),
    modelDir: optional(Config.String(`${prefix}MODEL_DIR`)),
    threads: optional(Config.Int(`${prefix}THREADS`)),
    speed: optional(Config.Finite(`${prefix}SPEED`)),
    trim: optional(Config.Boolean(`${prefix}TRIM_SILENCE`)),
    clausePauseMs: optional(Config.Int(`${prefix}CLAUSE_PAUSE_MS`)),
    sentencePauseMs: optional(Config.Int(`${prefix}SENTENCE_PAUSE_MS`)),
    padMs: optional(Config.Int(`${prefix}PAD_MS`)),
    chunkMs: optional(Config.Int(`${prefix}CHUNK_MS`))
  }).pipe(Config.map(({ preset, modelDir, threads, speed, ...join }) =>
    defined({ preset, modelDir, threads, speed, join: defined(join) })
  ))

/** `Tts` configured from `<prefix>PRESET`, `<prefix>THREADS`, ... (see `config`). */
export const layerConfig = (prefix = "TTS_SHERPA_"): Layer.Layer<Tts, TtsError | Config.ConfigError> =>
  Layer.effect(Tts, Effect.flatMap(config(prefix), make))

/**
 * The voices on this machine (`TtsVoices`, docs/VOICE-PROVIDERS.md §7.2): the presets with their install state, and
 * previews through `options.engineFor` (default: a temporary engine per preview).
 */
export const makeVoices = (options: SherpaVoicesOptions = {}) => makeVoicesWith(options, temporaryEngine(make))
