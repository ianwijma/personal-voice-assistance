import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import type { ModulePresent, Presentation } from "../../src/Present.ts"
import { presentFaultyStore, presentPrepared, presentWorld } from "../../src/presentContract.ts"
import { makeMemoryHouseholdStore } from "../../src/testing.ts"

const yields = Effect.repeat(Effect.yieldNow, { times: 100 })
const image = (url: string): Presentation => ({ kind: "image", url, alt: "Picture", credit: "Example", spoken: "A picture." })
const pin = { lifetime: "pinned", key: "photo" } as const

describe("presentation round 3", () => {
  for (const change of ["replacement", "update"] as const) for (const failedWrite of [false, true]) {
    it.effect(`a1: crossed image completions resolve the ${change}, with ${failedWrite ? "one failed write" : "overlapping writes"}`, () => Effect.gen(function*() {
      const f = presentFaultyStore(yield* presentPrepared(makeMemoryHouseholdStore()))
      const a = yield* Deferred.make<{ hash: string }>()
      const b = yield* Deferred.make<{ hash: string }>()
      const gate = yield* Deferred.make<void>()
      const calls: Array<string> = []
      const urlA = "https://example.org/a", urlB = "https://example.org/b"
      const w = yield* presentWorld(f.store, { media: (url) => Effect.andThen(Effect.sync(() => calls.push(url)), Deferred.await(url === urlA ? a : b)) })
      const h = yield* w.showOn("kitchen-display", image(urlA), pin)
      if (change === "replacement") yield* w.showOn("kitchen-display", image(urlB), pin)
      else yield* h.update(image(urlB))
      yield* yields
      assert.deepStrictEqual(calls, [urlA, urlB])
      if (failedWrite) f.faults.writes = 1
      else f.gate.wait = gate
      yield* Deferred.succeed(a, { hash: "a".repeat(64) })
      yield* yields
      yield* Deferred.succeed(b, { hash: "b".repeat(64) })
      yield* yields
      yield* Deferred.succeed(gate, undefined)
      yield* w.settle
      yield* w.advance(61_000)
      yield* w.present.maintainNow
      yield* w.settle
      const content = (yield* w.rows).find((r) => r.id === h.id)!.value.content
      assert.strictEqual(content.kind, "image")
      if (content.kind === "image") assert.strictEqual(content.hash, "b".repeat(64))
      const page = w.shownOn("kitchen-display")[0]!.content
      assert.strictEqual(page.kind, "image")
      if (page.kind === "image") assert.strictEqual(page.image.state, "ready")
      assert.deepStrictEqual(calls, [urlA, urlB], "each in-flight URL is fetched once")
    }))
  }

  it.effect("a2: reconnect gives fresh press slots and old requests release only their own connection's slots", () => Effect.gen(function*() {
    let present: ModulePresent | undefined
    let started = 0
    const oldGate = yield* Deferred.make<void>(), newGate = yield* Deferred.make<void>()
    const oldStarted = yield* Deferred.make<void>(), newStarted = yield* Deferred.make<void>()
    const module = defineModule({ apiVersion: 2, id: "board", name: "Board", description: "Reconnect", shared: (ctx) => Effect.gen(function*() {
      present = ctx.present
      yield* present.handle("answer", { run: () => Effect.gen(function*() {
        const call = ++started
        if (call === 4) yield* Deferred.succeed(oldStarted, undefined)
        if (call === 8) yield* Deferred.succeed(newStarted, undefined)
        if (call <= 4) yield* Deferred.await(oldGate)
        else if (call <= 8) yield* Deferred.await(newGate)
        return { say: "OK" }
      }) }).pipe(Effect.orDie)
      return { value: undefined }
    }), start: () => Effect.succeed({}) })
    const kit = yield* startTestModule(module)
    const device = "kitchen-display", ids: Array<string> = []
    for (let i = 0; i < 8; i++) ids.push((yield* present!.show({ device }, { kind: "card", title: `Card ${i}`, spoken: "Card", handler: "answer", buttons: [{ id: "go", label: "Go" }] }, { lifetime: "pinned" })).id)
    yield* kit.present.settle
    const oldCalls = yield* Effect.forkChild(Effect.forEach(ids.slice(0, 4), (id) => kit.present.press(id, "go"), { concurrency: "unbounded" }))
    yield* Deferred.await(oldStarted)
    yield* kit.notify.disconnect(device)
    assert.lengthOf(kit.present.shown(device), 0)
    yield* kit.notify.connect(device)
    assert.lengthOf(kit.present.shown(device), 8)
    // First make a single fresh call: the unfixed kit refuses it immediately, so this assertion cannot hang.
    const firstNew = yield* Effect.forkChild(kit.present.press(ids[4]!, "go"))
    yield* yields
    assert.strictEqual(started, 5)
    const otherNew = yield* Effect.forkChild(Effect.forEach(ids.slice(5), (id) => kit.present.press(id, "go"), { concurrency: "unbounded" }))
    yield* Deferred.await(newStarted)
    yield* Deferred.succeed(oldGate, undefined)
    assert.isTrue((yield* Fiber.join(oldCalls)).every((a) => a.ok))
    assert.strictEqual((yield* kit.present.press(ids[0]!, "go")).code, "busy")
    assert.strictEqual(started, 8)
    yield* Deferred.succeed(newGate, undefined)
    assert.isTrue((yield* Fiber.join(firstNew)).ok)
    assert.isTrue((yield* Fiber.join(otherNew)).every((a) => a.ok))
    assert.isTrue((yield* kit.present.press(ids[0]!, "go")).ok)
  }))
})
