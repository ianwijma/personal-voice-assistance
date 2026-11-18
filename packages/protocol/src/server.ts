import { Schema } from "effect"
import {
  AssistantState,
  ErrorInfo,
  ModuleId,
  NonNegativeFinite,
  NonNegativeInt,
  RequestId,
  Role,
  TurnId,
  TurnSource
} from "./common.ts"
import { AdminSession, AdminState } from "./admin.ts"
import { AssistantId } from "./assistants.ts"
import { AssistantInfo, DeviceListInfo, DeviceSetup, DeviceTypeInfo } from "./devices.ts"
import { DeviceId, WakePhrase } from "./frontends.ts"
import { AdminSnapshot, EngineStatus, EngineSummary, HistoryItem, ModuleInfo, SettingsSection, Snapshot, TraceInfo } from "./snapshot.ts"
import { EnvInfo } from "./env.ts"
import { JobInfo, ModelSet } from "./jobs.ts"
import { VaultInfo } from "./vault.ts"
import { ConversationId, ConversationReason, SessionInfo, SessionKey } from "./sessions.ts"
import { HealthInfo } from "./health.ts"
import { HouseholdEventMessage, HouseholdGapMessage, HouseholdSnapshotMessage } from "./household.ts"
import { NotificationResolvedMessage, NotificationRingMessage } from "./notifications.ts"
import { FieldActionResult } from "./settings.ts"

/**
 * Text frames from the assistant to the browser. Binary frames from the
 * assistant are reply audio (see `frames.ts`) and go to the audio owner only;
 * every other message goes to every connected tab unless noted.
 *
 * Protocol 5: messages marked "Admin connections only" carry admin data (settings, modules, engine details,
 * vault, `.env`, models, jobs, front ends, devices) and go only to connections that are admin (`admin.ts`).
 * Turn events go to every connection; `turn.end.trace` is included for every connection (it is the turn's own
 * latency), while the trace list lives in `admin.snapshot`.
 */

/**
 * Answer to `hello`. Sent only to the new connection, with the voice part of the state. On an admin connection
 * whose `hello.adminToken` was valid, `admin.snapshot` follows immediately.
 */
export const Welcome = Schema.Struct({
  type: Schema.Literal("welcome"),
  protocol: Schema.Int,
  server: Schema.Struct({ name: Schema.String, version: Schema.String }),
  /** Unique per connection, for logs. */
  connectionId: Schema.String,
  snapshot: Snapshot
})

/** This tab's role or the owner's presence changed. Sent to each tab with its own `role`. */
export const Session = Schema.Struct({
  type: Schema.Literal("session"),
  role: Role,
  ownerPresent: Schema.Boolean,
  reason: Schema.Literals(["claimed", "released", "taken_over", "owner_disconnected", "resumed"])
})

/** The assistant state changed. */
export const State = Schema.Struct({
  type: Schema.Literal("state"),
  state: AssistantState,
  /** The committed turn this state belongs to (thinking, speaking). */
  turnId: Schema.optionalKey(TurnId),
  /**
   * Protocol 7: the assistant that has the turn, the one rule the pages show: the assistant of the turn in flight or of
   * the utterance being heard, else the one whose armed or follow-up window is open; `null`: nobody, speech goes to who
   * answers without a phrase. Sent again with an unchanged `state` when only this changed (a phrase inside the
   * utterance, a window that closed by itself while the device keeps listening, an accepted `device.pick`, which closes
   * the windows). Absent: the server does not say.
   */
  holder: Schema.optionalKey(Schema.NullOr(AssistantId))
})

/**
 * What the recogniser hears right now (interim, replaces the previous one).
 * "" clears it (the words became a turn, or were dropped as the assistant's own echo).
 */
export const Transcript = Schema.Struct({
  type: Schema.Literal("transcript"),
  text: Schema.String
})

/** A committed turn began. Speculative turns stay invisible until promoted. */
export const TurnStart = Schema.Struct({
  type: Schema.Literal("turn.start"),
  turnId: TurnId,
  source: TurnSource,
  userText: Schema.String,
  /** The reply will be spoken (voice turns, and typed turns from the audio owner with `speak`). */
  spoken: Schema.Boolean,
  /** Protocol 7: the assistant answering. */
  assistantId: Schema.optionalKey(AssistantId)
})

/**
 * Assistant text. Spoken turns send one message per
 * clause as it is handed to speech synthesis (`clause` = its 0-based index);
 * unspoken turns stream raw text deltas (`clause: null`).
 */
