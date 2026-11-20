// Protocol 9 (docs/MODULES-PLAN.md §4 P1): the `unavailable` module state, tool metadata, templates and the issue
// registry messages.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { exampleHealth, exampleHouseholdSnapshotFinal, exampleUnavailableModule, serverExamples } from "../src/examples.ts"
import { AssistantTemplate, decodeClientMessage, decodeServerMessage, HealthIssue, ModuleInfo, ModuleState, PROTOCOL_VERSION, ToolInfo } from "../src/index.ts"

const decodes = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success"

describe("protocol 9", () => {
  it("is version 9: unavailable is a new member of the closed ModuleState set", () => {
    expect(PROTOCOL_VERSION).toBe(12)
    expect(decodes(ModuleState, "unavailable")).toBe(true)
    expect(decodes(ModuleInfo, exampleUnavailableModule)).toBe(true)
  })

  it("tool metadata is optional; sensitivity is household or personal", () => {
    expect(decodes(ToolInfo, { name: "t", description: "", speculative: false })).toBe(true)
    expect(decodes(ToolInfo, { name: "t", description: "", speculative: false, risk: "security", sensitivity: "personal", latency: "slow" })).toBe(true)
    expect(decodes(ToolInfo, { name: "t", description: "", speculative: false, sensitivity: "normal" })).toBe(false)
    expect(decodes(ToolInfo, { name: "t", description: "", speculative: false, risk: "dangerous" })).toBe(false)
  })

  it("a template id is <moduleId>.<id>, within the assistant's own limits", () => {
    const t = { id: "music.dj", name: "DJ", prompt: "", modules: ["music"] }
    expect(decodes(AssistantTemplate, t)).toBe(true)
    expect(decodes(AssistantTemplate, { ...t, id: "dj" })).toBe(false)
    expect(decodes(AssistantTemplate, { ...t, name: "x".repeat(33) })).toBe(false)
  })

  it("health and health.check round-trip; an issue needs a severity of the closed set", () => {
    expect(decodeServerMessage(JSON.stringify(serverExamples.health))).toMatchObject({ _tag: "Ok", message: { type: "health", health: exampleHealth } })
    expect(decodeClientMessage(JSON.stringify({ type: "health.check", requestId: "h1" }))).toMatchObject({ _tag: "Ok" })
    expect(decodes(HealthIssue, { id: "x", severity: "fatal", title: "", detail: "" })).toBe(false)
  })

  it("the snapshot example is the sequence the feed sends: a part with rows, then the empty final part naming what was cut", () => {
    const parts = [serverExamples["household.snapshot"], exampleHouseholdSnapshotFinal]
    for (const part of parts) expect(decodeServerMessage(JSON.stringify(part))).toMatchObject({ _tag: "Ok" })
    expect(parts.map((p) => [p.part, p.final, p.collections.length > 0])).toEqual([[0, false, true], [1, true, false]])
    expect(parts[0]!.truncated).toEqual([])
    expect(parts[1]!.truncated.length).toBeGreaterThan(0)
  })
})
