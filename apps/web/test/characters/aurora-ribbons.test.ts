/**
 * Aurora ribbons (src/characters/library/aurora-ribbons.ts): what only this character does, checked on the paths it
 * draws on the recording canvas. The shared suites (compat, isolation) already cover its manifest, every mode and
 * option extreme, reduced-motion stillness and its recorded digest; this file covers the ribbons themselves: when
 * one is born and which way it drifts, how many there are, the form, the style, the intonation tilt, the room they
 * keep, the colour of each side, and the motes on the horizon line.
 *
 * A ribbon is a closed lens drawn in two passes (the outer lens and a narrower core), so the ribbons of a frame
 * are every other closed path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Focus, Mode, OptionValues, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import aurora from "@/characters/library/aurora-ribbons.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()
// Several tests play 300 frames or more; leave room on a slow CI runner.
vi.setConfig({ testTimeout: 30_000 })

const W = 720
const H = 240
const DT = 1 / 60

type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
interface Path {
  readonly xs: Array<number>
  readonly ys: Array<number>
  closed: boolean
  readonly fills: Array<number> // alpha of each fill
  readonly fillColours: Array<string>
  readonly strokes: Array<number> // alpha of each stroke
}

beforeEach(() => {
  recording.log = null
})

const make = (stored: OptionValues = {}, size: readonly [number, number] = [W, H]) => {
  const r = new Runner(aurora, document.createElement("canvas"), stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

interface Drive {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly reduced?: boolean
  readonly focus?: Focus
  readonly palette?: "dark" | "light"
}
const quiet = createVoiceFeatures()
const tick = (r: Runner, mode: Mode, o: Drive = {}): Array<Call> => {
  recording.log = []
  r.step({ mode, dt: DT, user: o.user ?? quiet, agent: o.agent ?? quiet, palette: PALETTES[o.palette ?? "dark"], reducedMotion: o.reduced === true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity, ...(o.focus !== undefined ? { focus: o.focus } : {}) })
  const calls = recording.log
  recording.log = null
  return calls
}

interface VoiceOpts {
  level?: number
  onset?: number
  speaking?: boolean
  voicing?: number
  pitchDelta?: number
  register?: number
  syllableRate?: number
  bands?: number
  brightness?: number
}
const voice = (o: VoiceOpts = {}): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.level = o.level ?? 0.5
  f.rms = f.level * 0.1
  f.low = f.mid = f.high = f.level
  f.onset = o.onset ?? 0
  f.speaking = o.speaking ?? false
  f.voicing = o.voicing ?? 1
  f.pitchDelta = o.pitchDelta ?? 0
  f.register = o.register ?? f.register
  f.syllableRate = o.syllableRate ?? 0
  f.bands.fill(o.bands ?? 0)
  f.brightness = o.brightness ?? f.brightness
  return f
}

const lo = (a: ReadonlyArray<number>) => a.reduce((m, v) => Math.min(m, v), Infinity)
const hi = (a: ReadonlyArray<number>) => a.reduce((m, v) => Math.max(m, v), -Infinity)

const alphaOf = (style: string): number => Number(style.match(/rgba\([^,]+,[^,]+,[^,]+,([\d.e-]+)\)/)?.[1] ?? Number.NaN)
const rgbOf = (style: string): Array<number> => style.match(/rgba\((\d+),(\d+),(\d+),/)!.slice(1, 4).map(Number)

/** Every closed path of a frame, with what was done to it. */
const closedPaths = (calls: ReadonlyArray<Call>): Array<Path> => {
  const out: Array<Path> = []
  let cur: Path = { xs: [], ys: [], closed: false, fills: [], fillColours: [], strokes: [] }
  let fillStyle = ""
  let strokeStyle = ""
  for (const c of calls) {
    if (c.name === "beginPath") cur = { xs: [], ys: [], closed: false, fills: [], fillColours: [], strokes: [] }
    else if (c.name === "moveTo" || c.name === "lineTo") {
      cur.xs.push(c.args[0] as number)
      cur.ys.push(c.args[1] as number)
    } else if (c.name === "closePath") {
      cur.closed = true
      out.push(cur)
    } else if (c.name === "=fillStyle") fillStyle = String(c.args[0])
    else if (c.name === "=strokeStyle") strokeStyle = String(c.args[0])
    else if (c.name === "fill") {
      cur.fills.push(alphaOf(fillStyle))
      cur.fillColours.push(fillStyle)
    } else if (c.name === "stroke") cur.strokes.push(alphaOf(strokeStyle))
  }
  return out
}
/** The outer lens of each ribbon on screen. */
const ribbons = (calls: ReadonlyArray<Call>) => closedPaths(calls).filter((_, i) => i % 2 === 0)
/** Where a ribbon is, across the width: −1 (left edge) .. 1 (right edge). */
const centreOf = (p: Path, width = W) => ((Math.min(...p.xs) + Math.max(...p.xs)) / 2 / width) * 2 - 1
/** The horizon line: the last stroked straight path from the left edge to the right. */
const horizon = (calls: ReadonlyArray<Call>) => {
  const i = calls.map((c) => c.name).lastIndexOf("lineTo")
  return calls[i]!.args as [number, number]
}
/** Circles drawn in the frame: x, y, radius. */
const circles = (calls: ReadonlyArray<Call>) => calls.filter((c) => c.name === "arc").map((c) => ({ x: c.args[0] as number, y: c.args[1] as number, r: c.args[2] as number }))

