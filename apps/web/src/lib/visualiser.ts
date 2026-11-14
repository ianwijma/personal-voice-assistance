import { currentMicRms, levels } from "./audio/levels.ts"
import type { VisualState } from "./state.ts"

/**
 * The visualiser: three superimposed sine lines on a canvas, drawn on
 * `requestAnimationFrame` from a plain mutable input (no React per frame).
 * Shape, states and timings: docs/UI-AND-MODULES.md §3.3.
 */

export interface VisualInput {
  state: VisualState
  /** This tab owns the audio (levels come from the real microphone and player). */
  owner: boolean
}

type ColorKey = "ink-faint" | "voice" | "you" | "danger"
type Triple = readonly [number, number, number]

interface StateParams {
  readonly color: ColorKey
  readonly alpha: number
  readonly aMin: number
  readonly omega: Triple
  readonly weights: Triple | "bands"
  readonly dashed?: boolean
  readonly glow?: { readonly blur: number; readonly alpha: number }
  readonly breathe?: boolean
  readonly sweep?: boolean
  readonly gap?: boolean
}

export const STATE_PARAMS: { readonly [S in VisualState]: StateParams } = {
  disconnected: { color: "ink-faint", alpha: 0.5, aMin: 0, omega: [0, 0, 0], weights: [1, 0.5, 0.3], dashed: true },
  error: { color: "danger", alpha: 1, aMin: 0, omega: [0, 0, 0], weights: [1, 0.5, 0.3] },
  "not-started": { color: "ink-faint", alpha: 0.4, aMin: 0, omega: [0, 0, 0], weights: [1, 0.5, 0.3] },
  speaking: { color: "voice", alpha: 1, aMin: 3, omega: [2.0, 2.8, 3.9], weights: "bands", glow: { blur: 12, alpha: 0.4 } },
  thinking: { color: "voice", alpha: 0.7, aMin: 4, omega: [1.2, 1.6, 2.1], weights: [1, 0.5, 0.3], sweep: true },
  muted: { color: "ink-faint", alpha: 1, aMin: 0, omega: [0, 0, 0], weights: [1, 0.5, 0.3], gap: true },
  hearing: { color: "you", alpha: 1, aMin: 3, omega: [2.4, 3.1, 4.2], weights: [1, 0.7, 0.5], glow: { blur: 8, alpha: 0.35 } },
  listening: { color: "you", alpha: 0.85, aMin: 2, omega: [0.6, 0.9, 1.3], weights: [1, 0.6, 0.35], breathe: true },
  // Wake-phrase mode, waiting for the phrase: your colour, faint and slow, breathing.
  asleep: { color: "you", alpha: 0.42, aMin: 1.5, omega: [0.25, 0.35, 0.45], weights: [1, 0.5, 0.3], breathe: true },
  idle: { color: "ink-faint", alpha: 1, aMin: 1, omega: [0.3, 0.4, 0.5], weights: [1, 0.5, 0.3] }
}

const K: Triple = [1.5, 2.5, 4.0]
const PHI: Triple = [0, 2.1, 4.2]
const STROKE: Triple = [2, 1.5, 1]
const OPACITY: Triple = [1, 0.45, 0.25]
/** Speaking weights: a = [0.5 + 0.5·low, 0.3 + 0.7·mid, 0.2 + 0.8·high]. */
const BAND_BASE: Triple = [0.5, 0.3, 0.2]

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Smooth pseudo-noise in about [-1, 1], for the observer's stand-in levels. */
const noise = (t: number) => 0.5 * Math.sin(1.7 * t) + 0.3 * Math.sin(2.9 * t + 1.3) + 0.2 * Math.sin(5.3 * t + 0.4)

/** The level the line moves toward in a state (0..1). */
export const targetLevel = (input: VisualInput, t: number, outRms: number, micRms: number): number => {
  switch (input.state) {
    case "speaking":
      return input.owner ? clamp01(Math.sqrt(outRms * 5)) : 0.35 + 0.15 * noise(t)
    case "thinking":
      return 0.08
    case "hearing":
      return input.owner ? clamp01(Math.sqrt(micRms * 9)) : 0.3 + 0.15 * noise(t * 1.3)
    case "listening":
      return input.owner ? clamp01(micRms * 4) : 0.03
    default:
      return 0
  }
}

/** Resolve a CSS colour (any syntax, e.g. oklch) to RGB by painting one pixel. */
const resolveColor = (probe: CanvasRenderingContext2D, css: string): [number, number, number] => {
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = "#000"
  probe.fillStyle = css
  probe.fillRect(0, 0, 1, 1)
  const d = probe.getImageData(0, 0, 1, 1).data
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0]
}

