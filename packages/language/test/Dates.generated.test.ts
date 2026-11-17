// Dates and times (review round 3, decision 6): every calendar day of several years in each date form, the date speaker over
// ±400/800 days, generated phrases with their meaning computed by the tests' own calendar, and their mutants.
import { describe, expect, it } from "@effect/vitest"
import { parseDateTime, speakDate, type DateTimeValue } from "../src/index.ts"
import { stable } from "./support/Cfg.ts"
import { generatedParse, mutantsParse, type GrammarCheck } from "./support/Check.ts"
import { plusDays, weekdayOf, type Day } from "./support/Zone.ts"
import { dateGrammar, meaning, type DateReading, type Expected } from "./grammars/dates.ts"

const project = (v: DateTimeValue): Expected => ({
  date: { year: v.date.year, month: v.date.month, day: v.date.day }, weekday: v.weekday,
  ...(v.time !== undefined ? { time: { hour: v.time.hour, minute: v.time.minute, guessed: v.time.guessed, alternatives: v.time.alternatives.map((a) => ({ hour: a.hour, minute: a.minute })) } } : {}),
  ...(v.instant !== undefined ? { instant: v.instant } : {}), ...(v.partOfDay !== undefined ? { partOfDay: v.partOfDay } : {}), inPast: v.inPast
})
const answer = (values: ReadonlyArray<Expected>): unknown => {
  const distinct = [...new Map(values.map((v) => [stable(v), v])).values()]
  if (distinct.length === 0) return "not-understood"
  if (distinct.length === 1) return distinct[0]
  return { ambiguous: distinct.map(stable).sort() }
}
const parsed = (text: string, language: "en" | "nl", now: number, timeZone: string): unknown => {
  const r = parseDateTime(text, language, { now, timeZone })
  if (r.kind === "ok") return project(r.value)
  if (r.kind === "ambiguous") return { ambiguous: r.candidates.map((c) => stable(project(c))).sort() }
  return "not-understood"
}

const english = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const dutch = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"]
const enWeekday = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const nlWeekday = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]
const suffix = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th")

describe("dates: every calendar day of 2000, 2027, 2028 and 2100 in each written form", () => {
  it("both languages, five English and four Dutch forms (14 610 phrases)", () => {
    const now = Date.UTC(2026, 10, 18, 9)
    for (const y of [2000, 2027, 2028, 2100]) {
      for (let d: Day = { year: y, month: 1, day: 1 }; d.year === y; d = plusDays(d, 1)) {
        const wd = weekdayOf(d)
        const en = [`${d.day} ${english[d.month - 1]} ${y}`, `the ${d.day}${suffix(d.day)} of ${english[d.month - 1]} ${y}`, `${english[d.month - 1]} ${d.day}${suffix(d.day)} ${y}`,
          `${enWeekday[wd - 1]} ${d.day} ${english[d.month - 1]} ${y}`, `on ${enWeekday[wd - 1]}, the ${d.day}${suffix(d.day)} of ${english[d.month - 1]} ${y}`]
        const nl = [`${d.day} ${dutch[d.month - 1]} ${y}`, `de ${d.day}e ${dutch[d.month - 1]} ${y}`, `${nlWeekday[wd - 1]} ${d.day} ${dutch[d.month - 1]} ${y}`, `op ${nlWeekday[wd - 1]} ${d.day} ${dutch[d.month - 1]} ${y}`]
        for (const [language, texts] of [["en", en], ["nl", nl]] as const) {
          for (const text of texts) {
            const r = parseDateTime(text, language, { now, timeZone: "Europe/Amsterdam" })
            if (r.kind !== "ok" || stable(r.value.date) !== stable(d)) throw new Error(`"${text}" → ${stable(r)}`)
          }
        }
      }
    }
  })
  it("a weekday that is not the date's, and 29 February of a year without one, are refused", () => {
    const now = Date.UTC(2026, 10, 18, 9)
    expect(parseDateTime("Tuesday 3 March 2027", "en", { now, timeZone: "UTC" }).kind).toBe("not-understood")
    for (const y of [2027, 2100, 2199]) expect(parseDateTime(`29 February ${y}`, "en", { now, timeZone: "UTC" }).kind).toBe("not-understood")
    expect(parseDateTime("29 February 2000", "en", { now, timeZone: "UTC" }).kind).toBe("ok")
  })
})

describe("dates: speakDate reads back to the date", () => {
  for (const language of ["en", "nl"] as const) {
    it(`${language}: from four todays (one in a leap year, one at the end of the range), every day from 400 before to 800 after`, () => {
      for (const today of [{ year: 2026, month: 11, day: 18 }, { year: 2028, month: 2, day: 28 }, { year: 2027, month: 12, day: 31 }, { year: 2199, month: 6, day: 1 }]) {
        const now = Date.UTC(today.year, today.month - 1, today.day, 12)
        for (let k = -400; k <= 800; k++) {
          const d = plusDays(today, k)
          if (d.year > 2199 || d.year < 2000) continue
          const said = speakDate(d, language, today)!
          const r = parseDateTime(said, language, { now, timeZone: "UTC" })
          if (r.kind !== "ok" || stable(r.value.date) !== stable(d)) throw new Error(`${stable(today)} ${stable(d)}: "${said}" → ${stable(r)}`)
        }
      }
    })
  }
})

/** The moments the generated phrases are read at: an ordinary morning, the small hours, both daylight-saving days, the range's ends. */
const moments: ReadonlyArray<{ readonly now: number; readonly zone: string }> = [
  { now: Date.UTC(2026, 10, 18, 9), zone: "Europe/Amsterdam" },
  { now: Date.UTC(2026, 10, 18, 0, 30), zone: "Europe/Amsterdam" },
  { now: Date.UTC(2026, 2, 29, 0, 30), zone: "Europe/Amsterdam" },
  { now: Date.UTC(2026, 9, 25, 0, 30), zone: "Europe/Amsterdam" },
  { now: Date.UTC(2026, 3, 4, 14, 30), zone: "Australia/Sydney" },
  { now: Date.UTC(2199, 11, 30, 12), zone: "UTC" },
  { now: Date.UTC(2000, 0, 1, 12), zone: "UTC" }
]

describe("dates: generated phrases and their mutants", () => {
  for (const language of ["en", "nl"] as const) {
    const grammar = dateGrammar(language)
    moments.forEach(({ now, zone }, k) => {
      const check: GrammarCheck = {
        grammar,
        start: "PHRASE",
        expected: (values) => answer((values as Array<DateReading>).flatMap((r) => meaning(r, now, zone) ?? [])),
        actual: (text) => parsed(text, language, now, zone)
      }
      it(`${language}, ${new Date(now).toISOString()} ${zone}: 600 generated phrases (seed ${50 + k})`, () => expect(generatedParse(check, 600, 50 + k)).toBeGreaterThan(500))
      if (k < 3) it(`${language}, ${new Date(now).toISOString()} ${zone}: every mutant of 40 generated phrases, a third of the insertions (seed ${60 + k})`, () => expect(mutantsParse(check, 40, 60 + k, 1 / 3)).toBeGreaterThan(3000))
    })
  }
})
