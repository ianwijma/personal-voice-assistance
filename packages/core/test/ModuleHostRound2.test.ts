// Module API v2, review round 2 (docs/MODULES-PLAN.md §4 P1): each test is the reviewer's own sequence of events for
// one finding of p1-r2. Since review round 3 the host replaces a module by stopping it, then starting it (one worker,
// one module at a time; docs/ARCHITECTURE.md "Module host"), so the scenarios that depended on two generations of a
// module now end with no overlap at all.
import { assert, describe, it } from "@effect/vitest"
import { encodeServerMessage, type ModuleInfo } from "@pva/protocol"
import { Cause, Deferred, Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { defineAction } from "../src/Actions.ts"
import { makeExecutionGateway } from "../src/Gateway.ts"
import { makeTool } from "../src/Module.ts"
import { ContributionKey, isModuleStopped, type ModuleHostApi, type RequirementCheck, ServiceKey } from "../src/ModuleApi.ts"
import { defineModule, type ModuleDefinition, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, type ModulePersistence, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import type { PartHandle, Registrar } from "../src/ModuleRegistrations.ts"
import { Setting } from "../src/Settings.ts"
import { CurrentJob, CurrentTurn, type JobOrigin, type TurnContext } from "../src/TurnContext.ts"

const settle = Effect.repeat(Effect.yieldNow, { times: 50 })
const advance = (millis: number) => Effect.andThen(settle, TestClock.adjust(millis))

const demandOf = (entries: Record<string, ReadonlyArray<ModuleDemand>>) => ({ current: new Map(Object.entries(entries)) as Map<string, ReadonlyArray<ModuleDemand>> })
const hostOf = (
  catalog: ReadonlyArray<ModuleDefinition<any>>,
  demand: { current: Map<string, ReadonlyArray<ModuleDemand>> } | undefined,
  extra: Partial<Parameters<typeof makeModuleHost>[0]> = {}
) => makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {}, ...(demand !== undefined ? { demand: () => demand.current } : {}), ...extra })
const info = (host: { readonly modules: () => ReadonlyArray<ModuleInfo> }, id: string) => host.modules().find((m) => m.id === id)!
const turn = (assistantId: string, deviceId = "kitchen"): TurnContext => ({ turnId: 1, conversationId: "c", assistantId, deviceId, source: "voice" })

interface Svc {
  readonly address: string
}
const Svc = ServiceKey<Svc>("r2.svc")
const Section = ContributionKey<string>("r2.section")

/** A provider with a shared part (`address` shared, `place` overridable); `log` records starts and closes. */
const provider = (log: Array<string>, options: { readonly id?: string; readonly gate?: Deferred.Deferred<void>; readonly failInstance?: (place: string) => boolean } = {}) => {
  const id = options.id ?? "prov"
  return defineModule({
    apiVersion: 2,
    id,
    name: id.toUpperCase(),
    description: "provider",
    settings: {
      address: Setting.text({ label: "Address", default: "a1" }),
      place: Setting.text({ label: "Place", default: "Amsterdam", overridable: true })
    },
    shared: ({ settings }) =>
      Effect.gen(function*() {
        const address = settings.address ?? ""
        log.push(`${id}:shared+${address}`)
        if (options.gate !== undefined) yield* Deferred.await(options.gate)
        if (address === "fail") return yield* new ModuleStartError({ message: "no such endpoint" })
        yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`${id}:shared-${address}`)))
        return { value: { address }, services: [Svc.of({ address })], contributions: [Section.of(`${id}@${address}`)] }
      }),
    start: ({ settings, shared }) =>
      Effect.gen(function*() {
        const address = (shared as Svc).address
        log.push(`${id}:start+${address}/${settings.place}`)
        if (options.failInstance?.(settings.place) === true) return yield* new ModuleStartError({ message: `no ${settings.place}` })
        yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`${id}:stop-${address}/${settings.place}`)))
        return { tools: [makeTool({ name: `${id}_${settings.place.toLowerCase()}`, description: "", parameters: Schema.Struct({}), execute: () => Effect.succeed(address) })] }
      })
  })
}

