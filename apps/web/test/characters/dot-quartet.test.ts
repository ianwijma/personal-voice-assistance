/**
 * What is particular to "Dot quartet" (src/characters/library/dot-quartet.ts): four dots that stand up as bars,
 * with the direction rule (the outer pair leads and the row is a tight V for the person, the inner pair leads and
 * the row is a spread Λ for the assistant), hollow bars for a whisper, the pitch staircase, the orbit while
 * thinking, and bars that never leave the box. Driven through the runner on the recording canvas with hand-set
 * voice features, reading the bars from the `roundRect` calls. The groundwork suites (compat, isolation) already
 * cover the manifest, option extremes and garbage, mode distinctness, digests and frame cost.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Mode, OptionValues, Palette, Pointer, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import dotQuartet from "@/characters/library/dot-quartet.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const DT = 1 / 60
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }

const make = (stored: OptionValues = {}, size: readonly [number, number] = [720, 240]) => {
  const r = new Runner(dotQuartet, document.createElement("canvas"), stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return { r, W: size[0], H: size[1] }
}
type Rig = ReturnType<typeof make>

/** Loud voiced speech by default; `bands` stay flat so every bar gets the same spectrum gain. */
const voice = (o: Partial<VoiceFeatures> = {}): VoiceFeatures => ({ ...createVoiceFeatures(), speaking: true, level: 0.6, rms: 0.06, voicing: 1, pitchHz: 200, pitch: 0.5, register: 0.5, ...o })
const silent = createVoiceFeatures()
/**
 * No pointer: not inside, and placed well outside the canvas as well.
 */
const NO_POINTER: Pointer = { x: -1000, y: -1000, down: false, inside: false }

interface StepOptions {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly reduced?: boolean
  readonly pointer?: Pointer
  readonly palette?: Palette
}

/** Steps `frames` frames; returns the calls of the last one. */
const step = (rig: Rig, mode: Mode, frames: number, o: StepOptions | ((i: number) => StepOptions) = {}): Array<Call> => {
  let last: Array<Call> = []
  for (let i = 0; i < frames; i++) {
    const s = typeof o === "function" ? o(i) : o
    recording.log = []
    rig.r.step({ mode, dt: DT, user: s.user ?? silent, agent: s.agent ?? silent, palette: s.palette ?? PALETTES.dark, reducedMotion: s.reduced === true, pointer: s.pointer ?? NO_POINTER, sinceInterrupt: Infinity })
    last = recording.log
  }
  recording.log = null
  return last
}
const secs = (n: number) => Math.round(n / DT)

interface Bar {
  readonly cx: number
  readonly cy: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly radius: number
  /** The fill colour and alpha the bar was filled with, and whether it was also outlined. */
  readonly fill: { readonly rgb: ReadonlyArray<number>; readonly alpha: number }
  readonly stroked: boolean
}
const parse = (css: string) => {
  const m = css.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/)!
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) }
}
/** The four bars of a frame, left to right, with the paint they got. */
const bars = (calls: ReadonlyArray<Call>): Array<Bar> => {
  const out: Array<Bar> = []
  let style = "rgba(0,0,0,0)"
  for (let k = 0; k < calls.length; k++) {
    const c = calls[k]!
    if (c.name === "=fillStyle") style = String(c.args[0])
    if (c.name !== "roundRect") continue
    const [x, y, w, h, radius] = c.args as Array<number>
    // roundRect, then fillStyle, fill, and (hollow bars) strokeStyle, stroke.
    const rest = calls.slice(k + 1, k + 6)
    const fillStyle = (rest.find((n) => n.name === "=fillStyle")?.args[0] as string | undefined) ?? style
    out.push({ cx: x! + w! / 2, cy: y! + h! / 2, x: x!, y: y!, w: w!, h: h!, radius: radius!, fill: parse(fillStyle), stroked: rest.some((n) => n.name === "stroke") })
  }
  return out
}
const spacingOf = (b: ReadonlyArray<Bar>) => (b[3]!.cx - b[0]!.cx) / 3
const mean = (xs: ReadonlyArray<number>) => xs.reduce((a, b) => a + b, 0) / xs.length

beforeEach(() => {
  recording.log = null
})

