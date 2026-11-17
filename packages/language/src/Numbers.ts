import { numericSpans } from "@pva/core"
import { dict } from "./Dict.ts"
import type { Language } from "./Result.ts"
import type { Tok } from "./Tokens.ts"

/**
 * The numbers this package reads, one grammar per language, total over its input: a number phrase is exactly one number by the
 * language's rules, or it is not a number (review round 2, finding 23). Supported:
 * - digits: whole numbers 0 to 999 999 999, with at most six decimals ("2.5", "2,5"; "1,500" in English and "1.500" in Dutch are
 *   thousands, and each is no number in the other language);
 * - words: 0 to 999 999 ("twenty five", "two hundred and five", "a thousand", "vijfentwintig", "tweeduizend driehonderd",
 *   "vijf en twintig"), then optionally "point" / "komma" and one to six digit words ("two point five").
 * Anything else that looks like a number — "five five", "one thousand two thousand", "twenty thirty", "1e3", seven decimals,
 * ten digits, "million" — is not read, so a parser using it answers `not-understood`.
 */
export const maxWhole = 999_999_999
export const maxWordsWhole = 999_999
export const maxDecimals = 6

const enUnits = dict<number>({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
})
const enTens = dict<number>({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 })
const enDigitWords = dict<number>({ zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 })
const nlUnits = dict<number>({
  een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12,
  dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19
})
const nlTens = dict<number>({ twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90 })
const nlDigitWords = dict<number>({ nul: 0, een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 })
const nlSmallUnits: ReadonlyArray<string> = ["een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen"]

// ---- Dutch: a number is one written word (accents removed), or spaced parts that join into one ------------------------------------

/** 1–99: "zeven", "veertien", "twintig", "vijfentwintig", "eenentwintig". */
const nlBelow100 = (w: string): number | undefined => {
  const u = nlUnits[w]
  if (u !== undefined) return u
  const t = nlTens[w]
  if (t !== undefined) return t
  for (const unit of nlSmallUnits) {
    if (!w.startsWith(`${unit}en`)) continue
    const tens = nlTens[w.slice(unit.length + 2)]
    if (tens !== undefined) return nlUnits[unit]! + tens
  }
  return undefined
}
/** 1–999: below 100, or [unit] "honderd" [below 100]: "honderd", "tweehonderd", "honderdvijftig", "driehonderdvijfentwintig". */
const nlBelow1000 = (w: string): number | undefined => {
  const at = w.indexOf("honderd")
  if (at < 0) return nlBelow100(w)
  if (w.indexOf("honderd", at + 1) >= 0) return undefined
  const left = w.slice(0, at)
  const right = w.slice(at + 7)
  const l = left === "" ? 1 : nlUnits[left]
  if (l === undefined || l > 9) return undefined
  const r = right === "" ? 0 : nlBelow100(right)
  return r === undefined ? undefined : l * 100 + r
}
/** A Dutch whole number written as one word, 0 to 999 999, or `undefined`. "duizend" once, "honderd" at most once on each side of it. */
export const nlWholeWord = (w: string): number | undefined => {
  if (w === "nul") return 0
  if (w === "") return undefined
  const at = w.indexOf("duizend")
  if (at < 0) return nlBelow1000(w)
  if (w.indexOf("duizend", at + 1) >= 0) return undefined
  const left = w.slice(0, at)
  const right = w.slice(at + 7)
  const l = left === "" ? 1 : nlBelow1000(left)
  const r = right === "" ? 0 : nlBelow1000(right)
  return l === undefined || r === undefined ? undefined : l * 1000 + r
}

/** Spaced Dutch parts: number words and an "en" between two of them ("vijf en twintig"), joined and read as one word. */
const nlRead = (toks: ReadonlyArray<Tok>, i: number): NumberRead | undefined => {
  const isPart = (k: number) => toks[k] !== undefined && nlWholeWord(toks[k]!.norm) !== undefined
  if (!isPart(i)) return undefined
  let k = i + 1
  for (;;) {
    if (isPart(k)) { k++; continue }
    if (toks[k]?.norm === "en" && isPart(k + 1) && nlTens[toks[k + 1]!.norm] !== undefined) { k += 2; continue }
    break
  }
  // The longest run that reads as one number; a run that does not ("vijf vijf", "duizend duizend") reads as nothing.
  const joined = toks.slice(i, k).map((t) => t.norm).join("")
  const value = nlWholeWord(joined)
  if (value === undefined) return undefined
  if (k - i > 1 && toks[i]!.norm === "nul") return undefined
  return { value, next: k, digits: false }
}

