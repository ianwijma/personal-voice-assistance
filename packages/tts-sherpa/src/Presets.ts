/**
 * Voice presets. Each one names the sherpa-onnx model archive it comes from, the
 * files inside it, the engine kind and its tuning. Archives are the official
 * sherpa-onnx `tts-models` releases and unpack to `<modelDir>/<archive>/`.
 */
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type EngineKind = "piper" | "kokoro"

export interface Preset {
  readonly name: string
  readonly engine: EngineKind
  /**
   * Directory the archive unpacks to, relative to the model directory. Presets with the same `dir` share one archive
   * (the Kokoro speakers): downloading any of them installs all of them (`archiveOwner`, `archiveVoices`).
   */
  readonly dir: string
  /** Download URL of the `.tar.bz2` archive. */
  readonly url: string
  /** Model files, relative to `dir`. */
  readonly files: Readonly<Record<string, string>>
  /** Speaker id inside the model (Kokoro: the `speaker2id` metadata of `model.onnx`; Piper: always 0). */
  readonly speaker: number
  /** Kokoro: the `lang` passed to the engine (ignored by sherpa-onnx 2.x, which uses the lexicon; kept for clarity). */
  readonly lang?: string
  readonly threads: number
  /** Native output rate (the engine reports it too; this is for documentation and checks). */
  readonly sampleRate: number
  readonly license: string
  /** Download size, MB (10^6 bytes, rounded up; the release's Content-Length). */
  readonly sizeMb: number
  /** Unpacked size, MB. */
  readonly diskMb: number
  /** How the voice picker shows it (docs/VOICE-PROVIDERS.md §4.1). */
  readonly voice: {
    readonly name: string
    readonly description: string
    /** BCP 47. */
    readonly language: string
    /** Absent when neither the voice's documentation nor its measured pitch says (docs/VOICE-PROVIDERS.md §3.1). */
    readonly gender?: "female" | "male" | "neutral"
    readonly tags: ReadonlyArray<string>
  }
}

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"

interface PiperOptions {
  readonly sizeMb?: number
  readonly diskMb?: number
  readonly sampleRate?: number
}

/**
 * A Piper voice from the sherpa-onnx releases, e.g. `piper("en_US-lessac-medium", "...", {...})`. Defaults: a
 * "medium" voice (68 MB download, 83 MB unpacked, 22050 Hz); "low" and "x_low" voices are 16000 Hz.
 */
const piper = (voice: string, license: string, about: Preset["voice"], options: PiperOptions = {}): Preset => ({
  name: voice,
  engine: "piper",
  dir: `vits-piper-${voice}`,
  url: `${RELEASES}/vits-piper-${voice}.tar.bz2`,
  files: { model: `${voice}.onnx`, tokens: "tokens.txt", dataDir: "espeak-ng-data" },
  speaker: 0,
  threads: 4, // measured best for the fp32 models on this machine (8 is barely faster)
  sampleRate: options.sampleRate ?? 22_050,
  license,
  sizeMb: options.sizeMb ?? 68,
  diskMb: options.diskMb ?? 83,
  voice: about
})

const lowRate = { sampleRate: 16_000 } as const
const piperVoice = (name: string, language: string, gender: "female" | "male" | undefined, description: string): Preset["voice"] => ({
  name,
  description: `Piper: ${description}`,
  language,
  ...(gender !== undefined ? { gender } : {}),
  tags: ["fast"]
})

/**
 * Kokoro v1.0 (multi-lang), one archive for every speaker. Only the English speakers are offered: sherpa-onnx 2.x (the
 * version Kokoro runs on) has no espeak fallback, so it only speaks words in its lexicons (US and GB English, and
 * Chinese, which is not offered); Spanish, French, Hindi, Italian, Japanese and Portuguese text is mostly skipped
 * ("OOV word skipped"). Speaker ids: the `speaker2id` metadata of this archive's `model.onnx`.
 */
const KOKORO_DIR = "kokoro-multi-lang-v1_0"
const KOKORO_COUNT = 28
const kokoro = (
  speaker: string,
  id: number,
  name: string,
  grade: string,
  description?: string
): Preset => {
  const british = speaker.startsWith("b")
  return {
    name: `kokoro-${speaker}`,
    engine: "kokoro",
    dir: KOKORO_DIR,
    url: `${RELEASES}/${KOKORO_DIR}.tar.bz2`,
    files: {
      model: "model.onnx",
      voices: "voices.bin",
      tokens: "tokens.txt",
      dataDir: "espeak-ng-data",
      lexicon: british ? "lexicon-gb-en.txt" : "lexicon-us-en.txt",
      // Both lexicons, for every speaker: the files (and so the install check) are the same for all of them.
      lexiconUs: "lexicon-us-en.txt",
      lexiconGb: "lexicon-gb-en.txt"
    },
    speaker: id,
    lang: british ? "en-gb" : "en-us",
    threads: 8,
    sampleRate: 24_000,
    license: "Apache-2.0",
    sizeMb: 350,
    diskMb: 403,
    voice: {
      name,
      description: description ??
        `Kokoro: ${british ? "British" : "American"} English (upstream grade ${grade}); one download with the other ${KOKORO_COUNT - 1} Kokoro voices.`,
      language: british ? "en-GB" : "en-US",
      gender: speaker[1] === "f" ? "female" : "male",
      tags: ["natural", "slow-start"]
    }
  }
}

