/**
 * Baseline: the app's current visualiser (apps/web/src/lib/visualiser.ts), ported to the lab
 * contract. Three superimposed sine lines under a sin² envelope; colour, speed, amplitude and
 * the line weights follow the mode.
 *
 * Differences from the app, all because the contract has no such input:
 * - the app's extra states (disconnected, error, not-started, muted, asleep) are not lab modes;
 * - the fast collapse after an interruption is not modelled;
 * - the speaking weights use the contract's low/mid/high (0..1, log scale) raised to the 4th
 *   power as an energy proxy, where the app reads analyser energy directly.
 *
 * As a reference for design authors: keep everything the instance needs in the closure of
 * `create`, allocate in `resize` (not per frame), read only `frame`, smooth with `dt`.
 */
import type { Design, DesignInstance, Frame, Mode, Rgb } from "../contract.ts"
import { approach, clamp01, clear2d, mix, optNumber, optToggle, rgba, setup2d } from "../kit.ts"

type Triple = readonly [number, number, number]
type ColorKey = "inkFaint" | "voice" | "you"

interface ModeLook {
  readonly color: ColorKey
  readonly alpha: number
  /** Amplitude at level 0, CSS px. */
  readonly aMin: number
  /** Phase speed of each line, rad/s. */
  readonly omega: Triple
  /** Amplitude weight of each line, or follow the agent's spectrum. */
  readonly weights: Triple | "bands"
  readonly glow?: { readonly blur: number; readonly alpha: number }
  readonly breathe?: boolean
  readonly sweep?: boolean
}

/** Same numbers as STATE_PARAMS in the app. */
const LOOK: { readonly [M in Mode]: ModeLook } = {
  idle: { color: "inkFaint", alpha: 1, aMin: 1, omega: [0.3, 0.4, 0.5], weights: [1, 0.5, 0.3] },
  listening: { color: "you", alpha: 0.85, aMin: 2, omega: [0.6, 0.9, 1.3], weights: [1, 0.6, 0.35], breathe: true },
  hearing: { color: "you", alpha: 1, aMin: 3, omega: [2.4, 3.1, 4.2], weights: [1, 0.7, 0.5], glow: { blur: 8, alpha: 0.35 } },
  thinking: { color: "voice", alpha: 0.7, aMin: 4, omega: [1.2, 1.6, 2.1], weights: [1, 0.5, 0.3], sweep: true },
  speaking: { color: "voice", alpha: 1, aMin: 3, omega: [2.0, 2.8, 3.9], weights: "bands", glow: { blur: 12, alpha: 0.4 } }
}

const MAX_LINES = 5
type Five = readonly [number, number, number, number, number]
const K: Five = [1.5, 2.5, 4.0, 5.5, 7.0] // cycles across the width (lines 4 and 5 only appear when the "Lines" option asks for them)
const PHI: Five = [0, 2.1, 4.2, 1.0, 3.3]
const STROKE: Five = [2, 1.5, 1, 0.8, 0.7]
const OPACITY: Five = [1, 0.45, 0.25, 0.18, 0.12]
/** Which of low / mid / high drives each line's weight while speaking. */
const BAND_OF: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2] = [0, 1, 2, 1, 2]
/** Lines beyond the third are lighter and a little faster than the third. */
const outerWeight = (i: number): number => (i < 3 ? 1 : 0.7 ** (i - 2))
const outerOmega = (i: number): number => (i < 3 ? 1 : 1 + 0.25 * (i - 2))
/** Speaking weights: a = [0.5 + 0.5·low, 0.3 + 0.7·mid, 0.2 + 0.8·high] (shares of the energy). */
const BAND_BASE: Triple = [0.5, 0.3, 0.2]
const STEP = 2 // px between line samples

/** The level the lines move toward (0..1): the app's formulas, on the raw window RMS. */
const targetLevel = (f: Frame): number => {
  switch (f.mode) {
    case "speaking":
      return clamp01(Math.sqrt(f.agent.rms * 5))
    case "thinking":
      return 0.08
    case "hearing":
      return clamp01(Math.sqrt(f.user.rms * 9))
    case "listening":
      return clamp01(f.user.rms * 4)
    case "idle":
      return 0
  }
}

