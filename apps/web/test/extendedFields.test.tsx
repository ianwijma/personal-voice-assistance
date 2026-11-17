import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import type { ModuleInfo, ModuleRoutesResponse, SettingField, SettingsForm, SettingValue } from "@pva/protocol"
import { ClientContext } from "@/components/context.tsx"
import type { FieldContext } from "@/components/fields/types.ts"
import { ModuleRoutes } from "@/components/settings/ModuleRoutes.tsx"
import { computePatch, initialDraft, setDraftValue, valueEqual } from "@/lib/forms.ts"
import type { AssistantClient } from "@/lib/client.ts"
import type { VoiceApi } from "@/lib/voiceCatalog.ts"
import { rendererFor } from "@/ui/fieldRenderers.ts"

// Protocol 10 (docs/SETTINGS-UI.md §3.2): the generic renderers of the extended field types, and the module routes view.

const rooms: Extract<SettingField, { type: "records" }> = {
  type: "records",
  key: "rooms",
  label: "Rooms",
  apply: "live",
  default: [],
  itemFields: [
    { type: "text", key: "name", label: "Name", default: "" },
    { type: "textList", key: "aliases", label: "Other names", default: [], maxItems: 3 },
    { type: "boolean", key: "dim", label: "Dimmable", default: false }
  ],
  itemLabel: "room",
  titleKey: "name",
  orderable: true
}
const greetings: Extract<SettingField, { type: "textList" }> = { type: "textList", key: "greetings", label: "Greetings", apply: "live", default: [], maxItems: 3, itemMaxLength: 10 }
const scene: Extract<SettingField, { type: "combo" }> = {
  type: "combo",
  key: "scene",
  label: "Scene",
  apply: "live",
  default: "Cosy",
  options: [{ value: "Cosy", label: "Cosy" }, { value: "film", label: "Film night" }],
  allowCustom: false,
  optionsNote: "2 suggestions from Demo home"
}
const state: Extract<SettingField, { type: "info" }> = { type: "info", key: "state", label: "Now", apply: "live", tone: "ok" }
const check: Extract<SettingField, { type: "action" }> = { type: "action", key: "check", label: "Check", apply: "live", buttonLabel: "Check", requiresSaved: false }
const allOff: Extract<SettingField, { type: "action" }> = { type: "action", key: "allOff", label: "All off", apply: "live", buttonLabel: "Switch everything off", requiresSaved: true }

/** One field with its own state, as a form holds it. */
function Harness({ field, initial, onValue, onError, context }: {
  readonly field: SettingField
  readonly initial: SettingValue | undefined
  readonly onValue?: (v: SettingValue) => void
  readonly onError?: (m: string | undefined) => void
  readonly context?: FieldContext
}) {
  const [value, setValue] = useState(initial)
  const Renderer = rendererFor(field)
  return (
    <Renderer
      field={field}
      id={`f-${field.key}`}
      describedBy={`f-${field.key}-desc`}
      value={value}
      onChange={(v) => {
        setValue(v)
        onValue?.(v)
      }}
      onSecretChange={() => undefined}
      disabled={false}
      invalid={false}
      onLocalError={onError ?? (() => undefined)}
      {...(context !== undefined ? { context } : {})}
    />
  )
}

const withClient = (request: AssistantClient["request"], ui: React.ReactNode) =>
  render(<ClientContext.Provider value={{ request } as unknown as AssistantClient}>{ui}</ClientContext.Provider>)

