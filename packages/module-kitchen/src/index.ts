import { CurrentJob, defineModule, type ModuleDefinition, Setting } from "@pva/core"
import { Clock, Effect, Schema } from "effect"
import { collections, DATA_VERSION } from "./data.ts"
import { makePantry } from "./pantry.ts"
import { type KitchenSettings, pantryActions, productTools } from "./pantryActions.ts"
import { recipeTools } from "./recipes.ts"
import { tidy } from "./tidy.ts"

export { bookings, forgotten, names, products, recipes, recipeTexts } from "./data.ts"
export { texts } from "./texts.ts"

/**
 * The kitchen (docs/modules/kitchen.md; docs/MODULES-PLAN.md §5.1 row 7, wave A): a pantry ledger whose bookings sum
 * to each product's stock, which is either known or unknown, with a one-step undo; product settings; low stock onto
 * the household's shopping list through the `Lists` service; stored recipes entered by voice, with their allergens
 * declared; and `kitchen_what_can_i_make`, within a time limit and the diets and allergies of the people it is for.
 * Off by default.
 */

export const settings = {
  lowStockToList: Setting.boolean({
    label: "Low stock to the shopping list",
    description: "Put a product on the shopping list when it falls below its minimum, and tick it off when it is back.",
    default: true
  }),
  listWhenOut: Setting.boolean({
    label: "Also when something runs out",
    description: "Put a product on the shopping list when none is left, also when it has no minimum.",
    default: true
  }),
  cup: Setting.choice({
    label: "A cup is",
    options: [{ value: "metric", label: "250 ml (metric)" }, { value: "us", label: "236.6 ml (US)" }],
    default: "metric"
  }),
  assumed: Setting.textList({
    label: "Always in the house",
    description: "Ingredients a recipe never counts as missing.",
    default: ["salt", "pepper", "water", "oil", "zout", "peper", "olie"],
    maxItems: 30,
    itemMaxLength: 40
  }),
  keepDays: Setting.number({
    label: "Keep pantry history for",
    description: "Days each booking is kept on its own; older ones are added up into one each night. The stock stays the same.",
    default: 90,
    integer: true,
    min: 7,
    max: 730,
    unit: "days"
  })
}

/** The nightly job's time: 03:30 in the household's zone. */
export const TIDY_CRON = "30 3 * * *"

const pantryOf = (s: { readonly lowStockToList?: boolean | undefined; readonly listWhenOut?: boolean | undefined; readonly cup?: string | undefined }): KitchenSettings => ({
  lowStockToList: s.lowStockToList ?? true,
  listWhenOut: s.listWhenOut ?? true,
  cup: s.cup === "us" ? "us" : "metric"
})

export const kitchenModule = defineModule({
  apiVersion: 2,
  id: "kitchen",
  name: "Kitchen",
  description: "A pantry ledger, stored recipes, and what you can make with what is in the house.",
  enabledByDefault: false,
  settings,
  storage: { version: DATA_VERSION, collections },
  events: [],
  shared: (ctx) =>
    Effect.gen(function*() {
      yield* ctx.scheduler.handle("tidy", {
        payload: Schema.Struct({}),
        // Folding is a sum kept as one booking, checking is a comparison, forgetting removes what is left, listing uses
        // one key per product, and each product's progress is on its row: running it twice does no harm, so a run cut
        // short is run again and carries on.
        idempotent: true,
        timeoutMs: 120_000,
        run: () =>
          Effect.gen(function*() {
            const job = yield* CurrentJob
            if (job === undefined) return yield* Effect.die(new Error("tidy runs only as a job"))
            const s = ctx.settingsFor(undefined)
            yield* tidy({
              store: ctx.store,
              host: ctx.host,
              settings: { ...pantryOf(s ?? {}), keepDays: s?.keepDays ?? 90 },
              now: yield* Clock.currentTimeMillis,
              actor: { kind: "job", jobId: job.jobId }
            })
          })
      }).pipe(Effect.orDie)
      // Scheduled once and kept: scheduling the key again at every start would replace a run that is due after an
      // outage before it ran. The kitchen has no other job, so its one page of live jobs holds it if it is there.
      const live = yield* ctx.scheduler.list().pipe(Effect.orDie)
      if (!live.some((j) => j.key === "tidy" && j.cron === TIDY_CRON)) yield* ctx.scheduler.schedule({ handler: "tidy", key: "tidy", cron: TIDY_CRON }).pipe(Effect.orDie)
      const pantry = makePantry({ store: ctx.store, host: ctx.host })
      return { value: pantry }
    }),
  start: (ctx) =>
    Effect.sync(() => {
      const s = pantryOf(ctx.settings)
      const deps = { host: ctx.host, store: ctx.store, pantry: ctx.shared, settings: s }
      const recipe = recipeTools({ host: ctx.host, store: ctx.store, settings: { cup: s.cup, assumed: ctx.settings.assumed ?? [] } })
      return {
        tools: [...productTools(deps), ...recipe.tools],
        actions: [...pantryActions(deps), ...recipe.actions],
        instructions:
          "The kitchen tools keep the household's pantry and recipes. Use kitchen_stock_add only when someone bought or put away food (a bare \"add milk\" is the shopping list), kitchen_stock_use when they used some, and kitchen_undo to take the last change back; never guess what is in the pantry, ask the tools. Say amounts with their units, and when the tools say an amount is not known, say so. Never fill in a recipe's allergens yourself: ask. When you suggest a dish that is not a saved recipe, or a saved recipe whose source is the assistant, say it is your own idea, and keep strictly to the allergies and diets the tools give."
      }
    })
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [kitchenModule]
