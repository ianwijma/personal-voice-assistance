import { AGENT_ID, AGENT_NAME } from "@pva/agent-claude-code"
import {
  type Agent,
  type AgentEvent,
  type AgentTurnSetup,
  initialRouterState,
  type Llm,
  makeModelAgent,
  type Router,
  type TurnSetup
} from "@pva/core"
import type { ModuleInfo } from "@pva/protocol"
import { Stream } from "effect"

/**
 * `LLM_PROVIDER=claude-subscription`: the language model is the
 * `claude-subscription` agent module (Claude Code with the owner's own login,
 * `@pva/agent-claude-code`), run through the agent conversation
 * (`makeAgentConversation`). The running agent is read from the module host's
 * snapshot at the start of every turn, so switching the module on or off in
 * the UI takes effect from the next turn without a reload.
 *
 * While it is not running (off, starting, failed), or when it fails a turn
 * before saying anything, the router marks it `unavailable` and the offline
 * stand-in answers instead, starting with a spoken notice that says why.
 */

export const SUBSCRIPTION_PROVIDER = "claude-subscription"
export const SUBSCRIPTION_AGENT_ID = AGENT_ID
export const OFFLINE_AGENT_ID = "offline"

/** What the stand-in says first, from the module's state. */
export const subscriptionNotice = (module: ModuleInfo | undefined): string => {
  if (module === undefined || !module.enabled) return "Claude subscription is off — switch it on in Settings, Language model."
  if (module.state === "starting") return "Claude subscription is still starting — try again in a moment."
  if (module.state === "error") return "Claude subscription could not start — see Settings, Language model."
  return "Claude subscription did not answer."
}

const NEWLINE: AgentEvent = { _tag: "TextDelta", text: "\n" }

/** The offline stand-in model as an agent that first says `notice()` (as its own clause). */
export const offlineAgentWithNotice = (llm: Llm["Service"], notice: () => string): Agent => {
  const model = makeModelAgent({ llm })
  return {
    id: OFFLINE_AGENT_ID,
    name: "Offline stand-in",
    kind: "model",
    speculate: true,
    firstEventTimeoutMs: Number.POSITIVE_INFINITY,
    turn: (input) =>
      Stream.suspend(() => Stream.fromIterable<AgentEvent>([{ _tag: "TextDelta", text: notice() }, NEWLINE])).pipe(
        Stream.concat(model.turn(input))
      )
  }
}

/** Always the subscription agent when it is running; otherwise the stand-in, with the agent marked unavailable. */
export const subscriptionRouter: Router = {
  route: (input) =>
    input.isAvailable(SUBSCRIPTION_AGENT_ID)
      ? { agentId: SUBSCRIPTION_AGENT_ID, reason: "default", text: input.text, next: initialRouterState }
      : { agentId: OFFLINE_AGENT_ID, reason: "default", unavailable: SUBSCRIPTION_AGENT_ID, text: input.text, next: initialRouterState },
  matchTrigger: () => undefined
}

export interface SubscriptionAgentsOptions {
  /** The offline stand-in model (`LlmLayer` builds it for this provider). */
  readonly fallbackLlm: Llm["Service"]
  /** The running agents, read per turn (`host.snapshot().agents`). */
  readonly agents: () => ReadonlyMap<string, Agent>
  /** The module's current info, for the notice. */
  readonly module: () => ModuleInfo | undefined
  /** The stable system prompt for an agent with its own prompt (`Agent.systemPrompt`); default: the turn's. */
  readonly promptFor?: (agent: Agent, setup: TurnSetup) => string
}

/** Turn a turn's `TurnSetup` into the agent setup for this provider. Cheap: a map lookup per turn. */
export const makeSubscriptionAgents = (options: SubscriptionAgentsOptions): (setup: TurnSetup) => AgentTurnSetup => {
  const offline = offlineAgentWithNotice(options.fallbackLlm, () => subscriptionNotice(options.module()))
  const names: ReadonlyMap<string, string> = new Map([[SUBSCRIPTION_AGENT_ID, AGENT_NAME], [OFFLINE_AGENT_ID, offline.name]])
  const alone: ReadonlyMap<string, Agent> = new Map([[OFFLINE_AGENT_ID, offline]])
  return (setup) => {
    const claude = options.agents().get(SUBSCRIPTION_AGENT_ID)
    const agents: ReadonlyMap<string, Agent> = claude === undefined ? alone : new Map([[SUBSCRIPTION_AGENT_ID, claude], [OFFLINE_AGENT_ID, offline]])
    const promptFor = options.promptFor
    return {
      ...setup,
      agents: {
        router: subscriptionRouter,
        agents,
        names,
        defaultAgent: SUBSCRIPTION_AGENT_ID,
        fallbackAgent: OFFLINE_AGENT_ID,
        ...(promptFor !== undefined ? { promptFor: (agent: Agent) => promptFor(agent, setup) } : {})
      }
    }
  }
}
