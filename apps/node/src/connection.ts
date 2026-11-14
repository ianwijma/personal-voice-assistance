/**
 * The WebSocket to the assistant (docs/VOICE-NODES.md §7.4): open, `hello`, wait for `welcome`, ping every 5 s,
 * and report why it ended. The reconnect policy (`reconnectDelay`, `closeAction`) is pure so it can be tested.
 *
 * Uses the `ws` package rather than Node 22's global `WebSocket`: it exposes `bufferedAmount` the same way, and
 * takes an `https.Agent` / `checkServerIdentity`, which WP-10 needs for the `tlsPin` of a self-signed server.
 */
import {
  type ClientMessage,
  CloseCode,
  decodeReplyFrame,
  decodeServerMessage,
  encodeClientMessage,
  PROTOCOL_VERSION,
  type ServerMessage
} from "@pva/protocol"
import { Data, Deferred, Effect, type Scope } from "effect"
import WebSocket from "ws"

export interface Timing {
  readonly openTimeoutMs: number
  readonly welcomeTimeoutMs: number
  readonly pingEveryMs: number
  readonly pongTimeoutMs: number
  /** Reconnect backoff: `backoffBaseMs` doubling to `backoffMaxMs`, with jitter (§7.4: 0.5 s → 30 s, for ever). */
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
  /** After the server refused this node's credential (4403, §5.1): retry only this often. */
  readonly unauthorizedRetryMs: number
  /** After `sessions_full`: claim again this much later. */
  readonly claimRetryMs: number
}

export const defaultTiming: Timing = {
  openTimeoutMs: 5000,
  welcomeTimeoutMs: 5000,
  pingEveryMs: 5000,
  pongTimeoutMs: 10_000,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  unauthorizedRetryMs: 10 * 60_000,
  claimRetryMs: 10_000
}

/**
 * TODO(WP-6): protocol 7's `CloseCode.unauthorized` (a voice-node hello without a valid credential, or a removed
 * node). Declared here so the reconnect policy already handles it; replace with the protocol constant.
 */
export const UNAUTHORIZED_CLOSE_CODE = 4403

/** Delay before reconnect attempt `attempt` (1-based): exponential, capped, "equal jitter" (half fixed, half random). */
export const reconnectDelay = (attempt: number, timing: Pick<Timing, "backoffBaseMs" | "backoffMaxMs">, random: () => number = Math.random): number => {
  const ceiling = Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

export type CloseAction = "retry" | "outdated" | "unauthorized"

export const closeAction = (code: number): CloseAction =>
  code === CloseCode.protocolMismatch ? "outdated" : code === UNAUTHORIZED_CLOSE_CODE ? "unauthorized" : "retry"

export class ConnectionLost extends Data.TaggedError("ConnectionLost")<{
  readonly code: number
  readonly reason: string
  /** A `welcome` was received on this connection (resets the backoff). */
  readonly welcomed: boolean
}> {}

/** What the connection hands to whoever drives the protocol. */
export interface ConnectionHandlers {
  readonly onMessage: (message: ServerMessage) => void
  readonly onUndecodable: (text: string) => void
  readonly onReplyFrame: (turnId: number, pcm: Uint8Array) => void
}

export interface OpenSocket {
  readonly send: (message: ClientMessage) => void
  readonly sendBinary: (frame: Uint8Array) => void
  readonly bufferedAmount: () => number
}

export type HelloMessage = Extract<ClientMessage, { readonly type: "hello" }>

const toBytes = (data: WebSocket.RawData): Uint8Array => {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

const openSocket = (url: string, timing: Timing) =>
  Effect.callback<WebSocket, ConnectionLost>((resume) => {
    const ws = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 })
    const fail = (code: number, reason: string) => resume(Effect.fail(new ConnectionLost({ code, reason, welcomed: false })))
    ws.once("open", () => resume(Effect.succeed(ws)))
    ws.once("error", (e) => fail(0, e.message))
    ws.once("unexpected-response", (_req, res) => fail(0, `HTTP ${res.statusCode ?? "?"} instead of a WebSocket`))
    return Effect.sync(() => ws.terminate())
  }).pipe(
    Effect.timeoutOrElse({
      duration: timing.openTimeoutMs,
      orElse: () => Effect.fail(new ConnectionLost({ code: 0, reason: "connect timeout", welcomed: false }))
    })
  )

