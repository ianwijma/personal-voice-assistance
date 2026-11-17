import { Schema } from "effect"
import { AssistantState, NonNegativeFinite, NonNegativeInt } from "./common.ts"
import { AssistantId } from "./assistants.ts"
import { CONVERSATION_IDLE_MINUTES_LIMITS, DeviceId, DeviceName } from "./frontends.ts"

/**
 * Voice sessions and conversations (docs/VOICE-SESSIONS.md, protocol 6).
 *
 * Every voice device gets its own **voice session** (its own audio pipeline, state and conversation), created at its
 * first `audio.claim` or `text.send`. Several devices talk at once; at most `MAX_VOICE_SESSIONS` sessions exist
 * (one more is refused with error code `sessions_full`). A session's conversation can be restarted
 * (`conversation.new`) and restarts by itself after `conversationIdleMinutes` (device profile) without a turn.
 */

/** A conversation's id (`AgentTurnInput.conversationId` in core): opaque, a UUID in practice. */
export const ConversationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
export type ConversationId = typeof ConversationId.Type

/** Why a conversation is the one shown now: `new` (asked for), `idle` (the idle reset), `resumed` (it carried on). */
export const ConversationReason = Schema.Literals(["new", "idle", "resumed"])
export type ConversationReason = typeof ConversationReason.Type

/** The device's current conversation (`snapshot.conversation`). */
export const ConversationInfo = Schema.Struct({
  id: ConversationId,
  /** Epoch milliseconds when it started. */
  startedAt: NonNegativeFinite
})
export type ConversationInfo = typeof ConversationInfo.Type

/** Default of the assistant setting `MAX_VOICE_SESSIONS`: voice sessions (devices talking) at once. */
export const DEFAULT_MAX_VOICE_SESSIONS = 4
/** Default of `SESSION_DISCARD_MINUTES`: a session without a connection for this long is dropped, conversation and all. */
export const DEFAULT_SESSION_DISCARD_MINUTES = 30
/**
 * Default of `CONVERSATION_IDLE_MINUTES` (and the built-in default of the profile field `conversationIdleMinutes`,
 * bounds `CONVERSATION_IDLE_MINUTES_LIMITS`); 0 = never.
 */
export const DEFAULT_CONVERSATION_IDLE_MINUTES: number = CONVERSATION_IDLE_MINUTES_LIMITS.default

/**
 * A session's key: the device id for a voice `hello` with `device`, else the connection's `clientId` (a session of
 * its own). Opaque to the page.
 */
export const SessionKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
export type SessionKey = typeof SessionKey.Type

/** One voice session, for admin (`sessions`, `admin.snapshot.sessions`). */
export const SessionInfo = Schema.Struct({
  /** The session's key (`SessionKey`). */
  key: SessionKey,
  /** The device; absent for a session of a voice connection that sent no `device`. */
  deviceId: Schema.optionalKey(DeviceId),
  /** The device's name (or a description of the connection without a device). */
  name: DeviceName,
  state: AssistantState,
  /** One of the device's connections owns the session's audio now ("talking now"). */
  ownerPresent: Schema.Boolean,
  conversationId: ConversationId,
  /** Committed turns in the current conversation. */
  turns: NonNegativeInt,
  /** Epoch milliseconds of the last committed turn; `null`: none yet in this conversation. */
  lastTurnAt: Schema.NullOr(NonNegativeFinite),
  /** Protocol 7: the assistant that answers without a phrase (or last replied). */
  answering: Schema.optionalKey(AssistantId),
  /** Protocol 7: one conversation per assistant; `conversationId`, `turns` and `lastTurnAt` above are the answering one's. */
  conversations: Schema.optionalKey(Schema.Array(Schema.Struct({
    assistantId: AssistantId,
    conversationId: ConversationId,
    turns: NonNegativeInt,
    lastTurnAt: Schema.NullOr(NonNegativeFinite)
  })))
})
export type SessionInfo = typeof SessionInfo.Type
