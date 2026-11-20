// P9: the voice page's notification cards and its ring cue (docs/NOTIFICATIONS.md "The voice page"): the cards follow
// `notification.ring` / `notification.resolved`, every one the server may have open is kept, and they are emptied at
// every welcome (the server sends what is open again after it). The cue loops while a card that rings is held (derived
// from every card), stops on resolve, on a press, when the card comes again silent, when the connection is lost and
// when the page is left; it makes no sound before the page has its audio (the card shows the server's note), and
// starts once the audio runs. Review round 1: b8, b9, b10, b12 (and note b15) each have a case here.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { notifyStorage, schedulerStorage } from "@pva/core"
import { notifyWorld } from "@pva/core/notify-contract"
import { makeMemoryHouseholdStore } from "@pva/core/testing"
import { MAX_NOTIFICATION_CARDS, type NotificationCard, type ServerMessage } from "@pva/protocol"
import { Effect } from "effect"
import { serverExamples } from "@pva/protocol/examples"
import { type AssistantClient, createAssistantClient } from "@/lib/client.ts"
import { makeRingLoop, RING_EVERY_MS, ringCue } from "@/lib/audio/ringLoop.ts"
import { VoiceAudio } from "@/lib/audio/VoiceAudio.ts"
import { type Action, type ClientState, initialState, MAX_CARDS, reducer, ringingCard } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { NotificationCards } from "@/components/NotificationCards.tsx"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)
const card = (id: string, over: Partial<NotificationCard> = {}): NotificationCard => ({
  id,
  title: `Card ${id}`,
  priority: "ring",
  show: true,
  sound: true,
  actions: [{ id: "stop", label: "Stop" }, { id: "snooze", label: "Snooze" }],
  sentAt: 1_000,
  texts: { region: "Notifications", startAudio: "Start audio to hear it." },
  ...over
})
const ring = (c: NotificationCard): ServerMessage => ({ type: "notification.ring", notification: c })
const resolved = (id: string): ServerMessage => ({ type: "notification.resolved", id, outcome: "stop" })
const wanted = (s: ClientState) => s.notifications.some(ringingCard)

