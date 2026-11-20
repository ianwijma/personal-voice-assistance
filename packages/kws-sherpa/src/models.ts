/**
 * The two English-capable sherpa-onnx keyword-spotting models (release tag `kws-models`), with the files this
 * package uses. Sizes are the release archive and the files actually loaded (int8 encoder/joiner).
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models"

export type TokenizerKind = "bpe" | "phone"

export interface KwsModel {
  readonly name: KwsModelName
  readonly dir: string
  readonly url: string
  /** download size of the .tar.bz2, MB */
  readonly archiveMb: number
  readonly tokenizer: TokenizerKind
  /** relative to `dir` */
  readonly files: {
    readonly encoder: string
    readonly decoder: string
    readonly joiner: string
    readonly tokens: string
    /** bpe.model (bpe) or en.phone (phone) */
    readonly tokenizer: string
  }
}

export type KwsModelName = "gigaspeech-bpe" | "zh-en-phone" | "zh-en-phone-chunk8"

const giga = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
const zhEn = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"

export const kwsModels: Readonly<Record<KwsModelName, KwsModel>> = {
  /** English only, GigaSpeech 10 k h, 500 BPE tokens. Keywords need sentencepiece encoding (src/sentencepiece.ts). */
  "gigaspeech-bpe": {
    name: "gigaspeech-bpe",
    dir: giga,
    url: `${RELEASES}/${giga}.tar.bz2`,
    archiveMb: 16.8,
    tokenizer: "bpe",
    files: {
      encoder: "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      decoder: "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
      joiner: "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
      tokens: "tokens.txt",
      tokenizer: "bpe.model"
    }
  },
  /** Chinese + English, ARPAbet phones for English (lexicon en.phone). 16-frame chunks. */
  "zh-en-phone": {
    name: "zh-en-phone",
    dir: zhEn,
    url: `${RELEASES}/${zhEn}.tar.bz2`,
    archiveMb: 31.4,
    tokenizer: "phone",
    files: {
      encoder: "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
      decoder: "decoder-epoch-13-avg-2-chunk-16-left-64.onnx",
      joiner: "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx",
      tokens: "tokens.txt",
      tokenizer: "en.phone"
    }
  },
  /** The same model exported with 8-frame chunks (lower fire delay, more decode calls). */
  "zh-en-phone-chunk8": {
    name: "zh-en-phone-chunk8",
    dir: zhEn,
    url: `${RELEASES}/${zhEn}.tar.bz2`,
    archiveMb: 31.4,
    tokenizer: "phone",
    files: {
      encoder: "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
      decoder: "decoder-epoch-13-avg-2-chunk-8-left-64.onnx",
      joiner: "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
      tokens: "tokens.txt",
      tokenizer: "en.phone"
    }
  }
}

export const kwsModelNames = Object.keys(kwsModels) as ReadonlyArray<KwsModelName>

export const isKwsModelName = (s: string): s is KwsModelName => (kwsModelNames as ReadonlyArray<string>).includes(s)

/** `<repo>/models`, like the other sherpa packages; `KWS_MODEL_DIR` overrides it. */
export const defaultModelDir: string = process.env["KWS_MODEL_DIR"] ??
  fileURLToPath(new URL("../../../models", import.meta.url))

export const modelPaths = (model: KwsModel, modelDir: string = defaultModelDir) => {
  const d = join(modelDir, model.dir)
  return {
    encoder: join(d, model.files.encoder),
    decoder: join(d, model.files.decoder),
    joiner: join(d, model.files.joiner),
    tokens: join(d, model.files.tokens),
    tokenizer: join(d, model.files.tokenizer)
  }
}

/** The first missing file of a model, or undefined when all are there. */
export const missingFile = (model: KwsModel, modelDir: string = defaultModelDir): string | undefined =>
  Object.values(modelPaths(model, modelDir)).find((f) => !existsSync(f))
