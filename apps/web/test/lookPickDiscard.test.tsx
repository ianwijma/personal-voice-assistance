import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { AssistantInfo, DeviceListInfo, Look } from "@pva/protocol"
import { exampleAssistantInfo, exampleAssistantT3, exampleDevice, exampleDeviceType } from "@pva/protocol/examples"
import type { Loaded } from "@/characters/catalog.ts"
import { registry } from "@/characters/registry.ts"
import type { Outcome } from "@/lib/assistants.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"

// PR #84 review 4: a character still loading must not land on a draft that was discarded, reset or saved since it was
// picked, also when the look itself is unchanged by that (Cancel only put back another field). The chunk loads are
// held here, so the test decides when each one arrives.
const held = vi.hoisted(() => new Map<string, (r: Loaded) => void>())
vi.mock("@/characters/catalog.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/characters/catalog.ts")>()
  return {
    ...real,
    loadCharacter: (id: string) => (id === registry.baseline.id ? real.loadCharacter(id) : new Promise<Loaded>((resolve) => held.set(id, resolve)))
  }
})
vi.mock("@/components/looks/LookPreview.tsx", () => ({ LookPreview: () => null }))
vi.mock("@/components/looks/CharacterPicker.tsx", () => ({
  CharacterPicker: ({ ids, onPick }: { readonly ids: ReadonlyArray<string>; readonly onPick: (id: string) => void }) => (
    <div>{ids.map((id) => <button key={id} type="button" data-testid={`pick-${id}`} onClick={() => onPick(id)}>{id}</button>)}</div>
  )
}))

const { ClientContext } = await import("@/components/context.tsx")
const { LookTab } = await import("@/components/settings/pages/assistants/LookTab.tsx")
const { useAssistantDraft } = await import("@/components/settings/pages/assistants/useAssistantDraft.ts")
const { DevicePage } = await import("@/components/settings/pages/DevicesPages.tsx")

const flame = { ...registry.baseline, id: "flame", name: "Flame", version: "1.0.0" }
const arrive = async () => {
  await act(async () => {
    held.get("flame")!({ kind: "ready", character: flame })
    await Promise.resolve()
  })
}

describe("Assistant › Look: a pick still loading is dropped by Cancel, Reset and Save, with the look unchanged", () => {
  const info: AssistantInfo = { ...exampleAssistantInfo, usedOn: [] }
  const setup = () => {
    held.clear()
    const store = createStore({ ...initialState, assistants: [info] }, reducer)
    const saveAssistant = vi.fn(async (..._args: ReadonlyArray<unknown>): Promise<Outcome> => ({ kind: "ok" }))
    const client = { store, saveAssistant } as unknown as AssistantClient
    const out: { draft?: ReturnType<typeof useAssistantDraft> } = {}
    function Page() {
      const draft = useAssistantDraft(info)
      out.draft = draft
      return (
        <>
          <button type="button" onClick={() => draft.set("purpose", "Something else")}>Edit purpose</button>
          <button type="button" onClick={() => draft.cancel()}>Cancel</button>
          <button type="button" onClick={() => draft.reset("purpose")}>Reset purpose</button>
          <button type="button" onClick={() => void draft.save()}>Save</button>
          <LookTab draft={draft} info={info} />
        </>
      )
    }
    render(<ClientContext.Provider value={client}><Page /></ClientContext.Provider>)
    const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }))
    return { out, click, saveAssistant }
  }

  it("the reviewer's case: purpose edited, Flame picked, Cancel before it has loaded: no look edit afterwards", async () => {
    const t = setup()
    t.click("Edit purpose")
    fireEvent.click(screen.getByTestId("pick-flame"))
    t.click("Cancel")
    expect(t.out.draft!.dirty).toBe(false)
    await arrive()
    expect(t.out.draft!.dirty).toBe(false)
    expect(t.out.draft!.current.look).toBeUndefined()
    expect(screen.getByTestId("look-editor").getAttribute("data-character")).toBe(registry.baseline.id)
  })

  it("Reset of another field before it has loaded: dropped too", async () => {
    const t = setup()
    t.click("Edit purpose")
    fireEvent.click(screen.getByTestId("pick-flame"))
    t.click("Reset purpose")
    await arrive()
    expect(t.out.draft!.dirty).toBe(false)
    expect(t.out.draft!.current.look).toBeUndefined()
  })

  it("Save sent before it has loaded: the saved draft gets no look edit afterwards", async () => {
    const t = setup()
    t.click("Edit purpose")
    fireEvent.click(screen.getByTestId("pick-flame"))
    await act(async () => {
      t.click("Save")
    })
    expect(t.saveAssistant).toHaveBeenCalledTimes(1)
    await arrive()
    expect(t.out.draft!.current.look).toBeUndefined()
    expect(t.out.draft!.dirty).toBe(false)
  })

  it("with nothing put back in between, the pick still lands", async () => {
    const t = setup()
    t.click("Edit purpose")
    fireEvent.click(screen.getByTestId("pick-flame"))
    await arrive()
    expect(t.out.draft!.current.look?.character).toBe("flame")
    expect(t.out.draft!.current.purpose).toBe("Something else")
  })
})

