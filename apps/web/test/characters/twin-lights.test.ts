/**
 * Twin lights, the behaviour that is its own (the shared suites in `compat.test.ts`, `baseline.test.ts` and
 * `isolation.test.ts` already run it through the manifest, the modes, the option extremes, reduced-motion stillness,
 * the digest and the stage checks): which light is whose, whose turn is the larger, what a syllable does to the
 * motes (one per onset, from the speaker, as high as the pitch, hollow when breathy), what the options promise, and
 * what reduced motion shows instead of motes. Checked on the calls it makes, through the runner, on the recording canvas.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Focus, Mode, Palette, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import twinLights from "@/characters/library/twin-lights.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
/** The same value as `MARGIN` in the character: the room kept above the motes' peaks and beside the lights. */
const MARGIN = 6
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Shape = { readonly kind: "fill" | "stroke"; readonly x: number; readonly y: number; readonly r: number }

const make = (stored: Record<string, number | boolean | string> = {}, size: readonly [number, number] = [W, H]) => {
  const canvas = document.createElement("canvas")
  const r = new Runner(twinLights, canvas, stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

/** A voice that is speaking now: loud, voiced, mid pitch, and no syllable starting unless `onset` says so. */
const voice = (o: Partial<VoiceFeatures> = {}): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.level = 0.5
  f.rms = 0.05
  f.speaking = true
  f.voicing = 1
  f.pitch = 0.5
  f.syllableRate = 4
  return Object.assign(f, o)
}
const quiet = createVoiceFeatures()

interface StepOptions {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly palette?: Palette
  readonly reduced?: boolean
  readonly pointer?: { readonly x: number; readonly y: number; readonly down: boolean; readonly inside: boolean }
  readonly focus?: Focus
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
    sinceInterrupt: Infinity,
    ...(o.focus !== undefined ? { focus: o.focus } : {})
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

/** The circles filled or stroked, in drawing order, in the canvas's own (CSS px) coordinates of the box. */
const shapes = (calls: ReadonlyArray<Call>): Array<Shape> => {
  const out: Array<Shape> = []
  let arc: readonly [number, number, number] | null = null
  for (const c of calls) {
    if (c.name === "beginPath") arc = null
    else if (c.name === "arc") arc = [c.args[0] as number, c.args[1] as number, c.args[2] as number]
    else if ((c.name === "fill" || c.name === "stroke") && arc !== null) out.push({ kind: c.name, x: arc[0], y: arc[1], r: arc[2] })
  }
  return out
}
/** The two lights' bodies are the last two circles of a frame (no halo ring while not listening). Yours is first. */
const lights = (calls: ReadonlyArray<Call>): readonly [Shape, Shape] => {
  const s = shapes(calls)
  return [s[s.length - 2]!, s[s.length - 1]!]
}
/** What is in the air: every circle before the lights. */
const motes = (calls: ReadonlyArray<Call>): Array<Shape> => shapes(calls).slice(0, -2)

/** The syllable at frame `i`: onset 1 on exactly the frames in `at`, else 0. */
const syllables = (at: ReadonlyArray<number>, base: Partial<VoiceFeatures> = {}) => (i: number): VoiceFeatures => voice({ ...base, onset: at.includes(i) ? 1 : 0 })

/** Run `n` frames from the first one in `mode`, the voice given per frame; the calls of every frame. */
const run = (r: Runner, mode: Mode, n: number, who: "user" | "agent", at: (i: number) => VoiceFeatures, o: StepOptions = {}): Array<Array<Call>> => {
  const out: Array<Array<Call>> = []
  for (let i = 0; i < n; i++) out.push(frame(r, mode, { ...o, [who]: at(i) }))
  return out
}

beforeEach(() => {
  recording.log = null
})

describe("twin lights: whose light is whose", () => {
  it("yours is on the left and the assistant's on the right, and 'Your side: right' mirrors them", () => {
    const left = lights(settle(make(), "idle", 90, { reduced: true }))
    const right = lights(settle(make({ yourSide: "right" }), "idle", 90, { reduced: true }))
    expect(left[0].x).toBeLessThan(left[1].x)
    expect(right[0].x).toBeGreaterThan(right[1].x)
    // Mirrored about the centre of the box.
    expect(left[0].x + left[1].x).toBeCloseTo(W, 3)
    expect(right[0].x).toBeCloseTo(left[1].x, 3)
    expect(right[1].x).toBeCloseTo(left[0].x, 3)
  })

  it("'Distance apart' spreads the lights, within what the box can hold", () => {
    const gap = (stored: Record<string, number>, size: readonly [number, number]) => {
      const [a, b] = lights(settle(make(stored, size), "idle", 90, { reduced: true }))
      return b.x - a.x
    }
    expect(gap({ distance: 0.5 }, [W, H])).toBeLessThan(gap({ distance: 1 }, [W, H]))
    expect(gap({ distance: 1 }, [W, H])).toBeLessThan(gap({ distance: 1.3 }, [W, H]))
  })

  it("at the widest setting and the biggest size, both lights (their whole body, not just the core) stay inside the box, even in the smallest cell", () => {
    for (const size of [[160, 140], [W, H], [900, 420]] as const) {
      for (const mode of ["listening", "hearing", "speaking"] as const) {
        const r = make({ distance: 1.3, size: 1.5 }, size)
        const calls = settle(r, mode, 90, { reduced: true, user: voice({ level: 1 }), agent: voice({ level: 1 }) })
        for (const l of lights(calls)) {
          // The core is drawn at 0.62 of the light's radius.
          const body = l.r / 0.62
          expect(l.x - body, `${size.join("×")} ${mode}: left edge`).toBeGreaterThanOrEqual(0)
          expect(l.x + body, `${size.join("×")} ${mode}: right edge`).toBeLessThanOrEqual(size[0])
          expect(l.y - body, `${size.join("×")} ${mode}: top edge`).toBeGreaterThanOrEqual(0)
          expect(l.y + body, `${size.join("×")} ${mode}: bottom edge`).toBeLessThanOrEqual(size[1])
        }
      }
    }
  })
})

describe("twin lights: whoever has the turn is the larger light", () => {
  const radii = (mode: Mode, o: StepOptions) => {
    const [a, b] = lights(settle(make(), mode, 90, { reduced: true, ...o }))
    return { you: a.r, assistant: b.r }
  }

  it("idle: equal; listening and hearing: yours; thinking and speaking: the assistant's", () => {
    const idle = radii("idle", {})
    expect(idle.you).toBeCloseTo(idle.assistant, 6)
    expect(radii("listening", {}).you).toBeGreaterThan(radii("listening", {}).assistant)
    const hearing = radii("hearing", { user: voice({ level: 0.5 }) })
    expect(hearing.you).toBeGreaterThan(hearing.assistant)
    const thinking = radii("thinking", {})
    expect(thinking.assistant).toBeGreaterThan(thinking.you)
    const speaking = radii("speaking", { agent: voice({ level: 0.5 }) })
    expect(speaking.assistant).toBeGreaterThan(speaking.you)
  })

  it("the speaker's light grows with the loudness, the listener's does not", () => {
    const soft = radii("hearing", { user: voice({ level: 0.1 }) })
    const loud = radii("hearing", { user: voice({ level: 0.9 }) })
    expect(loud.you).toBeGreaterThan(soft.you * 1.1)
    expect(loud.assistant).toBeCloseTo(soft.assistant, 6)
    const softA = radii("speaking", { agent: voice({ level: 0.1 }) })
    const loudA = radii("speaking", { agent: voice({ level: 0.9 }) })
    expect(loudA.assistant).toBeGreaterThan(softA.assistant * 1.1)
    expect(loudA.you).toBeCloseTo(softA.you, 6)
  })

  it("while thinking the two lights circle each other, closer than they sit apart", () => {
    const apart = lights(settle(make(), "idle", 90, { reduced: true }))
    const r = make()
    settle(r, "thinking", 120)
    const seen: Array<readonly [Shape, Shape]> = []
    for (let i = 0; i < 90; i++) seen.push(lights(frame(r, "thinking")))
    const gaps = seen.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y))
    expect(Math.max(...gaps)).toBeLessThan(apart[1].x - apart[0].x)
    // They circle: the line between them turns over the second and a half.
    const angles = seen.map(([a, b]) => Math.atan2(b.y - a.y, b.x - a.x))
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(0.5)
  })
})

