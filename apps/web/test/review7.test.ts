/**
 * Seventh review: the count of a failed player (finding 1), a replacement player that fails again (finding 2),
 * and a reply id used again while an older instance's messages are still on their way (finding 3). Each case
 * reproduces the reviewer's scenario and failed before its fix. Finding 1's situations are also cases of the
 * independent oracle (`worklets/playedOracle.test.ts`, "never above what rendered"), and finding 4 is fixed
 * in that oracle's generator.
 */
import "./worklets/shim.ts"
import { type ClientMessage, encodeReplyFrame } from "@pva/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { STOP_ANSWER_MS } from "../src/lib/audio/playback.ts"
import { MAX_PLAYER_REPLACEMENTS, PLAYER_FAILED_MESSAGE, PLAYER_FAILURE_WINDOW_MS, type PlayerEvent } from "../src/lib/audio/VoiceAudio.ts"
import { createAssistantClient } from "../src/lib/client.ts"
import { PlayerProcessor } from "../worklets/player.js"
import { flush, installFakeAudio } from "./fakeAudio.ts"
import { installScriptedSocket, ScriptedSocket } from "./scriptedSocket.ts"
import { replayOnServer, type ServerEvent } from "./serverRule.ts"
import { linkWithWorklet } from "./worklets/linkHarness.ts"
import { alternating, QUANTUM, replyFrame } from "./worklets/oracle.ts"

let fake: ReturnType<typeof installFakeAudio>
installScriptedSocket()

beforeEach(() => {
  fake = installFakeAudio({ realPlayer: { Processor: PlayerProcessor } })
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => ({ release: async () => undefined }) } })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
})

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(f()).toBe(true)
}
const pcm = (from: number, n: number) => new Uint8Array(alternating(from, n).buffer)

/** A connected client that owns the audio; every message it sends is recorded with a sequence time. */
const connectedOwner = async () => {
  const client = createAssistantClient()
  const sent: Array<{ at: number; message: ClientMessage }> = []
  let clock = 0
  const tick = () => ++clock
  vi.spyOn(client.connection, "send").mockImplementation((m) => {
    sent.push({ at: tick(), message: m })
    return true
  })
  const disconnect = client.connect()
  await until(() => ScriptedSocket.last !== undefined)
  ScriptedSocket.last!.open()
  await until(() => ScriptedSocket.last!.onmessage !== null)
  const socket = ScriptedSocket.last!
  client.startAudio()
  fake.pending.at(-1)!.resolve()
  await flush()
  client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
  expect(client.store.get().audio.phase).toBe("running")
  return { client, sent, socket, tick, disconnect }
}

const stoppedFor = (sent: ReadonlyArray<{ message: ClientMessage }>, turnId: number) =>
  sent.map((s) => s.message).filter((m): m is Extract<ClientMessage, { type: "playback.stopped" }> => m.type === "playback.stopped" && m.turnId === turnId)

