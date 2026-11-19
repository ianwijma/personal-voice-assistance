// GPT review round 3, finding 4: real event-loop gaps, including the atomic write and keyed job cancellations.
import { assert, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { timersModule } from "../src/index.ts"

it.effect("4: cancelling 190 expired timers keeps a 1ms heartbeat below the main-thread budget", () => Effect.gen(function*() {
  const samples: Array<{ readonly gap: number; readonly transaction: number }> = []
  for (let round = 0; round < 4; round++) {
    let active = false, transaction = 0, ticks = 0, pendingRows = 0, scanTicks = 0
    let firstScanTick: number | undefined
    const kit = yield* startTestModule({ ...timersModule, shared: (ctx) => timersModule.shared!({ ...ctx, store: { ...ctx.store, collection: (c) => {
      const store = ctx.store.collection(c)
      return { ...store, list: (q) => Effect.tap(store.list(q), (rows) => Effect.sync(() => {
        if (active && q?.where !== undefined && "pending" in q.where && q.where.pending === true && rows.length > 0) {
          firstScanTick ??= ticks
          pendingRows += rows.length
          scanTicks = ticks - firstScanTick
        }
      })) }
    }, transaction: (f) => ctx.store.transaction((tx) => {
      const start = performance.now()
      try { return f(tx) } finally { if (active) transaction = Math.max(transaction, performance.now() - start) }
    }) } }) })
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < (batch === 3 ? 40 : 50); i++) yield* kit.action("start", { duration: "1 minute", name: `b${batch}n${i}` })
      yield* kit.advance(60_000)
    }
    let gap = 0, last = performance.now()
    const heartbeat = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; ticks++ }, 1)
    try {
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 3)))
      active = true
      const outcome = yield* kit.action("cancel", { all: true, bulk: "timers" })
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 3)))
      assert.isTrue(outcome.ok)
      assert.include(outcome.say!, "190 timers")
      assert.isAbove(ticks, 0)
      assert.strictEqual(pendingRows, 190)
      assert.isAbove(scanTicks, 0, "the heartbeat must run while pending rows are still being read")
      samples.push({ gap, transaction })
    } finally { clearInterval(heartbeat) }
    yield* kit.stop
  }
  console.log(`cancel-all heartbeat (four runs of 190): ${JSON.stringify(samples)}; longest stop ${Math.max(...samples.map((s) => s.gap)).toFixed(2)} ms`)
  assert.isBelow(Math.max(...samples.map((s) => s.gap)), bound(10))
}), { timeout: 60_000 })
