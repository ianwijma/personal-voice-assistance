import { applySettingsPatch, type HostResult, resolveSettings, Setting, type SettingsSpec } from "@pva/core"
import type { SettingsPatch, SettingsSection, SettingValue } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { ConfigProvider, Effect, Semaphore } from "effect"
import { defaultSystemPrompt } from "../config.ts"
import { voiceCatalog } from "../voices.ts"
import type { SettingsStore } from "./SettingsStore.ts"

/**
 * Assistant settings sections (docs/UI-AND-MODULES.md §1.7): voices, engines
 * and turn detection, built with the same `Setting` constructors as modules and
 * keyed by their existing environment variable names. Saved values reach the
 * providers through a `ConfigProvider` placed under the environment, so the
 * adapters read their settings exactly as before.
 */

interface SectionDefinition {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly spec: SettingsSpec
}

const reload = "reload" as const

const msField = (label: string, key: string, def: number, min: number, max: number, extra: { readonly description?: string; readonly advanced?: boolean } = {}) =>
  Setting.number({ label, env: key, default: def, integer: true, min, max, step: 10, unit: "ms", apply: reload, ...extra })

/** Languages offered for the models that take one (Whisper, Nemotron). */
const languageOptions = [
  { value: "auto", label: "Automatic", description: "The model works out the language itself." },
  { value: "en", label: "English" },
  { value: "nl", label: "Dutch" },
  { value: "de", label: "German" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" }
] as const

/** The recogniser presets, recommended first; ones whose files are missing say so (choosing one is refused). */
const modelOptions = () => {
  const installed = new Set(SherpaStt.installedPresets())
  const demoted = (name: SherpaStt.PresetName) => Number((SherpaStt.presets[name] as SherpaStt.Preset).demoted ?? false)
  const names = [...SherpaStt.presetNames].sort((a, b) => demoted(a) - demoted(b))
  return names.map((name) => {
    const preset = SherpaStt.presets[name]
    return {
      value: name,
      label: installed.has(name) ? preset.label : `${preset.label} (not downloaded)`,
      description: installed.has(name)
        ? preset.description
        : `${preset.description} Not downloaded: run ${SherpaStt.DOWNLOAD_COMMAND} ${name}`
    }
  })
}

/** Turn recordings for "what does the assistant hear" (heardAudio.ts); live, no reload. */
const recordingFields: SettingsSpec = {
  RECORD_HEARD_AUDIO: Setting.boolean({
    label: "Save what the assistant hears",
    description:
      "Saves the audio the server receives for each of your turns as a WAV file in the data directory (recordings/), with its level, " +
      "loudness and band, and logs them with the transcript. Use it to find out whether bad transcripts come from the audio or from the model " +
      "(see the README: `pnpm start compare-models`). Off by default; keeps the newest files only.",
    env: "RECORD_HEARD_AUDIO",
    default: false
  }),
  RECORD_HEARD_AUDIO_MAX_FILES: Setting.number({
    label: "Recordings kept",
    description: "The oldest recordings are deleted beyond this many (each turn is at most 30 s, about 1 MB).",
    env: "RECORD_HEARD_AUDIO_MAX_FILES",
    default: 50,
    integer: true,
    min: 1,
    max: 500,
    advanced: true
  })
}

/** The sections for the providers in use (`STT_PROVIDER` decides which listening settings are shown). */
const definitions = (sttProvider: string): ReadonlyArray<SectionDefinition> => {
  const voiceOptions = voiceCatalog.map((v) => ({ value: v.name, label: v.name, description: v.description }))
  const listening: SettingsSpec = sttProvider === "deepgram"
    ? {
      DEEPGRAM_EOT_THRESHOLD: Setting.number({
        label: "End-of-turn confidence",
        description: "How sure the recogniser must be that you have finished (0.5–1). Higher waits longer.",
        env: "DEEPGRAM_EOT_THRESHOLD",
        default: 0.7,
        min: 0.5,
        max: 1,
        step: 0.05,
        apply: reload
      }),
      DEEPGRAM_EAGER_EOT_THRESHOLD: Setting.number({
        label: "Early reply confidence",
        description: "Start preparing a reply at this confidence (0 turns it off).",
        env: "DEEPGRAM_EAGER_EOT_THRESHOLD",
        default: 0.5,
        min: 0,
        max: 0.9,
        step: 0.05,
        apply: reload
      }),
      ...recordingFields
    }
    : {
      STT_SHERPA_MODEL: Setting.choice({
        label: "Speech recognition model",
        description:
          "Which model turns your voice into text. Accurate models (Parakeet, Whisper) read the whole sentence once you pause, " +
          "so there are no live words; streaming models (Nemotron) show words while you talk but mishear more. " +
          "Changing it reloads the engines (a few seconds); if it fails, the previous model keeps running.",
        env: "STT_SHERPA_MODEL",
        default: SherpaStt.DEFAULT_PRESET,
        options: modelOptions(),
        apply: reload
      }),
      STT_SHERPA_LANGUAGE: Setting.choice({
        label: "Language",
        description:
          "Only for Whisper and Nemotron. Automatic works for most speech; choosing your language helps with short or unclear sentences. " +
          "Parakeet v2 is English only; Parakeet Ultra picks the language itself.",
        env: "STT_SHERPA_LANGUAGE",
        default: "auto",
        options: languageOptions,
        apply: reload
      }),
      STT_SHERPA_EAGER_SILENCE_MS: msField("Pause before an early reply", "STT_SHERPA_EAGER_SILENCE_MS", 250, 50, 2_000, {
        description:
          "After this much silence your sentence is transcribed and a reply is prepared speculatively (thrown away if you go on). " +
          "Shorter answers sooner; longer avoids work on mid-sentence pauses. With a streaming model, a pause longer than this also " +
          "splits the sentence, which costs some accuracy at the join."
      }),
      STT_SHERPA_FINAL_SILENCE_MS: msField("Pause that ends your turn", "STT_SHERPA_FINAL_SILENCE_MS", 600, 100, 3_000, {
        description:
          "After this much silence your turn is over and the reply may play. Shorter is faster but cuts in when you pause to think; " +
          "longer lets you pause but every reply starts later."
      }),
      STT_SHERPA_AGC: Setting.boolean({
        label: "Boost quiet microphones",
        description:
          "Automatic gain on the server, before speech detection: raises quiet speech by up to the maximum below so words are not missed. " +
          "It never raises steady background noise above a low level and never turns loud speech down. Turn it off to hear the microphone as it is.",
        env: "STT_SHERPA_AGC",
        default: true,
        apply: reload
      }),
      STT_SHERPA_VAD_THRESHOLD: Setting.number({
        label: "Speech detection threshold",
        description:
          `How sure the speech detector must be that a sound is speech (0–1, default ${SherpaStt.DEFAULT_VAD_THRESHOLD}). ` +
          "Lower catches quiet or distant speech but reacts to more noise and holds on a little longer after you stop; " +
          "higher ignores more noise but can miss soft words.",
        env: "STT_SHERPA_VAD_THRESHOLD",
        default: SherpaStt.DEFAULT_VAD_THRESHOLD,
        min: 0.05,
        max: 0.95,
        step: 0.05,
        apply: reload
      }),
      STT_SHERPA_AGC_MAX_GAIN_DB: Setting.number({
        label: "Maximum boost",
        description: "The most the automatic gain may raise quiet speech. 30 dB lifts a very quiet microphone to a normal level.",
        env: "STT_SHERPA_AGC_MAX_GAIN_DB",
        default: 30,
        min: 0,
        max: 40,
        step: 1,
        unit: "dB",
        advanced: true,
        apply: reload
      }),
      STT_SHERPA_MIN_SPEECH_MS: msField("Shortest speech", "STT_SHERPA_MIN_SPEECH_MS", 100, 20, 1_000, {
        advanced: true,
        description: "Continuous speech needed before it counts as you talking (and interrupts a reply). Filters clicks and coughs."
      }),
      ...recordingFields
    }
  return [
    {
      id: "conversation",
      title: "Conversation",
      spec: {
        SYSTEM_PROMPT: Setting.text({
          label: "System prompt",
          description: "Instructions for the language model. Applies from the next turn.",
          env: "SYSTEM_PROMPT",
          default: defaultSystemPrompt,
          multiline: true,
          maxLength: 4_000
        }),
        MAX_TOOL_ROUNDS: Setting.number({
          label: "Tool rounds per turn",
          env: "MAX_TOOL_ROUNDS",
          default: 5,
          integer: true,
          min: 0,
          max: 10,
          advanced: true,
          apply: reload
        })
      }
    },
    {
      id: "voices",
      title: "Voices",
      description: "The model picks a voice per reply; the default speaks everything else.",
      spec: {
        DEFAULT_VOICE: Setting.choice({
          label: "Default voice",
          description: "Applies from the next reply when the voice is enabled; otherwise after reloading the engines.",
          env: "DEFAULT_VOICE",
          default: voiceCatalog[0]!.name,
          options: voiceOptions
        }),
        VOICES: Setting.multichoice({
          label: "Enabled voices",
          description: "Each local voice is its own engine process. The default voice is always enabled.",
          env: "VOICES",
          default: [voiceCatalog[0]!.name],
          options: voiceOptions,
          apply: reload
        })
      }
    },
    { id: "listening", title: "Listening", description: "How your speech is recognised and when your turn ends.", spec: listening },
    {
      id: "language-model",
      title: "Language model",
      spec: {
        LLM_PROVIDER: Setting.choice({
          label: "Provider",
          env: "LLM_PROVIDER",
          default: "fake",
          options: [
            { value: "fake", label: "Offline stand-in", description: "Echoes what you say; answers time questions." },
            { value: "anthropic", label: "Anthropic" }
          ],
          apply: reload
        }),
        ANTHROPIC_MODEL: Setting.text({ label: "Anthropic model", env: "ANTHROPIC_MODEL", default: "claude-haiku-5-5", maxLength: 100, apply: reload }),
        ANTHROPIC_API_KEY: Setting.secret({ label: "Anthropic API key", env: "ANTHROPIC_API_KEY", apply: reload })
      }
    },
    {
      id: "speech",
      title: "Speech engines",
      spec: {
        STT_PROVIDER: Setting.choice({
          label: "Speech to text",
          env: "STT_PROVIDER",
          default: "sherpa",
          options: [{ value: "sherpa", label: "On this machine (sherpa-onnx)" }, { value: "deepgram", label: "Deepgram (hosted)" }],
          apply: reload
        }),
        TTS_PROVIDER: Setting.choice({
          label: "Text to speech (standard voice)",
          env: "TTS_PROVIDER",
          default: "sherpa",
          options: [{ value: "sherpa", label: "On this machine (Piper/Kokoro)" }, { value: "cartesia", label: "Cartesia (hosted)" }],
          apply: reload
        })
      }
    }
  ]
}

export interface Sections {
  readonly list: () => ReadonlyArray<SettingsSection>
  /** Validate and save a patch; `reload` is true when a field that needs an engine reload changed. */
  readonly update: (id: string, patch: SettingsPatch) => Effect.Effect<{ readonly result: HostResult; readonly reload: boolean }>
  /** The effective value of a field (environment > saved > default). */
  readonly value: (key: string) => SettingValue | undefined
  /** Environment first, then the saved section values and secrets: what the providers read. */
  readonly configProvider: () => ConfigProvider.ConfigProvider
  /** Called with a section after it changed. */
  readonly subscribe: (listener: (section: SettingsSection) => void) => () => void
}

/** Saved values from earlier versions: renamed recogniser presets. */
const migrate = (values: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const model = values.STT_SHERPA_MODEL
  if (typeof model !== "string" || SherpaStt.isPresetName(model)) return values
  const renamed = SherpaStt.resolvePresetName(model)
  return renamed === undefined ? values : { ...values, STT_SHERPA_MODEL: renamed }
}

/** A recogniser preset whose files are missing cannot be chosen: the field error carries the download command. */
const checkModel = (patch: SettingsPatch, env: Readonly<Record<string, string | undefined>>): ReadonlyArray<{ readonly key: string; readonly message: string }> => {
  const model = patch.values.STT_SHERPA_MODEL
  if (typeof model !== "string" || !SherpaStt.isPresetName(model)) return []
  const modelDir = env.STT_SHERPA_MODEL_DIR
  const message = SherpaStt.missingModelMessage(model, modelDir || SherpaStt.defaultModelDir, Boolean(modelDir))
  return message === undefined ? [] : [{ key: "STT_SHERPA_MODEL", message }]
}

const encode = (value: unknown): string =>
  Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : String(value)

export const makeSections = (store: SettingsStore, env: Readonly<Record<string, string | undefined>>): Sections => {
  const revisions = new Map<string, number>()
  const listeners = new Set<(section: SettingsSection) => void>()
  const sources = (id: string) => ({
    stored: migrate(store.settings().sections[id] ?? {}),
    secrets: store.secrets().sections[id] ?? {},
    env
  })
  const sttProvider = () => {
    const speech = definitions("sherpa").find((d) => d.id === "speech")!
    return String(resolveSettings(speech.spec, sources("speech")).form.values.STT_PROVIDER ?? "sherpa")
  }
  const current = () => definitions(sttProvider())
  const describe = (d: SectionDefinition): SettingsSection => ({
    id: d.id,
    title: d.title,
    ...(d.description !== undefined ? { description: d.description } : {}),
    form: resolveSettings(d.spec, sources(d.id)).form,
    revision: revisions.get(d.id) ?? 0
  })

  /**
   * Effective values by key, built on first use and dropped after every save. `value` is read for every
   * microphone frame (RECORD_HEARD_AUDIO); building the sections checks the recogniser model files on disk,
   * which belongs in forms (`list`), not in a per-frame lookup.
   */
  let effective: Map<string, SettingValue | undefined> | undefined
  const effectiveValues = () => {
    if (effective === undefined) {
      const values = new Map<string, SettingValue | undefined>()
      for (const d of current()) {
        const resolved = resolveSettings(d.spec, sources(d.id)).form.values
        for (const key of Object.keys(d.spec)) if (!values.has(key)) values.set(key, resolved[key])
      }
      effective = values
    }
    return effective
  }

  const updateLock = Semaphore.makeUnsafe(1)
  const nonEmptyEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined && value !== "") nonEmptyEnv[key] = value

  return {
    list: () => current().map(describe),
    value: (key) => effectiveValues().get(key),
    // Read, validate and save as one step: two saves of a section at once must not each start from the old values.
    update: (id, patch) =>
      updateLock.withPermit(Effect.gen(function*() {
        const d = current().find((s) => s.id === id)
        if (d === undefined) return { result: { ok: false, error: { code: "unknown_section", message: `There is no settings section "${id}"` } }, reload: false } as const
        const missingModel = id === "listening" ? checkModel(patch, env) : []
        if (missingModel.length > 0) {
          return { result: { ok: false, error: { code: "invalid_settings", message: missingModel[0]!.message, fieldErrors: missingModel } }, reload: false } as const
        }
        const patched = applySettingsPatch(d.spec, sources(id), patch)
        if (!patched.ok) {
          return { result: { ok: false, error: { code: "invalid_settings", message: "Some settings are not valid", fieldErrors: patched.errors } }, reload: false } as const
        }
        const saved = yield* Effect.result(store.saveSection(id, patched.stored, patched.secrets))
        if (saved._tag === "Failure") {
          yield* Effect.logError(saved.failure.message, saved.failure.cause)
          return { result: { ok: false, error: { code: "internal", message: `${saved.failure.message}; nothing was changed` } }, reload: false } as const
        }
        effective = undefined
        const changed = [...Object.keys(patch.values), ...Object.keys(patch.secrets)]
        const needsReload = changed.some((key) => {
          const field = d.spec[key]?.describe(key)
          return field !== undefined && field.apply === "reload"
        })
        revisions.set(id, (revisions.get(id) ?? 0) + 1)
        // A change of STT_PROVIDER changes which listening settings exist: announce both.
        const affected = id === "speech" ? ["speech", "listening"] : [id]
        for (const s of current().filter((x) => affected.includes(x.id))) {
          if (s.id !== id) revisions.set(s.id, (revisions.get(s.id) ?? 0) + 1)
          const section = describe(s)
          for (const listener of listeners) listener(section)
        }
        return { result: { ok: true }, reload: needsReload } as const
      })),
    configProvider: () => {
      const saved: Record<string, string> = {}
      const settings = store.settings().sections
      const secrets = store.secrets().sections
      for (const values of Object.values(settings)) for (const [key, value] of Object.entries(values)) saved[key] = encode(value)
      for (const values of Object.values(secrets)) for (const [key, value] of Object.entries(values)) saved[key] = value
      return ConfigProvider.orElse(ConfigProvider.fromEnvRecord(nonEmptyEnv), ConfigProvider.fromEnvRecord(saved))
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
