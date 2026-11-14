import { describe, expect, it } from "vitest"
import type { SettingsForm } from "@pva/protocol"
import { exampleHomeAssistantModule, exampleWeatherModule } from "@pva/protocol/examples"
import {
  computePatch,
  draftLookup,
  errorsByKey,
  fieldVisible,
  initialDraft,
  isDirty,
  onlyReloadFields,
  parseNumber,
  reconcile,
  resetDraftValue,
  setDraftValue,
  someReloadFields,
  splitAdvanced
} from "@/lib/forms.ts"

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
    const replaced = { ...d, values: { ...d.values, domains: ["light"] }, secrets: { token: "new" } }
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
    // The edit is kept, the other tab's change shows in the field the user did not touch...
    expect(dirty.draft.values).toMatchObject({ units: "fahrenheit", defaultPlace: "Utrecht" })
    // ...and saving sends only the edit: never a reset of the other tab's change.
    expect(computePatch(next, dirty.draft)).toEqual({ values: { units: "fahrenheit" }, secrets: {} })

    const old = { draft: edits, baseRevision: 5, stale: false }
    expect(reconcile(old, weather, next, 4)).toBe(old)
  })

  it("a stale form saved without reconciling still sends only what the user edited (review finding 7)", () => {
    // a=old-a, b=old-b; the user edits only a; another tab changes b; the form shown is the newest.
    const edits = { ...initialDraft(weather), values: { ...initialDraft(weather).values, units: "fahrenheit" } }
    const remote: SettingsForm = { ...weather, values: { ...weather.values, defaultPlace: "remote place" } }
    expect(computePatch(remote, edits)).toEqual({ values: { units: "fahrenheit" }, secrets: {} })
    // An edit reverted by hand is no edit.
    const reverted = { ...edits, values: { ...edits.values, units: weather.values.units! } }
    expect(isDirty(remote, reverted)).toBe(false)
  })

  it("several revisions in a row keep merging, and a field both sides changed keeps the user's edit", () => {
    const edits = { ...initialDraft(weather), values: { ...weather.values, units: "fahrenheit" } }
    const r4: SettingsForm = { ...weather, values: { ...weather.values, defaultPlace: "Utrecht" } }
    const r5: SettingsForm = { ...weather, values: { ...weather.values, defaultPlace: "Delft", units: "celsius", timeoutMs: 4000 } }
    let sync = reconcile({ draft: edits, baseRevision: 3, stale: false }, weather, r4, 4)
    sync = reconcile(sync, r4, r5, 5)
    expect(sync.draft.values).toMatchObject({ units: "fahrenheit", defaultPlace: "Delft", timeoutMs: 4000 })
    expect(computePatch(r5, sync.draft)).toEqual({ values: { units: "fahrenheit" }, secrets: {} })
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

describe("draft-driven visibility, reset and patches (settings screen)", () => {
  const form: SettingsForm = {
    fields: [
      { type: "choice", key: "STT_PROVIDER", label: "Engine", apply: "reload", default: "sherpa", source: "saved", options: [{ value: "sherpa", label: "Local" }, { value: "deepgram", label: "Deepgram" }] },
      { type: "number", key: "MODEL_SIZE", label: "Size", apply: "reload", default: 2, integer: true, source: "saved", visibleWhen: { key: "STT_PROVIDER", in: ["sherpa"] } },
      { type: "secret", key: "DEEPGRAM_API_KEY", label: "Key", apply: "reload", visibleWhen: { key: "STT_PROVIDER", in: ["deepgram"] } }
    ],
    values: { STT_PROVIDER: "sherpa", MODEL_SIZE: 3 },
    secrets: { DEEPGRAM_API_KEY: { set: false, source: "none" } },
    errors: []
  }
  const field = (key: string) => form.fields.find((f) => f.key === key)!

  it("evaluates visibleWhen against the draft (choosing Deepgram shows its key before saving)", () => {
    const d = setDraftValue(initialDraft(form), "STT_PROVIDER", "deepgram")
    const lookup = draftLookup(d, () => undefined)
    expect(fieldVisible(field("DEEPGRAM_API_KEY"), lookup)).toBe(true)
    expect(fieldVisible(field("MODEL_SIZE"), lookup)).toBe(false)
    expect(fieldVisible(field("MODEL_SIZE"), draftLookup(initialDraft(form), () => undefined))).toBe(true)
    // Keys of other sections come from the fallback.
    expect(fieldVisible(field("MODEL_SIZE"), (k) => (k === "STT_PROVIDER" ? "sherpa" : undefined))).toBe(true)
  })

  it("does not send hidden fields", () => {
    let d = setDraftValue(initialDraft(form), "MODEL_SIZE", 4)
    d = setDraftValue(d, "STT_PROVIDER", "deepgram")
    const lookup = draftLookup(d, () => undefined)
    expect(computePatch(form, d, (f) => fieldVisible(f, lookup))).toEqual({ values: { STT_PROVIDER: "deepgram" }, secrets: {} })
  })

  it("Reset to default sends null (nothing stays saved); an edit after it cancels the reset", () => {
    const reset = resetDraftValue(initialDraft(form), field("MODEL_SIZE"))
    expect(reset.values.MODEL_SIZE).toBe(2)
    expect(computePatch(form, reset)).toEqual({ values: { MODEL_SIZE: null }, secrets: {} })
    const edited = setDraftValue(reset, "MODEL_SIZE", 5)
    expect(computePatch(form, edited)).toEqual({ values: { MODEL_SIZE: 5 }, secrets: {} })
  })

  it("knows when every change needs an engine reload", () => {
    expect(onlyReloadFields(form, { values: { STT_PROVIDER: "deepgram" }, secrets: {} })).toBe(true)
    expect(onlyReloadFields(weather, { values: { units: "fahrenheit" }, secrets: {} })).toBe(false)
    expect(someReloadFields(form, { values: {}, secrets: {} })).toBe(false)
  })
})
