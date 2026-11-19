// system-status through the real host: what the host's own view says, and what each kind of device is told.
import { assert, describe, it } from "@effect/vitest"
import { Devices, type HostView, type ModuleContextV2 } from "@pva/core"
import { checkModule, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { problemsOf, systemStatusModule, texts } from "../src/systemStatus.ts"

const nl = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }

/** Distinctive words of the failing house: none of them may reach a device that is not told details. */
const SECRET_REASON = "token sk-live-4242 refused by 192.168.1.77 for robin@example.org"
/**
 * The real module, with the host's view replaced by a house in trouble: four modules failing (with error text that
 * holds a key, an address and a person's mail), the vault locked and the engines failed. `devices`: the `Devices`
 * service as the host has it, missing, or one that knows no device (a device removed since the turn began).
 */
const troubled = (devices: "host" | "missing" | "unknown" = "host"): typeof systemStatusModule => ({
  ...systemStatusModule,
  start: (given) => {
    const ctx = given as unknown as ModuleContextV2<{}>
    return systemStatusModule.start({
      ...ctx,
      host: {
        ...ctx.host,
        view: (): HostView => ({
          ...ctx.host.view(),
          vaultLocked: true,
          engine: { ready: false, state: "failed", voices: [] },
          modules: [
            { id: "weather", name: "Weather", kind: "capability", state: "error", unavailable: SECRET_REASON },
            { id: "lists", name: "Lists", kind: "capability", state: "unavailable", unavailable: SECRET_REASON },
            { id: "news", name: "News", kind: "capability", state: "error", unavailable: SECRET_REASON },
            { id: "music", name: "Music", kind: "capability", state: "error" },
            { id: "clock", name: "Clock", kind: "capability", state: "running" }
          ]
        }),
        service: ((key: unknown) =>
          key === Devices && devices === "missing" ? undefined
            : key === Devices && devices === "unknown" ? { list: () => [], get: () => undefined, otherScreens: () => [], bestOtherScreen: () => undefined }
            : ctx.host.service(key as never)) as typeof ctx.host.service
      }
    } as never)
  }
})
const DISTINCTIVE = [/sk-live/, /192\.168/, /robin@/, /Robin/, /Weather|Lists|News|Music/, /vault|kluis/i, /engine|motor/i, /\d/]

