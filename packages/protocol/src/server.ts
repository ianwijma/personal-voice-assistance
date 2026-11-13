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
import { EngineStatus, ModuleInfo, SettingsSection, Snapshot, TraceInfo } from "./snapshot.ts"
import { VaultInfo } from "./vault.ts"

/**
 * Text frames from the assistant to the browser. Binary frames from the
 * assistant are reply audio (see `frames.ts`) and go to the audio owner only;
 * every other message goes to every connected tab unless noted.
 */

/** Answer to `hello`. Sent only to the new connection. */
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
  turnId: Schema.optionalKey(TurnId)
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
  spoken: Schema.Boolean
})

/**
 * Assistant text, voice markers removed. Spoken turns send one message per
 * clause as it is handed to speech synthesis (`clause` = its 0-based index);
 * unspoken turns stream raw text deltas (`clause: null`).
 */
export const AssistantText = Schema.Struct({
  type: Schema.Literal("assistant.text"),
  turnId: TurnId,
  clause: Schema.NullOr(NonNegativeInt),
  text: Schema.String,
  /** The voice speaking this clause (spoken turns only). */
  voice: Schema.optionalKey(Schema.String)
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
  input: Schema.Json
})

export const ToolEnd = Schema.Struct({
  type: Schema.Literal("tool.end"),
  turnId: TurnId,
  callId: Schema.String,
  ok: Schema.Boolean,
  ms: NonNegativeFinite,
  /** The error returned to the model, when `ok` is false. */
  error: Schema.optionalKey(Schema.String)
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
  sampleRate: Schema.Int.check(Schema.isBetween({ minimum: 8000, maximum: 96_000 }))
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

export const ModuleChanged = Schema.Struct({
  type: Schema.Literal("module.changed"),
  module: ModuleInfo
})

export const SectionChanged = Schema.Struct({
  type: Schema.Literal("section.changed"),
  section: SettingsSection
})

export const Engine = Schema.Struct({
  type: Schema.Literal("engine"),
  engine: EngineStatus
})

/** The vault's state or this page's admin access changed. Sent to each tab with its own `admin`. */
export const Vault = Schema.Struct({
  type: Schema.Literal("vault"),
  vault: VaultInfo
})

/** Outcome of a request (`requestId` of the request). Sent only to the requesting tab. */
export const Result = Schema.Struct({
  type: Schema.Literal("result"),
  requestId: RequestId,
  ok: Schema.Boolean,
  /** Present when `ok` is false. */
  error: Schema.optionalKey(ErrorInfo)
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
  Result,
  ErrorMessage,
  Pong
]).pipe(Schema.toTaggedUnion("type"))
export type ServerMessage = typeof ServerMessage.Type
export type ServerMessageType = ServerMessage["type"]
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { readonly type: T }>
