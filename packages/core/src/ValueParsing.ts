import type { ValueCandidate, ValueParser } from "./Decision.ts"
import {
  durationUnits,
  fractionWords,
  hundredWords,
  MINUTE,
  nlTens,
  nlUnits,
  nlUnitValue,
  nlWhole,
  scaleWords,
  SECOND,
  signWords,
  tens,
  units,
  unitWords
} from "./NumberWords.ts"
import { type Word, words } from "./TextMatching.ts"
import { DASH, MINUS, readUtterance } from "./Utterance.ts"

/**
 * Local parsing of numbers and durations for the typed-intent path
 * (docs/AGENTS-AND-INTENTS.md §3.5, "Review fixes, third round"), English and
 * Dutch. The decision model only chooses; values it cannot choose from a list
 * are found here.
 *
 * THE RULE. A connected numeric expression is consumed as ONE span: either the
 * whole span reads as exactly one value, or the whole span is one candidate
 * with value NaN (said as a number, accepted by no parameter, so it is asked
 * for again). The scanner never resumes inside a span and never offers a part
 * of one ("one hundred 40 percent" is invalid, never 40).
 *
 * Span (both languages). The parser reads the canonical text of the utterance
 * (`canonicalUtterance`, `Utterance.ts`: the one normalisation shared with core's
 * accounting and the promotion comparison). Words are those of `words()`; between
 * two words of a span there may be only spaces, at most one comma or dash (any
 * Unicode dash or minus), a "%" or "°" sign, or a "." / "," glued between two
 * digit groups. A sign of any dash kind written before the span, a decimal mark
 * glued before its first digit group (".5") and a "%" / "°" after it belong to it.
 *
 *   span      := [sign] item (item | unit | connector item | sign item)*
 *   item      := digits | number word | fraction word | article-before-number
 *   sign      := "-" | "−" | "﹣" | "－" (written, right before) | minus | negative | negatief | min (not after a numeral)
 *                any other dash written before ("‐", "‒", "–", "—", "―", "﹘"): the span has no reading (NaN)
 *   connector := and | en | point | komma | of            (only with a numeral after it)
 *   unit      := percent | procent | pct | % | degree(s) | graad | graden | °  (number units: the candidate's `unit`)
 *              | second(s) sec(s) seconde(n) minute(s) min(s) minuut minuten hour(s) hr(s) uur uren kwartier
 *   article-before-number := a | an | een, right before hundred/scale, half, quarter/kwart(ier) or a unit;
 *                            "één" always
 *
 * Reading a span as a NUMBER (spans containing a duration unit are durations,
 * not numbers, and are skipped):
 *
 *   number    := [sign] value [number-unit | "%"]
 *   value     := digits ["." | "," digits]          one separator: decimal, except exactly three digits
 *                                                   after it ("1,000"/"1.000": thousands in one language,
 *                                                   decimal in the other: NaN); two or more separators: NaN
 *              | English  "twenty one", "twenty-one", "one hundred (and) forty", "nineteen hundred",
 *                         "two thousand five hundred and twelve", "a hundred", "<n> and a half", "<n> point <digits>"
 *              | Dutch    one word of any size ("honderdveertig", "tweeduizenddriehonderd", "tweeënhalf"),
 *                         spaced ("honderd veertig", "twee duizend"), "vijf en twintig", "<n> en een half",
 *                         "<n> komma <cijfers>", "anderhalf"
 *              | half | halve | a/een half (0.5) | quarter | kwart | a/een quarter/kwart (0.25)
 *
 *   The value words must be consumed completely by that grammar; anything left
 *   over makes the whole span NaN: "one hundred 40", "one point twenty five"
 *   (after point/komma only single digit words or one digit group), "five five",
 *   "3 and 5", "3-5", "3 - 5", "five minus three", "40 percent 5", "1.234,5".
 *   A unit word must be the last word; a sign only the first.
 *
 * Reading a span as a DURATION (spans without a duration unit are skipped):
 *
 *   duration  := [sign] part ([and | en] part)*
 *   part      := number [and a half | en een half | en half] unit [and a half | en een half]
 *              | a/an/een unit | anderhalf/anderhalve unit | <n>enhalf unit
 *              | (een) kwartier | half an hour | (een) half uur | a quarter of an hour
 *
 *   Parts must cover the span exactly; a number unit or an inner sign makes it NaN.
 *   A sign makes the duration negative, which no duration parameter accepts.
 *
 * A leading decimal mark (".5 percent") reads 0.5 before one digit group that is not all zeros, else NaN.
 * A number unit is carried on the candidate (`unit`: "percent" | "degree"); a
 * parameter takes a number only with no unit or its own unit (`unitFits`).
 *
 * Candidates carry their character offsets. Numbers with a unit come first,
 * then the rest in order of appearance; durations in order of appearance.
 * Pure; microseconds per sentence.
 */

