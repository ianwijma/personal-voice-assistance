import { Schema } from "effect"
import { AssistantId } from "./assistants.ts"
import { DeviceUser } from "./deviceUsers.ts"
import { AssistantInfo, DeviceListInfo, DeviceSetup, DeviceTypeInfo } from "./devices.ts"
import { ConversationId, SessionInfo } from "./sessions.ts"
import {
  AssistantState,
  FieldKey,
  ModuleId,
  NonNegativeFinite,
  NonNegativeInt,
  Role,
  SectionId,
  TurnId,
  TurnOutcome,
  TurnSource
} from "./common.ts"
import { ModuleKind } from "./agents.ts"
import { Condition, SettingsForm, SettingsGroup, SettingsPage } from "./settings.ts"
import { EnvInfo } from "./env.ts"
import { JobInfo, ModelSet } from "./jobs.ts"
import { VaultInfo } from "./vault.ts"
import { AdminState } from "./admin.ts"
import { AssistantTemplate, HealthInfo, MAX_MODULE_TEMPLATES, MAX_TOOL_RISKS, ModuleUnavailable } from "./health.ts"
import { MAX_ROUTES_PER_MODULE, ModuleRouteInfo } from "./moduleRoutes.ts"

/** A one-line status a running module publishes, e.g. "Connected · 143 entities". */
export const StatusLine = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(120)),
  tone: Schema.Literals(["neutral", "ok", "warning", "error"])
})
export type StatusLine = typeof StatusLine.Type

/**
 * Protocol 9 adds `unavailable`: the module cannot run on this server (a program or platform it needs is missing, or
 * it was written for an unsupported module API; `ModuleInfo.unavailable` says why). It is never started. A page that
 * does not know a state shows it as `error`.
 */
export const ModuleState = Schema.Literals(["disabled", "starting", "running", "stopping", "error", "unavailable"])
export type ModuleState = typeof ModuleState.Type

/**
 * Protocol 9: what a tool or action may do (module-definition §B.5). `read`: lookups; `change`: lights, music, timers;
 * `message`: send mail or chat as the owner; `money`: purchases, bookings; `security`: locks, alarms, cameras.
 * Inferred when a module does not say: a speculative tool is `read`, any other `change`. Carried only; a later
 * protocol enforces it with a policy.
 */
export const ToolRisk = Schema.Literals(["read", "change", "message", "money", "security"])
export type ToolRisk = typeof ToolRisk.Type
/**
 * Protocol 9: whose a result is (docs/MODULES-PLAN.md §2 row 8): `household` (default), `personal` (one person's; the
 * module names the owner, or it is unknown), or `per-result` (the module decides for each result).
 */
export const ToolSensitivity = Schema.Literals(["household", "personal", "per-result"])
export type ToolSensitivity = typeof ToolSensitivity.Type
/** Protocol 9: how long a call usually takes: `instant` (< 50 ms), `quick` (< 1 s), `slow` (seconds), `background`. Default `quick`. */
export const ToolLatency = Schema.Literals(["instant", "quick", "slow", "background"])
export type ToolLatency = typeof ToolLatency.Type

export const ToolInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** Read-only: may run before the user has finished speaking. */
  speculative: Schema.Boolean,
  /** Protocol 9: the declared or inferred class; absent when it depends on the input (or from an older server). */
  risk: Schema.optionalKey(ToolRisk),
  /**
   * Protocol 9: every class a call can have: `[risk]` for a fixed class, the declared list when the class depends on
   * the input (a cover tool: `change` and `security`). A later policy leaves a tool out of a list by these.
   */
  risks: Schema.optionalKey(Schema.Array(ToolRisk).check(Schema.isMaxLength(MAX_TOOL_RISKS))),
  sensitivity: Schema.optionalKey(ToolSensitivity),
  latency: Schema.optionalKey(ToolLatency)
})
export type ToolInfo = typeof ToolInfo.Type

