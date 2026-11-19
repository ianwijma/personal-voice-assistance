import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { serverExamples } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { VoiceApp } from "@/components/voice/VoiceApp.tsx"

const mocks = vi.hoisted(() => ({ client: undefined as unknown, wide: false }))
vi.mock("@/lib/client.ts", () => ({ createAssistantClient: () => mocks.client }))
vi.mock("@/components/useMediaQuery.ts", () => ({ WIDE_QUERY: "(min-width:1024px)", useMediaQuery: () => mocks.wide }))
vi.mock("@/components/Stage.tsx", () => ({ Stage: () => null }))
vi.mock("@/components/ControlDock.tsx", () => ({ ControlDock: () => null }))
vi.mock("@/components/TopBar.tsx", () => ({ TopBar: () => null }))
vi.mock("@/components/voice/VoiceSheet.tsx", () => ({ VoiceSheet: () => null }))
vi.mock("@/components/ShortcutsDialog.tsx", () => ({ ShortcutsDialog: () => null }))
vi.mock("@/components/voice/useSessionFocus.ts", () => ({ useSessionFocus: () => undefined, useHoldsAudio: () => false }))
vi.mock("@/components/useShortcuts.ts", () => ({ useShortcuts: () => undefined }))

afterEach(cleanup)

it.each([false, true])("r3 b1: modal chat hides and inerts ordinary presentations while ring Stop remains usable (wide=%s)", async (wide) => {
  mocks.wide = wide
  const store = createStore(initialState, reducer)
  const request = vi.fn(async () => ({ ok: true, say: "Done." }))
  mocks.client = { store, request, connect: () => () => undefined } as unknown as AssistantClient
  render(<VoiceApp />)
  act(() => {
    store.dispatch({ type: "present.show", presentation: {
      id: "p-tea", revision: "tea:1", lifetime: "pinned", shownAt: 1000, serverNow: 1000, v: 1,
      content: { kind: "card", title: "Tea", facts: [] }, buttons: [{ id: "choose", label: "Choose tea" }], interactive: true,
      texts: { region: "On screen", loading: "Loading", imageMissing: "Missing", timerDone: "Done", credit: "Image", high: "High", low: "Low" }
    } })
    store.dispatch(serverExamples["notification.ring"])
  })
  const cards = screen.getByTestId("presentations")
  expect(screen.getByRole("button", { name: "Choose tea" })).toBeTruthy()
  act(() => store.dispatch({ type: "local/ui", patch: { chatOpen: true } }))
  expect(screen.getByTestId("chat-panel").getAttribute("aria-modal")).toBe(wide ? null : "true")
  expect(screen.getByTestId("page-behind").hasAttribute("inert")).toBe(!wide)
  // jsdom does not enforce inert clicks: assert the actual shell boundary as well as accessible visibility.
  expect(cards.hasAttribute("inert")).toBe(!wide)
  expect(screen.queryByRole("button", { name: "Choose tea" }) !== null).toBe(wide)
  const stop = screen.getByRole("button", { name: "Stop" })
  expect(stop.closest("[inert]")).toBeNull()
  await act(async () => fireEvent.click(stop))
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "notification.action", actionId: "stop" }))
  act(() => store.dispatch({ type: "local/ui", patch: { chatOpen: false } }))
  expect(cards.hasAttribute("inert")).toBe(false)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Choose tea" })))
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "present.action", action: "choose" }))
})

it.each(["sheetOpen", "shortcutsOpen"] as const)("r4 b1: %s hides the stage over four held pins and restores them on close", (modal) => {
  mocks.wide = false
  const store = createStore(initialState, reducer)
  mocks.client = { store, connect: () => () => undefined } as unknown as AssistantClient
  render(<VoiceApp />)
  act(() => {
    for (let i = 0; i < 4; i++) store.dispatch({ type: "present.show", presentation: {
      id: `p-${i}`, revision: "r1", lifetime: "pinned", shownAt: i, serverNow: 1000, v: 1,
      content: { kind: "card", title: `Shopping ${i}`, facts: [] }, buttons: [], interactive: false,
      texts: serverExamples["present.show"].presentation.texts
    } })
    store.dispatch({ type: "local/ui", patch: { [modal]: true } })
  })
  expect(screen.queryByRole("region", { name: "On screen" })).toBeNull()
  const stage = screen.getByTestId("present-stage")
  expect(stage.closest("[hidden]")).not.toBeNull()
  expect(store.get().presentations).toHaveLength(4)
  act(() => store.dispatch({ type: "local/ui", patch: { [modal]: false } }))
  expect(stage.closest("[hidden]")).toBeNull()
  expect(screen.getAllByRole("heading", { name: /Shopping/ })).toHaveLength(4)
})

