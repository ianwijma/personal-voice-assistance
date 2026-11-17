import { type EventBus, type FeedCursor, type HouseholdFeed, type HouseholdStore, hostEvent, type TargetDevice } from "@pva/core"
import type { ServerMessage } from "@pva/protocol"
import { Deferred, Effect, type Scope, Stream } from "effect"
import type { HouseholdHooks, VoiceConnection } from "./SessionHub.ts"

/**
 * Household data to voice pages (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4). Each voice connection has
 * its own fiber:
 *
 * 1. after `hello` (every time, a reconnect too) a fresh snapshot (`household.snapshot`, in parts), with a cursor;
 * 2. then, whenever a commit wakes it, the change log after its cursor (`feed.catchUp`): current rows through the
 *    projections, a page of changes at a time, until it is current. The log is read from the store, so nothing is
 *    lost to a slow page; a page the log cannot bring up to date (pruned past it, or `resync`) gets a fresh snapshot.
 *
 * A connection that fails (its send throws, its projection throws) affects only itself; a store error is logged and
 * the connection starts again from a snapshot after a second. Module events (not data) come from the bus, which
 * drops for a slow subscriber; they are sent to every connection whose device the type's projection lets see them.
 * Also publishes the hub's device events on the bus.
 */
export const makeHouseholdPush = (options: {
  readonly feed: HouseholdFeed
  readonly bus: EventBus
  readonly store: HouseholdStore
  /** Run an effect in the server's scope. */
  readonly run: (effect: Effect.Effect<void>) => void
  readonly log: (line: string) => void
}) => {
  const { feed, bus, store } = options

  interface Follower {
    readonly connection: VoiceConnection
    /** A commit happened since the follower last looked; `signal` wakes it. */
    dirty: boolean
    signal: Deferred.Deferred<void>
    readonly closed: Deferred.Deferred<void>
    /** Set by `resync`: start again from a snapshot. */
    fresh: boolean
  }
  const followers = new Map<string, Follower>()

  const wake = (f: Follower) => {
    f.dirty = true
    Deferred.doneUnsafe(f.signal, Effect.void)
  }
  const waitForWake = (f: Follower) =>
    Effect.suspend(() => {
      if (f.dirty) {
        f.dirty = false
        return Effect.void
      }
      f.signal = Deferred.makeUnsafe<void>()
      return Effect.map(Deferred.await(f.signal), () => {
        f.dirty = false
      })
    })

  /** Send one message; `false` when the connection could not take it (it is then followed no more). */
  const send = (f: Follower, message: ServerMessage): boolean => {
    try {
      f.connection.send(message)
      return true
    } catch (e) {
      options.log(`Household data could not be sent to a voice page (${f.connection.id}): ${e instanceof Error ? e.message : String(e)}`)
      Deferred.doneUnsafe(f.closed, Effect.void)
      return false
    }
  }

  const follow = (f: Follower) =>
    Effect.gen(function*() {
      const device: TargetDevice = f.connection.device
      for (;;) {
        f.fresh = false
        const snap = yield* feed.snapshot(device)
        for (const [part, collections] of snap.parts.entries()) {
          if (!send(f, { type: "household.snapshot", seq: snap.seq, part, final: part === snap.parts.length - 1, collections: [...collections] })) return
          yield* Effect.yieldNow
        }
        const cursor: FeedCursor = snap.cursor
        // A commit between the snapshot's read and here has already offered a wake-up; start by catching up.
        let resync = false
        while (!resync) {
          const r = yield* feed.catchUp(device, cursor)
          if (r.kind === "resync") {
            resync = true
            break
          }
          for (const event of r.events) if (!send(f, { type: "household.event", event })) return
          if (r.events.length > 0) yield* Effect.yieldNow
          if (r.more) continue
          if (f.fresh) break
          yield* waitForWake(f)
          if (f.fresh) break
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function*() {
          options.log(`Household data for a voice page (${f.connection.id}) could not be read: ${String(cause).slice(0, 300)}; starting again`)
          yield* Effect.sleep(1000)
        })
      ),
      Effect.forever
    )

  const hooks: HouseholdHooks = {
    connected: (connection) => {
      if (!feed.active) return
      const previous = followers.get(connection.id)
      if (previous !== undefined) Deferred.doneUnsafe(previous.closed, Effect.void)
      const f: Follower = { connection, dirty: false, signal: Deferred.makeUnsafe<void>(), closed: Deferred.makeUnsafe<void>(), fresh: false }
      followers.set(connection.id, f)
      options.run(Effect.raceFirst(follow(f), Deferred.await(f.closed)).pipe(
        Effect.ensuring(Effect.sync(() => {
          if (followers.get(connection.id) === f) followers.delete(connection.id)
        }))
      ))
    },
    // P5: the device's place or default person changed: what it may see changed, so it starts again from a snapshot.
    placeChanged: (connection) => hooks.connected(connection),
    closed: (connection) => {
      const f = followers.get(connection.id)
      if (f !== undefined) Deferred.doneUnsafe(f.closed, Effect.void)
    },
    deviceConnected: (deviceId) => bus.publish(hostEvent("device.connected", { deviceId }, { kind: "device", id: deviceId })),
    deviceDisconnected: (deviceId) => bus.publish(hostEvent("device.disconnected", { deviceId }, { kind: "device", id: deviceId }))
  }

  /** Give every page of `deviceId` (all pages: `undefined`) a fresh snapshot (its place changed; P5). */
  const resync = (deviceId?: string) => {
    for (const f of followers.values()) {
      if (deviceId !== undefined && f.connection.device.id !== deviceId) continue
      f.fresh = true
      wake(f)
    }
  }

  /** Wake every follower after each commit, and forward module events, until the scope closes. */
  const forward: Effect.Effect<void, never, Scope.Scope> = feed.active
    ? Effect.gen(function*() {
      const off = store.onCommit(() => {
        for (const f of followers.values()) wake(f)
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
      yield* Effect.forkScoped(Stream.runForEach(bus.subscribe(undefined, { capacity: 1024, name: "voice pages" }), (event) =>
        Effect.sync(() => {
          if (event.change !== undefined) return
          for (const f of followers.values()) {
            const info = feed.live(event, f.connection.device)
            if (info !== undefined) send(f, { type: "household.event", event: info })
          }
        })))
    })
    : Effect.void

  return { hooks, forward, resync }
}