describe("twin lights: syllables become motes", () => {
  const alive = (n: number, who: "user" | "agent", mode: Mode, at: (i: number) => VoiceFeatures, stored = {}) => {
    const r = make(stored)
    const frames = run(r, mode, n, who, at)
    return frames
  }

  it("each syllable onset sends one mote; a held onset sends no more, and a falling-then-rising one sends another", () => {
    const held = alive(12, "user", "hearing", (i) => voice({ onset: i >= 2 ? 1 : 0 }))
    expect(motes(held[11]!)).toHaveLength(1)
    const twice = alive(14, "user", "hearing", (i) => voice({ onset: i === 2 || i === 8 ? 1 : 0 }))
    expect(motes(twice[13]!)).toHaveLength(2)
    expect(motes(alive(14, "user", "hearing", () => voice())[13]!)).toHaveLength(0)
  })

  it("a faint onset (a whisper's, 0.4) counts; one below the threshold does not", () => {
    const whisper = alive(8, "user", "hearing", (i) => voice({ onset: i === 2 ? 0.4 : 0 }))
    expect(motes(whisper[7]!)).toHaveLength(1)
    const murmur = alive(8, "user", "hearing", (i) => voice({ onset: i === 2 ? 0.25 : 0 }))
    expect(motes(murmur[7]!)).toHaveLength(0)
  })

  it("no motes while the voice is not the one being heard: another mode's onsets are ignored", () => {
    for (const mode of ["idle", "listening", "thinking"] as const) {
      // The same circles as with no syllables at all (listening has its halo ring, which is not a mote).
      const withSyllable = alive(10, "user", mode, syllables([2]))
      const without = alive(10, "user", mode, () => voice())
      expect(shapes(withSyllable[9]!).length, mode).toBe(shapes(without[9]!).length)
    }
    // While you speak, the assistant's features are not read, and the other way round.
    const wrong = run(make(), "hearing", 10, "agent", syllables([2]))
    expect(motes(wrong[9]!)).toHaveLength(0)
    const wrongA = run(make(), "speaking", 10, "user", syllables([2]))
    expect(motes(wrongA[9]!)).toHaveLength(0)
  })

  it("the motes fly from you to the assistant while hearing, and from the assistant to you while speaking", () => {
    const hear = run(make(), "hearing", 60, "user", syllables([2]))
    const [you, assistant] = lights(hear[59]!)
    const early = motes(hear[4]!)[0]!
    const late = motes(hear[55]!)[0]!
    expect(Math.abs(early.x - you.x)).toBeLessThan(Math.abs(early.x - assistant.x))
    expect(Math.abs(late.x - assistant.x)).toBeLessThan(Math.abs(late.x - you.x))

    const say = run(make(), "speaking", 60, "agent", syllables([2]))
    const [you2, assistant2] = lights(say[59]!)
    const early2 = motes(say[4]!)[0]!
    const late2 = motes(say[55]!)[0]!
    expect(Math.abs(early2.x - assistant2.x)).toBeLessThan(Math.abs(early2.x - you2.x))
    expect(Math.abs(late2.x - you2.x)).toBeLessThan(Math.abs(late2.x - assistant2.x))
  })

  it("a mote lands and is gone within about a second and a half, and the receiving light swells as it lands", () => {
    const r = make()
    const frames = run(r, "hearing", 130, "user", syllables([2]))
    expect(motes(frames[20]!).length).toBe(1)
    expect(motes(frames[129]!)).toHaveLength(0)
    // The listener (the assistant's light) swells a little when the mote arrives, then relaxes.
    const radius = frames.map((c) => lights(c)[1].r)
    const rest = radius[0]!
    expect(Math.max(...radius)).toBeGreaterThan(rest * 1.05)
    expect(radius[129]!).toBeCloseTo(rest, 1)
  })

  it("a higher voice flies a higher arc: pitch sets the height", () => {
    const peak = (pitch: number, stored = {}) => {
      const frames = run(make(stored), "hearing", 90, "user", syllables([2], { pitch }))
      const ys = frames.flatMap((c) => motes(c).map((m) => m.y))
      const [a, b] = lights(frames[89]!)
      return { top: Math.min(...ys), lightsTop: Math.min(a.y, b.y) }
    }
    const deep = peak(0.1)
    const child = peak(0.9)
    expect(child.top).toBeLessThan(deep.top - 30)
    // A deep voice flies nearly flat; a child's well above the lights.
    expect(deep.lightsTop - deep.top).toBeLessThan(40)
    expect(child.lightsTop - child.top).toBeGreaterThan(60)
  })

  it("'Flight height: 0' sends every mote straight across, whatever the pitch", () => {
    const frames = run(make({ arcHeight: 0 }), "hearing", 90, "user", syllables([2], { pitch: 0.9 }))
    const [a, b] = lights(frames[89]!)
    const ys = frames.flatMap((c) => motes(c).map((m) => m.y))
    expect(ys.length).toBeGreaterThan(0)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(Math.min(a.y, b.y) - 1)
    expect(Math.max(...ys)).toBeLessThanOrEqual(Math.max(a.y, b.y) + 1)
  })

  it("a rising voice bends the arc toward the listener, a falling one toward the speaker", () => {
    // Mote positions at mid-flight: the arc's peak is nearer the assistant for a question than for a statement.
    const midX = (pitchDelta: number) => {
      const frames = run(make(), "hearing", 120, "user", (i) => voice({ onset: i === 2 ? 1 : 0, pitchDelta, pitch: 0.9 }))
      // The frame where the mote is highest, i.e. the peak of the arc.
      let best = { y: Infinity, x: 0 }
      for (const c of frames) for (const m of motes(c)) if (m.y < best.y) best = m
      const [a, b] = lights(frames[119]!)
      return (best.x - a.x) / (b.x - a.x)
    }
    const rising = midX(8)
    const falling = midX(-8)
    expect(rising).toBeGreaterThan(falling + 0.05)
  })

  it("a loud syllable is a bigger mote than a soft one", () => {
    const size = (level: number) => {
      const frames = run(make(), "hearing", 20, "user", syllables([2], { level }))
      return Math.max(...frames.flatMap((c) => motes(c).map((m) => m.r)))
    }
    expect(size(0.9)).toBeGreaterThan(size(0.1) * 1.2)
  })

  it("a voiced syllable is a solid point of light, a breathy one (a whisper) a hollow ring", () => {
    const kind = (voicing: number) => {
      // The voice has been breathy (or not) for a while before the syllable, so the smoothed voicing is settled.
      const frames = run(make(), "hearing", 60, "user", (i) => voice({ voicing, onset: i === 50 ? 1 : 0 }))
      return motes(frames[55]!).map((m) => m.kind)
    }
    expect(kind(1)).toEqual(["fill"])
    expect(kind(0)).toEqual(["stroke"])
  })

  it("a mote is a ring in the 'Rings' style, and the lights are outlined too", () => {
    const frames = run(make({ style: "rings" }), "hearing", 20, "user", syllables([2]))
    const last = frames[19]!
    expect(motes(last).map((m) => m.kind)).toEqual(["stroke"])
    expect(lights(last).map((l) => l.kind)).toEqual(["stroke", "stroke"])
  })

  it("the 'Flat' style keeps solid discs, and the default fills the lights", () => {
    expect(lights(settle(make({ style: "flat" }), "hearing", 30, { user: voice() })).map((l) => l.kind)).toEqual(["fill", "fill"])
    expect(lights(settle(make(), "hearing", 30, { user: voice() })).map((l) => l.kind)).toEqual(["fill", "fill"])
  })

  it("tails: 'Mote tails' off draws fewer glow sprites around a mote than on", () => {
    const sprites = (trails: boolean) => {
      const frames = run(make({ trails }), "hearing", 20, "user", syllables([2]))
      return frames[19]!.filter((c) => c.name === "drawImage").length
    }
    expect(sprites(true)).toBeGreaterThan(sprites(false))
  })

  it("the motes' peaks stay below the top of the canvas even when the box sits at its top edge", () => {
    const focus: Focus = { x: 280, y: 12, width: W, height: H }
    const frames = run(make({ arcHeight: 2 }, [1280, 800]), "hearing", 90, "user", syllables([2], { pitch: 1 }), { focus })
    const tops = frames.flatMap((c) => motes(c).map((m) => m.y + focus.y))
    expect(tops.length).toBeGreaterThan(0)
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(MARGIN - 0.5)
    // ...and without the cap the same flight would have gone off the top: a box with room flies higher.
    const roomy = run(make({ arcHeight: 2 }, [1280, 800]), "hearing", 90, "user", syllables([2], { pitch: 1 }), { focus: { ...focus, y: 400 } })
    const roomyTops = roomy.flatMap((c) => motes(c).map((m) => m.y + 400))
    expect(Math.min(...roomyTops) - 400).toBeLessThan(Math.min(...tops) - focus.y - 20)
  })
})

