/**
 * Model presets. Three kinds:
 * - `streaming`: a sherpa-onnx streaming transducer, fed from the VAD's speech
 *   onset; words appear while the user speaks (`Interim`), each pause longer
 *   than the eager threshold finalises a segment.
 * - `offline`: a non-streaming model (Parakeet, Whisper) that decodes the whole
 *   turn so far, from its start, at every eager end-of-turn point.
 * - `hybrid`: both in one worker: the streaming model only for live words, the
 *   offline model for the speculative and final text.
 * Adding a model = one entry here (and its archive in `archives`).
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"

/** One `.tar.bz2` release archive that unpacks to `dir` under the models directory. */
export interface Archive {
  readonly dir: string
  readonly url: string
}

export interface StreamingModel {
  readonly archive: Archive
  readonly encoder: string
  readonly decoder: string
  readonly joiner: string
  readonly tokens: string
  readonly featureDim: number
  /**
   * Silence appended before `inputFinished()` when a segment is finalised, so
   * every speech frame goes through the encoder (chunk + right context, minus
   * the >= 250 ms of real silence the stream already holds); see README.
   */
  readonly tailPaddingMs: number
  /** Whether the model takes a per-stream `language` option ("auto", "en", "nl", ...). */
  readonly multilingual: boolean
}

export type OfflineModel =
  | {
    readonly type: "nemo_transducer"
    readonly archive: Archive
    readonly encoder: string
    readonly decoder: string
    readonly joiner: string
    readonly tokens: string
  }
  | {
    readonly type: "whisper"
    readonly archive: Archive
    readonly encoder: string
    readonly decoder: string
    readonly tokens: string
  }

interface PresetCommon {
  /** Short name for the settings screen. */
  readonly label: string
  /** One line for a person choosing between presets: accuracy, speed, memory, languages. */
  readonly description: string
  /** Shown last and marked as not recommended in the settings screen. */
  readonly demoted?: boolean
  /** Licence of the model files (see README). */
  readonly licence: string
}

export interface StreamingPreset extends PresetCommon {
  readonly kind: "streaming"
  readonly model: StreamingModel
  readonly threads: number
  /** Default per-stream language for multilingual models. */
  readonly language?: string
}

export interface OfflinePreset extends PresetCommon {
  readonly kind: "offline"
  readonly model: OfflineModel
  readonly threads: number
  /** Whether a language setting applies (Whisper: per recogniser; Parakeet detects it itself or is English only). */
  readonly takesLanguage: boolean
  /**
   * Longest turn decoded in one piece (30 s for Parakeet: the recogniser's memory grows with the longest
   * input it has decoded, and a 30 s decode takes about 1 s). Beyond it, the turn's audio so far is
   * decoded at the next VAD silence frame and the rest starts a new piece
   * (whose text is appended); hard cut 5 s later.
   */
  readonly maxTurnMs: number
  /** Interim text by decoding the turn so far again every this many ms of speech; 0 = none (see worker.mjs). */
  readonly interimMs: number
}

export interface HybridPreset extends PresetCommon {
  readonly kind: "hybrid"
  /** Live words only. */
  readonly streaming: StreamingModel
  readonly streamingThreads: number
  /** Speculative and final text. */
  readonly offline: OfflineModel
  readonly threads: number
  readonly takesLanguage: false
  readonly maxTurnMs: number
}

export type Preset = StreamingPreset | OfflinePreset | HybridPreset

const archive = (dir: string): Archive => ({ dir, url: `${RELEASES}/${dir}.tar.bz2` })

const transducer = (dir: string) => ({
  archive: archive(dir),
  encoder: "encoder.int8.onnx",
  decoder: "decoder.int8.onnx",
  joiner: "joiner.int8.onnx",
  tokens: "tokens.txt"
})

const nemotron = (chunkMs: 320 | 560): StreamingModel => ({
  ...transducer(`sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-${chunkMs}ms-int8-2026-06-11`),
  featureDim: 128,
  // 320 ms: found by probing (README). 560 ms: chunk + right context grow by 240 ms.
  tailPaddingMs: chunkMs === 320 ? 400 : 640,
  multilingual: true
})

const parakeet = (variant: "v2" | "ultra"): OfflineModel => ({
  type: "nemo_transducer",
  ...transducer(`sherpa-onnx-nemo-parakeet-tdt-0.6b-${variant}-int8`)
})

const NVIDIA_OPEN_MODEL = "NVIDIA Open Model License / OpenMDW-1.1 (see the model card)"

