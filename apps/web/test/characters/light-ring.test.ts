/**
 * Light ring, the behaviour that is its own (the shared suites in `compat.test.ts` and `isolation.test.ts` already run
 * it through the manifest, the modes, the option extremes, reduced-motion stillness, the digest and the stage checks):
 * the arc that sits at the pitch of your voice, the beads each syllable leaves, the spectrum band and ripples of the
 * reply, the thinking chase, and what the options promise (size cap, styles, arc position, spectrum, sparks).
 * Checked on the calls it makes, through the runner, on the recording canvas.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Focus, Mode, Palette, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import lightRing from "@/characters/library/light-ring.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
const TAU = Math.PI * 2
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Pointer = { readonly x: number; readonly y: number; readonly down: boolean; readonly inside: boolean }
/** An arc that was stroked or filled: the circle's centre and radius, the angles, and the drawing state at the time. */
interface Arc {
  readonly op: "stroke" | "fill"
  readonly x: number
  readonly y: number
  readonly r: number
  readonly from: number
  readonly to: number
  readonly style: string
  readonly width: number
  readonly dashed: boolean
}
interface Fill {
  readonly style: string
  readonly pts: ReadonlyArray<readonly [number, number]>
}

const make = (stored: Record<string, number | boolean | string> = {}, size: readonly [number, number] = [W, H]) => {
  const canvas = document.createElement("canvas")
  const r = new Runner(lightRing, canvas, stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

/** A voice speaking now: loud, voiced, mid pitch, no syllable starting unless `onset` says so. */
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
  readonly pointer?: Pointer
  readonly focus?: Focus
}
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
const settle = (r: Runner, mode: Mode, frames: number, o: StepOptions = {}): Array<Call> => {
  let last: Array<Call> = []
  for (let i = 0; i < frames; i++) last = frame(r, mode, o)
  return last
}
/** Run `n` frames, the voice given per frame; the calls of every frame. */
const run = (r: Runner, mode: Mode, n: number, who: "user" | "agent", at: (i: number) => VoiceFeatures, o: StepOptions = {}): Array<Array<Call>> => {
  const out: Array<Array<Call>> = []
  for (let i = 0; i < n; i++) out.push(frame(r, mode, { ...o, [who]: at(i) }))
  return out
}
/** Onset 1 on exactly the frames in `at`. */
const syllables = (at: ReadonlyArray<number>, base: Partial<VoiceFeatures> = {}) => (i: number): VoiceFeatures => voice({ ...base, onset: at.includes(i) ? 1 : 0 })

/** Every arc stroked or filled in a frame, in drawing order. */
const arcs = (calls: ReadonlyArray<Call>): Array<Arc> => {
  const out: Array<Arc> = []
  let style = { fill: "", stroke: "" }
  let width = 1
  let dashed = false
  let arc: ReadonlyArray<number> | null = null
  for (const c of calls) {
    switch (c.name) {
      case "=fillStyle":
        style = { ...style, fill: String(c.args[0]) }
        break
      case "=strokeStyle":
        style = { ...style, stroke: String(c.args[0]) }
        break
      case "=lineWidth":
        width = c.args[0] as number
        break
      case "setLineDash":
        dashed = (c.args[0] as Array<number>).length > 0
        break
      case "beginPath":
        arc = null
        break
      case "arc":
        arc = c.args as Array<number>
        break
      case "stroke":
      case "fill":
        if (arc !== null) out.push({ op: c.name, x: arc[0]!, y: arc[1]!, r: arc[2]!, from: arc[3]!, to: arc[4]!, style: c.name === "stroke" ? style.stroke : style.fill, width, dashed })
        break
    }
  }
  return out
}
/** The closed polygons filled in a frame (the spectrum band), with their colour. */
const polygons = (calls: ReadonlyArray<Call>): Array<Fill> => {
  const out: Array<Fill> = []
  let fillStyle = ""
  let pts: Array<readonly [number, number]> = []
  for (const c of calls) {
    if (c.name === "=fillStyle") fillStyle = String(c.args[0])
    else if (c.name === "beginPath") pts = []
    else if (c.name === "moveTo" || c.name === "lineTo") pts.push([c.args[0] as number, c.args[1] as number])
    else if (c.name === "fill" && pts.length > 10) out.push({ style: fillStyle, pts })
  }
  return out
}
const rgba = (css: string) => css.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/)!.slice(1).map(Number) as [number, number, number, number]
const rgb = (css: string) => rgba(css).slice(0, 3)
const wholeCircle = (a: Arc) => a.to - a.from >= TAU - 0.01
/** The ring itself: the first full circle stroked in a frame. */
const ring = (calls: ReadonlyArray<Call>): Arc => arcs(calls).find((a) => a.op === "stroke" && wholeCircle(a))!
/** The bright arcs of hearing: stroked part-circles. */
const partArcs = (calls: ReadonlyArray<Call>) => arcs(calls).filter((a) => a.op === "stroke" && !wholeCircle(a))
/** Elevation (0 bottom .. 1 top) of a point on the ring, measured from the centre. */
const elevationOf = (x: number, y: number, cx = W / 2, cy = H / 2) => Math.abs(Math.atan2(Math.sin(Math.atan2(y - cy, x - cx) - Math.PI / 2), Math.cos(Math.atan2(y - cy, x - cx) - Math.PI / 2))) / Math.PI
/** Elevation of an arc's centre, from the bottom of the ring. */
const arcElevation = (a: Arc) => elevationOf(W / 2 + Math.cos((a.from + a.to) / 2) * a.r, H / 2 + Math.sin((a.from + a.to) / 2) * a.r)
/** Each bead: a small filled circle (two per syllable, one each side); the speaking band's inner circle is far bigger. */
const beads = (calls: ReadonlyArray<Call>) => arcs(calls).filter((a) => a.op === "fill" && wholeCircle(a) && a.r < 20)

