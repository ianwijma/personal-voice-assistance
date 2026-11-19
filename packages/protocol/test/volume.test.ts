// P7 (docs/PHRASES.md "Louder and quieter"; review round 1, E9): the one volume state machine, which the server and the
// web mock both run: steps, limits, an absolute setting that changes nothing, and the cap with what is dropped at it.
import { describe, expect, it } from "vitest"
import { changeReplyVolume, MAX_KEPT_VOLUMES, NO_REPLY_VOLUMES, REPLY_VOLUME, replyVolumeOf, stepReplyVolume } from "../src/index.ts"

describe("the reply volume's state machine", () => {
  it("steps within the bounds, at the limit nothing changes and nothing is sent", () => {
    let v = NO_REPLY_VOLUMES
    const loud = changeReplyVolume(v, "kitchen", "louder")
    expect([loud.change, loud.sends, loud.volumes]).toEqual([{ level: 1, atLimit: true }, [], v])
    for (const level of [0.8, 0.6, 0.4, 0.2]) {
      const t = changeReplyVolume(v, "kitchen", "quieter")
      expect(t.change).toEqual({ level, atLimit: false })
      expect(t.sends).toEqual([{ deviceId: "kitchen", volume: level }])
      v = t.volumes
    }
    expect(changeReplyVolume(v, "kitchen", "quieter")).toMatchObject({ change: { level: 0.2, atLimit: true }, sends: [] })
    expect(stepReplyVolume(0.2, "quieter")).toEqual({ level: 0.2, atLimit: true })
  })

  it("an absolute setting moves to the nearest step; one that is the level already changes nothing (atLimit), sends nothing", () => {
    const t = changeReplyVolume(NO_REPLY_VOLUMES, "kitchen", { to: 0.61 })
    expect(t.change).toEqual({ level: 0.6, atLimit: false })
    expect(changeReplyVolume(t.volumes, "kitchen", { to: 0.6 })).toMatchObject({ change: { level: 0.6, atLimit: true }, sends: [] })
    expect(changeReplyVolume(t.volumes, "kitchen", { to: 0.05 }).change).toEqual({ level: 0.2, atLimit: false })
    // Back to the default: not kept.
    const back = changeReplyVolume(t.volumes, "kitchen", { to: 1 })
    expect([back.volumes.size, back.sends]).toEqual([0, [{ deviceId: "kitchen", volume: 1 }]])
  })

  it(`at most ${MAX_KEPT_VOLUMES} levels: the oldest is dropped and its device is sent the default in the same step`, () => {
    let v = changeReplyVolume(NO_REPLY_VOLUMES, "kitchen", "quieter").volumes
    let dropped: ReadonlyArray<{ readonly deviceId: string; readonly volume: number }> = []
    for (let i = 0; i < MAX_KEPT_VOLUMES; i++) {
      const t = changeReplyVolume(v, `device-${i}`, "quieter")
      v = t.volumes
      if (t.sends.length > 1) dropped = t.sends.slice(1)
    }
    expect(v.size).toBe(MAX_KEPT_VOLUMES)
    expect(dropped).toEqual([{ deviceId: "kitchen", volume: REPLY_VOLUME.default }])
    expect(replyVolumeOf(v, "kitchen")).toBe(1)
    // Server and page agree: louder at the default is the limit.
    expect(changeReplyVolume(v, "kitchen", "louder").change).toEqual({ level: 1, atLimit: true })
    // A change moves a device to the newest place: it is dropped last.
    const touched = changeReplyVolume(v, "device-0", "quieter").volumes
    const next = changeReplyVolume(touched, "another", "quieter")
    expect(next.sends.at(-1)).toEqual({ deviceId: "device-1", volume: 1 })
  })
})
