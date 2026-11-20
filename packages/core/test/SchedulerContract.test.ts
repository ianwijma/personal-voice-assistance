// The scheduler on the in-memory household store (`@pva/core/testing`) passes the same contract as on SQLite.
import { Effect } from "effect"
import { schedulerContract } from "../src/schedulerContract.ts"
import { makeMemoryHouseholdStore } from "../src/testing.ts"

schedulerContract("in memory", () =>
  Effect.sync(() => {
    const store = makeMemoryHouseholdStore()
    return { store, reopen: Effect.succeed(store) }
  }))
