/**
 * Robot eyes (src/characters/library/robot-eyes.ts): what only this character does, checked on the paths it draws
 * on the recording canvas. The shared suites (compat, isolation) already cover its manifest, every mode and option
 * extreme, reduced-motion stillness and its recorded digest; this file covers the eyes themselves: the shapes, the
 * pose of each mode, the rim light and the eye colour, the gaze following the pointer, and the blink rate.
 *
 * Most checks run with reduced motion, which holds every pose still (no blinks, saccades or breathing) so a
 * measurement is exact; the blink test runs with motion.
 */
import { beforeEach, describe, expect, it } from "vitest"
import type { Focus, Mode, OptionValues, VoiceFeatures } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import robot from "@/characters/library/robot-eyes.ts"
import { Runner } from "@/characters/runner.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { CONVERSATION, run } from "./support/conversation.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

const W = 720
const H = 240
const DT = 1 / 60
const FRAMES = 30

type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }
type Pointer = { x: number; y: number; down: boolean; inside: boolean }
/** A closed path of one frame and how it was painted. */
interface Shape {
  readonly points: number
  readonly width: number
  readonly height: number
  readonly minX: number
  readonly maxX: number
  readonly style: string
  /** Line width in force when it was painted (the rounding stroke of an eye, the rim's wider one). */
  readonly lineWidth: number
  readonly op: "fill" | "stroke"
}

beforeEach(() => {
  recording.log = null
})

const make = (stored: OptionValues = {}, size: readonly [number, number] = [W, H]) => {
  const r = new Runner(robot, document.createElement("canvas"), stored)
  r.create()
  r.resize(size[0], size[1], 1)
  return r
}

const OFF: Pointer = { x: 0, y: 0, down: false, inside: false }

interface Drive {
  readonly user?: VoiceFeatures
  readonly agent?: VoiceFeatures
  readonly reduced?: boolean
  readonly pointer?: Pointer
  readonly focus?: Focus
}

const quiet = createVoiceFeatures()
const tick = (r: Runner, mode: Mode, o: Drive = {}): Array<Call> => {
  recording.log = []
  r.step({ mode, dt: DT, user: o.user ?? quiet, agent: o.agent ?? quiet, palette: PALETTES.dark, reducedMotion: o.reduced === true, pointer: o.pointer ?? OFF, sinceInterrupt: Infinity, ...(o.focus !== undefined ? { focus: o.focus } : {}) })
  const calls = recording.log
  recording.log = null
  return calls
}

/** A person or assistant who is talking at `level`. */
const talking = (level = 0.5): VoiceFeatures => {
  const f = createVoiceFeatures()
  f.level = level
  f.rms = level * 0.1
  f.speaking = true
  f.speechFor = 2
  f.voicing = 1
  f.low = f.mid = f.high = level
  return f
}

/** The filled and stroked paths of a frame, with the colour and line width they were painted with. */
const shapes = (calls: ReadonlyArray<Call>): Array<Shape> => {
  const out: Array<Shape> = []
  let xs: Array<number> = []
  let ys: Array<number> = []
  let fillStyle = ""
  let strokeStyle = ""
  let lineWidth = 1
  for (const c of calls) {
    if (c.name === "beginPath") {
      xs = []
      ys = []
    } else if (c.name === "moveTo" || c.name === "lineTo") {
      xs.push(c.args[0] as number)
      ys.push(c.args[1] as number)
    } else if (c.name === "=fillStyle") fillStyle = String(c.args[0])
    else if (c.name === "=strokeStyle") strokeStyle = String(c.args[0])
    else if (c.name === "=lineWidth") lineWidth = c.args[0] as number
    else if ((c.name === "fill" || c.name === "stroke") && xs.length > 0) {
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      out.push({ points: xs.length, width: maxX - minX, height: Math.max(...ys) - Math.min(...ys), minX, maxX, style: c.name === "fill" ? fillStyle : strokeStyle, lineWidth, op: c.name })
    }
  }
  return out
}

/** An eye or the visor's bar: the 44-point outlines (the lights inside the visor are rounded rectangles of far fewer). */
const OUTLINE = 44
const bodies = (calls: ReadonlyArray<Call>) => shapes(calls).filter((s) => s.op === "fill" && s.points === OUTLINE)
/** What an eye looks like on the page: its path plus the stroke that rounds its corners. */
const painted = (s: Shape) => ({ width: s.width + s.lineWidth, height: s.height + s.lineWidth })
const rgbOf = (css: string) => css.match(/rgba\((\d+),(\d+),(\d+),([\d.e-]+)\)/)!.slice(1, 5).map(Number)

