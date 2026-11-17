import { dict, dicts } from "./Dict.ts"
import { largeScales, numbersWhole, readAmount, readNumber } from "./Numbers.ts"
import { notUnderstood, ok, type Language, type Parsed } from "./Result.ts"
import { onlyWords, tokenize, type Tok } from "./Tokens.ts"

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
  /** The words of the quantity as written, without the item ("about 2 kg" in "about 2 kg of flour"). */
  readonly said: string
  /** What came after it ("rice" in "a kilo of rice"), without "of" / "van", as written. */
  readonly item: string
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
    snufje: { unit: "pinch", dimension: "vague", approx: true }, snufjes: { unit: "pinch", dimension: "vague", approx: true },
    handjes: { unit: "handful", dimension: "vague", approx: true }, scheutjes: { unit: "splash", dimension: "vague", approx: true }, mespunten: { unit: "pinch", dimension: "vague", approx: true }, snuf: { unit: "pinch", dimension: "vague", approx: true }, mespunt: { unit: "pinch", dimension: "vague", approx: true },
    scheutje: { unit: "splash", dimension: "vague", approx: true }, scheut: { unit: "splash", dimension: "vague", approx: true }
  }
})

/**
 * The words that may stand before an amount: "about 2 kg", "ongeveer een kilo". Only these; a bound or a hedge that changes the
 * amount ("less than", "at least", "almost", "not", "bijna", "ruim", "minder dan") is not one, so the phrase is `not-understood`.
 */