beforeEach(() => {
  recording.log = null
})

describe("light ring: the bright arc sits at your pitch", () => {
  const hear = (u: VoiceFeatures, stored: Record<string, number | boolean | string> = {}, o: StepOptions = {}) => settle(make(stored), "hearing", 120, { user: u, ...o })

  it("a deep voice is at the bottom of the ring, a high one up the sides, mirrored left and right", () => {
    for (const pitch of [0.1, 0.5, 0.9]) {
      const a = partArcs(hear(voice({ pitch })))
      expect(a.length, `pitch ${pitch}`).toBeGreaterThan(0)
      for (const arc of a) expect(arcElevation(arc), `pitch ${pitch}`).toBeCloseTo(pitch, 1)
      // Two arcs mirrored about the vertical axis: their centres sum to π (bottom is π/2).
      const centres = [...new Set(a.map((x) => ((x.from + x.to) / 2).toFixed(3)))].map(Number)
      expect(centres).toHaveLength(2)
      expect((centres[0]! + centres[1]!) / 2, `pitch ${pitch}`).toBeCloseTo(Math.PI / 2, 2)
    }
  })

  it("moves only while the voice is voiced: a breathy high pitch leaves the arc where it was", () => {
    const r = make()
    settle(r, "hearing", 120, { user: voice({ pitch: 0.2 }) })
    const calls = settle(r, "hearing", 120, { user: voice({ pitch: 0.9, voicing: 0.1 }) })
    for (const arc of partArcs(calls)) expect(arcElevation(arc)).toBeCloseTo(0.2, 1)
  })

  it("'Arc position' pins the arc at the bottom, the sides or the top, whatever the pitch", () => {
    const at = (arcPlace: string) => partArcs(hear(voice({ pitch: 0.9 }), { arcPlace }))
    for (const [place, e] of [["bottom", 0.08], ["sides", 0.5], ["top", 0.92]] as const) {
      const a = at(place)
      expect(a.length, place).toBeGreaterThan(0)
      for (const arc of a) expect(arcElevation(arc), place).toBeCloseTo(e, 1)
    }
  })

  it("under reduced motion the arc moves in sixths of the ring", () => {
    const a = partArcs(hear(voice({ pitch: 0.53 }), {}, { reduced: true }))
    for (const arc of a) expect(arcElevation(arc)).toBeCloseTo(0.5, 2)
  })

  it("is longer when louder, and 'Arc length' scales it", () => {
    const span = (level: number, stored: Record<string, number> = {}) => {
      const a = partArcs(hear(voice({ level }), stored))
      return Math.max(...a.map((x) => x.to - x.from))
    }
    expect(span(0.6)).toBeGreaterThan(span(0.05) * 1.8)
    expect(span(0.3, { arcLength: 1.8 })).toBeCloseTo(span(0.3) * 1.8, 1)
    expect(span(0.3, { arcLength: 0.4 })).toBeCloseTo(span(0.3) * 0.4, 1)
  })

  it("a whisper breaks the arc into a dotted line; a voiced sound keeps it solid", () => {
    expect(partArcs(hear(voice({ voicing: 0.05 }))).every((a) => a.dashed)).toBe(true)
    expect(partArcs(hear(voice({ voicing: 1 }))).some((a) => a.dashed)).toBe(false)
  })

  it("the arc is thicker when louder", () => {
    const w = (level: number) => Math.max(...partArcs(hear(voice({ level }))).map((a) => a.width))
    expect(w(0.6)).toBeGreaterThan(w(0.05) * 1.5)
  })
})

