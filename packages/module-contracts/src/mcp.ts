import { ServiceKey } from "@pva/core"
import { Data, type Effect, type Scope } from "effect"
import type { Json, JsonObject } from "./common.ts"

/**
 * `Mcp`: an authenticated, reusable client for HTTP MCP servers, as a **transport** (docs/MODULES-PLAN.md §2 row 18,
 * §5.2 and §5.1 row 22; docs/research/modules/mcp-client.md). Provided by `mcp` (`packages/module-mcp`), used later by
 * `t3-code` (its own server, its own token provider).
 *
 * **What it is.** `open` connects to one server the consumer names, with the consumer's own headers and token
 * provider, speaking both protocol revisions the mcp module supports; the client lists the server's tools and calls
 * one. The consumer decides which tools exist for the model, their names, descriptions, risk and parameters: the
 * client is never offered to the model, and none of the server's tools is offered directly (t3-code wraps four of them
 * in tools of its own). Each `callTool` must fit the call the gateway admitted for the consumer's tool.
 *
 * **The address.** `url` is an address the owner typed into the consumer's settings (never one a model chose):
 * `http` or `https`; a LAN address only with `lan: true`, which uses `@pva/net`'s owner-configured-LAN rules. The
 * client follows no redirect to another origin.
 *
 * **Lifetime.** `open` needs a `Scope`: the client is closed when that scope closes. Open it in the consumer's
 * `shared` part (one client for the module's life) or for one call (`Effect.scoped`). A closed client answers
 * `closed`. A server that changes its tool list does not change an open client's answers until it is listed again.
 *
 * **Bounds.** `listTools` gives at most `MCP_LIMITS.tools` tools, each description cut to `MCP_LIMITS.descriptionChars`
 * and its input schema at most `MCP_LIMITS.schemaChars` as JSON (a tool over it is left out and counted in `left`).
 * `callTool`'s `args` at most `MCP_LIMITS.argsChars` as JSON; its result's text cut to `maxChars` (default
 * `MCP_LIMITS.resultChars`; `truncated` says so), its structured content kept only when it fits the same bound.
 * Each request has `timeoutMs` (default `MCP_LIMITS.timeoutMs`, at most `MCP_LIMITS.maxTimeoutMs`).
 *
 * **Untrusted.** Everything a server returns (descriptions, results) is data, never instructions: the consumer passes
 * it to the model marked as such (the mcp module's tool results begin with the server's name and say so).
 *
 * **Secrets.** The token provider's tokens and the headers' values are never in an error message, a log line or a
 * result.
 *
 * **When mcp is off or stops**: `host.service(Mcp)` is `undefined`; an open client answers `closed` once the provider
 * stopped; a call may die with `ModuleStopped`. `useService(host, Mcp, "MCP", …)` makes those `ProviderOff`; a
 * consumer that needs it names `mcp` in `uses` and opens a new client after a restart.
 */
export const MCP_LIMITS = {
  tools: 200,
  descriptionChars: 1_000,
  schemaChars: 16_000,
  argsChars: 16_000,
  resultChars: 4_000,
  timeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  nameChars: 60
} as const

export interface McpOpenOptions {
  /** A short label for the status line and logs ("T3"); at most `MCP_LIMITS.nameChars`. */
  readonly name: string
  readonly url: string
  /** Extra request headers (values may be secrets: they are never shown). */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * A bearer token, asked for before the first request and again once after a 401 (a refreshed token). Its failure
   * fails the request with `unauthorized`.
   */
  readonly token?: () => Effect.Effect<string, McpError>
  /** The URL is an address on the owner's network (see above). Default false. */
  readonly lan?: boolean
  readonly timeoutMs?: number
}

export interface McpToolInfo {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: JsonObject
  /** The server's hints; untrusted (a server can say anything about itself). */
  readonly annotations: {
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
    readonly idempotentHint?: boolean
    readonly openWorldHint?: boolean
  }
}

export interface McpToolList {
  readonly tools: ReadonlyArray<McpToolInfo>
  /** Tools left out (over the count or the schema bound). */
  readonly left: number
}

export interface McpCallResult {
  /** The server said the tool failed (its text says why). */
  readonly isError: boolean
  /** The text content, joined, cut to `maxChars`. */
  readonly text: string
  readonly truncated: boolean
  readonly structured?: Json
}

/** A refusal or failure; `message` is one sentence, never a token or a header value. */
export class McpError extends Data.TaggedError("McpError")<{
  /**
   * `invalid`: options or arguments out of bounds, or an address refused. `unreachable`: no connection. `unauthorized`:
   * 401 or 403, or the token provider failed. `protocol`: an answer that is not MCP. `timeout`: no answer in time.
   * `unknown_tool`: the server has no such tool. `closed`: the client (or its provider) is closed.
   */
  readonly reason: "invalid" | "unreachable" | "unauthorized" | "protocol" | "timeout" | "unknown_tool" | "closed"
  readonly message: string
}> {}

export interface McpClient {
  /** What the server said about itself when it was opened. */
  readonly server: { readonly name: string; readonly version: string; readonly protocolVersion: string }
  readonly listTools: () => Effect.Effect<McpToolList, McpError>
  readonly callTool: (
    name: string,
    args: JsonObject,
    options?: { readonly timeoutMs?: number; readonly maxChars?: number }
  ) => Effect.Effect<McpCallResult, McpError>
}

export interface McpService {
  readonly open: (options: McpOpenOptions) => Effect.Effect<McpClient, McpError, Scope.Scope>
}

export const Mcp = ServiceKey<McpService>("mcp")
