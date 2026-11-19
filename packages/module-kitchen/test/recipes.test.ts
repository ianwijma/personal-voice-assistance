// Stored recipes and "what can I make", through the test kit: the time limit, the household's and each person's diets
// and allergies (strictly: declared complete, and never named in the lines), what the pantry certainly has, and what
// the answer may reveal on the shared, private and public devices of the household.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule, type TestHouseholdInput } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { NAMES } from "../src/allergens.ts"
import { kitchenModule, names, products, recipes, recipeTexts } from "../src/index.ts"
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

const ALLERGY_CHECK = "These suggestions go by the allergens declared when the recipes were saved; check the ingredients."

/** The kitchen with the recipe book above and rice, eggs, onions, pasta and soy sauce in the pantry. */
const stocked = (options: { readonly household?: TestHouseholdInput } = {}) =>
  Effect.gen(function*() {
    const k = yield* startTestModule(kitchenModule, { household: options.household ?? household })
    for (const r of book) assert.isTrue((yield* k.tool("kitchen_recipe_save", r)).ok)
    for (const what of ["a kilo of rice", "six eggs", "two onions", "500 grams of pasta", "150 ml of soy sauce"]) yield* k.tool("kitchen_stock_add", { what })
    return k
  })

type Made = {
  readonly recipes?: ReadonlyArray<{ readonly title: string; readonly missing: ReadonlyArray<string>; readonly mayBeMissing: ReadonlyArray<string>; readonly source: string }>
  readonly spoken?: string
  readonly more?: number
  readonly cut?: string
  readonly pantryCut?: string
  readonly leftOut?: string
  readonly undeclared?: string
  readonly tooShort?: string
  readonly ownIdea?: string
  readonly owner?: string
  readonly allergyCheck?: string
}
const made = (r: { readonly value: unknown }) => r.value as Made
const titles = (r: { readonly value: unknown }) => (made(r).recipes ?? []).map((x) => x.title)
/** A recipe declared to contain none of the fourteen, with these lines. */
const none = (title: string, ingredients: ReadonlyArray<string>, minutes = 10) => ({ title, servings: 2, minutes, ingredients, steps: [], allergens: [], source: "own" as const })

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
      assert.deepStrictEqual([...row!.value.allergens].sort(), ["eggs", "gluten", "soybeans"])
      assert.isTrue(row!.value.declared)
      const words = yield* k.moduleStore().collection(recipeTexts).get(row!.id)
      assert.deepStrictEqual(words?.value.lines, book[0].ingredients)
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_save", { ...book[0], title: "egg fried rice" })).value, { spoken: "There is already a recipe called egg fried rice." })
      // A line break in a step is refused before the module runs.
      assert.isFalse((yield* k.tool("kitchen_recipe_save", { ...book[1], steps: ["one\ntwo"] })).ok)
    }))

  it.effect("the allergens are only what was stated, from the fourteen; without them the declaration is not complete", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      const { allergens: _a, ...undeclared } = book[1]
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_save", { ...undeclared, title: "Plain eggs" })).value, {
        spoken: "Saved Plain eggs: serves 2, 25 minutes. Not in the pantry yet: tomato, egg and onion. Its allergens weren't stated, so I won't suggest it to anyone with an allergy."
      })
      assert.isFalse((yield* k.moduleStore().collection(recipes).list({ where: { titleKey: "plain egg" } }))[0]!.value.declared)
      // "None" is a declaration; a word outside the fourteen is a question, and nothing is saved.
      assert.isTrue((yield* k.tool("kitchen_recipe_save", { ...none("Rice", ["300 g rice"]), allergens: ["none"] })).ok)
      assert.isTrue((yield* k.moduleStore().collection(recipes).list({ where: { titleKey: "rice" } }))[0]!.value.declared)
      const kiwi = yield* k.tool("kitchen_recipe_save", { ...none("Fruit salad", ["1 kiwi"]), allergens: ["kiwi"] })
      assert.strictEqual(
        (kiwi.value as { spoken: string }).spoken,
        "kiwi isn't one of the allergens I keep track of: cereals containing gluten, crustaceans, eggs, fish, peanuts, soybeans, milk, tree nuts, celery, mustard, sesame, sulphites, lupin and molluscs. Which of them does it contain? Nothing was saved."
      )
      assert.deepStrictEqual(yield* k.moduleStore().collection(recipes).list({ where: { titleKey: "fruit salad" } }), [])
      // Every ingredient a line gives is kept; more than a recipe holds is refused, never cut (finding 1).
      const many = yield* k.tool("kitchen_recipe_save", none("Long list", [...Array.from({ length: 19 }, (_, n) => `water ${n + 1}`), "salt and peanuts"]))
      assert.deepStrictEqual(many.value, { spoken: "A recipe can have at most 20 ingredients; nothing was saved." })
      const [mix] = [yield* k.tool("kitchen_recipe_save", none("Mix", ["salt, pepper, water, oil, peanuts"]))]
      assert.isTrue(mix.ok)
      assert.deepStrictEqual((yield* k.moduleStore().collection(recipes).list({ where: { titleKey: "mix" } }))[0]!.value.ingredients.map((i) => i.key), ["salt", "pepper", "water", "oil", "peanut"])
    }))

  it.effect("lists, reads and forgets recipes; a name a little off is offered, never guessed", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
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
        allergens: "eggs",
        source: "the household's own"
      })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_get", { name: "shakshoeka" })).value, { spoken: "There's no recipe called shakshoeka. Did you mean Shakshuka?" })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_forget", { name: "Shakshuka" })).value, { spoken: "Forgot the recipe for Shakshuka. The daily backups keep it for up to 14 days." })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_forget", { name: "Shakshuka" })).value, { spoken: "There's no recipe called Shakshuka." })
      assert.deepStrictEqual((yield* k.moduleStore().collection(recipes).list({ where: { titleKey: "shakshuka" } })), [])
      assert.strictEqual((yield* k.moduleStore().collection(recipes).list({})).length, 5)
      const empty = yield* startTestModule(kitchenModule)
      assert.deepStrictEqual((yield* empty.tool("kitchen_recipe_list", {})).value, { spoken: "There are no saved recipes yet." })
    }))

  it.effect("in Dutch: saving, listing, reading and forgetting, with their failure paths (finding 20)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_list", {})).value, { spoken: "Er zijn nog geen recepten bewaard." })
      const saved = yield* k.tool("kitchen_recipe_save", { title: "Omelet", servings: 1, minutes: 10, ingredients: ["2 eieren", "zout naar smaak"], steps: ["Klop de eieren."], allergens: ["ei"], source: "own" })
      assert.deepStrictEqual(saved.value, { spoken: "Omelet bewaard: voor 1 personen, 10 minuten. Nog niet in de voorraad: ei." })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_save", { ...none("omelet", ["2 eieren"]) })).value, { spoken: "Er is al een recept dat omelet heet." })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_save", { ...none("Kiwi", ["1 kiwi"]), allergens: ["kiwi"] })).value, {
        spoken: "kiwi is geen van de allergenen die ik bijhoud: glutenbevattende granen, schaaldieren, eieren, vis, pinda's, soja, melk, noten, selderij, mosterd, sesam, sulfiet, lupine en weekdieren. Welke daarvan zitten erin? Er is niets bewaard."
      })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_save", none("Lang", Array.from({ length: 11 }, (_, n) => `zout en peper ${n}`)))).value, {
        spoken: "Een recept kan hoogstens 20 ingrediënten hebben; er is niets bewaard."
      })
      const { allergens: _a, ...open } = none("Pap", ["1 liter melk"])
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_save", open)).value, {
        spoken: "Pap bewaard: voor 2 personen, 10 minuten. Nog niet in de voorraad: melk. De allergenen zijn niet opgegeven, dus ik stel het niet voor aan iemand met een allergie."
      })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_list", {})).value, { recipes: ["Omelet", "Pap"], more: 0 })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_get", { name: "omelet" })).value, {
        title: "Omelet",
        serves: 1,
        minutes: 10,
        ingredients: ["2 eieren", "zout naar smaak"],
        steps: ["Klop de eieren."],
        allergens: "eieren",
        source: "van het huishouden zelf"
      })
      assert.strictEqual(((yield* k.tool("kitchen_recipe_get", { name: "pap" })).value as { allergens: string }).allergens, "niet opgegeven")
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_get", { name: "omelett" })).value, { spoken: "Er is geen recept dat omelett heet. Bedoel je Omelet?" })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_get", { name: "lasagne" })).value, { spoken: "Er is geen recept dat lasagne heet." })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_forget", { name: "Omelet" })).value, { spoken: "Het recept voor Omelet is vergeten. De dagelijkse back-ups bewaren het nog tot 14 dagen." })
      assert.deepStrictEqual((yield* k.tool("kitchen_recipe_forget", { name: "Omelet" })).value, { spoken: "Er is geen recept dat Omelet heet." })
    }))
})

