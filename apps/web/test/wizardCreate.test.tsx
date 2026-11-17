import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Outcome } from "@/lib/assistants.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { navigateSettings } from "@/lib/settingsTree.ts"
import { exampleAssistantInfo } from "@pva/protocol/examples"
import { blankAssistantBody } from "@/lib/assistants.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { NewAssistantWizard } from "@/components/settings/pages/NewAssistantWizard.tsx"

// The voice catalog fetches from the server; the wizard only needs a voice's name.
vi.mock("@/components/settings/pages/AssistantsPage.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/settings/pages/AssistantsPage.tsx")>()),
  useVoiceNameOf: () => () => undefined
}))

const setup = (createAssistant: (...args: ReadonlyArray<unknown>) => Promise<Outcome>, assistants: typeof initialState.assistants = []) => {
  const store = createStore({ ...initialState, assistants, ui: { ...initialState.ui, settingsOpen: true, settingsPath: ["assistants", "new", "1"] } }, reducer)
  const create = vi.fn(createAssistant)
  const settings = vi.fn((to: Parameters<AssistantClient["settings"]>[0], options?: { readonly discard?: boolean }) =>
    store.dispatch({ type: "local/ui", patch: navigateSettings(store.get().ui, to, options?.discard === true) })
  )
  const client = { store, settings, createAssistant: create } as unknown as AssistantClient
  const { unmount } = render(<ClientContext.Provider value={client}><NewAssistantWizard /></ClientContext.Provider>)
  /** The step as the browser's back and forward buttons change it: not through the wizard. */
  const toStep = (n: number) => act(() => store.dispatch({ type: "local/ui", patch: { settingsPath: ["assistants", "new", String(n)] } }))
  return { store, create, settings, toStep, unmount }
}

const nameField = () => screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement
const createButton = () => screen.getByTestId("wizard-create") as HTMLButtonElement

