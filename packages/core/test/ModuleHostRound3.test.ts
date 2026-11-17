// Module API v2, review round 3 (p1-r3a): each test is the reviewer's sequence of events for one host finding, against
// the host as it is now: one worker, one module at a time, stop before start, every call into module code bounded
// (docs/ARCHITECTURE.md "Module host"). Each ends with the host working and every failure on the Health page.
import { assert, describe, it } from "@effect/vitest"
import type { ModuleInfo } from "@pva/protocol"
import { Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeTool } from "../src/Module.ts"
import { type RequirementCheck, ServiceKey } from "../src/ModuleApi.ts"
import { defineModule, type ModuleDefinition, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, type ModulePersistence, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import type { Registrar } from "../src/ModuleRegistrations.ts"
import { Setting } from "../src/Settings.ts"

const settle = Effect.repeat(Effect.yieldNow, { times: 50 })
const advance = (millis: number) => Effect.andThen(settle, TestClock.adjust(millis))
/** Wait for a fiber while letting the test clock run, in steps of a second. */
const joinWithin = <A, E>(fiber: Fiber.Fiber<A, E>, ms: number) =>
  Effect.gen(function*() {
    for (let t = 0; t <= ms; t += 1_000) {
      yield* settle
      const done = fiber.pollUnsafe()
      if (done !== undefined) return done
      yield* TestClock.adjust(1_000)
    }
    return assert.fail(`not finished within ${ms} ms`)
  })

const demandOf = (entries: Record<string, ReadonlyArray<ModuleDemand>>) => ({ current: new Map(Object.entries(entries)) as Map<string, ReadonlyArray<ModuleDemand>> })
const hostOf = (
  catalog: ReadonlyArray<ModuleDefinition<any>>,
  demand: { current: Map<string, ReadonlyArray<ModuleDemand>> } | undefined,
  extra: Partial<Parameters<typeof makeModuleHost>[0]> = {}
) => makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {}, ...(demand !== undefined ? { demand: () => demand.current } : {}), ...extra })
const info = (host: { readonly modules: () => ReadonlyArray<ModuleInfo> }, id: string) => host.modules().find((m) => m.id === id)!

interface Svc {
  readonly name: string
}
const Svc = ServiceKey<Svc>("r3.svc")

/** A simple module: `shared` and `start` run `hooks` (log lines, faults); its tool is `<id>_tool`. */
const mod = (
  id: string,
  log: Array<string>,
  hooks: {
    readonly shared?: Effect.Effect<void, ModuleStartError, Scope.Scope>
    readonly start?: (settings: { readonly place: string }) => Effect.Effect<void, ModuleStartError, Scope.Scope>
    readonly service?: boolean
    readonly uses?: ReadonlyArray<string>
    readonly requires?: ModuleDefinition["requires"]
  } = {}
) =>
  defineModule({
    apiVersion: 2,
    id,
    name: id.toUpperCase(),
    description: "",
    ...(hooks.uses !== undefined ? { uses: hooks.uses } : {}),
    ...(hooks.requires !== undefined ? { requires: hooks.requires } : {}),
    settings: { place: Setting.text({ label: "Place", default: "P1", overridable: true }), token: Setting.secret({ label: "Token" }) },
    shared: () =>
      Effect.gen(function*() {
        log.push(`${id}:shared+`)
        yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`${id}:shared-`)))
        if (hooks.shared !== undefined) yield* hooks.shared
        return { value: undefined, ...(hooks.service === true ? { services: [Svc.of({ name: id })] } : {}) }
      }),
    start: ({ settings }) =>
      Effect.gen(function*() {
        log.push(`${id}:start+${settings.place}`)
        yield* Effect.addFinalizer(() => Effect.sync(() => void log.push(`${id}:stop-${settings.place}`)))
        if (hooks.start !== undefined) yield* hooks.start(settings)
        return { tools: [makeTool({ name: `${id}_tool`, description: "", parameters: Schema.Struct({}), execute: () => Effect.sync(() => (log.push(`${id}:called`), id)) })] }
      })
  })

