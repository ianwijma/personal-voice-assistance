// The main thread is never held long while a room is resolved (docs/MODULES.md §15): at the largest cache the
// `HomeAssistant` contract allows (500 areas and 5,000 entities, all media players, each with 20 aliases of 200
// characters), every area and every player is compared, in steps with a yield to the event loop between them. Each run
// gets a cache of new objects, so nothing remembered from an earlier run helps it (a poll brings new objects too). A
// 1 ms heartbeat measures the longest stop; it must stay under 10 ms (three times that on CI).
import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { Playback } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { HA_LIMITS } from "@pva/module-contracts"
import { Effect, Fiber } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { musicModule } from "../src/index.ts"
import { area, at, KITCHEN, makeHa, player } from "./helpers.ts"

// Each test starts one or more test households with the real host.
vi.setConfig({ testTimeout: 60_000 })

/** Starts a 1 ms heartbeat; `stop` answers the longest gap between two beats, in ms. */
const heartbeat = () =>
  Effect.sync(() => {
    let last = performance.now()
    let longest = 0
    const timer = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 1)
    return {
      stop: Effect.promise(() =>
        new Promise<number>((resolve) =>
          setTimeout(() => {
            clearInterval(timer)
            resolve(longest)
          }, 5)
        )
      )
    }
  })

const measured = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
    const beat = yield* heartbeat()
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 3)))
    const began = performance.now()
    const result = yield* effect
    const took = performance.now() - began
    return { result, took, longest: yield* beat.stop }
  })

/** Aliases as long as the provider keeps them (`nameChars`), accented, so the comparison does its full work. */
const longName = (stem: string, n: number) => `${stem} ${n} Ångström ${"é".repeat(HA_LIMITS.nameChars - stem.length - 20)}`.slice(0, HA_LIMITS.nameChars)
const aliases = (stem: string, extra: ReadonlyArray<string>) => [...extra, ...Array.from({ length: HA_LIMITS.aliases - extra.length }, (_, i) => longName(`${stem} alias`, i))]

/** A cache at the contract's bounds, of new objects; `everywhere` gives every player the alias "Everywhere". */
const largest = (everywhere = false) => ({
  areas: Array.from({ length: HA_LIMITS.areas }, (_, i) => area(`area_${i}`, `Area ${i}`, aliases(`Area ${i}`, []))),
  entities: Array.from({ length: HA_LIMITS.entities }, (_, i) =>
    player(`media_player.p_${String(i).padStart(4, "0")}`, { name: `Player ${i}`, aliases: aliases(`Player ${i}`, everywhere ? ["Everywhere"] : []), areaId: `area_${i % 500}` })
  )
})

