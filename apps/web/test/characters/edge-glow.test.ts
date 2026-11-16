/**
 * What is particular to the edge glow (src/characters/library/edge-glow.ts), beyond the compatibility suite that
 * every character gets (manifest, modes, option extremes, reduced motion, the recorded digest, centred on the
 * focus): that the whole canvas is its frame whatever the focus, the three styles and the border line, the corner
 * roundness, the syllable pulses toggle, the lit-edges choices, and the corner chevrons that mark the direction
 * under reduced motion (in for you, out for the assistant).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Character, Focus, Mode, OptionValues } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import { Runner } from "@/characters/runner.ts"
import { CONVERSATION_SECONDS, pinned, run, type RunResult } from "./support/conversation.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

/** A freshly evaluated module per call, so every run starts from the same state. */
const fresh = async (): Promise<Character> => {
  vi.resetModules()
  return (await import("@/characters/library/edge-glow.ts")).default
}

const go = async (o: { mode?: Mode; stored?: OptionValues; size?: readonly [number, number, number]; focus?: Focus; seconds?: number }): Promise<RunResult> =>
  run(await fresh(), {
    script: pinned(o.mode ?? "speaking"),
    seconds: o.seconds ?? 4,
    palette: PALETTES.dark,
    ...(o.stored !== undefined ? { stored: o.stored } : {}),
    ...(o.size !== undefined ? { size: o.size } : {}),
    ...(o.focus !== undefined ? { focus: o.focus } : {})
  })

type Call = { readonly name: string; readonly args: ReadonlyArray<unknown> }

/** The calls of the last of 60 still (reduced motion, silent) frames in `mode`: long enough for every option to have settled. */
const stillFrame = async (mode: Mode, stored: OptionValues = {}): Promise<ReadonlyArray<Call>> => {
  const r = new Runner(await fresh(), document.createElement("canvas"), stored)
  r.create()
  r.resize(720, 240, 1)
  const quiet = createVoiceFeatures()
  let last: ReadonlyArray<Call> = []
  for (let i = 0; i < 60; i++) {
    recording.log = []
    r.step({ mode, dt: 1 / 60, user: quiet, agent: quiet, palette: PALETTES.dark, reducedMotion: true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity })
    last = recording.log
  }
  recording.log = null
  r.dispose()
  return last
}
const count = (calls: ReadonlyArray<Call>, name: string) => calls.filter((c) => c.name === name).length

beforeEach(() => {
  recording.log = null
})

describe("edge glow: the whole canvas is its frame", () => {
  it("draws the same whatever box the page puts it in", async () => {
    const size: readonly [number, number, number] = [1280, 800, 1]
    const whole = await go({ size, seconds: CONVERSATION_SECONDS })
    const boxed = await go({ size, focus: { x: 280, y: 200, width: 720, height: 240 }, seconds: CONVERSATION_SECONDS })
    expect(boxed.last).toBe(whole.last)
    expect(boxed.calls).toBe(whole.calls)
  })
})

describe("edge glow: styles and the border line", () => {
  it("soft, crisp and line-only each draw their own light", async () => {
    const last = async (style: string) => (await go({ mode: "hearing", stored: { style }, seconds: 3 })).last
    expect(new Set([await last("soft"), await last("crisp"), await last("line")]).size).toBe(3)
  })

  it("crisp drops the deep layer and line-only drops both: fewer gradients are built", async () => {
    const gradients = async (style: string) => count(await stillFrame("hearing", { style }), "createConicGradient")
    const [soft, crisp, line] = [await gradients("soft"), await gradients("crisp"), await gradients("line")]
    expect(soft).toBeGreaterThan(crisp)
    expect(crisp).toBeGreaterThan(line)
    expect(line).toBe(1) // the border line's own
  })

  it("a border line of 0 hides the line, except in the line-only style, which always keeps one to draw with", async () => {
    const strokes = async (stored: OptionValues) => count(await stillFrame("idle", stored), "stroke")
    const shown = await strokes({})
    expect(shown).toBe(2) // the solid floor, then the gradient on top
    expect(await strokes({ line: 0 })).toBe(0)
    expect(await strokes({ line: 0, style: "line" })).toBe(2)
  })
})

describe("edge glow: corner roundness", () => {
  /** The corner radius of the border line (the last rounded rectangle of an idle frame). */
  const radius = async (corners: number): Promise<number> => {
    const rects = (await stillFrame("idle", { corners })).filter((c) => c.name === "roundRect")
    return rects[rects.length - 1]!.args[4] as number
  }

  it("is square at 0 and rounder as it goes up", async () => {
    const [square, normal, round] = [await radius(0), await radius(1), await radius(3)]
    expect(square).toBe(0)
    expect(normal).toBeGreaterThan(0)
    expect(round).toBeGreaterThan(normal)
  })

  it("never rounds past half the short side", async () => {
    expect(await radius(3)).toBeLessThanOrEqual(240 / 2)
  })
})

