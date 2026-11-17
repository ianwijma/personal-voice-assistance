import { readNumber } from "./Numbers.ts"
import { formatDtstart, formatRRule, occurrencesAfter, weekdayCodes, type Freq, type RecurrenceRule, type RuleDay } from "./Rrule.ts"
import { notUnderstood, ok, type ClockTime, type Language, type LocalDate, type LocalDateTime, type Parsed } from "./Result.ts"
import { matchTime, resolveTime, type Period, type TimeOfDay, type TimeOptions } from "./Time.ts"
import { tokenize, type Tok } from "./Tokens.ts"
import { monthOf, readOrdinal, weekdayOf } from "./Words.ts"
import { localParts, zonedToInstant } from "./Zoned.ts"

export interface RecurrenceOptions extends Omit<TimeOptions, "afterMinutes"> {
  readonly now: number | Date
  readonly timeZone: string
  /** The time of day when none is said ("every Monday"). Default 09:00. */
  readonly defaultTime?: ClockTime
}

export interface Recurrence {
  readonly rule: RecurrenceRule
  /** The `RRULE` value: "FREQ=WEEKLY;BYDAY=MO". */
  readonly rrule: string
  /** The time said, if any (with its am/pm guess). */
  readonly time?: TimeOfDay
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
type Sym =
  | { readonly k: "every" }
  | { readonly k: "other" }
  | { readonly k: "and" }
  | { readonly k: "ord"; readonly n: number }
  | { readonly k: "num"; readonly n: number }
  | { readonly k: "unit"; readonly u: Unit }
  | { readonly k: "wd"; readonly days: ReadonlyArray<number> }
  | { readonly k: "month"; readonly n: number }
  | { readonly k: "part"; readonly p: Period }
  | { readonly k: "junk" }

const everyWords: Record<Language, ReadonlySet<string>> = { en: new Set(["every", "each"]), nl: new Set(["elke", "elk", "iedere", "ieder"]) }
const fillers: Record<Language, ReadonlySet<string>> = {
  en: new Set(["on", "the", "of", "at", "a", "an", "in", "s"]),
  nl: new Set(["op", "de", "het", "van", "in", "aan", "om", "s", "een"])
}
const unitWords: Record<Language, Record<string, Unit>> = {
  en: { minute: "minute", minutes: "minute", hour: "hour", hours: "hour", day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year" },
  nl: { minuut: "minute", minuten: "minute", uur: "hour", uren: "hour", dag: "day", dagen: "day", week: "week", weken: "week", maand: "month", maanden: "month", jaar: "year", jaren: "year" }
}
const adverbs: Record<Language, Record<string, ReadonlyArray<Sym>>> = {
  en: {
    daily: [{ k: "every" }, { k: "unit", u: "day" }], weekly: [{ k: "every" }, { k: "unit", u: "week" }], monthly: [{ k: "every" }, { k: "unit", u: "month" }],
    yearly: [{ k: "every" }, { k: "unit", u: "year" }], annually: [{ k: "every" }, { k: "unit", u: "year" }], hourly: [{ k: "every" }, { k: "unit", u: "hour" }],
    biweekly: [{ k: "every" }, { k: "other" }, { k: "unit", u: "week" }], fortnightly: [{ k: "every" }, { k: "other" }, { k: "unit", u: "week" }],
    fortnight: [{ k: "num", n: 2 }, { k: "unit", u: "week" }], quarterly: [{ k: "every" }, { k: "num", n: 3 }, { k: "unit", u: "month" }], quarter: [{ k: "num", n: 3 }, { k: "unit", u: "month" }],
    weekday: [{ k: "wd", days: [1, 2, 3, 4, 5] }], weekdays: [{ k: "wd", days: [1, 2, 3, 4, 5] }], workday: [{ k: "wd", days: [1, 2, 3, 4, 5] }], workdays: [{ k: "wd", days: [1, 2, 3, 4, 5] }],
    weekend: [{ k: "wd", days: [6, 7] }], weekends: [{ k: "wd", days: [6, 7] }]
  },
  nl: {
    dagelijks: [{ k: "every" }, { k: "unit", u: "day" }], wekelijks: [{ k: "every" }, { k: "unit", u: "week" }], maandelijks: [{ k: "every" }, { k: "unit", u: "month" }],
    jaarlijks: [{ k: "every" }, { k: "unit", u: "year" }], kwartaal: [{ k: "num", n: 3 }, { k: "unit", u: "month" }],
    werkdag: [{ k: "wd", days: [1, 2, 3, 4, 5] }], werkdagen: [{ k: "wd", days: [1, 2, 3, 4, 5] }],
    weekend: [{ k: "wd", days: [6, 7] }], weekenden: [{ k: "wd", days: [6, 7] }]
  }
}
const parts: Record<Language, Record<string, Period>> = {
  en: { morning: "morning", mornings: "morning", afternoon: "afternoon", afternoons: "afternoon", evening: "evening", evenings: "evening", night: "night", nights: "night" },
  nl: { ochtend: "morning", ochtends: "morning", morgens: "morning", middag: "afternoon", middags: "afternoon", avond: "evening", avonds: "evening", nacht: "night", nachts: "night" }
}

const weekdayOfWord = (w: string, language: Language): number | undefined => {
  const direct = weekdayOf(w, language)
  if (direct !== undefined) return direct
  if (language === "en" && w.endsWith("s")) return weekdayOf(w.slice(0, -1), "en")
  if (language === "nl" && w.endsWith("s")) return weekdayOf(w.slice(0, -1), "nl")
  if (language === "nl" && w.endsWith("en")) return weekdayOf(w.slice(0, -2), "nl")
  return undefined
}

const symbolize = (norms: ReadonlyArray<string>, toks: ReadonlyArray<Tok>, language: Language): Array<Sym> => {
  // "om de week" = "every other week" (before fillers go)
  const words: Array<string> = []
  for (let i = 0; i < norms.length; i++) {
    if (language === "nl" && norms[i] === "om" && norms[i + 1] === "de") { words.push("elke", "andere"); i++ } else words.push(norms[i]!)
  }
  const syms: Array<Sym> = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (everyWords[language].has(w)) { syms.push({ k: "every" }); continue }
    if (w === "other" || w === "andere") { syms.push({ k: "other" }); continue }
    if (w === "and" || w === "en" || w === "or") { syms.push({ k: "and" }); continue }
    if (fillers[language].has(w)) continue
    if (w === "last" || w === "laatste") { syms.push({ k: "ord", n: -1 }); continue }
    const adv = adverbs[language][w]
    if (adv !== undefined) { syms.push(...adv); continue }
    const ord = readOrdinal(words, i, language)
    if (ord !== undefined) { syms.push({ k: "ord", n: ord.value }); i = ord.next - 1; continue }
    const u = unitWords[language][w]
    if (u !== undefined) { syms.push({ k: "unit", u }); continue }
    const wd = weekdayOfWord(w, language)
    if (wd !== undefined) { syms.push({ k: "wd", days: [wd] }); continue }
    const month = monthOf(w, language)
    if (month !== undefined) { syms.push({ k: "month", n: month }); continue }
    const part = parts[language][w]
    if (part !== undefined) { syms.push({ k: "part", p: part }); continue }
    const num = readNumber(toks.map((t, k) => ({ ...t, norm: words[k] ?? t.norm })), i, language)
    if (num !== undefined && Number.isInteger(num.value) && num.value >= 1 && num.value <= 1000) { syms.push({ k: "num", n: num.value }); i = num.next - 1; continue }
    syms.push({ k: "junk" })
  }
  return syms
}

const wdCode = (n: number): RuleDay["weekday"] => weekdayCodes[n - 1]!
const empty = { byDay: [] as Array<RuleDay>, byMonthDay: [] as Array<number>, byMonth: [] as Array<number> }
const rule = (freq: Freq, interval: number, extra: Partial<Omit<RecurrenceRule, "freq" | "interval">> = {}): RecurrenceRule => ({ freq, interval, ...empty, ...extra })
const unitFreq: Record<Unit, Freq> = { minute: "MINUTELY", hour: "HOURLY", day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" }

/** Read the symbols of a spoken recurrence into a rule. */
const matchRule = (s: ReadonlyArray<Sym>): { rule: RecurrenceRule; part?: Period } | undefined => {
  let i = 0
  const at = (k: number): Sym | undefined => s[k]
  if (at(0)?.k === "every") i++
  let part: Period | undefined
  const withPart = (r: RecurrenceRule): { rule: RecurrenceRule; part?: Period } => (part === undefined ? { rule: r } : { rule: r, part })
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
  const readOrds = (from: number): { ords: Array<number>; next: number } => {
    const ords: Array<number> = []
    let k = from
    for (;;) {
      const x = at(k)
      if (x?.k === "ord") {
        if (x.n === -1 && at(k + 1)?.k === "unit" && (at(k + 1) as { u: Unit }).u === "day") { ords.push(-1); k += 2; continue }
        ords.push(x.n); k++; continue
      }
      if (x?.k === "and" && (at(k + 1)?.k === "ord")) { k++; continue }
      if (x?.k === "every" && ords.length > 0) { k++; continue }
      break
    }
    return { ords, next: k }
  }
  let interval = 1
  let ordinal: number | undefined
  const first = at(i)
  if (first === undefined) return undefined
  if (first.k === "other") {
    interval = 2
    i++
    const n = at(i)
    if (n?.k === "num") { interval = n.n; i++ }
  } else if (first.k === "num" && (at(i + 1)?.k === "unit" || at(i + 1)?.k === "month")) {
    if (at(i + 1)?.k === "month") {
      // "elke 3 maart": a date every year
      const day = first.n
      const m = at(i + 1) as { n: number }
      return day >= 1 && day <= 31 ? withPart(rule("YEARLY", 1, { byMonth: [m.n], byMonthDay: [day] })) : undefined
    }
    interval = first.n
    i++
  }
  const x = at(i)
  if (x === undefined) return undefined
  if (x.k === "part") { part = x.p; return withPart(rule("DAILY", interval)) }
  if (x.k === "unit") {
    const freq = unitFreq[x.u]
    const next = at(i + 1)
    if (x.u === "day") {
      if (next?.k === "part") part = next.p
      return withPart(rule(freq, interval))
    }
    if (x.u === "week") {
      const wd = readWeekdays(i + 1)
      return withPart(rule(freq, interval, { byDay: wd.days.map((d) => ({ weekday: wdCode(d) })) }))
    }
    if (x.u === "month") {
      const o = readOrds(i + 1)
      return withPart(rule(freq, interval, { byMonthDay: o.ords }))
    }
    if (x.u === "year") {
      const a = at(i + 1)
      const b = at(i + 2)
      if (a?.k === "month" && (b?.k === "ord" || b?.k === "num")) return withPart(rule(freq, interval, { byMonth: [a.n], byMonthDay: [b.n] }))
      if ((a?.k === "ord" || a?.k === "num") && b?.k === "month") return withPart(rule(freq, interval, { byMonth: [b.n], byMonthDay: [a.n] }))
      return withPart(rule(freq, interval))
    }
    return withPart(rule(freq, interval))
  }
  if (x.k === "ord") {
    const o = readOrds(i)
    const next = at(o.next)
    if (next?.k === "wd" && o.ords.length > 0) {
      const wd = readWeekdays(o.next)
      const monthly = (() => { for (let k = wd.next; k < s.length; k++) { const y = at(k); if (y?.k === "unit") return y.u === "month"; if (y?.k !== "every") break } return false })()
      ordinal = o.ords[0]
      if (monthly || ordinal === 1 || ordinal === -1) return withPart(rule("MONTHLY", interval, { byDay: wd.days.flatMap((d) => o.ords.map((n) => ({ weekday: wdCode(d), nth: n }))) }))
      return withPart(rule("WEEKLY", interval * ordinal!, { byDay: wd.days.map((d) => ({ weekday: wdCode(d) })) }))
    }
    if (next?.k === "unit" && next.u === "month") {
      let n = o.next + 1
      if (at(n)?.k === "num" && (at(n + 1) as { u?: Unit } | undefined)?.u === "month") n += 2
      return withPart(rule("MONTHLY", interval, { byMonthDay: o.ords }))
    }
    if (next?.k === "month") return withPart(rule("YEARLY", interval, { byMonth: [next.n], byMonthDay: [o.ords[0]!] }))
    if (next?.k === "num" && at(o.next + 1)?.k === "unit" && (at(o.next + 1) as { u: Unit }).u === "month") {
      return withPart(rule("MONTHLY", (next as { n: number }).n, { byMonthDay: o.ords }))
    }
    return undefined
  }
  if (x.k === "wd") {
    const wd = readWeekdays(i)
    let k = wd.next
    while (at(k)?.k === "every") k++
    return withPart(rule("WEEKLY", interval, { byDay: wd.days.map((d) => ({ weekday: wdCode(d) })) }))
  }
  if (x.k === "month") {
    const b = at(i + 1)
    if (b?.k === "ord" || b?.k === "num") return withPart(rule("YEARLY", interval, { byMonth: [x.n], byMonthDay: [b.n] }))
    return undefined
  }
  return undefined
}

/**
 * Build an RFC 5545 rule from spoken words: "every day", "every weekday", "every Monday", "every second Tuesday" (every other week),
 * "the first Monday of every month", "on the first of the month", "every 3 days", "every year on March 3rd", "weekly", with an optional time
 * ("every day at nine", "every Monday at half past seven"). Dutch: "elke dag", "elke werkdag", "elke tweede dinsdag", "om de week",
 * "elke eerste maandag van de maand", "op de eerste van de maand", "elk jaar op 3 maart". The result has the `RRULE`, a DTSTART in
 * the zone that is the first occurrence after now, and both as iCalendar lines. Anything not understood is `not-understood`.
 */
export const parseRecurrence = (text: string, language: Language, options: RecurrenceOptions): Parsed<Recurrence> => {
  const toks = tokenize(text)
  const now = typeof options.now === "number" ? options.now : options.now.getTime()
  const zone = options.timeZone
  // 1. the time of day, cut out
  let timeAt: { from: number; match: NonNullable<ReturnType<typeof matchTime>> } | undefined
  const leads = language === "en" ? new Set(["at", "around", "about"]) : new Set(["om", "rond", "tegen"])
  for (let i = 0; i < toks.length && timeAt === undefined; i++) {
    const prev = toks[i - 1]?.norm
    // "elke twee uur" is an interval, not a time
    if (prev !== undefined && everyWords[language].has(prev)) continue
    const m = matchTime(toks, i, language, prev !== undefined && leads.has(prev))
    if (m !== undefined) timeAt = { from: i, match: m }
  }
  const rest: Array<Tok> = []
  const cutFrom = timeAt === undefined ? -1 : timeAt.from > 0 && leads.has(toks[timeAt.from - 1]!.norm) ? timeAt.from - 1 : timeAt.from
  toks.forEach((t, k) => { if (timeAt === undefined || k < cutFrom || k >= timeAt.match.next) rest.push(t) })
  // 2. the rule
  const syms = symbolize(rest.map((t) => t.norm), rest, language)
  let begin = 0
  while (begin < syms.length && syms[begin]!.k === "junk") begin++
  let end = begin
  while (end < syms.length && syms[end]!.k !== "junk") end++
  const matched = matchRule(syms.slice(begin, end))
  if (matched === undefined) return notUnderstood
  const r = matched.rule
  // 3. the time
  let time: TimeOfDay | undefined
  if (timeAt !== undefined) {
    const withPart = matched.part !== undefined && timeAt.match.period === undefined ? { ...timeAt.match, period: matched.part } : timeAt.match
    const resolved = resolveTime(withPart, options.band !== undefined ? { band: options.band } : {})
    if (resolved === undefined) return notUnderstood
    time = resolved.time
  }
  const clock: ClockTime = time ?? options.defaultTime ?? { hour: 9, minute: 0 }
  // 4. the first occurrence after now, matching the rule (alignment of "every other week" starts there)
  const nowParts = localParts(now, zone)
  const today: LocalDate = nowParts
  if (r.freq === "HOURLY" || r.freq === "MINUTELY") {
    const step = (r.freq === "HOURLY" ? 3_600_000 : 60_000) * r.interval
    const t = Math.floor(now / 60_000) * 60_000 + step
    const p = localParts(t, zone)
    const start: LocalDateTime = { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute }
    return finish(r, start, time, zone, text, toks, rest, begin, end)
  }
  const probeSpec = { rrule: formatRRule({ ...r, interval: 1 }), dtstart: formatDtstart({ ...today, ...clock }, zone).replace(/^DTSTART;TZID=[^:]+:/, ""), timeZone: zone }
  const probe = occurrencesAfter(probeSpec, now, 1)[0]
  if (probe === undefined) return notUnderstood
  const p = localParts(probe, zone)
  return finish(r, { year: p.year, month: p.month, day: p.day, ...clock }, time, zone, text, toks, rest, begin, end)
}

const finish = (
  r: RecurrenceRule, start: LocalDateTime, time: TimeOfDay | undefined, zone: string, text: string, toks: ReadonlyArray<Tok>,
  rest: ReadonlyArray<Tok>, begin: number, end: number
): Parsed<Recurrence> => {
  const rrule = formatRRule(r)
  const dtstart = formatDtstart(start, zone)
  const from = rest[begin]?.start ?? toks[0]!.start
  const to = rest[end - 1]?.end ?? toks[toks.length - 1]!.end
  return ok({
    rule: r, rrule, ...(time !== undefined ? { time } : {}), start, startInstant: zonedToInstant(start, zone), dtstart, ics: `${dtstart}\nRRULE:${rrule}`, timeZone: zone
  }, text.slice(from, to))
}
