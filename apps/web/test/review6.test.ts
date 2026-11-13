/**
 * Sixth review: a replacement player answering for its predecessor's reply (finding 1) and the echo test
 * against real replies (finding 2). Each case reproduces the reviewer's scenario and failed before its fix.
 * The client runs with the real player worklet behind its audio and a scripted socket, so what is sent is
 * what the server would receive; finding 1's server side is the real server (`serverRule.ts`).
 */
import "./worklets/shim.ts"
import { type ClientMessage, encodeReplyFrame } from "@pva/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PlaybackLink, SharedCounter, STOP_ANSWER_MS } from "../src/lib/audio/playback.ts"
import type { PlayerEvent } from "../src/lib/audio/VoiceAudio.ts"
import { createAssistantClient } from "../src/lib/client.ts"
import { PlayerProcessor } from "../worklets/player.js"
import { flush, installFakeAudio, tokenFor } from "./fakeAudio.ts"
import { installScriptedSocket, ScriptedSocket } from "./scriptedSocket.ts"
import { replayOnServer, type ServerEvent } from "./serverRule.ts"
import { alternating, replyFrame } from "./worklets/oracle.ts"

let fake: ReturnType<typeof installFakeAudio>
installScriptedSocket()

const LOCAL_REPLY_ID = 0xffff_fff0

beforeEach(() => {
  fake = installFakeAudio({ realPlayer: { Processor: PlayerProcessor } })
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => ({ release: async () => undefined }) } })
})
afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
})

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(f()).toBe(true)
}
const pcm = (from: number, n: number) => new Uint8Array(alternating(from, n).buffer)

/** A connected client that owns the audio; every message it sends is recorded with a sequence time (ms). */
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

describe("finding 1: a replacement player never answers for its predecessor's reply", () => {
  beforeEach(() => {
    ;(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true
  })

  it("30 quanta rendered, processorerror, then reply.stop: the server keeps the 3,840 samples that played", async () => {
    const { sent, socket, tick, disconnect } = await connectedOwner()
    const ctx = fake.contexts[0]!
    expect(fake.players[0]!.processorOptions.counter).toBeInstanceOf(SharedArrayBuffer)
    const events: Array<ServerEvent> = []
    const t0 = tick()
    socket.text({ type: "reply.start", turnId: 5, sampleRate: 48_000 })
    for (let off = 0; off < 28_800; off += 960) socket.binary(encodeReplyFrame(5, pcm(off, 960)))
    events.push({ at: tick() - t0, kind: "frames", samples: 28_800 })
    ctx.render(30)

    fake.players[0]!.node.onprocessorerror?.()
    expect(fake.players).toHaveLength(2) // replaced, without shared memory
    expect(fake.players[1]!.processorOptions.counter).toBeUndefined()
    // More audio of that reply arrives, then the server stops it (a barge-in) before it has committed anything.
    for (let off = 28_800; off < 38_400; off += 960) socket.binary(encodeReplyFrame(5, pcm(off, 960)))
    events.push({ at: tick() - t0, kind: "frames", samples: 9_600 })
    ctx.render(10)
    events.push({ at: tick() - t0, kind: "stop" })
    socket.text({ type: "reply.stop", turnId: 5 })
    ctx.render(10)
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 20))
    await flush()

    const finals = stoppedFor(sent, 5)
    expect(finals.length).toBeGreaterThan(0)
    // Nothing for this reply claims to be exact: only the failed player could have known that.
    expect(finals.filter((m) => m.exact !== false)).toEqual([])
    expect(finals[0]!.playedSamples).toBe(3840)
    // Nothing of the reply plays on the new player (it would have a gap and a wrong count).
    expect(fake.bridges[1]!.rendered.filter((q) => q.id === 5)).toEqual([])

    // The real server accepts the count that played.
    for (const s of sent) if ("turnId" in s.message && s.message.turnId === 5) events.push({ at: s.at - t0, kind: "report", message: s.message })
    const server = await replayOnServer(5, 48_000, events)
    expect(server).toMatchObject({ accepted: 3840, decided: true })
    disconnect()
  })

  it("the server ends its audio instead (no stop): the failed reply is answered from the page's record, provisional", async () => {
    const { sent, socket, disconnect } = await connectedOwner()
    const ctx = fake.contexts[0]!
    socket.text({ type: "reply.start", turnId: 6, sampleRate: 48_000 })
    for (let off = 0; off < 9_600; off += 960) socket.binary(encodeReplyFrame(6, pcm(off, 960)))
    ctx.render(30)
    fake.players[0]!.node.onprocessorerror?.()
    socket.text({ type: "reply.end", turnId: 6 })
    ctx.render(100)
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 20))
    await flush()
    const reports = sent.map((s) => s.message).filter((m) => "turnId" in m && m.turnId === 6)
    expect(reports.filter((m) => m.type === "playback.finished")).toEqual([])
    expect(stoppedFor(sent, 6).every((m) => m.exact === false && m.playedSamples === 3840)).toBe(true)
    disconnect()
  })

  it("the next reply plays normally on the new player, with exact counts", async () => {
    const { sent, socket, disconnect } = await connectedOwner()
    const ctx = fake.contexts[0]!
    socket.text({ type: "reply.start", turnId: 7, sampleRate: 48_000 })
    for (let off = 0; off < 9_600; off += 960) socket.binary(encodeReplyFrame(7, pcm(off, 960)))
    ctx.render(30)
    fake.players[0]!.node.onprocessorerror?.()
    socket.text({ type: "reply.stop", turnId: 7 })
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 20))
    socket.text({ type: "reply.start", turnId: 8, sampleRate: 48_000 })
    for (let off = 0; off < 4_800; off += 960) socket.binary(encodeReplyFrame(8, pcm(off, 960)))
    socket.text({ type: "reply.end", turnId: 8 })
    ctx.render(80)
    await flush()
    const finished = sent.map((s) => s.message).find((m) => m.type === "playback.finished" && m.turnId === 8)
    expect(finished).toMatchObject({ playedSamples: 4800 })
    disconnect()
  })
})

