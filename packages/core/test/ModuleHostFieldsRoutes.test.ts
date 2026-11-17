// P3 in the module host (docs/MODULES-PLAN.md §4 P3): field actions (definition and instance handlers, saved vs draft
// settings, timeout, double press, not running), `info` values and `combo` options on the described form, the
// generated agent Test button, and module routes: checked at start, live while the shared part runs, gone when it stops.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { defineAgent } from "../src/ModuleContributions.ts"
import { defineModule, type ModuleDefinition } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import type { ModuleRoute } from "../src/ModuleRoutes.ts"
import { Setting } from "../src/Settings.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const hostOf = (catalog: ReadonlyArray<ModuleDefinition<any>>, stored: Record<string, Record<string, unknown>> = {}) =>
  makeModuleHost({
    catalog,
    persistence: readOnlyPersistence({ modules: Object.fromEntries(Object.entries(stored).map(([id, settings]) => [id, { enabled: true, settings }])), secrets: {} }),
    env: {}
  })

const house = (probe: { pressed: Array<unknown>; options: Array<{ value: string; label: string }>; info: string }) =>
  defineModule({
    id: "house",
    name: "House",
    description: "A house",
    settings: {
      address: Setting.text({ label: "Address", default: "here" }),
      scene: Setting.combo({ label: "Scene", default: "Cosy", options: [{ value: "Cosy", label: "Cosy" }] }),
      state: Setting.info({ label: "Now" }),
      check: Setting.action({ label: "Check", buttonLabel: "Check", requiresSaved: false }),
      allOff: Setting.action({ label: "All off", buttonLabel: "All off" }),
      slow: Setting.action({ label: "Slow", buttonLabel: "Slow" })
    },
    fieldActions: {
      check: ({ settings, draft }) =>
        Effect.sync(() => {
          probe.pressed.push({ address: settings.address, draft })
          return { ok: settings.address !== "", text: `Checked ${settings.address}` }
        })
    },
    start: () =>
      Effect.succeed({
        info: () => ({ state: probe.info }),
        settingOptions: () => ({ scene: probe.options }),
        fieldActions: {
          allOff: () => Effect.succeed({ ok: true, text: "All off", tone: "ok" as const }),
          slow: () => Effect.as(Effect.sleep(60_000), { ok: true, text: "late" })
        }
      })
  })