/** `frames` frames in one mode, with the voice of frame `i` (the same for both sides); the calls of the last frame. */
const play = (mode: Mode, frames: number, voiceAt: (i: number) => VoiceFeatures, o: Drive & { readonly stored?: OptionValues; readonly canvas?: readonly [number, number]; readonly each?: (calls: Array<Call>, i: number) => void } = {}) => {
  const r = make(o.stored, o.canvas)
  let calls: Array<Call> = []
  for (let i = 0; i < frames; i++) {
    const v = voiceAt(i)
    calls = tick(r, mode, { user: v, agent: v, ...(o.reduced === true ? { reduced: true } : {}), ...(o.focus !== undefined ? { focus: o.focus } : {}), ...(o.palette !== undefined ? { palette: o.palette } : {}) })
    o.each?.(calls, i)
  }
  return calls
}
const steady = (o: VoiceOpts = {}) => () => voice(o)
/** A steady voice with an onset at each of the given frames. */
const onsets = (at: ReadonlyArray<number>, o: VoiceOpts = {}) => (i: number) => voice({ ...o, onset: at.includes(i) ? 1 : 0 })
/** An onset every `every` frames: a run of syllables. */
const syllables = (every: number, o: VoiceOpts = {}) => (i: number) => voice({ ...o, onset: i % every === 0 ? 1 : 0 })

