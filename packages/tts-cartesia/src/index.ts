/**
 * Tts via the Cartesia Sonic WebSocket (contexts/continuations, raw pcm_s16le).
 * Wire reference: docs/protocols/cartesia-tts.md.
 */
import { randomUUID } from "node:crypto"
import { Tts, type TtsAudio, TtsError } from "@pva/core"
import { Cause, Config, Effect, Layer, Queue, Redacted, Stream } from "effect"
import WebSocket from "ws"

export const CARTESIA_VERSION = "2026-08-14"
export const DEFAULT_BASE_URL = "wss://api.cartesia.ai"
/** Docs: "We recommend using Sonic 3.6". Configurable because 3.5 may be faster; measure with TurnTrace. */
export const DEFAULT_MODEL = "sonic-3.6"
/** "Skylar" (en-US), one of the stable voices the docs recommend for voice agents. */
export const DEFAULT_VOICE = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"

export interface CartesiaOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly model?: string
  readonly voice?: string
  readonly language?: string
  /** Output rate in Hz (8000, 16000, 22050, 24000, 44100 or 48000). Default 24000. */
  readonly sampleRate?: number
  /**
   * Server-side text buffering (0–5000 ms): higher waits for more text (better
   * prosody), lower starts sooner. Default 0: the clause chunker already
   * buffers client-side, which is the case the docs give for 0, and every
   * clause is flushed anyway (see `synthesize`).
   */
  readonly maxBufferDelayMs?: number
  /** Default `wss://api.cartesia.ai`; tests point it at a local server. */
  readonly baseUrl?: string
  /** How long a turn waits for a (re)connect before failing. Default 2000. */
  readonly connectTimeoutMs?: number
  /** Ping interval; a socket that answered nothing for a whole interval is dropped. Default 30000. */
  readonly pingIntervalMs?: number
  /** Reopen an idle socket after this long, before the server's 5-minute idle close. Default 240000. */
  readonly idleRefreshMs?: number
  /** After end of input, end the turn if the context stays silent this long (no `done`). Default 5000. */
  readonly drainTimeoutMs?: number
}

/** Fields of any server message we look at. Parsed with JSON.parse and narrowed by hand: this is the per-chunk hot path. */
interface ServerMessage {
  readonly type?: unknown
  readonly context_id?: unknown
  readonly data?: unknown
  readonly done?: unknown
  readonly status_code?: unknown
  readonly error_code?: unknown
  readonly title?: unknown
  readonly message?: unknown
  readonly error?: unknown
}

interface Route {
  readonly socket: WebSocket
  readonly message: (msg: ServerMessage) => void
  readonly closed: (message: string) => void
}

const describeError = (msg: ServerMessage): string => {
  const parts = [msg.status_code, msg.error_code, msg.title, msg.message, msg.error]
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map(String)
  return `Cartesia error: ${parts.length > 0 ? parts.join(" — ") : JSON.stringify(msg)}`
}

/**
 * One WebSocket shared by every turn: opened eagerly, pinged, refreshed before
 * the idle limit and reopened with backoff. Server messages are routed to the
 * turn that owns their `context_id`; messages for unknown ids (cancelled or
 * finished contexts) are dropped.
 */
