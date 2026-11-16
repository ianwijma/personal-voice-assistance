/**
 * What is particular to the profile head, checked on the calls it makes through the runner on the recording canvas.
 * The shared suites (`compat.test.ts`, `isolation.test.ts`) already cover its manifest, every mode, option extremes,
 * garbage in storage, reduced-motion stillness, the recorded digest and the stage placement; this adds the design's
 * own promises, as it declares them in `modes`, `mappings` and `options`:
 *   - it faces the way the Facing option says, mirrored about the box through a fade, and its sound leaves the mouth
 *     on that side;
 *   - Silhouette is a solid head with a receding outline, Contour a faint inside and a full outline; line weight and
 *     size scale the drawing, and size never pushes the head out of its box;
 *   - the jaw opens only while it speaks, and Mouth range scales it;
 *   - reduced motion shows a fixed set of dots per mode, in the colour of the mode, and two arcs at the ear
 *     (listening, hearing) or three at the mouth (speaking), and no others.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Focus, Mode, Palette } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import profileHead from "@/characters/library/profile-head.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const STAGE: readonly [number, number] = [1280, 800]
/** The box on the stage, as the voice page places it. */
const BOX: Focus = { x: 280, y: 197, width: 720, height: 240 }
const DT = 1 / 60
const DPR = 2
const quiet = createVoiceFeatures()
const TAU = 2 * Math.PI

type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Stored = Record<string, number | boolean | string>

const make = (stored: Stored = {}): Runner => {
  const r = new Runner(profileHead, document.createElement("canvas"), stored)
  r.create()
  r.resize(STAGE[0], STAGE[1], DPR)
  return r
}

/** Step `frames` frames in `mode` with silent voices; returns the calls of each frame. */
const frames = (r: Runner, mode: Mode, count: number, o: { palette?: Palette; reduced?: boolean } = {}): Array<Array<Call>> => {
  const out: Array<Array<Call>> = []
  for (let i = 0; i < count; i++) {
    recording.log = []
    r.step({ mode, dt: DT, user: quiet, agent: quiet, palette: o.palette ?? PALETTES.dark, reducedMotion: o.reduced === true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity, focus: BOX })
    out.push(recording.log)
  }
  recording.log = null
  return out
}
/** The calls of the last of `count` frames. */
const last = (r: Runner, mode: Mode, count: number, o: { palette?: Palette; reduced?: boolean } = {}): Array<Call> => frames(r, mode, count, o).at(-1)!

const rgba = (css: string) => {
  const m = css.match(/rgba\((\d+),(\d+),(\d+),([\d.e-]+)\)/)
  if (m === null) throw new Error(`not an rgba colour: ${css}`)
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])] as const, alpha: Number(m[4]) }
}
type Colour = ReturnType<typeof rgba>

