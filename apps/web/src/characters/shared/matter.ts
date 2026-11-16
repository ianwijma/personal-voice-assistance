/**
 * Shared helpers for the "matter" characters (liquid-blob, particle-sphere, pitch-ink, ripple-pond,
 * flame, chladni-sand). Not a character: it lives in `shared/`, outside `library/`.
 * Copied from the lab (docs/research/visualiser-investigation/lab/src/designs/_matter.ts), behaviour unchanged;
 * `ModeMix` reads `frame.coreMode` (identical to `mode` for a character without extra modes).
 * Ports import it and never edit it.
 *
 * Everything here is allocation-free per frame: colours are mixed into caller-owned arrays.
 */
import type { CoreMode, Frame, Palette, Rgb, VoiceFeatures } from "../contract.ts"
import { approach, clamp01 } from "../kit.ts"

export const MODE_INDEX: { readonly [M in CoreMode]: number } = { idle: 0, listening: 1, hearing: 2, thinking: 3, speaking: 4 }

/** A mutable RGB triple (0..255). */
export type Col = [number, number, number]
export const col = (): Col => [0, 0, 0]

export const setCol = (out: Col, c: Rgb): Col => {
  out[0] = c[0]
  out[1] = c[1]
  out[2] = c[2]
  return out
}

/** out = a + (b − a)·t, in place. */
export const mixInto = (out: Col, a: Rgb, b: Rgb, t: number): Col => {
  out[0] = a[0] + (b[0] - a[0]) * t
  out[1] = a[1] + (b[1] - a[1]) * t
  out[2] = a[2] + (b[2] - a[2]) * t
  return out
}

/** Toward white on the dark theme and toward black on the light one ("stands out more"), in place. */
export const liftInto = (out: Col, c: Rgb, t: number, p: Palette): Col => mixInto(out, c, p.dark ? WHITE : BLACK, clamp01(t))
/** Toward the page background ("recedes"), in place. */
export const sinkInto = (out: Col, c: Rgb, t: number, p: Palette): Col => mixInto(out, c, p.bg, clamp01(t))

export const WHITE: Rgb = [255, 255, 255]
export const BLACK: Rgb = [0, 0, 0]

/** `rgba()` string; the only allocation the designs make per draw call, as in the kit. */
export const css = (c: Rgb, a = 1): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a < 0 ? 0 : a > 1 ? 1 : a})`

/**
 * Continuous mode weights: one weight per mode that eases to 1 for the current mode and to 0 for
 * the others, so a design can blend every look parameter and a mode change is never a cut.
 * Reduced motion jumps (a cross-fade is motion too).
 */
export class ModeMix {
  readonly w = new Float32Array(5)
  private started = false
  private readonly tau: number
  constructor(tau = 0.32) {
    this.tau = tau
  }

  step(f: Frame): this {
    const k = MODE_INDEX[f.coreMode]
    const jump = !this.started || f.reducedMotion
    this.started = true
    let sum = 0
    for (let i = 0; i < 5; i++) {
      const target = i === k ? 1 : 0
      this.w[i] = jump ? target : approach(this.w[i]!, target, f.dt, this.tau)
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
  /** Weight of "taking in" (listening + hearing). */
  get taking(): number {
    return this.w[1]! + this.w[2]!
  }
  /** Weight of the assistant's side (thinking + speaking). */
  get giving(): number {
    return this.w[3]! + this.w[4]!
  }
  /** −1 inward (taking in) .. +1 outward (speaking); thinking and idle are 0. */
  get flow(): number {
    return this.w[4]! - this.w[1]! - this.w[2]!
  }
  /** Blend five per-mode numbers by the weights. */
  blend(idle: number, listening: number, hearing: number, thinking: number, speaking: number): number {
    const w = this.w
    return w[0]! * idle + w[1]! * listening + w[2]! * hearing + w[3]! * thinking + w[4]! * speaking
  }
}

/**
 * The mode colour of the conversation: faint ink when idle, the person's mint while the assistant
 * listens or hears, the assistant's amber while it thinks or speaks. `out` is written in place.
 */
export const modeTone = (out: Col, m: ModeMix, p: Palette): Col => {
  const w = m.w
  const a = w[0]!
  const b = w[1]! + w[2]!
  const c = w[3]! + w[4]!
  out[0] = a * p.inkFaint[0] + b * p.you[0] + c * p.voice[0]
  out[1] = a * p.inkFaint[1] + b * p.you[1] + c * p.voice[1]
  out[2] = a * p.inkFaint[2] + b * p.you[2] + c * p.voice[2]
  return out
}

/**
 * The voice that drives the look now, cross-faded: the person's features while the assistant
 * takes in, the assistant's while it speaks. Read a scalar with `voiceOf(f, m, key)`.
 */
export const voiceOf = (f: Frame, m: ModeMix, key: "level" | "voicing" | "pitch" | "register" | "pitchDelta" | "brightness" | "sibilance" | "onset" | "syllableRate" | "low" | "mid" | "high"): number => {
  const u = f.user[key]
  const a = f.agent[key]
  const s = m.speaking + m.thinking
  return u + (a - u) * clamp01(s)
}

/** Contrast-shaped band energy: the raw bands sit around 0.6 in speech; this spreads them to 0..1. */
export const bandShape = (v: VoiceFeatures, i: number): number => {
  const b = v.bands[i] ?? 0
  const x = clamp01((b - 0.28) / 0.72)
  return x * x
}

/**
 * Eases the viewer's option values (`frame.options`) so a change glides instead of jumping.
 * Call `begin(f)` once per frame, then `to(current, goal, tau)` per value. It snaps on the
 * first frame (so the first picture is already the chosen look) and under reduced motion.
 */
export class OptionGlide {
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
  /** Eases one weight per choice toward 1 for `chosen` (an index) and 0 for the rest, in place. */
  weights(w: Float32Array, chosen: number, tau = 0.25): Float32Array {
    for (let i = 0; i < w.length; i++) w[i] = this.to(w[i]!, i === chosen ? 1 : 0, tau)
    return w
  }
}

/**
 * Grows `base` by the factor `k` without passing `cap`: below 1 it scales straight down, above
 * 1 the extra is eased into the room left under the cap. `k = 1` returns `base` exactly, so a
 * design's default look is untouched.
 */
export const grow = (base: number, k: number, cap: number): number => {
  if (k <= 1) return base * k
  const room = cap - base
  if (room <= 0) return base
  return base + room * Math.tanh((base * (k - 1)) / room)
}

/** Stable hash 0..1 of an integer (for per-particle constants without storing them). */
export const hash01 = (n: number): number => {
  let x = (n | 0) * 0x27d4eb2d
  x = (x ^ (x >>> 15)) * 0x85ebca6b
  x = x ^ (x >>> 13)
  return ((x >>> 0) % 100000) / 100000
}
