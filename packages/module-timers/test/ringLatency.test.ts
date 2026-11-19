// How late a timer rings (docs/modules/timers.md, "How late it rings"). A latency test: it imports latencyBound.ts, so
// CI runs it alone after the rest. What it measures, through the kit's real scheduler engine, notification service and
// page boundary on the in-memory store:
//
// - on the scheduler's clock (the test clock): the instant the ring was stored and sent, against the timer's due
//   instant, for ten timers due at the same instant (the most rings one module may have open);
// - in real time: from the scheduler calling the ring job's handler to the ringing card leaving for the device's page
//   (the module's own work: the lock, a row read, the send, the row's write, the countdown taken down), and from the
//   first handler call to the last of the ten cards.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { timersModule } from "../src/index.ts"

const MIN = 60_000
const RINGS = 10

/** The module with the real time of each ring handler's call and each send recorded (a test's own wrapper). */
const timed = (calls: Array<number>, sends: Array<number>): typeof timersModule => ({
  ...timersModule,
  shared: (ctx) =>
    timersModule.shared!({
      ...ctx,
      scheduler: {
        ...ctx.scheduler,
        handle: (name, handler) =>
          ctx.scheduler.handle(name, name !== "ring" ? handler : { ...handler, run: (payload, due) => Effect.andThen(Effect.sync(() => void calls.push(performance.now())), handler.run(payload, due)) })
      },
      notify: { ...ctx.notify, send: (request) => Effect.tap(ctx.notify.send(request), () => Effect.sync(() => void sends.push(performance.now()))) }
    })
})

describe("how late a timer rings", () => {
  it.effect("on the scheduler's clock: at its due instant; in real time: the module's share stays small", () =>
    Effect.gen(function*() {
      const rounds: Array<{ readonly each: number; readonly all: number }> = []
      for (let round = 0; round < 5; round++) {
        const calls: Array<number> = []
        const sends: Array<number> = []
        const kit = yield* startTestModule(timed(calls, sends))
        for (let i = 0; i < RINGS; i++) yield* kit.action("start", { duration: "1 minute", name: `t${i}` })
        const due = (yield* kit.now) + MIN
        yield* kit.advance(MIN)
        const sent = (yield* kit.notify.all).filter((n) => n.key?.startsWith("timer:"))
        assert.strictEqual(sent.length, RINGS)
        // Stored and sent at the due instant: 0 ms late on the scheduler's clock.
        assert.deepStrictEqual(sent.map((n) => n.sentAt - due), Array(RINGS).fill(0))
        // Every card reached the device's page.
        yield* kit.notify.settle
        assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, RINGS)
        assert.strictEqual(calls.length, RINGS)
        assert.strictEqual(sends.length, RINGS)
        const each = Math.max(...sends.map((s, i) => s - calls[i]!))
        rounds.push({ each, all: sends.at(-1)! - calls[0]! })
      }
      const worstEach = Math.max(...rounds.map((r) => r.each))
      const worstAll = Math.max(...rounds.map((r) => r.all))
      console.log(`timers: ring handler call → card sent, worst of ${RINGS} × 5: ${worstEach.toFixed(2)} ms; first call → last of ${RINGS} cards, worst of 5: ${worstAll.toFixed(2)} ms`)
      assert.isBelow(worstEach, bound(10))
      assert.isBelow(worstAll, bound(60))
    }))
})