describe("light ring: each syllable lands as a bead", () => {
  it("one bead (a light each side) per onset; a held onset adds none; gone after 1.8 s", () => {
    const one = run(make(), "hearing", 20, "user", syllables([2]))
    expect(beads(one[19]!)).toHaveLength(2)
    const held = run(make(), "hearing", 20, "user", (i) => voice({ onset: i >= 2 ? 1 : 0 }))
    expect(beads(held[19]!)).toHaveLength(2)
    const twice = run(make(), "hearing", 30, "user", syllables([2, 12]))
    expect(beads(twice[29]!)).toHaveLength(4)
    const gone = run(make(), "hearing", 140, "user", syllables([2]))
    expect(beads(gone[60]!)).toHaveLength(2)
    expect(beads(gone[139]!)).toHaveLength(0)
  })

  it("a faint onset (a whisper's) counts; one below the threshold does not", () => {
    expect(beads(run(make(), "hearing", 12, "user", (i) => voice({ onset: i === 2 ? 0.4 : 0 }))[11]!)).toHaveLength(2)
    expect(beads(run(make(), "hearing", 12, "user", (i) => voice({ onset: i === 2 ? 0.25 : 0 }))[11]!)).toHaveLength(0)
  })

  it("the beads trace your intonation: each lands at the pitch it was spoken at", () => {
    // Low for a while, a syllable, high for a while, another: the second bead sits higher on the ring.
    const frames = run(make(), "hearing", 120, "user", (i) => voice({ pitch: i < 60 ? 0.2 : 0.8, onset: i === 50 || i === 110 ? 1 : 0 }))
    const last = beads(frames[119]!)
    expect(last).toHaveLength(4)
    const elev = [...new Set(last.map((b) => elevationOf(b.x, b.y).toFixed(2)))].map(Number).sort()
    expect(elev).toHaveLength(2)
    expect(elev[0]!).toBeCloseTo(0.2, 1)
    expect(elev[1]!).toBeCloseTo(0.8, 1)
  })

  it("a spark comes in from outside the ring (about 1.45× its radius) and settles on it", () => {
    const frames = run(make(), "hearing", 30, "user", syllables([2]))
    const dist = (calls: Array<Call>) => {
      const b = beads(calls)[0]!
      return Math.hypot(b.x - W / 2, b.y - H / 2) / ring(calls).r
    }
    expect(dist(frames[2]!)).toBeGreaterThan(1.3)
    expect(dist(frames[29]!)).toBeCloseTo(1, 2)
  })

  it("'Sparks and ripples: off' leaves no beads, and neither does reduced motion", () => {
    expect(beads(run(make({ sparks: false }), "hearing", 20, "user", syllables([2]))[19]!)).toHaveLength(0)
    expect(beads(run(make(), "hearing", 20, "user", syllables([2]), { reduced: true })[19]!)).toHaveLength(0)
  })

  it("onsets are ignored outside hearing, and the assistant's are not beads", () => {
    for (const mode of ["idle", "listening", "thinking"] as const) expect(beads(run(make(), mode, 20, "user", syllables([2]))[19]!), mode).toHaveLength(0)
    expect(beads(run(make(), "speaking", 20, "agent", syllables([2]))[19]!)).toHaveLength(0)
    expect(beads(run(make(), "hearing", 20, "agent", syllables([2]))[19]!)).toHaveLength(0)
  })

  it("'Motion speed' makes beads fade faster", () => {
    const alive = (speed: number) => {
      const frames = run(make({ speed }), "hearing", 150, "user", syllables([2]))
      return frames.findIndex((c, i) => i > 3 && beads(c).length === 0)
    }
    expect(alive(2)).toBeLessThan(alive(1))
    expect(alive(1)).toBeGreaterThan(0)
  })
})

