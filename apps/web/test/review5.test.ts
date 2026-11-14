/**
 * Fifth review: three late-callback races (findings 1–3) and the shared-memory fallback (finding 4).
 * Each case reproduces the reviewer's scenario; each failed before its fix.
 */
import "./worklets/shim.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ROUTE_REASONS, SHARED_MISSES, SHARED_READY_MS } from "../src/lib/audio/playback.ts"
import type { PlaybackRoute } from "../src/lib/audio/playback.ts"
import { type PlayerEvent, VoiceAudio } from "../src/lib/audio/VoiceAudio.ts"
import { createAssistantClient } from "../src/lib/client.ts"
import { PlayerProcessor } from "../worklets/player.js"
import { flush, installFakeAudio, tokenFor } from "./fakeAudio.ts"
import { alternating, contentCounts, QUANTUM, replyFrame } from "./worklets/oracle.ts"
import { profileMessage } from "./profile.ts"

const LOCAL_REPLY_ID = 0xffff_fff0
let fake: ReturnType<typeof installFakeAudio>

const wakeLock = () =>
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => ({ release: async () => undefined }) } })

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
})

/** A client whose audio runs and which owns it; `send` and `setMicGate` are recorded. */
const owningClient = async (client = createAssistantClient()) => {
  const sent: Array<any> = []
  const gate: Array<boolean> = []
  vi.spyOn(client.connection, "send").mockImplementation((m) => {
    sent.push(m)
    return true
  })
  vi.spyOn(client.connection, "setMicGate").mockImplementation((open) => void gate.push(open))
  client.startAudio()
  fake.pending.at(-1)!.resolve()
  await flush()
  client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
  expect(client.store.get().audio.phase).toBe("running")
  return { client, sent, gate }
}

/** Every `start` message a player node was sent. */
const startsTo = (player: { node: any }) =>
  (player.node.port.postMessage.mock.calls as Array<[any]>).map(([m]) => m).filter((m) => m?.type === "start")

