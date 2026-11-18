import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Searches the web through SearXNG or Brave and reads a page in short.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 4, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/web-search.md and docs/research/modules/web-search.md.
 */
export const webSearchModule = defineModule({
  apiVersion: 2,
  id: "web-search",
  name: "Web search",
  description: "Searches the web through SearXNG or Brave and reads a page in short.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [webSearchModule]
