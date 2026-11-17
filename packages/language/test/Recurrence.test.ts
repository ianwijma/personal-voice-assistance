import { describe, expect, it } from "@effect/vitest"
import { parseRecurrence, type RecurrenceOptions } from "../src/Recurrence.ts"
import { describeRRule, formatRRule, nextOccurrence, occurrencesAfter, parseDtstart, parseRRule, type RecurrenceSpec } from "../src/Rrule.ts"
import { AMS, ams, dtstartOf, iso, NOW } from "./helpers.ts"

/** The instants of `occurrencesAfter` (round 3: it also says why it stopped). */
const occ = (...a: Parameters<typeof occurrencesAfter>): Array<number> => [...(occurrencesAfter(...a)?.instants ?? [])]

const opts: RecurrenceOptions = { now: NOW, timeZone: AMS } // Wednesday 2026-11-18 10:00
const read = (text: string, language: "en" | "nl", options: RecurrenceOptions = opts) => {
  const r = parseRecurrence(text, language, options)
  return r.kind === "ok" ? `${r.value.rrule} @ ${r.value.dtstart.replace("DTSTART;TZID=Europe/Amsterdam:", "")}` : r.kind
}

describe("parseRecurrence: English", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["every day", "FREQ=DAILY @ 20261119T090000"], ["daily", "FREQ=DAILY @ 20261119T090000"], ["each day", "FREQ=DAILY @ 20261119T090000"],
    ["every weekday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR @ 20261119T090000"], ["on weekdays", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR @ 20261119T090000"],
    ["every weekend", "FREQ=WEEKLY;BYDAY=SA,SU @ 20261121T090000"],
    ["every Monday", "FREQ=WEEKLY;BYDAY=MO @ 20261123T090000"], ["mondays", "FREQ=WEEKLY;BYDAY=MO @ 20261123T090000"], ["every Wednesday", "FREQ=WEEKLY;BYDAY=WE @ 20261125T090000"],
    ["every Monday and Wednesday", "FREQ=WEEKLY;BYDAY=MO,WE @ 20261120T090000".replace("20261120", "20261123")],
    ["every Monday, Wednesday and Friday", "FREQ=WEEKLY;BYDAY=MO,WE,FR @ 20261120T090000"],
    ["every second Tuesday", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU @ 20261124T090000"], ["every other Tuesday", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU @ 20261124T090000"],
    ["every 2nd Tuesday", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU @ 20261124T090000"], ["every third Friday", "FREQ=WEEKLY;INTERVAL=3;BYDAY=FR @ 20261120T090000"],
    ["every other week", "FREQ=WEEKLY;INTERVAL=2 @ 20261125T090000"], ["every two weeks", "FREQ=WEEKLY;INTERVAL=2 @ 20261125T090000"], ["fortnightly", "FREQ=WEEKLY;INTERVAL=2 @ 20261125T090000"],
    ["every 3 weeks on Monday", "FREQ=WEEKLY;INTERVAL=3;BYDAY=MO @ 20261123T090000"], ["weekly", "FREQ=WEEKLY @ 20261125T090000"], ["every week", "FREQ=WEEKLY @ 20261125T090000"],
    ["every other day", "FREQ=DAILY;INTERVAL=2 @ 20261119T090000"], ["every 3 days", "FREQ=DAILY;INTERVAL=3 @ 20261119T090000"], ["every three days", "FREQ=DAILY;INTERVAL=3 @ 20261119T090000"],
    ["on the first of the month", "FREQ=MONTHLY;BYMONTHDAY=1 @ 20261201T090000"], ["on the first of every month", "FREQ=MONTHLY;BYMONTHDAY=1 @ 20261201T090000"],
    ["on the 15th of every month", "FREQ=MONTHLY;BYMONTHDAY=15 @ 20261215T090000"], ["every month on the 15th", "FREQ=MONTHLY;BYMONTHDAY=15 @ 20261215T090000"], ["on the 18th of each month", "FREQ=MONTHLY;BYMONTHDAY=18 @ 20261218T090000"],
    ["on the last day of the month", "FREQ=MONTHLY;BYMONTHDAY=-1 @ 20261130T090000"], ["on the 31st of every month", "FREQ=MONTHLY;BYMONTHDAY=31 @ 20261231T090000"],
    ["on the 1st and 15th of every month", "FREQ=MONTHLY;BYMONTHDAY=1,15 @ 20261201T090000"],
    ["every month", "FREQ=MONTHLY @ 20261218T090000"], ["monthly", "FREQ=MONTHLY @ 20261218T090000"], ["every 3 months", "FREQ=MONTHLY;INTERVAL=3 @ 20261218T090000"], ["quarterly", "FREQ=MONTHLY;INTERVAL=3 @ 20261218T090000"],
    ["every first Monday of the month", "FREQ=MONTHLY;BYDAY=1MO @ 20261207T090000"], ["the second Tuesday of every month", "FREQ=MONTHLY;BYDAY=2TU @ 20261208T090000"],
    ["the last Friday of every month", "FREQ=MONTHLY;BYDAY=-1FR @ 20261127T090000"], ["every last Friday of the month", "FREQ=MONTHLY;BYDAY=-1FR @ 20261127T090000"],
    ["every year", "FREQ=YEARLY @ 20271118T090000"], ["yearly", "FREQ=YEARLY @ 20271118T090000"], ["annually", "FREQ=YEARLY @ 20271118T090000"],
    ["every year on March 3rd", "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3 @ 20270303T090000"], ["every March 3rd", "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3 @ 20270303T090000"],
    ["every 3rd of March", "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3 @ 20270303T090000"], ["every year on December 25th", "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25 @ 20261225T090000"]
  ]
  for (const [text, expected] of rows) it(`"${text}"`, () => expect(read(text, "en")).toBe(expected))

  it("with a time", () => {
    expect(read("every day at 9", "en")).toBe("FREQ=DAILY @ 20261119T090000")
    expect(read("every day at 9 am", "en")).toBe("FREQ=DAILY @ 20261119T090000")
    expect(read("every day at 11 am", "en")).toBe("FREQ=DAILY @ 20261118T110000")
    expect(read("every day at 7:30", "en")).toBe("FREQ=DAILY @ 20261119T073000")
    expect(read("every Monday at half past seven", "en")).toBe("FREQ=WEEKLY;BYDAY=MO @ 20261123T073000")
    expect(read("every weekday at 8:15 am", "en")).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR @ 20261119T081500")
    expect(read("every evening at seven", "en")).toBe("FREQ=DAILY @ 20261118T190000")
    expect(read("every morning at seven", "en")).toBe("FREQ=DAILY @ 20261119T070000")
    expect(read("every Wednesday at 3 pm", "en")).toBe("FREQ=WEEKLY;BYDAY=WE @ 20261118T150000")
    expect(read("every Wednesday at 9 am", "en")).toBe("FREQ=WEEKLY;BYDAY=WE @ 20261125T090000")
    expect(read("on the first of the month at noon", "en")).toBe("FREQ=MONTHLY;BYMONTHDAY=1 @ 20261201T120000")
  })
  it("a time of day the caller wants as the default", () => {
    expect(read("every day", "en", { ...opts, defaultTime: { hour: 8, minute: 0 } })).toBe("FREQ=DAILY @ 20261119T080000")
    const r = parseRecurrence("every day", "en", opts)
    expect(r.kind === "ok" && r.value.time).toBeUndefined()
    const t = parseRecurrence("every day at nine pm", "en", opts)
    expect(t.kind === "ok" && t.value.time).toEqual({ hour: 21, minute: 0, guessed: false, alternatives: [] })
  })
  it("gives the iCalendar lines", () => {
    const r = parseRecurrence("every Monday at half past seven", "en", opts)
    expect(r.kind === "ok" && r.value.ics).toBe("DTSTART;TZID=Europe/Amsterdam:20261123T073000\nRRULE:FREQ=WEEKLY;BYDAY=MO")
    expect(r.kind === "ok" && r.value.timeZone).toBe(AMS)
  })
  for (const bad of ["", "tomorrow", "banana", "every", "every blue moon", "sometimes", "every 0 days", "biweekly", "every hour", "hourly", "every 2 hours", "every 15 minutes"]) it(`"${bad}" is not a recurrence`, () => expect(read(bad, "en")).toBe("not-understood"))
})

