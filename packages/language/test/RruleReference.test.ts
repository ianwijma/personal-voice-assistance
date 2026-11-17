// The recurrence engine against an independent brute-force reference (review round 2, decision 2; made independent in round 3,
// finding 25). The reference shares nothing with the engine: it walks every local day with JavaScript's Date (support/Zone.ts),
// decides membership from the README's definitions, converts each instance with the tests' own Intl-based zone lookup (every offset
// seen near it tried and checked against the wall clock Intl formats), counts COUNT over distinct instants, and stops at the end of
// the supported years. The engine jumps to the period of `after` by arithmetic. They must agree, with no instant twice and none out
// of order, and with the same reason for stopping.
import { describe, expect, it } from "@effect/vitest"
import { parseRecurrence } from "../src/Recurrence.ts"
import { describeRRule, formatRRule, occurrencesAfter, parseRRule, readSeries, type RecurrenceRule, type RecurrenceSpec } from "../src/Rrule.ts"
import { stable } from "./support/Cfg.ts"
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
        if (c.rule.count !== undefined && counted > c.rule.count) return { instants: out, stop: "series" }
        if (instant > after) out.push(instant)
        if (out.length >= n) return { instants: out, stop: "limit" }
      }
    }
    // The next day, by hand.
    wd = wd === 7 ? 1 : wd + 1
    if (x.day < monthLength(x.year, x.month)) x.day++
    else if (x.month < 12) { x.day = 1; x.month++ } else { x.day = 1; x.month = 1; x.year++ }
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
      checked++
    }
    expect(checked).toBeGreaterThan(100)
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
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  })

  it("describeRRule: without COUNT and UNTIL the words read back to the same occurrences; with them, the suffix is the independent rendering", () => {
    const problems: Array<string> = []
    let readBack = 0
    let suffixed = 0
    const r = rng(203)
    for (const [k, c] of cases.entries()) {
      const language = k % 2 === 0 ? "en" : "nl"
      const spec = specOf(c)
      const start = { year: c.start.year, month: c.start.month, day: c.start.day }
      const time = { hour: c.start.hour, minute: c.start.minute }
      const plain: RecurrenceRule = { freq: c.rule.freq, interval: c.rule.interval, byDay: c.rule.byDay, byMonthDay: c.rule.byMonthDay, byMonth: c.rule.byMonth }
      const body = describeRRule(plain, language, { time, start })
      if (body === undefined) { problems.push(`${spec.rrule}: no description`); continue }
      if (c.rule.count !== undefined || c.rule.until !== undefined) {
        const said = describeRRule(c.rule, language, { time, start, timeZone: c.zone })
        let suffix: string
        if (c.rule.count !== undefined) suffix = language === "en" ? `, ${c.rule.count} ${c.rule.count === 1 ? "time" : "times"}` : `, ${c.rule.count} keer`
        else {
          const w = wallOf(untilMs(c.rule.until!), c.zone)
          const months = language === "en" ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
            : ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"]
          const clock = `${pad(w.hour)}:${pad(w.minute)}${w.second === 0 ? "" : `:${pad(w.second)}`}`
          suffix = language === "en" ? `, until ${w.day} ${months[w.month - 1]} ${w.year} at ${clock}` : `, tot ${w.day} ${months[w.month - 1]} ${w.year} om ${clock}`
          if (describeRRule(c.rule, language, { time, start }) !== undefined) problems.push(`${spec.rrule}: an UNTIL without a zone was described`)
        }
        if (said !== body + suffix) problems.push(`${spec.rrule}: "${said}" is not "${body}${suffix}"`)
        suffixed++
        continue
      }
      // Seconds are not said: compare at the minute. Interval 1: read at any moment within 60 days before DTSTART (the words must carry
      // the weekday, day or date a plain rule takes from DTSTART; finding 7, 8); a longer interval: just before DTSTART (its phase).
      const startInstant = instantsOf(c.start, c.zone)[0]!
      const minute = startInstant - c.start.second * 1000
      const now = c.rule.interval === 1 ? minute - r.int(1, 60 * 1440) * 60_000 : minute - 1000
      if (wallOf(now, c.zone).year < 2000) continue
      const back = parseRecurrence(body, language, { now, timeZone: c.zone })
      if (back.kind !== "ok") { problems.push(`${language} "${body}" (${spec.rrule} ${spec.dtstart}): ${back.kind}`); continue }
      const theirs = occurrencesAfter({ rrule: back.value.rrule, dtstart: back.value.dtstart, timeZone: c.zone }, minute - 1000, 8)!.instants
      const ours = occurrencesAfter(spec, minute - 1000, 8)!.instants.map((t) => t - c.start.second * 1000)
      if (JSON.stringify(theirs) !== JSON.stringify(ours)) problems.push(`${language} "${body}" (${spec.rrule} ${spec.dtstart}) → ${back.value.rrule} ${back.value.dtstart}`)
      readBack++
    }
    expect(problems.slice(0, 10)).toEqual([])
    expect(readBack).toBeGreaterThan(1000)
    expect(suffixed).toBeGreaterThan(1000)
  }, 60_000)

  it("a plain weekly, monthly or yearly rule is not described without the start it takes its day from (findings 7, 8)", () => {
    for (const rule of ["FREQ=WEEKLY", "FREQ=MONTHLY", "FREQ=YEARLY", "FREQ=WEEKLY;INTERVAL=3"]) for (const language of ["en", "nl"] as const) expect(describeRRule(rule, language)).toBeUndefined()
    expect(describeRRule("FREQ=MONTHLY", "en", { start: { year: 2026, month: 10, day: 30 }, time: { hour: 9, minute: 0 } })).toBe("on the thirtieth of every month at nine o'clock in the morning")
    expect(describeRRule("FREQ=WEEKLY", "nl", { start: { year: 2026, month: 11, day: 16 }, time: { hour: 9, minute: 0 } })).toBe("elke maandag om negen uur 's ochtends")
    // A start the rule does not select is not described.
    expect(describeRRule("FREQ=WEEKLY;BYDAY=TU", "en", { start: { year: 2026, month: 11, day: 16 } })).toBeUndefined()
  })
})
