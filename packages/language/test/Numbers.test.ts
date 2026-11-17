// Numbers (review round 3, decisions 3 and 6): the one number grammar per language, shown by examples, by exhaustive and sampled
// round trips with the speaker, by phrases generated from the tests' own grammar, and by mutants of them.
import { describe, expect, it } from "@effect/vitest"
import { parseNumber } from "../src/Numbers.ts"
import { numberToWords, speakNumber } from "../src/index.ts"
import { generate, mutants, norm, recognise } from "./support/Cfg.ts"
import { rng } from "./support/Rng.ts"
import { enSpell, nlSpell, signedGrammar, type Lang } from "./grammars/numbers.ts"

const value = (text: string, language: Lang) => {
  const r = parseNumber(text, language)
  return r.kind === "ok" ? r.value : r.kind
}

describe("parseNumber: examples", () => {
  const en: ReadonlyArray<readonly [string, number]> = [
    ["seven", 7], ["twenty five", 25], ["twenty-five", 25], ["a hundred", 100], ["one hundred and fifty", 150], ["two hundred fifty", 250], ["one thousand", 1000],
    ["two thousand five hundred", 2500], ["one thousand and five", 1005], ["a hundred thousand", 100_000], ["zero", 0], ["250", 250], ["2.5", 2.5], ["1,500", 1500],
["999,999.99", 999_999.99], ["two point five", 2.5], ["zero point zero one", 0.01], ["2.50", 2.5], ["minus five", -5], ["minus 2.5", -2.5]
  ]
  for (const [text, v] of en) it(`en "${text}" is ${v}`, () => expect(value(text, "en")).toBe(v))
  const nl: ReadonlyArray<readonly [string, number]> = [
    ["zeven", 7], ["eenentwintig", 21], ["tweeëntwintig", 22], ["vijf en twintig", 25], ["honderd", 100], ["tweehonderdvijftig", 250], ["twee honderd", 200],
    ["duizend", 1000], ["tweeduizend driehonderd", 2300], ["2,5", 2.5], ["1.500", 1500], ["twee komma vijf", 2.5], ["min drie", -3], ["een", 1]
  ]
  for (const [text, v] of nl) it(`nl "${text}" is ${v}`, () => expect(value(text, "nl")).toBe(v))
  // Finding 17 and round-2 finding 23: a malformed run of numbers is no number, not its first part.
  const notEn = ["5 five", "five 5", "5 5", "five five", "one thousand two thousand", "twenty thirty", "seven thirty", "1e3", "1,5", "2.5555", "1,000,000", "1.000", "2.125", "0.001", "two point one two five", ".5", "in .5", "a million",
    "two million", "", "hundred", "and", "twenty and", "minus zero", "- 5", "-5", "5-", "½", "one hundred and", "point five", "0x10", "1e308", "Infinity", "NaN", "05"]
  for (const t of notEn) it(`en "${t}" is not a number`, () => expect(value(t, "en")).toBe("not-understood"))
  const notNl = ["1,000", "2,125", ",5", "1 een", "een 1", "vijf vijf", "duizend duizend", "eenhonderd", "eenduizend", "2.5", "nul nul", "honderd en vijf", "tweeënhalf", "en vijf"]
  for (const t of notNl) it(`nl "${t}" is not a number`, () => expect(value(t, "nl")).toBe("not-understood"))
  it("a word that is an inherited property name is no number", () => {
    for (const t of ["constructor", "__proto__", "toString"]) expect(value(t, "en")).toBe("not-understood")
  })
})

describe("numbers: exhaustive and sampled round trips with the speaker", () => {
  it("every whole number 0–10 000, in words (numberToWords) and digits (speakNumber), both languages", () => {
    for (const lang of ["en", "nl"] as const) {
      for (let n = 0; n <= 10_000; n++) {
        const w = numberToWords(n, lang)!
        if (value(w, lang) !== n) throw new Error(`${lang} ${n}: "${w}" reads as ${value(w, lang)}`)
        const d = speakNumber(n, lang)!
        if (value(d, lang) !== n) throw new Error(`${lang} ${n}: "${d}"`)
      }
    }
  })
  it("sampled magnitudes to 999 999 and decimals to two places, digits and words, both signs (20 000 numbers, seed 11)", () => {
    const r = rng(11)
    for (let k = 0; k < 20_000; k++) {
      const lang = r.pick(["en", "nl"] as const)
      const hundredths = r.int(0, 99_999_999)
      const magnitude = r.pick([1, 10, 1000, 1_000_000, 100_000_000])
      let v = (hundredths % magnitude) / 100
      if (r.chance(0.3)) v = Math.round(v)
      if (r.chance(0.2) && v > 0) v = -v
      for (const words of [false, true]) {
        const said = speakNumber(v, lang, { words })!
        if (value(said, lang) !== v) throw new Error(`${lang} ${v} (${words ? "words" : "digits"}): "${said}" reads as ${value(said, lang)}`)
      }
    }
  })
  it("the speaker's own spelling is the tests' spelling", () => {
    for (let n = 0; n <= 999_999; n += 997) {
      expect(numberToWords(n, "en")).toBe(enSpell(n))
      expect(norm(numberToWords(n, "nl")!)).toBe(norm(nlSpell(n)))
    }
  })
})

describe("numbers: generated phrases and their mutants", () => {
  for (const lang of ["en", "nl"] as const) {
    const g = signedGrammar(lang)
    it(`${lang}: 3000 generated phrases parse to their value (seed 21)`, () => {
      const r = rng(21)
      for (let k = 0; k < 3000; k++) {
        const p = generate(g, "NUMBER", r)!
        const text = p.words.join(" ")
        if (value(text, lang) !== p.value) throw new Error(`"${text}" should be ${p.value}, is ${value(text, lang)}`)
      }
    })
    it(`${lang}: every mutant of 150 generated phrases is refused or is a number of the grammar with that value (seed 22)`, () => {
      const r = rng(22)
      let checked = 0
      for (let k = 0; k < 150; k++) {
        const p = generate(g, "NUMBER", r)!
        for (const m of mutants(p.words)) {
          const expected = recognise(g, "NUMBER", m) as Array<number>
          const got = parseNumber(m.join(" "), lang)
          checked++
          const want = expected.length === 1 ? expected[0] : expected.length === 0 ? "not-understood" : "ambiguous"
          const have = got.kind === "ok" ? got.value : got.kind
          if (want !== have) throw new Error(`"${m.join(" ")}": the grammar says ${JSON.stringify(expected)}, the parser ${JSON.stringify(got)}`)
        }
      }
      expect(checked).toBeGreaterThan(30_000)
    })
  }
})
