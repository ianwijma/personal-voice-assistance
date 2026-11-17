import { dict } from "./Dict.ts"
import { guarded, isLanguage, isOptions, isText } from "./Domain.ts"
import { alt, from, map, oneOf, opt, seq, tok, whole, words, type Input, type P } from "./Grammar.ts"
import { wordNumber } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type ClockTime, type Language, type Parsed } from "./Result.ts"
import { sliceText, tokenize } from "./Tokens.ts"

/** A clock time said aloud. `guessed`: no part of the day was said and the band chose; `alternatives`: other readings inside the band. */
export interface TimeOfDay extends ClockTime {
  readonly guessed: boolean
  readonly alternatives: ReadonlyArray<ClockTime>
}

export interface TimeOptions {
  /**
   * A time said without a part of the day must fall inside this band: "HH:MM" or whole minutes since midnight (0–1439), `from` not
   * after `to`. Default 07:00–21:00. Anything else makes the answer `not-understood`.
   */
  readonly band?: { readonly from: string | number; readonly to: string | number }
  /** Whole minutes since midnight now (0–1439): of the readings in the band, the next one after it wins (else the earliest). */
  readonly afterMinutes?: number
}

export type Period = "am" | "pm" | "morning" | "afternoon" | "evening" | "night"

/** A time as read, before the band settles an open hour. */
export interface TimeMatch {
  /** 0–23 as said, or 24 for "24:00". */
  readonly hour: number
  readonly minute: number
  /** 1–12 said without anything that settles it: morning or evening. */
  readonly open: boolean
  /** Only a number was said ("seven", "7"). */
  readonly bare: boolean
  /** The word "midnight" / "middernacht". */
  readonly midnightWord: boolean
  readonly period?: Period
}

const toMinutes = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= 1439 ? v : undefined
  if (typeof v !== "string") return undefined
  // Exactly "HH:MM", as documented: no colonless "0730", no spaces (review round 4, finding 19).
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(v)
  return m === null ? undefined : Number(m[1]) * 60 + Number(m[2])
}
/** The band of the options, or `undefined` when it is not one (review round 3, decision 1). */
export const bandOf = (o: unknown): { from: number; to: number } | undefined => {
  if (!isOptions(o)) return undefined
  const band = (o as { band?: unknown } | undefined)?.band
  if (band === undefined) return { from: 7 * 60, to: 21 * 60 }
  if (!isOptions(band)) return undefined
  const from = toMinutes((band as { from?: unknown }).from)
  const to = toMinutes((band as { to?: unknown }).to)
  return from === undefined || to === undefined || from > to ? undefined : { from, to }
}

// ---- the grammar ---------------------------------------------------------------------------------------------------------------------

type Core = Omit<TimeMatch, "period">
const core = (hour: number, minute: number, open: boolean, bare = false, midnightWord = false): Core => ({ hour, minute, open, bare, midnightWord })

/** "7:30", "19.30", "07:00", "24:00": a clock written with digits; the hour is settled by a leading zero, 0 or 13–23. */
const clockToken: P<Core> = tok((w, t) => {
  const m = t.kind === "digits" ? /^([0-9]{1,2})[:.]([0-9]{2})$/.exec(w) : null
  if (m === null) return undefined
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (minute > 59 || hour > 24 || (hour === 24 && minute > 0)) return undefined
  return core(hour, minute, !(hour === 0 || hour > 12 || m[1]!.startsWith("0")))
})
/** An hour in digits, "7" or "07" or "19": `exact` when a leading zero, 0 or 13–23 settles it. */
const digitHour = (min: number, max: number, zeroOk: boolean): P<{ hour: number; exact: boolean }> => tok((w, t) => {
  if (t.kind !== "digits" || !/^[0-9]{1,2}$/.test(w) || (!zeroOk && w.length === 2 && w.startsWith("0"))) return undefined
  const hour = Number(w)
  return hour >= min && hour <= max ? { hour, exact: hour === 0 || hour > 12 || w.startsWith("0") } : undefined
})
const hour12: Record<Language, P<number>> = {
  en: alt(wordNumber("en", 1, 12), map(digitHour(1, 12, false), (h) => h.hour)),
  nl: alt(wordNumber("nl", 1, 12), map(digitHour(1, 12, false), (h) => h.hour))
}
const hourBefore = (h: number): number => (h === 1 ? 12 : h - 1)