describe("twin lights: the pointer", () => {
  const press = (px: number, o: { reduced?: boolean; inside?: boolean } = {}) => ({ x: px, y: H / 2, down: true, inside: o.inside ?? true })

  it("pressing near a light sends motes from that light to the other", () => {
    const rest = lights(settle(make(), "idle", 30))
    for (const [side, near] of [["yours", rest[0].x], ["the assistant's", rest[1].x]] as const) {
      const r = make()
      settle(r, "idle", 30)
      // A press sends a mote on about one frame in twelve: the first one is still at its light.
      let first: Shape | undefined
      for (let i = 0; i < 300 && first === undefined; i++) first = motes(frame(r, "idle", { pointer: press(near) }))[0]
      expect(first, `${side}: a mote appears`).toBeDefined()
      const other = near === rest[0].x ? rest[1].x : rest[0].x
      expect(Math.abs(first!.x - near), `${side}: the mote starts at its own light`).toBeLessThan(Math.abs(first!.x - other))
    }
  })

  it("does nothing when the pointer is outside the box, not pressed, or the user prefers reduced motion", () => {
    const r = make()
    settle(r, "idle", 30)
    for (let i = 0; i < 60; i++) {
      expect(motes(frame(r, "idle", { pointer: press(W / 2, { inside: false }) }))).toHaveLength(0)
      expect(motes(frame(r, "idle", { pointer: { x: W / 2, y: H / 2, down: false, inside: true } }))).toHaveLength(0)
    }
    // On the stage `inside` is true anywhere in the window: a press outside the box sends nothing.
    for (const [x, y] of [[-50, H / 2], [W + 50, H / 2], [W / 2, -50], [W / 2, H + 50]] as const) {
      for (let i = 0; i < 60; i++) expect(motes(frame(r, "idle", { pointer: { x, y, down: true, inside: true } })), `${x},${y}`).toHaveLength(0)
    }
    const calm = make()
    settle(calm, "idle", 30, { reduced: true })
    for (let i = 0; i < 60; i++) expect(shapes(frame(calm, "idle", { reduced: true, pointer: press(W / 2) }))).toHaveLength(2)
  })

  it("hovering a light swells a glow around it, and not one far from both", () => {
    const r = make()
    const rest = lights(settle(r, "idle", 30))
    const sprites = (x: number, y: number) => frame(r, "idle", { pointer: { x, y, down: false, inside: true } }).filter((c) => c.name === "drawImage").length
    const far = sprites(W / 2, H - 4)
    expect(sprites(rest[0].x, rest[0].y)).toBeGreaterThan(far)
    expect(sprites(rest[1].x, rest[1].y)).toBeGreaterThan(far)
  })
})

