// The spoken-recurrence grammar of the README ("Spoken recurrence") for the tests, and its meaning: the RRULE it says and its first
// occurrence after now, found with the tests' own calendar (support/Zone.ts).
import { fixed, lit, oneOf, words, type Grammar, type Rule } from "../support/Cfg.ts"
import { daysIn, instantsOf, plusDays, wallOf, weekdayOf, type Day } from "../support/Zone.ts"
import { ordinalRules } from "./dates.ts"
import { number, type Lang } from "./numbers.ts"
import { inPart, settleReading, timeGrammar, type Period, type Reading } from "./times.ts"

interface Body {
  readonly freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
  readonly interval: number
  readonly days?: ReadonlyArray<number>
  readonly monthDays?: ReadonlyArray<number>
  readonly nth?: { readonly n: number; readonly wd: number }
  readonly date?: { readonly month: number; readonly day: number }
  readonly part?: Period
}
export interface RecurrenceReading { readonly body: Body; readonly time?: Reading }

const enWd = { monday: [1], tuesday: [2], wednesday: [3], thursday: [4], friday: [5], saturday: [6], sunday: [7], weekday: [1, 2, 3, 4, 5], weekend: [6, 7] }
const nlWd = { maandag: [1], dinsdag: [2], woensdag: [3], donderdag: [4], vrijdag: [5], zaterdag: [6], zondag: [7], werkdag: [1, 2, 3, 4, 5], weekend: [6, 7] }
const enWdPl = { mondays: [1], tuesdays: [2], wednesdays: [3], thursdays: [4], fridays: [5], saturdays: [6], sundays: [7], weekdays: [1, 2, 3, 4, 5], weekends: [6, 7] }
const nlWdPl = { maandagen: [1], dinsdagen: [2], woensdagen: [3], donderdagen: [4], vrijdagen: [5], zaterdagen: [6], zondagen: [7], werkdagen: [1, 2, 3, 4, 5], weekenden: [6, 7] }
const nlWdS = { maandags: [1], dinsdags: [2], woensdags: [3], donderdags: [4], vrijdags: [5], zaterdags: [6], zondags: [7] }
const enOne = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 }
const nlOne = { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7 }
const enParts = { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" }
const nlParts = { ochtend: "morning", middag: "afternoon", avond: "evening", nacht: "night" }
const enPartsPl = { mornings: "morning", afternoons: "afternoon", evenings: "evening", nights: "night" }
const nlPartsPl = { ochtenden: "morning", middagen: "afternoon", avonden: "evening", nachten: "night" }
const enMonths = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }
const nlMonths = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 }
const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const distinctSorted = (xs: ReadonlyArray<number>): Array<number> | undefined => (new Set(xs).size === xs.length ? [...xs].sort((a, b) => (a < 0 ? 100 : a) - (b < 0 ? 100 : b)) : undefined)

