// Review round 2, decision 2: the recurrence engine against an independent brute-force reference.
//
// The reference below is a direct transcription of the semantics in the README ("Recurrence"): it walks local calendar days one by
// one (with JavaScript's own Date arithmetic, not the package's day numbers), decides membership of each day with the rule's
// definition, counts COUNT from DTSTART, converts each instance to an instant with its own offset search over Intl (the offset before
// a gap; the first of two), and drops an instant that is not later than the one before. The fast implementation jumps to the period
// of `after` with arithmetic. They must agree for every rule of a generated matrix and many `after` instants.
import { describe, expect, it } from "@effect/vitest"
import { parseRecurrence } from "../src/Recurrence.ts"
import { describeRRule, formatRRule, occurrencesAfter, parseRRule, readSeries, type RecurrenceRule, type RecurrenceSpec } from "../src/Rrule.ts"

// ---- the reference ------------------------------------------------------------------------------------------------------------------

interface Day { readonly y: number; readonly m: number; readonly d: number }
const DAY = 86_400_000
const utcOf = (x: Day): number => { const t = new Date(0); t.setUTCFullYear(x.y, x.m - 1, x.d); t.setUTCHours(0, 0, 0, 0); return t.getTime() }
const dayAt = (ms: number): Day => { const t = new Date(ms); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() } }
const weekdayRef = (x: Day): number => { const w = new Date(utcOf(x)).getUTCDay(); return w === 0 ? 7 : w }
const lastOfMonth = (x: Day): number => new Date(utcOf({ y: x.m === 12 ? x.y + 1 : x.y, m: x.m === 12 ? 1 : x.m + 1, d: 1 }) - DAY).getUTCDate()
const codes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

