import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import type { Agent, AgentEvent, AgentTurnInput } from "./Agent.ts"
import { AgentError } from "./Agent.ts"
import { type ClauseChunkerOptions, chunkClauses } from "./ClauseChunker.ts"
import type {
  AgentSet,
  AgentTurnSetup,
  ConversationEvent,
  ConversationStartReason,
  ConversationInput,
  PlaybackObserver,
  TurnSetup
} from "./ConversationEvents.ts"
import type { DecisionProvider } from "./Decision.ts"
import type { Message, SttEvent, ToolCall, ToolResult } from "./Domain.ts"
import { type AudioError, LlmError, type SttError, type TtsError } from "./Errors.ts"
import { makeModelAgent } from "./ModelAgent.ts"
import { armAgent, initialRouterState, type RouteDecision, type Router, type RouterState, setActiveAgent } from "./Routing.ts"
import { AudioInput, AudioOutput, Llm, Stt, Tts, type TtsAudio } from "./Services.ts"
import { ToolRegistry } from "./ToolRegistry.ts"
import { CurrentTurnTrace, type Trace, TurnTrace, type TurnOutcome } from "./TurnTrace.ts"
import { ACTION_TIMEOUT_MS, ActionError, type ActionOutcome, actionToolName, type RegisteredAction } from "./Actions.ts"
import { confirmationQuestion, describeProposal } from "./Decision.ts"
import type { IntentWords } from "./IntentWords.ts"
import {
  CONFIRM_WINDOW_MS,
  CONFIRMATIONS_OFF_REASON,
  confirmationAnswer,
  consumeConfirmation,
  makePendingIntents,
  needsConfirmation,
  type PendingEntry,
  proposingTools
} from "./PendingIntents.ts"
import { canonicalUtterance, sameUtterance } from "./Utterance.ts"

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
  /**
   * The id of the conversation `initialHistory` belongs to (an engine reload keeps it, so an agent that keys
   * state by `AgentTurnInput.conversationId` keeps its session). Default: a new random id.
   */
  readonly initialConversationId?: string
  /**
   * When the last turn of `initialHistory` was committed (epoch ms, `Conversation.lastTurnAt`), so an engine reload
   * does not restart the idle clock. Default: none (the idle clock starts at the next committed turn).
   */
  readonly initialLastTurnAt?: number
  /**
   * Idle reset (docs/VOICE-SESSIONS.md §1): when no turn has been committed for this long (ms), the next turn first
   * starts a new conversation (`newConversation("idle")`). Decided at the start of the turn, so a speculative turn
   * and its promotion see the same history. A function is read at every turn start (it can change at runtime, e.g.
   * a device profile); `undefined`, 0 or a negative value means never. Default never.
   */
  readonly idleResetMs?: number | (() => number | undefined)
  /** How much history is kept (and so sent to a model every turn). Defaults: `DEFAULT_HISTORY_LIMITS`. */
  readonly history?: HistoryLimits
  /**
   * How long the owner has to answer a confirmation question of an action declared
   * `confirm: true`, counted from the moment the question has been presented (its audio
   * finished, or the owner interrupted it after its final clause started; text delivered in
   * text mode). Default 15 000 ms (`CONFIRM_WINDOW_MS`).
   */
  readonly confirmWindowMs?: number
  /**
   * The closed word lists by which a turn answers a confirmation (`yes`/`yesFiller` for a
   * confirmation, `no`/`noFiller` for a refusal). Default English and Dutch (`defaultIntentWords`);
   * give the same lists as `makeIntentAgent({ words })` when a household extends them.
   */
  readonly intentWords?: IntentWords
  /**
   * The fixed sentences core says while conducting a confirmation (review round 7). Default
   * English (`DEFAULT_CONFIRM_TEXTS`); `DUTCH_CONFIRM_TEXTS` is the Dutch set.
   */
  readonly confirmTexts?: Partial<ConfirmTexts>
  /**
   * Whether actions declared `confirm: true` can be run at all (after the final review; see the known
   * limitations in docs/AGENTS-AND-INTENTS.md §3.2). Default "off": a proposal of such an action is
   * refused before anything is recorded as pending — no question, nothing run, the proposing agent
   * told so, the owner hears `ConfirmTexts.switchedOff`, history gets an outcome note. Read once,
   * when the conversation is made. "on": core conducts the confirmation as described in §3.2.
   */
  readonly confirmActions?: "off" | "on"
}

/** The fixed sentences of a confirmation core conducts (review rounds 6 and 7). */
export interface ConfirmTexts {
  /** Before the action's question when the proposing turn already said something ("To confirm:"). */
  readonly leadIn: string
  /** The owner said no. */
  readonly cancelled: string
  /** The action succeeded and supplied no words of its own (no announcement, no `say`). */
  readonly done: string
  /** A yes from an utterance that began before the question had been played to its end. */
  readonly tooEarly: string
  /** A yes after the response window closed. */
  readonly lapsed: string
  /** A yes for an action that is no longer offered (module disabled or reconfigured, value gone). */
  readonly unavailable: string
  /** A proposal whose confirmation question cannot state the values: nothing was asked. */
  readonly refused: string
  /** A proposal of a `confirm: true` action while `confirmActions` is "off": nothing was asked or run. */
  readonly switchedOff: string
}

export const DEFAULT_CONFIRM_TEXTS: ConfirmTexts = {
  leadIn: "To confirm:",
  cancelled: "OK, I won't.",
  done: "Done.",
  tooEarly: "I didn't do it: the question hadn't finished when you answered. Please say your request again.",
  lapsed: "I didn't do it: that answer came too late. Please say your request again.",
  unavailable: "I didn't do it: that can't be done any more.",
  refused: "Sorry, I can't ask you to confirm that, so I didn't do it.",
  switchedOff: "I can't do that: it needs a confirmation step, and confirmations are switched off."
}

export const DUTCH_CONFIRM_TEXTS: ConfirmTexts = {
  leadIn: "Ter bevestiging:",
  cancelled: "Oké, dan niet.",
  done: "Klaar.",
  tooEarly: "Ik heb het niet gedaan: de vraag was nog niet af toen je antwoordde. Zeg je verzoek nog eens.",
  lapsed: "Ik heb het niet gedaan: dat antwoord kwam te laat. Zeg je verzoek nog eens.",
  unavailable: "Ik heb het niet gedaan: dat kan niet meer.",
  refused: "Sorry, dat kan ik je niet laten bevestigen, dus ik heb het niet gedaan.",
  switchedOff: "Dat kan ik niet doen: daarvoor is een bevestiging nodig, en bevestigen staat uit."
}

/**
 * The bound on the stored conversation history (docs/ARCHITECTURE.md, "History
 * bound"). Whole committed turns are evicted, oldest first — a user message with
 * everything the assistant said and did in reply, so tool calls stay paired with
 * their results and an interrupted reply keeps its marker — when the history
 * holds more than `maxTurns` turns or more than `maxChars` characters. Eviction
 * goes in batches of `evictTurns`, so the start of what is sent to a model stays
 * the same between evictions (prompt caching needs a stable prefix). A single
 * message larger than `maxItemChars` (a huge tool result) is cut, keeping its
 * envelope (role, tool call ids, flags), with a marker saying how much was cut.
 */
export interface HistoryLimits {
  /** Most turns kept. Default 32. */
  readonly maxTurns?: number
  /** Turns evicted at once when a limit is passed. Default 8. */
  readonly evictTurns?: number
  /** Most characters of message text kept (a stand-in for tokens). Default 48 000. */
  readonly maxChars?: number
  /** Longest single message text or tool result kept. Default 8 000. */
  readonly maxItemChars?: number
}

export const DEFAULT_HISTORY_LIMITS: Required<HistoryLimits> = { maxTurns: 32, evictTurns: 8, maxChars: 48_000, maxItemChars: 8_000 }

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
  /**
   * Start a new conversation (docs/VOICE-SESSIONS.md §1): stops the running voice turn as Stop does (the rest of
   * the utterance being spoken starts nothing), drops the history, the pending question or confirmation and the
   * routing state, and gives the conversation a new id, emitted as `ConversationStarted`. Works whether or not a
   * voice loop runs. A `textTurn` still running is not stopped, but nothing of it is recorded in the new
   * conversation. Succeeds with the new id.
   */
  newConversation(reason?: ConversationStartReason): Effect.Effect<string>
  /** The current conversation's id (`AgentTurnInput.conversationId`). */
  readonly conversationId: Effect.Effect<string>
  /** When the current conversation's last turn was committed (epoch ms; `Clock`), or `undefined` if none yet. */
  readonly lastTurnAt: Effect.Effect<number | undefined>
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