interface Parsed {
  readonly value: number
  /** Words consumed. */
  readonly length: number
}

/** One word of a number phrase. */
type Atom =
  | { readonly kind: "digits"; readonly value: number }
  /** Below 100; `tens`: an English tens word that a unit may follow ("forty five"). */
  | { readonly kind: "small"; readonly value: number; readonly tens: boolean }
  | { readonly kind: "hundred" }
  | { readonly kind: "scale"; readonly value: number }
  /** A Dutch number of 100 or more written as one word ("honderdveertig"). */
  | { readonly kind: "whole"; readonly value: number }

/**
 * Word `i` as part of a number. `"een"` / `"a"` / `"an"` are 1 only right before
 * "hundred" or a scale word, and "een" also where `article` allows it or written
 * "één" (it is also the Dutch article).
 */
const atomAt = (text: string, ws: ReadonlyArray<Word>, i: number, article: boolean): Atom | undefined => {
  const w = ws[i]
  if (w === undefined) return undefined
  const n = w.norm
  if (/^\d+$/.test(n)) return { kind: "digits", value: Number(n) }
  if (n in units) return { kind: "small", value: units[n]!, tens: false }
  if (n in tens) return { kind: "small", value: tens[n]!, tens: true }
  if (hundredWords.has(n)) return { kind: "hundred" }
  if (n in scaleWords) return { kind: "scale", value: scaleWords[n]! }
  const beforeScale = ws[i + 1] !== undefined && (hundredWords.has(ws[i + 1]!.norm) || ws[i + 1]!.norm in scaleWords)
  if (n === "a" || n === "an") return beforeScale ? { kind: "small", value: 1, tens: false } : undefined
  if (n === "een") return article || beforeScale || /^één$/i.test(text.slice(w.start, w.end)) ? { kind: "small", value: 1, tens: false } : undefined
  const whole = nlWhole(n)
  if (whole === undefined) return undefined
  return whole < 100 && Number.isInteger(whole) ? { kind: "small", value: whole, tens: false } : { kind: "whole", value: whole }
}

const digitWords: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  nul: "0", een: "1", twee: "2", drie: "3", vier: "4", vijf: "5", zes: "6", zeven: "7", acht: "8", negen: "9"
}

/**
 * A number starting at word `i`, read as a whole so that no part of it is ever
 * offered on its own ("one hundred forty" is 140, never 100 and 40):
 *
 * - digits: "40", "21.5" / "21,5" (decimal: two digit words with nothing but the
 *   separator between). "1,000" / "1.000" (three digits after the separator) is
 *   a thousands separator in one language and a decimal point in the other: it
 *   is returned whole with value NaN, which no parameter accepts, so it is asked for;
 * - English: "twenty one", "one hundred and forty", "nineteen hundred", "two
 *   thousand five hundred", "three million"; "a hundred";
 * - Dutch: one word of any size ("honderdveertig", "tweehonderd",
 *   "tweeduizenddriehonderd"), or spaced ("honderd veertig", "twee duizend"),
 *   "vijf en twintig"; "anderhalf" (1.5), "tweeënhalf" (2.5);
 * - "<n> and a half", "<n> en een half" (+0.5); "<n> point five", "<n> komma vijf".
 */
