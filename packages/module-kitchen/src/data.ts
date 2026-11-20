// What the kitchen stores (docs/modules/kitchen.md, "What it stores"). Everything is household data: the pantry, its
// ledger and the recipes are the household's, and nothing here is about one person (diets live in the core's People).
import { type CollectionHandle, defineCollection, type ListQuery, type Row } from "@pva/core"
import { isLine, StoredText } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { ALLERGENS, Allergen, allergensOf } from "./allergens.ts"
import { KEY_CHARS, keyOf } from "./words.ts"

/** The largest amount kept, in grams, millilitres or pieces (a tonne): bounds every amount and every sum. */
export const MAX_AMOUNT = 1_000_000

const oneLine = (max: number) => StoredText(max).check(Schema.makeFilter((t: string) => isLine(t, max) || "one line, without line breaks"))

/** An id this module makes (`randomUUID`, 36 characters). */
const Id = StoredText(40)
const Key = StoredText(KEY_CHARS)
const Amount = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_AMOUNT }))
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))

/** What a product's stock is counted in. */
export const BaseUnit = Schema.Literals(["g", "ml", "piece"])
export type BaseUnit = typeof BaseUnit.Type

/** The data version of the kitchen's collections (`storage.version`); version 1 is migrated by the functions below. */
export const DATA_VERSION = 2

/**
 * One product of the pantry. `stock` is the sum of the product's bookings (the ledger, `bookings`): written in the same
 * transaction as each booking, so a read is one row, and checked against the ledger by the nightly job.
 */
export const Product = Schema.Struct({
  /** As it was first said: "rice", "tinned tomatoes". */
  name: oneLine(KEY_CHARS),
  /** `keyOf(name)`; indexed, so the overview reads in name order. */
  key: Key,
  unit: BaseUnit,
  /** The amount on record. While `unknown`, only the last known amount: never said as what there is now. */
  stock: Amount,
  /** An approximate booking ("some", "about", a package of unknown size) left the stock unknown until it is set exactly. */
  unknown: Schema.Boolean,
  /** Below its minimum, or none left on record: indexed with `key`, so "what are we low on" is one index range. */
  low: Schema.Boolean,
  /** Keep at least this much (base unit): below it, the product goes on the shopping list. */
  min: Schema.optionalKey(Amount),
  /** How much one package holds (base unit), exactly: "two bags of rice" is twice this. An approximate size is not stored. */
  pack: Schema.optionalKey(Amount.check(Schema.isGreaterThan(0))),
  /** Other names the product answers to ("rijst"), each also in `names`. */
  aliases: Schema.Array(Key).check(Schema.isMaxLength(6)),
  /** When the nightly job last folded and checked its ledger, and last brought its shopping-list item into line (epoch ms; 0: never). */
  tidiedAt: Time,
  listedAt: Time
})
export type Product = typeof Product.Type

export const products = defineCollection({
  name: "products",
  scope: "household",
  schema: Product,
  maxChars: 1_000,
  // `tidiedAt` and `listedAt`: the nightly job takes the products it saw longest ago first, so a bounded night
  // carries on where the last one stopped and every product is reached.
  indexes: ["key", ["low", "key"], "tidiedAt", "listedAt"],
  migrate: {
    1: (old: { readonly key: string; readonly aliases: ReadonlyArray<string>; readonly approx: boolean; readonly uncertain: boolean }) => {
      const { approx, uncertain, ...rest } = old
      return { ...rest, key: keyOf(old.key), aliases: [...new Set(old.aliases.map(keyOf))], unknown: approx || uncertain, tidiedAt: 0, listedAt: 0 }
    }
  }
})

/** A name or an alias of a product: one row per key, so a product is found by one indexed read. */
export const Name = Schema.Struct({ key: Key, product: Id })
export type Name = typeof Name.Type

export const names = defineCollection({
  name: "names",
  scope: "household",
  schema: Name,
  maxChars: 300,
  indexes: ["key", "product"],
  migrate: { 1: (old: { readonly key: string; readonly product: string }) => ({ ...old, key: keyOf(old.key) }) }
})

/** What a booking did. `carry` is the nightly job's: the sum of older bookings it folded into one. */
export const BookingKind = Schema.Literals(["add", "use", "set", "undo", "carry"])
export type BookingKind = typeof BookingKind.Type

/** One booking of the ledger: a change of one product's stock. The stock is the sum of its bookings' deltas. */
export const Booking = Schema.Struct({
  product: Id,
  kind: BookingKind,
  /** The change, in the product's unit, exactly as it was made: never one that takes the stock below 0 or above the bound. */
  delta: Schema.Finite.check(Schema.isBetween({ minimum: -MAX_AMOUNT, maximum: MAX_AMOUNT })),
  /** The amount said was "about", there was none ("some"), or a package of unknown size: it left the stock unknown. */
  approx: Schema.Boolean,
  /** Whether the product's stock was unknown before this booking, so an undo puts it back exactly. */
  unknownBefore: Schema.Boolean,
  /** The words of the amount as said ("about 250 grams"). */
  said: Schema.optionalKey(oneLine(80)),
  at: Time,
  /** The device it was said on (a device id): an undo reverses that device's own last booking. */
  device: Schema.optionalKey(StoredText(64))
})
export type Booking = typeof Booking.Type

