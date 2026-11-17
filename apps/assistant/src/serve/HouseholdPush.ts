import { CATCH_UP_ROWS, type EventBus, type FeedChange, type FeedCursor, feedRowKey, type HouseholdFeed, type HouseholdStore, hostEvent, type TargetDevice } from "@pva/core"
import type { ServerMessage } from "@pva/protocol"
import { Deferred, Effect, type Scope, Stream } from "effect"
import type { HouseholdHooks, VoiceConnection } from "./SessionHub.ts"

/**
 * Household data to voice pages (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4). Each voice connection has
 * its own fiber:
 *
 * 1. after `hello` (every time, a reconnect too) a fresh snapshot (`household.snapshot`, in parts), with a cursor;
 * 2. then the rows that commits touched since (`feed.catchUp`), coalesced per row: each read as it is now and passed
 *    through the projections. They are collected from the store's commit listener (not from the bus, which may drop),
 *    so nothing is lost to a slow page; a page with more than it can catch up on gets a fresh snapshot instead.
 *
 * A connection that fails (its send throws, its projection throws) affects only itself; a store error is logged and
 * the connection starts again from a snapshot after a second. Module events (not data) come from the bus, which
 * drops for a slow subscriber; they are sent to every connection whose device the type's projection lets see them.
 * Also publishes the hub's device events on the bus.
 */
/** The most rows a page may have pending before it is given a fresh snapshot instead. */
const PENDING_ROWS = 2000

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
    /** The rows committed changes touched since it last caught up, in the order of their last change. */
    pending: Map<string, FeedChange>
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
        f.pending.clear()
        const snap = yield* feed.snapshot(device)
        for (const [part, collections] of snap.parts.entries()) {
          if (!send(f, { type: "household.snapshot", seq: snap.seq, part, final: part === snap.parts.length - 1, collections: [...collections] })) return
          yield* Effect.yieldNow
        }
        const cursor: FeedCursor = snap.cursor
        // A commit between the snapshot's read and here is in `pending` already; start by catching up.
        for (;;) {
          if (f.fresh) break
          if (f.pending.size > 0) {
            const batch = [...f.pending.values()].slice(0, CATCH_UP_ROWS)
            for (const c of batch) f.pending.delete(feedRowKey(c.module, c.collection, c.id))
            const events = yield* feed.catchUp(device, cursor, batch)
            for (const event of events) if (!send(f, { type: "household.event", event })) return
            yield* Effect.yieldNow
            continue
          }
          yield* waitForWake(f)
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
      const f: Follower = { connection, dirty: false, pending: new Map(), signal: Deferred.makeUnsafe<void>(), closed: Deferred.makeUnsafe<void>(), fresh: false }
      followers.set(connection.id, f)
      options.run(Effect.raceFirst(follow(f), Deferred.await(f.closed)).pipe(
        Effect.ensuring(Effect.sync(() => {
          if (followers.get(connection.id) === f) followers.delete(connection.id)
        }))
      ))
    },
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
      const off = store.onCommit((changes) => {
        for (const f of followers.values()) {
          for (const c of changes) {
            const key = feedRowKey(c.module, c.collection, c.id)
            f.pending.delete(key)
            f.pending.set(key, { module: c.module, collection: c.collection, id: c.id, scope: c.scope })
          }
          // Too much to catch up on: a fresh snapshot is cheaper and bounded.
          if (f.pending.size > PENDING_ROWS) {
            f.pending.clear()
            f.fresh = true
          }
          wake(f)
        }
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