const enMinutesBefore: P<number> = alt(
  map(words("five"), () => 5), map(words("ten"), () => 10), map(words("quarter"), () => 15), map(words("a", "quarter"), () => 15),
  map(words("twenty"), () => 20), map(words("twenty", "five"), () => 25)
)
const enUnit = dict<number>({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 })
/** "oh nine": an hour or a minute 1–9 said with "oh". */
const ohDigit: P<number> = map(seq(words("oh"), from(enUnit)), ([, u]) => u)

/** "seven minutes", "7 minutes", "a minute": 1–29 minutes said with the word (without it only 5, 10, 20, 25 and a quarter). */
const minutesWord = (language: Language): P<number> => alt(
  map(seq(alt(wordNumber(language, 1, 29), tok((w, t) => (t.kind === "digits" && /^[1-9][0-9]?$/.test(w) && Number(w) <= 29 ? Number(w) : undefined))), oneOf(...(language === "en" ? ["minutes", "minute"] : ["minuten", "minuut"]))), ([n]) => n)
)
const coresEn: P<Core> = alt(
  clockToken,
  map(oneOf("noon", "midday"), () => core(12, 0, false)),
  map(words("midnight"), () => core(0, 0, false, false, true)),
  // MINUTES past HOUR, MINUTES to HOUR, half past HOUR
  map(seq(alt(enMinutesBefore, map(words("half"), () => 30)), words("past"), hour12.en), ([m, , h]) => core(h, m, true)),
  map(seq(enMinutesBefore, words("to"), hour12.en), ([m, , h]) => core(hourBefore(h), 60 - m, true)),
  // "seven minutes past eight", "twenty nine minutes to nine"
  map(seq(minutesWord("en"), words("past"), hour12.en), ([m, , h]) => core(h, m, true)),
  map(seq(minutesWord("en"), words("to"), hour12.en), ([m, , h]) => core(hourBefore(h), 60 - m, true)),
  // half HOUR (British: "half seven" is 7:30)
  map(seq(words("half"), hour12.en), ([, h]) => core(h, 30, true)),
  // HOUR o'clock
  map(seq(hour12.en, oneOf("o'clock", "oclock")), ([h]) => core(h, 0, true)),
  // HOUR hundred: the 24-hour clock ("ten hundred", "nineteen hundred", "oh nine hundred")
  map(seq(alt(wordNumber("en", 10, 23), ohDigit, map(words("zero"), () => 0)), words("hundred")), ([h]) => core(h, 0, false)),
  // HOUR MINUTES: "seven thirty", "nineteen forty five", "oh seven fifteen", "seven oh five"
  map(seq(alt(map(wordNumber("en", 1, 23), (h) => ({ h, exact: h > 12 })), map(ohDigit, (h) => ({ h, exact: true })), map(words("zero"), () => ({ h: 0, exact: true }))),
    alt(wordNumber("en", 10, 59), ohDigit)), ([h, m]) => core(h.h, m, !h.exact)),
  // a bare hour
  map(wordNumber("en", 0, 23), (h) => core(h, 0, h >= 1 && h <= 12, true)),
  map(digitHour(0, 23, true), (h) => core(h.hour, 0, !h.exact, true))
)

const nlMinutesBefore: P<number> = alt(map(words("vijf"), () => 5), map(words("tien"), () => 10), map(words("kwart"), () => 15), minutesWord("nl"))
const nlHour: P<{ hour: number; exact: boolean }> = alt(map(wordNumber("nl", 0, 23), (h) => ({ hour: h, exact: h === 0 || h > 12 })), digitHour(0, 23, true))

