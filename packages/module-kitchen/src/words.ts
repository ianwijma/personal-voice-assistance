// What the kitchen does with words: the key a product or ingredient is found by, the phrase a person says cleaned of
// what is not the quantity, and the conservative matching of allergies and diets. Pure functions, each bounded by the
// length of its (already bounded) input; no state.
import { normalizePhrase, stem } from "@pva/core"
import { type Language, parseQuantity, type Quantity } from "@pva/language"

/** The longest key: product names and ingredient keys are cut to this. */
export const KEY_CHARS = 40

const LEADING = new Set(["the", "a", "an", "my", "our", "de", "het", "een", "mijn", "onze", "ons"])

/** One word in its singular form, for the plurals that matter in a kitchen ("tomatoes", "berries", "eggs"). */
const singular = (w: string): string => {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith("oes")) return w.slice(0, -2)
  return stem(w)
}

/**
 * The key a name is found by: lower case, accents and punctuation dropped, a leading article dropped, each word in its
 * singular form, at most `KEY_CHARS` characters. "The Tomatoes" and "tomato" have one key; "rijst" is "rijst".
 */
export const keyOf = (name: string): string => {
  const ws = normalizePhrase(name.slice(0, 200)).split(" ").filter((w) => w !== "")
  while (ws.length > 1 && LEADING.has(ws[0]!)) ws.shift()
  return ws.map(singular).join(" ").slice(0, KEY_CHARS).trim()
}

/** Words that say how an ingredient is prepared: "cooked rice" is rice from the pantry (matching tries without them). */
const PREPARED = new Set([
  "cooked", "boiled", "chopped", "diced", "sliced", "fresh", "dried", "grated", "minced", "tinned", "canned", "frozen", "large", "small",
  "medium", "ripe", "crushed", "ground", "whole", "raw", "peeled", "gekookte", "gekookt", "gehakte", "gehakt", "verse", "vers", "gedroogde",
  "geraspte", "gesneden", "grote", "kleine", "rijpe", "bevroren", "diepvries", "gepelde", "gemalen", "hele"
])

/** The keys an ingredient may be found under, most specific first: "cooked rice", then "rice". */
export const ingredientKeys = (key: string): ReadonlyArray<string> => {
  const out = [key]
  const ws = key.split(" ")
  while (ws.length > 1 && PREPARED.has(ws[0]!)) {
    ws.shift()
    out.push(ws.join(" "))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// The phrase a person says

/** Trailing words that name where it goes or that it is left, not what it is ("to the pantry", "left", "gekocht"). */
const TRAILING = [
  /\s+(?:to|in|into|on|from)\s+(?:the\s+)?(?:pantry|cupboard|fridge|freezer|stock|larder|kitchen|house)$/iu,
  /\s+(?:is|are)\s+left$/iu,
  /\s+(?:left|please|today|now|at home|in the house|do we have|have we got|we have|have i got|i have)$/iu,
  /\s+(?:aan|in|uit)\s+(?:de\s+|het\s+)?(?:voorraad|voorraadkast|koelkast|vriezer|keuken|kast|huis)$/iu,
  /\s+(?:gekocht|gebruikt|toegevoegd|toe|op|over|meer|nog|gehaald|gegeten|opgemaakt|alsjeblieft|graag|vandaag|hebben we nog|hebben we|is er nog|zijn er nog)$/iu
]
/** Leading words that are not the quantity ("I", "we", "out of", "ik", "er"). */
const LEADING_WORDS = /^(?:i|we|we've|ive|i've|just|also|out of|of|ik|we|er|nog|ook|net|van)\s+/iu

/** "some of the cheese" is "some cheese", "wat van de kaas" is "wat kaas": the quantity grammar takes no "of the" there. */
const SOME_OF: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(some|a few|a couple of|several)\s+of\s+(?:the|my|our)\s+/iu, "$1 "],
  [/^(a bit|a little|a lot)\s+of\s+(?:the|my|our)\s+/iu, "$1 of "],
  [/^(wat|een beetje|een paar|veel)\s+van\s+(?:de|het|onze|mijn)\s+/iu, "$1 "]
]

