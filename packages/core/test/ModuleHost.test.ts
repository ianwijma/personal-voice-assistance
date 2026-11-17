import { assert, describe, it } from "@effect/vitest"
import type { ModuleInfo } from "@pva/protocol"
import { Effect, Fiber, Scheduler, Schema } from "effect"
import { TestClock } from "effect/testing"
import { makeTool } from "../src/Module.ts"
import { defineModule, ModuleStartError } from "../src/ModuleDefinition.ts"
import { makeModuleHost, type ModulePersistence, type ModuleRecord } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

/** Persistence that records every save. */
const fakePersistence = (
  modules: Record<string, ModuleRecord> = {},
  secrets: Record<string, Record<string, string>> = {}
) => {
  const saves: Array<{ id: string; enabled: boolean; settings: unknown; secrets: unknown }> = []
  const persistence: ModulePersistence = {
    initial: { modules, secrets },
    save: (id, record) => Effect.sync(() => saves.push({ id, ...record }))
  }
  return { persistence, saves }
}

interface Probe {
  starts: number
  closes: number
  toolCalls: Array<string>
}

/** A module with a `greeting` setting, a tool named `tool` (configurable), a context provider, and a probe. */
const testModule = (options: {
  readonly id?: string
  readonly tool?: string
  readonly startMillis?: number
  readonly fail?: string
  readonly toolMillis?: number
  readonly contextMillis?: number
  readonly enabledByDefault?: boolean
  readonly probe?: Probe
}) => {
  const probe: Probe = options.probe ?? { starts: 0, closes: 0, toolCalls: [] }
  const definition = defineModule({
    id: options.id ?? "test",
    name: options.id === undefined ? "Test" : options.id.toUpperCase(),
    description: "A test module",
    ...(options.enabledByDefault !== undefined ? { enabledByDefault: options.enabledByDefault } : {}),
    settings: {
      greeting: Setting.text({ label: "Greeting", default: "hello", check: (v) => (v === "bad" ? "Not this one" : undefined) }),
      token: Setting.secret({ label: "Token", env: "TEST_TOKEN" })
    },
    start: ({ settings, setStatus }) =>
      Effect.gen(function*() {
        probe.starts++
        if ((options.startMillis ?? 0) > 0) yield* Effect.sleep(options.startMillis!)
        if (options.fail !== undefined || settings.greeting === "fail") {
          return yield* new ModuleStartError({ message: options.fail ?? "Refused" })
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => probe.closes++))
        setStatus({ text: `Greeting ${settings.greeting}`, tone: "ok" })
        return {
          instructions: `Say ${settings.greeting}.`,
          tools: [makeTool({
            name: options.tool ?? "tool",
            description: "tool",
            parameters: Schema.Struct({}),
            speculative: true,
            execute: () =>
              Effect.gen(function*() {
                if ((options.toolMillis ?? 0) > 0) yield* Effect.sleep(options.toolMillis!)
                probe.toolCalls.push(settings.greeting)
                return settings.greeting
              })
          })],
          context: [{
            name: "Ctx",
            get: (options.contextMillis ?? 0) > 0
              ? Effect.as(Effect.sleep(options.contextMillis!), "slow")
              : Effect.succeed(`ctx ${settings.greeting}`)
          }]
        }
      })
  })
  return { definition, probe }
}

const host = (catalog: ReadonlyArray<ReturnType<typeof testModule>["definition"]>, persistence: ModulePersistence, env: Record<string, string> = {}) =>
  makeModuleHost({ catalog, persistence, env })

const stateOf = (modules: ReadonlyArray<ModuleInfo>, id = "test") => modules.find((m) => m.id === id)!