/**
 * One running (or failing) instance of a module that assistants switch on (docs/ASSISTANTS.md §2.6, §3): assistants
 * whose effective settings are equal share one instance; an assistant with its own values may run another.
 */
export const ModuleInstanceInfo = Schema.Struct({
  /** The switched-on assistants that use this instance. */
  assistants: Schema.Array(Schema.String),
  /** The fields this instance's assistants have their own values for (empty: the shared settings). */
  own: Schema.Array(FieldKey),
  state: ModuleState,
  error: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(StatusLine)
})
export type ModuleInstanceInfo = typeof ModuleInstanceInfo.Type

export const ModuleInfo = Schema.Struct({
  id: ModuleId,
  name: Schema.String,
  description: Schema.String,
  /** The owner's intent (persisted). A module can be enabled and still be `starting` or in `error`. */
  enabled: Schema.Boolean,
  state: ModuleState,
  /** Why the module is in `error` (start failure, invalid saved settings). */
  error: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(StatusLine),
  /** Tools of the running instance (empty while it is not running). */
  tools: Schema.Array(ToolInfo),
  /**
   * Protocol 10: tools of the running instance not listed in `tools` (the admin view lists at most 100, and a
   * module's tools count toward what its form may take); the page says "and N more". Absent = none left out.
   */
  toolsLeft: Schema.optionalKey(NonNegativeInt),
  settings: SettingsForm,
  /** Increases on every change to this module; a client keeps the highest it has seen. */
  revision: NonNegativeInt,
  /**
   * It has a secret, or it is an agent. Before protocol 5 only admin pages could change such a module; since
   * protocol 5 every module change is admin only, so this is informational (and module info reaches admin
   * connections only). Absent = false.
   */
  protected: Schema.optionalKey(Schema.Boolean),
  /** What the module contributes. Absent = "capability". */
  kind: Schema.optionalKey(ModuleKind),
  /**
   * The settings category that shows the module's page (`#settings/<group>/<id>`): `modules` for capabilities,
   * `agents` (Language model) for agents and decision providers. Absent = by `kind`.
   */
  group: Schema.optionalKey(SettingsGroup),
  /**
   * Present for a module the assistants switch on and off (a capability, in serve mode): `enabled` is then "at least
   * one switched-on assistant has it on", `state` sums up the instances (`error` when one fails), and each instance
   * is listed with its assistants. Absent: one instance at most, following `enabled`.
   */
  instances: Schema.optionalKey(Schema.Array(ModuleInstanceInfo)),
  /** Protocol 9: why it is `unavailable` (present exactly then). */
  unavailable: Schema.optionalKey(ModuleUnavailable),
  /** Protocol 9: the module's own version (its manifest's `version`), shown in the UI. */
  version: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  /** Protocol 9: the module API it was written for (absent = 1). */
  apiVersion: Schema.optionalKey(Schema.Int),
  /** Protocol 9: the assistants it suggests (the new-assistant flow offers them). Absent = none. */
  templates: Schema.optionalKey(Schema.Array(AssistantTemplate).check(Schema.isMaxLength(MAX_MODULE_TEMPLATES))),
  /**
   * Protocol 10: the HTTP routes its shared part declares (docs/UI-AND-MODULES.md §1.11), while it runs. Absent =
   * none. The recent calls and the tokens are read through the admin API (`GET /api/module-routes`).
   */
  routes: Schema.optionalKey(Schema.Array(ModuleRouteInfo).check(Schema.isMaxLength(MAX_ROUTES_PER_MODULE))),
  /**
   * Protocol 10: `"follow"` on a module of `admin.snapshot` whose complete entry did not fit the snapshot's share of
   * its frame: this entry carries only its identity, switch, state and short error (an empty form, no tools), and the
   * complete entry follows at once, in its own `module.changed` of the same send. A page shows the module as loading
   * until then, never makes a form of it, and keeps a complete entry it already has. Absent = complete.
   */
  details: Schema.optionalKey(Schema.Literal("follow"))
})
export type ModuleInfo = typeof ModuleInfo.Type

