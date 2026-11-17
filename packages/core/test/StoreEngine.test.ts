// The engine's settlement, with a backend that fails where SQLite can: a COMMIT that fails, a transaction the backend
// ended itself, a BEGIN that finds the database locked. Each is a typed StoreError (never a defect), the rollback
// hooks run, nothing is released, and the store goes on working.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { defineCollection, type StoreError } from "../src/HouseholdStore.ts"
import { makeMemoryBackend } from "../src/MemoryHouseholdStore.ts"
import { makeStoreEngine, type SyncBackend } from "../src/StoreEngine.ts"

const items = defineCollection({ name: "items", scope: "household", schema: Schema.Struct({ text: Schema.String }) })
const errorOf = <A>(exit: Exit.Exit<A, unknown>) => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: StoreError } | undefined)?.error : undefined)

/** The in-memory backend with faults to switch on. */
const faulty = () => {
  const inner = makeMemoryBackend()
  const faults = { commit: false, endItself: false, busyBegins: 0 }
  let ended = false
  const backend: SyncBackend = {
    ...inner,
    begin: () => {
      if (faults.busyBegins > 0) {
        faults.busyBegins--
        throw Object.assign(new Error("database is locked"), { errcode: 5 })
      }
      ended = false
      inner.begin()
    },
    commit: () => {
      if (faults.commit) throw new Error("FOREIGN KEY constraint failed")
      inner.commit()
    },
    inTransaction: () => !ended && inner.inTransaction(),
    put: (doc, keys, expect) => {
      const done = inner.put(doc, keys, expect)
      if (faults.endItself) {
        // As SQLite does on SQLITE_FULL: the transaction is rolled back underneath the engine.
        inner.rollback()
        ended = true
        throw new Error("database or disk is full")
      }
      return done
    }
  }
  return { backend, faults }
}

const setup = Effect.gen(function*() {
  const { backend, faults } = faulty()
  const engine = makeStoreEngine({ backend })
  yield* engine.prepare([{ id: "m", storage: { collections: [items] } }])
  const heard: Array<unknown> = []
  engine.onCommit((r) => heard.push(...r))
  return { engine, faults, heard, c: engine.forModule("m").collection(items) }
})

describe("the store engine settles every transaction itself", () => {
  it.effect("a COMMIT that fails is a StoreError, the rollback hooks run, nothing is released, the store goes on", () =>
    Effect.gen(function*() {
      const { engine, faults, heard, c } = yield* setup
      faults.commit = true
      const undone: Array<string> = []
      const exit = yield* Effect.exit(engine.forModule("m").transaction((tx) => {
        tx.onRollback(() => undone.push("undone"))
        tx.collection(items).insert({ text: "x" })
        tx.publish("done", {})
      }))
      assert.strictEqual(errorOf(exit)?._tag, "StoreError")
      assert.strictEqual(errorOf(exit)?.reason, "failed")
      assert.match(errorOf(exit)?.message ?? "", /could not be committed/)
      assert.deepStrictEqual(undone, ["undone"])
      assert.deepStrictEqual(heard, [])
      assert.isFalse(engine.inTransaction())
      faults.commit = false
      assert.deepStrictEqual(yield* c.list(), [])
      yield* c.insert({ text: "later" })
      assert.strictEqual((yield* c.list()).length, 1)
    }).pipe(Effect.scoped))

  it.effect("a transaction the backend ended itself fails whole with a StoreError, also when the function caught the failure", () =>
    Effect.gen(function*() {
      const { engine, faults, heard, c } = yield* setup
      const undone: Array<string> = []
      const exit = yield* Effect.exit(engine.forModule("m").transaction((tx) => {
        tx.onRollback(() => undone.push("undone"))
        faults.endItself = true
        try {
          tx.collection(items).insert({ text: "fills the disk" })
        } catch {
          // Caught: the engine must still refuse to go on or commit.
        }
        faults.endItself = false
        try {
          tx.collection(items).insert({ text: "after" })
        } catch {
          // Refused too.
        }
      }))
      assert.strictEqual(errorOf(exit)?.reason, "failed")
      assert.match(errorOf(exit)?.message ?? "", /ended the household transaction itself/)
      assert.deepStrictEqual(undone, ["undone"])
      assert.deepStrictEqual(heard, [])
      assert.deepStrictEqual(yield* c.list(), [])
    }).pipe(Effect.scoped))

  it.live("a BEGIN that finds the database locked is tried again on a timer; locked for longer, it is a typed `busy` failure and nothing ran", () =>
    Effect.gen(function*() {
      const { engine, faults, c } = yield* setup
      faults.busyBegins = 3
      assert.strictEqual((yield* c.insert({ text: "after three tries" })).value.text, "after three tries")
      faults.busyBegins = 1000
      let ran = false
      const exit = yield* Effect.exit(engine.forModule("m").transaction(() => {
        ran = true
      }))
      assert.strictEqual(errorOf(exit)?.reason, "busy")
      assert.isFalse(ran)
      faults.busyBegins = 0
      assert.strictEqual((yield* c.list()).length, 1)
    }).pipe(Effect.scoped))
})
