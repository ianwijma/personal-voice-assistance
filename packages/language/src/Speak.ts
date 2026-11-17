import { dicts } from "./Dict.ts"
import type { ClockTime, Language, LocalDate } from "./Result.ts"
import type { PackUnit, UnitId } from "./Quantity.ts"
import { monthNames, numberToWords, ordinalToWords, weekdayNames } from "./Words.ts"
import { dayDiff, isoWeekday } from "./Zoned.ts"

/**
 * The numbers `speakNumber` says: 0, and every number whose size is from `minSpoken` to below `maxSpoken`. Others are said as ""
 * (nothing to say), never as a different number.
 */
export const minSpoken = 1e-90
export const maxSpoken = 1e21

/**
 * The decimals a number is said with: two, or as many as its first two significant digits need when it is below 1 (0.001 is
 * "0.001", 0.000123 is "0.00012", 1e-11 is "0.00000000001"). A nonzero number is never said as 0 (review round 1, finding 22;
 * round 2, finding 21).
 */
const decimalsFor = (v: number): number => {
  if (v === 0 || v >= 1) return 2
  return Math.max(2, 1 - Math.floor(Math.log10(v)))
}
/** `v` (not negative) as digits with at most `decimals` decimals, trailing zeros dropped: "2.5", "0.001", "12". */
const digitsOf = (v: number, decimals: number): { whole: string; fraction: string } => {
  const fixed = v.toFixed(decimals)
  const [whole, fraction = ""] = fixed.split(".")
  return { whole: whole!, fraction: fraction.replace(/0+$/, "") }
}

/**
 * A number for the speech synthesiser. Digits by default, with the language's decimal mark ("2.5", "2,5"; two decimals, more for a
 * number below 1 so that it keeps two significant digits; no thousands separator). `words`: "forty two" / "tweeënveertig", decimals
 * digit by digit ("two point five", "twee komma vijf"). Not finite: "" (nothing to say).
 */
export const speakNumber = (n: number, language: Language, options: { readonly words?: boolean } = {}): string => {
  if (!Number.isFinite(n)) return ""
  const abs = Math.abs(n)
  if (abs !== 0 && (abs < minSpoken || abs >= maxSpoken)) return ""
  const { whole, fraction } = digitsOf(abs, decimalsFor(abs))
  const sign = n < 0 && (whole !== "0" || fraction !== "") ? (language === "en" ? "minus " : "min ") : ""
  if (options.words !== true) return `${sign}${whole}${fraction === "" ? "" : (language === "en" ? "." : ",") + fraction}`
  const w = numberToWords(Number(whole), language)
  if (fraction === "") return sign + w
  const digits = fraction.split("").map((d) => numberToWords(Number(d), language)).join(" ")
  return `${sign}${w} ${language === "en" ? "point" : "komma"} ${digits}`
}

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
  nl: {
    g: n("gram"), kg: n("kilo"), oz: n("ounce", "ounces"), lb: n("pond"),
    ml: n("milliliter"), cl: n("centiliter"), dl: n("deciliter"), l: n("liter"),
    tsp: n("theelepel", "theelepels"), tbsp: n("eetlepel", "eetlepels"), cup: n("kopje", "kopjes"),
    pack: n("pak", "pakken"), bag: n("zak", "zakken"), bottle: n("fles", "flessen"), can: n("blik", "blikken"), jar: n("pot", "potten"), bunch: n("bos", "bossen"),
    loaf: n("brood", "broden"), box: n("doos", "dozen"), tub: n("bak", "bakken"), roll: n("rol", "rollen"),
    piece: n("stuk", "stuks"), handful: n("handvol"), pinch: n("snufje", "snufjes"), splash: n("scheutje", "scheutjes")
  }
})
const packUnits: ReadonlySet<UnitId> = new Set<PackUnit>(["pack", "bag", "bottle", "can", "jar", "bunch", "loaf", "box", "tub", "roll"])

export interface AmountLike {
  readonly amount?: number | undefined
  readonly unit?: UnitId | undefined
  readonly approx?: boolean | undefined
  readonly rest?: boolean | undefined
}
export interface SpeakAmountOptions {
  /** What it is an amount of: "rice" → "about 750 grams of rice" / "ongeveer 750 gram rijst". */
  readonly item?: string
  /** 1500 g is "1.5 kilograms", 1500 ml is "1.5 litres". Default true. */
  readonly humanize?: boolean
}

