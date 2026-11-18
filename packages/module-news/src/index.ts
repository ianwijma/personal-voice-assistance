import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Headlines and stories from news feeds, and subscribing to feeds by voice.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 20, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/news.md and docs/research/modules/news-and-feeds.md.
 */
export const newsModule = defineModule({
  apiVersion: 2,
  id: "news",
  name: "News and feeds",
  description: "Headlines and stories from news feeds, and subscribing to feeds by voice.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [newsModule]
