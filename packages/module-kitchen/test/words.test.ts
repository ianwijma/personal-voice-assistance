// The kitchen's word helpers: keys (English and Dutch singulars and plurals), phrases, diets; and the fixed allergen
// vocabulary: every name maps to its allergen in both directions of language, and an allergy outside it maps to none.
import { assert, describe, it } from "@effect/vitest"
import { ALLERGENS, allergensOf, anyMentioned, saysNone } from "../src/allergens.ts"
import { cleanPhrase, dietFits, dietKey, ingredientKeys, keyOf, readPhrase } from "../src/words.ts"

describe("kitchen: words", () => {
  it("finds a product by one key whatever the article, case or plural", () => {
    assert.strictEqual(keyOf("The Tomatoes"), "tomato")
    assert.strictEqual(keyOf("eggs"), "egg")
    assert.strictEqual(keyOf("berries"), "berry")
    assert.strictEqual(keyOf("de rijst"), "rijst")
    assert.strictEqual(keyOf("x".repeat(100)).length, 40)
    assert.deepStrictEqual(ingredientKeys("cooked rice"), ["cooked rice", "rice"])
    assert.deepStrictEqual(ingredientKeys(keyOf("frozen peas")), [`${keyOf("frozen")} pea`, "pea"])
    assert.deepStrictEqual(ingredientKeys("peanut butter"), ["peanut butter"])
  })

  it("Dutch singular and plural are one key: the common endings and the irregular words (finding 17)", () => {
    const same: ReadonlyArray<readonly [string, string]> = [
      ["eieren", "ei"], ["eitjes", "ei"], ["tomaten", "tomaat"], ["uien", "ui"], ["bonen", "boon"], ["noten", "noot"], ["kazen", "kaas"],
      ["druiven", "druif"], ["kippen", "kip"], ["aardappelen", "aardappel"], ["aardappels", "aardappel"], ["wortels", "wortel"], ["bananen", "banaan"],
      ["citroenen", "citroen"], ["peren", "peer"], ["radijzen", "radijs"], ["garnalen", "garnaal"], ["groenten", "groente"], ["linzen", "linze"],
      ["champignons", "champignon"], ["paprika's", "paprika"], ["sjalotten", "sjalot"], ["kersen", "kers"], ["chickens", "chicken"]
    ]
    for (const [plural, one] of same) assert.strictEqual(keyOf(plural), keyOf(one), `${plural} and ${one}`)
    assert.strictEqual(keyOf("verse eieren"), keyOf("verse ei"))
    // Different things stay different.
    assert.notStrictEqual(keyOf("peper"), keyOf("peren"))
    assert.notStrictEqual(keyOf("rijst"), keyOf("rijstnoedels"))
  })

  it("cleans a sentence down to how much of what, in both languages", () => {
    assert.strictEqual(cleanPhrase("a kilo of rice to the pantry."), "a kilo of rice")
    assert.strictEqual(cleanPhrase("een kilo rijst gekocht"), "een kilo rijst")
    assert.strictEqual(cleanPhrase("rice is left"), "rice")
    assert.strictEqual(cleanPhrase("some of the cheese"), "some cheese")
    assert.strictEqual(cleanPhrase("wat van de kaas"), "wat kaas")
    // The advertised examples' leftovers (finding 16).
    assert.strictEqual(cleanPhrase("melk is op"), "melk")
    assert.strictEqual(cleanPhrase("at least six eggs in the house"), "six eggs")
    assert.strictEqual(cleanPhrase("zes eieren zijn"), "zes eieren")
    assert.deepInclude(readPhrase("about 250 grams of rice", "en", 250), { kind: "amount", item: "rice" })
    assert.deepInclude(readPhrase("about 250 grams of rice", "nl", 250), { kind: "amount", item: "rice" })
    assert.deepStrictEqual(readPhrase("rice and pasta", "en", 250), { kind: "several" })
    assert.deepStrictEqual(readPhrase("2 2 rice", "en", 250), { kind: "unclear" })
    assert.deepStrictEqual(readPhrase("rice", "en", 250), { kind: "item", item: "rice" })
  })

  it("diets: one canonical word in both languages, met only when declared", () => {
    assert.strictEqual(dietKey("Vegetarisch"), "vegetarian")
    assert.strictEqual(dietKey("glutenvrij"), "gluten free")
    assert.strictEqual(dietKey("Gluten-free"), "gluten free")
    assert.isTrue(dietFits("vegetarian", ["vegan"]))
    assert.isTrue(dietFits("pescatarian", ["vegetarian"]))
    assert.isFalse(dietFits("vegan", ["vegetarian"]))
    assert.isFalse(dietFits("halal", []))
  })
})

