import { describe, expect, it } from "vitest"
import type { ModuleInfo, SettingsSection } from "@pva/protocol"
import { exampleAssistantInfo as exampleAssistant, exampleHomeAssistantModule, exampleSpeechEngineSection, exampleVoiceSection, exampleWeatherModule } from "@pva/protocol/examples"
import {
  buildSettingsTree,
  describeServerPaths,
  formatSettingsHash,
  navigateSettings,
  parentPath,
  parseSettingsHash,
  resolveSettingsPath,
  type SettingsUi
} from "@/lib/settingsTree.ts"
import { keysList, lockedExplanation } from "@/lib/vault.ts"

const section = (over: Partial<SettingsSection>): SettingsSection => ({ ...exampleVoiceSection, ...over })
const without = <T extends object, K extends keyof T>(x: T, ...keys: ReadonlyArray<K>): Omit<T, K> => {
  const copy = { ...x }
  for (const k of keys) delete copy[k]
  return copy
}
const formOf = (fields: SettingsSection["form"]["fields"]): SettingsSection["form"] => ({ fields, values: {}, secrets: {}, errors: [] })
const deepgramPage = section({
  id: "stt-deepgram",
  title: "Deepgram",
  group: "speech",
  page: { id: "deepgram", title: "Deepgram" },
  order: 40,
  visibleWhen: { key: "STT_PROVIDER", in: ["deepgram"] },
  form: {
    fields: [
      { type: "secret", key: "DEEPGRAM_API_KEY", label: "Deepgram API key", apply: "reload", env: "DEEPGRAM_API_KEY" },
      { type: "number", key: "DEEPGRAM_EOT_THRESHOLD", label: "End-of-turn confidence", apply: "reload", default: 0.7, integer: false, min: 0.5, max: 1 }
    ],
    values: {},
    secrets: { DEEPGRAM_API_KEY: { set: false, source: "none" } },
    errors: []
  }
})
// The old per-assistant pages: every field moved onto the assistant, so nothing of them is shown.
const timing = section({ id: "stt-timing", title: "Turn timing", group: "speech", page: { id: "turn-timing", title: "Turn timing" }, order: 20, form: formOf([{ type: "number", key: "STT_EAGER_SILENCE_MS", label: "Pause", apply: "reload", default: 250, integer: true, min: 50, max: 2000 }]) })
const languageModel = section({
  id: "language-model",
  title: "Provider",
  group: "agents",
  page: { id: "provider", title: "Provider" },
  order: 10,
  form: formOf([
    { type: "text", key: "LLM_PROVIDER", label: "Language model", apply: "reload", default: "fake" },
    { type: "secret", key: "ANTHROPIC_API_KEY", label: "Anthropic API key", apply: "reload", visibleWhen: { key: "LLM_PROVIDER", in: ["anthropic"] } },
    { type: "text", key: "ANTHROPIC_MODEL", label: "Model", apply: "reload", default: "claude-haiku-5-5" },
    { type: "text", key: "ANTHROPIC_BASE_URL", label: "API address", apply: "reload", default: "https://api.anthropic.com", advanced: true }
  ])
})
const behaviour = section({
  id: "llm-behaviour",
  title: "Behaviour",
  group: "agents",
  page: { id: "behaviour", title: "Behaviour" },
  order: 20,
  form: formOf([
    { type: "text", key: "SYSTEM_PROMPT", label: "System prompt", apply: "live", default: "" },
    { type: "number", key: "MAX_VOICE_SESSIONS", label: "Devices talking at once", apply: "live", default: 4, integer: true, min: 1, max: 8, advanced: true }
  ])
})
const agent: ModuleInfo = { ...exampleWeatherModule, id: "claude-subscription", name: "Claude subscription", kind: "agent", group: "agents" }
const decider: ModuleInfo = { ...exampleWeatherModule, id: "typesafe", name: "TypeSafe", kind: "decider", group: "agents" }
const clientPages = [
  { group: "overview", id: "overview", title: "Overview", order: 0 },
  { group: "assistants", id: "new", title: "New assistant", order: 50, listed: false, backLabel: "Assistants", under: "all" },
  { group: "shared", id: "speech-extra", title: "Models", order: 0 },
  { group: "about", id: "about", title: "About", order: 0 }
]
const tree = buildSettingsTree({
  sections: [deepgramPage, exampleSpeechEngineSection, timing, languageModel, behaviour, exampleVoiceSection, { ...without(exampleVoiceSection, "group", "page"), id: "mystery", title: "Mystery" }],
  modules: [exampleWeatherModule, exampleHomeAssistantModule, agent],
  clientPages
})
const shared = (t = tree) => t.find((g) => g.slug === "shared")!