describe("@pva/module-music: resolving a room at the largest cache", () => {
  it.effect("every area and every player compared, cold, for a name that matches nothing and for the last player: the main thread held under 10 ms", () =>
    Effect.gen(function*() {
      const ha = makeHa(largest())
      const kit = yield* startTestModule(musicModule, { provide: [ha.provided] })
      // Warm the code paths, as a running server is.
      yield* kit.action("pause", { where: "nowhere at all" }, at("kitchen-display"))
      let worst = 0
      let slowest = 0
      for (
        const [where, said] of [
          ["nowhere at all", "I don't know a room or player called nowhere at all."],
          ["nowhere at all", "I don't know a room or player called nowhere at all."],
          // The last of 5,000 players, by name: found, because none is left out.
          ["Player 4999", "Asked Player 4999 to pause."]
        ] as const
      ) {
        const fresh = largest()
        ha.world.areas = fresh.areas
        ha.world.entities = new Map(fresh.entities.map((e) => [e.entityId, e]))
        const { result, longest, took } = yield* measured(kit.action("pause", { where }, at("kitchen-display")))
        assert.deepStrictEqual(result, { ok: true, say: said })
        worst = Math.max(worst, longest)
        slowest = Math.max(slowest, took)
      }
      console.log(`music: resolving cold at the largest cache: longest main-thread stop ${worst.toFixed(2)} ms, whole answer at most ${slowest.toFixed(0)} ms`)
      assert.isBelow(worst, bound(10))
      // An exact id is looked up directly, wherever it is.
      assert.deepStrictEqual(yield* kit.action("pause", { where: "media_player.p_4998" }, at("kitchen-display")), { ok: true, say: "Asked Player 4998 to pause." })
      assert.deepStrictEqual(ha.calls.map((c) => c.target.entityIds[0]), ["media_player.p_4999", "media_player.p_4998"])
    }))

  it.effect("a name all 5,000 players carry: a short question with the count, the main thread held under 10 ms", () =>
    Effect.gen(function*() {
      const ha = makeHa(largest(true))
      const kit = yield* startTestModule(musicModule, { provide: [ha.provided] })
      const { result, longest, took } = yield* measured(kit.action("pause", { where: "everywhere" }, at("kitchen-display")))
      console.log(`music: a 5,000-player question at the largest cache: longest main-thread stop ${longest.toFixed(2)} ms, whole answer ${took.toFixed(0)} ms`)
      assert.deepStrictEqual(result, { ok: true, say: "everywhere has 5000 players, among them Player 0, Player 1 and Player 2. Which one?" })
      assert.isBelow(longest, bound(10))
      assert.strictEqual(ha.calls.length, 0)
    }))

  describe("Playback has one 3 s budget from entry: resolving spends from it, the call gets what is left", () => {
    /** Waits in real time until `done()` (the call has gone out), at most 20 s. */
    const until = (done: () => boolean) =>
      Effect.promise(async () => {
        const end = Date.now() + 20_000
        while (!done() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5))
      })

    /** The largest cache, cold, with the last player playing and named `name`, and a provider that answers in 2.6 s (within its own limit). */
    const slowHouse = (name: string) => {
      const cache = largest()
      const last = cache.entities.length - 1
      cache.entities[last] = { ...cache.entities[last]!, name, aliases: [], state: "playing" }
      const ha = makeHa(cache)
      ha.answer(() => Effect.as(Effect.sleep(2_600), {}))
      return ha
    }

    it.effect("pause and changeVolume, called directly: after a cold search the call gets only what is left, and runs out as timeout", () =>
      Effect.gen(function*() {
        for (const op of ["pause", "changeVolume"] as const) {
          const ha = slowHouse("Last speaker")
          const kit = yield* startTestModule(musicModule, { provide: [ha.provided] })
          const playback = kit.service(Playback)!
          const began = performance.now()
          const fiber = yield* Effect.forkChild(Effect.flip<unknown, import("@pva/core").PlaybackError, never>(op === "pause" ? playback.pause("Last speaker") : playback.changeVolume("Last speaker", { to: 0.4 })))
          yield* until(() => ha.calls.length === 1)
          const searched = performance.now() - began
          // The provider would answer at 2.6 s: within its own limit, but not within what is left of 3 s.
          yield* kit.advance(2_600)
          const e = yield* Fiber.join(fiber)
          console.log(`music: Playback.${op} after a ${searched.toFixed(0)} ms cold search: ${e.reason}`)
          assert.isAbove(searched, 300)
          assert.strictEqual(e.reason, "timeout")
          assert.strictEqual(ha.calls.length, 1)
        }
      }))

    it.effect("through the host's stop: the pause times out inside the host's 3 s, so stop says it could not stop it rather than running past", () =>
      Effect.gen(function*() {
        // The kitchen display's room is Kitchen; no area of that name: the room is found only as the last player's name.
        const ha = slowHouse("Kitchen")
        const kit = yield* startTestModule(musicModule, { provide: [ha.provided] })
        const fiber = yield* Effect.forkChild(kit.phrases.say("stop", KITCHEN))
        yield* until(() => ha.calls.length === 1)
        yield* kit.advance(2_600)
        const stop = yield* Fiber.join(fiber)
        assert.isTrue(stop.taken && stop.by === "control" && stop.outcome.did === "failed", JSON.stringify(stop))
        assert.strictEqual(ha.calls.length, 1)
      }))

    it.effect("resolving that uses the whole budget is timeout, and nothing is sent", () =>
      Effect.gen(function*() {
        const ha = makeHa({ areas: [], entities: [player("media_player.slow", { name: "Slow speaker", state: "playing" })] })
        const all = [...ha.world.entities.values()]
        // A provider whose cache read holds the thread for 3.1 s (as an overloaded machine would).
        ha.stub.answer("entities", () => {
          const end = performance.now() + 3_100
          while (performance.now() < end) {
            // busy
          }
          return all
        })
        const kit = yield* startTestModule(musicModule, { provide: [ha.provided] })
        const e = yield* Effect.flip(kit.service(Playback)!.pause("Slow speaker"))
        assert.strictEqual(e.reason, "timeout")
        const v = yield* Effect.flip(kit.service(Playback)!.changeVolume("Slow speaker", { to: 0.4 }))
        assert.strictEqual(v.reason, "timeout")
        assert.strictEqual(ha.calls.length, 0)
      }))
  })
})
