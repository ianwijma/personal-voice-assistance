import {
  MAX_MEDIA_TEXT_CHARS,
  MEDIA_STATE_BURST,
  MEDIA_STATE_PER_SECOND,
  MediaCommand,
  type MediaCommandMessage,
  type MediaCurrent,
  type MediaPlayerState,
  type MediaState,
  MediaStateMessage,
  type MediaStatus,
  type MediaWant
} from "@pva/protocol"
import { Clock, Data, Deferred, Effect, type Scope, PubSub, Schema, Stream } from "effect"
import { ServiceKey } from "./ModuleApi.ts"
import { type ConnectionRef, makeConnectionRef } from "./TurnContext.ts"

/**
 * `DevicePlayers`: a module's way to the player in a device's web page, and the page's way back (docs/modules/media.md
 * §4.1; docs/ARCHITECTURE.md). Provided by the core in serve mode through `host.service(DevicePlayers)`, like `Devices`.
 * Core knows no provider: a `source` is an opaque slug ("spotify", "youtube") end to end, and a page that does not know
 * one says so.
 *
 * - **Commands** (`send`): one `media.command` to one page, numbered per connection (`seq`, assigned here). The call waits
 *   for the first state report that acknowledges it (`ack >= seq`), within `DEVICE_PLAYER_LIMITS.ackTimeoutMs` unless the
 *   caller asks for another time; with `awaitStatus` it then keeps waiting (inside the same time) until the page's
 *   `current.status` is one of those, or `error` or `blocked`. Nothing is queued here: a command is sent at once, and
 *   the connection's own send buffer is the only queue.
 * - **State** (`state`, `changes`, `isPlaying`): what the device's player page last reported. Memory only; nothing is kept
 *   on disk.
 *
 * **Which page.** A device can have several connections (tabs). The one that counts, for `send` and for the device's
 * `state`, is, in this order:
 *
 * 1. the connection the caller names (`options.connection`; a module passes `CurrentTurn.connection`), if its page declared
 *    players (and the owner has not taken them away);
 * 2. else the connection that currently reports something open (`current`; the most recent report if several do);
 * 3. else the most recently connected one that declared players.
 *
 * A connection that declared no players is never chosen, and a device with none has no player (`no_player`). One state
 * per device: that of its chosen connection (`state(deviceId, connection)` and `send` apply the same rule, so a module
 * that passes its turn's connection to both reads and commands the same page). `isPlaying` is the exception: it is true
 * when any of the device's player pages plays.
 *
 * **Reports are untrusted.** `report` accepts one only from a voice page that declared players (the hub refuses admin pages
 * and voice nodes before it gets here), drops what does not fit the protocol's bounds, cleans every text the way texts
 * from outside are cleaned (`cleanPlayerText`: control, format and line-break characters become spaces, then clipped),
 * and limits each connection to `DEVICE_PLAYER_LIMITS.stateBurst` reports at once and `statePerSecond` after that. A
 * report over the limit is not lost: the latest one waits and is applied when the connection's allowance is back.
 *
 * **Credentials.** A `credential` command carries a short-lived access token. It is sent and forgotten: it is never put
 * in a state, an error, a log line or a change event, and no message here quotes a command.
 */

export const DEVICE_PLAYER_LIMITS = {
  /** How long `send` waits for the page's acknowledgement when the caller says nothing. */
  ackTimeoutMs: 3_000,
  /** The longest a caller may ask `send` to wait. */
  maxTimeoutMs: 60_000,
  /** Commands waiting for an acknowledgement per connection at most (one more is `failed`). */
  pendingPerConnection: 16,
  /** A connection's reports: a burst of this many, then this many a second (`MEDIA_STATE_BURST`, `MEDIA_STATE_PER_SECOND`). */
  stateBurst: MEDIA_STATE_BURST,
  statePerSecond: MEDIA_STATE_PER_SECOND,
  /** A text a page reports is cut to this many characters. */
  textChars: MAX_MEDIA_TEXT_CHARS,
  /** A page that said `playing` this long ago and nothing since is not counted as playing (`isPlaying`). */
  playingFreshMs: 60_000,
  /** The longest device id accepted. */
  deviceIdChars: 64
} as const

