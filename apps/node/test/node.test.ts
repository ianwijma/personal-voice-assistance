/**
 * The node client against a scripted server speaking the real protocol codecs (docs/VOICE-NODES.md §5, §8):
 * handshake with the credential and capabilities, claim, microphone frames and their sequence, reply playback
 * reports (started, progress monotonic and clamped, finished, stopped on `reply.stop` within 300 ms), cues, the
 * latency line, reconnect with backoff, the `sessions_full` retry, the 4403 slow retry, the pushed settings (volume,
 * cues, devices), `node.status` and the `node.command`s.
 */
import { AudioError } from "@pva/core"
import { exampleDeviceSetup, exampleNodeCapabilities, exampleNodeHello, exampleTrace } from "@pva/protocol/examples"
import { PROTOCOL_VERSION, VOICE_NODE_KIND } from "@pva/protocol"
import { Effect, Stream } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { AudioDevices } from "../src/audio.ts"
import type { NodeConfig } from "../src/config.ts"
import type { ConnectionLost } from "../src/connection.ts"
import { NODE_CAPABILITIES, type NodeIdentity, type NodeUpdates } from "../src/node.ts"
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

const CREDENTIAL = exampleNodeHello.credential
const config = (s: FakeServer): NodeConfig => ({ server: s.url, deviceId: "node-test-box", name: "Kitchen", credential: CREDENTIAL })
const identity: NodeIdentity = { version: "0.1.0+test", bundleSha256: "a".repeat(64), platform: { os: "linux", arch: "arm64", hostname: "kitchen-pi" } }
const devicesList = (extra: ReadonlyArray<string> = []): AudioDevices => ({
  inputs: [{ id: "plughw:CARD=Speaker,DEV=0", name: "USB Speakerphone", isDefault: true }, ...extra.map((id) => ({ id, name: id, isDefault: false }))],
  outputs: [{ id: "plughw:CARD=Speaker,DEV=0", name: "USB Speakerphone", isDefault: true }]
})
const setupWith = (sound: { volume: number; cues: boolean }, soundDevices = { input: "", output: "" }) => ({ ...exampleDeviceSetup, sound, soundDevices })

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
  it("says hello as a voice-node device with its credential and capabilities, then claims the audio with the microphone live", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming, clientId: "node-client-1", identity })
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
      device: { id: "node-test-box", kind: VOICE_NODE_KIND, name: "Kitchen", capabilities: NODE_CAPABILITIES },
      node: { credential: CREDENTIAL, ...identity }
    })
    expect(NODE_CAPABILITIES).toEqual(exampleNodeCapabilities)
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
    expect(c.of("audio.claim")).toHaveLength(1) // it does not fight the other connection
    expect(node.logs.some((l) => l.includes("another connection of this node took the audio") && l.includes("node.json on two boxes"))).toBe(true)

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

  it("claims again after sessions_full (a coded error)", async () => {
    server = await FakeServer.start({ grantClaims: false })
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("audio.claim")
    c.send({ type: "error", error: { code: "sessions_full", message: "The assistant is already talking on 4 devices" } })
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

  it("is refused with 4403 for a credential the server does not know, never gets a welcome and retries slowly", async () => {
    server = await FakeServer.start({ credential: "B".repeat(43) })
    const delays: Array<{ code: number; delay: number }> = []
    node = startNode({ config: config(server), timing: fastTiming, onReconnect: (lost, d) => delays.push({ code: lost.code, delay: d }) })
    const c = await server.connection()
    await c.closed
    await until(() => delays.length === 1, 3000, "the retry delay")
    expect(delays[0]).toEqual({ code: 4403, delay: 60_000 })
    expect(c.of("audio.claim")).toHaveLength(0)
  })
})