/**
 * How long Stop keeps the stopped utterance cancelled at most, for a recogniser
 * that breaks the `SttEvent` contract and never sends the utterance's `EndOfTurn`
 * (review round 4: the conversation sees only events and their times, not audio,
 * so it cannot tell a `SpeechStarted` that begins a new utterance from one a
 * recogniser repeats inside the stopped one; this lapse is the only fallback).
 */
export const CANCELLED_UTTERANCE_MS = 20_000

/** Ends `text` as a sentence (a full stop added when it has no final punctuation). */
const sentenceOf = (text: string): string => {
  const t = text.trim()
  return t === "" ? "unknown reason." : /[.!?]$/.test(t) ? t : `${t}.`
}

/** A transcript with no words: empty, whitespace, or punctuation only. */
const isBlank = (text: string): boolean => !/[\p{L}\p{N}]/u.test(text)

/** Spoken when no agent is running at all. */
export const NO_AGENT_TEXT = "No agent is available right now. Check the agents in the options."
/** Spoken when an agent passed a turn on and no conversational agent can take it. */
export const CANNOT_HELP_TEXT = "I can't help with that right now."
/** Spoken by core when the owner refuses a confirmation (`DEFAULT_CONFIRM_TEXTS.cancelled`). */
export const CONFIRM_CANCELLED_TEXT = DEFAULT_CONFIRM_TEXTS.cancelled
/** A transcript without an open utterance is logged at most this often (`SttEvent` contract). */
export const PROTOCOL_LOG_MS = 10_000
export const notAvailableText = (name: string) => `${name} isn't available.`

/** A router that always picks `agentId` and keeps no state (single-agent conversations). */
export const singleAgentRouter = (agentId: string): Router => ({
  route: (input) => ({ agentId, reason: "default", text: input.text, next: initialRouterState }),
  matchTrigger: () => undefined
})

/**
 * Transcript comparison for promoting a speculative turn, for every agent kind
 * (review round 5; rounds 3 and 4 applied it to intent turns only): the canonical
 * texts must be equal (`canonicalUtterance`, the very normalisation the intent
 * path's parser and accounting read). Only whitespace and the ignorable
 * punctuation of `Utterance.ts` (sentence-final ".", "!", "…", commas away from
 * numbers, quotes) may differ. Anything else — "yes" and "yes?", "5" and "–5",
 * "5" and ".5", a comma next to a number, a word's case, an added or dropped word
 * — discards the speculative turn, and the final transcript is planned afresh.
 * One rule for all: a turn planned for a conversational agent can still reach an
 * intent agent (hand-off, failure fallback), and a conversational agent can call
 * side-effecting tools itself.
 */
export const strictTranscript = (s: string): string => canonicalUtterance(s)

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
  /** Core's confirmation question (review round 6): the last round of its turn. */
  question?: true
}

/** An action declared `confirm: true` that an agent proposed in this turn (review round 6). */
interface Proposal {
  readonly action: RegisteredAction
  readonly params: Readonly<Record<string, unknown>>
  readonly question: string
  /** The proposing agent (history attribution; absent in single-model conversations). */
  readonly agentId: string | undefined
}

/** A proposal whose confirmation question could not state the values (review round 7): nothing is asked. */
interface Refusal {
  readonly action: RegisteredAction
  readonly params: Readonly<Record<string, unknown>>
  readonly reason: string
  /** Refused because `confirmActions` is "off" (the owner hears `ConfirmTexts.switchedOff`). */
  readonly switchedOff?: true
}

/**
 * The last confirmation question core asked, until a later committed turn settles it (review
 * round 7): an answer (yes or no by closed grammar) or anything else. `entry` is set once the
 * question had been played to its end (armed); an utterance can answer it only if it began after
 * that (`Answer.answerable` is this very entry).
 */
interface Asked {
  readonly proposal: Proposal
  readonly turnId: number
  entry?: PendingEntry
}

/** A confirmed action, started at promotion of the answering turn (review round 7). */
interface ActionRecord {
  status: "running" | "ok" | "failed"
  say?: string
  error?: string
  fiber?: Fiber.Fiber<void>
  /** "Switch everything off", "Reset the room (room: Bedroom)". */
  readonly describe: string
  /** The outcome note committed to history while the action was still running: replaced when it ends. */
  committed?: Message
}

type DropReason = "cancelled" | "tooEarly" | "lapsed" | "unavailable" | "switchedOff"

/** How an answering turn was settled at promotion (`resolveAnswer`). */
type Resolution =
  | { readonly kind: "fresh" }
  | { readonly kind: "ran"; readonly entry: PendingEntry; readonly record: ActionRecord }
  | { readonly kind: "dropped"; readonly reason: DropReason; readonly describe: string }

/** A turn whose words answer the last confirmation question by closed grammar. */
interface Answer {
  readonly asked: Asked
  readonly kind: "yes" | "no"
  /** The armed entry when the answering utterance BEGAN (typed: when it was submitted); fixed then, never improved. */
  readonly answerable: PendingEntry | undefined
  /** Set when the turn is committed (promotion), in one step with the action's start. */
  resolution?: Resolution
}

/** What a turn produced so far; turned into history when the turn ends. */
interface TurnLog {
  /** The user message as recorded: what the agent received (trigger phrase removed). */
  readonly user: string
  /** The conversation the turn started in: a turn of an earlier conversation is never recorded in a newer one. */
  readonly conversation: number
  readonly rounds: Array<Round>
  /** Spoken turns only: clauses sent to TTS, in order, with the round they belong to (-1: a notice, never recorded). */
  readonly clauses: Array<{ readonly text: string; readonly round: number }>
  /** Spoken turns only: number of clauses whose audio started playing. */
  played: number
  /** A canned reply: nothing is recorded. */
  readonly canned: boolean
  /** The agent whose words the rounds hold (the fallback agent after a hand-off). */
  agentId?: string
  /** The `confirm: true` action proposed in this turn: core asks its question and arms it when presented. */
  proposal?: Proposal
  questionAsked?: boolean
  /** The question's text, with the flush after it, went out (text mode: delivered). */
  questionDelivered?: boolean
  /** A proposal of this turn was refused (its question cannot state the values): core says so. */
  refusal?: Refusal
  /** Something was said in this turn before (decides the question's lead-in). */
  said?: boolean
  /** The output's authoritative final count shows that not everything was played (round 7). */
  shortened?: boolean
  /** The turn answers a confirmation: its outcome note is recorded at commit. */
  answer?: Answer
}

/** How a turn will be answered, decided synchronously at its start. */
interface TurnPlan {
  readonly setup?: AgentTurnSetup
  readonly decision?: RouteDecision
  readonly agent?: Agent
  /** Speak this instead of running an agent. */
  readonly canned?: string
  /** The voice of a `Say` (a canned reply made without a setup): the setup's `tts`, read when it starts. */
  readonly tts?: Tts["Service"] | undefined
  /** Spoken before the agent's answer ("Codex isn't available."). */
  readonly notice?: string
  /** Manual routing changes (`SetActiveAgent`) made before this plan; a later one wins over this turn's routing outcome. */
  readonly manualRouting?: number
  /**
   * The turn's words answer the last confirmation question (by closed grammar): core settles it
   * at promotion, before any agent (`resolveAnswer`). Only if another turn settled it meanwhile is
   * the turn answered as planned (`agent`/`canned`), like any fresh request.
   */
  readonly answer?: Answer
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
  /** Stopped by the Stop control (`Interrupt`): a confirmation question it asked is not armed. */
  stopped?: boolean
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
  /** Messages evicted before `history[0]` when the snapshot was taken. */
  readonly historyStart: number
  /** The conversation the turn belongs to (decided at its start). */
  readonly conversationId: string
  readonly expectReply: (agentId: string) => void
}

