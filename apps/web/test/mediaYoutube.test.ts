import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { errorCodeOf, IFRAME_ALLOW, IFRAME_REFERRER_POLICY, YOUTUBE_API_URL, YoutubePlayer, type YtGlobal, type YtPlayer } from "@/lib/media/youtube.ts"
import type { PlayerCurrent, PlayerReport } from "@/lib/media/types.ts"

type Handlers = Record<string, (e: { data?: number; target?: YtPlayer }) => void>
class FakeYt implements YtPlayer {
  static last: FakeYt | undefined
  static all: Array<FakeYt> = []
  calls: Array<string> = []
  title = "Sharpening a knife"
  duration = 300
  time = 0
  volume = 100
  destroyed = false
  readonly target: HTMLElement | string
  readonly options: { events?: Handlers }
  constructor(target: HTMLElement | string, options: { events?: Handlers }) {
    this.target = target
    this.options = options
    FakeYt.last = this
    FakeYt.all.push(this)
  }
  playVideo() {
    this.calls.push("play")
  }
  pauseVideo() {
    this.calls.push("pause")
  }
  seekTo(s: number) {
    this.calls.push(`seek:${s}`)
  }
  setVolume(v: number) {
    this.calls.push(`volume:${v}`)
    this.volume = v
  }
  getVolume() {
    return this.volume
  }
  getCurrentTime() {
    return this.time
  }
  getDuration() {
    return this.duration
  }
  getPlayerState() {
    return -1
  }
  getVideoData() {
    return { title: this.title }
  }
  destroy() {
    this.destroyed = true
  }
  fire(name: string, data?: number) {
    this.options.events?.[name]?.({ ...(data !== undefined ? { data } : {}), target: this })
  }
}

const rig = (opts: { apiThere?: boolean } = {}) => {
  const win: { YT?: YtGlobal; onYouTubeIframeAPIReady?: () => void; location: { origin: string } } = { location: { origin: "https://home.example" } }
  if (opts.apiThere !== false) win.YT = { Player: FakeYt }
  const loaded: Array<string> = []
  const player = new YoutubePlayer({
    win,
    loadScript: async (src) => {
      loaded.push(src)
    }
  })
  const reports: Array<PlayerReport> = []
  const currents: Array<PlayerCurrent> = []
  player.attach({ report: (r) => reports.push(r), current: (c) => currents.push(c), needsCredential: () => {} })
  const el = document.createElement("div")
  document.body.appendChild(el)
  return { player, win, loaded, reports, currents, el }
}
const OPEN = { source: "youtube", ref: "abc123", title: "From the server", autoplay: true } as const

beforeEach(() => {
  vi.useFakeTimers()
  FakeYt.last = undefined
  FakeYt.all = []
})
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ""
})

describe("loading", () => {
  it("loads nothing until prepare or the first open; prepare with the API there reports ready", async () => {
    const r = rig({ apiThere: false })
    expect(r.loaded).toEqual([])
    r.player.prepare()
    await vi.advanceTimersByTimeAsync(5)
    expect(r.loaded).toEqual([YOUTUBE_API_URL])
    expect(r.reports.at(-1)).toEqual({ ready: false })
    r.win.YT = { Player: FakeYt }
    r.win.onYouTubeIframeAPIReady?.()
    expect(r.reports.at(-1)).toEqual({ ready: true })
  })

  it("an open before the API and the frame element waits for both, then builds", async () => {
    const r = rig({ apiThere: false })
    r.player.open({ ...OPEN })
    r.player.mount(r.el)
    expect(FakeYt.last).toBeUndefined()
    r.win.YT = { Player: FakeYt }
    r.win.onYouTubeIframeAPIReady?.()
    expect(FakeYt.last).toBeDefined()
    expect(r.el.querySelector("iframe")).not.toBeNull()
  })
})

