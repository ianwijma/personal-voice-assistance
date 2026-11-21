import type { MediaCommand, MediaStateMessage } from "@pva/protocol"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HEARTBEAT_MS, MediaController, RAMP_MS, REPORT_MIN_MS, RESTORE_MS } from "@/lib/media/controller.ts"
import { isTalking } from "@/lib/media/index.ts"
import { initialState } from "@/lib/state.ts"
import { FakePlayer } from "./mediaFakes.ts"

const talk = (mode: "lower" | "pause" | "none", level = 0.2) => ({ mode, level })
const open = (source: string, extra: Partial<Extract<MediaCommand, { type: "open" }>> = {}): MediaCommand => ({ type: "open", source, autoplay: true, talk: talk("lower"), ...extra })

interface Rig {
  readonly c: MediaController
  readonly music: FakePlayer
  readonly video: FakePlayer
  readonly sent: Array<MediaStateMessage>
  readonly doc: { visibilityState: string; addEventListener: (t: string, f: () => void) => void; removeEventListener: () => void; fire: () => void }
  connected: boolean
}

const rig = (): Rig => {
  const music = new FakePlayer("spotify", { volume: 0.8, volumeSteps: 6 })
  const video = new FakePlayer("youtube", { volume: 1, volumeSteps: 3, pausesWhenHidden: true })
  const sent: Array<MediaStateMessage> = []
  let listener: (() => void) | undefined
  const doc = {
    visibilityState: "visible",
    addEventListener: (_t: string, f: () => void) => {
      listener = f
    },
    removeEventListener: () => {},
    fire: () => listener?.()
  }
  const r = { music, video, sent, doc, connected: true } as Rig
  const c = new MediaController({ players: [music, video], send: (m) => (r.connected ? (sent.push(m), true) : false), doc: doc as never })
  return Object.assign(r, { c })
}

beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }))
afterEach(() => vi.useRealTimers())

const last = (r: Rig) => r.sent[r.sent.length - 1]!

describe("commands and the acknowledgement", () => {
  it("acks the highest seq handled, also for a command that does nothing, and reports every player", () => {
    const r = rig()
    r.c.handleCommand(1, { type: "prepare", sources: [{ source: "spotify", config: { name: "Kitchen" } }] })
    expect(r.music.calls).toEqual(["prepare:Kitchen"])
    expect(last(r).ack).toBe(1)
    vi.advanceTimersByTime(REPORT_MIN_MS)
    r.c.handleCommand(2, { type: "pause" }) // nothing is open
    expect(last(r).ack).toBe(2)
    expect(last(r).state.players.map((p) => p.source)).toEqual(["spotify", "youtube"])
    vi.advanceTimersByTime(REPORT_MIN_MS)
    r.c.handleCommand(5, { type: "play" })
    r.c.handleCommand(3, { type: "play" }) // out of order: the highest stays
    vi.advanceTimersByTime(REPORT_MIN_MS)
    expect(last(r).ack).toBe(5)
  })

  it("a source it has no player for is reported unsupported and the command is still acked", () => {
    const r = rig()
    r.c.handleCommand(1, open("radio"))
    expect(last(r).ack).toBe(1)
    expect(last(r).state.players).toContainEqual({ source: "radio", ready: false, error: "unsupported" })
    expect(last(r).state.current).toBeUndefined()
  })

  it("a player that throws still gets its command acked", () => {
    const r = rig()
    r.music.prepare = () => {
      throw new Error("boom")
    }
    r.c.handleCommand(1, { type: "prepare", sources: [{ source: "spotify" }] })
    expect(last(r).ack).toBe(1)
  })

  it("routes transport commands to the open player and relative seeks use the position now", () => {
    const r = rig()
    r.c.handleCommand(1, open("spotify", { title: "Song" }))
    r.music.say({ status: "playing", positionMs: 10_000, durationMs: 200_000 })
    vi.advanceTimersByTime(2_000)
    r.c.handleCommand(2, { type: "seek", byMs: 30_000 })
    r.c.handleCommand(3, { type: "seek", toMs: 5_000 })
    r.c.handleCommand(4, { type: "next" })
    r.c.handleCommand(5, { type: "previous" })
    r.c.handleCommand(6, { type: "pause" })
    r.c.handleCommand(7, { type: "play" })
    expect(r.music.calls.slice(1)).toEqual(["seek:42000", "seek:5000", "next", "previous", "pause", "play"])
    expect(r.video.calls).toEqual(["close"])
  })
})

