import { dict, dicts } from "./Dict.ts"
import { numbersWhole, readNumber } from "./Numbers.ts"
import { formatDtstart, formatRRule, readSeries, ruleSelects, seriesAfter, weekdayCodes, type Freq, type RecurrenceRule, type RuleDay } from "./Rrule.ts"
import { ambiguous, notUnderstood, ok, type ClockTime, type Language, type LocalDate, type LocalDateTime, type Parsed } from "./Result.ts"
import { matchTimes, periodHours, resolveTime, type Period, type TimeMatch, type TimeOfDay, type TimeOptions } from "./Time.ts"
import { onlyWords, tokenize, type Tok } from "./Tokens.ts"
import { monthOf, readOrdinal, weekdayOf } from "./Words.ts"
import { addDays, daysInMonth, localParts, normalizeTimeZone, zonedToInstant } from "./Zoned.ts"

export interface RecurrenceOptions extends Omit<TimeOptions, "afterMinutes"> {
  readonly now: number | Date
  /** IANA zone; an unknown zone makes the answer `not-understood`. */
  readonly timeZone: string
  /** The time of day when none is said ("every Monday"). Default 09:00. With a part of the day ("every evening") it is used only when it falls inside that part. */
  readonly defaultTime?: ClockTime
}

export interface Recurrence {
  readonly rule: RecurrenceRule
  /** The `RRULE` value: "FREQ=WEEKLY;BYDAY=MO". */
  readonly rrule: string
  /** The time said, if any (with its am/pm guess). */
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
  readonly next: number
}

const words = <T>(en: Readonly<Record<string, T>>, nl: Readonly<Record<string, T>>) => dicts<Language, T>({ en, nl })
const everyWords = words<true>({ every: true, each: true }, { elke: true, elk: true, iedere: true, ieder: true })
const unitSingular = words<Unit>({ day: "day", week: "week", month: "month", year: "year" }, { dag: "day", week: "week", maand: "month", jaar: "year" })
const unitPlural = words<Unit>({ days: "day", weeks: "week", months: "month", years: "year" }, { dagen: "day", weken: "week", maanden: "month", jaar: "year", jaren: "year" })
const adverbs = words<{ unit: Unit; interval: number }>(
  { daily: { unit: "day", interval: 1 }, weekly: { unit: "week", interval: 1 }, fortnightly: { unit: "week", interval: 2 }, monthly: { unit: "month", interval: 1 }, quarterly: { unit: "month", interval: 3 }, yearly: { unit: "year", interval: 1 }, annually: { unit: "year", interval: 1 } },
  { dagelijks: { unit: "day", interval: 1 }, wekelijks: { unit: "week", interval: 1 }, tweewekelijks: { unit: "week", interval: 2 }, maandelijks: { unit: "month", interval: 1 }, jaarlijks: { unit: "year", interval: 1 } }
)
const partWords = words<Period>(
  { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" },
  { ochtend: "morning", morgen: "morning", middag: "afternoon", avond: "evening", nacht: "night" }
)
const partPlurals = words<Period>({ mornings: "morning", afternoons: "afternoon", evenings: "evening", nights: "night" }, { ochtenden: "morning", middagen: "afternoon", avonden: "evening", nachten: "night" })
const daySets = words<ReadonlyArray<number>>(
  { weekday: [1, 2, 3, 4, 5], workday: [1, 2, 3, 4, 5], weekend: [6, 7] },
  { werkdag: [1, 2, 3, 4, 5], weekend: [6, 7] }
)
const daySetPlurals = words<ReadonlyArray<number>>(
  { weekdays: [1, 2, 3, 4, 5], workdays: [1, 2, 3, 4, 5], weekends: [6, 7] },
  { werkdagen: [1, 2, 3, 4, 5], weekenden: [6, 7], weekends: [6, 7] }
)
const nlWeekdayNames = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]
/** The usual clock time of a part of the day said without one ("every evening"). */
const partTimes = dict<ClockTime>({ morning: { hour: 8, minute: 0 }, afternoon: { hour: 14, minute: 0 }, evening: { hour: 19, minute: 0 }, night: { hour: 22, minute: 0 } })
const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

