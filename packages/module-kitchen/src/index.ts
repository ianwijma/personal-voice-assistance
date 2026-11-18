import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * A pantry ledger, stored recipes, and what you can make with what is in the house.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 7, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/kitchen.md and docs/research/modules/kitchen.md.
 */
export const kitchenModule = defineModule({
  apiVersion: 2,
  id: "kitchen",
  name: "Kitchen",
  description: "A pantry ledger, stored recipes, and what you can make with what is in the house.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [kitchenModule]
