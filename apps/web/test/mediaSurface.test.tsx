import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { MediaCommand, MediaStateMessage } from "@pva/protocol"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ClientContext } from "@/components/context.tsx"
import { MediaSurface } from "@/components/media/MediaSurface.tsx"
import { clock, mediaTexts } from "@/components/media/texts.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { MediaController } from "@/lib/media/controller.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { FakePlayer } from "./mediaFakes.ts"
import type { PagePlayer } from "../src/lib/media/types.ts"
import { YoutubePlayer, type YtGlobal } from "@/lib/media/youtube.ts"

const talk = { mode: "lower", level: 0.2 } as const

const setup = (players: Array<PagePlayer> = [new FakePlayer("spotify", { volumeSteps: 1 }), new FakePlayer("youtube", { pausesWhenHidden: true })]) => {
  const sent: Array<MediaStateMessage> = []
  const media = new MediaController({ players, send: (m) => (sent.push(m), true) })
  const store = createStore(initialState, reducer)
  const client = { store, media, request: vi.fn() } as unknown as AssistantClient
  const view = render(<ClientContext.Provider value={client}><MediaSurface /></ClientContext.Provider>)
  const command = (seq: number, c: MediaCommand) => act(() => media.handleCommand(seq, c))
  return { media, store, sent, players, view, command, music: players[0] as FakePlayer, video: players[1] as FakePlayer }
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  for (const a of ["data-music", "data-theatre", "data-theatre-badge"]) document.documentElement.removeAttribute(a)
})

const openMusic = (t: ReturnType<typeof setup>) => {
  t.command(1, { type: "open", source: "spotify", title: "So What", subtitle: "Miles Davis", autoplay: true, talk })
  act(() =>
    t.music.say({
      status: "playing",
      title: "So What",
      artist: "Miles Davis",
      album: "Kind of Blue",
      artUrl: "https://i.scdn.co/image/abc",
      link: "https://open.spotify.com/track/xyz",
      positionMs: 65_000,
      durationMs: 540_000,
      canNext: true,
      canPrevious: false
    })
  )
}

it("renders nothing without a media controller or while nothing is open", () => {
  const store = createStore(initialState, reducer)
  const bare = render(<ClientContext.Provider value={{ store } as unknown as AssistantClient}><MediaSurface /></ClientContext.Provider>)
  expect(bare.container.innerHTML).toBe("")
  cleanup()
  const t = setup()
  expect(t.view.container.innerHTML).toBe("")
})

it("the music panel shows cover, title, artist and a Spotify mark that links back", () => {
  const t = setup()
  openMusic(t)
  const panel = screen.getByTestId("music-panel")
  expect(panel.getAttribute("aria-label")).toBe("Now playing")
  expect(screen.getByTestId("music-title").textContent).toBe("So What")
  expect(screen.getByTestId("music-artist").textContent).toBe("Miles Davis")
  expect(panel.querySelector("img")!.getAttribute("src")).toBe("https://i.scdn.co/image/abc")
  const links = [...panel.querySelectorAll("a")].map((a) => a.getAttribute("href"))
  expect(links).toEqual(["https://open.spotify.com/track/xyz", "https://open.spotify.com/track/xyz"])
  expect(screen.getByTestId("spotify-attribution").textContent).toContain("Open in Spotify")
  expect(screen.getByTestId("music-position").textContent).toBe("1:05")
  expect(screen.getByTestId("music-duration").textContent).toBe("9:00")
  expect(document.documentElement.hasAttribute("data-music")).toBe(true)
  expect(document.documentElement.hasAttribute("data-theatre")).toBe(false)
})

it("an address that is not Spotify's is neither an image nor a link", () => {
  const t = setup()
  t.command(1, { type: "open", source: "spotify", title: "X", autoplay: true, talk })
  act(() => t.music.say({ status: "playing", title: "X", artUrl: "https://evil.example/a.png", link: "https://evil.example/t" }))
  expect(screen.getByTestId("music-panel").querySelector("img")).toBeNull()
  expect(screen.getByTestId("music-panel").querySelector("a")).toBeNull()
  expect(screen.getByTestId("spotify-attribution").textContent).toContain("Spotify")
})