/** A `newConversation` request to the running voice loop. */
interface VoiceControl {
  readonly reason: ConversationStartReason
  readonly done: Deferred.Deferred<string>
}

/** What the voice loop handles: the input events, and `newConversation` requests. */
type LoopInput = ConversationInput | { readonly _tag: "NewConversation" } & VoiceControl

/** A new conversation id (random; `ConversationOptions.initialConversationId` carries one across a reload). */
const newConversationId = (): string => globalThis.crypto.randomUUID()

const noDeciders: ReadonlyMap<string, DecisionProvider> = new Map()
const HANDOFF = Symbol("handoff")
/** The agent proposed a `confirm: true` action and its tool round is complete: stop reading its stream. */
const CUT = Symbol("cut")

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
  const defaultLlm = yield* Llm
  /** The one `model` agent over `llm` (a turn's `TurnSetup.llm`, else the conversation's). */
  const agentSetOf = (llm: Llm["Service"]): AgentSet => {
    const agent: Agent = {
      id: "llm",
      name: "Assistant",
      kind: "model",
      speculate: true,
      firstEventTimeoutMs: Number.POSITIVE_INFINITY,
      turn: makeModelAgent({ llm }).turn
    }
    return { router: singleAgentRouter(agent.id), agents: new Map([[agent.id, agent]]), defaultAgent: agent.id }
  }
  const perLlm = new WeakMap<Llm["Service"], { readonly agents: AgentSet; readonly perRegistry: WeakMap<ToolRegistry["Service"], AgentSet> }>()
  // The registry's own action tools are the actions this turn offers (review round 7): a confirmation
  // is consumed against them, so one asked before a registry replacement is not run after it.
  const agentsFor = (registry: ToolRegistry["Service"], llm: Llm["Service"]): AgentSet => {
    let forLlm = perLlm.get(llm)
    if (forLlm === undefined) {
      forLlm = { agents: agentSetOf(llm), perRegistry: new WeakMap() }
      perLlm.set(llm, forLlm)
    }
    const { agents, perRegistry } = forLlm
    const known = perRegistry.get(registry)
    if (known !== undefined) return known
    // A hand-made registry may have no action lookup (or no specs): then it offers no actions.
    const actionFor = registry.actionFor
    const actions = actionFor === undefined ? [] : (registry.specs ?? []).flatMap((spec) => {
      const action = actionFor(spec.name)
      return action === undefined ? [] : [action]
    })
    const set: AgentSet = { ...agents, actions }
    perRegistry.set(registry, set)
    return set
  }
  return yield* makeConversationCore(
    {
      ...options,
      setup: Effect.map(options.setup, (s): AgentTurnSetup => ({ system: s.system, registry: s.registry, agents: agentsFor(s.registry, s.llm ?? defaultLlm), ...(s.tts !== undefined ? { tts: s.tts } : {}), ...(s.maxToolRounds !== undefined ? { maxToolRounds: s.maxToolRounds } : {}) }))
    },
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

  const limits = { ...DEFAULT_HISTORY_LIMITS, ...options.history }
  const history: Array<Message> = []
  /** Messages evicted from the front so far (`AgentTurnInput.historyStart`). */
  let evicted = 0
  /** The current conversation (`newConversation`): its id, and a counter that tells turns of older ones apart. */
  let conversationId = options.initialConversationId ?? newConversationId()
  let conversationEpoch = 0
  /** When the last turn was committed (epoch ms), for the idle reset. */
  let lastTurnAt: number | undefined = options.initialLastTurnAt
  /** The running voice loop's way to stop its turn and start a new conversation (`newConversation`). */
  let voiceControl: Queue.Queue<VoiceControl> | undefined
  let routerState: RouterState = options.initialRouterState ?? initialRouterState
  /** The conversation's one pending question or confirmation, shared by every agent (review rounds 5 and 6). */
  const pendingIntents = makePendingIntents()
  const confirmWindowMs = options.confirmWindowMs ?? CONFIRM_WINDOW_MS
  const texts: ConfirmTexts = { ...DEFAULT_CONFIRM_TEXTS, ...options.confirmTexts }
  /** Read once: a conversation's confirmations are on or off for its whole life (default off). */
  const confirmActions: "off" | "on" = options.confirmActions === "on" ? "on" : "off"
  /** The last confirmation question asked and not yet settled by a later committed turn (round 7). */
  let asked: Asked | undefined
  /** Counts `SetActiveAgent`: a turn planned before the latest one does not overwrite it when it is promoted. */
  let manualRouting = 0

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
  // Conversations (docs/VOICE-SESSIONS.md §1)

  /** Drops the conversation's state and starts a new one. No turn may be running (the caller stops it first). */
  const resetConversation = (reason: ConversationStartReason) =>
    Effect.suspend(() => {
      const ended = conversationId
      history.length = 0
      evicted = 0
      conversationEpoch++
      conversationId = newConversationId()
      lastTurnAt = undefined
      pendingIntents.set(undefined)
      asked = undefined
      setRouterState(initialRouterState)
      emit({ _tag: "ConversationStarted", conversationId, reason })
      const id = conversationId
      return Effect.as(endAgentConversations(ended), id)
    })

  /** Tell the agents of the current setup that a conversation ended (a harness closes its session). Never fails. */
  const endAgentConversations = (ended: string): Effect.Effect<void> =>
    options.setup.pipe(
      Effect.flatMap((setup) => {
        const ends = [...setup.agents.agents.values()].flatMap((a) => (a.endConversation !== undefined ? [a.endConversation] : []))
        return Effect.forEach(ends, (end) => Effect.catchCause(Effect.suspend(() => end(ended)), () => Effect.void), { discard: true })
      }),
      Effect.catchCause(() => Effect.void)
    )

  const idleResetMs = (): number | undefined => {
    const value = typeof options.idleResetMs === "function" ? options.idleResetMs() : options.idleResetMs
    return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined
  }

  /** At a turn's start: a new conversation first when none was committed for `idleResetMs`. True if it reset. */
  const resetIfIdle: Effect.Effect<boolean> = Effect.suspend(() => {
    const ms = idleResetMs()
    const last = lastTurnAt
    if (ms === undefined || last === undefined) return Effect.succeed(false)
    return Effect.flatMap(Clock.currentTimeMillis, (now) =>
      now - last < ms ? Effect.succeed(false) : Effect.as(resetConversation("idle"), true))
  })

  // -------------------------------------------------------------------------
  // Routing

  const setRouterState = (next: RouterState, always = false) => {
    const changed = !sameState(routerState, next)
    routerState = next
    if (!legacy && (changed || always)) emit({ _tag: "RoutingChanged", state: next })
  }

  const nameOf = (set: AgentSet, id: string) => set.names?.get(id) ?? set.agents.get(id)?.name ?? id

  /**
   * `answerable`: the armed confirmation entry when the turn's utterance began (spoken: at its
   * `SpeechStarted`; typed: when submitted). Fixed then and never improved (review round 7).
   */
  const planTurn = (
    setup: AgentTurnSetup,
    text: string,
    source: "voice" | "text",
    explicitAgent: string | undefined,
    answerable: PendingEntry | undefined
  ): TurnPlan => {
    const set = setup.agents
    const decision = set.router.route({ text, source, explicitAgent, state: routerState, now: tt.now(), isAvailable: (id) => set.agents.has(id) })
    // Offered first to the last confirmation question, before any agent (rounds 6 and 7): a yes or a
    // no by closed grammar is core's, whether or not it can still be used (core says why not);
    // anything else drops the confirmation at commit and is routed as usual.
    const kind = asked !== undefined ? confirmationAnswer(decision.text, options.intentWords) : "other"
    const answer: Answer | undefined = kind !== "other" ? { asked: asked!, kind, answerable } : undefined
    const base = { setup, decision, manualRouting, ...(answer !== undefined ? { answer } : {}) }
    if (decision.agentId === undefined) return { ...base, canned: NO_AGENT_TEXT }
    if (decision.acknowledge !== undefined) {
      return { ...base, canned: decision.unavailable !== undefined ? notAvailableText(nameOf(set, decision.unavailable)) : decision.acknowledge }
    }
    const agent = set.agents.get(decision.agentId)!
    return decision.unavailable !== undefined && decision.reason !== "default"
      ? { ...base, agent, notice: notAvailableText(nameOf(set, decision.unavailable)) }
      : { ...base, agent }
  }

  /** The owner chose an agent by hand after this turn was planned: that choice stands. */
  const overruled = (plan: TurnPlan) => plan.manualRouting !== undefined && plan.manualRouting !== manualRouting

  /**
   * Apply the turn's routing outcome; called when the turn is committed (a
   * discarded turn changes nothing). Skipped when the owner chose an agent by
   * hand while the turn waited for promotion.
   */
  const commitRouting = (plan: TurnPlan) => {
    if (plan.decision !== undefined && !overruled(plan)) setRouterState(plan.decision.next)
  }
  /**
   * A turn is committed (started committed, or promoted): its routing outcome, and the end of the
   * confirmation it does not answer (it is a fresh request). An answering turn is settled here, in
   * one step (`resolveAnswer`).
   */
  const commitPlan = (plan: TurnPlan, trace: Trace): Effect.Effect<void> =>
    plan.answer !== undefined ? resolveAnswer(plan, plan.answer, trace) : Effect.sync(() => {
      commitRouting(plan)
      pendingIntents.dropConfirmation()
      asked = undefined
    })

  /** History note for an outcome (round 7): a fact a model reads, never spoken. */
  const ranNote = (r: ActionRecord): string =>
    r.status === "ok"
      ? `[${r.describe}: the owner confirmed; it ran and succeeded.]`
      : r.status === "failed"
      ? `[${r.describe}: the owner confirmed; it ran and failed: ${sentenceOf(r.error ?? "")}]`
      : `[${r.describe}: the owner confirmed; it was started, and its outcome was not known yet when this was recorded.]`
  const droppedNote = (describe: string, reason: DropReason): string =>
    reason === "cancelled"
      ? `[${describe}: the owner said no; it was not run.]`
      : reason === "tooEarly"
      ? `[${describe}: not run — the owner answered before the confirmation question had finished playing.]`
      : reason === "lapsed"
      ? `[${describe}: not run — the owner's answer came after the confirmation window had closed.]`
      : reason === "switchedOff"
      ? `[${describe}: not run — ${CONFIRMATIONS_OFF_REASON}]`
      : `[${describe}: not run — the action is no longer available.]`
  const dropText = (reason: DropReason): string =>
    reason === "cancelled"
      ? texts.cancelled
      : reason === "tooEarly"
      ? texts.tooEarly
      : reason === "lapsed"
      ? texts.lapsed
      : reason === "switchedOff"
      ? texts.switchedOff
      : texts.unavailable

  /** A confirmed action finished: its real outcome replaces a note committed while it ran. */
  const settle = (record: ActionRecord) => {
    const committed = record.committed
    if (committed === undefined || committed.role !== "assistant") return
    const i = history.indexOf(committed)
    if (i >= 0) history[i] = { ...committed, content: ranNote(record) }
  }

  /**
   * Start a CONSUMED confirmation's action (review round 7): detached, so that nothing that happens
   * to the turn (its speech interrupted, its consumer gone) cancels it half-way; the 5 s limit; its
   * outcome kept in `record`, emitted, and written into history even after the turn has ended.
   */
  const startConfirmed = (entry: PendingEntry, trace: Trace, describe: string): Effect.Effect<ActionRecord> =>
    Effect.gen(function*() {
      const action = entry.intent.action
      const def = action.definition
      const params = entry.intent.params
      const record: ActionRecord = { status: "running", describe }
      const turnId = trace.id
      const callId = `confirmed-${turnId}`
      tt.mark(trace, "actionStarted")
      emit({ _tag: "ActionStarted", turnId, callId, actionId: action.id, label: def.label, params })
      const start = tt.now()
      const work = Effect.suspend(() => def.run(params as never)).pipe(
        Effect.timeoutOrElse({
          duration: ACTION_TIMEOUT_MS,
          orElse: () => Effect.fail(new ActionError({ message: `${def.label} did not finish within ${ACTION_TIMEOUT_MS / 1000} seconds.` }))
        })
      )
      record.fiber = yield* Effect.forkDetach(Effect.interruptible(work).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            const ms = tt.now() - start
            if (trace.outcome === undefined) tt.mark(trace, "actionFinished")
            trace.tools.push({ name: actionToolName(action.moduleId, def.id), ms })
            if (Exit.isSuccess(exit)) {
              record.status = "ok"
              const say = (exit.value as ActionOutcome | undefined)?.say
              if (say !== undefined && say.trim() !== "") record.say = say
              emit({ _tag: "ActionFinished", turnId, callId, ok: true, ms })
            } else {
              const error = Cause.findErrorOption(exit.cause)
              const message = error._tag === "Some" && error.value.message.length > 0 ? error.value.message : "Something went wrong."
              record.status = "failed"
              record.error = message
              emit({ _tag: "ActionFinished", turnId, callId, ok: false, ms, error: message })
            }
            settle(record)
          })
        )
      ))
      return record
    })

  /**
   * Settle an answering turn when it is committed (review round 7): ONE uninterruptible step with
   * nothing awaited between validation, consumption and the start of the action. A no cancels. A
   * yes is used only if its utterance began after the question had been played to its end
   * (`answerable` is the armed entry), the window is open now, and the action and its values are
   * still offered (`consumeConfirmation`, the clock read now); then the action starts, detached.
   * Otherwise the confirmation is dropped, and the reply says why.
   */
  const resolveAnswer = (plan: TurnPlan, answer: Answer, trace: Trace): Effect.Effect<void> =>
    Effect.uninterruptible(Effect.gen(function*() {
      if (answer.resolution !== undefined) return
      const a = answer.asked
      if (asked !== a) {
        // Another turn settled that question since this one was planned: a fresh request.
        answer.resolution = { kind: "fresh" }
        commitRouting(plan)
        pendingIntents.dropConfirmation()
        asked = undefined
        return
      }
      asked = undefined
      const describe = describeProposal(a.proposal.action, a.proposal.params)
      const drop = (reason: DropReason) => {
        pendingIntents.dropConfirmation()
        answer.resolution = { kind: "dropped", reason, describe }
      }
      const entry = a.entry
      if (answer.kind === "no") return drop("cancelled")
      if (entry === undefined || answer.answerable !== entry) return drop("tooEarly")
      // Second check, at execution: with confirmations off nothing is consumed or run.
      if (confirmActions !== "on") return drop("switchedOff")
      const setup = yield* options.setup
      const now = tt.now()
      if (pendingIntents.current(now) !== entry) return drop(now >= entry.until ? "lapsed" : "unavailable")
      const consumed = consumeConfirmation(pendingIntents, entry, { turnId: trace.id, now, actions: setup.agents.actions ?? [] })
      if (consumed === undefined) return drop("unavailable")
      answer.resolution = { kind: "ran", entry, record: yield* startConfirmed(entry, trace, describe) }
    }))

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
  const unrecorded = (turnId: number, text: string, flush: boolean, log?: TurnLog): Stream.Stream<string> =>
    Stream.suspend(() => {
      if (log !== undefined) log.said = true
      emit({ _tag: "TextDelta", turnId, text })
      if (!flush) return Stream.make(text)
      emit({ _tag: "TextDelta", turnId, text: "\n" })
      return Stream.make(text, "\n")
    })

  /** Text recorded as the agent's reply. */
  const recorded = (log: TurnLog, turnId: number, text: string): Stream.Stream<string> =>
    Stream.suspend(() => {
      openRoundOf(log).text += text
      if (text.trim() !== "") log.said = true
      emit({ _tag: "TextDelta", turnId, text })
      return Stream.make(text)
    })

  /** A recorded line of core's own, flushed as its own clause. */
  const sayLine = (log: TurnLog, turnId: number, text: string): Stream.Stream<string> =>
    text.length === 0 ? Stream.empty : recorded(log, turnId, text).pipe(Stream.concat(Stream.suspend(() => {
      emit({ _tag: "TextDelta", turnId, text: "\n" })
      return Stream.make("\n")
    })))

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

  /** A proposal was made, or refused, in this turn: the agent's stream ends and nothing else runs. */
  const closed = (log: TurnLog) => log.proposal !== undefined || log.refusal !== undefined

  /** Core's words for a refused proposal (round 7): the turn's last, recorded as the agent's. */
  const refusedReply = (log: TurnLog, turnId: number): Stream.Stream<string> =>
    Stream.suspend(() => {
      emit({ _tag: "TextDelta", turnId, text: "\n" })
      return Stream.make("\n")
    }).pipe(Stream.concat(sayLine(log, turnId, log.refusal?.switchedOff === true ? texts.switchedOff : texts.refused)))

  /** No tool call of the turn is waiting for its result. */
  const noOpenCalls = (log: TurnLog) => log.rounds.every((r) => r.results !== undefined || r.toolCalls.length === 0)

  /**
   * Core's confirmation question (review round 6), the last thing a proposing turn says: the
   * action's own question for the proposed values, recorded as the proposing agent's words in a
   * round of its own, flushed before and after, so its clauses are the turn's last ones.
   */
  const askQuestion = (log: TurnLog, turnId: number): Stream.Stream<string> =>
    Stream.suspend(() => {
      // Once per turn (a failure fallback nests one agent's run inside another's).
      if (log.questionAsked === true) return Stream.empty
      log.questionAsked = true
      emit({ _tag: "TextDelta", turnId, text: "\n" })
      return Stream.make("\n")
    }).pipe(
      Stream.concat(Stream.suspend(() => {
        // When the turn already said something, the question stands apart from it (round 7): a fixed
        // lead-in names what is being confirmed, so what the owner hears last is the action's question.
        const own = log.proposal!.question
        const question = log.said === true ? `${texts.leadIn} ${own}` : own
        const round = openRound(log)
        round.question = true
        round.text = question
        emit({ _tag: "TextDelta", turnId, text: question })
        emit({ _tag: "TextDelta", turnId, text: "\n" })
        return Stream.make(question, "\n")
      })),
      Stream.concat(Stream.fromEffectDrain(Effect.sync(() => {
        log.questionDelivered = true
      })))
    )

  /** Module code: an announcement that throws is no announcement (the action still runs). */
  const safely = (f: () => string | undefined): string | undefined => {
    try {
      return f()
    } catch {
      return undefined
    }
  }

  /**
   * The reply of a turn whose action was confirmed and STARTED at promotion (review round 7): the
   * announcement first (if the action declares one), then — only once the action has ended — its
   * `say`, or a fixed acknowledgement when it supplied no words, or why it failed. Recorded as the
   * proposing agent's words; the outcome note is added at commit (`commit`).
   */
  const confirmedReply = (ctx: ReplyContext, entry: PendingEntry, record: ActionRecord): Stream.Stream<string> =>
    Stream.suspend(() => {
      const { log } = ctx
      const turnId = ctx.trace.id
      const def = entry.intent.action.definition
      const announced = safely(() => def.announce?.(entry.intent.params as never))
      const announce = announced !== undefined && announced.trim() !== "" ? announced : undefined
      const sep = announce !== undefined ? " " : ""
      const after = Effect.map(record.fiber === undefined ? Effect.void : Fiber.await(record.fiber), () => {
        if (record.status === "ok") {
          const words = record.say ?? (announce === undefined ? texts.done : undefined)
          return words === undefined ? Stream.empty : sayLine(log, turnId, `${sep}${words}`)
        }
        return sayLine(log, turnId, `${sep}Sorry, ${record.error ?? "that failed."}`)
      })
      return (announce === undefined ? Stream.empty : sayLine(log, turnId, announce)).pipe(Stream.concat(Stream.unwrap(after)))
    })

  /**
   * A turn whose words answer the last confirmation question (rounds 6 and 7). It was settled when
   * it was committed (`resolveAnswer`); after promotion it says the outcome: the action's words, or
   * why it was not done. A turn whose question another turn settled is a fresh request.
   */
  const answerReply = (ctx: ReplyContext, answer: Answer): Stream.Stream<string, AgentError> =>
    Stream.unwrap(Effect.gen(function*() {
      yield* ctx.promoted
      const r = answer.resolution
      if (r === undefined || r.kind === "fresh") return agentReply(ctx)
      const proposer = answer.asked.proposal.agentId
      if (!legacy && proposer !== undefined) ctx.log.agentId = proposer
      if (r.kind === "dropped") return sayLine(ctx.log, ctx.trace.id, dropText(r.reason))
      return confirmedReply(ctx, r.entry, r.record)
    }))

  const reply = (ctx: ReplyContext): Stream.Stream<string, AgentError> =>
    Stream.suspend(() => (ctx.plan.answer !== undefined ? answerReply(ctx, ctx.plan.answer) : agentReply(ctx)))

  const agentReply = (ctx: ReplyContext): Stream.Stream<string, AgentError> =>
    Stream.suspend(() => {
      const { log, plan, trace } = ctx
      const turnId = trace.id
      if (plan.canned !== undefined) return unrecorded(turnId, plan.canned, false)
      const setup = plan.setup!
      const decision = plan.decision!
      const set = setup.agents
      const maxToolRounds = setup.maxToolRounds ?? set.maxToolRounds ?? options.maxToolRounds ?? 5

      return Stream.unwrap(Effect.map(setup.registry.context, (context) => {
        /**
         * Record THE proposal of this turn (review round 6); false when one exists already. A proposal
         * whose question cannot state the values is REFUSED (round 7): the reason is returned, nothing
         * is asked, and core says it could not be confirmed.
         */
        const propose = (agent: Agent, action: RegisteredAction, params: Readonly<Record<string, unknown>>): boolean | string => {
          if (closed(log)) return false
          // Confirmations switched off (the default): refused before anything can become pending.
          if (confirmActions !== "on" && needsConfirmation(action)) {
            log.refusal = { action, params, reason: CONFIRMATIONS_OFF_REASON, switchedOff: true }
            return CONFIRMATIONS_OFF_REASON
          }
          const q = confirmationQuestion(action, params)
          if ("refused" in q) {
            log.refusal = { action, params, reason: q.refused }
            return q.refused
          }
          log.proposal = { action, params, question: q.question, agentId: legacy ? undefined : agent.id }
          return true
        }
        const inputFor = (agent: Agent): AgentTurnInput => ({
          turnId,
          text: decision.text,
          utterance: ctx.utterance,
          source: ctx.source,
          spoken: ctx.spoken,
          routedBy: decision.reason,
          history: ctx.history,
          ...(ctx.historyStart > 0 ? { historyStart: ctx.historyStart } : {}),
          conversationId: ctx.conversationId,
          system: set.promptFor === undefined ? setup.system : set.promptFor(agent),
          context: context.length === 0 ? undefined : context,
          // A call of a `confirm: true` action PROPOSES it: core asks and conducts the confirmation (round 6),
          // for model and harness agents alike; after a proposal every further call of the turn is refused.
          tools: proposingTools(setup.registry, {
            actions: set.actions ?? [],
            propose: (action, params) => propose(agent, action, params),
            proposed: () => closed(log)
          }),
          pendingIntents,
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
            const handle = (event: AgentEvent): string | typeof HANDOFF | typeof CUT | undefined => {
              // After a proposal nothing the agent says is spoken or recorded, and its stream is cut
              // as soon as no tool call of the turn waits for its result (refused calls finish at once).
              if (closed(log)) {
                switch (event._tag) {
                  case "ToolStarted":
                    openRoundOf(log).toolCalls.push(event.call)
                    emit({ _tag: "ToolStarted", turnId, call: event.call })
                    return undefined
                  case "ToolFinished":
                    addResult(log, event.result)
                    emit({ _tag: "ToolFinished", turnId, result: event.result, ms: event.ms })
                    return noOpenCalls(log) ? CUT : undefined
                  default:
                    return noOpenCalls(log) ? CUT : undefined
                }
              }
              switch (event._tag) {
                case "TextDelta": {
                  if (event.text.length === 0) return undefined
                  if (event.text !== "\n") {
                    said = true
                    log.said = true
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
                  // The call that proposed: stop once the round's other calls are in.
                  return closed(log) && noOpenCalls(log) ? CUT : undefined
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
                case "ConfirmAction":
                  // Only an action this turn offers; the agent's stream ends here either way.
                  if ((set.actions ?? []).includes(event.action)) propose(agent, event.action, event.params)
                  return CUT
                case "Handoff":
                  if (said) return undefined // too late: the agent already spoke (a defect of the agent; ignored)
                  handoff = event.reason
                  return HANDOFF
              }
            }

            const events = agentEvents(agent, inputFor(agent)).pipe(
              Stream.map(handle),
              Stream.takeUntil((x) => x === HANDOFF || x === CUT, { excludeLast: true }),
              Stream.filter((x): x is string => typeof x === "string"),
              Stream.catchTag("AgentError", (error) => {
                // After a proposal the turn's outcome is core's question, whatever the agent does next.
                if (closed(log)) return Stream.empty
                const fallback = attempt === 0 && !said && !acted ? fallbackFor(set, agent) : undefined
                if (fallback === undefined) return Stream.fail(error)
                // Failed before saying or doing anything: the same turn, once, on the fallback agent.
                emit({ _tag: "TurnAgentChanged", turnId, agentId: fallback.id, from: agent.id, reason: "failed" })
                setTraceAgent(trace, fallback, decision, agent.id)
                return Stream.fromEffectDrain(Effect.logWarning(`Agent ${agent.id} failed before answering (${error.reason}): ${error.message}; ${fallback.id} answers`)).pipe(
                  Stream.concat(unrecorded(turnId, notAvailableText(agent.name), true, log)),
                  Stream.concat(run(fallback, 1))
                )
              })
            )

            return events.pipe(Stream.concat(Stream.suspend(() => {
              if (log.proposal !== undefined) return askQuestion(log, turnId)
              if (log.refusal !== undefined) return refusedReply(log, turnId)
              if (handoff === undefined) return Stream.empty
              const fallback = attempt === 0 ? fallbackFor(set, agent) : undefined
              if (fallback === undefined) return recorded(log, turnId, CANNOT_HELP_TEXT)
              emit({ _tag: "TurnAgentChanged", turnId, agentId: fallback.id, from: agent.id, reason: "handoff" })
              setTraceAgent(trace, fallback, decision, agent.id)
              return run(fallback, 1)
            })))
          })

        const head = plan.notice === undefined ? Stream.empty : unrecorded(turnId, plan.notice, true, log)
        return head.pipe(Stream.concat(run(plan.agent!, 0)))
      }))
    })

  // -------------------------------------------------------------------------
  // History and turn end

  /** A message with every text longer than `maxItemChars` cut (envelope kept). */
  const boundItem = (message: Message): Message => {
    const max = limits.maxItemChars
    const cut = (text: string) => (text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters cut from the history]`)
    if (message.role === "tool") {
      return message.results.some((r) => r.content.length > max) ? { ...message, results: message.results.map((r) => ({ ...r, content: cut(r.content) })) } : message
    }
    return message.content.length > max ? { ...message, content: cut(message.content) } : message
  }
  const sizeOf = (message: Message): number =>
    message.role === "tool" ? message.results.reduce((n, r) => n + r.content.length, 0)
    : message.content.length + (message.role === "assistant" ? (message.toolCalls ?? []).reduce((n, c) => n + JSON.stringify(c.input ?? null).length, 0) : 0)

  /**
   * Evict whole turns from the front while a limit is passed, `evictTurns` at a
   * time (the last turn is always kept). A turn starts at a user message; messages
   * before the first user message belong to the first turn.
   */
  const boundHistory = () => {
    const starts: Array<number> = []
    history.forEach((m, i) => {
      if (m.role === "user" && i > 0) starts.push(i)
    })
    const turns = starts.length + (history.length > 0 ? 1 : 0)
    let chars = history.reduce((n, m) => n + sizeOf(m), 0)
    if (turns <= limits.maxTurns && chars <= limits.maxChars) return
    let drop = 0 // turns to drop
    while (drop < turns - 1 && (turns - drop > limits.maxTurns || chars > limits.maxChars)) {
      const next = Math.min(turns - 1, drop + Math.max(1, limits.evictTurns))
      const from = drop === 0 ? 0 : starts[drop - 1]!
      const to = starts[next - 1]!
      for (let i = from; i < to; i++) chars -= sizeOf(history[i]!)
      drop = next
    }
    if (drop === 0) return
    const cut = starts[drop - 1]!
    history.splice(0, cut)
    evicted += cut
  }

  for (const message of options.initialHistory ?? []) history.push(boundItem(message))
  boundHistory()

  /**
   * Append a finished turn to history. Spoken turns not played in full keep only what was played:
   * interrupted ones, and (round 7) completed ones whose authoritative final count shows that not
   * everything was played (`complete` false). A turn that settled a confirmation, or refused a
   * proposal, ends with its outcome as an explicit note (never spoken), attributed to the proposer.
   */
  const commit = (log: TurnLog, spokenTurn: boolean, complete: boolean) => {
    const spoken = (index: number): string => {
      const round = log.rounds[index]!
      if (complete || !spokenTurn) return round.text
      return log.clauses.filter((c, i) => c.round === index && i < log.played).map((c) => c.text).join(" ")
    }
    const by = !legacy && log.agentId !== undefined ? { agentId: log.agentId } : {}
    const add = (message: Message) => history.push(boundItem(message))
    add({ role: "user", content: log.user })
    log.rounds.forEach((round, index) => {
      const content = spoken(index)
      if (round.results !== undefined) {
        add({ role: "assistant", content, toolCalls: round.toolCalls, ...by })
        add({ role: "tool", results: round.results })
      } else if (content.length > 0) {
        add(complete ? { role: "assistant", content, ...by } : { role: "assistant", content, interrupted: true, ...by })
      }
    })
    const r = log.answer?.resolution
    if (r !== undefined && r.kind !== "fresh") {
      const proposer = log.answer!.asked.proposal.agentId
      const note: Message = { role: "assistant", content: r.kind === "ran" ? ranNote(r.record) : droppedNote(r.describe, r.reason), ...(!legacy && proposer !== undefined ? { agentId: proposer } : {}) }
      history.push(note)
      // Still running: replaced by the real outcome when the action ends (`settle`).
      if (r.kind === "ran" && r.record.status === "running") r.record.committed = note
    } else if (log.refusal !== undefined) {
      add({ role: "assistant", content: `[${describeProposal(log.refusal.action, log.refusal.params)}: not asked and not run — ${log.refusal.reason}]`, ...by })
    }
    boundHistory()
  }

  const outcomeOf = (exit: Exit.Exit<unknown, unknown>, discarded: boolean): TurnOutcome =>
    Exit.isSuccess(exit)
      ? "completed"
      : Cause.hasInterruptsOnly(exit.cause)
      ? discarded ? "discarded" : "interrupted"
      : "failed"

  /**
   * Remember the turn's confirmation question and arm it once it has been played TO ITS END (review
   * round 7; no barge-in shortcut): spoken, when the turn completed, its question's final clause was
   * the turn's last and started playing, and an authoritative final count (if given) covers all of
   * it; in text mode, when the question was delivered and the turn completed. The window starts now.
   * A question interrupted by speech or typed text is remembered unarmed (an answer to it is too
   * early); one stopped by Stop, whose playback failed, or in a discarded turn is forgotten. Replaces
   * whatever was pending (a parameter question, an older confirmation).
   */
  const armProposal = (log: TurnLog, trace: Trace, spoken: boolean, outcome: TurnOutcome, stopped: boolean) => {
    const p = log.proposal
    if (p === undefined || outcome === "discarded" || outcome === "failed" || stopped) return
    if (confirmActions !== "on") return // never reached: `propose` refuses first
    const question: Asked = { proposal: p, turnId: trace.id }
    asked = question
    if (outcome !== "completed" || log.questionDelivered !== true || log.shortened === true) return
    if (spoken) {
      let last = -1
      log.clauses.forEach((c, i) => {
        if (log.rounds[c.round]?.question === true) last = i
      })
      if (last < 0 || last !== log.clauses.length - 1 || log.played < log.clauses.length) return
    }
    const now = tt.now()
    const entry: PendingEntry = {
      intent: { action: p.action, params: p.params, missing: [], awaiting: { kind: "confirm", question: p.question }, probability: 1 },
      at: now,
      armedAt: now,
      until: now + confirmWindowMs,
      turnId: trace.id,
      ...(p.agentId !== undefined ? { agentId: p.agentId } : {})
    }
    pendingIntents.set(entry)
    question.entry = entry
  }

  const finishTurn = (
    log: TurnLog,
    trace: Trace,
    spoken: boolean,
    exit: Exit.Exit<unknown, unknown>,
    discarded: boolean,
    stopped = false
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const outcome = outcomeOf(exit, discarded)
      // A turn of a conversation that has since been replaced (`newConversation`) is not recorded in the new one.
      const current = log.conversation === conversationEpoch
      if (current && outcome !== "discarded" && !log.canned) {
        commit(log, spoken, outcome === "completed" && log.shortened !== true)
        lastTurnAt = now
      }
      if (current) armProposal(log, trace, spoken, outcome, stopped)
      const logFailure = Exit.isFailure(exit) && outcome === "failed"
        ? Effect.logError("Turn failed", exit.cause)
        : Effect.void
      return logFailure.pipe(
        Effect.andThen(tt.finish(trace, outcome)),
        Effect.andThen(Effect.sync(() => emit({ _tag: "TurnEnded", turnId: trace.id, outcome, trace })))
      )
    })

  const newLog = (plan: TurnPlan, text: string): TurnLog => ({
    user: plan.decision?.text ?? text,
    conversation: conversationEpoch,
    rounds: [],
    clauses: [],
    played: 0,
    // A turn that answers a confirmation is always recorded (its outcome note), even when it was planned canned.
    canned: plan.canned !== undefined && plan.answer === undefined,
    ...(plan.answer !== undefined ? { answer: plan.answer } : {})
  })

  const toLlmError = (error: AgentError): LlmError =>
    error.cause instanceof LlmError ? error.cause : new LlmError({ message: error.message, cause: error })

  const textTurn = (text: string, turnOptions?: { readonly agentId?: string | undefined }): Stream.Stream<string, LlmError> =>
    Stream.unwrap(Effect.gen(function*() {
      yield* resetIfIdle
      const trace = tt.begin("text")
      tt.mark(trace, "endOfTurn")
      // Typed: it can answer a confirmation only if it was submitted after the question was armed.
      const plan = planTurn(yield* options.setup, text, "text", turnOptions?.agentId, asked?.entry)
      emit(turnStarted(trace, "text", text, false, false, plan))
      yield* commitPlan(plan, trace)
      if (plan.agent !== undefined) setTraceAgent(trace, plan.agent, plan.decision!, plan.decision!.unavailable)
      const log = newLog(plan, text)
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
        historyStart: evicted,
        conversationId,
        expectReply: (agentId) => {
          if (!overruled(plan)) armFor(plan.setup?.agents, agentId)
        }
      }
      return reply(ctx).pipe(
        Stream.mapError(toLlmError),
        Stream.onExit((exit) => finishTurn(log, trace, false, exit, false))
      )
    }))

  const voice = <E>(events: Stream.Stream<ConversationInput, E>): Effect.Effect<void, E, Tts | AudioOutput> =>
    Effect.scoped(Effect.gen(function*() {
      const scope = yield* Effect.scope
      const defaultTts = yield* Tts
      const output = yield* AudioOutput
      let current: ActiveTurn | undefined

      const live = () => (current !== undefined && !current.done ? current : undefined)

      const contextOf = (turn: ActiveTurn, log: TurnLog, history: ReadonlyArray<Message>, historyStart: number, conversationId: string): ReplyContext => ({
        plan: turn.plan,
        log,
        trace: turn.trace,
        utterance: turn.text,
        source: turn.source,
        spoken: turn.spoken,
        speculative: turn.trace.speculative,
        promoted: Deferred.await(turn.promoted),
        history,
        historyStart,
        conversationId,
        expectReply: (agentId) => {
          // The owner chose an agent by hand after this turn was planned: that choice stands,
          // whether the request comes before promotion (stored) or after it (applied now).
          if (overruled(turn.plan)) return
          if (turn.pending) turn.expectReply = agentId
          else armFor(turn.plan.setup?.agents, agentId)
        }
      })

      /** A typed turn without speech: the reply is only text (deltas go out as events). */
      const unspokenBody = (ctx: ReplyContext) => Stream.runDrain(reply(ctx))

      const turnBody = (turn: ActiveTurn, ctx: ReplyContext) =>
        Effect.gen(function*() {
          const log = ctx.log
          // The turn's voice, fixed at its start (`TurnSetup.tts`), else the voice loop's.
          const tts = ctx.plan.tts ?? ctx.plan.setup?.tts ?? defaultTts
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
          /** The output reported its authoritative final count (`PlaybackObserver.final`): nothing after it counts. */
          let finalized = false
          const progress = (samples: number) => {
            if (finalized) return
            let played = log.played
            while (played < clauseStarts.length && clauseStarts[played]! < samples) played++
            markPlayed(played)
          }
          const observer: PlaybackObserver = {
            started: () => {
              markStarted()
              progress(1)
            },
            progress,
            // Authoritative: the clauses heard are recomputed from it and may SHRINK (a clause whose
            // first sample lies at or beyond the final count was not heard), before history is
            // committed. A `ClausePlaying` already emitted for such a clause cannot be recalled.
            final: (samples: number) => {
              if (finalized) return
              finalized = true
              let played = 0
              while (played < clauseStarts.length && clauseStarts[played]! < samples) played++
              if (played < log.played) log.played = played
              else markPlayed(played)
              // Not everything handed over was played: recorded like an interrupted turn, never armed (round 7).
              if (samples < pulled) log.shortened = true
            }
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
        how: { readonly explicitAgent?: string | undefined; readonly say?: string; readonly answerable?: PendingEntry | undefined } = {}
      ) =>
        Effect.gen(function*() {
          // Idle reset, decided here at the turn's start (a speculative turn and its promotion see the same
          // history); a canned `Say` is not a turn of the conversation. What an utterance could answer belonged
          // to the old conversation.
          const reset = how.say === undefined && (yield* resetIfIdle)
          const answerable = reset ? undefined : how.answerable
          const plan: TurnPlan = how.say !== undefined
            ? { canned: how.say, tts: (yield* options.setup).tts }
            : planTurn(yield* options.setup, text, source, how.explicitAgent, answerable)
          const trace = tt.begin(source, speculative)
          const promoted = yield* Deferred.make<void>()
          if (!speculative) {
            tt.mark(trace, "endOfTurn")
            yield* Deferred.succeed(promoted, undefined)
          }
          const turn: ActiveTurn = { text, source, spoken, pending: speculative, speaking: false, done: false, promoted, trace, plan }
          const log = newLog(plan, text)
          current = turn
          emit(turnStarted(trace, source, text, speculative, spoken, plan))
          if (plan.agent !== undefined) setTraceAgent(trace, plan.agent, plan.decision!, plan.decision!.unavailable)
          if (!speculative) yield* commitPlan(plan, trace)
          const ctx = contextOf(turn, log, history.slice(), evicted, conversationId)
          // Forked uninterruptible so the exit handler is installed even if the
          // turn is interrupted before it starts running; the body is interruptible.
          turn.fiber = yield* Effect.interruptible(spoken ? turnBody(turn, ctx) : unspokenBody(ctx)).pipe(
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                turn.done = true
                if (current === turn) current = undefined
                return finishTurn(log, trace, spoken, exit, turn.pending, turn.stopped === true)
              })
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope, { uninterruptible: true })
          )
        })

      const interrupt = (turn: ActiveTurn) => turn.fiber === undefined ? Effect.void : Fiber.interrupt(turn.fiber)

      /**
       * The utterance being spoken, tracked apart from any reply fiber (review round 3):
       * `SpeechStarted` opens it, its `EndOfTurn` closes it. An eager or final transcript, or a
       * `TurnResumed`, with no utterance open breaks the `SttEvent` contract and is ignored
       * (review round 6; before, an eager transcript opened one).
       */
      let utteranceOpen = false
      /** The armed confirmation entry when the open utterance began (`SpeechStarted`): what it may answer. */
      let utteranceAnswerable: PendingEntry | undefined
      /**
       * Stop cancelled the open utterance, whether or not a turn existed for it (before
       * its first eager transcript, between speculative replies after `TurnResumed`, or
       * with a speculative turn pending). Until that utterance ends, whatever the
       * recogniser sends for it (eager transcripts, `TurnResumed`, a new `SpeechStarted`
       * inside it, the final transcript with any words) starts nothing. It ends with its
       * `EndOfTurn` (which is swallowed); after that, `SpeechStarted` begins something new,
       * and typed text and `Say` always do (docs/ARCHITECTURE.md, `SttEvent`). A recogniser
       * that breaks that contract cannot leave the conversation deaf: the cancellation
       * lapses after `CANCELLED_UTTERANCE_MS`.
       */
      let cancelled: { readonly until: number } | undefined
      const utteranceCancelled = (): boolean => {
        if (cancelled !== undefined && tt.now() >= cancelled.until) cancelled = undefined
        return cancelled !== undefined
      }

      /**
       * A transcript (eager or final) or `TurnResumed` with no utterance open — no `SpeechStarted`
       * since the last `EndOfTurn` — breaks the `SttEvent` contract (review round 6: a duplicated
       * final ran its action twice). It is ignored: it starts, promotes, discards and interrupts
       * nothing. Logged at most once per `PROTOCOL_LOG_MS`.
       */
      let lastViolationLog = Number.NEGATIVE_INFINITY
      const outsideUtterance = (event: SttEvent): Effect.Effect<void> => {
        const now = tt.now()
        if (now - lastViolationLog < PROTOCOL_LOG_MS) return Effect.void
        lastViolationLog = now
        return Effect.logWarning(`Speech recognition sent ${event._tag} with no utterance open (no SpeechStarted since the last EndOfTurn); ignored`)
      }

      const handle = (event: LoopInput): Effect.Effect<void> =>
        Effect.gen(function*() {
          const turn = live()
          switch (event._tag) {
            case "EagerEndOfTurn": {
              if (!utteranceOpen) return yield* outsideUtterance(event)
              if (utteranceCancelled()) return
              // No words (yet): nothing to reply to. A speculative turn for earlier words is
              // no longer what is being said, so it is discarded; a committed turn is left alone.
              if (isBlank(event.text)) {
                if (turn?.pending) yield* interrupt(turn)
                return
              }
              if (turn !== undefined) {
                if (!turn.pending && !bargeIn) return
                yield* interrupt(turn)
              }
              return yield* start(event.text, true, "voice", true, { answerable: utteranceAnswerable })
            }
            case "TurnResumed": {
              if (!utteranceOpen) return yield* outsideUtterance(event)
              if (turn?.pending) yield* interrupt(turn)
              return
            }
            case "EndOfTurn": {
              if (!utteranceOpen) return yield* outsideUtterance(event)
              utteranceOpen = false
              if (utteranceCancelled()) {
                cancelled = undefined // the stopped utterance is over
                return
              }
              // An utterance that ended with no words (the recogniser heard sound but no speech):
              // it is closed (above) and its speculative turn, if any, discarded; nothing starts —
              // no agent request, no history entry, no canned reply, for every agent kind.
              if (isBlank(event.text)) {
                if (turn?.pending) yield* interrupt(turn)
                return
              }
              // Any turn can act on the world (an intent agent by hand-off or fallback, a model
              // through its tools): promoted only for the same canonical text.
              if (turn?.pending && sameUtterance(turn.text, event.text)) {
                turn.pending = false
                tt.mark(turn.trace, "endOfTurn")
                emit({ _tag: "TurnPromoted", turnId: turn.trace.id })
                yield* commitPlan(turn.plan, turn.trace)
                if (turn.expectReply !== undefined && !overruled(turn.plan)) armFor(turn.plan.setup?.agents, turn.expectReply)
                return yield* Deferred.succeed(turn.promoted, undefined)
              }
              if (turn !== undefined) {
                if (!turn.pending && !bargeIn) return
                yield* interrupt(turn)
              }
              return yield* start(event.text, false, "voice", true, { answerable: utteranceAnswerable })
            }
            case "SpeechStarted": {
              // A new utterance begins, unless the stopped one is still open (speech resumed inside it).
              if (!utteranceOpen) {
                cancelled = undefined
                // What this utterance can answer is fixed now, by what had been played to its end NOW
                // (round 7): the armed entry, if any. Never improved by later playback reports.
                utteranceAnswerable = asked?.entry
              }
              utteranceOpen = true
              // A committed turn is interrupted whether or not its audio has started
              // (otherwise a stale reply could start playing over the user). A pending
              // speculative turn is left to TurnResumed / EndOfTurn.
              if (bargeIn && turn !== undefined && !turn.pending) yield* interrupt(turn)
              return
            }
            case "Interim":
              return
            case "TextInput": {
              cancelled = undefined
              const answerable = asked?.entry
              // Deliberate input: replaces whatever runs, whatever the barge-in setting.
              if (turn !== undefined) yield* interrupt(turn)
              return yield* start(event.text, false, "text", event.speak, { explicitAgent: event.agentId, answerable })
            }
            case "Say": {
              cancelled = undefined
              if (turn !== undefined) yield* interrupt(turn)
              return yield* start("", false, "text", true, { say: event.text })
            }
            case "SetActiveAgent": {
              if (!legacy) {
                manualRouting++
                setRouterState(setActiveAgent(routerState, event.agentId, tt.now()), true)
              }
              return
            }
            case "Interrupt":
              return yield* stop(turn)
            case "NewConversation": {
              // As Stop, then the new conversation (the stopped turn is committed to the old one first).
              yield* stop(turn)
              return yield* Deferred.succeed(event.done, yield* resetConversation(event.reason))
            }
          }
        })

      /**
       * Stop cancels whatever runs, a speculative turn included, and the open utterance whether or
       * not a turn exists for it: the rest of that utterance (eager transcripts, its final EndOfTurn)
       * must not then start a reply.
       */
      const stop = (turn: ActiveTurn | undefined) =>
        Effect.gen(function*() {
          if (utteranceOpen || turn?.pending === true) cancelled = { until: tt.now() + CANCELLED_UTTERANCE_MS }
          if (turn !== undefined) {
            turn.stopped = true
            yield* interrupt(turn)
          }
        })

      // `newConversation` reaches the loop through this queue, so it is handled in order with the events.
      const control = yield* Queue.unbounded<VoiceControl>()
      voiceControl = control
      yield* Effect.addFinalizer(() =>
        Effect.gen(function*() {
          if (voiceControl === control) voiceControl = undefined
          // Requests that arrived as the loop ended: answered without a loop.
          for (const request of yield* Queue.clear(control)) yield* Deferred.succeed(request.done, yield* resetConversation(request.reason))
        }).pipe(Effect.orDie)
      )
      const controlEvents = Stream.fromQueue(control).pipe(
        Stream.map((request): LoopInput => ({ _tag: "NewConversation", reason: request.reason, done: request.done }))
      )
      yield* Stream.runForEach(Stream.merge(events as Stream.Stream<LoopInput, E>, controlEvents, { haltStrategy: "left" }), handle)

      const last = live()
      if (last?.fiber !== undefined) {
        if (last.pending) yield* Fiber.interrupt(last.fiber)
        else yield* Fiber.await(last.fiber)
      }
    }))

  const newConversation = (reason: ConversationStartReason = "new"): Effect.Effect<string> =>
    Effect.suspend(() => {
      const control = voiceControl
      if (control === undefined) return resetConversation(reason)
      return Effect.gen(function*() {
        const done = yield* Deferred.make<string>()
        yield* Queue.offer(control, { reason, done })
        return yield* Deferred.await(done)
      })
    })

  return Conversation.of({
    voice,
    textTurn,
    history: Effect.sync(() => history.slice()),
    routerState: Effect.sync(() => routerState),
    newConversation,
    conversationId: Effect.sync(() => conversationId),
    lastTurnAt: Effect.sync(() => lastTurnAt)
  })
})