export const AssistantText = Schema.Struct({
  type: Schema.Literal("assistant.text"),
  turnId: TurnId,
  clause: Schema.NullOr(NonNegativeInt),
  text: Schema.String,
  /** The voice speaking this clause (spoken turns only). */
  voice: Schema.optionalKey(Schema.String),
  /** Protocol 7: the assistant answering. */
  assistantId: Schema.optionalKey(AssistantId)
})

/** Clauses up to and including `clause` have started playing in the owner's browser. */
export const AssistantPlaying = Schema.Struct({
  type: Schema.Literal("assistant.playing"),
  turnId: TurnId,
  clause: NonNegativeInt
})

export const ToolStart = Schema.Struct({
  type: Schema.Literal("tool.start"),
  turnId: TurnId,
  callId: Schema.String,
  tool: Schema.String,
  /** The module that contributed the tool (null for an unknown tool name). */
  moduleId: Schema.NullOr(ModuleId),
  /** The model's input, truncated by the server to about 2 KB of JSON. */
  input: Schema.Json,
  /** Protocol 7: the assistant whose turn it is (as on `turn.start`), so a tab that joined mid-turn files it right. */
  assistantId: Schema.optionalKey(AssistantId)
})

export const ToolEnd = Schema.Struct({
  type: Schema.Literal("tool.end"),
  turnId: TurnId,
  callId: Schema.String,
  ok: Schema.Boolean,
  ms: NonNegativeFinite,
  /** The error returned to the model, when `ok` is false. */
  error: Schema.optionalKey(Schema.String),
  /** Protocol 7: the assistant whose turn it is (as on `turn.start`). */
  assistantId: Schema.optionalKey(AssistantId)
})

/** A committed turn ended. `trace` is its latency trace. */
export const TurnEnd = Schema.Struct({
  type: Schema.Literal("turn.end"),
  turnId: TurnId,
  outcome: Schema.Literals(["completed", "interrupted", "failed"]),
  trace: TraceInfo
})

/** Audio owner only: binary reply frames for `turnId` follow, PCM s16le mono at `sampleRate`. */
export const ReplyStart = Schema.Struct({
  type: Schema.Literal("reply.start"),
  turnId: TurnId,
  sampleRate: Schema.Int.check(Schema.isBetween({ minimum: 8000, maximum: 96_000 })),
  /** Protocol 7: the assistant whose voice this is. */
  assistantId: Schema.optionalKey(AssistantId)
})

/** Audio owner only: every frame of the reply has been sent. */
export const ReplyEnd = Schema.Struct({
  type: Schema.Literal("reply.end"),
  turnId: TurnId
})

/** Audio owner only: stop playing the reply now and answer `playback.stopped`. */
export const ReplyStop = Schema.Struct({
  type: Schema.Literal("reply.stop"),
  turnId: TurnId
})

/** Admin connections only. */
export const ModuleChanged = Schema.Struct({
  type: Schema.Literal("module.changed"),
  module: ModuleInfo
})

/** Admin connections only. */
export const SectionChanged = Schema.Struct({
  type: Schema.Literal("section.changed"),
  section: SettingsSection
})

/** Admin connections only: the full engine status changed. Everyone also gets `engine.summary` when it changes. */
export const Engine = Schema.Struct({
  type: Schema.Literal("engine"),
  engine: EngineStatus
})

/** Admin connections only: the vault's state changed. (`vault.admin` mirrors `AdminState.loggedIn` since protocol 5.) */
export const Vault = Schema.Struct({
  type: Schema.Literal("vault"),
  vault: VaultInfo
})

/** Admin connections only: the settings set outside the UI changed (a move, or an engine reload). */
export const Env = Schema.Struct({
  type: Schema.Literal("env"),
  env: EnvInfo
})

/** Admin connections only: a job started, progressed (at most 4 per second), or ended. */
export const Job = Schema.Struct({
  type: Schema.Literal("job"),
  job: JobInfo
})

/** Admin connections only: the downloadable models changed (a download finished, a model was deleted, the engines changed). */
export const Models = Schema.Struct({
  type: Schema.Literal("models"),
  models: Schema.Array(ModelSet)
})

/** Outcome of a request (`requestId` of the request). Sent only to the requesting tab. */
export const Result = Schema.Struct({
  type: Schema.Literal("result"),
  requestId: RequestId,
  ok: Schema.Boolean,
  /** Present when `ok` is false. */
  error: Schema.optionalKey(ErrorInfo),
  /** Protocol 5: present only on the successful result of `admin.login`. */
  admin: Schema.optionalKey(AdminSession),
  /** Protocol 7: present only on the successful result of `assistant.create`: the id the server made. */
  assistantId: Schema.optionalKey(AssistantId),
  /**
   * Protocol 7: present only on the successful result of `device.save`: the revision the saved device or defaults
   * have now, so the page can wait until that revision has reached it (the lists are pushed after the result).
   */
  rev: Schema.optionalKey(NonNegativeInt),
  /** Protocol 10: present only on the result of `module.action` that ran: what the handler said, shown by the button. */
  action: Schema.optionalKey(FieldActionResult),
  /**
   * Additive within protocol 11 (P9): on the result of `notification.action`, the sentence to show for the press (the
   * module's answer, or "I can't do that right now"), in the household's language.
   */
  say: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300)))
})

