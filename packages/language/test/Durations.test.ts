// Durations (review round 3, decision 3): the package's own grammar per language. Examples (the reviewer's), the speaker over a grid,
// generated phrases and their mutants.
import { describe, expect, it } from "@effect/vitest"
import { parseDuration, speakDuration } from "../src/index.ts"
import { generatedParse, mutantsParse, type GrammarCheck } from "./support/Check.ts"
import { rng } from "./support/Rng.ts"
import { durationGrammar } from "./grammars/durations.ts"

const ms = (text: string, language: "en" | "nl") => {
  const r = parseDuration(text, language)
  return r.kind === "ok" ? r.value : r.kind
}

describe("parseDuration: examples", () => {
  it("finding 1: the closed grammar, fractions kept, no Infinity", () => {
    for (const t of ["not two hours", "two hours please", "less than two hours", "", "0x10", "1e308", "two", "hours", "2 hours 3 hours", "3 minutes 2 hours"]) expect(ms(t, "en"), t).toBe("not-understood")
    for (const t of ["geen twee uur", "minder dan twee uur", "twee uur alsjeblieft"]) expect(ms(t, "nl"), t).toBe("not-understood")
    expect(ms("three quarters of an hour", "en")).toBe(2_700_000)
    expect(ms("1 day 12 hours", "en")).toBe(129_600_000)
    expect(ms("two hours and thirty minutes", "en")).toBe(9_000_000)
    expect(ms("an hour and a half", "en")).toBe(5_400_000)
    expect(ms("1.5 hours", "en")).toBe(5_400_000)
    expect(ms("drie kwartier", "nl")).toBe(2_700_000)
    expect(ms("tweeënhalf uur", "nl")).toBe(9_000_000)
    expect(ms("366 days", "en")).toBe("not-understood")
    expect(ms("0 seconds", "en")).toBe("not-understood")
    expect(ms("two hours", "nl")).toBe("not-understood")
    expect(ms("twee uur", "en")).toBe("not-understood")
  })
})

describe("durations: the speaker reads back over a grid", () => {
  it("every second to an hour, every minute to a day, every hour to a week, every day to 365, and 3000 mixed (seed 31), both languages", () => {
    const grid: Array<number> = []
    for (let s = 1; s <= 3600; s++) grid.push(s * 1000)
    for (let m = 1; m <= 1440; m++) grid.push(m * 60_000)
    for (let h = 1; h <= 168; h++) grid.push(h * 3_600_000)
    for (let d = 1; d <= 365; d++) grid.push(d * 86_400_000)
    const r = rng(31)
    for (let k = 0; k < 3000; k++) grid.push(r.int(1, 365 * 86_400) * 1000)
    for (const language of ["en", "nl"] as const) {
      for (const value of grid) {
        for (const natural of [true, false]) {
          const said = speakDuration(value, language, { natural })!
          if (ms(said, language) !== value) throw new Error(`${language} ${value}: "${said}" reads as ${ms(said, language)}`)
        }
      }
    }
  })
  it("rounds to the second; outside 1 s – 365 days it cannot say it", () => {
    expect(speakDuration(1499, "en")).toBe("1 second")
    for (const v of [0, 499, -1000, 366 * 86_400_000, Number.NaN, Infinity]) expect(speakDuration(v, "en")).toBeUndefined()
  })
})

describe("durations: generated phrases and their mutants", () => {
  for (const language of ["en", "nl"] as const) {
    const check: GrammarCheck = {
      grammar: durationGrammar(language),
      start: "MS",
      expected: (values) => (values.length === 0 ? "not-understood" : values.length === 1 ? values[0] : "ambiguous"),
      actual: (text) => ms(text, language)
    }
    it(`${language}: 3000 generated durations (seed 32)`, () => expect(generatedParse(check, 3000, 32)).toBeGreaterThan(2500))
    it(`${language}: every mutant of 120 generated durations (seed 33)`, () => expect(mutantsParse(check, 120, 33)).toBeGreaterThan(20_000))
  }
})
