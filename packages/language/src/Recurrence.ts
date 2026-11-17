import { dict, dicts } from "./Dict.ts"
import { numbersWhole, readNumber, type CharRange } from "./Numbers.ts"
import { formatDtstart, formatRRule, occurrencesAfter, weekdayCodes, type Freq, type RecurrenceRule, type RuleDay } from "./Rrule.ts"
import { notUnderstood, ok, type ClockTime, type Language, type LocalDateTime, type Parsed } from "./Result.ts"
import { matchTime, periodHours, resolveTime, type Period, type TimeOfDay, type TimeOptions } from "./Time.ts"
import { tokenize, type Tok } from "./Tokens.ts"
import { monthOf, readOrdinal, weekdayOf } from "./Words.ts"
import { addDays, localParts, normalizeTimeZone, zonedToInstant } from "./Zoned.ts"

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
  /** The first occurrence, a wall-clock time in `timeZone`; matches the rule. */
  readonly start: LocalDateTime
  readonly startInstant: number
  /** "DTSTART;TZID=Europe/Amsterdam:20261120T090000" */
  readonly dtstart: string
  /** `dtstart` and `RRULE:…` as two lines, ready for an iCalendar file or `nextOccurrence`. */
  readonly ics: string
  readonly timeZone: string
}

type Unit = "minute" | "hour" | "day" | "week" | "month" | "year"
type SymKind =
  | { readonly k: "every" }
  | { readonly k: "other" }
  | { readonly k: "and" }
  | { readonly k: "ord"; readonly n: number }
  | { readonly k: "num"; readonly n: number }
  | { readonly k: "unit"; readonly u: Unit }
  | { readonly k: "wd"; readonly days: ReadonlyArray<number> }
  | { readonly k: "month"; readonly n: number }
  | { readonly k: "part"; readonly p: Period }
  | { readonly k: "junk"; readonly stop: boolean }
/** A word (or words) of the text read as one symbol, with the tokens it came from, so `said` is the text as written. */
type Sym = SymKind & {
  readonly from: number
  readonly to: number
  /** "of" / "van" stood right before it ("the 2nd of the month", not "every second month"). */
  readonly afterOf: boolean
}

const everyWords = dicts<Language, true>({ en: { every: true, each: true }, nl: { elke: true, elk: true, iedere: true, ieder: true } })
const fillers = dicts<Language, true>({
  en: { on: true, the: true, of: true, at: true, a: true, an: true, in: true, s: true },
  nl: { op: true, de: true, het: true, van: true, in: true, aan: true, om: true, s: true, een: true }
})
/**
 * Words that add a condition this parser does not build (an exception, an end, a start, a count) or say when in another way.
 * Anywhere in the text they make it `not-understood` ("every day except weekends", "every day until December 1st",
 * "every Monday for 3 times", "every day from tomorrow"): review round 1, finding 11.
 */
