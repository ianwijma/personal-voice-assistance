// P5 review round 1, finding 5: a change of a device's place supersedes everything the household push was doing for
// its pages under the old place. Since P4's one queue per page (`HouseholdPage`), a changed device record replaces the
// snapshot in progress (`refresh`), and every frame is built from the device record of the moment it is sent; these
// tests hold the same promises against that push.
import type { HouseholdFeed, SnapshotRun, TargetDevice } from "@pva/core"
import { makeMemoryHouseholdStore } from "@pva/core/testing"
import type { ServerMessage } from "@pva/protocol"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeHouseholdPush } from "../src/serve/HouseholdPush.ts"
import type { VoiceConnection } from "../src/serve/SessionHub.ts"

/** A snapshot of `parts` frames of one row each (the row's value: `label`), then the final frame; one frame per step. */
const run = (label: string, parts: number): SnapshotRun => {
  let at = 0
  return {
    seq: 0,
    step: () => {
      if (at < parts) {
        const part = at++
        return {
          frames: [{
            type: "household.snapshot",
            seq: 0,
            part,
            final: false,
            collections: [{ module: "m", collection: "c", rows: [{ id: `${label}-${part}`, rev: 1, scope: { kind: "household" }, value: label, updatedAt: 0 }] }],
            truncated: []
          }],
          done: false
        }
      }
      return { frames: [{ type: "household.snapshot", seq: 0, part: at++, final: true, collections: [], truncated: [] }], done: true }
    }
  }
}

const setup = (snapshot: (device: TargetDevice) => SnapshotRun, device: () => TargetDevice) => {
  const feed: HouseholdFeed = {
    active: true,
    sendsEvent: () => false,
    sendsCollection: () => false,
    snapshot,
    change: () => undefined,
    live: () => undefined
  }
  return makeHouseholdPush({
    feed,
    bus: { publish: () => Effect.void } as never,
    store: makeMemoryHouseholdStore(),
    device,
    run: (effect) => void Effect.runFork(effect),
    log: () => {}
  })
}

const rowsOf = (sent: ReadonlyArray<ServerMessage>) =>
  sent.flatMap((m) => (m.type === "household.snapshot" ? m.collections.flatMap((c) => c.rows.map((r) => r.value as string)) : []))

const settle = () => new Promise((r) => setTimeout(r, 50))

describe("household push: a place change supersedes the old generation", () => {
  // Was: "a snapshot still being read under the old (private) place is never sent after the change". A snapshot step
  // is synchronous now and builds its frame as it sends it, so no read is in flight across a change; what is left to
  // hold is that a change after a snapshot gives a fresh one of the new place, and a change during one is below.
  it("a place change after the snapshot was sent: a fresh snapshot of the new place follows", async () => {
    let device: TargetDevice = { id: "kitchen-01", privacy: "private" }
    const push = setup((d) => run(d.privacy ?? "unknown", 1), () => device)
    const sent: Array<ServerMessage> = []
    const connection: VoiceConnection = { id: "c1", deviceId: "kitchen-01", send: (m) => void sent.push(m) }
    push.hooks.connected(connection)
    await settle()
    expect(rowsOf(sent)).toEqual(["private"])
    device = { id: "kitchen-01", privacy: "public" }
    push.hooks.devicesChanged()
    await settle()
    expect(rowsOf(sent)).toEqual(["private", "public"])
  })

  it("the rest of a snapshot whose first part went out under the old place is not sent; rapid changes leave only the last", async () => {
    let device: TargetDevice = { id: "kitchen-01", privacy: "private" }
    const push = setup((d) => run(d.privacy ?? "unknown", 3), () => device)
    const sent: Array<ServerMessage> = []
    let changes = 0
    const connection: VoiceConnection = {
      id: "c2",
      deviceId: "kitchen-01",
      send: (m) => {
        sent.push(m)
        // The place changes twice while the private snapshot is being sent.
        if (m.type === "household.snapshot" && changes < 2 && device.privacy !== "public") {
          changes++
          device = changes === 1 ? { id: "kitchen-01", privacy: "shared" } : { id: "kitchen-01", privacy: "public" }
          push.hooks.devicesChanged()
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

  it("a device record that did not change gives no new snapshot", async () => {
    const device: TargetDevice = { id: "kitchen-01", privacy: "shared", defaultPerson: "p-sam" }
    let n = 0
    const push = setup(() => run(`s${++n}`, 1), () => ({ ...device }))
    const sent: Array<ServerMessage> = []
    push.hooks.connected({ id: "c4", deviceId: "kitchen-01", send: (m) => void sent.push(m) })
    await settle()
    push.hooks.devicesChanged()
    await settle()
    expect(rowsOf(sent)).toEqual(["s1"])
  })

  it("resync() (Members changed) starts every page again; a closed page gets nothing more", async () => {
    let n = 0
    const push = setup(() => run(`s${++n}`, 1), () => ({ id: "kitchen-01" }))
    const sent: Array<ServerMessage> = []
    const connection: VoiceConnection = { id: "c3", deviceId: "kitchen-01", send: (m) => void sent.push(m) }
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
