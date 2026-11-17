import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { AssistantClient } from "@/lib/client.ts"
import { type HeardLine, type HeardOutcome, type HeardTone, heardRow, initialState, reducer } from "@/lib/state.ts"
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

// PR #35 review 7, finding 1: every kind of heard line, from the table at `heardRow` (lib/state.ts). A line that was
// not accepted never says, or implies, that an assistant woke — also a retained line the page judged earlier.
describe("Phrase tester: every kind of heard line", () => {
  const kitchen = "d-kitchen0001"
  const office = "d-office00001"
  // Jeff is on, Otto is switched off now; "gone" is the id of an assistant that has been removed.
  const assistants = [{ id: "jeff", name: "Jeff", enabled: true }, { id: "otto", name: "Otto", enabled: false }] as unknown as typeof initialState.assistants
  // The kitchen is the device talking, so a line without `source` is judged on it (with `wakes`: T3).
  const sessions = [{ key: kitchen, deviceId: kitchen, name: "Kitchen", ownerPresent: true }] as unknown as typeof initialState.sessions
  const devices = [{ id: kitchen, name: "Kitchen", audioOwner: true }] as unknown as typeof initialState.devices
  type Row = {
    readonly name: string
    readonly line: Omit<HeardLine, "text" | "at">
    readonly outcome: HeardOutcome
    readonly tone: HeardTone
    readonly label: string
    readonly add: boolean
    /** Shown on the kitchen's device page. */
    readonly onKitchen: boolean
  }
  const jeff = { matched: "hey jeff" } as const
  const rows: ReadonlyArray<Row> = [
    // The server says where it was heard (`source`).
    { name: "matched, taken, assistant known", line: { ...jeff, accepted: true, source: { deviceId: kitchen, assistantId: "jeff" } }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff → wakes Jeff", add: false, onKitchen: true },
    { name: "matched, taken, assistant switched off since", line: { matched: "hey otto", accepted: true, source: { deviceId: kitchen, assistantId: "otto" } }, outcome: "matched", tone: "ok", label: "Matched Hey Otto → wakes Otto", add: false, onKitchen: true },
    { name: "matched, taken, assistant removed since", line: { ...jeff, accepted: true, source: { deviceId: kitchen, assistantId: "gone" } }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff → wakes a removed assistant", add: false, onKitchen: true },
    { name: "matched, taken, nobody's phrase", line: { ...jeff, accepted: true, source: { deviceId: kitchen } }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff", add: false, onKitchen: true },
    { name: "matched, taken, no device", line: { ...jeff, accepted: true, source: { assistantId: "jeff" } }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff → wakes Jeff", add: false, onKitchen: false },
    { name: "matched, taken, another device", line: { ...jeff, accepted: true, source: { deviceId: office, assistantId: "jeff" } }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff → wakes Jeff", add: false, onKitchen: false },
    { name: "matched, not taken, assistant off", line: { matched: "hey otto", accepted: false, source: { deviceId: kitchen, assistantId: "otto" } }, outcome: "matched-ignored", tone: "muted", label: "Matched Hey Otto, not accepted", add: false, onKitchen: true },
    { name: "matched, not taken, assistant on now", line: { ...jeff, accepted: false, source: { deviceId: kitchen, assistantId: "jeff" } }, outcome: "matched-ignored", tone: "muted", label: "Matched Hey Jeff, not accepted", add: false, onKitchen: true },
    { name: "matched, not taken, assistant removed", line: { ...jeff, accepted: false, source: { deviceId: kitchen, assistantId: "gone" } }, outcome: "matched-ignored", tone: "muted", label: "Matched Hey Jeff, not accepted", add: false, onKitchen: true },
    { name: "matched, not taken, nobody's phrase", line: { ...jeff, accepted: false, source: { deviceId: kitchen } }, outcome: "matched-ignored", tone: "muted", label: "Matched Hey Jeff, not accepted", add: false, onKitchen: true },
    { name: "matched, not taken, no device", line: { ...jeff, accepted: false, source: { assistantId: "jeff" } }, outcome: "matched-ignored", tone: "muted", label: "Matched Hey Jeff, not accepted", add: false, onKitchen: false },
    { name: "no phrase, taken", line: { accepted: true, source: { deviceId: kitchen } }, outcome: "accepted", tone: "you", label: "Accepted without a phrase", add: false, onKitchen: true },
    { name: "no phrase, taken, with an assistant (never sent)", line: { accepted: true, source: { deviceId: kitchen, assistantId: "jeff" } }, outcome: "accepted", tone: "you", label: "Accepted without a phrase", add: false, onKitchen: true },
    { name: "no phrase, not taken", line: { accepted: false, source: { deviceId: kitchen } }, outcome: "ignored", tone: "muted", label: "Ignored", add: true, onKitchen: true },
    { name: "no phrase, not taken, no device", line: { accepted: false, source: {} }, outcome: "ignored", tone: "muted", label: "Ignored", add: true, onKitchen: false },
    // An older server, without `source`: judged by the page on the tested device (the kitchen), `wakes` says T3.
    { name: "old server: matched, taken", line: { ...jeff, accepted: true }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff → wakes T3", add: false, onKitchen: true },
    { name: "old server: matched, not taken", line: { ...jeff, accepted: false }, outcome: "matched-ignored", tone: "muted", label: "Matched Hey Jeff, not accepted", add: false, onKitchen: true },
    { name: "older server: matched, no accepted", line: { ...jeff }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff → wakes T3", add: false, onKitchen: true },
    { name: "old server: no phrase, taken", line: { accepted: true }, outcome: "accepted", tone: "you", label: "Accepted without a phrase", add: false, onKitchen: true },
    { name: "old server: no phrase, not taken", line: { accepted: false }, outcome: "ignored", tone: "muted", label: "Ignored", add: true, onKitchen: true },
    { name: "older server: no phrase, no accepted", line: {}, outcome: "no-match", tone: "muted", label: "No phrase matched", add: true, onKitchen: true },
    // Retained lines the page judged earlier (`judged`): their own device and assistant, never relabelled.
    { name: "retained: matched, taken", line: { ...jeff, accepted: true, judged: { deviceId: kitchen, woke: "Jeff" } }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff → wakes Jeff", add: false, onKitchen: true },
    { name: "retained: matched, not taken, judged with an assistant", line: { ...jeff, accepted: false, judged: { deviceId: kitchen, woke: "Jeff" } }, outcome: "matched-ignored", tone: "muted", label: "Matched Hey Jeff, not accepted", add: false, onKitchen: true },
    { name: "retained: matched, taken, on another device", line: { ...jeff, accepted: true, judged: { deviceId: office, woke: "Jeff" } }, outcome: "matched", tone: "ok", label: "Matched Hey Jeff → wakes Jeff", add: false, onKitchen: false }
  ]
  const textOf = (i: number) => `line ${i} said`
  const heard: ReadonlyArray<HeardLine> = rows.map((r, i) => ({ ...r.line, text: textOf(i), at: 100 + i }))
  const rowOf = (container: HTMLElement, i: number) =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="heard-lines"] li')].find((li) => (li.textContent ?? "").includes(`“${textOf(i)}”`))
  const setup = () => {
    const store = createStore({ ...initialState, assistants, sessions, devices, heard }, reducer)
    const client = { store, wakeTest: vi.fn(async () => ({ type: "result", requestId: "r", ok: true })) } as unknown as AssistantClient
    const tester = (deviceId?: string) => (
      <ClientContext.Provider value={client}>
        <PhraseTester key={deviceId ?? "defaults"} {...(deviceId !== undefined ? { deviceId } : {})} wakes={() => "T3"} onAdd={() => undefined} />
      </ClientContext.Provider>
    )
    return { tester }
  }

  it("labels, tones and Add for every row, on the defaults page and on a device page", () => {
    const { tester } = setup()
    const page = render(tester())
    rows.forEach((r, i) => {
      const li = rowOf(page.container, i)
      expect(li, r.name).toBeDefined()
      expect(li!.dataset.outcome, r.name).toBe(r.outcome)
      expect(li!.dataset.tone, r.name).toBe(r.tone)
      const label = (li!.textContent ?? "").replace(`“${textOf(i)}”`, "").replace(/Add “.*”$/, "")
      expect(label, r.name).toBe(r.label)
      expect(li!.querySelector('[data-testid="add-heard"]') !== null, r.name).toBe(r.add)
      // The one rule the table exists for: not accepted, so nobody woke.
      if (r.line.accepted === false) expect(li!.textContent, r.name).not.toMatch(/wakes/)
      // The label is the pure function's, given what the page knows of the assistant.
      expect(heardRow(heard[i]!, undefined).outcome, r.name).toBe(r.outcome)
    })
    page.unmount()

    const onKitchen = render(tester(kitchen))
    rows.forEach((r, i) => {
      const li = rowOf(onKitchen.container, i)
      expect(li !== undefined, r.name).toBe(r.onKitchen)
      if (li !== undefined) expect((li.textContent ?? "").replace(`“${textOf(i)}”`, "").replace(/Add “.*”$/, ""), r.name).toBe(r.label)
    })
  })
})
