import { isNumericWord } from "./NumberWords.ts"
import { normalizeWord, type Word, words } from "./TextMatching.ts"

/**
 * The one normalisation of what was said (docs/AGENTS-AND-INTENTS.md, "Review
 * fixes, fourth round"). The value parser, core's accounting, the confirmation
 * grammar and the promotion of a speculative intent turn all read an utterance
 * through `canonicalUtterance`, so they cannot disagree about what was said:
 * two transcripts with the same canonical text are interpreted identically, and
 * two that differ in anything the interpreter could treat differently have
 * different canonical texts.
 *
 * Canonical text = the original (Unicode NFC, case kept) with only the
 * IGNORABLE punctuation removed and whitespace collapsed. Ignorable is a closed
 * set, decided by the characters around it, never by what it means:
 *
 *   - `.` `!` `…` `;` `:` followed by whitespace or the end of the text
 *     (sentence punctuation; "14:30", ".5", "5.5" keep theirs);
 *   - `,` followed by whitespace or the end, unless the word before or after it
 *     is part of a number ("lights, please" loses it; "forty, five" and
 *     "40, 5" keep it, and the number grammar reads them as one unreadable span);
 *   - quotation marks `"` `“` `”` `„` `«` `»` `‘` `’` `‚` `` ` `` and `'` outside a word (between two
 *     letters or digits a quote is a mark: it would otherwise split the word);
 *   - a dash of any kind between two letters ("twenty-one", "wi-fi").
 *
 * Every other character that is not part of a word is a significant MARK and
 * stays: `?`, `%`, `°`, `+`, `/`, `#`, any dash or minus that is not between two
 * letters (U+002D, U+2010–U+2015, U+2212, U+FE58, U+FE63, U+FF0D, …), a `.` or
 * `,` glued to what follows ("to .5", "5,percent"), a comma next to a number.
 * A mark is accounted for only when the number span it belongs to consumes it
 * (`numericSpans`), when it is the final `?` of a polite question ("can you …?"),
 * or, for a comma kept next to a number but outside its span, as the one
 * punctuation that is ignorable outside numbers (`IGNORABLE_OUTSIDE_NUMBERS`).
 * Anything else makes the sentence unaccounted for (core's accounting).
 *
 * Idempotent: `canonicalUtterance(canonicalUtterance(t)) === canonicalUtterance(t)`.
 */

/** Every dash and minus: Unicode dash punctuation (U+002D, U+2010–U+2015, U+FE58, U+FE63, U+FF0D, …) and U+2212. */
export const DASH = /[\p{Pd}−]/u
/** The dashes read as a minus sign before a number; any other dash there makes the number unreadable. */
export const MINUS = /[-−﹣－]/u
/** Punctuation that is ignorable outside a number span once the text is canonical (a comma kept next to a number). */
export const IGNORABLE_OUTSIDE_NUMBERS: ReadonlySet<string> = new Set([","])

const TERMINAL = new Set([".", "!", "…", ";", ":"])
const QUOTES = new Set(["\"", "“", "”", "„", "«", "»", "‘", "’", "‚", "`", "'"])
const LETTER = /\p{L}/u
const SPACE = /\s/u
const wordPattern = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu

/** The canonical text of an utterance (see the module comment). Pure; linear in its length. */
export const canonicalUtterance = (raw: string): string => {
  const text = raw.normalize("NFC")
  const chars = [...text]
  // Code-point index → inside a word (letters/digits, apostrophes inside it).
  const inWord = new Array<boolean>(chars.length).fill(false)
  const offsets: Array<number> = []
  let o = 0
  for (const c of chars) {
    offsets.push(o)
    o += c.length
  }
  const indexAt = new Map<number, number>(offsets.map((off, i) => [off, i]))
  const wordAt = new Array<string | undefined>(chars.length).fill(undefined)
  for (const m of text.matchAll(wordPattern)) {
    const from = indexAt.get(m.index)!
    const to = indexAt.get(m.index + m[0].length) ?? chars.length
    const norm = normalizeWord(m[0])
    for (let k = from; k < to; k++) {
      inWord[k] = true
      wordAt[k] = norm
    }
  }
  /** The normalised word ending right before index `k` (skipping spaces and marks), or undefined. */
  const wordBefore = (k: number): string | undefined => {
    for (let j = k - 1; j >= 0; j--) if (inWord[j]) return wordAt[j]
    return undefined
  }
  const wordAfter = (k: number): string | undefined => {
    for (let j = k + 1; j < chars.length; j++) if (inWord[j]) return wordAt[j]
    return undefined
  }
  // Right to left, so "followed by" means: followed in the result (removals included). This makes it idempotent.
  const out: Array<string> = []
  for (let k = chars.length - 1; k >= 0; k--) {
    const c = chars[k]!
    if (inWord[k]) {
      out.push(c)
      continue
    }
    if (SPACE.test(c)) {
      out.push(" ")
      continue
    }
    const next = out.length === 0 ? "" : out[out.length - 1]!
    const atBreak = next === "" || next === " "
    let ignorable = false
    // A quote inside a word ("a`t", "kit“chen") is a mark, not a space that would split the word (round 5).
    if (QUOTES.has(c)) ignorable = !(k > 0 && inWord[k - 1]! && k + 1 < chars.length && inWord[k + 1]!)
    else if (TERMINAL.has(c)) ignorable = atBreak
    else if (c === ",") {
      const before = wordBefore(k)
      const after = wordAfter(k)
      ignorable = atBreak && !(before !== undefined && isNumericWord(before)) && !(after !== undefined && isNumericWord(after))
    } else if (DASH.test(c)) ignorable = k > 0 && inWord[k - 1]! && LETTER.test(chars[k - 1]!) && k + 1 < chars.length && inWord[k + 1]! && LETTER.test(chars[k + 1]!)
    out.push(ignorable ? " " : c)
  }
  return out.reverse().join("").replace(/\s+/gu, " ").trim()
}

/** A significant mark of a canonical text: a character that is neither part of a word nor a space. */
export interface Mark {
  readonly char: string
  /** Offset in the canonical text. */
  readonly start: number
}

/** An utterance read once: its canonical text, its words and its significant marks (offsets into the canonical text). */
export interface Utterance {
  readonly text: string
  readonly words: ReadonlyArray<Word>
  readonly marks: ReadonlyArray<Mark>
}

const marksOf = (text: string, ws: ReadonlyArray<Word>): Array<Mark> => {
  const out: Array<Mark> = []
  let w = 0
  for (let i = 0; i < text.length; i++) {
    while (w < ws.length && ws[w]!.end <= i) w++
    if (w < ws.length && ws[w]!.start <= i) continue
    const c = text[i]!
    if (!SPACE.test(c)) out.push({ char: c, start: i })
  }
  return out
}

// The last few utterances read: a turn reads the same text several times (plan, parser, interpretation).
const recent: Array<readonly [string, Utterance]> = []

/** Read an utterance (raw or canonical): canonical text, words, marks. Memoised for the last few texts. */
export const readUtterance = (raw: string): Utterance => {
  for (const [key, value] of recent) if (key === raw) return value
  const text = canonicalUtterance(raw)
  const ws = words(text)
  const u: Utterance = { text, words: ws, marks: marksOf(text, ws) }
  recent.unshift([raw, u])
  if (recent.length > 8) recent.pop()
  return u
}

/**
 * Whether two transcripts are the same for the intent path: equal canonical
 * texts. Used to promote a speculative intent turn ("yes" and "yes?", "5" and
 * "–5", ".5" and "5" are different; "Yes." and "Yes" are the same).
 */
export const sameUtterance = (a: string, b: string): boolean => a === b || canonicalUtterance(a) === canonicalUtterance(b)