const numberAt = (text: string, ws: ReadonlyArray<Word>, i: number, article = false): Parsed | undefined => {
  const w = ws[i]
  if (w === undefined) return undefined
  if (w.norm === "anderhalf" || w.norm === "anderhalve") return { value: 1.5, length: 1 }
  const next = ws[i + 1]
  if (/^\d+$/.test(w.norm) && next !== undefined && /^\d+$/.test(next.norm)) {
    const between = text.slice(w.end, next.start)
    if (between === "." || between === ",") {
      if (next.norm.length !== 3 || w.norm === "0" || w.norm.length > 3) return { value: Number(`${w.norm}.${next.norm}`), length: 2 }
      // "1,000" / "1.000" / "1,000,000": ambiguous; the whole run is one value that no parameter takes.
      let j = i + 2
      while (ws[j] !== undefined && /^\d{3}$/.test(ws[j]!.norm) && /^[.,]$/.test(text.slice(ws[j - 1]!.end, ws[j]!.start))) j++
      return { value: Number.NaN, length: j - i }
    }
  }
  let total = 0
  let chunk = 0 // below 1000, since the last scale word
  let group: number | undefined // below 100, not yet added to `chunk`
  let hundredInChunk = false
  let lastScale = Number.POSITIVE_INFINITY
  let prev: "start" | "small" | "tens" | "digits" | "hundred" | "scale" | "closed" = "start"
  let j = i
  for (;;) {
    let atom = atomAt(text, ws, j, article && j === i)
    let skip = 0
    // "one hundred and forty", "honderd en vijf", "two thousand and one", "vijf en twintig".
    if (atom === undefined && is(ws, j, "and", "en")) {
      const after = atomAt(text, ws, j + 1, false)
      const afterHundred = (prev === "hundred" || prev === "scale") && after?.kind === "small"
      const dutchTens = prev === "small" && group !== undefined && group >= 1 && group <= 9 && is(ws, j - 1, ...Object.keys(nlUnitValue)) &&
        after?.kind === "small" && is(ws, j + 1, ...Object.keys(nlTens))
      if (afterHundred || dutchTens) {
        atom = after
        skip = 1
        if (dutchTens) {
          group = group! + (after as { value: number }).value
          prev = "closed"
          j += 2
          continue
        }
      }
    }
    if (atom === undefined) break
    let ok = true
    switch (atom.kind) {
      case "digits":
        if (prev !== "start") ok = false
        else {
          group = atom.value
          prev = "digits"
        }
        break
      case "small":
        if (prev === "start" || prev === "hundred" || prev === "scale") {
          group = atom.value
          prev = atom.tens ? "tens" : "small"
        } else if (prev === "tens" && !atom.tens && atom.value >= 1 && atom.value <= 9 && ws[j]!.norm in units) {
          group = group! + atom.value
          prev = "small"
        } else ok = false
        break
      case "hundred":
        if (hundredInChunk || chunk !== 0 || !(prev === "start" || prev === "small" || prev === "tens" || prev === "digits")) ok = false
        else {
          chunk = (group ?? 1) * 100
          group = undefined
          hundredInChunk = true
          prev = "hundred"
        }
        break
      case "scale": {
        const amount = chunk + (group ?? 0)
        if (atom.value >= lastScale || (prev !== "start" && amount === 0) || prev === "scale") ok = false
        else {
          total += (prev === "start" ? 1 : amount) * atom.value
          chunk = 0
          group = undefined
          hundredInChunk = false
          lastScale = atom.value
          prev = "scale"
        }
        break
      }
      case "whole":
        if (!(prev === "start" || (prev === "scale" && atom.value < lastScale))) ok = false
        else if (atom.value >= 1000) {
          total += atom.value
          lastScale = atom.value >= 1e9 ? 1e9 : atom.value >= 1e6 ? 1e6 : 1e3
          prev = "scale"
        } else {
          chunk = atom.value
          hundredInChunk = true
          // "tweehonderd veertig" may go on with a small number; "honderdveertig" only with a scale word.
          prev = Number.isInteger(atom.value) && atom.value % 100 === 0 ? "hundred" : "closed"
        }
        break
    }
    if (!ok) break
    j += 1 + skip
  }
  if (j === i) return undefined
  let value = total + chunk + (group ?? 0)
  // "two and a half", "twee en een half"
  const half = is(ws, j, "and") && is(ws, j + 1, "a") && is(ws, j + 2, "half") ? 3
    : is(ws, j, "en") && is(ws, j + 1, "een") && is(ws, j + 2, "half") ? 3
    : 0
  if (half > 0 && Number.isInteger(value)) return { value: value + 0.5, length: j - i + half }
  // "twenty one point five", "eenentwintig komma vijf"
  if (is(ws, j, "point", "komma") && Number.isInteger(value)) {
    let digits = ""
    let k = j + 1
    for (; ws[k] !== undefined; k++) {
      const d = /^\d+$/.test(ws[k]!.norm) && digits === "" ? ws[k]!.norm : digitWords[ws[k]!.norm]
      if (d === undefined) break
      digits += d
      if (/^\d{2,}$/.test(ws[k]!.norm)) {
        k++
        break
      }
    }
    if (digits !== "") return { value: Number(`${value}.${digits}`), length: k - i }
  }
  return { value, length: j - i }
}

