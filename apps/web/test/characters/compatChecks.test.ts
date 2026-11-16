/**
 * The compatibility suite's own checks, proven on characters built to fail them (review of #12): a character that
 * only clears and sets state paints nothing, one whose modes differ only in state set after its last paint shows
 * the same in every mode, and the test canvas throws where a browser throws.
 */
import { describe, expect, it } from "vitest"
import type { Character, CharacterInstance, CoreMode } from "@/characters/contract.ts"
import { clear2d, rgba, setup2d } from "@/characters/kit.ts"
import { CONVERSATION, CONVERSATION_SECONDS, pinned, run } from "./support/conversation.ts"
import { coreModeProblems } from "./support/compat.ts"
import { fake2d, installFakeCanvas, Recording } from "./support/fakeCanvas.ts"
import { PALETTES } from "./support/palettes.ts"
import testDots from "./support/test-dots.ts"

installFakeCanvas()

const manifest = {
  version: "0.0.1",
  contract: 1,
  family: "abstract",
  summary: "A fixture that must fail.",
  inspiredBy: "Nothing.",
  modes: { idle: "a", listening: "b", hearing: "c", thinking: "d", speaking: "e" },
  mappings: [{ signal: "mode", effect: "nothing visible" }],
  renderer: "2d"
} as const

const COLOURS: { readonly [M in CoreMode]: string } = { idle: "#111111", listening: "#222222", hearing: "#333333", thinking: "#444444", speaking: "#555555" }

/** Clears the canvas and sets a different, valid fill colour per mode, and never paints: a blank stage. */
const blank: Character = {
  ...manifest,
  id: "blank",
  name: "Blank",
  create: (canvas): CharacterInstance => {
    let g = setup2d(canvas)
    let dpr = 1
    return {
      resize: (_w, _h, ratio) => {
        dpr = ratio
        g = setup2d(canvas, dpr)
      },
      frame: (f) => {
        clear2d(g, dpr)
        g.fillStyle = COLOURS[f.coreMode]
        g.beginPath()
        g.rect(0, 0, 10, 10) // a path, never filled
      },
      dispose: () => undefined
    }
  }
}

/** Paints the same grey square in every mode, then sets a per-mode colour nothing is painted with. */
const sameInEveryMode: Character = {
  ...manifest,
  id: "same-in-every-mode",
  name: "Same in every mode",
  create: (canvas): CharacterInstance => {
    let g = setup2d(canvas)
    let dpr = 1
    return {
      resize: (_w, _h, ratio) => {
        dpr = ratio
        g = setup2d(canvas, dpr)
      },
      frame: (f) => {
        clear2d(g, dpr)
        g.fillStyle = rgba([128, 128, 128], 1)
        g.fillRect(10, 10, 20, 20)
        g.fillStyle = COLOURS[f.coreMode]
        g.strokeStyle = COLOURS[f.coreMode]
      },
      dispose: () => undefined
    }
  }
}

const runMode = (c: Character) => (m: CoreMode) => Promise.resolve(run(c, { script: pinned(m), seconds: 1, palette: PALETTES.dark }))

