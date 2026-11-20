import {
  CurrentTurn,
  CurrentTurnCommit,
  CurrentTurnTrace,
  type Agent,
  type AgentEvent,
  addTraceEvent,
  beginTraceSpan,
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
import {
  ClaudeSession,
  launchKeyOf,
  type LoginInfo,
  proxySecrets,
  safeErrorText,
  type SessionConfig,
  type SessionEffort,
  SessionError,
  type SessionThinking,
  toolKey
} from "./session.ts"

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
  /**
   * Most Claude Code sessions open at once, one per conversation (docs/VOICE-SESSIONS.md §3). When one more is
   * needed, the least recently used one is closed (it primes from the history again if that conversation comes
   * back). Default 4 (`MAX_VOICE_SESSIONS`'s default).
   */
  readonly maxSessions?: number
}

/**
 * One conversation's options (docs/ASSISTANTS.md §4.1, WP-13a): the assistant's own model and settings, so several
 * assistants can use the one account (its login, program, proxy and debug logs stay the module's, shared). Given with
 * each turn (`withConversationOptions`); a turn without them uses the module's own settings.
 *
 * When they change, the conversation's next turn uses them: a session launched with another model, effort or thinking
 * is replaced by one launched with the new values (told what was said before, as after an idle restart); `tools` and
 * `sessionIdleMinutes` are read at every turn as before.
 */
export interface ClaudeConversationOptions {
  readonly model: string
  /** Absent: Claude Code's default effort for the model. */
  readonly effort?: SessionEffort | undefined
  /** Absent or "off": no extended thinking. */
  readonly thinking?: SessionThinking | undefined
  /** Let Claude use the assistant's tools (the assistant's `useModules`). */
  readonly tools: boolean
  /** A fresh session after this many minutes without a turn; 0 = never (the assistant's `freshSessionAfterMinutes`). */
  readonly sessionIdleMinutes: number
  /**
   * The account's bound on open sessions (docs/ASSISTANTS.md §3.3: `MAX_VOICE_SESSIONS` × the switched-on assistants on
   * the account), read at every turn: the latest value counts for every conversation. Absent: `ClaudeAgentOptions.maxSessions`.
   */
  readonly maxSessions?: number | undefined
}

const CONVERSATION_OPTIONS: unique symbol = Symbol.for("@pva/agent-claude-code/conversation-options") as never

/** The options a turn input carries (`withConversationOptions`), if any. */
export const conversationOptionsOf = (input: AgentTurnInput): ClaudeConversationOptions | undefined =>
  (input as AgentTurnInput & { readonly [CONVERSATION_OPTIONS]?: ClaudeConversationOptions })[CONVERSATION_OPTIONS]

/**
 * The Claude subscription agent answering with one assistant's options: each turn's input carries `options` (read by
 * this package's agent only; any other agent ignores them). Everything else of `agent` (its id, `endConversation`) is kept.
 */
export const withConversationOptions = (agent: Agent, options: ClaudeConversationOptions): Agent => ({
  ...agent,
  turn: (input) => agent.turn({ ...input, [CONVERSATION_OPTIONS]: options } as AgentTurnInput)
})

/** A session is idle-restarted after `minutes` without a turn; 0 = never. */
const idleMsOf = (minutes: number): number => (minutes > 0 ? minutes * 60_000 : Number.POSITIVE_INFINITY)

export const DEFAULTS = {
  startTimeoutMs: 9_000, // the host fails a start after 10 s
  turnTimeoutMs: 30_000,
  interruptAckMs: 1_000,
  bindTimeoutMs: 3_000,
  maxSessions: 4
}

/** How often sessions are checked for an idle restart (the shortest per-conversation idle time is one minute). */
const IDLE_CHECK_MS = 15_000

/** Minimal session states for logs and the status line. */
export interface ClaudeAgentHandle extends AgentImplementation {
  readonly login: () => LoginInfo | undefined
  /** Ends every session (module scope close). */
  readonly shutdown: () => void
  /**
   * For tests and diagnostics: the session of `conversationId`, or without one the most recently used
   * conversation's session (else the warm spare).
   */
  readonly session: (conversationId?: string) => ClaudeSession | undefined
  /** Conversations with an open session, least recently used first (tests, diagnostics). */
  readonly conversations: () => ReadonlyArray<string>
  /** The bound on open sessions now (the latest turn's `maxSessions`, else the module's). Tests, diagnostics. */
  readonly sessionLimit: () => number
  /** Close the Claude Code session of a conversation that has ended (New conversation, a discarded voice session). */
  readonly endConversation: (conversationId: string) => Effect.Effect<void>
}