describe("ribbons are born from syllables", () => {
  it("an onset blooms one ribbon while taking in or giving out; without an onset, no ribbon appears", () => {
    for (const mode of ["hearing", "speaking"] as const) {
      expect(ribbons(play(mode, 50, steady())), `${mode}, no onset`).toHaveLength(0)
      expect(ribbons(play(mode, 50, onsets([10]))), `${mode}, one onset`).toHaveLength(1)
      expect(ribbons(play(mode, 50, onsets([10, 25]))), `${mode}, two onsets`).toHaveLength(2)
    }
  })

  it("an onset that stays high is one syllable", () => {
    expect(ribbons(play("hearing", 50, (i) => voice({ onset: i >= 10 ? 1 : 0 })))).toHaveLength(1)
  })

  it("reduced motion spawns nothing: syllables change nothing in the still set", () => {
    const set = (voiceAt: (i: number) => VoiceFeatures) => JSON.stringify(closedPaths(play("hearing", 60, voiceAt, { reduced: true })))
    expect(set(syllables(5, { level: 0.5 }))).toBe(set(steady({ level: 0.5 })))
  })

  it("reduced motion holds the lenses while live pitch, spectrum, voicing and brightness keep changing", () => {
    const live = (i: number) => voice({ level: 0.5, speaking: true, pitchDelta: 7 * Math.sin(i / 5), bands: 0.5 + 0.5 * Math.sin(i / 7), voicing: 0.5 + 0.5 * Math.cos(i / 9), brightness: 0.5 + 0.5 * Math.sin(i / 11) })
    const held = (voiceAt: (i: number) => VoiceFeatures) => JSON.stringify(closedPaths(play("hearing", 120, voiceAt, { reduced: true })))
    expect(held(live)).toBe(held(steady({ level: 0.5, speaking: true })))
  })

  it("never shows more ribbons than the ribbons option allows, however many syllables arrive", () => {
    const most = (count: number) => {
      let m = 0
      play("hearing", 600, syllables(5, { level: 0.9, speaking: true, syllableRate: 5, bands: 0.9 }), { stored: { count }, each: (calls) => (m = Math.max(m, ribbons(calls).length)) })
      return m
    }
    expect(most(3)).toBeLessThanOrEqual(3)
    expect(most(3)).toBeGreaterThan(0)
    expect(most(16)).toBeGreaterThan(3)
    expect(most(16)).toBeLessThanOrEqual(16)
  })
})

describe("which way ribbons drift", () => {
  /** Distance of the born ribbon from the middle (0..1) `after` frames after its onset, with no other ribbons around. */
  const offset = (mode: Mode, after: number, stored: OptionValues = {}) => {
    const p = ribbons(play(mode, 10 + after, onsets([10], { level: 0.6 }), { stored }))
    expect(p).toHaveLength(1)
    return Math.abs(centreOf(p[0]!))
  }

  it("taken in: a ribbon is born toward the edge and travels to the centre", () => {
    expect(offset("hearing", 40)).toBeLessThan(offset("hearing", 12))
  })

  it("given out: a ribbon is born near the centre and travels outward", () => {
    expect(offset("speaking", 12)).toBeLessThan(0.45)
    expect(offset("speaking", 40)).toBeGreaterThan(offset("speaking", 12))
  })

  it("the motion speed option scales how fast ribbons drift", () => {
    const travel = (speed: number) => Math.abs(offset("speaking", 40, { speed }) - offset("speaking", 12, { speed }))
    expect(travel(2) / travel(1)).toBeGreaterThan(1.6)
    expect(travel(0.5) / travel(1)).toBeLessThan(0.75)
  })
})

describe("reduced motion: a still arrangement per mode", () => {
  const still = (mode: Mode, stored: OptionValues = {}, voiceAt = steady()) => ribbons(play(mode, 20, voiceAt, { reduced: true, stored }))

  it("six lenses in every mode but idle, or as many as the ribbons option allows", () => {
    expect(still("idle")).toHaveLength(0)
    for (const mode of ["listening", "hearing", "thinking", "speaking"] as const) {
      expect(still(mode, {}, steady({ level: 0.8 })), mode).toHaveLength(6)
      expect(still(mode, { count: 4 }, steady({ level: 0.8 })), `${mode}, 4 ribbons`).toHaveLength(4)
      expect(still(mode, { count: 16 }, steady({ level: 0.8 })), `${mode}, 16 ribbons`).toHaveLength(6)
    }
  })

  it("gathers the person's lenses in the middle and spreads the assistant's", () => {
    const span = (mode: Mode) => {
      const xs = still(mode, {}, steady({ level: 0.8 })).flatMap((p) => p.xs)
      return hi(xs) - lo(xs)
    }
    expect(span("hearing")).toBeLessThan(span("speaking"))
  })
})

