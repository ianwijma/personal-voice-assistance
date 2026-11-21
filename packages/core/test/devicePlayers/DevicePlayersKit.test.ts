// The kit's fake pages (`kit.players`) under a module that uses `host.service(DevicePlayers)` as the media module will:
// the real service answers, the page is scripted. Also the host's "stop" pausing a player through `Playback` by device id.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
import { makeTool } from "../../src/Module.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { DevicePlayerError, DevicePlayers } from "../../src/DevicePlayers.ts"
import { Playback, PlaybackError } from "../../src/Playback.ts"
import { CurrentTurn } from "../../src/TurnContext.ts"
import { startTestModule } from "../../src/testing.ts"

/** A module shaped like the media module's use of the service: open and wait for `playing`, and provide `Playback`. */
const player = defineModule({
  apiVersion: 2,
  id: "player",
  name: "Player",
  description: "Plays on the asking device.",
  enabledByDefault: false,
  shared: (ctx) =>
    Effect.succeed({
      value: undefined,
      services: [Playback.of({
        pause: (deviceId) =>
          Effect.gen(function*() {
            const players = ctx.host.service(DevicePlayers)
            const state = players === undefined ? undefined : yield* players.state(deviceId)
            if (players === undefined || state === undefined) return yield* new PlaybackError({ reason: "no_player", detail: "no page" })
            if (state.current?.status !== "playing") return false
            yield* players.send(deviceId, { type: "pause" }, { awaitStatus: ["paused"] }).pipe(
              Effect.mapError((e) => new PlaybackError({ reason: e.reason === "timeout" ? "timeout" : e.reason === "no_player" ? "no_player" : "failed", detail: e.detail }))
            )
            return true
          }),
        changeVolume: () => Effect.fail(new PlaybackError({ reason: "failed", detail: "not used here" }))
      })]
    }),
  start: (ctx) =>
    Effect.succeed({
      tools: [
        makeTool({
          name: "player_open",
          description: "Open a source on this device.",
          parameters: Schema.Struct({ source: Schema.String, ref: Schema.String }),
          speculative: false,
          risk: "change",
          execute: ({ source, ref }) =>
            Effect.gen(function*() {
              const turn = yield* CurrentTurn
              const players = ctx.host.service(DevicePlayers)
              if (players === undefined || turn?.deviceId === undefined) return { error: "not available" }
              return yield* players.send(
                turn.deviceId,
                { type: "open", source, ref, autoplay: true, talk: { mode: "lower", level: 0.2 } },
                { ...(turn.connection !== undefined ? { connection: turn.connection } : {}), awaitStatus: ["playing"], timeoutMs: 5_000 }
              ).pipe(
                Effect.map((s) => ({ status: s.current?.status, onConnection: s.connection.id })),
                Effect.catchTag("DevicePlayerError", (e) => Effect.succeed({ error: e.reason }))
              )
            })
        })
      ]
    })
})

