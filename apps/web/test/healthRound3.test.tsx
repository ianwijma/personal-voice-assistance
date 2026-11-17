// P1 review round 3 (p1-r3c, findings 13, 16–18, 20): the Health page names the device an issue is about; a module's
// "cannot run here" note renders a link fix as a link; the module header shows its version; the new-assistant wizard
// says which modules a template names that this server does not have, and where the draft started.
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { exampleDevice, exampleWeatherModule } from "@pva/protocol/examples"
import type { AssistantTemplate, HealthInfo, ModuleInfo } from "@pva/protocol"
import { ClientContext } from "@/components/context.tsx"
import { ModuleHeader } from "@/components/settings/ModuleHeader.tsx"
import { HealthPage } from "@/components/settings/pages/HealthPage.tsx"
import { absentModules, BLANK_START, startOrigin, templateStart } from "@/components/settings/pages/NewAssistantWizard.tsx"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState } from "@/lib/state.ts"
import { createClientStore } from "@/lib/store.ts"

const withStore = (ui: React.ReactElement, patch: Partial<typeof initialState>) => {
  const store = createClientStore({ ...initialState, ...patch })
  return render(<ClientContext.Provider value={{ store } as unknown as AssistantClient}>{ui}</ClientContext.Provider>)
}

describe("the Health page names the device of an issue (finding 13)", () => {
  it("two issues with the same title for two devices: each shows its device, by name, else by id", () => {
    const health: HealthInfo = {
      issues: [
        { id: "music.speaker", module: "music", device: exampleDevice.id, severity: "warning", title: "The speaker did not answer", detail: "" },
        { id: "music.speaker", module: "music", device: "d-unknown-77", severity: "warning", title: "The speaker did not answer", detail: "" }
      ],
      checking: false
    }
    withStore(<HealthPage />, { health, devices: [exampleDevice] })
    const items = screen.getAllByTestId("health-issue")
    expect(items).toHaveLength(2)
    const devices = items.map((li) => within(li).getByTestId("issue-device").textContent)
    expect(devices.sort()).toEqual([exampleDevice.name, "d-unknown-77"].sort())
  })
})

describe("the module header (findings 17, 20)", () => {
  it("an unavailable module's link fix is a link; a command fix is shown as a command; the version is shown", () => {
    const linked: ModuleInfo = {
      ...exampleWeatherModule,
      version: "0.3.0",
      state: "unavailable",
      unavailable: { reason: "Runs on linux; this server runs darwin.", fix: { kind: "link", label: "Read about platforms", value: "https://example.org/platforms" } }
    }
    const { unmount } = withStore(<ModuleHeader module={linked} editable />, {})
    const link = within(screen.getByTestId("module-unavailable")).getByRole("link", { name: "Read about platforms" })
    expect(link).toHaveAttribute("href", "https://example.org/platforms")
    expect(screen.getByTestId("module-version")).toHaveTextContent("version 0.3.0")
    unmount()
    withStore(<ModuleHeader module={{ ...linked, version: undefined as never, unavailable: { reason: "mpv is missing", fix: { kind: "command", label: "Install mpv", value: "sudo apt install mpv" } } }} editable />, {})
    expect(screen.getByTestId("issue-command")).toHaveTextContent("sudo apt install mpv")
    expect(screen.queryByTestId("module-version")).toBeNull()
  })
})

describe("the new-assistant wizard (findings 16, 18)", () => {
  const dj: AssistantTemplate = { id: "music.dj", name: "DJ", prompt: "You play music.", modules: ["music", "weathre", "jev"] }
  const known = { assistants: [{ id: "jeff", name: "Jeff" }], templates: [dj], capabilities: ["music", "weather"] }

  it("a template's module that this server has no capability of is named, never silently dropped", () => {
    expect(absentModules(dj, known.capabilities)).toEqual(["weathre", "jev"])
  })

  it("the review step says where the draft started: blank, a copy, or a module's suggestion", () => {
    expect(startOrigin(BLANK_START, known)).toBe("Started blank")
    expect(startOrigin("jeff", known)).toBe("Copy of Jeff")
    expect(startOrigin(templateStart("music.dj"), known)).toBe("From the suggestion DJ (not on this server: weathre, jev)")
  })
})
