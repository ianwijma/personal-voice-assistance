import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { PhraseTester } from "@/components/settings/PhraseTester.tsx"

// PR #35 review 3, finding 2: a heard line names the assistant it woke with the device's settings when it was heard.
describe("Phrase tester: who a matched line woke", () => {
  it("keeps the assistant a line woke when the device's assignments change afterwards; a new line uses the new ones", () => {
    const store = createStore({ ...initialState, heard: [{ text: "hey jeff", matched: "hey jeff", accepted: true, at: 1 }] }, reducer)
    const client = { store, wakeTest: vi.fn(async () => ({ type: "result", requestId: "r", ok: true })) } as unknown as AssistantClient
    const tester = (who: string) => <ClientContext.Provider value={client}><PhraseTester deviceId="d-kitchen0001" wakes={() => who} /></ClientContext.Provider>
    const matched = (container: HTMLElement) => [...container.querySelectorAll('[data-outcome="matched"]')].map((li) => li.textContent ?? "")

    const { container, rerender } = render(tester("Jeff"))
    expect(matched(container)).toHaveLength(1)
    expect(matched(container)[0]).toMatch(/wakes Jeff/)

    // The device is saved with "hey jeff" on T3: the line Jeff handled still says Jeff.
    rerender(tester("T3"))
    expect(matched(container)[0]).toMatch(/wakes Jeff/)
    expect(matched(container)[0]).not.toMatch(/wakes T3/)

    // A line heard after the change is judged with the new settings (newest first).
    act(() => store.dispatch({ type: "wake.heard", text: "hey jeff", matched: "hey jeff", accepted: true, at: 2 }))
    const now = matched(container)
    expect(now).toHaveLength(2)
    expect(now[0]).toMatch(/wakes T3/)
    expect(now[1]).toMatch(/wakes Jeff/)
  })
})
