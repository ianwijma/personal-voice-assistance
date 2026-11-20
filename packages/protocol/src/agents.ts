import { Schema } from "effect"
import { SettingField, type SettingFieldType, SettingsForm, SettingsPatch, SettingValue } from "./settings.ts"

/**
 * Module kinds, agent kinds, route reasons and the extended settings field types (docs/AGENTS-AND-INTENTS.md §5). The
 * field types (`SettingFieldV2`, `SettingsFormV2`, `SettingsPatchV2`) are what module forms use through
 * `SettingsExtra`; `ModuleKind` is on `ModuleInfo.kind`. The messages and optional fields that the first design added
 * here (`module.action`, `routing.set`, `routing`, `intent.decision`, `turn.agent`, the agent fields of turns and
 * traces, `ErrorCodeV2`) were never put into the unions and were removed with the assistants work: routing is the
 * route gate and the dispatcher (docs/ASSISTANTS.md), and a turn names its assistant and route (`TraceInfo`).
 */

// ---------------------------------------------------------------------------
// Shared literals

/** What a module contributes; the UI groups cards by it. Absent = "capability" (v1 modules). */
export const ModuleKind = Schema.Literals(["capability", "agent", "decider"])
export type ModuleKind = typeof ModuleKind.Type

/**
 * - `model`: one model call per request; the assistant runs the tool loop (Anthropic API, OpenAI-compatible servers, offline stand-in).
 * - `harness`: a whole agent that runs its own loop and keeps its own session (Claude or Codex subscription).
 * - `intent`: recognises a command and runs a programmatic action (Jev); no conversation.
 */
export const AgentKind = Schema.Literals(["model", "harness", "intent"])
export type AgentKind = typeof AgentKind.Type

/**
 * Why a turn went to its agent:
 * - `explicit`: chosen in the chat composer (`text.send.agentId`);
 * - `trigger`: a trigger phrase at the start of the utterance;
 * - `armed`: the previous turn was only a trigger, or the agent asked a question, so this reply goes back to it;
 * - `sticky`: a conversation-mode trigger selected the agent for the following turns;
 * - `default`: none of the above.
 */
export const RouteReason = Schema.Literals(["explicit", "trigger", "armed", "sticky", "default"])
export type RouteReason = typeof RouteReason.Type

// ---------------------------------------------------------------------------
// The extended settings field types

/*
 * Protocol 10: `TextListField`, `RecordsField` (with `RecordItemField` and `RecordValue`), `ComboField`,
 * `ActionField` and `InfoField` moved to `settings.ts` and joined `SettingField`, so agent, module and section forms
 * share one wire form. The `V2` names stay as aliases.
 */
export { ActionField, ComboField, InfoField, RecordItemField, RecordsField, RecordValue, TextListField } from "./settings.ts"

export const SettingFieldV2 = SettingField
export type SettingFieldV2 = SettingField
export type SettingFieldTypeV2 = SettingFieldType
export const SettingValueV2 = SettingValue
export type SettingValueV2 = SettingValue
export const SettingsFormV2 = SettingsForm
export type SettingsFormV2 = SettingsForm
export const SettingsPatchV2 = SettingsPatch
export type SettingsPatchV2 = SettingsPatch
