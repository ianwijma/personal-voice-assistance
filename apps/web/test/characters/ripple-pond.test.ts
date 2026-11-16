/**
 * Ripple pond (src/characters/library/ripple-pond.ts): what only this character does, checked on the arcs it draws
 * on the recording canvas. The shared suites (compat, isolation) already cover its manifest, every mode and option
 * extreme, reduced-motion stillness and its recorded digest; this file covers the water itself: where rings start,
 * which way they run, how many crests they have and how far apart, how fast they travel, and what each option,
 * the pointer and the stage focus do to them.
 *
 * A ring is found by running the same scene twice, once with an event (an onset, a press, a moving pointer) and once
 * without, and keeping the stroked arcs only the first run drew: everything else on the canvas (rim, halo, reflection)
 * is identical in both runs and drops out.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Focus, Mode, OptionValues, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import pond from "@/characters/library/ripple-pond.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
/** The pool radius at size 1 on the W × H canvas: 0.45 of the height (the width allows 0.47 of 720). */
const R = H * 0.45
const DT = 1 / 60
/** Frames the scene runs before the event, so the voice level and the colours have settled. */
const SETTLE = 40

type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Pointer = { x: number; y: number; down: boolean; inside: boolean }
type Arc = { readonly x: number; readonly y: number; readonly r: number; readonly alpha: number }

beforeEach(() => {
  recording.log = null
})

