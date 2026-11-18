import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Which bin goes out next, from the collection calendar's ICS link.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 18, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/bin-day.md and docs/research/modules/local-info.md.
 */
export const binDayModule = defineModule({
  apiVersion: 2,
  id: "bin-day",
  name: "Bin day",
  description: "Which bin goes out next, from the collection calendar's ICS link.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [binDayModule]
