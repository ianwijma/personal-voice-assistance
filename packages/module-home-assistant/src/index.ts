import type { ModuleDefinition } from "@pva/core"
import { homeAssistant } from "./module.ts"

export * from "./client.ts"
export * from "./house.ts"
export * from "./module.ts"
export * from "./texts.ts"

/**
 * What the app runs from this package: the production definition of its one module id. (The app's catalogue lists
 * `homeAssistantModule()` itself, as before the scaffold; this array is the same definition for the scaffold's shape.)
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [homeAssistant]
