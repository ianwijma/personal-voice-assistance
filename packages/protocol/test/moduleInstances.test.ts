// The wire shapes added for module instances per assistant (docs/ASSISTANTS.md §2.6, §3): `ModuleInfo.instances` and
// a field's `overridable` flag. Older peers send neither, so both are optional; the rest stays strict.
import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { exampleWeatherModule } from "../src/examples.ts"
import { ModuleInfo, ModuleInstanceInfo, SettingField } from "../src/index.ts"

const decodes = (schema: Schema.Codec<any, unknown>, value: unknown): boolean => Result.isSuccess(Schema.decodeUnknownResult(schema)(value))
const roundTrip = <A>(schema: Schema.Codec<A, unknown>, value: A): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))))

describe("module instances on the wire", () => {
  it("a module without instances stays valid (an older server), and with instances it round-trips", () => {
    expect(exampleWeatherModule.instances).toBeUndefined()
    const info: ModuleInfo = {
      ...exampleWeatherModule,
      instances: [
        { assistants: ["alpha", "bravo"], own: [], state: "running" },
        { assistants: ["charlie"], own: ["units"], state: "error", error: "Weather could not start", status: { text: "Failed", tone: "error" } }
      ]
    }
    expect(roundTrip(ModuleInfo, info)).toEqual(info)
  })

  it("an instance needs its assistants, own fields and a known state", () => {
    const ok = { assistants: ["alpha"], own: ["units"], state: "running" }
    expect(decodes(ModuleInstanceInfo, ok)).toBe(true)
    expect(decodes(ModuleInstanceInfo, { ...ok, state: "paused" })).toBe(false)
    expect(decodes(ModuleInstanceInfo, { own: [], state: "running" })).toBe(false)
    expect(decodes(ModuleInstanceInfo, { assistants: ["alpha"], state: "running" })).toBe(false)
    expect(decodes(ModuleInstanceInfo, { ...ok, assistants: [1] })).toBe(false)
    expect(decodes(ModuleInstanceInfo, { ...ok, status: { text: "x".repeat(121), tone: "ok" } })).toBe(false)
  })

  it("a field's overridable flag is optional and boolean", () => {
    const field = exampleWeatherModule.settings.fields[0]!
    expect(decodes(SettingField, field)).toBe(true)
    expect(roundTrip(SettingField, { ...field, overridable: true })).toEqual({ ...field, overridable: true })
    expect(decodes(SettingField, { ...field, overridable: "yes" })).toBe(false)
  })
})
