/**
 * The character host: owns the stage's canvas, the animation loop, both voices' features and the viewer's choice,
 * and runs one character at a time (docs/CHARACTERS.md §1, §4). It replaces the old `startVisualiser`.
 *
 * - The baseline (sine lines) is bundled and drawn from the first frame. A chosen character is loaded on demand as
 *   its own chunk; whatever is on stage stays until it is ready, then the swap happens inside one animation task
 *   (dispose, create, size, first frame), so there is no blank frame. A new choice swaps live.
 * - Each frame: the application's visual state is resolved for the character (`runner.ts`), the person's and the
 *   assistant's features come from the microphone ring buffer and the player's analyser (`voices.ts`), or from
 *   stand-ins in a tab that does not own the audio.
 * - Isolation (§4.6): a character that fails to load, has an invalid manifest, is written for a contract or
 *   renderer this host does not serve, throws in `create`, `resize` or `frame`, or persistently exceeds the frame
 *   budget, is disposed and replaced by the baseline for the rest of the page's life, with one console warning.
 *   An unknown id falls back to the baseline too; the stored choice is never touched (the host only reads it).
 *   "Persistently": the mean `frame()` cost over a window of 120 measured frames (each frame counted at most
 *   16 ms, so one long pause cannot do it) is above `budgetMs` (4 ms, twice the 2 ms budget) in 3 consecutive
 *   windows, about 6 s at 60 Hz. The first 30 frames after a character starts, after a resize and after the tab
 *   comes back from the background are not measured. The baseline is never stopped: there is nothing behind it.
 * - One requestAnimationFrame loop, paused while the tab is hidden. The canvas follows its CSS box and the device
 *   pixel ratio. A canvas cannot change context type, so a "webgl2" character gets a fresh canvas of its own next
 *   to the page's (which "2d" characters share); its WebGL context is released and the canvas removed on dispose.
 *
 * Nothing here runs in or waits on the audio worklets: the host only reads what the audio code already left in
 * `levels` (a ring of microphone samples, the analyser), on the main thread, once per frame.
 */
import { levels, readMicWindow } from "../lib/audio/levels.ts"
import { BASELINE_ID } from "./choice.ts"
import { type Character, type CharacterChoice, type Mode, type OptionValues, type Palette, type Pointer, type Rgb } from "./contract.ts"
import { manifestProblems } from "./manifest.ts"
import { registry as defaultRegistry, type Registry } from "./registry.ts"
import { coreOf, Runner } from "./runner.ts"
import { agentOn, LiveVoice, standInAgent, standInUser, userOn } from "./voices.ts"

/** The stage's live input, a plain object the page mutates in place (no React per frame). */
export interface HostInput {
  /** The application's visual state (`visualState` in `lib/state.ts` is exactly a `Mode`). */
  state: Mode
  /** This tab owns the audio (features come from the real microphone and player). */
  owner: boolean
}

/** Where the host reads audio from; `levels.ts` by default, a fake in tests. */
export interface AudioTaps {
  /** Fill `out` with the latest microphone samples; false when there are none (muted, stalled, no audio). */
  readonly readMic: (out: Float32Array, now: number) => boolean
  readonly micRate: () => number
  /** The player's output tap, or null when no audio runs. */
  readonly analyser: () => AnalyserNode | null
  /** `performance.now()` of the last interruption, `-Infinity` if none. */
  readonly interruptedAt: () => number
}

const levelTaps: AudioTaps = {
  readMic: readMicWindow,
  micRate: () => levels.micRate,
  analyser: () => levels.outAnalyser,
  interruptedAt: () => levels.interruptedAt
}

export interface HostOptions {
  readonly registry?: Registry
  readonly taps?: AudioTaps
  /** Mean frame cost (ms) above which a measuring window counts against a character. */
  readonly budgetMs?: number
  /** Consecutive over-budget windows before a character is stopped. */
  readonly budgetWindows?: number
  /** Frames per measuring window. */
  readonly windowFrames?: number
  readonly warn?: (message: string, error?: unknown) => void
}

export const FRAME_BUDGET_MS = 2
const DEFAULT_LIMIT_MS = 2 * FRAME_BUDGET_MS
const DEFAULT_WINDOWS = 3
const DEFAULT_WINDOW_FRAMES = 120
const WARMUP_FRAMES = 30
/** A single frame counts at most this much towards the budget (one frame at 60 Hz). */
const COST_CAP_MS = 16
const DEBUG_N = 120

