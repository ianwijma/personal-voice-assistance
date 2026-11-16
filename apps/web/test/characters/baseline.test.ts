/**
 * The baseline (sine lines) looks as the stage did before characters existed, in every visual state
 * (docs/UI-AND-MODULES.md §3.3): checked on the calls it makes, through the runner, on the recording canvas.
 */
import { beforeEach, describe, expect, it } from "vitest"
import { CORE_MODES, EXTRA_MODES, type Focus, type Mode, type Palette, type VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import baseline from "@/characters/library/sine-lines.ts"
import { Runner } from "@/characters/runner.ts"
import { noise, standInAgent, standInUser } from "@/characters/voices.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }

const make = (stored: Record<string, number | boolean | string> = {}, size: readonly [number, number] = [W, H]) => {
  const canvas = document.createElement("canvas")
  const r = new Runner(baseline, canvas, stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}
/** The voice page at 1280 × 800: the full-stage canvas, and the box on it. */
const STAGE: readonly [number, number] = [1280, 800]
const BOX: Focus = { x: 280, y: 197, width: W, height: H }

const loud = (): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.rms = 0.05
  f.level = 0.5
  f.low = f.mid = f.high = 0.5
  return f
}
const quiet = createVoiceFeatures()

/** Step `frames` frames; returns the calls of the last one. */
const step = (r: Runner, mode: Mode, frames: number, o: { user?: VoiceFeatures; agent?: VoiceFeatures; palette?: Palette; reduced?: boolean; sinceInterrupt?: number; focus?: Focus } = {}): Array<Call> => {
  let last: Array<Call> = []
  for (let i = 0; i < frames; i++) {
    recording.log = []
    r.step({ mode, dt: DT, user: o.user ?? quiet, agent: o.agent ?? quiet, palette: o.palette ?? PALETTES.dark, reducedMotion: o.reduced === true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: o.sinceInterrupt ?? Infinity, ...(o.focus !== undefined ? { focus: o.focus } : {}) })
    last = recording.log
  }
  recording.log = null
  return last
}

const strokes = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "=strokeStyle").map((c) => String(c.args[0]))
const points = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "lineTo" || c.name === "moveTo").map((c) => [c.args[0] as number, c.args[1] as number] as const)
/** Line points on the canvas, CSS px: through the transform set before them (a stage character draws at the focus). */
const placed = (calls: ReadonlyArray<Call>) => {
  let m = [1, 0, 0, 1, 0, 0]
  const out: Array<readonly [number, number]> = []
  for (const c of calls) {
    if (c.name === "setTransform") m = c.args as Array<number>
    else if (c.name === "lineTo" || c.name === "moveTo") {
      const [x, y] = c.args as [number, number]
      out.push([(m[0]! * x + m[2]! * y + m[4]!) / m[0]!, (m[1]! * x + m[3]! * y + m[5]!) / m[3]!])
    }
  }
  return out
}
const amplitude = (calls: ReadonlyArray<Call>) => Math.max(...points(calls).map(([, y]) => Math.abs(y - H / 2)))
const rgbOf = (css: string) => css.match(/rgba\((\d+),(\d+),(\d+),([\d.e-]+)\)/)!.slice(1).map(Number)

beforeEach(() => {
  recording.log = null
})