/**
 * `no_player`: the device is unknown, not connected, or no page of it declared players (also: the page disconnected while
 * the command was waiting). `unsupported`: the page declared players but not this source. `timeout`: sent, not
 * acknowledged in time (it may still happen). `failed`: it could not be sent. `invalid`: the command or an option is not
 * valid (nothing was sent).
 */
export class DevicePlayerError extends Data.TaggedError("DevicePlayerError")<{
  readonly reason: "no_player" | "unsupported" | "timeout" | "failed" | "invalid"
  /** For the log and a developer; never a command's content. */
  readonly detail: string
}> {}

/** What a device's chosen player page last reported (one snapshot; a new one is made at every report). */
export interface DevicePlayerState {
  /** The page this state is of. */
  readonly connection: ConnectionRef
  /** The sources the page declared (minus what the owner took away). */
  readonly sources: ReadonlyArray<string>
  /** Its players, as reported (empty before the first report). */
  readonly players: ReadonlyArray<MediaPlayerState>
  /** What is open, as reported; absent: nothing (or no report yet). */
  readonly current?: MediaCurrent
  /** The page said whether it is visible (`media.state.visible`). */
  readonly visible?: boolean
  /** The highest command number the page has acknowledged. */
  readonly ack: number
  /** Epoch ms of the last accepted report; `undefined` before the first. */
  readonly reportedAt: number | undefined
}

/** One change a module may follow: a report that changed the device's state, a page that came or went, a wish. */
export interface DevicePlayerChange {
  readonly deviceId: string
  /** The connection that caused it. */
  readonly connection: ConnectionRef
  /** The device's state after the change; `undefined`: it has no player page any more. */
  readonly state: DevicePlayerState | undefined
  /** What the page asked for with this report (`credential`). Absent when it asked nothing. */
  readonly wants?: ReadonlyArray<MediaWant>
}

export interface DevicePlayerSendOptions {
  /** Wait at most this long (default `DEVICE_PLAYER_LIMITS.ackTimeoutMs`, at most `maxTimeoutMs`). */
  readonly timeoutMs?: number
  /** The page to use first (a turn's `CurrentTurn.connection`); see "Which page". */
  readonly connection?: ConnectionRef
  /** After the acknowledgement keep waiting until `current.status` is one of these, or `error` or `blocked`. */
  readonly awaitStatus?: ReadonlyArray<MediaStatus>
}

export interface DevicePlayersService {
  /**
   * The device's last reported state; `undefined` when no connected page of that device declared players. `connection`
   * (a turn's `CurrentTurn.connection`) names the page to read first, by the same rule `send` uses (see "Which page"), so
   * a module reads the page it commands.
   */
  readonly state: (deviceId: string, connection?: ConnectionRef) => Effect.Effect<DevicePlayerState | undefined>
  /**
   * Sends one command to the device's player page and waits for the first report that acknowledges it (see the top of
   * this file). Answers the page's state at that report.
   */
  readonly send: (deviceId: string, command: MediaCommand, options?: DevicePlayerSendOptions) => Effect.Effect<DevicePlayerState, DevicePlayerError>
  /** Every accepted report that changed a device's state, and a player page arriving or going (`state` undefined on the last one's disconnect). */
  readonly changes: Stream.Stream<DevicePlayerChange>
  /**
   * Whether any player page of the device is playing now: that page's state says `playing` and was reported within
   * `DEVICE_PLAYER_LIMITS.playingFreshMs`. Device-wide on purpose (the route gate's guard): a second tab that plays
   * guards the device even when another tab is the one `state` would choose. Synchronous and cheap (map reads): the
   * route gate may ask on a turn's path.
   */
  readonly isPlaying: (deviceId: string) => boolean
}

/** `host.service(DevicePlayers)`: provided by the core in serve mode. */
export const DevicePlayers = ServiceKey<DevicePlayersService>("core.device-players")

// ---------------------------------------------------------------------------------------------------------------------
// Texts from a page

// Control, format (zero-width, bidirectional overrides and isolates), line and paragraph separators.
// A surrogate half with no partner (JSON can carry one; it would not survive being encoded as UTF-8).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * A text a page reported, as the rest of the server cleans texts from outside (`oneLine`, `plainName`): well-formed
 * UTF-16 (a lone surrogate becomes U+FFFD), control, format and direction characters and line breaks replaced by a space, spaces collapsed, clipped to
 * `max` characters (code points) with "…". Quotes and brackets stay (a title may have them); the text is data, never
 * markup or instructions. `undefined` when nothing is left.
 */
