// The date-time grammar of the README ("Dates and times") for the tests, and its meaning, computed with the tests' own calendar and
// zone arithmetic (support/Zone.ts). The grammar's values are what was said (a day word, a weekday with its modifier, a calendar date,
// an offset, a time reading); `meaning` turns a reading into the values the README says, for a given now and zone.
import { fixed, lit, oneOf, words, type Grammar, type Rule, type Term } from "../support/Cfg.ts"
import { dayKey, daysIn, inYears, instantsOf, plusDays, sameDay, wallOf, weekdayOf, type Day } from "../support/Zone.ts"
import { durationGrammar } from "./durations.ts"
import { number, type Lang } from "./numbers.ts"
import { inPart, settleReading, timeGrammar, type Period, type Reading } from "./times.ts"

type Said =
  | { readonly kind: "word"; readonly offset: number; readonly part?: Period }
  | { readonly kind: "weekday"; readonly wd: number; readonly mod?: "this" | "next"; readonly nextWeek?: boolean; readonly part?: Period }
  | { readonly kind: "weekdayDate"; readonly wd: number; readonly date: Cal }
  | { readonly kind: "cal"; readonly date: Cal }
  | { readonly kind: "relative"; readonly n: number; readonly unit: "day" | "week" | "month" | "year" }
  | { readonly kind: "offset"; readonly ms: number }
interface Cal { readonly day: number; readonly month?: number; readonly year?: number }
interface DateSaid { readonly said: Said; readonly part?: Period }
export interface DateReading { readonly date?: DateSaid; readonly time?: { readonly t: Reading; readonly lead: boolean } }

const enWeekdays = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 }
const nlWeekdays = { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7 }
const enMonths = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }
const nlMonths = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 }
const nlParts: Record<string, Period> = { ochtend: "morning", middag: "afternoon", avond: "evening", nacht: "night" }
const enOrdinals = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"]
const nlOrdinals = ["eerste", "tweede", "derde", "vierde", "vijfde", "zesde", "zevende", "achtste", "negende", "tiende", "elfde", "twaalfde", "dertiende", "veertiende", "vijftiende", "zestiende", "zeventiende", "achttiende", "negentiende", "twintigste"]
const nlUnitWords = ["een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen"]

