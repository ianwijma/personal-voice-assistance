// The calculator's bounded evaluator.
//
// THE BOUND (stated, and tested with hostile inputs in test/calculator.test.ts): an expression is at most `MAX_CHARS`
// characters of a fixed alphabet, nests parentheses at most `MAX_PARENS` deep (and the parsed tree is at most `MAX_DEPTH` deep), has at most `MAX_NODES` nodes, and only these nodes
// are evaluated: real numbers, the constants pi, e and tau, units (and currencies), the operators + - * / ^ % and `to`,
// the postfix `!`, parentheses, and the functions in `FUNCTIONS`. Every one of those works on plain numbers and units,
// and none costs more as its operands grow (a huge exponent is `Math.pow`, a huge factorial is Infinity at 171), so one
// evaluation is a few hundred operations at most. What mathjs offers that does grow with its operands (combinations,
// gcd, range, zeros, matrices, bignumbers, strings, `evaluate`, `import`, …) is refused by name before anything runs: the
// check is a whitelist on the parsed tree, never a blacklist, and a length limit alone is not what bounds it.
import type { MathJsInstance, MathNode } from "mathjs"

export const MAX_CHARS = 200
export const MAX_PARENS = 12
export const MAX_DEPTH = 40
export const MAX_NODES = 60

/** Why an expression was not worked out. `detail` is a bounded, plain-letters name where one helps (a unit). */
export type CalcFailure = {
  readonly ok: false
  readonly reason: "empty" | "too-long" | "too-complex" | "not-allowed" | "syntax" | "unknown-unit" | "mismatch" | "no-real-answer" | "too-large" | "no-rates"
  readonly detail?: string
}
export type CalcSuccess = {
  readonly ok: true
  /** The expression as it was worked out (after the percentage and spelling rewrites). */
  readonly expression: string
  readonly value: number
  /** The unit the value is in, as mathjs names it ("inch", "EUR", "m / s"); absent for a plain number. */
  readonly unit?: string
}
export type CalcResult = CalcSuccess | CalcFailure

const FUNCTIONS = new Set([
  "sqrt", "cbrt", "abs", "round", "floor", "ceil", "sign", "min", "max", "sin", "cos", "tan", "asin", "acos", "atan", "log", "log10", "log2", "exp"
])
const OPERATORS = new Set(["add", "subtract", "multiply", "divide", "pow", "mod", "unaryMinus", "unaryPlus", "factorial", "to"])
const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI }
const ALPHABET = /^[A-Za-z\d\s.,+\-*/^%()!_]+$/

/** Words people (and models) write for units mathjs names differently. */
const ALIASES: Readonly<Record<string, string>> = {
  pounds: "lb", pound: "lb", lbs: "lb", ounces: "oz", ounce: "oz", kilos: "kg", kilo: "kg", kilogram: "kg", kilograms: "kg", grams: "g", gram: "g",
  litres: "L", litre: "L", liters: "L", liter: "L", millilitres: "ml", millilitre: "ml", milliliters: "ml", milliliter: "ml",
  teaspoons: "teaspoon", tablespoons: "tablespoon", fahrenheit: "degF", celsius: "degC", kelvins: "K", mph: "mile/hour", kph: "km/hour", kmh: "km/hour"
}

/** 12 significant digits: 57.800000000000004 is 57.8. */
const tidy = (n: number): number => (n === 0 ? 0 : Number(n.toPrecision(12)))

class Refused extends Error {
  readonly failure: CalcFailure
  constructor(failure: CalcFailure) {
    super(failure.reason)
    this.failure = failure
  }
}
const refuse = (reason: CalcFailure["reason"], detail?: string): never => {
  throw new Refused({ ok: false, reason, ...(detail !== undefined ? { detail } : {}) })
}

/** The percentage forms people say, as plain arithmetic. Whole-expression forms only; anything else is left to the parser. */
export const rewritePercent = (text: string): string => {
  const n = String.raw`(-?\d+(?:\.\d+)?)`
  const pct = String.raw`\s*(?:%|percent|procent)`
  const ofTail = String.raw`\s*(?:of|van)\s+(.+)`
  let m = new RegExp(`^(?:what\\s+is\\s+|wat\\s+is\\s+)?${n}${pct}${ofTail}$`, "i").exec(text)
  if (m !== null) return `(${m[1]} / 100) * (${m[2]})`
  m = new RegExp(String.raw`^(?:what\s+(?:percent|percentage)\s+is|hoeveel\s+procent\s+is)\s+${n}\s+(?:of|van)\s+${n}$`, "i").exec(text)
  if (m !== null) return `(${m[1]} / ${m[2]}) * 100`
  m = new RegExp(String.raw`^(.+?)\s*([+-])\s*${n}${pct}$`, "i").exec(text)
  if (m !== null) return `(${m[1]}) * (1 ${m[2]} ${m[3]} / 100)`
  return text
}

/** Parentheses nest deeper than the limit (checked on the text, before any parsing). */
const nestsTooDeep = (text: string): boolean => {
  let depth = 0
  for (const ch of text) {
    if (ch === "(") {
      depth++
      if (depth > MAX_PARENS) return true
    } else if (ch === ")") depth = Math.max(0, depth - 1)
  }
  return false
}

