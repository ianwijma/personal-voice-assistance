/**
 * After the final (eighth) review: a reported count never exceeds what the worklet published (no extrapolation
 * from the context's clock), a replacement player that cannot be built fails visibly, and a capture processor that
 * fails fails visibly. Each case reproduces the reviewer's scenario and failed before its fix.
 */
import "./worklets/shim.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CAPTURE_FAILED_MESSAGE, PLAYER_RESTART_FAILED_MESSAGE, type PlayerEvent } from "../src/lib/audio/VoiceAudio.ts"
import { createAssistantClient } from "../src/lib/client.ts"
import { flush, installFakeAudio } from "./fakeAudio.ts"
import { linkWithWorklet } from "./worklets/linkHarness.ts"
import { alternating, replyFrame } from "./worklets/oracle.ts"

const stoppedOf = (events: ReadonlyArray<PlayerEvent>, id: number) =>
  events.filter((e): e is Extract<PlayerEvent, { type: "stopped" }> => e.type === "stopped" && e.id === id)

describe("a reported count is the published count: never extrapolated (message route)", () => {
  const SLACK = 4
  /** Reply 5 with 9,600 samples queued; 30 quanta (3,840 samples) rendered and their counts read: 5,760 still queued. */
  const playing = () => {
    const h = linkWithWorklet(false)
    h.link.replyStart(5, 48_000)
    for (let off = 0; off < 9_600; off += 960) h.link.frame(replyFrame(5, alternating(off, 960)))
    h.render(30)
    h.toPageNow()
    // 3,840 rendered; the oracle misses the reply's first samples (they fade in from 0): the slack used elsewhere.
    expect(h.oracle().get(5)).toBeGreaterThanOrEqual(3_840 - SLACK)
    return h
  }

  it("the processor dies, the context runs on for the microphone, the page unloads 100 ms later before processorerror arrives: 3,840 (was 8,640)", () => {
    const h = playing()
    h.idle(100) // nothing renders (the processor is dead); the context's clock runs on
    h.link.unload(false)
    expect(stoppedOf(h.events, 5)).toEqual([{ type: "stopped", id: 5, playedSamples: 3_840, report: true, exact: false }])
    expect(3_840).toBeLessThanOrEqual(h.oracle().get(5)! + SLACK) // nothing more rendered
  })

  it("after a suspension the clock advanced without rendering, and the page unloads before a fresh count: 3,840", () => {
    const h = playing()
    h.setRunning(false)
    h.link.suspended(0)
    h.idle(200, { clock: true }) // the clock advances; nothing renders
    h.setRunning(true) // running again, no quantum rendered yet
    h.link.unload(false)
    expect(stoppedOf(h.events, 5)).toEqual([{ type: "stopped", id: 5, playedSamples: 3_840, report: true, exact: false }])
    expect(3_840).toBeLessThanOrEqual(h.oracle().get(5)! + SLACK) // nothing more rendered
  })

  it("the stop deadline after the same failure: 3,840", () => {
    const h = playing()
    h.link.stop(5, true, false)
    h.idle(100) // the stop never reaches a live processor; the deadline answers
    expect(stoppedOf(h.events, 5)).toEqual([{ type: "stopped", id: 5, playedSamples: 3_840, report: true, exact: false }])
  })
})

let fake: ReturnType<typeof installFakeAudio>

beforeEach(() => {
  fake = installFakeAudio()
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => ({ release: async () => undefined }) } })
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** A client whose audio is running and which the server made the owner; every message it sends is recorded. */
const owningClient = async () => {
  const client = createAssistantClient()
  const sent: Array<{ type: string }> = []
  vi.spyOn(client.connection, "send").mockImplementation((m) => {
    sent.push(m)
    return true
  })
  await startOwning(client)
  return { client, sent }
}

const startOwning = async (client: ReturnType<typeof createAssistantClient>) => {
  client.startAudio()
  fake.pending.at(-1)!.resolve()
  await flush()
  client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
  expect(client.store.get().audio.phase).toBe("running")
}

/** The page ended in the failed state with `message`, gave the audio back, and closed the microphone and context. */
const failedVisibly = (client: ReturnType<typeof createAssistantClient>, sent: ReadonlyArray<{ type: string }>, message: string, context = 0) => {
  expect(client.store.get().audio).toMatchObject({ phase: "error", error: message })
  expect(sent.map((m) => m.type)).toContain("audio.release")
  expect(fake.liveStreams()).toEqual([])
  expect(fake.contexts[context]!.state).toBe("closed")
}

describe("a replacement player that cannot be built fails visibly", () => {
  it.each(["construct", "connect"] as const)("the player fails and its replacement throws on %s: failed state, error shown, audio released, microphone closed; Start works again", async (where) => {
    const { client, sent } = await owningClient()
    expect(fake.players).toHaveLength(1)
    if (where === "construct") fake.setPlayerThrows(new DOMException("no worklet", "InvalidStateError"))
    else {
      vi.spyOn(globalThis.AudioWorkletNode.prototype, "connect").mockImplementation(() => {
        throw new DOMException("cannot connect", "InvalidAccessError")
      })
    }
    expect(() => fake.players[0]!.node.onprocessorerror?.()).not.toThrow()
    await flush()
    failedVisibly(client, sent, PLAYER_RESTART_FAILED_MESSAGE)

    fake.setPlayerThrows(undefined)
    vi.restoreAllMocks()
    vi.spyOn(client.connection, "send").mockImplementation(() => true)
    await startOwning(client)
    expect(fake.contexts).toHaveLength(2)
    expect(fake.contexts[1]!.state).toBe("running")
  })
})

describe("a capture processor that fails fails visibly", () => {
  it("processorerror on the capture node: failed state, error shown, audio released, microphone closed; Start works again", async () => {
    const { client, sent } = await owningClient()
    expect(fake.captures).toHaveLength(1)
    expect(typeof fake.captures[0]!.onprocessorerror).toBe("function")
    fake.captures[0]!.onprocessorerror()
    await flush()
    failedVisibly(client, sent, CAPTURE_FAILED_MESSAGE)
    expect(CAPTURE_FAILED_MESSAGE).toMatch(/microphone stopped working/)
    expect(CAPTURE_FAILED_MESSAGE).toMatch(/Press Start/)

    await startOwning(client)
    expect(fake.captures).toHaveLength(2)
    expect(fake.contexts[1]!.state).toBe("running")
  })

  it("a stale processorerror from an earlier session's capture node does nothing", async () => {
    const { client } = await owningClient()
    const old = fake.captures[0]!
    client.endAudio()
    await flush()
    expect(client.store.get().audio.phase).toBe("off")
    await startOwning(client)
    old.onprocessorerror?.()
    await flush()
    expect(client.store.get().audio.phase).toBe("running")
    expect(fake.liveStreams()).toHaveLength(1)
    expect(fake.contexts[1]!.state).toBe("running")
  })
})
