import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Routines and quick commands the owner defines, started by a phrase.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 21, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/routines.md and docs/research/modules/routines-and-automations.md.
 */
export const routinesModule = defineModule({
  apiVersion: 2,
  id: "routines",
  name: "Routines",
  description: "Routines and quick commands the owner defines, started by a phrase.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [routinesModule]
