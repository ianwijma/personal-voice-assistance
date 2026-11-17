// Review round 5 of PR 90 (core): presses answered at the grace period whatever another instance's cleanup takes
// (5A-6), and the other host-side fixes of this round.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { defineModule } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

describe("press stop across instances (5A-6)", () => {
  it.effect("two instances, the first with a two-second finaliser: the second instance's press is answered not_running right after the grace period", () =>
    Effect.gen(function*() {
      const closes: Array<string> = []
      const presser = defineModule({
        id: "presser",
        name: "Presser",
        description: "Two instances",
        settings: {
          format: Setting.choice({ label: "Format", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "a", overridable: true }),
          place: Setting.text({ label: "Place", default: "here" }),
          go: Setting.action({ label: "Go", buttonLabel: "Go" })
        },
        start: ({ settings }) =>
          Effect.gen(function*() {
            // The own-value instance (first in the run) takes two seconds to clean up (its first run only, so the
            // test's own shutdown is quick).
            const slow = settings.format === "b" && !closes.includes("b")
            if (settings.format === "b") yield* Effect.addFinalizer(() => Effect.andThen(Effect.sleep(slow ? 2_000 : 0), Effect.sync(() => closes.push("b"))))
            else yield* Effect.addFinalizer(() => Effect.sync(() => closes.push("a")))
            return { fieldActions: { go: () => Effect.as(Effect.never, { ok: true, text: "never" }) } }
          })
      })
      const demand: Array<ModuleDemand> = [{ assistantId: "own", own: { format: "b" } }, { assistantId: "plain" }]
      const host = yield* makeModuleHost({
        catalog: [presser],
        persistence: readOnlyPersistence({ modules: { presser: { settings: {} } }, secrets: {} }),
        env: {},
        demand: () => new Map([["presser", demand]]),
        graceMs: 100,
        stopTimeoutMs: 5_000
      })
      yield* host.startEnabled
      assert.deepStrictEqual(host.modules()[0]!.instances?.map((i) => i.own), [["format"], []])
      // The button belongs to the main (no-own) instance, the second in the run.
      const press = yield* Effect.forkChild(host.fieldAction("presser", "go"))
      yield* advance(10)
      assert.isUndefined(press.pollUnsafe())
      // A shared setting changes: the module restarts.
      const saved = yield* Effect.forkChild(host.configure("presser", { values: { place: "there" }, secrets: {} }))
      yield* advance(50)
      assert.isUndefined(press.pollUnsafe(), "still in the grace period")
      yield* advance(60)
      assert.deepStrictEqual(press.pollUnsafe() === undefined ? "still waiting" : yield* Fiber.join(press), { ok: false, code: "not_running", message: "Presser is not running" })
      assert.deepStrictEqual(closes, [], "the first instance is still cleaning up")
      yield* advance(2_100)
      assert.deepStrictEqual(closes, ["b", "a"])
      assert.isTrue((yield* Fiber.join(saved)).ok)
    }))
})
