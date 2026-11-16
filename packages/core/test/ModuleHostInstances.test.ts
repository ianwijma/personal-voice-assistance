// Module instances keyed by effective settings (docs/ASSISTANTS.md §2.6, WP-12b): assistants with equal settings
// share one instance, an assistant with its own value of an `overridable` field runs a second, the run rule (a module
// runs while a switched-on assistant wants it), grace on stop, restarts only where settings changed, failure isolation,
// linked defaults.
import { assert, describe, it } from "@effect/vitest"
import type { ModuleInfo } from "@pva/protocol"
import { Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { makeTool } from "../src/Module.ts"
import { defineModule, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

interface Probe {
  /** The settings of every start, in order. */
  starts: Array<{ readonly format: string; readonly place: string }>
  closes: Array<string>
  calls: Array<string>
}

/** A clock-like module: `format` is overridable, `place` is not, `token` is a secret; tool `say` answers with them. */
const datesModule = (probe: Probe, options: { readonly toolMillis?: number } = {}) =>
  defineModule({
    id: "dates",
    name: "Dates",
    description: "Says the date",
    settings: {
      format: Setting.choice({
        label: "Date format",
        options: [{ value: "en-GB", label: "13 November" }, { value: "en-US", label: "November 13" }, { value: "nl-NL", label: "13 november" }, { value: "fail", label: "Fails" }],
        default: "en-GB",
        overridable: true
      }),
      place: Setting.text({ label: "Address", default: "here" }),
      token: Setting.secret({ label: "Token" })
    },
    start: ({ settings }) =>
      Effect.gen(function*() {
        probe.starts.push({ format: settings.format, place: settings.place })
        if (settings.format === "fail") return yield* new ModuleStartError({ message: "This format cannot start" })
        const label = `${settings.format}@${settings.place}`
        yield* Effect.addFinalizer(() => Effect.sync(() => probe.closes.push(label)))
        return {
          instructions: `Dates in ${settings.format}.`,
          tools: [makeTool({
            name: "say",
            description: "say the date",
            parameters: Schema.Struct({}),
            speculative: true,
            execute: () =>
              Effect.gen(function*() {
                if ((options.toolMillis ?? 0) > 0) yield* Effect.sleep(options.toolMillis!)
                probe.calls.push(label)
                return label
              })
          })],
          context: [{ name: "Date", get: Effect.succeed(`date in ${settings.format}`) }]
        }
      })
  })

/** A host over `datesModule` whose demand is the mutable `demand` (no demand at all: a module without an entry). */
const setup = (options: { readonly defaults?: Record<string, unknown>; readonly toolMillis?: number; readonly saved?: Record<string, unknown> } = {}) =>
  Effect.gen(function*() {
    const probe: Probe = { starts: [], closes: [], calls: [] }
    const state: { demand: Array<ModuleDemand>; defaults: Record<string, unknown> | undefined } = { demand: [], defaults: options.defaults }
    const host = yield* makeModuleHost({
      catalog: [datesModule(probe, options)],
      persistence: readOnlyPersistence({ modules: { dates: { settings: options.saved ?? {} } }, secrets: {} }),
      env: {},
      demand: () => new Map([["dates", state.demand]]),
      defaults: () => state.defaults
    })
    const info = (): ModuleInfo => host.modules()[0]!
    /** What the assistant's tool says (its instance), or undefined when it has none. */
    const ask = (assistantId: string) =>
      Effect.gen(function*() {
        const parts = host.snapshot().assistantParts.get(assistantId) ?? []
        const tool = parts.flatMap((p) => p.module.tools ?? []).find((t) => t.name === "say")
        if (tool === undefined) return undefined
        return String(yield* tool.execute({}))
      })
    return { host, probe, state, info, ask }
  })

describe("module instances (WP-12b)", () => {
  it.effect("two assistants with equal settings share one instance; an own date format runs a second; each gets its own answers", () =>
    Effect.gen(function*() {
      const { ask, host, info, probe, state } = yield* setup()
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: {} }]
      yield* host.startEnabled
      assert.deepStrictEqual(probe.starts, [{ format: "en-GB", place: "here" }], "one instance for two assistants")
      const snap = host.snapshot()
      assert.strictEqual(snap.assistantParts.get("a")![0], snap.assistantParts.get("b")![0], "the same part object")
      assert.strictEqual(snap.assistantParts.get("a")![0], snap.parts[0], "and the main one")
      assert.deepStrictEqual(info().instances, [{ assistants: ["a", "b"], own: [], state: "running" }])
      assert.isTrue(info().enabled)

      // B gets its own date format: a second instance; A keeps its instance (not restarted).
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "nl-NL" } }]
      yield* host.refresh
      assert.deepStrictEqual(probe.starts.map((s) => s.format), ["en-GB", "nl-NL"])
      assert.deepStrictEqual(probe.closes, [])
      assert.strictEqual(yield* ask("a"), "en-GB@here")
      assert.strictEqual(yield* ask("b"), "nl-NL@here")
      assert.strictEqual(yield* host.snapshot().registry.context, "## Date\ndate in en-GB", "the shared registry is the shared instance")
      assert.deepStrictEqual(info().instances, [
        { assistants: ["a"], own: [], state: "running" },
        { assistants: ["b"], own: ["format"], state: "running" }
      ])
      assert.deepStrictEqual(info().tools.map((t) => t.name), ["say"])
      // A third with the same own value shares B's instance.
      state.demand = [...state.demand, { assistantId: "c", own: { format: "nl-NL" } }]
      yield* host.refresh
      assert.strictEqual(probe.starts.length, 2)
      assert.strictEqual(host.snapshot().assistantParts.get("b")![0], host.snapshot().assistantParts.get("c")![0])
      // An own value equal to the shared one is the shared instance.
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "en-GB" } }]
      yield* host.refresh
      assert.strictEqual(host.snapshot().assistantParts.get("a")![0], host.snapshot().assistantParts.get("b")![0])
      yield* advance(10_000)
      assert.deepStrictEqual(probe.closes, ["nl-NL@here"], "the instance nobody uses any more closed after the grace period")
    }).pipe(Effect.scoped))

  it.effect("the run rule: no assistant wants it, nothing runs; the saved switch is not read and enable/disable are refused", () =>
    Effect.gen(function*() {
      const { host, info, probe, state } = yield* setup()
      yield* host.startEnabled
      assert.deepStrictEqual([info().enabled, info().state, info().instances], [false, "disabled", []])
      assert.strictEqual(probe.starts.length, 0)
      const refused = yield* host.enable("dates")
      assert.strictEqual(refused.ok ? "" : refused.error.code, "not_allowed")
      const off = yield* host.disable("dates")
      assert.strictEqual(off.ok ? "" : off.error.code, "not_allowed")
      state.demand = [{ assistantId: "a" }]
      yield* host.refresh
      assert.deepStrictEqual([info().enabled, info().state], [true, "running"])
    }).pipe(Effect.scoped))

  it.effect("secrets and fields that are not overridable are refused as own values, and ignored at run time", () =>
    Effect.gen(function*() {
      const { ask, host, probe, state } = yield* setup()
      assert.deepStrictEqual(host.checkOwn("dates", { format: "nl-NL" }), [])
      assert.deepStrictEqual(host.checkOwn("dates", { token: "mine", place: "there", format: "xx", nope: 1 }), [
        { key: "token", message: "A secret is shared: it cannot be set per assistant" },
        { key: "place", message: "This setting is shared: it cannot be set per assistant" },
        { key: "format", message: "Must be one of: en-GB, en-US, nl-NL, fail" },
        { key: "nope", message: "There is no setting \"nope\"" }
      ])
      assert.deepStrictEqual(host.checkOwn("missing", {}), [{ key: null, message: "There is no module \"missing\"" }])
      const fields = host.modules()[0]!.settings.fields
      assert.deepStrictEqual(fields.map((f) => [f.key, f.overridable === true]), [["format", true], ["place", false], ["token", false]])
      // Should one get through, it changes nothing: the assistant shares the instance with the shared settings.
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { place: "there", token: "mine" } }]
      yield* host.startEnabled
      assert.strictEqual(probe.starts.length, 1)
      assert.strictEqual(yield* ask("b"), "en-GB@here")
    }).pipe(Effect.scoped))

  it.effect("grace on stop: an instance nobody wants leaves the snapshot at once, a tool call in flight finishes, it closes after 10 s", () =>
    Effect.gen(function*() {
      const { host, info, probe, state } = yield* setup({ toolMillis: 3_000 })
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "en-US" } }]
      yield* host.startEnabled
      const tool = host.snapshot().assistantParts.get("b")![0]!.module.tools![0]!
      const call = yield* Effect.forkChild(tool.execute({}))
      yield* advance(10)
      state.demand = [{ assistantId: "a" }]
      yield* host.refresh
      assert.deepStrictEqual(host.snapshot().assistantParts.get("b"), undefined)
      assert.deepStrictEqual(info().instances, [{ assistants: ["a"], own: [], state: "running" }])
      yield* advance(3_000)
      assert.strictEqual(yield* Fiber.join(call), "en-US@here", "the call finished on the retired instance")
      assert.deepStrictEqual(probe.closes, [], "still in its grace period")
      yield* advance(7_000)
      assert.deepStrictEqual(probe.closes, ["en-US@here"])
      // Nobody at all: stopping, then disabled after the grace period.
      state.demand = []
      yield* host.refresh
      assert.deepStrictEqual([info().state, info().enabled], ["stopping", false])
      assert.deepStrictEqual(host.snapshot().parts, [])
      yield* advance(10_000)
      assert.deepStrictEqual(probe.closes, ["en-US@here", "en-GB@here"])
      assert.strictEqual(info().state, "disabled")
    }).pipe(Effect.scoped))

  it.effect("a change of the shared settings restarts only the instances it affects", () =>
    Effect.gen(function*() {
      const { ask, host, probe, state } = yield* setup()
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "nl-NL" } }]
      yield* host.startEnabled
      assert.strictEqual(probe.starts.length, 2)
      // The shared format: only A's instance (B has its own) restarts.
      assert.deepStrictEqual(yield* host.configure("dates", { values: { format: "en-US" }, secrets: {} }), { ok: true })
      assert.deepStrictEqual(probe.starts.map((s) => s.format), ["en-GB", "nl-NL", "en-US"])
      assert.strictEqual(yield* ask("a"), "en-US@here")
      assert.strictEqual(yield* ask("b"), "nl-NL@here")
      // A shared field nobody overrides: both restart.
      assert.deepStrictEqual(yield* host.configure("dates", { values: { format: "en-US", place: "there" }, secrets: {} }), { ok: true })
      assert.deepStrictEqual(probe.starts.slice(3).map((s) => `${s.format}@${s.place}`).sort(), ["en-US@there", "nl-NL@there"])
      // Saving the same values again restarts nothing; a new secret restarts every instance.
      yield* host.configure("dates", { values: { format: "en-US", place: "there" }, secrets: {} })
      assert.strictEqual(probe.starts.length, 5)
      yield* host.configure("dates", { values: {}, secrets: { token: "t" } })
      assert.strictEqual(probe.starts.length, 7)
      // A shared change that one instance cannot start with changes nothing at all.
      const failed = yield* host.configure("dates", { values: { format: "fail" }, secrets: {} })
      assert.strictEqual(failed.ok ? "" : failed.error.code, "module_start_failed")
      assert.strictEqual(yield* ask("a"), "en-US@there")
      assert.strictEqual(host.modules()[0]!.settings.values.format, "en-US")
    }).pipe(Effect.scoped))

  it.effect("a module failure of one instance does not take down the other", () =>
    Effect.gen(function*() {
      const { ask, host, info, state } = yield* setup()
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "fail" } }]
      yield* host.startEnabled
      assert.strictEqual(yield* ask("a"), "en-GB@here")
      assert.strictEqual(yield* ask("b"), undefined, "B's instance did not start: B has no tool of it")
      assert.deepStrictEqual(info().instances, [
        { assistants: ["a"], own: [], state: "running" },
        { assistants: ["b"], own: ["format"], state: "error", error: "This format cannot start" }
      ])
      assert.deepStrictEqual([info().state, info().error], ["error", "This format cannot start (for b)"])
      assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name), ["say"])
      // B fixes its value: its instance runs, A's is untouched.
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "nl-NL" } }]
      yield* host.refresh
      assert.strictEqual(yield* ask("b"), "nl-NL@here")
      assert.strictEqual(info().state, "running")
    }).pipe(Effect.scoped))

  it.effect("linked defaults: used when nothing is saved, a saved value wins; a changed default restarts the instances it moves", () =>
    Effect.gen(function*() {
      const { ask, host, info, state } = yield* setup({ defaults: { format: "nl-NL" } })
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "en-US" } }]
      yield* host.startEnabled
      assert.strictEqual(yield* ask("a"), "nl-NL@here")
      assert.strictEqual(yield* ask("b"), "en-US@here")
      const field = info().settings.fields.find((f) => f.key === "format")!
      assert.deepStrictEqual([info().settings.values.format, field.source, "default" in field ? field.default : undefined], ["nl-NL", "default", "nl-NL"])
      state.defaults = { format: "en-GB" }
      yield* host.refresh
      assert.strictEqual(yield* ask("a"), "en-GB@here")
      assert.strictEqual(yield* ask("b"), "en-US@here")
      // A default the field refuses is ignored.
      state.defaults = { format: "klingon" }
      yield* host.refresh
      assert.strictEqual(yield* ask("a"), "en-GB@here")
    }).pipe(Effect.scoped))

  it.effect("a replaced instance keeps serving until its replacement has started", () =>
    Effect.gen(function*() {
      const { ask, host, state } = yield* setup({ defaults: { format: "nl-NL" } })
      state.demand = [{ assistantId: "a" }]
      yield* host.startEnabled
      state.defaults = { format: "en-US" }
      const fiber = yield* Effect.forkChild(host.refresh)
      // Before the new instance has published (the refresh has not run yet or is starting), A still has a tool.
      assert.include(["nl-NL@here", "en-US@here"], yield* ask("a"))
      yield* Fiber.join(fiber)
      assert.strictEqual(yield* ask("a"), "en-US@here")
    }).pipe(Effect.scoped))

  it.effect("a module without demand keeps one instance following its switch, with linked defaults", () =>
    Effect.gen(function*() {
      const probe: Probe = { starts: [], closes: [], calls: [] }
      const host = yield* makeModuleHost({
        catalog: [datesModule(probe)],
        persistence: readOnlyPersistence(),
        env: {},
        demand: () => new Map(),
        defaults: () => ({ format: "en-US" })
      })
      yield* host.startEnabled
      assert.deepStrictEqual(probe.starts, [{ format: "en-US", place: "here" }])
      assert.strictEqual(host.modules()[0]!.instances, undefined)
      assert.deepStrictEqual(yield* host.disable("dates"), { ok: true })
      assert.strictEqual(host.snapshot().assistantParts.size, 0)
    }).pipe(Effect.scoped))
})
