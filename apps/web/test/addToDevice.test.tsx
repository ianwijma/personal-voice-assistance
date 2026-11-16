import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { type Assignment, type DeviceListInfo, MAX_ASSIGNMENTS } from "@pva/protocol"
import { exampleAssistantInfo, exampleDevice } from "@pva/protocol/examples"
import type { Outcome } from "@/lib/assistants.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { AddToDeviceDialog, addToDeviceProblem } from "@/components/settings/pages/assistants/dialogs.tsx"

/** A device Jeff is not on yet (the example assistant is on the example device and on the browser defaults). */
const kitchen = (assistants: ReadonlyArray<Assignment> = exampleDevice.settings.assistants): DeviceListInfo => ({
  ...exampleDevice,
  id: "d-kitchen0001",
  name: "Kitchen",
  settings: { ...exampleDevice.settings, assistants }
})

const setup = (device: DeviceListInfo, saveDevice: (...args: ReadonlyArray<unknown>) => Promise<Outcome>) => {
  const store = createStore({ ...initialState, devices: [device] }, reducer)
  const save = vi.fn(saveDevice)
  const client = { store, saveDevice: save } as unknown as AssistantClient
  const onClose = vi.fn()
  render(<ClientContext.Provider value={client}><AddToDeviceDialog info={exampleAssistantInfo} onClose={onClose} /></ClientContext.Provider>)
  return { save, onClose }
}

const confirm = () => screen.getByTestId("dialog-confirm") as HTMLButtonElement
const cancel = () => screen.getByText("Cancel") as HTMLButtonElement

describe("Add to a device (PR #34 review 2, finding 1)", () => {
  it("a phrase without words is not sent: the dialog says so and stays usable; a corrected phrase is sent", async () => {
    const { save, onClose } = setup(kitchen(), async () => ({ kind: "ok" }))
    fireEvent.change(screen.getByLabelText("Wake phrase"), { target: { value: "!!!" } })
    fireEvent.click(confirm())
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByTestId("add-device-message").textContent).toMatch(/at least one word/)
    expect(confirm().disabled).toBe(false)
    expect(cancel().disabled).toBe(false)
    fireEvent.change(screen.getByLabelText("Wake phrase"), { target: { value: "hey jeff" } })
    await act(async () => {
      fireEvent.click(confirm())
    })
    expect(save).toHaveBeenCalledTimes(1)
    const [target, , settings] = save.mock.calls[0]!
    expect(target).toEqual({ kind: "device", id: "d-kitchen0001" })
    expect((settings as { assistants: ReadonlyArray<Assignment> }).assistants.at(-1)).toEqual({ assistant: "jeff", phrases: ["hey jeff"] })
    expect(onClose).toHaveBeenCalled()
  })

  it("a device with a full list is not sent to", () => {
    const full = Array.from({ length: MAX_ASSIGNMENTS }, (_, i): Assignment => ({ assistant: `a${i}`, phrases: [] }))
    const { save } = setup(kitchen(full), async () => ({ kind: "ok" }))
    fireEvent.click(confirm())
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByTestId("add-device-message").textContent).toMatch(/Kitchen has 8 assistants already/)
    expect(confirm().disabled).toBe(false)
  })

  it("a request that fails gives the controls back and says it did not add", async () => {
    const { save, onClose } = setup(kitchen(), () => Promise.reject(new Error("encode failed")))
    await act(async () => {
      fireEvent.click(confirm())
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("add-device-message").textContent).toBe("Could not add it. Try again.")
    expect(confirm().disabled).toBe(false)
    expect(cancel().disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("addToDeviceProblem: an empty phrase is fine, too many words or characters are not", () => {
    expect(addToDeviceProblem("", [], "Kitchen")).toBeUndefined()
    expect(addToDeviceProblem("hey jeff", [], "Kitchen")).toBeUndefined()
    expect(addToDeviceProblem("one two three four five six seven", [], "Kitchen")).toMatch(/at most 6 words/)
    expect(addToDeviceProblem(`hey ${"a".repeat(60)}`, [], "Kitchen")).toMatch(/at most 60 characters/)
  })
})
