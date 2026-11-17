import { type EventBus, type HouseholdFeed, type HouseholdPage, type HouseholdStore, hostEvent, makeHouseholdPage, MAX_QUEUED, type TargetDevice } from "@pva/core"
import type { ServerMessage } from "@pva/protocol"
import { Deferred, Effect, type Scope } from "effect"
import type { HouseholdHooks, VoiceConnection } from "./SessionHub.ts"

/**
 * Household data to voice pages (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4). Each voice connection has
 * one queue (`HouseholdPage` in core: everything it is sent, in order, with one bound) and a fiber of its own.
 *
 * - The queue is filled from the store's commit listener, in commit order (it only queues: no page's frame is built on
 *   the stack of the commit that released it).
 * - The fiber drains it a bounded synchronous step at a time: a snapshot part, a row's change, a module event, or a
 *   `household.gap`. **Every frame is built in the same synchronous step that hands it to the socket**, from the
 *   committed state and the server's record of the device at that moment.
 * - Loss is always signalled: an overflow (more than `MAX_QUEUED` waiting) or a failed send that starts again gives the
 *   page `household.gap` and a fresh snapshot. A changed device record gives a fresh snapshot; queued module events
 *   are kept and follow it.
 *
 * A connection that fails (its send throws) affects only itself. Also publishes the hub's device events on the bus.
 */

export { MAX_QUEUED }

export const makeHouseholdPush = (options: {
  readonly feed: HouseholdFeed
  readonly bus: EventBus
  readonly store: HouseholdStore
  /** The server's record of a device (its saved name), for projections. `undefined`: a page without a device. */
  readonly device: (deviceId: string | undefined) => TargetDevice
  /** Run an effect in the server's scope. */
  readonly run: (effect: Effect.Effect<void>) => void
  readonly log: (line: string) => void
  /** The queue bound (tests). Default `MAX_QUEUED`. */
  readonly maxQueued?: number
}) => {
  const { feed, bus, store } = options

  interface Follower {
    readonly connection: VoiceConnection
    readonly page: HouseholdPage
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
      if (f.page.pending()) return Effect.void
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
        yield* waitForWake(f)
        // One bounded step: read, project, build and hand the frames to the socket, all at once.
        for (const message of f.page.step()) if (!send(f, message)) return
        yield* Effect.yieldNow
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function*() {
          options.log(`Household data for a voice page (${f.connection.id}) could not be sent: ${String(cause).slice(0, 300)}; starting again`)
          f.page.restart()
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
      const f: Follower = {
        connection,
        page: makeHouseholdPage({ feed, device: () => options.device(connection.deviceId), ...(options.maxQueued !== undefined ? { maxQueued: options.maxQueued } : {}) }),
        signal: Deferred.makeUnsafe<void>(),
        waking: false,
        closed: Deferred.makeUnsafe<void>()
      }
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
   * record is not the one their snapshot was made with (a saved name; P5: the place and default person).
   */
  const resync = (deviceId?: string, ifChanged = false) => {
    for (const f of followers.values()) {
      if (deviceId !== undefined && f.connection.deviceId !== deviceId) continue
      if (ifChanged && JSON.stringify(resolve(f)) === JSON.stringify(f.page.snapshotDevice())) continue
      f.page.refresh()
      wake(f)
    }
  }

  /** Queue what each commit releases for every page, until the scope closes. */
  const forward: Effect.Effect<void, never, Scope.Scope> = feed.active
    ? Effect.gen(function*() {
      const off = store.onCommit((released) => {
        for (const f of followers.values()) {
          f.page.offer(released)
          if (f.page.pending()) wake(f)
        }
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
    })
    : Effect.void

  return { hooks, forward, resync }
}
