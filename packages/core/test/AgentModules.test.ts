import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { defineAgent, defineDecider, type ExtendedModuleInstance } from "../src/ModuleContributions.ts"
import { Setting } from "../src/Settings.ts"
import { SettingExtra } from "../src/SettingsExtra.ts"

describe("SettingExtra.textList", () => {
  const aliases = SettingExtra.textList({ label: "Aliases", maxItems: 3, itemMaxLength: 10 })
  it("trims, drops empty items and duplicates ignoring case", () => {
    expect(aliases.decode([" hey jeff ", "", "Hey Jeff", "hey jef"])).toEqual({ ok: true, value: ["hey jeff", "hey jef"] })
  })
  it("enforces limits", () => {
    expect(aliases.decode(["a", "b", "c", "d"])).toEqual({ ok: false, error: "At most 3 items" })
    expect(aliases.decode(["far too long here"]).ok).toBe(false)
    expect(aliases.decode("hey").ok).toBe(false)
  })
  it("reads a comma-separated environment value", () => {
    expect(aliases.fromEnv("hey jev, hey jeff")).toEqual({ ok: true, value: ["hey jev", "hey jeff"] })
  })
})

describe("SettingExtra.records", () => {
  const rules = SettingExtra.records({
    label: "Trigger phrases",
    env: "ROUTING_RULES",
    itemLabel: "rule",
    titleKey: "agent",
    orderable: true,
    item: {
      agent: Setting.choice({ label: "Agent", options: [{ value: "jev", label: "Jev" }, { value: "anthropic", label: "Claude (API)" }], default: "jev" }),
      phrases: SettingExtra.textList({ label: "Phrases", maxItems: 10 }),
      mode: Setting.choice({ label: "Applies to", options: [{ value: "turn", label: "That sentence" }, { value: "conversation", label: "Following sentences too" }], default: "turn" })
    },
    check: (list) => (list.some((r) => r.phrases.length === 0) ? "Every rule needs at least one phrase" : undefined)
  })

  it("fills missing item keys with defaults and drops unknown keys", () => {
    expect(rules.decode([{ phrases: ["hey jev"], colour: "red" }])).toEqual({ ok: true, value: [{ agent: "jev", phrases: ["hey jev"], mode: "turn" }] })
  })

  it("names the record and field of an invalid value", () => {
    expect(rules.decode([{ phrases: ["a"] }, { agent: "nobody", phrases: ["b"] }])).toEqual({
      ok: false,
      error: "Rule 2, Agent: Must be one of: jev, anthropic"
    })
    expect(rules.decode([{ agent: "jev", phrases: [] }])).toEqual({ ok: false, error: "Every rule needs at least one phrase" })
  })

  it("reads JSON from the environment", () => {
    expect(rules.fromEnv("[{\"agent\":\"anthropic\",\"phrases\":[\"hey claude\"],\"mode\":\"conversation\"}]").ok).toBe(true)
    expect(rules.fromEnv("hey claude")).toEqual({ ok: false, error: "Must be JSON: a list of objects" })
  })

  it("describes its item fields without apply, locked or advanced", () => {
    const field = rules.describe("ROUTING_RULES")
    assert.strictEqual(field.type, "records")
    if (field.type !== "records") return
    expect(field.itemFields.map((f) => [f.key, f.type])).toEqual([["agent", "choice"], ["phrases", "textList"], ["mode", "choice"]])
    expect(Object.keys(field.itemFields[0]!)).not.toContain("apply")
    expect(field).toMatchObject({ itemLabel: "rule", titleKey: "agent", orderable: true, maxItems: 50 })
  })

  it("refuses secret item fields", () => {
    expect(() => SettingExtra.records({ label: "x", itemLabel: "x", titleKey: "k", item: { k: Setting.secret({ label: "K" }) as never } })).toThrow()
  })
})

describe("SettingExtra.combo, action, info", () => {
  it("combo accepts any non-empty name unless restricted", () => {
    const model = SettingExtra.combo({ label: "Model", default: "claude-haiku-5-5", options: [{ value: "claude-haiku-5-5", label: "Haiku" }] })
    expect(model.decode(" gpt-6-luna ")).toEqual({ ok: true, value: "gpt-6-luna" })
    expect(model.decode("").ok).toBe(false)
    const fixed = SettingExtra.combo({ label: "Model", default: "a", options: [{ value: "a", label: "A" }], allowCustom: false })
    expect(fixed.decode("b").ok).toBe(false)
    expect(model.describe("model")).toMatchObject({ type: "combo", allowCustom: true, options: [{ value: "claude-haiku-5-5", label: "Haiku" }] })
  })

  it("action and info have no editable value", () => {
    const test = SettingExtra.action({ label: "Test", buttonLabel: "Send a test message" })
    expect(test.value).toBe("none")
    expect(test.describe("test")).toEqual({ type: "action", key: "test", label: "Test", apply: "live", buttonLabel: "Send a test message", requiresSaved: true })
    expect(test.decode("x").ok).toBe(false)
    const info = SettingExtra.info({ label: "Login", tone: "ok" })
    expect(info.value).toBe("readOnly")
    expect(info.decode("x").ok).toBe(false)
  })
})

describe("defineAgent and defineDecider", () => {
  it.effect("start an agent module that contributes one agent with defaults by kind", () =>
    Effect.gen(function*() {
      const harness = defineAgent({
        id: "claude-subscription",
        name: "Claude subscription",
        description: "Your Claude plan through Claude Code.",
        kind: "harness",
        settings: { model: Setting.text({ label: "Model", default: "claude-haiku-5-5" }) },
        start: ({ settings }) =>
          Effect.succeed({ systemPrompt: "", turn: () => Stream.make({ _tag: "TextDelta" as const, text: settings.model }) })
      })
      expect(harness).toMatchObject({ id: "claude-subscription", kind: "agent", agentKind: "harness", enabledByDefault: false })
      const instance: ExtendedModuleInstance = yield* Effect.scoped(harness.start({ settings: { model: "claude-haiku-5-5" }, setStatus: () => {} }))
      const agent = instance.agents![0]!
      expect(agent).toMatchObject({ id: "claude-subscription", name: "Claude subscription", kind: "harness", speculate: false, firstEventTimeoutMs: 8_000 })
      expect(agent.systemPrompt).toBeUndefined() // empty = the global prompt
    }))

  it.effect("start a decider module that contributes one provider", () =>
    Effect.gen(function*() {
      const keywords = defineDecider({
        id: "keywords",
        name: "Offline keywords",
        description: "Matches words locally.",
        enabledByDefault: true,
        start: () => Effect.succeed({ location: "local" as const, decide: () => Effect.succeed({ answers: {} }) })
      })
      expect(keywords.kind).toBe("decider")
      const instance: ExtendedModuleInstance = yield* Effect.scoped(keywords.start({ settings: {}, setStatus: () => {} }))
      expect(instance.deciders?.map((d) => [d.id, d.name, d.location])).toEqual([["keywords", "Offline keywords", "local"]])
    }))
})
