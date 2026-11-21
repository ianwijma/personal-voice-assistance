import type { MediaConfig } from "@pva/protocol"
import { loadScript, type ScriptLoader } from "./load.ts"
import type { OpenCommand, PagePlayer, PlayerCurrent, PlayerEvents } from "./types.ts"

/**
 * The page's Spotify player (docs/modules/media.md §3, §5): Spotify's Web Playback SDK, which turns this tab into a
 * Spotify Connect device (Premium only). Its script is loaded on `prepare` and never before, so a household without
 * the module contacts nobody. The server starts playback on the device id this reports (`playerId`) through Spotify's
 * Web API; this player only controls what plays here and shows what it is.
 *
 * The SDK types are written by hand here (no npm package): only what is used.
 */

export const SPOTIFY_SDK_URL = "https://sdk.scdn.co/spotify-player.js"
/** A cached token is used while it has more than this left. */
export const TOKEN_MIN_LEFT_MS = 60_000
/** How long the SDK's wish for a token waits for the server's `credential` before the player says `no_credential`. */
export const TOKEN_WAIT_MS = 10_000
const DEFAULT_NAME = "Voice assistant"
const DEFAULT_VOLUME = 0.8

interface SpotifyImage {
  readonly url?: string
  readonly width?: number | null
  readonly height?: number | null
}
interface SpotifyTrack {
  readonly id?: string | null
  readonly uri?: string
  readonly type?: string
  readonly name?: string
  readonly album?: { readonly name?: string; readonly images?: ReadonlyArray<SpotifyImage> }
  readonly artists?: ReadonlyArray<{ readonly name?: string }>
}
export interface SpotifyState {
  readonly paused: boolean
  readonly position: number
  readonly duration: number
  readonly loading?: boolean
  readonly disallows?: Readonly<Record<string, boolean | undefined>>
  readonly track_window: {
    readonly current_track: SpotifyTrack | null
    readonly previous_tracks?: ReadonlyArray<SpotifyTrack>
    readonly next_tracks?: ReadonlyArray<SpotifyTrack>
  }
}
export interface SpotifySdkPlayer {
  connect(): Promise<boolean>
  disconnect(): void
  addListener(event: string, callback: (payload: never) => void): boolean
  activateElement(): Promise<void>
  resume(): Promise<void>
  pause(): Promise<void>
  nextTrack(): Promise<void>
  previousTrack(): Promise<void>
  seek(positionMs: number): Promise<void>
  setVolume(volume: number): Promise<void>
  getCurrentState(): Promise<SpotifyState | null>
}
export interface SpotifyGlobal {
  Player: new (options: { name: string; getOAuthToken: (cb: (token: string) => void) => void; volume?: number }) => SpotifySdkPlayer
}
declare global {
  interface Window {
    Spotify?: SpotifyGlobal
    onSpotifyWebPlaybackSDKReady?: () => void
  }
}

export interface SpotifyDeps {
  readonly loadScript?: ScriptLoader
  readonly win?: Pick<Window, "addEventListener" | "removeEventListener"> & { Spotify?: SpotifyGlobal; onSpotifyWebPlaybackSDKReady?: (() => void) | undefined }
  readonly now?: () => number
}

const SCDN_ART = /^https:\/\/i\.scdn\.co\//
const SPOTIFY_LINK = /^https:\/\/open\.spotify\.com\//

/** The SDK's state as the page's `current`. */
export const currentOfState = (s: SpotifyState, fallbackLink: string | undefined): PlayerCurrent => {
  const track = s.track_window.current_track
  const prev = s.track_window.previous_tracks ?? []
  const next = s.track_window.next_tracks ?? []
  const images = (track?.album?.images ?? []).filter((i) => typeof i.url === "string" && SCDN_ART.test(i.url))
  // The smallest picture that is at least 200 px, else the largest there is.
  const sized = images.filter((i) => (i.height ?? 0) >= 200).sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0]
  const art = sized ?? [...images].sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
  const artists = (track?.artists ?? []).map((a) => a.name).filter((n): n is string => typeof n === "string" && n !== "")
  // Spotify leaves a finished track at position 0, paused, with that track in the history.
  const ended = s.paused && s.position === 0 && track?.id != null && prev.some((p) => p.id === track.id)
  const kind = track?.type === "episode" ? "episode" : "track"
  const id = track?.id
  const link = typeof id === "string" && /^[A-Za-z0-9]+$/.test(id) ? `https://open.spotify.com/${kind}/${id}` : fallbackLink
  return {
    status: s.loading === true ? "loading" : ended ? "ended" : s.paused ? "paused" : "playing",
    ...(track?.name !== undefined ? { title: track.name } : {}),
    ...(artists.length > 0 ? { artist: artists.join(", ") } : {}),
    ...(track?.album?.name !== undefined ? { album: track.album.name } : {}),
    ...(art?.url !== undefined ? { artUrl: art.url } : {}),
    ...(link !== undefined ? { link } : {}),
    ...(typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? { ref: id } : {}),
    durationMs: s.duration,
    positionMs: s.position,
    canNext: s.disallows?.skipping_next !== true && next.length > 0,
    canPrevious: s.disallows?.skipping_prev !== true && (prev.length > 0 || s.position > 0)
  }
}

