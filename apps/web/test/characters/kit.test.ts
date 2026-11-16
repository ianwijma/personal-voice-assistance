// @vitest-environment node
/** The kit for character authors (src/characters/kit.ts): numbers, noise, colour, option readers and canvas helpers. */
import { describe, expect, it, vi } from "vitest"
import type { Palette, Rgb } from "@/characters/contract.ts"
import { approach, AttackRelease, clamp, clamp01, clear2d, darken, fbm2, glProgram, invLerp, lerp, lift, lighten, mix, noise2, noise3, optChoice, optColor, optNumber, optToggle, remap, rgb01, rgba, rng, setup2d, sink, smoothstep, Spring } from "@/characters/kit.ts"
import { PALETTES } from "./support/palettes.ts"

describe("numbers", () => {
  it("clamp and clamp01 bound a value and leave one inside alone", () => {
    expect(clamp(5, 0, 3)).toBe(3)
    expect(clamp(-5, 0, 3)).toBe(0)
    expect(clamp(2, 0, 3)).toBe(2)
    expect(clamp01(-0.1)).toBe(0)
    expect(clamp01(1.1)).toBe(1)
    expect(clamp01(0.25)).toBe(0.25)
  })

  it("lerp, invLerp and remap map between ranges; the last two clamp, in either direction", () => {
    expect(lerp(10, 20, 0.25)).toBe(12.5)
    expect(lerp(10, 20, 2)).toBe(30)
    expect(invLerp(10, 20, 15)).toBe(0.5)
    expect(invLerp(10, 20, 0)).toBe(0)
    expect(invLerp(10, 20, 99)).toBe(1)
    expect(invLerp(20, 10, 15)).toBe(0.5)
    expect(remap(5, 0, 10, 100, 200)).toBe(150)
    expect(remap(-5, 0, 10, 100, 200)).toBe(100)
    expect(remap(50, 0, 10, 100, 200)).toBe(200)
    expect(remap(5, 0, 10, 200, 100)).toBe(150)
  })

  it("smoothstep is 0 and 1 at the edges, ½ in the middle, flat at the ends and monotonic", () => {
    expect(smoothstep(0, 1, -3)).toBe(0)
    expect(smoothstep(0, 1, 3)).toBe(1)
    expect(smoothstep(0, 2, 1)).toBeCloseTo(0.5, 12)
    expect(smoothstep(0, 1, 0.01)).toBeLessThan(0.01)
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const v = smoothstep(0, 1, i / 20)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it("approach closes 63 % of the gap after tau, takes the same path at any frame rate, and snaps for tau <= 0", () => {
    expect(approach(0, 1, 0.5, 0.5)).toBeCloseTo(1 - Math.exp(-1), 12)
    let a = 0
    for (let i = 0; i < 60; i++) a = approach(a, 1, 1 / 60, 0.3)
    let b = 0
    for (let i = 0; i < 120; i++) b = approach(b, 1, 1 / 120, 0.3)
    expect(a).toBeCloseTo(b, 9)
    expect(approach(0.2, 0.9, 0.016, 0)).toBe(0.9)
    expect(approach(0.2, 0.9, 0.016, -1)).toBe(0.9)
    expect(approach(0.2, 0.9, 0, 1)).toBe(0.2)
  })

  it("AttackRelease rises with the attack constant and falls with the release constant", () => {
    const up = new AttackRelease(0.03, 0.5)
    const upAfter = up.step(1, 0.03)
    expect(upAfter).toBeCloseTo(1 - Math.exp(-1), 9)
    const down = new AttackRelease(0.03, 0.5, 1)
    expect(down.step(0, 0.03)).toBeCloseTo(Math.exp(-0.06), 9)
    expect(down.value).toBeCloseTo(Math.exp(-0.06), 9)
    // Rising is much faster than falling by the same distance and time.
    expect(1 - upAfter).toBeLessThan(1 - (1 - Math.exp(-0.06)))
  })
})

describe("Spring", () => {
  it("closes half the distance in about one half-life and never overshoots when critically damped", () => {
    const s = new Spring(0.2)
    let t = 0
    let max = 0
    let half = Infinity
    for (let i = 0; i < 600; i++) {
      const v = s.step(1, 1 / 60)
      t += 1 / 60
      max = Math.max(max, v)
      if (half === Infinity && v >= 0.5) half = t
    }
    expect(half).toBeGreaterThan(0.17)
    expect(half).toBeLessThan(0.24)
    expect(max).toBeLessThanOrEqual(1.0001)
    expect(s.value).toBeCloseTo(1, 4)
  })

  it("overshoots with bounce, and still settles", () => {
    const s = new Spring(0.2, 0, 0.7)
    let max = 0
    for (let i = 0; i < 1200; i++) max = Math.max(max, s.step(1, 1 / 60))
    expect(max).toBeGreaterThan(1.02)
    expect(s.value).toBeCloseTo(1, 3)
  })

  it("stays finite and settles for a huge dt and for an out-of-range bounce", () => {
    const big = new Spring(0.1)
    expect(Number.isFinite(big.step(1, 5))).toBe(true)
    const wild = new Spring(0.1, 0, 5)
    for (let i = 0; i < 600; i++) wild.step(1, 1 / 60)
    expect(wild.value).toBeCloseTo(1, 3)
  })

  it("settles for a small half-life", () => {
    for (const halfLife of [0.05, 0.02, 0.01]) {
      const s = new Spring(halfLife)
      for (let i = 0; i < 60; i++) s.step(1, 1 / 60)
      expect(s.value, `halfLife ${halfLife}`).toBeCloseTo(1, 4)
    }
  })

  // Was a bug: below a half-life of about 8.5 ms (0 is clamped to 1 ms) omega * (1/240) passed the explicit Euler
  // stability limit and the value diverged (to -1e49 .. NaN). Stiff springs now use the exact solution.
  it("a half-life of 5 ms or 0 follows its target instead of diverging", () => {
    for (const halfLife of [0.005, 0]) {
      const s = new Spring(halfLife)
      for (let i = 0; i < 60; i++) s.step(1, 1 / 60)
      expect(s.value, `halfLife ${halfLife}`).toBeCloseTo(1, 4)
    }
  })

  it("every half-life settles for any dt, with or without bounce, and never overshoots when critically damped", () => {
    for (const halfLife of [0, 0.0005, 0.001, 0.005, 0.0139, 0.015, 0.1]) {
      for (const bounce of [0, 0.5, 0.9]) {
        for (const dt of [1 / 240, 1 / 60, 0.1, 1, 100, Infinity]) {
          const s = new Spring(halfLife, 0, bounce)
          let max = 0
          for (let i = 0; i < 4000 && Math.abs(s.value - 1) > 1e-9; i++) max = Math.max(max, s.step(1, dt))
          const label = `halfLife ${halfLife}, bounce ${bounce}, dt ${dt}`
          expect(Number.isFinite(s.value), label).toBe(true)
          expect(s.value, label).toBeCloseTo(1, 4)
          if (bounce === 0) expect(max, label).toBeLessThanOrEqual(1.0001)
        }
      }
    }
  })

  it("a stiff spring matches the sub-stepped integration across the switch-over, and keeps its velocity", () => {
    const stiff = new Spring(0.0139) // exact solution (ω·h > 0.5)
    const soft = new Spring(0.0141) // sub-stepped Euler
    for (let i = 0; i < 6; i++) {
      stiff.step(1, 1 / 240)
      soft.step(1, 1 / 240)
    }
    expect(stiff.value).toBeGreaterThan(0)
    expect(Math.abs(stiff.value - soft.value)).toBeLessThan(0.02)
    expect(stiff.velocity).toBeGreaterThan(0)
    // Velocity is carried over a change of half-life: the spring keeps moving.
    stiff.halfLife = 0.2
    const before = stiff.value
    stiff.step(1, 1 / 60)
    expect(stiff.value).toBeGreaterThan(before)
  })

  it("does not move for dt 0, and set() jumps with no velocity left over", () => {
    const s = new Spring(0.1, 0.4)
    expect(s.step(1, 0)).toBe(0.4)
    s.step(1, 0.05)
    expect(s.velocity).toBeGreaterThan(0)
    s.set(2)
    expect(s.value).toBe(2)
    expect(s.velocity).toBe(0)
    expect(s.step(2, 1 / 60)).toBe(2)
  })
})

describe("randomness and noise", () => {
  it("rng is deterministic per seed, in [0, 1), and differs between seeds", () => {
    const a = rng(7)
    const b = rng(7)
    const seqA = Array.from({ length: 50 }, () => a())
    expect(seqA).toEqual(Array.from({ length: 50 }, () => b()))
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(new Set(seqA).size).toBe(50)
    expect(Array.from({ length: 5 }, rng(8))).not.toEqual(seqA.slice(0, 5))
    // Negative and fractional seeds are coerced, not rejected.
    expect(rng(-1)()).toBeGreaterThanOrEqual(0)
    expect(rng(1.9)()).toBe(rng(1)())
  })

  it("rng is roughly uniform", () => {
    const r = rng(42)
    let sum = 0
    const n = 20000
    for (let i = 0; i < n; i++) sum += r()
    expect(sum / n).toBeGreaterThan(0.48)
    expect(sum / n).toBeLessThan(0.52)
  })

  it("noise2, noise3 and fbm2 are deterministic, bounded about −1..1, smooth, and not constant", () => {
    const r = rng(3)
    const vals2: Array<number> = []
    const vals3: Array<number> = []
    for (let i = 0; i < 2000; i++) {
      const x = r() * 40 - 20
      const y = r() * 40 - 20
      const z = r() * 40 - 20
      const a = noise2(x, y)
      const b = noise3(x, y, z)
      const c = fbm2(x, y, 4)
      for (const v of [a, b, c]) {
        expect(Number.isFinite(v)).toBe(true)
        expect(Math.abs(v)).toBeLessThanOrEqual(1.05)
      }
      vals2.push(a)
      vals3.push(b)
      expect(noise2(x, y)).toBe(a)
      // Smooth: a tiny step changes the value by a tiny amount.
      expect(Math.abs(noise2(x + 1e-4, y) - a)).toBeLessThan(0.01)
      expect(Math.abs(noise3(x, y, z + 1e-4) - b)).toBeLessThan(0.01)
    }
    for (const vals of [vals2, vals3]) {
      expect(Math.max(...vals)).toBeGreaterThan(0.5)
      expect(Math.min(...vals)).toBeLessThan(-0.5)
    }
  })

  it("noise is zero at the origin and fbm2 with one octave is noise2", () => {
    expect(noise2(0, 0)).toBe(0)
    expect(noise3(0, 0, 0)).toBe(0)
    expect(fbm2(1.3, 2.7, 1)).toBeCloseTo(noise2(1.3, 2.7), 12)
    expect(fbm2(1.3, 2.7)).toBe(fbm2(1.3, 2.7, 3))
  })
})

describe("colour", () => {
  const a: Rgb = [0, 100, 200]
  const b: Rgb = [100, 200, 0]

  it("mix interpolates per channel", () => {
    expect(mix(a, b, 0)).toEqual(a)
    expect(mix(a, b, 1)).toEqual(b)
    expect(mix(a, b, 0.5)).toEqual([50, 150, 100])
  })

  it("lighten and darken move toward white and black, clamping t to 0..1", () => {
    expect(lighten(a, 0)).toEqual(a)
    expect(lighten(a, 1)).toEqual([255, 255, 255])
    expect(lighten(a, 7)).toEqual([255, 255, 255])
    expect(lighten(a, -3)).toEqual(a)
    expect(darken(a, 1)).toEqual([0, 0, 0])
    expect(darken(a, 0.5)).toEqual([0, 50, 100])
  })

  it("lift is lighter on the dark theme and darker on the light one; sink moves toward the page background", () => {
    const sum = (c: Rgb) => c[0] + c[1] + c[2]
    expect(sum(lift(a, 0.3, PALETTES.dark))).toBeGreaterThan(sum(a))
    expect(sum(lift(a, 0.3, PALETTES.light))).toBeLessThan(sum(a))
    expect(lift(a, 0.3, PALETTES.dark)).toEqual(lighten(a, 0.3))
    expect(lift(a, 0.3, PALETTES.light)).toEqual(darken(a, 0.3))
    const pal: Palette = { ...PALETTES.dark, bg: [10, 20, 30] }
    expect(sink(a, 1, pal)).toEqual([10, 20, 30])
    expect(sink(a, 0, pal)).toEqual(a)
    expect(sink(a, 9, pal)).toEqual([10, 20, 30])
  })

  it("rgba truncates channels, clamps alpha and defaults it to 1", () => {
    expect(rgba([10.9, 20.2, 30.5])).toBe("rgba(10,20,30,1)")
    expect(rgba([1, 2, 3], 0.5)).toBe("rgba(1,2,3,0.5)")
    expect(rgba([1, 2, 3], 2)).toBe("rgba(1,2,3,1)")
    expect(rgba([1, 2, 3], -1)).toBe("rgba(1,2,3,0)")
  })

  it("rgb01 divides by 255", () => {
    expect(rgb01([0, 51, 255])).toEqual([0, 0.2, 1])
  })
})

describe("option readers are total", () => {
  const o = { n: 2.5, t: true, c: "round", s: "x", off: false }
  it("give the value when the kind matches, and 0, false or '' when the id is missing or another kind", () => {
    expect(optNumber(o, "n")).toBe(2.5)
    expect(optNumber(o, "missing")).toBe(0)
    expect(optNumber(o, "c")).toBe(0)
    expect(optNumber(o, "t")).toBe(0)
    expect(optToggle(o, "t")).toBe(true)
    expect(optToggle(o, "off")).toBe(false)
    expect(optToggle(o, "n")).toBe(false)
    expect(optToggle(o, "missing")).toBe(false)
    expect(optChoice(o, "c")).toBe("round")
    expect(optChoice(o, "n")).toBe("")
    expect(optChoice(o, "missing")).toBe("")
  })

  it("optColor resolves a palette key against frame.palette, parses hex, and gives ink for a missing or bad value", () => {
    const palette = PALETTES.dark
    const col = (v: unknown) => optColor({ options: { c: v as string }, palette }, "c")
    expect(col("you")).toBe(palette.you)
    expect(col("voice")).toBe(palette.voice)
    expect(col("#ff8000")).toEqual([255, 128, 0])
    expect(col("nope")).toBe(palette.ink)
    expect(col(3)).toBe(palette.ink)
    expect(optColor({ options: {}, palette }, "absent")).toBe(palette.ink)
  })
})

/** A canvas whose context records the calls the kit makes on it. */
const recordingCanvas = (ctx: object | null) => {
  const canvas = { width: 200, height: 100, getContext: vi.fn(() => ctx) }
  return canvas as unknown as HTMLCanvasElement & { getContext: ReturnType<typeof vi.fn> }
}

describe("canvas helpers", () => {
  it("setup2d asks for an alpha context, scales to CSS pixels, and throws when there is no 2D context", () => {
    const setTransform = vi.fn()
    const canvas = recordingCanvas({ setTransform })
    const g = setup2d(canvas, 2)
    expect(canvas.getContext).toHaveBeenCalledWith("2d", { alpha: true })
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
    expect(g).toBeDefined()
    setup2d(canvas)
    expect(setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, 0)
    expect(() => setup2d(recordingCanvas(null))).toThrow("2D canvas unavailable")
  })

  it("clear2d wipes the whole backing store, then restores the CSS-pixel transform, shifted by the origin in CSS pixels", () => {
    const calls: Array<[string, ...Array<number>]> = []
    const g = {
      canvas: { width: 400, height: 200 },
      setTransform: (...a: Array<number>) => calls.push(["setTransform", ...a]),
      clearRect: (...a: Array<number>) => calls.push(["clearRect", ...a])
    } as unknown as CanvasRenderingContext2D
    clear2d(g, 2)
    expect(calls).toEqual([["setTransform", 1, 0, 0, 1, 0, 0], ["clearRect", 0, 0, 400, 200], ["setTransform", 2, 0, 0, 2, 0, 0]])
    calls.length = 0
    clear2d(g, 2, { x: 30, y: 10 })
    expect(calls).toEqual([["setTransform", 1, 0, 0, 1, 0, 0], ["clearRect", 0, 0, 400, 200], ["setTransform", 2, 0, 0, 2, 60, 20]])
  })

  describe("glProgram", () => {
    const fakeGl = (opts: { readonly compileOk?: boolean; readonly linkOk?: boolean; readonly shaderLog?: string | null; readonly programLog?: string | null }) => {
      const deleted: Array<unknown> = []
      const gl = {
        VERTEX_SHADER: 1,
        FRAGMENT_SHADER: 2,
        COMPILE_STATUS: 3,
        LINK_STATUS: 4,
        createShader: (type: number) => ({ type }),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: () => opts.compileOk ?? true,
        getShaderInfoLog: () => opts.shaderLog ?? null,
        createProgram: () => ({ program: true }),
        attachShader: vi.fn(),
        linkProgram: vi.fn(),
        deleteShader: (s: unknown) => deleted.push(s),
        getProgramParameter: () => opts.linkOk ?? true,
        getProgramInfoLog: () => opts.programLog ?? null
      }
      return { gl: gl as unknown as WebGL2RenderingContext, raw: gl, deleted }
    }

    it("returns the linked program and releases both shaders", () => {
      const { gl, raw, deleted } = fakeGl({})
      expect(glProgram(gl, "v", "f")).toEqual({ program: true })
      expect(raw.attachShader).toHaveBeenCalledTimes(2)
      expect(deleted).toHaveLength(2)
    })

    it("throws with the shader's info log when a shader does not compile, and with a default when there is none", () => {
      expect(() => glProgram(fakeGl({ compileOk: false, shaderLog: "0:1 syntax error" }).gl, "v", "f")).toThrow("0:1 syntax error")
      expect(() => glProgram(fakeGl({ compileOk: false }).gl, "v", "f")).toThrow("shader compile failed")
    })

    it("throws with the program's info log when linking fails, after releasing the shaders", () => {
      const { gl, deleted } = fakeGl({ linkOk: false, programLog: "varying mismatch" })
      expect(() => glProgram(gl, "v", "f")).toThrow("varying mismatch")
      expect(deleted).toHaveLength(2)
      expect(() => glProgram(fakeGl({ linkOk: false }).gl, "v", "f")).toThrow("program link failed")
    })
  })
})
