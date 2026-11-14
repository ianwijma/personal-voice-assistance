import { Schema } from "effect"
import {
  ClientId,
  InterruptMode,
  ModuleId,
  NonNegativeFinite,
  NonNegativeInt,
  OutputPath,
  RequestId,
  SectionId,
  TurnId
} from "./common.ts"
import { MAX_TEXT_INPUT_CHARS } from "./constants.ts"
import { MAX_MOVE_KEYS } from "./env.ts"
import { JobAction, ToolId } from "./jobs.ts"
import { SettingsPatch } from "./settings.ts"
import { Password } from "./vault.ts"

/**
 * Text frames from the browser to the assistant. Binary frames from the
 * browser are microphone audio (see `frames.ts`).
 */

/** First message on every connection. Nothing else is accepted before it. */
export const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  protocol: Schema.Int,
  clientId: ClientId,
  /**
   * This page was the audio owner before the connection dropped and its audio
   * graph is still running. The server makes it the owner again only if no other
   * tab has claimed the audio since.
   */
  resumeOwner: Schema.Boolean
})

/** Facts about the browser's audio setup, for logs and the latency trace. */
export const AudioClientInfo = Schema.Struct({
  contextSampleRate: Schema.Finite,
  baseLatencyMs: Schema.optionalKey(NonNegativeFinite),
  outputLatencyMs: Schema.optionalKey(NonNegativeFinite),
  /** `MediaStreamTrack.getSettings().echoCancellation`, when the browser reports it. */
  echoCancellation: Schema.optionalKey(Schema.Boolean),
  outputPath: OutputPath
})

/** Become the microphone and speaker (sent after the Start gesture succeeded). The last claim wins. */
export const AudioClaim = Schema.Struct({
  type: Schema.Literal("audio.claim"),
  interruptMode: InterruptMode,
  audio: AudioClientInfo
})

/** Stop being the microphone and speaker (the user ended the session). */
export const AudioRelease = Schema.Struct({ type: Schema.Literal("audio.release") })

/** Change per-device audio options while owning the audio. */
export const AudioConfig = Schema.Struct({
  type: Schema.Literal("audio.config"),
  interruptMode: InterruptMode,
  audio: AudioClientInfo
})

/**
 * Microphone on or off. While off the browser sends no microphone frames; the
 * server feeds the speech recogniser a quiet noise floor instead.
 */
export const MicState = Schema.Struct({
  type: Schema.Literal("mic.state"),
  live: Schema.Boolean
})

/** The first sample of reply `turnId` was handed to the audio device. */
export const PlaybackStarted = Schema.Struct({
  type: Schema.Literal("playback.started"),
  turnId: TurnId,
  /** `AudioContext.outputLatency` in ms (0 when unknown): the sound is audible this much later. */
  outputLatencyMs: NonNegativeFinite,
  /** From the reply's first audio frame arriving to playback starting. */
  startDelayMs: NonNegativeFinite
})

/** Sent every 250 ms while a reply plays. */
export const PlaybackProgress = Schema.Struct({
  type: Schema.Literal("playback.progress"),
  turnId: TurnId,
  /** Samples of the reply (at its `reply.start` rate) handed to the audio device so far. */
  playedSamples: NonNegativeInt,
  /** Buffer underruns in this reply so far. */
  underruns: NonNegativeInt
})

/** The reply played to its end (after `reply.end`, the queue ran dry). */
export const PlaybackFinished = Schema.Struct({
  type: Schema.Literal("playback.finished"),
  turnId: TurnId,
  playedSamples: NonNegativeInt
})

/**
 * Playback of the reply was stopped (after `reply.stop`, or by the user's own
 * `interrupt`). `playedSamples` is final: it is what the user heard.
 */
export const PlaybackStopped = Schema.Struct({
  type: Schema.Literal("playback.stopped"),
  turnId: TurnId,
  playedSamples: NonNegativeInt,
  /**
   * `false`: `playedSamples` is the page's best estimate, sent before the player
   * confirmed its own count; an exact report for the same turn may follow, and
   * the server waits for it (within its stop deadline) before taking this one.
   * Absent (older pages) or `true`: the count is exact.
   */
  exact: Schema.optionalKey(Schema.Boolean)
})

/**
 * The user pressed Stop. The browser has already silenced its player; the
 * server interrupts the running turn. Accepted from any tab.
 */
export const Interrupt = Schema.Struct({
  type: Schema.Literal("interrupt"),
  /** The turn the user saw; omitted = whatever is running. A stale id is ignored. */
  turnId: Schema.optionalKey(TurnId)
})

/** A typed message. Answered with `result` (same id), then the normal turn events. */
export const TextSend = Schema.Struct({
  type: Schema.Literal("text.send"),
  requestId: RequestId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TEXT_INPUT_CHARS)),
  /** Speak the reply. Honoured only for the audio owner; otherwise the reply is text only. */
  speak: Schema.Boolean
})