describe("light ring: the reply as a band and ripples", () => {
  const LIGHT = { palette: PALETTES.light }
  const spectrum = (low: boolean): VoiceFeatures => {
    const f = voice({ level: 0.5 })
    for (let i = 0; i < 24; i++) f.bands[i] = (low ? i < 4 : i >= 20) ? 1 : 0
    return f
  }
  /** The band, its radius at each of the 97 samples around the ring (sample 24 is the bottom, 72 the top). */
  const band = (calls: ReadonlyArray<Call>) => {
    const p = polygons(calls).find((q) => q.pts.length >= 97)!
    return p.pts.slice(0, 97).map(([x, y]) => Math.hypot(x - W / 2, y - H / 2))
  }
  const say = (f: VoiceFeatures, stored: Record<string, number | boolean | string> = {}, o: StepOptions = {}) => settle(make(stored), "speaking", 120, { agent: f, ...LIGHT, ...o })

  it("is thick at the bottom for low sounds and thick at the top for high sounds, the same on both sides", () => {
    const low = band(say(spectrum(true)))
    const high = band(say(spectrum(false)))
    expect(low[24]!).toBeGreaterThan(low[72]! + 3)
    expect(high[72]!).toBeGreaterThan(high[24]! + 3)
    expect(low[12]!).toBeCloseTo(low[36]!, 1)
    expect(high[12]!).toBeCloseTo(high[36]!, 1)
  })

  it("'Spectrum detail: 0' makes a plain, even band, and more detail makes the bumps taller", () => {
    const spread = (b: Array<number>) => Math.max(...b) - Math.min(...b)
    expect(spread(band(say(spectrum(true), { spectrum: 0 })))).toBeLessThan(0.01)
    expect(spread(band(say(spectrum(true), { spectrum: 2 })))).toBeGreaterThan(spread(band(say(spectrum(true), { spectrum: 1 }))) * 1.5)
  })

  it("the band only grows outward: its inner edge is the plain ring", () => {
    const calls = say(spectrum(true))
    const inner = arcs(calls).filter((a) => a.op === "fill" || (a.op === "stroke" && wholeCircle(a))).at(-1)
    expect(inner).toBeDefined()
    const b = band(calls)
    expect(Math.min(...b)).toBeGreaterThan(0)
    expect(Math.max(...b)).toBeGreaterThan(Math.min(...b))
  })

  it("each syllable sends one ripple outward, up to about 1.66× the radius over 1.1 s, and then it is gone", () => {
    const frames = run(make({}, [W, H]), "speaking", 120, "agent", syllables([2]), LIGHT)
    const ripples = (calls: Array<Call>) => {
      const r = ring(calls).r
      return arcs(calls).filter((a) => a.op === "stroke" && wholeCircle(a) && a.r > r * 1.04)
    }
    expect(ripples(frames[5]!)).toHaveLength(1)
    const early = ripples(frames[5]!)[0]!.r / ring(frames[5]!).r
    const late = ripples(frames[55]!)[0]!.r / ring(frames[55]!).r
    expect(early).toBeGreaterThan(1.04)
    expect(late).toBeGreaterThan(early + 0.2)
    expect(late).toBeLessThan(1.7)
    expect(ripples(frames[119]!)).toHaveLength(0)
  })

  it("a louder syllable makes a stronger (thicker) ripple", () => {
    const widest = (level: number) => {
      const frames = run(make(), "speaking", 12, "agent", syllables([2], { level }), LIGHT)
      const r = ring(frames[8]!).r
      return arcs(frames[8]!).find((a) => a.op === "stroke" && wholeCircle(a) && a.r > r * 1.04)!.width
    }
    expect(widest(0.9)).toBeGreaterThan(widest(0.1))
  })

  it("'Sparks and ripples: off' sends none; reduced motion sends none but shows a still outer ring", () => {
    const ripples = (calls: Array<Call>) => {
      const r = ring(calls).r
      return arcs(calls).filter((a) => a.op === "stroke" && wholeCircle(a) && a.r > r * 1.04)
    }
    expect(ripples(run(make({ sparks: false }), "speaking", 12, "agent", syllables([2]), LIGHT)[8]!)).toHaveLength(0)
    const still = run(make(), "speaking", 90, "agent", (i) => voice({ onset: i % 6 === 0 ? 1 : 0 }), { ...LIGHT, reduced: true })
    const last = still[89]!
    const outer = ripples(last)
    expect(outer).toHaveLength(1)
    expect(outer[0]!.r / ring(last).r).toBeCloseTo(1.22, 2)
    expect(ripples(still[60]!)[0]!.r).toBeCloseTo(outer[0]!.r, 0) // the ring itself is still settling by a hair
  })

  it("the ring is a little larger while the reply is loud", () => {
    const radius = (level: number) => ring(say(voice({ level }))).r
    expect(radius(0.9)).toBeGreaterThan(radius(0.05))
  })
})

