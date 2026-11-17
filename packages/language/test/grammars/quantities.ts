// The quantity grammar of the README ("Quantities") for the tests. The units, the reserved words and the item vocabulary are written
// out here from the README; the values follow its rules (amount × the unit's count, base in grams, millilitres or pieces).
import { fixed, lit, norm, oneOf, words, type Grammar, type Multi, type Rule, type Term } from "../support/Cfg.ts"
import { amountRules } from "./durations.ts"
import { nlWhole, number, type Lang } from "./numbers.ts"

interface Unit { readonly unit: string; readonly dimension: "mass" | "volume" | "count" | "pack" | "vague"; readonly per?: number; readonly size?: number }
const mass = (unit: string, size: number, per?: number): Unit => ({ unit, dimension: "mass", size, ...(per !== undefined ? { per } : {}) })
const volume = (unit: string, size: number): Unit => ({ unit, dimension: "volume", size })
const pack = (unit: string): Unit => ({ unit, dimension: "pack" })
const vague = (unit: string): Unit => ({ unit, dimension: "vague" })
const piece = (per?: number): Unit => ({ unit: "piece", dimension: "count", size: 1, ...(per !== undefined ? { per } : {}) })
const g = mass("g", 1), kg = mass("kg", 1000), oz = mass("oz", 28.349523125), lb = mass("lb", 453.59237)
const ml = volume("ml", 1), cl = volume("cl", 10), dl = volume("dl", 100), l = volume("l", 1000), tsp = volume("tsp", 5), tbsp = volume("tbsp", 15), cup = volume("cup", 250)

export const units: Record<Lang, Record<string, Unit>> = {
  en: {
    g, gram: g, grams: g, kg, kilo: kg, kilos: kg, kilogram: kg, kilograms: kg, oz, ounce: oz, ounces: oz, lb, lbs: lb, pound: lb, pounds: lb,
    ml, millilitre: ml, millilitres: ml, cl, centilitre: cl, centilitres: cl, dl, decilitre: dl, decilitres: dl, l, litre: l, litres: l, liter: l, liters: l,
    tsp, teaspoon: tsp, teaspoons: tsp, tbsp, tablespoon: tbsp, tablespoons: tbsp, cup, cups: cup, piece: piece(), pieces: piece(), dozen: piece(12),
    pack: pack("pack"), packs: pack("pack"), packet: pack("pack"), packets: pack("pack"), bag: pack("bag"), bags: pack("bag"), bottle: pack("bottle"), bottles: pack("bottle"),
    can: pack("can"), cans: pack("can"), tin: pack("can"), tins: pack("can"), jar: pack("jar"), jars: pack("jar"), bunch: pack("bunch"), bunches: pack("bunch"),
    loaf: pack("loaf"), loaves: pack("loaf"), box: pack("box"), boxes: pack("box"), tub: pack("tub"), tubs: pack("tub"), roll: pack("roll"), rolls: pack("roll"),
    handful: vague("handful"), handfuls: vague("handful"), pinch: vague("pinch"), pinches: vague("pinch"), splash: vague("splash"), splashes: vague("splash")
  },
  nl: {
    g, gram: g, kg, kilo: kg, kilos: kg, kilogram: kg, ons: mass("g", 1, 100), pond: mass("g", 1, 500),
    ml, milliliter: ml, cl, centiliter: cl, dl, deciliter: dl, l, liter: l, tl: tsp, theelepel: tsp, theelepels: tsp, el: tbsp, eetlepel: tbsp, eetlepels: tbsp,
    kopje: cup, kopjes: cup, stuk: piece(), stuks: piece(), dozijn: piece(12),
    pak: pack("pack"), pakken: pack("pack"), pakje: pack("pack"), pakjes: pack("pack"), zak: pack("bag"), zakken: pack("bag"), zakje: pack("bag"), zakjes: pack("bag"),
    fles: pack("bottle"), flessen: pack("bottle"), blik: pack("can"), blikken: pack("can"), blikje: pack("can"), blikjes: pack("can"), pot: pack("jar"), potten: pack("jar"),
    potje: pack("jar"), potjes: pack("jar"), bos: pack("bunch"), bossen: pack("bunch"), brood: pack("loaf"), broden: pack("loaf"), doos: pack("box"), dozen: pack("box"),
    bak: pack("tub"), bakken: pack("tub"), bakje: pack("tub"), bakjes: pack("tub"), rol: pack("roll"), rollen: pack("roll"),
    handvol: vague("handful"), snufje: vague("pinch"), snufjes: vague("pinch"), scheutje: vague("splash"), scheutjes: vague("splash")
  }
}

