// Regression tests for the second review of the modules P2 helpers (PR #88). Each describe names its finding; each has the
// reviewer's example and the class it stands for. The cause of most of them — a parser that answered from the part of the input it
// recognised — is closed by the whole-input rule (README, "The rule"), tested in "whole input" below.
import { describe, expect, it } from "@effect/vitest"
import { parseDateTime, type DateOptions } from "../src/Dates.ts"
import * as language from "../src/index.ts"
import { parseNumber } from "../src/Numbers.ts"
import { convertAmount, parseQuantity } from "../src/Quantity.ts"
import { parseRecurrence, type RecurrenceOptions } from "../src/Recurrence.ts"
import { formatDtstart, nextOccurrence, occurrencesAfter, parseRRule, readSeries, type RecurrenceSpec } from "../src/Rrule.ts"
import { speakAmount, speakNumber } from "../src/Speak.ts"
import { parseTimeOfDay } from "../src/Time.ts"
import { addDays, dayDiff, isoWeekday, isValidLocal, normalizeTimeZone, zonedToInstant } from "../src/Zoned.ts"
import { AMS, ams, dtstartOf, hm, iso, NOW } from "./helpers.ts"

const dopts: DateOptions = { now: NOW, timeZone: AMS } // Wednesday 2026-11-18 10:00
const ropts: RecurrenceOptions = { now: NOW, timeZone: AMS }
const ymd = (d: { year: number; month: number; day: number }) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
const date = (text: string, lang: "en" | "nl" = "en", options: DateOptions = dopts) => {
  const r = parseDateTime(text, lang, options)
  if (r.kind === "ok") return `${ymd(r.value.date)}${r.value.time ? " " + hm(r.value.time) : ""}${r.value.partOfDay ? " " + r.value.partOfDay : ""}`
  if (r.kind === "ambiguous") return `ambiguous: ${r.candidates.map((c) => `${ymd(c.date)}${c.time ? " " + hm(c.time) : ""}`).join(" | ")}`
  return r.kind
}
const rec = (text: string, lang: "en" | "nl" = "en", options: RecurrenceOptions = ropts) => {
  const r = parseRecurrence(text, lang, options)
  if (r.kind === "ambiguous") return `ambiguous: ${r.candidates.map((c) => c.rrule).join(" | ")}`
  return r.kind === "ok" ? `${r.value.rrule} @ ${r.value.dtstart.replace(`DTSTART;TZID=${AMS}:`, "")}` : r.kind
}
const qty = (text: string, lang: "en" | "nl" = "en") => {
  const r = parseQuantity(text, lang)
  return r.kind === "ok" ? `${r.value.amount} ${r.value.unit}${r.value.item ? " " + r.value.item : ""}` : r.kind
}
const spec = (rrule: string, dtstart: string, timeZone = AMS): RecurrenceSpec => ({ rrule, dtstart: dtstartOf(dtstart, timeZone), timeZone })
const utc = (t: number) => new Date(t).toISOString()
/** The instants of `occurrencesAfter` (round 3: it also says why it stopped, and is `undefined` for a spec it refuses). */
const occ = (...a: Parameters<typeof occurrencesAfter>): Array<number> => [...(occurrencesAfter(...a)?.instants ?? [])]

