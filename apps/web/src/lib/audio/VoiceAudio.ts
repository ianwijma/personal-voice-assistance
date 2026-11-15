import type { MicProcessing, MicReport, ReplyStats } from "./diagnostics.ts"
import type { AudioClientInfo, OutputPath } from "./types.ts"
import { levels, pushMicFrame } from "./levels.ts"
import { Lifecycle, type LifecycleState, type Ticket } from "./lifecycle.ts"
import { type InheritedReply, PlaybackLink, type PlaybackRoute, type PlayerPort, ROUTE_REASONS, SharedCounter, STOP_ANSWER_MS } from "./playback.ts"

/**
 * The page's audio: one `AudioContext` at the device's native rate, the
 * microphone capture graph (worklet → 16 kHz s16le frames) and the reply
 * player (worklet with a queue, a per-reply resampler and instant stop).
 *
 * Framework-free: React only calls `start()` (synchronously, from the Start
 * click) and the setters. Derived from docs/research/browser-audio.md, with the
 * changes listed in apps/web/README.md.
 */

/** The capture worklet's output rate (the microphone frames sent to the server and kept in `levels.mic`). */
const CAPTURE_RATE = 16_000

export type PlayerEvent =
  | { readonly type: "started"; readonly id: number; readonly startDelayMs: number }
  | { readonly type: "progress"; readonly id: number; readonly playedSamples: number; readonly underruns: number }
  | { readonly type: "finished"; readonly id: number; readonly playedSamples: number }
  | {
    readonly type: "stopped"
    readonly id: number
    readonly playedSamples: number
    readonly report: boolean
    /** The worklet's own final count (true), or the page's best count, a lower bound (false; see `playback.ts`). */
    readonly exact?: boolean
  }
  | { readonly type: "underrun"; readonly id: number; readonly underruns: number }
  | ({ readonly type: "stats" } & ReplyStats)

export interface VoiceAudioEvents {
  /** A 20 ms microphone frame: 8 empty header bytes + 320 samples of 16 kHz s16le, ready to send. */
  readonly onMicFrame: (buffer: ArrayBuffer) => void
  /**
   * A player event. `current`: it comes from this session's player (false for an older session's player
   * still finishing its final counts after End or a takeover: its reports must still reach the server,
   * but it must not change what the page shows for the session that replaced it).
   */
  readonly onPlayer: (event: PlayerEvent, current: boolean) => void
  /** The context was suspended or resumed by the browser, or the microphone failed. */
  readonly onState: (state: "running" | "suspended" | "error", detail?: string) => void
  /**
   * The microphone stays muted by the system after `MUTED_MAX_REOPENS` reopens (a hardware mute switch, an
   * app holding it): a message for the owner (audio stays on), or undefined once it is live again.
   */
  readonly onMicMuted?: (message: string | undefined) => void
  /** The route the player's live count takes, and why (for the diagnostics; see `PlaybackRoute`). */
  readonly onRoute?: (route: PlaybackRoute) => void
}

export interface StartOptions {
  readonly micDeviceId: string
  readonly sinkId: string
  readonly outputPath: OutputPath
  readonly prebufferMs: number
  /** The browser's voice processing (all on by default). */
  readonly processing?: MicProcessing
}

export const DEFAULT_PROCESSING: MicProcessing = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

export const MIC_CONSTRAINTS: MediaTrackConstraints = { channelCount: 1, ...DEFAULT_PROCESSING }

/** The `getUserMedia` audio constraints for a microphone and processing choice. */
export const micConstraints = (deviceId: string, processing: MicProcessing): MediaTrackConstraints => ({
  ...MIC_CONSTRAINTS,
  ...processing,
  ...(deviceId !== "" ? { deviceId: { exact: deviceId } } : {})
})

/** The owner-facing explanation of a `getUserMedia` failure (from the research, §4). */
export const describeMicError = (e: unknown): string => {
  const name = (e as { name?: string } | null)?.name
  switch (name) {
    case "NotAllowedError":
      return "Microphone permission was denied. Allow it in the browser's site settings, then press Try again."
    case "NotFoundError":
      return "No microphone found."
    case "NotReadableError":
      return "The microphone is in use by another app or blocked by the system."
    case "OverconstrainedError":
      return "The selected microphone is not available. Choose another one in Settings › Microphone."
    case "SecurityError":
      return "The browser blocked the microphone on this page. It needs HTTPS or localhost."
    default:
      return `Could not start audio (${name ?? (e instanceof Error ? e.message : "unknown error")}).`
  }
}

/**
 * A microphone change failed, and the previous (or the default) microphone was opened again
 * instead: audio keeps working, on `fallback`. `cause` is the original failure.
 */
export class MicFallbackError extends Error {
  override readonly cause: unknown
  readonly fallback: { readonly deviceId: string; readonly processing: MicProcessing }
  constructor(cause: unknown, fallback: { readonly deviceId: string; readonly processing: MicProcessing }) {
    super(`${describeMicError(cause)} Using the previous microphone instead.`)
    this.name = "MicFallbackError"
    this.cause = cause
    this.fallback = fallback
  }
}