export class SpotifyPlayer implements PagePlayer {
  readonly source = "spotify"
  readonly volumeSteps = 6
  readonly pausesWhenHidden = false
  readonly volume = DEFAULT_VOLUME

  private events: PlayerEvents | undefined
  private readonly load: ScriptLoader
  private readonly win: NonNullable<SpotifyDeps["win"]> | undefined
  private readonly now: () => number
  private sdk: SpotifySdkPlayer | undefined
  private started = false
  private ready = false
  private playerId: string | undefined
  private error: string | undefined
  private name = DEFAULT_NAME

  // Credential.
  private token: { value: string; expiresAtMs: number } | undefined
  private waiters: Array<(token: string) => void> = []
  private tokenTimer: ReturnType<typeof setTimeout> | undefined

  // What is open (the SDK's state is shown only while it is).
  private opened: OpenCommand | undefined
  private lastState: SpotifyState | undefined
  private activated = false
  private gestureOff: (() => void) | undefined

  constructor(deps: SpotifyDeps = {}) {
    this.load = deps.loadScript ?? loadScript
    this.win = deps.win ?? (typeof window === "undefined" ? undefined : window)
    this.now = deps.now ?? Date.now
  }

  attach(events: PlayerEvents): void {
    this.events = events
  }

  private report() {
    this.events?.report({ ready: this.ready, ...(this.playerId !== undefined ? { playerId: this.playerId } : {}), ...(this.error !== undefined ? { error: this.error } : {}) })
  }
  private fail(error: string) {
    this.ready = false
    this.error = error
    this.report()
  }

  prepare(config?: MediaConfig): void {
    if (this.started) return
    this.started = true
    const n = config?.name
    if (typeof n === "string" && n.trim() !== "") this.name = n.trim().slice(0, 100)
    this.report()
    this.armGesture()
    void this.load(SPOTIFY_SDK_URL)
      .then(() => this.whenGlobal())
      .then((g) => this.init(g))
      .catch(() => {
        this.started = false // a later prepare tries again
        this.fail("sdk_load_failed")
      })
  }

  /** The SDK calls `onSpotifyWebPlaybackSDKReady` when it is ready; it may already have by the time the script's `load` fires. */
  private whenGlobal(): Promise<SpotifyGlobal> {
    const w = this.win
    if (w?.Spotify?.Player !== undefined) return Promise.resolve(w.Spotify)
    return new Promise((resolve, reject) => {
      if (w === undefined) return reject(new Error("no window"))
      const previous = w.onSpotifyWebPlaybackSDKReady
      w.onSpotifyWebPlaybackSDKReady = () => {
        previous?.()
        if (w.Spotify !== undefined) resolve(w.Spotify)
        else reject(new Error("no Spotify global"))
      }
      // A script that already fired its callback before we set ours: check once more shortly.
      setTimeout(() => {
        if (w.Spotify?.Player !== undefined) resolve(w.Spotify)
      }, 0)
    })
  }

  private init(g: SpotifyGlobal) {
    if (this.sdk !== undefined) return
    const sdk = new g.Player({ name: this.name, getOAuthToken: (cb) => this.getToken(cb), volume: this.volume })
    this.sdk = sdk
    const on = <T,>(event: string, f: (p: T) => void) => sdk.addListener(event, f as (p: never) => void)
    on<{ device_id: string }>("ready", (p) => {
      this.ready = true
      this.error = undefined
      this.playerId = p.device_id
      this.report()
      this.activateNow()
    })
    on<{ device_id: string }>("not_ready", () => {
      this.ready = false
      this.error = "not_ready"
      this.report()
    })
    // No encrypted media (Widevine) in this browser, a refused token, a missing Premium, a failed track.
    on<{ message?: string }>("initialization_error", () => this.fail("initialization_error"))
    on<{ message?: string }>("authentication_error", () => this.fail("authentication_error"))
    on<{ message?: string }>("account_error", () => this.fail("account_error"))
    on<{ message?: string }>("playback_error", () => {
      if (this.opened !== undefined) this.events?.current({ ...this.shown(), status: "error", errorCode: "playback_error" })
    })
    on<unknown>("autoplay_failed", () => {
      // The browser would not start sound without a gesture: the panel stays up and a touch starts it.
      this.activated = false
      this.armGesture()
      if (this.opened !== undefined) this.events?.current({ ...this.shown(), status: "blocked" })
    })
    on<SpotifyState | null>("player_state_changed", (s) => {
      if (s === null) return
      this.lastState = s
      if (this.opened !== undefined) this.events?.current(this.shown())
    })
    void sdk.connect().then((ok) => {
      if (!ok) this.fail("initialization_error")
    }, () => this.fail("initialization_error"))
  }