/** The README's reserved words: an item holds none of them. */
export const reserved: Record<Lang, ReadonlySet<string>> = {
  en: new Set(("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty " +
    "seventy eighty ninety hundred thousand million billion point minus half quarter quarters third thirds dozen about around roughly approximately approx some bit few couple " +
    "lot lots rest remaining several a an the of and or nor plus but not no without except less more than least most under over below above max maximum minimum almost nearly " +
    "up to at per each every x").split(" ")),
  nl: new Set(("nul half halve kwart driekwart anderhalf anderhalve derde miljoen miljard komma min dozijn ongeveer circa ca zon rond wat beetje paar veel enkele rest een de " +
    "het van aan en of noch plus maar niet geen zonder behalve minder meer dan minstens hooguit maximaal minimaal bijna ruim boven onder over tot per elke elk ieder iedere x").split(" "))
}
const itemWords: Record<Lang, ReadonlyArray<string>> = {
  en: ["flour", "rice", "sugar", "olive", "oil", "apples", "milk", "eggs", "Ben's", "crème", "fraîche", "tomatoes", "basmati", "cheddar", "Monday", "bread"],
  nl: ["bloem", "rijst", "suiker", "olijfolie", "appels", "melk", "eieren", "kaas", "crème", "tomaten", "boter", "zout", "peper", "maandag", "Ben's"]
}
const itemWord = (lang: Lang): Term => ({
  read: (w) => {
    if (!/^\p{L}+$/u.test(w) || reserved[lang].has(w) || Object.prototype.hasOwnProperty.call(units[lang], w)) return undefined
    if (lang === "nl" && (nlWhole(w) !== undefined || (/^(.+)enhalf$/.test(w) && nlWhole(w.slice(0, -6)) !== undefined))) return undefined
    return w
  },
  write: (r) => r.pick(itemWords[lang])
})

const tidy = (n: number) => Number(n.toPrecision(12))

/** A count's number; a Dutch "een" alone is the article, not an amount (README: "een appel" is not a quantity). */
const countNumber = (lang: Lang): Multi => {
  const n = number(lang, { min: 0, max: 999_999.99 })
  return { readMany: (ws, at) => n.readMany(ws, at).filter((h) => !(lang === "nl" && h.next === at + 1 && ws[at] === "een")), writeMany: (r) => { for (;;) { const w = n.writeMany(r); if (!(lang === "nl" && w.length === 1 && norm(w[0]!) === "een")) return w } } }
}

export interface QuantityValue {
  readonly amount?: number
  readonly unit?: string
  readonly dimension: string
  readonly approx: boolean
  readonly rest: boolean
  readonly base?: { readonly amount: number; readonly unit: string }
  readonly said: string
  readonly item: string
}

const measured = (a: number, u: Unit) => {
  const amount = tidy(a * (u.per ?? 1))
  if (!(amount > 0)) return undefined
  const baseUnit = u.dimension === "mass" ? "g" : u.dimension === "volume" ? "ml" : u.dimension === "count" ? "piece" : undefined
  return {
    amount, unit: u.unit, dimension: u.dimension, approx: u.dimension === "vague", rest: false, needsItem: false,
    ...(baseUnit !== undefined && u.size !== undefined ? { base: { amount: tidy(amount * u.size), unit: baseUnit } } : {})
  }
}

