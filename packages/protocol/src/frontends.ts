import { Schema } from "effect"
import { InterruptMode, NonNegativeFinite, OutputPath } from "./common.ts"

/**
 * Front ends, devices and device profiles (docs/FRONTENDS-AND-ACTIVATION.md §2, protocol 5).
 *
 * Browser-safe: the server, the voice front end and the admin front end share these definitions, the built-in
 * defaults and the bounds, so a value the admin form accepts is a value the server accepts.
 *
 * - A **front-end role** is what a connection is: the voice front end (`/`) or the admin front end (`/admin/`).
 * - A **front-end kind** is a type of client that can be a voice front end: `web-voice` (a browser) today,
 *   `satellite` (a box with a microphone and a speaker) later. Kinds are a registry on the server.
 * - A **device** is one installed front end with a stable id (a browser keeps it in `localStorage`).
 * - A **profile** is the per-device settings. Effective profile = `DEFAULT_DEVICE_PROFILE` ← the kind's defaults
 *   (admin: Front ends › kind) ← the device's overrides (admin: Devices › device, or the device itself for the
 *   fields in `DEVICE_EDITABLE_FIELDS`). See `effectiveProfile`.
 */

/** What a connection is, sent in `hello`. `admin` connections never own the audio. */
export const FrontendRole = Schema.Literals(["voice", "admin"])
export type FrontendRole = typeof FrontendRole.Type

/** Id of a front-end kind: lower case, digits and dashes, starting with a letter (`web-voice`, `satellite`). */
export const FrontendKindId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/))
export type FrontendKindId = typeof FrontendKindId.Type

/** The kind every browser voice front end reports. */
export const WEB_VOICE_KIND = "web-voice"

/**
 * Stable id of a device, chosen by the device (random, at least 8 characters, URL-safe). Distinct from the per-tab
 * `clientId`: every tab of one browser shares one `deviceId`.
 */
export const DeviceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{8,64}$/))
export type DeviceId = typeof DeviceId.Type

/** Longest device name. */
export const MAX_DEVICE_NAME_CHARS = 60
/** A device's display name ("iPhone · Safari"). Not blank. */
export const DeviceName = Schema.String.check(
  Schema.isMaxLength(MAX_DEVICE_NAME_CHARS),
  Schema.makeFilter((s: string) => s.trim().length > 0 || "a device name must not be blank")
)
export type DeviceName = typeof DeviceName.Type

/** At most this many devices are remembered (least recently seen dropped first; devices with overrides last). */
export const MAX_DEVICES = 64

/**
 * - `always`: react to everything heard (the behaviour before protocol 5).
 * - `wake-phrase`: react only after one of `wakePhrases` (or inside the armed / follow-up windows).
 */
export const Activation = Schema.Literals(["always", "wake-phrase"])
export type Activation = typeof Activation.Type

/**
 * How strictly a heard phrase must equal a wake phrase (both normalised by `wakeWords`):
 * - `exact`: every word equal.
 * - `close`: a phrase word of `CLOSE_MATCH_MIN_LETTERS` or more letters may differ by one edit (Levenshtein 1);
 *   shorter words must be equal. "hey jeff" accepts "hey jeffs" and "hey geff", not "hey go".
 */
export const WakeMatch = Schema.Literals(["exact", "close"])
export type WakeMatch = typeof WakeMatch.Type

/** In `close` matching, words of at least this many letters may differ by one edit. */
export const CLOSE_MATCH_MIN_LETTERS = 4

/**
 * Normalise text into words for wake-phrase matching: Unicode NFD, diacritics (combining marks) removed, lower
 * case, apostrophes removed inside words ("Jeff's" → "jeffs"), every other character that is not a letter or a
 * digit separates words. "Hé, Jeff!" → ["he", "jeff"]. The matcher in `@pva/core` (`matchWakePhrase`) and the
 * `WakePhrase` validation use this same function.
 */
export const wakeWords = (text: string): Array<string> => {
  const out: Array<string> = []
  for (const token of text.match(WAKE_TOKEN) ?? []) {
    const word = normaliseWakeToken(token)
    if (word.length > 0) out.push(word)
  }
  return out
}

