// The number grammar of the README ("Numbers"), written for the tests: English as a context-free grammar, Dutch as the rule "spaced
// parts that join into one written number", digits per language. Spelling and reading here are the tests' own; nothing comes from
// the package.
import { fixed, lit, norm, oneOf, readFrom, words, type Grammar, type Multi, type Rule } from "../support/Cfg.ts"
import type { Rng } from "../support/Rng.ts"

export type Lang = "en" | "nl"

const enU: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }
const enT: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 }
const enX: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const enD: Record<string, number> = { zero: 0, ...enU }

/** English whole numbers 0–999 999 and decimals in words, by British rules. */
export const enWords: Grammar = {
  U: [{ rhs: [oneOf(enU)] }],
  B100: [{ rhs: [oneOf(enU)] }, { rhs: [oneOf(enT)] }, { rhs: [oneOf(enX)] }, { rhs: [oneOf(enX), oneOf(enU)], act: ([x, u]) => x + u }],
  HLEAD: [{ rhs: ["U"] }, fixed([lit("a")], 1)],
  H: [
    { rhs: ["HLEAD", lit("hundred")], act: ([h]) => h * 100 },
    { rhs: ["HLEAD", lit("hundred"), "B100"], act: ([h, , r]) => h * 100 + r },
    { rhs: ["HLEAD", lit("hundred"), lit("and"), "B100"], act: ([h, , , r]) => h * 100 + r }
  ],
  B1000: [{ rhs: ["B100"] }, { rhs: ["H"] }],
  TLEAD: [{ rhs: ["B1000"] }, fixed([lit("a")], 1)],
  // After "thousand": "and" and a part below 100, or a part below 1000 whose hundreds have a number word ("two hundred"; "a hundred" is not).
  HU: [
    { rhs: ["U", lit("hundred")], act: ([h]) => h * 100 },
    { rhs: ["U", lit("hundred"), "B100"], act: ([h, , r]) => h * 100 + r },
    { rhs: ["U", lit("hundred"), lit("and"), "B100"], act: ([h, , , r]) => h * 100 + r }
  ],
  TH: [
    { rhs: ["TLEAD", lit("thousand")], act: ([t]) => t * 1000 },
    { rhs: ["TLEAD", lit("thousand"), lit("and"), "B100"], act: ([t, , , r]) => t * 1000 + r },
    { rhs: ["TLEAD", lit("thousand"), "B100"], act: ([t, , r]) => t * 1000 + r },
    { rhs: ["TLEAD", lit("thousand"), "HU"], act: ([t, , r]) => t * 1000 + r }
  ],
  WHOLE: [fixed([lit("zero")], 0), { rhs: ["B1000"] }, { rhs: ["TH"] }],
  D: [{ rhs: [oneOf(enD)] }],
  WORDS: [
    { rhs: ["WHOLE"], weight: 3 },
    { rhs: ["WHOLE", lit("point"), "D"], act: ([w, , a]) => Number(`${w}.${a}`) },
    { rhs: ["WHOLE", lit("point"), "D", "D"], act: ([w, , a, b]) => Number(`${w}.${a}${b}`) }
  ]
}

// ---- Dutch: a written number is one word; spaced parts are read joined -------------------------------------------------------------