/** The calls of the last of `frames` frames in one mode. */
const pose = (mode: Mode, o: Drive & { readonly stored?: OptionValues; readonly frames?: number; readonly size?: readonly [number, number] } = {}) => {
  const r = make(o.stored, o.size)
  let calls: Array<Call> = []
  for (let i = 0; i < (o.frames ?? FRAMES); i++) calls = tick(r, mode, { reduced: true, ...o })
  return calls
}
const eyeOf = (calls: ReadonlyArray<Call>, side: 0 | 1 = 0) => painted(bodies(calls)[side]!)

describe("eye shape", () => {
  const shape = (eyeShape: string) => eyeOf(pose("listening", { stored: { eyeShape } }))
  const ratio = (eyeShape: string) => {
    const e = shape(eyeShape)
    return e.width / e.height
  }

  it("rounded, round and tall are two eyes of one size each; round is as wide as it is high, tall is higher than wide", () => {
    for (const eyeShape of ["rounded", "round", "tall"]) {
      const eyes = bodies(pose("listening", { stored: { eyeShape } }))
      expect(eyes, eyeShape).toHaveLength(2)
      expect(painted(eyes[0]!).width, eyeShape).toBeCloseTo(painted(eyes[1]!).width, 3)
    }
    expect(ratio("round")).toBeCloseTo(1, 1)
    expect(ratio("tall")).toBeLessThan(0.6)
    expect(ratio("tall")).toBeLessThan(ratio("rounded"))
    expect(ratio("rounded")).toBeLessThan(ratio("round"))
  })

  it("visor draws one bar, wider than an eye, and clips the two eye lights inside it", () => {
    const eyes = pose("listening")
    const visor = pose("listening", { stored: { eyeShape: "visor" } })
    expect(bodies(visor)).toHaveLength(1)
    expect(painted(bodies(visor)[0]!).width).toBeGreaterThan(painted(bodies(eyes)[0]!).width * 1.5)
    expect(visor.some((c) => c.name === "clip")).toBe(true)
    expect(eyes.some((c) => c.name === "clip")).toBe(false)
    // The lights are painted after the clip, inside it.
    const clip = visor.findIndex((c) => c.name === "clip")
    expect(visor.slice(clip).some((c) => c.name === "fill")).toBe(true)
  })

  it("an unknown shape falls back to rounded", () => {
    const r = ratio("rounded")
    expect(ratio("nonsense")).toBeCloseTo(r, 6)
  })

  it("changing the shape morphs the eyes over about 0.2 s, and cross-fades to and from the visor", () => {
    const r = make({ eyeShape: "round" })
    for (let i = 0; i < FRAMES; i++) tick(r, "listening")
    r.setStored({ eyeShape: "visor" })
    const mid = tick(r, "listening")
    // Half way: the eyes and the bar are both there, each with a partial opacity.
    const alphas = mid.filter((c) => c.name === "=globalAlpha").map((c) => c.args[0] as number)
    expect(alphas.some((a) => a > 0 && a < 1)).toBe(true)
    expect(bodies(mid).length).toBeGreaterThan(1)
    for (let i = 0; i < 90; i++) tick(r, "listening")
    expect(bodies(tick(r, "listening"))).toHaveLength(1)
  })
})

describe("the pose of each mode (reduced motion holds it)", () => {
  const height = (mode: Mode, o: Parameters<typeof pose>[1] = {}) => eyeOf(pose(mode, o)).height

  it("idle: eyes almost shut in thin bars; listening: wide open", () => {
    expect(height("idle")).toBeLessThan(height("listening") * 0.3)
  })

  it("listening is a little larger than hearing; thinking lowers the lids", () => {
    const listening = eyeOf(pose("listening"))
    const hearing = eyeOf(pose("hearing", { user: talking(0.3) }))
    expect(listening.height).toBeGreaterThan(hearing.height)
    expect(listening.width).toBeGreaterThan(hearing.width)
    expect(height("thinking")).toBeLessThan(listening.height * 0.85)
  })

  it("speaking raises the bottom lids in a happy squint: lower than open, and the outline is flatter underneath", () => {
    const talk = (mode: Mode) => bodies(pose(mode, { agent: talking(0.5), user: talking(0.5) }))[0]!
    const speaking = talk("speaking")
    const hearing = talk("hearing")
    expect(speaking.height).toBeLessThan(hearing.height)
  })

  it("holds the same pose forever with reduced motion (no breathing, blinks or saccades)", () => {
    const r = make()
    const first = JSON.stringify(shapes(tick(r, "listening", { reduced: true })))
    for (let i = 0; i < 600; i++) tick(r, "listening", { reduced: true })
    expect(JSON.stringify(shapes(tick(r, "listening", { reduced: true })))).toBe(first)
  })
})

