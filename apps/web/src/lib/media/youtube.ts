import type { MediaConfig } from "@pva/protocol"
import { loadScript, type ScriptLoader } from "./load.ts"
import type { OpenCommand, PlayerCurrent, PlayerEvents, SurfacePlayer } from "./types.ts"

/**
 * The page's YouTube player (docs/modules/media.md §3, §5): YouTube's IFrame Player API, the only allowed way to play
 * YouTube in our page. Its script is loaded on `prepare` or the first `open`, never before.
 *
 * YouTube Developer Policies, kept here: nothing is drawn over the frame and its own controls are never hidden (the
 * theatre puts ours outside its rectangle); nothing plays audio-only or in the background (a hidden tab pauses it,
 * `pausesWhenHidden`); ads are untouched. The frame is made here with the attributes it needs from the first request
 * (`allow`, `referrerpolicy`: YouTube refuses an embed without a Referer, error 153), then handed to the API.
 *
 * `next` and `previous` are not this page's: the module opens another video (`canNext: false`).
 */

export const YOUTUBE_API_URL = "https://www.youtube.com/iframe_api"
export const IFRAME_ALLOW = "autoplay; encrypted-media; fullscreen; picture-in-picture"
export const IFRAME_REFERRER_POLICY = "strict-origin-when-cross-origin"
const POSITION_POLL_MS = 1_000
const DEFAULT_VOLUME = 1

interface YtVideoData {
  readonly title?: string
  readonly video_id?: string
}
export interface YtPlayer {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(volume: number): void
  getVolume(): number
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  getVideoData?(): YtVideoData
  destroy(): void
  addEventListener?(event: string, listener: (e: { data?: number }) => void): void
}
export interface YtGlobal {
  Player: new (target: HTMLElement | string, options: { events?: Record<string, (e: { data?: number; target?: YtPlayer }) => void> }) => YtPlayer
}
declare global {
  interface Window {
    YT?: YtGlobal
    onYouTubeIframeAPIReady?: () => void
  }
}

export interface YoutubeDeps {
  readonly loadScript?: ScriptLoader
  readonly win?: { YT?: YtGlobal; onYouTubeIframeAPIReady?: (() => void) | undefined; location?: { origin: string } }
  readonly doc?: Pick<Document, "createElement">
}

/** An error code of the IFrame API as the slug the page reports. */
export const errorCodeOf = (data: number | undefined): string => {
  switch (data) {
    case 101:
    case 150:
      return "embed_refused"
    case 100:
      return "not_found"
    case 153:
      return "no_referrer"
    default:
      return "player_error"
  }
}

const STATUS_OF: Readonly<Record<number, PlayerCurrent["status"]>> = { [-1]: "loading", 0: "ended", 1: "playing", 2: "paused", 3: "loading", 5: "paused" }

export class YoutubePlayer implements SurfacePlayer {
  readonly source = "youtube"
  readonly volumeSteps = 3
  readonly pausesWhenHidden = true
  readonly volume = DEFAULT_VOLUME

  private events: PlayerEvents | undefined
  private readonly load: ScriptLoader
  private readonly win: NonNullable<YoutubeDeps["win"]> | undefined
  private readonly doc: Pick<Document, "createElement"> | undefined
  private started = false
  private apiReady = false
  private container: HTMLElement | undefined
  private opened: OpenCommand | undefined
  private iframe: HTMLIFrameElement | undefined
  private yt: YtPlayer | undefined
  private ytReady = false
  private queued: Array<(p: YtPlayer) => void> = []
  private status: PlayerCurrent["status"] = "loading"
  private errorCode: string | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private generation = 0

  constructor(deps: YoutubeDeps = {}) {
    this.load = deps.loadScript ?? loadScript
    this.win = deps.win ?? (typeof window === "undefined" ? undefined : window)
    this.doc = deps.doc ?? (typeof document === "undefined" ? undefined : document)
  }

