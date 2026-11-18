import type { ModuleDefinition } from "@pva/core"
import { calculatorModule } from "./calculator.ts"
import { knowledgeModule } from "./knowledge.ts"
import { systemStatusModule } from "./systemStatus.ts"

export { calculatorModule, makeCalculator } from "./calculator.ts"
export { knowledgeModule, makeKnowledge } from "./knowledge.ts"
export { systemStatusModule } from "./systemStatus.ts"

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [calculatorModule, knowledgeModule, systemStatusModule]
