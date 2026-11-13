import type { MicProcessing, MicReport, ReplyStats } from "./diagnostics.ts"
import type { AudioClientInfo, OutputPath } from "./types.ts"
import { levels, pushMicFrame } from "./levels.ts"

/**
 * The page's audio: one `AudioContext` at the device's native rate, the
 * microphone capture graph (worklet → 16 kHz s16le frames) and the reply
 * player (worklet with a queue, a per-reply resampler and instant stop).
 *
 * Framework-free: React only calls `start()` (synchronously, from the Start
 * click) and the setters. Derived from docs/research/browser-audio.md, with the
 * changes listed in apps/web/README.md.
 */

export type PlayerEvent =
  | { readonly type: "started"; readonly id: number; readonly startDelayMs: number }
  | { readonly type: "progress"; readonly id: number; readonly playedSamples: number; readonly underruns: number }
  | { readonly type: "finished"; readonly id: number; readonly playedSamples: number }
  | { readonly type: "stopped"; readonly id: number; readonly playedSamples: number; readonly report: boolean }
  | { readonly type: "underrun"; readonly id: number; readonly underruns: number }
  | ({ readonly type: "stats" } & ReplyStats)

export interface VoiceAudioEvents {
  /** A 20 ms microphone frame: 8 empty header bytes + 320 samples of 16 kHz s16le, ready to send. */
  readonly onMicFrame: (buffer: ArrayBuffer) => void
  readonly onPlayer: (event: PlayerEvent) => void
  /** The context was suspended or resumed by the browser, or the microphone failed. */
  readonly onState: (state: "running" | "suspended" | "error", detail?: string) => void
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
      return "Microphone permission was denied. Allow it in the browser's site settings and press Start again."
    case "NotFoundError":
      return "No microphone found."
    case "NotReadableError":
      return "The microphone is in use by another app or blocked by the system."
    case "OverconstrainedError":
      return "The selected microphone is not available. Choose another one under Options → This device."
    case "SecurityError":
      return "The browser blocked the microphone on this page. It needs HTTPS or localhost."
    default:
      return `Could not start audio (${name ?? (e instanceof Error ? e.message : "unknown error")}).`
  }
}

const workletUrl = (name: string) => new URL(`worklets/${name}.js?v=2`, document.baseURI).toString()

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }
type SinkElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

export class VoiceAudio {
  private ctx: AudioContext | undefined
  private mic: MediaStream | undefined
  private micSource: MediaStreamAudioSourceNode | undefined
  private capture: AudioWorkletNode | undefined
  private player: AudioWorkletNode | undefined
  private analyser: AnalyserNode | undefined
  private streamDest: MediaStreamAudioDestinationNode | undefined
  private element: SinkElement | undefined
  private outputPath: OutputPath = "direct"
  private sinkId = ""
  private deviceId = ""
  private processing: MicProcessing = DEFAULT_PROCESSING
  private stopped = false
  private readonly onDeviceChange = () => {
    // The selected microphone was unplugged: fall back to the default one.
    if (this.mic?.getAudioTracks()[0]?.readyState === "ended") void this.setMicDevice("")
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
    return this.ctx !== undefined && !this.stopped
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
    this.stopped = false
    const ctx = new AudioContext({ latencyHint: "interactive" })
    this.ctx = ctx
    const resumed = ctx.resume()
    this.outputPath = options.outputPath
    this.sinkId = options.sinkId
    this.processing = options.processing ?? DEFAULT_PROCESSING
    if (options.outputPath === "element") this.unlockElement()
    return this.finishStart(ctx, resumed, options)
  }

  private async finishStart(ctx: AudioContext, resumed: Promise<void>, options: StartOptions): Promise<AudioClientInfo> {
    try {
      this.mic = await this.openMic(options.micDeviceId)
      await resumed
      await Promise.all([ctx.audioWorklet.addModule(workletUrl("capture")), ctx.audioWorklet.addModule(workletUrl("player"))])
      if (this.stopped) throw new DOMException("Audio was stopped while starting", "AbortError")

      // Capture: microphone → capture worklet → (silent) destination, so the graph is pulled.
      this.capture = new AudioWorkletNode(ctx, "pva-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { targetRate: 16_000 }
      })
      const silent = ctx.createGain()
      silent.gain.value = 0
      this.capture.connect(silent).connect(ctx.destination)
      this.capture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const buffer = e.data
        pushMicFrame(new Int16Array(buffer, 8))
        this.events.onMicFrame(buffer)
      }
      this.connectMic()