const table: Array<Preset> = [
  // The first three: the voices of earlier versions (their keys are stored in settings and favourites).
  piper(
    "en_US-lessac-medium",
    "Trained on the Blizzard 2013 Lessac dataset, whose licence allows non-commercial (research) use only",
    { name: "Lessac", description: "Piper: fast, clear American English.", language: "en-US", gender: "female", tags: ["fast"] }
  ),
  piper(
    "nl_NL-pim-medium",
    "Dataset CC0 (fine-tuned from lessac-medium, so the lessac terms may carry over)",
    { name: "Pim", description: "Piper: fast Dutch.", language: "nl-NL", gender: "male", tags: ["fast"] }
  ),
  // The owner of the Kokoro archive: the first Kokoro preset in this table.
  kokoro("af_heart", 3, "Heart", "A", "Kokoro: warm and natural; its first audio comes later."),

  // Piper, English (US).
  piper("en_US-amy-medium", "Dataset: see https://github.com/MycroftAI/mimic3-voices", piperVoice("Amy", "en-US", "female", "American English.")),
  piper("en_US-kristin-medium", "Dataset public domain (LibriVox)", piperVoice("Kristin", "en-US", "female", "American English.")),
  piper("en_US-ryan-medium", "Dataset CC BY-NC-SA 4.0 (non-commercial)", piperVoice("Ryan", "en-US", "male", "American English.")),
  piper("en_US-john-medium", "Dataset public domain (LibriVox)", piperVoice("John", "en-US", "male", "American English.")),
  piper("en_US-joe-medium", "Dataset CC0", piperVoice("Joe", "en-US", "male", "American English.")),
  // Piper, English (GB).
  piper("en_GB-alba-medium", "Dataset CC BY 4.0", piperVoice("Alba", "en-GB", "female", "British English, Scottish accent.")),
  piper("en_GB-cori-medium", "Dataset CC BY 4.0 (Hi-Fi TTS, NVIDIA)", piperVoice("Cori", "en-GB", "female", "British English.")),
  piper("en_GB-jenny_dioco-medium", "Dataset: see https://github.com/dioco-group/jenny-tts-dataset", piperVoice("Jenny", "en-GB", "female", "British English.")),
  piper("en_GB-alan-medium", "Dataset: see https://github.com/MycroftAI/mimic3-voices", piperVoice("Alan", "en-GB", "male", "British English.")),
  piper("en_GB-northern_english_male-medium", "Dataset CC BY-SA 4.0", piperVoice("Northern English", "en-GB", "male", "British English, northern accent.")),
  // Piper, Dutch.
  piper("nl_NL-ronnie-medium", "Dataset CC0", piperVoice("Ronnie", "nl-NL", "male", "Dutch.")),
  piper("nl_NL-alex-medium", "Dataset CC0", piperVoice("Alex", "nl-NL", "male", "Dutch.")),
  piper("nl_BE-nathalie-medium", "Dataset CC0", piperVoice("Nathalie", "nl-BE", undefined, "Flemish (Belgian Dutch).")),
  piper("nl_BE-rdh-medium", "Dataset CC0", piperVoice("Rdh", "nl-BE", "male", "Flemish (Belgian Dutch).")),
  // Piper, other languages.
  piper("de_DE-thorsten-medium", "Dataset CC0", piperVoice("Thorsten", "de-DE", "male", "German.")),
  piper("de_DE-kerstin-low", "Dataset CC0", piperVoice("Kerstin", "de-DE", undefined, "German (lower quality, 16 kHz)."), lowRate),
  piper("fr_FR-siwis-medium", "Dataset CC BY 4.0", piperVoice("Siwis", "fr-FR", "female", "French.")),
  piper("fr_FR-gilles-low", "Dataset CC0", piperVoice("Gilles", "fr-FR", "male", "French (lower quality, 16 kHz)."), lowRate),
  piper("es_ES-davefx-medium", "Dataset CC0", piperVoice("Davefx", "es-ES", "male", "Spanish (Spain).")),
  piper("es_AR-daniela-high", "Dataset CC BY-SA 4.0", piperVoice("Daniela", "es-AR", undefined, "Spanish (Argentina), high quality."), { sizeMb: 116, diskMb: 134 }),
  piper("it_IT-paola-medium", "Dataset CC0", piperVoice("Paola", "it-IT", "female", "Italian.")),
  piper("pt_BR-cadu-medium", "Dataset CC0", piperVoice("Cadu", "pt-BR", "male", "Brazilian Portuguese.")),
  piper("pt_BR-faber-medium", "Dataset CC0", piperVoice("Faber", "pt-BR", undefined, "Brazilian Portuguese.")),
  piper("pt_PT-tugao-medium", "Dataset CC0", piperVoice("Tugão", "pt-PT", undefined, "European Portuguese.")),

  // Kokoro, the other English speakers (ids 0–27 of the archive; 3 is Heart, above). Grades: upstream VOICES.md.
  kokoro("af_bella", 2, "Bella", "A-"),
  kokoro("af_nicole", 6, "Nicole", "B-"),
  kokoro("af_aoede", 1, "Aoede", "C+"),
  kokoro("af_kore", 5, "Kore", "C+"),
  kokoro("af_sarah", 9, "Sarah", "C+"),
  kokoro("af_alloy", 0, "Alloy", "C"),
  kokoro("af_nova", 7, "Nova", "C"),
  kokoro("af_sky", 10, "Sky", "C-"),
  kokoro("af_jessica", 4, "Jessica", "D"),
  kokoro("af_river", 8, "River", "D"),
  kokoro("am_fenrir", 14, "Fenrir", "C+"),
  kokoro("am_michael", 16, "Michael", "C+"),
  kokoro("am_puck", 18, "Puck", "C+"),
  kokoro("am_echo", 12, "Echo", "D"),
  kokoro("am_eric", 13, "Eric", "D"),
  kokoro("am_liam", 15, "Liam", "D"),
  kokoro("am_onyx", 17, "Onyx", "D"),
  kokoro("am_santa", 19, "Santa", "D-"),
  kokoro("am_adam", 11, "Adam", "F+"),
  kokoro("bf_emma", 21, "Emma", "B-"),
  kokoro("bf_isabella", 22, "Isabella", "C"),
  kokoro("bf_alice", 20, "Alice", "D"),
  kokoro("bf_lily", 23, "Lily", "D"),
  kokoro("bm_fable", 25, "Fable", "C"),
  kokoro("bm_george", 26, "George", "C"),
  kokoro("bm_lewis", 27, "Lewis", "D+"),
  kokoro("bm_daniel", 24, "Daniel", "D")
]

