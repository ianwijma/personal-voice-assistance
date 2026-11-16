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

  // PR #35 review 5, finding 2: the label is kept with the line in the store, so it survives the tester remounting,
  // and another device's page does not show (or relabel) a line heard on the first device.
  it("a line heard on device A is not shown on device B's page, and still says who woke on A's page again", () => {
    const store = createStore({ ...initialState, heard: [{ text: "hey jeff", matched: "hey jeff", accepted: true, at: 1 }] }, reducer)
    const client = { store, wakeTest: vi.fn(async () => ({ type: "result", requestId: "r", ok: true })) } as unknown as AssistantClient
    const tester = (deviceId: string, who: string) => (
      <ClientContext.Provider value={client}><PhraseTester key={deviceId} deviceId={deviceId} wakes={() => who} /></ClientContext.Provider>
    )
    const matched = (container: HTMLElement) => [...container.querySelectorAll('[data-outcome="matched"]')].map((li) => li.textContent ?? "")

    // Device A, where "hey jeff" wakes Jeff.
    const a = render(tester("d-kitchen0001", "Jeff"))
    expect(matched(a.container)).toEqual([expect.stringMatching(/wakes Jeff/)])
    expect(store.get().heard[0]?.judged).toEqual({ deviceId: "d-kitchen0001", woke: "Jeff" })
    a.unmount()

    // Device B's page (a new tester), where the same phrase belongs to T3: A's line is neither shown nor relabelled.
    const b = render(tester("d-office00001", "T3"))
    expect(matched(b.container)).toEqual([])
    expect(b.container.querySelector('[data-testid="heard-lines"]')).toBeNull()
    expect(store.get().heard[0]?.judged).toEqual({ deviceId: "d-kitchen0001", woke: "Jeff" })
    // A line heard on B is shown there, with B's assistant.
    act(() => store.dispatch({ type: "wake.heard", text: "hey jeff", matched: "hey jeff", accepted: true, at: 2 }))
    expect(matched(b.container)).toEqual([expect.stringMatching(/wakes T3/)])
    b.unmount()

    // Back on A's page (now with other assignments): its own line still says Jeff, B's line is not there.
    const again = render(tester("d-kitchen0001", "Someone else"))
    expect(matched(again.container)).toEqual([expect.stringMatching(/wakes Jeff/)])
  })
})

// PR #35 review 6, finding 2: the server says where a line was heard and whose phrase it matched (`wake.heard.source`);
// the tester shows exactly that and derives nothing from the session list or the assignments.
describe("Phrase tester: a line that says where it was heard", () => {
  const assistants = [{ id: "jeff", name: "Jeff" }, { id: "t3", name: "T3" }] as unknown as typeof initialState.assistants
  // The page still lists B (office) first and as the one talking, but the server heard the line on A (kitchen).
  const sessions = [
    { key: "d-office00001", deviceId: "d-office00001", name: "Office", ownerPresent: true },
    { key: "d-kitchen0001", deviceId: "d-kitchen0001", name: "Kitchen", ownerPresent: true }
  ] as unknown as typeof initialState.sessions
  const line = { type: "wake.heard", text: "hey jeff", matched: "hey jeff", accepted: true, source: { deviceId: "d-kitchen0001", assistantId: "jeff" }, at: 5 } as const
  const setup = () => {
    const store = createStore({ ...initialState, assistants, sessions }, reducer)
    const client = { store, wakeTest: vi.fn(async () => ({ type: "result", requestId: "r", ok: true })) } as unknown as AssistantClient
    const wakes = vi.fn(() => "T3")
    const tester = (deviceId?: string) => (
      <ClientContext.Provider value={client}>
        <PhraseTester key={deviceId ?? "defaults"} {...(deviceId !== undefined ? { deviceId } : {})} wakes={wakes} />
      </ClientContext.Provider>
    )
    return { store, tester, wakes }
  }
  const matched = (container: HTMLElement) => [...container.querySelectorAll('[data-outcome="matched"]')].map((li) => li.textContent ?? "")

  it("on the defaults page, names the assistant the server matched on the device it heard, not the session list's guess", () => {
    const { store, tester, wakes } = setup()
    const page = render(tester())
    act(() => store.dispatch(line))
    expect(matched(page.container)).toEqual([expect.stringMatching(/wakes Jeff/)])
    expect(matched(page.container)[0]).not.toMatch(/T3/)
    expect(wakes).not.toHaveBeenCalled()
    // Stored as the server said it; no judgement of the page's own is added.
    expect(store.get().heard[0]).toEqual({ text: "hey jeff", matched: "hey jeff", accepted: true, source: { deviceId: "d-kitchen0001", assistantId: "jeff" }, at: 5 })
    page.unmount()

    // B's page does not show it; A's page does, still with Jeff.
    const b = render(tester("d-office00001"))
    expect(b.container.querySelector('[data-testid="heard-lines"]')).toBeNull()
    b.unmount()
    const a = render(tester("d-kitchen0001"))
    expect(matched(a.container)).toEqual([expect.stringMatching(/wakes Jeff/)])
  })

  it("a line whose phrase is nobody's there wakes nobody, and a line from an older server is still judged by the page", () => {
    const { store, tester } = setup()
    const page = render(tester("d-kitchen0001"))
    act(() => store.dispatch({ ...line, source: { deviceId: "d-kitchen0001" }, at: 6 }))
    expect(matched(page.container)).toEqual([expect.not.stringMatching(/wakes/)])
    // No `source`: the fallback for an older server (the tested device and `wakes`).
    act(() => store.dispatch({ type: "wake.heard", text: "hey jeff", matched: "hey jeff", accepted: true, at: 7 }))
    expect(matched(page.container)[0]).toMatch(/wakes T3/)
    expect(store.get().heard.find((l) => l.at === 7)?.judged).toEqual({ deviceId: "d-kitchen0001", woke: "T3" })
    expect(store.get().heard.find((l) => l.at === 6)?.judged).toBeUndefined()
  })
})
