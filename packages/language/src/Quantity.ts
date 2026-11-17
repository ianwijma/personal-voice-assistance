import { dict, dicts } from "./Dict.ts"
import { numbersWhole, readAmount, readNumber } from "./Numbers.ts"
import { notUnderstood, ok, type Language, type Parsed } from "./Result.ts"
import { tokenize, type Tok } from "./Tokens.ts"

export type MassUnit = "g" | "kg" | "oz" | "lb"
export type VolumeUnit = "ml" | "cl" | "dl" | "l" | "tsp" | "tbsp" | "cup"
export type PackUnit = "pack" | "bag" | "bottle" | "can" | "jar" | "bunch" | "loaf" | "box" | "tub" | "roll"
export type UnitId = MassUnit | VolumeUnit | PackUnit | "piece" | "handful" | "pinch" | "splash"
export type Dimension = "mass" | "volume" | "count" | "pack" | "vague" | "none"

export interface Quantity {
  /** In `unit`, as said ("two kilos" is 2 kg). `undefined` for "some" and "the rest". "een ons" is 100 g. */
  readonly amount?: number
  readonly unit?: UnitId
  readonly dimension: Dimension
  /** "about", "ongeveer", "some", "a handful". */
  readonly approx: boolean
  /** "the rest". */
  readonly rest: boolean
  /** The same amount in grams, millilitres or pieces, when the unit has one. */
  readonly base?: { readonly amount: number; readonly unit: "g" | "ml" | "piece" }
  /** The words of the quantity as said. */
  readonly said: string
  /** What came after it ("rice" in "a kilo of rice"), without "of" / "van". */
  readonly item: string
  /** Where in the text the quantity was read, `[start, end)`. */
  readonly start: number
  readonly end: number
}

export interface QuantityOptions {
  /** Millilitres in a cup: 250 (metric, default) or 236.588 (US). */
  readonly cupMl?: number
}

export const metricCupMl = 250
export const usCupMl = 236.588

interface UnitInfo {
  readonly unit: UnitId
  readonly dimension: Dimension
  /** Multiplier into the base unit; for "cup" it is replaced by the cup size. */
  readonly factor?: number
  /** The amount said is this many of `unit` per word ("ons" is 100 g). */
  readonly per?: number
  readonly approx?: boolean
}

const mass = (unit: MassUnit, factor: number, per?: number): UnitInfo => ({ unit, dimension: "mass", factor, ...(per !== undefined ? { per } : {}) })
const volume = (unit: VolumeUnit, factor: number): UnitInfo => ({ unit, dimension: "volume", factor })
const pack = (unit: PackUnit): UnitInfo => ({ unit, dimension: "pack" })
const piece = (per = 1): UnitInfo => ({ unit: "piece", dimension: "count", factor: 1, ...(per !== 1 ? { per } : {}) })

/** Base-unit factors of every convertible unit. */
const factors = dict<number>({ g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237, ml: 1, cl: 10, dl: 100, l: 1000, tsp: 5, tbsp: 15, cup: metricCupMl, piece: 1 })

