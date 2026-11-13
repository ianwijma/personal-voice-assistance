import { describe, expect, it } from "@effect/vitest"
import { parseDuration, parseValues } from "../src/ValueParsing.ts"

const S = 1_000
const M = 60 * S
const H = 60 * M

describe("parseValues: numbers (English and Dutch)", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    ["set it to 40", [["40", 40]]],
    ["21.5 degrees please", [["21.5 degrees", 21.5]]],
    ["zet hem op 21,5 graden", [["21,5 graden", 21.5]]],
    ["forty percent", [["forty percent", 40]]],
    ["dim to 40%", [["40%", 40]]],
    ["twenty-one", [["twenty-one", 21]]],
    ["twenty one degrees", [["twenty one degrees", 21]]],
    ["veertig procent", [["veertig procent", 40]]],
    ["eenentwintig graden", [["eenentwintig graden", 21]]],
    ["tweeëntwintig", [["tweeëntwintig", 22]]],
    ["one hundred percent", [["one hundred percent", 100]]],
    ["honderd", [["honderd", 100]]],
    ["half", [["half", 0.5]]],
    ["a quarter", [["a quarter", 0.25]]],
    ["een kwart", [["een kwart", 0.25]]],
    ["zet één lamp aan", [["één", 1]]],
    ["een procent", [["een procent", 1]]],
    ["doe een lamp aan", []],
    ["turn on the lights", []],
    // A number with a unit ranks first.
    ["in the kitchen set 3 lights to 40 percent", [["40 percent", 40], ["3", 3]]]
  ]
  for (const [utterance, expected] of cases) {
    it(utterance, () => {
      expect(parseValues("number", utterance).map((c) => [c.text, c.value])).toEqual(expected)
    })
  }
})

describe("parseValues: durations (English and Dutch)", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    ["set a timer for ten minutes", [["ten minutes", 10 * M]]],
    ["10 minutes", [["10 minutes", 10 * M]]],
    ["30 seconds", [["30 seconds", 30 * S]]],
    ["a minute", [["a minute", M]]],
    ["an hour and a half", [["an hour and a half", 90 * M]]],
    ["two and a half hours", [["two and a half hours", 150 * M]]],
    ["half an hour", [["half an hour", 30 * M]]],
    ["a quarter of an hour", [["a quarter of an hour", 15 * M]]],
    ["one hour twenty minutes", [["one hour twenty minutes", 80 * M]]],
    ["1 hour and 20 minutes", [["1 hour and 20 minutes", 80 * M]]],
    ["tien minuten", [["tien minuten", 10 * M]]],
    ["anderhalf uur", [["anderhalf uur", 90 * M]]],
    ["een kwartier", [["een kwartier", 15 * M]]],
    ["een half uur", [["een half uur", 30 * M]]],
    ["half uur", [["half uur", 30 * M]]],
    ["twee uur en tien minuten", [["twee uur en tien minuten", 130 * M]]],
    ["tweeënhalf uur", [["tweeënhalf uur", 150 * M]]],
    ["een minuut", [["een minuut", M]]],
    ["vijf seconden", [["vijf seconden", 5 * S]]],
    ["turn on the lights", []],
    ["two lights", []]
  ]
  for (const [utterance, expected] of cases) {
    it(utterance, () => {
      expect(parseValues("duration", utterance).map((c) => [c.text, c.value])).toEqual(expected)
    })
  }

  it("parseDuration reads tool input", () => {
    expect(parseDuration("10 minutes")).toBe(10 * M)
    expect(parseDuration("1 hour 30 minutes")).toBe(90 * M)
    expect(parseDuration("45")).toBe(45 * S)
    expect(parseDuration("soon")).toBeUndefined()
  })

  it("is fast: a typical utterance in microseconds", () => {
    const start = performance.now()
    for (let i = 0; i < 1_000; i++) parseValues("duration", "set a timer for one hour and twenty minutes in the kitchen please")
    expect((performance.now() - start) / 1_000).toBeLessThan(0.2)
  })
})
