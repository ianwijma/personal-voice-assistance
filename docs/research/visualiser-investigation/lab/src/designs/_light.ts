/**
 * Shared helpers for the "light" designs (aurora-ribbons, edge-glow, cloud-orb, dot-quartet,
 * light-ring, twin-lights). Not a design: the registry ignores files starting with "_".
 *
 * - `ModeMix`: one smoothly crossfading weight per mode, so every parameter can be a weighted
 *   sum and a mode change is a continuous morph of one object, never a cut.
 * - Colour: hue rotation that keeps a colour's lightness (extra hues that stay in harmony with
 *   the palette in both themes), and a few theme-aware mixes.
 * - `GlowSprite`: a pre-rendered soft disc per colour, redrawn only when its colour changes, so
 *   drawing many glows costs one `drawImage` each and allocates nothing per frame.
 * - `Glide`, `ChoiceMix`: ease the viewer's option values (`frame.options`) instead of jumping.
 */
import type { Frame, Mode, Rgb } from "../contract.ts"
import { approach, clamp01 } from "../kit.ts"

/** A mutable colour (0..255 RGB) for reuse between frames; assignable wherever an `Rgb` is read. */
export type Col = [number, number, number]

/**
 * Syllable-onset threshold (rising edge of `onset`). Normal speech peaks near 1, but a whisper's
 * onsets only reach about 0.4, so the threshold sits low enough to catch those too.
 */
export const ONSET = 0.3

export const MODE_INDEX: { readonly [M in Mode]: number } = { idle: 0, listening: 1, hearing: 2, thinking: 3, speaking: 4 }

/** Weights for the five modes that sum to 1 and glide on a mode change. */
export class ModeMix {
  readonly w = new Float32Array([1, 0, 0, 0, 0])
  private started = false
  /** `tau`: seconds for 63 % of a crossfade. Reduced motion uses a short fade, not a cut. */
  step(f: Frame, tau: number): this {
    const target = MODE_INDEX[f.mode]
    if (!this.started) {
      this.started = true
      this.w.fill(0)
      this.w[target] = 1
      return this
    }
    const k = f.reducedMotion ? Math.min(tau, 0.12) : tau
    let sum = 0
    for (let i = 0; i < 5; i++) {
      this.w[i] = approach(this.w[i]!, i === target ? 1 : 0, f.dt, k)
      sum += this.w[i]!
    }
    if (sum > 0) for (let i = 0; i < 5; i++) this.w[i] = this.w[i]! / sum
    return this
  }
  get idle(): number {
    return this.w[0]!
  }
  get listening(): number {
    return this.w[1]!
  }
  get hearing(): number {
    return this.w[2]!
  }
  get thinking(): number {
    return this.w[3]!
  }
  get speaking(): number {
    return this.w[4]!
  }
  /** Weighted sum of one value per mode (idle, listening, hearing, thinking, speaking). */
  of(idle: number, listening: number, hearing: number, thinking: number, speaking: number): number {
    const w = this.w
    return w[0]! * idle + w[1]! * listening + w[2]! * hearing + w[3]! * thinking + w[4]! * speaking
  }
}

// ---------------------------------------------------------------------------------------------
// Colour

/** Rotate the hue of `c` by `deg` degrees, keeping HSL lightness and saturation. Writes into `out`. */
export const hueShift = (c: Rgb, deg: number, out: Col = [0, 0, 0]): Col => {
  const r = c[0] / 255
  const g = c[1] / 255
  const b = c[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d > 1e-6) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  h = (((h + deg) % 360) + 360) % 360
  const C = (1 - Math.abs(2 * l - 1)) * s
  const X = C * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - C / 2
  let rr = 0
  let gg = 0
  let bb = 0
  if (h < 60) [rr, gg, bb] = [C, X, 0]
  else if (h < 120) [rr, gg, bb] = [X, C, 0]
  else if (h < 180) [rr, gg, bb] = [0, C, X]
  else if (h < 240) [rr, gg, bb] = [0, X, C]
  else if (h < 300) [rr, gg, bb] = [X, 0, C]
  else [rr, gg, bb] = [C, 0, X]
  out[0] = (rr + m) * 255
  out[1] = (gg + m) * 255
  out[2] = (bb + m) * 255
  return out
}

