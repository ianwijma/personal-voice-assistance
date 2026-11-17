import type { RouteReason } from "@pva/protocol"
import type { Effect } from "effect"
import type { RegisteredAction } from "./Actions.ts"
import type { Agent, IntentDecisionInfo } from "./Agent.ts"
import type { DecisionProvider } from "./Decision.ts"
import type { SttEvent, ToolCall, ToolResult } from "./Domain.ts"
import type { Router, RouterState } from "./Routing.ts"
import type { Llm, Tts } from "./Services.ts"
import type { ToolRegistry } from "./ToolRegistry.ts"
import type { Trace, TurnOutcome } from "./TurnTrace.ts"

/**
 * Types of the serve-mode additions to `Conversation` and `AudioOutput`
 * (docs/UI-AND-MODULES.md §4.3).
 */

/**
 * What happened inside the conversation, emitted synchronously through
 * `ConversationOptions.onEvent`. The callback must not block or
 * throw: it runs on the turn's fiber, between LLM deltas and audio chunks.
 * Speculative turns emit events too; the subscriber decides what to show
 * (serve mode buffers a pending turn's events and releases them on
 * `TurnPromoted`, or drops them when the turn ends `discarded`).
 */
/** Why a new conversation started (`Conversation.newConversation`): asked for, or the idle reset. */
export type ConversationStartReason = "new" | "idle"

export type ConversationEvent =
  /**
   * A new conversation started (`newConversation`, or the idle reset at a turn's start): the history is empty and
   * `conversationId` is new. Emitted on the fiber that started it, before the next turn's `TurnStarted`.
   */
  | { readonly _tag: "ConversationStarted"; readonly conversationId: string; readonly reason: ConversationStartReason }
  | {
    readonly _tag: "TurnStarted"
    /** The turn's `Trace.id`. */
    readonly turnId: number
    readonly source: "voice" | "text"
    /** The user's words. */
    readonly text: string
    /** Started from `EagerEndOfTurn`; not committed until `TurnPromoted`. */
    readonly speculative: boolean
    /** Audio will be synthesised and played (voice turns, and text input with `speak`). */
    readonly spoken: boolean
    // Agent conversations only (`makeAgentConversation`); absent in single-model conversations.
    /** The agent that answers; absent when no agent is available (a canned reply). */
    readonly agentId?: string
    readonly routedBy?: RouteReason
    /** The agent the route pointed at when it was not available. */
    readonly fallbackFrom?: string
    /** What the agent receives: `text` without the trigger phrase. */
    readonly agentText?: string
    /** A canned reply ("Yes?", "No agent is available right now.", `Say`): no agent runs, nothing is recorded in history. */
    readonly canned?: boolean
  }
  | { readonly _tag: "TurnPromoted"; readonly turnId: number }
  /** Raw model text, voice markers included; rounds are separated by "\n". */
  | { readonly _tag: "TextDelta"; readonly turnId: number; readonly text: string }
  /** A clause was handed to TTS (spoken turns). The text as handed over. */
  | { readonly _tag: "ClauseQueued"; readonly turnId: number; readonly index: number; readonly text: string }
  /** Every clause up to `index` has started playing (spoken turns; from playback reports when the output provides them). */
  | { readonly _tag: "ClausePlaying"; readonly turnId: number; readonly index: number }
  | { readonly _tag: "ToolStarted"; readonly turnId: number; readonly call: ToolCall }
  | { readonly _tag: "ToolFinished"; readonly turnId: number; readonly result: ToolResult; readonly ms: number }
  /** A fallback agent took over the turn before anything was said: the agent passed it on, or failed. */
  | {
    readonly _tag: "TurnAgentChanged"
    readonly turnId: number
    readonly agentId: string
    readonly from: string
    readonly reason: "handoff" | "failed"
  }
  /** An intent agent's decision (shown in the chat; not recorded in history). */
  | { readonly _tag: "IntentDecided"; readonly turnId: number; readonly agentId: string; readonly decision: IntentDecisionInfo }
  /** An intent action runs (shown like a tool call; not recorded in history). */
  | {
    readonly _tag: "ActionStarted"
    readonly turnId: number
    readonly callId: string
    readonly actionId: string
    readonly label: string
    readonly params: Readonly<Record<string, unknown>>
  }
  | { readonly _tag: "ActionFinished"; readonly turnId: number; readonly callId: string; readonly ok: boolean; readonly ms: number; readonly error?: string }
  /** The routing state changed: after a committed turn that changed it, an `ExpectReply`, or `SetActiveAgent`. */
  | { readonly _tag: "RoutingChanged"; readonly state: RouterState }
  /** After the turn's history was committed (or the turn discarded). */
  | { readonly _tag: "TurnEnded"; readonly turnId: number; readonly outcome: TurnOutcome; readonly trace: Trace }

/**
 * Input of `Conversation.voice`: speech recognition events, typed text and the
 * stop control.
 * - `TextInput` behaves like `EndOfTurn` but is deliberate, so it interrupts a
 *   running committed turn even when barge-in is disabled. With `speak: false`
 *   the reply is not synthesised and the whole reply is committed to history.
 * - `Interrupt` (the user pressed Stop) interrupts the running turn, whatever
 *   the barge-in setting. A pending speculative turn is discarded, and the
 *   eager or final transcript of that same utterance then starts nothing (until
 *   new speech, typed text or a different transcript).
 * - `SetActiveAgent` and `Say`: agent conversations (single-model conversations
 *   ignore `SetActiveAgent`; `Say` works in both).
 */
