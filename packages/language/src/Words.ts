import type { Language } from "./Result.ts"

/** 1 = Monday … 7 = Sunday, as the words are said. */
export const weekdayNames: Record<Language, ReadonlyArray<string>> = {
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  nl: ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]
}
export const monthNames: Record<Language, ReadonlyArray<string>> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  nl: ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"]
}

const weekdayWords: Record<Language, Record<string, number>> = {
  en: {
    monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5, saturday: 6, sunday: 7
  },
  nl: { maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6, zondag: 7 }
}
const monthWords: Record<Language, Record<string, number>> = {
  en: {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
    august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
  },
  nl: {
    januari: 1, jan: 1, februari: 2, feb: 2, maart: 3, mrt: 3, april: 4, apr: 4, mei: 5, juni: 6, jun: 6, juli: 7, jul: 7,
    augustus: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, november: 11, nov: 11, december: 12, dec: 12
  }
}
export const weekdayOf = (word: string, language: Language): number | undefined => weekdayWords[language][word]
export const monthOf = (word: string, language: Language): number | undefined => monthWords[language][word]

const enOrdinalWords: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30
}
const nlOrdinalWords: Record<string, number> = {
  eerste: 1, tweede: 2, derde: 3, vierde: 4, vijfde: 5, zesde: 6, zevende: 7, achtste: 8, negende: 9, tiende: 10, elfde: 11, twaalfde: 12,
  dertiende: 13, veertiende: 14, vijftiende: 15, zestiende: 16, zeventiende: 17, achttiende: 18, negentiende: 19, twintigste: 20, dertigste: 30
}
const enTensStem: Record<string, number> = { twenty: 20, thirty: 30 }
const nlUnitStem: Record<string, number> = { een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 }

export interface OrdinalRead {
  readonly value: number
  readonly next: number
}

/** An ordinal at word `i`: "third", "3rd", "3e", "twenty first", "eenentwintigste". Only 1–31. */
export const readOrdinal = (norms: ReadonlyArray<string>, i: number, language: Language): OrdinalRead | undefined => {
  const w = norms[i]
  if (w === undefined) return undefined
  const digits = language === "en" ? /^(\d{1,2})(st|nd|rd|th)$/.exec(w) : /^(\d{1,2})(e|de|ste)$/.exec(w)
  if (digits !== null) return { value: Number(digits[1]), next: i + 1 }
  if (/^\d+$/.test(w)) return undefined
  if (language === "en") {
    if (w in enOrdinalWords) return { value: enOrdinalWords[w]!, next: i + 1 }
    if (w in enTensStem) {
      const n = norms[i + 1]
      const u = n === undefined ? undefined : enOrdinalWords[n]
      if (u !== undefined && u >= 1 && u <= 9) return { value: enTensStem[w]! + u, next: i + 2 }
    }
    return undefined
  }
  if (w in nlOrdinalWords) return { value: nlOrdinalWords[w]!, next: i + 1 }
  const m = /^(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(twintigste|dertigste)$/.exec(w)
  if (m !== null) return { value: nlUnitStem[m[1]!]! + nlOrdinalWords[m[2]!]!, next: i + 1 }
  return undefined
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

/** A whole number in words, 0 to 999 999: 42 → "forty two" / "tweeënveertig". Anything else comes back as digits. */
export const numberToWords = (n: number, language: Language): string => {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return String(n)
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

/** 1–31 as a spoken ordinal: "third", "twenty first", "derde", "eenentwintigste". */
export const ordinalToWords = (n: number, language: Language): string => {
  if (!Number.isInteger(n) || n < 1 || n > 31) return String(n)
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
