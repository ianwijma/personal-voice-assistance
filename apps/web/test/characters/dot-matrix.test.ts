/**
 * What is particular to the dot matrix, read off the paths it fills on the recording canvas through the runner. The
 * shared suites (`compat.test.ts`, `isolation.test.ts`) already cover its manifest, every mode, option extremes,
 * garbage in storage, reduced-motion stillness, the recorded digest and the stage placement; this adds the design's
 * own promises, as `modes`, `mappings` and `options` declare them:
 *   - the panel is 19 × 9, 27 × 13 or 39 × 19 LEDs, centred on the box and fitted to it, and Size shrinks it;
 *   - LEDs are round or square (morphing between them), with the unlit ones shown or hidden; a new grid swaps
 *     behind a fade (and at once under reduced motion);
 *   - each LED is lit by one channel: grey for the face, mint for the ears, amber for the mouth and the "…";
 *   - the ears meter your pitch (row) and loudness (length, a second column above 0.55) while you speak;
 *   - the eyes' height says the mode; the glow only appears on a dark theme with motion and LEDs big enough.
 */
import { describe, expect, it } from "vitest"
import type { Focus, Mode, Palette, Rgb, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import dotMatrix from "@/characters/library/dot-matrix.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const CANVAS: readonly [number, number] = [1280, 800]
const BOX: Focus = { x: 280, y: 197, width: 720, height: 240 }
const DPR = 2
const DT = 1 / 60
type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Stored = Record<string, number | boolean | string>
type Channel = "ink" | "you" | "voice"

const GRIDS = { coarse: [19, 9], medium: [27, 13], fine: [39, 19] } as const

const voice = (over: Partial<VoiceFeatures> = {}): VoiceFeatures => ({ ...createVoiceFeatures(), ...over })

interface Drive {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly palette?: Palette
  readonly reduced?: boolean
  readonly focus?: Focus
}

/** A dot matrix on the stage; `run` steps it and returns each frame's calls. */
const matrix = (stored: Stored = {}) => {
  const runner = new Runner(dotMatrix, document.createElement("canvas"), stored)
  runner.create()
  runner.resize(CANVAS[0], CANVAS[1], DPR)
  const silent = voice()
  const api = {
    run(mode: Mode, frames: number, d: Drive = {}): Array<Array<Call>> {
      const out: Array<Array<Call>> = []
      for (let i = 0; i < frames; i++) {
        recording.log = []
        runner.step({ mode, dt: DT, user: d.user ?? silent, agent: d.agent ?? silent, palette: d.palette ?? PALETTES.dark, reducedMotion: d.reduced === true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity, focus: d.focus ?? BOX })
        out.push(recording.log)
      }
      recording.log = null
      return out
    },
    setStored: (s: Stored) => runner.setStored(s)
  }
  return api
}

interface Fill {
  readonly kind: "arc" | "rect" | "roundRect" | "none"
  /** Centres of the LEDs, CSS px on the canvas. */
  readonly leds: ReadonlyArray<readonly [number, number]>
  readonly colour: Rgb | null
  readonly alpha: number
  readonly blur: number
}

const rgb = (css: string): Rgb | null => {
  const m = css.match(/rgba\((\d+),(\d+),(\d+),([\d.e-]+)\)/)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Every `fill` of a frame: the LEDs of its path (centres through the transform), its colour, alpha and glow. */
const fills = (calls: ReadonlyArray<Call>): Array<Fill> => {
  const out: Array<Fill> = []
  let m = [1, 0, 0, 1, 0, 0]
  let colour: Rgb | null = null
  let alpha = 1
  let blur = 0
  let leds: Array<readonly [number, number]> = []
  let kind: Fill["kind"] = "none"
  const at = (x: number, y: number) => [(m[0]! * x + m[2]! * y + m[4]!) / DPR, (m[1]! * x + m[3]! * y + m[5]!) / DPR] as const
  for (const c of calls) {
    const a = c.args as Array<number>
    switch (c.name) {
      case "setTransform":
        m = a
        break
      case "=fillStyle":
        colour = typeof c.args[0] === "string" ? rgb(c.args[0]) : null
        break
      case "=globalAlpha":
        alpha = a[0]!
        break
      case "=shadowBlur":
        blur = a[0]!
        break
      case "beginPath":
        leds = []
        kind = "none"
        break
      case "arc":
        kind = "arc"
        leds.push(at(a[0]!, a[1]!))
        break
      case "rect":
      case "roundRect":
        kind = c.name
        leds.push(at(a[0]! + a[2]! / 2, a[1]! + a[3]! / 2))
        break
      case "fill":
        out.push({ kind, leds, colour, alpha, blur })
        break
    }
  }
  return out
}

const OFF = (p: Palette): Rgb => [0, 1, 2].map((i) => p.inkFaint[i]! + (p.bg[i]! - p.inkFaint[i]!) * (p.dark ? 0.72 : 0.62)) as unknown as Rgb

/** The unlit panel: the one fill with a LED at every grid position (all grids have 171 or more). */
const isPanel = (f: Fill): boolean => f.leds.length >= 171
const unlit = (calls: ReadonlyArray<Call>): Fill | undefined => fills(calls).find(isPanel)

/** The channel a lit colour belongs to: every lit colour is the unlit grey mixed toward ink, mint or amber, so the one it lies on the line to. */
const channelOf = (c: Rgb, p: Palette): Channel => {
  const off = OFF(p)
  const res = (target: Rgb): number => {
    const d = [0, 1, 2].map((i) => target[i]! - off[i]!)
    const e = [0, 1, 2].map((i) => c[i]! - off[i]!)
    const n = d.reduce((s, x) => s + x * x, 0)
    const t = e.reduce((s, x, i) => s + x * d[i]!, 0) / n
    return Math.hypot(...e.map((x, i) => x - t * d[i]!))
  }
  const rs: Array<readonly [Channel, number]> = [["ink", res(p.ink)], ["you", res(p.you)], ["voice", res(p.voice)]]
  return rs.sort((a, b) => a[1] - b[1])[0]![0]
}

/** The LEDs lit by each channel in a frame, as grid (column, row) from the unlit panel's top-left. */
const lit = (calls: ReadonlyArray<Call>, palette: Palette = PALETTES.dark) => {
  const all = fills(calls)
  const panel = all.find(isPanel)!
  const xs = panel.leds.map(([x]) => x)
  const ys = panel.leds.map(([, y]) => y)
  const x0 = Math.min(...xs)
  const y0 = Math.min(...ys)
  const pitch = (Math.max(...xs) - x0) / (new Set(xs.map((x) => Math.round(x * 100))).size - 1)
  const by: { [C in Channel]: Array<readonly [number, number]> } = { ink: [], you: [], voice: [] }
  for (const f of all) {
    if (f === panel || f.colour === null) continue
    for (const [x, y] of f.leds) by[channelOf(f.colour, palette)].push([Math.round((x - x0) / pitch), Math.round((y - y0) / pitch)] as const)
  }
  return { ...by, pitch, x0, y0 }
}

const last = <T,>(xs: ReadonlyArray<T>): T => xs[xs.length - 1]!

describe("dot matrix: the panel", () => {
  it("has 19 × 9, 27 × 13 or 39 × 19 LEDs according to Grid, and 27 × 13 by default", () => {
    for (const [grid, [cols, rows]] of Object.entries(GRIDS)) {
      const calls = last(matrix({ grid }).run("idle", 3, { reduced: true }))
      const panel = unlit(calls)!
      expect(panel.leds.length, grid).toBe(cols * rows)
      expect(new Set(panel.leds.map(([x]) => Math.round(x * 100))).size, `${grid} columns`).toBe(cols)
      expect(new Set(panel.leds.map(([, y]) => Math.round(y * 100))).size, `${grid} rows`).toBe(rows)
    }
    expect(unlit(last(matrix().run("idle", 3)))!.leds).toHaveLength(27 * 13)
  })

  it("is centred on the box and fitted to it with a margin, whatever the box's shape and the grid", () => {
    const boxes: ReadonlyArray<Focus> = [BOX, { x: 100, y: 100, width: 200, height: 600 }, { x: 0, y: 300, width: 900, height: 90 }]
    for (const focus of boxes) {
      for (const [grid, [cols, rows]] of Object.entries(GRIDS)) {
        const panel = unlit(last(matrix({ grid }).run("idle", 3, { reduced: true, focus })))!
        const xs = panel.leds.map(([x]) => x)
        const ys = panel.leds.map(([, y]) => y)
        const pitch = Math.min((focus.width * 0.94) / cols, (focus.height * 0.9) / rows)
        expect((Math.min(...xs) + Math.max(...xs)) / 2, `${grid} in ${focus.width}×${focus.height}: x`).toBeCloseTo(focus.x + focus.width / 2, 3)
        expect((Math.min(...ys) + Math.max(...ys)) / 2, `${grid} in ${focus.width}×${focus.height}: y`).toBeCloseTo(focus.y + focus.height / 2, 3)
        expect((Math.max(...xs) - Math.min(...xs)) / (cols - 1), `${grid} in ${focus.width}×${focus.height}: pitch`).toBeCloseTo(pitch, 3)
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(focus.width)
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(focus.height)
      }
    }
  })

  it("the size option shrinks the panel about its centre", () => {
    const span = (size: number) => {
      const xs = unlit(last(matrix({ size }).run("idle", 3, { reduced: true })))!.leds.map(([x]) => x)
      return [Math.max(...xs) - Math.min(...xs), (Math.max(...xs) + Math.min(...xs)) / 2] as const
    }
    expect(span(0.5)[0]).toBeCloseTo(0.5 * span(1)[0], 3)
    expect(span(0.5)[1]).toBeCloseTo(span(1)[1], 3)
  })

  it("draws round LEDs, or square ones; with the unlit ones shown, or only the lit ones", () => {
    const style = (ledStyle: string) => {
      const calls = last(matrix({ ledStyle }).run("listening", 5, { reduced: true }))
      return { all: fills(calls), panel: unlit(calls) }
    }
    expect(style("round").panel!.kind).toBe("arc")
    expect(style("square").panel!.kind).toBe("rect")
    for (const [name, kind] of [["roundLit", "arc"], ["squareLit", "rect"]] as const) {
      const s = style(name)
      expect(s.panel, name).toBeUndefined()
      expect(s.all.length, name).toBeGreaterThan(0)
      expect(s.all.every((f) => f.kind === kind), name).toBe(true)
    }
    // Hiding the unlit LEDs leaves the lit ones exactly where they were.
    const sameLit = (a: string, b: string) => {
      const [pa, pb] = [style(a), style(b)]
      const sum = (s: typeof pa) => s.all.filter((f) => !isPanel(f)).reduce((n, f) => n + f.leds.length, 0)
      return [sum(pa), sum(pb)]
    }
    expect(sameLit("round", "roundLit")[0]).toBe(sameLit("round", "roundLit")[1])
  })

  it("morphs between round and square through rounded squares, and snaps under reduced motion", () => {
    const r = matrix({ ledStyle: "round" })
    r.run("idle", 30)
    r.setStored({ ledStyle: "square" })
    const kinds = r.run("idle", 120).map((calls) => unlit(calls)!.kind)
    expect(kinds[0]).not.toBe("rect")
    expect(kinds).toContain("roundRect")
    expect(last(kinds)).toBe("rect")
    const s = matrix({ ledStyle: "round" })
    s.run("idle", 5, { reduced: true })
    s.setStored({ ledStyle: "square" })
    expect(unlit(s.run("idle", 1, { reduced: true })[0]!)!.kind).toBe("rect")
  })

  it("a new grid is swapped behind a fade: the LED count only changes while the panel is dimmed; reduced motion swaps at once", () => {
    const r = matrix({ grid: "medium" })
    r.run("idle", 30)
    r.setStored({ grid: "fine" })
    const seen = r.run("idle", 60).map((calls) => {
      const p = unlit(calls)!
      return { count: p.leds.length, alpha: p.alpha }
    })
    expect(seen[0]!.count).toBe(27 * 13)
    expect(last(seen)).toEqual({ count: 39 * 19, alpha: 1 })
    expect(seen.some((s) => s.alpha < 1)).toBe(true)
    seen.forEach((s, i) => {
      if (i > 0 && s.count !== seen[i - 1]!.count) expect(s.alpha, `frame ${i}, where the grid changes`).toBeLessThan(0.5)
    })
    const q = matrix({ grid: "medium" })
    q.run("idle", 5, { reduced: true })
    q.setStored({ grid: "coarse" })
    const first = unlit(q.run("idle", 1, { reduced: true })[0]!)!
    expect(first.leds).toHaveLength(19 * 9)
    expect(first.alpha).toBe(1)
  })
})

describe("dot matrix: which channel lights what", () => {
  const rest = (mode: Mode, d: Drive = {}, stored: Stored = {}) => lit(last(matrix(stored).run(mode, 120, { reduced: true, ...d })))

  it("at rest the face is grey: nothing mint or amber", () => {
    const l = rest("idle")
    expect(l.ink.length).toBeGreaterThan(0)
    expect([l.you.length, l.voice.length]).toEqual([0, 0])
  })

  it("listening turns the ears on: one faint mint LED in the middle of each edge, mirror images of each other", () => {
    const l = rest("listening")
    expect(l.you).toHaveLength(2)
    const [a, b] = [...l.you].sort((p, q) => p[0] - q[0])
    expect([a![0], b![0]]).toEqual([0, 26])
    expect([a![1], b![1]]).toEqual([6, 6])
  })

  it("speaking lights the mouth amber, below the eyes, and the face's own mouth goes out", () => {
    const l = rest("speaking")
    expect(l.voice.length).toBeGreaterThan(4)
    expect(l.voice.every(([, row]) => row >= 8)).toBe(true) // the mouth is well below the middle (row 6)
    expect(l.ink.length).toBeGreaterThan(0)
    expect(l.ink.every(([, row]) => row < 9), "grey LEDs are only the eyes").toBe(true)
    expect(rest("idle").ink.some(([, row]) => row >= 9), "at rest the mouth is grey").toBe(true)
  })

  it("Mouth range scales how far the amber mouth opens", () => {
    const rows = (mouthRange: number) => new Set(rest("speaking", {}, { mouthRange }).voice.map(([, row]) => row)).size
    expect(rows(1.5)).toBeGreaterThan(rows(0.4))
  })

  it("thinking lights a '…' of three amber LEDs in the top corner on one side, and nothing amber elsewhere", () => {
    const l = rest("thinking")
    expect(l.voice).toHaveLength(3)
    const [cols, rowSet] = [l.voice.map(([c]) => c).sort((a, b) => a - b), new Set(l.voice.map(([, r]) => r))]
    expect(rowSet).toEqual(new Set([1]))
    expect(cols[1]! - cols[0]!).toBe(1)
    expect(cols[2]! - cols[1]!).toBe(1)
    expect([3, 21]).toContain(cols[0]!) // the left corner, or the right one
    // On the coarse grid, the top row.
    expect(new Set(rest("thinking", {}, { grid: "coarse" }).voice.map(([, r]) => r))).toEqual(new Set([0]))
    for (const m of ["idle", "listening", "hearing"] as const) expect(rest(m).voice, m).toHaveLength(0)
  })

  it("the eyes' height says the mode: closed to a line at rest, tall when it listens, narrowed while it thinks", () => {
    const height = (mode: Mode) => new Set(rest(mode).ink.filter(([, row]) => row < 9).map(([, row]) => row)).size
    expect(height("idle")).toBeLessThan(height("thinking"))
    expect(height("thinking")).toBeLessThan(height("listening"))
  })

  it("the face scales with the grid: the eyes stay at the same share of the panel's height", () => {
    const share = (grid: keyof typeof GRIDS) => {
      const rows = GRIDS[grid][1]
      const eyeRows = rest("listening", {}, { grid }).ink.filter(([, r]) => r < rows / 2 - 1).map(([, r]) => r)
      return (Math.max(...eyeRows) - Math.min(...eyeRows) + 1) / rows
    }
    expect(Math.abs(share("fine") - share("medium"))).toBeLessThan(0.12)
    expect(Math.abs(share("coarse") - share("medium"))).toBeLessThan(0.12)
  })
})

describe("dot matrix: the ear meters", () => {
  const ears = (v: Partial<VoiceFeatures>, stored: Stored = {}) => {
    const user = voice({ speaking: true, speechFor: 1, voicing: 0.8, ...v })
    return lit(last(matrix(stored).run("hearing", 120, { reduced: true, user }))).you
  }
  const LOUD = 0.9

  it("light only the edge columns while you speak: the outer ones, and the next ones in from them for a loud voice", () => {
    const soft = ears({ level: 0.3 })
    expect(soft.length).toBeGreaterThan(0)
    expect(soft.every(([c]) => c === 0 || c === 26)).toBe(true)
    const loud = ears({ level: LOUD })
    expect(loud.some(([c]) => c === 1 || c === 25)).toBe(true)
    expect(loud.every(([c]) => c <= 1 || c >= 25)).toBe(true)
  })

  it("the lit segment is as long as you are loud", () => {
    const length = (level: number) => ears({ level }).filter(([c]) => c === 0).length
    expect(length(LOUD)).toBeGreaterThan(length(0.5))
    expect(length(0.5)).toBeGreaterThan(length(0.15))
  })

  it("the lit segment sits at the height of your pitch: high for a high voice, low for a low one, both edges alike", () => {
    const centre = (pitch: number, edge: number) => {
      const rows = ears({ level: 0.5, pitch }).filter(([c]) => c === edge).map(([, r]) => r)
      return rows.reduce((a, b) => a + b, 0) / rows.length
    }
    expect(centre(0.95, 0)).toBeLessThan(centre(0.05, 0) - 3) // a smaller row is higher up
    expect(centre(0.95, 0)).toBeCloseTo(centre(0.95, 26), 6)
  })

  it("fall back to one dim LED per edge while you are silent, and go out while the assistant talks", () => {
    const silent = ears({ level: 0.8, speaking: false })
    expect(silent.map(([c]) => c).sort((a, b) => a - b)).toEqual([0, 26])
    const speaking = lit(last(matrix().run("speaking", 120, { reduced: true, user: voice({ speaking: true, level: 0.9 }), agent: voice({ speaking: true, level: 0.5 }) }))).you
    expect(speaking).toHaveLength(0)
  })
})

describe("dot matrix: glow", () => {
  const blurred = (d: Drive, mode: Mode = "listening") => matrix().run(mode, 20, d).some((calls) => fills(calls).some((f) => f.blur > 0))

  it("the brightest LEDs glow on a dark theme, with motion", () => {
    expect(blurred({ palette: PALETTES.dark })).toBe(true)
  })

  it("no glow on a light theme, under reduced motion, or when the LEDs are tiny", () => {
    expect(blurred({ palette: PALETTES.light })).toBe(false)
    expect(blurred({ reduced: true })).toBe(false)
    expect(blurred({ focus: { x: 0, y: 0, width: 200, height: 80 } })).toBe(false) // LEDs 5.5 px apart
  })
})
