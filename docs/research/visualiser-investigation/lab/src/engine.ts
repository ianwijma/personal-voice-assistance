/**
 * The engine: one requestAnimationFrame loop for every live design instance on the page.
 *
 * - A `Stage` is one instance of one design in one host element, fed by one `Conversation`.
 * - Only stages on screen run (IntersectionObserver); the loop stops while the tab is hidden.
 * - At most `WEBGL_LIMIT` webgl2 instances exist at once: an off-screen one is disposed and its
 *   canvas dropped; a visible one waits for a free slot (higher `priority` first).
 * - Any exception from create/resize/frame is caught: that stage shows the message, the rest run.
 * - `frame()` cost is measured per stage: mean of the last 120 calls and worst of the last 300,
 *   skipping the first 10 calls after creation (shader compiles, JIT).
 */
import { BAND_COUNT, type Design, type DesignInstance, type Frame, type Palette, type Pointer, type VoiceFeatures } from "./contract.ts"
import type { Conversation } from "./driver.ts"
import { recolour, scaleFeatures, type ResolvedOptions } from "./options.ts"

export const WEBGL_LIMIT = 6
const MEAN_N = 120
const WORST_N = 300
const WARMUP = 10

export interface EngineEnv {
  palette(): Palette
  reducedMotion(): boolean
  /** The viewer's validated options for a design; the same object until a value changes. */
  options(design: Design): ResolvedOptions
}

export class Stage {
  readonly design: Design
  readonly host: HTMLElement
  conversation: Conversation
  readonly priority: number
  error: string | null = null
  /** Called after each drawn frame (cheap work only). */
  onFrame: ((stage: Stage) => void) | null = null

  private canvas: HTMLCanvasElement | null = null
  private instance: DesignInstance | null = null
  private readonly overlay: HTMLElement
  visible = false
  private w = 0
  private h = 0
  private dpr = 1
  private sized = false
  private age = 0
  private calls = 0
  private readonly costs = new Float32Array(WORST_N)
  private costHead = 0
  private costCount = 0
  private readonly pointer: Pointer = { x: 0, y: 0, down: false, inside: false }
  private readonly frameObj: Frame
  /** Per-instance copies of the voices for the sensitivity setting (the shared features stay raw). */
  private readonly userView: VoiceFeatures
  private readonly agentView: VoiceFeatures
  private readonly userBands = new Float32Array(BAND_COUNT)
  private readonly agentBands = new Float32Array(BAND_COUNT)
  private seenVersion = -1
  private basePalette: Palette
  private palette: Palette
  private readonly ro: ResizeObserver
  private readonly listeners: Array<[string, (e: PointerEvent) => void]> = []
  private readonly engine: Engine

