import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Plays and controls music per room through Music Assistant in Home Assistant.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 8, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/music.md and docs/research/modules/music.md.
 */
export const musicModule = defineModule({
  apiVersion: 2,
  id: "music",
  name: "Music",
  description: "Plays and controls music per room through Music Assistant in Home Assistant.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [musicModule]
