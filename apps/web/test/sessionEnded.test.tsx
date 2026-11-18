import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { exampleDeviceSetup } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { ChatPanel } from "@/components/ChatPanel.tsx"

// P5 review round 3 (p5-r3b finding 1): when the server ends the device's session (CloseCode.settingsChanged), the
// chat's draft goes with it, like the turns: the composer starts afresh.

describe("a session the server ended takes the composer's draft with it", () => {
  it("a typed, unsent draft is empty after local/session-ended; an ordinary drop keeps it", () => {
    const store = createStore(
      {
        ...initialState,
        connection: { ...initialState.connection, status: "open", everConnected: true },
        summary: { ...initialState.summary, ready: true },
        setup: exampleDeviceSetup,
        ui: { ...initialState.ui, chatOpen: true }
      },
      reducer
    )
    const client = { store, readConversation: vi.fn(), sendText: vi.fn(async () => ({ ok: true })), newConversation: vi.fn() } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><ChatPanel /></ClientContext.Provider>)
    const box = () => screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(box(), { target: { value: "Sam's private draft" } })
    expect(box().value).toBe("Sam's private draft")
    // A network drop: the draft stays (the same session comes back).
    act(() => store.dispatch({ type: "local/socket-lost" }))
    expect(box().value).toBe("Sam's private draft")
    // The session ended on purpose: the draft goes.
    act(() => store.dispatch({ type: "local/session-ended" }))
    expect(box().value).toBe("")
  })
})
