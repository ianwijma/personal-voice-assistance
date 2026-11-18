// How the calculator says a result and the sum it worked out: the number (rounded for the ear), its unit, in English
// and Dutch. A unit's name never names another quantity: Dutch "pond" (500 g) and "ons" (100 g) are not the
// avoirdupois pound and ounce, so those are "Engels pond" and "ounce"; mathjs's gallon, pint and quart are the US ones,
// and its ton the short ton, and are named so.
import { speakNumber } from "@pva/language"
import type { Language } from "@pva/module-contracts"
import type { PercentForm } from "./engine.ts"

const SCALES: Record<Language, ReadonlyArray<readonly [number, string]>> = {
  en: [[1e15, "quadrillion"], [1e12, "trillion"], [1e9, "billion"], [1e6, "million"]],
  nl: [[1e15, "biljard"], [1e12, "biljoen"], [1e9, "miljard"], [1e6, "miljoen"]]
}

const decimal = (digits: string, lang: Language): string => (lang === "nl" ? digits.replace(".", ",") : digits)
const three = (n: number): string => String(Number(n.toPrecision(3)))

/** A number as the ear wants it; `about` is true when what is said is not the exact value. */
export const spokenNumber = (n: number, lang: Language): { readonly text: string; readonly about: boolean } => {
  const abs = Math.abs(n)
  const sign = n < 0 ? (lang === "nl" ? "min " : "minus ") : ""
  if (abs >= 1e6) {
    if (abs >= 1e18) {
      const [mantissa, exponent] = abs.toExponential(2).split("e") as [string, string]
      const power = Number(exponent)
      const times = lang === "nl" ? "keer tien tot de macht" : "times ten to the power"
      return { text: `${sign}${decimal(String(Number(mantissa)), lang)} ${times} ${power}`, about: true }
    }
    const [size, name] = SCALES[lang].find(([s]) => abs >= s)!
    const scaled = abs / size
    const exact = Number.isInteger(n) && abs < 1e15 && Number(three(scaled)) * size === abs
    return { text: `${sign}${decimal(three(scaled), lang)} ${name}`, about: !exact }
  }
  if (abs !== 0 && abs < 0.005) {
    if (abs < 1e-3) {
      const [mantissa, exponent] = abs.toExponential(2).split("e") as [string, string]
      const times = lang === "nl" ? "keer tien tot de macht min" : "times ten to the power minus"
      return { text: `${sign}${decimal(String(Number(mantissa)), lang)} ${times} ${Math.abs(Number(exponent))}`, about: true }
    }
    return { text: `${sign}${decimal(three(abs), lang)}`, about: Number(three(abs)) !== abs }
  }
  const said = speakNumber(n, lang)
  if (said === undefined) return { text: String(n), about: true }
  return { text: said, about: Math.abs(Number(said.replace(",", ".").replace(/^(minus|min) /, "-")) - n) > 1e-9 }
}

interface Names {
  readonly one: string
  readonly many: string
}
const n = (one: string, many = one + "s"): Names => ({ one, many })