export const recurrenceGrammar = (lang: Lang): Grammar => {
  const en = lang === "en"
  const every = en ? [oneOf({ every: 1, each: 1 })] : [oneOf({ elke: 1, elk: 1, iedere: 1, ieder: 1 })]
  const and = en ? "and" : "en"
  const unitSg = en ? { day: "day", week: "week", month: "month", year: "year" } : { dag: "day", week: "week", maand: "month", jaar: "year" }
  const unitPl = en ? { days: "day", weeks: "week", months: "month", years: "year" } : { dagen: "day", weken: "week", maanden: "month", jaar: "year", jaren: "year" }
  const adverbs = en
    ? { daily: ["day", 1], weekly: ["week", 1], fortnightly: ["week", 2], monthly: ["month", 1], quarterly: ["month", 3], yearly: ["year", 1], annually: ["year", 1] }
    : { dagelijks: ["day", 1], wekelijks: ["week", 1], tweewekelijks: ["week", 2], maandelijks: ["month", 1], jaarlijks: ["year", 1] }
  const nlCompound = {
    read: (w: string) => { for (const [name, wd] of Object.entries(nlOne)) if (w.startsWith(name) && (nlParts as Record<string, string>)[w.slice(name.length)] !== undefined) return { days: [wd], part: (nlParts as Record<string, string>)[w.slice(name.length)] }; return undefined },
    write: (r: { pick: <T>(x: ReadonlyArray<T>) => T }) => `${r.pick(Object.keys(nlOne))}${r.pick(Object.keys(nlParts))}`
  }
  const interval: Array<Rule> = [
    { rhs: [oneOf(adverbs)], act: ([[unit, n]]) => ({ unit, n }) },
    { rhs: [...every, oneOf(unitSg)], act: ([, unit]) => ({ unit, n: 1 }), weight: 4 },
    { rhs: [...every, "ORD2", oneOf(unitSg)], act: ([, n, unit]) => ({ unit, n }) },
    { rhs: [...every, number(lang, { min: 2, max: 999, whole: true }), oneOf(unitPl)], act: ([, n, unit]) => ({ unit, n }), weight: 2 },
    ...(en ? [{ rhs: [...every, lit("other"), oneOf(unitSg)], act: ([, , unit]: ReadonlyArray<any>) => ({ unit, n: 2 }) }]
      : [{ rhs: [...words("om de"), oneOf(unitSg)], act: ([, , unit]: ReadonlyArray<any>) => ({ unit, n: 2 }) },
        { rhs: [...words("om de"), number("nl", { min: 2, max: 999, whole: true }), oneOf(unitPl)], act: ([, , n, unit]: ReadonlyArray<any>) => ({ unit, n }) }])
  ]
  const ofMonth: Array<Rule> = [
    fixed(words(en ? "of the month" : "van de maand"), 1, 3),
    { rhs: [lit(en ? "of" : "van"), ...every, oneOf(unitSg)], act: ([, , u]) => (u === "month" ? 1 : undefined), weight: 2 },
    { rhs: [lit(en ? "of" : "van"), ...every, "ORD2", oneOf(unitSg)], act: ([, , n, u]) => (u === "month" ? n : undefined) },
    { rhs: [lit(en ? "of" : "van"), ...every, number(lang, { min: 2, max: 999, whole: true }), oneOf(unitPl)], act: ([, , n, u]) => (u === "month" ? n : undefined) },
    ...(en ? [{ rhs: [lit("of"), ...every, lit("other"), oneOf(unitSg)], act: (v: ReadonlyArray<any>) => (v[3] === "month" ? 2 : undefined) }] : [])
  ]
  const yearDate: Array<Rule> = []
  const valid = (month: number, day: number) => (day <= maxDays[month - 1]! ? { month, day } : undefined)
  for (const the of [false, true]) for (const of of en ? [false, true] : [false]) {
    yearDate.push({ rhs: [...(the ? [lit(en ? "the" : "de")] : []), "DAYNUM", ...(of ? [lit("of")] : []), oneOf(en ? enMonths : nlMonths)], act: (v) => valid(v[v.length - 1], v[the ? 1 : 0]) })
  }
  if (en) for (const the of [false, true]) yearDate.push({ rhs: [oneOf(enMonths), ...(the ? [lit("the")] : []), "DAYNUM"], act: (v) => valid(v[0], v[v.length - 1]) })
  const time = timeGrammar(lang)
  const on = lit(en ? "on" : "op")
  return {
    ...time,
    ORD: ordinalRules(lang),
    ORD2: ordinalRules(lang, 2, 31),
    ORD25: ordinalRules(lang, 2, 5),
    ORD15: ordinalRules(lang, 1, 5),
    DAYNUM: [{ rhs: ["ORD"] }, { rhs: [number(lang, { min: 1, max: 31, whole: true })] }],
    INTERVAL: interval,
    SG: [{ rhs: [oneOf(en ? enWd : nlWd)], act: ([days]) => ({ days }), weight: 4 }, ...(en ? [] : [{ rhs: [nlCompound] }])],
    SGLIST: [{ rhs: ["SG"], act: ([x]) => [x], weight: 3 }, { rhs: ["SG", "SGLIST"], act: ([x, rest]) => [x, ...rest] }, { rhs: ["SG", lit(and), "SGLIST"], act: ([x, , rest]) => [x, ...rest] }],
    SGDAYS: [{ rhs: ["SGLIST"], act: ([items]) => {
      const days = distinctSorted(items.flatMap((i: { days: Array<number> }) => i.days))
      const parts = new Set(items.map((i: { part?: string }) => i.part))
      return days === undefined || parts.size > 1 ? undefined : { days, ...(items[0].part !== undefined ? { part: items[0].part } : {}) }
    } }],
    PLLIST: [{ rhs: [oneOf(en ? enWdPl : nlWdPl)], act: ([d]) => d, weight: 3 }, { rhs: [oneOf(en ? enWdPl : nlWdPl), "PLLIST"], act: ([d, rest]) => [...d, ...rest] }, { rhs: [oneOf(en ? enWdPl : nlWdPl), lit(and), "PLLIST"], act: ([d, , rest]) => [...d, ...rest] }],
    PLDAYS: [{ rhs: ["PLLIST"], act: ([d]) => distinctSorted(d) }],
    MDDAY: [{ rhs: ["ORD"], weight: 3 }, fixed(words(en ? "last day" : "laatste dag"), -1)],
    MDNEXT: [
      { rhs: [lit(en ? "the" : "de"), "MDDAY"], act: ([, d]) => d }, { rhs: [lit(and), "MDDAY"], act: ([, d]) => d },
      { rhs: [lit(and), lit(en ? "the" : "de"), "MDDAY"], act: ([, , d]) => d, weight: 2 }
    ],
    MDREST: [{ rhs: ["MDNEXT"], act: ([d]) => [d], weight: 3 }, { rhs: ["MDNEXT", "MDREST"], act: ([d, rest]) => [d, ...rest] }],
    MDAYS: [{ rhs: [lit(en ? "the" : "de"), "MDDAY"], act: ([, d]) => [d], weight: 3 }, { rhs: [lit(en ? "the" : "de"), "MDDAY", "MDREST"], act: ([, d, rest]) => distinctSorted([d, ...rest]) }],
    NTH: [
      { rhs: [lit(en ? "the" : "de"), "ORD15", oneOf(en ? enOne : nlOne)], act: ([, n, wd]) => ({ n, wd }) },
      { rhs: [lit(en ? "the" : "de"), lit(en ? "last" : "laatste"), oneOf(en ? enOne : nlOne)], act: ([, , wd]) => ({ n: -1, wd }) }
    ],
    OFMONTH: ofMonth,
    YEARDATE: yearDate,
    BODY: [
      { rhs: ["INTERVAL"], act: ([i]) => ({ freq: ({ day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" } as Record<string, string>)[i.unit], interval: i.n }), weight: 3 },
      { rhs: ["INTERVAL", on, "SGDAYS"], act: ([i, , l]) => (i.unit === "week" && l.part === undefined ? { freq: "WEEKLY", interval: i.n, days: l.days } : undefined) },
      { rhs: ["INTERVAL", on, "PLDAYS"], act: ([i, , d]) => (i.unit === "week" ? { freq: "WEEKLY", interval: i.n, days: d } : undefined) },
      { rhs: ["INTERVAL", on, "MDAYS"], act: ([i, , d]) => (i.unit === "month" ? { freq: "MONTHLY", interval: i.n, monthDays: d } : undefined) },
      { rhs: ["INTERVAL", on, "NTH"], act: ([i, , nth]) => (i.unit === "month" ? { freq: "MONTHLY", interval: i.n, nth } : undefined) },
      { rhs: ["INTERVAL", on, "YEARDATE"], act: ([i, , date]) => (i.unit === "year" ? { freq: "YEARLY", interval: i.n, date } : undefined) },
      { rhs: [...every, "SGDAYS"], act: ([, l]) => ({ freq: "WEEKLY", interval: 1, ...l }), weight: 4 },
      { rhs: [...every, "SGDAYS", oneOf(en ? enParts : nlParts)], act: ([, l, part]) => (l.part !== undefined ? undefined : { freq: "WEEKLY", interval: 1, days: l.days, part }) },
      { rhs: [...every, "ORD25", oneOf(en ? enOne : nlOne)], act: ([, n, wd]) => ({ freq: "WEEKLY", interval: n, days: [wd] }) },
      ...(en ? [{ rhs: [...words("every other"), oneOf(enOne)], act: ([, , wd]: ReadonlyArray<any>) => ({ freq: "WEEKLY", interval: 2, days: [wd] }) }] : []),
      { rhs: [...every, oneOf(en ? enParts : nlParts)], act: ([, part]) => ({ freq: "DAILY", interval: 1, part }) },
      { rhs: ["PLDAYS"], act: ([days]) => ({ freq: "WEEKLY", interval: 1, days }) },
      { rhs: [on, "PLDAYS"], act: ([, days]) => ({ freq: "WEEKLY", interval: 1, days }) },
      { rhs: ["PLDAYS", oneOf(en ? enPartsPl : nlPartsPl)], act: ([days, part]) => ({ freq: "WEEKLY", interval: 1, days, part }) },
      { rhs: [on, "PLDAYS", oneOf(en ? enPartsPl : nlPartsPl)], act: ([, days, part]) => ({ freq: "WEEKLY", interval: 1, days, part }) },
      ...(en
        ? [{ rhs: ["SGDAYS", oneOf(enPartsPl)], act: ([l, part]: ReadonlyArray<any>) => (l.part !== undefined ? undefined : { freq: "WEEKLY", interval: 1, days: l.days, part }) },
          { rhs: [on, "SGDAYS", oneOf(enPartsPl)], act: ([, l, part]: ReadonlyArray<any>) => (l.part !== undefined ? undefined : { freq: "WEEKLY", interval: 1, days: l.days, part }) }]
        : [{ rhs: [lit("'s"), oneOf(nlWdS)], act: ([, days]: ReadonlyArray<any>) => ({ freq: "WEEKLY", interval: 1, days }) }, { rhs: [oneOf(nlWdS)], act: ([days]: ReadonlyArray<any>) => ({ freq: "WEEKLY", interval: 1, days }) }]),
      { rhs: ["MDAYS", "OFMONTH"], act: ([monthDays, n]) => ({ freq: "MONTHLY", interval: n, monthDays }), weight: 2 },
      { rhs: [on, "MDAYS", "OFMONTH"], act: ([, monthDays, n]) => ({ freq: "MONTHLY", interval: n, monthDays }) },
      { rhs: ["NTH", "OFMONTH"], act: ([nth, n]) => ({ freq: "MONTHLY", interval: n, nth }), weight: 2 },
      { rhs: [on, "NTH", "OFMONTH"], act: ([, nth, n]) => ({ freq: "MONTHLY", interval: n, nth }) },
      { rhs: [...every, "ORD", "OFMONTH"], act: ([, d, i]) => ({ freq: "MONTHLY", interval: i, monthDays: [d] }) },
      { rhs: [...every, "ORD15", oneOf(en ? enOne : nlOne), "OFMONTH"], act: ([, n, wd, i]) => ({ freq: "MONTHLY", interval: i, nth: { n, wd } }) },
      { rhs: [...every, lit(en ? "last" : "laatste"), oneOf(en ? enOne : nlOne), "OFMONTH"], act: ([, , wd, i]) => ({ freq: "MONTHLY", interval: i, nth: { n: -1, wd } }) },
      { rhs: [...every, "YEARDATE"], act: ([, date]) => ({ freq: "YEARLY", interval: 1, date }) }
    ],
    TIMEC: [{ rhs: [lit(en ? "at" : "om"), "TIME"], act: ([, t]) => t }],
    PHRASE: [
      { rhs: ["BODY"], act: ([body]) => ({ body }), weight: 2 },
      { rhs: ["BODY", "TIMEC"], act: ([body, time]) => ({ body, time }), weight: 2 },
      { rhs: ["TIMEC", "BODY"], act: ([time, body]) => ({ body, time }) }
    ]
  }
}

// ---- the meaning ---------------------------------------------------------------------------------------------------------------------

const codes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
const partTime: Record<Period, { hour: number; minute: number } | undefined> = { morning: { hour: 8, minute: 0 }, afternoon: { hour: 14, minute: 0 }, evening: { hour: 19, minute: 0 }, night: { hour: 22, minute: 0 }, am: undefined, pm: undefined }

export interface RecurrenceMeaning {
  readonly rrule: string
  readonly dtstart: string
  readonly time?: { readonly hour: number; readonly minute: number; readonly guessed: boolean; readonly alternatives: ReadonlyArray<{ readonly hour: number; readonly minute: number }> }
  readonly partOfDay?: Period
  readonly timeDefaulted: boolean
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")
/** The meaning of a reading at `now` in `zone`, or `undefined` when the parts do not fit or there is no occurrence in the supported years. */
export const recurrenceMeaning = (r: RecurrenceReading, now: number, zone: string, defaultTime?: { hour: number; minute: number }): RecurrenceMeaning | undefined => {
  const b = r.body
  let time: RecurrenceMeaning["time"]
  let small = false
  if (r.time !== undefined) {
    const t = r.time
    if (t.hour === 24) return undefined
    if (t.period !== undefined && b.part !== undefined && t.period !== b.part && t.period !== "am" && t.period !== "pm") return undefined
    const s = settleReading(t.period === undefined && b.part !== undefined ? { ...t, period: b.part } : t)
    if (s === undefined || s === "both") return undefined
    if (b.part !== undefined && !inPart(b.part, s.hour)) return undefined
    time = s
    small = [s, ...s.alternatives].every((x) => x.hour < 6)
    if (t.midnight && b.freq !== "DAILY" && b.part !== "night") return undefined
  }
  const partDefault = b.part === undefined ? undefined : defaultTime !== undefined && inPart(b.part, defaultTime.hour) ? defaultTime : partTime[b.part]
  const clock = time ?? partDefault ?? defaultTime ?? { hour: 9, minute: 0 }
  const shift = b.part === "night" && clock.hour < 6 && (time === undefined || small) ? 1 : 0
  if (shift === 1 && b.freq !== "DAILY" && b.freq !== "WEEKLY") return undefined
  const days = b.days?.map((d) => ((d - 1 + shift) % 7) + 1).sort((x, y) => x - y)
  const monthDays = b.monthDays ?? (b.date !== undefined ? [b.date.day] : [])
  const rrule = [`FREQ=${b.freq}`, ...(b.interval > 1 ? [`INTERVAL=${b.interval}`] : []), ...(b.date !== undefined ? [`BYMONTH=${b.date.month}`] : []),
    ...(monthDays.length > 0 ? [`BYMONTHDAY=${monthDays.join(",")}`] : []),
    ...(days !== undefined ? [`BYDAY=${days.map((d) => codes[d - 1]).join(",")}`] : b.nth !== undefined ? [`BYDAY=${b.nth.n}${codes[b.nth.wd - 1]}`] : [])].join(";")
  const w = wallOf(now, zone)
  const today: Day = { year: w.year, month: w.month, day: w.day }
  const selects = (d: Day): boolean => {
    switch (b.freq) {
      case "DAILY": return true
      case "WEEKLY": return (days ?? [weekdayOf(today)]).includes(weekdayOf(d))
      case "MONTHLY":
        if (b.nth !== undefined) {
          if (weekdayOf(d) !== b.nth.wd) return false
          return b.nth.n > 0 ? Math.ceil(d.day / 7) === b.nth.n : d.day + 7 > daysIn(d.year, d.month)
        }
        return b.monthDays !== undefined ? b.monthDays.some((x) => (x === -1 ? d.day === daysIn(d.year, d.month) : d.day === x)) : d.day === today.day
      case "YEARLY": return b.date !== undefined ? d.month === b.date.month && d.day === b.date.day : d.month === today.month && d.day === today.day
    }
  }
  for (let k = 0; k <= 366 * 8 + 31; k++) {
    const d = plusDays(today, k)
    if (d.year > 2199) return undefined
    if (!selects(d)) continue
    const instant = instantsOf({ ...d, hour: clock.hour, minute: clock.minute, second: 0 }, zone)[0]!
    if (instant <= now) continue
    return {
      rrule, dtstart: `DTSTART;TZID=${zone}:${pad(d.year, 4)}${pad(d.month)}${pad(d.day)}T${pad(clock.hour)}${pad(clock.minute)}00`,
      ...(time !== undefined ? { time } : {}), ...(b.part !== undefined ? { partOfDay: b.part } : {}), timeDefaulted: time === undefined
    }
  }
  return undefined
}
