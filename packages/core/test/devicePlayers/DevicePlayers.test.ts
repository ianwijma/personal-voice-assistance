// `DevicePlayers` (docs/modules/media.md §4.1): which page counts, acknowledgements and `awaitStatus`, time-outs and
// disconnects, what is dropped from a page's reports and how texts are cleaned, the per-connection rate limit, the
// change stream, and that a credential token is never kept or quoted. The engine is driven directly over fake pages.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { MAX_MEDIA_TEXT_CHARS, type MediaCommandMessage, type MediaState } from "@pva/protocol"
import {
  cleanPlayerText,
  DEVICE_PLAYER_LIMITS,
  type DevicePlayerChange,
  DevicePlayerError,
  type DevicePlayersEngine,
  makeDevicePlayers,
  type PlayerLink
} from "../../src/DevicePlayers.ts"
import { makeConnectionRef } from "../../src/TurnContext.ts"

interface Page {
  readonly link: PlayerLink
  readonly deviceId: string
  readonly sent: Array<MediaCommandMessage>
}

/** A world of fake pages, oldest first, and the engine over them. */
const world = Effect.gen(function*() {
  const pages: Array<Page> = []
  const lines: Array<string> = []
  const engine: DevicePlayersEngine = yield* makeDevicePlayers({
    connections: (deviceId) => pages.filter((p) => p.deviceId === deviceId).map((p) => p.link),
    log: (line) => void lines.push(line)
  })
  const open = (id: string, sources: ReadonlyArray<string> | (() => ReadonlyArray<string>), deviceId = "kitchen-display"): Page => {
    const sent: Array<MediaCommandMessage> = []
    const page: Page = { deviceId, sent, link: { id, send: (m) => void sent.push(m), sources: typeof sources === "function" ? sources : () => sources } }
    pages.push(page)
    return page
  }
  const close = (page: Page) => {
    pages.splice(pages.indexOf(page), 1)
    engine.closed(page.link.id, page.deviceId)
  }
  const changes: Array<DevicePlayerChange> = []
  yield* Effect.forkScoped(Stream.runForEach(engine.service.changes, (c) => Effect.sync(() => void changes.push(c))))
  yield* Effect.yieldNow
  const report = (page: Page, state: Partial<MediaState> = {}, extra: object = {}) =>
    engine.report(page.link.id, page.deviceId, { type: "media.state", state: { players: [], ...state }, ...extra })
  const playing = (title = "Song"): Partial<MediaState> => ({ players: [{ source: "spotify", ready: true }], current: { source: "spotify", status: "playing", title } })
  return { pages, lines, engine, service: engine.service, open, close, changes, report, playing }
})

const play = { type: "play" } as const
const openSpotify = { type: "open", source: "spotify", ref: "spotify:track:abc", autoplay: true, talk: { mode: "lower", level: 0.2 } } as const