describe("form, style and the room they keep", () => {
  const loud = syllables(6, { level: 0.9, speaking: true, syllableRate: 4, bands: 0.9 })
  /** Every ribbon point of 300 frames: [x, y]. */
  const points = (stored: OptionValues, o: Parameters<typeof play>[3] = {}, mode: Mode = "hearing") => {
    const pts: Array<readonly [number, number]> = []
    let y0 = 0
    play(mode, 300, loud, {
      ...o,
      stored,
      each: (calls) => {
        y0 = horizon(calls)[1]
        for (const p of ribbons(calls)) p.xs.forEach((x, k) => pts.push([x, p.ys[k]!]))
      }
    })
    return { pts, y0 }
  }

  it("mirrored: ribbons grow up and down from a horizon in the middle; rising: only upward from a low horizon", () => {
    const mirrored = points({})
    expect(mirrored.y0).toBeCloseTo(H / 2, 6)
    expect(lo(mirrored.pts.map(([, y]) => y))).toBeLessThan(H / 2 - 20)
    expect(hi(mirrored.pts.map(([, y]) => y))).toBeGreaterThan(H / 2 + 20)
    const rising = points({ form: "rising" })
    expect(rising.y0).toBeCloseTo(0.86 * H, 6)
    expect(rising.pts.length).toBeGreaterThan(0)
    expect(hi(rising.pts.map(([, y]) => y))).toBeLessThanOrEqual(rising.y0 + 1e-6)
    expect(lo(rising.pts.map(([, y]) => y))).toBeLessThan(rising.y0 - 40)
  })

  it("keeps the ribbons inside the box at the largest size and the strongest tilt, in either form", () => {
    for (const form of ["mirrored", "rising"]) {
      const { pts } = points({ form, size: 1.4, intonation: 2 })
      expect(pts.length, form).toBeGreaterThan(0)
      const ys = pts.map(([, y]) => y)
      const xs = pts.map(([x]) => x)
      expect(lo(ys), `${form} top`).toBeGreaterThanOrEqual(3 - 1e-6)
      expect(hi(ys), `${form} bottom`).toBeLessThanOrEqual(H - 3 + 1e-6)
      expect(lo(xs), `${form} left`).toBeGreaterThanOrEqual(0)
      expect(hi(xs), `${form} right`).toBeLessThanOrEqual(W)
    }
  })

  it("a falling or rising voice at the strongest tilt never pushes a ribbon outside the box, in either form", () => {
    for (const form of ["mirrored", "rising"]) {
      for (const pitchDelta of [-7, 7]) {
        const voiceAt = syllables(6, { level: 1, speaking: true, syllableRate: 4, bands: 1, pitchDelta })
        const ys: Array<number> = []
        play("hearing", 300, voiceAt, { stored: { form, size: 1.4, intonation: 2 }, each: (calls) => ribbons(calls).forEach((p) => ys.push(...p.ys)) })
        expect(ys.length, `${form} ${pitchDelta}`).toBeGreaterThan(0)
        expect(lo(ys), `${form} ${pitchDelta} top`).toBeGreaterThanOrEqual(3 - 1e-6)
        expect(hi(ys), `${form} ${pitchDelta} bottom`).toBeLessThanOrEqual(H - 3 + 1e-6)
      }
    }
  })

  it("on the stage, may swell past the box's top and bottom where the page has room, but not into the canvas edge", () => {
    const BOX: Focus = { x: 280, y: 200, width: W, height: H }
    const roomy = points({}, { canvas: [1280, 800], focus: BOX })
    expect(lo(roomy.pts.map(([, y]) => y))).toBeLessThan(0)
    expect(hi(roomy.pts.map(([, y]) => y))).toBeGreaterThan(H)
    // A box 20 px from the top of the canvas: the ribbons stop 12 px short of it.
    const tight = points({}, { canvas: [1280, 800], focus: { ...BOX, y: 20 } })
    expect(lo(tight.pts.map(([, y]) => y)) + 20).toBeGreaterThanOrEqual(12 - 1e-6)
    // Without the room (the box is the whole canvas) they stay in the box.
    expect(lo(points({}).pts.map(([, y]) => y))).toBeGreaterThanOrEqual(3 - 1e-6)
  })

  it("soft: filled light; outline: thin lines only", () => {
    const paths = (style: string) => closedPaths(play("hearing", 120, syllables(6, { level: 0.8, speaking: true, voicing: 1, bands: 0.5 }), { stored: { style } }))
    const soft = paths("soft")
    const outline = paths("outline")
    expect(soft.some((p) => p.fills.length > 0)).toBe(true)
    expect(outline.length).toBeGreaterThan(0)
    expect(outline.every((p) => p.fills.length === 0)).toBe(true)
    expect(outline.some((p) => p.strokes.length > 0)).toBe(true)
  })
})