// ---- English: a sequence of number words with a strict grammar ---------------------------------------------------------------------

const enBelow100 = (w: ReadonlyArray<string>): number | undefined => {
  if (w.length === 1) return enUnits[w[0]!] ?? enTens[w[0]!]
  if (w.length === 2) {
    const t = enTens[w[0]!]
    const u = enUnits[w[1]!]
    return t !== undefined && u !== undefined && u <= 9 ? t + u : undefined
  }
  return undefined
}
/** below 100 | (unit | "a" | "an") "hundred" [["and"] below 100]. */
const enBelow1000 = (w: ReadonlyArray<string>): number | undefined => {
  const h = w.indexOf("hundred")
  if (h < 0) return enBelow100(w)
  if (w.indexOf("hundred", h + 1) >= 0 || h !== 1) return undefined
  const lead = w[0]!
  const l = lead === "a" || lead === "an" ? 1 : enUnits[lead]
  if (l === undefined || l > 9) return undefined
  let rest = w.slice(h + 1)
  if (rest.length === 0) return l * 100
  if (rest[0] === "and") rest = rest.slice(1)
  const r = enBelow100(rest)
  return r === undefined ? undefined : l * 100 + r
}
/** below 1000 | (below 1000 | "a") "thousand" [["and"] below 1000]; "and" after "thousand" only before a part below 100. */
const enWhole = (w: ReadonlyArray<string>): number | undefined => {
  if (w.length === 1 && w[0] === "zero") return 0
  if (w.includes("zero")) return undefined
  const t = w.indexOf("thousand")
  if (t < 0) return w.length === 0 || w[0] === "and" ? undefined : enBelow1000(w)
  if (w.indexOf("thousand", t + 1) >= 0 || t === 0) return undefined
  const head = w.slice(0, t)
  const l = head.length === 1 && (head[0] === "a" || head[0] === "an") ? 1 : enBelow1000(head)
  if (l === undefined) return undefined
  let rest = w.slice(t + 1)
  if (rest.length === 0) return l * 1000
  let and = false
  if (rest[0] === "and") { and = true; rest = rest.slice(1) }
  const r = enBelow1000(rest)
  if (r === undefined || (and && r >= 100)) return undefined
  return l * 1000 + r
}

const enPart = (w: string | undefined): boolean => w !== undefined && (enUnits[w] !== undefined || enTens[w] !== undefined || w === "hundred" || w === "thousand" || w === "zero")

const enRead = (toks: ReadonlyArray<Tok>, i: number): NumberRead | undefined => {
  const first = toks[i]?.norm
  let k = i
  if ((first === "a" || first === "an") && (toks[i + 1]?.norm === "hundred" || toks[i + 1]?.norm === "thousand")) k++
  else if (!enPart(first)) return undefined
  for (;;) {
    const w = toks[k]?.norm
    if (enPart(w)) { k++; continue }
    // "and" joins only when a number word follows and a scale word came before: "two hundred and five".
    if (w === "and" && enPart(toks[k + 1]?.norm) && toks.slice(i, k).some((t) => t.norm === "hundred" || t.norm === "thousand")) { k++; continue }
    break
  }
  const words = toks.slice(i, k).map((t) => t.norm)
  const value = enWhole(words)
  return value === undefined ? undefined : { value, next: k, digits: false }
}

/**
 * A number written with digits: "250", "2.5", "2,5", "1,500" (English) and "1.500" (Dutch) for thousands in groups of three.
 * One separator followed by exactly three digits is a thousands separator in the language that writes it so and has no reading
 * in the other ("1.500" in English, "1,500" in Dutch: core's rule, `ValueParsing.ts`), so it is `undefined` there. More than
 * `maxDecimals` decimals or a whole part above `maxWhole` is `undefined` too: never a rounded or imprecise value.
 */
