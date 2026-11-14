/**
 * A SentencePiece encoder in TypeScript, enough to turn a wake phrase into the tokens the English sherpa-onnx
 * keyword spotter (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`) expects. Its `bpe.model` is, despite
 * the name, a **unigram** model (`trainer_spec.model_type` = 1, as icefall's `prepare_lang_bpe` trains them), so
 * encoding is a Viterbi search for the segmentation with the highest sum of piece scores.
 *
 * sherpa-onnx's keyword spotter does not tokenise: every keyword line must already be model tokens
 * (`EncodeBase` in sherpa-onnx/csrc/utils.cc looks each whitespace-separated word up in tokens.txt).
 * Upstream does this in Python (`sherpa-onnx-cli text2token`, which calls the `sentencepiece` package).
 * This file reads the same `bpe.model` (a protobuf `ModelProto`) and runs the same search as
 * sentencepiece's `unigram_model.cc` (`EncodeOptimized`): best[end] = max over pieces ending there of
 * best[start] + score, the earliest start winning ties; a code point no piece covers becomes `<unk>` with score
 * min_score − 10 (kUnkPenalty) and is returned as its own text, as
 * `encode(out_type=str)` does, so the tokens.txt check rejects it (rather than letting `<unk>` through).
 *
 * Only what the KWS models need: no byte fallback, no sampling, no user-defined symbols, normalisation reduced to
 * "trim, collapse whitespace, prefix every word with ▁" (NFKC is the identity on the upper-case ASCII phrases fed
 * to it).
 * The test compares the output with the reference `sentencepiece` on a phrase set.
 */

export const WORD_START = "▁"

/** piece type numbers from sentencepiece_model.proto */
const NORMAL = 1

export interface BpeModel {
  /** piece → score, NORMAL pieces only (the ones Viterbi may choose). */
  readonly scores: ReadonlyMap<string, number>
  /** longest piece, in code points */
  readonly maxLen: number
  readonly unkScore: number
}

// --- minimal protobuf reader -------------------------------------------------------------------------------------

class Reader {
  pos = 0
  readonly buf: Uint8Array
  constructor(buf: Uint8Array) {
    this.buf = buf
  }
  get done(): boolean {
    return this.pos >= this.buf.length
  }
  varint(): number {
    let result = 0
    let shift = 0
    for (;;) {
      const b = this.buf[this.pos++]
      if (b === undefined) throw new Error("bpe.model: truncated varint")
      result += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) return result
      shift += 7
    }
  }
  bytes(): Uint8Array {
    const len = this.varint()
    const out = this.buf.subarray(this.pos, this.pos + len)
    if (out.length !== len) throw new Error("bpe.model: truncated field")
    this.pos += len
    return out
  }
  float32(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true)
    this.pos += 4
    return v
  }
  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 1) this.pos += 8
    else if (wire === 2) this.bytes()
    else if (wire === 5) this.pos += 4
    else throw new Error(`bpe.model: unsupported wire type ${wire}`)
  }
}

const decoder = new TextDecoder()

/** Parse a sentencepiece `ModelProto` (the `bpe.model` file). Throws if it is not a BPE model. */
export const parseBpeModel = (bytes: Uint8Array): BpeModel => {
  const scores = new Map<string, number>()
  const r = new Reader(bytes)
  let modelType: number | undefined
  while (!r.done) {
    const key = r.varint()
    const field = Math.floor(key / 8)
    const wire = key & 7
    if (field === 1 && wire === 2) {
      // SentencePiece { string piece = 1; float score = 2; Type type = 3 [default NORMAL]; }
      const p = new Reader(r.bytes())
      let piece = ""
      let score = 0
      let type = NORMAL
      while (!p.done) {
        const k = p.varint()
        const f = Math.floor(k / 8)
        const w = k & 7
        if (f === 1 && w === 2) piece = decoder.decode(p.bytes())
        else if (f === 2 && w === 5) score = p.float32()
        else if (f === 3 && w === 0) type = p.varint()
        else p.skip(w)
      }
      if (type === NORMAL) scores.set(piece, score)
    } else if (field === 2 && wire === 2) {
      // TrainerSpec { ... ModelType model_type = 3; ... }  UNIGRAM = 1, BPE = 2
      const t = new Reader(r.bytes())
      while (!t.done) {
        const k = t.varint()
        if (Math.floor(k / 8) === 3 && (k & 7) === 0) modelType = t.varint()
        else t.skip(k & 7)
      }
    } else {
      r.skip(wire)
    }
  }
  // model_type defaults to UNIGRAM (1) when absent
  if (modelType !== undefined && modelType !== 1) throw new Error(`bpe.model: model_type ${modelType} is not unigram (1)`)
  if (scores.size === 0) throw new Error("bpe.model: no pieces")
  let min = Infinity
  let maxLen = 1
  for (const [p, s] of scores) {
    if (s < min) min = s
    maxLen = Math.max(maxLen, Array.from(p).length)
  }
  return { scores, maxLen, unkScore: min - 10 }
}

/** Viterbi over one already-normalised word (starting with ▁). */
const encodeWord = (model: BpeModel, word: string): Array<string> => {
  const cps = Array.from(word)
  const n = cps.length
  const best = new Array<number>(n + 1).fill(-Infinity)
  const from = new Array<number>(n + 1).fill(-1)
  const piece = new Array<string>(n + 1).fill("")
  best[0] = 0
  for (let start = 0; start < n; start++) {
    const base = best[start]!
    if (base === -Infinity) continue
    let covered = false
    let s = ""
    for (let end = start + 1; end <= Math.min(n, start + model.maxLen); end++) {
      s += cps[end - 1]!
      const score = model.scores.get(s)
      if (score === undefined) continue
      if (end === start + 1) covered = true
      if (base + score > best[end]!) {
        best[end] = base + score
        from[end] = start
        piece[end] = s
      }
    }
    if (!covered && base + model.unkScore > best[start + 1]!) {
      best[start + 1] = base + model.unkScore
      from[start + 1] = start
      // like sentencepiece's out_type=str: an unknown piece comes back as its surface text
      piece[start + 1] = cps[start]!
    }
  }
  const out: Array<{ text: string; unk: boolean }> = []
  for (let end = n; end > 0; end = from[end]!) out.push({ text: piece[end]!, unk: !model.scores.has(piece[end]!) })
  out.reverse()
  // sentencepiece joins consecutive unknown pieces into one ("42", not "4" "2")
  const merged: Array<string> = []
  out.forEach((p, i) => {
    if (p.unk && i > 0 && out[i - 1]!.unk) merged[merged.length - 1] += p.text
    else merged.push(p.text)
  })
  return merged
}

/**
 * Text → pieces, as `sentencepiece.encode(text, out_type=str)` would give for these models: words are split on
 * whitespace and each gets a leading ▁ (the models are trained with `split_by_whitespace`, so no piece spans two
 * words, and searching per word gives the same result as searching the whole string). Unknown code points come
 * back as themselves; the caller checks every piece against tokens.txt.
 */
export const encode = (model: BpeModel, text: string): Array<string> =>
  text.trim().split(/\s+/).filter((w) => w.length > 0).flatMap((w) => encodeWord(model, WORD_START + w))
