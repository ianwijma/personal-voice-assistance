import { type EventBus, type HouseholdEvent, type HouseholdFeed, hostEvent } from "@pva/core"
import type { HouseholdEventInfo, ServerMessage } from "@pva/protocol"
import { Effect, type Scope, Stream } from "effect"
import type { HouseholdHooks, VoiceConnection } from "./SessionHub.ts"

/**
 * Household data to voice pages (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4): after each `hello`, the
 * snapshot or the replay after the page's last `seq`; then every bus event the feed's projections let through for the
 * connection's device, after its commit. A connection's live events wait until its first message has gone out (a
 * change committed meanwhile is in that message or comes after it), so a page never applies a snapshot over newer
 * changes. Also publishes the hub's device events on the bus.
 */
export const makeHouseholdPush = (options: {
  readonly feed: HouseholdFeed
  readonly bus: EventBus
  /** Run an effect in the server's scope. */
  readonly run: (effect: Effect.Effect<void>) => void
  readonly log: (line: string) => void
}) => {
  const { feed, bus } = options
  /** Per connection until its first message went out: the live events held back. */
  const waiting = new WeakMap<VoiceConnection, Array<HouseholdEventInfo>>()

  const hooks: HouseholdHooks = {
    connected: (connection, seq) => {
      if (!feed.active) return
      waiting.set(connection, [])
      options.run(Effect.gen(function*() {
        let sentSeq = 0
        if (seq === undefined) {
          const snapshot = yield* feed.snapshot(connection.device)
          connection.send({ type: "household.snapshot", seq: snapshot.seq, collections: [...snapshot.collections] })
          sentSeq = snapshot.seq
        } else {
          const replay = yield* feed.replay(connection.device, seq)
          if (replay.kind === "snapshot") {
            connection.send({ type: "household.snapshot", seq: replay.seq, collections: [...replay.collections] })
            sentSeq = replay.seq
          } else {
            for (const event of replay.events) connection.send({ type: "household.event", event })
            sentSeq = replay.events.reduce((n, e) => Math.max(n, e.seq ?? 0), seq)
          }
        }
        const held = waiting.get(connection) ?? []
        waiting.delete(connection)
        for (const event of held) if (event.seq === undefined || event.seq > sentSeq) connection.send({ type: "household.event", event })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            waiting.delete(connection)
            options.log(`Household data for a voice page could not be read: ${String(cause).slice(0, 300)}`)
          })
        )
      ))
    },
    // P5: the device's place or default person changed: what it may see changed, so it starts again from a snapshot.
    placeChanged: (connection) => hooks.connected(connection, undefined),
    deviceConnected: (deviceId) => bus.publish(hostEvent("device.connected", { deviceId }, { kind: "device", id: deviceId })),
    deviceDisconnected: (deviceId) => bus.publish(hostEvent("device.disconnected", { deviceId }, { kind: "device", id: deviceId }))
  }

  const deliver = (event: HouseholdEvent, connections: ReadonlyArray<VoiceConnection>) => {
    for (const connection of connections) {
      const info = feed.live(event, connection.device)
      if (info === undefined) continue
      const held = waiting.get(connection)
      if (held !== undefined) {
        if (held.length < 500) held.push(info)
        continue
      }
      const message: ServerMessage = { type: "household.event", event: info }
      connection.send(message)
    }
  }

  /** Forward the bus to the pages until the scope closes. */
  const forward = (connections: () => ReadonlyArray<VoiceConnection>): Effect.Effect<void, never, Scope.Scope> =>
    feed.active
      ? Effect.asVoid(Effect.forkScoped(Stream.runForEach(bus.subscribe(undefined, { capacity: 1024, name: "voice pages" }), (event) =>
        Effect.sync(() => deliver(event, connections())))))
      : Effect.void

  return { hooks, forward, deliver }
}