export type FallbackReason = "unknown" | "load" | "invalid" | "create" | "resize" | "frame" | "budget"

export interface HostDebug {
  /** The id the choice asks for. */
  readonly requested: string
  /** The character on stage now. */
  readonly id: string
  readonly renderer: "2d" | "webgl2" | null
  /** An id being loaded, or null. */
  readonly loading: string | null
  /** Why the requested character is not on stage, or null. */
  readonly fallback: { readonly id: string; readonly reason: FallbackReason; readonly message: string } | null
  /** Ids stopped for this page's life. */
  readonly failed: ReadonlyArray<string>
  /** Frames the current character has drawn. */
  readonly frames: number
  /** Mean `frame()` cost of the current character, ms, over its last 120 measured frames (null before any). */
  readonly frameMs: number | null
  /** Mean cost of producing both voices' features per frame, ms, over the last 120 frames. */
  readonly featuresMs: number | null
  /** The current character's validated options (`frame.options`) and the validated host-level settings. */
  readonly options: OptionValues
  readonly hostOptions: OptionValues
}

export interface CharacterHost {
  /** Apply a (changed) choice: options at once, another character when it has loaded. */
  readonly setChoice: (choice: CharacterChoice | undefined) => void
  /** Resolves when no load is pending (the requested character is on stage, or the host fell back). */
  readonly ready: () => Promise<void>
  readonly debug: () => HostDebug
  readonly stop: () => void
}

const FALLBACK_PALETTE: Palette = {
  dark: true,
  bg: [21, 22, 19],
  surface: [30, 31, 28],
  line: [60, 61, 57],
  ink: [235, 232, 222],
  inkFaint: [150, 148, 140],
  you: [120, 220, 200],
  voice: [230, 180, 90],
  danger: [230, 90, 70]
}

const TOKENS = { bg: "bg", surface: "surface", line: "line", ink: "ink", inkFaint: "ink-faint", you: "you", voice: "voice", danger: "danger" } as const

/** The theme's colour tokens as RGB, by painting each into one pixel (any CSS colour syntax, e.g. oklch). */
const readPalette = (probe: CanvasRenderingContext2D | null, dark: boolean): Palette => {
  if (probe === null) return { ...FALLBACK_PALETTE, dark }
  const cs = getComputedStyle(document.documentElement)
  const out: { -readonly [K in keyof Palette]: Palette[K] } = { ...FALLBACK_PALETTE, dark }
  for (const [key, token] of Object.entries(TOKENS) as Array<[keyof typeof TOKENS, string]>) {
    const v = cs.getPropertyValue(`--color-${token}`).trim()
    if (v === "") continue
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = "#000"
    probe.fillStyle = v
    probe.fillRect(0, 0, 1, 1)
    const d = probe.getImageData(0, 0, 1, 1).data
    out[key] = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as Rgb
  }
  return out
}

const describe = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/** Host-level settings only (`$you`, `$voice`, `$sensitivity`): what a fallback baseline keeps from another character's choice. */
const hostLevel = (o: OptionValues | undefined): OptionValues | undefined => {
  if (o === undefined) return undefined
  const out: { [id: string]: number | boolean | string } = {}
  for (const [k, v] of Object.entries(o)) if (k.startsWith("$")) out[k] = v
  return out
}

interface Active {
  readonly id: string
  readonly runner: Runner
  readonly canvas: HTMLCanvasElement
  frames: number
}

class PhaseError extends Error {
  readonly phase: "create" | "resize" | "frame"
  readonly inner: unknown
  constructor(phase: "create" | "resize" | "frame", inner: unknown) {
    super(describe(inner))
    this.phase = phase
    this.inner = inner
  }
}

/** A ring of the last `n` costs, for the debug readout. */
class Costs {
  private readonly v: Float32Array
  private head = 0
  private count = 0
  constructor(n: number) {
    this.v = new Float32Array(n)
  }
  push(x: number): void {
    this.v[this.head] = x
    this.head = (this.head + 1) % this.v.length
    if (this.count < this.v.length) this.count++
  }
  reset(): void {
    this.count = 0
    this.head = 0
  }
  mean(): number | null {
    if (this.count === 0) return null
    let s = 0
    for (let i = 0; i < this.count; i++) s += this.v[i]!
    return s / this.count
  }
}