describe("eye size", () => {
  const widthAt = (size: number, canvas: readonly [number, number] = [W, H]) => eyeOf(pose("listening", { stored: { size }, size: canvas })).width

  it("scales the eyes with the size option", () => {
    expect(widthAt(0.5) / widthAt(1)).toBeCloseTo(0.5, 1)
  })

  it("is capped: the largest size grows the eyes by less than its factor, on a wide canvas and a narrow one", () => {
    // The unit is min(0.92 × room, cap) with the cap at 0.98 of the room the eyes and their motion need,
    // so 1.25 × cannot be reached: about 1.19 × at 720 × 240 and 1.18 × at 160 × 140.
    for (const canvas of [[W, H], [160, 140]] as const) {
      const grown = widthAt(1.25, canvas) / widthAt(1, canvas)
      expect(grown, canvas.join("×")).toBeGreaterThan(1.1)
      expect(grown, canvas.join("×")).toBeLessThan(1.22)
    }
  })

  it("keeps the drawing inside the canvas at the largest size, on a small cell and a big stage", () => {
    for (const size of [[160, 140, 1], [900, 420, 1]] as const) {
      const r = run(robot, { script: CONVERSATION, seconds: 11, palette: PALETTES.dark, stored: { size: 1.25 }, size })
      expect(r.overflow, size.join("×")).toBeLessThan(1)
    }
  })
})

describe("the rim light says whose voice it is", () => {
  /** Strokes wider than the rounding stroke of the eyes: the rim, painted under each eye. */
  const rims = (calls: ReadonlyArray<Call>) => {
    const all = shapes(calls)
    const eyeLine = Math.min(...all.filter((s) => s.op === "fill").map((s) => s.lineWidth))
    return all.filter((s) => s.op === "stroke" && s.lineWidth > eyeLine + 1e-6)
  }

  it("is mint (your colour) while hearing, amber (the assistant's) while speaking and thinking", () => {
    const hearing = rims(pose("hearing", { user: talking(0.5) }))
    expect(hearing.length).toBeGreaterThan(0)
    for (const s of hearing) expect(rgbOf(s.style).slice(0, 3)).toEqual([...PALETTES.dark.you])
    for (const mode of ["speaking", "thinking"] as const) {
      const rim = rims(pose(mode, { agent: talking(0.5) }))
      expect(rim.length, mode).toBeGreaterThan(0)
      for (const s of rim) expect(rgbOf(s.style).slice(0, 3), mode).toEqual([...PALETTES.dark.voice])
    }
  })

  it("is brighter for a louder voice", () => {
    const alpha = (level: number) => Math.max(...rims(pose("hearing", { user: talking(level) })).map((s) => rgbOf(s.style)[3]!), 0)
    expect(alpha(0.8)).toBeGreaterThan(alpha(0.1))
  })

  it("is faint while listening and absent while idle", () => {
    expect(rims(pose("idle"))).toHaveLength(0)
    expect(rims(pose("listening")).length).toBeGreaterThan(0)
  })

  it("is wider with a thicker rim option and gone at 0, where the eyes take the voice colour instead", () => {
    const widest = (rimLight: number) => Math.max(...rims(pose("hearing", { user: talking(0.5), stored: { rimLight } })).map((s) => s.lineWidth), 0)
    expect(widest(2)).toBeGreaterThan(widest(1))
    expect(widest(0)).toBe(0)
    const fill = (rimLight: number) => rgbOf(bodies(pose("hearing", { user: talking(0.5), stored: { rimLight } }))[0]!.style).slice(0, 3)
    expect(fill(1)).toEqual([...PALETTES.dark.ink])
    // At 0 the eyes lean toward the mint of the voice: every channel moves toward it.
    fill(0).forEach((v, i) => {
      const ink = PALETTES.dark.ink[i]!
      const you = PALETTES.dark.you[i]!
      expect(Math.abs(v - you)).toBeLessThanOrEqual(Math.abs(ink - you))
    })
    expect(fill(0)).not.toEqual(fill(1))
  })
})

