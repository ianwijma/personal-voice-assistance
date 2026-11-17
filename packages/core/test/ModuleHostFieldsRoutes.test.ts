// P3 in the module host (docs/MODULES-PLAN.md §4 P3): field actions (definition and instance handlers, saved vs draft
// settings, timeout, double press, not running), `info` values and `combo` options on the described form, the
// generated agent Test button, and module routes: checked at start, live while the shared part runs, gone when it stops.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Logger, Stream } from "effect"
import { TestClock } from "effect/testing"
import { defineAgent, type FieldActionHandler } from "../src/ModuleContributions.ts"
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
      assert.deepStrictEqual(refused, { ok: true, result: { ok: false, text: "Not run: Address: Must be text", tone: "error" } })
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
      // Free again once its interruption has run (in the background).
      yield* advance(0)
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
      assert.match(yield* refused([{ method: "POST", path: "cb", public: true, handler: ok }]), /must be a GET/)
      assert.match(yield* refused([{ method: "GET", path: "cb", public: true, body: "bytes", handler: ok }]), /may not read a body/)
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

// ---------------------------------------------------------------------------------------------------------------------
// Review round 1 (PR 90): deadlines that never wait for cleanup, secrets kept from the page, settings that do not
// resolve, closed combos, method receivers, and prototype-style keys.

const SECRET = "tok-0123456789-abcdef"

const keyed = (probe: { seen: Array<unknown> }) =>
  defineModule({
    id: "keyed",
    name: "Keyed",
    description: "Has a key",
    settings: {
      address: Setting.text({ label: "Address", default: "http://here" }),
      token: Setting.secret({ label: "Token", env: "KEYED_TOKEN", required: true }),
      tries: Setting.number({ label: "Tries", default: 1, integer: true, min: 1, max: 5 }),
      echo: Setting.action({ label: "Echo", buttonLabel: "Echo", requiresSaved: false }),
      boom: Setting.action({ label: "Boom", buttonLabel: "Boom" }),
      thrown: Setting.action({ label: "Thrown", buttonLabel: "Thrown" }),
      state: Setting.info({ label: "Now" })
    },
    fieldActions: {
      echo: ({ settings }) =>
        Effect.sync(() => {
          probe.seen.push({ address: settings.address, token: settings.token })
          return { ok: true, text: `Using ${settings.token} at ${settings.address}`, tone: "ok" as const }
        }),
      boom: ({ settings }) => Effect.fail(new Error(`bad credential ${settings.token}`)),
      thrown: ({ settings }) => {
        throw new Error(`defect with ${settings.token}`)
      }
    },
    start: () => Effect.succeed({ info: () => ({ state: `Signed in with ${SECRET}` }) })
  })

const keyedHost = (probe: { seen: Array<unknown> }, opts: { readonly stored?: Record<string, unknown>; readonly secrets?: Record<string, string>; readonly env?: Record<string, string> } = {}) =>
  makeModuleHost({
    catalog: [keyed(probe)],
    persistence: readOnlyPersistence({ modules: { keyed: { enabled: true, settings: opts.stored ?? {} } }, secrets: { keyed: opts.secrets ?? { token: SECRET } } }),
    env: opts.env ?? {}
  })

