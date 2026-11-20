import { dict } from "./Dict.ts"
import { alt, from, map, seq, tok, type P } from "./Grammar.ts"
import type { Language } from "./Result.ts"

/** 1 = Monday … 7 = Sunday, as the words are written. */
export const weekdayNames: Record<Language, ReadonlyArray<string>> = {
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  nl: ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]
}
export const monthNames: Record<Language, ReadonlyArray<string>> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  nl: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"]
}

const enOrdinalWords = dict<number>({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30
})
const enOrdinalUnits = dict<number>({ first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9 })
const nlOrdinalWords = dict<number>({
  eerste: 1, tweede: 2, derde: 3, vierde: 4, vijfde: 5, zesde: 6, zevende: 7, achtste: 8, negende: 9, tiende: 10, elfde: 11, twaalfde: 12,
  dertiende: 13, veertiende: 14, vijftiende: 15, zestiende: 16, zeventiende: 17, achttiende: 18, negentiende: 19, twintigste: 20, dertigste: 30
})
const nlUnitStem = ["een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen"]

/** The suffix a day number takes in digits: "1st", "2nd", "3rd", "11th"; Dutch "1e" (also "1ste", "1de"). */
const enSuffix = (n: number): string => (n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th")

/**
 * An ordinal 1–31 at one or two words: "third", "twenty first", "3rd" (the right suffix only: "3th" is not one), "derde",
 * "eenentwintigste", "3e", "3de", "3ste".
 */
export const ordinal = (language: Language, min: number, max: number): P<number> => {
  const digits = tok((w, t) => {
    if (t.kind !== "digits") return undefined
    const m = /^([1-9][0-9]?)([a-z]+)$/.exec(w)
    if (m === null) return undefined
    const n = Number(m[1])
    const ok = language === "en" ? m[2] === enSuffix(n) : m[2] === "e" || m[2] === "de" || m[2] === "ste"
    return ok ? n : undefined
  })
  const spelled: P<number> = language === "en"
    ? alt(from(enOrdinalWords), map(seq(from(dict<number>({ twenty: 20, thirty: 30 })), from(enOrdinalUnits)), ([t, u]) => t + u))
    : alt(from(nlOrdinalWords), tok((w) => {
      const m = /^(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(twintigste|dertigste)$/.exec(w)
      return m === null ? undefined : nlUnitStem.indexOf(m[1]!) + 1 + (m[2] === "twintigste" ? 20 : 30)
    }))
  return map(alt(digits, spelled), (n) => (n >= min && n <= max ? n : undefined))
}

const enSmall = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
const enTensWords = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
const nlSmall = ["nul", "een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen", "tien", "elf", "twaalf", "dertien", "veertien", "vijftien", "zestien", "zeventien", "achttien", "negentien"]
const nlTensWords = ["", "", "twintig", "dertig", "veertig", "vijftig", "zestig", "zeventig", "tachtig", "negentig"]

const enBelow1000 = (n: number): string => {
  const h = Math.floor(n / 100)
  const r = n % 100
  const rest = r < 20 ? (r === 0 ? "" : enSmall[r]!) : enTensWords[Math.floor(r / 10)]! + (r % 10 === 0 ? "" : " " + enSmall[r % 10]!)
  if (h === 0) return rest
  return enSmall[h]! + " hundred" + (rest === "" ? "" : " and " + rest)
}
const nlBelow100 = (r: number): string => {
  if (r < 20) return nlSmall[r]!
  const u = r % 10
  if (u === 0) return nlTensWords[r / 10]!
  const unit = nlSmall[u]!
  return unit + (unit.endsWith("e") ? "ën" : "en") + nlTensWords[Math.floor(r / 10)]!
}
const nlBelow1000 = (n: number): string => {
  const h = Math.floor(n / 100)
  const r = n % 100
  return (h === 0 ? "" : h === 1 ? "honderd" : nlSmall[h]! + "honderd") + (r === 0 ? "" : nlBelow100(r))
}

/**
 * A whole number in words, 0 to 999 999: 42 → "forty two" / "tweeënveertig", 2300 → "two thousand three hundred" / "tweeduizend
 * driehonderd". `undefined` for anything else (cannot say it in words). `parseNumber` reads every result back to the number.
 */
export const numberToWords = (n: number, language: Language): string | undefined => {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 999_999 || (language !== "en" && language !== "nl")) return undefined
  if (n === 0) return language === "en" ? "zero" : "nul"
  if (language === "en") {
    if (n < 1000) return enBelow1000(n)
    const th = Math.floor(n / 1000)
    const r = n % 1000
    return `${enBelow1000(th)} thousand` + (r === 0 ? "" : r < 100 ? ` and ${enBelow1000(r)}` : ` ${enBelow1000(r)}`)
  }
  if (n < 1000) return nlBelow1000(n)
  const th = Math.floor(n / 1000)
  const r = n % 1000
  return (th === 1 ? "duizend" : nlBelow1000(th) + "duizend") + (r === 0 ? "" : " " + nlBelow1000(r))
}

const enOrdinalOut = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"]
const nlOrdinalOut = ["", "eerste", "tweede", "derde", "vierde", "vijfde", "zesde", "zevende", "achtste", "negende", "tiende", "elfde", "twaalfde", "dertiende", "veertiende", "vijftiende", "zestiende", "zeventiende", "achttiende", "negentiende", "twintigste"]

/** 1–31 as a spoken ordinal: "third", "twenty first", "derde", "eenentwintigste"; `undefined` for anything else. */
export const ordinalToWords = (n: number, language: Language): string | undefined => {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 31 || (language !== "en" && language !== "nl")) return undefined
  if (language === "en") {
    if (n <= 20) return enOrdinalOut[n]!
    if (n === 30) return "thirtieth"
    return (n < 30 ? "twenty" : "thirty") + " " + enOrdinalOut[n % 10]!
  }
  if (n <= 20) return nlOrdinalOut[n]!
  if (n === 30) return "dertigste"
  const unit = nlSmall[n % 10]!
  return unit + (unit.endsWith("e") ? "ën" : "en") + (n < 30 ? "twintigste" : "dertigste")
}