describe("parseRecurrence: Dutch", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["elke dag", "FREQ=DAILY @ 20261119T090000"], ["iedere dag", "FREQ=DAILY @ 20261119T090000"], ["dagelijks", "FREQ=DAILY @ 20261119T090000"],
    ["elke werkdag", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR @ 20261119T090000"], ["op werkdagen", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR @ 20261119T090000"], ["elk weekend", "FREQ=WEEKLY;BYDAY=SA,SU @ 20261121T090000"],
    ["elke maandag", "FREQ=WEEKLY;BYDAY=MO @ 20261123T090000"], ["maandags", "FREQ=WEEKLY;BYDAY=MO @ 20261123T090000"], ["elke maandag en woensdag", "FREQ=WEEKLY;BYDAY=MO,WE @ 20261123T090000"],
    ["elke maandag, woensdag en vrijdag", "FREQ=WEEKLY;BYDAY=MO,WE,FR @ 20261120T090000"],
    ["elke tweede dinsdag", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU @ 20261124T090000"], ["om de week", "FREQ=WEEKLY;INTERVAL=2 @ 20261125T090000"], ["elke twee weken", "FREQ=WEEKLY;INTERVAL=2 @ 20261125T090000"],
    ["om de twee weken", "FREQ=WEEKLY;INTERVAL=2 @ 20261125T090000"], ["wekelijks", "FREQ=WEEKLY @ 20261125T090000"], ["elke week", "FREQ=WEEKLY @ 20261125T090000"], ["om de dag", "FREQ=DAILY;INTERVAL=2 @ 20261119T090000"], ["elke drie dagen", "FREQ=DAILY;INTERVAL=3 @ 20261119T090000"],
    ["op de eerste van de maand", "FREQ=MONTHLY;BYMONTHDAY=1 @ 20261201T090000"], ["op de eerste van elke maand", "FREQ=MONTHLY;BYMONTHDAY=1 @ 20261201T090000"], ["elke maand op de 15e", "FREQ=MONTHLY;BYMONTHDAY=15 @ 20261215T090000"],
    ["op de vijftiende van elke maand", "FREQ=MONTHLY;BYMONTHDAY=15 @ 20261215T090000"], ["op de laatste dag van de maand", "FREQ=MONTHLY;BYMONTHDAY=-1 @ 20261130T090000"],
    ["elke maand", "FREQ=MONTHLY @ 20261218T090000"], ["maandelijks", "FREQ=MONTHLY @ 20261218T090000"], ["elke drie maanden", "FREQ=MONTHLY;INTERVAL=3 @ 20261218T090000"],
    ["elke eerste maandag van de maand", "FREQ=MONTHLY;BYDAY=1MO @ 20261207T090000"], ["elke laatste vrijdag van de maand", "FREQ=MONTHLY;BYDAY=-1FR @ 20261127T090000"], ["elke tweede dinsdag van de maand", "FREQ=MONTHLY;BYDAY=2TU @ 20261208T090000"],
    ["elk jaar", "FREQ=YEARLY @ 20271118T090000"], ["jaarlijks", "FREQ=YEARLY @ 20271118T090000"], ["elk jaar op 3 maart", "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3 @ 20270303T090000"], ["elke 3 maart", "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3 @ 20270303T090000"]
  ]
  for (const [text, expected] of rows) it(`"${text}"`, () => expect(read(text, "nl")).toBe(expected))

  it("with a time", () => {
    expect(read("elke dag om 9 uur", "nl")).toBe("FREQ=DAILY @ 20261119T090000")
    expect(read("elke dag om half acht", "nl")).toBe("FREQ=DAILY @ 20261119T073000")
    expect(read("iedere vrijdag om half acht", "nl")).toBe("FREQ=WEEKLY;BYDAY=FR @ 20261120T073000")
    expect(read("elke avond om zeven uur", "nl")).toBe("FREQ=DAILY @ 20261118T190000")
    expect(read("elke ochtend om zeven uur", "nl")).toBe("FREQ=DAILY @ 20261119T070000")
    expect(read("elke maandag om kwart over negen 's ochtends", "nl")).toBe("FREQ=WEEKLY;BYDAY=MO @ 20261123T091500")
    expect(read("op de eerste van de maand om twaalf uur 's middags", "nl")).toBe("FREQ=MONTHLY;BYMONTHDAY=1 @ 20261201T120000")
  })
  for (const bad of ["", "morgen", "banaan", "elke", "elke blauwe maan", "elk uur", "elke twee uur", "elke 15 minuten"]) it(`"${bad}" is not a recurrence`, () => expect(read(bad, "nl")).toBe("not-understood"))
})

