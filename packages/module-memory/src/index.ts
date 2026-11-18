import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Remembers facts and notes you tell it, recalls them, and forgets them for good.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 13, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/memory.md and docs/research/modules/memory-and-notes.md.
 */
export const memoryModule = defineModule({
  apiVersion: 2,
  id: "memory",
  name: "Memory and notes",
  description: "Remembers facts and notes you tell it, recalls them, and forgets them for good.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [memoryModule]