describe("kitchen: the allergen vocabulary", () => {
  it("has the fourteen major allergens of EU food law", () => {
    assert.deepStrictEqual([...ALLERGENS].sort(), ["celery", "crustaceans", "eggs", "fish", "gluten", "lupin", "milk", "molluscs", "mustard", "nuts", "peanuts", "sesame", "soybeans", "sulphites"])
  })

  it("maps names and synonyms to the allergen in both directions of language (finding 2)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["ei", "eggs"], ["eieren", "eggs"], ["egg", "eggs"], ["eggs", "eggs"], ["Eggs", "eggs"],
      ["pinda", "peanuts"], ["pinda's", "peanuts"], ["peanut", "peanuts"], ["peanuts", "peanuts"], ["aardnoot", "peanuts"],
      ["amandel", "nuts"], ["almond", "nuts"], ["almonds", "nuts"], ["walnoot", "nuts"], ["walnuts", "nuts"], ["hazelnoot", "nuts"], ["tree nuts", "nuts"],
      ["sesam", "sesame"], ["sesame", "sesame"], ["melk", "milk"], ["lactose", "milk"], ["dairy", "milk"], ["zuivel", "milk"],
      ["gluten", "gluten"], ["tarwe", "gluten"], ["wheat", "gluten"], ["coeliac", "gluten"], ["garnalen", "crustaceans"], ["shrimp", "crustaceans"],
      ["mosselen", "molluscs"], ["mussels", "molluscs"], ["vis", "fish"], ["fish", "fish"], ["soja", "soybeans"], ["soy", "soybeans"],
      ["selderij", "celery"], ["celery", "celery"], ["mosterd", "mustard"], ["mustard", "mustard"], ["lupine", "lupin"], ["lupin", "lupin"],
      ["sulfiet", "sulphites"], ["sulphites", "sulphites"], ["notenallergie", "nuts"], ["nut allergy", "nuts"], ["allergic to eggs", "eggs"]
    ]
    for (const [label, id] of cases) assert.include(allergensOf(label) ?? [], id, label)
    // "Nuts" alone is both kinds, and "shellfish" both kinds of shellfish: the stricter reading.
    assert.sameMembers([...(allergensOf("nuts") ?? [])], ["nuts", "peanuts"])
    assert.sameMembers([...(allergensOf("noten") ?? [])], ["nuts", "peanuts"])
    assert.sameMembers([...(allergensOf("shellfish") ?? [])], ["crustaceans", "molluscs"])
  })

  it("an allergy outside the vocabulary maps to nothing, and never to a word inside it", () => {
    assert.isUndefined(allergensOf("kiwi"))
    assert.isUndefined(allergensOf("pine nuts"))
    assert.isUndefined(allergensOf("nuts and eggs"))
    assert.isUndefined(allergensOf(""))
    assert.isTrue(saysNone("none"))
    assert.isTrue(saysNone("Geen"))
    assert.isFalse(saysNone("eggs"))
  })

  it("finds the names in recipe lines as substrings, compounds and the other language included", () => {
    assert.isTrue(anyMentioned(["eggs"], ["1 eigeel"]))
    assert.isTrue(anyMentioned(["eggs"], ["2 tablespoons mayonnaise"]))
    assert.isTrue(anyMentioned(["nuts"], ["100 g amandelen"]))
    assert.isTrue(anyMentioned(["nuts"], ["almond flakes"]))
    assert.isTrue(anyMentioned(["sesame"], ["1 el sesamzaad"]))
    assert.isTrue(anyMentioned(["sesame"], ["sesame seeds"]))
    assert.isTrue(anyMentioned(["peanuts"], ["salt, pepper, water, oil, peanuts"]))
    assert.isTrue(anyMentioned(["peanuts"], ["1 g fresh finely chopped organically grown roasted peanuts"]))
    assert.isTrue(anyMentioned(["peanuts"], ["pindakaas"]))
    assert.isTrue(anyMentioned(["milk"], ["Crème fraîche"]))
    assert.isTrue(anyMentioned(["gluten"], ["spaghetti"]))
    assert.isFalse(anyMentioned(["peanuts", "nuts"], ["300 g rice", "Fried rice"]))
  })
})