const unitTable = dicts<Language, UnitInfo>({
  en: {
    g: mass("g", 1), gr: mass("g", 1), gram: mass("g", 1), grams: mass("g", 1), gramme: mass("g", 1), grammes: mass("g", 1),
    kg: mass("kg", 1000), kilo: mass("kg", 1000), kilos: mass("kg", 1000), kilogram: mass("kg", 1000), kilograms: mass("kg", 1000),
    oz: mass("oz", 28.349523125), ounce: mass("oz", 28.349523125), ounces: mass("oz", 28.349523125),
    lb: mass("lb", 453.59237), lbs: mass("lb", 453.59237), pound: mass("lb", 453.59237), pounds: mass("lb", 453.59237),
    ml: volume("ml", 1), milliliter: volume("ml", 1), milliliters: volume("ml", 1), millilitre: volume("ml", 1), millilitres: volume("ml", 1),
    cl: volume("cl", 10), centiliter: volume("cl", 10), centiliters: volume("cl", 10), centilitre: volume("cl", 10), centilitres: volume("cl", 10),
    dl: volume("dl", 100), deciliter: volume("dl", 100), deciliters: volume("dl", 100), decilitre: volume("dl", 100), decilitres: volume("dl", 100),
    l: volume("l", 1000), liter: volume("l", 1000), liters: volume("l", 1000), litre: volume("l", 1000), litres: volume("l", 1000),
    tsp: volume("tsp", 5), teaspoon: volume("tsp", 5), teaspoons: volume("tsp", 5), tbsp: volume("tbsp", 15), tablespoon: volume("tbsp", 15), tablespoons: volume("tbsp", 15),
    cup: volume("cup", metricCupMl), cups: volume("cup", metricCupMl),
    piece: piece(), pieces: piece(), x: piece(), dozen: piece(12),
    pack: pack("pack"), packs: pack("pack"), packet: pack("pack"), packets: pack("pack"),
    bag: pack("bag"), bags: pack("bag"), bottle: pack("bottle"), bottles: pack("bottle"), can: pack("can"), cans: pack("can"), tin: pack("can"), tins: pack("can"),
    jar: pack("jar"), jars: pack("jar"), bunch: pack("bunch"), bunches: pack("bunch"), loaf: pack("loaf"), loaves: pack("loaf"),
    box: pack("box"), boxes: pack("box"), carton: pack("pack"), cartons: pack("pack"), tub: pack("tub"), tubs: pack("tub"), roll: pack("roll"), rolls: pack("roll"),
    handful: { unit: "handful", dimension: "vague", approx: true }, handfuls: { unit: "handful", dimension: "vague", approx: true },
    pinch: { unit: "pinch", dimension: "vague", approx: true }, pinches: { unit: "pinch", dimension: "vague", approx: true },
    splash: { unit: "splash", dimension: "vague", approx: true }, splashes: { unit: "splash", dimension: "vague", approx: true }
  },
  nl: {
    g: mass("g", 1), gr: mass("g", 1), gram: mass("g", 1), grammen: mass("g", 1),
    kg: mass("kg", 1000), kilo: mass("kg", 1000), kilos: mass("kg", 1000), kilogram: mass("kg", 1000),
    ons: mass("g", 1, 100), pond: mass("g", 1, 500), ponden: mass("g", 1, 500),
    oz: mass("oz", 28.349523125), lb: mass("lb", 453.59237),
    ml: volume("ml", 1), milliliter: volume("ml", 1), cl: volume("cl", 10), centiliter: volume("cl", 10), dl: volume("dl", 100), deciliter: volume("dl", 100),
    l: volume("l", 1000), liter: volume("l", 1000), liters: volume("l", 1000),
    tl: volume("tsp", 5), theelepel: volume("tsp", 5), theelepels: volume("tsp", 5), el: volume("tbsp", 15), eetlepel: volume("tbsp", 15), eetlepels: volume("tbsp", 15),
    kop: volume("cup", metricCupMl), kopje: volume("cup", metricCupMl), kopjes: volume("cup", metricCupMl), cup: volume("cup", metricCupMl), cups: volume("cup", metricCupMl),
    stuk: piece(), stuks: piece(), stukken: piece(), x: piece(), dozijn: piece(12),
    pak: pack("pack"), pakken: pack("pack"), pakje: pack("pack"), pakjes: pack("pack"),
    zak: pack("bag"), zakken: pack("bag"), zakje: pack("bag"), zakjes: pack("bag"), fles: pack("bottle"), flessen: pack("bottle"), flesje: pack("bottle"), flesjes: pack("bottle"),
    blik: pack("can"), blikken: pack("can"), blikje: pack("can"), blikjes: pack("can"), pot: pack("jar"), potten: pack("jar"), potje: pack("jar"), potjes: pack("jar"),
    bos: pack("bunch"), bossen: pack("bunch"), bosje: pack("bunch"), bosjes: pack("bunch"), brood: pack("loaf"), broden: pack("loaf"),
    doos: pack("box"), dozen: pack("box"), doosje: pack("box"), doosjes: pack("box"), bak: pack("tub"), bakken: pack("tub"), bakje: pack("tub"), bakjes: pack("tub"),
    rol: pack("roll"), rollen: pack("roll"),
    handvol: { unit: "handful", dimension: "vague", approx: true }, handje: { unit: "handful", dimension: "vague", approx: true },
    snufje: { unit: "pinch", dimension: "vague", approx: true }, snuf: { unit: "pinch", dimension: "vague", approx: true }, mespunt: { unit: "pinch", dimension: "vague", approx: true },
    scheutje: { unit: "splash", dimension: "vague", approx: true }, scheut: { unit: "splash", dimension: "vague", approx: true }
  }
})

