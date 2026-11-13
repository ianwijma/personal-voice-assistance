import { mkdirSync } from "node:fs"
import { PROVISIONAL_SYSTEM_PROMPT, SESSION_CWD, sessionOptions } from "./options.ts"
import { type ClaudeSdk, MCP_SERVER_NAME, type QueryHandle, type SDKMessage, type SDKUserMessage, type SessionTool, type ToolHandler } from "./sdk.ts"

/**
 * One long-lived Claude Code session: a single `query()` in streaming-input
 * mode, fed from a queue, read by one background pump that hands every message
 * to the turn in progress. Promise-based (the SDK is); the agent wraps it in
 * an Effect stream.
 *
 * A session is spawned either with the real system prompt and tools, or, when
 * they are not known yet (at module start, before the first turn), as a
 * *provisional* session: a fixed short system prompt and no tools. Its first
 * turn then carries the real prompt in an `<instructions>` block and registers
 * the tools with `setMcpServers` before the message is sent, so the first turn
 * is warm too. A provisional session that has been used is bound to that
 * prompt and tool set like any other.
 */

export interface SessionConfig {
  readonly model: string
  readonly claudePath: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  /** Undefined: provisional (see above). */
  readonly system: string | undefined
  readonly tools: ReadonlyArray<SessionTool>
}

export interface LoginInfo {
  readonly subscriptionType: string | undefined
  readonly apiKeySource: string | undefined
  readonly models: ReadonlyArray<{ readonly value: string; readonly label: string }>
}

export class SessionError extends Error {
  readonly kind: "unavailable" | "failed" | "timeout"
  constructor(message: string, kind: "unavailable" | "failed" | "timeout") {
    super(message)
    this.kind = kind
  }
}

/** Receives the session's messages while a turn runs. */
export interface TurnListener {
  readonly message: (m: SDKMessage) => void
  readonly died: (reason: string) => void
}

