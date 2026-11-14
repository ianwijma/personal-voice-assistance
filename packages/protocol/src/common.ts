import { Schema } from "effect"

/** A committed turn. Equal to the `TurnTrace` id; also the reply id in binary reply frames (u32). */
export const TurnId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 0xffff_ffff }))
export type TurnId = typeof TurnId.Type

/** Correlates a request with its `result`. Chosen by the client, unique per connection. */
export const RequestId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
export type RequestId = typeof RequestId.Type

/** Random per page load (kept in `sessionStorage`), so a reconnecting tab can be recognised. */
export const ClientId = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(64))
export type ClientId = typeof ClientId.Type

/** Module and settings-section ids: lower case, digits and dashes, starting with a letter. */
export const ModuleId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/))
export type ModuleId = typeof ModuleId.Type
export const SectionId = ModuleId
export type SectionId = ModuleId

/** Key of a settings field: `camelCase` for modules, `ENV_STYLE` for assistant settings. */
export const FieldKey = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,63}$/))
export type FieldKey = typeof FieldKey.Type

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * What the assistant is doing, as decided by the server (see the state table in
 * docs/UI-AND-MODULES.md). `muted`, `disconnected`, `error` and "not started"
 * are client-side states layered on top.
 *
 * `asleep` (protocol 5): there is an audio owner, its profile's activation is `wake-phrase`, and no window is
 * open (no armed window after the phrase alone, no follow-up window after a reply, no reply in progress that
 * counts as awake). The assistant still hears everything but reacts only to a wake phrase. The voice front end
 * shows *Say "<first wake phrase>"*. It takes the place of `listening`; `hearing` is not shown for speech the wake
 * gate holds back (ordinary talk in the room), only once an utterance is accepted.
 */
export const AssistantState = Schema.Literals(["idle", "listening", "hearing", "thinking", "speaking", "asleep"])
export type AssistantState = typeof AssistantState.Type

export const TurnOutcome = Schema.Literals(["completed", "interrupted", "discarded", "failed"])
export type TurnOutcome = typeof TurnOutcome.Type

/** How the user's words reached the assistant. */
export const TurnSource = Schema.Literals(["voice", "text"])
export type TurnSource = typeof TurnSource.Type

/** `owner`: this tab is the microphone and speaker. `observer`: sees everything, plays nothing. */
export const Role = Schema.Literals(["owner", "observer"])
export type Role = typeof Role.Type

/**
 * How the user can interrupt the assistant while it speaks, per device (a `DeviceProfile` field since protocol 5;
 * it used to be sent in `audio.claim` / `audio.config`):
 * - `instant`: any speech interrupts (headphones, or proven echo cancellation).
 * - `confirm`: speech interrupts once the recogniser has heard at least two words
 *   that are not the assistant's own (open speakers; the default).
 * - `manual`: the browser does not send the microphone while the assistant is
 *   audible; only the Stop control interrupts.
 */
export const InterruptMode = Schema.Literals(["instant", "confirm", "manual"])
export type InterruptMode = typeof InterruptMode.Type

/** How the browser routes reply audio: straight to the `AudioContext` destination, or through an `<audio>` element. */
export const OutputPath = Schema.Literals(["direct", "element"])
export type OutputPath = typeof OutputPath.Type

export const ErrorCode = Schema.Literals([
  /** The message had a known type but failed validation. */
  "bad_message",
  /** Only the audio owner may send this (microphone, playback reports). */
  "not_owner",
  "unknown_module",
  "unknown_section",
  /** Settings failed validation; see `fieldErrors`. */
  "invalid_settings",
  /** The module could not start with the requested settings; the previous state is kept. */
  "module_start_failed",
  /** The request conflicts with one in progress (e.g. two changes to one module at once, or a reload running). */
  "busy",
  /** The speech or language engines failed to start; the UI can still change settings. */
  "engine_failed",
  /** Microphone frames were lost (sequence gap) or arrived after a stall. */
  "mic_gap",
  /** The browser did not report playback progress in time; the reply was stopped. */
  "playback_timeout",
  /** A turn failed (provider error); the conversation continues. */
  "turn_failed",
  /**
   * The keys it needs are locked (the vault is locked, or a `.env` key cannot be moved while it is). Since
   * protocol 5 a request from a connection that is not admin is answered `admin_required` instead.
   */
  "locked",
  /**
   * A password was wrong, too short, or refused for now (too many attempts): the vault password (see
   * `vault.retryAfterMs`) or, since protocol 5, the admin password of `admin.login` (see `admin.state.retryAfterMs`).
   */
  "bad_password",
  /**
   * Protocol 5: the request needs an admin connection (`admin.login`) and this one is not, or its session ended.
   * Every settings, module, vault, job, model, `.env`, front-end and device-admin request, and `wake.test`.
   */
  "admin_required",
  /** Protocol 5: no such device (`device.admin.update`, `device.forget`) or front-end kind (`frontend.update`). */
  "unknown_device",
  "internal"
])
export type ErrorCode = typeof ErrorCode.Type

/** A validation problem in one settings field (`key: null` = the form as a whole). */
export const FieldError = Schema.Struct({
  key: Schema.NullOr(FieldKey),
  message: Schema.String
})
export type FieldError = typeof FieldError.Type

export const ErrorInfo = Schema.Struct({
  code: ErrorCode,
  /** One sentence for the user, saying how to fix it where possible. */
  message: Schema.String,
  turnId: Schema.optionalKey(TurnId),
  moduleId: Schema.optionalKey(ModuleId),
  fieldErrors: Schema.optionalKey(Schema.Array(FieldError)),
  /**
   * `invalid_settings` without field errors: the save would work, but these look like mistakes. Nothing was saved;
   * send it again with `confirmWarnings` to save anyway.
   */
  warnings: Schema.optionalKey(Schema.Array(FieldError))
})
export type ErrorInfo = typeof ErrorInfo.Type
