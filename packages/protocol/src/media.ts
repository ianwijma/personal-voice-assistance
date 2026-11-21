import { Schema } from "effect"

/**
 * The player of a device's page, on the wire (docs/modules/media.md §4.1, §4.2; additive within protocol 12). Core
 * never knows a provider: a `source` is an opaque short slug ("spotify", "youtube") end to end, and a page that does
 * not know one says so (`media.state.players[].error`, or an `unsupported` answer to a command). A page that does not
 * know these messages ignores them (`decodeServerMessage` answers `Unknown`), and one that declares no
 * `media.players` (`DeviceCapabilities.media`) is sent none.
 *
 * - `media.command` (server → one voice connection that declared players): one command to its player, numbered by
 *   the server (`seq`, per connection, rising). The page answers with `media.state` and the number it has handled
 *   in `ack`.
 * - `media.state` (voice page → server, no answer): the page's players and what is open, sent on every change and
 *   every few seconds while playing. The server drops a report that does not fit these bounds, refuses it from admin
 *   and node connections, and limits its rate per connection (`MEDIA_STATE_BURST`, `MEDIA_STATE_PER_SECOND`).
 *
 * Everything the page sends is untrusted: every text and address is bounded here and cleaned again by the server.
 * Everything the server sends is bounded the same way, and a page inserts none of it as markup.
 */

// -- Bounds -------------------------------------------------------------------------------------------------------------

/** A source: a short slug ("spotify", "youtube"). */
export const MEDIA_SOURCE = /^[a-z][a-z0-9-]{0,23}$/
/** Sources a page declares or reports at most (`DeviceCapabilities.media.players`, `MediaState.players`). */
export const MAX_MEDIA_PLAYERS = 8
/** The provider's id of a thing to play or of a device: a video id, a URI ("spotify:track:…"), a Connect device id. */
export const MEDIA_REF = /^[A-Za-z0-9_.:-]{1,128}$/
/** What kind of thing a `ref` is ("track", "album", "video"): a slug. */
export const MEDIA_KIND = /^[a-z][a-z0-9_-]{0,23}$/
/** A title, a name, a subtitle. */
export const MAX_MEDIA_TEXT_CHARS = 200
/** An address (`https:` only, printable ASCII without quotes, backslashes or spaces). */
export const MEDIA_URL = /^https:\/\/[\x21\x23-\x5b\x5d-\x7e]+$/
export const MAX_MEDIA_URL_CHARS = 2_000
/** A short-lived access token: printable ASCII without spaces. Never logged (docs/ARCHITECTURE.md `DevicePlayers`). */
export const MEDIA_CREDENTIAL_TOKEN = /^[\x21-\x7e]+$/
export const MAX_MEDIA_TOKEN_CHARS = 2_048
/** An error code the page reports: a slug. */
export const MEDIA_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,39}$/
/** A position, a duration, a seek: at most this many milliseconds (48 hours). */
export const MAX_MEDIA_MS = 172_800_000
/** A player's `config` (a Spotify player name, say): at most this many entries, a key of this form, a text value of at most this many characters. */
export const MAX_MEDIA_CONFIG_ENTRIES = 8
export const MEDIA_CONFIG_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
export const MAX_MEDIA_CONFIG_TEXT_CHARS = 100
/** Wishes (`media.state.wants`) at most. */
export const MAX_MEDIA_WANTS = 8
/** `seq` and `ack`: unsigned 32-bit. */
export const MAX_MEDIA_SEQ = 0xffff_ffff
/** Reports the server accepts per connection: a burst, refilled at this rate per second (the rest are dropped, the latest state wins on the next). */
export const MEDIA_STATE_BURST = 10
export const MEDIA_STATE_PER_SECOND = 10

// -- Pieces -------------------------------------------------------------------------------------------------------------

export const MediaSource = Schema.String.check(Schema.isPattern(MEDIA_SOURCE))
export type MediaSource = typeof MediaSource.Type

const Text = Schema.String.check(Schema.isMaxLength(MAX_MEDIA_TEXT_CHARS))
const Url = Schema.String.check(Schema.isMaxLength(MAX_MEDIA_URL_CHARS), Schema.isPattern(MEDIA_URL))
const Ref = Schema.String.check(Schema.isPattern(MEDIA_REF))
const Kind = Schema.String.check(Schema.isPattern(MEDIA_KIND))
const ErrorCode = Schema.String.check(Schema.isPattern(MEDIA_ERROR_CODE))
const Ms = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_MEDIA_MS }))
const Level = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Seq = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_MEDIA_SEQ }))

/** A player's settings: strings, numbers and booleans under short keys; at most `MAX_MEDIA_CONFIG_ENTRIES`. */
export const MediaConfig = Schema.Record(
  Schema.String.check(Schema.isPattern(MEDIA_CONFIG_KEY)),
  Schema.Union([Schema.String.check(Schema.isMaxLength(MAX_MEDIA_CONFIG_TEXT_CHARS)), Schema.Finite, Schema.Boolean])
).check(Schema.makeFilter((r: Readonly<Record<string, unknown>>) => Object.keys(r).length <= MAX_MEDIA_CONFIG_ENTRIES || `at most ${MAX_MEDIA_CONFIG_ENTRIES} entries`))
export type MediaConfig = typeof MediaConfig.Type

/** While the assistant listens and speaks: `lower` the sound, `pause` it, or `none`. `level` is the lowered level (0 to 1). */
export const MediaTalk = Schema.Struct({ mode: Schema.Literals(["lower", "pause", "none"]), level: Level })
export type MediaTalk = typeof MediaTalk.Type