describe("pushed settings", () => {
  it("applies the volume and the cues of snapshot.setup and of every device.setup", async () => {
    server = await FakeServer.start({ setup: setupWith({ volume: 50, cues: false }) })
    node = startNode({ config: config(server), timing: fastTiming, speed: 50 })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()
    const reply = (turnId: number) => {
      c.send({ type: "reply.start", turnId, sampleRate: 16_000 })
      c.sendReplyFrame(turnId, new Uint8Array(new Int16Array(320).fill(10_000).buffer))
      c.send({ type: "reply.end", turnId })
    }
    const firstSample = (n: number) => new Int16Array(node!.replies.plays[n]!.chunks[0]!.buffer, node!.replies.plays[n]!.chunks[0]!.byteOffset, 1)[0]
    reply(1)
    await c.waitFor("playback.finished", 1)
    expect(firstSample(0)).toBe(2500) // (50/100)² = 0.25

    c.send({ type: "wake", phrase: "hey jev", armed: true })
    await tick(100)
    expect(node.cues.plays).toHaveLength(0) // cues off

    c.send({ type: "device.setup", ...setupWith({ volume: 100, cues: true }) })
    await tick()
    reply(2)
    await c.waitFor("playback.finished", 2)
    expect(firstSample(1)).toBe(10_000)
    c.send({ type: "wake", phrase: "hey jev", armed: true })
    await until(() => node!.cues.plays.length === 1, 1000, "the wake cue")
  })

  it("reopens the microphone when the input device changes, and only then", async () => {
    server = await FakeServer.start({ setup: setupWith({ volume: 80, cues: true }) })
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()
    node.mic.push(2)
    await c.until(() => c.micFrames.length >= 2)
    expect(node.opened).toHaveLength(0) // the first setup asked for what is already open

    c.send({ type: "device.setup", ...setupWith({ volume: 80, cues: true }, { input: "plughw:CARD=USB,DEV=0", output: "" }) })
    await until(() => node!.opened.length === 1, 1000, "audioFor")
    expect(node.opened[0]!.devices).toEqual({ input: "plughw:CARD=USB,DEV=0", output: "" })
    await tick(50)
    node.opened[0]!.mic.push(3)
    await c.until(() => c.micFrames.length >= 5, 2000, "frames from the new microphone")
    const before = c.micFrames.length
    node.mic.push(3) // the old microphone is no longer read
    await tick(100)
    expect(c.micFrames).toHaveLength(before)

    // The same input again, another output: the new output is used, the capture keeps running.
    c.send({ type: "device.setup", ...setupWith({ volume: 80, cues: true }, { input: "plughw:CARD=USB,DEV=0", output: "plughw:CARD=Speaker,DEV=0" }) })
    await until(() => node!.opened.length === 2, 1000, "audioFor for the output")
    expect(node.opened[1]!.devices.output).toBe("plughw:CARD=Speaker,DEV=0")
    node.opened[0]!.mic.push(2)
    await c.until(() => c.micFrames.length >= before + 2, 2000, "frames from the same microphone")
  })

  it("falls back to the default device when a chosen input gives no audio, and reports it in node.status", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: { ...fastTiming, statusThrottleMs: 20 }, brokenInputs: ["plughw:CARD=Gone,DEV=0"], devices: Effect.succeed(devicesList()) })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()
    c.send({ type: "device.setup", ...setupWith({ volume: 80, cues: true }, { input: "plughw:CARD=Gone,DEV=0", output: "" }) })
    await until(() => node!.opened.length === 2, 2000, "the fallback to the default device")
    expect(node.opened.map((o) => o.devices.input)).toEqual(["plughw:CARD=Gone,DEV=0", ""])
    await tick(50)
    node.opened[1]!.mic.push(2)
    await c.until(() => c.micFrames.length >= 2, 2000, "frames from the default microphone")
    await c.until(() => c.of("node.status").some((m) => m.lastError !== undefined), 2000, "a status with lastError")
    const last = c.of("node.status").at(-1)!
    expect(last.lastError!.message).toContain("plughw:CARD=Gone,DEV=0")
    expect(last.lastError!.message).toContain("using the default device")
    expect(last.input).toEqual({ opened: "plughw:CARD=Speaker,DEV=0", sampleRate: 16_000 })
  })
})

describe("node.status", () => {
  it("is sent after welcome and again, throttled, when the device list changes", async () => {
    server = await FakeServer.start()
    let extra: Array<string> = []
    node = startNode({
      config: config(server),
      timing: { ...fastTiming, statusPollMs: 20, statusThrottleMs: 300 },
      devices: Effect.sync(() => devicesList(extra)),
      missingTools: () => ["pw-record"]
    })
    const c = await server.connection()
    const [first] = await c.waitFor("node.status")
    expect(first).toMatchObject({
      type: "node.status",
      backend: "alsa",
      inputs: [{ id: "plughw:CARD=Speaker,DEV=0", name: "USB Speakerphone", isDefault: true }],
      outputs: [{ id: "plughw:CARD=Speaker,DEV=0", name: "USB Speakerphone", isDefault: true }],
      input: { opened: "plughw:CARD=Speaker,DEV=0", sampleRate: 16_000 },
      output: { opened: "plughw:CARD=Speaker,DEV=0" },
      missingTools: ["pw-record"]
    })
    expect(first!.lastError).toBeUndefined()
    // The status is sent after the welcome (the claim follows it).
    const order = c.messages.map((m) => m.message.type)
    expect(order.indexOf("node.status")).toBeGreaterThan(order.indexOf("hello"))

    // Plug devices in and out quickly: at most one status per throttle window, and the last list wins.
    extra = ["plughw:CARD=A,DEV=0"]
    await c.waitFor("node.status", 2)
    extra = ["plughw:CARD=A,DEV=0", "plughw:CARD=B,DEV=0"]
    await tick(50)
    extra = ["plughw:CARD=B,DEV=0"]
    await c.waitFor("node.status", 3, 2000)
    const times = c.messages.filter((m) => m.message.type === "node.status").map((m) => m.at)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(250)
    expect(c.of("node.status").at(-1)!.inputs.map((d) => d.id)).toEqual(["plughw:CARD=Speaker,DEV=0", "plughw:CARD=B,DEV=0"])
  })

  it("is sent again after a reconnect", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: { ...fastTiming, statusPollMs: 10_000 }, devices: Effect.succeed(devicesList()) })
    const c1 = await server.connection()
    await c1.waitFor("node.status")
    c1.close(1001, "restart")
    const c2 = await server.connection(2)
    await c2.waitFor("node.status")
  })
})

