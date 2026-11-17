// The recurrence engine against an independent brute-force reference (review round 2, decision 2; made independent in round 3,
// finding 25). The reference shares nothing with the engine: it walks every local day with JavaScript's Date (support/Zone.ts),
// decides membership from the README's definitions, converts each instance with the tests' own Intl-based zone lookup (every offset
// seen near it tried and checked against the wall clock Intl formats), counts COUNT over distinct instants, and stops at the end of
// the supported years. The engine jumps to the period of `after` by arithmetic. They must agree, with no instant twice and none out
// of order, and with the same reason for stopping.
import { describe, expect, it } from "@effect/vitest"
import { describeRRule, formatRRule, occurrencesAfter, parseRRule, readSeries, seriesAfter, type RecurrenceRule, type RecurrenceSpec } from "../src/Rrule.ts"
import { speakTime } from "../src/Speak.ts"
import { recognise, stable, type Grammar } from "./support/Cfg.ts"
import { ordinalRules } from "./grammars/dates.ts"
import { number } from "./grammars/numbers.ts"
import { rng } from "./support/Rng.ts"
import { daysIn, instantsOf, plusDays, utcOfDay, wallOf, weekdayOf, type Day } from "./support/Zone.ts"

const DAY = 86_400_000
const codes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const
const lastDay: Day = { year: 2199, month: 12, day: 31 }

interface Case {
  readonly rule: RecurrenceRule
  readonly start: Day & { readonly hour: number; readonly minute: number; readonly second: number }
  readonly zone: string
}

