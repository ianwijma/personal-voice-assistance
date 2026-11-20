import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { exampleDeviceSetup } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { ChatPanel } from "@/components/ChatPanel.tsx"

// P5 review round 3 (p5-r3b finding 1): when the server ends the device's session (CloseCode.settingsChanged), the
// chat's draft goes with it, like the turns: the composer starts afresh. Round 4 (p5-r4b finding 1, the class): the
// message list's scroll state, what the recogniser heard and the old session's notices go too.

afterEach(cleanup)

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

  it("round 4: the message list starts afresh (no \"Jump to latest\" left over from the old session)", () => {
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
    // The list is scrolled up, away from the bottom: a new turn offers "Jump to latest".
    const list = screen.getByTestId("messages")
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 2000 })
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 300 })
    list.scrollTop = 0
    fireEvent.scroll(list)
    act(() => store.dispatch({ type: "turn.start", turnId: 41, source: "text", userText: "Sam's private question", spoken: false }))
    expect(screen.queryByText("Jump to latest")).not.toBeNull()
    act(() => store.dispatch({ type: "local/session-ended" }))
    expect(screen.getAllByTestId("messages")).toHaveLength(1)
    expect(screen.queryByText("Jump to latest")).toBeNull()
    expect(screen.queryByText("Sam's private question")).toBeNull()
  })

  it("round 4: what the recogniser heard and the old session's notices are dropped at the boundary; an ordinary drop keeps them", () => {
    let s = reducer({ ...initialState, connection: { ...initialState.connection, status: "open", everConnected: true } }, { type: "wake.heard", text: "hey jeff what is on sam's calendar", at: 1 } as never)
    s = reducer(s, { type: "local/toast", message: "Sam's reminder could not be read", tone: "error" } as never)
    expect(s.heard.map((h) => h.text)).toEqual(["hey jeff what is on sam's calendar"])
    expect(s.toasts).toHaveLength(1)
    const dropped = reducer(s, { type: "local/socket-lost" })
    expect(dropped.heard).toHaveLength(1)
    expect(dropped.toasts).toHaveLength(1)
    const ended = reducer(s, { type: "local/session-ended" })
    expect(ended.heard).toEqual([])
    expect(ended.toasts).toEqual([])
  })
})
