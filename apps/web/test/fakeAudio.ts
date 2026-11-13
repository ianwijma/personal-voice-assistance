/**
 * Just enough of Web Audio and `getUserMedia` (absent from jsdom) to drive `VoiceAudio` and the
 * client through their lifecycle in unit tests: every `getUserMedia` call returns a promise the
 * test settles, and every stream records whether its tracks were stopped.
 */
import { vi } from "vitest"

export class FakeTrack {
  readyState: "live" | "ended" = "live"
  enabled = true
  muted = false
  readonly label: string
  private readonly listeners = new Map<string, Array<() => void>>()
  constructor(label: string) {
    this.label = label
  }
  stop() {
    this.readyState = "ended"
  }
  getSettings() {
    return { echoCancellation: true, sampleRate: 48_000, channelCount: 1 }
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  /** The browser ends the track (device unplugged, permission revoked). */
  end() {
    this.readyState = "ended"
    for (const l of this.listeners.get("ended") ?? []) l()
  }
  /** The system mutes (or unmutes) the capture: an interruption such as a call. */
  setMuted(muted: boolean) {
    this.muted = muted
    for (const l of this.listeners.get(muted ? "mute" : "unmute") ?? []) l()
  }
}

export class FakeStream {
  readonly track: FakeTrack
  constructor(label: string) {
    this.track = new FakeTrack(label)
  }
  getTracks() {
    return [this.track]
  }
  getAudioTracks() {
    return [this.track]
  }
  get live() {
    return this.track.readyState === "live"
  }
}

export interface PendingMic {
  readonly constraints: MediaStreamConstraints
  readonly stream: FakeStream
  readonly resolve: () => void
  readonly reject: (e: unknown) => void
}

class FakeNode {
  readonly port = { postMessage: vi.fn(), onmessage: null as unknown }
  connect<T>(next: T): T {
    return next
  }
  disconnect() {}
}

/**
 * How the real player worklet is connected to the page in a test (`installFakeAudio({ realPlayer })`):
 * the node's port talks to a real `PlayerProcessor`, and the context renders it on `render()`.
 * Messages to the worklet are delivered at the next render (as they would be before the next quantum);
 * while the context is not running they are held back when `holdWhileSuspended` (whether a suspended
 * WebKit context delivers them is unverified), and delivered when rendering resumes.
 */
export interface RealPlayerOptions {
  /** The worklet class (imported by the test after `worklets/shim.ts`). */
  readonly Processor: new (options?: any) => any
  readonly holdWhileSuspended?: boolean
  /** Messages from the worklet wait (in order) until the test delivers them: a busy main thread. */
  readonly holdFromWorklet?: boolean
}

export interface PlayerBridge {
  readonly processor: any
  /** Messages for the worklet not delivered yet. */
  readonly toWorklet: Array<unknown>
  /** Every quantum rendered, in order (copies), with the reply id that was active while it rendered. */
  readonly rendered: Array<{ readonly id: number; readonly out: Float32Array; readonly afterGap: boolean }>
  /** Deliver held messages now (as if the browser delivered them). */
  deliver(): void
  /** Messages from the worklet not delivered to the page yet (`holdFromWorklet`). */
  readonly fromWorklet: Array<unknown>
  /** Deliver the first `n` held messages from the worklet (all by default). */
  deliverFromWorklet(n?: number): void
}

export const installFakeAudio = (setup: {
  readonly realPlayer?: RealPlayerOptions
  /** Constructing the player with a shared counter throws (a browser that refuses to clone it: `DataCloneError`). */
  readonly refuseSharedCounter?: boolean
} = {}) => {
  const pending: Array<PendingMic> = []
  const sources: Array<{ stream: FakeStream }> = []
  const contexts: Array<FakeContext> = []
  let count = 0

  const bridges: Array<PlayerBridge> = []
  /** Every player node constructed (in order), with the options it was given. */
  const players: Array<{ readonly node: any; readonly processorOptions: any }> = []
  /** Every capture node constructed (in order). */
  const captures: Array<any> = []
  /** When set, constructing a player node throws this (final review: a replacement that cannot be built). */
  let playerThrows: unknown = undefined

  class FakeContext {
    state: AudioContextState = "suspended"
    /** The real player of this context, when the test asked for one. */
    bridge: PlayerBridge | undefined
    /** Wall-clock milliseconds as the worklet sees them: advanced by rendering and by `idle`. */
    wallMs = 0
    private gap = false
    readonly sampleRate = 48_000
    readonly baseLatency = 0.005
    currentTime = 1.5
    readonly outputLatency = 0.02
    readonly destination = new FakeNode()
    readonly audioWorklet = { addModule: async () => undefined }
    onstatechange: (() => void) | null = null
    constructor() {
      contexts.push(this)
    }
    async resume() {
      this.setState("running")
    }
    async suspend() {
      this.setState("suspended")
    }
    /** The browser changes the state (screen lock, call: WebKit's non-standard "interrupted"). */
    setState(state: string) {
      if (this.state === state) return
      this.state = state as AudioContextState
      if (state !== "running") this.gap = true
      this.onstatechange?.()
    }
    async close() {
      this.state = "closed"
    }
    /** Render `quanta` quanta of 128 frames (nothing when the context is not running). */
    render(quanta: number) {
      const b = this.bridge
      if (b === undefined) return
      for (let q = 0; q < quanta; q++) {
        if (this.state !== "running") {
          this.gap = true
          return
        }
        b.deliver()
        const out = new Float32Array(128)
        const id = b.processor.id as number
        b.processor.process([], [[out]])
        b.rendered.push({ id, out, afterGap: this.gap })
        this.gap = false
        this.currentTime += 128 / this.sampleRate
        this.wallMs += (128 / this.sampleRate) * 1000
        ;(globalThis as any).currentTime = this.currentTime
      }
    }
    /** Time passes without rendering (the device is silent). */
    idle(ms: number) {
      this.wallMs += ms
    }
    createGain() {
      return Object.assign(new FakeNode(), { gain: { value: 1 } })
    }
    createAnalyser() {
      return Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0 })
    }
    createMediaStreamSource(stream: FakeStream) {
      const source = Object.assign(new FakeNode(), { stream })
      sources.push(source)
      return source
    }
    createMediaStreamDestination() {
      return Object.assign(new FakeNode(), { stream: new FakeStream("output") })
    }
  }

  const g = globalThis as any
  g.AudioContext = FakeContext
  // jsdom has no media playback: `play()` resolves (or rejects, per test) and updates `paused`.
  const elements: Array<HTMLMediaElement> = []
  let playResult: () => Promise<void> = async () => undefined
  HTMLMediaElement.prototype.play = function(this: HTMLMediaElement) {
    if (!elements.includes(this)) elements.push(this)
    return playResult().then(() => {
      Object.defineProperty(this, "paused", { configurable: true, value: false })
      this.dispatchEvent(new Event("playing"))
    })
  }
  HTMLMediaElement.prototype.pause = function(this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true })
    this.dispatchEvent(new Event("pause"))
  }
  class FakeWorkletNode extends FakeNode {
    onprocessorerror: (() => void) | null = null
    constructor(ctx: FakeContext, name: string, options?: { processorOptions?: unknown }) {
      super()
      if (name === "pva-capture") captures.push(this)
      if (name === "pva-player") {
        if (playerThrows !== undefined) throw playerThrows
        if (setup.refuseSharedCounter === true && (options?.processorOptions as { counter?: unknown } | undefined)?.counter !== undefined) {
          throw new DOMException("SharedArrayBuffer transfer is not allowed", "DataCloneError")
        }
        players.push({ node: this, processorOptions: options?.processorOptions })
      }
      const real = setup.realPlayer
      if (name !== "pva-player" || real === undefined) return
      ;(globalThis as any).sampleRate = ctx.sampleRate
      const processor = new real.Processor({ processorOptions: options?.processorOptions ?? {} })
      // The worklet's own clock: the context's (the test controls time through it).
      processor.now = () => ctx.wallMs
      ;(globalThis as any).currentTime = ctx.currentTime
      const toWorklet: Array<unknown> = []
      const fromWorklet: Array<unknown> = []
      const toPage = (message: unknown) => {
        const onmessage = this.port.onmessage as ((e: { data: unknown }) => void) | null
        onmessage?.({ data: message })
      }
      const bridge: PlayerBridge = {
        processor,
        toWorklet,
        rendered: [],
        deliver: () => {
          while (toWorklet.length > 0) processor.port.deliver(toWorklet.shift())
        },
        fromWorklet,
        deliverFromWorklet: (n = Infinity) => {
          for (let i = 0; i < n && fromWorklet.length > 0; i++) toPage(fromWorklet.shift())
        }
      }
      this.port.postMessage.mockImplementation((message: unknown) => {
        toWorklet.push(message)
        if (ctx.state !== "running" && real.holdWhileSuspended !== true) bridge.deliver()
      })
      processor.port.postMessage = (message: unknown) => {
        if (real.holdFromWorklet === true) fromWorklet.push(message)
        else toPage(message)
      }
      // What the processor posted while it was constructed (its `ready`) reaches the page once the page
      // listens (a port queues messages until then).
      const early = (processor.port.sent as Array<unknown> | undefined)?.splice(0) ?? []
      queueMicrotask(() => {
        for (const m of early) processor.port.postMessage(m)
      })
      ctx.bridge = bridge
      bridges.push(bridge)
    }
  }
  g.AudioWorkletNode = FakeWorkletNode
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: (constraints: MediaStreamConstraints) =>
        new Promise((resolve, reject) => {
          const stream = new FakeStream(`mic ${++count}`)
          // A refused request hands out no stream: its track counts as never live.
          pending.push({ constraints, stream, resolve: () => resolve(stream), reject: (e) => (stream.track.stop(), reject(e)) })
        }),
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
  })
  return {
    pending,
    contexts,
    bridges,
    players,
    captures,
    setPlayerThrows: (e: unknown) => {
      playerThrows = e
    },
    elements,
    setPlayResult: (f: () => Promise<void>) => {
      playResult = f
    },
    /** The stream most recently connected to the capture graph. */
    connected: () => sources.at(-1)?.stream,
    /** Every stream handed out whose track is still live. */
    liveStreams: () => pending.filter((p) => p.stream.live).map((p) => p.stream)
  }
}

/** Let promise continuations run. */
export const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/**
 * The instance token the page gave reply `id` in its latest `start` to a player node (seventh review, finding 3:
 * every message from the worklet about a reply carries it, so a test that speaks for the worklet must too).
 */
export const tokenFor = (node: { readonly port: { readonly postMessage: unknown } }, id: number): number => {
  const calls = (node.port.postMessage as { mock: { calls: Array<Array<any>> } }).mock.calls
  const start = calls.map(([m]) => m).filter((m) => m?.type === "start" && m.id === id).at(-1)
  if (typeof start?.token !== "number") throw new Error(`no start with a token for reply ${id}`)
  return start.token
}