export const digitValue = (token: string, language: Language): number | undefined => {
  if (/^\d+$/.test(token)) {
    const v = Number(token)
    return v <= maxWhole ? v : undefined
  }
  const thousands = language === "en" ? "," : "."
  const decimal = language === "en" ? "." : ","
  const parts = token.split(thousands)
  if (parts.length > 1 && !token.includes(decimal) && /^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p))) {
    const v = Number(parts.join(""))
    return v <= maxWhole ? v : undefined
  }
  // One separator: a decimal, unless three digits follow it (a thousands separator of the other language).
  const one = /^(\d+)[.,](\d+)$/.exec(token)
  if (one === null || one[2]!.length === 3 || one[2]!.length > maxDecimals || Number(one[1]) > maxWhole) return undefined
  return Number(`${one[1]}.${one[2]}`)
}

export interface NumberRead {
  readonly value: number
  /** The index after the last word used. */
  readonly next: number
  readonly digits: boolean
}

/** After a whole number read in words: "point five", "point two five", "komma vijf" (one to six digit words). */
const decimals = (toks: ReadonlyArray<Tok>, n: NumberRead, language: Language): NumberRead | undefined => {
  const mark = toks[n.next]?.norm
  if (mark !== (language === "en" ? "point" : "komma")) return n
  const table = language === "en" ? enDigitWords : nlDigitWords
  let k = n.next + 1
  let digits = ""
  while (toks[k] !== undefined && table[toks[k]!.norm] !== undefined && !(language === "en" && toks[k]!.norm === "oh")) { digits += String(table[toks[k]!.norm]); k++ }
  if (digits === "" || digits.length > maxDecimals) return undefined
  return { value: Number(`${n.value}.${digits}`), next: k, digits: false }
}

/**
 * Read a whole number or a decimal at word `i`: digits ("7", "2,5") or number words ("twenty five", "vijfentwintig"). The number
 * words from `i` on are read as one phrase by the grammar above, all of them or none: "five five" and "one thousand two thousand"
 * are `undefined`, not 5 or 3000.
 */
export const readNumber = (toks: ReadonlyArray<Tok>, i: number, language: Language): NumberRead | undefined => {
  const t = toks[i]
  if (t === undefined) return undefined
  let read: NumberRead | undefined
  if (/^\d/.test(t.norm)) {
    const v = digitValue(t.norm, language)
    read = v === undefined ? undefined : { value: v, next: i + 1, digits: true }
  } else {
    const words = language === "en" ? enRead(toks, i) : nlRead(toks, i)
    read = words === undefined ? undefined : decimals(toks, words, language)
  }
  // "two million", "3 miljard": a scale beyond the supported range is not read as the number before it.
  return read !== undefined && largeScales.has(toks[read.next]?.norm ?? "") ? undefined : read
}

/** Scale words above what this package reads; a number followed by one is not read at all. */
export const largeScales: ReadonlySet<string> = new Set(["million", "millions", "billion", "billions", "trillion", "miljoen", "miljoenen", "miljard", "miljarden", "biljoen", "mln", "mrd"])

/** A character range of the text, `[start, end)`. */
export interface CharRange {
  readonly start: number
  readonly end: number
}

const glued = /[\/\p{N}]/u
const asciiDigit = /^\d/

/**
 * Core's atomic numeric-span rule (`ValueParsing.ts`, "THE RULE"), applied to what a parser read: every connected numeric expression
 * of `text` (a sign before it, a decimal mark, "and a half", "point five", spaced number words, "3-5", "five five" included) must lie
 * wholly inside one of the `ranges` the parser consumed, or wholly outside all of them. Also refused: a number of the ranges glued
 * to a "/" or to a digit character that is not 0–9 ("1/2", "2½"), and digits glued to letters glued to digits ("1e3", "3x4"; not the
 * clock spellings "19u30", "19h30").
 */