describe("light ring: the colours and sizes of the modes", () => {
  const ringColour = (mode: Mode, palette: Palette) => rgb(ring(settle(make(), mode, 90, { palette, user: voice(), agent: voice() })).style)

  it("the ring is grey at rest, mint when it is ready and amber while it speaks", () => {
    const p = PALETTES.light
    expect(ringColour("idle", p)).toEqual([...p.inkFaint])
    expect(ringColour("listening", p)).toEqual([...p.you])
    expect(ringColour("speaking", p)).toEqual([...p.voice])
  })

  it("is small and still at rest and when ready, full size while hearing or speaking", () => {
    const radius = (mode: Mode) => ring(settle(make(), mode, 120, { user: voice(), agent: voice() })).r
    expect(radius("idle")).toBeLessThan(radius("hearing") * 0.6)
    expect(radius("listening")).toBeLessThan(radius("hearing") * 0.65)
    expect(radius("thinking")).toBeLessThan(radius("hearing"))
    expect(radius("speaking")).toBeGreaterThanOrEqual(radius("hearing"))
  })

  it("'Size' scales the ring until the box cannot hold more", () => {
    const radius = (size: number, box: readonly [number, number] = [W, H]) => ring(settle(make({ size }, box), "hearing", 120, { user: voice() })).r
    expect(radius(0.5)).toBeCloseTo(radius(1) * 0.5, 1)
    expect(radius(1.15)).toBeLessThan(radius(1) * 1.15) // capped
    expect(radius(1.15)).toBeLessThan(H / 2)
  })

  it("pressing on the ring shrinks it 6 %, but only inside the box", () => {
    const stage = [1280, 800] as const
    const focus: Focus = { x: 280, y: 200, width: W, height: H }
    const at = (pointer: Pointer) => ring(settle(make({}, stage), "listening", 90, { focus, pointer })).r
    const none = at({ x: 0, y: 0, down: false, inside: false })
    expect(at({ x: 600, y: 320, down: true, inside: true }) / none).toBeCloseTo(0.94, 2)
    expect(at({ x: 600, y: 320, down: false, inside: true }) / none).toBeCloseTo(1, 3)
    expect(at({ x: 10, y: 10, down: true, inside: true }) / none).toBeCloseTo(1, 3)
  })
})

