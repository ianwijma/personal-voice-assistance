import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { exampleAssistantInfo, exampleWeatherModule } from "@pva/protocol/examples"
import type { ModuleInfo, ModuleInstanceInfo } from "@pva/protocol"
import { ClientContext } from "@/components/context.tsx"
import { ModuleInstances, moduleStateText } from "@/components/settings/ModuleHeader.tsx"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState } from "@/lib/state.ts"
import { createClientStore } from "@/lib/store.ts"

const weather = (instances: ReadonlyArray<ModuleInstanceInfo> | undefined, state: ModuleInfo["state"] = "running"): ModuleInfo => ({
  ...exampleWeatherModule,
  state,
  ...(instances === undefined ? {} : { instances })
})

const show = (m: ModuleInfo) => {
  const store = createClientStore({
    ...initialState,
    assistants: [{ ...exampleAssistantInfo, id: "jeff", name: "Jeff" }, { ...exampleAssistantInfo, id: "keuken", name: "Keuken" }]
  })
  // `ModuleInstances` reads only the client's store.
  return render(
    <ClientContext.Provider value={{ store } as unknown as AssistantClient}>
      <ModuleInstances module={m} />
    </ClientContext.Provider>
  )
}

describe("module instances (docs/ASSISTANTS.md §2.6)", () => {
  it("says the module is not running when no assistant has it on", () => {
    show(weather([]))
    expect(screen.getByTestId("no-instances")).toHaveTextContent("Not running: no assistant has Weather switched on.")
    expect(screen.queryAllByTestId("instance")).toHaveLength(0)
    expect(screen.getByTestId("module-weather")).toHaveAttribute("data-state", "running")
  })

  // Review round 2, finding 18: a provider demanded only through another module's `uses` runs with no instance.
  it("a provider running only for the modules that use it says so, and is not called off", () => {
    const shared: ModuleInfo = { ...weather([]), enabled: false, state: "running" }
    show(shared)
    expect(screen.getByTestId("no-instances")).toHaveTextContent("Running for the modules that use it: no assistant has Weather switched on itself.")
    expect(screen.getByTestId("no-instances")).not.toHaveTextContent("Not running")
    expect(moduleStateText(shared)).toBe("Running for the modules that use it")
    expect(moduleStateText({ ...shared, state: "disabled" })).toBe("Off")
    expect(moduleStateText({ ...shared, state: "stopping" })).toBe("Off")
  })

  it("no instance while it starts or failed: says that, not that nobody has it on", () => {
    const { unmount } = show({ ...weather([]), state: "starting" })
    expect(screen.getByTestId("no-instances")).toHaveTextContent("Starting…")
    unmount()
    show({ ...weather([]), state: "error", error: "Its shared part did not start" })
    expect(screen.getByTestId("no-instances")).toHaveTextContent("Could not start: Its shared part did not start")
  })

  it("lists an instance with the assistants that use it, by name, linked to their module page", () => {
    show(weather([{ assistants: ["jeff", "keuken"], own: [], state: "running", status: { text: "Home: Amsterdam", tone: "neutral" } }]))
    const row = screen.getByTestId("instance")
    expect(row).toHaveAttribute("data-own", "false")
    expect(row).toHaveAttribute("data-state", "running")
    expect(row).toHaveTextContent("Running")
    expect(row).toHaveTextContent("Shared settings · Jeff, Keuken")
    expect(within(row).getByRole("link", { name: "Jeff" })).toHaveAttribute("href", "#settings/assistants/jeff/modules")
    expect(within(row).getByRole("link", { name: "Keuken" })).toHaveAttribute("href", "#settings/assistants/keuken/modules")
    expect(row).toHaveTextContent("Home: Amsterdam")
  })

  it("an assistant that is gone is named by its id; an instance with own values says which, by the field's label", () => {
    show(weather([{ assistants: ["removed"], own: ["units", "nope"], state: "running" }]))
    const row = screen.getByTestId("instance")
    expect(row).toHaveAttribute("data-own", "true")
    // "units" has the label "Units"; a key the module has no field for is shown as it is.
    expect(row).toHaveTextContent("Own units, nope · removed")
    expect(row).not.toHaveTextContent("Shared settings")
  })

  it("shows the error of an instance that could not start, and the status only while it runs", () => {
    show(weather([
      { assistants: ["jeff"], own: [], state: "error", error: "No API key", status: { text: "stale status", tone: "neutral" } },
      { assistants: ["keuken"], own: ["units"], state: "starting", status: { text: "starting status", tone: "neutral" } },
      { assistants: ["jeff"], own: ["units"], state: "running", status: { text: "all good", tone: "neutral" } }
    ], "error"))
    const [failed, starting, running] = screen.getAllByTestId("instance")
    expect(failed).toHaveTextContent("Could not start")
    expect(within(failed!).getByTestId("instance-error")).toHaveTextContent("No API key")
    expect(within(failed!).getByRole("alert")).toBeInTheDocument()
    expect(failed).not.toHaveTextContent("stale status")
    expect(starting).toHaveTextContent("Starting…")
    expect(starting).not.toHaveTextContent("starting status")
    expect(starting).not.toHaveAttribute("role", "alert")
    expect(running).toHaveTextContent("Running")
    expect(running).toHaveTextContent("all good")
    expect(screen.getAllByRole("alert")).toHaveLength(1)
  })

  it("a module without `instances` (an older server) is treated as running nowhere", () => {
    show(weather(undefined))
    expect(screen.getByTestId("no-instances")).toBeInTheDocument()
  })
})