describe("node.command", () => {
  it("identify plays the identify sound even with cues off", async () => {
    server = await FakeServer.start({ setup: setupWith({ volume: 80, cues: false }) })
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()
    c.send({ type: "node.command", command: "identify" })
    await until(() => node!.cues.plays.length === 1, 1000, "the identify sound")
    expect(node.cues.plays[0]!.pulled).toBeGreaterThan(24_000) // about 1.2 s at 24 kHz
  })

  it("test-speaker plays a tone of the asked length (default 1 s, at most 5 s)", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()
    c.send({ type: "node.command", command: "test-speaker", durationMs: 500 })
    await until(() => node!.cues.plays.length === 1, 1000, "the tone")
    c.send({ type: "node.command", command: "test-speaker" })
    await until(() => node!.cues.plays.length === 2, 1000, "the default tone")
    c.send({ type: "node.command", command: "test-speaker", durationMs: 60_000 })
    await until(() => node!.cues.plays.length === 3, 1000, "the capped tone")
    await until(() => node!.cues.plays.every((p) => p.outcome !== "playing"), 3000, "the tones to finish")
    expect(node.cues.plays.map((p) => p.pulled)).toEqual([12_000, 24_000, 120_000])
  })

  it("never plays a tone over a reply", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()
    c.send({ type: "reply.start", turnId: 1, sampleRate: 16_000 })
    for (const f of replyFrames(2000, 16_000)) c.sendReplyFrame(1, f)
    await c.waitFor("playback.started")
    c.send({ type: "node.command", command: "test-speaker" })
    await tick(100)
    expect(node.cues.plays).toHaveLength(0)
  })

  it("test-mic sends node.level five times a second for its duration and not otherwise", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("mic.state")
    await tick()
    const feed = setInterval(() => node!.mic.push(1), 20)
    try {
      await tick(300)
      expect(c.of("node.level")).toHaveLength(0) // no test running
      c.send({ type: "node.command", command: "test-mic", durationMs: 700 })
      await c.until(() => c.of("node.level").length >= 3, 2000, "three levels")
      for (const level of c.of("node.level")) {
        expect(Number.isFinite(level.rmsDbfs) && Number.isFinite(level.peakDbfs)).toBe(true)
        expect(level.peakDbfs).toBeLessThanOrEqual(0)
        expect(level.rmsDbfs).toBeLessThanOrEqual(level.peakDbfs + 0.001)
      }
      await tick(500) // past the end of the window
      const after = c.of("node.level").length
      expect(after).toBeLessThanOrEqual(5)
      await tick(500)
      expect(c.of("node.level")).toHaveLength(after)
    } finally {
      clearInterval(feed)
    }
  })

  it("restart ends the run with exit code 0", async () => {
    server = await FakeServer.start()
    node = startNode({ config: config(server), timing: fastTiming })
    const c = await server.connection()
    await c.waitFor("mic.state")
    c.send({ type: "node.command", command: "restart" })
    expect(await node.exit).toEqual({ _tag: "Restarted", exitCode: 0 })
  })

  it("update checks the manifest now and exits 0 when a new release was switched to", async () => {
    server = await FakeServer.start()
    const results = ["UpToDate", "Switched"]
    const updates: NodeUpdates = { check: Effect.sync(() => ({ _tag: results.shift() ?? "UpToDate" })), welcomed: Effect.void, onProbation: () => false }
    node = startNode({ config: config(server), timing: fastTiming, updates })
    const c = await server.connection()
    await c.waitFor("mic.state")
    c.send({ type: "node.command", command: "update" })
    expect(await node.exit).toEqual({ _tag: "Updated", exitCode: 0 })
  })
})