/**
 * Player failures (`processorerror`, seventh review, finding 2): a failed player is replaced at most
 * `MAX_PLAYER_REPLACEMENTS` times within `PLAYER_FAILURE_WINDOW_MS`; the next failure in that window ends audio
 * with `PLAYER_FAILED_MESSAGE` (the fatal path: the reply's count goes out, the audio is given back to the
 * server, the context closes, and the owner sees the error and Start).
 *
 * Why 2 in 60 s: the one known cause, a worklet that fails with the shared counter, takes one replacement (the
 * replacement runs without it); a second allows for one unrelated, transient failure (memory pressure on a
 * phone). A third within a minute means the cause is still there: every reply would be cut off and recovered
 * again, so the page stops and says so. A minute is long next to a reply (seconds), so a fault that hits every
 * reply uses up the allowance within one or two replies, and short next to a session, so isolated failures far
 * apart are each recovered.
 */
export const MAX_PLAYER_REPLACEMENTS = 2
export const PLAYER_FAILURE_WINDOW_MS = 60_000
export const PLAYER_FAILED_MESSAGE =
  "The speaker stopped working: the audio player failed three times within a minute. Press Start to turn audio on again."
/** A failed player whose replacement could not be built, connected or wired (after the final review): the same fatal path. */
export const PLAYER_RESTART_FAILED_MESSAGE =
  "The speaker stopped working: the audio player failed and could not be restarted. Press Start to turn audio on again."
/** The capture worklet's processor failed (after the final review): the microphone gives no more frames. */
export const CAPTURE_FAILED_MESSAGE = "The microphone stopped working: audio capture failed. Press Start to turn audio on again."

/** How long a stop waits for the worklet's exact count before the page answers with its best count (see `playback.ts`). */
export const STOP_FALLBACK_MS = STOP_ANSWER_MS
/** A microphone that stays muted this long while the context runs and the page is visible is reopened. */
export const MUTED_REOPEN_MS = 1500
/** At most one automatic reopen of a muted microphone per this long (a microphone muted for good must not loop). */
export const MUTED_REOPEN_EVERY_MS = 10_000
/** Reopens of a microphone that keeps coming back muted before the page stops trying and tells the owner. */
export const MUTED_MAX_REOPENS = 3
export const MUTED_MESSAGE =
  "The microphone is muted by the system (a mute switch, a call, or another app using it). Audio stays on; it works again as soon as the microphone is unmuted."

type MicChoice = { readonly deviceId: string; readonly processing: MicProcessing }
const sameChoice = (a: MicChoice, b: MicChoice) =>
  a.deviceId === b.deviceId && a.processing.echoCancellation === b.processing.echoCancellation &&
  a.processing.noiseSuppression === b.processing.noiseSuppression && a.processing.autoGainControl === b.processing.autoGainControl

// v=5: reply instance tokens and a 5-Int32 shared counter (seventh review, finding 3); a cached older worklet must not be used.
const workletUrl = (name: string) => new URL(`worklets/${name}.js?v=5`, document.baseURI).toString()

/** The shared-buffer failure the browser raised, for the diagnostics line. */
const refusedReason = (e: unknown) =>
  `the browser refused the shared buffer (${(e as { name?: string } | null)?.name ?? (e instanceof Error ? e.message : "error")})`

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }
type SinkElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

export class VoiceAudio {
  private ctx: AudioContext | undefined
  private mic: MediaStream | undefined
  private micSource: MediaStreamAudioSourceNode | undefined
  private capture: AudioWorkletNode | undefined
  private player: AudioWorkletNode | undefined
  /** Reply playback of this session (counts, stops, teardown); a new session gets a new one. */
  private link: PlaybackLink | undefined
  /** When this session's players failed (`performance.now()`), within `PLAYER_FAILURE_WINDOW_MS`: see `playerFailed`. */
  private playerFailures: Array<number> = []
  private analyser: AnalyserNode | undefined
  private streamDest: MediaStreamAudioDestinationNode | undefined
  private element: SinkElement | undefined
  private outputPath: OutputPath = "direct"
  /**
   * The output route and its play attempt (fifth review, finding 3): bumped by every `play()` of the
   * element and every output-path change, so a late `play()` outcome acts only while it is still the
   * attempt in force (the context's identity alone says nothing about which route is current).
   */
  private playAttempt = 0
  private prebufferMs = 60
  private sinkId = ""
  /** The microphone choice requested (the latest device and processing). */
  private deviceId = ""
  private processing: MicProcessing = DEFAULT_PROCESSING
  /** The choice the open microphone was opened with, and the request it belongs to. */
  private micChoice: MicChoice | undefined
  private micRequest = -1
  /**
   * The session and microphone lifecycle (see `lifecycle.ts`). Every continuation captures a
   * ticket before its first await and checks it after: a stale one only cleans up after itself.
   */
  private readonly lifecycle = new Lifecycle()
  /** Resolves when the current `start()` has finished (either way); changes made meanwhile wait on it. */
  private starting: Promise<void> | undefined
  private mutedTimer: ReturnType<typeof setTimeout> | undefined
  private lastMutedReopen = -Infinity
  /** Automatic reopens since the microphone was last heard live (reset by an unmute or a chosen change). */
  private mutedReopens = 0
  private mutedNotified = false
  /**
   * The output element was paused (an audio-session interruption, the lock-screen controls) or
   * refused to play. The context would keep rendering into it, and the player would report as
   * played audio nobody hears; suspend the context instead, so nothing is counted, the server's
   * stall timer sees the truth, and the page shows "Resume" (`onState("suspended")`).
   */
  // continuation(identity): an element event acts only for the session's current element (an older
  // session's element keeps its listeners) and only on the current session's state.
  private readonly onElementPause = (e?: Event) => {
    const el = this.element
    if (e !== undefined && e.target !== el) return
    if (!this.lifecycle.active || this.outputPath !== "element" || el === undefined || !el.paused || el.srcObject === null) return
    void this.ctx?.suspend().catch(() => undefined) // continuation(none): ignores the outcome
  }
  // continuation(identity): as above.
  private readonly onElementPlaying = (e?: Event) => {
    if (e !== undefined && e.target !== this.element) return
    if (!this.lifecycle.active || this.outputPath !== "element" || this.ctx?.state !== "suspended") return
    void this.ctx.resume().catch(() => undefined) // continuation(none): ignores the outcome
  }
  // continuation(state): registered per session (removed in `stop`); acts only on a running session whose own microphone ended.
  private readonly onDeviceChange = () => {
    // The selected microphone was unplugged: fall back to the default one.
    if (this.lifecycle.state === "running" && this.mic?.getAudioTracks()[0]?.readyState === "ended") {
      void this.setMicDevice("").catch(() => undefined) // continuation(request): `replaceMic` checks its own request ticket
    }
  }