const withTimeout = <A>(promise: Promise<A>, ms: number, message: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SessionError(message, "timeout")), ms)
    promise.then(
      (a) => {
        clearTimeout(timer)
        resolve(a)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

let nextSessionId = 1

export class ClaudeSession {
  readonly id = nextSessionId++
  /** The system prompt the session runs with; undefined while provisional and unused. */
  system: string | undefined
  /** Key of the tool set the session exposes (names + descriptions + schemas). */
  toolKey: string
  /** A user message was sent. */
  used = false
  /** Set once the session can no longer be used, with the reason. */
  dead: string | undefined
  lastUsedAt: number
  login: LoginInfo | undefined
  /** Resolves when an interrupted reply has been acknowledged (or the session was killed). The next turn awaits it. */
  draining: Promise<void> | undefined
  /** The last lines Claude Code wrote to stderr (diagnostics; never shown to the owner unfiltered). */
  readonly stderr: Array<string> = []
  /** Validated the session's `init` message (tool list) once. */
  initChecked = false

  private readonly query: QueryHandle
  private readonly queue: Array<SDKUserMessage> = []
  private wake: (() => void) | undefined
  private inputClosed = false
  private listener: TurnListener | undefined
  private busy = false
  private toolHandler: ToolHandler | undefined
  private mcp: ReturnType<ClaudeSdk["mcpServer"]> | undefined

  private readonly sdk: ClaudeSdk
  readonly config: SessionConfig
  private readonly now: () => number

  constructor(sdk: ClaudeSdk, config: SessionConfig, now: () => number) {
    this.sdk = sdk
    this.config = config
    this.now = now
    this.system = config.system
    this.toolKey = toolKey(config.tools)
    this.lastUsedAt = now()
    // The MCP server always exists when tools exist; its handler forwards to the turn in progress.
    this.mcp = config.tools.length > 0 ? sdk.mcpServer(config.tools, (name, args) => this.callTool(name, args)) : undefined
    const self = this
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (self.queue.length === 0) {
          if (self.inputClosed) return
          await new Promise<void>((resolve) => (self.wake = resolve))
        }
        yield self.queue.shift()!
      }
    }
    try {
      mkdirSync(SESSION_CWD, { recursive: true })
    } catch {
      // The SDK reports a missing cwd itself.
    }
    const provisional = config.system === undefined
    this.query = sdk.query({
      prompt: input(),
      options: sessionOptions({
        model: config.model,
        system: provisional ? PROVISIONAL_SYSTEM_PROMPT : config.system!,
        tools: provisional ? [] : config.tools.map((t) => t.name),
        mcpServer: provisional ? undefined : this.mcp,
        claudePath: config.claudePath,
        env: config.env,
        stderr: (data) => {
          for (const line of data.split("\n")) if (line.trim() !== "") this.stderr.push(line.slice(0, 300))
          if (this.stderr.length > 20) this.stderr.splice(0, this.stderr.length - 20)
        }
      })
    })
    void this.pump()
  }

  get provisional(): boolean {
    return this.system === undefined
  }

  /** Wait for Claude Code to answer `initialize`: proves the process runs and reports the login. */
  async start(timeoutMs: number): Promise<LoginInfo> {
    try {
      const init = await withTimeout(this.query.initializationResult(), timeoutMs, `Claude Code did not start within ${timeoutMs / 1000} s`)
      this.login = {
        subscriptionType: init.account.subscriptionType,
        apiKeySource: init.account.apiKeySource,
        models: init.models.map((m) => ({ value: m.value, label: m.displayName }))
      }
      return this.login
    } catch (e) {
      const reason = this.dead ?? errorText(e)
      this.kill(reason)
      throw e instanceof SessionError ? e : new SessionError(`Claude Code could not start: ${reason}`, "unavailable")
    }
  }

  /**
   * Bind an unused provisional session to the real prompt and tools: register
   * the MCP server (if any) and return the instructions to put in the first message.
   */
  async bind(system: string, tools: ReadonlyArray<SessionTool>, timeoutMs: number): Promise<void> {
    if (tools.length > 0) {
      this.mcp = this.sdk.mcpServer(tools, (name, args) => this.callTool(name, args))
      await withTimeout(this.query.setMcpServers({ [MCP_SERVER_NAME]: this.mcp }), timeoutMs, "Registering the assistant's tools timed out")
    }
    this.toolKey = toolKey(tools)
    this.system = system
  }

  /** Start a turn: `listener` gets every message until it is removed with `endTurn`. */
  send(text: string, listener: TurnListener, tools: ToolHandler): void {
    if (this.dead !== undefined) throw new SessionError(this.dead, "unavailable")
    this.listener = listener
    this.toolHandler = tools
    this.busy = true
    this.used = true
    this.lastUsedAt = this.now()
    this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })
    this.wake?.()
  }

  /** The turn's `result` arrived (or it failed): the session is idle again. */
  endTurn(): void {
    this.listener = undefined
    this.toolHandler = undefined
    this.busy = false
    this.lastUsedAt = this.now()
  }

  /**
   * Barge-in: interrupt the reply in progress and keep the session. The reply's
   * `result` (subtype `error_during_execution`) is awaited in the background;
   * without it within `ackMs` the session is killed (a new one is started at the next turn).
   */
  interrupt(ackMs: number): void {
    if (!this.busy || this.dead !== undefined) return
    this.toolHandler = undefined
    this.draining = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.endTurn()
        this.draining = undefined
        resolve()
      }
      const timer = setTimeout(() => {
        this.kill(`the interrupted reply was not acknowledged within ${ackMs} ms`)
        done()
      }, ackMs)
      this.listener = {
        message: (m) => {
          if (m.type === "result") done()
        },
        died: () => done()
      }
    })
    this.query.interrupt().catch((e) => this.kill(`interrupt failed: ${errorText(e)}`))
  }

  /** End the session for good. Idempotent. */
  kill(reason: string): void {
    if (this.dead === undefined) this.dead = reason
    this.inputClosed = true
    this.wake?.()
    try {
      this.query.close()
    } catch {
      // already closed
    }
    const listener = this.listener
    this.listener = undefined
    this.toolHandler = undefined
    this.busy = false
    listener?.died(this.dead)
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const r = await this.query.next()
        if (r.done === true) {
          this.kill(this.dead ?? "Claude Code ended the session")
          return
        }
        this.listener?.message(r.value)
      }
    } catch (e) {
      this.kill(this.dead ?? `Claude Code stopped: ${errorText(e)}`)
    }
  }

  private callTool(name: string, args: Record<string, unknown>) {
    const handler = this.toolHandler
    if (handler === undefined) return Promise.resolve({ content: "The turn was interrupted; do not continue.", isError: true })
    return handler(name, args)
  }
}

/** Identity of a tool set: a change restarts the session at the next turn boundary. */
export const toolKey = (tools: ReadonlyArray<SessionTool>): string =>
  JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema]))
