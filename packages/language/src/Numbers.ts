import { numericSpans } from "@pva/core"
import { dict } from "./Dict.ts"
import type { Language } from "./Result.ts"
import type { Tok } from "./Tokens.ts"

const enUnits = dict<number>({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
})
const enTens = dict<number>({ twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 })
const nlUnits = dict<number>({
  nul: 0, een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10, elf: 11, twaalf: 12,
  dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19
})
const nlTens = dict<number>({ twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90 })
const nlCompound = new RegExp(`^(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(${Object.keys(nlTens).join("|")})$`)

/** A Dutch number written as one word, accents already removed: "zeven", "vijfentwintig", "honderdvijftig", "tweeenhalf" (2.5). */
export const nlWord = (w: string): number | undefined => {
  if (w in nlUnits) return nlUnits[w]
  if (w in nlTens) return nlTens[w]
  const c = nlCompound.exec(w)
  if (c !== null) return nlUnits[c[1]!]! + nlTens[c[2]!]!
  const half = /^(.+)enhalf$/.exec(w)
  if (half !== null) {
    const n = nlWord(half[1]!)
    return n === undefined || !Number.isInteger(n) ? undefined : n + 0.5
  }
  for (const [word, scale] of [["miljoen", 1e6], ["duizend", 1e3], ["honderd", 100]] as const) {
    const at = w.indexOf(word)
    if (at < 0) continue
    const left = w.slice(0, at)
    const right = w.slice(at + word.length)
    const l = left === "" ? 1 : nlWord(left)
    const r = right === "" ? 0 : nlWord(right)
    if (l === undefined || r === undefined || !Number.isInteger(l) || !Number.isInteger(r) || l < 1 || r >= scale || l >= (scale === 100 ? 100 : 1000)) return undefined
    return l * scale + r
  }
  return undefined
}

/**
 * A number written with digits: "250", "2.5", "2,5", "1,500" (English) and "1.500" (Dutch) for thousands in groups of three.
 * One separator followed by exactly three digits is a thousands separator in the language that writes it so and has no reading
 * in the other ("1.500" in English, "1,500" in Dutch: core's rule, `ValueParsing.ts`), so it is `undefined` there.
 */
export const digitValue = (token: string, language: Language): number | undefined => {
  if (/^\d+$/.test(token)) return Number(token)
  const thousands = language === "en" ? "," : "."
  const decimal = language === "en" ? "." : ","
  const parts = token.split(thousands)
  if (parts.length > 1 && !token.includes(decimal) && /^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p))) return Number(parts.join(""))
  // One separator: a decimal, unless three digits follow it (a thousands separator of the other language).
  const one = /^(\d+)[.,](\d+)$/.exec(token)
  if (one === null || one[2]!.length === 3) return undefined
  return Number(`${one[1]}.${one[2]}`)
}

export interface NumberRead {
  readonly value: number
  /** The index after the last word used. */
  readonly next: number
  readonly digits: boolean
}

type Kind = "unit" | "teen" | "tens" | "hundred" | "thousand"

const enRead = (toks: ReadonlyArray<Tok>, i: number): NumberRead | undefined => {
  let total = 0
  let current = 0
  let k = i
  let last: Kind | undefined
  let any = false
  const first = toks[k]?.norm
  if ((first === "a" || first === "an") && (toks[k + 1]?.norm === "hundred" || toks[k + 1]?.norm === "thousand")) {
    current = 1
    last = "unit"
    any = true
    k++
  }
  const fresh = () => last === undefined || last === "hundred" || last === "thousand"
  for (; k < toks.length; k++) {
    const w = toks[k]!.norm
    if (w === "and" && (last === "hundred" || last === "thousand")) {
      const peek = toks[k + 1]?.norm
      if (peek !== undefined && (peek in enUnits || peek in enTens) && enUnits[peek] !== 0) continue
      break
    }
    if (w in enUnits) {
      const v = enUnits[w]!
      if (v === 0) {
        if (any) break
        return { value: 0, next: k + 1, digits: false }
      }
      if (v < 10) {
        if (!(fresh() || last === "tens")) break
        current += v
        last = "unit"
      } else {
        if (!fresh()) break
        current += v
        last = "teen"
      }
    } else if (w in enTens) {
      if (!fresh()) break
      current += enTens[w]!
      last = "tens"
    } else if (w === "hundred") {
      if (!(last === "unit" || last === "teen" || last === "tens") || current >= 100 || current === 0) break
      current *= 100
      last = "hundred"
    } else if (w === "thousand") {
      if (!(last === "unit" || last === "teen" || last === "tens" || last === "hundred") || current === 0) break
      total += current * 1000
      current = 0
      last = "thousand"
    } else break
    any = true
  }
  if (!any) return undefined
  return { value: total + current, next: k, digits: false }
}

/** The smallest power of ten above `v` (5 → 10, 25 → 100, 300 → 1000). */
const placeAbove = (v: number): number => {
  let p = 10
  while (p <= v) p *= 10
  return p
}

/**
 * Dutch: one word of any size ("vijfentwintig", "tweeduizenddriehonderd") or spaced parts ("twee honderd", "honderd vijftig",
 * "tweeduizend driehonderd", "vijf en twintig"). A part is added only to a total that leaves room for it, and "honderd" / "duizend"
 * multiply what came before; anything else ends the number (the caller then checks it read the whole connected expression).
 */
