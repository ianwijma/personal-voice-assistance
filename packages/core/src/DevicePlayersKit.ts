import type { MediaCommand, MediaCommandMessage, MediaCurrent, MediaPlayerState, MediaState, MediaWant } from "@pva/protocol"
import { Effect } from "effect"
import type { DevicePlayerState, DevicePlayersEngine, PlayerLink, ReportOutcome } from "./DevicePlayers.ts"
import { type ConnectionRef, makeConnectionRef } from "./TurnContext.ts"

/**
 * The test kit's fake page players (`kit.players`; docs/MODULES.md "Testing a module that plays on a device"): scriptable
 * pages that answer `DevicePlayers` the way a real voice page does. The service under them is the real one
 * (`makeDevicePlayers`: its connection choice, acknowledgement, `awaitStatus`, time-outs, rate limit and text cleaning),
 * so what a module's test sees is what serve mode does; only the page is played by hand.
 */

/** What a page changes in its own reported state (`media.state.state`); `current: null` closes what is open. */
export interface KitPageState {
  readonly players?: ReadonlyArray<MediaPlayerState>
  readonly current?: MediaCurrent | null
  readonly visible?: boolean
}

/** What a responder answers to one command: the state it changes (default: none), and whether it acknowledges (default: yes). */
export interface KitPageReply {
  readonly state?: KitPageState
  readonly ack?: boolean
  readonly wants?: ReadonlyArray<MediaWant>
}

/** Options of the working-player model (`respond("play")`). */
export interface KitPlayerModel {
  /** `open` with `autoplay` reports `blocked`, as a browser that refuses unmuted autoplay does. */
  readonly autoplayBlocked?: boolean
  /** `open` fails: its status is `error` with this code. */
  readonly openError?: string
  /** The duration it reports for what it opens (default 180 000 ms). */
  readonly durationMs?: number
  /** The level it starts at (default 0.5). */
  readonly volume?: number
}

export interface KitPlayerPage {
  readonly deviceId: string
  /** The page's connection (the first page of a device has the connection the kit's turns carry). */
  readonly connection: ConnectionRef
  /** The sources it declared. */
  readonly sources: ReadonlyArray<string>
  /** Every `media.command` the page was sent, in order, with its number. A `credential` carries its token: it is the page. */
  readonly received: ReadonlyArray<MediaCommandMessage>
  /** Just the commands of `received`. */
  readonly commands: () => ReadonlyArray<MediaCommand>
  /** What the page holds now (what its next report says). */
  readonly state: () => { readonly players: ReadonlyArray<MediaPlayerState>; readonly current: MediaCurrent | undefined; readonly visible: boolean | undefined }
  /**
   * Report as the page (`media.state`). `patch` changes the page's own state first (`current: null` closes). `ack`
   * defaults to the highest number received so far (every command so far is handled); `false`: none; a number: that
   * one. `raw`: send exactly this message instead (to test what the server drops). Answers what the service did with it.
   */
  readonly report: (patch?: KitPageState, options?: { readonly ack?: number | false; readonly wants?: ReadonlyArray<MediaWant>; readonly raw?: unknown }) => Effect.Effect<ReportOutcome>
  /**
   * Answer every command from now on, at the moment it arrives: `"play"` is a working player (see `KitPlayerModel`),
   * `"ack"` acknowledges and changes nothing, a function decides per command (`undefined`: no answer at all, so the
   * caller times out), `false` stops answering (the default: the page answers nothing until the test reports).
   */
  readonly respond: (how: false | "ack" | "play" | ((message: MediaCommandMessage, page: KitPlayerPage) => KitPageReply | undefined), model?: KitPlayerModel) => void
  /** The page goes (its tab closed or the socket dropped): its state goes and what waited for it fails. */
  readonly close: Effect.Effect<void>
}

