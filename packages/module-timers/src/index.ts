import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Named countdown timers that ring on the device that set them.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 2, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/timers.md and docs/research/modules/timers-and-alarms.md.
 */
export const timersModule = defineModule({
  apiVersion: 2,
  id: "timers",
  name: "Timers",
  description: "Named countdown timers that ring on the device that set them.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * One-off and repeating alarms that ring on the device they were set for.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 2, wave B): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/alarms.md and docs/research/modules/timers-and-alarms.md.
 */
export const alarmsModule = defineModule({
  apiVersion: 2,
  id: "alarms",
  name: "Alarms",
  description: "One-off and repeating alarms that ring on the device they were set for.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [timersModule, alarmsModule]
