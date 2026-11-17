// Times of day (review round 3, decision 6): every clock time in every speaking style reads back; generated phrases and mutants.
import { describe, expect, it } from "@effect/vitest"
import { parseTimeOfDay, speakTime } from "../src/index.ts"
import { stable } from "./support/Cfg.ts"
import { generatedParse, mutantsParse, type GrammarCheck } from "./support/Check.ts"
import { settleReading, timeGrammar, type Reading, type Settled } from "./grammars/times.ts"

const clockOrder = (a: { hour: number; minute: number }, b: { hour: number; minute: number }) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)
const parsed = (text: string, language: "en" | "nl", options?: Parameters<typeof parseTimeOfDay>[2]) => {
  const r = parseTimeOfDay(text, language, options)
  if (r.kind === "ambiguous") return { ambiguous: r.candidates.map((c) => ({ hour: c.hour, minute: c.minute })).sort(clockOrder) }
  return r.kind === "ok" ? { hour: r.value.hour, minute: r.value.minute, guessed: r.value.guessed, alternatives: r.value.alternatives } : r.kind
}

describe("times: every clock time, every style, both languages", () => {
  // The four style and `period` combinations (review round 5, finding 2), each read back with the parser's documented default context:
  // no band given (07:00–21:00), no `afterMinutes`.
  const inDefaultBand = (x: { hour: number; minute: number }) => x.hour * 60 + x.minute >= 420 && x.hour * 60 + x.minute <= 1260
  for (const language of ["en", "nl"] as const) {
    for (const style of ["12h", "24h"] as const) for (const period of [false, true]) {
      it(`${language}, ${style}${period ? " with the part of the day" : ""}: the 1440 times read back as the README promises`, () => {
        for (let m = 0; m < 1440; m++) {
          const t = { hour: Math.floor(m / 60), minute: m % 60 }
          const said = speakTime(t, language, { style, period })!
          // Settled by the words: with `period` always; in the 24-hour style English but 10–12 with minutes ("ten thirty"), Dutch 0 and
          // 13–23; in the 12-hour style English noon and midnight, Dutch middernacht.
          const settled = period ? true
            : style === "24h" ? (language === "en" ? !(t.hour >= 10 && t.hour <= 12 && t.minute !== 0) : t.hour === 0 || t.hour >= 13)
            : t.minute === 0 && (t.hour === 0 || (language === "en" && t.hour === 12))
          const p = parsed(said, language)
          if (typeof p === "string" || "ambiguous" in p) throw new Error(`${language} ${style} ${period} ${stable(t)}: "${said}" → ${stable(p)}`)
          const readings = [{ hour: p.hour, minute: p.minute }, ...p.alternatives].map((x) => ({ hour: x.hour, minute: x.minute })).sort(clockOrder)
          // Open: the same clock reading modulo 12 hours, guessed, as the default band reads it (the time itself among the readings
          // exactly when the band holds it).
          const want = settled ? [t] : [t.hour % 12, (t.hour % 12) + 12].map((hour) => ({ hour, minute: t.minute })).filter(inDefaultBand)
          if (p.guessed === settled || stable(readings) !== stable(want) || (settled && (p.hour !== t.hour || p.minute !== t.minute))) {
            throw new Error(`${language} ${style} ${period} ${stable(t)}: "${said}" → ${stable(p)}`)
          }
        }
      })
    }
  }
})

describe("times: generated phrases and their mutants", () => {
  // Bands and moments beyond the default: some leave out both readings of an open hour, so `ambiguous` results come up with every
  // minute, and each of their candidates is compared with the tests' own settling (review round 4, finding 22).
  const contexts: ReadonlyArray<{ name: string; band?: { from: number; to: number }; after?: number; count: number; mutants: number }> = [
    { name: "the default band", count: 4000, mutants: 200 },
    { name: "09:00–11:00", band: { from: 540, to: 660 }, count: 1500, mutants: 40 },
    { name: "13:00–14:00, after 13:30", band: { from: 780, to: 840 }, after: 810, count: 1500, mutants: 40 },
    { name: "00:00–00:00", band: { from: 0, to: 0 }, count: 1500, mutants: 40 },
    { name: "the whole day, after 18:00", band: { from: 0, to: 1439 }, after: 1080, count: 1500, mutants: 40 }
  ]
  for (const language of ["en", "nl"] as const) {
    for (const ctx of contexts) {
      let ambiguous = 0
      const check: GrammarCheck = {
        grammar: timeGrammar(language),
        start: "TIMEPHRASE",
        expected: (values) => {
          const settled = (values as Array<Reading>).map((v) => settleReading(v, ctx.band, ctx.after))
          const times = [...new Map(settled.filter((s): s is Settled => s !== undefined && s !== "both").map((s) => [stable(s), s])).values()]
          if (times.length === 1 && !settled.includes("both")) return times[0]
          // Ambiguous: every candidate, as a clock time — both readings of an hour the band holds neither of, and every reading.
          const candidates = new Map<string, { hour: number; minute: number }>()
          for (const t of times) candidates.set(stable({ hour: t.hour, minute: t.minute }), { hour: t.hour, minute: t.minute })
          for (const [k, v] of (values as Array<Reading>).entries()) {
            if (settled[k] !== "both") continue
            for (const hour of [v.hour % 12, (v.hour % 12) + 12]) candidates.set(stable({ hour, minute: v.minute }), { hour, minute: v.minute })
          }
          if (candidates.size === 0) return "not-understood"
          ambiguous++
          return { ambiguous: [...candidates.values()].sort(clockOrder) }
        },
        actual: (text) => parsed(text, language, { ...(ctx.band !== undefined ? { band: ctx.band } : {}), ...(ctx.after !== undefined ? { afterMinutes: ctx.after } : {}) })
      }
      it(`${language}, ${ctx.name}: ${ctx.count} generated times (seed 41)`, () => {
        ambiguous = 0
        expect(generatedParse(check, ctx.count, 41)).toBeGreaterThan(ctx.count * 0.85)
        // A band that leaves out readings must give ambiguous answers to compare.
        if (ctx.band !== undefined && ctx.band.to - ctx.band.from < 600) expect(ambiguous).toBeGreaterThan(50)
      })
      it(`${language}, ${ctx.name}: every mutant of ${ctx.mutants} generated times (seed 42)`, () => expect(mutantsParse(check, ctx.mutants, 42)).toBeGreaterThan(ctx.mutants * 100))
    }
  }
  it("the reviewer's case: both candidates keep their minutes", () => {
    expect(parsed("3:15", "en", { band: { from: "09:00", to: "11:00" } })).toEqual({ ambiguous: [{ hour: 3, minute: 15 }, { hour: 15, minute: 15 }] })
    expect(parsed("kwart over drie", "nl", { band: { from: "09:00", to: "11:00" } })).toEqual({ ambiguous: [{ hour: 3, minute: 15 }, { hour: 15, minute: 15 }] })
  })
  it("a band is exactly HH:MM or whole minutes (round 4, finding 19)", () => {
    expect(parsed("7", "en", { band: { from: "0730", to: "2100" } })).toBe("not-understood")
    expect(parsed("7", "en", { band: { from: " 07:30", to: "21:00" } })).toBe("not-understood")
    expect(parsed("7", "en", { band: { from: "07:30", to: "21:00" } })).toMatchObject({ hour: 19, minute: 0, guessed: true })
  })
})
