import { dicts } from "./Dict.ts"
import { numbersWhole, readNumber } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type ClockTime, type Language, type Parsed } from "./Result.ts"
import { sliceText, tokenize, type Tok } from "./Tokens.ts"

/** A clock time said aloud. `guessed`: no am/pm was said and the band chose; `alternatives`: other readings inside the band. */
export interface TimeOfDay extends ClockTime {
  readonly guessed: boolean
  readonly alternatives: ReadonlyArray<ClockTime>
}

export interface TimeOptions {
  /** A time said without am/pm must fall inside this band, "HH:MM" or minutes since midnight. Default 07:00–21:00. */
  readonly band?: { readonly from: string | number; readonly to: string | number }
  /** Minutes since midnight now: of the readings in the band, the next one after it wins (else the earliest). */
  readonly afterMinutes?: number
}

export type Period = "am" | "pm" | "morning" | "afternoon" | "evening" | "night"

/** The time as read, before am/pm is settled. */
export interface TimeMatch {
  /** 0–24 as said. */
  readonly hour: number
  readonly minute: number
  /** 1–12 said without a marker: could be morning or evening. */
  readonly open: boolean
  readonly period?: Period
  readonly next: number
}

const toMinutes = (v: string | number): number => {
  if (typeof v === "number") return v
  const m = /^(\d{1,2}):?(\d{2})$/.exec(v.trim())
  return m === null ? 0 : Number(m[1]) * 60 + Number(m[2])
}
export const bandOf = (o: TimeOptions | undefined): { from: number; to: number } => ({
  from: toMinutes(o?.band?.from ?? "07:00"),
  to: toMinutes(o?.band?.to ?? "21:00")
})

