/**
 * Tts via the Cartesia Sonic WebSocket (contexts/continuations, raw pcm_s16le).
 * Wire reference: docs/protocols/cartesia-tts.md.
 */
import { randomUUID } from "node:crypto"
import { Tts, type TtsAudio, TtsError } from "@pva/core"
import { Cause, Config, Effect, Layer, Queue, Redacted, Stream } from "effect"
import WebSocket from "ws"
import { addressSecrets, checkAddress, clip, errorName, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"

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
  /** Abandon (and reopen) a socket whose WebSocket upgrade takes longer than this. Default 5000. */
  readonly handshakeTimeoutMs?: number
  /** Ping interval; a socket that answered nothing for a whole interval is dropped. Default 30000. */
  readonly pingIntervalMs?: number
  /** Reopen an idle socket after this long, before the server's 5-minute idle close. Default 240000. */
  readonly idleRefreshMs?: number
  /**
   * After end of input, give up on a context that stays silent this long without `done`. Default 5000.
   * The turn then fails with `TtsError` unless every clause's audio had arrived (only `done` was missing).
   */
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

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** Upstream text, redacted (a peer may echo the key back) before it is shortened. */
const describeError = (msg: ServerMessage, secrets: Secrets): string => {
  const parts = [msg.status_code, msg.error_code, msg.title, msg.message, msg.error]
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p) => (typeof p === "object" ? JSON.stringify(p) : String(p)))
  return `Cartesia error: ${clip(parts.length > 0 ? parts.join(" — ") : JSON.stringify(msg), secrets, 400)}`
}

/** The only way a `TtsError` is made here: message and cause sanitised (see `redact.ts`). */
const ttsError = (secrets: Secrets, message: string, cause?: unknown): TtsError => new TtsError(sanitize(secrets, { message, cause }))

/** Standard base64 with correct padding (what Cartesia sends); `Buffer.from` would silently skip anything else. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** A clause that should produce sound (not only punctuation or spaces). */
const SPEAKABLE = /[\p{L}\p{N}]/u

/**
 * One WebSocket shared by every turn: opened eagerly, pinged, refreshed before
 * the idle limit and reopened with backoff. Server messages are routed to the
 * turn that owns their `context_id`; messages for unknown ids (cancelled or
 * finished contexts) are dropped.
 */
