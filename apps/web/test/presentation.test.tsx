// P10: the presentation stage on the voice page (docs/PRESENTING.md "The voice page"): the page keeps what the server
// sends (show, update, dismiss; emptied at a welcome and when the session ends), one renderer per kind with every word
// the host shows from the server, both themes and both languages, ticks and buttons sent as present.action with the
// answer shown while it is held, a countdown to the server's instant on a page whose clock is off, long and many, the
// notification cards first in the same stage, and the page's declaration of the kinds.
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

const EN = { region: "On screen", loading: "Loading the image…", imageMissing: "The image is not available.", timerDone: "Done", credit: "Image:", high: "High", low: "Low" }
const NL = { region: "Op het scherm", loading: "De afbeelding wordt geladen…", imageMissing: "De afbeelding is niet beschikbaar.", timerDone: "Klaar", credit: "Afbeelding:", high: "Hoog", low: "Laag" }

const wire = (id: string, content: PresentationWire["content"], extra: Partial<PresentationWire> = {}): PresentationWire => ({
  id,
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
  image: state === "ready" ? { state, hash: "a".repeat(64) } : { state }
})
const WEATHER: PresentationWire["content"] = {
  kind: "weather",
  place: "Utrecht",
  now: { temperature: "12°", condition: "Light rain", icon: "rain" },
  days: [{ label: "Thu", high: "14°", low: "8°", icon: "partly" }, { label: "Fri", high: "11°", low: "6°", icon: "sun" }]
}

describe("what the page keeps", () => {
  it("holds a presentation from show until dismiss, replaces it on update in place, and empties at a welcome and when the session ends", () => {
    vi.spyOn(pageClock, "now").mockReturnValue(500)
    const s1 = run([show(wire("a", CARD)), show(wire("b", LIST))])
    expect(s1.presentations.map((p) => p.id)).toEqual(["a", "b"])
    expect(s1.presentations[0]!.clockOffset).toBe(500)
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
        expect(img.getAttribute("src")).toBe(`/media/${"a".repeat(64)}`)
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
    expect(request).toHaveBeenCalledWith({ type: "present.action", id: "l", action: "tick", item: "milk", done: true })
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
  it("counts down to the server's instant on a page whose clock is ten minutes off, and says the server's word at zero", () => {
    vi.useFakeTimers()
    try {
      // The server's clock is 10 minutes ahead of the page's: it ends 5 minutes from the server's now.
      const serverNow = Date.UTC(2026, 10, 19, 12)
      const page = serverNow - 10 * 60_000
      let now = page
      vi.spyOn(pageClock, "now").mockImplementation(() => now)
      mount(run([show(wire("t", { kind: "timer", label: "Pasta", endsAt: serverNow + 5 * 60_000 }, { serverNow, texts: NL }))]))
      expect(screen.getByRole("timer").textContent).toBe("5:00")
      now += 61_000
      act(() => void vi.advanceTimersByTime(250))
      expect(screen.getByRole("timer").textContent).toBe("3:59")
      now += 4 * 60_000
      act(() => void vi.advanceTimersByTime(250))
      expect(screen.getByRole("timer").textContent).toBe("Klaar")
    } finally {
      vi.useRealTimers()
    }
    expect(remainingMs(10_000, 2_000, 5_000)).toBe(3_000)
    expect(formatRemaining(3_723_400)).toBe("1:02:04")
    expect(formatRemaining(0)).toBe("0:00")
  })
})

describe("long and many, and the notification cards in the same stage", () => {
  it("many long presentations and cards stay in one region that scrolls within the viewport; long text wraps; the cards come first", () => {
    const longCard = (i: number): PresentationWire => wire(`c${i}`, { kind: "card", title: "T".repeat(60), text: "x".repeat(300), facts: Array.from({ length: 6 }, () => ({ label: "L".repeat(30), value: "V".repeat(60) })) }, { shownAt: i })
    const ring: ServerMessage = { ...serverExamples["notification.ring"], notification: { ...serverExamples["notification.ring"].notification, id: "n1" } }
    mount(run([ring, ...Array.from({ length: MAX_PRESENTATIONS_PER_PAGE }, (_, i) => show(longCard(i)))]))
    const stage = screen.getByTestId("present-stage")
    const scroller = stage.firstElementChild as HTMLElement
    expect(scroller.className).toContain("overflow-y-auto")
    expect(scroller.className).toMatch(/max-h-/)
    expect(screen.getAllByTestId("presentation")).toHaveLength(MAX_PRESENTATIONS_PER_PAGE)
    // The notification cards first, then the presentations.
    const order = [...scroller.querySelectorAll("[data-testid=notification-card],[data-testid=presentation]")].map((e) => e.getAttribute("data-testid"))
    expect(order[0]).toBe("notification-card")
    expect(screen.getAllByRole("heading").every((h) => h.className.includes("overflow-wrap:anywhere"))).toBe(true)
  })

  it("a transient presentation is drawn first, then the pinned ones oldest first; nothing at all draws nothing", () => {
    mount(run([
      show(wire("p2", CARD, { shownAt: 20 })),
      show(wire("t", { ...CARD, title: "Now" }, { lifetime: "transient", shownAt: 30 })),
      show(wire("p1", CARD, { shownAt: 10 }))
    ]))
    expect(screen.getAllByTestId("presentation").map((e) => e.getAttribute("data-lifetime"))).toEqual(["transient", "pinned", "pinned"])
    cleanup()
    mount(initialState)
    expect(screen.queryByTestId("present-stage")).toBeNull()
  })
})
