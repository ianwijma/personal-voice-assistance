import { describe, expect, it } from "@effect/vitest"
import { parseDateTime, type DateOptions } from "../src/Dates.ts"
import { AMS, ams, hm, iso, NOW } from "./helpers.ts"

const opts: DateOptions = { now: NOW, timeZone: AMS }
const ymd = (d: { year: number; month: number; day: number }) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
const read = (text: string, language: "en" | "nl", options: DateOptions = opts) => {
  const r = parseDateTime(text, language, options)
  if (r.kind === "ok") return `${ymd(r.value.date)}${r.value.time ? " " + hm(r.value.time) : ""}${r.value.partOfDay ? " " + r.value.partOfDay : ""}`
  if (r.kind === "ambiguous") return `ambiguous: ${r.candidates.map((c) => ymd(c.date)).join(" | ")}`
  return "not-understood"
}
// "Now" is Wednesday 2026-11-18 10:00 in Amsterdam.

describe("parseDateTime: English", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["today", "2026-11-18"], ["tomorrow", "2026-11-19"], ["yesterday", "2026-11-17"], ["the day after tomorrow", "2026-11-20"],
    ["tonight", "2026-11-18 night"], ["this evening", "2026-11-18 evening"], ["tomorrow morning", "2026-11-19 morning"], ["tomorrow evening", "2026-11-19 evening"],
    ["on Friday", "2026-11-20"], ["Friday", "2026-11-20"], ["on Wednesday", "2026-11-25"], ["Tuesday", "2026-11-24"], ["this Friday", "2026-11-20"], ["this Wednesday", "2026-11-18"],
    ["this coming Monday", "2026-11-23"], ["next Wednesday", "2026-11-25"], ["Friday next week", "2026-11-27"], ["next week", "not-understood"], ["next week Monday", "2026-11-23"],
    ["next Friday", "ambiguous: 2026-11-20 | 2026-11-27"], ["next Saturday", "ambiguous: 2026-11-21 | 2026-11-28"], ["next Monday", "ambiguous: 2026-11-23 | 2026-11-30"],
    ["the 3rd", "2026-12-03"], ["on the third", "2026-12-03"], ["the 18th", "2026-11-18"], ["the 17th", "2026-12-17"], ["the 31st", "2026-12-31"], ["the twenty first", "2026-11-21"],
    ["3 March", "2027-03-03"], ["March 3rd", "2027-03-03"], ["the 3rd of March", "2027-03-03"], ["March the third", "2027-03-03"], ["3 March 2028", "2028-03-03"],
    ["18 November", "2026-11-18"], ["17 November", "2027-11-17"], ["December 25th", "2026-12-25"], ["1 January", "2027-01-01"], ["29 February", "2028-02-29"], ["29 February 2027", "not-understood"],
    ["in two days", "2026-11-20"], ["in 3 days", "2026-11-21"], ["in a week", "2026-11-25"], ["in two weeks", "2026-12-02"], ["in a month", "2026-12-18"], ["in two months", "2027-01-18"], ["in a year", "2027-11-18"],
    ["tomorrow at five", "2026-11-19 17:00"], ["tomorrow at 5 am", "2026-11-19 05:00"], ["tomorrow at half past seven", "2026-11-19 07:30"], ["tomorrow at 19:30", "2026-11-19 19:30"],
    ["Friday at nine", "2026-11-20 09:00"], ["on Friday at 3 pm", "2026-11-20 15:00"], ["March 3rd at noon", "2027-03-03 12:00"], ["tonight at nine", "2026-11-18 21:00"],
    ["tomorrow evening at eight", "2026-11-19 20:00"], ["tomorrow morning at seven", "2026-11-19 07:00"], ["tomorrow night at eleven", "2026-11-19 23:00"],
    ["at seven", "2026-11-18 19:00"], ["at 11", "2026-11-18 11:00"], ["at 9 am", "2026-11-19 09:00"], ["at nine", "2026-11-18 21:00"], ["at 7:30 pm", "2026-11-18 19:30"], ["at 08:00", "2026-11-19 08:00"],
    ["remind me to call mum tomorrow at 5 pm please", "not-understood"], ["seven", "2026-11-18 19:00"], ["buy 3 apples", "not-understood"], ["banana", "not-understood"], ["", "not-understood"]
  ]
  for (const [text, expected] of rows) it(`"${text}"`, () => expect(read(text, "en")).toBe(expected))

  it("next Friday reports both candidates, each with the time", () => {
    const r = parseDateTime("next Friday at five", "en", opts)
    expect(r.kind).toBe("ambiguous")
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((c) => iso(c.instant!))).toEqual(["2026-11-20T17:00", "2026-11-27T17:00"])
      expect(r.reason).toContain("next friday")
    }
  })
  it("reads the time phrase alone: a sentence around it is not searched", () => {
    expect(read("remind me to call mum tomorrow at five o'clock about the thing", "en")).toBe("not-understood")
    const r = parseDateTime("tomorrow at five o'clock", "en", opts)
    expect(r.kind === "ok" && r.said).toBe("tomorrow at five o'clock")
    expect(r.kind === "ok" && "start" in r.value).toBe(false)
  })
  it("in two hours is a moment from now", () => {
    const r = parseDateTime("in two hours", "en", opts)
    expect(r.kind === "ok" && r.value.instant).toBe(NOW + 2 * 3_600_000)
    const half = parseDateTime("in half an hour", "en", opts)
    expect(half.kind === "ok" && half.value.instant).toBe(NOW + 1_800_000)
    const mins = parseDateTime("in 45 minutes", "en", opts)
    expect(mins.kind === "ok" && mins.value.instant).toBe(NOW + 45 * 60_000)
  })
  it("flags a moment that has passed", () => {
    const r = parseDateTime("today at 8 am", "en", opts)
    expect(r.kind === "ok" && r.value.inPast).toBe(true)
    const f = parseDateTime("today at 3 pm", "en", opts)
    expect(f.kind === "ok" && f.value.inPast).toBe(false)
    expect(parseDateTime("yesterday", "en", opts).kind === "ok" && (parseDateTime("yesterday", "en", opts) as { value: { inPast: boolean } }).value.inPast).toBe(true)
  })
  it("reports that the time was guessed, and the other reading", () => {
    const r = parseDateTime("tomorrow at nine", "en", opts)
    expect(r.kind === "ok" && r.value.time?.guessed).toBe(true)
    expect(r.kind === "ok" && r.value.time?.alternatives).toEqual([{ hour: 21, minute: 0 }])
    const said = parseDateTime("tomorrow at nine pm", "en", opts)
    expect(said.kind === "ok" && said.value.time?.guessed).toBe(false)
  })
  it("month and year boundaries", () => {
    const dec = { now: ams(2026, 12, 30, 10), timeZone: AMS }
    expect(read("tomorrow", "en", dec)).toBe("2026-12-31")
    expect(read("in two days", "en", dec)).toBe("2027-01-01")
    expect(read("the 1st", "en", dec)).toBe("2027-01-01")
    expect(read("3 March", "en", dec)).toBe("2027-03-03")
    expect(read("in a month", "en", dec)).toBe("2027-01-30")
    const jan31 = { now: ams(2027, 1, 31, 10), timeZone: AMS }
    expect(read("in a month", "en", jan31)).toBe("2027-02-28")
    expect(read("the 31st", "en", { now: ams(2027, 2, 10, 10), timeZone: AMS })).toBe("2027-03-31")
    expect(read("the 30th", "en", { now: ams(2027, 2, 10, 10), timeZone: AMS })).toBe("2027-03-30")
    const leap = { now: ams(2027, 3, 1, 10), timeZone: AMS }
    expect(read("29 February", "en", leap)).toBe("2028-02-29")
    expect(read("in a year", "en", { now: ams(2028, 2, 29, 10), timeZone: AMS })).toBe("2029-02-28")
  })
  it("a time late in the evening: the date follows the zone, not UTC", () => {
    const late = { now: ams(2026, 11, 18, 23, 30), timeZone: AMS } // 22:30 UTC the same day
    expect(read("tomorrow", "en", late)).toBe("2026-11-19")
    expect(read("at seven", "en", late)).toBe("2026-11-19 07:00")
    const tokyo = { now: Date.UTC(2026, 10, 18, 20, 0), timeZone: "Asia/Tokyo" } // already the 19th there
    expect(read("today", "en", tokyo)).toBe("2026-11-19")
  })
})

