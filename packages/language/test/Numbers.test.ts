import { describe, expect, it } from "@effect/vitest"
import { digitValue, nlWord, readAmount, readNumber } from "../src/Numbers.ts"
import { tokenize } from "../src/Tokens.ts"

const num = (text: string, language: "en" | "nl") => {
  const r = readNumber(tokenize(text), 0, language)
  return r === undefined ? undefined : [r.value, r.next]
}
const amount = (text: string, language: "en" | "nl") => {
  const r = readAmount(tokenize(text), 0, language)
  return r === undefined ? undefined : [r.value, r.next]
}

describe("readNumber", () => {
  const en: ReadonlyArray<readonly [string, number, number]> = [
    ["seven", 7, 1], ["fifteen", 15, 1], ["twenty", 20, 1], ["twenty five", 25, 2], ["twenty-five", 25, 2], ["ninety nine", 99, 2], ["one hundred", 100, 2], ["a hundred", 100, 2],
    ["one hundred and fifty", 150, 4], ["two hundred fifty", 250, 3], ["three hundred and fifty grams", 350, 4], ["one thousand", 1000, 2], ["two thousand five hundred", 2500, 4], ["a thousand", 1000, 2],
    ["zero", 0, 1], ["250", 250, 1], ["2.5", 2.5, 1], ["1,500", 1500, 1], ["seven thirty", 7, 1], ["nineteen thirty", 19, 1], ["fifty five and", 55, 2]
  ]
  for (const [text, value, next] of en) it(`en "${text}"`, () => expect(num(text, "en")).toEqual([value, next]))
  const nl: ReadonlyArray<readonly [string, number, number]> = [
    ["zeven", 7, 1], ["vijftien", 15, 1], ["twintig", 20, 1], ["eenentwintig", 21, 1], ["tweeëntwintig", 22, 1], ["vijfentwintig", 25, 1], ["negenennegentig", 99, 1],
    ["honderd", 100, 1], ["honderdvijftig", 150, 1], ["tweehonderd", 200, 1], ["tweehonderdvijftig", 250, 1], ["twee honderd", 200, 2], ["honderd vijftig", 150, 2], ["duizend", 1000, 1],
    ["tweeduizenddriehonderd", 2300, 1], ["250", 250, 1], ["2,5", 2.5, 1], ["1.500", 1500, 1], ["tweeënhalf", 2.5, 1], ["een", 1, 1]
  ]
  for (const [text, value, next] of nl) it(`nl "${text}"`, () => expect(num(text, "nl")).toEqual([value, next]))
  for (const bad of ["", "apple", "hundred", "and", "thousand", "twenty-"]) it(`en "${bad}" is no number`, () => {
    const r = num(bad, "en")
    if (bad === "twenty-") expect(r).toEqual([20, 1])
    else expect(r).toBeUndefined()
  })
  it("digitValue reads thousands and decimals by language", () => {
    expect(digitValue("1,500", "en")).toBe(1500)
    expect(digitValue("1.500", "nl")).toBe(1500)
    expect(digitValue("1,5", "en")).toBe(1.5)
    expect(digitValue("1.5", "nl")).toBe(1.5)
    expect(digitValue("2,5", "nl")).toBe(2.5)
    expect(digitValue("1,234,567", "en")).toBe(1234567)
    expect(digitValue("1:30", "en")).toBeUndefined()
  })
  it("nlWord", () => {
    expect(nlWord("zeventien")).toBe(17)
    expect(nlWord("drieënzestig".normalize("NFD").replace(/\p{M}/gu, ""))).toBe(63)
    expect(nlWord("appel")).toBeUndefined()
  })
})

describe("readAmount", () => {
  const rows: ReadonlyArray<readonly [string, "en" | "nl", number, number]> = [
    ["half", "en", 0.5, 1], ["a half", "en", 0.5, 2], ["a quarter", "en", 0.25, 2], ["three quarters", "en", 0.75, 2], ["one and a half", "en", 1.5, 4], ["two and a half", "en", 2.5, 4],
    ["a", "en", 1, 1], ["an", "en", 1, 1], ["2", "en", 2, 1],
    ["half", "nl", 0.5, 1], ["een half", "nl", 0.5, 2], ["halve", "nl", 0.5, 1], ["een kwart", "nl", 0.25, 2], ["driekwart", "nl", 0.75, 1], ["drie kwart", "nl", 0.75, 2], ["anderhalf", "nl", 1.5, 1], ["anderhalve", "nl", 1.5, 1],
    ["twee en een half", "nl", 2.5, 4], ["tweeënhalf", "nl", 2.5, 1], ["een", "nl", 1, 1]
  ]
  for (const [text, language, value, next] of rows) it(`${language} "${text}"`, () => expect(amount(text, language)).toEqual([value, next]))
})
