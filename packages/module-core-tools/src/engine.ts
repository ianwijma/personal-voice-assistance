// The calculator's bounded evaluator.
//
// THE BOUND (stated, and tested with hostile inputs in test/engine.test.ts): an expression is at most `MAX_CHARS`
// characters of a fixed alphabet, nests parentheses at most `MAX_PARENS` deep (and the parsed tree is at most `MAX_DEPTH`
// deep), has at most `MAX_NODES` nodes, and only these nodes are evaluated: real numbers, the constants pi, e and tau,
// units, the operators + - * / ^ % and `to`, the postfix `!`, parentheses, and the functions in `FUNCTIONS`. Every one of
// those works on plain numbers and units, and none costs more as its operands grow (a huge exponent is `Math.pow`, a huge
// factorial is Infinity at 171), so one evaluation is a few hundred operations at most; the exactness check evaluates
// each of at most 60 subtrees once more, a few thousand at most. What mathjs offers that does grow with its operands
// (combinations, gcd, range, zeros, matrices, bignumbers, strings, `evaluate`, `import`, …) is refused by name before
// anything runs: the check is a whitelist on the parsed tree, never a blacklist, and a length limit alone is not what
// bounds it.
//
// Currencies are not converted in this version (docs/modules/calculator.md, "What was left out"): an expression that
// names one (an ISO code in either case, a currency word or sign) is refused as `currency` before it is parsed.
import type { MathJsInstance, MathNode } from "mathjs"

export const MAX_CHARS = 200
export const MAX_PARENS = 12
export const MAX_DEPTH = 40
export const MAX_NODES = 60

/** Why an expression was not worked out. `detail` is a bounded, plain-letters name where one helps (a unit). */
export type CalcFailure = {
  readonly ok: false
  readonly reason: "empty" | "too-long" | "too-complex" | "not-allowed" | "syntax" | "unknown-unit" | "mismatch" | "no-real-answer" | "too-large" | "currency"
  readonly detail?: string
}

/** How a percentage form was said, so the answer can say it back ("17 percent of 340 is 57.8"). */
export type PercentForm =
  | { readonly kind: "of"; readonly percent: number; readonly base: string }
  | { readonly kind: "what"; readonly part: number; readonly whole: number }
  | { readonly kind: "change"; readonly base: string; readonly sign: "+" | "-"; readonly percent: number }