describe("cards in the page's state", () => {
  it("a ring adds a card, the same id again replaces it, resolved takes it down, a welcome empties them", () => {
    let s = run([serverExamples.welcome, ring(card("a")), ring(card("b", { sentAt: 500 }))])
    expect(s.notifications.map((n) => n.id)).toEqual(["b", "a"])
    s = run([ring(card("a", { sound: false }))], s)
    expect(s.notifications.find((n) => n.id === "a")?.sound).toBe(false)
    s = run([resolved("b")], s)
    expect(s.notifications.map((n) => n.id)).toEqual(["a"])
    s = run([serverExamples.welcome], s)
    expect(s.notifications).toEqual([])
  })

  it("a press quiets a card here (kept when it rings again) until the server resolves it; the session ending empties them", () => {
    let s = run([ring(card("a"))])
    s = run([{ type: "local/notification-pressed", id: "a" }, ring(card("a"))], s)
    expect(s.notifications[0]?.quiet).toBe(true)
    expect(wanted(s)).toBe(false)
    s = run([ring(card("z")), { type: "local/session-ended" }], s)
    expect(s.notifications).toEqual([])
  })

  it(`b8: keeps every card the server may have open (${MAX_NOTIFICATION_CARDS}); a ring followed by newer cards still rings`, () => {
    expect(MAX_CARDS).toBe(MAX_NOTIFICATION_CARDS)
    let s = run([ring(card("only-ring"))])
    for (let i = 0; i < MAX_NOTIFICATION_CARDS - 1; i++) s = run([ring(card(`normal-${i}`, { priority: "normal", sound: false, sentAt: 1_001 + i }))], s)
    expect(s.notifications.length).toBe(MAX_NOTIFICATION_CARDS)
    expect(s.notifications.some((n) => n.id === "only-ring")).toBe(true)
    expect(wanted(s)).toBe(true)
  })

  it("b3 (round 2): churn at the bound, from the service to this reducer: a resolve and a new send in one go never cost a live ring, and the page never holds more than the bound", async () => {
    const store = makeMemoryHouseholdStore()
    await Effect.runPromise(store.prepare([], [schedulerStorage, notifyStorage]))
    let s: ClientState = initialState
    let most = 0
    const modules = Array.from({ length: 7 }, (_, i) => `bell${i}`)
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const world = yield* notifyWorld(store, {
        modules,
        connected: ["kitchen-display"],
        outlet: (_d, m) => {
          s = reducer(s, m as Action)
          most = Math.max(most, s.notifications.length)
        }
      })
      yield* world.settle
      const ids: Array<string> = []
      for (let i = 0; i < MAX_NOTIFICATION_CARDS; i++) {
        const n = yield* world.bell(modules[Math.floor(i / 10)]!).send({ title: `Card ${i}`, priority: i === 0 ? "ring" : "normal", target: "everywhere" })
        ids.push(n.notification.id)
      }
      yield* world.settle
      expect(s.notifications.length).toBe(MAX_NOTIFICATION_CARDS)
      expect(wanted(s)).toBe(true)
      // The newest resolved and a replacement sent at once: one reconciliation pass sees both.
      for (let round = 0; round < 3; round++) {
        const m = world.bell(modules[6]!)
        yield* m.resolve(ids.pop()!)
        ids.push((yield* m.send({ title: `Replacement ${round}`, target: "everywhere" })).notification.id)
        yield* world.settle
        expect(s.notifications.length).toBe(MAX_NOTIFICATION_CARDS)
        expect(s.notifications.some((n) => n.id === ids[0])).toBe(true)
        expect(wanted(s)).toBe(true)
      }
      expect(most).toBe(MAX_NOTIFICATION_CARDS)
      expect(world.notify.ringingOn("kitchen-display").map((r) => r.id)).toEqual([ids[0]])
    })))
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
    return { loop, events, beat: () => timers.at(-1)?.() }
  }

  it("starts at once with a ringing card and beats while it is wanted; stops (and silences) when it is not", () => {
    const state = { wanted: true, canPlay: true }
    const h = harness(state)
    h.loop.update()
    h.beat()
    expect(h.events).toEqual(["play", "play"])
    state.wanted = false
    h.loop.update()
    expect(h.events).toEqual(["play", "play", "cleared", "silence"])
    expect(h.loop.running()).toBe(false)
  })

  it("without audio (before Start, or a reply playing) it makes no sound, and plays at the next beat once it may", () => {
    const state = { wanted: true, canPlay: false }
    const h = harness(state)
    h.loop.update()
    h.beat()
    expect(h.events).toEqual([])
    state.canPlay = true
    h.beat()
    expect(h.events).toEqual(["play"])
  })

  it(`the cue is generated (no asset), short and soft, and beats every ${RING_EVERY_MS} ms`, () => {
    const pcm = ringCue(24_000)
    expect(pcm.length).toBeGreaterThan(24_000 * 0.4)
    expect(pcm.length).toBeLessThan(24_000 * 0.8)
    expect(Math.max(...pcm.map(Math.abs))).toBeLessThan(0.25 * 32767)
  })
})

