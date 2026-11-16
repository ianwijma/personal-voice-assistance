/**
 * The kit for character authors: small, allocation-free helpers. A character may import this file and
 * `contract.ts` (and the shared modules under `shared/`), nothing else of the application.
 *
 *   numbers   clamp, clamp01, lerp, invLerp, remap, smoothstep, approach (exponential smoothing),
 *             AttackRelease (fast up, slow down), Spring (critically damped)
 *   noise     rng (seeded), noise2 / noise3 (simplex, about −1..1), fbm2
 *   colour    mix, rgba, lighten, darken, lift / sink (theme-aware)
 *   options   optNumber, optToggle, optChoice, optColor: read `frame.options` (docs/CHARACTERS.md §4.4)
 *   canvas    setup2d (size + transform), clear2d (optionally at the focus), glProgram (WebGL2 shader pair)
 *
 * All smoothing helpers take `dt` in seconds, so they behave the same at 60 and 120 Hz.
 * Copied from the lab (docs/research/visualiser-investigation/lab/src/kit.ts); behaviour unchanged.
 */
import type { Frame, OptionValues, Palette, Rgb } from "./contract.ts"
import { resolveColor } from "./options.ts"

// ---------------------------------------------------------------------------------------------
// Numbers

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
/** Where `x` sits between `a` and `b`, clamped to 0..1. */
export const invLerp = (a: number, b: number, x: number): number => clamp01((x - a) / (b - a))
/** Map `x` from [a0, a1] to [b0, b1], clamped. */
export const remap = (x: number, a0: number, a1: number, b0: number, b1: number): number => lerp(b0, b1, invLerp(a0, a1, x))
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = invLerp(a, b, x)
  return t * t * (3 - 2 * t)
}
export const TAU = Math.PI * 2

/** Move `current` toward `target` with time constant `tau` seconds (63 % after `tau`). */
export const approach = (current: number, target: number, dt: number, tau: number): number =>
  tau <= 0 ? target : current + (target - current) * (1 - Math.exp(-dt / tau))

/** Exponential smoothing with separate rise and fall time constants (an envelope follower). */
export class AttackRelease {
  value: number
  attack: number
  release: number
  constructor(attack: number, release: number, initial = 0) {
    this.attack = attack
    this.release = release
    this.value = initial
  }
  step(target: number, dt: number): number {
    this.value = approach(this.value, target, dt, target > this.value ? this.attack : this.release)
    return this.value
  }
}

/**
 * Critically damped spring: follows its target without overshoot, with velocity, so a moving
 * target gives smooth motion. `halfLife` is the seconds to close half the distance.
 * Use `bounce` (0..0.9) for an underdamped wobble instead.
 */
export class Spring {
  value: number
  velocity = 0
  halfLife: number
  bounce: number
  constructor(halfLife: number, initial = 0, bounce = 0) {
    this.halfLife = halfLife
    this.bounce = bounce
    this.value = initial
  }
  step(target: number, dt: number): number {
    const omega = 1.678 / Math.max(1e-3, this.halfLife) // (1 + ωt)·e^(−ωt) = ½ at ωt ≈ 1.678
    const zeta = 1 - clamp(this.bounce, 0, 0.9)
    if (!(dt > 0)) return this.value
    // Fully decayed (e^−50 ≈ 2e-22): snap, so an enormous dt costs nothing and cannot overflow.
    if (dt * zeta * omega > 50) {
      this.value = target
      this.velocity = 0
      return this.value
    }
    if (omega * (1 / 240) > 0.5) {
      // Stiff spring (half-life under ~14 ms): explicit Euler is unstable at frame-sized steps, so use
      // the exact solution of the damped oscillator, which is stable for any dt and any half-life > 0.
      const x0 = this.value - target
      const v0 = this.velocity
      const a = zeta * omega
      const decay = Math.exp(-a * dt)
      let x: number
      let v: number
      if (zeta >= 1) {
        const b = v0 + a * x0
        x = decay * (x0 + b * dt)
        v = decay * (v0 - a * b * dt)
      } else {
        const wd = omega * Math.sqrt(1 - zeta * zeta)
        const c = Math.cos(wd * dt)
        const s = Math.sin(wd * dt)
        const b = (v0 + a * x0) / wd
        x = decay * (x0 * c + b * s)
        v = decay * ((wd * b - a * x0) * c - (a * b + wd * x0) * s)
      }
      this.value = target + x
      this.velocity = v
      return this.value
    }
    // Semi-implicit Euler in sub-steps of at most 1/240 s: stable while ω/240 ≤ 0.5 (checked above).
    let left = dt
    while (left > 0) {
      const h = Math.min(left, 1 / 240)
      const acc = omega * omega * (target - this.value) - 2 * zeta * omega * this.velocity
      this.velocity += acc * h
      this.value += this.velocity * h
      left -= h
    }
    return this.value
  }
  /** Jump to `value` with no motion. */
  set(value: number): void {
    this.value = value
    this.velocity = 0
  }
}

