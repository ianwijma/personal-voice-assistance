/**
 * Fourth review, finding 3: the count the server accepts (the first final it receives) when the
 * worklet's messages are still on their way to the page. The client runs with the real player worklet,
 * whose messages to the page are held until the test delivers them (a busy main thread), and the
 * accepted count is read from the messages the client sends to the server.
 */
import "./worklets/shim.ts"
import { type ClientMessage, encodeReplyFrame } from "@pva/protocol"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SERVER_STOP_WAIT_MS, STOP_ANSWER_MS } from "../src/lib/audio/playback.ts"
import { createAssistantClient } from "../src/lib/client.ts"
import { PlayerProcessor } from "../worklets/player.js"
import { flush, installFakeAudio } from "./fakeAudio.ts"
import { installScriptedSocket, ScriptedSocket } from "./scriptedSocket.ts"
import { alternating, contentCounts, QUANTUM } from "./worklets/oracle.ts"

let fake: ReturnType<typeof installFakeAudio>
installScriptedSocket()

beforeEach(() => {
  fake = installFakeAudio({ realPlayer: { Processor: PlayerProcessor, holdWhileSuspended: true, holdFromWorklet: true } })
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => ({ release: async () => undefined }) } })
})
afterEach(() => {
  delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
})

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 1))
  expect(f()).toBe(true)
}