interface G {
  readonly toks: ReadonlyArray<Tok>
  readonly norms: ReadonlyArray<string>
  readonly language: Language
}

const is = (g: G, k: number, ...ws: ReadonlyArray<string>): boolean => g.norms[k] !== undefined && ws.includes(g.norms[k]!)
const isEvery = (g: G, k: number): boolean => everyWords[g.language][g.norms[k] ?? ""] !== undefined

/** A weekday (or a set of them) in the singular: "Monday", "weekday", "weekend"; Dutch "maandag", "werkdag". */
const weekdayAt = (g: G, k: number): ReadonlyArray<number> | undefined => {
  const w = g.norms[k] ?? ""
  const d = weekdayOf(w, g.language)
  return d !== undefined ? [d] : daySets[g.language][w]
}
/** A weekday in the plural: "Mondays", "weekdays"; Dutch "maandagen", "werkdagen", "maandags" ('s maandags). */
const weekdayPluralAt = (g: G, k: number): ReadonlyArray<number> | undefined => {
  const w = g.norms[k] ?? ""
  const set = daySetPlurals[g.language][w]
  if (set !== undefined) return set
  if (g.language === "en") {
    const d = w.endsWith("s") ? weekdayOf(w.slice(0, -1), "en") : undefined
    return d !== undefined && w.length > 4 ? [d] : undefined
  }
  const d = nlWeekdayNames.findIndex((n) => w === `${n}en` || w === `${n}s`)
  return d >= 0 ? [d + 1] : undefined
}
/** Dutch weekday and part in one word: "vrijdagavond", "maandagochtend". */
const nlCompoundAt = (g: G, k: number): { days: ReadonlyArray<number>; part: Period } | undefined => {
  if (g.language !== "nl") return undefined
  const w = g.norms[k] ?? ""
  for (let d = 0; d < 7; d++) {
    const name = nlWeekdayNames[d]!
    if (w.startsWith(name)) {
      const part = partWords.nl[w.slice(name.length)]
      if (part !== undefined) return { days: [d + 1], part }
    }
  }
  return undefined
}

/** A list of weekdays: "Monday", "Monday and Friday", "Monday, Wednesday and Friday" (commas are not tokens). `plural` for "Mondays". */
const weekdayList = (g: G, k: number, plural: boolean): { days: Array<number>; next: number; part?: Period } | undefined => {
  const days: Array<number> = []
  let at = k
  let part: Period | undefined
  for (;;) {
    const one = plural ? weekdayPluralAt(g, at) : weekdayAt(g, at)
    const compound = plural ? undefined : nlCompoundAt(g, at)
    if (one === undefined && compound === undefined) return undefined
    days.push(...(one ?? compound!.days))
    at++
    if (compound !== undefined) {
      if (part !== undefined && part !== compound.part) return undefined
      part = compound.part
    }
    if (is(g, at, g.language === "en" ? "and" : "en") && ((plural ? weekdayPluralAt(g, at + 1) : weekdayAt(g, at + 1) ?? nlCompoundAt(g, at + 1)?.days) !== undefined)) { at++; continue }
    if ((plural ? weekdayPluralAt(g, at) : weekdayAt(g, at) ?? nlCompoundAt(g, at)?.days) !== undefined) continue
    break
  }
  if (new Set(days).size !== days.length) return undefined // "every Monday and Monday", "every weekday and Friday"
  return { days: days.sort((a, b) => a - b), next: at, ...(part !== undefined ? { part } : {}) }
}

/** A whole number 2–99 in digits or words that ends at a unit. */
const countAt = (g: G, k: number): { value: number; next: number } | undefined => {
  const n = readNumber(g.toks, k, g.language)
  return n !== undefined && Number.isInteger(n.value) && n.value >= 2 && n.value <= 99 ? { value: n.value, next: n.next } : undefined
}
const ordinalAt = (g: G, k: number, min: number, max: number): { value: number; next: number } | undefined => {
  const o = readOrdinal(g.norms, k, g.language)
  return o !== undefined && o.value >= min && o.value <= max ? o : undefined
}
/** An ordinal weekday's ordinal: first–fifth, 1st–5th, last; Dutch eerste–vijfde, 1e–5e, laatste. */
const nthAt = (g: G, k: number): { value: number; next: number } | undefined =>
  is(g, k, g.language === "en" ? "last" : "laatste") ? { value: -1, next: k + 1 } : ordinalAt(g, k, 1, 5)

