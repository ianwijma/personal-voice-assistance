// Review round 3, decision 1 and 6, narrowed in round 4 (decision 1): every exported function, called with arguments of their declared
// types holding any data — extreme and odd numbers, odd strings, unknown time zones — never throws and never returns NaN, Infinity,
// an invalid date, a date outside the supported years, or "" / "NaN" to say; an unknown time zone gives the function's failure.
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
// Review round 4, decision 1: text and numbers are data and may be anything; everything else is the caller's code and has its declared
// type. So every argument here has its declared type, and the data in it — every string, number, instant and time zone — is drawn
// from the pools above, whatever it holds.
const language = (r: Rng): L.Language => r.pick(["en", "nl"] as const)
/** Time zone strings; the invalid ones must give the function's failure (round 4, finding 18). */
const invalidZones: ReadonlyArray<string> = ["+01:00", "Mars/Olympus", "", "not/a/zone", "GMT+1", "x".repeat(65), "constructor"]
const zone = (r: Rng): string => r.pick(["Europe/Amsterdam", "UTC", "Pacific/Apia", "Australia/Lord_Howe", "Africa/Casablanca", "europe/amsterdam ", ...invalidZones])
const now = (r: Rng): number | Date => (r.chance(0.8) ? r.pick(numbers) : new Date(r.pick(numbers)))
const clock = (r: Rng): L.ClockTime => ({ hour: r.pick(numbers), minute: r.pick(numbers) })
const date = (r: Rng): L.LocalDate => ({ year: r.pick([2026, 1999, 2200, 2000, 2199, 10000, Number.NaN, 2026.5, ...numbers]), month: r.pick([1, 2, 12, 13, 0, Number.NaN, 2.5]), day: r.pick([1, 29, 30, 31, 32, -1, 1.5]) })
const band = (r: Rng): { from: string | number; to: string | number } => ({ from: r.chance(0.5) ? r.pick(strings) : r.pick(numbers), to: r.chance(0.5) ? r.pick(["21:00", "07:00", "2100", "24:00", ...strings]) : r.pick(numbers) })
const dateOptions = (r: Rng, z = zone(r)): L.DateOptions & L.RecurrenceOptions => ({
  now: now(r), timeZone: z, ...(r.chance(0.3) ? { band: band(r) } : {}), ...(r.chance(0.3) ? { defaultTime: clock(r) } : {})
})
const text = (r: Rng): string => r.pick(strings)
const spec = (r: Rng, z = zone(r)): L.RecurrenceSpec => ({
  rrule: r.pick([...strings, "FREQ=DAILY;COUNT=3", "FREQ=WEEKLY;INTERVAL=999", "FREQ=DAILY;BYHOUR=99", "FREQ=YEARLY;BYWEEKNO=0"]),
  dtstart: r.pick([...strings, "DTSTART;TZID=Pacific/Apia:20111228T090000", "DTSTART;TZID=UTC:21991231T235959", "DTSTART;TZID=Europe/Amsterdam:20261118T090000"]),
  timeZone: z
})
const units: ReadonlyArray<L.UnitId> = ["g", "kg", "oz", "lb", "ml", "cl", "dl", "l", "cup", "tsp", "tbsp", "pack", "bag", "piece", "handful", "pinch", "splash"]
const unit = (r: Rng): L.UnitId => r.pick(units)
const rule = (r: Rng): L.RecurrenceRule => ({
  freq: r.pick(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const), interval: r.pick([1, 2, 999, 1000, ...numbers]),
  byDay: r.pick([[], [{ weekday: "MO" as const }], [{ weekday: "TU" as const, nth: r.pick([1, -1, 5, 6, 0, ...numbers]) }]]),
  byMonthDay: r.pick([[], [31], [0], [-1], [1, 15], [r.pick(numbers)]]), byMonth: r.pick([[], [2], [13], [r.pick(numbers)]]),
  ...(r.chance(0.3) ? { count: r.pick(numbers) } : {}), ...(r.chance(0.2) ? { until: r.pick([...strings, "20271231T230000Z", "21991231T235959Z"]) } : {})
})

