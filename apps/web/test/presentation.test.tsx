// P10: the presentation stage on the voice page (docs/PRESENTING.md "The voice page"): the page keeps what the server
// sends (show, update, dismiss; emptied at a welcome and when the session ends), one renderer per kind with every word
// the host shows from the server, both themes and both languages, ticks and buttons sent as present.action with the
// answer shown while it is held, a countdown to the server's instant on a page whose clock is off, long and many, the
// notification cards separate from the presentation stage, and the page's declaration of the kinds.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MAX_PRESENTATIONS_PER_PAGE, PRESENT_KIND_VERSIONS, type PresentationWire, type ServerMessage } from "@pva/protocol"
import { serverExamples } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import { measureCapabilities, PRESENT_KINDS } from "@/lib/capabilities.ts"
import { formatRemaining, remainingMs } from "@/lib/countdown.ts"
import { type Action, type ClientState, initialState, pageClock, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { PresentationStage } from "@/components/PresentationStage.tsx"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.documentElement.classList.remove("dark")
})

const EN = { region: "On screen", loading: "Loading the image…", imageMissing: "The image is not available.", timerDone: "Done", credit: "Image:", high: "High", low: "Low", failed: "That didn't work." }
const NL = { region: "Op het scherm", loading: "De afbeelding wordt geladen…", imageMissing: "De afbeelding is niet beschikbaar.", timerDone: "Klaar", credit: "Afbeelding:", high: "Hoog", low: "Laag", failed: "Dat lukte niet." }

const wire = (id: string, content: PresentationWire["content"], extra: Partial<PresentationWire> = {}): PresentationWire => ({
  id,
  revision: `${id}:1`,
  lifetime: "pinned",
  shownAt: 1_000,
  serverNow: 1_000,
  v: 1,
  content,
  buttons: [],
  interactive: true,
  texts: EN,
  ...extra
})
const show = (p: PresentationWire): Action => ({ type: "present.show", presentation: p })
const update = (p: PresentationWire): Action => ({ type: "present.update", presentation: p })
const dismiss = (id: string): Action => ({ type: "present.dismiss", id })
const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)

const mount = (state: ClientState, request: (m: unknown) => Promise<unknown> = vi.fn(async () => ({ type: "result", requestId: "r", ok: true, say: "Ticked." }))) => {
  const store = createStore(state, reducer)
  const client = { store, request } as unknown as AssistantClient
  render(<ClientContext.Provider value={client}><PresentationStage /></ClientContext.Provider>)
  return { store, request }
}

const CARD: PresentationWire["content"] = { kind: "card", title: "Bins out", text: "Paper tonight\nGlass on Friday", facts: [{ label: "Where", value: "Front door" }] }
const LIST: PresentationWire["content"] = { kind: "list", title: "Shopping", style: "checklist", items: [{ id: "milk", text: "Milk", done: false }, { id: "eggs", text: "Eggs", done: true }] }
const IMAGE = (state: "loading" | "ready" | "failed"): PresentationWire["content"] => ({
  kind: "image",
  alt: "A heron",
  credit: "Wikimedia Commons, CC BY-SA",
  caption: "Grey heron",
  image: state === "ready" ? { state, token: "a".repeat(32) } : { state }
})
const WEATHER: PresentationWire["content"] = {
  kind: "weather",
  place: "Utrecht",
  now: { temperature: "12°", condition: "Light rain", icon: "rain" },
  days: [{ label: "Thu", high: "14°", low: "8°", icon: "partly" }, { label: "Fri", high: "11°", low: "6°", icon: "sun" }]
}

