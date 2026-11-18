// The kitchen's word helpers: keys, phrases, and the conservative allergy and diet matching.
import { assert, describe, it } from "@effect/vitest"
import { allergyIn, cleanPhrase, dietFits, dietKey, ingredientKeys, keyOf, readPhrase } from "../src/words.ts"

describe("kitchen: words", () => {
  it("finds a product by one key whatever the article, case or plural", () => {
    assert.strictEqual(keyOf("The Tomatoes"), "tomato")
    assert.strictEqual(keyOf("eggs"), "egg")
    assert.strictEqual(keyOf("berries"), "berry")
    assert.strictEqual(keyOf("de rijst"), "rijst")
    assert.strictEqual(keyOf("x".repeat(100)).length, 40)
    assert.deepStrictEqual(ingredientKeys("cooked rice"), ["cooked rice", "rice"])
    assert.deepStrictEqual(ingredientKeys("peanut butter"), ["peanut butter"])
  })

  it("cleans a sentence down to how much of what, in both languages", () => {
    assert.strictEqual(cleanPhrase("a kilo of rice to the pantry."), "a kilo of rice")
    assert.strictEqual(cleanPhrase("een kilo rijst gekocht"), "een kilo rijst")
    assert.strictEqual(cleanPhrase("rice is left"), "rice")
    assert.strictEqual(cleanPhrase("some of the cheese"), "some cheese")
    assert.strictEqual(cleanPhrase("wat van de kaas"), "wat kaas")
    assert.deepInclude(readPhrase("about 250 grams of rice", "en", 250), { kind: "amount", item: "rice" })
    assert.deepInclude(readPhrase("about 250 grams of rice", "nl", 250), { kind: "amount", item: "rice" })
    assert.deepStrictEqual(readPhrase("rice and pasta", "en", 250), { kind: "several" })
    assert.deepStrictEqual(readPhrase("2 2 rice", "en", 250), { kind: "unclear" })
    assert.deepStrictEqual(readPhrase("rice", "en", 250), { kind: "item", item: "rice" })
  })

  it("leaves a recipe out when in doubt: allergy words, their relatives in both languages, and undeclared diets", () => {
    assert.isTrue(allergyIn("nuts", ["peanut butter"]))
    assert.isTrue(allergyIn("noten", ["pinda"]))
    assert.isTrue(allergyIn("gluten", ["spaghetti"]))
    assert.isTrue(allergyIn("lactose", ["parmesan"]))
    assert.isTrue(allergyIn("ei", ["ei"]))
    assert.isFalse(allergyIn("ei", ["rijst"]))
    assert.isTrue(allergyIn("shellfish", ["prawn"]))
    assert.isFalse(allergyIn("nuts", ["rice", "egg"]))
    assert.isTrue(allergyIn("coriander", ["fresh coriander"]))
    assert.strictEqual(dietKey("Vegetarisch"), "vegetarian")
    assert.isTrue(dietFits("vegetarian", ["vegan"]))
    assert.isTrue(dietFits("pescatarian", ["vegetarian"]))
    assert.isFalse(dietFits("vegan", ["vegetarian"]))
    assert.isFalse(dietFits("halal", []))
  })
})