export type ConversationInput =
  | SttEvent
  | {
    readonly _tag: "TextInput"
    readonly text: string
    readonly speak: boolean
    /** The agent chosen in the composer (route reason `explicit`); absent = routed like speech. */
    readonly agentId?: string | undefined
  }
  | { readonly _tag: "Interrupt" }
  /** `routing.set`: make an agent sticky, or `null` to go back to the default. Applied at once; starts no turn. */
  | { readonly _tag: "SetActiveAgent"; readonly agentId: string | null }
  /**
   * Speak `text` as a canned turn: no agent, nothing recorded ("Play a sample").
   * Interrupts like `TextInput`.
   */
  | { readonly _tag: "Say"; readonly text: string }

/**
 * Passed by `Conversation` to `AudioOutput.play` (third parameter) when
 * the output declares `reportsPlayback: true`. Conversation then counts a clause
 * as played when the device reached its first sample, instead of when its first
 * chunk was pulled, and marks `playbackStart` on `started`.
 */
export interface PlaybackObserver {
  /** The first sample reached the audio device. Call at most once. */
  readonly started: () => void
  /**
   * Samples (at the `play` sample rate) handed to the device so far.
   * Non-decreasing. The final value must be reported before `play` returns
   * or, when interrupted, before its interruption completes.
   */
  readonly progress: (playedSamples: number) => void
  /**
   * The authoritative number of samples handed to the device when playback ended
   * (finished, stopped or failed). Called at most once, after the last `progress`
   * and before `play` returns or its interruption completes. Unlike `progress` it
   * may be lower than the last progress value: a page's exact count after a stop
   * can be below an earlier estimate. When it is called, the conversation uses it,
   * and not the last progress value, to decide which clauses were heard.
   */
  readonly final?: (playedSamples: number) => void
}

/**
 * What one turn is built from, captured once at its start so a turn never sees
 * a half-applied module change (`ConversationSetupOptions.setup`).
 */
export interface TurnSetup {
  /** Stable system prompt: base prompt + module instructions + voice block. */
  readonly system: string
  /** Immutable snapshot of the enabled modules' tools and context providers. */
  readonly registry: ToolRegistry["Service"]
  /**
   * The language model this turn uses from start to end (every round of its tool loop), in a single-model
   * conversation (`makeConversationWithSetup`). Absent: the `Llm` the conversation was made with. Serve mode's
   * resource pool sets it, so a changed model applies at the next turn start (docs/ASSISTANTS.md §3.2). Ignored by
   * agent conversations (their agents hold their own model).
   */
  readonly llm?: Llm["Service"] | undefined
  /**
   * The voice this turn speaks with, from its start to its end (`Conversation.voice`): every clause of every round,
   * a canned reply and a notice included. Absent: the `Tts` the voice loop was given. Serve mode's resource pool sets
   * it (the assistant's own voice), so a changed voice applies at the next turn start without touching a turn that is
   * speaking (docs/ASSISTANTS.md §3.2). Its `sampleRate` must be final once `ttsReady` has completed.
   */
  readonly tts?: Tts["Service"] | undefined
  /**
   * Completes once `tts.sampleRate` is final (a voice still being built). A spoken turn waits for it inside the turn,
   * just before it starts to play, so Stop, barge-in and a new conversation interrupt the wait, and a typed reply that
   * is not spoken never waits. Absent: `tts.sampleRate` is final already.
   */
  readonly ttsReady?: Effect.Effect<void> | undefined
}

/**
 * The agents one turn can use, captured with the rest of its setup
 * (docs/AGENTS-AND-INTENTS.md §1.12).
 */
export interface AgentSet {
  /** Chooses the agent at the start of every turn (synchronous, microseconds). */
  readonly router: Router
  /** Running agents by id. A routed agent missing here is "not available". */
  readonly agents: ReadonlyMap<string, Agent>
  /** Display names of every catalog agent, running or not ("Codex isn't available."). Default: the running agents' names. */
  readonly names?: ReadonlyMap<string, string> | undefined
  /** The routing configuration's default agent (the fallback for intent agents that pass a turn on). */
  readonly defaultAgent: string
  /** Takes over when the default cannot (the routing configuration's `fallbackAgent`). */
  readonly fallbackAgent?: string | undefined
  /** Actions of the running modules, for intent agents. Default none. */
  readonly actions?: ReadonlyArray<RegisteredAction> | undefined
  /** Running decision providers by id, for intent agents. Default none. */
  readonly deciders?: ReadonlyMap<string, DecisionProvider> | undefined
  /** Read per turn (live). Default: the conversation's `maxToolRounds`, else 5. */
  readonly maxToolRounds?: number | undefined
  /**
   * The stable system prompt for `agent`: its own prompt or the global one, plus
   * module instructions and the voice block. Default: the setup's `system` for every agent.
   */
  readonly promptFor?: ((agent: Agent) => string) | undefined
  /** How long an `ExpectReply` arms the agent for the next utterance. Default 10 000 ms (the router's `armedMs`). */
  readonly armedMs?: number | undefined
}

/** `TurnSetup` plus the agents (`Conversation.layerWithAgents`). */
export interface AgentTurnSetup extends TurnSetup {
  readonly agents: AgentSet
}
