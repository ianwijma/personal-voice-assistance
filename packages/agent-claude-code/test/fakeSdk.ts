import type { ClaudeSdk, McpServerConfig, Options, QueryHandle, SDKMessage, SDKUserMessage, SessionTool, ToolHandler } from "../src/sdk.ts"

/**
 * A scripted stand-in for the Agent SDK's `query()`. Each spawned query reads
 * the user messages the adapter writes and answers them with `respond`, which
 * can emit text deltas, call the session's tools through the registered MCP
 * handler (as Claude Code would), and finish with a result. `interrupt()`
 * answers with `error_during_execution` unless told to hang; `crash()` makes
 * the iterator throw (the process died).
 */

export interface FakeTurnContext {
  readonly query: FakeQuery
  readonly text: string
  /** Emit a text delta (a `stream_event` / `text_delta`). */
  delta(text: string): void
  /** Call a tool the way Claude Code would: announce it in the stream, then call it through the in-process MCP server's handler. */
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>
  /** Only announce a tool use in the stream (its MCP call is made later, or never); returns its `tool_use` id. */
  announce(name: string, args: Record<string, unknown>, id?: string): string
  /** The MCP server's handler as it is now (a test keeps it to make a late call). */
  mcp(): ToolHandler | undefined
  result(subtype?: "success" | "error_during_execution", isError?: boolean, text?: string): void
  emit(message: unknown): void
  /** Resolves when this turn was interrupted. */
  readonly interrupted: Promise<void>
  sleep(ms: number): Promise<void>
}

export type Responder = (ctx: FakeTurnContext) => void | Promise<void>

export interface FakeQuery extends QueryHandle {
  readonly id: number
  readonly options: Options
  readonly received: Array<string>
  readonly interrupts: number
  readonly closed: boolean
  readonly registered: Array<{ tools: ReadonlyArray<SessionTool>; viaSetMcpServers: boolean }>
  /** `setModel` and `applyFlagSettings` calls, in order. */
  readonly retunes: Array<{ model: string | undefined } | { effortLevel: string | null | undefined }>
  /** The model it answers with now: the last `setModel` it received (applied on arrival, before it is acknowledged), else its launch model. */
  readonly model: string | undefined
  /** The iterator throws `error` (an `Error` made from a string), as the SDK does when the process dies. */
  crash(error?: string | Error): void
}