describe("finding 1: a failed player's count is what it published, never extrapolated", () => {
  beforeEach(() => {
    ;(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true
  })

  it("3,840 rendered with 5,760 queued, failure, processorerror handled 100 ms later while the context runs: 3,840, and the server commits 3,840", async () => {
    const { sent, socket, tick, disconnect } = await connectedOwner()
    const ctx = fake.contexts[0]!
    const events: Array<ServerEvent> = []
    const t0 = tick()
    socket.text({ type: "reply.start", turnId: 5, sampleRate: 48_000 })
    for (let off = 0; off < 9_600; off += 960) socket.binary(encodeReplyFrame(5, pcm(off, 960)))
    events.push({ at: tick() - t0, kind: "frames", samples: 9_600 })
    ctx.render(30) // 3,840 samples handed to the device
    // The processor fails; the context runs on (the microphone), and the page hears of it 100 ms later.
    ctx.currentTime += 0.1
    fake.players[0]!.node.onprocessorerror?.()
    events.push({ at: tick() - t0, kind: "stop" })
    socket.text({ type: "reply.stop", turnId: 5 })
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 20))
    await flush()

    const finals = stoppedFor(sent, 5)
    expect(finals.length).toBeGreaterThan(0)
    expect(new Set(finals.map((m) => `${m.playedSamples}${m.exact === false ? " provisional" : " exact"}`))).toEqual(new Set(["3840 provisional"]))
    for (const s of sent) if ("turnId" in s.message && s.message.turnId === 5) events.push({ at: s.at - t0, kind: "report", message: s.message })
    expect(await replayOnServer(5, 48_000, events)).toMatchObject({ accepted: 3840, decided: true })
    disconnect()
  })

  it("an exact count the failed player already gave is kept", async () => {
    const { sent, socket, disconnect } = await connectedOwner()
    const ctx = fake.contexts[0]!
    socket.text({ type: "reply.start", turnId: 6, sampleRate: 48_000 })
    for (let off = 0; off < 3_840; off += 960) socket.binary(encodeReplyFrame(6, pcm(off, 960)))
    socket.text({ type: "reply.end", turnId: 6 })
    ctx.render(40)
    await flush()
    ctx.currentTime += 0.1
    fake.players[0]!.node.onprocessorerror?.()
    socket.text({ type: "reply.stop", turnId: 6 }) // a late stop: answered from the record, with the exact count
    await flush()
    expect(sent.map((s) => s.message).find((m) => m.type === "playback.finished" && m.turnId === 6)).toMatchObject({ playedSamples: 3840 })
    expect(stoppedFor(sent, 6)).toEqual([{ type: "playback.stopped", turnId: 6, playedSamples: 3840, exact: true }])
    disconnect()
  })
})