describe("field actions after review round 1", () => {
  const logs: Array<string> = []
  it.effect("answer at the deadline even when the handler's cleanup hangs; the button is free once cleanup ends or overruns", () =>
    Effect.gen(function*() {
      let cleaned = false
      const mod = defineModule({
        id: "stuck",
        name: "Stuck",
        description: "Hangs",
        settings: {
          hang: Setting.action({ label: "Hang", buttonLabel: "Hang" }),
          busyWork: Setting.action({ label: "Busy", buttonLabel: "Busy" })
        },
        fieldActions: {
          // A finalizer that takes a minute: the press is answered at 8 s all the same.
          hang: () => Effect.as(Effect.never.pipe(Effect.ensuring(Effect.sleep(60_000))), { ok: true, text: "never" }),
          // Uninterruptible work that ends after 12 s, then cleans up.
          busyWork: () =>
            Effect.uninterruptible(Effect.sleep(12_000)).pipe(Effect.ensuring(Effect.sync(() => void (cleaned = true))), Effect.as({ ok: true, text: "late" }))
        },
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([mod])
      const hung = yield* Effect.forkChild(host.fieldAction("stuck", "hang"))
      const busy = yield* Effect.forkChild(host.fieldAction("stuck", "busyWork"))
      yield* advance(8_000)
      assert.deepStrictEqual(yield* Fiber.join(hung), { ok: true, result: { ok: false, text: "Did not finish within 8 s", tone: "error" } })
      assert.deepStrictEqual(yield* Fiber.join(busy), { ok: true, result: { ok: false, text: "Did not finish within 8 s", tone: "error" } })
      // Still cleaning up: the same buttons are busy, and nothing was logged yet.
      assert.strictEqual((yield* host.fieldAction("stuck", "hang")).ok, false)
      assert.strictEqual((yield* host.fieldAction("stuck", "busyWork")).ok, false)
      yield* advance(4_000)
      // The uninterruptible one ended (12 s) and ran its finalizer: free again.
      assert.strictEqual(cleaned, true)
      const again = yield* Effect.forkChild(host.fieldAction("stuck", "busyWork"))
      yield* advance(8_000)
      assert.strictEqual((yield* Fiber.join(again)).ok, true)
      // The hung one overran its 10 s cleanup limit: logged, and the button is free.
      yield* advance(6_000)
      assert.isTrue(logs.some((l) => /field action stuck\.hang: still cleaning up 10000 ms after it was stopped/.test(l)))
      const third = yield* Effect.forkChild(host.fieldAction("stuck", "hang"))
      yield* advance(8_000)
      assert.deepStrictEqual(yield* Fiber.join(third), { ok: true, result: { ok: false, text: "Did not finish within 8 s", tone: "error" } })
      // Let the slow finalizers end, so the host shuts down at once.
      yield* advance(120_000)
    }).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))]))))

  it.effect("never send a saved or environment secret back: failures say a generic sentence, results are redacted", () =>
    Effect.gen(function*() {
      const probe = { seen: [] as Array<unknown> }
      const host = yield* keyedHost(probe)
      const echo = yield* host.fieldAction("keyed", "echo")
      assert.deepStrictEqual(echo, { ok: true, result: { ok: true, text: "Using [secret] at http://here", tone: "ok" } })
      for (const key of ["boom", "thrown"]) {
        const failed = yield* host.fieldAction("keyed", key)
        assert.deepStrictEqual(failed, { ok: true, result: { ok: false, text: "It failed; the server's log says why.", tone: "error" } })
      }
      // A draft cannot replace the secret: the handler sees the saved one (and the page never does).
      const drafted = yield* host.fieldAction("keyed", "echo", { address: "http://draft", token: "attacker-chosen-value" })
      assert.deepStrictEqual(drafted, { ok: true, result: { ok: true, text: "Using [secret] at http://draft", tone: "ok" } })
      assert.deepStrictEqual(probe.seen.at(-1), { address: "http://draft", token: SECRET })
      // An info value of the running instance is redacted too.
      yield* host.startEnabled
      assert.strictEqual(host.modules()[0]!.settings.values.state, "Signed in with [secret]")
      // A secret set in the environment is just as secret.
      const envHost = yield* keyedHost(probe, { secrets: {}, env: { KEYED_TOKEN: "env-secret-value-42" } })
      assert.deepStrictEqual(yield* envHost.fieldAction("keyed", "echo"), { ok: true, result: { ok: true, text: "Using [secret] at http://here", tone: "ok" } })
    }))

  it.effect("do not run a handler on settings that do not resolve: a missing required key or an invalid saved value is the result", () =>
    Effect.gen(function*() {
      const probe = { seen: [] as Array<unknown> }
      // A clean form whose required key is not saved (or the vault is locked, so no key is known).
      const missing = yield* keyedHost(probe, { secrets: {} })
      assert.deepStrictEqual(yield* missing.fieldAction("keyed", "echo"), {
        ok: true,
        result: { ok: false, text: "Not run: Token: Not set (enter it here or set KEYED_TOKEN)", tone: "error" }
      })
      assert.deepStrictEqual(yield* missing.fieldAction("keyed", "echo", { address: "http://draft" }), {
        ok: true,
        result: { ok: false, text: "Not run: Token: Not set (enter it here or set KEYED_TOKEN)", tone: "error" }
      })
      // A saved value that is no longer valid.
      const invalid = yield* keyedHost(probe, { stored: { tries: 9 } })
      const r = yield* invalid.fieldAction("keyed", "echo")
      assert.isTrue(r.ok && r.result.ok === false && r.result.text.startsWith("Not run: Tries: The saved value is not valid"))
      assert.deepStrictEqual(probe.seen, [])
      // With valid settings it runs with them (not with `{}`).
      const fine = yield* keyedHost(probe)
      yield* fine.fieldAction("keyed", "echo")
      assert.deepStrictEqual(probe.seen, [{ address: "http://here", token: SECRET }])
    }))

  it.effect("offer a running instance's options only on an open combo (a closed one accepts its static options only)", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "combos",
        name: "Combos",
        description: "Combos",
        settings: {
          closed: Setting.combo({ label: "Closed", default: "a", options: [{ value: "a", label: "A" }], allowCustom: false }),
          open: Setting.combo({ label: "Open", default: "a", options: [{ value: "a", label: "A" }] })
        },
        start: () => Effect.succeed({ settingOptions: () => ({ closed: [{ value: "b", label: "B" }], open: [{ value: "b", label: "B" }] }) })
      })
      const host = yield* hostOf([mod], { combos: {} })
      yield* host.startEnabled
      const fields = host.modules()[0]!.settings.fields
      const options = (key: string) => {
        const f = fields.find((x) => x.key === key)
        return f?.type === "combo" ? f.options.map((o) => o.value) : []
      }
      assert.deepStrictEqual(options("closed"), ["a"])
      assert.deepStrictEqual(options("open"), ["a", "b"])
      // And what is offered can be saved: the closed one refuses "b" (it was never shown).
      assert.isFalse((yield* host.configure("combos", { values: { closed: "b" }, secrets: {} })).ok)
      assert.isTrue((yield* host.configure("combos", { values: { open: "b" }, secrets: {} })).ok)
    }))

  it.effect("call an instance's info, settingOptions and fieldActions on the instance (a class using `this` works)", () =>
    Effect.gen(function*() {
      class Actions {
        n = 0
        bump() {
          return Effect.sync(() => ({ ok: true, text: `pressed ${++this.n}` }))
        }
      }
      class LampInstance {
        state = "on"
        names = [{ value: "Desk", label: "Desk" }]
        fieldActions = new Actions() as unknown as Readonly<Record<string, FieldActionHandler>>
        info() {
          return { state: this.state }
        }
        settingOptions() {
          return { lamp: this.names }
        }
      }
      const mod = defineModule({
        id: "lamp",
        name: "Lamp",
        description: "A lamp",
        settings: {
          lamp: Setting.combo({ label: "Lamp", default: "Desk" }),
          state: Setting.info({ label: "Now" }),
          bump: Setting.action({ label: "Bump", buttonLabel: "Bump" })
        },
        start: () => Effect.succeed(new LampInstance())
      })
      const host = yield* hostOf([mod], { lamp: {} })
      yield* host.startEnabled
      const form = host.modules()[0]!.settings
      assert.strictEqual(form.values.state, "on")
      const combo = form.fields.find((f) => f.key === "lamp")
      assert.deepStrictEqual(combo?.type === "combo" && combo.optionsNote, "1 suggestions from Lamp")
      assert.deepStrictEqual(yield* host.fieldAction("lamp", "bump"), { ok: true, result: { ok: true, text: "pressed 1" } })
      assert.deepStrictEqual(yield* host.fieldAction("lamp", "bump"), { ok: true, result: { ok: true, text: "pressed 2" } })
    }))

  it.effect("treat prototype-style keys as unknown: no inherited handler, info value or option list", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "proto",
        name: "Proto",
        description: "Proto",
        settings: {
          valueOf: Setting.combo({ label: "Value of", default: "x" }),
          toString: Setting.info({ label: "To string" })
        },
        fieldActions: {},
        start: () => Effect.succeed({ info: () => ({}), settingOptions: () => ({}), fieldActions: {} })
      })
      const host = yield* hostOf([mod], { proto: {} })
      yield* host.startEnabled
      for (const key of ["constructor", "hasOwnProperty", "toString", "valueOf"]) {
        const r = yield* host.fieldAction("proto", key)
        assert.strictEqual(r.ok, false, key)
      }
      const form = host.modules()[0]!.settings
      assert.strictEqual(Object.getOwnPropertyDescriptor(form.values, "toString")?.value, "")
      const combo = form.fields.find((f) => f.key === "valueOf")
      assert.deepStrictEqual(combo?.type === "combo" && combo.options, [])
    }))
})

describe("route declarations after review round 1", () => {
  it.effect("refuse dot segments, which a URL resolves away", () =>
    Effect.gen(function*() {
      for (const path of ["a/../callback", "./x", "a/.", ".."]) {
        assert.match(yield* refusedRoutes([{ method: "GET", path, guards: ["lan"], handler: ok }]), /not valid/, path)
      }
      // A dot inside a segment is fine.
      const host = yield* hostOf([routesModule([{ method: "GET", path: "v1.2/.well-known", guards: ["lan"], handler: ok }])], { hooks: {} })
      yield* host.startEnabled
      assert.strictEqual(host.routes().length, 1)
    }))
})

const refusedRoutes = (routes: ReadonlyArray<ModuleRoute>) =>
  Effect.gen(function*() {
    const host = yield* hostOf([routesModule(routes)], { hooks: {} })
    yield* host.startEnabled
    assert.deepStrictEqual(host.routes(), [])
    return host.modules()[0]!.error ?? ""
  })
