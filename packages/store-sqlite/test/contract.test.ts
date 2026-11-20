// The SQLite store passes the household store contract, in memory and on a file.
import { householdStoreContract } from "@pva/core/store-contract"
import { Effect } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"

householdStoreContract("SQLite in memory", (options) => makeSqliteStore({ filename: ":memory:", ...options }))

householdStoreContract("SQLite on a file", (options) =>
  Effect.gen(function*() {
    const dir = mkdtempSync(join(tmpdir(), "pva-store-"))
    const file = join(dir, "household.db")
    if (options?.readOnly === true) {
      // A read-only open needs an existing database: make one, then open it read-only.
      yield* Effect.scoped(makeSqliteStore({ filename: file }))
    }
    return yield* makeSqliteStore({ filename: file, ...options })
  }))
