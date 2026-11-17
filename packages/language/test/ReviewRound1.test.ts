// Regression tests for the first review of the modules P2 helpers (PR #88). Each describe names its finding.
import { describe, expect, it } from "@effect/vitest"
import { parseDateTime, type DateOptions } from "../src/Dates.ts"
import * as language from "../src/index.ts"
import { parseQuantity } from "../src/Quantity.ts"
import { parseRecurrence, type RecurrenceOptions } from "../src/Recurrence.ts"
import { describeRRule, formatRRule, nextOccurrence, occurrencesAfter, parseDtstart, parseRRule, type RecurrenceSpec } from "../src/Rrule.ts"
import { speakAmount, speakNumber } from "../src/Speak.ts"
import { parseTimeOfDay } from "../src/Time.ts"
import { normalizeTimeZone, offsetAt } from "../src/Zoned.ts"
import { AMS, ams, dtstartOf, hm, iso, NOW } from "./helpers.ts"

const dopts: DateOptions = { now: NOW, timeZone: AMS } // Wednesday 2026-11-18 10:00
const ropts: RecurrenceOptions = { now: NOW, timeZone: AMS }
const ymd = (d: { year: number; month: number; day: number }) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
const date = (text: string, lang: "en" | "nl" = "en", options: DateOptions = dopts) => {
  const r = parseDateTime(text, lang, options)
  if (r.kind === "ok") return `${ymd(r.value.date)}${r.value.time ? " " + hm(r.value.time) : ""}${r.value.partOfDay ? " " + r.value.partOfDay : ""}`
  return r.kind
}
const rec = (text: string, lang: "en" | "nl" = "en", options: RecurrenceOptions = ropts) => {
  const r = parseRecurrence(text, lang, options)
  return r.kind === "ok" ? `${r.value.rrule} @ ${r.value.dtstart.replace(`DTSTART;TZID=${AMS}:`, "")}` : r.kind
}
const spec = (rrule: string, dtstart: string, timeZone = AMS): RecurrenceSpec => ({ rrule, dtstart: dtstartOf(dtstart, timeZone), timeZone })
const list = (s: RecurrenceSpec, after: number, n: number) => occurrencesAfter(s, after, n).map(iso)

describe("finding 6: words that are names of object properties", () => {
  const names = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "prototype", "isPrototypeOf", "__defineGetter__"]
  const numbersIn = (v: unknown): Array<number> => {
    if (typeof v === "number") return [v]
    if (v === null || typeof v !== "object") return []
    return Object.values(v).flatMap(numbersIn)
  }
  for (const lang of ["en", "nl"] as const) {
    for (const w of names) {
      const texts = [w, `${w} at noon`, `every ${w}`, `elke ${w}`, `2 ${w}`, `twee ${w}`, `in ${w} days`, `the ${w} of March`, `${w} ${w}`, `half ${w}`, `om ${w} uur`]
      it(`${lang} "${w}" in every parser: no throw, no NaN, never a value from the word`, () => {
        for (const t of texts) {
          const results = [parseDateTime(t, lang, dopts), parseRecurrence(t, lang, ropts), parseQuantity(t, lang), parseTimeOfDay(t, lang)]
          for (const r of results) for (const n of numbersIn(r)) expect(Number.isNaN(n), `${t}: ${JSON.stringify(r)}`).toBe(false)
        }
        expect(date(w, lang)).toBe("not-understood")
        expect(rec(`every ${w}`, lang)).toBe("not-understood")
        expect(parseQuantity(w, lang).kind).toBe("not-understood")
      })
    }
  }
  it("constructor at noon: a word no rule reads is refused (round 2: the phrase is read whole)", () => {
    expect(date("constructor at noon")).toBe("not-understood")
    expect(date("at noon")).toBe("2026-11-18 12:00")
  })
  it("describeRRule and the speakers ignore such words", () => {
    expect(describeRRule("FREQ=WEEKLY;BYDAY=constructor", "en")).toBeUndefined()
    expect(speakAmount({ amount: 2, unit: "constructor" as never }, "en")).toBe("2 constructor")
  })
})

