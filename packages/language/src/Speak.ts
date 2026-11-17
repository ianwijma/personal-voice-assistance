import { dicts } from "./Dict.ts"
import { guarded, isLanguage, isOptions, maxDurationMs, maxNumber, maxTextLength } from "./Domain.ts"
import type { ClockTime, Language, LocalDate } from "./Result.ts"
import type { PackUnit, UnitId } from "./Quantity.ts"
import { monthNames, numberToWords, ordinalToWords, weekdayNames } from "./Words.ts"
import { dayDiff, inRange, isoWeekday } from "./Zoned.ts"

/**
 * The speakers. Each checks its arguments and answers `undefined` — "cannot say this" — for anything outside its domain (README,
 * domain table), never an empty or a wrong utterance (review round 3, decision 1). Which outputs read back with a parser is in the
 * README ("Speaking"): numbers, durations, clock times and dates read back (round 4, decision 2); `speakAmount` promises instead never to
 * state another quantity than it was given. The tests prove each promise over the whole enumerable domain.
 */

const isDate = (d: unknown): d is LocalDate =>
  typeof d === "object" && d !== null && inRange(d as LocalDate)

/**
 * A number for the speech synthesiser: digits with the language's decimal mark ("2.5", "2,5"), rounded to two decimals, trailing
 * zeros dropped, no thousands separator; a negative number with "minus" / "min" ("minus 3"). `words`: "forty two point five" /
 * "tweeënveertig komma vijf". `undefined` when it is not a finite number, its size is above 999 999.99, or it is not 0 but rounds
 * to 0 (a nonzero number is never said as 0). `parseNumber` reads every result back to the number rounded to two decimals.
 */
export const speakNumber: (n: number, language: Language, options?: { readonly words?: boolean }) => string | undefined = guarded((n: number, language: Language, options?: { readonly words?: boolean }): string | undefined => {
  if (typeof n !== "number" || !Number.isFinite(n) || !isLanguage(language) || !isOptions(options)) return undefined
  // The size is checked on the number given, not on its rounding: 999 999.994 is above 999 999.99 (review round 4, finding 9).
  if (Math.abs(n) > maxSpoken) return undefined
  const hundredths = Math.round(Math.abs(n) * 100)
  if (n !== 0 && hundredths === 0) return undefined
  const whole = Math.floor(hundredths / 100)
  const fraction = String(hundredths % 100).padStart(2, "0").replace(/0+$/, "")
  const sign = n < 0 ? (language === "en" ? "minus " : "min ") : ""
  if (options?.words !== true) return `${sign}${whole}${fraction === "" ? "" : (language === "en" ? "." : ",") + fraction}`
  const w = numberToWords(whole, language)!
  if (fraction === "") return sign + w
  const digits = fraction.split("").map((d) => numberToWords(Number(d), language)!).join(" ")
  return `${sign}${w} ${language === "en" ? "point" : "komma"} ${digits}`
}, undefined)

/** The largest size `speakNumber` says: 999 999.99. */
const maxSpoken = maxNumber + 0.99

