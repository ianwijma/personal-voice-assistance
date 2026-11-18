// The extended `current_time` (docs/modules/clock.md): time in other places, what a time elsewhere is on a date, days
// until and since a date, a date plus an amount, and the week number. Everything is offline, imports no library, and is
// answered in a few milliseconds. Public holidays and sun times are not in this version.
//
// Dates come as ISO ("2026-12-25") or in words in the household's language ("3 March", "next monday"), read by
// `@pva/language`, which never guesses: an ambiguous date is a question back to the person. A wall-clock time is never
// guessed either: one the clocks jump over is said not to exist, one they go back over is a question (earlier or later).
import { parseDateTime, parseTimeOfDay, speakDate, speakDuration, speakTime } from "@pva/language"
import { defineTexts, say, type Language } from "@pva/module-contracts"
import { findPlace, PLACES, type Place } from "./places.ts"

export const OPS = ["now", "convert", "until", "since", "add", "week"] as const
export type Op = (typeof OPS)[number]
export const UNITS = ["days", "weeks", "months", "years"] as const

export interface ExtendedInput {
  readonly timeZone: string
  readonly op: Op
  readonly place?: string | undefined
  readonly date?: string | undefined
  readonly time?: string | undefined
  readonly from?: string | undefined
  readonly amount?: number | undefined
  readonly unit?: (typeof UNITS)[number] | undefined
  /** For op convert: which of a time that happens twice (the clocks go back over it). */
  readonly repeat?: (typeof REPEATS)[number] | undefined
}
export const REPEATS = ["earlier", "later"] as const

export const texts = defineTexts({
  en: {
    now: "It's {time} {where}, {weekday}.",
    nowHere: "It's {time}, {weekday}.",
    inPlace: "in {place}",
    unknownPlace: "I don't know where {place} is. Tell me its time zone, for example Europe/Paris.",
    unknownZone: "I don't know the time zone {zone}.",
    needTime: "Which time do you mean?",
    needDate: "Which date do you mean?",
    needAmount: "How many days, weeks, months or years?",
    cantReadTime: "I couldn't understand the time {time}.",
    cantReadDate: "I couldn't understand the date {date}.",
    askWhich: "Do you mean {options}?",
    or: "or",
    convert: "{time} in {from} is {result} in {to}.",
    convertOn: "{date}, {time} in {from} is {result} in {to}.",
    convertDated: "{time} in {from} {fromDate} is {result} in {to} {toDate}.",
    noSuchTime: "{time} does not exist in {place} {date}: the clocks go forward over it.",
    twiceTime: "{time} happens twice in {place} {date}, because the clocks go back. Do you mean the earlier one or the later one?",
    on: "on {date}",
    untilToday: "That is today.",
    untilTomorrow: "That is tomorrow.",
    untilPast: "That was {days} ago, {date}.",
    untilFuture: "{days} until {date}.",
    sinceToday: "That is today.",
    sinceFuture: "That is {days} from now, {date}.",
    sincePast: "{days} since {date}.",
    added: "That is {date}.",
    week: "{date} is in week {week}.",
    outOfRange: "That date is too far away for me.",
    today: "today"
  },
  nl: {
    now: "Het is {time} {where}, {weekday}.",
    nowHere: "Het is {time}, {weekday}.",
    inPlace: "in {place}",
    unknownPlace: "Ik weet niet waar {place} is. Noem de tijdzone, bijvoorbeeld Europe/Paris.",
    unknownZone: "Ik ken de tijdzone {zone} niet.",
    needTime: "Welke tijd bedoel je?",
    needDate: "Welke datum bedoel je?",
    needAmount: "Hoeveel dagen, weken, maanden of jaren?",
    cantReadTime: "Ik begreep de tijd {time} niet.",
    cantReadDate: "Ik begreep de datum {date} niet.",
    askWhich: "Bedoel je {options}?",
    or: "of",
    convert: "{time} in {from} is {result} in {to}.",
    convertOn: "{date}, {time} in {from} is {result} in {to}.",
    convertDated: "{time} in {from} {fromDate} is {result} in {to} {toDate}.",
    noSuchTime: "{time} bestaat niet in {place} {date}: de klok springt er dan overheen.",
    twiceTime: "{time} komt twee keer voor in {place} {date}, omdat de klok dan teruggaat. Bedoel je de eerste of de tweede keer?",
    on: "op {date}",
    untilToday: "Dat is vandaag.",
    untilTomorrow: "Dat is morgen.",
    untilPast: "Dat was {days} geleden, {date}.",
    untilFuture: "Nog {days} tot {date}.",
    sinceToday: "Dat is vandaag.",
    sinceFuture: "Dat is over {days}, {date}.",
    sincePast: "{days} sinds {date}.",
    added: "Dat is {date}.",
    week: "{date} valt in week {week}.",
    outOfRange: "Die datum is te ver weg voor mij.",
    today: "vandaag"
  }
})

