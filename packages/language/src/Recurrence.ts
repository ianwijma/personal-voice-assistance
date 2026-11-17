import { dict, dicts } from "./Dict.ts"
import { guarded, isLanguage, isOptions, isText, maxYear } from "./Domain.ts"
import { alt, from, many1, map, oneOf, opt, seq, whole, words, type Input, type P } from "./Grammar.ts"
import { wholeNumber } from "./Numbers.ts"
import { formatDtstart, formatRRule, maxInterval, readSeries, ruleSelects, seriesAfter, weekdayCodes, type Freq, type RecurrenceRule, type RuleDay } from "./Rrule.ts"
import { ambiguous, notUnderstood, ok, type ClockTime, type Language, type LocalDate, type LocalDateTime, type Parsed } from "./Result.ts"
import { bandOf, periodHours, resolveTime, timeOfDay, type Period, type TimeMatch, type TimeOfDay, type TimeOptions } from "./Time.ts"
import { sliceText, tokenize } from "./Tokens.ts"
import { ordinal } from "./Words.ts"
import { addDays, daysInMonth, instantIn, localParts, normalizeTimeZone, zonedToInstant } from "./Zoned.ts"

export interface RecurrenceOptions extends Omit<TimeOptions, "afterMinutes"> {
  /** Epoch milliseconds or a Date, whose local date in `timeZone` is in the supported years. */
  readonly now: number | Date
  /** IANA zone; an unknown zone or an offset makes the answer `not-understood`. */
  readonly timeZone: string
  /** The time of day when none is said ("every Monday"): whole hour 0–23 and minute 0–59. Default 09:00. With a part of the day ("every evening") it is used only when it falls inside that part. */
  readonly defaultTime?: ClockTime
}

export interface Recurrence {
  readonly rule: RecurrenceRule
  /** The `RRULE` value: "FREQ=WEEKLY;BYDAY=MO". */
  readonly rrule: string
  /** The time said, if any (with its band guess). */
  readonly time?: TimeOfDay
  /** The part of the day said ("every evening", "elke ochtend"); the start's time lies inside it. */
  readonly partOfDay?: Period
  /** No clock time was said: the start's time is `defaultTime`, or for a part of the day its usual time (08:00, 14:00, 19:00, 22:00). */
  readonly timeDefaulted: boolean
  /** The first occurrence after now, a wall-clock time in `timeZone`; it is an instance of the rule. */
  readonly start: LocalDateTime
  readonly startInstant: number
  /** "DTSTART;TZID=Europe/Amsterdam:20261120T090000" */
  readonly dtstart: string
  /** `dtstart` and `RRULE:…` as two lines, ready for an iCalendar file or `nextOccurrence`. */
  readonly ics: string
  readonly timeZone: string
}

type Unit = "day" | "week" | "month" | "year"

/** What a rule phrase says, before the time is added. */
interface Body {
  readonly freq: Freq
  readonly interval: number
  /** Weekdays 1–7 (WEEKLY). */
  readonly days?: ReadonlyArray<number>
  /** Days of the month (MONTHLY), -1 the last. */
  readonly monthDays?: ReadonlyArray<number>
  /** An ordinal weekday of the month (MONTHLY). */
  readonly nth?: { readonly n: number; readonly wd: number }
  /** A date every year (YEARLY). */
  readonly date?: { readonly month: number; readonly day: number }
  /** A part of the day said with the days ("every Friday night", "every evening"). */
  readonly part?: Period
}

