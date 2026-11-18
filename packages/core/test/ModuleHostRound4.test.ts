// Module API v2, review round 4 (p1-r4a): each test is the reviewer's sequence of events for one host finding that the
// lead decided to fix (docs/MODULES-PLAN.md §4 P1, "Decided after review round 4"), against the host as it is now.
import { assert, describe, it } from "@effect/vitest"
import { decodeServerMessage, encodeServerMessage, type ModuleInfo } from "@pva/protocol"
import { exampleAdminSnapshot } from "@pva/protocol/examples"
import { Cause, Deferred, Effect, Exit, Fiber, Scheduler, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeIssueRegistry } from "../src/Issues.ts"
import { makeTool } from "../src/Module.ts"
import { ContributionKey, isModuleStopped, type ModuleHostApi, ServiceKey } from "../src/ModuleApi.ts"
import { defineModule, type ModuleDefinition, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, type ModulePersistence, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import type { PartHandle, RegisterResult, Registrar } from "../src/ModuleRegistrations.ts"
import { Setting } from "../src/Settings.ts"
import { CurrentTurn } from "../src/TurnContext.ts"

const settle = Effect.repeat(Effect.yieldNow, { times: 50 })
const advance = (millis: number) => Effect.andThen(settle, TestClock.adjust(millis))
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
const Svc = ServiceKey<Svc>("r4.svc")
const Section = ContributionKey<string>("r4.section")

const toolOf = (name: string, log: Array<string>) =>
  makeTool({ name, description: "", parameters: Schema.Struct({}), execute: () => Effect.sync(() => (log.push(`${name}:called`), name)) })

describe("host shutdown withdraws everything first (finding 2)", () => {
  it.effect("2: the close budget runs out on the first module: the second's handlers are already uncallable, its tools absent, its context stopped", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const hosts: Record<string, ModuleHostApi> = {}
      const scope = yield* Scope.make()
      // Shutdown walks consumers first, so "stuck" (last in uses order) is visited first; its finalizer never returns.
      const second = defineModule({
        apiVersion: 2,
        id: "second",
        name: "Second",
        description: "",
        shared: ({ host }) => Effect.sync(() => ((hosts.second = host), { value: undefined, services: [Svc.of({ name: "second" })] })),
        start: () => Effect.succeed({ tools: [toolOf("second_tool", log)] })
      })
      const stuck = defineModule({
        apiVersion: 2,
        id: "stuck",
        name: "Stuck",
        description: "",
        uses: ["second"],
        start: () => Effect.map(Effect.addFinalizer(() => Effect.never), () => ({ tools: [toolOf("stuck_tool", log)] }))
      })
      const host = yield* hostOf([second, stuck], demandOf({ second: [{ assistantId: "a" }], stuck: [{ assistantId: "a" }] }), { stopTimeoutMs: 60_000, closeTimeoutMs: 3_000 })
        .pipe(Scope.provide(scope))
      yield* host.startEnabled
      const held = host.snapshot()
      assert.includeMembers(held.registry.specs.map((s) => s.name), ["second_tool", "stuck_tool"])
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* settle
      const check = (when: string) =>
        Effect.gen(function*() {
          assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name), [], `${when}: no tools in the current snapshot`)
          assert.strictEqual(host.service(Svc), undefined, `${when}: its service is withdrawn`)
          const late = yield* held.registry.run({ id: "1", name: "second_tool", input: {} })
          assert.isTrue(late.isError, `${when}: a held snapshot's tool is refused`)
          assert.throws(() => hosts.second!.view(), /has stopped/, `${when}: its context answers ModuleStopped`)
        })
      yield* check("while the first module still closes")
      yield* joinWithin(closing, 10_000)
      yield* check("after the close gave up")
      assert.notInclude(log, "second_tool:called")
    }))
})

