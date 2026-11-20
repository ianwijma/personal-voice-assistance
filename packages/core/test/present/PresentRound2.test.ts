import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import type { ModulePresent, Presentation, PresentHandle } from "../../src/Present.ts"
import { PRESENT_DEVICES, presentFaultyStore, presentPrepared, presentWorld } from "../../src/presentContract.ts"
import { makeMemoryHouseholdStore } from "../../src/testing.ts"
import { CurrentTurn } from "../../src/TurnContext.ts"

const card = (title: string, extra: object = {}): Presentation => ({ kind: "card", title, spoken: title, ...extra }) as Presentation
const image = (): Presentation => ({ kind: "image", url: "https://example.org/a", alt: "A", credit: "C", spoken: "A" })
const pin = { lifetime: "pinned", key: "slot" } as const
const yields = Effect.repeat(Effect.yieldNow, { times: 100 })
const start = (o: Parameters<typeof presentWorld>[1] = {}) => Effect.gen(function*() {
  const f = presentFaultyStore(yield* presentPrepared(makeMemoryHouseholdStore()))
  const w = yield* presentWorld(f.store, o)
  yield* w.settle
  return { f, w }
})

describe("presentation round 2", () => {
  it.effect("a1: a stopped owner cannot update a pin through another module after the store waits", () => Effect.gen(function*() {
    let update: PresentHandle
    const { f, w } = yield* start({ modules: ["board", "caller"], toolRun: () => Effect.map(update.update(card("Changed after stop")), (out) => out === undefined ? "gone" : "updated").pipe(Effect.orDie) })
    update = yield* w.showOn("kitchen-display", card("Original"), pin)
    const gate = yield* Deferred.make<void>()
    f.gate.wait = gate
    const running = yield* Effect.forkChild(w.toolOn("kitchen-display", "unused", "caller"))
    yield* yields
    yield* w.host.disable("board")
    yield* Deferred.succeed(gate, undefined)
    assert.strictEqual((yield* Fiber.join(running)).content, "gone")
    yield* w.settle
    assert.strictEqual((w.shownOn("kitchen-display")[0]!.content as { title: string }).title, "Original")
  }))

  it.effect("a2: a replacement joins image completion while another waiter's write is blocked", () => Effect.gen(function*() {
    const f = presentFaultyStore(yield* presentPrepared(makeMemoryHouseholdStore()))
    const fetched = yield* Deferred.make<{ hash: string }>()
    const gate = yield* Deferred.make<void>()
    let arm = false
    let writes = 0
    let fetches = 0
    const wrapped = { ...f.store, forCore: (owner: Parameters<typeof f.store.forCore>[0]) => {
      const own = f.store.forCore(owner)
      return owner !== "core.present" ? own : { ...own, transaction: ((body) => Effect.suspend(() => {
        if (arm && ++writes === 2) f.gate.wait = gate
        return own.transaction(body)
      })) satisfies typeof own.transaction }
    } }
    const w = yield* presentWorld(wrapped, { media: () => Effect.andThen(Effect.sync(() => { fetches++ }), Deferred.await(fetched)) })
    const a = yield* w.showOn("kitchen-display", image(), pin)
    yield* w.showOn("robins-phone", image(), { ...pin, key: "b" })
    arm = true
    yield* Deferred.succeed(fetched, { hash: "a".repeat(64) })
    yield* yields
    assert.strictEqual(writes, 2)
    yield* w.open("robins-phone")
    assert.strictEqual(fetches, 1, "a completion waiting on its store write is still owned by that showing")
    yield* w.showOn("kitchen-display", image(), pin)
    yield* yields
    yield* Deferred.succeed(gate, undefined)
    yield* w.settle
    yield* w.advance(61_000)
    assert.strictEqual(w.shownOn("kitchen-display").find((p) => p.id === a.id)!.content.kind, "image")
    assert.strictEqual(((yield* w.rows).find((r) => r.id === a.id)!.value.content as { hash?: string }).hash, "a".repeat(64))
  }))

  it.effect("a3: a failed busy-outcome write belongs only to its show, not a fresh same-URL show", () => Effect.gen(function*() {
    let calls = 0
    let fail: () => void = () => undefined
    const { f, w } = yield* start({ media: () => Effect.sync(() => {
      if (++calls === 1) { fail(); return { refused: "busy" as const } }
      return { hash: "b".repeat(64) }
    }) })
    fail = () => { f.faults.writes = 1 }
    const h = yield* w.showOn("kitchen-display", image(), pin)
    yield* w.showOn("kitchen-display", image(), pin)
    yield* w.advance(61_000)
    assert.strictEqual(calls, 2)
    assert.strictEqual(((yield* w.rows).find((r) => r.id === h.id)!.value.content as { hash?: string }).hash, "b".repeat(64))
  }))

  it.effect("a4: the writer retains only live reservations when a key is replaced repeatedly", () => Effect.gen(function*() {
    const { f, w } = yield* start()
    const gate = yield* Deferred.make<void>()
    f.gate.wait = gate
    const show = (i: number) => w.toolOn("kitchen-display", { forModel: "ok", present: card(`Version ${i}`), show: pin })
    yield* show(0)
    yield* yields
    for (let i = 1; i <= 48; i++) yield* show(i)
    let dequeued = 0
    let high = 0
    const shift = Array.prototype.shift
    Array.prototype.shift = function<T>(this: Array<T>): T | undefined {
      const first = this[0] as { entry?: { key?: string }; content?: { kind?: string } } | undefined
      if (first?.entry?.key === "slot" && first.content?.kind === "card") { dequeued++; high = Math.max(high, this.length) }
      return shift.call(this) as T | undefined
    }
    try { yield* Deferred.succeed(gate, undefined); yield* w.settle }
    finally { Array.prototype.shift = shift }
    assert.isAtMost(high, 1)
    assert.strictEqual(dequeued, 1)
    assert.strictEqual((yield* w.rows).length, 1)
    assert.strictEqual((w.shownOn("kitchen-display")[0]!.content as { title: string }).title, "Version 48")
  }))

  it.effect("a5: origin is refused if its device disappears before the committing attempt", () => Effect.gen(function*() {
    const devices = PRESENT_DEVICES.map((d) => ({ ...d }))
    const { f, w } = yield* start({ devices })
    const gate = yield* Deferred.make<void>()
    f.gate.wait = gate
    const running = yield* Effect.forkChild(Effect.exit(w.board().show("origin", card("Forgotten"), pin).pipe(Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c1", source: "voice", assistantId: "jeff", deviceId: "kitchen-display" }))))
    yield* yields
    devices.splice(devices.findIndex((d) => d.id === "kitchen-display"), 1)
    yield* Deferred.succeed(gate, undefined)
    assert.isTrue(Exit.isFailure(yield* Fiber.join(running)))
    assert.deepStrictEqual(yield* w.rows, [])
    assert.isTrue(Exit.isFailure(yield* Effect.exit(w.board().show("origin", card("Still forgotten"), pin).pipe(Effect.provideService(CurrentTurn, { turnId: 2, conversationId: "c1", source: "voice", assistantId: "jeff", deviceId: "kitchen-display" })))))
  }))

  it.effect("a6: the kit presses the displayed revision before settling a replacement", () => Effect.gen(function*() {
    let present: ModulePresent | undefined
    const invoked: Array<string> = []
    const module = defineModule({ apiVersion: 2, id: "board", name: "Board", description: "Test", shared: (ctx) => Effect.gen(function*() {
      present = ctx.present
      for (const name of ["before", "after"]) yield* present.handle(name, { run: () => Effect.sync(() => { invoked.push(name); return { say: name } }) }).pipe(Effect.orDie)
      return { value: undefined }
    }), start: () => Effect.succeed({}) })
    const kit = yield* startTestModule(module)
    const show = (name: string) => present!.show({ device: "kitchen-display" }, card(name, { handler: name, buttons: [{ id: "go", label: name }] }), pin)
    const h = yield* show("before")
    yield* kit.present.settle
    yield* show("after")
    assert.strictEqual((kit.present.shown()[0]!.content as { title: string }).title, "before")
    assert.isFalse((yield* kit.present.press(h.id, "go")).ok)
    assert.deepStrictEqual(invoked, [])
    assert.isTrue((yield* kit.present.press(h.id, "go")).ok)
    assert.deepStrictEqual(invoked, ["after"])
  }))

  it.effect("a7: the kit shares four page slots between presentation and notification presses, exempting Stop", () => Effect.gen(function*() {
    let present: ModulePresent | undefined
    let send: Effect.Effect<string> | undefined
    let active = 0
    let peak = 0
    const handler = { run: () => Effect.gen(function*() { active++; peak = Math.max(peak, active); yield* Effect.sleep(500); active--; return { say: "ok" } }) }
    const module = defineModule({ apiVersion: 2, id: "board", name: "Board", description: "Test", shared: (ctx) => Effect.gen(function*() {
      present = ctx.present
      yield* ctx.present.handle("answer", handler).pipe(Effect.orDie)
      yield* ctx.notify.handle("answer", handler).pipe(Effect.orDie)
      send = Effect.map(ctx.notify.send({ target: "everywhere", title: "Reminder", actions: [{ id: "go", label: "Go" }], handler: "answer" }).pipe(Effect.orDie), (out) => out.notification.id)
      return { value: undefined }
    }), start: () => Effect.succeed({}) })
    const kit = yield* startTestModule(module)
    const notification = yield* send!
    const ids: Array<string> = []
    for (let i = 0; i < 4; i++) ids.push((yield* present!.show({ device: "kitchen-display" }, card(`P${i}`, { handler: "answer", buttons: [{ id: "go", label: "Go" }] }), { lifetime: "pinned" })).id)
    yield* kit.present.settle
    const answers = yield* Effect.all([...ids.map((id) => kit.present.press(id, "go")), kit.notify.press(notification, "go")], { concurrency: "unbounded" })
    assert.strictEqual(peak, 4)
    assert.strictEqual(answers.filter((a) => a.code === "busy").length, 1)
    const again = yield* send!
    const withStop = yield* Effect.all([...ids.map((id) => kit.present.press(id, "go")), kit.notify.press(again, "stop")], { concurrency: "unbounded" })
    assert.isTrue(withStop[4]!.ok)
    assert.strictEqual(peak, 4)
  }))
})
