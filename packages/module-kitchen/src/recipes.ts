// Stored recipes, entered by voice (the model structures what the person dictates), and "what can I make": the stored
// recipes that fit a time limit, the diets and allergies of the people it is for, and what is in the pantry.
import {
  ActionError, CurrentTurn, defineAction, type Diet, EMPTY_DIET, makeTool, type ModuleHostApi, type ModuleStore, Param, People, type Person, Privacy,
  type Row, ToolError, type TurnContext
} from "@pva/core"
import { type Language, metricCupMl, speakDuration, speakList, usCupMl } from "@pva/language"
import { homeLanguage, isLine, say } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import Fuse from "fuse.js"
import { randomUUID } from "node:crypto"
import { type Ingredient, names, type Product, products, type Recipe, recipes, recipeTexts, scan } from "./data.ts"
import { PRODUCT_PAGE, PRODUCT_SCAN, round, storeFailureText } from "./pantry.ts"
import { texts } from "./texts.ts"
import { allergyTest, dietFits, dietKey, ingredientKeys, keyOf, readPhrase } from "./words.ts"

/** The most recipes one answer reads: 20 pages of 5 (a recipe row is up to 5,000 characters). */
export const RECIPE_SCAN = 100
const RECIPE_PAGE = 5
/** How many recipes an answer names, and how many missing things per recipe. */
export const SHOWN = 5
const MISSING_SHOWN = 3
/** The most people one "what can I make" is for, and the most distinct allergy words it checks (a bound on the work). */
export const MAX_PEOPLE = 10
export const MAX_DIET_TERMS = 200

export interface RecipeDeps {
  readonly host: ModuleHostApi
  readonly store: ModuleStore
  readonly settings: { readonly cup: "metric" | "us"; readonly assumed: ReadonlyArray<string> }
}

const Line = (max: number, description: string) =>
  Schema.String.check(Schema.makeFilter((t: string) => (isLine(t, max) && t.trim() !== "") || `one line of 1 to ${max} characters`)).annotate({ description })

const OPTIONAL = /\s*(?:\(\s*(?:optional|optioneel)\s*\)|,?\s*(?:optional|optioneel|to taste|naar smaak|if you like|naar keuze))\s*$/iu

/** One ingredient line as said ("300 g cooked rice", "salt to taste") as matching keeps it; "salt and pepper" is two. */
export const parseIngredient = (line: string, lang: Language, cupMl: number): ReadonlyArray<Ingredient> => {
  const optional = OPTIONAL.test(line)
  const text = line.replace(OPTIONAL, "").trim()
  const mark = optional ? { optional: true } : {}
  const r = readPhrase(text, lang, cupMl)
  if (r.kind === "amount") {
    const q = r.quantity
    const key = keyOf(r.item)
    if (q.dimension === "pack" && q.amount !== undefined) return [{ key, packs: q.amount, ...mark }]
    if (q.base !== undefined) return [{ key, amount: round(q.base.amount), unit: q.base.unit, ...mark }]
    return [{ key, ...mark }]
  }
  if (r.kind === "several") return text.split(/\s*(?:,|\band\b|\ben\b|&|\bplus\b)\s*/iu).map(keyOf).filter((k) => k !== "").slice(0, 4).map((key) => ({ key, ...mark }))
  const key = keyOf(text.replace(/\d+(?:[.,]\d+)?/gu, ""))
  return key === "" ? [] : [{ key, ...mark }]
}

/** Which product an ingredient is: by its key or an alias, then without preparation words ("cooked rice" is rice). */
const productFor = (byKey: ReadonlyMap<string, Product>, ingredient: Ingredient): Product | undefined => {
  for (const k of ingredientKeys(ingredient.key)) {
    const p = byKey.get(k)
    if (p !== undefined) return p
  }
  return undefined
}