describe("twin lights: reduced motion", () => {
  /** The chevrons' arrowheads (three of them): the tip is the middle point of each moveTo-lineTo-lineTo. */
  const chevrons = (calls: ReadonlyArray<Call>) => {
    const out: Array<{ tip: readonly [number, number]; tail: readonly [number, number] }> = []
    const pts: Array<readonly [number, number]> = []
    let sinceDash = false
    for (const c of calls) {
      if (c.name === "setLineDash" && (c.args[0] as Array<number>).length === 0) sinceDash = true
      else if (sinceDash && (c.name === "moveTo" || c.name === "lineTo")) pts.push([c.args[0] as number, c.args[1] as number])
    }
    for (let i = 0; i + 2 < pts.length; i += 3) out.push({ tail: pts[i]!, tip: pts[i + 1]! })
    return out
  }
  /** +1 if the arrowheads point to the right, −1 to the left. */
  const pointing = (calls: ReadonlyArray<Call>) => {
    const ch = chevrons(calls)
    expect(ch).toHaveLength(3)
    const dirs = ch.map((c) => Math.sign(c.tip[0] - c.tail[0]))
    expect(new Set(dirs).size).toBe(1)
    return dirs[0]!
  }
  const quietRun = (mode: Mode, stored: Record<string, string> = {}) => settle(make(stored), mode, 90, { reduced: true, user: voice({ onset: 1 }), agent: voice({ onset: 1 }) })

  it("draws no motes, however many syllables the voice has", () => {
    for (const mode of ["hearing", "speaking"] as const) {
      const r = make()
      const frames = run(r, mode, 60, mode === "hearing" ? "user" : "agent", (i) => voice({ onset: i % 4 === 0 ? 1 : 0 }), { reduced: true })
      for (const c of frames) expect(shapes(c), mode).toHaveLength(2)
    }
  })

  it("shows which way the words go: chevrons pointing at the assistant while you speak, at you while it speaks", () => {
    expect(pointing(quietRun("hearing"))).toBe(1)
    expect(pointing(quietRun("speaking"))).toBe(-1)
  })

  it("the chevrons turn round with 'Your side: right'", () => {
    expect(pointing(quietRun("hearing", { yourSide: "right" }))).toBe(-1)
    expect(pointing(quietRun("speaking", { yourSide: "right" }))).toBe(1)
  })

  it("while listening or idle there is a plain path at most, and no chevrons", () => {
    expect(chevrons(quietRun("listening"))).toHaveLength(0)
    expect(chevrons(quietRun("idle"))).toHaveLength(0)
    expect(chevrons(quietRun("thinking"))).toHaveLength(0)
    // A still dotted path joins the lights while listening.
    expect(quietRun("listening").some((c) => c.name === "setLineDash" && (c.args[0] as Array<number>).length === 2)).toBe(true)
  })

  it("switching it on while motes are in the air clears them, and none come back", () => {
    for (const mode of ["hearing", "speaking"] as const) {
      const who = mode === "hearing" ? "user" : "agent"
      const r = make()
      const before = run(r, mode, 20, who, syllables([2]))
      expect(motes(before[19]!).length, mode).toBeGreaterThan(0)
      for (let i = 0; i < 120; i++) expect(shapes(frame(r, mode, { reduced: true, [who]: voice() })), mode).toHaveLength(2)
      expect(shapes(frame(r, "idle", { reduced: true }))).toHaveLength(2)
      // Switched off again: nothing left over from before.
      expect(motes(frame(r, "idle"))).toHaveLength(0)
    }
  })

  it("is the same on every frame: no orbit, no breathing, no creeping dashes", () => {
    for (const mode of ["listening", "thinking", "hearing", "speaking"] as const) {
      const r = make()
      const a = settle(r, mode, 90, { reduced: true, user: voice({ onset: 1 }), agent: voice({ onset: 1 }) })
      const b = settle(r, mode, 30, { reduced: true, user: voice({ onset: 1 }), agent: voice({ onset: 1 }) })
      const before = shapes(a)
      const after = shapes(b)
      expect(after.length, mode).toBe(before.length)
      after.forEach((s, i) => {
        expect(s.kind, mode).toBe(before[i]!.kind)
        for (const k of ["x", "y", "r"] as const) expect(s[k], `${mode} ${k}`).toBeCloseTo(before[i]![k], 4)
      })
      expect(b.filter((c) => c.name === "=lineDashOffset").every((c) => c.args[0] === 0), mode).toBe(true)
    }
  })
})