/** The phrase cleaned of what is not "how much of what": "a kilo of rice to the pantry" is "a kilo of rice". */
export const cleanPhrase = (text: string): string => {
  let t = text.slice(0, 200).replace(/[.!?,;:]+$/u, "").replace(/\s+/gu, " ").trim()
  for (let i = 0; i < 6; i++) {
    const before = t
    for (const r of TRAILING) t = t.replace(r, "").trim()
    t = t.replace(LEADING_WORDS, "").trim()
    if (t === before) break
  }
  for (const [r, to] of SOME_OF) t = t.replace(r, to)
  return t.replace(/^a little of /iu, "a bit of ")
}

/** What a phrase says: an amount of an item, an item alone, several things at once, or nothing clear. */
export type Reading =
  | { readonly kind: "amount"; readonly item: string; readonly quantity: Quantity }
  | { readonly kind: "item"; readonly item: string }
  | { readonly kind: "several" }
  | { readonly kind: "unclear" }

const SEVERAL = /(?:^|\s)(?:and|en|plus|&)(?:\s|$)|,/iu

/**
 * Read "about 250 grams of rice", "een kilo rijst", "six eggs", "rice". The household's language first, then the other
 * (a model may word an English phrase in a Dutch household). Never guessed: an ambiguous quantity is `unclear`.
 */
export const readPhrase = (text: string, language: Language, cupMl: number): Reading => {
  const t = cleanPhrase(text)
  if (t === "") return { kind: "unclear" }
  const other: Language = language === "nl" ? "en" : "nl"
  let ambiguous = false
  for (const lang of [language, other]) {
    const parsed = parseQuantity(t, lang, { cupMl })
    if (parsed.kind === "ok") return parsed.value.item === "" ? { kind: "unclear" } : { kind: "amount", item: parsed.value.item, quantity: parsed.value }
    if (parsed.kind === "ambiguous") ambiguous = true
  }
  if (ambiguous) return { kind: "unclear" }
  if (SEVERAL.test(t)) return { kind: "several" }
  // A number we could not read is never dropped: "2 2 rice" is unclear, not "rice".
  if (/\d/u.test(t)) return { kind: "unclear" }
  return keyOf(t) === "" ? { kind: "unclear" } : { kind: "item", item: t }
}

// ---------------------------------------------------------------------------------------------------------------------
// Allergies and diets (conservative: when in doubt, a recipe is left out)

/**
 * What an allergy also covers, by key, in both languages: a safety net beside the allergens a recipe declares. Matching
 * is by substring of keys, so "nut" also leaves out nutmeg and coconut: a recipe left out by mistake is the safe error.
 */
const ALLERGY_TERMS: Readonly<Record<string, ReadonlyArray<string>>> = (() => {
  const nuts = ["nut", "almond", "cashew", "pecan", "pistachio", "hazelnut", "walnut", "macadamia", "peanut", "praline", "marzipan", "pesto", "noot", "noten", "amandel", "pinda", "hazelnoot", "walnoot", "marsepein", "satay", "sate"]
  const peanut = ["peanut", "pinda", "satay", "sate"]
  const gluten = ["gluten", "wheat", "flour", "bread", "pasta", "spaghetti", "noodle", "couscous", "barley", "rye", "spelt", "semolina", "breadcrumb", "cracker", "biscuit", "soy sauce", "beer", "tarwe", "bloem", "brood", "gerst", "rogge", "griesmeel", "paneermeel", "beschuit", "bier", "sojasaus"]
  const dairy = ["milk", "cheese", "butter", "cream", "yoghurt", "yogurt", "lactose", "whey", "ghee", "parmesan", "mozzarella", "feta", "melk", "kaas", "boter", "room", "zuivel", "kwark", "wei"]
  const egg = ["egg", "mayonnaise", "mayo", "meringue", "ei", "eieren", "mayonaise"]
  const fish = ["fish", "salmon", "tuna", "cod", "anchovy", "sardine", "mackerel", "haddock", "vis", "zalm", "tonijn", "kabeljauw", "ansjovis", "makreel"]
  const shellfish = ["shellfish", "shrimp", "prawn", "crab", "lobster", "mussel", "oyster", "clam", "scallop", "garnaal", "garnalen", "krab", "kreeft", "mossel", "oester", "schaaldier"]
  const soy = ["soy", "soya", "tofu", "tempeh", "edamame", "miso", "soja", "sojasaus"]
  const sesame = ["sesame", "tahini", "sesam"]
  const celery = ["celery", "celeriac", "selderij", "knolselderij"]
  const mustard = ["mustard", "mosterd"]
  const out: Record<string, ReadonlyArray<string>> = {}
  const add = (names: ReadonlyArray<string>, terms: ReadonlyArray<string>) => {
    for (const n of names) out[keyOf(n)] = [...(out[keyOf(n)] ?? []), ...terms.map(keyOf)]
  }
  add(["nuts", "nut", "tree nuts", "noten", "noot", "notenallergie"], nuts)
  add(["peanuts", "peanut", "pinda", "pindas", "pinda's"], peanut)
  add(["gluten", "wheat", "coeliac", "celiac", "tarwe", "coeliakie"], gluten)
  add(["dairy", "milk", "lactose", "zuivel", "melk", "lactose-intolerant", "lactose intolerance"], dairy)
  add(["egg", "eggs", "ei", "eieren"], egg)
  add(["fish", "vis"], fish)
  add(["shellfish", "crustaceans", "schaaldieren", "schelpdieren"], shellfish)
  add(["soy", "soya", "soja"], soy)
  add(["sesame", "sesam"], sesame)
  add(["celery", "selderij"], celery)
  add(["mustard", "mosterd"], mustard)
  return out
})()