/** "every day", "every other week", "every second month", "every 3 years", "daily", "om de week", "elke twee weken". */
const intervalPhrase = (g: G, k: number): { unit: Unit; interval: number; next: number } | undefined => {
  const adverb = adverbs[g.language][g.norms[k] ?? ""]
  if (adverb !== undefined) return { ...adverb, next: k + 1 }
  if (g.language === "nl" && is(g, k, "om") && is(g, k + 1, "de")) {
    const u = unitSingular.nl[g.norms[k + 2] ?? ""]
    if (u !== undefined) return { unit: u, interval: 2, next: k + 3 }
    const n = countAt(g, k + 2)
    const pu = n === undefined ? undefined : unitPlural.nl[g.norms[n.next] ?? ""]
    return n !== undefined && pu !== undefined ? { unit: pu, interval: n.value, next: n.next + 1 } : undefined
  }
  if (!isEvery(g, k)) return undefined
  const u = unitSingular[g.language][g.norms[k + 1] ?? ""]
  if (u !== undefined) return { unit: u, interval: 1, next: k + 2 }
  if (g.language === "en" && is(g, k + 1, "other")) {
    const u2 = unitSingular.en[g.norms[k + 2] ?? ""]
    return u2 === undefined ? undefined : { unit: u2, interval: 2, next: k + 3 }
  }
  const o = ordinalAt(g, k + 1, 2, 31)
  if (o !== undefined) {
    const u2 = unitSingular[g.language][g.norms[o.next] ?? ""]
    return u2 === undefined ? undefined : { unit: u2, interval: o.value, next: o.next + 1 }
  }
  const n = countAt(g, k + 1)
  if (n !== undefined) {
    const pu = unitPlural[g.language][g.norms[n.next] ?? ""]
    return pu === undefined ? undefined : { unit: pu, interval: n.value, next: n.next + 1 }
  }
  return undefined
}

/** The days of the month: "the 1st and the 15th", "the first and fifteenth", "the last day", "de eerste en de vijftiende". */
const monthDayList = (g: G, k: number): { days: Array<number>; next: number } | undefined => {
  const the = g.language === "en" ? "the" : "de"
  const and = g.language === "en" ? "and" : "en"
  if (!is(g, k, the)) return undefined
  const days: Array<number> = []
  let at = k + 1
  for (;;) {
    if (is(g, at, g.language === "en" ? "last" : "laatste") && is(g, at + 1, g.language === "en" ? "day" : "dag")) { days.push(-1); at += 2 }
    else {
      const o = ordinalAt(g, at, 1, 31)
      if (o === undefined) return undefined
      days.push(o.value)
      at = o.next
    }
    if (is(g, at, and)) {
      const after = is(g, at + 1, the) ? at + 2 : at + 1
      if (ordinalAt(g, after, 1, 31) !== undefined || is(g, after, g.language === "en" ? "last" : "laatste")) { at = after; continue }
    }
    break
  }
  if (new Set(days).size !== days.length) return undefined
  return { days, next: at }
}

/** "the second Tuesday", "the last Friday", "de eerste maandag". */
const nthWeekdayPhrase = (g: G, k: number, article: boolean): { n: number; wd: number; next: number } | undefined => {
  let at = k
  if (article) {
    if (!is(g, at, g.language === "en" ? "the" : "de")) return undefined
    at++
  }
  const nth = nthAt(g, at)
  if (nth === undefined) return undefined
  const wd = weekdayOf(g.norms[nth.next] ?? "", g.language)
  return wd === undefined ? undefined : { n: nth.value, wd, next: nth.next + 1 }
}

/** "of the month", "of every month", "of every other month", "of every second month", "of every 3 months"; Dutch "van de maand", "van elke maand", "van elke tweede maand". */
const ofMonthTail = (g: G, k: number): { interval: number; next: number } | undefined => {
  if (!is(g, k, g.language === "en" ? "of" : "van")) return undefined
  if (is(g, k + 1, g.language === "en" ? "the" : "de") && is(g, k + 2, g.language === "en" ? "month" : "maand")) return { interval: 1, next: k + 3 }
  const p = intervalPhrase(g, k + 1)
  return p !== undefined && p.unit === "month" && adverbs[g.language][g.norms[k + 1] ?? ""] === undefined ? { interval: p.interval, next: p.next } : undefined
}