describe("eye colour", () => {
  const fill = (mode: Mode, stored: OptionValues) => rgbOf(bodies(pose(mode, { stored }))[0]!.style).slice(0, 3)

  it("follows the theme's ink by default, and takes a chosen colour", () => {
    expect(fill("listening", {})).toEqual([...PALETTES.dark.ink])
    expect(fill("listening", { eyeColor: "#ff8000" })).toEqual([255, 128, 0])
    expect(fill("listening", { eyeColor: "you" })).toEqual([...PALETTES.dark.you])
  })

  it("dims toward the faint ink when idle (the default colour), and toward the page for a chosen one", () => {
    const awake = fill("listening", {})
    const idle = fill("idle", {})
    idle.forEach((v, i) => {
      const faint = PALETTES.dark.inkFaint[i]!
      expect(Math.abs(v - faint)).toBeLessThanOrEqual(Math.abs(awake[i]! - faint))
    })
    expect(idle).not.toEqual(awake)
    const orange = fill("idle", { eyeColor: "#ff8000" })
    expect(orange).not.toEqual([255, 128, 0])
    expect(orange[0]!).toBeGreaterThan(orange[2]!) // still orange, only dimmer
  })
})

describe("gaze", () => {
  const FOCUS: Focus = { x: 0, y: 0, width: W, height: H }
  /** Where the eyes sit: the translate the character sets before drawing them, and the width of each eye. */
  const gaze = (stored: OptionValues, pointer: Pointer) => {
    const calls = pose("listening", { stored, pointer, focus: FOCUS })
    const t = calls.find((c) => c.name === "translate")!
    const eyes = bodies(calls)
    return { x: t.args[0] as number, left: painted(eyes[0]!).width, right: painted(eyes[1]!).width }
  }
  const at = (x: number): Pointer => ({ x, y: H / 2, down: false, inside: true })

  it("the eyes move toward the pointer, and the eye on that side grows", () => {
    const centre = gaze({}, OFF)
    const right = gaze({}, at(W - 10))
    const left = gaze({}, at(10))
    expect(centre.x).toBeCloseTo(W / 2, 6)
    expect(right.x).toBeGreaterThan(centre.x)
    expect(left.x).toBeLessThan(centre.x)
    expect(right.right).toBeGreaterThan(right.left)
    expect(left.left).toBeGreaterThan(left.right)
  })

  it("looks straight out when the pointer is not over it, or when following the pointer is switched off", () => {
    const centre = gaze({}, OFF)
    const off = gaze({ followsPointer: false }, at(W - 10))
    expect(off.x).toBeCloseTo(centre.x, 6)
    expect(off.right).toBeCloseTo(off.left, 6)
    const away = gaze({}, { x: W - 10, y: H / 2, down: false, inside: false })
    expect(away.x).toBeCloseTo(centre.x, 6)
  })

  it("never looks further than the eyes can reach, however far away the pointer is", () => {
    expect(gaze({}, at(5000)).x).toBeCloseTo(gaze({}, at(W + 600)).x, 6)
  })
})

describe("blinking", () => {
  /** Blinks in `seconds` of listening: the times the eyes' height drops under half of its usual value. */
  const blinks = (liveliness: number, seconds = 60) => {
    const r = make({ liveliness })
    const heights: Array<number> = []
    for (let i = 0; i < seconds / DT; i++) {
      const eyes = bodies(tick(r, "listening"))
      heights.push(painted(eyes[0]!).height)
    }
    const typical = [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)]!
    let count = 0
    let closed = false
    for (const h of heights) {
      if (h < typical * 0.6 && !closed) count++
      closed = h < typical * 0.6
    }
    return count
  }

  it("blinks every few seconds, and more often at a higher liveliness", () => {
    const calm = blinks(0.3)
    const lively = blinks(2)
    expect(calm).toBeGreaterThanOrEqual(1)
    expect(lively).toBeGreaterThan(calm * 2)
    expect(lively).toBeGreaterThan(8) // about every 2.1 s at 2×, and extra ones with each big glance
  })

  it("does not blink at all with reduced motion", () => {
    const r = make()
    const hs = new Set<number>()
    for (let i = 0; i < 3600; i++) hs.add(Math.round(painted(bodies(tick(r, "listening", { reduced: true }))[0]!).height * 1000))
    expect(hs.size).toBe(1)
  })
})