/** A run of letters, digits, combining marks and apostrophes: one word before normalisation. */
export const WAKE_TOKEN = /[\p{L}\p{N}\p{M}'’]+/gu

/** One token (a `WAKE_TOKEN` match) → its normalised word ("" when nothing is left). */
export const normaliseWakeToken = (token: string): string =>
  token.normalize("NFD").replace(/[\p{M}'’]/gu, "").toLowerCase()

export const WAKE_PHRASES_MIN = 1
export const WAKE_PHRASES_MAX = 12
export const WAKE_PHRASE_WORDS_MAX = 6
export const WAKE_PHRASE_CHARS_MAX = 60

/** One wake phrase as typed ("Hey Jeff"): 1..6 words after `wakeWords`, at most 60 characters. */
export const WakePhrase = Schema.String.check(
  Schema.isMaxLength(WAKE_PHRASE_CHARS_MAX),
  Schema.makeFilter((s: string) => {
    const n = wakeWords(s).length
    return n < 1
      ? "a wake phrase needs at least one word"
      : n > WAKE_PHRASE_WORDS_MAX
      ? `a wake phrase has at most ${WAKE_PHRASE_WORDS_MAX} words`
      : undefined
  })
)
export type WakePhrase = typeof WakePhrase.Type

export const WakePhrases = Schema.Array(WakePhrase).check(
  Schema.isMinLength(WAKE_PHRASES_MIN),
  Schema.isMaxLength(WAKE_PHRASES_MAX)
)

export const FOLLOW_UP_SECONDS_MIN = 0
export const FOLLOW_UP_SECONDS_MAX = 60
export const PREBUFFER_MS_MIN = 20
export const PREBUFFER_MS_MAX = 500
/** After the phrase alone ("Hey Jeff", pause), the next utterance starting within this long needs no phrase. */
export const WAKE_ARMED_MS = 8_000
/** The admin phrase tester (`wake.test`) switches itself off after this long. */
export const WAKE_TEST_MAX_MS = 300_000
/** `conversationIdleMinutes` bounds (docs/VOICE-SESSIONS.md §4); the built-in default is the setting's default. */
export const CONVERSATION_IDLE_MINUTES_LIMITS = { min: 0, max: 240, default: 10 } as const
/** Longest voice name in a profile. */
export const MAX_VOICE_NAME_CHARS = 64

/** Seconds after a reply during which the device keeps reacting without the phrase. Whole seconds, 0..60. */
export const FollowUpSeconds = Schema.Int.check(Schema.isBetween({ minimum: FOLLOW_UP_SECONDS_MIN, maximum: FOLLOW_UP_SECONDS_MAX }))
/** Reply audio buffered by the browser before playback starts, 20..500 ms. */
export const PrebufferMs = Schema.Int.check(Schema.isBetween({ minimum: PREBUFFER_MS_MIN, maximum: PREBUFFER_MS_MAX }))
/**
 * Minutes without a committed turn after which the next turn starts a new conversation (protocol 6); 0 = never.
 * Whole minutes, 0..240.
 */
export const ConversationIdleMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: CONVERSATION_IDLE_MINUTES_LIMITS.min, maximum: CONVERSATION_IDLE_MINUTES_LIMITS.max })
)
/** `""` = the assistant's default voice; else the name of an enabled voice (the server falls back to `""` otherwise). */
export const ProfileVoice = Schema.String.check(Schema.isMaxLength(MAX_VOICE_NAME_CHARS))

