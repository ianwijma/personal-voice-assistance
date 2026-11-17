// Review round 3 of the language package: every finding with the reviewer's own examples. Most are also caught by the permanent
// tests (generated phrases and mutants, round trips, the domain fuzz, the recurrence reference); the README's test table says which.
import { describe, expect, it } from "@effect/vitest"
import {
  convertAmount, describeRRule, occurrencesAfter, parseDateTime, parseDuration, parseNumber, parseQuantity, parseRecurrence, parseRRule, parseTimeOfDay, readSeries, speakAmount, speakTime
} from "../src/index.ts"

const now = Date.parse("2026-11-18T09:00:00Z")
const opts = { now, timeZone: "Europe/Amsterdam" }
const kind = (r: { kind: string }) => r.kind
const day = (r: ReturnType<typeof parseDateTime>) => (r.kind === "ok" ? `${r.value.date.year}-${r.value.date.month}-${r.value.date.day}` : r.kind)
const iso = (t: number) => new Date(t).toISOString()

describe("round 3 findings", () => {
  it("1: parseDuration is a closed grammar of its own, with a language", () => {
    for (const t of ["not two hours", "two hours please", "less than two hours", "", "0x10", "1e308"]) expect(kind(parseDuration(t, "en")), t).toBe("not-understood")
    for (const t of ["geen twee uur", "minder dan twee uur"]) expect(kind(parseDuration(t, "nl")), t).toBe("not-understood")
    expect(parseDuration("three quarters of an hour", "en")).toMatchObject({ kind: "ok", value: 2_700_000 })
    expect(parseDuration("1 day 12 hours", "en")).toMatchObject({ kind: "ok", value: 129_600_000 })
  })
  it("2: a huge relative duration is refused, not a crash", () => {
    expect(kind(parseDateTime("in 999999999999 hours", "en", opts))).toBe("not-understood")
    expect(kind(parseDateTime(`in ${"9".repeat(60)} hours`, "en", opts))).toBe("not-understood")
    expect(kind(parseDateTime("in 8760 hours", "en", opts))).toBe("ok")
    expect(kind(parseDateTime("in 8761 hours", "en", opts))).toBe("not-understood")
  })
  it("3: a finite but invalid now is refused", () => {
    expect(kind(parseDateTime("tomorrow", "en", { now: Number.MAX_VALUE, timeZone: "UTC" }))).toBe("not-understood")
    expect(kind(parseRecurrence("every day", "en", { now: Number.MAX_VALUE, timeZone: "UTC" }))).toBe("not-understood")
  })
  it("4: a default time that is not a clock time is refused", () => {
    expect(kind(parseRecurrence("every day", "en", { ...opts, defaultTime: { hour: Number.NaN, minute: 0 } }))).toBe("not-understood")
    expect(kind(parseRecurrence("every day", "en", { ...opts, defaultTime: { hour: 24, minute: 0 } }))).toBe("not-understood")
  })
  it("5: relative durations use the duration and number grammars of the language", () => {
    for (const t of ["in two hours million and thirty minutes", "in million two hours and thirty minutes", "in two uur"]) expect(kind(parseDateTime(t, "en", opts)), t).toBe("not-understood")
    for (const t of ["over twee uur en half dertig minuten", "over two hours"]) expect(kind(parseDateTime(t, "nl", opts)), t).toBe("not-understood")
    expect(parseDateTime("in two hours and thirty minutes", "en", opts)).toMatchObject({ kind: "ok", value: { instant: now + 9_000_000 } })
  })
  it("6: COUNT counts distinct instances", () => {
    expect(occurrencesAfter({ rrule: "FREQ=DAILY;COUNT=4", dtstart: "DTSTART;TZID=Pacific/Apia:20111228T090000", timeZone: "Pacific/Apia" }, Date.parse("2011-12-27T00:00Z"), 10)?.instants.map(iso))
      .toEqual(["2011-12-28T19:00:00.000Z", "2011-12-29T19:00:00.000Z", "2011-12-30T19:00:00.000Z", "2011-12-31T19:00:00.000Z"])
  })
  it("7 and 8: a plain monthly or weekly rule says DTSTART's day", () => {
    expect(describeRRule("FREQ=MONTHLY", "en", { start: { year: 2026, month: 10, day: 30 }, time: { hour: 9, minute: 0 } })).toBe("on the thirtieth of every month at nine o'clock in the morning")
    expect(describeRRule("FREQ=MONTHLY", "nl", { start: { year: 2026, month: 10, day: 30 }, time: { hour: 9, minute: 0 } })).toBe("op de dertigste van elke maand om negen uur 's ochtends")
    expect(describeRRule("FREQ=WEEKLY", "en", { start: { year: 2026, month: 11, day: 16 }, time: { hour: 9, minute: 0 } })).toBe("every Monday at nine o'clock in the morning")
    const back = parseRecurrence("every Monday at nine o'clock in the morning", "en", opts)
    expect(back.kind === "ok" && back.value.dtstart).toBe("DTSTART;TZID=Europe/Amsterdam:20261123T090000")
  })
  it("9: an item holding an amount, some, or the rest is refused", () => {
    for (const t of ["2 kg bloem tweeënhalf", "2 kg bloem en tweeënhalf", "2 kg bloem, wat suiker", "2 kg bloem een paar appels"]) expect(kind(parseQuantity(t, "nl")), t).toBe("not-understood")
    for (const t of ["2 kg flour, some sugar", "2 kg flour and the rest of sugar"]) expect(kind(parseQuantity(t, "en")), t).toBe("not-understood")
  })
  it("10: conversions never underflow or overflow; the cup size is bounded", () => {
    expect(convertAmount(Number.MIN_VALUE, "g", "kg")).toBeUndefined()
    expect(convertAmount(1e308, "kg", "g")).toBeUndefined()
    expect(convertAmount(1e308, "kg", "kg")).toBeUndefined()
    expect(kind(parseQuantity("2 cups milk", "en", { cupMl: Number.MAX_VALUE }))).toBe("not-understood")
    expect(parseQuantity("2 cups milk", "en", { cupMl: 236.588 })).toMatchObject({ kind: "ok", value: { base: { amount: 473.176, unit: "ml" } } })
  })
  it("11: Dutch has no pound or ounce of 453.6 g to say or read", () => {
    expect(kind(parseQuantity("1 lb suiker", "nl"))).toBe("not-understood")
    expect(speakAmount({ amount: 1, unit: "lb" }, "nl", { item: "suiker" })).toBeUndefined()
    expect(speakAmount({ amount: 2, unit: "oz" }, "nl", { item: "suiker", humanize: false })).toBeUndefined()
    expect(parseQuantity("een pond suiker", "nl")).toMatchObject({ kind: "ok", value: { base: { amount: 500 } } })
  })
  it("12: the reviewer's descriptions (round 4: descriptions are for speaking and not promised to read back; the parser reads these phrases)", () => {
    expect(describeRRule("FREQ=DAILY;INTERVAL=100", "en", { start: { year: 2026, month: 11, day: 20 } })).toBe("every 100 days, from 20 November 2026")
    expect(parseRecurrence("every 100 days", "en", opts)).toMatchObject({ kind: "ok", value: { rrule: "FREQ=DAILY;INTERVAL=100" } })
    expect(parseRecurrence("elke 100 dagen", "nl", opts)).toMatchObject({ kind: "ok", value: { rrule: "FREQ=DAILY;INTERVAL=100" } })
    const lists = describeRRule("FREQ=MONTHLY;BYMONTHDAY=1,15,31", "en")!
    expect(lists).toBe("on the first, the fifteenth and the thirty first of every month")
    expect(parseRecurrence("on the first, the fifteenth and the thirty first of every month", "en", opts)).toMatchObject({ kind: "ok", value: { rrule: "FREQ=MONTHLY;BYMONTHDAY=1,15,31" } })
    expect(describeRRule("FREQ=DAILY;COUNT=5", "en")).toBe("every day, 5 times")
  })
  it("13: tonight at midnight is the end of today, also in the small hours", () => {
    const small = { now: Date.parse("2026-11-18T00:00Z"), timeZone: "Europe/Amsterdam" }
    expect(day(parseDateTime("tonight at midnight", "en", small))).toBe("2026-11-19")
    expect(day(parseDateTime("vannacht om middernacht", "nl", small))).toBe("2026-11-19")
  })
  it("14: no date outside 2000–2199", () => {
    const late = { now: Date.parse("2199-12-31T12:00Z"), timeZone: "UTC" }
    for (const t of ["tomorrow", "at 24:00", "in 999 years", "in 2 days"]) expect(kind(parseDateTime(t, "en", late)), t).toBe("not-understood")
    expect(kind(parseDateTime("gisteren", "nl", { now: Date.parse("2000-01-01T12:00Z"), timeZone: "UTC" }))).toBe("not-understood")
    expect(kind(parseDateTime("tomorrow", "en", { now: Date.parse("9999-12-31T12:00Z"), timeZone: "UTC" }))).toBe("not-understood")
  })
  it("15: the last week of 2199 has nothing in 2200", () => {
    expect(occurrencesAfter({ rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", dtstart: "DTSTART;TZID=UTC:21991227T090000", timeZone: "UTC" }, Date.parse("2199-12-27T10:00Z"), 10)?.stop).toBe("range")
  })
  it("a date outside 2000–2199 in a rule is unsupported, not moved", () => {
    expect(parseRRule("FREQ=DAILY;UNTIL=99991231T000000Z").kind).toBe("unsupported")
    expect(parseRRule("FREQ=DAILY;UNTIL=19991231T000000Z").kind).toBe("unsupported")
    expect(parseRRule("FREQ=DAILY;UNTIL=20270230T000000Z").kind).toBe("invalid")
    expect(readSeries({ rrule: "FREQ=DAILY", dtstart: "DTSTART;TZID=UTC:22000101T090000", timeZone: "UTC" }).kind).toBe("unsupported")
  })
  it("16: UNTIL before DTSTART is invalid", () => {
    expect(readSeries({ rrule: "FREQ=DAILY;UNTIL=20261117T090000Z", dtstart: "DTSTART;TZID=UTC:20261118T090000", timeZone: "UTC" }).kind).toBe("invalid")
  })
  it("17: a malformed run of numbers is no number", () => {
    for (const t of ["5 five", "five 5", "5 5"]) expect(kind(parseNumber(t, "en")), t).toBe("not-understood")
    for (const t of ["1 een", "een 1"]) expect(kind(parseNumber(t, "nl")), t).toBe("not-understood")
  })
  it("18: on/op leads a modified weekday", () => {
    for (const [t, l] of [["on this Friday", "en"], ["on coming Friday", "en"], ["op deze vrijdag", "nl"], ["op komende vrijdag", "nl"]] as const) expect(day(parseDateTime(t, l, opts)), t).toBe("2026-11-20")
    expect(kind(parseDateTime("on next Friday", "en", opts))).toBe("ambiguous")
    expect(kind(parseDateTime("op volgende vrijdag", "nl", opts))).toBe("ambiguous")
  })
  it("19: an agreeing part of the day on a settled hour is read", () => {
    expect(parseTimeOfDay("07:00 am", "en")).toMatchObject({ kind: "ok", value: { hour: 7, minute: 0, guessed: false } })
    expect(kind(parseTimeOfDay("07:00 pm", "en"))).toBe("not-understood")
  })
  it("20: the 24-hour speaker's hundred forms read back", () => {
    for (const h of [10, 11, 12]) expect(parseTimeOfDay(speakTime({ hour: h, minute: 0 }, "en", { style: "24h" })!, "en")).toMatchObject({ kind: "ok", value: { hour: h, guessed: false } })
  })
  it("21: the optional x before a unit is no longer offered", () => {
    expect(kind(parseQuantity("3 x bottles of milk", "en"))).toBe("not-understood")
    expect(kind(parseQuantity("3 x flessen melk", "nl"))).toBe("not-understood")
    expect(kind(parseQuantity("3x milk", "en"))).toBe("not-understood")
  })
  it("22: the item is as written; punctuation the grammar does not read refuses the phrase", () => {
    for (const t of ["2 kg flour-", "2 kg 'flour'"]) expect(kind(parseQuantity(t, "en")), t).toBe("not-understood")
    expect(parseQuantity("2 kg Ben's crème fraîche.", "en")).toMatchObject({ kind: "ok", value: { item: "Ben's crème fraîche" } })
  })
  it("23: an amount that cannot be said is undefined, not a broken utterance", () => {
    expect(speakAmount({ amount: 1e21, unit: "kg" }, "en")).toBeUndefined()
    expect(speakAmount({ amount: 1e21, unit: "kg" }, "nl")).toBeUndefined()
    expect(speakAmount({ amount: 1e-95, unit: "g" }, "en")).toBeUndefined()
  })
  it("24: a decomposed accent is part of its word", () => {
    expect(parseQuantity("tweeënhalf kilo rijst".normalize("NFD"), "nl")).toMatchObject({ kind: "ok", value: { amount: 2.5, unit: "kg" } })
  })
})
