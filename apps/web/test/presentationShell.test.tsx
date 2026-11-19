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