export const presets = {
  "parakeet-v2": {
    kind: "offline",
    label: "Parakeet v2 — accurate, English",
    description:
      "Best English accuracy (about 13 % word errors on phone-like audio, where Nemotron has 34 %). The reply starts 0.1–0.5 s after you stop. English only. About 1.3–1.5 GB of memory. Words appear about once a second while you talk.",
    model: parakeet("v2"),
    // The decode is on the critical path and bursty: 8 threads take 13.9 s of audio in 345 ms instead of 459 (stt-quality.md §2.3).
    threads: 8,
    takesLanguage: false,
    maxTurnMs: 30_000,
    interimMs: 1_000,
    licence: "CC-BY-4.0 (NVIDIA parakeet-tdt-0.6b-v2)"
  },
  "parakeet-ultra": {
    kind: "offline",
    label: "Parakeet Ultra — accurate, English + Dutch",
    description:
      "Nearly as accurate and as fast as Parakeet v2, and also understands Dutch and 23 more European languages (it picks the language itself, so very poor audio can confuse it). About 1.3–1.5 GB. Words appear about once a second.",
    model: parakeet("ultra"),
    threads: 8,
    takesLanguage: false,
    maxTurnMs: 30_000,
    interimMs: 1_000,
    licence: "CC-BY-4.0 (Moondream, post-trained from NVIDIA parakeet-tdt-0.6b-v3)"
  },
  "whisper-turbo": {
    kind: "offline",
    label: "Whisper turbo — robust, 99 languages, slow",
    description:
      "Most robust for Dutch in noise and knows 99 languages (set the language below, or leave it automatic), but slower: the reply starts 1–3 s after you stop. About 1.5–2.2 GB. No words until you pause, so the “say a few words” way of interrupting waits for a pause.",
    model: {
      type: "whisper",
      archive: archive("sherpa-onnx-whisper-turbo"),
      encoder: "turbo-encoder.int8.onnx",
      decoder: "turbo-decoder.int8.onnx",
      tokens: "turbo-tokens.txt"
    },
    threads: 8,
    takesLanguage: true,
    // Whisper's encoder sees at most 30 s.
    maxTurnMs: 28_000,
    // A Whisper decode takes 1–3 s: interim decodes would delay the reply.
    interimMs: 0,
    licence: "MIT (OpenAI Whisper large-v3-turbo)"
  },
  "hybrid-nemotron-parakeet": {
    kind: "hybrid",
    label: "Live words + Parakeet v2",
    description:
      "Shows your words live (Nemotron) while Parakeet v2 makes the accurate text the assistant answers. English answers. Same reply speed as Parakeet v2, about 2.2–2.6 GB of memory and more CPU.",
    streaming: nemotron(560),
    streamingThreads: 2,
    offline: parakeet("v2"),
    threads: 8,
    takesLanguage: false,
    maxTurnMs: 30_000,
    licence: "CC-BY-4.0 (Parakeet v2) and NVIDIA OpenMDW-1.1 (Nemotron)"
  },
  "nemotron-560": {
    kind: "streaming",
    label: "Nemotron 560 ms — live words, multilingual",
    description:
      "Shows words while you are still talking and is multilingual, but makes 2–3× the errors of Parakeet (about 31 % on phone-like audio). Replies start about 0.4 s after you stop. About 1.0 GB.",
    model: nemotron(560),
    threads: 4,
    language: "auto",
    licence: NVIDIA_OPEN_MODEL
  },
  "nemotron-320": {
    kind: "streaming",
    label: "Nemotron 320 ms — the previous default",
    description:
      "The previous default: live words, multilingual, the least accurate of the large models (about 34 % word errors on phone-like audio) and more CPU than the 560 ms version. About 1.0 GB.",
    model: nemotron(320),
    threads: 4,
    language: "auto",
    licence: NVIDIA_OPEN_MODEL
  },
  "zipformer-en": {
    kind: "streaming",
    label: "Zipformer — tiny, English (not recommended)",
    description:
      "Small (about 300 MB) and light on CPU, but by far the least accurate on real-world audio (about 53 % word errors on phone-like audio). English only, upper case without punctuation.",
    demoted: true,
    model: {
      archive: archive("sherpa-onnx-streaming-zipformer-en-2023-06-26"),
      encoder: "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
      // The int8 decoder of this release loses accuracy; the float one is small.
      decoder: "decoder-epoch-99-avg-1-chunk-16-left-128.onnx",
      joiner: "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
      tokens: "tokens.txt",
      featureDim: 80,
      tailPaddingMs: 600,
      multilingual: false
    },
    threads: 2,
    licence: "Apache-2.0 (icefall)"
  },
  "fast-conformer-en": {
    kind: "streaming",
    label: "FastConformer — small, English (not recommended)",
    description:
      "Small (about 400 MB), live words, English only; poor on noisy or quiet audio (about 38 % word errors on phone-like audio).",
    demoted: true,
    model: {
      ...transducer("sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8"),
      featureDim: 80,
      tailPaddingMs: 800,
      multilingual: false
    },
    threads: 2,
    licence: "CC-BY-4.0 (NVIDIA NeMo)"
  }
} satisfies Record<string, Preset>