/** A date in a year: "3 March", "the 3rd of March", "March 3rd", "March the third"; Dutch "3 maart", "drie maart", "de derde maart". */
const yearDate = (g: G, k: number): { month: number; day: number; next: number } | undefined => {
  const the = g.language === "en" ? "the" : "de"
  const dayAt = (at: number) => ordinalAt(g, at, 1, 31) ?? (() => {
    const n = readNumber(g.toks, at, g.language)
    return n !== undefined && Number.isInteger(n.value) && n.value >= 1 && n.value <= 31 ? { value: n.value, next: n.next } : undefined
  })()
  const valid = (month: number, day: number, next: number) => (day <= maxDays[month - 1]! ? { month, day, next } : undefined)
  let at = k
  if (is(g, at, the)) at++
  const d = dayAt(at)
  if (d !== undefined) {
    let m = d.next
    if (g.language === "en" && is(g, m, "of")) m++
    const month = monthOf(g.norms[m] ?? "", g.language)
    return month === undefined ? undefined : valid(month, d.value, m + 1)
  }
  if (at !== k) return undefined
  const month = monthOf(g.norms[k] ?? "", g.language)
  if (month === undefined || g.language === "nl") return undefined
  let a = k + 1
  if (is(g, a, "the")) a++
  const dd = dayAt(a)
  return dd === undefined ? undefined : valid(month, dd.value, dd.next)
}

/** "in the evening" after the days is not read here (it is the time's); this is the bare part: "every Friday night". */
const partAt = (g: G, k: number, plural: boolean): Period | undefined => (plural ? partPlurals : partWords)[g.language][g.norms[k] ?? ""]