/** Walks a frame's calls keeping the transform and the paint state, so a test can ask what was drawn where, in CSS px on the canvas. */
const walk = (calls: ReadonlyArray<Call>) => {
  const arcs: Array<{ x: number; y: number; radius: number; from: number; to: number; stroke: Colour | null; fill: Colour | null }> = []
  const paths: Array<{ op: "fill" | "stroke"; points: Array<readonly [number, number]>; closed: boolean; colour: Colour | null; lineWidth: number; alpha: number }> = []
  let m = [1, 0, 0, 1, 0, 0]
  const stack: Array<{ m: Array<number>; stroke: Colour | null; fill: Colour | null; lineWidth: number; alpha: number }> = []
  let stroke: Colour | null = null
  let fill: Colour | null = null
  let lineWidth = 1
  let alpha = 1
  let points: Array<readonly [number, number]> = []
  let closed = false
  const at = (x: number, y: number) => [(m[0]! * x + m[2]! * y + m[4]!) / DPR, (m[1]! * x + m[3]! * y + m[5]!) / DPR] as const
  for (const c of calls) {
    const a = c.args as Array<number>
    switch (c.name) {
      case "setTransform":
        m = a
        break
      case "save":
        stack.push({ m: [...m], stroke, fill, lineWidth, alpha })
        break
      case "restore": {
        const s = stack.pop()
        if (s !== undefined) ({ m, stroke, fill, lineWidth, alpha } = s)
        break
      }
      case "translate":
        m = [m[0]!, m[1]!, m[2]!, m[3]!, m[0]! * a[0]! + m[2]! * a[1]! + m[4]!, m[1]! * a[0]! + m[3]! * a[1]! + m[5]!]
        break
      case "=strokeStyle":
        stroke = typeof c.args[0] === "string" && c.args[0].startsWith("rgba") ? rgba(c.args[0]) : null
        break
      case "=fillStyle":
        fill = typeof c.args[0] === "string" && c.args[0].startsWith("rgba") ? rgba(c.args[0]) : null
        break
      case "=lineWidth":
        lineWidth = a[0]!
        break
      case "=globalAlpha":
        alpha = a[0]!
        break
      case "beginPath":
        points = []
        closed = false
        break
      case "moveTo":
      case "lineTo":
        points.push(at(a[0]!, a[1]!))
        break
      case "closePath":
        closed = true
        break
      case "arc": {
        const [x, y] = at(a[0]!, a[1]!)
        arcs.push({ x, y, radius: a[2]!, from: a[3]!, to: a[4]!, stroke, fill })
        break
      }
      case "fill":
      case "stroke":
        paths.push({ op: c.name, points, closed, colour: c.name === "fill" ? fill : stroke, lineWidth, alpha })
        break
    }
  }
  return { arcs, paths }
}

/** The head, filled once, from the first fill of a frame. */
const headFill = (calls: ReadonlyArray<Call>) => walk(calls).paths.find((p) => p.op === "fill")!
/** The head's outline: its two long strokes (the upper contour and the lower one; links between dots are 2 points). */
const outline = (calls: ReadonlyArray<Call>) => walk(calls).paths.filter((p) => p.op === "stroke" && p.points.length > 50)
/** The mouth opening between the lips: the closed fill of 23 points; the head's own fill is far longer. */
const wedges = (calls: ReadonlyArray<Call>) => walk(calls).paths.filter((p) => p.op === "fill" && p.closed && p.points.length > 10 && p.points.length < 40)
const area = (pts: ReadonlyArray<readonly [number, number]>) => Math.abs(pts.reduce((s, [x, y], i) => s + x * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * y, 0)) / 2

const EAR_ARC = 0.38 // the two still arcs in front of the ear
const MOUTH_ARC = 0.45 // the three still arcs at the mouth
/** Arcs of the given angular span that are visible (alpha above zero). */
const waves = (calls: ReadonlyArray<Call>, span: number) => walk(calls).arcs.filter((a) => a.from === -span && a.to === span && a.stroke !== null && a.stroke.alpha > 0)
/** The dots in the head: full circles bigger than the eye's highlight (a dot is at least 0.9 px in radius, the highlight about 1). */
const dots = (calls: ReadonlyArray<Call>) => walk(calls).arcs.filter((a) => a.from === 0 && a.to === TAU && a.fill !== null && a.radius > 1.5)

beforeEach(() => {
  recording.log = null
})

