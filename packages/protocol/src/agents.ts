import { Schema } from "effect"
import { ChoiceOption, NumberField, BooleanField, ChoiceField, MultiChoiceField, SecretField, SecretState, TextField } from "./settings.ts"
import { FieldError, FieldKey } from "./common.ts"

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
// New settings field types

const common = {
  key: FieldKey,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  apply: Schema.Literals(["live", "reload"]),
  advanced: Schema.optionalKey(Schema.Boolean),
  locked: Schema.optionalKey(Schema.Struct({ reason: Schema.String }))
}

/** A list of short strings (aliases, greeting words, rooms): chips with an "add" input. Value: `string[]`. */
export const TextListField = Schema.Struct({
  type: Schema.Literal("textList"),
  ...common,
  default: Schema.Array(Schema.String),
  maxItems: Schema.optionalKey(Schema.Int),
  itemMaxLength: Schema.optionalKey(Schema.Int),
  placeholder: Schema.optionalKey(Schema.String)
})

const itemCommon = {
  key: FieldKey,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String)
}

/** The field types allowed inside a record (no secrets, no nesting, no actions). */
export const RecordItemField = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    ...itemCommon,
    default: Schema.String,
    placeholder: Schema.optionalKey(Schema.String),
    maxLength: Schema.optionalKey(Schema.Int)
  }),
  Schema.Struct({
    type: Schema.Literal("number"),
    ...itemCommon,
    default: Schema.Finite,
    integer: Schema.Boolean,
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.optionalKey(Schema.Finite),
    step: Schema.optionalKey(Schema.Finite),
    unit: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({ type: Schema.Literal("boolean"), ...itemCommon, default: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("choice"), ...itemCommon, default: Schema.String, options: Schema.Array(ChoiceOption) }),
  Schema.Struct({
    type: Schema.Literal("multichoice"),
    ...itemCommon,
    default: Schema.Array(Schema.String),
    options: Schema.Array(ChoiceOption)
  }),
  Schema.Struct({
    type: Schema.Literal("textList"),
    ...itemCommon,
    default: Schema.Array(Schema.String),
    maxItems: Schema.optionalKey(Schema.Int),
    itemMaxLength: Schema.optionalKey(Schema.Int)
  })
]).pipe(Schema.toTaggedUnion("type"))
export type RecordItemField = typeof RecordItemField.Type

/** One record: item field key → value. */
export const RecordValue = Schema.Record(FieldKey, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Array(Schema.String)]))
export type RecordValue = typeof RecordValue.Type

/**
 * An ordered list of records with the same fields (routing rules, rooms with
 * aliases). Rendered as a list of compact rows, each expanding into a small form
 * built from `itemFields`; add, remove and (if `orderable`) move up/down.
 * Value: `RecordValue[]`.
 */
export const RecordsField = Schema.Struct({
  type: Schema.Literal("records"),
  ...common,
  default: Schema.Array(RecordValue),
  itemFields: Schema.Array(RecordItemField),
  /** Singular noun for buttons: "Add rule". */
  itemLabel: Schema.String,
  /** Item field whose value titles a collapsed row. */
  titleKey: FieldKey,
  maxItems: Schema.optionalKey(Schema.Int),
  /** Order matters (first match wins); show move controls. */
  orderable: Schema.Boolean
})

/**
 * Free text with suggestions (a combobox): a model name picked from the
 * backend's own model list, with any other name allowed when `allowCustom`.
 * The server fills `options` from the running instance; `optionsNote` says
 * where they came from ("From the server's model list", "Agent not running: type a name").
 * Value: `string`.
 */
export const ComboField = Schema.Struct({
  type: Schema.Literal("combo"),
  ...common,
  default: Schema.String,
  options: Schema.Array(ChoiceOption),
  allowCustom: Schema.Boolean,
  maxLength: Schema.optionalKey(Schema.Int),
  placeholder: Schema.optionalKey(Schema.String),
  optionsNote: Schema.optionalKey(Schema.String)
})

/**
 * A button that runs something on the server ("Test", "Play a sample",
 * "Refresh model list"). It has no value. Pressing it sends `module.action` or
 * `settings.action`; the `result.detail` text is shown under the button until
 * the form is closed. Disabled while the form is dirty if `requiresSaved`.
 */
export const ActionField = Schema.Struct({
  type: Schema.Literal("action"),
  ...common,
  buttonLabel: Schema.String,
  /** Ask "Are you sure?" with this text first. */
  confirm: Schema.optionalKey(Schema.String),
  /** The action uses the saved settings: disable it while there are unsaved edits. */
  requiresSaved: Schema.Boolean
})

/** Read-only text computed by the server ("Logged in with a Max plan", "Last test: 912 ms"). Value: `string`. */
export const InfoField = Schema.Struct({
  type: Schema.Literal("info"),
  ...common,
  tone: Schema.optionalKey(Schema.Literals(["neutral", "ok", "warning", "error"]))
})

/** v2 field set: v1's six plus the five above. Replaces `SettingField` at integration. */
export const SettingFieldV2 = Schema.Union([
  TextField,
  SecretField,
  NumberField,
  BooleanField,
  ChoiceField,
  MultiChoiceField,
  TextListField,
  RecordsField,
  ComboField,
  ActionField,
  InfoField
]).pipe(Schema.toTaggedUnion("type"))
export type SettingFieldV2 = typeof SettingFieldV2.Type
export type SettingFieldTypeV2 = SettingFieldV2["type"]

/** v2 values: v1's plus a list of records. `action` fields have no value; `info` fields have a string. */
export const SettingValueV2 = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Array(Schema.String), Schema.Array(RecordValue)])
export type SettingValueV2 = typeof SettingValueV2.Type

export const SettingsFormV2 = Schema.Struct({
  fields: Schema.Array(SettingFieldV2),
  values: Schema.Record(FieldKey, SettingValueV2),
  secrets: Schema.Record(FieldKey, SecretState),
  errors: Schema.Array(FieldError)
})
export type SettingsFormV2 = typeof SettingsFormV2.Type

export const SettingsPatchV2 = Schema.Struct({
  values: Schema.Record(FieldKey, Schema.NullOr(SettingValueV2)),
  secrets: Schema.Record(FieldKey, Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096))))
})
export type SettingsPatchV2 = typeof SettingsPatchV2.Type