describe("finding 7: a number is read whole or not at all", () => {
  const q = (t: string, lang: "en" | "nl" = "en") => {
    const r = parseQuantity(t, lang)
    return r.kind === "ok" ? `${r.value.amount} ${r.value.unit}${r.value.item ? " " + r.value.item : ""}` : r.kind
  }
  const rows: ReadonlyArray<readonly [string, "en" | "nl", string]> = [
    [".5 kg flour", "en", "not-understood"], ["-2 kg flour", "en", "not-understood"], ["1/2 kg flour", "en", "not-understood"], ["2½ kg flour", "en", "not-understood"],
    ["one point five litres milk", "en", "1.5 l milk"], ["two point two five kilo rice", "en", "2.25 kg rice"], ["twee komma vijf kilo meel", "nl", "2.5 kg meel"],
    ["tweeduizend driehonderd gram meel", "nl", "2300 g meel"], ["twee duizend gram meel", "nl", "2000 g meel"], ["vijf en twintig gram suiker", "nl", "25 g suiker"],
    ["five five apples", "en", "not-understood"], ["3-5 apples", "en", "not-understood"], ["1e3 kg", "en", "not-understood"], ["1.000 g sugar", "en", "not-understood"],
    ["1,000 g sugar", "nl", "not-understood"], ["1,500 g sugar", "en", "1500 g sugar"], ["1.500 gram suiker", "nl", "1500 g suiker"], ["2 kg 500 g flour", "en", "not-understood"],
    ["two and a half kilo potatoes", "en", "2.5 kg potatoes"], ["a kilo of rice", "en", "1 kg rice"], ["3x melk", "nl", "3 piece melk"]
  ]
  for (const [t, lang, want] of rows) it(`${lang} "${t}"`, () => expect(q(t, lang)).toBe(want))
  it("times and dates use the same rule", () => {
    expect(parseTimeOfDay("seven five", "en").kind).toBe("not-understood")
    expect(date("tomorrow at 5 and 6")).toBe("not-understood")
    expect(date("tomorrow at 5, 6")).toBe("not-understood")
    expect(rec("every day at 9 and 5")).toBe("not-understood")
    expect(date("in -2 days")).toBe("not-understood")
    expect(date("in .5 hours")).toBe("not-understood")
  })
})

describe("finding 8: the whole temporal expression is read, or none of it", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Wednesday 3 March 2027 at 5 pm", "2027-03-03 17:00"], ["Tuesday 3 March 2027 at 5 pm", "not-understood"], ["Friday the 20th", "2026-11-20"], ["Friday the 21st", "not-understood"],
    ["on Wednesday, 3 March 2027", "2027-03-03"], ["tomorrow, Thursday", "2026-11-19"], ["tomorrow Friday", "not-understood"],
    ["29 February 2027 at 5 pm", "not-understood"], ["31 April at 9", "not-understood"], ["the 32nd", "not-understood"], ["the 0th", "not-understood"],
    ["last Friday", "not-understood"], ["previous Monday", "not-understood"], ["before Friday", "not-understood"], ["after tomorrow at 5", "not-understood"], ["until 5 pm", "not-understood"],
    ["every Friday", "not-understood"], ["Fridays at 5", "not-understood"], ["this weekend", "not-understood"], ["in 2 weeks and 3 days", "not-understood"],
    ["tomorrow or Friday", "not-understood"], ["tomorrow at 5 and at 6", "not-understood"], ["two days ago", "not-understood"], ["tomorrow in the evening", "2026-11-19 evening"],
    ["remind me to call mum tomorrow at five", "not-understood"], ["remind me to buy 3 apples tomorrow", "not-understood"], ["I may call mum tomorrow", "not-understood"]
  ]
  for (const [t, want] of rows) it(`"${t}"`, () => expect(date(t)).toBe(want))
  const nl: ReadonlyArray<readonly [string, string]> = [
    ["woensdag 3 maart 2027 om 17:00", "2027-03-03 17:00"], ["dinsdag 3 maart 2027", "not-understood"], ["afgelopen vrijdag", "not-understood"], ["vorige maandag", "not-understood"],
    ["na vrijdag", "not-understood"], ["voor 5 uur", "not-understood"], ["zet een wekker voor morgen om kwart over zeven", "not-understood"], ["morgen om kwart over zeven", "2026-11-19 07:15"], ["twee dagen geleden", "not-understood"]
  ]
  for (const [t, want] of nl) it(`nl "${t}"`, () => expect(date(t, "nl")).toBe(want))
})