describe("ModuleHost", () => {
  it.effect("startup: modules with intent on start (default: enabledByDefault); the snapshot has their tools and instructions", () =>
    Effect.gen(function*() {
      const a = testModule({ id: "a", tool: "ta" })
      const b = testModule({ id: "b", tool: "tb", enabledByDefault: false })
      const c = testModule({ id: "c", tool: "tc", enabledByDefault: false })
      const { persistence } = fakePersistence({ c: { enabled: true } })
      const h = yield* host([a.definition, b.definition, c.definition], persistence)
      assert.deepStrictEqual(h.modules().map((m) => m.state), ["disabled", "disabled", "disabled"])
      yield* h.startEnabled
      assert.deepStrictEqual(h.modules().map((m) => [m.id, m.enabled, m.state]), [["a", true, "running"], ["b", false, "disabled"], ["c", true, "running"]])
      const snap = h.snapshot()
      assert.deepStrictEqual(snap.registry.specs.map((s) => s.name), ["ta", "tc"])
      assert.deepStrictEqual(snap.instructions, ["Say hello.", "Say hello."])
      assert.deepStrictEqual([...snap.toolModules], [["ta", "a"], ["tc", "c"]])
      assert.strictEqual(yield* snap.registry.context, "## Ctx\nctx hello\n\n## Ctx\nctx hello")
      assert.deepStrictEqual(stateOf(h.modules(), "a").status, { text: "Greeting hello", tone: "ok" })
    }).pipe(Effect.scoped))

  it.effect("enable: starting → running, intent saved, every change notified with a higher revision", () =>
    Effect.gen(function*() {
      const m = testModule({ startMillis: 100, enabledByDefault: false })
      const { persistence, saves } = fakePersistence()
      const h = yield* host([m.definition], persistence)
      const seen: Array<ModuleInfo> = []
      h.subscribe((info) => seen.push(info))
      const fiber = yield* Effect.forkChild(h.enable("test"))
      yield* advance(10)
      assert.strictEqual(stateOf(h.modules()).state, "starting")
      // A disable while it starts is not refused: it is the desired state from now on, applied after this pass.
      const disabling = yield* Effect.forkChild(h.disable("test"))
      yield* advance(100)
      assert.deepStrictEqual(yield* Fiber.join(fiber), { ok: true })
      assert.deepStrictEqual(yield* Fiber.join(disabling), { ok: true })
      assert.deepStrictEqual(seen.slice(0, 3).map((i) => i.state), ["starting", "running", "stopping"])
      assert.isTrue(seen[1]!.revision > seen[0]!.revision)
      assert.deepStrictEqual(saves, [{ id: "test", enabled: true, settings: {}, secrets: {} }, { id: "test", enabled: false, settings: {}, secrets: {} }])
      assert.deepStrictEqual(seen[1]!.tools, [{ name: "tool", description: "tool", speculative: true, risk: "read", risks: ["read"], sensitivity: "household", latency: "quick" }])
    }).pipe(Effect.scoped))

  it.effect("enable with invalid saved settings: error with form errors, intent saved, invalid_settings", () =>
    Effect.gen(function*() {
      const m = testModule({ enabledByDefault: false })
      const { persistence, saves } = fakePersistence({ test: { enabled: false, settings: { greeting: "bad" } } })
      const h = yield* host([m.definition], persistence)
      const result = yield* h.enable("test")
      assert.isFalse(result.ok)
      if (!result.ok) {
        assert.strictEqual(result.error.code, "invalid_settings")
        assert.deepStrictEqual(result.error.fieldErrors, [{ key: "greeting", message: "The saved value is not valid (Not this one); save a new one" }])
      }
      const info = stateOf(h.modules())
      assert.deepStrictEqual([info.enabled, info.state], [true, "error"])
      assert.match(info.error!, /not valid/)
      assert.strictEqual(saves.at(-1)!.enabled, true)
      assert.strictEqual(m.probe.starts, 0)
    }).pipe(Effect.scoped))

  it.effect("a failing start: error with its message, module_start_failed; enabling again retries", () =>
    Effect.gen(function*() {
      const m = testModule({ fail: "The token was rejected (HTTP 401)", enabledByDefault: false })
      const { persistence } = fakePersistence()
      const h = yield* host([m.definition], persistence)
      const result = yield* h.enable("test")
      assert.deepStrictEqual(result, { ok: false, error: { code: "module_start_failed", message: "The token was rejected (HTTP 401)", moduleId: "test" } })
      assert.deepStrictEqual([stateOf(h.modules()).state, stateOf(h.modules()).error], ["error", "The token was rejected (HTTP 401)"])
      yield* h.enable("test")
      assert.strictEqual(m.probe.starts, 2)
    }).pipe(Effect.scoped))

  it.effect("a start that takes longer than 10 s fails", () =>
    Effect.gen(function*() {
      const m = testModule({ startMillis: 60_000, enabledByDefault: false })
      const { persistence } = fakePersistence()
      const h = yield* host([m.definition], persistence)
      const fiber = yield* Effect.forkChild(h.enable("test"))
      yield* advance(10_000)
      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.ok ? "" : result.error.message, "Did not start within 10 s")
      assert.strictEqual(stateOf(h.modules()).state, "error")
    }).pipe(Effect.scoped))

  it.effect("a tool name used by another running module: error, module_start_failed, scope closed", () =>
    Effect.gen(function*() {
      const a = testModule({ id: "a", tool: "same" })
      const b = testModule({ id: "b", tool: "same", enabledByDefault: false })
      const { persistence } = fakePersistence()
      const h = yield* host([a.definition, b.definition], persistence)
      yield* h.startEnabled
      const result = yield* h.enable("b")
      assert.strictEqual(result.ok ? "" : result.error.message, "Tool name \"same\" is already used by module A")
      assert.strictEqual(stateOf(h.modules(), "b").state, "error")
      assert.strictEqual(b.probe.closes, 1)
      assert.deepStrictEqual(h.snapshot().registry.specs.map((s) => s.name), ["same"])
    }).pipe(Effect.scoped))

  it.effect("disable: leaves the snapshot at once; a tool call in flight finishes; the scope closes after the grace period", () =>
    Effect.gen(function*() {
      const m = testModule({ toolMillis: 3_000 })
      const { persistence, saves } = fakePersistence()
      const h = yield* host([m.definition], persistence)
      yield* h.startEnabled
      const turnSnapshot = h.snapshot() // a turn in flight holds this
      const call = yield* Effect.forkChild(turnSnapshot.registry.run({ id: "1", name: "tool", input: {} }))
      yield* advance(10)
      assert.deepStrictEqual(yield* h.disable("test"), { ok: true })
      assert.deepStrictEqual(h.snapshot().registry.specs, [])
      assert.strictEqual(stateOf(h.modules()).state, "stopping")
      assert.deepStrictEqual(saves.at(-1)!.enabled, false)
      yield* advance(3_000)
      const result = yield* Fiber.join(call)
      assert.deepStrictEqual([result.isError, result.content], [false, "hello"])
      assert.strictEqual(m.probe.closes, 0, "still in its grace period")
      yield* advance(7_000)
      assert.strictEqual(m.probe.closes, 1)
      assert.strictEqual(stateOf(h.modules()).state, "disabled")
    }).pipe(Effect.scoped))

  it.effect("reconfigure while running: the new instance replaces the old one, a running tool call finishes on the old one", () =>
    Effect.gen(function*() {
      const m = testModule({ toolMillis: 1_000 })
      const { persistence, saves } = fakePersistence()
      const h = yield* host([m.definition], persistence)
      yield* h.startEnabled
      const call = yield* Effect.forkChild(h.snapshot().registry.run({ id: "1", name: "tool", input: {} }))
      yield* advance(10)
      const result = yield* h.configure("test", { values: { greeting: "hi" }, secrets: {} })
      assert.deepStrictEqual(result, { ok: true })
      assert.deepStrictEqual(h.snapshot().instructions, ["Say hi."])
      yield* advance(1_000)
      assert.strictEqual((yield* Fiber.join(call)).content, "hello", "the old instance served the call")
      assert.deepStrictEqual(saves.at(-1)!.settings, { greeting: "hi" })
      yield* Effect.yieldNow
      assert.deepStrictEqual(stateOf(h.modules()).status, { text: "Greeting hi", tone: "ok" })
      assert.deepStrictEqual(stateOf(h.modules()).settings.values.greeting, "hi")
      assert.strictEqual(m.probe.closes, 0)
      yield* advance(10_000)
      assert.strictEqual(m.probe.closes, 1, "the old instance closed after the grace period")
    }).pipe(Effect.scoped))

  it.effect("reconfigure that fails to start keeps the old instance and does not save", () =>
    Effect.gen(function*() {
      const m = testModule({})
      const { persistence, saves } = fakePersistence()
      const h = yield* host([m.definition], persistence)
      yield* h.startEnabled
      const result = yield* h.configure("test", { values: { greeting: "fail" }, secrets: {} })
      assert.strictEqual(result.ok ? "" : result.error.code, "module_start_failed")
      assert.strictEqual(stateOf(h.modules()).state, "running")
      assert.deepStrictEqual(h.snapshot().instructions, ["Say hello."])
      assert.deepStrictEqual(stateOf(h.modules()).settings.values.greeting, "hello")
      assert.deepStrictEqual(saves, [])
    }).pipe(Effect.scoped))

  it.effect("an invalid patch changes nothing; a locked field is refused", () =>
    Effect.gen(function*() {
      const m = testModule({})
      const { persistence, saves } = fakePersistence()
      const h = yield* host([m.definition], persistence, { TEST_TOKEN: "from-env" })
      yield* h.startEnabled
      const bad = yield* h.configure("test", { values: { greeting: "bad" }, secrets: { token: "x" } })
      assert.deepStrictEqual(bad.ok ? [] : bad.error.fieldErrors, [
        { key: "greeting", message: "Not this one" },
        { key: "token", message: "Set by TEST_TOKEN in the environment; change it there" }
      ])
      assert.deepStrictEqual(saves, [])
      assert.deepStrictEqual(stateOf(h.modules()).settings.secrets, { token: { set: true, source: "env" } })
    }).pipe(Effect.scoped))

  it.effect("reconfigure while disabled saves without starting; while in error it saves and starts", () =>
    Effect.gen(function*() {
      const m = testModule({ enabledByDefault: false })
      const { persistence, saves } = fakePersistence({ test: { enabled: true, settings: { greeting: "fail" } } })
      const h = yield* host([m.definition], persistence)
      yield* h.startEnabled
      assert.strictEqual(stateOf(h.modules()).state, "error")
      const fixed = yield* h.configure("test", { values: { greeting: "ok now" }, secrets: { token: "secret" } })
      assert.deepStrictEqual(fixed, { ok: true })
      assert.strictEqual(stateOf(h.modules()).state, "running")
      assert.deepStrictEqual(saves.at(-1), { id: "test", enabled: true, settings: { greeting: "ok now" }, secrets: { token: "secret" } })
      yield* h.disable("test")
      yield* h.configure("test", { values: { greeting: "later" }, secrets: {} })
      assert.strictEqual(m.probe.starts, 2)
      assert.deepStrictEqual(saves.at(-1)!.settings, { greeting: "later" })
    }).pipe(Effect.scoped))

  it.effect("a context provider slower than 50 ms contributes nothing to that turn", () =>
    Effect.gen(function*() {
      const m = testModule({ contextMillis: 200 })
      const { persistence } = fakePersistence()
      const h = yield* host([m.definition], persistence)
      yield* h.startEnabled
      const fiber = yield* Effect.forkChild(h.snapshot().registry.context)
      yield* advance(50)
      assert.strictEqual(yield* Fiber.join(fiber), "")
    }).pipe(Effect.scoped))

  it.effect("unknown module; shutdown closes every instance without grace", () =>
    Effect.gen(function*() {
      const m = testModule({})
      const { persistence } = fakePersistence()
      yield* Effect.scoped(Effect.gen(function*() {
        const h = yield* host([m.definition], persistence)
        yield* h.startEnabled
        const unknown = yield* h.enable("nope")
        assert.strictEqual(unknown.ok ? "" : unknown.error.code, "unknown_module")
        yield* h.configure("test", { values: { greeting: "two" }, secrets: {} }) // one instance in its grace period
      }))
      assert.strictEqual(m.probe.closes, 2)
    }))
  it.effect("setSecrets: secrets change without a save; an enabled module that failed for a missing key starts once it has one", () =>
    Effect.gen(function*() {
      let starts = 0
      const keyed = defineModule({
        id: "keyed",
        name: "Keyed",
        description: "Needs a key",
        settings: { token: Setting.secret({ label: "Token", required: true }) },
        start: ({ settings }) => Effect.sync(() => {
          starts++
          return { instructions: `Key ${settings.token?.length ?? 0}` }
        })
      })
      const { persistence, saves } = fakePersistence({ keyed: { enabled: true } })
      const h = yield* makeModuleHost({ catalog: [keyed], persistence, env: {} })
      const seen: Array<ModuleInfo> = []
      h.subscribe((info) => seen.push(info))
      yield* h.startEnabled
      assert.strictEqual(h.modules()[0]!.state, "error")
      assert.strictEqual(starts, 0)

      yield* h.setSecrets({ keyed: { token: "abc" } })
      assert.strictEqual(h.modules()[0]!.state, "running")
      assert.deepStrictEqual(h.modules()[0]!.settings.secrets.token, { set: true, source: "store" })
      assert.strictEqual(starts, 1)
      assert.deepStrictEqual(h.snapshot().instructions, ["Key 3"])
      assert.strictEqual(saves.length, 0)

      // Taken away again (the vault was locked): the form says so, the running instance keeps running.
      yield* h.setSecrets({})
      assert.deepStrictEqual(h.modules()[0]!.settings.secrets.token, { set: false, source: "none" })
      assert.strictEqual(h.modules()[0]!.state, "running")
      assert.strictEqual(saves.length, 0)
      assert.ok(seen.length >= 3)
    }).pipe(Effect.scoped))
})