      // Playback: player worklet → analyser (visualiser tap, passes audio through) → output.
      this.player = new AudioWorkletNode(ctx, "pva-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })
      this.player.port.onmessage = (e: MessageEvent<PlayerEvent>) => this.events.onPlayer(e.data)
      this.player.port.postMessage({ type: "prebuffer", ms: options.prebufferMs })
      this.analyser = ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.smoothingTimeConstant = 0.5
      this.player.connect(this.analyser)
      this.routeOutput()
      levels.outAnalyser = this.analyser
      if (options.sinkId !== "") await this.applySink(options.sinkId).catch(() => undefined)

      ctx.onstatechange = () => {
        if (this.stopped) return
        this.events.onState(ctx.state === "running" ? "running" : "suspended")
      }
      navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange)
      return this.info()
    } catch (e) {
      await this.stop()
      throw e
    }
  }

  private async openMic(deviceId: string): Promise<MediaStream> {
    this.deviceId = deviceId
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId, this.processing), video: false })
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (!this.stopped && this.mic === stream) this.events.onState("error", "The microphone stopped (unplugged or blocked).")
    })
    return stream
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
    void el.play().catch(() => undefined) // in the gesture: allowed to play later
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
      this.element!.srcObject = this.streamDest.stream
      void this.element!.play().catch(() => undefined)
    }
  }

  private async applySink(sinkId: string) {
    this.sinkId = sinkId
    if (this.outputPath === "element") {
      await this.element?.setSinkId?.(sinkId)
    } else {
      await (this.ctx as SinkContext | undefined)?.setSinkId?.(sinkId)
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

  async setMicDevice(deviceId: string) {
    if (!this.running) return
    const old = this.mic
    // Released first: iOS gives the new track the old one's processing while both are open.
    old?.getTracks().forEach((t) => t.stop())
    this.mic = await this.openMic(deviceId)
    this.connectMic()
  }

  /** Re-open the microphone with other voice processing (echo cancellation, noise suppression, auto gain). */
  async setMicProcessing(processing: MicProcessing) {
    this.processing = processing
    if (!this.running) return
    await this.setMicDevice(this.deviceId)
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
    await this.applySink(sinkId)
  }

  setOutputPath(path: OutputPath) {
    this.outputPath = path
    this.routeOutput()
    if (this.sinkId !== "") void this.applySink(this.sinkId).catch(() => undefined)
  }

  setPrebuffer(ms: number) {
    this.player?.port.postMessage({ type: "prebuffer", ms })
  }

  async resume() {
    await this.ctx?.resume()
  }

  // ---- Reply playback (messages keep socket order: one port) ----

  replyStart(turnId: number, sampleRate: number) {
    this.player?.port.postMessage({ type: "start", id: turnId, rate: sampleRate })
  }

  /** A whole binary reply frame (header + PCM); the buffer is transferred, not copied. */
  replyFrame(buffer: ArrayBuffer) {
    this.player?.port.postMessage({ type: "frame", buffer }, [buffer])
  }

  replyEnd(turnId: number) {
    this.player?.port.postMessage({ type: "end", id: turnId })
  }

  /** Stop the reply now (4 ms fade). `report: false` when the socket is gone. */
  replyStop(turnId: number | undefined, report: boolean) {
    this.player?.port.postMessage(turnId === undefined ? { type: "stop", report } : { type: "stop", id: turnId, report })
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

  async stop() {
    this.stopped = true
    navigator.mediaDevices?.removeEventListener("devicechange", this.onDeviceChange)
    this.mic?.getTracks().forEach((t) => t.stop())
    this.mic = undefined
    if (levels.outAnalyser === this.analyser) levels.outAnalyser = null
    levels.micRms = 0
    if (this.element !== undefined) {
      this.element.srcObject = null
      this.element = undefined
    }
    const ctx = this.ctx
    this.ctx = undefined
    this.capture = undefined
    this.player = undefined
    this.analyser = undefined
    this.micSource = undefined
    this.streamDest = undefined
    if (ctx !== undefined && ctx.state !== "closed") await ctx.close().catch(() => undefined)
  }
}
