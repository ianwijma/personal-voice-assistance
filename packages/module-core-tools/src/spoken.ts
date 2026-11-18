// How the calculator says a result: the number (rounded for the ear), and its unit or currency, in English and Dutch.
import { speakNumber } from "@pva/language"
import type { Language } from "@pva/module-contracts"

const SCALES: Record<Language, ReadonlyArray<readonly [number, string]>> = {
  en: [[1e15, "quadrillion"], [1e12, "trillion"], [1e9, "billion"], [1e6, "million"]],
  nl: [[1e15, "biljard"], [1e12, "biljoen"], [1e9, "miljard"], [1e6, "miljoen"]]
}

const decimal = (digits: string, lang: Language): string => (lang === "nl" ? digits.replace(".", ",") : digits)
const three = (n: number): string => String(Number(n.toPrecision(3)))

/** A number as the ear wants it; `about` is true when what is said is not the exact value. */
export const spokenNumber = (n: number, lang: Language): { readonly text: string; readonly about: boolean } => {
  const abs = Math.abs(n)
  const sign = n < 0 ? (lang === "nl" ? "min " : "minus ") : ""
  if (abs >= 1e6) {
    if (abs >= 1e18) {
      const [mantissa, exponent] = abs.toExponential(2).split("e") as [string, string]
      const power = Number(exponent)
      const times = lang === "nl" ? "keer tien tot de macht" : "times ten to the power"
      return { text: `${sign}${decimal(String(Number(mantissa)), lang)} ${times} ${power}`, about: true }
    }
    const [size, name] = SCALES[lang].find(([s]) => abs >= s)!
    const scaled = abs / size
    const exact = Number.isInteger(n) && abs < 1e15 && Number(three(scaled)) * size === abs
    return { text: `${sign}${decimal(three(scaled), lang)} ${name}`, about: !exact }
  }
  if (abs !== 0 && abs < 0.005) {
    if (abs < 1e-3) {
      const [mantissa, exponent] = abs.toExponential(2).split("e") as [string, string]
      const times = lang === "nl" ? "keer tien tot de macht min" : "times ten to the power minus"
      return { text: `${sign}${decimal(String(Number(mantissa)), lang)} ${times} ${Math.abs(Number(exponent))}`, about: true }
    }
    return { text: `${sign}${decimal(three(abs), lang)}`, about: Number(three(abs)) !== abs }
  }
  const said = speakNumber(n, lang)
  if (said === undefined) return { text: String(n), about: true }
  return { text: said, about: Math.abs(Number(said.replace(",", ".").replace(/^(minus|min) /, "-")) - n) > 1e-9 }
}

interface Names {
  readonly one: string
  readonly many: string
}
const n = (one: string, many = one + "s"): Names => ({ one, many })

const UNITS: Record<Language, Readonly<Record<string, Names>>> = {
  en: {
    mm: n("millimetre"), cm: n("centimetre"), m: n("metre"), km: n("kilometre"), inch: n("inch", "inches"), ft: n("foot", "feet"), yd: n("yard"),
    mile: n("mile"), mg: n("milligram"), g: n("gram"), kg: n("kilogram"), lb: n("pound"), oz: n("ounce"), ml: n("millilitre"), cl: n("centilitre"),
    dl: n("decilitre"), L: n("litre"), l: n("litre"), cup: n("cup"), teaspoon: n("teaspoon"), tablespoon: n("tablespoon"), gal: n("gallon"),
    s: n("second"), minute: n("minute"), hour: n("hour"), day: n("day"), week: n("week"), degC: n("degree Celsius", "degrees Celsius"),
    degF: n("degree Fahrenheit", "degrees Fahrenheit"), K: n("kelvin", "kelvin"), "m / s": n("metre per second", "metres per second"),
    "km / h": n("kilometre per hour", "kilometres per hour"), "km / hour": n("kilometre per hour", "kilometres per hour"), "mile / hour": n("mile per hour", "miles per hour"), m2: n("square metre"), ha: n("hectare"),
    W: n("watt"), kW: n("kilowatt"), J: n("joule"), kJ: n("kilojoule"), cal: n("calorie"), kcal: n("kilocalorie"), byte: n("byte"), deg: n("degree"), rad: n("radian")
  },
  nl: {
    mm: n("millimeter", "millimeter"), cm: n("centimeter", "centimeter"), m: n("meter", "meter"), km: n("kilometer", "kilometer"), inch: n("inch", "inch"),
    ft: n("voet", "voet"), yd: n("yard", "yard"), mile: n("mijl", "mijl"), mg: n("milligram", "milligram"), g: n("gram", "gram"), kg: n("kilo", "kilo"),
    lb: n("pond", "pond"), oz: n("ons", "ons"), ml: n("milliliter", "milliliter"), cl: n("centiliter", "centiliter"), dl: n("deciliter", "deciliter"),
    L: n("liter", "liter"), l: n("liter", "liter"), cup: n("kopje", "kopjes"), teaspoon: n("theelepel", "theelepels"), tablespoon: n("eetlepel", "eetlepels"),
    gal: n("gallon", "gallon"), s: n("seconde", "seconden"), minute: n("minuut", "minuten"), hour: n("uur", "uur"), day: n("dag", "dagen"), week: n("week", "weken"),
    degC: n("graad Celsius", "graden Celsius"), degF: n("graad Fahrenheit", "graden Fahrenheit"), K: n("kelvin", "kelvin"),
    "m / s": n("meter per seconde", "meter per seconde"), "km / h": n("kilometer per uur", "kilometer per uur"), "km / hour": n("kilometer per uur", "kilometer per uur"), "mile / hour": n("mijl per uur", "mijl per uur"),
    m2: n("vierkante meter", "vierkante meter"), ha: n("hectare", "hectare"), W: n("watt", "watt"), kW: n("kilowatt", "kilowatt"), J: n("joule", "joule"),
    kJ: n("kilojoule", "kilojoule"), cal: n("calorie", "calorieën"), kcal: n("kilocalorie", "kilocalorieën"), byte: n("byte", "bytes"), deg: n("graad", "graden"),
    rad: n("radiaal", "radialen")
  }
}