describe("kit.players", () => {
  it.effect("a device without a page has no player; a page that declared its sources has", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(player)
      assert.deepStrictEqual((yield* kit.tool("player_open", { source: "spotify", ref: "spotify:track:1" })).value, { error: "no_player" })
      const page = yield* kit.players.page(["spotify", "youtube"])
      assert.strictEqual(page.connection.id, "kit-connection-kitchen-display", "the device's first page is the connection the kit's turns carry")
      assert.deepStrictEqual((yield* kit.service(DevicePlayers)!.state("kitchen-display"))?.sources, ["spotify", "youtube"])
      // The page answers nothing until the test says so: the call is waiting on the test clock, so the test moves it.
      const waiting = yield* Effect.forkChild(kit.tool("player_open", { source: "spotify", ref: "spotify:track:1" }))
      yield* kit.players.settle
      yield* kit.advance(5_000)
      assert.deepStrictEqual((yield* Fiber.join(waiting)).value, { error: "timeout" })
      assert.deepStrictEqual(page.commands().map((c) => c.type), ["open"])
    }))

  it.effect("respond(\"play\"): a working player opens, plays, pauses and reports; the module waits for `playing`", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(player)
      const page = yield* kit.players.page(["spotify"])
      page.respond("play")
      const opened = yield* kit.tool("player_open", { source: "spotify", ref: "spotify:track:1" })
      assert.deepStrictEqual(opened.value, { status: "playing", onConnection: page.connection.id })
      assert.strictEqual(page.state().current?.ref, "spotify:track:1")
      assert.isTrue(kit.service(DevicePlayers)!.isPlaying("kitchen-display"))
      // The host's "stop" pauses it through the module's Playback, by device id, and the page confirms.
      const stop = yield* kit.phrases.say("stop")
      assert.isTrue(stop.taken && stop.outcome.did === "paused-media")
      assert.deepStrictEqual(page.commands().map((c) => c.type), ["open", "pause"])
      assert.strictEqual(page.state().current?.status, "paused")
      // Nothing playing now: "stop" does nothing.
      const again = yield* kit.phrases.say("stop")
      assert.isTrue(again.taken && again.outcome.did === "nothing")
    }))

  it.effect("a blocked autoplay and a failing open come back as the page's status, not a time out", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(player)
      const page = yield* kit.players.page(["youtube"])
      page.respond("play", { autoplayBlocked: true })
      assert.deepStrictEqual((yield* kit.tool("player_open", { source: "youtube", ref: "dQw4w9WgXcQ" })).value, { status: "blocked", onConnection: page.connection.id })
      page.respond("play", { openError: "embed_refused" })
      assert.deepStrictEqual((yield* kit.tool("player_open", { source: "youtube", ref: "dQw4w9WgXcQ" })).value, { status: "error", onConnection: page.connection.id })
      assert.strictEqual(page.state().current?.errorCode, "embed_refused")
    }))

  it.effect("a custom responder decides per command; a page that lacks the source answers `unsupported`", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(player)
      const page = yield* kit.players.page(["youtube"])
      page.respond((m) => (m.command.type === "open" ? { state: { current: { source: "youtube", status: "playing", title: "A\nvideo" } } } : undefined))
      assert.deepStrictEqual((yield* kit.tool("player_open", { source: "youtube", ref: "dQw4w9WgXcQ" })).value, { status: "playing", onConnection: page.connection.id })
      assert.strictEqual((yield* kit.service(DevicePlayers)!.state("kitchen-display"))?.current?.title, "A video", "the title was cleaned by the service")
      assert.deepStrictEqual((yield* kit.tool("player_open", { source: "spotify", ref: "spotify:track:1" })).value, { error: "unsupported" })
    }))

  it.effect("two tabs: the turn's own connection first; a report from the other tab is the device's state while it plays", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(player)
      const first = yield* kit.players.page(["spotify"])
      const second = yield* kit.players.page(["spotify"])
      assert.notStrictEqual(first.connection.id, second.connection.id)
      first.respond("play")
      second.respond("play")
      assert.strictEqual(((yield* kit.tool("player_open", { source: "spotify", ref: "spotify:track:1" })).value as { onConnection: string }).onConnection, first.connection.id)
      assert.deepStrictEqual(second.commands(), [])
      // A touch on the second tab starts something there: it reports, and it is the device's page now (the other one is idle).
      yield* first.report({ current: null })
      yield* second.report({ current: { source: "spotify", status: "playing", title: "By touch" } })
      assert.strictEqual((yield* kit.service(DevicePlayers)!.state("kitchen-display"))?.connection.id, second.connection.id)
      // The tool still goes to the turn's own tab.
      assert.strictEqual(((yield* kit.tool("player_open", { source: "spotify", ref: "spotify:track:2" })).value as { onConnection: string }).onConnection, first.connection.id)
      assert.deepStrictEqual(kit.players.sent.map((s) => [s.connection.id === first.connection.id ? "first" : "second", s.message.command.type]), [["first", "open"], ["first", "open"]])
    }))

  it.effect("a device's page disconnecting takes its players with it, and what was waiting fails", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(player)
      const page = yield* kit.players.page(["spotify"])
      yield* kit.notify.disconnect("kitchen-display")
      assert.isUndefined(yield* kit.service(DevicePlayers)!.state("kitchen-display"))
      yield* kit.notify.connect("kitchen-display")
      assert.isUndefined(yield* kit.service(DevicePlayers)!.state("kitchen-display"), "a page that reconnects declares its players again")
      const error = yield* Effect.flip(kit.players.service.send("kitchen-display", { type: "play" }))
      assert.instanceOf(error, DevicePlayerError)
      assert.strictEqual(error.reason, "no_player")
      assert.isDefined(page)
    }))

  it.effect("raw reports: the service drops what does not fit, as it would from a real page", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(player)
      const page = yield* kit.players.page(["spotify"])
      assert.strictEqual(yield* page.report(undefined, { raw: { type: "media.state", state: { players: [], current: { source: "spotify", status: "dancing" } } } }), "invalid")
      assert.strictEqual(yield* page.report({ current: { source: "spotify", status: "paused" } }), "accepted")
      assert.strictEqual((yield* kit.players.service.state("kitchen-display"))?.current?.status, "paused")
    }))
})