const UNITS: Record<Language, Readonly<Record<string, Names>>> = {
  en: {
    mm: n("millimetre"), cm: n("centimetre"), m: n("metre"), km: n("kilometre"), inch: n("inch", "inches"), ft: n("foot", "feet"), yd: n("yard"),
    mile: n("mile"), mg: n("milligram"), g: n("gram"), kg: n("kilogram"), lb: n("pound"), oz: n("ounce"), ml: n("millilitre"), cl: n("centilitre"),
    dl: n("decilitre"), L: n("litre"), l: n("litre"), cup: n("cup"), teaspoon: n("teaspoon"), tablespoon: n("tablespoon"), gal: n("US gallon"), gallon: n("US gallon"), pint: n("US pint"),
    quart: n("US quart"), floz: n("US fluid ounce"), ton: n("short ton"), tonne: n("tonne"),
    s: n("second"), minute: n("minute"), hour: n("hour"), day: n("day"), week: n("week"), degC: n("degree Celsius", "degrees Celsius"),
    degF: n("degree Fahrenheit", "degrees Fahrenheit"), K: n("kelvin", "kelvin"), "m / s": n("metre per second", "metres per second"),
    "km / h": n("kilometre per hour", "kilometres per hour"), "km / hour": n("kilometre per hour", "kilometres per hour"), "mile / hour": n("mile per hour", "miles per hour"), m2: n("square metre"), ha: n("hectare"),
    W: n("watt"), kW: n("kilowatt"), J: n("joule"), kJ: n("kilojoule"), cal: n("calorie"), kcal: n("kilocalorie"), byte: n("byte"), deg: n("degree"), rad: n("radian")
  },
  nl: {
    mm: n("millimeter", "millimeter"), cm: n("centimeter", "centimeter"), m: n("meter", "meter"), km: n("kilometer", "kilometer"), inch: n("inch", "inch"),
    ft: n("voet", "voet"), yd: n("yard", "yard"), mile: n("mijl", "mijl"), mg: n("milligram", "milligram"), g: n("gram", "gram"), kg: n("kilo", "kilo"),
    lb: n("Engels pond", "Engelse pond"), oz: n("ounce", "ounce"), ml: n("milliliter", "milliliter"), cl: n("centiliter", "centiliter"), dl: n("deciliter", "deciliter"),
    L: n("liter", "liter"), l: n("liter", "liter"), cup: n("kopje", "kopjes"), teaspoon: n("theelepel", "theelepels"), tablespoon: n("eetlepel", "eetlepels"),
    gal: n("Amerikaanse gallon", "Amerikaanse gallon"), gallon: n("Amerikaanse gallon", "Amerikaanse gallon"), pint: n("Amerikaanse pint", "Amerikaanse pint"),
    quart: n("Amerikaanse quart", "Amerikaanse quart"), floz: n("Amerikaanse fluid ounce", "Amerikaanse fluid ounce"), ton: n("short ton", "short ton"), tonne: n("ton", "ton"), s: n("seconde", "seconden"), minute: n("minuut", "minuten"), hour: n("uur", "uur"), day: n("dag", "dagen"), week: n("week", "weken"),
    degC: n("graad Celsius", "graden Celsius"), degF: n("graad Fahrenheit", "graden Fahrenheit"), K: n("kelvin", "kelvin"),
    "m / s": n("meter per seconde", "meter per seconde"), "km / h": n("kilometer per uur", "kilometer per uur"), "km / hour": n("kilometer per uur", "kilometer per uur"), "mile / hour": n("mijl per uur", "mijl per uur"),
    m2: n("vierkante meter", "vierkante meter"), ha: n("hectare", "hectare"), W: n("watt", "watt"), kW: n("kilowatt", "kilowatt"), J: n("joule", "joule"),
    kJ: n("kilojoule", "kilojoule"), cal: n("calorie", "calorieën"), kcal: n("kilocalorie", "kilocalorieën"), byte: n("byte", "bytes"), deg: n("graad", "graden"),
    rad: n("radiaal", "radialen")
  }
}

/** The unit after a number: "inches", or what mathjs calls it when there is no name here (a compound unit is read as it is). */
export const spokenUnit = (unit: string, amount: number, lang: Language): string => {
  const plural = Math.abs(amount) !== 1
  const singular = unit.endsWith("s") && unit.length > 3 ? unit.slice(0, -1) : unit
  const found = UNITS[lang][unit] ?? UNITS[lang][singular]
  if (found !== undefined) return plural ? found.many : found.one
  return unit.replace(/\s*\/\s*/g, " per ")
}

/** An operand as it was written, never rounded: "340", "0.125", "1234567890123" (a decimal comma in Dutch). */
const operand = (n: number, lang: Language): string => {
  const said = Number.isFinite(n) && Math.abs(n) < 1e6 && Math.round(n * 100) === n * 100 ? speakNumber(n, lang) : undefined
  if (said !== undefined) return said
  const digits = Math.abs(n) < 1e21 ? n.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 17 }) : String(n)
  return decimal(digits.replace(/^-/, lang === "nl" ? "min " : "minus "), lang)
}

