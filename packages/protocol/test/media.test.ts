// The player's wire messages (docs/modules/media.md §4.1, §4.2): bounds, round trips, the capability, and that an older
// peer's tolerance of unknown messages is unchanged.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  decodeClientMessage,
  decodeServerMessage,
  DeviceCapabilities,
  effectiveCapabilities,
  encodeClientMessage,
  encodeServerMessage,
  MAX_MEDIA_CONFIG_ENTRIES,
  MAX_MEDIA_PLAYERS,
  MAX_MEDIA_TEXT_CHARS,
  MAX_MEDIA_TOKEN_CHARS,
  MAX_MEDIA_URL_CHARS,
  MAX_MEDIA_WANTS,
  MediaCommandMessage,
  MediaConfig,
  MediaStateMessage,
  NO_OVERRIDES,
  PROTOCOL_VERSION
} from "../src/index.ts"
import { clientExamples, exampleCapabilities, serverExamples } from "../src/examples.ts"

const command = Schema.is(MediaCommandMessage)
const state = Schema.is(MediaStateMessage)
const caps = Schema.is(DeviceCapabilities)
const cmd = (c: unknown, seq = 1) => ({ type: "media.command", seq, command: c })
const open = { type: "open", source: "youtube", autoplay: true, talk: { mode: "lower", level: 0.2 } }
const report = (s: unknown, rest: object = {}) => ({ type: "media.state", state: s, ...rest })
const https = (n: number) => `https://x.example/${"a".repeat(n - "https://x.example/".length)}`

describe("media.command", () => {
  it("keeps the protocol version", () => expect(PROTOCOL_VERSION).toBe(12))

  it("accepts every command", () => {
    for (const c of [
      { type: "prepare", sources: [{ source: "spotify", config: { name: "Kitchen", volume: 0.5, shuffle: false } }, { source: "youtube" }] },
      { type: "credential", source: "spotify", token: "BQD-abc_123.xyz", expiresAtMs: 1_763_103_600_000 },
      open,
      { ...open, ref: "spotify:track:7KXjTSCq5nL1LoYtL7XAwS", kind: "track", title: "T", subtitle: "S", artUrl: "https://i.scdn.co/x", link: "https://open.spotify.com/t", startAtMs: 1000 },
      { type: "play" }, { type: "pause" }, { type: "next" }, { type: "previous" }, { type: "close" },
      { type: "seek", toMs: 30_000 }, { type: "seek", byMs: -10_000 }, { type: "volume", level: 0 }, { type: "volume", level: 1 }
    ]) expect(command(cmd(c)), JSON.stringify(c)).toBe(true)
  })

  it("refuses what is out of bounds", () => {
    const bad: ReadonlyArray<unknown> = [
      { type: "teleport" },
      { type: "volume", level: 1.01 }, { type: "volume", level: -0.1 }, { type: "volume" },
      { type: "seek" }, { type: "seek", toMs: -1 }, { type: "seek", byMs: 1e12 },
      { ...open, source: "Spotify" }, { ...open, source: "" }, { ...open, source: "x".repeat(25) },
      { ...open, talk: { mode: "mute", level: 0.2 } }, { ...open, talk: { mode: "lower", level: 2 } }, { ...open, talk: undefined },
      { ...open, autoplay: undefined },
      { ...open, ref: "has space" }, { ...open, ref: "x".repeat(129) },
      { ...open, title: "x".repeat(MAX_MEDIA_TEXT_CHARS + 1) }, { ...open, subtitle: "x".repeat(MAX_MEDIA_TEXT_CHARS + 1) },
      { ...open, artUrl: "http://x.example/a.png" }, { ...open, link: "javascript:alert(1)" }, { ...open, artUrl: "https://x.example/a b" },
      { ...open, artUrl: https(MAX_MEDIA_URL_CHARS + 1) },
      { ...open, startAtMs: -5 },
      { type: "credential", source: "spotify", token: "", expiresAtMs: 1 },
      { type: "credential", source: "spotify", token: "has space", expiresAtMs: 1 },
      { type: "credential", source: "spotify", token: "a".repeat(MAX_MEDIA_TOKEN_CHARS + 1), expiresAtMs: 1 },
      { type: "credential", source: "spotify", token: "ok", expiresAtMs: -1 },
      { type: "prepare", sources: Array.from({ length: MAX_MEDIA_PLAYERS + 1 }, (_, i) => ({ source: `s${i}` })) },
      { type: "prepare", sources: [{ source: "spotify", config: { a: { nested: true } } }] },
      { type: "prepare", sources: [{ source: "spotify", config: { name: "x".repeat(101) } }] }
    ]
    for (const c of bad) expect(command(cmd(c)), JSON.stringify(c)).toBe(false)
    expect(command(cmd({ type: "play" }, -1))).toBe(false)
    expect(command(cmd({ type: "play" }, 1.5))).toBe(false)
    expect(command(cmd({ type: "play" }, 2 ** 32))).toBe(false)
    expect(command(cmd(open, 2 ** 32 - 1))).toBe(true)
  })

  it("bounds a player's config", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_MEDIA_CONFIG_ENTRIES + 1 }, (_, i) => [`k${i}`, i]))
    expect(Schema.is(MediaConfig)(many)).toBe(false)
    expect(Schema.is(MediaConfig)(Object.fromEntries(Object.entries(many).slice(0, MAX_MEDIA_CONFIG_ENTRIES)))).toBe(true)
  })

  it("round trips through the codec, and an older server's tolerance is unchanged", () => {
    const message = serverExamples["media.command"]
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual({ _tag: "Ok", message })
    // A peer that does not know a newer message type ignores it.
    expect(decodeServerMessage(JSON.stringify({ type: "media.something.new" }))._tag).toBe("Unknown")
    expect(decodeServerMessage(JSON.stringify({ type: "media.command", seq: 1, command: { type: "teleport" } }))._tag).toBe("Invalid")
  })
})