const approxWords: Record<Language, ReadonlySet<string>> = {
  en: new Set(["about", "around", "roughly", "approximately", "approx", "circa", "ca"]),
  nl: new Set(["ongeveer", "circa", "ca", "rond", "zon", "plusminus"])
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
const joinWords: Record<Language, ReadonlySet<string>> = { en: new Set(["and", "or", "plus", "to", "nor", "versus", "vs"]), nl: new Set(["en", "of", "plus", "tot", "noch"]) }
const orWords: Record<Language, ReadonlySet<string>> = { en: new Set(["or", "nor"]), nl: new Set(["of", "noch", "ofwel"]) }
const fractionWords: ReadonlySet<string> = new Set(["half", "halve", "quarter", "quarters", "kwart", "anderhalf", "anderhalve", "driekwart", "third", "thirds", "derde"])
const articles: ReadonlySet<string> = new Set(["a", "an", "een"])

/** Exact to twelve significant digits (no float noise such as 0.30000000000000004), and never 0 for an amount that is not 0. */
export const tidy = (n: number): number => (n === 0 ? 0 : Number(n.toPrecision(12)))

const startsWith = (norms: ReadonlyArray<string>, i: number, phrase: ReadonlyArray<string>): boolean => phrase.every((p, k) => norms[i + k] === p)

const unitAt = (toks: ReadonlyArray<Tok>, k: number, language: Language): UnitInfo | undefined => {
  const w = toks[k]?.norm
  return w === undefined ? undefined : unitTable[language][w]
}

/**
 * The item may not hold a second amount: a number (digits or number words), a unit, a fraction, or after "and" / "or" / "en" / "of" /
 * "plus" an article or a word of "some" ("2 kg flour and a bag of sugar", "2 kg bloem of een zak suiker", "2 kg flour and some sugar").
 * Two quantities are the caller's to split (review round 2, findings 15 and 16).
 */
const itemHoldsAmount = (toks: ReadonlyArray<Tok>, from: number, language: Language): boolean => {
  const norms = toks.map((t) => t.norm)
  // An item that starts or ends with "and" / "or" ("2 kg and flour", "2 kg flour or") is not one thing either.
  if (from < toks.length && (joinWords[language].has(norms[from]!) || joinWords[language].has(norms[toks.length - 1]!))) return true
  // "salt or pepper", "flour or so", "zout of peper": alternatives are not one item (decision 1 of review round 2).
  if (norms.slice(from).some((w) => orWords[language].has(w))) return true
  for (let k = from; k < toks.length; k++) {
    const w = norms[k]!
    if (/\d/.test(w)) return true
    if (unitAt(toks, k, language) !== undefined || fractionWords.has(w) || largeScales.has(w)) return true
    if (!articles.has(w) && readNumber(toks, k, language) !== undefined) return true
    if (approxWords[language].has(w) && k > from) return true
    const joined = k > from && joinWords[language].has(norms[k - 1]!)
    if (joined && (articles.has(w) || someWords[language].some((p) => startsWith(norms, k, p)) || readAmount(toks, k, language, true) !== undefined)) return true
    if (articles.has(w) && (unitAt(toks, k + 1, language) !== undefined || fractionWords.has(norms[k + 1] ?? ""))) return true
  }
  return false
}

/**
 * A quantity of something, for lists and the kitchen: the phrase is `[about] amount [unit] [of] item` and nothing else — "a kilo of
 * rice", "about 250 grams", "twee liter melk", "een ons kaas", "een pak melk", "3x melk", "two apples", "a handful of nuts", "some
 * salt", "the rest of the rice". The item is everything after the amount and unit, as written (it may be empty after a unit). Only an
 * approximator ("about", "ongeveer") may stand before the amount: "less than 2 kg flour", "not 2 kg flour" and "buy 2 kg flour" are
 * `not-understood`. An item that holds another amount ("2 kg flour and 3 eggs", "2 kg flour or a bag of sugar") is `not-understood`:
 * the caller splits a list into its quantities first. Mass, volume, pieces and packs; `base` is in grams, millilitres or pieces.
 * Numbers as `readNumber` reads them (at most six decimals; nothing rounded to 0). Never throws.
 */
export const parseQuantity = (text: string, language: Language, options: QuantityOptions = {}): Parsed<Quantity> => {
  if (typeof text !== "string") return notUnderstood
  const toks = tokenize(text)
  const norms = toks.map((t) => t.norm)
  const cupMl = options.cupMl ?? metricCupMl
  if (!(cupMl > 0) || !Number.isFinite(cupMl)) return notUnderstood
  if (toks.length === 0 || !onlyWords(text, toks)) return notUnderstood
  let k = 0
  let approx = false
  if (k < toks.length && approxWords[language].has(norms[k]!)) { approx = true; k++ }
  const finish = (q: Omit<Quantity, "said" | "item" | "approx"> & { approx?: boolean }, next: number, needsItem = false): Parsed<Quantity> => {
    let n = next
    if (linkWords[language].has(norms[n] ?? "")) n++
    if (n === next + 1 && n >= toks.length) return notUnderstood // "a kilo of"
    if (needsItem && n >= toks.length) return notUnderstood
    if (itemHoldsAmount(toks, n, language)) return notUnderstood
    if (!numbersWhole(text, toks, [{ start: toks[0]!.start, end: toks[next - 1]!.end }])) return notUnderstood
    const item = n < toks.length ? text.slice(toks[n]!.start, toks[toks.length - 1]!.end) : ""
    const said = text.slice(toks[0]!.start, toks[next - 1]!.end)
    return ok({ ...q, approx: approx || q.approx === true, said, item }, text.slice(toks[0]!.start, toks[toks.length - 1]!.end))
  }
  // the rest
  const rest = restWords[language].find((p) => startsWith(norms, k, p))
  if (rest !== undefined) return approx ? notUnderstood : finish({ dimension: "none", rest: true }, k + rest.length)
  // some, a bit of, een paar
  const some = someWords[language].find((p) => startsWith(norms, k, p))
  if (some !== undefined) {
    if (approx) return notUnderstood
    return finish({ dimension: "none", rest: false, approx: true }, k + some.length, true)
  }
  // AMOUNT [x] [a] UNIT
  const amount = readAmount(toks, k, language, true)
  if (amount === undefined) return notUnderstood
  if (!Number.isFinite(amount.value) || !(amount.value > 0)) return notUnderstood
  let next = amount.next
  // "half a kilo", "een halve liter" (the article belongs to the amount)
  if (articles.has(norms[next] ?? "") && amount.value < 1 && unitAt(toks, next + 1, language) !== undefined) next++
  if (norms[next] === "x" && unitAt(toks, next + 1, language) === undefined) {
    // "3x melk": three pieces
    return finish({ dimension: "count", unit: "piece", amount: amount.value, rest: false, base: { amount: amount.value, unit: "piece" } }, next + 1, true)
  }
  const info = unitAt(toks, next, language)
  if (info === undefined) {
    // "two apples": a count of something; a lone "a" / "een" is no amount ("a banana" is not a quantity).
    if (amount.next === k + 1 && articles.has(norms[k]!)) return notUnderstood
    return finish({ dimension: "count", unit: "piece", amount: amount.value, rest: false, base: { amount: amount.value, unit: "piece" } }, next, true)
  }
  const value = tidy(amount.value * (info.per ?? 1))
  const unit = info.unit
  const factor = unit === "cup" ? cupMl : factors[unit]
  const baseUnit = info.dimension === "mass" ? "g" : info.dimension === "volume" ? "ml" : info.dimension === "count" ? "piece" : undefined
  const base = factor !== undefined && baseUnit !== undefined ? { amount: tidy(value * factor), unit: baseUnit } as const : undefined
  return finish({
    dimension: info.dimension, unit, amount: value, rest: false, ...(info.approx === true ? { approx: true } : {}), ...(base !== undefined ? { base } : {})
  }, next + 1)
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
  return tidy((amount * size(from)) / size(to))
}