it("a title is text, never markup", () => {
  const t = setup()
  t.command(1, { type: "open", source: "spotify", title: "<img src=x onerror=alert(1)>", autoplay: true, talk })
  expect(screen.getByTestId("music-title").textContent).toBe("<img src=x onerror=alert(1)>")
  expect(screen.getByTestId("music-panel").querySelectorAll("img")).toHaveLength(0)
})

it("the buttons call the player directly, and the change is reported", () => {
  const t = setup()
  openMusic(t)
  t.music.calls.length = 0
  fireEvent.click(screen.getByRole("button", { name: "Pause" }))
  fireEvent.click(screen.getByRole("button", { name: "Next track" }))
  expect(t.music.calls).toEqual(["pause", "next"])
  expect(screen.getByRole("button", { name: "Previous track" })).toBeDisabled() // canPrevious false
  act(() => t.music.say({ status: "paused", title: "So What", canNext: true }))
  fireEvent.click(screen.getByRole("button", { name: "Play" }))
  expect(t.music.calls.at(-1)).toBe("play")
  act(() => vi.advanceTimersByTime(300))
  expect(t.sent.at(-1)!.state.current?.status).toBe("paused")
  expect(t.sent.at(-1)!.ack).toBe(1) // touches add no ack of their own
})

it("seeking by drag commits on release; the volume slider acts at once and the close button closes", () => {
  const t = setup()
  openMusic(t)
  t.music.calls.length = 0
  const seek = screen.getByTestId("music-seek")
  fireEvent.change(seek, { target: { value: "120000" } })
  expect(t.music.calls).toEqual([]) // still dragging
  expect(screen.getByTestId("music-position").textContent).toBe("2:00")
  fireEvent.pointerUp(seek)
  expect(t.music.calls).toEqual(["seek:120000"])
  fireEvent.change(screen.getByTestId("music-volume"), { target: { value: "0.5" } })
  expect(t.music.calls.at(-1)).toBe("volume:0.5")
  fireEvent.click(screen.getByRole("button", { name: "Close music player" }))
  expect(t.music.calls.at(-1)).toBe("close")
  expect(screen.queryByTestId("music-panel")).toBeNull()
  expect(document.documentElement.hasAttribute("data-music")).toBe(false)
})

it("the position keeps moving while it plays", () => {
  const t = setup()
  openMusic(t)
  act(() => vi.advanceTimersByTime(3_000))
  expect(screen.getByTestId("music-position").textContent).toBe("1:08")
})

it("shows loading, blocked and error states in words", () => {
  const t = setup()
  t.command(1, { type: "open", source: "spotify", title: "X", autoplay: true, talk })
  expect(screen.getByTestId("media-status").textContent).toBe("Loading…")
  act(() => t.music.say({ status: "blocked", title: "X" }))
  expect(screen.getByTestId("media-status").textContent).toBe("Tap play to start")
  act(() => t.music.say({ status: "error", title: "X", errorCode: "account_error" }))
  expect(screen.getByTestId("media-status").textContent).toBe("Spotify needs a Premium account.")
})

it("Escape closes like a presentation does, but not while the assistant answers or a presentation is up", () => {
  const t = setup()
  openMusic(t)
  act(() => t.store.dispatch({ type: "state", state: "speaking", turnId: 1 }))
  fireEvent.keyDown(window, { key: "Escape" })
  expect(screen.queryByTestId("music-panel")).not.toBeNull()
  act(() => t.store.dispatch({ type: "state", state: "idle" }))
  act(() => t.store.dispatch({ type: "present.show", presentation: {
    id: "p", revision: "p:1", lifetime: "pinned", shownAt: 1, serverNow: 1, v: 1, content: { kind: "card", title: "Tea", facts: [] }, buttons: [], interactive: false, closable: true,
    texts: { region: "On screen", loading: "Loading", imageMissing: "Missing", timerDone: "Done", credit: "Image", high: "High", low: "Low" }
  } }))
  fireEvent.keyDown(window, { key: "Escape" })
  expect(screen.queryByTestId("music-panel")).not.toBeNull()
  act(() => t.store.dispatch({ type: "present.dismiss", id: "p" }))
  fireEvent.keyDown(window, { key: "Escape" })
  expect(t.music.calls.at(-1)).toBe("close")
  expect(screen.queryByTestId("music-panel")).toBeNull()
})

// -- The theatre ----------------------------------------------------------------------------------------------------

