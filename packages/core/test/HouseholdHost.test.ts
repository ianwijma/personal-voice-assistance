// The household store and the event bus in the module host (docs/STORING-DATA.md): `ctx.store` and `ctx.events` for
// version 2 modules, a module whose data is newer is `unavailable`, host events, and a slow subscriber.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { hostEvent, makeEventBus } from "../src/EventBus.ts"
import { defineCollection, type ModuleStore, StoreError } from "../src/HouseholdStore.ts"
import type { ModuleEvents } from "../src/EventBus.ts"
import { defineModule, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"
import { makeTestHousehold } from "../src/testing.ts"

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
      const exit = yield* Effect.exit(seen.store!.collection(items).list())
      assert.isTrue(exit._tag === "Failure")
    }).pipe(Effect.scoped))

  it.effect("a shared part's subscriptions follow its generation: nothing while a candidate, nothing once replaced or retired", () =>
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
            // The second generation is slow to start: events published meanwhile must not reach it yet.
            if (label === "two") yield* Effect.callback<void>((resume) => void (release = () => resume(Effect.void)))
            return { value: undefined }
          }),
        start: () => Effect.succeed({})
      })
      const h = yield* makeTestHousehold([watcher])
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["watcher", [{ assistantId: "a" }]]]) }
      const host = yield* makeModuleHost({ catalog: [watcher], persistence: readOnlyPersistence(), env: {}, demand: () => demand.current, household: h.household })
      yield* host.startEnabled
      const tick = Effect.andThen(Effect.sync(() => h.bus.publish(hostEvent("turn.ended", {}))), Effect.repeat(Effect.yieldNow, { times: 20 }))
      // Let the shared part's subscription start.
      yield* Effect.repeat(Effect.yieldNow, { times: 50 })
      yield* tick
      assert.deepStrictEqual(handled, ["one"])
      // Replace the shared part: while the new one starts, the old one still handles; the candidate does not.
      const fiber = yield* Effect.forkChild(host.configure("watcher", { values: { label: "two" }, secrets: {} }))
      yield* Effect.repeat(Effect.yieldNow, { times: 50 })
      yield* tick
      assert.deepStrictEqual(handled, ["one", "one"])
      release!()
      assert.isTrue((yield* Fiber.join(fiber)).ok)
      // Published: only the new one handles, although the old one's scope stays open for its grace period.
      yield* tick
      assert.deepStrictEqual(handled, ["one", "one", "two"])
      // Demand ends: the retiring part handles nothing more.
      demand.current = new Map([["watcher", []]])
      yield* host.refresh
      yield* tick
      assert.deepStrictEqual(handled, ["one", "one", "two"])
      yield* TestClock.adjust(10_000)
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