describe("the settings tree", () => {
  it("regroups the language model, speech, voice and module pages under Shared settings, in the mock-up's order; empty categories are hidden", () => {
    expect(tree.map((g) => g.slug)).toEqual(["overview", "assistants", "shared", "about", "other"])
    expect(shared().title).toBe("Shared settings")
    expect(shared().pages.map((p) => p.id)).toEqual(["modules", "accounts", "speech", "limits"])
    // A section without placement (an older server) gets a page of its own under Other.
    expect(tree.find((g) => g.slug === "other")!.pages.map((p) => [p.id, p.title])).toEqual([["mystery", "Mystery"]])
  })

  it("leaves out the fields that moved onto the assistant, and the pages that held only those", () => {
    const keys = (id: string) => shared().pages.find((p) => p.id === id)!.source.kind === "server" ? (shared().pages.find((p) => p.id === id)!.source as { sections: ReadonlyArray<SettingsSection> }).sections.flatMap((s) => s.form.fields.map((f) => f.key)) : []
    expect(keys("accounts")).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"])
    expect(keys("limits")).toEqual(["MAX_VOICE_SESSIONS"])
    expect(keys("speech")).toEqual(["DEEPGRAM_API_KEY"])
    // The engine, turn timing, microphone and Voices pages are gone; what stays is always shown, plainly.
    const fields = (shared().pages.find((p) => p.id === "accounts")!.source as { sections: ReadonlyArray<SettingsSection> }).sections.flatMap((s) => s.form.fields)
    expect(fields.every((f) => f.visibleWhen === undefined && f.advanced === undefined)).toBe(true)
    expect(shared().pages.every((p) => p.inUse)).toBe(true)
  })

  it("modules are on the Modules page; agent modules join the accounts; a decision module is Routing", () => {
    const sources = (id: string) => (shared().pages.find((p) => p.id === id)!.source as { moduleIds: ReadonlyArray<string> }).moduleIds
    expect(sources("modules")).toEqual(["weather", "home-assistant"])
    expect(sources("accounts")).toEqual(["claude-subscription"])
    const withRouting = buildSettingsTree({ sections: [], modules: [decider], clientPages: [] })
    expect(shared(withRouting).pages.map((p) => p.id)).toEqual(["modules", "routing"])
    // Routing is omitted without a routing section or a decision module.
    expect(shared().pages.some((p) => p.id === "routing")).toBe(false)
    expect(shared(buildSettingsTree({ sections: [], modules: [], clientPages: [] })).pages.map((p) => p.id)).toEqual(["modules"])
  })

  it("marks protected pages, pages with keys and pages with errors; a model list completes its page", () => {
    const page = (id: string) => shared().pages.find((p) => p.id === id)!
    expect(page("accounts").hasSecrets).toBe(true)
    expect(page("speech").hasSecrets).toBe(true)
    expect(page("speech").extra).toBe("speech-extra")
    expect(page("modules")).toMatchObject({ protected: true, hasSecrets: true, hasErrors: true })
    expect(tree.find((g) => g.slug === "shared")!.pages.some((p) => p.id === "speech-extra")).toBe(false)
  })

  it("an unlisted page can stay under a listed one in the navigation (the wizard)", () => {
    const wizard = tree.find((g) => g.slug === "assistants")!.pages.find((p) => p.id === "new")!
    expect(wizard).toMatchObject({ listed: false, under: "all", backLabel: "Assistants" })
  })

  it("sections that share a page are stacked on one page", () => {
    const a = section({ id: "a", title: "A", group: "diagnostics", page: { id: "shared", title: "Shared" }, order: 5 })
    const b = section({ id: "b", title: "B", group: "diagnostics", page: { id: "shared", title: "Shared" }, order: 6 })
    const pages = buildSettingsTree({ sections: [a, b], modules: [], clientPages: [] }).find((g) => g.slug === "diagnostics")!.pages
    expect(pages).toHaveLength(1)
    expect(pages[0]!.source).toEqual({ kind: "server", sections: [a, b], moduleIds: [] })
  })

  it("names the pages of reloadPendingFor", () => {
    expect(describeServerPaths(tree, ["agents/provider", "speech/nope", "agents/claude-subscription", "speech/deepgram"])).toEqual([
      { label: "Shared settings › Language model accounts", path: ["shared", "accounts"] },
      { label: "Shared settings › Speech recognition models", path: ["shared", "speech"] }
    ])
  })
})

