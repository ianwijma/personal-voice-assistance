// Review round 3, decision 1 and 6: every exported function, called with generated arguments of wrong types, extreme values and odd
// strings, never throws and never returns NaN, Infinity, an invalid date, a date outside the supported years, or "" / "NaN" to say.
import { describe, expect, it } from "@effect/vitest"
import * as L from "../src/index.ts"
import { escaped } from "../src/Domain.ts"
import { rng, type Rng } from "./support/Rng.ts"

const strings = [
  "", " ", "tomorrow at five", "morgen om vijf uur", "every day", "2 kg flour", "two hours", "twenty five", "7:30", "x".repeat(201), "a ".repeat(60),
  "constructor", "__proto__", "toString", "NaN", "Infinity", "-Infinity", "1e308", "0x10", "9".repeat(400), "½", "<5", "2,5", "1.500", "１２", "٣",
  "tweeënhalf kilo", "in 999999999999 hours", "\u0000", "\uD800", "🙂", "FREQ=DAILY", "DTSTART;TZID=UTC:20261118T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "FREQ=DAILY;UNTIL=99991231T000000Z", "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "DTSTART;TZID=Mars/Olympus:20261118T090000", "Europe/Amsterdam", "+01:00", "UTC"
]
const numbers = [0, -0, 1, -1, 0.5, 1e-300, Number.MIN_VALUE, 1e21, -1e21, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 8.64e15, 8.64e15 + 1, -8.64e15,
  Number.NaN, Infinity, -Infinity, 999_999.999, 1_000_000, 0.0004, 2.5, 59, 60, 23, 24, 1439, 1440, Date.UTC(2026, 10, 18), Date.UTC(1999, 11, 31, 23), Date.UTC(2200, 0, 1), Date.UTC(10000, 0, 1)]
const odd: ReadonlyArray<unknown> = [undefined, null, true, false, {}, [], [1], () => 1, Symbol("s"), 10n, new Date(Number.NaN), new Date(Date.UTC(2026, 10, 18)), Object.create(null), { toString: () => "x" }]
const any = (r: Rng): unknown => {
  const k = r.int(0, 2)
  return k === 0 ? r.pick(strings) : k === 1 ? r.pick(numbers) : r.pick(odd)
}
const language = (r: Rng): unknown => (r.chance(0.8) ? r.pick(["en", "nl"]) : r.pick(["de", "EN", "", undefined, null, 1, {}]))
const zone = (r: Rng): unknown => r.pick(["Europe/Amsterdam", "UTC", "Pacific/Apia", "Australia/Lord_Howe", "europe/amsterdam ", "+01:00", "Mars/Olympus", "", undefined, 5, null])
const now = (r: Rng): unknown => (r.chance(0.7) ? r.pick(numbers) : r.pick([new Date(Date.UTC(2026, 10, 18)), new Date(Number.NaN), "2026-11-18", undefined, null, {}]))
const clock = (r: Rng): unknown => (r.chance(0.6) ? { hour: r.pick(numbers), minute: r.pick(numbers) } : any(r))
const date = (r: Rng): unknown => (r.chance(0.6) ? { year: r.pick([2026, 1999, 2200, 2000, 2199, 10000, Number.NaN, 2026.5]), month: r.pick([1, 2, 12, 13, 0, Number.NaN]), day: r.pick([1, 29, 30, 31, 32, -1]) } : any(r))
const dateOptions = (r: Rng): unknown => (r.chance(0.8)
  ? { now: now(r), timeZone: zone(r), ...(r.chance(0.3) ? { band: r.pick([{ from: "07:00", to: "21:00" }, { from: 2000, to: 3 }, { from: "25:00", to: "x" }, null, { from: Number.NaN, to: 10 }]) } : {}),
    ...(r.chance(0.3) ? { defaultTime: clock(r) } : {}) }
  : any(r))
const text = (r: Rng): unknown => (r.chance(0.85) ? r.pick(strings) : any(r))
const spec = (r: Rng): unknown => (r.chance(0.8) ? { rrule: r.pick([...strings, "FREQ=DAILY;COUNT=3", "FREQ=WEEKLY;INTERVAL=999"]), dtstart: r.pick([...strings, "DTSTART;TZID=Pacific/Apia:20111228T090000", "DTSTART;TZID=UTC:21991231T235959"]), timeZone: zone(r) } : any(r))
const unit = (r: Rng): unknown => r.pick(["g", "kg", "oz", "lb", "ml", "l", "cup", "tsp", "pack", "piece", "handful", "parsec", "", undefined, "constructor"])

