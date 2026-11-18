// P9: the voice page's notification cards and its ring cue (docs/NOTIFICATIONS.md "The voice page"): the cards follow
// `notification.ring` / `notification.resolved` and are emptied at every welcome (the server sends what is open again
// after it); the cue loops while a card that is not silent is shown, stops on resolve, on a press and when the card
// comes again silent, survives a reconnect, and makes no sound before the page has its audio (a card is shown, with a
// note), starting once the audio runs.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NotificationCard, ServerMessage } from "@pva/protocol"
import { serverExamples } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import { makeRingLoop, RING_EVERY_MS, ringCue } from "@/lib/audio/ringLoop.ts"
import { type Action, type ClientState, initialState, MAX_CARDS, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { NotificationCards } from "@/components/NotificationCards.tsx"

afterEach(cleanup)

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)
const card = (id: string, over: Partial<NotificationCard> = {}): NotificationCard => ({
  id,
  title: `Card ${id}`,
  priority: "ring",
  silent: false,
  actions: [{ id: "stop", label: "Stop" }, { id: "snooze", label: "Snooze" }],
  sentAt: 1_000,
  ...over
})
const ring = (c: NotificationCard): ServerMessage => ({ type: "notification.ring", notification: c })
const resolved = (id: string): ServerMessage => ({ type: "notification.resolved", id, outcome: "stop" })

describe("cards in the page's state", () => {
  it("a ring adds a card, the same id again replaces it, resolved takes it down, a welcome empties them", () => {
    let s = run([serverExamples.welcome, ring(card("a")), ring(card("b", { sentAt: 500 }))])
    expect(s.notifications.map((n) => n.id)).toEqual(["b", "a"])
    s = run([ring(card("a", { silent: true }))], s)
    expect(s.notifications.find((n) => n.id === "a")?.silent).toBe(true)
    s = run([resolved("b")], s)
    expect(s.notifications.map((n) => n.id)).toEqual(["a"])
    s = run([serverExamples.welcome], s)
    expect(s.notifications).toEqual([])
  })

  it("a press quiets a card here (kept when it rings again) until the server resolves it; the session ending empties them", () => {
    let s = run([ring(card("a"))])
    s = run([{ type: "local/notification-pressed", id: "a" }, ring(card("a"))], s)
    expect(s.notifications[0]?.quiet).toBe(true)
    s = run([ring(card("z")), { type: "local/session-ended" }], s)
    expect(s.notifications).toEqual([])
  })

  it(`keeps at most ${MAX_CARDS} cards, the newest`, () => {
    const s = run(Array.from({ length: MAX_CARDS + 4 }, (_, i) => ring(card(`n${i}`, { sentAt: i }))))
    expect(s.notifications.length).toBe(MAX_CARDS)
    expect(s.notifications[0]?.id).toBe("n4")
  })
})

