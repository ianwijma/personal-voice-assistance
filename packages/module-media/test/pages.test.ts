// The pages part of the media module against a fake `DevicePlayers` and a fake Spotify: who may be told to load Spotify and who
// may be handed a token (the owner's registry knows the device, and this module prepared that connection for Spotify), how
// often, how often a refusal is logged, and that every tab is prepared again after a sign-in change.
import { assert, describe, it } from "@effect/vitest"
import { type ConnectionRef, DevicePlayers, type DevicePlayerChange, type DevicePlayerState, Devices, makeConnectionRef } from "@pva/core"
import { WebVideos } from "@pva/module-contracts"
import { Effect, Logger, PubSub, Scope, Stream } from "effect"
import { TOKEN_EVERY_MS, watchPages } from "../src/pages.ts"

type Sent = { readonly deviceId: string; readonly connection: string | undefined; readonly command: any }

const make = (init: { readonly known: Set<string>; readonly signedIn?: boolean; readonly videos?: boolean; readonly tokenLifeMs?: number }) =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const pubsub = yield* PubSub.unbounded<DevicePlayerChange>()
    const sent: Array<Sent> = []
    const clock = { now: 1_000_000 }
    const spotify = {
      signedIn: init.signedIn ?? true,
      status() {
        return this.signedIn ? { kind: "signed-in" as const, cannotRenew: false } : { kind: "signed-out" as const }
      },
      source: { accessToken: Effect.sync(() => ({ token: "SECRET-TOKEN", expiresAtMs: clock.now + (init.tokenLifeMs ?? 3_600_000) })) }
    }
    const svc = {
      state: () => Effect.succeed(undefined),
      send: (deviceId: string, command: unknown, options?: { connection?: ConnectionRef }) =>
        Effect.sync(() => {
          sent.push({ deviceId, connection: options?.connection?.id, command })
          return {} as DevicePlayerState
        }),
      changes: Stream.fromPubSub(pubsub),
      isPlaying: () => false
    }
    const host = {
      view: () => ({}) as never,
      service: ((key: unknown) => (key === DevicePlayers ? svc : key === Devices ? { get: (id: string) => (init.known.has(id) ? { id, name: "Kitchen" } : undefined) } : key === WebVideos && init.videos === true ? {} : undefined)) as never
    }
    const pages = yield* watchPages({ host, spotify: spotify as never, scope, now: () => clock.now })
    const change = (deviceId: string, connection: string, extra: { sources?: ReadonlyArray<string>; wants?: boolean; chosen?: string } = {}) =>
      Effect.gen(function*() {
        const chosen = makeConnectionRef(extra.chosen ?? connection)
        PubSub.publishUnsafe(pubsub, {
          deviceId,
          connection: makeConnectionRef(connection),
          state: { connection: chosen, sources: extra.sources ?? ["spotify", "youtube"], players: [], ack: 0, reportedAt: clock.now },
          ...(extra.wants === true ? { wants: [{ source: "spotify", what: "credential" as const }] } : {})
        })
        // The handler runs on its own fiber.
        yield* Effect.sleep(10)
      })
    return { pages, sent, clock, spotify, change, known: init.known }
  })

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, logged: Array<string> = []) =>
  effect.pipe(
    Effect.provide(Logger.layer([Logger.make<unknown, void>(({ message }) => void logged.push(Array.isArray(message) ? message.join(" ") : String(message)))])),
    Effect.scoped
  )

const credentials = (sent: ReadonlyArray<Sent>) => sent.filter((s) => s.command.type === "credential")
const prepares = (sent: ReadonlyArray<Sent>) => sent.filter((s) => s.command.type === "prepare")