export const numbersWhole = (text: string, toks: ReadonlyArray<Tok>, ranges: ReadonlyArray<CharRange>): boolean => {
  const live = ranges.filter((r) => r.end > r.start)
  for (const span of numericSpans(text)) {
    const inside = live.some((r) => span.start >= r.start && span.end <= r.end)
    const outside = live.every((r) => span.end <= r.start || span.start >= r.end)
    if (!inside && !outside) return false
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!
    if (!asciiDigit.test(t.norm) || !live.some((r) => t.start >= r.start && t.end <= r.end)) continue
    if (glued.test(text[t.start - 1] ?? "") && !/\d/.test(text[t.start - 1]!)) return false
    if (text[t.start - 1] === "/" || text[t.end] === "/") return false
    if (glued.test(text[t.end] ?? "") && !/\d/.test(text[t.end]!)) return false
    if (/\p{L}/u.test(text[t.start - 1] ?? "")) {
      const prev = toks[k - 1]
      const clock = prev !== undefined && prev.end === t.start && (prev.norm === "u" || prev.norm === "h") && toks[k - 2] !== undefined && toks[k - 2]!.end === prev.start && /^\d+$/.test(toks[k - 2]!.norm)
      if (!clock) return false
    }
  }
  return true
}

/** "half", "a quarter", "three quarters", "een half", "driekwart" at word `k`. */
const fractionAt = (toks: ReadonlyArray<Tok>, k: number, language: Language): { value: number; next: number } | undefined => {
  const a = toks[k]?.norm
  const b = toks[k + 1]?.norm
  if (language === "en") {
    if ((a === "a" || a === "an") && (b === "half" || b === "quarter")) return { value: b === "half" ? 0.5 : 0.25, next: k + 2 }
    if (a === "half") return { value: 0.5, next: k + 1 }
    if (a === "quarter") return { value: 0.25, next: k + 1 }
    if (a === "three" && (b === "quarters" || b === "quarter")) return { value: 0.75, next: k + 2 }
    return undefined
  }
  if (a === "een" && (b === "half" || b === "halve")) return { value: 0.5, next: k + 2 }
  if (a === "een" && b === "kwart") return { value: 0.25, next: k + 2 }
  if (a === "half" || a === "halve") return { value: 0.5, next: k + 1 }
  if (a === "kwart") return { value: 0.25, next: k + 1 }
  if (a === "driekwart") return { value: 0.75, next: k + 1 }
  if (a === "drie" && b === "kwart") return { value: 0.75, next: k + 2 }
  return undefined
}

/**
 * An amount with spoken fractions at word `i`: "two", "2,5", "one and a half", "half", "a quarter", "three quarters",
 * "anderhalf", "twee en een half", "tweeënhalf", "driekwart". `article`: read a lone "a"/"an" (English) as 1.
 */
export const readAmount = (toks: ReadonlyArray<Tok>, i: number, language: Language, article = true): NumberRead | undefined => {
  const w = toks[i]?.norm
  if (w === undefined) return undefined
  if (language === "nl" && (w === "anderhalf" || w === "anderhalve")) return { value: 1.5, next: i + 1, digits: false }
  if (language === "nl") {
    const half = /^(.+)enhalf$/.exec(w)
    if (half !== null) {
      const n = nlWholeWord(half[1]!)
      return n === undefined || n < 1 ? undefined : { value: n + 0.5, next: i + 1, digits: false }
    }
  }
  const lead = fractionAt(toks, i, language)
  if (lead !== undefined) return { value: lead.value, next: lead.next, digits: false }
  const n = readNumber(toks, i, language)
  if (n === undefined) {
    if (article && language === "en" && (w === "a" || w === "an")) return { value: 1, next: i + 1, digits: false }
    return undefined
  }
  // N and a half / N en een half / N en half
  const k = n.next
  if ((toks[k]?.norm === "and" && language === "en") || (toks[k]?.norm === "en" && language === "nl")) {
    const f = fractionAt(toks, k + 1, language)
    if (f !== undefined && Number.isInteger(n.value)) {
      return { value: n.value + f.value, next: f.next, digits: n.digits }
    }
  }
  return n
}
