import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Announces a message on every device or in one room, with a chime.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 16, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/broadcast.md and docs/research/modules/broadcast.md.
 */
export const broadcastModule = defineModule({
  apiVersion: 2,
  id: "broadcast",
  name: "Broadcast",
  description: "Announces a message on every device or in one room, with a chime.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [broadcastModule]
