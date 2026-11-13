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
    ["twenty-one", [["twenty one", 21]]],
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

describe("parseValues: signed numbers keep their sign (review finding 7)", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    ["-5 degrees", [["-5 degrees", -5]]],
    ["minus five degrees", [["minus five degrees", -5]]],
    ["negative 5", [["negative 5", -5]]],
    ["set it to -21.5", [["-21.5", -21.5]]],
    ["set it to −3", [["−3", -3]]],
    ["dim the kitchen to -5 percent", [["-5 percent", -5]]],
    ["min vijf graden", [["min vijf graden", -5]]],
    ["zet hem op minus 2,5 graden", [["minus 2,5 graden", -2.5]]],
    ["negatief tien", [["negatief tien", -10]]],
    // Not signs: a hyphen between two numbers (one expression with no single reading, round 3), and a hyphenated number word.
    ["rooms 3-5", [["3-5", Number.NaN]]],
    ["twenty-one", [["twenty one", 21]]]
  ]
  for (const [utterance, expected] of cases) {
    it(utterance, () => {
      expect(parseValues("number", utterance).map((c) => [c.text, c.value])).toEqual(expected)
    })
  }
  it("negative durations are not durations", () => {
    expect(parseValues("duration", "set a timer for minus 5 minutes").every((c) => c.value < 0)).toBe(true)
    expect(parseValues("duration", "set a timer for 10 min").map((c) => c.value)).toEqual([10 * M])
    expect(parseDuration("-5 minutes")).toBeUndefined()
    expect(parseDuration("-5")).toBeUndefined()
  })
})

// Rule: a number is read as a whole. A compound phrase is one candidate with its full
// value, or (when it cannot be read whole) one candidate no parameter accepts; a valid
// smaller part of a larger number is never offered on its own.
describe("parseValues: compound numbers are read whole (review round 2, finding D)", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    ["dim the kitchen to one hundred forty percent", [["one hundred forty percent", 140]]],
    ["dim the kitchen to one hundred and forty percent", [["one hundred and forty percent", 140]]],
    ["dim the kitchen to two hundred percent", [["two hundred percent", 200]]],
    ["a hundred percent", [["a hundred percent", 100]]],
    ["hundred forty five", [["hundred forty five", 145]]],
    ["nineteen hundred", [["nineteen hundred", 1900]]],
    ["two thousand five hundred and twelve", [["two thousand five hundred and twelve", 2512]]],
    ["three million", [["three million", 3_000_000]]],
    ["zet de keuken op honderdveertig procent", [["honderdveertig procent", 140]]],
    ["zet de keuken op honderd veertig procent", [["honderd veertig procent", 140]]],
    ["zet de keuken op tweehonderd procent", [["tweehonderd procent", 200]]],
    ["zet de keuken op twee honderd procent", [["twee honderd procent", 200]]],
    ["honderdeenentwintig", [["honderdeenentwintig", 121]]],
    ["tweehonderdvijfenveertig", [["tweehonderdvijfenveertig", 245]]],
    ["duizend", [["duizend", 1000]]],
    ["tweeduizend driehonderd", [["tweeduizend driehonderd", 2300]]],
    ["vijf en twintig procent", [["vijf en twintig procent", 25]]],
    ["anderhalf procent", [["anderhalf procent", 1.5]]],
    ["tweeënhalf procent", [["tweeënhalf procent", 2.5]]],
    ["twee en een half procent", [["twee en een half procent", 2.5]]],
    ["one and a half percent", [["one and a half percent", 1.5]]],
    ["twenty one point five degrees", [["twenty one point five degrees", 21.5]]],
    ["eenentwintig komma vijf graden", [["eenentwintig komma vijf graden", 21.5]]],
    ["dim 3 lights in kitchen to one hundred forty percent", [["one hundred forty percent", 140], ["3", 3]]],
    ["zet 3 lampen op honderdveertig procent", [["honderdveertig procent", 140], ["3", 3]]],
    // Two numbers with nothing between them are one expression with no single reading (round 3).
    ["five five", [["five five", Number.NaN]]],
    ["rooms 3 and 5", [["3 and 5", Number.NaN]]]
  ]
  for (const [utterance, expected] of cases) {
    it(utterance, () => {
      expect(parseValues("number", utterance).map((c) => [c.text, c.value])).toEqual(expected)
    })
  }
  it("a thousands separator (or a decimal point: it depends on the language) is one value no parameter takes", () => {
    for (const [utterance, text] of [["dim to 1,000 percent", "1,000 percent"], ["zet op 1.000 procent", "1.000 procent"], ["set it to 1,000,000", "1,000,000"]] as const) {
      const found = parseValues("number", utterance)
      expect(found.map((c) => c.text)).toEqual([text])
      expect(Number.isNaN(found[0]!.value)).toBe(true)
    }
    expect(parseValues("number", "set it to 0.125").map((c) => c.value)).toEqual([0.125])
    expect(parseValues("number", "set it to 21.5").map((c) => c.value)).toEqual([21.5])
  })
  it("durations read compound numbers whole too", () => {
    expect(parseValues("duration", "one hundred twenty seconds").map((c) => [c.text, c.value])).toEqual([["one hundred twenty seconds", 120 * S]])
    expect(parseValues("duration", "honderdtwintig seconden").map((c) => c.value)).toEqual([120 * S])
    expect(parseValues("duration", "a hundred minutes").map((c) => c.value)).toEqual([100 * M])
    expect(parseValues("duration", "two and a half hours").map((c) => c.value)).toEqual([150 * M])
  })
})