const WORDS: Record<Language, Readonly<Record<string, string>>> = {
  en: { add: "plus", subtract: "minus", multiply: "times", divide: "divided by", pow: "to the power", mod: "modulo", to: "in", unaryMinus: "minus", factorial: "factorial", percent: "percent", of: "of", and: "and", sqrt: "the square root of", cbrt: "the cube root of", pi: "pi", e: "e", tau: "tau" },
  nl: { add: "plus", subtract: "min", multiply: "keer", divide: "gedeeld door", pow: "tot de macht", mod: "modulo", to: "in", unaryMinus: "min", factorial: "faculteit", percent: "procent", of: "van", and: "en", sqrt: "de wortel uit", cbrt: "de derdemachtswortel uit", pi: "pi", e: "e", tau: "tau" }
}

/** The longest sum said back; a longer one is not repeated (the answer alone is said). */
export const MAX_SPOKEN_SUM = 120

/**
 * The sum as it was worked out, said back so a misheard number is audible: "17 percent of 340", "500 millilitres in
 * cups", "12 times 15". Walks the parsed tree (at most 60 nodes); `undefined` when it would be longer than
 * `MAX_SPOKEN_SUM` characters or has a node it cannot say.
 */
export const spokenSum = (
  tree: unknown,
  lang: Language,
  percent?: PercentForm
): string | undefined => {
  const w = WORDS[lang]
  const say = (node: any): string | undefined => {
    switch (node?.type) {
      case "ConstantNode":
        return typeof node.value === "number" ? operand(node.value, lang) : undefined
      case "ParenthesisNode":
        return say(node.content)
      case "SymbolNode":
        return w[node.name] ?? spokenUnit(node.name, 2, lang)
      case "OperatorNode": {
        const [a, b] = node.args as Array<any>
        if (node.fn === "multiply" && node.implicit === true && a?.type === "ConstantNode" && b?.type === "SymbolNode" && w[b.name] === undefined) {
          return typeof a.value === "number" ? `${operand(a.value, lang)} ${spokenUnit(b.name, a.value, lang)}` : undefined
        }
        if (node.fn === "unaryPlus") return say(a)
        if (node.fn === "unaryMinus") return mapped(say(a), (x) => `${w.unaryMinus} ${x}`)
        if (node.fn === "factorial") return mapped(say(a), (x) => `${x} ${w.factorial}`)
        const word = w[node.fn]
        if (word === undefined || node.args.length !== 2) return undefined
        const left = say(a)
        const right = say(b)
        return left === undefined || right === undefined ? undefined : `${left} ${word} ${right}`
      }
      case "FunctionNode": {
        const name: string = node.fn?.name
        const args = (node.args as Array<any>).map(say)
        if (args.some((x) => x === undefined)) return undefined
        const list = args.length <= 1 ? args.join("") : `${args.slice(0, -1).join(", ")} ${w.and} ${args[args.length - 1]}`
        return `${w[name] ?? `${name} ${w.of}`} ${list}`
      }
      default:
        return undefined
    }
  }
  // The percentage forms were rewritten (engine.ts): "(p / 100) * (base)" and "(base) * (1 ± p / 100)"; the base is said from its subtree.
  const t = tree as any
  const said = percent === undefined ? say(tree)
    : percent.kind === "of" ? mapped(say(t?.args?.[1]), (b) => `${operand(percent.percent, lang)} ${w.percent} ${w.of} ${b}`)
    : percent.kind === "what" ? `${operand(percent.part, lang)} ${w.of} ${operand(percent.whole, lang)}`
    : mapped(say(t?.args?.[0]), (b) => `${b} ${percent.sign === "+" ? w.add : w.subtract} ${operand(percent.percent, lang)} ${w.percent}`)
  return said !== undefined && said.length <= MAX_SPOKEN_SUM ? said : undefined
}

const mapped = (x: string | undefined, f: (x: string) => string): string | undefined => (x === undefined ? undefined : f(x))
