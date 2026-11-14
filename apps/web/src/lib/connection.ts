import {
  type ClientMessage,
  CloseCode,
  decodeReplyFrame,
  type DeviceHello,
  type FrontendRole,
  decodeServerMessage,
  encodeClientMessage,
  FrameKind,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ServerMessageOf,
  writeFrameHeader
} from "@pva/protocol"
import { Data, Deferred, Duration, Effect, Fiber } from "effect"
import type { ClientStore } from "./store.ts"

/**
 * The connection to the assistant: one WebSocket, managed by an Effect fiber
 * (open, handshake, liveness, reconnect with backoff). Framework-free: it only
 * sees the store (`dispatch`, `get`) and the audio port.
 *
 * Incoming frames are handled synchronously in `onmessage`: reply audio goes
 * from the socket to the player worklet with no queue hop, and every text
 * message is decoded once and dispatched in order.
 */

export type ResultMessage = ServerMessageOf<"result">

/** What the connection needs from the audio engine. */
export interface AudioPort {
  readonly replyStart: (turnId: number, sampleRate: number) => void
  readonly replyFrame: (buffer: ArrayBuffer) => void
  readonly replyEnd: (turnId: number) => void
  readonly replyStop: (turnId: number) => void
  /** The socket closed: flush the player without reporting, stop sending. */
  readonly socketLost: () => void
  /** The page's audio graph is running (so a reconnect may resume ownership). */
  readonly running: () => boolean
}

export interface ConnectionHooks {
  /** After every server message is dispatched (session changes, interruptions, …). */
  readonly afterMessage?: (message: ServerMessage, previousRole: "owner" | "observer") => void
  /** After a `welcome`: `resumed` = this tab is the owner again after a reconnect. */
  readonly afterWelcome?: (resumed: boolean) => void
}

/** What `hello` says about the page (protocol 5): read on every connect, so a new admin token is sent after a login. */
export interface HelloIdentity {
  readonly frontend: FrontendRole
  /** Voice front end: this browser as a device. */
  readonly device?: DeviceHello
  /** Admin front end: the session token from `sessionStorage`, if any. */
  readonly adminToken?: string
}

export interface ConnectionOptions {
  readonly url: string
  readonly clientId: string
  /** Default: a voice page without a device. */
  readonly identity?: () => HelloIdentity
  readonly store: ClientStore
  readonly audio: AudioPort
  readonly hooks?: ConnectionHooks
  /** Override timings (tests). */
  readonly timing?: Partial<Timing>
}

export interface Timing {
  readonly openTimeoutMs: number
  readonly welcomeTimeoutMs: number
  readonly pingEveryMs: number
  readonly pongTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly backoffBaseMs: number
  readonly backoffMaxMs: number
}

export const defaultTiming: Timing = {
  openTimeoutMs: 5000,
  welcomeTimeoutMs: 5000,
  pingEveryMs: 5000,
  pongTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  backoffBaseMs: 250,
  backoffMaxMs: 5000
}

/** Microphone frames are dropped (not queued) when more than this is waiting to be sent: 500 ms of audio. */
export const MIC_BUFFER_LIMIT = 16_000

/** Backoff before reconnect attempt `n` (1-based): 250 ms doubling, capped at 5 s. */
export const backoffMs = (n: number, timing: Pick<Timing, "backoffBaseMs" | "backoffMaxMs"> = defaultTiming) =>
  Math.min(timing.backoffBaseMs * 2 ** Math.max(0, n - 1), timing.backoffMaxMs)

export class ConnectionLost extends Data.TaggedError("ConnectionLost")<{
  readonly code: number
  readonly reason: string
  readonly welcomed: boolean
}> {}

type RequestMessage = Extract<ClientMessage, { readonly requestId: string }>
type WithoutRequestId<M> = M extends unknown ? Omit<M, "requestId"> : never
export type RequestInput = WithoutRequestId<RequestMessage>

export interface Connection {
  /** Start the connection fiber; returns a function that stops it (and closes the socket). */
  readonly start: () => () => void
  /** Fire and forget; dropped while not connected. */
  readonly send: (message: ClientMessage) => boolean
  /** Send a request and wait for its `result` (10 s timeout; immediate failure while disconnected). */
  readonly request: (message: RequestInput) => Promise<ResultMessage>
  /** Send a microphone frame (header space + PCM) if this tab may; otherwise drop it. */
  readonly sendMic: (buffer: ArrayBuffer) => void
  /** The next microphone frame is sequence 0 (after a claim, an unmute, a resumed connection). */
  readonly resetMicSequence: () => void
  /** Hold microphone frames back (manual interrupt mode while the reply is audible). */
  readonly setMicGate: (open: boolean) => void
  readonly isOpen: () => boolean
  /** Counters for diagnostics and tests. */
  readonly stats: () => { readonly micSent: number; readonly micDropped: number; readonly unknownMessages: number; readonly invalidMessages: number }
}

const localFailure = (requestId: string, message: string): ResultMessage => ({
  type: "result",
  requestId,
  ok: false,
  error: { code: "internal", message }
})

