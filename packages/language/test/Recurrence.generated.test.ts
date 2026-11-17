// Spoken recurrence (review round 3, decision 6): generated phrases and their mutants against the tests' own grammar and meaning.
import { describe, expect, it, vi } from "@effect/vitest"
import { parseRecurrence, type Recurrence } from "../src/index.ts"
import { stable } from "./support/Cfg.ts"
import { generatedParse, mutantsParse, type GrammarCheck } from "./support/Check.ts"
import { agree } from "./support/Agree.ts"
import { recurrenceGrammar, recurrenceMeaning, type RecurrenceMeaning, type RecurrenceReading } from "./grammars/recurrence.ts"

// Generated cases by the hundred: slow on a shared CI runner, so these tests get more than the default five seconds.
vi.setConfig({ testTimeout: 60_000 })

const project = (r: Recurrence): RecurrenceMeaning => ({
  rrule: r.rrule, dtstart: r.dtstart,
  start: { year: r.start.year, month: r.start.month, day: r.start.day, hour: r.start.hour, minute: r.start.minute, second: r.start.second ?? 0 },
  ...(r.time !== undefined ? { time: { hour: r.time.hour, minute: r.time.minute, guessed: r.time.guessed, alternatives: r.time.alternatives.map((a) => ({ hour: a.hour, minute: a.minute })) } } : {}),
  ...(r.partOfDay !== undefined ? { partOfDay: r.partOfDay } : {}), timeDefaulted: r.timeDefaulted
})
const moments: ReadonlyArray<{ readonly now: number; readonly zone: string }> = [
  { now: Date.UTC(2026, 10, 18, 9), zone: "Europe/Amsterdam" },
  { now: Date.UTC(2026, 2, 28, 23, 30), zone: "Europe/Amsterdam" },
  { now: Date.UTC(2026, 3, 4, 14, 30), zone: "Australia/Sydney" },
  { now: Date.UTC(2199, 11, 20, 12), zone: "UTC" },
  // A gap that crosses midnight: Nuuk's clocks go from 23:00 on Saturday 28 March 2026 to 00:00 (review round 5, finding 1).
  { now: Date.UTC(2026, 2, 28, 12), zone: "America/Nuuk" },
  // The autumn fold: 02:00–03:00 on 25 October 2026 happens twice in Amsterdam (round 5, finding 5: both readings).
  { now: Date.UTC(2026, 9, 24, 12), zone: "Europe/Amsterdam" }
]

describe("recurrence: generated phrases and their mutants", () => {
  for (const language of ["en", "nl"] as const) {
    const grammar = recurrenceGrammar(language)
    moments.forEach(({ now, zone }, k) => {
      const check: GrammarCheck = {
        grammar,
        start: "PHRASE",
        expected: (values) => {
          const all = [...new Map((values as Array<RecurrenceReading>).map((r) => recurrenceMeaning(r, now, zone)).filter((m) => m !== undefined).map((m) => [stable(m), m])).values()]
          return all.length === 0 ? "not-understood" : all.length === 1 ? all[0] : { ambiguous: all.map(stable).sort() }
        },
        actual: (text) => {
          const r = parseRecurrence(text, language, { now, timeZone: zone })
          if (r.kind === "ok") agree(r.value, zone)
          if (r.kind === "ambiguous") for (const c of r.candidates) agree(c, zone)
          return r.kind === "ok" ? project(r.value) : r.kind === "ambiguous" ? { ambiguous: r.candidates.map((c) => stable(project(c))).sort() } : "not-understood"
        }
      }
      it(`${language}, ${new Date(now).toISOString()} ${zone}: 500 generated phrases (seed ${80 + k})`, () => expect(generatedParse(check, 500, 80 + k)).toBeGreaterThan(400))
      if (k < 2) it(`${language}, ${new Date(now).toISOString()} ${zone}: every mutant of 40 generated phrases, a third of the insertions (seed ${90 + k})`, () => expect(mutantsParse(check, 40, 90 + k, 1 / 3)).toBeGreaterThan(3000))
    })
  }
})