const is = (ws: ReadonlyArray<Word>, i: number, ...options: ReadonlyArray<string>) => ws[i] !== undefined && options.includes(ws[i]!.norm)

/** One duration part starting at word `i` ("ten minutes", "an hour and a half", "anderhalf uur", "een kwartier"). */
const durationPartAt = (text: string, ws: ReadonlyArray<Word>, i: number): Parsed | undefined => {
  // Fixed phrases first.
  if (is(ws, i, "anderhalf", "anderhalve") && ws[i + 1]?.norm !== undefined && durationUnits[ws[i + 1]!.norm] !== undefined) {
    return { value: 1.5 * durationUnits[ws[i + 1]!.norm]!, length: 2 }
  }
  if (is(ws, i, "kwartier")) return { value: 15 * MINUTE, length: 1 }
  if (is(ws, i, "een", "a", "an") && is(ws, i + 1, "kwartier")) return { value: 15 * MINUTE, length: 2 }
  if (is(ws, i, "half") && is(ws, i + 1, "an", "a") && is(ws, i + 2, "hour")) return { value: 30 * MINUTE, length: 3 }
  if (is(ws, i, "half") && is(ws, i + 1, "uur")) return { value: 30 * MINUTE, length: 2 }
  if (is(ws, i, "een") && is(ws, i + 1, "half") && is(ws, i + 2, "uur")) return { value: 30 * MINUTE, length: 3 }
  if (is(ws, i, "a", "an") && is(ws, i + 1, "quarter") && is(ws, i + 2, "of") && is(ws, i + 3, "an", "a") && is(ws, i + 4, "hour")) {
    return { value: 15 * MINUTE, length: 5 }
  }
  // "<n>enhalf uur" (tweeënhalf uur)
  const half = ws[i] === undefined ? null : /^(een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien)enhalf$/.exec(ws[i]!.norm)
  if (half !== null && ws[i + 1] !== undefined && durationUnits[ws[i + 1]!.norm] !== undefined) {
    return { value: (nlUnitValue[half[1]!]! + 0.5) * durationUnits[ws[i + 1]!.norm]!, length: 2 }
  }
  // "<number> [and a half | en een half | enhalf] <unit> [and a half | en een half]"
  const n = numberAt(text, ws, i, true) ?? (is(ws, i, "a", "an") ? { value: 1, length: 1 } : undefined)
  if (n === undefined) return undefined
  let j = i + n.length
  let value = n.value
  const halfAt = (k: number): number =>
    is(ws, k, "and") && is(ws, k + 1, "a") && is(ws, k + 2, "half") ? 3
    : is(ws, k, "en") && is(ws, k + 1, "een") && is(ws, k + 2, "half") ? 3
    : is(ws, k, "en") && is(ws, k + 1, "half") ? 2
    : 0
  const before = halfAt(j)
  if (before > 0) {
    value += 0.5
    j += before
  }
  const unit = ws[j] === undefined ? undefined : durationUnits[ws[j]!.norm]
  if (unit === undefined) return undefined
  j++
  if (before === 0) {
    const after = halfAt(j)
    if (after > 0) {
      value += 0.5
      j += after
    }
  }
  return { value: value * unit, length: j - i }
}

