// The extended `current_time` (docs/modules/clock.md): time in other places, what a time elsewhere is here, days until and
// since a date, a date plus an amount, the week number, public holidays and sunrise and sunset. Everything is offline and
// answered in a few milliseconds. The two libraries for holidays and the sun are loaded the first time they are used.
//
// Dates come as ISO ("2026-12-25") or in words in the household's language ("3 March", "next monday"), read by
// `@pva/language`, which never guesses: an ambiguous date is a question back to the person.
import { parseDateTime, parseTimeOfDay, speakDate, speakDuration, speakTime } from "@pva/language"
import { defineTexts, say, type Language } from "@pva/module-contracts"
import { findPlace, PLACES, type Place } from "./places.ts"

export const OPS = ["now", "convert", "until", "since", "add", "week", "holidays", "sun"] as const
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
  readonly country?: string | undefined
}

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
    untilToday: "That is today.",
    untilTomorrow: "That is tomorrow.",
    untilPast: "That was {days} ago, {date}.",
    untilFuture: "{days} until {date}.",
    sinceToday: "That is today.",
    sinceFuture: "That is {days} from now, {date}.",
    sincePast: "{days} since {date}.",
    added: "That is {date}.",
    week: "{date} is in week {week}.",
    holidayYes: "Yes, {date} is a public holiday: {name}.",
    holidayNo: "No, {date} is not a public holiday.",
    holidayNext: "The next public holiday is {name}, {date}.",
    holidayNone: "I found no public holiday ahead.",
    holidayMore: "{list}.",
    needCountry: "For which country? I can't tell from the time zone {zone}.",
    unknownCountry: "I don't have public holidays for {country}.",
    sunBoth: "Sunrise is at {rise} and sunset at {set}{where}.",
    sunNone: "The sun does not rise and set {when}{where}.",
    sunWhen: "on {date}",
    sunWhere: " in {place}",
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
    untilToday: "Dat is vandaag.",
    untilTomorrow: "Dat is morgen.",
    untilPast: "Dat was {days} geleden, {date}.",
    untilFuture: "Nog {days} tot {date}.",
    sinceToday: "Dat is vandaag.",
    sinceFuture: "Dat is over {days}, {date}.",
    sincePast: "{days} sinds {date}.",
    added: "Dat is {date}.",
    week: "{date} valt in week {week}.",
    holidayYes: "Ja, {date} is een feestdag: {name}.",
    holidayNo: "Nee, {date} is geen feestdag.",
    holidayNext: "De volgende feestdag is {name}, {date}.",
    holidayNone: "Ik vond geen feestdag in de toekomst.",
    holidayMore: "{list}.",
    needCountry: "Voor welk land? Aan de tijdzone {zone} kan ik dat niet zien.",
    unknownCountry: "Ik heb geen feestdagen voor {country}.",
    sunBoth: "De zon komt op om {rise} en gaat onder om {set}{where}.",
    sunNone: "De zon komt niet op en gaat niet onder {when}{where}.",
    sunWhen: "op {date}",
    sunWhere: " in {place}",
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
/** The instant a wall-clock time is in a zone (twice, so a daylight-saving change between the guess and the answer settles). */
const instantOf = (y: Ymd, hour: number, minute: number, zone: string): number => {
  const guess = Date.UTC(y.year, y.month - 1, y.day, hour, minute)
  const first = guess - offsetMs(guess, zone)
  return guess - offsetMs(first, zone)
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

/** The country of a zone, for the holidays: the table's cities say it. */
const COUNTRY: Readonly<Record<string, string>> = {
  "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES",
  "Europe/Lisbon": "PT", "Europe/Rome": "IT", "Europe/Vienna": "AT", "Europe/Zurich": "CH", "Europe/Copenhagen": "DK", "Europe/Stockholm": "SE", "Europe/Oslo": "NO",
  "Europe/Helsinki": "FI", "Europe/Warsaw": "PL", "Europe/Prague": "CZ", "Europe/Athens": "GR", "Europe/Istanbul": "TR", "America/New_York": "US", "America/Chicago": "US",
  "America/Denver": "US", "America/Los_Angeles": "US", "America/Toronto": "CA", "America/Vancouver": "CA", "Australia/Sydney": "AU", "Australia/Melbourne": "AU",
  "Pacific/Auckland": "NZ", "Asia/Tokyo": "JP", "America/Paramaribo": "SR", "America/Curacao": "CW"
}

export interface Context {
  /** Epoch ms now. */
  readonly now: number
  /** The household's zone (the clock's own). */
  readonly zone: string
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

const homeCountry = (zone: string): string | undefined => COUNTRY[zone]

export const run = async (input: ExtendedInput, ctx: Context): Promise<Record<string, unknown>> => {
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
      const base = parts(ctx.now, fromZone)
      const instant = instantOf(base, read.value.hour, read.value.minute, fromZone)
      const there = parts(instant, zone)
      const nameOf = (z: string, p?: Place) => p?.name ?? findPlaceByZone(z) ?? z.split("/").pop()!.replace(/_/g, " ")
      const fromName = input.from !== undefined ? (findPlace(input.from)?.name ?? nameOf(fromZone)) : nameOf(fromZone)
      const result = speak(lang, there.hour, there.minute)
      const nextDay = dayNumber(there) - dayNumber(base)
      return {
        op: "convert",
        from: { timeZone: fromZone, time: `${String(read.value.hour).padStart(2, "0")}:${String(read.value.minute).padStart(2, "0")}` },
        to: { timeZone: zone, time: `${String(there.hour).padStart(2, "0")}:${String(there.minute).padStart(2, "0")}`, ...(nextDay !== 0 ? { dayOffset: nextDay } : {}) },
        spoken: say(texts, lang, "convert", { time: speak(lang, read.value.hour, read.value.minute), from: fromName, result, to: nameOf(zone, place) })
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
    case "holidays": {
      const country = (input.country ?? homeCountry(zone))?.toUpperCase()
      if (country === undefined) throw new Say(say(texts, lang, "needCountry", { zone }))
      if (!/^[A-Z]{2}$/.test(country)) throw new Say(say(texts, lang, "unknownCountry", { country: country.slice(0, 10) }))
      const { default: Holidays } = await import("date-holidays")
      const hd = new Holidays(country)
      hd.setLanguages(lang)
      if (hd.getCountries === undefined || hd.getHolidays(today.year).length === 0) throw new Say(say(texts, lang, "unknownCountry", { country }))
      const of = (year: number) => hd.getHolidays(year).filter((h) => h.type === "public").map((h) => ({ date: h.date.slice(0, 10), name: h.name }))
      if (input.date !== undefined && input.date.trim() !== "") {
        const date = readDate(input.date, zone, ctx, false)
        const found = of(date.year).find((h) => h.date === iso(date))
        return found === undefined
          ? { op: "holidays", date: iso(date), holiday: false, spoken: say(texts, lang, "holidayNo", { date: dateWords(date, lang, today) }) }
          : { op: "holidays", date: iso(date), holiday: true, name: found.name, spoken: say(texts, lang, "holidayYes", { date: dateWords(date, lang, today), name: found.name }) }
      }
      const upcoming = [...of(today.year), ...of(today.year + 1)].filter((h) => h.date >= iso(today)).slice(0, 5)
      const next = upcoming[0]
      if (next === undefined) return { op: "holidays", upcoming: [], spoken: say(texts, lang, "holidayNone") }
      const [y, m, d] = next.date.split("-").map(Number) as [number, number, number]
      return { op: "holidays", country, upcoming, spoken: say(texts, lang, "holidayNext", { name: next.name, date: dateWords({ year: y, month: m, day: d }, lang, today) }) }
    }
    case "sun": {
      const at = place ?? PLACES.find((p) => p.zone === zone)
      if (at === undefined) throw new Say(say(texts, lang, "unknownPlace", { place: input.place ?? zone }))
      const date = readDate(input.date, zone, ctx, true)
      const loaded = await import("suncalc")
      const SunCalc: typeof loaded = (loaded as unknown as { readonly default?: typeof loaded }).default ?? loaded
      const noon = new Date(instantOf(date, 12, 0, zone))
      const t = SunCalc.getTimes(noon, at.lat, at.lon)
      const valid = (x: Date | null): x is Date => x !== null && !Number.isNaN(x.getTime())
      const place$ = place === undefined ? "" : say(texts, lang, "sunWhere", { place: place.name })
      if (!valid(t.sunrise) || !valid(t.sunset)) return { op: "sun", date: iso(date), spoken: say(texts, lang, "sunNone", { when: say(texts, lang, "sunWhen", { date: dateWords(date, lang, today) }), where: place$ }) }
      const rise = parts(t.sunrise.getTime(), zone)
      const set = parts(t.sunset.getTime(), zone)
      const hhmm = (p: { hour: number; minute: number }) => `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`
      return { op: "sun", date: iso(date), sunrise: hhmm(rise), sunset: hhmm(set), spoken: say(texts, lang, "sunBoth", { rise: speak(lang, rise.hour, rise.minute), set: speak(lang, set.hour, set.minute), where: place$ }) }
    }
  }
}

const findPlaceByZone = (zone: string): string | undefined => PLACES.find((p) => p.zone === zone)?.name
