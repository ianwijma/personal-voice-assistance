// The Presenter on the SQLite store passes the same contract as in memory: in memory, and on a file that a
// "restart" closes and opens again.
import { presentContract } from "@pva/core/present-contract"
import { Effect, Exit, Scope } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"

presentContract("SQLite in memory", () =>
  Effect.gen(function*() {
    const store = yield* makeSqliteStore({ filename: ":memory:" })
    return { store, reopen: Effect.succeed(store) }
  }))

presentContract("SQLite on a file", () =>
  Effect.gen(function*() {
    const file = join(mkdtempSync(join(tmpdir(), "pva-present-")), "household.db")
    const outer = yield* Effect.scope
    let scope = yield* Scope.fork(outer)
    const store = yield* Scope.provide(scope)(makeSqliteStore({ filename: file }))
    const reopen = Effect.gen(function*() {
      yield* Scope.close(scope, Exit.void)
      scope = yield* Scope.fork(outer)
      return yield* Scope.provide(scope)(makeSqliteStore({ filename: file }))
    })
    return { store, reopen }
  }))