describe("module code that hangs or ends badly never takes the worker with it (findings 1–3)", () => {
  it.effect("1: a finalizer that never returns: the stop is abandoned after its limit, reported, and the host goes on and closes", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const scope = yield* Scope.make()
      const stuck = mod("stuck", log, { start: () => Effect.addFinalizer(() => Effect.never) })
      const other = mod("other", log)
      const demand = demandOf({ stuck: [{ assistantId: "a" }], other: [] })
      const host = yield* hostOf([stuck, other], demand, { stopTimeoutMs: 2_000, closeTimeoutMs: 10_000 }).pipe(Scope.provide(scope))
      yield* Effect.forkChild(host.startEnabled)
      yield* advance(10)
      demand.current = new Map([["stuck", []], ["other", [{ assistantId: "a" }]]])
      const refreshing = yield* Effect.forkChild(host.refresh)
      yield* joinWithin(refreshing, 10_000)
      assert.strictEqual(info(host, "stuck").state, "disabled")
      assert.strictEqual(info(host, "other").state, "running", "the worker moved on")
      assert.isTrue(host.issues.all().some((i) => i.module === "stuck" && i.title === "STUCK did not finish stopping"))
      // The same hang at host close: close returns within its bound.
      demand.current = new Map([["stuck", [{ assistantId: "a" }]], ["other", [{ assistantId: "a" }]]])
      yield* joinWithin(yield* Effect.forkChild(host.refresh), 10_000)
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* joinWithin(closing, 12_000)
      assert.include(log, "other:shared-")
    }))

  it.effect("1: a start that never returns, even uninterruptibly: abandoned at its limit; the module is down; the worker goes on", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const host = yield* hostOf([mod("hangs", log, { shared: Effect.uninterruptible(Effect.never) }), mod("next", log)], demandOf({ hangs: [{ assistantId: "a" }], next: [{ assistantId: "a" }] }))
      const starting = yield* Effect.forkChild(host.startEnabled)
      yield* joinWithin(starting, 30_000)
      assert.deepStrictEqual([info(host, "hangs").state, info(host, "hangs").error], ["error", "Its shared part did not start within 10 s"])
      assert.strictEqual(info(host, "next").state, "running")
      assert.include(log, "hangs:shared-", "its scope was closed (the finalizer it added before hanging ran)")
    }))

  it.effect("2: a start that interrupts itself is a start failure; the worker lives and every later trigger completes", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const host = yield* hostOf([mod("selfstop", log, { shared: Effect.interrupt }), mod("next", log)], demandOf({ selfstop: [{ assistantId: "a" }], next: [] }))
      yield* host.startEnabled
      assert.deepStrictEqual([info(host, "selfstop").state, info(host, "selfstop").error], ["error", "It was interrupted while starting"])
      assert.include(log, "selfstop:shared-")
      const result = yield* host.configure("next", { values: { place: "P2" }, secrets: {} })
      assert.isTrue(result.ok)
      yield* host.refresh
      yield* host.recheck
    }))

  it.effect("2: a defect thrown inside start is a start failure, and so is one thrown while its registrations are read (3)", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const throwing: Registrar = ({ handle }) => {
        if (handle.moduleId === "reg") throw new Error("registrar broke")
        return []
      }
      const host = yield* hostOf(
        [mod("boom", log, { start: () => Effect.sync(() => { throw new Error("thrown") }) }), mod("reg", log), mod("fine", log)],
        demandOf({ boom: [{ assistantId: "a" }], reg: [{ assistantId: "a" }], fine: [{ assistantId: "a" }] }),
        { registrars: [throwing] }
      )
      yield* host.startEnabled
      assert.match(info(host, "boom").error ?? "", /crashed while starting/)
      assert.match(info(host, "reg").error ?? "", /registrations could not be read: registrar broke/)
      assert.includeMembers(log, ["boom:stop-P1", "boom:shared-", "reg:stop-P1", "reg:shared-"], "everything that started was closed")
      assert.strictEqual(info(host, "fine").state, "running")
      assert.isFalse((yield* host.refresh.pipe(Effect.as(false))))
    }))
})

