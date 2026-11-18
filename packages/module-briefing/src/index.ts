import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * A short spoken briefing from the modules the assistant has on.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 17, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/briefing.md and docs/research/modules/briefing.md.
 */
export const briefingModule = defineModule({
  apiVersion: 2,
  id: "briefing",
  name: "Briefing",
  description: "A short spoken briefing from the modules the assistant has on.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [briefingModule]