describe("one current thing", () => {
  it("opening one source closes the other, and what the closed player says later is ignored", () => {
    const r = rig()
    r.c.handleCommand(1, open("spotify", { title: "Song", subtitle: "Band" }))
    r.music.say({ status: "playing", title: "Song" })
    expect(r.c.getView().current?.source).toBe("spotify")
    r.c.handleCommand(2, open("youtube", { ref: "abc", title: "Clip" }))
    expect(r.music.calls).toContain("close")
    expect(r.c.getView().current).toMatchObject({ source: "youtube", status: "loading", title: "Clip", ref: "abc" })
    r.music.say({ status: "playing", title: "late Spotify" })
    expect(r.c.getView().current?.title).toBe("Clip")
    vi.advanceTimersByTime(REPORT_MIN_MS)
    r.c.handleCommand(3, { type: "close" })
    vi.advanceTimersByTime(REPORT_MIN_MS)
    expect(last(r).state.current).toBeUndefined()
    expect(r.c.getView().current).toBeUndefined()
  })

  it("an open shows the given title in loading at once, with no ref", () => {
    const r = rig()
    r.c.handleCommand(1, open("spotify", { title: "Kind of Blue", subtitle: "Miles Davis" }))
    expect(last(r).state.current).toMatchObject({ source: "spotify", status: "loading", title: "Kind of Blue", artist: "Miles Davis" })
    expect(r.music.opened?.ref).toBeUndefined()
  })
})

describe("reporting", () => {
  it("coalesces changes (the latest wins), and a position alone is not a change", () => {
    const r = rig()
    r.c.handleCommand(1, open("spotify", { title: "A" }))
    expect(r.sent).toHaveLength(1)
    for (let i = 0; i < 6; i++) r.music.say({ status: "playing", title: `T${i}`, positionMs: i * 1000 })
    expect(r.sent).toHaveLength(1) // inside the window
    vi.advanceTimersByTime(REPORT_MIN_MS)
    expect(r.sent).toHaveLength(2)
    expect(last(r).state.current?.title).toBe("T5")
    r.music.say({ status: "playing", title: "T5", positionMs: 9_000 })
    vi.advanceTimersByTime(REPORT_MIN_MS * 4)
    expect(r.sent).toHaveLength(2)
  })

  it("repeats every five seconds while playing, with the position of that moment, and stops when paused", () => {
    const r = rig()
    r.c.handleCommand(1, open("spotify"))
    r.music.say({ status: "playing", title: "A", positionMs: 1_000 })
    vi.advanceTimersByTime(REPORT_MIN_MS)
    const before = r.sent.length
    vi.advanceTimersByTime(HEARTBEAT_MS)
    expect(r.sent.length).toBe(before + 1)
    expect(last(r).state.current?.positionMs).toBeGreaterThanOrEqual(5_000)
    r.music.say({ status: "paused", title: "A", positionMs: 7_000 })
    vi.advanceTimersByTime(REPORT_MIN_MS)
    const paused = r.sent.length
    vi.advanceTimersByTime(HEARTBEAT_MS * 3)
    expect(r.sent.length).toBe(paused)
  })

  it("cleans what a player says: texts cut, addresses https only", () => {
    const r = rig()
    r.c.handleCommand(1, open("spotify"))
    r.music.say({ status: "playing", title: "x".repeat(500), artUrl: "http://evil.example/a.png", link: "https://open.spotify.com/track/1", durationMs: Number.NaN })
    vi.advanceTimersByTime(REPORT_MIN_MS)
    const cur = last(r).state.current!
    expect(cur.title).toHaveLength(200)
    expect(cur.artUrl).toBeUndefined()
    expect(cur.link).toBe("https://open.spotify.com/track/1")
    expect(cur.durationMs).toBeUndefined()
  })

  it("a reconnect sends the whole state again and the numbering starts over", () => {
    const r = rig()
    r.c.handleCommand(1, open("spotify", { title: "A" }))
    r.c.handleCommand(2, { type: "play" })
    vi.advanceTimersByTime(REPORT_MIN_MS)
    expect(last(r).ack).toBe(2)
    r.connected = false
    vi.advanceTimersByTime(REPORT_MIN_MS)
    r.music.say({ status: "playing", title: "A" })
    vi.advanceTimersByTime(REPORT_MIN_MS)
    const n = r.sent.length
    r.connected = true
    r.c.resync()
    expect(r.sent.length).toBe(n + 1)
    expect(last(r).ack).toBeUndefined()
    expect(last(r).state.current).toMatchObject({ source: "spotify", title: "A", status: "playing" })
    vi.advanceTimersByTime(REPORT_MIN_MS)
    r.c.handleCommand(1, { type: "pause" }) // the new connection's first command
    vi.advanceTimersByTime(REPORT_MIN_MS)
    expect(last(r).ack).toBe(1)
  })

  it("starts with nothing open (a reload restores nothing)", () => {
    const r = rig()
    r.c.resync()
    expect(last(r).state.current).toBeUndefined()
    expect(last(r).state.players.every((p) => !p.ready)).toBe(true)
  })
})

