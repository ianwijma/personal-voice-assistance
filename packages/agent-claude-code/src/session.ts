import { mkdirSync } from "node:fs"
import { PROVISIONAL_SYSTEM_PROMPT, SESSION_CWD, sessionOptions } from "./options.ts"
import { addressSecrets, fromUpstream, type Secrets, secretList } from "./redact.ts"
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
  /** The reasoning effort Claude Code sends (absent: its default for the model). */
  readonly effort?: SessionEffort | undefined
  /** Adaptive thinking, or none (absent: none). */
  readonly thinking?: SessionThinking | undefined
  readonly claudePath: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  /** The agent's "Proxy for Claude Code" secret (see `sessionEnv`). */
  readonly proxy?: string | undefined
  /** Claude Code's debug logging (off unless the owner's setting enables it). */
  readonly debug?: boolean
  /** Undefined: provisional (see above). */
  readonly system: string | undefined
  readonly tools: ReadonlyArray<SessionTool>
}

export type SessionEffort = "low" | "medium" | "high"
export type SessionThinking = "off" | "adaptive"

/**
 * What a session answers with: model, effort and thinking. Model and effort can be changed on a running session
 * (`ClaudeSession.retune`); thinking cannot (a session launched with other thinking is replaced).
 */
export const launchKeyOf = (config: Pick<SessionConfig, "model" | "effort" | "thinking">): string =>
  `${config.model}|${config.effort ?? ""}|${config.thinking ?? "off"}`

export interface LoginInfo {
  readonly subscriptionType: string | undefined
  readonly apiKeySource: string | undefined
  /** The models Claude Code reports at start (its `initialize` answer), as setting choices. */
  readonly models: ReadonlyArray<{ readonly value: string; readonly label: string; readonly description?: string }>
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

/** The longest error text taken from Claude Code or the SDK (it reaches the owner's status line and logs). */
export const ERROR_TEXT_MAX = 200

/**
 * The redaction list for this adapter (seventh review): the "Proxy for Claude Code" secret as given and trimmed,
 * and its user-info, user name and password on their own, as written and percent-decoded (`addressSecrets`).
 * Every error text, status line and cause the adapter produces is redacted with it (`src/redact.ts`, a copy
 * identical to the other adapters').
 */
export const proxySecrets = (proxy: string | undefined): Array<string> => secretList(proxy, addressSecrets(proxy))

/**
 * An error's text, safe to show: redacted whole first (`fromUpstream`: the configured proxy in every form),
 * then the SDK's exit-error tail (". stderr: …", which can hold anything Claude Code printed) is dropped (the
 * bounded `stderr` lines stay for diagnostics), and the rest is one line of at most `ERROR_TEXT_MAX`
 * characters: redact, then shorten, never the other way round.
 */
export const safeErrorText = (e: unknown, secrets: Secrets = []): string => {
  const raw = fromUpstream(e, secrets) // an error's message, a string, or anything else as JSON: redacted whole
  const cut = raw.search(/[.\s]*\bstderr\s*:/i)
  const text = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/\s+/g, " ").trim()
  return text.length > ERROR_TEXT_MAX ? `${text.slice(0, ERROR_TEXT_MAX - 1)}…` : text
}

let nextSessionId = 1

/**
 * One turn's tool handler, bound when the turn is sent (`send`): a tool call is run by the binding of the turn whose
 * stream announced it, never by "the turn in progress now". `live` is false once the turn ended or was interrupted.
 */
interface TurnBinding {
  readonly handler: ToolHandler
  live: boolean
}

/** A tool use the stream announced (an `assistant` message's `tool_use` block), waiting for its MCP call. */
interface ToolClaim {
  readonly binding: TurnBinding | undefined
  /** The block's `tool_use` id: what a call that carries one is matched by. */
  readonly id: string | undefined
  readonly name: string
  readonly input: unknown
  taken: boolean
}

const signal = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** How long an MCP call waits for its turn's stream to announce it (the SDK delivers both from one ordered pipe). */
export const CLAIM_WAIT_MS = 2_000
const MAX_CLAIMS = 64

const canonical = (u: unknown): unknown =>
  Array.isArray(u)
    ? u.map(canonical)
    : u !== null && typeof u === "object"
    ? Object.fromEntries(Object.entries(u as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]))
    : u

