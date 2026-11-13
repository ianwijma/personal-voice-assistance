import {
  type AgentEvent,
  AgentError,
  type AgentImplementation,
  type AgentTurnInput,
  defineAgent,
  ModuleStartError,
  Setting,
  type ToolCall
} from "@pva/core"
import { Cause, Effect, Queue, Stream } from "effect"
import { catchUpBlock, composeMessage, primeBlock } from "./catchUp.ts"
import { type ClaudeSdk, loadClaudeSdk, mcpToolName, type SDKMessage, type SessionTool, type ToolHandler } from "./sdk.ts"
import { proxyCredentialsProblem } from "./options.ts"
import { clip, fromUpstream, redact } from "./redact.ts"
import { ClaudeSession, type LoginInfo, proxySecrets, safeErrorText, SessionError, type SessionConfig, toolKey } from "./session.ts"

export const AGENT_ID = "claude-subscription"
export const AGENT_NAME = "Claude subscription"

/** The opt-in sentence; also the start error while the switch is off. */
export const OPT_IN_TEXT =
  "I understand Anthropic's terms for using a subscription from other software are unclear, and I accept that"

export const MODELS = [
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest)" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5" }
]

export interface ClaudeAgentOptions {
  readonly model: string
  readonly tools: boolean
  readonly speculate: boolean
  readonly systemPrompt?: string | undefined
  readonly sessionIdleMinutes: number
  readonly claudePath?: string | undefined
  /** Environment the Claude Code process's allow-listed variables are taken from (`ALLOWED_ENV`). Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * The "Proxy for Claude Code" secret: passed to the process as-is (`HTTPS_PROXY`, `HTTP_PROXY`). Inherited proxy
   * URLs with credentials are never passed (sixth review, finding 3; `sessionEnv`).
   */
  readonly proxy?: string | undefined
  /** Claude Code's debug logging (debug files under its configuration directory). Default: off. */
  readonly debug?: boolean
  readonly sdk?: ClaudeSdk | undefined
  readonly now?: () => number
  /** Limits; defaults from the design (§1.8). */
  readonly startTimeoutMs?: number
  readonly turnTimeoutMs?: number
  readonly interruptAckMs?: number
}

export const DEFAULTS = {
  startTimeoutMs: 9_000, // the host fails a start after 10 s
  turnTimeoutMs: 30_000,
  interruptAckMs: 1_000,
  bindTimeoutMs: 3_000
}

/** Minimal session states for logs and the status line. */
export interface ClaudeAgentHandle extends AgentImplementation {
  readonly login: () => LoginInfo | undefined
  /** Ends the session (module scope close). */
  readonly shutdown: () => void
  /** For tests and diagnostics. */
  readonly session: () => ClaudeSession | undefined
}

const sessionToolsOf = (input: AgentTurnInput): ReadonlyArray<SessionTool> =>
  input.tools.specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema }))

const isAuthError = (e: string | undefined) =>
  e === "authentication_failed" || e === "oauth_org_not_allowed" || e === "account_on_hold" || e === "billing_error" ||
  e === "verification_required"

/**
 * The Claude subscription agent's behaviour, independent of the module
 * plumbing. `start` spawns a warm (provisional) session and checks the login;
 * each `turn` reuses it, restarting it when the prompt or the tools changed,
 * after a crash, a stuck interrupt or `sessionIdleMinutes` without a turn.
 */
