import { dicts } from "./Dict.ts"
import { guarded, isLanguage, isOptions, isText, maxYear, minYear } from "./Domain.ts"
import { duration, type DurationUnit } from "./Durations.ts"
import { alt, from, map, oneOf, opt, seq, tok, whole, words, type Input, type P } from "./Grammar.ts"
import { wholeNumber } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type ClockTime, type Language, type LocalDate, type Parsed } from "./Result.ts"
import { bandOf, periodAfterTime, periodHours, resolveTime, timeOfDay, type Period, type TimeMatch, type TimeOfDay, type TimeOptions } from "./Time.ts"
import { sliceText, tokenize } from "./Tokens.ts"
import { ordinal } from "./Words.ts"
import { addDays, addMonths, daysInMonth, inRange, instantIn, instantInRange, isoWeekday, localParts, normalizeTimeZone, sameDate, zonedInstants } from "./Zoned.ts"

export interface DateOptions extends Omit<TimeOptions, "afterMinutes"> {
  /** The moment "now" means: epoch milliseconds or a Date, whose local date in `timeZone` is in the supported years. */
  readonly now: number | Date
  /** IANA zone the words are about, e.g. "Europe/Amsterdam". An unknown zone or an offset makes every answer `not-understood`. */
  readonly timeZone: string
}

export interface DateTimeValue {
  readonly date: LocalDate
  /** 1 = Monday … 7 = Sunday. */
  readonly weekday: number
  /** Said, or settled from the band (see `TimeOfDay.guessed`). */
  readonly time?: TimeOfDay
  /** The moment, when there is a time; correct across daylight-saving changes. */
  readonly instant?: number
  /** "tonight", "tomorrow morning": a part of the day without a clock time. */
  readonly partOfDay?: Period
  /** The moment (or, without a time, the day) is not after now. */
  readonly inPast: boolean
}

/** A date read from the words, before a time is added. */
type Atom =
  | { readonly kind: "days"; readonly dates: ReadonlyArray<LocalDate>; readonly period?: Period; readonly reason?: string; readonly leadable: boolean }
  | { readonly kind: "offset"; readonly ms: number }

interface Ctx {
  readonly language: Language
  readonly today: LocalDate
}

