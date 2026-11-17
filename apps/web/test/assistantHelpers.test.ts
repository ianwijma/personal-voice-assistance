import { describe, expect, it } from "vitest"
import type { ModuleInfo, SettingsSection } from "@pva/protocol"
import { exampleAssistant, exampleDeviceType } from "@pva/protocol/examples"
import {
  accountInfo,
  accountState,
  ASSISTANT_TABS,
  copyName,
  hearingModelNames,
  isAssistantTab,
  listJoin,
  modelAfterAccountChange,
  modelChoices,
  outcomeOf,
  plural,
  quoted,
  summaryParts,
  TAB_PATHS,
  targetKey,
  targetName,
  toolCount,
  voiceWords
} from "@/lib/assistants.ts"
import { samePage } from "@/lib/settingsTree.ts"

const mod = (id: string, tools: ReadonlyArray<string>, extra: Partial<{ enabled: boolean; state: string }> = {}) =>
  ({ id, tools: tools.map((name) => ({ name, description: "", speculative: false })), enabled: true, state: "running", ...extra }) as unknown as ModuleInfo

const section = (fields: ReadonlyArray<unknown>, secrets: Record<string, { set: boolean }> = {}) =>
  ({ form: { fields, secrets } }) as unknown as SettingsSection

describe("outcomeOf: the edges of an answer", () => {
  const failed = (error?: unknown) => outcomeOf({ type: "result", requestId: "r", ok: false, ...(error !== undefined ? { error } : {}) } as never)

  it("a refusal that does not say why is an internal refusal", () => {
    expect(failed()).toEqual({ kind: "refused", code: "internal", message: "The assistant did not say why." })
  })
  it("field errors win over warnings when both come back; an empty list of either is not one", () => {
    const both = { code: "invalid_settings", message: "m", fieldErrors: [{ key: "name", message: "e" }], warnings: [{ key: null, message: "w" }] }
    expect(failed(both)).toMatchObject({ kind: "invalid", fieldErrors: [{ key: "name" }] })
    expect(failed({ code: "invalid_settings", message: "m", fieldErrors: [], warnings: [] })).toEqual({ kind: "refused", code: "invalid_settings", message: "m" })
  })
  it("stale wins over any field errors it carries", () => {
    expect(failed({ code: "stale", message: "s", fieldErrors: [{ key: "name", message: "e" }] })).toEqual({ kind: "stale", message: "s" })
  })
  it("a success without an id has no assistantId", () => {
    expect(outcomeOf({ type: "result", requestId: "r", ok: true })).toEqual({ kind: "ok", assistantId: undefined })
  })
  it("a device save's success carries the revision it made", () => {
    expect(outcomeOf({ type: "result", requestId: "r", ok: true, rev: 4 })).toEqual({ kind: "ok", assistantId: undefined, rev: 4 })
  })
})

describe("tabs", () => {
  it("only the listed tabs are tabs", () => {
    expect(isAssistantTab("model")).toBe(true)
    expect(isAssistantTab("used")).toBe(true)
    expect(isAssistantTab("nope")).toBe(false)
    expect(isAssistantTab(undefined)).toBe(false)
  })
  it("every tab has paths, and no path belongs to two tabs", () => {
    expect(Object.keys(TAB_PATHS).sort()).toEqual(ASSISTANT_TABS.map(([k]) => k).sort())
    const all = Object.values(TAB_PATHS).flat()
    expect(new Set(all).size).toBe(all.length)
  })
  it("every field of an assistant is on some tab (a new field must not go unnoticed)", () => {
    const { id: _i, rev: _r, ...fields } = exampleAssistant
    for (const key of Object.keys(fields)) expect(tabOf(key), key).toBeDefined()
  })
  const tabOf = (key: string) => ASSISTANT_TABS.map(([k]) => k).find((k) => TAB_PATHS[k].includes(key))
})