interface Names {
  readonly one: string
  readonly many: string
}
const n = (one: string, many = one): Names => ({ one, many })
const unitNames = dicts<Language, Names>({
  en: {
    g: n("gram", "grams"), kg: n("kilogram", "kilograms"), oz: n("ounce", "ounces"), lb: n("pound", "pounds"),
    ml: n("millilitre", "millilitres"), cl: n("centilitre", "centilitres"), dl: n("decilitre", "decilitres"), l: n("litre", "litres"),
    tsp: n("teaspoon", "teaspoons"), tbsp: n("tablespoon", "tablespoons"), cup: n("cup", "cups"),
    pack: n("pack", "packs"), bag: n("bag", "bags"), bottle: n("bottle", "bottles"), can: n("can", "cans"), jar: n("jar", "jars"), bunch: n("bunch", "bunches"),
    loaf: n("loaf", "loaves"), box: n("box", "boxes"), tub: n("tub", "tubs"), roll: n("roll", "rolls"),
    piece: n("piece", "pieces"), handful: n("handful", "handfuls"), pinch: n("pinch", "pinches"), splash: n("splash", "splashes")
  },
  // No ounce or pound: Dutch "pond" is 500 g, and Dutch has no word for 453.6 g that this package reads (finding 11).
  nl: {
    g: n("gram"), kg: n("kilo"), ml: n("milliliter"), cl: n("centiliter"), dl: n("deciliter"), l: n("liter"),
    tsp: n("theelepel", "theelepels"), tbsp: n("eetlepel", "eetlepels"), cup: n("kopje", "kopjes"),
    pack: n("pak", "pakken"), bag: n("zak", "zakken"), bottle: n("fles", "flessen"), can: n("blik", "blikken"), jar: n("pot", "potten"), bunch: n("bos", "bossen"),
    loaf: n("brood", "broden"), box: n("doos", "dozen"), tub: n("bak", "bakken"), roll: n("rol", "rollen"),
    piece: n("stuk", "stuks"), handful: n("handvol"), pinch: n("snufje", "snufjes"), splash: n("scheutje", "scheutjes")
  }
})
const packUnits: ReadonlySet<UnitId> = new Set<PackUnit>(["pack", "bag", "bottle", "can", "jar", "bunch", "loaf", "box", "tub", "roll"])
const vagueUnits: ReadonlySet<UnitId> = new Set<UnitId>(["handful", "pinch", "splash"])
const singularAfterNumber: ReadonlySet<UnitId> = new Set<UnitId>(["g", "kg", "ml", "cl", "dl", "l"])

export interface AmountLike {
  readonly amount?: number | undefined
  readonly unit?: UnitId | undefined
  readonly approx?: boolean | undefined
  readonly rest?: boolean | undefined
}
export interface SpeakAmountOptions {
  /** What it is an amount of: "rice" → "about 750 grams of rice" / "ongeveer 750 gram rijst". At most 200 characters. */
  readonly item?: string
  /** 0.25 kg is "250 grams", 1500 g "1.5 kilograms" (only when nothing is lost); 0.25 l "250 millilitres". Default true. */
  readonly humanize?: boolean
}

const article = (language: Language, word: string): string => (language === "nl" ? "een" : /^[aeiou]/.test(word) ? "an" : "a")
/**
 * Whole hundredths: `x` said by `speakNumber` is `x` itself. The allowance is a few units in the last place of `x * 100` (the error a
 * decimal fraction and a sum or unit change of them leave in binary: 0.1 + 0.2 is 0.3), scaled to the number's size, not a fixed
 * amount: 1.000000001 is not whole hundredths (review round 5, finding 6).
 */
const exact = (x: number): boolean => {
  const h = Math.round(x * 100)
  return Math.abs(x * 100 - h) <= 4 * Number.EPSILON * Math.abs(h)
}

/**
 * An amount with its unit, as it is said: "about 750 grams of rice", "2 kilo bloem", "a pack of milk", "a handful of nuts", "3
 * apples", "some rice", "the rest of the rice". Dutch units stay singular after a number ("2 liter"). For speaking, not promised to
 * read back; the promise (review round 4, decision 2) is that it never states another quantity than it was given: nothing is rounded
 * (an amount that is not whole hundredths of the unit it is said in, after humanising, is `undefined`), humanising only changes the
 * unit when the amount stays exact (1500 g is "1.5 kilograms", 1.234 kg "1234 grams"), and "about" is said only when `approx` is
 * true. A handful, a pinch and a splash are vague by themselves: said as given, without "about". `undefined` when the amount is not a
 * positive number `speakNumber` says, the unit is not one of `UnitId` (Dutch: an ounce or a pound), or the item is longer than 200
 * characters.
 */