/** Every way the words from `k` on read as a rule (the caller keeps the ones that leave nothing unread). */
const bodies = (g: G, k: number): Array<Body> => {
  const out: Array<Body> = []
  const en = g.language === "en"
  const on = en ? "on" : "op"
  // An interval phrase, then what it may take: "every week on Monday", "every 2 months on the 15th", "every year on 3 March".
  const ip = intervalPhrase(g, k)
  if (ip !== undefined) {
    const freq: Freq = ip.unit === "day" ? "DAILY" : ip.unit === "week" ? "WEEKLY" : ip.unit === "month" ? "MONTHLY" : "YEARLY"
    out.push({ freq, interval: ip.interval, next: ip.next })
    if (is(g, ip.next, on)) {
      const at = ip.next + 1
      if (ip.unit === "week") {
        const l = weekdayList(g, at, false) ?? weekdayList(g, at, true)
        if (l !== undefined && l.part === undefined) out.push({ freq, interval: ip.interval, days: l.days, next: l.next })
      }
      if (ip.unit === "month") {
        const md = monthDayList(g, at)
        if (md !== undefined) out.push({ freq, interval: ip.interval, monthDays: md.days, next: md.next })
        const nth = nthWeekdayPhrase(g, at, true)
        if (nth !== undefined) out.push({ freq, interval: ip.interval, nth: { n: nth.n, wd: nth.wd }, next: nth.next })
      }
      if (ip.unit === "year") {
        const d = yearDate(g, at)
        if (d !== undefined) out.push({ freq, interval: ip.interval, date: { month: d.month, day: d.day }, next: d.next })
      }
    }
  }
  if (isEvery(g, k)) {
    // "every Monday and Friday [evening]", "every weekday morning", "elke vrijdagavond"
    const l = weekdayList(g, k + 1, false)
    if (l !== undefined) {
      const part = partAt(g, l.next, false)
      if (part !== undefined && l.part === undefined) out.push({ freq: "WEEKLY", interval: 1, days: l.days, part, next: l.next + 1 })
      out.push({ freq: "WEEKLY", interval: 1, days: l.days, ...(l.part !== undefined ? { part: l.part } : {}), next: l.next })
    }
    // "every other Tuesday", "every second Tuesday", "every third Friday": every few weeks. "every first Monday" is not read.
    const o = en && is(g, k + 1, "other") ? { value: 2, next: k + 2 } : ordinalAt(g, k + 1, 2, 5)
    if (o !== undefined) {
      const l2 = weekdayList(g, o.next, false)
      if (l2 !== undefined && l2.part === undefined) out.push({ freq: "WEEKLY", interval: o.value, days: l2.days, next: l2.next })
    }
    // "every morning", "elke avond"
    const part = partAt(g, k + 1, false)
    if (part !== undefined) out.push({ freq: "DAILY", interval: 1, part, next: k + 2 })
    // "every 2nd of the month", "every first of every month"
    const ord = ordinalAt(g, k + 1, 1, 31)
    if (ord !== undefined) {
      const tail = ofMonthTail(g, ord.next)
      if (tail !== undefined) out.push({ freq: "MONTHLY", interval: tail.interval, monthDays: [ord.value], next: tail.next })
    }
    // "every first Monday of the month", "elke laatste vrijdag van de maand"
    const nth = nthWeekdayPhrase(g, k + 1, false)
    if (nth !== undefined) {
      const tail = ofMonthTail(g, nth.next)
      if (tail !== undefined) out.push({ freq: "MONTHLY", interval: tail.interval, nth: { n: nth.n, wd: nth.wd }, next: tail.next })
    }
    // "every 3 March", "every March 3rd", "elke 3 maart"
    const d = yearDate(g, k + 1)
    if (d !== undefined) out.push({ freq: "YEARLY", interval: 1, date: { month: d.month, day: d.day }, next: d.next })
  }
  // [on] Mondays [and Thursdays] [evenings]; on Monday evenings; 's maandags
  {
    const at = is(g, k, on) ? k + 1 : g.language === "nl" && is(g, k, "s") ? k + 1 : k
    const pl = weekdayList(g, at, true)
    if (pl !== undefined) {
      const part = partAt(g, pl.next, true)
      if (part !== undefined) out.push({ freq: "WEEKLY", interval: 1, days: pl.days, part, next: pl.next + 1 })
      out.push({ freq: "WEEKLY", interval: 1, days: pl.days, next: pl.next })
    }
    const sg = en ? weekdayList(g, at, false) : undefined
    if (sg !== undefined && sg.part === undefined) {
      const part = partAt(g, sg.next, true)
      if (part !== undefined) out.push({ freq: "WEEKLY", interval: 1, days: sg.days, part, next: sg.next + 1 })
    }
  }
  // [on] the 1st [and the 15th] of the month / of every other month; [on] the last day of the month
  {
    const at = is(g, k, on) ? k + 1 : k
    const md = monthDayList(g, at)
    if (md !== undefined) {
      const tail = ofMonthTail(g, md.next)
      if (tail !== undefined) out.push({ freq: "MONTHLY", interval: tail.interval, monthDays: md.days, next: tail.next })
    }
    const nth = nthWeekdayPhrase(g, at, true)
    if (nth !== undefined) {
      const tail = ofMonthTail(g, nth.next)
      if (tail !== undefined) out.push({ freq: "MONTHLY", interval: tail.interval, nth: { n: nth.n, wd: nth.wd }, next: tail.next })
    }
    // [on] 3 March every year
    const d = yearDate(g, at)
    if (d !== undefined && isEvery(g, d.next) && unitSingular[g.language][g.norms[d.next + 1] ?? ""] === "year") {
      out.push({ freq: "YEARLY", interval: 1, date: { month: d.month, day: d.day }, next: d.next + 2 })
    }
  }
  return out
}

const timeLeads = dicts<Language, true>({ en: { at: true }, nl: { om: true } })

/** "at seven", "at half past seven in the evening", "om half acht": every reading. */
const timeClauses = (g: G, k: number): Array<{ match: TimeMatch; from: number; next: number }> => {
  if (timeLeads[g.language][g.norms[k] ?? ""] === undefined) return []
  return matchTimes(g.toks, k + 1, g.language, true).map((m) => ({ match: m, from: k, next: m.next }))
}

interface Reading {
  readonly body: Body
  readonly time?: { readonly match: TimeMatch; readonly from: number; readonly next: number }
}