describe("field actions", () => {
  it.effect("run with the saved settings, or with the page's draft over them when the button allows it", () =>
    Effect.gen(function*() {
      const probe = { pressed: [] as Array<unknown>, options: [], info: "" }
      const host = yield* hostOf([house(probe)], { house: { address: "saved" } })
      yield* host.startEnabled
      assert.deepStrictEqual(yield* host.fieldAction("house", "check"), { ok: true, result: { ok: true, text: "Checked saved" } })
      // `check` does not need saved settings: the draft (with a value the field accepts) is applied.
      assert.deepStrictEqual(yield* host.fieldAction("house", "check", { address: "draft", state: "ignored", nope: 1 }), { ok: true, result: { ok: true, text: "Checked draft" } })
      assert.deepStrictEqual(probe.pressed, [{ address: "saved", draft: false }, { address: "draft", draft: true }])
      // A draft value the field refuses is the result, and the handler does not run.
      const refused = yield* host.fieldAction("house", "check", { address: 12 })
      assert.deepStrictEqual(refused, { ok: true, result: { ok: false, text: "Not tested: Address: Must be text", tone: "error" } })
      assert.strictEqual(probe.pressed.length, 2)
      // `allOff` needs saved settings: a draft is not used (and it is the running instance's handler).
      assert.deepStrictEqual(yield* host.fieldAction("house", "allOff", { address: "draft" }), { ok: true, result: { ok: true, text: "All off", tone: "ok" } })
    }))

  it.effect("a definition handler runs without an instance; an instance handler needs one", () =>
    Effect.gen(function*() {
      const probe = { pressed: [] as Array<unknown>, options: [], info: "" }
      const host = yield* hostOf([house(probe)])
      // Not started: the module is off.
      assert.deepStrictEqual(yield* host.fieldAction("house", "check"), { ok: true, result: { ok: true, text: "Checked here" } })
      assert.deepStrictEqual(yield* host.fieldAction("house", "allOff"), { ok: false, code: "not_running", message: "House is not running" })
      assert.deepStrictEqual(yield* host.fieldAction("house", "address"), { ok: false, code: "unknown_action", message: "House: \"address\" is not a button" })
      assert.deepStrictEqual(yield* host.fieldAction("house", "nothing"), { ok: false, code: "unknown_action", message: "House has no action \"nothing\"" })
      assert.deepStrictEqual(yield* host.fieldAction("nope", "check"), { ok: false, code: "unknown_module", message: "There is no module \"nope\"" })
    }))

  it.effect("has 8 s, and one press of a button at a time", () =>
    Effect.gen(function*() {
      const probe = { pressed: [] as Array<unknown>, options: [], info: "" }
      const host = yield* hostOf([house(probe)], { house: {} })
      yield* host.startEnabled
      const first = yield* Effect.forkChild(host.fieldAction("house", "slow"))
      yield* advance(10)
      assert.deepStrictEqual(yield* host.fieldAction("house", "slow"), { ok: false, code: "busy", message: "That button is still running" })
      // Another button is not held up.
      assert.strictEqual((yield* host.fieldAction("house", "allOff")).ok, true)
      yield* advance(8_000)
      assert.deepStrictEqual(yield* Fiber.join(first), { ok: true, result: { ok: false, text: "Did not finish within 8 s", tone: "error" } })
      // Free again afterwards.
      const again = yield* Effect.forkChild(host.fieldAction("house", "slow"))
      yield* advance(8_000)
      assert.strictEqual((yield* Fiber.join(again)).ok, true)
    }))

  it.effect("info values and combo options come from the running instance; a press announces the module again", () =>
    Effect.gen(function*() {
      const probe = { pressed: [] as Array<unknown>, options: [{ value: "Film night", label: "Film night" }, { value: "Cosy", label: "Cosy (theirs)" }], info: "2 lights on" }
      const host = yield* hostOf([house(probe)], { house: {} })
      const off = host.modules()[0]!.settings
      assert.strictEqual(off.values.state, "")
      const comboOff = off.fields.find((f) => f.key === "scene")
      assert.deepStrictEqual(comboOff?.type === "combo" && { options: comboOff.options, note: comboOff.optionsNote }, { options: [{ value: "Cosy", label: "Cosy" }], note: "Not running: type a name" })
      yield* host.startEnabled
      const on = host.modules()[0]!.settings
      assert.strictEqual(on.values.state, "2 lights on")
      const combo = on.fields.find((f) => f.key === "scene")
      assert.deepStrictEqual(combo?.type === "combo" && combo.options.map((o) => o.value), ["Cosy", "Film night"])
      assert.strictEqual(combo?.type === "combo" && combo.optionsNote, "2 suggestions from House")
      // After a press the page hears about the module again, with the new info value.
      const seen: Array<unknown> = []
      host.subscribe((m) => seen.push(m.settings.values.state))
      probe.info = "all off"
      yield* host.fieldAction("house", "allOff")
      assert.deepStrictEqual(seen, ["all off"])
    }))

  it.effect("an agent's form ends with the host's Test button", () =>
    Effect.gen(function*() {
      const agent = defineAgent({
        id: "echo",
        name: "Echo",
        description: "Echo",
        kind: "model",
        enabledByDefault: true,
        start: () => Effect.succeed({ turn: () => Stream.make({ _tag: "TextDelta" as const, text: "Hello there, friend." }) })
      })
      const host = yield* hostOf([agent])
      yield* host.startEnabled
      const fields = host.modules()[0]!.settings.fields
      assert.deepStrictEqual(fields.at(-1), {
        type: "action",
        key: "test",
        label: "Test",
        description: "Sends one short message and reports the first answer and how long it took.",
        apply: "live",
        buttonLabel: "Test",
        requiresSaved: true,
        source: "default"
      })
      const result = yield* host.fieldAction("echo", "test")
      assert.strictEqual(result.ok && result.result.ok, true)
    }))
})

const routesModule = (routes: ReadonlyArray<ModuleRoute>) =>
  defineModule({
    apiVersion: 2,
    id: "hooks",
    name: "Hooks",
    description: "Hooks",
    settings: { word: Setting.text({ label: "Word", default: "a" }) },
    shared: () => Effect.succeed({ value: undefined, routes }),
    start: () => Effect.succeed({})
  })