/** Assistant settings that are not a module (voices, listening, language model). */
export const SettingsSection = Schema.Struct({
  id: SectionId,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  form: SettingsForm,
  revision: NonNegativeInt,
  /**
   * It has a secret, or it chooses providers. Informational since protocol 5 (every settings change is admin only,
   * and sections reach admin connections only). Absent = false.
   */
  protected: Schema.optionalKey(Schema.Boolean),
  /** The settings category (docs/SETTINGS-UI.md §2.2). Absent = "general". */
  group: Schema.optionalKey(SettingsGroup),
  /** The page it is shown on; sections sharing a page are stacked on it. Absent = a page of its own (`id`, `title`). */
  page: Schema.optionalKey(SettingsPage),
  /** Position among the pages of its group (lower first), then server order. */
  order: Schema.optionalKey(Schema.Finite),
  /**
   * The page is in use only while this holds (the Deepgram page: `STT_PROVIDER = deepgram`). A page not in use is
   * still reachable ("Set up Deepgram", under "Not in use"), so a key can be entered before switching.
   */
  visibleWhen: Schema.optionalKey(Condition)
})
export type SettingsSection = typeof SettingsSection.Type

export const Location = Schema.Literals(["local", "hosted"])
export type Location = typeof Location.Type

export const VoiceInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  enabled: Schema.Boolean,
  isDefault: Schema.Boolean,
  /** Human-readable engine, e.g. "Piper en_US-lessac-medium". */
  engine: Schema.String,
  location: Location
})
export type VoiceInfo = typeof VoiceInfo.Type

export const EngineInfo = Schema.Struct({
  stage: Schema.Literals(["llm", "stt", "tts"]),
  /** Provider key as configured, e.g. "anthropic", "sherpa". */
  provider: Schema.String,
  /** Model or preset, e.g. "claude-haiku-5-5", "nemotron-3.5". */
  detail: Schema.String,
  location: Location
})
export type EngineInfo = typeof EngineInfo.Type

/** Where the engines are: `failed` = a provider could not start (see `EngineStatus.problems`). */
export const EngineState = Schema.Literals(["starting", "ready", "reloading", "failed"])
export type EngineState = typeof EngineState.Type

/** Protocol 7: one shared resource of the pool (docs/ASSISTANTS.md §3.2) and who uses it. */
export const ResourceInfo = Schema.Struct({
  kind: Schema.Literals(["llm", "stt", "tts"]),
  key: Schema.String,
  label: Schema.String,
  location: Schema.Literals(["local", "hosted"]),
  /** Assistants only: a pool user `assistant@place` (a device voice) counts as the assistant. */
  usedBy: Schema.Array(AssistantId),
  /** Additive: the devices (and device types' defaults) that use this resource as their own; today a voice. */
  usedByDevices: Schema.optionalKey(Schema.Array(DeviceUser)),
  state: Schema.Literals(["unused", "starting", "ready", "failed"]),
  problem: Schema.optionalKey(Schema.String),
  ramMb: Schema.optionalKey(NonNegativeFinite)
})
export type ResourceInfo = typeof ResourceInfo.Type

export const EngineStatus = Schema.Struct({
  /** `failed`: a provider could not start; see `problems`. The UI and settings still work. */
  state: EngineState,
  problems: Schema.Array(Schema.Struct({ stage: Schema.String, message: Schema.String })),
  /** Saved settings differ from what the running engines use; a reload would apply them. */
  reloadPending: Schema.Boolean,
  /** The settings pages (`<group>/<page>`) whose saved changes wait for that reload. Absent = not known. */
  reloadPendingFor: Schema.optionalKey(Schema.Array(Schema.String)),
  engines: Schema.Array(EngineInfo),
  voices: Schema.Array(VoiceInfo),
  /** Protocol 7: the resource pool, replacing `engines` once the server builds it. */
  resources: Schema.optionalKey(Schema.Array(ResourceInfo))
})
export type EngineStatus = typeof EngineStatus.Type