describe("the gateway's principal is the identity (findings 1, 2)", () => {
  const seen: Array<string> = []
  const lights = (nested?: { current: ModuleHostApi | undefined }) =>
    defineModule({
      apiVersion: 2,
      id: "lights",
      name: "Lights",
      description: "",
      start: ({ host }) =>
        Effect.sync(() => {
          if (nested !== undefined) nested.current = host
          return {
            actions: [
              defineAction({
                id: "on",
                label: "On",
                description: "",
                params: {},
                run: () =>
                  Effect.gen(function*() {
                    const t = yield* CurrentTurn
                    const j = yield* CurrentJob
                    seen.push(`on:${t?.assistantId ?? "-"}/${j?.jobId ?? "-"}`)
                    return { say: "On." }
                  })
              }),
              defineAction({
                id: "both",
                label: "Both",
                description: "",
                params: {},
                // Nested: runs `on` through the host, as the principal it was itself admitted for.
                run: () => Effect.flatMap(nested!.current!.actions.run({ moduleId: "lights", actionId: "on", params: {} }), (r) => Effect.succeed({ say: r.ok ? "both" : r.message }))
              })
            ]
          }
        })
    })
  const access = { moduleOn: (assistant: string) => assistant !== "denied", toolOff: () => false }

  it.effect("1: a turn without an assistant or a device is refused in serve mode, never admitted by a looser rule", () =>
    Effect.gen(function*() {
      seen.length = 0
      const host = yield* hostOf([lights()], demandOf({ lights: [{ assistantId: "denied" }] }), { access })
      yield* host.startEnabled
      const partial: TurnContext = { turnId: 1, conversationId: "c", source: "text" }
      const run = host.actions.run({ moduleId: "lights", actionId: "on", params: {} })
      assert.deepStrictEqual(yield* Effect.provideService(run, CurrentTurn, partial), { ok: false, code: "refused", message: "Not run: the turn names no assistant." })
      assert.deepStrictEqual(yield* Effect.provideService(run, CurrentTurn, { ...partial, assistantId: "x" }), { ok: false, code: "refused", message: "Not run: the turn names no device." })
      assert.deepStrictEqual(yield* Effect.provideService(host.actions.list, CurrentTurn, partial), [], "nothing is listed for it either")
      assert.deepStrictEqual(seen, [])
      // A tool of no module cannot be checked against the assistant's choices.
      const gateway = makeExecutionGateway({ access })
      const tool = makeTool({ name: "loose", description: "", parameters: Schema.Struct({}), execute: () => Effect.sync(() => void seen.push("loose")) })
      const exit = yield* Effect.exit(Effect.provideService(gateway.tool(undefined, tool, {}), CurrentTurn, turn("a")))
      assert.isTrue(exit._tag === "Failure")
      assert.deepStrictEqual(seen, [])
      // `principalProblem`: parts that do not belong together.
      const strict = makeExecutionGateway({ access: { ...access, principalProblem: (p) => (p._tag === "turn" && p.turn.assistantId === "ghost" ? "no such assistant" : undefined) } })
      const ghost = yield* Effect.exit(Effect.provideService(strict.tool("m", tool, {}), CurrentTurn, turn("ghost")))
      assert.isTrue(ghost._tag === "Failure" && String(ghost.cause).includes("no such assistant"))
    }))

  it.effect("2: an explicit job principal runs as that job, not the ambient turn of another room; a nested action too", () =>
    Effect.gen(function*() {
      seen.length = 0
      const nested = { current: undefined as ModuleHostApi | undefined }
      const host = yield* hostOf([lights(nested)], demandOf({ lights: [{ assistantId: "a" }, { assistantId: "b" }] }), { access })
      yield* host.startEnabled
      const action = host.snapshot().actions.find((a) => a.definition.id === "both")!
      const job: JobOrigin = { jobId: "wake-up", moduleId: "lights", assistantId: "a" }
      const ran = yield* Effect.provideService(host.gateway.action(action, {}, { principal: { _tag: "job", job } }), CurrentTurn, turn("b", "hall"))
      assert.deepStrictEqual(ran, { say: "both" })
      assert.deepStrictEqual(seen, ["on:-/wake-up"], "the nested action ran for the job: no turn of b, the job's id")
      seen.length = 0
      // A notification principal: the nested call inherits it (no turn, no job), whatever the ambient turn.
      const n = yield* Effect.provideService(
        host.gateway.action(action, {}, { principal: { _tag: "notification", notification: { notificationId: "n1", deviceId: "hall" } } }),
        CurrentTurn,
        turn("b", "hall")
      )
      assert.deepStrictEqual(n, { say: "both" })
      assert.deepStrictEqual(seen, ["on:-/-"])
    }))
})

