import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ModuleInfo, SettingsPatch } from "@pva/protocol"
import type { AssistantClient } from "@/lib/client.ts"
import type { ResultMessage } from "@/lib/connection.ts"
import type { NavPage } from "@/lib/settingsTree.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { ServerPage } from "@/components/settings/ServerPage.tsx"

// PR 90 review round 1, findings 13 and 14: a text list's rejected item and a record field's invalid text are edits
// the enclosing form knows about: Save waits, the page counts as edited, Cancel clears them; removing the row with
// the problem frees Save again.

const lists: ModuleInfo = {
  id: "lists",
  name: "Lists",
  description: "Lists",
  enabled: true,
  state: "running",
  tools: [],
  revision: 1,
  settings: {
    fields: [
      { type: "text", key: "title", label: "Title", apply: "live", default: "", source: "default" },
      { type: "textList", key: "greetings", label: "Greetings", apply: "live", default: [], maxItems: 5, itemMaxLength: 10, source: "default" },
      {
        type: "records",
        key: "levels",
        label: "Levels",
        apply: "live",
        default: [],
        itemFields: [
          { type: "text", key: "name", label: "Name", default: "" },
          { type: "number", key: "low", label: "Low", default: 1, integer: true }
        ],
        itemLabel: "level",
        titleKey: "name",
        orderable: false,
        source: "saved"
      }
    ],
    values: { title: "", greetings: ["hey"], levels: [{ name: "A", low: 1 }, { name: "B", low: 2 }] },
    secrets: {},
    errors: []
  }
}

const page: NavPage = {
  group: "shared",
  id: "modules",
  title: "Modules",
  order: 0,
  source: { kind: "server", sections: [], moduleIds: [lists.id] },
  inUse: true,
  listed: true,
  protected: false,
  hasSecrets: false,
  hasErrors: false,
  origins: []
}

const setup = () => {
  const store = createStore({ ...initialState, vault: { state: "none", admin: true }, modules: { order: [lists.id], byId: { [lists.id]: lists } } }, reducer)
  const ok: ResultMessage = { type: "result", requestId: "r", ok: true }
  const configureModule = vi.fn(async (_id: string, _patch: SettingsPatch) => ok)
  const client = { store, configureModule, updateSection: vi.fn(async () => ok), reloadEngines: vi.fn(async () => ok), settings: vi.fn() } as unknown as AssistantClient
  render(<ClientContext.Provider value={client}><ServerPage page={page} /></ClientContext.Provider>)
  const footer = () => screen.getByTestId("page-footer")
  const save = () => within(footer()).getByRole("button", { name: "Save" }) as HTMLButtonElement
  const cancel = () => within(footer()).getByRole("button", { name: "Cancel" }) as HTMLButtonElement
  return { store, configureModule, save, cancel }
}

describe("extended fields in their form", () => {
  it("a text item that could not be added holds Save, marks the page edited, and goes with Cancel", async () => {
    const { store, configureModule, save, cancel } = setup()
    // Another edit, then an item that is too long, left in the input.
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Home" } })
    const input = screen.getByLabelText("Greetings")
    fireEvent.change(input, { target: { value: "far too long a greeting" } })
    fireEvent.blur(input)
    expect(input).toHaveValue("far too long a greeting")
    expect(screen.getByText(/Not added: .*longer than 10 characters/)).toBeInTheDocument()
    expect(save().disabled).toBe(true)
    await act(async () => fireEvent.click(save()))
    expect(configureModule).not.toHaveBeenCalled()
    // Cancel the title edit alone: the pending text is an edit too (the page asks before it is left).
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } })
    expect(store.get().ui.settingsDirty).toBe(true)
    expect(cancel().disabled).toBe(false)
    await act(async () => fireEvent.click(cancel()))
    expect(screen.getByLabelText("Greetings")).toHaveValue("")
    expect(screen.queryByText(/Not added/)).toBeNull()
    expect(store.get().ui.settingsDirty).toBe(false)
  })

  it("a record field's invalid text holds Save until its row is removed", async () => {
    const { configureModule, save } = setup()
    const rows = screen.getAllByTestId("record")
    fireEvent.click(rows[0]!.querySelector<HTMLElement>("[aria-expanded]")!)
    fireEvent.change(within(rows[0]!).getByLabelText("Low"), { target: { value: "" } })
    // A valid edit of the other row does not clear the first row's problem.
    fireEvent.click(rows[1]!.querySelector<HTMLElement>("[aria-expanded]")!)
    fireEvent.change(within(rows[1]!).getByLabelText("Low"), { target: { value: "5" } })
    expect(screen.getByText(/^Level 1, Low: /)).toBeInTheDocument()
    expect(save().disabled).toBe(true)
    // Removing the row with the problem: nothing is left to fix.
    fireEvent.click(screen.getByRole("button", { name: "Remove A" }))
    expect(screen.queryByText(/^Level 1, Low: /)).toBeNull()
    expect(save().disabled).toBe(false)
    await act(async () => fireEvent.click(save()))
    expect(configureModule).toHaveBeenCalledTimes(1)
    expect(configureModule.mock.calls[0]![1].values).toEqual({ levels: [{ name: "B", low: 5 }] })
  })
})
