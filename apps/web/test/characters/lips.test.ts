/**
 * Lips, the behaviour that is its own (the shared suites in `compat.test.ts` and `isolation.test.ts` already run it
 * through the manifest, the modes, the option extremes, reduced-motion stillness, the digest and the stage checks):
 * the mouth shapes the reply's `mouth` estimate draws, the sealed seam that carries your voice, the whisper and
 * shout poses, the thinking glint, and what the options promise (size cap, style, teeth, colour, mouth range).
 * Checked on the paths it draws, through the runner, on the recording canvas.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Focus, Mode, Palette, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import lips from "@/characters/library/lips.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
/** Samples across the mouth (`N` in the character): every lip edge is this many points. */
const N = 33
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Pt = readonly [number, number]
type Path = { readonly op: "fill" | "stroke"; readonly style: string; readonly pts: ReadonlyArray<Pt>; readonly arcs: ReadonlyArray<ReadonlyArray<number>>; readonly ellipses: ReadonlyArray<ReadonlyArray<number>> }

const make = (stored: Record<string, number | boolean | string> = {}, size: readonly [number, number] = [W, H]) => {
  const canvas = document.createElement("canvas")
  const r = new Runner(lips, canvas, stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

interface StepOptions {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly palette?: Palette
  readonly reduced?: boolean
  readonly focus?: Focus
}
const quiet = createVoiceFeatures()

/** The user talking: speaking now, voiced, at `level`, with a sine of `cycles` periods in `wave`. */
const talking = (o: { level?: number; voicing?: number; cycles?: number } = {}): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.speaking = true
  f.speechFor = 2
  f.level = o.level ?? 0.35
  f.rms = 0.05
  f.voicing = o.voicing ?? 1
  f.syllableRate = 3
  const cycles = o.cycles ?? 3
  for (let i = 0; i < f.wave.length; i++) f.wave[i] = Math.sin((i / f.wave.length) * cycles * 2 * Math.PI)
  return f
}
/** The assistant speaking with a mouth shape. */
const saying = (mouth: { open?: number; wide?: number; round?: number }, level = 0.5): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.speaking = true
  f.level = level
  f.voicing = 1
  f.mouth = { open: mouth.open ?? 0, wide: mouth.wide ?? 0, round: mouth.round ?? 0 }
  return f
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
    pointer: { x: 0, y: 0, down: false, inside: false },
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

/** Every filled or stroked path of a frame: its colour and its points, in the box's coordinates. */
const paths = (calls: ReadonlyArray<Call>): Array<Path> => {
  const out: Array<Path> = []
  let fillStyle = ""
  let strokeStyle = ""
  let pts: Array<Pt> = []
  let arcs: Array<Array<number>> = []
  let ellipses: Array<Array<number>> = []
  for (const c of calls) {
    switch (c.name) {
      case "=fillStyle":
        fillStyle = String(c.args[0])
        break
      case "=strokeStyle":
        strokeStyle = String(c.args[0])
        break
      case "beginPath":
        pts = []
        arcs = []
        ellipses = []
        break
      case "moveTo":
      case "lineTo":
        pts.push([c.args[0] as number, c.args[1] as number])
        break
      case "quadraticCurveTo":
        pts.push([c.args[2] as number, c.args[3] as number])
        break
      case "arc":
        arcs.push(c.args as Array<number>)
        break
      case "ellipse":
        ellipses.push(c.args as Array<number>)
        break
      case "fill":
        out.push({ op: "fill", style: fillStyle, pts, arcs, ellipses })
        break
      case "stroke":
        out.push({ op: "stroke", style: strokeStyle, pts, arcs, ellipses })
        break
    }
  }
  return out
}
const rgba = (css: string) => css.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/)!.slice(1).map(Number) as [number, number, number, number]

/** A lip edge or the opening: a polygon of at least two edges of `N` points. */
const polygons = (calls: ReadonlyArray<Call>, op: "fill" | "stroke" = "fill") => paths(calls).filter((p) => p.op === op && p.pts.length >= 2 * N)
/** The dark opening (the first polygon filled while the mouth is open): its edges are the upper then the lower edge. */
const opening = (calls: ReadonlyArray<Call>) => {
  const p = polygons(calls)[0]
  if (p === undefined || p.pts.length !== 2 * N) return undefined
  const mid = (N - 1) / 2
  const top = p.pts[mid]!
  const bottom = p.pts[2 * N - 1 - mid]!
  return { height: bottom[1] - top[1], width: p.pts[N - 1]![0] - p.pts[0]![0], left: p.pts[0]![0], right: p.pts[N - 1]![0] }
}
/** The seam: the stroke of one open line of `N` points in your colour. */
const seam = (calls: ReadonlyArray<Call>, palette: Palette = PALETTES.dark) =>
  paths(calls).find((p) => {
    if (p.op !== "stroke" || p.pts.length !== N) return false
    const [r, g, b] = rgba(p.style)
    return r === palette.you[0] && g === palette.you[1] && b === palette.you[2]
  })