describe("dot quartet: at rest", () => {
  it("is four equal round dots in an even row, centred", () => {
    const { r, W, H } = make()
    const b = bars(step({ r, W, H }, "idle", secs(1)))
    expect(b).toHaveLength(4)
    for (const x of b) {
      expect(x.w).toBeCloseTo(b[0]!.w, 3)
      expect(x.h).toBeCloseTo(x.w, 3) // a dot
      expect(x.radius).toBeCloseTo(x.w / 2, 3) // a round one
      expect(x.cy).toBeCloseTo(H / 2, 3)
    }
    expect(mean(b.map((x) => x.cx))).toBeCloseTo(W / 2, 3)
    expect(b[1]!.cx - b[0]!.cx).toBeCloseTo(b[2]!.cx - b[1]!.cx, 3)
  })

  it("Size scales the dots and Gap scales their spacing, but neighbours never touch", () => {
    const idle = (stored: OptionValues) => bars(step(make(stored), "idle", secs(1)))
    const small = idle({ size: 0.5 })
    const large = idle({ size: 1.5 })
    expect(large[0]!.w / small[0]!.w).toBeCloseTo(3, 1)
    const tight = idle({ spacing: 0.7 })
    const wide = idle({ spacing: 1.6 })
    expect(spacingOf(wide)).toBeGreaterThan(spacingOf(tight) * 2)
    // The tightest row still leaves a gap between neighbours.
    expect(spacingOf(tight)).toBeGreaterThan(tight[0]!.w)
  })
})

describe("dot quartet: the direction rule", () => {
  const hearing = (stored: OptionValues = {}) => bars(step(make(stored), "hearing", secs(2), { user: voice() }))
  const speaking = (stored: OptionValues = {}) => bars(step(make(stored), "speaking", secs(2), { agent: voice() }))

  it("while you speak the outer bars are taller (a V); while the assistant speaks the inner ones are (a Λ)", () => {
    const you = hearing()
    expect(you[0]!.h).toBeCloseTo(you[3]!.h, 3)
    expect(you[1]!.h).toBeCloseTo(you[2]!.h, 3)
    expect(you[0]!.h).toBeGreaterThan(you[1]!.h * 1.3)
    const agent = speaking()
    expect(agent[0]!.h).toBeCloseTo(agent[3]!.h, 3)
    expect(agent[1]!.h).toBeCloseTo(agent[2]!.h, 3)
    expect(agent[1]!.h).toBeGreaterThan(agent[0]!.h * 1.3)
  })

  it("the row is tight for the person and spread for the assistant", () => {
    expect(spacingOf(speaking())).toBeGreaterThan(spacingOf(hearing()) * 1.4)
  })

  it("the leading pair reaches its height before the trailing pair, in both directions", () => {
    const reached = (mode: Mode, side: "user" | "agent", lead: [number, number], trail: [number, number]) => {
      const rig = make()
      step(rig, mode, secs(1), { [side]: voice({ level: 0, speaking: false }) })
      const onset = bars(step(rig, mode, 4, { [side]: voice() })) // about 70 ms after the voice starts
      const steady = bars(step(rig, mode, secs(2), { [side]: voice() }))
      const fraction = (i: number) => (onset[i]!.h - onset[i]!.w) / (steady[i]!.h - steady[i]!.w)
      return { lead: mean(lead.map(fraction)), trail: mean(trail.map(fraction)) }
    }
    const you = reached("hearing", "user", [0, 3], [1, 2])
    expect(you.lead).toBeGreaterThan(you.trail)
    const agent = reached("speaking", "agent", [1, 2], [0, 3])
    expect(agent.lead).toBeGreaterThan(agent.trail)
  })

  it("a deep voice makes wider bars than a child's while the person speaks", () => {
    const width = (register: number) => bars(step(make(), "hearing", secs(3), { user: voice({ register }) }))[0]!.w
    expect(width(0)).toBeGreaterThan(width(1) * 1.4)
  })

  it("each bar follows its own quarter of the spectrum, scaled by Spectrum detail", () => {
    const lowHeavy = (spectrum: number) => {
      const bands = new Float32Array(24)
      bands.fill(0.9, 0, 6)
      const b = bars(step(make({ spectrum }), "hearing", secs(2), { user: voice({ bands }) }))
      // Divide out the V so the bars can be compared with each other: bars 0 and 3 share a shape factor.
      return b[0]!.h / b[3]!.h
    }
    expect(lowHeavy(1)).toBeGreaterThan(1.1)
    expect(lowHeavy(2)).toBeGreaterThan(lowHeavy(1))
    expect(lowHeavy(0)).toBeCloseTo(1, 3)
  })
})

