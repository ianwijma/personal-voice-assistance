import { makeVoiceRouter, Tts, voicePrompt, type VoiceSegmentStats } from "@pva/core"
import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { defaultTtsProvider, type TtsProviderName, ttsProviderNames, ttsProviders } from "./providers.ts"
import { StartupError } from "./startup.ts"

export interface VoiceDeclaration {
  readonly name: string
  /** What the voice is good for. The model reads this to choose, so write it as advice. */
  readonly description: string
  /** Entry of `ttsProviders` in `providers.ts`. Omitted: whichever `TTS_PROVIDER` selects. */
  readonly provider?: TtsProviderName
  /**
   * Provider settings this voice uses unless `VOICE_<NAME>_<KEY>` is set, e.g.
   * `{ TTS_SHERPA_PRESET: "kokoro-af_heart" }`. They take precedence over the
   * unprefixed `<KEY>` (which configures the other voices).
   */
  readonly settings?: Readonly<Record<string, string>>
}

/**
 * The voices the assistant can speak with. Adding a voice = one entry here;
 * enabling it = adding its name to `VOICES`. The first entry is the default
 * unless `DEFAULT_VOICE` says otherwise.
 *
 * A voice's provider can be swapped with `VOICE_<NAME>_PROVIDER`, and every
 * provider setting can be overridden for one voice with the `VOICE_<NAME>_`
 * prefix (e.g. `VOICE_EXPRESSIVE_CARTESIA_VOICE`); unprefixed settings
 * (including API keys) are the fallback.
 */
export const voiceCatalog: ReadonlyArray<VoiceDeclaration> = [
  // Local Piper by default (TTS_PROVIDER=sherpa, preset en_US-lessac-medium): first audio in ~30-90 ms.
  { name: "standard", description: "Everyday answers: quick and clear. Use it for almost everything." },
  // Local Kokoro: more natural, but first audio takes ~200-950 ms depending on clause length.
  {
    name: "natural",
    description: "Longer replies where a warm, natural voice matters more than a fast start: stories, poems, " +
      "explanations of several sentences.",
    provider: "sherpa",
    settings: { TTS_SHERPA_PRESET: "kokoro-af_heart" }
  },
  // Hosted Cartesia (needs CARTESIA_API_KEY).
  {
    name: "expressive",
    description: "Singing, storytelling, jokes, and replies that call for strong emotion or drama.",
    provider: "cartesia"
  }
]

export interface VoiceSettings {
  /** Enabled voices, in catalog order. */
  readonly enabled: ReadonlyArray<VoiceDeclaration>
  readonly defaultVoice: string
}

/**
 * `VOICES` (comma- or space-separated names; the default voice is always
 * enabled) and `DEFAULT_VOICE` (default: the first declared voice).
 * Returns the settings, or a message naming the problem.
 */
export const parseVoiceSettings = (
  input: { readonly voices?: string | undefined; readonly defaultVoice?: string | undefined },
  catalog: ReadonlyArray<VoiceDeclaration> = voiceCatalog
): VoiceSettings | string => {
  const declared = catalog.map((v) => v.name).join(", ")
  const defaultVoice = (input.defaultVoice ?? "").trim().toLowerCase() || catalog[0]?.name
  if (defaultVoice === undefined) return "no voices are declared in voices.ts"
  const names = new Set((input.voices ?? "").split(/[\s,]+/).filter((n) => n.length > 0).map((n) => n.toLowerCase()))
  for (const name of names) {
    if (!catalog.some((v) => v.name === name)) return `VOICES: unknown voice "${name}" (declared: ${declared})`
  }
  if (!catalog.some((v) => v.name === defaultVoice)) {
    return `DEFAULT_VOICE: unknown voice "${defaultVoice}" (declared: ${declared})`
  }
  names.add(defaultVoice)
  return { enabled: catalog.filter((v) => names.has(v.name)), defaultVoice }
}