describe("publishing and withdrawing are all or nothing (finding 4; round 2 finding 4)", () => {
  it.effect("4: a publish that throws withdraws what this step published of the module; the module is down; a withdraw that throws is reported", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const table = new Set<string>()
      let breakPublish = true
      let breakWithdraw = false
      const kinds: Registrar = ({ handle, instance }) =>
        instance === undefined || handle.moduleId !== "sub" ? [] : [
          { kind: "first", publish: () => void table.add("first"), withdraw: () => void table.delete("first") },
          {
            kind: "second",
            publish: () => {
              if (breakPublish) throw new Error("table full")
              table.add("second")
            },
            withdraw: () => {
              if (breakWithdraw) throw new Error("gone already")
              table.delete("second")
            }
          }
        ]
      const demand = demandOf({ sub: [{ assistantId: "a" }] })
      const host = yield* hostOf([mod("sub", log, { service: true })], demand, { registrars: [kinds] })
      yield* host.startEnabled
      assert.deepStrictEqual([...table], [], "the first registration was withdrawn again")
      assert.strictEqual(host.service(Svc), undefined, "nothing of it is published")
      assert.match(info(host, "sub").error ?? "", /second could not be published: table full/)
      assert.includeMembers(log, ["sub:stop-P1", "sub:shared-"])
      breakPublish = false
      yield* host.recheck
      assert.deepStrictEqual([...table].sort(), ["first", "second"])
      // A withdraw that throws: reported, and the stop goes on (the other registration is withdrawn, the scope closes).
      breakWithdraw = true
      demand.current = new Map([["sub", []]])
      yield* host.refresh
      assert.deepStrictEqual([...table], ["second"])
      assert.strictEqual(host.service(Svc), undefined)
      assert.isTrue(host.issues.all().some((i) => i.title === "SUB: its second could not be withdrawn"))
      assert.include(log, "sub:shared-")
    }))
})