describe("ModuleHost: review findings", () => {
  it.effect("finding 4: two modules starting at once with the same tool name: one runs, the other fails to start, the host carries on", () =>
    Effect.gen(function*() {
      const a = testModule({ id: "a", tool: "same", startMillis: 1 })
      const b = testModule({ id: "b", tool: "same", startMillis: 1 })
      const { persistence } = fakePersistence()
      const h = yield* host([a.definition, b.definition], persistence)
      const fiber = yield* Effect.forkChild(Effect.exit(h.startEnabled))
      yield* advance(10)
      const exit = yield* Fiber.join(fiber)
      assert.strictEqual(exit._tag, "Success", "startEnabled does not fail")
      const states = h.modules().map((m) => [m.id, m.state])
      assert.deepStrictEqual(states, [["a", "running"], ["b", "error"]])
      assert.match(stateOf(h.modules(), "b").error ?? "", /Tool name "same" is already used by module A/)
      assert.deepStrictEqual(h.snapshot().registry.specs.map((s) => s.name), ["same"])
      assert.deepStrictEqual([...h.snapshot().toolModules], [["same", "a"]])
      assert.strictEqual(b.probe.closes, 1, "the rejected instance was closed")
    }).pipe(Effect.scoped))

  it.effect("finding 4: enabling a module while another with the same tool is being reconfigured", () =>
    Effect.gen(function*() {
      const a = testModule({ id: "a", tool: "same", startMillis: 1 })
      const b = testModule({ id: "b", tool: "same", startMillis: 1, enabledByDefault: false })
      const { persistence } = fakePersistence()
      const h = yield* host([a.definition, b.definition], persistence)
      const first = yield* Effect.forkChild(h.startEnabled)
      yield* advance(5)
      yield* Fiber.join(first)
      const enabling = yield* Effect.forkChild(h.enable("b"))
      yield* advance(5)
      const result = yield* Fiber.join(enabling)
      assert.deepStrictEqual(result.ok ? "ok" : result.error.code, "module_start_failed")
      assert.deepStrictEqual(h.snapshot().registry.specs.map((s) => s.name), ["same"])
    }).pipe(Effect.scoped))

  const slowStarter = (log: Array<string>, options: { readonly throwSync?: boolean } = {}) =>
    defineModule({
      id: "slow",
      name: "Slow",
      description: "Registers a resource, then takes its time",
      settings: {},
      start: options.throwSync === true
        ? () => {
          throw new Error("constructed badly")
        }
        : () =>
          Effect.gen(function*() {
            yield* Effect.addFinalizer(() => Effect.sync(() => log.push("closed")))
            yield* Effect.sleep(1_000)
            return {}
          })
    })

  it.effect("finding 5 (round 2): interrupting startEnabled's caller only stops its wait; closing the host mid-start closes the half-started scope once", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const { persistence } = fakePersistence()
      yield* Effect.gen(function*() {
        const h = yield* makeModuleHost({ catalog: [slowStarter(log)], persistence, env: {} })
        const fiber = yield* Effect.forkChild(h.startEnabled)
        yield* advance(10)
        assert.strictEqual(stateOf(h.modules(), "slow").state, "starting")
        yield* Fiber.interrupt(fiber)
        assert.strictEqual(stateOf(h.modules(), "slow").state, "starting", "the start goes on")
        yield* advance(1_000)
        assert.strictEqual(stateOf(h.modules(), "slow").state, "running")
        assert.deepStrictEqual(log, [])
      }).pipe(Effect.scoped)
      assert.deepStrictEqual(log, ["closed"], "closed at shutdown, once")
      yield* Effect.gen(function*() {
        const h = yield* makeModuleHost({ catalog: [slowStarter(log)], persistence, env: {} })
        yield* Effect.forkChild(h.startEnabled)
        yield* advance(10)
        assert.strictEqual(stateOf(h.modules(), "slow").state, "starting")
      }).pipe(Effect.scoped)
      assert.deepStrictEqual(log, ["closed", "closed"], "a start in progress is closed when the host closes")
    }))

  it.effect("finding 5: a start that throws before returning its effect is a start failure, not a host crash", () =>
    Effect.gen(function*() {
      const { persistence } = fakePersistence()
      const h = yield* makeModuleHost({ catalog: [slowStarter([], { throwSync: true })], persistence, env: {} })
      yield* h.startEnabled
      assert.strictEqual(stateOf(h.modules(), "slow").state, "error")
      assert.match(stateOf(h.modules(), "slow").error ?? "", /crashed while starting/)
    }).pipe(Effect.scoped))

  it.effect("finding 11, same mistake: a field action that throws is reported, not a crash", () =>
    Effect.gen(function*() {
      const m = defineModule({
        id: "fa",
        name: "FA",
        description: "x",
        settings: {},
        start: () => Effect.succeed({ fieldActions: { check: () => { throw new Error("thrown") } } })
      })
      const h = yield* makeModuleHost({ catalog: [m], persistence: fakePersistence().persistence, env: {} })
      yield* h.startEnabled
      const result = yield* h.fieldAction("fa", "check")
      assert.isTrue(result.ok && !result.result.ok)
    }).pipe(Effect.scoped))

  it.effect("settingOptions: the running instance's choices; none while it does not run, or when they throw", () =>
    Effect.gen(function*() {
      let fail = false
      const m = defineModule({
        id: "opts",
        name: "Opts",
        description: "x",
        settings: {},
        start: () =>
          Effect.succeed({
            settingOptions: () => {
              if (fail) throw new Error("thrown")
              return { model: [{ value: "a", label: "A" }] }
            }
          })
      })
      const h = yield* makeModuleHost({ catalog: [m], persistence: fakePersistence().persistence, env: {} })
      assert.isUndefined(h.settingOptions("opts"))
      assert.isUndefined(h.settingOptions("nope"))
      yield* h.enable("opts")
      assert.deepStrictEqual(h.settingOptions("opts"), { model: [{ value: "a", label: "A" }] })
      fail = true
      assert.isUndefined(h.settingOptions("opts"))
    }).pipe(Effect.scoped))
})

