import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  agentClientExamples,
  agentServerExamples,
  exampleAgentForm,
  exampleLightsOnAction,
  exampleRulesField
} from "../src/agentExamples.ts"
import {
  ActionInfo,
  ClientMessageAdditions,
  ModuleInfo,
  ModuleInfoAgentFields,
  ServerMessageAdditions,
  SettingFieldV2,
  SettingsFormV2,
  SettingsPatchV2,
  TextSend,
  TextSendAgentFields,
  TraceAgentFields,
  TraceInfo,
  TraceMarkAdditions,
  TurnStart,
  TurnStartAgentFields
} from "../src/index.ts"
import { exampleWeatherModule, serverExamples } from "../src/examples.ts"

const roundTrip = <A>(schema: Schema.Codec<A, unknown>, value: A): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(Schema.encodeSync(schema)(value))))

const decodes = (schema: Schema.Codec<any, unknown>, value: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(value))

describe("agent protocol additions", () => {
  it("cover every new message type with an example", () => {
    expect(Object.keys(agentClientExamples).sort()).toEqual([...ClientMessageAdditions.discriminants].sort())
    expect(Object.keys(agentServerExamples).sort()).toEqual([...ServerMessageAdditions.discriminants].sort())
  })

  it("round-trip every example", () => {
    for (const message of Object.values(agentClientExamples)) expect(roundTrip(ClientMessageAdditions, message)).toEqual(message)
    for (const message of Object.values(agentServerExamples)) expect(roundTrip(ServerMessageAdditions, message)).toEqual(message)
    expect(roundTrip(SettingsFormV2, exampleAgentForm)).toEqual(exampleAgentForm)
    expect(roundTrip(ActionInfo, exampleLightsOnAction)).toEqual(exampleLightsOnAction)
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

  it("reject a routing.set with an id that is not an agent id", () => {
    expect(decodes(ClientMessageAdditions, { type: "routing.set", requestId: "r1", agentId: "Not An Id" })).toBe(false)
  })
})

describe("optional fields for existing messages", () => {
  const TurnStartV2 = TurnStart.mapFields((f) => ({ ...f, ...TurnStartAgentFields }))
  const TextSendV2 = TextSend.mapFields((f) => ({ ...f, ...TextSendAgentFields }))
  const ModuleInfoV2 = ModuleInfo.mapFields((f) => ({ ...f, ...ModuleInfoAgentFields }))
  const TraceInfoV2 = TraceInfo.mapFields((f) => ({
    ...f,
    ...TraceAgentFields,
    marks: f.marks.mapFields((m) => ({ ...m, ...TraceMarkAdditions }))
  }))

  it("leave v1 messages valid", () => {
    expect(decodes(TurnStartV2, serverExamples["turn.start"])).toBe(true)
    expect(decodes(TextSendV2, { type: "text.send", requestId: "r1", text: "hi", speak: true })).toBe(true)
    expect(decodes(ModuleInfoV2, exampleWeatherModule)).toBe(true)
    expect(decodes(TraceInfoV2, serverExamples["turn.end"].trace)).toBe(true)
  })

  it("carry the agent of a turn", () => {
    const start = {
      ...serverExamples["turn.start"],
      agent: { id: "jev", name: "Jev", kind: "intent" },
      routedBy: "trigger",
      agentText: "Turn on the lights in the living room."
    } as const
    expect(roundTrip(TurnStartV2, start)).toEqual(start)
    expect(decodes(TurnStartV2, { ...start, routedBy: "guess" })).toBe(false)
  })

  it("carry agent kinds and actions on a module", () => {
    const info = { ...exampleWeatherModule, id: "demo-home", kind: "capability", actions: [exampleLightsOnAction] } as const
    expect(roundTrip(ModuleInfoV2, info)).toEqual(info)
  })

  it("carry intent marks in a trace", () => {
    const trace = {
      ...serverExamples["turn.end"].trace,
      marks: { decisionSent: -270, decisionReceived: -22, actionStarted: 3, actionFinished: 61, playbackStart: 14 },
      agent: { id: "jev", kind: "intent", routedBy: "trigger" }
    } as const
    expect(roundTrip(TraceInfoV2, trace)).toEqual(trace)
  })
})
