// The time-of-day grammar of the README ("Time of day"), for the tests, and its meaning: how the hour is settled. Values of the
// grammar are readings ({ hour, minute, exact, bare, midnight, period }); `settleReading` turns one into the time the README says.
import { fixed, lit, oneOf, words, type Grammar, type Rule, type Term } from "../support/Cfg.ts"
import { number, type Lang } from "./numbers.ts"

export type Period = "am" | "pm" | "morning" | "afternoon" | "evening" | "night"
export interface Reading {
  readonly hour: number
  readonly minute: number
  /** The hour says itself: 0, 13–23, a leading zero, "oh", "zero", "hundred", noon, midnight. */
  readonly exact: boolean
  readonly bare: boolean
  readonly midnight: boolean
  readonly period?: Period
}
const reading = (hour: number, minute: number, exact: boolean, extra: Partial<Reading> = {}): Reading => ({ hour, minute, exact, bare: false, midnight: false, ...extra })

/** A clock in digits: "7:30", "19.30", "07:00"; "24:00" only where a date-time allows it. */
const clock = (allow24: boolean): Term => ({
  read: (w) => {
    const m = /^([0-9]{1,2})[:.]([0-9]{2})$/.exec(w)
    if (m === null) return undefined
    const hour = Number(m[1])
    const minute = Number(m[2])
    if (minute > 59 || hour > 24 || (hour === 24 && (minute > 0 || !allow24))) return undefined
    return reading(hour, minute, hour === 0 || hour > 12 || m[1]!.startsWith("0"))
  },
  write: (r) => {
    const hour = allow24 && r.chance(0.02) ? 24 : r.int(0, 23)
    const minute = hour === 24 ? 0 : r.int(0, 59)
    const h = hour < 10 && r.chance(0.5) ? `0${hour}` : String(hour)
    return `${h}${r.chance(0.7) ? ":" : "."}${String(minute).padStart(2, "0")}`
  }
})
/** A bare hour in digits: "7", "07", "19". */
const digitHour = (min: number, max: number, zero: boolean): Term => ({
  read: (w) => {
    if (!/^[0-9]{1,2}$/.test(w) || (!zero && w.startsWith("0") && w.length === 2)) return undefined
    const h = Number(w)
    return h >= min && h <= max ? { hour: h, exact: h === 0 || h > 12 || w.startsWith("0") } : undefined
  },
  write: (r) => {
    const h = r.int(min, max)
    return zero && h < 10 && r.chance(0.3) ? `0${h}` : String(h)
  }
})
const enUnit = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 }

const enPeriods: ReadonlyArray<Rule> = [
  fixed([lit("am")], "am"), fixed([lit("pm")], "pm"), fixed(words("in the morning"), "morning"), fixed(words("in the afternoon"), "afternoon"),
  fixed(words("in the evening"), "evening"), fixed(words("at night"), "night")
]
const nlPeriods: ReadonlyArray<Rule> = [
  fixed([lit("'s"), lit("ochtends")], "morning"), fixed([lit("'s"), lit("morgens")], "morning"), fixed([lit("'s"), lit("middags")], "afternoon"),
  fixed([lit("'s"), lit("avonds")], "evening"), fixed([lit("'s"), lit("nachts")], "night"),
  fixed(words("in de ochtend"), "morning"), fixed(words("in de middag"), "afternoon"), fixed(words("in de avond"), "evening"), fixed(words("in de nacht"), "night")
]
const before = (h: number) => (h === 1 ? 12 : h - 1)