const wiggle = (p: Path) => {
  const ys = p.pts.map(([, y]) => y)
  return Math.max(...ys) - Math.min(...ys)
}
/** How many times the seam crosses its own mean: the number of half-waves of the voice it shows. */
const crossings = (p: Path) => {
  const ys = p.pts.map(([, y]) => y)
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length
  let n = 0
  for (let i = 1; i < ys.length; i++) if ((ys[i - 1]! - mean) * (ys[i]! - mean) < 0) n++
  return n
}

beforeEach(() => {
  recording.log = null
})

describe("lips: the mouth shapes of the reply", () => {
  const speak = (mouth: Parameters<typeof saying>[0], stored: Record<string, number | boolean | string> = {}, o: StepOptions = {}) =>
    settle(make(stored), "speaking", 90, { agent: saying(mouth), ...o })

  it("is sealed while listening and thinking, and a little apart at rest", () => {
    expect(opening(settle(make(), "listening", 60))).toBeUndefined()
    expect(opening(settle(make(), "thinking", 60))).toBeUndefined()
    const idle = opening(settle(make(), "idle", 60))
    expect(idle).toBeDefined()
    expect(idle!.height).toBeGreaterThan(0)
    expect(idle!.height).toBeLessThan(0.1 * H)
  })

  it("the jaw follows agent.mouth.open: closed, then more and more open", () => {
    const heights = [0, 0.25, 0.5, 1].map((open) => opening(speak({ open }))!.height)
    for (let i = 1; i < heights.length; i++) expect(heights[i]!, `open step ${i}`).toBeGreaterThan(heights[i - 1]!)
    expect(heights[3]!).toBeGreaterThan(heights[0]! * 3)
  })

  it("keeps the lips a little apart mid-utterance, and closes them in a pause", () => {
    const talk = opening(speak({ open: 0 }))!
    expect(talk.height).toBeGreaterThan(0)
    const r = make()
    settle(r, "speaking", 60, { agent: saying({ open: 0 }) })
    const paused = createVoiceFeatures() // not speaking: the target opening is 0
    const after = opening(settle(r, "speaking", 90, { agent: paused }))
    expect(after === undefined || after.height < talk.height * 0.25).toBe(true)
  })

  it("'Mouth range' scales how far the jaw opens", () => {
    const small = opening(speak({ open: 0.8 }, { mouthRange: 0.5 }))!.height
    const normal = opening(speak({ open: 0.8 }))!.height
    const large = opening(speak({ open: 0.8 }, { mouthRange: 1.5 }))!.height
    expect(small).toBeLessThan(normal)
    expect(large).toBeGreaterThan(normal)
  })

  it("a wide shape ('ee') is a wider mouth than a neutral one, and a round one ('oo') a narrower mouth", () => {
    const wide = opening(speak({ open: 0.3, wide: 1 }))!.width
    const neutral = opening(speak({ open: 0.3 }))!.width
    const round = opening(speak({ open: 0.3, round: 1 }))!.width
    expect(wide).toBeGreaterThan(neutral * 1.1)
    expect(round).toBeLessThan(neutral * 0.9)
  })

  it("the opening is centred in the box and the lips lie on its edges", () => {
    const o = opening(speak({ open: 0.5 }))!
    expect((o.left + o.right) / 2).toBeCloseTo(W / 2, 0)
    const lipsFilled = polygons(speak({ open: 0.5 }))
    expect(lipsFilled.length).toBeGreaterThanOrEqual(3) // opening, upper lip, lower lip
  })

  it("a loud reply glows inside the mouth more than a soft one; a silent mouth does not glow", () => {
    const glow = (level: number, state: "speaking" | "idle" = "speaking") => {
      const calls = settle(make(), state, 90, { agent: saying({ open: 0.6 }, level) })
      // The glow is an ellipse filled in the voice colour.
      const v = PALETTES.dark.voice
      const hit = paths(calls).find((p) => {
        if (p.op !== "fill" || p.ellipses.length !== 1) return false
        const [r, gg, b] = rgba(p.style)
        return r === v[0] && gg === v[1] && b === v[2]
      })
      return hit === undefined ? 0 : rgba(hit.style)[3]
    }
    expect(glow(0.9)).toBeGreaterThan(glow(0.1))
    expect(glow(0.1)).toBeGreaterThan(0)
    // Silent: when the assistant is not speaking there is no glow, whatever the level.
    expect(glow(0.9, "idle")).toBe(0)
  })
})