describe("ModuleHost: review round 2, a successful start is always published or closed", () => {
  // Every operation yields to the scheduler after each step (MaxOpsBeforeYield = 1), and the
  // caller interrupts it after k of those yields, for every k: the interruption lands at every
  // point between the module's start returning and its publication.
  const instant = (probe: { starts: number; closes: number }, id = "m") =>
    defineModule({
      id,
      name: id.toUpperCase(),
      description: "Starts at once",
      settings: { greeting: Setting.text({ label: "Greeting", default: "hello" }) },
      start: () =>
        Effect.gen(function*() {
          yield* Effect.acquireRelease(Effect.sync(() => probe.starts++), () => Effect.sync(() => probe.closes++))
          return { tools: [makeTool({ name: `${id}_tool`, description: "t", parameters: Schema.Struct({}), execute: () => Effect.succeed("ok") })] }
        })
    })

  it.effect("enable and configure, interrupted at every step: no instance is left running unpublished", () =>
    Effect.gen(function*() {
      for (const op of ["enable", "configure"] as const) {
        for (let k = 0; k < 120; k++) {
          const probe = { starts: 0, closes: 0 }
          const { persistence } = fakePersistence({ m: { enabled: op === "configure" } })
          yield* Effect.gen(function*() {
            const h = yield* makeModuleHost({ catalog: [instant(probe)], persistence, env: {} })
            if (op === "configure") yield* h.startEnabled
            const run = op === "enable" ? h.enable("m") : h.configure("m", { values: { greeting: "hi" }, secrets: {} })
            const fiber = yield* Effect.forkChild(run.pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1)))
            for (let i = 0; i < k; i++) yield* Effect.yieldNow
            yield* Fiber.interrupt(fiber)
            yield* advance(10_000) // past the grace period of a retired instance
            const info = stateOf(h.modules(), "m")
            const published = h.snapshot().registry.specs.some((s) => s.name === "m_tool")
            // Exactly the published instance (if any) is still open.
            assert.strictEqual(probe.starts - probe.closes, published ? 1 : 0, `${op}, interrupted after ${k} yields: open instances`)
            assert.strictEqual(info.state === "running", published, `${op}, interrupted after ${k} yields: state ${info.state}`)
          }).pipe(Effect.scoped)
          assert.strictEqual(probe.starts, probe.closes, `${op}, k=${k}: everything closed at shutdown`)
        }
      }
    }))
})