/** Also enable `name` (for `say --voice`). */
export const enableVoice = (settings: VoiceSettings, name: string): VoiceSettings | string => {
  const extra = settings.enabled.map((v) => v.name).concat(name)
  return parseVoiceSettings({ voices: extra.join(","), defaultVoice: settings.defaultVoice })
}

export const loadVoiceSettings: Effect.Effect<VoiceSettings, StartupError | Config.ConfigError> = Effect.gen(function*() {
  const voices = yield* Config.String("VOICES").pipe(Config.withDefault(""))
  const defaultVoice = yield* Config.String("DEFAULT_VOICE").pipe(Config.withDefault(""))
  const settings = parseVoiceSettings({ voices, defaultVoice })
  if (typeof settings === "string") return yield* new StartupError({ message: settings })
  return settings
})

/** The stable system prompt plus the voice instructions (nothing is added for a single voice). */
export const withVoicePrompt = (systemPrompt: string, settings: VoiceSettings): string => {
  const block = voicePrompt(settings.enabled, settings.defaultVoice)
  return block.length === 0 ? systemPrompt : `${systemPrompt}\n\n${block}`
}

const envName = (name: string) => `VOICE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`

/** `VOICE_<NAME>_PROVIDER`, else the declared provider, else `TTS_PROVIDER` (default `sherpa`). */
const providerOf = (voice: VoiceDeclaration): Config.Config<TtsProviderName> =>
  Config.option(Config.Literals(ttsProviderNames, `${envName(voice.name)}_PROVIDER`)).pipe(
    Config.map(Option.getOrUndefined),
    Config.flatMap((chosen) =>
      chosen !== undefined || voice.provider !== undefined
        ? Config.succeed(chosen ?? voice.provider!)
        : Config.Literals(ttsProviderNames, "TTS_PROVIDER").pipe(Config.withDefault(defaultTtsProvider))
    )
  )

/**
 * Settings are looked up as `VOICE_<NAME>_<SETTING>` first, then in the voice's
 * declared `settings`, then as `<SETTING>`.
 */
export const voiceConfigProvider = (base: ConfigProvider.ConfigProvider, voice: VoiceDeclaration) => {
  const fallback = voice.settings === undefined
    ? base
    : ConfigProvider.orElse(ConfigProvider.fromEnvRecord({ ...voice.settings }), base)
  return ConfigProvider.orElse(ConfigProvider.nested(base, envName(voice.name)), fallback)
}

const prefixedSettings = (voice: VoiceDeclaration) =>
  ConfigProvider.layer(Effect.map(Effect.service(ConfigProvider.ConfigProvider), (base) => voiceConfigProvider(base, voice)))

const voiceKey = (name: string) => Context.Service<Tts["Service"]>(`@pva/assistant/Voice/${name}`)

/**
 * One startup stage per enabled voice (see `buildProviders`), so a missing key
 * is reported with the other missing settings. Only enabled voices are built.
 */
export const voiceStages = (settings: VoiceSettings) =>
  settings.enabled.map((voice) => ({
    stage: `voice "${voice.name}" (${voice.provider ?? "TTS_PROVIDER"})`,
    layer: Layer.effect(voiceKey(voice.name), Effect.service(Tts)).pipe(
      Layer.provide(Layer.unwrap(Effect.map(providerOf(voice), (provider) =>
        ttsProviders[provider].pipe(Layer.provide(prefixedSettings(voice))))))
    )
  }))

/** The `Tts` over the voices built by `voiceStages` (found in `context`). */
export const voiceRouter = (
  context: Context.Context<any>,
  settings: VoiceSettings,
  onSegment?: (stats: VoiceSegmentStats) => void
) =>
  makeVoiceRouter({
    defaultVoice: settings.defaultVoice,
    voices: settings.enabled.map((v) => ({ name: v.name, description: v.description, tts: Context.get(context, voiceKey(v.name)) })),
    ...(onSegment !== undefined ? { onSegment } : {})
  })

/** `context` with `Tts` set to the voice router. */
export const withVoiceRouter = (context: Context.Context<any>, settings: VoiceSettings): Context.Context<any> =>
  Context.add(context, Tts, voiceRouter(context, settings))
