// The extended field types on module forms (docs/MODULES-PLAN.md §4 P3): every type is described as a protocol
// `SettingField`, saved by a patch, loaded from saved values, read from the environment, and (where allowed) owned by
// an assistant; `action` and `info` have no value the owner sets; settings saved before the fields existed still load.
import { describe, expect, it } from "@effect/vitest"
import { SettingField, SettingsForm, SettingsPatch } from "@pva/protocol"
import { Result, Schema } from "effect"
import { applySettingsPatch, checkOwnValues, resolveSettings, Setting, type SettingsOf } from "../src/Settings.ts"

const spec = {
  rooms: Setting.records({
    label: "Rooms",
    env: "DEMO_ROOMS",
    itemLabel: "room",
    titleKey: "name",
    overridable: true,
    item: { name: Setting.text({ label: "Name" }), aliases: Setting.textList({ label: "Other names", maxItems: 3 }), lamps: Setting.number({ label: "Lamps", default: 1, integer: true, min: 0 }) },
    default: [{ name: "Kitchen", aliases: [], lamps: 1 }],
    check: (list) => (new Set(list.map((r) => r.name)).size === list.length ? undefined : "Two rooms have one name")
  }),
  greetings: Setting.textList({ label: "Greetings", env: "DEMO_GREETINGS", default: ["please"], overridable: true }),
  scene: Setting.combo({ label: "Scene", env: "DEMO_SCENE", default: "Cosy", options: [{ value: "Cosy", label: "Cosy" }] }),
  strict: Setting.combo({ label: "Strict", default: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], allowCustom: false }),
  state: Setting.info({ label: "Now", tone: "ok" }),
  test: Setting.action({ label: "Test", buttonLabel: "Test", requiresSaved: false }),
  name: Setting.text({ label: "Name", default: "home" })
}

const sources = (stored: Record<string, unknown> = {}, env: Record<string, string> = {}, own?: Record<string, unknown>) => ({
  stored,
  secrets: {},
  env,
  ...(own !== undefined ? { own } : {})
})

const decodes = (schema: Schema.Codec<any, unknown>, value: unknown) => Result.isSuccess(Schema.decodeUnknownResult(schema)(JSON.parse(JSON.stringify(value))))