describe("paths", () => {
  it("parse and format deep links", () => {
    expect(parseSettingsHash("#settings")).toEqual([])
    expect(parseSettingsHash("#settings/")).toEqual([])
    expect(parseSettingsHash("#settings/shared/accounts")).toEqual(["shared", "accounts"])
    // A third part is an assistant's tab; nothing after it counts.
    expect(parseSettingsHash("#settings/assistants/jeff/model")).toEqual(["assistants", "jeff", "model"])
    expect(parseSettingsHash("#settings/assistants/new/3/more")).toEqual(["assistants", "new", "3"])
    expect(parseSettingsHash("#settingsx")).toBeUndefined()
    expect(parseSettingsHash("")).toBeUndefined()
    expect(formatSettingsHash(["shared", "accounts"])).toBe("#settings/shared/accounts")
    expect(formatSettingsHash([])).toBe("#settings")
  })

  it("resolve: a wide screen always shows a page; a phone drills down", () => {
    expect(resolveSettingsPath(tree, [], true).page?.id).toBe("overview")
    expect(resolveSettingsPath(tree, ["shared"], true).page?.id).toBe("modules")
    expect(resolveSettingsPath(tree, ["shared", "speech"], true).page?.id).toBe("speech")
    expect(resolveSettingsPath(tree, ["nowhere"], true).group?.slug).toBe("overview")
    expect(resolveSettingsPath(tree, [], false)).toEqual({ group: undefined, page: undefined })
    expect(resolveSettingsPath(tree, ["shared"], false).page).toBeUndefined()
    expect(resolveSettingsPath(tree, ["about"], false).page?.id).toBe("about") // a category with one page opens it
    expect(resolveSettingsPath(tree, ["shared", "gone"], false).page).toBeUndefined()
    // The wizard is a page of Assistants, reached by its path, though it is not listed.
    expect(resolveSettingsPath(tree, ["assistants", "new", "4"], true).page?.id).toBe("new")
  })

  it("back goes up one level on a phone (a one-page category to the top); a wide screen closes", () => {
    expect(parentPath(tree, ["shared", "accounts"], false)).toEqual(["shared"])
    expect(parentPath(tree, ["shared"], false)).toEqual([])
    expect(parentPath(tree, ["about"], false)).toEqual([])
    expect(parentPath(tree, [], false)).toBeUndefined()
    expect(parentPath(tree, ["shared", "accounts"], true)).toBeUndefined()
    expect(parentPath(tree, ["assistants", "new", "2"], false)).toEqual(["assistants"])
  })
})