  private readonly events: VoiceAudioEvents

  constructor(events: VoiceAudioEvents) {
    this.events = events
  }

  static supported(): boolean {
    return typeof window !== "undefined" && typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined" &&
      navigator.mediaDevices !== undefined
  }

  get running(): boolean {
    return this.ctx !== undefined && this.lifecycle.active
  }

  /** The lifecycle state (for diagnostics and tests). */
  get state(): LifecycleState {
    return this.lifecycle.state
  }

  /** The microphone choice actually open (after a fallback it differs from the one requested). */
  micInUse(): MicChoice | undefined {
    return this.micChoice
  }

  get contextState(): AudioContextState | undefined {
    return this.ctx?.state
  }

  /**
   * Start audio. **Must be called synchronously from a click or tap handler**:
   * the context is created and resumed, and the media element unlocked, before
   * the first `await`, so the browser counts the gesture.
   */
  start(options: StartOptions): Promise<AudioClientInfo> {
    // A Start while audio is open (the client never does this) first closes the old session.
    if (this.lifecycle.active) void this.stop() // continuation(session): `stop` finishes only its own session
    const ticket = this.lifecycle.dispatch("start")!
    this.playerFailures = []
    const ctx = new AudioContext({ latencyHint: "interactive" })
    this.ctx = ctx
    const resumed = ctx.resume()
    this.outputPath = options.outputPath
    this.sinkId = options.sinkId
    this.deviceId = options.micDeviceId
    this.processing = options.processing ?? DEFAULT_PROCESSING
    this.prebufferMs = options.prebufferMs
    if (options.outputPath === "element") this.unlockElement()
    const done = this.finishStart(ctx, resumed, options, ticket)
    const settled = done.then(() => undefined, () => undefined) // continuation(none): only settles
    this.starting = settled
    // continuation(identity): clears `starting` only if it is still this start's.
    void settled.then(() => {
      if (this.starting === settled) this.starting = undefined
    })
    return done
  }

  private async finishStart(ctx: AudioContext, resumed: Promise<void>, options: StartOptions, ticket: Ticket): Promise<AudioClientInfo> {
    const session = this.lifecycle.sessionGuard()
    const current = () => session.current() && this.lifecycle.isSession(ticket) && this.ctx === ctx
    const abandoned = () => new DOMException("Audio was stopped while starting", "AbortError")
    let mic: MediaStream | undefined
    try {
      // The microphone: if the device or processing changes while permission is pending, the
      // answer is superseded (stopped) and the latest choice is opened instead; the session lives on.
      for (;;) {
        const request = this.lifecycle.ticket()
        const choice: MicChoice = { deviceId: this.deviceId, processing: this.processing }
        let stream: MediaStream
        try {
          stream = await this.openMic(choice) // continuation(session+request): `current()` and `isRequest(request)` below
        } catch (e) {
          if (!current()) throw abandoned()
          if (!this.lifecycle.isRequest(request)) continue // a refusal of a superseded choice
          throw e
        }
        if (!current()) {
          stopStream(stream)
          throw abandoned()
        }
        if (!this.lifecycle.isRequest(request)) {
          stopStream(stream)
          continue
        }
        mic = stream
        this.useMic(stream, choice, request)
        this.lifecycle.dispatch("mic-acquired")
        break
      }
      await resumed // continuation(session): checked by `current()` after the modules load (nothing acts in between)
      await Promise.all([ctx.audioWorklet.addModule(workletUrl("capture")), ctx.audioWorklet.addModule(workletUrl("player"))]) // continuation(session): `current()` next
      if (!current()) throw abandoned()

      // Capture: microphone → capture worklet → (silent) destination, so the graph is pulled.
      this.capture = new AudioWorkletNode(ctx, "pva-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate: CAPTURE_RATE }
      })
      const silent = ctx.createGain()
      silent.gain.value = 0
      this.capture.connect(silent).connect(ctx.destination)
      const capture = this.capture
      // continuation(session+identity): only this start's session, while `capture` is its capture node. A failed
      // capture processor sends no more frames (after the final review): the fatal path, no automatic recovery.
      capture.onprocessorerror = () => {
        if (!current() || this.capture !== capture) return
        if (this.lifecycle.dispatch("track-ended") !== undefined) this.events.onState("error", CAPTURE_FAILED_MESSAGE)
      }
      // continuation(session): microphone frames of an abandoned start (or of a session `stop` detached) are never sent.
      this.capture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (!current()) return
        const buffer = e.data
        pushMicFrame(new Int16Array(buffer, 8), performance.now(), CAPTURE_RATE)
        this.events.onMicFrame(buffer)
      }
      this.connectMic()

