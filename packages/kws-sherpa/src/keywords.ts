/**
 * Plain-text wake phrases → the keyword lines sherpa-onnx's spotter reads (`EncodeBase`, sherpa-onnx/csrc/utils.cc):
 *
 *   <token> <token> … [:<boost score>] [#<trigger threshold>] [@<label>]
 *
 * one per phrase. Tokens must all be in the model's tokens.txt, the label has no spaces. Several lines are joined
 * with "/" when passed to `createStream(keywords)` (the C++ side replaces "/" by newlines).
 */
import { readFileSync } from "node:fs"
import { type Lexicon, parseLexicon, phones } from "./lexicon.ts"
import { type KwsModel, modelPaths } from "./models.ts"
import { type BpeModel, encode, parseBpeModel } from "./sentencepiece.ts"

export interface Phrase {
  /** As the owner types it: "hey jeff". */
  readonly text: string
  /** Per-phrase boost (default: the spotter's `keywordsScore`). */
  readonly boost?: number
  /** Per-phrase trigger threshold, 0..1 (default: the spotter's `keywordsThreshold`). */
  readonly threshold?: number
}

/** Upper case, letters / digits / apostrophes only, single spaces. */
export const normalizePhrase = (text: string): string =>
  text.toUpperCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim()

/** The label sherpa-onnx returns as `keyword` on a fire: lower-case, words joined with "_". */
export const phraseLabel = (text: string): string => normalizePhrase(text).toLowerCase().replace(/ /g, "_")

export class UnknownTokenError extends Error {
  readonly phrase: string
  readonly tokens: ReadonlyArray<string>
  constructor(phrase: string, tokens: ReadonlyArray<string>) {
    super(`"${phrase}" encodes to tokens the model does not have: ${tokens.join(" ")}`)
    this.phrase = phrase
    this.tokens = tokens
  }
}

export interface Tokenizer {
  readonly kind: KwsModel["tokenizer"]
  /** Phrase text → model tokens. Throws on words / tokens the model cannot represent. */
  readonly tokens: (text: string) => ReadonlyArray<string>
}

const readTokenSet = (path: string): ReadonlySet<string> =>
  new Set(readFileSync(path, "utf8").split("\n").map((l) => l.trim().split(/\s+/)[0] ?? "").filter((t) => t !== ""))

export const makeTokenizer = (
  kind: KwsModel["tokenizer"],
  parts: { readonly tokenSet: ReadonlySet<string>; readonly bpe?: BpeModel; readonly lexicon?: Lexicon },
  overrides: Readonly<Record<string, ReadonlyArray<string>>> = {}
): Tokenizer => ({
  kind,
  tokens: (text) => {
    const norm = normalizePhrase(text)
    const out = kind === "bpe"
      ? encode(parts.bpe!, norm)
      : phones(parts.lexicon!, norm.split(" "), overrides)
    const unknown = out.filter((t) => !parts.tokenSet.has(t))
    if (unknown.length > 0) throw new UnknownTokenError(text, unknown)
    return out
  }
})

/** Load the tokeniser of a model from its files (bpe.model: 245 kB; en.phone: 3.3 MB). */
export const loadTokenizer = (
  model: KwsModel,
  modelDir?: string,
  overrides: Readonly<Record<string, ReadonlyArray<string>>> = {}
): Tokenizer => {
  const p = modelPaths(model, modelDir)
  const tokenSet = readTokenSet(p.tokens)
  return model.tokenizer === "bpe"
    ? makeTokenizer("bpe", { tokenSet, bpe: parseBpeModel(readFileSync(p.tokenizer)) })
    : makeTokenizer("phone", { tokenSet, lexicon: parseLexicon(readFileSync(p.tokenizer, "utf8")) }, overrides)
}

/** One keyword line. */
export const keywordLine = (tokenizer: Tokenizer, phrase: Phrase): string => {
  const parts = [...tokenizer.tokens(phrase.text)]
  if (phrase.boost !== undefined) parts.push(`:${phrase.boost}`)
  if (phrase.threshold !== undefined) parts.push(`#${phrase.threshold}`)
  parts.push(`@${phraseLabel(phrase.text)}`)
  return parts.join(" ")
}

/** All phrases as one keywords text (newline-separated, as for `keywordsBuf`). Duplicate token sequences dropped. */
export const keywordsText = (tokenizer: Tokenizer, phrases: ReadonlyArray<Phrase>): string => {
  const seen = new Set<string>()
  const lines: Array<string> = []
  for (const p of phrases) {
    const key = tokenizer.tokens(p.text).join(" ")
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(keywordLine(tokenizer, p))
  }
  return lines.join("\n")
}