const periodWords = dicts<Language, Period>({
  en: { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night", tonight: "night" },
  nl: {
    ochtend: "morning", ochtends: "morning", morgens: "morning", voormiddag: "morning", vroeg: "morning",
    middag: "afternoon", middags: "afternoon", namiddag: "afternoon", avond: "evening", avonds: "evening", nacht: "night", nachts: "night"
  }
})
export const periodAt = (toks: ReadonlyArray<Tok>, i: number, language: Language): { period: Period; next: number } | undefined => {
  const w = toks[i]?.norm
  if (w === undefined) return undefined
  if (w === "am" || w === "pm") return { period: w, next: i + 1 }
  let k = i
  if (language === "en") {
    if (w === "in" && toks[k + 1]?.norm === "the") k += 2
    else if (w === "at" && toks[k + 1]?.norm === "night") return { period: "night", next: k + 2 }
    else if (w === "this") k += 1
    else return undefined
  } else {
    if (w === "s") k += 1
    else if (w === "in" && toks[k + 1]?.norm === "de") k += 2
    else if (w === "van" && toks[k + 1]?.norm === "de") k += 2
  }
  const p = toks[k] === undefined ? undefined : periodWords[language][toks[k]!.norm]
  return p === undefined ? undefined : { period: p, next: k + 1 }
}

interface Hour {
  readonly value: number
  readonly next: number
  readonly exact: boolean
}
const hourAt = (toks: ReadonlyArray<Tok>, k: number, language: Language): Hour | undefined => {
  const t = toks[k]
  if (t === undefined) return undefined
  if (language === "en") {
    if (t.norm === "noon" || t.norm === "midday") return { value: 12, next: k + 1, exact: true }
    if (t.norm === "midnight") return { value: 0, next: k + 1, exact: true }
  } else if (t.norm === "middernacht") return { value: 0, next: k + 1, exact: true }
  if (/^\d{1,2}$/.test(t.norm)) {
    const v = Number(t.norm)
    return v > 24 ? undefined : { value: v, next: k + 1, exact: v === 0 || v > 12 || (t.norm.length === 2 && t.norm.startsWith("0")) }
  }
  const n = readNumber(toks, k, language)
  if (n === undefined || n.digits || !Number.isInteger(n.value) || n.value > 24) return undefined
  return { value: n.value, next: n.next, exact: n.value === 0 || n.value > 12 }
}

const minuteWords = (toks: ReadonlyArray<Tok>, k: number, language: Language): { value: number; next: number } | undefined => {
  const w = toks[k]?.norm
  if (w === undefined) return undefined
  let value: number
  let next: number
  if (language === "en" && (w === "a" || w === "an") && toks[k + 1]?.norm === "quarter") { value = 15; next = k + 2 }
  else if (w === "quarter" || w === "kwart") { value = 15; next = k + 1 }
  else {
    const n = readNumber(toks, k, language)
    if (n === undefined || n.value < 1 || n.value > 29 || !Number.isInteger(n.value)) return undefined
    value = n.value
    next = n.next
  }
  const unit = toks[next]?.norm
  if (unit === "minutes" || unit === "minute" || unit === "mins" || unit === "min" || unit === "minuten" || unit === "minuut") next++
  return { value, next }
}

/** hour (1–12 or 0/13–24 as said) minus one hour, keeping the 12-hour openness. */
const hourBefore = (h: number): number => (h === 0 ? 23 : h === 1 ? 12 : h - 1)

const matchClockToken = (toks: ReadonlyArray<Tok>, k: number): { hour: number; minute: number; exact: boolean; next: number } | undefined => {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(toks[k]?.norm ?? "")
  if (m === null) return undefined
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return undefined
  return { hour: hour === 24 ? 0 : hour, minute, exact: hour === 0 || hour > 12 || (m[1]!.length === 2 && m[1]!.startsWith("0")), next: k + 1 }
}

const base = (hour: Hour, minute: number, next: number): Omit<TimeMatch, "period"> => ({ hour: hour.value, minute, open: !hour.exact, next })

const matchEn = (toks: ReadonlyArray<Tok>, i: number, bareOk: boolean): Omit<TimeMatch, "period"> | undefined => {
  const w = toks[i]!.norm
  const clock = matchClockToken(toks, i)
  if (clock !== undefined) return { hour: clock.hour, minute: clock.minute, open: !clock.exact, next: clock.next }
  // noon, midnight
  const special = hourAt(toks, i, "en")
  if (special !== undefined && (w === "noon" || w === "midday" || w === "midnight")) return base(special, 0, special.next)
  // half HOUR (British "half seven" = 7:30)
  if (w === "half") {
    const h = hourAt(toks, i + 1, "en")
    if (h !== undefined && h.value >= 1 && h.value <= 12) return base(h, 30, h.next)
  }
  // [MINS] past|to HOUR
  const half = w === "half" ? { value: 30, next: i + 1 } : minuteWords(toks, i, "en")
  if (half !== undefined) {
    const c = toks[half.next]?.norm
    if (c === "past" || c === "after" || c === "to" || c === "till" || c === "until" || c === "of") {
      const h = hourAt(toks, half.next + 1, "en")
      if (h !== undefined && h.value <= 12) {
        if (c === "past" || c === "after") return base(h, half.value, h.next)
        return { hour: hourBefore(h.value), minute: 60 - half.value, open: !h.exact, next: h.next }
      }
    }
  }
  // HOUR [o'clock] | HOUR MIN
  const h = hourAt(toks, i, "en")
  if (h === undefined) return undefined
  const n1 = toks[h.next]?.norm
  if (n1 === "oclock") return base(h, 0, h.next + 1)
  if (n1 === "oh" || n1 === "o" || n1 === "zero") {
    const m = readNumber(toks, h.next + 1, "en")
    if (m !== undefined && m.value >= 1 && m.value <= 9 && (bareOk || toks[m.next]?.norm === "am" || toks[m.next]?.norm === "pm")) return base(h, m.value, m.next)
  }
  const m = readNumber(toks, h.next, "en")
  const markerFollows = (k: number) => toks[k]?.norm === "am" || toks[k]?.norm === "pm"
  if (m !== undefined && m.value >= 10 && m.value <= 59 && Number.isInteger(m.value) && (!m.digits || toks[h.next]!.norm.length <= 2) && (bareOk || markerFollows(m.next))) return base(h, m.value, m.next)
  if (markerFollows(h.next)) return base(h, 0, h.next)
  const p = periodAt(toks, h.next, "en")
  if (bareOk || (p !== undefined && h.value >= 1 && h.value <= 12 && toks[h.next]?.norm !== "this")) return base(h, 0, h.next)
  return undefined
}

const matchNl = (toks: ReadonlyArray<Tok>, i: number, bareOk: boolean): Omit<TimeMatch, "period"> | undefined => {
  const w = toks[i]!.norm
  const clock = matchClockToken(toks, i)
  if (clock !== undefined) return { hour: clock.hour, minute: clock.minute, open: !clock.exact, next: clock.next }
  if (w === "middernacht") return { hour: 0, minute: 0, open: false, next: i + 1 }
  // half HOUR: "half acht" = 7:30
  if (w === "half") {
    const h = hourAt(toks, i + 1, "nl")
    if (h !== undefined && h.value >= 1 && h.value <= 12) return { hour: hourBefore(h.value), minute: 30, open: true, next: h.next }
    return undefined
  }
  // [MINS] voor|over [half] HOUR
  const mins = minuteWords(toks, i, "nl")
  if (mins !== undefined) {
    const c = toks[mins.next]?.norm
    if (c === "voor" || c === "over") {
      const isHalf = toks[mins.next + 1]?.norm === "half"
      const h = hourAt(toks, mins.next + 1 + (isHalf ? 1 : 0), "nl")
      if (h !== undefined && h.value >= 1 && h.value <= 12) {
        // minutes since the reference hour: "half acht" is 7:30
        let hour = h.value
        let minute = 0
        if (isHalf) { hour = hourBefore(hour); minute = 30 }
        if (c === "over") minute += mins.value
        else minute -= mins.value
        if (minute < 0) { minute += 60; hour = hourBefore(hour) }
        if (minute >= 60) { minute -= 60; hour = hour === 12 ? 1 : hour + 1 }
        return { hour, minute, open: true, next: h.next }
      }
    }
  }
  // HH u MM ("19u30")
  const h = hourAt(toks, i, "nl")
  if (h === undefined) return undefined
  const u = toks[h.next]?.norm
  if (u === "u" || u === "uur") {
    const m = /^\d{1,2}$/.test(toks[h.next + 1]?.norm ?? "") ? { value: Number(toks[h.next + 1]!.norm), next: h.next + 2 } : readNumber(toks, h.next + 1, "nl")
    if (m !== undefined && m.value >= 1 && m.value <= 59 && Number.isInteger(m.value)) return base(h, m.value, m.next)
    return base(h, 0, h.next + 1)
  }
  if (bareOk) return base(h, 0, h.next)
  return undefined
}

/** The time of day starting at word `i`, with its am/pm or period words. `bareOk`: a lone number may be a time. */
export const matchTime = (toks: ReadonlyArray<Tok>, i: number, language: Language, bareOk: boolean): TimeMatch | undefined => {
  if (toks[i] === undefined) return undefined
  const m = language === "en" ? matchEn(toks, i, bareOk) : matchNl(toks, i, bareOk)
  if (m === undefined) return undefined
  let next = m.next
  if (language === "en" && toks[next]?.norm === "oclock") next++
  const p = periodAt(toks, next, language)
  if (p === undefined) return { ...m, next }
  return { ...m, period: p.period, next: p.next }
}

/** The 24-hour hour of a 12-hour reading (1–12) that am/pm or a period word settles, or `undefined` when they do not fit. */
const settle = (hour: number, period: Period): number | undefined => {
  switch (period) {
    case "am": return hour === 12 ? 0 : hour
    case "pm": return hour === 12 ? 12 : hour + 12
    // "twelve in the morning" has no single reading (midnight or noon).
    case "morning": return hour === 12 ? undefined : hour
    case "afternoon": return hour === 12 ? 12 : hour + 12
    case "evening": return hour === 12 ? undefined : hour + 12
    case "night": return hour === 12 ? 0 : hour >= 6 ? hour + 12 : hour
  }
}

/**
 * The 24-hour hours a part of the day covers. A clock reading that already says its hour (a leading zero, 0 or 13–24, noon, midnight)
 * must fall inside the part said with it: "07:00 in the evening" and "23 in the morning" contradict themselves and are not read
 * (review round 1, finding 10).
 */
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
}

