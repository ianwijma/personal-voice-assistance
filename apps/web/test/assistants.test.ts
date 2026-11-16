import { describe, expect, it } from "vitest"
import { assistantsServerExamples, exampleAdminSnapshot, exampleAssistantInfo, exampleDeviceType, serverExamples } from "@pva/protocol/examples"
import {
  accountNotAvailableYet,
  blankAssistantBody,
  copyName,
  deepEqual,
  errorsFor,
  getPath,
  modelAfterAccountChange,
  outcomeOf,
  setPath,
  tabOfPath,
  targetName,
  toAssistant,
  toBody
} from "@/lib/assistants.ts"
import { buildSettingsTree, formatSettingsHash, navigateSettings, parentPath, parseSettingsHash, resolveSettingsPath, type SettingsUi } from "@/lib/settingsTree.ts"
import { type Action, type ClientState, initialState, reducer } from "@/lib/state.ts"

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)
const loggedIn = { ...serverExamples.welcome, snapshot: { ...serverExamples.welcome.snapshot, admin: { enabled: true, loggedIn: true } } }

describe("assistant state", () => {
  it("the admin snapshot and the pushes set the assistants and device types; logging out empties them", () => {
    let s = run([loggedIn, { type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, assistants: [exampleAssistantInfo], deviceTypes: [exampleDeviceType] } }])
    expect(s.assistants).toEqual([exampleAssistantInfo])
    expect(s.deviceTypes).toEqual([exampleDeviceType])
    s = reducer(s, { ...assistantsServerExamples.assistants, assistants: [] })
    expect(s.assistants).toEqual([])
    s = reducer(s, assistantsServerExamples["device.types"])
    expect(s.deviceTypes).toEqual([exampleDeviceType])
    s = reducer(s, { type: "admin.state", admin: { enabled: true, loggedIn: false, endReason: "logout" } })
    expect(s.assistants).toEqual([])
    expect(s.deviceTypes).toEqual([])
  })

  it("an older server's snapshot without them leaves empty lists", () => {
    const { assistants: _a, deviceTypes: _d, ...old } = exampleAdminSnapshot
    expect(run([loggedIn, { type: "admin.snapshot", snapshot: old }]).assistants).toEqual([])
  })
})

describe("results of the assistant messages", () => {
  const result = (error?: Parameters<typeof outcomeOf>[0]["error"], assistantId?: string) =>
    outcomeOf({ type: "result", requestId: "r1", ok: error === undefined, ...(error !== undefined ? { error } : {}), ...(assistantId !== undefined ? { assistantId } : {}) })

  it("ok (with the id a create made), stale, field errors by dotted path, warnings, other refusals", () => {
    expect(result(undefined, "mia")).toEqual({ kind: "ok", assistantId: "mia" })
    expect(result({ code: "stale", message: "Jeff changed." })).toEqual({ kind: "stale", message: "Jeff changed." })
    expect(result({ code: "invalid_settings", message: "x", fieldErrors: [{ key: "hearing.finalSilenceMs", message: "Longer." }] })).toMatchObject({ kind: "invalid", fieldErrors: [{ key: "hearing.finalSilenceMs" }] })
    expect(result({ code: "invalid_settings", message: "Check.", warnings: [{ key: null, message: "w" }] })).toMatchObject({ kind: "warnings" })
    expect(result({ code: "locked", message: "Unlock." })).toEqual({ kind: "refused", code: "locked", message: "Unlock." })
  })

  it("errorsFor takes the field's own errors and those of its children", () => {
    const errors = [{ key: "llm.model", message: "a" }, { key: "llm", message: "b" }, { key: "name", message: "c" }, { key: null, message: "d" }]
    expect(errorsFor(errors, "llm")).toEqual(["a", "b"])
    expect(errorsFor(errors, "llm.model")).toEqual(["a"])
    expect(errorsFor(errors, "llm.mod")).toEqual([])
  })

  it("a field's tab, from its path", () => {
    expect(tabOfPath("llm.maxTokens")).toBe("model")
    expect(tabOfPath("hearing.deepgram.eotThreshold")).toBe("hearing")
    expect(tabOfPath("modules.clock.own.locale")).toBe("modules")
    expect(tabOfPath("name")).toBe("basics")
    expect(tabOfPath("nameless")).toBeUndefined()
  })
})

describe("plain-data paths", () => {
  const a = { llm: { model: "m", effort: "low" }, name: "x" }
  it("get and set a dotted path without changing the original", () => {
    expect(getPath(a, "llm.model")).toBe("m")
    expect(getPath(a, "llm.nope.deeper")).toBeUndefined()
    const b = setPath(a, "llm.effort", "high")
    expect(b).toEqual({ llm: { model: "m", effort: "high" }, name: "x" })
    expect(a.llm.effort).toBe("low")
    expect(setPath({}, "a.b.c", 1)).toEqual({ a: { b: { c: 1 } } })
  })
  it("deepEqual ignores key order and tells arrays from objects", () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual([], {})).toBe(false)
  })
  it("an assistants entry as the server stores it: without usedOn, resources and problems", () => {
    expect(Object.keys(toAssistant(exampleAssistantInfo))).not.toContain("usedOn")
    expect(Object.keys(toBody(exampleAssistantInfo))).not.toContain("rev")
  })
})