describe("a module's plain functions that throw are that module's error (finding 4A)", () => {
  const broken = { current: false }
  const base = Setting.text({ label: "Place", default: "P1", overridable: true })
  const place = { ...base, decode: (raw: unknown) => {
    if (broken.current) throw new Error("decoder broke")
    return base.decode(raw)
  } }
  const m = defineModule({ id: "m", name: "M", description: "", settings: { place }, start: () => Effect.succeed({ tools: [] }) })
  const other = defineModule({ id: "other", name: "Other", description: "", start: () => Effect.succeed({}) })

  it.effect("4A: a decoder that starts throwing: the newly demanded module is down with its error; the pass is not taken as converged; others run", () =>
    Effect.gen(function*() {
      broken.current = false
      const demand = demandOf({ m: [], other: [{ assistantId: "a" }] })
      const host = yield* hostOf([m, other], demand, { persistence: readOnlyPersistence({ modules: { m: { settings: { place: "Rome" } } }, secrets: {} }) })
      yield* host.startEnabled
      broken.current = true
      demand.current = new Map([["m", [{ assistantId: "a" }]], ["other", [{ assistantId: "a" }]]])
      yield* host.refresh
      assert.strictEqual(info(host, "m").state, "error")
      assert.match(info(host, "m").error ?? "", /could not be read \(decoder broke\)/)
      assert.isTrue(host.issues.all().some((i) => i.module === "m" && i.severity === "error"))
      assert.strictEqual(info(host, "other").state, "running")
      // Saving and checking own values call the same code: each answers with the module's error, never a crash.
      const saved = yield* host.configure("m", { values: { place: "Paris" }, secrets: {} })
      assert.isFalse(saved.ok)
      assert.match(host.checkOwn("m", { place: "x" })[0]?.message ?? "", /decoder broke/)
      broken.current = false
      yield* host.recheck
      assert.strictEqual(info(host, "m").state, "running")
    }))

  it.effect("4A: switching on a module whose decoder throws answers with its error, not ok", () =>
    Effect.gen(function*() {
      broken.current = true
      const host = yield* hostOf([{ ...m, enabledByDefault: false } as ModuleDefinition<any>], undefined, { persistence: readOnlyPersistence({ modules: { m: { settings: { place: "Rome" } } }, secrets: {} }) })
      const result = yield* host.enable("m")
      assert.isFalse(result.ok)
      broken.current = false
    }))
})