/** Settle am/pm: said → that; not said → the readings inside the band, the next after `afterMinutes` (else the earliest). */
export const resolveTime = (m: TimeMatch, options?: TimeOptions): Resolved | undefined => {
  if (m.hour < 0 || m.hour > 24 || m.minute < 0 || m.minute > 59 || (m.hour === 24 && m.minute > 0)) return undefined
  if ((m.period === "am" || m.period === "pm") && (m.hour < 1 || m.hour > 12)) return undefined
  if (!m.open || m.hour < 1 || m.hour > 12) {
    // The hour is already settled ("19:30", "07:00", "noon"): a period said with it must agree, never override or be dropped.
    const hour = m.hour % 24
    if (m.period !== undefined && !(m.period === "am" || m.period === "pm" ? settle(m.hour, m.period) === hour : periodHours(m.period, hour))) return undefined
    return { time: { hour, minute: m.minute, guessed: false, alternatives: [] }, nextDay: false }
  }
  if (m.period !== undefined) {
    const hour = settle(m.hour, m.period)
    if (hour === undefined || hour > 23 || !periodHours(m.period, hour)) return undefined
    return { time: { hour, minute: m.minute, guessed: false, alternatives: [] }, nextDay: false }
  }
  const { from, to } = bandOf(options)
  const candidates = [m.hour === 12 ? 0 : m.hour, m.hour === 12 ? 12 : m.hour + 12]
    .map((hour) => ({ hour, minute: m.minute }))
    .sort((a, b) => a.hour - b.hour)
  const inBand = candidates.filter((c) => c.hour * 60 + c.minute >= from && c.hour * 60 + c.minute <= to)
  if (inBand.length === 0) return undefined
  const after = options?.afterMinutes
  let chosen = inBand[0]!
  let nextDay = false
  if (after !== undefined) {
    const later = inBand.find((c) => c.hour * 60 + c.minute > after)
    if (later !== undefined) chosen = later
    else nextDay = true
  }
  return { time: { ...chosen, guessed: true, alternatives: inBand.filter((c) => c !== chosen) }, nextDay }
}

