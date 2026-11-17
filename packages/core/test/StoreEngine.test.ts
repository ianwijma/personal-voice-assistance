// The engine's settlement, with a backend that fails where SQLite can: a COMMIT that fails, a transaction the backend
// ended itself, a BEGIN that finds the database locked. Each is a typed StoreError (never a defect), the rollback
// hooks run, nothing is released, and the store goes on working.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Schema } from "effect"
import { CurrentTurn } from "../src/TurnContext.ts"
import { BULK_STEP_ROWS, defineCollection, type StoreError } from "../src/HouseholdStore.ts"
import { makeMemoryBackend } from "../src/MemoryHouseholdStore.ts"
import { makeStoreEngine, type SyncBackend } from "../src/StoreEngine.ts"

const items = defineCollection({ name: "items", scope: "household", schema: Schema.Struct({ text: Schema.String }) })
const errorOf = <A>(exit: Exit.Exit<A, unknown>) => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: StoreError } | undefined)?.error : undefined)

/** The in-memory backend with faults to switch on. */
const faulty = () => {
  const inner = makeMemoryBackend()
  const faults = { commit: false, endItself: false, busyBegins: 0, onRows: undefined as (() => void) | undefined }
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
    conversationRows: (conversationId, after, limit) => {
      faults.onRows?.()
      return inner.conversationRows(conversationId, after, limit)
    },
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

const chat = defineCollection({ name: "chat", scope: "conversation", schema: Schema.Struct({ text: Schema.String }) })
const inConversation = (conversationId: string) => <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.provideService(e, CurrentTurn, { turnId: 1, conversationId, source: "voice" })

const setup = Effect.gen(function*() {
  const { backend, faults } = faulty()
  const engine = makeStoreEngine({ backend })
  yield* engine.prepare([{ id: "m", storage: { collections: [items, chat] } }])
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

  it.live("a bulk removal that fails (busy through every retry) or is interrupted between steps ends its hiding: a retry removes the rest and the conversation is usable again", () =>
    Effect.gen(function*() {
      const { engine, faults } = yield* setup
      const c = engine.forModule("m").collection(chat)
      const n = BULK_STEP_ROWS * 2 + 50
      yield* engine.forModule("m").transaction((tx) => {
        for (let i = 0; i < n; i++) tx.collection(chat).insert({ text: `r${i}` })
      }).pipe(inConversation("c1"))
      // Busy through all retries: the sweep fails `busy`, and hides nothing afterwards.
      faults.busyBegins = 1000
      assert.strictEqual(errorOf(yield* Effect.exit(engine.sweepConversations))?.reason, "busy")
      faults.busyBegins = 0
      assert.isDefined(yield* c.insert({ text: "a new conversation" }).pipe(inConversation("c2")))
      assert.strictEqual((yield* c.list().pipe(inConversation("c1"))).length, 20)
      // Interrupted after its first step: hidden while it ran, visible (what is left) after.
      let steps = 0
      // After its first step the next one finds the database locked (retried on a timer): it is interrupted there.
      faults.onRows = () => {
        steps++
        faults.busyBegins = 1000
      }
      const ending = yield* Effect.forkChild(engine.endConversation("c1"))
      while (steps < 1) yield* Effect.yieldNow
      yield* Effect.sleep(5)
      yield* Fiber.interrupt(ending)
      faults.onRows = undefined
      faults.busyBegins = 0
      assert.strictEqual(steps, 1)
      assert.isDefined(yield* c.insert({ text: "after the interruption" }).pipe(inConversation("c1")))
      assert.strictEqual(yield* engine.endConversation("c1"), n + 1 - BULK_STEP_ROWS)
      assert.isDefined(yield* c.insert({ text: "after the retry" }).pipe(inConversation("c1")))
      assert.strictEqual(yield* engine.sweepConversations, 2)
      assert.isDefined(yield* c.insert({ text: "after the sweep" }).pipe(inConversation("c3")))
    }).pipe(Effect.scoped))
})

describe("the store engine: a read never migrates", () => {
  it.effect("Sol's sequence over fresh engines on one backend: a no-op version, then a migration from a version no row is at; get and list agree with the stored value", () =>
    Effect.gen(function*() {
      const backend = makeMemoryBackend()
      const Count = Schema.Struct({ n: Schema.Finite })
      const v1 = defineCollection({ name: "counts", scope: "household", schema: Count, indexes: ["n"] })
      const v3 = defineCollection({ name: "counts", scope: "household", schema: Count, indexes: ["n"], migrate: { 1: (old: { n: number }) => ({ ...old, n: 2 }) } })
      const first = makeStoreEngine({ backend })
      yield* first.prepare([{ id: "m", storage: { collections: [v1] } }])
      yield* first.forModule("m").collection(v1).insert({ n: 1 }, { id: "x" })
      yield* makeStoreEngine({ backend }).prepare([{ id: "m", storage: { version: 2, collections: [v1] } }])
      const third = makeStoreEngine({ backend })
      yield* third.prepare([{ id: "m", storage: { version: 3, collections: [v3] } }])
      assert.strictEqual(third.availability("m"), undefined)
      const c = third.forModule("m").collection(v3)
      assert.strictEqual((yield* c.get("x"))?.value.n, 1)
      assert.deepStrictEqual((yield* c.list({ where: { n: 1 } })).map((r) => r.id), ["x"])
      assert.deepStrictEqual(yield* c.list({ where: { n: 2 } }), [])
      assert.strictEqual(backend.read("m", "counts", "x")?.text, JSON.stringify({ n: 1 }))
      assert.strictEqual(backend.storedCollections("m").get("counts")?.version, 3)
    }).pipe(Effect.scoped))
})
