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
  /** Directory the archive unpacks to, relative to the model directory. */
  readonly dir: string
  /** Download URL of the `.tar.bz2` archive. */
  readonly url: string
  /** Model files, relative to `dir`. */
  readonly files: Readonly<Record<string, string>>
  readonly speaker: number
  readonly threads: number
  /** Native output rate (the engine reports it too; this is for documentation and checks). */
  readonly sampleRate: number
  readonly license: string
  /** Download size, MB (10^6 bytes; the release's Content-Length, 2026-11-14). */
  readonly sizeMb: number
  /** Unpacked size, MB. */
  readonly diskMb: number
  /** How the voice picker shows it (docs/VOICE-PROVIDERS.md §4.1). */
  readonly voice: {
    readonly name: string
    readonly description: string
    /** BCP 47. */
    readonly language: string
    readonly gender: "female" | "male" | "neutral"
    readonly tags: ReadonlyArray<string>
  }
}

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"

/** A Piper voice from the sherpa-onnx releases, e.g. `piper("en_US-lessac-medium", "...")`. */
const piper = (voice: string, license: string, about: Preset["voice"], sizeMb = 68, diskMb = 83): Preset => ({
  name: voice,
  engine: "piper",
  dir: `vits-piper-${voice}`,
  url: `${RELEASES}/vits-piper-${voice}.tar.bz2`,
  files: { model: `${voice}.onnx`, tokens: "tokens.txt", dataDir: "espeak-ng-data" },
  speaker: 0,
  threads: 4, // measured best for the fp32 models on this machine (8 is barely faster)
  sampleRate: 22_050,
  license,
  sizeMb,
  diskMb,
  voice: about
})

export const presets: Readonly<Record<string, Preset>> = Object.fromEntries(([
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
  {
    name: "kokoro-af_heart",
    engine: "kokoro",
    dir: "kokoro-multi-lang-v1_0",
    url: `${RELEASES}/kokoro-multi-lang-v1_0.tar.bz2`,
    files: {
      model: "model.onnx",
      voices: "voices.bin",
      tokens: "tokens.txt",
      dataDir: "espeak-ng-data",
      lexicon: "lexicon-us-en.txt"
    },
    speaker: 3, // af_heart
    threads: 8,
    sampleRate: 24_000,
    license: "Apache-2.0",
    sizeMb: 350,
    diskMb: 403,
    voice: {
      name: "Heart",
      description: "Kokoro: warm and natural; its first audio comes later.",
      language: "en-US",
      gender: "female",
      tags: ["natural", "slow-start"]
    }
  }
] satisfies Array<Preset>).map((p) => [p.name, p]))

export const DEFAULT_PRESET = "en_US-lessac-medium"

/** `<repo>/models`, next to `packages/`. */
export const defaultModelDir = fileURLToPath(new URL("../../../models", import.meta.url))

/** Download size of a preset, MB. */
export const sizeMb = (preset: Preset): number => preset.sizeMb

/** A short label for the Models page ("Piper en_US-lessac-medium"). */
export const presetLabel = (preset: Preset): string => `${preset.engine === "kokoro" ? "Kokoro" : "Piper"} ${preset.name}`

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
    : { kokoro: { model: f.model, voices: f.voices, tokens: f.tokens, dataDir: f.dataDir, lexicon: f.lexicon, lang: "en-us" } }
  return {
    module: preset.engine === "piper" ? "sherpa-onnx-node-v1" : "sherpa-onnx-node",
    // maxNumSentences 1: one clause in, one generate call; silenceScale only affects pauses inside a clause.
    config: { model: { ...model, numThreads: threads, provider: "cpu", debug: false }, maxNumSentences: 1, silenceScale: 0.2 }
  }
}
