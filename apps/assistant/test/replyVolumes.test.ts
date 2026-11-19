// P7 review round 1 (b8, E9): serve mode's reply volume runs the protocol's state machine; a level dropped at the cap
// for a device with a page connected is sent to that page in the same step, so the page and the server agree.
import { MAX_KEPT_VOLUMES, type ServerMessage } from "@pva/protocol"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeReplyVolumes } from "../src/serve/phraseCommands.ts"

describe("serve mode's reply volume", () => {
  it("b8: cap eviction with a connected page: the page is set back to the default; the next louder is the limit and sends nothing", () => {
    const sent: Array<[string, ServerMessage]> = []
    const page = new Map<string, number>()
    const v = makeReplyVolumes((deviceId, message) => {
      sent.push([deviceId, message])
      if (message.type === "output.volume") page.set(deviceId, message.volume)
    })
    Effect.runSync(v.service.changeReplyVolume("kitchen", "quieter"))
    expect(page.get("kitchen")).toBe(0.8)
    for (let i = 0; i < MAX_KEPT_VOLUMES; i++) Effect.runSync(v.service.changeReplyVolume(`other-${i}`, "quieter"))
    expect(v.service.replyVolume("kitchen")).toBe(1)
    expect(page.get("kitchen")).toBe(1)
    expect(v.levelOf("kitchen")).toBeUndefined()
    const before = sent.length
    expect(Effect.runSync(v.service.changeReplyVolume("kitchen", "louder"))).toEqual({ level: 1, atLimit: true })
    expect(sent.length).toBe(before)
  })
})