const create = (canvas: HTMLCanvasElement): DesignInstance => {
  let g = setup2d(canvas)
  let W = 1
  let H = 1
  let dpr = 1
  let ys: Array<Float32Array> = []

  // Animated state.
  let level = 0
  const theta = [0, 0, 0, 0, 0]
  const omega = [0, 0, 0, 0, 0]
  const weights = [1, 0.5, 0.3, 0.2, 0.15]
  // Option values the drawing glides toward (visible share of each line, density, thickness, glow).
  const vis = [1, 1, 1, 0, 0]
  let density = 1
  let thick = 1
  let glow = 1
  let started = false
  let rgb: Rgb = [128, 128, 120]
  let alpha = 1
  let fromRgb: Rgb = rgb
  let fromAlpha = alpha
  let fade = 1 // 0..1 progress of the 240 ms colour crossfade
  let shown: Mode | null = null

  return {
    resize(width, height, ratio) {
      W = width
      H = height
      dpr = ratio
      g = setup2d(canvas, dpr)
      const n = Math.floor(W / STEP) + 1
      ys = Array.from({ length: MAX_LINES }, () => new Float32Array(n))
    },

    frame(f) {
      const p = LOOK[f.mode]
      const reduced = f.reducedMotion
      const target = f.palette[p.color]
      const dt = f.dt

      // Options: glide to the chosen values (snap on the first frame and with reduced motion).
      const lines = Math.round(optNumber(f.options, "lines"))
      const quick = !started || reduced
      started = true
      const glide = (cur: number, goal: number, tau: number) => (quick ? goal : approach(cur, goal, dt, tau))
      for (let i = 0; i < MAX_LINES; i++) vis[i] = glide(vis[i]!, i < lines ? 1 : 0, 0.2)
      density = glide(density, optNumber(f.options, "density"), 0.25)
      thick = glide(thick, optNumber(f.options, "thickness"), 0.15)
      glow = glide(glow, optToggle(f.options, "glow") ? 1 : 0, 0.2)
      const speed = optNumber(f.options, "speed")

      // Colour: crossfade 240 ms on a mode change (instant with reduced motion).
      if (shown !== f.mode) {
        fromRgb = shown === null ? target : rgb
        fromAlpha = shown === null ? p.alpha : alpha
        fade = reduced || shown === null ? 1 : 0
        shown = f.mode
      }
      fade = Math.min(1, fade + dt / 0.24)
      const e = 1 - (1 - fade) * (1 - fade)
      rgb = mix(fromRgb, target, e)
      alpha = fromAlpha + (p.alpha - fromAlpha) * e

      // Level: fast rise (40 ms), slower fall (180 ms); reduced motion quantises to thirds.
      let goal = targetLevel(f)
      let tau: number
      if (reduced) {
        goal = Math.round(goal * 3) / 3
        tau = 0.15
      } else tau = goal > level ? 0.04 : 0.18
      level = approach(level, goal, dt, tau)

      // Speed and weights glide (240 ms), so a mode change never jumps.
      const a = f.agent
      const e0 = a.low ** 4
      const e1 = a.mid ** 4
      const e2 = a.high ** 4
      const total = e0 + e1 + e2
      const shares: Triple = total > 0 ? [e0 / total, e1 / total, e2 / total] : [1 / 3, 1 / 3, 1 / 3]
      for (let i = 0; i < MAX_LINES; i++) {
        const b = BAND_OF[i]!
        const base = p.weights === "bands" ? BAND_BASE[b]! + (1 - BAND_BASE[b]!) * shares[b]! : p.weights[Math.min(i, 2)]!
        const w = base * outerWeight(i)
        weights[i] = approach(weights[i]!, w, dt, p.weights === "bands" ? 0.12 : 0.24)
        omega[i] = approach(omega[i]!, reduced ? 0 : p.omega[Math.min(i, 2)]! * outerOmega(i) * speed, dt, 0.24)
        theta[i] = (theta[i]! + omega[i]! * dt) % (Math.PI * 2000)
      }

      // Geometry.
      clear2d(g, dpr)
      const y0 = H / 2
      const A = p.aMin + level * (0.38 * H - p.aMin)
      const n = ys[0]!.length
      for (let i = 0; i < MAX_LINES; i++) {
        if (vis[i]! < 0.01) continue
        const yi = ys[i]!
        const amp = A * weights[i]!
        const k = 2 * Math.PI * K[i]! * density
        const ph = PHI[i]! + theta[i]!
        for (let j = 0; j < n; j++) {
          const u = (j * STEP) / W
          const env = Math.sin(Math.PI * u)
          yi[j] = y0 + amp * env * env * Math.sin(k * u + ph)
        }
      }

      // Lines, back to front; the main line glows while hearing or speaking.
      let ga = alpha
      if (p.breathe && !reduced) ga *= 0.875 + 0.125 * Math.cos((2 * Math.PI * f.t) / 4)
      g.lineCap = "round"
      g.lineJoin = "round"
      for (let i = MAX_LINES - 1; i >= 0; i--) {
        if (vis[i]! < 0.01) continue
        const yi = ys[i]!
        g.lineWidth = STROKE[i]! * thick
        g.strokeStyle = rgba(rgb, ga * OPACITY[i]! * vis[i]!)
        if (i === 0 && p.glow && !reduced && glow > 0.01) {
          g.shadowBlur = p.glow.blur * glow
          g.shadowColor = rgba(rgb, p.glow.alpha * glow * Math.min(1, 0.4 + level * 1.5))
        } else g.shadowBlur = 0
        g.beginPath()
        g.moveTo(0, yi[0]!)
        for (let j = 1; j < n; j++) g.lineTo(j * STEP, yi[j]!)
        g.stroke()
      }
      g.shadowBlur = 0

      // Thinking: a highlight travels along the main line every 1.4 s.
      if (p.sweep && !reduced) {
        const sigma = 0.08 * W
        const c = -2 * sigma + ((f.t % 1.4) / 1.4) * (W + 4 * sigma)
        const grad = g.createLinearGradient(c - 2 * sigma, 0, c + 2 * sigma, 0)
        grad.addColorStop(0, rgba(rgb, 0))
        grad.addColorStop(0.5, rgba(rgb, 1))
        grad.addColorStop(1, rgba(rgb, 0))
        g.strokeStyle = grad
        g.lineWidth = 2.5 * thick
        g.shadowBlur = 10 * glow
        g.shadowColor = rgba(rgb, 0.55 * glow)
        const y = ys[0]!
        const j0 = Math.max(0, Math.floor((c - 2 * sigma) / STEP))
        const j1 = Math.min(n - 1, Math.ceil((c + 2 * sigma) / STEP))
        g.beginPath()
        for (let j = j0; j <= j1; j++) {
          if (j === j0) g.moveTo(j * STEP, y[j]!)
          else g.lineTo(j * STEP, y[j]!)
        }
        g.stroke()
        g.shadowBlur = 0
      }
    },

    dispose() {
      // Nothing to release for a 2D canvas; the harness drops the element.
    }
  }
}