describe("Device › Look: a pick still loading is dropped by Cancel of another section", () => {
  const own: Look = { character: registry.baseline.id }
  const device: DeviceListInfo = {
    ...exampleDevice,
    own: { ...exampleDevice.own, look: { from: "device", look: own } },
    settings: { ...exampleDevice.settings, look: { from: "device", look: own } }
  }
  const setup = () => {
    held.clear()
    const store = createStore(
      {
        ...initialState,
        deviceTypes: [exampleDeviceType],
        devices: [device],
        assistants: [exampleAssistantInfo, { ...exampleAssistantT3, usedOn: [], resources: { llm: "ready", voice: "ready" }, problems: [] }],
        ui: { ...initialState.ui, settingsOpen: true, settingsPath: ["devices", device.id] }
      },
      reducer
    )
    const saveDevice = vi.fn(async (..._args: ReadonlyArray<unknown>): Promise<Outcome> => ({ kind: "ok", rev: device.rev + 1 }))
    const client = { store, saveDevice, settings: vi.fn(), wakeTest: vi.fn(async () => ({ type: "result", requestId: "r", ok: true })) } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><DevicePage /></ClientContext.Provider>)
    const character = () => screen.getByTestId("look-editor").getAttribute("data-character")
    const dirty = () => store.get().ui.settingsDirty
    return { character, dirty, saveDevice, store }
  }

  it("the reviewer's case: name edited, Flame picked, Cancel before it has loaded: no look edit afterwards", async () => {
    const t = setup()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hall tablet" } })
    expect(t.dirty()).toBe(true)
    fireEvent.click(screen.getByTestId("pick-flame"))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(t.dirty()).toBe(false)
    await arrive()
    expect(t.dirty()).toBe(false)
    expect(t.character()).toBe(registry.baseline.id)
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(device.name)
  })

  it("Save sent before it has loaded: no look edit lands afterwards", async () => {
    const t = setup()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hall tablet" } })
    fireEvent.click(screen.getByTestId("pick-flame"))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })
    expect(t.saveDevice).toHaveBeenCalledTimes(1)
    // The saved revision arrives: the editor is free again before the chunk is.
    act(() => {
      t.store.dispatch({ type: "devices", devices: [{ ...device, name: "Hall tablet", rev: device.rev + 1 }] })
    })
    expect(screen.getByTestId("device-editor").getAttribute("aria-busy")).not.toBe("true")
    await arrive()
    expect(t.character()).toBe(registry.baseline.id)
    expect(t.dirty()).toBe(false)
  })

  it("with nothing put back in between, the pick still lands", async () => {
    const t = setup()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Hall tablet" } })
    fireEvent.click(screen.getByTestId("pick-flame"))
    await arrive()
    expect(t.character()).toBe("flame")
  })
})
