import {
  cleanPlayerText,
  type ConnectionRef,
  type DevicePlayerChange,
  DevicePlayers,
  type DevicePlayersService,
  Devices,
  type ModuleHostApi,
  PLAYBACK_LIMITS,
  type PlaybackService,
  PlaybackError
} from "@pva/core"
import { WebVideos } from "@pva/module-contracts"
import { Effect, type Scope, Stream } from "effect"
import type { Spotify } from "./spotify/client.ts"

/**
 * The pages (docs/modules/media.md §7): what the module does when a device's player page appears, asks for a credential
 * or fails, and the `Playback` service the host's "stop" uses.
 *
 * - **A page appears** (`DevicePlayers.changes`): it is sent `prepare` with the sources it can play and the module can serve:
 *   `spotify` only while signed in (its `config.name` is the device's name, so the Connect device is called after the
 *   device), `youtube` while the web search offers `WebVideos`. A page is prepared once per connection and set of
 *   sources; a sign-in that changes (in, out, ended) prepares every known page again.
 * - **A page wants a credential** (`wants`): it is sent a fresh access token with a `credential` command, on the connection
 *   that asked. The token is never logged, kept or put in an error here.
 * - **A page reports a player error** (`initialization_error`, `account_error`): remembered per device for Health, until the
 *   page reports no error or leaves.
 */

/** A device whose page said its player cannot work, for Health. */
export interface PlayerProblem {
  readonly deviceId: string
  readonly name: string
  readonly error: string
}

export interface Pages {
  /** Prepare every known page again (the sign-in or the video search changed). */
  readonly prepareAll: Effect.Effect<void>
  /** Players that reported an error that needs the owner: no encrypted-media support, a Premium account missing. */
  readonly problems: () => ReadonlyArray<PlayerProblem>
}

const PROBLEM_ERRORS: ReadonlySet<string> = new Set(["initialization_error", "account_error"])

export const watchPages = (o: {
  readonly host: Pick<ModuleHostApi, "service" | "view">
  readonly spotify: Spotify
  readonly scope: Scope.Scope
  readonly now: () => number
}): Effect.Effect<Pages> =>
  Effect.gen(function*() {
    const svc = o.host.service(DevicePlayers)
    if (svc === undefined) return { prepareAll: Effect.void, problems: () => [] }

    const known = new Map<string, { readonly connection: ConnectionRef; readonly sources: ReadonlyArray<string> }>()
    /** What each page (connection) was last prepared with, and which device it belongs to; bounded, and a device's go when its last page does. */
    const prepared = new Map<string, { readonly deviceId: string; readonly key: string }>()
    const problems = new Map<string, PlayerProblem>()

    const nameOf = (deviceId: string): string => cleanPlayerText(o.host.service(Devices)?.get(deviceId)?.name, 100) ?? "Assistant"

    /** The sources this page can play and the module can serve now. */
    const sourcesFor = (declared: ReadonlyArray<string>): ReadonlyArray<"spotify" | "youtube"> => {
      const out: Array<"spotify" | "youtube"> = []
      if (declared.includes("spotify") && o.spotify.status().kind === "signed-in") out.push("spotify")
      if (declared.includes("youtube") && o.host.service(WebVideos) !== undefined) out.push("youtube")
      return out
    }

    const prepare = (svc: DevicePlayersService, deviceId: string, connection: ConnectionRef, declared: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        const sources = sourcesFor(declared)
        const name = nameOf(deviceId)
        const key = `${sources.join(",")}|${name}`
        if (prepared.get(connection.id)?.key === key) return
        prepared.delete(connection.id)
        prepared.set(connection.id, { deviceId, key })
        while (prepared.size > 256) prepared.delete(prepared.keys().next().value!)
        if (sources.length === 0) return
        yield* svc.send(deviceId, {
          type: "prepare",
          sources: sources.map((source) => (source === "spotify" ? { source, config: { name } } : { source }))
        }, { connection, timeoutMs: 3_000 }).pipe(Effect.ignore)
      })

    const credential = (svc: DevicePlayersService, deviceId: string, connection: ConnectionRef) =>
      Effect.gen(function*() {
        const got = yield* o.spotify.source.accessToken.pipe(Effect.result)
        if (got._tag === "Failure") {
          yield* Effect.logWarning(`Media: no Spotify token for the page of a device (${got.failure.reason})`)
          return
        }
        // The token goes to the page that asked, in this one command, and nowhere else.
        const sent = yield* svc.send(deviceId, { type: "credential", source: "spotify", token: got.success.token, expiresAtMs: got.success.expiresAtMs }, { connection, timeoutMs: 3_000 }).pipe(Effect.result)
        if (sent._tag === "Failure") yield* Effect.logWarning(`Media: the page of a device did not take its Spotify token (${sent.failure.reason})`)
      })

    const handle = (svc: DevicePlayersService, change: DevicePlayerChange) =>
      Effect.gen(function*() {
        const { deviceId } = change
        if (change.state === undefined) {
          // The device's last page went: what it was told goes with it, so a page that comes back is prepared again.
          known.delete(deviceId)
          for (const [id, held] of prepared) if (held.deviceId === deviceId) prepared.delete(id)
          problems.delete(deviceId)
          return
        }
        const state = change.state
        known.set(deviceId, { connection: state.connection, sources: state.sources })
        const reported = state.players.find((p) => p.error !== undefined && PROBLEM_ERRORS.has(p.error))?.error ?? (state.current?.status === "error" && state.current.errorCode !== undefined && PROBLEM_ERRORS.has(state.current.errorCode) ? state.current.errorCode : undefined)
        if (reported !== undefined) problems.set(deviceId, { deviceId, name: nameOf(deviceId), error: reported })
        else if (state.players.length > 0) problems.delete(deviceId)
        yield* prepare(svc, deviceId, state.connection, state.sources)
        for (const want of change.wants ?? []) {
          if (want.source === "spotify" && want.what === "credential") yield* credential(svc, deviceId, change.connection)
        }
      })

    // Each change is handled on its own fiber (a page that is slow to answer holds no other page up). The stream is
    // followed from here on: the fork runs at once, so a page that appears right after the start is not missed.
    yield* Effect.forkIn(
      Stream.runForEach(svc.changes, (change) =>
        Effect.asVoid(Effect.forkIn(handle(svc, change).pipe(Effect.catchCause(() => Effect.void)), o.scope))),
      o.scope,
      { startImmediately: true }
    )

    return {
      // Suspended: the pages known at the moment it runs, not at the moment it was made.
      prepareAll: Effect.suspend(() =>
        Effect.forEach([...known], ([deviceId, k]) => prepare(svc, deviceId, k.connection, k.sources).pipe(Effect.catchCause(() => Effect.void)), { concurrency: "unbounded", discard: true })
      ),
      problems: () => [...problems.values()]
    }
  })