describe("whole input: every parser reads the whole phrase, or answers not-understood", () => {
  // One extra word in every position of phrases each parser reads: none of them may still give an answer.
  const extras = { en: ["not", "maybe", "before", "or", "please", "UTC", "constructor", "except", "less", "and"], nl: ["niet", "misschien", "voor", "of", "graag", "UTC", "constructor", "behalve", "minder", "en"] }
  const phrases = {
    time: { en: ["half past seven", "seven thirty pm", "quarter to seven"], nl: ["half acht", "kwart voor zeven", "zeven uur 's avonds"] },
    date: { en: ["tomorrow at five", "on Friday at 3 pm", "3 March 2027"], nl: ["morgen om vijf uur", "vrijdag om half acht", "3 maart 2027"] },
    recurrence: { en: ["every Monday at nine", "every second Tuesday", "on the first of every month"], nl: ["elke maandag om negen uur", "elke tweede dinsdag", "op de eerste van elke maand"] },
    quantity: { en: ["about 2 kg flour"], nl: ["ongeveer 2 kg bloem"] }
  }
  const parse = (kind: keyof typeof phrases, text: string, lang: "en" | "nl") =>
    kind === "time" ? parseTimeOfDay(text, lang).kind : kind === "date" ? parseDateTime(text, lang, dopts).kind : kind === "recurrence" ? parseRecurrence(text, lang, ropts).kind : parseQuantity(text, lang).kind
  for (const kind of ["time", "date", "recurrence", "quantity"] as const) {
    for (const lang of ["en", "nl"] as const) {
      it(`${kind}, ${lang}: an extra word anywhere is refused`, () => {
        for (const p of phrases[kind][lang]) {
          expect(parse(kind, p, lang), p).toBe("ok")
          const words = p.split(" ")
          for (let at = 0; at <= words.length; at++) {
            for (const extra of extras[lang]) {
              // The quantity's item is everything after the amount: an extra word at the end or inside it is part of the item.
              if (kind === "quantity" && at >= 3 && !/^(and|en|or|of)$/i.test(extra)) continue
              const text = [...words.slice(0, at), extra, ...words.slice(at)].join(" ")
              expect(parse(kind, text, lang), text).not.toBe("ok")
            }
          }
        }
      })
    }
  }
  it("a character outside the words that carries meaning is refused", () => {
    for (const t of ["<5 pm", "~7", "7 +01:00", "7 / 8"]) expect(parseTimeOfDay(t, "en").kind, t).toBe("not-understood")
    for (const t of ["tomorrow at <5", "tomorrow at 5 (UTC)", "tomorrow & Friday", "tomorrow at 5 = 17:00"]) expect(date(t), t).toBe("not-understood")
    for (const t of ["< 2 kg flour", "~2 kg flour", "2 kg flour + 1 kg sugar", "2½ kg flour"]) expect(qty(t), t).toBe("not-understood")
    for (const t of ["every day @ 9", "every Monday & Friday"]) expect(rec(t), t).toBe("not-understood")
    expect(date("Wednesday, 3 March 2027")).toBe("2027-03-03")
  })
  it("the API offers no span to cut out of a longer sentence (findings 17, 28)", () => {
    const d = parseDateTime("tomorrow at five", "en", dopts)
    expect(d.kind === "ok" && ("start" in d.value || "end" in d.value)).toBe(false)
    const q = parseQuantity("2 kg flour", "en")
    expect(q.kind === "ok" && ("start" in q.value || "end" in q.value)).toBe(false)
  })
})