/** One conversation's Claude Code session and its catch-up position. */
interface Slot {
  readonly conversationId: string
  session: ClaudeSession | undefined
  /** The session being started for this conversation. */
  starting: Promise<ClaudeSession> | undefined
  /** Shared-history index at the start of this conversation's last turn here (catch-up, §1.4). */
  syncedThrough: number
  /** Its options' idle restart (ms; `Infinity`: never), from its last turn. */
  idleMs: number
  /**
   * The end of the last queued turn's acquisition (`queued`): every turn of the conversation takes, retunes and binds
   * its session only after the ones before it finished (a cancelled turn's retune included), up to sending its message.
   */
  queue: Promise<void>
}

type Launch = Pick<SessionConfig, "model" | "effort" | "thinking">

const sessionToolsOf = (input: AgentTurnInput): ReadonlyArray<SessionTool> =>
  input.tools.specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema }))

const isAuthError = (e: string | undefined) =>
  e === "authentication_failed" || e === "oauth_org_not_allowed" || e === "account_on_hold" || e === "billing_error" ||
  e === "verification_required"

/**
 * The Claude subscription agent's behaviour, independent of the module
 * plumbing. `start` spawns a warm (provisional) session and checks the login
 * (once, for every conversation). Each conversation (`AgentTurnInput.conversationId`)
 * gets its own session, opened at its first turn (the warm spare when there is one),
 * with its own catch-up position; turns of different conversations run in parallel.
 * A conversation's session is restarted when the prompt or the tools changed, after a
 * crash or a stuck interrupt, and when the turn's options (`withConversationOptions`: the
 * assistant's model, effort, thinking) differ from those it was launched with; it is closed
 * after the conversation's `sessionIdleMinutes` without a turn, by `endConversation`, and
 * (least recently used first) when `maxSessions` are open and another conversation needs one.
 */