const nlRead = (toks: ReadonlyArray<Tok>, i: number): NumberRead | undefined => {
  const first = nlWord(toks[i]!.norm)
  if (first === undefined) return undefined
  let value = first
  let k = i + 1
  for (;;) {
    const w = toks[k]?.norm
    if (w === undefined) break
    // "vijf en twintig": a unit, "en", a tens word.
    if (w === "en" && value >= 1 && value <= 9 && Number.isInteger(value) && k === i + 1) {
      const tens = nlTens[toks[k + 1]?.norm ?? ""]
      if (tens !== undefined) { value += tens; k += 2; continue }
      break
    }
    const v = nlWord(w)
    if (v === undefined || !Number.isInteger(v) || !Number.isInteger(value) || v === 0) break
    if ((v === 100 && value >= 1 && value < 100) || (v === 1000 && value >= 1 && value < 1000) || (v === 1e6 && value >= 1 && value < 1000)) { value *= v; k++; continue }
    if (value >= 100 && v < value && value % placeAbove(v) === 0) { value += v; k++; continue }
    break
  }
  return { value, next: k, digits: false }
}

const digitWord = (w: string | undefined, language: Language): number | undefined => {
  if (w === undefined) return undefined
  const v = language === "en" ? enUnits[w] : nlUnits[w]
  return v !== undefined && v <= 9 ? v : undefined
}

/** After a whole number read in words: "point five", "point two five", "komma vijf" (single digit words), or "point 25". */
const decimals = (toks: ReadonlyArray<Tok>, n: NumberRead, language: Language): NumberRead => {
  const mark = toks[n.next]?.norm
  if (!Number.isInteger(n.value) || mark !== (language === "en" ? "point" : "komma")) return n
  let k = n.next + 1
  const after = toks[k]?.norm
  if (after !== undefined && /^\d+$/.test(after)) return { value: Number(`${n.value}.${after}`), next: k + 1, digits: n.digits }
  let digits = ""
  for (let d = digitWord(toks[k]?.norm, language); d !== undefined; d = digitWord(toks[k]?.norm, language)) { digits += String(d); k++ }
  return digits === "" ? n : { value: Number(`${n.value}.${digits}`), next: k, digits: n.digits }
}

/** Read a whole number or a decimal at word `i`: digits ("7", "2,5") or number words ("twenty five", "vijfentwintig"). */
export const readNumber = (toks: ReadonlyArray<Tok>, i: number, language: Language): NumberRead | undefined => {
  const t = toks[i]
  if (t === undefined) return undefined
  if (/^\d/.test(t.norm)) {
    const v = digitValue(t.norm, language)
    return v === undefined ? undefined : { value: v, next: i + 1, digits: true }
  }
  const words = language === "en" ? enRead(toks, i) : nlRead(toks, i)
  return words === undefined ? undefined : decimals(toks, words, language)
}

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
 * to a "/" or to a digit character that is not 0–9 ("1/2", "2½"), and digits glued to letters glued to digits ("1e3", "3x4"; not the clock spellings "19u30", "19h30").
 * A parser that read only part of a numeric expression answers `not-understood` instead of a confident wrong value
 * (review round 1, finding 7).
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
    // Digits glued to a letter before them ("1e3", "a3") are part of a word, except the clock spellings "19u30" and "19h30".
    if (/\p{L}/u.test(text[t.start - 1] ?? "")) {
      const prev = toks[k - 1]
      const clock = prev !== undefined && prev.end === t.start && (prev.norm === "u" || prev.norm === "h") && toks[k - 2] !== undefined && toks[k - 2]!.end === prev.start && /^\d+$/.test(toks[k - 2]!.norm)
      if (!clock) return false
    }
  }
  return true
}

/**
 * An amount with spoken fractions at word `i`: "two", "2,5", "one and a half", "half", "a quarter", "three quarters",
 * "anderhalf", "twee en een half", "driekwart". `article`: treat "a"/"an" (English) as 1.
 */
export const readAmount = (toks: ReadonlyArray<Tok>, i: number, language: Language, article = true): NumberRead | undefined => {
  const w = toks[i]?.norm
  if (w === undefined) return undefined
  const frac = (k: number): { value: number; next: number } | undefined => {
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
  if (language === "nl" && (w === "anderhalf" || w === "anderhalve")) return { value: 1.5, next: i + 1, digits: false }
  const lead = frac(i)
  if (lead !== undefined) return { value: lead.value, next: lead.next, digits: false }
  const n = readNumber(toks, i, language)
  if (n === undefined) {
    if (article && language === "en" && (w === "a" || w === "an")) {
      const f = frac(i)
      return f !== undefined ? { value: f.value, next: f.next, digits: false } : { value: 1, next: i + 1, digits: false }
    }
    return undefined
  }
  // N and a half / N en een half / N en half
  let k = n.next
  if (toks[k]?.norm === "and" || toks[k]?.norm === "en") {
    const f = frac(k + 1)
    if (f !== undefined) return { value: n.value + f.value, next: f.next, digits: n.digits }
    if (language === "nl" && toks[k]?.norm === "en" && toks[k + 1]?.norm === "half") return { value: n.value + 0.5, next: k + 2, digits: n.digits }
  }
  if (n.value === 3 && (toks[k]?.norm === "kwart")) return { value: 0.75, next: k + 1, digits: false }
  if (n.value === 3 && language === "en" && toks[k]?.norm === "quarters") return { value: 0.75, next: k + 1, digits: false }
  return n
}