export const makeClaudeAgent = async (options: ClaudeAgentOptions): Promise<ClaudeAgentHandle> => {
  const sdk = options.sdk ?? (await loadClaudeSdk())
  const now = options.now ?? Date.now
  const env = options.env ?? process.env
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULTS.startTimeoutMs
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULTS.turnTimeoutMs
  const interruptAckMs = options.interruptAckMs ?? DEFAULTS.interruptAckMs
  const idleMs = options.sessionIdleMinutes * 60_000
  /** Every error text this agent produces is redacted with these (the proxy secret: `proxySecrets`). */
  const secrets = proxySecrets(options.proxy)

  let closed = false
  let current: ClaudeSession | undefined
  let starting: Promise<ClaudeSession> | undefined
  /** The last real prompt and tool set, so a replacement session is spawned with them (warm, not provisional). */
  let known: { system: string; tools: ReadonlyArray<SessionTool> } | undefined
  /** Shared-history index at the start of this agent's last turn (catch-up, §1.4). */
  let syncedThrough = 0
  let login: LoginInfo | undefined

  const spawn = (config: Omit<SessionConfig, "model" | "claudePath" | "env" | "proxy" | "debug">): Promise<ClaudeSession> => {
    const session = new ClaudeSession(sdk, { ...config, model: options.model, claudePath: options.claudePath, env, proxy: options.proxy, debug: options.debug === true }, now)
    const ready = session.start(startTimeoutMs).then((info) => {
      login = info
      return session
    })
    current = session
    starting = ready
    ready.then(
      () => {
        if (starting === ready) starting = undefined
      },
      () => {
        if (starting === ready) starting = undefined
      }
    )
    return ready
  }

  /** Start a replacement in the background, so the next turn finds a warm session. */
  const respawnSoon = () => {
    if (closed) return
    spawn(known !== undefined ? { system: known.system, tools: known.tools } : { system: undefined, tools: [] }).catch(() => {})
  }

  /** A ready session for this turn's prompt and tools, and the instructions to prepend when binding a provisional one. */
  const acquire = async (system: string, tools: ReadonlyArray<SessionTool>): Promise<{ session: ClaudeSession; instructions?: string }> => {
    if (closed) throw new SessionError(`${AGENT_NAME} is stopped`, "unavailable")
    let session = starting !== undefined ? await starting.catch(() => undefined) : current
    if (session?.draining !== undefined) await session.draining
    const key = toolKey(tools)
    const stale = session === undefined || session.dead !== undefined ||
      (session.used && now() - session.lastUsedAt > idleMs) ||
      (!session.provisional && (session.system !== system || session.toolKey !== key)) ||
      (session.provisional && session.used)
    if (stale) {
      session?.kill("replaced")
      session = await spawn({ system, tools })
    }
    known = { system, tools }
    if (session!.provisional) {
      await session!.bind(system, tools, DEFAULTS.bindTimeoutMs)
      return { session: session!, instructions: system }
    }
    return { session: session! }
  }

  const turn = (input: AgentTurnInput): Stream.Stream<AgentEvent, AgentError> =>
    Stream.callback<AgentEvent, AgentError>((queue) =>
      Effect.gen(function*() {
        const controller = new AbortController()
        let session: ClaudeSession | undefined
        let settled = false
        let emittedText = false
        const emit = (event: AgentEvent) => {
          if (settled) return
          if (event._tag === "TextDelta" && event.text !== "\n") emittedText = true
          Queue.offerUnsafe(queue, event)
        }

        // Closing the stream before the reply finished (barge-in, discarded speculative turn,
        // first-event timeout): stop the harness at once and keep the session.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            controller.abort()
            if (!settled) {
              settled = true
              session?.interrupt(interruptAckMs)
            }
          })
        )

        const run = async (): Promise<void> => {
          const tools = options.tools ? sessionToolsOf(input) : []
          const acquired = await acquire(input.system, tools)
          session = acquired.session
          if (controller.signal.aborted) return
          const fresh = !session.used
          const ctx = { selfId: AGENT_ID, selfName: AGENT_NAME }
          // `syncedThrough` is an absolute position in the conversation; the history given
          // here starts at `historyStart` once old turns have been evicted. A negative
          // offset (our own last turn was evicted) clamps to 0 inside `catchUpBlock`.
          const start = input.historyStart ?? 0
          const earlier = fresh ? primeBlock(input.history, ctx) : catchUpBlock(input.history, syncedThrough - start, ctx)
          syncedThrough = start + input.history.length
          const text = composeMessage({ instructions: acquired.instructions, earlier, context: input.context, text: input.text })

          let textSinceTool = false
          let toolCalls = 0
          let callIds = 0
          const tooMany = input.maxToolRounds
          const toolHandler: ToolHandler = async (name, args) => {
            if (controller.signal.aborted) return { content: "The turn was interrupted.", isError: true }
            if (toolCalls >= tooMany) return { content: "Tool limit reached for this turn: answer with what you have.", isError: true }
            toolCalls++
            // Let text the harness streamed before this call be dispatched first (same event loop,
            // different channels), so "Let me check," is flushed ahead of the tool call.
            await new Promise<void>((resolve) => setImmediate(resolve))
            if (textSinceTool) {
              emit({ _tag: "TextDelta", text: "\n" })
              textSinceTool = false
            }
            const call: ToolCall = { id: `claude-${input.turnId}-${++callIds}`, name, input: args }
            emit({ _tag: "ToolStarted", call })
            const started = performance.now()
            try {
              if (!input.tools.isSpeculative(name)) await Effect.runPromise(input.promoted, { signal: controller.signal })
              const ran = await Effect.runPromise(input.tools.run(call), { signal: controller.signal })
              // A failed tool returns its error as a result (it does not throw): a diagnostic, redacted like the
              // catch path's (after the final review). A successful result is content and passes untouched.
              const result = ran.isError ? { ...ran, content: redact(ran.content, secrets) } : ran
              const ms = Math.round(performance.now() - started)
              input.trace.tools.push({ name, ms })
              emit({ _tag: "ToolFinished", result, ms })
              return { content: result.content, isError: result.isError }
            } catch (e) {
              const ms = Math.round(performance.now() - started)
              const result = { id: call.id, name, content: `Tool did not finish: ${fromUpstream(e, secrets)}`, isError: true }
              emit({ _tag: "ToolFinished", result, ms })
              return { content: result.content, isError: true }
            }
          }

          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new SessionError(`${AGENT_NAME} did not finish within ${turnTimeoutMs / 1000} s`, "timeout"))
            }, turnTimeoutMs)
            const finish = (error?: SessionError) => {
              clearTimeout(timer)
              session!.endTurn()
              if (error !== undefined) reject(error)
              else resolve()
            }
            const onMessage = (m: SDKMessage) => {
              switch (m.type) {
                case "stream_event": {
                  if (m.parent_tool_use_id !== null) return
                  const event = m.event
                  if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text.length > 0) {
                    input.mark("llmFirstToken")
                    textSinceTool = true
                    emit({ _tag: "TextDelta", text: event.delta.text })
                  }
                  return
                }
                case "system": {
                  if (m.subtype === "init" && !session!.initChecked) {
                    session!.initChecked = true
                    const foreign = m.tools.filter((t) => !t.startsWith("mcp__assistant__"))
                    const servers = m.mcp_servers.filter((s) => s.name !== "assistant")
                    if (foreign.length > 0 || servers.length > 0) {
                      const names = [...foreign, ...servers.map((s) => s.name)].slice(0, 5).join(", ")
                      finish(new SessionError(`Claude Code offered tools it should not have (${names}); refusing to continue`, "unavailable"))
                      session!.kill(`unexpected tools: ${names}`)
                    }
                  }
                  return
                }
                case "assistant": {
                  if (m.parent_tool_use_id === null && m.error !== undefined && !emittedText) {
                    const reason = m.error === "rate_limit"
                      ? `${AGENT_NAME}: the plan's usage limit is reached`
                      : isAuthError(m.error)
                      ? `${AGENT_NAME}: Claude Code is not logged in (${m.error}); run claude and log in`
                      : `${AGENT_NAME}: ${redact(String(m.error), secrets)}`
                    finish(new SessionError(reason, m.error === "invalid_request" || m.error === "unknown" ? "failed" : "unavailable"))
                  }
                  return
                }
                case "result": {
                  if (m.subtype === "success" && !m.is_error) return finish()
                  if (m.subtype === "error_max_turns") return finish()
                  // Redacted whole, then shortened (`clip`): a cut first could leave part of a secret unrecognisable.
                  const detail = m.subtype === "success" ? clip(m.result, secrets, 200) : redact(String(m.subtype), secrets)
                  return finish(new SessionError(`${AGENT_NAME} failed: ${detail}`, emittedText ? "failed" : "unavailable"))
                }
                default:
                  return
              }
            }
            const died = (reason: string) => {
              clearTimeout(timer)
              respawnSoon()
              reject(new SessionError(`${AGENT_NAME} stopped: ${reason}`, "unavailable"))
            }
            input.mark("llmRequestSent")
            session!.send(text, { message: onMessage, died }, toolHandler)
          })
        }

        run().then(
          () => {
            if (settled) return
            settled = true
            Queue.endUnsafe(queue)
          },
          (e: unknown) => {
            if (settled) return
            settled = true
            // The SDK's exit errors end with the process's stderr: never shown raw (`safeErrorText`), and the
            // proxy secret is redacted from the message and the cause alike (the cause is a fresh, redacted error).
            const kind = e instanceof SessionError ? e.kind : "failed"
            const message = safeErrorText(e, secrets)
            // A stuck turn: interrupt it (killing the session if that is not acknowledged either).
            if (kind === "timeout") session?.interrupt(interruptAckMs)
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(new AgentError({ message, reason: kind, cause: new SessionError(message, kind) }))
            )
          }
        )
      })
    )

  // Warm up: spawn the session now, so the process start is off the first turn's path.
  // No warm-up *turn*: it would spend quota and put a message in the session.
  const first = await spawn({ system: undefined, tools: [] })
  if (first.login?.apiKeySource !== undefined && first.login.apiKeySource !== "none" && first.login.apiKeySource !== "oauth") {
    closed = true
    first.kill("not a subscription login")
    throw new SessionError(
      redact(`Claude Code is not using a subscription login (it uses ${first.login.apiKeySource}): run claude and log in with your Claude account.`, secrets),
      "unavailable"
    )
  }

  // Idle restart: bounds the memory of a day-long session (untested) and keeps a warm one ready.
  const idleTimer = setInterval(() => {
    const s = current
    if (closed || s === undefined || !s.used || s.dead !== undefined || s.draining !== undefined) return
    if (now() - s.lastUsedAt > idleMs) {
      s.kill("idle")
      respawnSoon()
    }
  }, Math.min(60_000, Math.max(1_000, idleMs / 4)))
  idleTimer.unref?.()

  return {
    turn,
    speculate: options.speculate,
    systemPrompt: options.systemPrompt,
    login: () => login,
    session: () => current,
    settingOptions: () => ({ model: login?.models.length ? login.models : MODELS }),
    info: () => ({
      login: login === undefined ? "" : `Logged in with a ${login.subscriptionType ?? "Claude"} plan`
    }),
    shutdown: () => {
      closed = true
      clearInterval(idleTimer)
      current?.kill("stopped")
    }
  }
}