describe("finding 2: every player's failure is handled, and repeated failures end audio with an error", () => {
  it("the replacement of a failed shared-memory player is itself replaced when it fails; the next failure within the window is fatal", async () => {
    ;(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true
    let clock = 10_000
    vi.spyOn(performance, "now").mockImplementation(() => clock)
    const { client, sent, socket, disconnect } = await connectedOwner()
    const ctx = fake.contexts[0]!
    fake.players[0]!.node.onprocessorerror?.()
    expect(fake.players).toHaveLength(2)
    expect(typeof fake.players[1]!.node.onprocessorerror).toBe("function")
    clock += 1000
    fake.players[1]!.node.onprocessorerror?.()
    expect(fake.players).toHaveLength(1 + MAX_PLAYER_REPLACEMENTS)
    expect(client.store.get().audio.phase).toBe("running")

    // A reply plays on the last replacement, which then fails too: no more replacements.
    socket.text({ type: "reply.start", turnId: 9, sampleRate: 48_000 })
    for (let off = 0; off < 9_600; off += 960) socket.binary(encodeReplyFrame(9, pcm(off, 960)))
    ctx.render(20)
    clock += 1000
    fake.players.at(-1)!.node.onprocessorerror?.()
    await flush()
    expect(fake.players).toHaveLength(1 + MAX_PLAYER_REPLACEMENTS)
    expect(client.store.get().audio).toMatchObject({ phase: "error", error: PLAYER_FAILED_MESSAGE })
    await until(() => ctx.state === "closed")
    const messages = sent.map((s) => s.message)
    // The reply's count (what the player published, provisional) goes out, then the audio is given back.
    const stop = messages.findIndex((m) => m.type === "playback.stopped" && m.turnId === 9)
    const release = messages.findIndex((m) => m.type === "audio.release")
    expect(stop).toBeGreaterThanOrEqual(0)
    expect(messages[stop]).toEqual({ type: "playback.stopped", turnId: 9, playedSamples: 20 * QUANTUM, exact: false })
    expect(release).toBeGreaterThan(stop)
    disconnect()
  })

  it("failures further apart than the window are each replaced", async () => {
    ;(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true
    let clock = 10_000
    vi.spyOn(performance, "now").mockImplementation(() => clock)
    const { client, disconnect } = await connectedOwner()
    for (let i = 0; i < 5; i++) {
      fake.players.at(-1)!.node.onprocessorerror?.()
      clock += PLAYER_FAILURE_WINDOW_MS / MAX_PLAYER_REPLACEMENTS + 1
    }
    expect(fake.players).toHaveLength(6)
    expect(client.store.get().audio.phase).toBe("running")
    disconnect()
  })

  it("a player without shared memory (the page is not isolated) is replaced on its first failure", async () => {
    const { client, disconnect } = await connectedOwner()
    expect(fake.players[0]!.processorOptions.counter).toBeUndefined()
    expect(typeof fake.players[0]!.node.onprocessorerror).toBe("function")
    fake.players[0]!.node.onprocessorerror?.()
    expect(fake.players).toHaveLength(2)
    expect(client.store.get().audio.phase).toBe("running")
    disconnect()
  })
})

const finalsOf = (events: ReadonlyArray<PlayerEvent>, id: number) =>
  events.filter((e): e is Extract<PlayerEvent, { type: "finished" | "stopped" }> => (e.type === "finished" || e.type === "stopped") && e.id === id)

describe("finding 3: a reply id used again never takes an older instance's messages or counter", () => {
  it.each([false, true])("an old reply 5's queued `finished` after a reconnect and a new reply 5 is dropped (shared counter: %s)", (shared) => {
    const h = linkWithWorklet(shared)
    h.link.replyStart(5, 48_000)
    for (let off = 0; off < 3_840; off += 960) h.link.frame(replyFrame(5, alternating(off, 960)))
    h.link.end(5)
    h.render(40) // reply 5 plays out: its `finished` (3,840) waits in the page's queue
    // The socket reconnects (the reply is flushed, unreported), and the new connection's reply 5 starts.
    h.link.stop(undefined, false, false)
    h.link.replyStart(5, 48_000)
    for (let off = 0; off < 9_600; off += 960) h.link.frame(replyFrame(5, alternating(off, 960)))
    h.link.end(5) // the server already sent the new reply's end
    const before = h.events.length
    h.toPageNow() // the old instance's messages arrive now
    expect(finalsOf(h.events.slice(before), 5)).toEqual([])
    expect(h.link.openReply).toBe(5)
    h.render(100)
    h.toPageNow()
    const finals = finalsOf(h.events.slice(before), 5)
    expect(finals).toEqual([{ type: "finished", id: 5, playedSamples: 9600 }])
  })

  it("with the shared counter, an old instance's final count is not read as the new one's: a stop before the new start reaches the worklet answers 0", () => {
    const h = linkWithWorklet(true)
    h.link.replyStart(5, 48_000)
    for (let off = 0; off < 3_840; off += 960) h.link.frame(replyFrame(5, alternating(off, 960)))
    h.link.end(5)
    h.render(40)
    h.toPageNow()
    expect(h.counter!.read(5, 0)).toBeUndefined() // the counter knows which instance it holds (see `read`)
    // A new reply 5 (after a server restart); the context stops rendering before the worklet gets its start.
    h.setRunning(false)
    h.link.replyStart(5, 48_000)
    h.link.frame(replyFrame(5, alternating(0, 960)))
    h.link.stop(5, true, true)
    h.idle(STOP_ANSWER_MS + 1)
    const answer = finalsOf(h.events, 5).at(-1)
    expect(answer).toEqual({ type: "stopped", id: 5, playedSamples: 0, report: true, exact: false })
  })

  it("a stray stop for an old instance does not stop the new instance of the same id in the worklet", () => {
    const h = linkWithWorklet(false)
    h.link.replyStart(5, 48_000)
    h.link.frame(replyFrame(5, alternating(0, 960)))
    h.render(2)
    const oldToken = (h.proc as { token: number }).token
    h.link.replyStart(5, 48_000)
    for (let off = 0; off < 4_800; off += 960) h.link.frame(replyFrame(5, alternating(off, 960)))
    h.render(1)
    h.proc.port.deliver({ type: "stop", id: 5, token: oldToken, report: true })
    expect(h.proc.state).toBe("playing") // not fading, not idle
    h.render(10)
    expect(h.proc.state).toBe("playing")
  })
})
