import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { exampleAgentForm, exampleRulesField } from "../src/agentExamples.ts"
import { SettingFieldV2, SettingsFormV2, SettingsPatchV2 } from "../src/index.ts"
import { exampleWeatherModule } from "../src/examples.ts"

const roundTrip = <A>(schema: Schema.Codec<A, unknown>, value: A): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))))

const decodes = (schema: Schema.Codec<any, unknown>, value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(value))

describe("the extended settings field types", () => {
  it("round-trip a form that uses them", () => {
    expect(roundTrip(SettingsFormV2, exampleAgentForm)).toEqual(exampleAgentForm)
  })

  it("keep every v1 field type valid in v2", () => {
    for (const field of exampleWeatherModule.settings.fields) expect(decodes(SettingFieldV2, field)).toBe(true)
  })

  it("validate the new field types", () => {
    expect(decodes(SettingFieldV2, exampleRulesField)).toBe(true)
    // a record item field may not be a secret
    expect(decodes(SettingFieldV2, { ...exampleRulesField, itemFields: [{ type: "secret", key: "k", label: "K" }] })).toBe(false)
    // combo needs allowCustom; action needs a button label
    expect(decodes(SettingFieldV2, { type: "combo", key: "model", label: "Model", apply: "live", default: "", options: [] })).toBe(false)
    expect(decodes(SettingFieldV2, { type: "action", key: "test", label: "Test", apply: "live", requiresSaved: false })).toBe(false)
  })

  it("accept a list of records as a value and in a patch", () => {
    const rules = [{ agent: "jev", phrases: ["hey jev"], mode: "turn" }]
    expect(decodes(SettingsPatchV2, { values: { ROUTING_RULES: rules }, secrets: {} })).toBe(true)
    expect(decodes(SettingsPatchV2, { values: { ROUTING_RULES: [{ agent: { nested: true } }] }, secrets: {} })).toBe(false)
  })
})
