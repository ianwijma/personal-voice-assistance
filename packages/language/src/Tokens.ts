import { maxTextLength, maxWords } from "./Domain.ts"

/** One word of spoken or typed text: lower case, no accents, no apostrophes, with its place in the original. */
export interface Tok {
  readonly norm: string
  readonly start: number
  readonly end: number
  readonly kind: "word" | "digits"
}

const wordAt = /[\p{L}][\p{L}\p{M}]*(?:['’][\p{L}][\p{L}\p{M}]*)*/uy
const digitsAt = /[0-9]+(?:[.,:][0-9]+)*/y
const meridiemAt = /([ap])\.\s?m\./iy
const ordinalSuffix = /^(st|nd|rd|th|e|de|ste)$/
const space = /\s/u
const sentencePunctuation = new Set([",", ".", "!", "?"])
const dashes = new Set(["-", "‐", "–", "—"])
const apostrophes = new Set(["'", "’"])

export const stripMarks = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "")
const normOf = (raw: string): string => stripMarks(raw).toLowerCase().replace(/['’]/g, "")

/**
 * Split a phrase into tokens, or `undefined` when it holds something no grammar here reads. The one tokenizer of every parser
 * (review round 3, decision 3):
 * - a word is letters (with any combining marks, so a decomposed "tweeënhalf" is one word), apostrophes only inside it ("o'clock");
 *   digits are ASCII digits with `.`, `,` or `:` only between digits ("7:30", "2,5", "1,500"); "a.m." and "p.m." are "am" and "pm";
 *   "3rd" and "3e" are one token;
 * - between tokens only spaces and the sentence punctuation `, . ! ?` (not right before digits: ".5"); a hyphen or dash only right between two words
 *   ("twenty-one"); an apostrophe only right before an "s" word (Dutch "'s avonds");
 * - digits may run into a word ("5kg", "7pm"), a word never into digits ("x3", "1e3" are refused);
 * - anything else — a sign, a symbol, "½", a slash, a bracket, a quote, digits that are not ASCII — makes the phrase unreadable.
 * At most `maxTextLength` characters and `maxWords` tokens.
 */
export const tokenize = (text: string): Array<Tok> | undefined => {
  if (typeof text !== "string" || text.length > maxTextLength) return undefined
  const out: Array<Tok> = []
  let at = 0
  let gap = true
  while (at < text.length) {
    const c = text[at]!
    if (space.test(c) || sentencePunctuation.has(c)) {
      // A mark right before digits belongs to the number (".5", ",5"): no grammar here reads it, so the phrase is unreadable.
      if (sentencePunctuation.has(c) && /[0-9]/.test(text[at + 1] ?? "")) return undefined
      gap = true
      at++
      continue
    }
    if (dashes.has(c)) {
      const prev = out[out.length - 1]
      wordAt.lastIndex = at + 1
      if (prev === undefined || prev.kind !== "word" || prev.end !== at || !wordAt.test(text)) return undefined
      gap = true
      at++
      continue
    }
    if (apostrophes.has(c)) {
      wordAt.lastIndex = at + 1
      const m = wordAt.exec(text)
      if (!gap || (out.length > 0 && out[out.length - 1]!.end === at) || m === null || normOf(m[0]) !== "s") return undefined
      gap = true
      at++
      continue
    }
    meridiemAt.lastIndex = at
    const meridiem = meridiemAt.exec(text)
    if (meridiem !== null) {
      const end = at + meridiem[0].length
      if (!gap && out[out.length - 1]?.kind !== "digits") return undefined
      out.push({ norm: `${meridiem[1]!.toLowerCase()}m`, start: at, end, kind: "word" })
      gap = false
      at = end
      continue
    }
    digitsAt.lastIndex = at
    const d = digitsAt.exec(text)
    if (d !== null) {
      // A word never runs into digits ("x3", "1e3"); digits never run into digits (they would be one token).
      if (!gap) return undefined
      out.push({ norm: d[0], start: at, end: at + d[0].length, kind: "digits" })
      gap = false
      at += d[0].length
      continue
    }
    wordAt.lastIndex = at
    const w = wordAt.exec(text)
    if (w !== null) {
      const norm = normOf(w[0])
      const prev = out[out.length - 1]
      const end = at + w[0].length
      if (!gap && prev !== undefined && prev.kind === "digits" && /^[0-9]{1,2}$/.test(prev.norm) && ordinalSuffix.test(norm)) {
        out[out.length - 1] = { norm: prev.norm + norm, start: prev.start, end, kind: "digits" }
      } else {
        if (!gap && prev?.kind !== "digits") return undefined
        out.push({ norm, start: at, end, kind: "word" })
      }
      gap = false
      at = end
      continue
    }
    return undefined
  }
  return out.length > maxWords ? undefined : out
}

/** The text of tokens `[from, to)` as it was written. */
export const sliceText = (text: string, toks: ReadonlyArray<Tok>, from: number, to: number): string =>
  to > from ? text.slice(toks[from]!.start, toks[to - 1]!.end) : ""