describe("twin lights: per-frame allocation", () => {
  const dashes = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "setLineDash").map((c) => c.args[0] as Array<number>)

  it("the dash arrays are the same objects on every frame, also under reduced motion", () => {
    for (const [mode, reduced] of [["listening", false], ["hearing", true], ["speaking", true]] as const) {
      const r = make()
      const o: StepOptions = { reduced, user: voice(), agent: voice() }
      settle(r, mode, 60, o)
      const a = dashes(frame(r, mode, o))
      const b = dashes(frame(r, mode, o))
      expect(a.length, mode).toBe(2)
      expect(b.length, mode).toBe(2)
      expect(b[0], `${mode}: the dash`).toBe(a[0])
      expect(b[1], `${mode}: the reset`).toBe(a[1])
    }
  })
})

describe("twin lights: a focus partly above the page", () => {
  it("the motes never bend downward, whatever the focus's top is", () => {
    for (const y of [-150, -400]) {
      const focus: Focus = { x: 280, y, width: W, height: H }
      const frames = run(make({}, [1280, 800]), "hearing", 90, "user", syllables([2], { pitch: 0.9 }), { focus })
      const [a, b] = lights(frames[89]!)
      const ys = frames.flatMap((c) => motes(c).map((m) => m.y))
      expect(ys.length, `y ${y}`).toBeGreaterThan(0)
      expect(Math.max(...ys), `y ${y}`).toBeLessThanOrEqual(Math.max(a.y, b.y) + 1)
    }
  })
})

describe("twin lights: on the whole stage", () => {
  const BOX: Focus = { x: 280, y: 200, width: W, height: H }

  it("lays the lights out in the focus, not on the page: moving the box moves them with it", () => {
    const at = (focus: Focus) => lights(settle(make({}, [1280, 800]), "idle", 60, { reduced: true, focus }))
    const a = at(BOX)
    const b = at({ ...BOX, x: BOX.x + 100, y: BOX.y + 50 })
    // Drawn relative to the focus: the same local positions, whatever the offset.
    expect(b[0].x).toBeCloseTo(a[0].x, 3)
    expect(b[1].y).toBeCloseTo(a[1].y, 3)
    // A smaller focus brings them closer.
    const small = at({ ...BOX, width: 240, height: 160 })
    expect(small[1].x - small[0].x).toBeLessThan(a[1].x - a[0].x)
  })
})