/** Every exported function with a generator of its arguments. */
const calls: ReadonlyArray<readonly [string, (r: Rng) => unknown]> = [
  ["parseNumber", (r) => L.parseNumber(text(r) as string, language(r) as "en")],
  ["parseDuration", (r) => L.parseDuration(text(r) as string, language(r) as "en")],
  ["parseTimeOfDay", (r) => L.parseTimeOfDay(text(r) as string, language(r) as "en", (r.chance(0.5) ? { band: { from: r.pick(numbers), to: r.pick(numbers) }, afterMinutes: r.pick(numbers) } : any(r)) as undefined)],
  ["parseDateTime", (r) => L.parseDateTime(text(r) as string, language(r) as "en", dateOptions(r) as L.DateOptions)],
  ["parseQuantity", (r) => L.parseQuantity(text(r) as string, language(r) as "en", (r.chance(0.5) ? { cupMl: r.pick(numbers) } : any(r)) as undefined)],
  ["convertAmount", (r) => L.convertAmount(r.pick(numbers) as number, unit(r) as "g", unit(r) as "g", (r.chance(0.5) ? { cupMl: r.pick(numbers) } : any(r)) as undefined)],
  ["parseRecurrence", (r) => L.parseRecurrence(text(r) as string, language(r) as "en", dateOptions(r) as L.RecurrenceOptions)],
  ["parseRRule", (r) => L.parseRRule(text(r) as string)],
  ["formatRRule", (r) => L.formatRRule((r.chance(0.5) ? { freq: r.pick(["DAILY", "WEEKLY", "HOURLY", 1]), interval: r.pick(numbers), byDay: r.pick([[], [{ weekday: "MO" }], [{ weekday: "XX" }], null]), byMonthDay: r.pick([[], [31], [0], null]), byMonth: r.pick([[], [2], null]), ...(r.chance(0.3) ? { count: r.pick(numbers) } : {}) } : any(r)) as L.RecurrenceRule)],
  ["parseDtstart", (r) => L.parseDtstart(text(r) as string)],
  ["formatDtstart", (r) => L.formatDtstart({ ...(date(r) as object), hour: r.pick(numbers), minute: r.pick(numbers) } as L.LocalDateTime, zone(r) as string)],
  ["readSeries", (r) => L.readSeries(spec(r) as L.RecurrenceSpec)],
  ["occurrencesAfter", (r) => L.occurrencesAfter(spec(r) as L.RecurrenceSpec, r.pick(numbers) as number, r.pick([1, 3, 0, -1, 10_001, Number.NaN, 2.5, undefined]) as number)],
  ["nextOccurrence", (r) => L.nextOccurrence(spec(r) as L.RecurrenceSpec, now(r) as number)],
  ["seriesAfter", (r) => {
    const read = L.readSeries(spec(r) as L.RecurrenceSpec)
    const s = read.kind === "ok" ? read.series : r.pick([{ rule: { freq: "DAILY", interval: 1, byDay: [], byMonthDay: [], byMonth: [] }, start: date(r), timeZone: zone(r) }, any(r)])
    return L.seriesAfter(s as L.Series, r.pick(numbers) as number, r.pick([1, 5, 0, 20_000]) as number)
  }],
  ["describeRRule", (r) => L.describeRRule(text(r) as string, language(r) as "en", (r.chance(0.6) ? { start: date(r), time: clock(r), timeZone: zone(r) } : any(r)) as undefined)],
  ["speakNumber", (r) => L.speakNumber(r.pick(numbers) as number, language(r) as "en", (r.chance(0.5) ? { words: r.chance(0.5) } : any(r)) as undefined)],
  ["speakAmount", (r) => L.speakAmount((r.chance(0.7) ? { amount: r.pick(numbers), unit: unit(r), approx: r.chance(0.5), rest: r.chance(0.1) } : any(r)) as L.AmountLike, language(r) as "en", (r.chance(0.5) ? { item: text(r), humanize: r.chance(0.5) } : any(r)) as undefined)],
  ["speakDuration", (r) => L.speakDuration(r.pick(numbers) as number, language(r) as "en", any(r) as undefined)],
  ["speakTime", (r) => L.speakTime(clock(r) as L.ClockTime, language(r) as "en", (r.chance(0.5) ? { style: r.pick(["12h", "24h", "x"]), period: r.chance(0.5) } : any(r)) as undefined)],
  ["speakDate", (r) => L.speakDate(date(r) as L.LocalDate, language(r) as "en", date(r) as L.LocalDate)],
  ["speakMoment", (r) => L.speakMoment((r.chance(0.7) ? { date: date(r), time: clock(r) } : any(r)) as { date: L.LocalDate }, language(r) as "en", date(r) as L.LocalDate)],
  ["speakList", (r) => L.speakList((r.chance(0.7) ? Array.from({ length: r.int(0, 5) }, () => text(r)) : any(r)) as Array<string>, language(r) as "en", (r.chance(0.5) ? { max: r.pick(numbers) } : any(r)) as undefined)],
  ["numberToWords", (r) => L.numberToWords(r.pick(numbers) as number, language(r) as "en")],
  ["ordinalToWords", (r) => L.ordinalToWords(r.pick(numbers) as number, language(r) as "en")],
  ["normalizeTimeZone", (r) => L.normalizeTimeZone(text(r) as string)]
]