describe("the frame", () => {
  it("is built with the permissions and the referrer policy it needs, and the API's origin parameters", () => {
    const r = rig()
    r.player.mount(r.el)
    r.player.open({ ...OPEN, startAtMs: 65_000 })
    const iframe = r.el.querySelector("iframe")!
    expect(iframe.getAttribute("allow")).toBe(IFRAME_ALLOW)
    expect(iframe.getAttribute("allow")).toBe("autoplay; encrypted-media; fullscreen; picture-in-picture")
    expect(iframe.getAttribute("referrerpolicy")).toBe(IFRAME_REFERRER_POLICY)
    expect(iframe.hasAttribute("allowfullscreen")).toBe(true)
    const src = new URL(iframe.getAttribute("src")!)
    expect(src.origin + src.pathname).toBe("https://www.youtube.com/embed/abc123")
    expect(src.searchParams.get("enablejsapi")).toBe("1")
    expect(src.searchParams.get("autoplay")).toBe("1")
    expect(src.searchParams.get("playsinline")).toBe("1")
    expect(src.searchParams.get("origin")).toBe("https://home.example")
    expect(src.searchParams.get("rel")).toBe("0")
    expect(src.searchParams.get("start")).toBe("65")
    expect(FakeYt.last!.target).toBe(iframe)
  })

  it("holds when told not to autoplay, and the element holds nothing but the frame", () => {
    const r = rig()
    r.player.mount(r.el)
    r.player.open({ ...OPEN, autoplay: false })
    expect(new URL(r.el.querySelector("iframe")!.getAttribute("src")!).searchParams.get("autoplay")).toBe("0")
    expect([...r.el.children].map((c) => c.tagName)).toEqual(["IFRAME"])
  })

  it("a new open is a new frame; close takes it away", () => {
    const r = rig()
    r.player.mount(r.el)
    r.player.open({ ...OPEN })
    const first = FakeYt.last!
    r.player.open({ ...OPEN, ref: "second" })
    expect(first.destroyed).toBe(true)
    expect(r.el.querySelectorAll("iframe")).toHaveLength(1)
    expect(r.el.querySelector("iframe")!.getAttribute("src")).toContain("/embed/second")
    r.player.close()
    expect(r.el.querySelector("iframe")).toBeNull()
    expect(FakeYt.last!.destroyed).toBe(true)
  })
})

describe("state and errors", () => {
  const ready = (r: ReturnType<typeof rig>) => {
    r.player.mount(r.el)
    r.player.open({ ...OPEN })
    FakeYt.last!.fire("onReady")
    return FakeYt.last!
  }

  it.each([
    [-1, "loading"],
    [0, "ended"],
    [1, "playing"],
    [2, "paused"],
    [3, "loading"],
    [5, "paused"]
  ] as const)("player state %i is %s", (code, status) => {
    const r = rig()
    const yt = ready(r)
    yt.fire("onStateChange", code)
    expect(r.currents.at(-1)?.status).toBe(status)
  })

  it("buffering in the middle of a video does not flip it back to loading", () => {
    const r = rig()
    const yt = ready(r)
    yt.fire("onStateChange", 1)
    yt.fire("onStateChange", 3)
    expect(r.currents.at(-1)?.status).toBe("playing")
  })

  it("takes the title from the video, the server's words before it can say; next and previous are not the page's", () => {
    const r = rig()
    r.player.mount(r.el)
    r.player.open({ ...OPEN })
    expect(r.currents.at(-1)).toMatchObject({ status: "loading", title: "From the server", canNext: false, canPrevious: false })
    const yt = FakeYt.last!
    yt.fire("onReady")
    yt.time = 12.5
    yt.fire("onStateChange", 1)
    expect(r.currents.at(-1)).toMatchObject({ status: "playing", title: "Sharpening a knife", durationMs: 300_000, positionMs: 12_500, volume: 1, canNext: false, ref: "abc123" })
  })

  it("polls the position every second while it plays, and not otherwise", () => {
    const r = rig()
    const yt = ready(r)
    yt.fire("onStateChange", 1)
    const n = r.currents.length
    vi.advanceTimersByTime(3_000)
    expect(r.currents.length).toBe(n + 3)
    yt.fire("onStateChange", 2)
    const m = r.currents.length
    vi.advanceTimersByTime(3_000)
    expect(r.currents.length).toBe(m)
  })

  it("autoplay blocked keeps the frame and says blocked", () => {
    const r = rig()
    const yt = ready(r)
    yt.fire("onAutoplayBlocked")
    expect(r.currents.at(-1)?.status).toBe("blocked")
    expect(r.el.querySelector("iframe")).not.toBeNull()
  })

  it.each([
    [101, "embed_refused"],
    [150, "embed_refused"],
    [100, "not_found"],
    [153, "no_referrer"],
    [2, "player_error"],
    [5, "player_error"],
    [undefined, "player_error"]
  ] as const)("error %s is %s", (code, slug) => {
    expect(errorCodeOf(code)).toBe(slug)
    const r = rig()
    const yt = ready(r)
    yt.fire("onError", code)
    expect(r.currents.at(-1)).toMatchObject({ status: "error", errorCode: slug })
  })

  it("commands map to the player, queued until it is ready; volume is 0 to 100; seek is in seconds", () => {
    const r = rig()
    r.player.mount(r.el)
    r.player.open({ ...OPEN })
    const yt = FakeYt.last!
    r.player.pause()
    expect(yt.calls).toEqual([])
    yt.fire("onReady")
    expect(yt.calls).toEqual(["pause"])
    r.player.play()
    r.player.seek(90_500)
    r.player.setVolume(0.25)
    r.player.next()
    r.player.previous()
    expect(yt.calls).toEqual(["pause", "play", "seek:90.5", "volume:25"])
  })

  it("a frame replaced meanwhile is not heard from", () => {
    const r = rig()
    const old = ready(r)
    r.player.open({ ...OPEN, ref: "other" })
    const n = r.currents.length
    old.fire("onStateChange", 1)
    expect(r.currents.length).toBe(n)
  })
})
