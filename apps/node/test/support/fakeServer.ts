/**
 * A scripted assistant server for the node's tests: a real `ws` WebSocket server on a random local port that speaks
 * the real protocol codecs of `@pva/protocol` (text frames through `decodeClientMessage` / `encodeServerMessage`,
 * binary frames through `decodeMicFrame` / `encodeReplyFrame`). It answers `hello` with `welcome` (protocol-version
 * checked, as the server does) and `ping` with `pong`; everything else is driven by the test.
 *
 * Protocol 9 (docs/VOICE-NODES.md §6.1): a `hello` without `node`, from a device that is not a `voice-node`, or with
 * a credential other than `credential` (when given) is closed with 4403 and no `welcome`. `setup` is sent in
 * `welcome.snapshot.setup`. With `tls` the server speaks wss on a self-signed certificate (for the pin tests).
 */
import * as https from "node:https"
import type { AddressInfo } from "node:net"
import {
  type ClientMessage,
  type ClientMessageOf,
  type ClientMessageType,
  decodeClientMessage,
  CloseCode,
  decodeMicFrame,
  type DeviceSetup,
  encodeReplyFrame,
  encodeServerMessage,
  type MicFrame,
  PROTOCOL_VERSION,
  type ServerMessage,
  VOICE_NODE_KIND
} from "@pva/protocol"
import { exampleSnapshot } from "@pva/protocol/examples"
import { type WebSocket, WebSocketServer } from "ws"

export interface FakeServerOptions {
  /** Answer `hello` with `welcome` (default true). */
  readonly welcome?: boolean
  /** Make the welcomed connection the audio owner on its `audio.claim` (default true). */
  readonly grantClaims?: boolean
  /** The only credential accepted (default: any well-formed one, as the codec checked it). */
  readonly credential?: string
  /** `welcome.snapshot.setup`. */
  readonly setup?: DeviceSetup
  /** Serve wss with this key and certificate instead of ws. */
  readonly tls?: { readonly key: string; readonly cert: string }
}

interface FakeServerState {
  welcome: boolean
  grantClaims: boolean
  credential: string | undefined
  setup: DeviceSetup | undefined
}

interface Waiter {
  readonly match: () => boolean
  readonly resolve: () => void
}

export class FakeConnection {
  readonly messages: Array<{ readonly at: number; readonly message: ClientMessage }> = []
  readonly micFrames: Array<MicFrame> = []
  readonly closed: Promise<void>
  readonly ws: WebSocket
  private readonly waiters: Array<Waiter> = []
  private readonly options: FakeServerState

  constructor(ws: WebSocket, options: FakeServerState) {
    this.ws = ws
    this.options = options
    this.closed = new Promise((resolve) => ws.on("close", () => resolve()))
    ws.on("message", (data, isBinary) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (isBinary) {
        const frame = decodeMicFrame(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
        if (!frame.ok) throw new Error(`node sent a bad frame: ${frame.error}`)
        this.micFrames.push({ ...frame.frame, pcm: frame.frame.pcm.slice() })
      } else {
        const decoded = decodeClientMessage(buffer.toString("utf8"))
        if (decoded._tag !== "Ok") throw new Error(`node sent an invalid message: ${JSON.stringify(decoded)}`)
        this.onMessage(decoded.message)
      }
      this.check()
    })
  }