// Rule: a minus sign belongs to the number after it, also when a space separates them,
// unless it joins two numbers (a range or a subtraction: "3 - 5", "three - five").
describe("parseValues: a minus sign separated by a space (review round 2, finding I)", () => {
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    ["dim the kitchen to - 5 percent", [["- 5 percent", -5]]],
    ["dim the kitchen to − 5 percent", [["− 5 percent", -5]]],
    ["set it to - 21.5", [["- 21.5", -21.5]]],
    ["zet hem op -  vijf graden", [["- vijf graden", -5]]],
    ["- 5", [["- 5", -5]]],
    ["rooms 3 - 5", [["3 - 5", Number.NaN]]],
    ["three − five", [["three − five", Number.NaN]]],
    ["twenty-one", [["twenty one", 21]]]
  ]
  for (const [utterance, expected] of cases) {
    it(utterance, () => {
      expect(parseValues("number", utterance).map((c) => [c.text, c.value])).toEqual(expected)
    })
  }
  it("durations", () => {
    expect(parseValues("duration", "set a timer for - 5 minutes").map((c) => c.value)).toEqual([-5 * M])
    expect(parseValues("duration", "set a timer for − 10 seconds").map((c) => c.value)).toEqual([-10 * S])
    expect(parseDuration("- 5 minutes")).toBeUndefined()
  })
})

