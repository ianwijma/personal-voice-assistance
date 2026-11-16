/**
 * What is particular to the flame (src/characters/library/flame.ts), beyond the compatibility suite that every
 * character gets (manifest, modes, option extremes, reduced motion, the recorded digest): the three styles, the
 * sparks and air toggles, the flame tint (only while the assistant burns), the promise that the flame never
 * leaves the top of the canvas even with the options stacked, and the pointer drawing it in or blowing it away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Character, Focus, Mode, OptionValues } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import { Runner } from "@/characters/runner.ts"
import { pinned, run, type RunResult } from "./support/conversation.ts"
import { installFakeCanvas, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

/** A freshly evaluated module per call, so every run starts from the same state. */
const fresh = async (): Promise<Character> => {
  vi.resetModules()
  return (await import("@/characters/library/flame.ts")).default
}

const go = async (o: { mode?: Mode; stored?: OptionValues; size?: readonly [number, number, number]; focus?: Focus; seconds?: number; still?: boolean; palette?: "dark" | "light" }): Promise<RunResult> =>
  run(await fresh(), {
    script: pinned(o.mode ?? "speaking"),
    seconds: o.seconds ?? 3,
    palette: PALETTES[o.palette ?? "dark"],
    ...(o.stored !== undefined ? { stored: o.stored } : {}),
    ...(o.size !== undefined ? { size: o.size } : {}),
    ...(o.focus !== undefined ? { focus: o.focus } : {}),
    ...(o.still === true ? { silent: true, reducedMotion: true } : {})
  })

const spanOf = (r: RunResult) => {
  expect(r.extent, "draws something solid").not.toBeNull()
  const e = r.extent!
  return { w: e.maxX - e.minX, h: e.maxY - e.minY }
}

/** One frame in a still pose with the calls recorded, for counting what was drawn. */
const stillCalls = async (mode: Mode, stored: OptionValues) => {
  const r = new Runner(await fresh(), document.createElement("canvas"), stored)
  r.create()
  r.resize(720, 240, 1)
  const quiet = createVoiceFeatures()
  recording.log = []
  r.step({ mode, dt: 1 / 60, user: quiet, agent: quiet, palette: PALETTES.dark, reducedMotion: true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity })
  const log = recording.log
  recording.log = null
  r.dispose()
  const count = (name: string) => log.filter((c) => c.name === name).length
  return { arcs: count("arc"), strokes: count("stroke") }
}

beforeEach(() => {
  recording.log = null
})

describe("flame: styles", () => {
  it("candle, torch and lantern each draw their own flame", async () => {
    const last = async (style: string) => (await go({ mode: "listening", stored: { style }, still: true, seconds: 2 })).last
    expect(new Set([await last("candle"), await last("torch"), await last("lantern")]).size).toBe(3)
  })

  it("a torch burns wider than a candle", async () => {
    const width = async (style: string) => spanOf(await go({ mode: "speaking", stored: { style, sparks: false, air: false }, still: true, seconds: 2 })).w
    expect(await width("torch")).toBeGreaterThan(await width("candle"))
  })

  it("only the lantern draws a glass globe: one extra stroke over the candle in the same pose", async () => {
    const candle = await stillCalls("listening", { style: "candle" })
    const lantern = await stillCalls("listening", { style: "lantern" })
    expect(lantern.strokes - candle.strokes).toBe(3) // the glass, its collar, its reflection
  })
})

describe("flame: sparks and air", () => {
  it("shows fixed sparks above the tip in held poses while speaking, none when sparks are off", async () => {
    expect((await stillCalls("speaking", { sparks: true })).arcs).toBe(5)
    expect((await stillCalls("speaking", { sparks: false })).arcs).toBe(0)
  })

  it("shows fixed air dashes pointing in while listening, none when air is off", async () => {
    const on = await stillCalls("listening", { air: true })
    const off = await stillCalls("listening", { air: false })
    expect(on.strokes - off.strokes).toBe(4)
  })

  it("moving motes: sparks off draws fewer shapes than on while it speaks", async () => {
    const calls = async (sparks: boolean) => (await go({ mode: "speaking", stored: { sparks }, seconds: 4 })).calls
    expect(await calls(false)).toBeLessThan(await calls(true))
  })
})

describe("flame: tint", () => {
  const last = async (mode: Mode, tint: string, palette: "dark" | "light" = "dark") => (await go({ mode, stored: { tint }, still: true, seconds: 2, palette })).last

  it("colours the outer flame only while the assistant burns (thinking, speaking)", async () => {
    for (const mode of ["thinking", "speaking"] as const) expect(await last(mode, "#22cc44"), mode).not.toBe(await last(mode, "#c84628"))
    for (const mode of ["idle", "listening", "hearing"] as const) expect(await last(mode, "#22cc44"), mode).toBe(await last(mode, "#c84628"))
  })

  it("keeps the theme's own flame colour at the default tint, on both themes, and a chosen tint differs from it", async () => {
    for (const palette of ["dark", "light"] as const) expect(await last("speaking", "#00aa88", palette), palette).not.toBe(await last("speaking", "#c84628", palette))
  })
})