describe("interrupted callers (findings 5, 16)", () => {
  it.effect("5: a caller interrupted right after its write: the change and its save stay", () =>
    Effect.gen(function*() {
      const saves: Array<{ readonly id: string; readonly enabled: boolean }> = []
      const persistence: ModulePersistence = { initial: { modules: {}, secrets: {} }, save: (id, record) => Effect.sync(() => void saves.push({ id, enabled: record.enabled })) }
      const log: Array<string> = []
      const host = yield* hostOf([{ ...mod("m", log), enabledByDefault: false } as ModuleDefinition<any>], undefined, { persistence })
      const fiber = yield* Effect.forkChild(host.enable("m"), { startImmediately: true })
      yield* Fiber.interrupt(fiber)
      yield* settle
      assert.deepStrictEqual(saves, [{ id: "m", enabled: true }])
      assert.strictEqual(info(host, "m").state, "running")
    }))

  it.effect("16: many configures whose callers gave up: the last change applies, and nothing is kept for them (there is no per-caller state)", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const host = yield* hostOf([mod("m", log)], demandOf({ m: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      for (let i = 0; i < 200; i++) {
        const fiber = yield* Effect.forkChild(host.configure("m", { values: { place: `P${i}` }, secrets: {} }), { startImmediately: true })
        yield* Fiber.interrupt(fiber)
      }
      yield* host.refresh
      assert.strictEqual(info(host, "m").settings.values.place, "P199")
      assert.include(log, "m:start+P199")
    }))
})

describe("one picture per pass (findings 6, 12, 13)", () => {
  it.effect("6: a module judged unavailable while another starts: what is published stays consistent with the pass's own picture", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const gate = yield* Deferred.make<void>()
      let missing = false
      const requirements: RequirementCheck = (rs) => rs.map((requirement) => ({ requirement, state: missing ? "missing" : "met", detail: missing ? "mpv is missing" : "mpv 1.0.0" }))
      const a = mod("a", log, { service: true, requires: [{ tool: "mpv", why: "Plays" }] })
      const b = mod("b", log, { shared: Deferred.await(gate) })
      const demand = demandOf({ a: [{ assistantId: "x" }], b: [] })
      const host = yield* hostOf([a, b], demand, { requirements })
      yield* host.startEnabled
      const consistent = () => {
        const parts = host.snapshot().parts.filter((p) => p.moduleId === "a")
        const service = host.service(Svc)
        if (service !== undefined) assert.isTrue(parts.length === 1 && parts[0]!.unavailable !== true, "a's service with a's tools")
        else assert.isTrue(parts.every((p) => p.unavailable === true), "no service: a is shown unavailable or absent")
      }
      demand.current = new Map([["a", [{ assistantId: "x" }]], ["b", [{ assistantId: "x" }]]])
      const refreshing = yield* Effect.forkChild(host.refresh)
      yield* settle
      missing = true
      const rechecking = yield* Effect.forkChild(host.recheck)
      yield* settle
      consistent()
      assert.deepStrictEqual(host.service(Svc), { name: "a" }, "the pass that is running still publishes its own picture")
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(refreshing)
      yield* Fiber.join(rechecking)
      consistent()
      assert.strictEqual(info(host, "a").state, "unavailable")
      assert.strictEqual(host.service(Svc), undefined)
    }))

  it.effect("12: a first provider that fails and a second that starts: the consumer's start sees the second, the only one ever published", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const seen: Array<string | undefined> = []
      const bad = mod("bad", log, { service: true, start: () => Effect.fail(new ModuleStartError({ message: "bad instance" })) })
      const good = mod("good", log, { service: true })
      const consumer = defineModule({
        apiVersion: 2,
        id: "cons",
        name: "Cons",
        description: "",
        uses: ["good"],
        start: ({ host }) => Effect.sync(() => (seen.push(host.service(Svc)?.name), {}))
      })
      const host = yield* hostOf([bad, good, consumer], demandOf({ bad: [{ assistantId: "a" }], good: [{ assistantId: "a" }], cons: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      assert.deepStrictEqual(seen, ["good"])
      assert.include(log, "bad:shared-", "the failed provider was closed before anything else started")
      assert.isTrue(log.indexOf("bad:shared-") < log.indexOf("good:shared+"))
    }))
})

describe("stopping: order and calls (findings 7, 15)", () => {
  it.effect("7: a consumer and its provider stop in one pass: the consumer first (instances, then shared), then the provider; one after another", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const flush = yield* Deferred.make<void>()
      const provider = mod("prov", log, { service: true })
      const consumer = mod("cons", log, { uses: ["prov"], start: () => Effect.addFinalizer(() => Effect.andThen(Effect.sync(() => void log.push("cons:flushing")), Deferred.await(flush))) })
      const demand = demandOf({ prov: [{ assistantId: "a" }], cons: [{ assistantId: "a" }] })
      const host = yield* hostOf([consumer, provider], demand)
      yield* host.startEnabled
      demand.current = new Map([["prov", []], ["cons", []]])
      const stopping = yield* Effect.forkChild(host.refresh)
      yield* settle
      assert.include(log, "cons:flushing")
      assert.notInclude(log, "prov:stop-P1", "the provider waits for its consumer's finalizer")
      yield* Deferred.succeed(flush, undefined)
      yield* Fiber.join(stopping)
      const closes = log.filter((l) => l.includes("-") && (l.includes(":stop") || l.includes(":shared")))
      assert.deepStrictEqual(closes, ["cons:stop-P1", "cons:shared-", "prov:stop-P1", "prov:shared-"])
    }))

  it.effect("15: once withdrawn, an old snapshot's tool is refused at once, while the module's finalizers still run", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const slowClose = yield* Deferred.make<void>()
      const m = mod("m", log, { start: () => Effect.addFinalizer(() => Deferred.await(slowClose)) })
      const demand = demandOf({ m: [{ assistantId: "a" }] })
      const host = yield* hostOf([m], demand)
      yield* host.startEnabled
      const old = host.snapshot()
      demand.current = new Map([["m", []]])
      const stopping = yield* Effect.forkChild(host.refresh)
      yield* settle
      assert.strictEqual(info(host, "m").state, "stopping")
      const late = yield* old.registry.run({ id: "1", name: "m_tool", input: {} })
      assert.isTrue(late.isError)
      assert.notInclude(log, "m:called")
      yield* Deferred.succeed(slowClose, undefined)
      yield* Fiber.join(stopping)
    }))
})

