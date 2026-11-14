/**
 * The node client against a scripted server speaking the real protocol codecs (docs/VOICE-NODES.md WP-3
 * acceptance): handshake, claim, microphone frames and their sequence, reply playback reports (started, progress
 * monotonic and clamped, finished, stopped on `reply.stop` within 300 ms), cues, the latency line, reconnect with
 * backoff, the `sessions_full` retry and the 4403 slow retry.
 */
import { exampleTrace } from "@pva/protocol/examples"
import { PROTOCOL_VERSION } from "@pva/protocol"
import { afterEach, describe, expect, it } from "vitest"
import type { NodeConfig } from "../src/config.ts"
import type { ConnectionLost } from "../src/connection.ts"
import { VOICE_NODE_KIND } from "../src/node.ts"
import { FakeServer } from "./support/fakeServer.ts"
import { startNode, type TestNode, until } from "./support/fakeAudio.ts"

const fastTiming = { backoffBaseMs: 40, backoffMaxMs: 200, claimRetryMs: 100, unauthorizedRetryMs: 60_000, pingEveryMs: 1000 }

let server: FakeServer | undefined
let node: TestNode | undefined

afterEach(async () => {
  await node?.stop()
  await server?.stop()
  node = undefined
  server = undefined
})

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))

const config = (s: FakeServer): NodeConfig => ({ server: s.url, deviceId: "node-test-box", name: "Kitchen" })

/** `ms` of a 16-bit sine at `rate`, as 20 ms reply frames. */
const replyFrames = (ms: number, rate: number): Array<Uint8Array> => {
  const per = rate / 50
  const frames: Array<Uint8Array> = []
  for (let f = 0; f < ms / 20; f++) {
    const s = new Int16Array(per)
    for (let i = 0; i < per; i++) s[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (f * per + i)) / rate))
    frames.push(new Uint8Array(s.buffer))
  }
  return frames
}

describe("handshake and claim", () => {
  it("says hello as a voice-node device, then claims the audio with the microphone live", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming, clientId: "node-client-1" })
    const c = await server.connection()
    await c.waitFor("mic.state")
    const types = c.messages.map((m) => m.message.type)
    expect(types.slice(0, 3)).toEqual(["hello", "audio.claim", "mic.state"])
    expect(c.of("hello")[0]).toEqual({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      clientId: "node-client-1",
      resumeOwner: true,
      frontend: "voice",
      device: { id: "node-test-box", kind: VOICE_NODE_KIND, name: "Kitchen" }
    })
    expect(c.of("audio.claim")[0]).toEqual({ type: "audio.claim", audio: { contextSampleRate: 16_000, outputPath: "direct" } })
    expect(c.of("mic.state")[0]).toEqual({ type: "mic.state", live: true })
  })
})