const coresNl: P<Core> = alt(
  clockToken,
  map(words("middernacht"), () => core(0, 0, false, false, true)),
  // MINUTES over|voor HOUR
  map(seq(nlMinutesBefore, words("over"), hour12.nl), ([m, , h]) => core(h, m, true)),
  map(seq(nlMinutesBefore, words("voor"), hour12.nl), ([m, , h]) => core(hourBefore(h), 60 - m, true)),
  // vijf|tien over|voor half HOUR: "vijf voor half acht" is 7:25, "tien over half acht" 7:40
  map(seq(alt(map(words("vijf"), () => 5), map(words("tien"), () => 10)), oneOf("over", "voor"), words("half"), hour12.nl),
    ([m, dir, , h]) => core(hourBefore(h), dir === "over" ? 30 + m : 30 - m, true)),
  // half HOUR: "half acht" is 7:30
  map(seq(words("half"), hour12.nl), ([, h]) => core(hourBefore(h), 30, true)),
  // HOUR uur [MINUTES]: "zeven uur", "negentien uur dertig"
  map(seq(nlHour, words("uur"), opt(wordNumber("nl", 1, 59))), ([h, , m]) => core(h.hour, m ?? 0, !h.exact)),
  // "24 uur", "vierentwintig uur": the end of the day (only a date-time reads it, as 00:00 of the next day)
  map(seq(alt(tok((w, t) => (t.kind === "digits" && w === "24" ? 24 : undefined)), wordNumber("nl", 24, 24)), words("uur")), () => core(24, 0, false)),
  // a bare hour
  map(nlHour, (h) => core(h.hour, 0, !h.exact, true))
)

const periodsEn: P<Period> = alt(
  map(words("am"), () => "am" as const), map(words("pm"), () => "pm" as const),
  map(words("in", "the", "morning"), () => "morning" as const), map(words("in", "the", "afternoon"), () => "afternoon" as const),
  map(words("in", "the", "evening"), () => "evening" as const), map(words("at", "night"), () => "night" as const)
)
const nlSPeriods = dict<Period>({ ochtends: "morning", morgens: "morning", middags: "afternoon", avonds: "evening", nachts: "night" })
const nlPeriodNouns = dict<Period>({ ochtend: "morning", middag: "afternoon", avond: "evening", nacht: "night" })
const periodsNl: P<Period> = alt(
  map(seq(words("s"), from(nlSPeriods)), ([, p]) => p),
  map(seq(words("in", "de"), from(nlPeriodNouns)), ([, p]) => p)
)
/** The part of the day said right after a clock time. */
export const periodAfterTime: Record<Language, P<Period>> = { en: periodsEn, nl: periodsNl }

/** Every reading of a clock time, with the part of the day said right after it. A bare number has none. */
export const timeOfDay: Record<Language, P<TimeMatch>> = {
  en: alt(coresEn, map(seq(coresEn, periodsEn), ([c, period]) => (c.bare ? { ...c, bare: false, period } : { ...c, period }))),
  nl: alt(coresNl, map(seq(coresNl, periodsNl), ([c, period]) => (c.bare ? { ...c, bare: false, period } : { ...c, period })))
}

// ---- settling the hour -----------------------------------------------------------------------------------------------------------

/** The 24-hour hour of an open reading (1–12) that a part of the day settles, or `undefined` when they do not fit. */
const settle = (hour: number, period: Period): number | undefined => {
  switch (period) {
    case "am": return hour === 12 ? 0 : hour
    case "pm": return hour === 12 ? 12 : hour + 12
    case "morning": return hour === 12 ? undefined : hour
    case "afternoon": return hour === 12 ? 12 : hour + 12
    case "evening": return hour === 12 ? undefined : hour + 12
    case "night": return hour === 12 ? 0 : hour >= 6 ? hour + 12 : hour
  }
}

/** The 24-hour hours a part of the day covers: a settled hour said with one must be inside it ("07:00 in the evening" is not read). */
export const periodHours = (period: Period, hour: number): boolean => {
  switch (period) {
    case "am": return hour <= 11
    case "pm": return hour >= 12
    case "morning": return hour <= 11
    case "afternoon": return hour >= 12 && hour <= 18
    case "evening": return hour >= 17 && hour <= 23
    case "night": return hour >= 18 || hour <= 5
  }
}

export interface Resolved {
  readonly time: TimeOfDay
  /** The band left no later reading today; the earliest one is meant for tomorrow. */
  readonly nextDay: boolean
  /** "24:00": 00:00 of the next day. */
  readonly carry: boolean
}