/** Conversation history, as shown to the user (tool results omitted). */
export const HistoryItem = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    /** What the user heard (for an interrupted reply: only the part that played). */
    text: Schema.String,
    interrupted: Schema.Boolean,
    tools: Schema.Array(Schema.Struct({ name: Schema.String, ok: Schema.Boolean }))
  })
]).pipe(Schema.toTaggedUnion("role"))
export type HistoryItem = typeof HistoryItem.Type

/** Protocol 7: how the assistant was chosen. */
export const TraceRoute = Schema.Union([
  Schema.Struct({ by: Schema.Literals(["phrase", "armed"]), phrase: Schema.String }),
  Schema.Struct({ by: Schema.Literals(["follow-up", "default", "typed"]) }),
  Schema.Struct({
    by: Schema.Literal("typesafe"),
    outcome: Schema.Literals(["chosen", "none-fits", "timeout", "error"]),
    /** The chosen (or best) option's probability, 0..1; absent with one candidate (the Noul alone decides). */
    probability: Schema.optionalKey(Schema.Finite),
    /** The companion Noul "does any fit", 0..1. */
    fits: Schema.optionalKey(Schema.Finite),
    ms: NonNegativeFinite,
    fallback: Schema.Boolean
  })
])
export type TraceRoute = typeof TraceRoute.Type

/** Protocol 7: the latency-relevant configuration of one turn. */
export const TraceConfig = Schema.Struct({
  llm: Schema.Struct({
    account: Schema.String,
    model: Schema.String,
    effort: Schema.String,
    thinking: Schema.String,
    maxTokens: NonNegativeInt
  }),
  hearing: Schema.Struct({
    hearer: AssistantId,
    engine: Schema.String,
    model: Schema.optionalKey(Schema.String),
    language: Schema.optionalKey(Schema.String),
    eagerSilenceMs: Schema.optionalKey(NonNegativeFinite),
    finalSilenceMs: Schema.optionalKey(NonNegativeFinite),
    eotThreshold: Schema.optionalKey(Schema.Finite)
  }),
  /** `VoiceKey` of the voice. */
  voice: Schema.String,
  /** Whose voice it is (docs/LOOKS-AND-VOICES.md): the device's own for every assistant, or the assistant's. Absent in older traces. */
  voiceFrom: Schema.optionalKey(Schema.Literals(["assistant", "device"])),
  modules: NonNegativeInt,
  tools: NonNegativeInt,
  replyEarly: Schema.Boolean,
  toolRounds: NonNegativeInt
})
export type TraceConfig = typeof TraceConfig.Type

/**
 * One turn's latency trace. Marks are milliseconds relative to end of turn
 * (negative: done early by a promoted speculative turn), as in the CLI's latency line.
 */
/** What took an utterance and what it came to (`TraceInfo.phrase`). */
export const PhraseTraceInfo = Schema.Struct({
  by: Schema.Literals(["ringing", "control", "command"]),
  /** The control, the action (`<module>.<action>`), or the ringing match ("stop", or the action id). */
  name: Schema.String.check(Schema.isMaxLength(120)),
  /** The outcome (`PhraseDid`: "ran", "stopped-ring", "refused", "failed", …). */
  did: Schema.String.check(Schema.isMaxLength(40)),
  why: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  /** The class the execution gateway judged a command's call as, and its refusal. */
  risk: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20))),
  refused: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  /**
   * P8 (additive): the household risk policy's decision for the command's action, when one was taken: its outcome and
   * the class it was decided by (as for the model's call of the same action).
   */
  decision: Schema.optionalKey(Schema.Struct({
    outcome: Schema.Literals(["allow", "confirm", "deny"]),
    by: Schema.String.check(Schema.isMaxLength(20))
  })),
  /** The person the command ran for (a Members id). */
  person: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** How long the module's action ran. */
  actionMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  /** P10: the action also showed a presentation (its outcome carried one, handed to the Presenter). */
  presented: Schema.optionalKey(Schema.Boolean)
})
export type PhraseTraceInfo = typeof PhraseTraceInfo.Type

