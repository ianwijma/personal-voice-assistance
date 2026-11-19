// Stored recipes, entered by voice (the model structures what the person dictates), and "what can I make": the stored
// recipes that fit a time limit, the diets and allergies of the people it is for, and what is in the pantry.
//
// Allergies are safe by construction (docs/modules/kitchen.md, "Allergies"): for a request where anyone it is for has
// an allergy, a recipe is suggested only if its allergens were declared complete when it was saved and contain none
// of those people's allergens; on top of that, never instead of it, it is left out when any name of such an allergen
// is found in its title or its ingredient lines as said. An allergy outside the fixed vocabulary cannot be checked:
// then nothing is suggested.
import {
  ActionError, CurrentTurn, defineAction, type Diet, EMPTY_DIET, makeTool, type ModuleHostApi, type ModuleStore, Param, People, type Person, Privacy,
  type Row, ToolError, type TurnContext
} from "@pva/core"
import { type Language, metricCupMl, speakDuration, speakList, usCupMl } from "@pva/language"
import { homeLanguage, isLine, say } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import Fuse from "fuse.js"
import { randomUUID } from "node:crypto"
import { type AllergenId, allergenName, allergenNames, allergensOf, anyMentioned, saysNone } from "./allergens.ts"
import { type Ingredient, MAX_INGREDIENTS, names, type Product, products, type Recipe, recipes, recipeTexts, scan } from "./data.ts"
import { PRODUCT_PAGE, PRODUCT_SCAN, round, storeFailureText } from "./pantry.ts"
import { texts } from "./texts.ts"
import { dietFits, dietKey, dislikeText, ingredientKeys, keyOf, readPhrase } from "./words.ts"

/** The most recipes one answer reads: 20 pages of 5 (a recipe row is up to 5,000 characters). */
export const RECIPE_SCAN = 100
const RECIPE_PAGE = 5
/** How many recipes an answer names, and how many missing things per recipe. */
export const SHOWN = 5
const MISSING_SHOWN = 3
/** The most people one "what can I make" is for, and the most distinct diet words it checks (a bound on the work). */
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
  // "salt, pepper and oil" is three: every one is kept (a save that gives more than a recipe holds is refused, never cut).
  if (r.kind === "several") return text.split(/\s*(?:,|\band\b|\ben\b|&|\bplus\b)\s*/iu).map(keyOf).filter((k) => k !== "").map((key) => ({ key, ...mark }))
  const key = keyOf(text.replace(/\d+(?:[.,]\d+)?/gu, ""))
  return key === "" ? [] : [{ key, ...mark }]
}

