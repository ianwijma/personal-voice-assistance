/**
 * Tts via the ElevenLabs multi-context WebSocket (one context per turn, raw PCM s16le).
 * Wire reference: docs/protocols/elevenlabs-tts.md.
 */
import { randomUUID } from "node:crypto"
import { Tts, type TtsAudio, TtsError } from "@pva/core"
import { Cause, Config, Effect, Layer, Queue, Redacted, Stream } from "effect"
import WebSocket from "ws"
import { addressSecrets, checkAddress, clip, errorName, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"

export const DEFAULT_BASE_URL = "wss://api.elevenlabs.io"
/** The docs' low-latency model for the multi-context WebSocket (~100 ms median, 32 languages). Measure others with TurnTrace. */
export const DEFAULT_MODEL = "eleven_flash_v2_5"
/** "Sarah", one of the ElevenLabs default voices. */
export const DEFAULT_VOICE = "EXAVITQu4vr4xnSDxMaL"
/** The raw PCM rates ElevenLabs offers (`pcm_<rate>`). */
export const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000] as const
/** The server's limit of open contexts on one connection. */
export const MAX_CONTEXTS_PER_SOCKET = 5

export interface ElevenLabsOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly model?: string
  /** Voice id (from the ElevenLabs voice library). */
  readonly voice?: string
  /** ISO 639-1 code (`language_code`), only for models that support enforcing a language. Default: unset. */
  readonly language?: string
  /** Output rate in Hz, one of `SAMPLE_RATES`. Default 24000. */
  readonly sampleRate?: number
  /** `voice_settings.speed` (0.7–1.2). Default: the voice's own. */
  readonly speed?: number
  /** `voice_settings.stability` (0–1). Default: the voice's own. */
  readonly stability?: number
  /**
   * `auto_mode`: the server skips its chunk schedule and buffers, for callers that send whole
   * sentences or phrases (the clause chunker does). Default true.
   */
  readonly autoMode?: boolean
  /** Default `wss://api.elevenlabs.io`; tests point it at a local server. */
  readonly baseUrl?: string
  /** How long a turn waits for a (re)connect before failing. Default 2000. */
  readonly connectTimeoutMs?: number
  /** Abandon (and reopen) a socket whose WebSocket upgrade takes longer than this. Default 5000. */
  readonly handshakeTimeoutMs?: number
  /** Ping interval; a socket that answered nothing for a whole interval is dropped. Default 30000. */
  readonly pingIntervalMs?: number
  /** `inactivity_timeout` in seconds (max 180): the server closes a context (and an idle socket) after this. Default 180. */
  readonly inactivityTimeoutS?: number
  /** Reopen an idle socket after this long, before the server's inactivity limit. Default 170000. */
  readonly idleRefreshMs?: number
  /** While a turn's input is still open but quiet (a tool call), reset its context's inactivity clock this often. Default 30000. */
  readonly keepAliveMs?: number
  /**
   * After end of input, give up on a context that stays silent this long without `isFinal`. Default 5000.
   * The turn then fails with `TtsError` if no audio arrived; otherwise it ends normally (only `isFinal` was missing).
   */
  readonly drainTimeoutMs?: number
}

/** Fields of any server message we look at. Parsed with JSON.parse and narrowed by hand: this is the per-chunk hot path. */
interface ServerMessage {
  readonly audio?: unknown
  readonly isFinal?: unknown
  readonly is_final?: unknown
  readonly contextId?: unknown
  readonly context_id?: unknown
  readonly alignment?: unknown
  readonly error?: unknown
  readonly message?: unknown
  readonly code?: unknown
}

