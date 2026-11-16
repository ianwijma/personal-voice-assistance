// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Palette, Rgb } from "../src/contract.ts"
import {
  AttackRelease,
  Spring,
  approach,
  clamp,
  clamp01,
  darken,
  fbm2,
  invLerp,
  lerp,
  lift,
  lighten,
  mix,
  noise2,
  noise3,
  optChoice,
  optColor,
  optNumber,
  optToggle,
  remap,
  rgb01,
  rgba,
  rng,
  sink,
  smoothstep
} from "../src/kit.ts"

const palette = (dark: boolean): Palette => ({
  dark,
  bg: [10, 20, 30],
  surface: [0, 0, 0],
  line: [0, 0, 0],
  ink: [200, 200, 200],
  inkFaint: [100, 100, 100],
  you: [1, 2, 3],
  voice: [4, 5, 6],
  danger: [255, 0, 0]
})

describe("number helpers", () => {
  it("clamp and clamp01 pin to their bounds", () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-5, 0, 3)).toBe(0)
    expect(clamp(2, 0, 3)).toBe(2)
    expect(clamp01(-0.1)).toBe(0)
    expect(clamp01(1.1)).toBe(1)
    expect(clamp01(0.25)).toBe(0.25)
  })

  it("lerp, invLerp and remap agree, and invLerp/remap clamp outside the range", () => {
    expect(lerp(10, 20, 0.25)).toBe(12.5)
    expect(invLerp(10, 20, 15)).toBe(0.5)
    expect(invLerp(10, 20, 5)).toBe(0)
    expect(invLerp(10, 20, 99)).toBe(1)
    expect(remap(5, 0, 10, 100, 200)).toBe(150)
    expect(remap(-5, 0, 10, 100, 200)).toBe(100)
    expect(remap(50, 0, 10, 100, 200)).toBe(200)
    // a reversed output range is allowed
    expect(remap(2.5, 0, 10, 1, 0)).toBe(0.75)
  })

  it("smoothstep is 0 and 1 at the edges, ½ in the middle, flat at the ends", () => {
    expect(smoothstep(0, 1, -1)).toBe(0)
    expect(smoothstep(0, 1, 2)).toBe(1)
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12)
    expect(smoothstep(0, 1, 0.01)).toBeLessThan(0.01)
    expect(smoothstep(0, 1, 0.99)).toBeGreaterThan(0.99)
  })
})

describe("approach", () => {
  it("covers 63 % of the gap after one time constant", () => {
    expect(approach(0, 1, 0.2, 0.2)).toBeCloseTo(1 - Math.exp(-1), 12)
  })

  it("snaps to the target when tau is 0 or negative", () => {
    expect(approach(0, 7, 0.016, 0)).toBe(7)
    expect(approach(0, 7, 0.016, -1)).toBe(7)
  })

  it("is frame-rate independent: 120 half-steps equal 60 whole steps", () => {
    let a = 0
    let b = 0
    for (let i = 0; i < 60; i++) a = approach(a, 1, 1 / 60, 0.3)
    for (let i = 0; i < 120; i++) b = approach(b, 1, 1 / 120, 0.3)
    expect(a).toBeCloseTo(b, 10)
  })
})

describe("AttackRelease", () => {
  it("rises with the attack constant and falls with the release constant", () => {
    const env = new AttackRelease(0.05, 0.5)
    const up = env.step(1, 0.05)
    expect(up).toBeCloseTo(1 - Math.exp(-1), 12)
    env.value = 1
    const down = env.step(0, 0.05)
    expect(down).toBeCloseTo(Math.exp(-0.1), 12)
    expect(1 - down).toBeLessThan(up) // fell slower than it rose
  })

  it("starts from the initial value and never overshoots the target", () => {
    const env = new AttackRelease(0.02, 0.2, 0.4)
    expect(env.value).toBe(0.4)
    for (let i = 0; i < 200; i++) expect(env.step(0.9, 1 / 60)).toBeLessThanOrEqual(0.9)
    expect(env.value).toBeCloseTo(0.9, 3)
  })
})

describe("Spring", () => {
  it("closes half the distance in about one half-life and does not overshoot when critically damped", () => {
    const s = new Spring(0.2)
    let peak = 0
    for (let t = 0; t < 0.2 - 1e-9; t += 1 / 240) peak = Math.max(peak, s.step(1, 1 / 240))
    expect(s.value).toBeGreaterThan(0.45)
    expect(s.value).toBeLessThan(0.55)
    for (let i = 0; i < 600; i++) peak = Math.max(peak, s.step(1, 1 / 60))
    expect(peak).toBeLessThanOrEqual(1 + 1e-3)
    expect(s.value).toBeCloseTo(1, 3)
    expect(Math.abs(s.velocity)).toBeLessThan(1e-3)
  })

  it("bounce > 0 overshoots and then settles", () => {
    const s = new Spring(0.2, 0, 0.8)
    let peak = 0
    for (let i = 0; i < 600; i++) peak = Math.max(peak, s.step(1, 1 / 60))
    expect(peak).toBeGreaterThan(1.05)
    expect(s.value).toBeCloseTo(1, 2)
  })

  it("set() jumps with no motion", () => {
    const s = new Spring(0.2)
    s.step(1, 0.1)
    s.set(5)
    expect(s.value).toBe(5)
    expect(s.velocity).toBe(0)
    s.step(5, 0.1)
    expect(s.value).toBe(5)
  })

  it("stays stable for a huge dt and gives similar results at 60 and 120 Hz", () => {
    const big = new Spring(0.1)
    expect(Number.isFinite(big.step(1, 5))).toBe(true)
    expect(big.value).toBeCloseTo(1, 3)
    const a = new Spring(0.25)
    const b = new Spring(0.25)
    for (let i = 0; i < 30; i++) a.step(1, 1 / 60)
    for (let i = 0; i < 60; i++) b.step(1, 1 / 120)
    expect(a.value).toBeCloseTo(b.value, 2)
  })

  it("survives a zero half-life (clamped) and a zero dt", () => {
    const s = new Spring(0)
    expect(Number.isFinite(s.step(1, 1 / 60))).toBe(true)
    const z = new Spring(0.2, 3)
    expect(z.step(10, 0)).toBe(3)
  })
})

