import type { AgentKind, RouteReason } from "@pva/protocol"
import { type Effect, Schema, type Stream } from "effect"
import type { RegisteredAction } from "./Actions.ts"
import type { DecisionProvider } from "./Decision.ts"
import type { Message, ToolCall, ToolResult } from "./Domain.ts"
import type { ToolRegistry } from "./ToolRegistry.ts"
import type { Trace, TraceMark } from "./TurnTrace.ts"

/**
 * Agents: the interchangeable responders behind one interface
 * (docs/AGENTS-AND-INTENTS.md §1).
 *
 * - `model` agents make one model call per request and leave the tool loop to
 *   the assistant (`makeModelAgent` wraps any `Llm`): Anthropic API,
 *   OpenAI-compatible servers (OpenRouter, Ollama, llama.cpp, LM Studio, vLLM),
 *   the offline stand-in.
 * - `harness` agents run their own loop and keep their own session (Claude and
 *   Codex subscriptions through their CLIs); the assistant's tools are handed
 *   to them, and their tool activity is reported back.
 * - `intent` agents recognise a command among the enabled modules' actions and
 *   run it, with no conversational model (Jev).
 *
 * `Conversation` drives every kind the same way: it calls `turn` once per
 * turn, feeds the `TextDelta`s to the clause chunker and TTS, records tool
 * rounds in the shared history, and interrupts the stream on barge-in.
 *
 * `Conversation` drives agents through `makeAgentConversation`; `makeModelAgent`
 * (ModelAgent.ts) wraps an `Llm`.
 */

/** What an agent gets for one turn. Everything is read once at the start of the turn (a snapshot). */
export interface AgentTurnInput {
  /** The turn's id (= trace id). */
  readonly turnId: number
  /** What the agent should answer: the utterance with the trigger phrase removed. */
  readonly text: string
  /** The utterance as recognised or typed, trigger included. */
  readonly utterance: string
  readonly source: "voice" | "text"
  /** The reply will be synthesised and played. */
  readonly spoken: boolean
  readonly routedBy: RouteReason
  /**
   * The shared conversation history before this turn, committed messages only
   * (interrupted replies hold only what was heard). The same for every agent.
   */
  readonly history: ReadonlyArray<Message>
  /** Stable system prompt for this agent: its own prompt (or the global one) + module instructions + voice block. Cacheable. */
  readonly system: string
  /** Per-turn facts from context providers (time, ...); `undefined` when empty. Never cached. */
  readonly context: string | undefined
  /** Tools of the running modules plus the generated action tools, for agents that use tools. */
  readonly tools: ToolRegistry["Service"]
  /** Actions of the running modules (intent agents). */
  readonly actions: ReadonlyArray<RegisteredAction>
  /** Running decision providers by module id (intent agents). */
  readonly deciders: ReadonlyMap<string, DecisionProvider>
  /**
   * Completes when the turn is committed: at once for a normal turn, at
   * `EndOfTurn` for a speculative one. Await it before any side effect
   * (a non-speculative tool or action). A discarded turn is interrupted instead.
   */
  readonly promoted: Effect.Effect<void>
  /** True when the turn started from `EagerEndOfTurn` (it may still be discarded). */
  readonly speculative: boolean
  /** Record a latency mark on the turn's trace (synchronous, first call per mark counts). */
  readonly mark: (mark: TraceMark) => void
  /** Record a tool or action duration on the trace. */
  readonly trace: Trace
  /**
   * The trace clock (monotonic milliseconds), for measuring tool and action
   * durations on the same scale as the marks. Optional for agents' own tests;
   * fall back to `Clock.currentTimeMillis` when absent.
   */
  readonly now?: (() => number) | undefined
  /** Upper bound on tool rounds (model agents; harness agents pass it on where the harness supports it). */
  readonly maxToolRounds: number
}

/**
 * What an agent emits while it answers. The stream ending is completion; a
 * failure is `AgentError`. Text deltas are spoken as they arrive (clause by
 * clause); a delta of exactly `"\n"` separates rounds and makes the chunker
 * flush, so "let me check" is heard while a tool runs: agents emit it before
 * their first tool call after text.
 */
export type AgentEvent =
  | { readonly _tag: "TextDelta"; readonly text: string }
  /** A tool call starts (model and harness agents). Recorded in history as part of a round. */
  | { readonly _tag: "ToolStarted"; readonly call: ToolCall }
  | { readonly _tag: "ToolFinished"; readonly result: ToolResult; readonly ms: number }
  /** An intent agent's decision, for the UI and trace. Not recorded in history. */
  | { readonly _tag: "Decision"; readonly decision: IntentDecisionInfo }
  /** An intent action starts / ends. Shown like a tool call; not recorded in history (the spoken text is). */
  | { readonly _tag: "ActionStarted"; readonly callId: string; readonly actionId: string; readonly label: string; readonly params: Readonly<Record<string, unknown>> }
  | { readonly _tag: "ActionFinished"; readonly callId: string; readonly ok: boolean; readonly ms: number; readonly error?: string }
  /** The agent asked the owner something: route the next utterance back to it (armed, `RoutingConfig.armedMs`). */
  | { readonly _tag: "ExpectReply" }
  /**
   * The agent passes this turn on before producing any text (an intent agent
   * found no matching action). `Conversation` re-runs the same turn on the
   * fallback agent; emitting it after text is a defect.
   */
  | { readonly _tag: "Handoff"; readonly reason: string }

/** Shown in the chat for an intent turn (`intent.decision` in the protocol). */
export interface IntentDecisionInfo {
  readonly decider: string
  readonly outcome: "act" | "ask" | "confirm" | "cancelled" | "fallback" | "error"
  readonly action?: { readonly id: string; readonly label: string; readonly moduleId: string }
  readonly params: ReadonlyArray<{ readonly name: string; readonly label: string; readonly value: string; readonly probability?: number }>
  readonly probability?: number
  readonly ms: number
  readonly reason?: string
}

/**
 * - `unavailable`: the agent cannot answer at all right now (not logged in, server
 *   unreachable, session crashed). Before any output, `Conversation` falls back.
 * - `timeout`: no first event within the agent's limit. Same fallback.
 * - `failed`: anything else.
 */
export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
  reason: Schema.Literals(["unavailable", "timeout", "failed"]),
  cause: Schema.optional(Schema.Defect())
}) {}

export interface Agent {
  /** The module id of the agent ("anthropic", "claude-subscription", "jev"). */
  readonly id: string
  /** Display name ("Claude (API)", "Claude subscription", "Jev"). */
  readonly name: string
  readonly kind: AgentKind
  /**
   * May `turn` run before the turn is committed? `true`: started at
   * `EagerEndOfTurn` like today's turns (model agents; intent agents, which only
   * decide speculatively and act after promotion). `false`: `Conversation`
   * waits for promotion before calling `turn` (harness agents by default: their
   * session cannot take back a message, and a discard wastes subscription quota).
   */
  readonly speculate: boolean
  /** Replaces the global system prompt for this agent when set (module instructions and the voice block are still appended). */
  readonly systemPrompt?: string | undefined
  /** No first event within this long fails the turn with `timeout` (and falls back if nothing was said). */
  readonly firstEventTimeoutMs: number
  /** Answer one turn. Interrupting the stream must stop the agent's work promptly and leave it ready for the next turn. */
  readonly turn: (input: AgentTurnInput) => Stream.Stream<AgentEvent, AgentError>
}
