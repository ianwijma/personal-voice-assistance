import { describe, expect, it } from "@effect/vitest"
import { convertAmount, parseQuantity, usCupMl } from "../src/Quantity.ts"

const read = (text: string, language: "en" | "nl", options?: Parameters<typeof parseQuantity>[2]) => {
  const r = parseQuantity(text, language, options)
  if (r.kind !== "ok") return r.kind
  const q = r.value
  return { amount: q.amount, unit: q.unit, dim: q.dimension, approx: q.approx, rest: q.rest, base: q.base === undefined ? undefined : `${q.base.amount} ${q.base.unit}`, item: q.item, said: q.said }
}

describe("parseQuantity: English", () => {
  const rows: ReadonlyArray<readonly [string, ReturnType<typeof read>]> = [
    ["a kilo of rice", { amount: 1, unit: "kg", dim: "mass", approx: false, rest: false, base: "1000 g", item: "rice", said: "a kilo" }],
    ["two kilos of potatoes", { amount: 2, unit: "kg", dim: "mass", approx: false, rest: false, base: "2000 g", item: "potatoes", said: "two kilos" }],
    ["about 250 grams of flour", { amount: 250, unit: "g", dim: "mass", approx: true, rest: false, base: "250 g", item: "flour", said: "about 250 grams" }],
    ["250g pasta", { amount: 250, unit: "g", dim: "mass", approx: false, rest: false, base: "250 g", item: "pasta", said: "250g" }],
    ["roughly three hundred and fifty grams of butter", { amount: 350, unit: "g", dim: "mass", approx: true, rest: false, base: "350 g", item: "butter", said: "roughly three hundred and fifty grams" }],
    ["half a kilo of butter", { amount: 0.5, unit: "kg", dim: "mass", approx: false, rest: false, base: "500 g", item: "butter", said: "half a kilo" }],
    ["a pound of mince", { amount: 1, unit: "lb", dim: "mass", approx: false, rest: false, base: "453.59237 g", item: "mince", said: "a pound" }],
    ["8 ounces of cheese", { amount: 8, unit: "oz", dim: "mass", approx: false, rest: false, base: "226.796185 g", item: "cheese", said: "8 ounces" }],
    ["two litres of milk", { amount: 2, unit: "l", dim: "volume", approx: false, rest: false, base: "2000 ml", item: "milk", said: "two litres" }],
    ["1.5 liters of water", { amount: 1.5, unit: "l", dim: "volume", approx: false, rest: false, base: "1500 ml", item: "water", said: "1.5 liters" }],
    ["a quarter litre of cream", { amount: 0.25, unit: "l", dim: "volume", approx: false, rest: false, base: "250 ml", item: "cream", said: "a quarter litre" }],
    ["300 ml of stock", { amount: 300, unit: "ml", dim: "volume", approx: false, rest: false, base: "300 ml", item: "stock", said: "300 ml" }],
    ["2 cups of flour", { amount: 2, unit: "cup", dim: "volume", approx: false, rest: false, base: "500 ml", item: "flour", said: "2 cups" }],
    ["a cup of sugar", { amount: 1, unit: "cup", dim: "volume", approx: false, rest: false, base: "250 ml", item: "sugar", said: "a cup" }],
    ["three tablespoons of oil", { amount: 3, unit: "tbsp", dim: "volume", approx: false, rest: false, base: "45 ml", item: "oil", said: "three tablespoons" }],
    ["a teaspoon of salt", { amount: 1, unit: "tsp", dim: "volume", approx: false, rest: false, base: "5 ml", item: "salt", said: "a teaspoon" }],
    ["a pack of spaghetti", { amount: 1, unit: "pack", dim: "pack", approx: false, rest: false, base: undefined, item: "spaghetti", said: "a pack" }],
    ["three cans of tomatoes", { amount: 3, unit: "can", dim: "pack", approx: false, rest: false, base: undefined, item: "tomatoes", said: "three cans" }],
    ["a bottle of wine", { amount: 1, unit: "bottle", dim: "pack", approx: false, rest: false, base: undefined, item: "wine", said: "a bottle" }],
    ["a loaf of bread", { amount: 1, unit: "loaf", dim: "pack", approx: false, rest: false, base: undefined, item: "bread", said: "a loaf" }],
    ["a handful of nuts", { amount: 1, unit: "handful", dim: "vague", approx: true, rest: false, base: undefined, item: "nuts", said: "a handful" }],
    ["a pinch of salt", { amount: 1, unit: "pinch", dim: "vague", approx: true, rest: false, base: undefined, item: "salt", said: "a pinch" }],
    ["12 eggs", { amount: 12, unit: "piece", dim: "count", approx: false, rest: false, base: "12 piece", item: "eggs", said: "12" }],
    ["a dozen eggs", { amount: 12, unit: "piece", dim: "count", approx: false, rest: false, base: "12 piece", item: "eggs", said: "a dozen" }],
    ["two apples", { amount: 2, unit: "piece", dim: "count", approx: false, rest: false, base: "2 piece", item: "apples", said: "two" }],
    ["3x milk", { amount: 3, unit: "piece", dim: "count", approx: false, rest: false, base: "3 piece", item: "milk", said: "3x" }],
    ["some milk", { amount: undefined, unit: undefined, dim: "none", approx: true, rest: false, base: undefined, item: "milk", said: "some" }],
    ["a bit of cheese", { amount: undefined, unit: undefined, dim: "none", approx: true, rest: false, base: undefined, item: "cheese", said: "a bit" }],
    ["the rest of the rice", { amount: undefined, unit: undefined, dim: "none", approx: false, rest: true, base: undefined, item: "the rice", said: "the rest" }],
    ["add a kilo of rice to the list", { amount: 1, unit: "kg", dim: "mass", approx: false, rest: false, base: "1000 g", item: "rice to the list", said: "a kilo" }]
  ]
  for (const [text, expected] of rows) it(`"${text}"`, () => expect(read(text, "en")).toEqual(expected))
  for (const bad of ["", "rice", "an apple", "a", "hello there"]) it(`"${bad}" has no quantity`, () => expect(read(bad, "en")).toBe("not-understood"))
  it("the cup size is a parameter", () => {
    expect(read("2 cups of flour", "en", { cupMl: usCupMl })).toMatchObject({ base: "473.176 ml" })
    expect(read("a cup of milk", "en", { cupMl: 240 })).toMatchObject({ base: "240 ml" })
  })
})