export interface Engine {
  readonly evaluate: (text: string) => CalcResult
  /** Install the rates: units per one euro, by ISO code. Returns the codes that could not be installed (a name mathjs already uses). */
  readonly setRates: (perEuro: ReadonlyMap<string, number>) => ReadonlyArray<string>
  readonly hasCurrency: (code: string) => boolean
}

/** `cupMl`: the size of "cup" (250 or 236.588). The mathjs library comes in as `math` (the caller imports it lazily). */
export const makeEngine = (math: MathJsInstance, options: { readonly cupMl: number }): Engine => {
  const currencies = new Set<string>()
  const knownUnit = (name: string): boolean => math.Unit.isValuelessUnit(name)
  math.createUnit("cup", { definition: `${options.cupMl} ml`, aliases: ["cups"] }, { override: true })
  math.createUnit("EUR", {}, { override: true })
  currencies.add("EUR")

  const setRates: Engine["setRates"] = (perEuro) => {
    const skipped: Array<string> = []
    for (const [code, rate] of perEuro) {
      if (code === "EUR") continue
      if (!/^[A-Z]{3}$/.test(code) || !Number.isFinite(rate) || rate <= 0) continue
      if (!currencies.has(code) && knownUnit(code)) {
        skipped.push(code)
        continue
      }
      math.createUnit(code, { definition: `${1 / rate} EUR` }, { override: true })
      currencies.add(code)
    }
    return skipped
  }

  const check = (root: MathNode): void => {
    let count = 0
    const walk = (node: MathNode, depth: number): void => {
      if (++count > MAX_NODES || depth > MAX_DEPTH) refuse("too-complex")
      const n = node as any
      switch (n.type) {
        case "ConstantNode":
          if (typeof n.value !== "number") refuse("not-allowed")
          return
        case "ParenthesisNode":
          return walk(n.content, depth + 1)
        case "SymbolNode": {
          const name: string = n.name
          if (Object.hasOwn(CONSTANTS, name)) return
          if (!knownUnit(name)) refuse("unknown-unit", /^[A-Za-z]{1,20}$/.test(name) ? name : undefined)
          return
        }
        case "OperatorNode":
          if (!OPERATORS.has(n.fn)) refuse("not-allowed")
          for (const arg of n.args) walk(arg, depth + 1)
          return
        case "FunctionNode":
          if (n.fn?.type !== "SymbolNode" || !FUNCTIONS.has(n.fn.name)) refuse("not-allowed")
          for (const arg of n.args) walk(arg, depth + 1)
          return
        default:
          return refuse("not-allowed")
      }
    }
    walk(root, 0)
  }

  const evaluate: Engine["evaluate"] = (input) => {
    try {
      const raw = input.trim()
      if (raw === "") return { ok: false, reason: "empty" }
      if (raw.length > MAX_CHARS) return { ok: false, reason: "too-long" }
      if (!ALPHABET.test(raw)) return { ok: false, reason: "not-allowed" }
      if (nestsTooDeep(raw)) return { ok: false, reason: "too-complex" }
      // The percentage forms first (they use the words "percent" and "of"), then spelling: words for units, currency codes in lower case.
      const worked = rewritePercent(raw).replace(/[A-Za-z]+/g, (word) => {
        const alias = ALIASES[word.toLowerCase()]
        if (alias !== undefined) return alias
        const upper = word.toUpperCase()
        return word !== upper && word.length === 3 && currencies.has(upper) && !knownUnit(word) ? upper : word
      })
      const root = math.parse(worked)
      check(root)
      const result: unknown = root.evaluate({ ...CONSTANTS })
      if (typeof result === "number") {
        if (Number.isNaN(result)) return { ok: false, reason: "no-real-answer" }
        if (!Number.isFinite(result)) return { ok: false, reason: "too-large" }
        return { ok: true, expression: worked, value: tidy(result) }
      }
      if (math.isUnit(result)) {
        const unit = result as import("mathjs").Unit
        if (unit.value === null || unit.value === undefined) return { ok: false, reason: "not-allowed" }
        const name = unit.formatUnits()
        const value = unit.toNumber(name)
        if (typeof value !== "number" || Number.isNaN(value)) return { ok: false, reason: "no-real-answer" }
        if (!Number.isFinite(value)) return { ok: false, reason: "too-large" }
        return { ok: true, expression: worked, value: tidy(value), unit: name }
      }
      return { ok: false, reason: "no-real-answer" }
    } catch (error) {
      if (error instanceof Refused) return error.failure
      const message = error instanceof Error ? error.message : ""
      if (error instanceof RangeError) return { ok: false, reason: "too-complex" }
      if (/Units do not match|Cannot convert|do not match/i.test(message)) return { ok: false, reason: "mismatch" }
      const undefinedSymbol = /Undefined symbol ([A-Za-z]{1,20})/.exec(message)
      if (undefinedSymbol !== null) return { ok: false, reason: "unknown-unit", detail: undefinedSymbol[1]! }
      return { ok: false, reason: "syntax" }
    }
  }

  return { evaluate, setRates, hasCurrency: (code) => currencies.has(code) }
}
