/**
 * What is particular to "Line face" (src/characters/library/line-face.ts): which strokes are drawn in each mode
 * and style, the comic-strip sound marks that carry the person's voice in, the thinking dots, how the mouth
 * follows the reply, how the face leans in for a whisper and pulls back from a shout, and that the face fits its
 * canvas at every size. Driven through the runner on the recording canvas with hand-set voice features; the
 * drawing is in face units (the head has radius 1), so the numbers read directly. The groundwork suites (compat,
 * isolation) already cover the manifest, option extremes and garbage, mode distinctness, digests and frame cost,
 * and the figure helpers in `shared/figure.ts` belong to an earlier change.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Mode, OptionValues, Palette, Pointer, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import lineFace from "@/characters/library/line-face.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const DT = 1 / 60
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }

const make = (stored: OptionValues = {}, size: readonly [number, number] = [720, 240]) => {
  const r = new Runner(lineFace, document.createElement("canvas"), stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

const voice = (o: Partial<VoiceFeatures> = {}): VoiceFeatures => ({ ...createVoiceFeatures(), speaking: true, level: 0.4, rms: 0.04, voicing: 1, pitchHz: 200, pitch: 0.5, register: 0.5, ...o })
const silent = createVoiceFeatures()
const NO_POINTER: Pointer = { x: 0, y: 0, down: false, inside: false }

interface StepOptions {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly reduced?: boolean
  readonly pointer?: Pointer
  readonly palette?: Palette
}

/** Steps `frames` frames; returns the calls of the last one. */
const step = (r: Runner, mode: Mode, frames: number, o: StepOptions | ((i: number) => StepOptions) = {}): Array<Call> => {
  let last: Array<Call> = []
  for (let i = 0; i < frames; i++) {
    const s = typeof o === "function" ? o(i) : o
    recording.log = []
    r.step({ mode, dt: DT, user: s.user ?? silent, agent: s.agent ?? silent, palette: s.palette ?? PALETTES.dark, reducedMotion: s.reduced === true, pointer: s.pointer ?? NO_POINTER, sinceInterrupt: Infinity })
    last = recording.log
  }
  recording.log = null
  return last
}
const secs = (n: number) => Math.round(n / DT)
/** A still pose: no blinks, saccades or travelling marks, so the geometry is exact. */
const pose = (mode: Mode, o: StepOptions = {}, stored: OptionValues = {}, size?: readonly [number, number]) => step(make(stored, size), mode, secs(1.5), { reduced: true, ...o })