describe("voicing: filled light for a voiced sound, breathy outlines for a whisper", () => {
  const frame = (voicing: number) => closedPaths(play("hearing", 200, syllables(8, { level: 0.8, speaking: true, voicing, bands: 0.5 })))
  const fill = (paths: ReadonlyArray<Path>) => Math.max(0, ...paths.flatMap((p) => p.fills))
  const lines = (paths: ReadonlyArray<Path>) => Math.max(0, ...paths.flatMap((p) => p.strokes))

  it("a voiced voice has strong fills and no outlines; a whisper has faint fills and outlines", () => {
    const voiced = frame(1)
    const whisper = frame(0)
    expect(voiced.length).toBeGreaterThan(0)
    expect(whisper.length).toBeGreaterThan(0)
    expect(fill(voiced)).toBeGreaterThan(fill(whisper) * 3)
    expect(lines(voiced)).toBe(0)
    expect(lines(whisper)).toBeGreaterThan(0.25)
  })
})

describe("intonation tilt", () => {
  /** How far the ribbons reach above and below the horizon. */
  const reach = (pitchDelta: number, stored: OptionValues = {}) => {
    const calls = play("hearing", 240, syllables(7, { level: 0.6, speaking: true, pitchDelta, bands: 0.5 }), { stored })
    const y0 = horizon(calls)[1]
    const ys = ribbons(calls).flatMap((p) => p.ys)
    expect(ys.length).toBeGreaterThan(0)
    return { up: y0 - lo(ys), down: hi(ys) - y0 }
  }

  it("rising pitch lifts the lenses above the line, falling sinks them, flat keeps them mirrored", () => {
    const rise = reach(7)
    const fall = reach(-7)
    const flat = reach(0)
    expect(rise.up).toBeGreaterThan(rise.down * 2)
    expect(fall.down).toBeGreaterThan(fall.up * 2)
    expect(Math.abs(flat.up - flat.down)).toBeLessThan(1)
  })

  it("'follow intonation' at 0 keeps them mirrored whatever the voice does", () => {
    const rise = reach(7, { intonation: 0 })
    expect(Math.abs(rise.up - rise.down)).toBeLessThan(1)
  })
})

describe("the colour of each side", () => {
  const fills = (mode: Mode, palette: "dark" | "light", stored: OptionValues = {}) =>
    closedPaths(play(mode, 120, syllables(6, { level: 0.8, speaking: true, bands: 0.5 }), { palette, stored }))
      .filter((_, i) => i % 2 === 0)
      .flatMap((p) => p.fillColours)
  const dist = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) => Math.hypot(...a.map((v, i) => v - b[i]!))

  it("with the colour range at 0, every ribbon of the person is their colour and every one of the assistant is the assistant's", () => {
    const you = [...PALETTES.dark.you]
    const voice = [...PALETTES.dark.voice]
    const mine = fills("hearing", "dark", { colourRange: 0 })
    const theirs = fills("speaking", "dark", { colourRange: 0 })
    expect(mine.length).toBeGreaterThan(0)
    expect(theirs.length).toBeGreaterThan(0)
    for (const c of mine) expect(rgbOf(c)).toEqual(you)
    for (const c of theirs) expect(rgbOf(c)).toEqual(voice)
  })

  it("with the default range, the person's ribbons stay nearer their colour than the assistant's, and the other way round", () => {
    for (const palette of ["dark", "light"] as const) {
      const you = [...PALETTES[palette].you]
      const voice = [...PALETTES[palette].voice]
      for (const c of fills("hearing", palette)) expect(dist(rgbOf(c), you), `${palette} hearing`).toBeLessThan(dist(rgbOf(c), voice))
      for (const c of fills("speaking", palette)) expect(dist(rgbOf(c), voice), `${palette} speaking`).toBeLessThan(dist(rgbOf(c), you))
    }
  })

  it("a wider colour range lets the ribbons stray further from the person's colour", () => {
    const you = [...PALETTES.dark.you]
    const strays = (range: number) => Math.max(...fills("hearing", "dark", { colourRange: range }).map((c) => dist(rgbOf(c), you)))
    expect(strays(3)).toBeGreaterThan(strays(1))
    expect(strays(1)).toBeGreaterThan(strays(0))
  })
})