export const TraceInfo = Schema.Struct({
  turnId: TurnId,
  mode: TurnSource,
  speculative: Schema.Boolean,
  outcome: TurnOutcome,
  marks: Schema.Struct({
    llmRequestSent: Schema.optionalKey(Schema.Finite),
    llmFirstToken: Schema.optionalKey(Schema.Finite),
    firstClause: Schema.optionalKey(Schema.Finite),
    ttsFirstAudio: Schema.optionalKey(Schema.Finite),
    /** The browser reported that the reply started playing (includes the one-way network delay). */
    playbackStart: Schema.optionalKey(Schema.Finite),
    /** Protocol 7: the routing request left / its answer arrived. */
    routeSent: Schema.optionalKey(Schema.Finite),
    routeReceived: Schema.optionalKey(Schema.Finite)
  }),
  totalMs: Schema.optionalKey(Schema.Finite),
  tools: Schema.Array(Schema.Struct({ name: Schema.String, ms: NonNegativeFinite })),
  voices: Schema.Array(Schema.String),
  /** Reported by the browser: add `outputLatencyMs` to `playbackStart` for the audible start. */
  client: Schema.optionalKey(Schema.Struct({
    outputLatencyMs: NonNegativeFinite,
    /** From the reply's first audio chunk arriving in the browser to playback starting (prebuffer). */
    startDelayMs: NonNegativeFinite
  })),
  /** Protocol 6: the voice session the turn belongs to (its device's name), so admin can tell sessions apart. */
  session: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** Protocol 7: who answered. */
  assistant: Schema.optionalKey(Schema.Struct({ id: AssistantId, name: Schema.String })),
  deviceId: Schema.optionalKey(Schema.String),
  device: Schema.optionalKey(Schema.String),
  /** Protocol 7: who chose the assistant. */
  route: Schema.optionalKey(TraceRoute),
  /** Protocol 7: a snapshot of the latency-relevant configuration at that turn. */
  config: Schema.optionalKey(TraceConfig),
  /**
   * P7, additive within 11 (docs/PHRASES.md "Traces"): present on the execution trace of a taken utterance (a phrase
   * command, a host control, the ringing window), which is no conversation turn; an older page ignores the key.
   */
  phrase: Schema.optionalKey(PhraseTraceInfo)
})
export type TraceInfo = typeof TraceInfo.Type

/** A voice the voice front end can offer ("Assistant default" is `""` in the profile, not listed here). */
export const VoiceChoice = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** The assistant's default voice (`DEFAULT_VOICE`), used when the profile's `voice` is `""`. */
  isDefault: Schema.Boolean
})
export type VoiceChoice = typeof VoiceChoice.Type

/**
 * The engine as a voice connection sees it (protocol 5): whether a conversation can run, and the enabled voices.
 * Admin connections get the full `EngineStatus` as well (`admin.snapshot.engine`, `engine`).
 */
export const EngineSummary = Schema.Struct({
  /** `EngineStatus.state === "ready"`: speech and language engines are running. */
  ready: Schema.Boolean,
  /** `EngineStatus.state`, without the problems: lets a voice page say "starting" rather than "failed". */
  state: EngineState,
  /** The enabled voices of the running engines (empty while not ready). */
  voices: Schema.Array(VoiceChoice)
})
export type EngineSummary = typeof EngineSummary.Type

