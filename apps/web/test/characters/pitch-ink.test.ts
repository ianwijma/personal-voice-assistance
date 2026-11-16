/**
 * What is particular to "Pitch ink" (src/characters/library/pitch-ink.ts): the pen's height follows the pitch of
 * the voice, it stays in its own stave, the line breaks where the voice is unvoiced, stipples for a whisper,
 * spatters on "s", and the hover label reads the pitch under the pointer. Driven the way the host drives it
 * (through the runner, on the recording canvas) with hand-set voice features, so each case is exact.
 * The groundwork suites (compat, baseline, isolation) already cover manifests, option extremes, digests and cost.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Mode, OptionValues, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import pitchInk from "@/characters/library/pitch-ink.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Pointer = { x: number; y: number; down: boolean; inside: boolean }

const make = (stored: OptionValues = {}) => {
  const r = new Runner(pitchInk, document.createElement("canvas"), stored)
  r.create()
  r.resize(W, H, 1)
  return r
}

/** A voice: voiced speech at `pitchHz` unless overridden. `pitch` is the log-scale position the character draws. */
const voice = (o: Partial<VoiceFeatures> = {}): VoiceFeatures => ({ ...createVoiceFeatures(), speaking: true, level: 0.5, rms: 0.05, voicing: 1, pitchHz: 200, pitch: 0.5, register: 0.5, ...o })
const silent = createVoiceFeatures()

const NO_POINTER: Pointer = { x: 0, y: 0, down: false, inside: false }

interface StepOptions {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly reduced?: boolean
  readonly pointer?: Pointer
  readonly focus?: { x: number; y: number; width: number; height: number }
}

/** Steps `frames` frames; returns the calls of the last one. `voices(i)` may vary the voice per frame. */
const step = (r: Runner, mode: Mode, frames: number, o: StepOptions | ((i: number) => StepOptions) = {}): Array<Call> => {
  let last: Array<Call> = []
  for (let i = 0; i < frames; i++) {
    const s = typeof o === "function" ? o(i) : o
    recording.log = []
    r.step({ mode, dt: DT, user: s.user ?? silent, agent: s.agent ?? silent, palette: PALETTES.dark, reducedMotion: s.reduced === true, pointer: s.pointer ?? NO_POINTER, sinceInterrupt: Infinity, ...(s.focus !== undefined ? { focus: s.focus } : {}) })
    last = recording.log
  }
  recording.log = null
  return last
}

const secs = (n: number) => Math.round(n / DT)
const arcs = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "arc")
/** The pen's nib is the last thing drawn in the ink part of the frame: a disc and its smaller centre, at the pen's position. */
const nib = (calls: ReadonlyArray<Call>) => {
  const a = arcs(calls)
  const outer = a[a.length - 2]!.args as ReadonlyArray<number>
  return { x: outer[0]!, y: outer[1]!, radius: outer[2]! }
}
const count = (calls: ReadonlyArray<Call>, name: string) => calls.filter((c) => c.name === name).length
/** The calls as plain data (a gradient object is a fresh object each frame, so it is reduced to its kind). */
const plain = (calls: ReadonlyArray<Call>) => calls.map((c) => [c.name, ...c.args.map((a) => (typeof a === "object" && a !== null && !Array.isArray(a) ? "object" : a))])
const labels = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "fillText").map((c) => String(c.args[0]))

beforeEach(() => {
  recording.log = null
})

