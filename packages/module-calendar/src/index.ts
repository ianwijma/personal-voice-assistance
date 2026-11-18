import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Calendars from ICS links and CalDAV: what is on, when, free time, and adding an event.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 12, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/calendar.md and docs/research/modules/calendar.md.
 */
export const calendarModule = defineModule({
  apiVersion: 2,
  id: "calendar",
  name: "Calendar",
  description: "Calendars from ICS links: what is on, when, and free time.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [calendarModule]