describe("what the page keeps", () => {
  it("holds a presentation from show until dismiss, replaces it on update in place, and empties at a welcome and when the session ends", () => {
    vi.spyOn(pageClock, "mono").mockReturnValue(500)
    const s1 = run([show(wire("a", CARD)), show(wire("b", LIST))])
    expect(s1.presentations.map((p) => p.id)).toEqual(["a", "b"])
    expect(s1.presentations[0]!.receivedMono).toBe(500)
    const s2 = run([update(wire("a", { ...CARD, title: "Changed" }))], s1)
    expect(s2.presentations.map((p) => [p.id, p.content.kind === "card" ? p.content.title : ""])).toEqual([["a", "Changed"], ["b", ""]])
    expect(run([dismiss("a")], s2).presentations.map((p) => p.id)).toEqual(["b"])
    expect(run([serverExamples.welcome], s2).presentations).toEqual([])
    expect(run([{ type: "local/session-ended" } as unknown as Action], s2).presentations).toEqual([])
  })

  it("keeps every presentation it is sent (the server bounds a page), never cutting", () => {
    const many = run(Array.from({ length: MAX_PRESENTATIONS_PER_PAGE + 3 }, (_, i) => show(wire(`p${i}`, CARD))))
    expect(many.presentations).toHaveLength(MAX_PRESENTATIONS_PER_PAGE + 3)
  })

  it("the page declares every kind of the first version", () => {
    expect(PRESENT_KINDS).toEqual(PRESENT_KIND_VERSIONS)
    const caps = measureCapabilities({ width: 800, height: 600, dpr: 1, matches: () => false, userAgent: "", audioOut: true, microphone: true })
    expect(caps.present?.kinds).toEqual(PRESENT_KIND_VERSIONS)
  })
})

describe("one renderer per kind, in both themes and both languages", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const lang of ["en", "nl"] as const) {
      it(`${theme}, ${lang}: card, checklist, timer, image (three states) and weather draw their texts as text and the host's words from the server`, () => {
        if (theme === "dark") document.documentElement.classList.add("dark")
        vi.spyOn(pageClock, "now").mockReturnValue(1_000)
        const texts = lang === "en" ? EN : NL
        mount(run([
          show(wire("card", CARD, { texts })),
          show(wire("list", LIST, { texts })),
          show(wire("timer", { kind: "timer", label: "Pasta", endsAt: 1_000 + 5 * 60_000 }, { texts })),
          show(wire("img1", IMAGE("loading"), { texts })),
          show(wire("img2", IMAGE("failed"), { texts })),
          show(wire("img3", IMAGE("ready"), { texts })),
          show(wire("weather", WEATHER, { texts }))
        ]))
        expect(screen.getByRole("region", { name: texts.region })).toBeTruthy()
        expect(screen.getByText("Bins out")).toBeTruthy()
        expect(screen.getByText("Front door")).toBeTruthy()
        expect(screen.getByText(/Paper tonight/).className).toContain("whitespace-pre-line")
        expect(screen.getAllByRole("checkbox").map((c) => [c.textContent, c.getAttribute("aria-checked")])).toEqual([["Milk", "false"], ["Eggs", "true"]])
        expect(screen.getByRole("timer").textContent).toBe("5:00")
        expect(screen.getAllByTestId("image-state").map((e) => e.textContent)).toEqual([texts.loading, texts.imageMissing])
        const img = screen.getByAltText("A heron") as HTMLImageElement
        expect(img.getAttribute("src")).toBe(`/media/${"a".repeat(32)}`)
        expect(screen.getAllByText(`${texts.credit} Wikimedia Commons, CC BY-SA`)).toHaveLength(3)
        expect(screen.getByText("12°")).toBeTruthy()
        expect(screen.getAllByText(`${texts.high}`, { exact: false }).length).toBeGreaterThan(0)
      })
    }
  }

  it("text from a presentation is never markup", () => {
    mount(run([show(wire("x", { kind: "card", title: "<img src=x onerror=alert(1)>", facts: [] }))]))
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy()
    expect(document.querySelector("img[src='x']")).toBeNull()
  })
})

describe("ticks and buttons", () => {
  it("a tick and a button send present.action; the answer is shown while it is held; a late answer after it is gone is ignored", async () => {
    let answerLate: (v: unknown) => void = () => undefined
    const request = vi.fn((m: unknown) =>
      (m as { action: string }).action === "late" ? new Promise((resolve) => (answerLate = resolve)) : Promise.resolve({ type: "result", requestId: "r", ok: true, say: "Ticked." })
    )
    const { store } = mount(run([show(wire("l", LIST, { buttons: [{ id: "late", label: "Later" }] }))]), request)
    await act(async () => {
      fireEvent.click(screen.getAllByRole("checkbox")[0]!)
    })
    expect(request).toHaveBeenCalledWith({ type: "present.action", id: "l", revision: "l:1", action: "tick", item: "milk", done: true })
    expect(screen.getByText("Ticked.")).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByText("Later"))
    })
    expect((screen.getByText("Later") as HTMLButtonElement).disabled).toBe(true)
    act(() => store.dispatch(dismiss("l")))
    await act(async () => answerLate({ type: "result", requestId: "r", ok: true, say: "Too late." }))
    expect(screen.queryByText("Too late.")).toBeNull()
  })

  it("where the server says it may not be pressed, ticks and buttons are disabled and nothing is sent", async () => {
    const request = vi.fn(async () => ({}))
    mount(run([show(wire("l", LIST, { interactive: false, buttons: [{ id: "clear", label: "Clear" }] }))]), request)
    for (const b of [...screen.getAllByRole("checkbox"), screen.getByText("Clear")]) {
      expect((b as HTMLButtonElement).disabled).toBe(true)
      await act(async () => {
        fireEvent.click(b)
      })
    }
    expect(request).not.toHaveBeenCalled()
  })
})