describe("check (1): every core mode paints, and paints something different", () => {
  it("a blank character fails it (it would have passed on call counts and call digests alone)", async () => {
    const r = run(blank, { script: pinned("idle"), seconds: 1, palette: PALETTES.dark })
    expect(r.lastCalls).toBeGreaterThan(0)
    expect(run(blank, { script: pinned("speaking"), seconds: 1, palette: PALETTES.dark }).last).not.toBe(r.last)
    const problems = await coreModeProblems(runMode(blank))
    expect(problems).toContain("idle paints nothing (5 calls, none of them puts pixels on a canvas)")
    expect(problems.filter((p) => p.endsWith("paints nothing (5 calls, none of them puts pixels on a canvas)"))).toHaveLength(5)
  })

  it("a character whose modes differ only in state it never paints with fails it", async () => {
    expect(run(sameInEveryMode, { script: pinned("idle"), seconds: 1, palette: PALETTES.dark }).last).not.toBe(run(sameInEveryMode, { script: pinned("hearing"), seconds: 1, palette: PALETTES.dark }).last)
    const problems = await coreModeProblems(runMode(sameInEveryMode))
    expect(problems).toContain("idle and listening paint the same")
    expect(problems).toHaveLength(10)
  })

  it("a real character passes it, and the baseline does", async () => {
    expect(await coreModeProblems(runMode(testDots))).toEqual([])
    const { default: baseline } = await import("@/characters/library/sine-lines.ts")
    expect(await coreModeProblems(runMode(baseline))).toEqual([])
  })

  it("state set in an earlier frame still counts for a paint made with it", () => {
    const rec = new Recording()
    const g = fake2d({ width: 10, height: 10 }, rec)
    const paintOnce = (colour: string | null) => {
      if (colour !== null) g.fillStyle = colour
      rec.reset()
      g.fillRect(0, 0, 5, 5)
      return rec.paintDigest
    }
    const red = paintOnce("#ff0000")
    expect(paintOnce(null)).toBe(red) // the same fill colour, set a frame earlier
    expect(paintOnce("#00ff00")).not.toBe(red)
  })
})

describe("the test canvas throws where a browser throws", () => {
  const g = () => fake2d({ width: 10, height: 10 }, new Recording())

  it("a negative radius: arc, arcTo, ellipse and createRadialGradient throw an IndexSizeError, roundRect a RangeError", () => {
    const name = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return (e as Error).name
      }
      return "no error"
    }
    expect(name(() => g().arc(5, 5, -1, 0, Math.PI))).toBe("IndexSizeError")
    expect(name(() => g().arcTo(0, 0, 5, 5, -0.5))).toBe("IndexSizeError")
    expect(name(() => g().ellipse(5, 5, 2, -1, 0, 0, Math.PI))).toBe("IndexSizeError")
    expect(name(() => g().ellipse(5, 5, -2, 1, 0, 0, Math.PI))).toBe("IndexSizeError")
    expect(name(() => g().createRadialGradient(0, 0, -1, 0, 0, 5))).toBe("IndexSizeError")
    expect(name(() => g().createRadialGradient(0, 0, 0, 0, 0, -5))).toBe("IndexSizeError")
    expect(name(() => g().roundRect(0, 0, 5, 5, -1))).toBe("RangeError")
    expect(name(() => g().roundRect(0, 0, 5, 5, [2, -1]))).toBe("RangeError")
    expect(name(() => g().roundRect(0, 0, 5, 5, [1, 2, 3, 4, 5]))).toBe("RangeError")
  })

  it("zero radii are fine, and a non-finite argument is skipped and counted, not thrown", () => {
    const rec = new Recording()
    const c = fake2d({ width: 10, height: 10 }, rec)
    expect(() => {
      c.arc(5, 5, 0, 0, Math.PI)
      c.arcTo(0, 0, 5, 5, 0)
      c.ellipse(5, 5, 0, 0, 0, 0, Math.PI)
      c.roundRect(0, 0, 5, 5, 0)
      c.roundRect(0, 0, 5, 5, [0, { x: 1, y: 2 }])
      c.createRadialGradient(0, 0, 0, 0, 0, 0)
    }).not.toThrow()
    expect(rec.nonFinite).toBe(0)
    expect(() => c.arc(Number.NaN, 5, -1, 0, Math.PI)).not.toThrow()
    c.lineTo(Infinity, 0)
    expect(rec.nonFinite).toBe(2)
  })
})

describe("check (10) on the suite's own fixture", () => {
  it("test-dots on a 1 × 1 canvas: no throw, finite coordinates", () => {
    const r = run(testDots, { script: CONVERSATION, seconds: CONVERSATION_SECONDS, palette: PALETTES.dark, size: [1, 1, 1] })
    expect(r.nonFinite).toBe(0)
  })
})
