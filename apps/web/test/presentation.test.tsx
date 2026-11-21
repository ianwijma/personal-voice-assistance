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

describe("larger while shown, and closed by touch", () => {
  const closable = (id: string, extra: Partial<PresentationWire> = {}) => show(wire(id, CARD, { closable: true, texts: { ...EN, close: "Close" }, ...extra }))
  const closeRequests = (request: ReturnType<typeof vi.fn>) => request.mock.calls.map((c) => c[0] as { type: string }).filter((m) => m.type === "present.close")

  it("a closable presentation has a close button of at least 44 px with the server's name, in both languages; one that is not has none", () => {
    mount(run([closable("en1"), closable("nl1", { texts: { ...NL, close: "Sluiten" } }), show(wire("plain", { ...CARD, title: "Plain" }))]))
    const buttons = screen.getAllByTestId("presentation-close")
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Close", "Sluiten"])
    for (const b of buttons) expect(b.className).toContain("size-11")
    // An older server never marks one closable (and sends no name): no button.
    cleanup()
    mount(run([show(wire("older", CARD, { closable: true }))]))
    expect(screen.queryByTestId("presentation-close")).toBeNull()
  })

  it("a tap hides it at once and tells the server; the server's dismissal takes it away for good", async () => {
    let answer: (v: unknown) => void = () => undefined
    const request = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    const { store } = mount(run([closable("a"), closable("b", { content: { ...CARD, title: "Other" }, shownAt: 2_000 })]), request)
    await act(async () => fireEvent.click(screen.getAllByTestId("presentation-close")[0]!))
    expect(closeRequests(request)).toEqual([{ type: "present.close", id: "a", revision: "a:1" }])
    expect(screen.getAllByTestId("presentation")).toHaveLength(1)
    expect(screen.getByRole("heading").textContent).toBe("Other")
    await act(async () => answer({ ok: true }))
    await act(async () => store.dispatch(dismiss("a")))
    expect(screen.getAllByTestId("presentation")).toHaveLength(1)
    // The same id shown again later (a key shown again) is a new showing: it is drawn.
    await act(async () => store.dispatch(closable("a", { revision: "a2:1" })))
    expect(screen.getAllByTestId("presentation")).toHaveLength(2)
  })

  it.each([
    ["a refusal", async () => ({ ok: false, say: "That changed just now.", error: { code: "bad_message", message: "x" } }), "That changed just now."],
    ["a lost connection", async () => Promise.reject(new Error("lost")), EN.failed]
  ] as const)("after %s it comes back with the sentence", async (_name, answer, sentence) => {
    mount(run([closable("a")]), vi.fn(answer))
    await act(async () => fireEvent.click(screen.getByTestId("presentation-close")))
    expect(screen.getByTestId("presentation")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toBe(sentence)
  })

  it("a refused close of one the server took away meanwhile does not bring it back", async () => {
    let answer: (v: unknown) => void = () => undefined
    const { store } = mount(run([closable("a")]), vi.fn(() => new Promise((resolve) => { answer = resolve })))
    await act(async () => fireEvent.click(screen.getByTestId("presentation-close")))
    await act(async () => store.dispatch(dismiss("a")))
    await act(async () => answer({ ok: false, say: "I can't do that right now." }))
    expect(screen.queryByTestId("presentation")).toBeNull()
  })

  it("a tap on the content, a tick or a button never closes it", async () => {
    const request = vi.fn(async () => ({ ok: true, say: "Ticked." }))
    mount(run([show(wire("l", LIST, { closable: true, texts: { ...EN, close: "Close" }, buttons: [{ id: "clear", label: "Clear" }] }))]), request)
    await act(async () => fireEvent.click(screen.getByText("Shopping")))
    await act(async () => fireEvent.click(screen.getAllByRole("checkbox")[0]!))
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear" })))
    expect(closeRequests(request)).toEqual([])
    expect(screen.getByTestId("presentation")).toBeTruthy()
  })

  it("Escape closes the newest closable one; not while a reply plays (Escape stops that), not while covered, not one that is not closable", async () => {
    const request = vi.fn(async () => ({ ok: true }))
    const { store } = mount(run([closable("old", { shownAt: 1 }), closable("new", { shownAt: 5, content: { ...CARD, title: "Newest" } }), show(wire("fixed", CARD, { shownAt: 9 }))]), request)
    act(() => store.dispatch({ type: "state", state: "speaking" } as unknown as Action))
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }))
    expect(closeRequests(request)).toEqual([])
    act(() => store.dispatch({ type: "state", state: "idle" } as unknown as Action))
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }))
    expect(closeRequests(request)).toEqual([{ type: "present.close", id: "new", revision: "new:1" }])
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }))
    expect(closeRequests(request).map((m) => (m as { id?: string }).id)).toEqual(["new", "old"])
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }))
    expect(closeRequests(request)).toHaveLength(2)
    cleanup()
    const covered = vi.fn(async () => ({ ok: true }))
    render(<ClientContext.Provider value={{ store: createStore(run([closable("c")]), reducer), request: covered } as unknown as AssistantClient}><PresentationStage obscured /></ClientContext.Provider>)
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }))
    expect(closeRequests(covered)).toEqual([])
  })

  it("the character yields while something is shown: data-presenting on the root, gone when covered, closed or withdrawn", async () => {
    const root = document.documentElement
    const { store } = mount(run([closable("a")]), vi.fn(() => new Promise(() => undefined)))
    expect(root.hasAttribute("data-presenting")).toBe(true)
    await act(async () => fireEvent.click(screen.getByTestId("presentation-close")))
    expect(root.hasAttribute("data-presenting")).toBe(false)
    await act(async () => store.dispatch(closable("b")))
    expect(root.hasAttribute("data-presenting")).toBe(true)
    await act(async () => store.dispatch(dismiss("b")))
    expect(root.hasAttribute("data-presenting")).toBe(false)
    cleanup()
    render(<ClientContext.Provider value={{ store: createStore(run([closable("c")]), reducer), request: vi.fn() } as unknown as AssistantClient}><PresentationStage obscured /></ClientContext.Provider>)
    expect(root.hasAttribute("data-presenting")).toBe(false)
  })

  it("the area takes most of the screen: under the header and the character's strip down to the controls, up to 960 px; an image is scaled to fit with its caption", () => {
    mount(run([closable("img", { content: IMAGE("ready") }), closable("card", { shownAt: 2_000 })]))
    const stage = screen.getByTestId("present-stage")
    expect(stage.className).toContain("top-[calc(var(--pva-notifications-space,0px)_+_56px_+_var(--pva-present-gap,76px))]")
    expect(stage.className).toContain("bottom-[calc(96px_+_env(safe-area-inset-bottom))]")
    expect((stage.firstElementChild as HTMLElement).className).toContain("max-w-[960px]")
    const [image, card] = screen.getAllByTestId("presentation")
    expect(image!.className).toContain("max-w-[960px]")
    expect(card!.className).toContain("max-w-[680px]")
    const img = screen.getByAltText("A heron")
    expect(img.className).toContain("object-contain")
    expect(img.className).toMatch(/max-h-\[max\(120px,calc\(var\(--pva-present-room/)
  })
})