describe("describeRRule", () => {
  const rows: ReadonlyArray<readonly [string, string, string]> = [
    ["FREQ=DAILY", "every day", "elke dag"], ["FREQ=DAILY;INTERVAL=2", "every other day", "om de dag"], ["FREQ=DAILY;INTERVAL=3", "every three days", "elke drie dagen"], ["FREQ=DAILY;INTERVAL=12", "every 12 days", "elke 12 dagen"],
    ["FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "every weekday", "elke werkdag"], ["FREQ=WEEKLY;BYDAY=SA,SU", "every weekend", "elk weekend"],
    ["FREQ=WEEKLY;BYDAY=MO", "every Monday", "elke maandag"], ["FREQ=WEEKLY;BYDAY=MO,WE", "every Monday and Wednesday", "elke maandag en woensdag"],
    ["FREQ=WEEKLY;BYDAY=MO,WE,FR", "every Monday, Wednesday and Friday", "elke maandag, woensdag en vrijdag"],
    ["FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "every second Tuesday", "elke tweede dinsdag"], ["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "every other week on Monday and Wednesday", "om de week op maandag en woensdag"],
    ["FREQ=WEEKLY;INTERVAL=3;BYDAY=TU", "every third Tuesday", "elke derde dinsdag"], ["FREQ=WEEKLY;INTERVAL=6;BYDAY=TU", "every six weeks on Tuesday", "elke zes weken op dinsdag"],
    ["FREQ=MONTHLY;BYMONTHDAY=1", "on the first of every month", "op de eerste van elke maand"], ["FREQ=MONTHLY;BYMONTHDAY=15", "on the fifteenth of every month", "op de vijftiende van elke maand"],
    ["FREQ=MONTHLY;BYMONTHDAY=-1", "on the last day of every month", "op de laatste dag van elke maand"], ["FREQ=MONTHLY;BYMONTHDAY=1,15", "on the first and the fifteenth of every month", "op de eerste en de vijftiende van elke maand"],
    ["FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1", "every other month on the first", "om de maand op de eerste"],
    ["FREQ=MONTHLY;BYDAY=1MO", "the first Monday of every month", "de eerste maandag van elke maand"], ["FREQ=MONTHLY;BYDAY=-1FR", "the last Friday of every month", "de laatste vrijdag van elke maand"],
    ["FREQ=MONTHLY;INTERVAL=3;BYDAY=2TU", "every three months on the second Tuesday", "elke drie maanden op de tweede dinsdag"],
    ["FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3", "every year on the third of March", "elk jaar op 3 maart"],
    ["FREQ=DAILY;COUNT=5", "every day, 5 times", "elke dag, 5 keer"]
  ]
  for (const [rule, en, nl] of rows) it(rule, () => {
    expect(describeRRule(rule, "en")).toBe(en)
    expect(describeRRule(rule, "nl")).toBe(nl)
  })
  it("a plain weekly, monthly or yearly rule says the day it takes from DTSTART, and is not described without it (round 3, findings 7 and 8)", () => {
    const start = { year: 2026, month: 11, day: 18 }
    const plain: ReadonlyArray<readonly [string, string, string]> = [
      ["FREQ=WEEKLY", "every Wednesday", "elke woensdag"], ["FREQ=WEEKLY;INTERVAL=2", "every second Wednesday", "elke tweede woensdag"],
      ["FREQ=WEEKLY;INTERVAL=6", "every six weeks on Wednesday", "elke zes weken op woensdag"], ["FREQ=MONTHLY", "on the eighteenth of every month", "op de achttiende van elke maand"],
      ["FREQ=MONTHLY;INTERVAL=3", "every three months on the eighteenth", "elke drie maanden op de achttiende"], ["FREQ=YEARLY", "every year on the eighteenth of November", "elk jaar op 18 november"]
    ]
    for (const [rule, en, nl] of plain) {
      expect(describeRRule(rule, "en", { start })).toBe(en)
      expect(describeRRule(rule, "nl", { start })).toBe(nl)
      expect(describeRRule(rule, "en")).toBeUndefined()
    }
  })
  it("with the time of day", () => {
    expect(describeRRule("FREQ=DAILY", "en", { time: { hour: 9, minute: 0 } })).toBe("every day at nine o'clock in the morning")
    expect(describeRRule("FREQ=WEEKLY;BYDAY=MO", "nl", { time: { hour: 7, minute: 30 } })).toBe("elke maandag om half acht 's ochtends")
    expect(describeRRule("FREQ=WEEKLY;BYDAY=FR", "en", { time: { hour: 0, minute: 0 } })).toBe("every Friday at 00:00")
  })
  it("an UNTIL is said in the series' zone, or not at all", () => {
    expect(describeRRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270303T225959Z", "en")).toBeUndefined()
    expect(describeRRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270303T225959Z", "en", { timeZone: AMS })).toBe("every Monday, until 3 March 2027 at 23:59:59")
    expect(describeRRule("FREQ=WEEKLY;BYDAY=MO;UNTIL=20270303T225959Z", "nl", { timeZone: AMS })).toBe("elke maandag, tot 3 maart 2027 om 23:59:59")
  })
  it("a yearly date left to the start needs the start", () => {
    expect(describeRRule("FREQ=YEARLY;BYMONTH=3", "en")).toBeUndefined()
    expect(describeRRule("FREQ=YEARLY;BYMONTH=3", "en", { start: { year: 2027, month: 3, day: 3 } })).toBe("every year on the third of March")
    expect(describeRRule("FREQ=YEARLY", "nl", { start: { year: 2026, month: 3, day: 3 } })).toBe("elk jaar op 3 maart")
  })
  it("returns undefined for what it cannot read", () => {
    expect(describeRRule("FREQ=SOMETIMES", "en")).toBeUndefined()
    expect(describeRRule("FREQ=MONTHLY;BYSETPOS=1", "en")).toBeUndefined()
    expect(describeRRule("FREQ=HOURLY", "en")).toBeUndefined()
    expect(describeRRule("", "nl")).toBeUndefined()
  })

  it("round trip: speak a rule, read it back, get the same rule", () => {
    const rules = [
      "FREQ=DAILY", "FREQ=DAILY;INTERVAL=2", "FREQ=DAILY;INTERVAL=3", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "FREQ=WEEKLY;BYDAY=SA,SU", "FREQ=WEEKLY;BYDAY=MO", "FREQ=WEEKLY;BYDAY=MO,WE,FR", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "FREQ=WEEKLY;INTERVAL=3;BYDAY=TU",
      "FREQ=MONTHLY;BYMONTHDAY=1", "FREQ=MONTHLY;BYMONTHDAY=15", "FREQ=MONTHLY;BYMONTHDAY=-1", "FREQ=MONTHLY;BYMONTHDAY=1,15", "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1",
      "FREQ=MONTHLY;BYDAY=1MO", "FREQ=MONTHLY;BYDAY=-1FR", "FREQ=MONTHLY;BYDAY=2TU", "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3"
    ]
    for (const language of ["en", "nl"] as const) {
      for (const r of rules) {
        const said = describeRRule(r, language)!
        const back = parseRecurrence(said, language, opts)
        expect(back.kind === "ok" ? back.value.rrule : back.kind, `${language}: "${said}"`).toBe(r)
      }
    }
  })
})

describe("parseRRule / formatRRule", () => {
  it("reads and writes", () => {
    const r = parseRRule("RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=6")
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.rule.freq).toBe("MONTHLY")
    expect(r.rule.interval).toBe(2)
    expect(r.rule.byDay).toEqual([{ weekday: "FR", nth: -1 }])
    expect(r.rule.count).toBe(6)
    expect(formatRRule(r.rule)).toBe("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=6")
  })
  for (const bad of ["", "FREQ=", "INTERVAL=2", "FREQ=DAILY;INTERVAL=0", "FREQ=DAILY;BYDAY=XX", "FREQ=MONTHLY;BYMONTHDAY=0", "FREQ=DAILY;UNTIL=tomorrow", "nonsense"])
    it(`"${bad}" is invalid`, () => expect(parseRRule(bad).kind).toBe("invalid"))
  for (const other of ["FREQ=DAILY;BYSETPOS=1", "FREQ=HOURLY", "FREQ=DAILY;UNTIL=20270101"])
    it(`"${other}" is unsupported`, () => expect(parseRRule(other).kind).toBe("unsupported"))
  it("reads DTSTART lines of the supported form only", () => {
    expect(parseDtstart("DTSTART;TZID=Europe/Amsterdam:20261120T090000")).toEqual({ start: { year: 2026, month: 11, day: 20, hour: 9, minute: 0, second: 0 }, timeZone: "Europe/Amsterdam" })
    for (const other of ["2026-11-20T09:30", "DTSTART:20261120T090000", "DTSTART:20261120T090000Z", "DTSTART;VALUE=DATE:20261120", "soon"]) expect(parseDtstart(other), other).toBeUndefined()
  })
})

describe("nextOccurrence", () => {
  const spec = (rrule: string, dtstart: string, timeZone = AMS): RecurrenceSpec => ({ rrule, dtstart: dtstartOf(dtstart, timeZone), timeZone })
  const list = (s: RecurrenceSpec, after: number, n: number) => occ(s, after, n).map(iso)

  it("daily", () => {
    expect(list(spec("FREQ=DAILY", "2026-11-18T09:00"), ams(2026, 11, 18, 9, 0), 3)).toEqual(["2026-11-19T09:00", "2026-11-20T09:00", "2026-11-21T09:00"])
    expect(list(spec("FREQ=DAILY", "2026-11-18T09:00"), ams(2026, 11, 18, 8, 59), 1)).toEqual(["2026-11-18T09:00"])
    expect(list(spec("FREQ=DAILY;INTERVAL=3", "2026-11-18T09:00"), ams(2026, 11, 18, 10), 3)).toEqual(["2026-11-21T09:00", "2026-11-24T09:00", "2026-11-27T09:00"])
  })
  it("weekly, with days and an interval", () => {
    expect(list(spec("FREQ=WEEKLY;BYDAY=MO,WE,FR", "2026-11-18T07:30"), ams(2026, 11, 18, 8), 4)).toEqual(["2026-11-20T07:30", "2026-11-23T07:30", "2026-11-25T07:30", "2026-11-27T07:30"])
    expect(list(spec("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", "2026-11-24T09:00"), ams(2026, 11, 24, 10), 3)).toEqual(["2026-12-08T09:00", "2026-12-22T09:00", "2027-01-05T09:00"])
    expect(list(spec("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-11-19T09:00"), ams(2026, 11, 20, 10), 3)).toEqual(["2026-11-23T09:00", "2026-11-24T09:00", "2026-11-25T09:00"])
  })
  it("monthly: dates, ordinal weekdays, the last day, short months, and a long way after the start", () => {
    expect(list(spec("FREQ=MONTHLY;BYMONTHDAY=31", "2026-10-31T09:00"), ams(2026, 11, 1), 4)).toEqual(["2026-12-31T09:00", "2027-01-31T09:00", "2027-03-31T09:00", "2027-05-31T09:00"])
    expect(list(spec("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-11-30T09:00"), ams(2026, 11, 30, 10), 3)).toEqual(["2026-12-31T09:00", "2027-01-31T09:00", "2027-02-28T09:00"])
    expect(list(spec("FREQ=MONTHLY;BYDAY=2TU", "2026-12-08T09:00"), ams(2026, 12, 8, 10), 3)).toEqual(["2027-01-12T09:00", "2027-02-09T09:00", "2027-03-09T09:00"])
    expect(list(spec("FREQ=MONTHLY;BYDAY=-1FR", "2026-11-27T09:00"), ams(2026, 11, 27, 10), 3)).toEqual(["2026-12-25T09:00", "2027-01-29T09:00", "2027-02-26T09:00"])
    expect(list(spec("FREQ=MONTHLY;BYMONTHDAY=15", "2020-01-15T09:00"), ams(2026, 11, 18), 2)).toEqual(["2026-12-15T09:00", "2027-01-15T09:00"])
    expect(list(spec("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1", "2026-11-01T09:00"), ams(2026, 11, 2), 3)).toEqual(["2027-01-01T09:00", "2027-03-01T09:00", "2027-05-01T09:00"])
  })
  it("yearly, including the 29th of February", () => {
    expect(list(spec("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=3", "2027-03-03T09:00"), ams(2027, 3, 3, 10), 2)).toEqual(["2028-03-03T09:00", "2029-03-03T09:00"])
    expect(list(spec("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", "2028-02-29T09:00"), ams(2028, 3, 1), 2)).toEqual(["2032-02-29T09:00", "2036-02-29T09:00"])
    expect(list(spec("FREQ=YEARLY", "2026-11-18T09:00"), ams(2026, 11, 19), 2)).toEqual(["2027-11-18T09:00", "2028-11-18T09:00"])
  })
  it("hourly and minutely rules are not supported: they are scheduler jobs", () => {
    expect(list(spec("FREQ=HOURLY;INTERVAL=2", "2026-11-18T10:00"), ams(2026, 11, 18, 10, 30), 3)).toEqual([])
    expect(list(spec("FREQ=MINUTELY;INTERVAL=15", "2026-11-18T10:00"), ams(2026, 11, 18, 10, 5), 2)).toEqual([])
  })
  it("COUNT and UNTIL end the series", () => {
    const counted = spec("FREQ=DAILY;COUNT=3", "2026-11-18T09:00")
    expect(list(counted, ams(2026, 11, 17), 10)).toEqual(["2026-11-18T09:00", "2026-11-19T09:00", "2026-11-20T09:00"])
    expect(nextOccurrence(counted, ams(2026, 11, 20, 9))).toBeUndefined()
    const until = spec("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261207T225959Z", "2026-11-23T09:00")
    expect(list(until, ams(2026, 11, 17), 10)).toEqual(["2026-11-23T09:00", "2026-11-30T09:00", "2026-12-07T09:00"])
    expect(list(spec("FREQ=DAILY;UNTIL=20261120T080000Z", "2026-11-18T09:00"), ams(2026, 11, 17), 10)).toEqual(["2026-11-18T09:00", "2026-11-19T09:00", "2026-11-20T09:00"])
  })
  it("is strictly after, and accepts a Date", () => {
    const s = spec("FREQ=DAILY", "2026-11-18T09:00")
    expect(nextOccurrence(s, ams(2026, 11, 18, 9))).toBe(ams(2026, 11, 19, 9))
    expect(nextOccurrence(s, new Date(ams(2026, 11, 18, 9)))).toBe(ams(2026, 11, 19, 9))
  })
  it("a rule that never matches gives nothing instead of looping", () => {
    expect(nextOccurrence(spec("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "2026-02-28T09:00"), ams(2026, 3, 1))).toBeUndefined()
    expect(nextOccurrence(spec("FREQ=MONTHLY;BYMONTHDAY=15", "2026-02-28T09:00"), ams(2026, 3, 1))).toBeUndefined() // DTSTART is not an instance
    expect(nextOccurrence(spec("FREQ=NONSENSE", "2026-02-28T09:00"), 0)).toBeUndefined()
    expect(nextOccurrence(spec("FREQ=DAILY", "not a date"), 0)).toBeUndefined()
  })

  describe("daylight saving in Europe/Amsterdam", () => {
    it("daily at 09:00 stays 09:00 on the wall clock across the spring jump (2027-03-28)", () => {
      const s = spec("FREQ=DAILY", "2027-03-25T09:00")
      const got = occ(s, ams(2027, 3, 25, 10), 5)
      expect(got.map(iso)).toEqual(["2027-03-26T09:00", "2027-03-27T09:00", "2027-03-28T09:00", "2027-03-29T09:00", "2027-03-30T09:00"])
      expect(got.map((t, i) => (i === 0 ? 24 : (t - got[i - 1]!) / 3_600_000))).toEqual([24, 24, 23, 24, 24])
    })
    it("daily at 09:00 stays 09:00 across the autumn jump (2026-10-25): that day is 25 hours long", () => {
      const got = occ(spec("FREQ=DAILY", "2026-10-23T09:00"), ams(2026, 10, 23, 10), 4)
      expect(got.map(iso)).toEqual(["2026-10-24T09:00", "2026-10-25T09:00", "2026-10-26T09:00", "2026-10-27T09:00"])
      expect((got[1]! - got[0]!) / 3_600_000).toBe(25)
    })
    it("a time the clocks skip (02:30 on 2027-03-28) happens at 03:30, and goes back to 02:30 the next day", () => {
      const got = occ(spec("FREQ=DAILY", "2027-03-26T02:30"), ams(2027, 3, 26, 12), 3)
      expect(got.map((t) => new Date(t).toISOString())).toEqual(["2027-03-27T01:30:00.000Z", "2027-03-28T01:30:00.000Z", "2027-03-29T00:30:00.000Z"])
      expect(got.map(iso)).toEqual(["2027-03-27T02:30", "2027-03-28T03:30", "2027-03-29T02:30"])
    })
    it("a time that happens twice (02:30 on 2026-10-25) is the first one", () => {
      const got = occ(spec("FREQ=DAILY", "2026-10-24T02:30"), ams(2026, 10, 24, 12), 2)
      expect(got.map((t) => new Date(t).toISOString())).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"])
    })
    it("weekly on Sunday at 09:00 across both jumps", () => {
      const spring = occ(spec("FREQ=WEEKLY;BYDAY=SU", "2027-03-21T09:00"), ams(2027, 3, 21, 10), 2)
      expect(spring.map(iso)).toEqual(["2027-03-28T09:00", "2027-04-04T09:00"])
      expect(spring.map((t) => new Date(t).toISOString())).toEqual(["2027-03-28T07:00:00.000Z", "2027-04-04T07:00:00.000Z"])
      const autumn = occ(spec("FREQ=WEEKLY;BYDAY=SU", "2026-10-18T09:00"), ams(2026, 10, 18, 10), 2)
      expect(autumn.map((t) => new Date(t).toISOString())).toEqual(["2026-10-25T08:00:00.000Z", "2026-11-01T08:00:00.000Z"])
    })
    it("monthly on the last day, and yearly, across a jump", () => {
      expect(list(spec("FREQ=MONTHLY;BYMONTHDAY=-1", "2027-02-28T23:30"), ams(2027, 2, 28, 23, 31), 2)).toEqual(["2027-03-31T23:30", "2027-04-30T23:30"])
      expect(list(spec("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=28", "2026-03-28T02:30"), ams(2026, 3, 29), 1)).toEqual(["2027-03-28T03:30"])
    })
    it("the same rule in another zone has other instants", () => {
      const ny = occ(spec("FREQ=DAILY", "2027-03-13T09:00", "America/New_York"), Date.UTC(2027, 2, 13, 14), 3).map((t) => new Date(t).toISOString())
      expect(ny).toEqual(["2027-03-14T13:00:00.000Z", "2027-03-15T13:00:00.000Z", "2027-03-16T13:00:00.000Z"]) // US jump is on the 14th: 09:00 EST = 14:00Z before, EDT = 13:00Z after
    })
    it("parse to expand: 'every day at 9' said before the jump keeps 09:00 after it", () => {
      const r = parseRecurrence("every day at 9 am", "en", { now: ams(2027, 3, 26, 12), timeZone: AMS })
      expect(r.kind).toBe("ok")
      if (r.kind === "ok") {
        const got = occ({ rrule: r.value.rrule, dtstart: r.value.dtstart, timeZone: AMS }, ams(2027, 3, 26, 12), 3)
        expect(got.map(iso)).toEqual(["2027-03-27T09:00", "2027-03-28T09:00", "2027-03-29T09:00"])
      }
    })
  })
})