const nlU = ["een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen"]
const nlT = ["tien", "elf", "twaalf", "dertien", "veertien", "vijftien", "zestien", "zeventien", "achttien", "negentien"]
const nlX = ["twintig", "dertig", "veertig", "vijftig", "zestig", "zeventig", "tachtig", "negentig"]
const nlB100 = (s: string): number | undefined => {
  if (nlU.includes(s)) return nlU.indexOf(s) + 1
  if (nlT.includes(s)) return nlT.indexOf(s) + 10
  if (nlX.includes(s)) return (nlX.indexOf(s) + 2) * 10
  const m = new RegExp(`^(${nlU.join("|")})en(${nlX.join("|")})$`).exec(s)
  return m === null ? undefined : nlU.indexOf(m[1]!) + 1 + (nlX.indexOf(m[2]!) + 2) * 10
}
const nlB1000 = (s: string): number | undefined => {
  const m = /^(twee|drie|vier|vijf|zes|zeven|acht|negen)?honderd(.*)$/.exec(s)
  if (m === null) return nlB100(s)
  const rest = m[2] === "" ? 0 : nlB100(m[2]!)
  return rest === undefined ? undefined : (m[1] === undefined ? 1 : nlU.indexOf(m[1]) + 1) * 100 + rest
}
/** A Dutch whole number as one written word (accents removed), or `undefined`. */
export const nlWhole = (s: string): number | undefined => {
  if (s === "nul") return 0
  const m = /^(.*)duizend(.*)$/.exec(s)
  if (m === null) return nlB1000(s)
  const left = m[1] === "" ? 1 : m[1] === "een" ? undefined : nlB1000(m[1]!)
  const right = m[2] === "" ? 0 : nlB1000(m[2]!)
  return left === undefined || right === undefined ? undefined : left * 1000 + right
}
const nlIsPart = (w: string): boolean => w === "en" || (w !== "nul" && nlWhole(w) !== undefined)
const nlWholeMulti: Multi = {
  readMany: (ws, at) => {
    if (ws[at] === "nul") return [{ value: 0, next: at + 1 }]
    const out: Array<{ value: number; next: number }> = []
    // Any number of parts (README: the 40-word phrase is the only bound; review round 4, finding 10).
    for (let k = 1; at + k <= ws.length; k++) {
      const part = ws.slice(at, at + k)
      if (!part.every(nlIsPart) || part[0] === "en" || part[k - 1] === "en") continue
      const v = nlWhole(part.join(""))
      if (v !== undefined) out.push({ value: v, next: at + k })
    }
    return out
  },
  writeMany: () => ["nul"]
}
const nlD: Record<string, number> = { nul: 0, een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 }
export const nlWords: Grammar = {
  D: [{ rhs: [oneOf(nlD)] }],
  WORDS: [
    { rhs: [nlWholeMulti] },
    { rhs: [nlWholeMulti, lit("komma"), "D"], act: ([w, , a]) => Number(`${w}.${a}`) },
    { rhs: [nlWholeMulti, lit("komma"), "D", "D"], act: ([w, , a, b]) => Number(`${w}.${a}${b}`) }
  ]
}

// ---- spelling (the tests' own) --------------------------------------------------------------------------------------------------------

