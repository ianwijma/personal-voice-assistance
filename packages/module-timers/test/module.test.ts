// The scaffold's test (docs/MODULES.md, "Testing"): the real module host accepts every module of the package, it is
// off for an installation that has not switched it on, and it passes the conformance check with its texts.
import { describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault } from "@pva/core/testing"
import { Effect } from "effect"
import { alarmsModule, alarmTexts, catalog, timersModule, timerTexts } from "../src/index.ts"

describe("@pva/module-timers", () => {
  it.effect("timers, alarms: accepted by the host, off by default, conformant", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault(catalog)
      yield* checkModule(timersModule, { texts: timerTexts })
      yield* checkModule(alarmsModule, { texts: alarmTexts })
    }))
})