export const bookings = defineCollection({
  name: "bookings",
  scope: "household",
  schema: Booking,
  maxChars: 800,
  indexes: [["product", "at"], ["device", "at"]],
  migrate: {
    1: (old: { readonly approx: boolean; readonly uncertain?: boolean; readonly approxBefore: boolean; readonly uncertainBefore: boolean; readonly undoes?: string }) => {
      const { uncertain, approxBefore, uncertainBefore, undoes: _undoes, ...rest } = old
      return { ...rest, approx: old.approx || uncertain === true, unknownBefore: approxBefore || uncertainBefore }
    }
  }
})

/** A product forgotten whose bookings are not all removed yet: the forget goes on in steps, and the nightly job finishes it. */
export const Forgotten = Schema.Struct({ product: Id })
export const forgotten = defineCollection({ name: "forgotten", scope: "household", schema: Forgotten, maxChars: 200 })

/** One ingredient as pantry matching uses it: the key it is found by, and how much in base units when that was said. */
export const Ingredient = Schema.Struct({
  key: Key,
  amount: Schema.optionalKey(Amount),
  unit: Schema.optionalKey(BaseUnit),
  /** Optional or "to taste": never counted as missing. */
  optional: Schema.optionalKey(Schema.Boolean),
  /** Said in packages ("a tin of tomatoes"): the product's package size decides. */
  packs: Schema.optionalKey(Amount)
})
export type Ingredient = typeof Ingredient.Type

/** The most ingredients a recipe's lines may give; a save that gives more is refused, never cut. */
export const MAX_INGREDIENTS = 20

/** A stored recipe, as matching reads it; its lines and steps are in `recipeTexts`, under the same id. */
export const Recipe = Schema.Struct({
  title: oneLine(60),
  /** `keyOf(title)`; indexed, so a recipe is found by its name and two never share one. */
  titleKey: StoredText(60),
  servings: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  /** Total time in minutes; indexed, so "within 15 minutes" reads only the recipes that fit. */
  minutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_440 })),
  ingredients: Schema.Array(Ingredient).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_INGREDIENTS)),
  /** The allergens of the fixed vocabulary it contains, as stated when it was saved. */
  allergens: Schema.Array(Allergen).check(Schema.isMaxLength(ALLERGENS.length)),
  /**
   * Whether `allergens` was stated (a person said which of the fourteen it contains, or "none"). Without it, the recipe
   * is never suggested to anyone with an allergy.
   */
  declared: Schema.Boolean,
  /** The diets it suits (`dietKey`), as declared. A diet not declared is not assumed. */
  diets: Schema.Array(StoredText(30)).check(Schema.isMaxLength(6)),
  /** Dictated by a person, or the assistant's own idea saved on request. */
  source: Schema.Literals(["own", "assistant"])
})
export type Recipe = typeof Recipe.Type

export const recipes = defineCollection({
  name: "recipes",
  scope: "household",
  schema: Recipe,
  maxChars: 5_000,
  indexes: ["titleKey", "minutes"],
  migrate: {
    // Version 1's allergens were "as far as the model could tell": kept where they name the vocabulary, but never a
    // complete declaration.
    1: (old: { readonly titleKey: string; readonly allergens: ReadonlyArray<string>; readonly ingredients: ReadonlyArray<{ readonly key: string }> }) => ({
      ...old,
      titleKey: keyOf(old.titleKey) || old.titleKey,
      ingredients: old.ingredients.map((i) => ({ ...i, key: keyOf(i.key) || i.key })),
      allergens: [...new Set(old.allergens.flatMap((a) => allergensOf(a) ?? []))],
      declared: false
    })
  }
})

/**
 * A recipe's words: the ingredient lines exactly as said (whole: the allergy check reads them) and the steps. Read
 * when one recipe is asked for, and for each recipe an allergy check considers.
 */
export const RecipeText = Schema.Struct({
  lines: Schema.Array(oneLine(80)).check(Schema.isMaxLength(20)),
  steps: Schema.Array(oneLine(250)).check(Schema.isMaxLength(20))
})
export type RecipeText = typeof RecipeText.Type

export const recipeTexts = defineCollection({ name: "recipe_texts", scope: "household", schema: RecipeText, maxChars: 14_000 })

export const collections = [products, names, bookings, forgotten, recipes, recipeTexts]

// ---------------------------------------------------------------------------------------------------------------------
// Bounded reads

/**
 * Rows of one list query, page by page (`after` continues it), at most `max`, and whether there were more: a turn
 * never reads further, and a partial read is never called "everything". `stop` ends the read early at a row that
 * shows the rest is not wanted (a recipe past the time limit, in order of time). `max` is a whole number of pages.
 */
export const scan = <A>(
  handle: Pick<CollectionHandle<A>, "list">,
  query: Omit<ListQuery<A>, "limit" | "after">,
  page: number,
  max: number,
  stop?: (row: Row<A>) => boolean
) =>
  Effect.gen(function*() {
    const rows: Array<Row<A>> = []
    let after: Row<A> | undefined
    for (let n = 0; n < Math.ceil(max / page); n++) {
      const got = yield* handle.list({ ...query, limit: page, ...(after !== undefined ? { after } : {}) })
      for (const row of got) {
        if (stop?.(row) === true) return { rows, cut: false }
        rows.push(row)
      }
      if (got.length < page) return { rows, cut: false }
      after = got.at(-1)
      // Between pages the event loop runs (it frames every device's audio): a scan holds it one page at a time.
      yield* Effect.yieldNow
    }
    const beyond = yield* handle.list({ ...query, limit: 1, ...(after !== undefined ? { after } : {}) })
    return { rows, cut: beyond.length > 0 && stop?.(beyond[0]!) !== true }
  })