export const makeClaudeAgent = async (options: ClaudeAgentOptions): Promise<ClaudeAgentHandle> => {
  const sdk = options.sdk ?? (await loadClaudeSdk())
  const now = options.now ?? Date.now
  const env = options.env ?? process.env
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULTS.startTimeoutMs
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULTS.turnTimeoutMs
  const interruptAckMs = options.interruptAckMs ?? DEFAULTS.interruptAckMs
  /** The module's own settings: a turn without options (`withConversationOptions`) uses them. */
  const defaults: ClaudeConversationOptions = { model: options.model, tools: options.tools, sessionIdleMinutes: options.sessionIdleMinutes }
  /** Every error text this agent produces is redacted with these (the proxy secret: `proxySecrets`). */
  const secrets = proxySecrets(options.proxy)

  /** The bound on open sessions: the module's, until a turn's options name the account's (the latest counts). */
  let maxSessions = Math.max(1, options.maxSessions ?? DEFAULTS.maxSessions)

  let closed = false
  /** Conversations with a session (open or starting), least recently used first (re-inserted at every turn). */
  const slots = new Map<string, Slot>()
  /**
   * A warm session not yet given to a conversation: the one spawned at start (provisional), or a replacement
   * started in the background after one closed. The next conversation that needs a session takes it.
   */
  let spare: { session: ClaudeSession; ready: Promise<ClaudeSession> } | undefined
  /**
   * The last real prompt, tool set and launch options, so a replacement session is spawned with them (warm, not
   * provisional). With several assistants on the account it is the last turn's: the spare fits that assistant.
   */
  let known: { system: string; tools: ReadonlyArray<SessionTool>; launch: Launch } | undefined
  let login: LoginInfo | undefined

  const spawn = (config: Omit<SessionConfig, "claudePath" | "env" | "proxy" | "debug">) => {
    const session = new ClaudeSession(sdk, { ...config, claudePath: options.claudePath, env, proxy: options.proxy, debug: options.debug === true }, now)
    const ready = session.start(startTimeoutMs).then((info) => {
      login = info
      return session
    })
    return { session, ready }
  }

  /** Sessions that hold (or are starting) a Claude Code process for a conversation. */
  const boundCount = () => {
    let n = 0
    for (const slot of slots.values()) if (slot.starting !== undefined || (slot.session !== undefined && slot.session.dead === undefined)) n++
    return n
  }

  /** Start a replacement in the background, so the next turn finds a warm session (if there is room for one). */
  const respawnSoon = () => {
    if (closed || spare !== undefined || boundCount() >= maxSessions) return
    const s = spawn(known !== undefined ? { system: known.system, tools: known.tools, ...known.launch } : { system: undefined, tools: [], model: options.model })
    spare = s
    s.ready.catch(() => {
      if (spare === s) spare = undefined
    })
  }

  const closeSlot = (slot: Slot, reason: string) => {
    if (slots.get(slot.conversationId) === slot) slots.delete(slot.conversationId)
    slot.session?.kill(reason)
    slot.starting?.then((s) => s.kill(reason), () => {})
    slot.session = undefined
  }

  /** Make room for one more conversation's session: close the least recently used one (an idle one first). */
  const makeRoom = (forSlot: Slot) => {
    while (boundCount() >= maxSessions) {
      const others = [...slots.values()].filter((s) => s !== forSlot && (s.starting !== undefined || (s.session !== undefined && s.session.dead === undefined)))
      const victim = others.find((s) => s.starting === undefined && s.session?.inTurn === false && s.session.draining === undefined) ?? others[0]
      if (victim === undefined) return
      closeSlot(victim, "closed for another conversation")
    }
  }

  /**
   * Bring `session` to `launch` (model, effort) in place; `false` (and the session killed) when Claude Code did not
   * confirm, or the thinking differs, which only a new session can change.
   */
  const retuned = async (session: ClaudeSession, launch: Launch): Promise<boolean> => {
    if (session.launch === launchKeyOf(launch)) return true
    if (session.thinking !== (launch.thinking ?? "off")) return false
    try {
      await session.retune(launch, DEFAULTS.bindTimeoutMs)
      return true
    } catch (e) {
      session.kill(`could not change the model or effort: ${safeErrorText(e, secrets)}`)
      return false
    }
  }

  /** A session for `slot`: the warm spare if it fits, else a new one (closing the least recently used if needed). */
  const take = async (slot: Slot, system: string, tools: ReadonlyArray<SessionTool>, launch: Launch): Promise<ClaudeSession> => {
    const key = toolKey(tools)
    const s = spare
    spare = undefined
    if (s !== undefined) {
      const ready = await s.ready.catch(() => undefined)
      if (ready !== undefined && ready.dead === undefined && !ready.used &&
        (ready.provisional || (ready.system === system && ready.toolKey === key)) && await retuned(ready, launch)) {
        // The bound may have shrunk since the spare was started (an assistant on the account switched off).
        makeRoom(slot)
        slot.session = ready
        return ready
      }
      s.session.kill("replaced")
    }
    makeRoom(slot)
    const started = spawn({ system, tools, ...launch })
    slot.session = started.session
    slot.starting = started.ready
    try {
      return await started.ready
    } finally {
      if (slot.starting === started.ready) slot.starting = undefined
    }
  }

  const slotFor = (conversationId: string): Slot => {
    let slot = slots.get(conversationId)
    if (slot === undefined) {
      slot = { conversationId, session: undefined, starting: undefined, syncedThrough: 0, idleMs: idleMsOf(defaults.sessionIdleMinutes), queue: Promise.resolve() }
    }
    // Most recently used last.
    slots.delete(conversationId)
    slots.set(conversationId, slot)
    return slot
  }

  /**
   * Wait for the turns of `slot` queued before this one (their acquisition, retune and bind, up to sending their message
   * or giving up), then hold the queue: resolves with the release (idempotent). The queue does not depend on the turns'
   * streams, so a cancelled turn's pending retune still holds it until Claude Code confirmed it or the session was killed,
   * and the next turn compares its options with what the session acknowledged.
   */
  const queued = (slot: Slot): Promise<() => void> => {
    const before = slot.queue
    let release!: () => void
    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    slot.queue = before.then(() => mine)
    return before.then(() => release)
  }

  /** A ready session for this turn's conversation, prompt and tools, and the instructions to prepend when binding a provisional one. */
  const acquire = async (
    slot: Slot,
    system: string,
    tools: ReadonlyArray<SessionTool>,
    launch: Launch,
    signal: AbortSignal
  ): Promise<{ session: ClaudeSession; instructions?: string }> => {
    if (closed) throw new SessionError(`${AGENT_NAME} is stopped`, "unavailable")
    let session = slot.starting !== undefined ? await slot.starting.catch(() => undefined) : slot.session
    if (session?.draining !== undefined) await session.draining
    const key = toolKey(tools)
    let stale = session === undefined || session.dead !== undefined ||
      (session.used && now() - session.lastUsedAt > slot.idleMs) ||
      (!session.provisional && (session.system !== system || session.toolKey !== key)) ||
      (session.provisional && session.used)
    // The assistant's model or effort changed: the session answers with the new ones from this turn on (it keeps
    // what was said). Other thinking, or a change Claude Code does not confirm: a new session, told what was said.
    if (!stale && !(await retuned(session!, launch))) stale = true
    if (stale) {
      session?.kill("replaced")
      slot.session = undefined
      // The turn was cancelled meanwhile (its retune was refused or timed out): no new session for it; the next turn starts one.
      if (signal.aborted) throw new SessionError(`${AGENT_NAME}: the turn was interrupted`, "failed")
      if (slots.get(slot.conversationId) !== slot) slots.set(slot.conversationId, slot) // closed meanwhile: open again
      session = await take(slot, system, tools, launch)
    }
    if (closed) throw new SessionError(`${AGENT_NAME} is stopped`, "unavailable")
    known = { system, tools, launch }
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
        // The SDK calls tools from outside this fiber: the turn's context is captured here and given to each call, with
        // the turn's trace (the execution gateway records its risk decisions there).
        const currentTurn = yield* CurrentTurn
        const currentCommit = yield* CurrentTurnCommit
        const runTool = (call: ToolCall) => input.tools.run(call).pipe(
          Effect.provideService(CurrentTurn, currentTurn),
          Effect.provideService(CurrentTurnCommit, currentCommit),
          Effect.provideService(CurrentTurnTrace, input.trace)
        )
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
          const conversation = conversationOptionsOf(input) ?? defaults
          if (conversation.maxSessions !== undefined) maxSessions = Math.max(1, Math.floor(conversation.maxSessions))
          const tools = conversation.tools ? sessionToolsOf(input) : []
          const launch: Launch = {
            model: conversation.model.trim() === "" ? options.model : conversation.model.trim(),
            ...(conversation.effort !== undefined ? { effort: conversation.effort } : {}),
            ...(conversation.thinking !== undefined ? { thinking: conversation.thinking } : {})
          }
          const slot = slotFor(input.conversationId)
          slot.idleMs = idleMsOf(conversation.sessionIdleMinutes)
          // One turn at a time takes and tunes the conversation's session (`queued`); released once the message is sent.
          const release = await queued(slot)
          try {
            await sendTurn(slot, tools, launch, release)
          } finally {
            release()
          }
        }

        const sendTurn = async (slot: Slot, tools: ReadonlyArray<SessionTool>, launch: Launch, release: () => void): Promise<void> => {
          // Cancelled while waiting: abandoned, before it touched the session.
          if (controller.signal.aborted) return
          const acquired = await acquire(slot, input.system, tools, launch, controller.signal)
          session = acquired.session
          if (controller.signal.aborted) return
          const fresh = !session.used
          const ctx = { selfId: AGENT_ID, selfName: AGENT_NAME }
          // `syncedThrough` is an absolute position in the conversation; the history given
          // here starts at `historyStart` once old turns have been evicted. A negative
          // offset (our own last turn was evicted) clamps to 0 inside `catchUpBlock`.
          const start = input.historyStart ?? 0
          const earlier = fresh ? primeBlock(input.history, ctx) : catchUpBlock(input.history, slot.syncedThrough - start, ctx)
          slot.syncedThrough = start + input.history.length
          const text = composeMessage({ instructions: acquired.instructions, earlier, context: input.context, text: input.text })

          /** The trace clock (`input.now`), the scale of every mark and time-line entry of the turn. */
          const clock = input.now ?? (() => performance.now())
          let textSinceTool = false
          /** This call's first text was recorded on the time line. */
          let firstToken = false
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
            let started = clock()
            let span: ReturnType<typeof beginTraceSpan> | undefined
            // Cancelled while this call waited (the native yield, or promotion): it does not start. Checked inside the
            // effect, so even an effect that would finish synchronously never runs after cancellation.
            const live = <A>(effect: Effect.Effect<A>): Effect.Effect<A, SessionError> =>
              Effect.suspend(() => (controller.signal.aborted ? Effect.fail(new SessionError("the turn was interrupted", "failed")) : effect))
            try {
              if (!input.tools.isSpeculative(name)) await Effect.runPromise(live(input.promoted), { signal: controller.signal })
              // The tool's own time: after the wait for the turn to be confirmed (a speculative turn's tool span must not begin before 0).
              started = clock()
              // Recorded at its start: a tool still running when the turn is interrupted is on the time line too.
              span = beginTraceSpan(input.trace, "tool", started, name)
              const ran = await Effect.runPromise(live(runTool(call)), { signal: controller.signal })
              // A failed tool returns its error as a result (it does not throw): a diagnostic, redacted like the
              // catch path's (after the final review). A successful result is content and passes untouched.
              const result = ran.isError ? { ...ran, content: redact(ran.content, secrets) } : ran
              const ms = Math.round(clock() - started)
              input.trace.tools.push({ name, ms })
              span?.end(started + ms)
              emit({ _tag: "ToolFinished", result, ms })
              return { content: result.content, isError: result.isError }
            } catch (e) {
              const ms = Math.round(clock() - started)
              span?.end(started + ms)
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
                    if (!firstToken) {
                      firstToken = true
                      addTraceEvent(input.trace, "llmFirstToken", clock())
                    }
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
                  if (m.parent_tool_use_id === null && typeof m.message?.model === "string") session!.answeredWith = m.message.model
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
                  if (m.subtype === "success" && !m.is_error) {
                    addTraceEvent(input.trace, "llmDone", clock())
                    return finish()
                  }
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
            // Its own entry too: after a failed agent's request in the same turn (a fallback) the first-only mark is
            // that agent's, and the time line pairs this call's `llmDone` with the latest request. With an entry the
            // published time line leaves the mark out (no duplicate).
            addTraceEvent(input.trace, "llmRequestSent", clock())
            firstToken = false
            try {
              session!.send(text, { message: onMessage, died }, toolHandler)
            } finally {
              release()
            }
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
  const warm = spawn({ system: undefined, tools: [], model: options.model })
  const first = await warm.ready
  spare = warm
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
    if (closed) return
    let closedOne = false
    for (const slot of [...slots.values()]) {
      const s = slot.session
      if (slot.starting !== undefined || s === undefined || !s.used || s.dead !== undefined || s.draining !== undefined || s.inTurn) continue
      if (now() - s.lastUsedAt > slot.idleMs) {
        closeSlot(slot, "idle")
        closedOne = true
      }
    }
    if (closedOne) respawnSoon()
  }, Math.min(60_000, Math.max(1_000, IDLE_CHECK_MS)))
  idleTimer.unref?.()

  return {
    turn,
    speculate: options.speculate,
    systemPrompt: options.systemPrompt,
    login: () => login,
    session: (conversationId) => {
      if (conversationId !== undefined) return slots.get(conversationId)?.session
      return [...slots.values()].at(-1)?.session ?? spare?.session
    },
    conversations: () => [...slots.keys()],
    sessionLimit: () => maxSessions,
    endConversation: (conversationId) =>
      Effect.sync(() => {
        const slot = slots.get(conversationId)
        if (slot === undefined) return
        closeSlot(slot, "the conversation ended")
        // Keep a warm session for the next conversation.
        respawnSoon()
      }),
    settingOptions: () => ({ model: login?.models.length ? login.models : MODELS }),
    info: () => ({
      login: login === undefined ? "" : `Logged in with a ${login.subscriptionType ?? "Claude"} plan`
    }),
    shutdown: () => {
      closed = true
      clearInterval(idleTimer)
      for (const slot of [...slots.values()]) closeSlot(slot, "stopped")
      spare?.session.kill("stopped")
      spare = undefined
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
    description: "Minutes without a question to Claude; the new session is told what was said before. 0 = never.",
    default: 60,
    integer: true,
    min: 0,
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
export const claudeSubscriptionAgentModule = (
  deps: {
    readonly sdk?: ClaudeSdk
    readonly env?: Readonly<Record<string, string | undefined>>
    /** Most Claude Code sessions at once (one per conversation; the assistant's `MAX_VOICE_SESSIONS`). Default 4. */
    readonly maxSessions?: number
  } = {}
) =>
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
                ...(deps.maxSessions !== undefined ? { maxSessions: deps.maxSessions } : {}),
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
        const { conversations: _c, login: _l, shutdown: _s, session: _x, sessionLimit: _m, ...implementation } = agent
        return implementation
      })
  })

export const claudeSubscriptionAgent = claudeSubscriptionAgentModule()