/** Whether the pantry has enough of an ingredient. Unknown amounts and other units count as present when there is some. */
const enough = (p: Product | undefined, i: Ingredient): boolean => {
  if (p === undefined) return false
  if (p.uncertain) return true
  if (p.stock <= 0) return false
  if (i.amount !== undefined && i.unit === p.unit) return p.stock >= i.amount
  if (i.packs !== undefined && p.pack !== undefined) return p.stock >= i.packs * p.pack
  return true
}

/** A diet part with whose it is: the household's (`owner` absent) or one person's. */
interface DietItem {
  readonly text: string
  readonly owner?: string
}

export const recipeTools = (deps: RecipeDeps) => {
  const { store, settings } = deps
  const cupMl = settings.cup === "us" ? usCupMl : metricCupMl
  const lang = () => homeLanguage(deps.host.view())
  const recipeStore = store.collection(recipes)
  const textStore = store.collection(recipeTexts)
  const minutesText = (m: number, l: Language) => speakDuration(m * 60_000, l) ?? `${m} min`

  const byTitle = () => scan(recipeStore, { orderBy: { field: "titleKey", direction: "asc" } }, RECIPE_PAGE, RECIPE_SCAN)

  /** A stored recipe by its name, or the nearest name (from a bounded read) to offer. */
  const findRecipe = (name: string) =>
    Effect.gen(function*() {
      const key = keyOf(name)
      if (key !== "") {
        const [hit] = yield* recipeStore.list({ where: { titleKey: key }, limit: 1 })
        if (hit !== undefined) return { row: hit }
      }
      const { rows } = yield* byTitle()
      const fuse = new Fuse(rows.map((r) => r.value), { keys: ["titleKey"], threshold: 0.35, ignoreLocation: true })
      const near = fuse.search(key, { limit: 1 })[0]?.item.title
      return { suggestion: near }
    })

  const unknownRecipe = (name: string, suggestion: string | undefined, l: Language) =>
    suggestion !== undefined ? say(texts, l, "recipeUnknownMaybe", { name, suggestion }) : say(texts, l, "recipeUnknown", { name })

  const save = makeTool({
    name: "kitchen_recipe_save",
    description:
      "Save a recipe the person dictates, or one of your own ideas they want kept, in the household's recipe book. Give each ingredient as one line with its amount (\"300 g cooked rice\", \"2 eggs\", \"salt to taste\"), the steps one per line, and the allergens it contains (nuts, peanuts, gluten, dairy, egg, fish, shellfish, soy, sesame, celery, mustard) and the diets it suits (vegetarian, vegan, gluten free…), as far as you can tell from the ingredients.",
    parameters: Schema.Struct({
      title: Line(60, "The recipe's name"),
      servings: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({ description: "How many people it serves" }),
      minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_440 })).annotate({ description: "Total time in minutes, preparation included" }),
      ingredients: Schema.Array(Line(80, "One ingredient with its amount")).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
      steps: Schema.Array(Line(250, "One step")).check(Schema.isMaxLength(20)),
      allergens: Schema.Array(Line(20, "An allergen it contains")).check(Schema.isMaxLength(8)).annotate({ description: "The allergens it contains; empty when none" }),
      diets: Schema.optionalKey(Schema.Array(Line(30, "A diet it suits")).check(Schema.isMaxLength(6))),
      source: Schema.Literals(["own", "assistant"]).annotate({ description: "own: the person's recipe; assistant: your own idea, saved because they asked" })
    }),
    risk: "change",
    execute: (input) =>
      Effect.gen(function*() {
        const l = lang()
        const titleKey = keyOf(input.title)
        if (titleKey === "") return { spoken: say(texts, l, "unclear") }
        const ingredients = input.ingredients.flatMap((line) => parseIngredient(line, l, cupMl)).slice(0, 20)
        if (ingredients.length === 0) return { spoken: say(texts, l, "unclear") }
        const recipe: Recipe = {
          title: input.title.trim(),
          titleKey,
          servings: input.servings,
          minutes: input.minutes,
          ingredients,
          allergens: [...new Set(input.allergens.map((a) => keyOf(a)).filter((a) => a !== ""))].slice(0, 8),
          diets: [...new Set((input.diets ?? []).map(dietKey).filter((d) => d !== ""))].slice(0, 6),
          source: input.source
        }
        const failed = (e: unknown) => new ToolError({ message: storeFailureText(e, l, "recipeUnsaved") })
        const saved = yield* store.transaction((tx) => {
          if (tx.collection(recipes).list({ where: { titleKey }, limit: 1 }).length > 0) return false
          const id = randomUUID()
          tx.collection(recipes).insert(recipe, { id })
          tx.collection(recipeTexts).insert({ lines: input.ingredients.map((s) => s.trim()), steps: input.steps.map((s) => s.trim()) }, { id })
          return true
        }).pipe(Effect.mapError(failed))
        if (!saved) return { spoken: say(texts, l, "recipeExists", { title: input.title }) }
        // What is not in the pantry yet: one indexed read per ingredient (at most 20), for the person to know.
        const assumed = new Set(settings.assumed.map(keyOf))
        const missing: Array<string> = []
        for (const i of ingredients) {
          if (i.optional === true || ingredientKeys(i.key).some((k) => assumed.has(k))) continue
          let found = false
          for (const k of ingredientKeys(i.key)) {
            if ((yield* store.collection(names).list({ where: { key: k }, limit: 1 }).pipe(Effect.orElseSucceed(() => []))).length > 0) found = true
          }
          if (!found) missing.push(i.key)
        }
        const values = { title: recipe.title, servings: recipe.servings, minutes: minutesText(recipe.minutes, l) }
        return {
          spoken: missing.length === 0 ? say(texts, l, "recipeSaved", values) : say(texts, l, "recipeSavedMissing", { ...values, list: speakList(missing, l, { max: 4 }) ?? "" })
        }
      })
  })

  const list = makeTool({
    name: "kitchen_recipe_list",
    description: "The names of the household's saved recipes, in alphabetical order.",
    parameters: Schema.Struct({}),
    speculative: true,
    execute: () =>
      Effect.gen(function*() {
        const l = lang()
        const { rows, cut } = yield* byTitle().pipe(Effect.mapError(() => new ToolError({ message: say(texts, l, "recipesUnreadable") })))
        if (rows.length === 0) return { spoken: say(texts, l, "recipesNone") }
        return {
          recipes: rows.slice(0, 10).map((r) => r.value.title),
          more: Math.max(0, rows.length - 10),
          ...(cut ? { cut: say(texts, l, "recipesCut", { count: RECIPE_SCAN }) } : {})
        }
      })
  })

  const get = makeTool({
    name: "kitchen_recipe_get",
    description: "One saved recipe: its ingredients as written, its steps, how many it serves and how long it takes. Read one step at a time when the person is cooking.",
    parameters: Schema.Struct({ name: Line(60, "The recipe's name") }),
    speculative: true,
    execute: ({ name }) =>
      Effect.gen(function*() {
        const l = lang()
        const unreadable = () => new ToolError({ message: say(texts, l, "recipesUnreadable") })
        const found = yield* findRecipe(name).pipe(Effect.mapError(unreadable))
        if (found.row === undefined) return { spoken: unknownRecipe(name, found.suggestion, l) }
        const r = found.row.value
        const words = yield* textStore.get(found.row.id).pipe(Effect.mapError(unreadable))
        return {
          title: r.title,
          serves: r.servings,
          minutes: r.minutes,
          ingredients: words?.value.lines ?? r.ingredients.map((i) => i.key),
          steps: words?.value.steps ?? [],
          source: r.source === "assistant" ? "the assistant's own idea, saved" : "the household's own"
        }
      })
  })

  const forget = makeTool({
    name: "kitchen_recipe_forget",
    description: "Remove a saved recipe from the household's recipe book.",
    parameters: Schema.Struct({ name: Line(60, "The recipe's name, exactly") }),
    risk: "change",
    execute: ({ name }) =>
      Effect.gen(function*() {
        const l = lang()
        const key = keyOf(name)
        const gone = yield* store.transaction((tx) => {
          const [hit] = key === "" ? [] : tx.collection(recipes).list({ where: { titleKey: key }, limit: 1 })
          if (hit === undefined) return undefined
          tx.collection(recipes).remove(hit.id)
          tx.collection(recipeTexts).remove(hit.id)
          return hit.value.title
        }).pipe(Effect.mapError((e) => new ToolError({ message: storeFailureText(e, l, "recipeUnsaved") })))
        if (gone !== undefined) return { spoken: say(texts, l, "recipeForgotten", { title: gone }) }
        const found = yield* findRecipe(name).pipe(Effect.orElseSucceed(() => ({ suggestion: undefined })))
        return { spoken: unknownRecipe(name, found.suggestion, l) }
      })
  })

  // -------------------------------------------------------------------------------------------------------------------
  // What can I make

  interface MakeInput {
    readonly maxMinutes?: number | undefined
    readonly people?: ReadonlyArray<string> | undefined
    readonly everyone?: boolean | undefined
    readonly allowMissing?: number | undefined
  }

  /** The diets that apply: the household's always, and each person's it is for (asked, everyone, or the one asking). */
  const dietsFor = (input: MakeInput, turn: TurnContext | undefined, l: Language) => {
    const people = deps.host.service(People)
    if (people === undefined) return { spoken: say(texts, l, "dietsUnknown") } as const
    const persons: Array<Person> = []
    if (input.everyone === true) persons.push(...people.list())
    for (const spoken of input.people ?? []) {
      const m = people.find(spoken)
      if (m.kind === "none") return { spoken: say(texts, l, "whoIs", { name: spoken }) } as const
      if (m.kind === "ambiguous") return { spoken: say(texts, l, "whichPerson", { name: spoken, list: speakList(m.people.map((p) => p.name), l, { max: 4 }) ?? "" }) } as const
      persons.push(m.person)
    }
    if (input.everyone !== true && (input.people ?? []).length === 0 && turn?.person !== undefined) {
      const me = people.get(turn.person.id)
      if (me !== undefined) persons.push(me)
    }
    const unique = [...new Map(persons.map((p) => [p.id, p])).values()]
    if (unique.length > MAX_PEOPLE && input.everyone !== true) return { spoken: say(texts, l, "tooManyDiets") } as const
    // The strictest reading: the household's diet and every person's own, together (a person's empty part is the
    // household's, `dietOf`). Nothing is dropped to stay within the bound: past it, the question is refused.
    const household: Diet = people.householdDiet() ?? EMPTY_DIET
    const items = (part: keyof Diet): Array<DietItem> => {
      const own = new Set(household[part].map(keyOf))
      return [
        ...household[part].map((text) => ({ text })),
        ...unique.flatMap((p) => people.dietOf(p.id)[part].filter((t) => !own.has(keyOf(t))).map((text) => ({ text, owner: p.id })))
      ]
    }
    const allergies = items("allergies")
    const diets = items("diets")
    const dislikes = items("dislikes")
    if (allergies.length + diets.length + dislikes.length > MAX_DIET_TERMS) return { spoken: say(texts, l, "tooManyDiets") } as const
    return { allergies, diets, dislikes, persons: unique } as const
  }

  const whatCanIMake = (input: MakeInput) =>
    Effect.gen(function*() {
      const l = lang()
      const turn = yield* CurrentTurn
      const unreadable = () => new ToolError({ message: say(texts, l, "recipesUnreadable") })
      const diet = dietsFor(input, turn, l)
      if ("spoken" in diet) return { spoken: diet.spoken }
      const allowMissing = input.allowMissing ?? 1
      const max = input.maxMinutes
      // The pantry, by every name, from one bounded read; then the recipes in order of time, up to the limit.
      const pantry = yield* scan(store.collection(products), { orderBy: { field: "key", direction: "asc" } }, PRODUCT_PAGE, PRODUCT_SCAN).pipe(Effect.mapError(unreadable))
      const byKey = new Map<string, Product>()
      for (const r of pantry.rows) {
        byKey.set(r.value.key, r.value)
        for (const a of r.value.aliases) if (!byKey.has(a)) byKey.set(a, r.value)
      }
      const found = yield* scan(
        recipeStore,
        { orderBy: { field: "minutes", direction: "asc" } },
        RECIPE_PAGE,
        RECIPE_SCAN,
        max === undefined ? undefined : (r) => r.value.minutes > max
      ).pipe(Effect.mapError(unreadable))
      if (found.rows.length === 0) {
        return { spoken: max === undefined ? say(texts, l, "recipesNone") : say(texts, l, "makeNoneWithin", { minutes: minutesText(max, l) }), ...ownIdea(diet, turn, l, pantry.rows.map((r) => r.value)) }
      }
      const assumed = new Set(settings.assumed.map(keyOf))
      // Each allergy's and dislike's words, worked out once for the whole answer.
      const allergies = diet.allergies.map((a) => allergyTest(a.text))
      const dislikes = diet.dislikes.map((d) => allergyTest(d.text))
      let leftOut = 0
      let tooShort = 0
      const fits: Array<{ readonly recipe: Recipe; readonly missing: ReadonlyArray<string>; readonly disliked: number }> = []
      for (const { value: recipe } of found.rows) {
        const keys = [keyOf(recipe.title), ...recipe.allergens, ...recipe.ingredients.map((i) => i.key)]
        if (allergies.some((test) => test(keys)) || diet.diets.some((d) => !dietFits(d.text, recipe.diets))) {
          leftOut++
          continue
        }
        const missing = recipe.ingredients
          .filter((i) => i.optional !== true && !ingredientKeys(i.key).some((k) => assumed.has(k)))
          .filter((i) => !enough(productFor(byKey, i), i))
          .map((i) => productFor(byKey, i)?.name ?? i.key)
        if (missing.length > allowMissing) {
          tooShort++
          continue
        }
        fits.push({ recipe, missing, disliked: dislikes.filter((test) => test(keys)).length })
      }
      fits.sort((a, b) => a.missing.length - b.missing.length || a.disliked - b.disliked || a.recipe.minutes - b.recipe.minutes || a.recipe.titleKey.localeCompare(b.recipe.titleKey))
      const shown = fits.slice(0, SHOWN)
      const notes = {
        ...(leftOut > 0 ? { leftOut: say(texts, l, "leftOut", { count: leftOut }) } : {}),
        ...(tooShort > 0 ? { tooShort: say(texts, l, "tooShort", { count: tooShort }) } : {}),
        ...(found.cut ? { cut: say(texts, l, "recipesCut", { count: RECIPE_SCAN }) } : {}),
        ...(diet.allergies.length > 0 ? { allergyCheck: say(texts, l, "allergyCheck") } : {})
      }
      if (shown.length === 0) {
        return {
          spoken: max === undefined ? say(texts, l, "makeNone") : say(texts, l, "makeNoneWithin", { minutes: minutesText(max, l) }),
          ...notes,
          ...ownIdea(diet, turn, l, pantry.rows.map((r) => r.value))
        }
      }
      return {
        recipes: shown.map((f) => ({ title: f.recipe.title, minutes: f.recipe.minutes, missing: f.missing.slice(0, MISSING_SHOWN) })),
        more: fits.length - shown.length,
        ...notes,
        // Always told how to treat a dish of its own; told what is in the pantry only when few saved recipes fit.
        ...ownIdea(diet, turn, l, shown.length < 2 ? pantry.rows.map((r) => r.value) : [])
      }
    })

  /**
   * When few stored recipes fit, the model may offer a dish of its own: it is told what is in the pantry and the diets
   * to keep to, but a person's diet only where it may be revealed on this device (asked now). Where one may not, it
   * is told not to invent a dish at all, because it could not keep to a diet it is not told.
   */
  const ownIdea = (diet: { readonly allergies: ReadonlyArray<DietItem>; readonly diets: ReadonlyArray<DietItem> }, turn: TurnContext | undefined, l: Language, stock: ReadonlyArray<Product>) => {
    const privacy = deps.host.service(Privacy)
    const items = [...diet.allergies.map((a) => ({ ...a, text: l === "nl" ? `geen ${a.text}` : `no ${a.text}` })), ...diet.diets]
    const hidden = items.some((i) => i.owner !== undefined && privacy?.mayReveal(i.owner, turn) !== true)
    const inStock = stock.filter((p) => p.stock > 0).slice(0, 12).map((p) => p.name)
    if (hidden) return { ownIdea: say(texts, l, "ownIdeaNo") }
    const owner = items.find((i) => i.owner !== undefined)?.owner
    return {
      ...(inStock.length > 0 ? { pantry: inStock } : {}),
      ownIdea: items.length === 0 ? say(texts, l, "ownIdea") : say(texts, l, "ownIdeaAvoid", { list: items.map((i) => i.text).join(", ") }),
      ...(owner !== undefined ? { owner } : {})
    }
  }

  const make = makeTool({
    name: "kitchen_what_can_i_make",
    description:
      "Which saved recipes can be made now with what is in the pantry, within a time limit, keeping strictly to the allergies and diets of the household and of the people it is for (the one asking, unless others are named). Returns the best few with what is missing.",
    parameters: Schema.Struct({
      maxMinutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_440 })).annotate({ description: "Total time it may take, in minutes" })),
      people: Schema.optionalKey(Schema.Array(Line(60, "A person's name")).check(Schema.isMaxLength(MAX_PEOPLE)).annotate({ description: "Who it is for, when named" })),
      everyone: Schema.optionalKey(Schema.Boolean.annotate({ description: "For the whole household" })),
      allowMissing: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })).annotate({ description: "How many ingredients may be missing (default 1)" }))
    }),
    speculative: true,
    // What it returns is household data, except a person's diet passed on for the model's own idea, which names its
    // owner (and is there only where `Privacy.mayReveal` allowed it on this device).
    sensitivity: (result) => {
      const owner = (result as { readonly owner?: string }).owner
      return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
    },
    execute: (input) => whatCanIMake(input)
  })

  /** The same as a typed action, for the things people say most, with a template answer and no model. */
  const makeAction = defineAction({
    id: "what_to_make",
    label: "What can I make",
    description: "Suggest saved recipes that can be made now with what is in the pantry, optionally within a time, keeping to the diets of the household and the one asking.",
    examples: ["what can I make", "what can I cook within 15 minutes", "what can we make for everyone tonight", "wat kan ik maken", "wat kan ik binnen een kwartier koken"],
    params: {
      within: Param.duration({ label: "Time limit", minMs: 60_000, maxMs: 86_400_000, optional: true }),
      everyone: Param.boolean({ label: "For everyone", question: "Is it for the whole household?" })
    },
    offerAsTool: false,
    speculative: true,
    run: ({ within, everyone }) =>
      Effect.gen(function*() {
        const l = lang()
        const result = yield* whatCanIMake({ ...(within !== undefined ? { maxMinutes: Math.max(1, Math.round(within / 60_000)) } : {}), everyone }).pipe(
          Effect.mapError((e) => new ActionError({ message: e.message }))
        )
        if ("spoken" in result && typeof result.spoken === "string") return { say: [result.spoken, "leftOut" in result ? result.leftOut : undefined].filter((s) => s !== undefined).join(" ") }
        const r = result as { readonly recipes: ReadonlyArray<{ readonly title: string; readonly missing: ReadonlyArray<string> }>; readonly leftOut?: string }
        const parts = r.recipes.slice(0, 3).map((x) =>
          x.missing.length === 0 ? say(texts, l, "makeAll", { title: x.title }) : say(texts, l, "makeShort", { title: x.title, missing: speakList(x.missing, l) ?? "" })
        )
        // Each part has a comma of its own ("egg fried rice, with everything in the house"), so they are joined with semicolons.
        const main = say(texts, l, "makeSay", { list: parts.join("; ") })
        return { say: r.leftOut !== undefined ? `${main} ${r.leftOut}` : main }
      })
  })

  return { tools: [save, list, get, forget, make], actions: [makeAction] }
}