describe("pitch ink: the pen's height", () => {
  it("a higher pitch writes higher on the stave, a lower one lower", () => {
    const at = (pitch: number) => nib(step(make(), "hearing", secs(3), { user: voice({ pitch }) })).y
    const high = at(0.9)
    const mid = at(0.5)
    const low = at(0.1)
    expect(high).toBeLessThan(mid)
    expect(mid).toBeLessThan(low)
  })

  it("keeps the person in the upper stave and the assistant in the lower one", () => {
    const you = nib(step(make(), "hearing", secs(3), { user: voice() }))
    const agent = nib(step(make(), "speaking", secs(3), { agent: voice() }))
    expect(you.y).toBeLessThan(H * 0.45)
    expect(agent.y).toBeGreaterThan(H * 0.55)
  })

  it("rests on the centre rule when idle", () => {
    expect(nib(step(make(), "idle", secs(4))).y).toBeCloseTo(H / 2, 0)
  })

  it("with one shared stave, the same voice spans more of the height than in its own stave", () => {
    const spread = (staves: string) => {
      const high = nib(step(make({ staves }), "hearing", secs(3), { user: voice({ pitch: 0.95 }) })).y
      const low = nib(step(make({ staves }), "hearing", secs(3), { user: voice({ pitch: 0.05 }) })).y
      return low - high
    }
    expect(spread("shared")).toBeGreaterThan(spread("two") * 1.5)
  })

  it("melody zoom stretches the pitch around the voice's own register", () => {
    const rise = (zoom: number) => {
      const reg = nib(step(make({ zoom }), "hearing", secs(3), { user: voice({ pitch: 0.5, register: 0.5 }) })).y
      const up = nib(step(make({ zoom }), "hearing", secs(3), { user: voice({ pitch: 0.7, register: 0.5 }) })).y
      return reg - up
    }
    expect(rise(1)).toBeGreaterThan(0)
    expect(rise(2)).toBeGreaterThan(rise(1) * 1.8)
  })

  it("on the stage, a pitch far past the stave swings on but never closer than 12 px to the canvas edge, also with one shared stave", () => {
    const BOXED = { x: 280, y: 100, width: 720, height: 240 }
    const stage = (stored: OptionValues) => {
      const r = new Runner(pitchInk, document.createElement("canvas"), stored)
      r.create()
      r.resize(1280, 800, 1)
      return r
    }
    for (const staves of ["two", "shared"]) {
      const r = stage({ staves, zoom: 3 })
      const high = nib(step(r, "hearing", secs(3), { user: voice({ pitch: 1, register: 0.5 }), focus: BOXED })).y
      expect(high + BOXED.y).toBeGreaterThanOrEqual(12 - 1e-6)
      expect(high).toBeLessThan(H * 0.08) // and it does swing on past the top of the stave
      const low = nib(step(stage({ staves, zoom: 3 }), "hearing", secs(3), { user: voice({ pitch: 0, register: 0.5 }), focus: BOXED })).y
      expect(low + BOXED.y).toBeLessThanOrEqual(800 - 12 + 1e-6)
    }
  })

  it("when the box moves nearer the canvas edge, the ink already written is brought inside it too", () => {
    const r = new Runner(pitchInk, document.createElement("canvas"), { zoom: 3 })
    r.create()
    r.resize(1280, 800, 1)
    step(r, "hearing", secs(3), { user: voice({ pitch: 1, register: 0.5 }), focus: { x: 280, y: 100, width: 720, height: 240 } })
    const moved = { x: 280, y: 20, width: 720, height: 240 }
    const calls = step(r, "hearing", 1, { user: voice({ pitch: 1, register: 0.5 }), focus: moved })
    const ys = calls.filter((c) => c.name === "lineTo" || c.name === "moveTo").map((c) => c.args[1] as number)
    // The ribbon's edges lie up to a nib's half-width (about 7 px here) beyond the bounded centre line.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(12 - moved.y - 12)
    expect(nib(calls).y + moved.y).toBeGreaterThanOrEqual(12 - 1e-6)
  })

  it("is slew-limited: a single octave slip of the tracker cannot make the line jump", () => {
    const r = make({ zoom: 1 })
    const settled = nib(step(r, "hearing", secs(2), { user: voice({ pitch: 0.2, register: 0.5 }) })).y
    // 1.6 pitch units per second over a 0.82 span of a 0.37 H stave.
    const perFrame = ((1.6 * DT) / 0.82) * 0.37 * H
    const frames = 10
    const during = nib(step(r, "hearing", frames, { user: voice({ pitch: 0.95, register: 0.5 }) })).y
    expect(settled - during).toBeGreaterThan(0)
    expect(settled - during).toBeLessThanOrEqual(perFrame * frames + 1e-6)
    // And it does get there: a held new pitch is followed.
    const later = nib(step(r, "hearing", secs(2), { user: voice({ pitch: 0.95, register: 0.5 }) })).y
    expect(later).toBeLessThan(settled - 10 * perFrame)
  })
})