describe("profile head: which way it faces", () => {
  it("draws the same head mirrored about the box when it faces left, and unmirrored facing right", () => {
    const right = last(make({ facing: "right" }), "idle", 60, { reduced: true })
    const left = last(make({ facing: "left" }), "idle", 60, { reduced: true })
    const scaleX = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "setTransform").map((c) => (c.args as Array<number>)[0]!)
    expect(scaleX(right).every((s) => s > 0)).toBe(true)
    expect(scaleX(left).at(-1)).toBeLessThan(0)
    const a = outline(right).flatMap((p) => p.points)
    const b = outline(left).flatMap((p) => p.points)
    expect(a.length).toBeGreaterThan(100)
    expect(b.length).toBe(a.length)
    // Each point of one is the other's reflection about the middle of the box: x + x' = 2 × centre, same height.
    const centre = BOX.x + BOX.width / 2
    a.forEach(([x, y], i) => {
      expect(x + b[i]![0], `point ${i}`).toBeCloseTo(2 * centre, 3)
      expect(y, `point ${i}`).toBeCloseTo(b[i]![1], 3)
    })
  })

  it("turning round passes through the mirror dimmed: it never flips at full strength", () => {
    const r = make({ facing: "right" })
    frames(r, "listening", 30)
    r.setStored({ facing: "left" })
    // The head's outline carries the fade: its global alpha, and whether the frame was drawn mirrored.
    const sequence = frames(r, "listening", 45).map((calls) => {
      const mirrored = calls.filter((c) => c.name === "setTransform").some((c) => (c.args as Array<number>)[0]! < 0)
      return { mirrored, dimmed: outline(calls)[0]!.alpha < 1 }
    })
    expect(sequence[0]!.mirrored).toBe(false)
    expect(sequence.some((s) => s.dimmed && !s.mirrored)).toBe(true) // fading out, still facing right
    expect(sequence.some((s) => s.dimmed && s.mirrored)).toBe(true) // fading in, now facing left
    expect(sequence.at(-1)).toEqual({ mirrored: true, dimmed: false }) // settled
    sequence.forEach((s, i) => {
      if (i > 0 && s.mirrored !== sequence[i - 1]!.mirrored) expect(s.dimmed, `frame ${i}, where it flips`).toBe(true)
    })
  })

  it("under reduced motion it turns at once, with no fade", () => {
    const r = make({ facing: "right" })
    frames(r, "listening", 10, { reduced: true })
    r.setStored({ facing: "left" })
    const [first] = frames(r, "listening", 1, { reduced: true })
    expect(first!.filter((c) => c.name === "setTransform").some((c) => (c.args as Array<number>)[0]! < 0)).toBe(true)
    expect(outline(first!)[0]!.alpha).toBe(1)
  })

  it("its sound leaves the mouth on the side it faces: right of the ear facing right, left of it facing left", () => {
    for (const [facing, sign] of [["right", 1], ["left", -1]] as const) {
      const mouth = waves(last(make({ facing }), "speaking", 20, { reduced: true }), MOUTH_ARC)
      const ear = waves(last(make({ facing }), "listening", 20, { reduced: true }), EAR_ARC)
      expect(mouth, facing).toHaveLength(3)
      expect(ear, facing).toHaveLength(2)
      expect(Math.sign(mouth[0]!.x - ear[0]!.x), facing).toBe(sign)
    }
  })
})

describe("profile head: contour, silhouette, weight and size", () => {
  it("silhouette fills the head solid and lets the outline recede; contour is a faint inside and a full outline", () => {
    for (const [name, palette] of Object.entries(PALETTES)) {
      const contour = last(make({ style: "contour" }), "idle", 30, { palette, reduced: true })
      const silhouette = last(make({ style: "silhouette" }), "idle", 30, { palette, reduced: true })
      expect(headFill(silhouette).colour!.alpha, name).toBeGreaterThan(2.5 * headFill(contour).colour!.alpha)
      expect(headFill(contour).colour!.alpha, name).toBeLessThan(0.1)
      const [c0, s0] = [outline(contour)[0]!.colour!, outline(silhouette)[0]!.colour!]
      expect(c0.alpha, name).toBe(1)
      expect(s0.alpha, name).toBeLessThan(0.5)
      expect(s0.rgb, `${name}: same ink, only fainter`).toEqual(c0.rgb)
    }
  })

  it("the line weight option scales the outline's thickness", () => {
    const width = (lineWeight: number) => outline(last(make({ lineWeight }), "idle", 30, { reduced: true }))[0]!.lineWidth
    expect(width(2)).toBeCloseTo(2 * width(1), 6)
    expect(width(0.5)).toBeCloseTo(0.5 * width(1), 6)
  })

  it("the size option scales the head, but never past the room the skull and face need; the head stays inside the box", () => {
    const extent = (size: number) => {
      const pts = outline(last(make({ size }), "idle", 30, { reduced: true })).flatMap((p) => p.points)
      const xs = pts.map(([x]) => x)
      const ys = pts.map(([, y]) => y)
      return { width: Math.max(...xs) - Math.min(...xs), minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys) }
    }
    const small = extent(0.5)
    const normal = extent(1)
    const big = extent(1.2)
    expect(small.width).toBeCloseTo(0.5 * normal.width, 1)
    // At 1.2 the cap holds it below a straight 1.2 × (this box is the height-limited case).
    expect(big.width).toBeGreaterThan(normal.width)
    expect(big.width).toBeLessThan(1.2 * normal.width - 1)
    for (const e of [small, normal, big]) {
      expect(e.minX).toBeGreaterThanOrEqual(BOX.x)
      expect(e.maxX).toBeLessThanOrEqual(BOX.x + BOX.width)
      expect(e.minY).toBeGreaterThanOrEqual(BOX.y)
    }
  })
})