export const speakAmount: (q: AmountLike, language: Language, options?: SpeakAmountOptions) => string | undefined = guarded((q: AmountLike, language: Language, options?: SpeakAmountOptions): string | undefined => {
  if (typeof q !== "object" || q === null || !isLanguage(language) || !isOptions(options)) return undefined
  const given = options?.item
  if (given !== undefined && (typeof given !== "string" || given.length > maxTextLength)) return undefined
  const item = given !== undefined && given.trim() !== "" ? given.trim() : undefined
  const en = language === "en"
  if (q.rest === true) return en ? (item === undefined ? "the rest" : `the rest of the ${item.replace(/^the\s+/i, "")}`) : (item === undefined ? "de rest" : `de rest van ${item}`)
  let amount = q.amount
  let unit = q.unit
  if (amount === undefined && unit === undefined) {
    if (item === undefined) return undefined
    return en ? `some ${item}` : `wat ${item}`
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || !(amount > 0)) return undefined
  const about = q.approx === true ? (en ? "about " : "ongeveer ") : ""
  if (unit === undefined || unit === "piece") {
    if ((item === undefined && unit === undefined) || !exact(amount) || speakNumber(amount, language) === undefined) return undefined
    const count = `${about}${speakNumber(amount, language)!}`
    const names = unitNames[language]["piece"]!
    return item !== undefined ? `${count} ${item}` : `${count} ${speakNumber(amount, language) === "1" ? names.one : names.many}`
  }
  if (unitNames[language][unit] === undefined) return undefined
  if (options?.humanize !== false) {
    if (amount < 1 && (unit === "kg" || unit === "l")) { amount = amount * 1000; unit = unit === "kg" ? "g" : "ml" }
    else if (amount >= 1000 && (unit === "g" || unit === "ml") && exact(amount / 1000)) { amount = amount / 1000; unit = unit === "g" ? "kg" : "l" }
    // 1.234 kg is 1234 grams: said exactly in the smaller unit rather than rounded in the larger.
    else if ((unit === "kg" || unit === "l") && !exact(amount) && exact(amount * 1000)) { amount = amount * 1000; unit = unit === "kg" ? "g" : "ml" }
  }
  // Never a different quantity (review round 4, finding 2): an amount that is not whole hundredths of the unit it is said in would be
  // rounded by `speakNumber`, so it is not said.
  if (!exact(amount)) return undefined
  const names = unitNames[language][unit]!
  const of = (text: string) => (item === undefined ? text : en ? `${text} of ${item}` : `${text} ${item}`)
  const said = speakNumber(amount, language)
  if (said === undefined) return undefined
  if (vagueUnits.has(unit)) {
    if (said === "1") return of(`${article(language, names.one)} ${names.one}`)
    return of(`${said} ${names.many}`)
  }
  if (said === "1" && packUnits.has(unit)) return of(`${about}${article(language, names.one)} ${names.one}`)
  const noun = (!en && (singularAfterNumber.has(unit) || amount < 1)) || said === "1" ? names.one : names.many
  return of(`${about}${said} ${noun}`)
}, undefined)

export interface SpeakTimeOptions {
  /** "12h": "half past seven", "kwart over zeven". "24h": "nineteen thirty", "negentien uur dertig". Default "12h". */
  readonly style?: "12h" | "24h"
  /**
   * Add "in the evening" / "'s avonds" so that the part of the day is said. In the 24-hour style only to an hour 1–12 (the others are
   * settled by their words). Default false.
   */
  readonly period?: boolean
}

const dayPart = (hour: number): "morning" | "afternoon" | "evening" | "night" =>
  hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : hour < 22 ? "evening" : "night"
const periodText: Record<Language, Record<"morning" | "afternoon" | "evening" | "night", string>> = {
  en: { morning: "in the morning", afternoon: "in the afternoon", evening: "in the evening", night: "at night" },
  nl: { morning: "'s ochtends", afternoon: "'s middags", evening: "'s avonds", night: "'s nachts" }
}
const words = (x: number, language: Language): string => numberToWords(x, language)!

/**
 * A clock time as it is said. `undefined` unless the hour is a whole number 0–23 and the minute 0–59. Every result reads back with
 * `parseTimeOfDay` (README, "Speaking").
 */