// ---------------------------------------------------------------------------
// Spans: one connected numeric expression is read whole, or not at all.

/** Words before which "a", "an" and "een" are part of a number ("a hundred", "een half uur", "an hour", "een procent"). */
const takesArticle = (n: string): boolean =>
  hundredWords.has(n) || n in scaleWords || n === "half" || n === "halve" || n === "quarter" || n === "kwart" || n === "kwartier" ||
  unitWords.has(n) || n in durationUnits

type TokenClass = "numeral" | "numberUnit" | "durationUnit" | "sign" | "connector"

/** What word `i` is in a numeric expression, or undefined (it ends one). */
const classify = (text: string, ws: ReadonlyArray<Word>, i: number, afterNumeral: boolean): TokenClass | undefined => {
  const w = ws[i]
  if (w === undefined) return undefined
  const n = w.norm
  if (/^\d+$/.test(n)) return "numeral"
  if (n === "a" || n === "an" || n === "een") {
    if (n === "een" && /^één$/i.test(text.slice(w.start, w.end))) return "numeral"
    const next = ws[i + 1]?.norm
    return next !== undefined && takesArticle(next) ? "numeral" : undefined
  }
  if (n in units || n in tens || hundredWords.has(n) || n in scaleWords || fractionWords.has(n)) return "numeral"
  if (/^(een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien)enhalf$/.test(n)) return "numeral"
  if (nlWhole(n) !== undefined) return "numeral"
  if (unitWords.has(n)) return afterNumeral ? "numberUnit" : undefined
  if (n === "kwartier") return "durationUnit" // a duration on its own ("een kwartier", "kwartier")
  if (n === "min") return afterNumeral ? "durationUnit" : "sign" // "10 min" is a unit, "min vijf" a sign
  if (n in durationUnits) return afterNumeral ? "durationUnit" : undefined
  if (signWords.has(n)) return "sign"
  if (n === "and" || n === "en" || n === "point" || n === "komma" || n === "of") return "connector"
  return undefined
}

const DASH_IN_GAP = new RegExp(`^\\s*[%°]?\\s*(?:,|${DASH.source})?\\s*$`, "u")

/** The text between words `j` and `k` keeps them in one expression: spaces, at most one comma or dash, a percent or degree sign, or a separator between digits. */
const connected = (text: string, ws: ReadonlyArray<Word>, j: number, k: number): boolean => {
  const gap = text.slice(ws[j]!.end, ws[k]!.start)
  return DASH_IN_GAP.test(gap) || (/^[.,]$/.test(gap) && /^\d+$/.test(ws[j]!.norm) && /^\d+$/.test(ws[k]!.norm))
}

/** A number unit, as core reads it: the spoken unit word or sign of a span. */
export type NumberUnit = "percent" | "degree"

/** One connected numeric expression: words `[from, to)` and characters `[start, end)`, its sign, a leading decimal mark and a trailing "%" or "°" included. */
export interface NumericSpan {
  readonly from: number
  readonly to: number
  readonly start: number
  readonly end: number
  /** The number unit said with it (a unit word or "%"/"°"), if any. Durations have none. */
  readonly unit?: NumberUnit
}

/** What is written right before word `i`: a leading decimal mark (".5", ",5") and a sign of any dash kind ("-5", "–5", "- .5"). */
interface Prefix {
  readonly start: number
  /** "minus": "-", "−", "﹣", "－"; "dash": any other dash (unreadable: the number becomes NaN). */
  readonly sign?: "minus" | "dash"
  readonly decimal: boolean
}

const ALNUM = /[\p{L}\p{N}]/u

/**
 * The prefix of word `i`. A decimal mark counts only glued to a digit group and not after a
 * letter or digit ("to .5", not "1.5"); a dash only when not glued to a letter or digit
 * before it ("-5", "- 5", "to –5"; not "covid-19", not "3-5" where the dash joins two numbers).
 */