/** The per-device settings. Every field is always present in an effective profile. */
export const DeviceProfile = Schema.Struct({
  /** Server: the wake gate. */
  activation: Activation,
  /** Server: the wake gate. 1..12 phrases, each 1..6 words, e.g. ["hey jeff", "hey jev", "hey geoff"]. */
  wakePhrases: WakePhrases,
  /** Server: the wake gate. */
  wakeMatch: WakeMatch,
  /** Server: the wake gate. After a reply, keep reacting without the phrase this long; 0 = asleep right away. */
  followUpSeconds: FollowUpSeconds,
  /** Server: the voice router's default voice while this device owns the audio. */
  voice: ProfileVoice,
  /** Server: the echo gate's mode while this device owns the audio (it used to come in `audio.claim`). */
  interruptMode: InterruptMode,
  /**
   * Server (protocol 6): the device's conversation starts afresh at the next turn after this many minutes without a
   * committed turn; 0 = never. The kind default comes from the assistant setting `CONVERSATION_IDLE_MINUTES`.
   */
  conversationIdleMinutes: ConversationIdleMinutes,
  /** Browser: show captions of the reply on the stage. */
  captions: Schema.Boolean,
  /** Browser: speak replies to typed messages (`text.send.speak`). */
  speakReplies: Schema.Boolean,
  /** Browser: `getUserMedia` voice processing (the microphone is re-opened when one changes). */
  echoCancellation: Schema.Boolean,
  noiseSuppression: Schema.Boolean,
  autoGainControl: Schema.Boolean,
  /** Browser: how reply audio is routed. */
  outputPath: OutputPath,
  /** Browser: reply audio buffered before playback starts. */
  prebufferMs: PrebufferMs
})
export type DeviceProfile = typeof DeviceProfile.Type

/** The name of one profile field. */
export const ProfileField = Schema.Literals([
  "activation",
  "wakePhrases",
  "wakeMatch",
  "followUpSeconds",
  "voice",
  "interruptMode",
  "conversationIdleMinutes",
  "captions",
  "speakReplies",
  "echoCancellation",
  "noiseSuppression",
  "autoGainControl",
  "outputPath",
  "prebufferMs"
])
export type ProfileField = typeof ProfileField.Type

/** Every profile field, in form order. */
export const PROFILE_FIELDS: ReadonlyArray<ProfileField> = ProfileField.literals

/** The fields a device may change for itself without admin (`device.update`). Everything else is admin only. */
export const DEVICE_EDITABLE_FIELDS: ReadonlyArray<ProfileField> = ["voice", "activation", "followUpSeconds"]

/** Built-in defaults: equal to the browser defaults before protocol 5, with `activation: always`. */
export const DEFAULT_DEVICE_PROFILE: DeviceProfile = {
  activation: "always",
  wakePhrases: ["hey jeff", "hey jev", "hey geoff"],
  wakeMatch: "close",
  followUpSeconds: 8,
  voice: "",
  interruptMode: "confirm",
  conversationIdleMinutes: CONVERSATION_IDLE_MINUTES_LIMITS.default,
  captions: true,
  speakReplies: true,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  outputPath: "direct",
  prebufferMs: 60
}

/**
 * Stored overrides: the fields that differ from the level below (kind defaults over the built-in defaults, device
 * overrides over the kind). An absent field = inherited.
 */
export const ProfileOverrides = Schema.Struct({
  activation: Schema.optionalKey(Activation),
  wakePhrases: Schema.optionalKey(WakePhrases),
  wakeMatch: Schema.optionalKey(WakeMatch),
  followUpSeconds: Schema.optionalKey(FollowUpSeconds),
  voice: Schema.optionalKey(ProfileVoice),
  interruptMode: Schema.optionalKey(InterruptMode),
  conversationIdleMinutes: Schema.optionalKey(ConversationIdleMinutes),
  captions: Schema.optionalKey(Schema.Boolean),
  speakReplies: Schema.optionalKey(Schema.Boolean),
  echoCancellation: Schema.optionalKey(Schema.Boolean),
  noiseSuppression: Schema.optionalKey(Schema.Boolean),
  autoGainControl: Schema.optionalKey(Schema.Boolean),
  outputPath: Schema.optionalKey(OutputPath),
  prebufferMs: Schema.optionalKey(PrebufferMs)
})
export type ProfileOverrides = typeof ProfileOverrides.Type

/**
 * A change to overrides: only the fields named change. A value sets the override; `null` removes it (the field
 * inherits again, shown as "Default (…)" / "Reset" in admin). An empty patch is valid and changes nothing.
 */