export const speakTime: (t: ClockTime, language: Language, options?: SpeakTimeOptions) => string | undefined = guarded((t: ClockTime, language: Language, options?: SpeakTimeOptions): string | undefined => {
  if (typeof t !== "object" || t === null || !isLanguage(language) || !isOptions(options)) return undefined
  const { hour, minute } = t
  const style = options?.style ?? "12h"
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || (style !== "12h" && style !== "24h")) return undefined
  if (style === "24h") {
    // With `period`, an hour 1–12 says its part of the day too, so that it reads back exactly (review round 5, finding 2): "een uur
    // dertig 's nachts", "ten thirty in the morning". Hours 0 and 13–23 are settled by their words.
    const part = options?.period === true && hour >= 1 && hour <= 12 ? " " + periodText[language][dayPart(hour)] : ""
    if (language === "en") {
      if (hour === 0 && minute === 0) return "midnight"
      const h = hour === 0 ? "zero" : hour < 10 ? `oh ${words(hour, "en")}` : words(hour, "en")
      const m = minute === 0 ? "hundred" : minute < 10 ? `oh ${words(minute, "en")}` : words(minute, "en")
      return `${h} ${m}${part}`
    }
    if (hour === 0 && minute === 0) return "middernacht"
    return `${words(hour, "nl")} uur${minute === 0 ? "" : " " + words(minute, "nl")}${part}`
  }
  if (language === "nl" && hour === 0 && minute === 0) return "middernacht"
  const h12 = (x: number) => (x % 12 === 0 ? 12 : x % 12)
  // English says noon and midnight; Dutch says middernacht, and twelve noon is "twaalf uur 's middags".
  const said = language === "en" ? minute === 0 && (hour === 0 || hour === 12) : hour === 0 && minute === 0
  const suffix = options?.period === true && !said ? " " + periodText[language][dayPart(hour)] : ""
  if (language === "en") {
    const cur = words(h12(hour), "en")
    const next = words(h12(hour + 1), "en")
    if (minute === 0) return (hour === 12 ? "noon" : hour === 0 ? "midnight" : `${cur} o'clock`) + suffix
    const table: Record<number, string> = {
      5: `five past ${cur}`, 10: `ten past ${cur}`, 15: `quarter past ${cur}`, 20: `twenty past ${cur}`, 25: `twenty five past ${cur}`, 30: `half past ${cur}`,
      35: `twenty five to ${next}`, 40: `twenty to ${next}`, 45: `quarter to ${next}`, 50: `ten to ${next}`, 55: `five to ${next}`
    }
    return (table[minute] ?? `${cur} ${minute < 10 ? "oh " : ""}${words(minute, "en")}`) + suffix
  }
  const cur = words(h12(hour), "nl")
  const next = words(h12(hour + 1), "nl")
  const table: Record<number, string> = {
    0: `${cur} uur`, 5: `vijf over ${cur}`, 10: `tien over ${cur}`, 15: `kwart over ${cur}`, 20: `tien voor half ${next}`, 25: `vijf voor half ${next}`,
    30: `half ${next}`, 35: `vijf over half ${next}`, 40: `tien over half ${next}`, 45: `kwart voor ${next}`, 50: `tien voor ${next}`, 55: `vijf voor ${next}`
  }
  return (table[minute] ?? `${cur} uur ${words(minute, "nl")}`) + suffix
}, undefined)

/**
 * A duration in milliseconds as it is said, to the second: "6 minutes 10 seconds", "1 day 12 hours", "6 minuten 10 seconden"; round
 * values in words: "half an hour" / "een half uur", "an hour and a half" / "anderhalf uur", "a quarter of an hour" / "een kwartier",
 * "three quarters of an hour" / "drie kwartier". `undefined` unless it is from 1 second to 365 days (after rounding to the second).
 * Every result reads back with `parseDuration` to the rounded duration.
 */
export const speakDuration: (ms: number, language: Language, options?: { readonly natural?: boolean }) => string | undefined = guarded((ms: number, language: Language, options?: { readonly natural?: boolean }): string | undefined => {
  if (typeof ms !== "number" || !Number.isFinite(ms) || !isLanguage(language) || !isOptions(options)) return undefined
  const total = Math.round(ms / 1000)
  if (total < 1 || total * 1000 > maxDurationMs) return undefined
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const en = language === "en"
  if (options?.natural !== false && days === 0) {
    if (total === 900) return en ? "a quarter of an hour" : "een kwartier"
    if (total === 1800) return en ? "half an hour" : "een half uur"
    if (total === 2700) return en ? "three quarters of an hour" : "drie kwartier"
    if (seconds === 0 && minutes === 30 && hours >= 1 && hours <= 12) {
      return en ? (hours === 1 ? "an hour and a half" : `${words(hours, "en")} and a half hours`) : (hours === 1 ? "anderhalf uur" : `${words(hours, "nl")} en een half uur`)
    }
    if (hours === 0 && seconds === 30 && minutes >= 1 && minutes <= 9) {
      return en ? (minutes === 1 ? "a minute and a half" : `${words(minutes, "en")} and a half minutes`) : (minutes === 1 ? "anderhalve minuut" : `${words(minutes, "nl")} en een halve minuut`)
    }
  }
  const part = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const parts: Array<string> = []
  if (days > 0) parts.push(part(days, en ? "day" : "dag", en ? "days" : "dagen"))
  if (hours > 0) parts.push(part(hours, en ? "hour" : "uur", en ? "hours" : "uur"))
  if (minutes > 0) parts.push(part(minutes, en ? "minute" : "minuut", en ? "minutes" : "minuten"))
  if (seconds > 0) parts.push(part(seconds, en ? "second" : "seconde", en ? "seconds" : "seconden"))
  return parts.join(" ")
}, undefined)