describe("New assistant wizard while it creates (PR #35 review 3, finding 1)", () => {
  it("ignores edits and step changes while the create is on its way, so what it lands on is what was sent", async () => {
    let answer: (o: Outcome) => void = () => undefined
    const { create, settings, toStep } = setup(() => new Promise<Outcome>((resolve) => { answer = resolve }))
    fireEvent.change(nameField(), { target: { value: "Mia" } })
    expect(nameField().value).toBe("Mia")
    toStep(7)
    await act(async () => {
      fireEvent.click(createButton())
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect((create.mock.calls[0]![0] as { readonly name: string }).name).toBe("Mia")
    expect(screen.getByTestId("wizard").getAttribute("aria-busy")).toBe("true")
    expect(createButton().disabled).toBe(true)

    // Check's Edit and Back do not move while it creates.
    fireEvent.click(screen.getByRole("button", { name: "Edit Start" }))
    fireEvent.click(screen.getByTestId("wizard-back"))
    expect(settings).not.toHaveBeenCalled()
    // A rename on Start (reached with the browser's back button) is not taken.
    toStep(1)
    fireEvent.change(nameField(), { target: { value: "Zed" } })
    expect(nameField().value).toBe("Mia")

    await act(async () => {
      answer({ kind: "ok", assistantId: "mia" })
    })
    expect(settings).toHaveBeenCalledWith(["assistants", "mia"], { discard: true })
  })

  it("a create that fails gives the wizard back: an error, Create and the steps work again", async () => {
    const { create, settings } = setup(() => Promise.reject(new Error("encode failed")))
    fireEvent.change(nameField(), { target: { value: "Mia" } })
    fireEvent.click(screen.getByTestId("wizard-next"))
    expect(settings).toHaveBeenLastCalledWith(["assistants", "new", "2"])
    act(() => settings(["assistants", "new", "7"]))
    await act(async () => {
      fireEvent.click(createButton())
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("create-error").textContent).toBe("Could not create it. Try again.")
    expect(screen.getByTestId("wizard").getAttribute("aria-busy")).toBe("false")
    expect(createButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Edit Start" }))
    expect(settings).toHaveBeenLastCalledWith(["assistants", "new", "1"])
    fireEvent.change(nameField(), { target: { value: "Zed" } })
    expect(nameField().value).toBe("Zed")
  })
})

describe("New assistant wizard left while it creates (PR #35 review 4, finding 2)", () => {
  /** Name Mia, go to Check and send Create with the answer held; then leave the wizard (it unmounts) before it comes. */
  const leaveWhileCreating = async () => {
    let answer: (o: Outcome) => void = () => undefined
    const s = setup(() => new Promise<Outcome>((resolve) => { answer = resolve }))
    fireEvent.change(nameField(), { target: { value: "Mia" } })
    s.toStep(7)
    await act(async () => {
      fireEvent.click(createButton())
    })
    expect(s.create).toHaveBeenCalledTimes(1)
    // The sidebar opens a device; the wizard is gone.
    act(() => s.store.dispatch({ type: "local/ui", patch: { settingsPath: ["devices", "kitchen"] } }))
    s.unmount()
    return { ...s, answer: (o: Outcome) => act(async () => answer(o)) }
  }

  it("a late success does not navigate (it would discard the page shown now), but still says it was created", async () => {
    const { settings, store, answer } = await leaveWhileCreating()
    await answer({ kind: "ok", assistantId: "mia" })
    expect(settings).not.toHaveBeenCalled()
    expect(store.get().ui.settingsPath).toEqual(["devices", "kitchen"])
    expect(store.get().toasts.some((t) => t.message === "Created Mia.")).toBe(true)
  })

  it("a late refusal does not go back to a wizard step", async () => {
    const { settings, store, answer } = await leaveWhileCreating()
    await answer({ kind: "invalid", message: "Not valid.", fieldErrors: [{ key: "name", message: "Taken." }] })
    expect(settings).not.toHaveBeenCalled()
    expect(store.get().ui.settingsPath).toEqual(["devices", "kitchen"])
  })
})

// PR #35 review 6, finding 1: Start from › Blank is not an assistant id, so an assistant called Blank (id `blank`) is
// a copy like any other and choosing Blank gives the defaults.
describe("New assistant wizard: Start from Blank next to an assistant called Blank", () => {
  const custom = { ...exampleAssistantInfo, id: "blank", name: "Blank", prompt: "You are the custom Blank." }
  const other = { ...exampleAssistantInfo, id: "t3", name: "T3", prompt: "You are T3." }
  const radio = (value: string) => document.querySelector<HTMLElement>(`[role="radio"][data-value="${value}"]`)
  const radios = () => [...document.querySelectorAll<HTMLElement>('[role="radio"]')]

  it("lists Blank and Copy of Blank as two choices; Blank after a copy restores the defaults and sends no copyOf", async () => {
    const { create, toStep } = setup(() => new Promise<Outcome>(() => undefined), [custom, other])
    const values = radios().map((r) => r.dataset.value)
    expect(new Set(values).size).toBe(values.length)
    expect(radios().filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1)
    expect(radios().find((r) => r.getAttribute("aria-checked") === "true")?.textContent).not.toMatch(/Copy of/)

    fireEvent.change(nameField(), { target: { value: "Mia" } })
    fireEvent.click(radio("t3")!)
    expect(radio("t3")!.getAttribute("aria-checked")).toBe("true")
    // Back to Blank: the first card, not the assistant called Blank.
    const blankCard = radios().find((r) => !(r.textContent ?? "").includes("Copy of"))!
    fireEvent.click(blankCard)
    expect(blankCard.getAttribute("aria-checked")).toBe("true")
    expect(radio("blank")!.getAttribute("aria-checked")).toBe("false")

    toStep(7)
    expect(screen.getByTestId("check-list").textContent).toContain("Started blank")
    await act(async () => {
      fireEvent.click(createButton())
    })
    const [body, options] = create.mock.calls[0]! as [{ readonly prompt: string }, { readonly copyOf?: string }]
    expect(options.copyOf).toBeUndefined()
    expect(body.prompt).toBe(blankAssistantBody("").prompt)
    expect(body.prompt).not.toBe(custom.prompt)
  })

  it("Copy of Blank copies the assistant called Blank and says so on Check", async () => {
    const { create, toStep } = setup(() => new Promise<Outcome>(() => undefined), [custom, other])
    fireEvent.change(nameField(), { target: { value: "Mia" } })
    fireEvent.click(radio("blank")!)
    toStep(7)
    expect(screen.getByTestId("check-list").textContent).toContain("Copy of Blank")
    expect(screen.getByTestId("check-list").textContent).not.toContain("Started blank")
    await act(async () => {
      fireEvent.click(createButton())
    })
    const [body, options] = create.mock.calls[0]! as [{ readonly prompt: string }, { readonly copyOf?: string }]
    expect(options.copyOf).toBe("blank")
    expect(body.prompt).toBe(custom.prompt)
  })
})
