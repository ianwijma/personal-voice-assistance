import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { DeviceListInfo, DeviceTypeInfo } from "@pva/protocol"
import { exampleAssistantInfo, exampleAssistantT3, exampleDevice, exampleDeviceType, serverExamples } from "@pva/protocol/examples"
import type { Outcome } from "@/lib/assistants.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { typePageId } from "@/lib/settingsTree.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { DevicePage } from "@/components/settings/pages/DevicesPages.tsx"

// PR #35 review 8: the server answers a save before it pushes the lists with the new revision. A save is over only when
// that revision has reached the editor's base; until then the editor stays inert, and it never stays locked.

const from = exampleDevice.settings.matching
const to = from === "close" ? "exact" : "close"
const label = (v: string) => (v === "close" ? "Close" : "Exact")

/** The device as the server pushes it once the matching change is saved at `rev`. */
const savedDevice = (rev: number): DeviceListInfo => ({ ...exampleDevice, own: { ...exampleDevice.own, matching: to }, settings: { ...exampleDevice.settings, matching: to }, rev })
const savedType = (rev: number): DeviceTypeInfo => ({ ...exampleDeviceType, settings: { ...exampleDeviceType.settings, matching: to }, rev })

const setup = (page: "device" | "type" = "device") => {
  const store = createStore(
    {
      ...initialState,
      deviceTypes: [exampleDeviceType],
      devices: [exampleDevice],
      assistants: [exampleAssistantInfo, { ...exampleAssistantT3, usedOn: [], resources: { llm: "ready", voice: "ready" }, problems: [] }],
      ui: { ...initialState.ui, settingsOpen: true, settingsPath: ["devices", page === "device" ? exampleDevice.id : typePageId(exampleDeviceType.kind)] }
    },
    reducer
  )
  let answer: (o: Outcome) => void = () => {}
  const saveDevice = vi.fn<(...args: ReadonlyArray<unknown>) => Promise<Outcome>>(() => new Promise<Outcome>((resolve) => (answer = resolve)))
  const client = { store, saveDevice, settings: vi.fn(), wakeTest: vi.fn(async () => ({ type: "result", requestId: "r", ok: true })) } as unknown as AssistantClient
  render(<ClientContext.Provider value={client}><DevicePage /></ClientContext.Provider>)
  const editor = () => screen.getByTestId("device-editor")
  const busy = () => editor().getAttribute("aria-busy") === "true"
  const matching = (v: string) => within(screen.getByTestId("seg-matching")).getByRole("radio", { name: label(v) })
  const pick = (v: string) => fireEvent.click(matching(v))
  const checked = () => (matching(to).getAttribute("aria-checked") === "true" ? to : from)
  const saveButton = () => screen.queryByRole("button", { name: "Save" }) as HTMLButtonElement | null
  const dirty = () => store.get().ui.settingsDirty
  /** Change matching and click Save; the answer is held until `respond`. */
  const send = async () => {
    pick(to)
    await act(async () => {
      fireEvent.click(saveButton()!)
    })
    expect(saveDevice).toHaveBeenCalledTimes(1)
    expect(busy()).toBe(true)
  }
  const respond = async (o: Outcome) => {
    await act(async () => {
      answer(o)
    })
  }
  const push = (m: Parameters<typeof store.dispatch>[0]) =>
    act(() => {
      store.dispatch(m)
    })
  return { store, saveDevice, busy, pick, checked, saveButton, dirty, send, respond, push }
}

