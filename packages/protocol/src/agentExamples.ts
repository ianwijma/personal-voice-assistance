/**
 * Valid examples of the extended settings field types in `agents.ts`, for tests and mocks
 * (`import { exampleRulesField } from "@pva/protocol/agent-examples"`).
 */
import type { SettingFieldV2, SettingsFormV2 } from "./agents.ts"

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
