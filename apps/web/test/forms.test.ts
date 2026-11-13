import { describe, expect, it } from "vitest"
import type { SettingsForm } from "@pva/protocol"
import { exampleHomeAssistantModule, exampleWeatherModule } from "@pva/protocol/examples"
import { computePatch, errorsByKey, initialDraft, isDirty, parseNumber, reconcile, splitAdvanced } from "@/lib/forms.ts"

const weather = exampleWeatherModule.settings
const ha = exampleHomeAssistantModule.settings

describe("generated forms", () => {
  it("sends only the changed fields", () => {
    const d = initialDraft(weather)
    expect(isDirty(weather, d)).toBe(false)
    const edited = { ...d, values: { ...d.values, units: "fahrenheit", defaultPlace: "Amsterdam" } }
    expect(computePatch(weather, edited)).toEqual({ values: { units: "fahrenheit" }, secrets: {} })
  })

  it("compares multichoice values by content and sends secrets only when touched", () => {
    const d = initialDraft(ha)
    const same = { ...d, values: { ...d.values, domains: ["light", "sensor", "climate"] } }
    expect(isDirty(ha, same)).toBe(false)
    const replaced = { values: { ...d.values, domains: ["light"] }, secrets: { token: "new" } }
    expect(computePatch(ha, replaced)).toEqual({ values: { domains: ["light"] }, secrets: { token: "new" } })
    expect(computePatch(ha, { ...d, secrets: { token: null } })).toEqual({ values: {}, secrets: { token: null } })
  })

  it("never sends locked fields", () => {
    const locked: SettingsForm = { ...weather, fields: weather.fields.map((f) => (f.key === "units" ? { ...f, locked: { reason: "Set by WEATHER_UNITS" } } : f)) }
    const d = initialDraft(locked)
    expect(computePatch(locked, { ...d, values: { ...d.values, units: "fahrenheit" } })).toEqual({ values: {}, secrets: {} })
  })

  it("a newer revision updates a clean form silently and marks a dirty form stale, keeping the edits", () => {
    const next: SettingsForm = { ...weather, values: { ...weather.values, defaultPlace: "Utrecht" } }
    const clean = reconcile({ draft: initialDraft(weather), baseRevision: 3, stale: false }, weather, next, 4)
    expect(clean).toEqual({ draft: initialDraft(next), baseRevision: 4, stale: false })

    const edits = { ...initialDraft(weather), values: { ...weather.values, units: "fahrenheit" } }
    const dirty = reconcile({ draft: edits, baseRevision: 3, stale: false }, weather, next, 4)
    expect(dirty.stale).toBe(true)
    expect(dirty.draft).toBe(edits)

    const old = { draft: edits, baseRevision: 5, stale: false }
    expect(reconcile(old, weather, next, 4)).toBe(old)
  })

  it("groups errors by field, null for the form", () => {
    const m = errorsByKey([{ key: "a", message: "x" }, { key: null, message: "y" }, { key: "a", message: "z" }])
    expect(m.get("a")).toEqual(["x", "z"])
    expect(m.get(null)).toEqual(["y"])
  })

  it("splits advanced fields", () => {
    expect(splitAdvanced(weather.fields).advanced.map((f) => f.key)).toEqual(["timeoutMs"])
  })

  it("parses number inputs against the field's limits", () => {
    const f = weather.fields.find((x) => x.type === "number")!
    if (f.type !== "number") throw new Error()
    expect(parseNumber("3000", f)).toEqual({ value: 3000 })
    expect(parseNumber("", f)).toHaveProperty("error")
    expect(parseNumber("1.5", f)).toEqual({ error: "Enter a whole number." })
    expect(parseNumber("100", f)).toEqual({ error: "At least 500 ms." })
  })
})
