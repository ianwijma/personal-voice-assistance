import { assert, describe, it } from "@effect/vitest"
import { makeToolRegistry, resolveSettings } from "@pva/core"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { clockModule, makeClock } from "../src/clock.ts"

describe("clock module", () => {
  const registry = makeToolRegistry([makeClock({ timeZone: "Europe/Amsterdam", locale: "en-GB" })])
  const at = Date.UTC(2026, 10, 13, 10, 45, 30) // 11:45:30 in Amsterdam

  it.effect("provides local date, time and zone as context", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(at)
      assert.strictEqual(
        yield* registry.context,
        "## Clock\nIt is Friday, 13 November 2026, 11:45 local time (Europe/Amsterdam)."
      )
    }))

  it.effect("tool returns the time in the requested zone", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(at)
      const result = yield* registry.run({ id: "1", name: "current_time", input: { timeZone: "Asia/Tokyo" } })
      assert.isFalse(result.isError)
      assert.deepStrictEqual(JSON.parse(result.content), {
        timeZone: "Asia/Tokyo",
        date: "Friday, 13 November 2026",
        time: "19:45",
        iso: "2026-11-13T19:45:30.000+09:00"
      })
      assert.isTrue(registry.isSpeculative("current_time"))
    }))

  it.effect("unknown zones and bad input are errors for the model", () =>
    Effect.gen(function*() {
      const unknown = yield* registry.run({ id: "2", name: "current_time", input: { timeZone: "Mars/Olympus" } })
      assert.deepStrictEqual([unknown.isError, unknown.content], [true, "Unknown time zone \"Mars/Olympus\""])
      const invalid = yield* registry.run({ id: "3", name: "current_time", input: {} })
      assert.isTrue(invalid.isError)
    }))

  it("exposes a JSON Schema for the tool input", () => {
    const [spec] = registry.specs
    assert.deepStrictEqual(spec!.inputSchema.required, ["timeZone"])
    assert.strictEqual((spec!.inputSchema.properties as any).timeZone.description, "IANA time zone name")
  })
})

describe("clock module definition", () => {
  it.effect("starts with typed settings and validates the time zone", () =>
    Effect.gen(function*() {
      const bad = resolveSettings(clockModule.settings, { stored: { timeZone: "Mars/Olympus" }, secrets: {}, env: {} })
      assert.deepStrictEqual(bad.form.errors, [{ key: "timeZone", message: "The saved value is not valid (Unknown time zone); save a new one" }])
      const ok = resolveSettings(clockModule.settings, { stored: { locale: "en-US" }, secrets: {}, env: { CLOCK_TIME_ZONE: "Asia/Tokyo" } })
      assert.deepStrictEqual(ok.value, { timeZone: "Asia/Tokyo", locale: "en-US" })
      yield* TestClock.setTime(Date.UTC(2026, 10, 13, 10, 45, 30))
      const instance = yield* Effect.scoped(clockModule.start({ settings: ok.value!, setStatus: () => {} }))
      const registry = makeToolRegistry([{ name: "clock", ...instance }])
      assert.strictEqual(yield* registry.context, "## Clock\nIt is Friday, November 13, 2026, 7:45 PM local time (Asia/Tokyo).")
    }))
})