const both = <T>(en: Readonly<Record<string, T>>, nl: Readonly<Record<string, T>>) => dicts<Language, T>({ en, nl })
const unitSingular = both<Unit>({ day: "day", week: "week", month: "month", year: "year" }, { dag: "day", week: "week", maand: "month", jaar: "year" })
const unitPlural = both<Unit>({ days: "day", weeks: "week", months: "month", years: "year" }, { dagen: "day", weken: "week", maanden: "month", jaar: "year", jaren: "year" })
const adverbs = both<{ unit: Unit; interval: number }>(
  { daily: { unit: "day", interval: 1 }, weekly: { unit: "week", interval: 1 }, fortnightly: { unit: "week", interval: 2 }, monthly: { unit: "month", interval: 1 }, quarterly: { unit: "month", interval: 3 }, yearly: { unit: "year", interval: 1 }, annually: { unit: "year", interval: 1 } },
  { dagelijks: { unit: "day", interval: 1 }, wekelijks: { unit: "week", interval: 1 }, tweewekelijks: { unit: "week", interval: 2 }, maandelijks: { unit: "month", interval: 1 }, jaarlijks: { unit: "year", interval: 1 } }
)
const partWords = both<Period>({ morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" }, { ochtend: "morning", middag: "afternoon", avond: "evening", nacht: "night" })
const partPlurals = both<Period>({ mornings: "morning", afternoons: "afternoon", evenings: "evening", nights: "night" }, { ochtenden: "morning", middagen: "afternoon", avonden: "evening", nachten: "night" })
const weekdaySingular = both<ReadonlyArray<number>>(
  { monday: [1], tuesday: [2], wednesday: [3], thursday: [4], friday: [5], saturday: [6], sunday: [7], weekday: [1, 2, 3, 4, 5], weekend: [6, 7] },
  { maandag: [1], dinsdag: [2], woensdag: [3], donderdag: [4], vrijdag: [5], zaterdag: [6], zondag: [7], werkdag: [1, 2, 3, 4, 5], weekend: [6, 7] }
)
const weekdayPlural = both<ReadonlyArray<number>>(
  { mondays: [1], tuesdays: [2], wednesdays: [3], thursdays: [4], fridays: [5], saturdays: [6], sundays: [7], weekdays: [1, 2, 3, 4, 5], weekends: [6, 7] },
  { maandagen: [1], dinsdagen: [2], woensdagen: [3], donderdagen: [4], vrijdagen: [5], zaterdagen: [6], zondagen: [7], werkdagen: [1, 2, 3, 4, 5], weekenden: [6, 7] }
)
const nlWeekdayS = dict<ReadonlyArray<number>>({ maandags: [1], dinsdags: [2], woensdags: [3], donderdags: [4], vrijdags: [5], zaterdags: [6], zondags: [7] })
const weekdayOne = both<number>(
  { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 },
  { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7 }
)
const monthWords = both<number>(
  { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 },
  { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 }
)
/** The usual clock time of a part of the day said without one ("every evening"). */
const partTimes = dict<ClockTime>({ morning: { hour: 8, minute: 0 }, afternoon: { hour: 14, minute: 0 }, evening: { hour: 19, minute: 0 }, night: { hour: 22, minute: 0 } })
const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

interface Words {
  readonly every: P<string>
  readonly on: string
  readonly and: string
  readonly the: string
  readonly of: string
  readonly last: string
  readonly lastDay: ReadonlyArray<string>
}
const vocabulary: Record<Language, Words> = {
  en: { every: oneOf("every", "each"), on: "on", and: "and", the: "the", of: "of", last: "last", lastDay: ["last", "day"] },
  nl: { every: oneOf("elke", "elk", "iedere", "ieder"), on: "op", and: "en", the: "de", of: "van", last: "laatste", lastDay: ["laatste", "dag"] }
}

const grammar = (language: Language): P<Body> => {
  const w = vocabulary[language]
  const en = language === "en"
  const and = opt(words(w.and))

  /** "every day", "every other week", "every second month", "every 3 years", "daily"; "om de week", "elke twee weken". */
  const interval: P<{ unit: Unit; interval: number }> = alt(
    from(adverbs[language]),
    map(seq(w.every, from(unitSingular[language])), ([, unit]) => ({ unit, interval: 1 })),
    // EVERY ORDINAL UNIT from "first" ("every first day" is every day; review round 4, finding 20).
    map(seq(w.every, ordinal(language, 1, 31), from(unitSingular[language])), ([, n, unit]) => ({ unit, interval: n })),
    map(seq(w.every, wholeNumber(language, 2, maxInterval), from(unitPlural[language])), ([, n, unit]) => ({ unit, interval: n })),
    ...(en
      ? [map(seq(oneOf("every", "each"), words("other"), from(unitSingular.en)), ([, , unit]) => ({ unit, interval: 2 }))]
      : [
        map(seq(words("om", "de"), from(unitSingular.nl)), ([, unit]) => ({ unit, interval: 2 })),
        map(seq(words("om", "de"), wholeNumber("nl", 2, maxInterval), from(unitPlural.nl)), ([, n, unit]) => ({ unit, interval: n }))
      ])
  )
  const intervalOf = (unit: Unit) => map(interval, (i) => (i.unit === unit ? i.interval : undefined))

  /** A Dutch weekday and part of the day in one word: "vrijdagavond". */
  const nlCompound: P<{ days: ReadonlyArray<number>; part: Period }> = (input, at) => {
    const t = input.norms[at]
    if (language !== "nl" || t === undefined) return []
    for (const [name, wd] of Object.entries(weekdayOne.nl)) {
      if (!t.startsWith(name)) continue
      const part = partWords.nl[t.slice(name.length)]
      if (part !== undefined) return [{ value: { days: [wd!], part }, next: at + 1 }]
    }
    return []
  }
  const singular: P<{ days: ReadonlyArray<number>; part?: Period }> = alt(map(from(weekdaySingular[language]), (days) => ({ days })), nlCompound)
  /** "Monday", "Monday and Friday", "Monday, Wednesday and Friday" (a comma is punctuation), "weekday"; every part the same. */
  const singularList: P<{ days: ReadonlyArray<number>; part?: Period }> = map(many1(singular, and, 7), (items) => {
    const days = items.flatMap((i) => i.days)
    const parts = new Set(items.map((i) => i.part))
    if (new Set(days).size !== days.length || parts.size > 1) return undefined
    const part = items[0]!.part
    return { days: [...days].sort((a, b) => a - b), ...(part !== undefined ? { part } : {}) }
  })
  const pluralList: P<ReadonlyArray<number>> = map(many1(from(weekdayPlural[language]), and, 7), (items) => {
    const days = items.flat()
    return new Set(days).size === days.length ? [...days].sort((a, b) => a - b) : undefined
  })

  /**
   * "the 1st and the 15th", "the 1st and 15th", "the first, the fifteenth and the last day", "de eerste en de vijftiende": the first
   * day with "the"; each next one with "the", "and" or both.
   */
  const dayItem: P<number> = alt(ordinal(language, 1, 31), map(words(...w.lastDay), () => -1))
  const monthDayList: P<ReadonlyArray<number>> = map(
    seq(words(w.the), dayItem, opt(many1(map(seq(alt(words(w.the), map(seq(words(w.and), opt(words(w.the))), () => "")), dayItem), ([, d]) => d), undefined, 30))),
    ([, first, rest]) => {
      const days = [first, ...(rest ?? [])]
      return new Set(days).size === days.length ? [...days].sort((a, b) => (a < 0 ? 100 : a) - (b < 0 ? 100 : b)) : undefined
    }
  )
  /** "the second Tuesday", "the last Friday", "de eerste maandag". */
  const nthWeekday: P<{ n: number; wd: number }> = map(
    seq(words(w.the), alt(ordinal(language, 1, 5), map(words(w.last), () => -1)), from(weekdayOne[language])),
    ([, n, wd]) => ({ n, wd })
  )
  /** "of the month", "of every month", "of every other month", "of every 3 months"; "van de maand", "van elke maand". */
  const ofMonth: P<number> = alt(
    map(words(w.of, w.the, en ? "month" : "maand"), () => 1),
    map(seq(words(w.of), w.every, from(unitSingular[language])), ([, , u]) => (u === "month" ? 1 : undefined)),
    map(seq(words(w.of), w.every, ordinal(language, 1, 31), from(unitSingular[language])), ([, , n, u]) => (u === "month" ? n : undefined)),
    map(seq(words(w.of), w.every, wholeNumber(language, 2, maxInterval), from(unitPlural[language])), ([, , n, u]) => (u === "month" ? n : undefined)),
    ...(en ? [map(seq(words("of"), w.every, words("other"), from(unitSingular.en)), ([, , , u]) => (u === "month" ? 2 : undefined))] : [])
  )
  /** "3 March", "the 3rd of March", "March 3rd", "March the third"; "3 maart", "de derde maart". */
  const dayOfMonth = alt(ordinal(language, 1, 31), wholeNumber(language, 1, 31))
  const valid = (month: number, day: number) => (day <= maxDays[month - 1]! ? { month, day } : undefined)
  const yearDate: P<{ month: number; day: number }> = en
    ? alt(
      map(seq(opt(words("the")), dayOfMonth, opt(words("of")), from(monthWords.en)), ([, d, , m]) => valid(m, d)),
      map(seq(from(monthWords.en), opt(words("the")), dayOfMonth), ([m, , d]) => valid(m, d))
    )
    : map(seq(opt(words("de")), dayOfMonth, from(monthWords.nl)), ([, d, m]) => valid(m, d))
  const on = words(w.on)

  return alt<Body>(
    // An interval phrase, then what it may take: "every week on Monday", "every 2 months on the 15th", "every year on 3 March".
    map(intervalOf("day"), (n) => ({ freq: "DAILY", interval: n })),
    map(seq(intervalOf("week"), opt(seq(on, alt(map(singularList, (l) => (l.part === undefined ? l.days : undefined)), pluralList)))),
      ([n, d]) => ({ freq: "WEEKLY", interval: n, ...(d !== undefined ? { days: d[1] } : {}) })),
    map(intervalOf("month"), (n) => ({ freq: "MONTHLY", interval: n })),
    map(seq(intervalOf("month"), on, monthDayList), ([n, , days]) => ({ freq: "MONTHLY", interval: n, monthDays: days })),
    map(seq(intervalOf("month"), on, nthWeekday), ([n, , nth]) => ({ freq: "MONTHLY", interval: n, nth })),
    map(seq(intervalOf("year"), opt(seq(on, yearDate))), ([n, d]) => ({ freq: "YEARLY", interval: n, ...(d !== undefined ? { date: d[1] } : {}) })),
    // "every Monday and Friday [evening]", "every weekday morning", "elke vrijdagavond"
    map(seq(w.every, singularList, opt(from(partWords[language]))), ([, l, p]) => (l.part !== undefined && p !== undefined ? undefined
      : { freq: "WEEKLY", interval: 1, days: l.days, ...((l.part ?? p) !== undefined ? { part: (l.part ?? p)! } : {}) })),
    // "every other Tuesday", "every second Tuesday", "every third Friday": every few weeks.
    map(seq(w.every, alt(ordinal(language, 2, 5), ...(en ? [map(words("other"), () => 2)] : [])), from(weekdayOne[language])), ([, n, wd]) => ({ freq: "WEEKLY", interval: n, days: [wd] })),
    // "every morning", "elke avond"
    map(seq(w.every, from(partWords[language])), ([, part]) => ({ freq: "DAILY", interval: 1, part })),
    // [on] Mondays [and Thursdays] [evenings]; on Monday evenings; op werkdagen; 's maandags
    map(seq(opt(on), pluralList, opt(from(partPlurals[language]))), ([, days, part]) => ({ freq: "WEEKLY", interval: 1, days, ...(part !== undefined ? { part } : {}) })),
    ...(en
      ? [map(seq(opt(on), map(singularList, (l) => (l.part === undefined ? l.days : undefined)), from(partPlurals.en)), ([, days, part]): Body => ({ freq: "WEEKLY", interval: 1, days, part }))]
      : [map(seq(opt(words("s")), from(nlWeekdayS)), ([, days]): Body => ({ freq: "WEEKLY", interval: 1, days }))]),
    // [on] the 1st [and the 15th] of the month | of every other month; [on] the last day of the month
    map(seq(opt(on), monthDayList, ofMonth), ([, days, n]) => ({ freq: "MONTHLY", interval: n, monthDays: days })),
    // [on] the second Tuesday of the month
    map(seq(opt(on), nthWeekday, ofMonth), ([, nth, n]) => ({ freq: "MONTHLY", interval: n, nth })),
    // "every 2nd of the month", "elke eerste van de maand"
    map(seq(w.every, ordinal(language, 1, 31), ofMonth), ([, d, i]) => ({ freq: "MONTHLY", interval: i, monthDays: [d] })),
    // "every first Monday of the month", "every last Friday of every month", "elke tweede dinsdag van de maand"
    map(seq(w.every, alt(ordinal(language, 1, 5), map(words(w.last), () => -1)), from(weekdayOne[language]), ofMonth), ([, n, wd, i]) => ({ freq: "MONTHLY", interval: i, nth: { n, wd } })),
    // "every 3 March", "every March 3rd", "elke 3 maart"
    map(seq(w.every, yearDate), ([, date]) => ({ freq: "YEARLY", interval: 1, date }))
  )
}
const grammars: Record<Language, P<Body>> = { en: grammar("en"), nl: grammar("nl") }

interface Reading {
  readonly body: Body
  readonly time?: TimeMatch
}
/** [at TIME] RULE [at TIME], at most one time. */
const phrases: Record<Language, P<Reading>> = {
  en: phraseOf("en"),
  nl: phraseOf("nl")
}
function phraseOf(language: Language): P<Reading> {
  const time = map(seq(words(language === "en" ? "at" : "om"), timeOfDay[language]), ([, m]) => m)
  const body = grammars[language]
  return alt(
    map(body, (b) => ({ body: b })),
    map(seq(body, time), ([b, t]) => ({ body: b, time: t })),
    map(seq(time, body), ([t, b]) => ({ body: b, time: t }))
  )
}

const wdCode = (n: number): RuleDay["weekday"] => weekdayCodes[((n - 1) % 7 + 7) % 7]!

/** The rule of a reading, with the time settled; `undefined` when the parts do not fit together. */
const settle = (r: Reading, band: { from: number; to: number }, defaultTime: ClockTime | undefined): { rule: RecurrenceRule; time?: TimeOfDay; clock: ClockTime; part?: Period } | undefined => {
  const { body } = r
  let time: TimeOfDay | undefined
  let smallHours = false
  if (r.time !== undefined) {
    const m = r.time
    if (m.hour === 24) return undefined // "every day at 24:00": a day later than said; say 00:00
    if (m.period !== undefined && body.part !== undefined && m.period !== body.part && m.period !== "am" && m.period !== "pm") return undefined
    const resolved = resolveTime(body.part !== undefined && m.period === undefined ? { ...m, period: body.part } : m, band)
    if (resolved === undefined) return undefined
    if (body.part !== undefined && !periodHours(body.part, resolved.time.hour)) return undefined
    time = resolved.time
    smallHours = [time, ...time.alternatives].every((t) => t.hour < 6)
    // "every Friday at midnight": the start of Friday or its end. Only a daily rule, or a night ("every Friday night at midnight"), says.
    if (m.midnightWord && body.freq !== "DAILY" && body.part !== "night") return undefined
  }
  const partDefault = body.part === undefined ? undefined
    : defaultTime !== undefined && periodHours(body.part, defaultTime.hour) ? defaultTime : partTimes[body.part]
  const clock: ClockTime = time ?? partDefault ?? defaultTime ?? { hour: 9, minute: 0 }
  // "every Friday night at 1": the small hours after Friday evening are Saturday's.
  const shift = body.part === "night" && clock.hour < 6 && (time === undefined || smallHours) ? 1 : 0
  if (shift === 1 && body.freq !== "DAILY" && body.freq !== "WEEKLY") return undefined
  const byDay: Array<RuleDay> = body.days !== undefined ? body.days.map((d) => ({ weekday: wdCode(d + shift) }))
    : body.nth !== undefined ? [{ weekday: wdCode(body.nth.wd), nth: body.nth.n }] : []
  const rule: RecurrenceRule = {
    freq: body.freq, interval: body.interval,
    byDay: [...byDay].sort((a, b) => weekdayCodes.indexOf(a.weekday) - weekdayCodes.indexOf(b.weekday)),
    byMonthDay: body.monthDays !== undefined ? [...body.monthDays] : body.date !== undefined ? [body.date.day] : [],
    byMonth: body.date !== undefined ? [body.date.month] : []
  }
  if (formatRRule(rule) === undefined) return undefined
  return { rule, ...(time !== undefined ? { time } : {}), clock, ...(body.part !== undefined ? { part: body.part } : {}) }
}

const isClock = (t: unknown): t is ClockTime =>
  typeof t === "object" && t !== null && Number.isInteger((t as ClockTime).hour) && Number.isInteger((t as ClockTime).minute) &&
  (t as ClockTime).hour >= 0 && (t as ClockTime).hour <= 23 && (t as ClockTime).minute >= 0 && (t as ClockTime).minute <= 59

/**
 * Build an RFC 5545 rule from a phrase that is only a recurrence (README, "Spoken recurrence"), and its first occurrence after now:
 * "every day", "every weekday at seven", "every second Tuesday", "on the first of the month", "the last Friday of every month", "every
 * year on 3 March", "elke werkdag om zeven uur", "elke tweede dinsdag", "op de eerste van de maand". Every word must be read by the
 * grammar: "every Monday or Friday", "every hour", "every day except Sunday", "every day until June" are `not-understood`. When the
 * words read as two different rules, the answer is `ambiguous` with both. Never throws.
 */
export const parseRecurrence: (text: string, language: Language, options: RecurrenceOptions) => Parsed<Recurrence> = guarded((text: string, language: Language, options: RecurrenceOptions): Parsed<Recurrence> => {
  if (!isText(text) || !isLanguage(language) || !isOptions(options) || options === undefined) return notUnderstood
  const zone = normalizeTimeZone(options.timeZone)
  const band = bandOf(options)
  if (zone === undefined || band === undefined) return notUnderstood
  // A default time that is not a clock time is refused before any conversion (finding 4).
  if (options.defaultTime !== undefined && !isClock(options.defaultTime)) return notUnderstood
  const nowIn = instantIn(options.now, zone)
  if (nowIn === undefined) return notUnderstood
  const now = nowIn.instant
  const toks = tokenize(text)
  if (toks === undefined || toks.length === 0) return notUnderstood
  const input: Input = { text, toks, norms: toks.map((t) => t.norm) }
  const today: LocalDate = { year: nowIn.parts.year, month: nowIn.parts.month, day: nowIn.parts.day }
  const results: Array<Recurrence> = []
  for (const r of whole(phrases[language], input)) {
    const s = settle(r, band, options.defaultTime)
    if (s === undefined) continue
    const built = firstAfter(s.rule, s.clock, today, now, zone)
    if (built === undefined) continue
    const rrule = formatRRule(s.rule)!
    const dtstart = formatDtstart(built.start, zone)
    if (dtstart === undefined) continue
    // The series as stored must give the start back.
    const read = readSeries({ rrule, dtstart, timeZone: zone })
    if (read.kind !== "ok" || seriesAfter(read.series, now, 1)?.instants[0] !== built.instant) continue
    const value: Recurrence = {
      rule: s.rule, rrule, ...(s.time !== undefined ? { time: s.time } : {}), ...(s.part !== undefined ? { partOfDay: s.part } : {}), timeDefaulted: s.time === undefined,
      start: built.start, startInstant: built.instant, dtstart, ics: `${dtstart}\nRRULE:${rrule}`, timeZone: zone
    }
    if (!results.some((x) => x.rrule === value.rrule && x.dtstart === value.dtstart)) results.push(value)
  }
  const said = sliceText(text, toks, 0, toks.length)
  if (results.length === 0) return notUnderstood
  if (results.length > 1) return ambiguous(results, said, "The words read as more than one rule")
  return ok(results[0]!, said)
}, notUnderstood)

/**
 * The first instance after now: the first day from today the rule selects (with interval 1; DTSTART sets the phase), at `clock`,
 * whose moment is after now, within the supported years. A plain weekly, monthly or yearly rule takes today's weekday, day or date.
 */
const firstAfter = (rule: RecurrenceRule, clock: ClockTime, today: LocalDate, now: number, zone: string): { start: LocalDateTime; instant: number } | undefined => {
  for (let k = 0; k <= 366 * 8 + 31; k++) {
    const d = addDays(today, k)
    if (d.year > maxYear) return undefined
    if (!ruleSelects(rule, today, d)) continue
    if (rule.freq === "MONTHLY" && rule.byDay.length + rule.byMonthDay.length === 0 && d.day !== today.day) continue
    if (rule.freq === "YEARLY" && rule.byMonth.length === 0 && (d.month !== today.month || d.day !== today.day)) continue
    if (d.day > daysInMonth(d.year, d.month)) continue
    const start = { ...d, hour: clock.hour, minute: clock.minute, second: 0 }
    const instant = zonedToInstant(start, zone)
    // A day the zone skips altogether (Pacific/Apia, 30 December 2011) is not a start: its instant is the next day's, and a start
    // on it would shift the phase of every-few-days rules by one day.
    const back = localParts(instant, zone)
    if (back.year !== d.year || back.month !== d.month || back.day !== d.day) continue
    if (instant > now) return { start, instant }
  }
  return undefined
}