export const presets: Readonly<Record<string, Preset>> = Object.fromEntries(table.map((p) => [p.name, p]))

const lookup = (name: string): Preset | undefined => (Object.hasOwn(presets, name) ? presets[name] : undefined)

/**
 * The preset an archive is downloaded (and deleted, and listed on the Models page) under: the first preset in the
 * table with the same `dir`. For a preset with an archive of its own, itself. `undefined` for an unknown name.
 */
export const archiveOwner = (name: string): string | undefined => {
  const preset = lookup(name)
  return preset === undefined ? undefined : table.find((p) => p.dir === preset.dir)!.name
}

/** The presets that share `name`'s archive, `name` included (one entry for an archive of its own). */
export const archiveVoices = (name: string): ReadonlyArray<string> => {
  const preset = lookup(name)
  return preset === undefined ? [] : table.filter((p) => p.dir === preset.dir).map((p) => p.name)
}

export const DEFAULT_PRESET = "en_US-lessac-medium"

/** `<repo>/models`, next to `packages/`. */
export const defaultModelDir = fileURLToPath(new URL("../../../models", import.meta.url))

/** Download size of a preset, MB. */
export const sizeMb = (preset: Preset): number => preset.sizeMb

/** A short label for the Models page ("Piper en_US-lessac-medium"). */
export const presetLabel = (preset: Preset): string => {
  const shared = archiveVoices(preset.name).length
  return shared > 1 && preset.engine === "kokoro"
    ? `Kokoro v1.0 (${shared} voices)`
    : `${preset.engine === "kokoro" ? "Kokoro" : "Piper"} ${preset.name}`
}

/** The command that downloads a preset, for error messages. */
export const downloadCommand = (preset: string) => `pnpm --filter @pva/tts-sherpa download ${preset}`

/** Where to get a missing preset: the web UI, or the command. */
export const downloadHint = (preset: string) => `Download it in Settings → Voices → Models, or run: ${downloadCommand(preset)}`

export const presetFiles = (preset: Preset, modelDir: string): Record<string, string> =>
  Object.fromEntries(Object.entries(preset.files).map(([k, f]) => [k, join(modelDir, preset.dir, f)]))

/**
 * The sherpa-onnx module and `OfflineTtsConfig` for a preset. Piper must use
 * 1.13.8 (2.x dropped the built-in espeak phonemiser Piper models need).
 */
export const engineConfig = (preset: Preset, modelDir: string, threads: number) => {
  const f = presetFiles(preset, modelDir)
  const model = preset.engine === "piper"
    ? { vits: { model: f.model, tokens: f.tokens, dataDir: f.dataDir } }
    : { kokoro: { model: f.model, voices: f.voices, tokens: f.tokens, dataDir: f.dataDir, lexicon: f.lexicon, lang: preset.lang ?? "en-us" } }
  return {
    module: preset.engine === "piper" ? "sherpa-onnx-node-v1" : "sherpa-onnx-node",
    // maxNumSentences 1: one clause in, one generate call; silenceScale only affects pauses inside a clause.
    config: { model: { ...model, numThreads: threads, provider: "cpu", debug: false }, maxNumSentences: 1, silenceScale: 0.2 }
  }
}