describe("microphone", () => {
  it("sends nothing before it owns the audio, then every frame with sequence numbers from 0", async () => {
    server = await FakeServer.start({ grantClaims: false })
    node = startNode({ config: config(server), timing: { ...fastTiming, claimRetryMs: 60_000 } })
    const c = await server.connection()
    await c.waitFor("mic.state")
    node.mic.push(5) // not the owner yet: the capture has not even started
    await new Promise((r) => setTimeout(r, 100))
    expect(c.micFrames).toHaveLength(0)

    c.send({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    await tick()
    node.mic.push(20)
    await c.until(() => c.micFrames.length >= 25, 3000, "25 frames")
    expect(c.micFrames.map((f) => f.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i))
    expect(c.micFrames.every((f) => f.pcm.length === 640)).toBe(true)
    // Frames carry the audio in order (sample 0 is the fake microphone's counter).
    expect(c.micFrames.map((f) => new Int16Array(f.pcm.buffer)[0])).toEqual(Array.from({ length: 25 }, (_, i) => i))
  })

  it("stops sending when another device takes the audio and claims again once nobody holds it", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("audio.claim")
    await tick()
    node.mic.push(3)
    await c.until(() => c.micFrames.length >= 3)

    c.send({ type: "session", role: "observer", ownerPresent: true, reason: "taken_over" })
    await new Promise((r) => setTimeout(r, 50))
    node.mic.push(3)
    await new Promise((r) => setTimeout(r, 150))
    expect(c.micFrames).toHaveLength(3)
    expect(c.of("audio.claim")).toHaveLength(1) // it does not fight the browser

    c.send({ type: "session", role: "observer", ownerPresent: false, reason: "owner_disconnected" })
    await c.waitFor("audio.claim", 2)
    // After the new claim the sequence starts at 0 again.
    await tick()
    node.mic.push(2)
    await c.until(() => c.micFrames.length >= 5)
    expect(c.micFrames.slice(3).map((f) => f.seq)).toEqual([0, 1])
  })
})

describe("reply playback", () => {
  it("reports started, monotonic clamped progress and finished with every sample", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming, progressMs: 50 })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()

    const rate = 22_050
    const frames = replyFrames(600, rate)
    const total = frames.reduce((n, f) => n + f.length / 2, 0)
    c.send({ type: "reply.start", turnId: 7, sampleRate: rate })
    for (const f of frames) c.sendReplyFrame(7, f)
    c.send({ type: "reply.end", turnId: 7 })

    const [finished] = await c.waitFor("playback.finished", 1, 3000)
    expect(finished).toEqual({ type: "playback.finished", turnId: 7, playedSamples: total })
    const started = c.of("playback.started")
    expect(started).toHaveLength(1)
    expect(started[0]!.turnId).toBe(7)
    expect(started[0]!.outputLatencyMs).toBe(20)
    expect(started[0]!.startDelayMs).toBeGreaterThanOrEqual(0)
    const progress = c.of("playback.progress").map((p) => p.playedSamples)
    expect(progress.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!)
    expect(Math.max(...progress)).toBeLessThanOrEqual(total)
    // Reports come in order: started before any progress, finished last.
    const order = c.messages.map((m) => m.message.type).filter((t) => t.startsWith("playback."))
    expect(order[0]).toBe("playback.started")
    expect(order.at(-1)).toBe("playback.finished")
    expect(node.replies.plays[0]).toMatchObject({ sampleRate: rate, pulled: total, outcome: "finished" })
  })

  it("applies the volume as (volume/100)² without changing the sample count", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming, settings: { volume: 50, cues: true }, speed: 50 })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()
    const frame = new Int16Array(320).fill(10_000)
    c.send({ type: "reply.start", turnId: 3, sampleRate: 16_000 })
    c.sendReplyFrame(3, new Uint8Array(frame.buffer))
    c.send({ type: "reply.end", turnId: 3 })
    const [finished] = await c.waitFor("playback.finished")
    expect(finished!.playedSamples).toBe(320)
  })

  it("answers reply.stop with an exact playback.stopped within 300 ms and kills the player", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming, progressMs: 50 })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()

    const rate = 24_000
    const frames = replyFrames(5000, rate)
    c.send({ type: "reply.start", turnId: 9, sampleRate: rate })
    for (const f of frames) c.sendReplyFrame(9, f)
    await c.waitFor("playback.progress", 3)
    const sentAt = performance.now()
    c.send({ type: "reply.stop", turnId: 9 })
    const [stopped] = await c.waitFor("playback.stopped", 1, 1000)
    const answeredAt = c.messages.find((m) => m.message.type === "playback.stopped")!.at
    expect(answeredAt - sentAt).toBeLessThan(300)
    expect(stopped).toMatchObject({ type: "playback.stopped", turnId: 9, exact: true })
    const lastProgress = c.of("playback.progress").at(-1)!.playedSamples
    expect(stopped!.playedSamples).toBeGreaterThanOrEqual(lastProgress)
    expect(stopped!.playedSamples).toBeLessThan(5 * rate)
    expect(node.replies.plays[0]!.outcome).toBe("interrupted")
    await new Promise((r) => setTimeout(r, 120))
    expect(c.of("playback.finished")).toHaveLength(0)
    expect(c.of("playback.stopped")).toHaveLength(1)
  })

  it("stops a reply without reporting when the connection drops, and plays the next one after reconnecting", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming })
    const c1 = await server.connection()
    await c1.waitFor("mic.state")
    await tick()
    c1.send({ type: "reply.start", turnId: 1, sampleRate: 16_000 })
    for (const f of replyFrames(3000, 16_000)) c1.sendReplyFrame(1, f)
    await c1.waitFor("playback.started")
    c1.close(1001, "restart")
    await until(() => node!.replies.plays[0]?.outcome === "interrupted", 1000, "the reply to stop")

    const c2 = await server.connection(2)
    await c2.waitFor("mic.state")
    await tick()
    c2.send({ type: "reply.start", turnId: 2, sampleRate: 16_000 })
    for (const f of replyFrames(100, 16_000)) c2.sendReplyFrame(2, f)
    c2.send({ type: "reply.end", turnId: 2 })
    const [finished] = await c2.waitFor("playback.finished")
    expect(finished).toMatchObject({ turnId: 2, playedSamples: 1600 })
    expect(c2.messages.some((m) => "turnId" in m.message && m.message.turnId === 1)).toBe(false)
  })
})

