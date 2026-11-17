import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { StrictMode, useState } from "react"
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
    const errors: Array<string | undefined> = []
    render(<Harness key="again" field={greetings} initial={[]} onError={(m) => errors.push(m)} />)
    const other = screen.getAllByRole("textbox").at(-1)!
    fireEvent.change(other, { target: { value: "far too long a word" } })
    fireEvent.keyDown(other, { key: "Enter" })
    expect(errors.at(-1)).toMatch(/^Not added: .*is longer than 10 characters/)
    expect(other).toHaveValue("far too long a word")
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
    const second = within(list).getAllByTestId("record")[1]!
    expect(within(second).getByTestId("record-form")).toBeVisible()
    fireEvent.change(within(second).getByLabelText("Name"), { target: { value: "Hall" } })
    expect(values.at(-1)).toEqual([{ name: "Kitchen", aliases: ["keuken"], dim: false }, { name: "Hall", aliases: [], dim: false }])
    fireEvent.click(within(second).getByRole("switch"))
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
    tokensLocked: false,
    behindProxy: false
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

// ---------------------------------------------------------------------------------------------------------------------
// Review round 1 (PR 90).

const levels: Extract<SettingField, { type: "records" }> = {
  type: "records",
  key: "levels",
  label: "Levels",
  apply: "live",
  default: [],
  itemFields: [
    { type: "text", key: "name", label: "Name", default: "" },
    { type: "number", key: "low", label: "Low", default: 1, integer: true },
    { type: "number", key: "high", label: "High", default: 9, integer: true }
  ],
  itemLabel: "level",
  titleKey: "name",
  orderable: true
}

/** The button that opens and closes a record row. */
const toggle = (row: HTMLElement) => row.querySelector<HTMLElement>("[aria-expanded]")!

describe("records after review round 1", () => {
  it("keeps each field's problem until it is fixed or its row removed, and names the row", () => {
    const errors: Array<string | undefined> = []
    render(<Harness field={levels} initial={[{ name: "A", low: 1, high: 9 }, { name: "B", low: 2, high: 8 }]} onError={(m) => errors.push(m)} />)
    const [a, b] = screen.getAllByTestId("record")
    fireEvent.click(toggle(a!))
    fireEvent.change(within(a!).getByLabelText("Low"), { target: { value: "" } })
    expect(errors.at(-1)).toMatch(/^Level 1, Low: /)
    // A valid edit of another field of the same row does not clear it.
    fireEvent.change(within(a!).getByLabelText("High"), { target: { value: "7" } })
    expect(errors.at(-1)).toMatch(/^Level 1, Low: /)
    expect(within(a!).getByLabelText("Low")).toHaveAttribute("aria-invalid", "true")
    expect(within(a!).getByTestId("record-field-error")).toBeInTheDocument()
    // Closing the row keeps the typed text and the problem (marked on the row).
    fireEvent.click(toggle(a!))
    expect(a).toHaveAttribute("data-invalid", "true")
    expect(errors.at(-1)).toMatch(/^Level 1/)
    // Moving rows keeps the problem with its row (now row 2).
    fireEvent.click(within(b!).getByRole("button", { name: "Move B up" }))
    expect(errors.at(-1)).toMatch(/^Level 2, Low: /)
    // Removing that row removes its problem.
    fireEvent.click(screen.getByRole("button", { name: "Remove A" }))
    expect(errors.at(-1)).toBeUndefined()
  })

  it("keeps the open row open when a closed neighbour moves into its place", () => {
    render(<Harness field={levels} initial={[{ name: "A", low: 1, high: 9 }, { name: "B", low: 2, high: 8 }]} />)
    fireEvent.click(toggle(screen.getAllByTestId("record")[0]!))
    fireEvent.change(within(screen.getAllByTestId("record")[0]!).getByLabelText("Low"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Move B up" }))
    const [first, second] = screen.getAllByTestId("record")
    expect(first).toHaveTextContent("B")
    expect(toggle(first!)).toHaveAttribute("aria-expanded", "false")
    expect(toggle(second!)).toHaveAttribute("aria-expanded", "true")
    expect(second).toHaveTextContent("A")
    // Its typed text went with it.
    expect(within(second!).getByLabelText("Low")).toHaveValue(null)
  })
})

describe("action buttons after review round 1", () => {
  it("finish a press under StrictMode, and a second one too", async () => {
    let finish: (v: unknown) => void = () => undefined
    const request = vi.fn(() => new Promise((resolve) => (finish = resolve))) as unknown as AssistantClient["request"]
    withClient(request, <StrictMode><Harness field={allOff} initial={undefined} context={{ form: { kind: "module", id: "demo-home" }, dirty: false, draftValues: {} }} /></StrictMode>)
    const button = screen.getByRole("button", { name: "Switch everything off" })
    for (const text of ["Switched 2 lights off.", "Every light was already off."]) {
      fireEvent.click(button)
      expect(button).toBeDisabled()
      await act(async () => finish({ type: "result", requestId: "r", ok: true, action: { ok: true, text, tone: "ok" } }))
      expect(screen.getByTestId("action-result")).toHaveTextContent(text)
      expect(button).toBeEnabled()
    }
  })

  it("free the button when the request itself fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("closed")
    }) as unknown as AssistantClient["request"]
    withClient(request, <Harness field={allOff} initial={undefined} context={{ form: { kind: "module", id: "demo-home" }, dirty: false, draftValues: {} }} />)
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Switch everything off" })))
    expect(screen.getByTestId("action-result")).toHaveTextContent("No answer from the assistant")
    expect(screen.getByRole("button", { name: "Switch everything off" })).toBeEnabled()
  })
})