describe("leaving a page with unsaved edits", () => {
  const ui: SettingsUi = { settingsOpen: true, settingsPath: ["shared", "accounts"], settingsDirty: false }
  it("navigates at once when there is nothing to lose", () => {
    expect(navigateSettings(ui, ["assistants"])).toEqual({ settingsOpen: true, settingsPath: ["assistants"], settingsLeave: undefined, settingsDirty: false })
    expect(navigateSettings(ui, "close")).toEqual({ settingsOpen: false, settingsDirty: false, settingsLeave: undefined })
  })
  it("holds the navigation for 'Leave without saving?', and applies it once confirmed", () => {
    const dirty = { ...ui, settingsDirty: true }
    expect(navigateSettings(dirty, ["assistants"])).toEqual({ settingsLeave: ["assistants"] })
    expect(navigateSettings(dirty, "close")).toEqual({ settingsLeave: "close" })
    expect(navigateSettings(dirty, ["assistants"], true)).toMatchObject({ settingsPath: ["assistants"], settingsDirty: false, settingsLeave: undefined })
    // Staying on the same page is not leaving it.
    expect(navigateSettings(dirty, ["shared", "accounts"])).toEqual({ settingsOpen: true, settingsPath: ["shared", "accounts"], settingsLeave: undefined })
  })
})

describe("keys", () => {
  it("lists every key once with the pages that use it", () => {
    const keys = keysList(tree, { "home-assistant": exampleHomeAssistantModule, weather: exampleWeatherModule, [agent.id]: agent })
    expect(keys.map((k) => [k.id, k.env, k.state.set])).toEqual([
      ["home-assistant.token", "HOME_ASSISTANT_TOKEN", true],
      ["ANTHROPIC_API_KEY", undefined, false],
      ["DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY", false]
    ])
    expect(keys[2]!.usedBy).toEqual([{ title: "Shared settings › Speech recognition models", path: ["shared", "speech"] }])
    expect(keys[0]!.label).toBe("Home Assistant: Access token")
  })
  it("says why the keys are locked", () => {
    expect(lockedExplanation({ state: "locked", admin: false, lockReason: "manual" })).toMatch(/^The keys were locked from a page \(Lock now\)/)
    expect(lockedExplanation({ state: "locked", admin: false, lockReason: "start" })).toMatch(/^The assistant was restarted/)
    expect(lockedExplanation({ state: "locked", admin: false })).toMatch(/^The keys are locked\./)
  })
})

describe("the Overview checklist", () => {
  it("says what works and what needs doing, with the page that fixes it", async () => {
    const { reducer, initialState } = await import("@/lib/state.ts")
    const { openChecklistItems, setupChecklist } = await import("@/lib/setupChecklist.ts")
    const { serverExamples } = await import("@pva/protocol/examples")
    const withEnv = reducer(reducer(initialState, serverExamples.welcome), serverExamples["admin.snapshot"])
    // The example has a key still in .env: one open item, until it moves.
    expect(setupChecklist(withEnv).find((i) => i.id === "env")).toMatchObject({ ok: false, text: "1 setting is still in .env (they cannot be changed here)", action: { path: ["diagnostics", "overrides"] } })
    const s = reducer(withEnv, { type: "env", env: { files: [], entries: [] } })
    expect(setupChecklist(s).map((i) => i.id)).toEqual(["assistants", "llm", "stt", "voice", "vault"])
    // No assistant yet: nobody answers; the item opens the wizard.
    expect(setupChecklist(s).find((i) => i.id === "assistants")).toMatchObject({ ok: false, action: { path: ["assistants", "new", "1"] } })
    const named = reducer(s, { type: "assistants", assistants: [{ ...exampleAssistant, name: "Jeff", on: true }, { ...exampleAssistant, id: "t3", name: "T3", on: false }] })
    expect(setupChecklist(named).find((i) => i.id === "assistants")).toMatchObject({ ok: true, text: "Assistants: Jeff and T3, 1 switched on" })
    expect(setupChecklist(named).find((i) => i.id === "voice")).toMatchObject({ ok: true })
    const locked = reducer(named, { type: "vault", vault: { state: "locked", admin: false } })
    const items = setupChecklist(locked)
    expect(items.find((i) => i.id === "vault")).toMatchObject({ ok: false, text: "Key vault: locked", action: { label: "Unlock" } })
    expect(items.find((i) => i.id === "llm")).toMatchObject({ ok: false, action: { path: ["shared", "accounts"] } })
    expect(openChecklistItems(locked)).toBe(2)
  })
})