/** Whether `term` is found in `key`: a whole word for terms under four letters ("ei"), otherwise anywhere ("nut" in "peanut"). */
const found = (term: string, key: string): boolean => {
  if (term === "") return false
  if (term.length < 4) return (` ${key} `).includes(` ${term} `)
  return key.includes(term)
}

/**
 * A test of whether an allergy (as people write it: "nuts", "pinda's") is in any of some keys (a recipe's ingredients,
 * its declared allergens, its title). Its words are worked out once; each test is at most (words × keys) substring
 * checks, with at most about 30 words per allergy.
 */
export const allergyTest = (allergy: string): ((keys: ReadonlyArray<string>) => boolean) => {
  const k = keyOf(allergy)
  if (k === "") return () => false
  const terms = [...new Set([k, ...(ALLERGY_TERMS[k] ?? []), ...k.split(" ").flatMap((w) => ALLERGY_TERMS[w] ?? [])])]
  return (keys) => keys.some((key) => terms.some((term) => found(term, key)))
}

/** Whether an allergy is in any of these keys (`allergyTest`, once). */
export const allergyIn = (allergy: string, keys: ReadonlyArray<string>): boolean => allergyTest(allergy)(keys)

/** A diet as one canonical word, both languages: "Vegetarisch" and "veggie" are "vegetarian". */
export const dietKey = (diet: string): string => {
  const k = keyOf(diet).replace(/-/gu, " ")
  const table: Readonly<Record<string, string>> = {
    vegetarian: "vegetarian", veggie: "vegetarian", vegetarisch: "vegetarian", vegetarier: "vegetarian",
    vegan: "vegan", veganistisch: "vegan", veganist: "vegan", plantaardig: "vegan",
    pescatarian: "pescatarian", pescotarian: "pescatarian", pescotarier: "pescatarian", pescatarier: "pescatarian",
    "gluten free": "gluten free", glutenvrij: "gluten free", "lactose free": "lactose free", lactosevrij: "lactose free",
    "dairy free": "dairy free", zuivelvrij: "dairy free", halal: "halal", kosher: "kosher", koosjer: "kosher"
  }
  return table[k] ?? k
}

/** What a diet also accepts: a vegan dish is vegetarian, and both are pescatarian. */
const SATISFIES: Readonly<Record<string, ReadonlyArray<string>>> = {
  vegetarian: ["vegetarian", "vegan"],
  pescatarian: ["pescatarian", "vegetarian", "vegan"],
  "lactose free": ["lactose free", "dairy free", "vegan"],
  "dairy free": ["dairy free", "vegan"]
}

/** Whether a recipe whose declared diets are `declared` (canonical keys) fits `diet`. Undeclared is no. */
export const dietFits = (diet: string, declared: ReadonlyArray<string>): boolean => {
  const d = dietKey(diet)
  if (d === "") return true
  return (SATISFIES[d] ?? [d]).some((x) => declared.includes(x))
}