describe("language model accounts", () => {
  it("the Claude subscription takes the Claude models like the API does; the offline stand-in takes none", () => {
    expect(modelChoices("claude-subscription")).toEqual(modelChoices("anthropic"))
    expect(modelChoices("offline")).toBeUndefined()
    expect(modelAfterAccountChange("claude-subscription", "gpt-x")).toBe("claude-haiku-5-5")
    expect(modelAfterAccountChange("claude-subscription", "claude-opus-5-5")).toBe("claude-opus-5-5")
    expect(modelAfterAccountChange("openrouter", "claude-opus-5-5")).toBe("")
    expect(modelAfterAccountChange("openrouter", "vendor/model")).toBe("vendor/model")
  })
  it("accountInfo knows every account and falls back to the first for an unknown one", () => {
    expect(accountInfo("offline").title).toBe("Offline stand-in")
    expect(accountInfo("nope" as never).id).toBe("anthropic")
  })

  describe("accountState", () => {
    it("the offline stand-in is always ready", () => {
      expect(accountState("offline", [], [])).toEqual({ tone: "ok", text: "Always ready" })
    })
    it("the Anthropic API is ready when its key is set, else points at where to set it", () => {
      expect(accountState("anthropic", [section([], { ANTHROPIC_API_KEY: { set: true } })], [])).toEqual({ tone: "ok", text: "Key set" })
      expect(accountState("anthropic", [section([], { ANTHROPIC_API_KEY: { set: false } })], [])).toMatchObject({ tone: "todo", setUp: ["shared", "accounts"] })
      expect(accountState("anthropic", [section([])], [])).toMatchObject({ tone: "todo" })
    })
    it("the subscription is ready only when its module is on and running", () => {
      expect(accountState("claude-subscription", [], [mod("claude-subscription", [])])).toEqual({ tone: "ok", text: "Logged in" })
      for (const m of [mod("claude-subscription", [], { enabled: false }), mod("claude-subscription", [], { state: "starting" })]) {
        expect(accountState("claude-subscription", [], [m])).toMatchObject({ tone: "todo", setUp: ["shared", "accounts"] })
      }
      expect(accountState("claude-subscription", [], [])).toMatchObject({ tone: "todo" })
    })
    it("the accounts the server cannot build yet say so", () => {
      expect(accountState("openrouter", [], [])).toEqual({ tone: "muted", text: "Not available yet" })
      expect(accountState("home-model", [], [])).toEqual({ tone: "muted", text: "Not available yet" })
    })
  })
})

describe("naming helpers", () => {
  it("plural and listJoin", () => {
    expect(plural(1, "module")).toBe("1 module")
    expect(plural(0, "module")).toBe("0 modules")
    expect(plural(2, "reply", "replies")).toBe("2 replies")
    expect(listJoin([])).toBe("")
    expect(listJoin(["a"])).toBe("a")
    expect(listJoin(["a", "b"])).toBe("a and b")
    expect(listJoin(["a", "b", "c"])).toBe("a, b and c")
  })
  it("quoted uses typographic quotes", () => {
    expect(quoted("Hey Jeff")).toBe("“Hey Jeff”")
  })
  it("a target's key tells a type from a device with the same word", () => {
    expect(targetKey({ kind: "type", type: "x" })).toBe("type:x")
    expect(targetKey({ kind: "device", id: "x" })).toBe("device:x")
  })
  it("an unknown device type is named by its own kind", () => {
    expect(targetName({ kind: "type", type: "toaster" }, [], [exampleDeviceType])).toBe("toaster")
  })
  it("copyName counts up past taken copies, ignoring case and surrounding spaces", () => {
    expect(copyName("Jeff", ["Jeff copy", "Jeff copy 2"])).toBe("Jeff copy 3")
    expect(copyName("Jeff", ["  JEFF COPY  "])).toBe("Jeff copy 2")
    expect(copyName("A".repeat(24), [])).toBe(`${"A".repeat(24)} copy`)
  })
  // Regression: the candidate used to be cut to 32 characters AFTER the number was added, so for a name of 28 or more
  // characters every candidate was the same text and the loop never ended. The timeout makes a regression fail, not hang.
  it("copyName finds a free name for a long name whose first copy is taken", () => {
    const long = "A".repeat(30)
    const first = copyName(long, [long])
    expect(first).toHaveLength(32)
    const second = copyName(long, [long, first])
    expect(second).not.toBe(first)
    expect(second.length).toBeLessThanOrEqual(32)
    expect(second.endsWith(" copy 2")).toBe(true)
    const third = copyName(long, [long, first, second])
    expect(new Set([first, second, third]).size).toBe(3)
    expect(third.length).toBeLessThanOrEqual(32)
  }, 2000)
})

