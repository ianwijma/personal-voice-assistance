// The Presenter's contract on the in-memory store (the same suite runs on SQLite in packages/store-sqlite).
import { Effect } from "effect"
import { presentContract } from "../../src/presentContract.ts"
import { makeMemoryHouseholdStore } from "../../src/testing.ts"

presentContract("in memory", () =>
  Effect.sync(() => {
    const store = makeMemoryHouseholdStore()
    return { store, reopen: Effect.succeed(store) }
  }))
