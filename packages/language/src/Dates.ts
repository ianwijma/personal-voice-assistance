import { numericSpans, parseDuration } from "@pva/core"
import { dict, dicts } from "./Dict.ts"
import { numbersWhole, readAmount, readNumber, type CharRange } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type Language, type LocalDate, type Parsed } from "./Result.ts"
import { matchTime, periodAt, periodHours, resolveTime, type Period, type TimeOfDay, type TimeOptions } from "./Time.ts"
import { tokenize, type Tok } from "./Tokens.ts"
import { monthOf, readOrdinal, weekdayOf } from "./Words.ts"
import { addDays, addMonths, daysInMonth, isoWeekday, localParts, normalizeTimeZone, sameDate, zonedToInstant } from "./Zoned.ts"

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
  /** The moment is not after now. */
  readonly inPast: boolean
}

export interface DateTimeParsed extends DateTimeValue {
  /** Characters of the text that were read, `[start, end)`, so a caller can cut the title out of "remind me to call mum tomorrow at five". */
  readonly start: number
  readonly end: number
}

interface Atom {
  readonly from: number
  readonly next: number
  readonly dates: ReadonlyArray<LocalDate>
  readonly period?: Period
  /** Moments relative to now ("in two hours"). */
  readonly offsetMs?: number
  readonly reason?: string
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
  readonly spans: ReadonlyArray<CharRange>
}

const readYear = (c: Ctx, at: number): { value: number; next: number } | undefined => {
  const t = c.norms[at]
  return t !== undefined && /^(19|20)\d{2}$/.test(t) ? { value: Number(t), next: at + 1 } : undefined
}
const readDay = (c: Ctx, at: number): { value: number; next: number } | undefined => {
  const ord = readOrdinal(c.norms, at, c.language)
  if (ord !== undefined) return ord
  const n = readNumber(c.toks, at, c.language)
  if (n !== undefined && Number.isInteger(n.value) && n.value >= 1 && n.value <= 31) return { value: n.value, next: n.next }
  return undefined
}

/** "3 March [2027]", "the 3rd of March", "March 3rd [2027]", "March the third", "de derde maart", and the bare ordinal "the 3rd" / "de 3e". */
const readCalendarDate = (c: Ctx, i: number): { date: LocalDate; next: number } | typeof invalid | undefined => {
  const { norms, language, today } = c
  const article = language === "en" ? "the" : "de"
  let s = i
  if (norms[s] === article) s++
  const d = readDay(c, s)
  if (d !== undefined) {
    let m = d.next
    if (norms[m] === "of" || (language === "nl" && norms[m] === "van")) m++
    const month = monthOf(norms[m] ?? "", language)
    if (month !== undefined) {
      const y = readYear(c, m + 1)
      const date = nextDayOfMonth(today, d.value, month, y?.value)
      return date === undefined ? invalid : { date, next: y?.next ?? m + 1 }
    }
    // bare ordinal: "the 3rd" / "de derde" / "de 3e" (a bare "3" is not a date)
    if (readOrdinal(norms, s, language) !== undefined && (s > i || /^\d/.test(norms[s]!))) {
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
      const date = nextDayOfMonth(today, dd.value, month, y?.value)
      return date === undefined ? invalid : { date, next: y?.next ?? dd.next }
    }
  }
  return undefined
}

/** A weekday said next to a date must be that date's weekday ("Wednesday 3 March 2027"); otherwise the phrase contradicts itself. */
const weekdayAfter = (c: Ctx, at: number, date: LocalDate): number | typeof invalid => {
  let k = at
  if (c.norms[k] === "on" || c.norms[k] === "op") k++
  const wd = weekdayOf(c.norms[k] ?? "", c.language)
  if (wd === undefined) return at
  return wd === isoWeekday(date) ? k + 1 : invalid
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
    if (amount === undefined || amount.next !== k || !Number.isInteger(amount.value) || amount.value < 0 || amount.value >= 1000) return invalid
    return calendarOffset(c, i, k + 1, amount.value, norms[k]!, unit, today)
  }
  // No numeric expression: "in a week", "over een maand", "in a fortnight".
  const a = norms[i + 1]
  const article = language === "en" ? a === "a" || a === "an" : a === "een"
  if (!article) return undefined
  const unit = dateUnits[language][norms[i + 2] ?? ""]
  return unit === undefined ? undefined : calendarOffset(c, i, i + 3, 1, norms[i + 2]!, unit, today)
}