describe("kitchen: what can I make, and allergies", () => {
  it.effect("on Sam's shared kitchen display: Sam's allergy and the household's, within the time limit, the allergy sentence last", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      const r = yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 20 }, { device: "kitchen-display" })
      assert.deepStrictEqual(r.value, {
        recipes: [{ title: "Egg fried rice", minutes: 20, missing: ["spring onion"], mayBeMissing: [], source: "own" }],
        more: 0,
        leftOut: "1 recipes don't fit the diets of the people you asked about.",
        tooShort: "1 more recipes need more than you have in the house.",
        pantry: ["eggs", "onions", "pasta", "rice", "soy sauce"],
        ownIdea: "If you suggest a dish of your own, say that it is your own idea, and keep to these diets: no shellfish, no nuts.",
        owner: "p-sam",
        allergyCheck: ALLERGY_CHECK
      })
      assert.strictEqual(Object.keys(r.value as object).at(-1), "allergyCheck")
      const all = yield* k.tool("kitchen_what_can_i_make", {}, { device: "kitchen-display" })
      assert.deepStrictEqual(titles(all), ["Egg fried rice", "Shakshuka"])
      assert.notInclude(all.content, "Prawn")
      assert.notInclude(all.content, "Peanut")
      const loose = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 }, { device: "kitchen-display" })
      assert.deepStrictEqual(titles(loose), ["Egg fried rice", "Shakshuka", "Slow beef stew", "Tuna pasta salad"])
    }))

  it.effect("left out unless declared safe: every bypass the review found, in English (findings 1, 2)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, {
        household: {
          people: [
            { id: "p-sam", name: "Sam", aliases: ["Sammie"], diet: { allergies: ["egg"] } },
            { id: "p-robin", name: "Robin", diet: { allergies: ["almond"] } },
            { id: "p-alex", name: "Alex", diet: { allergies: ["sesamzaad"] } }
          ],
          householdDiet: { allergies: ["peanuts"] }
        }
      })
      // Each declared to contain none of the fourteen; each line names an allergen anyway.
      for (
        const r of [
          none("Snack mix", ["salt, pepper, water, oil, peanuts"]),
          none("Watery", [...Array.from({ length: 18 }, (_, n) => `water ${n + 1}`), "salt and peanuts"]),
          none("Roast", ["1 g fresh finely chopped organically grown roasted peanuts"]),
          none("Sauce", ["1 eigeel"]),
          none("Cake", ["100 g amandelen"]),
          none("Salad", ["sesame seeds"]),
          none("Plain rice", ["300 g rice"])
        ]
      ) assert.isTrue((yield* k.tool("kitchen_recipe_save", r)).ok, r.title)
      // The household's peanuts, on the public hall screen (nobody's): only the plain rice.
      const hall = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 }, { device: "hall-screen" })
      assert.deepStrictEqual(titles(hall), ["Cake", "Plain rice", "Salad", "Sauce"])
      // Sam, named by an alias, on Sam's display: the egg yolk sauce is out too.
      const sam = yield* k.tool("kitchen_what_can_i_make", { people: ["Sammie"], allowMissing: 3 }, { device: "kitchen-display" })
      assert.deepStrictEqual(titles(sam), ["Cake", "Plain rice", "Salad"])
      // Robin's almond allergy, against "amandelen"; Alex's "sesamzaad" against "sesame seeds".
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { people: ["Robin"], allowMissing: 3 })), ["Plain rice", "Salad", "Sauce"])
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { people: ["Alex"], allowMissing: 3 })), ["Cake", "Plain rice", "Sauce"])
      // For everyone: all of it together.
      const everyone = yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 3 }, { device: "robins-phone" })
      assert.deepStrictEqual(titles(everyone), ["Plain rice"])
      assert.strictEqual(made(everyone).leftOut, "6 recipes don't fit the diets of the people you asked about.")
      assert.strictEqual(made(everyone).allergyCheck, ALLERGY_CHECK)
    }))

  it.effect("left out unless declared safe: the same bypasses in Dutch, both directions of language (findings 1, 2)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, {
        household: {
          home: { HOME_LANGUAGE: "nl-NL" },
          people: [{ id: "p-sam", name: "Sam", diet: { allergies: ["eieren"] } }, { id: "p-robin", name: "Robin", diet: { allergies: ["amandel"] } }, { id: "p-alex", name: "Alex", diet: { allergies: ["sesam"] } }],
          householdDiet: { allergies: ["pinda's"] }
        }
      })
      for (
        const r of [
          none("Notenmix", ["zout, peper, water, olie, pinda's"]),
          none("Geroosterd", ["1 g verse fijngehakte biologisch geteelde geroosterde pinda's"]),
          none("Satay", ["2 el peanut butter"]),
          none("Saus", ["1 egg yolk"]),
          none("Taart", ["100 g almond flakes"]),
          none("Salade", ["1 el sesamzaad"]),
          none("Rijst", ["300 g rijst"])
        ]
      ) assert.isTrue((yield* k.tool("kitchen_recipe_save", r)).ok, r.title)
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 }, { device: "hall-screen" })), ["Rijst", "Salade", "Saus", "Taart"])
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { people: ["Sam"], allowMissing: 3 })), ["Rijst", "Salade", "Taart"])
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { people: ["Robin"], allowMissing: 3 })), ["Rijst", "Salade", "Saus"])
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { people: ["Alex"], allowMissing: 3 })), ["Rijst", "Saus", "Taart"])
      const r = yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 3 }, { device: "robins-phone" })
      assert.deepStrictEqual(titles(r), ["Rijst"])
      assert.strictEqual(made(r).allergyCheck, "Deze voorstellen gaan uit van de allergenen die zijn opgegeven toen de recepten bewaard werden; kijk de ingrediënten na.")
      assert.strictEqual(Object.keys(r.value as object).at(-1), "allergyCheck")
    }))

  it.effect("a recipe without a complete declaration: never for someone with an allergy, offered to someone without one", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, {
        household: { people: [{ id: "p-sam", name: "Sam", diet: { allergies: ["nuts"] } }, { id: "p-robin", name: "Robin" }, { id: "p-alex", name: "Alex" }] }
      })
      const { allergens: _a, ...undeclared } = none("Rice bowl", ["300 g rice"])
      yield* k.tool("kitchen_recipe_save", undeclared)
      const sam = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 }, { device: "kitchen-display" })
      assert.deepStrictEqual(made(sam).recipes, undefined)
      assert.strictEqual(made(sam).spoken, "None of your saved recipes fit.")
      assert.strictEqual(made(sam).undeclared, "1 recipes were left out because their allergens weren't stated when they were saved.")
      assert.strictEqual(made(sam).allergyCheck, ALLERGY_CHECK)
      const robin = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 }, { device: "robins-phone" })
      assert.deepStrictEqual(titles(robin), ["Rice bowl"])
      assert.isUndefined(made(robin).allergyCheck)
      // The typed answer says it too, and ends with the allergy sentence.
      assert.deepStrictEqual(yield* k.action("what_to_make", {}, { device: "kitchen-display" }), {
        ok: true,
        say: `None of your saved recipes fit. 1 recipes were left out because their allergens weren't stated when they were saved. ${ALLERGY_CHECK}`
      })
    }))

  it.effect("an allergy outside the fourteen cannot be checked: nothing is suggested, named only where it may be", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, {
        household: { people: [{ id: "p-sam", name: "Sam" }, { id: "p-robin", name: "Robin", diet: { allergies: ["kiwi"] } }, { id: "p-alex", name: "Alex" }] }
      })
      yield* k.tool("kitchen_recipe_save", none("Plain rice", ["300 g rice"]))
      const phone = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 }, { device: "robins-phone" })
      assert.deepStrictEqual(phone.value, {
        spoken: "I can't check recipes for kiwi, so I won't suggest any; a person has to read the recipes' ingredients.",
        ownIdea: "Do not suggest a dish of your own: an allergy of the people asked about cannot be checked.",
        allergyCheck: ALLERGY_CHECK
      })
      // Asked for Robin on Sam's display: Robin's allergy is not named there.
      const display = yield* k.tool("kitchen_what_can_i_make", { people: ["Robin"], allowMissing: 3 }, { device: "kitchen-display" })
      assert.strictEqual(made(display).spoken, "I can't check recipes for one of the allergies of the people you asked about, so I won't suggest any; a person has to read the recipes' ingredients.")
      assert.notInclude(display.content, "kiwi")
      assert.deepStrictEqual(made(yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 }, { device: "kitchen-display" })).recipes?.map((x) => x.title), ["Plain rice"])
      const nl = yield* startTestModule(kitchenModule, {
        household: { home: { HOME_LANGUAGE: "nl-NL" }, people: [{ id: "p-robin", name: "Robin", diet: { allergies: ["kiwi"] } }], devices: [{ id: "robins-phone", name: "Telefoon", privacy: "private", defaultPerson: "p-robin" }] }
      })
      assert.deepStrictEqual(yield* nl.action("what_to_make", {}, { device: "robins-phone" }), {
        ok: true,
        say: "Ik kan recepten niet nagaan op kiwi, dus ik stel er geen voor; iemand moet de ingrediënten van de recepten lezen. Deze voorstellen gaan uit van de allergenen die zijn opgegeven toen de recepten bewaard werden; kijk de ingrediënten na."
      })
    }))

  it.effect("on the public hall screen, asked for Sam: Sam's allergy is applied, and nothing names it", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      const r = yield* k.tool("kitchen_what_can_i_make", { people: ["Sam"] }, { device: "hall-screen" })
      assert.deepStrictEqual(titles(r), ["Egg fried rice", "Shakshuka"])
      assert.strictEqual(made(r).ownIdea, "Do not suggest a dish of your own here: the diets of the people asked about cannot be named on this device.")
      assert.isUndefined(made(r).owner)
      assert.notMatch(r.content, /\bnuts?\b/iu)
      const anyone = yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 15, allowMissing: 2 }, { device: "hall-screen" })
      assert.deepStrictEqual(titles(anyone), ["Peanut noodles"])
    }))

  it.effect("on Sam's shared kitchen display, asked for Robin: Robin's diet is applied and not named there", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      const r = yield* k.tool("kitchen_what_can_i_make", { people: ["Robin"], allowMissing: 3 }, { device: "kitchen-display" })
      assert.deepStrictEqual(titles(r), ["Egg fried rice", "Shakshuka", "Peanut noodles"])
      assert.strictEqual(made(r).ownIdea, "Do not suggest a dish of your own here: the diets of the people asked about cannot be named on this device.")
      assert.notInclude(r.content, "vegetarian")
      assert.isUndefined(made(r).owner)
    }))

  it.effect("on Robin's private phone, for everyone: every member's diet, and they may be named here", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 3 }, { device: "robins-phone" })), ["Egg fried rice", "Shakshuka"])
      const r = yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 0 }, { device: "robins-phone" })
      assert.strictEqual(made(r).spoken, "None of your saved recipes fit.")
      assert.strictEqual(made(r).leftOut, "4 recipes don't fit the diets of the people you asked about.")
      assert.strictEqual(made(r).ownIdea, "If you suggest a dish of your own, say that it is your own idea, and keep to these diets: no shellfish, no nuts, vegetarian.")
      assert.strictEqual(made(r).owner, "p-sam")
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
        ownIdea: "Do not suggest a dish of your own here: the diets of the people asked about cannot be named on this device.",
        allergyCheck: ALLERGY_CHECK
      })
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 15, allowMissing: 2 }, { device: "living-room" })), ["Peanut noodles"])
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
      const many = Array.from({ length: 10 }, (_, n) => ({ id: `p-${n}`, name: `Person ${n}`, diet: { allergies: Array.from({ length: 30 }, (_, a) => `allergen ${n}-${a}`) } }))
      const crowded = yield* startTestModule(kitchenModule, { household: { people: many, devices: [{ id: "kitchen-display", name: "Kitchen display", privacy: "private", defaultPerson: "p-0" }] } })
      assert.isAbove(300, MAX_DIET_TERMS)
      assert.deepStrictEqual((yield* crowded.tool("kitchen_what_can_i_make", { everyone: true })).value, { spoken: "There are too many diets to check at once; ask for fewer people." })
    }))
})

