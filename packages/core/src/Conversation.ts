import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import type { Agent, AgentEvent, AgentTurnInput } from "./Agent.ts"
import { AgentError } from "./Agent.ts"
import { type ClauseChunkerOptions, chunkClauses } from "./ClauseChunker.ts"
import type {
  AgentSet,
  AgentTurnSetup,
  ConversationEvent,
  ConversationInput,
  PlaybackObserver,
  TurnSetup
} from "./ConversationEvents.ts"
import type { DecisionProvider } from "./Decision.ts"
import type { Message, ToolCall, ToolResult } from "./Domain.ts"
import { type AudioError, LlmError, type SttError, type TtsError } from "./Errors.ts"
import { makeModelAgent } from "./ModelAgent.ts"
import { armAgent, initialRouterState, type RouteDecision, type Router, type RouterState, setActiveAgent } from "./Routing.ts"
import { AudioInput, AudioOutput, Llm, Stt, Tts, type TtsAudio } from "./Services.ts"
import { ToolRegistry } from "./ToolRegistry.ts"
import { CurrentTurnTrace, type Trace, TurnTrace, type TurnOutcome } from "./TurnTrace.ts"

interface CommonOptions {
  /** Maximum tool rounds per turn (LLM calls are capped at this + 1). Default 5. */
  readonly maxToolRounds?: number
  /** Interrupt the assistant when the user starts speaking over it. Default true. */
  readonly bargeIn?: boolean
  readonly chunker?: ClauseChunkerOptions
  /**
   * Called synchronously for everything that happens in a turn (see
   * `ConversationEvent`). Must not block; exceptions are caught and ignored.
   */
  readonly onEvent?: (event: ConversationEvent) => void
  /** History to start from (an engine reload keeps the conversation). */
  readonly initialHistory?: ReadonlyArray<Message>
}

export interface ConversationOptions extends CommonOptions {
  readonly systemPrompt: string
}

/** Options for a conversation whose system prompt and tools can change between turns. */
export interface ConversationSetupOptions extends CommonOptions {
  /**
   * Evaluated once at the start of every turn (voice and text): the system
   * prompt and the tool registry that turn uses from start to end, even if a
   * newer setup is published while it runs.
   */
  readonly setup: Effect.Effect<TurnSetup>
}

/** Options for a conversation answered by several agents, chosen per turn by a router (docs/AGENTS-AND-INTENTS.md §1.12). */
export interface AgentConversationOptions extends CommonOptions {
  /**
   * Read once at the start of every turn, before `TurnStarted` (keep it a
   * reference read): prompt, tools, agents and router for that turn. Context
   * providers still run inside the turn.
   */
  readonly setup: Effect.Effect<AgentTurnSetup>
  /** Routing state to start from (an engine reload keeps a sticky agent). */
  readonly initialRouterState?: RouterState
}

/**
 * The orchestrator. `voice` consumes `SttEvent`s and owns at most one turn
 * fiber; `textTurn` runs a single turn without any audio services. Both share
 * the history, the routing state and the agent code path.
 */
export class Conversation extends Context.Service<Conversation, {
  /**
   * Run the voice loop over `events` (speech recognition events, typed
   * messages and Stop) until the stream ends; then waits for the last
   * committed turn to finish playing.
   */
  voice<E>(events: Stream.Stream<ConversationInput, E>): Effect.Effect<void, E, Tts | AudioOutput>
  /**
   * One text turn: text in, assistant text deltas out (rounds separated by "\n").
   * Routed like speech unless `agentId` names the agent. Agent failures arrive as `LlmError`.
   */
  textTurn(text: string, options?: { readonly agentId?: string | undefined }): Stream.Stream<string, LlmError>
  readonly history: Effect.Effect<ReadonlyArray<Message>>
  /** The routing state (sticky and armed agents); always empty in a single-model conversation. */
  readonly routerState: Effect.Effect<RouterState>
}>()("@pva/core/Conversation") {
  static readonly layer = (options: ConversationOptions) =>
    Layer.effect(Conversation, makeConversation(options))
  /** A conversation that reads its system prompt and tools from `setup` at the start of each turn (no `ToolRegistry` needed). */
  static readonly layerWithSetup = (options: ConversationSetupOptions) =>
    Layer.effect(Conversation, makeConversationWithSetup(options))
  /** A conversation answered by the agents of each turn's setup (no `Llm` needed). */
  static readonly layerWithAgents = (options: AgentConversationOptions) =>
    Layer.effect(Conversation, makeAgentConversation(options))
}