const calendarOffset = (_c: Ctx, from: number, next: number, amount: number, word: string, unit: "day" | "week" | "month" | "year", today: LocalDate): Atom => {
  const n = (word.startsWith("fortnight") ? 2 : 1) * amount
  const date = unit === "day" ? addDays(today, n) : unit === "week" ? addDays(today, 7 * n)
    : unit === "month" ? lastDay(addMonths(today, n).year, addMonths(today, n).month, today.day) : lastDay(today.year + n, today.month, today.day)
  return { from, next, dates: [date] }
}

const dateAtom = (c: Ctx, i: number): AtomRead => {
  const { norms, language, today } = c
  const w = norms[i]!
  const lead = (from: number): number => (from > 0 && (norms[from - 1] === "on" || norms[from - 1] === "op") ? from - 1 : from)
  // today, tomorrow, …
  const day = dayWords[language][w]
  if (day !== undefined) {
    let next = i + 1
    let period = day.period
    if (language === "en" && w === "tomorrow" && barePeriods.en[norms[next] ?? ""] !== undefined) { period = barePeriods.en[norms[next]!]; next++ }
    if (language === "nl" && w === "morgen" && barePeriods.nl[norms[next] ?? ""] !== undefined) { period = barePeriods.nl[norms[next]!]; next++ }
    const date = addDays(today, day.offset)
    const after = weekdayAfter(c, next, date)
    if (after === invalid) return invalid
    return { from: i, next: after, dates: [date], ...(period !== undefined ? { period } : {}) }
  }
  if (language === "en" && w === "the" && norms[i + 1] === "day" && norms[i + 2] === "after" && norms[i + 3] === "tomorrow") return { from: i, next: i + 4, dates: [addDays(today, 2)] }
  if (language === "en" && w === "day" && norms[i + 1] === "after" && norms[i + 2] === "tomorrow") return { from: i, next: i + 3, dates: [addDays(today, 2)] }
  if (language === "en" && w === "this" && barePeriods.en[norms[i + 1] ?? ""] !== undefined) return { from: i, next: i + 2, dates: [today], period: barePeriods.en[norms[i + 1]!]! }
  // in N days / over N weken / in two hours and thirty minutes
  if (w === "in" || (language === "nl" && w === "over")) {
    const r = relativeAtom(c, i)
    if (r !== undefined) return r
  }
  // next week / volgende week (+7 days) and weekday forms
  const nextWeekWord = (k: number): boolean => (language === "en" ? norms[k] === "next" && norms[k + 1] === "week" : norms[k] === "volgende" && norms[k + 1] === "week")
  if (nextWeekWord(i) && weekdayOf(norms[i + 2] ?? "", language) === undefined) return { from: i, next: i + 2, dates: [addDays(today, 7)] }
  // weekday: [on|this|next|coming] WEEKDAY [next week | DATE]
  let k = i
  let mod: "this" | "next" | undefined
  if (modifierWords[language][w] !== undefined) { mod = modifierWords[language][w]; k++ }
  if (language === "en" && norms[k] === "this" && norms[k + 1] === "coming") k += 2
  if (nextWeekWord(i)) { mod = "next"; k = i + 2 }
  const wd = weekdayOf(norms[k] ?? "", language)
  if (wd !== undefined) {
    const todayWd = isoWeekday(today)
    const ahead = (wd - todayWd + 7) % 7
    let next = k + 1
    // "Wednesday 3 March 2027", "Friday the 20th": the date decides, and the weekday must be its weekday.
    const explicit = readCalendarDate(c, next)
    if (explicit === invalid) return invalid
    if (explicit !== undefined) return isoWeekday(explicit.date) === wd ? { from: lead(i), next: explicit.next, dates: [explicit.date] } : invalid
    const weekAfter = nextWeekWord(next) || (language === "nl" && norms[next] === "over" && norms[next + 1] === "een" && norms[next + 2] === "week")
    if (weekAfter) {
      if (mod !== undefined) return invalid // "next Friday next week"
      next += language === "nl" && norms[next] === "over" ? 3 : 2
      const mondayThis = addDays(today, -(todayWd - 1))
      return { from: lead(i), next, dates: [addDays(mondayThis, 7 + wd - 1)] }
    }
    if (mod === "next") {
      const first = ahead === 0 ? 7 : ahead
      if (nextWeekWord(i)) {
        const mondayThis = addDays(today, -(todayWd - 1))
        return { from: lead(i), next, dates: [addDays(mondayThis, 7 + wd - 1)] }
      }
      const dates = ahead === 0 ? [addDays(today, 7)] : [addDays(today, first), addDays(today, first + 7)]
      return { from: lead(i), next, dates, reason: `"next ${norms[k]}" can mean the coming one or the one after` }
    }
    if (mod === "this") return { from: lead(i), next, dates: [addDays(today, ahead)] }
    return { from: lead(i), next, dates: [addDays(today, ahead === 0 ? 7 : ahead)] }
  }
  if (mod !== undefined) return undefined
  // 3 March [2027], the 3rd of March, March 3rd, the 3rd, de derde, 3 maart
  const date = readCalendarDate(c, i)
  if (date === invalid) return invalid
  if (date !== undefined) {
    const after = weekdayAfter(c, date.next, date.date)
    if (after === invalid) return invalid
    return { from: lead(i), next: after, dates: [date.date] }
  }
  return undefined
}

