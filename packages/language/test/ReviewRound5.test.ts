// Review round 5 of the language package: the reviewer's own inputs, finding by finding. Each behaviour is also caught by a permanent
// test (the generated recurrence contexts, the agreement check, the time round trips and the reference matrix were extended first);
// the PR's round-5 account says which.
import { describe, expect, it } from "@effect/vitest"
import { describeRRule, occurrencesAfter, parseRecurrence, parseRRule, parseTimeOfDay, speakAmount, speakTime, type Recurrence } from "../src/index.ts"
import { agree } from "./support/Agree.ts"

const okValue = (r: ReturnType<typeof parseRecurrence>): Recurrence => {
  if (r.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(r)}`)
  return r.value
}
const nuuk = { now: Date.parse("2026-03-28T12:00:00Z"), timeZone: "America/Nuuk" }

describe("round 5 findings", () => {
  it("1: a gap that pushes the time past midnight is an ordinary gap: the pre-gap reading on that day, not a skipped day", () => {
    // Nuuk, Saturday 28 March 2026: the clocks go from 23:00 to 00:00, so 23:30 is read at the offset before the gap.
    for (const [text, language] of [["every day at 23:30", "en"], ["elke dag om 23:30", "nl"], ["every Saturday at 23:30", "en"], ["elke zaterdag om 23:30", "nl"], ["every 2 days at 23:30", "en"], ["om de 2 dagen om 23:30", "nl"]] as const) {
      const r = okValue(parseRecurrence(text, language, nuuk))
      expect(r.start, text).toEqual({ year: 2026, month: 3, day: 28, hour: 23, minute: 30, second: 0 })
      expect(r.startInstant, text).toBe(1774747800000)
      expect(r.dtstart, text).toMatch(/:20260328T233000$/)
      agree(r, nuuk.timeZone)
      // The stored series starts there.
      expect(occurrencesAfter({ rrule: r.rrule, dtstart: r.dtstart, timeZone: r.timeZone }, nuuk.now, 1)?.instants).toEqual([1774747800000])
    }
    // Every two days from 28 March: the phase is the 28th's, so the next is 30 March at 23:30 (UTC−01:00 by then).
    const two = okValue(parseRecurrence("every 2 days at 23:30", "en", nuuk))
    expect(occurrencesAfter({ rrule: two.rrule, dtstart: two.dtstart, timeZone: two.timeZone }, nuuk.now, 2)?.instants).toEqual([1774747800000, Date.parse("2026-03-31T00:30:00Z")])
    // A day the zone skips altogether is still not a start: Apia had no 30 December 2011.
    const apia = okValue(parseRecurrence("every day at 09:00", "en", { now: Date.parse("2011-12-29T22:00:00Z"), timeZone: "Pacific/Apia" }))
    expect(apia.start).toEqual({ year: 2011, month: 12, day: 31, hour: 9, minute: 0, second: 0 })
  })

  it("2: the 24-hour style with `period` says the part of the day of an hour 1–12, and reads back exactly", () => {
    expect(speakTime({ hour: 1, minute: 30 }, "nl", { style: "24h", period: true })).toBe("een uur dertig 's nachts")
    expect(speakTime({ hour: 10, minute: 30 }, "en", { style: "24h", period: true })).toBe("ten thirty in the morning")
    expect(parseTimeOfDay("een uur dertig 's nachts", "nl")).toMatchObject({ kind: "ok", value: { hour: 1, minute: 30, guessed: false } })
    expect(parseTimeOfDay("ten thirty in the morning", "en")).toMatchObject({ kind: "ok", value: { hour: 10, minute: 30, guessed: false } })
    // Settled hours say no part of the day.
    expect(speakTime({ hour: 19, minute: 30 }, "nl", { style: "24h", period: true })).toBe("negentien uur dertig")
    expect(speakTime({ hour: 0, minute: 5 }, "en", { style: "24h", period: true })).toBe("zero oh five")
    // Without `period`, as before: the reading the default band picks, guessed.
    expect(speakTime({ hour: 1, minute: 30 }, "nl", { style: "24h" })).toBe("een uur dertig")
    expect(parseTimeOfDay("een uur dertig", "nl")).toMatchObject({ kind: "ok", value: { hour: 13, minute: 30, guessed: true } })
  })

  it("3: an UNTIL in an hour the clocks repeat is not described: it cannot say which of the two", () => {
    const options = { time: { hour: 2, minute: 30 }, timeZone: "Europe/Amsterdam" }
    // Amsterdam, 25 October 2026: 02:15 happens at 00:15Z and at 01:15Z.
    for (const rrule of ["FREQ=DAILY;UNTIL=20261025T001500Z", "FREQ=DAILY;UNTIL=20261025T011500Z"]) {
      for (const language of ["en", "nl"] as const) expect(describeRRule(rrule, language, options), `${language} ${rrule}`).toBeUndefined()
    }
    // They are different series.
    const after = Date.parse("2026-10-24T12:00:00Z")
    expect(occurrencesAfter({ rrule: "FREQ=DAILY;UNTIL=20261025T001500Z", dtstart: "DTSTART;TZID=Europe/Amsterdam:20261024T023000", timeZone: "Europe/Amsterdam" }, after, 3)).toEqual({ instants: [], stop: "series" })
    expect(occurrencesAfter({ rrule: "FREQ=DAILY;UNTIL=20261025T011500Z", dtstart: "DTSTART;TZID=Europe/Amsterdam:20261024T023000", timeZone: "Europe/Amsterdam" }, after, 3)).toEqual({ instants: [1792888200000], stop: "series" })
    // An UNTIL outside the repeated hour is described as before.
    expect(describeRRule("FREQ=DAILY;UNTIL=20261025T021500Z", "en", options)).toBe("every day at half past two at night, until 25 October 2026 at 03:15")
    expect(describeRRule("FREQ=DAILY;UNTIL=20261024T231500Z", "nl", options)).toBe("elke dag om half drie 's nachts, tot 25 oktober 2026 om 01:15")
  })

  it("4: at the end of the range, UNTIL ends the series unless an actual instance of 2200 is still before it", () => {
    const at = (rrule: string, after: number, limit = 10) => occurrencesAfter({ rrule, dtstart: "DTSTART;TZID=Pacific/Kiritimati:21991230T090000", timeZone: "Pacific/Kiritimati" }, after, limit)
    const only = 7257927600000 // 30 December 2199, 09:00 in Kiritimati (UTC+14)
    for (const rrule of ["FREQ=YEARLY;UNTIL=21991231T230000Z", "FREQ=MONTHLY;UNTIL=21991231T230000Z", "FREQ=WEEKLY;UNTIL=21991231T230000Z", "FREQ=DAILY;INTERVAL=3;UNTIL=21991231T230000Z"]) {
      expect(at(rrule, 0), rrule).toEqual({ instants: [only], stop: "series" })
      expect(at(rrule, Date.parse("2199-12-31T00:00:00Z")), rrule).toEqual({ instants: [], stop: "series" })
      expect(at(rrule, Date.parse("2200-01-10T00:00:00Z")), rrule).toEqual({ instants: [], stop: "series" })
      expect(at(rrule, Infinity), rrule).toEqual({ instants: [], stop: "series" })
      // The limit keeps its priority.
      expect(at(rrule, 0, 1), rrule).toEqual({ instants: [only], stop: "limit" })
    }
    // A daily rule does have an instance of 2200 before that UNTIL: 1 January 2200, 09:00 there is 2199-12-31T19:00Z.
    expect(at("FREQ=DAILY;UNTIL=21991231T230000Z", 0)).toEqual({ instants: [only, only + 86_400_000], stop: "range" })
    expect(at("FREQ=DAILY;UNTIL=21991231T230000Z", Infinity)).toEqual({ instants: [], stop: "range" })
    // Every two days from 30 December lands on 1 January 2200 too.
    expect(at("FREQ=DAILY;INTERVAL=2;UNTIL=21991231T230000Z", 0)).toEqual({ instants: [only], stop: "range" })
  })

  it("5: a parsed recurrence's start agrees with its DTSTART, start instant and ICS, with default times and both DST readings", () => {
    const utc = { now: Date.parse("2026-11-18T10:00:00Z"), timeZone: "UTC" }
    const monday = okValue(parseRecurrence("every Monday at 09:30", "en", utc))
    expect(monday.start).toEqual({ year: 2026, month: 11, day: 23, hour: 9, minute: 30, second: 0 })
    agree(monday, "UTC")
    // A default time: 09:00.
    const plain = okValue(parseRecurrence("every Monday", "en", utc))
    expect(plain).toMatchObject({ timeDefaulted: true, start: { year: 2026, month: 11, day: 23, hour: 9, minute: 0 }, startInstant: Date.UTC(2026, 10, 23, 9) })
    agree(plain, "UTC")
    // A part of the day's usual time: the evening, 19:00.
    const evening = okValue(parseRecurrence("elke vrijdagavond", "nl", { now: Date.parse("2026-11-18T10:00:00Z"), timeZone: "Europe/Amsterdam" }))
    expect(evening).toMatchObject({ timeDefaulted: true, start: { year: 2026, month: 11, day: 20, hour: 19, minute: 0 } })
    agree(evening, "Europe/Amsterdam")
    // The autumn fold: the first 02:30 (00:30Z); the spring gap: the pre-gap reading (01:30Z).
    const fold = okValue(parseRecurrence("every day at 02:30", "en", { now: Date.parse("2026-10-24T12:00:00Z"), timeZone: "Europe/Amsterdam" }))
    expect(fold).toMatchObject({ start: { year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, startInstant: Date.parse("2026-10-25T00:30:00Z") })
    agree(fold, "Europe/Amsterdam")
    const gap = okValue(parseRecurrence("elke dag om 02:30", "nl", { now: Date.parse("2026-03-28T12:00:00Z"), timeZone: "Europe/Amsterdam" }))
    expect(gap).toMatchObject({ start: { year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, startInstant: Date.parse("2026-03-29T01:30:00Z") })
    agree(gap, "Europe/Amsterdam")
    // The check catches the reviewer's mutation: a start whose clock is not DTSTART's.
    expect(() => agree({ ...monday, start: { ...monday.start, hour: 0, minute: 0 } }, "UTC")).toThrow(/dtstart/)
  })

  it("6: whole hundredths are judged with an allowance scaled to the number, not a fixed one", () => {
    expect(speakAmount({ amount: 1.000000001, unit: "kg" }, "en", { humanize: false })).toBeUndefined()
    expect(speakAmount({ amount: 1.000000001, unit: "kg" }, "nl", { humanize: false })).toBeUndefined()
    for (const v of [0.25, 1, 2.5, 99.99, 1234.56, 999_999.99]) {
      for (const near of [v * (1 + 1e-12), v * (1 - 1e-12), v * (1 + 1e-9), v * (1 - 1e-9)]) {
        expect(speakAmount({ amount: near, unit: "kg" }, "en", { humanize: false }), `${near} kg`).toBeUndefined()
        expect(speakAmount({ amount: near, unit: "piece" }, "nl", { item: "appels" }), `${near} pieces`).toBeUndefined()
      }
      expect(speakAmount({ amount: v, unit: "kg" }, "en", { humanize: false }), `${v} kg`).toBeDefined()
    }
    // Ordinary sums of hundredths are still said.
    expect(speakAmount({ amount: 0.1 + 0.2, unit: "kg" }, "en", { humanize: false })).toBe("0.3 kilograms")
    expect(speakAmount({ amount: 1.1 * 3, unit: "l" }, "en", { humanize: false })).toBe("3.3 litres")
    expect(speakAmount({ amount: 0.7 + 0.1, unit: "kg" }, "nl", { humanize: false })).toBe("0,8 kilo")
    expect(speakAmount({ amount: 0.1 + 0.2, unit: "kg" }, "en")).toBe("300 grams")
  })

  it("7, 8: outside the supported set is never ok; padded month and day numbers are not RFC 5545's", () => {
    expect(parseRRule("FREQ=YEARLY;BYMONTH=003;BYMONTHDAY=3").kind).not.toBe("ok")
    expect(parseRRule("FREQ=MONTHLY;BYMONTHDAY=001").kind).not.toBe("ok")
    expect(parseRRule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=003").kind).not.toBe("ok")
    // Two digits are RFC 5545's.
    expect(parseRRule("FREQ=YEARLY;BYMONTH=03;BYMONTHDAY=03")).toEqual({ kind: "ok", rule: { freq: "YEARLY", interval: 1, byDay: [], byMonthDay: [3], byMonth: [3] } })
    expect(parseRRule("FREQ=MONTHLY;BYMONTHDAY=01,-1")).toMatchObject({ kind: "ok", rule: { byMonthDay: [1, -1] } })
    // The reviewer's other rules: not ok, each with a reason (which kind is a hint).
    for (const r of ["FREQ=HOURLY;BYDAY=0MO", "FREQ=HOURLY;BYDAY=54MO", "FREQ=DAILY;INTERVAL=1000;BYDAY=0MO", "FREQ=DAILY;BYWEEKNO=1", "FREQ=DAILY;BYYEARDAY=1", "FREQ=DAILY;BYSETPOS=1",
      "FREQ=MONTHLY;BYDAY=6MO", "FREQ=DAILY;BYHOUR=1,1", "FREQ=DAILY;UNTIL=20161231T235960Z", "FREQ=DAILY;COUNT=1000000000", "FREQ=DAILY;INTERVAL=1000000000", "FREQ=DAILY;BYHOUR=000", "FREQ=YEARLY;BYWEEKNO=001"]) {
      const read = parseRRule(r)
      expect(read.kind, r).not.toBe("ok")
      expect(read.kind !== "ok" && read.reason.length > 0, r).toBe(true)
    }
  })
})