describe("who may be told to load Spotify and handed a token", () => {
  it.live("a device id the owner's registry does not know is sent no Spotify prepare and no token, however it asks", () =>
    run(Effect.gen(function*() {
      const w = yield* make({ known: new Set(["kitchen-display"]), videos: true })
      yield* w.change("invented-by-a-client", "c1", { wants: true })
      assert.deepStrictEqual(prepares(w.sent).map((s) => s.command.sources), [[{ source: "youtube" }]])
      assert.deepStrictEqual(credentials(w.sent), [])
    })))

  it.live("a device that becomes known is prepared for Spotify on its next report, and only then handed a token", () =>
    run(Effect.gen(function*() {
      const w = yield* make({ known: new Set() })
      yield* w.change("kitchen-display", "c1", { wants: true })
      assert.strictEqual(w.sent.length, 0)
      w.known.add("kitchen-display")
      yield* w.change("kitchen-display", "c1", { wants: true })
      assert.deepStrictEqual(prepares(w.sent).map((s) => s.command.sources), [[{ source: "spotify", config: { name: "Kitchen" } }]])
      assert.strictEqual(credentials(w.sent).length, 1)
      assert.strictEqual(credentials(w.sent)[0]!.connection, "c1")
    })))

  it.live("a page this module did not prepare for Spotify (it declared only YouTube) is not handed a token", () =>
    run(Effect.gen(function*() {
      const w = yield* make({ known: new Set(["kitchen-display"]), videos: true })
      yield* w.change("kitchen-display", "c1", { sources: ["youtube"], wants: true })
      assert.deepStrictEqual(prepares(w.sent).map((s) => s.command.sources), [[{ source: "youtube" }]])
      assert.deepStrictEqual(credentials(w.sent), [])
    })))

  it.live("at most one token per connection per five minutes unless it expires within two; a repeated want is not an error", () =>
    run(Effect.gen(function*() {
      const w = yield* make({ known: new Set(["kitchen-display"]) })
      yield* w.change("kitchen-display", "c1", { wants: true })
      yield* w.change("kitchen-display", "c1", { wants: true })
      yield* w.change("kitchen-display", "c1", { wants: true })
      assert.strictEqual(credentials(w.sent).length, 1)
      // Another connection has its own allowance.
      yield* w.change("kitchen-display", "c2", { wants: true, chosen: "c1" })
      assert.deepStrictEqual(credentials(w.sent).map((s) => s.connection), ["c1", "c2"])
      // Five minutes on, a new need is met.
      w.clock.now += TOKEN_EVERY_MS + 1
      yield* w.change("kitchen-display", "c1", { wants: true })
      assert.strictEqual(credentials(w.sent).filter((s) => s.connection === "c1").length, 2)
      // The token itself never leaves in anything but the credential command.
      assert.isTrue(w.sent.filter((s) => s.command.type !== "credential").every((s) => !JSON.stringify(s.command).includes("SECRET-TOKEN")))
    })))

  it.live("a token that expires within two minutes is replaced at once when the page asks", () =>
    run(Effect.gen(function*() {
      const w = yield* make({ known: new Set(["kitchen-display"]), tokenLifeMs: 90_000 })
      yield* w.change("kitchen-display", "c1", { wants: true })
      yield* w.change("kitchen-display", "c1", { wants: true })
      assert.strictEqual(credentials(w.sent).length, 2)
    })))

  it.live("refusals and failures are logged at most once a minute per connection (signed out, refused), and never with a token", () => {
    const logged: Array<string> = []
    return run(Effect.gen(function*() {
      const signedOut = yield* make({ known: new Set(["kitchen-display"]) })
      // Prepared while signed in; then the token cannot be had (a locked vault, a refused client) and the page keeps asking.
      yield* signedOut.change("kitchen-display", "c1")
      ;(signedOut.spotify.source as { accessToken: unknown }).accessToken = Effect.fail({ reason: "locked" })
      for (let i = 0; i < 20; i++) yield* signedOut.change("kitchen-display", "c1", { wants: true })
      const unknown = yield* make({ known: new Set() })
      for (let i = 0; i < 20; i++) yield* unknown.change("nobody", "c9", { wants: true })
      const ours = logged.filter((l) => l.startsWith("Media:"))
      assert.strictEqual(ours.filter((l) => l.includes("no Spotify token")).length, 1)
      assert.strictEqual(ours.filter((l) => l.includes("was not given one")).length, 1)
      assert.isFalse(logged.some((l) => l.includes("SECRET-TOKEN")))
      // A minute on, it may be said again.
      signedOut.clock.now += 61_000
      yield* signedOut.change("kitchen-display", "c1", { wants: true })
      assert.strictEqual(logged.filter((l) => l.includes("no Spotify token")).length, 2)
    }), logged)
  })
})

describe("every tab is prepared again after a sign-in change", () => {
  it.live("`prepareAll` reaches each connection of a device, not one per device", () =>
    run(Effect.gen(function*() {
      const w = yield* make({ known: new Set(["kitchen-display"]), signedIn: false, videos: true })
      yield* w.change("kitchen-display", "c1")
      yield* w.change("kitchen-display", "c2", { chosen: "c1" })
      assert.deepStrictEqual(prepares(w.sent).map((s) => s.connection).sort(), ["c1", "c2"])
      w.spotify.signedIn = true
      yield* w.pages.prepareAll
      const again = prepares(w.sent).filter((s) => JSON.stringify(s.command.sources).includes("spotify"))
      assert.deepStrictEqual(again.map((s) => s.connection).sort(), ["c1", "c2"])
    })))
})