  attach(events: PlayerEvents): void {
    this.events = events
  }

  prepare(_config?: MediaConfig): void {
    this.ensureApi()
  }

  private ensureApi() {
    if (this.apiReady) return
    const w = this.win
    if (w?.YT?.Player !== undefined) {
      this.apiReady = true
      this.events?.report({ ready: true })
      return
    }
    if (this.started) return
    this.started = true
    this.events?.report({ ready: false })
    const done = () => {
      this.apiReady = true
      this.events?.report({ ready: true })
      this.build()
    }
    if (w !== undefined) {
      const previous = w.onYouTubeIframeAPIReady
      w.onYouTubeIframeAPIReady = () => {
        previous?.()
        done()
      }
    }
    void this.load(YOUTUBE_API_URL).then(() => {
      // The API may have called its ready callback before `load` fired, or after; both end in `done` once.
      if (!this.apiReady && w?.YT?.Player !== undefined) done()
    }, () => {
      this.started = false
      this.events?.report({ ready: false, error: "api_load_failed" })
    })
  }

  // -- The frame -----------------------------------------------------------------------------------------------------

  /** The theatre gives the element the frame goes in (it never has children of its own). */
  mount(element: HTMLElement): void {
    this.container = element
    this.build()
  }
  unmount(): void {
    if (this.iframe !== undefined) this.teardown()
    this.container = undefined
  }

  /** The frame needs the API, an element to live in and something to open. */
  private build() {
    const w = this.win
    const o = this.opened
    const container = this.container
    const doc = this.doc
    if (o === undefined || o.ref === undefined || container === undefined || doc === undefined || w?.YT?.Player === undefined) return
    if (this.iframe !== undefined && this.iframe.parentElement === container) return
    this.teardown()
    const gen = ++this.generation
    const params = new URLSearchParams({ autoplay: o.autoplay ? "1" : "0", playsinline: "1", enablejsapi: "1", rel: "0" })
    if (w.location?.origin !== undefined) params.set("origin", w.location.origin)
    if (o.startAtMs !== undefined && o.startAtMs > 0) params.set("start", String(Math.floor(o.startAtMs / 1000)))
    const iframe = doc.createElement("iframe")
    // Set before the frame is in the page, so the very first request carries the Referer and the permissions.
    iframe.setAttribute("allow", IFRAME_ALLOW)
    iframe.setAttribute("referrerpolicy", IFRAME_REFERRER_POLICY)
    iframe.setAttribute("allowfullscreen", "")
    iframe.setAttribute("title", o.title ?? "YouTube video player")
    iframe.setAttribute("frameborder", "0")
    iframe.style.width = "100%"
    iframe.style.height = "100%"
    iframe.style.border = "0"
    iframe.setAttribute("src", `https://www.youtube.com/embed/${encodeURIComponent(o.ref)}?${params.toString()}`)
    container.appendChild(iframe)
    this.iframe = iframe
    this.ytReady = false
    this.status = "loading"
    this.errorCode = undefined
    const alive = () => gen === this.generation
    this.yt = new w.YT.Player(iframe, {
      events: {
        onReady: () => {
          if (!alive()) return
          this.ytReady = true
          const q = this.queued
          this.queued = []
          for (const f of q) if (this.yt !== undefined) f(this.yt)
          this.emit()
        },
        onStateChange: (e) => {
          if (!alive()) return
          const mapped = e.data === undefined ? undefined : STATUS_OF[e.data]
          if (mapped === undefined) return
          // Buffering in the middle of a video is not "loading" again.
          this.status = e.data === 3 && (this.status === "playing" || this.status === "paused") ? this.status : mapped
          if (this.status !== "error") this.errorCode = undefined
          this.managePoll()
          this.emit()
        },
        // The browser would not start sound: the frame stays up with its own play button.
        onAutoplayBlocked: () => {
          if (!alive()) return
          this.status = "blocked"
          this.emit()
        },
        onError: (e) => {
          if (!alive()) return
          this.status = "error"
          this.errorCode = errorCodeOf(e.data)
          this.managePoll()
          this.emit()
        }
      }
    })
    this.emit()
  }