describe("b9: the real client's cue lives with the connection and the page", () => {
  /** The real client with its audio and socket stood in for: what it plays, on fake timers. */
  const realClient = () => {
    vi.useFakeTimers()
    const played: Array<number> = []
    const stopped: Array<number | undefined> = []
    vi.spyOn(VoiceAudio.prototype, "running", "get").mockReturnValue(true)
    vi.spyOn(VoiceAudio.prototype, "contextState", "get").mockReturnValue("running")
    vi.spyOn(VoiceAudio.prototype, "openReply").mockReturnValue(undefined)
    vi.spyOn(VoiceAudio.prototype, "playLocal").mockImplementation((id: number) => void played.push(id))
    vi.spyOn(VoiceAudio.prototype, "replyStop").mockImplementation((id: number | undefined) => void stopped.push(id))
    vi.spyOn(VoiceAudio.prototype, "unload").mockImplementation(() => undefined)
    class Socket {
      readyState = 0
      onopen: unknown
      onclose: ((e: { code: number; reason: string }) => void) | undefined
      onerror: unknown
      onmessage: unknown
      binaryType = "arraybuffer"
      send() {}
      close() {
        this.readyState = 3
        this.onclose?.({ code: 1000, reason: "" })
      }
    }
    vi.stubGlobal("WebSocket", Socket)
    const client = createAssistantClient()
    const disconnect = client.connect()
    const ready = () => {
      client.store.dispatch(serverExamples.welcome)
      client.store.dispatch({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" } as Action)
      client.store.dispatch({ type: "local/audio", phase: "running" })
    }
    return { client, disconnect, ready, played, stopped }
  }

  it("plays while connected with audio; stops when the connection is lost and starts again with the server's ring after the welcome", () => {
    const c = realClient()
    c.ready()
    c.client.store.dispatch(ring(card("live")))
    expect(c.played.length).toBe(1)
    vi.advanceTimersByTime(RING_EVERY_MS)
    expect(c.played.length).toBe(2)
    act(() => c.client.store.dispatch({ type: "local/connection", status: "reconnecting", attempt: 1 }))
    vi.advanceTimersByTime(3 * RING_EVERY_MS)
    expect(c.played.length).toBe(2)
    c.ready()
    c.client.store.dispatch(ring(card("live")))
    expect(c.played.length).toBe(3)
    c.disconnect()
  })

  it("stops on leaving the page and with the connection's clean-up; one loop only, however often it connects", () => {
    const c = realClient()
    const again = c.client.connect()
    c.ready()
    c.client.store.dispatch(ring(card("live")))
    vi.advanceTimersByTime(RING_EVERY_MS)
    expect(c.played.length).toBe(2)
    window.dispatchEvent(new Event("pagehide"))
    vi.advanceTimersByTime(3 * RING_EVERY_MS)
    expect(c.played.length).toBe(2)
    again()
    c.disconnect()
    c.client.store.dispatch(ring(card("other")))
    vi.advanceTimersByTime(3 * RING_EVERY_MS)
    expect(c.played.length).toBe(2)
  })
})

describe("the card", () => {
  const mount = (state: ClientState, request: (m: unknown) => Promise<unknown> = vi.fn(async () => ({ type: "result", requestId: "r", ok: true, say: "Snoozed." }))) => {
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
    await act(async () => {
      fireEvent.click(screen.getByText("Snooze"))
    })
    expect(request).toHaveBeenCalledWith({ type: "notification.action", id: "a", actionId: "snooze" })
    expect(store.get().notifications[0]?.quiet).toBe(true)
    expect(screen.getByText("Snoozed.")).toBeTruthy()
    act(() => store.dispatch(resolved("a")))
    expect(screen.queryByTestId("notification-card")).toBeNull()
  })

  it("b10: while a module action is pending, Stop stays usable (only the pending button is disabled); a late answer to a card that is gone is ignored", async () => {
    let answerSnooze: (v: unknown) => void = () => undefined
    const request = vi.fn((m: unknown) =>
      (m as { actionId: string }).actionId === "snooze"
        ? new Promise((resolve) => (answerSnooze = resolve))
        : Promise.resolve({ type: "result", requestId: "r", ok: true, say: "Done." })
    )
    const { store } = mount(run([ring(card("a"))]), request)
    await act(async () => {
      fireEvent.click(screen.getByText("Snooze"))
    })
    expect((screen.getByText("Snooze") as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText("Stop") as HTMLButtonElement).disabled).toBe(false)
    await act(async () => {
      fireEvent.click(screen.getByText("Stop"))
    })
    expect(request.mock.calls.map((c) => (c[0] as { actionId: string }).actionId)).toEqual(["snooze", "stop"])
    act(() => store.dispatch(resolved("a")))
    await act(async () => answerSnooze({ type: "result", requestId: "r", ok: true, say: "Late answer." }))
    expect(screen.queryByText("Late answer.")).toBeNull()
  })

  it("a card the server says not to show (a speaker without a display) is not drawn, but it still rings", () => {
    const s = run([ring(card("cue-only", { show: false }))])
    mount(s)
    expect(screen.queryByTestId("notification-card")).toBeNull()
    expect(wanted(s)).toBe(true)
  })

  it("b12: every word the card says itself comes from the server, in the household's language", () => {
    const dutch = card("a", { title: "Het water kookt", actions: [{ id: "stop", label: "Stop" }, { id: "later", label: "Later" }], texts: { region: "Meldingen", startAudio: "Zet het geluid aan om het te horen." } })
    mount(run([ring(dutch)]))
    expect(screen.getByTestId("notification-silent-note").textContent).toBe("Zet het geluid aan om het te horen.")
    expect(screen.getByRole("region", { name: "Meldingen" })).toBeTruthy()
  })

  it("b15: many long cards stay in a region that scrolls within the viewport, long text wraps, every Stop is there", () => {
    const long = (i: number) => card(`c${i}`, { title: "T".repeat(60), text: "x".repeat(200), sentAt: i })
    mount(run(Array.from({ length: 20 }, (_, i) => ring(long(i)))))
    const region = screen.getByTestId("notification-cards")
    expect(region.className).toContain("overflow-y-auto")
    expect(region.className).toMatch(/max-h-/)
    expect(screen.getAllByText("Stop").length).toBe(20)
    expect(screen.getAllByRole("heading")[0]!.className).toContain("overflow-wrap:anywhere")
  })
})