export interface KitPlayerPages {
  /**
   * A page of a device declares these sources (and is connected; the device's first page uses the connection the kit's
   * turns carry, another page of the same device is a second tab). Default device: the household's first.
   */
  readonly page: (sources: ReadonlyArray<string>, as?: { readonly device?: string }) => Effect.Effect<KitPlayerPage>
  /** Every page ever made, in order (closed ones too). */
  readonly pages: () => ReadonlyArray<KitPlayerPage>
  /** Every command sent to any page, in order. */
  readonly sent: ReadonlyArray<{ readonly deviceId: string; readonly connection: ConnectionRef; readonly message: MediaCommandMessage }>
  /** A device's pages go (its page disconnected; the kit's `notify.disconnect` does the same). */
  readonly closeDevice: (deviceId: string) => Effect.Effect<void>
}

interface Inner {
  readonly page: KitPlayerPage
  readonly link: PlayerLink
  closed: boolean
}

export const makeKitPlayerPages = (input: {
  readonly engine: DevicePlayersEngine
  /** The device has a page connected now (the kit's household). */
  readonly connected: (deviceId: string) => boolean
  /** The connection of the device's first page. */
  readonly connectionOf: (deviceId: string) => ConnectionRef
  readonly firstDevice: string
  /** Lets what a report resolved run (the kit's `settle`). */
  readonly settle: Effect.Effect<void>
}): {
  readonly api: KitPlayerPages
  readonly connections: (deviceId: string) => ReadonlyArray<PlayerLink>
  /** The same as `api.closeDevice`, synchronously (the kit's `notify.disconnect` calls it). */
  readonly closeDeviceNow: (deviceId: string) => void
} => {
  const inners: Array<Inner> = []
  const sent: Array<{ readonly deviceId: string; readonly connection: ConnectionRef; readonly message: MediaCommandMessage }> = []
  let tabs = 0

  const make = (sources: ReadonlyArray<string>, deviceId: string): KitPlayerPage => {
    const first = !inners.some((i) => i.page.deviceId === deviceId && !i.closed && i.page.connection.id === input.connectionOf(deviceId).id)
    const connection = first ? input.connectionOf(deviceId) : makeConnectionRef(`kit-page-${++tabs}-${deviceId}`)
    const received: Array<MediaCommandMessage> = []
    let players: ReadonlyArray<MediaPlayerState> = sources.map((source) => ({ source, ready: true, playerId: `${deviceId}-${source}` }))
    let current: MediaCurrent | undefined
    let visible: boolean | undefined
    let responder: ((message: MediaCommandMessage, page: KitPlayerPage) => KitPageReply | undefined) | undefined
    let highest = 0

    const apply = (patch: KitPageState | undefined) => {
      if (patch === undefined) return
      if (patch.players !== undefined) players = patch.players
      if (patch.current !== undefined) current = patch.current === null ? undefined : patch.current
      if (patch.visible !== undefined) visible = patch.visible
    }
    const message = (ack: number | false | undefined, wants: ReadonlyArray<MediaWant> | undefined) => ({
      type: "media.state" as const,
      state: { players, ...(current !== undefined ? { current } : {}), ...(visible !== undefined ? { visible } : {}) } satisfies MediaState,
      ...(ack === false ? {} : { ack: ack ?? highest }),
      ...(wants !== undefined ? { wants } : {})
    })
    const reportNow = (patch: KitPageState | undefined, options: { readonly ack?: number | false; readonly wants?: ReadonlyArray<MediaWant>; readonly raw?: unknown } = {}): ReportOutcome => {
      apply(patch)
      return input.engine.report(connection.id, deviceId, options.raw !== undefined ? options.raw : message(options.ack, options.wants))
    }

    const link: PlayerLink = {
      id: connection.id,
      sources: () => sources,
      send: (m) => {
        received.push(m)
        sent.push({ deviceId, connection, message: m })
        highest = Math.max(highest, m.seq)
        // The reply is made in the page's own turn of the loop, after the service has recorded the command as waiting.
        if (responder !== undefined) {
          const reply = responder(m, page)
          if (reply !== undefined) reportNow(reply.state, { ack: reply.ack === false ? false : m.seq, ...(reply.wants !== undefined ? { wants: reply.wants } : {}) })
        }
      }
    }

    const page: KitPlayerPage = {
      deviceId,
      connection,
      sources,
      received,
      commands: () => received.map((m) => m.command),
      state: () => ({ players, current, visible }),
      report: (patch, options) => Effect.andThen(Effect.sync(() => reportNow(patch, options)), (outcome) => Effect.as(input.settle, outcome)),
      respond: (how, model = {}) => {
        responder = how === false ? undefined : how === "ack" ? () => ({}) : how === "play" ? workingPlayer(model, () => current, deviceId) : how
      },
      close: Effect.suspend(() => {
        const inner = inners.find((i) => i.page === page)
        if (inner === undefined || inner.closed) return Effect.void
        inner.closed = true
        input.engine.closed(connection.id, deviceId)
        return input.settle
      })
    }
    inners.push({ page, link, closed: false })
    return page
  }

  const closeDeviceNow = (deviceId: string) => {
    for (const i of inners) {
      if (i.page.deviceId !== deviceId || i.closed) continue
      i.closed = true
      input.engine.closed(i.page.connection.id, deviceId)
    }
  }

  const api: KitPlayerPages = {
    page: (sources, as = {}) =>
      Effect.suspend(() => {
        const deviceId = as.device ?? input.firstDevice
        const page = make(sources, deviceId)
        input.engine.refresh(deviceId)
        return Effect.as(input.settle, page)
      }),
    pages: () => inners.map((i) => i.page),
    sent,
    closeDevice: (deviceId) => Effect.andThen(Effect.sync(() => closeDeviceNow(deviceId)), input.settle)
  }
  return {
    api,
    closeDeviceNow,
    connections: (deviceId) => (input.connected(deviceId) ? inners.filter((i) => i.page.deviceId === deviceId && !i.closed).map((i) => i.link) : [])
  }
}

