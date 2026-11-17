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

describe("durations: decimal amounts of every unit, enumerated, compared in exact arithmetic (round 4, finding 5)", () => {
  // Every amount in hundredths near 0, every one just below each unit's 365-day limit, and 3000 between, in digits in both languages:
  // the value is computed with BigInt, so a floating-point tolerance in the parser cannot hide behind the same one in the test.
  const unitMs: Record<string, bigint> = { week: 604_800_000n, day: 86_400_000n, hour: 3_600_000n, minute: 60_000n, second: 1000n, quarter: 900_000n }
  const names: Record<"en" | "nl", Record<string, string>> = {
    en: { week: "weeks", day: "days", hour: "hours", minute: "minutes", second: "seconds" },
    nl: { week: "weken", day: "dagen", hour: "uur", minute: "minuten", second: "seconden", quarter: "kwartier" }
  }
  const limit = 365n * 86_400_000n * 100n
  for (const language of ["en", "nl"] as const) {
    it(`${language}: every unit`, () => {
      const r = rng(34)
      let checked = 0
      for (const [unit, word] of Object.entries(names[language])) {
        // The largest amount said in digits is 999 999.99: the top of the range is the unit's limit or that, whichever is lower.
        const hi = Math.min(Number(limit / unitMs[unit]!) + 50, 99_999_999)
        const amounts = new Set<number>()
        for (let h = 1; h <= 2000; h++) amounts.add(h)
        for (let h = Math.max(1, hi - 2050); h <= hi; h++) amounts.add(h)
        for (let k = 0; k < 3000; k++) amounts.add(r.int(1, hi))
        for (const h of amounts) {
          const whole = Math.floor(h / 100)
          const frac = h % 100
          const digits = `${whole}${frac === 0 ? "" : (language === "en" ? "." : ",") + String(frac).padStart(2, "0").replace(/0$/, "")}`
          const exact = BigInt(h) * unitMs[unit]!
          const want = exact <= limit ? Number(exact / 100n) : "not-understood"
          const got = ms(`${digits} ${word}`, language)
          if (got !== want) throw new Error(`${language} "${digits} ${word}": ${want} expected, ${got} read`)
          checked++
        }
      }
      expect(checked).toBeGreaterThan(30_000)
    })
  }
  it("the reviewer's phrases, also inside a date", () => {
    expect(ms("128.05 days", "en")).toBe(11_063_520_000)
    expect(ms("128,05 dagen", "nl")).toBe(11_063_520_000)
    expect(ms("16.08 weeks", "en")).toBe(9_725_184_000)
    expect(ms("16,08 weken", "nl")).toBe(9_725_184_000)
    expect(ms("4096.02 hours", "en")).toBe(14_745_672_000)
    expect(ms("4096,02 uur", "nl")).toBe(14_745_672_000)
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