export const cleanPlayerText = (text: unknown, max: number = MAX_MEDIA_TEXT_CHARS): string | undefined => {
  if (typeof text !== "string") return undefined
  const flat = text.replace(LONE_SURROGATE, "\ufffd").replace(INVISIBLE, " ").replace(/\s+/gu, " ").trim()
  const chars = [...flat]
  const out = chars.length <= max ? flat : `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`
  return out === "" ? undefined : out
}

const cleanCurrent = (c: MediaCurrent): MediaCurrent => {
  const title = cleanPlayerText(c.title)
  const artist = cleanPlayerText(c.artist)
  const album = cleanPlayerText(c.album)
  return {
    source: c.source,
    status: c.status,
    ...(title !== undefined ? { title } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(album !== undefined ? { album } : {}),
    ...(c.artUrl !== undefined ? { artUrl: c.artUrl } : {}),
    ...(c.link !== undefined ? { link: c.link } : {}),
    ...(c.ref !== undefined ? { ref: c.ref } : {}),
    ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
    ...(c.positionMs !== undefined ? { positionMs: c.positionMs } : {}),
    ...(c.volume !== undefined ? { volume: c.volume } : {}),
    ...(c.canNext !== undefined ? { canNext: c.canNext } : {}),
    ...(c.canPrevious !== undefined ? { canPrevious: c.canPrevious } : {}),
    ...(c.errorCode !== undefined ? { errorCode: c.errorCode } : {}),
    ...(c.held === true ? { held: true } : {})
  }
}

const cleanPlayer = (p: MediaPlayerState): MediaPlayerState => ({
  source: p.source,
  ready: p.ready,
  ...(p.playerId !== undefined ? { playerId: p.playerId } : {}),
  ...(p.error !== undefined ? { error: p.error } : {})
})

// ---------------------------------------------------------------------------------------------------------------------
// The service

/** A page's connection as the service sees it: how to send to it, and what it may play now. */
export interface PlayerLink {
  /** The connection's id (`ConnectionRef.id`). */
  readonly id: string
  readonly send: (message: MediaCommandMessage) => void
  /** The sources it declared and the owner has not taken away; empty: it declared none. Read at every use. */
  readonly sources: () => ReadonlyArray<string>
}

export interface DevicePlayersOptions {
  /** The device's voice-page connections, oldest first (the order they connected in). Voice nodes and admin pages are not among them. */
  readonly connections: (deviceId: string) => ReadonlyArray<PlayerLink>
  /** One line for the log; never carries a command, a token or a page's text. */
  readonly log?: (line: string) => void
}

/** What `report` did with a message. */
export type ReportOutcome = "accepted" | "limited" | "invalid" | "refused"

export interface DevicePlayersEngine {
  readonly service: DevicePlayersService
  /**
   * A `media.state` from a connection of `deviceId` (the hub has refused admin pages and voice nodes already). `raw`
   * is validated against the protocol here. `refused`: the connection is not a page of that device that declared
   * players. `limited`: over the connection's rate; the latest such report is kept and applied later.
   */
  readonly report: (connectionId: string, deviceId: string, raw: unknown) => ReportOutcome
  /** The device's connections or what they declared may have changed (a hello, `device.caps`): followers of `changes` hear of a new or lost player page. */
  readonly refresh: (deviceId: string) => void
  /** A connection closed: its state goes, its waiting commands fail `no_player`. */
  readonly closed: (connectionId: string, deviceId: string | undefined) => void
}

interface Waiter {
  readonly seq: number
  readonly statuses: ReadonlyArray<MediaStatus> | undefined
  readonly done: Deferred.Deferred<DevicePlayerState, DevicePlayerError>
}

interface Held {
  state: MediaState
  ack: number | undefined
  wants: ReadonlyArray<MediaWant> | undefined
}

interface Conn {
  readonly id: string
  deviceId: string
  seq: number
  ack: number
  players: ReadonlyArray<MediaPlayerState>
  current: MediaCurrent | undefined
  visible: boolean | undefined
  reportedAt: number | undefined
  tokens: number
  refilledAt: number
  held: Held | undefined
  timer: { readonly cancel: () => void } | undefined
  readonly waiters: Set<Waiter>
}

const isReport = Schema.is(MediaStateMessage)
const isCommand = Schema.is(MediaCommand)

/**
 * Made in a scope: the timers that apply a limited connection's held report are fibres of it, on the Effect clock (so a
 * test clock drives them, and so it reads the time).
 */
export const makeDevicePlayers = (options: DevicePlayersOptions): Effect.Effect<DevicePlayersEngine, never, Scope.Scope> =>
  Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    const effectClock = yield* Clock.Clock
    const clock = () => effectClock.currentTimeMillisUnsafe()
    const timers = new Set<{ readonly interruptUnsafe: () => void }>()
    yield* Effect.addFinalizer(() => Effect.sync(() => void [...timers].forEach((t) => t.interruptUnsafe())))
    const later = (ms: number, run: () => void) => {
      const box: { fiber?: { readonly interruptUnsafe: () => void } } = {}
      const fiber = Effect.runForkWith(context)(Effect.andThen(Effect.sleep(ms), Effect.sync(() => {
        if (box.fiber !== undefined) timers.delete(box.fiber)
        run()
      })))
      box.fiber = fiber
      timers.add(fiber)
      return { cancel: () => (timers.delete(fiber), fiber.interruptUnsafe()) }
    }
    const log = options.log ?? (() => undefined)
    const pubsub = yield* PubSub.sliding<DevicePlayerChange>(64)
    const conns = new Map<string, Conn>()
    /** What was last published per device: the chosen connection and its sources, to publish a page arriving or going once. */
    const published = new Map<string, string>()
    const lastLimitLog = new Map<string, number>()

    const connOf = (id: string, deviceId: string): Conn => {
      let c = conns.get(id)
      if (c === undefined) {
        c = {
          id,
          deviceId,
          seq: 0,
          ack: 0,
          players: [],
          current: undefined,
          visible: undefined,
          reportedAt: undefined,
          tokens: DEVICE_PLAYER_LIMITS.stateBurst,
          refilledAt: clock(),
          held: undefined,
          timer: undefined,
          waiters: new Set()
        }
        conns.set(id, c)
      }
      return c
    }

    const linksOf = (deviceId: string): ReadonlyArray<PlayerLink> => {
      if (deviceId === "" || deviceId.length > DEVICE_PLAYER_LIMITS.deviceIdChars) return []
      try {
        return options.connections(deviceId).filter((l) => l.sources().length > 0)
      } catch {
        return []
      }
    }

    /** "Which page" (see the top of the file). */
    const choose = (deviceId: string, preferred?: ConnectionRef): PlayerLink | undefined => {
      const links = linksOf(deviceId)
      if (links.length === 0) return undefined
      if (preferred !== undefined) {
        const own = links.find((l) => l.id === preferred.id)
        if (own !== undefined) return own
      }
      let open: PlayerLink | undefined
      let openAt = -Infinity
      for (const l of links) {
        const c = conns.get(l.id)
        if (c?.current !== undefined && (c.reportedAt ?? 0) >= openAt) {
          open = l
          openAt = c.reportedAt ?? 0
        }
      }
      return open ?? links[links.length - 1]
    }

    const stateOf = (link: PlayerLink): DevicePlayerState => {
      const c = conns.get(link.id)
      return {
        connection: makeConnectionRef(link.id),
        sources: [...link.sources()],
        players: c?.players ?? [],
        ...(c?.current !== undefined ? { current: c.current } : {}),
        ...(c?.visible !== undefined ? { visible: c.visible } : {}),
        ack: c?.ack ?? 0,
        reportedAt: c?.reportedAt
      }
    }

    const stateOfDevice = (deviceId: string, preferred?: ConnectionRef): DevicePlayerState | undefined => {
      const link = choose(deviceId, preferred)
      return link === undefined ? undefined : stateOf(link)
    }

    const publish = (change: DevicePlayerChange) => {
      PubSub.publishUnsafe(pubsub, change)
    }

    /** Resolve what a report has answered. */
    const settle = (c: Conn, link: PlayerLink | undefined) => {
      if (c.waiters.size === 0) return
      const state = link === undefined ? undefined : stateOf(link)
      if (state === undefined) return
      for (const w of [...c.waiters]) {
        if (c.ack < w.seq) continue
        if (w.statuses !== undefined) {
          const status = c.current?.status
          if (status === undefined || !(w.statuses.includes(status) || status === "error" || status === "blocked")) continue
        }
        c.waiters.delete(w)
        Deferred.doneUnsafe(w.done, Effect.succeed(state))
      }
    }

    const apply = (c: Conn, deviceId: string, message: Held) => {
      const before = choose(deviceId)?.id
      const beforeState = JSON.stringify([c.players, c.current, c.visible])
      c.players = message.state.players.map(cleanPlayer)
      c.current = message.state.current === undefined ? undefined : cleanCurrent(message.state.current)
      if (message.state.visible !== undefined) c.visible = message.state.visible
      if (message.ack !== undefined && message.ack > c.ack) c.ack = Math.min(message.ack, c.seq)
      c.reportedAt = clock()
      const links = linksOf(deviceId)
      const link = links.find((l) => l.id === c.id)
      settle(c, link)
      const after = choose(deviceId)
      const wants = message.wants !== undefined && message.wants.length > 0 ? message.wants : undefined
      const changed = JSON.stringify([c.players, c.current, c.visible]) !== beforeState
      if (after !== undefined && (wants !== undefined || (changed && after.id === c.id) || before !== after.id)) {
        publish({ deviceId, connection: makeConnectionRef(c.id), state: stateOf(after), ...(wants !== undefined ? { wants } : {}) })
        published.set(deviceId, signature(after))
      }
    }

    const signature = (link: PlayerLink) => `${link.id}|${link.sources().join(",")}`

    const refill = (c: Conn) => {
      const now = clock()
      const elapsed = Math.max(0, now - c.refilledAt)
      c.refilledAt = now
      c.tokens = Math.min(DEVICE_PLAYER_LIMITS.stateBurst, c.tokens + (elapsed * DEVICE_PLAYER_LIMITS.statePerSecond) / 1000)
    }

    const flush = (c: Conn) => {
      c.timer = undefined
      const held = c.held
      c.held = undefined
      if (held === undefined || conns.get(c.id) !== c) return
      refill(c)
      if (c.tokens < 1) return limit(c, held)
      c.tokens -= 1
      apply(c, c.deviceId, held)
    }

    /** Keep the latest report of an over-limit connection (acknowledgements and wishes of the ones it replaces are kept) and apply it when a token is back. */
    const limit = (c: Conn, message: Held) => {
      const previous = c.held
      const acks = [previous?.ack, message.ack].filter((a): a is number => a !== undefined)
      c.held = {
        state: message.state,
        ack: acks.length === 0 ? undefined : Math.max(...acks),
        wants: previous?.wants === undefined ? message.wants : [...previous.wants, ...(message.wants ?? [])].slice(0, 8)
      }
      if (c.timer === undefined) {
        const wait = Math.max(1, Math.ceil(((1 - c.tokens) * 1000) / DEVICE_PLAYER_LIMITS.statePerSecond))
        c.timer = later(wait, () => flush(c))
      }
      const now = clock()
      if (now - (lastLimitLog.get(c.id) ?? -Infinity) > 10_000) {
        lastLimitLog.set(c.id, now)
        log(`A player page is sending state reports faster than ${DEVICE_PLAYER_LIMITS.statePerSecond} a second; the latest is kept`)
      }
    }

    const report: DevicePlayersEngine["report"] = (connectionId, deviceId, raw) => {
      if (deviceId === "" || deviceId.length > DEVICE_PLAYER_LIMITS.deviceIdChars) return "refused"
      if (!linksOf(deviceId).some((l) => l.id === connectionId)) return "refused"
      if (!isReport(raw)) return "invalid"
      const message: Held = { state: raw.state, ack: raw.ack, wants: raw.wants }
      const c = connOf(connectionId, deviceId)
      c.deviceId = deviceId
      refill(c)
      if (c.tokens < 1 || c.held !== undefined) {
        limit(c, message)
        return "limited"
      }
      c.tokens -= 1
      apply(c, deviceId, message)
      return "accepted"
    }

    const refresh: DevicePlayersEngine["refresh"] = (deviceId) => {
      const link = choose(deviceId)
      const sig = link === undefined ? undefined : signature(link)
      const previous = published.get(deviceId)
      if (sig === previous) return
      if (sig === undefined) published.delete(deviceId)
      else published.set(deviceId, sig)
      // A page arrived or its declaration changed (the new chosen one is the cause), or the last page's players went.
      publish({
        deviceId,
        connection: makeConnectionRef(link?.id ?? previous!.split("|")[0]!),
        state: link === undefined ? undefined : stateOf(link)
      })
    }

    const closed: DevicePlayersEngine["closed"] = (connectionId, deviceId) => {
      const c = conns.get(connectionId)
      lastLimitLog.delete(connectionId)
      if (c !== undefined) {
        c.timer?.cancel()
        c.timer = undefined
        c.held = undefined
        conns.delete(connectionId)
        for (const w of c.waiters) Deferred.doneUnsafe(w.done, Effect.fail(new DevicePlayerError({ reason: "no_player", detail: "the page disconnected before it answered" })))
        c.waiters.clear()
      }
      const id = deviceId ?? c?.deviceId
      if (id === undefined) return
      const link = choose(id)
      const sig = link === undefined ? undefined : signature(link)
      if (sig === published.get(id) && c === undefined) return
      if (sig === undefined) published.delete(id)
      else published.set(id, sig)
      publish({ deviceId: id, connection: makeConnectionRef(connectionId), state: link === undefined ? undefined : stateOf(link) })
    }

    const send: DevicePlayersService["send"] = (deviceId, command, sendOptions = {}) =>
      Effect.suspend(() => {
        const invalid = (detail: string) => Effect.fail(new DevicePlayerError({ reason: "invalid", detail }))
        if (typeof deviceId !== "string" || deviceId === "" || deviceId.length > DEVICE_PLAYER_LIMITS.deviceIdChars) return invalid("deviceId: 1 to 64 characters")
        if (!isCommand(command)) return invalid("not a valid media command")
        const asked = sendOptions.timeoutMs
        if (asked !== undefined && (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0)) return invalid("timeoutMs: a positive number of milliseconds")
        const timeoutMs = Math.min(asked ?? DEVICE_PLAYER_LIMITS.ackTimeoutMs, DEVICE_PLAYER_LIMITS.maxTimeoutMs)
        const statuses = sendOptions.awaitStatus
        const link = choose(deviceId, sendOptions.connection)
        if (link === undefined) return Effect.fail(new DevicePlayerError({ reason: "no_player", detail: "no page of that device declared players" }))
        // Which sources the command is about; a transport command (play, pause, …) names none.
        const declared = new Set(link.sources())
        let sent: MediaCommand = command
        if (command.type === "prepare") {
          const sources = command.sources.filter((s) => declared.has(s.source))
          if (sources.length === 0 && command.sources.length > 0) return Effect.fail(new DevicePlayerError({ reason: "unsupported", detail: "the page has none of those players" }))
          sent = { ...command, sources }
        } else if ((command.type === "credential" || command.type === "open") && !declared.has(command.source)) {
          return Effect.fail(new DevicePlayerError({ reason: "unsupported", detail: `the page has no player for "${command.source}"` }))
        }
        const c = connOf(link.id, deviceId)
        if (c.waiters.size >= DEVICE_PLAYER_LIMITS.pendingPerConnection) {
          return Effect.fail(new DevicePlayerError({ reason: "failed", detail: "too many commands are waiting for the page" }))
        }
        const seq = ++c.seq
        const waiter: Waiter = { seq, statuses, done: Deferred.makeUnsafe<DevicePlayerState, DevicePlayerError>() }
        c.waiters.add(waiter)
        try {
          link.send({ type: "media.command", seq, command: sent })
        } catch {
          c.waiters.delete(waiter)
          return Effect.fail(new DevicePlayerError({ reason: "failed", detail: "the command could not be sent to the page" }))
        }
        return Deferred.await(waiter.done).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(new DevicePlayerError({ reason: "timeout", detail: "the page did not answer in time; the command may still happen" }))
          }),
          Effect.ensuring(Effect.sync(() => void c.waiters.delete(waiter)))
        )
      })

    const isPlaying = (deviceId: string): boolean => {
      const now = clock()
      return linksOf(deviceId).some((l) => {
        const c = conns.get(l.id)
        return c?.current?.status === "playing" && c.reportedAt !== undefined && now - c.reportedAt <= DEVICE_PLAYER_LIMITS.playingFreshMs
      })
    }

    const service: DevicePlayersService = {
      state: (deviceId, connection) => Effect.sync(() => stateOfDevice(deviceId, connection)),
      send,
      changes: Stream.fromPubSub(pubsub),
      isPlaying
    }
    return { service, report, refresh, closed }
  })
