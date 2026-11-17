import { readAmount, readNumber } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type Language, type LocalDate, type Parsed } from "./Result.ts"
import { matchTime, resolveTime, type Period, type TimeOfDay, type TimeOptions } from "./Time.ts"
import { tokenize, type Tok } from "./Tokens.ts"
import { monthOf, readOrdinal, weekdayOf } from "./Words.ts"
import { addDays, addMonths, daysInMonth, isoWeekday, localParts, sameDate, zonedToInstant } from "./Zoned.ts"

export interface DateOptions extends Omit<TimeOptions, "afterMinutes"> {
  /** The moment "now" means: epoch milliseconds or a Date. */
  readonly now: number | Date
  /** IANA zone the words are about, e.g. "Europe/Amsterdam". */
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

const barePeriods: Record<Language, Record<string, Period>> = {
  en: { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" },
  nl: { ochtend: "morning", middag: "afternoon", avond: "evening", nacht: "night" }
}
const dayWords: Record<Language, Record<string, { offset: number; period?: Period }>> = {
  en: {
    today: { offset: 0 }, tonight: { offset: 0, period: "night" }, tomorrow: { offset: 1 }, yesterday: { offset: -1 }
  },
  nl: {
    vandaag: { offset: 0 }, vanavond: { offset: 0, period: "evening" }, vanochtend: { offset: 0, period: "morning" }, vanmorgen: { offset: 0, period: "morning" },
    vanmiddag: { offset: 0, period: "afternoon" }, vannacht: { offset: 0, period: "night" }, morgen: { offset: 1 }, overmorgen: { offset: 2 }, gisteren: { offset: -1 },
    morgenochtend: { offset: 1, period: "morning" }, morgenvroeg: { offset: 1, period: "morning" }, morgenmiddag: { offset: 1, period: "afternoon" },
    morgenavond: { offset: 1, period: "evening" }, morgennacht: { offset: 1, period: "night" }
  }
}
const dateUnits: Record<Language, Record<string, "day" | "week" | "month" | "year">> = {
  en: { day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year", fortnight: "week" },
  nl: { dag: "day", dagen: "day", week: "week", weken: "week", maand: "month", maanden: "month", jaar: "year", jaren: "year" }
}
const clockUnits: Record<Language, Record<string, number>> = {
  en: { hour: 3_600_000, hours: 3_600_000, minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000, hr: 3_600_000, hrs: 3_600_000 },
  nl: { uur: 3_600_000, uren: 3_600_000, minuut: 60_000, minuten: 60_000, kwartier: 900_000 }
}

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

const connectorsBefore: Record<Language, ReadonlySet<string>> = {
  en: new Set(["on", "at", "for", "by", "the"]),
  nl: new Set(["op", "om", "voor", "de", "tegen"])
}

const dateAtom = (toks: ReadonlyArray<Tok>, i: number, language: Language, today: LocalDate): Atom | undefined => {
  const norms = toks.map((t) => t.norm)
  const w = norms[i]!
  const lead = (from: number): number => (from > 0 && connectorsBefore[language].has(norms[from - 1]!) && (norms[from - 1] === "on" || norms[from - 1] === "op") ? from - 1 : from)
  // today, tomorrow, …
  const day = dayWords[language][w]
  if (day !== undefined) {
    let next = i + 1
    let period = day.period
    if (language === "en" && w === "tomorrow" && barePeriods.en[norms[next] ?? ""] !== undefined) { period = barePeriods.en[norms[next]!]; next++ }
    if (language === "nl" && w === "morgen" && barePeriods.nl[norms[next] ?? ""] !== undefined) { period = barePeriods.nl[norms[next]!]; next++ }
    return { from: i, next, dates: [addDays(today, day.offset)], ...(period !== undefined ? { period } : {}) }
  }
  if (language === "en" && w === "the" && norms[i + 1] === "day" && norms[i + 2] === "after" && norms[i + 3] === "tomorrow") return { from: i, next: i + 4, dates: [addDays(today, 2)] }
  if (language === "en" && w === "day" && norms[i + 1] === "after" && norms[i + 2] === "tomorrow") return { from: i, next: i + 3, dates: [addDays(today, 2)] }
  if (language === "en" && w === "this" && barePeriods.en[norms[i + 1] ?? ""] !== undefined) return { from: i, next: i + 2, dates: [today], period: barePeriods.en[norms[i + 1]!]! }
  // in N days / over N weken / in an hour
  if (w === "in" || (language === "nl" && w === "over")) {
    const amount = readAmount(toks, i + 1, language)
    if (amount !== undefined) {
      let k = amount.next
      if (language === "en" && (norms[k] === "a" || norms[k] === "an") && amount.value < 1) k++
      if (language === "nl" && norms[k] === "een" && amount.value < 1) k++
      const u = norms[k]
      if (u !== undefined) {
        const clock = clockUnits[language][u]
        if (clock !== undefined && !(u === "kwartier" && !(amount.value === 1))) {
          const n = u === "kwartier" ? 1 : amount.value
          return { from: i, next: k + 1, dates: [], offsetMs: Math.round(n * clock) }
        }
        const unit = dateUnits[language][u]
        if (unit !== undefined && Number.isInteger(amount.value) && amount.value >= 0 && amount.value < 1000) {
          const n = (u === "fortnight" ? 2 : 1) * amount.value
          const date = unit === "day" ? addDays(today, n) : unit === "week" ? addDays(today, 7 * n)
            : unit === "month" ? lastDay(addMonths(today, n).year, addMonths(today, n).month, today.day) : lastDay(today.year + n, today.month, today.day)
          return { from: i, next: k + 1, dates: [date] }
        }
      }
      // "over een week" with a half etc. is not read
    }
  }
  // next week / volgende week (+7 days) and weekday forms
  const nextWeekWord = (k: number): boolean => (language === "en" ? norms[k] === "next" && norms[k + 1] === "week" : norms[k] === "volgende" && norms[k + 1] === "week")
  if (nextWeekWord(i) && weekdayOf(norms[i + 2] ?? "", language) === undefined) return { from: i, next: i + 2, dates: [addDays(today, 7)] }
  // weekday: [on|this|next|coming] WEEKDAY [next week]
  const modifiers: Record<Language, Record<string, "this" | "next">> = {
    en: { this: "this", coming: "this", upcoming: "this", next: "next" },
    nl: { deze: "this", komende: "this", aanstaande: "this", aankomende: "this", volgende: "next" }
  }
  let k = i
  let mod: "this" | "next" | undefined
  if (modifiers[language][w] !== undefined) { mod = modifiers[language][w]; k++ }
  if (language === "en" && norms[k] === "this" && norms[k + 1] === "coming") k += 2
  if (nextWeekWord(i)) { mod = "next"; k = i + 2 }
  const wd = weekdayOf(norms[k] ?? "", language)
  if (wd !== undefined) {
    const todayWd = isoWeekday(today)
    const ahead = (wd - todayWd + 7) % 7
    let next = k + 1
    const weekAfter = nextWeekWord(next) || (language === "nl" && norms[next] === "over" && norms[next + 1] === "een" && norms[next + 2] === "week")
    if (weekAfter) {
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
  // 3 March [2027], the 3rd of March, March 3rd, the 3rd, de derde, 3 maart
  const readDay = (at: number): { value: number; next: number } | undefined => {
    const ord = readOrdinal(norms, at, language)
    if (ord !== undefined) return ord
    const n = readNumber(toks, at, language)
    if (n !== undefined && Number.isInteger(n.value) && n.value >= 1 && n.value <= 31) return { value: n.value, next: n.next }
    return undefined
  }
  const readYear = (at: number): { value: number; next: number } | undefined => {
    const t = norms[at]
    return t !== undefined && /^(19|20)\d{2}$/.test(t) ? { value: Number(t), next: at + 1 } : undefined
  }
  const article = (language === "en" ? "the" : "de")
  let s = i
  if (norms[s] === article) s++
  const d = readDay(s)
  if (d !== undefined) {
    let m = d.next
    if (norms[m] === "of" || (language === "nl" && norms[m] === "van")) m++
    const month = monthOf(norms[m] ?? "", language)
    if (month !== undefined) {
      const y = readYear(m + 1)
      const date = nextDayOfMonth(today, d.value, month, y?.value)
      if (date === undefined) return undefined
      return { from: lead(i), next: y?.next ?? m + 1, dates: [date] }
    }
    // bare ordinal: "the 3rd" / "de derde" / "de 3e"
    const bareOrdinal = readOrdinal(norms, s, language) !== undefined
    if (bareOrdinal && (s > i || /^\d/.test(norms[s]!))) {
      const date = nextDayOfMonth(today, d.value)
      if (date === undefined) return undefined
      return { from: lead(i), next: d.next, dates: [date] }
    }
  }
  // MONTH [the] DAY [YEAR]
  const month = monthOf(w, language)
  if (month !== undefined) {
    let at = i + 1
    if (norms[at] === article) at++
    const dd = readDay(at)
    if (dd !== undefined) {
      const y = readYear(dd.next)
      const date = nextDayOfMonth(today, dd.value, month, y?.value)
      if (date !== undefined) return { from: i, next: y?.next ?? dd.next, dates: [date] }
    }
  }
  return undefined
}

const timeLeads: Record<Language, ReadonlySet<string>> = {
  en: new Set(["at", "around", "about", "by", "for"]),
  nl: new Set(["om", "rond", "tegen", "ongeveer", "voor"])
}

const minutesOf = (p: { hour: number; minute: number }): number => p.hour * 60 + p.minute

/**
 * A date, a moment or both, from free text: "today", "tomorrow", "tonight", "on Friday", "the 3rd", "3 March", "in two days",
 * "tomorrow at five", "over twee weken", "vrijdag om half acht". "next Friday" is `ambiguous` (the coming one and the one after).
 * A time without am/pm is settled by the band and the clock (see `parseTimeOfDay`); `guessed` says so. Only what is recognised is read;
 * `start` and `end` say where. Needs the zone and "now" so that "tomorrow" and daylight-saving days come out right.
 */
export const parseDateTime = (text: string, language: Language, options: DateOptions): Parsed<DateTimeParsed> => {
  const toks = tokenize(text)
  const now = typeof options.now === "number" ? options.now : options.now.getTime()
  const zone = options.timeZone
  const nowParts = localParts(now, zone)
  const today: LocalDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day }
  let atom: Atom | undefined
  let timeAt: { from: number; match: NonNullable<ReturnType<typeof matchTime>> } | undefined
  for (let i = 0; i < toks.length; i++) {
    if (atom === undefined) {
      const a = dateAtom(toks, i, language, today)
      if (a !== undefined) {
        atom = a
        i = a.next - 1
        continue
      }
    }
    if (timeAt === undefined) {
      const prev = toks[i - 1]?.norm
      const bareOk = (prev !== undefined && timeLeads[language].has(prev)) || (toks.length === 1)
      const m = matchTime(toks, i, language, bareOk)
      if (m !== undefined) {
        timeAt = { from: i, match: m }
        i = m.next - 1
      }
    }
    if (atom !== undefined && timeAt !== undefined) break
  }
  if (atom === undefined && timeAt === undefined) return notUnderstood
  // A part of the day with a time word that is not open ("tonight at 22:00") needs no more.
  const lo = Math.min(atom?.from ?? Infinity, timeAt?.from ?? Infinity)
  const startTok = timeAt !== undefined && timeAt.from === lo && timeAt.from > 0 && timeLeads[language].has(toks[timeAt.from - 1]!.norm) ? lo - 1 : lo
  const endTok = Math.max(atom?.next ?? 0, timeAt?.match.next ?? 0)
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
      time = resolved.time
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
    const all = dates.map((d) => build(d)).filter((v): v is DateTimeParsed => v !== undefined)
    if (all.length === 0) return notUnderstood
    return ambiguous(all, said, atom?.reason ?? "More than one date fits")
  }
  const value = build(dates[0])
  return value === undefined ? notUnderstood : ok(value, said)
}