/** TIME: a clock reading and the part of the day said after it. `allow24`: "24:00" (date-times only). */
export const timeGrammar = (lang: Lang, allow24 = false): Grammar => {
  const words12 = number(lang, { min: 1, max: 12, whole: true, forms: "words" })
  const h12: ReadonlyArray<Rule> = [{ rhs: [words12] }, { rhs: [digitHour(1, 12, false)], act: ([h]) => h.hour }]
  const core: ReadonlyArray<Rule> = lang === "en"
    ? [
      { rhs: [clock(allow24)], weight: 3 },
      fixed([lit("noon")], reading(12, 0, true)), fixed([lit("midday")], reading(12, 0, true)), fixed([lit("midnight")], reading(0, 0, true, { midnight: true })),
      { rhs: ["MINB", lit("past"), "H12"], act: ([m, , h]) => reading(h, m, false), weight: 2 },
      { rhs: [lit("half"), lit("past"), "H12"], act: ([, , h]) => reading(h, 30, false) },
      { rhs: ["MINB", lit("to"), "H12"], act: ([m, , h]) => reading(before(h), 60 - m, false), weight: 2 },
      { rhs: ["MINW", lit("past"), "H12"], act: ([m, , h]) => reading(h, m, false) },
      { rhs: ["MINW", lit("to"), "H12"], act: ([m, , h]) => reading(before(h), 60 - m, false) },
      { rhs: [lit("half"), "H12"], act: ([, h]) => reading(h, 30, false) },
      { rhs: ["H12", lit("o'clock")], act: ([h]) => reading(h, 0, false) },
      { rhs: ["H24", lit("hundred")], act: ([h]) => reading(h, 0, true) },
      { rhs: ["HW", "MW"], act: ([h, m]) => reading(h.hour, m, h.exact), weight: 3 },
      { rhs: [number("en", { min: 0, max: 23, whole: true, forms: "words" })], act: ([h]) => reading(h, 0, !(h >= 1 && h <= 12), { bare: true }) },
      { rhs: [digitHour(0, 23, true)], act: ([h]) => reading(h.hour, 0, h.exact, { bare: true }) }
    ]
    : [
      { rhs: [clock(allow24)], weight: 3 },
      fixed([lit("middernacht")], reading(0, 0, true, { midnight: true })),
      { rhs: ["MINB", lit("over"), "H12"], act: ([m, , h]) => reading(h, m, false), weight: 2 },
      { rhs: ["MINB", lit("voor"), "H12"], act: ([m, , h]) => reading(before(h), 60 - m, false), weight: 2 },
      { rhs: ["MINH", lit("over"), lit("half"), "H12"], act: ([m, , , h]) => reading(before(h), 30 + m, false) },
      { rhs: ["MINH", lit("voor"), lit("half"), "H12"], act: ([m, , , h]) => reading(before(h), 30 - m, false) },
      { rhs: [lit("half"), "H12"], act: ([, h]) => reading(before(h), 30, false), weight: 2 },
      { rhs: ["HN", lit("uur")], act: ([h]) => reading(h.hour, 0, h.exact), weight: 2 },
      { rhs: ["HN", lit("uur"), number("nl", { min: 1, max: 59, whole: true, forms: "words" })], act: ([h, , m]) => reading(h.hour, m, h.exact), weight: 2 },
      { rhs: ["HN"], act: ([h]) => reading(h.hour, 0, h.exact, { bare: true }) },
      ...(allow24 ? [{ rhs: [oneOf({ "24": 24, vierentwintig: 24 }), lit("uur")], act: () => reading(24, 0, true) }] : [])
    ]
  return {
    H12: h12,
    MINB: lang === "en"
      ? [fixed([lit("five")], 5), fixed([lit("ten")], 10), fixed([lit("quarter")], 15), fixed(words("a quarter"), 15), fixed([lit("twenty")], 20), fixed(words("twenty five"), 25)]
      : [fixed([lit("vijf")], 5), fixed([lit("tien")], 10), fixed([lit("kwart")], 15), { rhs: ["MINW"] }],
    MINW: [
      { rhs: [number(lang, { min: 1, max: 29, whole: true, forms: "words" }), oneOf(lang === "en" ? { minutes: 1, minute: 1 } : { minuten: 1, minuut: 1 })] },
      { rhs: [digitHour(1, 29, false), oneOf(lang === "en" ? { minutes: 1, minute: 1 } : { minuten: 1, minuut: 1 })], act: ([h]) => h.hour }
    ],
    MINH: [fixed([lit("vijf")], 5), fixed([lit("tien")], 10)],
    H24: [
      { rhs: [number("en", { min: 10, max: 23, whole: true, forms: "words" })] },
      { rhs: [lit("oh"), oneOf(enUnit)], act: ([, u]) => u }, fixed([lit("zero")], 0)
    ],
    HW: [
      { rhs: [number("en", { min: 1, max: 23, whole: true, forms: "words" })], act: ([h]) => ({ hour: h, exact: h > 12 }) },
      { rhs: [lit("oh"), oneOf(enUnit)], act: ([, u]) => ({ hour: u, exact: true }) }, fixed([lit("zero")], { hour: 0, exact: true })
    ],
    MW: [{ rhs: [number("en", { min: 10, max: 59, whole: true, forms: "words" })] }, { rhs: [lit("oh"), oneOf(enUnit)], act: ([, u]) => u }],
    HN: [
      { rhs: [number("nl", { min: 0, max: 23, whole: true, forms: "words" })], act: ([h]) => ({ hour: h, exact: h === 0 || h > 12 }) },
      { rhs: [digitHour(0, 23, true)] }
    ],
    CORE: core,
    PERIOD: lang === "en" ? enPeriods : nlPeriods,
    TIME: [
      { rhs: ["CORE"], weight: 2 },
      { rhs: ["CORE", "PERIOD"], act: ([c, p]) => ({ ...c, bare: false, period: p }) }
    ],
    TIMEPHRASE: [{ rhs: ["TIME"], weight: 2 }, { rhs: [lit(lang === "en" ? "at" : "om"), "TIME"], act: ([, t]) => t }]
  }
}