describe("dot quartet: colour and fill", () => {
  const colour = (mode: Mode, o: StepOptions = {}) => bars(step(make(), mode, secs(3), { palette: PALETTES.light, ...o }))[0]!.fill.rgb
  it("grey at rest, the person's colour while listening and hearing, the assistant's while speaking", () => {
    const P = PALETTES.light
    expect(colour("idle")).toEqual([...P.inkFaint])
    expect(colour("listening")).toEqual([...P.you])
    expect(colour("hearing", { user: voice() })).toEqual([...P.you])
    expect(colour("speaking", { agent: voice() })).toEqual([...P.voice])
  })

  it("voiced bars are solid; a whisper leaves them hollow with an outline; Outline is always hollow", () => {
    const hearing = (stored: OptionValues, user: VoiceFeatures) => bars(step(make(stored), "hearing", secs(3), { user }))
    const voiced = hearing({}, voice())
    expect(voiced.every((b) => b.fill.alpha > 0.95 && !b.stroked)).toBe(true)
    const whisper = hearing({}, voice({ voicing: 0, pitchHz: 0, level: 0.15 }))
    expect(whisper.every((b) => b.fill.alpha < 0.2 && b.stroked)).toBe(true)
    const outline = hearing({ shape: "outline" }, voice())
    expect(outline.every((b) => b.fill.alpha < 0.01 && b.stroked)).toBe(true)
  })

  it("Square sharpens the corners of the bars", () => {
    const radius = (shape: string) => {
      const b = bars(step(make({ shape }), "hearing", secs(2), { user: voice() }))[0]!
      return b.radius / (b.w / 2)
    }
    expect(radius("rounded")).toBeCloseTo(1, 3)
    expect(radius("square")).toBeCloseTo(0.22, 2)
  })
})

describe("dot quartet: pitch staircase", () => {
  const tilt = (pitchDelta: number, stored: OptionValues = {}) => {
    const b = bars(step(make(stored), "hearing", secs(4), { user: voice({ pitchDelta }) }))
    return b[0]!.cy - b[3]!.cy // positive: the right-hand bar sits higher
  }
  it("a rising voice lifts the row to the right, a falling one to the left, a steady one leaves it level", () => {
    expect(tilt(9)).toBeGreaterThan(5)
    expect(tilt(-9)).toBeLessThan(-5)
    expect(Math.abs(tilt(0))).toBeLessThan(0.5)
  })

  it("the Pitch staircase option scales the tilt, and 0 turns it off", () => {
    expect(tilt(9, { intonation: 2 })).toBeGreaterThan(tilt(9, { intonation: 1 }) * 1.7)
    expect(Math.abs(tilt(9, { intonation: 0 }))).toBeLessThan(0.5)
  })
})

describe("dot quartet: the pointer", () => {
  it("the row leans toward the pointer", () => {
    const rig = make()
    const away = mean(bars(step(rig, "idle", secs(1))).map((b) => b.cx))
    const right = mean(bars(step(rig, "idle", secs(1), { pointer: { x: 700, y: 120, down: false, inside: true } })).map((b) => b.cx))
    const left = mean(bars(step(rig, "idle", secs(1), { pointer: { x: 20, y: 120, down: false, inside: true } })).map((b) => b.cx))
    expect(right).toBeGreaterThan(away)
    expect(left).toBeLessThan(away)
  })

  // The lean and the press need `pointer.inside`: a pointer that has left the canvas (inside = false, coordinates
  // left at the last position, or the initial 0, 0 on a canvas whose focus starts at 0, 0) does not pull the row.
  it("ignores a pointer that is not over the canvas (inside is false)", () => {
    const rig = make()
    const away = mean(bars(step(rig, "idle", secs(1))).map((b) => b.cx))
    const stale = mean(bars(step(rig, "idle", secs(1), { pointer: { x: 700, y: 120, down: false, inside: false } })).map((b) => b.cx))
    expect(stale).toBeCloseTo(away, 3)
  })

  it("pressing squashes the dots: wider and, for a bar, shorter", () => {
    const rig = make()
    const up = bars(step(rig, "hearing", secs(2), { user: voice(), pointer: { x: 360, y: 120, down: false, inside: true } }))
    const down = bars(step(rig, "hearing", secs(2), { user: voice(), pointer: { x: 360, y: 120, down: true, inside: true } }))
    expect(down[0]!.w).toBeCloseTo(up[0]!.w * 1.15, 1)
    expect(down[0]!.h).toBeLessThan(up[0]!.h * 0.9)
  })
})