describe("edge glow: syllable pulses", () => {
  const calls = async (mode: Mode, pulses: boolean) => (await go({ mode, stored: { pulses }, seconds: 5 })).calls

  it("runs a ring of light on the syllables, in while you speak and out while the assistant does", async () => {
    expect(await calls("hearing", false)).toBeLessThan(await calls("hearing", true))
    expect(await calls("speaking", false)).toBeLessThan(await calls("speaking", true))
  })

  it("has none to draw while idle, so the toggle changes nothing there", async () => {
    expect(await calls("idle", false)).toBe(await calls("idle", true))
  })
})

describe("edge glow: lit edges", () => {
  it("all round, bottom, sides and top-and-bottom each light the frame differently", async () => {
    const last = async (edges: string) => (await go({ mode: "hearing", stored: { edges }, seconds: 3 })).last
    const drawn = [await last("all"), await last("bottom"), await last("sides"), await last("topBottom")]
    expect(new Set(drawn).size).toBe(4)
  })
})

describe("edge glow: direction marks under reduced motion", () => {
  /** The three points (tip, corner, tip) of the first chevron. */
  const firstChevron = (calls: ReadonlyArray<Call>) => {
    const lines = calls.findIndex((c) => c.name === "lineTo")
    return { from: calls[lines - 1]!.args as [number, number], corner: calls[lines]!.args as [number, number] }
  }

  it("draws four corner chevrons while it listens, hears or speaks, and none while idle or thinking", async () => {
    for (const mode of ["listening", "hearing", "speaking"] as const) expect(count(await stillFrame(mode), "lineTo"), mode).toBe(8)
    for (const mode of ["idle", "thinking"] as const) expect(count(await stillFrame(mode), "lineTo"), mode).toBe(0)
  })

  it("points in for you and out for the assistant", async () => {
    for (const mode of ["listening", "hearing"] as const) {
      const c = firstChevron(await stillFrame(mode))
      expect(c.from[0], `${mode} points in`).toBeGreaterThan(c.corner[0]) // the top-left chevron opens toward the middle
    }
    const c = firstChevron(await stillFrame("speaking"))
    expect(c.from[0], "speaking points out").toBeLessThan(c.corner[0])
  })
})

describe("edge glow: tiny canvases", () => {
  it("never asks for a negative corner radius, even when a syllable starts on a 1 × 1 canvas, and draws nothing on a 0 × 0 one", async () => {
    for (const size of [[1, 1], [0, 0], [3, 2]] as const) {
      const r = new Runner(await fresh(), document.createElement("canvas"), {})
      r.create()
      r.resize(size[0], size[1], 1)
      const voice = createVoiceFeatures()
      voice.onset = 1
      voice.speaking = true
      recording.log = []
      r.step({ mode: "hearing", dt: 0, user: voice, agent: createVoiceFeatures(), palette: PALETTES.dark, reducedMotion: false, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity })
      const rects = recording.log.filter((c) => c.name === "roundRect")
      recording.log = null
      r.dispose()
      for (const c of rects) expect(c.args[4] as number, `${size.join("×")}`).toBeGreaterThanOrEqual(0)
      if (size[0] === 0) expect(rects.length).toBe(0)
    }
  })
})

describe("edge glow: reduced motion switched on mid-animation", () => {
  it("clears the pulses already in flight instead of freezing or moving them", async () => {
    for (const mode of ["hearing", "speaking"] as const) {
      const r = new Runner(await fresh(), document.createElement("canvas"), {})
      r.create()
      r.resize(720, 240, 1)
      const voice = createVoiceFeatures()
      const step = (onset: number, reducedMotion: boolean): number => {
        voice.onset = onset
        voice.speaking = true
        voice.level = 0.6
        recording.log = []
        r.step({ mode, dt: 1 / 60, user: voice, agent: voice, palette: PALETTES.dark, reducedMotion, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity })
        const n = recording.log.filter((c) => c.name === "roundRect").length
        recording.log = null
        return n
      }
      for (let i = 0; i < 5; i++) step(0, false)
      step(1, false) // a syllable starts a pulse
      const moving = step(0, false)
      expect(moving, `${mode}: a pulse is drawn`).toBeGreaterThan(2) // the clip and the border line are two
      expect(step(0, true), `${mode}: reduced motion draws no pulse`).toBe(2)
      expect(step(0, true), `${mode}: and none comes back`).toBe(2)
      r.dispose()
    }
  })
})
