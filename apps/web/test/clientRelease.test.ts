/**
 * Fourth review, finding 2: an old End must never release ownership that a newer Start acquired.
 * The client runs with the real player worklet behind its audio and a scripted socket, so the wire
 * order is what the server would see.
 */
import "./worklets/shim.ts"
import { encodeReplyFrame } from "@pva/protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createAssistantClient } from "../src/lib/client.ts"
import { STOP_ANSWER_MS } from "../src/lib/audio/playback.ts"
import { PlayerProcessor } from "../worklets/player.js"
import { flush, installFakeAudio } from "./fakeAudio.ts"
import { installScriptedSocket, ScriptedSocket } from "./scriptedSocket.ts"
import { alternating } from "./worklets/oracle.ts"

let fake: ReturnType<typeof installFakeAudio>
installScriptedSocket()

beforeEach(() => {
  fake = installFakeAudio({ realPlayer: { Processor: PlayerProcessor, holdWhileSuspended: true } })
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => ({ release: async () => undefined }) } })
})

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(f()).toBe(true)
}

const pcm = (from: number, n: number) => new Uint8Array(alternating(from, n).buffer)

describe("an old End never releases a newer session (fourth review, finding 2)", () => {
  it("End while a suspended reply waits for its count, then Start completes first: the old count goes out, the new session is not released", async () => {
    const client = createAssistantClient()
    const sent: Array<string> = []
    vi.spyOn(client.connection, "send").mockImplementation((m) => {
      sent.push(m.type)
      return true
    })
    const stop = client.connect()
    await until(() => ScriptedSocket.last !== undefined)
    ScriptedSocket.last!.open()
    await until(() => ScriptedSocket.last!.onmessage !== null)
    const socket = ScriptedSocket.last!

    client.startAudio()
    fake.pending[0]!.resolve()
    await flush()
    client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    const ctx = fake.contexts[0]!
    socket.text({ type: "reply.start", turnId: 5, sampleRate: 48_000 })
    for (let off = 0; off < 28_800; off += 960) socket.binary(encodeReplyFrame(5, pcm(off, 960)))
    ctx.render(40)
    expect(sent).toContain("playback.started")

    // The browser suspends the context: the worklet hears nothing, so the stop waits for the page's fallback.
    ctx.setState("suspended")
    client.endAudio()
    await flush()
    // Start again, and the microphone is granted before the old wait expires.
    client.startAudio()
    fake.pending[1]!.resolve()
    await flush()
    expect(sent.filter((t) => t === "audio.claim").length).toBe(2)
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 50))
    await flush()

    const afterSecondClaim = sent.slice(sent.lastIndexOf("audio.claim") + 1)
    expect(afterSecondClaim).toContain("playback.stopped") // the old reply's final count still goes out
    expect(afterSecondClaim).not.toContain("audio.release") // and it does not release the new session
    expect(fake.contexts[1]!.state).toBe("running")
    expect(client.store.get().audio.phase).toBe("running")
    stop()
  })

  it("End with nothing newer: the count goes out, then the release (unchanged)", async () => {
    const client = createAssistantClient()
    const sent: Array<string> = []
    vi.spyOn(client.connection, "send").mockImplementation((m) => {
      sent.push(m.type)
      return true
    })
    const stop = client.connect()
    await until(() => ScriptedSocket.last !== undefined)
    ScriptedSocket.last!.open()
    await until(() => ScriptedSocket.last!.onmessage !== null)
    const socket = ScriptedSocket.last!
    client.startAudio()
    fake.pending[0]!.resolve()
    await flush()
    client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    socket.text({ type: "reply.start", turnId: 6, sampleRate: 48_000 })
    for (let off = 0; off < 28_800; off += 960) socket.binary(encodeReplyFrame(6, pcm(off, 960)))
    fake.contexts[0]!.render(40)
    fake.contexts[0]!.setState("suspended")
    client.endAudio()
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 50))
    await flush()
    expect(sent.slice(sent.indexOf("playback.started") + 1)).toEqual(["playback.stopped", "audio.release"])
    stop()
  })
})

describe("other continuations of the same class (fourth review)", () => {
  it("a screen wake lock granted after End is released at once (it used to keep the screen on for good)", async () => {
    let grant: ((l: { release: () => Promise<void> }) => void) | undefined
    let released = 0
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: { request: () => new Promise((resolve) => (grant = resolve)) }
    })
    const client = createAssistantClient()
    vi.spyOn(client.connection, "send").mockImplementation(() => true)
    client.startAudio()
    fake.pending[0]!.resolve()
    await flush()
    expect(grant).toBeDefined() // requested when the audio started
    client.endAudio()
    grant!({ release: async () => void released++ }) // granted only now
    await flush()
    expect(released).toBe(1)
  })
})