/** A call, and whether its data says it must fail: a known-invalid zone, for every function that takes one. */
type Call = (r: Rng) => { readonly result: unknown; readonly mustFail?: boolean }
const failed = (v: unknown): boolean =>
  v === undefined || (typeof v === "object" && v !== null && ["not-understood", "invalid", "unsupported"].includes((v as { kind?: string }).kind ?? ""))
const withZone = (r: Rng, f: (z: string) => unknown) => { const z = zone(r); return { result: f(z), mustFail: invalidZones.includes(z) } }

/** Every exported function with a generator of its arguments. */
const calls: ReadonlyArray<readonly [string, Call]> = [
  ["parseNumber", (r) => ({ result: L.parseNumber(text(r), language(r)) })],
  ["parseDuration", (r) => ({ result: L.parseDuration(text(r), language(r)) })],
  ["parseTimeOfDay", (r) => ({ result: L.parseTimeOfDay(text(r), language(r), r.chance(0.7) ? { band: band(r), afterMinutes: r.pick(numbers) } : r.chance(0.5) ? { afterMinutes: r.pick(numbers) } : undefined) })],
  ["parseDateTime", (r) => withZone(r, (z) => L.parseDateTime(text(r), language(r), dateOptions(r, z)))],
  ["parseQuantity", (r) => ({ result: L.parseQuantity(text(r), language(r), r.chance(0.5) ? { cupMl: r.pick(numbers) } : undefined) })],
  ["convertAmount", (r) => ({ result: L.convertAmount(r.pick(numbers), unit(r), unit(r), r.chance(0.5) ? { cupMl: r.pick(numbers) } : undefined) })],
  ["parseRecurrence", (r) => withZone(r, (z) => L.parseRecurrence(text(r), language(r), dateOptions(r, z)))],
  ["parseRRule", (r) => ({ result: L.parseRRule(text(r)) })],
  ["formatRRule", (r) => ({ result: L.formatRRule(rule(r)) })],
  ["parseDtstart", (r) => ({ result: L.parseDtstart(r.chance(0.5) ? text(r) : `DTSTART;TZID=${zone(r)}:20261118T090000`) })],
  ["formatDtstart", (r) => withZone(r, (z) => L.formatDtstart({ ...date(r), hour: r.pick(numbers), minute: r.pick(numbers), ...(r.chance(0.5) ? { second: r.pick(numbers) } : {}) }, z))],
  ["readSeries", (r) => withZone(r, (z) => L.readSeries(spec(r, z)))],
  ["occurrencesAfter", (r) => withZone(r, (z) => L.occurrencesAfter(spec(r, z), r.pick(numbers), r.pick([1, 3, 0, -1, 10_001, Number.NaN, 2.5, ...numbers])))],
  ["nextOccurrence", (r) => withZone(r, (z) => L.nextOccurrence(spec(r, z), now(r)))],
  ["seriesAfter", (r) => {
    const read = L.readSeries(spec(r))
    // A series `readSeries` returned, or one made by hand from type-correct parts (round 4, finding 3: refused exactly as readSeries refuses).
    const s: L.Series = read.kind === "ok" && r.chance(0.5) ? read.series : { rule: rule(r), start: { ...date(r), hour: r.pick(numbers), minute: r.pick(numbers), second: r.pick([0, 30, ...numbers]) }, timeZone: zone(r) }
    return { result: L.seriesAfter(s, r.pick(numbers), r.pick([1, 5, 0, 20_000, ...numbers])) }
  }],
  ["describeRRule", (r) => withZone(r, (z) => L.describeRRule(r.chance(0.5) ? text(r) : rule(r), language(r), r.chance(0.8) ? { start: date(r), time: clock(r), timeZone: z } : { timeZone: z }))],
  ["speakNumber", (r) => ({ result: L.speakNumber(r.pick(numbers), language(r), { words: r.chance(0.5) }) })],
  ["speakAmount", (r) => ({ result: L.speakAmount(r.chance(0.8) ? { amount: r.pick(numbers), unit: unit(r), approx: r.chance(0.5), rest: r.chance(0.1) } : { approx: true }, language(r), { item: text(r), humanize: r.chance(0.5) }) })],
  ["speakDuration", (r) => ({ result: L.speakDuration(r.pick(numbers), language(r), { natural: r.chance(0.5) }) })],
  ["speakTime", (r) => ({ result: L.speakTime(clock(r), language(r), { style: r.pick(["12h", "24h"] as const), period: r.chance(0.5) }) })],
  ["speakDate", (r) => ({ result: L.speakDate(date(r), language(r), date(r)) })],
  ["speakMoment", (r) => ({ result: L.speakMoment(r.chance(0.5) ? { date: date(r), time: clock(r) } : { date: date(r) }, language(r), date(r), { style: r.pick(["12h", "24h"] as const) }) })],
  ["speakList", (r) => ({ result: L.speakList(Array.from({ length: r.int(0, 5) }, () => text(r)), language(r), r.chance(0.5) ? { max: r.pick(numbers) } : undefined) })],
  ["numberToWords", (r) => ({ result: L.numberToWords(r.pick(numbers), language(r)) })],
  ["ordinalToWords", (r) => ({ result: L.ordinalToWords(r.pick(numbers), language(r)) })],
  ["normalizeTimeZone", (r) => withZone(r, (z) => L.normalizeTimeZone(z))]
]

