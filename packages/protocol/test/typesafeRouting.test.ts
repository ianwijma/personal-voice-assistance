// What WP-14 changed in the protocol: `validateDeviceSettings` warns about switched-on assistants without Handles on a
// TypeSafe device (docs/ASSISTANTS.md §2.2), and a trace's TypeSafe route carries the Noul as a fraction.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TraceRoute, validateDeviceSettings } from "../src/index.ts"

const known = new Set(["jeff", "keuken"])
const typesafe = {
  assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }, { assistant: "keuken", phrases: [] }],
  withoutPhrase: { mode: "typesafe", fallback: "jeff", giveUpMs: 400 }
} as const
const records = (over: { jeff?: Partial<{ on: boolean; handles: string }>; keuken?: Partial<{ on: boolean; handles: string }> } = {}) =>
  new Map([
    ["jeff", { name: "Jeff", on: true, handles: "Everything else.", ...over.jeff }],
    ["keuken", { name: "Keuken", on: true, handles: "Timers and recipes.", ...over.keuken }]
  ])

describe("validateDeviceSettings: no_handles (TypeSafe devices)", () => {
  it("warns for a switched-on assistant whose Handles is empty or blank, at its own path", () => {
    for (const handles of ["", "   \n "]) {
      const v = validateDeviceSettings(typesafe, known, { assistants: records({ keuken: { handles } }) })
      expect(v.errors).toEqual([])
      expect(v.warnings).toEqual([
        {
          code: "no_handles",
          path: "assistants.keuken.handles",
          message: "Keuken has no Handles text, so TypeSafe can only go by its name and purpose."
        }
      ])
    }
  })

  it("one warning per assistant without Handles, none when every one has them", () => {
    const both = validateDeviceSettings(typesafe, known, { assistants: records({ jeff: { handles: "" }, keuken: { handles: "" } }) })
    expect(both.warnings.map((w) => w.path)).toEqual(["assistants.jeff.handles", "assistants.keuken.handles"])
    expect(validateDeviceSettings(typesafe, known, { assistants: records() }).warnings).toEqual([])
  })

  it("not for an assistant that is switched off", () => {
    expect(validateDeviceSettings(typesafe, known, { assistants: records({ keuken: { on: false, handles: "" } }) }).warnings).toEqual([])
  })

  it("not when TypeSafe does not decide on this device, whatever the Handles", () => {
    const empty = records({ jeff: { handles: "" }, keuken: { handles: "" } })
    for (const withoutPhrase of [{ mode: "nobody" }, { mode: "assistant", assistant: "jeff" }] as const) {
      const v = validateDeviceSettings({ ...typesafe, withoutPhrase }, known, { assistants: empty })
      expect(v.warnings.map((w) => w.code)).not.toContain("no_handles")
    }
  })

  it("not without the assistants' records (the old two-argument call), and not for an assistant missing from them", () => {
    expect(validateDeviceSettings(typesafe, known).warnings).toEqual([])
    const onlyJeff = new Map([["jeff", { name: "Jeff", on: true, handles: "" }]])
    expect(validateDeviceSettings(typesafe, known, { assistants: onlyJeff }).warnings.map((w) => w.path)).toEqual(["assistants.jeff.handles"])
  })

  it("is a warning only: it never refuses the save (errors stay empty)", () => {
    const v = validateDeviceSettings(typesafe, known, { assistants: records({ jeff: { handles: "" }, keuken: { handles: "" } }) })
    expect(v.errors).toEqual([])
  })
})

describe("TraceRoute: TypeSafe", () => {
  const decode = Schema.decodeUnknownSync(TraceRoute)
  const base = { by: "typesafe", outcome: "chosen", ms: 120, fallback: false } as const

  it("accepts the Noul as a fraction and the probability, both optional", () => {
    expect(decode({ ...base, probability: 0.92, fits: 0.95 })).toEqual({ ...base, probability: 0.92, fits: 0.95 })
    expect(decode({ ...base, fits: 0 })).toEqual({ ...base, fits: 0 })
    expect(decode(base)).toEqual(base)
  })

  it("accepts every outcome and rejects an unknown one, a negative time and non-finite numbers", () => {
    for (const outcome of ["chosen", "none-fits", "timeout", "error"]) expect(decode({ ...base, outcome }).by).toBe("typesafe")
    expect(() => decode({ ...base, outcome: "maybe" })).toThrow()
    expect(() => decode({ ...base, ms: -1 })).toThrow()
    expect(() => decode({ ...base, fits: Number.NaN })).toThrow()
    expect(() => decode({ ...base, probability: Number.POSITIVE_INFINITY })).toThrow()
  })
})