const approxWords: Record<Language, ReadonlySet<string>> = {
  en: new Set(["about", "around", "roughly", "approximately", "approx", "circa", "ca", "like", "maybe", "nearly", "almost"]),
  nl: new Set(["ongeveer", "ongeveer", "circa", "ca", "rond", "zon", "ruim", "bijna", "plusminus"])
}
const someWords: Record<Language, ReadonlyArray<ReadonlyArray<string>>> = {
  en: [["some"], ["a", "bit"], ["a", "little"], ["a", "few"], ["a", "couple"], ["several"], ["a", "lot"], ["lots"]],
  nl: [["wat"], ["een", "beetje"], ["een", "paar"], ["een", "aantal"], ["enkele"], ["veel"], ["een", "stukje"]]
}
const restWords: Record<Language, ReadonlyArray<ReadonlyArray<string>>> = {
  en: [["the", "rest"], ["the", "remaining"], ["the", "remainder"], ["the", "leftovers"], ["the", "leftover"], ["what", "is", "left"], ["whatever", "is", "left"], ["what", "s", "left"]],
  nl: [["de", "rest"], ["de", "overige"], ["wat", "er", "over", "is"], ["de", "restjes"], ["het", "restant"]]
}
const linkWords: Record<Language, ReadonlySet<string>> = { en: new Set(["of"]), nl: new Set(["van", "aan"]) }
const joinWords: ReadonlySet<string> = new Set(["and", "or", "en", "of", "plus", "to", "tot"])

const round = (n: number): number => Math.round(n * 1e6) / 1e6

const startsWith = (norms: ReadonlyArray<string>, i: number, phrase: ReadonlyArray<string>): boolean => phrase.every((p, k) => norms[i + k] === p)

const unitAt = (toks: ReadonlyArray<Tok>, k: number, language: Language): UnitInfo | undefined => {
  const w = toks[k]?.norm
  return w === undefined ? undefined : unitTable[language][w]
}

/**
 * A quantity with a unit, for lists and the kitchen: "a kilo of rice", "about 250 grams", "twee liter melk", "een ons", "een pak",
 * "a handful", "some", "the rest". Read from the first place the text has one; `item` is what follows. Mass, volume, pieces and packs;
 * `base` is in grams, millilitres or pieces. Never throws.
 */