export const quantityGrammar = (lang: Lang): Grammar => {
  const en = lang === "en"
  const article = en ? oneOf({ a: 1, an: 1 }) : lit("een")
  const head: Array<Rule> = [
    { rhs: ["AMOUNT", oneOf(units[lang])], act: ([a, u]) => (a > 0 ? measured(a, u) : undefined), weight: 5 },
    { rhs: [article, oneOf(units[lang])], act: ([, u]) => measured(1, u), weight: 2 },
    { rhs: [countNumber(lang)], act: ([a]) => (a > 0 ? { amount: a, unit: "piece", dimension: "count", approx: false, rest: false, needsItem: true, base: { amount: a, unit: "piece" } } : undefined), weight: 2 },
    ...(en ? ["some", "a bit of", "a few", "a couple of", "a lot of"] : ["wat", "een beetje", "een paar", "veel"]).map((p) => fixed(words(p), { dimension: "none", approx: true, rest: false, needsItem: true })),
    fixed(words(en ? "the rest" : "de rest"), { dimension: "none", approx: false, rest: true, needsItem: false })
  ]
  if (en) {
    head.push(
      { rhs: [lit("half"), article, oneOf(units.en)], act: ([, , u]) => measured(0.5, u) },
      { rhs: [...words("a quarter of"), article, oneOf(units.en)], act: (v) => measured(0.25, v[4]) },
      { rhs: [...words("three quarters of"), article, oneOf(units.en)], act: (v) => measured(0.75, v[4]) }
    )
  }
  return {
    AMOUNT: amountRules(lang),
    HEAD: head,
    APPROX: [{ rhs: [oneOf(Object.fromEntries((en ? ["about", "around", "roughly", "approximately"] : ["ongeveer", "circa", "zo'n"]).map((w) => [w, true])))] }],
    ITEM: [{ rhs: [itemWord(lang)], act: ([w]) => [w], weight: 3 }, { rhs: [itemWord(lang), "ITEM"], act: ([w, rest]) => [w, ...rest] }],
    LINK: en ? [fixed([lit("of")], "of"), fixed(words("of the"), "of the")] : [fixed([lit("van")], "van"), fixed(words("van de"), "van de"), fixed(words("van het"), "van het")],
    TAIL: [{ rhs: ["ITEM"], act: ([item]) => ({ item, link: undefined }), weight: 3 }, { rhs: ["LINK", "ITEM"], act: ([link, item]) => ({ item, link }) }],
    BODY: [{ rhs: ["HEAD"], weight: 1 }, { rhs: ["HEAD", "TAIL"], act: ([h, t]) => ({ ...h, tail: t }), weight: 3 }],
    QUANTITY: [
      { rhs: ["BODY"], act: ([b]) => accept(b, false, en), weight: 3 },
      { rhs: ["APPROX", "BODY"], act: ([, b]) => accept(b, true, en) }
    ]
  }
}

/** The grammar's conditions on a whole quantity (README); the value without `said` (the test takes that from the words). */
const accept = (b: Record<string, any>, approx: boolean, en: boolean): Record<string, unknown> | undefined => {
  const tail = b["tail"] as { item: Array<string>; link?: string } | undefined
  if (b["needsItem"] === true && tail === undefined) return undefined
  if (approx && b["dimension"] === "none") return undefined
  if (tail?.link !== undefined && (b["needsItem"] === true || (!en && b["rest"] !== true) || (tail.link !== "of" && b["rest"] !== true))) return undefined
  const { needsItem: _n, tail: _t, ...q } = b
  return { ...q, approx: approx || b["approx"] === true, item: tail === undefined ? [] : tail.item, linkWords: tail?.link === undefined ? 0 : tail.link.split(" ").length }
}

/** The value with `said` and `item` from the phrase's words (normalised). */
export const withText = (v: Record<string, any>, phrase: ReadonlyArray<string>): QuantityValue => {
  const { item, linkWords, ...q } = v
  const said = phrase.slice(0, phrase.length - item.length - linkWords).map(norm).join(" ")
  return { ...q, said, item: item.join(" ") } as QuantityValue
}