/** Microphone → Stt → Conversation → Tts → speaker, until the input ends. */
export const runVoice: Effect.Effect<
  void,
  AudioError | SttError,
  Conversation | AudioInput | Stt | Tts | AudioOutput
> = Effect.gen(function*() {
  const conversation = yield* Conversation
  const input = yield* AudioInput
  const stt = yield* Stt
  yield* conversation.voice(stt.transcribe(input.stream))
})

/** Spoken when no agent is running at all. */
export const NO_AGENT_TEXT = "No agent is available right now. Check the agents in the options."
/** Spoken when an agent passed a turn on and no conversational agent can take it. */
export const CANNOT_HELP_TEXT = "I can't help with that right now."
export const notAvailableText = (name: string) => `${name} isn't available.`

/** A router that always picks `agentId` and keeps no state (single-agent conversations). */
export const singleAgentRouter = (agentId: string): Router => ({
  route: (input) => ({ agentId, reason: "default", text: input.text, next: initialRouterState }),
  matchTrigger: () => undefined
})

/** Normalised transcript comparison for promoting a speculative turn. */
const sameText = (a: string, b: string) => normalize(a) === normalize(b)
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim()

const sameState = (a: RouterState, b: RouterState) =>
  a.sticky?.agentId === b.sticky?.agentId && a.sticky?.lastUsedAt === b.sticky?.lastUsedAt &&
  a.armed?.agentId === b.armed?.agentId && a.armed?.until === b.armed?.until

interface Round {
  /** Full text the agent said in this round. */
  text: string
  readonly toolCalls: Array<ToolCall>
  /** Set once every tool call of the round has a result (in call order). */
  results?: ReadonlyArray<ToolResult>
  partial?: Map<string, ToolResult>
}

/** What a turn produced so far; turned into history when the turn ends. */
interface TurnLog {
  /** The user message as recorded: what the agent received (trigger phrase removed). */
  readonly user: string
  readonly rounds: Array<Round>
  /** Spoken turns only: clauses sent to TTS, in order, with the round they belong to (-1: a notice, never recorded). */
  readonly clauses: Array<{ readonly text: string; readonly round: number }>
  /** Spoken turns only: number of clauses whose audio started playing. */
  played: number
  /** A canned reply: nothing is recorded. */
  readonly canned: boolean
  /** The agent whose words the rounds hold (the fallback agent after a hand-off). */
  agentId?: string
}

/** How a turn will be answered, decided synchronously at its start. */
interface TurnPlan {
  readonly setup?: AgentTurnSetup
  readonly decision?: RouteDecision
  readonly agent?: Agent
  /** Speak this instead of running an agent. */
  readonly canned?: string
  /** Spoken before the agent's answer ("Codex isn't available."). */
  readonly notice?: string
}

interface ActiveTurn {
  readonly text: string
  readonly source: "voice" | "text"
  /** The reply is synthesised and played (voice turns; typed turns with `speak`). */
  readonly spoken: boolean
  /** Speculative and not promoted yet: must not play or write history. */
  pending: boolean
  /** First audio chunk handed to the speaker. */
  speaking: boolean
  done: boolean
  readonly promoted: Deferred.Deferred<void>
  readonly trace: Trace
  readonly plan: TurnPlan
  /** An agent asked for a reply while the turn was still pending: arm it at promotion. */
  expectReply?: string
  fiber?: Fiber.Fiber<void>
}

interface ReplyContext {
  readonly plan: TurnPlan
  readonly log: TurnLog
  readonly trace: Trace
  readonly utterance: string
  readonly source: "voice" | "text"
  readonly spoken: boolean
  readonly speculative: boolean
  readonly promoted: Effect.Effect<void>
  readonly history: ReadonlyArray<Message>
  readonly expectReply: (agentId: string) => void
}

const noDeciders: ReadonlyMap<string, DecisionProvider> = new Map()
const HANDOFF = Symbol("handoff")

