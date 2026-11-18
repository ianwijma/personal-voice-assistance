// The one fixed vocabulary of allergens: the fourteen major allergens of EU food law (Regulation 1169/2011, Annex II),
// each with its English and Dutch names and the common words that mean it, in both languages. A recipe declares its
// allergens from this list; a person's allergy is mapped onto it. Matching words can never be made complete, so it is
// only ever used to leave a recipe out, on top of the declaration: never to let one in (docs/modules/kitchen.md,
// "Allergies").
import { normalizePhrase } from "@pva/core"
import { type Language } from "@pva/language"
import { Schema } from "effect"

export const ALLERGENS = [
  "gluten",
  "crustaceans",
  "eggs",
  "fish",
  "peanuts",
  "soybeans",
  "milk",
  "nuts",
  "celery",
  "mustard",
  "sesame",
  "sulphites",
  "lupin",
  "molluscs"
] as const
export type AllergenId = typeof ALLERGENS[number]
export const Allergen = Schema.Literals(ALLERGENS)

interface Entry {
  /** How it is said, in each language. */
  readonly en: string
  readonly nl: string
  /**
   * Every name and common synonym, English and Dutch: a person's allergy said as one of these is this allergen, and
   * any of them found in a recipe's title or ingredient lines leaves the recipe out for that person.
   */
  readonly names: ReadonlyArray<string>
}

const VOCABULARY: Readonly<Record<AllergenId, Entry>> = {
  gluten: {
    en: "cereals containing gluten",
    nl: "glutenbevattende granen",
    names: [
      "gluten", "cereals containing gluten", "wheat", "flour", "bread", "breadcrumb", "pasta", "spaghetti", "macaroni", "noodle", "couscous", "bulgur",
      "barley", "rye", "spelt", "oat", "kamut", "durum", "semolina", "seitan", "cracker", "biscuit", "beer", "soy sauce", "coeliac", "celiac",
      "tarwe", "bloem", "brood", "paneermeel", "noedel", "mie", "gerst", "rogge", "haver", "griesmeel", "beschuit", "bier", "sojasaus", "coeliakie",
      "glutenbevattende granen", "granen"
    ]
  },
  crustaceans: {
    en: "crustaceans",
    nl: "schaaldieren",
    names: [
      "crustacean", "shellfish", "shrimp", "prawn", "crab", "lobster", "crayfish", "langoustine", "scampi", "krill",
      "schaaldier", "garnaal", "garnalen", "krab", "kreeft", "rivierkreeft", "langoestine", "kreeftje"
    ]
  },
  eggs: {
    en: "eggs",
    nl: "eieren",
    names: ["egg", "eggs", "mayonnaise", "mayo", "meringue", "aioli", "albumen", "ei", "eieren", "eigeel", "eidooier", "eiwit", "mayonaise", "schuimpje"]
  },
  fish: {
    en: "fish",
    nl: "vis",
    names: [
      "fish", "salmon", "tuna", "cod", "anchov", "sardine", "mackerel", "haddock", "herring", "trout", "pollock", "tilapia", "pangasius", "hake",
      "plaice", "halibut", "surimi", "worcestershire", "vis", "zalm", "tonijn", "kabeljauw", "ansjovis", "sardien", "makreel", "schelvis",
      "haring", "forel", "koolvis", "heek", "schol", "heilbot", "kibbeling", "lekkerbek"
    ]
  },
  peanuts: {
    en: "peanuts",
    nl: "pinda's",
    names: ["peanut", "groundnut", "arachis", "satay", "pinda", "aardnoot", "olienoot", "sate", "satesaus", "pindakaas"]
  },
  soybeans: {
    en: "soybeans",
    nl: "soja",
    names: ["soy", "soya", "soybean", "tofu", "tempeh", "edamame", "miso", "tamari", "shoyu", "soja", "sojaboon", "ketjap"]
  },
  milk: {
    en: "milk",
    nl: "melk",
    names: [
      "milk", "dairy", "lactose", "cheese", "butter", "cream", "yoghurt", "yogurt", "whey", "casein", "ghee", "custard", "kefir", "buttermilk",
      "parmesan", "mozzarella", "feta", "ricotta", "mascarpone", "cheddar", "gouda", "brie", "camembert", "halloumi", "paneer", "pecorino",
      "gruyere", "emmental", "creme fraiche", "melk", "zuivel", "kaas", "boter", "room", "slagroom", "kwark", "wei", "caseine", "vla",
      "karnemelk", "parmezaan", "roomboter", "lactosevrij"
    ]
  },
  nuts: {
    en: "tree nuts",
    nl: "noten",
    names: [
      "nut", "tree nut", "almond", "hazelnut", "walnut", "cashew", "pecan", "pistachio", "macadamia", "brazil nut", "praline", "marzipan",
      "frangipane", "nutella", "gianduja", "pesto", "noot", "noten", "boomnoot", "amandel", "hazelnoot", "walnoot", "cashewnoot", "pecannoot",
      "pistache", "paranoot", "marsepein", "nougat"
    ]
  },
  celery: {
    en: "celery",
    nl: "selderij",
    names: ["celery", "celeriac", "selderij", "selderie", "knolselderij", "bleekselderij", "selder"]
  },
  mustard: {
    en: "mustard",
    nl: "mosterd",
    names: ["mustard", "mosterd"]
  },
  sesame: {
    en: "sesame",
    nl: "sesam",
    names: ["sesame", "sesame seed", "sesame oil", "sesam", "sesamzaad", "sesamzaadjes", "sesamolie", "tahini", "tahin", "gomasio", "hummus", "houmous", "humus", "halva"]
  },
  sulphites: {
    en: "sulphites",
    nl: "sulfiet",
    names: ["sulphite", "sulfite", "sulphur dioxide", "sulfur dioxide", "wine", "sulfiet", "sulfiet", "zwaveldioxide", "wijn", "e220"]
  },
  lupin: {
    en: "lupin",
    nl: "lupine",
    names: ["lupin", "lupine", "lupini"]
  },
  molluscs: {
    en: "molluscs",
    nl: "weekdieren",
    names: [
      "mollusc", "mollusk", "shellfish", "mussel", "oyster", "clam", "scallop", "squid", "calamari", "octopus", "snail", "escargot", "cockle",
      "whelk", "cuttlefish", "abalone", "weekdier", "schelpdier", "mossel", "oester", "venusschelp", "jakobsschelp", "coquille", "inktvis",
      "pijlinktvis", "calamares", "slak", "kokkel", "wulk", "zeekat"
    ]
  }
}