describe("accounts, names and new assistants", () => {
  it("a model list follows the account", () => {
    expect(modelAfterAccountChange("offline", "claude-haiku-5-5")).toBe("")
    expect(modelAfterAccountChange("anthropic", "claude-sonnet-5-5")).toBe("claude-sonnet-5-5")
    expect(modelAfterAccountChange("anthropic", "qwen3-14b")).toBe("claude-haiku-5-5")
    expect(modelAfterAccountChange("home-model", "claude-haiku-5-5")).toBe("")
    expect(modelAfterAccountChange("home-model", "qwen3-14b")).toBe("qwen3-14b")
    expect(accountNotAvailableYet("openrouter")).toBe(true)
    expect(accountNotAvailableYet("anthropic")).toBe(false)
  })
  it("copy names are unique, case-insensitively, and fit the limit", () => {
    expect(copyName("Jeff", ["Jeff"])).toBe("Jeff copy")
    expect(copyName("Jeff", ["Jeff", "jeff COPY"])).toBe("Jeff copy 2")
    expect(copyName("A".repeat(32), [])).toHaveLength(32)
  })
  it("a blank assistant is complete and valid by the protocol's bounds", () => {
    const body = blankAssistantBody("Mia")
    expect(body).toMatchObject({ name: "Mia", on: true, confirmActions: "off", modules: {} })
    expect(body.hearing.finalSilenceMs).toBeGreaterThan(body.hearing.eagerSilenceMs)
    expect(blankAssistantBody("Mia", exampleAssistantInfo).llm).toEqual(exampleAssistantInfo.llm)
  })
  it("targets are named for people", () => {
    expect(targetName({ kind: "type", type: "web-voice" }, [], [exampleDeviceType])).toBe(`Every ${exampleDeviceType.one}`)
    expect(targetName({ kind: "device", id: "d1" }, [{ id: "d1", name: "Desk" }], [])).toBe("Desk")
    expect(targetName({ kind: "device", id: "gone" }, [], [])).toBe("gone")
  })
})

describe("the assistants pages in the navigation", () => {
  const pages = [
    { group: "assistants", id: "all", title: "All assistants", order: 0 },
    { group: "assistants", id: "assistant", title: "Assistant", order: 100, perItem: true }
  ]
  const tree = buildSettingsTree({
    sections: [],
    modules: [],
    clientPages: pages,
    assistants: [{ id: "jeff", name: "Jeff", purpose: "Everyday.", on: true }, { id: "keuken", name: "Keuken", purpose: "", on: false }]
  })
  const group = tree.find((g) => g.slug === "assistants")!

  it("All assistants, then one listed page per assistant with its chip, purpose and back link", () => {
    expect(group.pages.map((p) => [p.id, p.title, p.listed])).toEqual([["all", "All assistants", true], ["jeff", "Jeff", true], ["keuken", "Keuken", true]])
    expect(group.pages[1]).toMatchObject({ chip: { text: "On", tone: "ok" }, description: "Everyday.", backLabel: "Assistants" })
    expect(group.pages[2]).toMatchObject({ chip: { text: "Off", tone: "off" } })
    expect(group.pages[2]!.description).toBeUndefined()
  })
  it("the category is hidden until the page is registered", () => {
    expect(buildSettingsTree({ sections: [], modules: [], clientPages: [] }).some((g) => g.slug === "assistants")).toBe(false)
  })
  it("a tab is the third part of the path: it resolves to the assistant's page, goes back to the list on a phone", () => {
    expect(parseSettingsHash("#settings/assistants/jeff/model")).toEqual(["assistants", "jeff", "model"])
    expect(formatSettingsHash(["assistants", "jeff", "model"])).toBe("#settings/assistants/jeff/model")
    expect(resolveSettingsPath(tree, ["assistants", "jeff", "model"], true).page?.id).toBe("jeff")
    expect(resolveSettingsPath(tree, ["assistants", "jeff", "model"], false).page?.source).toEqual({ kind: "client", id: "assistant" })
    expect(parentPath(tree, ["assistants", "jeff", "model"], false)).toEqual(["assistants"])
    expect(parentPath(tree, ["assistants", "jeff", "model"], true)).toBeUndefined()
  })
  it("changing tab is not leaving the page: edits are kept and nothing is asked; another page asks", () => {
    const ui: SettingsUi = { settingsOpen: true, settingsPath: ["assistants", "jeff", "basics"], settingsDirty: true }
    expect(navigateSettings(ui, ["assistants", "jeff", "model"])).toEqual({ settingsOpen: true, settingsPath: ["assistants", "jeff", "model"], settingsLeave: undefined })
    expect(navigateSettings(ui, ["assistants", "keuken"])).toEqual({ settingsLeave: ["assistants", "keuken"] })
    expect(navigateSettings(ui, ["assistants", "keuken"], true)).toMatchObject({ settingsPath: ["assistants", "keuken"], settingsDirty: false })
  })
})