const makeConnection = (
  url: string,
  headers: Record<string, string>,
  opts: { readonly pingIntervalMs: number; readonly idleRefreshMs: number },
  log: (message: string) => void
) => {
  const routes = new Map<string, Route>()
  const waiters = new Set<(socket: WebSocket) => void>()
  let current: WebSocket | undefined // open socket
  let pending: WebSocket | undefined // socket being opened
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let lastError = "not connected yet"
  let lastSent = Date.now()
  let heard = true // pong or message since the last ping
  let shut = false

  const connect = () => {
    if (shut || pending !== undefined || current !== undefined) return
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    const ws = new WebSocket(url, { headers })
    pending = ws
    let openedAt = 0
    ws.on("open", () => {
      pending = undefined
      current = ws
      openedAt = Date.now()
      lastSent = openedAt
      heard = true
      for (const waiter of waiters) waiter(ws)
      waiters.clear()
    })
    ws.on("message", (data) => {
      heard = true
      let msg: ServerMessage
      try {
        msg = JSON.parse((data as Buffer).toString())
      } catch {
        return log("Cartesia: dropped a non-JSON message")
      }
      if (typeof msg.context_id === "string") {
        // Unknown id: late output for a cancelled/finished context. Drop it.
        routes.get(msg.context_id)?.message(msg)
      } else if (msg.type === "error") {
        // Connection-level error: fail every turn on this socket.
        const message = describeError(msg)
        log(message)
        for (const route of [...routes.values()]) if (route.socket === ws) route.closed(message)
      }
    })
    ws.on("pong", () => {
      heard = true
    })
    ws.on("error", (error) => {
      lastError = error.message
    })
    ws.on("close", (code, reason) => {
      const wasActive = current === ws || pending === ws
      if (current === ws) current = undefined
      if (pending === ws) pending = undefined
      const text = reason.length > 0 ? `${code} ${reason.toString()}` : `${code}`
      if (openedAt > 0) lastError = `closed (${text})`
      const message = `Cartesia connection closed (${text})`
      for (const route of [...routes.values()]) if (route.socket === ws) route.closed(message)
      if (!wasActive || shut) return
      // A socket that dies right after opening (e.g. rejected) keeps backing off.
      if (openedAt > 0 && Date.now() - openedAt > 1000) attempt = 0
      const delay = attempt === 0 ? 0 : Math.min(250 * 2 ** (attempt - 1), 10_000)
      attempt++
      if (openedAt > 0 || attempt === 1) log(`Cartesia: ${lastError}; reconnecting in ${delay} ms`)
      reconnectTimer = setTimeout(connect, delay)
    })
  }

  const heartbeat = setInterval(() => {
    const ws = current
    if (ws === undefined) return
    if (!heard) return ws.terminate() // dead peer; `close` reconnects
    heard = false
    ws.ping()
    // The server closes idle sockets after 5 minutes; whether pings count as
    // activity is undocumented, so reopen proactively while nothing is running.
    if (routes.size === 0 && Date.now() - lastSent > opts.idleRefreshMs) ws.close(1000, "idle refresh")
  }, opts.pingIntervalMs)
  heartbeat.unref()

  connect()

  return {
    routes,
    /** The open socket, waiting up to `timeoutMs` for a (re)connect. */
    awaitOpen: (timeoutMs: number) =>
      Effect.callback<WebSocket, TtsError>((resume) => {
        if (current !== undefined) return resume(Effect.succeed(current))
        const waiter = (ws: WebSocket) => {
          clearTimeout(timer)
          resume(Effect.succeed(ws))
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          resume(Effect.fail(new TtsError({ message: `Cartesia not connected after ${timeoutMs} ms: ${lastError}` })))
        }, timeoutMs)
        waiters.add(waiter)
        connect() // skip any remaining backoff: someone is waiting
        return Effect.sync(() => {
          clearTimeout(timer)
          waiters.delete(waiter)
        })
      }),
    send: (ws: WebSocket, payload: string): boolean => {
      if (ws.readyState !== WebSocket.OPEN) return false
      ws.send(payload)
      lastSent = Date.now()
      return true
    },
    close: () => {
      shut = true
      clearInterval(heartbeat)
      clearTimeout(reconnectTimer)
      current?.close(1000, "OK")
      pending?.terminate()
    }
  }
}

/** One Cartesia context of a turn. A turn normally has one; see `rollOver`. */
interface Ctx {
  readonly id: string
  /** Index of the turn's clause that was sent first on this context. */
  readonly base: number
  /** Clauses sent / flushes acknowledged on this context. */
  sent: number
  acked: number
  audio: boolean
  lastMessageAt: number
  /** The server reported `done` before we ended the input (the context expired). */
  expired: boolean
}