const a = (language: Language, word: string): string => (language === "nl" ? "een" : /^[aeiou]/.test(word) ? "an" : "a")

/**
 * An amount with its unit, as it is said: "about 750 grams", "2 kilos of rice", "a pack of milk", "some", "the rest".
 * Dutch units stay singular after a number ("2 liter", "750 gram").
 */
export const speakAmount = (q: AmountLike, language: Language, options: SpeakAmountOptions = {}): string => {
  const item = options.item !== undefined && options.item.trim() !== "" ? options.item.trim() : undefined
  const of = (text: string, link = language === "en") => (item === undefined ? text : link ? `${text} of ${item}` : `${text} ${item}`)
  if (q.rest === true) return language === "en" ? (item === undefined ? "the rest" : `the rest of ${item}`) : (item === undefined ? "de rest" : `de rest van ${item}`)
  let amount = q.amount
  let unit = q.unit
  if (amount === undefined || unit === undefined) {
    if (amount !== undefined) return `${q.approx === true ? (language === "en" ? "about " : "ongeveer ") : ""}${speakNumber(amount, language)}${item === undefined ? "" : " " + item}`
    return language === "en" ? (item === undefined ? "some" : `some ${item}`) : (item === undefined ? "wat" : `wat ${item}`)
  }
  if (!Number.isFinite(amount)) return language === "en" ? (item === undefined ? "some" : `some ${item}`) : (item === undefined ? "wat" : `wat ${item}`)
  // 0.25 kg is "250 grams"; 1500 g is "1.5 kilograms" only when nothing is lost (1234 g stays "1234 grams").
  const exact = (x: number) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-9
  if (options.humanize !== false && Math.abs(amount) < 1 && amount !== 0 && unit === "kg") { amount = amount * 1000; unit = "g" }
  if (options.humanize !== false && Math.abs(amount) < 1 && amount !== 0 && unit === "l") { amount = amount * 1000; unit = "ml" }
  const names = unitNames[language][unit]
  if (names === undefined) return `${speakNumber(amount, language)} ${String(unit)}${item === undefined ? "" : " " + item}`
  // Singular or plural by what is said: "1 gram", "1.004" is said "1" too.
  const one = (x: number) => speakNumber(Math.abs(x), language) === "1"
  if (unit === "piece") {
    const count = `${q.approx === true ? (language === "en" ? "about " : "ongeveer ") : ""}${speakNumber(amount, language)}`
    return item !== undefined ? `${count} ${item}` : `${count} ${one(amount) ? names.one : names.many}`
  }
  if (options.humanize !== false && amount >= 1000 && unit === "g" && exact(amount / 1000)) { amount /= 1000; unit = "kg" }
  if (options.humanize !== false && amount >= 1000 && unit === "ml" && exact(amount / 1000)) { amount /= 1000; unit = "l" }
  return speakMeasured(amount, unit, unitNames[language][unit]!, q, language, of, one)
}

const speakMeasured = (
  amount: number, unit: UnitId, names: Names, q: AmountLike, language: Language, of: (text: string) => string, one: (x: number) => boolean
): string => {
  const approx = q.approx === true && unit !== "handful" && unit !== "pinch" && unit !== "splash" ? (language === "en" ? "about " : "ongeveer ") : ""
  if (unit === "handful" || unit === "pinch" || unit === "splash") {
    if (amount === 1) return of(`${a(language, names.one)} ${names.one}`)
    return of(`${approx}${speakNumber(amount, language)} ${one(amount) ? names.one : names.many}`)
  }
  if (amount === 1 && packUnits.has(unit)) return of(`${approx}${a(language, names.one)} ${names.one}`)
  const measure = unit === "g" || unit === "kg" || unit === "ml" || unit === "cl" || unit === "dl" || unit === "l" || unit === "lb"
  const noun = (language === "nl" && (measure || Math.abs(amount) < 1)) || one(amount) ? names.one : names.many
  return of(`${approx}${speakNumber(amount, language)} ${noun}`)
}

const timeWordsEn = (nn: number) => numberToWords(nn, "en")
const timeWordsNl = (nn: number) => numberToWords(nn, "nl")