describe("kitchen: what the pantry certainly has", () => {
  it.effect("a requirement that cannot be compared, or a stock not known, is 'may be missing', never enough (finding 8)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_stock_add", { what: "1 gram of rice" })
      for (const [title, line] of [["Cups", "2 cups of rice"], ["Bags", "2 bags of rice"], ["Pieces", "3 rice"]] as const) yield* k.tool("kitchen_recipe_save", none(title, [line]))
      assert.strictEqual(made(yield* k.tool("kitchen_what_can_i_make", { allowMissing: 0 })).spoken, "None of your saved recipes fit.")
      const one = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 1 })
      assert.deepStrictEqual(made(one).recipes?.map((x) => [x.title, x.missing, x.mayBeMissing]), [["Bags", [], ["rice"]], ["Cups", [], ["rice"]], ["Pieces", [], ["rice"]]])
      // A stock not known: may be missing, also for a recipe that needs more than was last known.
      yield* k.tool("kitchen_stock_set", { what: "2 kilos of rice" })
      yield* k.tool("kitchen_recipe_save", none("Kilo", ["1 kg rice"]))
      assert.deepStrictEqual(made(yield* k.tool("kitchen_what_can_i_make", { allowMissing: 0 })).recipes?.map((x) => x.title), ["Kilo"])
      yield* k.tool("kitchen_stock_use", { what: "some rice" })
      const unsure = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 1 })
      assert.deepStrictEqual(made(unsure).recipes?.find((x) => x.title === "Kilo")?.mayBeMissing, ["rice"])
      assert.deepStrictEqual(yield* k.action("what_to_make", { within: "10 minutes" }), { ok: true, say: "You could make Bags, if there is enough rice; Cups, if there is enough rice; Kilo, if there is enough rice." })
    }))

  it.effect("requirements are added up per product, across lines, aliases and units, before they are compared (findings 8, 9)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_stock_add", { what: "300 grams of rice" })
      yield* k.tool("kitchen_product_set", { item: "rice", alias: "rijst" })
      yield* k.tool("kitchen_stock_add", { what: "480 ml of milk" })
      yield* k.tool("kitchen_stock_add", { what: "six eggs" })
      yield* k.tool("kitchen_recipe_save", none("Twice", ["200 g rice", "200 g rice"]))
      yield* k.tool("kitchen_recipe_save", none("Alias", ["200 g rice", "200 g rijst"]))
      yield* k.tool("kitchen_recipe_save", none("Kilos", ["0.2 kg rice", "50 g rice"]))
      yield* k.tool("kitchen_recipe_save", none("Milky", ["2 cups of milk"]))
      yield* k.tool("kitchen_recipe_save", none("Eight", ["8 eggs"]))
      yield* k.tool("kitchen_recipe_save", none("Six", ["6 eggs"]))
      const r = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 1 })
      assert.deepStrictEqual(made(r).recipes?.map((x) => [x.title, x.missing]), [["Kilos", []], ["Six", []], ["Alias", ["rice"]], ["Eight", ["eggs"]], ["Milky", ["milk"]]])
      assert.strictEqual(made(r).more, 1)
      // Two metric cups are 500 ml; two US cups are 473 ml, and fit.
      const us = yield* startTestModule(kitchenModule, { settings: { cup: "us" } })
      yield* us.tool("kitchen_stock_add", { what: "480 ml of milk" })
      yield* us.tool("kitchen_recipe_save", none("Milky", ["2 cups of milk"]))
      assert.deepStrictEqual(made(yield* us.tool("kitchen_what_can_i_make", { allowMissing: 0 })).recipes?.map((x) => x.title), ["Milky"])
    }))

  it.effect("Dutch singular and plural: a recipe's ingredient finds the product either way (finding 17)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* k.tool("kitchen_stock_add", { what: "zes eieren" })
      yield* k.tool("kitchen_stock_add", { what: "een kilo tomaten" })
      yield* k.tool("kitchen_recipe_save", none("Ei", ["1 ei", "200 g tomaat"]))
      assert.deepStrictEqual(yield* k.action("what_to_make", {}), { ok: true, say: "Je kunt Ei, met alles in huis maken." })
    }))
})

