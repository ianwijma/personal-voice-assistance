// The test kit as docs/SCHEDULING.md "Testing a module" shows it: makeTestScheduler with a module host, on the test clock.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineCollection } from "../src/HouseholdStore.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import type { ModuleScheduler } from "../src/Scheduler.ts"
import { makeTestScheduler } from "../src/testing.ts"

const Timer = Schema.Struct({ label: Schema.String })
const timers = defineCollection({ name: "timers", scope: "household", schema: Timer })
const rang: Array<string> = []
let scheduler: ModuleScheduler | undefined
const timersModule = defineModule({
  apiVersion: 2,
  id: "timers",
  name: "Timers",
  description: "Test",
  storage: { collections: [timers] },
  shared: (ctx) =>
    Effect.gen(function*() {
      scheduler = ctx.scheduler
      yield* ctx.scheduler.handle("ring", { payload: Schema.Struct({ label: Schema.String }), run: (p) => Effect.sync(() => void rang.push(p.label)) }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})

describe("makeTestScheduler", () => {
  it.effect("the documented setup: a module's handler runs when the test clock reaches its job", () =>
    Effect.gen(function*() {
      const { advance, household, scheduler: engine } = yield* makeTestScheduler({ modules: [timersModule] })
      const host = yield* makeModuleHost({ catalog: [timersModule], persistence: readOnlyPersistence(), env: {}, household: household!, scheduler: engine })
      yield* host.startEnabled
      const job = yield* scheduler!.prepare({ handler: "ring", payload: { label: "pasta" }, inMs: 10 * 60_000 })
      yield* household!.store.forModule("timers").transaction((tx) => {
        tx.collection(timers).insert({ label: "pasta" })
        job.writeIn(tx)
      })
      yield* advance(10 * 60_000 - 1)
      assert.deepStrictEqual(rang, [])
      yield* advance(1)
      assert.deepStrictEqual(rang, ["pasta"])
    }))
})
