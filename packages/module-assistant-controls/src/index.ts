import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Stop, repeat, volume, a new conversation, switching assistant and sleep, by voice.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 1, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/assistant-controls.md and docs/research/modules/assistant-controls.md.
 */
export const assistantControlsModule = defineModule({
  apiVersion: 2,
  id: "assistant-controls",
  name: "Assistant controls",
  description: "Stop, repeat, volume, a new conversation, switching assistant and sleep, by voice.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [assistantControlsModule]
