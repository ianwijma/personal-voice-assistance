import {
  type EventBus,
  type FeedChange,
  type FeedCursor,
  feedRowKey,
  type HouseholdEvent,
  type HouseholdFeed,
  type HouseholdStore,
  hostEvent,
  moduleEvent,
  type TargetDevice
} from "@pva/core"
import type { ServerMessage } from "@pva/protocol"
import { Deferred, Effect, type Scope } from "effect"
import type { HouseholdHooks, VoiceConnection } from "./SessionHub.ts"

/**
 * Household data to voice pages (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4). Each voice connection has
 * a queue and a fiber of its own.
 *
 * - The queue is filled from the store's commit listener, in commit order: the rows changes touched (coalesced: a row
 *   is queued once, at the place of its last change) and the module events of a type with a projection. It never
 *   drops; a page with more than `MAX_QUEUED` entries waiting is given a fresh snapshot instead (the events in its
 *   queue are then lost to it, as they would be to a page that was not connected).
 * - The fiber first sends a snapshot (after every `hello`, a reconnect too; again after its device's record changed
 *   and after an overflow), a bounded synchronous step at a time; then the queue, one entry at a time. **Every frame is
 *   built in the same synchronous step that hands it to the socket**, from the committed state and the server's
 *   record of the device at that moment. Nothing of the queue is sent before the snapshot's final part, and nothing is
 *   lost between the snapshot and the queue: the queue is emptied when a snapshot begins and filled from then on.
 *
 * A connection that fails (its send throws) affects only itself. Also publishes the hub's device events on the bus.
 */

/** The most entries a page may have waiting before it gets a fresh snapshot instead. */
export const MAX_QUEUED = 2000

type Entry = { readonly _tag: "row"; readonly change: FeedChange } | { readonly _tag: "event"; readonly event: HouseholdEvent }

export const makeHouseholdPush = (options: {
  readonly feed: HouseholdFeed
  readonly bus: EventBus
  readonly store: HouseholdStore
  /** The server's record of a device (its saved name), for projections. `undefined`: a page without a device. */
  readonly device: (deviceId: string | undefined) => TargetDevice
  /** Run an effect in the server's scope. */
  readonly run: (effect: Effect.Effect<void>) => void
  readonly log: (line: string) => void
}) => {
  const { feed, bus, store } = options

  interface Follower {
    readonly connection: VoiceConnection
    readonly queue: Map<string, Entry>
    next: number
    /** The device record the current snapshot was made for. */
    device: TargetDevice
    /** Start again from a snapshot (device record changed, overflow). */
    fresh: boolean
    signal: Deferred.Deferred<void>
    /** A wake-up is on its way (`wake`). */
    waking: boolean
    readonly closed: Deferred.Deferred<void>
  }
  const followers = new Map<string, Follower>()

  /**
   * Wake a page's fiber, never on the stack of the commit that queued its work: a commit's listener only queues (so an
   * overflow is seen whole, and no page's frames are built inside someone else's transaction release).
   */
  const wake = (f: Follower) => {
    if (f.waking) return
    f.waking = true
    queueMicrotask(() => {
      f.waking = false
      Deferred.doneUnsafe(f.signal, Effect.void)
    })
  }
  const waitForWake = (f: Follower) =>
    Effect.suspend(() => {
      if (f.fresh || f.queue.size > 0) return Effect.void
      f.signal = Deferred.makeUnsafe<void>()
      return Deferred.await(f.signal)
    })

  const resolve = (f: Follower) => options.device(f.connection.deviceId)

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
      for (;;) {
        // A snapshot: from here on the queue collects what commits after it.
        f.fresh = false
        f.queue.clear()
        f.device = resolve(f)
        const run = feed.snapshot(f.device)
        let done = false
        while (!done) {
          // One bounded step: read, project, build and hand the frames to the socket, all at once.
          const r = run.step()
          for (const frame of r.frames) if (!send(f, frame)) return
          done = r.done
          if (!done) yield* Effect.yieldNow
          if (f.fresh) break
        }
        if (f.fresh) continue
        const cursor: FeedCursor = run.cursor
        let sent = 0
        while (!f.fresh) {
          yield* waitForWake(f)
          if (f.fresh) break
          const first = f.queue.entries().next()
          if (first.done === true) continue
          const [key, entry] = first.value
          f.queue.delete(key)
          // Built now, from what is committed now and the device's record now.
          const event = entry._tag === "row" ? feed.change(entry.change, f.device, cursor) : feed.live(entry.event, f.device)
          if (event !== undefined && !send(f, { type: "household.event", event })) return
          if (++sent % 50 === 0) yield* Effect.yieldNow
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function*() {
          options.log(`Household data for a voice page (${f.connection.id}) could not be sent: ${String(cause).slice(0, 300)}; starting again`)
          yield* Effect.sleep(1000)
          f.fresh = true
        })
      ),
      Effect.forever
    )

  const enqueue = (f: Follower, key: string, entry: Entry) => {
    f.queue.delete(key)
    f.queue.set(key, entry)
    if (f.queue.size > MAX_QUEUED) {
      f.queue.clear()
      f.fresh = true
    }
    wake(f)
  }

  const hooks: HouseholdHooks = {
    connected: (connection) => {
      if (!feed.active) return
      const previous = followers.get(connection.id)
      if (previous !== undefined) Deferred.doneUnsafe(previous.closed, Effect.void)
      const f: Follower = { connection, queue: new Map(), next: 0, device: {}, fresh: false, signal: Deferred.makeUnsafe<void>(), waking: false, closed: Deferred.makeUnsafe<void>() }
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
    devicesChanged: () => resync(undefined, true),
    deviceConnected: (deviceId) => bus.publish(hostEvent("device.connected", { deviceId }, { kind: "device", id: deviceId })),
    deviceDisconnected: (deviceId) => bus.publish(hostEvent("device.disconnected", { deviceId }, { kind: "device", id: deviceId }))
  }

  /**
   * Give the pages of `deviceId` (all pages: `undefined`) a fresh snapshot. With `ifChanged`, only those whose device
   * record is not the one their snapshot was made for (a saved name; P5: the place and default person).
   */
  const resync = (deviceId?: string, ifChanged = false) => {
    for (const f of followers.values()) {
      if (deviceId !== undefined && f.connection.deviceId !== deviceId) continue
      if (ifChanged && JSON.stringify(resolve(f)) === JSON.stringify(f.device)) continue
      f.fresh = true
      wake(f)
    }
  }

  /** Queue what each commit releases for every page, until the scope closes. */
  const forward: Effect.Effect<void, never, Scope.Scope> = feed.active
    ? Effect.gen(function*() {
      const off = store.onCommit((released) => {
        for (const f of followers.values()) {
          for (const item of released) {
            if (item._tag === "change") {
              const c = item.change
              if (!feed.sendsCollection(c.module, c.collection)) continue
              enqueue(f, `row:${feedRowKey(c.module, c.collection, c.id)}`, { _tag: "row", change: { module: c.module, collection: c.collection, id: c.id, scope: c.scope } })
            } else if (feed.sendsEvent(item.event.type)) {
              enqueue(f, `event:${f.next++}`, { _tag: "event", event: moduleEvent(item.event) })
            }
          }
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
    : Effect.void

  return { hooks, forward, resync }
}
