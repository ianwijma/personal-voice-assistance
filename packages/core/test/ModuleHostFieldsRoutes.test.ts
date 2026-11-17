// P3 in the module host (docs/MODULES-PLAN.md §4 P3): field actions (definition and instance handlers, saved vs draft
// settings, timeout, double press, not running), `info` values and `combo` options on the described form, the
// generated agent Test button, and module routes: checked at start, live while the shared part runs, gone when it stops.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Logger, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AgentError } from "../src/Agent.ts"
import { DecisionError } from "../src/Decision.ts"
import { defineAgent, defineDecider, type FieldActionHandler } from "../src/ModuleContributions.ts"
import { defineModule, type ModuleDefinition, ModuleStartError } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import type { ModuleRoute } from "../src/ModuleRoutes.ts"
import { Setting } from "../src/Settings.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"

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
  it.effect("answer at the deadline even when the handler's cleanup hangs; the button stays busy until the press has really ended", () =>
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
      // The hung one overran its 10 s cleanup limit: logged, and its button is STILL busy (its cleanup still runs).
      yield* advance(6_000)
      assert.isTrue(logs.some((l) => /field action stuck\.hang: still cleaning up 10000 ms after it was timed out/.test(l)))
      assert.deepStrictEqual(yield* host.fieldAction("stuck", "hang"), { ok: false, code: "busy", message: "That button is still running" })
      // Its finalizer ends 60 s after the deadline (at 68 s): only then is the button free.
      yield* advance(40_000)
      assert.strictEqual((yield* host.fieldAction("stuck", "hang")).ok, false)
      yield* advance(2_000)
      const third = yield* Effect.forkChild(host.fieldAction("stuck", "hang"))
      yield* advance(8_000)
      assert.deepStrictEqual(yield* Fiber.join(third), { ok: true, result: { ok: false, text: "Did not finish within 8 s", tone: "error" } })
      // Let the slow finalizers end, so the host shuts down at once.
      yield* advance(120_000)
    }).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))]))))

  it.effect("never let a press overlap the same button's earlier one, and never let an old press free a newer one", () =>
    Effect.gen(function*() {
      const running: Array<string> = []
      let overlapped = false
      const work = (name: string, ms: number) =>
        Effect.uninterruptible(Effect.gen(function*() {
          if (running.length > 0) overlapped = true
          running.push(name)
          yield* Effect.sleep(ms)
          running.splice(running.indexOf(name), 1)
          return { ok: true, text: name }
        }))
      const plan: Array<number> = [60_000, 30_000, 1_000]
      const names = ["A", "B", "C"]
      let n = 0
      const mod = defineModule({
        id: "solo",
        name: "Solo",
        description: "One at a time",
        settings: { go: Setting.action({ label: "Go", buttonLabel: "Go" }) },
        fieldActions: { go: () => Effect.suspend(() => work(names[n]!, plan[n++]!)) },
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([mod])
      // A: 60 s of uninterruptible work, answered at 8 s.
      const a = yield* Effect.forkChild(host.fieldAction("solo", "go"))
      yield* advance(8_000)
      assert.strictEqual((yield* Fiber.join(a)).ok && "answered", "answered")
      // At 18 s (past the cleanup limit) and at 55 s, A still runs: the button is busy.
      yield* advance(10_000)
      assert.strictEqual((yield* host.fieldAction("solo", "go")).ok, false)
      yield* advance(37_000)
      assert.strictEqual((yield* host.fieldAction("solo", "go")).ok, false)
      // A ends at 60 s; B starts and runs on; A's end has already been accounted and cannot free B's button.
      yield* advance(5_000)
      const b = yield* Effect.forkChild(host.fieldAction("solo", "go"))
      yield* advance(10)
      assert.deepStrictEqual(yield* host.fieldAction("solo", "go"), { ok: false, code: "busy", message: "That button is still running" })
      yield* advance(30_000)
      yield* Fiber.join(b)
      assert.isFalse(overlapped)
      assert.strictEqual(n, 2)
    }))

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

// ---------------------------------------------------------------------------------------------------------------------
// After merging P1's lifecycle (generations, one switch): routes belong to the published generation only, and module
// code the host starts never sees the turn of whoever triggered it.

describe("routes and field actions in P1's lifecycle", () => {
  const asA: TurnContext = { turnId: 1, conversationId: "c1", assistantId: "a", deviceId: "d", source: "voice" }

  it.effect("a field action pressed inside a turn runs outside it", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      const mod = defineModule({
        id: "turnless",
        name: "Turnless",
        description: "Looks for a turn",
        settings: { look: Setting.action({ label: "Look", buttonLabel: "Look" }) },
        fieldActions: {
          look: () =>
            Effect.gen(function*() {
              seen.push(yield* CurrentTurn)
              return { ok: true, text: "looked" }
            })
        },
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([mod])
      yield* Effect.provideService(host.fieldAction("turnless", "look"), CurrentTurn, asA)
      assert.deepStrictEqual(seen, [undefined])
    }))

  const generational = (probe: { closed: Array<string>; badRoute: boolean; failInstance: boolean }) =>
    defineModule({
      apiVersion: 2,
      id: "gen",
      name: "Gen",
      description: "Generations",
      settings: { word: Setting.text({ label: "Word", default: "a" }) },
      shared: ({ settings }) =>
        Effect.gen(function*() {
          const word = String(settings.word)
          yield* Effect.addFinalizer(() => Effect.sync(() => probe.closed.push(word)))
          const route: ModuleRoute = probe.badRoute
            ? { method: "GET", path: "x", handler: ok }
            : { method: "GET", path: "x", guards: ["lan"], handler: ok, description: word }
          return { value: word, routes: [route] }
        }),
      start: () => (probe.failInstance ? Effect.fail(new ModuleStartError({ message: "no" })) : Effect.succeed({}))
    })

  // Routes are one registration of the shared part (the "route" registrar): live exactly while the part is published.
  // Nothing here depends on how a replacement is made (no old and new generation are compared).
  it.effect("a route is in the route table only while its module is published: gone when it is switched off, back when on", () =>
    Effect.gen(function*() {
      const probe = { closed: [] as Array<string>, badRoute: false, failInstance: false }
      const host = yield* hostOf([generational(probe)], { gen: {} })
      yield* host.startEnabled
      assert.deepStrictEqual(host.routes().map((r) => [r.moduleId, r.route.description]), [["gen", "a"]])
      assert.deepStrictEqual(host.modules()[0]!.routes?.map((r) => r.path), ["/api/modules/gen/x"])
      yield* host.disable("gen")
      assert.deepStrictEqual(host.routes(), [])
      assert.isUndefined(host.modules()[0]!.routes)
      yield* host.enable("gen")
      assert.deepStrictEqual(host.routes().map((r) => r.route.description), ["a"])
    }))

  it.effect("a shared part whose routes are not valid, or whose instance fails, is never published: no route of it is live", () =>
    Effect.gen(function*() {
      for (const fault of ["badRoute", "failInstance"] as const) {
        const probe = { closed: [] as Array<string>, badRoute: fault === "badRoute", failInstance: fault === "failInstance" }
        const host = yield* hostOf([generational(probe)], { gen: {} })
        yield* host.startEnabled
        assert.deepStrictEqual(host.routes(), [], fault)
        assert.strictEqual(host.modules()[0]!.state, "error", fault)
        if (fault === "badRoute") assert.match(host.modules()[0]!.error ?? "", /has no guard/)
        // Its shared part was closed (it never served).
        assert.deepStrictEqual(probe.closed, ["a"], fault)
      }
    }))
})

// ---------------------------------------------------------------------------------------------------------------------
// Review round 2 (PR 90): one page boundary for everything a module says (findings 1–3 and the rest of 7), and
// field-action presses owned by the instance or host that runs them (findings 4–5).

describe("the page boundary after review round 2", () => {
  /** A module with a saved key that it puts into every kind of text the page shows. */
  const leaky = (token: { current: string }, probe: { release?: () => void; options?: unknown }) =>
    defineModule({
      apiVersion: 2,
      id: "leaky",
      name: "Leaky",
      description: "Says its key everywhere",
      settings: {
        token: Setting.secret({ label: "Token", required: true }),
        state: Setting.info({ label: "Now" }),
        pick: Setting.combo({ label: "Pick", default: "a", options: [{ value: "a", label: "A" }] }),
        slowEcho: Setting.action({ label: "Slow echo", buttonLabel: "Echo" })
      },
      shared: ({ settings }) =>
        Effect.succeed({
          value: settings.token,
          routes: [{ method: "GET", path: "x", guards: ["lan"], handler: ok, description: `Route for ${settings.token}` }]
        }),
      health: ({ settings }) => Effect.succeed([{ id: "h", severity: "warning", title: `Key ${String(settings?.token)}`, detail: `Detail ${String(settings?.token)}` }]),
      start: ({ setStatus, settings }) =>
        Effect.sync(() => {
          token.current = String(settings.token)
          setStatus({ text: `Using ${settings.token}`, tone: "ok" })
          return {
            info: () => ({ state: `Signed in with ${settings.token}` }),
            settingOptions: () => (probe.options ?? {
              pick: [
                { value: "b", label: `Account ${settings.token}`, description: `d ${settings.token}`, implication: `i ${settings.token}` },
                { value: `id-${settings.token}`, label: "Hidden value" }
              ]
            }) as never,
            fieldActions: {
              slowEcho: () =>
                Effect.gen(function*() {
                  yield* Effect.callback<void>((resume) => {
                    probe.release = () => resume(Effect.void)
                  })
                  return { ok: true, text: `Echo ${settings.token}` }
                })
            }
          }
        })
    })

  const OLD = "old-secret-0123456789"
  const NEW = "new-secret-9876543210"

  const leakyHost = (probe: { release?: () => void; options?: unknown }) =>
    makeModuleHost({
      catalog: [leaky({ current: "" }, probe)],
      persistence: readOnlyPersistence({ modules: { leaky: { enabled: true } }, secrets: { leaky: { token: OLD } } }),
      env: {}
    })

  /** Everything the page gets about the module, as one string. */
  const pageOf = (host: Effect.Success<ReturnType<typeof leakyHost>>) => JSON.stringify([host.modules(), host.issues.all(), host.settingOptions("leaky")])

  it.effect("1: after the vault is locked, a running instance's key is still redacted everywhere the page looks", () =>
    Effect.gen(function*() {
      const host = yield* leakyHost({})
      yield* host.startEnabled
      yield* host.checkHealth
      assert.include(pageOf(host), "Key [secret]")
      assert.notInclude(pageOf(host), OLD)
      // Locking the vault: no saved key is known now, but the instance still runs (and talks) with it.
      yield* host.setSecrets({})
      assert.strictEqual(host.modules()[0]!.state, "running")
      yield* host.checkHealth
      const page = pageOf(host)
      assert.notInclude(page, OLD)
      assert.include(page, "Signed in with [secret]")
      assert.include(page, "Using [secret]")
      assert.include(page, "Route for [secret]")
    }))

  it.effect("1: a key rotated while a press runs: the old key in its answer is still redacted", () =>
    Effect.gen(function*() {
      const probe: { release?: () => void } = {}
      const host = yield* leakyHost(probe)
      yield* host.startEnabled
      const press = yield* Effect.forkChild(host.fieldAction("leaky", "slowEcho"))
      yield* advance(10)
      assert.isTrue((yield* host.configure("leaky", { values: {}, secrets: { token: NEW } })).ok)
      probe.release!()
      const result = yield* Fiber.join(press)
      assert.deepStrictEqual(result, { ok: true, result: { ok: true, text: "Echo [secret]" } })
      assert.notInclude(pageOf(host), NEW)
      yield* advance(20_000)
    }))

  it.effect("2: runtime combo options: display texts redacted, an option whose value holds a key dropped, on the form and in settingOptions", () =>
    Effect.gen(function*() {
      const host = yield* leakyHost({})
      yield* host.startEnabled
      const combo = host.modules()[0]!.settings.fields.find((f) => f.key === "pick")
      assert.deepStrictEqual(combo?.type === "combo" && combo.options, [
        { value: "a", label: "A" },
        { value: "b", label: "Account [secret]", description: "d [secret]", implication: "i [secret]" }
      ])
      assert.deepStrictEqual(host.settingOptions("leaky"), {
        pick: [{ value: "b", label: "Account [secret]", description: "d [secret]", implication: "i [secret]" }]
      })
    }))

  it.effect("3 and 7: the generated agent Test redacts a long key before quoting it short; a provider failure says only a generic sentence", () =>
    Effect.gen(function*() {
      const LONG = `sk-${"x".repeat(100)}${"y".repeat(97)}`
      const mode = { current: "echo" as "echo" | "fail" | "longFail" }
      const agent = defineAgent({
        id: "talker",
        name: "Talker",
        description: "Talks",
        kind: "model",
        settings: { key: Setting.secret({ label: "Key", required: true }) },
        enabledByDefault: true,
        start: ({ settings }) =>
          Effect.succeed({
            turn: () =>
              mode.current === "echo"
                ? Stream.make({ _tag: "TextDelta" as const, text: `My key is ${settings.key}` })
                : Stream.fail(new AgentError({ reason: "failed", message: mode.current === "fail" ? `401 for key ${settings.key}` : `${"e".repeat(480)} ${settings.key}` }))
          })
      })
      const host = yield* makeModuleHost({
        catalog: [agent],
        persistence: readOnlyPersistence({ modules: { talker: { enabled: true } }, secrets: { talker: { key: LONG } } }),
        env: {}
      })
      yield* host.startEnabled
      const echoed = yield* host.fieldAction("talker", "test")
      assert.isTrue(echoed.ok && echoed.result.ok)
      const text = echoed.ok ? echoed.result.text : ""
      assert.include(text, "'My key is [secret]'")
      assert.notInclude(text, LONG.slice(0, 20))
      for (const m of ["fail", "longFail"] as const) {
        mode.current = m
        const failed = yield* host.fieldAction("talker", "test")
        assert.isTrue(failed.ok && !failed.result.ok)
        assert.match(failed.ok ? failed.result.text : "", /^Failed after \d+ ms; the server's log says why\.$/)
      }
    }))

  it.effect("3: the generated decider Test does not show the provider's error either", () =>
    Effect.gen(function*() {
      const decider = defineDecider({
        id: "picker",
        name: "Picker",
        description: "Picks",
        settings: { key: Setting.secret({ label: "Key", required: true }) },
        enabledByDefault: true,
        start: ({ settings }) =>
          Effect.succeed({ location: "hosted" as const, decide: () => Effect.fail(new DecisionError({ reason: "rejected", message: `bad key ${settings.key}` })) })
      })
      const host = yield* makeModuleHost({
        catalog: [decider],
        persistence: readOnlyPersistence({ modules: { picker: { enabled: true } }, secrets: { picker: { key: "decider-secret-123" } } }),
        env: {}
      })
      yield* host.startEnabled
      const r = yield* host.fieldAction("picker", "test")
      assert.match(r.ok ? r.result.text : "", /^Failed after \d+ ms; the server's log says why\.$/)
    }))

  it.effect("7: a start error and a status line with the key are redacted, the status clipped to the wire's 120 characters after", () =>
    Effect.gen(function*() {
      const KEY = "start-secret-0123456789"
      const mod = defineModule({
        id: "starter",
        name: "Starter",
        description: "Fails to start",
        settings: { key: Setting.secret({ label: "Key", required: true }), fail: Setting.boolean({ label: "Fail", default: true }) },
        start: ({ setStatus, settings }) =>
          settings.fail
            ? Effect.fail(new ModuleStartError({ message: `Login refused for ${settings.key}` }))
            : Effect.sync(() => {
              setStatus({ text: `${"s".repeat(110)}${settings.key}`, tone: "ok" })
              return {}
            })
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { starter: { enabled: true } }, secrets: { starter: { key: KEY } } }),
        env: {}
      })
      yield* host.startEnabled
      assert.strictEqual(host.modules()[0]!.error, "Login refused for [secret]")
      assert.notInclude(JSON.stringify(host.issues.all()), KEY)
      // The result of a save that fails to start reaches the page too.
      const refusedSave = yield* host.configure("starter", { values: {}, secrets: { key: "rotated-secret-424242" } })
      assert.deepStrictEqual(refusedSave.ok ? "" : refusedSave.error.message, "Login refused for [secret]")
      assert.isTrue((yield* host.configure("starter", { values: { fail: false }, secrets: {} })).ok)
      const status = host.modules()[0]!.status
      // Redacted first, so no prefix of the key survives the clipping.
      assert.strictEqual(status?.text, `${"s".repeat(110)}[secret]`)
    }))
})

describe("field-action presses after review round 2: owned by what runs them", () => {
  /** An instance with a socket-like resource; its action sleeps, then uses it; its cleanup looks at it too. */
  const socketed = (probe: { open: Array<boolean>; used: Array<boolean>; cleanup: Array<boolean> }) =>
    defineModule({
      id: "sock",
      name: "Sock",
      description: "Has a socket",
      settings: { word: Setting.text({ label: "Word", default: "a" }), use: Setting.action({ label: "Use", buttonLabel: "Use" }) },
      start: () =>
        Effect.gen(function*() {
          const socket = { open: true }
          yield* Effect.acquireRelease(Effect.sync(() => socket), (s) => Effect.sync(() => void (s.open = false)))
          probe.open.push(true)
          return {
            fieldActions: {
              use: () =>
                Effect.sleep(5_000).pipe(
                  Effect.andThen(Effect.sync(() => probe.used.push(socket.open))),
                  Effect.ensuring(Effect.sync(() => probe.cleanup.push(socket.open))),
                  Effect.as({ ok: true, text: "used" })
                )
            }
          }
        })
    })

  it.effect("5: a reconfigure with no grace stops the old instance's press, whose cleanup still sees its resource open", () =>
    Effect.gen(function*() {
      const probe = { open: [] as Array<boolean>, used: [] as Array<boolean>, cleanup: [] as Array<boolean> }
      const host = yield* makeModuleHost({
        catalog: [socketed(probe)],
        persistence: readOnlyPersistence({ modules: { sock: { enabled: true } }, secrets: {} }),
        env: {},
        graceMs: 0
      })
      yield* host.startEnabled
      const press = yield* Effect.forkChild(host.fieldAction("sock", "use"))
      yield* advance(100)
      assert.isTrue((yield* host.configure("sock", { values: { word: "b" }, secrets: {} })).ok)
      yield* advance(10)
      // The old instance went: its press was stopped first, while the socket was still open, and never used it closed.
      assert.deepStrictEqual(probe.cleanup, [true])
      assert.deepStrictEqual(probe.used, [])
      const answered = yield* Fiber.join(press)
      assert.isTrue(answered.ok)
      yield* advance(10_000)
      assert.deepStrictEqual(probe.used, [])
      // The new instance's button works.
      const again = yield* Effect.forkChild(host.fieldAction("sock", "use"))
      yield* advance(5_000)
      assert.deepStrictEqual(yield* Fiber.join(again), { ok: true, result: { ok: true, text: "used" } })
      assert.deepStrictEqual(probe.used, [true])
    }))

  it.effect("5: at shutdown an instance's press is stopped before its resources are released", () =>
    Effect.gen(function*() {
      const probe = { open: [] as Array<boolean>, used: [] as Array<boolean>, cleanup: [] as Array<boolean> }
      const scope = yield* Scope.make()
      const host = yield* makeModuleHost({
        catalog: [socketed(probe)],
        persistence: readOnlyPersistence({ modules: { sock: { enabled: true } }, secrets: {} }),
        env: {}
      }).pipe(Scope.provide(scope))
      yield* host.startEnabled
      yield* Effect.forkChild(host.fieldAction("sock", "use"))
      yield* advance(100)
      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(probe.cleanup, [true])
      assert.deepStrictEqual(probe.used, [])
    }))
})