const ok: ModuleRoute["handler"] = () => Effect.succeed({ status: 200 })

describe("module routes in the host", () => {
  it.effect("are live while the shared part runs, described on the module, and gone when it stops", () =>
    Effect.gen(function*() {
      const route: ModuleRoute = { method: "POST", path: "hook/:name", guards: ["token", "lan"], token: "hook", handler: ok, description: "A hook" }
      const host = yield* hostOf([routesModule([route])], { hooks: {} })
      assert.deepStrictEqual(host.routes(), [])
      yield* host.startEnabled
      assert.deepStrictEqual(host.routes().map((r) => [r.moduleId, r.route.path]), [["hooks", "hook/:name"]])
      assert.deepStrictEqual(host.modules()[0]!.routes, [{
        method: "POST",
        path: "/api/modules/hooks/hook/:name",
        guards: ["token", "lan"],
        public: false,
        token: "hook",
        bodyLimitBytes: 8192,
        ratePerMinute: { perAddress: 30, total: 120 },
        description: "A hook"
      }])
      yield* host.disable("hooks")
      assert.deepStrictEqual(host.routes(), [])
      assert.strictEqual(host.modules()[0]!.routes, undefined)
    }))

  const refused = (routes: ReadonlyArray<ModuleRoute>) =>
    Effect.gen(function*() {
      const host = yield* hostOf([routesModule(routes)], { hooks: {} })
      yield* host.startEnabled
      assert.deepStrictEqual(host.routes(), [])
      return host.modules()[0]!.error ?? ""
    })

  it.effect("refuse at start a route without a guard unless it is public, and a public route that reads a body", () =>
    Effect.gen(function*() {
      assert.match(yield* refused([{ method: "GET", path: "x", handler: ok }]), /has no guard: declare its guards, or public: true/)
      assert.match(yield* refused([{ method: "POST", path: "cb", public: true, handler: ok }]), /may not read a body/)
      assert.match(yield* refused([{ method: "GET", path: "cb", public: true, guards: ["lan"], handler: ok }]), /public but declares guards/)
      assert.match(yield* refused([{ method: "GET", path: "x", guards: ["token"], handler: ok }]), /token guard needs a token name/)
      assert.match(yield* refused([{ method: "GET", path: "x", guards: ["admin", "token"], token: "t", handler: ok }]), /both the admin token and a route token/)
      assert.match(yield* refused([{ method: "GET", path: "/x", guards: ["lan"], handler: ok }]), /not valid/)
      assert.match(yield* refused([{ method: "GET", path: "a/:n", guards: ["lan"], handler: ok }, { method: "GET", path: "a/:m", guards: ["admin"], handler: ok }]), /declared twice/)
      assert.match(yield* refused([{ method: "POST", path: "x", guards: ["lan"], bodyLimitBytes: 2_000_000, handler: ok }]), /bodyLimitBytes must be 0 to 1048576/)
      assert.match(yield* refused([{ method: "GET", path: "x", guards: ["lan"], rateLimit: { perAddress: 0 }, handler: ok }]), /rate limits/)
      // A public GET without a body is fine (an OAuth callback).
      const host = yield* hostOf([routesModule([{ method: "GET", path: "callback", public: true, handler: ok }])], { hooks: {} })
      yield* host.startEnabled
      assert.strictEqual(host.modules()[0]!.state, "running")
      assert.strictEqual(host.routes().length, 1)
    }))

  it.effect("give modules a token helper that says it is unavailable outside serve mode", () =>
    Effect.gen(function*() {
      let failure = ""
      const mod = defineModule({
        apiVersion: 2,
        id: "minter",
        name: "Minter",
        description: "Mints",
        shared: ({ host }) =>
          host.routeTokens.mint("hook", "x").pipe(
            Effect.match({ onFailure: (e) => void (failure = `${e.reason}: ${e.message}`), onSuccess: () => void (failure = "minted") }),
            Effect.as({ value: undefined })
          ),
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([mod], { minter: {} })
      yield* host.startEnabled
      assert.strictEqual(failure, "unavailable: Route tokens are kept by the server (serve mode) only")
    }))
})