describe("rng and noise", () => {
  it("rng is deterministic per seed, in [0, 1), and differs between seeds", () => {
    const a = rng(42)
    const b = rng(42)
    const seqA = Array.from({ length: 50 }, () => a())
    const seqB = Array.from({ length: 50 }, () => b())
    expect(seqA).toEqual(seqB)
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    const c = rng(43)
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(seqA)
  })

  it("rng has a roughly uniform mean", () => {
    const r = rng(7)
    let sum = 0
    for (let i = 0; i < 5000; i++) sum += r()
    expect(sum / 5000).toBeGreaterThan(0.47)
    expect(sum / 5000).toBeLessThan(0.53)
  })

  it("noise2, noise3 and fbm2 are deterministic, bounded and vary", () => {
    const r = rng(9)
    const seen2 = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const x = r() * 40 - 20
      const y = r() * 40 - 20
      const z = r() * 40 - 20
      const n2 = noise2(x, y)
      const n3 = noise3(x, y, z)
      const f = fbm2(x, y, 4)
      expect(n2).toBeGreaterThanOrEqual(-1.05)
      expect(n2).toBeLessThanOrEqual(1.05)
      expect(Math.abs(n3)).toBeLessThanOrEqual(1.05)
      expect(Math.abs(f)).toBeLessThanOrEqual(1.05)
      expect(noise2(x, y)).toBe(n2)
      seen2.add(Math.round(n2 * 100))
    }
    expect(seen2.size).toBeGreaterThan(30)
  })

  it("noise2 is smooth: tiny steps give tiny changes, and it is 0 at the origin", () => {
    expect(noise2(0, 0)).toBe(0)
    let worst = 0
    for (let x = -5; x < 5; x += 0.37) worst = Math.max(worst, Math.abs(noise2(x, 1.3) - noise2(x + 1e-3, 1.3)))
    expect(worst).toBeLessThan(0.02)
  })
})

describe("colour helpers", () => {
  const a: Rgb = [0, 100, 200]
  const b: Rgb = [100, 200, 0]

  it("mix interpolates per channel", () => {
    expect(mix(a, b, 0)).toEqual([0, 100, 200])
    expect(mix(a, b, 1)).toEqual([100, 200, 0])
    expect(mix(a, b, 0.5)).toEqual([50, 150, 100])
  })

  it("lighten and darken move toward white and black and clamp t", () => {
    expect(lighten(a, 1)).toEqual([255, 255, 255])
    expect(lighten(a, 5)).toEqual([255, 255, 255])
    expect(lighten(a, -1)).toEqual(a)
    expect(darken(a, 1)).toEqual([0, 0, 0])
    expect(darken(a, 0.5)).toEqual([0, 50, 100])
  })

  it("lift lightens on the dark theme and darkens on the light one; sink fades toward bg", () => {
    expect(lift(a, 0.5, palette(true))).toEqual(lighten(a, 0.5))
    expect(lift(a, 0.5, palette(false))).toEqual(darken(a, 0.5))
    expect(sink(a, 1, palette(true))).toEqual([10, 20, 30])
    expect(sink(a, 0, palette(true))).toEqual(a)
    expect(sink(a, 9, palette(true))).toEqual([10, 20, 30])
  })

  it("rgba truncates channels and clamps alpha; rgb01 scales to floats", () => {
    expect(rgba([1.9, 2.5, 255])).toBe("rgba(1,2,255,1)")
    expect(rgba([0, 0, 0], 0.5)).toBe("rgba(0,0,0,0.5)")
    expect(rgba([0, 0, 0], 2)).toBe("rgba(0,0,0,1)")
    expect(rgba([0, 0, 0], -1)).toBe("rgba(0,0,0,0)")
    expect(rgb01([255, 0, 51])).toEqual([1, 0, 0.2])
  })
})

describe("option readers", () => {
  const options = { n: 3, t: true, c: "round", k: "#ff0000", f: false }

  it("return the value for a matching kind and a neutral value otherwise", () => {
    expect(optNumber(options, "n")).toBe(3)
    expect(optNumber(options, "missing")).toBe(0)
    expect(optNumber(options, "c")).toBe(0)
    expect(optToggle(options, "t")).toBe(true)
    expect(optToggle(options, "f")).toBe(false)
    expect(optToggle(options, "n")).toBe(false)
    expect(optChoice(options, "c")).toBe("round")
    expect(optChoice(options, "missing")).toBe("")
    expect(optChoice(options, "n")).toBe("")
  })

  it("optColor resolves palette keys against the frame's palette, hex directly, and falls back to ink", () => {
    const p = palette(true)
    expect(optColor({ options: { k: "voice" }, palette: p }, "k")).toEqual(p.voice)
    expect(optColor({ options: { k: "#0a0b0c" }, palette: p }, "k")).toEqual([10, 11, 12])
    expect(optColor({ options: {}, palette: p }, "k")).toEqual(p.ink)
  })
})