describe("contributions for the caller across an await (finding 3)", () => {
  it.effect("an assistant's tool reads contributions after a native await and concurrently with another assistant: only its own", () =>
    Effect.gen(function*() {
      const host = yield* hostOf([provider([])], demandOf({ prov: [{ assistantId: "a" }] }), {
        access: { moduleOn: (assistant, moduleId) => !(assistant === "b" && moduleId === "prov"), toolOff: () => false }
      })
      yield* host.startEnabled
      const barrier = yield* Deferred.make<void>()
      const lookup = (assistantId: string) =>
        Effect.provideService(
          Effect.gen(function*() {
            // A native continuation in between: the fiber's own context survives it.
            yield* Effect.promise(async () => {
              await Promise.resolve()
              await new Promise((resolve) => setTimeout(resolve, 0))
            })
            yield* Deferred.await(barrier)
            return yield* host.contributions(Section)
          }),
          CurrentTurn,
          turn(assistantId)
        )
      const a = yield* Effect.forkChild(lookup("a"))
      const b = yield* Effect.forkChild(lookup("b"))
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
      yield* Deferred.succeed(barrier, undefined)
      assert.deepStrictEqual(yield* Fiber.join(a), ["prov@a1"])
      assert.deepStrictEqual(yield* Fiber.join(b), [], "b has the provider off, even after the await")
      // Native code with no fiber names the assistant explicitly (or asks for every provider deliberately).
      const native = yield* Effect.promise(async () => {
        await Promise.resolve()
        return [host.contributionsFor(Section, "b"), host.contributionsFor(Section, undefined)]
      })
      assert.deepStrictEqual(native, [[], ["prov@a1"]])
    }))
})