  private teardown() {
    this.generation++
    if (this.poll !== undefined) clearInterval(this.poll)
    this.poll = undefined
    try {
      this.yt?.destroy()
    } catch {
      // The frame may already be gone.
    }
    this.yt = undefined
    this.ytReady = false
    this.queued = []
    this.iframe?.remove()
    this.iframe = undefined
  }

  private managePoll() {
    if (this.status === "playing" && this.poll === undefined) this.poll = setInterval(() => this.emit(), POSITION_POLL_MS)
    else if (this.status !== "playing" && this.poll !== undefined) {
      clearInterval(this.poll)
      this.poll = undefined
    }
  }

  /** What is open, from the player where it can say and from the server's words where it cannot yet. */
  private emit() {
    const o = this.opened
    if (o === undefined) return
    const yt = this.yt
    const ready = this.ytReady && yt !== undefined
    let title = o.title
    let durationMs: number | undefined
    let positionMs: number | undefined
    let volume: number | undefined
    if (ready) {
      try {
        const t = yt.getVideoData?.().title
        if (typeof t === "string" && t.trim() !== "") title = t
        const d = yt.getDuration()
        if (Number.isFinite(d) && d > 0) durationMs = Math.round(d * 1000)
        const p = yt.getCurrentTime()
        if (Number.isFinite(p) && p >= 0) positionMs = Math.round(p * 1000)
        const v = yt.getVolume()
        if (Number.isFinite(v)) volume = Math.min(1, Math.max(0, v / 100))
      } catch {
        // A frame mid-teardown: report what the server said.
      }
    }
    this.events?.current({
      status: this.status,
      ...(title !== undefined ? { title } : {}),
      ...(o.subtitle !== undefined ? { artist: o.subtitle } : {}),
      ...(o.artUrl !== undefined ? { artUrl: o.artUrl } : {}),
      ...(o.link !== undefined ? { link: o.link } : {}),
      ...(o.ref !== undefined ? { ref: o.ref } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(positionMs !== undefined ? { positionMs } : {}),
      ...(volume !== undefined ? { volume } : {}),
      canNext: false,
      canPrevious: false,
      ...(this.errorCode !== undefined ? { errorCode: this.errorCode } : {})
    })
  }

  // -- Commands ------------------------------------------------------------------------------------------------------

  open(command: OpenCommand): void {
    this.opened = command
    this.status = "loading"
    this.errorCode = undefined
    this.teardown() // a new video is a new frame
    this.ensureApi()
    this.emit()
    this.build()
  }

  private withPlayer(f: (p: YtPlayer) => void) {
    if (this.yt !== undefined && this.ytReady) {
      try {
        f(this.yt)
      } catch {
        // The frame is gone or not ready: the next state report says so.
      }
    } else if (this.yt !== undefined) this.queued.push(f)
  }

  play(): void {
    this.withPlayer((p) => p.playVideo())
  }
  pause(): void {
    this.withPlayer((p) => p.pauseVideo())
  }
  /** Not this page's: the module opens the next result. */
  next(): void {}
  previous(): void {}
  seek(toMs: number): void {
    this.withPlayer((p) => {
      p.seekTo(Math.max(0, toMs) / 1000, true)
      this.emit()
    })
  }
  setVolume(level: number): void {
    this.withPlayer((p) => p.setVolume(Math.round(Math.min(1, Math.max(0, level)) * 100)))
  }
  /** Stop and take the frame away: YouTube plays nothing in the background. */
  close(): void {
    try {
      this.yt?.pauseVideo()
    } catch {
      // Already gone.
    }
    this.opened = undefined
    this.teardown()
  }
  /** YouTube takes no token. */
  credential(): void {}
}