describe("Device editor: a save is over when its revision has arrived", () => {
  it("the reviewer's case: answer first, push later; setting the old value back in between is not lost", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "ok", rev: exampleDevice.rev + 1 })
    // The answer is here, the revision is not: still inert, and a change is not taken (it would be judged against the old base).
    expect(t.busy()).toBe(true)
    t.pick(from)
    expect(t.checked()).toBe(to)
    await t.push({ type: "devices", devices: [savedDevice(exampleDevice.rev + 1)] })
    expect(t.busy()).toBe(false)
    expect(t.checked()).toBe(to)
    expect(t.dirty()).toBe(false)
    // Now setting the old value back is an edit against the saved one: shown, unsaved, and Save sends it.
    t.pick(from)
    expect(t.checked()).toBe(from)
    expect(t.dirty()).toBe(true)
    expect(t.saveButton()!.disabled).toBe(false)
  })

  it("the push came before the answer: free at once, clean", async () => {
    const t = setup()
    await t.send()
    await t.push({ type: "devices", devices: [savedDevice(exampleDevice.rev + 1)] })
    expect(t.busy()).toBe(true)
    await t.respond({ kind: "ok", rev: exampleDevice.rev + 1 })
    expect(t.busy()).toBe(false)
    expect(t.checked()).toBe(to)
    expect(t.dirty()).toBe(false)
  })

  it("a save that made no new revision (the answer's rev is the one the editor has): free at once", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "ok", rev: exampleDevice.rev })
    expect(t.busy()).toBe(false)
  })

  it("an answer without a revision (an older server): free at once, as before", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "ok" })
    expect(t.busy()).toBe(false)
  })

  it("a refused save: free at once, the edit kept", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "refused", code: "internal", message: "No." })
    expect(t.busy()).toBe(false)
    expect(t.checked()).toBe(to)
    expect(t.dirty()).toBe(true)
  })

  it("a push that does not carry the revision (another device's list change) keeps it inert", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "ok", rev: exampleDevice.rev + 1 })
    await t.push({ type: "devices", devices: [{ ...exampleDevice, lastSeen: exampleDevice.lastSeen + 1 }] })
    expect(t.busy()).toBe(true)
    await t.push({ type: "devices", devices: [savedDevice(exampleDevice.rev + 1)] })
    expect(t.busy()).toBe(false)
  })

  it("a later revision than the saved one (another change on top) also ends it, clean", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "ok", rev: exampleDevice.rev + 1 })
    await t.push({ type: "devices", devices: [{ ...savedDevice(exampleDevice.rev + 2), name: "Renamed elsewhere" }] })
    expect(t.busy()).toBe(false)
    expect(t.checked()).toBe(to)
    expect(t.dirty()).toBe(false)
  })

  it("the device is forgotten meanwhile: the editor goes, nothing stays locked or dirty", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "ok", rev: exampleDevice.rev + 1 })
    await t.push({ type: "devices", devices: [] })
    expect(screen.queryByTestId("device-editor")).toBeNull()
    expect(screen.getByTestId("unknown-device")).toBeInTheDocument()
    expect(t.dirty()).toBe(false)
  })

  it("a reconnect whose snapshot has the saved revision: free, clean", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "ok", rev: exampleDevice.rev + 1 })
    await t.push({ type: "local/connection", status: "reconnecting", attempt: 1 })
    expect(t.busy()).toBe(true)
    await t.push({ ...serverExamples.welcome, snapshot: { ...serverExamples.welcome.snapshot, admin: { enabled: true, loggedIn: true } } })
    expect(t.busy()).toBe(true)
    await t.push({ type: "devices", devices: [savedDevice(exampleDevice.rev + 1)] })
    expect(t.busy()).toBe(false)
    expect(t.dirty()).toBe(false)
  })

  it("a reconnect whose snapshot does not have it (the save never happened): free, and the edit is unsaved again", async () => {
    const t = setup()
    await t.send()
    await t.respond({ kind: "ok", rev: exampleDevice.rev + 1 })
    await t.push({ ...serverExamples.welcome, snapshot: { ...serverExamples.welcome.snapshot, admin: { enabled: true, loggedIn: true } } })
    expect(t.busy()).toBe(true)
    await t.push({ type: "devices", devices: [{ ...exampleDevice }] })
    expect(t.busy()).toBe(false)
    expect(t.checked()).toBe(to)
    expect(t.dirty()).toBe(true)
  })

  it("the defaults page waits for the type's revision the same way", async () => {
    const t = setup("type")
    await t.send()
    await t.respond({ kind: "ok", rev: exampleDeviceType.rev + 1 })
    expect(t.busy()).toBe(true)
    t.pick(from)
    expect(t.checked()).toBe(to)
    await t.push({ type: "device.types", types: [savedType(exampleDeviceType.rev + 1)] })
    expect(t.busy()).toBe(false)
    t.pick(from)
    expect(t.checked()).toBe(from)
    expect(t.dirty()).toBe(true)
  })
})