export const makeConversation = Effect.fnUntraced(function*(options: ConversationOptions) {
  const registry = yield* ToolRegistry
  return yield* makeConversationWithSetup({ ...options, setup: Effect.succeed({ system: options.systemPrompt, registry }) })
})

/**
 * A single-model conversation: one `model` agent over the `Llm` service, always
 * chosen, no first-event timeout. Behaves exactly as before agents existed:
 * events and history carry no agent fields.
 */
export const makeConversationWithSetup = Effect.fnUntraced(function*(options: ConversationSetupOptions) {
  const llm = yield* Llm
  const agent: Agent = {
    id: "llm",
    name: "Assistant",
    kind: "model",
    speculate: true,
    firstEventTimeoutMs: Number.POSITIVE_INFINITY,
    turn: makeModelAgent({ llm }).turn
  }
  const agents: AgentSet = { router: singleAgentRouter(agent.id), agents: new Map([[agent.id, agent]]), defaultAgent: agent.id }
  return yield* makeConversationCore(
    { ...options, setup: Effect.map(options.setup, (s): AgentTurnSetup => ({ system: s.system, registry: s.registry, agents })) },
    true
  )
})

/** A conversation answered by agents, routed per turn (docs/AGENTS-AND-INTENTS.md §1.3). */
export const makeAgentConversation = (options: AgentConversationOptions) => makeConversationCore(options, false)

