import { Schema } from "effect"
import { AdminToken } from "./admin.ts"
import { Assistant, AssistantBody, AssistantId, MAX_ASSISTANTS } from "./assistants.ts"
import {
  ClientId,
  FieldKey,
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
import { DeviceSettingsPatch, DeviceTarget } from "./devices.ts"
import { DeviceHello, DeviceId, DeviceName, FrontendRole, WakePhrase } from "./frontends.ts"
import { JobAction, ToolId } from "./jobs.ts"
import { SettingsPatch, SettingValue } from "./settings.ts"
import { Password } from "./vault.ts"

/**
 * Text frames from the browser to the assistant. Binary frames from the
 * browser are microphone audio (see `frames.ts`).
 *
 * Protocol 5: requests marked "Admin only" are answered `admin_required` on a connection that is not admin
 * (`admin.login`, `admin.ts`). That covers every settings, module, engine-reload, vault, `.env`, job, model,
 * front-end and device-admin request, and the phrase tester.
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
  resumeOwner: Schema.Boolean,
  /** Protocol 5: which front end this is. `admin` connections never own the audio and send no `device`. */
  frontend: FrontendRole,
  /**
   * Protocol 5, voice front ends: this device (stable `deviceId` from `localStorage`, its kind, a suggested name).
   * The server records it (first seen / last seen) and answers with its effective profile (`snapshot.device`).
   * Without it a voice connection gets the `web-voice` kind defaults and may change none of them.
   */
  device: Schema.optionalKey(DeviceHello),
  /**
   * Protocol 5, admin front ends: the session token from an earlier `admin.login` (kept in `sessionStorage`), so a
   * reload or reconnect stays logged in. Valid: `admin.snapshot` follows `welcome`. Not valid: `snapshot.admin` says
   * `loggedIn: false` (no error).
   */
  adminToken: Schema.optionalKey(AdminToken)
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

/**
 * Become the microphone and speaker (sent after the Start gesture succeeded). The last claim wins.
 * Protocol 5: the interrupt mode comes from the device profile, not from here. From an admin connection it is
 * refused with error `not_owner` (the admin front end never claims the audio).
 */
export const AudioClaim = Schema.Struct({
  type: Schema.Literal("audio.claim"),
  audio: AudioClientInfo
})

/** Stop being the microphone and speaker (the user ended the session). */
export const AudioRelease = Schema.Struct({ type: Schema.Literal("audio.release") })

/** The browser's audio setup changed while owning the audio (e.g. the output path). Protocol 5: no interrupt mode. */
export const AudioConfig = Schema.Struct({
  type: Schema.Literal("audio.config"),
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
  speak: Schema.Boolean,
  /** Protocol 7: the assistant this text is for (the voice page names the conversation shown). Absent: the device's route (docs/ASSISTANTS.md §2.6). */
  assistantId: Schema.optionalKey(AssistantId)
})

/** Admin only. */
export const ModuleEnable = Schema.Struct({
  type: Schema.Literal("module.enable"),
  requestId: RequestId,
  moduleId: ModuleId
})

/** Admin only. */
export const ModuleDisable = Schema.Struct({
  type: Schema.Literal("module.disable"),
  requestId: RequestId,
  moduleId: ModuleId
})

/** Admin only: change a module's settings (a patch: only changed fields). Restarts the module if it is running. */
export const ModuleConfigure = Schema.Struct({
  type: Schema.Literal("module.configure"),
  requestId: RequestId,
  moduleId: ModuleId,
  patch: SettingsPatch
})

/**
 * Protocol 10, admin only: press an `action` field of a module's form ("Test"). Answered with `result`, whose
 * `action` is what the handler said (`ok: true` on the result means it ran; `action.ok` says whether it worked).
 * `values`: the page's draft (non-secret values) for a field with `requiresSaved: false`; the handler then sees
 * them over the saved settings. Absent: the saved settings.
 */
export const ModuleAction = Schema.Struct({
  type: Schema.Literal("module.action"),
  requestId: RequestId,
  moduleId: ModuleId,
  key: FieldKey,
  values: Schema.optionalKey(Schema.Record(FieldKey, SettingValue))
})

/**
 * Admin only: change assistant settings in one section (a patch). Saved values are stored by key, not by section, so the
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

/** Admin only: rebuild the speech and language engines with the saved settings (keeps the conversation). */
export const EngineReload = Schema.Struct({
  type: Schema.Literal("engine.reload"),
  requestId: RequestId
})

/**
 * Admin only: create the vault with a password (at least `MIN_PASSWORD_CHARS`), moving the keys out of the project
 * into it. Only while there is no vault. (Before protocol 5 this also granted admin access; it no longer does.)
 */
export const VaultSetup = Schema.Struct({
  type: Schema.Literal("vault.setup"),
  requestId: RequestId,
  password: Password
})

/**
 * Admin only: unlock the vault (when locked). A wrong password is answered `bad_password`. (Before protocol 5 this
 * also granted admin access to the page; it no longer does, and an unlocked vault answers `ok`.)
 */
export const VaultUnlock = Schema.Struct({
  type: Schema.Literal("vault.unlock"),
  requestId: RequestId,
  password: Password
})

/** Admin only: lock the vault now (the keys leave memory). Admin sessions are not affected (protocol 5). */
export const VaultLock = Schema.Struct({
  type: Schema.Literal("vault.lock"),
  requestId: RequestId
})

/** Admin only: re-encrypt the vault under a new password (with a new salt). Needs the current password. */
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

/**
 * Log in to admin with `PVA_ADMIN_PASSWORD`. Success: `result` with `ok: true` and `admin: AdminSession` (keep the
 * token in `sessionStorage`, send it in the next `hello`), then `admin.state` and `admin.snapshot` on this
 * connection. Wrong password: `bad_password`, and `admin.state` with `retryAfterMs` while attempts are refused
 * (the same back-off as vault unlocks). Admin disabled (no password set): `admin_required` with a message saying
 * so. Already logged in: `ok` with a fresh session.
 */
export const AdminLogin = Schema.Struct({
  type: Schema.Literal("admin.login"),
  requestId: RequestId,
  password: Password
})

/**
 * End this connection's admin session (the token stops working everywhere it was used). Answered `ok` also when
 * not logged in. Every connection of the session gets `admin.state` with `loggedIn: false, endReason: "logout"`.
 */
export const AdminLogout = Schema.Struct({
  type: Schema.Literal("admin.logout"),
  requestId: RequestId
})

/**
 * Admin only: forget a device (its record and overrides). A device that is connected now is recorded again as new
 * (kind defaults) and its connections get `device.profile`. Unknown device: `unknown_device`.
 */
export const DeviceForget = Schema.Struct({
  type: Schema.Literal("device.forget"),
  requestId: RequestId,
  id: DeviceId
})

/**
 * Admin only: switch the wake-phrase tester on or off for this connection. While on, the connection gets
 * `wake.heard` for every final transcript of the current audio owner (also in `always` mode, and including what
 * the wake gate dropped). It switches itself off `WAKE_TEST_MAX_MS` (5 min) after the last `on: true`, and when the
 * connection stops being admin; the page counts the 5 minutes itself (sending `on: true` again restarts them).
 */
export const WakeTest = Schema.Struct({
  type: Schema.Literal("wake.test"),
  requestId: RequestId,
  on: Schema.Boolean,
  /**
   * Protocol 6: whose transcripts (each device has its own session): this device's session. Absent: the most
   * recently active session (as it changes). Unknown device: `unknown_device`.
   */
  deviceId: Schema.optionalKey(DeviceId)
})

/**
 * Protocol 6, voice connections: start a new conversation on this connection's device (New conversation). Stops the
 * running turn as Stop does, drops the device's history and gives the conversation a new id; every connection of the
 * device gets `conversation { reason: "new" }`. Works without running engines. Answered with `result`. A voice
 * connection without a device has a session of its own; one without a session yet gets the `conversation` message
 * all the same (its next turn starts in the new conversation).
 */
export const ConversationNew = Schema.Struct({
  type: Schema.Literal("conversation.new"),
  requestId: RequestId,
  /** Protocol 7: whose conversation restarts. Absent: the answering assistant's. */
  assistantId: Schema.optionalKey(AssistantId)
})

/** Liveness check; the server answers `pong` with the same id. Sent every 5 s. */
export const Ping = Schema.Struct({
  type: Schema.Literal("ping"),
  id: NonNegativeInt
})

// -- Protocol 7 (docs/ASSISTANTS.md §5.2, §5.3)

/** Where a created assistant is placed (wizard step 6): appended to that entry's list, with an optional first phrase. */
export const AssistantPlacement = Schema.Struct({
  target: DeviceTarget,
  phrase: Schema.optionalKey(WakePhrase)
})

/**
 * Admin only: create an assistant. The server makes the id from the name. Answered with `result`
 * (`assistantId`) or `invalid_settings` (fieldErrors) or `limit_reached` (`MAX_ASSISTANTS`).
 */
export const AssistantCreate = Schema.Struct({
  type: Schema.Literal("assistant.create"),
  requestId: RequestId,
  /** Every field except `id` and `rev`; the wizard's "Start from" is `copyOf`, and the body still carries every field. */
  assistant: AssistantBody,
  copyOf: Schema.optionalKey(AssistantId),
  placements: Schema.optionalKey(Schema.Array(AssistantPlacement).check(Schema.isMaxLength(MAX_ASSISTANTS * 4))),
  /** Additive: keep a voice whose hosted provider has no key yet (the voice check's warning). */
  saveAnyway: Schema.optionalKey(Schema.Boolean)
})

/** Admin only: save a whole assistant. `assistant.rev` must equal the stored rev, else `stale`. */
export const AssistantSave = Schema.Struct({
  type: Schema.Literal("assistant.save"),
  requestId: RequestId,
  assistant: Assistant,
  saveAnyway: Schema.optionalKey(Schema.Boolean)
})

/** Admin only: delete an assistant (removed from every list, see docs/ASSISTANTS.md §2.6). `rev` as for save. */
export const AssistantDelete = Schema.Struct({
  type: Schema.Literal("assistant.delete"),
  requestId: RequestId,
  id: AssistantId,
  rev: NonNegativeInt
})

/**
 * Admin only: save a device type's defaults entry or one device. `rev` is the entry's rev (`stale` otherwise).
 * `settings` sets sections (a value) or, for a device only, returns them to the type defaults (`null`).
 */
export const DeviceSave = Schema.Struct({
  type: Schema.Literal("device.save"),
  requestId: RequestId,
  target: DeviceTarget,
  rev: NonNegativeInt,
  /** Devices only. */
  name: Schema.optionalKey(DeviceName),
  settings: DeviceSettingsPatch,
  saveAnyway: Schema.optionalKey(Schema.Boolean)
})

/** Voice connections: read one assistant's conversation on this device; answered with `conversation.history`. */
export const ConversationRead = Schema.Struct({
  type: Schema.Literal("conversation.read"),
  requestId: RequestId,
  assistantId: AssistantId
})

/**
 * Voice connections: pick who answers without a phrase on this device (`""` = nobody, `"typesafe"` = whichever
 * fits). Refused `not_allowed` unless the setup says `canPick` (and `"typesafe"` unless `canAuto`).
 */
export const DevicePick = Schema.Struct({
  type: Schema.Literal("device.pick"),
  requestId: RequestId,
  withoutPhrase: Schema.Union([AssistantId, Schema.Literal(""), Schema.Literal("typesafe")])
})

/**
 * Protocol 9, admin only: "Check again" on the Health page. The server probes every program the modules need again,
 * re-judges which modules are available (starting those that now are, and trying again every module that is not
 * running), runs every module's `health()`, and sends `health`. Answered with `result` as soon as the check has started (it can take longer than a
 * page waits for an answer): `health` with `checking: true` comes first, and the outcome arrives as `health` with
 * `checking: false`. A check already running is not started twice.
 */
export const HealthCheck = Schema.Struct({
  type: Schema.Literal("health.check"),
  requestId: RequestId
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
  AdminLogin,
  AdminLogout,
  DeviceForget,
  WakeTest,
  ConversationNew,
  Ping,
  AssistantCreate,
  AssistantSave,
  AssistantDelete,
  DeviceSave,
  ConversationRead,
  DevicePick,
  HealthCheck,
  ModuleAction
]).pipe(Schema.toTaggedUnion("type"))
export type ClientMessage = typeof ClientMessage.Type
export type ClientMessageType = ClientMessage["type"]
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { readonly type: T }>

/** The client messages that protocol 7 adds (also members of `ClientMessage`). */
export const AssistantsClientMessage = Schema.Union([
  AssistantCreate,
  AssistantSave,
  AssistantDelete,
  DeviceSave,
  ConversationRead,
  DevicePick
]).pipe(Schema.toTaggedUnion("type"))
export type AssistantsClientMessage = typeof AssistantsClientMessage.Type
export type AssistantsClientMessageType = AssistantsClientMessage["type"]