describe("which page counts", () => {
  it.effect("the connection the caller names, else the one with something open, else the newest that declared players", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const b = w.open("tab-b", ["spotify", "youtube"])
      const c = w.open("tab-c", ["spotify"])
      const silent = w.open("tab-d", [])
      // Nothing open anywhere: the newest page with players (not the one with none).
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.connection.id, "tab-c")
      // Something open on a: it counts, the newer tabs do not.
      w.report(a, w.playing())
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.connection.id, "tab-a")
      // The most recent report wins between two with something open.
      yield* TestClock.adjust(1_000)
      w.report(b, w.playing("Other"))
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.connection.id, "tab-b")
      // The caller's own page wins over both, if it declared players; one that declared none is never used.
      const fiber = yield* Effect.forkChild(Effect.flip(w.service.send("kitchen-display", play, { connection: makeConnectionRef("tab-c") })))
      yield* Effect.yieldNow
      assert.deepStrictEqual(c.sent.map((m) => m.command), [play])
      yield* Effect.forkChild(Effect.flip(w.service.send("kitchen-display", play, { connection: makeConnectionRef("tab-d") })))
      yield* Effect.yieldNow
      assert.deepStrictEqual(silent.sent, [])
      assert.deepStrictEqual(b.sent.map((m) => m.command), [play], "tab-d declared none: the one with something open (tab-b) got it")
      yield* Fiber.interrupt(fiber)
    }))

  it.effect("`state(device, connection)` reads the page `send` would use: the named one first, so a module reads the page it commands", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const b = w.open("tab-b", ["spotify"])
      w.report(a, w.playing("On a"))
      // Without a connection: the page with something open; named: that page's own state, whatever the others say.
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.current?.title, "On a")
      const named = yield* w.service.state("kitchen-display", makeConnectionRef("tab-b"))
      assert.deepStrictEqual([named?.connection.id, named?.current], ["tab-b", undefined])
      // A connection that is not a player page of the device falls back to the same choice `send` makes.
      assert.strictEqual((yield* w.service.state("kitchen-display", makeConnectionRef("nobody")))?.connection.id, "tab-a")
      assert.strictEqual(b.sent.length, 0)
    }))

  it.effect("a device with no connected page that declared players has no player", () =>
    Effect.gen(function*() {
      const w = yield* world
      assert.isUndefined(yield* w.service.state("kitchen-display"))
      w.open("tab-a", [])
      assert.isUndefined(yield* w.service.state("kitchen-display"))
      assert.strictEqual((yield* Effect.flip(w.service.send("kitchen-display", play))).reason, "no_player")
      assert.strictEqual((yield* Effect.flip(w.service.send("elsewhere-device", play))).reason, "no_player")
      assert.isFalse(w.service.isPlaying("kitchen-display"))
    }))

  it.effect("what the owner took away is read at every use", () =>
    Effect.gen(function*() {
      const w = yield* world
      let sources: ReadonlyArray<string> = ["spotify"]
      w.open("tab-a", () => sources)
      assert.isDefined(yield* w.service.state("kitchen-display"))
      sources = []
      assert.isUndefined(yield* w.service.state("kitchen-display"))
    }))
})

