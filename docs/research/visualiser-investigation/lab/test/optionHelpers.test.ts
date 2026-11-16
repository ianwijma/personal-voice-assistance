// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { OptionSpec } from "../src/contract.ts"
import { COMMON_OPTIONS, isDefault, isHexColor, isPaletteKey, normaliseColor, resolveAll, rgbToHex, valueToString, parseHex, validateValue } from "../src/options.ts"

describe("colour values", () => {
  it("isPaletteKey and isHexColor accept only their own forms", () => {
    for (const k of ["you", "voice", "ink", "inkFaint"]) expect(isPaletteKey(k)).toBe(true)
    for (const k of ["bg", "", "YOU", 3, null, undefined]) expect(isPaletteKey(k)).toBe(false)
    expect(isHexColor("#a1B2c3")).toBe(true)
    for (const k of ["#abc", "a1b2c3", "#12345g", "#1234567", "rgb(1,2,3)", 0xffffff, null]) expect(isHexColor(k)).toBe(false)
  })

  it("normaliseColor keeps palette keys, lower-cases hex and rejects everything else", () => {
    expect(normaliseColor("voice")).toBe("voice")
    expect(normaliseColor("#AABBCC")).toBe("#aabbcc")
    expect(normaliseColor("#abc")).toBeNull()
    expect(normaliseColor("red")).toBeNull()
    expect(normaliseColor(5)).toBeNull()
  })

  it("rgbToHex rounds and clamps channels, and round-trips with parseHex", () => {
    expect(rgbToHex([0, 0, 0])).toBe("#000000")
    expect(rgbToHex([255, 255, 255])).toBe("#ffffff")
    expect(rgbToHex([1.4, 1.6, 15.5])).toBe("#010210")
    expect(rgbToHex([-20, 300, 10])).toBe("#00ff0a")
    for (const c of [[12, 200, 77], [255, 0, 128], [1, 2, 3]] as const) expect(parseHex(rgbToHex(c))).toEqual([...c])
  })
})

describe("isDefault and valueToString", () => {
  const num: OptionSpec = { id: "n", kind: "number", label: "N", min: 0, max: 10, step: 1, default: 4 }
  const tog: OptionSpec = { id: "t", kind: "toggle", label: "T", default: false }
  const col: OptionSpec = { id: "c", kind: "color", label: "C", default: "#ABCDEF" }

  it("isDefault compares against the validated default, so a mixed-case hex default still matches", () => {
    expect(isDefault(num, 4)).toBe(true)
    expect(isDefault(num, 5)).toBe(false)
    expect(isDefault(tog, false)).toBe(true)
    expect(isDefault(tog, true)).toBe(false)
    expect(isDefault(col, validateValue(col, "#ABCDEF"))).toBe(true)
    expect(isDefault(col, "voice")).toBe(false)
    expect(isDefault(num, "4")).toBe(false) // not the validated number
  })

  it("valueToString writes toggles as 1/0 and numbers and strings as is", () => {
    expect(valueToString(true)).toBe("1")
    expect(valueToString(false)).toBe("0")
    expect(valueToString(0.25)).toBe("0.25")
    expect(valueToString(3)).toBe("3")
    expect(valueToString("round")).toBe("round")
  })
})

describe("resolveAll", () => {
  const specs: ReadonlyArray<OptionSpec> = [{ id: "size", kind: "number", label: "Size", min: 1, max: 5, step: 1, default: 3 }]

  it("gives defaults for nothing stored, tagged with the version", () => {
    const r = resolveAll(specs, undefined, 7)
    expect(r.version).toBe(7)
    expect(r.values).toEqual({ size: 3 })
    expect(r.common).toEqual({ $you: "you", $voice: "voice", $sensitivity: 1 })
    expect(r.you).toBe("you")
    expect(r.voice).toBe("voice")
    expect(r.sensitivity).toBe(1)
  })

  it("reads the design's values and the common ones from the same stored map, validating both", () => {
    const r = resolveAll(specs, { size: 99, $you: "#FF0000", $voice: "not a colour", $sensitivity: 100 }, 1)
    expect(r.values).toEqual({ size: 5 })
    expect(r.you).toBe("#ff0000")
    expect(r.voice).toBe("voice") // invalid → default
    expect(r.sensitivity).toBe(2.5) // clamped to the declared max
  })

  it("works for a design without options and keeps the common ones", () => {
    const r = resolveAll(undefined, { $sensitivity: 0.1 }, 0)
    expect(r.values).toEqual({})
    expect(r.sensitivity).toBe(0.4)
  })

  it("the common settings are well formed and use the reserved $ ids", () => {
    expect(COMMON_OPTIONS.map((o) => o.id)).toEqual(["$you", "$voice", "$sensitivity"])
  })
})
