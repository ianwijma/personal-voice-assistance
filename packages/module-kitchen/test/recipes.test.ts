// Stored recipes and "what can I make", through the test kit: the time limit, the household's and each person's diets
// and allergies (strictly), and what the answer may reveal on the shared, private and public devices of the household.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule, type TestHouseholdInput } from "@pva/core/testing"
import { Effect } from "effect"
import { kitchenModule, recipes, recipeTexts } from "../src/index.ts"
import { MAX_DIET_TERMS, RECIPE_SCAN } from "../src/recipes.ts"

/** The default household's people with diets: Sam is allergic to nuts, Robin is vegetarian, the household avoids shellfish. */
const household: TestHouseholdInput = {
  people: [{ id: "p-sam", name: "Sam", diet: { allergies: ["nuts"] } }, { id: "p-robin", name: "Robin", diet: { diets: ["vegetarian"] } }, { id: "p-alex", name: "Alex" }],
  householdDiet: { allergies: ["shellfish"] }
}

const book = [
  { title: "Egg fried rice", servings: 2, minutes: 20, ingredients: ["300 g cooked rice", "2 eggs", "1 tablespoon soy sauce", "salt to taste", "1 spring onion"], steps: ["Beat the eggs.", "Fry the rice.", "Add the eggs and soy sauce."], allergens: ["egg", "soy", "gluten"], diets: ["vegetarian"], source: "own" },
  { title: "Shakshuka", servings: 2, minutes: 25, ingredients: ["1 tin of tomatoes", "4 eggs", "1 onion", "1 teaspoon cumin, optional"], steps: ["Soften the onion.", "Add the tomatoes.", "Poach the eggs."], allergens: ["egg"], diets: ["vegetarian", "gluten free"], source: "own" },
  { title: "Peanut noodles", servings: 2, minutes: 15, ingredients: ["200 g noodles", "3 tablespoons peanut butter", "1 tablespoon soy sauce"], steps: ["Cook the noodles.", "Stir in the sauce."], allergens: ["peanuts", "gluten", "soy"], diets: ["vegan"], source: "own" },
  { title: "Tuna pasta salad", servings: 2, minutes: 15, ingredients: ["250 g pasta", "1 tin of tuna", "100 g sweetcorn", "2 tablespoons mayonnaise"], steps: ["Cook the pasta.", "Mix."], allergens: ["fish", "gluten", "egg"], source: "own" },
  { title: "Prawn curry", servings: 4, minutes: 30, ingredients: ["400 g prawns", "1 onion", "400 ml coconut milk"], steps: ["Fry the onion.", "Add the rest."], allergens: ["shellfish"], source: "own" },
  { title: "Slow beef stew", servings: 6, minutes: 180, ingredients: ["1 kg beef", "2 onions", "500 ml stock"], steps: ["Brown the beef.", "Simmer for three hours."], allergens: [], source: "own" }
] as const

/** The kitchen with the recipe book above and rice, eggs, onions, pasta and soy sauce in the pantry. */
const stocked = (options: { readonly household?: TestHouseholdInput } = {}) =>
  Effect.gen(function*() {
    const k = yield* startTestModule(kitchenModule, { household: options.household ?? household })
    for (const r of book) assert.isTrue((yield* k.tool("kitchen_recipe_save", r)).ok)
    for (const what of ["a kilo of rice", "six eggs", "two onions", "500 grams of pasta", "150 ml of soy sauce"]) yield* k.tool("kitchen_stock_add", { what })
    return k
  })