describe("a failure is tried again when something it depends on changes (findings 8–10, 17, 18)", () => {
  it.effect("8: one assistant's instance fails; that assistant corrects its own value: the module is tried again", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const m = mod("m", log, { start: (s) => (s.place === "Bad" ? Effect.fail(new ModuleStartError({ message: "no Bad" })) : Effect.void) })
      const demand = demandOf({ m: [{ assistantId: "a" }, { assistantId: "b", own: { place: "Bad" } }] })
      const host = yield* hostOf([m], demand)
      yield* host.startEnabled
      assert.strictEqual(info(host, "m").state, "error")
      demand.current = new Map([["m", [{ assistantId: "a" }, { assistantId: "b", own: { place: "Good" } }]]])
      yield* host.refresh
      assert.strictEqual(info(host, "m").state, "running")
      // Removing the failing assistant instead is a change too.
      demand.current = new Map([["m", [{ assistantId: "a" }, { assistantId: "b", own: { place: "Bad" } }]]])
      yield* host.refresh
      assert.strictEqual(info(host, "m").state, "error")
      demand.current = new Map([["m", [{ assistantId: "a" }]]])
      yield* host.refresh
      assert.strictEqual(info(host, "m").state, "running")
    }))

  it.effect("9: the vault unlocks while another module's start holds the pass: the module that lacked its key starts in the next pass", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const gate = yield* Deferred.make<void>()
      const keyed = defineModule({
        apiVersion: 2,
        id: "keyed",
        name: "Keyed",
        description: "",
        settings: { token: Setting.secret({ label: "Token", required: true }) },
        start: ({ settings }) => Effect.sync(() => (log.push(`keyed:${settings.token}`), {}))
      })
      const slow = mod("slow", log, { shared: Deferred.await(gate) })
      const host = yield* hostOf([slow, keyed], demandOf({ keyed: [{ assistantId: "a" }], slow: [{ assistantId: "a" }] }))
      const starting = yield* Effect.forkChild(host.startEnabled)
      yield* settle
      const unlocking = yield* Effect.forkChild(host.setSecrets({ keyed: { token: "k" } }))
      yield* settle
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(starting)
      yield* Fiber.join(unlocking)
      assert.strictEqual(info(host, "keyed").state, "running")
      assert.include(log, "keyed:k")
    }))

  it.effect("10: an assistant whose instance failed leaves and comes back with the fault gone: it runs (no memo outlives its demand)", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const fault = { current: true }
      const m = mod("m", log, { start: (s) => (s.place === "B" && fault.current ? Effect.fail(new ModuleStartError({ message: "no B" })) : Effect.void) })
      const demand = demandOf({ m: [{ assistantId: "a" }, { assistantId: "b", own: { place: "B" } }] })
      const host = yield* hostOf([m], demand)
      yield* host.startEnabled
      assert.strictEqual(info(host, "m").state, "error")
      demand.current = new Map([["m", [{ assistantId: "a" }]]])
      yield* host.refresh
      assert.strictEqual(info(host, "m").state, "running")
      fault.current = false
      demand.current = new Map([["m", [{ assistantId: "a" }, { assistantId: "b", own: { place: "B" } }]]])
      yield* host.refresh
      assert.strictEqual(info(host, "m").state, "running")
      assert.deepStrictEqual(info(host, "m").instances?.map((i) => i.assistants), [["a"], ["b"]])
    }))

  it.effect("17: a valid and an invalid assistant whose fallback values are equal, in both orders: never grouped; the invalid one has its error", () =>
    Effect.gen(function*() {
      for (const order of [["a", "b"], ["b", "a"]] as const) {
        const log: Array<string> = []
        const m = defineModule({
          id: "wx",
          name: "Weather",
          description: "",
          settings: { place: Setting.text({ label: "Place", default: "Amsterdam", overridable: true, check: (v) => (v.trim() === "" ? "Say where" : undefined) }) },
          start: ({ settings }) => Effect.sync(() => (log.push(settings.place), {}))
        })
        const demands: Record<string, ModuleDemand> = { a: { assistantId: "a" }, b: { assistantId: "b", own: { place: " " } } }
        const host = yield* hostOf([m], demandOf({ wx: order.map((id) => demands[id]!) }))
        yield* host.startEnabled
        assert.deepStrictEqual(log, ["Amsterdam"])
        const instances = info(host, "wx").instances ?? []
        assert.deepStrictEqual(instances.find((i) => i.assistants.includes("a"))?.state, "running")
        assert.deepStrictEqual(instances.find((i) => i.assistants.includes("b"))?.state, "error")
        assert.isTrue(host.issues.all().some((i) => i.id === "wx.start" && /for b/.test(i.detail)))
      }
    }).pipe(Effect.scoped))

  it.effect("18: Check again retries a start that failed though no probe result changed", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const endpoint = { up: false }
      const m = mod("m", log, { shared: Effect.suspend(() => (endpoint.up ? Effect.void : Effect.fail(new ModuleStartError({ message: "endpoint down" })))) })
      const host = yield* hostOf([m], demandOf({ m: [{ assistantId: "a" }] }), { requirements: (rs) => rs.map((requirement) => ({ requirement, state: "met", detail: "ok" })) })
      yield* host.startEnabled
      assert.strictEqual(info(host, "m").state, "error")
      endpoint.up = true
      yield* host.refresh
      assert.strictEqual(info(host, "m").state, "error", "nothing it depends on changed: not tried again by itself")
      yield* host.recheck
      assert.strictEqual(info(host, "m").state, "running")
    }))
})

