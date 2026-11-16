/**
 * Liquid blob, the behaviour that is its own (the shared suites in `compat.test.ts`, `baseline.test.ts` and
 * `isolation.test.ts` already run it through the manifest, the modes, the option extremes, reduced-motion stillness,
 * the digest and the stage checks): the voice's spectrum pressing the outline by angle, what a deep or a high voice does
 * to its shape, the droplets (one per syllable, where they come from, when there are none), the three finishes, the
 * size cap, the pointer, and what reduced motion shows instead of flight. Checked on the calls it makes, through the
 * runner, on the recording canvas.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { BAND_COUNT, type Mode, type Palette, type VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import liquidBlob from "@/characters/library/liquid-blob.ts"
import { TAU } from "@/characters/kit.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
/** The same value as `N` in the character: points on the outline. */
const N = 96
/** The blob's centre in a box (the character puts it 2 % of the height below the middle). */
const CX = W / 2
const CY = H / 2 + H * 0.02
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Pt = { readonly x: number; readonly y: number }
type Pointer = { readonly x: number; readonly y: number; readonly down: boolean; readonly inside: boolean }

const make = (stored: Record<string, number | boolean | string> = {}, size: readonly [number, number] = [W, H]) => {
  const canvas = document.createElement("canvas")
  const r = new Runner(liquidBlob, canvas, stored)
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

/** The outline's control points (the first `N` curve segments of a frame are the body, drawn before anything else that curves), box px. */
const outline = (calls: ReadonlyArray<Call>): Array<Pt> =>
  calls
    .filter((c) => c.name === "quadraticCurveTo")
    .slice(0, N)
    .map((c) => ({ x: c.args[0] as number, y: c.args[1] as number }))
/** Outline point `i` is at angle `i / N` of a turn, clockwise from the right (canvas y points down): N/4 is straight down, 3N/4 straight up. */
const DOWN = N / 4
const UP = (3 * N) / 4
const meanRadius = (o: ReadonlyArray<Pt>) => o.reduce((s, p) => s + Math.hypot(p.x - CX, p.y - CY), 0) / o.length
const meanY = (o: ReadonlyArray<Pt>) => o.reduce((s, p) => s + p.y, 0) / o.length

/** Full circles (the droplets, in whatever state; the highlight on the rim is an arc but not a full one). */
const drops = (calls: ReadonlyArray<Call>): Array<{ readonly x: number; readonly y: number; readonly r: number }> =>
  calls.filter((c) => c.name === "arc" && c.args[3] === 0 && c.args[4] === TAU).map((c) => ({ x: c.args[0] as number, y: c.args[1] as number, r: c.args[2] as number }))
/** How far a droplet is from the body's middle, in body radii. */
const reach = (calls: ReadonlyArray<Call>, d: { readonly x: number; readonly y: number }) => Math.hypot(d.x - CX, d.y - CY) / meanRadius(outline(calls))

const count = (calls: ReadonlyArray<Call>, name: string) => calls.filter((c) => c.name === name).length
const rgbOf = (css: string) => css.match(/rgba\((\d+),(\d+),(\d+),([\d.e-]+)\)/)!.slice(1).map(Number)

beforeEach(() => {
  recording.log = null
})

describe("liquid blob: the spectrum presses the outline by angle", () => {
  const edge = (mode: "hearing" | "speaking", bands: Float32Array | undefined) => {
    const v = voice(bands === undefined ? {} : { bands })
    const calls = settle(make(), mode, 90, { reduced: true, ...(mode === "hearing" ? { user: v } : { agent: v }) })
    const o = outline(calls)
    return { bottom: o[DOWN]!.y - CY, top: CY - o[UP]!.y }
  }

  it("low bands move the bottom of the outline and high bands the top (band 0 down, band 23 up)", () => {
    const low = edge("speaking", bandsIn(0, 3))
    const high = edge("speaking", bandsIn(20, 23))
    expect(low.bottom).toBeGreaterThan(high.bottom + 3)
    expect(high.top).toBeGreaterThan(low.top + 3)
  })

  it("while speaking the spectrum swells the outline out; while hearing it presses dents in", () => {
    const flat = edge("speaking", undefined)
    expect(edge("speaking", bandsIn(0, 3)).bottom).toBeGreaterThan(flat.bottom + 3)
    expect(edge("speaking", bandsIn(20, 23)).top).toBeGreaterThan(flat.top + 3)
    const still = edge("hearing", undefined)
    expect(edge("hearing", bandsIn(0, 3)).bottom).toBeLessThan(still.bottom - 2)
    expect(edge("hearing", bandsIn(20, 23)).top).toBeLessThan(still.top - 2)
  })

  it("'Voice relief: 0' leaves the outline as the loudness alone makes it, whatever the spectrum", () => {
    const at = (bands: Float32Array) => outline(settle(make({ relief: 0 }), "speaking", 90, { reduced: true, agent: voice({ bands }) }))
    expect(at(bandsIn(0, 3))).toEqual(at(bandsIn(20, 23)))
    const full = (bands: Float32Array) => outline(settle(make({ relief: 1 }), "speaking", 90, { reduced: true, agent: voice({ bands }) }))
    expect(full(bandsIn(0, 3))).not.toEqual(full(bandsIn(20, 23)))
  })
})

describe("liquid blob: the shape follows the voice's character", () => {
  const shape = (v: Partial<VoiceFeatures>, stored: Record<string, number> = {}) => outline(settle(make(stored), "speaking", 90, { reduced: true, agent: voice(v) }))
  const deep = { register: 0, pitch: 0 }
  const high = { register: 1, pitch: 1 }

  it("a deep voice sags the liquid into a pear (heavier below), a high one lifts it", () => {
    expect(meanY(shape(deep))).toBeGreaterThan(meanY(shape(high)) + 2)
  })

  it("'Pitch character: 0' makes a deep and a high voice the same shape", () => {
    expect(shape(deep, { pitch: 0 })).toEqual(shape(high, { pitch: 0 }))
    expect(shape(deep, { pitch: 1 })).not.toEqual(shape(high, { pitch: 1 }))
  })

  it("each mode has its own size: a small drop at rest, the largest while speaking", () => {
    const radius = (mode: Mode) => meanRadius(outline(settle(make(), mode, 90, { reduced: true })))
    const idle = radius("idle")
    expect(idle).toBeLessThan(radius("thinking"))
    expect(radius("thinking")).toBeLessThan(radius("listening"))
    expect(radius("listening")).toBeLessThan(radius("speaking"))
  })

  it("a louder voice is more liquid: the body grows with the level", () => {
    const at = (level: number) => meanRadius(outline(settle(make(), "speaking", 90, { reduced: true, agent: voice({ level }) })))
    expect(at(0.9)).toBeGreaterThan(at(0.1) * 1.1)
  })

  it("'Size' scales the body: half the size is half the width, and the largest never leaves the canvas", () => {
    const width = (stored: Record<string, number>) => {
      const o = outline(settle(make(stored), "idle", 30, { reduced: true }))
      return Math.max(...o.map((p) => p.x)) - Math.min(...o.map((p) => p.x))
    }
    expect(width({ size: 0.5 }) / width({ size: 1 })).toBeCloseTo(0.5, 3)
    expect(width({ size: 1.25 })).toBeGreaterThan(width({ size: 1 }))
    for (const size of [[160, 140], [W, H], [900, 420]] as const) {
      const r = make({ size: 1.25 }, size)
      const loud = voice({ level: 1, bands: bandsIn(0, 23) })
      for (const i of [0, 1, 2]) {
        const calls = i === 0 ? settle(r, "speaking", 120, { reduced: true, agent: loud }) : settle(r, "speaking", 60, { agent: loud })
        for (const p of outline(calls)) {
          expect(p.x, `${size.join("×")} x`).toBeGreaterThanOrEqual(0)
          expect(p.x, `${size.join("×")} x`).toBeLessThanOrEqual(size[0])
          expect(p.y, `${size.join("×")} y`).toBeGreaterThanOrEqual(0)
          expect(p.y, `${size.join("×")} y`).toBeLessThanOrEqual(size[1])
        }
      }
    }
  })

  it("under reduced motion the level is quantised to thirds: a small change in the same third changes nothing, a change of third does", () => {
    const at = (level: number) => outline(settle(make(), "speaking", 120, { reduced: true, agent: voice({ level }) }))
    expect(at(0.45)).toEqual(at(0.5))
    expect(at(0.2)).not.toEqual(at(0.5))
    expect(at(0.5)).not.toEqual(at(0.9))
  })

  it("reduced motion holds a still outline under steady sibilance and a moving pitch", () => {
    for (const mode of ["speaking", "hearing"] as const) {
      const who = mode === "speaking" ? "agent" : "user"
      const r = make()
      const v = voice({ sibilance: 1, pitchDelta: 6, level: 0.5 })
      const o: StepOptions = who === "agent" ? { reduced: true, agent: v } : { reduced: true, user: v }
      settle(r, mode, 120, o)
      const a = outline(frame(r, mode, o))
      const b = outline(settle(r, mode, 17, o))
      expect(b, `${mode}: no shimmer`).toEqual(a)
    }
  })
})

describe("liquid blob: droplets", () => {
  const speak = (n: number, at: (i: number) => VoiceFeatures, stored: Record<string, number | boolean | string> = {}) => run(make(stored), "speaking", n, "agent", at)
  const hear = (n: number, at: (i: number) => VoiceFeatures, stored: Record<string, number | boolean | string> = {}) => run(make(stored), "hearing", n, "user", at)

  it("each syllable onset while speaking buds one droplet; a held onset buds no more, and a falling-then-rising one buds another", () => {
    const held = speak(10, (i) => voice({ onset: i >= 2 ? 1 : 0 }))
    expect(drops(held[9]!)).toHaveLength(1)
    const twice = speak(16, syllables([2, 10]))
    expect(drops(twice[15]!)).toHaveLength(2)
    expect(drops(speak(10, () => voice())[9]!)).toHaveLength(0)
  })

  it("at most one droplet per 120 ms", () => {
    const quick = speak(10, syllables([2, 5]))
    expect(drops(quick[9]!)).toHaveLength(1)
  })

  it("only a loud syllable of the reply buds a droplet (level above 0.22)", () => {
    expect(drops(speak(8, syllables([2], { level: 0.2 }))[7]!)).toHaveLength(0)
    expect(drops(speak(8, syllables([2], { level: 0.3 }))[7]!)).toHaveLength(1)
  })

  it("while hearing, a droplet flies in from outside the body; while speaking, it buds out of the surface", () => {
    const flying = hear(8, syllables([2]))
    const [d] = drops(flying[3]!)
    expect(drops(flying[3]!)).toHaveLength(1)
    expect(reach(flying[3]!, d!)).toBeGreaterThan(1.5)
    const budding = speak(8, syllables([2]))
    const [b] = drops(budding[3]!)
    expect(drops(budding[3]!)).toHaveLength(1)
    expect(reach(budding[3]!, b!)).toBeLessThan(1.3)
  })

  it("a very quiet word is not taken in (level 0.04 or below), a soft one is", () => {
    expect(drops(hear(8, syllables([2], { level: 0.03 }))[7]!)).toHaveLength(0)
    expect(drops(hear(8, syllables([2], { level: 0.1 }))[7]!)).toHaveLength(1)
  })

  it("syllables in another mode's voice are ignored: nothing flies in while idle, and the other side's onsets do nothing", () => {
    expect(drops(run(make(), "idle", 10, "user", syllables([2]))[9]!)).toHaveLength(0)
    expect(drops(run(make(), "speaking", 10, "user", syllables([2]))[9]!)).toHaveLength(0)
    expect(drops(run(make(), "hearing", 10, "agent", syllables([2]))[9]!)).toHaveLength(0)
  })

  it("a droplet buds, stretches and is pulled back: it is gone within two seconds", () => {
    const frames = speak(130, syllables([2]))
    expect(drops(frames[20]!)).toHaveLength(1)
    expect(drops(frames[129]!)).toHaveLength(0)
  })

  it("'Flying droplets' off: no droplet while hearing or speaking", () => {
    for (const [n, f] of [
      [hear(40, syllables([2, 12, 22]), { droplets: false }), "hearing"],
      [speak(40, syllables([2, 12, 22]), { droplets: false }), "speaking"]
    ] as const)
      for (const calls of n) expect(drops(calls), f).toHaveLength(0)
    expect(Math.max(...hear(40, syllables([2, 12, 22]), { droplets: true }).map((c) => drops(c).length))).toBeGreaterThan(0)
  })

  it("while listening, three droplets hover whether or not 'Flying droplets' is on, and with it on another drifts in every 1.4 s", () => {
    const listen = (stored: Record<string, boolean>) => run(make(stored), "listening", 300, "user", () => voice()).slice(120)
    const off = listen({ droplets: false })
    expect(off.every((c) => drops(c).length === 3)).toBe(true)
    const on = listen({ droplets: true })
    expect(Math.min(...on.map((c) => drops(c).length))).toBeGreaterThanOrEqual(3)
    expect(Math.max(...on.map((c) => drops(c).length))).toBeGreaterThanOrEqual(4)
    expect(drops(settle(make(), "idle", 90, { reduced: true }))).toHaveLength(0)
  })

  it("reduced motion: nothing flies; one still droplet shows the direction (out while speaking, in while taking in), and none with droplets off", () => {
    const still = (mode: "speaking" | "hearing", stored: Record<string, boolean> = {}) => {
      const r = make(stored)
      const frames = run(r, mode, 60, mode === "speaking" ? "agent" : "user", syllables([2, 12, 22], { level: 0.8 }), { reduced: true })
      return frames.map((c) => drops(c))
    }
    for (const mode of ["speaking", "hearing"] as const) {
      const on = still(mode)
      expect(on.every((d) => d.length === 1), `${mode}: one droplet in every frame, syllables or not`).toBe(true)
      expect(on[59]).toEqual(on[58]) // and, once the level has settled, it does not move
      expect(still(mode, { droplets: false }).every((d) => d.length === 0), `${mode}: none with droplets off`).toBe(true)
    }
    // Budded out while speaking (above the body, to the upper left of the top), waiting outside while taking in.
    const out = still("speaking")[59]![0]!
    const taking = still("hearing")[59]![0]!
    expect(out.y).toBeLessThan(CY)
    expect(taking.y).toBeLessThan(CY)
    expect(out.x).toBeLessThan(CX)
    expect(taking.x).toBeGreaterThan(CX)
  })

  it("reduced motion switched on mid-flight clears the droplets already in the air: only the one still droplet remains", () => {
    for (const mode of ["speaking", "hearing"] as const) {
      const who = mode === "speaking" ? "agent" : "user"
      const r = make()
      run(r, mode, 20, who, syllables([2], { level: 0.8 }))
      expect(drops(frame(r, mode, who === "agent" ? { agent: voice({ level: 0.8 }) } : { user: voice({ level: 0.8 }) })).length, `${mode}: one is in flight`).toBeGreaterThanOrEqual(1)
      const v = voice({ level: 0.8 })
      const after = settle(r, mode, 3, who === "agent" ? { reduced: true, agent: v } : { reduced: true, user: v })
      expect(drops(after), `${mode}: only the still droplet`).toHaveLength(1)
    }
  })

  it("reduced motion listening keeps its three waiting droplets and adds the still one only when droplets are on", () => {
    expect(drops(settle(make(), "listening", 60, { reduced: true }))).toHaveLength(4)
    expect(drops(settle(make({ droplets: false }), "listening", 60, { reduced: true }))).toHaveLength(3)
  })
})

describe("liquid blob: the finishes", () => {
  const at = (finish: string, mode: Mode = "idle", palette: Palette = PALETTES.dark) => settle(make({ finish }), mode, 30, { reduced: true, palette })

  it("glossy has highlights, flat has none, outline erases its inside and leaves a clear body", () => {
    const glossy = at("glossy")
    const flat = at("flat")
    const clear = at("outline")
    expect(count(glossy, "ellipse")).toBeGreaterThanOrEqual(2)
    expect(count(flat, "ellipse")).toBe(0)
    expect(count(clear, "ellipse")).toBe(0)
    expect(glossy.some((c) => c.name === "=globalCompositeOperation" && c.args[0] === "destination-out")).toBe(false)
    expect(flat.some((c) => c.name === "=globalCompositeOperation" && c.args[0] === "destination-out")).toBe(false)
    expect(clear.some((c) => c.name === "=globalCompositeOperation" && c.args[0] === "destination-out")).toBe(true)
  })

  it("every finish is a different picture, and an unknown one is treated as the first (glossy)", () => {
    const digest = (finish: string) => {
      const r = make({ finish })
      settle(r, "speaking", 30, { reduced: true, agent: voice() })
      recording.reset()
      settle(r, "speaking", 1, { reduced: true, agent: voice() })
      return recording.digest
    }
    const seen = new Set(["glossy", "flat", "outline"].map(digest))
    expect(seen.size).toBe(3)
    expect(digest("no-such-finish")).toBe(digest("glossy"))
  })

  it("the outline finish strokes the body in the mode's colour: faint grey at rest, yours listening and hearing, the assistant's thinking and speaking", () => {
    const p = PALETTES.dark
    const stroked = (mode: Mode) => rgbOf(String(at("outline", mode, p).find((c) => c.name === "=strokeStyle")!.args[0])).slice(0, 3)
    expect(stroked("idle")).toEqual([...p.inkFaint])
    expect(stroked("listening")).toEqual([...p.you])
    expect(stroked("hearing")).toEqual([...p.you])
    expect(stroked("thinking")).toEqual([...p.voice])
    expect(stroked("speaking")).toEqual([...p.voice])
  })

  it("the light theme gets a crisp edge on glossy and flat, which the clear outline replaces with its own line", () => {
    const edge = (finish: string) => count(at(finish, "idle", PALETTES.light), "stroke") - count(at(finish, "idle", PALETTES.dark), "stroke")
    expect(edge("glossy")).toBe(1)
    expect(edge("flat")).toBe(1)
  })
})

describe("liquid blob: thinking", () => {
  it("marbles the person's colour through the assistant's: five swirls inside the body, and only while thinking", () => {
    const p = PALETTES.dark
    // The flat finish has no highlights, so a clip and strokes can only be the marbling.
    const think = settle(make({ finish: "flat" }), "thinking", 30, { reduced: true, palette: p })
    expect(count(think, "clip")).toBe(1)
    expect(count(think, "stroke")).toBe(5)
    const [r, g, b] = rgbOf(String(think.find((c) => c.name === "=strokeStyle")!.args[0]))
    const dist = (c: ReadonlyArray<number>) => Math.hypot(r! - c[0]!, g! - c[1]!, b! - c[2]!)
    expect(dist(p.you)).toBeLessThan(dist(p.voice))
    for (const mode of ["idle", "listening", "hearing", "speaking"] as const) {
      const calls = settle(make({ finish: "flat" }), mode, 30, { reduced: true, palette: p })
      expect(count(calls, "clip"), mode).toBe(0)
      expect(count(calls, "stroke"), mode).toBe(0)
    }
  })

  it("turns slowly into two lobes, and holds still under reduced motion", () => {
    const r = make()
    settle(r, "thinking", 60)
    const a = outline(frame(r, "thinking"))
    settle(r, "thinking", 40)
    const b = outline(frame(r, "thinking"))
    expect(b).not.toEqual(a) // it swirls
    const still = make()
    settle(still, "thinking", 60, { reduced: true })
    expect(outline(frame(still, "thinking", { reduced: true }))).toEqual(outline(settle(still, "thinking", 40, { reduced: true })))
  })
})

describe("liquid blob: the pointer", () => {
  /** The outline point at the right of the body, and at its left, with the pointer at the right edge. */
  const sides = (pointer: Pointer | undefined) => {
    const o = outline(settle(make(), "idle", 30, { reduced: true, ...(pointer !== undefined ? { pointer } : {}) }))
    return { right: o[0]!.x, left: o[N / 2]!.x }
  }
  const rest = sides(undefined)
  /** At the body's right edge (a body radius from its middle). */
  const atEdge = (down: boolean, inside = true): Pointer => ({ x: rest.right, y: CY, down, inside })

  it("pressing dents the surface under the finger, and hovering close makes the edge reach toward it", () => {
    const pressed = sides(atEdge(true))
    const hovered = sides(atEdge(false))
    expect(pressed.right).toBeLessThan(rest.right - 3)
    expect(hovered.right).toBeGreaterThan(rest.right + 1)
  })

  it("only near the finger: the far side does not move", () => {
    expect(sides(atEdge(true)).left).toBeCloseTo(rest.left, 6)
    expect(sides(atEdge(false)).left).toBeCloseTo(rest.left, 6)
  })

  it("a pointer outside the canvas, or far from the body, does nothing", () => {
    expect(sides(atEdge(true, false))).toEqual(rest)
    expect(sides({ x: CX + 3 * (rest.right - CX), y: CY, down: true, inside: true })).toEqual(rest)
  })
})