const leadingFillers: Record<Language, ReadonlySet<string>> = {
  en: new Set(["at", "around", "about", "by", "roughly", "approximately", "for", "until", "till"]),
  nl: new Set(["om", "rond", "tegen", "ongeveer", "circa", "omstreeks", "tot", "voor"])
}
const trailingFillers: ReadonlySet<string> = new Set(["please", "alsjeblieft", "graag", "alstublieft", "sharp", "stipt", "precies", "exactly"])

/**
 * A time of day: "seven", "7:30", "half past seven", "quarter to seven", "seven thirty pm"; Dutch "half acht" (7:30), "kwart voor zeven",
 * "kwart over zeven", "zeven uur 's avonds". English "half seven" is 7:30, Dutch "half zeven" is 6:30. Without am/pm the reading inside
 * the band (default 07:00–21:00) wins and `guessed` is true. Ambiguous only when the band holds no reading.
 */
export const parseTimeOfDay = (text: string, language: Language, options?: TimeOptions): Parsed<TimeOfDay> => {
  const toks = tokenize(text)
  let i = 0
  while (i < toks.length && leadingFillers[language].has(toks[i]!.norm)) i++
  const m = matchTime(toks, i, language, true)
  if (m === undefined) return notUnderstood
  let end = m.next
  while (end < toks.length && trailingFillers.has(toks[end]!.norm)) end++
  if (end < toks.length) return notUnderstood
  const said = sliceText(text, toks, i, m.next)
  if (!numbersWhole(text, toks, [{ start: toks[i]!.start, end: toks[m.next - 1]!.end }])) return notUnderstood
  const r = resolveTime(m, options)
  if (r !== undefined) return ok(r.time, said)
  // The band holds no reading: both are possible.
  if (m.open && m.hour >= 1 && m.hour <= 12 && m.period === undefined) {
    const both = [m.hour === 12 ? 0 : m.hour, m.hour === 12 ? 12 : m.hour + 12].map((hour) => ({ hour, minute: m.minute, guessed: true, alternatives: [] }))
    return ambiguous(both, said, "No am or pm was said and neither reading falls inside the band")
  }
  return notUnderstood
}
