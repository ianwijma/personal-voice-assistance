// Reading ICS files (`expandCalendar`, the function the worker runs): repeating events, exceptions, time zones and
// their clock changes, durations, all-day events, rubbish and cut-off files, the limits, and text holding a private
// link. Called directly here (the same function `ics.task.ts` runs off the main thread); refresh.test.ts runs it
// through the worker.
import { assert, describe, it } from "@effect/vitest"
import ICAL from "ical.js"
import { type ExpandInput, type ExpandOutput, expandCalendar } from "../src/expand.ts"
import { LIMITS } from "../src/provider.ts"
import { instantOf } from "../src/time.ts"
import { AMS, ics } from "./fixtures.ts"
import { vi } from "vitest"

// These tests expand whole calendars (and some start real workers): on a slow two-core CI runner one of them can take
// longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 })

const day = (y: number, m: number, d: number, zone = AMS) => instantOf({ year: y, month: m, day: d }, zone)
/** The cache window of the default test clock: 17 November 2026 to 20 January 2027 (exclusive), Amsterdam. */
const WINDOW = { from: day(2026, 11, 17), to: day(2027, 1, 20) }
const iso = (ms: number) => new Date(ms).toISOString()

const run = (text: string, options: Partial<ExpandInput> = {}): ExpandOutput =>
  expandCalendar(ICAL, { text, from: WINDOW.from, to: WINDOW.to, zone: AMS, forbidden: [], limits: LIMITS, ...options })

const read = (text: string, options: Partial<ExpandInput> = {}) => {
  const r = run(text, options)
  if (!r.ok) throw new Error(`not read: ${r.reason}`)
  return r
}

const starts = (r: { readonly occurrences: ReadonlyArray<{ readonly start: number; readonly title: string }> }) => r.occurrences.map((o) => `${iso(o.start)} ${o.title}`)
const spans = (r: { readonly occurrences: ReadonlyArray<{ readonly start: number; readonly end: number }> }) => r.occurrences.map((o) => `${iso(o.start)}–${iso(o.end)}`)

/** A calendar of raw VEVENT lines. */
const raw = (...events: ReadonlyArray<ReadonlyArray<string>>) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR", ""].join("\r\n")