const makeConnection = (
  url: string,
  headers: Record<string, string>,
  opts: {
    readonly pingIntervalMs: number
    readonly idleRefreshMs: number
    readonly handshakeTimeoutMs: number
    readonly secrets: Secrets
  },
  unsafeLog: (message: string) => void
) => {
  // Every log line from the connection is upstream-influenced: redacted before it is shortened.
  const log = (message: string) => unsafeLog(clip(message, opts.secrets, 500))
  let malformed = 0
  /** Dropped malformed messages are logged at 1, 10, 100, … so a broken peer cannot flood the log. */
  const dropMalformed = (what: string) => {
    malformed++
    if (/^10*$/.test(String(malformed))) log(`Cartesia: dropped ${what} (${malformed} malformed message(s) so far)`)
  }
  const routes = new Map<string, Route>()
  /** Called with the socket once it opens, or with undefined when it never can. */
  const waiters = new Set<(socket: WebSocket | undefined) => void>()
  let current: WebSocket | undefined // open socket
  let pending: WebSocket | undefined // socket being opened
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let attempt = 0
  let lastError = "not connected yet"
  let lastSent = Date.now()
  let heard = true // pong or message since the last ping
  let shut = false
  /** The socket cannot be built at all (set once): waits fail at once with this. */
  let broken: string | undefined

  const connect = () => {
    if (shut || broken !== undefined || pending !== undefined || current !== undefined) return
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    // `handshakeTimeout`: a peer that accepts TCP but never answers the upgrade would otherwise
    // leave `pending` set for good, and `connect()` refuses to replace a pending socket.
    // Construction can throw (an address `ws` refuses), also from the reconnect timer, where a throw
    // would escape into Node: the connection is then broken for good, and every wait fails at once.
    let ws: WebSocket
    try {
      ws = new WebSocket(url, { headers, handshakeTimeout: opts.handshakeTimeoutMs })
    } catch (e) {
      broken = `could not open the connection (${fromUpstream(e, opts.secrets)})`
      lastError = broken
      for (const waiter of [...waiters]) waiter(undefined)
      return
    }
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
    // A plain event callback: an exception thrown here would escape into Node, not into a turn's
    // stream. Anything that is not a JSON object is dropped, and nothing may throw past this point.
    ws.on("message", (data) => {
      heard = true
      try {
        let parsed: unknown
        try {
          parsed = JSON.parse((data as Buffer).toString())
        } catch {
          return dropMalformed("a non-JSON message")
        }
        if (!isRecord(parsed)) return dropMalformed("a message that is not a JSON object")
        const msg: ServerMessage = parsed
        if (typeof msg.context_id === "string") {
          // Unknown id: late output for a cancelled/finished context. Drop it.
          routes.get(msg.context_id)?.message(msg)
        } else if (msg.type === "error") {
          // Connection-level error: fail every turn on this socket.
          const message = describeError(msg, opts.secrets)
          log(message)
          for (const route of [...routes.values()]) if (route.socket === ws) route.closed(message)
        }
      } catch (e) {
        // The error's name only: a runtime's message about upstream text can quote it already cut short
        // (V8's JSON.parse does), and no redaction recognises a credential prefix.
        dropMalformed(`a message it could not handle (${errorName(e)})`)
      }
    })
    ws.on("pong", () => {
      heard = true
    })
    ws.on("error", (error) => {
      lastError = clip(error.message, opts.secrets, 300)
    })
    ws.on("close", (code, reason) => {
      const wasActive = current === ws || pending === ws
      if (current === ws) current = undefined
      if (pending === ws) pending = undefined
      const text = reason.length > 0 ? `${code} ${clip(reason.toString(), opts.secrets, 200)}` : `${code}`
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
        const unusable = () => ttsError(opts.secrets, `Cartesia ${broken ?? "is not connected"}`)
        if (broken !== undefined) return resume(Effect.fail(unusable()))
        const waiter = (ws: WebSocket | undefined) => {
          clearTimeout(timer)
          resume(ws === undefined ? Effect.fail(unusable()) : Effect.succeed(ws))
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          resume(Effect.fail(ttsError(opts.secrets, `Cartesia not connected after ${timeoutMs} ms: ${lastError}`)))
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
  /** Clauses sent on this context that should produce sound (see `SPEAKABLE`). */
  spoken: number
  acked: number
  /** At least one chunk with valid, non-empty PCM arrived on this context. */
  audio: boolean
  /**
   * Per clause sent on this context (in order): whether it should produce sound, and whether valid
   * audio arrived in its flush interval (after the previous clause's `flush_done`, up to its own).
   */
  readonly clauses: Array<{ readonly speakable: boolean; audio: boolean }>
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

/** The rules for the base address: ws(s), no user-info, no query (the key goes in a header; see `redact.ts`). */
export const ADDRESS_RULES = { protocols: ["wss:", "ws:"], query: false } as const

const makeService = Effect.fnUntraced(function*(options: CartesiaOptions) {
  // Read and checked once, inside the boundary: a getter that throws or a refused address makes every
  // turn fail with a sanitised `TtsError`; building the service never throws or dies.
  let secrets: Secrets = []
  let setup: { readonly url: string; readonly apiKey: string } | TtsError
  try {
    secrets = secretList(Redacted.value(options.apiKey))
    secrets = secretList(secrets, addressSecrets(options.baseUrl))
    const address = checkAddress(options.baseUrl ?? DEFAULT_BASE_URL, ADDRESS_RULES)
    setup = address.ok
      ? { url: `${address.display}/tts/websocket?cartesia_version=${CARTESIA_VERSION}`, apiKey: Redacted.value(options.apiKey) }
      : ttsError(secrets, `The Cartesia address (CARTESIA_URL) ${address.problem}`)
  } catch (e) {
    setup = ttsError(secrets, `The Cartesia settings could not be read: ${fromUpstream(e, secrets)}`, e)
  }
  const sampleRate = typeof options.sampleRate === "number" ? options.sampleRate : 24_000

  const context = yield* Effect.context<never>()
  const log = (message: string) => void Effect.runForkWith(context)(Effect.logWarning(clip(message, secrets, 500)))
  if (setup instanceof TtsError) {
    log(setup.message)
    const failed = setup
    return Tts.of({ sampleRate, synthesize: () => Stream.fail(failed) })
  }
  const { url, apiKey } = setup
  const connectTimeoutMs = options.connectTimeoutMs ?? 2000
  const drainTimeoutMs = options.drainTimeoutMs ?? 5000

  const opened = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        makeConnection(
          url,
          { "X-API-Key": apiKey, "Cartesia-Version": CARTESIA_VERSION },
          {
            pingIntervalMs: options.pingIntervalMs ?? 30_000,
            idleRefreshMs: options.idleRefreshMs ?? 240_000,
            handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5000,
            secrets
          },
          log
        ),
      catch: (e) => ttsError(secrets, `Could not set up the Cartesia connection: ${fromUpstream(e, secrets)}`, e)
    }).pipe(Effect.result),
    (result) => Effect.sync(() => result._tag === "Success" ? result.success.close() : undefined)
  )
  if (opened._tag === "Failure") {
    log(opened.failure.message)
    const failed = opened.failure
    return Tts.of({ sampleRate, synthesize: () => Stream.fail(failed) })
  }
  const conn = opened.success

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
  const run = (clauses: Stream.Stream<string>): Stream.Stream<TtsAudio, TtsError> =>
    Stream.callback<TtsAudio, TtsError>((queue) =>
      Effect.gen(function*() {
        let socket: WebSocket | undefined
        let ctx: Ctx | undefined
        let next = 0
        let inputEnded = false
        let settled = false
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        /** Every context of this turn (a turn rolls over to a fresh one after a long pause). */
        const contexts: Array<Ctx> = []

        const settle = () => {
          settled = true
          clearTimeout(drainTimer)
          if (ctx !== undefined) conn.routes.delete(ctx.id)
        }
        const fail = (message: string) => {
          if (settled) return
          settle()
          Queue.failCauseUnsafe(queue, Cause.fail(ttsError(secrets, message)))
        }
        const finish = () => {
          if (settled) return
          settle()
          Queue.endUnsafe(queue)
        }

        const onMessage = (c: Ctx, msg: ServerMessage) => {
          c.lastMessageAt = performance.now()
          switch (msg.type) {
            case "chunk": {
              if (typeof msg.data !== "string" || msg.data.length === 0) break
              if (!BASE64.test(msg.data)) return fail("Cartesia sent audio that is not valid base64")
              const audio = Buffer.from(msg.data, "base64")
              if (audio.length === 0) break
              c.audio = true
              const local = Math.max(0, Math.min(c.acked, c.sent - 1))
              const slot = c.clauses[local]
              if (slot !== undefined) slot.audio = true
              Queue.offerUnsafe(queue, { audio, clause: c.base + local })
              break
            }
            case "flush_done":
              c.acked++
              break
            case "error":
              return fail(describeError(msg, secrets))
          }
          if (msg.type === "done" || msg.done === true) {
            if (!inputEnded) c.expired = true
            else if (contexts.some((x) => x.spoken > 0 && !x.audio)) {
              // `done` comes after a context's last audio, so a context that should have spoken and
              // sent nothing never will: the owner would hear nothing (or lose clauses) and the turn
              // would count as answered.
              fail("Cartesia finished the reply without sending any audio for it")
            } else {
              // Per clause, too: one clause with audio must not hide a later speakable one that got none.
              const missing = silentClause(false)
              if (missing !== undefined) fail(`Cartesia finished the reply with no audio for clause ${missing + 1}`)
              else finish()
            }
          }
        }

        /**
         * The first speakable clause of the turn (turn index) that received no audio: among clauses
         * whose flush was acknowledged (`acknowledgedOnly`, on a drain timeout: later ones may still be
         * generating), or among every clause sent (on `done`, which follows a context's last audio).
         */
        const silentClause = (acknowledgedOnly: boolean): number | undefined => {
          for (const x of contexts) {
            for (let k = 0; k < x.clauses.length; k++) {
              const clause = x.clauses[k]!
              if (acknowledgedOnly && k >= x.acked) break
              if (clause.speakable && !clause.audio) return x.base + k
            }
          }
          return undefined
        }

        const open = (ws: WebSocket, base: number): Ctx => {
          const c: Ctx = { id: randomUUID(), base, sent: 0, spoken: 0, acked: 0, audio: false, clauses: [], lastMessageAt: 0, expired: false }
          contexts.push(c)
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
            const speakable = SPEAKABLE.test(text)
            ctx.clauses.push({ speakable, audio: false })
            if (speakable) ctx.spoken++
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
        // Safety net in case `done` never comes: give up once the context goes silent. Success only
        // if every clause's audio arrived (all flushes acknowledged) and only `done` is missing;
        // otherwise the owner heard nothing, or the reply was cut short, and that is a TtsError.
        // Either way the context is cancelled first (the finalizer will not: the turn is settled).
        const c = ctx
        const ws = socket
        c.lastMessageAt = performance.now()
        const check = () => {
          if (settled) return
          const quiet = performance.now() - c.lastMessageAt
          if (quiet < drainTimeoutMs) {
            drainTimer = setTimeout(check, drainTimeoutMs - quiet)
            return
          }
          conn.send(ws, JSON.stringify({ context_id: c.id, cancel: true }))
          const silentFor = `${drainTimeoutMs} ms of silence`
          const silent = contexts.some((x) => x.spoken > 0 && !x.audio)
          const missing = silentClause(true)
          if (!silent && missing !== undefined) {
            fail(`Cartesia sent no audio for clause ${missing + 1} (its flush was acknowledged; then ${silentFor})`)
          } else if (!silent && c.audio && c.acked >= c.sent) {
            log(`Cartesia: no "done" for context ${c.id} after ${silentFor}, but all audio arrived; ending the turn`)
            finish()
          } else if (!c.audio || silent) {
            fail(`Cartesia sent no audio for this reply (no "done" after ${silentFor})`)
          } else {
            fail(`Cartesia stopped part-way: ${c.acked} of ${c.sent} clauses finished, then ${silentFor}`)
          }
        }
        if (!settled) drainTimer = setTimeout(check, drainTimeoutMs)
      })
    )

  // The last resort: anything unexpected (a defect, also from the clause input) leaves as a sanitised `TtsError`.
  const synthesize = (clauses: Stream.Stream<string>): Stream.Stream<TtsAudio, TtsError> =>
    Stream.suspend(() => run(clauses)).pipe(
      Stream.catchDefect((defect) => Stream.fail(ttsError(secrets, `Speech synthesis failed unexpectedly: ${fromUpstream(defect, secrets)}`, defect))),
      Stream.mapError((e) => ttsError(secrets, e.message, e.cause))
    )

  return Tts.of({ sampleRate, synthesize })
})

/**
 * The service. The last resort for building it: a defect (a getter that throws past the checks above)
 * becomes a service whose every turn fails with a sanitised `TtsError`, never a raw defect.
 */
export const make = (options: CartesiaOptions) =>
  makeService(options).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        const secrets = readableSecrets(options)
        const error = ttsError(secrets, `Cartesia could not be set up: ${fromUpstream(defect, secrets)}`, defect)
        return Tts.of({ sampleRate: 24_000, synthesize: () => Stream.fail(error) })
      })
    )
  )

/** The key and the address's credential parts, as far as they can be read (a getter may throw). */
const readableSecrets = (options: CartesiaOptions): Secrets => {
  let out: Secrets = []
  try {
    out = secretList(Redacted.value(options.apiKey))
    out = secretList(out, addressSecrets(options.baseUrl))
  } catch {
    // what was read is kept
  }
  return out
}

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

