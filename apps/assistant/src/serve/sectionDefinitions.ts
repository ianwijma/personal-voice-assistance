import { Setting, type SettingsCheck, type SettingsProblem, type SettingsSpec } from "@pva/core"
import type { Condition, OptionTag, SettingsGroup, SettingsPage } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { SUBSCRIPTION_AGENT_ID, SUBSCRIPTION_PROVIDER } from "../subscription.ts"
import { defaultSystemPrompt } from "../config.ts"
import { voiceCatalog } from "../voices.ts"

/**
 * The assistant settings as the settings screen shows them (docs/SETTINGS-UI.md
 * §2.1, §4.1): one entry per section, each placed on a page of a category by
 * the server (`group`, `page`, `order`), so the UI hard-codes nothing about
 * them. Fields are keyed by their environment variable names and stored flat
 * by key, so a field can move to another section or page without a migration.
 *
 * `visibleWhen` makes fields and pages depend on a choice (the UI evaluates it
 * against the draft, the server against the saved values); `checks` are the
 * cross-field checks run on save (an `error` refuses the save, a `warning`
 * asks "Save anyway").
 */

export interface SectionDefinition {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly group: SettingsGroup
  readonly page: SettingsPage
  readonly order: number
  /** The page is in use only while this holds (it stays reachable as "Set up …"). */
  readonly visibleWhen?: Condition
  /** Only admin pages may change it (it chooses providers). Sections with a secret are protected anyway (`access.ts`). */
  readonly protected?: boolean
  readonly spec: SettingsSpec
  readonly checks?: ReadonlyArray<SettingsCheck>
}

const reload = "reload" as const

const msField = (
  label: string,
  key: string,
  def: number,
  min: number,
  max: number,
  extra: { readonly description?: string; readonly advanced?: boolean; readonly visibleWhen?: Condition } = {}
) =>
  Setting.number({ label, env: key, default: def, integer: true, min, max, step: 10, unit: "ms", apply: reload, ...extra })

const sherpa: Condition = { key: "STT_PROVIDER", in: ["sherpa"] }
const deepgram: Condition = { key: "STT_PROVIDER", in: ["deepgram"] }
const anthropic: Condition = { key: "LLM_PROVIDER", in: ["anthropic"] }

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

/** Where the speech packages' models are (`STT_SHERPA_MODEL_DIR` / `TTS_SHERPA_MODEL_DIR`, else `<repo>/models`). */
export interface ModelDirs {
  readonly stt: string
  readonly tts: string
}

export const defaultModelDirs: ModelDirs = { stt: SherpaStt.defaultModelDir, tts: SherpaTts.defaultModelDir }

/**
 * The recogniser presets, recommended first. A preset whose files are missing is tagged `not-downloaded`; every
 * option says how to download it (`download`), so an admin page offers Download next to it.
 */
const modelOptions = (dir: string) => {
  const installed = new Set(SherpaStt.installedPresets(dir))
  const demoted = (name: SherpaStt.PresetName) => Number((SherpaStt.presets[name] as SherpaStt.Preset).demoted ?? false)
  const names = [...SherpaStt.presetNames].sort((a, b) => demoted(a) - demoted(b))
  return names.map((name) => {
    const preset = SherpaStt.presets[name] as SherpaStt.Preset
    const tags: Array<OptionTag> = ["local"]
    const size = SherpaStt.sizeMb(preset)
    if (!installed.has(name)) tags.push("not-downloaded")
    return {
      value: name,
      label: preset.label,
      description: installed.has(name) ? preset.description : `${preset.description} Not downloaded yet (${size} MB).`,
      tags,
      download: { tool: "stt-models" as const, target: name, sizeMb: size }
    }
  })
}

/** Presets for which the language setting changes anything. */
const languagePresets = SherpaStt.presetNames.filter((name) => SherpaStt.takesLanguage(SherpaStt.presets[name]))

const warn = (key: string, message: string): SettingsProblem => ({ level: "warning", key, message })
const error = (key: string, message: string): SettingsProblem => ({ level: "error", key, message })

