// The in-memory household store (`@pva/core/testing`) passes the same contract as the SQLite store.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { householdStoreContract } from "../src/storeContract.ts"
import { makeMemoryHouseholdStore } from "../src/testing.ts"

householdStoreContract("in memory", (options) => Effect.succeed(makeMemoryHouseholdStore(options)))

describe("the in-memory store's rollback hook (a core service's in-memory table joins its transactions)", () => {
  it.effect("an undo runs when its savepoint or the transaction rolls back, newest first; never after a commit", () =>
    Effect.gen(function*() {
      const store = makeMemoryHouseholdStore()
      const table = new Map<string, number>()
      const write = (k: string, v: number) =>
        store.transaction(Effect.suspend(() => {
          const before = table.get(k)
          table.set(k, v)
          return store.onRollback(() => (before === undefined ? table.delete(k) : table.set(k, before)))
        }))
      yield* write("a", 1)
      // A savepoint that fails takes its writes back; the parent's stay and commit.
      yield* store.transaction(Effect.gen(function*() {
        yield* write("a", 2)
        yield* Effect.exit(store.transaction(Effect.andThen(Effect.andThen(write("a", 3), write("b", 1)), Effect.fail("no"))))
        assert.deepStrictEqual([...table], [["a", 2]])
      }))
      assert.deepStrictEqual([...table], [["a", 2]])
      // A committed savepoint's undo goes up to its parent: the parent's failure takes it back too.
      yield* Effect.exit(store.transaction(Effect.gen(function*() {
        yield* store.transaction(Effect.andThen(write("a", 4), write("c", 1)))
        return yield* Effect.fail("outer")
      })))
      assert.deepStrictEqual([...table], [["a", 2]])
      // Outside a transaction: nothing to undo.
      yield* store.onRollback(() => table.clear())
      assert.deepStrictEqual([...table], [["a", 2]])
    }))
})