describe("flame: size", () => {
  it("the smallest size draws a clearly smaller flame than the default", async () => {
    const stored = (size: number) => ({ size, sparks: false, air: false })
    const small = spanOf(await go({ mode: "speaking", stored: stored(0.5), still: true, seconds: 2 }))
    const full = spanOf(await go({ mode: "speaking", stored: stored(1), still: true, seconds: 2 }))
    expect(small.h).toBeLessThan(full.h * 0.75)
  })
})

describe("flame: stays on the canvas", () => {
  // The flame (tongues included) never rises past the top of the canvas, even where the box sits near the top and the options are stacked.
  for (const style of ["candle", "torch", "lantern"]) {
    it(`${style} with the widest, most flickering, most flaring settings stays below the top edge`, async () => {
      const size: readonly [number, number, number] = [1280, 800, 1]
      const focus: Focus = { x: 280, y: 40, width: 720, height: 240 }
      const r = await go({ mode: "speaking", stored: { style, width: 1.8, flicker: 2, flare: 2, sparks: false, air: false }, size, focus, seconds: 6 })
      expect(r.extent!.minY).toBeGreaterThanOrEqual(0)
    })
  }
})

describe("flame: scrolled partly off the canvas", () => {
  it("a box scrolled above the canvas gives a flat flame in reduced motion, never one drawn downward from the wick", async () => {
    const r = new Runner(await fresh(), document.createElement("canvas"), { sparks: false, air: false })
    r.create()
    r.resize(1280, 800, 1)
    const quiet = createVoiceFeatures()
    recording.log = []
    r.step({ mode: "listening", dt: 1 / 60, user: quiet, agent: quiet, palette: PALETTES.dark, reducedMotion: true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity, focus: { x: 280, y: -200, width: 720, height: 240 } })
    const ys = recording.log.filter((c) => c.name === "lineTo").map((c) => (c.args as [number, number])[1])
    recording.log = null
    r.dispose()
    expect(ys.length).toBeGreaterThan(0)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6)
  })
})

describe("flame: reduced motion switched on mid-animation", () => {
  it("clears the licks and sparks already in flight and draws only the fixed pose", async () => {
    const r = new Runner(await fresh(), document.createElement("canvas"), { air: false })
    r.create()
    r.resize(720, 240, 1)
    const quiet = createVoiceFeatures()
    const loud = createVoiceFeatures()
    const step = (reducedMotion: boolean, onset: number) => {
      loud.level = 0.8
      loud.onset = onset
      recording.log = []
      r.step({ mode: "speaking", dt: 1 / 60, user: quiet, agent: loud, palette: PALETTES.dark, reducedMotion, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity })
      const log = recording.log
      recording.log = null
      return { lines: log.filter((c) => c.name === "lineTo").length, arcs: log.filter((c) => c.name === "arc").length }
    }
    step(false, 0)
    const live = step(false, 0.9) // the loud onset throws a lick
    for (let i = 0; i < 5; i++) step(false, 0.9)
    expect(live.lines, "a lick is on screen before").toBeGreaterThan(3 * 55)
    const calm = step(true, 0.9)
    r.dispose()
    expect(calm.lines).toBe(3 * 55) // the three flame layers only, no lick
    expect(calm.arcs).toBe(5) // the fixed sparks only, none in flight
  })
})

describe("flame: pointer", () => {
  /**
   * Where the tip of the flame (the first point of its outer outline, the highest one) is, across the box, after a
   * second of listening with the pointer at `px` (inside the box) and pressed or not; null: no pointer.
   */
  const centre = async (pointer: { px: number; down: boolean } | null): Promise<number> => {
    const r = new Runner(await fresh(), document.createElement("canvas"), { sparks: false, air: false, flicker: 0.2 })
    r.create()
    r.resize(720, 240, 1)
    const quiet = createVoiceFeatures()
    let tip = 0
    for (let i = 0; i < 60; i++) {
      recording.log = []
      r.step({
        mode: "listening",
        dt: 1 / 60,
        user: quiet,
        agent: quiet,
        palette: PALETTES.dark,
        reducedMotion: false,
        pointer: pointer === null ? { x: 0, y: 0, down: false, inside: false } : { x: pointer.px, y: 120, down: pointer.down, inside: true },
        sinceInterrupt: Infinity
      })
      const at = recording.log.findIndex((c) => c.name === "lineTo") // the wick is a curve, so the first line starts the outer outline
      const outline = recording.log.slice(at - 1, at + 55).map((c) => c.args as [number, number])
      tip = outline.reduce((best, p) => (p[1] < best[1] ? p : best))[0]
    }
    recording.log = null
    r.dispose()
    return tip
  }

  it("a hovering pointer draws the flame toward it", async () => {
    const none = await centre(null)
    expect(await centre({ px: 660, down: false })).toBeGreaterThan(none)
    expect(await centre({ px: 60, down: false })).toBeLessThan(none)
  })

  it("a pressed pointer next to the flame blows it away from the finger", async () => {
    const none = await centre(null)
    expect(await centre({ px: 400, down: true })).toBeLessThan(none) // finger on the right: blown left
    expect(await centre({ px: 320, down: true })).toBeGreaterThan(none) // finger on the left: blown right
  })
})
