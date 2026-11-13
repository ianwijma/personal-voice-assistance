import { Schema } from "effect"
import { ChoiceOption, NumberField, BooleanField, ChoiceField, MultiChoiceField, SecretField, SecretState, TextField } from "./settings.ts"
import { FieldError, FieldKey, ModuleId, NonNegativeFinite, RequestId, SectionId, TurnId } from "./common.ts"

/**
 * Protocol additions for agents, trigger routing, typed intents and the larger
 * settings screen (docs/AGENTS-AND-INTENTS.md §5).
 *
 * STATUS: defined and tested, NOT yet part of `ClientMessage` / `ServerMessage`,
 * `SettingField` or `PROTOCOL_VERSION`. Other work is being built against
 * protocol v1 right now, so nothing here changes what v1 peers send or accept.
 * The integration step (build plan piece G) merges these into the unions in one
 * change and sets `PROTOCOL_VERSION = 3` (2 is the key vault, already merged):
 * - the five new settings field types and the wider `SettingValue` (closed sets → bump);
 * - the new messages (`module.action`, `settings.action`, `routing.set`, `routing`, `intent.decision`, `turn.agent`);
 * - the optional fields below, spread into the existing structs (`...TurnStartAgentFields` into `TurnStart`, ...);
 * - `ErrorCodeV2` replaces `ErrorCode`.
 */

// ---------------------------------------------------------------------------
// Shared literals

/** Agents are modules (kind "agent"), so an agent id is a module id. */
export const AgentId = ModuleId
export type AgentId = typeof AgentId.Type

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

/** How the UI names an agent without looking it up. */
export const AgentRef = Schema.Struct({
  id: AgentId,
  name: Schema.String,
  kind: AgentKind
})
export type AgentRef = typeof AgentRef.Type

/** Which agent answers the next utterance that carries no trigger. */
export const RoutingInfo = Schema.Struct({
  /** The configured default agent (`DEFAULT_AGENT`); null when none is configured or it does not exist. */
  defaultAgent: Schema.NullOr(AgentId),
  /** The agent the next untriggered utterance goes to (the default unless `reason` is `sticky` or `armed`). */
  activeAgent: Schema.NullOr(AgentId),
  reason: Schema.Literals(["default", "sticky", "armed"]),
  /** Milliseconds until `sticky` / `armed` lapses (from when the message was sent). */
  expiresInMs: Schema.optionalKey(NonNegativeFinite)
})
export type RoutingInfo = typeof RoutingInfo.Type

// ---------------------------------------------------------------------------
// Actions (typed intents) as shown in the UI

export const ActionParamKind = Schema.Literals(["choice", "dynamic", "number", "duration", "boolean", "text"])
export type ActionParamKind = typeof ActionParamKind.Type

export const ActionParamInfo = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  kind: ActionParamKind,
  optional: Schema.Boolean,
  /** Choice parameters: the values the decision model can pick from right now (dynamic lists are capped at 255). */
  options: Schema.optionalKey(Schema.Array(Schema.String))
})
export type ActionParamInfo = typeof ActionParamInfo.Type

export const ActionInfo = Schema.Struct({
  /** Global id: `<moduleId>.<actionId>`, e.g. "demo-home.lights_on". */
  id: Schema.String,
  label: Schema.String,
  description: Schema.String,
  params: Schema.Array(ActionParamInfo),
  /** Read-only: may run before the user has finished speaking. */
  speculative: Schema.Boolean,
  /** Asks for a spoken yes before it runs. */
  confirm: Schema.Boolean,
  /** Name of the tool conversational agents can call for it; absent when not offered as a tool. */
  tool: Schema.optionalKey(Schema.String)
})
export type ActionInfo = typeof ActionInfo.Type

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

/** Which options tab a settings section belongs to. Absent = "general". */
export const SettingsGroup = Schema.Literals(["agents", "speech", "voices", "general"])
export type SettingsGroup = typeof SettingsGroup.Type

// ---------------------------------------------------------------------------
// New messages

/** Press an `action` field of a module's (or agent's) form. Answered with `result` (with `detail`). */
export const ModuleAction = Schema.Struct({
  type: Schema.Literal("module.action"),
  requestId: RequestId,
  moduleId: ModuleId,
  key: FieldKey
})

/** Press an `action` field of a settings section ("Play a sample"). */
export const SettingsAction = Schema.Struct({
  type: Schema.Literal("settings.action"),
  requestId: RequestId,
  sectionId: SectionId,
  key: FieldKey
})

/** Make an agent answer the following untriggered utterances (sticky), or go back to the default with `null`. */
export const RoutingSet = Schema.Struct({
  type: Schema.Literal("routing.set"),
  requestId: RequestId,
  agentId: Schema.NullOr(AgentId)
})

/** Routing changed (a sticky or armed agent, its expiry, the default agent). Broadcast. */
export const RoutingMessage = Schema.Struct({
  type: Schema.Literal("routing"),
  routing: RoutingInfo
})

