import type { ModuleDefinition } from "@pva/core"
import { listsModule } from "./module.ts"

/**
 * Shopping and to-do lists (docs/modules/lists.md; docs/MODULES-PLAN.md §5.1 row 5, wave A): household lists in the
 * module's own store, the ten `lists_*` tools (seven of them typed actions that run without the model), splitting
 * on "and", quantities, merging an item said again, one level of undo per conversation, and the `Lists` service the
 * kitchen module uses for the shopping list.
 */
export { listsModule, settings } from "./module.ts"
export { Item, items, ListRow, lists, MAX_CLEAR, MAX_LISTS, MAX_LIVE_LISTS, MAX_OPEN, MAX_PER_REQUEST, SHOPPING, TODO, undo, UndoEntry, undoIdOf, UNDO_WINDOW_MS } from "./data.ts"
export { SCAN_ROWS } from "./engine.ts"
export { splitItems } from "./parse.ts"
export { texts } from "./texts.ts"
export { MAX_TIDY_STEPS } from "./tidy.ts"

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [listsModule]
