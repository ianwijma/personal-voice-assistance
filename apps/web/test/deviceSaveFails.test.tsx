import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { exampleAssistantInfo, exampleAssistantT3, exampleDevice, exampleDeviceType } from "@pva/protocol/examples"
import type { Outcome } from "@/lib/assistants.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { DevicePage } from "@/components/settings/pages/DevicesPages.tsx"

// PR #35 review 3 (round 2's note): a save that throws instead of answering must not leave the device editor locked.
describe("Device editor: a save that fails", () => {
  it("gives the editor back with the draft and an error; Save works again", async () => {
    const store = createStore(
      {
        ...initialState,
        deviceTypes: [exampleDeviceType],
        devices: [exampleDevice],
        assistants: [exampleAssistantInfo, { ...exampleAssistantT3, usedOn: [], resources: { llm: "ready", voice: "ready" }, problems: [] }],
        ui: { ...initialState.ui, settingsOpen: true, settingsPath: ["devices", exampleDevice.id] }
      },
      reducer
    )
    const saveDevice = vi.fn<(...args: ReadonlyArray<unknown>) => Promise<Outcome>>()
      .mockRejectedValueOnce(new Error("encode failed"))
      .mockResolvedValueOnce({ kind: "ok" })
    const client = { store, saveDevice, settings: vi.fn(), wakeTest: vi.fn(async () => ({ type: "result", requestId: "r", ok: true })) } as unknown as AssistantClient
    const { container } = render(<ClientContext.Provider value={client}><DevicePage /></ClientContext.Provider>)
    const name = () => container.querySelector<HTMLInputElement>("#device-name")!
    const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement
    const editor = () => screen.getByTestId("device-editor")

    fireEvent.change(name(), { target: { value: "Kitchen" } })
    await act(async () => {
      fireEvent.click(save())
    })
    expect(saveDevice).toHaveBeenCalledTimes(1)
    expect(editor().getAttribute("aria-busy")).toBe("false")
    expect(editor().hasAttribute("inert")).toBe(false)
    expect(screen.getByText("Could not save. Try again.")).toBeInTheDocument()
    expect(name().value).toBe("Kitchen")
    // Still editable, and Save sends again.
    fireEvent.change(name(), { target: { value: "Kitchen 2" } })
    expect(name().value).toBe("Kitchen 2")
    expect(save().disabled).toBe(false)
    await act(async () => {
      fireEvent.click(save())
    })
    expect(saveDevice).toHaveBeenCalledTimes(2)
    expect((saveDevice.mock.calls[1]![3] as { readonly name?: string }).name).toBe("Kitchen 2")
  })
})