describe("lips: teeth, tongue, style and colour", () => {
  const openMouth = { open: 0.9 }
  const speak = (stored: Record<string, number | boolean | string> = {}, o: StepOptions = {}) => settle(make(stored), "speaking", 90, { agent: saying(openMouth), ...o })
  /** The tongue is a half ellipse (from π to 2π) inside the opening. */
  const tongues = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "ellipse" && c.args[5] === Math.PI)

  it("shows a tongue in a wide-open mouth, and 'Teeth and tongue: off' leaves a plain dark opening", () => {
    expect(tongues(speak())).toHaveLength(1)
    expect(tongues(speak({ teeth: false }))).toHaveLength(0)
    // Teeth are drawn with a butt-capped stroke inside the opening: invisible when off.
    const teethAlpha = (calls: ReadonlyArray<Call>) => {
      const butt = calls.findIndex((c) => c.name === "=lineCap" && c.args[0] === "butt")
      const style = calls.slice(0, butt).filter((c) => c.name === "=strokeStyle").at(-1)
      return rgba(String(style!.args[0]))[3]
    }
    expect(teethAlpha(speak())).toBeGreaterThan(0.5)
    expect(teethAlpha(speak({ teeth: false }))).toBe(0)
  })

  it("no tongue when the jaw is barely open, however much the mouth range is turned up", () => {
    expect(tongues(settle(make({ mouthRange: 1.5 }), "speaking", 90, { agent: saying({ open: 0 }) }))).toHaveLength(0)
  })

  it("the filled style paints both lips; the line drawing paints none and outlines them instead", () => {
    const filled = speak()
    const line = speak({ lipStyle: "line" })
    // Filled: the opening and the two lips. Line: the opening only; its contour is stroked.
    expect(polygons(filled).length).toBe(3)
    expect(polygons(line).length).toBe(1)
    expect(polygons(filled, "stroke")).toHaveLength(0)
    expect(polygons(line, "stroke")).toHaveLength(1)
  })

  it("the line drawing is in the ink colour, not the lip colour", () => {
    const contour = polygons(speak({ lipStyle: "line" }), "stroke")[0]!
    const ink = PALETTES.dark.ink
    const [r, g, b] = rgba(contour.style)
    // Between the faint ink and the ink; for a speaking (awake) mouth it is the ink itself.
    expect([r, g, b]).toEqual([...ink])
  })

  it("'Lip colour' paints the lower lip in exactly that colour when awake (light theme, speaking)", () => {
    const calls = speak({ lipColor: "#ff0000" }, { palette: PALETTES.light })
    const lower = polygons(calls).at(-1)!
    expect(rgba(lower.style)).toEqual([255, 0, 0, 1])
    // The default clay is not red, and the upper lip is the same colour in shade.
    const clay = polygons(speak({}, { palette: PALETTES.light })).at(-1)!
    expect(rgba(clay.style).slice(0, 3)).not.toEqual([255, 0, 0])
    const upper = rgba(polygons(calls)[1]!.style)
    expect(upper[0]).toBeLessThan(255)
    expect(upper[1]).toBe(0)
  })

  it("dims when idle: the same lips are closer to the background than when speaking", () => {
    const lower = (mode: Mode, o: StepOptions) => {
      const calls = settle(make(), mode, 60, { palette: PALETTES.light, ...o })
      return rgba(polygons(calls).at(-1)!.style).slice(0, 3)
    }
    const bg = PALETTES.light.bg
    const dist = (c: ReadonlyArray<number>) => Math.hypot(c[0]! - bg[0], c[1]! - bg[1], c[2]! - bg[2])
    expect(dist(lower("idle", {}))).toBeLessThan(dist(lower("speaking", { agent: saying({ open: 0.5 }) })))
  })
})

