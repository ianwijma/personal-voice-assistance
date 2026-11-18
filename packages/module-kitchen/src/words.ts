// What the kitchen does with words: the key a product or ingredient is found by, the phrase a person says cleaned of
// what is not the quantity, and diets and dislikes. Pure functions, each bounded by the length of its (already
// bounded) input; no state. Allergies are not matched here: they go by the fixed vocabulary (`allergens.ts`).
import { normalizePhrase, stem } from "@pva/core"
import { type Language, parseQuantity, type Quantity } from "@pva/language"

/** The longest key: product names and ingredient keys are cut to this (pantry matching only; never an allergy check). */
export const KEY_CHARS = 40

const LEADING = new Set(["the", "a", "an", "my", "our", "de", "het", "een", "mijn", "onze", "ons"])

/** Dutch plurals the endings below do not reach, and the diminutives a kitchen uses. */
const IRREGULAR: Readonly<Record<string, string>> = {
  eieren: "ei",
  eitjes: "ei",
  eitje: "ei",
  uien: "ui",
  uitjes: "ui",
  uitje: "ui",
  groenten: "groente",
  linzen: "linze",
  kalveren: "kalf",
  lammeren: "lam",
  runderen: "rund",
  kinderen: "kind",
  bladeren: "blad",
  kruidjes: "kruid",
  tomaatjes: "tomaat",
  worteltjes: "wortel",
  aardappeltjes: "aardappel"
}

const VOWEL = /[aeiouy]/u
const isVowel = (c: string | undefined) => c !== undefined && VOWEL.test(c)

/**
 * The Dutch "-en" plural taken off ("tomaten" → "tomaat", "bonen" → "boon", "kazen" → "kaas", "druiven" → "druif",
 * "kippen" → "kip", "aardappelen" → "aardappel"), for a word of five letters or more that does not end in "-een".
 * The open syllable gets its long vowel back where a single a, o or u (or the e of a one-syllable word) stood.
 */
const dutchEn = (w: string): string => {
  if (w.length < 5 || !w.endsWith("en") || w.endsWith("een")) return w
  let s = w.slice(0, -2)
  if (s.endsWith("z")) s = `${s.slice(0, -1)}s`
  else if (s.endsWith("v")) s = `${s.slice(0, -1)}f`
  const last = s.at(-1)
  const vowel = s.at(-2)
  const before = s.at(-3)
  if (last !== undefined && !isVowel(last) && s.at(-2) === last) return s.slice(0, -1)
  const syllables = s.match(/[aeiouy]+/gu)?.length ?? 0
  if (last !== undefined && !isVowel(last) && vowel !== undefined && "aou".includes(vowel) && !isVowel(before)) return `${s.slice(0, -1)}${vowel}${last}`
  if (last !== undefined && !isVowel(last) && vowel === "e" && !isVowel(before) && syllables === 1) return `${s.slice(0, -1)}e${last}`
  return s
}

/**
 * One word in its singular form, English and Dutch alike ("tomatoes", "berries", "eggs", "eieren", "tomaten"), so a
 * product said in the singular and in the plural is one product, in either language. The rules are applied until the
 * word stays the same, so a word and its plural meet in one key ("kazen" and "kaas", "chickens" and "chicken").
 */
export const singular = (word: string): string => {
  let w = word
  for (let i = 0; i < 4; i++) {
    const irregular = IRREGULAR[w]
    let next = irregular ?? w
    if (irregular === undefined) {
      if (next.length > 4 && next.endsWith("ies")) next = `${next.slice(0, -3)}y`
      else if (next.length > 4 && next.endsWith("oes")) next = next.slice(0, -2)
      else next = stem(next)
      if (next === w) next = dutchEn(next)
    }
    if (next === w) return w
    w = next
  }
  return w
}

/**
 * The key a name is found by: lower case, accents and punctuation dropped, a leading article dropped, each word in its
 * singular form, at most `KEY_CHARS` characters. "The Tomatoes" and "tomato" have one key; so do "eieren" and "ei".
 */
export const keyOf = (name: string): string => {
  const ws = normalizePhrase(name.slice(0, 200)).split(" ").filter((w) => w !== "")
  while (ws.length > 1 && LEADING.has(ws[0]!)) ws.shift()
  return ws.map(singular).join(" ").slice(0, KEY_CHARS).trim()
}

/** Words that say how an ingredient is prepared: "cooked rice" is rice from the pantry (matching tries without them). */
const PREPARED = new Set(
  [
    "cooked", "boiled", "chopped", "diced", "sliced", "fresh", "dried", "grated", "minced", "tinned", "canned", "frozen", "large", "small",
    "medium", "ripe", "crushed", "ground", "whole", "raw", "peeled", "gekookte", "gekookt", "gehakte", "gehakt", "verse", "vers", "gedroogde",
    "geraspte", "gesneden", "grote", "kleine", "rijpe", "bevroren", "diepvries", "gepelde", "gemalen", "hele"
  ].map(singular)
)

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

/**
 * Trailing words that name where it goes, that it is left or gone, not what it is ("to the pantry", "left", "is op",
 * "zijn", "gekocht"). Longer phrases first: "is op" before "op".
 */
const TRAILING = [
  /\s+(?:to|in|into|on|from)\s+(?:the\s+)?(?:pantry|cupboard|fridge|freezer|stock|larder|kitchen|house)$/iu,
  /\s+(?:is|are|was|were)\s+(?:left|gone|finished|empty|out|all gone)$/iu,
  /\s+(?:left|please|today|now|at home|in the house|in stock|do we have|have we got|we have|have i got|i have)$/iu,
  /\s+(?:aan|in|uit)\s+(?:de\s+|het\s+)?(?:voorraad|voorraadkast|koelkast|vriezer|keuken|kast|huis)$/iu,
  /\s+(?:is|zijn|was|waren)\s+(?:op|leeg|weg|over|er nog|opgemaakt)$/iu,
  /\s+(?:gekocht|gebruikt|toegevoegd|toe|op|over|meer|nog|gehaald|gegeten|opgemaakt|alsjeblieft|graag|vandaag|hebben we nog|hebben we|is er nog|zijn er nog|in huis zijn|zijn|is|hebben|heb|hebt|heeft|in huis)$/iu
]
/** Leading words that are not the quantity ("I", "we", "out of", "at least", "ik", "er", "altijd"). */
const LEADING_WORDS = /^(?:i|we|we've|ive|i've|just|also|out of|of|at least|always|ik|er|nog|ook|net|van|altijd|minstens|ten minste|tenminste|dat er|dat)\s+/iu

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
// Diets and dislikes (a diet is met only when a recipe declares it; a dislike only lowers a recipe)

/** A diet as one canonical word, both languages: "Vegetarisch" and "veggie" are "vegetarian". */
export const dietKey = (diet: string): string => {
  const k = normalizePhrase(diet.slice(0, 200)).replace(/-/gu, " ")
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

/** The longest dislike compared (a dislike only orders the answer, so a longer one is cut, never matched in part). */
const DISLIKE_CHARS = 60

/** A dislike as it is looked for in a recipe's title and lines: `normalizePhrase`, cut to a bound. */
export const dislikeText = (dislike: string): string => normalizePhrase(dislike.slice(0, DISLIKE_CHARS))