describe("send: acknowledgement, status, time-out, disconnect", () => {
  it.effect("numbers commands per connection and resolves on the first report that acknowledges it", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const b = w.open("tab-b", ["spotify"])
      const first = yield* Effect.forkChild(w.service.send("kitchen-display", play, { connection: makeConnectionRef("tab-a") }))
      const second = yield* Effect.forkChild(w.service.send("kitchen-display", { type: "pause" }, { connection: makeConnectionRef("tab-a") }))
      const other = yield* Effect.forkChild(w.service.send("kitchen-display", play, { connection: makeConnectionRef("tab-b") }))
      yield* Effect.yieldNow
      assert.deepStrictEqual(a.sent.map((m) => m.seq), [1, 2])
      assert.deepStrictEqual(b.sent.map((m) => m.seq), [1])
      // A report that acknowledges nothing, or too little, resolves nothing.
      w.report(a, w.playing())
      w.report(a, w.playing(), { ack: 0 })
      yield* Effect.yieldNow
      assert.isUndefined(first.pollUnsafe())
      w.report(a, w.playing(), { ack: 1 })
      yield* Effect.yieldNow
      assert.strictEqual((yield* Fiber.join(first)).current?.title, "Song")
      assert.isUndefined(second.pollUnsafe())
      w.report(a, w.playing("Second"), { ack: 2 })
      assert.strictEqual((yield* Fiber.join(second)).current?.title, "Second")
      assert.isUndefined(other.pollUnsafe(), "another connection's acknowledgement is its own")
      w.report(b, {}, { ack: 1 })
      assert.strictEqual((yield* Fiber.join(other)).connection.id, "tab-b")
    }))

  it.effect("an acknowledgement above what was sent is clamped to what was sent", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      w.report(a, {}, { ack: 999 })
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.ack, 0)
    }))

  it.effect("awaitStatus keeps waiting after the acknowledgement until the status, or error or blocked", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const wait = (statuses: ReadonlyArray<"playing" | "paused">) => w.service.send("kitchen-display", openSpotify, { awaitStatus: statuses, timeoutMs: 10_000 })
      const current = (status: "loading" | "playing" | "blocked" | "error" | "paused") => ({ current: { source: "spotify", status } })
      // A stale "playing" before the acknowledgement does not count.
      w.report(a, current("playing"), { ack: 0 })
      const f1 = yield* Effect.forkChild(wait(["playing"]))
      yield* Effect.yieldNow
      w.report(a, current("playing"), { ack: 0 })
      yield* Effect.yieldNow
      assert.isUndefined(f1.pollUnsafe())
      w.report(a, current("loading"), { ack: 1 })
      yield* Effect.yieldNow
      assert.isUndefined(f1.pollUnsafe(), "acknowledged, but still loading")
      w.report(a, current("playing"))
      assert.strictEqual((yield* Fiber.join(f1)).current?.status, "playing")
      for (const stop of ["error", "blocked"] as const) {
        const f = yield* Effect.forkChild(wait(["playing"]))
        yield* Effect.yieldNow
        w.report(a, current(stop), { ack: a.sent.length })
        assert.strictEqual((yield* Fiber.join(f)).current?.status, stop)
      }
      // Without awaitStatus the first acknowledgement resolves, whatever the status.
      const plain = yield* Effect.forkChild(w.service.send("kitchen-display", play))
      yield* Effect.yieldNow
      w.report(a, current("loading"), { ack: a.sent.length })
      assert.strictEqual((yield* Fiber.join(plain)).current?.status, "loading")
    }))

  it.effect("times out (3 s by default, or the caller's), the command having been sent; a late answer changes nothing", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const slow = yield* Effect.forkChild(Effect.flip(w.service.send("kitchen-display", play)))
      const quick = yield* Effect.forkChild(Effect.flip(w.service.send("kitchen-display", play, { timeoutMs: 500 })))
      yield* Effect.yieldNow
      yield* TestClock.adjust(500)
      const e = yield* Fiber.join(quick)
      assert.instanceOf(e, DevicePlayerError)
      assert.strictEqual(e.reason, "timeout")
      assert.isUndefined(slow.pollUnsafe())
      yield* TestClock.adjust(DEVICE_PLAYER_LIMITS.ackTimeoutMs)
      assert.strictEqual((yield* Fiber.join(slow)).reason, "timeout")
      assert.strictEqual(a.sent.length, 2)
      w.report(a, {}, { ack: 2 })
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.ack, 2)
    }))

  it.effect("a page that disconnects fails what waits for it as no_player", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const f = yield* Effect.forkChild(Effect.flip(w.service.send("kitchen-display", play)))
      yield* Effect.yieldNow
      w.close(a)
      assert.strictEqual((yield* Fiber.join(f)).reason, "no_player")
      assert.isUndefined(yield* w.service.state("kitchen-display"))
    }))

  it.effect("unsupported: a source the page lacks; prepare sends the sources it has", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["youtube"])
      assert.strictEqual((yield* Effect.flip(w.service.send("kitchen-display", openSpotify))).reason, "unsupported")
      assert.strictEqual((yield* Effect.flip(w.service.send("kitchen-display", { type: "credential", source: "spotify", token: "x", expiresAtMs: 1 }))).reason, "unsupported")
      assert.strictEqual((yield* Effect.flip(w.service.send("kitchen-display", { type: "prepare", sources: [{ source: "spotify" }] }))).reason, "unsupported")
      assert.deepStrictEqual(a.sent, [])
      const f = yield* Effect.forkChild(w.service.send("kitchen-display", { type: "prepare", sources: [{ source: "spotify" }, { source: "youtube", config: { name: "Kitchen" } }] }))
      yield* Effect.yieldNow
      assert.deepStrictEqual(a.sent[0]!.command, { type: "prepare", sources: [{ source: "youtube", config: { name: "Kitchen" } }] })
      w.report(a, {}, { ack: 1 })
      yield* Fiber.join(f)
    }))

  it.effect("invalid: a command or option that does not fit sends nothing; a page that cannot be written to is failed", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      for (const bad of [{ type: "volume", level: 2 }, { type: "nope" }, { type: "seek" }, null] as ReadonlyArray<unknown>) {
        assert.strictEqual((yield* Effect.flip(w.service.send("kitchen-display", bad as never))).reason, "invalid")
      }
      for (const timeoutMs of [0, -1, Number.NaN]) assert.strictEqual((yield* Effect.flip(w.service.send("kitchen-display", play, { timeoutMs }))).reason, "invalid")
      assert.strictEqual((yield* Effect.flip(w.service.send("", play))).reason, "invalid")
      assert.deepStrictEqual(a.sent, [])
      const broken = w.open("tab-b", ["spotify"])
      ;(broken.link as { send: unknown }).send = () => {
        throw new Error("socket closed")
      }
      assert.strictEqual((yield* Effect.flip(w.service.send("kitchen-display", play))).reason, "failed")
    }))

  it.effect("at most sixteen commands wait per connection", () =>
    Effect.gen(function*() {
      const w = yield* world
      w.open("tab-a", ["spotify"])
      const waiting = []
      for (let i = 0; i < DEVICE_PLAYER_LIMITS.pendingPerConnection; i++) waiting.push(yield* Effect.forkChild(Effect.flip(w.service.send("kitchen-display", play))))
      yield* Effect.yieldNow
      assert.strictEqual((yield* Effect.flip(w.service.send("kitchen-display", play))).reason, "failed")
      yield* TestClock.adjust(DEVICE_PLAYER_LIMITS.ackTimeoutMs)
      yield* Fiber.joinAll(waiting)
      const again = yield* Effect.forkChild(Effect.flip(w.service.send("kitchen-display", play)))
      yield* TestClock.adjust(DEVICE_PLAYER_LIMITS.ackTimeoutMs)
      assert.strictEqual((yield* Fiber.join(again)).reason, "timeout")
    }))
})