describe("parseDateTime: Dutch", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["vandaag", "2026-11-18"], ["morgen", "2026-11-19"], ["overmorgen", "2026-11-20"], ["gisteren", "2026-11-17"], ["vanavond", "2026-11-18 evening"], ["vanmiddag", "2026-11-18 afternoon"],
    ["morgenochtend", "2026-11-19 morning"], ["morgenavond", "2026-11-19 evening"], ["morgen ochtend", "2026-11-19 morning"], ["morgen avond", "2026-11-19 evening"],
    ["op vrijdag", "2026-11-20"], ["vrijdag", "2026-11-20"], ["woensdag", "2026-11-25"], ["deze vrijdag", "2026-11-20"], ["aanstaande maandag", "2026-11-23"], ["komende zaterdag", "2026-11-21"],
    ["volgende vrijdag", "ambiguous: 2026-11-20 | 2026-11-27"], ["volgende woensdag", "2026-11-25"], ["vrijdag volgende week", "2026-11-27"], ["volgende week", "not-understood"], ["vrijdag over een week", "2026-11-27"],
    ["de derde", "2026-12-03"], ["op de derde", "2026-12-03"], ["de 3e", "2026-12-03"], ["de 18e", "2026-11-18"], ["de eenentwintigste", "2026-11-21"],
    ["3 maart", "2027-03-03"], ["op 3 maart", "2027-03-03"], ["de derde maart", "2027-03-03"], ["drie maart", "2027-03-03"], ["3 maart 2028", "2028-03-03"], ["25 december", "2026-12-25"], ["31 april", "not-understood"], ["1 mei", "2027-05-01"],
    ["over twee dagen", "2026-11-20"], ["over twee weken", "2026-12-02"], ["over een week", "2026-11-25"], ["over een maand", "2026-12-18"], ["over drie maanden", "2027-02-18"], ["in twee dagen", "2026-11-20"], ["over een jaar", "2027-11-18"],
    ["morgen om vijf uur", "2026-11-19 17:00"], ["morgen om 5 uur 's ochtends", "2026-11-19 05:00"], ["vrijdag om half acht", "2026-11-20 07:30"], ["vrijdag om half acht 's avonds", "2026-11-20 19:30"],
    ["morgenavond om acht uur", "2026-11-19 20:00"], ["morgenochtend om negen uur", "2026-11-19 09:00"], ["vanavond om tien uur", "2026-11-18 22:00"], ["3 maart om kwart voor zeven", "2027-03-03 18:45"], ["3 maart om kwart voor zeven 's avonds", "2027-03-03 18:45"],
    ["om zeven uur", "2026-11-18 19:00"], ["om half acht", "2026-11-18 19:30"], ["om 9 uur", "2026-11-18 21:00"], ["om 19:30", "2026-11-18 19:30"], ["zet een wekker voor morgen om kwart over zeven", "not-understood"], ["morgen om kwart over zeven", "2026-11-19 07:15"],
    ["boodschappen doen", "not-understood"], ["", "not-understood"]
  ]
  for (const [text, expected] of rows) it(`"${text}"`, () => expect(read(text, "nl")).toBe(expected))

  it("over twee uur and over een kwartier are moments from now", () => {
    const a = parseDateTime("over twee uur", "nl", opts)
    expect(a.kind === "ok" && a.value.instant).toBe(NOW + 2 * 3_600_000)
    const b = parseDateTime("over een kwartier", "nl", opts)
    expect(b.kind === "ok" && b.value.instant).toBe(NOW + 900_000)
    const c = parseDateTime("over anderhalf uur", "nl", opts)
    expect(c.kind === "ok" && c.value.instant).toBe(NOW + 5_400_000)
    const d = parseDateTime("over een half uur", "nl", opts)
    expect(d.kind === "ok" && d.value.instant).toBe(NOW + 1_800_000)
  })
})