describe("finding 9: compound durations are read whole", () => {
  const instant = (t: string, lang: "en" | "nl" = "en") => {
    const r = parseDateTime(t, lang, dopts)
    return r.kind === "ok" ? (r.value.instant! - NOW) / 60_000 : r.kind
  }
  it("reads the complete duration", () => {
    expect(instant("in two hours and thirty minutes")).toBe(150)
    expect(instant("in an hour and a half")).toBe(90)
    expect(instant("in 2 hours 30 minutes")).toBe(150)
    expect(instant("in two and a half hours")).toBe(150)
    expect(instant("in a quarter of an hour")).toBe(15)
    expect(instant("over anderhalf uur", "nl")).toBe(90)
    expect(instant("over twee uur en dertig minuten", "nl")).toBe(150)
  })
  it("refuses what it cannot read whole", () => {
    expect(instant("in 2 weeks and 3 days")).toBe("not-understood")
    expect(instant("in two hours at five")).toBe("not-understood")
    expect(instant("in 1.5 days")).toBe("not-understood")
    expect(instant("in two hours and five")).toBe("not-understood")
  })
})

describe("finding 10: a part of the day said with the clock must agree with it", () => {
  const t = (s: string, lang: "en" | "nl" = "en") => {
    const r = parseTimeOfDay(s, lang)
    return r.kind === "ok" ? hm(r.value) : r.kind
  }
  const rows: ReadonlyArray<readonly [string, "en" | "nl", string]> = [
    ["07:00 in the evening", "en", "not-understood"], ["23 in the morning", "en", "not-understood"], ["19:00 in the evening", "en", "19:00"], ["07:00 in the morning", "en", "07:00"],
    ["noon in the evening", "en", "not-understood"], ["midnight at night", "en", "00:00"], ["seven in the evening", "en", "19:00"], ["three in the evening", "en", "not-understood"],
    ["twelve in the morning", "en", "not-understood"], ["three in the morning", "en", "03:00"], ["eleven at night", "en", "23:00"], ["07:00 pm", "en", "not-understood"],
    ["19 uur 's ochtends", "nl", "not-understood"], ["7 uur 's avonds", "nl", "19:00"], ["07:00 's avonds", "nl", "not-understood"]
  ]
  for (const [s, lang, want] of rows) it(`${lang} "${s}"`, () => expect(t(s, lang)).toBe(want))
  it("in dates: a part of the day and a time that disagree", () => {
    expect(date("tonight at 9 am")).toBe("not-understood")
    expect(date("tomorrow morning at 7 pm")).toBe("not-understood")
    expect(date("tomorrow evening at 07:00")).toBe("not-understood")
    expect(date("tonight at 22:00")).toBe("2026-11-18 22:00")
  })
})

describe("finding 11: a recurrence with a part it does not build is refused", () => {
  for (const t of ["every day except weekends", "every day until December 1st", "every Monday for 3 times", "every day at 25:00", "every day from tomorrow", "every Monday 3 times",
    "every day starting next week", "every weekday but not Friday", "every day for two weeks", "every day at 9 and at 5", "every hour at seven", "every Monday at 9 until Christmas"])
    it(`"${t}"`, () => expect(rec(t)).toBe("not-understood"))
  for (const t of ["elke dag behalve in het weekend", "elke dag tot 1 december", "elke maandag 3 keer", "elke dag om 25:00", "elke dag vanaf morgen"])
    it(`nl "${t}"`, () => expect(rec(t, "nl")).toBe("not-understood"))
  it("a title around the rule is not read (round 2: the caller passes the recurrence phrase alone)", () => {
    expect(rec("take 2 pills every day at 8 am")).toBe("not-understood")
    expect(rec("remind me every Monday to put the bins out")).toBe("not-understood")
    expect(rec("every day at 8 am")).toBe("FREQ=DAILY @ 20261119T080000")
  })
})