// ---- the meaning: the README's rules for settling an hour, written out as tables ------------------------------------------------

/** The hours a part of the day covers (README: "07:00 in the evening" is refused). */
export const inPart = (p: Period, h: number): boolean =>
  ({ am: h < 12, pm: h >= 12, morning: h < 12, afternoon: h >= 12 && h < 19, evening: h >= 17 && h < 24, night: h >= 18 || h < 6 })[p]
/** The 24-hour hour an open hour 1–12 has in a part of the day; `undefined`: none ("twelve in the morning"). */
const hourIn = (p: Period, h: number): number | undefined => {
  if (p === "am") return h % 12
  if (p === "pm" || p === "afternoon") return (h % 12) + 12
  if (p === "morning") return h === 12 ? undefined : h
  if (p === "evening") return h === 12 ? undefined : h + 12
  return h === 12 ? 0 : h < 6 ? h : h + 12
}

export interface Settled {
  readonly hour: number
  readonly minute: number
  readonly guessed: boolean
  readonly alternatives: ReadonlyArray<{ readonly hour: number; readonly minute: number }>
}
/**
 * A reading settled: an exact hour stays (a part of the day said with it must cover it), an open hour takes the part of the day said,
 * else the band's readings (the next after `after`, else the earliest), `guessed`. `"both"` when the band holds neither reading.
 */
export const settleReading = (t: Reading, band = { from: 420, to: 1260 }, after?: number): Settled | "both" | undefined => {
  if (t.hour === 24) return undefined
  if (t.exact) return t.period !== undefined && !inPart(t.period, t.hour) ? undefined : { hour: t.hour, minute: t.minute, guessed: false, alternatives: [] }
  if (t.period !== undefined) {
    const h = hourIn(t.period, t.hour)
    return h === undefined || !inPart(t.period, h) ? undefined : { hour: h, minute: t.minute, guessed: false, alternatives: [] }
  }
  const both = [t.hour % 12, (t.hour % 12) + 12].map((hour) => ({ hour, minute: t.minute }))
  const inBand = both.filter((x) => x.hour * 60 + x.minute >= band.from && x.hour * 60 + x.minute <= band.to)
  if (inBand.length === 0) return "both"
  const chosen = (after === undefined ? undefined : inBand.find((x) => x.hour * 60 + x.minute > after)) ?? inBand[0]!
  return { ...chosen, guessed: true, alternatives: inBand.filter((x) => x !== chosen) }
}