/** The voice's engine: its declared provider, else the standard engine (`TTS_PROVIDER`). */
const engineOfVoice = (name: string, ttsProvider: unknown) => voiceCatalog.find((v) => v.name === name)?.provider ?? String(ttsProvider ?? "sherpa")

export const sectionDefinitions = (dirs: ModelDirs = defaultModelDirs): ReadonlyArray<SectionDefinition> => {
  const voiceOptions = voiceCatalog.map((v) => {
    const hosted = (v.provider ?? "sherpa") === "cartesia"
    const kokoro = v.settings?.TTS_SHERPA_PRESET?.startsWith("kokoro") === true
    const tags: Array<OptionTag> = hosted ? ["hosted", "needs-key"] : kokoro ? ["local", "slow-start"] : ["local"]
    // A voice on this machine whose declared preset is not downloaded yet can be downloaded from the option.
    const preset = hosted ? undefined : SherpaTts.presets[v.settings?.TTS_SHERPA_PRESET ?? SherpaTts.DEFAULT_PRESET]
    const download = preset === undefined ? undefined : { tool: "tts-models" as const, target: preset.name, sizeMb: SherpaTts.sizeMb(preset) }
    if (preset !== undefined && !SherpaTts.isInstalled(preset.name, dirs.tts)) tags.push("not-downloaded")
    return {
      value: v.name,
      label: v.name,
      description: v.description,
      tags,
      ...(download !== undefined ? { download } : {}),
      ...(hosted ? { implication: "Replies in this voice are sent to Cartesia to be spoken." } : {}),
      ...(kokoro ? { implication: "Its first audio takes about 0.2–0.9 s longer than the standard voice." } : {})
    }
  })

  return [
    // ---- Language model
    {
      id: "language-model",
      title: "Provider",
      group: "agents",
      page: { id: "provider", title: "Provider", description: "Who answers you." },
      order: 10,
      protected: true,
      spec: {
        LLM_PROVIDER: Setting.choice({
          label: "Language model",
          env: "LLM_PROVIDER",
          default: "fake",
          options: [
            {
              value: "fake",
              label: "Offline stand-in",
              description: "Echoes what you say and answers time questions: for trying the assistant without a model.",
              tags: ["local"],
              implication: "No language model: the replies are canned."
            },
            {
              value: "anthropic",
              label: "Claude API",
              description: "The Anthropic API with your own API key, billed per use.",
              tags: ["hosted", "needs-key"],
              implication: "What you say is sent to Anthropic."
            },
            {
              value: SUBSCRIPTION_PROVIDER,
              label: "Claude subscription",
              description: "Claude Code with your own Claude login on this machine; replies count against your plan's limits. " +
                "Behind an opt-in, because Anthropic's terms for this use are unclear. Until it runs, the offline stand-in answers.",
              tags: ["hosted", "experimental"],
              implication: "What you say is sent to Anthropic through Claude Code.",
              module: { id: SUBSCRIPTION_AGENT_ID, optIn: "optIn" }
            }
          ],
          apply: reload
        }),
        ANTHROPIC_API_KEY: Setting.secret({ label: "Anthropic API key", env: "ANTHROPIC_API_KEY", apply: reload, visibleWhen: anthropic }),
        ANTHROPIC_MODEL: Setting.text({
          label: "Model",
          description: "claude-haiku-5-5 is the fastest; claude-sonnet-5-5 and claude-opus-5-5 are slower to start speaking.",
          env: "ANTHROPIC_MODEL",
          default: "claude-haiku-5-5",
          maxLength: 100,
          apply: reload,
          visibleWhen: anthropic
        }),
        ANTHROPIC_MAX_TOKENS: Setting.number({
          label: "Longest reply",
          description: "A cap on each reply, in tokens (about ¾ of a word each).",
          env: "ANTHROPIC_MAX_TOKENS",
          default: 1024,
          integer: true,
          min: 64,
          max: 8192,
          step: 64,
          unit: "tokens",
          advanced: true,
          apply: reload,
          visibleWhen: anthropic
        }),
        ANTHROPIC_EFFORT: Setting.choice({
          label: "Effort",
          env: "ANTHROPIC_EFFORT",
          default: "low",
          options: [
            { value: "low", label: "Low", description: "Fastest first word." },
            { value: "medium", label: "Medium", tags: ["slow-start"] },
            { value: "high", label: "High", tags: ["slow-start"], implication: "Higher effort means a slower first word." }
          ],
          advanced: true,
          apply: reload,
          visibleWhen: anthropic
        }),
        ANTHROPIC_THINKING: Setting.choice({
          label: "Thinking",
          env: "ANTHROPIC_THINKING",
          default: "disabled",
          options: [
            { value: "disabled", label: "Off", description: "Answers at once (best for a voice assistant)." },
            { value: "adaptive", label: "When useful", tags: ["slow-start"], implication: "Thinking adds latency before the first word." }
          ],
          advanced: true,
          apply: reload,
          visibleWhen: anthropic
        }),
        ANTHROPIC_TIMEOUT_MS: msField("Give up after", "ANTHROPIC_TIMEOUT_MS", 5_000, 1_000, 60_000, {
          advanced: true,
          visibleWhen: anthropic,
          description: "With no reply from Anthropic for this long, the turn fails."
        }),
        ANTHROPIC_WARM_UP: Setting.boolean({
          label: "Connect at startup",
          env: "ANTHROPIC_WARM_UP",
          default: true,
          description: "Opens the connection to Anthropic when the engines start, so the first reply does not wait for it.",
          advanced: true,
          apply: reload,
          visibleWhen: anthropic
        }),
        ANTHROPIC_BASE_URL: Setting.text({
          label: "API address",
          env: "ANTHROPIC_BASE_URL",
          default: "https://api.anthropic.com",
          maxLength: 300,
          check: (v) => (/^https?:\/\/[^\s]+$/.test(v.trim()) ? undefined : "Must be an address such as https://api.anthropic.com"),
          description: "Only for a proxy or gateway in front of the Anthropic API.",
          advanced: true,
          apply: reload,
          visibleWhen: anthropic
        })
      },
      checks: [
        (v) =>
          v.value("LLM_PROVIDER") === "anthropic" && !v.secretSet("ANTHROPIC_API_KEY")
            ? [warn("ANTHROPIC_API_KEY", "The Claude API is chosen but there is no API key: replies fail until you add it here.")]
            : []
      ]
    },
    {
      id: "llm-behaviour",
      title: "Behaviour",
      group: "agents",
      page: { id: "behaviour", title: "Behaviour", description: "How the language model talks." },
      order: 20,
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

    // ---- Speech recognition
    {
      id: "stt-engine",
      title: "Engine",
      group: "speech",
      page: { id: "engine", title: "Engine", description: "How your speech is turned into text." },
      order: 10,
      protected: true,
      spec: {
        STT_PROVIDER: Setting.choice({
          label: "Speech to text",
          env: "STT_PROVIDER",
          default: "sherpa",
          options: [
            { value: "sherpa", label: "On this machine", tags: ["local"], implication: "Your voice never leaves this machine." },
            {
              value: "deepgram",
              label: "Deepgram",
              description: "Deepgram Flux over the internet: live words and fast turn ends. Its key is on the Deepgram page.",
              tags: ["hosted", "needs-key"],
              implication: "What you say is sent to Deepgram."
            }
          ],
          apply: reload
        }),
        STT_SHERPA_MODEL: Setting.choice({
          label: "Speech recognition model",
          description:
            "Accurate models (Parakeet, Whisper) read the whole sentence once you pause, so there are no live words; streaming models " +
            "(Nemotron) show words while you talk but mishear more. If the reload fails, the previous model keeps running.",
          env: "STT_SHERPA_MODEL",
          default: SherpaStt.DEFAULT_PRESET,
          options: modelOptions(dirs.stt),
          apply: reload,
          visibleWhen: sherpa
        }),
        STT_SHERPA_LANGUAGE: Setting.choice({
          label: "Language",
          description: "Automatic works for most speech; choosing your language helps with short or unclear sentences.",
          env: "STT_SHERPA_LANGUAGE",
          default: "auto",
          options: languageOptions,
          apply: reload,
          visibleWhen: { all: [sherpa, { key: "STT_SHERPA_MODEL", in: languagePresets }] }
        })
      },
      checks: [
        (v) =>
          v.value("STT_PROVIDER") === "deepgram" && !v.secretSet("DEEPGRAM_API_KEY")
            ? [warn("STT_PROVIDER", "Deepgram is chosen but there is no Deepgram key: speech recognition fails until you add it on the Deepgram page.")]
            : []
      ]
    },
    {
      id: "stt-timing",
      title: "Turn timing",
      group: "speech",
      page: { id: "turn-timing", title: "Turn timing", description: "When your turn ends and a reply may start." },
      order: 20,
      visibleWhen: sherpa,
      spec: {
        STT_SHERPA_EAGER_SILENCE_MS: msField("Pause before an early reply", "STT_SHERPA_EAGER_SILENCE_MS", 250, 50, 2_000, {
          description:
            "After this much silence your sentence is transcribed and a reply is prepared speculatively (thrown away if you go on). " +
            "Shorter answers sooner; longer avoids work on mid-sentence pauses."
        }),
        STT_SHERPA_FINAL_SILENCE_MS: msField("Pause that ends your turn", "STT_SHERPA_FINAL_SILENCE_MS", 600, 100, 3_000, {
          description:
            "After this much silence your turn is over and the reply may play. Shorter is faster but cuts in when you pause to think; " +
            "longer lets you pause but every reply starts later."
        }),
        STT_SHERPA_MIN_SPEECH_MS: msField("Shortest speech", "STT_SHERPA_MIN_SPEECH_MS", 100, 20, 1_000, {
          advanced: true,
          description: "Continuous speech needed before it counts as you talking (and interrupts a reply). Filters clicks and coughs."
        })
      },
      checks: [
        (v) => {
          const eager = Number(v.value("STT_SHERPA_EAGER_SILENCE_MS"))
          const final = Number(v.value("STT_SHERPA_FINAL_SILENCE_MS"))
          return final <= eager
            ? [error("STT_SHERPA_FINAL_SILENCE_MS", `Must be longer than the pause before an early reply (${eager} ms).`)]
            : []
        }
      ]
    },
    {
      id: "stt-mic",
      title: "Microphone processing",
      group: "speech",
      page: { id: "microphone", title: "Microphone processing", description: "What the server does to your microphone before recognising speech." },
      order: 30,
      visibleWhen: sherpa,
      spec: {
        STT_SHERPA_AGC: Setting.boolean({
          label: "Boost quiet microphones",
          description:
            "Automatic gain on the server, before speech detection: raises quiet speech by up to the maximum below so words are not missed. " +
            "It never raises steady background noise above a low level and never turns loud speech down.",
          env: "STT_SHERPA_AGC",
          default: true,
          apply: reload
        }),
        STT_SHERPA_VAD_THRESHOLD: Setting.number({
          label: "Speech detection threshold",
          description:
            `How sure the speech detector must be that a sound is speech (0–1, default ${SherpaStt.DEFAULT_VAD_THRESHOLD}). ` +
            "Lower catches quiet or distant speech but reacts to more noise; higher ignores more noise but can miss soft words.",
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
          apply: reload,
          visibleWhen: { key: "STT_SHERPA_AGC", in: [true] }
        })
      }
    },
    {
      id: "stt-deepgram",
      title: "Deepgram",
      group: "speech",
      page: { id: "deepgram", title: "Deepgram", description: "Hosted speech recognition (Deepgram Flux)." },
      order: 40,
      visibleWhen: deepgram,
      spec: {
        DEEPGRAM_API_KEY: Setting.secret({ label: "Deepgram API key", env: "DEEPGRAM_API_KEY", apply: reload }),
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
        DEEPGRAM_EOT_TIMEOUT_MS: msField("Longest silence", "DEEPGRAM_EOT_TIMEOUT_MS", 5_000, 500, 10_000, {
          advanced: true,
          description: "Your turn ends after this much silence whatever the confidence."
        })
      },
      checks: [
        (v) => {
          const eager = Number(v.value("DEEPGRAM_EAGER_EOT_THRESHOLD"))
          const final = Number(v.value("DEEPGRAM_EOT_THRESHOLD"))
          return eager > 0 && eager >= final
            ? [error("DEEPGRAM_EAGER_EOT_THRESHOLD", `Must be lower than the end-of-turn confidence (${final}), or 0.`)]
            : []
        }
      ]
    },

    // ---- Voices
    {
      id: "voices",
      title: "Voices",
      description: "The model picks a voice per reply; the default speaks everything else.",
      group: "voices",
      page: { id: "overview", title: "Voices", description: "Which voices the assistant may use." },
      order: 10,
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
      },
      checks: [
        (v) => {
          if (v.secretSet("CARTESIA_API_KEY")) return []
          const enabled = new Set([...(Array.isArray(v.value("VOICES")) ? v.value("VOICES") as ReadonlyArray<string> : []), String(v.value("DEFAULT_VOICE"))])
          const hosted = [...enabled].filter((name) => engineOfVoice(name, v.value("TTS_PROVIDER")) === "cartesia")
          return hosted.length === 0 ? [] : [
            warn("VOICES", `${hosted.join(", ")} ${hosted.length === 1 ? "speaks" : "speak"} through Cartesia, but there is no Cartesia key: add it on the Voice engines page.`)
          ]
        }
      ]
    },
    {
      id: "voice-engines",
      title: "Voice engines",
      group: "voices",
      page: { id: "engines", title: "Voice engines", description: "The engine of the standard voice, and the hosted voice service." },
      order: 20,
      protected: true,
      spec: {
        TTS_PROVIDER: Setting.choice({
          label: "Standard voice engine",
          description: "Also used by voices that do not name an engine of their own.",
          env: "TTS_PROVIDER",
          default: "sherpa",
          options: [
            { value: "sherpa", label: "On this machine (Piper/Kokoro)", tags: ["local"] },
            { value: "cartesia", label: "Cartesia", tags: ["hosted", "needs-key"], implication: "Replies are sent to Cartesia to be spoken." }
          ],
          apply: reload
        }),
        CARTESIA_API_KEY: Setting.secret({
          label: "Cartesia API key",
          description: "For Cartesia voices (the standard voice on Cartesia, or the expressive voice).",
          env: "CARTESIA_API_KEY",
          apply: reload
        })
      },
      checks: [
        (v) =>
          v.value("TTS_PROVIDER") === "cartesia" && !v.secretSet("CARTESIA_API_KEY")
            ? [warn("TTS_PROVIDER", "Cartesia is chosen but there is no Cartesia key: the standard voice fails until you add it below.")]
            : []
      ]
    },

    // ---- Diagnostics
    {
      id: "recordings",
      title: "Recordings",
      group: "diagnostics",
      page: { id: "recordings", title: "Recordings", description: "Save what the assistant hears, to find out why it mishears." },
      order: 10,
      spec: {
        RECORD_HEARD_AUDIO: Setting.boolean({
          label: "Save what the assistant hears",
          description:
            "Saves the audio the server receives for each of your turns as a WAV file in the data directory (recordings/), with its level, " +
            "loudness and band, and logs them with the transcript (see the README: `pnpm start compare-models`). Keeps the newest files only.",
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
          advanced: true,
          visibleWhen: { key: "RECORD_HEARD_AUDIO", in: [true] }
        })
      }
    }
  ]
}

/** The settings path (`<group>/<page>`) of a section, as in `EngineStatus.reloadPendingFor` and deep links. */
export const sectionPath = (d: Pick<SectionDefinition, "group" | "page">) => `${d.group}/${d.page.id}`