const design: Design = {
  id: "sine-lines",
  name: "Sine lines",
  family: "baseline",
  summary: "The app's current look: three superimposed sine lines whose colour, speed and height follow the conversation.",
  inspiredBy: "Siri's classic multi-line waveform (iOS 7–13) and oscilloscope traces; kept deliberately quiet.",
  modes: {
    idle: "Grey, nearly flat, drifting very slowly.",
    listening: "Mint, low and slow, breathing in opacity on a 4 s cycle.",
    hearing: "Mint with a soft glow; height follows your voice, the lines move faster.",
    thinking: "Amber, low and dimmer; a highlight sweeps left to right every 1.4 s.",
    speaking: "Amber with a glow; height follows the reply, each line's weight follows a part of the spectrum."
  },
  mappings: [
    { signal: "user.rms (hearing)", effect: "Amplitude: √(rms·9) of 38 % of the height; 40 ms rise, 180 ms fall." },
    { signal: "user.rms (listening)", effect: "Amplitude: rms·4, so room noise barely moves it." },
    { signal: "agent.rms (speaking)", effect: "Amplitude: √(rms·5)." },
    { signal: "agent.low / mid / high (speaking)", effect: "Weight of the front, middle and back line (0.5+0.5·low, 0.3+0.7·mid, 0.2+0.8·high, as energy shares)." },
    { signal: "mode", effect: "Colour (grey / mint / amber, 240 ms crossfade), line speed and minimum height, glow, breathing, sweep." },
    { signal: "options", effect: "lines (1 to 5), thickness, density, speed and glow change the drawing in every mode; they glide over about 0.2 s, apart from reduced motion, which snaps." },
    { signal: "reducedMotion", effect: "Lines stop moving sideways; amplitude snaps to thirds; no breathing, sweep or glow; colour still shows the mode." }
  ],
  serverNeeds: "none",
  renderer: "2d",
  options: [
    { id: "lines", kind: "number", label: "Lines", min: 1, max: 5, step: 1, default: 3, group: "Shape", help: "How many sine lines are drawn. Extra lines are thinner and lighter." },
    { id: "thickness", kind: "number", label: "Line thickness", min: 0.5, max: 3, step: 0.1, default: 1, unit: "×", group: "Shape", help: "Scales every line's stroke width." },
    { id: "density", kind: "number", label: "Wave density", min: 0.5, max: 2, step: 0.1, default: 1, unit: "×", group: "Shape", help: "How many waves fit across the width: low is long and lazy, high is tight ripples." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.25, max: 2.5, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the lines travel sideways in every mode." },
    { id: "glow", kind: "toggle", label: "Glow", default: true, group: "Look", help: "The soft light around the main line while hearing or speaking, and on the thinking sweep." }
  ],
  create
}

export default design