// ---------------------------------------------------------------------------------------------------------------------
// Playback: the host's "stop"

const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/

/**
 * `Playback` by device (docs/modules/media.md §4.3): `pause` answers `true` only when the device was playing and its page
 * confirmed it paused within the budget; `changeVolume` sets a level or moves one step from the level the page reports.
 */
export const makePlayback = (host: Pick<ModuleHostApi, "service">): PlaybackService => {
  const fail = (reason: PlaybackError["reason"], detail: string) => Effect.fail(new PlaybackError({ reason, detail }))
  const players = (deviceId: string): Effect.Effect<DevicePlayersService, PlaybackError> => {
    if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId)) return fail("invalid", "a device id is 1 to 64 letters, digits, _ and -")
    const svc = host.service(DevicePlayers)
    return svc === undefined ? fail("no_player", "no device players here") : Effect.succeed(svc)
  }
  const reasonOf = (e: { readonly reason: string; readonly detail: string }): PlaybackError =>
    new PlaybackError({ reason: e.reason === "timeout" ? "timeout" : e.reason === "no_player" ? "no_player" : "failed", detail: e.detail })

  return {
    pause: (deviceId) =>
      Effect.gen(function*() {
        const svc = yield* players(deviceId)
        const state = yield* svc.state(deviceId)
        if (state === undefined) return yield* fail("no_player", "no page of that device has a player")
        if (state.current?.status !== "playing") return false
        const after = yield* svc.send(deviceId, { type: "pause" }, { timeoutMs: PLAYBACK_LIMITS.callTimeoutMs - 200, awaitStatus: ["paused"] }).pipe(Effect.mapError(reasonOf))
        return after.current?.status === "paused" ? true : yield* fail("failed", "the page did not report paused")
      }),
    changeVolume: (deviceId, change) =>
      Effect.gen(function*() {
        const svc = yield* players(deviceId)
        let level: number
        if ("to" in change) {
          if (typeof change.to !== "number" || !Number.isFinite(change.to) || change.to < 0 || change.to > 1) return yield* fail("invalid", "a level is 0 to 1")
          level = change.to
        } else {
          if (typeof change.by !== "number" || !Number.isFinite(change.by) || change.by < -1 || change.by > 1) return yield* fail("invalid", "a step is -1 to 1")
          const state = yield* svc.state(deviceId)
          if (state === undefined) return yield* fail("no_player", "no page of that device has a player")
          const present = state.current?.volume
          if (present === undefined) return yield* fail("unknown_level", "the page has not reported a level")
          level = Math.min(1, Math.max(0, present + change.by))
        }
        const after = yield* svc.send(deviceId, { type: "volume", level }, { timeoutMs: PLAYBACK_LIMITS.callTimeoutMs - 200 }).pipe(Effect.mapError(reasonOf))
        return after.current?.volume ?? level
      })
  }
}