describe("haze", () => {
  const glows = (stored: OptionValues, mode: Mode) => play(mode, 60, steady({ level: 0.7, speaking: true }), { stored }).filter((c) => c.name === "drawImage").length

  it("a soft glow behind the ribbons while taking in or giving out, gone with the option off", () => {
    for (const mode of ["hearing", "speaking"] as const) {
      expect(glows({}, mode), mode).toBeGreaterThan(0)
      expect(glows({ haze: false }, mode), `${mode} without haze`).toBe(0)
    }
  })
})

describe("the horizon line and its motes", () => {
  it("idle: a still line and nothing else", () => {
    const calls = play("idle", 60, steady())
    expect(closedPaths(calls)).toEqual([])
    expect(circles(calls)).toEqual([])
    expect(horizon(calls)).toEqual([W, H / 2])
  })

  it("listening: two motes slide in from the ends toward the middle, mirrored, at the motion speed", () => {
    const motes = (stored: OptionValues = {}) => {
      const xs: Array<number> = []
      let pair: Array<{ x: number; y: number; r: number }> = []
      play("listening", 50, steady({ level: 0 }), {
        stored,
        each: (calls, i) => {
          const c = circles(calls)
          if (i === 20 || i === 21) pair = c
          if (i >= 20 && i <= 21) xs.push(c[0]!.x)
        }
      })
      return { step: xs[1]! - xs[0]!, pair }
    }
    const slow = motes()
    // Each mote is drawn at x and at W − x.
    expect(slow.pair[0]!.x + slow.pair[1]!.x).toBeCloseTo(W, 6)
    expect(slow.pair[0]!.x).toBeLessThan(W * 0.42 + 1e-6)
    // 0.45 of the 0.42 W track per second, at 60 frames a second.
    expect(slow.step).toBeCloseTo((0.45 * 0.42 * W) / 60, 3)
    expect(motes({ speed: 2 }).step).toBeCloseTo(2 * slow.step, 3)
  })

  it("listening with reduced motion: one still dot in the middle of the line", () => {
    const calls = play("listening", 30, steady(), { reduced: true })
    const dot = circles(calls)
    expect(dot).toHaveLength(1)
    expect(dot[0]!.x).toBeCloseTo(W / 2, 6)
    expect(dot[0]!.y).toBeCloseTo(H / 2, 6)
  })

  it("thinking: a bright spot runs back and forth along the line, between 0.12 and 0.88 of the width", () => {
    const xs: Array<number> = []
    play("thinking", 360, steady({ level: 0 }), {
      each: (calls) => {
        const dot = circles(calls).filter((c) => Math.abs(c.r - 1.8) < 1e-6)
        if (dot.length === 1) xs.push(dot[0]!.x)
      }
    })
    expect(xs.length).toBeGreaterThan(300)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0.12 * W - 1e-6)
    expect(Math.max(...xs)).toBeLessThanOrEqual(0.88 * W + 1e-6)
    expect(Math.min(...xs)).toBeLessThan(0.14 * W)
    expect(Math.max(...xs)).toBeGreaterThan(0.86 * W)
  })
})