/**
 * Protocol 5: everyone. The engine's readiness or the enabled voices changed (sent with every change that alters
 * the summary; admin connections also get `engine`).
 */
export const EngineSummaryMessage = Schema.Struct({
  type: Schema.Literal("engine.summary"),
  engine: EngineSummary
})

/**
 * Protocol 5: this connection's admin access changed (login, logout, session end, a wrong password with back-off).
 * Sent to the connection concerned only.
 */
export const AdminStateMessage = Schema.Struct({
  type: Schema.Literal("admin.state"),
  admin: AdminState
})

/**
 * Protocol 5, admin connections only: the admin part of the state. Sent right after `welcome` (valid
 * `hello.adminToken`) or right after a successful `admin.login`. Replaces everything admin the page held.
 */
export const AdminSnapshotMessage = Schema.Struct({
  type: Schema.Literal("admin.snapshot"),
  snapshot: AdminSnapshot
})

/**
 * Protocol 5, admin connections only: the devices changed (seen, renamed, overrides, forgotten, connected,
 * disconnected, audio owner). The whole list, most recently seen first; at most one per second while only
 * `lastSeen` / `connections` change. Protocol 7 adds `own`, `settings`, `hearer` and `rev` to each device
 * (`DeviceListInfo`: a superset of the protocol 5 entry, so the one tag serves both).
 */
export const Devices = Schema.Struct({
  type: Schema.Literal("devices"),
  devices: Schema.Array(DeviceListInfo)
})

/**
 * Protocol 5, everyone: the audio owner said a wake phrase. `phrase` is the configured phrase that matched.
 * `armed: true`: it was the phrase alone; the next utterance within `WAKE_ARMED_MS` needs no phrase (the voice
 * front end shows "Listening…" and plays its cue). `armed: false`: the phrase and the request came in one
 * utterance (a turn follows; the cue is skipped).
 */
export const Wake = Schema.Struct({
  type: Schema.Literal("wake"),
  phrase: WakePhrase,
  armed: Schema.Boolean,
  /** Protocol 7: the assistant the phrase belongs to. */
  assistantId: Schema.optionalKey(AssistantId)
})

/**
 * Protocol 5, admin connections that switched `wake.test` on: one final transcript of the audio owner, as the
 * recogniser heard it (before the phrase was removed). `matched`: the wake phrase it matched (absent = it matched
 * none). `accepted`: the assistant took the utterance (it answers it, or the phrase alone made it listen); `true`
 * without `matched` means it was accepted without a phrase (always listening, or inside an armed or follow-up
 * window), `false` that it was ignored. Absent from an older server: the page then only knows "no phrase matched".
 * `source` (protocol 7, additive): where the server heard it, so the page need not guess from its session list:
 * `deviceId` the device whose audio it was (absent: a voice page without a device), `assistantId` the assistant the
 * matched phrase belongs to there (absent: no phrase matched, or it is nobody's). Absent from an older server.
 * Never stored.
 */
export const WakeHeard = Schema.Struct({
  type: Schema.Literal("wake.heard"),
  text: Schema.String,
  matched: Schema.optionalKey(WakePhrase),
  accepted: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(Schema.Struct({ deviceId: Schema.optionalKey(DeviceId), assistantId: Schema.optionalKey(AssistantId) })),
  /** Epoch milliseconds. */
  at: NonNegativeFinite
})

/**
 * Protocol 6, the device's connections: its conversation is a new one (`new`: `conversation.new`; `idle`: it had
 * been quiet for `conversationIdleMinutes`, sent before the turn that started it; `resumed`: the page's
 * conversation went on, e.g. after an engine reload, with a history the page should take from the snapshot). With
 * `new` and `idle` the history is empty: the page clears its chat and shows a divider. Replaces
 * `snapshot.conversation`.
 */
export const Conversation = Schema.Struct({
  type: Schema.Literal("conversation"),
  id: ConversationId,
  reason: ConversationReason,
  /** Epoch milliseconds when it started. */
  startedAt: NonNegativeFinite,
  /** Protocol 7: whose conversation (one per assistant per device). */
  assistantId: Schema.optionalKey(AssistantId)
})

