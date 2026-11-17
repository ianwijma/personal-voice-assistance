// P5 review round 1, finding 5: a change of a device's place supersedes everything the household push was doing for
// its pages under the old place. Nothing of an older generation is sent, whatever point it had reached.
import type { HouseholdFeed, Snapshot, TargetDevice } from "@pva/core"
import { makeMemoryHouseholdStore } from "@pva/core/testing"
import type { ServerMessage } from "@pva/protocol"
import { Deferred, Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeHouseholdPush } from "../src/serve/HouseholdPush.ts"
import type { VoiceConnection } from "../src/serve/SessionHub.ts"

const snap = (label: string, parts: number): Snapshot => ({
  seq: 0,
  parts: Array.from({ length: parts }, (_, i) => [{ module: "m", collection: "c", rows: [{ id: `${label}-${i}`, rev: 1, scope: { kind: "household" }, value: label, updatedAt: 0 }], truncated: false }]),
  cursor: { seq: 0, visible: new Set() }
})

const setup = (snapshot: (device: TargetDevice) => Effect.Effect<Snapshot>) => {
  const feed: HouseholdFeed = { active: true, snapshot, catchUp: () => Effect.never, live: () => undefined }
  const push = makeHouseholdPush({
    feed,
    bus: { publish: () => Effect.void } as never,
    store: makeMemoryHouseholdStore(),
    run: (effect) => void Effect.runFork(effect),
    log: () => {}
  })
  return push
}

const rowsOf = (sent: ReadonlyArray<ServerMessage>) =>
  sent.flatMap((m) => (m.type === "household.snapshot" ? m.collections.flatMap((c) => c.rows.map((r) => r.value as string)) : []))

const settle = () => new Promise((r) => setTimeout(r, 50))

describe("household push: a place change supersedes the old generation", () => {
  it("a snapshot still being read under the old (private) place is never sent after the change", async () => {
    const gate = Deferred.makeUnsafe<void>()
    let device: TargetDevice = { id: "kitchen-01", privacy: "private" }
    const push = setup((d) => (d.privacy === "private" ? Effect.as(Deferred.await(gate), snap("personal", 1)) : Effect.succeed(snap("public", 1))))
    const sent: Array<ServerMessage> = []
    const connection: VoiceConnection = { id: "c1", get device() { return device }, send: (m) => void sent.push(m) }
    push.hooks.connected(connection)
    await settle()
    device = { id: "kitchen-01", privacy: "public" }
    push.hooks.placeChanged!(connection)
    await settle()
    Deferred.doneUnsafe(gate, Effect.void)
    await settle()
    expect(rowsOf(sent)).toEqual(["public"])
  })

  it("the rest of a snapshot whose first part went out under the old place is not sent; rapid changes leave only the last", async () => {
    let device: TargetDevice = { id: "kitchen-01", privacy: "private" }
    const push = setup((d) => Effect.succeed(snap(d.privacy ?? "unknown", 3)))
    const sent: Array<ServerMessage> = []
    let changes = 0
    const connection: VoiceConnection = {
      id: "c2",
      get device() {
        return device
      },
      send: (m) => {
        sent.push(m)
        // The place changes twice while the private snapshot is being sent.
        if (m.type === "household.snapshot" && changes < 2 && device.privacy !== "public") {
          changes++
          device = changes === 1 ? { id: "kitchen-01", privacy: "shared" } : { id: "kitchen-01", privacy: "public" }
          push.hooks.placeChanged!(connection)
        }
      }
    }
    push.hooks.connected(connection)
    await settle()
    const rows = rowsOf(sent)
    // One part of each superseded snapshot at most, then the whole last one.
    expect(rows.filter((r) => r === "private")).toHaveLength(1)
    expect(rows.filter((r) => r === "shared")).toHaveLength(1)
    expect(rows.filter((r) => r === "public")).toHaveLength(3)
    expect(rows.slice(-3)).toEqual(["public", "public", "public"])
  })

  it("resync() (Members changed) starts every page again; a closed page gets nothing more", async () => {
    let n = 0
    const push = setup(() => Effect.succeed(snap(`s${++n}`, 1)))
    const sent: Array<ServerMessage> = []
    const connection: VoiceConnection = { id: "c3", device: { id: "kitchen-01" }, send: (m) => void sent.push(m) }
    push.hooks.connected(connection)
    await settle()
    push.resync()
    await settle()
    expect(rowsOf(sent)).toEqual(["s1", "s2"])
    push.hooks.closed(connection)
    push.resync()
    await settle()
    expect(rowsOf(sent)).toEqual(["s1", "s2"])
  })
})