const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const monthLength = (y: number, m: number) => (m === 2 ? (leap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31)

/** Whether day `x` (its UTC midnight `t` and weekday `wd`) is an instance day of the case, by the README's definitions. */
const memberAt = (c: Case, x: Day, t: number, wd: number): boolean => {
  const { rule, start: s } = c
  const startT = utcOfDay(s)
  if (t < startT) return false
  const I = rule.interval
  switch (rule.freq) {
    case "DAILY": return Math.round((t - startT) / DAY) % I === 0
    case "WEEKLY": {
      const weeks = Math.round(((t - (wd - 1) * DAY) - (startT - (weekdayOf(s) - 1) * DAY)) / (7 * DAY))
      if (weeks % I !== 0) return false
      const days = rule.byDay.length > 0 ? rule.byDay.map((d) => codes.indexOf(d.weekday) + 1) : [weekdayOf(s)]
      return days.includes(wd)
    }
    case "MONTHLY": {
      if (((x.year - s.year) * 12 + x.month - s.month) % I !== 0) return false
      if (rule.byDay.length === 1) {
        const { weekday, nth } = rule.byDay[0]!
        if (wd !== codes.indexOf(weekday) + 1) return false
        return nth! > 0 ? Math.ceil(x.day / 7) === nth : monthLength(x.year, x.month) - x.day < 7
      }
      if (rule.byMonthDay.length > 0) return rule.byMonthDay.some((v) => (v === -1 ? x.day === monthLength(x.year, x.month) : x.day === v))
      return x.day === s.day
    }
    case "YEARLY":
      return (x.year - s.year) % I === 0 && x.month === (rule.byMonth[0] ?? s.month) && x.day === (rule.byMonthDay[0] ?? s.day)
  }
}
const member = (c: Case, x: Day): boolean => memberAt(c, x, utcOfDay(x), weekdayOf(x))

const untilMs = (u: string): number => Date.UTC(Number(u.slice(0, 4)), Number(u.slice(4, 6)) - 1, Number(u.slice(6, 8)), Number(u.slice(9, 11)), Number(u.slice(11, 13)), Number(u.slice(13, 15)))

/** Up to `n` instances strictly after `after`, walking every day from DTSTART (or two days before `after`) to 31 December 2199, and why it stopped. */
const reference = (c: Case, after: number, n: number): { instants: Array<number>; stop: "limit" | "series" | "range" } => {
  const until = c.rule.until === undefined ? Infinity : untilMs(c.rule.until)
  const startT = utcOfDay(c.start)
  // Without COUNT, days long before `after` cannot matter: start two days before its local day (membership is still from DTSTART).
  const afterT = after === -Infinity || after < startT ? startT : utcOfDay(wallOf(after, c.zone)) - 2 * DAY
  let t = c.rule.count !== undefined ? startT : Math.max(startT, afterT)
  const first = new Date(t)
  const x = { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: first.getUTCDate() }
  let wd = weekdayOf(x)
  const out: Array<number> = []
  const seen = new Set<number>()
  let counted = 0
  const end = utcOfDay(lastDay)
  for (; t <= end; t += DAY) {
    if (memberAt(c, x, t, wd)) {
      const instant = instantsOf({ ...x, hour: c.start.hour, minute: c.start.minute, second: c.start.second }, c.zone)[0]!
      if (instant > until) return { instants: out, stop: "series" }
      if (!seen.has(instant)) {
        seen.add(instant)
        counted++
        if (instant > after) out.push(instant)
        if (out.length >= n) return { instants: out, stop: "limit" }
        // The COUNT-th instance is the series' last.
        if (c.rule.count !== undefined && counted === c.rule.count) return { instants: out, stop: "series" }
      }
    }
    // The next day, by hand.
    wd = wd === 7 ? 1 : wd + 1
    if (x.day < monthLength(x.year, x.month)) x.day++
    else if (x.month < 12) { x.day = 1; x.month++ } else { x.day = 1; x.month = 1; x.year++ }
  }
  // The supported years are over. The series goes on past them (`range`) exactly when it has an instance after 31 December 2199:
  // with COUNT, it has (the COUNT-th has not come); with UNTIL, when a local day of 2200 is an instance at or before UNTIL (an UNTIL is
  // at most 2199-12-31T23:59:59Z, so only the first two local days of 2200 can be, in zones far east); without either, always
  // (every supported rule has instances in every 400 years). Review round 4, finding 4: the reference no longer says `range` at its
  // endpoint unconditionally.
  if (c.rule.until !== undefined) {
    for (const day of [{ year: 2200, month: 1, day: 1 }, { year: 2200, month: 1, day: 2 }]) {
      if (!member(c, day)) continue
      const instant = instantsOf({ ...day, hour: c.start.hour, minute: c.start.minute, second: c.start.second }, c.zone)[0]!
      if (instant <= until) return { instants: out, stop: "range" }
    }
    return { instants: out, stop: "series" }
  }
  return { instants: out, stop: "range" }
}

// ---- the matrix -----------------------------------------------------------------------------------------------------------------

const pad = (v: number, w = 2) => String(v).padStart(w, "0")
const specOf = (c: Case): RecurrenceSpec => ({
  rrule: formatRRule(c.rule)!,
  dtstart: `DTSTART;TZID=${c.zone}:${pad(c.start.year, 4)}${pad(c.start.month)}${pad(c.start.day)}T${pad(c.start.hour)}${pad(c.start.minute)}${pad(c.start.second)}`,
  timeZone: c.zone
})

/** Per zone: month ends, 29 February, its daylight-saving days, a skipped day (Apia, 30 December 2011), and both ends of the range. */
const zoneDays: Record<string, ReadonlyArray<Day>> = {
  "Europe/Amsterdam": [{ year: 2024, month: 1, day: 31 }, { year: 2028, month: 2, day: 29 }, { year: 2026, month: 3, day: 29 }, { year: 2026, month: 10, day: 25 }, { year: 2026, month: 11, day: 18 }, { year: 2000, month: 1, day: 1 }],
  "Australia/Sydney": [{ year: 2026, month: 4, day: 5 }, { year: 2026, month: 10, day: 4 }, { year: 2025, month: 4, day: 30 }, { year: 2026, month: 12, day: 31 }],
  "Pacific/Apia": [{ year: 2011, month: 12, day: 28 }, { year: 2011, month: 12, day: 29 }, { year: 2011, month: 12, day: 31 }],
  "America/New_York": [{ year: 2026, month: 3, day: 8 }, { year: 2026, month: 11, day: 1 }],
  "Australia/Lord_Howe": [{ year: 2026, month: 4, day: 5 }, { year: 2026, month: 10, day: 4 }],
  UTC: [{ year: 2199, month: 12, day: 27 }, { year: 2199, month: 11, day: 30 }, { year: 2000, month: 2, day: 29 }]
}
const times: ReadonlyArray<readonly [number, number, number]> = [[2, 30, 0], [0, 0, 0], [9, 0, 30], [1, 45, 0]]

const rulesFor = (s: Day, interval: number): Array<RecurrenceRule> => {
  const wd = weekdayOf(s)
  const code = (n: number) => codes[(n - 1 + 70) % 7]!
  const base = { interval, byDay: [], byMonthDay: [], byMonth: [] }
  const sortDays = (ds: Array<{ weekday: (typeof codes)[number] }>) => ds.sort((a, b) => codes.indexOf(a.weekday) - codes.indexOf(b.weekday))
  const out: Array<RecurrenceRule> = [
    { ...base, freq: "DAILY" },
    { ...base, freq: "WEEKLY" },
    { ...base, freq: "WEEKLY", byDay: [{ weekday: code(wd) }] },
    { ...base, freq: "WEEKLY", byDay: sortDays([wd, wd + 2, wd + 4].map((d) => ({ weekday: code(d) }))) },
    { ...base, freq: "WEEKLY", byDay: (wd <= 5 ? [1, 2, 3, 4, 5] : [6, 7]).map((d) => ({ weekday: code(d) })) },
    { ...base, freq: "MONTHLY" },
    { ...base, freq: "MONTHLY", byMonthDay: [s.day] },
    { ...base, freq: "MONTHLY", byMonthDay: [...new Set([s.day === 1 ? 2 : 1, s.day, s.day === 30 ? 29 : 30])].sort((a, b) => a - b) },
    { ...base, freq: "MONTHLY", byDay: [{ weekday: code(wd), nth: Math.ceil(s.day / 7) }] },
    { ...base, freq: "YEARLY" },
    { ...base, freq: "YEARLY", byMonth: [s.month] },
    { ...base, freq: "YEARLY", byMonth: [s.month], byMonthDay: [s.day] }
  ]
  if (s.day === daysIn(s.year, s.month)) out.push({ ...base, freq: "MONTHLY", byMonthDay: [-1] }, { ...base, freq: "MONTHLY", byMonthDay: [1, -1] })
  if (daysIn(s.year, s.month) - s.day < 7) out.push({ ...base, freq: "MONTHLY", byDay: [{ weekday: code(wd), nth: -1 }] })
  return out
}

const cases: Array<Case> = []
{
  const r = rng(201)
  for (const [zone, days] of Object.entries(zoneDays)) for (const s of days) for (const [hour, minute, second] of times) for (const interval of [1, 2, 3, 4, 7, 12, 13, 99, 100, 400, 999]) {
    // The large intervals on a fifth of the rules (they walk far), every rule with the small ones.
    rulesFor(s, interval).forEach((rule0, k) => {
      if (interval > 4 && !r.chance(interval > 100 ? 0.03 : 0.1)) return
      if (interval <= 4 && hour === 1 && !r.chance(0.5)) return
      const end = (k + interval + hour) % 3
      // A third unbounded; the others end by COUNT, or by UNTIL — at DTSTART, on a later daylight-saving day, or about three years on.
      const until = (() => {
        const choice = r.int(0, 2)
        if (choice === 0 && untilAt(s, hour, minute, second, zone) >= "2000") return untilAt(s, hour, minute, second, zone)
        const later = choice === 1 ? { year: s.year + 1, month: s.month, day: Math.min(s.day, 28) } : { year: s.year + 3, month: s.month, day: Math.min(s.day, 28) }
        const text = `${pad(Math.min(later.year, 2199), 4)}${pad(later.month)}${pad(later.day)}T${pad(hour)}${pad(minute)}${pad(second)}Z`
        // Near the end of the range "a year on" can fall before DTSTART: then UNTIL is DTSTART itself.
        return text < untilAt(s, hour, minute, second, zone) ? untilAt(s, hour, minute, second, zone) : text
      })()
      const rule: RecurrenceRule = end === 0 ? rule0 : end === 1 ? { ...rule0, count: r.pick([1, 3, 5 + interval % 7, 13]) } : { ...rule0, until }
      cases.push({ rule, start: { ...s, hour, minute, second }, zone })
    })
  }
}
/** UNTIL exactly at DTSTART's instant. */
function untilAt(s: Day, hour: number, minute: number, second: number, zone: string): string {
  const i = instantsOf({ ...s, hour, minute, second }, zone)[0]!
  const d = new Date(i)
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

const iso = (t: number) => new Date(t).toISOString()

describe("the recurrence engine against a brute-force reference", () => {
  it(`agrees on ${cases.length} rules over many instants, with the same reason for stopping`, () => {
    const mismatches: Array<string> = []
    let compared = 0
    const r = rng(202)
    for (const c of cases) {
      const spec = specOf(c)
      const read = readSeries(spec)
      if (read.kind !== "ok") { mismatches.push(`${spec.rrule} ${spec.dtstart}: ${read.reason}`); continue }
      // parse → format → parse gives the generated rule back (finding 25: compared with the original, not with another parse).
      if (stable(parseRRule(formatRRule(c.rule)!)) !== stable({ kind: "ok", rule: c.rule })) mismatches.push(`${spec.rrule}: parse ∘ format is not the identity`)
      const first = reference(c, -Infinity, 4)
      const afters = [utcOfDay(c.start) - 30 * DAY, ...first.instants.slice(0, 3).flatMap((t) => [t - 1, t])]
      for (let k = 0; k < 2; k++) afters.push(utcOfDay(c.start) + r.int(0, 4 * 365) * DAY + r.int(0, DAY))
      if (c.rule.count === undefined && c.rule.until === undefined && r.chance(0.1)) afters.push(Date.UTC(2150, 5, 1), Date.UTC(2199, 11, 31, 12), Date.UTC(2300, 0, 1))
      for (const after of afters) {
        const want = reference(c, after, 3)
        const got = occurrencesAfter(spec, after, 3)!
        compared++
        const ordered = got.instants.every((t, k) => k === 0 || t > got.instants[k - 1]!)
        if (!ordered || JSON.stringify(got.instants) !== JSON.stringify(want.instants) || got.stop !== want.stop) {
          mismatches.push(`${spec.rrule} ${spec.dtstart} after ${iso(after)}: got ${got.instants.map(iso)} (${got.stop}) want ${want.instants.map(iso)} (${want.stop})`)
        }
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
    expect(compared).toBeGreaterThan(20_000)
  }, 120_000)

  it("fixed instants computed by hand: the spring gap, the autumn fold, Apia's skipped day, the end of the range", () => {
    const at = (rrule: string, dtstart: string, timeZone: string, after: number, n: number) => occurrencesAfter({ rrule, dtstart, timeZone }, after, n)!
    // Amsterdam, 29 March 2026: 02:30 does not exist; the offset before the gap (+01:00) makes it 01:30 UTC.
    expect(at("FREQ=DAILY", "DTSTART;TZID=Europe/Amsterdam:20260328T023000", "Europe/Amsterdam", 0, 3).instants.map(iso)).toEqual(["2026-03-28T01:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"])
    // Amsterdam, 25 October 2026: 02:30 happens twice; the first (+02:00) is 00:30 UTC.
    expect(at("FREQ=DAILY", "DTSTART;TZID=Europe/Amsterdam:20261024T023000", "Europe/Amsterdam", 0, 3).instants.map(iso)).toEqual(["2026-10-24T00:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"])
    // Apia skipped 30 December 2011: COUNT=4 is four distinct instants (finding 6).
    expect(at("FREQ=DAILY;COUNT=4", "DTSTART;TZID=Pacific/Apia:20111228T090000", "Pacific/Apia", Date.UTC(2011, 11, 27), 10)).toEqual({
      instants: ["2011-12-28T19:00:00.000Z", "2011-12-29T19:00:00.000Z", "2011-12-30T19:00:00.000Z", "2011-12-31T19:00:00.000Z"].map(Date.parse), stop: "series"
    })
    // The last week of 2199 (finding 15): nothing in 2200, and the stop says the range ended.
    expect(at("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU", "DTSTART;TZID=UTC:21991227T090000", "UTC", Date.UTC(2199, 11, 27, 10), 10)).toEqual({
      instants: [28, 29, 30, 31].map((d) => Date.UTC(2199, 11, d, 9)), stop: "range"
    })
  })

  it("why it stopped, fixed by hand (round 4, finding 4): a finished series is `series`, also at the end of the range", () => {
    const at = (rrule: string, dtstart: string, timeZone: string, after: number, n: number) => occurrencesAfter({ rrule, dtstart, timeZone }, after, n)!
    const last = Date.UTC(2199, 11, 31, 9)
    // COUNT=1 and UNTIL at the last day of the range: the series is over, not cut off.
    expect(at("FREQ=DAILY;COUNT=1", "DTSTART;TZID=UTC:21991231T090000", "UTC", Date.UTC(2199, 11, 30), 10)).toEqual({ instants: [last], stop: "series" })
    expect(at("FREQ=DAILY;UNTIL=21991231T090000Z", "DTSTART;TZID=UTC:21991231T090000", "UTC", Date.UTC(2199, 11, 30), 10)).toEqual({ instants: [last], stop: "series" })
    expect(at("FREQ=DAILY;COUNT=1", "DTSTART;TZID=UTC:21991231T090000", "UTC", Date.UTC(2200, 0, 1), 10)).toEqual({ instants: [], stop: "series" })
    expect(at("FREQ=DAILY;UNTIL=21991231T090000Z", "DTSTART;TZID=UTC:21991231T090000", "UTC", Date.UTC(2200, 0, 1), 10)).toEqual({ instants: [], stop: "series" })
    // An interval that never comes back within the range, with COUNT=1: the series ended with its only instance.
    expect(at("FREQ=YEARLY;INTERVAL=999;COUNT=1", "DTSTART;TZID=UTC:20261118T090000", "UTC", Date.UTC(2026, 10, 17), 10)).toEqual({ instants: [Date.UTC(2026, 10, 18, 9)], stop: "series" })
    // The limit comes first: as many as asked for, also when that was the last one.
    expect(at("FREQ=DAILY;COUNT=2", "DTSTART;TZID=UTC:20261118T090000", "UTC", 0, 2).stop).toBe("limit")
    expect(at("FREQ=DAILY;COUNT=2", "DTSTART;TZID=UTC:20261118T090000", "UTC", 0, 3).stop).toBe("series")
    // Cut off by the range: COUNT not reached, no UNTIL, or an UNTIL that a day of 2200 is still before (Kiritimati is UTC+14: 2200-01-01
    // 05:00 there is 2199-12-31T15:00Z).
    expect(at("FREQ=DAILY;COUNT=5", "DTSTART;TZID=UTC:21991230T090000", "UTC", 0, 10)).toEqual({ instants: [Date.UTC(2199, 11, 30, 9), last], stop: "range" })
    expect(at("FREQ=DAILY", "DTSTART;TZID=UTC:21991230T090000", "UTC", 0, 10).stop).toBe("range")
    expect(at("FREQ=DAILY;UNTIL=21991231T160000Z", "DTSTART;TZID=Pacific/Kiritimati:21991230T050000", "Pacific/Kiritimati", 0, 10)).toEqual({
      instants: [Date.UTC(2199, 11, 29, 15), Date.UTC(2199, 11, 30, 15)], stop: "range"
    })
    expect(at("FREQ=DAILY;UNTIL=21991231T140000Z", "DTSTART;TZID=Pacific/Kiritimati:21991230T050000", "Pacific/Kiritimati", 0, 10).stop).toBe("series")
  })

  it("UNTIL before DTSTART is invalid; UNTIL at DTSTART leaves exactly DTSTART (finding 16)", () => {
    expect(readSeries({ rrule: "FREQ=DAILY;UNTIL=20261117T090000Z", dtstart: "DTSTART;TZID=UTC:20261118T090000", timeZone: "UTC" }).kind).toBe("invalid")
    expect(readSeries({ rrule: "FREQ=DAILY;UNTIL=20261118T085959Z", dtstart: "DTSTART;TZID=UTC:20261118T090000", timeZone: "UTC" }).kind).toBe("invalid")
    expect(occurrencesAfter({ rrule: "FREQ=DAILY;UNTIL=20261118T090000Z", dtstart: "DTSTART;TZID=UTC:20261118T090000", timeZone: "UTC" }, 0, 5)).toEqual({ instants: [Date.UTC(2026, 10, 18, 9)], stop: "series" })
    let checked = 0
    for (const c of cases.filter((x) => x.rule.until !== undefined)) {
      const startInstant = instantsOf(c.start, c.zone)[0]!
      const early = new Date(startInstant - 1000)
      const until = `${pad(early.getUTCFullYear(), 4)}${pad(early.getUTCMonth() + 1)}${pad(early.getUTCDate())}T${pad(early.getUTCHours())}${pad(early.getUTCMinutes())}${pad(early.getUTCSeconds())}Z`
      if (Number(until.slice(0, 4)) < 2000) continue
      expect(readSeries(specOf({ ...c, rule: { ...c.rule, until } })).kind).toBe("invalid")
      expect(seriesAfter({ rule: { ...c.rule, until }, start: c.start, timeZone: c.zone }, 0, 2)).toBeUndefined()
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  })

  it("seriesAfter accepts exactly the series readSeries accepts (round 4, finding 3)", () => {
    const rule: RecurrenceRule = { freq: "WEEKLY", interval: 1, byDay: [{ weekday: "TU" }], byMonthDay: [], byMonth: [] }
    // The reviewer's: DTSTART is Monday 16 November, the rule Tuesdays.
    expect(seriesAfter({ rule, start: { year: 2026, month: 11, day: 16, hour: 9, minute: 0, second: 0 }, timeZone: "UTC" }, 0, 2)).toBeUndefined()
    // No clock time: not a DTSTART readSeries reads.
    expect(seriesAfter({ rule, start: { year: 2026, month: 11, day: 17, second: 0 } as never, timeZone: "UTC" }, 0, 2)).toBeUndefined()
    // A zone that is not one.
    expect(seriesAfter({ rule, start: { year: 2026, month: 11, day: 17, hour: 9, minute: 0, second: 0 }, timeZone: "Mars/Olympus" }, 0, 2)).toBeUndefined()
    // The accepted one, made by hand, expands as readSeries' own does.
    const byHand = seriesAfter({ rule, start: { year: 2026, month: 11, day: 17, hour: 9, minute: 0, second: 0 }, timeZone: "UTC" }, 0, 2)
    const read = readSeries({ rrule: "FREQ=WEEKLY;BYDAY=TU", dtstart: "DTSTART;TZID=UTC:20261117T090000", timeZone: "UTC" })
    expect(read.kind).toBe("ok")
    expect(byHand).toEqual(read.kind === "ok" ? seriesAfter(read.series, 0, 2) : undefined)
    expect(byHand).toEqual({ instants: [Date.UTC(2026, 10, 17, 9), Date.UTC(2026, 10, 24, 9)], stop: "limit" })
    // An after that is NaN, a limit out of range: undefined, as occurrencesAfter.
    expect(seriesAfter({ rule, start: { year: 2026, month: 11, day: 17, hour: 9, minute: 0, second: 0 }, timeZone: "UTC" }, Number.NaN, 2)).toBeUndefined()
    expect(occurrencesAfter({ rrule: "FREQ=WEEKLY;BYDAY=TU", dtstart: "DTSTART;TZID=UTC:20261117T090000", timeZone: "UTC" }, 0, 0)).toBeUndefined()
  })

  it("a DTSTART that is not an instance of its rule is invalid, as the reference says", () => {
    let checked = 0
    for (const c of cases.filter((_, k) => k % 7 === 0)) {
      const wd = weekdayOf(c.start)
      const wrong: RecurrenceRule = c.rule.freq === "WEEKLY" ? { ...c.rule, byDay: [{ weekday: codes[wd % 7]! }] }
        : c.rule.freq === "MONTHLY" ? { ...c.rule, byDay: [], byMonthDay: [c.start.day === 14 ? 13 : 14] }
        : c.rule.freq === "YEARLY" ? { ...c.rule, byMonth: [c.start.month === 6 ? 7 : 6], byMonthDay: [10] } : c.rule
      if (wrong === c.rule) continue
      expect(member({ ...c, rule: wrong }, c.start)).toBe(false)
      expect(readSeries(specOf({ ...c, rule: wrong })).kind).toBe("invalid")
      // The same series made by hand is refused by seriesAfter too: one front door (round 4, finding 3).
      expect(seriesAfter({ rule: wrong, start: c.start, timeZone: c.zone }, 0, 2)).toBeUndefined()
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  })

  it("describeRRule states every constraint of the rule, read by the test's own word tables (round 4, decision 2 and finding 1)", () => {
    // Descriptions are for speaking: not promised to read back. Each word table here is the test's own (the README's words).
    const tables = {
      en: {
        weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
        months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
        unit: { DAILY: /\bdays?\b/, WEEKLY: /\b(weeks?|weekdays?|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/, MONTHLY: /\bmonths?\b/, YEARLY: /\byears?\b/ },
        other: /\b(other|second)\b/, last: "last", lastDay: "last day", from: "from", at: "at", workweek: "every weekday", weekend: "every weekend"
      },
      nl: {
        weekdays: ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"],
        months: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"],
        unit: { DAILY: /\b(dag|dagen)\b/, WEEKLY: /\b(week|weken|werkdag|weekend|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b/, MONTHLY: /\b(maand|maanden)\b/, YEARLY: /\bjaar\b/ },
        other: /\b(om de|tweede|twee)\b/, last: "laatste", lastDay: "laatste dag", from: "vanaf", at: "om", workweek: "elke werkdag", weekend: "elk weekend"
      }
    } as const
    const ordinalGrammar = { en: { ORD: ordinalRules("en") }, nl: { ORD: ordinalRules("nl") } }
    const numberGrammar = { en: { N: [{ rhs: [number("en", { min: 0, max: 9999, whole: true })] }] }, nl: { N: [{ rhs: [number("nl", { min: 0, max: 9999, whole: true })] }] } }
    /** Every value a span of one to three words reads as, by a grammar of the test's. */
    const said = (g: Grammar, start: string, text: string): Set<number> => {
      const ws = text.replace(/[,]/g, "").split(" ")
      const out = new Set<number>()
      for (let a = 0; a < ws.length; a++) for (let b = a + 1; b <= Math.min(ws.length, a + 3); b++) for (const v of recognise(g, start, ws.slice(a, b))) out.add(v as number)
      return out
    }
    const problems: Array<string> = []
    let checked = 0
    for (const [k, c] of cases.entries()) {
      if (k % 2 === 1 && c.rule.interval === 1) continue
      const language = (k >> 1) % 2 === 0 ? "en" : "nl"
      const t = tables[language]
      const spec = specOf(c)
      const start = { year: c.start.year, month: c.start.month, day: c.start.day }
      const time = { hour: c.start.hour, minute: c.start.minute }
      const text = describeRRule(c.rule, language, { time, start, timeZone: c.zone })
      if (text === undefined) { problems.push(`${spec.rrule}: no description`); continue }
      const fail = (what: string) => problems.push(`${language} ${spec.rrule} ${spec.dtstart}: "${text}" does not say ${what}`)
      const lower = text.toLowerCase()
      const { rule } = c
      const ordinals = said(ordinalGrammar[language], "ORD", lower)
      const numbers = said(numberGrammar[language], "N", lower)
      if (!t.unit[rule.freq].test(lower)) fail("its frequency")
      // The interval, and with it its phase: the series' first day (finding 1).
      const n = rule.interval
      if (n === 2 && !t.other.test(lower) && !numbers.has(2) && !ordinals.has(2)) fail("every other")
      if (n > 2 && !numbers.has(n) && !ordinals.has(n)) fail(`the interval ${n}`)
      const phase = `, ${t.from} ${start.day} ${(t.months[start.month - 1] as string).toLowerCase()} ${start.year}`
      if (n > 1 && !lower.includes(phase)) fail(`its phase${phase}`)
      if (n === 1 && lower.includes(`, ${t.from} `)) fail("no phase (interval 1 has none)")
      // The days: weekdays, days of the month, the ordinal weekday, the month.
      const wd = (code: string) => t.weekdays[codes.indexOf(code as (typeof codes)[number])]!
      if (rule.freq === "WEEKLY") {
        const days = rule.byDay.length > 0 ? rule.byDay.map((d) => d.weekday) : [codes[weekdayOf(start) - 1]!]
        const group = n === 1 && (days.join() === "MO,TU,WE,TH,FR" ? lower.startsWith(t.workweek) : days.join() === "SA,SU" ? lower.startsWith(t.weekend) : false)
        if (!group) for (const d of days) if (!lower.includes(wd(d))) fail(wd(d))
        const others = t.weekdays.filter((name, i) => !days.includes(codes[i]!) && lower.includes(name))
        if (others.length > 0) fail(`no other weekday (${others.join()})`)
      }
      if (rule.freq === "MONTHLY") {
        if (rule.byDay.length === 1) {
          const { weekday, nth } = rule.byDay[0]!
          if (!lower.includes(wd(weekday))) fail(wd(weekday))
          if (nth === -1 ? !lower.includes(`${t.last} ${wd(weekday)}`) : !ordinals.has(nth!)) fail(`the ordinal ${nth}`)
        } else {
          for (const d of rule.byMonthDay.length > 0 ? rule.byMonthDay : [start.day]) if (d === -1 ? !lower.includes(t.lastDay) : !ordinals.has(d)) fail(`the day ${d}`)
        }
      }
      if (rule.freq === "YEARLY") {
        const month = rule.byMonth[0] ?? start.month
        const day = rule.byMonthDay[0] ?? start.day
        if (!lower.includes((t.months[month - 1] as string).toLowerCase())) fail(`the month ${month}`)
        if (!(language === "en" ? ordinals : numbers).has(day)) fail(`the day ${day}`)
      }
      // The time, as speakTime says it (its own round trip is proved), midnight as 00:00.
      const clock = time.hour === 0 && time.minute === 0 ? "00:00" : speakTime(time, language, { period: true })!
      if (!text.includes(` ${t.at} ${clock}`)) fail(`the time ${clock}`)
      // COUNT and UNTIL, against the test's own rendering.
      if (rule.count !== undefined) {
        const suffix = language === "en" ? `, ${rule.count} ${rule.count === 1 ? "time" : "times"}` : `, ${rule.count} keer`
        if (!text.endsWith(suffix)) fail(suffix)
      }
      if (rule.until !== undefined) {
        const w = wallOf(untilMs(rule.until), c.zone)
        const clockU = `${pad(w.hour)}:${pad(w.minute)}${w.second === 0 ? "" : `:${pad(w.second)}`}`
        const suffix = language === "en" ? `, until ${w.day} ${t.months[w.month - 1]} ${w.year} at ${clockU}` : `, tot ${w.day} ${t.months[w.month - 1]} ${w.year} om ${clockU}`
        if (!text.endsWith(suffix)) fail(suffix)
        if (describeRRule(rule, language, { time, start }) !== undefined) problems.push(`${spec.rrule}: an UNTIL without a zone was described`)
      }
      // Without its start an interval above one cannot say its phase: not described.
      if (n > 1 && describeRRule(rule, language, { time, timeZone: c.zone }) !== undefined) problems.push(`${spec.rrule}: described without its start`)
      checked++
    }
    expect(problems.slice(0, 10)).toEqual([])
    expect(checked).toBeGreaterThan(2000)
  }, 60_000)

  it("a plain weekly, monthly or yearly rule is not described without the start it takes its day from (findings 7, 8)", () => {
    for (const rule of ["FREQ=WEEKLY", "FREQ=MONTHLY", "FREQ=YEARLY", "FREQ=WEEKLY;INTERVAL=3", "FREQ=DAILY;INTERVAL=2"]) for (const language of ["en", "nl"] as const) expect(describeRRule(rule, language)).toBeUndefined()
    expect(describeRRule("FREQ=MONTHLY", "en", { start: { year: 2026, month: 10, day: 30 }, time: { hour: 9, minute: 0 } })).toBe("on the thirtieth of every month at nine o'clock in the morning")
    expect(describeRRule("FREQ=WEEKLY", "nl", { start: { year: 2026, month: 11, day: 16 }, time: { hour: 9, minute: 0 } })).toBe("elke maandag om negen uur 's ochtends")
    // A start the rule does not select is not described.
    expect(describeRRule("FREQ=WEEKLY;BYDAY=TU", "en", { start: { year: 2026, month: 11, day: 16 } })).toBeUndefined()
  })
})
