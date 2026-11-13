/**
 * Model presets. A preset is a sherpa-onnx streaming transducer release: the
 * directory it unpacks to under `models/`, its four files, and how to run it.
 * Adding a model = one entry here.
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

export interface Preset {
  /** Directory under the models directory (the archive's top-level directory). */
  readonly dir: string
  /** `.tar.bz2` archive that unpacks to `dir`. */
  readonly url: string
  readonly encoder: string
  readonly decoder: string
  readonly joiner: string
  readonly tokens: string
  readonly featureDim: number
  readonly threads: number
  /** Per-stream `language` option for multilingual models ("auto", "en", "nl", ...). */
  readonly language?: string
  /**
   * Silence appended before `inputFinished()` when a segment is finalised. It must
   * push every speech frame through the encoder: `reset()` keeps frames that did
   * not fill a chunk, and they are decoded at the start of the next segment (the
   * end of one turn leaks into the next). Sized as (chunk + right context) minus
   * the >= 250 ms of real silence the stream already holds when it is finalised;
   * see README.
   */
  readonly tailPaddingMs: number
  readonly description: string
}

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"

const transducer = (dir: string, files?: { encoder: string; decoder: string; joiner: string }) => ({
  dir,
  url: `${RELEASES}/${dir}.tar.bz2`,
  encoder: files?.encoder ?? "encoder.int8.onnx",
  decoder: files?.decoder ?? "decoder.int8.onnx",
  joiner: files?.joiner ?? "joiner.int8.onnx",
  tokens: "tokens.txt"
})

export const presets = {
  "nemotron-3.5": {
    ...transducer("sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-320ms-int8-2026-06-11"),
    featureDim: 128,
    threads: 4,
    language: "auto",
    tailPaddingMs: 400,
    description: "NVIDIA Nemotron 3.5 ASR streaming 0.6B, 320 ms chunks, int8. Multilingual, punctuated. ~1 GB RAM."
  },
  "zipformer-en": {
    ...transducer("sherpa-onnx-streaming-zipformer-en-2023-06-26", {
      encoder: "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
      // The int8 decoder of this release loses accuracy; the float one is small.
      decoder: "decoder-epoch-99-avg-1-chunk-16-left-128.onnx",
      joiner: "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
    }),
    featureDim: 80,
    threads: 2,
    tailPaddingMs: 600,
    description: "icefall streaming Zipformer, English only, upper case without punctuation. Fast, ~220 MB RAM."
  },
  "fast-conformer-en": {
    ...transducer("sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-480ms-int8"),
    featureDim: 80,
    threads: 2,
    tailPaddingMs: 800,
    description: "NeMo streaming FastConformer transducer, 480 ms chunks, English only."
  }
} satisfies Record<string, Preset>

export type PresetName = keyof typeof presets
export const presetNames = Object.keys(presets) as ReadonlyArray<PresetName>
export const isPresetName = (name: string): name is PresetName => Object.hasOwn(presets, name)

export const VAD_FILE = "silero_vad.onnx"
export const VAD_URL = `${RELEASES}/silero_vad.onnx`

/** `<repository root>/models`. */
export const defaultModelDir: string = fileURLToPath(new URL("../../../../models", import.meta.url))

export const DOWNLOAD_COMMAND = "pnpm --filter @pva/stt-sherpa download-models"

export interface ModelFiles {
  readonly encoder: string
  readonly decoder: string
  readonly joiner: string
  readonly tokens: string
  readonly vad: string
}

export const modelFiles = (preset: Preset, modelDir: string): ModelFiles => ({
  encoder: join(modelDir, preset.dir, preset.encoder),
  decoder: join(modelDir, preset.dir, preset.decoder),
  joiner: join(modelDir, preset.dir, preset.joiner),
  tokens: join(modelDir, preset.dir, preset.tokens),
  vad: join(modelDir, VAD_FILE)
})

/** The first file of the preset (or the VAD model) that does not exist, if any. */
export const missingFile = (files: ModelFiles): string | undefined =>
  Object.values(files).find((file) => !existsSync(file))