describe("extended fields: describe, save, load, resolve per layer", () => {
  it("describes every field as a protocol field and the form as a protocol form", () => {
    const { form, value } = resolveSettings(spec, sources())
    for (const field of form.fields) expect(decodes(SettingField, field)).toBe(true)
    expect(decodes(SettingsForm, form)).toBe(true)
    expect(form.fields.map((f) => f.type)).toEqual(["records", "textList", "combo", "combo", "info", "action", "text"])
    // An info value is "" until the host fills it; an action has no value at all.
    expect(form.values.state).toBe("")
    expect(Object.hasOwn(form.values, "test")).toBe(false)
    // The module's settings carry neither.
    expect(value).toEqual({ rooms: [{ name: "Kitchen", aliases: [], lamps: 1 }], greetings: ["please"], scene: "Cosy", strict: "a", name: "home" })
    const rooms = form.fields[0]!
    expect(rooms).toMatchObject({ type: "records", itemLabel: "room", titleKey: "name", overridable: true, source: "default" })
    if (rooms.type === "records") expect(rooms.itemFields.map((f) => f.type)).toEqual(["text", "textList", "number"])
  })

  it("saves each valued type through a patch and loads it back", () => {
    const patch: SettingsPatch = {
      values: { rooms: [{ name: "Hall", aliases: [" entrance ", "Entrance"] }], greetings: ["hey", "please"], scene: " Film night ", strict: "b" },
      secrets: {}
    }
    expect(decodes(SettingsPatch, patch)).toBe(true)
    const saved = applySettingsPatch(spec, sources(), patch)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    // Normalised as the fields decode them (missing item keys take their defaults, duplicates dropped, trimmed).
    expect(saved.stored).toEqual({ rooms: [{ name: "Hall", aliases: ["entrance"], lamps: 1 }], greetings: ["hey", "please"], scene: "Film night", strict: "b" })
    const loaded = resolveSettings(spec, sources(JSON.parse(JSON.stringify(saved.stored))))
    expect(loaded.form.errors).toEqual([])
    expect(loaded.value).toMatchObject(saved.stored)
    expect(loaded.form.fields.find((f) => f.key === "rooms")?.source).toBe("saved")
  })

  it("refuses values the fields refuse, naming the record and field", () => {
    const bad = applySettingsPatch(spec, sources(), { values: { rooms: [{ name: "A" }, { name: "A" }], strict: "c" }, secrets: {} })
    expect(bad).toEqual({
      ok: false,
      errors: [{ key: "rooms", message: "Two rooms have one name" }, { key: "strict", message: "Must be one of: a, b" }]
    })
    const nested = applySettingsPatch(spec, sources(), { values: { rooms: [{ name: "A", lamps: "two" }] }, secrets: {} })
    expect(nested).toEqual({ ok: false, errors: [{ key: "rooms", message: "Room 1, Lamps: Must be a number" }] })
  })

  it("never saves or patches an action or an info value", () => {
    expect(applySettingsPatch(spec, sources(), { values: { state: "x" }, secrets: {} })).toEqual({ ok: false, errors: [{ key: "state", message: "Read-only: the server sets it" }] })
    expect(applySettingsPatch(spec, sources(), { values: { test: "x" }, secrets: {} })).toEqual({ ok: false, errors: [{ key: "test", message: "An action has no value" }] })
    // Stray saved values under those keys are dropped by the next save and ignored when loading.
    const resolved = resolveSettings(spec, sources({ state: "stale", test: true }))
    expect(resolved.form.values.state).toBe("")
    expect(resolved.form.errors).toEqual([])
    const next = applySettingsPatch(spec, sources({ state: "stale", test: true, name: "x" }), { values: {}, secrets: {} })
    expect(next.ok && next.stored).toEqual({ name: "x" })
  })

  it("reads the environment: records as JSON, text lists comma-separated; the field is locked", () => {
    const { form, value } = resolveSettings(spec, sources({ rooms: [{ name: "Saved" }] }, { DEMO_ROOMS: "[{\"name\":\"Env\",\"aliases\":[\"e\"]}]", DEMO_GREETINGS: "hi, hello", DEMO_SCENE: "Bright" }))
    expect(value).toMatchObject({ rooms: [{ name: "Env", aliases: ["e"], lamps: 1 }], greetings: ["hi", "hello"], scene: "Bright" })
    expect(form.fields.find((f) => f.key === "rooms")).toMatchObject({ source: "env-process", locked: { reason: "Set by DEMO_ROOMS in the environment" } })
    const bad = resolveSettings(spec, sources({}, { DEMO_ROOMS: "not json" }))
    expect(bad.value).toBeUndefined()
    expect(bad.form.errors[0]).toEqual({ key: "rooms", message: "DEMO_ROOMS=not json is not valid: Must be JSON: a list of objects" })
    // A field set by the environment cannot be patched.
    expect(applySettingsPatch(spec, sources({}, { DEMO_GREETINGS: "hi" }), { values: { greetings: ["x"] }, secrets: {} }).ok).toBe(false)
  })

  it("lets an assistant own an overridable records or text-list field, and nothing else", () => {
    const own = { rooms: [{ name: "Mine" }], greetings: ["yo"] }
    const { value } = resolveSettings(spec, sources({ rooms: [{ name: "Shared" }] }, {}, own))
    expect(value).toMatchObject({ rooms: [{ name: "Mine", aliases: [], lamps: 1 }], greetings: ["yo"] })
    expect(checkOwnValues(spec, own)).toEqual([])
    expect(checkOwnValues(spec, { scene: "x", state: "y", test: 1 }).map((e) => e.key)).toEqual(["scene", "state", "test"])
    expect(checkOwnValues(spec, { rooms: "kitchen" })).toEqual([{ key: "rooms", message: "Must be a list" }])
  })

  it("loads settings saved before the new fields existed, unchanged", () => {
    // What a module saved with only `name`: the new fields take their defaults; the old value stays saved.
    const before = { name: "cottage" }
    const { form, value } = resolveSettings(spec, sources(before))
    expect(form.errors).toEqual([])
    expect(value).toMatchObject({ name: "cottage", rooms: [{ name: "Kitchen", aliases: [], lamps: 1 }], greetings: ["please"] })
    const saved = applySettingsPatch(spec, sources(before), { values: { scene: "Bright" }, secrets: {} })
    expect(saved.ok && saved.stored).toEqual({ name: "cottage", scene: "Bright" })
  })

  it("types a module's settings without its buttons and info values", () => {
    const settings: SettingsOf<typeof spec> = { rooms: [], greetings: [], scene: "", strict: "a", name: "" }
    // @ts-expect-error an action has no value in the settings a module receives
    void settings.test
    expect(Object.keys(settings)).not.toContain("state")
  })
})