describe("the countdown", () => {
  it("counts down to the server's instant on a page whose wall clock is off, on its monotonic clock, and says the server's word at zero", () => {
    vi.useFakeTimers()
    try {
      // The server says it ends 5 minutes from its own now; the page's wall clock is ten minutes behind and is not read.
      const serverNow = Date.UTC(2026, 10, 19, 12)
      let mono = 1_000
      vi.spyOn(pageClock, "now").mockReturnValue(serverNow - 10 * 60_000)
      vi.spyOn(pageClock, "mono").mockImplementation(() => mono)
      mount(run([show(wire("t", { kind: "timer", label: "Pasta", endsAt: serverNow + 5 * 60_000 }, { serverNow, texts: NL }))]))
      expect(screen.getByRole("timer").textContent).toBe("5:00")
      mono += 61_000
      act(() => void vi.advanceTimersByTime(250))
      expect(screen.getByRole("timer").textContent).toBe("3:59")
      mono += 4 * 60_000
      act(() => void vi.advanceTimersByTime(250))
      expect(screen.getByRole("timer").textContent).toBe("Klaar")
    } finally {
      vi.useRealTimers()
    }
    expect(remainingMs(10_000, 2_000, 100, 5_100)).toBe(3_000)
    expect(formatRemaining(3_723_400)).toBe("1:02:04")
    expect(formatRemaining(0)).toBe("0:00")
  })

  it("b6: a jump of the page's wall clock, forward past zero and back, neither ends nor freezes a running countdown", () => {
    vi.useFakeTimers()
    try {
      const serverNow = Date.UTC(2026, 10, 19, 12)
      let wall = serverNow
      let mono = 0
      vi.spyOn(pageClock, "now").mockImplementation(() => wall)
      vi.spyOn(pageClock, "mono").mockImplementation(() => mono)
      mount(run([show(wire("t", { kind: "timer", label: "Tea", endsAt: serverNow + 60_000 }, { serverNow }))]))
      expect(screen.getByRole("timer").textContent).toBe("1:00")
      wall += 3_600_000
      mono += 1_000
      act(() => void vi.advanceTimersByTime(250))
      expect(screen.getByRole("timer").textContent).toBe("0:59")
      wall -= 3_600_000
      mono += 9_000
      act(() => void vi.advanceTimersByTime(250))
      expect(screen.getByRole("timer").textContent).toBe("0:50")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("a page without its server", () => {
  it("b2: losing the connection clears what the server showed (the notification cards keep their own rule); a welcome starts afresh", () => {
    const ring: ServerMessage = { ...serverExamples["notification.ring"], notification: { ...serverExamples["notification.ring"].notification, id: "n1" } }
    const held = run([ring, show(wire("t", CARD, { lifetime: "transient" })), show(wire("p", CARD))])
    const lost = run([{ type: "local/socket-lost" } as Action], held)
    expect(lost.presentations).toEqual([])
    expect(lost.notifications.map((n) => n.id)).toEqual(held.notifications.map((n) => n.id))
    expect(run([{ type: "local/connection", status: "reconnecting", attempt: 1 } as Action], held).presentations).toEqual([])
  })

  it("b7: an image the browser cannot load shows the server's sentence for a missing image, with its caption and credit", () => {
    mount(run([show(wire("i", IMAGE("ready")))]))
    fireEvent.error(screen.getByAltText("A heron"))
    expect(screen.queryByAltText("A heron")).toBeNull()
    expect(screen.getByTestId("image-state").textContent).toBe(EN.imageMissing)
    expect(screen.getByText("Grey heron")).toBeTruthy()
    expect(screen.getByText(`${EN.credit} Wikimedia Commons, CC BY-SA`)).toBeTruthy()
  })
})

describe("long and many, with notifications in their own fixed region", () => {
  it("many long presentations scroll within the viewport; long text wraps; rings do not enter the stage", () => {
    const longCard = (i: number): PresentationWire => wire(`c${i}`, { kind: "card", title: "T".repeat(60), text: "x".repeat(300), facts: Array.from({ length: 6 }, () => ({ label: "L".repeat(30), value: "V".repeat(60) })) }, { shownAt: i })
    const ring: ServerMessage = { ...serverExamples["notification.ring"], notification: { ...serverExamples["notification.ring"].notification, id: "n1" } }
    mount(run([ring, ...Array.from({ length: MAX_PRESENTATIONS_PER_PAGE }, (_, i) => show(longCard(i)))]))
    const stage = screen.getByTestId("present-stage")
    const scroller = stage.firstElementChild as HTMLElement
    expect(scroller.className).toContain("overflow-y-auto")
    expect(scroller.className).toMatch(/max-h-/)
    expect(screen.getAllByTestId("presentation")).toHaveLength(MAX_PRESENTATIONS_PER_PAGE)
    // A ring must not change this stage's size or move presentations underneath an aimed-at pointer.
    expect(screen.queryByTestId("notification-card")).toBeNull()
    expect(screen.getAllByRole("heading").every((h) => h.className.includes("overflow-wrap:anywhere"))).toBe(true)
  })

  it("a transient presentation is drawn first, then the pinned ones oldest first; nothing at all draws nothing", () => {
    mount(run([
      show(wire("p2", { ...CARD, title: "Newer" }, { shownAt: 20 })),
      show(wire("t", { ...CARD, title: "Now" }, { lifetime: "transient", shownAt: 30 })),
      show(wire("p1", { ...CARD, title: "Older" }, { shownAt: 10 }))
    ]))
    expect(screen.getAllByTestId("presentation").map((e) => e.getAttribute("data-lifetime"))).toEqual(["transient", "pinned", "pinned"])
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Now", "Older", "Newer"])
    cleanup()
    mount(run([serverExamples["notification.ring"]]))
    expect(screen.queryByTestId("present-stage")).toBeNull()
  })
})

// b4: the stable key belongs to multiple showings; interactions belong to the displayed revision.
it("a replacement clears a pending press and ignores its reply, and clears an answer already shown", async () => {
  let finish: (v: unknown) => void = () => undefined
  const request = vi.fn(() => new Promise((resolve) => { finish = resolve }))
  const drink = (title: string, revision: string) => wire("drink", { ...CARD, title }, { revision, buttons: [{ id: "choose", label: "Choose" }] })
  const { store } = mount(run([show(drink("Tea", "tea:1"))]), request)
  await act(async () => fireEvent.click(screen.getByRole("button")))
  await act(async () => store.dispatch(update(drink("Coffee", "coffee:2"))))
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false)
  await act(async () => finish({ ok: true, say: "Tea selected." }))
  expect(screen.queryByText("Tea selected.")).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole("button")))
  await act(async () => finish({ ok: true, say: "Coffee selected." }))
  expect(screen.getByText("Coffee selected.")).toBeTruthy()
  await act(async () => store.dispatch(update(drink("Water", "water:3"))))
  expect(screen.queryByText("Coffee selected.")).toBeNull()
})


it.each(["timeout", "rejection"])("r2 b5: a Dutch presentation uses its localized fallback after a transport %s", async (fault) => {
  const request = vi.fn(() => fault === "timeout"
    ? Promise.resolve({ ok: false, error: { message: "The assistant did not answer in time." } })
    : Promise.reject(new Error("Connection lost")))
  mount(run([show(wire("dutch", CARD, { texts: NL, buttons: [{ id: "choose", label: "Kies" }] }))]), request)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Kies" })))
  expect(screen.getByRole("status").textContent).toBe(NL.failed)
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false)
})

it("r2 b5: a server's press answer takes precedence over the transport fallback", async () => {
  mount(run([show(wire("dutch", CARD, { texts: NL, buttons: [{ id: "choose", label: "Kies" }] }))]), async () => ({ ok: false, say: "Probeer straks opnieuw.", error: { message: "Diagnostic" } }))
  await act(async () => fireEvent.click(screen.getByRole("button")))
  expect(screen.getByRole("status").textContent).toBe("Probeer straks opnieuw.")
})
