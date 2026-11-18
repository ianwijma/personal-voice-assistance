/**
 * A scripted browser for serve mode (docs/UI-AND-MODULES.md §6.1): connects,
 * says hello, claims the audio, streams 16 kHz PCM, simulates the player
 * (counts received reply samples, reports started / progress every 250 ms by
 * wall clock / finished, answers reply.stop), can press Stop, drop the socket,
 * and records every message. Plain Node + `ws` + `@pva/protocol`.
 */
import {
  type AdminSnapshot,
  type ClientMessage,
  decodeReplyFrame,
  decodeServerMessage,
  type DeviceHello,
  encodeClientMessage,
  encodeMicFrame,
  type FrontendRole,
  MIC_FRAME_SAMPLES,
  PROTOCOL_VERSION,
  type ServerMessage,
  type ServerMessageOf,
  type ServerMessageType,
  WEB_VOICE_KIND,
  WS_PATH
} from "@pva/protocol"
import { randomUUID } from "node:crypto"

/** What an admin page has after logging in: the voice `welcome` and the `admin.snapshot`, and its session token. */
export interface AdminWelcome {
  readonly welcome: ServerMessageOf<"welcome">
  readonly snapshot: AdminSnapshot
  readonly token: string
}

let requestCounter = 0
import WebSocket from "ws"

export interface PlayerOptions {
  /** Simulate the player at all. Default true (an owner that never reports is a stalled browser). */
  readonly enabled?: boolean
  /** Playback speed relative to real time. Default 1. */
  readonly speed?: number
  /** Report interval (wall clock). Default 250 ms. */
  readonly progressMs?: number
  /**
   * The player's clock in ms: how far it has played is this clock's time since its first frame (times `speed`).
   * Default `performance.now`. A test that needs the page at a given place in the reply gives a clock of its own and
   * moves it, so a busy machine cannot carry the page further than the test says.
   */
  readonly now?: () => number
  /** Reported in playback.started. */
  readonly outputLatencyMs?: number
  /**
   * Answer `reply.stop` as a page whose worklet is slow to confirm: first `playback.stopped` with this provisional
   * count (`exact: false`, from the true count and the reply's rate), then the true count (`exact: true`) after
   * `exactAfterMs`. Default: one answer with the true count and no `exact` field (an older page).
   */
  readonly provisionalStop?: { readonly count: (played: number, sampleRate: number) => number; readonly exactAfterMs: number }
}

export interface ScriptedClientOptions {
  readonly url: string
  readonly origin?: string
  readonly clientId?: string
  /** The device this voice page says it is (default: one per client, `dev-<random>`, kind `web-voice`). */
  readonly deviceId?: string
  readonly player?: PlayerOptions
}

interface Reply {
  readonly turnId: number
  readonly sampleRate: number
  received: number
  played: number
  ended: boolean
  startedAt: number | undefined
  firstFrameAt: number | undefined
  done: boolean
  timer: ReturnType<typeof setInterval> | undefined
}