describe("reports from a page are untrusted", () => {
  it.effect("an invalid or oversized report is dropped, and one from a connection that declared no players is refused", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const none = w.open("tab-n", [])
      assert.strictEqual(w.report(a, w.playing()), "accepted")
      const before = JSON.stringify(yield* w.service.state("kitchen-display"))
      const long = "x".repeat(MAX_MEDIA_TEXT_CHARS + 1)
      const bad: ReadonlyArray<unknown> = [
        { type: "media.state", state: { players: [], current: { source: "spotify", status: "playing", title: long } } },
        { type: "media.state", state: { players: [], current: { source: "spotify", status: "dancing" } } },
        { type: "media.state", state: { players: [], current: { source: "spotify", status: "playing", artUrl: "http://x.example/a.png" } } },
        { type: "media.state", state: { players: Array.from({ length: 9 }, (_, i) => ({ source: `s${i}`, ready: true })) } },
        { type: "media.state", state: { players: [{ source: "Spotify", ready: true }] } },
        { type: "media.state", state: "playing" },
        { type: "media.state" },
        { type: "media.state", state: { players: [] }, ack: -1 },
        "text",
        null
      ]
      for (const raw of bad) assert.strictEqual(w.engine.report("tab-a", "kitchen-display", raw), "invalid", JSON.stringify(raw)?.slice(0, 80))
      assert.strictEqual(JSON.stringify(yield* w.service.state("kitchen-display")), before)
      assert.strictEqual(w.report(none, w.playing()), "refused")
      assert.strictEqual(w.engine.report("tab-a", "another-device", { type: "media.state", state: { players: [] } }), "refused")
      assert.strictEqual(w.engine.report("no-such-tab", "kitchen-display", { type: "media.state", state: { players: [] } }), "refused")
    }))

  it("cleans every text the way texts from outside are cleaned", () => {
    assert.strictEqual(cleanPlayerText("Feeling\nGood\t\u0000 \u202eevil\u202c\u200b  "), "Feeling Good evil")
    assert.strictEqual(cleanPlayerText("a\u2028b\u2029c\u0085d"), "a b c d")
    assert.strictEqual(cleanPlayerText("bad \ud800 half"), "bad \ufffd half")
    assert.strictEqual(cleanPlayerText("\u202e\u2066 \n"), undefined)
    assert.strictEqual(cleanPlayerText("say \"hi\" <b>[x]</b>"), "say \"hi\" <b>[x]</b>", "quotes and brackets are data, not removed")
    const clipped = cleanPlayerText("é".repeat(300), 50)!
    assert.strictEqual([...clipped].length, 50)
    assert.isTrue(clipped.endsWith("…"))
    assert.isUndefined(cleanPlayerText(42))
  })

  it.effect("texts in an accepted report are cleaned; empty ones are left out; addresses and codes pass as validated", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      w.report(a, {
        current: { source: "spotify", status: "playing", title: "A\nB\u202e", artist: "\u200b", album: "  Al  bum ", link: "https://open.spotify.com/x", errorCode: "none_here" }
      })
      const s = (yield* w.service.state("kitchen-display"))!
      assert.deepStrictEqual(s.current, { source: "spotify", status: "playing", title: "A B", album: "Al bum", link: "https://open.spotify.com/x", errorCode: "none_here" })
      assert.isUndefined(s.current?.artist)
    }))

  it.effect("`held` (the page itself paused it for the talk rule) passes as reported", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      w.report(a, { current: { source: "spotify", status: "paused", held: true } })
      assert.deepStrictEqual((yield* w.service.state("kitchen-display"))?.current, { source: "spotify", status: "paused", held: true })
      w.report(a, { current: { source: "spotify", status: "paused", held: false } })
      assert.isUndefined((yield* w.service.state("kitchen-display"))?.current?.held)
    }))

  it.effect("each connection has a burst of ten reports and ten a second after; the latest report over it is kept and applied", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const b = w.open("tab-b", ["spotify"])
      for (let i = 0; i < DEVICE_PLAYER_LIMITS.stateBurst; i++) assert.strictEqual(w.report(a, w.playing(`t${i}`)), "accepted")
      // Over the burst: limited, the newest kept (an acknowledgement carried by a dropped one is not lost).
      const waiting = yield* Effect.forkChild(w.service.send("kitchen-display", play, { connection: makeConnectionRef("tab-a") }))
      yield* Effect.yieldNow
      assert.strictEqual(w.report(a, w.playing("t10"), { ack: 0 }), "limited")
      assert.strictEqual(w.report(a, w.playing("t11"), { ack: 1 }), "limited")
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.current?.title, "t9")
      assert.isUndefined(waiting.pollUnsafe())
      // Another connection has its own allowance.
      assert.strictEqual(w.report(b, w.playing("other")), "accepted")
      // A tenth of a second refills one report: the latest held one is applied, with its acknowledgement.
      yield* TestClock.adjust(100)
      yield* Effect.yieldNow
      assert.strictEqual((yield* Fiber.join(waiting)).current?.title, "t11")
      assert.isTrue(w.lines.some((l) => l.includes("faster than 10 a second")))
      // After a second of quiet the burst is back.
      yield* TestClock.adjust(1_000)
      for (let i = 0; i < DEVICE_PLAYER_LIMITS.stateBurst; i++) assert.strictEqual(w.report(a, w.playing(`u${i}`)), "accepted")
      assert.strictEqual(w.report(a, w.playing("over")), "limited")
    }))
})