describe("finding 2: BYSETPOS is not offered", () => {
  it("rules with it are unsupported and have no occurrences", () => {
    for (const r of ["FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=9,17;BYSETPOS=1;COUNT=5", "FREQ=MONTHLY;BYDAY=MO,TU;BYHOUR=9,17;BYSETPOS=1", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"]) {
      expect(parseRRule(r).kind, r).toBe("unsupported")
      expect(occ(spec(r, "2026-11-16T09:00"), ams(2026, 11, 1), 5)).toEqual([])
    }
  })
})

describe("finding 3: INTERVAL keeps DTSTART's phase", () => {
  it("the reviewer's rules are unsupported (BYMONTH in a MONTHLY rule, HOURLY)", () => {
    expect(parseRRule("FREQ=MONTHLY;INTERVAL=5;BYMONTH=2").kind).toBe("unsupported")
    expect(parseRRule("FREQ=HOURLY;INTERVAL=5;BYHOUR=9").kind).toBe("unsupported")
  })
  it("in the supported shapes the interval counts periods from DTSTART's, also through periods without an instance", () => {
    // Every 5 months on the 31st from January 2026: in phase are 2026-01, 06, 11, 2027-04, 09, 2028-02 (none has a 31st after January), 2028-07, 12, 2029-05.
    const got = occ(spec("FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=31", "2026-01-31T09:00"), ams(2026, 1, 31, 10), 3).map(iso)
    expect(got).toEqual(["2028-07-31T09:00", "2028-12-31T09:00", "2029-05-31T09:00"])
    // A weekly rule every three weeks on two days keeps both in the same week.
    expect(occ(spec("FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,FR", "2026-11-16T09:00"), ams(2026, 11, 16, 10), 4).map(iso)).toEqual(["2026-11-20T09:00", "2026-12-07T09:00", "2026-12-11T09:00", "2026-12-28T09:00"])
    // Every second year on 29 February: 2024, 2028 (2026 has none, 2030 none, 2032 is in phase).
    expect(occ(spec("FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29", "2024-02-29T09:00"), ams(2024, 3, 1), 3).map(iso)).toEqual(["2028-02-29T09:00", "2032-02-29T09:00", "2036-02-29T09:00"])
  })
})

describe("finding 4: occurrences are in order, without duplicates, around a gap", () => {
  it("one time per day, so a skipped hour is one occurrence; the reviewer's several BYHOUR values are unsupported", () => {
    expect(parseRRule("FREQ=DAILY;BYHOUR=2,3;BYMINUTE=0,30;COUNT=12").kind).toBe("unsupported")
    const got = occ(spec("FREQ=DAILY", "2027-03-27T02:30"), Date.UTC(2027, 2, 26, 0), 4)
    expect(got.map(utc)).toEqual(["2027-03-27T01:30:00.000Z", "2027-03-28T01:30:00.000Z", "2027-03-29T00:30:00.000Z", "2027-03-30T00:30:00.000Z"])
    for (let k = 1; k < got.length; k++) expect(got[k]!).toBeGreaterThan(got[k - 1]!)
  })
  it("a day a zone skips altogether (Pacific/Apia, 30 December 2011) lands on the next day's instant: one occurrence", () => {
    const s = spec("FREQ=DAILY", "2011-12-28T09:00", "Pacific/Apia")
    const got = occ(s, Date.UTC(2011, 11, 27), 4)
    expect(new Set(got).size).toBe(got.length)
    for (let k = 1; k < got.length; k++) expect(got[k]!).toBeGreaterThan(got[k - 1]!)
  })
})

describe("finding 5: no work budget ends a live series", () => {
  it("dense rules are not offered; a daily rule decades from DTSTART answers at once", () => {
    expect(parseRRule("FREQ=DAILY;BYHOUR=0,1,2;BYMINUTE=0,1,2").kind).toBe("unsupported")
    const t0 = performance.now()
    expect(occ(spec("FREQ=DAILY", "2020-01-01T00:00"), ams(2026, 11, 18, 10), 2).map(iso)).toEqual(["2026-11-19T00:00", "2026-11-20T00:00"])
    expect(occ(spec("FREQ=DAILY", "2000-01-01T00:00"), ams(2199, 12, 30, 10), 2).map(iso)).toEqual(["2199-12-31T00:00"])
    expect(occ(spec("FREQ=MONTHLY;BYDAY=-1FR", "2026-01-30T00:00"), ams(2199, 1, 1), 1).map(iso)).toEqual(["2199-01-25T00:00"])
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe("finding 6: no elapsed-time shortcut", () => {
  it("HOURLY rules are not offered: \"every two hours\" is a scheduler job", () => {
    expect(parseRRule("FREQ=HOURLY;INTERVAL=2;COUNT=4").kind).toBe("unsupported")
    expect(rec("every two hours")).toBe("not-understood")
    expect(rec("elke twee uur", "nl")).toBe("not-understood")
  })
})

describe("finding 7: DTSTART and RRULE are checked together", () => {
  it("a date-only, UTC or floating DTSTART is unsupported; UNTIL must be UTC", () => {
    expect(readSeries({ rrule: "FREQ=DAILY", dtstart: "DTSTART;VALUE=DATE:20261118", timeZone: AMS }).kind).toBe("unsupported")
    expect(readSeries({ rrule: "FREQ=DAILY", dtstart: "DTSTART:20261118T090000Z", timeZone: AMS }).kind).toBe("unsupported")
    expect(readSeries({ rrule: "FREQ=DAILY", dtstart: "DTSTART:20261118T090000", timeZone: AMS }).kind).toBe("unsupported")
    expect(parseRRule("FREQ=DAILY;UNTIL=20261130").kind).toBe("unsupported")
    expect(parseRRule("FREQ=DAILY;UNTIL=20261130T090000").kind).toBe("unsupported")
    expect(parseRRule("FREQ=DAILY;UNTIL=20261130T090000Z").kind).toBe("ok")
    expect(nextOccurrence(spec("FREQ=DAILY;BYHOUR=9", "2026-11-18T00:00"), NOW)).toBeUndefined()
  })
  it("DTSTART must be an instance of its rule", () => {
    expect(readSeries(spec("FREQ=WEEKLY;BYDAY=MO", "2026-11-18T09:00")).kind).toBe("invalid") // a Wednesday
    expect(readSeries(spec("FREQ=MONTHLY;BYDAY=2TU", "2026-11-17T09:00")).kind).toBe("invalid") // the third Tuesday
    expect(readSeries(spec("FREQ=YEARLY;BYMONTH=3", "2026-11-18T09:00")).kind).toBe("invalid")
    expect(readSeries(spec("FREQ=WEEKLY;BYDAY=WE", "2026-11-18T09:00")).kind).toBe("ok")
  })
  it("UNTIL is an instant: an occurrence at it is in, one a second later is out", () => {
    const at = spec("FREQ=DAILY;UNTIL=20261120T080000Z", "2026-11-18T09:00")
    expect(occ(at, NOW, 9).map(iso)).toEqual(["2026-11-19T09:00", "2026-11-20T09:00"])
    const before = spec("FREQ=DAILY;UNTIL=20261120T075959Z", "2026-11-18T09:00")
    expect(occ(before, NOW, 9).map(iso)).toEqual(["2026-11-19T09:00"])
  })
})

describe("finding 8: a moment promised in the future is after now, on both sides of the autumn fold", () => {
  // 2026-10-25 in Amsterdam: 03:00 CEST becomes 02:00 CET at 01:00Z, so 02:00–02:59 happen twice (00:00–00:59Z and 01:00–01:59Z).
  for (const now of [Date.UTC(2026, 9, 24, 23, 45), Date.UTC(2026, 9, 25, 0, 15), Date.UTC(2026, 9, 25, 0, 45), Date.UTC(2026, 9, 25, 1, 15), Date.UTC(2026, 9, 25, 1, 45), Date.UTC(2026, 9, 25, 2, 15)]) {
    it(`a bare time at ${utc(now)}`, () => {
      for (const t of ["at 02:30", "at 2:30 am", "at 02:00", "at 03:00", "at 01:30", "at half past two at night", "om 02:30"]) {
        const r = parseDateTime(t, t.startsWith("om") ? "nl" : "en", { now, timeZone: AMS })
        expect(r.kind, t).toBe("ok")
        if (r.kind === "ok") expect(r.value.instant!, `${t} at ${utc(now)}`).toBeGreaterThan(now)
      }
    })
  }
  it("the reviewer's example: at 01:15Z (02:15 the second time), \"at 02:30\" is the second 02:30, 01:30Z", () => {
    const r = parseDateTime("at 02:30", "en", { now: Date.UTC(2026, 9, 25, 1, 15), timeZone: AMS })
    expect(r.kind === "ok" && utc(r.value.instant!)).toBe("2026-10-25T01:30:00.000Z")
  })
  it("\"every hour\" is not offered; a recurrence's first occurrence is after now, also in the fold", () => {
    expect(rec("every hour", "en", { now: Date.UTC(2026, 9, 25, 0, 30), timeZone: AMS })).toBe("not-understood")
    for (const now of [Date.UTC(2026, 9, 25, 0, 15), Date.UTC(2026, 9, 25, 0, 45), Date.UTC(2026, 9, 25, 1, 15)]) {
      const r = parseRecurrence("every day at 02:30", "en", { now, timeZone: AMS })
      expect(r.kind === "ok" && r.value.startInstant > now).toBe(true)
      expect(r.kind === "ok" && nextOccurrence({ rrule: r.value.rrule, dtstart: r.value.dtstart, timeZone: AMS }, now)).toBe(r.kind === "ok" ? r.value.startInstant : -1)
    }
  })
})

describe("finding 9: negation, bounds, alternatives and time zones are refused, not dropped", () => {
  const rows = [
    "tomorrow not at five", "tomorrow before five", "tomorrow after five", "tomorrow at 5 UTC", "tomorrow at 5 CET", "tomorrow at 5 GMT+1", "tomorrow at 17:00 +01:00",
    "not tomorrow", "tomorrow at five or six", "tomorrow or Friday", "until tomorrow at five", "by tomorrow at five", "around five tomorrow", "at least tomorrow", "no later than five",
    "tomorrow at five at the latest", "tomorrow at five Amsterdam time", "tomorrow at five local time", "tomorrow at five in London"
  ]
  for (const t of rows) it(`"${t}"`, () => expect(date(t)).toBe("not-understood"))
  for (const t of ["morgen niet om vijf uur", "morgen voor vijf uur", "morgen na vijf uur", "morgen om 5 uur UTC", "morgen of vrijdag", "uiterlijk morgen", "morgen om vijf uur Nederlandse tijd"])
    it(`nl "${t}"`, () => expect(date(t, "nl")).toBe("not-understood"))
  it("the phrases without the extra words are read", () => {
    expect(date("tomorrow at five")).toBe("2026-11-19 17:00")
    expect(date("morgen om vijf uur", "nl")).toBe("2026-11-19 17:00")
  })
})

describe("finding 10: an unfinished or restricted recurrence is refused", () => {
  for (const t of ["every day at", "every day at nonsense", "every Monday and", "every day in winter", "every day at 9 and", "every", "every Monday at", "on the first of", "every day during the holidays",
    "every weekday except Friday", "every day from 9", "every day between 9 and 5", "every Monday or so", "every day at about 9", "every other", "every day until"])
    it(`"${t}"`, () => expect(rec(t)).toBe("not-understood"))
  for (const t of ["elke dag om", "elke dag om onzin", "elke maandag en", "elke dag in de winter", "elke dag behalve zondag", "elke dag tot juni"])
    it(`nl "${t}"`, () => expect(rec(t, "nl")).toBe("not-understood"))
  it("no default time is invented for a dangling clock", () => {
    expect(rec("every day")).toBe("FREQ=DAILY @ 20261119T090000")
    expect(rec("every day at")).toBe("not-understood")
  })
})

describe("finding 11: alternatives are not a conjunction", () => {
  for (const t of ["every Monday or Friday", "every Monday or Tuesday at nine", "on Mondays or Fridays", "every day or every other day"]) it(`"${t}"`, () => expect(rec(t)).toBe("not-understood"))
  for (const t of ["elke maandag of vrijdag", "op maandagen of vrijdagen"]) it(`nl "${t}"`, () => expect(rec(t, "nl")).toBe("not-understood"))
  it("and is still a conjunction", () => {
    expect(rec("every Monday and Friday")).toBe("FREQ=WEEKLY;BYDAY=MO,FR @ 20261120T090000")
    expect(rec("elke maandag en vrijdag", "nl")).toBe("FREQ=WEEKLY;BYDAY=MO,FR @ 20261120T090000")
  })
})

describe("finding 12: \"every second Tuesday\", \"the second Tuesday of the month\" and \"the second Tuesday\" differ", () => {
  const rows: ReadonlyArray<readonly [string, "en" | "nl", string]> = [
    ["every second Tuesday", "en", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU @ 20261124T090000"], ["the second Tuesday of the month", "en", "FREQ=MONTHLY;BYDAY=2TU @ 20261208T090000"],
    ["every second Tuesday of the month", "en", "FREQ=MONTHLY;BYDAY=2TU @ 20261208T090000"], ["the second Tuesday", "en", "not-understood"], ["the third Friday", "en", "not-understood"],
    ["on the second Tuesday", "en", "not-understood"], ["every first Monday", "en", "not-understood"], ["every last Friday", "en", "not-understood"], ["the last Friday", "en", "not-understood"],
    ["elke tweede dinsdag", "nl", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU @ 20261124T090000"], ["de tweede dinsdag van de maand", "nl", "FREQ=MONTHLY;BYDAY=2TU @ 20261208T090000"],
    ["de tweede dinsdag", "nl", "not-understood"], ["op de derde vrijdag", "nl", "not-understood"], ["elke eerste maandag", "nl", "not-understood"]
  ]
  for (const [t, lang, want] of rows) it(`${lang} "${t}"`, () => expect(rec(t, lang)).toBe(want))
})

describe("finding 13: the small hours of a weekday night are the next day's", () => {
  const rows: ReadonlyArray<readonly [string, "en" | "nl", string]> = [
    ["every Friday night at 1 am", "en", "FREQ=WEEKLY;BYDAY=SA @ 20261121T010000"], ["every Friday night at 1", "en", "FREQ=WEEKLY;BYDAY=SA @ 20261121T010000"],
    ["every Friday night at 11", "en", "FREQ=WEEKLY;BYDAY=FR @ 20261120T230000"], ["every Sunday night at 2 am", "en", "FREQ=WEEKLY;BYDAY=MO @ 20261123T020000"],
    ["every weekday night at 1 am", "en", "FREQ=WEEKLY;BYDAY=TU,WE,TH,FR,SA @ 20261119T010000"], ["every Friday night at midnight", "en", "FREQ=WEEKLY;BYDAY=SA @ 20261121T000000"],
    ["every Friday at 1 am", "en", "FREQ=WEEKLY;BYDAY=FR @ 20261120T010000"], ["every Friday at 1 at night", "en", "FREQ=WEEKLY;BYDAY=FR @ 20261120T010000"],
    ["elke vrijdag nacht om 1 uur", "nl", "FREQ=WEEKLY;BYDAY=SA @ 20261121T010000"], ["elke vrijdagnacht om 1 uur", "nl", "FREQ=WEEKLY;BYDAY=SA @ 20261121T010000"],
    ["elke vrijdag om 1 uur 's nachts", "nl", "FREQ=WEEKLY;BYDAY=FR @ 20261120T010000"]
  ]
  for (const [t, lang, want] of rows) it(`${lang} "${t}"`, () => expect(rec(t, lang)).toBe(want))
  it("dates do the same", () => {
    expect(date("Friday night at 1")).toBe("2026-11-21 01:00")
    expect(date("vrijdagnacht om 1 uur", "nl")).toBe("2026-11-21 01:00")
    expect(date("Friday at 1 am")).toBe("2026-11-20 01:00")
  })
  it("\"midnight\" with a day is ambiguous in a date and refused in a rule that is not daily", () => {
    expect(date("Friday at midnight")).toBe("ambiguous: 2026-11-20 00:00 | 2026-11-21 00:00")
    expect(date("tomorrow at midnight")).toBe("ambiguous: 2026-11-19 00:00 | 2026-11-20 00:00")
    expect(date("tonight at midnight")).toBe("2026-11-19 00:00")
    expect(rec("every Friday at midnight")).toBe("not-understood")
    expect(rec("every day at midnight")).toBe("FREQ=DAILY @ 20261119T000000")
  })
})

describe("finding 14: 24:00 carries to the next day, or is refused", () => {
  it("dates carry it", () => {
    expect(date("tomorrow at 24:00")).toBe("2026-11-20 00:00")
    expect(date("Friday at 24:00")).toBe("2026-11-21 00:00")
    expect(date("3 March 2027 at 24:00")).toBe("2027-03-04 00:00")
    expect(date("at 24:00")).toBe("2026-11-19 00:00")
    expect(date("morgen om 24:00", "nl")).toBe("2026-11-20 00:00")
    expect(date("morgen om 24 uur", "nl")).toBe("2026-11-20 00:00")
  })
  it("a time of day and a recurrence cannot say \"the next day\": refused", () => {
    expect(parseTimeOfDay("24:00", "en").kind).toBe("not-understood")
    expect(parseTimeOfDay("24 uur", "nl").kind).toBe("not-understood")
    expect(rec("every Friday at 24:00")).toBe("not-understood")
    expect(date("tonight at 24:00")).toBe("not-understood")
    expect(date("tomorrow at 24:30")).toBe("not-understood")
  })
})

describe("finding 15: words before the amount other than an approximator are refused", () => {
  for (const t of ["less than 2 kg flour", "not 2 kg flour", "more than 2 kg flour", "at least 2 kg flour", "at most 2 kg flour", "up to 2 kg flour", "almost 2 kg flour", "nearly 2 kg flour",
    "under 2 kg flour", "over 2 kg flour", "buy 2 kg flour", "no 2 kg flour", "maybe 2 kg flour", "exactly 2 kg flour"])
    it(`"${t}"`, () => expect(qty(t)).toBe("not-understood"))
  for (const t of ["minder dan 2 kg bloem", "niet 2 kg bloem", "meer dan 2 kg bloem", "minstens 2 kg bloem", "hoogstens 2 kg bloem", "bijna 2 kg bloem", "ruim 2 kg bloem", "koop 2 kg bloem"])
    it(`nl "${t}"`, () => expect(qty(t, "nl")).toBe("not-understood"))
  it("approximators are read and said", () => {
    const r = parseQuantity("about 2 kg flour", "en")
    expect(r.kind === "ok" && [r.value.amount, r.value.approx]).toEqual([2, true])
    expect(qty("ongeveer 2 kg bloem", "nl")).toBe("2 kg bloem")
  })
})

describe("finding 16: an item holding another amount is refused", () => {
  for (const t of ["2 kg flour or a bag of sugar", "2 kg flour and a kilo of sugar", "2 kg flour and 3 eggs", "2 kg flour and three eggs", "2 kg flour and some sugar", "2 kg flour plus a pack of butter",
    "2 kg flour, 3 eggs", "2 kg flour 500 g sugar", "2 or 3 apples", "two apples or a pear", "a bag of flour and a bag of sugar", "2 kg flour and half a litre of milk", "a kilo of flour and an egg"])
    it(`"${t}"`, () => expect(qty(t)).toBe("not-understood"))
  for (const t of ["2 kg bloem of een zak suiker", "2 kg bloem en een kilo suiker", "2 kg bloem en 3 eieren", "2 kg bloem en drie eieren", "2 kg bloem en wat suiker", "een zak bloem en een zak suiker"])
    it(`nl "${t}"`, () => expect(qty(t, "nl")).toBe("not-understood"))
  it("an item is one thing: \"and\" is reserved (round 3), so \"salt and pepper\" is two items for the caller", () => {
    expect(qty("2 kg salt and pepper")).toBe("not-understood")
    expect(qty("a jar of peanut butter")).toBe("1 jar peanut butter")
    expect(qty("een pot pindakaas", "nl")).toBe("1 jar pindakaas")
  })
})

describe("finding 17: no title extraction", () => {
  it("a sentence with a title between the time words is refused, and no span is returned", () => {
    expect(date("tomorrow call mum at five")).toBe("not-understood")
    expect(rec("every Monday call mum at nine")).toBe("not-understood")
    expect(date("tomorrow at five")).toBe("2026-11-19 17:00")
  })
})

describe("finding 20: no positive amount is rounded to zero", () => {
  it("more decimals than supported (two, round 3) are refused; supported ones keep their value", () => {
    expect(qty("0.001 kg flour")).toBe("not-understood")
    const r = parseQuantity("0.01 kg flour", "en")
    expect(r.kind === "ok" && [r.value.amount, r.value.base?.amount]).toEqual([0.01, 10])
    const g = parseQuantity("0.01 g salt", "en")
    expect(g.kind === "ok" && g.value.base?.amount).toBe(0.01)
  })
  it("conversions keep twelve significant digits and never say 0 for a positive amount; beyond the domain they refuse (round 3, finding 10)", () => {
    expect(convertAmount(0.000001, "ml", "l")).toBe(1e-9)
    expect(convertAmount(1e-12, "g", "kg")).toBeUndefined()
    expect(convertAmount(Number.MIN_VALUE, "g", "kg")).toBeUndefined()
    expect(convertAmount(1e308, "kg", "g")).toBeUndefined()
    expect(convertAmount(1e308, "kg", "kg")).toBeUndefined()
    expect(convertAmount(1e9, "kg", "g")).toBe(1e12)
    expect(convertAmount(0.1 * 3, "l", "ml")).toBe(300)
    expect(convertAmount(1, "tsp", "cup")).toBe(0.02)
  })
})

describe("finding 21: a nonzero number is never said as 0", () => {
  it("below the two-decimal step a nonzero number cannot be said (round 3): undefined, never 0", () => {
    for (const v of [1e-11, 1e-12, -1e-11, -0.004, 1.5e-20, 0.004]) expect(speakNumber(v, "en"), String(v)).toBeUndefined()
    expect(speakNumber(0.005, "en")).toBe("0.01")
    expect(speakNumber(-0.01, "nl")).toBe("min 0,01")
  })
  it("outside the supported range nothing is said: undefined, never another number (round 3, decision 1)", () => {
    expect(speakNumber(1e-95, "en")).toBeUndefined()
    expect(speakNumber(1e22, "en")).toBeUndefined()
    expect(speakNumber(Number.MIN_VALUE, "en")).toBeUndefined()
    expect(speakNumber(1_000_000, "en")).toBeUndefined()
  })
  it("amounts are positive; one that cannot be said is undefined (round 3, finding 23)", () => {
    expect(speakAmount({ amount: 1e-9, unit: "kg" }, "en")).toBeUndefined()
    expect(speakAmount({ amount: 0.00001, unit: "kg" }, "en")).toBe("0.01 grams")
    expect(speakAmount({ amount: -0.5, unit: "kg" }, "en")).toBeUndefined()
    expect(speakAmount({ amount: 1e21, unit: "kg" }, "en")).toBeUndefined()
  })
})

describe("finding 22 (round 3: the supported years are 2000–2199): years outside are refused, never moved", () => {
  it("validity and conversion", () => {
    expect(isValidLocal({ year: 99, month: 1, day: 1 })).toBe(false)
    expect(isValidLocal({ year: 1999, month: 12, day: 31 })).toBe(false)
    expect(isValidLocal({ year: 2000, month: 1, day: 1 })).toBe(true)
    expect(isValidLocal({ year: 2199, month: 12, day: 31 })).toBe(true)
    expect(isValidLocal({ year: 2200, month: 1, day: 1 })).toBe(false)
    expect(utc(zonedToInstant({ year: 2000, month: 1, day: 1, hour: 9 }, "UTC"))).toBe("2000-01-01T09:00:00.000Z")
    expect(addDays({ year: 1000, month: 1, day: 1 }, -1)).toEqual({ year: 999, month: 12, day: 31 })
    expect(dayDiff({ year: 1999, month: 1, day: 1 }, { year: 2000, month: 1, day: 1 })).toBe(365)
    expect(isoWeekday({ year: 2000, month: 1, day: 1 })).toBe(6)
  })
  it("DTSTART and spoken years", () => {
    expect(formatDtstart({ year: 99, month: 1, day: 1, hour: 9, minute: 0 }, AMS)).toBeUndefined()
    expect(readSeries({ rrule: "FREQ=DAILY", dtstart: "DTSTART;TZID=Europe/Amsterdam:00990101T090000", timeZone: AMS }).kind).not.toBe("ok")
    expect(date("3 March 1066")).toBe("not-understood")
    expect(date("3 March 1999")).toBe("not-understood")
    expect(date("3 March 2300")).toBe("not-understood")
    expect(date("3 March 2027")).toBe("2027-03-03")
  })
})

describe("finding 23: one number grammar, total over its input", () => {
  const n = (t: string, lang: "en" | "nl" = "en") => { const r = parseNumber(t, lang); return r.kind === "ok" ? r.value : undefined }
  it("repeated or out-of-order scales are not a number", () => {
    for (const t of ["one thousand two thousand", "thousand thousand", "two hundred three hundred", "hundred thousand hundred", "five five", "twenty thirty", "twenty twenty one", "nineteen five",
      "one hundred and two hundred", "two thousand and three hundred", "zero five", "five zero"])
      expect(n(t), t).toBeUndefined()
    for (const t of ["duizend duizend", "tweeduizend drieduizend", "vijf vijf", "twintig dertig", "honderd honderd", "nul vijf"]) expect(n(t, "nl"), t).toBeUndefined()
    expect(qty("one thousand two thousand grams")).toBe("not-understood")
    expect(qty("a thousand a hundred grams")).toBe("not-understood")
    expect(qty("tweeduizend drieduizend gram suiker", "nl")).toBe("not-understood")
  })
  it("well-formed numbers are read", () => {
    expect(n("two thousand three hundred and five")).toBe(2305)
    expect(n("nine hundred ninety nine thousand nine hundred and ninety nine")).toBe(999_999)
    expect(n("a hundred and one")).toBe(101)
    expect(n("one thousand and five")).toBe(1005)
    expect(n("tweeduizend driehonderdvijf", "nl")).toBe(2305)
    expect(n("negenhonderdnegenennegentigduizend", "nl")).toBe(999_000)
  })
  it("beyond the supported range and precision is not a number", () => {
    // Round 3: whole part at most 999 999, at most two decimals.
    expect(n("1000000")).toBeUndefined()
    expect(n("999999")).toBe(999_999)
    expect(n("1.2345678")).toBeUndefined()
    expect(n("1,23", "nl")).toBe(1.23)
    expect(n("1,234", "nl")).toBeUndefined()
    expect(n("one million")).toBeUndefined()
    expect(n("2 million")).toBeUndefined()
    expect(n("twee miljoen", "nl")).toBeUndefined()
    expect(qty("one million apples")).toBe("not-understood")
    expect(qty("2 apples million")).toBe("not-understood")
    expect(n("two point one two three four five six seven")).toBeUndefined()
  })
})

describe("finding 24: a time zone that is not an IANA name is refused everywhere", () => {
  it("fixed offsets are not zones", () => {
    for (const z of ["+01:00", "+0100", "-05:00", "+01", "GMT+1:00", "UTC+1"]) {
      expect(normalizeTimeZone(z), z).toBeUndefined()
      expect(parseDateTime("tomorrow", "en", { now: NOW, timeZone: z }).kind).toBe("not-understood")
      expect(parseRecurrence("every day", "en", { now: NOW, timeZone: z }).kind).toBe("not-understood")
      expect(formatDtstart({ year: 2026, month: 11, day: 19, hour: 9, minute: 0 }, z)).toBeUndefined()
    }
    for (const z of ["UTC", "Etc/GMT-1", "Europe/Amsterdam"]) expect(normalizeTimeZone(z), z).toBe(z)
    expect(normalizeTimeZone("America/Argentina/Buenos_Aires")).toMatch(/Buenos_Aires$/)
  })
  it("an accepted zone round-trips: format → parse → expand", () => {
    for (const z of ["UTC", "Etc/GMT-1", "Europe/Amsterdam", "Australia/Sydney", "America/Argentina/Buenos_Aires", "Pacific/Chatham"]) {
      const r = parseRecurrence("every day at nine", "en", { now: NOW, timeZone: z })
      expect(r.kind, z).toBe("ok")
      if (r.kind !== "ok") continue
      const s = { rrule: r.value.rrule, dtstart: r.value.dtstart, timeZone: z }
      expect(readSeries(s).kind, z).toBe("ok")
      expect(nextOccurrence(s, NOW)).toBe(r.value.startInstant)
    }
  })
})

describe("found by the self-review scripts", () => {
  it("a range is not a clock time: \"seven to eight\" is not 7:53", () => {
    for (const t of ["seven to eight", "two to three", "seven past eight", "three past four"]) expect(parseTimeOfDay(t, "en").kind, t).toBe("not-understood")
    for (const t of ["drie voor acht", "zeven over acht"]) expect(parseTimeOfDay(t, "nl").kind, t).toBe("not-understood")
    expect(parseTimeOfDay("seven minutes to eight", "en").kind).toBe("ok")
    expect(parseTimeOfDay("five to eight", "en").kind).toBe("ok")
    expect(parseTimeOfDay("drie minuten voor acht", "nl").kind).toBe("ok")
  })
  it("one lead word, only first; one approximator; a part of the day once; \"on\" only before a weekday or a date", () => {
    for (const t of ["at at seven", "seven at", "half past seven at"]) expect(parseTimeOfDay(t, "en").kind, t).toBe("not-understood")
    for (const t of ["on tomorrow at five", "on in two hours", "tonight night", "on tonight"]) expect(date(t), t).toBe("not-understood")
    for (const t of ["op morgen om vijf uur", "vanavond avond", "vrijdagavond avond"]) expect(date(t, "nl"), t).toBe("not-understood")
    for (const t of ["about about 2 kg flour", "roughly about 2 kg flour"]) expect(qty(t), t).toBe("not-understood")
    expect(date("on Friday at five")).toBe("2026-11-20 17:00")
  })
  it("weekdays without \"and\" are a list only with a comma between them", () => {
    // Round 3: punctuation carries no meaning, so a list's items may stand side by side ("every Monday Tuesday" is Monday and Tuesday).
    expect(rec("every Monday Tuesday")).toBe("FREQ=WEEKLY;BYDAY=MO,TU @ 20261123T090000")
    expect(rec("every second Monday Tuesday")).toBe("not-understood")
    expect(rec("every Monday, Wednesday and Friday")).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR @ 20261120T090000")
    expect(rec("de laatste vrijdag van om de maand", "nl")).toBe("not-understood")
  })
  it("an item with an alternative in it, or a Dutch plural unit, is refused", () => {
    for (const t of ["2 kg salt or pepper", "2 kg flour or so", "a kilo of rice or pasta"]) expect(qty(t), t).toBe("not-understood")
    for (const t of ["2 kg zout of peper", "twee snufjes zout"]) expect(t === "twee snufjes zout" ? qty(t, "nl") : qty(t, "nl"), t).toBe(t === "twee snufjes zout" ? "2 pinch zout" : "not-understood")
  })
})

describe("the index exports what the README lists", () => {
  it("parsers, the engine and the helpers", () => {
    for (const name of ["parseNumber", "parseDuration", "parseTimeOfDay", "parseDateTime", "parseQuantity", "parseRecurrence", "parseRRule", "formatRRule", "parseDtstart", "formatDtstart",
      "readSeries", "seriesAfter", "occurrencesAfter", "nextOccurrence", "describeRRule", "normalizeTimeZone"])
      expect(typeof (language as Record<string, unknown>)[name], name).toBe("function")
    // Round 3, decision 3: the low-level readers that could not keep the closed-grammar rule are internal.
    for (const name of ["onlyWords", "accountedFor", "readNumber", "readAmount", "zonedInstants", "tokenize", "matchTime", "resolveTime"]) expect((language as Record<string, unknown>)[name], name).toBeUndefined()
  })
})