export class ScriptedClient {
  readonly messages: Array<ServerMessage> = []
  /** Reply audio received, per turn: samples. */
  readonly replySamples = new Map<number, number>()
  readonly clientId: string
  readonly device: DeviceHello
  readonly closed: Promise<{ code: number; reason: string }>
  private readonly waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; from: number }> = []
  private reply: Reply | undefined
  private seq = 0
  /** Where the next `waitFor` starts looking: just after the message the previous one returned. */
  private cursor = 0
  private readonly player: Required<Omit<PlayerOptions, "provisionalStop">> & { readonly provisionalStop: PlayerOptions["provisionalStop"] | undefined }

  readonly ws: WebSocket

  private constructor(ws: WebSocket, options: ScriptedClientOptions) {
    this.ws = ws
    this.clientId = options.clientId ?? `client-${randomUUID()}`
    this.device = { id: options.deviceId ?? `dev-${randomUUID()}`, kind: WEB_VOICE_KIND, name: "Test browser" }
    this.player = {
      enabled: options.player?.enabled ?? true,
      speed: options.player?.speed ?? 1,
      progressMs: options.player?.progressMs ?? 250,
      now: options.player?.now ?? (() => performance.now()),
      outputLatencyMs: options.player?.outputLatencyMs ?? 12,
      provisionalStop: options.player?.provisionalStop
    }
    this.closed = new Promise((resolve) => ws.on("close", (code, reason) => {
      this.stopReply()
      resolve({ code, reason: reason.toString() })
    }))
    ws.on("message", (data, isBinary) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (isBinary) return this.onFrame(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
      const decoded = decodeServerMessage(buffer.toString("utf8"))
      if (decoded._tag !== "Ok") throw new Error(`server sent an invalid message: ${JSON.stringify(decoded)}`)
      this.onMessage(decoded.message)
    })
  }

  /** Open the socket (rejects with the HTTP status on a refused upgrade). */
  static connect(options: ScriptedClientOptions): Promise<ScriptedClient> {
    const url = `${options.url.replace(/^http/, "ws")}${WS_PATH}`
    const ws = new WebSocket(url, options.origin !== undefined ? { headers: { Origin: options.origin } } : {})
    const client = new ScriptedClient(ws, options)
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(client))
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
      ws.once("error", reject)
    })
  }

  send(message: ClientMessage): void {
    this.ws.send(encodeClientMessage(message))
  }

  sendRaw(data: string | Uint8Array): void {
    this.ws.send(data)
  }

  /**
   * Say hello. Default: a voice page with this client's `device` (`device: false` sends none). `frontend: "admin"`
   * sends no device, and `adminToken` when given.
   */
  async hello(options: {
    readonly resumeOwner?: boolean
    readonly protocol?: number
    readonly frontend?: FrontendRole
    readonly device?: DeviceHello | false
    readonly adminToken?: string
  } = {}): Promise<ServerMessageOf<"welcome">> {
    const frontend = options.frontend ?? "voice"
    const device = frontend === "voice" && options.device !== false ? options.device ?? this.device : undefined
    this.send({
      type: "hello",
      protocol: options.protocol ?? PROTOCOL_VERSION,
      clientId: this.clientId,
      resumeOwner: options.resumeOwner ?? false,
      frontend,
      ...(device !== undefined ? { device } : {}),
      ...(options.adminToken !== undefined ? { adminToken: options.adminToken } : {})
    })
    return this.waitFor("welcome")
  }

  /** `admin.login` on this (admin) connection: the result, and after success the `admin.snapshot`. */
  async login(password: string): Promise<{ readonly result: ServerMessageOf<"result">; readonly snapshot?: AdminSnapshot }> {
    const requestId = `login-${++requestCounter}`
    const from = this.messages.length
    this.send({ type: "admin.login", requestId, password })
    const result = await this.waitFor("result", (m) => m.requestId === requestId, { from })
    if (!result.ok) return { result }
    const snapshot = (await this.waitFor("admin.snapshot", () => true, { from })).snapshot
    return { result, snapshot }
  }

  /** Hello as an admin page and log in (the usual start of a test that changes settings). */
  async admin(password: string): Promise<AdminWelcome> {
    const welcome = await this.hello({ frontend: "admin" })
    const { result, snapshot } = await this.login(password)
    if (!result.ok || snapshot === undefined || result.admin === undefined) throw new Error(`admin login failed: ${JSON.stringify(result)}`)
    return { welcome, snapshot, token: result.admin.token }
  }

  /** Become the audio owner. The interrupt mode comes from the device profile (protocol 5). */
  async claim(): Promise<ServerMessageOf<"session">> {
    this.seq = 0
    const from = this.messages.length
    this.send({ type: "audio.claim", audio: { contextSampleRate: 48_000, outputPath: "direct", outputLatencyMs: this.player.outputLatencyMs } })
    return this.waitFor("session", (m) => m.role === "owner", { from })
  }

  /** Send 16 kHz PCM as 20 ms microphone frames, in real time (default) or as fast as possible. */
  async streamPcm(pcm: Uint8Array, options: { readonly realTime?: boolean } = {}): Promise<void> {
    const frameBytes = MIC_FRAME_SAMPLES * 2
    const start = performance.now()
    for (let offset = 0, i = 0; offset < pcm.length; offset += frameBytes, i++) {
      const frame = new Uint8Array(frameBytes)
      frame.set(pcm.subarray(offset, offset + frameBytes))
      this.ws.send(encodeMicFrame(this.seq, frame))
      this.seq = (this.seq + 1) >>> 0
      if (options.realTime !== false) {
        const due = start + (i + 1) * 20
        const wait = due - performance.now()
        if (wait > 0) await sleep(wait)
      }
    }
  }

  /** Stream silence (a quiet noise floor) for `ms`, in real time. */
  silence(ms: number): Promise<void> {
    const samples = new Int16Array(Math.round((ms / 1000) * 16_000))
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round((Math.random() - 0.5) * 20)
    return this.streamPcm(new Uint8Array(samples.buffer))
  }

  /** The user pressed Stop: silence the player locally, then interrupt, then report the final count. */
  pressStop(): void {
    const reply = this.reply
    if (reply !== undefined && !reply.done) {
      this.advance(reply)
      this.finishReply(reply, "stopped", true)
      this.send({ type: "interrupt", turnId: reply.turnId })
      this.send({ type: "playback.stopped", turnId: reply.turnId, playedSamples: reply.played })
    } else this.send({ type: "interrupt" })
  }

  /** Drop the connection without a close handshake (like a lost network). */
  drop(): void {
    this.stopReply()
    this.ws.terminate()
  }

  close(): void {
    this.stopReply()
    this.ws.close()
  }

  /**
   * Resolve with the first message of `type` (matching `match`) at or after index
   * `from` (default: just after the message the previous `waitFor` returned, so
   * consecutive calls read the messages in order).
   */
  waitFor<T extends ServerMessageType>(
    type: T,
    match: (message: ServerMessageOf<T>) => boolean = () => true,
    options: { readonly from?: number; readonly timeoutMs?: number } = {}
  ): Promise<ServerMessageOf<T>> {
    const from = options.from ?? this.cursor
    const test = (m: ServerMessage) => m.type === type && match(m as ServerMessageOf<T>)
    const index = this.messages.findIndex((m, i) => i >= from && test(m))
    if (index >= 0) {
      this.cursor = index + 1
      return Promise.resolve(this.messages[index] as ServerMessageOf<T>)
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`timed out waiting for ${type}; received: ${this.messages.slice(from).map((m) => m.type).join(", ")}`))
      }, options.timeoutMs ?? 5_000)
      this.waiters.push({ match: test, from, resolve: (m) => {
        clearTimeout(timeout)
        this.cursor = this.messages.length
        resolve(m as ServerMessageOf<T>)
      } })
    })
  }

  /** Index of the next message to arrive. */
  get position(): number {
    return this.messages.length
  }

  types(from = 0): Array<string> {
    return this.messages.slice(from).map((m) => m.type)
  }

  private onMessage(message: ServerMessage) {
    this.messages.push(message)
    for (const waiter of [...this.waiters]) {
      if (waiter.match(message)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
    }
    switch (message.type) {
      case "reply.start": {
        this.stopReply()
        this.reply = { turnId: message.turnId, sampleRate: message.sampleRate, received: 0, played: 0, ended: false, startedAt: undefined, firstFrameAt: undefined, done: false, timer: undefined }
        return
      }
      case "reply.end": {
        if (this.reply?.turnId === message.turnId) {
          this.reply.ended = true
          this.tick(this.reply)
        }
        return
      }
      case "reply.stop": {
        const reply = this.reply
        const provisional = this.player.provisionalStop
        if (reply !== undefined && reply.turnId === message.turnId && !reply.done && provisional !== undefined) {
          this.advance(reply)
          this.finishReply(reply, "stopped", true)
          this.send({ type: "playback.stopped", turnId: reply.turnId, playedSamples: provisional.count(reply.played, reply.sampleRate), exact: false })
          setTimeout(() => this.send({ type: "playback.stopped", turnId: reply.turnId, playedSamples: reply.played, exact: true }), provisional.exactAfterMs)
        } else if (reply !== undefined && reply.turnId === message.turnId && !reply.done) {
          this.advance(reply)
          this.finishReply(reply, "stopped", false)
        } else if (reply !== undefined && reply.turnId === message.turnId) {
          // Already idle: answer again with the same final count.
          this.send({ type: "playback.stopped", turnId: reply.turnId, playedSamples: reply.played })
        }
        return
      }
    }
  }

  private onFrame(data: Uint8Array) {
    const decoded = decodeReplyFrame(data)
    if (!decoded.ok) throw new Error(decoded.error)
    const { turnId, pcm } = decoded.frame
    this.replySamples.set(turnId, (this.replySamples.get(turnId) ?? 0) + pcm.length / 2)
    const reply = this.reply
    if (reply === undefined || reply.turnId !== turnId || reply.done) return
    reply.received += pcm.length / 2
    if (!this.player.enabled) return
    if (reply.startedAt === undefined) {
      reply.firstFrameAt = this.player.now()
      reply.startedAt = this.player.now()
      this.send({ type: "playback.started", turnId, outputLatencyMs: this.player.outputLatencyMs, startDelayMs: 0 })
      reply.timer = setInterval(() => this.tick(reply), this.player.progressMs)
    }
  }

  /** Samples "handed to the device" so far: limited by what arrived and by wall-clock time. */
  private advance(reply: Reply) {
    if (reply.startedAt === undefined) return
    const elapsed = (this.player.now() - reply.startedAt) / 1000
    reply.played = Math.max(reply.played, Math.min(reply.received, Math.floor(elapsed * reply.sampleRate * this.player.speed)))
  }

  private tick(reply: Reply) {
    if (!this.player.enabled || reply.done || reply.startedAt === undefined) return
    this.advance(reply)
    if (reply.ended && reply.played >= reply.received) return this.finishReply(reply, "finished", false)
    this.send({ type: "playback.progress", turnId: reply.turnId, playedSamples: reply.played, underruns: 0 })
  }

  private finishReply(reply: Reply, how: "finished" | "stopped", silent: boolean) {
    reply.done = true
    if (reply.timer !== undefined) clearInterval(reply.timer)
    if (!silent) this.send({ type: how === "finished" ? "playback.finished" : "playback.stopped", turnId: reply.turnId, playedSamples: reply.played })
  }

  private stopReply() {
    if (this.reply?.timer !== undefined) clearInterval(this.reply.timer)
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