const prefixOf = (text: string, ws: ReadonlyArray<Word>, i: number): Prefix => {
  let start = ws[i]!.start
  let decimal = false
  const mark = text[start - 1]
  if ((mark === "." || mark === ",") && /^\d+$/.test(ws[i]!.norm) && !ALNUM.test(text[start - 2] ?? "")) {
    decimal = true
    start--
  }
  let k = start - 1
  while (k >= 0 && /\s/u.test(text[k]!)) k--
  const c = text[k]
  if (c === undefined || !DASH.test(c) || ALNUM.test(text[k - 1] ?? "")) return { start, decimal }
  return { start: k, sign: MINUS.test(c) ? "minus" : "dash", decimal }
}

/** After word `i` (a sign or a connector), connected, a numeral follows, possibly after more signs or "point"/"komma" ("minus minus five", "point five"). */
const leadsToNumeral = (text: string, ws: ReadonlyArray<Word>, i: number): boolean => {
  for (let k = i; ws[k + 1] !== undefined && connected(text, ws, k, k + 1); k++) {
    const next = classify(text, ws, k + 1, false)
    if (next === "numeral") return true
    if (next !== "sign" && !is(ws, k + 1, "point", "komma")) return false
  }
  return false
}

const numberUnitOf: Readonly<Record<string, NumberUnit>> = {
  percent: "percent", procent: "percent", pct: "percent", degree: "degree", degrees: "degree", graad: "degree", graden: "degree"
}

/** The unit of a span: a "%" / "°" after a word of it, or a unit word in it (the reading checks where). */
const unitOfSpan = (text: string, ws: ReadonlyArray<Word>, from: number, to: number, end: number): NumberUnit | undefined => {
  for (let j = from; j < to; j++) {
    const unit = numberUnitOf[ws[j]!.norm]
    if (unit !== undefined && j > from) return unit
    const after = text.slice(ws[j]!.end, j + 1 < to ? ws[j + 1]!.start : end)
    if (after.includes("%")) return "percent"
    if (after.includes("°")) return "degree"
  }
  return undefined
}

/**
 * Every numeric expression of the text, in order. Pure; linear in the number of words.
 * Offsets are into `text` as given (the value parser gives it the canonical text).
 */
export const numericSpans = (text: string, ws: ReadonlyArray<Word> = words(text)): Array<NumericSpan> => {
  const out: Array<NumericSpan> = []
  let i = 0
  while (i < ws.length) {
    const first = classify(text, ws, i, false)
    const startsHere = first === "numeral" || (first === "durationUnit" && ws[i]!.norm === "kwartier") ||
      ((first === "sign" || is(ws, i, "point", "komma")) && leadsToNumeral(text, ws, i))
    if (!startsHere) {
      i++
      continue
    }
    let last = i // last word that is part of the expression
    let k = i + 1
    while (k < ws.length && connected(text, ws, k - 1, k)) {
      // A unit belongs to the expression right after a numeral or another unit.
      const cls = classify(text, ws, k, last === k - 1)
      if (cls === "numeral" || cls === "numberUnit" || cls === "durationUnit") {
        last = k
        k++
        continue
      }
      // A sign or a connector belongs to the expression only when a numeral follows it.
      if ((cls === "sign" || cls === "connector") && leadsToNumeral(text, ws, k)) {
        k++
        continue
      }
      break
    }
    // Words between `last` and `k` (a dangling connector) are not part of it.
    const start = prefixOf(text, ws, i).start
    const sign = /^\s*[%°]/u.exec(text.slice(ws[last]!.end))
    const end = ws[last]!.end + (sign?.[0].length ?? 0)
    const unit = unitOfSpan(text, ws, i, last + 1, end)
    out.push({ from: i, to: last + 1, start, end, ...(unit !== undefined ? { unit } : {}) })
    i = last + 1
  }
  return out
}