describe("credentials", () => {
  it("a player's wish is sent as wants until the credential arrives, and the token goes to the player only", () => {
    const r = rig()
    r.music.events.needsCredential()
    expect(last(r).wants).toEqual([{ source: "spotify", what: "credential" }])
    vi.advanceTimersByTime(REPORT_MIN_MS)
    r.c.handleCommand(1, { type: "credential", source: "spotify", token: "tok-secret", expiresAtMs: 5 })
    expect(r.music.calls).toContain("credential:tok-secret:5")
    expect(last(r).wants).toBeUndefined()
    expect(JSON.stringify(r.sent)).not.toContain("tok-secret")
  })

  it("a player that reports no_credential after its wait is passed on", () => {
    const r = rig()
    r.music.events.report({ ready: false, error: "no_credential" })
    expect(last(r).state.players).toContainEqual({ source: "spotify", ready: false, error: "no_credential" })
  })
})

describe("talking: lower", () => {
  const playing = (r: Rig) => {
    r.c.handleCommand(1, open("spotify", { talk: talk("lower", 0.25) }))
    r.music.say({ status: "playing", title: "A", volume: 0.8 })
    r.music.volumes.length = 0
  }

  it("ramps to level times the user's volume and restores a second after the talk ends, never reporting the lowered level", () => {
    const r = rig()
    playing(r)
    r.c.setTalking(true)
    vi.advanceTimersByTime(RAMP_MS + 10)
    expect(r.music.volumes.at(-1)).toBe(0.2) // 0.25 * 0.8
    expect(r.music.volumes.length).toBeGreaterThan(1) // a ramp, not one jump
    vi.advanceTimersByTime(REPORT_MIN_MS)
    r.music.say({ status: "playing", title: "A", volume: 0.2 }) // the SDK echoing the lowered level
    vi.advanceTimersByTime(REPORT_MIN_MS)
    expect(last(r).state.current?.volume).toBe(0.8)
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS - 10)
    expect(r.music.volumes.at(-1)).toBe(0.2)
    vi.advanceTimersByTime(10 + RAMP_MS + 10)
    expect(r.music.volumes.at(-1)).toBe(0.8)
  })

  it("talking again inside the restore delay cancels the restore", () => {
    const r = rig()
    playing(r)
    r.c.setTalking(true)
    vi.advanceTimersByTime(RAMP_MS + 10)
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS - 100)
    r.c.setTalking(true)
    vi.advanceTimersByTime(RESTORE_MS * 3)
    expect(r.music.volumes.at(-1)).toBe(0.2)
  })

  it("a volume set by touch while lowered is the user's new level and stays lowered", () => {
    const r = rig()
    playing(r)
    r.c.setTalking(true)
    vi.advanceTimersByTime(RAMP_MS + 10)
    r.c.touch({ type: "volume", level: 0.4 })
    expect(r.music.volumes.at(-1)).toBe(0.1)
    expect(r.c.getView().volume).toBe(0.4)
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS + RAMP_MS + 10)
    expect(r.music.volumes.at(-1)).toBe(0.4)
  })

  it("a player without a ramp is stepped; mode none leaves everything alone", () => {
    const r = rig()
    r.c.handleCommand(1, open("youtube", { ref: "v", talk: talk("lower", 0.5) }))
    r.video.say({ status: "playing", volume: 1 })
    r.c.setTalking(true)
    vi.advanceTimersByTime(RAMP_MS + 10)
    expect(r.video.volumes).toEqual([0.833, 0.667, 0.5])
    const q = rig()
    q.c.handleCommand(1, open("spotify", { talk: talk("none") }))
    q.music.say({ status: "playing" })
    q.c.setTalking(true)
    q.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS * 2)
    expect(q.music.calls).toEqual(["open:play"])
  })

  it("an open that arrives during the talk starts lowered and is restored afterwards", () => {
    const r = rig()
    r.c.setTalking(true)
    r.c.handleCommand(1, open("spotify", { talk: talk("lower", 0.25) }))
    expect(r.music.volumes).toEqual([0.2])
    r.music.say({ status: "playing", title: "A" })
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS + RAMP_MS + 10)
    expect(r.music.volumes.at(-1)).toBe(0.8)
  })
})