describe("kitchen: recipes", () => {
  it.effect("saves a dictated recipe, says what is not in the pantry yet, and refuses a second one of the same name", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.tool("kitchen_stock_add", { what: "six eggs" })
      const saved = yield* k.tool("kitchen_recipe_save", book[0])
      assert.deepStrictEqual(saved.value, { spoken: "Saved Egg fried rice: serves 2, 20 minutes. Not in the pantry yet: soy sauce and spring onion." })
      const [row] = yield* k.moduleStore().collection(recipes).list({})
      assert.deepStrictEqual(row!.value.ingredients, [
        { key: "cooked rice", amount: 300, unit: "g" },
        { key: "egg", amount: 2, unit: "piece" },
        { key: "soy sauce", amount: 15, unit: "ml" },
        { key: "salt", optional: true },
        { key: "spring onion", amount: 1, unit: "piece" }
      ])
      assert.deepStrictEqual(row!.value.diets, ["vegetarian"])
      const words = yield* k.moduleStore().collection(recipeTexts).get(row!.id)
      assert.deepStrictEqual(words?.value.steps, ["Beat the eggs.", "Fry the rice.", "Add the eggs and soy sauce."])
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_save", { ...book[0], title: "egg fried rice" })).value, { spoken: "There is already a recipe called egg fried rice." })
      // A line break in a step is refused before the module runs.
      assert.isFalse((yield* k.tool("kitchen_recipe_save", { ...book[1], steps: ["one\ntwo"] })).ok)
    }))

  it.effect("lists, reads and forgets recipes; a name a little off is offered, never guessed", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      // Six recipes: more than one list page (five) of the recipes collection.
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_list", {})).value, {
        recipes: ["Egg fried rice", "Peanut noodles", "Prawn curry", "Shakshuka", "Slow beef stew", "Tuna pasta salad"],
        more: 0
      })
      const got = yield* k.tool("kitchen_recipe_get", { name: "shakshuka" })
      assert.deepStrictEqual(got.value, {
        title: "Shakshuka",
        serves: 2,
        minutes: 25,
        ingredients: ["1 tin of tomatoes", "4 eggs", "1 onion", "1 teaspoon cumin, optional"],
        steps: ["Soften the onion.", "Add the tomatoes.", "Poach the eggs."],
        source: "the household's own"
      })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_get", { name: "shakshoeka" })).value, { spoken: "There's no recipe called shakshoeka. Did you mean Shakshuka?" })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_forget", { name: "Shakshuka" })).value, { spoken: "Forgot the recipe for Shakshuka. The daily backups keep it for up to 14 days." })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_forget", { name: "Shakshuka" })).value, { spoken: "There's no recipe called Shakshuka." })
      // The recipe and its words went together.
      assert.deepStrictEqual((yield* k.moduleStore().collection(recipes).list({ where: { titleKey: "shakshuka" } })), [])
      assert.strictEqual((yield* k.moduleStore().collection(recipes).list({})).length, 5)
      const empty = yield* startTestModule(kitchenModule)
      assert.deepStrictEqual((yield* empty.tool("kitchen_recipe_list", {})).value, { spoken: "There are no saved recipes yet." })
    }))

  it.effect("what can I make, on Sam's shared kitchen display: Sam's allergy and the household's, within the time limit", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      const r = yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 20 }, { device: "kitchen-display" })
      assert.deepStrictEqual(r.value, {
        recipes: [{ title: "Egg fried rice", minutes: 20, missing: ["spring onion"] }],
        more: 0,
        leftOut: "1 recipes don't fit the diets of the people you asked about.",
        tooShort: "1 more recipes need more than you have in the house.",
        allergyCheck: "Allergies were checked against the recipes' ingredients and declared allergens; ready-made ingredients such as sauces and stock cubes can hide them.",
        pantry: ["eggs", "onions", "pasta", "rice", "soy sauce"],
        ownIdea: "If you suggest a dish of your own, say that it is your own idea, and keep to these diets: no shellfish, no nuts.",
        owner: "p-sam"
      })
      // Without a limit: shakshuka (missing the tomatoes) too; the prawn curry never (the household's shellfish).
      const all = yield* k.tool("kitchen_what_can_i_make", {}, { device: "kitchen-display" })
      assert.deepStrictEqual((all.value as { recipes: ReadonlyArray<{ title: string }> }).recipes.map((x) => x.title), ["Egg fried rice", "Shakshuka"])
      assert.notInclude(all.content, "Prawn")
      assert.notInclude(all.content, "Peanut")
      // Allowing more missing brings the tuna salad back; never the excluded ones.
      const loose = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 }, { device: "kitchen-display" })
      assert.deepStrictEqual((loose.value as { recipes: ReadonlyArray<{ title: string }> }).recipes.map((x) => x.title), ["Egg fried rice", "Shakshuka", "Slow beef stew", "Tuna pasta salad"])
    }))

  it.effect("on the public hall screen, asked for Sam: Sam's allergy is applied, and nothing names it", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      const r = yield* k.tool("kitchen_what_can_i_make", { people: ["Sam"] }, { device: "hall-screen" })
      const value = r.value as { recipes: ReadonlyArray<{ title: string }>; ownIdea?: string; owner?: string }
      assert.deepStrictEqual(value.recipes.map((x) => x.title), ["Egg fried rice", "Shakshuka"])
      assert.strictEqual(value.ownIdea, "Do not suggest a dish of your own here: the diets of the people asked about cannot be named on this device.")
      assert.isUndefined(value.owner)
      assert.notMatch(r.content, /\bnuts?\b/iu)
      // Nobody asked for and nobody asking: the household's own diet only, so the peanut noodles are in.
      const anyone = yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 15, allowMissing: 2 }, { device: "hall-screen" })
      assert.deepStrictEqual((anyone.value as { recipes: ReadonlyArray<{ title: string }> }).recipes.map((x) => x.title), ["Peanut noodles"])
    }))

  it.effect("on Sam's shared kitchen display, asked for Robin: Robin's diet is applied and not named there", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      const r = yield* k.tool("kitchen_what_can_i_make", { people: ["Robin"], allowMissing: 3 }, { device: "kitchen-display" })
      const value = r.value as { recipes: ReadonlyArray<{ title: string }>; ownIdea?: string; owner?: string }
      // Not declared vegetarian: the tuna salad and the stew are left out. Named people replace the one asking, so Sam's
      // nut allergy does not apply here and the (vegan) peanut noodles are in.
      assert.deepStrictEqual(value.recipes.map((x) => x.title), ["Egg fried rice", "Shakshuka", "Peanut noodles"])
      assert.strictEqual(value.ownIdea, "Do not suggest a dish of your own here: the diets of the people asked about cannot be named on this device.")
      assert.notInclude(r.content, "vegetarian")
      assert.isUndefined(value.owner)
    }))

  it.effect("on Robin's private phone, for everyone: every member's diet, and they may be named here", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      const fits = yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 3 }, { device: "robins-phone" })
      // The tuna salad and the stew are not declared vegetarian (Robin), the noodles have peanuts (Sam), the curry prawns.
      assert.deepStrictEqual((fits.value as { recipes: ReadonlyArray<{ title: string }> }).recipes.map((x) => x.title), ["Egg fried rice", "Shakshuka"])
      // Nothing with everything in the house: the model may offer its own idea, and is told every diet to keep to.
      const r = yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 0 }, { device: "robins-phone" })
      const value = r.value as { spoken?: string; ownIdea?: string; owner?: string; leftOut?: string }
      assert.strictEqual(value.spoken, "None of your saved recipes fit.")
      assert.strictEqual(value.leftOut, "4 recipes don't fit the diets of the people you asked about.")
      assert.strictEqual(value.ownIdea, "If you suggest a dish of your own, say that it is your own idea, and keep to these diets: no shellfish, no nuts, vegetarian.")
      assert.strictEqual(value.owner, "p-sam")
    }))

  it.effect("on a public screen whose default person is Sam, and on a shared screen with nobody: who is asking decides the diet, the device what is named", () =>
    Effect.gen(function*() {
      const k = yield* stocked({
        household: {
          ...household,
          devices: [
            { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: "p-sam" },
            { id: "living-room", name: "Living room", room: "Living", privacy: "shared", defaultPerson: null }
          ]
        }
      })
      const hall = yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 15, allowMissing: 2 }, { device: "hall-screen" })
      assert.deepStrictEqual(hall.value, {
        spoken: "None of your saved recipes fit within a quarter of an hour.",
        leftOut: "1 recipes don't fit the diets of the people you asked about.",
        tooShort: "1 more recipes need more than you have in the house.",
        allergyCheck: "Allergies were checked against the recipes' ingredients and declared allergens; ready-made ingredients such as sauces and stock cubes can hide them.",
        ownIdea: "Do not suggest a dish of your own here: the diets of the people asked about cannot be named on this device."
      })
      const living = yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 15, allowMissing: 2 }, { device: "living-room" })
      assert.deepStrictEqual((living.value as { recipes: ReadonlyArray<{ title: string }> }).recipes.map((x) => x.title), ["Peanut noodles"])
      // Asked for Sam on the shared screen that is nobody's: applied, not named.
      const forSam = yield* k.tool("kitchen_what_can_i_make", { people: ["Sam"] }, { device: "living-room" })
      assert.notMatch(forSam.content, /\bnuts?\b/iu)
      assert.include(forSam.content, "Do not suggest a dish of your own here")
    }))

  it.effect("asks about people it does not know or cannot tell apart, and refuses more diets than it checks at once", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, {
        household: { people: [{ id: "p-sam-j", name: "Sam Jones" }, { id: "p-sam-s", name: "Sam Smith" }, { id: "p-robin", name: "Robin" }], devices: [{ id: "kitchen-display", name: "Kitchen display", privacy: "shared", defaultPerson: null }] }
      })
      assert.deepStrictEqual((yield* k.tool("kitchen_what_can_i_make", { people: ["Kim"] })).value, { spoken: "I don't know who Kim is." })
      assert.deepStrictEqual((yield* k.tool("kitchen_what_can_i_make", { people: ["Sam"] })).value, { spoken: "Which Sam do you mean: Sam Jones and Sam Smith?" })
      // Ten people with 30 allergies each: more diet words than one answer checks. Refused, never checked in part.
      const many = Array.from({ length: 10 }, (_, n) => ({ id: `p-${n}`, name: `Person ${n}`, diet: { allergies: Array.from({ length: 30 }, (_, a) => `allergen ${n}-${a}`) } }))
      const crowded = yield* startTestModule(kitchenModule, { household: { people: many, devices: [{ id: "kitchen-display", name: "Kitchen display", privacy: "private", defaultPerson: "p-0" }] } })
      assert.isAbove(300, MAX_DIET_TERMS)
      assert.deepStrictEqual((yield* crowded.tool("kitchen_what_can_i_make", { everyone: true })).value, { spoken: "There are too many diets to check at once; ask for fewer people." })
    }))

  it.effect("reads at most 100 recipes and says so; the time limit stops the read early, in order of time", () =>
    Effect.gen(function*() {
      // Six people with 30 allergies each and the household's own: 181 diet words, near the bound of 200.
      const heavy = Array.from({ length: 6 }, (_, n) => ({ id: `p-${n}`, name: `Person ${n}`, diet: { allergies: Array.from({ length: 30 }, (_, a) => `allergen ${n} ${a}`) } }))
      const k = yield* startTestModule(kitchenModule, { household: { people: heavy, householdDiet: { allergies: ["shellfish"] }, devices: [{ id: "kitchen-display", name: "Kitchen display", privacy: "private", defaultPerson: "p-0" }] } })
      const ingredients = Array.from({ length: 20 }, (_, n) => ({ key: `ingredient ${n}` }))
      yield* k.moduleStore().transaction((tx) => {
        for (let n = 0; n < RECIPE_SCAN + 20; n++) {
          tx.collection(recipes).insert({ title: `Dish ${n}`, titleKey: `dish ${n}`, servings: 2, minutes: 10 + n, ingredients, allergens: [], diets: [], source: "own" })
        }
      })
      // Near the worst case: 120 recipes of 20 ingredients against 181 diet words. Bounded (100 recipes read), and fast.
      const started = performance.now()
      const r = yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 3 })
      const took = performance.now() - started
      assert.strictEqual((r.value as { cut?: string }).cut, "I read the first 100 recipes; there are more.")
      assert.isBelow(took, 2_000)
      // Within 15 minutes: only Dish 0 to 5 are read, and the read is not cut.
      const quick = yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 15, allowMissing: 3 })
      assert.isUndefined((quick.value as { cut?: string }).cut)
      assert.strictEqual((quick.value as { tooShort?: string }).tooShort, "6 more recipes need more than you have in the house.")
      assert.strictEqual(((yield* k.tool("kitchen_recipe_list", {})).value as { cut?: string }).cut, "I read the first 100 recipes; there are more.")
    }))

  it.effect("the typed action answers with a template and no model, in English and in Dutch", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      assert.deepStrictEqual(yield* k.action("what_to_make", { within: "20 minutes" }), {
        ok: true,
        say: "You could make Egg fried rice, short of spring onion. 1 recipes don't fit the diets of the people you asked about."
      })
      assert.deepStrictEqual(yield* k.action("what_to_make", {}), {
        ok: true,
        say: "You could make Egg fried rice, short of spring onion; Shakshuka, short of tomato. 2 recipes don't fit the diets of the people you asked about."
      })
      const nl = yield* startTestModule(kitchenModule, { household: { ...household, home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual(yield* nl.action("what_to_make", {}), { ok: true, say: "Er zijn nog geen recepten bewaard." })
      yield* nl.tool("kitchen_recipe_save", { ...book[1], title: "Shakshuka", ingredients: ["4 eieren", "1 ui"], allergens: ["ei"] })
      yield* nl.tool("kitchen_stock_add", { what: "zes eieren" })
      assert.deepStrictEqual(yield* nl.action("what_to_make", { within: "een half uur" }), { ok: true, say: "Je kunt Shakshuka, alleen ui ontbreekt maken." })
    }))

  it.effect("with no recipe that fits, the model is told what is in the pantry and the diets to keep to", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, { household })
      yield* k.tool("kitchen_stock_add", { what: "two courgettes" })
      const r = yield* k.tool("kitchen_what_can_i_make", {}, { device: "kitchen-display" })
      assert.deepStrictEqual(r.value, {
        spoken: "There are no saved recipes yet.",
        pantry: ["courgettes"],
        ownIdea: "If you suggest a dish of your own, say that it is your own idea, and keep to these diets: no shellfish, no nuts.",
        owner: "p-sam"
      })
    }))
})
