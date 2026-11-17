import { dict, dicts } from "./Dict.ts"
import { guarded, isLanguage, isOptions, isText } from "./Domain.ts"
import { alt, from, many1, map, oneOf, opt, seq, tok, whole, words, type Input, type P } from "./Grammar.ts"
import { amountNumber, enFractionBeforeArticle, nlWholeWord, unsignedNumber } from "./Numbers.ts"
import { ambiguous, notUnderstood, ok, type Language, type Parsed } from "./Result.ts"
import { sliceText, tokenize } from "./Tokens.ts"

export type MassUnit = "g" | "kg" | "oz" | "lb"
export type VolumeUnit = "ml" | "cl" | "dl" | "l" | "tsp" | "tbsp" | "cup"
export type PackUnit = "pack" | "bag" | "bottle" | "can" | "jar" | "bunch" | "loaf" | "box" | "tub" | "roll"
export type UnitId = MassUnit | VolumeUnit | PackUnit | "piece" | "handful" | "pinch" | "splash"
export type Dimension = "mass" | "volume" | "count" | "pack" | "vague" | "none"

export interface Quantity {
  /** In `unit`, as said ("two kilos" is 2 kg; "een ons" is 100 g, "a dozen" 12 pieces). Absent for "some" and "the rest". */
  readonly amount?: number
  readonly unit?: UnitId
  readonly dimension: Dimension
  /** "about", "ongeveer", "some", "a handful". */
  readonly approx: boolean
  /** "the rest". */
  readonly rest: boolean
  /** The same amount in grams, millilitres or pieces, when the unit has one; 12 significant digits. */
  readonly base?: { readonly amount: number; readonly unit: "g" | "ml" | "piece" }
  /** The words of the quantity as written, without the item ("about 2 kg" in "about 2 kg of flour"). */
  readonly said: string
  /** What it is a quantity of: the text from its first word to its last as written ("rice" in "a kilo of rice"); "" for none. */
  readonly item: string
}

export interface QuantityOptions {
  /** Millilitres in a cup: 250 (metric, default) or 236.588 (US); any number from 50 to 1000. */
  readonly cupMl?: number
}

export const metricCupMl = 250
export const usCupMl = 236.588

interface UnitInfo {
  readonly unit: UnitId
  readonly dimension: Dimension
  /** The amount said is this many of `unit` per word ("ons" is 100 g, "dozen" 12 pieces). */
  readonly per?: number
  readonly approx?: boolean
}
const u = (unit: UnitId, dimension: Dimension, per?: number): UnitInfo => ({ unit, dimension, ...(per !== undefined ? { per } : {}) })
const mass = (unit: MassUnit, per?: number) => u(unit, "mass", per)
const volume = (unit: VolumeUnit) => u(unit, "volume")
const pack = (unit: PackUnit) => u(unit, "pack")
const vague = (unit: "handful" | "pinch" | "splash"): UnitInfo => ({ unit, dimension: "vague", approx: true })

/** Base-unit sizes: grams, millilitres, pieces. A cup is the `cupMl` option. */
const factors: Readonly<Record<string, number>> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237, ml: 1, cl: 10, dl: 100, l: 1000, tsp: 5, tbsp: 15, cup: metricCupMl, piece: 1 }