describe("finding 12: an ordinal before a unit is an interval", () => {
  const rows: ReadonlyArray<readonly [string, "en" | "nl", string]> = [
    ["every second month", "en", "FREQ=MONTHLY;INTERVAL=2 @ 20261218T090000"], ["every third day", "en", "FREQ=DAILY;INTERVAL=3 @ 20261119T090000"],
    ["every second week", "en", "FREQ=WEEKLY;INTERVAL=2 @ 20261125T090000"], ["every second year", "en", "FREQ=YEARLY;INTERVAL=2 @ 20271118T090000"],
    ["every 2nd of the month", "en", "FREQ=MONTHLY;BYMONTHDAY=2 @ 20261202T090000"], ["on the second of every month", "en", "FREQ=MONTHLY;BYMONTHDAY=2 @ 20261202T090000"],
    ["elke tweede maand", "nl", "FREQ=MONTHLY;INTERVAL=2 @ 20261218T090000"], ["elke derde dag", "nl", "FREQ=DAILY;INTERVAL=3 @ 20261119T090000"],
    ["op de tweede van elke maand", "nl", "FREQ=MONTHLY;BYMONTHDAY=2 @ 20261202T090000"]
  ]
  for (const [t, lang, want] of rows) it(`${lang} "${t}"`, () => expect(rec(t, lang)).toBe(want))
})

describe("finding 13: a part of the day sets the clock", () => {
  it("every evening rings in the evening", () => {
    expect(rec("every evening")).toBe("FREQ=DAILY @ 20261118T190000")
    expect(rec("elke avond", "nl")).toBe("FREQ=DAILY @ 20261118T190000")
    expect(rec("every Tuesday and Thursday evening")).toBe("FREQ=WEEKLY;BYDAY=TU,TH @ 20261119T190000")
    expect(rec("every morning")).toBe("FREQ=DAILY @ 20261119T080000")
    expect(rec("every weekday morning")).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR @ 20261119T080000")
    expect(rec("every night")).toBe("FREQ=DAILY @ 20261118T220000")
    const r = parseRecurrence("every evening", "en", ropts)
    expect(r.kind === "ok" && [r.value.partOfDay, r.value.timeDefaulted, r.value.time]).toEqual(["evening", true, undefined])
  })
  it("the caller's default time is used when it fits the part", () => {
    expect(rec("every evening", "en", { ...ropts, defaultTime: { hour: 20, minute: 30 } })).toBe("FREQ=DAILY @ 20261118T203000")
    expect(rec("every evening", "en", { ...ropts, defaultTime: { hour: 9, minute: 0 } })).toBe("FREQ=DAILY @ 20261118T190000")
  })
  it("a time and a part that disagree are refused", () => {
    expect(rec("every morning at 7 pm")).toBe("not-understood")
    expect(rec("every evening at 07:00")).toBe("not-understood")
    expect(rec("elke ochtend om 19:00", "nl")).toBe("not-understood")
    expect(rec("every Tuesday evening at seven")).toBe("FREQ=WEEKLY;BYDAY=TU @ 20261124T190000")
  })
})