/** Mix into a mutable target (no allocation). */
export const mixInto = (out: Col, a: Rgb, b: Rgb, t: number): Col => {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

/** Weighted mix of up to three colours into `out`; weights need not sum to 1. */
export const mix3Into = (out: Col, a: Rgb, wa: number, b: Rgb, wb: number, c: Rgb, wc: number): Col => {
  const s = wa + wb + wc || 1
  out[0] = (a[0] * wa + b[0] * wb + c[0] * wc) / s
  out[1] = (a[1] * wa + b[1] * wb + c[1] * wc) / s
  out[2] = (a[2] * wa + b[2] * wb + c[2] * wc) / s
  return out
}

/** `rgba(...)` string from a mutable colour (canvas still needs a string). */
export const css = (c: Rgb, a: number): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp01(a).toFixed(3)})`


// ---------------------------------------------------------------------------------------------
// Sprites

/**
 * A soft radial glow of one colour, pre-rendered at `size` px (device pixels). `core` (0..1) is how
 * much of the radius is a solid centre before the falloff. Draw it with `draw(g, x, y, r, alpha)`.
 */
export class GlowSprite {
  readonly canvas: OffscreenCanvas
  private readonly g: OffscreenCanvasRenderingContext2D
  private readonly key = new Float64Array([-1, -1, -1, -1, -1])
  constructor(size = 128) {
    this.canvas = new OffscreenCanvas(size, size)
    const g = this.canvas.getContext("2d")
    if (g === null) throw new Error("2D canvas unavailable")
    this.g = g
  }
  /** Re-render only when the colour or shape changed. */
  paint(c: Rgb, core = 0.15, falloff = 2): void {
    const k = this.key
    const r = c[0] | 0
    const gg = c[1] | 0
    const b = c[2] | 0
    if (k[0] === r && k[1] === gg && k[2] === b && k[3] === core && k[4] === falloff) return
    k[0] = r
    k[1] = gg
    k[2] = b
    k[3] = core
    k[4] = falloff
    const s = this.canvas.width
    const g = this.g
    g.clearRect(0, 0, s, s)
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
    const steps = 12
    for (let i = 0; i <= steps; i++) {
      const u = i / steps
      const a = u <= core ? 1 : Math.pow(1 - (u - core) / (1 - core), falloff)
      grad.addColorStop(u, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(4)})`)
    }
    g.fillStyle = grad
    g.fillRect(0, 0, s, s)
  }
  draw(g: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number): void {
    if (alpha <= 0.002 || r <= 0.1) return
    g.globalAlpha = clamp01(alpha)
    g.drawImage(this.canvas, x - r, y - r, 2 * r, 2 * r)
    g.globalAlpha = 1
  }
}

/** Smallest dimension helper: a size unit that scales from the 160×140 cells to the 900×420 stage. */
export const unit = (w: number, h: number): number => Math.min(w, h * 1.6)

// ---------------------------------------------------------------------------------------------
// Options

/**
 * Glides option values toward the viewer's choice. Snaps on the first frame (so a saved look
 * appears at once) and under reduced motion; otherwise eases with `tau`. Call `begin` once per frame.
 */
export class Glide {
  private started = false
  private quick = true
  private dt = 0
  begin(f: Frame): this {
    this.quick = !this.started || f.reducedMotion
    this.started = true
    this.dt = f.dt
    return this
  }
  to(current: number, goal: number, tau = 0.2): number {
    return this.quick ? goal : approach(current, goal, this.dt, tau)
  }
  /** True on the first frame and under reduced motion, when values jump straight to the goal. */
  get snapping(): boolean {
    return this.quick
  }
}

/** One gliding weight per value of a `choice` option, so switching looks is a crossfade. */
export class ChoiceMix {
  readonly w: Float32Array
  private readonly values: ReadonlyArray<string>
  constructor(values: ReadonlyArray<string>) {
    this.values = values
    this.w = new Float32Array(values.length)
  }
  step(glide: Glide, value: string, tau = 0.25): Float32Array {
    const target = Math.max(0, this.values.indexOf(value))
    for (let i = 0; i < this.w.length; i++) this.w[i] = glide.to(this.w[i]!, i === target ? 1 : 0, tau)
    return this.w
  }
}