const makeConversationCore = Effect.fnUntraced(function*(options: AgentConversationOptions, legacy: boolean) {
  const tt = yield* TurnTrace
  const bargeIn = options.bargeIn ?? true
  const chunk = chunkClauses(options.chunker)
  const onEvent = options.onEvent

  const history: Array<Message> = [...(options.initialHistory ?? [])]
  let routerState: RouterState = options.initialRouterState ?? initialRouterState

  const emit = onEvent === undefined
    ? (_event: ConversationEvent) => {}
    : (event: ConversationEvent) => {
      try {
        onEvent(event)
      } catch {
        // A subscriber must never break a turn.
      }
    }

  // -------------------------------------------------------------------------
  // Routing

  const setRouterState = (next: RouterState, always = false) => {
    const changed = !sameState(routerState, next)
    routerState = next
    if (!legacy && (changed || always)) emit({ _tag: "RoutingChanged", state: next })
  }

  const nameOf = (set: AgentSet, id: string) => set.names?.get(id) ?? set.agents.get(id)?.name ?? id

  const planTurn = (setup: AgentTurnSetup, text: string, source: "voice" | "text", explicitAgent: string | undefined): TurnPlan => {
    const set = setup.agents
    const decision = set.router.route({ text, source, explicitAgent, state: routerState, now: tt.now(), isAvailable: (id) => set.agents.has(id) })
    if (decision.agentId === undefined) return { setup, decision, canned: NO_AGENT_TEXT }
    if (decision.acknowledge !== undefined) {
      return { setup, decision, canned: decision.unavailable !== undefined ? notAvailableText(nameOf(set, decision.unavailable)) : decision.acknowledge }
    }
    const agent = set.agents.get(decision.agentId)!
    return decision.unavailable !== undefined && decision.reason !== "default"
      ? { setup, decision, agent, notice: notAvailableText(nameOf(set, decision.unavailable)) }
      : { setup, decision, agent }
  }

  /** Apply the turn's routing outcome; called when the turn is committed (a discarded turn changes nothing). */
  const commitRouting = (plan: TurnPlan) => {
    if (plan.decision !== undefined) setRouterState(plan.decision.next)
  }

  const armFor = (set: AgentSet | undefined, agentId: string) =>
    setRouterState(armAgent(routerState, agentId, tt.now(), set?.armedMs ?? 10_000))

  const setTraceAgent = (trace: Trace, agent: Agent, decision: RouteDecision, fallbackFrom: string | undefined) => {
    if (legacy) return
    trace.agent = {
      id: agent.id,
      kind: agent.kind,
      routedBy: decision.reason,
      ...(fallbackFrom !== undefined ? { fallbackFrom } : {})
    }
  }

  const turnStarted = (
    trace: Trace,
    source: "voice" | "text",
    text: string,
    speculative: boolean,
    spoken: boolean,
    plan: TurnPlan
  ): ConversationEvent => {
    const base = { _tag: "TurnStarted", turnId: trace.id, source, text, speculative, spoken } as const
    if (legacy) return base
    const d = plan.decision
    return {
      ...base,
      ...(d?.agentId !== undefined ? { agentId: d.agentId } : {}),
      ...(d !== undefined ? { routedBy: d.reason, agentText: d.text } : {}),
      ...(d?.unavailable !== undefined ? { fallbackFrom: d.unavailable } : {}),
      ...(plan.canned !== undefined ? { canned: true } : {})
    }
  }

  // -------------------------------------------------------------------------
  // The reply: agent events → text deltas (spoken) + rounds (history) + events (UI)

  const openRound = (log: TurnLog): Round => {
    const round: Round = { text: "", toolCalls: [] }
    log.rounds.push(round)
    return round
  }
  const openRoundOf = (log: TurnLog): Round => {
    const last = log.rounds[log.rounds.length - 1]
    return last !== undefined && last.results === undefined ? last : openRound(log)
  }
  const addResult = (log: TurnLog, result: ToolResult) => {
    for (let i = log.rounds.length - 1; i >= 0; i--) {
      const round = log.rounds[i]!
      if (round.results !== undefined || !round.toolCalls.some((c) => c.id === result.id)) continue
      const partial = round.partial ?? (round.partial = new Map())
      partial.set(result.id, result)
      if (partial.size === round.toolCalls.length) {
        round.results = round.toolCalls.map((c) => partial.get(c.id)!)
        delete round.partial
      }
      return
    }
  }

  /** Text that is spoken and shown but not recorded (notices, canned replies). `flush` makes it its own clause. */
  const unrecorded = (turnId: number, text: string, flush: boolean): Stream.Stream<string> =>
    Stream.suspend(() => {
      emit({ _tag: "TextDelta", turnId, text })
      if (!flush) return Stream.make(text)
      emit({ _tag: "TextDelta", turnId, text: "\n" })
      return Stream.make(text, "\n")
    })

  /** Text recorded as the agent's reply. */
  const recorded = (log: TurnLog, turnId: number, text: string): Stream.Stream<string> =>
    Stream.suspend(() => {
      openRoundOf(log).text += text
      emit({ _tag: "TextDelta", turnId, text })
      return Stream.make(text)
    })

  const fallbackFor = (set: AgentSet, agent: Agent): Agent | undefined => {
    const byDefault = set.agents.get(set.defaultAgent)
    if (byDefault !== undefined && byDefault !== agent && byDefault.kind !== "intent") return byDefault
    const fallback = set.fallbackAgent === undefined ? undefined : set.agents.get(set.fallbackAgent)
    return fallback !== undefined && fallback !== agent ? fallback : undefined
  }

  /** Fails the stream with `timeout` when it emits nothing within the agent's limit. Costs one timer fiber, nothing per event. */
  const withFirstEventTimeout = <E>(stream: Stream.Stream<AgentEvent, E>, agent: Agent): Stream.Stream<AgentEvent, E | AgentError> =>
    Stream.suspend(() => {
      let seen = false
      const ms = agent.firstEventTimeoutMs
      const timer = Stream.fromEffectDrain(Effect.sleep(ms).pipe(
        Effect.andThen(Effect.suspend(() =>
          seen ? Effect.void : Effect.fail(new AgentError({ message: `${agent.name} did not answer within ${ms} ms`, reason: "timeout" }))
        ))
      ))
      return stream.pipe(
        Stream.mapArray((events) => {
          seen = true
          return events
        }),
        Stream.merge(timer, { haltStrategy: "left" })
      )
    })

  const agentEvents = (agent: Agent, input: AgentTurnInput): Stream.Stream<AgentEvent, AgentError> => {
    let stream: Stream.Stream<AgentEvent, AgentError> = Stream.suspend(() => agent.turn(input))
    if (Number.isFinite(agent.firstEventTimeoutMs) && agent.firstEventTimeoutMs > 0) stream = withFirstEventTimeout(stream, agent)
    // A harness that cannot take a message back starts only once the turn is committed.
    if (!agent.speculate && input.speculative) stream = Stream.fromEffectDrain(input.promoted).pipe(Stream.concat(stream))
    return stream
  }

  const reply = (ctx: ReplyContext): Stream.Stream<string, AgentError> =>
    Stream.suspend(() => {
      const { log, plan, trace } = ctx
      const turnId = trace.id
      if (plan.canned !== undefined) return unrecorded(turnId, plan.canned, false)
      const setup = plan.setup!
      const decision = plan.decision!
      const set = setup.agents
      const maxToolRounds = set.maxToolRounds ?? options.maxToolRounds ?? 5

      return Stream.unwrap(Effect.map(setup.registry.context, (context) => {
        const inputFor = (agent: Agent): AgentTurnInput => ({
          turnId,
          text: decision.text,
          utterance: ctx.utterance,
          source: ctx.source,
          spoken: ctx.spoken,
          routedBy: decision.reason,
          history: ctx.history,
          system: set.promptFor === undefined ? setup.system : set.promptFor(agent),
          context: context.length === 0 ? undefined : context,
          tools: setup.registry,
          actions: set.actions ?? [],
          deciders: set.deciders ?? noDeciders,
          promoted: ctx.promoted,
          speculative: ctx.speculative,
          mark: (mark) => tt.mark(trace, mark),
          trace,
          now: tt.now,
          maxToolRounds
        })

        const run = (agent: Agent, attempt: number): Stream.Stream<string, AgentError> =>
          Stream.suspend(() => {
            log.agentId = agent.id
            let said = false
            let acted = false
            let handoff: string | undefined
            const handle = (event: AgentEvent): string | typeof HANDOFF | undefined => {
              switch (event._tag) {
                case "TextDelta": {
                  if (event.text.length === 0) return undefined
                  if (event.text !== "\n") {
                    said = true
                    openRoundOf(log).text += event.text
                  }
                  emit({ _tag: "TextDelta", turnId, text: event.text })
                  return event.text
                }
                case "ToolStarted":
                  acted = true
                  openRoundOf(log).toolCalls.push(event.call)
                  emit({ _tag: "ToolStarted", turnId, call: event.call })
                  return undefined
                case "ToolFinished":
                  addResult(log, event.result)
                  emit({ _tag: "ToolFinished", turnId, result: event.result, ms: event.ms })
                  return undefined
                case "Decision":
                  emit({ _tag: "IntentDecided", turnId, agentId: agent.id, decision: event.decision })
                  return undefined
                case "ActionStarted":
                  acted = true
                  emit({ ...event, turnId })
                  return undefined
                case "ActionFinished":
                  emit({ ...event, turnId })
                  return undefined
                case "ExpectReply":
                  ctx.expectReply(agent.id)
                  return undefined
                case "Handoff":
                  if (said) return undefined // too late: the agent already spoke (a defect of the agent; ignored)
                  handoff = event.reason
                  return HANDOFF
              }
            }

            const events = agentEvents(agent, inputFor(agent)).pipe(
              Stream.map(handle),
              Stream.takeUntil((x) => x === HANDOFF, { excludeLast: true }),
              Stream.filter((x): x is string => typeof x === "string"),
              Stream.catchTag("AgentError", (error) => {
                const fallback = attempt === 0 && !said && !acted ? fallbackFor(set, agent) : undefined
                if (fallback === undefined) return Stream.fail(error)
                // Failed before saying or doing anything: the same turn, once, on the fallback agent.
                emit({ _tag: "TurnAgentChanged", turnId, agentId: fallback.id, from: agent.id, reason: "failed" })
                setTraceAgent(trace, fallback, decision, agent.id)
                return Stream.fromEffectDrain(Effect.logWarning(`Agent ${agent.id} failed before answering (${error.reason}): ${error.message}; ${fallback.id} answers`)).pipe(
                  Stream.concat(unrecorded(turnId, notAvailableText(agent.name), true)),
                  Stream.concat(run(fallback, 1))
                )
              })
            )

            return events.pipe(Stream.concat(Stream.suspend(() => {
              if (handoff === undefined) return Stream.empty
              const fallback = attempt === 0 ? fallbackFor(set, agent) : undefined
              if (fallback === undefined) return recorded(log, turnId, CANNOT_HELP_TEXT)
              emit({ _tag: "TurnAgentChanged", turnId, agentId: fallback.id, from: agent.id, reason: "handoff" })
              setTraceAgent(trace, fallback, decision, agent.id)
              return run(fallback, 1)
            })))
          })

        const head = plan.notice === undefined ? Stream.empty : unrecorded(turnId, plan.notice, true)
        return head.pipe(Stream.concat(run(plan.agent!, 0)))
      }))
    })

  // -------------------------------------------------------------------------
  // History and turn end

  /** Append a finished turn to history. Interrupted spoken turns keep only what was played. */
  const commit = (log: TurnLog, spokenTurn: boolean, complete: boolean) => {
    const spoken = (index: number): string => {
      const round = log.rounds[index]!
      if (complete || !spokenTurn) return round.text
      return log.clauses.filter((c, i) => c.round === index && i < log.played).map((c) => c.text).join(" ")
    }
    const by = !legacy && log.agentId !== undefined ? { agentId: log.agentId } : {}
    history.push({ role: "user", content: log.user })
    log.rounds.forEach((round, index) => {
      const content = spoken(index)
      if (round.results !== undefined) {
        history.push({ role: "assistant", content, toolCalls: round.toolCalls, ...by }, { role: "tool", results: round.results })
      } else if (content.length > 0) {
        history.push(complete ? { role: "assistant", content, ...by } : { role: "assistant", content, interrupted: true, ...by })
      }
    })
  }

  const outcomeOf = (exit: Exit.Exit<unknown, unknown>, discarded: boolean): TurnOutcome =>
    Exit.isSuccess(exit)
      ? "completed"
      : Cause.hasInterruptsOnly(exit.cause)
      ? discarded ? "discarded" : "interrupted"
      : "failed"

  const finishTurn = (
    log: TurnLog,
    trace: Trace,
    spoken: boolean,
    exit: Exit.Exit<unknown, unknown>,
    discarded: boolean
  ) =>
    Effect.suspend(() => {
      const outcome = outcomeOf(exit, discarded)
      if (outcome !== "discarded" && !log.canned) commit(log, spoken, outcome === "completed")
      const logFailure = Exit.isFailure(exit) && outcome === "failed"
        ? Effect.logError("Turn failed", exit.cause)
        : Effect.void
      return logFailure.pipe(
        Effect.andThen(tt.finish(trace, outcome)),
        Effect.andThen(Effect.sync(() => emit({ _tag: "TurnEnded", turnId: trace.id, outcome, trace })))
      )
    })

  const toLlmError = (error: AgentError): LlmError =>
    error.cause instanceof LlmError ? error.cause : new LlmError({ message: error.message, cause: error })

  const textTurn = (text: string, turnOptions?: { readonly agentId?: string | undefined }): Stream.Stream<string, LlmError> =>
    Stream.unwrap(Effect.gen(function*() {
      const trace = tt.begin("text")
      tt.mark(trace, "endOfTurn")
      const plan = planTurn(yield* options.setup, text, "text", turnOptions?.agentId)
      emit(turnStarted(trace, "text", text, false, false, plan))
      commitRouting(plan)
      if (plan.agent !== undefined) setTraceAgent(trace, plan.agent, plan.decision!, plan.decision!.unavailable)
      const log: TurnLog = { user: plan.decision?.text ?? text, rounds: [], clauses: [], played: 0, canned: plan.canned !== undefined }
      const ctx: ReplyContext = {
        plan,
        log,
        trace,
        utterance: text,
        source: "text",
        spoken: false,
        speculative: false,
        promoted: Effect.void,
        history: history.slice(),
        expectReply: (agentId) => armFor(plan.setup?.agents, agentId)
      }
      return reply(ctx).pipe(
        Stream.mapError(toLlmError),
        Stream.onExit((exit) => finishTurn(log, trace, false, exit, false))
      )
    }))

  const voice = <E>(events: Stream.Stream<ConversationInput, E>): Effect.Effect<void, E, Tts | AudioOutput> =>
    Effect.scoped(Effect.gen(function*() {
      const scope = yield* Effect.scope
      const tts = yield* Tts
      const output = yield* AudioOutput
      let current: ActiveTurn | undefined

      const live = () => (current !== undefined && !current.done ? current : undefined)

      const contextOf = (turn: ActiveTurn, log: TurnLog, history: ReadonlyArray<Message>): ReplyContext => ({
        plan: turn.plan,
        log,
        trace: turn.trace,
        utterance: turn.text,
        source: turn.source,
        spoken: turn.spoken,
        speculative: turn.trace.speculative,
        promoted: Deferred.await(turn.promoted),
        history,
        expectReply: (agentId) => {
          if (turn.pending) turn.expectReply = agentId
          else armFor(turn.plan.setup?.agents, agentId)
        }
      })

      /** A typed turn without speech: the reply is only text (deltas go out as events). */
      const unspokenBody = (ctx: ReplyContext) => Stream.runDrain(reply(ctx))

      const turnBody = (turn: ActiveTurn, ctx: ReplyContext) =>
        Effect.gen(function*() {
          const log = ctx.log
          const queue = yield* Queue.unbounded<TtsAudio, AgentError | TtsError | Cause.Done>()

          // One TTS stream for the whole turn (all rounds), fed clause by clause as the
          // chunker emits them. Audio is produced ahead of playback (and before
          // promotion for speculative turns); its clause index drives the bookkeeping.
          // The TTS input carries no errors: an agent failure ends the clause stream and
          // is re-raised after the audio of the clauses already sent.
          let failure: Cause.Cause<AgentError> | undefined
          const clauses = reply(ctx).pipe(
            chunk,
            Stream.map((text) => {
              log.clauses.push({ text, round: log.rounds.length - 1 })
              tt.mark(turn.trace, "firstClause")
              emit({ _tag: "ClauseQueued", turnId: turn.trace.id, index: log.clauses.length - 1, text })
              return text
            }),
            Stream.catchCause((cause) => {
              failure = cause
              return Stream.empty
            })
          )
          yield* tts.synthesize(clauses).pipe(
            Stream.provideService(CurrentTurnTrace, turn.trace),
            Stream.tap(() => Effect.sync(() => tt.mark(turn.trace, "ttsFirstAudio"))),
            Stream.concat(Stream.suspend(() => failure === undefined ? Stream.empty : Stream.failCause(failure))),
            Stream.runIntoQueue(queue),
            Effect.forkChild
          )

          yield* Deferred.await(turn.promoted)
          const markPlayed = (played: number) => {
            if (played <= log.played) return
            log.played = played
            emit({ _tag: "ClausePlaying", turnId: turn.trace.id, index: played - 1 })
          }
          const markStarted = () => {
            if (turn.speaking) return
            turn.speaking = true
            tt.mark(turn.trace, "playbackStart")
          }
          // With playback reports, a clause counts as played once the device has
          // reached its first sample: record where each clause starts (in samples)
          // as chunks are pulled, and compare with the reported progress.
          const reports = output.reportsPlayback === true
          const clauseStarts: Array<number> = []
          let pulled = 0
          const progress = (samples: number) => {
            let played = log.played
            while (played < clauseStarts.length && clauseStarts[played]! < samples) played++
            markPlayed(played)
          }
          const observer: PlaybackObserver = {
            started: () => {
              markStarted()
              progress(1)
            },
            progress
          }
          // One chunk per pull: `fromQueue` takes everything already queued in one pull,
          // so without `rechunk(1)` a TTS that ran ahead of playback would mark clauses
          // as played long before the speaker reached them.
          const audio = Stream.fromQueue(queue).pipe(Stream.rechunk(1), Stream.map(({ audio, clause }) => {
            if (reports) {
              while (clauseStarts.length <= clause) clauseStarts.push(pulled)
              pulled += audio.length >> 1
            } else if (clause >= log.played) {
              markStarted()
              markPlayed(clause + 1)
            }
            return audio
          }))
          yield* (reports ? output.play(audio, tts.sampleRate, observer) : output.play(audio, tts.sampleRate)).pipe(
            Effect.provideService(CurrentTurnTrace, turn.trace)
          )
        })

      const start = (
        text: string,
        speculative: boolean,
        source: "voice" | "text" = "voice",
        spoken = true,
        how: { readonly explicitAgent?: string | undefined; readonly say?: string } = {}
      ) =>
        Effect.gen(function*() {
          const plan: TurnPlan = how.say !== undefined ? { canned: how.say } : planTurn(yield* options.setup, text, source, how.explicitAgent)
          const trace = tt.begin(source, speculative)
          const promoted = yield* Deferred.make<void>()
          if (!speculative) {
            tt.mark(trace, "endOfTurn")
            yield* Deferred.succeed(promoted, undefined)
          }
          const turn: ActiveTurn = { text, source, spoken, pending: speculative, speaking: false, done: false, promoted, trace, plan }
          const log: TurnLog = { user: plan.decision?.text ?? text, rounds: [], clauses: [], played: 0, canned: plan.canned !== undefined }
          current = turn
          emit(turnStarted(trace, source, text, speculative, spoken, plan))
          if (plan.agent !== undefined) setTraceAgent(trace, plan.agent, plan.decision!, plan.decision!.unavailable)
          if (!speculative) commitRouting(plan)
          const ctx = contextOf(turn, log, history.slice())
          // Forked uninterruptible so the exit handler is installed even if the
          // turn is interrupted before it starts running; the body is interruptible.
          turn.fiber = yield* Effect.interruptible(spoken ? turnBody(turn, ctx) : unspokenBody(ctx)).pipe(
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                turn.done = true
                if (current === turn) current = undefined
                return finishTurn(log, trace, spoken, exit, turn.pending)
              })
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope, { uninterruptible: true })
          )
        })

      const interrupt = (turn: ActiveTurn) => turn.fiber === undefined ? Effect.void : Fiber.interrupt(turn.fiber)

      const handle = (event: ConversationInput): Effect.Effect<void> =>
        Effect.gen(function*() {
          const turn = live()
          switch (event._tag) {
            case "EagerEndOfTurn": {
              if (turn !== undefined) {
                if (!turn.pending && !bargeIn) return
                yield* interrupt(turn)
              }
              return yield* start(event.text, true)
            }
            case "TurnResumed": {
              if (turn?.pending) yield* interrupt(turn)
              return
            }
            case "EndOfTurn": {
              if (turn?.pending && sameText(turn.text, event.text)) {
                turn.pending = false
                tt.mark(turn.trace, "endOfTurn")
                emit({ _tag: "TurnPromoted", turnId: turn.trace.id })
                commitRouting(turn.plan)
                if (turn.expectReply !== undefined) armFor(turn.plan.setup?.agents, turn.expectReply)
                return yield* Deferred.succeed(turn.promoted, undefined)
              }
              if (turn !== undefined) {
                if (!turn.pending && !bargeIn) return
                yield* interrupt(turn)
              }
              return yield* start(event.text, false)
            }
            case "SpeechStarted": {
              // A committed turn is interrupted whether or not its audio has started
              // (otherwise a stale reply could start playing over the user). A pending
              // speculative turn is left to TurnResumed / EndOfTurn.
              if (bargeIn && turn !== undefined && !turn.pending) yield* interrupt(turn)
              return
            }
            case "Interim":
              return
            case "TextInput": {
              // Deliberate input: replaces whatever runs, whatever the barge-in setting.
              if (turn !== undefined) yield* interrupt(turn)
              return yield* start(event.text, false, "text", event.speak, { explicitAgent: event.agentId })
            }
            case "Say": {
              if (turn !== undefined) yield* interrupt(turn)
              const text = event.voice !== undefined && !/^\s*\[voice:/i.test(event.text) ? `[voice:${event.voice}] ${event.text}` : event.text
              return yield* start("", false, "text", true, { say: text })
            }
            case "SetActiveAgent": {
              if (!legacy) setRouterState(setActiveAgent(routerState, event.agentId, tt.now()), true)
              return
            }
            case "Interrupt": {
              if (turn !== undefined && !turn.pending) yield* interrupt(turn)
              return
            }
          }
        })

      yield* Stream.runForEach(events, handle)

      const last = live()
      if (last?.fiber !== undefined) {
        if (last.pending) yield* Fiber.interrupt(last.fiber)
        else yield* Fiber.await(last.fiber)
      }
    }))

  return Conversation.of({
    voice,
    textTurn,
    history: Effect.sync(() => history.slice()),
    routerState: Effect.sync(() => routerState)
  })
})
