import { Schema } from "effect"
import {
  AssistantState,
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

/** A one-line status a running module publishes, e.g. "Connected · 143 entities". */
export const StatusLine = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(120)),
  tone: Schema.Literals(["neutral", "ok", "warning", "error"])
})
export type StatusLine = typeof StatusLine.Type

export const ModuleState = Schema.Literals(["disabled", "starting", "running", "stopping", "error"])
export type ModuleState = typeof ModuleState.Type

export const ToolInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** Read-only: may run before the user has finished speaking. */
  speculative: Schema.Boolean
})
export type ToolInfo = typeof ToolInfo.Type

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
  settings: SettingsForm,
  /** Increases on every change to this module; a client keeps the highest it has seen. */
  revision: NonNegativeInt,
  /**
   * Only a page with admin access may switch it on or off or change its settings (it has a secret, or it is an
   * agent). Absent = false.
   */
  protected: Schema.optionalKey(Schema.Boolean),
  /** What the module contributes. Absent = "capability". */
  kind: Schema.optionalKey(ModuleKind),
  /**
   * The settings category that shows the module's page (`#settings/<group>/<id>`): `modules` for capabilities,
   * `agents` (Language model) for agents and decision providers. Absent = by `kind`.
   */
  group: Schema.optionalKey(SettingsGroup)
})
export type ModuleInfo = typeof ModuleInfo.Type

/** Assistant settings that are not a module (voices, listening, language model). */
export const SettingsSection = Schema.Struct({
  id: SectionId,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  form: SettingsForm,
  revision: NonNegativeInt,
  /** Only a page with admin access may change it (it has a secret, or it chooses providers). Absent = false. */
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

export const EngineStatus = Schema.Struct({
  /** `failed`: a provider could not start; see `problems`. The UI and settings still work. */
  state: Schema.Literals(["starting", "ready", "reloading", "failed"]),
  problems: Schema.Array(Schema.Struct({ stage: Schema.String, message: Schema.String })),
  /** Saved settings differ from what the running engines use; a reload would apply them. */
  reloadPending: Schema.Boolean,
  /** The settings pages (`<group>/<page>`) whose saved changes wait for that reload. Absent = not known. */
  reloadPendingFor: Schema.optionalKey(Schema.Array(Schema.String)),
  engines: Schema.Array(EngineInfo),
  voices: Schema.Array(VoiceInfo)
})
export type EngineStatus = typeof EngineStatus.Type

/** Conversation history, as shown to the user (voice markers removed, tool results omitted). */
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

/**
 * One turn's latency trace. Marks are milliseconds relative to end of turn
 * (negative: done early by a promoted speculative turn), as in the CLI's latency line.
 */
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
    playbackStart: Schema.optionalKey(Schema.Finite)
  }),
  totalMs: Schema.optionalKey(Schema.Finite),
  tools: Schema.Array(Schema.Struct({ name: Schema.String, ms: NonNegativeFinite })),
  voices: Schema.Array(Schema.String),
  /** Reported by the browser: add `outputLatencyMs` to `playbackStart` for the audible start. */
  client: Schema.optionalKey(Schema.Struct({
    outputLatencyMs: NonNegativeFinite,
    /** From the reply's first audio chunk arriving in the browser to playback starting (prebuffer). */
    startDelayMs: NonNegativeFinite
  }))
})
export type TraceInfo = typeof TraceInfo.Type

/** Everything a freshly connected tab needs to render. */
export const Snapshot = Schema.Struct({
  state: AssistantState,
  role: Role,
  ownerPresent: Schema.Boolean,
  engine: EngineStatus,
  /** In catalog order. */
  modules: Schema.Array(ModuleInfo),
  sections: Schema.Array(SettingsSection),
  /** The most recent history (at most 200 items), oldest first. */
  history: Schema.Array(HistoryItem),
  /** The most recent traces (at most 20), oldest first. */
  traces: Schema.Array(TraceInfo),
  /** The key vault as this page sees it. Absent: treat as `{ state: "none", admin: true }`. */
  vault: Schema.optionalKey(VaultInfo),
  /** Settings set outside the UI (environment, `.env`). Absent: an older server. */
  env: Schema.optionalKey(EnvInfo),
  /** Downloadable models, per tool. */
  models: Schema.optionalKey(Schema.Array(ModelSet)),
  /** Running jobs and the last finished ones, oldest first. */
  jobs: Schema.optionalKey(Schema.Array(JobInfo))
})
export type Snapshot = typeof Snapshot.Type