describe("the summary strip", () => {
  const modules = [mod("weather", ["weather", "forecast"]), mod("clock", ["time", "set_timer"])]

  it("voiceWords: the catalog's name when given, else the voice id's own words", () => {
    const v = (provider: string, voiceId: string) => ({ voice: { provider, voiceId } }) as never
    expect(voiceWords(v("sherpa", "en_US-lessac-medium"))).toBe("Lessac · on this machine")
    expect(voiceWords(v("sherpa", "kokoro-af_heart"))).toBe("Heart · on this machine")
    expect(voiceWords(v("elevenlabs", "abc123"))).toBe("Abc123 · elevenlabs")
    expect(voiceWords(v("sherpa", "en_US-lessac-medium"), "Amy")).toBe("Amy · on this machine")
  })

  it("toolCount: tools of the switched-on modules, minus the switched-off ones; unknown and not-running modules count none", () => {
    expect(toolCount({ modules: {} }, modules)).toBe(0)
    expect(toolCount({ modules: { weather: { on: true, offTools: [] }, clock: { on: true, offTools: ["set_timer"] } } }, modules)).toBe(3)
    expect(toolCount({ modules: { weather: { on: false, offTools: [] } } }, modules)).toBe(0)
    expect(toolCount({ modules: { gone: { on: true, offTools: [] } } }, modules)).toBe(0)
  })

  it("summaryParts: model and effort | hearing | voice | modules and tools", () => {
    const names = { hearing: (p: string) => `H:${p}` }
    expect(summaryParts(exampleAssistant, modules, names)).toEqual([
      "claude-haiku-5-5 · effort low",
      "H:nemotron-3.5 · end pause 600 ms",
      "Lessac · piper",
      "2 modules · 3 tools"
    ])
  })
  it("summaryParts: the offline stand-in has no model name, Deepgram needs no preset, one module reads singular", () => {
    const a = {
      ...exampleAssistant,
      llm: { ...exampleAssistant.llm, account: "offline" as const, model: "" },
      hearing: { ...exampleAssistant.hearing, engine: "deepgram" as const },
      modules: { clock: { on: true, offTools: ["set_timer"] }, weather: { on: false, offTools: [] } }
    }
    const parts = summaryParts(a, modules, { hearing: () => "never" })
    expect(parts[0]).toBe("offline stand-in · effort low")
    expect(parts[1]).toBe("Deepgram · end pause 600 ms")
    expect(parts[3]).toBe("1 module · 1 tool")
  })

  describe("hearingModelNames", () => {
    const choice = { key: "STT_SHERPA_MODEL", type: "choice", options: [{ value: "parakeet-v2", label: "Parakeet v2 — fast, English" }, { value: "plain", label: "Plain" }] }
    it("uses the label before ' — ', the whole label without one, and the preset itself when it is not offered", () => {
      const names = hearingModelNames([section([{ key: "OTHER", type: "text" }]), section([choice])])
      expect(names.hearing("parakeet-v2")).toBe("Parakeet v2")
      expect(names.hearing("plain")).toBe("Plain")
      expect(names.hearing("mystery")).toBe("mystery")
    })
    it("falls back to the preset when the speech section is missing or the field is not a choice", () => {
      expect(hearingModelNames([]).hearing("parakeet-v2")).toBe("parakeet-v2")
      expect(hearingModelNames([section([{ key: "STT_SHERPA_MODEL", type: "text" }])]).hearing("x")).toBe("x")
    })
  })
})

describe("samePage", () => {
  it("another tab is the same page; another assistant or category is not", () => {
    expect(samePage(["assistants", "jeff", "basics"], ["assistants", "jeff", "model"])).toBe(true)
    expect(samePage(["assistants", "jeff"], ["assistants", "jeff", "model"])).toBe(true)
    expect(samePage(["assistants", "jeff"], ["assistants", "keuken"])).toBe(false)
    expect(samePage(["assistants", "jeff"], ["devices", "jeff"])).toBe(false)
    expect(samePage([], [])).toBe(true)
  })
})