// ---------------------------------------------------------------------------------------------
// Randomness and noise

/** Seeded PRNG (mulberry32): `rng(1)()` → 0..1, the same sequence for the same seed. */
export const rng = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PERM = new Uint8Array(512)
{
  const r = rng(1337)
  const p = new Uint8Array(256)
  for (let i = 0; i < 256; i++) p[i] = i
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const t = p[i]!
    p[i] = p[j]!
    p[j] = t
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]!
}
const G3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1])

/** 2D simplex noise, about −1..1, smooth, period 256. */
export const noise2 = (x: number, y: number): number => {
  const F2 = 0.3660254037844386
  const G2 = 0.21132486540518713
  const s = (x + y) * F2
  const i = Math.floor(x + s)
  const j = Math.floor(y + s)
  const t = (i + j) * G2
  const x0 = x - (i - t)
  const y0 = y - (j - t)
  const i1 = x0 > y0 ? 1 : 0
  const j1 = 1 - i1
  const x1 = x0 - i1 + G2
  const y1 = y0 - j1 + G2
  const x2 = x0 - 1 + 2 * G2
  const y2 = y0 - 1 + 2 * G2
  const ii = i & 255
  const jj = j & 255
  let n = 0
  let c = 0.5 - x0 * x0 - y0 * y0
  if (c > 0) {
    const g = (PERM[ii + PERM[jj]!]! % 12) * 3
    c *= c
    n += c * c * (G3[g]! * x0 + G3[g + 1]! * y0)
  }
  c = 0.5 - x1 * x1 - y1 * y1
  if (c > 0) {
    const g = (PERM[ii + i1 + PERM[jj + j1]!]! % 12) * 3
    c *= c
    n += c * c * (G3[g]! * x1 + G3[g + 1]! * y1)
  }
  c = 0.5 - x2 * x2 - y2 * y2
  if (c > 0) {
    const g = (PERM[ii + 1 + PERM[jj + 1]!]! % 12) * 3
    c *= c
    n += c * c * (G3[g]! * x2 + G3[g + 1]! * y2)
  }
  return 70 * n
}

/** 3D simplex noise, about −1..1. Use the third axis for time to animate a 2D field. */
export const noise3 = (x: number, y: number, z: number): number => {
  const F3 = 1 / 3
  const G = 1 / 6
  const s = (x + y + z) * F3
  const i = Math.floor(x + s)
  const j = Math.floor(y + s)
  const k = Math.floor(z + s)
  const t = (i + j + k) * G
  const x0 = x - (i - t)
  const y0 = y - (j - t)
  const z0 = z - (k - t)
  let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number
  if (x0 >= y0) {
    if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0]
    else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1]
    else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1]
  } else if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1]
  else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1]
  else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0]
  const ii = i & 255
  const jj = j & 255
  const kk = k & 255
  const corner = (dx: number, dy: number, dz: number, gi: number): number => {
    let c = 0.6 - dx * dx - dy * dy - dz * dz
    if (c <= 0) return 0
    const g = (gi % 12) * 3
    c *= c
    return c * c * (G3[g]! * dx + G3[g + 1]! * dy + G3[g + 2]! * dz)
  }
  const n =
    corner(x0, y0, z0, PERM[ii + PERM[jj + PERM[kk]!]!]!) +
    corner(x0 - i1 + G, y0 - j1 + G, z0 - k1 + G, PERM[ii + i1 + PERM[jj + j1 + PERM[kk + k1]!]!]!) +
    corner(x0 - i2 + 2 * G, y0 - j2 + 2 * G, z0 - k2 + 2 * G, PERM[ii + i2 + PERM[jj + j2 + PERM[kk + k2]!]!]!) +
    corner(x0 - 1 + 3 * G, y0 - 1 + 3 * G, z0 - 1 + 3 * G, PERM[ii + 1 + PERM[jj + 1 + PERM[kk + 1]!]!]!)
  return 32 * n
}