const yt = () => {
  class Y {
    readonly t: unknown
    readonly o: unknown
    constructor(t: unknown, o: unknown) {
      this.t = t
      this.o = o
    }
    destroy() {}
    pauseVideo() {}
    playVideo() {}
    seekTo() {}
    setVolume() {}
    getVolume() { return 100 }
    getCurrentTime() { return 0 }
    getDuration() { return 0 }
    getPlayerState() { return -1 }
  }
  return { Player: Y } as unknown as YtGlobal
}

const openVideo = (t: ReturnType<typeof setup>) => {
  t.command(1, { type: "open", source: "youtube", ref: "abc123", title: "Sharpening", autoplay: true, talk: { mode: "pause", level: 0.2 } })
  act(() => t.video.say({ status: "playing", title: "Sharpening", positionMs: 1_000 }))
}

it("the theatre has a strip of our own and a frame that holds nothing of ours; the character is a badge", () => {
  const t = setup()
  openVideo(t)
  const theatre = screen.getByTestId("theatre")
  const frame = screen.getByTestId("theatre-frame")
  const strip = screen.getByTestId("theatre-strip")
  expect(screen.getByTestId("theatre-title").textContent).toBe("Sharpening")
  expect(frame.className).toContain("aspect-video")
  // Nothing of ours inside the frame, and the controls are a sibling before it, not a descendant.
  expect(frame.children).toHaveLength(0)
  expect(strip.contains(frame)).toBe(false)
  expect(frame.contains(screen.getByTestId("media-close"))).toBe(false)
  expect(strip.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(theatre.getAttribute("data-badge")).toBe("true")
  const root = document.documentElement
  expect(root.hasAttribute("data-theatre")).toBe(true)
  expect(root.hasAttribute("data-theatre-badge")).toBe(true)
  expect(root.hasAttribute("data-music")).toBe(false)
})

it("the character grows back while the assistant talks, and shrinks again after", () => {
  const t = setup()
  openVideo(t)
  act(() => t.media.setTalking(true))
  expect(document.documentElement.hasAttribute("data-theatre")).toBe(true)
  expect(document.documentElement.hasAttribute("data-theatre-badge")).toBe(false)
  expect(screen.getByTestId("theatre").getAttribute("data-badge")).toBeNull()
  act(() => t.media.setTalking(false))
  expect(document.documentElement.hasAttribute("data-theatre-badge")).toBe(true)
})

it("the close button closes the video and takes the frame away", () => {
  const t = setup()
  openVideo(t)
  fireEvent.click(screen.getByRole("button", { name: "Close video" }))
  expect(t.video.calls.at(-1)).toBe("close")
  expect(screen.queryByTestId("theatre")).toBeNull()
  expect(document.documentElement.hasAttribute("data-theatre")).toBe(false)
  expect(document.documentElement.hasAttribute("data-theatre-badge")).toBe(false)
})

it("a refused video says why in the strip", () => {
  const t = setup()
  openVideo(t)
  act(() => t.video.say({ status: "error", title: "Sharpening", errorCode: "embed_refused" }))
  expect(screen.getByTestId("media-status").textContent).toBe("This video cannot be played here.")
})

it("the real YouTube player draws into the frame element and only a frame is ever in it", () => {
  const win = { YT: yt(), location: { origin: "https://home.example" } }
  const player = new YoutubePlayer({ win: win as never, loadScript: async () => {} })
  const t = setup([new FakePlayer("spotify"), player])
  t.command(1, { type: "open", source: "youtube", ref: "abc123", title: "V", autoplay: true, talk })
  const frame = screen.getByTestId("theatre-frame")
  expect([...frame.children].map((c) => c.tagName)).toEqual(["IFRAME"])
  expect(frame.querySelector("iframe")!.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin")
  expect(frame.querySelector("iframe")!.getAttribute("allow")).toContain("autoplay")
  // The strip and its buttons are outside it.
  expect(frame.querySelectorAll("button")).toHaveLength(0)
})

it("speaks Dutch when the page is Dutch", () => {
  expect(mediaTexts("nl-NL").close).toBe("Muziekspeler sluiten")
  expect(mediaTexts("en-GB").close).toBe("Close music player")
  expect(mediaTexts("fr").close).toBe("Close music player")
  expect(clock(3_725_000)).toBe("1:02:05")
  expect(clock(-5)).toBe("0:00")
})