describe("calendar: reading ICS files", () => {
  it("a weekly series with an excluded date and a moved occurrence, in a VTIMEZONE of its own", () => {
    const vtimezone = [
      "BEGIN:VTIMEZONE",
      "TZID:W. Europe Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16010101T030000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:16010101T020000",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
      "END:DAYLIGHT",
      "END:VTIMEZONE"
    ]
    const tz = "W. Europe Standard Time"
    const r = read(ics([
      { uid: "club", summary: "Club", start: "20261104T193000", end: "20261104T210000", tz, rrule: "FREQ=WEEKLY;COUNT=6", exdate: "20261125T193000" },
      { uid: "club", summary: "Club (moved)", start: "20261203T200000", end: "20261203T213000", tz, recurrenceId: "20261202T193000" }
    ], vtimezone))
    assert.deepStrictEqual(starts(r), ["2026-11-18T18:30:00.000Z Club", "2026-12-03T19:00:00.000Z Club (moved)", "2026-12-09T18:30:00.000Z Club"])
    assert.strictEqual(r.unreadable, 0)
  })

  it("a TZID without a VTIMEZONE is read as the IANA zone it names, across a change of the clocks", () => {
    // From 15 March 2027: the clocks go forward on 28 March in Amsterdam, and the time stays 09:00 there.
    const r = read(ics([{ uid: "w", summary: "Work", start: "20270322T090000", end: "20270322T100000", tz: AMS, rrule: "FREQ=WEEKLY;COUNT=3" }]), { from: day(2027, 3, 15), to: day(2027, 4, 5) })
    assert.deepStrictEqual(r.occurrences.map((o) => iso(o.start)), ["2027-03-22T08:00:00.000Z", "2027-03-29T07:00:00.000Z"])
    // A floating time (no TZID) is the household's; a UTC time is UTC; New York is New York.
    const mixed = read(ics([
      { uid: "f", summary: "Floating", start: "20261120T090000", end: "20261120T093000" },
      { uid: "u", summary: "UTC", start: "20261120T090000Z", end: "20261120T093000Z" },
      { uid: "n", summary: "New York", start: "20261120T090000", end: "20261120T093000", tz: "America/New_York" }
    ]))
    assert.deepStrictEqual(starts(mixed), ["2026-11-20T08:00:00.000Z Floating", "2026-11-20T09:00:00.000Z UTC", "2026-11-20T14:00:00.000Z New York"])
  })

  it("finding 5: an EXDATE and a RECURRENCE-ID in UTC match a series in a TZID without a VTIMEZONE, also across a clock change", () => {
    const r = read(raw(
      ["UID:d", "SUMMARY:Daily", "DTSTART;TZID=Europe/Amsterdam:20261118T090000", "DTEND;TZID=Europe/Amsterdam:20261118T093000", "RRULE:FREQ=DAILY;COUNT=4", "EXDATE:20261119T080000Z"],
      ["UID:d", "SUMMARY:Daily (moved)", "RECURRENCE-ID:20261120T080000Z", "DTSTART:20261120T120000Z", "DTEND:20261120T123000Z"]
    ))
    assert.deepStrictEqual(starts(r), ["2026-11-18T08:00:00.000Z Daily", "2026-11-20T12:00:00.000Z Daily (moved)", "2026-11-21T08:00:00.000Z Daily"])
    // After the clocks go forward (28 March 2027), 09:00 in Amsterdam is 07:00 UTC.
    const spring = read(raw(
      ["UID:s", "SUMMARY:Daily", "DTSTART;TZID=Europe/Amsterdam:20270327T090000", "DTEND;TZID=Europe/Amsterdam:20270327T093000", "RRULE:FREQ=DAILY;COUNT=4", "EXDATE:20270329T070000Z"],
      ["UID:s", "SUMMARY:Daily (moved)", "RECURRENCE-ID:20270330T070000Z", "DTSTART:20270330T150000Z", "DTEND:20270330T153000Z"]
    ), { from: day(2027, 3, 20), to: day(2027, 4, 10) })
    assert.deepStrictEqual(starts(spring), ["2027-03-27T08:00:00.000Z Daily", "2027-03-28T07:00:00.000Z Daily", "2027-03-30T15:00:00.000Z Daily (moved)"])
  })

  it("finding 6: a series that changes its zone from an instance on (RANGE=THISANDFUTURE) keeps the new zone, through both zones' clock changes", () => {
    const r = read(raw(
      ["UID:z", "SUMMARY:Call", "DTSTART;TZID=Europe/Amsterdam:20261118T090000", "DTEND;TZID=Europe/Amsterdam:20261118T100000", "RRULE:FREQ=DAILY;COUNT=4"],
      ["UID:z", "SUMMARY:Call (New York)", "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Amsterdam:20261119T090000", "DTSTART;TZID=America/New_York:20261119T090000", "DTEND;TZID=America/New_York:20261119T100000"]
    ))
    assert.deepStrictEqual(starts(r), ["2026-11-18T08:00:00.000Z Call", "2026-11-19T14:00:00.000Z Call (New York)", "2026-11-20T14:00:00.000Z Call (New York)", "2026-11-21T14:00:00.000Z Call (New York)"])
    assert.deepStrictEqual(r.occurrences.map((o) => (o.end - o.start) / 60_000), [60, 60, 60, 60])
    // March 2027: New York moves its clocks on the 14th, Amsterdam on the 28th; from the 11th the series is New York's.
    const march = read(raw(
      ["UID:m", "SUMMARY:Call", "DTSTART;TZID=Europe/Amsterdam:20270310T090000", "DTEND;TZID=Europe/Amsterdam:20270310T100000", "RRULE:FREQ=DAILY;COUNT=21"],
      ["UID:m", "SUMMARY:Call (New York)", "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Amsterdam:20270311T090000", "DTSTART;TZID=America/New_York:20270311T090000", "DTEND;TZID=America/New_York:20270311T100000"]
    ), { from: day(2027, 3, 9), to: day(2027, 4, 1) })
    const byDay = new Map(march.occurrences.map((o) => [iso(o.start).slice(0, 10), iso(o.start).slice(11, 16)]))
    assert.deepStrictEqual([byDay.get("2027-03-10"), byDay.get("2027-03-13"), byDay.get("2027-03-14"), byDay.get("2027-03-28"), byDay.get("2027-03-30")], ["08:00", "14:00", "13:00", "13:00", "13:00"])
  })

  it("finding 7: hours of a DURATION are elapsed time and days are calendar days, in both directions of a clock change and in the south", () => {
    const one = (start: string, tz: string, duration: string, window: { from: number; to: number }) =>
      spans(read(raw([`UID:x`, "SUMMARY:X", `DTSTART;TZID=${tz}:${start}`, `DURATION:${duration}`]), window))[0]
    const march = { from: day(2027, 3, 20), to: day(2027, 4, 10) }
    // Amsterdam, spring forward at 02:00: 01:30 + two hours is 04:30 there (02:30 UTC), not 03:30.
    assert.strictEqual(one("20270328T013000", AMS, "PT2H", march), "2027-03-28T00:30:00.000Z–2027-03-28T02:30:00.000Z")
    // Amsterdam, fall back at 03:00: 01:30 + two hours is 02:30 the second time (01:30 UTC).
    assert.strictEqual(one("20261025T013000", AMS, "PT2H", { from: day(2026, 10, 20), to: day(2026, 11, 1) }), "2026-10-24T23:30:00.000Z–2026-10-25T01:30:00.000Z")
    // Sydney, spring forward on 4 October 2026 and fall back on 4 April 2027.
    const sydney = (y: number, m: number, d: number) => day(y, m, d, "Australia/Sydney")
    assert.strictEqual(one("20261004T013000", "Australia/Sydney", "PT2H", { from: sydney(2026, 10, 1), to: sydney(2026, 10, 10) }), "2026-10-03T15:30:00.000Z–2026-10-03T17:30:00.000Z")
    assert.strictEqual(one("20270404T013000", "Australia/Sydney", "PT2H", { from: sydney(2027, 4, 1), to: sydney(2027, 4, 10) }), "2027-04-03T14:30:00.000Z–2027-04-03T16:30:00.000Z")
    // A day is a calendar day: noon to noon across the change, 23 elapsed hours.
    assert.strictEqual(one("20270327T120000", AMS, "P1D", march), "2027-03-27T11:00:00.000Z–2027-03-28T10:00:00.000Z")
    // A daily series across the change: each instance two elapsed hours; one with a DTEND lasts exactly as long as the first.
    const daily = read(raw(["UID:d", "SUMMARY:D", "DTSTART;TZID=Europe/Amsterdam:20270327T013000", "DURATION:PT2H", "RRULE:FREQ=DAILY;COUNT=3"]), march)
    assert.deepStrictEqual(daily.occurrences.map((o) => (o.end - o.start) / 3_600_000), [2, 2, 2])
    const ended = read(raw(["UID:e", "SUMMARY:E", "DTSTART;TZID=Europe/Amsterdam:20270327T013000", "DTEND;TZID=Europe/Amsterdam:20270327T033000", "RRULE:FREQ=DAILY;COUNT=3"]), march)
    assert.deepStrictEqual(ended.occurrences.map((o) => (o.end - o.start) / 3_600_000), [2, 2, 2])
  })

  it("finding 8: an instance moved into the window from beyond it is there; one moved out, either way, is not", () => {
    const r = read(raw(
      ["UID:w", "SUMMARY:Weekly", "DTSTART:20261101T100000Z", "DTEND:20261101T110000Z", "RRULE:FREQ=WEEKLY"],
      ["UID:w", "SUMMARY:Moved in", "RECURRENCE-ID:20270207T100000Z", "DTSTART:20261118T120000Z", "DTEND:20261118T130000Z"],
      ["UID:w", "SUMMARY:Moved out", "RECURRENCE-ID:20261122T100000Z", "DTSTART:20270301T100000Z", "DTEND:20270301T110000Z"],
      ["UID:w", "SUMMARY:Moved before", "RECURRENCE-ID:20261129T100000Z", "DTSTART:20261110T100000Z", "DTEND:20261110T110000Z"]
    ))
    const titles = starts(r)
    assert.include(titles, "2026-11-18T12:00:00.000Z Moved in")
    assert.notInclude(titles.join(), "Moved out")
    assert.notInclude(titles.join(), "Moved before")
    assert.notInclude(titles, "2026-11-22T10:00:00.000Z Weekly")
    assert.notInclude(titles, "2026-11-29T10:00:00.000Z Weekly")
    assert.include(titles, "2026-12-06T10:00:00.000Z Weekly")
    assert.strictEqual(r.unreadable, 0)
  })

  it("finding 9: a period RDATE keeps the series and has its own end (an end or a duration)", () => {
    const r = read(raw(["UID:p", "SUMMARY:P", "DTSTART:20261118T090000Z", "DTEND:20261118T100000Z", "RDATE;VALUE=PERIOD:20261119T090000Z/20261119T120000Z,20261120T090000Z/PT30M"]))
    assert.deepStrictEqual(spans(r), [
      "2026-11-18T09:00:00.000Z–2026-11-18T10:00:00.000Z",
      "2026-11-19T09:00:00.000Z–2026-11-19T12:00:00.000Z",
      "2026-11-20T09:00:00.000Z–2026-11-20T09:30:00.000Z"
    ])
    assert.strictEqual(r.unreadable, 0)
  })

  it("finding 10: a TZID that is neither defined nor an IANA zone is left out and counted, never read as the household's", () => {
    const r = read(raw(
      ["UID:u", "SUMMARY:Unknown", "DTSTART;TZID=Unknown/Zone:20261118T090000", "DTEND;TZID=Unknown/Zone:20261118T100000"],
      ["UID:k", "SUMMARY:Known", "DTSTART:20261118T090000Z", "DTEND:20261118T100000Z"]
    ))
    assert.deepStrictEqual(starts(r), ["2026-11-18T09:00:00.000Z Known"])
    assert.strictEqual(r.unreadable, 1)
    // A definition over the bound is not used: an IANA name is then read as that zone, any other name is unresolved.
    const huge = (tzid: string) => ["BEGIN:VTIMEZONE", `TZID:${tzid}`, ...Array.from({ length: 1_000 }, (_, i) => `X-PAD-${i}:x`), "BEGIN:STANDARD", "DTSTART:16010101T030000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", "END:STANDARD", "END:VTIMEZONE"]
    const custom = read(ics([{ uid: "c", summary: "Custom", start: "20261118T090000", end: "20261118T100000", tz: "Custom Zone" }], huge("Custom Zone")))
    assert.deepStrictEqual(custom.occurrences, [])
    assert.strictEqual(custom.unreadable, 1)
    const iana = read(ics([{ uid: "a", summary: "Amsterdam", start: "20261118T090000", end: "20261118T100000", tz: AMS }], huge(AMS)))
    assert.deepStrictEqual(starts(iana), ["2026-11-18T08:00:00.000Z Amsterdam"])
  })

  it("finding 11: a cancelled instance without a DTSTART (a tombstone) takes that instance out", () => {
    const r = read(raw(
      ["UID:t", "SUMMARY:Daily", "DTSTART:20261118T090000Z", "DTEND:20261118T100000Z", "RRULE:FREQ=DAILY;COUNT=3"],
      ["UID:t", "RECURRENCE-ID:20261119T090000Z", "STATUS:CANCELLED"]
    ))
    assert.deepStrictEqual(r.occurrences.map((o) => iso(o.start)), ["2026-11-18T09:00:00.000Z", "2026-11-20T09:00:00.000Z"])
    assert.strictEqual(r.unreadable, 0)
    // A cancelled range (RANGE=THISANDFUTURE) takes out that instance and every later one.
    const range = read(raw(
      ["UID:t", "SUMMARY:Daily", "DTSTART:20261118T090000Z", "DTEND:20261118T100000Z", "RRULE:FREQ=DAILY;COUNT=5"],
      ["UID:t", "RECURRENCE-ID;RANGE=THISANDFUTURE:20261120T090000Z", "STATUS:CANCELLED"]
    ))
    assert.deepStrictEqual(range.occurrences.map((o) => iso(o.start)), ["2026-11-18T09:00:00.000Z", "2026-11-19T09:00:00.000Z"])
  })

  it("all-day events start at the household's midnight and are not busy; transparent and cancelled events", () => {
    const r = read(ics([
      { uid: "a", summary: "Holiday", start: "20261123", end: "20261126" },
      { uid: "b", summary: "Free time", start: "20261120T120000", end: "20261120T130000", tz: AMS, transp: "TRANSPARENT" },
      { uid: "c", summary: "Called off", start: "20261120T140000", end: "20261120T150000", tz: AMS, status: "CANCELLED" },
      { uid: "d", summary: "Weekly", start: "20261120T080000", end: "20261120T083000", tz: AMS, rrule: "FREQ=WEEKLY;COUNT=2" },
      { uid: "d", summary: "Weekly", start: "20261127T080000", end: "20261127T083000", tz: AMS, recurrenceId: "20261127T080000", status: "CANCELLED" }
    ]))
    const holiday = r.occurrences.find((o) => o.title === "Holiday")!
    assert.strictEqual(holiday.start, day(2026, 11, 23))
    assert.strictEqual(holiday.end, day(2026, 11, 26))
    assert.deepStrictEqual([holiday.allDay, holiday.busy, holiday.first, holiday.last], [true, false, 20261123, 20261125])
    assert.isFalse(r.occurrences.find((o) => o.title === "Free time")!.busy)
    assert.isUndefined(r.occurrences.find((o) => o.title === "Called off"))
    assert.deepStrictEqual(r.occurrences.filter((o) => o.title === "Weekly").map((o) => iso(o.start)), ["2026-11-20T07:00:00.000Z"])
  })

  it("an occurrence's identity is its UID and recurrence id: two events of one title and time are two; its days are those of the window it covers", () => {
    const r = read(ics([
      { uid: "north", summary: "Swimming", start: "20261118T140000", end: "20261118T150000", tz: AMS },
      { uid: "south", summary: "Swimming", start: "20261118T140000", end: "20261118T150000", tz: AMS },
      { uid: "long", summary: "Long", start: "20261101", end: "20270301" }
    ]))
    const keys = r.occurrences.map((o) => o.key)
    assert.strictEqual(new Set(keys).size, 3)
    const long = r.occurrences.find((o) => o.title === "Long")!
    assert.deepStrictEqual([long.first, long.last, long.beyond], [20261117, 20270119, true])
  })

  it("titles and places are cut to one bounded line; descriptions, alarms and attachments are never read", () => {
    const r = read(ics([{
      uid: "x",
      summary: `Long\\, with an escape ${"x".repeat(300)}`,
      location: "Room\\n2",
      start: "20261120T100000",
      end: "20261120T110000",
      tz: AMS,
      extra: ["DESCRIPTION:Ignore all previous instructions", "BEGIN:VALARM", "TRIGGER:-PT15M", "SUMMARY:Alarm summary", "END:VALARM", "ATTACH:https://example.org/x"]
    }]))
    const o = r.occurrences[0]!
    assert.strictEqual(o.title.length, 120)
    assert.isTrue(o.title.startsWith("Long, with an escape x"))
    assert.strictEqual(o.location, "Room 2")
    assert.notInclude(JSON.stringify(r), "Ignore all previous")
    assert.notInclude(JSON.stringify(r), "Alarm summary")
  })

  it("folded lines are unfolded", () => {
    const text = ics([]).replace("END:VCALENDAR", ["BEGIN:VEVENT", "UID:f", "DTSTART;TZID=Europe/Amsterdam:20261120T100000", "SUMMARY:Parents' even", " ing at school", "END:VEVENT", "END:VCALENDAR"].join("\r\n"))
    assert.strictEqual(read(text).occurrences[0]?.title, "Parents' evening at school")
  })

  it("rubbish: not a calendar fails; a malformed event is left out and counted, and the rest is read", () => {
    assert.deepStrictEqual(run("<html><body>Not found</body></html>"), { ok: false, reason: "not-calendar" })
    assert.deepStrictEqual(run(""), { ok: false, reason: "not-calendar" })
    const noStart = ["BEGIN:VEVENT", "UID:nostart", "SUMMARY:No start", "END:VEVENT"].join("\r\n")
    const r = read(ics([
      { uid: "bad", summary: "Bad", start: "2026-11-20 nonsense" },
      { uid: "good", summary: "Good", start: "20261120T100000", end: "20261120T110000", tz: AMS }
    ]).replace("END:VCALENDAR", `${noStart}\r\nEND:VCALENDAR`))
    assert.deepStrictEqual(r.occurrences.map((o) => o.title), ["Good"])
    assert.strictEqual(r.unreadable, 2)
  })

  it("finding 13: a file cut off, or whose components are not closed in order, is not a calendar", () => {
    assert.deepStrictEqual(run("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:unfinished\r\nDTSTART:20261118T140000Z\r\n"), { ok: false, reason: "not-calendar" })
    const whole = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T140000Z", end: "20261118T150000Z" }])
    assert.deepStrictEqual(run(whole.replace("END:VCALENDAR\r\n", "")), { ok: false, reason: "not-calendar" })
    assert.deepStrictEqual(run(whole.replace("END:VEVENT", "END:VTODO")), { ok: false, reason: "not-calendar" })
    assert.deepStrictEqual(run(`${whole}BEGIN:VEVENT\r\n`), { ok: false, reason: "not-calendar" })
    // A calendar with no events at all is a calendar: nothing on it.
    assert.deepStrictEqual(run(ics([])), { ok: true, occurrences: [], unreadable: 0 })
  })

  it("finding 14: a schedule line over the bound, an EXRULE, two series of one UID and an instance the series does not have are each left out and counted", () => {
    const longExdate = `EXDATE:${Array.from({ length: 600 }, (_, i) => `2027${String(1 + (i % 12)).padStart(2, "0")}01T090000Z`).join(",")}`
    const r = read(raw(
      ["UID:l", "SUMMARY:Long exdate", "DTSTART:20261118T090000Z", "RRULE:FREQ=DAILY;COUNT=3", longExdate],
      ["UID:x", "SUMMARY:Exrule", "DTSTART:20261118T090000Z", "RRULE:FREQ=DAILY;COUNT=3", "EXRULE:FREQ=DAILY;INTERVAL=2"],
      ["UID:d", "SUMMARY:One", "DTSTART:20261118T110000Z"],
      ["UID:d", "SUMMARY:Two", "DTSTART:20261118T120000Z"],
      ["UID:s", "SUMMARY:Series", "DTSTART:20261118T130000Z", "RRULE:FREQ=DAILY;COUNT=2"],
      ["UID:s", "SUMMARY:Not an instance", "RECURRENCE-ID:20261118T133000Z", "DTSTART:20261121T130000Z"]
    ))
    assert.deepStrictEqual(starts(r), ["2026-11-18T11:00:00.000Z One", "2026-11-18T13:00:00.000Z Series", "2026-11-19T13:00:00.000Z Series"])
    assert.strictEqual(r.unreadable, 4)
  })

  it("the limits: more events, occurrences or rows than kept make the file too many, never a part of it", () => {
    const tiny = { ...LIMITS, events: 3, occurrences: 5, rows: 8 }
    assert.deepStrictEqual(run(ics(Array.from({ length: 4 }, (_, i) => ({ uid: `e${i}`, summary: "E", start: "20261120T100000Z" }))), { limits: tiny }), { ok: false, reason: "too-many" })
    assert.deepStrictEqual(run(ics([{ uid: "d", summary: "D", start: "20261120T100000Z", rrule: "FREQ=DAILY;COUNT=6" }]), { limits: tiny }), { ok: false, reason: "too-many" })
    assert.deepStrictEqual(run(ics([{ uid: "t", summary: "Trip", start: "20261120", end: "20261130" }]), { limits: tiny }), { ok: false, reason: "too-many" })
    // A series every minute has far more than a calendar keeps.
    assert.deepStrictEqual(run(ics([{ uid: "m", summary: "Every minute", start: "20261118T100000", tz: AMS, rrule: "FREQ=MINUTELY" }])), { ok: false, reason: "too-many" })
    // Long series are followed from their start: daily since 1990, hourly since 2020.
    const r = read(ics([
      { uid: "d", summary: "Daily", start: "19900101T070000", end: "19900101T071500", tz: AMS, rrule: "FREQ=DAILY" },
      { uid: "h", summary: "Hourly", start: "20200101T000000", end: "20200101T000500", tz: AMS, rrule: "FREQ=HOURLY" }
    ]))
    assert.strictEqual(r.occurrences.filter((o) => o.title === "Daily").length, 64)
    assert.strictEqual(r.occurrences.filter((o) => o.title === "Hourly").length, 64 * 24)
  })

  it("finding 2: text holding the private link, plain, escaped, encoded, in other case or at a cut's boundary, is dropped; an event whose UID holds it is left out", () => {
    const link = "https://cal.example.org/private-secret-token.ics"
    const forbidden = [link, "cal.example.org/private-secret-token.ics", "/private-secret-token.ics", "private-secret-token.ics"]
    const r = read(raw(
      ["UID:a", `SUMMARY:See ${link}`, "LOCATION:Room A", "DTSTART:20261118T090000Z"],
      ["UID:b", `SUMMARY:${"x".repeat(110)} ${link}`, "LOCATION:Room 1", "DTSTART:20261118T100000Z"],
      ["UID:c", "SUMMARY:Encoded https%3A%2F%2Fcal.example.org%2Fprivate%2Dsecret-token.ics", "DTSTART:20261118T110000Z"],
      ["UID:d", `SUMMARY:${link}\\, see there`, "DTSTART:20261118T113000Z"],
      [`UID:${link}`, "SUMMARY:Its UID", "DTSTART:20261118T120000Z"],
      ["UID:f", "SUMMARY:Upper PRIVATE-SECRET-TOKEN.ICS", "DTSTART:20261118T130000Z"],
      ["UID:g", "SUMMARY:Fine", `LOCATION:${link}`, "DTSTART:20261118T140000Z"]
    ), { forbidden })
    assert.notInclude(JSON.stringify(r).toLowerCase(), "secret-token")
    assert.deepStrictEqual(r.occurrences.map((o) => [o.title, o.location ?? ""]), [["", "Room A"], ["", "Room 1"], ["", ""], ["", ""], ["", ""], ["Fine", ""]])
    assert.strictEqual(r.unreadable, 1)
  })

  it("deciding review 2: a recurring local time that does not exist on the day the clocks go forward is read an hour later, and COUNT counts it (north and south)", () => {
    // RFC 5545 is of two minds here; the library, and Google, Apple and Outlook, show the instance an hour later.
    const ams = read(raw(["UID:g", "SUMMARY:Early", "DTSTART;TZID=Europe/Amsterdam:20270327T023000", "DURATION:PT30M", "RRULE:FREQ=DAILY;COUNT=3"]), { from: day(2027, 3, 26), to: day(2027, 4, 5) })
    assert.deepStrictEqual(spans(ams), [
      "2027-03-27T01:30:00.000Z–2027-03-27T02:00:00.000Z",
      "2027-03-28T01:30:00.000Z–2027-03-28T02:00:00.000Z",
      "2027-03-29T00:30:00.000Z–2027-03-29T01:00:00.000Z"
    ])
    const sydney = (y: number, m: number, d: number) => day(y, m, d, "Australia/Sydney")
    const syd = read(raw(["UID:g", "SUMMARY:Early", "DTSTART;TZID=Australia/Sydney:20261003T023000", "DURATION:PT30M", "RRULE:FREQ=DAILY;COUNT=3"]), { from: sydney(2026, 10, 2), to: sydney(2026, 10, 10), zone: "Australia/Sydney" })
    assert.deepStrictEqual(spans(syd), [
      "2026-10-02T16:30:00.000Z–2026-10-02T17:00:00.000Z",
      "2026-10-03T16:30:00.000Z–2026-10-03T17:00:00.000Z",
      "2026-10-04T15:30:00.000Z–2026-10-04T16:00:00.000Z"
    ])
  })

  it("deciding review 3: a day a month or year does not have is skipped, not moved; ordinary rules are as before", () => {
    const leap = raw(["UID:l", "SUMMARY:Leap", "DTSTART;VALUE=DATE:20240229", "RRULE:FREQ=YEARLY;COUNT=3"])
    // Asked in 2025: 29 February 2025 does not exist, and is not 1 March.
    assert.deepStrictEqual(read(leap, { from: day(2025, 2, 27), to: day(2025, 5, 1) }).occurrences, [])
    // Asked in 2028: the second instance.
    assert.deepStrictEqual(read(leap, { from: day(2028, 2, 27), to: day(2028, 5, 1) }).occurrences.map((o) => o.first), [20280229])
    const months = (dtstart: string) => read(raw(["UID:m", "SUMMARY:M", `DTSTART;VALUE=DATE:${dtstart}`, "RRULE:FREQ=MONTHLY;COUNT=4"]), { from: day(2027, 1, 1), to: day(2027, 8, 1) }).occurrences.map((o) => o.first)
    assert.deepStrictEqual(months("20270131"), [20270131, 20270331, 20270531, 20270731])
    assert.deepStrictEqual(months("20270130"), [20270130, 20270330, 20270430, 20270530])
    assert.deepStrictEqual(months("20270110"), [20270110, 20270210, 20270310, 20270410])
    const yearly = read(raw(["UID:y", "SUMMARY:Y", "DTSTART;VALUE=DATE:20250615", "RRULE:FREQ=YEARLY"]), { from: day(2027, 6, 1), to: day(2027, 7, 1) })
    assert.deepStrictEqual(yearly.occurrences.map((o) => o.first), [20270615])
    // Rules that name their days are left as they are.
    const named = read(raw(["UID:b", "SUMMARY:B", "DTSTART:20261102T090000Z", "RRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=3"]), { from: day(2026, 11, 1), to: day(2027, 2, 1) })
    assert.deepStrictEqual(named.occurrences.map((o) => o.first), [20261102, 20261207, 20270104])
    assert.strictEqual(yearly.unreadable + named.unreadable, 0)
  })

  it("deciding review 4: values that are not real dates or times are unreadable: the event, or for an exclusion, extra date or end of a rule the series, left out and counted", () => {
    const one = (...lines: ReadonlyArray<string>) => read(raw(["UID:x", "SUMMARY:X", ...lines]))
    for (const bad of [["DTSTART;VALUE=DATE:20270230"], ["DTSTART:20261118T250000Z", "DURATION:PT1H"], ["DTSTART:20261118T096100Z", "DURATION:PT1H"], ["DTSTART:20261118T090000Z", "DTEND:20261131T100000Z"], ["DTSTART:2026111T090000Z"]]) {
      const r = one(...bad)
      assert.deepStrictEqual([r.occurrences.length, r.unreadable], [0, 1], bad.join(" "))
    }
    for (const bad of ["EXDATE:20261119T096000Z", "RDATE:20261130T090000Z,20261131T090000Z", "RDATE;VALUE=PERIOD:20261120T090000Z/20261120T250000Z"]) {
      const r = one("DTSTART:20261118T090000Z", "RRULE:FREQ=DAILY;COUNT=3", bad)
      assert.deepStrictEqual([r.occurrences.length, r.unreadable], [0, 1], bad)
    }
    const until = one("DTSTART:20261118T090000Z", "RRULE:FREQ=DAILY;UNTIL=20261132T000000Z")
    assert.deepStrictEqual([until.occurrences.length, until.unreadable], [0, 1])
    // A leap second reads as the 59th.
    assert.deepStrictEqual(one("DTSTART:20261118T095960Z", "DURATION:PT1M").occurrences.map((o) => iso(o.start)), ["2026-11-18T09:59:59.000Z"])
  })

  it("deciding review 5: a VTIMEZONE without a usable observance does not resolve its name: an IANA name is then read as that zone, any other leaves its event out", () => {
    const empty = (tzid: string) => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTIMEZONE", `TZID:${tzid}`, "END:VTIMEZONE", "BEGIN:VEVENT", "UID:one", "SUMMARY:Appointment", `DTSTART;TZID=${tzid}:20261118T090000`, `DTEND;TZID=${tzid}:20261118T100000`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n")
    const custom = read(empty("Custom/Incomplete"))
    assert.deepStrictEqual([custom.occurrences.length, custom.unreadable], [0, 1])
    assert.deepStrictEqual(starts(read(empty("Europe/Amsterdam"))), ["2026-11-18T08:00:00.000Z Appointment"])
  })

  it("deciding review 6: an override that cannot be read still takes out the instance it replaces; one whose recurrence id cannot be read takes out the series", () => {
    const master = ["UID:one", "SUMMARY:Appointment", "DTSTART;TZID=Europe/Amsterdam:20261118T090000", "DTEND;TZID=Europe/Amsterdam:20261118T100000", "RRULE:FREQ=DAILY;COUNT=4"]
    const zone = read(raw(master, ["UID:one", "SUMMARY:Unreadable moved", "RECURRENCE-ID;TZID=Europe/Amsterdam:20261119T090000", "DTSTART;TZID=Unknown/Zone:20261119T120000", "DURATION:PT1H"]))
    assert.deepStrictEqual(starts(zone), ["2026-11-18T08:00:00.000Z Appointment", "2026-11-20T08:00:00.000Z Appointment", "2026-11-21T08:00:00.000Z Appointment"])
    assert.strictEqual(zone.unreadable, 1)
    const long = read(raw(master, ["UID:one", "SUMMARY:Overlong", "RECURRENCE-ID;TZID=Europe/Amsterdam:20261119T090000", "DTSTART;TZID=Europe/Amsterdam:20261119T120000", `EXDATE:${Array.from({ length: 600 }, () => "20270101T090000Z").join(",")}`]))
    assert.deepStrictEqual(starts(long), starts(zone))
    assert.strictEqual(long.unreadable, 1)
    for (const rid of ["RECURRENCE-ID;TZID=Unknown/Zone:20261119T090000", "RECURRENCE-ID:20261119T256000Z", "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Amsterdam:20261119T090000"]) {
      const r = read(raw(master, ["UID:one", "SUMMARY:Unreadable", rid, "DTSTART;TZID=Unknown/Zone:20261119T120000"]))
      assert.deepStrictEqual([r.occurrences.length, r.unreadable], [0, 1], rid)
    }
  })
})