/**
 * One connection: open, hello, welcome, then ping until the socket goes. Never succeeds; fails with
 * `ConnectionLost`. `attach` is called once the socket is open (before `hello`) and returns the handlers for it.
 */
export const connectOnce = (
  url: string,
  hello: HelloMessage,
  attach: (socket: OpenSocket) => ConnectionHandlers,
  timing: Timing = defaultTiming
): Effect.Effect<never, ConnectionLost, Scope.Scope> =>
  Effect.gen(function*() {
    const ws = yield* Effect.acquireRelease(openSocket(url, timing), (ws) =>
      Effect.sync(() => {
        ws.removeAllListeners()
        ws.on("error", () => {})
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000)
        // A peer that does not answer the close handshake must not keep the socket for ever.
        setTimeout(() => ws.terminate(), 1000).unref()
      }))
    let welcomed = false
    const closed = yield* Deferred.make<never, ConnectionLost>()
    const welcome = yield* Deferred.make<void>()
    let outstandingPing: { id: number; at: number } | undefined
    let pingSeq = 0

    const socket: OpenSocket = {
      send: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(encodeClientMessage(message))
      },
      sendBinary: (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame)
      },
      bufferedAmount: () => ws.bufferedAmount
    }
    const handlers = attach(socket)

    ws.on("close", (code, reason) => {
      Deferred.doneUnsafe(closed, Effect.fail(new ConnectionLost({ code, reason: reason.toString() || "closed", welcomed })))
    })
    ws.on("error", () => {}) // a close event follows
    ws.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          const frame = decodeReplyFrame(toBytes(data))
          if (frame.ok) handlers.onReplyFrame(frame.frame.turnId, frame.frame.pcm)
          return
        }
        const text = toBytes(data)
        const decoded = decodeServerMessage(Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString("utf8"))
        if (decoded._tag === "Unknown") return
        if (decoded._tag === "Invalid") {
          handlers.onUndecodable(Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString("utf8"))
          return
        }
        const m = decoded.message
        if (m.type === "welcome") {
          if (m.protocol !== PROTOCOL_VERSION) return // the server closes with 4400
          welcomed = true
          Deferred.doneUnsafe(welcome, Effect.void)
        } else if (m.type === "pong") {
          if (outstandingPing?.id === m.id) outstandingPing = undefined
          return
        }
        handlers.onMessage(m)
      } catch (error) {
        console.error("[pva-node] failed to handle a message", error)
      }
    })

    socket.send(hello)
    yield* Deferred.await(welcome).pipe(
      Effect.timeoutOrElse({
        duration: timing.welcomeTimeoutMs,
        orElse: () => Effect.fail(new ConnectionLost({ code: 0, reason: "no welcome", welcomed: false }))
      }),
      Effect.raceFirst(Deferred.await(closed))
    )

    const pinger = Effect.gen(function*() {
      while (true) {
        yield* Effect.sleep(timing.pingEveryMs)
        const now = performance.now()
        if (outstandingPing !== undefined && now - outstandingPing.at > timing.pongTimeoutMs) {
          return yield* new ConnectionLost({ code: 0, reason: "no pong", welcomed: true })
        }
        if (outstandingPing === undefined) {
          outstandingPing = { id: pingSeq, at: now }
          pingSeq = (pingSeq + 1) % 0x7fff_ffff
          socket.send({ type: "ping", id: outstandingPing.id })
        }
      }
    })
    return yield* pinger.pipe(Effect.raceFirst(Deferred.await(closed)))
  })