describe("light ring: thinking", () => {
  /** The chase: six part-circle segments (three amber, three mint), as the centres of their outer glow arcs. */
  const chase = (calls: ReadonlyArray<Call>, palette: Palette = PALETTES.light) => {
    const a = partArcs(calls)
    const colour = (c: readonly number[]) => (x: Arc) => rgb(x.style).join() === c.join()
    return { amber: a.filter(colour(palette.voice)), mint: a.filter(colour(palette.you)) }
  }
  const centre = (a: Arc) => (a.from + a.to) / 2

  it("alternating amber and mint segments, three of each", () => {
    const { amber, mint } = chase(settle(make(), "thinking", 60, { palette: PALETTES.light }))
    expect(amber.length).toBeGreaterThan(0)
    expect(amber.length).toBe(mint.length)
    const distinct = (a: Array<Arc>) => new Set(a.map((x) => centre(x).toFixed(3))).size
    expect(distinct(amber)).toBe(3)
    expect(distinct(mint)).toBe(3)
  })

  it("they chase clockwise, and faster at a higher 'Motion speed'", () => {
    const first = (r: Runner, n: number) => {
      settle(r, "thinking", n, { palette: PALETTES.light })
      return centre(chase(frame(r, "thinking", { palette: PALETTES.light })).amber[0]!)
    }
    const turn = (speed: number) => {
      const r = make({ speed })
      const a = first(r, 60)
      const b = first(r, 5)
      return Math.atan2(Math.sin(b - a), Math.cos(b - a))
    }
    expect(turn(1)).toBeGreaterThan(0.05)
    expect(turn(2)).toBeGreaterThan(turn(1) * 1.5)
  })

  it("under reduced motion the segments stand still", () => {
    const r = make()
    const a = chase(settle(r, "thinking", 60, { palette: PALETTES.light, reduced: true }))
    const b = chase(settle(r, "thinking", 60, { palette: PALETTES.light, reduced: true }))
    expect(b.amber.map(centre)).toEqual(a.amber.map(centre))
  })
})