export const ProfilePatch = Schema.Struct({
  activation: Schema.optionalKey(Schema.NullOr(Activation)),
  wakePhrases: Schema.optionalKey(Schema.NullOr(WakePhrases)),
  wakeMatch: Schema.optionalKey(Schema.NullOr(WakeMatch)),
  followUpSeconds: Schema.optionalKey(Schema.NullOr(FollowUpSeconds)),
  voice: Schema.optionalKey(Schema.NullOr(ProfileVoice)),
  interruptMode: Schema.optionalKey(Schema.NullOr(InterruptMode)),
  conversationIdleMinutes: Schema.optionalKey(Schema.NullOr(ConversationIdleMinutes)),
  captions: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  speakReplies: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  echoCancellation: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  noiseSuppression: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  autoGainControl: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  outputPath: Schema.optionalKey(Schema.NullOr(OutputPath)),
  prebufferMs: Schema.optionalKey(Schema.NullOr(PrebufferMs))
})
export type ProfilePatch = typeof ProfilePatch.Type

/** The fields a patch touches (sets or removes). The server refuses a `device.update` naming a field not editable. */
export const patchFields = (patch: ProfilePatch): Array<ProfileField> =>
  PROFILE_FIELDS.filter((f) => Object.hasOwn(patch, f))

/** Apply a patch to overrides: a value sets, `null` removes, absent keeps. Returns a new object. */
export const applyProfilePatch = (overrides: ProfileOverrides, patch: ProfilePatch): ProfileOverrides => {
  const next: Record<string, unknown> = { ...overrides }
  for (const field of patchFields(patch)) {
    const value = (patch as Record<string, unknown>)[field]
    if (value === null) delete next[field]
    else next[field] = value
  }
  return next as ProfileOverrides
}

/** Effective profile: built-in defaults ← kind defaults ← device overrides. */
export const effectiveProfile = (
  kindDefaults: ProfileOverrides = {},
  deviceOverrides: ProfileOverrides = {},
  builtIn: DeviceProfile = DEFAULT_DEVICE_PROFILE
): DeviceProfile => ({ ...builtIn, ...kindDefaults, ...deviceOverrides })

/** What a device says about itself in `hello` (voice front ends). */
export const DeviceHello = Schema.Struct({
  id: DeviceId,
  kind: FrontendKindId,
  /** Suggested name (derived from the user agent); used only the first time the server sees this device. */
  name: DeviceName
})
export type DeviceHello = typeof DeviceHello.Type

/**
 * A connection's effective profile (`snapshot.device`, `device.profile`). `editable`: the fields this connection
 * may change itself with `device.update` (`DEVICE_EDITABLE_FIELDS`, or none for a voice connection without a
 * device).
 */
export const DeviceProfileInfo = Schema.Struct({
  /** The device this profile belongs to; absent for a voice connection that sent no `device` (kind defaults). */
  deviceId: Schema.optionalKey(DeviceId),
  profile: DeviceProfile,
  editable: Schema.Array(ProfileField)
})
export type DeviceProfileInfo = typeof DeviceProfileInfo.Type

/** One front-end kind, for admin (Front ends › kind). */
export const FrontendKindInfo = Schema.Struct({
  id: FrontendKindId,
  /** "Voice assistant in a browser". */
  title: Schema.String,
  description: Schema.String,
  /** The profile fields that apply to this kind (the form shows only these), in form order. */
  fields: Schema.Array(ProfileField),
  /** The kind's defaults set by admin (stored in `data/settings.json` `frontends[kind]`). */
  defaults: ProfileOverrides,
  /** `DEFAULT_DEVICE_PROFILE` ← `defaults`: what a device of this kind without overrides gets. */
  profile: DeviceProfile
})
export type FrontendKindInfo = typeof FrontendKindInfo.Type

/** One remembered device, for admin (Devices). */
export const DeviceInfo = Schema.Struct({
  id: DeviceId,
  kind: FrontendKindId,
  name: DeviceName,
  /** Epoch milliseconds. */
  firstSeen: NonNegativeFinite,
  /** Epoch milliseconds of the last `hello` (or now, while connected). */
  lastSeen: NonNegativeFinite,
  /** The device's own overrides over its kind's defaults (stored in `data/settings.json` `devices[id]`). */
  overrides: ProfileOverrides,
  /** The effective profile (kind defaults ← overrides). */
  profile: DeviceProfile,
  /** Open voice connections of this device right now. */
  connections: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** One of its connections owns the audio now ("this is the audio owner now"). */
  audioOwner: Schema.Boolean
})
export type DeviceInfo = typeof DeviceInfo.Type