describe("dot quartet: thinking", () => {
  const centre = (b: ReadonlyArray<Bar>, W: number, H: number) => b.map((x) => Math.hypot(x.cx - W / 2, x.cy - H / 2))

  it("the dots gather into a ring around the centre and circle", () => {
    const rig = make()
    const a = bars(step(rig, "thinking", secs(2)))
    const dot = a[0]!.w
    // On a ring of 1.45 dots (the springs trail the moving target a little, so a touch inside it), all four alike.
    const rings = centre(a, rig.W, rig.H)
    for (const d of rings) {
      expect(d).toBeGreaterThan(dot * 1.2)
      expect(d).toBeLessThan(dot * 1.45 + 0.5)
      expect(Math.abs(d - rings[0]!)).toBeLessThan(2)
    }
    const b = bars(step(rig, "thinking", secs(0.3)))
    expect(Math.hypot(b[0]!.cx - a[0]!.cx, b[0]!.cy - a[0]!.cy)).toBeGreaterThan(dot * 0.5)
  })

  it("comet tails follow the dots, unless Comet tails is off or motion is reduced", () => {
    const tails = (stored: OptionValues, reduced = false) => step(make(stored), "thinking", secs(2), { reduced }).filter((c) => c.name === "arc").length
    expect(tails({})).toBe(16)
    expect(tails({ trails: false })).toBe(0)
    expect(tails({}, true)).toBe(0)
  })

  it("reduced motion: a still diamond of four dots", () => {
    const rig = make()
    const a = bars(step(rig, "thinking", secs(2), { reduced: true }))
    const b = bars(step(rig, "thinking", secs(1), { reduced: true }))
    expect(b.map((x) => [x.cx, x.cy])).toEqual(a.map((x) => [x.cx, x.cy]))
    expect(new Set(a.map((x) => `${x.cx.toFixed(1)},${x.cy.toFixed(1)}`)).size).toBe(4)
  })
})

describe("dot quartet: bars stay in the box", () => {
  it("at the largest size, the widest gap and the loudest voice, in the smallest cell", () => {
    for (const mode of ["hearing", "speaking"] as const) {
      const { r, W, H } = make({ size: 1.5, spacing: 1.6, spectrum: 2 }, [160, 140])
      const loud = voice({ level: 1, bands: new Float32Array(24).fill(1) }) // every quarter at full energy: the tallest bars the options allow
      const b = bars(step({ r, W, H }, mode, secs(2), { user: loud, agent: loud }))
      expect(Math.max(...b.map((x) => x.h)), `${mode}: bars are tall`).toBeGreaterThan(H * 0.8)
      for (const x of b) {
        expect(x.y, mode).toBeGreaterThanOrEqual(4 - 1e-6)
        expect(x.y + x.h, mode).toBeLessThanOrEqual(H - 4 + 1e-6)
        expect(x.x, mode).toBeGreaterThanOrEqual(0)
        expect(x.x + x.w, mode).toBeLessThanOrEqual(W)
      }
      for (let i = 1; i < 4; i++) expect(b[i]!.x, `${mode}: bars ${i - 1} and ${i} do not overlap`).toBeGreaterThan(b[i - 1]!.x + b[i - 1]!.w)
    }
  })

  it("heights are quantised to quarters of the level under reduced motion", () => {
    const height = (level: number) => bars(step(make(), "hearing", secs(2), { user: voice({ level }), reduced: true }))[0]!.h
    expect(height(0.55)).toBeCloseTo(height(0.5), 3)
    expect(height(0.55)).not.toBeCloseTo(height(0.7), 1)
  })
})