export type CalcSuccess = {
  readonly ok: true
  /** The expression as it was worked out (after the percentage and spelling rewrites). */
  readonly expression: string
  /**
   * The value computed: an integer result is the computed integer itself (exact to the last digit inside the safe
   * range); a fraction is given to 15 significant digits, the precision of the arithmetic (0.1 + 0.2 is 0.3).
   */
  readonly value: number
  /**
   * True when the arithmetic could not be exact: an operand or an intermediate or final result is outside the range of
   * exact integers (±2^53), or an operand has more than 15 significant digits.
   */
  readonly approximate: boolean
  /** The unit the value is in, as mathjs names it ("inch", "m / s"); absent for a plain number. */
  readonly unit?: string
  /** The parsed expression, for saying it back (at most `MAX_NODES` nodes). */
  readonly tree: MathNode
  readonly percent?: PercentForm
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

/** Words and signs that name a currency (lower case), in English and Dutch. "pound" is a mass here: "pound sterling" and "sterling" are the currency. */
const CURRENCY_WORDS = new Set([
  "euro", "euros", "eurocent", "eurocents", "dollar", "dollars", "cent", "cents", "sterling", "pence", "penny", "yen", "yuan", "renminbi", "franc", "francs",
  "frank", "franken", "krona", "kronor", "krone", "kroner", "kroon", "kronen", "rupee", "rupees", "roepie", "roepies", "peso", "pesos", "zloty", "lira", "lire",
  "rand", "real", "reais", "won", "forint", "ruble", "rubles", "roebel", "roebels", "bitcoin", "bitcoins"
])
const CURRENCY_SIGNS = /[$€£¥₹₽₩₺₿¢]/
const ISO_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency"))

const tidy = (n: number): number => (n === 0 ? 0 : Number(n.toPrecision(15)))

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

/** The percentage forms people say, as plain arithmetic, and how each was said. Whole-expression forms only; anything else is left to the parser. */
export const rewritePercent = (text: string): { readonly text: string; readonly form?: PercentForm } => {
  const n = String.raw`(-?\d+(?:\.\d+)?)`
  const pct = String.raw`\s*(?:%|percent|procent)`
  const ofTail = String.raw`\s*(?:of|van)\s+(.+)`
  let m = new RegExp(`^(?:what\\s+is\\s+|wat\\s+is\\s+)?${n}${pct}${ofTail}$`, "i").exec(text)
  if (m !== null) return { text: `(${m[1]} / 100) * (${m[2]})`, form: { kind: "of", percent: Number(m[1]), base: m[2]! } }
  m = new RegExp(String.raw`^(?:what\s+(?:percent|percentage)\s+is|hoeveel\s+procent\s+is)\s+${n}\s+(?:of|van)\s+${n}$`, "i").exec(text)
  if (m !== null) return { text: `(${m[1]} / ${m[2]}) * 100`, form: { kind: "what", part: Number(m[1]), whole: Number(m[2]) } }
  m = new RegExp(String.raw`^(.+?)\s*([+-])\s*${n}${pct}$`, "i").exec(text)
  if (m !== null) return { text: `(${m[1]}) * (1 ${m[2]} ${m[3]} / 100)`, form: { kind: "change", base: m[1]!, sign: m[2] as "+" | "-", percent: Number(m[3]) } }
  return { text }
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

/** A literal with more significant digits than a double holds: "12345678901234567", "0.1234567890123456789". */
const tooPrecise = (text: string): boolean => {
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const digits = m[0].replace(".", "").replace(/^0+/, "").replace(/0+$/, "")
    if (digits.length > 15) return true
  }
  return false
}

export interface Engine {
  readonly evaluate: (text: string) => CalcResult
}

/** `cupMl`: the size of "cup" (250 or 236.588). The mathjs library comes in as `math` (the caller imports it lazily). */
export const makeEngine = (math: MathJsInstance, options: { readonly cupMl: number }): Engine => {
  const knownUnit = (name: string): boolean => math.Unit.isValuelessUnit(name)
  math.createUnit("cup", { definition: `${options.cupMl} ml`, aliases: ["cups"] }, { override: true })

  /** A word that names a currency: an ISO code (any case) that is not a unit's name, or a currency word. "CUP" is the cup, not the Cuban peso. */
  const isCurrency = (word: string): boolean => {
    const lower = word.toLowerCase()
    if (CURRENCY_WORDS.has(lower)) return true
    return word.length === 3 && ISO_CURRENCIES.has(word.toUpperCase()) && !knownUnit(word) && !knownUnit(lower) && ALIASES[lower] === undefined
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

  /** Whether any operand or intermediate result leaves the exact integers: each of the (at most 60) subtrees is evaluated once more. */
  const leavesExactRange = (root: MathNode): boolean => {
    let outside = false
    const big = (x: unknown): boolean => {
      if (typeof x === "number") return Number.isFinite(x) && Math.abs(x) > Number.MAX_SAFE_INTEGER
      if (math.isUnit(x)) {
        const v = (x as { value: unknown }).value
        return typeof v === "number" && Math.abs(v) > Number.MAX_SAFE_INTEGER
      }
      return false
    }
    root.traverse((node) => {
      if (outside) return
      const n = node as any
      if (n.type === "ConstantNode" || n.type === "OperatorNode" || n.type === "FunctionNode") {
        try {
          if (big(node.evaluate({ ...CONSTANTS }))) outside = true
        } catch {
          // A subtree that does not evaluate alone (a unit conversion's target): its parent says what it is.
        }
      }
    })
    return outside
  }

  const evaluate: Engine["evaluate"] = (input) => {
    try {
      const raw = input.trim()
      if (raw === "") return { ok: false, reason: "empty" }
      if (raw.length > MAX_CHARS) return { ok: false, reason: "too-long" }
      if (CURRENCY_SIGNS.test(raw)) return { ok: false, reason: "currency" }
      if (!ALPHABET.test(raw)) return { ok: false, reason: "not-allowed" }
      if (nestsTooDeep(raw)) return { ok: false, reason: "too-complex" }
      for (const m of raw.matchAll(/[A-Za-z]+/g)) if (isCurrency(m[0])) return { ok: false, reason: "currency" }
      // The percentage forms first (they use the words "percent" and "of"), then spelling: words for units.
      const rewritten = rewritePercent(raw)
      const worked = rewritten.text.replace(/[A-Za-z]+/g, (word) => ALIASES[word.toLowerCase()] ?? word)
      const tree = math.parse(worked)
      check(tree)
      const result: unknown = tree.evaluate({ ...CONSTANTS })
      const form = rewritten.form !== undefined ? { percent: rewritten.form } : {}
      const settle = (value: number, unit?: string): CalcResult => {
        if (Number.isNaN(value)) return { ok: false, reason: "no-real-answer" }
        if (!Number.isFinite(value)) return { ok: false, reason: "too-large" }
        const approximate = tooPrecise(raw) || Math.abs(value) > Number.MAX_SAFE_INTEGER || leavesExactRange(tree)
        // An integer is kept as computed; a fraction loses only the binary noise past 15 significant digits.
        const kept = Number.isInteger(value) ? value : tidy(value)
        return { ok: true, expression: worked, value: kept, approximate, tree, ...(unit !== undefined ? { unit } : {}), ...form }
      }
      if (typeof result === "number") return settle(result)
      if (math.isUnit(result)) {
        const unit = result as import("mathjs").Unit
        if (unit.value === null || unit.value === undefined) return { ok: false, reason: "not-allowed" }
        const name = unit.formatUnits()
        const value = unit.toNumber(name)
        if (typeof value !== "number") return { ok: false, reason: "no-real-answer" }
        return settle(value, name)
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

  return { evaluate }
}