  private onMessage(m: ClientMessage) {
    this.messages.push({ at: performance.now(), message: m })
    if (m.type === "hello") {
      if (m.protocol !== PROTOCOL_VERSION) return this.ws.close(4400, "protocol mismatch")
      const credential = m.node?.credential
      if (m.device?.kind !== VOICE_NODE_KIND || credential === undefined || (this.options.credential !== undefined && credential !== this.options.credential)) {
        return this.ws.close(CloseCode.unauthorized, "unauthorized")
      }
      if (this.options.welcome) {
        const setup = this.options.setup
        this.send({
          type: "welcome",
          protocol: PROTOCOL_VERSION,
          server: { name: "fake", version: "0" },
          connectionId: "c1",
          snapshot: { ...exampleSnapshot, role: "observer", ownerPresent: false, ...(setup !== undefined ? { setup } : {}) }
        })
      }
    } else if (m.type === "ping") {
      this.send({ type: "pong", id: m.id })
    } else if (m.type === "audio.claim" && this.options.grantClaims) {
      this.send({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    }
  }

  private check() {
    for (const w of [...this.waiters]) {
      if (w.match()) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        w.resolve()
      }
    }
  }

  send(message: ServerMessage) {
    this.ws.send(encodeServerMessage(message))
  }

  sendRaw(text: string) {
    this.ws.send(text)
  }

  sendReplyFrame(turnId: number, pcm: Uint8Array) {
    this.ws.send(encodeReplyFrame(turnId, pcm))
  }

  of<T extends ClientMessageType>(type: T): Array<ClientMessageOf<T>> {
    return this.messages.filter((m) => m.message.type === type).map((m) => m.message as ClientMessageOf<T>)
  }

  /** Resolve once `predicate` holds (checked after every message from the node). */
  until(predicate: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
    if (predicate()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs)
      this.waiters.push({ match: predicate, resolve: () => {
        clearTimeout(timer)
        resolve()
      } })
    })
  }

  waitFor<T extends ClientMessageType>(type: T, count = 1, timeoutMs = 3000): Promise<Array<ClientMessageOf<T>>> {
    return this.until(() => this.of(type).length >= count, timeoutMs, `${count} × ${type}`).then(() => this.of(type))
  }

  close(code = 1000, reason = "") {
    this.ws.close(code, reason)
  }
}

export class FakeServer {
  readonly connections: Array<FakeConnection> = []
  private readonly wss: WebSocketServer
  private readonly waiters: Array<{ count: number; resolve: (c: FakeConnection) => void }> = []
  /** Read on every message, so a test can change it while connections are open. */
  readonly options: FakeServerState

  private readonly tlsServer: https.Server | undefined
  private readonly secure: boolean

  private constructor(wss: WebSocketServer, options: FakeServerOptions, tlsServer?: https.Server) {
    this.wss = wss
    this.tlsServer = tlsServer
    this.secure = tlsServer !== undefined
    this.options = { welcome: options.welcome ?? true, grantClaims: options.grantClaims ?? true, credential: options.credential, setup: options.setup }
    wss.on("connection", (ws) => {
      const connection = new FakeConnection(ws, this.options)
      this.connections.push(connection)
      for (const w of [...this.waiters]) {
        if (this.connections.length >= w.count) {
          this.waiters.splice(this.waiters.indexOf(w), 1)
          w.resolve(this.connections[w.count - 1]!)
        }
      }
    })
  }

  static start(options: FakeServerOptions = {}): Promise<FakeServer> {
    const tls = options.tls
    if (tls !== undefined) {
      return new Promise((resolve) => {
        const tlsServer = https.createServer(tls)
        const wss: WebSocketServer = new WebSocketServer({ server: tlsServer, path: "/ws" })
        tlsServer.listen(0, "127.0.0.1", () => resolve(new FakeServer(wss, options, tlsServer)))
      })
    }
    return new Promise((resolve) => {
      const wss: WebSocketServer = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/ws" }, (): void => resolve(new FakeServer(wss, options)))
    })
  }

  get url(): string {
    const port = this.tlsServer !== undefined ? (this.tlsServer.address() as AddressInfo).port : (this.wss.address() as AddressInfo).port
    return `${this.secure ? "https" : "http"}://127.0.0.1:${port}`
  }

  /** The `n`-th connection (1-based), once it exists. */
  connection(n = 1, timeoutMs = 5000): Promise<FakeConnection> {
    if (this.connections.length >= n) return Promise.resolve(this.connections[n - 1]!)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for connection ${n}`)), timeoutMs)
      this.waiters.push({ count: n, resolve: (c) => {
        clearTimeout(timer)
        resolve(c)
      } })
    })
  }

  stop(): Promise<void> {
    for (const c of this.connections) c.ws.terminate()
    return new Promise((resolve) =>
      this.wss.close(() => {
        if (this.tlsServer !== undefined) this.tlsServer.close(() => resolve())
        else resolve()
      })
    )
  }
}