describe("cues and the latency line", () => {
  it("plays the wake cue on wake armed, the lapse cue when the window lapses, none after a turn started", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()

    c.send({ type: "wake", phrase: "hey jev", armed: true })
    await until(() => node!.cues.plays.length === 1, 1000, "the wake cue")
    c.send({ type: "state", state: "asleep" })
    await until(() => node!.cues.plays.length === 2, 1000, "the lapse cue")

    c.send({ type: "wake", phrase: "hey jev", armed: true })
    await until(() => node!.cues.plays.length === 3, 1000, "the second wake cue")
    c.send({ type: "turn.start", turnId: 4, source: "voice", userText: "what time is it", spoken: true })
    c.send({ type: "state", state: "asleep" })
    c.send({ type: "wake", phrase: "hey jev", armed: false }) // phrase + request: no cue
    await new Promise((r) => setTimeout(r, 100))
    expect(node.cues.plays).toHaveLength(3)
  })

  it("prints the turn's TurnTrace as a latency line", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("mic.state")
    c.send({ type: "turn.end", turnId: exampleTrace.turnId, outcome: "completed", trace: { ...exampleTrace, client: { outputLatencyMs: 20, startDelayMs: 3 } } })
    await until(() => node!.traces.length === 1, 1000, "a latency line")
    expect(node.traces[0]).toMatch(new RegExp(`^turn #${exampleTrace.turnId} `))
    expect(node.traces[0]).toContain("audible=")
  })
})

describe("reconnect", () => {
  it("reconnects with growing, capped backoff while the server refuses, and resets after a welcome", async () => {
    server = await FakeServer.start({ welcome: false })
    const delays: Array<{ delay: number; welcomed: boolean }> = []
    node = startNode({
      config: config(server),
      timing: { ...fastTiming, welcomeTimeoutMs: 30 },
      random: () => 1,
      onReconnect: (lost: ConnectionLost, delay) => delays.push({ delay, welcomed: lost.welcomed })
    })
    await until(() => delays.length >= 5, 5000, "five reconnects")
    expect(delays.slice(0, 5).map((d) => d.delay)).toEqual([40, 80, 160, 200, 200])

    server.options.welcome = true
    const n = server.connections.length
    const c = await server.connection(n + 1)
    await c.waitFor("mic.state")
    c.close(1001, "restart")
    await until(() => delays.some((d) => d.welcomed), 3000, "a welcomed loss")
    expect(delays.find((d) => d.welcomed)!.delay).toBe(40)
  })

  it("claims again after sessions_full (protocol 6 error)", async () => {
    server = await FakeServer.start({ grantClaims: false })
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("audio.claim")
    c.sendRaw(JSON.stringify({ type: "error", error: { code: "sessions_full", message: "The assistant is already talking on 4 devices" } }))
    await c.waitFor("audio.claim", 2, 1000)
    const claims = c.messages.filter((m) => m.message.type === "audio.claim")
    expect(claims[1]!.at - claims[0]!.at).toBeGreaterThanOrEqual(90)
  })

  it("waits the long retry after 4403 (credential refused)", async () => {
    server = await FakeServer.start()
    const delays: Array<number> = []
    node = startNode({ config: config(server), timing: fastTiming, onReconnect: (_lost, d) => delays.push(d) })
    const c = await server.connection()
    await c.waitFor("mic.state")
    c.close(4403, "unauthorized")
    await until(() => delays.length === 1)
    expect(delays[0]).toBe(60_000)
    expect(node.logs.some((l) => l.includes("pair it again"))).toBe(true)
  })
})
