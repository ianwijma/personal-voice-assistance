// A scheduler transaction that finds the store's write lock taken (another connection holds it, as the checkpoint
// worker does while it starts a new log: docs/STORING-DATA.md "The write-ahead log") waits on real timers and is then
// written. `settled` (the scheduler's test synchronisation) must wait for it, whatever the test's clock says.
import { assert, describe, it } from "@effect/vitest"
import { type CoreOwner, makeIssueRegistry, makeSchedulerEngine, schedulerStorage } from "@pva/core"
import { engineOn } from "@pva/core/scheduler-contract"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"

describe("the scheduler while another connection holds the store's write lock", () => {
  it.effect("a run that becomes due then is claimed, run and written once the lock is free; settled waits for that", () =>
    Effect.scoped(Effect.gen(function*() {
      const file = join(mkdtempSync(join(tmpdir(), "pva-scheduler-busy-")), "household.db")
      const store = yield* makeSqliteStore({ filename: file })
      yield* store.prepare([], [schedulerStorage])
      const engine = yield* makeSchedulerEngine({ store, issues: makeIssueRegistry() })
      const core = engine.forCore("core.busy" as CoreOwner)
      const ran: Array<number> = []
      yield* core.handle("h", { payload: Schema.Unknown, run: (_p, due) => Effect.sync(() => void ran.push(due.dueAt)) })
      const job = yield* core.schedule({ handler: "h", inMs: 1_000 })
      yield* engine.settled
      // Another connection takes the write lock and lets it go 300 ms later (real time).
      const other = new DatabaseSync(file)
      other.exec("PRAGMA busy_timeout = 0")
      other.exec("BEGIN IMMEDIATE")
      const release = setTimeout(() => {
        other.exec("COMMIT")
        other.close()
      }, 300)
      try {
        yield* TestClock.adjust(1_000)
        yield* engine.settled
      } finally {
        clearTimeout(release)
        if (other.isOpen) {
          other.exec("ROLLBACK")
          other.close()
        }
      }
      assert.deepStrictEqual(ran, [1_000])
      assert.strictEqual((yield* core.get(job.id))?.state, "done")
    })), { timeout: 30_000 })

  it.effect("the contract's advance stops at a pass that waits for the lock: the job runs on time, not late or missed", () =>
    Effect.scoped(Effect.gen(function*() {
      const file = join(mkdtempSync(join(tmpdir(), "pva-scheduler-busy-")), "household.db")
      const store = yield* makeSqliteStore({ filename: file })
      yield* store.prepare([], [schedulerStorage])
      const { engine, advance } = yield* engineOn(store)
      const core = engine.forCore("core.busy" as CoreOwner)
      const ran: Array<number> = []
      yield* core.handle("h", { payload: Schema.Unknown, run: (_p, due) => Effect.sync(() => void ran.push(due.dueAt)) })
      // Due in 1 s, and missed when it cannot run within 2 s of that.
      const job = yield* core.schedule({ handler: "h", inMs: 1_000, late: { withinMs: 2_000 } })
      yield* advance(0)
      const other = new DatabaseSync(file)
      other.exec("PRAGMA busy_timeout = 0")
      other.exec("BEGIN IMMEDIATE")
      const release = setTimeout(() => {
        other.exec("COMMIT")
        other.close()
      }, 300)
      try {
        // Ten seconds in one call: the pass at 1 s waits 300 ms (real time) for the lock; the clock must wait with it.
        yield* advance(10_000)
      } finally {
        clearTimeout(release)
        if (other.isOpen) {
          other.exec("ROLLBACK")
          other.close()
        }
      }
      assert.deepStrictEqual(ran, [1_000])
      assert.strictEqual((yield* core.get(job.id))?.state, "done")
    })), { timeout: 30_000 })
})