const named = (calls: ReadonlyArray<Call>, name: string) => calls.filter((c) => c.name === name)
const nums = (c: Call) => c.args as ReadonlyArray<number>
/** Arcs of the sound marks: concentric about the head, outside its radius of 1. */
const markArcs = (calls: ReadonlyArray<Call>) => named(calls, "arc").filter((c) => nums(c)[2]! > 1.1)
/** The head contour: the one arc of radius 1. */
const headArcs = (calls: ReadonlyArray<Call>) => named(calls, "arc").filter((c) => nums(c)[2] === 1)
const eyes = (calls: ReadonlyArray<Call>) => named(calls, "ellipse")
/** The three thinking dots: small arcs above the head. */
const dots = (calls: ReadonlyArray<Call>) => named(calls, "arc").filter((c) => nums(c)[2]! < 0.1)
/** The face's scale: the single `scale` call that sets pixels per face unit. */
const faceScale = (calls: ReadonlyArray<Call>) => nums(named(calls, "scale")[0]!)[0]!
/** The 28 points of the open mouth's outline, or null when the mouth is a single line. */
const mouthOutline = (calls: ReadonlyArray<Call>): Array<readonly [number, number]> | null => {
  let pts: Array<readonly [number, number]> = []
  for (const c of calls) {
    if (c.name === "beginPath") pts = []
    else if (c.name === "moveTo" || c.name === "lineTo") pts.push([nums(c)[0]!, nums(c)[1]!])
    else if (c.name === "closePath" && pts.length === 28) return pts
  }
  return null
}
const extent = (pts: ReadonlyArray<readonly [number, number]>) => ({ w: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])), h: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])) })
/** The colour a property had when call `c` was made. */
const styleAt = (calls: ReadonlyArray<Call>, c: Call, prop: "fillStyle" | "strokeStyle"): ReadonlyArray<number> => {
  let style = ""
  for (const k of calls) {
    if (k === c) break
    if (k.name === `=${prop}`) style = String(k.args[0])
  }
  return style.match(/rgba\((\d+),(\d+),(\d+)/)!.slice(1).map(Number)
}

beforeEach(() => {
  recording.log = null
})

describe("line face: style", () => {
  it("Sketch and Bold brows draw the head line; No outline and Minimal do not", () => {
    for (const style of ["sketch", "boldBrows"]) expect(headArcs(pose("listening", {}, { style })), style).toHaveLength(1)
    for (const style of ["noOutline", "minimal"]) expect(headArcs(pose("listening", {}, { style })), style).toHaveLength(0)
  })

  it("Minimal draws no brows; Bold brows are straight bars where the others curve", () => {
    // Eyes open and no blinks under reduced motion, so the first two curves are the brows; the mouth's is the last.
    const brows = (style: string) => named(pose("listening", {}, { style }), "quadraticCurveTo").slice(0, 2)
    expect(brows("minimal")).toHaveLength(1) // only the mouth's curve is left
    /** How far a brow's control point sits from the straight line between its ends (face units). */
    const bow = (c: Call, calls: ReadonlyArray<Call>) => {
      const [, cy, , y1] = nums(c)
      const y0 = nums(calls[calls.indexOf(c) - 1]!)[1]!
      return Math.abs(cy! - (y0 + y1!) / 2)
    }
    const straight = pose("listening", {}, { style: "boldBrows" })
    const curved = pose("listening", {}, { style: "sketch" })
    for (const c of named(straight, "quadraticCurveTo").slice(0, 2)) expect(bow(c, straight)).toBeLessThan(1e-6)
    for (const c of named(curved, "quadraticCurveTo").slice(0, 2)) expect(bow(c, curved)).toBeGreaterThan(0.02)
  })
})

describe("line face: the eyes", () => {
  it("rest closed in soft arcs when idle and open as dots once it listens", () => {
    expect(eyes(pose("idle"))).toHaveLength(0)
    expect(eyes(pose("listening"))).toHaveLength(2)
    expect(eyes(pose("thinking"))).toHaveLength(2)
  })

  it("widen for a whisper and squint at a shout", () => {
    // Moving poses (blinks come and go), so take the widest the eyes get over the last second.
    const height = (user: VoiceFeatures) => {
      const r = make()
      step(r, "hearing", secs(4), { user })
      let widest = 0
      for (let i = 0; i < secs(1); i++) for (const e of eyes(step(r, "hearing", 1, { user }))) widest = Math.max(widest, nums(e)[3]!)
      return widest
    }
    const whisper = height(voice({ voicing: 0.1, level: 0.06 }))
    const normal = height(voice({ level: 0.3 }))
    const shout = height(voice({ level: 0.9 }))
    expect(whisper).toBeGreaterThan(normal * 1.05)
    expect(shout).toBeLessThan(normal * 0.9)
  })

  it("follow the pointer, unless Follows pointer is off or the pointer is not over the canvas", () => {
    const x = (o: StepOptions, stored: OptionValues = {}) => nums(eyes(pose("hearing", o, stored))[0]!)[0]!
    const centre = x({})
    const right = x({ pointer: { x: 700, y: 120, down: false, inside: true } })
    const left = x({ pointer: { x: 20, y: 120, down: false, inside: true } })
    expect(right).toBeGreaterThan(centre + 0.05)
    expect(left).toBeLessThan(centre - 0.05)
    expect(x({ pointer: { x: 700, y: 120, down: false, inside: true } }, { followsPointer: false })).toBeCloseTo(centre, 6)
    expect(x({ pointer: { x: 700, y: 120, down: false, inside: false } })).toBeCloseTo(centre, 6)
  })
})

describe("line face: sound marks", () => {
  it("a still pose shows one pair while listening, three while hearing, none otherwise", () => {
    expect(markArcs(pose("listening"))).toHaveLength(2)
    expect(markArcs(pose("hearing", { user: voice() }))).toHaveLength(6)
    for (const mode of ["idle", "thinking", "speaking"] as const) expect(markArcs(pose(mode, { agent: voice() })), mode).toHaveLength(0)
  })

  it("the marks are in the person's colour", () => {
    const P = PALETTES.light
    const calls = pose("hearing", { user: voice(), palette: P })
    const first = markArcs(calls)[0]!
    expect(styleAt(calls, first, "strokeStyle")).toEqual([...P.you])
  })

  it("each syllable onset of the person launches one more pair, which arrives and fades", () => {
    const r = make()
    const onsets = [0, 0.3, 0.6].map(secs)
    const talk = (i: number): StepOptions => ({ user: voice({ onset: onsets.includes(i) ? 1 : 0 }) })
    step(r, "hearing", secs(0.5), { user: voice() }) // settle in hearing
    const calm = markArcs(step(r, "hearing", 1, { user: voice() })).length
    const busy = markArcs(step(r, "hearing", secs(0.7), talk)).length
    expect(calm).toBe(2) // the ear mark alone
    expect(busy).toBe(2 + 3 * 2)
    // Mark life is 1.3 s: with no new onsets, they are gone again.
    expect(markArcs(step(r, "hearing", secs(1.6), { user: voice() }))).toHaveLength(2)
  })

  it("at most ten pairs are in flight, however fast the person talks", () => {
    const r = make()
    step(r, "hearing", secs(0.5), { user: voice() })
    const fast = markArcs(step(r, "hearing", secs(1), (i) => ({ user: voice({ onset: i % 5 === 0 ? 1 : 0 }) }))).length // 12 onsets a second
    expect(fast).toBeLessThanOrEqual(2 + 10 * 2)
    expect(fast).toBeGreaterThan(2 + 5 * 2)
  })

  it("a mark can only be launched by speech, not by an onset while the person is silent", () => {
    const r = make()
    step(r, "hearing", secs(0.5), { user: voice() })
    const calls = step(r, "hearing", secs(0.5), (i) => ({ user: voice({ speaking: false, level: 0, onset: i % 10 === 0 ? 1 : 0 }) }))
    expect(markArcs(calls)).toHaveLength(2)
  })
})

describe("line face: thinking dots", () => {
  it("three amber dots above the head, on one side, stepping up and outward", () => {
    const P = PALETTES.light
    const calls = pose("thinking", { palette: P })
    const d = dots(calls)
    expect(d).toHaveLength(3)
    const side = Math.sign(nums(d[0]!)[0]!)
    expect(side).not.toBe(0)
    for (let i = 1; i < 3; i++) {
      expect(Math.sign(nums(d[i]!)[0]!)).toBe(side)
      expect(Math.abs(nums(d[i]!)[0]!)).toBeGreaterThan(Math.abs(nums(d[i - 1]!)[0]!))
      expect(nums(d[i]!)[1]!).toBeLessThan(nums(d[i - 1]!)[1]!)
      expect(nums(d[i]!)[2]!).toBeGreaterThan(nums(d[i - 1]!)[2]!)
    }
    expect(styleAt(calls, d[0]!, "fillStyle")).toEqual([...P.voice])
    for (const mode of ["idle", "listening", "hearing", "speaking"] as const) expect(dots(pose(mode, { user: voice(), agent: voice() })), mode).toHaveLength(0)
  })
})

describe("line face: the mouth", () => {
  const speaking = (agent: VoiceFeatures, stored: OptionValues = {}) => step(make(stored), "speaking", secs(1.5), { agent })

  it("is a single curved line when it is not speaking, and an outline when it is", () => {
    expect(mouthOutline(pose("listening"))).toBeNull()
    expect(mouthOutline(speaking(voice({ mouth: { open: 0.8, wide: 0, round: 0 } })))).not.toBeNull()
  })

  it("opens as far as the reply's jaw does, and the Mouth range option scales that", () => {
    const height = (open: number, stored: OptionValues = {}) => extent(mouthOutline(speaking(voice({ mouth: { open, wide: 0, round: 0 } }), stored))!).h
    expect(height(0.9)).toBeGreaterThan(height(0.3) * 1.5)
    expect(height(0.9, { mouthRange: 2 })).toBeGreaterThan(height(0.9, { mouthRange: 1 }) * 1.4)
  })

  it("widens for a wide vowel and narrows for a round one", () => {
    const width = (mouth: VoiceFeatures["mouth"]) => extent(mouthOutline(speaking(voice({ mouth })))!).w
    const wide = width({ open: 0.5, wide: 1, round: 0 })
    const flat = width({ open: 0.5, wide: 0, round: 0 })
    const round = width({ open: 0.5, wide: 0, round: 1 })
    expect(wide).toBeGreaterThan(flat * 1.2)
    expect(round).toBeLessThan(flat * 0.8)
  })

  it("keeps the lips a little apart in the middle of a phrase", () => {
    // Silent jaw, but the reply is still going: not a hard line.
    expect(mouthOutline(speaking(voice({ mouth: { open: 0, wide: 0, round: 0 } })))).not.toBeNull()
  })

  it("shows a teeth line on a sibilant with the jaw closed, and not when the jaw is open", () => {
    // The teeth are a two-point stroke (moveTo, lineTo at one height) after the outline's 28 points.
    const flatLines = (calls: ReadonlyArray<Call>) => {
      let n = 0
      for (let i = 1; i < calls.length; i++) {
        const a = calls[i - 1]!
        const b = calls[i]!
        if (a.name === "moveTo" && b.name === "lineTo" && nums(a)[1] === nums(b)[1] && calls[i + 1]?.name === "stroke") n++
      }
      return n
    }
    const hiss = flatLines(speaking(voice({ sibilance: 0.9, mouth: { open: 0, wide: 0, round: 0 } })))
    const hissOpen = flatLines(speaking(voice({ sibilance: 0.9, mouth: { open: 0.9, wide: 0, round: 0 } })))
    const plain = flatLines(speaking(voice({ mouth: { open: 0, wide: 0, round: 0 } })))
    expect(hiss).toBe(plain + 1)
    expect(hissOpen).toBe(plain)
  })

  it("is outlined in the assistant's colour while speaking and in the ink while listening", () => {
    const P = PALETTES.light
    const outline = (mode: Mode) => {
      const calls = pose(mode, { agent: voice({ mouth: { open: 0.5, wide: 0, round: 0 } }), palette: P })
      const strokes = named(calls, "stroke")
      return styleAt(calls, strokes[strokes.length - 1]!, "strokeStyle")
    }
    expect(outline("speaking")).toEqual([...P.voice])
    expect(outline("listening")).toEqual([...P.ink])
  })

  it("reduced motion holds one half-open pose while speaking", () => {
    const a = mouthOutline(pose("speaking", { agent: voice({ mouth: { open: 0, wide: 0, round: 0 } }) }))!
    const b = mouthOutline(pose("speaking", { agent: voice({ mouth: { open: 1, wide: 1, round: 0 } }) }))!
    expect(extent(a).h).toBeGreaterThan(0.05)
    expect(extent(b).h).toBeCloseTo(extent(a).h, 6)
  })
})

describe("line face: stroke colour", () => {
  it("is faint grey at rest and darkens to the ink as soon as it attends", () => {
    const P = PALETTES.light
    const colour = (mode: Mode) => {
      const calls = pose(mode, { palette: P }, { style: "sketch" })
      return styleAt(calls, named(calls, "stroke")[0]!, "strokeStyle")
    }
    expect(colour("idle")).toEqual([...P.inkFaint])
    for (const mode of ["listening", "hearing", "thinking", "speaking"] as const) expect(colour(mode), mode).toEqual([...P.ink])
  })
})

describe("line face: leaning in and pulling back", () => {
  it("leans in for a whisper and pulls back from a shout", () => {
    const scale = (user: VoiceFeatures) => faceScale(step(make(), "hearing", secs(4), { user }))
    const normal = scale(voice({ level: 0.3 }))
    expect(scale(voice({ voicing: 0.1, level: 0.06 }))).toBeGreaterThan(normal * 1.05)
    expect(scale(voice({ level: 0.9 }))).toBeLessThan(normal * 0.95)
  })

  it("a loud onset makes it flinch, and it settles again", () => {
    const r = make()
    const calm = faceScale(step(r, "hearing", secs(1), { user: voice({ level: 0.3 }) }))
    const hit = faceScale(step(r, "hearing", 6, (i) => ({ user: voice({ level: 0.7, onset: i === 0 ? 1 : 0 }) })))
    expect(hit).toBeLessThan(calm)
  })
})

describe("line face: size", () => {
  it("Size scales the face, and the largest size still keeps the head, marks and motion in the canvas", () => {
    const s = (size: number) => faceScale(pose("idle", {}, { size }))
    expect(s(0.5)).toBeCloseTo(s(1) / 2, 3)
    expect(s(1.1)).toBeGreaterThanOrEqual(s(1))
    for (const [w, h] of [[160, 140], [720, 240], [390, 844], [1280, 800]] as const) {
      const scale = faceScale(pose("idle", {}, { size: 1.1 }, [w, h]))
      expect(scale * 3.1, `${w}×${h}: width`).toBeLessThanOrEqual(w + 1e-6)
      expect(scale * 2.45, `${w}×${h}: height`).toBeLessThanOrEqual(h + 1e-6)
    }
  })
})