/** What a result must never hold. Returns the first problem found, or `undefined`. */
const problem = (v: unknown, path = "result", depth = 0, echoes = false): string | undefined => {
  if (depth > 8) return undefined
  if (typeof v === "number") return Number.isFinite(v) ? undefined : `${path} is ${v}`
  // A speaker that repeats the caller's text (an item, a list) may repeat "NaN" or spaces from it; its own words never hold these, nor
  // a space at either end or two in a row (an utterance with a part missing, review round 3 finding 23).
  if (typeof v === "string") return v === "" || (echoes ? /undefined|\[object/ : /NaN|Infinity|undefined|\[object|^\s|\s$|\s\s/).test(v) ? `${path} is "${v}"` : undefined
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
    it(`${name}: 3000 generated calls (seed 101) never throw, never escape a check, never return NaN, Infinity or a date outside 2000–2199, and fail for an unknown zone`, () => {
      const r = rng(101 + name.length)
      const before = escaped.count
      let mustFail = 0
      for (let k = 0; k < 3000; k++) {
        let out: { result: unknown; mustFail?: boolean }
        try {
          out = call(r)
        } catch (e) {
          throw new Error(`${name} threw on call ${k}: ${String(e)}`)
        }
        const p = problem(out.result, "result", 0, name === "speakAmount" || name === "speakList")
        if (p !== undefined) throw new Error(`${name}, call ${k}: ${p}: ${JSON.stringify(out.result)?.slice(0, 300)}`)
        if (out.mustFail === true) {
          mustFail++
          if (!failed(out.result)) throw new Error(`${name}, call ${k}: an unknown time zone gave ${JSON.stringify(out.result)?.slice(0, 300)}`)
        }
      }
      if (escaped.count !== before) throw new Error(`${name}: ${escaped.count - before} exceptions escaped a check; the last: ${String(escaped.last)}`)
      if (["parseDateTime", "parseRecurrence", "formatDtstart", "readSeries", "occurrencesAfter", "nextOccurrence", "describeRRule", "normalizeTimeZone"].includes(name)) expect(mustFail).toBeGreaterThan(500)
    })
  }
})
