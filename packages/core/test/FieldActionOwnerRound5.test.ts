// Review round 5 of PR 90, finding 5A-1: two presses of one button can never both pass the busy check, however the
// scheduler interleaves them, and whatever was admitted belongs to the owner (`stop` and `settled` see it).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Scheduler } from "effect"
import { makeFieldActionOwner } from "../src/FieldActionOwner.ts"
import { makeModuleSlots, MAX_PRESS_SLOTS } from "../src/ModuleSlots.ts"

describe("FieldActionOwner (review round 5)", () => {
  it.effect("5A-1: thirty concurrent presses of one button, yielding after every operation: one runs, the rest are busy; after stop and settled no fiber or slot is left", () =>
    Effect.gen(function*() {
      const slots = makeModuleSlots({ cap: MAX_PRESS_SLOTS })
      const owner = makeFieldActionOwner({ slots, moduleOf: () => "m" })
      const probe = { started: 0, active: 0 }
      const fibers: Array<Fiber.Fiber<unknown, unknown>> = []
      const work = Effect.suspend(() => {
        probe.started++
        probe.active++
        return Effect.never.pipe(Effect.ensuring(Effect.sync(() => probe.active--)))
      })
      const outcomes: Array<string> = []
      const presses = yield* Effect.forEach(
        Array.from({ length: 30 }, (_, i) => i),
        () =>
          Effect.forkChild(
            owner.start("same", work, 10_000, (fiber) => fibers.push(fiber)).pipe(
              Effect.tap((o) => Effect.sync(() => outcomes.push(o._tag))),
              Effect.provideService(Scheduler.MaxOpsBeforeYield, 1)
            )
          )
      )
      yield* Effect.repeat(Effect.yieldNow, { times: 200 })
      assert.strictEqual(fibers.length, 1, "exactly one press was started")
      assert.strictEqual(probe.started, 1)
      assert.strictEqual(slots.taken("m"), 1)
      assert.deepStrictEqual(outcomes, Array.from({ length: 29 }, () => "busy"))
      assert.deepStrictEqual(owner.inFlight(), ["same"])
      yield* owner.stop.pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1))
      yield* owner.settled
      for (const fiber of fibers) assert.isDefined(fiber.pollUnsafe(), "every started press has ended")
      assert.strictEqual(probe.active, 0)
      assert.strictEqual(slots.taken("m"), 0)
      assert.deepStrictEqual(owner.inFlight(), [])
      yield* Effect.forEach(presses, Fiber.await)
      assert.deepStrictEqual(outcomes.filter((t) => t !== "busy"), ["stopped"])
    }))

  it.effect("5A-1: a press refused for want of a slot, or whose caller is interrupted while it is admitted, leaves its key free", () =>
    Effect.gen(function*() {
      const slots = makeModuleSlots({ cap: 1 })
      const owner = makeFieldActionOwner({ slots, moduleOf: () => "m" })
      const holder = yield* Effect.forkChild(owner.start("a", Effect.never, 10_000))
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      assert.deepStrictEqual(yield* owner.start("b", Effect.void, 10_000), { _tag: "full" })
      assert.deepStrictEqual(owner.inFlight(), ["a"])
      // Interrupted at every step of its admission: never a reserved key left behind.
      for (let k = 0; k < 20; k++) {
        const caller = yield* Effect.forkChild(owner.start("c", Effect.never, 10_000).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1)))
        yield* Effect.repeat(Effect.yieldNow, { times: k })
        yield* Fiber.interrupt(caller)
        assert.deepStrictEqual(owner.inFlight(), ["a"], `k = ${k}`)
      }
      yield* owner.stop
      yield* Fiber.await(holder)
      assert.deepStrictEqual(owner.inFlight(), [])
      assert.strictEqual(slots.taken("m"), 0)
    }))
})