/**
 * Settle the hour: a settled hour stays (a part of the day said with it must agree: "07:00 am" yes, "07:00 pm" no); an open one with a
 * part of the day takes it; an open one without takes the readings inside the band, the next after `afterMinutes` (else the
 * earliest), `guessed`. "24:00" is 00:00 with `carry` and takes no part of the day.
 */
export const resolveTime = (m: TimeMatch, band: { from: number; to: number }, afterMinutes?: number): Resolved | undefined => {
  if (m.hour === 24) return m.minute === 0 && m.period === undefined ? { time: { hour: 0, minute: 0, guessed: false, alternatives: [] }, nextDay: false, carry: true } : undefined
  if (!m.open) {
    if (m.period !== undefined && !periodHours(m.period, m.hour)) return undefined
    return { time: { hour: m.hour, minute: m.minute, guessed: false, alternatives: [] }, nextDay: false, carry: false }
  }
  if (m.period !== undefined) {
    const hour = settle(m.hour, m.period)
    if (hour === undefined || !periodHours(m.period, hour)) return undefined
    return { time: { hour, minute: m.minute, guessed: false, alternatives: [] }, nextDay: false, carry: false }
  }
  const readings = [m.hour === 12 ? 0 : m.hour, m.hour === 12 ? 12 : m.hour + 12].map((hour) => ({ hour, minute: m.minute }))
  const inBand = readings.filter((c) => c.hour * 60 + c.minute >= band.from && c.hour * 60 + c.minute <= band.to)
  if (inBand.length === 0) return undefined
  let chosen = inBand[0]!
  let nextDay = false
  if (afterMinutes !== undefined) {
    const later = inBand.find((c) => c.hour * 60 + c.minute > afterMinutes)
    if (later !== undefined) chosen = later
    else nextDay = true
  }
  return { time: { ...chosen, guessed: true, alternatives: inBand.filter((c) => c !== chosen) }, nextDay, carry: false }
}

/**
 * A phrase that is only a time of day (README, "Time of day"): `["at" | "om"] TIME [PART OF THE DAY]`. English "half seven" is 7:30,
 * Dutch "half zeven" 6:30. Without a part of the day the reading inside the band wins and `guessed` is true; `ambiguous` only when
 * the band holds none. "24:00" is refused here (a time of day cannot say "the next day"). Never throws.
 */
export const parseTimeOfDay: (text: string, language: Language, options?: TimeOptions) => Parsed<TimeOfDay> = guarded((text: string, language: Language, options?: TimeOptions): Parsed<TimeOfDay> => {
  if (!isText(text) || !isLanguage(language) || !isOptions(options)) return notUnderstood
  const band = bandOf(options)
  const after = options?.afterMinutes
  if (band === undefined || (after !== undefined && !(Number.isInteger(after) && after >= 0 && after <= 1439))) return notUnderstood
  const toks = tokenize(text)
  if (toks === undefined || toks.length === 0) return notUnderstood
  const input: Input = { text, toks, norms: toks.map((t) => t.norm) }
  const phrase = map(seq(opt(oneOf(language === "en" ? "at" : "om")), timeOfDay[language]), ([, m]) => m)
  const matches = whole(phrase, input).filter((m) => m.hour !== 24)
  // `said` is the time without its lead word ("half past seven" in "at half past seven"); no time starts with "at" / "om".
  const said = sliceText(text, toks, toks[0]!.norm === (language === "en" ? "at" : "om") ? 1 : 0, toks.length)
  const results: Array<TimeOfDay> = []
  let open: TimeMatch | undefined
  for (const m of matches) {
    const r = resolveTime(m, band, after)
    if (r !== undefined) results.push(r.time)
    else if (m.open && m.period === undefined) open = m
  }
  const distinct = [...new Map(results.map((t) => [`${t.hour}:${t.minute}`, t])).values()]
  if (distinct.length === 1) return ok(distinct[0]!, said)
  if (distinct.length > 1) return ambiguous(distinct, said, "The words read as more than one time")
  if (open !== undefined) {
    const both = [open.hour === 12 ? 0 : open.hour, open.hour === 12 ? 12 : open.hour + 12].map((hour) => ({ hour, minute: open!.minute, guessed: true, alternatives: [] }))
    return ambiguous(both, said, "No part of the day was said and neither reading falls inside the band")
  }
  return notUnderstood
}, notUnderstood)