/** A working player: it opens, plays, pauses, seeks and changes volume the way a real page would report it. */
const workingPlayer = (model: KitPlayerModel, current: () => MediaCurrent | undefined, deviceId: string) =>
  (m: MediaCommandMessage): KitPageReply => {
    const c = m.command
    const now = current()
    const patch = (next: Partial<MediaCurrent>): KitPageReply =>
      now === undefined ? {} : { state: { current: { ...now, ...next } } }
    switch (c.type) {
      case "open": {
        const status = model.openError !== undefined ? "error" as const : c.autoplay ? (model.autoplayBlocked === true ? "blocked" as const : "playing" as const) : "paused" as const
        return {
          state: {
            current: {
              source: c.source,
              status,
              ...(c.title !== undefined ? { title: c.title } : {}),
              ...(c.subtitle !== undefined ? { artist: c.subtitle } : {}),
              ...(c.artUrl !== undefined ? { artUrl: c.artUrl } : {}),
              ...(c.link !== undefined ? { link: c.link } : {}),
              ...(c.ref !== undefined ? { ref: c.ref } : {}),
              durationMs: model.durationMs ?? 180_000,
              positionMs: c.startAtMs ?? 0,
              volume: model.volume ?? 0.5,
              canNext: true,
              canPrevious: true,
              ...(model.openError !== undefined ? { errorCode: model.openError } : {})
            }
          }
        }
      }
      case "play":
        return patch({ status: "playing" })
      case "pause":
        return patch({ status: "paused" })
      case "next":
      case "previous":
        return patch({ positionMs: 0 })
      case "seek": {
        const duration = now?.durationMs ?? model.durationMs ?? 180_000
        const to = "toMs" in c ? c.toMs : (now?.positionMs ?? 0) + c.byMs
        return patch({ positionMs: Math.min(duration, Math.max(0, to)) })
      }
      case "volume":
        return patch({ volume: c.level })
      case "close":
        return { state: { current: null } }
      case "prepare":
        return { state: { players: c.sources.map((s) => ({ source: s.source, ready: true, playerId: `${deviceId}-${s.source}` })) } }
      case "credential":
        return {}
    }
  }
