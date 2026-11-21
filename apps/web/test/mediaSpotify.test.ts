import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { currentOfState, SPOTIFY_SDK_URL, SpotifyPlayer, type SpotifyGlobal, type SpotifySdkPlayer, type SpotifyState, TOKEN_WAIT_MS } from "@/lib/media/spotify.ts"
import type { PlayerCurrent, PlayerReport } from "@/lib/media/types.ts"

class FakeSdk implements SpotifySdkPlayer {
  static last: FakeSdk | undefined
  listeners = new Map<string, (p: never) => void>()
  calls: Array<string> = []
  state: SpotifyState | null = null
  readonly options: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }
  constructor(options: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) {
    this.options = options
    FakeSdk.last = this
  }
  async connect() {
    this.calls.push("connect")
    this.options.getOAuthToken(() => this.calls.push("token-given"))
    return true
  }
  disconnect() {}
  addListener(event: string, cb: (p: never) => void) {
    this.listeners.set(event, cb)
    return true
  }
  async activateElement() {
    this.calls.push("activate")
  }
  async resume() {
    this.calls.push("resume")
  }
  async pause() {
    this.calls.push("pause")
  }
  async nextTrack() {
    this.calls.push("next")
  }
  async previousTrack() {
    this.calls.push("previous")
  }
  async seek(ms: number) {
    this.calls.push(`seek:${ms}`)
  }
  async setVolume(v: number) {
    this.calls.push(`volume:${v}`)
  }
  async getCurrentState() {
    return this.state
  }
  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.(payload as never)
  }
}

const track = (over: object = {}) => ({
  id: "4uLU6hMCjMI75M1A2tKUQC",
  uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC",
  type: "track",
  name: "So What",
  album: { name: "Kind of Blue", images: [{ url: "https://i.scdn.co/image/small", height: 64 }, { url: "https://i.scdn.co/image/mid", height: 300 }, { url: "https://evil.example/x.png", height: 640 }] },
  artists: [{ name: "Miles Davis" }, { name: "John Coltrane" }],
  ...over
})
const state = (over: Partial<SpotifyState> = {}): SpotifyState => ({
  paused: false,
  position: 12_000,
  duration: 540_000,
  track_window: { current_track: track(), previous_tracks: [], next_tracks: [track({ id: "n1" })] },
  ...over
})

const rig = () => {
  const win = new EventTarget() as unknown as NonNullable<ConstructorParameters<typeof SpotifyPlayer>[0]>["win"] & { Spotify?: SpotifyGlobal }
  win!.Spotify = { Player: FakeSdk }
  const loaded: Array<string> = []
  let now = 1_000_000
  const player = new SpotifyPlayer({ win, loadScript: async (src) => void loaded.push(src), now: () => now })
  const reports: Array<PlayerReport> = []
  const currents: Array<PlayerCurrent> = []
  let wants = 0
  player.attach({ report: (r) => reports.push(r), current: (c) => currents.push(c), needsCredential: () => void wants++ })
  return { player, win: win as unknown as EventTarget, loaded, reports, currents, wants: () => wants, advance: (ms: number) => void (now += ms), at: (n: number) => void (now = n) }
}
const flush = () => vi.advanceTimersByTimeAsync(5)

beforeEach(() => {
  vi.useFakeTimers()
  FakeSdk.last = undefined
})
afterEach(() => vi.useRealTimers())