export const makeConnection = (options: ConnectionOptions): Connection => {
  const { store, audio, hooks = {} } = options
  const timing: Timing = { ...defaultTiming, ...options.timing }

  let ws: WebSocket | undefined
  let welcomed = false
  let micSeq = 0
  let micGateOpen = true
  let wasOwner = false
  const counters = { micSent: 0, micDropped: 0, unknownMessages: 0, invalidMessages: 0 }
  let requestSeq = 0
  const pendingRequests = new Map<string, { resolve: (r: ResultMessage) => void; timer: ReturnType<typeof setTimeout> }>()
  let pingSeq = 0
  let outstandingPing: { id: number; at: number } | undefined

  const isOpen = () => ws !== undefined && welcomed && ws.readyState === WebSocket.OPEN

  const sendRaw = (socket: WebSocket, message: ClientMessage) => {
    socket.send(encodeClientMessage(message))
  }

  const send = (message: ClientMessage): boolean => {
    if (!isOpen()) return false
    sendRaw(ws!, message)
    return true
  }

  const settle = (requestId: string, result: ResultMessage) => {
    const p = pendingRequests.get(requestId)
    if (p === undefined) return
    clearTimeout(p.timer)
    pendingRequests.delete(requestId)
    store.dispatch({ type: "local/request-done", requestId })
    p.resolve(result)
  }

  const request = (message: RequestInput): Promise<ResultMessage> => {
    const requestId = `r${++requestSeq}-${Date.now().toString(36)}`
    const full = { ...message, requestId } as RequestMessage
    if (!isOpen()) return Promise.resolve(localFailure(requestId, "Not connected to the assistant."))
    const target = "moduleId" in full ? full.moduleId : "sectionId" in full ? full.sectionId : undefined
    store.dispatch(target === undefined ? { type: "local/request", requestId, kind: full.type } : { type: "local/request", requestId, kind: full.type, target })
    return new Promise<ResultMessage>((resolve) => {
      const timer = setTimeout(() => settle(requestId, localFailure(requestId, "The assistant did not answer in time.")), timing.requestTimeoutMs)
      pendingRequests.set(requestId, { resolve, timer })
      sendRaw(ws!, full)
    })
  }

  const sendMic = (buffer: ArrayBuffer) => {
    const s = store.get()
    if (!isOpen() || s.session.role !== "owner" || !s.audio.micLive || !micGateOpen) return
    const socket = ws!
    writeFrameHeader(new Uint8Array(buffer, 0, 8), FrameKind.mic, micSeq)
    micSeq = (micSeq + 1) >>> 0
    if (socket.bufferedAmount > MIC_BUFFER_LIMIT) {
      // A growing queue is latency: drop. The server sees the sequence gap.
      counters.micDropped++
      return
    }
    socket.send(buffer)
    counters.micSent++
  }

  const resetMicSequence = () => {
    micSeq = 0
  }

  // ---- Incoming frames ----

  const onText = (text: string, welcomedSignal: Deferred.Deferred<void>) => {
    const decoded = decodeServerMessage(text)
    if (decoded._tag === "Unknown") {
      counters.unknownMessages++
      return
    }
    if (decoded._tag === "Invalid") {
      counters.invalidMessages++
      console.warn(`[pva] invalid message from the assistant${decoded.messageType ? ` (${decoded.messageType})` : ""}: ${decoded.reason}`)
      return
    }
    const m = decoded.message
    const previousRole = store.get().session.role
    const owner = previousRole === "owner" && audio.running()
    switch (m.type) {
      case "welcome": {
        if (m.protocol !== PROTOCOL_VERSION) return // the server closes with 4400
        welcomed = true
        outstandingPing = undefined
        store.dispatch(m)
        Deferred.doneUnsafe(welcomedSignal, Effect.void)
        const resumed = m.snapshot.role === "owner" && audio.running()
        if (resumed) micSeq = 0
        hooks.afterWelcome?.(resumed)
        return
      }
      case "pong":
        if (outstandingPing?.id === m.id) outstandingPing = undefined
        return
      case "result":
        store.dispatch(m)
        settle(m.requestId, m)
        return
      case "reply.start":
        if (owner) audio.replyStart(m.turnId, m.sampleRate)
        break
      case "reply.end":
        if (owner) audio.replyEnd(m.turnId)
        break
      case "reply.stop":
        if (owner) audio.replyStop(m.turnId)
        break
    }
    store.dispatch(m)
    hooks.afterMessage?.(m, previousRole)
  }

  const onBinary = (buffer: ArrayBuffer) => {
    const frame = decodeReplyFrame(buffer)
    if (!frame.ok) {
      counters.invalidMessages++
      return
    }
    if (store.get().session.role === "owner" && audio.running()) audio.replyFrame(buffer)
  }

  // ---- The Effect program ----

  const open = Effect.callback<WebSocket, ConnectionLost>((resume) => {
    const socket = new WebSocket(options.url)
    socket.binaryType = "arraybuffer"
    socket.onopen = () => resume(Effect.succeed(socket))
    socket.onclose = (e) => resume(Effect.fail(new ConnectionLost({ code: e.code, reason: e.reason || "could not connect", welcomed: false })))
    return Effect.sync(() => {
      // Interrupted while connecting (timeout or stop).
      socket.onopen = null
      socket.onclose = null
      socket.close()
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timing.openTimeoutMs),
      orElse: () => Effect.fail(new ConnectionLost({ code: 0, reason: "connect timeout", welcomed: false }))
    })
  )

  const closeSocket = (socket: WebSocket) =>
    Effect.sync(() => {
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      if (ws === socket) ws = undefined
      welcomed = false
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000)
    })

  const pinger = (socket: WebSocket) =>
    Effect.gen(function*() {
      while (true) {
        yield* Effect.sleep(Duration.millis(timing.pingEveryMs))
        const now = performance.now()
        // Judged on the outstanding ping, not on the timer, so throttled background timers don't cause false alarms.
        if (outstandingPing !== undefined && now - outstandingPing.at > timing.pongTimeoutMs) {
          return yield* new ConnectionLost({ code: 0, reason: "no pong", welcomed: true })
        }
        if (outstandingPing === undefined) {
          outstandingPing = { id: pingSeq, at: now }
          pingSeq = (pingSeq + 1) % 0x7fff_ffff
          sendRaw(socket, { type: "ping", id: outstandingPing.id })
        }
      }
    })

  /** One connection attempt. Never succeeds: it fails with `ConnectionLost` when the socket goes. */
  const session = Effect.gen(function*() {
    const socket = yield* Effect.acquireRelease(open, closeSocket)
    const closed = yield* Deferred.make<never, ConnectionLost>()
    const welcomedSignal = yield* Deferred.make<void>()
    ws = socket
    welcomed = false
    socket.onclose = (e) => {
      Deferred.doneUnsafe(closed, Effect.fail(new ConnectionLost({ code: e.code, reason: e.reason, welcomed })))
    }
    socket.onerror = () => undefined // a close event follows
    socket.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      try {
        if (typeof e.data === "string") onText(e.data, welcomedSignal)
        else onBinary(e.data)
      } catch (error) {
        console.error("[pva] failed to handle a message", error)
      }
    }
    const identity = options.identity?.() ?? { frontend: "voice" as const }
    sendRaw(socket, {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      clientId: options.clientId,
      // An admin page never owns the audio.
      resumeOwner: identity.frontend === "voice" && wasOwner && audio.running(),
      frontend: identity.frontend,
      ...(identity.device !== undefined ? { device: identity.device } : {}),
      ...(identity.adminToken !== undefined ? { adminToken: identity.adminToken } : {})
    })
    yield* Deferred.await(welcomedSignal).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timing.welcomeTimeoutMs),
        orElse: () => Effect.fail(new ConnectionLost({ code: 0, reason: "no welcome", welcomed: false }))
      }),
      Effect.raceFirst(Deferred.await(closed))
    )
    return yield* pinger(socket).pipe(Effect.raceFirst(Deferred.await(closed)))
  })

  const onLost = (error: ConnectionLost) => {
    wasOwner = store.get().session.role === "owner"
    outstandingPing = undefined
    for (const [requestId] of pendingRequests) settle(requestId, localFailure(requestId, "The connection to the assistant was lost."))
    audio.socketLost()
    store.dispatch({ type: "local/socket-lost" })
    return error
  }

  const program = Effect.gen(function*() {
    let failures = 0
    while (true) {
      const error = yield* Effect.scoped(session).pipe(Effect.flip)
      onLost(error)
      if (error.code === CloseCode.protocolMismatch) {
        store.dispatch({ type: "local/connection", status: "outdated", attempt: 0 })
        return
      }
      if (error.welcomed) failures = 0
      failures++
      const everConnected = store.get().connection.everConnected
      store.dispatch({ type: "local/connection", status: everConnected ? "reconnecting" : "connecting", attempt: failures })
      yield* Effect.sleep(Duration.millis(backoffMs(failures, timing)))
    }
  })

  const start = () => {
    const fiber = Effect.runFork(program)
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }

  return {
    start,
    send,
    request,
    sendMic,
    resetMicSequence,
    setMicGate: (open) => {
      micGateOpen = open
    },
    isOpen,
    stats: () => ({ ...counters })
  }
}

/** The WebSocket URL: `?ws=` override, the build-time variable, the dev default, else same origin. */
export const resolveWsUrl = (location: Pick<Location, "protocol" | "host" | "hostname" | "search">): string => {
  const override = new URLSearchParams(location.search).get("ws")
  if (override !== null && /^wss?:\/\//.test(override)) return override
  const env = process.env.NEXT_PUBLIC_PVA_WS_URL
  if (env !== undefined && env !== "") return env
  const scheme = location.protocol === "https:" ? "wss" : "ws"
  if (process.env.NODE_ENV === "development") return `${scheme}://${location.hostname}:8787/ws`
  return `${scheme}://${location.host}/ws`
}
