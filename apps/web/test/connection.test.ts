// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { type AddressInfo } from "node:net"
import { type ClientMessage, CloseCode, decodeClientMessage, decodeMicFrame, encodeReplyFrame, encodeServerMessage, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
import { serverExamples } from "@pva/protocol/examples"
import { WebSocket as WsClient, WebSocketServer, type WebSocket as ServerSocket } from "ws"
import { type AudioPort, backoffMs, makeConnection, SETTINGS_CHANGED_NOTICE } from "@/lib/connection.ts"
import { createClientStore } from "@/lib/store.ts"

const timing = { openTimeoutMs: 1000, welcomeTimeoutMs: 500, pingEveryMs: 60, pongTimeoutMs: 150, requestTimeoutMs: 300, backoffBaseMs: 20, backoffMaxMs: 80 }

/**
 * The page's `WebSocket`, played here by the `ws` package. This file runs in the node
 * environment, whose built-in WebSocket is undici's, and that changes between Node
 * releases: Node 22.23 (undici 6.29) fires `error` for a refused connection but never
 * `close`, which a browser always does. Run on a fixed implementation, the tests mean
 * the same on every Node.
 */
class TestWebSocket extends WsClient {
  constructor(url: string) {
    super(url)
    // `ws` is an EventEmitter and throws on an `error` with no listener, which the page's
    // `onerror = null` (a browser would stay quiet) would otherwise leave behind.
    this.on("error", () => undefined)
  }
}
beforeAll(() => void vi.stubGlobal("WebSocket", TestWebSocket))
afterAll(() => void vi.unstubAllGlobals())

interface Peer {
  readonly ws: ServerSocket
  readonly text: Array<ClientMessage>
  readonly binary: Array<Buffer>
}

const servers: Array<WebSocketServer> = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const s of stops.splice(0)) s()
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate()
    await new Promise((r) => s.close(r))
  }
})

/** A tiny scripted server: records what the client sends; `onHello` decides the answer. */
const startServer = (onHello: (peer: Peer, hello: Extract<ClientMessage, { type: "hello" }>) => void = (p) => p.ws.send(encodeServerMessage(serverExamples.welcome))) =>
  new Promise<{ url: string; peers: Array<Peer>; wss: WebSocketServer }>((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    servers.push(wss)
    const peers: Array<Peer> = []
    wss.on("connection", (ws) => {
      const peer: Peer = { ws, text: [], binary: [] }
      peers.push(peer)
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return void peer.binary.push(data)
        const d = decodeClientMessage(data.toString())
        if (d._tag !== "Ok") throw new Error(`bad client message: ${data.toString()}`)
        peer.text.push(d.message)
        if (d.message.type === "hello") onHello(peer, d.message)
        if (d.message.type === "ping") ws.send(encodeServerMessage({ type: "pong", id: d.message.id }))
      })
    })
    wss.on("listening", () => resolve({ url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, peers, wss }))
  })

const fakeAudio = (running = true) => {
  const calls: Array<string> = []
  const frames: Array<ArrayBuffer> = []
  const audio: AudioPort = {
    replyStart: (id, rate) => calls.push(`start ${id} ${rate}`),
    replyFrame: (b) => frames.push(b),
    replyEnd: (id) => calls.push(`end ${id}`),
    replyStop: (id) => calls.push(`stop ${id}`),
    socketLost: () => calls.push("lost"),
    running: () => running
  }
  return { audio, calls, frames }
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 5))
  }
}

const connect = (url: string, audio: AudioPort, hooks = {}) => {
  const store = createClientStore()
  const conn = makeConnection({ url, clientId: "c-test-0001", store, audio, timing, hooks })
  stops.push(conn.start())
  return { store, conn }
}