/** Fractal (octave-summed) 2D noise, about −1..1. */
export const fbm2 = (x: number, y: number, octaves = 3): number => {
  let sum = 0
  let amp = 0.5
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x, y)
    norm += amp
    x *= 2.03
    y *= 2.03
    amp *= 0.5
  }
  return sum / norm
}

// ---------------------------------------------------------------------------------------------
// Colour (on the contract's 0..255 `Rgb`)

export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
/** A CSS colour string for canvas: `rgba(c, alpha)`. */
export const rgba = (c: Rgb, alpha = 1): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp01(alpha)})`
export const lighten = (c: Rgb, t: number): Rgb => mix(c, [255, 255, 255], clamp01(t))
export const darken = (c: Rgb, t: number): Rgb => mix(c, [0, 0, 0], clamp01(t))
/** Make a colour stand out more against the page: lighter on the dark theme, darker on the light one. */
export const lift = (c: Rgb, t: number, palette: Palette): Rgb => (palette.dark ? lighten(c, t) : darken(c, t))
/** Make a colour recede toward the page background (a faded, "off" version of it). */
export const sink = (c: Rgb, t: number, palette: Palette): Rgb => mix(c, palette.bg, clamp01(t))
/** WebGL-friendly copy: 0..1 floats. */
export const rgb01 = (c: Rgb): [number, number, number] => [c[0] / 255, c[1] / 255, c[2] / 255]

// ---------------------------------------------------------------------------------------------
// Canvas

/**
 * Get a 2D context, scaled so you draw in CSS pixels. Call it from `create`, and again from
 * `resize` (setting `canvas.width` resets the context state; the host already sized it).
 */
export const setup2d = (canvas: HTMLCanvasElement, dpr = 1): CanvasRenderingContext2D => {
  const g = canvas.getContext("2d", { alpha: true })
  if (g === null) throw new Error("2D canvas unavailable")
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  return g
}

/**
 * Clear the whole canvas (transparent) and restore the CSS-pixel transform. Call at the top of `frame`.
 * `origin`: put (0, 0) at this point instead of the canvas corner; a stage character passes `frame.focus`, so code
 * written for a box from (0, 0) to (focus.width, focus.height) draws on the box's place on the stage
 * (docs/CHARACTERS.md §2.6). With the origin at (0, 0) the calls are exactly those without it.
 */
export const clear2d = (g: CanvasRenderingContext2D, dpr: number, origin?: { readonly x: number; readonly y: number }): void => {
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.clearRect(0, 0, g.canvas.width, g.canvas.height)
  g.setTransform(dpr, 0, 0, dpr, origin === undefined ? 0 : dpr * origin.x, origin === undefined ? 0 : dpr * origin.y)
}

/** Compile and link a WebGL2 program from two GLSL ES 3.00 sources; throws with the info log on failure. */
export const glProgram = (gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram => {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed")
    return s
  }
  const p = gl.createProgram()
  const vs = shader(gl.VERTEX_SHADER, vertex)
  const fs = shader(gl.FRAGMENT_SHADER, fragment)
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program link failed")
  return p
}

/** A full-screen triangle vertex shader (no buffers needed: `gl.drawArrays(gl.TRIANGLES, 0, 3)`); passes `uv` 0..1. */
export const FULLSCREEN_VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// ---------------------------------------------------------------------------------------------
// Options (the viewer's settings, `frame.options`). Cheap and total: a missing id gives 0, false, "" or ink.

/** A `number` option. */
export const optNumber = (options: OptionValues, id: string): number => {
  const v = options[id]
  return typeof v === "number" ? v : 0
}
/** A `toggle` option. */
export const optToggle = (options: OptionValues, id: string): boolean => options[id] === true
/** A `choice` option: the chosen `value`. */
export const optChoice = (options: OptionValues, id: string): string => {
  const v = options[id]
  return typeof v === "string" ? v : ""
}
/** A `color` option as RGB: a palette key resolves against `frame.palette` (so it follows theme and recolouring), "#rrggbb" is parsed once and cached. */
export const optColor = (frame: Pick<Frame, "options" | "palette">, id: string): Rgb => resolveColor(frame.options[id], frame.palette)