/** The text between two consecutive words of an expression is allowed where it is ("21.5"), or the reading fails. */
const gapsValid = (text: string, ws: ReadonlyArray<Word>, from: number, to: number): boolean => {
  for (let j = from; j + 1 < to; j++) {
    const gap = text.slice(ws[j]!.end, ws[j + 1]!.start).trim()
    if (gap === "") continue
    const a = ws[j]!.norm
    const b = ws[j + 1]!.norm
    // "twenty-one" (a hyphen between letters is removed by the canonical text; kept here for raw text).
    // Glued on both sides only: "seventy- five", "seventy ‑five" have a dash glued to one word (round 5).
    if (/^[\-‐‑]$/.test(gap) && text.slice(ws[j]!.end, ws[j + 1]!.start) === gap && a in tens && b in units && units[b]! >= 1 && units[b]! <= 9) continue
    if (/^[.,]$/.test(gap) && /^\d+$/.test(a) && /^\d+$/.test(b) && text.slice(ws[j]!.end, ws[j + 1]!.start) === gap) continue
    return false
  }
  return true
}

/** The value of number words `[from, to)` read as one number, or NaN when they are not exactly one. */
const numberValue = (text: string, ws: ReadonlyArray<Word>, from: number, to: number): number => {
  const length = to - from
  const at = (k: number) => ws[from + k]!.norm
  if (length === 1 && (at(0) === "half" || at(0) === "halve")) return 0.5
  if (length === 1 && (at(0) === "quarter" || at(0) === "kwart")) return 0.25
  if (length === 2 && (at(0) === "a" || at(0) === "een") && (at(1) === "half" || at(1) === "halve")) return 0.5
  if (length === 2 && (at(0) === "a" || at(0) === "een") && (at(1) === "quarter" || at(1) === "kwart")) return 0.25
  // A run of digit groups with two or more separators ("1.234,5", "1,000,000", "1.2.3") has no single reading.
  let separators = 0
  for (let j = from; j + 1 < to; j++) if (/^[.,]$/.test(text.slice(ws[j]!.end, ws[j + 1]!.start))) separators++
  if (separators > 1) return Number.NaN
  const parsed = numberAt(text, ws, from, true)
  return parsed === undefined || parsed.length !== length ? Number.NaN : parsed.value
}

/** The value of duration words `[from, to)`, in milliseconds, or NaN when they are not exactly one duration. */
const durationValue = (text: string, ws: ReadonlyArray<Word>, from: number, to: number): number => {
  let j = from
  let total = 0
  let parts = 0
  while (j < to) {
    if (parts > 0 && is(ws, j, "and", "en")) j++
    const part = durationPartAt(text, ws, j)
    if (part === undefined || j + part.length > to) return Number.NaN
    total += part.value
    j += part.length
    parts++
  }
  return parts === 0 ? Number.NaN : Math.round(total)
}

/** A span read as `kind`: its candidate (value NaN when it cannot be read whole), or undefined when it is the other kind. */
const readSpan = (text: string, ws: ReadonlyArray<Word>, span: NumericSpan, kind: "number" | "duration"): ValueCandidate | undefined => {
  let from = span.from
  const prefix = prefixOf(text, ws, span.from)
  let negative = prefix.sign !== undefined
  // A dash that is not a minus ("–5", "—5"): said as a number, but no single reading.
  let unreadable = prefix.sign === "dash"
  if (signWords.has(ws[from]!.norm) || ws[from]!.norm === "min") {
    if (negative || prefix.decimal) unreadable = true
    negative = true
    from++
  }
  let durationUnit = false
  let numberUnit = span.unit !== undefined
  for (let j = from; j < span.to; j++) {
    const cls = classify(text, ws, j, j > from)
    if (cls === "durationUnit") durationUnit = true
    if (cls === "numberUnit") numberUnit = true
  }
  const candidate = (value: number): ValueCandidate => ({
    text: text.slice(span.start, span.end),
    value: unreadable || Number.isNaN(value) ? Number.NaN : (negative ? -1 : 1) * value,
    start: span.start,
    end: span.end,
    ...(kind === "number" && span.unit !== undefined ? { unit: span.unit } : {})
  })
  if (kind === "duration") {
    if (!durationUnit) return undefined // a number, not a duration
    if (numberUnit || prefix.decimal || !gapsValid(text, ws, from, span.to)) return candidate(Number.NaN)
    // A sign inside the expression ("ten minutes minus five") has no single reading.
    for (let j = from; j < span.to; j++) if (classify(text, ws, j, j > from) === "sign") return candidate(Number.NaN)
    return candidate(durationValue(text, ws, from, span.to))
  }
  if (durationUnit) return undefined // a duration, not a number
  // [sign] number [unit]: one unit word, last, or a "%"/"°" right after the number.
  let to = span.to
  if (unitWords.has(ws[to - 1]!.norm)) to--
  let valid = to > from && gapsValid(text, ws, from, span.to)
  for (let j = from; j < to && valid; j++) {
    const cls = classify(text, ws, j, j > from)
    if (cls === "numberUnit" || cls === "sign") valid = false
  }
  // Exactly one unit: a sign inside the expression ("40% 5", "40 % percent") or after a unit word has no single reading.
  for (let j = from; j + 1 < span.to && valid; j++) if (/[%°]/u.test(text.slice(ws[j]!.end, ws[j + 1]!.start))) valid = false
  if (to !== span.to && /[%°]/u.test(text.slice(ws[span.to - 1]!.end, span.end))) valid = false // "40 percent %"
  if (!valid) return candidate(Number.NaN)
  // ".5": a leading decimal mark is read only before one digit group ("to .5 percent" is 0.5, asked again if out of range).
  // Only zeros after it (",0", ".00") is no way to say 0 (round 5: a cut-off "71,0" must not read as 0).
  if (prefix.decimal) return candidate(to - from === 1 && /^\d*[1-9]\d*$/.test(ws[from]!.norm) ? Number(`0.${ws[from]!.norm}`) : Number.NaN)
  return candidate(numberValue(text, ws, from, to))
}

