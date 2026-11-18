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
      { type: "text", key: "constructor", label: "Builder", apply: "live", default: "", source: "default" },
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
    values: { title: "", constructor: "", greetings: ["hey"], levels: [{ name: "A", low: 1 }, { name: "B", low: 2 }] },
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

describe("a field named like an Object member (review round 1)", () => {
  it("has no inherited local error, and saves like any other", async () => {
    const { configureModule, save } = setup()
    const builder = screen.getByLabelText("Builder")
    expect(builder).not.toHaveAttribute("aria-invalid", "true")
    fireEvent.change(builder, { target: { value: "Bob" } })
    expect(save().disabled).toBe(false)
    await act(async () => fireEvent.click(save()))
    expect(configureModule.mock.calls[0]![1].values).toEqual({ constructor: "Bob" })
  })
})

// PR 90 review round 2, finding 6: a field hidden by `visibleWhen` (or gone from the form) takes its local error with
// it, so an invalid combo that is hidden no longer holds Save of the switch that hid it.
describe("a hidden field's local error (review round 2)", () => {
  const scenes: ModuleInfo = {
    id: "scenes",
    name: "Scenes",
    description: "Scenes",
    enabled: true,
    state: "running",
    tools: [],
    revision: 1,
    settings: {
      fields: [
        { type: "boolean", key: "enabled", label: "Use scenes", apply: "live", default: false, source: "saved" },
        {
          type: "combo",
          key: "scene",
          label: "Scene",
          apply: "live",
          default: "a",
          options: [{ value: "a", label: "A" }],
          allowCustom: false,
          visibleWhen: { key: "enabled", in: [true] },
          source: "default"
        }
      ],
      values: { enabled: true, scene: "a" },
      secrets: {},
      errors: []
    }
  }

  it("hiding an invalid closed combo frees Save, and the switch is saved without it", async () => {
    const store = createStore({ ...initialState, vault: { state: "none", admin: true }, modules: { order: [scenes.id], byId: { [scenes.id]: scenes } } }, reducer)
    const ok: ResultMessage = { type: "result", requestId: "r", ok: true }
    const configureModule = vi.fn(async (_id: string, _patch: SettingsPatch) => ok)
    const client = { store, configureModule, updateSection: vi.fn(async () => ok), reloadEngines: vi.fn(async () => ok), settings: vi.fn() } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><ServerPage page={{ ...page, source: { kind: "server", sections: [], moduleIds: [scenes.id] } }} /></ClientContext.Provider>)
    const save = () => within(screen.getByTestId("page-footer")).getByRole("button", { name: "Save" }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText("Scene"), { target: { value: "b" } })
    expect(save().disabled).toBe(true)
    // Switch scenes off: the combo goes, and so does its error.
    fireEvent.click(screen.getByRole("switch", { name: "Use scenes" }))
    expect(screen.queryByLabelText("Scene")).toBeNull()
    expect(save().disabled).toBe(false)
    await act(async () => fireEvent.click(save()))
    expect(configureModule).toHaveBeenCalledTimes(1)
    expect(configureModule.mock.calls[0]![1].values).toEqual({ enabled: false })
  })
})

// PR 90 review round 5, finding 5B-4: a refreshed form treats a field with a shown local error as edited, like Save
// and Test do: it keeps the text being typed and its error, and the form says it changed elsewhere.
describe("a newer form from the server while a record's number is invalid", () => {
  it("keeps the cleared input and its error, keeps the other side's change of the rest, and marks the form stale", () => {
    const { store, save } = setup()
    const rows = screen.getAllByTestId("record")
    fireEvent.click(rows[0]!.querySelector<HTMLElement>("[aria-expanded]")!)
    fireEvent.change(within(rows[0]!).getByLabelText("Low"), { target: { value: "" } })
    expect(screen.getByText(/^Level 1, Low: /)).toBeInTheDocument()
    expect(save().disabled).toBe(true)
    // Another admin saves Low 2 for the first level, and a new title.
    act(() => {
      store.dispatch({
        type: "module.changed",
        module: { ...lists, revision: 2, settings: { ...lists.settings, values: { ...lists.settings.values, title: "Theirs", levels: [{ name: "A", low: 2 }, { name: "B", low: 2 }] } } }
      })
    })
    // The edit and its error stay; the form says it is not the latest.
    const first = screen.getAllByTestId("record")[0]!
    expect((within(first).getByLabelText("Low") as HTMLInputElement).value).toBe("")
    expect(screen.getByText(/^Level 1, Low: /)).toBeInTheDocument()
    expect(screen.getByText("Changed in another tab")).toBeInTheDocument()
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Theirs")
    expect(save().disabled).toBe(true)
  })
})