export const ModuleEnable = Schema.Struct({
  type: Schema.Literal("module.enable"),
  requestId: RequestId,
  moduleId: ModuleId
})

export const ModuleDisable = Schema.Struct({
  type: Schema.Literal("module.disable"),
  requestId: RequestId,
  moduleId: ModuleId
})

/** Change a module's settings (a patch: only changed fields). Restarts the module if it is running. */
export const ModuleConfigure = Schema.Struct({
  type: Schema.Literal("module.configure"),
  requestId: RequestId,
  moduleId: ModuleId,
  patch: SettingsPatch
})

/**
 * Change assistant settings in one section (a patch). Saved values are stored by key, not by section, so the
 * section only says which form (and which checks) the patch belongs to.
 */
export const SettingsUpdate = Schema.Struct({
  type: Schema.Literal("settings.update"),
  requestId: RequestId,
  sectionId: SectionId,
  patch: SettingsPatch,
  /** Save even when the section's checks warn (the owner saw `ErrorInfo.warnings` and chose "Save anyway"). */
  confirmWarnings: Schema.optionalKey(Schema.Boolean)
})

/** Rebuild the speech and language engines with the saved settings (keeps the conversation). */
export const EngineReload = Schema.Struct({
  type: Schema.Literal("engine.reload"),
  requestId: RequestId
})

/**
 * Create the vault with a password (at least `MIN_PASSWORD_CHARS`), moving the keys out of the project into it.
 * Only while there is no vault. Grants this page admin access.
 */
export const VaultSetup = Schema.Struct({
  type: Schema.Literal("vault.setup"),
  requestId: RequestId,
  password: Password
})

/**
 * Unlock the vault (when locked) and get admin access for this page (also when another page or
 * `PVA_VAULT_PASSWORD` already unlocked it). A wrong password is answered `bad_password`.
 */
export const VaultUnlock = Schema.Struct({
  type: Schema.Literal("vault.unlock"),
  requestId: RequestId,
  password: Password
})

/** Admin only: lock the vault now (the keys leave memory; every page loses admin access). */
export const VaultLock = Schema.Struct({
  type: Schema.Literal("vault.lock"),
  requestId: RequestId
})

/** Re-encrypt the vault under a new password (with a new salt). Needs the current password. */
export const VaultChangePassword = Schema.Struct({
  type: Schema.Literal("vault.changePassword"),
  requestId: RequestId,
  oldPassword: Password,
  newPassword: Password
})

/**
 * Admin only: move settings from a `.env` file into the saved settings (keys into the key vault, refused while it
 * is locked). Each line is commented out of the file (a backup is kept next to it); the value is never echoed.
 * `keys` are environment variable names with `movable` in `EnvInfo`. All or nothing per key; the answer names the
 * keys that could not be moved.
 */
export const SettingsMoveFromEnv = Schema.Struct({
  type: Schema.Literal("settings.moveFromEnv"),
  requestId: RequestId,
  keys: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MOVE_KEYS)
  )
})

/** Admin only: start a job (download a model preset). `target` must be a name from the tool's table. */
export const JobStart = Schema.Struct({
  type: Schema.Literal("job.start"),
  requestId: RequestId,
  tool: ToolId,
  action: JobAction,
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))
})

/** Admin only: cancel a running job (a download's partial files are removed). */
export const JobCancel = Schema.Struct({
  type: Schema.Literal("job.cancel"),
  requestId: RequestId,
  jobId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
})

/** Admin only: delete a downloaded model. Refused while the running engines use it. */
export const ModelDelete = Schema.Struct({
  type: Schema.Literal("model.delete"),
  requestId: RequestId,
  tool: ToolId,
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))
})

/** Liveness check; the server answers `pong` with the same id. Sent every 5 s. */
export const Ping = Schema.Struct({
  type: Schema.Literal("ping"),
  id: NonNegativeInt
})

export const ClientMessage = Schema.Union([
  Hello,
  AudioClaim,
  AudioRelease,
  AudioConfig,
  MicState,
  PlaybackStarted,
  PlaybackProgress,
  PlaybackFinished,
  PlaybackStopped,
  Interrupt,
  TextSend,
  ModuleEnable,
  ModuleDisable,
  ModuleConfigure,
  SettingsUpdate,
  EngineReload,
  VaultSetup,
  VaultUnlock,
  VaultLock,
  VaultChangePassword,
  SettingsMoveFromEnv,
  JobStart,
  JobCancel,
  ModelDelete,
  Ping
]).pipe(Schema.toTaggedUnion("type"))
export type ClientMessage = typeof ClientMessage.Type
export type ClientMessageType = ClientMessage["type"]
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { readonly type: T }>
