import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Reads and dismisses notifications, and do not disturb by voice.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 6, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/notifications.md and docs/research/modules/notifications.md.
 */
export const notificationsModule = defineModule({
  apiVersion: 2,
  id: "notifications",
  name: "Notifications",
  description: "Reads and dismisses notifications, and do not disturb by voice.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [notificationsModule]
