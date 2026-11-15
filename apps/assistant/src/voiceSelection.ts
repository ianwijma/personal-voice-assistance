import { parseVoiceKey, Tts, TtsError, type VoiceRef, voiceKey, withTraceVoice } from "@pva/core"
import * as SherpaTts from "@pva/tts-sherpa"
import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { isTtsProvider, ttsProviderInfo, ttsProviders } from "./providers.ts"
import { StartupError } from "./startup.ts"

/**
 * Which voice is used (docs/VOICE-PROVIDERS.md §6.2, §7.1). A voice is a `VoiceRef` (core); this file answers
 * "which voice does X use" and builds a `Tts` for a voice. Today there is one X, the assistant
 * (`ASSISTANT_VOICE`); a per-agent voice later is one more resolver here, with nothing changed in the providers.
 */

/** The assistant's voice: a voice key (`provider:voiceId`). */
export const ASSISTANT_VOICE = "ASSISTANT_VOICE"

export const DEFAULT_ASSISTANT_VOICE: VoiceRef = { provider: "sherpa", voiceId: SherpaTts.DEFAULT_PRESET }

export interface ResolvedVoice {
  readonly ref: VoiceRef
  /** `setting`: `ASSISTANT_VOICE`; `migrated`: from the settings before voice providers; `default`: nothing was set. */
  readonly source: "setting" | "migrated" | "default"
  /** What the migration did or ignored, for the owner (logged; shown by the API). */
  readonly notes: ReadonlyArray<string>
}

/** The voices of the old design, as they chose a provider and a voice (`voices.ts` until 2026-11-16). */
const legacyVoices: Readonly<Record<string, { readonly provider?: string; readonly preset?: string }>> = {
  standard: {},
  natural: { provider: "sherpa", preset: "kokoro-af_heart" },
  expressive: { provider: "cartesia" }
}

/** Per-voice provider settings of the old design that are no longer read (reported in a note when set). */
const legacyOverrides = [
  "TTS_SHERPA_SPEED",
  "TTS_SHERPA_THREADS",
  "TTS_SHERPA_MODEL_DIR",
  "CARTESIA_MODEL",
  "CARTESIA_LANGUAGE",
  "CARTESIA_API_KEY",
  "CARTESIA_URL",
  "ELEVENLABS_MODEL",
  "ELEVENLABS_LANGUAGE",
  "ELEVENLABS_SPEED",
  "ELEVENLABS_STABILITY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_URL"
] as const

const voiceIdSetting = { sherpa: "TTS_SHERPA_PRESET", cartesia: "CARTESIA_VOICE", elevenlabs: "ELEVENLABS_VOICE" } as const

const envName = (name: string) => `VOICE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`

/** Every setting `resolveAssistantVoice` may read. */
export const voiceSelectionKeys: ReadonlyArray<string> = [
  ASSISTANT_VOICE,
  "DEFAULT_VOICE",
  "VOICES",
  "TTS_PROVIDER",
  ...Object.values(voiceIdSetting),
  ...Object.keys(legacyVoices).flatMap((name) => [
    `${envName(name)}_PROVIDER`,
    ...Object.values(voiceIdSetting).map((k) => `${envName(name)}_${k}`),
    ...legacyOverrides.map((k) => `${envName(name)}_${k}`)
  ])
]

/**
 * The assistant's voice from the effective settings (`get` returns a set, non-empty value or undefined).
 * `ASSISTANT_VOICE` wins; otherwise the old settings are migrated (§6.2). Fails (a message) only for an
 * `ASSISTANT_VOICE` that is not a voice key of a known provider.
 */
export const resolveAssistantVoice = (get: (key: string) => string | undefined): ResolvedVoice | { readonly problem: string } => {
  const value = (key: string) => {
    const v = get(key)?.trim()
    return v === undefined || v === "" ? undefined : v
  }
  const chosen = value(ASSISTANT_VOICE)
  if (chosen !== undefined) {
    const ref = parseVoiceKey(chosen)
    if (ref === undefined) return { problem: `ASSISTANT_VOICE "${chosen.slice(0, 80)}" is not a voice (expected provider:voice, e.g. ${voiceKey(DEFAULT_ASSISTANT_VOICE)})` }
    if (!isTtsProvider(ref.provider)) return { problem: `ASSISTANT_VOICE names an unknown voice provider "${ref.provider}"` }
    return { ref, source: "setting", notes: [] }
  }

  const notes: Array<string> = []
  const keys = ["DEFAULT_VOICE", "VOICES", "TTS_PROVIDER", ...Object.values(voiceIdSetting)]
  const legacySet = keys.some((k) => value(k) !== undefined) ||
    voiceSelectionKeys.some((k) => k.startsWith("VOICE_") && value(k) !== undefined)
  if (!legacySet) return { ref: DEFAULT_ASSISTANT_VOICE, source: "default", notes }

  let name = value("DEFAULT_VOICE")?.toLowerCase() ?? "standard"
  const asKey = parseVoiceKey(name)
  if (asKey !== undefined && isTtsProvider(asKey.provider)) {
    // A voice key in DEFAULT_VOICE (written by hand after reading the new docs): taken as meant.
    return { ref: { provider: asKey.provider, voiceId: value("DEFAULT_VOICE")!.slice(asKey.provider.length + 1) }, source: "migrated", notes }
  }
  if (!Object.hasOwn(legacyVoices, name)) {
    notes.push(`DEFAULT_VOICE "${name.slice(0, 40)}" was not a voice; the standard voice's settings were used.`)
    name = "standard"
  }
  const declared = legacyVoices[name]!
  const prefix = envName(name)
  const providerSetting = value(`${prefix}_PROVIDER`) ?? declared.provider ?? value("TTS_PROVIDER") ?? "sherpa"
  const provider = isTtsProvider(providerSetting) ? providerSetting : "sherpa"
  if (provider !== providerSetting) {
    notes.push(`The voice provider "${providerSetting.slice(0, 40)}" does not exist; the voice on this machine was used.`)
  }
  const idSetting = voiceIdSetting[provider]
  const voiceId = value(`${prefix}_${idSetting}`) ??
    (provider === "sherpa" ? declared.preset : undefined) ??
    value(idSetting) ??
    ttsProviderInfo[provider].defaultVoice

  const enabled = (value("VOICES") ?? "").split(/[\s,]+/).map((n) => n.toLowerCase()).filter((n) => n.length > 0 && n !== name)
  if (enabled.length > 0) notes.push(`VOICES is no longer used: ${enabled.join(", ")} ${enabled.length === 1 ? "is" : "are"} not spoken with any more.`)
  const ignored = Object.keys(legacyVoices).flatMap((n) => legacyOverrides.map((k) => `${envName(n)}_${k}`)).filter((k) => value(k) !== undefined)
  if (ignored.length > 0) notes.push(`No longer read (the provider-wide settings apply): ${ignored.join(", ")}.`)
  notes.push(`The voice was taken from the earlier voice settings (the ${name} voice). Choose a voice in Settings → Voices to replace them.`)
  return { ref: { provider, voiceId }, source: "migrated", notes }
}

