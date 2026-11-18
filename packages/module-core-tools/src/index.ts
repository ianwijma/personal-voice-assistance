import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Arithmetic, units and currency, worked out exactly, and random picks.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 3, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/calculator.md and docs/research/modules/core-tools.md.
 */
export const calculatorModule = defineModule({
  apiVersion: 2,
  id: "calculator",
  name: "Calculator",
  description: "Arithmetic, units and currency, worked out exactly, and random picks.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * Short facts and definitions from Wikipedia, Wikidata and Wiktionary.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 3, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/knowledge.md and docs/research/modules/core-tools.md.
 */
export const knowledgeModule = defineModule({
  apiVersion: 2,
  id: "knowledge",
  name: "Knowledge",
  description: "Short facts and definitions from Wikipedia, Wikidata and Wiktionary.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * How the assistant itself is doing: its modules, engines and devices.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 3, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/system-status.md and docs/research/modules/core-tools.md.
 */
export const systemStatusModule = defineModule({
  apiVersion: 2,
  id: "system-status",
  name: "System status",
  description: "How the assistant itself is doing: its modules, engines and devices.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [calculatorModule, knowledgeModule, systemStatusModule]