describe("finding 1: an echo test of an older session never touches the session that replaced it", () => {
  beforeEach(() => {
    fake = installFakeAudio()
    wakeLock()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
  })

  it("End during the baseline second, then Start: no chirp into the new player, no result saved, the test says it was interrupted", async () => {
    const { client } = await owningClient()
    const outcome = client.echoTest().then(() => "resolved", (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(300) // inside the 1 s of silence
    client.endAudio()
    await vi.advanceTimersByTimeAsync(100)
    await owningClient(client) // Start again: a new session, a new player
    expect(fake.players).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(6000)
    expect(startsTo(fake.players[1]!).filter((m) => m.id === LOCAL_REPLY_ID)).toEqual([])
    expect(await outcome).toMatch(/interrupted/)
    expect(client.prefs.get().echoTest).toBeUndefined()
  })

  it("a test started in the new session keeps its listener and the shut microphone gate when the old one ends", async () => {
    const { client } = await owningClient()
    const first = client.echoTest().catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(300)
    client.endAudio()
    const { gate } = await owningClient(client) // records the gate from here on
    const second = client.echoTest()
    await vi.advanceTimersByTimeAsync(50) // the old test notices and cleans up
    expect(await first).toMatch(/interrupted/)
    expect(gate.at(-1)).toBe(false) // still shut for the second test
    await vi.advanceTimersByTimeAsync(1000) // the second test's baseline ends: it plays
    const local = startsTo(fake.players[1]!).filter((m) => m.id === LOCAL_REPLY_ID)
    expect(local).toHaveLength(1)
    // Its player says the chirp finished: the second test (and only it) completes and saves.
    const port = fake.players[1]!.node.port as { onmessage: ((e: { data: unknown }) => void) | null }
    port.onmessage?.({ data: { type: "finished", id: LOCAL_REPLY_ID, token: tokenFor(fake.players[1]!.node, LOCAL_REPLY_ID), playedSamples: 72_000 } })
    await vi.advanceTimersByTimeAsync(100)
    const result = await second
    expect(client.prefs.get().echoTest).toMatchObject({ residualDb: result.residualDb, outputPath: "direct" })
    expect(gate.at(-1)).toBe(true)
  })

  it("a change of output path while the test runs cancels it (the result would describe neither path)", async () => {
    const { client } = await owningClient()
    const outcome = client.echoTest().then(() => "resolved", (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(1200) // playing
    client.store.dispatch(profileMessage({ outputPath: "element" })) // the profile changed in admin
    await vi.advanceTimersByTimeAsync(100)
    expect(await outcome).toMatch(/interrupted/)
    expect(client.prefs.get().echoTest).toBeUndefined()
    // Its chirp is stopped in its own session.
    const stops = (fake.players[0]!.node.port.postMessage.mock.calls as Array<[any]>).map(([m]) => m).filter((m) => m?.type === "stop" && m.id === LOCAL_REPLY_ID)
    expect(stops).toHaveLength(1)
  })
})

describe("finding 2 (protocol 5): a profile change reaches the running microphone; the interrupt mode is the server's", () => {
  beforeEach(() => {
    fake = installFakeAudio()
    wakeLock()
  })

  it("processing changed in the profile: the microphone re-opens with it, then audio.config (without a mode) is sent", async () => {
    const { client, sent } = await owningClient()
    client.store.dispatch(profileMessage({ echoCancellation: false }))
    client.store.dispatch(profileMessage({ echoCancellation: false, interruptMode: "instant" }))
    const reopened = fake.pending.at(-1)!
    expect((reopened.constraints.audio as MediaTrackConstraints).echoCancellation).toBe(false)
    reopened.resolve()
    await flush()
    const configs = sent.filter((m) => m.type === "audio.config")
    expect(configs.length).toBeGreaterThan(0)
    expect(configs.every((m) => !("interruptMode" in m))).toBe(true)
  })

  it("an unchanged profile (another field) does not re-open the microphone", async () => {
    const { client } = await owningClient()
    const before = fake.pending.length
    client.store.dispatch(profileMessage({ captions: false }))
    await flush()
    expect(fake.pending.length).toBe(before)
  })
})

describe("finding 3: a stale element play() refusal never suspends direct output", () => {
  beforeEach(() => {
    fake = installFakeAudio()
  })

  it("Resume with the element's play() pending, switch to direct output, then the old play rejects: the context keeps running", async () => {
    const audio = new VoiceAudio({ onMicFrame: () => undefined, onPlayer: () => undefined, onState: () => undefined })
    const ready = audio.start({ micDeviceId: "", sinkId: "", outputPath: "element", prebufferMs: 60 })
    fake.pending[0]!.resolve()
    await ready
    await flush()
    const ctx = fake.contexts[0]!
    fake.elements.at(-1)!.pause() // the system paused the element: the context is suspended
    await flush()
    expect(ctx.state).toBe("suspended")
    let reject!: (e: unknown) => void
    fake.setPlayResult(() => new Promise<void>((_, r) => (reject = r)))
    const resumed = audio.resume()
    audio.setOutputPath("direct")
    await flush()
    expect(ctx.state).toBe("running")
    reject(new DOMException("not allowed", "NotAllowedError"))
    await resumed
    await flush()
    expect(ctx.state).toBe("running")
  })

  it("the same refusal on the element route, still in force, does suspend (unchanged)", async () => {
    const audio = new VoiceAudio({ onMicFrame: () => undefined, onPlayer: () => undefined, onState: () => undefined })
    const ready = audio.start({ micDeviceId: "", sinkId: "", outputPath: "element", prebufferMs: 60 })
    fake.pending[0]!.resolve()
    await ready
    await flush()
    const ctx = fake.contexts[0]!
    fake.elements.at(-1)!.pause()
    await flush()
    fake.setPlayResult(async () => {
      throw new DOMException("not allowed", "NotAllowedError")
    })
    await audio.resume()
    await flush()
    expect(ctx.state).toBe("suspended")
  })

  it("a speaker chosen while the permission prompt is up is not overwritten by the choice at Start (second pass)", async () => {
    const sinks: Array<string> = []
    ;(globalThis as any).AudioContext.prototype.setSinkId = async function(id: string) {
      sinks.push(id)
    }
    try {
      const audio = new VoiceAudio({ onMicFrame: () => undefined, onPlayer: () => undefined, onState: () => undefined })
      const ready = audio.start({ micDeviceId: "", sinkId: "old-speaker", outputPath: "direct", prebufferMs: 60 })
      await audio.setSink("new-speaker")
      fake.pending[0]!.resolve()
      await ready
      expect(sinks.at(-1)).toBe("new-speaker")
    } finally {
      delete (globalThis as any).AudioContext.prototype.setSinkId
    }
  })
})

/**
 * Finding 4: on a cross-origin isolated page every way the shared route can fail ends on the message route,
 * working, with one diagnostics line saying so; a failed shared route never reports a count of zero.
 */
describe("finding 4: the shared counter falls back to messages", () => {
  const events: Array<PlayerEvent> = []
  const routes: Array<PlaybackRoute> = []

  const run = async (options: Parameters<typeof installFakeAudio>[0]) => {
    ;(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true
    fake = installFakeAudio(options)
    events.length = 0
    routes.length = 0
    const audio = new VoiceAudio({
      onMicFrame: () => undefined,
      onPlayer: (e) => void events.push(e),
      onState: () => undefined,
      onRoute: (r) => void routes.push(r)
    })
    const ready = audio.start({ micDeviceId: "", sinkId: "", outputPath: "direct", prebufferMs: 0 })
    fake.pending[0]!.resolve()
    await ready
    await flush()
    return audio
  }

  /** Play reply `id` (1 s at 48 kHz), render `quanta`, stop it, let it answer: the final count against the oracle. */
  const playAndStop = async (audio: VoiceAudio, id: number, quanta: number) => {
    const ctx = fake.contexts[0]!
    audio.replyStart(id, 48_000)
    for (let off = 0; off < 48_000; off += 4800) audio.replyFrame(replyFrame(id, alternating(off, 4800)))
    ctx.render(quanta)
    await flush()
    audio.replyStop(id, true)
    ctx.render(4)
    await flush()
    const finals = events.filter((e): e is Extract<PlayerEvent, { type: "stopped" }> => e.type === "stopped" && e.id === id)
    const played = contentCounts(fake.bridges.at(-1)!.rendered.filter((q) => q.id === id)).get(id) ?? 0
    return { finals, played }
  }

  const Processor = PlayerProcessor as unknown as new (o?: any) => any

  it("the node cannot be constructed with the buffer (DataCloneError): built again without it, counts by message", async () => {
    const audio = await run({ realPlayer: { Processor }, refuseSharedCounter: true })
    expect(fake.players).toHaveLength(1)
    expect(fake.players[0]!.processorOptions?.counter).toBeUndefined()
    expect(routes.at(-1)).toEqual({ route: "messages", reason: expect.stringContaining("DataCloneError") })
    const { finals, played } = await playAndStop(audio, 3, 60)
    expect(played).toBeGreaterThan(50 * QUANTUM)
    expect(finals[0]!.playedSamples).toBeGreaterThan(0)
    expect(Math.abs(finals[0]!.playedSamples - played)).toBeLessThanOrEqual(QUANTUM)
  })

  it("the processor says it got no buffer: messages, and the reason", async () => {
    class NoBuffer extends PlayerProcessor {
      constructor() {
        super({ processorOptions: {} })
      }
    }
    const audio = await run({ realPlayer: { Processor: NoBuffer as never } })
    expect(routes.at(-1)).toEqual({ route: "messages", reason: ROUTE_REASONS.notReceived })
    const { finals, played } = await playAndStop(audio, 4, 60)
    expect(Math.abs(finals[0]!.playedSamples - played)).toBeLessThanOrEqual(QUANTUM)
  })

  it("the processor never confirms, and its counter (a copy) never advances while audio plays: messages, and the count is not zero", async () => {
    class Copy extends PlayerProcessor {
      constructor() {
        super({ processorOptions: { counter: new SharedArrayBuffer(16) } }) // not the page's buffer
        ;(this as any).port.sent.length = 0 // and no `ready`
      }
    }
    const audio = await run({ realPlayer: { Processor: Copy as never } })
    expect(routes.at(-1)).toEqual({ route: "messages", reason: ROUTE_REASONS.unconfirmed })
    const { finals, played } = await playAndStop(audio, 5, 60)
    expect(routes.at(-1)).toEqual({ route: "messages", reason: ROUTE_REASONS.stuck })
    expect(fake.bridges[0]!.processor.shared).toBeNull() // the worklet was told
    expect(finals[0]!.playedSamples).toBeGreaterThan(50 * QUANTUM)
    expect(Math.abs(finals[0]!.playedSamples - played)).toBeLessThanOrEqual(QUANTUM)
    expect(SHARED_MISSES).toBeLessThan(60)
  })

  it("no `ready` within its time and no reply to check the counter by: the page stops waiting for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    class Silent extends PlayerProcessor {
      constructor(o: any) {
        super(o)
        ;(this as any).port.sent.length = 0
      }
    }
    const audio = await run({ realPlayer: { Processor: Silent as never } })
    await vi.advanceTimersByTimeAsync(SHARED_READY_MS + 10)
    expect(routes.at(-1)).toEqual({ route: "messages", reason: ROUTE_REASONS.noReady })
    vi.useRealTimers()
    const { finals, played } = await playAndStop(audio, 6, 60)
    expect(Math.abs(finals[0]!.playedSamples - played)).toBeLessThanOrEqual(QUANTUM)
  })

  it("the processor fails with the buffer (processorerror): a new player without it, which plays and counts", async () => {
    const audio = await run({ realPlayer: { Processor } })
    expect(fake.players[0]!.processorOptions?.counter).toBeInstanceOf(SharedArrayBuffer)
    fake.players[0]!.node.onprocessorerror?.()
    expect(fake.players).toHaveLength(2)
    expect(fake.players[1]!.processorOptions?.counter).toBeUndefined()
    expect(routes.at(-1)).toEqual({ route: "messages", reason: expect.stringContaining("processorerror") })
    const { finals, played } = await playAndStop(audio, 7, 60)
    expect(played).toBeGreaterThan(50 * QUANTUM)
    expect(Math.abs(finals[0]!.playedSamples - played)).toBeLessThanOrEqual(QUANTUM)
  })

  it("a working counter is confirmed (count messages stop), and one that stops advancing later is given up, the count still right", async () => {
    const audio = await run({ realPlayer: { Processor } })
    const ctx = fake.contexts[0]!
    audio.replyStart(8, 48_000)
    for (let off = 0; off < 48_000; off += 4800) audio.replyFrame(replyFrame(8, alternating(off, 4800)))
    ctx.render(3)
    await flush()
    expect(routes.at(-1)).toEqual({ route: "shared", reason: ROUTE_REASONS.confirmed })
    const processor = fake.bridges[0]!.processor
    ctx.render(2)
    expect(processor.sharedConfirmed).toBe(true)
    // The counter stops being written (whatever the cause), while audio demonstrably plays (progress).
    processor.shared = null
    ctx.render(100)
    await flush()
    expect(routes.at(-1)).toEqual({ route: "messages", reason: ROUTE_REASONS.stuck })
    ctx.render(40)
    audio.replyStop(8, true)
    ctx.render(4)
    await flush()
    const final = events.find((e): e is Extract<PlayerEvent, { type: "stopped" }> => e.type === "stopped" && e.id === 8)!
    const played = contentCounts(fake.bridges[0]!.rendered).get(8) ?? 0
    expect(Math.abs(final.playedSamples - played)).toBeLessThanOrEqual(QUANTUM)
  })

  it("the diagnostics panel says which route is in use and why", async () => {
    ;(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true
    fake = installFakeAudio({ realPlayer: { Processor }, refuseSharedCounter: true })
    wakeLock()
    const { client } = await owningClient()
    const { describeRoute, formatDiagnostics } = await import("../src/lib/audio/diagnostics.ts")
    expect(describeRoute(client.diagnostics.get().route)).toMatch(/^messages: the browser refused the shared buffer \(DataCloneError\)$/)
    expect(formatDiagnostics(client.diagnostics.get(), { userAgent: "t", outputPath: "direct", prebufferMs: 60 })).toContain("Playback count: messages: the browser refused")
  })
})
