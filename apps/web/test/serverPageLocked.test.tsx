import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { SettingsPatch } from "@pva/protocol"
import { exampleHomeAssistantModule, exampleWeatherModule } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import type { ResultMessage } from "@/lib/connection.ts"
import type { NavPage } from "@/lib/settingsTree.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { ServerPage } from "@/components/settings/ServerPage.tsx"

// PR #35 review 4, finding 1: on a merged page, a protected module must not take Save and Cancel away from the
// unprotected forms next to it while the vault is locked.
describe("A merged page with the vault locked", () => {
  const page: NavPage = {
    group: "shared",
    id: "modules",
    title: "Modules",
    order: 0,
    source: { kind: "server", sections: [], moduleIds: [exampleWeatherModule.id, exampleHomeAssistantModule.id] },
    inUse: true,
    listed: true,
    protected: true,
    hasSecrets: true,
    hasErrors: false,
    origins: []
  }

  it("keeps the unprotected module editable and savable; the protected one stays read-only", async () => {
    const store = createStore(
      {
        ...initialState,
        vault: { state: "locked", admin: true },
        modules: {
          order: [exampleWeatherModule.id, exampleHomeAssistantModule.id],
          byId: { [exampleWeatherModule.id]: exampleWeatherModule, [exampleHomeAssistantModule.id]: exampleHomeAssistantModule }
        }
      },
      reducer
    )
    const ok: ResultMessage = { type: "result", requestId: "r", ok: true }
    const configureModule = vi.fn(async (_id: string, _patch: SettingsPatch) => ok)
    const client = { store, configureModule, updateSection: vi.fn(async () => ok), reloadEngines: vi.fn(async () => ok), settings: vi.fn() } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><ServerPage page={page} /></ClientContext.Provider>)

    // The protected module is read-only, and the banner says only part of the page is locked.
    expect(screen.getByTestId(`form-m-${exampleHomeAssistantModule.id}`).getAttribute("data-readonly")).toBe("true")
    expect(screen.getByTestId(`form-m-${exampleWeatherModule.id}`).hasAttribute("data-readonly")).toBe(false)
    expect(screen.getByTestId("keys-locked").textContent).toContain("some settings on this page cannot be changed")

    // The weather module's own setting can be changed and saved.
    fireEvent.change(screen.getByLabelText("Home location"), { target: { value: "Utrecht" } })
    const footer = screen.getByTestId("page-footer")
    const save = within(footer).getByRole("button", { name: "Save" }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(save)
    })
    expect(configureModule).toHaveBeenCalledTimes(1)
    expect(configureModule.mock.calls[0]![0]).toBe(exampleWeatherModule.id)
    expect(configureModule.mock.calls[0]![1].values).toEqual({ defaultPlace: "Utrecht" })
  })
})
