import type { RouteReason } from "@pva/protocol"

/**
 * Which agent answers a turn (docs/AGENTS-AND-INTENTS.md §2).
 *
 * The router is a pure, synchronous function of the utterance, the routing
 * state and the clock: it runs at the start of every turn, including a
 * speculative one, so it must never wait for anything. A trigger phrase at the
 * start of the utterance ("hey Jev, …") picks its agent; tolerant matching
 * accepts misrecognised triggers ("hey Jeff", "hay jev", "J. E. V."). The rules
 * are data from the settings screen, not code. `Router` is an interface, so the
 * trigger router can be replaced by another implementation with the same shape.
 */

/** Routing memory between turns. Changed only when a turn is committed. */
export interface RouterState {
  readonly sticky?: { readonly agentId: string; readonly lastUsedAt: number } | undefined
  readonly armed?: { readonly agentId: string; readonly until: number } | undefined
}

export const initialRouterState: RouterState = {}

export interface RouteInput {
  /** The transcript (or typed text) of the whole utterance. */
  readonly text: string
  readonly source: "voice" | "text"
  /** Chosen in the chat composer: wins over everything; a trigger in the text is still removed. */
  readonly explicitAgent?: string | undefined
  readonly state: RouterState
  /** Monotonic milliseconds (the turn trace clock). */
  readonly now: number
  /** True when the agent is enabled and running in this turn's snapshot. */
  readonly isAvailable: (agentId: string) => boolean
}

export interface TriggerMatch {
  /** Index of the rule in the router's configuration. */
  readonly rule: number
  /** The rule's agent, `DEFAULT_AGENT_REF` resolved. */
  readonly agentId: string
  readonly mode: "turn" | "conversation"
  /** The phrase (as configured) that matched. */
  readonly phrase: string
  /** The words of the utterance that matched, as said ("Hey Jeff"). */
  readonly matched: string
  /** Offset in the utterance just past the matched words. */
  readonly end: number
  /** 1 = exact; lower for phonetic or approximate matches (≥ 0.75), or a missing greeting. */
  readonly score: number
}

export interface RouteDecision {
  /** The agent that answers; `undefined` when no agent is available at all. */
  readonly agentId: string | undefined
  readonly reason: RouteReason
  /**
   * The agent the route pointed at when it is not available; the turn went to
   * the default (or fallback) agent instead. The UI shows it, and when the owner
   * asked for that agent on purpose (any reason but `default`) the assistant says so.
   */
  readonly unavailable?: string
  /** What the agent receives: the utterance without the trigger, first letter upper-cased. */
  readonly text: string
  readonly trigger?: TriggerMatch
  /**
   * The utterance was only a trigger: speak this instead of running an agent
   * (the agent is armed for the next utterance). Present only for trigger-only utterances.
   */
  readonly acknowledge?: string
  /** The router state to keep if this turn is committed (a discarded speculative turn changes nothing). */
  readonly next: RouterState
}

/** A replaceable router. Must be synchronous and fast: it runs before every turn, speculative ones included. */
export interface Router {
  readonly route: (input: RouteInput) => RouteDecision
  /** The trigger at the start of `text`, if any (exposed for tests and the settings screen's "try a phrase"). */
  readonly matchTrigger: (text: string) => TriggerMatch | undefined
}

/** Arm `agentId` for the next utterance (the agent asked a question, or the utterance was only its trigger). */
export const armAgent = (state: RouterState, agentId: string, now: number, ms: number): RouterState => ({
  ...state,
  armed: { agentId, until: now + ms }
})

/** `routing.set`: make `agentId` sticky, or clear stickiness with `null`. Clears any armed agent. */
export const setActiveAgent = (state: RouterState, agentId: string | null, now: number): RouterState =>
  agentId === null ? {} : { sticky: { agentId, lastUsedAt: now } }

/** What the UI shows as the agent for the next untriggered utterance. */
export const activeAgent = (
  state: RouterState,
  config: { readonly defaultAgent: string; readonly stickyIdleMs: number },
  now: number
): { readonly agentId: string; readonly reason: "default" | "sticky" | "armed"; readonly expiresInMs?: number } => {
  if (state.armed !== undefined && now < state.armed.until) {
    return { agentId: state.armed.agentId, reason: "armed", expiresInMs: state.armed.until - now }
  }
  if (state.sticky !== undefined && now - state.sticky.lastUsedAt < config.stickyIdleMs) {
    return { agentId: state.sticky.agentId, reason: "sticky", expiresInMs: state.sticky.lastUsedAt + config.stickyIdleMs - now }
  }
  return { agentId: config.defaultAgent, reason: "default" }
}