const dayWords = dicts<Language, { offset: number; period?: Period }>({
  en: { today: { offset: 0 }, tonight: { offset: 0, period: "night" }, tomorrow: { offset: 1 }, yesterday: { offset: -1 } },
  nl: {
    vandaag: { offset: 0 }, vanavond: { offset: 0, period: "evening" }, vanochtend: { offset: 0, period: "morning" }, vanmorgen: { offset: 0, period: "morning" },
    vanmiddag: { offset: 0, period: "afternoon" }, vannacht: { offset: 0, period: "night" }, morgen: { offset: 1 }, overmorgen: { offset: 2 }, gisteren: { offset: -1 },
    eergisteren: { offset: -2 }, morgenochtend: { offset: 1, period: "morning" }, morgenmiddag: { offset: 1, period: "afternoon" },
    morgenavond: { offset: 1, period: "evening" }, morgennacht: { offset: 1, period: "night" }
  }
})
const barePeriods = dicts<Language, Period>({
  en: { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" },
  nl: { ochtend: "morning", middag: "afternoon", avond: "evening", nacht: "night" }
})
const weekdayWords = dicts<Language, number>({
  en: { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 },
  nl: { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7 }
})
const monthWords = dicts<Language, number>({
  en: { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 },
  nl: { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 }
})
const modifierWords = dicts<Language, "this" | "next">({
  en: { this: "this", coming: "this", next: "next" },
  nl: { deze: "this", komende: "this", aanstaande: "this", volgende: "next" }
})
const calendarUnits = dicts<Language, "day" | "week" | "month" | "year">({
  en: { day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year" },
  nl: { dag: "day", dagen: "day", week: "week", weken: "week", maand: "month", maanden: "month", jaar: "year", jaren: "year" }
})
const calendarSingular = dicts<Language, "day" | "week" | "month" | "year">({
  en: { day: "day", week: "week", month: "month", year: "year" },
  nl: { dag: "day", week: "week", maand: "month", jaar: "year" }
})
const clockUnits: ReadonlySet<DurationUnit> = new Set(["hour", "quarter", "minute", "second"])

/** A weekday, or (Dutch) a weekday and a part of the day in one word: "vrijdagavond". */
const weekday = (language: Language): P<{ wd: number; period?: Period }> => alt(
  map(from(weekdayWords[language]), (wd) => ({ wd })),
  tok((w) => {
    if (language !== "nl") return undefined
    for (const [name, wd] of Object.entries(weekdayWords.nl)) {
      if (!w.startsWith(name)) continue
      const period = barePeriods.nl[w.slice(name.length)]
      if (period !== undefined) return { wd: wd!, period }
    }
    return undefined
  })
)

/** A year: four digits in the supported years. */
const year: P<number> = tok((w, t) => (t.kind === "digits" && /^[0-9]{4}$/.test(w) && Number(w) >= minYear && Number(w) <= maxYear ? Number(w) : undefined))
/** A day of the month: an ordinal ("third", "3rd", "derde", "3e") or a number 1–31 ("3", "three", "drie"). */
const dayOfMonth = (language: Language): P<number> => alt(ordinal(language, 1, 31), wholeNumber(language, 1, 31))

/** The next date at or after `today` with this day (and month, if given); in `inYear` when given. */
const nextDate = (today: LocalDate, day: number, month?: number, inYear?: number): LocalDate | undefined => {
  if (inYear !== undefined) {
    const m = month ?? today.month
    return day <= daysInMonth(inYear, m) ? { year: inYear, month: m, day } : undefined
  }
  if (month === undefined) {
    for (let k = 0; k < 13; k++) {
      const t = addMonths(today, k)
      if (day > daysInMonth(t.year, t.month)) continue
      const candidate = { ...t, day }
      if (dayKey(candidate) >= dayKey(today)) return candidate
    }
    return undefined
  }
  for (let y = today.year; y <= today.year + 8; y++) {
    if (day > daysInMonth(y, month)) continue
    const candidate = { year: y, month, day }
    if (dayKey(candidate) >= dayKey(today)) return candidate
  }
  return undefined
}

/** "3 March [2027]", "the 3rd of March", "March 3rd", "March the third", "de derde maart", and the bare "the 3rd" / "de 3e". */
const calendarDate = (c: Ctx): P<LocalDate> => {
  const { language, today } = c
  const the = language === "en" ? "the" : "de"
  const dayMonthYear = language === "en"
    ? alt(
      map(seq(opt(words("the")), dayOfMonth("en"), opt(words("of")), from(monthWords.en), opt(year)), ([, d, , m, y]) => nextDate(today, d, m, y)),
      map(seq(from(monthWords.en), opt(words("the")), dayOfMonth("en"), opt(year)), ([m, , d, y]) => nextDate(today, d, m, y))
    )
    : map(seq(opt(words("de")), dayOfMonth("nl"), from(monthWords.nl), opt(year)), ([, d, m, y]) => nextDate(today, d, m, y))
  const ofTheMonth = language === "en" ? words("of", "the", "month") : words("van", "de", "maand")
  const bareOrdinal = map(seq(words(the), ordinal(language, 1, 31), opt(ofTheMonth)), ([, d]) => nextDate(today, d))
  return alt(dayMonthYear, bareOrdinal)
}

/** [this | next | coming] WEEKDAY [next week], WEEKDAY DATE (the weekday must be the date's). */
const weekdayDate = (c: Ctx): P<Atom> => {
  const { language, today } = c
  const todayWd = isoWeekday(today)
  const mondayThis = addDays(today, -(todayWd - 1))
  const nextWeek = language === "en" ? words("next", "week") : words("volgende", "week")
  const days = (dates: ReadonlyArray<LocalDate>, period: Period | undefined, reason?: string): Atom =>
    ({ kind: "days", dates, leadable: true, ...(period !== undefined ? { period } : {}), ...(reason !== undefined ? { reason } : {}) })
  return alt(
    map(seq(opt(from(modifierWords[language])), weekday(language)), ([mod, w]) => {
      const ahead = (w.wd - todayWd + 7) % 7
      if (mod === "this") return days([addDays(today, ahead)], w.period)
      if (mod === "next") {
        if (ahead === 0) return days([addDays(today, 7)], w.period)
        return days([addDays(today, ahead), addDays(today, ahead + 7)], w.period, "\"next\" with a weekday can mean the coming one or the one after")
      }
      return days([addDays(today, ahead === 0 ? 7 : ahead)], w.period)
    }),
    map(seq(weekday(language), nextWeek), ([w]) => days([addDays(mondayThis, 7 + w.wd - 1)], w.period)),
    map(seq(from(weekdayWords[language]), calendarDate(c)), ([wd, d]) => (isoWeekday(d) === wd ? days([d], undefined) : undefined))
  )
}

/** today, tomorrow, tonight, "this evening", "the day after tomorrow"; vandaag, morgen, overmorgen, vanavond, morgenochtend, … */
const dayWord = (c: Ctx): P<Atom> => {
  const { language, today } = c
  const one = (offset: number, period?: Period): Atom => ({ kind: "days", dates: [addDays(today, offset)], leadable: false, ...(period !== undefined ? { period } : {}) })
  return alt(
    map(from(dayWords[language]), (d) => one(d.offset, d.period)),
    ...(language === "en"
      ? [
        map(seq(words("this"), from(barePeriods.en)), ([, p]): Atom | undefined => (p === "night" ? undefined : one(0, p))),
        map(words("the", "day", "after", "tomorrow"), () => one(2))
      ]
      : [])
  )
}

/** "in two days", "over twee weken", "in a month"; "in two hours and thirty minutes", "over anderhalf uur" (the duration grammar). */
const relative = (c: Ctx): P<Atom> => {
  const { language, today } = c
  const lead = language === "en" ? "in" : "over"
  const calendar = (n: number, unit: "day" | "week" | "month" | "year"): Atom => {
    const date = unit === "day" ? addDays(today, n) : unit === "week" ? addDays(today, 7 * n)
      : unit === "month" ? clampDay(addMonths(today, n), today.day) : clampDay({ year: today.year + n, month: today.month }, today.day)
    return { kind: "days", dates: [date], leadable: false }
  }
  return alt(
    map(seq(words(lead), wholeNumber(language, 1, 999), from(calendarUnits[language])), ([, n, u]) => calendar(n, u)),
    map(seq(words(lead), oneOf(...(language === "en" ? ["a", "an"] : ["een"])), from(calendarSingular[language])), ([, , u]) => calendar(1, u)),
    map(seq(words(lead), duration[language]), ([, d]): Atom | undefined => (d.units.every((u) => clockUnits.has(u)) ? { kind: "offset", ms: d.ms } : undefined))
  )
}
const clampDay = (ym: { year: number; month: number }, day: number): LocalDate => ({ ...ym, day: Math.min(day, daysInMonth(ym.year, ym.month)) })

/** The part of the day right after a day: "tomorrow evening", "Friday night", "Friday in the evening", "vrijdag 's avonds". */
const dayPeriod = (language: Language): P<Period> => alt(
  from(barePeriods[language]),
  map(periodAfterTime[language], (p) => (p === "am" || p === "pm" ? undefined : p))
)

/** A date with its lead word and a part of the day after it. */
const dateExpression = (c: Ctx): P<Atom> => {
  const { language } = c
  const on = language === "en" ? "on" : "op"
  const leadable: P<Atom> = alt(weekdayDate(c), map(calendarDate(c), (d): Atom => ({ kind: "days", dates: [d], leadable: true })))
  const plain: P<Atom> = alt(map(seq(opt(words(on)), leadable), ([, a]) => a), dayWord(c), relative(c))
  return alt(
    plain,
    map(seq(plain, dayPeriod(language)), ([a, p]) => (a.kind === "days" && a.period === undefined ? { ...a, period: p } : undefined))
  )
}

interface TimePart {
  readonly match: TimeMatch
  readonly lead: boolean
}
interface Reading {
  readonly atom?: Atom
  readonly time?: TimePart
}

/** At most one date and at most one time, in either order, and nothing else. */
const phrase = (c: Ctx): P<Reading> => {
  const at = c.language === "en" ? "at" : "om"
  const time: P<TimePart> = alt<TimePart>(
    map(seq(words(at), timeOfDay[c.language]), ([, match]) => ({ match, lead: true })),
    map(timeOfDay[c.language], (match) => ({ match, lead: false }))
  )
  const date = dateExpression(c)
  return alt<Reading>(
    map(date, (atom) => ({ atom })),
    map(time, (t) => ({ time: t })),
    map(seq(date, time), ([atom, t]) => ({ atom, time: t })),
    map(seq(time, date), ([t, atom]) => ({ atom, time: t }))
  )
}

const dayKey = (d: LocalDate): number => d.year * 10_000 + d.month * 100 + d.day

/**
 * A phrase that is only a date, a moment or both (README, "Dates and times"): "today", "tomorrow at five", "on Friday", "the 3rd",
 * "3 March 2027", "in two days", "in two hours and thirty minutes", "over twee weken", "vrijdag om half acht", "vrijdagavond om acht
 * uur". The text is the time phrase alone: every word must be read by the grammar, so "remind me tomorrow", "tomorrow not at five",
 * "before Friday", "tomorrow at 5 UTC", "tomorrow or Friday", "last Friday" and "in 2 weeks and 3 days" are `not-understood`. "next
 * Friday" is `ambiguous` (the coming one and the one after), and so is a date with the word "midnight" (the start or the end of that
 * day), except "tonight at midnight", the end of today. Every date returned is in the supported years. Never throws.
 */
export const parseDateTime: (text: string, language: Language, options: DateOptions) => Parsed<DateTimeValue> = guarded((text: string, language: Language, options: DateOptions): Parsed<DateTimeValue> => {
  if (!isText(text) || !isLanguage(language) || !isOptions(options) || options === undefined) return notUnderstood
  const zone = normalizeTimeZone(options.timeZone)
  const band = bandOf(options)
  if (zone === undefined || band === undefined) return notUnderstood
  const nowIn = instantIn(options.now, zone)
  if (nowIn === undefined) return notUnderstood
  const now = nowIn.instant
  const nowParts = nowIn.parts
  const toks = tokenize(text)
  if (toks === undefined || toks.length === 0) return notUnderstood
  const input: Input = { text, toks, norms: toks.map((t) => t.norm) }
  const today: LocalDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day }
  const c: Ctx = { language, today }
  const said = sliceText(text, toks, 0, toks.length)

  const value = (d: LocalDate, t: TimeOfDay | undefined, instant: number | undefined, partOfDay?: Period): DateTimeValue => ({
    date: d, weekday: isoWeekday(d), ...(t !== undefined ? { time: t } : {}), ...(instant !== undefined ? { instant } : {}),
    ...(t === undefined && partOfDay !== undefined ? { partOfDay } : {}),
    inPast: instant !== undefined ? instant <= now : dayKey(d) < dayKey(today)
  })

  /** The values of one date of a reading; `undefined` when the parts do not fit. */
  const build = (atom: Atom | undefined, date: LocalDate | undefined, time: TimePart | undefined): { values: Array<DateTimeValue>; reason?: string } | undefined => {
    if (atom?.kind === "offset") {
      if (time !== undefined) return undefined // "in two hours at five"
      const instant = now + atom.ms
      if (!instantInRange(instant, zone)) return undefined
      const p = localParts(instant, zone)
      return { values: [{ ...value({ year: p.year, month: p.month, day: p.day }, { hour: p.hour, minute: p.minute, guessed: false, alternatives: [] }, instant), inPast: false }] }
    }
    const dayPart = atom?.kind === "days" ? atom.period : undefined
    if (time === undefined) return { values: [value(date!, undefined, undefined, dayPart)] }
    const m = time.match
    // A lone number is a time after "at" / "om", or when it is the whole phrase.
    if (m.bare && !time.lead && atom !== undefined) return undefined
    if (m.period !== undefined && dayPart !== undefined && m.period !== dayPart && m.period !== "am" && m.period !== "pm") return undefined
    if (m.hour === 24 && dayPart !== undefined) return undefined
    const settled = resolveTime(m.period === undefined && dayPart !== undefined ? { ...m, period: dayPart } : m, band)
    if (settled === undefined) return undefined
    // "tomorrow morning at 7 pm", "tonight at 9 am": the part of the day and the clock disagree.
    if (dayPart !== undefined && !settled.carry && !periodHours(dayPart, settled.time.hour)) return undefined
    const readingsOf: Array<ClockTime> = settled.time.guessed ? [settled.time, ...settled.time.alternatives].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)) : [settled.time]
    const asTime = (r: ClockTime): TimeOfDay => ({ hour: r.hour, minute: r.minute, guessed: settled.time.guessed, alternatives: readingsOf.filter((x) => x !== r).map((x) => ({ hour: x.hour, minute: x.minute })) })
    const at = (d: LocalDate, r: ClockTime) => zonedInstants({ ...d, hour: r.hour, minute: r.minute }, zone)
    if (date === undefined) {
      // A time without a date: the next moment after now it names, over today and the next two days, both readings of a repeated hour.
      let best: { d: LocalDate; r: ClockTime; instant: number } | undefined
      for (let k = 0; k <= 2; k++) {
        const d = addDays(today, k + (settled.carry ? 1 : 0))
        if (!inRange(d)) continue
        for (const r of readingsOf) for (const instant of at(d, r)) if (instant > now && (best === undefined || instant < best.instant)) best = { d, r, instant }
      }
      return best === undefined ? undefined : { values: [value(best.d, asTime(best.r), best.instant)] }
    }
    let day = date
    if (dayPart === "night" && m.midnightWord) {
      // "tonight at midnight", "Friday night at midnight": the end of that day, whatever the hour now (finding 13).
      day = addDays(day, 1)
    } else if (dayPart === "night" && !settled.carry && readingsOf.every((r) => r.hour < 6)) {
      // "tonight at 2 am", "Friday night at 1": the small hours after that evening; said in those small hours themselves
      // ("vannacht om drie uur" at 01:00), it is this night.
      if (!(sameDate(day, today) && nowParts.hour < 6)) day = addDays(day, 1)
    } else if (m.midnightWord) {
      // "Friday at midnight": the start of Friday or its end.
      const r = readingsOf[0]!
      const end = addDays(day, 1)
      if (!inRange(end)) return undefined
      return { values: [value(day, asTime(r), at(day, r)[0]), value(end, asTime(r), at(end, r)[0])], reason: "\"midnight\" with a day can mean the start of that day or its end" }
    }
    if (settled.carry) day = addDays(day, 1)
    if (!inRange(day)) return undefined
    // Today: the next reading after now (of a repeated hour, the one after now); another day: the earliest reading, the first time.
    if (sameDate(day, today)) {
      for (const r of readingsOf) {
        const later = at(day, r).find((x) => x > now)
        if (later !== undefined) return { values: [value(day, asTime(r), later)] }
      }
    }
    const r = readingsOf[0]!
    return { values: [value(day, asTime(r), at(day, r)[0])] }
  }

  const results: Array<DateTimeValue> = []
  let reason: string | undefined
  for (const reading of whole(phrase(c), input)) {
    const { atom, time } = reading
    const dates = atom?.kind === "days" ? atom.dates : [undefined]
    if (dates.some((d) => d !== undefined && !inRange(d))) continue
    const built = dates.map((d) => build(atom, d, time))
    if (built.some((b) => b === undefined)) continue
    const values = built.flatMap((b) => b!.values)
    if (values.some((v) => !inRange(v.date) || (v.instant !== undefined && !Number.isFinite(v.instant)))) continue
    reason ??= built.find((b) => b!.reason !== undefined)?.reason ?? (atom?.kind === "days" ? atom.reason : undefined)
    for (const v of values) if (!results.some((x) => JSON.stringify(x) === JSON.stringify(v))) results.push(v)
  }
  if (results.length === 0) return notUnderstood
  if (results.length === 1) return ok(results[0]!, said)
  return ambiguous(results, said, reason ?? "The words read as more than one moment")
}, notUnderstood)