/** The tool name the harness uses for one of our tools (for logs and tests). */
export { mcpToolName }

const settings = {
  optIn: Setting.boolean({
    label: "Use my Claude subscription",
    description: `${OPT_IN_TEXT}. Anthropic does not clearly allow other software to drive Claude Code with a ` +
      "subscription login; usage counts against your plan's limits. The assistant never reads or stores your Claude " +
      "login: you log in by running claude yourself. Off by default.",
    env: "CLAUDE_SUBSCRIPTION_OPT_IN",
    default: false
  }),
  // A `combo` with the backend's model list once settings widen to v2 (build plan piece G).
  model: Setting.text({
    label: "Model",
    description: "claude-haiku-5-5 (fastest), claude-sonnet-5-5 or claude-opus-5-5.",
    env: "CLAUDE_SUBSCRIPTION_MODEL",
    default: "claude-haiku-5-5",
    maxLength: 100,
    check: (v) => (v.trim() === "" ? "Must not be empty" : undefined)
  }),
  systemPrompt: Setting.text({
    label: "System prompt for this agent",
    description: "Empty: the global prompt (Agents → All agents).",
    multiline: true,
    maxLength: 4000
  }),
  speculate: Setting.boolean({
    label: "Start before I finish speaking",
    description: "Saves about a quarter of a second, but a pause mid-sentence can leave half a sentence in Claude's " +
      "session and uses a message from your plan.",
    default: false
  }),
  tools: Setting.boolean({
    label: "Let Claude use the assistant's tools",
    description: "Lights, weather and the other modules. A tool call adds about two seconds.",
    default: true
  }),
  sessionIdleMinutes: Setting.number({
    label: "Start a fresh session after",
    description: "Minutes without a question to Claude; the new session is told what was said before.",
    default: 60,
    integer: true,
    min: 5,
    max: 1440,
    unit: "min",
    advanced: true
  }),
  claudePath: Setting.text({
    label: "Claude Code program",
    description: "Empty: the copy bundled with the SDK. Or the path to an installed claude.",
    maxLength: 500,
    advanced: true
  }),
  proxy: Setting.secret({
    label: "Proxy for Claude Code",
    description: "Only if Claude Code must reach the internet through a proxy that needs a user name and password: the " +
      "proxy's address with them, for example http://user:password@proxy:8080. Passed to Claude Code as its proxy and kept " +
      "as a secret. A proxy without credentials in the assistant's own environment (HTTPS_PROXY) is passed on by itself; " +
      "one with credentials is not.",
    env: "CLAUDE_SUBSCRIPTION_PROXY"
  }),
  debugLogs: Setting.boolean({
    label: "Claude Code debug logs",
    description: "Lets Claude Code write its debug log files (under its configuration folder, usually ~/.claude). They can " +
      "contain what was said. Only for diagnosing a problem; off by default.",
    default: false,
    advanced: true
  })
}

