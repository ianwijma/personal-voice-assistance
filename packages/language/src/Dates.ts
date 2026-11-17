import { numericSpans, parseDuration } from "@pva/core"
import { dicts } from "./Dict.ts"
import { numbersWhole, readAmount, readNumber, type CharRange } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type ClockTime, type Language, type LocalDate, type Parsed } from "./Result.ts"
import { matchTimes, periodAt, periodHours, resolveTime, type Period, type TimeMatch, type TimeOfDay, type TimeOptions } from "./Time.ts"
import { onlyWords, tokenize, type Tok } from "./Tokens.ts"
import { monthOf, readOrdinal, weekdayOf } from "./Words.ts"
import { addDays, addMonths, daysInMonth, isoWeekday, localParts, normalizeTimeZone, sameDate, zonedInstants } from "./Zoned.ts"

export interface DateOptions extends Omit<TimeOptions, "afterMinutes"> {
  /** The moment "now" means: epoch milliseconds or a Date. */
  readonly now: number | Date
  /** IANA zone the words are about, e.g. "Europe/Amsterdam". An unknown zone makes every answer `not-understood`. */
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

/** Spoken years: four digits in this range ("3 March 2027"). */
export const minSpokenYear = 1900
export const maxSpokenYear = 2199

interface Atom {
  readonly from: number
  readonly next: number
  readonly dates: ReadonlyArray<LocalDate>
  /** A part of the day said with the day ("tonight", "Friday night", "morgenavond"). */
  readonly period?: Period
  /** Moments relative to now ("in two hours"). */
  readonly offsetMs?: number
  readonly reason?: string
  /** A weekday or a calendar date, which "on" / "op" may lead ("on Friday"; not "on tomorrow"). */
  readonly leadable?: boolean
}
/** A date expression that was recognised but cannot be read as said ("29 February 2027", "Tuesday 3 March 2027"). */
const invalid = "invalid" as const
type AtomRead = Atom | typeof invalid | undefined

const barePeriods = dicts<Language, Period>({
  en: { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" },
  nl: { ochtend: "morning", middag: "afternoon", avond: "evening", nacht: "night" }
})
const dayWords = dicts<Language, { offset: number; period?: Period }>({
  en: {
    today: { offset: 0 }, tonight: { offset: 0, period: "night" }, tomorrow: { offset: 1 }, yesterday: { offset: -1 }
  },
  nl: {
    vandaag: { offset: 0 }, vanavond: { offset: 0, period: "evening" }, vanochtend: { offset: 0, period: "morning" }, vanmorgen: { offset: 0, period: "morning" },
    vanmiddag: { offset: 0, period: "afternoon" }, vannacht: { offset: 0, period: "night" }, morgen: { offset: 1 }, overmorgen: { offset: 2 }, gisteren: { offset: -1 },
    eergisteren: { offset: -2 },
    morgenochtend: { offset: 1, period: "morning" }, morgenvroeg: { offset: 1, period: "morning" }, morgenmiddag: { offset: 1, period: "afternoon" },
    morgenavond: { offset: 1, period: "evening" }, morgennacht: { offset: 1, period: "night" }
  }
})
const dateUnits = dicts<Language, "day" | "week" | "month" | "year">({
  en: { day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year", fortnight: "week", fortnights: "week" },
  nl: { dag: "day", dagen: "day", week: "week", weken: "week", maand: "month", maanden: "month", jaar: "year", jaren: "year" }
})
/** Words of a clock duration ("two hours and thirty minutes"), read by core's duration grammar (`parseDuration`). */
const clockUnitWords: ReadonlySet<string> = new Set([
  "hour", "hours", "hr", "hrs", "minute", "minutes", "min", "mins", "second", "seconds", "sec", "secs",
  "uur", "uren", "minuut", "minuten", "seconde", "seconden", "kwartier"
])
/** Dutch weekday and part of the day in one word: "vrijdagavond", "maandagochtend", "zaterdagnacht". */
const nlCompoundPeriods = dicts<Language, Period>({ en: {}, nl: { ochtend: "morning", morgen: "morning", middag: "afternoon", avond: "evening", nacht: "night" } })

const lastDay = (year: number, month: number, day: number): LocalDate => ({ year, month, day: Math.min(day, daysInMonth(year, month)) })

/** The next date at or after `today` that is day `day` of month `month` (any month if undefined), in `year` if given. */
const nextDayOfMonth = (today: LocalDate, day: number, month?: number, year?: number): LocalDate | undefined => {
  if (day < 1 || day > 31) return undefined
  if (year !== undefined) {
    const m = month ?? today.month
    return day <= daysInMonth(year, m) ? { year, month: m, day } : undefined
  }
  const key = (d: LocalDate) => d.year * 372 + d.month * 31 + d.day
  for (let k = 0; k < 100; k++) {
    const target = month === undefined ? addMonths(today, k) : { year: today.year + k, month }
    if (day > daysInMonth(target.year, target.month)) continue
    const candidate = { ...target, day }
    if (key(candidate) >= key(today)) return candidate
  }
  return undefined
}

const modifierWords = dicts<Language, "this" | "next">({
  en: { this: "this", coming: "this", upcoming: "this", next: "next" },
  nl: { deze: "this", komende: "this", aanstaande: "this", aankomende: "this", volgende: "next" }
})

interface Ctx {
  readonly text: string
  readonly toks: ReadonlyArray<Tok>
  readonly norms: ReadonlyArray<string>
  readonly language: Language
  readonly today: LocalDate
  readonly spans: ReadonlyArray<{ readonly start: number; readonly end: number }>
}

/** A year: four digits, `minSpokenYear`–`maxSpokenYear`; another four-digit number where a year goes is `invalid`. */
const readYear = (c: Ctx, at: number): { value: number; next: number } | typeof invalid | undefined => {
  const t = c.norms[at]
  if (t === undefined || !/^\d{4}$/.test(t)) return undefined
  const v = Number(t)
  return v >= minSpokenYear && v <= maxSpokenYear ? { value: v, next: at + 1 } : invalid
}
const readDay = (c: Ctx, at: number): { value: number; next: number; ordinal: boolean } | undefined => {
  const ord = readOrdinal(c.norms, at, c.language)
  if (ord !== undefined) return { ...ord, ordinal: true }
  const n = readNumber(c.toks, at, c.language)
  if (n !== undefined && Number.isInteger(n.value) && n.value >= 1 && n.value <= 31) return { value: n.value, next: n.next, ordinal: false }
  return undefined
}

/** "3 March [2027]", "the 3rd of March", "March 3rd [2027]", "March the third", "de derde maart", the bare ordinal "the 3rd" / "de 3e". */
const readCalendarDate = (c: Ctx, i: number): { date: LocalDate; next: number } | typeof invalid | undefined => {
  const { norms, language, today } = c
  const article = language === "en" ? "the" : "de"
  let s = i
  if (norms[s] === article) s++
  const d = readDay(c, s)
  if (d !== undefined) {
    let m = d.next
    if ((language === "en" && norms[m] === "of") || (language === "nl" && norms[m] === "van")) m++
    const month = monthOf(norms[m] ?? "", language)
    if (month !== undefined) {
      const y = readYear(c, m + 1)
      if (y === invalid) return invalid
      const date = nextDayOfMonth(today, d.value, month, y?.value)
      return date === undefined ? invalid : { date, next: y?.next ?? m + 1 }
    }
    // bare ordinal: "the 3rd" / "de derde" / "de 3e" (a bare "3" is not a date)
    if (d.ordinal && (s > i || /^\d/.test(norms[s]!))) {
      const date = nextDayOfMonth(today, d.value)
      if (date === undefined) return invalid
      // "the first of the month", "de eerste van de maand": the same date, all of it read.
      const ofMonth = language === "en" ? norms[d.next] === "of" && norms[d.next + 1] === "the" && norms[d.next + 2] === "month"
        : norms[d.next] === "van" && norms[d.next + 1] === "de" && norms[d.next + 2] === "maand"
      return { date, next: ofMonth ? d.next + 3 : d.next }
    }
  }
  // MONTH [the] DAY [YEAR]
  const month = monthOf(norms[i] ?? "", language)
  if (month !== undefined) {
    let at = i + 1
    if (norms[at] === article) at++
    const dd = readDay(c, at)
    if (dd !== undefined) {
      const y = readYear(c, dd.next)
      if (y === invalid) return invalid
      const date = nextDayOfMonth(today, dd.value, month, y?.value)
      return date === undefined ? invalid : { date, next: y?.next ?? dd.next }
    }
  }
  return undefined
}

/** A weekday said next to a date must be that date's weekday ("tomorrow, Thursday"); otherwise the phrase contradicts itself. */
const weekdayAfter = (c: Ctx, at: number, date: LocalDate): number | typeof invalid => {
  const wd = weekdayOf(c.norms[at] ?? "", c.language)
  if (wd === undefined) return at
  return wd === isoWeekday(date) ? at + 1 : invalid
}

/** "in two days", "over twee weken", "in two hours and thirty minutes", "in an hour and a half", "over anderhalf uur". */
const relativeAtom = (c: Ctx, i: number): AtomRead => {
  const { toks, norms, language, today } = c
  const first = toks[i + 1]
  if (first === undefined) return undefined
  const span = c.spans.find((s) => s.end > first.start && s.start < first.end)
  if (span !== undefined) {
    // A sign or a decimal mark written before the number ("in -2 days", "in .5 hours") belongs to it.
    if (span.start < first.start) return invalid
    let k = i + 1
    while (k < toks.length && toks[k]!.start < span.end) k++
    const words = norms.slice(i + 1, k)
    if (words.some((w) => clockUnitWords.has(w))) {
      // A clock duration: core's grammar reads the whole expression ("two hours and thirty minutes") or nothing.
      const ms = parseDuration(c.text.slice(span.start, span.end))
      return ms === undefined || !(ms > 0) ? invalid : { from: i, next: k, dates: [], offsetMs: ms }
    }
    const unit = dateUnits[language][norms[k] ?? ""]
    if (unit === undefined) return undefined
    const amount = readAmount(toks, i + 1, language, false)
    if (amount === undefined || amount.next !== k || !Number.isInteger(amount.value) || amount.value < 1 || amount.value > 999) return invalid
    return calendarOffset(i, k + 1, amount.value, norms[k]!, unit, today)
  }
  // No numeric expression: "in a week", "over een maand", "in a fortnight".
  const a = norms[i + 1]
  const article = language === "en" ? a === "a" || a === "an" : a === "een"
  if (!article) return undefined
  const unit = dateUnits[language][norms[i + 2] ?? ""]
  return unit === undefined ? undefined : calendarOffset(i, i + 3, 1, norms[i + 2]!, unit, today)
}

const calendarOffset = (from: number, next: number, amount: number, word: string, unit: "day" | "week" | "month" | "year", today: LocalDate): Atom => {
  const n = (word.startsWith("fortnight") ? 2 : 1) * amount
  const date = unit === "day" ? addDays(today, n) : unit === "week" ? addDays(today, 7 * n)
    : unit === "month" ? lastDay(addMonths(today, n).year, addMonths(today, n).month, today.day) : lastDay(today.year + n, today.month, today.day)
  return { from, next, dates: [date] }
}

/** A part of the day right after a day: "tomorrow evening", "Friday night", "Friday in the evening", "vrijdag 's avonds". */
const dayPeriod = (c: Ctx, at: number): { period: Period; next: number } | undefined => {
  const bare = barePeriods[c.language][c.norms[at] ?? ""]
  if (bare !== undefined) return { period: bare, next: at + 1 }
  const p = periodAt(c.toks, at, c.language)
  return p === undefined || p.period === "am" || p.period === "pm" ? undefined : p
}

const withPeriod = (c: Ctx, a: Atom): Atom | typeof invalid => {
  if (a.offsetMs !== undefined) return a
  const p = dayPeriod(c, a.next)
  if (p === undefined) return a
  if (a.period !== undefined) return invalid // "tonight night", "vrijdagavond avond"
  return { ...a, next: p.next, period: p.period }
}

const dateAtom = (c: Ctx, i: number): AtomRead => {
  const { norms, language, today } = c
  const w = norms[i]!
  // today, tomorrow, …
  const day = dayWords[language][w]
  if (day !== undefined) {
    const date = addDays(today, day.offset)
    const after = weekdayAfter(c, i + 1, date)
    if (after === invalid) return invalid
    return { from: i, next: after, dates: [date], ...(day.period !== undefined ? { period: day.period } : {}) }
  }
  if (language === "en" && w === "the" && norms[i + 1] === "day" && norms[i + 2] === "after" && norms[i + 3] === "tomorrow") return { from: i, next: i + 4, dates: [addDays(today, 2)] }
  if (language === "en" && w === "day" && norms[i + 1] === "after" && norms[i + 2] === "tomorrow") return { from: i, next: i + 3, dates: [addDays(today, 2)] }
  if (language === "en" && w === "this" && barePeriods.en[norms[i + 1] ?? ""] !== undefined) return { from: i, next: i + 2, dates: [today], period: barePeriods.en[norms[i + 1]!]! }
  // in N days / over N weken / in two hours and thirty minutes
  if (w === "in" || (language === "nl" && w === "over")) {
    const r = relativeAtom(c, i)
    if (r !== undefined) return r
  }
  const nextWeekWord = (k: number): boolean => (language === "en" ? norms[k] === "next" && norms[k + 1] === "week" : norms[k] === "volgende" && norms[k + 1] === "week")
  // weekday: [this|next|coming] WEEKDAY [next week | DATE], next week WEEKDAY
  let k = i
  let mod: "this" | "next" | undefined
  if (language === "en" && w === "this" && norms[i + 1] === "coming") { mod = "this"; k = i + 2 }
  else if (modifierWords[language][w] !== undefined) { mod = modifierWords[language][w]; k++ }
  if (nextWeekWord(i)) { mod = "next"; k = i + 2 }
  let wd = weekdayOf(norms[k] ?? "", language)
  let compound: Period | undefined
  if (wd === undefined && language === "nl") {
    // "vrijdagavond": a weekday and a part of the day in one word.
    for (const name of ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]) {
      const rest = (norms[k] ?? "").startsWith(name) ? norms[k]!.slice(name.length) : undefined
      const p = rest === undefined ? undefined : nlCompoundPeriods.nl[rest]
      if (p !== undefined) { wd = weekdayOf(name, "nl"); compound = p }
    }
  }
  if (wd !== undefined) {
    const todayWd = isoWeekday(today)
    const ahead = (wd - todayWd + 7) % 7
    const next = k + 1
    const period = compound !== undefined ? { period: compound } : {}
    // "Wednesday 3 March 2027", "Friday the 20th": the date decides, and the weekday must be its weekday.
    const explicit = compound === undefined ? readCalendarDate(c, next) : undefined
    if (explicit === invalid) return invalid
    if (explicit !== undefined) return mod === undefined && isoWeekday(explicit.date) === wd ? { from: i, next: explicit.next, dates: [explicit.date], leadable: true } : invalid
    const weekAfter = nextWeekWord(next) || (language === "nl" && norms[next] === "over" && norms[next + 1] === "een" && norms[next + 2] === "week")
    const mondayThis = addDays(today, -(todayWd - 1))
    if (weekAfter) {
      if (mod !== undefined) return invalid // "next Friday next week"
      return { from: i, next: next + (language === "nl" && norms[next] === "over" ? 3 : 2), dates: [addDays(mondayThis, 7 + wd - 1)], leadable: true, ...period }
    }
    if (mod === "next") {
      if (nextWeekWord(i)) return { from: i, next, dates: [addDays(mondayThis, 7 + wd - 1)], ...period }
      const first = ahead === 0 ? 7 : ahead
      const dates = ahead === 0 ? [addDays(today, 7)] : [addDays(today, first), addDays(today, first + 7)]
      return { from: i, next, dates, reason: `"next ${norms[k]}" can mean the coming one or the one after`, ...period }
    }
    if (mod === "this") return { from: i, next, dates: [addDays(today, ahead)], leadable: mod === undefined, ...period }
    return { from: i, next, dates: [addDays(today, ahead === 0 ? 7 : ahead)], leadable: true, ...period }
  }
  if (mod !== undefined) return undefined
  // 3 March [2027], the 3rd of March, March 3rd, the 3rd, de derde, 3 maart
  const date = readCalendarDate(c, i)
  if (date === invalid) return invalid
  if (date !== undefined) {
    const after = weekdayAfter(c, date.next, date.date)
    if (after === invalid) return invalid
    return { from: i, next: after, dates: [date.date], leadable: true }
  }
  return undefined
}

/** The word that leads a date ("on Friday", "op vrijdag") and the one that leads a time ("at five", "om vijf uur"). */
const dateLeads = dicts<Language, true>({ en: { on: true }, nl: { op: true } })
const timeLeads = dicts<Language, true>({ en: { at: true }, nl: { om: true } })

interface TimePart {
  readonly from: number
  readonly match: TimeMatch
}
interface Reading {
  readonly atom?: Atom
  readonly time?: TimePart
}

/**
 * The phrase as a sequence of at most one date and at most one time, in either order, each with its lead word, and nothing else:
 * every reading that consumes every token. A bare number ("seven") is a time only after "at" / "om" or when it is the whole phrase.
 */
const readings = (c: Ctx, pos: number, so: Reading): Array<Reading> => {
  const { toks, norms, language } = c
  if (pos === toks.length) return so.atom === undefined && so.time === undefined ? [] : [so]
  const out: Array<Reading> = []
  if (so.atom === undefined) {
    const lead = dateLeads[language][norms[pos]!] !== undefined ? 1 : 0
    const a = toks[pos + lead] === undefined ? undefined : dateAtom(c, pos + lead)
    if (a === invalid) return [{ atom: { from: pos, next: pos, dates: [], reason: invalid } }]
    if (a !== undefined && (lead === 0 || a.leadable === true)) {
      const full = withPeriod(c, a)
      if (full === invalid) return [{ atom: { from: pos, next: pos, dates: [], reason: invalid } }]
      out.push(...readings(c, full.next, { ...so, atom: { ...full, from: pos } }))
    }
  }
  if (so.time === undefined) {
    const lead = timeLeads[language][norms[pos]!] !== undefined ? 1 : 0
    for (const m of matchTimes(toks, pos + lead, language, true)) {
      // A lone number is a time after "at" / "om", or when nothing else is said.
      if (m.bare && lead === 0 && !(pos === 0 && m.next === toks.length)) continue
      out.push(...readings(c, m.next, { ...so, time: { from: pos, match: m } }))
      if (out.length > 0) break
    }
  }
  return out
}

/**
 * A date, a moment or both: "today", "tomorrow", "tonight", "on Friday", "the 3rd", "3 March", "Wednesday 3 March 2027",
 * "in two days", "tomorrow at five", "at five tomorrow", "in two hours and thirty minutes", "over twee weken", "vrijdag om half acht",
 * "vrijdagavond om acht uur". The text is the time phrase alone — the caller passes the words that say when (the language model
 * fills a tool parameter with them; a phrase command gets them from a typed slot), not a sentence to search: every word must be
 * read by the grammar (README), so "remind me tomorrow", "tomorrow not at five", "before Friday", "tomorrow at 5 UTC", "tomorrow or
 * Friday", "last Friday" and "in 2 weeks and 3 days" are `not-understood`. "next Friday" is `ambiguous` (the coming one and the one
 * after), and so is a date with the word "midnight" (the start or the end of that day). A time without am/pm is settled by the band
 * and the clock (see `parseTimeOfDay`); `guessed` says so. "Friday night at 1" is Saturday 01:00; "24:00" is 00:00 of the next day.
 * A time without a date is the next one after now, never now or before, including in the hour the clocks go back.
 */
export const parseDateTime = (text: string, language: Language, options: DateOptions): Parsed<DateTimeValue> => {
  const zone = normalizeTimeZone(options.timeZone)
  const now = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : Number.NaN
  if (zone === undefined || !Number.isFinite(now) || typeof text !== "string") return notUnderstood
  const toks = tokenize(text)
  if (toks.length === 0 || !onlyWords(text, toks)) return notUnderstood
  const nowParts = localParts(now, zone)
  const today: LocalDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day }
  const c: Ctx = { text, toks, norms: toks.map((t) => t.norm), language, today, spans: numericSpans(text) }
  const found = readings(c, 0, {})[0]
  if (found === undefined || found.atom?.reason === invalid) return notUnderstood
  const { atom, time } = found
  if (atom?.offsetMs !== undefined && time !== undefined) return notUnderstood // "in two hours at five"
  const ranges: Array<CharRange> = []
  if (atom !== undefined) ranges.push({ start: toks[atom.from]!.start, end: toks[atom.next - 1]!.end })
  if (time !== undefined) ranges.push({ start: toks[time.from]!.start, end: toks[time.match.next - 1]!.end })
  if (!numbersWhole(text, toks, ranges)) return notUnderstood
  const said = text.slice(toks[0]!.start, toks[toks.length - 1]!.end)
  const band = options.band !== undefined ? { band: options.band } : {}

  type Built = { readonly kind: "one"; readonly value: DateTimeValue } | { readonly kind: "two"; readonly values: ReadonlyArray<DateTimeValue>; readonly reason: string } | undefined
  const value = (d: LocalDate, t: TimeOfDay | undefined, instant: number | undefined, partOfDay?: Period): DateTimeValue => ({
    date: d, weekday: isoWeekday(d), ...(t !== undefined ? { time: t } : {}), ...(instant !== undefined ? { instant } : {}),
    ...(t === undefined && partOfDay !== undefined ? { partOfDay } : {}),
    inPast: instant !== undefined ? instant <= now : (d.year * 372 + d.month * 31 + d.day < today.year * 372 + today.month * 31 + today.day)
  })
  const build = (date: LocalDate | undefined): Built => {
    // "in two hours": a moment from now
    if (atom?.offsetMs !== undefined) {
      const instant = now + atom.offsetMs
      const p = localParts(instant, zone)
      const d = { year: p.year, month: p.month, day: p.day }
      return { kind: "one", value: { ...value(d, { hour: p.hour, minute: p.minute, guessed: false, alternatives: [] }, instant), inPast: false } }
    }
    if (time === undefined) return { kind: "one", value: value(date!, undefined, undefined, atom?.period) }
    const m = time.match
    if (m.period !== undefined && atom?.period !== undefined && m.period !== atom.period && !(m.period === "am" || m.period === "pm")) return undefined
    const open: TimeMatch = m.period === undefined && atom?.period !== undefined ? { ...m, period: atom.period } : m
    if (m.hour === 24 && atom?.period !== undefined) return undefined
    const settled = resolveTime({ ...open }, band)
    if (settled === undefined) return undefined
    // "tomorrow morning at 7 pm", "tonight at 9 am": the part of the day and the clock disagree.
    if (atom?.period !== undefined && !settled.carry && !periodHours(atom.period, settled.time.hour)) return undefined
    // The readings to choose from: the one said, or every one inside the band.
    const readingsOf: Array<ClockTime> = settled.time.guessed ? [settled.time, ...settled.time.alternatives].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)) : [settled.time]
    const asTime = (r: ClockTime): TimeOfDay => ({ hour: r.hour, minute: r.minute, guessed: settled.time.guessed, alternatives: readingsOf.filter((x) => x !== r).map((x) => ({ hour: x.hour, minute: x.minute })) })
    const at = (d: LocalDate, r: ClockTime) => zonedInstants({ ...d, hour: r.hour, minute: r.minute }, zone)
    if (date === undefined) {
      // A bare time: the next moment after now it names, over today and the next two days, both readings of a repeated hour included.
      let best: { d: LocalDate; r: ClockTime; instant: number } | undefined
      for (let k = 0; k <= 2; k++) {
        const d = addDays(today, k + (settled.carry ? 1 : 0))
        for (const r of readingsOf) for (const instant of at(d, r)) if (instant > now && (best === undefined || instant < best.instant)) best = { d, r, instant }
      }
      if (best === undefined) return undefined
      return { kind: "one", value: value(best.d, asTime(best.r), best.instant) }
    }
    let day = date
    // "tonight at 2 am", "Friday night at 1", "tomorrow night at midnight": the small hours after that evening. Said in those small
    // hours themselves ("vannacht om drie uur" at 01:00), it is this night.
    const smallHours = !settled.carry && readingsOf.every((r) => r.hour < 6)
    if (atom?.period === "night" && smallHours && !(sameDate(day, today) && nowParts.hour < 6)) day = addDays(day, 1)
    else if (m.midnightWord) {
      // "Friday at midnight": the start of Friday or its end.
      const start = value(day, asTime(readingsOf[0]!), at(day, readingsOf[0]!)[0])
      const end = addDays(day, 1)
      return { kind: "two", values: [start, value(end, asTime(readingsOf[0]!), at(end, readingsOf[0]!)[0])], reason: "\"midnight\" with a day can mean the start of that day or its end" }
    }
    if (settled.carry) day = addDays(day, 1)
    // Today: the next reading after now (and of a repeated hour the reading after now); another day: the earliest reading, the first time.
    if (sameDate(day, today)) {
      for (const r of readingsOf) {
        const later = at(day, r).find((x) => x > now)
        if (later !== undefined) return { kind: "one", value: value(day, asTime(r), later) }
      }
    }
    const r = readingsOf[0]!
    return { kind: "one", value: value(day, asTime(r), at(day, r)[0]) }
  }
  const dates = atom?.dates ?? []
  if (dates.length > 1) {
    const all = dates.map((d) => build(d))
    if (all.some((v) => v?.kind !== "one")) return notUnderstood
    return ambiguous(all.map((v) => (v as { value: DateTimeValue }).value), said, atom?.reason ?? "More than one date fits")
  }
  const built = build(dates[0])
  if (built === undefined) return notUnderstood
  return built.kind === "one" ? ok(built.value, said) : ambiguous(built.values, said, built.reason)
}
