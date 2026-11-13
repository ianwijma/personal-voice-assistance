/**
 * Valid examples of the protocol additions in `agents.ts`, for tests and mocks
 * (`import { agentExamples } from "@pva/protocol/agent-examples"`). Not part of
 * `@pva/protocol/examples` until the integration step merges the additions.
 */
import type {
  ActionInfo,
  ClientMessageAdditions,
  RoutingInfo,
  ServerMessageAdditions,
  SettingFieldV2,
  SettingsFormV2
} from "./agents.ts"

export const exampleRouting: RoutingInfo = {
  defaultAgent: "anthropic",
  activeAgent: "claude-subscription",
  reason: "sticky",
  expiresInMs: 104_000
}

export const exampleLightsOnAction: ActionInfo = {
  id: "demo-home.lights_on",
  label: "Turn lights on",
  description: "Switch on the lights in a room, one light, or every light.",
  params: [{
    name: "target",
    label: "Room or light",
    kind: "dynamic",
    optional: false,
    options: ["Living room", "Kitchen", "Bedroom", "Office", "Desk lamp", "All lights"]
  }],
  speculative: false,
  confirm: false,
  tool: "demo-home_lights_on"
}

/** The routing section's rule list, as the server describes it. */
export const exampleRulesField: SettingFieldV2 = {
  type: "records",
  key: "ROUTING_RULES",
  label: "Trigger phrases",
  description: "Said at the start of a sentence, a phrase sends that sentence to its agent. First match wins.",
  apply: "live",
  default: [{ agent: "jev", phrases: ["hey jev", "hey jeff"], mode: "turn" }],
  itemFields: [
    { type: "choice", key: "agent", label: "Agent", default: "jev", options: [{ value: "jev", label: "Jev" }, { value: "anthropic", label: "Claude (API)" }] },
    { type: "textList", key: "phrases", label: "Phrases", default: [], maxItems: 10, itemMaxLength: 40 },
    {
      type: "choice",
      key: "mode",
      label: "Applies to",
      default: "turn",
      options: [{ value: "turn", label: "That sentence" }, { value: "conversation", label: "Following sentences too" }]
    }
  ],
  itemLabel: "rule",
  titleKey: "agent",
  maxItems: 20,
  orderable: true
}

export const exampleAgentForm: SettingsFormV2 = {
  fields: [
    {
      type: "combo",
      key: "model",
      label: "Model",
      apply: "live",
      default: "claude-haiku-5-5",
      options: [{ value: "claude-haiku-5-5", label: "Claude Haiku 5.5" }, { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }],
      allowCustom: true,
      optionsNote: "From Anthropic's model list"
    },
    { type: "secret", key: "apiKey", label: "API key", apply: "live", env: "ANTHROPIC_API_KEY" },
    { type: "info", key: "lastTest", label: "Last test", apply: "live", tone: "ok" },
    { type: "action", key: "test", label: "Test", apply: "live", buttonLabel: "Send a test message", requiresSaved: true },
    exampleRulesField
  ],
  values: {
    model: "claude-haiku-5-5",
    lastTest: "First text after 640 ms",
    ROUTING_RULES: [{ agent: "jev", phrases: ["hey jev", "hey jeff"], mode: "turn" }]
  },
  secrets: { apiKey: { set: true, source: "store" } },
  errors: []
}

export const agentClientExamples: { readonly [T in ClientMessageAdditions["type"]]: Extract<ClientMessageAdditions, { type: T }> } = {
  "module.action": { type: "module.action", requestId: "r7", moduleId: "anthropic", key: "test" },
  "settings.action": { type: "settings.action", requestId: "r8", sectionId: "voice-natural", key: "PLAY_SAMPLE" },
  "routing.set": { type: "routing.set", requestId: "r9", agentId: null }
}

export const agentServerExamples: { readonly [T in ServerMessageAdditions["type"]]: Extract<ServerMessageAdditions, { type: T }> } = {
  routing: { type: "routing", routing: exampleRouting },
  "intent.decision": {
    type: "intent.decision",
    turnId: 31,
    agentId: "jev",
    decider: "jev-typesafe",
    outcome: "act",
    action: { id: "demo-home.lights_on", label: "Turn lights on", moduleId: "demo-home" },
    params: [{ name: "target", label: "Room or light", value: "Living room", probability: 0.93 }],
    probability: 0.93,
    ms: 241
  },
  "turn.agent": {
    type: "turn.agent",
    turnId: 32,
    agent: { id: "anthropic", name: "Claude (API)", kind: "model" },
    from: { id: "jev", name: "Jev", kind: "intent" },
    reason: "handoff"
  }
}