describe("the baseline in every visual state", () => {
  it("draws each extra mode itself (it declares all of them)", () => {
    expect(Object.keys(baseline.extraModes ?? {}).sort()).toEqual(["asleep", "disconnected", "error", "muted", "not-started"])
  })

  it("disconnected: faint grey, flat and dashed 4 on 6 off", () => {
    const calls = step(make(), "disconnected", 60)
    expect(calls).toContainEqual({ name: "setLineDash", args: [[4, 6]] })
    const [r, g, b, a] = rgbOf(strokes(calls)[2]!) // the front line is drawn last
    expect([r, g, b]).toEqual([...PALETTES.dark.inkFaint])
    expect(a).toBeCloseTo(0.5)
    expect(amplitude(calls)).toBeLessThan(0.01)
  })

  it("error: flat, in the danger colour", () => {
    const calls = step(make(), "error", 60, { palette: PALETTES.light })
    expect(rgbOf(strokes(calls)[2]!).slice(0, 3)).toEqual([...PALETTES.light.danger])
    expect(amplitude(calls)).toBeLessThan(0.01)
  })

  it("not started: faint grey at 40 %, flat", () => {
    const calls = step(make(), "not-started", 60)
    const c = rgbOf(strokes(calls)[2]!)
    expect(c.slice(0, 3)).toEqual([...PALETTES.dark.inkFaint])
    expect(c[3]).toBeCloseTo(0.4)
  })

  it("muted: flat with a 48 px gap in the middle", () => {
    const calls = step(make(), "muted", 60)
    const xs = points(calls).map(([x]) => x)
    expect(xs.some((x) => Math.abs(x - W / 2) < 24)).toBe(false)
    expect(xs.some((x) => Math.abs(x - W / 2) < 30)).toBe(true)
    expect(calls.some((c) => c.name === "setLineDash" && (c.args[0] as Array<number>).length > 0)).toBe(false)
  })

  it("asleep: your colour, faint, breathing", () => {
    const r = make()
    const alphas = [0, 1, 2, 3].map(() => rgbOf(strokes(step(r, "asleep", 30))[2]!)[3]!)
    expect(rgbOf(strokes(step(r, "asleep", 1))[2]!).slice(0, 3)).toEqual([...PALETTES.dark.you])
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.42 + 1e-9)
    expect(Math.max(...alphas) - Math.min(...alphas)).toBeGreaterThan(0.01)
  })

  it("hearing and speaking follow the voice; thinking sweeps; listening is quiet", () => {
    expect(amplitude(step(make(), "hearing", 30, { user: loud() }))).toBeGreaterThan(30)
    expect(amplitude(step(make(), "speaking", 30, { agent: loud() }))).toBeGreaterThan(30)
    expect(step(make(), "thinking", 30).some((c) => c.name === "createLinearGradient")).toBe(true)
    expect(amplitude(step(make(), "listening", 30))).toBeLessThan(3)
  })

  it("collapses fast just after an interruption", () => {
    const after = (sinceInterrupt: number) => {
      const r = make()
      step(r, "speaking", 30, { agent: loud() })
      return amplitude(step(r, "speaking", 9, { sinceInterrupt }))
    }
    expect(after(0.1)).toBeLessThan(after(Infinity) * 0.5)
  })

  it("reduced motion: no sideways motion, no glow, no sweep; the colour still shows the mode", () => {
    const r = make()
    const a = step(r, "thinking", 60, { reduced: true })
    const b = step(r, "thinking", 60, { reduced: true })
    expect(points(a)).toEqual(points(b))
    expect(a.some((c) => c.name === "createLinearGradient")).toBe(false)
    expect(rgbOf(strokes(a)[2]!).slice(0, 3)).toEqual([...PALETTES.dark.voice])
    const h = step(make(), "hearing", 60, { reduced: true, user: loud() })
    expect(h.filter((c) => c.name === "=shadowBlur").every((c) => c.args[0] === 0)).toBe(true)
  })

  it("reduced motion with a live, changing voice: the shape is held and steps at most once a second", () => {
    for (const [mode, side] of [["hearing", "user"], ["speaking", "agent"]] as const) {
      const r = make()
      const v = createVoiceFeatures()
      let prev: string | null = null
      let lastChange = -Infinity
      let changes = 0
      const frames = 300
      for (let i = 0; i < frames; i++) {
        const t = i * DT
        // A voice whose loudness and spectrum change every frame.
        v.rms = 0.03 + 0.028 * Math.sin(3.1 * t)
        v.level = 0.5 + 0.3 * Math.sin(3.1 * t)
        v.low = 0.5 + 0.4 * Math.sin(5 * t)
        v.mid = 0.5 + 0.4 * Math.sin(3 * t + 1)
        v.high = 0.5 + 0.4 * Math.sin(4 * t + 2)
        const calls = step(r, mode, 1, side === "user" ? { reduced: true, user: v } : { reduced: true, agent: v })
        const shape = JSON.stringify(points(calls))
        if (prev !== null && shape !== prev) {
          changes++
          expect(i - lastChange, `${mode}: frames between two steps of the shape`).toBeGreaterThanOrEqual(59)
          lastChange = i
        }
        prev = shape
      }
      expect(changes, `${mode}: steps in ${frames} frames`).toBeLessThanOrEqual(Math.ceil(frames * DT))
      expect(changes, `${mode}: the held shape still follows the voice`).toBeGreaterThan(0)
    }
  })

  it("keeps the lab's options: five lines, no glow", () => {
    const calls = step(make({ lines: 5, glow: false }), "hearing", 30, { user: loud() })
    expect(calls.filter((c) => c.name === "stroke")).toHaveLength(5)
    expect(calls.filter((c) => c.name === "=shadowBlur").every((c) => c.args[0] === 0)).toBe(true)
  })
})