const enSmall = ["zero", ...Object.keys(enU), ...Object.keys(enT)]
const enTens = ["", "", ...Object.keys(enX)]
const enB1000 = (n: number, r: Rng | undefined): string => {
  const h = Math.floor(n / 100)
  const rest = n % 100
  const low = rest === 0 ? "" : rest < 20 ? enSmall[rest]! : enTens[Math.floor(rest / 10)]! + (rest % 10 === 0 ? "" : ` ${enSmall[rest % 10]}`)
  if (h === 0) return low
  const head = h === 1 && r?.chance(0.3) === true ? "a hundred" : `${enSmall[h]} hundred`
  return low === "" ? head : `${head}${r?.chance(0.2) === true ? "" : " and"} ${low}`
}
/** An English spelling of a whole number 0–999 999: British by default, other spellings the grammar reads when `r` is given. */
export const enSpell = (n: number, r?: Rng): string => {
  if (n === 0) return "zero"
  if (n < 1000) return enB1000(n, r)
  const th = Math.floor(n / 1000)
  const rest = n % 1000
  const head = th === 1 && r?.chance(0.3) === true ? "a thousand" : `${enB1000(th, r)} thousand`
  return rest === 0 ? head : rest < 100 ? `${head} and ${enB1000(rest, r)}` : `${head} ${enB1000(rest, undefined)}`
}
const nlSmallAll = ["nul", ...nlU, ...nlT]
const nlB100Spell = (n: number, r: Rng | undefined): string => {
  if (n < 20) return nlSmallAll[n]!
  const u = n % 10
  const x = nlX[Math.floor(n / 10) - 2]!
  if (u === 0) return x
  const unit = nlU[u - 1]!
  return r?.chance(0.2) === true ? `${unit} en ${x}` : `${unit}${unit.endsWith("e") ? "ën" : "en"}${x}`
}
const nlB1000Spell = (n: number, r: Rng | undefined): string => {
  const h = Math.floor(n / 100)
  const rest = n % 100
  const head = h === 0 ? "" : h === 1 ? "honderd" : `${nlU[h - 1]}honderd`
  const tail = rest === 0 ? "" : nlB100Spell(rest, r)
  if (head !== "" && tail !== "" && r?.chance(0.2) === true) return `${head} ${tail}`
  return head + tail
}
/** The parts of a Dutch written number: 225 324 is twee honderd vijf en twintig duizend drie honderd vier en twintig. */
const nlMorphemes = (n: number): Array<string> => {
  const b100 = (x: number): Array<string> => (x === 0 ? [] : x < 20 ? [nlSmallAll[x]!] : x % 10 === 0 ? [nlX[x / 10 - 2]!] : [nlU[(x % 10) - 1]!, "en", nlX[Math.floor(x / 10) - 2]!])
  const b1000 = (x: number): Array<string> => {
    const h = Math.floor(x / 100)
    return [...(h === 0 ? [] : h === 1 ? ["honderd"] : [nlU[h - 1]!, "honderd"]), ...b100(x % 100)]
  }
  const th = Math.floor(n / 1000)
  return [...(th === 0 ? [] : th === 1 ? ["duizend"] : [...b1000(th), "duizend"]), ...b1000(n % 1000)]
}
/**
 * The parts joined at random, each boundary a space or none ("en" is joined on both sides or spaced on both: "vijfentwintig", "vijf en
 * twintig"): every spacing of the written number (review round 4, finding 10), up to all eleven parts of 999 999.
 */
const nlPartition = (n: number, r: Rng): string => {
  for (;;) {
    const spaced = nlPartitionOnce(n, r)
    // A spaced part must itself be a number word or "en": "honderd eenduizend" is not written ("eenduizend" is no word).
    if (spaced.split(" ").every((w) => nlIsPart(norm(w)))) return spaced
  }
}
const nlPartitionOnce = (n: number, r: Rng): string => {
  const ms = nlMorphemes(n)
  let out = ms[0]!
  for (let k = 1; k < ms.length; k++) {
    const m = ms[k]!
    // The joint after "en" follows the one before it.
    const join = ms[k - 1] === "en" ? !out.endsWith(" en") : r.chance(0.5)
    if (!join) { out += ` ${m}`; continue }
    out += m === "en" && out.endsWith("e") ? "ën" : m
  }
  return out
}
/**
 * A Dutch spelling: one word below 1000, "tweeduizend driehonderd" above (the speaker's); with `r`, often the speaker's style with
 * some spaced parts, and otherwise any spacing of the parts.
 */
export const nlSpell = (n: number, r?: Rng): string => {
  if (n === 0) return "nul"
  if (r !== undefined && r.chance(0.4)) return nlPartition(n, r)
  if (n < 1000) return nlB1000Spell(n, r)
  const th = Math.floor(n / 1000)
  const rest = n % 1000
  return (th === 1 ? "duizend" : `${nlB1000Spell(th, undefined)}duizend`) + (rest === 0 ? "" : ` ${nlB1000Spell(rest, r)}`)
}