describe("talking: pause", () => {
  const video = (r: Rig) => {
    r.c.handleCommand(1, open("youtube", { ref: "v", talk: talk("pause") }))
    r.video.say({ status: "playing" })
    r.video.calls.length = 0
  }

  it("pauses while talking and resumes after the delay, when it was playing", () => {
    const r = rig()
    video(r)
    r.c.setTalking(true)
    expect(r.video.calls).toEqual(["pause"])
    r.video.say({ status: "paused" })
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS - 1)
    expect(r.video.calls).toEqual(["pause"])
    vi.advanceTimersByTime(1)
    expect(r.video.calls).toEqual(["pause", "play"])
  })

  it("does not pause or resume something that was not playing", () => {
    const r = rig()
    r.c.handleCommand(1, open("youtube", { ref: "v", talk: talk("pause") }))
    r.video.say({ status: "paused" })
    r.c.setTalking(true)
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS * 2)
    expect(r.video.calls).toEqual(["open:play"])
  })

  it.each([
    ["a pause command", (r: Rig) => r.c.handleCommand(9, { type: "pause" })],
    ["a touch on pause", (r: Rig) => r.c.touch({ type: "pause" })],
    ["a touch on play", (r: Rig) => r.c.touch({ type: "play" })],
    ["a close", (r: Rig) => r.c.handleCommand(9, { type: "close" })],
    ["a new open", (r: Rig) => r.c.handleCommand(9, open("youtube", { ref: "w", talk: talk("pause"), autoplay: false }))]
  ])("is not resumed after %s in between", (_name, interfere) => {
    const r = rig()
    video(r)
    r.c.setTalking(true)
    r.video.say({ status: "paused" })
    interfere(r)
    r.video.calls.length = 0
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS * 2)
    expect(r.video.calls).not.toContain("play")
  })

  it("an open that arrives during the talk is held and starts when the talk ends; a server start meanwhile is paused again", () => {
    const r = rig()
    r.c.setTalking(true)
    r.c.handleCommand(1, open("spotify", { talk: talk("pause") }))
    expect(r.music.calls).toEqual(["open:hold"])
    r.music.say({ status: "playing", title: "A" }) // the server's own start arrives
    expect(r.music.calls).toEqual(["open:hold", "pause"])
    r.music.say({ status: "paused", title: "A" })
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS)
    expect(r.music.calls.at(-1)).toBe("play")
  })

  it("a lagging playing report right after our own pause does not cancel the resume", () => {
    const r = rig()
    video(r)
    r.c.setTalking(true)
    r.video.say({ status: "playing" })
    r.c.setTalking(false)
    vi.advanceTimersByTime(RESTORE_MS)
    expect(r.video.calls).toEqual(["pause", "play"])
  })
})

describe("a hidden tab", () => {
  it("pauses a playing video and leaves music playing", () => {
    const r = rig()
    r.c.handleCommand(1, open("youtube", { ref: "v" }))
    r.video.say({ status: "playing" })
    r.doc.visibilityState = "hidden"
    r.doc.fire()
    expect(r.video.calls).toContain("pause")
    const m = rig()
    m.c.handleCommand(1, open("spotify"))
    m.music.say({ status: "playing" })
    m.doc.visibilityState = "hidden"
    m.doc.fire()
    expect(m.music.calls).toEqual(["open:play"])
  })

  it("a video opened in a hidden tab does not autoplay", () => {
    const r = rig()
    r.doc.visibilityState = "hidden"
    r.c.handleCommand(1, open("youtube", { ref: "v" }))
    expect(r.video.calls).toEqual(["open:hold"])
  })
})

describe("what counts as talking (the page's own state)", () => {
  const s = (patch: object) => ({ ...initialState, ...patch }) as typeof initialState
  it("wake, listening, hearing, thinking, speaking and a playing reply; not idle or asleep", () => {
    expect(isTalking(initialState)).toBe(false)
    expect(isTalking(s({ woke: { phrase: "hey" } }))).toBe(true)
    for (const serverState of ["listening", "hearing", "thinking", "speaking"] as const) expect(isTalking(s({ session: { ...initialState.session, serverState } }))).toBe(true)
    for (const serverState of ["idle", "asleep"] as const) expect(isTalking(s({ session: { ...initialState.session, serverState } }))).toBe(false)
    expect(isTalking(s({ audio: { ...initialState.audio, playing: { turnId: 1 } } }))).toBe(true)
  })
})