/** The MCP call's arguments are the announced input (the server's schema may have dropped keys it does not know). */
const sameInput = (announced: unknown, args: Record<string, unknown>): boolean => {
  if (announced === null || typeof announced !== "object" || Array.isArray(announced)) return Object.keys(args).length === 0
  const a = canonical(announced) as Record<string, unknown>
  return Object.entries(canonical(args) as Record<string, unknown>).every(([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v))
}

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
  /** What its error texts are redacted with (`proxySecrets`). */
  readonly secrets: ReadonlyArray<string>
  /** Model, effort and thinking it answers with now (`launchKeyOf`; `retune` changes the first two). */
  launch: string
  model: string
  effort: SessionEffort | undefined
  readonly thinking: SessionThinking
  /** The model Claude Code reported in its last reply (diagnostics; the live test checks a retune with it). */
  answeredWith: string | undefined

  private readonly query: QueryHandle
  private readonly queue: Array<SDKUserMessage> = []
  private wake: (() => void) | undefined
  private inputClosed = false
  private listener: TurnListener | undefined
  private busy = false
  /** The turn in progress (its handler), from `send` until it ends or is interrupted. */
  private binding: TurnBinding | undefined
  /** Tool uses the stream announced, oldest first (bounded). */
  private readonly claims: Array<ToolClaim> = []
  /** Resolved whenever the stream delivers a message (or the session dies): a waiting tool call looks again. */
  private progress: { readonly promise: Promise<void>; readonly resolve: () => void } = signal()
  private mcp: ReturnType<ClaudeSdk["mcpServer"]> | undefined

  private readonly sdk: ClaudeSdk
  readonly config: SessionConfig
  private readonly now: () => number

  constructor(sdk: ClaudeSdk, config: SessionConfig, now: () => number) {
    this.sdk = sdk
    this.config = config
    this.secrets = proxySecrets(config.proxy)
    this.launch = launchKeyOf(config)
    this.model = config.model
    this.effort = config.effort
    this.thinking = config.thinking ?? "off"
    this.now = now
    this.system = config.system
    this.toolKey = toolKey(config.tools)
    this.lastUsedAt = now()
    // The MCP server always exists when tools exist; its handler forwards to the turn in progress.
    this.mcp = config.tools.length > 0 ? sdk.mcpServer(config.tools, (name, args, toolUseId) => this.callTool(name, args, toolUseId)) : undefined
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
        effort: config.effort,
        thinking: config.thinking,
        system: provisional ? PROVISIONAL_SYSTEM_PROMPT : config.system!,
        tools: provisional ? [] : config.tools.map((t) => t.name),
        mcpServer: provisional ? undefined : this.mcp,
        claudePath: config.claudePath,
        env: config.env,
        proxy: config.proxy,
        debug: config.debug === true,
        stderr: (data) => {
          for (const line of data.split("\n")) if (line.trim() !== "") this.stderr.push(line.slice(0, 300))
          if (this.stderr.length > 20) this.stderr.splice(0, this.stderr.length - 20)
        }
      })
    })
    void this.pump()
  }

  /** A turn is in progress (sent and not yet ended or interrupted). */
  get inTurn(): boolean {
    return this.busy
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
        models: init.models.map((m) => ({
          value: m.value,
          label: m.displayName,
          ...(typeof m.description === "string" && m.description.trim() !== "" ? { description: m.description.trim().slice(0, 300) } : {})
        }))
      }
      return this.login
    } catch (e) {
      const reason = this.dead ?? safeErrorText(e, this.secrets)
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
      this.mcp = this.sdk.mcpServer(tools, (name, args, toolUseId) => this.callTool(name, args, toolUseId))
      await withTimeout(this.query.setMcpServers({ [MCP_SERVER_NAME]: this.mcp }), timeoutMs, "Registering the assistant's tools timed out")
    }
    this.toolKey = toolKey(tools)
    this.system = system
  }

  /**
   * Answer with another model or effort from the next message on (the assistant's settings changed), keeping the
   * session and what was said in it: `setModel` and the `effortLevel` flag setting, as Claude Code's /model and
   * /effort do. Thinking cannot be changed this way. Rejects (the caller replaces the session) when Claude Code does
   * not confirm within `timeoutMs`.
   */
  async retune(launch: Pick<SessionConfig, "model" | "effort">, timeoutMs: number): Promise<void> {
    if (launch.model !== this.model) {
      await withTimeout(this.query.setModel(launch.model), timeoutMs, "Changing the model timed out")
      this.model = launch.model
    }
    if (launch.effort !== this.effort) {
      await withTimeout(this.query.applyFlagSettings({ effortLevel: launch.effort ?? null }), timeoutMs, "Changing the effort timed out")
      this.effort = launch.effort
    }
    this.launch = launchKeyOf({ model: this.model, effort: this.effort, thinking: this.thinking })
  }

  /** Start a turn: `listener` gets every message until it is removed with `endTurn`. */
  send(text: string, listener: TurnListener, tools: ToolHandler): void {
    if (this.dead !== undefined) throw new SessionError(this.dead, "unavailable")
    this.listener = listener
    this.binding = { handler: tools, live: true }
    this.busy = true
    this.used = true
    this.lastUsedAt = this.now()
    this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })
    this.wake?.()
  }

  /** The turn's `result` arrived (or it failed): the session is idle again. */
  endTurn(): void {
    this.listener = undefined
    this.unbind()
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
    // Its tool calls are refused from now on, whether they arrive before or after the next turn starts.
    if (this.binding !== undefined) this.binding.live = false
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
    this.query.interrupt().catch((e) => this.kill(`interrupt failed: ${safeErrorText(e, this.secrets)}`))
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
    this.unbind()
    this.busy = false
    this.progress.resolve()
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
        this.record(r.value)
        this.listener?.message(r.value)
        const progress = this.progress
        this.progress = signal()
        progress.resolve()
      }
    } catch (e) {
      this.kill(this.dead ?? `Claude Code stopped: ${safeErrorText(e, this.secrets)}`)
    }
  }

  /** The turn ended: its binding is dead, and its tool uses that were never called expire a moment later. */
  private unbind(): void {
    const ended = this.binding
    this.binding = undefined
    if (ended === undefined) return
    ended.live = false
    // A call the SDK had already read before the turn's end reaches `callTool` within this macrotask and is refused
    // by the dead binding; after that, nothing of that turn is left to match a later call.
    setImmediate(() => {
      for (let i = this.claims.length - 1; i >= 0; i--) if (this.claims[i]!.binding === ended) this.claims.splice(i, 1)
    })
  }

  /** Remember the tool uses an `assistant` message of the turn in progress announces. */
  private record(message: SDKMessage): void {
    if (message.type !== "assistant" || message.parent_tool_use_id !== null) return
    const content = (message.message as { readonly content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return
    const prefix = `mcp__${MCP_SERVER_NAME}__`
    for (const block of content as ReadonlyArray<{ readonly type?: unknown; readonly id?: unknown; readonly name?: unknown; readonly input?: unknown }>) {
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue
      const name = block.name.startsWith(prefix) ? block.name.slice(prefix.length) : block.name
      this.claims.push({ binding: this.binding, id: typeof block.id === "string" ? block.id : undefined, name, input: block.input, taken: false })
    }
    if (this.claims.length > MAX_CLAIMS) this.claims.splice(0, this.claims.length - MAX_CLAIMS)
  }

  /**
   * An MCP tool call from Claude Code: run by the turn whose stream announced it. Claude Code sends the model's
   * `tool_use` id with the request (`_meta["claudecode/toolUseId"]`): the call is matched to the announcement with that
   * id, and to nothing else. Only a call without one (an older Claude Code) is matched by name and input to the oldest
   * unanswered announcement; there, an identical call of a turn that was cancelled, arriving after its announcements
   * were purged, can take the next turn's claim (the effect is one refused tool call for that turn). A call whose turn
   * ended or was interrupted is refused; so is one no turn announced within `CLAIM_WAIT_MS`. It is never given to
   * whatever turn happens to be in progress.
   */
  private async callTool(name: string, args: Record<string, unknown>, toolUseId?: string): Promise<{ readonly content: string; readonly isError: boolean }> {
    const deadline = this.now() + CLAIM_WAIT_MS
    const matches = (c: ToolClaim) => !c.taken && c.name === name && (toolUseId !== undefined ? c.id === toolUseId : sameInput(c.input, args))
    for (;;) {
      const claim = this.claims.find(matches)
      if (claim !== undefined) {
        claim.taken = true
        const binding = claim.binding
        if (binding === undefined || !binding.live) return { content: "The turn this call belongs to has ended; it was not run. Do not continue.", isError: true }
        return binding.handler(name, args)
      }
      const left = deadline - this.now()
      if (this.dead !== undefined || left <= 0) return { content: "This call could not be matched to a turn; it was not run.", isError: true }
      await Promise.race([this.progress.promise, new Promise<void>((resolve) => setTimeout(resolve, Math.min(left, 100)))])
    }
  }
}

/** Identity of a tool set: a change restarts the session at the next turn boundary. */
export const toolKey = (tools: ReadonlyArray<SessionTool>): string =>
  JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema]))