describe("restart requests (findings 7, 8)", () => {
  it.effect("7: callers interrupted at every step of a request: none leaves a held request that blocks later ones", () =>
    Effect.gen(function*() {
      let starts = 0
      let restart: ((reason: string) => Effect.Effect<void>) | undefined
      const m = defineModule({ apiVersion: 2, id: "m", name: "M", description: "", start: ({ host }) => Effect.sync(() => (starts++, (restart = host.requestRestart), {})) })
      const host = yield* hostOf([m], undefined)
      yield* host.startEnabled
      yield* restart!("first")
      yield* settle
      assert.strictEqual(starts, 2, "the first request is taken up at once")
      // Within the interval: interrupted at every point of the call.
      for (let k = 0; k < 40; k++) {
        const fiber = yield* Effect.forkChild(restart!("interrupted").pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1)))
        for (let i = 0; i < k; i++) yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }
      yield* advance(6_000)
      yield* settle
      const before = starts
      yield* restart!("after the interruptions")
      yield* advance(6_000)
      yield* settle
      assert.isAbove(starts, before, "a request after the last one was taken up always leads to another restart")
    }))

  it.effect("8: a shared finalizer that asks for a restart while a failed start is rolled back: exactly one attempt", () =>
    Effect.gen(function*() {
      let shareds = 0
      const m = defineModule({
        apiVersion: 2,
        id: "m",
        name: "M",
        description: "",
        shared: ({ host }) =>
          Effect.gen(function*() {
            shareds++
            yield* Effect.addFinalizer(() => Effect.exit(host.requestRestart("socket closed")))
            return { value: undefined }
          }),
        start: () => Effect.fail(new ModuleStartError({ message: "instance refused" }))
      })
      const host = yield* hostOf([m], demandOf({ m: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      yield* advance(30_000)
      yield* advance(30_000)
      assert.strictEqual(shareds, 1)
      assert.strictEqual(info(host, "m").state, "error")
    }))
})

describe("settingsFor follows the run's current membership and defaults (finding 9)", () => {
  const provider = (seen: { current: ((assistantId: string | undefined) => unknown) | undefined }) =>
    defineModule({
      apiVersion: 2,
      id: "p",
      name: "P",
      description: "",
      settings: { place: Setting.text({ label: "Place", default: "Amsterdam", overridable: true }) },
      shared: ({ settingsFor }) => Effect.sync(() => ((seen.current = settingsFor as never), { value: undefined })),
      start: () => Effect.succeed({})
    })
  const place = (f: ((assistantId: string | undefined) => unknown) | undefined, id: string | undefined) => (f!(id) as { readonly place: string }).place

  it.effect("9: an assistant added onto an existing key, and two assistants swapping keys", () =>
    Effect.gen(function*() {
      const seen: { current: ((assistantId: string | undefined) => unknown) | undefined } = { current: undefined }
      const demand = demandOf({ p: [{ assistantId: "a", own: { place: "Rome" } }, { assistantId: "c", own: { place: "Paris" } }] })
      const host = yield* hostOf([provider(seen)], demand)
      yield* host.startEnabled
      const first = seen.current
      demand.current = new Map([["p", [{ assistantId: "a", own: { place: "Rome" } }, { assistantId: "c", own: { place: "Paris" } }, { assistantId: "b", own: { place: "Rome" } }]]])
      yield* host.refresh
      assert.strictEqual(seen.current, first, "not restarted: the instances are the same")
      assert.strictEqual(place(first, "b"), "Rome")
      demand.current = new Map([["p", [{ assistantId: "a", own: { place: "Paris" } }, { assistantId: "c", own: { place: "Rome" } }]]])
      yield* host.refresh
      assert.strictEqual(seen.current, first)
      assert.strictEqual(place(first, "a"), "Paris")
      assert.strictEqual(place(first, "c"), "Rome")
    }))

  it.effect("9: an unused overridable default changed while the provider runs shared-only", () =>
    Effect.gen(function*() {
      const seen: { current: ((assistantId: string | undefined) => unknown) | undefined } = { current: undefined }
      const consumer = defineModule({ apiVersion: 2, id: "c", name: "C", description: "", uses: ["p"], start: () => Effect.succeed({}) })
      const host = yield* hostOf([provider(seen), consumer], demandOf({ p: [], c: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      const first = seen.current
      assert.strictEqual(place(first, undefined), "Amsterdam")
      assert.isTrue((yield* host.configure("p", { values: { place: "Berlin" }, secrets: {} })).ok)
      assert.strictEqual(seen.current, first, "kept")
      assert.strictEqual(place(first, undefined), "Berlin")
    }))
})

describe("the saved switch (finding 10)", () => {
  it.effect("10: a keyed module saved between its stop and start, with the vault locked and the saver held: saved on", () =>
    Effect.gen(function*() {
      const saves: Array<{ readonly id: string; readonly enabled: boolean }> = []
      const held = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let keyedStarts = 0
      const persistence: ModulePersistence = {
        initial: { modules: {}, secrets: { keyed: { token: "t" } } },
        save: (id, record) => Effect.andThen(id === "other" ? Deferred.await(held) : Effect.void, Effect.sync(() => void saves.push({ id, enabled: record.enabled })))
      }
      const keyed = defineModule({
        id: "keyed",
        name: "Keyed",
        description: "",
        enabledByDefault: false,
        enabledWhenSet: "token",
        settings: { token: Setting.secret({ label: "Token" }), place: Setting.text({ label: "Place", default: "P1" }) },
        start: () => Effect.andThen(++keyedStarts > 1 ? Deferred.await(gate) : Effect.void, Effect.succeed({}))
      })
      const other = defineModule({ id: "other", name: "Other", description: "", settings: { place: Setting.text({ label: "Place", default: "P1" }) }, start: () => Effect.succeed({}) })
      const host = yield* hostOf([keyed, other], undefined, { persistence })
      yield* host.startEnabled
      assert.strictEqual(info(host, "keyed").state, "running")
      yield* host.setSecrets({})
      assert.strictEqual(info(host, "keyed").state, "running", "a lock keeps it running")
      const otherSave = yield* Effect.forkChild(host.configure("other", { values: { place: "P2" }, secrets: {} }))
      yield* settle
      const keyedSave = yield* Effect.forkChild(host.configure("keyed", { values: { place: "P2" }, secrets: {} }))
      yield* settle
      assert.strictEqual(info(host, "keyed").state, "starting", "between its stop and its start")
      yield* Deferred.succeed(held, undefined)
      yield* settle
      assert.deepStrictEqual(saves.filter((s) => s.id === "keyed"), [{ id: "keyed", enabled: true }])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(otherSave)
      yield* Fiber.join(keyedSave)
      assert.strictEqual(info(host, "keyed").state, "running")
    }))
})

describe("Check again (finding 11)", () => {
  it.effect("11: Check again while a first start that will fail is under way: a fresh attempt follows", () =>
    Effect.gen(function*() {
      const endpoint = { up: false }
      const gate = yield* Deferred.make<void>()
      let attempts = 0
      const m = defineModule({
        apiVersion: 2,
        id: "m",
        name: "M",
        description: "",
        shared: () =>
          Effect.gen(function*() {
            const up = endpoint.up
            if (++attempts === 1) yield* Deferred.await(gate)
            if (!up) return yield* new ModuleStartError({ message: "endpoint down" })
            return { value: undefined }
          }),
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([m], demandOf({ m: [{ assistantId: "a" }] }), { requirements: (rs) => rs.map((requirement) => ({ requirement, state: "met", detail: "ok" })) })
      const starting = yield* Effect.forkChild(host.startEnabled)
      yield* settle
      endpoint.up = true
      const rechecking = yield* Effect.forkChild(host.recheck)
      yield* settle
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(starting)
      yield* Fiber.join(rechecking)
      assert.strictEqual(info(host, "m").state, "running")
      assert.strictEqual(attempts, 2)
    }))
})

describe("health checks (finding 15)", () => {
  it.effect("15: a health check that interrupts itself is that module's issue; the other modules' checks are kept", () =>
    Effect.gen(function*() {
      const a = defineModule({ apiVersion: 2, id: "a", name: "A", description: "", health: () => Effect.interrupt, start: () => Effect.succeed({}) })
      const b = defineModule({
        apiVersion: 2,
        id: "b",
        name: "B",
        description: "",
        health: () => Effect.succeed([{ id: "x", severity: "warning" as const, title: "B is low", detail: "" }]),
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([a, b], undefined)
      yield* host.startEnabled
      const exit = yield* Effect.exit(host.checkHealth)
      assert.isTrue(Exit.isSuccess(exit), "the whole check is not interrupted")
      const titles = host.issues.all().map((i) => i.title)
      assert.include(titles, "A's health check failed")
      assert.include(titles, "B is low")
    }))
})

describe("contributions without access follow demand (finding 16)", () => {
  it.effect("16: A has the consumer on and the provider off: A does not see the provider's contribution, with or without a turn", () =>
    Effect.gen(function*() {
      const contributor = (id: string, uses?: ReadonlyArray<string>) =>
        defineModule({
          apiVersion: 2,
          id,
          name: id.toUpperCase(),
          description: "",
          ...(uses !== undefined ? { uses } : {}),
          shared: () => Effect.succeed({ value: undefined, contributions: [Section.of(id)] }),
          start: () => Effect.succeed({})
        })
      const host = yield* hostOf([contributor("p"), contributor("c", ["p"])], demandOf({ p: [], c: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      assert.deepStrictEqual([...host.contributionsFor(Section, undefined)].sort(), ["c", "p"], "every provider when no assistant is named")
      assert.deepStrictEqual(host.contributionsFor(Section, "a"), ["c"])
      const inTurn = yield* host.contributions(Section).pipe(Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "x", assistantId: "a", deviceId: "d", source: "voice" }))
      assert.deepStrictEqual(inTurn, ["c"])
    }))
})

describe("a down module follows who wants it (finding 17)", () => {
  it.effect("17: a failed capability's demand moves from A to B at the same settings: its error and the assistants' parts follow", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const m = defineModule({ apiVersion: 2, id: "m", name: "M", description: "", start: () => Effect.fail(new ModuleStartError({ message: "broken" })) })
      const g = defineModule({ apiVersion: 2, id: "g", name: "G", description: "", start: () => Effect.succeed({ tools: [toolOf("g_tool", log)] }) })
      const demand = demandOf({ m: [{ assistantId: "a" }] })
      const host = yield* hostOf([m, g], demand)
      yield* host.startEnabled
      assert.deepStrictEqual([...host.snapshot().assistantParts.keys()], ["a"])
      demand.current = new Map([["m", [{ assistantId: "b" }]]])
      yield* host.refresh
      const parts = host.snapshot().assistantParts
      assert.deepStrictEqual([...parts.keys()], ["b"])
      assert.deepStrictEqual(parts.get("b")!.map((p) => p.moduleId), ["g"])
      assert.deepStrictEqual(info(host, "m").instances?.map((i) => [i.assistants, i.state]), [[["b"], "error"]])
    }))
})

describe("registration window (finding 18)", () => {
  it.effect("18: registering on a part after its own start returned, or from a validation callback, is refused and nothing is published", () =>
    Effect.gen(function*() {
      const published: Array<string> = []
      const results: Array<RegisterResult> = []
      let sharedHandle: PartHandle | undefined
      const late = (name: string) => ({ kind: "late", publish: () => void published.push(name), withdraw: () => {} })
      const registrar: Registrar = ({ handle, instance, shared }) => {
        if (shared !== undefined) {
          sharedHandle = handle
          return [{ kind: "check", publish: () => {}, withdraw: () => {}, validate: () => (results.push(handle.register(late("from validate"))), undefined) }]
        }
        if (instance !== undefined) results.push(sharedHandle!.register(late("while another part is registered")))
        return []
      }
      const m = defineModule({ apiVersion: 2, id: "m", name: "M", description: "", shared: () => Effect.succeed({ value: undefined }), start: () => Effect.succeed({}) })
      const host = yield* hostOf([m], demandOf({ m: [{ assistantId: "a" }] }), { registrars: [registrar] })
      yield* host.startEnabled
      assert.strictEqual(info(host, "m").state, "running")
      assert.deepStrictEqual(results.map((r) => r.ok), [false, false])
      assert.deepStrictEqual(published, [])
    }))
})

describe("issue count (finding 20)", () => {
  it("20: more issues than the bound from one source: the most severe kept, and the true number left out said", () => {
    const registry = makeIssueRegistry()
    registry.set("s", [
      ...Array.from({ length: 150 }, (_, i) => ({ id: `w${i}`, severity: "warning" as const, title: `warning ${i}`, detail: "" })),
      { id: "e", severity: "error" as const, title: "the error", detail: "" }
    ])
    const all = registry.all()
    assert.strictEqual(all[0]!.title, "the error")
    assert.strictEqual(all.length, 100)
    assert.strictEqual(all.at(-1)!.title, "And 52 more issues")
  })
})

// Kept for the reader: the stopped error is what a context answers after close (finding 2 above).
void isModuleStopped
void Cause

describe("the registry's health fits the frame (p1-r4c finding 2)", () => {
  it("issues at every field maximum, all escaped: what the registry keeps encodes and decodes, standalone and in an admin snapshot", () => {
    const nul = (n: number) => "\u0000".repeat(n)
    const registry = makeIssueRegistry()
    registry.set("s", Array.from({ length: 150 }, (_, i) => ({
      id: `i${i}`,
      severity: "error" as const,
      title: nul(200),
      device: nul(200),
      detail: nul(2000),
      fix: { kind: "command" as const, label: nul(200), value: nul(1000) }
    })))
    const health = { issues: [...registry.all()], checking: false, checkedAt: 1 }
    const standalone = decodeServerMessage(encodeServerMessage({ type: "health", health }))
    assert.strictEqual(standalone._tag, "Ok")
    const snapshot = decodeServerMessage(encodeServerMessage({ type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, health } }))
    assert.strictEqual(snapshot._tag, "Ok")
    assert.match(health.issues.at(-1)!.title, /^And \d+ more issues$/)
  })
})
