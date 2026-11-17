// Quantities (review round 3, decision 6): the speaker reads back over a grid of amounts, units and items; generated phrases and
// their mutants against the tests' own grammar.
import { describe, expect, it } from "@effect/vitest"
import { convertAmount, parseQuantity, speakAmount, type UnitId } from "../src/index.ts"
import { norm, stable } from "./support/Cfg.ts"
import { generatedParse, mutantsParse, type GrammarCheck } from "./support/Check.ts"
import { rng } from "./support/Rng.ts"
import { quantityGrammar, withText, type QuantityValue } from "./grammars/quantities.ts"

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

describe("quantities: speakAmount reads back", () => {
  for (const language of ["en", "nl"] as const) {
    it(`${language}: 0.01–999 999 over every unit, with and without "about" and an item, humanised or not (seed 71, 40 000 amounts)`, () => {
      const r = rng(71)
      let n = 0
      for (let k = 0; k < 40_000; k++) {
        const unit = r.pick([...massVolume[language], ...others])
        let amount = r.int(1, 99_999_999) / 100
        if (r.chance(0.5)) amount = Math.max(1, Math.round(amount / r.pick([1, 1000, 100_000])))
        const approx = unit !== "handful" && unit !== "pinch" && unit !== "splash" && r.chance(0.3)
        const item = r.pick(items[language])
        if (unit === "piece" && item === "" && r.chance(0.5)) continue
        const humanize = r.chance(0.5)
        const said = speakAmount({ amount, unit, approx }, language, { item, humanize })!
        const p = parseQuantity(said, language)
        if (p.kind !== "ok") throw new Error(`${language} ${amount} ${unit} ${item}: "${said}" → ${p.kind}`)
        const q = p.value
        const sameBase = q.base === undefined ? q.amount === amount : Math.abs(q.base.amount - (convertAmount(amount, unit, unit === "piece" ? "piece" : (["g", "kg", "oz", "lb"].includes(unit) ? "g" : "ml")) ?? amount)) <= 1e-9 * q.base.amount
        const vague = unit === "handful" || unit === "pinch" || unit === "splash"
        if (!sameBase || q.approx !== (approx || vague) || q.item !== item || (!humanize && q.unit !== unit)) {
          throw new Error(`${language} ${amount} ${unit} "${item}" approx ${approx}: "${said}" → ${stable(q)}`)
        }
        n++
      }
      expect(n).toBeGreaterThan(30_000)
    })
    it(`${language}: some and the rest read back`, () => {
      for (const item of items[language].filter((i) => i !== "")) {
        expect(parseQuantity(speakAmount({ approx: true }, language, { item })!, language)).toMatchObject({ kind: "ok", value: { approx: true, item, dimension: "none" } })
        expect(parseQuantity(speakAmount({ rest: true }, language, { item })!, language)).toMatchObject({ kind: "ok", value: { rest: true, item } })
      }
    })
  }
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