describe("parseDateTime: daylight-saving days in Europe/Amsterdam", () => {
  // Clocks go forward on Sunday 2027-03-28 (02:00 → 03:00) and back on Sunday 2026-10-25 (03:00 → 02:00).
  it("the day before the jump: 'tomorrow at 2:30' does not exist and moves forward", () => {
    const now = ams(2027, 3, 27, 12)
    const r = parseDateTime("tomorrow at 2:30 am", "en", { now, timeZone: AMS })
    expect(r.kind === "ok" && iso(r.value.instant!)).toBe("2027-03-28T03:30")
    expect(r.kind === "ok" && r.value.instant).toBe(Date.UTC(2027, 2, 28, 1, 30))
  })
  it("a normal time on the jump day keeps the wall clock", () => {
    const now = ams(2027, 3, 27, 12)
    const r = parseDateTime("tomorrow at 9 am", "en", { now, timeZone: AMS })
    expect(r.kind === "ok" && r.value.instant).toBe(Date.UTC(2027, 2, 28, 7, 0))
    const same = parseDateTime("today at 9 am", "en", { now: ams(2027, 3, 26, 12), timeZone: AMS })
    expect(same.kind === "ok" && same.value.instant).toBe(Date.UTC(2027, 2, 26, 8, 0))
  })
  it("a time that happens twice is the first one", () => {
    const now = ams(2026, 10, 24, 12)
    const r = parseDateTime("tomorrow at 2:30 am", "en", { now, timeZone: AMS })
    expect(r.kind === "ok" && r.value.instant).toBe(Date.UTC(2026, 9, 25, 0, 30)) // 02:30 CEST
  })
  it("in two hours is two real hours across the jump", () => {
    const now = Date.UTC(2027, 2, 28, 0, 30) // 01:30 CET
    const r = parseDateTime("in two hours", "en", { now, timeZone: AMS })
    expect(r.kind === "ok" && r.value.instant).toBe(now + 2 * 3_600_000)
    expect(r.kind === "ok" && hm(r.value.time!)).toBe("04:30")
  })
  it("in a week keeps the calendar day across the jump", () => {
    const r = parseDateTime("in a week at 9 am", "en", { now: ams(2027, 3, 24, 12), timeZone: AMS })
    expect(r.kind === "ok" && iso(r.value.instant!)).toBe("2027-03-31T09:00")
  })
})
