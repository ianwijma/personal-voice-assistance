import { describe, expect, it } from "vitest"
import type { ModuleInfo, SettingsSection } from "@pva/protocol"
import { exampleHomeAssistantModule, exampleSpeechEngineSection, exampleVoiceSection, exampleWeatherModule } from "@pva/protocol/examples"
import {
  buildSettingsTree,
  describeServerPaths,
  formatSettingsHash,
  moduleGroup,
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
const deepgramPage = section({
  id: "stt-deepgram",
  title: "Deepgram",
  group: "speech",
  page: { id: "deepgram", title: "Deepgram" },
  order: 40,
  visibleWhen: { key: "STT_PROVIDER", in: ["deepgram"] },
  form: {
    fields: [{ type: "secret", key: "DEEPGRAM_API_KEY", label: "Deepgram API key", apply: "reload", env: "DEEPGRAM_API_KEY" }],
    values: {},
    secrets: { DEEPGRAM_API_KEY: { set: false, source: "none" } },
    errors: []
  }
})
const timing = section({ id: "stt-timing", title: "Turn timing", group: "speech", page: { id: "turn-timing", title: "Turn timing" }, order: 20, visibleWhen: { key: "STT_PROVIDER", in: ["sherpa"] } })
const agent: ModuleInfo = { ...exampleWeatherModule, id: "claude-subscription", name: "Claude subscription", kind: "agent", group: "agents" }
const clientPages = [
  { group: "overview", id: "overview", title: "Overview", order: 0 },
  { group: "speech", id: "models", title: "Speech models", order: 50 },
  { group: "about", id: "about", title: "About", order: 0 }
]
const tree = buildSettingsTree({
  sections: [deepgramPage, exampleSpeechEngineSection, timing, exampleVoiceSection, { ...without(exampleVoiceSection, "group", "page"), id: "mystery", title: "Mystery" }],
  modules: [exampleWeatherModule, exampleHomeAssistantModule, agent],
  clientPages
})

describe("the settings tree", () => {
  it("places sections and modules by the server's data, in the fixed category order; empty categories are hidden", () => {
    expect(tree.map((g) => g.slug)).toEqual(["overview", "language-model", "speech", "voices", "modules", "about", "other"])
    const speech = tree.find((g) => g.slug === "speech")!
    expect(speech.pages.map((p) => p.id)).toEqual(["engine", "turn-timing", "deepgram", "models"])
    expect(tree.find((g) => g.slug === "modules")!.pages.map((p) => p.id)).toEqual(["weather", "home-assistant"])
    expect(tree.find((g) => g.slug === "language-model")!.pages.map((p) => p.id)).toEqual(["claude-subscription"])
    // A section without placement (an older server) gets a page of its own under Other.
    expect(tree.find((g) => g.slug === "other")!.pages.map((p) => [p.id, p.title])).toEqual([["mystery", "Mystery"]])
  })

  it("marks pages not in use (by the saved values), protected pages, pages with keys and pages with errors", () => {
    const speech = tree.find((g) => g.slug === "speech")!
    const page = (id: string) => speech.pages.find((p) => p.id === id)!
    // The example saved STT_PROVIDER = deepgram: the Deepgram page is in use, turn timing is not.
    expect(page("deepgram").inUse).toBe(true)
    expect(page("turn-timing").inUse).toBe(false)
    expect(page("engine").protected).toBe(true)
    expect(page("deepgram").hasSecrets).toBe(true)
    const ha = tree.find((g) => g.slug === "modules")!.pages.find((p) => p.id === "home-assistant")!
    expect(ha).toMatchObject({ protected: true, hasSecrets: true, hasErrors: true })
  })

  it("sections that share a page are stacked on one page", () => {
    const a = section({ id: "a", title: "A", group: "voices", page: { id: "shared", title: "Shared" }, order: 5 })
    const b = section({ id: "b", title: "B", group: "voices", page: { id: "shared", title: "Shared" }, order: 6 })
    const shared = buildSettingsTree({ sections: [a, b], modules: [], clientPages: [] }).find((g) => g.slug === "voices")!.pages
    expect(shared).toHaveLength(1)
    expect(shared[0]!.source).toEqual({ kind: "sections", sections: [a, b] })
  })

  it("a module's category comes from its group, else its kind", () => {
    expect(moduleGroup(agent)).toBe("language-model")
    expect(moduleGroup(without(agent, "group"))).toBe("language-model")
    expect(moduleGroup(without(exampleWeatherModule, "group", "kind"))).toBe("modules")
  })

  it("names the pages of reloadPendingFor", () => {
    expect(describeServerPaths(tree, ["speech/engine", "speech/nope", "agents/claude-subscription"])).toEqual([
      { label: "Speech recognition › Engine", path: ["speech", "engine"] },
      { label: "Language model › Claude subscription", path: ["language-model", "claude-subscription"] }
    ])
  })
})

describe("paths", () => {
  it("parse and format deep links", () => {
    expect(parseSettingsHash("#settings")).toEqual([])
    expect(parseSettingsHash("#settings/")).toEqual([])
    expect(parseSettingsHash("#settings/speech/engine")).toEqual(["speech", "engine"])
    expect(parseSettingsHash("#settings/modules/weather/extra")).toEqual(["modules", "weather"])
    expect(parseSettingsHash("#settingsx")).toBeUndefined()
    expect(parseSettingsHash("")).toBeUndefined()
    expect(formatSettingsHash(["speech", "engine"])).toBe("#settings/speech/engine")
    expect(formatSettingsHash([])).toBe("#settings")
  })

  it("resolve: a wide screen always shows a page; a phone drills down", () => {
    expect(resolveSettingsPath(tree, [], true).page?.id).toBe("overview")
    expect(resolveSettingsPath(tree, ["speech"], true).page?.id).toBe("engine")
    expect(resolveSettingsPath(tree, ["speech", "deepgram"], true).page?.id).toBe("deepgram")
    expect(resolveSettingsPath(tree, ["nowhere"], true).group?.slug).toBe("overview")
    expect(resolveSettingsPath(tree, [], false)).toEqual({ group: undefined, page: undefined })
    expect(resolveSettingsPath(tree, ["speech"], false).page).toBeUndefined()
    expect(resolveSettingsPath(tree, ["about"], false).page?.id).toBe("about") // a category with one page opens it
    expect(resolveSettingsPath(tree, ["speech", "gone"], false).page).toBeUndefined()
  })

  it("back goes up one level on a phone (a one-page category to the top); a wide screen closes", () => {
    expect(parentPath(tree, ["speech", "engine"], false)).toEqual(["speech"])
    expect(parentPath(tree, ["speech"], false)).toEqual([])
    expect(parentPath(tree, ["about"], false)).toEqual([])
    expect(parentPath(tree, [], false)).toBeUndefined()
    expect(parentPath(tree, ["speech", "engine"], true)).toBeUndefined()
  })
})

describe("leaving a page with unsaved edits", () => {
  const ui: SettingsUi = { settingsOpen: true, settingsPath: ["speech", "engine"], settingsDirty: false }
  it("navigates at once when there is nothing to lose", () => {
    expect(navigateSettings(ui, ["voices"])).toEqual({ settingsOpen: true, settingsPath: ["voices"], settingsLeave: undefined, settingsDirty: false })
    expect(navigateSettings(ui, "close")).toEqual({ settingsOpen: false, settingsDirty: false, settingsLeave: undefined })
  })
  it("holds the navigation for 'Leave without saving?', and applies it once confirmed", () => {
    const dirty = { ...ui, settingsDirty: true }
    expect(navigateSettings(dirty, ["voices"])).toEqual({ settingsLeave: ["voices"] })
    expect(navigateSettings(dirty, "close")).toEqual({ settingsLeave: "close" })
    expect(navigateSettings(dirty, ["voices"], true)).toMatchObject({ settingsPath: ["voices"], settingsDirty: false, settingsLeave: undefined })
    // Staying on the same page is not leaving it.
    expect(navigateSettings(dirty, ["speech", "engine"])).toEqual({ settingsOpen: true, settingsPath: ["speech", "engine"], settingsLeave: undefined })
  })
})

describe("keys", () => {
  it("lists every key once with the pages that use it", () => {
    const keys = keysList(tree, { "home-assistant": exampleHomeAssistantModule, weather: exampleWeatherModule, [agent.id]: agent })
    expect(keys.map((k) => [k.id, k.env, k.state.set])).toEqual([
      ["DEEPGRAM_API_KEY", "DEEPGRAM_API_KEY", false],
      ["home-assistant.token", "HOME_ASSISTANT_TOKEN", true]
    ])
    expect(keys[0]!.usedBy).toEqual([{ title: "Speech recognition › Deepgram", path: ["speech", "deepgram"] }])
    expect(keys[1]!.label).toBe("Home Assistant: Access token")
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
    expect(setupChecklist(s).map((i) => [i.id, i.ok])).toEqual([["llm", true], ["stt", true], ["voice", true], ["vault", true]])
    expect(openChecklistItems(s)).toBe(0)
    const fake = reducer(s, { type: "engine", engine: { ...s.engine, engines: s.engine.engines.map((e) => (e.stage === "llm" ? { ...e, provider: "fake" } : e)) } })
    const locked = reducer(fake, { type: "vault", vault: { state: "locked", admin: false } })
    const items = setupChecklist(locked)
    expect(items.find((i) => i.id === "llm")).toMatchObject({ ok: false, action: { path: ["language-model", "provider"] } })
    expect(items.find((i) => i.id === "vault")).toMatchObject({ ok: false, text: "Key vault: locked", action: { label: "Unlock" } })
    expect(openChecklistItems(locked)).toBe(2)
  })
})
