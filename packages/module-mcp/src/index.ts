import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"

/**
 * Tools of the MCP servers the owner adds, each allowed one by one.
 *
 * A stub of the scaffold (docs/MODULES-PLAN.md §4 P11; §5.1 row 22, wave A): off by default, no tools yet.
 * Its own pull request writes it. What it is to do: docs/modules/mcp.md and docs/research/modules/mcp-client.md.
 */
export const mcpModule = defineModule({
  apiVersion: 2,
  id: "mcp",
  name: "MCP servers",
  description: "Tools of the MCP servers the owner adds, each allowed one by one.",
  enabledByDefault: false,
  start: () => Effect.succeed({})
})

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [mcpModule]
