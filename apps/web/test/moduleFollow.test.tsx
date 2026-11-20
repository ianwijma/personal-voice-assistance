// Review round 6 of PR 90 (6A-2): a module the admin snapshot carries as a light entry (`details: "follow"`) is
// followed at once by its complete `module.changed`. The page shows it as loading until then, makes no form of the
// light entry, and keeps a complete entry it already has.
import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ModuleInfo } from "@pva/protocol"
import { exampleWeatherModule, serverExamples } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import type { ResultMessage } from "@/lib/connection.ts"
import type { NavPage } from "@/lib/settingsTree.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { ServerPage } from "@/components/settings/ServerPage.tsx"

const light = (m: ModuleInfo): ModuleInfo => ({
  id: m.id,
  name: m.name,
  description: m.description,
  enabled: m.enabled,
  state: m.state,
  tools: [],
  settings: { fields: [], values: {}, secrets: {}, errors: [] },
  revision: m.revision,
  details: "follow"
})
const snapshotWith = (modules: ReadonlyArray<ModuleInfo>) => {
  const example = serverExamples["admin.snapshot"]
  return { ...example, snapshot: { ...example.snapshot, modules: [...modules] } }
}

describe("a light snapshot entry and the frame that follows it", () => {
  it("an unknown module: the light entry, then the complete one", () => {
    const s1 = reducer(initialState, snapshotWith([light(exampleWeatherModule)]))
    expect(s1.modules.byId.weather?.details).toBe("follow")
    const s2 = reducer(s1, { type: "module.changed", module: exampleWeatherModule })
    expect(s2.modules.byId.weather).toEqual(exampleWeatherModule)
  })

  it("a module the page already has complete (a reconnect): the light entry does not replace it", () => {
    const known = reducer(initialState, { type: "module.changed", module: exampleWeatherModule })
    const s1 = reducer(known, snapshotWith([light(exampleWeatherModule)]))
    expect(s1.modules.byId.weather).toEqual(exampleWeatherModule)
    const newer = { ...exampleWeatherModule, revision: 4, settings: { ...exampleWeatherModule.settings, values: { ...exampleWeatherModule.settings.values, defaultPlace: "Utrecht" } } }
    expect(reducer(s1, { type: "module.changed", module: newer }).modules.byId.weather).toEqual(newer)
  })

  it("the module's page shows it as loading, with no switch and no form, then its form with the saved values", () => {
    const page: NavPage = {
      group: "shared",
      id: "weather",
      title: "Weather",
      order: 0,
      source: { kind: "server", sections: [], moduleIds: [exampleWeatherModule.id] },
      inUse: true,
      listed: true,
      protected: false,
      hasSecrets: false,
      hasErrors: false,
      origins: []
    }
    const store = createStore(reducer(initialState, snapshotWith([light(exampleWeatherModule)])), reducer)
    const ok: ResultMessage = { type: "result", requestId: "r", ok: true }
    const client = { store, configureModule: vi.fn(async () => ok), updateSection: vi.fn(async () => ok), reloadEngines: vi.fn(async () => ok), settings: vi.fn() } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><ServerPage page={page} /></ClientContext.Provider>)
    expect(screen.getByTestId("module-loading")).toHaveTextContent("Loading")
    expect(screen.queryByRole("switch")).toBeNull()
    expect(screen.queryByTestId("form-m-weather")).toBeNull()
    expect(screen.queryByTestId("page-footer")).toBeNull()
    act(() => store.dispatch({ type: "module.changed", module: exampleWeatherModule }))
    expect(screen.queryByTestId("module-loading")).toBeNull()
    expect((screen.getByLabelText("Home location") as HTMLInputElement).value).toBe("Amsterdam")
  })
})
