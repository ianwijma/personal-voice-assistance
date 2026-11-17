import { dict } from "./Dict.ts"
import { nlWholeWord, numbersWhole } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type ClockTime, type Language, type Parsed } from "./Result.ts"
import { accountedFor, onlyWords, range, sliceText, tokenize, type Tok } from "./Tokens.ts"

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
  /** 0–24 as said; 24 only as "24:00" or "24" (the end of the day). */
  readonly hour: number
  readonly minute: number
  /** 1–12 said without a marker: could be morning or evening. */
  readonly open: boolean
  /** Only a number was said ("seven", "7"): no "o'clock", "uur", minutes, am/pm or part of the day. */
  readonly bare: boolean
  /** The word "midnight" / "middernacht": with a date it can mean the start or the end of that day. */
  readonly midnightWord: boolean
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

const enPeriodNouns = dict<Period>({ morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" })
const nlSPeriods = dict<Period>({ ochtends: "morning", morgens: "morning", middags: "afternoon", avonds: "evening", nachts: "night" })
const nlPeriodNouns = dict<Period>({ ochtend: "morning", morgen: "morning", voormiddag: "morning", middag: "afternoon", namiddag: "afternoon", avond: "evening", nacht: "night" })

/**
 * The part of the day said right after a clock time: "am", "pm", "in the morning", "in the afternoon", "in the evening", "at night";
 * Dutch "'s ochtends", "'s morgens", "'s middags", "'s avonds", "'s nachts", "in de ochtend", "in de avond", … Nothing else.
 */
export const periodAt = (toks: ReadonlyArray<Tok>, i: number, language: Language): { period: Period; next: number } | undefined => {
  const w = toks[i]?.norm
  if (w === undefined) return undefined
  if (w === "am" || w === "pm") return { period: w, next: i + 1 }
  const n1 = toks[i + 1]?.norm ?? ""
  const n2 = toks[i + 2]?.norm ?? ""
  if (language === "en") {
    if (w === "in" && n1 === "the" && enPeriodNouns[n2] !== undefined && n2 !== "night") return { period: enPeriodNouns[n2]!, next: i + 3 }
    if (w === "at" && n1 === "night") return { period: "night", next: i + 2 }
    return undefined
  }
  if (w === "s" && nlSPeriods[n1] !== undefined) return { period: nlSPeriods[n1]!, next: i + 2 }
  if (w === "in" && n1 === "de" && nlPeriodNouns[n2] !== undefined) return { period: nlPeriodNouns[n2]!, next: i + 3 }
  return undefined
}

// ---- hours and minutes: fixed shapes, not the open number grammar ("seven thirty" is a time, not a number) ---------------------

const enSmall = dict<number>({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
})
const enTens = dict<number>({ twenty: 20, thirty: 30, forty: 40, fifty: 50 })

interface Read {
  readonly value: number
  readonly next: number
  /** The reading says the hour of a 24-hour clock (0, 13–24, a leading zero, "oh nine"). */
  readonly exact: boolean
}

/** English 0–59 in words at `k`: "seven", "nineteen", "twenty", "forty five". Every way to read it (longest first). */
const enWords = (toks: ReadonlyArray<Tok>, k: number): Array<{ value: number; next: number }> => {
  const w = toks[k]?.norm ?? ""
  const out: Array<{ value: number; next: number }> = []
  const t = enTens[w]
  if (t !== undefined) {
    const u = enSmall[toks[k + 1]?.norm ?? ""]
    if (u !== undefined && u <= 9) out.push({ value: t + u, next: k + 2 })
    out.push({ value: t, next: k + 1 })
  } else if (enSmall[w] !== undefined) out.push({ value: enSmall[w]!, next: k + 1 })
  return out
}

/** The hours that may start at `k` (longest first): digits 0–24, a word 1–24, "zero", "oh nine". */
const hoursAt = (toks: ReadonlyArray<Tok>, k: number, language: Language): Array<Read> => {
  const t = toks[k]
  if (t === undefined) return []
  if (/^\d{1,2}$/.test(t.norm)) {
    const v = Number(t.norm)
    return v > 24 ? [] : [{ value: v, next: k + 1, exact: v === 0 || v > 12 || (t.norm.length === 2 && t.norm.startsWith("0")) }]
  }
  if (language === "en") {
    if (t.norm === "zero") return [{ value: 0, next: k + 1, exact: true }]
    if (t.norm === "oh") {
      const u = enSmall[toks[k + 1]?.norm ?? ""]
      return u !== undefined && u <= 9 ? [{ value: u, next: k + 2, exact: true }] : []
    }
    return enWords(toks, k).filter((r) => r.value >= 1 && r.value <= 24).map((r) => ({ ...r, exact: r.value > 12 }))
  }
  const v = nlWholeWord(t.norm)
  return v === undefined || v > 24 ? [] : [{ value: v, next: k + 1, exact: v === 0 || v > 12 }]
}
/** An hour of a 12-hour clock (1–12) at `k`, as "half seven", "quarter past seven" and "kwart voor zeven" use. */
const hour12At = (toks: ReadonlyArray<Tok>, k: number, language: Language): Read | undefined =>
  hoursAt(toks, k, language).find((h) => h.value >= 1 && h.value <= 12 && h.next === k + 1 && !/^0/.test(toks[k]!.norm))

/** The minutes after an hour: "thirty", "forty five", "oh five", "05", "30"; English "hundred" is :00 ("nineteen hundred"). */
const minutesAfterHour = (toks: ReadonlyArray<Tok>, k: number, language: Language): Array<{ value: number; next: number }> => {
  const t = toks[k]
  if (t === undefined) return []
  if (/^\d{2}$/.test(t.norm)) {
    const v = Number(t.norm)
    return v <= 59 ? [{ value: v, next: k + 1 }] : []
  }
  if (language === "en") {
    if (t.norm === "hundred") return [{ value: 0, next: k + 1 }]
    if (t.norm === "oh" || t.norm === "o") {
      const u = enSmall[toks[k + 1]?.norm ?? ""]
      return u !== undefined && u <= 9 ? [{ value: u, next: k + 2 }] : []
    }
    return enWords(toks, k).filter((r) => r.value >= 10 && r.value <= 59)
  }
  const v = nlWholeWord(t.norm)
  return v !== undefined && v >= 1 && v <= 59 ? [{ value: v, next: k + 1 }] : []
}

/** The minutes before "past" / "to" / "over" / "voor": 1–29 in words or digits, "a quarter", "quarter", "kwart", [minutes]. */
const minutesBefore = (toks: ReadonlyArray<Tok>, k: number, language: Language): Array<{ value: number; next: number }> => {
  const w = toks[k]?.norm
  if (w === undefined) return []
  let found: Array<{ value: number; next: number }>
  if (language === "en" && (w === "a" || w === "an") && toks[k + 1]?.norm === "quarter") found = [{ value: 15, next: k + 2 }]
  else if (w === "quarter" || w === "kwart") found = [{ value: 15, next: k + 1 }]
  else if (/^\d{1,2}$/.test(w) && !w.startsWith("0")) found = [{ value: Number(w), next: k + 1 }]
  else if (language === "en") found = enWords(toks, k)
  else {
    const v = nlWholeWord(w)
    found = v === undefined ? [] : [{ value: v, next: k + 1 }]
  }
  const unit: ReadonlySet<string> = language === "en" ? new Set(["minutes", "minute", "mins", "min"]) : new Set(["minuten", "minuut"])
  // Without "minutes" only the counts a clock is read in: "five to eight", "twenty past seven". "seven to eight" and "two to three"
  // are ranges, not 7:53 and 2:58.
  const spoken: ReadonlySet<number> = new Set([5, 10, 15, 20, 25])
  return found.filter((f) => f.value >= 1 && f.value <= 29)
    .flatMap((f) => unit.has(toks[f.next]?.norm ?? "") ? [{ value: f.value, next: f.next + 1 }] : spoken.has(f.value) ? [f] : [])
}

/** hour (1–12) minus one hour, keeping the 12-hour openness. */
const hourBefore = (h: number): number => (h === 1 ? 12 : h - 1)

const clockToken = (toks: ReadonlyArray<Tok>, k: number): { hour: number; minute: number; exact: boolean } | undefined => {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(toks[k]?.norm ?? "")
  if (m === null) return undefined
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return undefined
  return { hour, minute, exact: hour === 0 || hour > 12 || (m[1]!.length === 2 && m[1]!.startsWith("0")) }
}

type Core = Omit<TimeMatch, "period" | "midnightWord"> & { readonly midnightWord?: boolean }

/** Every clock reading that starts at `i`, in the order tried. */
const coresEn = (toks: ReadonlyArray<Tok>, i: number): Array<Core> => {
  const w = toks[i]!.norm
  const out: Array<Core> = []
  const clock = clockToken(toks, i)
  if (clock !== undefined) out.push({ hour: clock.hour, minute: clock.minute, open: !clock.exact, bare: false, next: i + 1 })
  if (w === "noon" || w === "midday") out.push({ hour: 12, minute: 0, open: false, bare: false, next: i + 1 })
  if (w === "midnight") out.push({ hour: 0, minute: 0, open: false, bare: false, midnightWord: true, next: i + 1 })
  // [MINS] past|after|to|till|of HOUR, "half past HOUR"
  const mins = w === "half" ? [{ value: 30, next: i + 1 }] : minutesBefore(toks, i, "en")
  for (const m of mins) {
    const c = toks[m.next]?.norm
    const h = hour12At(toks, m.next + 1, "en")
    if (h === undefined) continue
    if (c === "past" || c === "after") out.push({ hour: h.value, minute: m.value, open: true, bare: false, next: h.next })
    else if ((c === "to" || c === "till" || c === "of") && w !== "half") out.push({ hour: hourBefore(h.value), minute: 60 - m.value, open: true, bare: false, next: h.next })
  }
  // half HOUR (British "half seven" = 7:30)
  if (w === "half") {
    const h = hour12At(toks, i + 1, "en")
    if (h !== undefined) out.push({ hour: h.value, minute: 30, open: true, bare: false, next: h.next })
  }
  for (const h of hoursAt(toks, i, "en")) {
    if (toks[h.next]?.norm === "oclock" && h.value >= 1 && h.value <= 12) out.push({ hour: h.value, minute: 0, open: !h.exact, bare: false, next: h.next + 1 })
    for (const m of minutesAfterHour(toks, h.next, "en")) {
      // "nineteen hundred", "oh nine hundred": the 24-hour clock; "seven hundred" is not a time.
      if (toks[h.next]!.norm === "hundred" && !h.exact) continue
      if (h.value === 24 && m.value > 0) continue
      out.push({ hour: h.value, minute: m.value, open: !h.exact, bare: false, next: m.next })
    }
    out.push({ hour: h.value, minute: 0, open: !h.exact, bare: true, next: h.next })
  }
  return out
}

const coresNl = (toks: ReadonlyArray<Tok>, i: number): Array<Core> => {
  const w = toks[i]!.norm
  const out: Array<Core> = []
  const clock = clockToken(toks, i)
  if (clock !== undefined) out.push({ hour: clock.hour, minute: clock.minute, open: !clock.exact, bare: false, next: i + 1 })
  if (w === "middernacht") out.push({ hour: 0, minute: 0, open: false, bare: false, midnightWord: true, next: i + 1 })
  // [MINS] voor|over [half] HOUR
  for (const m of minutesBefore(toks, i, "nl")) {
    const c = toks[m.next]?.norm
    if (c !== "voor" && c !== "over") continue
    const isHalf = toks[m.next + 1]?.norm === "half"
    const h = hour12At(toks, m.next + 1 + (isHalf ? 1 : 0), "nl")
    if (h === undefined) continue
    // minutes since the reference: "half acht" is 7:30
    let hour = isHalf ? hourBefore(h.value) : h.value
    let minute = (isHalf ? 30 : 0) + (c === "over" ? m.value : -m.value)
    if (minute < 0) { minute += 60; hour = hourBefore(hour) }
    if (minute >= 60) { minute -= 60; hour = hour === 12 ? 1 : hour + 1 }
    out.push({ hour, minute, open: true, bare: false, next: h.next })
  }
  // half HOUR: "half acht" = 7:30
  if (w === "half") {
    const h = hour12At(toks, i + 1, "nl")
    if (h !== undefined) out.push({ hour: hourBefore(h.value), minute: 30, open: true, bare: false, next: h.next })
  }
  for (const h of hoursAt(toks, i, "nl")) {
    const u = toks[h.next]?.norm
    if (u === "uur" || u === "u" || u === "h") {
      for (const m of minutesAfterHour(toks, h.next + 1, "nl")) {
        if (h.value === 24 && m.value > 0) continue
        out.push({ hour: h.value, minute: m.value, open: !h.exact, bare: false, next: m.next })
      }
      if (u === "uur") out.push({ hour: h.value, minute: 0, open: !h.exact, bare: false, next: h.next + 1 })
    }
    out.push({ hour: h.value, minute: 0, open: !h.exact, bare: true, next: h.next })
  }
  return out
}

/**
 * Every clock time starting at word `i`, each with the part of the day said right after it, longest first. `bareOk`: a lone number
 * ("seven") may be one. Callers pick the reading that lets their whole phrase be read.
 */
export const matchTimes = (toks: ReadonlyArray<Tok>, i: number, language: Language, bareOk: boolean): Array<TimeMatch> => {
  if (toks[i] === undefined) return []
  const cores = (language === "en" ? coresEn(toks, i) : coresNl(toks, i)).filter((c) => bareOk || !c.bare)
  const out: Array<TimeMatch> = []
  for (const c of cores) {
    const base: TimeMatch = { ...c, midnightWord: c.midnightWord === true }
    const p = periodAt(toks, c.next, language)
    if (p !== undefined) out.push({ ...base, bare: false, period: p.period, next: p.next })
    out.push(base)
  }
  return out.sort((a, b) => b.next - a.next)
}

/** The longest clock time at word `i` (see `matchTimes`). */
export const matchTime = (toks: ReadonlyArray<Tok>, i: number, language: Language, bareOk: boolean): TimeMatch | undefined =>
  matchTimes(toks, i, language, bareOk)[0]

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
 * The 24-hour hours a part of the day covers. A clock reading that already says its hour (a leading zero, 0 or 13–23, noon, midnight)
 * must fall inside the part said with it: "07:00 in the evening" and "23 in the morning" contradict themselves and are not read.
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
  /** "24:00": midnight at the end of the day, so 00:00 of the next one. */
  readonly carry: boolean
}

/**
 * Settle am/pm: said → that; not said → the readings inside the band, the next after `afterMinutes` (else the earliest). "24:00"
 * is 00:00 with `carry`; it takes no part of the day.
 */
export const resolveTime = (m: TimeMatch, options?: TimeOptions): Resolved | undefined => {
  if (m.hour < 0 || m.hour > 24 || m.minute < 0 || m.minute > 59 || (m.hour === 24 && m.minute > 0)) return undefined
  if (m.hour === 24) return m.period === undefined ? { time: { hour: 0, minute: 0, guessed: false, alternatives: [] }, nextDay: false, carry: true } : undefined
  if ((m.period === "am" || m.period === "pm") && (m.hour < 1 || m.hour > 12 || !m.open)) return undefined
  if (!m.open || m.hour < 1 || m.hour > 12) {
    // The hour is already settled ("19:30", "07:00", "noon"): a period said with it must agree, never override or be dropped.
    if (m.period !== undefined && !periodHours(m.period, m.hour)) return undefined
    return { time: { hour: m.hour, minute: m.minute, guessed: false, alternatives: [] }, nextDay: false, carry: false }
  }
  if (m.period !== undefined) {
    const hour = settle(m.hour, m.period)
    if (hour === undefined || hour > 23 || !periodHours(m.period, hour)) return undefined
    return { time: { hour, minute: m.minute, guessed: false, alternatives: [] }, nextDay: false, carry: false }
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
  return { time: { ...chosen, guessed: true, alternatives: inBand.filter((c) => c !== chosen) }, nextDay, carry: false }
}

/** The one word a time phrase may start with besides the time: "at seven", "om zeven uur". */
export const timeFillers: Record<Language, ReadonlySet<string>> = { en: new Set(["at"]), nl: new Set(["om"]) }

/**
 * A time of day, and nothing else: "seven", "7:30", "half past seven", "quarter to seven", "seven thirty pm", "nineteen hundred",
 * "seven in the evening"; Dutch "half acht" (7:30), "kwart voor zeven", "kwart over zeven", "zeven uur 's avonds", "19u30". English
 * "half seven" is 7:30, Dutch "half zeven" is 6:30. Without am/pm the reading inside the band (default 07:00–21:00) wins and `guessed`
 * is true; `ambiguous` only when the band holds no reading. The phrase may have "at" / "om" before it and no other word:
 * "around seven", "until seven", "seven or eight", "seven UTC" and "seven please" are `not-understood`. "24:00" is refused here (a
 * time of day cannot say "the next day"); `parseDateTime` reads it.
 */
export const parseTimeOfDay = (text: string, language: Language, options?: TimeOptions): Parsed<TimeOfDay> => {
  if (typeof text !== "string") return notUnderstood
  const toks = tokenize(text)
  if (!onlyWords(text, toks)) return notUnderstood
  // One lead word, first; then the time, and nothing after it.
  const i = toks.length > 0 && timeFillers[language].has(toks[0]!.norm) ? 1 : 0
  for (const m of matchTimes(toks, i, language, true)) {
    if (!accountedFor(toks, new Set(range(0, m.next)), new Set())) continue
    if (!numbersWhole(text, toks, [{ start: toks[i]!.start, end: toks[m.next - 1]!.end }])) return notUnderstood
    if (m.hour === 24) return notUnderstood
    const said = sliceText(text, toks, i, m.next)
    const r = resolveTime(m, options)
    if (r !== undefined) return ok(r.time, said)
    // The band holds no reading: both are possible.
    if (m.open && m.hour >= 1 && m.hour <= 12 && m.period === undefined) {
      const both = [m.hour === 12 ? 0 : m.hour, m.hour === 12 ? 12 : m.hour + 12].map((hour) => ({ hour, minute: m.minute, guessed: true, alternatives: [] }))
      return ambiguous(both, said, "No am or pm was said and neither reading falls inside the band")
    }
    return notUnderstood
  }
  return notUnderstood
}

