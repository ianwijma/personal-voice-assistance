import type { ValueCandidate, ValueParser } from "./Decision.ts"
import { type Word, words } from "./TextMatching.ts"

/**
 * Local parsing of numbers and durations for the typed-intent path
 * (docs/AGENTS-AND-INTENTS.md §3.5), English and Dutch. The decision model only
 * chooses; values it cannot choose from a list are found here.
 *
 * - numbers: digits ("40", "21.5", "21,5"), words 0–100 ("forty", "twenty-one",
 *   "veertig", "eenentwintig"), "one/één", "half/halve", "a quarter/een kwart",
 *   percentages ("40%", "forty percent", "veertig procent");
 * - durations: `<number> <unit>` (seconds, minutes, hours; English and Dutch),
 *   "an hour and a half", "anderhalf uur", "two and a half hours", "een kwartier",
 *   "half an hour", "half uur", and sums ("one hour twenty minutes", "1 uur en 10 minuten").
 *
 * Candidates are returned in order of appearance, except that numbers followed
 * by a unit word (percent, degrees, …) come first. Pure; microseconds.
 */

const units: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
}
const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const nlUnits: Record<string, number> = {
  nul: 0, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10,
  elf: 11, twaalf: 12, dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19
}
const nlTens: Record<string, number> = { twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90 }
const nlCompound = new RegExp(`^(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(${Object.keys(nlTens).join("|")})$`)
const nlUnitValue: Record<string, number> = { een: 1, ...nlUnits }

const unitWords = new Set(["percent", "procent", "pct", "degrees", "degree", "graden", "graad"])

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const durationUnits: Record<string, number> = {
  second: SECOND, seconds: SECOND, sec: SECOND, secs: SECOND, seconde: SECOND, seconden: SECOND,
  minute: MINUTE, minutes: MINUTE, min: MINUTE, mins: MINUTE, minuut: MINUTE, minuten: MINUTE,
  hour: HOUR, hours: HOUR, hr: HOUR, hrs: HOUR, uur: HOUR, uren: HOUR
}

interface Parsed {
  readonly value: number
  /** Words consumed. */
  readonly length: number
}

/** A single number word, or a digits token. `"een"` is 1 only where `article` allows it (it is also the Dutch article). */
const singleNumber = (w: Word, raw: string, article: boolean): number | undefined => {
  const n = w.norm
  if (/^\d+$/.test(n)) return Number(n)
  if (n in units) return units[n]
  if (n in tens) return tens[n]
  if (n in nlUnits) return nlUnits[n]
  if (n in nlTens) return nlTens[n]
  if (n === "hundred" || n === "honderd") return 100
  if (n === "een") return article || /^één$/i.test(raw) ? 1 : undefined
  const m = nlCompound.exec(n)
  if (m !== null) return nlUnitValue[m[1]!]! + nlTens[m[2]!]!
  return undefined
}

/**
 * A number starting at word `i`: "21.5" / "21,5" (decimal: two digit words with
 * nothing but the separator between), "twenty one" / "twenty-one", "one hundred".
 */
const numberAt = (text: string, ws: ReadonlyArray<Word>, i: number, article = false): Parsed | undefined => {
  const w = ws[i]
  if (w === undefined) return undefined
  const raw = text.slice(w.start, w.end)
  const first = singleNumber(w, raw, article)
  if (first === undefined) return undefined
  const next = ws[i + 1]
  if (/^\d+$/.test(w.norm) && next !== undefined && /^\d+$/.test(next.norm)) {
    const between = text.slice(w.end, next.start)
    if (between === "." || between === ",") return { value: Number(`${w.norm}.${next.norm}`), length: 2 }
  }
  if (first >= 20 && first % 10 === 0 && first < 100 && next !== undefined && next.norm in units && units[next.norm]! < 10 && units[next.norm]! > 0) {
    return { value: first + units[next.norm]!, length: 2 }
  }
  if ((first === 1 || first === 0) && next !== undefined && (next.norm === "hundred" || next.norm === "honderd")) {
    return { value: 100, length: 2 }
  }
  return { value: first, length: 1 }
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
  const article = is(ws, i, "a", "an") ? { value: 1, length: 1 } : undefined
  const n = article ?? numberAt(text, ws, i, true)
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

/** Durations: parts joined by nothing, "and" or "en" add up ("one hour twenty minutes"). */
const durations = (text: string, ws: ReadonlyArray<Word>): Array<ValueCandidate> => {
  const out: Array<ValueCandidate> = []
  let i = 0
  while (i < ws.length) {
    const part = durationPartAt(text, ws, i)
    if (part === undefined) {
      i++
      continue
    }
    let total = part.value
    let end = i + part.length
    for (;;) {
      const gap = is(ws, end, "and", "en") ? 1 : 0
      const more = durationPartAt(text, ws, end + gap)
      if (more === undefined) break
      total += more.value
      end += gap + more.length
    }
    out.push({ text: text.slice(ws[i]!.start, ws[end - 1]!.end), value: Math.round(total) })
    i = end
  }
  return out
}

const numbers = (text: string, ws: ReadonlyArray<Word>): Array<ValueCandidate> => {
  const withUnit: Array<ValueCandidate> = []
  const plain: Array<ValueCandidate> = []
  let i = 0
  while (i < ws.length) {
    const w = ws[i]!
    let parsed: Parsed | undefined
    if (is(ws, i, "half", "halve")) parsed = { value: 0.5, length: 1 }
    else if (is(ws, i, "a", "een") && is(ws, i + 1, "quarter", "kwart")) parsed = { value: 0.25, length: 2 }
    else if (is(ws, i, "quarter", "kwart")) parsed = { value: 0.25, length: 1 }
    else parsed = numberAt(text, ws, i, unitWords.has(ws[i + 1]?.norm ?? ""))
    if (parsed === undefined) {
      i++
      continue
    }
    let end = i + parsed.length
    const afterText = text.slice(ws[end - 1]!.end)
    const percentSign = /^\s*%/.exec(afterText)
    const unit = ws[end] !== undefined && unitWords.has(ws[end]!.norm)
    if (unit) end++
    const last = ws[end - 1]!.end + (percentSign !== null && !unit ? percentSign[0].length : 0)
    const candidate = { text: text.slice(w.start, last), value: parsed.value }
    if (unit || percentSign !== null) withUnit.push(candidate)
    else plain.push(candidate)
    i = end
  }
  return [...withUnit, ...plain]
}

/** The value parser handed to `buildDecisionPlan` (and used by generated action tools for durations). */
export const parseValues: ValueParser = (kind, utterance) => {
  const ws = words(utterance)
  return kind === "number" ? numbers(utterance, ws) : durations(utterance, ws)
}

/** A duration given as text by a conversational agent's tool call ("10 minutes", "PT10M" is not supported): milliseconds, or undefined. */
export const parseDuration = (text: string): number | undefined => {
  const found = parseValues("duration", text)
  if (found.length > 0) return found[0]!.value
  const n = Number(text.trim())
  return Number.isFinite(n) && n >= 0 ? n * SECOND : undefined
}