/**
 * A date relative to `today`: "today", "tomorrow", "yesterday", "Friday" (two to six days ahead), "Friday the third" (later this
 * month), "Friday the third of March" (later this year), "Friday the third of March 2027" (another year, or the past). Dutch:
 * "vandaag", "morgen", "overmorgen", "gisteren", "eergisteren", "vrijdag", "vrijdag de derde", "vrijdag 3 maart", "vrijdag 3 maart
 * 2027". `undefined` unless both dates are real dates in the supported years. `parseDateTime` with `now` on `today` reads every
 * result back to the date.
 */
export const speakDate: (date: LocalDate, language: Language, today: LocalDate) => string | undefined = guarded((date: LocalDate, language: Language, today: LocalDate): string | undefined => {
  if (!isDate(date) || !isDate(today) || !isLanguage(language)) return undefined
  const diff = dayDiff(today, date)
  const en = language === "en"
  const weekday = weekdayNames[language][isoWeekday(date) - 1]!
  if (diff === 0) return en ? "today" : "vandaag"
  if (diff === 1) return en ? "tomorrow" : "morgen"
  if (diff === -1) return en ? "yesterday" : "gisteren"
  if (diff === 2 && !en) return "overmorgen"
  if (diff === -2 && !en) return "eergisteren"
  if (diff >= 2 && diff <= 6) return weekday
  const day = ordinalToWords(date.day, language)!
  const month = monthNames[language][date.month - 1]!
  if (diff > 0 && date.year === today.year && date.month === today.month) return en ? `${weekday} the ${day}` : `${weekday} de ${day}`
  const year = diff > 0 && date.year === today.year ? "" : ` ${date.year}`
  return en ? `${weekday} the ${day} of ${month}${year}` : `${weekday} ${date.day} ${month}${year}`
}, undefined)

/** A moment: "tomorrow at half past seven", "morgen om half acht". `undefined` when the date or the time cannot be said. Not promised to read back. */
export const speakMoment: (value: { readonly date: LocalDate; readonly time?: ClockTime }, language: Language, today: LocalDate, options?: SpeakTimeOptions) => string | undefined = guarded((value: { readonly date: LocalDate; readonly time?: ClockTime }, language: Language, today: LocalDate, options?: SpeakTimeOptions): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const day = speakDate(value.date, language, today)
  if (day === undefined) return undefined
  if (value.time === undefined) return day
  const time = speakTime(value.time, language, options)
  return time === undefined ? undefined : `${day} ${language === "en" ? "at" : "om"} ${time}`
}, undefined)

/**
 * A short list: "a, b and c"; more than `max` (a whole number from 2, default 3): "a, b and two more" / "a, b en nog twee". One item
 * is that item. `undefined` unless the items are one to 100 strings of 1 to 200 characters (not only spaces).
 */
export const speakList: (items: ReadonlyArray<string>, language: Language, options?: { readonly max?: number }) => string | undefined = guarded((items: ReadonlyArray<string>, language: Language, options?: { readonly max?: number }): string | undefined => {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100 || !items.every((x) => typeof x === "string" && x.trim() !== "" && x.length <= maxTextLength) || !isLanguage(language) || !isOptions(options)) return undefined
  const given = options?.max
  if (given !== undefined && !(Number.isInteger(given) && given >= 2)) return undefined
  const max = given ?? 3
  const and = language === "en" ? "and" : "en"
  if (items.length === 1) return items[0]!
  if (items.length <= max) return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`
  const shown = items.slice(0, max - 1)
  const more = items.length - shown.length
  const count = more <= 20 ? words(more, language) : String(more)
  return `${shown.join(", ")} ${and} ${language === "en" ? count + " more" : "nog " + count}`
}, undefined)
