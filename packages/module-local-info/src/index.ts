import type { ModuleDefinition } from "@pva/core"
import { binDayModule } from "./binDay.ts"

export { binDayModule, type NetDeps } from "./binDay.ts"

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order. The
 * weather module is not here: it is `weatherModule` in `packages/modules-builtin`, which the catalogue lists itself.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [binDayModule()]
