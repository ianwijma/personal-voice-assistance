import type {
  AccountInfo,
  McpServerConfig,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk"

/**
 * The part of `@anthropic-ai/claude-agent-sdk` this adapter uses, as an
 * injectable dependency: tests pass a fake `query()`, production loads the
 * real SDK lazily (importing this package loads nothing and spawns nothing).
 */

/** What the adapter needs from a running `query()` (streaming-input mode). */
export interface QueryHandle {
  /** Read with manual `next()`: `for await … break` would close the session. */
  next(): Promise<IteratorResult<SDKMessage, void>>
  interrupt(): Promise<unknown>
  close(): void
  initializationResult(): Promise<{ readonly account: AccountInfo; readonly models: ReadonlyArray<ModelInfo> }>
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<unknown>
}

/** An assistant tool as handed to the harness: name, description, JSON Schema of the input. */
export interface SessionTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** Runs one tool call for the harness. Never rejects: failures are error results. */
export type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<{ readonly content: string; readonly isError: boolean }>

export interface ClaudeSdk {
  readonly query: (params: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => QueryHandle
  /** An in-process MCP server named `assistant` exposing `tools`, every call going to `handler`. */
  readonly mcpServer: (tools: ReadonlyArray<SessionTool>, handler: ToolHandler) => McpServerConfig
}

export type { AccountInfo, McpServerConfig, ModelInfo, Options, SDKMessage, SDKUserMessage }

/** The MCP server name; the harness calls our tools `mcp__assistant__<name>`. */
export const MCP_SERVER_NAME = "assistant"
export const mcpToolName = (name: string) => `mcp__${MCP_SERVER_NAME}__${name}`

/** Load the real SDK (and zod, which its `tool()` needs) on first use. */
export const loadClaudeSdk = async (): Promise<ClaudeSdk> => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  const { z } = await import("zod")

  // The SDK's `tool()` takes a zod object shape. Our tools describe their input as
  // JSON Schema (from Effect Schema), so convert property by property; a property
  // zod cannot convert becomes `any` (our registry validates the input anyway).
  const toShape = (schema: Readonly<Record<string, unknown>>) => {
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    const required = new Set((schema.required ?? []) as ReadonlyArray<string>)
    const defs = schema.$defs as Record<string, unknown> | undefined
    const shape: Record<string, import("zod").ZodType> = {}
    for (const [key, property] of Object.entries(properties)) {
      let type: import("zod").ZodType
      try {
        type = z.fromJSONSchema((defs !== undefined ? { ...property, $defs: defs } : property) as never)
      } catch {
        type = z.any()
      }
      if (typeof property.description === "string") type = type.describe(property.description)
      shape[key] = required.has(key) ? type : type.optional()
    }
    return shape
  }

  return {
    query: (params) => sdk.query(params) as unknown as QueryHandle,
    mcpServer: (tools, handler) =>
      sdk.createSdkMcpServer({
        name: MCP_SERVER_NAME,
        version: "1.0.0",
        // Include every tool in the first prompt and wait (≤ 5 s, SDK cap) for the server at start:
        // research saw a fresh session miss an in-process tool on its first turn.
        alwaysLoad: true,
        tools: tools.map((t) =>
          sdk.tool(t.name, t.description, toShape(t.inputSchema), async (args) => {
            const result = await handler(t.name, args as Record<string, unknown>)
            return { content: [{ type: "text" as const, text: result.content }], isError: result.isError }
          })
        )
      })
  }
}