interface Route {
  readonly socket: WebSocket
  readonly message: (msg: ServerMessage) => void
  readonly closed: (message: string) => void
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

const contextOf = (msg: ServerMessage): string | undefined =>
  typeof msg.contextId === "string" ? msg.contextId : typeof msg.context_id === "string" ? msg.context_id : undefined

const isFinal = (msg: ServerMessage) => msg.isFinal === true || msg.is_final === true

/** A message that reports a failure (the error shape is not documented: any `error`, or a `message` without audio). */
const isError = (msg: ServerMessage) =>
  (msg.error !== undefined && msg.error !== null && msg.error !== "") ||
  (typeof msg.audio !== "string" && !isFinal(msg) && typeof msg.message === "string" && msg.message !== "")

/** Upstream text, redacted (a peer may echo the key back) before it is shortened. */
const describeError = (msg: ServerMessage, secrets: Secrets): string => {
  const parts = [msg.code, msg.error, msg.message]
    .filter((p) => p !== undefined && p !== null && p !== "")
    .map((p) => (typeof p === "object" ? JSON.stringify(p) : String(p)))
  return `ElevenLabs error: ${clip(parts.length > 0 ? parts.join(" — ") : JSON.stringify(msg), secrets, 400)}`
}

/** The only way a `TtsError` is made here: message and cause sanitised (see `redact.ts`). */
const ttsError = (secrets: Secrets, message: string, cause?: unknown): TtsError => new TtsError(sanitize(secrets, { message, cause }))

/** Standard base64 with correct padding; `Buffer.from` would silently skip anything else. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** A clause that should produce sound (not only punctuation or spaces). */
const SPEAKABLE = /[\p{L}\p{N}]/u

/** Characters counted for attribution: whitespace is left out, so spacing differences in the alignment do not shift it. */
const countable = (text: string): number => text.replace(/\s+/g, "").length

/** The number of countable characters in a chunk's `alignment.chars`, or undefined when it has none. */
const alignedChars = (alignment: unknown): number | undefined => {
  if (!isRecord(alignment) || !Array.isArray(alignment.chars)) return undefined
  let n = 0
  for (const c of alignment.chars) if (typeof c === "string") n += countable(c)
  return n
}

/**
 * One WebSocket: opened eagerly, pinged, refreshed before the idle limit and reopened with backoff.
 * Server messages are routed to the turn that owns their context id; messages for unknown ids
 * (closed or finished contexts) are dropped.
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
    if (/^10*$/.test(String(malformed))) log(`ElevenLabs: dropped ${what} (${malformed} malformed message(s) so far)`)
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
    // `handshakeTimeout`: a peer that accepts TCP but never answers the upgrade would otherwise leave
    // `pending` set for good. Construction can throw (an address `ws` refuses), also from the reconnect
    // timer, where a throw would escape into Node: the connection is then broken for good.
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
        const id = contextOf(msg)
        if (id !== undefined) {
          // Unknown id: late output for a closed/finished context. Drop it.
          routes.get(id)?.message(msg)
        } else if (isError(msg)) {
          // Connection-level error: fail every turn on this socket.
          const message = describeError(msg, opts.secrets)
          log(message)
          for (const route of [...routes.values()]) if (route.socket === ws) route.closed(message)
        }
      } catch (e) {
        // The error's name only: a runtime's message about upstream text can quote it already cut short.
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
      const message = `ElevenLabs connection closed (${text})`
      for (const route of [...routes.values()]) if (route.socket === ws) route.closed(message)
      if (!wasActive || shut) return
      // A socket that dies right after opening (e.g. a refused key) keeps backing off.
      if (openedAt > 0 && Date.now() - openedAt > 1000) attempt = 0
      const delay = attempt === 0 ? 0 : Math.min(250 * 2 ** (attempt - 1), 10_000)
      attempt++
      if (openedAt > 0 || attempt === 1) log(`ElevenLabs: ${lastError}; reconnecting in ${delay} ms`)
      reconnectTimer = setTimeout(connect, delay)
    })
  }

  const heartbeat = setInterval(() => {
    const ws = current
    if (ws === undefined) return
    if (!heard) return ws.terminate() // dead peer; `close` reconnects
    heard = false
    ws.ping()
    // The server closes a connection after `inactivity_timeout` without input; whether pings count
    // is undocumented, so reopen proactively while nothing is running.
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
        const unusable = () => ttsError(opts.secrets, `ElevenLabs ${broken ?? "is not connected"}`)
        if (broken !== undefined) return resume(Effect.fail(unusable()))
        const waiter = (ws: WebSocket | undefined) => {
          clearTimeout(timer)
          resume(ws === undefined ? Effect.fail(unusable()) : Effect.succeed(ws))
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          resume(Effect.fail(ttsError(opts.secrets, `ElevenLabs not connected after ${timeoutMs} ms: ${lastError}`)))
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

type Connection = ReturnType<typeof makeConnection>

/** One ElevenLabs context of a turn. A turn normally has one; a new one starts if the server ended it early. */
interface Ctx {
  readonly id: string
  readonly conn: Connection
  readonly socket: WebSocket
  /** Index of the turn's clause that was sent first on this context. */
  readonly base: number
  /** Per clause sent on this context: the end of its text in countable characters, whether it should produce sound, whether audio arrived for it. */
  readonly clauses: Array<{ readonly end: number; readonly speakable: boolean; audio: boolean }>
  /** Countable characters sent so far. */
  chars: number
  /** Countable characters the audio received so far covered (from `alignment`). */
  heard: number
  /** Clause (local index) the latest audio was attributed to. */
  current: number
  /** At least one chunk carried an `alignment`, so per-clause checks are meaningful. */
  aligned: boolean
  /** At least one chunk with valid, non-empty PCM arrived on this context. */
  audio: boolean
  /** An odd byte left over from the previous chunk (a sample split across chunks). */
  carry: number | undefined
  lastMessageAt: number
  lastSentAt: number
  /** The server sent `isFinal` before we closed the context. */
  ended: boolean
}

/** The rules for the base address: ws(s), no user-info, no query (the key goes in a header; see `redact.ts`). */
export const ADDRESS_RULES = { protocols: ["wss:", "ws:"], query: false } as const

/** Checks the options that the server would otherwise refuse mid-turn. A problem, or undefined. */
const optionProblem = (options: ElevenLabsOptions, sampleRate: number): string | undefined => {
  if (!(SAMPLE_RATES as ReadonlyArray<number>).includes(sampleRate)) {
    return `The ElevenLabs sample rate (ELEVENLABS_SAMPLE_RATE) must be one of ${SAMPLE_RATES.join(", ")}`
  }
  if (options.speed !== undefined && !(options.speed >= 0.7 && options.speed <= 1.2)) {
    return "The ElevenLabs speed (ELEVENLABS_SPEED) must be between 0.7 and 1.2"
  }
  if (options.stability !== undefined && !(options.stability >= 0 && options.stability <= 1)) {
    return "The ElevenLabs stability (ELEVENLABS_STABILITY) must be between 0 and 1"
  }
  const timeout = options.inactivityTimeoutS
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout >= 1 && timeout <= 180)) {
    return "The ElevenLabs inactivity timeout must be a whole number of seconds from 1 to 180"
  }
  if ((options.voice ?? DEFAULT_VOICE).trim() === "") return "The ElevenLabs voice (ELEVENLABS_VOICE) is empty"
  return undefined
}