describe("a generation owns its registrations (findings 4, 12)", () => {
  /** A registrar for a test kind, "handler": the shared part's value names it; delivery goes through the live table. */
  const handlerKind = (table: Map<string, { readonly generation: number; readonly handle: PartHandle }>, handles: Array<PartHandle>): Registrar => ({ handle, shared }) => {
    if (shared === undefined) return []
    handles.push(handle)
    return [{
      kind: "handler",
      claims: ["on-event"],
      publish: () => table.set("on-event", { generation: handle.id, handle }),
      withdraw: () => {
        if (table.get("on-event")?.handle === handle) table.delete("on-event")
      }
    }]
  }

  it.effect("4: a handler is live while its module is published only; absent while it restarts; never twice; never for a failed start", () =>
    Effect.gen(function*() {
      const table = new Map<string, { readonly generation: number; readonly handle: PartHandle }>()
      const handles: Array<PartHandle> = []
      const log: Array<string> = []
      const gate = yield* Deferred.make<void>()
      let gated = false
      let handleOf: PartHandle | undefined
      const mod = defineModule({
        apiVersion: 2,
        id: "sub",
        name: "Sub",
        description: "",
        settings: { address: Setting.text({ label: "Address", default: "a1" }) },
        shared: ({ settings }) =>
          Effect.gen(function*() {
            if (gated) yield* Deferred.await(gate)
            if (settings.address === "fail") return yield* new ModuleStartError({ message: "refused" })
            yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`closed ${settings.address}`)))
            return { value: settings.address }
          }),
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([mod], demandOf({ sub: [{ assistantId: "a" }] }), {
        registrars: [
          handlerKind(table, handles),
          // A part that registers during its start (a context member would, through its handle).
          ({ handle, shared }) => {
            if (shared === undefined) return []
            handleOf = handle
            return []
          }
        ]
      })
      const deliver = () => table.get("on-event")?.handle.id
      yield* host.startEnabled
      const g1 = handles[0]!.id
      assert.strictEqual(deliver(), g1)
      gated = true
      const fiber = yield* Effect.forkChild(host.configure("sub", { values: { address: "a2" }, secrets: {} }))
      yield* settle
      assert.strictEqual(deliver(), undefined, "while the new one starts, the old one is withdrawn: nothing handles events")
      assert.include(log, "closed a1", "and closed before the new one started")
      yield* Deferred.succeed(gate, undefined)
      assert.isTrue((yield* Fiber.join(fiber)).ok)
      gated = false
      const g2 = handles[1]!.id
      assert.strictEqual(deliver(), g2)
      assert.strictEqual(handles[0]!.state(), "closed")
      // Registering after the start is refused, for an old part and for the live one: only the worker publishes.
      assert.isFalse(handles[0]!.register({ kind: "late", publish: () => log.push("late published"), withdraw: () => {} }).ok)
      assert.isFalse(handleOf!.register({ kind: "late", publish: () => log.push("late published"), withdraw: () => {} }).ok)
      assert.notInclude(log, "late published")
      // A start that fails never handles anything, and the module is down.
      const failed = yield* host.configure("sub", { values: { address: "fail" }, secrets: {} })
      assert.isFalse(failed.ok)
      assert.strictEqual(deliver(), undefined)
      assert.isTrue((yield* host.configure("sub", { values: { address: "a3" }, secrets: {} })).ok)
      assert.strictEqual(deliver(), handles.at(-1)!.id)
    }))

  it.effect("12: an old part's requestRestart after its module stopped dies with ModuleStopped; a failed start's request is dropped", () =>
    Effect.gen(function*() {
      const restarts: Array<{ readonly address: string; readonly restart: (reason: string) => Effect.Effect<void> }> = []
      let shareds = 0
      const mod = defineModule({
        apiVersion: 2,
        id: "sock",
        name: "Sock",
        description: "",
        settings: { address: Setting.text({ label: "Address", default: "a1" }) },
        shared: ({ host, settings }) =>
          Effect.gen(function*() {
            shareds++
            restarts.push({ address: settings.address ?? "", restart: host.requestRestart })
            // A start that asks for a restart during itself, then fails.
            if (settings.address === "fail") {
              yield* host.requestRestart("socket dropped while starting")
              return yield* new ModuleStartError({ message: "refused" })
            }
            return { value: settings.address }
          }),
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([mod], demandOf({ sock: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      assert.isTrue((yield* host.configure("sock", { values: { address: "a2" }, secrets: {} })).ok)
      assert.strictEqual(shareds, 2)
      // The first start's part has closed: its host object answers with ModuleStopped, and nothing restarts.
      const exit = yield* Effect.exit(restarts[0]!.restart("G1's socket closed"))
      assert.isTrue(exit._tag === "Failure" && isModuleStopped(Cause.squash(exit.cause)))
      yield* advance(10_000)
      assert.strictEqual(shareds, 2, "the healthy second start is not restarted")
      // A failed start's request is dropped with it.
      assert.isFalse((yield* host.configure("sock", { values: { address: "fail" }, secrets: {} })).ok)
      yield* advance(10_000)
      assert.strictEqual(shareds, 3)
      assert.isTrue((yield* host.configure("sock", { values: { address: "a4" }, secrets: {} })).ok)
      yield* restarts.at(-1)!.restart("its tools changed")
      yield* advance(10)
      assert.strictEqual(shareds, 5)
    }))
})

describe("CLI and shutdown (findings 6, 7)", () => {
  it.effect("6: closing the host while a call is in flight: the call is interrupted, instances close before the shared part, once", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      let call: Fiber.Fiber<unknown, unknown> | undefined
      const slow = defineModule({
        apiVersion: 2,
        id: "slow",
        name: "Slow",
        description: "",
        shared: () => Effect.as(Effect.addFinalizer(() => Effect.sync(() => log.push("shared closed"))), { value: undefined }),
        start: () =>
          Effect.as(Effect.addFinalizer(() => Effect.sync(() => log.push("instance closed"))), {
            tools: [makeTool({ name: "wait", description: "", parameters: Schema.Struct({}), execute: () => Effect.as(Effect.sleep(60_000), "done") })]
          })
      })
      yield* Effect.gen(function*() {
        const host = yield* hostOf([slow], undefined)
        yield* host.startEnabled
        call = yield* Effect.forkDetach(host.snapshot().registry.run({ id: "1", name: "wait", input: {} }))
        yield* settle
      }).pipe(Effect.scoped)
      assert.deepStrictEqual(log, ["instance closed", "shared closed"])
      const result = (yield* Fiber.join(call!)) as { readonly isError: boolean }
      assert.isTrue(result.isError, "interrupted: no grace period when the host closes")
    }))
  it.effect("7: rollback and shutdown wait for an instance's asynchronous finalizer before closing its shared part", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const flush = yield* Deferred.make<void>()
      const mod = defineModule({
        apiVersion: 2,
        id: "db",
        name: "DB",
        description: "",
        settings: { place: Setting.text({ label: "Place", default: "x", overridable: true }), address: Setting.text({ label: "Address", default: "a1" }) },
        shared: ({ settings }) =>
          Effect.gen(function*() {
            yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`shared closed ${settings.address}`)))
            return { value: settings.address }
          }),
        start: ({ settings }) =>
          Effect.gen(function*() {
            if (settings.place === "bad" && settings.address !== "a1") return yield* new ModuleStartError({ message: "bad place" })
            // Flushes through the shared connection when it closes, asynchronously.
            yield* Effect.addFinalizer(() =>
              Effect.gen(function*() {
                log.push(`flush ${settings.place} ${settings.address}`)
                if (settings.address !== "a1") yield* Deferred.await(flush)
                log.push(`flushed ${settings.place} ${settings.address}`)
              })
            )
            return {}
          })
      })
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.gen(function*() {
        const host = yield* hostOf([mod], demandOf({ db: [{ assistantId: "a" }, { assistantId: "b", own: { place: "bad" } }] }))
        yield* host.startEnabled
        // Rollback: the second instance fails, the first (started) one is closed before its shared part.
        const configuring = yield* Effect.forkChild(host.configure("db", { values: { address: "a2" }, secrets: {} }))
        yield* settle
        assert.deepStrictEqual(log.filter((l) => l.includes("a2")), ["flush x a2"], "the shared part waits for the flush")
        yield* Deferred.succeed(flush, undefined)
        assert.isFalse((yield* Fiber.join(configuring)).ok)
        assert.deepStrictEqual(log.filter((l) => l.includes("a2")), ["flush x a2", "flushed x a2", "shared closed a2"])
      })))
      yield* Fiber.join(fiber)
      // Shutdown: every instance's finalizer has finished before the shared part closes.
      const tail = log.filter((l) => l.includes("a1"))
      assert.deepStrictEqual(tail.slice(-1), ["shared closed a1"])
      assert.includeMembers(tail, ["flushed x a1", "flushed bad a1"])
    }))
})