const make = (stored: OptionValues = {}, size: readonly [number, number] = [W, H]) => {
  const r = new Runner(pond, document.createElement("canvas"), stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

const OFF: Pointer = { x: 0, y: 0, down: false, inside: false }

interface Drive {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly reduced?: boolean
  readonly pointer?: Pointer
  readonly focus?: Focus
}

/** One frame; returns the calls it made. */
const tick = (r: Runner, mode: Mode, o: Drive = {}): Array<Call> => {
  recording.log = []
  const quiet = createVoiceFeatures()
  r.step({ mode, dt: DT, user: o.user ?? quiet, agent: o.agent ?? quiet, palette: PALETTES.dark, reducedMotion: o.reduced === true, pointer: o.pointer ?? OFF, sinceInterrupt: Infinity, ...(o.focus !== undefined ? { focus: o.focus } : {}) })
  const calls = recording.log
  recording.log = null
  return calls
}

const voice = (o: { level?: number; onset?: number; register?: number; pitch?: number; sibilance?: number; syllableRate?: number } = {}): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.level = o.level ?? 0.5
  f.rms = f.level * 0.1
  f.low = f.mid = f.high = f.level
  f.onset = o.onset ?? 0
  f.register = o.register ?? f.register
  f.pitch = o.pitch ?? f.pitch
  f.sibilance = o.sibilance ?? 0
  f.syllableRate = o.syllableRate ?? 0
  return f
}

const alphaOf = (style: string): number => Number(style.match(/rgba\([^,]+,[^,]+,[^,]+,([\d.e-]+)\)/)?.[1] ?? Number.NaN)

/** The circles of one frame, on the canvas (through the transform set before them), that were stroked and that were filled. */
const circles = (calls: ReadonlyArray<Call>) => {
  let m = [1, 0, 0, 1, 0, 0]
  let arc: ReadonlyArray<unknown> | null = null
  let style = ""
  const stroked: Array<Arc> = []
  const filled: Array<Arc> = []
  for (const c of calls) {
    if (c.name === "setTransform") m = c.args as Array<number>
    else if (c.name === "beginPath") arc = null
    else if (c.name === "arc") arc = c.args
    else if (c.name === "=strokeStyle") style = String(c.args[0])
    else if ((c.name === "stroke" || c.name === "fill") && arc !== null) {
      const circle: Arc = { x: m[0]! * (arc[0] as number) + m[4]!, y: m[3]! * (arc[1] as number) + m[5]!, r: m[0]! * (arc[2] as number), alpha: alphaOf(style) }
      if (c.name === "stroke" && arc[3] === 0 && arc[4] === Math.PI * 2) stroked.push(circle)
      else if (c.name === "fill") filled.push(circle)
    }
  }
  return { stroked, filled }
}

const same = (a: Arc, b: Arc) => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 && Math.abs(a.r - b.r) < 1e-3

interface Scene {
  readonly mode: Mode
  readonly stored?: OptionValues
  readonly frames: number
  readonly reduced?: boolean
  /** The voice at frame `i`; `event` is true in the run that has the event. Used for both sides. */
  readonly voice?: (i: number, event: boolean) => VoiceFeatures
  readonly pointer?: (i: number, event: boolean) => Pointer
}

/** The stroked circles the event run draws in the last frame and the control run does not. */
const added = (s: Scene): Array<Arc> => {
  const last = (event: boolean) => {
    const r = make({ look: "lines", ...s.stored })
    let calls: Array<Call> = []
    for (let i = 0; i < s.frames; i++) {
      const v = s.voice?.(i, event) ?? voice()
      calls = tick(r, s.mode, { user: v, agent: v, ...(s.reduced === true ? { reduced: true } : {}), ...(s.pointer !== undefined ? { pointer: s.pointer(i, event) } : {}) })
    }
    return circles(calls).stroked
  }
  const control = last(false)
  return last(true).filter((a) => {
    const k = control.findIndex((b) => same(a, b))
    if (k < 0) return true
    control.splice(k, 1)
    return false
  })
}

/** A steady voice with a rising edge at the given frames (only in the run that has the event). */
const pulses = (at: ReadonlyArray<number>, o: Parameters<typeof voice>[0] = {}) => (i: number, event: boolean) => voice({ ...o, onset: event && at.includes(i) ? 1 : 0 })

/** The rings one onset drops, `after` frames old, in the "lines" look (one arc per crest). */
const ring = (mode: Mode, after: number, o: Parameters<typeof voice>[0] = {}, stored: OptionValues = {}) => added({ mode, frames: SETTLE + after + 1, stored, voice: pulses([SETTLE], o) })

const radii = (arcs: ReadonlyArray<Arc>) => arcs.map((a) => a.r).sort((a, b) => a - b)

describe("rings of a syllable (docs: one ring per syllable, inward while hearing, outward while speaking)", () => {
  it("while hearing, a ring starts at the wall and its crests run in toward the centre", () => {
    const born = ring("hearing", 0)
    const old = ring("hearing", 35)
    expect(born.length).toBeGreaterThan(0)
    for (const a of [...born, ...old]) expect([a.x, a.y]).toEqual([W / 2, H / 2])
    // The leading crest is the innermost one: it starts just outside the wall (1.02 R) and moves inward.
    expect(radii(born)[0]!).toBeCloseTo(1.02 * R, 3)
    expect(radii(old)[0]!).toBeLessThan(R)
  })

  it("while speaking, a ring starts at the centre and runs out past the wall", () => {
    const young = ring("speaking", 10)
    const old = ring("speaking", 180)
    // Outward rings start a hair off the centre, never further than 0.035 R / 2.
    for (const a of young) expect(Math.hypot(a.x - W / 2, a.y - H / 2)).toBeLessThanOrEqual(0.0175 * R * Math.SQRT2 + 1e-6)
    expect(radii(young).at(-1)!).toBeLessThan(R * 0.5)
    expect(radii(old).at(-1)!).toBeGreaterThan(R)
  })

  it("travels at 0.38 + 0.06 × syllable rate pool radii per second, times the speed option", () => {
    const speedOf = (o: Parameters<typeof voice>[0], stored: OptionValues = {}) => (radii(ring("hearing", 10, o, stored))[0]! - radii(ring("hearing", 40, o, stored))[0]!) / R / (30 * DT)
    expect(speedOf({ syllableRate: 0 })).toBeCloseTo(0.38, 2)
    expect(speedOf({ syllableRate: 5 })).toBeCloseTo(0.68, 2)
    expect(speedOf({ syllableRate: 20 })).toBeCloseTo(0.38 + 0.06 * 7, 2) // the rate is capped at 7 syllables a second
    expect(speedOf({ syllableRate: 0 }, { speed: 2 })).toBeCloseTo(0.76, 2)
  })

  it("has more crests when louder: 1 under 0.15, 2 under 0.4, 3 under 0.62, 4 above (at the middle wavelength)", () => {
    const crests = (level: number) => ring("hearing", 20, { level }).length
    expect([0.1, 0.3, 0.5, 0.8].map(crests)).toEqual([1, 2, 3, 4])
  })

  it("spaces the crests by a wavelength set by register and pitch: wide for a deep voice, fine for a child's", () => {
    const spacing = (v: number, stored: OptionValues = {}) => {
      const r = radii(ring("hearing", 20, { register: v, pitch: v }, stored))
      return { n: r.length, gap: r[1]! - r[0]! }
    }
    const deep = spacing(0)
    const child = spacing(1)
    expect(deep.gap).toBeCloseTo(0.2 * R, 3)
    expect(child.gap).toBeCloseTo(0.04 * R, 3)
    // A shorter wavelength packs more crests into the same packet.
    expect(child.n).toBeGreaterThan(deep.n)
    // Pitch reaction 0: every voice ripples alike, at the geometric middle.
    expect(spacing(0, { pitch: 0 }).gap).toBeCloseTo(spacing(1, { pitch: 0 }).gap, 6)
    expect(spacing(0, { pitch: 0 }).gap).toBeCloseTo(0.2 * Math.sqrt(0.2) * R, 3)
  })

  it("drops at most one ring per 70 ms, one per rising edge, and none for a whisper", () => {
    const rings = (at: ReadonlyArray<number>, o: Parameters<typeof voice>[0] = {}) => added({ mode: "hearing", frames: SETTLE + 30, voice: pulses(at, o) }).length
    const one = rings([SETTLE])
    expect(one).toBeGreaterThan(0)
    expect(rings([SETTLE, SETTLE + 3])).toBe(one) // 50 ms later: too soon
    expect(rings([SETTLE, SETTLE + 6])).toBe(2 * one) // 100 ms later: a second ring
    // An onset that stays high is one edge.
    const held = added({ mode: "hearing", frames: SETTLE + 30, voice: (i, event) => voice({ onset: event && i >= SETTLE ? 1 : 0 }) })
    expect(held.length).toBe(one)
    // Under a level of 0.03 nothing is heard.
    expect(rings([SETTLE], { level: 0.02 })).toBe(0)
  })

  it("drops no ring from a person's onsets while idle, listening or thinking (only hearing and speaking are 'on')", () => {
    for (const mode of ["idle", "listening", "thinking"] as const) expect(ring(mode, 20), mode).toEqual([])
  })

  it("reduced motion drops no rings, nor a press, nor a trail", () => {
    expect(added({ mode: "hearing", frames: SETTLE + 20, reduced: true, voice: pulses([SETTLE]) })).toEqual([])
    const press = (i: number, event: boolean): Pointer => ({ x: 410, y: 120, down: event && i === SETTLE, inside: event })
    expect(added({ mode: "idle", frames: SETTLE + 20, reduced: true, pointer: press })).toEqual([])
  })
})

describe("what the water does on its own", () => {
  const count = (frames: ReadonlyArray<number>, mode: Mode, reduced = false) => {
    const r = make({ look: "lines" })
    const out: Array<number> = []
    for (let i = 1; i <= Math.max(...frames); i++) {
      const calls = tick(r, mode, reduced ? { reduced } : {})
      if (frames.includes(i)) out.push(circles(calls).stroked.length)
    }
    return out
  }

  it("listening: a faint ring slides in about every 1.7 s", () => {
    const [before, still, first, second] = count([40, 90, 120, 220], "listening") as [number, number, number, number]
    expect(still).toBe(before)
    expect(first).toBe(before + 1)
    expect(second).toBe(before + 2)
  })

  it("listening with reduced motion keeps still: no ring comes in", () => {
    const [a, b] = count([40, 220], "listening", true)
    expect(b).toBe(a)
  })

  it("idle: after about 2 s a lone ring lands somewhere on the water, between 0.2 and 0.65 of the radius from the centre", () => {
    const r = make({ look: "lines" })
    let early: Array<Arc> = []
    let late: Array<Arc> = []
    for (let i = 1; i <= 150; i++) {
      const s = circles(tick(r, "idle")).stroked
      if (i === 60) early = s
      if (i === 150) late = s
    }
    const off = (a: Arc) => Math.hypot(a.x - W / 2, a.y - H / 2) > 1
    expect(early.filter(off)).toEqual([])
    const lone = late.filter(off)
    expect(lone).toHaveLength(1)
    const d = Math.hypot(lone[0]!.x - W / 2, lone[0]!.y - H / 2)
    expect(d).toBeGreaterThanOrEqual(0.2 * R - 0.01)
    expect(d).toBeLessThanOrEqual(0.65 * R + 0.01)
  })

  it("thinking: no rings, even with onsets; the whirlpool has two strokes per arm", () => {
    const arms = (n: number) => {
      const r = make({ arms: n })
      let calls: Array<Call> = []
      for (let i = 0; i < 40; i++) calls = tick(r, "thinking", { user: voice({ onset: i % 6 === 0 ? 1 : 0 }) })
      return calls
    }
    for (const n of [2, 3, 6]) {
      const calls = arms(n)
      expect(calls.filter((c) => c.name === "moveTo"), `${n} arms`).toHaveLength(2 * n)
      expect(circles(calls).stroked.filter((a) => a.r < R * 0.85)).toEqual([])
    }
  })
})

describe("sibilance fizz", () => {
  /** Tiny stroked circles (a fizz drop is about px1 × 1..6 wide) over a second of hearing. */
  const drops = (o: { sibilance: number; stored?: OptionValues; reduced?: boolean }) => {
    const r = make({ look: "lines", ...o.stored })
    let n = 0
    for (let i = 0; i < 60; i++) n += circles(tick(r, "hearing", { user: voice({ sibilance: o.sibilance }), ...(o.reduced === true ? { reduced: true } : {}) })).stroked.filter((a) => a.r < 8).length
    return n
  }

  it("pops tiny drops on 's' sounds, and only above a sibilance of 0.35", () => {
    expect(drops({ sibilance: 1 })).toBeGreaterThan(5)
    expect(drops({ sibilance: 0.3 })).toBe(0)
  })

  it("is switched off by the fizz option, and by reduced motion", () => {
    expect(drops({ sibilance: 1, stored: { fizz: false } })).toBe(0)
    expect(drops({ sibilance: 1, reduced: true })).toBe(0)
  })
})

describe("looks and options", () => {
  /** Arcs per ring of one onset at level 0.5 (3 crests) in each look. */
  const arcsPerRing = (look: string) => added({ mode: "hearing", frames: SETTLE + 20, stored: { look }, voice: pulses([SETTLE]) }).length

  it("draws a swell, a crest and a trough per crest in 'water' and 'soft', and the crest alone in 'lines'", () => {
    const crests = arcsPerRing("lines")
    expect(crests).toBe(3)
    expect(arcsPerRing("water")).toBe(3 * crests)
    expect(arcsPerRing("soft")).toBe(3 * crests)
  })

  it("the basin wall option draws or leaves out the wall; without it the lit edge still glows inside", () => {
    const wall = (on: boolean, mode: Mode) => {
      const r = make({ wall: on })
      let calls: Array<Call> = []
      for (let i = 0; i < SETTLE; i++) calls = tick(r, mode)
      return circles(calls).stroked
    }
    const at = (arcs: ReadonlyArray<Arc>, lo: number, hi: number) => arcs.filter((a) => a.r > lo && a.r <= hi)
    // Idle: the wall is the one stroke at the pool radius.
    expect(at(wall(true, "idle"), R - 0.01, R + 0.01)).toHaveLength(1)
    expect(at(wall(false, "idle"), R - 0.01, R + 0.01)).toHaveLength(0)
    // Listening without the wall: no wall, but a halo just inside the edge.
    expect(at(wall(false, "listening"), R - 0.01, R + 0.01)).toHaveLength(0)
    expect(at(wall(false, "listening"), R - 8, R - 0.01).length).toBeGreaterThan(0)
  })

  it("the size option scales the basin; at 1 it takes 0.45 of the height and never overflows the width", () => {
    const pool = (stored: OptionValues, size: readonly [number, number]) => {
      const r = make(stored, size)
      let calls: Array<Call> = []
      for (let i = 0; i < 5; i++) calls = tick(r, "idle")
      return Math.max(...circles(calls).filled.map((a) => a.r))
    }
    expect(pool({}, [W, H])).toBeCloseTo(0.45 * H, 6)
    expect(pool({ size: 0.5 }, [W, H])).toBeCloseTo(0.225 * H, 6)
    expect(pool({}, [100, 300])).toBeCloseTo(0.47 * 100, 6) // a narrow cell: the width limits
    expect(pool({}, [160, 140])).toBeCloseTo(0.45 * 140, 6)
  })

  it("ring strength scales the brightness of the crests with reduced motion's still rings (capped at 1)", () => {
    const strongest = (strength: number) => {
      const r = make({ look: "lines", strength })
      let calls: Array<Call> = []
      for (let i = 0; i < SETTLE; i++) calls = tick(r, "hearing", { user: voice({ level: 0.5 }), reduced: true })
      return Math.max(...circles(calls).stroked.filter((a) => a.r < 0.85 * R && a.alpha > 0.001).map((a) => a.alpha))
    }
    const base = strongest(1)
    expect(strongest(0.3)).toBeCloseTo(base * 0.3, 2)
    expect(strongest(2)).toBe(1)
  })
})

describe("reduced motion: a still ring set per mode", () => {
  /** The still crests: stroked circles well inside the water (the wall and the lit halo just inside it are further out, the drop's crown at the centre is smaller, the idle reflection is a partial arc, not a circle). */
  const still = (mode: Mode, level: number) => {
    const r = make({ look: "lines" })
    let calls: Array<Call> = []
    for (let i = 0; i < SETTLE; i++) calls = tick(r, mode, { user: voice({ level }), agent: voice({ level }), reduced: true })
    return circles(calls)
      .stroked.filter((a) => a.r > 0.13 * R && a.r < 0.85 * R && a.alpha > 0.001)
      .sort((a, b) => a.r - b.r)
  }

  it("shows no crests when idle, one when listening, and two to five when hearing or speaking by loudness in thirds", () => {
    expect(still("idle", 0)).toHaveLength(0)
    expect(still("listening", 0)).toHaveLength(1)
    expect([0, 0.5, 1].map((level) => still("hearing", level).length)).toEqual([2, 4, 5])
    expect([0, 0.5, 1].map((level) => still("speaking", level).length)).toEqual([2, 4, 5])
  })

  it("puts the strongest crest innermost while taking sound in, outermost while speaking", () => {
    const inward = still("hearing", 0.5).map((a) => a.alpha)
    const outward = still("speaking", 0.5).map((a) => a.alpha)
    expect(inward).toEqual([...inward].sort((a, b) => b - a))
    expect(outward).toEqual([...outward].sort((a, b) => a - b))
    expect(new Set(inward).size).toBe(inward.length)
  })
})

describe("the pointer (a press drops a strong ring, moving trails small ones)", () => {
  const FINGER = { x: 410, y: 120 }
  const press = (until: number) => (i: number, event: boolean): Pointer => ({ ...FINGER, down: event && i >= SETTLE && i < until, inside: event && i >= SETTLE })

  it("a press on the water drops a ring centred where the finger is", () => {
    const rings = added({ mode: "idle", frames: SETTLE + 20, pointer: press(SETTLE + 1) })
    expect(rings.length).toBeGreaterThan(0)
    for (const a of rings) {
      expect(a.x).toBeCloseTo(FINGER.x, 3)
      expect(a.y).toBeCloseTo(FINGER.y, 3)
    }
  })

  it("holding the press drops no more rings than the press itself", () => {
    const once = added({ mode: "idle", frames: SETTLE + 20, pointer: press(SETTLE + 1) })
    const held = added({ mode: "idle", frames: SETTLE + 20, pointer: press(SETTLE + 20) })
    expect(held).toHaveLength(once.length)
  })

  it("a press outside the water, or one the page says is not over the stage, drops nothing", () => {
    const outside = (i: number, event: boolean): Pointer => ({ x: 700, y: 10, down: event && i === SETTLE, inside: event })
    expect(added({ mode: "idle", frames: SETTLE + 20, pointer: outside })).toEqual([])
    const away = (i: number, event: boolean): Pointer => ({ ...FINGER, down: event && i === SETTLE, inside: false })
    expect(added({ mode: "idle", frames: SETTLE + 20, pointer: away })).toEqual([])
  })

  it("moving over the water trails a small ring about every 0.12 R of travel, and standing still drops none", () => {
    // 10 px a frame for 10 frames (100 px, R × 0.12 = 13 px a ring), then still.
    const swipe = (i: number, event: boolean): Pointer => ({ x: 300 + 10 * Math.min(i, 9), y: 120, down: false, inside: event })
    const after = (frames: number) => added({ mode: "idle", frames, pointer: swipe })
    const moving = after(12)
    expect(moving.length).toBeGreaterThanOrEqual(4)
    expect(moving.length).toBeLessThanOrEqual(6)
    expect(new Set(moving.map((a) => Math.round(a.x))).size).toBe(moving.length)
    expect(after(30)).toHaveLength(moving.length)
  })
})

describe("on the whole stage", () => {
  const BOX: Focus = { x: 280, y: 200, width: 720, height: 240 }

  it("centres the basin on the focus and sizes it by the focus, following it between frames without a resize", () => {
    const r = make({}, [1280, 800])
    const pool = (focus: Focus) => {
      let calls: Array<Call> = []
      for (let i = 0; i < 5; i++) calls = tick(r, "idle", { focus })
      const p = circles(calls).filled.sort((a, b) => b.r - a.r)[0]!
      return { x: p.x, y: p.y, r: p.r }
    }
    const a = pool(BOX)
    expect(a.x).toBeCloseTo(BOX.x + BOX.width / 2, 6)
    expect(a.y).toBeCloseTo(BOX.y + BOX.height / 2, 6)
    expect(a.r).toBeCloseTo(0.45 * BOX.height, 6)
    const moved: Focus = { x: 100, y: 50, width: 300, height: 400 }
    const b = pool(moved)
    expect(b.x).toBeCloseTo(250, 6)
    expect(b.y).toBeCloseTo(250, 6)
    expect(b.r).toBeCloseTo(0.47 * moved.width, 6)
  })
})

describe("review fixes", () => {
  it("never draws an arc with a negative radius, even on a 1 × 1 focus (the fake canvas would hide it with abs)", () => {
    for (const mode of ["idle", "listening", "hearing", "thinking", "speaking"] as const) {
      for (const reduced of [false, true]) {
        const r = make({}, [1, 1])
        const calls: Array<Call> = []
        for (let i = 0; i < 60; i++) {
          const v = voice({ level: 0.8, onset: i % 6 === 0 ? 1 : 0, sibilance: 1 })
          calls.push(...tick(r, mode, { user: v, agent: v, reduced, focus: { x: 0, y: 0, width: 1, height: 1 } }))
        }
        const arcs = calls.filter((c) => c.name === "arc")
        expect(arcs.length, mode).toBeGreaterThan(0)
        for (const c of arcs) expect(c.args[2] as number, `${mode} reduced=${reduced}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it("a focus that moves under a resting pointer is not pointer travel: no trail ring", () => {
    const rings = (moveFocus: boolean) => {
      const r = make({ look: "lines" }, [1280, 800])
      let calls: Array<Call> = []
      for (let i = 0; i < 60; i++) {
        const focus: Focus = moveFocus && i >= 50 ? { x: 260, y: 200, width: 720, height: 240 } : { x: 280, y: 200, width: 720, height: 240 }
        calls = tick(r, "idle", { focus, pointer: { x: 640, y: 320, down: false, inside: true } })
      }
      return circles(calls).stroked.length
    }
    expect(rings(true)).toBe(rings(false))
  })

  it("reduced motion clears rings in flight: they do not come back when motion is allowed again", () => {
    const last = (event: boolean) => {
      const r = make({ look: "lines" })
      let calls: Array<Call> = []
      for (let i = 0; i < SETTLE + 20; i++) {
        const v = voice({ onset: event && i === SETTLE ? 1 : 0 })
        calls = tick(r, "hearing", { user: v, agent: v, reduced: i >= SETTLE + 10 && i < SETTLE + 15 })
      }
      return circles(calls).stroked
    }
    expect(last(true)).toHaveLength(last(false).length)
  })

  it("reduced motion holds a calm pose while the live level keeps changing inside one third", () => {
    for (const mode of ["hearing", "speaking"] as const) {
      const frame = (level: number) => {
        const r = make({ look: "lines" })
        let calls: Array<Call> = []
        for (let i = 0; i < SETTLE; i++) calls = tick(r, mode, { user: voice({ level }), agent: voice({ level }), reduced: true })
        // Hearing also lights the rim by level (a separate smoothing); the centre mound is what the still pose pins down.
        return JSON.stringify(mode === "speaking" ? calls : circles(calls).filled)
      }
      expect(frame(0.47), mode).toBe(frame(0.5))
    }
  })
})