describe("lips: the sealed seam carries your voice", () => {
  const hear = (user: VoiceFeatures, stored: Record<string, number | boolean | string> = {}, o: StepOptions = {}) => settle(make(stored), "hearing", 90, { user, ...o })
  /** How far the seam of `voiced` is from the seam of the same voice with a silent waveform: what the waves add (the smile's curve is in both). */
  const waves = (voiced: VoiceFeatures, flat: VoiceFeatures, o: StepOptions = {}) => {
    const a = seam(hear(voiced, {}, o))
    const b = seam(hear(flat, {}, o))
    expect(a, "seam while it hears").toBeDefined()
    expect(b, "seam without waves").toBeDefined()
    return a!.pts.map(([, y], i) => Math.abs(y - b!.pts[i]![1]))
  }

  it("traces your waveform along the seam while you speak, in your colour", () => {
    const d = waves(talking({ cycles: 3 }), talking({ cycles: 0 }))
    expect(Math.max(...d)).toBeGreaterThan(2)
  })

  it("under reduced motion the seam stays a still line: no waves", () => {
    const d = waves(talking({ cycles: 3 }), talking({ cycles: 0 }), { reduced: true })
    expect(Math.max(...d)).toBeLessThan(0.01)
  })

  it("the louder you are, the taller the waves", () => {
    const soft = Math.max(...waves(talking({ level: 0.25 }), talking({ level: 0.25, cycles: 0 })))
    const loud = Math.max(...waves(talking({ level: 0.5 }), talking({ level: 0.5, cycles: 0 })))
    expect(soft).toBeGreaterThan(0.5)
    expect(loud).toBeGreaterThan(soft * 1.2)
  })

  it("a deep voice shows long waves, a child's dense ripples", () => {
    const deep = crossings(seam(hear(talking({ cycles: 2 })))!)
    const child = crossings(seam(hear(talking({ cycles: 6 })))!)
    expect(child).toBeGreaterThan(deep + 4)
  })

  it("the waves taper to the corners: the lips' ends stay put", () => {
    const d = waves(talking({ cycles: 3 }), talking({ cycles: 0 }))
    expect(d[0]!).toBeLessThan(0.01)
    expect(d[N - 1]!).toBeLessThan(0.01)
    expect(d[(N - 1) / 2 + 2]!).toBeGreaterThan(d[1]!)
  })

  it("the sealed seam is already there in your colour while listening, before you say anything", () => {
    expect(seam(settle(make(), "listening", 60))).toBeDefined()
  })

  it("a whisper parts the lips a little ('oh?'); ordinary speech keeps them together", () => {
    const whisper = talking({ level: 0.12, voicing: 0.1 })
    const speech = talking({ level: 0.35 })
    const long = (u: VoiceFeatures) => settle(make(), "hearing", 240, { user: u })
    expect(opening(long(whisper))).toBeDefined()
    expect(opening(long(speech))).toBeUndefined()
  })

  it("a shout tightens the lips: a narrower mouth than ordinary speech", () => {
    const widthOf = (u: VoiceFeatures) => {
      const calls = settle(make(), "hearing", 240, { user: u })
      const edge = polygons(calls).find((p) => p.pts.length >= 2 * N)!
      return edge.pts[N - 1]![0] - edge.pts[0]![0]
    }
    expect(widthOf(talking({ level: 0.95 }))).toBeLessThan(widthOf(talking({ level: 0.35 })) * 0.97)
  })
})

describe("lips: thinking", () => {
  const glint = (calls: ReadonlyArray<Call>) => {
    const v = PALETTES.dark.voice
    return paths(calls).find((p) => {
      if (p.op !== "fill" || p.arcs.length !== 1) return false
      const [r, g, b] = rgba(p.style)
      return r === v[0] && g === v[1] && b === v[2]
    })
  }
  const glintX = (calls: ReadonlyArray<Call>) => glint(calls)?.arcs[0]![0]

  it("an amber glint slides along the seam while it thinks, and is not there in any other mode", () => {
    const r = make()
    settle(r, "thinking", 60)
    const xs: Array<number> = []
    for (let i = 0; i < 200; i++) xs.push(glintX(frame(r, "thinking"))!)
    expect(xs.every((x) => Number.isFinite(x))).toBe(true)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(40)
    for (const mode of ["idle", "listening", "hearing", "speaking"] as const) expect(glint(settle(make(), mode, 60, { user: talking(), agent: saying({ open: 0.3 }) })), mode).toBeUndefined()
  })

  it("under reduced motion the glint holds still in the middle", () => {
    const r = make()
    settle(r, "thinking", 60, { reduced: true })
    const a = glintX(frame(r, "thinking", { reduced: true }))!
    for (let i = 0; i < 120; i++) frame(r, "thinking", { reduced: true })
    const b = glintX(frame(r, "thinking", { reduced: true }))!
    expect(b).toBeCloseTo(a, 6)
    expect(Math.abs(a - W / 2)).toBeLessThan(0.15 * W)
  })

  it("the mouth is pushed to one side while it thinks, and is centred while listening", () => {
    const centre = (calls: ReadonlyArray<Call>) => {
      const s = paths(calls).find((p) => p.op === "stroke" && p.pts.length === N)!
      return s.pts[(N - 1) / 2]![0]
    }
    expect(centre(settle(make(), "listening", 90))).toBeCloseTo(W / 2, 0)
    expect(Math.abs(centre(settle(make(), "thinking", 240)) - W / 2)).toBeGreaterThan(10)
  })

  it("thinking and listening are pursed and sealed, but thinking is the narrower mouth", () => {
    const width = (mode: Mode) => {
      const s = paths(settle(make(), mode, 120)).find((p) => p.op === "stroke" && p.pts.length === N)!
      return s.pts[N - 1]![0] - s.pts[0]![0]
    }
    expect(width("thinking")).toBeLessThan(width("listening") * 0.85)
  })
})

