import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Reminders at a time or repeating, for the household or for one person.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 10, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/reminders.md and docs/research/modules/reminders.md.
 */
export const remindersModule = defineModule({
  apiVersion: 2,
  id: "reminders",
  name: "Reminders",
  description: "Reminders at a time or repeating, for the household or for one person.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [remindersModule]