/** A client that owns the audio and is playing reply `turnId` (600 ms at 48 kHz, all frames sent). */
const playing = async (turnId: number) => {
  const client = createAssistantClient()
  const sent: Array<ClientMessage> = []
  vi.spyOn(client.connection, "send").mockImplementation((m) => {
    sent.push(m)
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
  socket.text({ type: "reply.start", turnId, sampleRate: 48_000 })
  for (let off = 0; off < 28_800; off += 960) socket.binary(encodeReplyFrame(turnId, new Uint8Array(alternating(off, 960).buffer)))
  return { client, sent, stop, ctx: fake.contexts[0]!, bridge: () => fake.bridges[0]! }
}

/** What the server accepts for `turnId`: the first final count it receives. */
const accepted = (sent: ReadonlyArray<ClientMessage>, turnId: number) =>
  sent.find((m): m is Extract<ClientMessage, { type: "playback.stopped" | "playback.finished" }> =>
    (m.type === "playback.stopped" || m.type === "playback.finished") && m.turnId === turnId
  )?.playedSamples

/** Deliver the worklet's held messages up to (and including) the count for `samples`. */
const deliverCountsThrough = (bridge: ReturnType<typeof fake.bridges.at> & object, samples: number) => {
  for (;;) {
    const next = bridge.fromWorklet[0] as { type: string; playedSamples?: number } | undefined
    if (next === undefined) return
    bridge.deliverFromWorklet(1)
    if (next.type === "count" && (next.playedSamples ?? 0) >= samples) return
  }
}

describe("the count the server accepts while the worklet's messages are delayed (fourth review, finding 3)", () => {
  it("the reviewer's case: 75 quanta rendered, count messages received through quantum 65, then pagehide", async () => {
    const { sent, stop, ctx, bridge } = await playing(5)
    ctx.render(75)
    deliverCountsThrough(bridge(), 65 * QUANTUM)
    expect(bridge().fromWorklet.length).toBeGreaterThan(5) // ten quanta of counts still queued
    window.dispatchEvent(new Event("pagehide"))
    const oracle = contentCounts(bridge().rendered).get(5) ?? 0
    const count = accepted(sent, 5)
    expect(oracle).toBeGreaterThan(9_500)
    // After the final review: the last count received (the page never adds the clock), ten quanta short of what
    // rendered: the accepted cost of never reporting above what rendered (`playback.ts`, header).
    expect(count).toBe(65 * QUANTUM)
    expect(count!).toBeLessThanOrEqual(oracle)
    stop()
  })

  it("Stop pressed, the worklet's answer delayed past the page's wait: the page's answer (the accepted one) is the last count received", async () => {
    const { client, sent, stop, ctx, bridge } = await playing(6)
    ctx.render(30)
    deliverCountsThrough(bridge(), 20 * QUANTUM)
    client.stopReply()
    ctx.render(4) // the stop arrives, the 4 ms fade renders, the worklet answers (held)
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 30))
    const first = accepted(sent, 6)
    expect(first).toBeDefined()
    bridge().deliverFromWorklet() // the exact answer arrives late: a correction at most, never the accepted count
    const oracle = contentCounts(bridge().rendered).get(6) ?? 0
    expect(first).toBe(20 * QUANTUM) // the published count: never the clock (after the final review)
    expect(first!).toBeLessThanOrEqual(oracle)
    expect(accepted(sent, 6)).toBe(first)
    stop()
  })

  it("a reply that underran is never extrapolated past what was queued", async () => {
    const client = createAssistantClient()
    const sent: Array<ClientMessage> = []
    vi.spyOn(client.connection, "send").mockImplementation((m) => {
      sent.push(m)
      return true
    })
    const stopConnection = client.connect()
    await until(() => ScriptedSocket.last !== undefined)
    ScriptedSocket.last!.open()
    await until(() => ScriptedSocket.last!.onmessage !== null)
    client.startAudio()
    fake.pending[0]!.resolve()
    await flush()
    client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    // Only 100 ms of audio arrives, then the link stalls: the player runs dry and waits.
    ScriptedSocket.last!.text({ type: "reply.start", turnId: 7, sampleRate: 48_000 })
    for (let off = 0; off < 4_800; off += 960) ScriptedSocket.last!.binary(encodeReplyFrame(7, new Uint8Array(alternating(off, 960).buffer)))
    const ctx = fake.contexts[0]!
    ctx.render(80) // 213 ms: 100 ms of content, then silence
    fake.bridges[0]!.deliverFromWorklet(4) // only the first counts reached the page
    window.dispatchEvent(new Event("pagehide"))
    const oracle = contentCounts(fake.bridges[0]!.rendered).get(7) ?? 0
    const count = accepted(sent, 7)!
    expect(count).toBeLessThanOrEqual(oracle + QUANTUM)
    expect(count).toBeLessThanOrEqual(4_800)
    stopConnection()
  })

  it("with cross-origin isolation the shared counter switches on by itself: once the page confirmed it, no count messages, and the live count is exact", async () => {
    ;(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true
    const { sent, stop, ctx, bridge } = await playing(8)
    expect(bridge().processor.shared).not.toBeNull()
    // Fifth review, finding 4: count messages go on until the page has seen the counter hold what they say.
    ctx.render(2)
    expect(bridge().fromWorklet.some((m) => (m as { type: string }).type === "count")).toBe(true)
    bridge().deliverFromWorklet()
    await flush()
    ctx.render(75)
    expect(bridge().fromWorklet.filter((m) => (m as { type: string }).type === "count")).toEqual([])
    window.dispatchEvent(new Event("pagehide")) // nothing from the worklet since has reached the page
    const oracle = contentCounts(bridge().rendered).get(8) ?? 0
    expect(Math.abs(accepted(sent, 8)! - oracle)).toBeLessThanOrEqual(QUANTUM)
    stop()
  })

  it("with cross-origin isolation, before the page could confirm the counter: it is still read (it only raises the count), and messages still flow", async () => {
    ;(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true
    const { sent, stop, ctx, bridge } = await playing(8)
    ctx.render(75)
    expect(bridge().fromWorklet.filter((m) => (m as { type: string }).type === "count").length).toBeGreaterThan(0)
    window.dispatchEvent(new Event("pagehide")) // nothing from the worklet has reached the page
    const oracle = contentCounts(bridge().rendered).get(8) ?? 0
    expect(Math.abs(accepted(sent, 8)! - oracle)).toBeLessThanOrEqual(QUANTUM)
    stop()
  })
})

describe("the page's wait is derived from the server's deadline", () => {
  it("the server's stop deadline is what the page assumes, and the wait leaves 250 ms for the round trip", () => {
    // Read-only: the server's own default (`packages/audio-web`).
    const file = ["packages/audio-web/src/WebAudio.ts", "../../packages/audio-web/src/WebAudio.ts"].map((f) => join(process.cwd(), f)).find((f) => existsSync(f))!
    const server = readFileSync(file, "utf8")
    const deadline = /stopWaitMs\s*\?\?\s*(\d+)/.exec(server)?.[1]
    expect(Number(deadline)).toBe(SERVER_STOP_WAIT_MS)
    expect(SERVER_STOP_WAIT_MS - STOP_ANSWER_MS).toBeGreaterThanOrEqual(250)
  })
})

/**
 * `playback.stopped`'s `exact` field: the server waits (within its 300 ms) for an exact count when the first one is
 * provisional. What a server that does so accepts: the first exact final, else the first provisional one.
 */
type Final = Extract<ClientMessage, { type: "playback.stopped" | "playback.finished" }>
const finals = (sent: ReadonlyArray<ClientMessage>, turnId: number) =>
  sent.filter((m): m is Final => (m.type === "playback.stopped" || m.type === "playback.finished") && m.turnId === turnId)
const acceptedWithExact = (sent: ReadonlyArray<ClientMessage>, turnId: number) => {
  const all = finals(sent, turnId)
  return (all.find((m) => m.type === "playback.finished" || m.exact !== false) ?? all[0])?.playedSamples
}

describe("the page says whether each final count is exact", () => {
  it("Stop pressed, the worklet's answer delayed past the page's wait: exact: false; the worklet's count follows as exact: true", async () => {
    const { client, sent, stop, ctx, bridge } = await playing(9)
    ctx.render(30)
    deliverCountsThrough(bridge(), 20 * QUANTUM)
    client.stopReply()
    ctx.render(4)
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 30))
    expect(finals(sent, 9).map((m) => m.type === "playback.stopped" && m.exact)).toEqual([false])
    bridge().deliverFromWorklet()
    await flush()
    // The provisional count is the last count received (20 quanta); the worklet's exact count, which includes the
    // quanta and the fade whose count messages were still in flight, corrects it.
    const all = finals(sent, 9)
    const oracle = contentCounts(bridge().rendered).get(9) ?? 0
    expect(all.map((m) => m.type === "playback.stopped" && m.exact)).toEqual([false, true])
    expect(all[0]!.playedSamples).toBe(20 * QUANTUM)
    expect(all[1]!.playedSamples).toBeGreaterThan(all[0]!.playedSamples)
    expect(Math.abs(acceptedWithExact(sent, 9)! - oracle)).toBeLessThanOrEqual(QUANTUM)
    stop()
  })

  it("a stop while the context stops rendering, answered with the best count (exact: false); rendering resumes and the worklet's different count follows with exact: true", async () => {
    const { client, sent, stop, ctx, bridge } = await playing(12)
    ctx.render(30)
    bridge().deliverFromWorklet()
    ctx.setState("interrupted")
    client.stopReply()
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 30))
    expect(finals(sent, 12).map((m) => m.type === "playback.stopped" && m.exact)).toEqual([false])
    // Rendering resumes before the held stop reaches the worklet: it plays one more quantum, then fades.
    ctx.state = "running"
    const held = bridge().toWorklet.splice(0)
    ctx.render(1)
    for (const m of held) bridge().processor.port.deliver(m)
    ctx.render(4)
    bridge().deliverFromWorklet()
    await flush()
    const all = finals(sent, 12)
    expect(all.map((m) => m.type === "playback.stopped" && m.exact)).toEqual([false, true])
    expect(all[1]!.playedSamples).toBeGreaterThan(all[0]!.playedSamples)
    const oracle = contentCounts(bridge().rendered).get(12) ?? 0
    // An older server keeps the first (short by the quantum that played after it); a newer one the exact count.
    expect(accepted(sent, 12)).toBe(all[0]!.playedSamples)
    expect(acceptedWithExact(sent, 12)).toBe(all[1]!.playedSamples)
    expect(Math.abs(all[1]!.playedSamples - oracle)).toBeLessThanOrEqual(QUANTUM)
    stop()
  })

  it("a worklet that answers within the page's wait: one final, exact: true", async () => {
    const { client, sent, stop, ctx, bridge } = await playing(10)
    ctx.render(30)
    bridge().deliverFromWorklet()
    client.stopReply()
    ctx.render(4)
    bridge().deliverFromWorklet()
    await new Promise((r) => setTimeout(r, STOP_ANSWER_MS + 30))
    const all = finals(sent, 10)
    expect(all.map((m) => m.type === "playback.stopped" && m.exact)).toEqual([true])
    expect(Math.abs(all[0]!.playedSamples - (contentCounts(bridge().rendered).get(10) ?? 0))).toBeLessThanOrEqual(QUANTUM)
    stop()
  })

  it("pagehide: the best count, exact: false (the page cannot wait for the worklet)", async () => {
    const { sent, stop, ctx, bridge } = await playing(11)
    ctx.render(40)
    deliverCountsThrough(bridge(), 30 * QUANTUM)
    window.dispatchEvent(new Event("pagehide"))
    expect(finals(sent, 11).map((m) => m.type === "playback.stopped" && m.exact)).toEqual([false])
    stop()
  })
})
