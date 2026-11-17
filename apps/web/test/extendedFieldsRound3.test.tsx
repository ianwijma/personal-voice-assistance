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
import { createModuleRoutesMock } from "../mock/demoHome.ts"

// PR 90 review round 3, findings 4 and 5 of the server/web half: one rule for the form's state. A button press, a
// save or a reset acts on exactly what is shown: a press is refused while a shown field is invalid; Reset replaces
// the field's value and clears its private state and errors.

const house: ModuleInfo = {
  id: "house",
  name: "House",
  description: "House",
  enabled: true,
  state: "running",
  tools: [],
  revision: 1,
  settings: {
    fields: [
      { type: "boolean", key: "advanced", label: "Advanced", apply: "live", default: false, source: "default" },
      { type: "text", key: "hidden", label: "Hidden", apply: "live", default: "", visibleWhen: { key: "advanced", in: [true] }, source: "default" },
      { type: "textList", key: "greetings", label: "Greetings", apply: "live", default: [], maxItems: 5, itemMaxLength: 10, source: "saved" },
      {
        type: "records",
        key: "levels",
        label: "Levels",
        apply: "live",
        default: [{ name: "A", low: 1 }],
        itemFields: [
          { type: "text", key: "name", label: "Name", default: "" },
          { type: "number", key: "low", label: "Low", default: 1, integer: true }
        ],
        itemLabel: "level",
        titleKey: "name",
        orderable: false,
        source: "saved"
      },
      { type: "action", key: "check", label: "Check", apply: "live", buttonLabel: "Check", requiresSaved: false, source: "default" }
    ],
    values: { advanced: false, hidden: "secret draft", greetings: ["hey"], levels: [{ name: "A", low: 2 }] },
    secrets: {},
    errors: []
  }
}

const page: NavPage = {
  group: "shared",
  id: "modules",
  title: "Modules",
  order: 0,
  source: { kind: "server", sections: [], moduleIds: [house.id] },
  inUse: true,
  listed: true,
  protected: false,
  hasSecrets: false,
  hasErrors: false,
  origins: []
}

const setup = () => {
  const store = createStore({ ...initialState, vault: { state: "none", admin: true }, modules: { order: [house.id], byId: { [house.id]: house } } }, reducer)
  const ok: ResultMessage = { type: "result", requestId: "r", ok: true }
  const configureModule = vi.fn(async (_id: string, _patch: SettingsPatch) => ok)
  const request = vi.fn(async (_m: unknown) => ({ ...ok, action: { ok: true, text: "Checked", tone: "ok" } }))
  const client = { store, configureModule, request, updateSection: vi.fn(async () => ok), reloadEngines: vi.fn(async () => ok), settings: vi.fn() } as unknown as AssistantClient
  render(<ClientContext.Provider value={client}><ServerPage page={page} /></ClientContext.Provider>)
  const save = () => within(screen.getByTestId("page-footer")).getByRole("button", { name: "Save" }) as HTMLButtonElement
  const check = () => within(screen.getByTestId("action-check")).getByRole("button", { name: "Check" }) as HTMLButtonElement
  const lowInput = () => {
    const row = screen.getAllByTestId("record")[0]!
    const toggle = row.querySelector<HTMLElement>("[aria-expanded]")!
    if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle)
    return within(row).getByLabelText("Low") as HTMLInputElement
  }
  return { configureModule, request, save, check, lowInput }
}