export const startCharacterHost = (primary: HTMLCanvasElement, input: HostInput, initial: CharacterChoice | undefined, options: HostOptions = {}): CharacterHost => {
  const reg = options.registry ?? defaultRegistry
  const taps = options.taps ?? levelTaps
  const limitMs = options.budgetMs ?? DEFAULT_LIMIT_MS
  const limitWindows = options.budgetWindows ?? DEFAULT_WINDOWS
  const windowFrames = options.windowFrames ?? DEFAULT_WINDOW_FRAMES
  const warn = options.warn ?? ((m: string, e?: unknown) => console.warn(m, ...(e === undefined ? [] : [e])))

  // Theme, motion and pointer.
  const probeCanvas = document.createElement("canvas")
  probeCanvas.width = probeCanvas.height = 1
  const probe = probeCanvas.getContext("2d", { willReadFrequently: true })
  const schemeQuery = matchMedia("(prefers-color-scheme: light)")
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)")
  let palette = readPalette(probe, !schemeQuery.matches)
  let reduced = motionQuery.matches
  const onScheme = () => {
    palette = readPalette(probe, !schemeQuery.matches)
  }
  const onMotion = () => {
    reduced = motionQuery.matches
  }
  schemeQuery.addEventListener("change", onScheme)
  motionQuery.addEventListener("change", onMotion)
  const pointer: Pointer = { x: 0, y: 0, down: false, inside: false }
  const target: HTMLElement = primary.parentElement ?? primary
  const at = (e: PointerEvent) => {
    const r = primary.getBoundingClientRect()
    pointer.x = e.clientX - r.left
    pointer.y = e.clientY - r.top
  }
  const listeners: Array<[string, (e: PointerEvent) => void]> = [
    ["pointermove", (e) => { at(e); pointer.inside = true }],
    ["pointerenter", (e) => { at(e); pointer.inside = true }],
    ["pointerleave", () => { pointer.inside = false; pointer.down = false }],
    ["pointerdown", (e) => { at(e); pointer.down = true }],
    ["pointerup", () => { pointer.down = false }],
    ["pointercancel", () => { pointer.down = false }]
  ]
  for (const [type, fn] of listeners) target.addEventListener(type, fn as EventListener)

  // Size.
  let W = 1
  let H = 1
  let dpr = 1
  const measure = (): boolean => {
    const r = primary.getBoundingClientRect()
    const w = Math.max(1, r.width)
    const h = Math.max(1, r.height)
    const d = Math.min(3, window.devicePixelRatio || 1)
    if (w === W && h === H && d === dpr) return false
    W = w
    H = h
    dpr = d
    return true
  }
  measure()
  let resized = false
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { resized = true })
  ro?.observe(primary)

  // Voices.
  const userLive = new LiveVoice()
  const agentLive = new LiveVoice()
  const userStand = standInUser()
  const agentStand = standInAgent()
  let outBuf = new Float32Array(2048)
  let clock = 0

  // Characters.
  let choice = initial
  let requested = initial?.character ?? BASELINE_ID
  let active: Active | null = null
  let loading: string | null = null
  let loadToken = 0
  let stopped = false
  let fallback: HostDebug["fallback"] = null
  const failed = new Map<string, FallbackReason>()
  const loaded = new Map<string, Character>()
  const waiters: Array<() => void> = []
  const settle = () => {
    for (const w of waiters.splice(0)) w()
  }

  // Cost.
  const frameCosts = new Costs(DEBUG_N)
  const featureCosts = new Costs(DEBUG_N)
  let warm = WARMUP_FRAMES
  let windowSum = 0
  let windowCount = 0
  let strikes = 0
  const resetBudget = () => {
    warm = WARMUP_FRAMES
    windowSum = 0
    windowCount = 0
  }

  const storedFor = (id: string): OptionValues | undefined => (choice !== undefined && choice.character === id ? choice.options : hostLevel(choice?.options))

  const release = (a: Active, next: HTMLCanvasElement | null) => {
    a.runner.dispose()
    if (a.canvas !== primary) {
      if (a.runner.character.renderer === "webgl2") {
        try {
          a.canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext()
        } catch {
          // already lost
        }
      }
      a.canvas.remove()
    } else if (next !== primary) {
      primary.width = primary.width // clears it
    }
  }

  const sibling = (): HTMLCanvasElement => {
    const c = document.createElement("canvas")
    c.className = primary.className
    c.setAttribute("aria-hidden", "true")
    primary.after(c)
    return c
  }

  const sinceInterrupt = (now: number): number => {
    const at = taps.interruptedAt()
    return Number.isFinite(at) ? Math.max(0, (now - at) / 1000) : Infinity
  }

  /** Both voices for this frame, from audio (owner) or stand-ins (observer). */
  const voices = (now: number, dt: number) => {
    const core = coreOf(input.state)
    if (input.owner) {
      let hasUser = false
      if (userOn(core)) hasUser = taps.readMic(userLive.window(taps.micRate()), now)
      const user = userLive.step(dt, hasUser)
      let hasAgent = false
      const a = agentOn(core) ? taps.analyser() : null
      if (a !== null) {
        if (outBuf.length !== a.fftSize) outBuf = new Float32Array(a.fftSize)
        a.getFloatTimeDomainData(outBuf)
        const w = agentLive.window(a.context.sampleRate)
        const n = Math.min(w.length, outBuf.length)
        if (n < w.length) w.fill(0, 0, w.length - n)
        for (let i = 0; i < n; i++) w[w.length - n + i] = outBuf[outBuf.length - n + i]!
        hasAgent = true
      }
      const agent = agentLive.step(dt, hasAgent)
      return { user, agent }
    }
    const user = userStand.step(core === "hearing" ? "voice" : core === "listening" ? "room" : "silent", clock, dt)
    const agent = agentStand.step(core === "speaking" ? "voice" : "silent", clock, dt)
    return { user, agent }
  }

  const draw = (runner: Runner, now: number, dt: number, user: ReturnType<typeof voices>["user"], agent: ReturnType<typeof voices>["agent"]) =>
    runner.step({ mode: input.state, dt, user, agent, palette, reducedMotion: reduced, pointer, sinceInterrupt: sinceInterrupt(now) })

  let lastVoices = voices(performance.now(), 1 / 60)

  /** Put `character` on stage, inside this task. Throws a PhaseError; on failure nothing of it remains. */
  const mount = (character: Character, id: string) => {
    const canvas = character.renderer === "2d" ? primary : sibling()
    const old = active
    if (old !== null && old.canvas === canvas) {
      release(old, canvas)
      active = null
    }
    const runner = new Runner(character, canvas, storedFor(id))
    let phase: "create" | "resize" | "frame" = "create"
    try {
      runner.create()
      phase = "resize"
      runner.resize(W, H, dpr)
      phase = "frame"
      draw(runner, performance.now(), 1 / 60, lastVoices.user, lastVoices.agent)
    } catch (e) {
      runner.dispose()
      if (canvas !== primary) canvas.remove()
      throw new PhaseError(phase, e)
    }
    if (active !== null) release(active, canvas)
    primary.style.visibility = canvas === primary ? "" : "hidden"
    active = { id, runner, canvas, frames: 1 }
    frameCosts.reset()
    strikes = 0
    resetBudget()
  }

  const mountBaseline = () => {
    try {
      mount(reg.baseline, BASELINE_ID)
    } catch (e) {
      // Nothing to fall back to: leave the stage empty for this page.
      warn(`[characters] the baseline failed, the stage stays empty: ${describe(e instanceof PhaseError ? e.inner : e)}`)
      if (active !== null) release(active, null)
      active = null
    }
  }

  const fail = (id: string, reason: FallbackReason, error: unknown) => {
    const message = error instanceof PhaseError ? error.message : typeof error === "string" ? error : describe(error)
    if (id === BASELINE_ID) {
      warn(`[characters] the baseline failed (${reason}), the stage stays empty: ${message}`)
      if (active !== null) release(active, null)
      active = null
      return
    }
    if (!failed.has(id)) warn(`[characters] "${id}" ${reason === "budget" ? "kept exceeding the frame budget" : `failed (${reason})`}; showing the baseline for the rest of this page: ${message}`, error instanceof PhaseError ? error.inner : undefined)
    failed.set(id, reason)
    fallback = { id, reason, message }
    ensureBaseline()
  }

  const show = (character: Character, id: string) => {
    try {
      mount(character, id)
      fallback = null
    } catch (e) {
      fail(id, e instanceof PhaseError ? e.phase : "create", e)
    }
  }

  const ensureBaseline = () => {
    if (active?.id !== BASELINE_ID) mountBaseline()
    else active.runner.setStored(storedFor(BASELINE_ID))
  }

  const setChoice = (next: CharacterChoice | undefined) => {
    if (stopped) return
    choice = next
    const id = next?.character ?? BASELINE_ID
    requested = id
    if (active !== null && active.id === id) {
      loadToken++
      loading = null
      active.runner.setStored(storedFor(id))
      fallback = null
      settle()
      return
    }
    if (id === BASELINE_ID) {
      loadToken++
      loading = null
      fallback = null
      ensureBaseline()
      settle()
      return
    }
    const gone = failed.get(id)
    if (gone !== undefined) {
      loadToken++
      loading = null
      fallback = { id, reason: gone, message: "stopped earlier on this page" }
      ensureBaseline()
      settle()
      return
    }
    const cached = loaded.get(id)
    if (cached !== undefined) {
      loadToken++
      loading = null
      show(cached, id)
      settle()
      return
    }
    const pending = reg.load(id)
    if (pending === undefined) {
      loadToken++
      loading = null
      if (fallback?.id !== id) warn(`[characters] no character "${id}" in this build; showing the baseline (the stored choice is kept)`)
      fallback = { id, reason: "unknown", message: `no character "${id}" in this build` }
      ensureBaseline()
      settle()
      return
    }
    // Whatever is on stage stays until the new character is ready; it follows the new host-level settings meanwhile.
    active?.runner.setStored(storedFor(active.id))
    const token = ++loadToken
    loading = id
    pending.then(
      (mod) => {
        if (token !== loadToken || stopped) return
        loading = null
        const problems = manifestProblems(mod, id)
        if (problems.length > 0) fail(id, "invalid", problems.join("; "))
        else {
          const c = mod as Character
          loaded.set(id, c)
          show(c, id)
        }
        settle()
      },
      (e: unknown) => {
        if (token !== loadToken || stopped) return
        loading = null
        fail(id, "load", e)
        settle()
      }
    )
  }

  // The loop.
  let raf = 0
  let last = performance.now()
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick)
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    clock += dt
    const a = active
    const t0 = performance.now()
    lastVoices = voices(now, dt)
    featureCosts.push(performance.now() - t0)
    if (a === null) return
    if (resized) {
      resized = false
      if (measure()) {
        try {
          a.runner.resize(W, H, dpr)
        } catch (e) {
          fail(a.id, "resize", new PhaseError("resize", e))
          return
        }
        resetBudget()
      }
    } else if (Math.min(3, window.devicePixelRatio || 1) !== dpr) resized = true
    const t1 = performance.now()
    try {
      draw(a.runner, now, dt, lastVoices.user, lastVoices.agent)
    } catch (e) {
      fail(a.id, "frame", new PhaseError("frame", e))
      return
    }
    const cost = performance.now() - t1
    a.frames++
    if (warm > 0) {
      warm--
      return
    }
    frameCosts.push(cost)
    if (a.id === BASELINE_ID) return
    windowSum += Math.min(cost, COST_CAP_MS)
    if (++windowCount < windowFrames) return
    const mean = windowSum / windowCount
    windowSum = 0
    windowCount = 0
    strikes = mean > limitMs ? strikes + 1 : 0
    if (strikes >= limitWindows) fail(a.id, "budget", `mean frame cost ${mean.toFixed(2)} ms over ${windowFrames} frames, ${limitWindows} windows in a row (limit ${limitMs} ms)`)
  }
  const start = () => {
    if (raf !== 0 || stopped || document.hidden) return
    last = performance.now()
    resetBudget()
    strikes = 0
    raf = requestAnimationFrame(tick)
  }
  const pause = () => {
    cancelAnimationFrame(raf)
    raf = 0
  }
  const onVisibility = () => (document.hidden ? pause() : start())
  document.addEventListener("visibilitychange", onVisibility)

  mountBaseline()
  setChoice(initial)
  start()

  return {
    setChoice,
    ready: () => (loading === null ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
    debug: () => ({
      requested,
      id: active?.id ?? "",
      renderer: active?.runner.character.renderer ?? null,
      loading,
      fallback,
      failed: [...failed.keys()],
      frames: active?.frames ?? 0,
      frameMs: frameCosts.mean(),
      featuresMs: featureCosts.mean(),
      options: active?.runner.options.values ?? {},
      hostOptions: active?.runner.options.common ?? {}
    }),
    stop: () => {
      if (stopped) return
      stopped = true
      loadToken++
      pause()
      document.removeEventListener("visibilitychange", onVisibility)
      schemeQuery.removeEventListener("change", onScheme)
      motionQuery.removeEventListener("change", onMotion)
      for (const [type, fn] of listeners) target.removeEventListener(type, fn as EventListener)
      ro?.disconnect()
      if (active !== null) release(active, null)
      active = null
      primary.style.visibility = ""
      settle()
    }
  }
}