describe("media.state", () => {
  const players = [{ source: "spotify", ready: true, playerId: "9c1f0a5be1c4" }]

  it("accepts the shapes a page sends", () => {
    expect(state(report({ players: [] }))).toBe(true)
    expect(state(report({ players }, { ack: 0 }))).toBe(true)
    expect(state(report({ players: [{ source: "youtube", ready: false, error: "unsupported" }], visible: false }))).toBe(true)
    for (const status of ["loading", "playing", "paused", "ended", "blocked", "error"]) {
      expect(state(report({ players, current: { source: "spotify", status, ...(status === "error" ? { errorCode: "account_error" } : {}) } })), status).toBe(true)
    }
    expect(state(report({ players }, { wants: [{ source: "spotify", what: "credential" }] }))).toBe(true)
  })

  it("refuses what is out of bounds", () => {
    const current = (c: object) => report({ players, current: { source: "spotify", status: "playing", ...c } })
    expect(state(report({ players: Array.from({ length: MAX_MEDIA_PLAYERS + 1 }, (_, i) => ({ source: `s${i}`, ready: true })) }))).toBe(false)
    expect(state(report({ players: [{ source: "spotify" }] }))).toBe(false)
    expect(state(report({ players: [{ source: "spotify", ready: true, playerId: "a b" }] }))).toBe(false)
    expect(state(report({ players: [{ source: "spotify", ready: true, error: "Bad Code" }] }))).toBe(false)
    expect(state(report({ players }, { ack: -1 }))).toBe(false)
    expect(state(report({ players }, { ack: 1.5 }))).toBe(false)
    expect(state(report({ players }, { wants: [{ source: "spotify", what: "pizza" }] }))).toBe(false)
    expect(state(report({ players }, { wants: Array.from({ length: MAX_MEDIA_WANTS + 1 }, () => ({ source: "spotify", what: "credential" })) }))).toBe(false)
    expect(state(current({ status: "dancing" }))).toBe(false)
    expect(state(current({ title: "x".repeat(MAX_MEDIA_TEXT_CHARS + 1) }))).toBe(false)
    expect(state(current({ artist: "x".repeat(MAX_MEDIA_TEXT_CHARS + 1) }))).toBe(false)
    expect(state(current({ album: "x".repeat(MAX_MEDIA_TEXT_CHARS + 1) }))).toBe(false)
    expect(state(current({ artUrl: "http://x.example/a.png" }))).toBe(false)
    expect(state(current({ link: https(MAX_MEDIA_URL_CHARS + 1) }))).toBe(false)
    expect(state(current({ durationMs: -1 }))).toBe(false)
    expect(state(current({ positionMs: 1e12 }))).toBe(false)
    expect(state(current({ volume: 1.5 }))).toBe(false)
    expect(state(current({ canNext: "yes" }))).toBe(false)
    expect(state(current({ errorCode: "no spaces allowed" }))).toBe(false)
    expect(state(current({ source: "" }))).toBe(false)
    expect(state(current({ title: "x".repeat(MAX_MEDIA_TEXT_CHARS), artUrl: https(MAX_MEDIA_URL_CHARS) }))).toBe(true)
  })

  it("round trips through the codec; a stranger's message is invalid, not a crash", () => {
    const message = clientExamples["media.state"]
    expect(decodeClientMessage(encodeClientMessage(message))).toEqual({ _tag: "Ok", message })
    expect(decodeClientMessage(JSON.stringify({ type: "media.state", state: "playing" }))._tag).toBe("Invalid")
    expect(decodeClientMessage(JSON.stringify({ type: "media.nothing" }))._tag).toBe("Unknown")
  })
})

describe("DeviceCapabilities.media", () => {
  const withMedia = (players: ReadonlyArray<string>) => ({ ...exampleCapabilities, media: { players } })

  it("declares at most eight source slugs and is optional", () => {
    expect(caps(exampleCapabilities)).toBe(true)
    expect(caps(withMedia(["spotify", "youtube"]))).toBe(true)
    expect(caps(withMedia([]))).toBe(true)
    expect(caps(withMedia(Array.from({ length: MAX_MEDIA_PLAYERS + 1 }, (_, i) => `s${i}`)))).toBe(false)
    expect(caps(withMedia(["Not A Slug"]))).toBe(false)
    expect(caps({ v: 1, media: {} })).toBe(false)
    expect(Schema.decodeUnknownSync(DeviceCapabilities)(withMedia(["spotify"])).media).toEqual({ players: ["spotify"] })
  })

  it("the owner can take it away like the display and the speaker, never add it", () => {
    const declared = { ...withMedia(["spotify"]), display: exampleCapabilities.display!, speaker: { media: ["speech", "audio"] as const } } as DeviceCapabilities
    expect(effectiveCapabilities(declared, NO_OVERRIDES).media).toEqual({ players: ["spotify"] })
    expect(effectiveCapabilities(declared, { ...NO_OVERRIDES, noDisplay: true }).media).toBeUndefined()
    expect(effectiveCapabilities(declared, { ...NO_OVERRIDES, noSpeaker: true }).media).toBeUndefined()
    expect(effectiveCapabilities({ v: 1, display: exampleCapabilities.display!, speaker: declared.speaker! }, NO_OVERRIDES).media).toBeUndefined()
    expect(effectiveCapabilities(undefined, NO_OVERRIDES).media).toBeUndefined()
  })
})
