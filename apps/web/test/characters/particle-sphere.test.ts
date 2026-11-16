/**
 * Particle sphere, the behaviour that is its own (the shared suites in `compat.test.ts`, `baseline.test.ts` and
 * `isolation.test.ts` already run it through the manifest, the modes, the option extremes, reduced-motion stillness,
 * the digest and the stage checks): how many points there are and how the voice's grain changes them, the spectrum
 * displacing the surface by latitude, the streaks (direction, form, bursts on syllables, the still fan under reduced
 * motion), the three point styles, the onset swell, the press ripple and hover, and the options. Checked on the calls it
 * makes, through the runner, on the recording canvas.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { BAND_COUNT, type Mode, type Palette, type VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import { TAU } from "@/characters/kit.ts"
import particleSphere from "@/characters/library/particle-sphere.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
/** The sphere's centre in a box. */
const CX = W / 2
const CY = H / 2
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Pt = { readonly x: number; readonly y: number; readonly r: number }
type Pointer = { readonly x: number; readonly y: number; readonly down: boolean; readonly inside: boolean }
type Stored = Record<string, number | boolean | string>

const make = (stored: Stored = {}, size: readonly [number, number] = [W, H]) => {
  const canvas = document.createElement("canvas")
  const r = new Runner(particleSphere, canvas, stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

/** A voice that is sounding now: loud, voiced, mid pitch, flat spectrum, and no syllable starting unless `onset` says so. */
const voice = (o: Partial<VoiceFeatures> = {}): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.level = 0.5
  f.rms = 0.05
  f.speaking = true
  f.voicing = 1
  f.pitch = 0.5
  f.register = 0.5
  f.syllableRate = 4
  return Object.assign(f, o)
}
/** Full energy in bands `from..to` (inclusive) and none elsewhere. */
const bandsIn = (from: number, to: number): Float32Array => {
  const b = new Float32Array(BAND_COUNT)
  for (let i = from; i <= to; i++) b[i] = 1
  return b
}
const quiet = createVoiceFeatures()
const DEEP = { register: 0, pitch: 0 }
const HIGH = { register: 1, pitch: 1 }

interface StepOptions {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly palette?: Palette
  readonly reduced?: boolean
  readonly pointer?: Pointer
}

/** Step one frame and return its calls. */
const frame = (r: Runner, mode: Mode, o: StepOptions = {}): Array<Call> => {
  recording.log = []
  r.step({
    mode,
    dt: DT,
    user: o.user ?? quiet,
    agent: o.agent ?? quiet,
    palette: o.palette ?? PALETTES.dark,
    reducedMotion: o.reduced === true,
    pointer: o.pointer ?? { x: 0, y: 0, down: false, inside: false },
    sinceInterrupt: Infinity
  })
  const calls = recording.log
  recording.log = null
  return calls
}

/** Step `frames` frames the same way; returns the calls of the last. */
const settle = (r: Runner, mode: Mode, frames: number, o: StepOptions = {}): Array<Call> => {
  let last: Array<Call> = []
  for (let i = 0; i < frames; i++) last = frame(r, mode, o)
  return last
}

/** Run `n` frames from the first one in `mode`, the voice given per frame; the calls of every frame. */
const run = (r: Runner, mode: Mode, n: number, who: "user" | "agent", at: (i: number) => VoiceFeatures, o: StepOptions = {}): Array<Array<Call>> => {
  const out: Array<Array<Call>> = []
  for (let i = 0; i < n; i++) out.push(frame(r, mode, { ...o, [who]: at(i) }))
  return out
}

/** The syllable at frame `i`: onset 1 on exactly the frames in `at`, else 0. */
const syllables = (at: ReadonlyArray<number>, base: Partial<VoiceFeatures> = {}) => (i: number): VoiceFeatures => voice({ ...base, onset: at.includes(i) ? 1 : 0 })

/** The points of the "dots" style: squares (under a pixel and a tenth) and circles, drawn before anything is stroked. */
const dots = (calls: ReadonlyArray<Call>): Array<Pt> => {
  const out: Array<Pt> = []
  for (const c of calls) {
    if (c.name === "=strokeStyle") break
    if (c.name === "rect") {
      const w = c.args[2] as number
      out.push({ x: (c.args[0] as number) + w / 2, y: (c.args[1] as number) + w / 2, r: w / 2 })
    } else if (c.name === "arc" && c.args[4] === TAU) out.push({ x: c.args[0] as number, y: c.args[1] as number, r: c.args[2] as number })
  }
  return out
}
/** Line segments (a `moveTo` and the `lineTo` after it), for the dashes and the spines (and the streaks, when there are any). */
const segments = (calls: ReadonlyArray<Call>): Array<{ readonly from: readonly [number, number]; readonly to: readonly [number, number] }> => {
  const out: Array<{ from: readonly [number, number]; to: readonly [number, number] }> = []
  let from: readonly [number, number] | null = null
  for (const c of calls) {
    if (c.name === "moveTo") from = [c.args[0] as number, c.args[1] as number]
    else if (c.name === "lineTo" && from !== null) {
      out.push({ from, to: [c.args[0] as number, c.args[1] as number] })
      from = null
    }
  }
  return out
}
/**
 * The head of each streak, with how many segments its path had. With the "dashes" style the points are lines, so
 * the circles in a frame are the streaks' heads (and the reduced-motion fan's).
 */
const heads = (calls: ReadonlyArray<Call>): Array<{ readonly x: number; readonly y: number; readonly segments: number }> => {
  const out: Array<{ x: number; y: number; segments: number }> = []
  let lines = 0
  let last = 0
  for (const c of calls) {
    if (c.name === "beginPath") lines = 0
    else if (c.name === "lineTo") lines++
    else if (c.name === "stroke") last = lines
    else if (c.name === "arc") out.push({ x: c.args[0] as number, y: c.args[1] as number, segments: last })
  }
  return out
}

const dist = (p: { readonly x: number; readonly y: number }) => Math.hypot(p.x - CX, p.y - CY)
const mean = (xs: ReadonlyArray<number>) => xs.reduce((s, x) => s + x, 0) / xs.length
/** How far the farthest point is from the sphere's middle. */
const extent = (pts: ReadonlyArray<Pt>) => Math.max(...pts.map(dist))
const key = (p: { readonly x: number; readonly y: number }) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`
const count = (calls: ReadonlyArray<Call>, name: string) => calls.filter((c) => c.name === name).length

beforeEach(() => {
  recording.log = null
})

describe("particle sphere: how many points", () => {
  const n = (stored: Stored, size: readonly [number, number] = [W, H], mode: Mode = "idle", o: StepOptions = {}) => dots(settle(make(stored, size), mode, 10, { reduced: true, ...o })).length

  it("'Points' sets the count: half as many at 0.5×, twice as many at 2×", () => {
    const one = n({})
    expect(one).toBeGreaterThan(100)
    expect(n({ density: 0.5 }) / one).toBeCloseTo(0.5, 1)
    expect(n({ density: 2 }) / one).toBeCloseTo(2, 1)
  })

  it("a bigger canvas gets more points, within 300 to 1100 at 1× and never above 2200", () => {
    const small = n({}, [160, 140])
    const stage = n({}, [1600, 1200])
    expect(small).toBeLessThan(n({}))
    expect(small).toBeGreaterThanOrEqual(0.9 * 300 * 0.42)
    expect(stage).toBeGreaterThan(small)
    expect(stage).toBeLessThanOrEqual(1100)
    expect(n({ density: 2 }, [1600, 1200])).toBeLessThanOrEqual(2200)
    expect(n({ density: 2 }, [1600, 1200])).toBeGreaterThan(1.8 * stage)
  })

  it("a deep voice shows fewer, heavier points; a child's voice shows every point as fine dust", () => {
    const grain = (v: Partial<VoiceFeatures>) => {
      const pts = dots(settle(make(), "thinking", 400, { reduced: true, agent: voice(v) }))
      return { n: pts.length, size: mean(pts.map((p) => p.r)) }
    }
    const deep = grain(DEEP)
    const high = grain(HIGH)
    expect(high.n / deep.n).toBeCloseTo(1 / 0.42, 1)
    expect(deep.size).toBeGreaterThan(high.size * 1.5)
  })

  it("'Pitch character: 0' makes a deep and a high voice the same grain", () => {
    const at = (v: Partial<VoiceFeatures>, pitch: number) => dots(settle(make({ pitch }), "thinking", 400, { reduced: true, agent: voice(v) }))
    expect(at(DEEP, 0)).toEqual(at(HIGH, 0))
    expect(at(DEEP, 1)).not.toEqual(at(HIGH, 1))
  })
})

describe("particle sphere: size", () => {
  const radius = (mode: Mode, stored: Stored = {}, o: StepOptions = {}) => extent(dots(settle(make(stored), mode, 10, { reduced: true, ...o })))

  it("each mode has its own size: a small sphere at rest, the largest while speaking", () => {
    const idle = radius("idle")
    expect(idle).toBeLessThan(radius("thinking"))
    expect(radius("thinking")).toBeLessThan(radius("listening"))
    expect(radius("listening")).toBeLessThan(radius("speaking", {}, { agent: quiet }))
  })

  it("'Size' scales the sphere (the points stay as visible as they can: they shrink less than in proportion)", () => {
    const half = radius("listening", { size: 0.5 })
    const full = radius("listening", { size: 1 })
    expect(half / full).toBeGreaterThan(0.45)
    expect(half / full).toBeLessThan(0.58)
    const sizeOf = (size: number) => mean(dots(settle(make({ size }), "listening", 10, { reduced: true })).map((p) => p.r))
    expect(sizeOf(0.5) / sizeOf(1)).toBeGreaterThan(0.5)
  })

  it("a louder voice swells the sphere", () => {
    const at = (level: number) => radius("speaking", {}, { agent: voice({ level }) })
    expect(at(0.9)).toBeGreaterThan(at(0.1) * 1.05)
  })

  it("a syllable's onset swells the whole sphere for a moment, and not under reduced motion", () => {
    const sizes = (reduced: boolean) => {
      const frames = run(make(), "hearing", 80, "user", syllables([60]), { reduced })
      return frames.map((c) => extent(dots(c)))
    }
    const live = sizes(false)
    expect(live[60]!).toBeGreaterThan(live[59]! * 1.03)
    expect(live[79]!).toBeCloseTo(live[59]!, 0)
    const still = sizes(true)
    expect(still[60]!).toBeCloseTo(still[59]!, 6)
  })
})

describe("particle sphere: the spectrum displaces the surface by latitude", () => {
  const reach = (mode: "hearing" | "speaking", bands: Float32Array | undefined, stored: Stored = {}) => {
    const v = voice(bands === undefined ? {} : { bands })
    const pts = dots(settle(make(stored), mode, 90, { reduced: true, ...(mode === "hearing" ? { user: v } : { agent: v }) }))
    return { bottom: Math.max(...pts.map((p) => p.y)) - CY, top: CY - Math.min(...pts.map((p) => p.y)) }
  }

  it("low bands move the bottom of the sphere and high bands the top (band 0 at the bottom pole, band 23 at the top)", () => {
    const low = reach("speaking", bandsIn(0, 3))
    const high = reach("speaking", bandsIn(20, 23))
    const flat = reach("speaking", undefined)
    expect(low.bottom).toBeGreaterThan(high.bottom + 3)
    expect(high.top).toBeGreaterThan(low.top + 3)
    expect(low.bottom).toBeGreaterThan(flat.bottom + 3)
    expect(high.top).toBeGreaterThan(flat.top + 3)
  })

  it("'Voice relief: 0' leaves the spectrum without effect", () => {
    const at = (bands: Float32Array, relief: number) => dots(settle(make({ relief }), "speaking", 90, { reduced: true, agent: voice({ bands }) }))
    expect(at(bandsIn(0, 3), 0)).toEqual(at(bandsIn(20, 23), 0))
    expect(at(bandsIn(0, 3), 1)).not.toEqual(at(bandsIn(20, 23), 1))
  })

})

describe("particle sphere: the streaks", () => {
  /** The "dashes" style, so the only circles are streak heads. */
  const streak = (mode: Mode, n: number, who: "user" | "agent", at: (i: number) => VoiceFeatures, stored: Stored = {}, o: StepOptions = {}) => run(make({ points: "dashes", ...stored }), mode, n, who, at, o).map(heads)

  it("none while idle or thinking", () => {
    for (const mode of ["idle", "thinking"] as const) {
      const frames = streak(mode, 120, "user", () => voice())
      expect(frames.every((h) => h.length === 0), mode).toBe(true)
    }
  })

  it("while listening a few particles drift in on a slow spiral, even in silence", () => {
    const frames = streak("listening", 180, "user", () => quiet)
    expect(frames[179]!.length).toBeGreaterThan(3)
    expect(frames[179]!.length).toBeLessThan(25)
    expect(frames[179]!.every((h) => h.segments === 5)).toBe(true)
  })

  it("incoming particles are curved paths (five segments), outgoing ones straight rays (one)", () => {
    const hearing = streak("hearing", 40, "user", syllables([2]))
    const speaking = streak("speaking", 40, "agent", syllables([2]))
    expect(hearing[10]!.length).toBeGreaterThan(5)
    expect(speaking[10]!.length).toBeGreaterThan(5)
    expect(hearing[10]!.every((h) => h.segments === 5)).toBe(true)
    expect(speaking[10]!.every((h) => h.segments === 1)).toBe(true)
  })

  it("they fly in while taking in and out while speaking", () => {
    const hearing = streak("hearing", 40, "user", syllables([2]))
    const speaking = streak("speaking", 40, "agent", syllables([2]))
    // Right after the syllable: those coming in start outside the sphere, those going out start at its surface.
    expect(mean(hearing[4]!.map(dist))).toBeGreaterThan(mean(speaking[4]!.map(dist)))
    // And they move: inward for the first, outward for the second.
    expect(mean(hearing[14]!.map(dist))).toBeLessThan(mean(hearing[4]!.map(dist)))
    expect(mean(speaking[14]!.map(dist))).toBeGreaterThan(mean(speaking[4]!.map(dist)))
  })

  it("a syllable's onset sends a burst, bigger when louder: fast speech fills the air", () => {
    const after = (level: number) => streak("speaking", 8, "agent", syllables([2], { level }))[7]!.length
    expect(after(0.9)).toBeGreaterThan(after(0.2) + 8)
    // A held onset sends no more bursts.
    const held = streak("speaking", 8, "agent", (i) => voice({ level: 0.5, onset: i >= 2 ? 1 : 0 }))[7]!.length
    const once = streak("speaking", 8, "agent", syllables([2], { level: 0.5 }))[7]!.length
    expect(held).toBe(once)
  })

  it("a louder voice streams more", () => {
    const at = (level: number) => streak("hearing", 90, "user", () => voice({ level }))[89]!.length
    expect(at(0.9)).toBeGreaterThan(at(0.1))
  })

  it("'Streams: 0' turns them off in every mode, under reduced motion too; 2× sends more", () => {
    for (const mode of ["listening", "hearing", "speaking"] as const) {
      const who = mode === "speaking" ? "agent" : "user"
      expect(streak(mode, 60, who, syllables([2, 20]), { streams: 0 }).every((h) => h.length === 0), mode).toBe(true)
      expect(streak(mode, 20, who, () => voice(), { streams: 0 }, { reduced: true }).every((h) => h.length === 0), `${mode} reduced`).toBe(true)
    }
    const amount = (streams: number) => streak("hearing", 90, "user", () => voice({ level: 0.5 }), { streams })[89]!.length
    expect(amount(2)).toBeGreaterThan(amount(1))
    expect(amount(1)).toBeGreaterThan(amount(0.3))
  })

  describe("under reduced motion", () => {
    const fan = (mode: Mode, v: VoiceFeatures, stored: Stored = {}) => heads(settle(make({ points: "dashes", ...stored }), mode, 30, { reduced: true, user: v, agent: v }))

    it("nothing streams; a fan of streaks shows the direction while listening, hearing and speaking, and none while idle or thinking", () => {
      for (const mode of ["listening", "hearing", "speaking"] as const) expect(fan(mode, voice()).length, mode).toBeGreaterThan(0)
      expect(fan("idle", voice())).toHaveLength(0)
      expect(fan("thinking", voice())).toHaveLength(0)
    })

    it("the fan's size: 8 while listening, 10 plus up to 20 by the level while hearing or speaking, scaled by 'Streams' (at most 1.5×, at least 3)", () => {
      expect(fan("listening", quiet)).toHaveLength(8)
      expect(fan("hearing", quiet)).toHaveLength(10)
      expect(fan("speaking", quiet)).toHaveLength(10)
      expect(fan("speaking", voice({ level: 1 })).length).toBeGreaterThan(14)
      expect(fan("listening", quiet, { streams: 2 })).toHaveLength(12)
      expect(fan("listening", quiet, { streams: 0.5 })).toHaveLength(4)
      expect(fan("listening", quiet, { streams: 0.1 })).toHaveLength(3)
    })

    it("heads toward the sphere while taking in, away from it while speaking", () => {
      const inHeads = mean(fan("hearing", quiet).map(dist))
      const outHeads = mean(fan("speaking", quiet).map(dist))
      expect(outHeads).toBeGreaterThan(inHeads * 1.1)
    })
  })
})

describe("particle sphere: point styles", () => {
  const style = (points: string, mode: Mode = "idle", o: StepOptions = {}) => settle(make({ points }), mode, 10, { reduced: true, ...o })

  it("dots are circles, dashes and spines are lines, and none of them draws the other's", () => {
    const d = style("dots")
    expect(dots(d).length).toBeGreaterThan(100)
    expect(segments(d)).toHaveLength(0)
    for (const s of ["dashes", "spines"]) {
      const calls = style(s)
      expect(dots(calls), s).toHaveLength(0)
      expect(segments(calls).length, s).toBeGreaterThan(100)
    }
  })

  it("every style puts one mark on each of the same points: a dash is centred on its point, a spine starts at it", () => {
    const at = new Set(dots(style("dots")).map(key))
    const dashCentres = segments(style("dashes")).map((s) => ({ x: (s.from[0] + s.to[0]) / 2, y: (s.from[1] + s.to[1]) / 2 }))
    const spineStarts = segments(style("spines")).map((s) => ({ x: s.from[0], y: s.from[1] }))
    expect(dashCentres).toHaveLength(at.size)
    expect(spineStarts).toHaveLength(at.size)
    // Squares are placed by their corner, so their centre may differ in the last digits: match within a hundredth of a pixel.
    const near = (p: { x: number; y: number }) => [...at].some((k) => { const [x, y] = k.split(",").map(Number); return Math.abs(x! - p.x) < 0.02 && Math.abs(y! - p.y) < 0.02 })
    expect(dashCentres.filter(near).length).toBeGreaterThan(0.99 * at.size)
    expect(spineStarts.filter(near).length).toBeGreaterThan(0.99 * at.size)
  })

  it("spines lengthen where the voice pushes the surface out", () => {
    // Streams off, so the only lines are the spines.
    const speaking = (level: number) => {
      const calls = settle(make({ points: "spines", streams: 0 }), "speaking", 90, { reduced: true, agent: voice({ level, bands: bandsIn(0, 23) }) })
      return mean(segments(calls).map((s) => Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1])))
    }
    expect(speaking(0.9)).toBeGreaterThan(speaking(0.05) * 1.5)
  })

})

describe("particle sphere: thinking", () => {
  it("gathers the points into rings that spin, with bigger points", () => {
    const idle = mean(dots(settle(make(), "idle", 10, { reduced: true })).map((p) => p.r))
    const think = mean(dots(settle(make(), "thinking", 10, { reduced: true })).map((p) => p.r))
    expect(think).toBeGreaterThan(idle * 1.3)
    const r = make()
    settle(r, "thinking", 60)
    const a = dots(frame(r, "thinking"))
    settle(r, "thinking", 30)
    expect(dots(frame(r, "thinking"))).not.toEqual(a)
  })
})

describe("particle sphere: the pointer", () => {
  /** The sphere's points a frame after the pointer did something; idle, so nothing but the pointer moves them. */
  const after = (pointer: ReadonlyArray<Pointer>, reduced = false, wait = 0) => {
    const r = make()
    settle(r, "idle", 30, { reduced })
    let last: Array<Call> = []
    for (const p of pointer) last = frame(r, "idle", { reduced, pointer: p })
    if (wait > 0) last = settle(r, "idle", wait, { reduced, pointer: pointer[pointer.length - 1]! })
    return dots(last)
  }
  const away: Pointer = { x: 0, y: 0, down: false, inside: false }
  const onSphere = (down: boolean): Pointer => ({ x: CX, y: CY, down, inside: true })
  const changed = (a: ReadonlyArray<Pt>, b: ReadonlyArray<Pt>) => {
    const before = new Set(a.map(key))
    return b.filter((p) => !before.has(key(p)))
  }

  it("a press sends a ripple across the surface from the finger: the points near it move, the far ones do not", () => {
    const calm = after([away])
    const pressed = after([onSphere(true)])
    const moved = changed(calm, pressed)
    expect(moved.length).toBeGreaterThan(5)
    const radius = extent(calm)
    expect(Math.max(...moved.map(dist))).toBeLessThan(0.8 * radius)
  })

  it("the ripple runs out: a couple of seconds later the sphere is as it would have been", () => {
    const calm = after([away, away], false, 150)
    const rippled = after([onSphere(true), away], false, 150)
    expect(rippled).toEqual(calm)
  })

  it("a press outside the sphere, or under reduced motion, sends no ripple", () => {
    expect(after([{ x: CX + 0.9 * W, y: CY, down: true, inside: true }])).toEqual(after([away]))
    expect(after([onSphere(true)], true)).toEqual(after([away], true))
  })

  it("hovering over the sphere lifts the points under the pointer; with the pointer away nothing moves", () => {
    const calm = after([away])
    const hovered = after([onSphere(false)])
    const moved = changed(calm, hovered)
    expect(moved.length).toBeGreaterThan(0)
    expect(Math.max(...moved.map(dist))).toBeLessThan(0.8 * extent(calm))
    // Under reduced motion the hover still lifts (it is a reaction, not motion of its own).
    expect(changed(after([away], true), after([onSphere(false)], true)).length).toBeGreaterThan(0)
  })
})

describe("particle sphere: glow", () => {
  it("'Glow: 0' draws no soft body of light behind the points; the default does", () => {
    const calls = (glow: number) => settle(make({ glow }), "listening", 10, { reduced: true })
    expect(count(calls(0), "fillRect")).toBe(0)
    expect(count(calls(1), "fillRect")).toBe(1)
  })
})