export interface FakeSdkOptions {
  readonly respond?: Responder
  readonly account?: { subscriptionType?: string; apiKeySource?: string }
  /** Delay before initializationResult resolves (ms); `Infinity` never resolves. */
  readonly initDelayMs?: number
  /** initializationResult rejects with this instead (the process could not start). */
  readonly initError?: unknown
  /** Interrupts are never acknowledged (a stuck session). */
  readonly hangOnInterrupt?: boolean
  /** Tools listed in the init message besides our MCP tools (to test the safety check). */
  readonly extraInitTools?: ReadonlyArray<string>
  /** `setModel` / `applyFlagSettings` reject (Claude Code refused the change). */
  readonly refuseRetune?: boolean
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const makeFakeSdk = (options: FakeSdkOptions = {}) => {
  const queries: Array<FakeQuery> = []
  let toolUses = 0
  const servers = new Map<object, { tools: ReadonlyArray<SessionTool>; handler: ToolHandler }>()
  /** While set, `setModel` and `applyFlagSettings` apply at once but are acknowledged only when it resolves (`holdRetunes`). */
  let retuneHold: Promise<void> | undefined
  let respond: Responder = options.respond ?? ((ctx) => {
    ctx.delta("Hello")
    ctx.delta(" there.")
    ctx.result()
  })

  const sdk: ClaudeSdk = {
    mcpServer: (tools, handler) => {
      const config = { type: "sdk", name: "assistant", instance: {} } as unknown as McpServerConfig
      servers.set(config, { tools, handler })
      return config
    },
    query: ({ prompt, options: queryOptions }) => {
      const out: Array<IteratorResult<SDKMessage, void>> = []
      const waiters: Array<{ resolve: (r: IteratorResult<SDKMessage, void>) => void; reject: (e: unknown) => void }> = []
      let failure: Error | undefined
      let closed = false
      let interrupts = 0
      let onInterrupt: (() => void) | undefined
      let initSent = false
      let currentTools: ReadonlyArray<SessionTool> = []
      const registered: FakeQuery["registered"] = []
      const retunes: FakeQuery["retunes"] = []
      let model = queryOptions.model
      const push = (m: unknown) => {
        const r = { done: false, value: m as SDKMessage } as IteratorResult<SDKMessage, void>
        const w = waiters.shift()
        if (w !== undefined) w.resolve(r)
        else out.push(r)
      }
      const spawnServer = queryOptions.mcpServers?.assistant
      if (spawnServer !== undefined) {
        const s = servers.get(spawnServer as object)
        if (s !== undefined) {
          currentTools = s.tools
          registered.push({ tools: s.tools, viaSetMcpServers: false })
        }
      }
      const handlerFor = () => {
        const s = [...servers.entries()].find(([, v]) => v.tools === currentTools)
        return s?.[1].handler
      }
      const query: FakeQuery = {
        id: queries.length + 1,
        options: queryOptions,
        received: [],
        get interrupts() {
          return interrupts
        },
        get closed() {
          return closed
        },
        registered,
        retunes,
        get model() {
          return model
        },
        setModel: async (next) => {
          if (options.refuseRetune === true) throw new Error("setModel refused")
          retunes.push({ model: next })
          model = next
          if (retuneHold !== undefined) await retuneHold
        },
        applyFlagSettings: async (settings) => {
          if (options.refuseRetune === true) throw new Error("applyFlagSettings refused")
          retunes.push({ effortLevel: settings.effortLevel })
          if (retuneHold !== undefined) await retuneHold
        },
        next: () => {
          if (failure !== undefined) return Promise.reject(failure)
          const r = out.shift()
          if (r !== undefined) return Promise.resolve(r)
          if (closed) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
        },
        interrupt: async () => {
          interrupts++
          const f = onInterrupt
          onInterrupt = undefined
          f?.()
          if (options.hangOnInterrupt !== true) {
            await sleep(5)
            push({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" })
          }
          return undefined
        },
        close: () => {
          closed = true
          for (const w of waiters.splice(0)) w.resolve({ done: true, value: undefined })
        },
        initializationResult: () =>
          (options.initDelayMs === Infinity ? new Promise(() => {}) : sleep(options.initDelayMs ?? 1)).then(() => {
            if ("initError" in options) throw options.initError
          }).then(() => ({
            account: { subscriptionType: "max", apiKeySource: "none", ...options.account },
            models: [{ value: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "" }] as never
          })),
        setMcpServers: async (servers2) => {
          const s = servers.get(servers2.assistant as object)
          if (s !== undefined) {
            currentTools = s.tools
            registered.push({ tools: s.tools, viaSetMcpServers: true })
          }
          return {}
        },
        crash: (error = "Claude Code process exited with code 1") => {
          failure = typeof error === "string" ? new Error(error) : error
          for (const w of waiters.splice(0)) w.reject(failure)
        }
      }
      queries.push(query)

      void (async () => {
        for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
          const text = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content)
          query.received.push(text)
          if (!initSent) {
            initSent = true
            push({
              type: "system",
              subtype: "init",
              apiKeySource: "none",
              tools: [...currentTools.map((t) => `mcp__assistant__${t.name}`), ...(options.extraInitTools ?? [])],
              mcp_servers: currentTools.length > 0 ? [{ name: "assistant", status: "connected" }] : []
            })
          }
          let stopped = false
          const interrupted = new Promise<void>((resolve) => {
            onInterrupt = () => {
              stopped = true
              resolve()
            }
          })
          const ctx: FakeTurnContext = {
            query,
            text,
            delta: (t) => {
              if (!stopped) push({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } } })
            },
            callTool: async (name, args) => {
              const handler = handlerFor()
              if (handler === undefined || !currentTools.some((t) => t.name === name)) return { content: `No such tool: ${name}`, isError: true }
              // As Claude Code does: the assistant message with the tool use comes first, then the MCP call.
              // Claude Code sends the tool_use id with the MCP request (`_meta["claudecode/toolUseId"]`).
              const id = `toolu_${++toolUses}`
              push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: `mcp__assistant__${name}`, input: args }] } })
              return handler(name, args, id)
            },
            announce: (name, args, given) => {
              const id = given ?? `toolu_${++toolUses}`
              push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: `mcp__assistant__${name}`, input: args }] } })
              return id
            },
            mcp: () => handlerFor(),
            result: (subtype = "success", isError = false, resultText = "") => {
              if (!stopped) push({ type: "result", subtype, is_error: isError, result: resultText, num_turns: 1 })
            },
            emit: push,
            interrupted,
            sleep
          }
          await respond(ctx)
        }
      })()
      return query
    }
  }

  return {
    sdk,
    queries,
    setRespond: (r: Responder) => (respond = r),
    /** Hold back the acknowledgement of retunes from now on (they still apply on arrival); the result releases them. */
    holdRetunes: (): (() => void) => {
      let release!: () => void
      retuneHold = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        retuneHold = undefined
        release()
      }
    }
  }
}
