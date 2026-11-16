/**
 * What is particular to the blob buddy (src/characters/library/blob-buddy.ts), beyond the compatibility suite that
 * every character gets (manifest, modes, option extremes, reduced motion, the recorded digest): its three body
 * shapes, the contrast of its features on a chosen body colour, its size option, the promise that a hop never
 * lifts the antenna out of the frame, its idle sag, and its eyes following the pointer only when asked to.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Character, Mode, OptionValues } from "@/characters/contract.ts"
import { createVoiceFeatures } from "@/characters/features.ts"
import { Runner } from "@/characters/runner.ts"
import { pinned, run, type RunResult } from "./support/conversation.ts"
import { installFakeCanvas, markStage, recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"

installFakeCanvas()

/** A freshly evaluated module per call: each instance draws its seed from a per-page counter, so two runs only match from the same start. */
const fresh = async (): Promise<Character> => {
  vi.resetModules()
  return (await import("@/characters/library/blob-buddy.ts")).default
}

const go = async (o: { mode?: Mode; stored?: OptionValues; size?: readonly [number, number, number]; seconds?: number; still?: boolean }): Promise<RunResult> =>
  run(await fresh(), {
    script: pinned(o.mode ?? "speaking"),
    seconds: o.seconds ?? 4,
    palette: PALETTES.dark,
    ...(o.stored !== undefined ? { stored: o.stored } : {}),
    ...(o.size !== undefined ? { size: o.size } : {}),
    ...(o.still === true ? { silent: true, reducedMotion: true } : {})
  })

/** The union of solid drawing; the character always draws something solid, so null is a failure. */
const extentOf = (r: RunResult) => {
  expect(r.extent, "draws something solid").not.toBeNull()
  return r.extent!
}
const spanOf = (r: RunResult) => {
  const e = extentOf(r)
  return { w: e.maxX - e.minX, h: e.maxY - e.minY }
}

beforeEach(() => {
  recording.log = null
})

describe("blob buddy: body shape", () => {
  it("draws its own silhouette for each shape", async () => {
    const last = async (bodyShape: string) => (await go({ mode: "listening", stored: { bodyShape }, still: true, seconds: 2 })).last
    const drawn = [await last("gumdrop"), await last("round"), await last("tall")]
    expect(new Set(drawn).size).toBe(3)
  })

  it("a tall body is narrower than a round one", async () => {
    const width = async (bodyShape: string) => spanOf(await go({ mode: "listening", stored: { bodyShape }, still: true, seconds: 2 })).w
    expect(await width("tall")).toBeLessThan(await width("round"))
  })
})

describe("blob buddy: body colour", () => {
  const colourAt = (css: string): Array<number> => css.match(/rgba\((\d+),(\d+),(\d+)/)!.slice(1).map(Number)
  const luma = (c: ReadonlyArray<number>) => (0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!) / 255

  /** The body colour and the feature colour of one idle frame: the antenna is stroked in the body colour, the features just before it. */
  const bodyAndFeatures = async (bodyColor: string, palette: "dark" | "light") => {
    const r = new Runner(await fresh(), document.createElement("canvas"), { bodyColor })
    r.create()
    r.resize(720, 240, 1)
    const quiet = createVoiceFeatures()
    let strokes: Array<string> = []
    for (let i = 0; i < 30; i++) {
      recording.log = []
      r.step({ mode: "idle", dt: 1 / 60, user: quiet, agent: quiet, palette: PALETTES[palette], reducedMotion: true, pointer: { x: 0, y: 0, down: false, inside: false }, sinceInterrupt: Infinity })
      strokes = recording.log.filter((c) => c.name === "=strokeStyle").map((c) => String(c.args[0]))
    }
    r.dispose()
    return { body: colourAt(strokes[strokes.length - 1]!), features: colourAt(strokes[strokes.length - 2]!) }
  }

  for (const palette of ["dark", "light"] as const) {
    it(`gives a light body dark features and a dark body light features (${palette} theme)`, async () => {
      const pale = await bodyAndFeatures("#f4e7c5", palette)
      expect(luma(pale.features), "features on a pale body").toBeLessThan(luma(pale.body) - 0.4)
      const deep = await bodyAndFeatures("#16213b", palette)
      expect(luma(deep.features), "features on a deep body").toBeGreaterThan(luma(deep.body) + 0.4)
    })
  }
})

describe("blob buddy: size", () => {
  it("only shrinks: the smallest size draws a clearly smaller figure than the default", async () => {
    const small = spanOf(await go({ mode: "listening", stored: { size: 0.5 }, still: true, seconds: 2 }))
    const full = spanOf(await go({ mode: "listening", stored: { size: 1 }, still: true, seconds: 2 }))
    expect(small.w).toBeLessThan(full.w * 0.75)
    expect(small.h).toBeLessThan(full.h * 0.75)
  })
})

describe("blob buddy: stays in its frame", () => {
  // The source promises that a hop never lifts the antenna tip out of the frame ("a big, animated hop on a tall pose in a
  // small tile"); the gumdrop at normal expressiveness keeps its designed hop and is left out. 0.5 px is the bound's own margin.
  const hopping = (bodyShape: string, size: readonly [number, number, number]) => async () => {
    const e = extentOf(await go({ mode: "speaking", stored: { bodyShape, expressiveness: 1.6 }, size, seconds: 8 }))
    expect(e.minY).toBeGreaterThanOrEqual(-0.5)
  }
  for (const bodyShape of ["round", "tall"]) {
    it(`${bodyShape} in the smallest tile keeps its antenna below the top edge while hopping at the strongest expressiveness`, hopping(bodyShape, [160, 140, 1]))
    // BUG (see the PR description): on a large canvas the tip rises above the top edge, by up to ~14 px (tall, 900×420).
    it.fails(`${bodyShape} on a 900×420 stage keeps its antenna below the top edge while hopping at the strongest expressiveness`, hopping(bodyShape, [900, 420, 1]))
  }
})

describe("blob buddy: idle and listening poses", () => {
  it("sags low when idle and stands up to listen", async () => {
    const idle = spanOf(await go({ mode: "idle", still: true, seconds: 3 })).h
    const listening = spanOf(await go({ mode: "listening", still: true, seconds: 3 })).h
    expect(idle).toBeLessThan(listening)
  })
})

describe("blob buddy: eyes follow the pointer", () => {
  const frames = async (followsPointer: boolean, inside: boolean): Promise<Array<string>> => {
    const canvas = document.createElement("canvas")
    markStage(canvas)
    const r = new Runner(await fresh(), canvas, { followsPointer })
    r.create()
    r.resize(720, 240, 1)
    const quiet = createVoiceFeatures()
    const out: Array<string> = []
    for (let i = 0; i < 90; i++) {
      recording.reset()
      r.step({ mode: "listening", dt: 1 / 60, user: quiet, agent: quiet, palette: PALETTES.dark, reducedMotion: true, pointer: { x: 700, y: 20, down: false, inside }, sinceInterrupt: Infinity })
      if (i % 30 === 29) out.push(recording.digest)
    }
    r.dispose()
    return out
  }

  it("looks and leans toward a pointer over it", async () => {
    expect(await frames(true, true)).not.toEqual(await frames(true, false))
  })

  it("ignores the pointer when the option is off", async () => {
    expect(await frames(false, true)).toEqual(await frames(false, false))
  })
})