describe("system-status", () => {
  it.effect("passes the conformance check, with its texts in both languages", () => checkModule(systemStatusModule, { texts }))

  it.effect("says whether things are fine, to a shared and a private device (only a private one hears whose devices), and reads nothing but the host's view", () =>
    Effect.gen(function*() {
      const s = yield* startTestModule(systemStatusModule)
      const kitchen = (yield* s.tool("system_status", {}, { device: "kitchen-display" })).value as any
      // The kit's host: this module and nothing else, the vault open, no engines (the CLI view), the household's three devices connected.
      assert.deepStrictEqual({ fine: kitchen.fine, spoken: kitchen.spoken, problems: kitchen.problems }, {
        fine: true,
        spoken: "Everything is running: 1 modules. 3 devices are connected.",
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
      assert.strictEqual(((yield* s.tool("system_status", {}, { device: "robins-phone" })).value as any).spoken, "Alles werkt: 1 modules. Verbonden apparaten: Kitchen display, Robin's phone en Hall screen.")
      assert.deepStrictEqual(yield* s.action("status", {}, { device: "kitchen-display" }), { ok: true, say: "Alles werkt: 1 modules. 3 apparaten zijn verbonden." })
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

  it.effect("a house in trouble: a public device (also one with a default person), an unknown device and no Devices hear one sentence, nothing named", () =>
    Effect.gen(function*() {
      const told = { spoken: "There is a problem. Check the settings page.", fine: false }
      const check = (value: unknown, where: string) => {
        assert.deepStrictEqual(value, told, where)
        for (const word of DISTINCTIVE) assert.notMatch(JSON.stringify(value), word, where)
      }
      // The default household's public hall screen, and a public screen whose default person is Robin.
      const household = {
        devices: [
          { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public" as const, defaultPerson: null },
          { id: "lobby-screen", name: "Robin's lobby screen", room: "Hall", privacy: "public" as const, defaultPerson: "p-robin" },
          { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-robin" }
        ]
      }
      const s = yield* startTestModule(troubled(), { household })
      for (const device of ["hall-screen", "lobby-screen"]) {
        for (const about of [undefined, "all", "modules", "devices"]) {
          check((yield* s.tool("system_status", about === undefined ? {} : { about }, { device })).value, `${device} ${about}`)
        }
        const action = yield* s.action("status", {}, { device })
        assert.deepStrictEqual(action, { ok: true, say: told.spoken }, device)
      }
      // A device the host no longer knows, and a host with no Devices service: the same.
      for (const devices of ["unknown", "missing"] as const) {
        const other = yield* startTestModule(troubled(devices), { household })
        check((yield* other.tool("system_status", {}, { device: "robins-phone" })).value, devices)
        assert.deepStrictEqual(yield* other.action("status", {}, { device: "robins-phone" }), { ok: true, say: told.spoken }, devices)
      }
      const dutch = yield* startTestModule(troubled(), { household: { ...household, ...nl.household } })
      assert.deepStrictEqual((yield* dutch.tool("system_status", {}, { device: "hall-screen" })).value, { spoken: "Er is een probleem. Kijk op de instellingenpagina.", fine: false })
    }))

  it.effect("a house in trouble on a private device: at most three problems, worst first, by name and state only", () =>
    Effect.gen(function*() {
      const s = yield* startTestModule(troubled())
      const r = (yield* s.tool("system_status", {}, { device: "robins-phone" })).value as any
      assert.deepStrictEqual(Object.keys(r).sort(), ["connectedDevices", "fine", "problems", "running", "spoken"])
      assert.deepStrictEqual(r.problems, [{ kind: "vault" }, { kind: "engine", state: "failed" }, { kind: "module", state: "error", name: "Weather" }])
      assert.strictEqual(
        r.spoken,
        "The key vault is locked, so modules that need a key are waiting for you to unlock it in Settings. The speech engines are stopped with an error. Weather has stopped with an error. And 3 more. " +
          "Connected devices: Kitchen display, Robin's phone and Hall screen."
      )
      // Nothing of a module's error text, on any path.
      const action = yield* s.action("status", {}, { device: "robins-phone" })
      for (const value of [r, action]) for (const word of [/sk-live/, /192\.168/, /robin@/, /refused/]) assert.notMatch(JSON.stringify(value), word)
      assert.deepStrictEqual(action, { ok: true, say: r.spoken })
      // A shared device hears the problems, and how many devices are connected, not whose they are.
      const kitchen = (yield* s.tool("system_status", {}, { device: "kitchen-display" })).value as any
      assert.strictEqual(kitchen.spoken, "The key vault is locked, so modules that need a key are waiting for you to unlock it in Settings. The speech engines are stopped with an error. Weather has stopped with an error. And 3 more. 3 devices are connected.")
      assert.notMatch(JSON.stringify(kitchen), /Robin/)
      // In Dutch, the engines' state too.
      const dutch = yield* startTestModule(troubled(), nl)
      assert.strictEqual(
        ((yield* dutch.tool("system_status", { about: "modules" }, { device: "robins-phone" })).value as any).spoken,
        "De sleutelkluis is op slot, dus modules die een sleutel nodig hebben wachten tot je hem ontgrendelt in de instellingen. De spraakmotoren zijn gestopt met een fout. Weather is gestopt met een fout. En nog 3."
      )
    }))

  it("names what is wrong, worst first, from a view (vault, engines, modules), and never their error text", () => {
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
    assert.deepStrictEqual(problemsOf(view as any), [{ kind: "vault" }, { kind: "engine", state: "starting" }, { kind: "module", state: "error", name: "Weather" }, { kind: "module", state: "unavailable", name: "Lists" }])
  })
})