      // Playback: player worklet → analyser (visualiser tap, passes audio through) → output. The worklet
      // publishes its live count into shared memory where the page may have it (cross-origin isolated),
      // otherwise by message (see `playback.ts`, `createPlayer`).
      this.analyser = ctx.createAnalyser()
      // 2048 samples is 43 ms at 48 kHz: the stage's feature extractor needs about 40 ms for pitch. The size only
      // changes what the tap reports when read (on the main thread); the audio passes through unchanged.
      this.analyser.fftSize = 2048
      this.analyser.smoothingTimeConstant = 0.5
      this.createPlayer(ctx, SharedCounter.available(), ROUTE_REASONS.notIsolated)
      this.routeOutput()
      levels.outAnalyser = this.analyser
      // The speaker and the prebuffer are read now, not from `options`: a change made while the permission
      // prompt was up is recorded in the fields and must not be overwritten by the choice at Start (fifth review).
      if (this.sinkId !== "") await this.applySink(this.sinkId).catch(() => undefined) // continuation(session): `current()` next
      if (!current()) throw abandoned()

      // continuation(identity): acts only while `ctx` is still this session's context and the session is active.
      ctx.onstatechange = () => {
        if (this.ctx !== ctx || !this.lifecycle.active) return
        // The device is silent from here: the player must resume from silence, not from where it was.
        if (ctx.state !== "running") this.link?.suspended(ctx.currentTime)
        this.events.onState(ctx.state === "running" ? "running" : "suspended")
        if (ctx.state === "running") this.checkCapture()
      }
      navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange) // continuation(state): see `onDeviceChange`
      this.lifecycle.dispatch("started")
      // A change made while the graph was being built (after the microphone was granted): apply it now.
      if (this.micRequest !== this.lifecycle.ticket().request) void this.replaceMic().catch(() => undefined) // continuation(request): `replaceMic` checks its ticket
      return this.info()
    } catch (e) {
      if (current()) {
        this.lifecycle.dispatch("mic-refused") // the session failed: nothing of it may continue
        await this.stop() // continuation(session): `stop` finishes only its own session; nothing after it but the rethrow
      } else {
        // Superseded by End or by a newer Start: release only what this attempt opened, never the
        // newer session's resources.
        if (mic !== undefined) stopStream(mic)
        if (this.mic === mic) this.mic = undefined
        if (ctx.state !== "closed") await ctx.close().catch(() => undefined) // continuation(none): closes only this attempt's own context
      }
      throw e
    }
  }

  /**
   * The player node and its link, connected to the analyser. With `shared`, the node gets a shared counter;
   * every way that can fail ends on the message route, working (fifth review, finding 4): a node that cannot
   * be constructed with the buffer (`DataCloneError`, or anything else) is constructed again without it; a
   * processor that fails with it (`processorerror`) is replaced by one without it; a worklet that says it got
   * no buffer, never confirms one, or whose counter does not keep up with its own count messages, is told to
   * send messages (`PlaybackLink`). The route and why go to `onRoute` (the diagnostics line). Every player, a
   * replacement too and one without shared memory, is watched for `processorerror` (`playerFailed`).
   */
  private createPlayer(ctx: AudioContext, shared: boolean, reason: string, inherited?: ReadonlyMap<number, InheritedReply>) {
    const options = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] }
    let counter = shared ? new SharedCounter() : undefined
    let routeReason = reason
    let node: AudioWorkletNode | undefined
    if (counter !== undefined) {
      try {
        node = new AudioWorkletNode(ctx, "pva-player", { ...options, processorOptions: { counter: counter.buffer } })
      } catch (e) {
        counter = undefined
        routeReason = refusedReason(e)
      }
    }
    node ??= new AudioWorkletNode(ctx, "pva-player", { ...options, processorOptions: {} })
    const player = node
    // continuation(link): this link's events, tagged with whether it is still the session's link. Its
    // final counts must reach the server even after End (the client sends reports by turn id), but an
    // older link must not change what the page shows for a newer session.
    const link: PlaybackLink = new PlaybackLink(player.port as unknown as PlayerPort, (e) => this.events.onPlayer(e, this.link === link), {
      counter,
      routeReason,
      ...(inherited !== undefined ? { inherited } : {}),
      // continuation(link): only the session's current link reports its route.
      onRoute: (route) => {
        if (this.link === link) this.events.onRoute?.(route)
      }
    })
    // continuation(identity): only for this node while it is the session's player, in its own context.
    player.onprocessorerror = () => {
      if (this.player !== player || this.ctx !== ctx || !this.lifecycle.active) return
      this.playerFailed(ctx, player, link, counter !== undefined)
    }
    this.player = player
    this.link = link
    link.prebuffer(this.prebufferMs)
    if (this.analyser !== undefined) player.connect(this.analyser)
    this.events.onRoute?.(link.route)
  }

  /**
   * The session's player failed (`processorerror`): answer for what it had (what it published, provisional:
   * `PlaybackLink.retire`), then replace it, without shared memory, unless it is the third failure within
   * `PLAYER_FAILURE_WINDOW_MS` (`MAX_PLAYER_REPLACEMENTS`): then the session fails (`PLAYER_FAILED_MESSAGE`) and
   * the client takes the fatal path (it releases the audio and shows the error with Start), so the page never
   * looks as if it could speak when it cannot. A new player inherits the page's records of every reply the
   * failed one knew (including those it inherited) and answers for them only from those records; a reply that
   * was playing is over on the page (`playback.ts`, rules (a)–(d)).
   */
  private playerFailed(ctx: AudioContext, old: AudioWorkletNode, link: PlaybackLink, hadCounter: boolean) {
    const at = performance.now()
    this.playerFailures = this.playerFailures.filter((t) => at - t < PLAYER_FAILURE_WINDOW_MS)
    const inherited = link.retire(ctx.state !== "running")
    old.onprocessorerror = null
    try {
      old.disconnect()
    } catch {
      // already disconnected
    }
    if (this.playerFailures.length >= MAX_PLAYER_REPLACEMENTS) {
      // The detached link stays the session's until `stop` (nothing more is sent to the dead node).
      if (this.lifecycle.dispatch("player-failed") !== undefined) this.events.onState("error", PLAYER_FAILED_MESSAGE)
      return
    }
    this.playerFailures.push(at)
    const reason = hadCounter
      ? "the player failed with the shared buffer (processorerror); restarted without it"
      : "the player failed (processorerror); restarted"
    try {
      this.createPlayer(ctx, false, reason, inherited)
    } catch {
      // The replacement could not be built, connected or wired (after the final review): the same fatal path.
      if (this.lifecycle.dispatch("player-failed") !== undefined) this.events.onState("error", PLAYER_RESTART_FAILED_MESSAGE)
    }
  }

  private openMic(choice: MicChoice): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ audio: micConstraints(choice.deviceId, choice.processing), video: false })
  }

  /** Make `stream` the session's microphone and watch its track (ended: fatal; muted: maybe reopen). */
  private useMic(stream: MediaStream, choice: MicChoice, request: Ticket) {
    this.mic = stream
    this.micChoice = choice
    this.micRequest = request.request
    const track = stream.getAudioTracks()[0]
    // continuation(session+identity): only this stream while it is the session's microphone.
    track?.addEventListener("ended", () => {
      if (this.mic !== stream || !this.lifecycle.isSession(request)) return
      if (this.lifecycle.dispatch("track-ended") !== undefined) {
        this.events.onState("error", "The microphone stopped (unplugged or blocked).")
      }
    })
    // continuation(identity): only while this stream is the microphone (the timer then checks its request ticket).
    track?.addEventListener("mute", () => {
      if (this.mic === stream) this.scheduleMutedCheck()
    })
    // continuation(identity): only while this stream is the microphone.
    track?.addEventListener("unmute", () => {
      if (this.mic !== stream) return
      // Live again: the recovery is over, and the next interruption gets its full number of reopens.
      clearTimeout(this.mutedTimer)
      this.mutedReopens = 0
      if (this.mutedNotified) {
        this.mutedNotified = false
        this.events.onMicMuted?.(undefined)
      }
    })
    // A replacement that opens muted (the interruption is still on) is checked like a track that mutes.
    if (track?.muted === true) this.scheduleMutedCheck()
  }

  private connectMic() {
    if (this.ctx === undefined || this.mic === undefined || this.capture === undefined) return
    this.micSource?.disconnect()
    this.micSource = this.ctx.createMediaStreamSource(this.mic)
    this.micSource.connect(this.capture)
  }

  private unlockElement() {
    if (this.element !== undefined) return
    const el: SinkElement = new Audio()
    el.autoplay = true
    el.addEventListener("pause", this.onElementPause) // continuation(identity): see `onElementPause`
    el.addEventListener("playing", this.onElementPlaying) // continuation(identity): see `onElementPlaying`
    this.playAttempt++
    void el.play().catch(() => undefined) // continuation(none): in the gesture: allowed to play later; ignores the outcome
    this.element = el
  }

  private routeOutput() {
    const ctx = this.ctx
    const analyser = this.analyser
    if (ctx === undefined || analyser === undefined) return
    analyser.disconnect()
    if (this.outputPath === "direct") {
      analyser.connect(ctx.destination)
      if (this.element !== undefined) this.element.srcObject = null
    } else {
      this.streamDest ??= ctx.createMediaStreamDestination()
      analyser.connect(this.streamDest)
      this.unlockElement()
      const el = this.element!
      el.srcObject = this.streamDest.stream
      const attempt = ++this.playAttempt
      // continuation(identity+route): a refusal acts only while `el` is still the session's element and this
      // is still the play attempt in force (no newer play, no change of output path since).
      void el.play().catch((e: unknown) => {
        if (this.element === el && this.playAttempt === attempt && (e as { name?: string } | null)?.name !== "AbortError") this.onElementPause()
      })
    }
  }

  private async applySink(sinkId: string) {
    this.sinkId = sinkId
    if (this.outputPath === "element") {
      await this.element?.setSinkId?.(sinkId) // continuation(none): nothing after it
    } else {
      await (this.ctx as SinkContext | undefined)?.setSinkId?.(sinkId) // continuation(none): nothing after it
    }
  }

  static canChooseSpeaker(): boolean {
    return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype
  }

  info(): AudioClientInfo {
    const ctx = this.ctx
    const settings = this.mic?.getAudioTracks()[0]?.getSettings()
    const info: { -readonly [K in keyof AudioClientInfo]: AudioClientInfo[K] } = {
      contextSampleRate: ctx?.sampleRate ?? 48_000,
      outputPath: this.outputPath
    }
    if (ctx !== undefined && Number.isFinite(ctx.baseLatency)) info.baseLatencyMs = Math.max(0, ctx.baseLatency * 1000)
    const out = this.outputLatencyMs()
    if (out !== undefined) info.outputLatencyMs = out
    if (typeof settings?.echoCancellation === "boolean") info.echoCancellation = settings.echoCancellation
    return info
  }

  /** `AudioContext.outputLatency` in ms, when the browser reports it. */
  outputLatencyMs(): number | undefined {
    const ctx = this.ctx
    if (ctx === undefined || !("outputLatency" in ctx) || !Number.isFinite(ctx.outputLatency)) return undefined
    return Math.max(0, ctx.outputLatency * 1000)
  }

  // ---- Microphone ----

  setMicLive(live: boolean) {
    this.capture?.port.postMessage({ type: "mute", value: !live })
    const track = this.mic?.getAudioTracks()[0]
    if (track !== undefined) track.enabled = live
    if (!live) levels.micRms = 0
  }

  /**
   * Use another microphone. During Start the choice is recorded and the start opens it (the
   * pending permission request is superseded, not the session). While running, the old microphone
   * is released first (iOS Safari captures from one microphone at a time: a second capture mutes
   * or ends the first, and gives the new track the old one's processing), then the new one is
   * opened; if that fails, the previous choice, then the default microphone, are opened again
   * (rejecting with `MicFallbackError`); if nothing opens, the session fails (`onState("error")`).
   * A request overtaken by End, a takeover or a newer change resolves without doing anything.
   */
  async setMicDevice(deviceId: string) {
    this.deviceId = deviceId
    this.mutedReopens = 0
    if (this.lifecycle.state === "starting") {
      this.lifecycle.dispatch("mic-change")
      await this.starting // continuation(none): only waits; the start loop opens the latest choice
      return
    }
    if (this.lifecycle.state !== "running" && this.lifecycle.state !== "replacing") return
    await this.replaceMic() // continuation(request): `replaceMic` checks its ticket; nothing after it
  }

  /** Re-open the microphone with other voice processing (echo cancellation, noise suppression, auto gain). */
  async setMicProcessing(processing: MicProcessing) {
    this.processing = processing
    await this.setMicDevice(this.deviceId) // continuation(none): nothing after it
  }

  private async replaceMic(): Promise<void> {
    const ticket = this.lifecycle.dispatch("mic-change")
    if (ticket === undefined) return
    const wanted: MicChoice = { deviceId: this.deviceId, processing: this.processing }
    const previous = this.micChoice ?? wanted
    const old = this.mic
    this.mic = undefined
    clearTimeout(this.mutedTimer)
    if (old !== undefined) stopStream(old)
    const candidates: Array<MicChoice> = [wanted]
    if (!sameChoice(previous, wanted)) candidates.push(previous)
    const fallbackDefault: MicChoice = { deviceId: "", processing: previous.processing }
    if (!candidates.some((c) => sameChoice(c, fallbackDefault))) candidates.push(fallbackDefault)
    let failure: unknown
    for (const choice of candidates) {
      let stream: MediaStream
      try {
        stream = await this.openMic(choice) // continuation(request): `isRequest(ticket)` on both outcomes
      } catch (e) {
        if (!this.lifecycle.isRequest(ticket)) return // overtaken: the newer request decides
        failure ??= e
        continue
      }
      if (!this.lifecycle.isRequest(ticket)) {
        stopStream(stream)
        return
      }
      this.useMic(stream, choice, ticket)
      this.connectMic()
      this.lifecycle.dispatch("mic-acquired")
      if (choice === wanted) return
      this.deviceId = choice.deviceId
      this.processing = choice.processing
      throw new MicFallbackError(failure, choice)
    }
    // Nothing opens: a session without a microphone must not pretend to be running.
    if (this.lifecycle.dispatch("mic-refused") !== undefined) this.events.onState("error", describeMicError(failure))
    throw failure
  }

  /**
   * Capture recovery: after an interruption (a call, Siri, another app recording) WebKit can leave
   * the track live but muted, delivering silence for good (WebKit bugs 208209, 213853). Called on a
   * track `mute`, when the context starts running again and when the page becomes visible: a track
   * still muted after `MUTED_REOPEN_MS` while the context runs is reopened, at most once per
   * `MUTED_REOPEN_EVERY_MS` (a check that falls inside that cooldown is rescheduled for its end, once),
   * and at most `MUTED_MAX_REOPENS` times until the microphone is heard live again; after that the owner
   * is told (`onMicMuted`) and nothing is reopened until it unmutes or the owner changes the microphone.
   * The single pending check is cancelled by an unmute, a replacement and stop. The microphone switch
   * (`setMicLive(false)`) disables the track, which does not mute it.
   */
  checkCapture() {
    const track = this.mic?.getAudioTracks()[0]
    if (track !== undefined && track.muted) this.scheduleMutedCheck()
  }

  private scheduleMutedCheck(delay = MUTED_REOPEN_MS) {
    clearTimeout(this.mutedTimer)
    const ticket = this.lifecycle.ticket()
    // continuation(request): acts only for the request it was scheduled in, while running.
    this.mutedTimer = setTimeout(() => {
      this.mutedTimer = undefined
      const track = this.mic?.getAudioTracks()[0]
      if (!this.lifecycle.isRequest(ticket) || this.lifecycle.state !== "running") return
      if (track === undefined || !track.muted || this.ctx?.state !== "running") return
      // Hidden: checked again when the page becomes visible (`checkCapture`).
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      if (this.mutedReopens >= MUTED_MAX_REOPENS) {
        if (!this.mutedNotified) {
          this.mutedNotified = true
          this.events.onMicMuted?.(MUTED_MESSAGE)
        }
        return
      }
      const now = performance.now()
      const wait = this.lastMutedReopen + MUTED_REOPEN_EVERY_MS - now
      if (wait > 0) {
        // Inside the cooldown: one check when it ends (otherwise nothing would ever look again).
        this.scheduleMutedCheck(wait)
        return
      }
      this.lastMutedReopen = now
      this.mutedReopens++
      void this.replaceMic().catch(() => undefined) // continuation(request): `replaceMic` checks its ticket
    }, delay)
  }

  /** The microphone as the browser reports it, for the "This device" diagnostics. */
  micReport(): MicReport | undefined {
    const track = this.mic?.getAudioTracks()[0]
    if (track === undefined || this.ctx === undefined) return undefined
    const settings = track.getSettings() as MediaTrackSettings & { sampleRate?: number; channelCount?: number }
    const report: { -readonly [K in keyof MicReport]: MicReport[K] } = {
      requested: this.processing,
      label: track.label,
      contextSampleRate: this.ctx.sampleRate
    }
    if (typeof settings.sampleRate === "number") report.sampleRate = settings.sampleRate
    if (typeof settings.channelCount === "number") report.channelCount = settings.channelCount
    if (typeof settings.echoCancellation === "boolean") report.echoCancellation = settings.echoCancellation
    if (typeof settings.noiseSuppression === "boolean") report.noiseSuppression = settings.noiseSuppression
    if (typeof settings.autoGainControl === "boolean") report.autoGainControl = settings.autoGainControl
    if (Number.isFinite(this.ctx.baseLatency)) report.baseLatencyMs = Math.max(0, this.ctx.baseLatency * 1000)
    const out = this.outputLatencyMs()
    if (out !== undefined) report.outputLatencyMs = out
    return report
  }

  async setSink(sinkId: string) {
    if (!this.running) {
      this.sinkId = sinkId
      return
    }
    await this.applySink(sinkId) // continuation(none): nothing after it
  }

  setOutputPath(path: OutputPath) {
    this.outputPath = path
    this.playAttempt++
    this.routeOutput()
    if (this.sinkId !== "") void this.applySink(this.sinkId).catch(() => undefined) // continuation(none): ignores the outcome
  }

  setPrebuffer(ms: number) {
    this.prebufferMs = ms
    this.link?.prebuffer(ms)
  }

  /**
   * Resume after a suspension. Called from a tap: everything that needs the tap's user activation is
   * called synchronously, before any await: the element's `play()`, and the context's `resume()` (for
   * WebKit's non-standard "interrupted" state, `suspend()` and then `resume()` back to back, the reported
   * workaround (WebKit bugs 273511, 276016): the context runs them in order, and `resume()` is called in
   * the tap instead of after `suspend()` settles, when the activation may be gone). They are not chained
   * with `play()`: with the media-element output the element's data comes from the context, so waiting for
   * `play()` before resuming could wait for itself. If the element still refuses to play, the context is
   * suspended again (rendering into a silent element would count audio nobody hears).
   */
  async resume() {
    const ctx = this.ctx
    if (ctx === undefined) return
    const el = this.element
    const attempt = this.outputPath === "element" && el !== undefined && el.paused ? ++this.playAttempt : undefined
    const playing = attempt !== undefined ? el!.play() : undefined
    const suspended = (ctx.state as string) === "interrupted" ? ctx.suspend().catch(() => undefined) : undefined // continuation(none): only settles
    const resumed = ctx.resume()
    if (playing !== undefined) {
      try {
        await playing // continuation(identity+route): `this.ctx === ctx` and the play attempt before acting
      } catch {
        await Promise.all([suspended, resumed.catch(() => undefined)]) // continuation(identity+route): checked next
        // Only while this element play is still the attempt in force on the element route: after a switch to
        // direct output (or a newer play) the refusal says nothing about what is audible now (fifth review, finding 3).
        if (this.ctx === ctx && this.element === el && this.outputPath === "element" && this.playAttempt === attempt) {
          await ctx.suspend().catch(() => undefined) // continuation(none): nothing after it
        }
        return
      }
    }
    await suspended // continuation(identity): `this.ctx === ctx` below
    await resumed // continuation(identity): `this.ctx === ctx` below
    if (this.ctx === ctx) this.checkCapture()
  }

  // ---- Reply playback (messages keep socket order: one port) ----

  replyStart(turnId: number, sampleRate: number) {
    this.link?.replyStart(turnId, sampleRate)
  }

  /** The reply the player is playing or buffering (the last one started, until it finished or stopped). */
  openReply(): number | undefined {
    return this.link?.openReply
  }

  /** A whole binary reply frame (header + PCM); the buffer is transferred, not copied. */
  replyFrame(buffer: ArrayBuffer) {
    this.link?.frame(buffer)
  }

  replyEnd(turnId: number) {
    this.link?.end(turnId)
  }

  /**
   * Stop the reply now (4 ms fade). `report: false` when the socket is gone. While the context is
   * not running (suspended, or WebKit's "interrupted") the fade would wait for rendering that is
   * not happening, and `playback.stopped` would miss the server's deadline: `now` makes the player
   * finish at once (nothing more can reach the device anyway). Whether a suspended context delivers the
   * message to the worklet is unverified on iOS: if the worklet has not answered within `STOP_ANSWER_MS`,
   * the page answers with its own count (at most one render quantum stale), and sends the worklet's exact
   * count later if it differs (see `playback.ts`).
   */
  replyStop(turnId: number | undefined, report: boolean) {
    const now = this.ctx !== undefined && this.ctx.state !== "running"
    this.link?.stop(turnId, report, now)
  }

  /**
   * The page is being unloaded (`pagehide`): answer for the reply now, with the best count, since nothing
   * can be waited for. The socket may or may not get the message out.
   */
  unload() {
    const now = this.ctx !== undefined && this.ctx.state !== "running"
    this.link?.unload(now)
  }

  /** Play local PCM through the normal player (the echo test). */
  playLocal(id: number, sampleRate: number, pcm: Int16Array) {
    this.replyStart(id, sampleRate)
    const chunk = sampleRate / 10
    for (let off = 0; off < pcm.length; off += chunk) {
      const part = pcm.subarray(off, Math.min(pcm.length, off + chunk))
      const buffer = new ArrayBuffer(8 + part.byteLength)
      new DataView(buffer).setUint32(4, id, true)
      new Int16Array(buffer, 8).set(part)
      this.replyFrame(buffer)
    }
    this.replyEnd(id)
  }

  /**
   * Close everything. `takeover`: another tab claimed the audio (same handling as End). Capture is
   * released at once. The reply's final count is obtained before the player and its context are closed:
   * a reply still open is stopped, and every pending stop is answered (the worklet keeps rendering
   * meanwhile, so a fade already started finishes and reports exactly), waiting at most `STOP_ANSWER_MS`;
   * then `afterFinal` runs (the client gives the audio back to the server there, after the count went out),
   * and the context closes. Everything of this session is detached from the object first, so a Start
   * pressed meanwhile builds a new session that this teardown never touches.
   */
  async stop(reason: "end" | "takeover" = "end", afterFinal?: () => void) {
    const ticket = this.lifecycle.dispatch(reason)
    clearTimeout(this.mutedTimer)
    this.mutedTimer = undefined
    this.mutedReopens = 0
    this.mutedNotified = false
    navigator.mediaDevices?.removeEventListener("devicechange", this.onDeviceChange)
    // Capture first, at once.
    if (this.mic !== undefined) stopStream(this.mic)
    this.micSource?.disconnect()
    if (this.capture !== undefined) this.capture.port.onmessage = null
    this.mic = undefined
    this.micChoice = undefined
    this.micRequest = -1
    levels.micRms = 0
    // Detach the session (a newer Start must not see any of it).
    const ctx = this.ctx
    const link = this.link
    const element = this.element
    const analyser = this.analyser
    this.ctx = undefined
    this.link = undefined
    this.element = undefined
    this.capture = undefined
    this.player = undefined
    this.analyser = undefined
    this.micSource = undefined
    this.streamDest = undefined
    try {
      // continuation(session): everything below acts on this stop's own detached resources; `afterFinal` is
      // the caller's, and the caller guards it (`client.ts` wraps it in its generation guard).
      if (link !== undefined && ctx !== undefined && ctx.state !== "closed") await link.finalise(ctx.state !== "running")
    } finally {
      afterFinal?.()
      link?.detach()
      if (levels.outAnalyser === analyser) levels.outAnalyser = null
      if (element !== undefined) element.srcObject = null
    }
    if (ctx !== undefined && ctx.state !== "closed") await ctx.close().catch(() => undefined) // continuation(session): the ticket check below
    // Only this stop's own close may finish it: a Start pressed meanwhile owns the lifecycle now.
    if (ticket !== undefined && this.lifecycle.state === "stopping" && this.lifecycle.ticket().session === ticket.session) {
      this.lifecycle.dispatch("stopped")
    }
  }
}

const stopStream = (stream: MediaStream) => stream.getTracks().forEach((t) => t.stop())
