// @vitest-environment node
// The lab's option tests (docs/research/visualiser-investigation/lab/test/options.test.ts) against the app's copy,
// without the lab's OptionStore (the app has no settings page yet), plus the reserved ids and the host-level settings.
import { describe, expect, it } from "vitest"
import type { OptionSpec, Palette, VoiceFeatures } from "@/characters/contract.ts"
import { optionProblems, parseHex, recolour, reservedOptionProblems, resolveAll, resolveColor, resolveOptions, scaleFeatures, snapNumber, validateValue } from "@/characters/options.ts"

const num: Extract<OptionSpec, { kind: "number" }> = { id: "n", kind: "number", label: "N", min: 1, max: 5, step: 1, default: 3 }
const frac: Extract<OptionSpec, { kind: "number" }> = { id: "f", kind: "number", label: "F", min: 0.5, max: 3, step: 0.1, default: 1 }
const tog: OptionSpec = { id: "t", kind: "toggle", label: "T", default: true }
const cho: OptionSpec = { id: "c", kind: "choice", label: "C", choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "a" }
const col: OptionSpec = { id: "k", kind: "color", label: "K", default: "voice" }
const specs = [num, frac, tog, cho, col]

const palette: Palette = { dark: true, bg: [0, 0, 0], surface: [1, 1, 1], line: [2, 2, 2], ink: [10, 10, 10], inkFaint: [20, 20, 20], you: [30, 30, 30], voice: [40, 40, 40], danger: [50, 50, 50] }

describe("validateValue", () => {
  it("clamps and snaps numbers", () => {
    expect(snapNumber(num, 99)).toBe(5)
    expect(snapNumber(num, -4)).toBe(1)
    expect(snapNumber(num, 2.6)).toBe(3)
    expect(snapNumber(frac, 1.34)).toBe(1.3)
    expect(snapNumber(frac, 0.3)).toBe(0.5)
  })
  it("accepts numeric strings and falls back on garbage", () => {
    expect(validateValue(num, "4")).toBe(4)
    expect(validateValue(num, "abc")).toBe(3)
    expect(validateValue(num, "")).toBe(3)
    expect(validateValue(num, NaN)).toBe(3)
    expect(validateValue(num, true)).toBe(3)
  })
  it("handles toggles, choices and colours", () => {
    expect(validateValue(tog, false)).toBe(false)
    expect(validateValue(tog, "0")).toBe(false)
    expect(validateValue(tog, "1")).toBe(true)
    expect(validateValue(tog, 7)).toBe(true)
    expect(validateValue(cho, "b")).toBe("b")
    expect(validateValue(cho, "z")).toBe("a")
    expect(validateValue(col, "#FFAA00")).toBe("#ffaa00")
    expect(validateValue(col, "you")).toBe("you")
    expect(validateValue(col, "#fff")).toBe("voice")
    expect(validateValue(col, "red")).toBe("voice")
  })
})

describe("resolveOptions", () => {
  it("is complete, overlays stored values and drops unknown ids", () => {
    const r = resolveOptions(specs, { n: 5, t: "nope", c: "b", other: 1 })
    expect(r).toEqual({ n: 5, f: 1, t: true, c: "b", k: "voice" })
  })
  it("gives {} for a design without options", () => {
    expect(resolveOptions(undefined, { a: 1 })).toEqual({})
    expect(resolveOptions([], undefined)).toEqual({})
  })
})

describe("optionProblems", () => {
  it("accepts a good declaration and none", () => {
    expect(optionProblems(specs)).toEqual([])
    expect(optionProblems(undefined)).toEqual([])
  })
  it("flags duplicate ids, bad defaults and empty labels", () => {
    const bad = [
      num,
      { ...num },
      { ...num, id: "x", default: 9 },
      { ...cho, id: "y", default: "zzz" },
      { ...tog, id: "w", label: " " },
      { ...col, id: "v", default: "#12" },
      { ...num, id: "u", min: 5, max: 1 },
      { ...frac, id: "s", default: 1.05 }
    ]
    const p = optionProblems(bad).join("\n")
    expect(p).toContain("duplicate id")
    expect(p).toContain("options.x: default 9 is outside")
    expect(p).toContain("options.y: default")
    expect(p).toContain("options.w: label")
    expect(p).toContain("options.v: default")
    expect(p).toContain("options.u: min")
    expect(p).toContain("step grid")
    expect(optionProblems("nope")).toHaveLength(1)
  })
})

