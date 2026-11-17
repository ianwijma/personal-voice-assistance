// The household store and the event bus in the module host (docs/STORING-DATA.md): `ctx.store` and `ctx.events` for
// version 2 modules, a module whose data is newer is `unavailable`, host events, and a slow subscriber.
import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { ToolError } from "../src/Errors.ts"
import { hostEvent, makeEventBus } from "../src/EventBus.ts"
import { defineCollection, type ModuleStore, StoreError } from "../src/HouseholdStore.ts"
import type { ModuleEvents } from "../src/EventBus.ts"
import { makeTool } from "../src/Module.ts"
import { ModuleStopped } from "../src/ModuleApi.ts"
import { defineModule, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"
import { makeTestHousehold } from "../src/testing.ts"

/** Let forked fibers (subscriptions, the host's worker) run. */
const settle = Effect.repeat(Effect.yieldNow, { times: 50 })

const Item = Schema.Struct({ text: Schema.String })
const items = defineCollection({ name: "items", scope: "household", schema: Item })

const seen: { store?: ModuleStore | undefined; events?: ModuleEvents; sharedStore?: ModuleStore } = {}
const shop = defineModule({
  apiVersion: 2,
  id: "shop",
  name: "Shop",
  description: "Test",
  storage: { collections: [items] },
  shared: (ctx) => Effect.sync(() => {
    seen.sharedStore = ctx.store
    return { value: undefined }
  }),
  start: (ctx) =>
    Effect.gen(function*() {
      seen.store = ctx.store
      seen.events = ctx.events
      yield* ctx.store.collection(items).insert({ text: "started" }).pipe(
        Effect.mapError((e) => new ModuleStartError({ message: e.message }))
      )
      return {}
    })
})

describe("household store in the module host", () => {
  it.effect("a version 2 module gets ctx.store and ctx.events in shared and start; its writes reach the bus", () =>
    Effect.gen(function*() {
      const h = yield* makeTestHousehold([shop])
      const host = yield* makeModuleHost({ catalog: [shop], persistence: readOnlyPersistence(), env: {}, household: h.household })
      yield* host.startEnabled
      assert.strictEqual(host.modules()[0]!.state, "running")
      assert.strictEqual(seen.store?.moduleId, "shop")
      assert.strictEqual(seen.sharedStore?.moduleId, "shop")
      const rows = yield* seen.store!.collection(items).list()
      assert.deepStrictEqual(rows.map((r) => r.value.text), ["started"])
      assert.isTrue(h.events.some((e) => e.type === "shop.items.changed"))
      assert.isTrue(h.events.some((e) => e.type === "host.module.state" && (e.data as { state: string }).state === "running"))
      yield* seen.events!.publish("basket.full", { n: 3 })
      const mine = h.events.find((e) => e.type === "shop.basket.full")
      assert.deepStrictEqual(mine?.data, { n: 3 })
      assert.strictEqual(mine?.module, "shop")
    }).pipe(Effect.scoped))

  it.effect("data written by a newer version makes the module unavailable, with the reason; it never starts", () =>
    Effect.gen(function*() {
      const h = yield* makeTestHousehold([shop], { storedVersions: { shop: 2 } })
      const host = yield* makeModuleHost({ catalog: [shop], persistence: readOnlyPersistence(), env: {}, household: h.household })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "unavailable")
      assert.match(info.unavailable?.reason ?? "", /newer version of this module/)
      assert.isTrue(host.issues.all().some((i) => i.id === "shop.unavailable"))
    }).pipe(Effect.scoped))

  it.effect("without a household the store fails every call unavailable", () =>
    Effect.gen(function*() {
      seen.store = undefined
      const host = yield* makeModuleHost({ catalog: [shop], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      assert.strictEqual(host.modules()[0]!.state, "error")
      assert.match(host.modules()[0]!.error ?? "", /no household store/)
      const exit = yield* Effect.exit(seen.store!.collection(items).list())
      assert.isTrue(exit._tag === "Failure")
    }).pipe(Effect.scoped))

  // Rewritten for the one-worker host (P1 round 3): a replacement stops the old part before it starts the new one, so
  // there is no moment when the old one still handles while the new one starts (the earlier version asserted that).
  it.effect("a subscription lives with its part: nothing while the module starts, nothing once it is withdrawn, released when its scope closes", () =>
    Effect.gen(function*() {
      const handled: Array<string> = []
      let release: (() => void) | undefined
      const watcher = defineModule({
        apiVersion: 2,
        id: "watcher",
        name: "Watcher",
        description: "Counts turns",
        settings: { label: Setting.text({ label: "Label", default: "one" }) },
        shared: ({ settings, events }) =>
          Effect.gen(function*() {
            const label = settings.label ?? ""
            yield* Effect.forkScoped(Stream.runForEach(events.subscribe({ type: "host.turn.ended" }), () => Effect.sync(() => handled.push(label))))
            // The second start is slow: events published meanwhile must reach neither part.
            if (label === "two") yield* Effect.callback<void>((resume) => void (release = () => resume(Effect.void)))
            return { value: undefined }
          }),
        start: () => Effect.succeed({})
      })
      const h = yield* makeTestHousehold([watcher])
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["watcher", [{ assistantId: "a" }]]]) }
      const host = yield* makeModuleHost({ catalog: [watcher], persistence: readOnlyPersistence(), env: {}, demand: () => demand.current, household: h.household })
      yield* host.startEnabled
      const tick = Effect.andThen(Effect.sync(() => h.bus.publish(hostEvent("turn.ended", {}))), settle)
      yield* settle
      yield* tick
      assert.deepStrictEqual(handled, ["one"])
      assert.strictEqual(h.bus.stats().subscribers, 1)
      // Replaced: the old part is withdrawn and closed (its subscription released) before the new one starts; while the
      // new one starts, neither handles.
      const fiber = yield* Effect.forkChild(host.configure("watcher", { values: { label: "two" }, secrets: {} }))
      yield* settle
      assert.strictEqual(host.modules()[0]!.state, "starting")
      assert.strictEqual(h.bus.stats().subscribers, 1, "only the starting part's subscription is left")
      yield* tick
      assert.deepStrictEqual(handled, ["one"])
      release!()
      assert.isTrue((yield* Fiber.join(fiber)).ok)
      // Published: the new one handles (an event published while it started was not kept for it).
      yield* tick
      assert.deepStrictEqual(handled, ["one", "two"])
      // Demand ends: withdrawn, closed, released.
      demand.current = new Map([["watcher", []]])
      yield* host.refresh
      yield* tick
      assert.deepStrictEqual(handled, ["one", "two"])
      assert.strictEqual(h.bus.stats().subscribers, 0)
    }).pipe(Effect.scoped))

  it.effect("once its module is withdrawn no event reaches a handler, even one already queued; the store writes through the grace period and refuses once the part has closed", () =>
    Effect.gen(function*() {
      const handled: Array<number> = []
      const handlerGate = yield* Deferred.make<void>()
      const toolGate = yield* Deferred.make<void>()
      const kept: { store?: ModuleStore; events?: ModuleEvents } = {}
      const slowpoke = defineModule({
        apiVersion: 2,
        id: "slowpoke",
        name: "Slowpoke",
        description: "Handles slowly",
        enabledByDefault: true,
        storage: { collections: [items] },
        start: (ctx) =>
          Effect.gen(function*() {
            kept.store = ctx.store
            kept.events = ctx.events
            // An instance's subscription, in its scope: the first event's handler waits.
            yield* Effect.forkScoped(Stream.runForEach(ctx.events.subscribe({ type: "host.turn.ended" }), (e) =>
              Effect.suspend(() => {
                handled.push((e.data as { i: number }).i)
                return handled.length === 1 ? Deferred.await(handlerGate) : Effect.void
              })))
            // One run outside the part's scope: it ends when the part's scope closes all the same.
            yield* Effect.forkDetach(Stream.runDrain(ctx.events.subscribe({ type: "nobody.publishes.this" })))
            return {
              tools: [makeTool({
                name: "note",
                description: "writes a note after a while",
                parameters: Schema.Struct({}),
                execute: () =>
                  Effect.andThen(Deferred.await(toolGate), ctx.store.collection(items).insert({ text: "in grace" })).pipe(
                    Effect.map((row) => row.value.text),
                    Effect.mapError((e) => new ToolError({ message: e.message }))
                  )
              })]
            }
          })
      })
      const h = yield* makeTestHousehold([slowpoke])
      const host = yield* makeModuleHost({ catalog: [slowpoke], persistence: readOnlyPersistence(), env: {}, household: h.household })
      yield* host.startEnabled
      yield* settle
      for (let i = 0; i < 3; i++) h.bus.publish(hostEvent("turn.ended", { i }))
      yield* settle
      assert.deepStrictEqual(handled, [0], "the first handler waits; two events are queued")
      assert.strictEqual(h.bus.stats().subscribers, 2)
      const tool = host.snapshot().parts[0]!.module.tools![0]!
      const call = yield* Effect.forkChild(host.gateway.tool("slowpoke", tool, {}))
      yield* settle
      const stopping = yield* Effect.forkChild(host.disable("slowpoke"))
      yield* settle
      assert.strictEqual(host.modules()[0]!.state, "stopping", "withdrawn; the tool call holds the grace period")
      yield* Deferred.succeed(handlerGate, undefined)
      yield* settle
      assert.deepStrictEqual(handled, [0], "the queued events never reach the handler of a withdrawn part")
      yield* Deferred.succeed(toolGate, undefined)
      assert.strictEqual(yield* Fiber.join(call), "in grace", "a call in flight still writes during the grace period")
      yield* Fiber.join(stopping)
      assert.strictEqual(host.modules()[0]!.state, "disabled")
      assert.strictEqual(h.bus.stats().subscribers, 0, "both released, the detached one too")
      // Closed: every member dies with ModuleStopped, a collection handle taken earlier too (taken now: the same).
      const stopped = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ModuleStopped
      assert.isTrue(stopped(yield* Effect.exit(kept.store!.collection(items).list())))
      assert.isTrue(stopped(yield* Effect.exit(kept.store!.transaction(() => 1))))
      assert.isTrue(stopped(yield* Effect.exit(kept.events!.publish("late", {}))))
      assert.isTrue(stopped(yield* Effect.exit(Stream.runDrain(kept.events!.subscribe()))))
      // The write made in the grace period is there.
      const rows = yield* h.store.forModule("slowpoke").collection(items).list()
      assert.deepStrictEqual(rows.map((r) => r.value.text), ["in grace"])
    }).pipe(Effect.scoped))

  it("the host's event namespace is reserved: no module may have the id host", () => {
    assert.throws(() => defineModule({ apiVersion: 2, id: "host", name: "Host", description: "", start: () => Effect.succeed({}) }), /reserved/)
  })

  it("storage needs module API 2", () => {
    assert.throws(() => defineModule({ id: "old", name: "Old", description: "", storage: { collections: [items] }, start: () => Effect.succeed({}) }))
    void StoreError
  })
})