describe("lips: the size option and the frame", () => {
  /** The extent of every lip polygon of a frame. */
  const extent = (calls: ReadonlyArray<Call>) => {
    const pts = [...polygons(calls), ...polygons(calls, "stroke")].flatMap((p) => p.pts)
    return { minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])) }
  }

  it("at the biggest size, widest shape and widest jaw, the mouth stays inside the box", () => {
    for (const size of [[W, H], [160, 140], [358, 160], [900, 420]] as const) {
      const mouth = { open: 1, wide: 1 }
      for (const shape of [mouth, { open: 1, round: 1 }]) {
        const r = make({ size: 1.25, mouthRange: 1.5, lineWeight: 1 }, size)
        const e = extent(settle(r, "speaking", 120, { agent: saying(shape) }))
        const label = `${size.join("×")} ${JSON.stringify(shape)}`
        expect(e.minX, `${label} left`).toBeGreaterThanOrEqual(0)
        expect(e.maxX, `${label} right`).toBeLessThanOrEqual(size[0])
        expect(e.minY, `${label} top`).toBeGreaterThanOrEqual(0)
        expect(e.maxY, `${label} bottom`).toBeLessThanOrEqual(size[1])
      }
    }
  })

  it("the size option scales the mouth, and the smallest is about half of the largest", () => {
    const width = (size: number) => {
      const o = opening(settle(make({ size }), "speaking", 90, { agent: saying({ open: 0.5 }) }))!
      return o.width
    }
    expect(width(0.5)).toBeLessThan(width(1) * 0.7)
    expect(width(1)).toBeLessThan(width(1.25) + 1e-6)
  })

  it("draws in the focus on the stage, wherever the box is, and lays out from the focus's size", () => {
    const stage = [1280, 800] as const
    const at = (focus: Focus) => opening(settle(make({}, stage), "speaking", 90, { agent: saying({ open: 0.5 }), focus }))!
    const a = at({ x: 280, y: 200, width: W, height: H })
    const b = at({ x: 100, y: 60, width: W, height: H })
    expect(b.width).toBeCloseTo(a.width, 3)
    expect(b.height).toBeCloseTo(a.height, 3)
    expect((a.left + a.right) / 2).toBeCloseTo(W / 2, 0) // in the focus's own coordinates
    const small = at({ x: 280, y: 200, width: 358, height: 160 })
    expect(small.width).toBeLessThan(a.width)
  })

  it("under reduced motion the mouth holds one half-open pose while speaking, whatever the voice does", () => {
    const pose = (mouth: Parameters<typeof saying>[0]) => opening(settle(make(), "speaking", 90, { agent: saying(mouth), reduced: true }))!
    const a = pose({ open: 0 })
    const b = pose({ open: 1, wide: 1 })
    expect(b.height).toBeCloseTo(a.height, 6)
    expect(b.width).toBeCloseTo(a.width, 6)
    expect(a.height).toBeGreaterThan(0.05 * H)
  })

  it("smile lines hug both corners while it listens (a soft closed smile), and are not drawn at rest", () => {
    const corners = settle(make(), "listening", 60).filter((c) => c.name === "arc")
    expect(corners).toHaveLength(2)
    expect(settle(make(), "idle", 60).filter((c) => c.name === "arc")).toHaveLength(0)
  })
})