export interface SpeakTimeOptions {
  /** "12h": "half past seven", "kwart over zeven". "24h": "nineteen thirty", "negentien uur dertig". Default "12h". */
  readonly style?: "12h" | "24h"
  /** 12h only: add "in the evening" / "'s avonds" so that am and pm are clear. Default false. */
  readonly period?: boolean
}

const dayPart = (hour: number): "morning" | "afternoon" | "evening" | "night" =>
  hour < 6 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : hour < 22 ? "evening" : "night"
const periodText: Record<Language, Record<"morning" | "afternoon" | "evening" | "night", string>> = {
  en: { morning: "in the morning", afternoon: "in the afternoon", evening: "in the evening", night: "at night" },
  nl: { morning: "'s ochtends", afternoon: "'s middags", evening: "'s avonds", night: "'s nachts" }
}

/** A clock time as it is said. */
export const speakTime = (t: ClockTime, language: Language, options: SpeakTimeOptions = {}): string => {
  const { hour, minute } = t
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return ""
  if ((options.style ?? "12h") === "24h") {
    if (language === "en") {
      if (hour === 0 && minute === 0) return "midnight"
      const h = hour === 0 ? "zero" : hour < 10 ? `oh ${timeWordsEn(hour)}` : timeWordsEn(hour)
      const m = minute === 0 ? "hundred" : minute < 10 ? `oh ${timeWordsEn(minute)}` : timeWordsEn(minute)
      return `${h} ${m}`
    }
    if (hour === 0 && minute === 0) return "middernacht"
    return `${timeWordsNl(hour)} uur${minute === 0 ? "" : " " + timeWordsNl(minute)}`
  }
  if (language === "nl" && hour === 0 && minute === 0) return "middernacht"
  const h12 = (x: number) => (x % 12 === 0 ? 12 : x % 12)
  const suffix = options.period === true && !(minute === 0 && (hour === 0 || hour === 12)) ? " " + periodText[language][dayPart(hour)] : ""
  if (language === "en") {
    const next = h12(hour + 1)
    const cur = h12(hour)
    if (minute === 0) return (hour === 12 ? "noon" : hour === 0 ? "midnight" : `${timeWordsEn(cur)} o'clock`) + suffix
    const table: Record<number, string> = { 5: `five past ${timeWordsEn(cur)}`, 10: `ten past ${timeWordsEn(cur)}`, 15: `quarter past ${timeWordsEn(cur)}`,
      20: `twenty past ${timeWordsEn(cur)}`, 25: `twenty five past ${timeWordsEn(cur)}`, 30: `half past ${timeWordsEn(cur)}`,
      35: `twenty five to ${timeWordsEn(next)}`, 40: `twenty to ${timeWordsEn(next)}`, 45: `quarter to ${timeWordsEn(next)}`, 50: `ten to ${timeWordsEn(next)}`, 55: `five to ${timeWordsEn(next)}` }
    const said = table[minute] ?? `${timeWordsEn(cur)} ${minute < 10 ? "oh " : ""}${timeWordsEn(minute)}`
    return said + suffix
  }
  const cur = timeWordsNl(h12(hour))
  const next = timeWordsNl(h12(hour + 1))
  const table: Record<number, string> = { 0: `${cur} uur`, 5: `vijf over ${cur}`, 10: `tien over ${cur}`, 15: `kwart over ${cur}`, 20: `tien voor half ${next}`, 25: `vijf voor half ${next}`,
    30: `half ${next}`, 35: `vijf over half ${next}`, 40: `tien over half ${next}`, 45: `kwart voor ${next}`, 50: `tien voor ${next}`, 55: `vijf voor ${next}` }
  return (table[minute] ?? `${cur} uur ${timeWordsNl(minute)}`) + suffix
}