/** A message for the person: the tool turns it into a `ToolError`. */
export class Say extends Error {}

type Ymd = { readonly year: number; readonly month: number; readonly day: number }

const parts = (instant: number, zone: string) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const o: Record<string, number> = {}
  for (const p of f.formatToParts(instant)) if (p.type !== "literal") o[p.type] = Number(p.value)
  return { year: o.year!, month: o.month!, day: o.day!, hour: o.hour!, minute: o.minute!, second: o.second! }
}
const offsetMs = (instant: number, zone: string): number => {
  const p = parts(instant, zone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000
}
/**
 * Every instant at which a wall-clock time happens on a day in a zone, earliest first: none when the clocks jump over
 * it, two when they go back over it. Each candidate offset (the zone's offset a day before, at, and a day after) is
 * checked by reading the instant back.
 */
const instantsOf = (y: Ymd, hour: number, minute: number, zone: string): ReadonlyArray<number> => {
  const wall = Date.UTC(y.year, y.month - 1, y.day, hour, minute)
  const offsets = new Set([offsetMs(wall - 86_400_000, zone), offsetMs(wall, zone), offsetMs(wall + 86_400_000, zone)])
  const found = new Set<number>()
  for (const o of offsets) {
    const instant = wall - o
    const p = parts(instant, zone)
    if (p.year === y.year && p.month === y.month && p.day === y.day && p.hour === hour && p.minute === minute) found.add(instant)
  }
  return [...found].sort((a, b) => a - b)
}
const dayNumber = (d: Ymd): number => Math.floor(Date.UTC(d.year, d.month - 1, d.day) / 86_400_000)
const fromDayNumber = (n: number): Ymd => {
  const d = new Date(n * 86_400_000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}
const iso = (d: Ymd): string => `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
const validDate = (d: Ymd): boolean => {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day))
  return d.year >= 1900 && d.year <= 2199 && t.getUTCFullYear() === d.year && t.getUTCMonth() === d.month - 1 && t.getUTCDate() === d.day
}
const isoWeek = (d: Ymd): number => {
  const day = (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7 // Monday 0
  const thursday = dayNumber(d) - day + 3
  const year = fromDayNumber(thursday).year
  return Math.floor((thursday - dayNumber({ year, month: 1, day: 1 })) / 7) + 1
}
const addMonths = (d: Ymd, months: number): Ymd => {
  const total = d.year * 12 + (d.month - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12 + 12) % 12 + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { year, month, day: Math.min(d.day, last) }
}

export const zoneKnown = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export interface Context {
  /** Epoch ms now. */
  readonly now: number
  /** The household's zone (the clock's own). */
  readonly zone: string
  /** The household's language as it is set now. */
  readonly lang: Language
}

const speak = (lang: Language, hour: number, minute: number): string => speakTime({ hour, minute }, lang, { style: "12h", period: true }) ?? `${hour}:${String(minute).padStart(2, "0")}`

const dateWords = (d: Ymd, lang: Language, today: Ymd): string => (validDate(d) && d.year >= 2000 && d.year <= 2199 ? speakDate(d, lang, today) : undefined) ?? new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(Date.UTC(d.year, d.month - 1, d.day))

const days = (n: number, lang: Language): string => {
  const abs = Math.abs(n)
  if (abs % 7 === 0 && abs >= 14) return speakDuration(abs * 86_400_000, lang) ?? `${abs} ${lang === "nl" ? "dagen" : "days"}`
  return `${abs} ${abs === 1 ? (lang === "nl" ? "dag" : "day") : lang === "nl" ? "dagen" : "days"}`
}

/** Resolve a place name or zone: `place` wins over `timeZone`. Throws `Say` for what the person can fix. */
const where = (input: ExtendedInput, ctx: Context): { readonly zone: string; readonly place: Place | undefined } => {
  const lang = ctx.lang
  if (input.place !== undefined && input.place.trim() !== "") {
    const place = findPlace(input.place)
    if (place !== undefined) return { zone: place.zone, place }
    if (zoneKnown(input.place.trim()) && input.place.includes("/")) return { zone: input.place.trim(), place: undefined }
    throw new Say(say(texts, lang, "unknownPlace", { place: input.place.trim().slice(0, 60) }))
  }
  if (!zoneKnown(input.timeZone)) throw new Say(say(texts, lang, "unknownZone", { zone: input.timeZone.slice(0, 60) }))
  return { zone: input.timeZone, place: undefined }
}

/** A date from ISO or words; `undefined` date: today in `zone`. */
const readDate = (text: string | undefined, zone: string, ctx: Context, optional: boolean): Ymd => {
  const today = parts(ctx.now, zone)
  if (text === undefined || text.trim() === "") {
    if (optional) return today
    throw new Say(say(texts, ctx.lang, "needDate"))
  }
  const given = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (given !== null) {
    const d = { year: Number(given[1]), month: Number(given[2]), day: Number(given[3]) }
    if (!validDate(d)) throw new Say(say(texts, ctx.lang, "cantReadDate", { date: text.slice(0, 40) }))
    return d
  }
  const read = parseDateTime(text.slice(0, 120), ctx.lang, { now: ctx.now, timeZone: zone })
  if (read.kind === "ok") return read.value.date
  if (read.kind === "ambiguous") {
    const options = read.candidates.slice(0, 3).map((c) => dateWords(c.date, ctx.lang, today)).join(` ${say(texts, ctx.lang, "or")} `)
    throw new Say(say(texts, ctx.lang, "askWhich", { options }))
  }
  throw new Say(say(texts, ctx.lang, "cantReadDate", { date: text.slice(0, 40) }))
}

const weekdayName = (d: Ymd, lang: Language): string =>
  new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", { weekday: "long", timeZone: "UTC" }).format(Date.UTC(d.year, d.month - 1, d.day))

/** A date to follow a clause: "today", "tomorrow", "yesterday" as they are, any other "on Sunday the fifteenth of March". */
const onDate = (d: Ymd, lang: Language, today: Ymd): string => {
  const said = dateWords(d, lang, today)
  const diff = dayNumber(d) - dayNumber(today)
  return Math.abs(diff) <= 1 || (lang === "nl" && Math.abs(diff) === 2) ? said : say(texts, lang, "on", { date: said })
}
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
const hhmm = (hour: number, minute: number): string => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`

export const run = (input: ExtendedInput, ctx: Context): Record<string, unknown> => {
  const lang = ctx.lang
  const { zone, place } = where(input, ctx)
  const today = parts(ctx.now, zone)
  switch (input.op) {
    case "now": {
      const time = speak(lang, today.hour, today.minute)
      const weekday = weekdayName(today, lang)
      const spoken = place === undefined && zone === ctx.zone ? say(texts, lang, "nowHere", { time, weekday }) : say(texts, lang, "now", { time, where: say(texts, lang, "inPlace", { place: place?.name ?? zone.split("/").pop()!.replace(/_/g, " ") }), weekday })
      return { op: "now", timeZone: zone, iso: `${iso(today)}T${String(today.hour).padStart(2, "0")}:${String(today.minute).padStart(2, "0")}`, spoken }
    }
    case "convert": {
      if (input.time === undefined || input.time.trim() === "") throw new Say(say(texts, lang, "needTime"))
      const fromZone = input.from === undefined || input.from.trim() === "" ? ctx.zone : (findPlace(input.from)?.zone ?? input.from.trim())
      if (!zoneKnown(fromZone) || (input.from !== undefined && findPlace(input.from) === undefined && !input.from.includes("/"))) {
        throw new Say(say(texts, lang, "unknownPlace", { place: (input.from ?? "").slice(0, 60) }))
      }
      const read = parseTimeOfDay(input.time.slice(0, 60), lang, { band: { from: "00:00", to: "23:59" } })
      if (read.kind !== "ok") throw new Say(say(texts, lang, "cantReadTime", { time: input.time.slice(0, 40) }))
      const { hour, minute } = read.value
      // The date is read in the source zone: absent, it is today there.
      const day = readDate(input.date, fromZone, ctx, true)
      const nameOf = (z: string, p?: Place) => p?.name ?? findPlaceByZone(z) ?? z.split("/").pop()!.replace(/_/g, " ")
      const fromName = input.from !== undefined ? (findPlace(input.from)?.name ?? nameOf(fromZone)) : nameOf(fromZone)
      const home = parts(ctx.now, ctx.zone)
      const time = speak(lang, hour, minute)
      const instants = instantsOf(day, hour, minute, fromZone)
      if (instants.length === 0) throw new Say(say(texts, lang, "noSuchTime", { time, place: fromName, date: onDate(day, lang, home) }))
      if (instants.length > 1 && input.repeat === undefined) throw new Say(say(texts, lang, "twiceTime", { time, place: fromName, date: onDate(day, lang, home) }))
      const instant = instants.length > 1 && input.repeat === "later" ? instants[instants.length - 1]! : instants[0]!
      const there = parts(instant, zone)
      const result = speak(lang, there.hour, there.minute)
      const toName = nameOf(zone, place)
      const nextDay = dayNumber(there) - dayNumber(day)
      const given = input.date !== undefined && input.date.trim() !== ""
      const spoken = nextDay !== 0
        ? say(texts, lang, "convertDated", { time, from: fromName, fromDate: onDate(day, lang, home), result, to: toName, toDate: onDate(there, lang, home) })
        : given
        ? say(texts, lang, "convertOn", { date: capital(onDate(day, lang, home)), time, from: fromName, result, to: toName })
        : say(texts, lang, "convert", { time, from: fromName, result, to: toName })
      return {
        op: "convert",
        from: { timeZone: fromZone, date: iso(day), time: hhmm(hour, minute) },
        to: { timeZone: zone, date: iso(there), time: hhmm(there.hour, there.minute), ...(nextDay !== 0 ? { dayOffset: nextDay } : {}) },
        spoken
      }
    }
    case "until":
    case "since": {
      const date = readDate(input.date, zone, ctx, false)
      const diff = dayNumber(date) - dayNumber(today)
      const said = dateWords(date, lang, today)
      const key = input.op === "until"
        ? diff === 0 ? "untilToday" : diff === 1 ? "untilTomorrow" : diff < 0 ? "untilPast" : "untilFuture"
        : diff === 0 ? "sinceToday" : diff > 0 ? "sinceFuture" : "sincePast"
      return { op: input.op, date: iso(date), days: diff, spoken: say(texts, lang, key, { days: days(diff, lang), date: said }) }
    }
    case "add": {
      if (input.amount === undefined) throw new Say(say(texts, lang, "needAmount"))
      const start = readDate(input.date, zone, ctx, true)
      const unit = input.unit ?? "days"
      const result = unit === "days" ? fromDayNumber(dayNumber(start) + input.amount) : unit === "weeks" ? fromDayNumber(dayNumber(start) + 7 * input.amount) : addMonths(start, unit === "months" ? input.amount : 12 * input.amount)
      if (!validDate(result)) throw new Say(say(texts, lang, "outOfRange"))
      return { op: "add", date: iso(result), weekday: weekdayName(result, lang), spoken: say(texts, lang, "added", { date: dateWords(result, lang, today) }) }
    }
    case "week": {
      const date = readDate(input.date, zone, ctx, true)
      return { op: "week", date: iso(date), week: isoWeek(date), spoken: say(texts, lang, "week", { date: dateWords(date, lang, today), week: isoWeek(date) }) }
    }
  }
}

const findPlaceByZone = (zone: string): string | undefined => PLACES.find((p) => p.zone === zone)?.name