describe("on the whole stage (docs/CHARACTERS.md §2.6)", () => {
  it("is a stage character", () => {
    expect(baseline.canvas).toBe("stage")
  })

  it("at rest, in every mode, draws exactly what it draws in the box, moved to the focus", () => {
    for (const mode of [...CORE_MODES, ...(Object.keys(EXTRA_MODES) as Array<Mode>)]) {
      const inBox = step(make(), mode, 90)
      const onStage = step(make({}, STAGE), mode, 90, { focus: BOX })
      const moved = placed(inBox).map(([x, y]) => [x + BOX.x, y + BOX.y])
      const got = placed(onStage)
      expect(got.length, mode).toBe(moved.length)
      got.forEach(([x, y], i) => {
        expect(x, `${mode} x`).toBeCloseTo(moved[i]![0]!, 6)
        // Within half a pixel: thinking's fixed level (0.08) adds 0.08² of the reach, under 0.4 px.
        expect(Math.abs(y - moved[i]![1]!), `${mode} y`).toBeLessThan(0.5)
      })
      expect(strokes(onStage), mode).toEqual(strokes(inBox))
    }
  })

  it("a loud voice swings past the box, but not by more than the reach, nor off the canvas", () => {
    const inBox = amplitude(step(make(), "hearing", 30, { user: loud() }))
    const calls = step(make({}, STAGE), "hearing", 30, { user: loud(), focus: BOX })
    const ys = placed(calls).map(([, y]) => y - (BOX.y + H / 2))
    const onStage = Math.max(...ys.map(Math.abs))
    expect(onStage).toBeGreaterThan(inBox * 1.05)
    expect(onStage).toBeLessThan(0.38 * H + 0.25 * H + 1)
    // The lines keep the box's width.
    const xs = placed(calls).map(([x]) => x)
    expect(Math.min(...xs)).toBeCloseTo(BOX.x, 6)
    expect(Math.max(...xs)).toBeLessThanOrEqual(BOX.x + W)
  })

  it("follows the focus between frames without a resize, and keeps the muted gap on the box's centre", () => {
    const r = make({}, STAGE)
    step(r, "muted", 10, { focus: BOX })
    const moved = { ...BOX, x: BOX.x - 200 }
    const xs = placed(step(r, "muted", 1, { focus: moved })).map(([x]) => x)
    expect(Math.min(...xs)).toBeCloseTo(moved.x, 6)
    const mid = moved.x + W / 2
    expect(xs.some((x) => Math.abs(x - mid) < 24)).toBe(false)
    expect(xs.some((x) => Math.abs(x - mid) < 30)).toBe(true)
  })

  it("a focus wider than the canvas (never sent, but possible) does not overrun its buffers", () => {
    const r = make({}, [400, 300])
    expect(() => step(r, "hearing", 5, { user: loud(), focus: { x: -100, y: 50, width: 900, height: 200 } })).not.toThrow()
  })
})

describe("the observer's stand-in voices give the old observer levels through the baseline's formulas", () => {
  it("hearing: √(rms·9) = 0.3 + 0.15·noise(1.3 t); speaking: √(rms·5) = 0.35 + 0.15·noise(t); listening: rms·4 = 0.03", () => {
    const u = standInUser()
    const a = standInAgent()
    for (const t of [0.5, 1.7, 4.2, 9.9]) {
      expect(Math.sqrt(u.step("voice", t, DT).rms * 9)).toBeCloseTo(0.3 + 0.15 * noise(t * 1.3), 9)
      expect(Math.sqrt(a.step("voice", t, DT).rms * 5)).toBeCloseTo(0.35 + 0.15 * noise(t), 9)
    }
    expect(u.step("room", 1, DT).rms * 4).toBeCloseTo(0.03, 9)
    const f = a.step("voice", 2, DT)
    expect(f.low).toBe(f.mid) // equal shares: the old observer's speaking weights (a third each)
    expect(f.mid).toBe(f.high)
  })
})
