// The in-memory household store (`@pva/core/testing`) passes the same contract as the SQLite store.
import { Effect } from "effect"
import { householdStoreContract } from "../src/storeContract.ts"
import { makeMemoryHouseholdStore } from "../src/testing.ts"

householdStoreContract("in memory", (options) => Effect.succeed(makeMemoryHouseholdStore(options)))