/** `resolveAssistantVoice` over the current `ConfigProvider`. */
export const assistantVoice: Effect.Effect<ResolvedVoice | { readonly problem: string }> = Effect.gen(function*() {
  const values = new Map<string, string>()
  for (const key of voiceSelectionKeys) {
    const config = Config.option(Config.String(key))
    const v = yield* Effect.orElseSucceed(Effect.gen(function*() {
      return yield* config
    }), () => Option.none<string>())
    if (Option.isSome(v)) values.set(key, v.value)
  }
  return resolveAssistantVoice((key) => values.get(key))
})

/** `base` with the voice's provider setting (`TTS_SHERPA_PRESET`, `CARTESIA_VOICE`, …) set to the voice's id. */
export const voiceConfigProvider = (base: ConfigProvider.ConfigProvider, ref: VoiceRef): ConfigProvider.ConfigProvider =>
  isTtsProvider(ref.provider)
    ? ConfigProvider.orElse(ConfigProvider.fromEnvRecord({ [ttsProviderInfo[ref.provider].voiceSetting]: ref.voiceId }), base)
    : base

/**
 * The `Tts` of one voice: its provider's layer, reading the provider's settings as usual, except that the
 * provider's voice setting is the voice's id.
 */
export const ttsLayerFor = (ref: VoiceRef): Layer.Layer<Tts, TtsError | Config.ConfigError> => {
  if (!isTtsProvider(ref.provider)) {
    return Layer.effect(Tts, Effect.fail(new TtsError({ message: `There is no voice provider "${ref.provider}"` })))
  }
  const overlay = ConfigProvider.layer(Effect.map(Effect.service(ConfigProvider.ConfigProvider), (base) => voiceConfigProvider(base, ref)))
  return ttsProviders[ref.provider].pipe(Layer.provide(overlay))
}

/** A short name for a voice when no list is at hand: the preset's voice name on this machine, else its id. */
export const voiceLabel = (ref: VoiceRef): string => {
  if (ref.provider === "sherpa") {
    const preset = Object.hasOwn(SherpaTts.presets, ref.voiceId) ? SherpaTts.presets[ref.voiceId] : undefined
    if (preset !== undefined) return preset.voice.name
  }
  return ref.voiceId
}

/** "Piper en_US-lessac-medium", "ElevenLabs EXAVITQu4vr4xnSDxMaL" (the engine list). */
export const voiceEngineName = (ref: VoiceRef): string => {
  if (ref.provider === "sherpa") {
    const preset = Object.hasOwn(SherpaTts.presets, ref.voiceId) ? SherpaTts.presets[ref.voiceId] : undefined
    return `${preset === undefined ? "Local" : preset.engine === "kokoro" ? "Kokoro" : "Piper"} ${ref.voiceId}`
  }
  return `${isTtsProvider(ref.provider) ? ttsProviderInfo[ref.provider].label : ref.provider} ${ref.voiceId}`
}

/** The startup stage of the assistant's voice (its problems are reported with the other settings). */
export const voiceStageName = "voice (ASSISTANT_VOICE)"

/**
 * For the CLI modes: the assistant's voice as a startup stage (an `ASSISTANT_VOICE` that is not a voice is a
 * `StartupError`); the migration notes are logged once.
 */
export const assistantVoiceStage = Effect.gen(function*() {
  const resolved = yield* assistantVoice
  if ("problem" in resolved) return yield* new StartupError({ message: resolved.problem })
  for (const note of resolved.notes) yield* Effect.logWarning(note)
  return { ref: resolved.ref, stage: { stage: voiceStageName, layer: ttsLayerFor(resolved.ref) } }
})

/** `context` with its `Tts` tagged with the voice's key in every turn's trace. */
export const withVoiceTrace = (context: Context.Context<any>, ref: VoiceRef): Context.Context<any> =>
  Context.add(context, Tts, withTraceVoice(Context.get(context as Context.Context<Tts>, Tts), voiceKey(ref)))