describe("text list", () => {
  it("adds on Enter and comma, drops duplicates ignoring case, removes a chip, and stops at the limit", () => {
    const values: Array<SettingValue> = []
    render(<Harness field={greetings} initial={["hey"]} onValue={(v) => values.push(v)} />)
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "please" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.change(input, { target: { value: "HEY, yo," } })
    expect(values).toEqual([["hey", "please"], ["hey", "please", "yo"]])
    expect(input).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Remove please" }))
    expect(values.at(-1)).toEqual(["hey", "yo"])
    fireEvent.change(input, { target: { value: "far too long a word" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByRole("alert")).toHaveTextContent("is longer than 10 characters")
  })
})

describe("records", () => {
  it("shows a row per record, adds one with the item defaults, edits it with the generic renderers, moves and removes", () => {
    const values: Array<SettingValue> = []
    render(<Harness field={rooms} initial={[{ name: "Kitchen", aliases: ["keuken"], dim: false }]} onValue={(v) => values.push(v)} />)
    const list = screen.getByTestId("records-rooms")
    expect(within(list).getAllByTestId("record")).toHaveLength(1)
    expect(within(list).getByTestId("record")).toHaveTextContent("Kitchen")
    expect(within(list).getByTestId("record")).toHaveTextContent("keuken")
    fireEvent.click(screen.getByRole("button", { name: "Add room" }))
    expect(values.at(-1)).toEqual([{ name: "Kitchen", aliases: ["keuken"], dim: false }, { name: "", aliases: [], dim: false }])
    // The new row is open: its name field is a text field.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hall" } })
    expect(values.at(-1)).toEqual([{ name: "Kitchen", aliases: ["keuken"], dim: false }, { name: "Hall", aliases: [], dim: false }])
    fireEvent.click(screen.getByRole("switch"))
    expect((values.at(-1) as ReadonlyArray<Record<string, unknown>>)[1]!.dim).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Move Hall up" }))
    expect((values.at(-1) as ReadonlyArray<Record<string, unknown>>).map((r) => r.name)).toEqual(["Hall", "Kitchen"])
    fireEvent.click(screen.getByRole("button", { name: "Remove Kitchen" }))
    expect(values.at(-1)).toEqual([{ name: "Hall", aliases: [], dim: true }])
  })
})

describe("combo, info", () => {
  it("offers the options, names where they came from, and refuses a value outside them without allowCustom", () => {
    const errors: Array<string | undefined> = []
    const { container } = render(<Harness field={scene} initial="Cosy" onError={(m) => errors.push(m)} />)
    expect([...container.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(["Cosy", "film"])
    expect(screen.getByTestId("options-note")).toHaveTextContent("2 suggestions from Demo home")
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "film" } })
    expect(screen.getByText("Film night", { selector: "p" })).toBeInTheDocument()
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Disco" } })
    expect(errors.at(-1)).toBe("Choose one of the suggestions.")
  })

  it("shows an info value read-only, and a dash while there is none", () => {
    const { rerender } = render(<Harness field={state} initial="2 lights on" />)
    expect(screen.getByTestId("info-state")).toHaveTextContent("2 lights on")
    expect(screen.queryByRole("textbox")).toBeNull()
    rerender(<Harness key="empty" field={state} initial="" />)
    expect(screen.getByTestId("info-state")).toHaveTextContent("—")
  })
})

describe("action buttons", () => {
  const context = (dirty: boolean): FieldContext => ({ form: { kind: "module", id: "demo-home" }, dirty, draftValues: { rooms: [{ name: "Hall" }], state: "x" } })

  it("sends module.action with the draft when it may, shows the result, and runs once at a time", async () => {
    let finish: (v: unknown) => void = () => undefined
    const request = vi.fn(() => new Promise((resolve) => (finish = resolve))) as unknown as AssistantClient["request"]
    withClient(request, <Harness field={check} initial={undefined} context={context(true)} />)
    const button = screen.getByRole("button", { name: "Check" })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith({ type: "module.action", moduleId: "demo-home", key: "check", values: { rooms: [{ name: "Hall" }], state: "x" } })
    expect(button).toBeDisabled()
    await act(async () => finish({ type: "result", requestId: "r", ok: true, action: { ok: false, text: "Desk lamp is in no room", tone: "error" } }))
    expect(screen.getByTestId("action-result")).toHaveTextContent("Desk lamp is in no room")
    expect(screen.getByTestId("action-result")).toHaveAttribute("data-ok", "false")
    expect(button).toBeEnabled()
  })

  it("waits for Save when it needs the saved settings, and says why a refused press did not run", async () => {
    const request = vi.fn(async () => ({ type: "result" as const, requestId: "r", ok: false, error: { code: "not_running" as const, message: "Demo home is not running" } }))
    const { rerender } = withClient(request as never, <Harness field={allOff} initial={undefined} context={context(true)} />)
    expect(screen.getByRole("button", { name: "Switch everything off" })).toBeDisabled()
    expect(screen.getByText("Save first")).toBeInTheDocument()
    rerender(
      <ClientContext.Provider value={{ request } as unknown as AssistantClient}>
        <Harness field={allOff} initial={undefined} context={context(false)} />
      </ClientContext.Provider>
    )
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch everything off" })))
    expect(request).toHaveBeenCalledWith({ type: "module.action", moduleId: "demo-home", key: "allOff" })
    expect(screen.getByTestId("action-result")).toHaveTextContent("Demo home is not running")
  })
})

describe("forms with the extended types", () => {
  const form: SettingsForm = {
    fields: [rooms, greetings, state, check],
    values: { rooms: [{ name: "Kitchen", aliases: [], dim: false }], greetings: ["hey"], state: "2 on" },
    secrets: {},
    errors: []
  }
  it("compares records deeply, and never sends an action or an info value", () => {
    expect(valueEqual([{ name: "a", aliases: ["x"] }], [{ name: "a", aliases: ["x"] }])).toBe(true)
    expect(valueEqual([{ name: "a", aliases: ["x"] }], [{ name: "a", aliases: ["y"] }])).toBe(false)
    let draft = initialDraft(form)
    // The same records as a new object are not an edit.
    draft = setDraftValue(draft, "rooms", [{ name: "Kitchen", aliases: [], dim: false }])
    draft = setDraftValue(draft, "state", "edited")
    expect(computePatch(form, draft)).toEqual({ values: {}, secrets: {} })
    draft = setDraftValue(draft, "rooms", [{ name: "Kitchen", aliases: ["keuken"], dim: false }])
    expect(computePatch(form, draft)).toEqual({ values: { rooms: [{ name: "Kitchen", aliases: ["keuken"], dim: false }] }, secrets: {} })
  })
})

describe("module routes view", () => {
  const module: ModuleInfo = {
    id: "hooks",
    name: "Hooks",
    description: "",
    enabled: true,
    state: "running",
    tools: [],
    settings: { fields: [], values: {}, secrets: {}, errors: [] },
    revision: 1,
    routes: [{ method: "POST", path: "/api/modules/hooks/hook", guards: ["token", "lan"], public: false, token: "hook", bodyLimitBytes: 8192, ratePerMinute: { perAddress: 30, total: 120 } }]
  }
  const view: ModuleRoutesResponse = {
    modules: [{
      moduleId: "hooks",
      running: true,
      routes: [{ ...module.routes![0]!, calls: [{ at: 0, address: "203.0.113.9", status: 403, ms: 0, note: "Only callers on the home network" }] }],
      tokens: [{ id: "a1b2c3d4e5f6", moduleId: "hooks", name: "hook", label: "Doorbell", createdAt: 0 }]
    }],
    tokensLocked: false
  }

  it("lists the routes with their guards and last calls, and mints a token whose secret is shown once", async () => {
    const calls: Array<[string, unknown]> = []
    const api: VoiceApi = {
      request: async (path, init) => {
        calls.push([path, init?.body])
        const body = path.endsWith("/tokens")
          ? { token: { id: "0f0f0f0f0f0f", moduleId: "hooks", name: "hook", label: "Grafana", createdAt: 1 }, secret: "s3cret-value-shown-once" }
          : view
        return new Response(JSON.stringify(body), { status: 200 })
      }
    }
    await act(async () => void render(<ModuleRoutes module={module} api={api} />))
    const route = screen.getByTestId("module-route")
    expect(route).toHaveTextContent("/api/modules/hooks/hook")
    expect(within(route).getByText("Token")).toBeInTheDocument()
    expect(within(route).getByText("Home network")).toBeInTheDocument()
    expect(screen.getByTestId("route-call")).toHaveTextContent("203.0.113.9")
    expect(screen.getByTestId("route-call")).toHaveTextContent("403")
    expect(screen.getByTestId("route-token")).toHaveTextContent("Doorbell")
    fireEvent.change(screen.getByLabelText("Who the new token is for"), { target: { value: "Grafana" } })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New token" })))
    expect(calls).toContainEqual(["module-routes/hooks/tokens", { name: "hook", label: "Grafana" }])
    expect(screen.getByTestId("minted-token")).toHaveTextContent("s3cret-value-shown-once")
  })
})