/** The unit words (README, "Quantities"). Dutch has no ounce or pound of 453.6 g: "pond" is 500 g. */
export const unitTable = dicts<Language, UnitInfo>({
  en: {
    g: mass("g"), gram: mass("g"), grams: mass("g"), kg: mass("kg"), kilo: mass("kg"), kilos: mass("kg"), kilogram: mass("kg"), kilograms: mass("kg"),
    oz: mass("oz"), ounce: mass("oz"), ounces: mass("oz"), lb: mass("lb"), lbs: mass("lb"), pound: mass("lb"), pounds: mass("lb"),
    ml: volume("ml"), millilitre: volume("ml"), millilitres: volume("ml"), cl: volume("cl"), centilitre: volume("cl"), centilitres: volume("cl"),
    dl: volume("dl"), decilitre: volume("dl"), decilitres: volume("dl"), l: volume("l"), litre: volume("l"), litres: volume("l"), liter: volume("l"), liters: volume("l"),
    tsp: volume("tsp"), teaspoon: volume("tsp"), teaspoons: volume("tsp"), tbsp: volume("tbsp"), tablespoon: volume("tbsp"), tablespoons: volume("tbsp"),
    cup: volume("cup"), cups: volume("cup"),
    piece: u("piece", "count"), pieces: u("piece", "count"), dozen: u("piece", "count", 12),
    pack: pack("pack"), packs: pack("pack"), packet: pack("pack"), packets: pack("pack"), bag: pack("bag"), bags: pack("bag"),
    bottle: pack("bottle"), bottles: pack("bottle"), can: pack("can"), cans: pack("can"), tin: pack("can"), tins: pack("can"),
    jar: pack("jar"), jars: pack("jar"), bunch: pack("bunch"), bunches: pack("bunch"), loaf: pack("loaf"), loaves: pack("loaf"),
    box: pack("box"), boxes: pack("box"), tub: pack("tub"), tubs: pack("tub"), roll: pack("roll"), rolls: pack("roll"),
    handful: vague("handful"), handfuls: vague("handful"), pinch: vague("pinch"), pinches: vague("pinch"), splash: vague("splash"), splashes: vague("splash")
  },
  nl: {
    g: mass("g"), gram: mass("g"), kg: mass("kg"), kilo: mass("kg"), kilos: mass("kg"), kilogram: mass("kg"), ons: mass("g", 100), pond: mass("g", 500),
    ml: volume("ml"), milliliter: volume("ml"), cl: volume("cl"), centiliter: volume("cl"), dl: volume("dl"), deciliter: volume("dl"), l: volume("l"), liter: volume("l"),
    tl: volume("tsp"), theelepel: volume("tsp"), theelepels: volume("tsp"), el: volume("tbsp"), eetlepel: volume("tbsp"), eetlepels: volume("tbsp"),
    kopje: volume("cup"), kopjes: volume("cup"),
    stuk: u("piece", "count"), stuks: u("piece", "count"), dozijn: u("piece", "count", 12),
    pak: pack("pack"), pakken: pack("pack"), pakje: pack("pack"), pakjes: pack("pack"), zak: pack("bag"), zakken: pack("bag"), zakje: pack("bag"), zakjes: pack("bag"),
    fles: pack("bottle"), flessen: pack("bottle"), blik: pack("can"), blikken: pack("can"), blikje: pack("can"), blikjes: pack("can"),
    pot: pack("jar"), potten: pack("jar"), potje: pack("jar"), potjes: pack("jar"), bos: pack("bunch"), bossen: pack("bunch"),
    brood: pack("loaf"), broden: pack("loaf"), doos: pack("box"), dozen: pack("box"), bak: pack("tub"), bakken: pack("tub"), bakje: pack("tub"), bakjes: pack("tub"),
    rol: pack("roll"), rollen: pack("roll"),
    handvol: vague("handful"), snufje: vague("pinch"), snufjes: vague("pinch"), scheutje: vague("splash"), scheutjes: vague("splash")
  }
})

const approxWords: Record<Language, ReadonlyArray<string>> = { en: ["about", "around", "roughly", "approximately"], nl: ["ongeveer", "circa", "zon"] }
const someWords: Record<Language, ReadonlyArray<ReadonlyArray<string>>> = {
  en: [["some"], ["a", "bit", "of"], ["a", "few"], ["a", "couple", "of"], ["a", "lot", "of"]],
  nl: [["wat"], ["een", "beetje"], ["een", "paar"], ["veel"]]
}

/**
 * The words an item may not hold (README, "Quantities"): every word of the quantity grammar (number words, fractions, units,
 * approximators, "some" words, "rest", articles, "of"), and conjunctions, negations and bounds, which would make it two items or a
 * changed amount. A digit is never an item word either. Review round 3, finding 9.
 */
export const reservedItemWords: Record<Language, ReadonlySet<string>> = {
  en: new Set([
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
    "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    "hundred", "thousand", "million", "billion", "point", "minus", "half", "quarter", "quarters", "third", "thirds", "dozen",
    "about", "around", "roughly", "approximately", "approx", "some", "bit", "few", "couple", "lot", "lots", "rest", "remaining", "several",
    "a", "an", "the", "of", "and", "or", "nor", "plus", "but", "not", "no", "without", "except", "less", "more", "than", "least", "most",
    "under", "over", "below", "above", "max", "maximum", "minimum", "almost", "nearly", "up", "to", "at", "per", "each", "every", "x"
  ]),
  nl: new Set([
    "nul", "half", "halve", "kwart", "driekwart", "anderhalf", "anderhalve", "derde", "miljoen", "miljard", "komma", "min", "dozijn",
    "ongeveer", "circa", "ca", "zon", "rond", "wat", "beetje", "paar", "veel", "enkele", "rest", "een", "de", "het", "van", "aan", "en", "of",
    "noch", "plus", "maar", "niet", "geen", "zonder", "behalve", "minder", "meer", "dan", "minstens", "hooguit", "maximaal", "minimaal",
    "bijna", "ruim", "boven", "onder", "over", "tot", "per", "elke", "elk", "ieder", "iedere", "x", "lb", "lbs", "oz"
  ])
}