// -- Commands (server → page) -------------------------------------------------------------------------------------------

/** One command to a page's player. */
export const MediaCommand = Schema.Union([
  /** Load these players now so they are ready. */
  Schema.Struct({
    type: Schema.Literal("prepare"),
    sources: Schema.Array(Schema.Struct({ source: MediaSource, config: Schema.optionalKey(MediaConfig) })).check(Schema.isMaxLength(MAX_MEDIA_PLAYERS))
  }),
  /** A short-lived access token for the page's player of `source`; `expiresAtMs` is epoch milliseconds (the server's clock). */
  Schema.Struct({
    type: Schema.Literal("credential"),
    source: MediaSource,
    token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_MEDIA_TOKEN_CHARS), Schema.isPattern(MEDIA_CREDENTIAL_TOKEN)),
    expiresAtMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  }),
  /**
   * Show the player surface for `source`. With `ref` the page starts that thing; without it the surface opens and the
   * server starts playback another way. `talk`: what the page does while the assistant listens and speaks.
   */
  Schema.Struct({
    type: Schema.Literal("open"),
    source: MediaSource,
    ref: Schema.optionalKey(Ref),
    kind: Schema.optionalKey(Kind),
    title: Schema.optionalKey(Text),
    subtitle: Schema.optionalKey(Text),
    artUrl: Schema.optionalKey(Url),
    link: Schema.optionalKey(Url),
    startAtMs: Schema.optionalKey(Ms),
    autoplay: Schema.Boolean,
    talk: MediaTalk
  }),
  Schema.Struct({ type: Schema.Literal("play") }),
  Schema.Struct({ type: Schema.Literal("pause") }),
  Schema.Struct({ type: Schema.Literal("next") }),
  Schema.Struct({ type: Schema.Literal("previous") }),
  Schema.Struct({ type: Schema.Literal("seek"), toMs: Ms }),
  Schema.Struct({ type: Schema.Literal("seek"), byMs: Schema.Finite.check(Schema.isBetween({ minimum: -MAX_MEDIA_MS, maximum: MAX_MEDIA_MS })) }),
  Schema.Struct({ type: Schema.Literal("volume"), level: Level }),
  Schema.Struct({ type: Schema.Literal("close") })
])
export type MediaCommand = typeof MediaCommand.Type
export type MediaCommandType = MediaCommand["type"]

/** Server → one voice connection that declared players: one command. */
export const MediaCommandMessage = Schema.Struct({
  type: Schema.Literal("media.command"),
  /** Per connection, rising; the page echoes the highest it has handled in `media.state.ack`. */
  seq: Seq,
  command: MediaCommand
})
export type MediaCommandMessage = typeof MediaCommandMessage.Type

// -- State (page → server) ----------------------------------------------------------------------------------------------

export const MediaPlayerState = Schema.Struct({
  source: MediaSource,
  ready: Schema.Boolean,
  /** The provider's id for this page as a playback device (a Spotify Connect device id). */
  playerId: Schema.optionalKey(Ref),
  /** Why it is not ready or failed (a slug the page chose: "unsupported", "initialization_error", "account_error"). */
  error: Schema.optionalKey(ErrorCode)
})
export type MediaPlayerState = typeof MediaPlayerState.Type

export const MEDIA_STATUSES = ["loading", "playing", "paused", "ended", "blocked", "error"] as const
export type MediaStatus = (typeof MEDIA_STATUSES)[number]

export const MediaCurrent = Schema.Struct({
  source: MediaSource,
  status: Schema.Literals(MEDIA_STATUSES),
  title: Schema.optionalKey(Text),
  artist: Schema.optionalKey(Text),
  album: Schema.optionalKey(Text),
  artUrl: Schema.optionalKey(Url),
  link: Schema.optionalKey(Url),
  ref: Schema.optionalKey(Ref),
  durationMs: Schema.optionalKey(Ms),
  positionMs: Schema.optionalKey(Ms),
  volume: Schema.optionalKey(Level),
  canNext: Schema.optionalKey(Schema.Boolean),
  canPrevious: Schema.optionalKey(Schema.Boolean),
  errorCode: Schema.optionalKey(ErrorCode),
  /** The page itself paused this for the talk rule ("pause while talking") and will resume it after the talk: a "stop" must still reach it. */
  held: Schema.optionalKey(Schema.Boolean)
})
export type MediaCurrent = typeof MediaCurrent.Type

export const MediaState = Schema.Struct({
  players: Schema.Array(MediaPlayerState).check(Schema.isMaxLength(MAX_MEDIA_PLAYERS)),
  /** What is open; absent: nothing. */
  current: Schema.optionalKey(MediaCurrent),
  /** The page is visible. Only when `device.caps.live` does not already say (a page that sends that need not send this). */
  visible: Schema.optionalKey(Schema.Boolean)
})
export type MediaState = typeof MediaState.Type

/** Something the page asks the server for: a fresh credential for `source` (its token ran out or is about to). */
export const MediaWant = Schema.Struct({ source: MediaSource, what: Schema.Literal("credential") })
export type MediaWant = typeof MediaWant.Type

/** Voice page → server, no answer: the player's state. */
export const MediaStateMessage = Schema.Struct({
  type: Schema.Literal("media.state"),
  state: MediaState,
  /** The highest `seq` of a `media.command` the page has handled (applied or refused) by the time of this state. */
  ack: Schema.optionalKey(Seq),
  wants: Schema.optionalKey(Schema.Array(MediaWant).check(Schema.isMaxLength(MAX_MEDIA_WANTS)))
})
export type MediaStateMessage = typeof MediaStateMessage.Type