describe("order through `uses` (findings 8, 9)", () => {
  const consumer = (log: Array<string>, id = "cons") =>
    defineModule({
      apiVersion: 2,
      id,
      name: id,
      description: "",
      enabledByDefault: false,
      uses: ["prov"],
      start: ({ host }) =>
        Effect.sync(() => {
          log.push(`${id}:start sees ${host.service(Svc)?.address ?? "nothing"}`)
          return {}
        })
    })

  it.effect("8: enabling a consumer (saved switch) starts its provider's shared part first, and the consumer sees it", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const gate = yield* Deferred.make<void>()
      const prov = { ...provider(log, { gate }), enabledByDefault: false }
      const host = yield* hostOf([consumer(log), prov], undefined)
      const enabling = yield* Effect.forkChild(host.enable("cons"))
      yield* settle
      assert.deepStrictEqual(log, ["prov:shared+a1"], "the consumer has not started while its provider's shared part starts")
      yield* Deferred.succeed(gate, undefined)
      assert.isTrue((yield* Fiber.join(enabling)).ok)
      assert.include(log, "cons:start sees a1", "it started after its provider, and found the new service")
    }))

  it.effect("9: a second trigger while the provider's shared part is still starting: the consumer waits for it (no overlapping passes)", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const gate = yield* Deferred.make<void>()
      const demand = demandOf({ prov: [{ assistantId: "x" }], cons: [] })
      const host = yield* hostOf([consumer(log), provider(log, { gate })], demand)
      const first = yield* Effect.forkChild(host.startEnabled)
      yield* settle
      demand.current.set("cons", [{ assistantId: "a" }])
      const second = yield* Effect.forkChild(host.refresh)
      yield* settle
      assert.notInclude(log.join(), "cons:start", "the provider is busy, not settled")
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      assert.include(log, "cons:start sees a1")
      assert.strictEqual(info(host, "cons").state, "running")
    }))
})

