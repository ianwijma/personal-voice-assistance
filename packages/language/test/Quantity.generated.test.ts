// Quantities (review round 3, decision 6): the speaker over a grid of amounts, units and items; generated phrases and their mutants
// against the tests' own grammar.
import { describe, expect, it } from "@effect/vitest"
import { parseQuantity, speakAmount, type UnitId } from "../src/index.ts"
import { norm, stable } from "./support/Cfg.ts"
import { generatedParse, mutantsParse, type GrammarCheck } from "./support/Check.ts"
import { rng } from "./support/Rng.ts"
import { quantityGrammar, units, withText, type QuantityValue } from "./grammars/quantities.ts"
import { readDigits } from "./grammars/numbers.ts"

const project = (q: Record<string, unknown>): QuantityValue => ({ ...q, said: norm(String(q["said"])), item: norm(String(q["item"])) }) as QuantityValue
const parsed = (text: string, language: "en" | "nl") => {
  const r = parseQuantity(text, language)
  return r.kind === "ok" ? project(r.value as unknown as Record<string, unknown>) : r.kind
}

const massVolume: Record<"en" | "nl", ReadonlyArray<UnitId>> = {
  en: ["g", "kg", "oz", "lb", "ml", "cl", "dl", "l", "tsp", "tbsp", "cup"],
  nl: ["g", "kg", "ml", "cl", "dl", "l", "tsp", "tbsp", "cup"]
}
const others: ReadonlyArray<UnitId> = ["pack", "bag", "bottle", "can", "jar", "bunch", "loaf", "box", "tub", "roll", "handful", "pinch", "splash", "piece"]
const items = { en: ["", "flour", "olive oil", "crème fraîche", "Ben's cookies"], nl: ["", "bloem", "olijfolie", "crème fraîche", "Ben's koekjes"] }

// Round 4, decision 2: `speakAmount` is for speaking and is not promised to read back. Its promise is that it never states another
// quantity than it was given. The utterance is read here by the test's own reader (the README's unit table in grammars/quantities.ts):
// its amount, unit and "about" must be the given ones, exactly; an amount that cannot be said exactly must be `undefined`.
const sizeOf = (language: "en" | "nl", id: string) => Object.values(units[language]).find((u) => u.unit === id && u.per === undefined)
const statedBy = (said: string, language: "en" | "nl", item: string) => {
  const ws = said.split(" ")
  let k = 0
  const about = ws[0] === (language === "en" ? "about" : "ongeveer")
  if (about) k++
  const n = ws[k]!
  const amount = /^(a|an|een)$/.test(n) ? 1 : readDigits(language, n)
  if (amount === undefined) return undefined
  const unitWord = ws[k + 1]
  const unit = unitWord === undefined ? undefined : units[language][norm(unitWord)]
  // A count with an item says no unit: "3 apples".
  const rest = ws.slice(unit === undefined ? k + 1 : k + 2).join(" ")
  const tail = language === "en" && unit !== undefined && rest !== "" ? rest.replace(/^of /, "") : rest
  return { about, amount: amount * (unit?.per ?? 1), unit: unit?.unit ?? "piece", tail: unit === undefined && tail === "" ? item : tail }
}
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b))