const timeLeads = dicts<Language, true>({
  en: { at: true, around: true, about: true, by: true, for: true },
  nl: { om: true, rond: true, tegen: true, ongeveer: true }
})
/** Words that change what the expression after them means ("before Friday", "until five", "na vrijdag"): not read. */
const reversingWords = dicts<Language, true>({
  en: { before: true, after: true, since: true, until: true, till: true, from: true, between: true, within: true, past: true, except: true, not: true },
  nl: { na: true, sinds: true, vanaf: true, tot: true, tussen: true, binnen: true, voordat: true, behalve: true, niet: true }
})
const relativeWords = dicts<Language, true>({
  en: { next: true, last: true, this: true, coming: true, upcoming: true, previous: true, past: true, every: true, each: true, following: true },
  nl: { volgende: true, vorige: true, afgelopen: true, komende: true, aanstaande: true, aankomende: true, deze: true, elke: true, elk: true, iedere: true, ieder: true, verleden: true }
})
const alwaysTemporal = dict<true>({
  noon: true, midday: true, midnight: true, middernacht: true, am: true, pm: true, oclock: true, weekend: true, weekends: true, weekday: true, weekdays: true,
  fortnight: true, fortnights: true, ago: true, geleden: true, werkdag: true, werkdagen: true, ochtends: true, middags: true, avonds: true, nachts: true, morgens: true
})
const periodNouns = dict<true>({
  morning: true, mornings: true, afternoon: true, afternoons: true, evening: true, evenings: true, night: true, nights: true,
  ochtend: true, middag: true, avond: true, nacht: true, voormiddag: true, namiddag: true
})
const numberish = (c: Ctx, k: number): boolean => {
  const w = c.norms[k]
  if (w === undefined) return false
  if (/^\d/.test(w) || readOrdinal(c.norms, k, c.language) !== undefined) return true
  return readNumber(c.toks, k, c.language) !== undefined
}
/** "a day", "the day after", "this week", "die maand": a unit with one of these before it says when. */
const unitDeterminers: ReadonlySet<string> = new Set(["a", "an", "een", "half", "every", "each", "elke", "elk", "the", "this", "that", "next", "last", "de", "het", "deze", "die", "dat"])
const isUnit = (w: string | undefined, language: Language): boolean => w !== undefined && (dateUnits[language][w] !== undefined || clockUnitWords.has(w))