export interface VisualiserHandle {
  readonly stop: () => void
}

export const startVisualiser = (canvas: HTMLCanvasElement, input: VisualInput): VisualiserHandle => {
  const g = canvas.getContext("2d", { alpha: true })
  if (g === null) return { stop: () => undefined }
  const probeCanvas = document.createElement("canvas")
  probeCanvas.width = probeCanvas.height = 1
  const probe = probeCanvas.getContext("2d", { willReadFrequently: true })!

  const colors: Record<ColorKey, [number, number, number]> = { "ink-faint": [128, 128, 120], voice: [230, 180, 90], you: [120, 220, 200], danger: [230, 90, 70] }
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement)
    for (const key of Object.keys(colors) as Array<ColorKey>) {
      const v = cs.getPropertyValue(`--color-${key}`).trim()
      if (v !== "") colors[key] = resolveColor(probe, v)
    }
  }
  readColors()
  const schemeQuery = matchMedia("(prefers-color-scheme: light)")
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)")
  let reduced = motionQuery.matches
  const onScheme = () => readColors()
  const onMotion = () => {
    reduced = motionQuery.matches
  }
  schemeQuery.addEventListener("change", onScheme)
  motionQuery.addEventListener("change", onMotion)

  // Canvas size follows its CSS box, at the device pixel ratio.
  let W = 0
  let H = 0
  let dpr = 1
  const resize = () => {
    dpr = Math.min(3, window.devicePixelRatio || 1)
    const rect = canvas.getBoundingClientRect()
    W = Math.max(1, rect.width)
    H = Math.max(1, rect.height)
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  // Animated values.
  let level = 0
  const theta = [0, 0, 0]
  const omega = [0, 0, 0]
  const weights = [1, 0.5, 0.3]
  const bands = [1 / 3, 1 / 3, 1 / 3]
  let rgb: [number, number, number] = [...colors["ink-faint"]]
  let alpha = STATE_PARAMS[input.state].alpha
  let fromRgb = rgb
  let fromAlpha = alpha
  let toKey: ColorKey = STATE_PARAMS[input.state].color
  let toAlpha = alpha
  let fadeStart = -1
  let shownState = input.state

  // Preallocated buffers.
  const timeBuf = new Float32Array(1024)
  const freqBuf = new Uint8Array(512)
  let ys = [new Float32Array(0), new Float32Array(0), new Float32Array(0)]

  const readOutput = (): number => {
    const a = levels.outAnalyser
    if (a === null) return 0
    a.getFloatTimeDomainData(timeBuf)
    let sum = 0
    for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i]! * timeBuf[i]!
    a.getByteFrequencyData(freqBuf)
    const hz = a.context.sampleRate / a.fftSize
    let low = 0
    let mid = 0
    let high = 0
    for (let i = 1; i < freqBuf.length; i++) {
      const f = i * hz
      const e = freqBuf[i]! * freqBuf[i]!
      if (f >= 80 && f < 300) low += e
      else if (f >= 300 && f < 1500) mid += e
      else if (f >= 1500 && f < 4000) high += e
    }
    const total = low + mid + high
    if (total > 0) {
      bands[0] = low / total
      bands[1] = mid / total
      bands[2] = high / total
    }
    return Math.sqrt(sum / timeBuf.length)
  }

  let last = performance.now()
  let raf = 0
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame)
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000))
    last = now
    const t = now / 1000
    const state = input.state
    const p = STATE_PARAMS[state]

    // Colour crossfade (240 ms) when the state's colour changes.
    if (p.color !== toKey || p.alpha !== toAlpha || state !== shownState) {
      fromRgb = rgb
      fromAlpha = alpha
      toKey = p.color
      toAlpha = p.alpha
      fadeStart = reduced ? -1 : now
      shownState = state
    }
    const target = colors[toKey]
    if (fadeStart < 0) {
      rgb = [...target]
      alpha = toAlpha
    } else {
      const m = clamp01((now - fadeStart) / 240)
      const e = 1 - (1 - m) * (1 - m)
      rgb = [fromRgb[0] + (target[0] - fromRgb[0]) * e, fromRgb[1] + (target[1] - fromRgb[1]) * e, fromRgb[2] + (target[2] - fromRgb[2]) * e]
      alpha = fromAlpha + (toAlpha - fromAlpha) * e
      if (m >= 1) fadeStart = -1
    }

    // Level: fast rise, slower fall; faster collapse just after an interruption.
    const outRms = state === "speaking" && input.owner ? readOutput() : 0
    let goal = targetLevel(input, t, outRms, currentMicRms(now))
    let tau: number
    if (reduced) {
      goal = Math.round(goal * 3) / 3
      tau = 0.15
    } else if (goal > level) {
      tau = 0.04
    } else {
      tau = now - levels.interruptedAt < 600 ? 0.06 : 0.18
    }
    level += (goal - level) * (1 - Math.exp(-dt / tau))

    // Speed and weights glide (no jumps between states).
    const glide = 1 - Math.exp(-dt / 0.24)
    for (let i = 0; i < 3; i++) {
      const w = p.weights === "bands" ? BAND_BASE[i]! + (1 - BAND_BASE[i]!) * bands[i]! : p.weights[i]!
      weights[i]! += (w - weights[i]!) * (p.weights === "bands" ? 1 - Math.exp(-dt / 0.12) : glide)
      omega[i]! += ((reduced ? 0 : p.omega[i]!) - omega[i]!) * glide
      theta[i] = (theta[i]! + omega[i]! * dt) % (Math.PI * 2000)
    }

    draw(t, p)
  }

  const draw = (t: number, p: StateParams) => {
    const w = canvas.width
    const h = canvas.height
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, w, h)
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    const y0 = H / 2
    const aMin = p.aMin
    const A = aMin + level * (0.38 * H - aMin)
    const step = 2
    const n = Math.floor(W / step) + 1
    if (ys[0]!.length !== n) ys = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
    for (let i = 0; i < 3; i++) {
      const yi = ys[i]!
      const amp = A * weights[i]!
      const k = 2 * Math.PI * K[i]!
      const ph = PHI[i]! + theta[i]!
      for (let j = 0; j < n; j++) {
        const u = (j * step) / W
        const e = Math.sin(Math.PI * u)
        yi[j] = y0 + amp * e * e * Math.sin(k * u + ph)
      }
    }
    let globalAlpha = alpha
    if (p.breathe && !reduced) globalAlpha *= 0.875 + 0.125 * Math.cos((2 * Math.PI * t) / 4)
    const [r, gg, b] = rgb
    const color = (a: number) => `rgba(${r | 0},${gg | 0},${b | 0},${a})`
    g.lineCap = "round"
    g.lineJoin = "round"
    g.setLineDash(p.dashed ? [4, 6] : [])
    const gapHalf = p.gap ? 24 : 0
    for (let i = 2; i >= 0; i--) {
      const yi = ys[i]!
      g.lineWidth = STROKE[i]!
      g.strokeStyle = color(globalAlpha * OPACITY[i]!)
      if (i === 0 && p.glow && !reduced) {
        g.shadowBlur = p.glow.blur
        g.shadowColor = color(p.glow.alpha * Math.min(1, 0.4 + level * 1.5))
      } else {
        g.shadowBlur = 0
      }
      g.beginPath()
      let pen = false
      for (let j = 0; j < n; j++) {
        const x = j * step
        if (gapHalf > 0 && Math.abs(x - W / 2) < gapHalf) {
          pen = false
          continue
        }
        if (pen) g.lineTo(x, yi[j]!)
        else {
          g.moveTo(x, yi[j]!)
          pen = true
        }
      }
      g.stroke()
    }
    g.shadowBlur = 0
    if (p.sweep && !reduced) {
      // A highlight travels left to right every 1.4 s.
      const sigma = 0.08 * W
      const c = -2 * sigma + (((t % 1.4) / 1.4) * (W + 4 * sigma))
      const grad = g.createLinearGradient(c - 2 * sigma, 0, c + 2 * sigma, 0)
      grad.addColorStop(0, color(0))
      grad.addColorStop(0.5, color(1))
      grad.addColorStop(1, color(0))
      g.strokeStyle = grad
      g.lineWidth = 2.5
      g.shadowBlur = 10
      g.shadowColor = color(0.55)
      const y = ys[0]!
      g.beginPath()
      const j0 = Math.max(0, Math.floor((c - 2 * sigma) / step))
      const j1 = Math.min(n - 1, Math.ceil((c + 2 * sigma) / step))
      for (let j = j0; j <= j1; j++) {
        if (j === j0) g.moveTo(j * step, y[j]!)
        else g.lineTo(j * step, y[j]!)
      }
      g.stroke()
      g.shadowBlur = 0
    }
  }

  raf = requestAnimationFrame(frame)
  return {
    stop: () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      schemeQuery.removeEventListener("change", onScheme)
      motionQuery.removeEventListener("change", onMotion)
    }
  }
}
