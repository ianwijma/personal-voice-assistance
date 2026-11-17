// The scheduler on the SQLite store (`core_scheduler__jobs`) passes the same contract as the test double, and keeps
// its jobs across a real reopen of the database file.
import { assert, describe, it } from "@effect/vitest"
import { sqlJobTable } from "@pva/core"
import { makeTestScheduler } from "@pva/core/testing"
import { CONTRACT_MODULES, schedulerContract } from "@pva/core/scheduler-contract"
import { Effect, Exit, Scope } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"

schedulerContract("SQLite in memory", () =>
  Effect.gen(function*() {
    const store = yield* makeSqliteStore({ filename: ":memory:" })
    yield* store.prepare(CONTRACT_MODULES)
    return { store, table: sqlJobTable(store) }
  }))

describe("the scheduler on a database file", () => {
  it.effect("a job survives closing and reopening the file, and fires at its time", () =>
    Effect.gen(function*() {
      const file = join(mkdtempSync(join(tmpdir(), "pva-sched-")), "household.db")
      const first = yield* Scope.make()
      const store = yield* makeSqliteStore({ filename: file }).pipe(Scope.provide(first))
      const made = yield* makeTestScheduler({ table: sqlJobTable(store) }).pipe(Scope.provide(first))
      const job = yield* made.scheduler.forModule("tm").schedule({
        kind: "timer",
        key: "timer:pasta",
        when: { inMs: 60_000 },
        onDue: { notify: { kind: "timer", priority: "high", content: { title: "Pasta" } } }
      })
      yield* Scope.close(first, Exit.void)
      const second = yield* Scope.make()
      const reopened = yield* makeSqliteStore({ filename: file }).pipe(Scope.provide(second))
      const again = yield* makeTestScheduler({ table: sqlJobTable(reopened) }).pipe(Scope.provide(second))
      assert.strictEqual((yield* again.scheduler.forModule("tm").get(job.id))?.key, "timer:pasta")
      yield* TestClock.adjust(60_000)
      yield* Effect.repeat(Effect.yieldNow, { times: 50 })
      assert.deepStrictEqual(again.deliveries.map((d) => d.info.notificationId), [`${job.id}@60000`])
      // A read-only open (the CLI modes, doctor) reads the jobs and refuses to write them.
      const third = yield* Scope.make()
      const readOnly = yield* makeSqliteStore({ filename: file, readOnly: true }).pipe(Scope.provide(third))
      const rows = yield* sqlJobTable(readOnly).query({ limit: 10 })
      assert.strictEqual(rows[0]?.state, "done")
      yield* Scope.close(third, Exit.void)
      yield* Scope.close(second, Exit.void)
    }))
})