describe("pitch ink: the ink", () => {
  it("the pen's thickness follows loudness, the Ink thickness option and the pen choice", () => {
    const radius = (stored: OptionValues, level: number) => nib(step(make(stored), "hearing", secs(2), { user: voice({ level }) })).radius
    expect(radius({}, 0.9)).toBeGreaterThan(radius({}, 0.4))
    expect(radius({ thickness: 2 }, 0.9)).toBeGreaterThan(radius({ thickness: 1 }, 0.9) * 1.8)
    expect(radius({ pen: "fine" }, 0.9)).toBeLessThan(radius({ pen: "pen" }, 0.9))
    expect(radius({ pen: "brush" }, 0.9)).toBeGreaterThan(radius({ pen: "pen" }, 0.9))
  })

  it("the nib never gets thinner than a visible dot, even in silence", () => {
    expect(nib(step(make(), "listening", secs(2))).radius).toBeGreaterThanOrEqual(3)
  })

  it("voiced speech draws a ribbon and no stipple; the same sound unvoiced (a whisper) draws stipple and no ribbon", () => {
    const voiced = step(make(), "hearing", secs(2), { user: voice() })
    // Long enough for the first few bridged (still voiced) columns to have scrolled off the paper.
    const whisper = step(make(), "hearing", secs(8), { user: voice({ voicing: 0, pitchHz: 0, level: 0.3 }) })
    expect(count(voiced, "closePath")).toBeGreaterThan(0)
    expect(count(voiced, "rect")).toBe(0)
    expect(count(whisper, "closePath")).toBe(0)
    expect(count(whisper, "rect")).toBeGreaterThan(0)
  })

  it("a dip of voicing shorter than 60 ms does not lift the pen; a longer one breaks the line", () => {
    const runs = (dipFrames: number) => {
      const dip = voice({ voicing: 0, pitchHz: 0 })
      const frames = secs(1.5)
      const dipAt = secs(1)
      return count(step(make(), "hearing", frames, (i) => ({ user: i >= dipAt && i < dipAt + dipFrames ? dip : voice() })), "closePath")
    }
    expect(runs(0)).toBe(1)
    expect(runs(2)).toBe(1)
    expect(runs(secs(0.25))).toBe(2)
  })

  it("spatters on a sibilant 's', and the Spatter option turns it off", () => {
    const hiss = (stored: OptionValues, sibilance: number) => arcs(step(make(stored), "hearing", secs(2), { user: voice({ sibilance }) })).length
    const plain = hiss({}, 0)
    expect(hiss({}, 0.95)).toBeGreaterThan(plain)
    expect(hiss({ spatter: false }, 0.95)).toBe(plain)
  })

  it("both voices' ink stays on the paper after the turn passes to the assistant", () => {
    const r = make()
    step(r, "hearing", secs(2), { user: voice() })
    step(r, "thinking", secs(1))
    const calls = step(r, "speaking", secs(2), { agent: voice({ pitch: 0.3 }) })
    expect(count(calls, "closePath")).toBe(2)
  })
})

describe("pitch ink: the stave lines", () => {
  const startsAtLeftEdge = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "moveTo" && c.args[0] === W * 0.03).length

  it("draws three lines per stave and the dashed rule between them", () => {
    expect(startsAtLeftEdge(step(make(), "listening", 2))).toBe(3 + 3 + 1)
  })

  it("one shared stave has three lines and no rule; Stave lines off draws none", () => {
    expect(startsAtLeftEdge(step(make({ staves: "shared" }), "listening", 2))).toBe(3)
    expect(startsAtLeftEdge(step(make({ lines: false }), "listening", 2))).toBe(0)
  })
})