/**
 * Protocol 6, admin connections only: the voice sessions changed (created, state, owner, a turn, a new
 * conversation, discarded). The whole list, most recently active first; throttled like `devices` (at most one per
 * second while only `state` changes).
 */
export const Sessions = Schema.Struct({
  type: Schema.Literal("sessions"),
  sessions: Schema.Array(SessionInfo)
})

/**
 * Protocol 6, admin connections only: a voice session finished a turn (committed or not; discarded speculative
 * turns are not sent). The trace carries `session` (the device's name); `key` / `deviceId` say which session, so
 * admin › Diagnostics › Latency grows live (admin gets no `turn.*`). Also kept in `admin.snapshot.traces`.
 */
export const TraceMessage = Schema.Struct({
  type: Schema.Literal("trace"),
  /** The session's key (`SessionInfo.key`). */
  key: SessionKey,
  /** The device; absent for a session of a voice connection without a device. */
  deviceId: Schema.optionalKey(DeviceId),
  trace: TraceInfo
})

/** A problem not tied to a request (a failed turn, lost microphone audio, a module that crashed). */
export const ErrorMessage = Schema.Struct({
  type: Schema.Literal("error"),
  error: ErrorInfo
})

export const Pong = Schema.Struct({
  type: Schema.Literal("pong"),
  id: NonNegativeInt
})

// -- Protocol 7 (docs/ASSISTANTS.md §5.3, §5.4)

/** The voice connection's device setup (replaces `device.profile`; also `snapshot.setup`). */
export const DeviceSetupMessage = Schema.Struct({
  type: Schema.Literal("device.setup"),
  ...DeviceSetup.fields
})

/** Answer to `conversation.read`, also the other assistants' history on demand. */
export const ConversationHistory = Schema.Struct({
  type: Schema.Literal("conversation.history"),
  requestId: RequestId,
  assistantId: AssistantId,
  id: ConversationId,
  history: Schema.Array(HistoryItem),
  /**
   * Protocol 7: the turn whose exchange ends `history` (its user message and what followed it), when a turn of this
   * session was committed last. The page may still show that turn as running (its `turn.end` is on the way): that
   * running turn and this exchange are the same, and no other running turn is in `history`. Absent: the server does
   * not say, or no turn of this session ends the history.
   */
  lastTurnId: Schema.optionalKey(TurnId)
})

/** Admin connections only: the whole list of assistants, order kept. */
export const AssistantsMessage = Schema.Struct({
  type: Schema.Literal("assistants"),
  assistants: Schema.Array(AssistantInfo)
})

/** Admin connections only: the device types and their defaults (replaces `frontends`). */
export const DeviceTypesMessage = Schema.Struct({
  type: Schema.Literal("device.types"),
  types: Schema.Array(DeviceTypeInfo)
})

/**
 * Protocol 9, admin connections only: the issue registry changed (a check started or finished, a module became
 * unavailable or available again, a module's start failed). Always the whole registry.
 */
export const HealthMessage = Schema.Struct({
  type: Schema.Literal("health"),
  health: HealthInfo
})

export const ServerMessage = Schema.Union([
  Welcome,
  Session,
  State,
  Transcript,
  TurnStart,
  AssistantText,
  AssistantPlaying,
  ToolStart,
  ToolEnd,
  TurnEnd,
  ReplyStart,
  ReplyEnd,
  ReplyStop,
  ModuleChanged,
  SectionChanged,
  Engine,
  Vault,
  Env,
  Job,
  Models,
  Result,
  ErrorMessage,
  EngineSummaryMessage,
  AdminStateMessage,
  AdminSnapshotMessage,
  Devices,
  Wake,
  WakeHeard,
  Conversation,
  Sessions,
  TraceMessage,
  Pong,
  DeviceSetupMessage,
  ConversationHistory,
  AssistantsMessage,
  DeviceTypesMessage,
  HealthMessage,
  HouseholdSnapshotMessage,
  HouseholdEventMessage,
  HouseholdGapMessage,
  NotificationRingMessage,
  NotificationResolvedMessage
]).pipe(Schema.toTaggedUnion("type"))
export type ServerMessage = typeof ServerMessage.Type
export type ServerMessageType = ServerMessage["type"]
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { readonly type: T }>

/** The server messages that protocol 7 adds (also members of `ServerMessage`); `devices` and `result` are extended in place. */
export const AssistantsServerMessage = Schema.Union([
  DeviceSetupMessage,
  ConversationHistory,
  AssistantsMessage,
  DeviceTypesMessage
]).pipe(Schema.toTaggedUnion("type"))
export type AssistantsServerMessage = typeof AssistantsServerMessage.Type
export type AssistantsServerMessageType = AssistantsServerMessage["type"]