it("r4 b2: narrow chat includes exactly one ringing Stop in its modal focus scope", () => {
  mocks.wide = false
  const store = createStore(initialState, reducer)
  mocks.client = { store, connect: () => () => undefined } as unknown as AssistantClient
  render(<VoiceApp />)
  act(() => store.dispatch({ type: "local/ui", patch: { chatOpen: true } }))
  act(() => store.dispatch(serverExamples["notification.ring"]))
  const stop = screen.getByRole("button", { name: /^Stop$/ })
  expect(screen.getByTestId("chat-panel").contains(stop)).toBe(true)
  expect(screen.getAllByTestId("notification-cards")).toHaveLength(1)
})

for (const settleInChat of [false, true]) {
  it(`r5 b1: pending notification and its reply survive chat relocation (settleInChat=${settleInChat})`, async () => {
    mocks.wide = false
    const store = createStore(initialState, reducer)
    let reply!: (r: { ok: boolean; say: string }) => void
    const request = vi.fn(() => new Promise<{ ok: boolean; say: string }>((resolve) => { reply = resolve }))
    mocks.client = { store, request, connect: () => () => undefined } as unknown as AssistantClient
    render(<VoiceApp />)
    act(() => store.dispatch(serverExamples["notification.ring"]))
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }))
    expect((screen.getByRole("button", { name: "Snooze" }) as HTMLButtonElement).disabled).toBe(true)
    act(() => store.dispatch({ type: "local/ui", patch: { chatOpen: true } }))
    expect((screen.getByRole("button", { name: "Snooze" }) as HTMLButtonElement).disabled).toBe(true)
    const { text: oldText, ...refreshed } = serverExamples["notification.ring"].notification
    act(() => store.dispatch({ type: "notification.ring", notification: refreshed }))
    expect(screen.queryByText(oldText!)).toBeNull()
    expect((screen.getByRole("button", { name: "Snooze" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }))
    expect(request).toHaveBeenCalledTimes(1)
    expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(false)
    if (!settleInChat) act(() => store.dispatch({ type: "local/ui", patch: { chatOpen: false } }))
    await act(async () => reply({ ok: true, say: "Snoozed for ten minutes." }))
    expect(screen.getByText("Snoozed for ten minutes.")).toBeTruthy()
    act(() => store.dispatch({ type: "local/ui", patch: { chatOpen: !settleInChat } }))
    expect(screen.getByText("Snoozed for ten minutes.")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Snooze" }) as HTMLButtonElement).disabled).toBe(false)
    act(() => store.dispatch({ type: "notification.resolved", id: serverExamples["notification.ring"].notification.id, outcome: "stop" }))
    act(() => store.dispatch(serverExamples["notification.ring"]))
    expect(screen.queryByText("Snoozed for ten minutes.")).toBeNull()
  })
}

it("r5 b1: a withdrawn card's late answer cannot affect a new holding of the same notification", async () => {
  mocks.wide = false
  const store = createStore(initialState, reducer)
  let reply!: (r: { ok: boolean; say: string }) => void
  const request = vi.fn(() => new Promise<{ ok: boolean; say: string }>((resolve) => { reply = resolve }))
  mocks.client = { store, request, connect: () => () => undefined } as unknown as AssistantClient
  render(<VoiceApp />)
  act(() => store.dispatch(serverExamples["notification.ring"]))
  fireEvent.click(screen.getByRole("button", { name: "Snooze" }))
  act(() => store.dispatch({ type: "notification.resolved", id: serverExamples["notification.ring"].notification.id, outcome: "stop" }))
  act(() => store.dispatch(serverExamples["notification.ring"]))
  await act(async () => reply({ ok: true, say: "Retired answer" }))
  expect(screen.queryByText("Retired answer")).toBeNull()
  expect((screen.getByRole("button", { name: "Snooze" }) as HTMLButtonElement).disabled).toBe(false)
})
