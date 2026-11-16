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

/** A character that clears the canvas and then runs `draw` each frame, with the mode's own colour to draw with. */
const drawing = (id: string, draw: (g: ReturnType<typeof setup2d>, colour: string) => void): Character => ({
  ...manifest,
  id,
  name: id,
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
        draw(g, COLOURS[f.coreMode])
      },
      dispose: () => undefined
    }
  }
})

/** Each of these draws nothing a browser would show, with a different valid colour per mode. */
const EMPTY: ReadonlyArray<readonly [string, Character]> = [
  [
    "a fill of an empty path",
    drawing("empty-path-fill", (g, c) => {
      g.beginPath()
      g.fillStyle = c
      g.fill()
    })
  ],
  [
    "a stroke of an empty path",
    drawing("empty-path-stroke", (g, c) => {
      g.beginPath()
      g.strokeStyle = c
      g.stroke()
    })
  ],
  [
    "a fill of a path with only a starting point",
    drawing("moveto-only", (g, c) => {
      g.beginPath()
      g.moveTo(5, 5)
      g.fillStyle = c
      g.fill()
    })
  ],
  [
    "zero-sized rectangles",
    drawing("zero-rects", (g, c) => {
      g.fillStyle = c
      g.strokeStyle = c
      g.fillRect(10, 10, 0, 20)
      g.fillRect(10, 10, 20, 0)
      g.fillRect(10, 10, 0, 0)
      g.strokeRect(10, 10, 0, 0)
      g.beginPath()
      g.rect(10, 10, 0, 0)
      g.fill()
    })
  ],
  [
    "everything at a global alpha of 0",
    drawing("alpha-zero", (g, c) => {
      g.globalAlpha = 0
      g.fillStyle = c
      g.strokeStyle = c
      g.fillRect(0, 0, 20, 20)
      g.strokeRect(0, 0, 20, 20)
      g.beginPath()
      g.arc(10, 10, 5, 0, Math.PI * 2)
      g.fill()
      g.stroke()
      g.fillText("text", 5, 5)
    })
  ],
  [
    "strokes of a line width of 0 and empty text",
    drawing("no-line-no-text", (g, c) => {
      g.strokeStyle = c
      g.fillStyle = c
      g.lineWidth = 0
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(20, 20)
      g.stroke()
      g.strokeRect(0, 0, 20, 20)
      g.fillText("", 5, 5)
    })
  ]
]

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

  for (const [what, character] of EMPTY)
    it(`a character that only does ${what} fails it, in every mode`, async () => {
      const problems = await coreModeProblems(runMode(character))
      expect(problems.filter((p) => p.includes("paints nothing"))).toHaveLength(5)
      expect(problems).toContain("idle and listening paint the same")
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

describe("the test canvas counts only effective painting", () => {
  const paints = (draw: (g: CanvasRenderingContext2D) => void): number => {
    const rec = new Recording()
    draw(fake2d({ width: 10, height: 10 }, rec))
    return rec.paints
  }

  it("a fill or stroke needs a path with a segment, a stroke a line width", () => {
    expect(paints((g) => { g.beginPath(); g.fill() })).toBe(0)
    expect(paints((g) => { g.beginPath(); g.stroke() })).toBe(0)
    expect(paints((g) => { g.beginPath(); g.moveTo(1, 1); g.fill() })).toBe(0)
    expect(paints((g) => { g.beginPath(); g.lineTo(1, 1); g.stroke() })).toBe(0) // a lone lineTo only starts a sub-path
    expect(paints((g) => { g.beginPath(); g.moveTo(1, 1); g.lineTo(5, 5); g.fill() })).toBe(1)
    expect(paints((g) => { g.beginPath(); g.moveTo(1, 1); g.lineTo(5, 5); g.stroke() })).toBe(1)
    expect(paints((g) => { g.beginPath(); g.moveTo(1, 1); g.lineTo(5, 5); g.lineWidth = 0; g.stroke() })).toBe(0)
    expect(paints((g) => { g.beginPath(); g.arc(5, 5, 3, 0, 6); g.fill() })).toBe(1)
    expect(paints((g) => { g.beginPath(); g.arc(5, 5, 0, 0, 6); g.fill() })).toBe(0)
    expect(paints((g) => { g.beginPath(); g.ellipse(5, 5, 3, 2, 0, 0, 6); g.stroke() })).toBe(1)
    expect(paints((g) => { g.beginPath(); g.roundRect(0, 0, 8, 8, 2); g.fill() })).toBe(1)
    expect(paints((g) => { g.beginPath(); g.moveTo(Number.NaN, 1); g.lineTo(Number.NaN, 5); g.fill() })).toBe(0)
    expect(paints((g) => { g.beginPath(); g.moveTo(1, 1); g.lineTo(5, 5); g.beginPath(); g.fill() })).toBe(0) // a new path starts empty
  })

  it("a rectangle needs a size, text must not be empty, an image draw needs a size", () => {
    expect(paints((g) => g.fillRect(0, 0, 0, 5))).toBe(0)
    expect(paints((g) => g.fillRect(0, 0, 5, 0))).toBe(0)
    expect(paints((g) => g.fillRect(0, 0, 5, 5))).toBe(1)
    expect(paints((g) => g.strokeRect(0, 0, 0, 0))).toBe(0)
    expect(paints((g) => g.strokeRect(0, 0, 5, 0))).toBe(1)
    expect(paints((g) => g.fillText("", 1, 1))).toBe(0)
    expect(paints((g) => g.fillText("a", 1, 1))).toBe(1)
    const image = { width: 4, height: 4 } as unknown as CanvasImageSource
    expect(paints((g) => g.drawImage(image, 0, 0, 0, 5))).toBe(0)
    expect(paints((g) => g.drawImage(image, 0, 0, 5, 5))).toBe(1)
    expect(paints((g) => g.drawImage({ width: 0, height: 4 } as unknown as CanvasImageSource, 0, 0))).toBe(0)
    expect(paints((g) => g.drawImage(image, 0, 0))).toBe(1)
  })

  it("nothing counts at a global alpha of 0, and it counts again when the alpha is restored", () => {
    expect(paints((g) => { g.globalAlpha = 0; g.fillRect(0, 0, 5, 5) })).toBe(0)
    expect(paints((g) => { g.globalAlpha = 0; g.fillRect(0, 0, 5, 5); g.globalAlpha = 1; g.fillRect(0, 0, 5, 5) })).toBe(1)
    expect(paints((g) => { g.save(); g.globalAlpha = 0; g.restore(); g.fillRect(0, 0, 5, 5) })).toBe(1)
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

  it("createRadialGradient throws a TypeError for any non-finite argument, before it looks at the radii", () => {
    const name = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        return (e as Error).name
      }
      return "no error"
    }
    const six = [0, 0, 1, 0, 0, 5]
    for (let i = 0; i < 6; i++)
      for (const bad of [Number.NaN, Infinity, -Infinity]) {
        const a = [...six]
        a[i] = bad
        expect(name(() => g().createRadialGradient(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!, a[5]!)), `argument ${i} = ${bad}`).toBe("TypeError")
      }
    // A non-finite argument next to a negative radius: the TypeError wins.
    expect(name(() => g().createRadialGradient(Number.NaN, 0, -1, 0, 0, 5))).toBe("TypeError")
    expect(name(() => g().createRadialGradient(0, 0, -1, 0, 0, Infinity))).toBe("TypeError")
    expect(name(() => g().createRadialGradient(0, 0, -1, 0, 0, 5))).toBe("IndexSizeError")
    // And what check (10) inspects: the call is counted as given a non-finite number.
    const rec = new Recording()
    const c = fake2d({ width: 10, height: 10 }, rec)
    expect(() => c.createRadialGradient(0, 0, 0, 0, 0, Number.NaN)).toThrow(TypeError)
    expect(rec.nonFinite).toBe(1)
    expect(() => c.createRadialGradient(0, 0, 0, 0, 0, 1)).not.toThrow()
    expect(rec.nonFinite).toBe(1)
  })

  it("roundRect with a non-finite radius draws nothing and does not throw, even next to a negative one; only a finite negative radius throws", () => {
    const rec = new Recording()
    const c = fake2d({ width: 10, height: 10 }, rec)
    expect(() => c.roundRect(0, 0, 5, 5, Number.NaN)).not.toThrow()
    expect(() => c.roundRect(0, 0, 5, 5, Infinity)).not.toThrow()
    expect(() => c.roundRect(0, 0, 5, 5, [-1, Number.NaN])).not.toThrow() // the non-finite one is met first, as in a browser
    expect(() => c.roundRect(0, 0, 5, 5, [Number.NaN, -1])).not.toThrow()
    expect(() => c.roundRect(0, 0, 5, 5, { x: Number.NaN, y: -1 })).not.toThrow()
    expect(() => c.roundRect(0, 0, 5, 5, { x: -1, y: Infinity })).not.toThrow()
    expect(() => c.roundRect(0, 0, 5, 5, [2, { x: 1, y: Number.NaN }])).not.toThrow()
    expect(() => c.roundRect(0, 0, 5, 5, { x: 1, y: -2 })).toThrow(RangeError) // both coordinates of a point-like radius
    expect(() => c.roundRect(0, 0, 5, 5, { x: -2, y: 1 })).toThrow(RangeError)
    expect(() => c.roundRect(0, 0, 5, 5, -1)).toThrow(RangeError)
    // Nothing was drawn by the skipped calls: the path is still empty, so a fill is not a paint.
    const fresh = new Recording()
    const g2 = fake2d({ width: 10, height: 10 }, fresh)
    g2.beginPath()
    g2.roundRect(0, 0, 5, 5, Number.NaN)
    g2.fill()
    expect(fresh.paints).toBe(0)
  })

  it("arc, arcTo and ellipse do nothing for a non-finite argument, even with a negative radius; a finite negative radius throws", () => {
    const rec = new Recording()
    const c = fake2d({ width: 10, height: 10 }, rec)
    expect(() => {
      c.arc(5, 5, Number.NaN, 0, 1)
      c.arc(5, 5, -1, Infinity, 1)
      c.arcTo(0, 0, 5, Number.NaN, -1)
      c.arcTo(0, 0, 5, 5, Infinity)
      c.ellipse(5, 5, -1, Number.NaN, 0, 0, 1)
      c.ellipse(5, 5, 2, 3, Number.NaN, 0, 1)
      c.ellipse(5, 5, Infinity, 3, 0, 0, 1)
    }).not.toThrow()
    expect(() => c.arc(5, 5, -1, 0, 1)).toThrow(DOMException)
    expect(() => c.arcTo(0, 0, 5, 5, -1)).toThrow(DOMException)
    expect(() => c.ellipse(5, 5, -1, 3, 0, 0, 1)).toThrow(DOMException)
    expect(() => c.ellipse(5, 5, 2, -3, 0, 0, 1)).toThrow(DOMException)
    const fresh = new Recording()
    const g2 = fake2d({ width: 10, height: 10 }, fresh)
    g2.beginPath()
    g2.arc(5, 5, Number.NaN, 0, 1)
    g2.ellipse(5, 5, 2, 2, Number.NaN, 0, 1)
    g2.fill()
    expect(fresh.paints).toBe(0)
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