describe("finding 2: a real reply always wins over the echo test", () => {
  /** A connected owner, then fake timers (the echo test's clock) from here on. */
  const owner = async () => {
    const o = await connectedOwner()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    vi.spyOn(o.client.connection, "setMicGate").mockImplementation(() => undefined)
    const replyStart = (turnId: number) => o.socket.text({ type: "reply.start", turnId, sampleRate: 48_000 })
    return { ...o, replyStart }
  }
  const startsTo = (n = 0) =>
    (fake.players[n]!.node.port.postMessage.mock.calls as Array<[any]>).map(([m]) => m).filter((m) => m?.type === "start")

  it("a reply during the chirp cancels the test: nothing is saved, and the test says it was interrupted", async () => {
    const { client, replyStart, disconnect } = await owner()
    const outcome = client.echoTest().then(() => "resolved", (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(1100) // the chirp plays
    fake.contexts[0]!.render(20)
    replyStart(9)
    fake.contexts[0]!.render(20)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await outcome).toMatch(/interrupted/)
    expect(client.prefs.get().echoTest).toBeUndefined()
    disconnect()
  })

  it("a reply during the baseline cancels the test before the chirp: the chirp never plays, the reply is not displaced", async () => {
    const { client, replyStart, disconnect } = await owner()
    const outcome = client.echoTest().then(() => "resolved", (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(300)
    replyStart(10)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await outcome).toMatch(/interrupted/)
    expect(startsTo().map((m) => m.id)).toEqual([10])
    expect(client.prefs.get().echoTest).toBeUndefined()
    disconnect()
  })

  it("a test cannot start while a reply is playing", async () => {
    const { client, replyStart, disconnect } = await owner()
    replyStart(11)
    await expect(client.echoTest()).rejects.toThrow(/reply/)
    disconnect()
  })

  it("a stopped chirp (not finished) saves nothing", async () => {
    const { client, disconnect } = await owner()
    const outcome = client.echoTest().then(() => "resolved", (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(1100)
    const port = fake.players[0]!.node.port as { onmessage: ((e: { data: unknown }) => void) | null }
    port.onmessage?.({ data: { type: "stopped", id: LOCAL_REPLY_ID, token: tokenFor(fake.players[0]!.node, LOCAL_REPLY_ID), playedSamples: 1000, report: false } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await outcome).toMatch(/interrupted/)
    expect(client.prefs.get().echoTest).toBeUndefined()
    disconnect()
  })

  it("a test whose chirp finishes and whose window completes still saves (unchanged)", async () => {
    const { client, disconnect } = await owner()
    const outcome = client.echoTest()
    await vi.advanceTimersByTimeAsync(1100)
    const port = fake.players[0]!.node.port as { onmessage: ((e: { data: unknown }) => void) | null }
    port.onmessage?.({ data: { type: "finished", id: LOCAL_REPLY_ID, token: tokenFor(fake.players[0]!.node, LOCAL_REPLY_ID), playedSamples: 72_000 } })
    await vi.advanceTimersByTimeAsync(100)
    const result = await outcome
    expect(client.prefs.get().echoTest).toMatchObject({ residualDb: result.residualDb })
    disconnect()
  })
})

describe("finding 1, the rules in playback.ts: who may answer for a reply", () => {
  const port = () => {
    const posted: Array<any> = []
    const p = { posted, onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => void posted.push(m) }
    return { p, deliver: (data: unknown) => p.onmessage?.({ data } as MessageEvent) }
  }
  /** The instance token the link gave reply `id` (seventh review, finding 3): the worklet echoes it. */
  const tok = (posted: ReadonlyArray<any>, id: number): number => posted.filter((m) => m.type === "start" && m.id === id).at(-1).token

  it("(b) a player never answers for a reply its link has no record of (End then Start: a new session's link and an old reply id)", () => {
    const { p, deliver } = port()
    const events: Array<PlayerEvent> = []
    const link = new PlaybackLink(p, (e) => events.push(e))
    link.stop(5, true, false)
    deliver({ type: "stopped", id: 5, playedSamples: 0, report: true }) // what a fresh worklet answers
    deliver({ type: "finished", id: 5, playedSamples: 0 })
    deliver({ type: "progress", id: 5, playedSamples: 10, underruns: 0 })
    expect(events).toEqual([])
  })

  it("(a)/(b) the records of a retired link: answered from them, provisional unless the old player's exact count, never by the new player", () => {
    const old = port()
    const events: Array<PlayerEvent> = []
    const first = new PlaybackLink(old.p, (e) => events.push(e))
    first.replyStart(3, 48_000)
    old.deliver({ type: "finished", id: 3, token: tok(old.p.posted, 3), playedSamples: 900 }) // answered exactly by the old player
    first.replyStart(4, 48_000)
    old.deliver({ type: "count", id: 4, token: tok(old.p.posted, 4), playedSamples: 3840 })
    const records = first.retire(false)
    expect(records.get(3)).toEqual({ count: 900, exact: true })
    expect(records.get(4)).toEqual({ count: 3840, exact: false })
    expect(events.at(-1)).toEqual({ type: "stopped", id: 4, playedSamples: 3840, report: true, exact: false })

    const fresh = port()
    events.length = 0
    const second = new PlaybackLink(fresh.p, (e) => events.push(e), { inherited: records })
    second.frame(replyFrame(4, alternating(0, 480)))
    second.stop(4, true, false)
    second.stop(3, true, false)
    second.end(4)
    expect(fresh.p.posted.filter((m) => m.type !== "prebuffer")).toEqual([]) // nothing of those replies reaches the new player
    expect(events).toEqual([
      { type: "stopped", id: 4, playedSamples: 3840, report: true, exact: false },
      { type: "stopped", id: 3, playedSamples: 900, report: true, exact: true },
      { type: "stopped", id: 4, playedSamples: 3840, report: true, exact: false }
    ])
    // (d) a new reply is the new player's own.
    second.replyStart(5, 48_000)
    expect(fresh.p.posted.at(-1)).toMatchObject({ type: "start", id: 5, rate: 48_000 })
  })

  it("the fallback from the shared counter to messages in the middle of a reply keeps the same player and a continuous count", () => {
    const { p, deliver } = port()
    const counter = new SharedCounter()
    const view = new Int32Array(counter.buffer)
    const write = (id: number, played: number) => {
      view[0] = (view[0]! + 1) | 0
      view[1] = id
      view[2] = tok(p.posted, id)
      view[3] = played
      view[4] = 1
      view[0] = (view[0]! + 1) | 0
    }
    const events: Array<PlayerEvent> = []
    const routes: Array<string> = []
    const timers = { setTimeout: () => 0, clearTimeout: () => undefined }
    const link = new PlaybackLink(p, (e) => events.push(e), { counter, timers, onRoute: (r) => routes.push(r.route) })
    deliver({ type: "ready", shared: true })
    link.replyStart(5, 48_000)
    write(5, 1000)
    const token = tok(p.posted, 5)
    deliver({ type: "count", id: 5, token, playedSamples: 1000 })
    expect(routes).toEqual(["shared"])
    const seen: Array<number> = []
    write(5, 2000)
    seen.push(link.bestCount(5))
    // The counter stops advancing: a progress report is ahead of it, so the page falls back to messages.
    deliver({ type: "progress", id: 5, token, playedSamples: 2500, underruns: 0 })
    expect(routes).toEqual(["shared", "messages"])
    expect(p.posted.at(-1)).toEqual({ type: "route", shared: false })
    seen.push(link.bestCount(5))
    deliver({ type: "count", id: 5, token, playedSamples: 3000 })
    seen.push(link.bestCount(5))
    expect(seen).toEqual([2000, 2500, 3000])
    link.stop(5, true, false)
    deliver({ type: "stopped", id: 5, token, playedSamples: 3100, report: true })
    expect(events.at(-1)).toEqual({ type: "stopped", id: 5, playedSamples: 3100, report: true, exact: true })
  })
})
