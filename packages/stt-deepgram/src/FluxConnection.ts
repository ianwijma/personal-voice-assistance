import type { SttEvent } from "@pva/core"
import { SttError } from "@pva/core"
import WebSocket from "ws"
import { clip, errorName, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"

/**
 * One Flux session over `ws`, written as plain callbacks so the per-chunk
 * path (`write`) is a memcpy and, every 80 ms, a `ws.send`. Wire reference:
 * `docs/protocols/deepgram-flux.md`.
 *
 * Lifecycle: `start` connects; `write` feeds PCM; `finish` (audio ended) sends
 * `ForceEndTurn` if a turn is open plus `CloseStream` and ends after the server
 * closes; `stop` (consumer interrupted) sends `CloseStream` and closes at once.
 * An unexpected close reconnects with backoff while the event stream continues.
 */

export interface ConnectionOptions {
  readonly url: string
  readonly apiKey: string
  /** Everything else to mask (credential parts of the configured address); the key always is. */
  readonly secrets?: ReadonlyArray<string | undefined>
  /** Audio frame size sent to Deepgram. 80 ms is Deepgram's recommendation. */
  readonly chunkMs: number
  /** Audio kept while disconnected and sent after reconnecting (newest wins). */
  readonly reconnectBufferMs: number
  readonly backoffInitialMs: number
  readonly backoffMaxMs: number
  /** Send a silent frame when no audio was sent for this long (keeps the socket alive). */
  readonly keepAliveMs: number
  /** How long a connection must stay up to count as healthy (backoff reset, Error policy). */
  readonly stableMs: number
  /** Wait at most this long for the server to close after `CloseStream`. */
  readonly closeTimeoutMs: number
  /** Abandon a connection whose WebSocket upgrade has not completed after this long, and reconnect. */
  readonly handshakeTimeoutMs: number
}

export interface ConnectionCallbacks {
  readonly emit: (event: SttEvent) => void
  readonly fail: (error: SttError) => void
  readonly end: () => void
  readonly log: (level: "info" | "warn", message: string) => void
}

const BYTES_PER_MS = 32 // 16 kHz * 2 bytes, mono
/** Drop audio rather than queue it once this much is waiting in the socket (stale audio only adds latency). */
const MAX_BUFFERED_BYTES = 1000 * BYTES_PER_MS
const CLOSE_STREAM = JSON.stringify({ type: "CloseStream" })
const FORCE_END_TURN = JSON.stringify({ type: "ForceEndTurn" })
/** A dropped duplicate turn message is logged at most this often. */
export const DUPLICATE_LOG_MS = 10_000

/** HTTP statuses on the upgrade that will not fix themselves by retrying. */
const isFatalStatus = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

export class FluxConnection {
  private readonly frameBytes: number
  private readonly maxPending: number
  private readonly silence: Uint8Array
  private frame: Uint8Array
  private fill = 0
  private pending: Array<Uint8Array> = []

  private ws: WebSocket | undefined
  private openedAt = 0
  private lastAudioAt = 0
  private attempt = 0
  private dropping = false
  /** "running" → "finishing" (CloseStream sent, waiting for the server) → "done". */
  private phase: "running" | "finishing" | "done" = "running"
  private reconnectTimer: NodeJS.Timeout | undefined
  private closeTimer: NodeJS.Timeout | undefined
  private keepAliveTimer: NodeJS.Timeout | undefined

  // Turn state of the current connection.
  private turnActive = false
  /**
   * `SpeechStarted` was emitted for the open utterance. The contract with core: every utterance that
   * emitted `SpeechStarted` ends with exactly one `EndOfTurn`, whose text is empty when no words were
   * recognised (a cough, a door), also when the connection drops or the audio ends mid-utterance.
   */
  private speechStarted = false
  private eager = false
  private transcript = ""
  /**
   * Duplicate protection (review round 7). The highest Flux `turn_index` that ended (`EndOfTurn`) on
   * this connection: a turn message for an index at or below it belongs to a turn that is over and is
   * dropped. Indexes restart on a new connection (assumed, not documented), so this is reset there.
   */
  private endedIndex: number | undefined
  /**
   * The last turn message was a final, with no start or interim since. Used only for messages that
   * carry no turn index: such a final (or eager transcript) is taken to repeat the previous one and is
   * dropped, so no `SpeechStarted` is ever synthesised for it.
   */
  private afterFinal = false
  /** Dropped duplicates are logged at most once per `DUPLICATE_LOG_MS`. */
  private lastDuplicateLog = Number.NEGATIVE_INFINITY
  /** Malformed text frames dropped so far (logged at 1, 10, 100, … so a broken peer cannot flood the log). */
  private malformed = 0

  private readonly options: ConnectionOptions
  private readonly cb: ConnectionCallbacks
  private readonly secrets: Secrets

  constructor(options: ConnectionOptions, cb: ConnectionCallbacks) {
    this.options = options
    // The one choke point for upstream text: every log line and every error leaves through these
    // two wrappers, redacted (a peer may echo the key back) before anything is shortened.
    const secrets = secretList(options.apiKey, options.secrets ?? [])
    this.secrets = secrets
    this.cb = {
      emit: cb.emit,
      end: cb.end,
      log: (level, message) => cb.log(level, clip(message, secrets, 300)),
      fail: (error) => cb.fail(new SttError(sanitize(secrets, { message: error.message, cause: error.cause })))
    }
    this.frameBytes = options.chunkMs * BYTES_PER_MS
    this.maxPending = Math.ceil(options.reconnectBufferMs / options.chunkMs)
    this.silence = new Uint8Array(this.frameBytes)
    this.frame = new Uint8Array(this.frameBytes)
  }

  start(): void {
    this.connect()
    this.keepAliveTimer = setInterval(() => {
      if (this.isOpen() && performance.now() - this.lastAudioAt >= this.options.keepAliveMs) {
        this.sendAudio(this.silence)
      }
    }, Math.max(100, this.options.keepAliveMs / 2))
  }

  /** Feed PCM. Cuts the byte stream into fixed frames; a frame is sent the moment it is full. */
  write(chunk: Uint8Array): void {
    let offset = 0
    while (offset < chunk.length) {
      const n = Math.min(this.frameBytes - this.fill, chunk.length - offset)
      this.frame.set(chunk.subarray(offset, offset + n), this.fill)
      this.fill += n
      offset += n
      if (this.fill === this.frameBytes) {
        this.sendAudio(this.frame)
        this.frame = new Uint8Array(this.frameBytes)
        this.fill = 0
      }
    }
  }

  /** Audio ended: flush, ask Deepgram to finish the open turn, close, then end the event stream. */
  finish(): void {
    if (this.phase !== "running") return
    if (this.fill > 0) {
      this.sendAudio(this.frame.subarray(0, this.fill))
      this.fill = 0
    }
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.stop() // still connecting or waiting to reconnect: nothing to flush to
      this.cb.end()
      return
    }
    this.phase = "finishing"
    if (this.turnActive) ws.send(FORCE_END_TURN)
    ws.send(CLOSE_STREAM)
    this.closeTimer = setTimeout(() => ws.terminate(), this.options.closeTimeoutMs)
  }

  /** Consumer went away: close immediately, emit nothing more. */
  stop(): void {
    if (this.phase === "done") return
    const ws = this.ws
    const closeStreamSent = this.phase === "finishing"
    this.done()
    if (!ws) return
    if (ws.readyState === WebSocket.OPEN) {
      if (!closeStreamSent) ws.send(CLOSE_STREAM)
      ws.close(1000)
    } else {
      ws.terminate()
    }
  }

  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private done(): void {
    this.phase = "done"
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.closeTimer)
    clearInterval(this.keepAliveTimer)
    this.pending = []
  }

  private sendAudio(frame: Uint8Array): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Disconnected: keep only the newest few frames. Copy, because `frame` may be reused (silence).
      this.pending.push(frame.slice())
      if (this.pending.length > this.maxPending) this.pending.shift()
      return
    }
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (!this.dropping) this.cb.log("warn", "Deepgram socket is backed up; dropping audio")
      this.dropping = true
      return
    }
    this.dropping = false
    ws.send(frame)
    this.lastAudioAt = performance.now()
  }

  private connect(): void {
    // `handshakeTimeout`: a peer that accepts TCP but never answers the upgrade would otherwise leave
    // the session "connecting" for good (no close, so no reconnect) while audio is discarded.
    // Construction can throw (an address `ws` refuses), also from the reconnect timer, where a throw
    // would escape into Node: the session ends with a sanitised error instead, its timers stopped.
    let ws: WebSocket
    try {
      ws = new WebSocket(this.options.url, {
        headers: { Authorization: `Token ${this.options.apiKey}` },
        handshakeTimeout: this.options.handshakeTimeoutMs
      })
    } catch (e) {
      if (this.phase === "done") return
      this.done()
      this.cb.fail(new SttError({ message: `Could not open the Deepgram connection: ${fromUpstream(e, this.secrets)}` }))
      return
    }
    this.ws = ws
    // A new connection numbers its turns afresh (see `endedIndex`).
    this.endedIndex = undefined
    this.afterFinal = false
    let fatal: SttError | undefined

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0
      if (isFatalStatus(status)) {
        fatal = new SttError({ message: `Deepgram rejected the connection: HTTP ${status}` })
      } else {
        this.cb.log("warn", `Deepgram connection refused: HTTP ${status}`)
      }
      res.resume()
      ws.terminate()
    })

    ws.on("open", () => {
      this.openedAt = performance.now()
      if (this.attempt > 0) this.cb.log("info", `Deepgram reconnected after ${this.attempt} attempt(s)`)
      const pending = this.pending
      this.pending = []
      for (const frame of pending) this.sendAudio(frame)
    })

    // A plain event callback: an exception thrown here would escape into Node, not into the stream.
    // Anything unexpected is dropped (with a bounded log) instead.
    ws.on("message", (data, isBinary) => {
      if (isBinary || this.ws !== ws) return
      try {
        let message: unknown
        try {
          message = JSON.parse(data.toString())
        } catch {
          return this.dropMalformed("a non-JSON text frame")
        }
        if (!isRecord(message)) return this.dropMalformed("a text frame that is not a JSON object")
        const error = this.onMessage(message)
        if (error) {
          fatal = error
          ws.terminate()
        }
      } catch (e) {
        // The error's name only: a runtime's message about upstream text can quote it already cut short
        // (V8's JSON.parse does), and no redaction recognises a credential prefix.
        this.dropMalformed(`a message it could not handle (${errorName(e)})`)
      }
    })

    ws.on("error", (error) => {
      if (this.phase === "running") this.cb.log("warn", `Deepgram socket error: ${error.message}`)
    })

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return
      this.ws = undefined
      clearTimeout(this.closeTimer)
      if (this.phase === "done") return
      // Whatever happens next, a turn that was open on this connection is over.
      this.endOpenTurn()
      if (fatal) {
        this.done()
        this.cb.fail(fatal)
        return
      }
      if (this.phase === "finishing") {
        this.done()
        this.cb.end()
        return
      }
      const upFor = this.openedAt > 0 ? performance.now() - this.openedAt : 0
      if (upFor >= this.options.stableMs) this.attempt = 0
      this.openedAt = 0
      const delay = Math.min(this.options.backoffMaxMs, this.options.backoffInitialMs * 2 ** this.attempt)
      const jittered = delay / 2 + Math.random() * delay / 2
      this.attempt++
      this.cb.log(
        "warn",
        `Deepgram connection closed (${code}${reason.length ? ` ${reason.toString()}` : ""}); reconnecting in ${
          Math.round(jittered)
        } ms`
      )
      this.reconnectTimer = setTimeout(() => this.connect(), jittered)
    })
  }

  private dropMalformed(what: string): void {
    this.malformed++
    if (/^10*$/.test(String(this.malformed))) {
      this.cb.log("warn", `Deepgram sent ${what}; dropped (${this.malformed} malformed message(s) so far)`)
    }
  }

  /** Returns an error when the message means the session cannot continue and retrying will not help. */
  private onMessage(message: Record<string, unknown>): SttError | undefined {
    switch (message["type"]) {
      case "TurnInfo":
        this.onTurnInfo(
          String(message["event"]),
          typeof message["transcript"] === "string" ? message["transcript"] : "",
          typeof message["turn_index"] === "number" && Number.isInteger(message["turn_index"]) ? message["turn_index"] : undefined
        )
        return undefined
      case "Warning":
        this.cb.log("warn", `Deepgram warning ${String(message["code"])}: ${String(message["description"])}`)
        return undefined
      case "Error": {
        const text = `Deepgram error ${String(message["code"])}: ${String(message["description"])}`
        // An error early in a connection is almost certainly configuration, credentials or quota:
        // retrying would repeat it. Later, treat it like a dropped connection (the socket closes next).
        if (this.openedAt === 0 || performance.now() - this.openedAt < this.options.stableMs) {
          return new SttError({ message: text })
        }
        this.cb.log("warn", text)
        return undefined
      }
      default: // Connected, ConfigureSuccess/Failure, anything new
        return undefined
    }
  }

  /**
   * Contract: every transcript event of an utterance is preceded by `SpeechStarted`. Flux can send an
   * Update, EagerEndOfTurn or EndOfTurn with no StartOfTurn (after a reconnect in the middle of an
   * utterance); the conversation ignores transcripts of an utterance that was never opened, so one is
   * synthesised here — only for a turn that has not been opened and has not ended (`isDuplicate` drops
   * messages of an ended turn before they get here).
   */
  private ensureStarted(): void {
    if (!this.speechStarted) this.cb.emit({ _tag: "SpeechStarted" })
    this.speechStarted = true
  }

  /**
   * A turn message that repeats one already handled (review round 7: a repeated final opened a
   * second utterance through the synthesised `SpeechStarted`, and the conversation acted twice).
   * With a turn index: any message for a turn that already ended on this connection. Without one:
   * a final or eager transcript right after a final, with no start or interim between. Not decided
   * by transcript text: the same words said twice are two turns.
   */
  private isDuplicate(event: string, index: number | undefined): boolean {
    if (index !== undefined) return this.endedIndex !== undefined && index <= this.endedIndex
    return this.afterFinal && (event === "EndOfTurn" || event === "EagerEndOfTurn" || event === "TurnResumed")
  }

  private onTurnInfo(event: string, text: string, index: number | undefined): void {
    if (this.isDuplicate(event, index)) {
      const now = performance.now()
      if (now - this.lastDuplicateLog >= DUPLICATE_LOG_MS) {
        this.lastDuplicateLog = now
        this.cb.log("warn", `Deepgram sent ${event} for a turn that already ended${index !== undefined ? ` (turn ${index})` : ""}; dropped`)
      }
      return
    }
    switch (event) {
      case "StartOfTurn":
        this.afterFinal = false
        this.turnActive = true
        this.eager = false
        this.transcript = text
        // A second StartOfTurn without an EndOfTurn continues the same utterance: one SpeechStarted, one EndOfTurn.
        this.ensureStarted()
        if (text) this.cb.emit({ _tag: "Interim", text })
        return
      case "Update":
        if (text && text !== this.transcript) {
          this.afterFinal = false
          this.turnActive = true
          this.transcript = text
          this.ensureStarted()
          this.cb.emit({ _tag: "Interim", text })
        }
        return
      case "EagerEndOfTurn":
        this.turnActive = true
        if (text) this.transcript = text
        // Never an empty EagerEndOfTurn: there is nothing to speculate on (the EndOfTurn still comes).
        if (!this.transcript) return
        this.eager = true
        this.afterFinal = false
        this.ensureStarted()
        this.cb.emit({ _tag: "EagerEndOfTurn", text: this.transcript })
        return
      case "TurnResumed":
        if (this.eager) {
          this.eager = false
          this.cb.emit({ _tag: "TurnResumed" })
        }
        return
      case "EndOfTurn": {
        if (index !== undefined) this.endedIndex = Math.max(index, this.endedIndex ?? index)
        this.afterFinal = true
        const final = text || this.transcript
        if (final) this.ensureStarted()
        const started = this.speechStarted
        this.resetTurn()
        // Closes the utterance even without words (empty text) once SpeechStarted went out; an EndOfTurn
        // with neither words nor a start is no utterance at all.
        if (final || started) this.cb.emit({ _tag: "EndOfTurn", text: final })
        return
      }
    }
  }

  /**
   * The connection ended mid-turn (drop, or no EndOfTurn before close): commit
   * what was heard as `EndOfTurn`, so a consumer holding a speculative reply is
   * never left waiting. After an eager EOT this is the eager transcript, so the
   * speculative reply is promoted. An utterance that emitted `SpeechStarted`
   * is closed even with no words (empty text).
   */
  private endOpenTurn(): void {
    const text = this.transcript
    const open = this.turnActive
    if (open && text) this.ensureStarted()
    const started = this.speechStarted
    this.resetTurn()
    if ((open && text) || started) this.cb.emit({ _tag: "EndOfTurn", text })
  }

  private resetTurn(): void {
    this.turnActive = false
    this.speechStarted = false
    this.eager = false
    this.transcript = ""
  }
}