/**
 * The `claude-subscription` agent module: Claude through the owner's Claude
 * subscription, by driving Claude Code with the Agent SDK. Off by default and
 * behind an explicit opt-in (§1.8).
 */
export const claudeSubscriptionAgentModule = (deps: { readonly sdk?: ClaudeSdk; readonly env?: Readonly<Record<string, string | undefined>> } = {}) =>
  defineAgent({
    id: AGENT_ID,
    name: AGENT_NAME,
    kind: "harness",
    description: "Claude through your Claude subscription (Claude Code). Off unless you opt in: the terms for this use are unclear.",
    enabledByDefault: false,
    settings,
    start: ({ settings: s, setStatus: setStatusRaw }) =>
      Effect.gen(function*() {
        // Every status line, error message and cause this module produces is redacted with the proxy secret.
        const secrets = proxySecrets(s.proxy)
        const setStatus: typeof setStatusRaw = (status) =>
          setStatusRaw(status === undefined ? status : { ...status, text: redact(status.text, secrets).slice(0, 120) })
        if (!s.optIn) return yield* new ModuleStartError({ message: `Switch on "Use my Claude subscription" first: ${OPT_IN_TEXT}.` })
        const proxyProblem = proxyCredentialsProblem(deps.env ?? process.env, s.proxy)
        if (proxyProblem !== undefined) return yield* new ModuleStartError({ message: proxyProblem })
        setStatus({ text: "Starting Claude Code…", tone: "neutral" })
        const agent = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              makeClaudeAgent({
                model: s.model.trim(),
                tools: s.tools,
                speculate: s.speculate,
                systemPrompt: s.systemPrompt,
                sessionIdleMinutes: s.sessionIdleMinutes,
                claudePath: s.claudePath,
                proxy: s.proxy,
                debug: s.debugLogs,
                ...(deps.sdk !== undefined ? { sdk: deps.sdk } : {}),
                ...(deps.env !== undefined ? { env: deps.env } : {})
              }),
            catch: (e) => {
              const text = safeErrorText(e, secrets)
              return new ModuleStartError({
                message: e instanceof SessionError && text.startsWith("Claude Code is not using")
                  ? text
                  : `Claude Code could not start: ${text}. Is it installed and logged in (run claude)?`,
                cause: e instanceof SessionError ? new SessionError(text, e.kind) : new Error(text)
              })
            }
          }),
          (a) => Effect.sync(() => a.shutdown())
        )
        const plan = agent.login()?.subscriptionType
        setStatus({ text: `Ready · ${s.model.trim()}${plan !== undefined ? ` · ${plan} plan` : ""}`, tone: "ok" })
        const { login: _l, shutdown: _s, session: _x, ...implementation } = agent
        return implementation
      })
  })

export const claudeSubscriptionAgent = claudeSubscriptionAgentModule()