/** A word that may be part of an item: letters, not reserved, not a unit, not a number or an amount word of the language. */
const itemWord = (language: Language): P<string> => tok((w, t) => {
  if (t.kind !== "word" || reservedItemWords[language].has(w) || Object.prototype.hasOwnProperty.call(unitTable[language], w)) return undefined
  if (language === "nl" && (nlWholeWord(w) !== undefined || (/^(.+)enhalf$/.test(w) && nlWholeWord(w.slice(0, -6)) !== undefined))) return undefined
  return w
})
/** The item: one or more item words; its value is the text from the first to the last, as written. */
const item = (language: Language): P<string> => (input, at) =>
  many1(itemWord(language), undefined, 40)(input, at).map((h) => ({ value: sliceText(input.text, input.toks, at, h.next), next: h.next }))

type Head = Omit<Quantity, "said" | "item" | "approx"> & { readonly approx: boolean; readonly needsItem: boolean }

/** 12 significant digits (no float noise such as 0.30000000000000004); a positive amount stays positive. */
export const tidy = (n: number): number => (n === 0 ? 0 : Number(n.toPrecision(12)))

const measured = (amount: number, info: UnitInfo, cupMl: number): Head | undefined => {
  const value = tidy(amount * (info.per ?? 1))
  if (!(value > 0) || !Number.isFinite(value)) return undefined
  const factor = info.unit === "cup" ? cupMl : factors[info.unit]
  const baseUnit = info.dimension === "mass" ? "g" : info.dimension === "volume" ? "ml" : info.dimension === "count" ? "piece" : undefined
  const base = factor !== undefined && baseUnit !== undefined ? { amount: tidy(value * factor), unit: baseUnit } as const : undefined
  return {
    dimension: info.dimension, unit: info.unit, amount: value, rest: false, approx: info.approx === true, needsItem: false,
    ...(base !== undefined ? { base } : {})
  }
}

/** The quantity before the item: an amount with or without a unit, "some", or "the rest". */
const head = (language: Language, cupMl: number): P<Head> => {
  const en = language === "en"
  const unit = from(unitTable[language])
  const article = en ? oneOf("a", "an") : oneOf("een")
  const count = (amount: number): Head => ({ dimension: "count", unit: "piece", amount, rest: false, approx: false, needsItem: true, base: { amount, unit: "piece" } })
  return alt(
    // AMOUNT UNIT: "2 kg", "two and a half litres", "tweeënhalf kilo", "een halve liter"
    map(seq(amountNumber[language], unit), ([a, info]) => (a > 0 ? measured(a, info, cupMl) : undefined)),
    // "a kilo", "an ounce", "een kilo", "a handful", "a dozen"
    map(seq(article, unit), ([, info]) => measured(1, info, cupMl)),
    // "half a kilo", "a quarter of a litre", "three quarters of a cup"
    ...(en ? [map(seq(enFractionBeforeArticle, article, unit), ([f, , info]) => measured(f, info, cupMl))] : []),
    // AMOUNT ITEM: "two apples", "3 eieren" (a count). A Dutch "een" alone is the article, not an amount: "een appel" is not a
    // quantity ("1 appel" is).
    map(unsignedNumber[language], (a, inp, at, next) => (a > 0 && !(language === "nl" && next === at + 1 && inp.norms[at] === "een") ? count(a) : undefined)),
    // some ITEM, the rest [of ITEM]
    ...someWords[language].map((ws) => map(words(...ws), (): Head => ({ dimension: "none", rest: false, approx: true, needsItem: true }))),
    map(words(en ? "the" : "de", "rest"), (): Head => ({ dimension: "none", rest: true, approx: false, needsItem: false }))
  )
}

const checkCup = (options: QuantityOptions | undefined): number | undefined => {
  const cup = options?.cupMl ?? metricCupMl
  return typeof cup === "number" && Number.isFinite(cup) && cup >= 50 && cup <= 1000 ? cup : undefined
}

