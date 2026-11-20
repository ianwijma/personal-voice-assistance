// The notification service on the in-memory household store (`@pva/core/testing`) passes the same contract as on SQLite.
import { Effect } from "effect"
import { notifyContract } from "../src/notifyContract.ts"
import { makeMemoryHouseholdStore } from "../src/testing.ts"

notifyContract("in memory", () =>
  Effect.sync(() => {
    const store = makeMemoryHouseholdStore()
    return { store, reopen: Effect.succeed(store) }
  }))
