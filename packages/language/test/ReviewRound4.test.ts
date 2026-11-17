// Review round 4 of the language package: the reviewer's own inputs, finding by finding. Each behaviour is also caught by a permanent
// test (the generators, enumerations and mutation list were extended first); the PR's round-4 account says which.
import { describe, expect, it } from "@effect/vitest"
import {
  describeRRule, occurrencesAfter, parseDateTime, parseDuration, parseNumber, parseQuantity, parseRecurrence, parseRRule, parseTimeOfDay, seriesAfter, speakAmount,
  speakNumber
} from "../src/index.ts"

const kind = (r: { kind: string }) => r.kind
const utc = { now: Date.parse("2026-11-18T10:00Z"), timeZone: "UTC" }

describe("round 4 findings", () => {
  it("1: an interval above one says its phase, the first day, or the rule is not described", () => {
    const options = { start: { year: 2026, month: 11, day: 20 }, time: { hour: 9, minute: 0 } }
    expect(describeRRule("FREQ=DAILY;INTERVAL=2", "en", options)).toBe("every other day at nine o'clock in the morning, from 20 November 2026")
    expect(describeRRule("FREQ=DAILY;INTERVAL=2", "nl", options)).toBe("om de dag om negen uur 's ochtends, vanaf 20 november 2026")
    expect(describeRRule("FREQ=DAILY;INTERVAL=2", "en", { time: { hour: 9, minute: 0 } })).toBeUndefined()
  })
  it("2: speakAmount never says a rounded quantity", () => {
    expect(speakAmount({ amount: 1.234, unit: "kg" }, "en", { item: "rice", humanize: false })).toBeUndefined()
    expect(speakAmount({ amount: 1.234, unit: "kg" }, "nl", { item: "rice", humanize: false })).toBeUndefined()
    expect(speakAmount({ amount: 0.006, unit: "kg" }, "en", { humanize: false })).toBeUndefined()
    expect(speakAmount({ amount: 1.234, unit: "kg" }, "en", { item: "rice" })).toBe("1234 grams of rice")
    expect(speakAmount({ amount: 0.006, unit: "kg" }, "en")).toBe("6 grams")
  })
  it("3: seriesAfter refuses what readSeries refuses", () => {
    const rule = { freq: "WEEKLY" as const, interval: 1, byDay: [{ weekday: "TU" as const }], byMonthDay: [], byMonth: [] }
    expect(seriesAfter({ rule, start: { year: 2026, month: 11, day: 16, hour: 9, minute: 0, second: 0 }, timeZone: "UTC" }, 0, 2)).toBeUndefined()
    expect(seriesAfter({ rule, start: { year: 2026, month: 11, day: 16, second: 0 } as never, timeZone: "UTC" }, 0, 2)).toBeUndefined()
  })
  it("4: a finished COUNT or UNTIL series says series, also at the end of the range", () => {
    const at = (rrule: string, after: number) => occurrencesAfter({ rrule, dtstart: "DTSTART;TZID=UTC:21991231T090000", timeZone: "UTC" }, after, 10)
    for (const rrule of ["FREQ=DAILY;COUNT=1", "FREQ=DAILY;UNTIL=21991231T090000Z"]) {
      expect(at(rrule, Date.parse("2199-12-30T00:00Z"))).toEqual({ instants: [7258064400000], stop: "series" })
      expect(at(rrule, Date.parse("2200-01-01T00:00Z"))).toEqual({ instants: [], stop: "series" })
    }
    expect(occurrencesAfter({ rrule: "FREQ=YEARLY;INTERVAL=999;COUNT=1", dtstart: "DTSTART;TZID=UTC:20261118T090000", timeZone: "UTC" }, Date.parse("2026-11-17T00:00Z"), 10)?.stop).toBe("series")
  })
  it("5: decimal durations are exact", () => {
    expect(parseDuration("128.05 days", "en")).toMatchObject({ kind: "ok", value: 11_063_520_000 })
    expect(parseDuration("128,05 dagen", "nl")).toMatchObject({ kind: "ok", value: 11_063_520_000 })
    expect(parseDuration("16.08 weeks", "en")).toMatchObject({ kind: "ok", value: 9_725_184_000 })
    expect(parseDuration("16,08 weken", "nl")).toMatchObject({ kind: "ok", value: 9_725_184_000 })
    expect(parseDuration("4096.02 hours", "en")).toMatchObject({ kind: "ok", value: 14_745_672_000 })
    expect(parseDuration("4096,02 uur", "nl")).toMatchObject({ kind: "ok", value: 14_745_672_000 })
    const now = Date.parse("2026-11-18T10:00Z")
    for (const [t, l] of [["in 4096.02 hours", "en"], ["over 4096,02 uur", "nl"]] as const) {
      const r = parseDateTime(t, l, { now, timeZone: "UTC" })
      expect(r.kind === "ok" ? r.value.instant : r.kind, t).toBe(now + 14_745_672_000)
    }
  })
  it("9: the size is checked on the number given", () => {
    expect(speakNumber(999_999.994, "en")).toBeUndefined()
    expect(speakNumber(999_999.994, "nl")).toBeUndefined()
    expect(speakNumber(-999_999.994, "en")).toBeUndefined()
  })
  it("10: Dutch spaced numbers have no six-part ceiling", () => {
    expect(parseNumber("twee honderd vijf en twintig duizend drie honderd vier en twintig", "nl")).toMatchObject({ kind: "ok", value: 225_324 })
    expect(parseNumber("negen honderd negen en negentig duizend negen honderd negen en negentig", "nl")).toMatchObject({ kind: "ok", value: 999_999 })
  })
  it("13: the rest of an item needs its link", () => {
    expect(kind(parseQuantity("the rest rice", "en"))).toBe("not-understood")
    expect(kind(parseQuantity("de rest rijst", "nl"))).toBe("not-understood")
    expect(parseQuantity("the rest of the rice", "en")).toMatchObject({ kind: "ok", value: { rest: true, item: "rice" } })
    expect(parseQuantity("de rest van de rijst", "nl")).toMatchObject({ kind: "ok", value: { rest: true, item: "rijst" } })
    expect(parseQuantity("the rest", "en")).toMatchObject({ kind: "ok", value: { rest: true, item: "" } })
  })
  it("14: an apostrophe the grammar does not have is not repaired away", () => {
    expect(kind(parseNumber("tw'o", "en"))).toBe("not-understood")
    expect(kind(parseQuantity("s'o'm'e sugar", "en"))).toBe("not-understood")
    // The grammar's own: o'clock, zo'n, kilo's (and without the apostrophe); an item word may have one.
    expect(parseTimeOfDay("five o'clock", "en", { band: { from: 0, to: 1439 } })).toMatchObject({ kind: "ok", value: { minute: 0 } })
    expect(parseTimeOfDay("five o’clock", "en", { band: { from: 0, to: 1439 } })).toMatchObject({ kind: "ok", value: { minute: 0 } })
    expect(parseQuantity("zo'n 2 kilo's suiker", "nl")).toMatchObject({ kind: "ok", value: { approx: true, unit: "kg", amount: 2, item: "suiker" } })
    expect(parseQuantity("2 kg baker's flour", "en")).toMatchObject({ kind: "ok", value: { item: "baker's flour" } })
    expect(kind(parseTimeOfDay("five o'cl'ock", "en"))).toBe("not-understood")
  })
  it("18: a time zone given is checked, with or without UNTIL", () => {
    expect(describeRRule("FREQ=DAILY", "en", { timeZone: "not/a/zone" })).toBeUndefined()
    expect(describeRRule("FREQ=DAILY", "nl", { timeZone: "not/a/zone" })).toBeUndefined()
  })
  it("19: a band string is exactly HH:MM", () => {
    expect(kind(parseTimeOfDay("7", "en", { band: { from: "0730", to: "2100" } }))).toBe("not-understood")
  })
  it("20: EVERY ORDINAL UNIT starts at first", () => {
    for (const [t, l] of [["every first day", "en"], ["elke eerste dag", "nl"], ["every 1st day", "en"]] as const) {
      expect(parseRecurrence(t, l, utc), t).toMatchObject({ kind: "ok", value: { rrule: "FREQ=DAILY", dtstart: "DTSTART;TZID=UTC:20261119T090000" } })
    }
    for (const [t, rrule] of [["every first week", "FREQ=WEEKLY"], ["every first month", "FREQ=MONTHLY"], ["every first year", "FREQ=YEARLY"]] as const) {
      expect(parseRecurrence(t, "en", utc), t).toMatchObject({ kind: "ok", value: { rrule } })
    }
  })
  it("21: a malformed value of a part not expanded is invalid", () => {
    for (const r of ["FREQ=DAILY;BYHOUR=garbage", "FREQ=DAILY;BYHOUR=99", "FREQ=YEARLY;BYWEEKNO=0", "FREQ=DAILY;UNTIL=20270230"]) expect(parseRRule(r).kind, r).toBe("invalid")
    for (const r of ["FREQ=DAILY;BYHOUR=9", "FREQ=YEARLY;BYWEEKNO=20", "FREQ=DAILY;UNTIL=20270228"]) expect(parseRRule(r).kind, r).toBe("unsupported")
  })
  it("22: ambiguous candidates keep their minutes", () => {
    const r = parseTimeOfDay("3:15", "en", { band: { from: "09:00", to: "11:00" } })
    expect(r.kind === "ambiguous" ? r.candidates.map((c) => [c.hour, c.minute]) : r.kind).toEqual([[3, 15], [15, 15]])
  })
  it("23: a gap after a zero offset (Casablanca) is read with the offset before it", () => {
    const r = parseDateTime("22 March 2026 at 02:30", "en", { now: Date.parse("2026-03-21T12:00Z"), timeZone: "Africa/Casablanca" })
    expect(r.kind === "ok" ? r.value.instant : r.kind).toBe(1_774_146_600_000)
  })
  it("24: a standalone Dutch number in NFD", () => {
    expect(parseNumber("tweeëntwintig".normalize("NFD"), "nl")).toMatchObject({ kind: "ok", value: 22 })
  })
})