const CURRENCIES: Record<Language, Readonly<Record<string, Names>>> = {
  en: {
    EUR: n("euro"), USD: n("US dollar"), GBP: n("pound"), JPY: n("yen", "yen"), CHF: n("Swiss franc"), CAD: n("Canadian dollar"), AUD: n("Australian dollar"),
    NZD: n("New Zealand dollar"), CNY: n("yuan", "yuan"), INR: n("Indian rupee"), SEK: n("Swedish krona", "Swedish kronor"), NOK: n("Norwegian krone", "Norwegian kroner"),
    DKK: n("Danish krone", "Danish kroner"), PLN: n("zloty", "zloty"), TRY: n("Turkish lira", "Turkish lira"), BRL: n("Brazilian real", "Brazilian reais"),
    MXN: n("Mexican peso"), ZAR: n("rand", "rand"), HKD: n("Hong Kong dollar"), SGD: n("Singapore dollar"), KRW: n("won", "won"), CZK: n("Czech koruna"), HUF: n("forint", "forint")
  },
  nl: {
    EUR: n("euro", "euro"), USD: n("Amerikaanse dollar", "Amerikaanse dollar"), GBP: n("Brits pond", "Britse pond"), JPY: n("yen", "yen"),
    CHF: n("Zwitserse frank", "Zwitserse frank"), CAD: n("Canadese dollar", "Canadese dollar"), AUD: n("Australische dollar", "Australische dollar"),
    NZD: n("Nieuw-Zeelandse dollar", "Nieuw-Zeelandse dollar"), CNY: n("yuan", "yuan"), INR: n("Indiase roepie", "Indiase roepie"), SEK: n("Zweedse kroon", "Zweedse kroon"),
    NOK: n("Noorse kroon", "Noorse kroon"), DKK: n("Deense kroon", "Deense kroon"), PLN: n("zloty", "zloty"), TRY: n("Turkse lira", "Turkse lira"),
    BRL: n("Braziliaanse real", "Braziliaanse real"), MXN: n("Mexicaanse peso", "Mexicaanse peso"), ZAR: n("rand", "rand"), HKD: n("Hongkongse dollar", "Hongkongse dollar"),
    SGD: n("Singaporese dollar", "Singaporese dollar"), KRW: n("won", "won"), CZK: n("Tsjechische kroon", "Tsjechische kroon"), HUF: n("forint", "forint")
  }
}

/** A currency code letter by letter for the voice when the module has no name for it ("U A H"). */
const letters = (code: string): string => code.split("").join(" ")

/** The unit after a number: "inches", "euros", or what mathjs calls it when there is no name here (a compound unit is read as it is). */
export const spokenUnit = (unit: string, amount: number, lang: Language): string => {
  const plural = Math.abs(amount) !== 1
  const singular = unit.endsWith("s") && unit.length > 3 ? unit.slice(0, -1) : unit
  const found = CURRENCIES[lang][unit] ?? UNITS[lang][unit] ?? UNITS[lang][singular]
  if (found !== undefined) return plural ? found.many : found.one
  if (/^[A-Z]{3}$/.test(unit)) return letters(unit)
  return unit.replace(/\s*\/\s*/g, " per ")
}