/** What a result must never hold. Returns the first problem found, or `undefined`. */
const problem = (v: unknown, path = "result", depth = 0, echoes = false): string | undefined => {
  if (depth > 8) return undefined
  if (typeof v === "number") return Number.isFinite(v) ? undefined : `${path} is ${v}`
  // A speaker that repeats the caller's text (an item, a list) may repeat "NaN" from it; its own words never hold these.
  if (typeof v === "string") return v === "" || (echoes ? /undefined|\[object/ : /NaN|Infinity|undefined|\[object/).test(v) ? `${path} is "${v}"` : undefined
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? undefined : `${path} is an invalid Date`
  if (Array.isArray(v)) {
    for (let k = 0; k < v.length; k++) {
      const p = problem(v[k], `${path}[${k}]`, depth + 1)
      if (p !== undefined) return p
      if (path.endsWith("instants")) { const y = new Date(v[k] as number).getUTCFullYear(); if (y < 1999 || y > 2200) return `${path}[${k}] is in ${y}` }
    }
    return undefined
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>
    if (typeof o["year"] === "number" && typeof o["month"] === "number" && (o["year"] < 2000 || o["year"] > 2199)) return `${path} is in ${o["year"]}`
    for (const key of ["instant", "startInstant"]) if (typeof o[key] === "number") { const y = new Date(o[key] as number).getUTCFullYear(); if (y < 1999 || y > 2200) return `${path}.${key} is in ${y}` }
    for (const [k, x] of Object.entries(o)) {
      if (k === "reason" || k === "said" || k === "item") continue
      const p = problem(x, `${path}.${k}`, depth + 1)
      if (p !== undefined) return p
    }
  }
  return undefined
}

describe("every exported function, any argument", () => {
  it("the fuzz covers every exported function", () => {
    const exported = Object.entries(L).filter(([, v]) => typeof v === "function").map(([k]) => k).sort()
    expect(calls.map(([name]) => name).sort()).toEqual(exported)
  })
  for (const [name, call] of calls) {
    it(`${name}: 3000 generated calls (seed 101) never throw, never escape a check, never return NaN, Infinity or a date outside 2000–2199`, () => {
      const r = rng(101 + name.length)
      const before = escaped.count
      for (let k = 0; k < 3000; k++) {
        let result: unknown
        try {
          result = call(r)
        } catch (e) {
          throw new Error(`${name} threw on call ${k}: ${String(e)}`)
        }
        const p = problem(result, "result", 0, name === "speakAmount" || name === "speakList")
        if (p !== undefined) throw new Error(`${name}, call ${k}: ${p}: ${JSON.stringify(result, (_k, x) => (typeof x === "bigint" ? String(x) : x))?.slice(0, 300)}`)
      }
      if (escaped.count !== before) throw new Error(`${name}: ${escaped.count - before} exceptions escaped a check; the last: ${String(escaped.last)}`)
    })
  }
  it("hostile arguments (getters that throw, proxies) in any position are answered, never thrown", () => {
    const hostile = new Proxy({}, { get: () => { throw new Error("no") }, has: () => { throw new Error("no") }, ownKeys: () => { throw new Error("no") }, getPrototypeOf: () => { throw new Error("no") } })
    const benign: ReadonlyArray<unknown> = ["tomorrow", "en", { now: Date.UTC(2026, 10, 18), timeZone: "UTC" }, 1]
    for (const [name, f] of Object.entries(L)) {
      if (typeof f !== "function") continue
      for (let k = 0; k < 4; k++) {
        const args = benign.map((b, j) => (j === k ? hostile : b))
        expect(() => (f as (...a: Array<unknown>) => unknown)(...args), `${name}, argument ${k}`).not.toThrow()
      }
    }
  })
})