/**
 * A word that says something about when, so that a parse which did not read it would answer with less than was said
 * ("last Friday", "every Monday", "29 February 2027", "in 2 weeks and 3 days", "at 5 and at 6", "this weekend").
 */
/** Dutch hours said as "vijven", "zessen" ("om vijven", "tegen zessen"). */
const nlHourPlurals: ReadonlySet<string> = new Set(["enen", "tweeen", "drieen", "vieren", "vijven", "zessen", "zevenen", "achten", "negenen", "tienen", "elven", "twaalven"])
const fractionOfHour: ReadonlySet<string> = new Set(["half", "quarter", "kwart"])
const clockLinks: ReadonlySet<string> = new Set(["past", "to", "after", "till", "over", "voor", "half"])

const isTemporal = (c: Ctx, k: number, consumed: ReadonlySet<number>): boolean => {
  const { norms, language } = c
  const w = norms[k]!
  const prev = norms[k - 1]
  const next = norms[k + 1]
  // "at 25", "om 25": a number right after a time word is a time this did not read.
  if (prev !== undefined && timeLeads[language][prev] !== undefined && numberish(c, k)) return true
  if (language === "nl" && nlHourPlurals.has(w)) return true
  // "tomorrow at half past", "morgen om kwart": the start of a clock time.
  if (fractionOfHour.has(w) && (consumed.has(k - 1) || consumed.has(k + 1) || (prev !== undefined && timeLeads[language][prev] !== undefined) || (next !== undefined && clockLinks.has(next)))) return true
  const nearNumber = numberish(c, k - 1) || numberish(c, k + 1) || (norms[k + 1] === "the" && numberish(c, k + 2))
  if (alwaysTemporal[w] !== undefined || dayWords[language][w] !== undefined || periodNouns[w] !== undefined) return true
  const wd = weekdayOf(w, language) ?? (w.endsWith("s") ? weekdayOf(w.slice(0, -1), language) : undefined)
  if (wd !== undefined) return w.length > 4 || nearNumber
  if (monthOf(w, language) !== undefined) return (w.length > 4 && w !== "march") || nearNumber
  if (/^\d{1,2}(st|nd|rd|th|e|de|ste)$/.test(w)) return true
  if (readOrdinal(norms, k, language) !== undefined) {
    const neighbour = (x: string | undefined) => x !== undefined && (monthOf(x, language) !== undefined || weekdayOf(x, language) !== undefined || x === "of" || x === "van")
    return neighbour(next) || neighbour(prev)
  }
  if (isUnit(w, language)) return numberish(c, k - 1) || (prev !== undefined && unitDeterminers.has(prev))
  if (relativeWords[language][w] !== undefined) {
    return next !== undefined && (weekdayOf(next, language) !== undefined || monthOf(next, language) !== undefined || isUnit(next, language) ||
      alwaysTemporal[next] !== undefined || periodNouns[next] !== undefined || weekdayOf(next.replace(/s$/, ""), language) !== undefined)
  }
  if (/^(19|20)\d{2}$/.test(w)) return (prev !== undefined && (monthOf(prev, language) !== undefined || numberish(c, k - 1))) || (next !== undefined && monthOf(next, language) !== undefined)
  if (matchTime(c.toks, k, language, prev !== undefined && timeLeads[language][prev] !== undefined) !== undefined) return true
  return false
}

const minutesOf = (p: { hour: number; minute: number }): number => p.hour * 60 + p.minute

