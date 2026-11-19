import type { Presentation } from "@pva/core"
import type { Language } from "@pva/module-contracts"

/**
 * The `weather` presentation of a day's forecast (docs/PRESENTING.md, the `weather` kind): what the answer said, and
 * nothing more. The kind has a place, a headline (a temperature, a condition, an icon) and up to five days with a high, a
 * low and an icon; it has no field for the chance of rain, the wind or the hours, so those stay in the spoken answer.
 */

/** The kind's bounds (`packages/protocol/src/presentation.ts`): the page refuses what passes them, so they are kept here. */
const PLACE_MAX = 40
const VALUE_MAX = 12
const CONDITION_MAX = 40
const LABEL_MAX = 12
const SPOKEN_MAX = 300

/** The icons of the closed set the page draws. */
type Icon = "sun" | "partly" | "cloud" | "rain" | "snow" | "storm" | "fog" | "wind" | "night"

/**
 * `text` as one line of at most `max` characters, cut at a code point boundary (an emoji or a surrogate pair is never
 * split): the one function every text of the card goes through.
 */
export const cutLine = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim()
  if (one.length <= max) return one
  let out = ""
  for (const ch of one) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out.trimEnd()
}

/**
 * The weather codes this module words (`conditionsEn`/`conditionsNl`, the same keys) as the closed set of icons, each exactly:
 * a code the module has no words for (52, 62, 7, 52.5) has no icon, so no card, whatever interval it lies in.
 */
const ICONS: ReadonlyMap<number, Icon> = new Map<number, Icon>([
  [0, "sun"], [1, "sun"], [2, "partly"], [3, "cloud"], [45, "fog"], [48, "fog"],
  ...[51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].map((c): [number, Icon] => [c, "rain"]),
  ...[71, 73, 75, 77, 85, 86].map((c): [number, Icon] => [c, "snow"]),
  ...[95, 96, 99].map((c): [number, Icon] => [c, "storm"])
])
export const iconOf = (code: number | null | undefined): Icon | undefined => (code === null || code === undefined ? undefined : ICONS.get(code))

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** A temperature as the card writes it: "12°", "54 °F". */
const degrees = (n: number, fahrenheit: boolean) => (fahrenheit ? `${n} °F` : `${n}°`)

/** The headline for a day: its range ("8 – 13°"); tighter when the longest values would pass the bound; none when still too long. */
const range = (min: number, max: number, fahrenheit: boolean): string | undefined => {
  const unit = fahrenheit ? " °F" : "°"
  for (const dash of [" – ", "–"]) {
    const text = `${min}${dash}${max}${unit}`
    if (text.length <= VALUE_MAX) return text
  }
  return undefined
}

/** What the card needs of a forecast of one day. */
export interface DayCardInput {
  readonly lang: Language
  readonly placeName: string
  /** The day asked for, as a date and its distance from today in days (0 today, 1 tomorrow). */
  readonly date: { readonly year: number; readonly month: number; readonly day: number }
  readonly daysFromToday: number
  readonly code: number | undefined
  /** The condition as the answer said it. */
  readonly condition: string
  readonly min: number
  readonly max: number
  readonly fahrenheit: boolean
  /** The complete answer as spoken (the hours and any note of what is only partly known included): what the model says where nothing is shown. */
  readonly spoken: string
}

/** The label of a day: "Today", "Tomorrow" or its weekday, in the household's language. */
const dayLabel = (input: DayCardInput): string => {
  const { lang, daysFromToday, date } = input
  if (daysFromToday === 0) return lang === "nl" ? "Vandaag" : "Today"
  if (daysFromToday === 1) return lang === "nl" ? "Morgen" : "Tomorrow"
  const noon = new Date(Date.UTC(date.year, date.month - 1, date.day, 12))
  return cap(new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", { weekday: "long", timeZone: "UTC" }).format(noon))
}

/**
 * The presentation of a day's forecast, or `undefined` when the day cannot be shown as the answer said it (a weather code
 * that has no icon, values too long for the card, a complete answer that does not fit the spoken bound): then the answer is
 * the same without a card. The place is the weather service's outside text, cut to one line at a code point boundary.
 */
export const forecastCard = (input: DayCardInput): Presentation | undefined => {
  const icon = iconOf(input.code)
  if (icon === undefined) return undefined
  const headline = range(input.min, input.max, input.fahrenheit)
  const high = degrees(input.max, input.fahrenheit)
  const low = degrees(input.min, input.fahrenheit)
  const condition = cutLine(cap(input.condition), CONDITION_MAX)
  const place = cutLine(input.placeName, PLACE_MAX)
  const label = cutLine(dayLabel(input), LABEL_MAX)
  if (headline === undefined || high.length > VALUE_MAX || low.length > VALUE_MAX || place === "" || condition === "" || label === "") return undefined
  // The fallback is the whole answer that was asked for, or there is no card: a card never costs the answer.
  const spoken = input.spoken
  if (spoken.length > SPOKEN_MAX || spoken.length === 0) return undefined
  return {
    kind: "weather",
    place,
    now: { temperature: headline, condition, icon },
    days: [{ label, high, low, icon }],
    spoken
  }
}