describe("the ring cue loop", () => {
  const harness = (state: { wanted: boolean; canPlay: boolean }) => {
    const timers: Array<() => void> = []
    const events: Array<string> = []
    const loop = makeRingLoop({
      wanted: () => state.wanted,
      canPlay: () => state.canPlay,
      play: () => void events.push("play"),
      silence: () => void events.push("silence"),
      setInterval: (f) => (timers.push(f), timers.length),
      clearInterval: () => void events.push("cleared")
    })
    const beat = () => timers.at(-1)?.()
    return { loop, events, beat }
  }

  it("starts at once with a ringing card and beats while it is wanted", () => {
    const state = { wanted: true, canPlay: true }
    const h = harness(state)
    h.loop.update()
    h.beat()
    h.beat()
    expect(h.events).toEqual(["play", "play", "play"])
    expect(h.loop.running()).toBe(true)
  })

  it("stops (and silences the cue) when the card is resolved, pressed or comes again silent", () => {
    const state = { wanted: true, canPlay: true }
    const h = harness(state)
    h.loop.update()
    state.wanted = false
    h.loop.update()
    expect(h.events).toEqual(["play", "cleared", "silence"])
    expect(h.loop.running()).toBe(false)
    // A beat that finds it no longer wanted stops too.
    state.wanted = true
    h.loop.update()
    state.wanted = false
    h.beat()
    expect(h.events.slice(-3)).toEqual(["play", "cleared", "silence"])
  })

  it("without audio (before Start, or a reply playing) it makes no sound, and plays at the next beat once it may", () => {
    const state = { wanted: true, canPlay: false }
    const h = harness(state)
    h.loop.update()
    h.beat()
    expect(h.events).toEqual([])
    expect(h.loop.running()).toBe(true)
    state.canPlay = true
    h.beat()
    expect(h.events).toEqual(["play"])
  })

  it("survives a reconnect: the welcome empties the cards (it stops), the server's ring starts it again", () => {
    const store = createStore(run([ring(card("a"))]), reducer)
    const events: Array<string> = []
    const loop = makeRingLoop({
      wanted: () => store.get().notifications.some((n) => n.priority === "ring" && !n.silent && n.quiet !== true),
      canPlay: () => true,
      play: () => void events.push("play"),
      silence: () => void events.push("silence"),
      setInterval: () => 1,
      clearInterval: () => undefined
    })
    store.subscribe(() => loop.update())
    loop.update()
    store.dispatch(serverExamples.welcome)
    store.dispatch(ring(card("a")))
    expect(events).toEqual(["play", "silence", "play"])
    store.dispatch({ type: "local/notification-pressed", id: "a" })
    expect(events.at(-1)).toBe("silence")
  })

  it(`the cue is generated (no asset), short and soft, and beats every ${RING_EVERY_MS} ms`, () => {
    const pcm = ringCue(24_000)
    expect(pcm.length).toBeGreaterThan(24_000 * 0.4)
    expect(pcm.length).toBeLessThan(24_000 * 0.8)
    expect(Math.max(...pcm.map(Math.abs))).toBeLessThan(0.25 * 32767)
    expect(RING_EVERY_MS).toBeGreaterThan(pcm.length / 24)
  })
})

describe("the card", () => {
  const mount = (state: ClientState, request = vi.fn(async (_m: unknown) => ({ type: "result" as const, requestId: "r", ok: true, say: "Snoozed." }))) => {
    const store = createStore(state, reducer)
    const client = { store, request } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><NotificationCards /></ClientContext.Provider>)
    return { store, request }
  }

  it("shows the title, the text and the buttons; a press sends notification.action, quiets the cue and shows the answer", async () => {
    const { store, request } = mount(run([{ type: "local/audio", phase: "running" }, ring(card("a", { text: "Ten minutes are up" }))]))
    expect(screen.getByText("Card a")).toBeTruthy()
    expect(screen.getByText("Ten minutes are up")).toBeTruthy()
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Stop", "Snooze"])
    expect(screen.queryByTestId("notification-silent-note")).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByText("Snooze"))
    })
    expect(request).toHaveBeenCalledWith({ type: "notification.action", id: "a", actionId: "snooze" })
    expect(store.get().notifications[0]?.quiet).toBe(true)
    expect(screen.getByText("Snoozed.")).toBeTruthy()
    act(() => store.dispatch(resolved("a")))
    expect(screen.queryByTestId("notification-card")).toBeNull()
  })

  it("before the audio was started, a ringing card says it cannot be heard yet; a refusal is shown", async () => {
    mount(run([ring(card("a"))]), vi.fn(async () => ({ type: "result" as const, requestId: "r", ok: false, error: { code: "not_running" as const, message: "I can't do that right now." }, say: "I can't do that right now." })))
    expect(screen.getByTestId("notification-silent-note").textContent).toBe("Start audio to hear it.")
    await act(async () => {
      fireEvent.click(screen.getByText("Snooze"))
    })
    expect(screen.getByText("I can't do that right now.")).toBeTruthy()
  })
})
