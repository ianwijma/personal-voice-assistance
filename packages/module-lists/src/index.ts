import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Shopping and to-do lists: add, read, tick off and remove items.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 5, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/lists.md and docs/research/modules/lists.md.
 */
export const listsModule = defineModule({
  apiVersion: 2,
  id: "lists",
  name: "Lists",
  description: "Shopping and to-do lists: add, read, tick off and remove items.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [listsModule]