/**
 * Contexts expire 1 s after their last audio. A new clause after a longer
 * silence (a tool call mid-turn) goes on a fresh context, which only costs
 * prosody continuity across the pause.
 */
const EXPIRY_MARGIN_MS = 700

export const make = Effect.fnUntraced(function*(options: CartesiaOptions) {
  const sampleRate = options.sampleRate ?? 24_000
  const connectTimeoutMs = options.connectTimeoutMs ?? 2000
  const drainTimeoutMs = options.drainTimeoutMs ?? 5000
  const apiKey = Redacted.value(options.apiKey)
  const url = `${options.baseUrl ?? DEFAULT_BASE_URL}/tts/websocket?cartesia_version=${CARTESIA_VERSION}`

  const context = yield* Effect.context<never>()
  const log = (message: string) => void Effect.runForkWith(context)(Effect.logWarning(message))

  const conn = yield* Effect.acquireRelease(
    Effect.sync(() =>
      makeConnection(
        url,
        { "X-API-Key": apiKey, "Cartesia-Version": CARTESIA_VERSION },
        { pingIntervalMs: options.pingIntervalMs ?? 30_000, idleRefreshMs: options.idleRefreshMs ?? 240_000 },
        log
      )
    ),
    (conn) => Effect.sync(conn.close)
  )

  // Fields repeated on every generation request (model, voice and format must
  // not change within a context; resending them is the documented-safe choice).
  const common = {
    model_id: options.model ?? DEFAULT_MODEL,
    voice: { id: options.voice ?? DEFAULT_VOICE },
    output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: sampleRate },
    language: options.language ?? "en",
    max_buffer_delay_ms: options.maxBufferDelayMs ?? 0
  }

  /**
   * Attribution: after each clause we send a flush. The server generates
   * everything buffered and then answers `flush_done`, so audio received after
   * the k-th `flush_done` of a context belongs to the clause after the k-th
   * one sent. The clause index is that count, capped at the last clause sent.
   * This is exact, needs no text alignment (word timestamps would have to match
   * the server's word split and normalisation, and may arrive after the audio
   * they describe), and adds no latency: a flush only makes the server start
   * on text it would otherwise hold in its buffer. If `flush_done` turned out
   * to come early, late or never, only the tags shift (audio is attributed to
   * an earlier clause); audio itself is never held back or dropped.
   */
  const synthesize = (clauses: Stream.Stream<string>): Stream.Stream<TtsAudio, TtsError> =>
    Stream.callback<TtsAudio, TtsError>((queue) =>
      Effect.gen(function*() {
        let socket: WebSocket | undefined
        let ctx: Ctx | undefined
        let next = 0
        let inputEnded = false
        let settled = false
        let drainTimer: ReturnType<typeof setTimeout> | undefined

        const settle = () => {
          settled = true
          clearTimeout(drainTimer)
          if (ctx !== undefined) conn.routes.delete(ctx.id)
        }
        const fail = (message: string) => {
          if (settled) return
          settle()
          Queue.failCauseUnsafe(queue, Cause.fail(new TtsError({ message })))
        }
        const finish = () => {
          if (settled) return
          settle()
          Queue.endUnsafe(queue)
        }

        const onMessage = (c: Ctx, msg: ServerMessage) => {
          c.lastMessageAt = performance.now()
          switch (msg.type) {
            case "chunk":
              if (typeof msg.data === "string" && msg.data.length > 0) {
                c.audio = true
                const clause = c.base + Math.max(0, Math.min(c.acked, c.sent - 1))
                Queue.offerUnsafe(queue, { audio: Buffer.from(msg.data, "base64"), clause })
              }
              break
            case "flush_done":
              c.acked++
              break
            case "error":
              return fail(describeError(msg))
          }
          if (msg.type === "done" || msg.done === true) {
            if (inputEnded) finish()
            else c.expired = true
          }
        }

        const open = (ws: WebSocket, base: number): Ctx => {
          const c: Ctx = { id: randomUUID(), base, sent: 0, acked: 0, audio: false, lastMessageAt: 0, expired: false }
          conn.routes.set(c.id, { socket: ws, message: (msg) => onMessage(c, msg), closed: fail })
          return c
        }

        // Only roll over once everything sent has been generated and the
        // context has gone quiet, so no audio of the old context can be lost.
        const rollOver = (c: Ctx) =>
          c.expired || (c.audio && c.acked >= c.sent && performance.now() - c.lastMessageAt > EXPIRY_MARGIN_MS)

        const send = (ws: WebSocket, c: Ctx, transcript: string, more: boolean, flush: boolean) => {
          const msg = flush
            ? { ...common, context_id: c.id, transcript, continue: more, flush: true }
            : { ...common, context_id: c.id, transcript, continue: more }
          if (!conn.send(ws, JSON.stringify(msg))) fail("Cartesia connection closed")
        }

        const sendClause = (text: string) =>
          Effect.gen(function*() {
            const ws = socket ?? (socket = yield* conn.awaitOpen(connectTimeoutMs))
            if (ctx === undefined || rollOver(ctx)) {
              if (ctx !== undefined) conn.routes.delete(ctx.id)
              ctx = open(ws, next)
            }
            // Transcripts are concatenated verbatim and clauses arrive trimmed.
            send(ws, ctx, ctx.sent === 0 ? text : ` ${text}`, true, false)
            send(ws, ctx, "", true, true)
            ctx.sent++
            next++
          })

        // Interruption (or failure): cancel at once. Output still generating
        // for this id is dropped by the router since the route is gone.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const c = ctx
            const wasSettled = settled
            settle()
            if (!wasSettled && c !== undefined && socket !== undefined) {
              conn.send(socket, JSON.stringify({ context_id: c.id, cancel: true }))
            }
          })
        )

        yield* Stream.runForEach(clauses, sendClause)
        inputEnded = true
        if (ctx === undefined || socket === undefined) return finish() // no clauses: nothing was sent
        send(socket, ctx, "", false, false)
        // Safety net in case `done` never comes: end once the context goes silent.
        const c = ctx
        c.lastMessageAt = performance.now()
        const check = () => {
          if (settled) return
          const quiet = performance.now() - c.lastMessageAt
          if (quiet >= drainTimeoutMs) {
            log(`Cartesia: no "done" for context ${c.id} after ${drainTimeoutMs} ms of silence; ending the turn`)
            finish()
          } else drainTimer = setTimeout(check, drainTimeoutMs - quiet)
        }
        if (!settled) drainTimer = setTimeout(check, drainTimeoutMs)
      })
    )

  return Tts.of({ sampleRate, synthesize })
})

