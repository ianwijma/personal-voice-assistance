// system-status through the real host: what the host's own view says, and what each kind of device is told.
import { assert, describe, it } from "@effect/vitest"
import { checkModule, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { problemsOf, systemStatusModule, texts } from "../src/systemStatus.ts"

const nl = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }

describe("system-status", () => {
  it.effect("passes the conformance check, with its texts in both languages", () => checkModule(systemStatusModule, { texts }))

  it.effect("says whether things are fine, to a shared and a private device, and reads nothing but the host's view", () =>
    Effect.gen(function*() {
      const s = yield* startTestModule(systemStatusModule)
      const kitchen = (yield* s.tool("system_status", {}, { device: "kitchen-display" })).value as any
      // The kit's host: this module and nothing else, the vault open, no engines (the CLI view), the household's three devices connected.
      assert.deepStrictEqual({ fine: kitchen.fine, spoken: kitchen.spoken, problems: kitchen.problems }, {
        fine: true,
        spoken: "Everything is running: 1 modules. Connected devices: Kitchen display, Robin's phone and Hall screen.",
        problems: []
      })
      const phone = (yield* s.tool("system_status", { about: "modules" }, { device: "robins-phone" })).value as any
      assert.strictEqual(phone.spoken, "1 modules are running.")
      const devices = (yield* s.tool("system_status", { about: "devices" }, { device: "robins-phone" })).value as any
      assert.strictEqual(devices.spoken, "Connected devices: Kitchen display, Robin's phone and Hall screen.")
      assert.isFalse((yield* s.tool("system_status", { about: "weather" })).ok)
      // It is a plain read: no tool changes anything, and nothing was stored.
      assert.deepStrictEqual(s.toolNames(), ["system_status"])
    }))

  it.effect("speaks in Dutch", () =>
    Effect.gen(function*() {
      const s = yield* startTestModule(systemStatusModule, nl)
      assert.strictEqual(((yield* s.tool("system_status", {}, { device: "kitchen-display" })).value as any).spoken, "Alles werkt: 1 modules. Verbonden apparaten: Kitchen display, Robin's phone en Hall screen.")
      assert.deepStrictEqual(yield* s.action("status", {}, { device: "kitchen-display" }), { ok: true, say: "Alles werkt: 1 modules. Verbonden apparaten: Kitchen display, Robin's phone en Hall screen." })
    }))

  it.effect("a public screen, and a device nobody knows, hear only whether it is fine", () =>
    Effect.gen(function*() {
      const s = yield* startTestModule(systemStatusModule)
      const hall = (yield* s.tool("system_status", {}, { device: "hall-screen" })).value as any
      assert.deepStrictEqual(hall, { spoken: "Everything is running.", fine: true })
      assert.deepStrictEqual(yield* s.action("status", {}, { device: "hall-screen" }), { ok: true, say: "Everything is running." })
      const dutchHall = yield* startTestModule(systemStatusModule, nl)
      assert.strictEqual(((yield* dutchHall.tool("system_status", {}, { device: "hall-screen" })).value as any).spoken, "Alles werkt.")
    }))

  it("names what is wrong, worst first, from a view (vault, engines, modules), and counts the rest", () => {
    const view = {
      modules: [
        { id: "a", name: "Weather", kind: "capability", state: "error", unavailable: "no key" },
        { id: "b", name: "Lists", kind: "capability", state: "unavailable", unavailable: "needs a newer app" },
        { id: "c", name: "Clock", kind: "capability", state: "running" },
        { id: "d", name: "News", kind: "capability", state: "disabled" }
      ],
      vaultLocked: true,
      engine: { ready: false, state: "starting", voices: [] },
      devices: [],
      home: {}
    } as const
    assert.deepStrictEqual(problemsOf(view as any).map((p) => p.kind + (p.name ?? "")), ["vault", "engine", "moduleWeather", "moduleLists"])
  })
})