describe("quantities: speakAmount never states another quantity (round 4, finding 2)", () => {
  for (const language of ["en", "nl"] as const) {
    it(`${language}: 40 000 amounts on and off the hundredths, every unit, with and without "about", items up to 200 characters, humanised or not (seed 71)`, () => {
      const r = rng(71)
      let said = 0
      let exact = 0
      const special = [1.234, 0.006, 1.001, 0.0005, 2 / 3, 999_999.994, 0.004, 1234.5678, 0.1 + 0.2]
      for (let k = 0; k < 40_000; k++) {
        const firstRounds = k < special.length * 4
        // The special amounts first, in kilograms and litres, humanised and not.
        const unit: UnitId = firstRounds ? (k % 2 === 0 ? "kg" : "l") : r.pick([...massVolume[language], ...others])
        const onGrid = r.chance(0.5)
        let amount = k < special.length * 4 ? special[k % special.length]! : onGrid ? r.int(1, 99_999_999) / 100 : r.next() * r.pick([1, 100, 10_000, 1_000_000])
        if (onGrid && r.chance(0.5)) amount = Math.max(1, Math.round(amount / r.pick([1, 1000, 100_000])))
        const approx = r.chance(0.3)
        const item = r.chance(0.02) ? "r".repeat(200) : r.pick(items[language])
        if (unit === "piece" && item === "" && r.chance(0.5)) continue
        const humanize = firstRounds ? k % 4 < 2 : r.chance(0.5)
        const text = speakAmount({ amount, unit, approx }, language, { item, humanize })
        // Whole hundredths by the test's own definition: the amount is the double nearest to its hundredths (round 5, finding 6).
        const hundredths = Math.round(amount * 100) / 100 === amount
        // An amount of whole hundredths in its own unit is always said (it needs no rounding).
        if (text === undefined) {
          if (hundredths && amount <= 999_999.99) throw new Error(`${language} ${amount} ${unit}: an exact amount was not said`)
          continue
        }
        const stated = statedBy(text, language, item)
        const given = sizeOf(language, unit)
        if (stated === undefined || given === undefined) throw new Error(`${language} ${amount} ${unit}: "${text}" is not read`)
        const statedSize = sizeOf(language, stated.unit)!
        const sameQuantity = given.size !== undefined
          ? statedSize.size !== undefined && statedSize.dimension === given.dimension && close(stated.amount * statedSize.size, amount * given.size)
          : stated.unit === unit && close(stated.amount, amount)
        const vague = given.dimension === "vague"
        // "about" only when it was given (a vague unit is vague by itself and says no "about").
        const aboutRight = stated.about === (approx && !vague)
        if (!sameQuantity || !aboutRight || stated.tail !== item || (!humanize && stated.unit !== unit)) {
          throw new Error(`${language} ${amount} ${unit} approx ${approx} "${item}": "${text}" states ${JSON.stringify(stated)}`)
        }
        said++
        if (!hundredths) exact++
      }
      expect(said).toBeGreaterThan(18_000)
      // Off the hundredths, some amounts are still said exactly in a smaller unit (1.234 kg is 1234 grams).
      expect(exact).toBeGreaterThan(5)
    })
    it(`${language}: some and the rest`, () => {
      for (const item of items[language].filter((i) => i !== "")) {
        expect(speakAmount({ approx: true }, language, { item })).toBe(language === "en" ? `some ${item}` : `wat ${item}`)
        expect(speakAmount({ rest: true }, language, { item })).toBe(language === "en" ? `the rest of the ${item}` : `de rest van ${item}`)
      }
    })
  }
  it("the reviewer's amounts (round 4, findings 2 and 6)", () => {
    expect(speakAmount({ amount: 1.234, unit: "kg" }, "en", { item: "rice", humanize: false })).toBeUndefined()
    expect(speakAmount({ amount: 1.234, unit: "kg" }, "en", { item: "rice" })).toBe("1234 grams of rice")
    expect(speakAmount({ amount: 1.234, unit: "kg" }, "nl", { item: "rijst" })).toBe("1234 gram rijst")
    expect(speakAmount({ amount: 0.006, unit: "kg" }, "en")).toBe("6 grams")
    expect(speakAmount({ amount: 0.006, unit: "kg" }, "en", { humanize: false })).toBeUndefined()
    // A vague unit says no "about", as given.
    expect(speakAmount({ amount: 2, unit: "handful", approx: false }, "en", { item: "rice", humanize: false })).toBe("2 handfuls of rice")
  })
  it("what it cannot say is undefined, never a broken utterance (finding 23, finding 11)", () => {
    for (const amount of [1e21, -1e21, 1e-95, -2, 0, Number.NaN, Infinity, 0.000001]) expect(speakAmount({ amount, unit: "kg" }, "en"), String(amount)).toBeUndefined()
    expect(speakAmount({ amount: 0.0001, unit: "kg" }, "en")).toBe("0.1 grams")
    expect(speakAmount({ amount: 1, unit: "lb" }, "nl", { item: "suiker" })).toBeUndefined()
    expect(speakAmount({ amount: 2, unit: "oz" }, "nl", { item: "suiker", humanize: false })).toBeUndefined()
    expect(speakAmount({ amount: 2, unit: "parsec" as UnitId }, "en")).toBeUndefined()
  })
})

describe("quantities: generated phrases and their mutants", () => {
  for (const language of ["en", "nl"] as const) {
    const check: GrammarCheck = {
      grammar: quantityGrammar(language),
      start: "QUANTITY",
      expected: (values, words) => {
        const all = [...new Map(values.map((v) => withText(v as Record<string, unknown>, words)).map((v) => [stable(v), v])).values()]
        return all.length === 0 ? "not-understood" : all.length === 1 ? all[0] : "ambiguous"
      },
      actual: (text) => parsed(text, language)
    }
    it(`${language}: 3000 generated quantities (seed 72)`, () => expect(generatedParse(check, 3000, 72)).toBeGreaterThan(2500))
    it(`${language}: every mutant of 120 generated quantities, half the insertions (seed 73)`, () => expect(mutantsParse(check, 120, 73, 0.5)).toBeGreaterThan(10_000))
  }
})