/** Text as both the vocabulary and the recipes are compared: lower case, no accents or apostrophes, single spaces. */
export const allergenText = (text: string): string => normalizePhrase(text.slice(0, 2_000))

/** Each allergen's names, compared as `allergenText` (both languages), worked out once. */
export const NAMES: Readonly<Record<AllergenId, ReadonlyArray<string>>> = Object.fromEntries(
  ALLERGENS.map((id) => [id, [...new Set(VOCABULARY[id].names.map(allergenText).filter((n) => n !== ""))]])
) as unknown as Record<AllergenId, ReadonlyArray<string>>

/**
 * Words a person or the model may use for an allergen that are not names to look for in a recipe (they would match
 * too much, or are a phrase): each maps to the allergens it means. "Nuts" said alone means tree nuts and peanuts
 * both: a person who says "nuts" may mean either, and the stricter reading is the safe one.
 */
const LABELS: Readonly<Record<string, ReadonlyArray<AllergenId>>> = {
  nut: ["nuts", "peanuts"],
  nuts: ["nuts", "peanuts"],
  noot: ["nuts", "peanuts"],
  noten: ["nuts", "peanuts"],
  "tree nuts": ["nuts"],
  boomnoten: ["nuts"],
  notenmix: ["nuts", "peanuts"],
  shellfish: ["crustaceans", "molluscs"],
  schelpdieren: ["crustaceans", "molluscs"],
  seafood: ["fish", "crustaceans", "molluscs"],
  zeevruchten: ["fish", "crustaceans", "molluscs"],
  vis: ["fish"],
  cereals: ["gluten"],
  wheat: ["gluten"],
  "lactose intolerance": ["milk"],
  lactoseintolerantie: ["milk"],
  "lactose intolerant": ["milk"],
  "lactose intolerantie": ["milk"],
  sulfites: ["sulphites"],
  sulfieten: ["sulphites"],
  soybeans: ["soybeans"],
  sojabonen: ["soybeans"],
  pindas: ["peanuts"],
  peanuts: ["peanuts"],
  eieren: ["eggs"],
  weekdieren: ["molluscs"],
  schaaldieren: ["crustaceans"]
}