/**
 * The value parser handed to `buildDecisionPlan` (and used by generated action tools for durations).
 * It reads `canonicalUtterance(utterance)` (the plan passes the canonical text already); offsets are
 * into that text. Numbers carry the unit said with them (`unit`).
 */
export const parseValues: ValueParser = (kind, utterance) => {
  const { text, words: ws } = readUtterance(utterance)
  const withUnit: Array<ValueCandidate> = []
  const plain: Array<ValueCandidate> = []
  for (const span of numericSpans(text, ws)) {
    const read = readSpan(text, ws, span, kind)
    if (read === undefined) continue
    if (read.unit !== undefined) withUnit.push(read)
    else plain.push(read)
  }
  // Durations in order of appearance; numbers with a unit (percent, degrees, …) first.
  return kind === "number" ? [...withUnit, ...plain] : [...plain, ...withUnit]
}

/**
 * The parameter unit a spoken unit fits, by closed aliases: "percent", "%", "procent", "pct",
 * "percentage" → percent; "degree(s)", "°", "graad", "graden", "celsius", "°c" → degree. Any
 * other declared unit ("lux", "ms") is compared as written, so no spoken unit fits it.
 */
const unitAliases: Readonly<Record<string, NumberUnit>> = {
  percent: "percent", "%": "percent", procent: "percent", pct: "percent", percentage: "percent", "per cent": "percent",
  degree: "degree", degrees: "degree", "°": "degree", graad: "degree", graden: "degree", celsius: "degree", "°c": "degree",
  "degrees celsius": "degree", "graden celsius": "degree"
}
export const paramUnit = (declared: string | undefined): string | undefined => {
  if (declared === undefined) return undefined
  const key = declared.trim().toLowerCase().replace(/\s+/g, " ")
  return unitAliases[key] ?? key
}

/**
 * A number said with `said` (a unit core read, or none) may be a value of a parameter with the
 * `declared` unit: only when no unit was said, or the units are the same by `paramUnit`.
 * "40 degrees" is not a brightness in percent; "40 percent" is not a value of a parameter without a unit.
 */
export const unitFits = (declared: string | undefined, said: string | undefined): boolean =>
  said === undefined || paramUnit(declared) === said

/** A duration given as text by a conversational agent's tool call ("10 minutes", "PT10M" is not supported): milliseconds, or undefined. */
export const parseDuration = (text: string): number | undefined => {
  const found = parseValues("duration", text)
  if (found.length > 0) return found.length === 1 && found[0]!.value >= 0 ? found[0]!.value : undefined
  if (numericSpans(readUtterance(text).text).length > 1) return undefined
  const n = Number(text.trim())
  return Number.isFinite(n) && n >= 0 ? n * SECOND : undefined
}