const decimalsOf = (v: number): string => {
  const s = (Math.round(Math.abs(v) * 100) % 100).toString().padStart(2, "0").replace(/0+$/, "")
  return s
}
const spellWords = (lang: Lang, v: number, r: Rng): string => {
  const whole = Math.floor(v)
  const ds = decimalsOf(v)
  const w = lang === "en" ? enSpell(whole, r) : nlSpell(whole, r)
  if (ds === "") return w
  const digit = lang === "en" ? ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"] : Object.keys(nlD)
  return `${w} ${lang === "en" ? "point" : "komma"} ${ds.split("").map((d) => digit[Number(d)]).join(" ")}`
}
/** Digits as the language writes them: English "1,500.25", Dutch "1.500,25"; the separator only sometimes. */
const spellDigits = (lang: Lang, v: number, r: Rng): string => {
  const whole = Math.floor(v)
  const ds = decimalsOf(v)
  const grouped = whole >= 1000 && r.chance(0.5) ? `${Math.floor(whole / 1000)}${lang === "en" ? "," : "."}${String(whole % 1000).padStart(3, "0")}` : String(whole)
  return ds === "" ? grouped : `${grouped}${lang === "en" ? "." : ","}${ds}`
}
const digitPattern: Record<Lang, RegExp> = {
  en: /^(0|[1-9][0-9]{0,5}|[1-9][0-9]{0,2},[0-9]{3})(\.[0-9]{1,2})?$/,
  nl: /^(0|[1-9][0-9]{0,5}|[1-9][0-9]{0,2}\.[0-9]{3})(,[0-9]{1,2})?$/
}
export const readDigits = (lang: Lang, w: string): number | undefined => {
  const m = digitPattern[lang].exec(w)
  if (m === null) return undefined
  const whole = Number(m[1]!.replace(/[.,]/g, ""))
  return m[2] === undefined ? whole : Number(`${whole}.${m[2].slice(1)}`)
}

export interface NumberShape {
  readonly min: number
  readonly max: number
  /** Whole numbers only. */
  readonly whole?: boolean
  /** Which forms: digits, words or both (default both). */
  readonly forms?: "digits" | "words" | "both"
}
const wordGrammar: Record<Lang, Grammar> = { en: enWords, nl: nlWords }
const inShape = (v: number, s: NumberShape) => v >= s.min && v <= s.max && (s.whole !== true || Number.isInteger(v))
/** A number of the shape: read in digits or words, written as a random number of the shape. */
export const number = (lang: Lang, shape: NumberShape): Multi => ({
  readMany: (ws, at) => {
    const out: Array<{ value: number; next: number }> = []
    const forms = shape.forms ?? "both"
    if (forms !== "words" && at < ws.length) {
      const d = readDigits(lang, ws[at]!)
      if (d !== undefined && inShape(d, shape)) out.push({ value: d, next: at + 1 })
    }
    if (forms !== "digits") {
      for (const h of readFrom(wordGrammar[lang], "WORDS", ws, at)) if (inShape(h.value as number, shape)) out.push({ value: h.value as number, next: h.next })
    }
    return out
  },
  writeMany: (r) => {
    const forms = shape.forms ?? "both"
    const lo = Math.ceil(shape.min * 100)
    const hi = Math.floor(shape.max * 100)
    // Small numbers more often: most phrases say them.
    const span = hi - lo
    let v = (lo + Math.floor((r.chance(0.6) ? Math.min(span, 3000) : span) * r.next())) / 100
    if (shape.whole === true || r.chance(0.7)) v = Math.min(Math.max(Math.round(v), Math.ceil(shape.min)), Math.floor(shape.max))
    const useWords = forms === "words" || (forms === "both" && r.chance(0.5))
    return (useWords ? spellWords(lang, v, r) : spellDigits(lang, v, r)).split(" ")
  }
})

/** parseNumber's phrase: a number, or "minus" / "min" and a number above 0. */
export const signedGrammar = (lang: Lang): Grammar => ({
  NUMBER: [
    { rhs: [number(lang, { min: 0, max: 999_999.99 })], weight: 4 },
    { rhs: [lit(lang === "en" ? "minus" : "min"), number(lang, { min: 0, max: 999_999.99 })], act: ([, v]) => (v > 0 ? -v : undefined) }
  ]
})

export const allWords = (rules: ReadonlyArray<Rule>): ReadonlyArray<Rule> => rules
export { norm, words }