/**
 * A phrase that is only a quantity of something (README, "Quantities"): `[approximator] amount [unit] [of] item`, "some" item, "the
 * rest" [of item] — "a kilo of rice", "about 250 grams", "twee liter melk", "een ons kaas", "two apples", "a handful of nuts". The
 * item is the text from its first word to its last as written, and holds no reserved word: "2 kg flour and 3 eggs", "2 kg flour,
 * some sugar" and "less than 2 kg flour" are `not-understood` (a list is the caller's to split). Never throws.
 */
export const parseQuantity: (text: string, language: Language, options?: QuantityOptions) => Parsed<Quantity> = guarded((text: string, language: Language, options?: QuantityOptions): Parsed<Quantity> => {
  if (!isText(text) || !isLanguage(language) || !isOptions(options)) return notUnderstood
  const cupMl = checkCup(options)
  if (cupMl === undefined) return notUnderstood
  const toks = tokenize(text)
  if (toks === undefined || toks.length === 0) return notUnderstood
  const input: Input = { text, toks, norms: toks.map((t) => t.norm) }
  const en = language === "en"
  const link: P<string> = en ? alt(words("of"), words("of", "the")) : alt(words("van"), words("van", "de"), words("van", "het"))
  const withEnd = <T>(p: P<T>): P<{ v: T; end: number }> => (inp, at) => p(inp, at).map((h) => ({ value: { v: h.value, end: h.next }, next: h.next }))
  const phrase: P<Quantity> = map(
    seq(opt(oneOf(...approxWords[language])), withEnd(head(language, cupMl)), opt(seq(opt(link), item(language)))),
    ([approx, h, tail], inp) => {
      const q = h.v
      const itemText = tail?.[1] ?? ""
      if (q.needsItem && itemText === "") return undefined
      // "about the rest", "about some": the approximator is for an amount.
      if (approx !== undefined && q.dimension === "none") return undefined
      // The link: English "of" after a unit or "the rest" ("a kilo of rice"), "of the" after "the rest" only ("the rest of the
      // rice"); Dutch "van" / "van de" / "van het" after "de rest" only.
      const linked = tail?.[0]
      if (linked !== undefined && (q.needsItem || (!en && !q.rest) || (linked !== "of" && !q.rest))) return undefined
      const { needsItem: _n, ...rest } = q
      return { ...rest, approx: approx !== undefined || q.approx, said: sliceText(inp.text, inp.toks, 0, h.end), item: itemText }
    }
  )
  const found = whole(phrase, input)
  const said = sliceText(text, toks, 0, toks.length)
  if (found.length === 0) return notUnderstood
  return found.length === 1 ? ok(found[0]!, said) : ambiguous(found, said, "The words read as more than one quantity")
}, notUnderstood)

const dimensionOf = (unit: unknown): Dimension => {
  if (unit === "g" || unit === "kg" || unit === "oz" || unit === "lb") return "mass"
  if (unit === "ml" || unit === "cl" || unit === "dl" || unit === "l" || unit === "tsp" || unit === "tbsp" || unit === "cup") return "volume"
  return "none"
}

/**
 * Convert between units of the same kind: mass (g, kg, oz, lb) or volume (ml, cl, dl, l, tsp, tbsp, cup). A teaspoon is 5 ml, a
 * tablespoon 15 ml, a cup `cupMl` (default 250). The amount is 0 or from 0.000001 to 1 000 000 000 in size; the result is given to 12
 * significant digits and is never 0 for an amount that is not 0, nor beyond 1e12 (decision 2). `undefined` for anything else:
 * other kinds, packs and vague units, an amount outside that range.
 */
export const convertAmount: (amount: number, from: UnitId, to: UnitId, options?: QuantityOptions) => number | undefined = guarded((amount: number, fromUnit: UnitId, toUnit: UnitId, options?: QuantityOptions): number | undefined => {
  if (typeof amount !== "number" || !Number.isFinite(amount) || !isOptions(options)) return undefined
  const size = Math.abs(amount)
  if (size !== 0 && (size < 1e-6 || size > 1e9)) return undefined
  const kind = dimensionOf(fromUnit)
  if (kind === "none" || dimensionOf(toUnit) !== kind) return undefined
  const cupMl = checkCup(options)
  if (cupMl === undefined) return undefined
  const sizeOf = (x: UnitId) => (x === "cup" ? cupMl : factors[x]!)
  const result = tidy((amount * sizeOf(fromUnit)) / sizeOf(toUnit))
  if (!Number.isFinite(result) || (amount !== 0 && (result === 0 || Math.abs(result) > 1e12))) return undefined
  return result
}, undefined)
