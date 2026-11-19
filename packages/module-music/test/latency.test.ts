// The main thread is never held long while a room is resolved (docs/MODULES.md §15): at the largest cache the
// `HomeAssistant` contract allows (500 areas and 5,000 entities, each with 20 aliases of 200 characters), a name that
// matches nothing is compared with every area and the first 200 media players, in steps with a yield to the event loop
// between them. A 1 ms heartbeat measures the longest stop; it must stay under 10 ms (three times that on CI).
import { assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import { startTestModule } from "@pva/core/testing"
import { HA_LIMITS } from "@pva/module-contracts"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { MAX_PLAYERS, musicModule } from "../src/index.ts"
import { area, KITCHEN, makeHa, player } from "./helpers.ts"

// Each test starts one or more test households with the real host.
vi.setConfig({ testTimeout: 30_000 })

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
    const result = yield* effect
    return { result, longest: yield* beat.stop }
  })

/** Aliases as long as the provider keeps them (`nameChars`), accented, so the comparison does its full work. */
const longName = (stem: string, n: number) => `${stem} ${n} Ångström ${"é".repeat(HA_LIMITS.nameChars - stem.length - 20)}`.slice(0, HA_LIMITS.nameChars)
const aliases = (stem: string) => Array.from({ length: HA_LIMITS.aliases }, (_, i) => longName(`${stem} alias`, i))

describe("@pva/module-music: resolving a room at the largest cache", () => {
  it.effect("a name that matches nothing, compared with 500 areas and 200 players of 20 aliases each: the main thread held under 10 ms", () =>
    Effect.gen(function*() {
      const areas = Array.from({ length: HA_LIMITS.areas }, (_, i) => area(`area_${i}`, `Area ${i}`, aliases(`Area ${i}`)))
      const entities = Array.from({ length: HA_LIMITS.entities }, (_, i) =>
        player(`media_player.p_${String(i).padStart(4, "0")}`, { name: `Player ${i}`, aliases: aliases(`Player ${i}`), areaId: `area_${i % 500}` })
      )
      const ha = makeHa({ areas, entities })
      const kit = yield* startTestModule(musicModule, { provide: [ha.provided] })
      // Warm, as a running server is.
      yield* kit.action("pause", { where: "nowhere at all" }, KITCHEN)
      let worst = 0
      let slowest = 0
      for (let run = 0; run < 3; run++) {
        const began = performance.now()
        const { result, longest } = yield* measured(kit.action("pause", { where: "nowhere at all" }, KITCHEN))
        slowest = Math.max(slowest, performance.now() - began - 8)
        assert.deepStrictEqual(result, { ok: true, say: "I don't know a room or player called nowhere at all." })
        worst = Math.max(worst, longest)
      }
      console.log(`music: resolving at the largest cache: longest main-thread stop ${worst.toFixed(2)} ms, whole answer at most ${slowest.toFixed(0)} ms`)
      assert.isBelow(worst, bound(10))
      assert.strictEqual(ha.calls.length, 0)
      // A player past the first 200 is not compared by name; one within them is.
      assert.deepStrictEqual(yield* kit.action("pause", { where: `Player ${MAX_PLAYERS - 1}` }, KITCHEN), { ok: true, say: `Paused Player ${MAX_PLAYERS - 1}.` })
      assert.deepStrictEqual(yield* kit.action("pause", { where: `Player ${MAX_PLAYERS}` }, KITCHEN), { ok: true, say: `I don't know a room or player called Player ${MAX_PLAYERS}.` })
    }), 30_000)
})