describe("parseQuantity: Dutch", () => {
  const rows: ReadonlyArray<readonly [string, ReturnType<typeof read>]> = [
    ["een kilo rijst", { amount: 1, unit: "kg", dim: "mass", approx: false, rest: false, base: "1000 g", item: "rijst", said: "een kilo" }],
    ["twee kilo aardappelen", { amount: 2, unit: "kg", dim: "mass", approx: false, rest: false, base: "2000 g", item: "aardappelen", said: "twee kilo" }],
    ["ongeveer 500 gram gehakt", { amount: 500, unit: "g", dim: "mass", approx: true, rest: false, base: "500 g", item: "gehakt", said: "ongeveer 500 gram" }],
    ["een ons kaas", { amount: 100, unit: "g", dim: "mass", approx: false, rest: false, base: "100 g", item: "kaas", said: "een ons" }],
    ["twee ons ham", { amount: 200, unit: "g", dim: "mass", approx: false, rest: false, base: "200 g", item: "ham", said: "twee ons" }],
    ["een half pond kaas", { amount: 250, unit: "g", dim: "mass", approx: false, rest: false, base: "250 g", item: "kaas", said: "een half pond" }],
    ["een pond tomaten", { amount: 500, unit: "g", dim: "mass", approx: false, rest: false, base: "500 g", item: "tomaten", said: "een pond" }],
    ["twee liter melk", { amount: 2, unit: "l", dim: "volume", approx: false, rest: false, base: "2000 ml", item: "melk", said: "twee liter" }],
    ["anderhalve liter melk", { amount: 1.5, unit: "l", dim: "volume", approx: false, rest: false, base: "1500 ml", item: "melk", said: "anderhalve liter" }],
    ["2,5 liter water", { amount: 2.5, unit: "l", dim: "volume", approx: false, rest: false, base: "2500 ml", item: "water", said: "2,5 liter" }],
    ["een halve liter room", { amount: 0.5, unit: "l", dim: "volume", approx: false, rest: false, base: "500 ml", item: "room", said: "een halve liter" }],
    ["drie eetlepels olie", { amount: 3, unit: "tbsp", dim: "volume", approx: false, rest: false, base: "45 ml", item: "olie", said: "drie eetlepels" }],
    ["een theelepel zout", { amount: 1, unit: "tsp", dim: "volume", approx: false, rest: false, base: "5 ml", item: "zout", said: "een theelepel" }],
    ["een kopje suiker", { amount: 1, unit: "cup", dim: "volume", approx: false, rest: false, base: "250 ml", item: "suiker", said: "een kopje" }],
    ["een pak melk", { amount: 1, unit: "pack", dim: "pack", approx: false, rest: false, base: undefined, item: "melk", said: "een pak" }],
    ["twee pakken pasta", { amount: 2, unit: "pack", dim: "pack", approx: false, rest: false, base: undefined, item: "pasta", said: "twee pakken" }],
    ["een half pak boter", { amount: 0.5, unit: "pack", dim: "pack", approx: false, rest: false, base: undefined, item: "boter", said: "een half pak" }],
    ["drie blikken tomaten", { amount: 3, unit: "can", dim: "pack", approx: false, rest: false, base: undefined, item: "tomaten", said: "drie blikken" }],
    ["een brood", { amount: 1, unit: "loaf", dim: "pack", approx: false, rest: false, base: undefined, item: "", said: "een brood" }],
    ["een handvol noten", { amount: 1, unit: "handful", dim: "vague", approx: true, rest: false, base: undefined, item: "noten", said: "een handvol" }],
    ["een snufje zout", { amount: 1, unit: "pinch", dim: "vague", approx: true, rest: false, base: undefined, item: "zout", said: "een snufje" }],
    ["een dozijn eieren", { amount: 12, unit: "piece", dim: "count", approx: false, rest: false, base: "12 piece", item: "eieren", said: "een dozijn" }],
    ["twee appels", { amount: 2, unit: "piece", dim: "count", approx: false, rest: false, base: "2 piece", item: "appels", said: "twee" }],
    ["6 stuks", { amount: 6, unit: "piece", dim: "count", approx: false, rest: false, base: "6 piece", item: "", said: "6 stuks" }],
    ["wat melk", { amount: undefined, unit: undefined, dim: "none", approx: true, rest: false, base: undefined, item: "melk", said: "wat" }],
    ["een beetje zout", { amount: undefined, unit: undefined, dim: "none", approx: true, rest: false, base: undefined, item: "zout", said: "een beetje" }],
    ["de rest van de rijst", { amount: undefined, unit: undefined, dim: "none", approx: false, rest: true, base: undefined, item: "de rijst", said: "de rest" }],
    ["de rest", { amount: undefined, unit: undefined, dim: "none", approx: false, rest: true, base: undefined, item: "", said: "de rest" }]
  ]
  for (const [text, expected] of rows) it(`"${text}"`, () => expect(read(text, "nl")).toEqual(expected))
  for (const bad of ["", "rijst", "een appel is lekker", "hallo"]) it(`"${bad}" has no quantity`, () => expect(read(bad, "nl")).toBe("not-understood"))
})

