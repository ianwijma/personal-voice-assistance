/**
 * The baseline (sine lines) looks as the stage did before characters existed, in every visual state
 * (docs/UI-AND-MODULES.md §3.3): checked on the calls it makes, through the runner, on the recording canvas.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Mode, Palette, VoiceFeatures } from "@/characters/contract.ts"
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

const make = (stored: Record<string, number | boolean | string> = {}) => {
  const canvas = document.createElement("canvas")
  const r = new Runner(baseline, canvas, stored)
  r.create()
  r.resize(W, H, 1)
  return r
}

const loud = (): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.rms = 0.05
  f.level = 0.5
  f.low = f.mid = f.high = 0.5
  return f
}
const quiet = createVoiceFeatures()

/** Step `frames` frames; returns the calls of the last one. */
const step = (r: Runner, mode: Mode, frames: number, o: { user?: VoiceFeatures; agent?: VoiceFeatures; palette?: Palette; reduced?: boolean; sinceInterrupt?: number } = {}): Array<Call> => {
  let last: Array<Call> = []
  for (let i = 0; i < frames; i++) {
    recording.log = []
    r.step({ mode, dt: DT, user: o.user ?? quiet, agent: o.agent ?? quiet, palette: o.palette ?? PALETTES.dark, reducedMotion: o.reduced === true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: o.sinceInterrupt ?? Infinity })
    last = recording.log
  }
  recording.log = null
  return last
}

const strokes = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "=strokeStyle").map((c) => String(c.args[0]))
const points = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "lineTo" || c.name === "moveTo").map((c) => [c.args[0] as number, c.args[1] as number] as const)
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

  it("keeps the lab's options: five lines, no glow", () => {
    const calls = step(make({ lines: 5, glow: false }), "hearing", 30, { user: loud() })
    expect(calls.filter((c) => c.name === "stroke")).toHaveLength(5)
    expect(calls.filter((c) => c.name === "=shadowBlur").every((c) => c.args[0] === 0)).toBe(true)
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