  /** What to show now: the SDK's state, or the title the server gave until the SDK has one. */
  private shown(): PlayerCurrent {
    if (this.lastState !== undefined && this.lastState.track_window.current_track !== null) return currentOfState(this.lastState, this.opened?.link)
    const o = this.opened
    return {
      status: "loading",
      ...(o?.title !== undefined ? { title: o.title } : {}),
      ...(o?.subtitle !== undefined ? { artist: o.subtitle } : {}),
      ...(o?.artUrl !== undefined ? { artUrl: o.artUrl } : {}),
      ...(o?.link !== undefined && SPOTIFY_LINK.test(o.link) ? { link: o.link } : {}),
      canNext: false,
      canPrevious: false
    }
  }

  private getToken(cb: (token: string) => void) {
    const t = this.token
    if (t !== undefined && t.expiresAtMs - this.now() > TOKEN_MIN_LEFT_MS) return cb(t.value)
    this.waiters.push(cb)
    this.events?.needsCredential()
    if (this.tokenTimer === undefined) {
      this.tokenTimer = setTimeout(() => {
        this.tokenTimer = undefined
        // The waiters stay: a token that arrives later still gets the SDK going.
        if (this.waiters.length > 0) this.fail("no_credential")
      }, TOKEN_WAIT_MS)
    }
  }

  credential(token: string, expiresAtMs: number): void {
    this.token = { value: token, expiresAtMs }
    if (this.tokenTimer !== undefined) clearTimeout(this.tokenTimer)
    this.tokenTimer = undefined
    const waiting = this.waiters
    this.waiters = []
    for (const cb of waiting) cb(token)
    if (this.error === "no_credential") {
      this.error = undefined
      this.report()
    }
  }

  // -- The gesture ---------------------------------------------------------------------------------------------------

  /** The Start press: unlocks sound now if the SDK is up; otherwise the first touch after it loads does. */
  activate(): void {
    this.activateNow()
  }

  private activateNow() {
    const sdk = this.sdk
    if (sdk === undefined || this.activated) return
    // Needs a user gesture (sticky activation where the browser keeps it); a refusal leaves the listeners armed.
    const active = typeof navigator !== "undefined" ? (navigator as { userActivation?: { hasBeenActive?: boolean } }).userActivation?.hasBeenActive : undefined
    if (active === false) return
    this.activated = true
    void sdk.activateElement().catch(() => {
      this.activated = false
    })
  }

  /** The first pointerdown or keydown after the SDK exists calls `activateElement()` inside that gesture. */
  private armGesture() {
    const w = this.win
    if (w === undefined || this.gestureOff !== undefined) return
    const onGesture = () => {
      const sdk = this.sdk
      if (sdk === undefined) return // not loaded yet: the next gesture counts
      if (this.activated) return this.disarmGesture()
      this.activated = true
      this.disarmGesture()
      void sdk.activateElement().catch(() => {
        this.activated = false
        this.armGesture()
      })
    }
    w.addEventListener("pointerdown", onGesture, true)
    w.addEventListener("keydown", onGesture, true)
    this.gestureOff = () => {
      w.removeEventListener("pointerdown", onGesture, true)
      w.removeEventListener("keydown", onGesture, true)
    }
  }
  private disarmGesture() {
    this.gestureOff?.()
    this.gestureOff = undefined
  }

  // -- Commands ------------------------------------------------------------------------------------------------------

  open(command: OpenCommand): void {
    this.opened = command
    this.lastState = undefined
    // Without a `ref` the panel shows what the server said until the SDK reports; the server starts the playback.
    this.events?.current(this.shown())
    // If something already plays here, the SDK will not say so again: ask.
    void this.sdk?.getCurrentState().then((s) => {
      if (s === null || this.opened === undefined) return
      this.lastState = s
      this.events?.current(this.shown())
    }, () => undefined)
  }

  private guard(p: Promise<void> | undefined) {
    void p?.catch(() => {
      if (this.opened !== undefined) this.events?.current({ ...this.shown(), status: "error", errorCode: "playback_error" })
    })
  }
  play(): void {
    this.guard(this.sdk?.resume())
  }
  pause(): void {
    this.guard(this.sdk?.pause())
  }
  next(): void {
    this.guard(this.sdk?.nextTrack())
  }
  previous(): void {
    this.guard(this.sdk?.previousTrack())
  }
  seek(toMs: number): void {
    this.guard(this.sdk?.seek(Math.max(0, Math.round(toMs))))
  }
  setVolume(level: number): void {
    const v = Math.min(1, Math.max(0, level))
    void this.sdk?.setVolume(v).catch(() => undefined)
  }
  /** Pause and hide; the SDK stays connected, so the next play is quick. */
  close(): void {
    this.opened = undefined
    this.lastState = undefined
    void this.sdk?.pause().catch(() => undefined)
  }
}
