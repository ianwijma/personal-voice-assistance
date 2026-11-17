// The test double (the engine on the in-memory store) passes the scheduler contract; the SQLite store runs the same
// suite in packages/store-sqlite/test/schedulerContract.test.ts.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { closedModuleScheduler, defineModule, makeModuleHost, memoryJobTable, readOnlyPersistence } from "../src/index.ts"
import { CONTRACT_MODULES, schedulerContract } from "../src/schedulerContract.ts"
import { makeMemoryHouseholdStore, makeTestScheduler } from "../src/testing.ts"

schedulerContract("the test double", () =>
  Effect.gen(function*() {
    const store = makeMemoryHouseholdStore()
    yield* store.prepare(CONTRACT_MODULES)
    return { store, table: memoryJobTable(store) }
  }))

describe("ctx.scheduler in the module host", () => {
  it.effect("a version 2 module registers a handler in shared and schedules from start", () =>
    Effect.gen(function*() {
      const { deliveries, scheduler } = yield* makeTestScheduler()
      const ran: Array<string> = []
      const def = defineModule({
        id: "tm",
        name: "Timers",
        description: "",
        apiVersion: 2,
        enabledByDefault: true,
        shared: (ctx) =>
          Effect.gen(function*() {
            yield* ctx.scheduler.handle("ring", Schema.Struct({ label: Schema.String }), (p) => Effect.sync(() => ran.push(p.label)))
            return { value: ctx.scheduler }
          }),
        start: () => Effect.succeed({})
      })
      const host = yield* makeModuleHost({ catalog: [def], persistence: readOnlyPersistence(), env: {}, scheduler })
      yield* host.startEnabled
      assert.strictEqual(host.modules()[0]?.state, "running")
      const tm = scheduler.forModule("tm")
      yield* tm.schedule({ kind: "timer", when: { inMs: 0 }, onDue: { handler: "ring", payload: { label: "pasta" } } })
      yield* Effect.repeat(Effect.yieldNow, { times: 50 })
      assert.deepStrictEqual(ran, ["pasta"])
      assert.strictEqual(deliveries.length, 0)
    }))

  it.effect("without a scheduler (the CLI modes) handle succeeds and everything else fails unavailable", () =>
    Effect.gen(function*() {
      const closed = closedModuleScheduler("Timers run only in the server")
      yield* closed.handle("x", Schema.Unknown, () => Effect.void)
      const e = yield* Effect.flip(closed.schedule({ kind: "timer", when: { inMs: 1 }, onDue: { notify: { kind: "timer", priority: "high", content: { title: "t" } } } }))
      assert.strictEqual(e._tag, "SchedulerError")
      assert.strictEqual(e.reason, "unavailable")
      assert.strictEqual(e.message, "Timers run only in the server")
    }))
})