describe("loading and connecting", () => {
  it("loads nothing until prepare, then the SDK script once, and builds the player with the given name", async () => {
    const r = rig()
    expect(r.loaded).toEqual([])
    r.player.prepare({ name: "Kitchen" })
    r.player.prepare({ name: "Again" })
    await flush()
    expect(r.loaded).toEqual([SPOTIFY_SDK_URL])
    expect(FakeSdk.last?.options.name).toBe("Kitchen")
    expect(FakeSdk.last?.options.volume).toBe(0.8)
    expect(FakeSdk.last?.calls).toContain("connect")
  })

  it("defaults the name, and reports ready with the Connect device id", async () => {
    const r = rig()
    r.player.prepare()
    await flush()
    expect(FakeSdk.last?.options.name).toBe("Voice assistant")
    FakeSdk.last!.emit("ready", { device_id: "dev123" })
    expect(r.reports.at(-1)).toEqual({ ready: true, playerId: "dev123" })
    FakeSdk.last!.emit("not_ready", { device_id: "dev123" })
    expect(r.reports.at(-1)).toMatchObject({ ready: false, error: "not_ready" })
  })

  it.each(["initialization_error", "authentication_error", "account_error"])("%s is reported as an error slug", async (event) => {
    const r = rig()
    r.player.prepare()
    await flush()
    FakeSdk.last!.emit(event, { message: "x" })
    expect(r.reports.at(-1)).toEqual({ ready: false, error: event })
  })

  it("a script that cannot load is an error, and a later prepare tries again", async () => {
    const win = new EventTarget() as never
    let fail = true
    const player = new SpotifyPlayer({ win, loadScript: async () => void (fail && (() => { throw new Error("blocked") })()) })
    const reports: Array<PlayerReport> = []
    player.attach({ report: (r) => reports.push(r), current: () => {}, needsCredential: () => {} })
    player.prepare()
    await flush()
    expect(reports.at(-1)).toEqual({ ready: false, error: "sdk_load_failed" })
    fail = false
    player.prepare()
    expect(reports.length).toBeGreaterThan(1)
  })
})

describe("the token", () => {
  it("uses a cached token with more than a minute left; otherwise asks, and answers when it arrives", async () => {
    const r = rig()
    r.player.prepare()
    await flush()
    // connect() asked once already: nothing cached.
    expect(r.wants()).toBe(1)
    expect(FakeSdk.last!.calls).not.toContain("token-given")
    r.player.credential("tok1", r.advance(0) ?? 1_000_000 + 3_600_000)
    expect(FakeSdk.last!.calls).toContain("token-given")
    FakeSdk.last!.calls.length = 0
    let got = ""
    FakeSdk.last!.options.getOAuthToken((t) => (got = t))
    expect(got).toBe("tok1")
    expect(r.wants()).toBe(1)
    r.advance(3_600_000 - 59_000) // under a minute left
    FakeSdk.last!.options.getOAuthToken((t) => (got = `again:${t}`))
    expect(got).toBe("tok1")
    expect(r.wants()).toBe(2)
    r.player.credential("tok2", 1_000_000 + 7_200_000)
    expect(got).toBe("again:tok2")
  })

  it("no credential after ten seconds is reported, and a late one still gets going", async () => {
    const r = rig()
    r.player.prepare()
    await flush()
    await vi.advanceTimersByTimeAsync(TOKEN_WAIT_MS)
    expect(r.reports.at(-1)).toMatchObject({ ready: false, error: "no_credential" })
    r.player.credential("late", 1_000_000 + 3_600_000)
    expect(FakeSdk.last!.calls).toContain("token-given")
    expect(r.reports.at(-1)?.error).toBeUndefined()
  })
})

describe("the gesture", () => {
  it("activateElement runs on the Start press when the SDK is up", async () => {
    const r = rig()
    r.player.prepare()
    await flush()
    r.player.activate()
    expect(FakeSdk.last!.calls.filter((c) => c === "activate")).toHaveLength(1)
    r.player.activate()
    expect(FakeSdk.last!.calls.filter((c) => c === "activate")).toHaveLength(1)
  })

  it("otherwise on the first pointerdown or keydown after it loads, once", async () => {
    const r = rig()
    // A touch before the SDK exists does nothing (nothing to activate yet).
    let resolve!: () => void
    const win = r.win as unknown as { Spotify?: SpotifyGlobal }
    const held = new SpotifyPlayer({ win: win as never, loadScript: () => new Promise<void>((res) => (resolve = res)) })
    held.attach({ report: () => {}, current: () => {}, needsCredential: () => {} })
    held.prepare()
    r.win.dispatchEvent(new Event("pointerdown"))
    expect(FakeSdk.last).toBeUndefined()
    resolve()
    await flush()
    expect(FakeSdk.last!.calls).not.toContain("activate")
    r.win.dispatchEvent(new Event("keydown"))
    expect(FakeSdk.last!.calls.filter((c) => c === "activate")).toHaveLength(1)
    r.win.dispatchEvent(new Event("pointerdown"))
    expect(FakeSdk.last!.calls.filter((c) => c === "activate")).toHaveLength(1)
  })

  it("autoplay_failed shows the panel as blocked and arms the gesture again", async () => {
    const r = rig()
    r.player.prepare()
    await flush()
    r.player.open({ source: "spotify", title: "X", autoplay: true })
    FakeSdk.last!.emit("autoplay_failed", {})
    expect(r.currents.at(-1)?.status).toBe("blocked")
  })
})

