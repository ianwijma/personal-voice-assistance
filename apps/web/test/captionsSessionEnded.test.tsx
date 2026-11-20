import { act, render } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { type AddressInfo } from "node:net"
import { type ClientMessage, CloseCode, decodeClientMessage, encodeServerMessage, type ServerMessage } from "@pva/protocol"
import { serverExamples } from "@pva/protocol/examples"
import { WebSocket as WsClient, WebSocketServer, type WebSocket as ServerSocket } from "ws"
import type { AssistantClient } from "@/lib/client.ts"
import { type AudioPort, makeConnection } from "@/lib/connection.ts"
import { createClientStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { Captions } from "@/components/Captions.tsx"

// P5 review round 4 (p5-r4b finding 1): the caption the stage remembers while it fades belongs to its session. When
// the server ends the device's session (CloseCode.settingsChanged), the old text is nowhere in the page: not during the
// outage, not after the successor's welcome, not when audio is claimed again with no new caption.

/** The page's `WebSocket`, played by the `ws` package (as in connection.test.ts). */
class TestWebSocket extends WsClient {
  constructor(url: string) {
    super(url)
    this.on("error", () => undefined)
  }
}
beforeAll(() => void vi.stubGlobal("WebSocket", TestWebSocket))
afterAll(() => void vi.unstubAllGlobals())

const servers: Array<WebSocketServer> = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const s of stops.splice(0)) s()
  for (const s of servers.splice(0)) {
    for (const c of s.clients) c.terminate()
    await new Promise((r) => s.close(r))
  }
})

interface Peer {
  readonly ws: ServerSocket
  readonly text: Array<ClientMessage>
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await act(async () => void (await new Promise((r) => setTimeout(r, 5))))
  }
}

const timing = { openTimeoutMs: 1000, welcomeTimeoutMs: 2000, pingEveryMs: 1000, pongTimeoutMs: 1500, requestTimeoutMs: 300, backoffBaseMs: 20, backoffMaxMs: 80 }

const audio: AudioPort = { replyStart: () => {}, replyFrame: () => {}, replyEnd: () => {}, replyStop: () => {}, socketLost: () => {}, running: () => true }

describe("the stage's caption and a session the server ended", () => {
  it("a caption on screen, then 4205: the old text is not in the page during the outage, after the welcome, or after an audio claim", async () => {
    let answer = true
    const peers: Array<Peer> = []
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    servers.push(wss)
    wss.on("connection", (ws) => {
      const peer: Peer = { ws, text: [] }
      peers.push(peer)
      ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) return
        const d = decodeClientMessage(data.toString())
        if (d._tag !== "Ok") return
        peer.text.push(d.message)
        if (d.message.type === "hello" && answer) ws.send(encodeServerMessage(serverExamples.welcome))
        if (d.message.type === "ping") ws.send(encodeServerMessage({ type: "pong", id: d.message.id }))
      })
    })
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()))
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
    const store = createClientStore()
    const conn = makeConnection({ url, clientId: "c-test-0001", store, audio, timing, hooks: {} })
    stops.push(conn.start())
    const client = { store } as unknown as AssistantClient
    const { container } = render(<ClientContext.Provider value={client}><Captions /></ClientContext.Provider>)
    await until(() => store.get().connection.status === "open")
    const send = (m: ServerMessage) => peers.at(-1)!.ws.send(encodeServerMessage(m))
    const SECRET = "Sam's private appointment at the clinic"
    // Another tab of the device owns the audio (the welcome says so); this page shows what is being heard.
    send({ type: "state", state: "hearing" })
    send({ type: "transcript", text: SECRET })
    await until(() => container.textContent?.includes(SECRET) === true)
    // The caption goes (hearing over); it is kept while it fades, as before.
    send({ type: "state", state: "listening" })
    await until(() => store.get().session.serverState === "listening")
    // The server ends the session; the successor's welcome is withheld for now (the outage).
    answer = false
    peers[0]!.ws.close(CloseCode.settingsChanged, "settings changed")
    await until(() => peers.length === 2 && peers[1]!.text.some((m) => m.type === "hello"))
    expect(store.get().connection.status).not.toBe("open")
    expect(container.textContent ?? "").not.toContain(SECRET)
    // The successor's welcome: a page whose audio is owned elsewhere, so the caption's place is reserved again.
    send(serverExamples.welcome)
    await until(() => store.get().connection.status === "open")
    expect(container.querySelector("[data-testid=captions]")).not.toBeNull()
    expect(container.textContent ?? "").not.toContain(SECRET)
    // An audio claim with no new caption.
    send({ type: "session", role: "observer", ownerPresent: true, reason: "taken_over" })
    send({ type: "state", state: "listening" })
    await until(() => store.get().session.ownerPresent)
    await act(async () => void (await new Promise((r) => setTimeout(r, 50))))
    expect(container.querySelector("[data-testid=captions]")).not.toBeNull()
    expect(container.textContent ?? "").not.toContain(SECRET)
    expect(container.innerHTML).not.toContain("clinic")
  })
})