describe("connection", () => {
  it("P5: a close for changed settings reconnects at once, says hello again and shows a notice after the welcome (once)", async () => {
    const { url, peers } = await startServer()
    const { store } = connect(url, fakeAudio().audio)
    await until(() => store.get().connection.status === "open")
    expect(store.get().toasts).toEqual([])
    peers[0]!.ws.close(CloseCode.settingsChanged, "settings changed")
    await until(() => peers.length === 2 && store.get().connection.status === "open")
    expect(peers[1]!.text[0]!.type).toBe("hello")
    expect(store.get().toasts.map((t) => [t.message, t.tone])).toEqual([[SETTINGS_CHANGED_NOTICE, "info"]])
    // An ordinary drop afterwards: no notice again.
    peers[1]!.ws.terminate()
    await until(() => peers.length === 3 && store.get().connection.status === "open")
    expect(store.get().toasts.filter((t) => t.message === SETTINGS_CHANGED_NOTICE)).toHaveLength(1)
  })

  it("says hello, dispatches the welcome and answers liveness pings", async () => {
    const { url, peers } = await startServer()
    const { store, conn } = connect(url, fakeAudio().audio)
    await until(() => store.get().connection.status === "open")
    expect(peers[0]!.text[0]).toEqual({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-test-0001", resumeOwner: false, frontend: "voice" })
    expect(store.get().connection.connectionId).toBe("conn-3")
    expect(conn.isOpen()).toBe(true)
    await until(() => peers[0]!.text.filter((m) => m.type === "ping").length >= 3)
    expect(store.get().connection.status).toBe("open") // pongs keep it alive
  })

  it("protocol 5: hello says what the page is: a voice page with its device; an admin page with its token, read on every connect", async () => {
    const { url, peers } = await startServer()
    const audio = fakeAudio(false).audio
    const voice = makeConnection({ url, clientId: "c-test-0002", store: createClientStore(), audio, timing, identity: () => ({ frontend: "voice", device: { id: "d-test-device-1", kind: "web-voice", name: "Mac · Chrome" } }) })
    stops.push(voice.start())
    let token: string | undefined
    const admin = makeConnection({ url, clientId: "c-test-0003", store: createClientStore(), audio, timing, identity: () => (token === undefined ? { frontend: "admin" } : { frontend: "admin", adminToken: token }) })
    stops.push(admin.start())
    await until(() => peers.filter((p) => p.text.length > 0).length === 2)
    const hellos = peers.map((p) => p.text[0]!)
    expect(hellos).toContainEqual({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-test-0002", resumeOwner: false, frontend: "voice", device: { id: "d-test-device-1", kind: "web-voice", name: "Mac · Chrome" } })
    expect(hellos).toContainEqual({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-test-0003", resumeOwner: false, frontend: "admin" })
    token = "A".repeat(43)
    for (const p of peers.filter((x) => x.text[0]?.type === "hello" && (x.text[0] as { clientId: string }).clientId === "c-test-0003")) p.ws.terminate()
    await until(() => peers.some((p) => (p.text[0] as { adminToken?: string } | undefined)?.adminToken === token), 3000)
  })

  it("resolves requests with their result, and times out unanswered ones", async () => {
    const { url, peers } = await startServer()
    const { store, conn } = connect(url, fakeAudio().audio)
    await until(() => conn.isOpen())
    const p = conn.request({ type: "module.enable", moduleId: "weather" })
    await until(() => peers[0]!.text.some((m) => m.type === "module.enable"))
    const sent = peers[0]!.text.find((m) => m.type === "module.enable") as Extract<ClientMessage, { type: "module.enable" }>
    expect(Object.values(store.get().pending)).toEqual([{ kind: "module.enable", target: "weather" }])
    peers[0]!.ws.send(encodeServerMessage({ type: "result", requestId: sent.requestId, ok: true }))
    expect(await p).toEqual({ type: "result", requestId: sent.requestId, ok: true })
    expect(store.get().pending).toEqual({})
    const late = await conn.request({ type: "engine.reload" })
    expect(late.ok).toBe(false)
    expect(late.error?.message).toMatch(/did not answer/)
  })

  it("routes reply audio to the player only for the owner, transferring the whole frame", async () => {
    const { url, peers } = await startServer()
    const fa = fakeAudio()
    const { conn } = connect(url, fa.audio)
    await until(() => conn.isOpen())
    const ws = peers[0]!.ws
    ws.send(encodeServerMessage({ type: "reply.start", turnId: 12, sampleRate: 22_050 }))
    ws.send(encodeReplyFrame(12, new Uint8Array(882)))
    ws.send(encodeServerMessage({ type: "reply.end", turnId: 12 }))
    ws.send(encodeServerMessage({ type: "reply.stop", turnId: 12 }))
    await until(() => fa.calls.length >= 3)
    expect(fa.calls).toEqual(["start 12 22050", "end 12", "stop 12"])
    expect(fa.frames).toHaveLength(1)
    expect(fa.frames[0]!.byteLength).toBe(8 + 882)
  })

  it("sends microphone frames with consecutive sequence numbers only while owner and live", async () => {
    const { url, peers } = await startServer()
    const { store, conn } = connect(url, fakeAudio().audio)
    await until(() => conn.isOpen())
    const frame = () => new ArrayBuffer(8 + 640)
    conn.resetMicSequence()
    for (let i = 0; i < 3; i++) conn.sendMic(frame())
    store.dispatch({ type: "local/mic", live: false })
    conn.sendMic(frame()) // muted: dropped
    store.dispatch({ type: "local/mic", live: true })
    conn.resetMicSequence()
    conn.sendMic(frame())
    store.dispatch({ type: "session", role: "observer", ownerPresent: true, reason: "taken_over" })
    conn.sendMic(frame()) // observer: dropped
    await until(() => peers[0]!.binary.length >= 4)
    await new Promise((r) => setTimeout(r, 30))
    const seqs = peers[0]!.binary.map((b) => {
      const f = decodeMicFrame(b)
      if (!f.ok) throw new Error(f.error)
      return f.frame.seq
    })
    expect(seqs).toEqual([0, 1, 2, 0])
  })

  it("reconnects with backoff after the socket drops, and asks to resume ownership", async () => {
    const welcomes: Array<boolean> = []
    const { url, peers } = await startServer((p, hello) => {
      welcomes.push(hello.resumeOwner)
      const snapshot = { ...serverExamples.welcome.snapshot, role: hello.resumeOwner ? "owner" as const : "observer" as const }
      p.ws.send(encodeServerMessage({ ...serverExamples.welcome, snapshot }))
    })
    const fa = fakeAudio(true)
    const resumed: Array<boolean> = []
    const { store } = connect(url, fa.audio, { afterWelcome: (r: boolean) => resumed.push(r) })
    await until(() => store.get().connection.status === "open")
    store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    peers[0]!.ws.terminate()
    await until(() => store.get().connection.status === "reconnecting")
    expect(fa.calls).toContain("lost") // the player is flushed at once
    await until(() => peers.length === 2 && store.get().connection.status === "open")
    expect(welcomes).toEqual([false, true])
    expect(resumed).toEqual([false, true])
    expect(store.get().session.role).toBe("owner")
  })

  it("treats a missing pong as a dead socket", async () => {
    const { url, peers } = await startServer()
    const { store, conn } = connect(url, fakeAudio().audio)
    await until(() => conn.isOpen())
    peers[0]!.ws.removeAllListeners("message") // stop answering pings (the socket stays open)
    await until(() => store.get().connection.status === "reconnecting", 3000)
    await until(() => peers.length >= 2)
  })

  it("stops retrying after close 4400 and marks the page outdated", async () => {
    let hellos = 0
    const { url } = await startServer((p) => {
      hellos++
      p.ws.send(encodeServerMessage({ type: "error", error: { code: "bad_message", message: "This page is out of date; reload it." } }))
      p.ws.close(CloseCode.protocolMismatch)
    })
    const { store } = connect(url, fakeAudio().audio)
    await until(() => store.get().connection.status === "outdated")
    await new Promise((r) => setTimeout(r, 200))
    expect(hellos).toBe(1)
  })

  it("shows connecting (not reconnecting) until the first welcome", async () => {
    const { store } = connect("ws://127.0.0.1:1", fakeAudio().audio)
    await until(() => store.get().connection.attempt >= 2)
    expect(store.get().connection.status).toBe("connecting")
  })

  it("ignores unknown message types and counts invalid ones", async () => {
    const { url, peers } = await startServer()
    const { store, conn } = connect(url, fakeAudio().audio)
    await until(() => conn.isOpen())
    peers[0]!.ws.send(JSON.stringify({ type: "from.the.future", x: 1 }))
    peers[0]!.ws.send(JSON.stringify({ type: "state", state: "dancing" }))
    peers[0]!.ws.send(encodeServerMessage({ type: "state", state: "thinking", turnId: 3 } satisfies ServerMessage))
    await until(() => store.get().session.serverState === "thinking")
    expect(conn.stats()).toMatchObject({ unknownMessages: 1, invalidMessages: 1 })
  })

  it("backoff doubles from 250 ms to a 5 s cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map((n) => backoffMs(n))).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000])
  })
})