describe("pitch ink: hover", () => {
  const hover = (backCols: number): Pointer => ({ x: W * 0.8 - backCols * 2, y: H / 2, down: false, inside: true })

  it("shows the pitch of the ink under the pointer", () => {
    const r = make()
    const calls = step(r, "hearing", secs(3), { user: voice({ pitchHz: 187.4 }), pointer: hover(40) })
    expect(labels(calls)).toEqual(["187 Hz"])
  })

  it("reads the pitch at the column under the pointer, by where it was recorded on the paper", () => {
    // Each frame's pitch is its own number (100 Hz + frame), so the label tells which moment's ink is under the pointer.
    const frames = secs(6)
    const r2 = make()
    const out = step(r2, "hearing", frames, (i) => ({ user: voice({ pitchHz: 100 + i }), pointer: { x: W * 0.8 - 80, y: H / 2, down: false, inside: true } }))
    const hz = Number(labels(out)[0]!.replace(" Hz", ""))
    // At settled speed (86.4 px/s, 1.44 px a frame) 80 px of paper is about 55.6 frames back, not the 80 the 2 px/column guess gives.
    const framesBack = frames - 1 - (hz - 100)
    expect(framesBack).toBeGreaterThan(52)
    expect(framesBack).toBeLessThan(60)
  })

  it("still shows the pitch over continuous ink when a slow frame rate writes the columns far apart", () => {
    // At 10 frames a second the columns are about 8.6 px apart: a pointer 4 px behind the nib is more than 3 px from both neighbours.
    const r = make()
    let last: Array<Call> = []
    for (let i = 0; i < 60; i++) {
      recording.log = []
      r.step({ mode: "hearing", dt: 0.1, user: voice({ pitchHz: 187.4 }), agent: silent, palette: PALETTES.dark, reducedMotion: false, pointer: { x: W * 0.8 - 4, y: H / 2, down: false, inside: true }, sinceInterrupt: Infinity })
      last = recording.log
    }
    recording.log = null
    expect(labels(last)).toEqual(["187 Hz"])
  })

  it("shows no pitch over the blank paper after a voice stops, also at a slow frame rate", () => {
    // Voiced ink, then one silent frame: the pointer 4 px past the last voiced column is over blank paper.
    const r = make()
    let last: Array<Call> = []
    for (let i = 0; i < 61; i++) {
      recording.log = []
      r.step({ mode: "hearing", dt: 0.1, user: i < 60 ? voice({ pitchHz: 187.4 }) : silent, agent: silent, palette: PALETTES.dark, reducedMotion: false, pointer: { x: W * 0.8 - 4.6, y: H / 2, down: false, inside: true }, sinceInterrupt: Infinity })
      last = recording.log
    }
    recording.log = null
    expect(labels(last)).toEqual([])
  })

  it("keeps the pitch over ink that continues through a short unvoiced consonant", () => {
    // Fast paper (216 px/s), a settled voiced line, then one 50 ms frame of a consonant: still speaking, no pitch.
    // The ribbon bridges it, and the new column is about 10.8 px from the last voiced one.
    const r = make({ paper: 2.5 })
    step(r, "hearing", secs(4), { user: voice({ pitchHz: 187.4 }) })
    recording.log = []
    r.step({ mode: "hearing", dt: 0.05, user: voice({ voicing: 0, pitchHz: 0 }), agent: silent, palette: PALETTES.dark, reducedMotion: false, pointer: { x: W * 0.8 - 6.8, y: H / 2, down: false, inside: true }, sinceInterrupt: Infinity })
    const last = recording.log
    recording.log = null
    expect(labels(last)).toEqual(["187 Hz"])
  })

  it("shows nothing off the paper's end, outside the canvas, or over a dotted line that carries no voice", () => {
    const r = make()
    // Only about a second of paper has been written, so far back there is nothing.
    expect(labels(step(r, "hearing", secs(1), { user: voice(), pointer: hover(600) }))).toEqual([])
    expect(labels(step(make(), "hearing", secs(3), { user: voice(), pointer: { ...hover(40), inside: false } }))).toEqual([])
    // Listening writes a dotted line, even with a voiced signal present: no pitch label for it.
    const listening = make()
    expect(labels(step(listening, "listening", secs(4), { user: voice(), pointer: hover(40) }))).toEqual([])
  })
})

describe("pitch ink: reduced motion", () => {
  it("a steady voice draws a still picture; a louder one adds a step", () => {
    const r = make()
    const reduced = (level: number): StepOptions => ({ user: voice({ level }), reduced: true })
    step(r, "hearing", secs(2), reduced(0.3))
    const a = step(r, "hearing", 1, reduced(0.3))
    const b = step(r, "hearing", secs(1), reduced(0.3))
    expect(plain(b)).toEqual(plain(a))
    const louder = step(r, "hearing", secs(1), reduced(0.9))
    expect(plain(louder)).not.toEqual(plain(a))
  })
})
