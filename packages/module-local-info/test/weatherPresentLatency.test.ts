// Latency: a forecast answer with its card costs the turn nothing it should notice. The tool's result goes through the host's
// registry and gateway as in the app, the card is validated and handed to the Presenter in one enqueue (docs/PRESENTING.md,
// "Latency"); the answer's own work (the forecast, here served from the cache of the first call) is the same as before.
import { assert, describe, it } from "@effect/vitest"
import { makeOfflineNet, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { weatherModule } from "../../modules-builtin/src/weather.ts"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { FORECAST, forecast, GEOCODE, geocoding, json, utrecht } from "./weatherFixtures.ts"

describe("the forecast with its card: latency", () => {
  it.effect("thirty answers with a card, each replacing the last: each holds the main thread under 10 ms", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({ [GEOCODE]: geocoding([utrecht]), [FORECAST]: { body: forecast(), headers: json } })
      const kit = yield* startTestModule(weatherModule({ resolver: net.resolver, connector: net.connector }))
      // The first answer pays the process's one-time costs (the time-zone formatters, the fetch); the app has paid them by then.
      for (const day of ["tomorrow", "today", "Friday"]) assert.match((yield* kit.tool("weather_forecast", { day })).content, /\[Screen: Showing on/)
      yield* kit.present.settle
      let last = performance.now()
      let worst = 0
      const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
      }, 1)
      const days = ["today", "tomorrow", "Friday"]
      const took: Array<number> = []
      yield* Effect.gen(function*() {
        for (let i = 0; i < 30; i++) {
          const at = performance.now()
          const r = yield* kit.tool("weather_forecast", { day: days[i % 3]! })
          took.push(performance.now() - at)
          assert.isTrue(r.ok)
          // Back to the event loop between turns, as the app is: the timer above then sees each call's own stop.
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 2)))
        }
      }).pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))))
      worst = Math.max(worst, performance.now() - last)
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      const median = [...took].sort((a, b) => a - b)[15]!
      console.log(`[weatherPresent] 30 forecast answers with a card: median ${median.toFixed(2)} ms, longest main-thread stop ${worst.toFixed(1)} ms`)
      assert.isBelow(worst, bound(10))
      assert.isBelow(Math.max(...took), bound(10))
      assert.isBelow(median, bound(5))
    }), 30_000)
})
