/**
 * The voices on this machine (docs/VOICE-PROVIDERS.md §3, §7.2): the presets of `Presets.ts`, each installed or not,
 * and a preview through a local engine.
 */
import { type PreviewAudio, synthesizeText, type Tts, TtsVoices, VoiceCatalogError, type VoiceDescription } from "@pva/core"
import { Effect, type Scope } from "effect"
import { isInstalled } from "./download.ts"
import { defaultModelDir, presets } from "./Presets.ts"

export interface SherpaVoicesOptions {
  /** Default `<repo>/models`. Read at every call (the setting may change). */
  readonly modelDir?: string | (() => string)
  /**
   * The engine a preview speaks with, for the scope of one preview. Default: a temporary engine for the preset
   * (a child process that loads the model, then stops). Serve mode passes its own (the running engine for the voice
   * the assistant speaks with, else one kept preview engine).
   */
  readonly engineFor?: (preset: string, modelDir: string) => Effect.Effect<Tts["Service"], VoiceCatalogError, Scope.Scope>
  /** Longest preview, seconds. Default 30. */
  readonly maxSeconds?: number
}

const dirOf = (options: SherpaVoicesOptions) =>
  typeof options.modelDir === "function" ? options.modelDir() : options.modelDir ?? defaultModelDir

/**
 * The presets as voice descriptions, with their install state in `modelDir`. Metadata and a few `existsSync` calls
 * per preset: nothing is loaded. The voices of a shared archive (Kokoro) are installed together.
 */
export const listVoices = (modelDir: string = defaultModelDir): ReadonlyArray<VoiceDescription> =>
  Object.values(presets).map((p) => ({
    id: p.name,
    name: p.voice.name,
    description: p.voice.description,
    language: p.voice.language,
    ...(p.voice.gender !== undefined ? { gender: p.voice.gender } : {}),
    tags: p.voice.tags,
    local: { installed: isInstalled(p.name, modelDir), sizeMb: p.sizeMb, diskMb: p.diskMb }
  }))

/** A temporary engine for `preset` (the default `engineFor`). */
export const temporaryEngine = (
  make: (options: { readonly preset: string; readonly modelDir: string }) => Effect.Effect<Tts["Service"], { readonly message: string }, Scope.Scope>
) =>
(preset: string, modelDir: string): Effect.Effect<Tts["Service"], VoiceCatalogError, Scope.Scope> =>
  make({ preset, modelDir }).pipe(
    Effect.mapError((e) => new VoiceCatalogError({ reason: "unavailable", message: `The voice could not be started: ${e.message}` }))
  )

export const makeVoicesWith = (
  options: SherpaVoicesOptions,
  defaultEngine: NonNullable<SherpaVoicesOptions["engineFor"]>
): TtsVoices["Service"] => {
  const engineFor = options.engineFor ?? defaultEngine
  const maxSeconds = options.maxSeconds ?? 30
  return TtsVoices.of({
    list: Effect.sync(() => ({ voices: listVoices(dirOf(options)), truncated: false })),
    preview: (voiceId, text): Effect.Effect<PreviewAudio, VoiceCatalogError> =>
      Effect.suspend(() => {
        const preset = Object.hasOwn(presets, voiceId) ? presets[voiceId] : undefined
        if (preset === undefined) return Effect.fail(new VoiceCatalogError({ reason: "unknown_voice", message: `There is no voice "${voiceId}" on this machine` }))
        const dir = dirOf(options)
        if (!isInstalled(preset.name, dir)) {
          return Effect.fail(
            new VoiceCatalogError({ reason: "not_installed", message: `${preset.voice.name} is not downloaded yet (${preset.sizeMb} MB): download it first` })
          )
        }
        return Effect.scoped(Effect.flatMap(engineFor(preset.name, dir), (tts) =>
          synthesizeText(tts, text, maxSeconds * tts.sampleRate).pipe(
            Effect.mapError((e) => new VoiceCatalogError({ reason: "unavailable", message: `The preview failed: ${e.message}` }))
          )))
      })
  })
}