const offsetFormatters = new Map<string, Intl.DateTimeFormat>()
/** Zone minus UTC in ms at an instant, read from Intl's "GMT+01:00" offset name. */
const refOffset = (instant: number, zone: string): number => {
  let f = offsetFormatters.get(zone)
  if (f === undefined) { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }); offsetFormatters.set(zone, f) }
  const name = f.formatToParts(instant).find((p) => p.type === "timeZoneName")!.value
  const m = /GMT(?:([+-])(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(name)!
  if (m[1] === undefined) return 0
  return (m[1] === "-" ? -1 : 1) * ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000
}
/** The instant of a local time: the first that has it; in a gap, the reading with the offset from before the gap. */
const refInstant = (x: Day, hour: number, minute: number, zone: string): number => {
  const wall = utcOf(x) + (hour * 60 + minute) * 60_000
  const before = refOffset(wall - 36 * 3_600_000, zone)
  const after = refOffset(wall + 36 * 3_600_000, zone)
  const valid = [before, after].filter((o) => refOffset(wall - o, zone) === o).map((o) => wall - o)
  return valid.length > 0 ? Math.min(...valid) : wall - before
}

interface Case {
  readonly rule: RecurrenceRule
  readonly start: Day & { readonly hour: number; readonly minute: number }
  readonly zone: string
}

const member = (c: Case, x: Day): boolean => {
  const { rule, start } = c
  const s: Day = start
  if (utcOf(x) < utcOf(s)) return false
  const I = rule.interval
  switch (rule.freq) {
    case "DAILY": return Math.round((utcOf(x) - utcOf(s)) / DAY) % I === 0
    case "WEEKLY": {
      const monday = (v: Day) => utcOf(v) - (weekdayRef(v) - 1) * DAY
      if (Math.round((monday(x) - monday(s)) / (7 * DAY)) % I !== 0) return false
      const days = rule.byDay.length > 0 ? rule.byDay.map((d) => codes.indexOf(d.weekday) + 1) : [weekdayRef(s)]
      return days.includes(weekdayRef(x))
    }
    case "MONTHLY": {
      if (((x.y - s.y) * 12 + x.m - s.m) % I !== 0) return false
      if (rule.byDay.length === 1) {
        const { weekday, nth } = rule.byDay[0]!
        if (weekdayRef(x) !== codes.indexOf(weekday) + 1) return false
        return nth! > 0 ? Math.ceil(x.d / 7) === nth : lastOfMonth(x) - x.d < 7
      }
      if (rule.byMonthDay.length > 0) return rule.byMonthDay.some((v) => (v === -1 ? x.d === lastOfMonth(x) : x.d === v))
      return x.d === s.d
    }
    case "YEARLY":
      return (x.y - s.y) % I === 0 && x.m === (rule.byMonth[0] ?? s.m) && x.d === (rule.byMonthDay[0] ?? s.d)
  }
}

const untilMs = (u: string): number => Date.UTC(Number(u.slice(0, 4)), Number(u.slice(4, 6)) - 1, Number(u.slice(6, 8)), Number(u.slice(9, 11)), Number(u.slice(11, 13)), Number(u.slice(13, 15)))

/**
 * Up to `n` instances strictly after `after`, by walking every day: from DTSTART when there is a COUNT (it counts from there), else
 * from two days before `after`'s day (membership itself is measured from DTSTART). Stops at `horizon` (a day): `complete` says the
 * series ended before it, so a shorter answer is the whole answer.
 */
const reference = (c: Case, after: number, n: number, horizon: Day): { instants: Array<number>; complete: boolean } => {
  const startDay = utcOf(c.start)
  const afterDay = after === -Infinity ? startDay : utcOf(dayAt(after + refOffset(after, c.zone))) - 2 * DAY
  const from = c.rule.count !== undefined ? startDay : Math.max(startDay, afterDay)
  const until = c.rule.until === undefined ? Infinity : untilMs(c.rule.until)
  const out: Array<number> = []
  let counted = 0
  let last = -Infinity
  for (let t = from; t <= utcOf(horizon); t += DAY) {
    const x = dayAt(t)
    if (!member(c, x)) continue
    counted++
    if (c.rule.count !== undefined && counted > c.rule.count) return { instants: out, complete: true }
    if (t < afterDay) continue
    const instant = refInstant(x, c.start.hour, c.start.minute, c.zone)
    if (instant > until) return { instants: out, complete: true }
    if (instant <= last) continue
    last = instant
    if (instant > after) out.push(instant)
    if (out.length >= n) return { instants: out, complete: true }
  }
  return { instants: out, complete: false }
}

// ---- the matrix -----------------------------------------------------------------------------------------------------------------

const pad = (v: number, w = 2) => String(v).padStart(w, "0")
const specOf = (c: Case): RecurrenceSpec => ({
  rrule: formatRRule(c.rule)!,
  dtstart: `DTSTART;TZID=${c.zone}:${pad(c.start.y, 4)}${pad(c.start.m)}${pad(c.start.d)}T${pad(c.start.hour)}${pad(c.start.minute)}00`,
  timeZone: c.zone
})

const zones = ["Europe/Amsterdam", "Australia/Sydney"]
/** Month ends, 29 February, and the daylight-saving days of both zones (2026: Amsterdam 29 March and 25 October; Sydney 5 April and 4 October). */
const startDays: ReadonlyArray<Day> = [
  { y: 2024, m: 1, d: 31 }, { y: 2024, m: 2, d: 29 }, { y: 2025, m: 4, d: 30 }, { y: 2026, m: 12, d: 31 }, { y: 2026, m: 3, d: 29 }, { y: 2026, m: 10, d: 25 },
  { y: 2026, m: 4, d: 5 }, { y: 2026, m: 10, d: 4 }, { y: 2026, m: 11, d: 18 }
]
const times: ReadonlyArray<readonly [number, number]> = [[2, 30], [0, 0], [9, 0]]

const rulesFor = (s: Day, interval: number): Array<RecurrenceRule> => {
  const wd = weekdayRef(s)
  const code = (n: number) => codes[(n - 1 + 70) % 7]! as RecurrenceRule["byDay"][number]["weekday"]
  const base = { interval, byDay: [], byMonthDay: [], byMonth: [] }
  const out: Array<RecurrenceRule> = [
    { ...base, freq: "DAILY" },
    { ...base, freq: "WEEKLY" },
    { ...base, freq: "WEEKLY", byDay: [{ weekday: code(wd) }] },
    { ...base, freq: "WEEKLY", byDay: [wd, wd + 2, wd + 4].map((d) => ({ weekday: code(d) })).sort((a, b) => codes.indexOf(a.weekday) - codes.indexOf(b.weekday)) },
    { ...base, freq: "WEEKLY", byDay: (wd <= 5 ? [1, 2, 3, 4, 5] : [6, 7]).map((d) => ({ weekday: code(d) })) },
    { ...base, freq: "MONTHLY" },
    { ...base, freq: "MONTHLY", byMonthDay: [s.d] },
    { ...base, freq: "MONTHLY", byMonthDay: [...new Set([s.d, s.d === 15 ? 1 : 15])].sort((a, b) => a - b) },
    { ...base, freq: "MONTHLY", byDay: [{ weekday: code(wd), nth: Math.ceil(s.d / 7) }] },
    { ...base, freq: "YEARLY" },
    { ...base, freq: "YEARLY", byMonth: [s.m] },
    { ...base, freq: "YEARLY", byMonth: [s.m], byMonthDay: [s.d] }
  ]
  if (s.d === lastOfMonth(s)) {
    out.push({ ...base, freq: "MONTHLY", byMonthDay: [-1] })
    out.push({ ...base, freq: "MONTHLY", byMonthDay: [1, -1] })
  }
  if (lastOfMonth(s) - s.d < 7) out.push({ ...base, freq: "MONTHLY", byDay: [{ weekday: code(wd), nth: -1 }] })
  return out
}

const cases: Array<Case> = []
for (const zone of zones) for (const s of startDays) for (const [hour, minute] of times) for (let interval = 1; interval <= 4; interval++) {
  rulesFor(s, interval).forEach((r, k) => {
    // Every third rule is unbounded, the others end by COUNT or by UNTIL (about three years on).
    const end = (k + interval + hour) % 3
    const rule: RecurrenceRule = end === 0 ? r : end === 1 ? { ...r, count: 5 + interval * 3 } : { ...r, until: `${s.y + 3}${pad(s.m)}${pad(Math.min(s.d, 28))}T${pad(hour)}0000Z` }
    cases.push({ rule, start: { ...s, hour, minute }, zone })
  })
}

/** A small fixed generator, so the matrix is the same on every run. */
let seed = 42
const rand = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648 }

