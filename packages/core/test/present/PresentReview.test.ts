import { assert, describe, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import type { ModulePresent, Presentation } from "../../src/Present.ts"
import { PRESENT_DEVICES, presentFaultyStore, presentPrepared, presentWorld } from "../../src/presentContract.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import { PRESENT_OWNER } from "../../src/Present.ts"
import { StoreError } from "../../src/HouseholdStore.ts"
import { noteOf } from "../../src/PresentEngine.ts"
import { SchedulerError } from "../../src/Scheduler.ts"
import { makeMemoryHouseholdStore } from "../../src/testing.ts"
import { makeConnectionRef } from "../../src/TurnContext.ts"

const card = (title: string, extra: object = {}): Presentation => ({ kind: "card", title, spoken: title, ...extra }) as Presentation
const image = (url = "https://example.org/a"): Presentation => ({ kind: "image", url, alt: "A", credit: "C", spoken: "A" })
const pin = { lifetime: "pinned", key: "slot" } as const
const yields = Effect.repeat(Effect.yieldNow, { times: 100 })
const start = (o: Parameters<typeof presentWorld>[1] = {}) => Effect.gen(function*() {
  const f = presentFaultyStore(yield* presentPrepared(makeMemoryHouseholdStore()))
  const w = yield* presentWorld(f.store, o)
  yield* w.settle
  return { f, w }
})

describe("presentation review regressions", () => {
  it.effect("a1: a handle update left unread cannot run its new handler; a buffered press cannot run a keyed replacement", () => Effect.gen(function*() {
    const { f, w } = yield* start()
    const h = yield* w.showOn("kitchen-display", card("Archive", { handler: "answer", buttons: [{ id: "go", label: "Archive" }] }), pin)
    f.faults.reads = 1
    yield* h.update(card("Delete", { handler: "h".repeat(64), buttons: [{ id: "go", label: "Delete" }] }))
    yield* w.settle
    assert.strictEqual((w.shownOn("kitchen-display")[0]!.content as { title: string }).title, "Archive")
    assert.isFalse((yield* w.pressOn("kitchen-display", h.id, "go")).ok)
    assert.deepStrictEqual(w.presses, [])
    yield* w.settle
    const buffered = w.shownOn("kitchen-display")[0]!
    yield* w.showOn("kitchen-display", card("Replacement", { handler: "answer", buttons: [{ id: "go", label: "Act" }] }), pin)
    assert.isFalse((yield* w.present.press({ presentationId: h.id, revision: buffered.revision, action: "go", deviceId: "kitchen-display", connection: makeConnectionRef(w.firstTab("kitchen-display")!.id) })).ok)
    assert.deepStrictEqual(w.presses, [])
    assert.isTrue((yield* w.pressOn("kitchen-display", h.id, "go")).ok)
  }))

  it.effect("a3: validation notes contain no rejected values and a job without a known device gets no fallback", () => Effect.gen(function*() {
    const { w } = yield* start()
    const item = { id: "private-appointment", text: "Appointment" }
    const out = yield* w.toolOn("hall-screen", { forModel: "Safe", present: { kind: "list", title: "Private", spoken: "Private", sensitivity: { personal: "p-sam" }, items: [item, item] } })
    assert.notInclude(out.content, "private-appointment")
    assert.include(out.content, "not valid")
    yield* w.host.disable("board")
    const note = yield* w.present.fromResult("board", { _tag: "job", job: { jobId: "j", moduleId: "board" } }, { forModel: "Safe", present: card("Fallback with no device") })
    assert.notInclude(JSON.stringify(note), "Fallback with no device")
  }))

  it.effect("a3: a startup refusal for a job without a device includes no household fallback", () => Effect.gen(function*() {
    const store = yield* presentPrepared(makeMemoryHouseholdStore())
    const w = yield* presentWorld({ ...store, forCore: (owner) => {
      const own = store.forCore(owner)
      return owner !== PRESENT_OWNER ? own : { ...own, collection: (c) => ({ ...own.collection(c), list: () => Effect.fail(new StoreError({ reason: "busy", message: "injected" })) }) }
    } })
    assert.isFalse(w.present.loaded())
    const note = yield* w.present.fromResult("board", { _tag: "job", job: { jobId: "j", moduleId: "board" } }, { forModel: "Safe", present: card("Fallback with no device") })
    assert.notInclude(JSON.stringify(note), "Fallback with no device")
    assert.include(JSON.stringify(note), "still being read")
  }))

  it.effect("a4: a show called by another module cannot commit after its originating part stops", () => Effect.gen(function*() {
    let provider: ModulePresent | undefined
    const { f, w } = yield* start({ modules: ["board", "caller"], toolRun: () => Effect.as(provider!.show({ device: "kitchen-display" }, card("Stopped")), "shown").pipe(Effect.orDie) })
    provider = w.board("board")
    const gate = yield* Deferred.make<void>()
    f.gate.wait = gate
    const running = yield* Effect.forkChild(w.toolOn("kitchen-display", "unused", "caller"))
    yield* yields
    yield* w.host.disable("board")
    yield* Deferred.succeed(gate, undefined)
    const result = yield* Fiber.join(running)
    yield* w.settle
    assert.isTrue(result.isError)
    assert.deepStrictEqual(yield* w.rows, [])
    assert.deepStrictEqual(w.shownOn("kitchen-display"), [])
  }))

  it.effect("a5: an older image completion preserves the newer address's failed outcome retry", () => Effect.gen(function*() {
    const a = yield* Deferred.make<{ hash: string }>()
    const b = yield* Deferred.make<{ hash: string }>()
    const { f, w } = yield* start({ media: (url) => Deferred.await(url.endsWith("/a") ? a : b) })
    yield* w.showOn("kitchen-display", image(), pin)
    yield* w.showOn("kitchen-display", image("https://example.org/b"), pin)
    f.faults.writes = 1
    yield* Deferred.succeed(b, { hash: "b".repeat(64) })
    yield* yields
    yield* Deferred.succeed(a, { hash: "a".repeat(64) })
    yield* w.settle
    yield* w.advance(120_000)
    assert.strictEqual((w.shownOn("kitchen-display")[0]!.content as { image: { state: string } }).image.state, "ready")
    assert.strictEqual(((yield* w.rows)[0]!.value.content as { hash: string }).hash, "b".repeat(64))
  }))

  it.effect("a6: a fresh keyed image resolves the cache again after a temporary refusal or a previous ready outcome", () => Effect.gen(function*() {
    let calls = 0
    const { w } = yield* start({ media: () => Effect.sync(() => ++calls === 1 ? { refused: "busy" } : { hash: `${calls}`.repeat(64).slice(0, 64) }) })
    yield* w.showOn("kitchen-display", image(), pin)
    yield* w.showOn("kitchen-display", image(), pin)
    assert.strictEqual(calls, 2)
    assert.strictEqual((w.shownOn("kitchen-display")[0]!.content as { image: { state: string } }).image.state, "ready")
    const result = yield* w.toolOn("kitchen-display", { forModel: "Ok", present: image(), show: pin })
    yield* w.settle
    assert.strictEqual(calls, 3)
    assert.include(result.content, "image is being fetched")
  }))

  it.effect("a7: a pending keyed move holds its pinned place on both the committed and pending devices", () => Effect.gen(function*() {
    const { f, w } = yield* start({ modules: ["board", "other", "third"] })
    yield* w.showOn("kitchen-display", card("Moving"), pin)
    for (let i = 0; i < 7; i++) yield* w.showOn("kitchen-display", card(`P${i}`), { lifetime: "pinned" }, "other")
    f.faults.writes = 1
    yield* w.toolOn("robins-phone", { forModel: "Ok", present: card("Moved"), show: pin })
    yield* yields
    const result = yield* Effect.exit(w.showOn("kitchen-display", card("Ninth"), { lifetime: "pinned" }, "third"))
    assert.isTrue(Exit.isFailure(result))
    assert.strictEqual(w.present.live().filter((e) => "device" in e.target && e.target.device === "kitchen-display").length, 8)
    yield* w.advance(1_000)
  }))

  it.effect("a8: a failed purge retries independently without delaying the next live expiry", () => Effect.gen(function*() {
    const { f, w } = yield* start()
    // Six removals span two batches: a failed first batch must not hide the next live expiry.
    for (let i = 0; i < 6; i++) {
      const old = yield* w.showOn("robins-phone", card(`Done ${i}`), { lifetime: "pinned" })
      yield* old.dismiss
    }
    yield* w.showOn("kitchen-display", card("15 seconds"), { expiresInMs: 15_000 })
    f.faults.writes = 1
    yield* w.advance(10_000)
    assert.strictEqual(w.present.plannedAt(), 15_000)
    yield* w.advance(6_000)
    assert.deepStrictEqual(w.shownOn("kitchen-display"), [])
    yield* w.advance(60_000)
    assert.deepStrictEqual(yield* w.rows, [])
  }))

  it.effect("a10: an accepted timer is validated in the attempt that commits", () => Effect.gen(function*() {
    const { f, w } = yield* start()
    yield* w.advance(120_000)
    const now = yield* Clock.currentTimeMillis
    const gate = yield* Deferred.make<void>()
    f.gate.wait = gate
    yield* w.toolOn("kitchen-display", { forModel: "Ok", present: { kind: "timer", label: "Timer", spoken: "Done", endsAt: now - 59_000 } })
    yield* yields
    yield* TestClock.adjust(2_000)
    yield* Deferred.succeed(gate, undefined)
    yield* w.settle
    assert.deepStrictEqual(yield* w.rows, [])
    assert.deepStrictEqual(w.shownOn("kitchen-display"), [])
  }))

  it.effect("a11: a room that becomes empty during the write is refused with no stored row", () => Effect.gen(function*() {
    const devices = PRESENT_DEVICES.map((d) => ({ ...d }))
    const { f, w } = yield* start({ devices })
    const gate = yield* Deferred.make<void>()
    f.gate.wait = gate
    const running = yield* Effect.forkChild(Effect.exit(w.board().show({ room: "Bedroom" }, card("Waiting"))))
    yield* yields
    const at = devices.findIndex((d) => d.id === "robins-phone")
    devices[at] = { ...devices[at]!, room: "Study" }
    yield* Deferred.succeed(gate, undefined)
    assert.isTrue(Exit.isFailure(yield* Fiber.join(running)))
    assert.deepStrictEqual(yield* w.rows, [])
    assert.strictEqual(noteOf([], () => ""), "Not showing it: there is no device to show it on.")
  }))

  it.effect("a12: dismiss after expiry returns false even if maintenance was not scheduled", () => Effect.gen(function*() {
    const { w } = yield* start({ wrapScheduler: (s) => ({ ...s, forCore: (owner) => {
      const jobs = s.forCore(owner)
      return { ...jobs, schedule: () => Effect.fail(new SchedulerError({ reason: "busy", message: "injected" })) }
    } }) })
    const h = yield* w.showOn("kitchen-display", card("Three seconds"), { expiresInMs: 3_000 })
    yield* TestClock.adjust(4_000)
    assert.isFalse(yield* h.dismiss)
    yield* w.settle
    assert.deepStrictEqual(w.shownOn("kitchen-display"), [])
  }))
  it.effect("a13: the kit refuses a fifth simultaneous press on one page and releases slots", () => Effect.gen(function*() {
    let present: ModulePresent | undefined
    let active = 0
    let peak = 0
    const module = defineModule({ apiVersion: 2, id: "board", name: "Board", description: "Test", shared: (ctx) => Effect.gen(function*() {
      present = ctx.present
      yield* present.handle("answer", { run: () => Effect.gen(function*() {
        active++
        peak = Math.max(peak, active)
        yield* Effect.sleep(300)
        active--
        return { say: "Done" }
      }) }).pipe(Effect.orDie)
      return { value: undefined }
    }), start: () => Effect.succeed({}) })
    const kit = yield* startTestModule(module)
    const ids: Array<string> = []
    for (let i = 0; i < 5; i++) ids.push((yield* present!.show({ device: "kitchen-display" }, card(`P${i}`, { handler: "answer", buttons: [{ id: "go", label: "Go" }] }), { lifetime: "pinned" })).id)
    yield* kit.present.settle
    const answers = yield* Effect.forEach(ids, (id) => kit.present.press(id, "go"), { concurrency: "unbounded" })
    assert.strictEqual(peak, 4)
    assert.strictEqual(answers.filter((a) => a.code === "busy").length, 1)
    assert.isTrue((yield* kit.present.press(ids[4]!, "go")).ok)
  }))
})