const makeService = Effect.fnUntraced(function*(options: ElevenLabsOptions) {
  // Read and checked once, inside the boundary: a getter that throws or a refused address makes every
  // turn fail with a sanitised `TtsError`; building the service never throws or dies.
  const sampleRate = typeof options.sampleRate === "number" ? options.sampleRate : 24_000
  let secrets: Secrets = []
  let setup: { readonly url: string; readonly apiKey: string } | TtsError
  try {
    secrets = secretList(Redacted.value(options.apiKey))
    secrets = secretList(secrets, addressSecrets(options.baseUrl))
    const address = checkAddress(options.baseUrl ?? DEFAULT_BASE_URL, ADDRESS_RULES)
    const problem = optionProblem(options, sampleRate)
    if (!address.ok) setup = ttsError(secrets, `The ElevenLabs address (ELEVENLABS_URL) ${address.problem}`)
    else if (problem !== undefined) setup = ttsError(secrets, problem)
    else {
      const query = new URLSearchParams({
        model_id: options.model ?? DEFAULT_MODEL,
        output_format: `pcm_${sampleRate}`,
        inactivity_timeout: String(options.inactivityTimeoutS ?? 180),
        sync_alignment: "true",
        auto_mode: String(options.autoMode ?? true)
      })
      if (options.language !== undefined && options.language.trim() !== "") query.set("language_code", options.language.trim())
      const voice = encodeURIComponent((options.voice ?? DEFAULT_VOICE).trim())
      setup = {
        url: `${address.display}/v1/text-to-speech/${voice}/multi-stream-input?${query.toString()}`,
        apiKey: Redacted.value(options.apiKey)
      }
    }
  } catch (e) {
    setup = ttsError(secrets, `The ElevenLabs settings could not be read: ${fromUpstream(e, secrets)}`, e)
  }

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
  const keepAliveMs = options.keepAliveMs ?? 30_000
  const connectionOptions = {
    pingIntervalMs: options.pingIntervalMs ?? 30_000,
    idleRefreshMs: options.idleRefreshMs ?? 170_000,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 5000,
    secrets
  }
  const openConnection = () => makeConnection(url, { "xi-api-key": apiKey }, connectionOptions, log)

  /**
   * The connections. The first is opened at build and kept warm; more are opened only while every
   * open one already carries `MAX_CONTEXTS_PER_SOCKET` turns (several devices speaking at once), and
   * each extra one is closed when its last turn ends.
   */
  const pool: Array<Connection> = []
  const opened = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        pool.push(openConnection())
      },
      catch: (e) => ttsError(secrets, `Could not set up the ElevenLabs connection: ${fromUpstream(e, secrets)}`, e)
    }).pipe(Effect.result),
    () => Effect.sync(() => pool.splice(0).forEach((c) => c.close()))
  )
  if (opened._tag === "Failure") {
    log(opened.failure.message)
    const failed = opened.failure
    return Tts.of({ sampleRate, synthesize: () => Stream.fail(failed) })
  }
  /** Turns using each connection, counted when the turn picks it (before its context exists, so turns that start together spread out). */
  const load = new Map<Connection, number>()
  const connectionForTurn = (): Connection => {
    let conn = pool.find((c) => (load.get(c) ?? 0) < MAX_CONTEXTS_PER_SOCKET)
    if (conn === undefined) {
      conn = openConnection()
      pool.push(conn)
    }
    load.set(conn, (load.get(conn) ?? 0) + 1)
    return conn
  }
  const releaseConnection = (conn: Connection) => {
    const left = (load.get(conn) ?? 1) - 1
    if (left > 0) return void load.set(conn, left)
    load.delete(conn)
    const index = pool.indexOf(conn)
    if (index > 0) {
      pool.splice(index, 1)
      conn.close()
    }
  }

  const voiceSettings = {
    ...(options.speed !== undefined ? { speed: options.speed } : {}),
    ...(options.stability !== undefined ? { stability: options.stability } : {})
  }
  const hasVoiceSettings = Object.keys(voiceSettings).length > 0

  /**
   * Attribution: ElevenLabs sends no per-flush acknowledgement, but with `sync_alignment` every audio
   * chunk carries the characters it speaks. Counting those (whitespace left out) against the text
   * sent gives the clause each chunk starts in. A chunk without an alignment keeps the previous
   * chunk's clause. If the alignment turned out to differ from the text sent, only the tags shift;
   * audio itself is never held back or dropped, and tags never decrease.
   */
  const run = (clauses: Stream.Stream<string>): Stream.Stream<TtsAudio, TtsError> =>
    Stream.callback<TtsAudio, TtsError>((queue) =>
      Effect.gen(function*() {
        let ctx: Ctx | undefined
        let conn: Connection | undefined
        let socket: WebSocket | undefined
        let next = 0
        let inputEnded = false
        let settled = false
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        let keepAliveTimer: ReturnType<typeof setInterval> | undefined
        /** Every context of this turn. */
        const contexts: Array<Ctx> = []

        const settle = () => {
          settled = true
          clearTimeout(drainTimer)
          clearInterval(keepAliveTimer)
          for (const c of contexts) c.conn.routes.delete(c.id)
          if (conn !== undefined) releaseConnection(conn)
          conn = undefined
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
        const sendJson = (c: Ctx, msg: Record<string, unknown>) => {
          c.lastSentAt = performance.now()
          if (!c.conn.send(c.socket, JSON.stringify(msg))) fail("ElevenLabs connection closed")
        }

        /**
         * The first speakable clause of the turn (turn index) the alignment says got no audio. Attribution
         * is counted from the alignment, which may not match the text exactly, so this is only logged:
         * a turn whose audio played must not fail on it.
         */
        const silentClause = (): number | undefined => {
          for (const x of contexts) {
            if (!x.aligned) continue
            for (let k = 0; k < x.clauses.length; k++) {
              const clause = x.clauses[k]!
              if (clause.speakable && !clause.audio) return x.base + k
            }
          }
          return undefined
        }
        /** A context that should have spoken and sent no audio at all: the owner would hear nothing (or lose clauses). */
        const silentContext = () => contexts.some((x) => x.clauses.some((k) => k.speakable) && !x.audio)
        const noteMissing = (why: string) => {
          const missing = silentClause()
          if (missing !== undefined) log(`ElevenLabs: ${why}; by its alignment, clause ${missing + 1} got no audio`)
        }

        /** The turn is over (`isFinal` after the input ended): it succeeded only if what should have spoken did. */
        const complete = () => {
          if (silentContext()) return fail("ElevenLabs finished the reply without sending any audio for it")
          noteMissing("the reply finished")
          finish()
        }

        const onAudio = (c: Ctx, msg: ServerMessage) => {
          if (typeof msg.audio !== "string" || msg.audio.length === 0) return
          if (!BASE64.test(msg.audio)) return fail("ElevenLabs sent audio that is not valid base64")
          let audio: Uint8Array = Buffer.from(msg.audio, "base64")
          if (c.carry !== undefined) {
            const joined = new Uint8Array(audio.length + 1)
            joined[0] = c.carry
            joined.set(audio, 1)
            audio = joined
            c.carry = undefined
          }
          if (audio.length % 2 === 1) {
            c.carry = audio[audio.length - 1]
            audio = audio.subarray(0, audio.length - 1)
          }
          const covered = alignedChars(msg.alignment)
          // The clause this chunk starts in: the first whose text ends past what was heard before it.
          let local = c.current
          if (covered !== undefined) {
            c.aligned = true
            while (local < c.clauses.length - 1 && c.clauses[local]!.end <= c.heard) local++
          }
          const from = local
          if (covered !== undefined) c.heard += covered
          // Every clause the chunk's characters reach counts as having audio.
          let to = from
          while (covered !== undefined && to < c.clauses.length - 1 && c.clauses[to]!.end < c.heard) to++
          c.current = from
          if (audio.length === 0) return
          c.audio = true
          for (let k = from; k <= to; k++) c.clauses[k]!.audio = true
          Queue.offerUnsafe(queue, { audio, clause: c.base + from })
        }

        const onMessage = (c: Ctx, msg: ServerMessage) => {
          c.lastMessageAt = performance.now()
          if (isError(msg)) return fail(describeError(msg, secrets))
          onAudio(c, msg)
          if (settled || !isFinal(msg)) return
          c.conn.routes.delete(c.id)
          if (!inputEnded) c.ended = true // the server ended it early: the next clause opens a new context
          else if (c === ctx) complete()
        }

        const open = (base: number): Ctx => {
          const c: Ctx = {
            id: randomUUID(),
            conn: conn!,
            socket: socket!,
            base,
            clauses: [],
            chars: 0,
            heard: 0,
            current: 0,
            aligned: false,
            audio: false,
            carry: undefined,
            lastMessageAt: 0,
            lastSentAt: 0,
            ended: false
          }
          contexts.push(c)
          c.conn.routes.set(c.id, { socket: c.socket, message: (msg) => onMessage(c, msg), closed: fail })
          // The documented first message of a context: a single space, with the context's settings.
          sendJson(c, { text: " ", context_id: c.id, ...(hasVoiceSettings ? { voice_settings: voiceSettings } : {}) })
          return c
        }

        const sendClause = (text: string) =>
          Effect.gen(function*() {
            if (settled) return
            if (socket === undefined) {
              conn = connectionForTurn()
              socket = yield* conn.awaitOpen(connectTimeoutMs)
            }
            if (settled) return
            if (ctx === undefined || ctx.ended) ctx = open(next)
            const c = ctx
            // Each clause is flushed: generation starts at once, without waiting for more text.
            sendJson(c, { text: `${text} `, context_id: c.id, flush: true })
            c.chars += countable(text)
            c.clauses.push({ end: c.chars, speakable: SPEAKABLE.test(text), audio: false })
            next++
            if (keepAliveTimer === undefined) {
              keepAliveTimer = setInterval(() => {
                const k = ctx
                if (k === undefined || inputEnded || settled) return
                if (performance.now() - Math.max(k.lastSentAt, k.lastMessageAt) >= keepAliveMs) sendJson(k, { text: "", context_id: k.id })
              }, Math.max(50, Math.floor(keepAliveMs / 2)))
              keepAliveTimer.unref()
            }
          })

        // Interruption (or failure): close the context at once. Output still generating for this id
        // is dropped by the router since the route is gone.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const c = ctx
            const wasSettled = settled
            settle()
            if (!wasSettled && c !== undefined && !c.ended) c.conn.send(c.socket, JSON.stringify({ context_id: c.id, close_context: true }))
          })
        )

        yield* Stream.runForEach(clauses, sendClause)
        inputEnded = true
        clearInterval(keepAliveTimer)
        if (settled) return
        if (ctx === undefined) return finish() // no clauses: nothing was sent
        const c = ctx
        if (c.ended) return complete() // its `isFinal` already came
        // Every clause was flushed, so closing generates nothing new; the server answers `isFinal`.
        sendJson(c, { context_id: c.id, close_context: true })
        // Safety net in case `isFinal` never comes: give up once the context goes silent. Success if
        // audio arrived; if nothing that should have spoken did, the owner heard nothing: a TtsError.
        c.lastMessageAt = performance.now()
        const check = () => {
          if (settled) return
          const quiet = performance.now() - c.lastMessageAt
          if (quiet < drainTimeoutMs) {
            drainTimer = setTimeout(check, drainTimeoutMs - quiet)
            return
          }
          const silentFor = `${drainTimeoutMs} ms of silence`
          if (silentContext() || !c.audio) {
            fail(`ElevenLabs sent no audio for this reply (no "isFinal" after ${silentFor})`)
          } else {
            noteMissing(`no "isFinal" after ${silentFor}`)
            log(`ElevenLabs: no "isFinal" for context ${c.id} after ${silentFor}, but its audio arrived; ending the turn`)
            finish()
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
export const make = (options: ElevenLabsOptions) =>
  makeService(options).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        const secrets = readableSecrets(options)
        const error = ttsError(secrets, `ElevenLabs could not be set up: ${fromUpstream(defect, secrets)}`, defect)
        return Tts.of({ sampleRate: 24_000, synthesize: () => Stream.fail(error) })
      })
    )
  )