const horizonFor = (c: Case, after: number): Day => {
  const years = c.rule.freq === "YEARLY" ? 13 * c.rule.interval : c.rule.freq === "MONTHLY" ? 3 * c.rule.interval : 1
  const a = dayAt(Math.max(after, utcOf(c.start)))
  return { y: a.y + years, m: a.m, d: Math.min(a.d, 28) }
}

describe("the recurrence engine against a brute-force reference", () => {
  it(`agrees on ${cases.length} rules over many instants`, () => {
    const mismatches: Array<string> = []
    let compared = 0
    for (const c of cases) {
      const spec = specOf(c)
      const read = readSeries(spec)
      if (read.kind !== "ok") { mismatches.push(`${spec.rrule} ${spec.dtstart}: ${read.reason}`); continue }
      // parse → format → parse is the identity
      const again = parseRRule(spec.rrule)
      if (again.kind !== "ok" || JSON.stringify(again.rule) !== JSON.stringify(read.series.rule)) mismatches.push(`${spec.rrule}: parse/format`)
      const first = reference(c, -Infinity, 6, horizonFor(c, utcOf(c.start)))
      const afters = [utcOf(c.start) - 30 * DAY, first.instants[0]! - 1, first.instants[0]!, first.instants[0]! + 1, ...first.instants.slice(1, 4).flatMap((t) => [t - 1, t])]
      for (let k = 0; k < 5; k++) afters.push(utcOf(c.start) + Math.floor(rand() * 4 * 365) * DAY + Math.floor(rand() * DAY))
      if (c.rule.count === undefined && c.rule.until === undefined && c.start.hour === 9 && c.rule.interval === 3) afters.push(Date.UTC(2071, 5, 1), Date.UTC(2300, 0, 1, 12))
      for (const after of afters) {
        const want = reference(c, after, 3, horizonFor(c, after))
        const got = occurrencesAfter(spec, after, 3)
        compared++
        const horizonEnd = utcOf(horizonFor(c, after))
        const shown = got.filter((t) => want.complete || t < horizonEnd)
        if (JSON.stringify(shown.slice(0, want.instants.length)) !== JSON.stringify(want.instants) || (want.complete && got.length !== want.instants.length)) {
          mismatches.push(`${spec.rrule} ${spec.dtstart} after ${new Date(after).toISOString()}: got ${got.map((t) => new Date(t).toISOString())} want ${want.instants.map((t) => new Date(t).toISOString())}`)
        }
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
    expect(compared).toBeGreaterThan(30_000)
  }, 120_000)

  it("a DTSTART that is not an instance of its rule is invalid, as the reference says", () => {
    let checked = 0
    for (const c of cases.filter((_, k) => k % 7 === 0)) {
      const wd = weekdayRef(c.start)
      const wrong: RecurrenceRule = c.rule.freq === "WEEKLY" ? { ...c.rule, byDay: [{ weekday: codes[wd % 7] as "MO" }] }
        : c.rule.freq === "MONTHLY" ? { ...c.rule, byDay: [], byMonthDay: [c.start.d === 14 ? 13 : 14] }
        : c.rule.freq === "YEARLY" ? { ...c.rule, byMonth: [c.start.m === 6 ? 7 : 6], byMonthDay: [10] } : c.rule
      if (wrong === c.rule) continue
      expect(member({ ...c, rule: wrong }, c.start)).toBe(false)
      expect(readSeries(specOf({ ...c, rule: wrong })).kind).toBe("invalid")
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  })

  it("describeRRule never drops a constraint: its words, read back, give the same occurrences", () => {
    const problems: Array<string> = []
    let checked = 0
    for (const [k, c] of cases.entries()) {
      if (c.rule.count !== undefined || c.rule.until !== undefined) continue
      // A plain rule takes its day from today's; at 00:00 "just before the start" is the day before.
      if (c.start.hour === 0 && c.rule.byDay.length + c.rule.byMonthDay.length + c.rule.byMonth.length === 0 && c.rule.freq !== "DAILY") continue
      const language = k % 2 === 0 ? "en" : "nl"
      const spec = specOf(c)
      const time = { hour: c.start.hour, minute: c.start.minute }
      const text = describeRRule(spec.rrule, language, { time, start: { year: c.start.y, month: c.start.m, day: c.start.d } })
      if (text === undefined) { problems.push(`${spec.rrule}: no description`); continue }
      const startInstant = occurrencesAfter(spec, Date.UTC(1900, 0, 1), 1)[0]!
      const back = parseRecurrence(text, language, { now: startInstant - 60_000, timeZone: c.zone })
      if (back.kind !== "ok") { problems.push(`${language} "${text}" (${spec.rrule} ${spec.dtstart}): ${back.kind}`); continue }
      const theirs = occurrencesAfter({ rrule: back.value.rrule, dtstart: back.value.dtstart, timeZone: c.zone }, startInstant - 60_000, 8)
      const ours = occurrencesAfter(spec, startInstant - 60_000, 8)
      if (JSON.stringify(theirs) !== JSON.stringify(ours)) problems.push(`${language} "${text}" (${spec.rrule} ${spec.dtstart}) → ${back.value.rrule} ${back.value.dtstart}`)
      checked++
    }
    expect(problems.slice(0, 10)).toEqual([])
    expect(checked).toBeGreaterThan(500)
  }, 60_000)

  it("COUNT and UNTIL are said", () => {
    const start = (c: Case) => ({ year: c.start.y, month: c.start.m, day: c.start.d })
    for (const c of cases.filter((x) => x.rule.count !== undefined)) {
      expect(describeRRule(c.rule, "en", { timeZone: c.zone, start: start(c) })).toContain(`, ${c.rule.count} times`)
      expect(describeRRule(c.rule, "nl", { timeZone: c.zone, start: start(c) })).toContain(`, ${c.rule.count} keer`)
    }
    for (const c of cases.filter((x) => x.rule.until !== undefined)) {
      expect(describeRRule(c.rule, "en", { timeZone: c.zone, start: start(c) })).toMatch(/, until \d+ \w+ \d{4} at \d\d:\d\d/)
      expect(describeRRule(c.rule, "nl", { timeZone: c.zone, start: start(c) })).toMatch(/, tot \d+ \w+ \d{4} om \d\d:\d\d/)
      expect(describeRRule(c.rule, "en", { start: start(c) })).toBeUndefined()
    }
  })
})