export type PresetName = keyof typeof presets
export const presetNames = Object.keys(presets) as ReadonlyArray<PresetName>
export const isPresetName = (name: string): name is PresetName => Object.hasOwn(presets, name)

export const DEFAULT_PRESET: PresetName = "parakeet-v2"

/** Silero speech probability threshold (README: "Level handling"). */
export const DEFAULT_VAD_THRESHOLD = 0.5

/** Earlier preset names, still accepted (in the environment and in saved settings). */
export const legacyPresetNames: Readonly<Record<string, PresetName>> = { "nemotron-3.5": "nemotron-320" }

/** A preset name, or a legacy one mapped to its current name; `undefined` when unknown. */
export const resolvePresetName = (name: string): PresetName | undefined =>
  isPresetName(name) ? name : legacyPresetNames[name]

/** Whether a language setting changes anything for this preset. */
export const takesLanguage = (preset: Preset): boolean =>
  preset.kind === "streaming" ? preset.model.multilingual : preset.takesLanguage

export const VAD_FILE = "silero_vad.onnx"
export const VAD_URL = `${RELEASES}/silero_vad.onnx`

/** `<repository root>/models`. */
export const defaultModelDir: string = fileURLToPath(new URL("../../../models", import.meta.url))

export const DOWNLOAD_COMMAND = "pnpm --filter @pva/stt-sherpa download-models"

/** The archives a preset needs. */
export const archives = (preset: Preset): ReadonlyArray<Archive> =>
  preset.kind === "streaming"
    ? [preset.model.archive]
    : preset.kind === "offline"
    ? [preset.model.archive]
    : [preset.streaming.archive, preset.offline.archive]

const streamingFiles = (model: StreamingModel, modelDir: string) => ({
  encoder: join(modelDir, model.archive.dir, model.encoder),
  decoder: join(modelDir, model.archive.dir, model.decoder),
  joiner: join(modelDir, model.archive.dir, model.joiner),
  tokens: join(modelDir, model.archive.dir, model.tokens)
})

const offlineFiles = (model: OfflineModel, modelDir: string) =>
  model.type === "whisper"
    ? {
      type: "whisper" as const,
      encoder: join(modelDir, model.archive.dir, model.encoder),
      decoder: join(modelDir, model.archive.dir, model.decoder),
      tokens: join(modelDir, model.archive.dir, model.tokens)
    }
    : { type: "nemo_transducer" as const, ...streamingFiles({ ...model, featureDim: 0, tailPaddingMs: 0, multilingual: false }, modelDir) }

export type StreamingFiles = ReturnType<typeof streamingFiles>
export type OfflineFiles = ReturnType<typeof offlineFiles>

export interface ModelFiles {
  readonly streaming?: StreamingFiles
  readonly offline?: OfflineFiles
  readonly vad: string
}

export const modelFiles = (preset: Preset, modelDir: string): ModelFiles => {
  const vad = join(modelDir, VAD_FILE)
  switch (preset.kind) {
    case "streaming":
      return { streaming: streamingFiles(preset.model, modelDir), vad }
    case "offline":
      return { offline: offlineFiles(preset.model, modelDir), vad }
    case "hybrid":
      return { streaming: streamingFiles(preset.streaming, modelDir), offline: offlineFiles(preset.offline, modelDir), vad }
  }
}

/** Every file path of a `ModelFiles`. */
const paths = (files: ModelFiles): Array<string> => [
  ...Object.values(files.streaming ?? {}),
  ...Object.entries(files.offline ?? {}).filter(([key]) => key !== "type").map(([, file]) => file),
  files.vad
]

/** The first file of the preset (or the VAD model) that does not exist, if any. */
export const missingFile = (files: ModelFiles): string | undefined => paths(files).find((file) => !existsSync(file))

/** The presets whose files are all present. */
export const installedPresets = (modelDir: string = defaultModelDir): ReadonlyArray<PresetName> =>
  presetNames.filter((name) => missingFile(modelFiles(presets[name], modelDir)) === undefined)

/** The error text for a preset with missing files (with the download command), or `undefined` when complete. */
export const missingModelMessage = (name: PresetName, modelDir: string, customDir: boolean): string | undefined => {
  const missing = missingFile(modelFiles(presets[name], modelDir))
  if (missing === undefined) return undefined
  return `Speech model file not found: ${missing}. Download it with \`${DOWNLOAD_COMMAND} ${name}` +
    (customDir ? ` --model-dir ${modelDir}` : "") + "`"
}