/** The key and the address's credential parts, as far as they can be read (a getter may throw). */
const readableSecrets = (options: ElevenLabsOptions): Secrets => {
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
export const layer = (options: ElevenLabsOptions): Layer.Layer<Tts> => Layer.effect(Tts, make(options))

const optionalNumber = (name: string) => Config.Finite(name).pipe(Config.option)

export const config = Config.all({
  apiKey: Config.Redacted("ELEVENLABS_API_KEY"),
  model: Config.String("ELEVENLABS_MODEL").pipe(Config.withDefault(DEFAULT_MODEL)),
  voice: Config.String("ELEVENLABS_VOICE").pipe(Config.withDefault(DEFAULT_VOICE)),
  language: Config.String("ELEVENLABS_LANGUAGE").pipe(Config.withDefault("")),
  sampleRate: Config.Int("ELEVENLABS_SAMPLE_RATE").pipe(Config.withDefault(24_000)),
  speed: optionalNumber("ELEVENLABS_SPEED"),
  stability: optionalNumber("ELEVENLABS_STABILITY"),
  autoMode: Config.Boolean("ELEVENLABS_AUTO_MODE").pipe(Config.withDefault(true)),
  baseUrl: Config.String("ELEVENLABS_URL").pipe(Config.withDefault(DEFAULT_BASE_URL))
})

/** `Tts` configured from the environment (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE`, ...). */
export const layerConfig: Layer.Layer<Tts, Config.ConfigError> = Layer.effect(
  Tts,
  Effect.gen(function*() {
    const { speed, stability, ...rest } = yield* config
    return yield* make({
      ...rest,
      ...(speed._tag === "Some" ? { speed: speed.value } : {}),
      ...(stability._tag === "Some" ? { stability: stability.value } : {})
    })
  })
)