describe("event bus", () => {
  it.effect("a logger or clock that throws stops nothing: every other subscriber still gets the event", () =>
    Effect.gen(function*() {
      const bus = makeEventBus({ log: () => { throw new Error("logger bug") }, now: () => { throw new Error("clock bug") } })
      const fast: Array<string> = []
      const slow = yield* Effect.forkChild(Stream.runForEach(bus.subscribe(undefined, { capacity: 1, name: "slow" }), () => Effect.never))
      const quick = yield* Effect.forkChild(Stream.runForEach(bus.subscribe(), (e) => Effect.sync(() => fast.push(e.type))))
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      for (let i = 0; i < 5; i++) assert.doesNotThrow(() => bus.publish(hostEvent("turn.ended", { i })))
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      assert.strictEqual(fast.length, 5)
      assert.isAbove(bus.stats().dropped, 0)
      yield* Fiber.interrupt(slow)
      yield* Fiber.interrupt(quick)
    }))

  it.effect("a module cannot publish in the host's namespace", () =>
    Effect.gen(function*() {
      const seenTypes: Array<string> = []
      const bus = makeEventBus({ observe: (e) => seenTypes.push(`${e.module}:${e.type}`) })
      yield* bus.forModule("host").publish("turn.ended", {})
      yield* bus.forModule("shop").publish("turn.ended", {})
      assert.deepStrictEqual(seenTypes, ["shop:shop.turn.ended"])
    }))

  it.live("filters by module, type and prefix; a slow subscriber drops (counted) without holding up the others", () =>
    Effect.gen(function*() {
      const warnings: Array<string> = []
      const bus = makeEventBus({ log: (l) => warnings.push(l) })
      const fast: Array<string> = []
      const prefixed: Array<string> = []
      const fastFiber = yield* Effect.forkChild(Stream.runForEach(bus.subscribe(), (e) => Effect.sync(() => fast.push(e.type))))
      const prefixFiber = yield* Effect.forkChild(Stream.runForEach(bus.subscribe({ prefix: "host.device." }), (e) => Effect.sync(() => prefixed.push(e.type))))
      // The slow one takes nothing for a long time.
      const slowFiber = yield* Effect.forkChild(Stream.runForEach(bus.subscribe(undefined, { capacity: 4, name: "slow" }), () => Effect.sleep("1 hour")))
      yield* Effect.sleep("20 millis")
      assert.strictEqual(bus.stats().subscribers, 3)
      const t0 = performance.now()
      for (let i = 0; i < 100; i++) bus.publish(hostEvent(i % 2 === 0 ? "device.connected" : "turn.ended", { i }))
      const took = performance.now() - t0
      yield* Effect.sleep("20 millis")
      assert.strictEqual(fast.length, 100)
      assert.strictEqual(prefixed.length, 50)
      assert.isAtLeast(bus.stats().dropped, 90)
      assert.isTrue(warnings.some((w) => w.includes("slow")))
      assert.isBelow(took, 50)
      yield* Fiber.interrupt(slowFiber)
      yield* Fiber.interrupt(fastFiber)
      yield* Fiber.interrupt(prefixFiber)
      yield* Effect.sleep("10 millis")
      assert.strictEqual(bus.stats().subscribers, 0)
    }))
})
