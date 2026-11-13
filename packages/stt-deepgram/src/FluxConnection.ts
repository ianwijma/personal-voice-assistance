import type { SttEvent } from "@pva/core"
import { SttError } from "@pva/core"
import WebSocket from "ws"

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

/** HTTP statuses on the upgrade that will not fix themselves by retrying. */
const isFatalStatus = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429

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
  private eager = false
  private transcript = ""

  private readonly options: ConnectionOptions
  private readonly cb: ConnectionCallbacks

  constructor(options: ConnectionOptions, cb: ConnectionCallbacks) {
    this.options = options
    this.cb = cb
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
    const ws = new WebSocket(this.options.url, { headers: { Authorization: `Token ${this.options.apiKey}` } })
    this.ws = ws
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

    ws.on("message", (data, isBinary) => {
      if (isBinary) return
      let message: Record<string, unknown>
      try {
        message = JSON.parse(data.toString())
      } catch {
        this.cb.log("warn", "Deepgram sent a non-JSON text frame")
        return
      }
      const error = this.onMessage(message)
      if (error) {
        fatal = error
        ws.terminate()
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

  /** Returns an error when the message means the session cannot continue and retrying will not help. */
  private onMessage(message: Record<string, unknown>): SttError | undefined {
    switch (message["type"]) {
      case "TurnInfo":
        this.onTurnInfo(String(message["event"]), typeof message["transcript"] === "string" ? message["transcript"] : "")
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

  private onTurnInfo(event: string, text: string): void {
    switch (event) {
      case "StartOfTurn":
        this.turnActive = true
        this.eager = false
        this.transcript = text
        this.cb.emit({ _tag: "SpeechStarted" })
        if (text) this.cb.emit({ _tag: "Interim", text })
        return
      case "Update":
        if (text && text !== this.transcript) {
          this.turnActive = true
          this.transcript = text
          this.cb.emit({ _tag: "Interim", text })
        }
        return
      case "EagerEndOfTurn":
        this.turnActive = true
        this.eager = true
        if (text) this.transcript = text
        this.cb.emit({ _tag: "EagerEndOfTurn", text: this.transcript })
        return
      case "TurnResumed":
        if (this.eager) {
          this.eager = false
          this.cb.emit({ _tag: "TurnResumed" })
        }
        return
      case "EndOfTurn": {
        const final = text || this.transcript
        this.resetTurn()
        if (final) this.cb.emit({ _tag: "EndOfTurn", text: final })
        return
      }
    }
  }

  /**
   * The connection ended mid-turn (drop, or no EndOfTurn before close): commit
   * what was heard as `EndOfTurn`, so a consumer holding a speculative reply is
   * never left waiting. After an eager EOT this is the eager transcript, so the
   * speculative reply is promoted.
   */
  private endOpenTurn(): void {
    const text = this.transcript
    const open = this.turnActive
    this.resetTurn()
    if (open && text) this.cb.emit({ _tag: "EndOfTurn", text })
  }

  private resetTurn(): void {
    this.turnActive = false
    this.eager = false
    this.transcript = ""
  }
}
