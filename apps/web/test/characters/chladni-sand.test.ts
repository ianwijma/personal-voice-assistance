/**
 * Chladni sand, the behaviour that is its own (the shared suites in `compat.test.ts`, `baseline.test.ts` and
 * `isolation.test.ts` already run it through the manifest, the modes, the option extremes, reduced-motion stillness,
 * the digest and the stage checks): that the sand really lies on the nodal lines of the figure the voice asks for
 * (a deep voice a cross, a child's a lattice; the plate, the figure range and the spiral change which), the number of
 * grains, the plate and its rim and driver, the fronts a syllable or a press sends, the shaking, and what reduced
 * motion does instead of hopping. Checked on the calls it makes, through the runner, on the recording canvas.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Mode, Palette, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import chladniSand from "@/characters/library/chladni-sand.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
const CX = W / 2
const CY = H / 2
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Pointer = { readonly x: number; readonly y: number; readonly down: boolean; readonly inside: boolean }
type Stored = Record<string, number | boolean | string>
/** A grain in plate coordinates: −1..1 across the plate, y down. */
type Grain = { readonly u: number; readonly v: number; readonly size: number }

const make = (stored: Stored = {}, size: readonly [number, number] = [W, H]) => {
  const canvas = document.createElement("canvas")
  const r = new Runner(chladniSand, canvas, stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

/** A voice that is sounding now: loud, voiced, mid register and pitch, and no syllable starting unless `onset` says so. */
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

/** The plate: the first rounded rectangle of a frame (the rim is drawn on the same one). */
const plate = (calls: ReadonlyArray<Call>) => {
  const c = calls.find((x) => x.name === "roundRect")!
  const [x, y, w, , r] = c.args as [number, number, number, number, number]
  return { x, y, side: w, radius: r, cx: x + w / 2, cy: y + w / 2 }
}
/** The sand: every `rect` of a frame, in plate coordinates. */
const grains = (calls: ReadonlyArray<Call>): Array<Grain> => {
  const p = plate(calls)
  return calls
    .filter((c) => c.name === "rect")
    .map((c) => {
      const [x, y, w] = c.args as [number, number, number, number]
      return { u: (x + w / 2 - p.cx) / (p.side / 2), v: (y + w / 2 - p.cy) / (p.side / 2), size: w }
    })
}
/** The faint rings of the fronts: circles drawn inside the plate's clip (the driver's are not clipped). */
const rings = (calls: ReadonlyArray<Call>): Array<{ readonly x: number; readonly y: number; readonly r: number }> => {
  const out: Array<{ x: number; y: number; r: number }> = []
  let clipped = false
  for (const c of calls) {
    if (c.name === "clip") clipped = true
    else if (c.name === "restore") clipped = false
    else if (c.name === "arc" && clipped) out.push({ x: c.args[0] as number, y: c.args[1] as number, r: c.args[2] as number })
  }
  return out
}
/** The driver puck and its ring: circles outside the clip. */
const driver = (calls: ReadonlyArray<Call>): Array<number> => {
  const out: Array<number> = []
  let clipped = false
  for (const c of calls) {
    if (c.name === "clip") clipped = true
    else if (c.name === "restore") clipped = false
    else if (c.name === "arc" && !clipped) out.push(c.args[2] as number)
  }
  return out
}
const count = (calls: ReadonlyArray<Call>, name: string) => calls.filter((c) => c.name === name).length
const mean = (xs: ReadonlyArray<number>) => xs.reduce((s, x) => s + x, 0) / xs.length

// ---- The figures, as the header of the character defines them (square plate: f = cos(nX)cos(mY) − s·cos(mX)cos(nY),
// X and Y from 0 to π across the plate; round plate: f = cos(aθ)·cos(bπr)); the sand lies where f = 0.
const FIG: ReadonlyArray<readonly [n: number, m: number, s: number]> = [
  [1, 2, 1], [1, 3, -1], [2, 3, 1], [1, 4, 1], [3, 4, -1], [2, 5, 1], [1, 6, -1], [3, 5, 1], [2, 7, -1], [4, 5, 1], [3, 7, 1], [5, 6, -1]
]
const ROUND: ReadonlyArray<readonly [a: number, b: number]> = [[1, 1], [2, 1], [0, 2], [3, 1], [1, 2], [2, 2], [4, 1], [3, 2], [0, 3], [4, 2], [2, 3], [3, 3]]
const square = (k: number, g: Grain): number => {
  const [n, m, s] = FIG[k]!
  const X = ((g.u + 1) * Math.PI) / 2
  const Y = ((g.v + 1) * Math.PI) / 2
  return Math.cos(n * X) * Math.cos(m * Y) - s * Math.cos(m * X) * Math.cos(n * Y)
}
const round = (k: number, g: Grain): number => {
  const [a, b] = ROUND[k]!
  return Math.cos(a * Math.atan2(g.v, g.u)) * Math.cos(b * Math.PI * Math.hypot(g.u, g.v))
}
const spiral = (g: Grain): number => {
  const r = Math.hypot(g.u, g.v)
  return Math.sin(7 * r - 3 * Math.atan2(g.v, g.u))
}
/** The share of the sand within 0.1 of a nodal line of `f` (a uniform scatter has well under a third there). */
const onLines = (gs: ReadonlyArray<Grain>, f: (g: Grain) => number) => gs.filter((g) => Math.abs(f(g)) < 0.1).length / gs.length
const mostAbs = (gs: ReadonlyArray<Grain>, f: (g: Grain) => number) => mean(gs.map((g) => Math.abs(f(g))))

beforeEach(() => {
  recording.log = null
})

describe("chladni sand: the sand lies on the nodal lines of the figure the voice picks", () => {
  /** Reduced motion places the sand straight into the settled figure, so the figure can be read at once. */
  const sand = (v: Partial<VoiceFeatures>, stored: Stored = {}, mode: Mode = "speaking") => grains(settle(make(stored), mode, 5, { reduced: true, agent: voice(v), user: voice(v) }))

  it("a deep voice settles the sand on the simplest cross, a child's on a fine lattice", () => {
    const deep = sand(DEEP)
    const high = sand(HIGH)
    expect(onLines(deep, (g) => square(0, g))).toBeGreaterThan(0.85)
    expect(onLines(high, (g) => square(11, g))).toBeGreaterThan(0.85)
    // And each is far from the other's lines.
    expect(onLines(deep, (g) => square(11, g))).toBeLessThan(0.45)
    expect(onLines(high, (g) => square(0, g))).toBeLessThan(0.45)
  })

  it("the same goes while hearing: the person's voice picks the figure", () => {
    expect(onLines(sand(DEEP, {}, "hearing"), (g) => square(0, g))).toBeGreaterThan(0.85)
    expect(onLines(sand(HIGH, {}, "hearing"), (g) => square(11, g))).toBeGreaterThan(0.85)
  })

  it("'Figures' limits the range: 'Simple' never goes past figure 6, 'Intricate' never below figure 4", () => {
    expect(onLines(sand(HIGH, { detail: "simple" }), (g) => square(6, g))).toBeGreaterThan(0.85)
    expect(onLines(sand(DEEP, { detail: "intricate" }), (g) => square(4, g))).toBeGreaterThan(0.85)
    expect(onLines(sand(HIGH, { detail: "intricate" }), (g) => square(11, g))).toBeGreaterThan(0.85)
    expect(onLines(sand(DEEP, { detail: "simple" }), (g) => square(0, g))).toBeGreaterThan(0.85)
  })

  it("a round plate has round figures, diameters and rings, and its sand stays inside the circle", () => {
    const at = (k: number) => sand({ register: k / 11, pitch: k / 11 }, { plate: "round" })
    for (const k of [0, 1, 3, 4, 5, 6, 7, 8, 9, 10]) expect(onLines(at(k), (g) => round(k, g)), `round figure ${k}`).toBeGreaterThan(0.95)
    expect(onLines(at(0), (g) => round(5, g))).toBeLessThan(0.45)
    expect(Math.max(...at(5).map((g) => Math.hypot(g.u, g.v)))).toBeLessThanOrEqual(1)
    // On a square plate the sand reaches the corners.
    expect(Math.max(...sand(DEEP).map((g) => Math.hypot(g.u, g.v)))).toBeGreaterThan(1.1)
  })

  // BUG (see the pull request): on a round plate, under reduced motion, the sand of figures 2 (pure rings) and 11 (3 diameters, 3 rings)
  // is placed by 14 Newton steps that stall on the antinodes, where the gradient is nearly zero. A quarter to a half of the sand is
  // left off the lines (measured: 73 % and 52 % within 0.1 of a nodal line; every other figure on both plates: 100 %).
  it.fails("a round plate gathers all the sand on the lines of figure 2 and figure 11 under reduced motion", () => {
    for (const k of [2, 11]) expect(onLines(sand({ register: k / 11, pitch: k / 11 }, { plate: "round" }), (g) => round(k, g)), `round figure ${k}`).toBeGreaterThan(0.95)
  })

  it("thinking turns the plate into a spiral, whatever the voice was", () => {
    const think = sand(HIGH, {}, "thinking")
    expect(onLines(think, spiral)).toBeGreaterThan(0.6)
    expect(onLines(think, (g) => square(11, g))).toBeLessThan(0.45)
  })

  it("under reduced motion only the register counts: the melody does not change the figure", () => {
    const at = (v: Partial<VoiceFeatures>) => grains(settle(make(), "speaking", 5, { reduced: true, agent: voice(v) }))
    expect(at({ register: 0.5, pitch: 0 })).toEqual(at({ register: 0.5, pitch: 1 }))
    expect(at({ register: 0, pitch: 0.5 })).not.toEqual(at({ register: 1, pitch: 0.5 }))
  })

  it("a change of voice or mode puts the sand straight onto the new figure under reduced motion, and then holds it still", () => {
    const r = make()
    settle(r, "speaking", 5, { reduced: true, agent: voice(DEEP) })
    const switched = grains(frame(r, "speaking", { reduced: true, agent: voice(HIGH) }))
    expect(onLines(switched, (g) => square(11, g))).toBeGreaterThan(0.85)
    expect(grains(frame(r, "speaking", { reduced: true, agent: voice(HIGH) }))).toEqual(switched)
    const thinking = grains(frame(r, "thinking", { reduced: true }))
    expect(onLines(thinking, spiral)).toBeGreaterThan(0.6)
  })

  it("while it is shaken live, a deep voice's sand gathers on the cross and a child's on the lattice", () => {
    const live = (v: Partial<VoiceFeatures>) => grains(settle(make(), "speaking", 300, { agent: voice({ ...v, level: 0.3 }) }))
    const deep = live(DEEP)
    const high = live(HIGH)
    expect(mostAbs(deep, (g) => square(0, g))).toBeLessThan(mostAbs(deep, (g) => square(11, g)))
    expect(mostAbs(high, (g) => square(11, g))).toBeLessThan(mostAbs(high, (g) => square(0, g)))
  })
})

describe("chladni sand: the sand", () => {
  const amount = (stored: Stored, size: readonly [number, number] = [W, H]) => count(settle(make(stored, size), "idle", 3, { reduced: true }), "rect")

  it("'Amount of sand' sets the number of grains: 1120 on this box, between 700 and 2400 at 1×, up to twice that", () => {
    expect(amount({})).toBe(1120)
    expect(amount({ grains: 0.5 })).toBe(560)
    expect(amount({ grains: 2 })).toBe(2240)
    expect(amount({}, [160, 140])).toBe(700)
    expect(amount({}, [1600, 1200])).toBe(2400)
    expect(amount({ grains: 2 }, [1600, 1200])).toBe(4800)
  })

  it("'Grain size' scales each grain; a loud plate draws them bolder (up to 60 % at full)", () => {
    const size = (stored: Stored, level = 0) => grains(settle(make(stored), "hearing", 90, { user: voice({ level }) }))[0]!.size
    expect(size({ grainSize: 2 }) / size({ grainSize: 1 })).toBeCloseTo(2, 6)
    expect(size({}, 1) / size({}, 0)).toBeCloseTo(1.6, 1)
  })

  it("every grain stays on the plate, even at the largest shake and the loudest voice", () => {
    for (const plateKind of ["square", "round"]) {
      const calls = settle(make({ shake: 2, plate: plateKind }), "speaking", 200, { agent: voice({ level: 1, onset: 0 }) })
      for (const g of grains(calls)) {
        expect(Math.abs(g.u)).toBeLessThanOrEqual(1)
        expect(Math.abs(g.v)).toBeLessThanOrEqual(1)
      }
    }
  })

  it("a silent plate lets the sand rest where it is", () => {
    const r = make()
    settle(r, "idle", 10)
    const rest = grains(frame(r, "idle"))
    expect(grains(settle(r, "idle", 60))).toEqual(rest)
  })

  it("a loud voice shakes the sand harder when the figure changes, 'Shake' sets how hard, and a whisper barely stirs it", () => {
    // How far the sand travels over the 40 frames after the voice moves from a deep register to a child's.
    const travel = (level: number, shake: number) => {
      const r = make({ shake })
      settle(r, "speaking", 200, { agent: voice({ level, ...DEEP }) })
      let prev = grains(frame(r, "speaking", { agent: voice({ level, ...HIGH }) }))
      let total = 0
      for (let i = 0; i < 40; i++) {
        const cur = grains(frame(r, "speaking", { agent: voice({ level, ...HIGH }) }))
        total += mean(cur.map((g, j) => Math.hypot(g.u - prev[j]!.u, g.v - prev[j]!.v)))
        prev = cur
      }
      return total
    }
    const loud = travel(0.9, 1)
    expect(travel(0.9, 2)).toBeGreaterThan(loud * 1.4)
    expect(travel(0.9, 0)).toBeLessThan(loud * 0.6)
    expect(travel(0.05, 1)).toBeLessThan(loud * 0.6)
  })

  it("the sand is fainter at rest and bolder while the plate is shaken: its opacity follows the mode", () => {
    const alpha = (mode: Mode) => {
      const calls = settle(make(), mode, 10, { reduced: true })
      const i = calls.findIndex((c) => c.name === "rect")
      let j = i
      while (calls[j]!.name !== "=fillStyle") j--
      return Number(String(calls[j]!.args[0]).match(/,([\d.]+)\)$/)![1])
    }
    expect(alpha("idle")).toBeCloseTo(0.55, 2)
    expect(alpha("listening")).toBeCloseTo(0.85, 2)
    expect(alpha("hearing")).toBeCloseTo(0.95, 2)
    expect(alpha("thinking")).toBeCloseTo(0.9, 2)
    expect(alpha("speaking")).toBeCloseTo(0.95, 2)
  })
})

describe("chladni sand: the plate", () => {
  const geometry = (stored: Stored, size: readonly [number, number] = [W, H]) => plate(settle(make(stored, size), "idle", 3, { reduced: true }))

  it("is a square nearly as high as the box and centred on it; 'Size' scales it", () => {
    const full = geometry({})
    expect(full.side).toBeCloseTo(0.9 * H, 6)
    expect(full.cx).toBeCloseTo(CX, 6)
    expect(full.cy).toBeCloseTo(CY, 6)
    expect(geometry({ size: 0.5 }).side).toBeCloseTo(0.45 * H, 6)
    expect(geometry({}, [160, 140]).side).toBeCloseTo(0.9 * 140, 6)
    // A box narrower than it is high: the width limits it.
    expect(geometry({}, [200, 400]).side).toBeCloseTo(0.9 * 200, 6)
  })

  it("has slightly rounded corners when square and is a circle when round", () => {
    const sq = geometry({})
    expect(sq.radius).toBeCloseTo(0.06 * sq.side, 6)
    const rd = geometry({ plate: "round" })
    expect(rd.radius).toBeCloseTo(0.5 * rd.side, 6)
  })

  it("lights its rim while taking in: brighter and bolder with the person's voice, and only then", () => {
    const rim = (mode: Mode, level = 0) => {
      const calls = settle(make(), mode, 90, { user: voice({ level }), agent: voice({ level }) })
      return Number(calls.find((c) => c.name === "=lineWidth")!.args[0])
    }
    const base = rim("idle")
    expect(rim("listening")).toBeGreaterThan(base)
    expect(rim("hearing", 0.9)).toBeGreaterThan(rim("hearing", 0.05) * 1.2)
    expect(rim("hearing", 0.05)).toBeGreaterThan(rim("listening"))
    expect(rim("speaking", 0.9)).toBeCloseTo(base, 6)
    expect(rim("thinking")).toBeCloseTo(base, 6)
  })

  it("has a driver in the middle only while speaking, bigger with the reply's loudness", () => {
    for (const mode of ["idle", "listening", "hearing", "thinking"] as const) expect(driver(settle(make(), mode, 90, { user: voice(), agent: voice() })), mode).toHaveLength(0)
    const puck = (level: number) => driver(settle(make(), "speaking", 90, { agent: voice({ level }) }))
    expect(puck(0.05)).toHaveLength(2)
    expect(puck(0.9)[0]!).toBeGreaterThan(puck(0.05)[0]! * 1.5)
    // The ring around it is 1.6 times the puck.
    expect(puck(0.5)[1]! / puck(0.5)[0]!).toBeCloseTo(1.6, 6)
  })
})

describe("chladni sand: fronts", () => {
  const front = (mode: "hearing" | "speaking", n: number, at: (i: number) => VoiceFeatures, stored: Stored = {}) => run(make(stored), mode, n, mode === "hearing" ? "user" : "agent", at).map(rings)

  it("a syllable sends one ring: inward from the rim while hearing, outward from the centre while speaking", () => {
    const hear = front("hearing", 40, syllables([2]))
    const say = front("speaking", 40, syllables([2]))
    expect(hear[5]!).toHaveLength(1)
    expect(say[5]!).toHaveLength(1)
    expect(hear[20]![0]!.r).toBeLessThan(hear[5]![0]!.r)
    expect(say[20]![0]!.r).toBeGreaterThan(say[5]![0]!.r)
    // From the centre of the plate: the inward ring starts beyond the rim, the outward one at the middle.
    expect(hear[5]![0]!.x).toBeCloseTo(CX, 6)
    expect(hear[5]![0]!.y).toBeCloseTo(CY, 6)
    const half = (0.9 * H) / 2
    expect(hear[3]![0]!.r).toBeGreaterThan(1.3 * half) // beyond the rim, out at the corners
    expect(say[3]![0]!.r).toBeLessThan(0.2 * half)
  })

  it("a held onset sends one ring; a new rising edge sends another; a weak onset (under 0.55) none", () => {
    const held = front("speaking", 20, (i) => voice({ onset: i >= 2 ? 1 : 0 }))
    expect(held[15]!).toHaveLength(1)
    const twice = front("speaking", 30, syllables([2, 10]))
    expect(twice[15]!).toHaveLength(2)
    expect(front("speaking", 20, (i) => voice({ onset: i === 2 ? 0.5 : 0 }))[15]!).toHaveLength(0)
  })

  it("a ring is gone after a second, and at most five show at once", () => {
    expect(front("speaking", 90, syllables([2]))[80]!).toHaveLength(0)
    const burst = front("speaking", 60, syllables([2, 8, 14, 20, 26, 32, 38, 44]))
    expect(Math.max(...burst.map((r) => r.length))).toBe(5)
  })

  it("'Syllable fronts' off sends none, and neither does reduced motion", () => {
    expect(front("hearing", 40, syllables([2, 12]), { fronts: false }).every((r) => r.length === 0)).toBe(true)
    expect(front("speaking", 40, syllables([2, 12]), { fronts: false }).every((r) => r.length === 0)).toBe(true)
    const reduced = run(make(), "speaking", 40, "agent", syllables([2, 12]), { reduced: true }).map(rings)
    expect(reduced.every((r) => r.length === 0)).toBe(true)
  })

  it("a syllable of the other side's voice, or while not taking in or speaking, sends none", () => {
    expect(run(make(), "hearing", 20, "agent", syllables([2])).every((c) => rings(c).length === 0)).toBe(true)
    expect(run(make(), "listening", 20, "user", syllables([2])).every((c) => rings(c).length === 0)).toBe(true)
    expect(run(make(), "thinking", 20, "user", syllables([2])).every((c) => rings(c).length === 0)).toBe(true)
  })

  it("a press on the plate sends a ring out from the finger; a press off the plate, or under reduced motion, none", () => {
    const at = { x: CX + 60, y: CY - 20, down: true, inside: true }
    const pressed = run(make(), "idle", 12, "user", () => quiet, { pointer: at }).map(rings)
    expect(pressed[5]!).toHaveLength(1)
    expect(pressed[5]![0]!.x).toBeCloseTo(at.x, 3)
    expect(pressed[5]![0]!.y).toBeCloseTo(at.y, 3)
    expect(pressed[10]![0]!.r).toBeGreaterThan(pressed[5]![0]!.r)
    // Holding sends no second ring.
    expect(pressed[11]!).toHaveLength(1)
    const off = { x: CX + 0.9 * W / 2, y: CY, down: true, inside: true }
    expect(run(make(), "idle", 12, "user", () => quiet, { pointer: off }).every((c) => rings(c).length === 0)).toBe(true)
    expect(run(make(), "idle", 12, "user", () => quiet, { pointer: at, reduced: true }).every((c) => rings(c).length === 0)).toBe(true)
  })

  it("a ring shakes the sand it passes: a syllable disturbs the plate even when the voice is silent", () => {
    const r = make()
    settle(r, "idle", 10)
    const rest = grains(frame(r, "idle"))
    const shaken = run(r, "idle", 20, "user", () => quiet, { pointer: { x: CX, y: CY, down: true, inside: true } }).map(grains)
    expect(shaken[10]).not.toEqual(rest)
  })
})