describe("restarts (finding 11; round 2 finding 17)", () => {
  it.effect("11: requests from two instances and the shared part within the interval: merged into one restart afterwards, none lost", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const restarts: Array<(reason: string) => Effect.Effect<void>> = []
      let starts = 0
      const m = defineModule({
        apiVersion: 2,
        id: "m",
        name: "M",
        description: "",
        settings: { place: Setting.text({ label: "Place", default: "P1", overridable: true }) },
        shared: ({ host }) => Effect.sync(() => (restarts.push(host.requestRestart), { value: undefined })),
        start: ({ host, settings }) => Effect.sync(() => (starts++, log.push(settings.place), restarts.push(host.requestRestart), {}))
      })
      const host = yield* hostOf([m], demandOf({ m: [{ assistantId: "a" }, { assistantId: "b", own: { place: "P2" } }] }))
      yield* host.startEnabled
      assert.strictEqual(starts, 2)
      yield* restarts[1]!("X changed")
      yield* settle
      assert.strictEqual(starts, 4, "the first request restarts at once")
      for (const r of restarts.slice(3)) yield* r("changed again")
      yield* advance(1_000)
      assert.strictEqual(starts, 4, "the next waits for the interval")
      yield* advance(5_000)
      assert.strictEqual(starts, 6, "all of them in one restart")
      yield* advance(30_000)
      assert.strictEqual(starts, 6, "and no more")
    }))
})