describe("changes and isPlaying", () => {
  it.effect("a page arriving, a report that changed the state, a wish, and the last page going", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      w.engine.refresh("kitchen-display")
      yield* Effect.yieldNow
      assert.deepStrictEqual(w.changes.map((c) => [c.deviceId, c.connection.id, c.state?.sources]), [["kitchen-display", "tab-a", ["spotify"]]])
      w.engine.refresh("kitchen-display")
      yield* Effect.yieldNow
      assert.strictEqual(w.changes.length, 1, "nothing changed")
      w.report(a, w.playing())
      w.report(a, w.playing()) // the same again: not a change
      w.report(a, w.playing(), { wants: [{ source: "spotify", what: "credential" }] })
      yield* Effect.yieldNow
      assert.deepStrictEqual(w.changes.slice(1).map((c) => [c.state?.current?.title, c.wants]), [["Song", undefined], ["Song", [{ source: "spotify", what: "credential" }]]])
      w.close(a)
      yield* Effect.yieldNow
      const last = w.changes.at(-1)!
      assert.deepStrictEqual([last.deviceId, last.connection.id, last.state], ["kitchen-display", "tab-a", undefined])
    }))

  it.effect("a report from a page that is not the chosen one changes nothing the device's followers see", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const b = w.open("tab-b", ["spotify"])
      w.report(a, w.playing())
      yield* Effect.yieldNow
      const seen = w.changes.length
      // b reports an idle state: a still has something open, so a is the device's page and its state did not change.
      w.report(b, { players: [{ source: "spotify", ready: true }] })
      yield* Effect.yieldNow
      assert.strictEqual(w.changes.length, seen)
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.connection.id, "tab-a")
    }))

  it.effect("isPlaying is device-wide: a second tab that plays guards the device though another page is the chosen one", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const b = w.open("tab-b", ["spotify"])
      // a reports paused later than b reported playing, so a is the chosen page (the most recent report with something open).
      w.report(b, w.playing())
      yield* TestClock.adjust(1_000)
      w.report(a, { players: [], current: { source: "spotify", status: "paused" } })
      assert.strictEqual((yield* w.service.state("kitchen-display"))?.connection.id, "tab-a")
      assert.isTrue(w.service.isPlaying("kitchen-display"))
      // It stops counting when that tab goes quiet or goes away.
      yield* TestClock.adjust(DEVICE_PLAYER_LIMITS.playingFreshMs)
      assert.isFalse(w.service.isPlaying("kitchen-display"))
      w.report(b, w.playing())
      w.close(b)
      assert.isFalse(w.service.isPlaying("kitchen-display"))
    }))

  it.effect("isPlaying: the chosen page says playing, reported within a minute", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      assert.isFalse(w.service.isPlaying("kitchen-display"))
      w.report(a, w.playing())
      assert.isTrue(w.service.isPlaying("kitchen-display"))
      yield* TestClock.adjust(DEVICE_PLAYER_LIMITS.playingFreshMs)
      assert.isTrue(w.service.isPlaying("kitchen-display"))
      yield* TestClock.adjust(1)
      assert.isFalse(w.service.isPlaying("kitchen-display"), "a page that went quiet is not counted")
      w.report(a, { players: [], current: { source: "spotify", status: "paused" } })
      assert.isFalse(w.service.isPlaying("kitchen-display"))
      w.report(a, w.playing())
      w.close(a)
      assert.isFalse(w.service.isPlaying("kitchen-display"))
    }))
})