describe("settings (findings 10, 11, 13, 16)", () => {
  it.effect("10 (round 3, finding 13): settingsFor answers from the desired state its module was started with; a change restarts it", () =>
    Effect.gen(function*() {
      const seen: Array<{ readonly settingsFor: (assistantId: string | undefined) => unknown; readonly atStart: unknown }> = []
      const mod = defineModule({
        apiVersion: 2,
        id: "wx",
        name: "Weather",
        description: "",
        settings: { place: Setting.text({ label: "Place", default: "Amsterdam", overridable: true }), units: Setting.text({ label: "Units", default: "metric" }) },
        shared: (ctx) =>
          Effect.sync(() => {
            // Asked inside `shared` itself: the same picture the module starts with.
            seen.push({ settingsFor: ctx.settingsFor as never, atStart: ctx.settingsFor(undefined) })
            return { value: undefined }
          }),
        start: () => Effect.succeed({})
      })
      const demand = demandOf({ wx: [{ assistantId: "a" }, { assistantId: "b", own: { place: "Utrecht" } }] })
      const host = yield* hostOf([mod], demand)
      yield* host.startEnabled
      const placeOf = (id: string | undefined) => (seen.at(-1)!.settingsFor(id) as { readonly place: string }).place
      assert.deepStrictEqual([placeOf("a"), placeOf("b"), placeOf(undefined)], ["Amsterdam", "Utrecht", "Amsterdam"])
      // Both a shared and an overridable default at once: the new start sees both, from inside `shared` too.
      assert.isTrue((yield* host.configure("wx", { values: { place: "Rome", units: "imperial" }, secrets: {} })).ok)
      assert.deepStrictEqual(seen.at(-1)!.atStart, { place: "Rome", units: "imperial" })
      assert.deepStrictEqual([placeOf("a"), placeOf("b")], ["Rome", "Utrecht"])
      // An own value only: what runs changes (an instance key), so it starts again with it.
      demand.current.set("wx", [{ assistantId: "a", own: { place: "Paris" } }, { assistantId: "b", own: { place: "Utrecht" } }])
      yield* host.refresh
      assert.deepStrictEqual(seen.at(-1)!.settingsFor("a"), { place: "Paris", units: "imperial" })
      // The first start's settingsFor, kept after its part closed, answers with ModuleStopped.
      assert.throws(() => seen[0]!.settingsFor("a"), /has stopped/)
    }))

  it.effect("11: a shared-only provider gains a direct assistant and a new shared default at once; the new instance fails: down, closed, said", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      let address = "a1"
      const consumer = defineModule({ apiVersion: 2, id: "cons", name: "Cons", description: "", uses: ["prov"], start: () => Effect.succeed({}) })
      const demand = demandOf({ cons: [{ assistantId: "c" }], prov: [] })
      const host = yield* hostOf([consumer, provider(log, { failInstance: (place) => place === "Nowhere" })], demand, { defaults: () => ({ address }) })
      yield* host.startEnabled
      assert.deepStrictEqual(host.service(Svc), { address: "a1" })
      demand.current.set("prov", [{ assistantId: "d", own: { place: "Nowhere" } }])
      address = "a2"
      yield* host.refresh
      assert.strictEqual(host.service(Svc), undefined, "a start is published only if every part started")
      assert.includeMembers(log, ["prov:shared-a1", "prov:shared-a2"], "the old one and the new shared part were closed")
      assert.strictEqual(info(host, "prov").state, "error")
      assert.isDefined(host.issues.all().find((i) => i.id === "prov.start"))
      assert.strictEqual(info(host, "cons").state, "running", "the consumer runs without the service")
      // The assistant leaves: the failure is forgotten and it runs for its consumer again.
      demand.current.set("prov", [])
      yield* host.refresh
      assert.deepStrictEqual(host.service(Svc), { address: "a2" })
    }))

  it.effect("13: an unlock while a configure is held in its save still switches on an `enabledWhenSet` module, and what it uses", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const held = yield* Deferred.make<void>()
      const persistence: ModulePersistence = {
        initial: { modules: {}, secrets: {} },
        save: (id) => (id === "keyed" ? Deferred.await(held) : Effect.void)
      }
      const keyed = defineModule({
        apiVersion: 2,
        id: "keyed",
        name: "Keyed",
        description: "",
        enabledByDefault: false,
        enabledWhenSet: "token",
        uses: ["prov"],
        settings: { token: Setting.secret({ label: "Token" }), region: Setting.text({ label: "Region", default: "eu" }) },
        start: () =>
          Effect.sync(() => {
            log.push("keyed:start")
            return {}
          })
      })
      const host = yield* hostOf([keyed, { ...provider(log), enabledByDefault: false }], undefined, { persistence })
      yield* host.startEnabled
      assert.strictEqual(info(host, "keyed").state, "disabled")
      const configuring = yield* Effect.forkChild(host.configure("keyed", { values: { region: "us" }, secrets: {} }))
      yield* settle
      yield* host.setSecrets({ keyed: { token: "k" } })
      assert.strictEqual(info(host, "keyed").state, "running")
      assert.include(log, "keyed:start")
      assert.deepStrictEqual(host.service(Svc), { address: "a1" }, "the module it uses is demanded")
      yield* Deferred.succeed(held, undefined)
      assert.isTrue((yield* Fiber.join(configuring)).ok)
    }))

  it.effect("16: a configure that fails leaves the module down and says why on the Health page; a good one brings it back", () =>
    Effect.gen(function*() {
      const host = yield* hostOf([provider([])], demandOf({ prov: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      const result = yield* host.configure("prov", { values: { address: "fail" }, secrets: {} })
      assert.isFalse(result.ok)
      assert.strictEqual(host.service(Svc), undefined)
      const issue = host.issues.all().find((i) => i.id === "prov.start")
      assert.strictEqual(issue?.title, "PROV could not start")
      assert.match(issue?.detail ?? "", /no such endpoint/)
      assert.isTrue((yield* host.configure("prov", { values: { address: "a2" }, secrets: {} })).ok)
      assert.isUndefined(host.issues.all().find((i) => i.id === "prov.start"), "gone once it starts")
    }))
})

describe("wire limits (finding 14)", () => {
  it.effect("a long unavailable reason, and a core issue with a long title, still encode", () =>
    Effect.gen(function*() {
      const requirements: RequirementCheck = (rs) => rs.map((requirement) => ({ requirement, state: "missing", detail: `x${"y".repeat(900)}`, fix: { kind: "command", label: "l".repeat(400), value: "v".repeat(3000) } }))
      const mod = defineModule({ apiVersion: 2, id: "music", name: "Music", description: "", requires: [{ tool: "mpv", why: "Plays" }], start: () => Effect.succeed({}) })
      const host = yield* hostOf([mod], undefined, { requirements })
      const unavailable = info(host, "music").unavailable!
      assert.isAtMost(unavailable.reason.length, 500)
      encodeServerMessage({ type: "module.changed", module: info(host, "music") })
      host.issues.set("core", [{ id: "core.disk", severity: "warning", title: `Low disk space in /${"d".repeat(300)}`, detail: "" }])
      encodeServerMessage({ type: "health", health: { issues: host.issues.all(), checking: false } })
      assert.isAtMost(host.issues.all().find((i) => i.id === "core.disk")!.title.length, 200)
    }))
})

describe("restarts lose no change (finding 17; round 3, finding 11)", () => {
  it.effect("a restart asked for during a restart starts it again afterwards (within the interval): the latest tool list is published", () =>
    Effect.gen(function*() {
      const toolList = { current: ["one"] }
      const sampled = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let starts = 0
      const restarts: Array<(reason: string) => Effect.Effect<void>> = []
      const mod = defineModule({
        apiVersion: 2,
        id: "mcp",
        name: "MCP",
        description: "",
        start: ({ host }) =>
          Effect.gen(function*() {
            starts++
            restarts.push(host.requestRestart)
            const tools = [...toolList.current]
            if (starts === 2) {
              // The restart has sampled the list, and waits; the list changes again, and the starting part asks.
              yield* Deferred.succeed(sampled, undefined)
              yield* Deferred.await(release)
              yield* host.requestRestart("list changed again")
            }
            return { tools: tools.map((name) => makeTool({ name, description: "", parameters: Schema.Struct({}), execute: () => Effect.void })) }
          })
      })
      const host = yield* hostOf([mod], undefined)
      yield* host.startEnabled
      toolList.current = ["one", "two"]
      yield* restarts[0]!("list changed")
      yield* Deferred.await(sampled)
      toolList.current = ["one", "two", "three"]
      yield* Deferred.succeed(release, undefined)
      yield* settle
      assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name), ["one", "two"], "the second request waits for the interval")
      // Many more requests in the interval are merged into one restart; none is lost.
      for (let i = 0; i < 5; i++) yield* restarts[1]!("again")
      yield* advance(5_000)
      yield* settle
      assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name), ["one", "two", "three"])
      assert.strictEqual(starts, 3)
    }))
})
