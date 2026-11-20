// Module instances keyed by effective settings (docs/ASSISTANTS.md §2.6, WP-12b): assistants with equal settings
// share one instance, an assistant with its own value of an `overridable` field runs a second, the run rule (a module
// runs while a switched-on assistant wants it), linked defaults. Since P1 review round 3 the module is the unit: a
// change of its instances stops all of it (calls in flight get the grace period) before it starts again, and a start
// is published only if every instance started (docs/ARCHITECTURE.md "Module host").
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
const datesModule = (probe: Probe, options: { readonly toolMillis?: number; readonly slowFormat?: string } = {}) =>
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
        if (settings.format === options.slowFormat) yield* Effect.sleep(1_000)
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
const setup = (
  options: {
    readonly defaults?: Record<string, unknown>
    readonly toolMillis?: number
    readonly slowFormat?: string
    readonly saved?: Record<string, unknown>
  } = {}
) =>
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
        // Through the gateway: a published tool's own `execute` only refuses.
        return String(yield* host.gateway.tool("dates", tool, {}))
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

      // B gets its own date format: a second instance; the module stops and starts again with both.
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "nl-NL" } }]
      yield* host.refresh
      assert.deepStrictEqual(probe.starts.map((s) => s.format), ["en-GB", "en-GB", "nl-NL"])
      assert.deepStrictEqual(probe.closes, ["en-GB@here"], "the old instance closed before the new ones started")
      assert.strictEqual(yield* ask("a"), "en-GB@here")
      assert.strictEqual(yield* ask("b"), "nl-NL@here")
      assert.strictEqual(yield* host.snapshot().registry.context, "## Date\ndate in en-GB", "the shared registry is the shared instance")
      assert.deepStrictEqual(info().instances, [
        { assistants: ["a"], own: [], state: "running" },
        { assistants: ["b"], own: ["format"], state: "running" }
      ])
      assert.deepStrictEqual(info().tools.map((t) => t.name), ["say"])
      // A third with the same own value shares B's instance: only who uses which changes, nothing restarts.
      state.demand = [...state.demand, { assistantId: "c", own: { format: "nl-NL" } }]
      yield* host.refresh
      assert.strictEqual(probe.starts.length, 3)
      assert.strictEqual(host.snapshot().assistantParts.get("b")![0], host.snapshot().assistantParts.get("c")![0])
      // An own value equal to the shared one is the shared instance (B's own instance goes: a restart).
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "en-GB" } }]
      yield* host.refresh
      assert.strictEqual(host.snapshot().assistantParts.get("a")![0], host.snapshot().assistantParts.get("b")![0])
      assert.deepStrictEqual(probe.closes, ["en-GB@here", "en-GB@here", "nl-NL@here"])
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

  it.effect("grace on stop: withdrawn at once, a tool call in flight finishes within the grace period, then it closes", () =>
    Effect.gen(function*() {
      const { host, info, probe, state } = yield* setup({ toolMillis: 3_000 })
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "en-US" } }]
      yield* host.startEnabled
      const tool = host.snapshot().assistantParts.get("b")![0]!.module.tools![0]!
      const call = yield* Effect.forkChild(host.gateway.tool("dates", tool, {}))
      yield* advance(10)
      state.demand = [{ assistantId: "a" }]
      const refreshing = yield* Effect.forkChild(host.refresh)
      yield* advance(10)
      assert.deepStrictEqual(host.snapshot().parts, [], "the whole module is withdrawn while it stops")
      assert.strictEqual(info().state, "stopping")
      yield* advance(3_000)
      assert.strictEqual(yield* Fiber.join(call), "en-US@here", "the call finished on the withdrawn instance")
      yield* Fiber.join(refreshing)
      assert.deepStrictEqual(probe.closes.sort(), ["en-GB@here", "en-US@here"])
      assert.deepStrictEqual(info().instances, [{ assistants: ["a"], own: [], state: "running" }])
      // A call that outlives the grace period is interrupted, and the stop goes on.
      const long = yield* Effect.forkChild(host.gateway.tool("dates", host.snapshot().parts[0]!.module.tools![0]!, {}))
      yield* advance(10)
      state.demand = []
      const stopping = yield* Effect.forkChild(host.refresh)
      yield* advance(10)
      assert.deepStrictEqual([info().state, info().enabled], ["stopping", false])
      yield* advance(2_000)
      assert.strictEqual(probe.closes.length, 2, "it waits for the call")
      yield* advance(1_000)
      yield* Fiber.join(stopping)
      yield* Fiber.join(long)
      assert.strictEqual(probe.closes.length, 3)
      assert.strictEqual(info().state, "disabled")
    }).pipe(Effect.scoped))

  it.effect("a change of the shared settings stops the module and starts it again with every instance", () =>
    Effect.gen(function*() {
      const { ask, host, probe, state } = yield* setup()
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "nl-NL" } }]
      yield* host.startEnabled
      assert.strictEqual(probe.starts.length, 2)
      assert.deepStrictEqual(yield* host.configure("dates", { values: { format: "en-US" }, secrets: {} }), { ok: true })
      assert.deepStrictEqual(probe.starts.slice(2).map((s) => s.format).sort(), ["en-US", "nl-NL"])
      assert.strictEqual(yield* ask("a"), "en-US@here")
      assert.strictEqual(yield* ask("b"), "nl-NL@here")
      // Saving the same values again restarts nothing; a new secret restarts it; the same secret again does not.
      yield* host.configure("dates", { values: { format: "en-US" }, secrets: {} })
      assert.strictEqual(probe.starts.length, 4)
      yield* host.configure("dates", { values: {}, secrets: { token: "t" } })
      assert.strictEqual(probe.starts.length, 6)
      yield* host.configure("dates", { values: {}, secrets: { token: "t" } })
      assert.strictEqual(probe.starts.length, 6, "an unchanged secret saved again changes nothing")
      // A shared change that one instance cannot start with: the module is down (nothing of it serves), and says why.
      const failed = yield* host.configure("dates", { values: { format: "fail" }, secrets: {} })
      assert.strictEqual(failed.ok ? "" : failed.error.code, "module_start_failed")
      assert.strictEqual(yield* ask("a"), undefined)
      assert.strictEqual(yield* ask("b"), undefined)
      assert.strictEqual(host.modules()[0]!.state, "error")
      assert.strictEqual(probe.closes.length, probe.starts.filter((st) => st.format !== "fail").length, "everything that started closed")
    }).pipe(Effect.scoped))

  it.effect("an instance that fails takes its module down (all or nothing); a valid change starts it again", () =>
    Effect.gen(function*() {
      const { ask, host, info, state } = yield* setup()
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "fail" } }]
      yield* host.startEnabled
      assert.strictEqual(yield* ask("a"), undefined)
      assert.strictEqual(yield* ask("b"), undefined)
      assert.deepStrictEqual(info().instances, [
        { assistants: ["a"], own: [], state: "error", error: "This format cannot start" },
        { assistants: ["b"], own: ["format"], state: "error", error: "This format cannot start" }
      ])
      assert.deepStrictEqual([info().state, info().error], ["error", "This format cannot start"])
      assert.isTrue(host.issues.all().some((i) => i.id === "dates.start"))
      // B fixes its value: the module starts again, both run.
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "nl-NL" } }]
      yield* host.refresh
      assert.strictEqual(yield* ask("a"), "en-GB@here")
      assert.strictEqual(yield* ask("b"), "nl-NL@here")
      assert.strictEqual(info().state, "running")
    }).pipe(Effect.scoped))

  it.effect("an assistant whose own value is not valid gets an error of its own; the others run", () =>
    Effect.gen(function*() {
      const { ask, host, info, probe, state } = yield* setup()
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "klingon" } }]
      yield* host.startEnabled
      assert.strictEqual(yield* ask("a"), "en-GB@here")
      assert.strictEqual(yield* ask("b"), undefined)
      assert.strictEqual(probe.starts.length, 1, "never grouped with A's valid instance, never started")
      assert.strictEqual(info().state, "error")
      assert.match(info().error!, /\(for b\)$/)
    }).pipe(Effect.scoped))

  it.effect("linked defaults: used when nothing is saved, a saved value wins; a changed default restarts the module", () =>
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

  it.effect("while a replacement starts the module is absent: an assistant has no tool of it, never two of it", () =>
    Effect.gen(function*() {
      const { ask, host, info, state } = yield* setup({ slowFormat: "nl-NL" })
      state.demand = [{ assistantId: "a" }, { assistantId: "b" }]
      yield* host.startEnabled
      state.demand = [{ assistantId: "a" }, { assistantId: "b", own: { format: "nl-NL" } }]
      const fiber = yield* Effect.forkChild(host.refresh)
      yield* advance(10)
      assert.deepStrictEqual(info().instances?.map((r) => [r.assistants, r.state]), [[["a"], "starting"], [["b"], "starting"]])
      assert.strictEqual(yield* ask("b"), undefined)
      assert.strictEqual(yield* ask("a"), undefined)
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.strictEqual(yield* ask("b"), "nl-NL@here")
      assert.strictEqual(yield* ask("a"), "en-GB@here")
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