describe("colours", () => {
  it("resolves keys against the palette and parses hex once", () => {
    expect(resolveColor("you", palette)).toBe(palette.you)
    expect(resolveColor("inkFaint", palette)).toBe(palette.inkFaint)
    expect(resolveColor("#ff8000", palette)).toEqual([255, 128, 0])
    expect(parseHex("#ff8000")).toBe(parseHex("#ff8000"))
    expect(resolveColor("garbage", palette)).toBe(palette.ink)
    expect(resolveColor(undefined, palette)).toBe(palette.ink)
  })
  it("recolours you and voice, resolving keys against the base", () => {
    expect(recolour(palette, "you", "voice")).toBe(palette)
    const p = recolour(palette, "voice", "#000001")
    expect(p.you).toBe(palette.voice)
    expect(p.voice).toEqual([0, 0, 1])
  })
})

const feat = (): VoiceFeatures =>
  ({ level: 0.6, rms: 0.3, speaking: true, speechFor: 1, silenceFor: 0, voicing: 1, pitchHz: 120, pitch: 0.4, pitchDelta: 0, register: 0.4, bands: new Float32Array(24).fill(0.5), low: 0.2, mid: 0.8, high: 0.1, brightness: 0.5, sibilance: 0, onset: 0, syllableRate: 4, mouth: { open: 0.5, wide: 0, round: 0 }, wave: new Float32Array(256) }) as VoiceFeatures

describe("scaleFeatures", () => {
  it("scales the loudness features on a copy and clamps", () => {
    const src = feat()
    const dst = feat()
    const bands = new Float32Array(24)
    scaleFeatures(src, dst, bands, 2)
    expect(dst.level).toBe(1)
    expect(dst.rms).toBeCloseTo(0.6)
    expect(dst.low).toBeCloseTo(0.4)
    expect(dst.mid).toBe(1)
    expect(dst.bands).toBe(bands)
    expect(bands[0]).toBe(1)
    expect(dst.pitchHz).toBe(120)
    expect(src.level).toBe(0.6)
    expect(src.bands[0]).toBe(0.5)
    scaleFeatures(src, dst, bands, 0.4)
    expect(dst.level).toBeCloseTo(0.24)
  })
})

describe("reserved ids (docs/CHARACTERS.md §4.4)", () => {
  it("accepts them with their kind and the designed default", () => {
    const ok: ReadonlyArray<OptionSpec> = [
      { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.5, step: 0.05, default: 1 },
      { id: "glow", kind: "toggle", label: "Glow", default: true },
      { id: "nods", kind: "toggle", label: "Nods", default: true },
      { id: "other", kind: "toggle", label: "Other", default: false }
    ]
    expect(reservedOptionProblems(ok)).toEqual([])
  })
  it("flags another kind or another default", () => {
    const bad: ReadonlyArray<OptionSpec> = [
      { id: "speed", kind: "choice", label: "Speed", choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "a" },
      { id: "nods", kind: "number", label: "Nods", min: 0, max: 1, step: 1, default: 1 },
      { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.5, step: 0.05, default: 0.8 },
      { id: "followsPointer", kind: "toggle", label: "Follow", default: false }
    ]
    const p = reservedOptionProblems(bad).join("\n")
    expect(p).toContain("options.speed: a reserved id")
    expect(p).toContain("options.nods: a reserved id")
    expect(p).toContain("options.size: a reserved number's default must be 1")
    expect(p).toContain("options.followsPointer: a reserved toggle's default must be on")
  })
})

describe("resolveAll", () => {
  it("validates the host-level settings beside the character's own, from one stored object", () => {
    const r = resolveAll(specs, { n: "4", $you: "#00FF00", $sensitivity: 9, $voice: 3 }, 1)
    expect(r.values).toEqual({ n: 4, f: 1, t: true, c: "a", k: "voice" })
    expect(r.you).toBe("#00ff00")
    expect(r.voice).toBe("voice")
    expect(r.sensitivity).toBe(2.5)
  })
})
