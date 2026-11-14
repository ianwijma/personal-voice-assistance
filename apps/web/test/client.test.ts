import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAssistantClient } from "../src/lib/client.ts"
import { flush, installFakeAudio } from "./fakeAudio.ts"

let fake: ReturnType<typeof installFakeAudio>
let wakeLockReleased: number

beforeEach(() => {
  fake = installFakeAudio()
  wakeLockReleased = 0
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: { request: async () => ({ release: async () => void wakeLockReleased++ }) }
  })
})

/** A client whose audio is running and which the server made the owner. */
const owningClient = async () => {
  const client = createAssistantClient()
  const sent: Array<{ type: string }> = []
  vi.spyOn(client.connection, "send").mockImplementation((m) => {
    sent.push(m)
    return true
  })
  client.startAudio()
  fake.pending[0]!.resolve()
  await flush()
  client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
  expect(client.store.get().audio.phase).toBe("running")
  return { client, sent }
}

describe("assistant client (review finding 9)", () => {
  it("a microphone that fails (unplugged, permission revoked) releases ownership, closes audio and keeps the error", async () => {
    const { client, sent } = await owningClient()
    fake.pending[0]!.stream.track.end()
    await flush()
    expect(sent.map((m) => m.type)).toContain("audio.release")
    const audio = client.store.get().audio
    expect(audio.phase).toBe("error")
    expect(audio.error).toMatch(/microphone stopped/)
    expect(fake.contexts[0]!.state).toBe("closed")
    expect(fake.liveStreams()).toEqual([])
    expect(wakeLockReleased).toBe(1)
  })

  it("a failure on a tab that is not the owner sends no release", async () => {
    const { client, sent } = await owningClient()
    client.store.dispatch({ type: "session", role: "observer", ownerPresent: true, reason: "taken_over" })
    sent.length = 0
    fake.pending[0]!.stream.track.end()
    await flush()
    expect(sent.map((m) => m.type)).not.toContain("audio.release")
  })
})

describe("playbackReport: the exact field of playback.stopped", () => {
  it("exact: true for the worklet's own count (also when the event does not say), false for the page's best count; nothing when not reported", async () => {
    const { playbackReport } = await import("../src/lib/client.ts")
    expect(playbackReport({ type: "stopped", id: 4, playedSamples: 10, report: true, exact: true }, 0)).toEqual({ type: "playback.stopped", turnId: 4, playedSamples: 10, exact: true })
    expect(playbackReport({ type: "stopped", id: 4, playedSamples: 10, report: true }, 0)).toEqual({ type: "playback.stopped", turnId: 4, playedSamples: 10, exact: true })
    expect(playbackReport({ type: "stopped", id: 4, playedSamples: 9, report: true, exact: false }, 0)).toEqual({ type: "playback.stopped", turnId: 4, playedSamples: 9, exact: false })
    expect(playbackReport({ type: "stopped", id: 4, playedSamples: 9, report: false, exact: false }, 0)).toBeUndefined()
    expect(playbackReport({ type: "finished", id: 4, playedSamples: 12 }, 0)).toEqual({ type: "playback.finished", turnId: 4, playedSamples: 12 })
  })
})