// Review round 3, finding 4. THE RULE: a connected numeric expression is one span; either the
// whole span reads as exactly one value, or the whole span is one invalid candidate (NaN). No
// part of a rejected span is ever offered. NaN below = "invalid, whole span".
describe("parseValues: a numeric expression is one value or one invalid span (review round 3)", () => {
  const NaN_ = Number.NaN
  const numbers: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    // The reviewer's cases.
    ["dim to one hundred 40 percent", [["one hundred 40 percent", NaN_]]],
    ["dim to one point twenty five percent", [["one point twenty five percent", NaN_]]],
    ["dim to 1.234,5 percent", [["1.234,5 percent", NaN_]]],
    // Mixed digits and words.
    ["40 five", [["40 five", NaN_]]],
    ["forty 5 percent", [["forty 5 percent", NaN_]]],
    ["twenty 1", [["twenty 1", NaN_]]],
    ["1 hundred", [["1 hundred", 100]]],
    ["2 thousand", [["2 thousand", 2000]]],
    ["veertig 5 procent", [["veertig 5 procent", NaN_]]],
    ["honderd 40 procent", [["honderd 40 procent", NaN_]]],
    // Fractions and decimals.
    ["one point five percent", [["one point five percent", 1.5]]],
    ["one point two five", [["one point two five", 1.25]]],
    ["21 point 5", [["21 point 5", 21.5]]],
    ["point five", [["point five", NaN_]]],
    ["eenentwintig komma twintig", [["eenentwintig komma twintig", NaN_]]],
    ["twee komma vijf procent", [["twee komma vijf procent", 2.5]]],
    ["one and a half and a half", [["one and a half and a half", NaN_]]],
    ["half percent", [["half percent", 0.5]]],
    ["een half procent", [["een half procent", 0.5]]],
    // Separators.
    ["21.5.3 degrees", [["21.5.3 degrees", NaN_]]],
    ["1,000,000", [["1,000,000", NaN_]]],
    ["1.000,00 procent", [["1.000,00 procent", NaN_]]],
    ["0,5 procent", [["0,5 procent", 0.5]]],
    ["1234.5", [["1234.5", 1234.5]]],
    // Signs.
    ["minus minus five", [["minus minus five", NaN_]]],
    ["- minus 5", [["- minus 5", NaN_]]],
    ["five minus three", [["five minus three", NaN_]]],
    ["min vijf procent", [["min vijf procent", -5]]],
    // Units.
    ["40 percent 5", [["40 percent 5", NaN_]]],
    ["40% percent", [["40% percent", NaN_]]],
    ["40 percent percent", [["40 percent percent", NaN_]]],
    ["40% 50%", [["40% 50%", NaN_]]],
    // Separate expressions stay separate; a dangling connector is not part of one.
    ["set 3 lights to 40 percent", [["40 percent", 40], ["3", 3]]],
    ["40 percent and the kitchen", [["40 percent", 40]]],
    ["one of the lights", [["one", 1]]],
    ["zet één lamp op 40", [["één", 1], ["40", 40]]],
    // A duration is not a number.
    ["in ten minutes", []],
    ["40 percent in ten minutes", [["40 percent", 40]]]
  ]
  for (const [utterance, expected] of numbers) {
    it(`number: ${utterance}`, () => {
      expect(parseValues("number", utterance).map((c) => [c.text, c.value])).toEqual(expected)
    })
  }
  const durations: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
    ["ten minutes five", [["ten minutes five", NaN_]]],
    ["ten minutes 40 percent", [["ten minutes 40 percent", NaN_]]],
    ["one hundred 20 seconds", [["one hundred 20 seconds", NaN_]]],
    ["one point five minutes", [["one point five minutes", 90 * S]]],
    ["anderhalf uur en tien minuten", [["anderhalf uur en tien minuten", 100 * M]]],
    ["tien minuten min vijf", [["tien minuten min vijf", NaN_]]],
    ["5 minutes and", [["5 minutes", 5 * M]]],
    ["a minute and a half", [["a minute and a half", 90 * S]]],
    ["2 hours 1.234,5 minutes", [["2 hours 1.234,5 minutes", NaN_]]],
    ["minutes", []],
    ["the second light", []],
    ["40 percent", []]
  ]
  for (const [utterance, expected] of durations) {
    it(`duration: ${utterance}`, () => {
      expect(parseValues("duration", utterance).map((c) => [c.text, c.value])).toEqual(expected)
    })
  }
  it("a candidate's offsets are its span in the sentence, sign and % included", () => {
    const text = "dim the kitchen to -40% now"
    const [c] = parseValues("number", text)
    expect(c).toMatchObject({ text: "-40%", value: -40 })
    expect(text.slice(c!.start, c!.end)).toBe("-40%")
  })
  it("parseDuration takes exactly one duration", () => {
    expect(parseDuration("10 minutes 5")).toBeUndefined()
    expect(parseDuration("10 minutes and 5 minutes")).toBe(15 * M)
    expect(parseDuration("5 5")).toBeUndefined()
  })
})