describe("kitchen: time, provenance and what was read", () => {
  it.effect("a time limit is compared as given, never rounded up (finding 15)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_recipe_save", none("Glass of water", ["water"], 2))
      assert.deepStrictEqual(yield* k.action("what_to_make", { within: "90 seconds" }), { ok: true, say: "None of your saved recipes fit within a minute and a half." })
      assert.deepStrictEqual(yield* k.action("what_to_make", { within: "2 minutes" }), { ok: true, say: "You could make Glass of water, with everything in the house." })
      assert.strictEqual(made(yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 1 })).spoken, "None of your saved recipes fit within 1 minute.")
      assert.deepStrictEqual(titles(yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 2 })), ["Glass of water"])
    }))

  it.effect("a suggestion says where the recipe came from, on both paths and for both sources (finding 19)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_recipe_save", { ...none("Toast", ["water"]), source: "assistant" })
      yield* k.tool("kitchen_recipe_save", none("Tea", ["water"], 11))
      const r = yield* k.tool("kitchen_what_can_i_make", {})
      assert.deepStrictEqual(made(r).recipes?.map((x) => [x.title, x.source]), [["Toast", "assistant"], ["Tea", "own"]])
      assert.deepStrictEqual(yield* k.action("what_to_make", {}), { ok: true, say: "You could make Toast (an idea of mine you saved), with everything in the house; Tea, with everything in the house." })
      assert.strictEqual(((yield* k.tool("kitchen_recipe_get", { name: "toast" })).value as { source: string }).source, "the assistant's own idea, saved")
      const nl = yield* startTestModule(kitchenModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* nl.tool("kitchen_recipe_save", { ...none("Toast", ["water"]), source: "assistant" })
      assert.deepStrictEqual(yield* nl.action("what_to_make", {}), { ok: true, say: "Je kunt Toast (een idee van mij dat je bewaard hebt), met alles in huis maken." })
    }))

  it.effect("a cut read is always said, on the tool and the typed answer; counts are of what was read (finding 10)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      // 100 recipes of a minute that need something not in the house, then one of two minutes that needs nothing.
      yield* k.moduleStore().transaction((tx) => {
        for (let n = 0; n < RECIPE_SCAN; n++) {
          const row = tx.collection(recipes).insert({ title: `Dish ${n}`, titleKey: `dish ${n}`, servings: 2, minutes: 1, ingredients: [{ key: "saffron" }, { key: "truffle" }], allergens: [], declared: true, diets: [], source: "own" })
          tx.collection(recipeTexts).insert({ lines: ["saffron", "truffle"], steps: [] }, { id: row.id })
        }
      })
      yield* k.tool("kitchen_recipe_save", none("Water", ["water"], 2))
      const r = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 0 })
      assert.strictEqual(made(r).spoken, "None of the first 100 recipes I read fit; there are more I didn't read.")
      assert.strictEqual(made(r).cut, "I read only the first 100 recipes, so others may fit too.")
      assert.deepStrictEqual(yield* k.action("what_to_make", {}), {
        ok: true,
        say: "None of the first 100 recipes I read fit; there are more I didn't read. I read only the first 100 recipes, so others may fit too. 100 more recipes need more than you have in the house."
      })
      // The pantry's bound on its own: an ingredient whose product was past it is "may be missing", and said.
      const p = yield* startTestModule(kitchenModule)
      yield* p.moduleStore().transaction((tx) => {
        for (let n = 0; n < 500; n++) {
          const name = `item ${String(n).padStart(3, "0")}`
          const row = tx.collection(products).insert({ name, key: name, unit: "g", stock: 0, unknown: false, low: true, aliases: [], tidiedAt: 0, listedAt: 0 })
          tx.collection(names).insert({ key: name, product: row.id })
        }
      })
      yield* p.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* p.tool("kitchen_recipe_save", none("Rice", ["300 g rice"]))
      const cut = yield* p.tool("kitchen_what_can_i_make", { allowMissing: 1 })
      assert.deepStrictEqual(made(cut).recipes?.map((x) => x.mayBeMissing), [["rice"]])
      assert.strictEqual(made(cut).pantryCut, "I read only the first 500 products of the pantry, so some ingredients may be there that I count as missing.")
      assert.include(spokenOf(yield* p.action("what_to_make", {})), "I read only the first 500 products of the pantry")
    }))

  it.effect("the worst case keeps the event loop free: 100 recipes of 20 lines against 200 allergy words (finding 7)", () =>
    Effect.gen(function*() {
      // 200 allergy words that all map, spread over the whole vocabulary: the most names a check compares.
      const words = [...new Set(Object.values(NAMES).flat())].slice(0, MAX_DIET_TERMS)
      assert.strictEqual(words.length, MAX_DIET_TERMS)
      const people = Array.from({ length: 6 }, (_, n) => ({ id: `p-${n}`, name: `Person ${n}`, diet: { allergies: words.slice(20 + n * 30, 50 + n * 30) } }))
      const k = yield* startTestModule(kitchenModule, {
        household: { people, householdDiet: { allergies: words.slice(0, 20) }, devices: [{ id: "kitchen-display", name: "Kitchen display", privacy: "private", defaultPerson: "p-0" }] }
      })
      // Each recipe declared free of all fourteen, with 20 lines of 80 characters that name none of them, so every
      // name is compared with every line: nothing ends a check early.
      const line = (n: number) => `${n} g ${"q".repeat(73 - String(n).length)}`.padEnd(80, "q")
      yield* k.moduleStore().transaction((tx) => {
        for (let n = 0; n < RECIPE_SCAN; n++) {
          const row = tx.collection(recipes).insert({
            title: `Dish ${n}`,
            titleKey: `dish ${n}`,
            servings: 2,
            minutes: 10,
            ingredients: Array.from({ length: 20 }, (_, i) => ({ key: `${"x".repeat(38)}${String(i).padStart(2, "0")}` })),
            allergens: [],
            declared: true,
            diets: [],
            source: "own"
          })
          tx.collection(recipeTexts).insert({ lines: Array.from({ length: 20 }, (_, i) => line(i)), steps: [] }, { id: row.id })
        }
      })
      yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 3 })
      let worst = 0
      let longest = 0
      for (let run = 0; run < 3; run++) {
        let last = performance.now()
        let stop = 0
        const timer = setInterval(() => {
          const now = performance.now()
          stop = Math.max(stop, now - last)
          last = now
        }, 1)
        const t0 = performance.now()
        const r = yield* k.tool("kitchen_what_can_i_make", { everyone: true, allowMissing: 3 })
        longest = Math.max(longest, performance.now() - t0)
        clearInterval(timer)
        worst = Math.max(worst, stop, performance.now() - last)
        assert.strictEqual(made(r).tooShort, "100 more recipes need more than you have in the house.")
      }
      console.log(`kitchen_what_can_i_make, 100 recipes × 20 lines against ${MAX_DIET_TERMS} allergy words: longest event-loop stop ${worst.toFixed(2)} ms (each call ${longest.toFixed(1)} ms at most)`)
      assert.isBelow(worst, bound(10))
    }))

  it.effect("reads at most 100 recipes and says so; the time limit stops the read early, in order of time", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      const ingredients = Array.from({ length: 20 }, (_, n) => ({ key: `ingredient ${n}` }))
      yield* k.moduleStore().transaction((tx) => {
        for (let n = 0; n < RECIPE_SCAN + 20; n++) {
          tx.collection(recipes).insert({ title: `Dish ${n}`, titleKey: `dish ${n}`, servings: 2, minutes: 10 + n, ingredients, allergens: [], declared: true, diets: [], source: "own" })
        }
      })
      const r = yield* k.tool("kitchen_what_can_i_make", { allowMissing: 3 })
      assert.strictEqual(made(r).cut, "I read only the first 100 recipes, so others may fit too.")
      const quick = yield* k.tool("kitchen_what_can_i_make", { maxMinutes: 15, allowMissing: 3 })
      assert.isUndefined(made(quick).cut)
      assert.strictEqual(made(quick).tooShort, "6 more recipes need more than you have in the house.")
      assert.strictEqual(((yield* k.tool("kitchen_recipe_list", {})).value as { cut?: string }).cut, "I read the first 100 recipes; there are more.")
    }))

  it.effect("the typed action answers with a template and no model, in English and in Dutch, every example included (finding 16)", () =>
    Effect.gen(function*() {
      const k = yield* stocked()
      // "what can I cook within 15 minutes", "what can I make", "what can we make for everyone tonight".
      assert.deepStrictEqual(yield* k.action("what_to_make", { within: "15 minutes" }), {
        ok: true,
        say: `None of your saved recipes fit within a quarter of an hour. 1 recipes don't fit the diets of the people you asked about. 1 more recipes need more than you have in the house. ${ALLERGY_CHECK}`
      })
      assert.deepStrictEqual(yield* k.action("what_to_make", {}), {
        ok: true,
        say: `You could make Egg fried rice, short of spring onion; Shakshuka, short of tomato. 2 recipes don't fit the diets of the people you asked about. 2 more recipes need more than you have in the house. ${ALLERGY_CHECK}`
      })
      assert.deepStrictEqual(yield* k.action("what_to_make", { everyone: true }), {
        ok: true,
        say: `You could make Egg fried rice, short of spring onion; Shakshuka, short of tomato. 4 recipes don't fit the diets of the people you asked about. ${ALLERGY_CHECK}`
      })
      // "wat kan ik maken", "wat kan ik binnen een kwartier koken".
      const nl = yield* startTestModule(kitchenModule, { household: { ...household, home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual(yield* nl.action("what_to_make", {}), { ok: true, say: "Er zijn nog geen recepten bewaard. Deze voorstellen gaan uit van de allergenen die zijn opgegeven toen de recepten bewaard werden; kijk de ingrediënten na." })
      yield* nl.tool("kitchen_recipe_save", { ...book[1], title: "Shakshuka", ingredients: ["4 eieren", "1 ui"], allergens: ["ei"] })
      yield* nl.tool("kitchen_stock_add", { what: "zes eieren" })
      assert.deepStrictEqual(yield* nl.action("what_to_make", { within: "een kwartier" }), {
        ok: true,
        say: "Geen van je bewaarde recepten past binnen een kwartier. Deze voorstellen gaan uit van de allergenen die zijn opgegeven toen de recepten bewaard werden; kijk de ingrediënten na."
      })
      assert.deepStrictEqual(yield* nl.action("what_to_make", { within: "een half uur" }), {
        ok: true,
        say: "Je kunt Shakshuka, alleen ui ontbreekt maken. Deze voorstellen gaan uit van de allergenen die zijn opgegeven toen de recepten bewaard werden; kijk de ingrediënten na."
      })
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
        owner: "p-sam",
        allergyCheck: ALLERGY_CHECK
      })
    }))
})

/** What an action said. */
const spokenOf = (r: { readonly ok: boolean; readonly say?: string | undefined }) => r.say ?? ""
