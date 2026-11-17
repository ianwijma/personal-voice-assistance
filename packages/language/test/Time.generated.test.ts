// Times of day (review round 3, decision 6): every clock time in every speaking style reads back; generated phrases and mutants.
import { describe, expect, it } from "@effect/vitest"
import { parseTimeOfDay, speakTime } from "../src/index.ts"
import { stable } from "./support/Cfg.ts"
import { generatedParse, mutantsParse, type GrammarCheck } from "./support/Check.ts"
import { settleReading, timeGrammar, type Reading } from "./grammars/times.ts"

const parsed = (text: string, language: "en" | "nl", options?: Parameters<typeof parseTimeOfDay>[2]) => {
  const r = parseTimeOfDay(text, language, options)
  return r.kind === "ok" ? { hour: r.value.hour, minute: r.value.minute, guessed: r.value.guessed, alternatives: r.value.alternatives } : r.kind
}

describe("times: every clock time, every style, both languages", () => {
  for (const language of ["en", "nl"] as const) {
    it(`${language}: the 1440 times with the part of the day read back exactly, not guessed`, () => {
      for (let m = 0; m < 1440; m++) {
        const t = { hour: Math.floor(m / 60), minute: m % 60 }
        const said = speakTime(t, language, { period: true })!
        const p = parsed(said, language)
        if (typeof p === "string" || p.hour !== t.hour || p.minute !== t.minute || p.guessed) throw new Error(`${language} ${stable(t)}: "${said}" → ${stable(p)}`)
      }
    })
    it(`${language}: the 1440 times in the 24-hour style read back exactly when the words settle the hour, else to the same clock reading, guessed`, () => {
      const wholeDay = { band: { from: 0, to: 1439 } }
      for (let m = 0; m < 1440; m++) {
        const t = { hour: Math.floor(m / 60), minute: m % 60 }
        const said = speakTime(t, language, { style: "24h" })!
        // Open: English 10–12 without "hundred" ("ten thirty"), Dutch 1–12 ("zeven uur", "twaalf uur dertig").
        const open = language === "en" ? t.hour >= 10 && t.hour <= 12 && t.minute !== 0 : t.hour >= 1 && t.hour <= 12
        const p = parsed(said, language, open ? wholeDay : undefined)
        if (typeof p === "string" || p.guessed !== open) throw new Error(`${language} ${stable(t)}: "${said}" → ${stable(p)}`)
        const readings = [{ hour: p.hour, minute: p.minute }, ...p.alternatives]
        const ok = open ? readings.some((x) => x.hour === t.hour && x.minute === t.minute) && readings.every((x) => x.hour % 12 === t.hour % 12) : p.hour === t.hour && p.minute === t.minute
        if (!ok) throw new Error(`${language} ${stable(t)}: "${said}" → ${stable(p)}`)
      }
    })
    it(`${language}: the 1440 times in the 12-hour style without a part of the day read back to the same clock reading, guessed (noon and midnight exact)`, () => {
      const wholeDay = { band: { from: 0, to: 1439 } }
      for (let m = 0; m < 1440; m++) {
        const t = { hour: Math.floor(m / 60), minute: m % 60 }
        const said = speakTime(t, language)!
        const p = parsed(said, language, wholeDay)
        const exact = t.minute === 0 && (t.hour === 0 || (language === "en" && t.hour === 12))
        if (typeof p === "string") throw new Error(`${language} ${stable(t)}: "${said}" → ${p}`)
        const readings = [{ hour: p.hour, minute: p.minute }, ...p.alternatives]
        if (p.guessed === exact || !readings.some((x) => x.hour === t.hour && x.minute === t.minute) || !readings.every((x) => x.minute === t.minute && x.hour % 12 === t.hour % 12)) {
          throw new Error(`${language} ${stable(t)}: "${said}" → ${stable(p)}`)
        }
      }
    })
  }
})

describe("times: generated phrases and their mutants", () => {
  for (const language of ["en", "nl"] as const) {
    const check: GrammarCheck = {
      grammar: timeGrammar(language),
      start: "TIMEPHRASE",
      expected: (values) => {
        const settled = (values as Array<Reading>).map((v) => settleReading(v))
        const times = [...new Map(settled.filter((s) => s !== undefined && s !== "both").map((s) => [stable(s), s])).values()]
        if (times.length === 1) return times[0]
        if (times.length > 1 || settled.includes("both")) return "ambiguous"
        return "not-understood"
      },
      actual: (text) => parsed(text, language)
    }
    it(`${language}: 4000 generated times (seed 41)`, () => expect(generatedParse(check, 4000, 41)).toBeGreaterThan(3500))
    it(`${language}: every mutant of 200 generated times (seed 42)`, () => expect(mutantsParse(check, 200, 42)).toBeGreaterThan(30_000))
  }
})