export const parseQuantity = (text: string, language: Language, options: QuantityOptions = {}): Parsed<Quantity> => {
  const toks = tokenize(text)
  const norms = toks.map((t) => t.norm)
  const cupMl = options.cupMl ?? metricCupMl
  if (!(cupMl > 0) || !Number.isFinite(cupMl)) return notUnderstood
  for (let i = 0; i < toks.length; i++) {
    let k = i
    let approx = false
    while (k < toks.length && approxWords[language].has(norms[k]!)) { approx = true; k++ }
    const finish = (q: Omit<Quantity, "said" | "item" | "start" | "end" | "approx"> & { approx?: boolean }, next: number): Parsed<Quantity> => {
      // "2 kg 500 g flour", "2 kg, 3 kg": a second amount right after the first is not an item.
      if (next < toks.length && (/^\d/.test(norms[next]!) || readNumber(toks, next, language) !== undefined || unitAt(toks, next, language) !== undefined)) return notUnderstood
      // "2 kg flour and 3 eggs", "2 or 3 apples", "two cups and a half": a second amount is a second item or an alternative.
      for (let j = next; j < toks.length; j++) {
        if (!joinWords.has(norms[j]!)) continue
        const after = norms[j + 1]
        if (after !== undefined && (/^\d/.test(after) || readAmount(toks, j + 1, language, false) !== undefined || (["a", "an", "een"].includes(after) && readAmount(toks, j + 1, language, true)?.next !== j + 2))) return notUnderstood
      }
      let n = next
      if (linkWords[language].has(norms[n] ?? "")) n++
      const item = n < toks.length ? text.slice(toks[n]!.start).replace(/[\s.,;!?]+$/u, "") : ""
      const start = toks[i]!.start
      const end = toks[next - 1]!.end
      return ok({ ...q, approx: approx || q.approx === true, said: text.slice(start, end), item, start, end }, text.slice(start, end))
    }
    // the rest
    const rest = restWords[language].find((p) => startsWith(norms, k, p))
    if (rest !== undefined) return finish({ dimension: "none", rest: true }, k + rest.length)
    // some, a bit, een paar
    const some = someWords[language].find((p) => startsWith(norms, k, p))
    if (some !== undefined) {
      // "a bit of salt" and "some salt" are quantities; "wat" in Dutch only when something follows.
      if (k + some.length < toks.length || some.length > 1 || language === "en") return finish({ dimension: "none", rest: false, approx: true }, k + some.length)
    }
    // AMOUNT [x] UNIT
    const amount = readAmount(toks, k, language, true)
    if (amount === undefined) continue
    // The amount must be the whole numeric expression: ".5 kg", "-2 kg", "1/2 kg", "five five apples" are not read as 5, 2, 1 or 5.
    if (!numbersWhole(text, toks, [{ start: toks[k]!.start, end: toks[amount.next - 1]!.end }])) return notUnderstood
    if (!Number.isFinite(amount.value) || amount.value < 0) return notUnderstood
    let next = amount.next
    const lone = (language === "en" && (norms[k] === "a" || norms[k] === "an") && next === k + 1) || (language === "nl" && norms[k] === "een" && next === k + 1)
    if ((norms[next] === "a" || norms[next] === "an" || norms[next] === "een") && amount.value < 1 && unitAt(toks, next + 1, language) !== undefined) next++
    if (norms[next] === "x") {
      if (unitAt(toks, next + 1, language) === undefined) {
        // "3x melk": three pieces
        return finish({ dimension: "count", unit: "piece", amount: amount.value, rest: false, base: { amount: amount.value, unit: "piece" } }, next + 1)
      }
    }
    const info = unitAt(toks, next, language)
    if (info === undefined) {
      if (lone || amount.value === 0) continue
      // "two apples": a count of something
      if (next < toks.length) {
        return finish({ dimension: "count", unit: "piece", amount: amount.value, rest: false, base: { amount: amount.value, unit: "piece" } }, next)
      }
      continue
    }
    const per = info.per ?? 1
    const value = round(amount.value * per)
    const unit = info.unit
    const factor = unit === "cup" ? cupMl : factors[unit]
    const baseUnit = info.dimension === "mass" ? "g" : info.dimension === "volume" ? "ml" : info.dimension === "count" ? "piece" : undefined
    const base = factor !== undefined && baseUnit !== undefined ? { amount: round(value * factor), unit: baseUnit } as const : undefined
    return finish({
      dimension: info.dimension, unit, amount: value, rest: false, ...(info.approx === true ? { approx: true } : {}), ...(base !== undefined ? { base } : {})
    }, next + 1)
  }
  return notUnderstood
}

const dimensionOf = (unit: UnitId): Dimension => {
  if (unit === "g" || unit === "kg" || unit === "oz" || unit === "lb") return "mass"
  if (unit === "ml" || unit === "cl" || unit === "dl" || unit === "l" || unit === "tsp" || unit === "tbsp" || unit === "cup") return "volume"
  return unit === "piece" ? "count" : "none"
}

/**
 * Convert between units of the same kind: mass (g, kg, oz, lb) or volume (ml, cl, dl, l, tsp, tbsp, cup). `undefined` when the kinds
 * differ or a unit has no fixed size (packs, a handful). A teaspoon is 5 ml, a tablespoon 15 ml, a cup `cupMl` (default 250).
 */
export const convertAmount = (amount: number, from: UnitId, to: UnitId, options: QuantityOptions = {}): number | undefined => {
  const kind = dimensionOf(from)
  if (kind === "none" || kind === "count" || dimensionOf(to) !== kind || !Number.isFinite(amount)) return undefined
  if (options.cupMl !== undefined && !(Number.isFinite(options.cupMl) && options.cupMl > 0)) return undefined
  const size = (u: UnitId) => (u === "cup" ? options.cupMl ?? metricCupMl : factors[u]!)
  return round((amount * size(from)) / size(to))
}