describe("finding 14 (kept): a time the clocks skip, by RFC 5545 §3.3.10 and §3.3.5", () => {
  it("a daily 02:30 in Amsterdam is 03:30 on the day the clocks go forward, and a repeated time is the first one", () => {
    expect(list(spec("FREQ=DAILY", "2027-03-26T02:30"), ams(2027, 3, 26, 12), 3)).toEqual(["2027-03-27T02:30", "2027-03-28T03:30", "2027-03-29T02:30"])
    expect(occurrencesAfter(spec("FREQ=DAILY", "2026-10-24T02:30"), ams(2026, 10, 24, 12), 1).map((t) => new Date(t).toISOString())).toEqual(["2026-10-25T00:30:00.000Z"])
  })
  it("wall-clock hourly rules are no longer offered (round 2)", () => {
    expect(parseRRule("FREQ=HOURLY;BYMINUTE=0").kind).toBe("unsupported")
  })
})
describe("finding 15: yearly rules", () => {
  it("the yearly shapes RFC 5545 gives another meaning are refused (round 2): BYMONTHDAY alone, ordinal weekdays, several months, plain weekdays", () => {
    for (const r of ["FREQ=YEARLY;BYMONTHDAY=1", "FREQ=YEARLY;BYDAY=20MO", "FREQ=YEARLY;BYDAY=1MO,-1FR", "FREQ=YEARLY;BYMONTH=5;BYDAY=2SU", "FREQ=YEARLY;BYMONTH=1,2;BYMONTHDAY=1,15", "FREQ=YEARLY;BYDAY=MO"])
      expect(parseRRule(r).kind, r).toBe("unsupported")
  })
  it("a plain yearly rule from 29 February is every leap year's 29 February", () => {
    expect(list(spec("FREQ=YEARLY", "2024-02-29T09:00"), ams(2024, 3, 1), 2)).toEqual(["2028-02-29T09:00", "2032-02-29T09:00"])
  })
  it("a month and a day; a month with DTSTART's day", () => {
    expect(list(spec("FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=29", "2026-03-29T09:00"), ams(2026, 3, 30), 2)).toEqual(["2028-03-29T09:00", "2030-03-29T09:00"])
    expect(list(spec("FREQ=YEARLY;BYMONTH=3", "2026-03-03T09:00"), ams(2026, 3, 4), 2)).toEqual(["2027-03-03T09:00", "2028-03-03T09:00"])
  })
})
describe("finding 16: HOURLY and MINUTELY are no longer offered (round 2)", () => {
  it("are unsupported and have no occurrences", () => {
    for (const r of ["FREQ=HOURLY;BYMONTHDAY=1", "FREQ=MINUTELY;INTERVAL=30;BYMONTHDAY=1"]) {
      expect(parseRRule(r).kind).toBe("unsupported")
      expect(list(spec(r, "2026-11-01T09:00"), ams(2026, 11, 2), 2)).toEqual([])
    }
  })
})
describe("finding 17: long series have no iteration cap", () => {
  it("a daily series of 1000 runs to its last occurrence and ends there", () => {
    const s = spec("FREQ=DAILY;COUNT=1000", "2026-11-01T09:00")
    const last = occurrencesAfter(s, ams(2029, 7, 27), 5)
    expect(last.map(iso)).toEqual(["2029-07-27T09:00"])
    expect(nextOccurrence(s, last[0]!)).toBeUndefined()
  })
  it("decades into an unbounded series is quick", () => {
    const t0 = performance.now()
    expect(list(spec("FREQ=DAILY", "1990-01-01T07:00"), ams(2026, 11, 18, 10, 0), 1)).toEqual(["2026-11-19T07:00"])
    expect(list(spec("FREQ=WEEKLY;BYDAY=MO", "1990-01-01T07:00"), ams(2026, 11, 18, 10, 0), 1)).toEqual(["2026-11-23T07:00"])
    expect(list(spec("FREQ=MONTHLY;BYDAY=-1FR", "1990-01-26T07:00"), ams(2026, 11, 18, 10, 0), 1)).toEqual(["2026-11-27T07:00"])
    expect(list(spec("FREQ=DAILY", "1990-01-01T07:00"), ams(9000, 1, 1, 10, 0), 1)).toEqual(["9000-01-02T07:00"])
    expect(performance.now() - t0).toBeLessThan(1500)
  })
})
describe("finding 18: DTSTART keeps its meaning", () => {
  it("only a zoned local date-time is read; dates that do not exist are refused", () => {
    expect(parseDtstart("DTSTART;TZID=Europe/Amsterdam:20261120T090030")?.start.second).toBe(30)
    for (const bad of ["DTSTART:20261120T080000Z", "DTSTART;VALUE=DATE:20261120", "2026-11-20T09:00:30", "DTSTART;TZID=Europe/Amsterdam:20260230T090000", "DTSTART;TZID=Europe/Amsterdam:20261120T250000",
      "DTSTART;TZID=Europe/Amsterdam:20261120T090000Z", "DTSTART;FOO=1:20261120T090000", "DTSTART;TZID=Mars/Olympus:20261120T090000"])
      expect(parseDtstart(bad), bad).toBeUndefined()
  })
  it("seconds are kept in the occurrences", () => {
    expect(new Date(nextOccurrence(spec("FREQ=DAILY", "DTSTART;TZID=Europe/Amsterdam:20261120T090030"), ams(2026, 11, 20, 10))!).toISOString()).toBe("2026-11-21T08:00:30.000Z")
  })
  it("a TZID that disagrees with the zone gives no occurrence; one that agrees (in any spelling) does", () => {
    expect(nextOccurrence(spec("FREQ=DAILY", "DTSTART;TZID=America/New_York:20261120T090000"), 0)).toBeUndefined()
    expect(nextOccurrence(spec("FREQ=DAILY", "DTSTART;TZID=europe/amsterdam:20261120T090000"), ams(2026, 11, 20, 10))).toBe(ams(2026, 11, 21, 9))
  })
})
describe("finding 19: only valid rules are read", () => {
  for (const bad of ["FREQ=DAILY;BYDAY=0MO", "FREQ=WEEKLY;BYDAY=2TU", "FREQ=DAILY;BYDAY=1MO", "FREQ=DAILY;FREQ=WEEKLY", "FREQ=DAILY;INTERVAL=2;INTERVAL=3", "FREQ=DAILY;COUNT=3;UNTIL=20270101T000000Z",
    "FREQ=DAILY;INTERVAL=1e3", "FREQ=DAILY;INTERVAL=+2", "FREQ=DAILY;INTERVAL=0x10", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;COUNT=1.5", "FREQ=MONTHLY;BYDAY=6MO", "FREQ=YEARLY;BYDAY=54MO",
    "FREQ=MONTHLY;BYMONTHDAY=32", "FREQ=MONTHLY;BYMONTHDAY=1,1", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "FREQ=WEEKLY;BYMONTHDAY=1", "FREQ=DAILY;UNTIL=20270230T000000Z",
    "FREQ=DAILY;WKST=XX", "FREQ=DAILY;", "FREQ=DAILY;;COUNT=2"])
    it(`"${bad}" is invalid`, () => expect(parseRRule(bad).kind).toBe("invalid"))
  for (const other of ["FREQ=MONTHLY;BYSETPOS=1", "FREQ=DAILY;BYSETPOS=1;BYHOUR=9", "FREQ=SECONDLY", "FREQ=DAILY;BYSECOND=5", "FREQ=YEARLY;BYWEEKNO=20", "FREQ=YEARLY;BYYEARDAY=100",
    "FREQ=DAILY;X-NAME=1", "FREQ=DAILY;BYHOUR=9", "FREQ=YEARLY;BYDAY=20MO;BYMONTHDAY=1", "FREQ=MONTHLY;BYMONTH=10;BYMONTHDAY=13;BYDAY=FR", "FREQ=DAILY;UNTIL=20271231"])
    it(`"${other}" is unsupported`, () => expect(parseRRule(other).kind).toBe("unsupported"))
  it("valid rules round-trip", () => {
    for (const good of ["FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;COUNT=6", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU", "FREQ=DAILY;UNTIL=20271231T230000Z", "FREQ=MONTHLY;BYMONTHDAY=1,15,-1", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"]) {
      const r = parseRRule(good)
      expect(r.kind === "ok" && formatRRule(r.rule)).toBe(good)
    }
    const lower = parseRRule("freq=weekly;byday=mo")
    expect(lower.kind === "ok" && formatRRule(lower.rule)).toBe("FREQ=WEEKLY;BYDAY=MO")
  })
  it("a rule that never occurs has no occurrence", () => {
    expect(nextOccurrence(spec("FREQ=MONTHLY;BYMONTH=2", "2026-01-31T09:00"), 0)).toBeUndefined()
  })
})
describe("finding 20: a description says every constraint or nothing", () => {
  for (const r of ["FREQ=MONTHLY;INTERVAL=2;BYDAY=MO", "FREQ=YEARLY;BYMONTH=1,2;BYMONTHDAY=1,15", "FREQ=DAILY;BYMONTH=3", "FREQ=DAILY;BYMONTHDAY=1", "FREQ=WEEKLY;BYMONTH=6;BYDAY=MO",
    "FREQ=DAILY;BYHOUR=9", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "FREQ=YEARLY;BYMONTHDAY=1", "FREQ=MONTHLY;BYDAY=-2FR", "FREQ=DAILY;INTERVAL=2;BYDAY=MO",
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU", "FREQ=DAILY;UNTIL=20271231T230000Z", "FREQ=HOURLY;BYDAY=MO", "FREQ=YEARLY;BYDAY=20MO", "FREQ=MONTHLY;BYMONTHDAY=-2"])
    it(`"${r}" is not described`, () => {
      expect(describeRRule(r, "en")).toBeUndefined()
      expect(describeRRule(r, "nl")).toBeUndefined()
    })
  it("what it can say, it says whole", () => {
    expect(describeRRule("FREQ=MONTHLY;BYDAY=2TU", "en")).toBe("the second Tuesday of every month")
    expect(describeRRule("FREQ=MONTHLY;BYDAY=2TU", "nl")).toBe("de tweede dinsdag van elke maand")
    expect(describeRRule("FREQ=WEEKLY;BYDAY=TU,SU", "en")).toBe("every Tuesday and Sunday")
    expect(describeRRule("FREQ=DAILY;UNTIL=20271231T230000Z", "en", { timeZone: AMS })).toBe("every day, until 1 January 2028 at 00:00")
    expect(describeRRule("FREQ=YEARLY;BYMONTH=3", "en", { start: { year: 2027, month: 3, day: 3 } })).toBe("every year on the third of March")
    expect(describeRRule("FREQ=YEARLY;BYMONTH=3", "en")).toBeUndefined()
  })
})
describe("finding 21: an unknown zone is never another zone", () => {
  it("parsers answer not-understood, whether UTC was used before or not", () => {
    expect(parseDateTime("tomorrow at 5 pm", "en", { now: NOW, timeZone: "Mars/Olympus" }).kind).toBe("not-understood")
    expect(parseDateTime("tomorrow at 5 pm", "en", { now: NOW, timeZone: "UTC" }).kind).toBe("ok")
    expect(parseDateTime("tomorrow at 5 pm", "en", { now: NOW, timeZone: "Mars/Olympus" }).kind).toBe("not-understood")
    expect(parseRecurrence("every day", "en", { now: NOW, timeZone: "Mars/Olympus" }).kind).toBe("not-understood")
    expect(parseDateTime("tomorrow", "en", { now: Number.NaN, timeZone: AMS }).kind).toBe("not-understood")
    expect(nextOccurrence({ rrule: "FREQ=DAILY", dtstart: "2026-11-20T09:00", timeZone: "Mars/Olympus" }, 0)).toBeUndefined()
    expect(() => offsetAt(0, "Mars/Olympus")).toThrow(RangeError)
  })
  it("a padded or differently cased zone (as Home may store it) is that zone", () => {
    expect(normalizeTimeZone(" Europe/Amsterdam ")).toBe(AMS)
    expect(normalizeTimeZone("europe/amsterdam")).toBe(AMS)
    expect(normalizeTimeZone("")).toBeUndefined()
    const padded = parseDateTime("tomorrow at 5 pm", "en", { now: NOW, timeZone: " Europe/Amsterdam " })
    expect(padded.kind === "ok" && padded.value.instant).toBe(ams(2026, 11, 19, 17))
    const r = parseRecurrence("every day", "en", { now: NOW, timeZone: " europe/amsterdam" })
    expect(r.kind === "ok" && r.value.dtstart).toBe("DTSTART;TZID=Europe/Amsterdam:20261119T090000")
  })
})

describe("finding 22: a nonzero amount is never said as zero", () => {
  it("numbers keep two significant digits below 1", () => {
    expect(speakNumber(0.001, "en")).toBe("0.001")
    expect(speakNumber(0.000123, "en")).toBe("0.00012")
    expect(speakNumber(0.001, "nl")).toBe("0,001")
    expect(speakNumber(0.001, "en", { words: true })).toBe("zero point zero zero one")
    expect(speakNumber(-0.004, "en")).toBe("minus 0.004")
    expect(speakNumber(2.346, "en")).toBe("2.35")
    expect(speakNumber(Number.NaN, "en")).toBe("")
  })
  it("amounts convert without rounding to zero, and humanise only exactly", () => {
    expect(speakAmount({ amount: 0.0001, unit: "kg" }, "en")).toBe("0.1 grams")
    expect(speakAmount({ amount: 0.25, unit: "kg" }, "en")).toBe("250 grams")
    expect(speakAmount({ amount: 0.0005, unit: "l" }, "nl")).toBe("0,5 milliliter")
    expect(speakAmount({ amount: 1500, unit: "g" }, "en")).toBe("1.5 kilograms")
    expect(speakAmount({ amount: 1234, unit: "g" }, "en")).toBe("1234 grams")
    expect(speakAmount({ amount: 1.001, unit: "kg" }, "en")).toBe("1 kilogram")
  })
})

describe("finding 27: the package index exports the tokenizer", () => {
  it("tokenize and sliceText are exported", () => {
    expect(language.tokenize("7pm").map((t) => t.norm)).toEqual(["7", "pm"])
    expect(typeof language.sliceText).toBe("function")
  })
})

describe("finding 28: said is the text as written", () => {
  const said = (t: string, lang: "en" | "nl" = "en") => {
    const r = parseRecurrence(t, lang, ropts)
    return r.kind === "ok" ? r.said : r.kind
  }
  it("is the whole phrase", () => {
    expect(said("every month on the 15th")).toBe("every month on the 15th")
    expect(said("on the 15th of every month at 9 am")).toBe("on the 15th of every month at 9 am")
    expect(said(" every Monday and Friday at half past seven ")).toBe("every Monday and Friday at half past seven")
    expect(said("op de laatste dag van de maand", "nl")).toBe("op de laatste dag van de maand")
  })
})
describe("beyond the list: found while re-reading", () => {
  it("an alternative, an unread clock time or a second date is not dropped", () => {
    for (const t of ["tomorrow at 5 maybe 6", "tomorrow at 25", "tomorrow at half past", "tomorrow and the day after", "between 5 and 6 tomorrow", "2 days from now", "the 3rd of next month"])
      expect(date(t), t).toBe("not-understood")
    for (const t of ["morgen tegen vijven", "morgen om kwart", "morgen half", "morgen om 5 uur of 6 uur"]) expect(date(t, "nl"), t).toBe("not-understood")
  })
  it("the small hours of tonight are after midnight", () => {
    expect(date("tonight at 2 am")).toBe("2026-11-19 02:00")
    expect(date("tomorrow night at 1 am")).toBe("2026-11-20 01:00")
    expect(date("vannacht om drie uur", "nl", { now: ams(2026, 11, 18, 1, 0), timeZone: AMS })).toBe("2026-11-18 03:00")
  })
  it("\"the first of the month\" is read whole", () => {
    const r = parseDateTime("the first of the month", "en", dopts)
    expect(r.kind === "ok" && [ymd(r.value.date), r.said]).toEqual(["2026-12-01", "the first of the month"])
  })
  it("a quantity whose item holds another amount is two items or an alternative", () => {
    for (const t of ["2 kg flour and 3 eggs", "2 or 3 apples", "two cups and a half of flour"]) expect(parseQuantity(t, "en").kind, t).toBe("not-understood")
    expect(parseQuantity("2 kg flour", "en").kind).toBe("ok")
  })
})