/** Which product an ingredient is: by its key or an alias, then without preparation words ("cooked rice" is rice). */
const productFor = (byKey: ReadonlyMap<string, Row<Product>>, ingredient: Ingredient): Row<Product> | undefined => {
  for (const k of ingredientKeys(ingredient.key)) {
    const p = byKey.get(k)
    if (p !== undefined) return p
  }
  return undefined
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
  const minutesText = (ms: number, l: Language) => speakDuration(ms, l) ?? `${Math.round(ms / 60_000)} min`

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

  const fourteen = (l: Language) => speakList(allergenNames(l), l, { max: 14 }) ?? allergenNames(l).join(", ")

  const save = makeTool({
    name: "kitchen_recipe_save",
    description:
      "Save a recipe the person dictates, or one of your own ideas they want kept, in the household's recipe book. Give each ingredient as one line with its amount (\"300 g cooked rice\", \"2 eggs\", \"salt to taste\"), the steps one per line, and the diets it suits (vegetarian, vegan, gluten free…). Allergens: pass `allergens` only when the person said which of the fourteen major allergens it contains (cereals containing gluten, crustaceans, eggs, fish, peanuts, soybeans, milk, tree nuts, celery, mustard, sesame, sulphites, lupin, molluscs), or that it contains none of them (then an empty list or \"none\"). When they did not say, ask them first, naming the fourteen; never fill it in yourself. A recipe saved without it is never suggested to anyone with an allergy.",
    parameters: Schema.Struct({
      title: Line(60, "The recipe's name"),
      servings: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({ description: "How many people it serves" }),
      minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_440 })).annotate({ description: "Total time in minutes, preparation included" }),
      ingredients: Schema.Array(Line(80, "One ingredient with its amount")).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
      steps: Schema.Array(Line(250, "One step")).check(Schema.isMaxLength(20)),
      allergens: Schema.optionalKey(
        Schema.Array(Line(40, "One of the fourteen major allergens, or \"none\"")).check(Schema.isMaxLength(14)).annotate({
          description: "The major allergens it contains, as the person stated them; [] or [\"none\"] when they said none. Leave out when they did not say."
        })
      ),
      diets: Schema.optionalKey(Schema.Array(Line(30, "A diet it suits")).check(Schema.isMaxLength(6))),
      source: Schema.Literals(["own", "assistant"]).annotate({ description: "own: the person's recipe; assistant: your own idea, saved because they asked" })
    }),
    risk: "change",
    execute: (input) =>
      Effect.gen(function*() {
        const l = lang()
        const titleKey = keyOf(input.title)
        if (titleKey === "") return { spoken: say(texts, l, "unclear") }
        // Every ingredient a line gives is kept: a recipe with more than it holds is refused, never cut.
        const ingredients = input.ingredients.flatMap((line) => parseIngredient(line, l, cupMl))
        if (ingredients.length === 0) return { spoken: say(texts, l, "unclear") }
        if (ingredients.length > MAX_INGREDIENTS) return { spoken: say(texts, l, "tooManyIngredients", { count: MAX_INGREDIENTS }) }
        // The declaration: only what the caller stated, each from the vocabulary. A word outside it is a question.
        const declared: Array<AllergenId> = []
        if (input.allergens !== undefined) {
          for (const label of input.allergens) {
            if (saysNone(label)) continue
            const ids = allergensOf(label)
            if (ids === undefined) return { spoken: say(texts, l, "allergenUnknown", { allergen: label, list: fourteen(l) }) }
            declared.push(...ids)
          }
        }
        const recipe: Recipe = {
          title: input.title.trim(),
          titleKey,
          servings: input.servings,
          minutes: input.minutes,
          ingredients,
          allergens: [...new Set(declared)],
          declared: input.allergens !== undefined,
          diets: [...new Set((input.diets ?? []).map(dietKey).filter((d) => d !== ""))].slice(0, 6),
          source: input.source
        }
        const failed = (e: unknown) => new ToolError({ message: storeFailureText(e, l, "recipeUnsaved") })
        const saved = yield* store.transaction((tx) => {
          if (tx.collection(recipes).list({ where: { titleKey }, limit: 1 }).length > 0) return false
          const id = randomUUID()
          tx.collection(recipes).insert(recipe, { id })
          // The lines whole, as said: the allergy check reads them.
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
        const values = { title: recipe.title, servings: recipe.servings, minutes: minutesText(recipe.minutes * 60_000, l) }
        const main = missing.length === 0 ? say(texts, l, "recipeSaved", values) : say(texts, l, "recipeSavedMissing", { ...values, list: speakList(missing, l, { max: 4 }) ?? "" })
        return { spoken: recipe.declared ? main : `${main} ${say(texts, l, "recipeUndeclared")}` }
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
          allergens: r.declared ? (r.allergens.length === 0 ? say(texts, l, "allergensNone") : speakList(r.allergens.map((a) => allergenName(a, l)), l, { max: 14 }) ?? "") : say(texts, l, "allergensUnstated"),
          source: r.source === "assistant" ? say(texts, l, "sourceAssistant") : say(texts, l, "sourceOwn")
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
    /** The time limit as given, in milliseconds: a recipe fits when its minutes are within it, never rounded. */
    readonly withinMs?: number | undefined
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

  /** What one requirement of a recipe comes to against the pantry. */
  type Need = "enough" | "missing" | "maybe"

  /**
   * What a recipe needs that the pantry does not certainly have: its requirements added up per product first (two
   * lines of 200 g rice need 400 g), then compared with the stock. A requirement that cannot be compared (cups
   * against grams, pieces against grams, packages of an unknown size), a stock that is not known, or a product the
   * bounded pantry read did not reach, is "may be missing", never "enough".
   */
  const needsOf = (recipe: Recipe, byKey: ReadonlyMap<string, Row<Product>>, assumed: ReadonlySet<string>, pantryCut: boolean) => {
    const groups = new Map<string, { readonly product: Row<Product> | undefined; readonly label: string; amount: number; comparable: boolean }>()
    for (const i of recipe.ingredients) {
      if (i.optional === true || ingredientKeys(i.key).some((k) => assumed.has(k))) continue
      const row = productFor(byKey, i)
      const id = row === undefined ? `ingredient:${i.key}` : row.id
      const g = groups.get(id) ?? { product: row, label: row?.value.name ?? i.key, amount: 0, comparable: true }
      const p = row?.value
      if (i.amount !== undefined && i.unit !== undefined) {
        if (p !== undefined && p.unit === i.unit) g.amount = round(g.amount + i.amount)
        else g.comparable = false
      } else if (i.packs !== undefined) {
        if (p?.pack !== undefined) g.amount = round(g.amount + i.packs * p.pack)
        else g.comparable = false
      }
      groups.set(id, g)
    }
    const missing: Array<string> = []
    const maybe: Array<string> = []
    for (const g of groups.values()) {
      const p = g.product?.value
      const need: Need = p === undefined
        ? (pantryCut ? "maybe" : "missing")
        : p.unknown
        ? "maybe"
        : p.stock <= 0
        ? "missing"
        : !g.comparable
        ? "maybe"
        : g.amount > p.stock
        ? "missing"
        : "enough"
      if (need === "missing") missing.push(g.label)
      if (need === "maybe") maybe.push(g.label)
    }
    return { missing, maybe }
  }

  /**
   * The allergy check of one recipe, for allergens that could all be mapped: declared complete, none of them declared,
   * and no name of any of them in its title or any of its ingredient lines (read whole from its text row; a recipe
   * whose lines cannot be read is left out). Matching only ever leaves a recipe out.
   */
  const allergySafe = (row: Row<Recipe>, ids: ReadonlyArray<AllergenId>) =>
    Effect.gen(function*() {
      const recipe = row.value
      if (!recipe.declared) return "undeclared" as const
      if (recipe.allergens.some((a) => ids.includes(a))) return "contains" as const
      const words = yield* textStore.get(row.id)
      if (words === undefined) return "contains" as const
      return anyMentioned(ids, [recipe.title, ...words.value.lines]) ? "contains" as const : "safe" as const
    })

  const whatCanIMake = (input: MakeInput) =>
    Effect.gen(function*() {
      const l = lang()
      const turn = yield* CurrentTurn
      const unreadable = () => new ToolError({ message: say(texts, l, "recipesUnreadable") })
      const diet = dietsFor(input, turn, l)
      if ("spoken" in diet) return { spoken: diet.spoken }
      const privacy = deps.host.service(Privacy)
      const allergic = diet.allergies.length > 0
      // Every answer for someone with an allergy ends with this sentence (the last field of the result).
      const closing = allergic ? { allergyCheck: say(texts, l, "allergyCheck") } : {}

      // Each allergy mapped onto the vocabulary. One that maps to nothing cannot be checked: nothing is suggested.
      const ids = new Set<AllergenId>()
      for (const a of diet.allergies) {
        const mapped = allergensOf(a.text)
        if (mapped === undefined) {
          const named = a.owner === undefined || privacy?.mayReveal(a.owner, turn) === true
          return {
            spoken: named ? say(texts, l, "cannotCheck", { allergy: a.text }) : say(texts, l, "cannotCheckUnnamed"),
            ownIdea: say(texts, l, "ownIdeaCannotCheck"),
            ...closing
          }
        }
        for (const id of mapped) ids.add(id)
      }
      const allergens = [...ids]

      const allowMissing = input.allowMissing ?? 1
      const within = input.withinMs
      // The pantry, by every name, from one bounded read; then the recipes in order of time, up to the limit.
      const pantry = yield* scan(store.collection(products), { orderBy: { field: "key", direction: "asc" } }, PRODUCT_PAGE, PRODUCT_SCAN).pipe(Effect.mapError(unreadable))
      const byKey = new Map<string, Row<Product>>()
      for (const r of pantry.rows) {
        byKey.set(r.value.key, r)
        for (const a of r.value.aliases) if (!byKey.has(a)) byKey.set(a, r)
      }
      const found = yield* scan(
        recipeStore,
        { orderBy: { field: "minutes", direction: "asc" } },
        RECIPE_PAGE,
        RECIPE_SCAN,
        within === undefined ? undefined : (r) => r.value.minutes * 60_000 > within
      ).pipe(Effect.mapError(unreadable))
      const stock = pantry.rows.map((r) => r.value)
      const pantryNote = pantry.cut ? { pantryCut: say(texts, l, "makePantryCut", { count: PRODUCT_SCAN }) } : {}
      if (found.rows.length === 0) {
        return {
          spoken: within === undefined ? say(texts, l, "recipesNone") : say(texts, l, "makeNoneWithin", { minutes: minutesText(within, l) }),
          ...ownIdea(diet, turn, l, stock),
          ...closing
        }
      }
      const assumed = new Set(settings.assumed.map(keyOf))
      const dislikes = [...new Set(diet.dislikes.map((d) => dislikeText(d.text)).filter((d) => d !== ""))]
      let leftOut = 0
      let undeclared = 0
      let tooShort = 0
      const fits: Array<{ readonly recipe: Recipe; readonly missing: ReadonlyArray<string>; readonly maybe: ReadonlyArray<string>; readonly disliked: number }> = []
      for (const row of found.rows) {
        // One recipe at a time, with the event loop free between them (it frames every device's audio).
        yield* Effect.yieldNow
        const recipe = row.value
        if (allergic) {
          const verdict = yield* allergySafe(row, allergens).pipe(Effect.mapError(unreadable))
          if (verdict === "undeclared") {
            undeclared++
            continue
          }
          if (verdict === "contains") {
            leftOut++
            continue
          }
        }
        if (diet.diets.some((d) => !dietFits(d.text, recipe.diets))) {
          leftOut++
          continue
        }
        const { missing, maybe } = needsOf(recipe, byKey, assumed, pantry.cut)
        if (missing.length + maybe.length > allowMissing) {
          tooShort++
          continue
        }
        const keys = [keyOf(recipe.title), ...recipe.ingredients.map((i) => i.key)].join(" ")
        fits.push({ recipe, missing, maybe, disliked: dislikes.filter((d) => keys.includes(d)).length })
      }
      fits.sort((a, b) =>
        a.missing.length + a.maybe.length - (b.missing.length + b.maybe.length) || a.disliked - b.disliked || a.recipe.minutes - b.recipe.minutes ||
        a.recipe.titleKey.localeCompare(b.recipe.titleKey)
      )
      const shown = fits.slice(0, SHOWN)
      const notes = {
        ...(undeclared > 0 ? { undeclared: say(texts, l, "undeclared", { count: undeclared }) } : {}),
        ...(leftOut > 0 ? { leftOut: say(texts, l, "leftOut", { count: leftOut }) } : {}),
        ...(tooShort > 0 ? { tooShort: say(texts, l, "tooShort", { count: tooShort }) } : {}),
        // A bounded read that was cut is always said, and the counts above are of the recipes read.
        ...(found.cut ? { cut: say(texts, l, "makeCut", { count: RECIPE_SCAN }) } : {}),
        ...pantryNote
      }
      if (shown.length === 0) {
        const none = found.cut
          ? say(texts, l, "makeNoneCut", { count: RECIPE_SCAN })
          : within === undefined
          ? say(texts, l, "makeNone")
          : say(texts, l, "makeNoneWithin", { minutes: minutesText(within, l) })
        return { spoken: none, ...notes, ...ownIdea(diet, turn, l, stock), ...closing }
      }
      return {
        recipes: shown.map((f) => ({
          title: f.recipe.title,
          minutes: f.recipe.minutes,
          missing: f.missing.slice(0, MISSING_SHOWN),
          mayBeMissing: f.maybe.slice(0, MISSING_SHOWN),
          // Where it came from: a person's own, or the assistant's idea that was saved.
          source: f.recipe.source
        })),
        more: fits.length - shown.length,
        ...notes,
        // Always told how to treat a dish of its own; told what is in the pantry only when few saved recipes fit.
        ...ownIdea(diet, turn, l, shown.length < 2 ? stock : []),
        ...closing
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
    const inStock = stock.filter((p) => p.stock > 0 && !p.unknown).slice(0, 12).map((p) => p.name)
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
      "Which saved recipes can be made now with what is in the pantry, within a time limit, keeping strictly to the allergies and diets of the household and of the people it is for (the one asking, unless others are named). Returns the best few with what is missing and what may be missing. A recipe whose source is \"assistant\" was your own idea, saved: say so when you suggest it. Pass on every note it gives, the allergy sentence last.",
    parameters: Schema.Struct({
      maxMinutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_440 })).annotate({ description: "Total time it may take, in minutes" })),
      people: Schema.optionalKey(Schema.Array(Line(60, "A person's name")).check(Schema.isMaxLength(MAX_PEOPLE)).annotate({ description: "Who it is for, when named" })),
      everyone: Schema.optionalKey(Schema.Boolean.annotate({ description: "For the whole household" })),
      allowMissing: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })).annotate({ description: "How many ingredients may be missing or possibly missing (default 1)" }))
    }),
    speculative: true,
    // What it returns is household data, except a person's diet passed on for the model's own idea, which names its
    // owner (and is there only where `Privacy.mayReveal` allowed it on this device).
    sensitivity: (result) => {
      const owner = (result as { readonly owner?: string }).owner
      return owner === undefined ? { kind: "household" } : { kind: "personal", owner }
    },
    execute: (input) =>
      whatCanIMake({
        ...(input.maxMinutes !== undefined ? { withinMs: input.maxMinutes * 60_000 } : {}),
        ...(input.people !== undefined ? { people: input.people } : {}),
        ...(input.everyone !== undefined ? { everyone: input.everyone } : {}),
        ...(input.allowMissing !== undefined ? { allowMissing: input.allowMissing } : {})
      })
  })

  /** A suggestion as the typed answer says it: what is short and what may be, and whose idea it was. */
  const suggestionText = (x: { readonly title: string; readonly missing: ReadonlyArray<string>; readonly mayBeMissing: ReadonlyArray<string>; readonly source: "own" | "assistant" }, l: Language) => {
    const title = x.source === "assistant" ? say(texts, l, "assistantTitle", { title: x.title }) : x.title
    const missing = speakList(x.missing, l) ?? ""
    const maybe = speakList(x.mayBeMissing, l) ?? ""
    if (x.missing.length === 0 && x.mayBeMissing.length === 0) return say(texts, l, "makeAll", { title })
    if (x.mayBeMissing.length === 0) return say(texts, l, "makeShort", { title, missing })
    if (x.missing.length === 0) return say(texts, l, "makeMaybe", { title, maybe })
    return say(texts, l, "makeShortMaybe", { title, missing, maybe })
  }

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
        const result: Readonly<Record<string, unknown>> = yield* whatCanIMake({ ...(within !== undefined ? { withinMs: within } : {}), everyone }).pipe(
          Effect.mapError((e) => new ActionError({ message: e.message }))
        )
        // Every note the answer has, in order, and the allergy sentence last: a cut read is always said.
        const notes = ["cut", "pantryCut", "undeclared", "leftOut", "tooShort"].flatMap((k) => (typeof result[k] === "string" ? [result[k] as string] : []))
        const closing = typeof result.allergyCheck === "string" ? [result.allergyCheck] : []
        const recipesFound = result.recipes as ReadonlyArray<Parameters<typeof suggestionText>[0]> | undefined
        const main = recipesFound === undefined
          ? String(result.spoken ?? "")
          // Each part has a comma of its own ("egg fried rice, with everything in the house"), so they are joined with semicolons.
          : say(texts, l, "makeSay", { list: recipesFound.slice(0, 3).map((x) => suggestionText(x, l)).join("; ") })
        return { say: [main, ...notes, ...closing].join(" ") }
      })
  })

  return { tools: [save, list, get, forget, make], actions: [makeAction] }
}