/**
 * A date, a moment or both, from free text: "today", "tomorrow", "tonight", "on Friday", "the 3rd", "3 March", "Wednesday 3 March 2027",
 * "in two days", "tomorrow at five", "in two hours and thirty minutes", "over twee weken", "vrijdag om half acht". "next Friday" is
 * `ambiguous` (the coming one and the one after). A time without am/pm is settled by the band and the clock (see `parseTimeOfDay`);
 * `guessed` says so. The rest of the text may be anything (the title of a reminder), but every word in it that says something about
 * when must have been read: "last Friday", "29 February 2027", "Tuesday 3 March 2027" (a Wednesday), "before Friday",
 * "07:00 in the evening" and "in 2 weeks and 3 days" are `not-understood`, never a moment built from the part that was recognised.
 * `start` and `end` say where it read. Needs the zone and "now" so that "tomorrow" and daylight-saving days come out right.
 */
export const parseDateTime = (text: string, language: Language, options: DateOptions): Parsed<DateTimeParsed> => {
  const zone = normalizeTimeZone(options.timeZone)
  const now = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : Number.NaN
  if (zone === undefined || !Number.isFinite(now) || typeof text !== "string") return notUnderstood
  const toks = tokenize(text)
  const nowParts = localParts(now, zone)
  const today: LocalDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day }
  const c: Ctx = { text, toks, norms: toks.map((t) => t.norm), language, today, spans: numericSpans(text) }
  let atom: Atom | undefined
  let timeAt: { from: number; match: NonNullable<ReturnType<typeof matchTime>> } | undefined
  for (let i = 0; i < toks.length; i++) {
    if (atom === undefined) {
      const a = dateAtom(c, i)
      if (a === invalid) return notUnderstood
      if (a !== undefined) {
        // A part of the day after the date: "tomorrow in the evening", "Friday at night".
        const p = a.offsetMs === undefined ? periodAt(toks, a.next, language) : undefined
        if (p !== undefined && a.period !== undefined && a.period !== p.period) return notUnderstood
        atom = p === undefined ? a : { ...a, next: p.next, period: p.period }
        i = atom.next - 1
        continue
      }
    }
    if (timeAt === undefined) {
      const prev = toks[i - 1]?.norm
      const bareOk = (prev !== undefined && timeLeads[language][prev] !== undefined) || (toks.length === 1)
      const m = matchTime(toks, i, language, bareOk)
      if (m !== undefined) {
        timeAt = { from: i, match: m }
        i = m.next - 1
      }
    }
    if (atom !== undefined && timeAt !== undefined) break
  }
  if (atom === undefined && timeAt === undefined) return notUnderstood
  if (atom?.offsetMs !== undefined && timeAt !== undefined) return notUnderstood // "in two hours at five"
  const timeStart = timeAt === undefined ? undefined : timeAt.from > 0 && timeLeads[language][toks[timeAt.from - 1]!.norm] !== undefined ? timeAt.from - 1 : timeAt.from
  const consumed = new Set<number>()
  const ranges: Array<CharRange> = []
  if (atom !== undefined) {
    for (let k = atom.from; k < atom.next; k++) consumed.add(k)
    ranges.push({ start: toks[atom.from]!.start, end: toks[atom.next - 1]!.end })
  }
  if (timeAt !== undefined) {
    for (let k = timeStart!; k < timeAt.match.next; k++) consumed.add(k)
    ranges.push({ start: toks[timeStart!]!.start, end: toks[timeAt.match.next - 1]!.end })
  }
  // Every word about when must have been read; every number read must have been read whole.
  for (let k = 0; k < toks.length; k++) if (!consumed.has(k) && isTemporal(c, k, consumed)) return notUnderstood
  if (!numbersWhole(text, toks, ranges)) return notUnderstood
  const startTok = Math.min(...consumed)
  const endTok = Math.max(...consumed) + 1
  const before = toks[startTok - 1]?.norm
  if (before !== undefined && (reversingWords[language][before] !== undefined || (language === "nl" && before === "voor" && atom === undefined))) return notUnderstood
  // A number right next to what was read, joined by "and" / "of" ("in 2 weeks and 3", "tomorrow at 5 or 6") is part of it.
  const joiners: ReadonlySet<string> = new Set(["and", "en", "or", "of", "to", "tot", "plus", "maybe", "perhaps", "misschien", "anders", "ofwel"])
  const neighbours: ReadonlyArray<readonly [number, number | undefined]> = [[startTok - 1, undefined], [endTok, undefined], [startTok - 2, startTok - 1], [endTok + 1, endTok]]
  for (const [k, joiner] of neighbours) {
    if (joiner !== undefined && !joiners.has(c.norms[joiner] ?? "")) continue
    if (k >= 0 && k < toks.length && !consumed.has(k) && numberish(c, k)) return notUnderstood
  }
  const start = toks[startTok]!.start
  const end = toks[endTok - 1]!.end
  const said = text.slice(start, end)

  const build = (date: LocalDate | undefined): DateTimeParsed | undefined => {
    // "in two hours": a moment from now
    if (atom?.offsetMs !== undefined) {
      const instant = now + atom.offsetMs
      const p = localParts(instant, zone)
      return {
        date: { year: p.year, month: p.month, day: p.day }, weekday: p.weekday, time: { hour: p.hour, minute: p.minute, guessed: false, alternatives: [] },
        instant, inPast: false, start, end
      }
    }
    let day = date
    let time: TimeOfDay | undefined
    if (timeAt !== undefined) {
      const isToday = day === undefined || sameDate(day, today)
      const open = { ...timeAt.match, ...(timeAt.match.period === undefined && atom?.period !== undefined ? { period: atom.period } : {}) }
      const resolved = resolveTime(open, { ...(options.band !== undefined ? { band: options.band } : {}), ...(isToday ? { afterMinutes: minutesOf(nowParts) } : {}) })
      if (resolved === undefined) return undefined
      // "tomorrow morning at 7 pm", "tonight at 9 am": the part of the day and the clock disagree.
      if (atom?.period !== undefined && !periodHours(atom.period, resolved.time.hour)) return undefined
      time = resolved.time
      // "tonight at 2 am", "vannacht om drie uur", "tomorrow night at 1": the small hours after that evening.
      // Said in those small hours themselves ("vannacht om drie uur" at 01:00), it is this night.
      if (day !== undefined && atom?.period === "night" && time.hour < 6 && !(sameDate(day, today) && nowParts.hour < 6)) day = addDays(day, 1)
      if (day === undefined) {
        day = today
        // A bare time: today if it is still ahead, otherwise tomorrow.
        if (resolved.nextDay || (!resolved.time.guessed && minutesOf(resolved.time) <= minutesOf(nowParts))) day = addDays(today, 1)
      }
    }
    const d = day ?? today
    const instant = time === undefined ? undefined : zonedToInstant({ ...d, hour: time.hour, minute: time.minute }, zone)
    return {
      date: d, weekday: isoWeekday(d), ...(time !== undefined ? { time } : {}), ...(instant !== undefined ? { instant } : {}),
      ...(time === undefined && atom?.period !== undefined ? { partOfDay: atom.period } : {}),
      inPast: instant !== undefined ? instant <= now : (day !== undefined && day.year * 372 + day.month * 31 + day.day < today.year * 372 + today.month * 31 + today.day),
      start, end
    }
  }
  const dates = atom?.dates ?? []
  if (dates.length > 1) {
    const all = dates.map((d) => build(d))
    if (all.some((v) => v === undefined)) return notUnderstood
    return ambiguous(all as ReadonlyArray<DateTimeParsed>, said, atom?.reason ?? "More than one date fits")
  }
  const value = build(dates[0])
  return value === undefined ? notUnderstood : ok(value, said)
}