/** `Tts` from explicit options. The socket opens when the layer is built. */
export const layer = (options: CartesiaOptions): Layer.Layer<Tts> => Layer.effect(Tts, make(options))

export const config = Config.all({
  apiKey: Config.Redacted("CARTESIA_API_KEY"),
  model: Config.String("CARTESIA_MODEL").pipe(Config.withDefault(DEFAULT_MODEL)),
  voice: Config.String("CARTESIA_VOICE").pipe(Config.withDefault(DEFAULT_VOICE)),
  language: Config.String("CARTESIA_LANGUAGE").pipe(Config.withDefault("en")),
  sampleRate: Config.Int("CARTESIA_SAMPLE_RATE").pipe(Config.withDefault(24_000)),
  maxBufferDelayMs: Config.Int("CARTESIA_MAX_BUFFER_DELAY_MS").pipe(Config.withDefault(0)),
  baseUrl: Config.String("CARTESIA_URL").pipe(Config.withDefault(DEFAULT_BASE_URL))
})

/** `Tts` configured from the environment (`CARTESIA_API_KEY`, `CARTESIA_MODEL`, ...). */
export const layerConfig: Layer.Layer<Tts, Config.ConfigError> = Layer.effect(
  Tts,
  Effect.gen(function*() {
    return yield* make(yield* config)
  })
)