describe("profile head: the jaw", () => {
  it("opens a mouth between the lips only while it speaks", () => {
    for (const mode of ["idle", "listening", "hearing", "thinking"] as const) expect(wedges(last(make(), mode, 30, { reduced: true })), mode).toHaveLength(0)
    expect(wedges(last(make(), "speaking", 30, { reduced: true }))).toHaveLength(1)
  })

  it("opens wider with a bigger Mouth range", () => {
    const opening = (mouthRange: number) => {
      const [w] = wedges(last(make({ mouthRange }), "speaking", 30, { reduced: true }))
      return w === undefined ? 0 : area(w.points) // a tiny range keeps the lips closed: no mouth between them
    }
    expect(opening(1)).toBeGreaterThan(0)
    expect(opening(1)).toBeGreaterThan(opening(0.4))
    expect(opening(1.5)).toBeGreaterThan(opening(1))
  })
})

describe("profile head: reduced motion shows what the mode is with still shapes", () => {
  const COUNTS: ReadonlyArray<readonly [Mode, number]> = [["idle", 4], ["listening", 6], ["hearing", 16], ["thinking", 18], ["speaking", 10]]
  const pal = PALETTES.dark

  it("fixes the number of dots in the head per mode: few and low at rest, most while it thinks", () => {
    for (const [mode, n] of COUNTS) expect(dots(last(make(), mode, 30, { reduced: true })), mode).toHaveLength(n)
  })

  it("colours them by the mode: mint hearing, half mint and half amber thinking, amber speaking, grey at rest", () => {
    const rgbs = (mode: Mode) => dots(last(make(), mode, 30, { reduced: true })).map((d) => d.fill!.rgb)
    expect(rgbs("hearing").every((c) => c.join() === pal.you.join())).toBe(true)
    expect(rgbs("speaking").every((c) => c.join() === pal.voice.join())).toBe(true)
    const thinking = rgbs("thinking")
    expect(thinking.filter((c) => c.join() === pal.voice.join())).toHaveLength(9)
    expect(thinking.filter((c) => c.join() === pal.you.join())).toHaveLength(9)
    // At rest the dots are dim: mixed toward the faint ink, so not the mint of hearing.
    expect(rgbs("idle").every((c) => c.join() !== pal.you.join())).toBe(true)
  })

  it("draws two still arcs at the ear while listening or hearing, three at the mouth while speaking, and neither otherwise", () => {
    const seen = (mode: Mode) => [waves(last(make(), mode, 30, { reduced: true }), EAR_ARC).length, waves(last(make(), mode, 30, { reduced: true }), MOUTH_ARC).length]
    expect(seen("listening")).toEqual([2, 0])
    expect(seen("hearing")).toEqual([2, 0])
    expect(seen("speaking")).toEqual([0, 3])
    expect(seen("thinking")).toEqual([0, 0])
    expect(seen("idle")).toEqual([0, 0])
  })

  it("the three arcs at the mouth are nested: each larger and fainter than the last", () => {
    const [a, b, c] = waves(last(make(), "speaking", 30, { reduced: true }), MOUTH_ARC)
    expect(a!.radius).toBeLessThan(b!.radius)
    expect(b!.radius).toBeLessThan(c!.radius)
    expect(a!.stroke!.alpha).toBeGreaterThan(b!.stroke!.alpha)
    expect(b!.stroke!.alpha).toBeGreaterThan(c!.stroke!.alpha)
  })
})