describe("a button press acts on exactly what is shown (3b-4)", () => {
  it("is refused while a record's number is invalid; once corrected it sends the shown draft, without hidden fields", async () => {
    const { check, lowInput, request } = setup()
    fireEvent.change(lowInput(), { target: { value: "" } })
    expect(lowInput()).toHaveValue(null)
    expect(check().disabled).toBe(true)
    expect(screen.getByTestId("action-blocked")).toHaveTextContent(/Levels: Level 1, Low: /)
    await act(async () => fireEvent.click(check()))
    expect(request).not.toHaveBeenCalled()
    fireEvent.change(lowInput(), { target: { value: "7" } })
    expect(check().disabled).toBe(false)
    await act(async () => fireEvent.click(check()))
    expect(request).toHaveBeenCalledTimes(1)
    const sent = request.mock.calls[0]![0] as { values: Record<string, unknown> }
    expect(sent.values["levels"]).toEqual([{ name: "A", low: 7 }])
    // A field hidden by `visibleWhen` is not part of what is shown, so not of the press either.
    expect(Object.hasOwn(sent.values, "hidden")).toBe(false)
  })

  it("is refused while a text list holds an item it could not add", async () => {
    const { check, request } = setup()
    const input = screen.getByLabelText("Greetings")
    fireEvent.change(input, { target: { value: "far too long a greeting" } })
    fireEvent.blur(input)
    expect(check().disabled).toBe(true)
    await act(async () => fireEvent.click(check()))
    expect(request).not.toHaveBeenCalled()
  })
})

describe("Reset replaces the field's value and clears its private state and errors (3b-5)", () => {
  it("records: an invalid edit, then Reset: no error left, and Save sends null for that field", async () => {
    const { configureModule, lowInput, save } = setup()
    fireEvent.change(lowInput(), { target: { value: "" } })
    expect(save().disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: /^Reset Levels to the default/ }))
    expect(screen.queryByText(/Level 1, Low: /)).toBeNull()
    expect(lowInput()).toHaveValue(1)
    expect(save().disabled).toBe(false)
    await act(async () => fireEvent.click(save()))
    expect(configureModule.mock.calls[0]![1].values).toEqual({ levels: null })
  })

  it("text list: a rejected item, then Reset: the input is empty, no error, and Save sends null", async () => {
    const { configureModule, save } = setup()
    const input = screen.getByLabelText("Greetings")
    fireEvent.change(input, { target: { value: "far too long a greeting" } })
    fireEvent.blur(input)
    expect(screen.getAllByText(/Not added/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: /^Reset Greetings to the default/ }))
    expect(screen.queryAllByText(/Not added/)).toEqual([])
    expect(screen.getByLabelText("Greetings")).toHaveValue("")
    expect(save().disabled).toBe(false)
    await act(async () => fireEvent.click(save()))
    expect(configureModule.mock.calls[0]![1].values).toEqual({ greetings: null })
  })
})

describe("the route token mock behaves as the server (3b-6, 3b-7)", () => {
  const modules = [{ id: "demo-home", state: "running", routes: [] } as unknown as ModuleInfo]

  it("refuses everything while the vault is locked, keeps the limits, and resets to its seeded tokens", () => {
    let locked = false
    const mock = createModuleRoutesMock(() => locked)
    expect(mock.view(modules).modules[0]!.tokens.map((t) => t.label)).toEqual(["Home Assistant automations"])
    locked = true
    expect(mock.view(modules)).toMatchObject({ tokensLocked: true, modules: [{ tokens: [] }] })
    expect(() => mock.mint("demo-home", "hook", "x")).toThrow(expect.objectContaining({ status: 503, code: "locked" }))
    expect(() => mock.revoke("demo-home", "a1b2c3d4e5f6")).toThrow(expect.objectContaining({ status: 503 }))
    locked = false
    expect(() => mock.mint("demo-home", "hook", "x".repeat(81))).toThrow(expect.objectContaining({ status: 400, code: "invalid" }))
    for (let i = 1; i < 20; i++) mock.mint("demo-home", "hook", `caller ${i}`)
    expect(() => mock.mint("demo-home", "hook", "one too many")).toThrow(expect.objectContaining({ status: 409, code: "limit" }))
    expect(mock.revoke("demo-home", "a1b2c3d4e5f6")).toBe(true)
    mock.reset()
    expect(mock.view(modules).modules[0]!.tokens.map((t) => t.label)).toEqual(["Home Assistant automations"])
  })
})