/** What the intent agent decided for a committed turn (before the action runs). Broadcast. */
export const IntentDecision = Schema.Struct({
  type: Schema.Literal("intent.decision"),
  turnId: TurnId,
  agentId: AgentId,
  /** Module id of the decision provider that answered ("jev-typesafe", "keywords"). */
  decider: Schema.String,
  outcome: Schema.Literals(["act", "ask", "confirm", "cancelled", "fallback", "error"]),
  action: Schema.optionalKey(Schema.Struct({ id: Schema.String, label: Schema.String, moduleId: ModuleId })),
  /** Parameter values as display text, with the decision model's probability where it chose them. */
  params: Schema.Array(Schema.Struct({
    name: Schema.String,
    label: Schema.String,
    value: Schema.String,
    probability: Schema.optionalKey(Schema.Finite)
  })),
  /** The least certain judgement the outcome rests on (0–1). */
  probability: Schema.optionalKey(Schema.Finite),
  /** Decision round trip. */
  ms: NonNegativeFinite,
  /** For `fallback` / `error`: why ("no_match", "uncertain", "compound", "timeout", ...). */
  reason: Schema.optionalKey(Schema.String)
})

/**
 * The agent answering a committed turn changed after `turn.start`: the routed
 * agent handed the turn on (an intent agent found no matching action) or failed
 * before saying anything, and `agent` answers instead. Broadcast.
 */
export const TurnAgent = Schema.Struct({
  type: Schema.Literal("turn.agent"),
  turnId: TurnId,
  agent: AgentRef,
  from: AgentRef,
  reason: Schema.Literals(["handoff", "failed", "unavailable"])
})

/** The new client messages (merged into `ClientMessage` at integration). */
export const ClientMessageAdditions = Schema.Union([ModuleAction, SettingsAction, RoutingSet]).pipe(Schema.toTaggedUnion("type"))
export type ClientMessageAdditions = typeof ClientMessageAdditions.Type

/** The new server messages (merged into `ServerMessage` at integration). */
export const ServerMessageAdditions = Schema.Union([RoutingMessage, IntentDecision, TurnAgent]).pipe(Schema.toTaggedUnion("type"))
export type ServerMessageAdditions = typeof ServerMessageAdditions.Type

// ---------------------------------------------------------------------------
// Optional fields for existing structs (spread in at integration; none is required)

/** `text.send`: send the typed message to this agent, skipping trigger routing. */
export const TextSendAgentFields = { agentId: Schema.optionalKey(AgentId) }

/** `turn.start`: who answers and why. `userText` stays the full utterance; `agentText` is what the agent received. */
export const TurnStartAgentFields = {
  agent: Schema.optionalKey(AgentRef),
  routedBy: Schema.optionalKey(RouteReason),
  /** The agent the route pointed at when it was unavailable or handed the turn on (the answer comes from `agent`). */
  fallbackFrom: Schema.optionalKey(AgentRef),
  agentText: Schema.optionalKey(Schema.String)
}

/** `tool.start`: an intent action is shown like a tool call, labelled. */
export const ToolStartActionFields = {
  kind: Schema.optionalKey(Schema.Literals(["tool", "action"])),
  label: Schema.optionalKey(Schema.String)
}

/** `ModuleInfo`: agents and decision providers are modules too. */
export const ModuleInfoAgentFields = {
  kind: Schema.optionalKey(ModuleKind),
  agentKind: Schema.optionalKey(AgentKind),
  actions: Schema.optionalKey(Schema.Array(ActionInfo))
}

/** `SettingsSection`: the options tab it belongs to. */
export const SettingsSectionGroupFields = { group: Schema.optionalKey(SettingsGroup) }

/** `Snapshot`: routing state on connect. */
export const SnapshotRoutingFields = { routing: Schema.optionalKey(RoutingInfo) }

/** `HistoryItem` (assistant): who answered. */
export const HistoryAgentFields = { agentId: Schema.optionalKey(AgentId) }

/** `Result`: a short outcome to show (action buttons). */
export const ResultDetailFields = {
  detail: Schema.optionalKey(Schema.Struct({
    text: Schema.String.check(Schema.isMaxLength(500)),
    tone: Schema.Literals(["neutral", "ok", "warning", "error"])
  }))
}

/** `TraceInfo.marks`: intent turns. */
export const TraceMarkAdditions = {
  decisionSent: Schema.optionalKey(Schema.Finite),
  decisionReceived: Schema.optionalKey(Schema.Finite),
  actionStarted: Schema.optionalKey(Schema.Finite),
  actionFinished: Schema.optionalKey(Schema.Finite)
}

/** `TraceInfo`: which agent the times belong to. */
export const TraceAgentFields = {
  agent: Schema.optionalKey(Schema.Struct({
    id: AgentId,
    kind: AgentKind,
    routedBy: RouteReason,
    fallbackFrom: Schema.optionalKey(AgentId)
  }))
}

/** Error codes after the agents merge: the current ones (vault included) plus three. */
export const ErrorCodeV2 = Schema.Literals([
  "bad_message",
  "not_owner",
  "unknown_module",
  "unknown_section",
  "invalid_settings",
  "module_start_failed",
  "busy",
  "engine_failed",
  "mic_gap",
  "playback_timeout",
  "turn_failed",
  "locked",
  "bad_password",
  "internal",
  /** `module.action` / `settings.action` named a key that is not an action field of that form. */
  "unknown_action",
  /** The action ran and failed (the message says why, for the user). */
  "action_failed",
  /** `routing.set` / `text.send.agentId` named an agent that is not running. */
  "agent_unavailable"
])
export type ErrorCodeV2 = typeof ErrorCodeV2.Type
