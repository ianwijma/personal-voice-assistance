// PR #84 review, finding 2: Duplicate (and the other name dialogs) can confirm a create the server answers with a
// warning (a hosted voice without its key), as the edit page's "Save anyway" does.
import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { exampleAssistantInfo } from "@pva/protocol/examples"
import type { Outcome } from "@/lib/assistants.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { DuplicateDialog } from "@/components/settings/pages/assistants/dialogs.tsx"

const warning: Outcome = {
  kind: "warnings",
  message: "Cartesia has no API key yet, so this voice cannot speak. Save anyway to keep it.",
  warnings: [{ key: "voice", message: "Cartesia has no API key yet, so this voice cannot speak." }]
}

const setup = (answers: Array<Outcome>) => {
  const store = createStore({ ...initialState, assistants: [exampleAssistantInfo] }, reducer)
  const create = vi.fn(async (..._args: ReadonlyArray<unknown>) => answers.shift()!)
  const client = { store, createAssistant: create } as unknown as AssistantClient
  const onClose = vi.fn()
  const onCreated = vi.fn()
  render(<ClientContext.Provider value={client}><DuplicateDialog info={exampleAssistantInfo} onClose={onClose} onCreated={onCreated} /></ClientContext.Provider>)
  return { create, onClose, onCreated }
}
const confirm = () => screen.getByTestId("dialog-confirm") as HTMLButtonElement
const optionsOf = (create: ReturnType<typeof setup>["create"], n: number) => create.mock.calls[n]![1] as { readonly copyOf?: string; readonly saveAnyway?: boolean }

describe("Duplicate: a create that warns", () => {
  it("shows the warning; Duplicate anyway sends saveAnyway with copyOf and opens the copy", async () => {
    const { create, onCreated, onClose } = setup([warning, { kind: "ok", assistantId: "jeff-copy" }])
    await act(async () => {
      fireEvent.click(confirm())
    })
    expect(optionsOf(create, 0)).toEqual({ copyOf: exampleAssistantInfo.id })
    expect(screen.getByTestId("save-warnings").textContent).toContain("Cartesia has no API key yet")
    expect(confirm().textContent).toBe("Duplicate anyway")
    expect(onCreated).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(confirm())
    })
    expect(optionsOf(create, 1)).toEqual({ copyOf: exampleAssistantInfo.id, saveAnyway: true })
    expect(onCreated).toHaveBeenCalledWith("jeff-copy")
    expect(onClose).not.toHaveBeenCalled()
  })

  it("Go back keeps the dialog without the warning; a rename drops it too, and the next try asks again", async () => {
    const { create, onClose } = setup([warning, warning, warning])
    await act(async () => {
      fireEvent.click(confirm())
    })
    fireEvent.click(screen.getByRole("button", { name: "Go back" }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByTestId("save-warnings")).toBeNull()
    expect(confirm().textContent).toBe("Duplicate")
    await act(async () => {
      fireEvent.click(confirm())
    })
    expect(optionsOf(create, 1).saveAnyway).toBeUndefined()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Other name" } })
    expect(screen.queryByTestId("save-warnings")).toBeNull()
    await act(async () => {
      fireEvent.click(confirm())
    })
    expect(optionsOf(create, 2).saveAnyway).toBeUndefined()
  })
})