describe("convertAmount", () => {
  const cases: ReadonlyArray<readonly [number, Parameters<typeof convertAmount>[1], Parameters<typeof convertAmount>[2], number | undefined]> = [
    [1, "kg", "g", 1000], [250, "g", "kg", 0.25], [1, "lb", "g", 453.59237], [8, "oz", "g", 226.796185], [16, "oz", "lb", 1],
    [2, "l", "ml", 2000], [250, "ml", "dl", 2.5], [1, "l", "cl", 100], [3, "tbsp", "ml", 45], [1, "tbsp", "tsp", 3], [2, "cup", "ml", 500], [1, "cup", "tbsp", 250 / 15],
    [1, "kg", "l", undefined], [1, "pack", "g", undefined], [2, "piece", "g", undefined], [1, "handful", "g", undefined], [1, "g", "pack", undefined]
  ]
  for (const [amount, from, to, expected] of cases)
    it(`${amount} ${from} → ${to}`, () => {
      const got = convertAmount(amount, from, to)
      if (expected === undefined) expect(got).toBeUndefined()
      else expect(got).toBeCloseTo(expected, 5)
    })
  it("a cup is as big as asked", () => {
    expect(convertAmount(1, "cup", "ml", { cupMl: usCupMl })).toBeCloseTo(236.588, 3)
    expect(convertAmount(250, "ml", "cup", { cupMl: 250 })).toBe(1)
    expect(convertAmount(1000, "ml", "cup", { cupMl: usCupMl })).toBeCloseTo(4.2268, 3)
  })
  it("round-trips within rounding", () => {
    for (const [from, to] of [["g", "oz"], ["ml", "cup"], ["kg", "lb"], ["dl", "tsp"]] as const) {
      const there = convertAmount(123.4, from, to)!
      expect(convertAmount(there, to, from)).toBeCloseTo(123.4, 3)
    }
  })
})