describe("what is open", () => {
  it("open without a ref shows the given title in loading until the SDK reports", async () => {
    const r = rig()
    r.player.prepare()
    await flush()
    r.player.open({ source: "spotify", title: "Kind of Blue", subtitle: "Miles Davis", link: "https://open.spotify.com/album/abc", autoplay: true })
    expect(r.currents.at(-1)).toMatchObject({ status: "loading", title: "Kind of Blue", artist: "Miles Davis", link: "https://open.spotify.com/album/abc" })
    FakeSdk.last!.emit("player_state_changed", state())
    expect(r.currents.at(-1)).toMatchObject({ status: "playing", title: "So What" })
  })

  it("maps the SDK state: title, artists, album, art from i.scdn.co, link, times, next and previous", () => {
    const c = currentOfState(state(), undefined)
    expect(c).toEqual({
      status: "playing",
      title: "So What",
      artist: "Miles Davis, John Coltrane",
      album: "Kind of Blue",
      artUrl: "https://i.scdn.co/image/mid",
      link: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      ref: "4uLU6hMCjMI75M1A2tKUQC",
      durationMs: 540_000,
      positionMs: 12_000,
      canNext: true,
      canPrevious: true
    })
    expect(currentOfState(state({ paused: true }), undefined).status).toBe("paused")
    expect(currentOfState(state({ loading: true }), undefined).status).toBe("loading")
    const none = currentOfState(state({ position: 0, track_window: { current_track: track(), previous_tracks: [], next_tracks: [] } }), undefined)
    expect(none).toMatchObject({ canNext: false, canPrevious: false })
    expect(currentOfState(state({ disallows: { skipping_next: true } }), undefined).canNext).toBe(false)
    expect(currentOfState(state({ paused: true, position: 0, track_window: { current_track: track(), previous_tracks: [track()], next_tracks: [] } }), undefined).status).toBe("ended")
  })

  it("never takes art from another host", () => {
    const c = currentOfState(state({ track_window: { current_track: track({ album: { name: "A", images: [{ url: "https://evil.example/x.png", height: 640 }] } }) } }), undefined)
    expect(c.artUrl).toBeUndefined()
  })

  it("commands map to the SDK; close pauses and keeps the connection; playback_error is an error", async () => {
    const r = rig()
    r.player.prepare()
    await flush()
    const sdk = FakeSdk.last!
    r.player.open({ source: "spotify", title: "X", autoplay: true })
    sdk.calls.length = 0
    r.player.play()
    r.player.pause()
    r.player.next()
    r.player.previous()
    r.player.seek(61_234.4)
    r.player.setVolume(1.5)
    r.player.close()
    expect(sdk.calls).toEqual(["resume", "pause", "next", "previous", "seek:61234", "volume:1", "pause"])
    r.player.open({ source: "spotify", title: "Y", autoplay: true })
    sdk.emit("playback_error", { message: "x" })
    expect(r.currents.at(-1)).toMatchObject({ status: "error", errorCode: "playback_error" })
    // After close, SDK states are not shown.
    r.player.close()
    const n = r.currents.length
    sdk.emit("player_state_changed", state())
    expect(r.currents.length).toBe(n)
  })
})
