import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Finds a picture of something on Wikipedia and Commons, with its credit.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 11, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/images.md and docs/research/modules/images-and-photos.md.
 */
export const imagesModule = defineModule({
  apiVersion: 2,
  id: "images",
  name: "Images",
  description: "Finds a picture of something on Wikipedia and Commons, with its credit.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [imagesModule]