describe("a credential token", () => {
  it.effect("is sent to the page and nowhere else: not in a state, an error, a change or a log line", () =>
    Effect.gen(function*() {
      const w = yield* world
      const a = w.open("tab-a", ["spotify"])
      const token = "BQDsecretTOKEN-0123456789.abc_def"
      const f = yield* Effect.forkChild(Effect.flip(w.service.send("kitchen-display", { type: "credential", source: "spotify", token, expiresAtMs: 1_763_103_600_000 })))
      yield* Effect.yieldNow
      assert.strictEqual((a.sent[0]!.command as { token: string }).token, token)
      yield* TestClock.adjust(DEVICE_PLAYER_LIMITS.ackTimeoutMs)
      const timeout = yield* Fiber.join(f)
      // Everything the service can show of it afterwards.
      w.report(a, w.playing(), { ack: 1 })
      for (let i = 0; i < 12; i++) w.report(a, w.playing()) // over the rate: its log line
      yield* Effect.yieldNow
      const visible = JSON.stringify([timeout, yield* w.service.state("kitchen-display"), w.changes, w.lines, String(timeout), timeout.message])
      assert.notInclude(visible, "secretTOKEN")
      assert.notInclude(visible, token)
      const invalid = yield* Effect.flip(w.service.send("kitchen-display", { type: "credential", source: "spotify", token: `${token} with space`, expiresAtMs: 1 }))
      assert.strictEqual(invalid.reason, "invalid")
      assert.notInclude(JSON.stringify([invalid, invalid.detail]), "secretTOKEN")
    }))
})