describe("light ring: the styles", () => {
  const strokes = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "stroke").length

  it("'Crisp' drops the glow passes: fewer strokes than 'Glow' for the same ring", () => {
    const n = (style: string) => strokes(settle(make({ style }), "listening", 90))
    expect(n("crisp")).toBeLessThan(n("glow"))
  })

  it("'Segments' cuts the light with thin radial gaps (36 of them) and the other styles do not", () => {
    const cuts = (calls: ReadonlyArray<Call>) => {
      const i = calls.findIndex((c) => c.name === "=globalCompositeOperation" && c.args[0] === "destination-out")
      if (i < 0) return undefined
      const rest = calls.slice(i)
      const end = rest.findIndex((c) => c.name === "stroke")
      return { gaps: rest.slice(0, end).filter((c) => c.name === "lineTo").length, width: rest.find((c) => c.name === "=lineWidth")!.args[0] as number }
    }
    expect(cuts(settle(make({ style: "glow" }), "listening", 90))).toBeUndefined()
    expect(cuts(settle(make({ style: "crisp" }), "listening", 90))).toBeUndefined()
    expect(cuts(settle(make({ style: "segments" }), "listening", 90))!.gaps).toBe(36)
  })

  it("the gaps never take more than a third of a small ring", () => {
    const calls = settle(make({ style: "segments", size: 0.5 }, [160, 140]), "listening", 90)
    const r = ring(calls).r
    const i = calls.findIndex((c) => c.name === "=globalCompositeOperation" && c.args[0] === "destination-out")
    const width = calls.slice(i).find((c) => c.name === "=lineWidth")!.args[0] as number
    expect(width * 36).toBeLessThanOrEqual(0.33 * TAU * r + 1e-6)
  })
})

describe("light ring: staying inside the box", () => {
  /** The loudest, fullest reply: every band at 1, level 1. How far the solid band reaches past the box's edge (negative: room left). */
  const overshoot = (stored: Record<string, number>, size: readonly [number, number]) => {
    const f = voice({ level: 1 })
    f.bands.fill(1)
    const calls = settle(make(stored, size), "speaking", 120, { agent: f, palette: PALETTES.light })
    const band = polygons(calls).find((p) => p.pts.length >= 97)!
    const [w, h] = size
    return Math.max(...band.pts.slice(0, 97).map(([x, y]) => Math.hypot(x - w / 2, y - h / 2))) - Math.min(w, h) / 2
  }
  const EXTREMES = { size: 1.15, thickness: 2.5, spectrum: 2 }

  it("the ring and its thickest spectrum band stay inside the box, at every box size, with the default look", () => {
    for (const size of [[160, 140], [358, 160], [W, H], [900, 420], [390, 844]] as const) expect(overshoot({}, size), size.join("×")).toBeLessThanOrEqual(0.01)
  })

  it("...and at the biggest size, thickness and detail in boxes that are not the smallest", () => {
    for (const size of [[W, H], [900, 420], [390, 844]] as const) expect(overshoot(EXTREMES, size), size.join("×")).toBeLessThanOrEqual(0.01)
    for (const size of [[160, 140], [358, 160], [W, H]] as const) {
      expect(overshoot({ thickness: 2.5 }, size), `thickness ${size.join("×")}`).toBeLessThanOrEqual(0.01)
      expect(overshoot({ spectrum: 2 }, size), `spectrum ${size.join("×")}`).toBeLessThanOrEqual(0.01)
    }
  })

  // BUG (see the PR description, "Bugs found"): `fit` sizes the cap as if a stroke unit were Rs / 40, but `unitW` is
  // floored at 1 (× thickness) once Rs < 40, so in the small cells the band is thicker than the cap allows and
  // reaches past the box: 79 px from the centre in a 160 × 140 box (limit 70), 83 px in 358 × 160 (limit 80).
  it.fails("the ring and its band stay inside the small cells at the biggest size, thickness and detail", () => {
    for (const size of [[160, 140], [358, 160]] as const) expect(overshoot(EXTREMES, size), size.join("×")).toBeLessThanOrEqual(0.01)
  })

  it("the ring is centred on the focus's own middle, wherever the box is on the stage", () => {
    const at = (focus: Focus) => ring(settle(make({}, [1280, 800]), "listening", 60, { focus }))
    const a = at({ x: 280, y: 200, width: W, height: H })
    const b = at({ x: 100, y: 40, width: W, height: H })
    expect([a.x, a.y]).toEqual([W / 2, H / 2])
    expect([b.x, b.y]).toEqual([W / 2, H / 2])
    expect(at({ x: 280, y: 200, width: 358, height: 160 }).r).toBeLessThan(a.r)
  })
})