/** The summary of a full status (what the server sends to voice connections). */
export const engineSummary = (status: EngineStatus): EngineSummary => ({
  ready: status.state === "ready",
  state: status.state,
  voices: status.state === "ready"
    ? status.voices.filter((v) => v.enabled).map((v) => ({ name: v.name, description: v.description, isDefault: v.isDefault }))
    : []
})

/**
 * Everything a freshly connected tab needs to run a conversation (protocol 5: the voice part, sent to every
 * connection in `welcome`). It holds no settings, modules, env, models, jobs, vault or traces: those are in
 * `AdminSnapshot`, sent as `admin.snapshot` to admin connections only.
 */
export const Snapshot = Schema.Struct({
  state: AssistantState,
  role: Role,
  ownerPresent: Schema.Boolean,
  engine: EngineSummary,
  /**
   * Protocol 7: the assistant `history` belongs to (the answering one: the follow-up holder, else who answers without
   * a phrase, …). Absent: no session yet, or the server does not say.
   */
  answering: Schema.optionalKey(AssistantId),
  /**
   * Protocol 7: who has the turn on the device now, as `state.holder` says it (the turn in flight or the utterance
   * being heard, else an open armed or follow-up window; `null`: nobody). Not whose `history` this is (`answering`):
   * an armed assistant has the turn without the history being its. Absent: no session yet, or the server does not say.
   */
  holder: Schema.optionalKey(Schema.NullOr(AssistantId)),
  /** The most recent history (at most 200 items), oldest first. */
  history: Schema.Array(HistoryItem),
  /** Admin access as this connection sees it (also on voice connections: the voice front end links to admin). */
  admin: AdminState,
  /**
   * Protocol 7: one conversation per assistant on the device, in the device's list order (empty on an admin
   * connection and before the device's session exists). `history` belongs to the answering assistant's.
   */
  conversations: Schema.Array(Schema.Struct({
    assistantId: AssistantId,
    id: ConversationId,
    startedAt: NonNegativeFinite,
    turns: NonNegativeInt
  })),
  /** Protocol 7: the device's setup. Voice connections only. */
  setup: Schema.optionalKey(DeviceSetup)
})
export type Snapshot = typeof Snapshot.Type

/**
 * The admin part of the state (protocol 5), sent as `admin.snapshot` right after `welcome` when the `hello` token
 * was valid, or right after a successful `admin.login`. Later changes arrive as their own messages (`engine`,
 * `module.changed`, `section.changed`, `turn.end` traces, `vault`, `env`, `models`, `job`, `frontends`,
 * `devices`), also to admin connections only.
 */
export const AdminSnapshot = Schema.Struct({
  engine: EngineStatus,
  /** In catalog order. */
  modules: Schema.Array(ModuleInfo),
  sections: Schema.Array(SettingsSection),
  /** The most recent traces (at most 20), oldest first. */
  traces: Schema.Array(TraceInfo),
  vault: VaultInfo,
  /** Settings set outside the UI (environment, `.env`). Absent: the server runs without the env view (tests). */
  env: Schema.optionalKey(EnvInfo),
  /** Downloadable models, per tool (empty when the server offers none). */
  models: Schema.Array(ModelSet),
  /** Running jobs and the last finished ones, oldest first. */
  jobs: Schema.Array(JobInfo),
  /** Every remembered device, most recently seen first. */
  devices: Schema.Array(DeviceListInfo),
  /** Protocol 6: the voice sessions, most recently active first (`sessions`). */
  sessions: Schema.Array(SessionInfo),
  /** Protocol 7: the assistants (replaces nothing yet). */
  assistants: Schema.optionalKey(Schema.Array(AssistantInfo)),
  /** Protocol 7: the device types with their defaults (replaces `frontends`). */
  deviceTypes: Schema.optionalKey(Schema.Array(DeviceTypeInfo)),
  /** Protocol 9: the issue registry (Diagnostics › Health). Absent: the server keeps none (tests). */
  health: Schema.optionalKey(HealthInfo)
})
export type AdminSnapshot = typeof AdminSnapshot.Type