  constructor(engine: Engine, host: HTMLElement, design: Design, conversation: Conversation, priority = 0) {
    this.engine = engine
    this.host = host
    this.design = design
    this.conversation = conversation
    this.priority = priority
    host.classList.add("stage-host")
    this.overlay = document.createElement("div")
    this.overlay.className = "stage-overlay"
    this.overlay.hidden = true
    host.append(this.overlay)
    const c = conversation
    this.userView = { ...c.user }
    this.agentView = { ...c.agent }
    this.basePalette = engine.env.palette()
    this.palette = this.basePalette
    this.frameObj = {
      t: 0,
      dt: 0,
      mode: c.mode,
      prevMode: c.prevMode,
      modeAge: c.modeAge,
      user: c.user,
      agent: c.agent,
      active: c.user,
      pointer: this.pointer,
      reducedMotion: false,
      palette: this.palette,
      options: engine.env.options(design).values
    }
    this.ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect()
      const w = Math.max(1, Math.round(r.width))
      const h = Math.max(1, Math.round(r.height))
      if (w !== this.w || h !== this.h) {
        this.w = w
        this.h = h
        this.sized = false
      }
    })
    this.ro.observe(host)
    const on = (type: string, fn: (e: PointerEvent) => void) => {
      host.addEventListener(type, fn as EventListener)
      this.listeners.push([type, fn])
    }
    const at = (e: PointerEvent) => {
      const r = host.getBoundingClientRect()
      this.pointer.x = e.clientX - r.left
      this.pointer.y = e.clientY - r.top
    }
    on("pointermove", (e) => {
      at(e)
      this.pointer.inside = true
    })
    on("pointerenter", (e) => {
      at(e)
      this.pointer.inside = true
    })
    on("pointerleave", () => {
      this.pointer.inside = false
      this.pointer.down = false
    })
    on("pointerdown", (e) => {
      at(e)
      this.pointer.down = true
    })
    on("pointerup", () => {
      this.pointer.down = false
    })
    on("pointercancel", () => {
      this.pointer.down = false
    })
  }

  get isWebgl(): boolean {
    return this.design.renderer === "webgl2"
  }
  get live(): boolean {
    return this.instance !== null
  }

  /** Mean and worst `frame()` cost in ms, or null before enough samples. */
  cost(): { mean: number; worst: number } | null {
    if (this.costCount === 0) return null
    let worst = 0
    let sum = 0
    const n = Math.min(this.costCount, WORST_N)
    const m = Math.min(this.costCount, MEAN_N)
    for (let i = 0; i < n; i++) {
      const v = this.costs[(this.costHead - 1 - i + WORST_N) % WORST_N]!
      if (v > worst) worst = v
      if (i < m) sum += v
    }
    return { mean: sum / m, worst }
  }

  /** Create the instance (fresh canvas). */
  create(): void {
    if (this.instance !== null || this.error !== null) return
    const canvas = document.createElement("canvas")
    canvas.className = "stage-canvas"
    this.host.prepend(canvas)
    this.canvas = canvas
    this.sized = false
    this.age = 0
    this.calls = 0
    this.costCount = 0
    this.costHead = 0
    this.setOverlay(null)
    try {
      this.instance = this.design.create(canvas)
    } catch (e) {
      this.fail(e)
    }
  }

  /** Dispose the instance and drop its canvas. */
  release(): void {
    const inst = this.instance
    this.instance = null
    if (inst !== null) {
      try {
        inst.dispose()
      } catch {
        // a failing dispose must not stop the page
      }
    }
    this.canvas?.remove()
    this.canvas = null
  }

  waitForSlot(): void {
    this.setOverlay(`Paused: at most ${WEBGL_LIMIT} WebGL instances run at once`, "wait")
  }

  private setOverlay(text: string | null, kind: "error" | "wait" = "error"): void {
    this.overlay.hidden = text === null
    this.overlay.textContent = text ?? ""
    this.overlay.dataset.kind = kind
  }

  private fail(e: unknown): void {
    this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.warn(`[lab] design "${this.design.id}" failed:`, e)
    this.release()
    this.setOverlay(this.error, "error")
    this.host.classList.add("stage-failed")
  }

  /** Draw one frame. `now` is ms; the conversation has already been stepped. */
  draw(dt: number): void {
    const inst = this.instance
    const canvas = this.canvas
    if (inst === null || canvas === null) return
    try {
      if (!this.sized && this.w > 0) {
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        this.dpr = dpr
        canvas.width = Math.max(1, Math.round(this.w * dpr))
        canvas.height = Math.max(1, Math.round(this.h * dpr))
        inst.resize(this.w, this.h, dpr)
        this.sized = true
      }
      if (!this.sized) return
      this.age += dt
      const c = this.conversation
      const f = this.frameObj
      f.t = this.age
      f.dt = dt
      f.mode = c.mode
      f.prevMode = c.prevMode
      f.modeAge = c.modeAge
      const env = this.engine.env
      const o = env.options(this.design)
      const base = env.palette()
      if (o.version !== this.seenVersion || base !== this.basePalette) {
        this.seenVersion = o.version
        this.basePalette = base
        this.palette = recolour(base, o.you, o.voice)
      }
      if (o.sensitivity === 1) {
        f.user = c.user
        f.agent = c.agent
      } else {
        scaleFeatures(c.user, this.userView, this.userBands, o.sensitivity)
        scaleFeatures(c.agent, this.agentView, this.agentBands, o.sensitivity)
        f.user = this.userView
        f.agent = this.agentView
      }
      f.active = c.mode === "speaking" ? f.agent : f.user
      f.reducedMotion = env.reducedMotion()
      f.palette = this.palette
      f.options = o.values
      const t0 = performance.now()
      inst.frame(f)
      const cost = performance.now() - t0
      if (++this.calls > WARMUP) {
        this.costs[this.costHead] = cost
        this.costHead = (this.costHead + 1) % WORST_N
        this.costCount++
      }
    } catch (e) {
      this.fail(e)
      return
    }
    this.onFrame?.(this)
  }

  destroy(): void {
    this.release()
    this.ro.disconnect()
    for (const [type, fn] of this.listeners) this.host.removeEventListener(type, fn as EventListener)
    this.overlay.remove()
  }
}

export class Engine {
  readonly env: EngineEnv
  private readonly stages = new Set<Stage>()
  private readonly io: IntersectionObserver
  private readonly byHost = new WeakMap<Element, Stage>()
  private raf = 0
  private last = 0
  private frameNo = 0
  /** Called once per frame after all stages drew. */
  onTick: (() => void) | null = null

  constructor(env: EngineEnv) {
    this.env = env
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const s = this.byHost.get(e.target)
          if (s === undefined) continue
          s.visible = e.isIntersecting
          if (!s.visible && s.isWebgl) s.release()
        }
        this.allocate()
      },
      { rootMargin: "120px 0px" }
    )
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.stop()
      else this.start()
    })
  }

  add(host: HTMLElement, design: Design, conversation: Conversation, priority = 0): Stage {
    const s = new Stage(this, host, design, conversation, priority)
    this.stages.add(s)
    this.byHost.set(host, s)
    this.io.observe(host)
    return s
  }

  remove(stage: Stage): void {
    this.io.unobserve(stage.host)
    this.stages.delete(stage)
    stage.destroy()
    this.allocate()
  }

  clear(): void {
    for (const s of [...this.stages]) this.remove(s)
  }

  /** Create visible instances; webgl ones only while under the limit. */
  private allocate(): void {
    let gl = 0
    for (const s of this.stages) if (s.isWebgl && s.live) gl++
    const waiting = [...this.stages].filter((s) => s.visible && !s.live && s.error === null).sort((a, b) => b.priority - a.priority)
    for (const s of waiting) {
      if (s.isWebgl) {
        if (gl >= WEBGL_LIMIT) {
          s.waitForSlot()
          continue
        }
        gl++
      }
      s.create()
    }
  }

  start(): void {
    if (this.raf !== 0 || document.hidden) return
    this.last = performance.now()
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick)
      const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000))
      this.last = now
      this.frameNo++
      for (const s of this.stages) {
        if (!s.visible || !s.live) continue
        const c = s.conversation
        if (c.stepped !== this.frameNo) {
          c.stepped = this.frameNo
          c.step(dt)
        }
        s.draw(dt)
      }
      // A conversation advances only while at least one of its stages is drawn.
      this.onTick?.()
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  /** The current frame number (conversations stepped this frame carry it). */
  get frame(): number {
    return this.frameNo
  }
}