describe("module routes view after review round 1", () => {
  const route = (path: string, token: string) => ({
    method: "POST" as const,
    path: `/api/modules/hooks/${path}`,
    guards: ["token" as const],
    public: false,
    token,
    bodyLimitBytes: 8192,
    ratePerMinute: { perAddress: 30, total: 120 }
  })
  const base: ModuleInfo = {
    id: "hooks",
    name: "Hooks",
    description: "",
    enabled: true,
    state: "running",
    tools: [],
    settings: { fields: [], values: {}, secrets: {}, errors: [] },
    revision: 1
  }
  const apiWith = (view: ModuleRoutesResponse, calls: Array<[string, unknown]>): VoiceApi => ({
    request: async (path, init) => {
      calls.push([path, init?.body])
      const name = (init?.body as { name?: string } | undefined)?.name ?? "hook"
      const body = path.endsWith("/tokens")
        ? { token: { id: "0f0f0f0f0f0f", moduleId: "hooks", name, label: "Uploader", createdAt: 1 }, secret: "s3cret-value-shown-once" }
        : init?.method === "DELETE" ? { revoked: true } : view
      return new Response(JSON.stringify(body), { status: 200 })
    }
  })

  it("mints a token for the purpose chosen, and shows each token's purpose", async () => {
    const module = { ...base, routes: [route("hook", "hook"), route("upload", "upload")] }
    const view: ModuleRoutesResponse = {
      modules: [{ moduleId: "hooks", running: true, routes: module.routes.map((r) => ({ ...r, calls: [] })), tokens: [{ id: "a1b2c3d4e5f6", moduleId: "hooks", name: "hook", label: "Doorbell", createdAt: 0 }] }],
      tokensLocked: false,
      behindProxy: false
    }
    const calls: Array<[string, unknown]> = []
    await act(async () => void render(<ModuleRoutes module={module} api={apiWith(view, calls)} />))
    expect(screen.getByTestId("route-token-name")).toHaveTextContent("hook")
    fireEvent.change(screen.getByLabelText("What the new token is for"), { target: { value: "upload" } })
    fireEvent.change(screen.getByLabelText("Who the new token is for"), { target: { value: "Uploader" } })
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New token" })))
    expect(calls).toContainEqual(["module-routes/hooks/tokens", { name: "upload", label: "Uploader" }])
    expect(screen.getByTestId("minted-token")).toHaveTextContent("“upload” token for Uploader")
  })

  it("shows a stopped module's tokens, to be revoked, and marks lan routes unreachable behind a proxy", async () => {
    const stopped = { ...base, state: "off" as const, enabled: false }
    const view: ModuleRoutesResponse = {
      modules: [{ moduleId: "hooks", running: false, routes: [], tokens: [{ id: "a1b2c3d4e5f6", moduleId: "hooks", name: "hook", label: "Doorbell", createdAt: 0 }] }],
      tokensLocked: false,
      behindProxy: false
    }
    const calls: Array<[string, unknown]> = []
    vi.spyOn(window, "confirm").mockReturnValue(true)
    await act(async () => void render(<ModuleRoutes module={stopped} api={apiWith(view, calls)} />))
    expect(screen.getByTestId("routes-stopped")).toBeInTheDocument()
    expect(screen.getByTestId("route-token")).toHaveTextContent("Doorbell")
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Revoke" })))
    expect(calls.map((c) => c[0])).toContain("module-routes/hooks/tokens/a1b2c3d4e5f6")

    const lan = { ...base, routes: [{ ...route("hook", "hook"), guards: ["lan" as const], token: undefined as never }] }
    const { token: _t, ...lanRoute } = lan.routes[0]!
    const proxied: ModuleRoutesResponse = { modules: [{ moduleId: "hooks", running: true, routes: [{ ...lanRoute, calls: [] }], tokens: [] }], tokensLocked: false, behindProxy: true }
    await act(async () => void render(<ModuleRoutes module={{ ...base, routes: [lanRoute] }} api={apiWith(proxied, [])} />))
    expect(screen.getByTestId("route-unreachable")).toHaveTextContent("SERVE_BEHIND_PROXY")
  })
})