const word = (count: number, language: Language, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/**
 * A duration in milliseconds as it is said, to the second: "6 minutes 10 seconds", "6 minuten 10 seconden". Round halves are said as
 * words: "half an hour" / "een half uur", "an hour and a half" / "anderhalf uur", "a quarter of an hour" / "een kwartier".
 */
export const speakDuration = (ms: number, language: Language, options: { readonly natural?: boolean } = {}): string => {
  if (!Number.isFinite(ms)) return ""
  const total = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const en = language === "en"
  if (options.natural !== false && days === 0) {
    if (total === 900) return en ? "a quarter of an hour" : "een kwartier"
    if (total === 1800) return en ? "half an hour" : "een half uur"
    if (total === 2700) return en ? "three quarters of an hour" : "drie kwartier"
    if (seconds === 0 && minutes === 30 && hours >= 1 && hours <= 12) {
      return en ? (hours === 1 ? "an hour and a half" : `${numberToWords(hours, "en")} and a half hours`) : (hours === 1 ? "anderhalf uur" : `${numberToWords(hours, "nl")} en een half uur`)
    }
    if (hours === 0 && seconds === 30 && minutes >= 1 && minutes <= 9) {
      return en ? (minutes === 1 ? "a minute and a half" : `${numberToWords(minutes, "en")} and a half minutes`) : (minutes === 1 ? "anderhalve minuut" : `${numberToWords(minutes, "nl")} en een halve minuut`)
    }
  }
  const parts: Array<string> = []
  if (days > 0) parts.push(word(days, language, en ? "day" : "dag", en ? "days" : "dagen"))
  if (hours > 0) parts.push(word(hours, language, en ? "hour" : "uur", en ? "hours" : "uur"))
  if (minutes > 0) parts.push(word(minutes, language, en ? "minute" : "minuut", en ? "minutes" : "minuten"))
  if (seconds > 0 || parts.length === 0) parts.push(word(seconds, language, en ? "second" : "seconde", en ? "seconds" : "seconden"))
  return parts.join(" ")
}

/**
 * A date relative to `today`: "today", "tomorrow", "Friday" (within the week), "Friday the third" (this month), "Friday the third of March"
 * (otherwise; with the year when it is not this year). Dutch: "vandaag", "morgen", "overmorgen", "vrijdag", "vrijdag de derde", "vrijdag 3 maart".
 */
export const speakDate = (date: LocalDate, language: Language, today: LocalDate): string => {
  const diff = dayDiff(today, date)
  const en = language === "en"
  const weekday = weekdayNames[language][isoWeekday(date) - 1]!
  if (diff === 0) return en ? "today" : "vandaag"
  if (diff === 1) return en ? "tomorrow" : "morgen"
  if (diff === 2 && !en) return "overmorgen"
  if (diff === -1) return en ? "yesterday" : "gisteren"
  if (diff >= 2 && diff <= 6) return weekday
  if (diff <= -2 && diff >= -6) return en ? `last ${weekday}` : `afgelopen ${weekday}`
  const sameMonth = date.year === today.year && date.month === today.month
  if (sameMonth) return en ? `${weekday} the ${ordinalToWords(date.day, "en")}` : `${weekday} de ${ordinalToWords(date.day, "nl")}`
  const month = monthNames[language][date.month - 1]!
  const year = date.year === today.year ? "" : ` ${date.year}`
  return en ? `${weekday} the ${ordinalToWords(date.day, "en")} of ${month}${year}` : `${weekday} ${date.day} ${month}${year}`
}

/** A moment: "tomorrow at half past seven", "morgen om half acht". */
export const speakMoment = (value: { readonly date: LocalDate; readonly time?: ClockTime }, language: Language, today: LocalDate, options: SpeakTimeOptions = {}): string => {
  const day = speakDate(value.date, language, today)
  if (value.time === undefined) return day
  return `${day} ${language === "en" ? "at" : "om"} ${speakTime(value.time, language, options)}`
}

/**
 * A short list: "a, b and c"; more than `max` (default 3): "a, b and two more" / "a, b en nog twee". One item is just that item.
 */
export const speakList = (items: ReadonlyArray<string>, language: Language, options: { readonly max?: number } = {}): string => {
  const max = Number.isInteger(options.max) ? Math.max(2, options.max!) : 3
  const and = language === "en" ? "and" : "en"
  if (items.length === 0) return ""
  if (items.length === 1) return items[0]!
  if (items.length <= max) return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`
  const shown = items.slice(0, max - 1)
  const more = items.length - shown.length
  const count = more <= 20 ? numberToWords(more, language) : String(more)
  return `${shown.join(", ")} ${and} ${language === "en" ? count + " more" : "nog " + count}`
}
