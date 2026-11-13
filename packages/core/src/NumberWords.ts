/**
 * The number and unit words of English and Dutch, shared by the value parser
 * (`ValueParsing.ts`) and the utterance normaliser (`Utterance.ts`), so both
 * agree on which words belong to a number. Pure tables.
 */
export const units: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
}
export const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
export const nlUnits: Record<string, number> = {
  nul: 0, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9, tien: 10,
  elf: 11, twaalf: 12, dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19
}
export const nlTens: Record<string, number> = { twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90 }
export const nlCompound = new RegExp(`^(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(${Object.keys(nlTens).join("|")})$`)
export const nlUnitValue: Record<string, number> = { een: 1, ...nlUnits }

export const unitWords = new Set(["percent", "procent", "pct", "degrees", "degree", "graden", "graad"])

export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const durationUnits: Record<string, number> = {
  second: SECOND, seconds: SECOND, sec: SECOND, secs: SECOND, seconde: SECOND, seconden: SECOND,
  minute: MINUTE, minutes: MINUTE, min: MINUTE, mins: MINUTE, minuut: MINUTE, minuten: MINUTE,
  hour: HOUR, hours: HOUR, hr: HOUR, hrs: HOUR, uur: HOUR, uren: HOUR
}


export const hundredWords = new Set(["hundred", "honderd"])
export const scaleWords: Record<string, number> = { thousand: 1e3, duizend: 1e3, million: 1e6, miljoen: 1e6, billion: 1e9, miljard: 1e9 }

/** A Dutch number below 100 written as one word: "vijf", "veertig", "eenentwintig" ("een" included: inside a word it is never the article). */
export const nlBelow100 = (w: string): number | undefined => {
  if (w in nlUnitValue) return nlUnitValue[w]
  if (w in nlTens) return nlTens[w]
  const m = nlCompound.exec(w)
  return m === null ? undefined : nlUnitValue[m[1]!]! + nlTens[m[2]!]!
}

/**
 * A Dutch number written as one word, any size: "honderdveertig", "tweehonderd",
 * "negentienhonderd", "tweeduizenddriehonderdvijftig", "tweeënhalf" (2.5).
 */
export const nlWhole = (w: string): number | undefined => {
  const below = nlBelow100(w)
  if (below !== undefined) return below
  const half = /^(.+)enhalf$/.exec(w)
  if (half !== null) {
    const n = nlWhole(half[1]!)
    return n === undefined || !Number.isInteger(n) ? undefined : n + 0.5
  }
  for (const [word, scale] of [["miljard", 1e9], ["miljoen", 1e6], ["duizend", 1e3], ["honderd", 100]] as const) {
    const at = w.indexOf(word)
    if (at < 0) continue
    const left = w.slice(0, at)
    const right = w.slice(at + word.length)
    const l = left === "" ? 1 : nlWhole(left)
    const r = right === "" ? 0 : nlWhole(right)
    if (l === undefined || r === undefined || !Number.isInteger(l) || !Number.isInteger(r)) return undefined
    if (l < 1 || l >= (scale === 100 ? 100 : 1000) || r >= scale) return undefined
    return l * scale + r
  }
  return undefined
}

export const signWords: ReadonlySet<string> = new Set(["minus", "negative", "negatief"])
export const fractionWords: ReadonlySet<string> = new Set(["half", "halve", "quarter", "kwart", "anderhalf", "anderhalve"])

/**
 * A word that can be part of a numeric expression: digits, a number, fraction,
 * sign or unit word. Used where the normaliser must know whether punctuation
 * sits next to a number ("forty, five" keeps its comma; "lights, please" loses it).
 */
export const isNumericWord = (n: string): boolean =>
  /^\d+$/.test(n) || n in units || n in tens || hundredWords.has(n) || n in scaleWords || fractionWords.has(n) ||
  unitWords.has(n) || n in durationUnits || signWords.has(n) || n === "kwartier" || nlWhole(n) !== undefined ||
  /^(een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien)enhalf$/.test(n)