/** "nlUnit"+"en"+"twintigste": a Dutch ordinal 21–39 in one word. */
const nlCompoundOrdinal: Term = {
  read: (w) => {
    const m = /^(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(twintigste|dertigste)$/.exec(w)
    return m === null ? undefined : nlUnitWords.indexOf(m[1]!) + 1 + (m[2] === "twintigste" ? 20 : 30)
  },
  write: (r) => { const u = nlUnitWords[r.int(0, 8)]!; return `${u}${u.endsWith("e") ? "ën" : "en"}${r.chance(0.8) ? "twintigste" : "dertigste"}` }
}
const enSuffix = (n: number) => (n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th")
const digitOrdinal = (lang: Lang): Term => ({
  read: (w) => {
    const m = /^([1-9][0-9]?)([a-z]+)$/.exec(w)
    if (m === null) return undefined
    const n = Number(m[1])
    return (lang === "en" ? m[2] === enSuffix(n) : ["e", "de", "ste"].includes(m[2]!)) ? n : undefined
  },
  write: (r) => { const n = r.int(1, 31); return `${n}${lang === "en" ? enSuffix(n) : r.pick(["e", "de", "ste"])}` }
})
const year: Term = { read: (w) => (/^[0-9]{4}$/.test(w) && Number(w) >= 2000 && Number(w) <= 2199 ? Number(w) : undefined), write: (r) => String(r.chance(0.8) ? r.int(2026, 2030) : r.int(2000, 2199)) }

/** Ordinals 1–31 in the grammar: words, digits with their suffix. */
export const ordinalRules = (lang: Lang, min = 1, max = 31): ReadonlyArray<Rule> => {
  const inRange = (n: number) => (n >= min && n <= max ? n : undefined)
  const single = Object.fromEntries((lang === "en" ? enOrdinals : nlOrdinals).map((w, k) => [w, k + 1]))
  const rules: Array<Rule> = [
    { rhs: [oneOf({ ...single, ...(lang === "en" ? { thirtieth: 30 } : { dertigste: 30 }) })], act: ([n]) => inRange(n) },
    { rhs: [digitOrdinal(lang)], act: ([n]) => inRange(n) }
  ]
  if (lang === "en") rules.push({ rhs: [oneOf({ twenty: 20, thirty: 30 }), oneOf(Object.fromEntries(enOrdinals.slice(0, 9).map((w, k) => [w, k + 1])))], act: ([t, u]) => inRange(t + u <= 31 ? t + u : 99) })
  else rules.push({ rhs: [nlCompoundOrdinal], act: ([n]) => inRange(n) })
  return rules
}

export const dateGrammar = (lang: Lang): Grammar => {
  const en = lang === "en"
  const time = timeGrammar(lang, true)
  const duration = durationGrammar(lang)
  const dayWords: ReadonlyArray<Rule> = en
    ? [fixed([lit("today")], { kind: "word", offset: 0 }), fixed([lit("tonight")], { kind: "word", offset: 0, part: "night" }), fixed([lit("tomorrow")], { kind: "word", offset: 1 }),
      fixed([lit("yesterday")], { kind: "word", offset: -1 }), fixed(words("this morning"), { kind: "word", offset: 0, part: "morning" }),
      fixed(words("this afternoon"), { kind: "word", offset: 0, part: "afternoon" }), fixed(words("this evening"), { kind: "word", offset: 0, part: "evening" }),
      fixed(words("the day after tomorrow"), { kind: "word", offset: 2 })]
    : Object.entries({
      vandaag: [0], vanavond: [0, "evening"], vanochtend: [0, "morning"], vanmorgen: [0, "morning"], vanmiddag: [0, "afternoon"], vannacht: [0, "night"], morgen: [1], overmorgen: [2],
      gisteren: [-1], eergisteren: [-2], morgenochtend: [1, "morning"], morgenmiddag: [1, "afternoon"], morgenavond: [1, "evening"], morgennacht: [1, "night"]
    } as Record<string, [number, Period?]>).map(([w, [offset, part]]) => fixed([lit(w)], { kind: "word", offset, ...(part !== undefined ? { part } : {}) }))
  const wdPart: Term = {
    read: (w) => { for (const [name, wd] of Object.entries(nlWeekdays)) if (w.startsWith(name) && nlParts[w.slice(name.length)] !== undefined) return { wd, part: nlParts[w.slice(name.length)] }; return undefined },
    write: (r) => `${r.pick(Object.keys(nlWeekdays))}${r.pick(Object.keys(nlParts))}`
  }
  // English: [the] DAY [of] MONTH [YEAR] | MONTH [the] DAY [YEAR] | the ORDINAL; Dutch: [de] DAY MONTH [YEAR] | de ORDINAL.
  const cal: Array<Rule> = []
  for (const the of [false, true]) for (const of of en ? [false, true] : [false]) for (const y of [false, true]) {
    const rhs = [...(the ? [lit(en ? "the" : "de")] : []), "DAYNUM", ...(of ? [lit("of")] : []), "MONTH", ...(y ? [year] : [])]
    const at = (the ? 1 : 0)
    cal.push({ rhs, act: (v) => ({ day: v[at], month: v[at + 1 + (of ? 1 : 0)], ...(y ? { year: v[v.length - 1] } : {}) }), weight: the || of ? 1 : 2 })
  }
  if (en) for (const the of [false, true]) for (const y of [false, true]) {
    cal.push({ rhs: ["MONTH", ...(the ? [lit("the")] : []), "DAYNUM", ...(y ? [year] : [])], act: (v) => ({ month: v[0], day: v[the ? 2 : 1], ...(y ? { year: v[v.length - 1] } : {}) }) })
  }
  cal.push({ rhs: [lit(en ? "the" : "de"), "ORD"], act: ([, day]) => ({ day }), weight: 2 })
  cal.push({ rhs: [lit(en ? "the" : "de"), "ORD", ...words(en ? "of the month" : "van de maand")], act: ([, day]) => ({ day }) })
  const wdx: ReadonlyArray<Rule> = [{ rhs: [oneOf(en ? enWeekdays : nlWeekdays)], act: ([wd]) => ({ wd }), weight: 3 }, ...(en ? [] : [{ rhs: [wdPart] }])]
  const lead = en ? "in" : "over"
  const calUnits = en
    ? { day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year" }
    : { dag: "day", dagen: "day", week: "week", weken: "week", maand: "month", maanden: "month", jaar: "year", jaren: "year" }
  const calSingular = en ? { day: "day", week: "week", month: "month", year: "year" } : { dag: "day", week: "week", maand: "month", jaar: "year" }
  const clockUnits = new Set(["hour", "quarter", "minute", "second"])
  return {
    ...time,
    ...Object.fromEntries(Object.entries(duration).map(([k, v]) => [`D_${k}`, v.map((r) => ({ ...r, rhs: r.rhs.map((s) => (typeof s === "string" ? `D_${s}` : s)) }))])),
    ORD: ordinalRules(lang),
    DAYNUM: [{ rhs: ["ORD"] }, { rhs: [number(lang, { min: 1, max: 31, whole: true })] }],
    MONTH: [{ rhs: [oneOf(en ? enMonths : nlMonths)] }],
    CAL: cal,
    WDX: wdx,
    MOD: en ? [fixed([lit("this")], "this"), fixed([lit("coming")], "this"), fixed([lit("next")], "next")]
      : [fixed([lit("deze")], "this"), fixed([lit("komende")], "this"), fixed([lit("aanstaande")], "this"), fixed([lit("volgende")], "next")],
    LEADABLE: [
      { rhs: ["WDX"], act: ([w]) => ({ kind: "weekday", ...w }), weight: 3 },
      { rhs: ["MOD", "WDX"], act: ([mod, w]) => ({ kind: "weekday", mod, ...w }), weight: 2 },
      { rhs: ["WDX", ...words(en ? "next week" : "volgende week")], act: ([w]) => ({ kind: "weekday", nextWeek: true, ...w }) },
      { rhs: [oneOf(en ? enWeekdays : nlWeekdays), "CAL"], act: ([wd, date]) => ({ kind: "weekdayDate", wd, date }) },
      { rhs: ["CAL"], act: ([date]) => ({ kind: "cal", date }), weight: 3 }
    ],
    RELATIVE: [
      { rhs: [lit(lead), number(lang, { min: 1, max: 999, whole: true }), oneOf(calUnits)], act: ([, n, unit]) => ({ kind: "relative", n, unit }), weight: 2 },
      { rhs: [lit(lead), oneOf(en ? { a: 1, an: 1 } : { een: 1 }), oneOf(calSingular)], act: ([, , unit]) => ({ kind: "relative", n: 1, unit }) },
      { rhs: [lit(lead), "D_DURATION"], act: ([, d]) => (d.units.every((u: string) => clockUnits.has(u)) ? { kind: "offset", ms: d.ms } : undefined), weight: 2 }
    ],
    PLAIN: [
      { rhs: ["LEADABLE"], weight: 4 }, { rhs: [lit(en ? "on" : "op"), "LEADABLE"], act: ([, s]) => s },
      { rhs: ["DAYWORD"], weight: 3 }, { rhs: ["RELATIVE"], weight: 2 }
    ],
    DAYWORD: dayWords,
    DAYPART: [
      { rhs: [oneOf(en ? { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" } : nlParts)] },
      ...(time["PERIOD"] ?? []).filter((r) => { const v = r.act?.([]); return v !== "am" && v !== "pm" })
    ],
    DATE: [
      { rhs: ["PLAIN"], act: ([said]) => ({ said }), weight: 3 },
      { rhs: ["PLAIN", "DAYPART"], act: ([said, part]) => (said.kind !== "offset" && said.part === undefined ? { said, part } : undefined) }
    ],
    TIMEP: [{ rhs: [lit(en ? "at" : "om"), "TIME"], act: ([, t]) => ({ t, lead: true }), weight: 3 }, { rhs: ["TIME"], act: ([t]) => ({ t, lead: false }) }],
    PHRASE: [
      { rhs: ["DATE"], act: ([date]) => ({ date }), weight: 2 },
      { rhs: ["TIMEP"], act: ([time]) => ({ time }) },
      { rhs: ["DATE", "TIMEP"], act: ([date, time]) => ({ date, time }), weight: 3 },
      { rhs: ["TIMEP", "DATE"], act: ([time, date]) => ({ date, time }) }
    ]
  }
}

// ---- the meaning ---------------------------------------------------------------------------------------------------------------------

export interface Expected {
  readonly date: Day
  readonly weekday: number
  readonly time?: { readonly hour: number; readonly minute: number; readonly guessed: boolean; readonly alternatives: ReadonlyArray<{ readonly hour: number; readonly minute: number }> }
  readonly instant?: number
  readonly partOfDay?: Period
  readonly inPast: boolean
}

const nextOnOrAfter = (today: Day, c: Cal): Day | undefined => {
  if (c.year !== undefined) {
    const m = c.month ?? today.month
    return c.day <= daysIn(c.year, m) ? { year: c.year, month: m, day: c.day } : undefined
  }
  // The first date from today on with that day (and month): walk the days.
  for (let k = 0; k < 366 * 9; k++) {
    const d = plusDays(today, k)
    if (d.day === c.day && (c.month === undefined || d.month === c.month)) return d
  }
  return undefined
}
const addMonthsClamped = (d: Day, n: number): Day => {
  const index = d.year * 12 + d.month - 1 + n
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  return { year, month, day: Math.min(d.day, daysIn(year, month)) }
}

/** The dates a said date names on `today`; `undefined` when it names none (a date that does not exist, a weekday that is not its). */
const datesOf = (s: Said, today: Day): ReadonlyArray<Day> | undefined => {
  const wdToday = weekdayOf(today)
  switch (s.kind) {
    case "word": return [plusDays(today, s.offset)]
    case "weekday": {
      const ahead = (s.wd - wdToday + 7) % 7
      if (s.nextWeek === true) return s.mod === undefined ? [plusDays(today, 7 - (wdToday - 1) + s.wd - 1)] : undefined
      if (s.mod === "this") return [plusDays(today, ahead)]
      if (s.mod === "next") return ahead === 0 ? [plusDays(today, 7)] : [plusDays(today, ahead), plusDays(today, ahead + 7)]
      return [plusDays(today, ahead === 0 ? 7 : ahead)]
    }
    case "weekdayDate": {
      const d = nextOnOrAfter(today, s.date)
      return d !== undefined && weekdayOf(d) === s.wd ? [d] : undefined
    }
    case "cal": { const d = nextOnOrAfter(today, s.date); return d === undefined ? undefined : [d] }
    case "relative":
      return [s.unit === "day" ? plusDays(today, s.n) : s.unit === "week" ? plusDays(today, 7 * s.n) : addMonthsClamped(today, s.unit === "month" ? s.n : 12 * s.n)]
    case "offset": return []
  }
}

/** Every value a reading means at `now` in `zone` (one, or two for "next Friday" and a date with "midnight"); `undefined`: none. */
export const meaning = (r: DateReading, now: number, zone: string, band = { from: 420, to: 1260 }): Array<Expected> | undefined => {
  const nowWall = wallOf(now, zone)
  const today: Day = { year: nowWall.year, month: nowWall.month, day: nowWall.day }
  const value = (d: Day, t: Expected["time"], instant: number | undefined, part?: Period): Expected => ({
    date: d, weekday: weekdayOf(d), ...(t !== undefined ? { time: t } : {}), ...(instant !== undefined ? { instant } : {}),
    ...(t === undefined && part !== undefined ? { partOfDay: part } : {}), inPast: instant !== undefined ? instant <= now : dayKey(d) < dayKey(today)
  })
  const said = r.date?.said
  if (said?.kind === "offset") {
    if (r.time !== undefined) return undefined
    const instant = now + said.ms
    const w = wallOf(instant, zone)
    const d = { year: w.year, month: w.month, day: w.day }
    return inYears(d) ? [{ ...value(d, { hour: w.hour, minute: w.minute, guessed: false, alternatives: [] }, instant), inPast: false }] : undefined
  }
  const part = said === undefined ? undefined : r.date!.part ?? ("part" in said ? said.part : undefined)
  const dates = said === undefined ? [undefined] : datesOf(said, today)
  if (dates === undefined || dates.some((d) => d !== undefined && !inYears(d))) return undefined
  const out: Array<Expected> = []
  for (const date of dates) {
    const one = meaningOne(date, part, r.time, now, zone, band, today, nowWall.hour, value)
    if (one === undefined) return undefined
    out.push(...one)
  }
  return out.every((v) => inYears(v.date)) ? out : undefined
}

const meaningOne = (
  date: Day | undefined, part: Period | undefined, time: DateReading["time"], now: number, zone: string, band: { from: number; to: number }, today: Day, nowHour: number,
  value: (d: Day, t: Expected["time"], instant: number | undefined, part?: Period) => Expected
): Array<Expected> | undefined => {
  if (time === undefined) return [value(date!, undefined, undefined, part)]
  const t = time.t
  if (t.bare && !time.lead && date !== undefined) return undefined
  if (t.period !== undefined && part !== undefined && t.period !== part && t.period !== "am" && t.period !== "pm") return undefined
  const carry = t.hour === 24
  if (carry && (part !== undefined || t.period !== undefined)) return undefined
  const settled = carry ? { hour: 0, minute: 0, guessed: false, alternatives: [] } : settleReading(t.period === undefined && part !== undefined ? { ...t, period: part } : t, band)
  if (settled === undefined || settled === "both") return undefined
  if (part !== undefined && !inPart(part, settled.hour)) return undefined
  const readings = (settled.guessed ? [{ hour: settled.hour, minute: settled.minute }, ...settled.alternatives] : [{ hour: settled.hour, minute: settled.minute }])
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
  const timeOf = (x: { hour: number; minute: number }) => ({ hour: x.hour, minute: x.minute, guessed: settled.guessed, alternatives: readings.filter((y) => y !== x) })
  const at = (d: Day, x: { hour: number; minute: number }) => instantsOf({ ...d, hour: x.hour, minute: x.minute, second: 0 }, zone)
  if (date === undefined) {
    let best: { d: Day; x: { hour: number; minute: number }; i: number } | undefined
    for (let k = 0; k <= 2; k++) {
      const d = plusDays(today, k + (carry ? 1 : 0))
      if (!inYears(d)) continue
      for (const x of readings) for (const i of at(d, x)) if (i > now && (best === undefined || i < best.i)) best = { d, x, i }
    }
    return best === undefined ? undefined : [value(best.d, timeOf(best.x), best.i)]
  }
  let day = date
  if (part === "night" && t.midnight) day = plusDays(day, 1)
  else if (part === "night" && !carry && readings.every((x) => x.hour < 6)) { if (!(sameDay(day, today) && nowHour < 6)) day = plusDays(day, 1) }
  else if (t.midnight) {
    const end = plusDays(day, 1)
    if (!inYears(end)) return undefined
    return [value(day, timeOf(readings[0]!), at(day, readings[0]!)[0]), value(end, timeOf(readings[0]!), at(end, readings[0]!)[0])]
  }
  if (carry) day = plusDays(day, 1)
  if (!inYears(day)) return undefined
  if (sameDay(day, today)) {
    for (const x of readings) {
      const later = at(day, x).find((i) => i > now)
      if (later !== undefined) return [value(day, timeOf(x), later)]
    }
  }
  return [value(day, timeOf(readings[0]!), at(day, readings[0]!)[0])]
}
