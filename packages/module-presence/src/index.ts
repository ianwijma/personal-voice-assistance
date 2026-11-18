import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Who is home, and who has just arrived or left, from Home Assistant's people.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 19, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/presence.md and docs/research/modules/presence-and-people.md.
 */
export const presenceModule = defineModule({
  apiVersion: 2,
  id: "presence",
  name: "Presence",
  description: "Who is home, and who has just arrived or left, from Home Assistant's people.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [presenceModule]