/** The phrase as [time] rule [time] with at most one time, every token read. */
const readingsOf = (g: G): Array<Reading> => {
  const n = g.toks.length
  const out: Array<Reading> = []
  for (const b of bodies(g, 0)) {
    if (b.next === n) out.push({ body: b })
    for (const t of timeClauses(g, b.next)) if (t.next === n) out.push({ body: b, time: t })
  }
  for (const t of timeClauses(g, 0)) for (const b of bodies(g, t.next)) if (b.next === n) out.push({ body: b, time: t })
  return out
}

const wdCode = (n: number): RuleDay["weekday"] => weekdayCodes[((n - 1) % 7 + 7) % 7]!

/** The rule of a reading, with the time settled; `undefined` when the parts do not fit together. */
const settle = (r: Reading, options: RecurrenceOptions): { rule: RecurrenceRule; time?: TimeOfDay; clock: ClockTime; part?: Period } | undefined => {
  const { body } = r
  let time: TimeOfDay | undefined
  let smallHours = false
  if (r.time !== undefined) {
    const m = r.time.match
    if (m.hour === 24) return undefined // "every day at 24:00": a day later than said; say 00:00
    if (m.period !== undefined && body.part !== undefined && m.period !== body.part && m.period !== "am" && m.period !== "pm") return undefined
    const withPart: TimeMatch = body.part !== undefined && m.period === undefined ? { ...m, period: body.part } : m
    const resolved = resolveTime(withPart, options.band !== undefined ? { band: options.band } : {})
    if (resolved === undefined) return undefined
    if (body.part !== undefined && !periodHours(body.part, resolved.time.hour)) return undefined
    time = resolved.time
    smallHours = [time, ...time.alternatives].every((t) => t.hour < 6)
    // "every Friday at midnight": the start of Friday or its end. Only a daily rule, or a night ("every Friday night at midnight"), says.
    if (m.midnightWord && body.freq !== "DAILY" && body.part !== "night") return undefined
  }
  const partDefault = body.part === undefined ? undefined
    : options.defaultTime !== undefined && periodHours(body.part, options.defaultTime.hour) ? options.defaultTime : partTimes[body.part]
  const clock: ClockTime = time ?? partDefault ?? options.defaultTime ?? { hour: 9, minute: 0 }
  // "every Friday night at 1": the small hours after Friday evening are Saturday's.
  const shift = body.part === "night" && clock.hour < 6 && (time === undefined || smallHours) ? 1 : 0
  if (shift === 1 && body.freq !== "DAILY" && body.freq !== "WEEKLY") return undefined
  const byDay: Array<RuleDay> = body.days !== undefined ? body.days.map((d) => ({ weekday: wdCode(d + shift) }))
    : body.nth !== undefined ? [{ weekday: wdCode(body.nth.wd), nth: body.nth.n }] : []
  const rule: RecurrenceRule = {
    freq: body.freq, interval: body.interval,
    byDay: [...byDay].sort((a, b) => weekdayCodes.indexOf(a.weekday) - weekdayCodes.indexOf(b.weekday)),
    byMonthDay: body.monthDays !== undefined ? [...body.monthDays].sort((a, b) => (a < 0 ? 100 : a) - (b < 0 ? 100 : b)) : body.date !== undefined ? [body.date.day] : [],
    byMonth: body.date !== undefined ? [body.date.month] : []
  }
  if (rule.interval < 1 || rule.interval > 99 || formatRRule(rule) === undefined) return undefined
  return { rule, ...(time !== undefined ? { time } : {}), clock, ...(body.part !== undefined ? { part: body.part } : {}) }
}

