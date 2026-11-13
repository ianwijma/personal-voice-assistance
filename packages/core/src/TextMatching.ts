/**
 * Small, pure text helpers shared by the trigger router (`Routing.ts`) and the
 * typed-intent path (`Decision.ts`; the value parser and the offline keyword
 * decider of build plan piece C). No Effect, no I/O: they run on the hot path
 * of every turn and must cost microseconds.
 *
 * See docs/AGENTS-AND-INTENTS.md §2.3.
 */

/** A word of an utterance: its normalised form and where it sits in the original text. */
export interface Word {
  /** Lower case, diacritics and apostrophes removed ("Hé" → "he", "what's" → "whats"). */
  readonly norm: string
  /** Offset of the first character in the original text. */
  readonly start: number
  /** Offset just past the last character in the original text. */
  readonly end: number
  /**
   * The word ends in a possessive suffix with its apostrophe: "bedroom's", "Bedroom’s", "kids'"
   * (review round 6). `norm` drops the apostrophe ("bedrooms"), so this is the only trace of it.
   */
  readonly possessive?: true
}

const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu

/**
 * Normalise one word: lower case, no diacritics, no apostrophes. Canonical decomposition (NFD),
 * not compatibility decomposition (review round 5): "²", "４", "ﬁ" stay what they are, so a
 * superscript or full-width character never turns into the digit or letters it resembles.
 */
export const normalizeWord = (word: string): string =>
  word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’]/g, "")

/** Split text into words (letters and digits; punctuation and spaces separate words). */
export const words = (text: string): Array<Word> => {
  const result: Array<Word> = []
  for (const match of text.matchAll(wordPattern)) {
    const norm = normalizeWord(match[0])
    if (norm.length === 0) continue
    const possessive = /\p{L}['’][sS]$/u.test(match[0]) || /[sS]['’]$/u.test(match[0])
    result.push(possessive ? { norm, start: match.index, end: match.index + match[0].length, possessive: true } : { norm, start: match.index, end: match.index + match[0].length })
  }
  return result
}

/**
 * Join runs of two or more one-letter words into one word, so a name the
 * recogniser spelled out still matches ("J. E. V." → "jev"). Digits are not joined.
 */
export const joinSpelledLetters = (input: ReadonlyArray<Word>): Array<Word> => {
  const result: Array<Word> = []
  let i = 0
  while (i < input.length) {
    let j = i
    while (j < input.length && input[j]!.norm.length === 1 && /\p{L}/u.test(input[j]!.norm)) j++
    if (j - i >= 2) {
      result.push({ norm: input.slice(i, j).map((w) => w.norm).join(""), start: input[i]!.start, end: input[j - 1]!.end })
      i = j
    } else {
      result.push(input[i]!)
      i++
    }
  }
  return result
}

/** The normalised words of `text` joined by single spaces ("Hey, Jev!" → "hey jev"). */
export const normalizePhrase = (text: string): string => words(text).map((w) => w.norm).join(" ")

const vowels = new Set(["a", "e", "i", "o", "u", "y"])

/**
 * A coarse "sounds alike" key for one normalised word, built for matching
 * misrecognised trigger words, not for general phonetics:
 * - spellings of one sound are merged: ph/v → f, ck/q/hard c → k, soft c/z → s,
 *   soft g (before e, i, y) → j, ch/sh → x, dg → j, x (not first) → ks;
 * - a run of vowels keeps only its first letter (y counts as a vowel except as the first letter),
 *   so "hey" → "he" but "hay" → "ha";
 * - doubled letters collapse;
 * - a final silent "e" after a consonant is dropped when the key is longer than three letters.
 *
 * "jev", "jeff", "jef", "gef" → "jef"; "claude" → "klad", "cloud" → "klod"; "codex", "codecs" → "kodeks".
 */
export const phoneticWord = (word: string): string => {
  let s = word.replace(/[^a-z0-9]/g, "")
  s = s
    .replace(/(?<=.)x/g, "ks")
    .replace(/ph/g, "f")
    .replace(/[cs]h/g, "x")
    .replace(/ck/g, "k")
    .replace(/dg/g, "j")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/qu/g, "kw")
    .replace(/q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
  let out = ""
  let previous = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const isVowel = vowels.has(ch) && !(ch === "y" && i === 0)
    if (isVowel && vowels.has(previous)) continue // keep the first vowel of a run
    if (ch === previous) continue // collapse doubled letters
    out += ch
    previous = isVowel ? ch : ch === "y" ? "" : ch
  }
  if (out.length > 3 && out.endsWith("e") && !vowels.has(out[out.length - 2]!)) out = out.slice(0, -1)
  return out
}

/** `phoneticWord` of every word of `text`, joined by single spaces. */
export const phoneticKey = (text: string): string => words(text).map((w) => phoneticWord(w.norm)).filter((k) => k.length > 0).join(" ")

/**
 * Edit distance with adjacent transpositions (optimal string alignment).
 * Stops early and returns `limit + 1` once the distance must exceed `limit`.
 */
export const editDistance = (a: string, b: string, limit = Number.POSITIVE_INFINITY): number => {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  const rows: Array<Array<number>> = []
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0))
    rows[i]![0] = i
  }
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Number.POSITIVE_INFINITY
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1)
      rows[i]![j] = d
      if (d < rowMin) rowMin = d
    }
    if (rowMin > limit) return limit + 1
  }
  return rows[a.length]![b.length]!
}

/** Light stemming for keyword overlap: "lights" → "light", "rooms" → "room" (words longer than 3 letters). */
export const stem = (word: string): string => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)