/** Every word said as an allergy that the vocabulary knows, to what it means: the names, then the labels over them. */
const LABEL_TABLE: ReadonlyMap<string, ReadonlyArray<AllergenId>> = (() => {
  const table = new Map<string, Set<AllergenId>>()
  const put = (word: string, ids: ReadonlyArray<AllergenId>) => {
    const key = allergenText(word)
    if (key === "") return
    const set = table.get(key) ?? new Set<AllergenId>()
    for (const id of ids) set.add(id)
    table.set(key, set)
  }
  for (const id of ALLERGENS) {
    put(id, [id])
    put(VOCABULARY[id].en, [id])
    put(VOCABULARY[id].nl, [id])
    for (const n of VOCABULARY[id].names) put(n, [id])
  }
  // A label replaces what the names alone would give it ("nuts" is also peanuts; "shellfish" both kinds).
  for (const [word, ids] of Object.entries(LABELS)) table.set(allergenText(word), new Set(ids))
  return new Map([...table].map(([k, v]) => [k, [...v]]))
})()

/** "Allergic to", "allergy", "allergie" and the like around the allergen's name, which say nothing about which it is. */
const AROUND = [
  /^(?:allergic to|allergy to|allergies to|an allergy to|allergisch voor|allergisch aan|allergie voor|een allergie voor|intolerant to|intolerantie voor)\s+/u,
  /\s+(?:allergy|allergie|allergies|allergieen|intolerance|intolerantie)$/u,
  /(?:allergie|allergieen)$/u
]

/** The words a label is looked up as: itself, without "allergy" around it, and singular or plural. */
const lookups = (label: string): ReadonlyArray<string> => {
  let t = allergenText(label)
  for (const r of AROUND) t = t.replace(r, "").trim()
  if (t === "") return []
  const out = [t]
  if (t.endsWith("s")) out.push(t.slice(0, -1))
  if (t.endsWith("es")) out.push(t.slice(0, -2))
  if (t.endsWith("en")) out.push(t.slice(0, -2))
  if (!t.endsWith("s")) out.push(`${t}s`)
  return out
}

/**
 * The allergens a label means ("pinda's", "eggs", "notenallergie", "lactose intolerance"), or `undefined` when it
 * means none of the fourteen ("kiwi"): such an allergy cannot be checked. Only a whole word or phrase of the
 * vocabulary maps: "pine nuts" is not "nuts".
 */
export const allergensOf = (label: string): ReadonlyArray<AllergenId> | undefined => {
  for (const k of lookups(label)) {
    const ids = LABEL_TABLE.get(k)
    if (ids !== undefined) return ids
  }
  return undefined
}

/** "None", "geen", "nothing": a declaration that the recipe contains none of the fourteen. */
export const saysNone = (label: string): boolean => /^(?:none|no allergens|nothing|niets|geen|geen allergenen|geen enkele)$/u.test(allergenText(label))

/** Whether any name of `allergen` (either language) occurs in the text, compared as `allergenText`. */
export const mentions = (allergen: AllergenId, text: string): boolean => {
  const t = allergenText(text)
  return NAMES[allergen].some((n) => t.includes(n))
}

/**
 * Whether any name of any of `allergens` occurs in any of the texts (a recipe's title and its ingredient lines, whole):
 * each text compared once as `allergenText`. At most 14 allergens' names against 21 texts of at most 80 characters.
 */
export const anyMentioned = (allergens: ReadonlyArray<AllergenId>, said: ReadonlyArray<string>): boolean => {
  const ts = said.map(allergenText)
  return allergens.some((id) => NAMES[id].some((n) => ts.some((t) => t.includes(n))))
}

/** How an allergen is said. */
export const allergenName = (id: AllergenId, lang: Language): string => VOCABULARY[id][lang]

/** The fourteen as said, for a question ("gluten, crustaceans, eggs, …"). */
export const allergenNames = (lang: Language): ReadonlyArray<string> => ALLERGENS.map((id) => VOCABULARY[id][lang])