const stopWords = dicts<Language, true>({
  en: {
    except: true, but: true, not: true, until: true, till: true, through: true, thru: true, ending: true, end: true, ends: true, starting: true, start: true,
    starts: true, from: true, beginning: true, after: true, before: true, unless: true, excluding: true, without: true, times: true, time: true, once: true,
    twice: true, between: true, since: true, during: true, today: true, tomorrow: true, tonight: true, yesterday: true, next: true, this: true, coming: true,
    previous: true, noon: true, midnight: true, am: true, pm: true, oclock: true, half: true, ago: true, only: true, odd: true, even: true
  },
  nl: {
    behalve: true, maar: true, niet: true, tot: true, totdat: true, vanaf: true, na: true, voor: true, voordat: true, zonder: true, uitgezonderd: true, keer: true,
    maal: true, eenmalig: true, tussen: true, sinds: true, gedurende: true, vandaag: true, morgen: true, overmorgen: true, vanavond: true, vannacht: true,
    volgende: true, deze: true, komende: true, aanstaande: true, middernacht: true, half: true, kwart: true, over: true, geleden: true, alleen: true, oneven: true, even: true
  }
})
const unitWords = dicts<Language, Unit>({
  en: { minute: "minute", minutes: "minute", hour: "hour", hours: "hour", day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year" },
  nl: { minuut: "minute", minuten: "minute", uur: "hour", uren: "hour", dag: "day", dagen: "day", week: "week", weken: "week", maand: "month", maanden: "month", jaar: "year", jaren: "year" }
})
const adverbs = dicts<Language, ReadonlyArray<SymKind>>({
  en: {
    daily: [{ k: "every" }, { k: "unit", u: "day" }], weekly: [{ k: "every" }, { k: "unit", u: "week" }], monthly: [{ k: "every" }, { k: "unit", u: "month" }],
    yearly: [{ k: "every" }, { k: "unit", u: "year" }], annually: [{ k: "every" }, { k: "unit", u: "year" }], hourly: [{ k: "every" }, { k: "unit", u: "hour" }],
    biweekly: [{ k: "every" }, { k: "other" }, { k: "unit", u: "week" }], fortnightly: [{ k: "every" }, { k: "other" }, { k: "unit", u: "week" }],
    fortnight: [{ k: "num", n: 2 }, { k: "unit", u: "week" }], quarterly: [{ k: "every" }, { k: "num", n: 3 }, { k: "unit", u: "month" }],
    quarter: [{ k: "num", n: 3 }, { k: "unit", u: "month" }],
    weekday: [{ k: "wd", days: [1, 2, 3, 4, 5] }], weekdays: [{ k: "wd", days: [1, 2, 3, 4, 5] }], workday: [{ k: "wd", days: [1, 2, 3, 4, 5] }], workdays: [{ k: "wd", days: [1, 2, 3, 4, 5] }],
    weekend: [{ k: "wd", days: [6, 7] }], weekends: [{ k: "wd", days: [6, 7] }]
  },
  nl: {
    dagelijks: [{ k: "every" }, { k: "unit", u: "day" }], wekelijks: [{ k: "every" }, { k: "unit", u: "week" }], maandelijks: [{ k: "every" }, { k: "unit", u: "month" }],
    jaarlijks: [{ k: "every" }, { k: "unit", u: "year" }], kwartaal: [{ k: "num", n: 3 }, { k: "unit", u: "month" }],
    werkdag: [{ k: "wd", days: [1, 2, 3, 4, 5] }], werkdagen: [{ k: "wd", days: [1, 2, 3, 4, 5] }],
    weekend: [{ k: "wd", days: [6, 7] }], weekenden: [{ k: "wd", days: [6, 7] }]
  }
})
const parts = dicts<Language, Period>({
  en: { morning: "morning", mornings: "morning", afternoon: "afternoon", afternoons: "afternoon", evening: "evening", evenings: "evening", night: "night", nights: "night" },
  nl: { ochtend: "morning", ochtends: "morning", morgens: "morning", middag: "afternoon", middags: "afternoon", avond: "evening", avonds: "evening", nacht: "night", nachts: "night" }
})
/** The usual clock time of a part of the day said without one ("every evening"). */
const partTimes = dict<ClockTime>({ morning: { hour: 8, minute: 0 }, afternoon: { hour: 14, minute: 0 }, evening: { hour: 19, minute: 0 }, night: { hour: 22, minute: 0 } })

const weekdayOfWord = (w: string, language: Language): number | undefined => {
  const direct = weekdayOf(w, language)
  if (direct !== undefined) return direct
  if (w.endsWith("s")) return weekdayOf(w.slice(0, -1), language)
  if (language === "nl" && w.endsWith("en")) return weekdayOf(w.slice(0, -2), language)
  return undefined
}

/** Read the tokens outside the time into symbols; `skip` holds the tokens of the time, which are not symbols. */
const symbolize = (toks: ReadonlyArray<Tok>, skip: ReadonlySet<number>, language: Language): Array<Sym> => {
  const norms = toks.map((t) => t.norm)
  // The time's tokens read as nothing, so a number cannot run into them.
  const masked = toks.map((t, k) => (skip.has(k) ? { ...t, norm: "\u0000" } : t))
  const syms: Array<Sym> = []
  let afterOf = false
  const push = (s: SymKind, from: number, to: number) => { syms.push({ ...s, from, to, afterOf } as Sym); afterOf = false }
  for (let i = 0; i < toks.length; i++) {
    if (skip.has(i)) { afterOf = false; continue }
    const w = norms[i]!
    // "om de week" = "every other week", "om de twee weken" = every two weeks
    if (language === "nl" && w === "om" && norms[i + 1] === "de" && !skip.has(i + 1)) { push({ k: "every" }, i, i + 1); push({ k: "other" }, i + 1, i + 2); i++; continue }
    if (everyWords[language][w] !== undefined) { push({ k: "every" }, i, i + 1); continue }
    if (w === "other" || w === "andere") { push({ k: "other" }, i, i + 1); continue }
    if (w === "and" || w === "en" || w === "or" || (w === "of" && language === "nl")) { push({ k: "and" }, i, i + 1); continue }
    if (fillers[language][w] !== undefined) { if (w === "of" || w === "van") afterOf = true; continue }
    if (w === "last" || w === "laatste") { push({ k: "ord", n: -1 }, i, i + 1); continue }
    const adv = adverbs[language][w]
    if (adv !== undefined) { for (const a of adv) push(a, i, i + 1); continue }
    const ord = readOrdinal(norms, i, language)
    if (ord !== undefined) { push({ k: "ord", n: ord.value }, i, ord.next); i = ord.next - 1; continue }
    const u = unitWords[language][w]
    if (u !== undefined) { push({ k: "unit", u }, i, i + 1); continue }
    const wd = weekdayOfWord(w, language)
    if (wd !== undefined) { push({ k: "wd", days: [wd] }, i, i + 1); continue }
    const month = monthOf(w, language)
    if (month !== undefined && (w.length > 3 || /^\d/.test(norms[i - 1] ?? "") || /^\d/.test(norms[i + 1] ?? ""))) { push({ k: "month", n: month }, i, i + 1); continue }
    const part = parts[language][w]
    if (part !== undefined) { push({ k: "part", p: part }, i, i + 1); continue }
    const num = readNumber(masked, i, language)
    if (num !== undefined && Number.isInteger(num.value) && num.value >= 1 && num.value <= 1000) { push({ k: "num", n: num.value }, i, num.next); i = num.next - 1; continue }
    push({ k: "junk", stop: stopWords[language][w] !== undefined || /\d/.test(w) || num !== undefined }, i, i + 1)
  }
  return syms
}

const wdCode = (n: number): RuleDay["weekday"] => weekdayCodes[n - 1]!
const rule = (freq: Freq, interval: number, extra: Partial<Pick<RecurrenceRule, "byDay" | "byMonthDay" | "byMonth">> = {}): RecurrenceRule =>
  ({ freq, interval, byDay: [], byMonthDay: [], byMonth: [], ...extra })
const unitFreq: Record<Unit, Freq> = { minute: "MINUTELY", hour: "HOURLY", day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" }

interface Matched {
  readonly rule: RecurrenceRule
  readonly part?: Period
  /** The symbol after the last one read. */
  readonly next: number
}

/**
 * Read the symbols of a spoken recurrence, starting at `i0`, into a rule, and say how far it read. The caller refuses the text when
 * a symbol about when is left over, so nothing said is silently dropped.
 */
const matchRule = (s: ReadonlyArray<Sym>, i0: number): Matched | undefined => {
  const at = (k: number): Sym | undefined => (s[k]?.k === "junk" ? undefined : s[k])
  let i = i0
  const fromEvery = at(i)?.k === "every"
  if (fromEvery) i++
  let part: Period | undefined
  const done = (r: RecurrenceRule, next: number): Matched | undefined => {
    // A part of the day after the rule: "every Tuesday and Thursday evening", "every weekday morning".
    let k = next
    const p = at(k)
    if (p?.k === "part") {
      if (part !== undefined && part !== p.p) return undefined
      part = p.p
      k++
    }
    if (r.interval < 1 || r.interval > 1000) return undefined
    return part === undefined ? { rule: r, next: k } : { rule: r, part, next: k }
  }
  const readWeekdays = (from: number): { days: Array<number>; next: number } => {
    const days: Array<number> = []
    let k = from
    for (;;) {
      const x = at(k)
      if (x?.k === "wd") { days.push(...x.days); k++; continue }
      if (x?.k === "and" && at(k + 1)?.k === "wd") { k++; continue }
      break
    }
    return { days: [...new Set(days)].sort((a, b) => a - b), next: k }
  }
  /** Ordinals ("the 1st and 15th", "the last day"); an "every" between them and the unit ("of every month") is read too. */
  const readOrds = (from: number): { ords: Array<number>; next: number; everyAfter: boolean } => {
    const ords: Array<number> = []
    let k = from
    let everyAfter = false
    for (;;) {
      const x = at(k)
      if (x?.k === "ord") {
        const y = at(k + 1)
        if (x.n === -1 && y?.k === "unit" && y.u === "day") { ords.push(-1); k += 2; continue }
        ords.push(x.n); k++; continue
      }
      if (x?.k === "and" && at(k + 1)?.k === "ord") { k++; continue }
      if (x?.k === "every" && ords.length > 0) { everyAfter = true; k++; continue }
      break
    }
    return { ords: [...new Set(ords)], next: k, everyAfter }
  }
  const monthly = (k: number): { interval: number; next: number } | undefined => {
    // "of the month", "of every month", "of every 2 months", "van elke maand"
    let j = k
    if (at(j)?.k === "every") j++
    const n = at(j)
    if (n?.k === "num" && at(j + 1)?.k === "unit" && (at(j + 1) as { u: Unit }).u === "month") return { interval: n.n, next: j + 2 }
    if (n?.k === "unit" && n.u === "month") return { interval: 1, next: j + 1 }
    return undefined
  }
  const yearSuffix = (k: number): number => (at(k)?.k === "every" && at(k + 1)?.k === "unit" && (at(k + 1) as { u: Unit }).u === "year" ? k + 2 : at(k)?.k === "unit" && (at(k) as { u: Unit }).u === "year" && at(k - 1)?.k === "every" ? k + 1 : k)
  let interval = 1
  const first = at(i)
  if (first === undefined) return undefined
  if (first.k === "other") {
    interval = 2
    i++
    const n = at(i)
    if (n?.k === "num") { interval = n.n; i++ }
  } else if (first.k === "num") {
    const nx = at(i + 1)
    if (nx?.k === "month") {
      // "elke 3 maart": a date every year
      return first.n >= 1 && first.n <= 31 ? done(rule("YEARLY", 1, { byMonth: [nx.n], byMonthDay: [first.n] }), yearSuffix(i + 2)) : undefined
    }
    if (nx?.k !== "unit") return undefined
    interval = first.n
    i++
  } else if (first.k === "ord" && fromEvery && first.n >= 2) {
    // "every second month", "every third day", "elke tweede maand": an interval, not a day of the month.
    const u = at(i + 1)
    if (u?.k === "unit" && !u.afterOf) { interval = first.n; i++ }
  }
  const x = at(i)
  if (x === undefined) return undefined
  if (x.k === "part") {
    if (interval !== 1) return undefined
    part = x.p
    return done(rule("DAILY", 1), i + 1)
  }
  if (x.k === "unit") {
    const freq = unitFreq[x.u]
    if (x.u === "day") {
      const p = at(i + 1)
      if (p?.k === "part") { part = p.p; return done(rule(freq, interval), i + 2) }
      return done(rule(freq, interval), i + 1)
    }
    if (x.u === "week") {
      const wd = readWeekdays(i + 1)
      return done(rule(freq, interval, { byDay: wd.days.map((d) => ({ weekday: wdCode(d) })) }), wd.next)
    }
    if (x.u === "month") {
      const o = readOrds(i + 1)
      if (o.everyAfter) return undefined
      const wd = at(o.next)?.k === "wd" && o.ords.length > 0 ? readWeekdays(o.next) : undefined
      if (wd !== undefined) {
        // "every month on the first Monday"
        if (o.ords.some((n) => n < -5 || n > 5)) return undefined
        return done(rule(freq, interval, { byDay: wd.days.flatMap((d) => o.ords.map((n) => ({ weekday: wdCode(d), nth: n }))) }), wd.next)
      }
      return done(rule(freq, interval, { byMonthDay: o.ords }), o.next)
    }
    if (x.u === "year") {
      const a = at(i + 1)
      const b = at(i + 2)
      if (a?.k === "month" && (b?.k === "ord" || b?.k === "num")) return b.n <= 31 ? done(rule(freq, interval, { byMonth: [a.n], byMonthDay: [b.n] }), i + 3) : undefined
      if ((a?.k === "ord" || a?.k === "num") && b?.k === "month") return a.n >= 1 && a.n <= 31 ? done(rule(freq, interval, { byMonth: [b.n], byMonthDay: [a.n] }), i + 3) : undefined
      return done(rule(freq, interval), i + 1)
    }
    return done(rule(freq, interval), i + 1)
  }
  if (x.k === "ord") {
    if (interval !== 1) return undefined
    const o = readOrds(i)
    const next = at(o.next)
    if (next?.k === "wd" && o.ords.length > 0 && !o.everyAfter) {
      const wd = readWeekdays(o.next)
      const ofMonth = monthly(wd.next)
      if (o.ords.some((n) => n < -5 || n > 5)) return undefined
      const nth = wd.days.flatMap((d) => o.ords.map((n) => ({ weekday: wdCode(d), nth: n })))
      if (ofMonth !== undefined) return done(rule("MONTHLY", ofMonth.interval, { byDay: nth }), ofMonth.next)
      const ordinal = o.ords[0]!
      // "every first Monday", "the last Friday", "the first and third Monday": in a month. "every second Tuesday": every other week.
      if (o.ords.length > 1 || ordinal === 1 || ordinal === -1) return done(rule("MONTHLY", 1, { byDay: nth }), wd.next)
      return done(rule("WEEKLY", ordinal, { byDay: wd.days.map((d) => ({ weekday: wdCode(d) })) }), wd.next)
    }
    const ofMonth = monthly(o.everyAfter ? o.next - 1 : o.next)
    if (ofMonth !== undefined && o.ords.length > 0) return done(rule("MONTHLY", ofMonth.interval, { byMonthDay: o.ords }), ofMonth.next)
    if (next?.k === "month" && o.ords.length === 1 && o.ords[0]! > 0) return done(rule("YEARLY", 1, { byMonth: [next.n], byMonthDay: [o.ords[0]!] }), yearSuffix(o.next + 1))
    return undefined
  }
  if (x.k === "wd") {
    const wd = readWeekdays(i)
    let k = wd.next
    // "every Monday of every week" adds nothing; "every Monday of the month" is not a rule this reads.
    if (at(k)?.k === "every" && at(k + 1)?.k === "unit" && (at(k + 1) as { u: Unit }).u === "week") k += 2
    return done(rule("WEEKLY", interval, { byDay: wd.days.map((d) => ({ weekday: wdCode(d) })) }), k)
  }
  if (x.k === "month") {
    const b = at(i + 1)
    if ((b?.k === "ord" || b?.k === "num") && b.n >= 1 && b.n <= 31 && interval === 1) return done(rule("YEARLY", 1, { byMonth: [x.n], byMonthDay: [b.n] }), yearSuffix(i + 2))
    return undefined
  }
  return undefined
}

const leads = dicts<Language, true>({ en: { at: true, around: true, about: true }, nl: { om: true, rond: true, tegen: true } })

/**
 * Build an RFC 5545 rule from spoken words: "every day", "every weekday", "every Monday", "every second Tuesday" (every other week),
 * "every second month" (every other month), "the first Monday of every month", "on the first of the month", "every 3 days",
 * "every year on March 3rd", "weekly", "every evening", with an optional time ("every day at nine", "every Monday at half past seven").
 * Dutch: "elke dag", "elke werkdag", "elke tweede dinsdag", "om de week", "elke eerste maandag van de maand", "op de eerste van de maand",
 * "elk jaar op 3 maart", "elke avond". The result has the `RRULE`, a DTSTART in the zone that is the first occurrence after now, and
 * both as iCalendar lines. A part of the day is kept: "every evening" starts at 19:00, not 09:00, and "every morning at 7 pm" is refused.
 * Anything this does not build (an exception, an end, a start, a count: "every day except weekends", "every day until December 1st",
 * "every Monday for 3 times") or a time it cannot read ("every day at 25:00") is `not-understood`, never the part that was recognised.
 */
export const parseRecurrence = (text: string, language: Language, options: RecurrenceOptions): Parsed<Recurrence> => {
  const zone = normalizeTimeZone(options.timeZone)
  const now = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : Number.NaN
  if (zone === undefined || !Number.isFinite(now) || typeof text !== "string") return notUnderstood
  const toks = tokenize(text)
  // 1. the time of day
  let timeAt: { from: number; cut: number; match: NonNullable<ReturnType<typeof matchTime>> } | undefined
  for (let i = 0; i < toks.length && timeAt === undefined; i++) {
    const prev = toks[i - 1]?.norm
    // "elke twee uur" is an interval, not a time
    if (prev !== undefined && everyWords[language][prev] !== undefined) continue
    const m = matchTime(toks, i, language, prev !== undefined && leads[language][prev] !== undefined)
    if (m !== undefined) timeAt = { from: i, cut: prev !== undefined && leads[language][prev] !== undefined ? i - 1 : i, match: m }
  }
  const skip = new Set<number>()
  if (timeAt !== undefined) for (let k = timeAt.cut; k < timeAt.match.next; k++) skip.add(k)
  // A second time ("every day at 9 and at 5") is a second rule, which this does not build.
  if (timeAt !== undefined) {
    for (let i = timeAt.match.next; i < toks.length; i++) {
      const prev = toks[i - 1]?.norm
      if (matchTime(toks, i, language, prev !== undefined && leads[language][prev] !== undefined) !== undefined) return notUnderstood
    }
  }
  // 2. the rule: the first place the words read as one
  const syms = symbolize(toks, skip, language)
  let matched: Matched | undefined
  let begin = 0
  for (; begin < syms.length; begin++) {
    if (syms[begin]!.k === "junk") continue
    matched = matchRule(syms, begin)
    if (matched !== undefined) break
  }
  if (matched === undefined) return notUnderstood
  // Nothing about when may be left over, before or after the rule, and no word that adds a condition.
  for (let k = 0; k < syms.length; k++) {
    if (k >= begin && k < matched.next) continue
    const x = syms[k]!
    if (x.k === "junk") { if (x.stop) return notUnderstood; continue }
    if (x.k === "and") continue
    if (x.k === "num") {
      // A number in the title ("take 2 pills every day") is fine; one next to the rule or a unit is not.
      const near = (j: number) => { const y = syms[j]; return y !== undefined && y.k !== "junk" && y.k !== "and" }
      const before = toks[x.from - 1]?.norm
      const joined = before !== undefined && (leads[language][before] !== undefined || ["and", "en", "or", "of", "plus"].includes(before))
      if (joined || k === matched.next || k === begin - 1 || near(k + 1) || near(k - 1)) return notUnderstood
      continue
    }
    return notUnderstood
  }
  const r = matched.rule
  // "on the 15th of every month": the fillers right before the first symbol belong to what was said.
  let first = syms[begin]!.from
  while (first > 0 && !skip.has(first - 1) && fillers[language][toks[first - 1]!.norm] !== undefined && toks[first - 1]!.norm !== "of" && toks[first - 1]!.norm !== "van") first--
  const ruleRange: CharRange = { start: toks[first]!.start, end: toks[syms[matched.next - 1]!.to - 1]!.end }
  const timeRange: CharRange | undefined = timeAt === undefined ? undefined : { start: toks[timeAt.cut]!.start, end: toks[timeAt.match.next - 1]!.end }
  if (!numbersWhole(text, toks, timeRange === undefined ? [ruleRange] : [ruleRange, timeRange])) return notUnderstood
  // 3. the time
  let time: TimeOfDay | undefined
  if (timeAt !== undefined) {
    const withPart = matched.part !== undefined && timeAt.match.period === undefined ? { ...timeAt.match, period: matched.part } : timeAt.match
    const resolved = resolveTime(withPart, options.band !== undefined ? { band: options.band } : {})
    if (resolved === undefined) return notUnderstood
    if (matched.part !== undefined && !periodHours(matched.part, resolved.time.hour)) return notUnderstood
    time = resolved.time
  }
  if (time !== undefined && (r.freq === "HOURLY" || r.freq === "MINUTELY")) return notUnderstood // "every hour at seven"
  const partDefault = matched.part === undefined ? undefined : options.defaultTime !== undefined && periodHours(matched.part, options.defaultTime.hour) ? options.defaultTime : partTimes[matched.part]
  const clock: ClockTime = time ?? partDefault ?? options.defaultTime ?? { hour: 9, minute: 0 }
  const said = text.slice(Math.min(ruleRange.start, timeRange?.start ?? Infinity), Math.max(ruleRange.end, timeRange?.end ?? -Infinity))
  // 4. the first occurrence after now, matching the rule (alignment of "every other week" starts there)
  const nowParts = localParts(now, zone)
  let start: LocalDateTime
  if (r.freq === "HOURLY" || r.freq === "MINUTELY") {
    const step = (r.freq === "HOURLY" ? 3_600_000 : 60_000) * r.interval
    const p = localParts(Math.floor(now / 60_000) * 60_000 + step, zone)
    start = { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute }
  } else {
    // Expand the rule (interval 1) from a start well before now; that start is the first instance whether it matches or not, so it
    // lies in the past, and the first instance after now is the first one that matches. Weekly rules keep today's weekday
    // (52 weeks back), monthly and yearly ones today's day of the month (4 years back, so 29 February too).
    const back = r.freq === "DAILY" ? addDays(nowParts, -2) : r.freq === "WEEKLY" ? addDays(nowParts, -364) : { year: nowParts.year - 4, month: nowParts.month, day: nowParts.day }
    const probe = occurrencesAfter({ rrule: formatRRule({ ...r, interval: 1 }), dtstart: formatDtstart({ ...back, ...clock }, zone), timeZone: zone }, now, 1)[0]
    if (probe === undefined) return notUnderstood
    const p = localParts(probe, zone)
    start = { year: p.year, month: p.month, day: p.day, ...clock }
  }
  const rrule = formatRRule(r)
  const dtstart = formatDtstart(start, zone)
  return ok({
    rule: r, rrule, ...(time !== undefined ? { time } : {}), ...(matched.part !== undefined ? { partOfDay: matched.part } : {}), timeDefaulted: time === undefined,
    start, startInstant: zonedToInstant(start, zone), dtstart, ics: `${dtstart}\nRRULE:${rrule}`, timeZone: zone
  }, said)
}