/**
 * Build an RFC 5545 rule from a spoken recurrence, and its first occurrence after now. The text is the recurrence phrase alone (the
 * caller passes the words that say when, not a sentence to search), read by a closed grammar (README, "Spoken recurrence") in which
 * every word must be read: "every day", "daily", "every other day", "every 3 days", "every weekday", "every Monday and Friday",
 * "every second Tuesday" (every other week), "every week on Monday", "every month", "on the first of the month", "on the 1st and the
 * 15th of every month", "the second Tuesday of the month", "the last Friday of every month", "every 2 months on the 15th", "every year
 * on 3 March", "every 3 March", "every evening", "every Friday night", each with an optional time ("at nine", "at half past seven in
 * the evening"). Dutch: "elke dag", "dagelijks", "om de dag", "elke werkdag", "elke maandag en vrijdag", "elke tweede dinsdag", "om de
 * week", "op de eerste van de maand", "de laatste vrijdag van de maand", "elk jaar op 3 maart", "elke avond", "elke vrijdagavond",
 * "om half acht". Refused (`not-understood`): anything else — "every Monday or Friday", "the second Tuesday" alone, "every first
 * Monday", "every hour", "every day except Sunday", "every day until June", "every day at", "every Monday and", "every day in winter",
 * "every Friday at midnight". "every Friday night at 1" is Saturday 01:00. A time without am/pm is settled by the band (`guessed`);
 * without a time the part of the day's usual time, `defaultTime`, or 09:00. Plain "every week", "every month" and "every year" keep
 * today's weekday, day of the month or date (the first one after now that has it).
 */
export const parseRecurrence = (text: string, language: Language, options: RecurrenceOptions): Parsed<Recurrence> => {
  const zone = normalizeTimeZone(options.timeZone)
  const now = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : Number.NaN
  if (zone === undefined || !Number.isFinite(now) || typeof text !== "string") return notUnderstood
  const toks = tokenize(text)
  if (toks.length === 0 || !onlyWords(text, toks)) return notUnderstood
  const g: G = { toks, norms: toks.map((t) => t.norm), language }
  const nowParts = localParts(now, zone)
  const today: LocalDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day }
  const results: Array<Recurrence> = []
  for (const r of readingsOf(g)) {
    const ranges = [{ start: toks[0]!.start, end: toks[toks.length - 1]!.end }]
    if (!numbersWhole(text, toks, ranges)) return notUnderstood
    const s = settle(r, options)
    if (s === undefined) continue
    const built = firstAfter(s.rule, s.clock, today, now, zone)
    if (built === undefined) continue
    const rrule = formatRRule(s.rule)!
    const dtstart = formatDtstart(built.start, zone)!
    // The series as stored must give the start back.
    const read = readSeries({ rrule, dtstart, timeZone: zone })
    if (read.kind !== "ok" || seriesAfter(read.series, now, 1)[0] !== built.instant) continue
    const value: Recurrence = {
      rule: s.rule, rrule, ...(s.time !== undefined ? { time: s.time } : {}), ...(s.part !== undefined ? { partOfDay: s.part } : {}), timeDefaulted: s.time === undefined,
      start: built.start, startInstant: built.instant, dtstart, ics: `${dtstart}\nRRULE:${rrule}`, timeZone: zone
    }
    if (!results.some((x) => x.rrule === value.rrule && x.dtstart === value.dtstart)) results.push(value)
  }
  const said = text.slice(toks[0]!.start, toks[toks.length - 1]!.end)
  if (results.length === 0) return notUnderstood
  if (results.length > 1) return ambiguous(results, said, "The words read as more than one rule")
  return ok(results[0]!, said)
}

/**
 * The first instance after now: the first day from today the rule selects (with interval 1; DTSTART sets the phase), at `clock`,
 * whose moment is after now. A plain weekly, monthly or yearly rule takes today's weekday, day or date.
 */
const firstAfter = (rule: RecurrenceRule, clock: ClockTime, today: LocalDate, now: number, zone: string): { start: LocalDateTime; instant: number } | undefined => {
  for (let k = 0; k <= 366 * 8 + 31; k++) {
    const d = addDays(today, k)
    if (!ruleSelects(rule, today, d)) continue
    if (rule.freq === "MONTHLY" && rule.byDay.length + rule.byMonthDay.length === 0 && d.day !== today.day) continue
    if (rule.freq === "YEARLY" && rule.byMonth.length === 0 && (d.month !== today.month || d.day !== today.day)) continue
    if (d.day > daysInMonth(d.year, d.month)) continue
    const start = { ...d, hour: clock.hour, minute: clock.minute, second: 0 }
    const instant = zonedToInstant(start, zone)
    if (instant > now) return { start, instant }
  }
  return undefined
}
