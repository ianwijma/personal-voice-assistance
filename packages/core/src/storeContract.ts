/**
 * The contract every `HouseholdStore` passes (`@pva/core/store-contract`): the in-memory double
 * (`makeMemoryHouseholdStore`) and the SQLite store run the same tests, so a module tested on the double behaves the
 * same on the real store. Test-only: imports vitest.
 */
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Schema, type Scope, Stream } from "effect"
import { connectStoreToBus, defineEventType, type HouseholdEvent, makeEventBus } from "./EventBus.ts"
import { type FeedProblem, makeHouseholdFeed, SNAPSHOT_PART_CHARS } from "./HouseholdFeed.ts"
import {
  type Actor,
  type Collection,
  defineCollection,
  type HouseholdStore,
  MAX_VALUE_CHARS,
  type ModuleStorage,
  type Row,
  StoreError
} from "./HouseholdStore.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

export const Note = Schema.Struct({ text: Schema.String, tag: Schema.optionalKey(Schema.String), n: Schema.optionalKey(Schema.Finite), done: Schema.optionalKey(Schema.Boolean) })
export type Note = typeof Note.Type

export const notes = defineCollection({ name: "notes", scope: "household", schema: Note, indexes: ["tag", "n", "done"], search: ["text"] })
export const mine = defineCollection({ name: "mine", scope: "person", schema: Note })
export const dev = defineCollection({ name: "dev", scope: "device", schema: Note, search: ["text"] })
export const chat = defineCollection({ name: "chat", scope: "conversation", schema: Note })
export const forgettable = defineCollection({ name: "forgettable", scope: "household", schema: Note, history: "none", search: ["text"] })
/** Shown on every page whose device is the row's `tag`; hidden elsewhere. */
export const shown = defineCollection({
  name: "shown",
  scope: "household",
  schema: Note,
  project: (row: Row<Note>, device) => (row.value.tag === undefined || row.value.tag === device.id ? { text: row.value.text } : undefined)
})

/** Any JSON in its indexed field `k` (to check what an index accepts and how both stores order it). */
export const loose = defineCollection({
  name: "loose",
  scope: "household",
  schema: Schema.Struct({ k: Schema.optionalKey(Schema.Unknown) }),
  indexes: ["k"]
})
/** A projection that throws for `tag: "bad"` and returns a BigInt for `tag: "big"`. */
export const broken = defineCollection({
  name: "broken",
  scope: "household",
  schema: Note,
  project: (row: Row<Note>) => {
    if (row.value.tag === "bad") throw new Error("projection bug")
    if (row.value.tag === "big") return { n: 1n }
    return { text: row.value.text }
  }
})
/** A collection whose name is also a property of every object. */
export const constructorCollection = defineCollection({ name: "constructor", scope: "household", schema: Note })

export const KIT: { readonly id: string; readonly storage: ModuleStorage } = {
  id: "kit",
  storage: { collections: [notes, mine, dev, chat, forgettable, shown, loose, broken, constructorCollection] }
}

export const turnOf = (over: Partial<TurnContext> = {}): TurnContext => ({
  turnId: 1,
  conversationId: "conv-1",
  source: "voice",
  assistantId: "jev",
  deviceId: "kitchen-01",
  ...over
})

const inTurn = (turn: TurnContext) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideService(effect, CurrentTurn, turn)

export type MakeStore = (options?: { readonly readOnly?: boolean }) => Effect.Effect<HouseholdStore, unknown, Scope.Scope>

const prepared = (make: MakeStore, modules: ReadonlyArray<{ readonly id: string; readonly storage: ModuleStorage }> = [KIT]) =>
  Effect.gen(function*() {
    const store = yield* make()
    yield* store.prepare(modules)
    return store
  })

const tagOf = (e: unknown) => (e as { _tag?: string } | undefined)?._tag
const texts = (rows: ReadonlyArray<Row<Note>>) => rows.map((r) => r.value.text).sort()
const settle = Effect.repeat(Effect.yieldNow, { times: 20 })

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: E } | undefined)?.error : undefined)

export const householdStoreContract = (name: string, make: MakeStore) =>
  describe(`HouseholdStore contract: ${name}`, () => {
    it.effect("insert, get and list in the household scope; rev and actor", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        const row = yield* c.insert({ text: "milk", tag: "shop" }).pipe(inTurn(turnOf({ person: { id: "sam", how: "device-default" } })))
        assert.isTrue(row.rev >= 1)
        assert.deepStrictEqual(row.scope, { kind: "household" })
        assert.strictEqual(row.updatedBy.kind, "turn")
        assert.strictEqual((row.updatedBy as Extract<Actor, { kind: "turn" }>).personId, "sam")
        const got = yield* c.get(row.id)
        assert.deepStrictEqual(got?.value, { text: "milk", tag: "shop" })
        assert.strictEqual(got?.rev, row.rev)
        assert.strictEqual((yield* c.list()).length, 1)
        // An id in use is a conflict; a bad id is invalid; a value that does not match the schema is invalid.
        const again = yield* Effect.exit(c.insert({ text: "x" }, { id: row.id }))
        assert.strictEqual(tagOf(failureOf(again)), "StoreConflict")
        const bad = yield* Effect.exit(c.insert({ text: 5 } as unknown as Note))
        assert.strictEqual((failureOf(bad) as StoreError).reason, "invalid")
        const undeclared = defineCollection({ name: "other", scope: "household", schema: Note })
        const refused = yield* Effect.exit(store.forModule("kit").collection(undeclared).list())
        assert.strictEqual((failureOf(refused) as StoreError).reason, "invalid")
      }).pipe(Effect.scoped))

    it.effect("scopes come from the turn; a person-scoped write with no person is ScopeUnknown, never a household write", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const noPerson = yield* Effect.exit(kit.collection(mine).insert({ text: "my reminder" }).pipe(inTurn(turnOf())))
        const err = failureOf(noPerson) as { _tag: string; scope: string }
        assert.strictEqual(err._tag, "ScopeUnknown")
        assert.strictEqual(err.scope, "person")
        assert.strictEqual((yield* kit.collection(notes).list()).length, 0)
        const sam = turnOf({ person: { id: "sam", how: "device-default" } })
        const row = yield* kit.collection(mine).insert({ text: "sam's" }).pipe(inTurn(sam))
        assert.deepStrictEqual(row.scope, { kind: "person", id: "sam" })
        // Another person's turn does not see it; an explicit scope does (jobs, admin).
        const ann = turnOf({ person: { id: "ann", how: "device-default" } })
        assert.strictEqual(yield* kit.collection(mine).get(row.id).pipe(inTurn(ann)), undefined)
        assert.strictEqual((yield* kit.collection(mine).list().pipe(inTurn(ann))).length, 0)
        assert.strictEqual((yield* kit.collection(mine).get(row.id, { scope: { kind: "person", id: "sam" } }))?.value.text, "sam's")
        // No turn at all (a job): explicit scope needed.
        const noTurn = yield* Effect.exit(kit.collection(dev).list())
        assert.strictEqual(tagOf(failureOf(noTurn)), "ScopeUnknown")
        // An explicit scope of the wrong kind is refused.
        const wrong = yield* Effect.exit(kit.collection(mine).list({ scope: { kind: "device", id: "kitchen-01" } }))
        assert.strictEqual((failureOf(wrong) as StoreError).reason, "invalid")
        // Device and conversation scopes from the turn; conversation rows go when the conversation ends.
        const d = yield* kit.collection(dev).insert({ text: "pinned list" }).pipe(inTurn(turnOf()))
        assert.deepStrictEqual(d.scope, { kind: "device", id: "kitchen-01" })
        assert.strictEqual(yield* kit.collection(dev).get(d.id).pipe(inTurn(turnOf({ deviceId: "study-001" }))), undefined)
        yield* kit.collection(chat).insert({ text: "scratch" }).pipe(inTurn(turnOf()))
        yield* kit.collection(chat).insert({ text: "other" }).pipe(inTurn(turnOf({ conversationId: "conv-2" })))
        assert.strictEqual(yield* store.endConversation("conv-1"), 1)
        assert.strictEqual((yield* kit.collection(chat).list().pipe(inTurn(turnOf()))).length, 0)
        assert.strictEqual((yield* kit.collection(chat).list().pipe(inTurn(turnOf({ conversationId: "conv-2" })))).length, 1)
      }).pipe(Effect.scoped))

    it.effect("list: one indexed filter, an order an index answers, a limit; other shapes are refused", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        for (const [i, tag] of ["a", "b", "a", "a", "b"].entries()) yield* c.insert({ text: `t${i}`, tag, n: 10 - i, done: i % 2 === 0 }, { id: `r${i}` })
        assert.strictEqual((yield* c.list({ where: { tag: "a" } })).length, 3)
        assert.strictEqual((yield* c.list({ where: { done: false } })).length, 2)
        assert.strictEqual((yield* c.list({ where: { done: 0 as unknown as boolean } })).length, 2)
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "n" }, limit: 2 })).map((r) => r.value.n), [6, 7])
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "n", direction: "desc" }, limit: 2 })).map((r) => r.value.n), [10, 9])
        assert.deepStrictEqual((yield* c.list({ where: { tag: "a" }, orderBy: { field: "tag" } })).map((r) => r.id), ["r0", "r2", "r3"])
        // Newest first by default (equal times: by id, the same direction).
        assert.deepStrictEqual((yield* c.list()).map((r) => r.id), ["r4", "r3", "r2", "r1", "r0"])
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "createdAt", direction: "asc" } })).map((r) => r.id), ["r0", "r1", "r2", "r3", "r4"])
        const unindexed = yield* Effect.exit(c.list({ where: { text: "t1" } as never }))
        assert.strictEqual((failureOf(unindexed) as StoreError).reason, "invalid")
        const two = yield* Effect.exit(c.list({ where: { tag: "a", done: true } }))
        assert.strictEqual((failureOf(two) as StoreError).reason, "invalid")
        const otherOrder = yield* Effect.exit(c.list({ where: { tag: "a" }, orderBy: { field: "n" } }))
        assert.strictEqual((failureOf(otherOrder) as StoreError).reason, "invalid")
        const createdFiltered = yield* Effect.exit(c.list({ where: { tag: "a" }, orderBy: { field: "createdAt" } }))
        assert.strictEqual((failureOf(createdFiltered) as StoreError).reason, "invalid")
        const found = yield* c.search("T3")
        assert.deepStrictEqual(found.map((r) => r.value.text), ["t3"])
      }).pipe(Effect.scoped))

    it.effect("indexed fields hold scalars only, ordered the same in both stores (null, numbers and booleans, strings by code point)", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(loose)
        for (const k of [["a"], { x: 1 }]) {
          const exit = yield* Effect.exit(c.insert({ k }))
          assert.strictEqual((failureOf(exit) as StoreError).reason, "invalid")
        }
        const values: ReadonlyArray<readonly [string, unknown]> = [
          ["v01", "😀"],
          ["v02", ""],
          ["v03", "é"],
          ["v04", "a"],
          ["v05", "B"],
          ["v06", 10],
          ["v07", 2],
          ["v08", true],
          ["v09", false],
          ["v10", null],
          ["v11", undefined],
          ["v12", 1]
        ]
        for (const [id, k] of values) yield* c.insert(k === undefined ? {} : { k }, { id })
        const asc = (yield* c.list({ orderBy: { field: "k" } })).map((r) => r.id)
        assert.deepStrictEqual(asc, ["v10", "v11", "v09", "v08", "v12", "v07", "v06", "v05", "v04", "v03", "v02", "v01"])
        const desc = (yield* c.list({ orderBy: { field: "k", direction: "desc" } })).map((r) => r.id)
        assert.deepStrictEqual(desc, [...asc].reverse())
        assert.deepStrictEqual((yield* c.list({ where: { k: null } })).map((r) => r.id).sort(), ["v10", "v11"])
        assert.deepStrictEqual((yield* c.list({ where: { k: true } })).map((r) => r.id).sort(), ["v08", "v12"])
        assert.deepStrictEqual((yield* c.list({ where: { k: "" } })).map((r) => r.id), ["v02"])
        assert.deepStrictEqual((yield* c.list({ where: { k: "[\"a\"]" } })).map((r) => r.id), [])
      }).pipe(Effect.scoped))

    it.effect("updates: read, apply and write as one step; rev is the change number, never used again (also after a removal)", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        const row = yield* c.insert({ text: "counter", n: 0 })
        const next = yield* c.update(row.id, (v) => ({ ...v, n: (v.n ?? 0) + 1 }))
        assert.isTrue(next.rev > row.rev)
        const stale = yield* Effect.exit(c.update(row.id, (v) => v, { expectRev: row.rev }))
        assert.strictEqual(tagOf(failureOf(stale)), "StoreConflict")
        const missing = yield* Effect.exit(c.update("nope", (v) => v))
        assert.strictEqual(tagOf(failureOf(missing)), "StoreNotFound")
        // Concurrent updates all land.
        yield* Effect.forEach(Array.from({ length: 8 }, () => 0), () => c.update(row.id, (v) => ({ ...v, n: (v.n ?? 0) + 1 })), { concurrency: "unbounded", discard: true })
        assert.strictEqual((yield* c.get(row.id))?.value.n, 9)
        // ABA: the same id removed and inserted again has a new rev, so a write expecting the old one is refused.
        const first = yield* c.insert({ text: "first" }, { id: "x" })
        assert.isTrue(yield* c.remove("x"))
        const second = yield* c.insert({ text: "second" }, { id: "x" })
        assert.notStrictEqual(second.rev, first.rev)
        const late = yield* Effect.exit(c.update("x", (v) => ({ ...v, text: "lost" }), { expectRev: first.rev }))
        assert.strictEqual(tagOf(failureOf(late)), "StoreConflict")
        const lateRemove = yield* Effect.exit(c.remove("x", { expectRev: first.rev }))
        assert.strictEqual(tagOf(failureOf(lateRemove)), "StoreConflict")
        assert.strictEqual((yield* c.get("x"))?.value.text, "second")
      }).pipe(Effect.scoped))

    it.effect("every write appends one change in the same transaction; a rollback leaves nothing; listeners hear commits only", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const heard: Array<string> = []
        store.onCommit((changes) => heard.push(...changes.map((ch) => `${ch.op}:${ch.seq}`)))
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        const row = yield* c.insert({ text: "a" })
        yield* c.update(row.id, (v) => ({ ...v, text: "b" }))
        yield* c.remove(row.id)
        assert.strictEqual(yield* c.remove(row.id), false)
        const page = yield* store.changesSince(0, 100)
        assert.deepStrictEqual(page.changes.map((ch) => ch.op), ["insert", "update", "remove"])
        assert.deepStrictEqual(page.changes.map((ch) => ch.seq), [1, 2, 3])
        assert.deepStrictEqual(page.changes.map((ch) => ch.rev), [1, 2, 3])
        assert.strictEqual(new Set(page.changes.map((ch) => ch.opId)).size, 3)
        assert.deepStrictEqual(page.changes[1]!.payload?.before, { text: "a" })
        assert.deepStrictEqual(page.changes[1]!.payload?.after, { text: "b" })
        assert.strictEqual(page.changes[0]!.module, "kit")
        assert.strictEqual(page.changes[0]!.collection, "notes")
        assert.deepStrictEqual(heard, ["insert:1", "update:2", "remove:3"])
        // A failing transaction: neither the rows nor the change log nor the listeners see anything of it.
        const failed = yield* Effect.exit(kit.transaction(Effect.gen(function*() {
          yield* c.insert({ text: "x" })
          yield* kit.collection(dev).insert({ text: "y" }, { scope: { kind: "device", id: "kitchen-01" } })
          return yield* Effect.fail("boom")
        })))
        assert.isTrue(Exit.isFailure(failed))
        assert.strictEqual((yield* c.list()).length, 0)
        assert.strictEqual(yield* store.lastSeq, 3)
        assert.strictEqual(heard.length, 3)
        // A committed transaction publishes after its commit, in order.
        yield* kit.transaction(Effect.gen(function*() {
          yield* c.insert({ text: "p" })
          assert.strictEqual(heard.length, 3)
          yield* c.insert({ text: "q" })
        }))
        assert.deepStrictEqual(heard.slice(3), ["insert:4", "insert:5"])
        // A savepoint that fails inside a transaction that commits: only its part is gone.
        yield* kit.transaction(Effect.gen(function*() {
          yield* c.insert({ text: "kept" })
          yield* Effect.exit(kit.transaction(Effect.andThen(c.insert({ text: "dropped" }), Effect.fail("inner"))))
        }))
        assert.deepStrictEqual(texts(yield* c.list({ limit: 10 })), ["kept", "p", "q"])
        assert.deepStrictEqual(heard.slice(5), ["insert:6"])
        // Numbers have no holes: the rolled-back changes left none.
        assert.deepStrictEqual((yield* store.changesSince(0, 100)).changes.map((ch) => ch.seq), [1, 2, 3, 4, 5, 6])
      }).pipe(Effect.scoped))

    it.effect("transactions: a savepoint that rolls back never takes a sibling's or the parent's write with it", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        const opened = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* kit.transaction(Effect.gen(function*() {
          const child = yield* Effect.forkChild(Effect.exit(kit.transaction(Effect.gen(function*() {
            yield* c.insert({ text: "child" })
            yield* Deferred.succeed(opened, undefined)
            yield* Deferred.await(release)
            return yield* Effect.fail("child fails")
          }))))
          yield* Deferred.await(opened)
          // While the child's savepoint is open, the parent's own write and a sibling savepoint wait for it.
          const parent = yield* Effect.forkChild(c.insert({ text: "parent" }))
          const sibling = yield* Effect.forkChild(kit.transaction(c.insert({ text: "sibling" })))
          yield* settle
          yield* Deferred.succeed(release, undefined)
          assert.isTrue(Exit.isFailure(yield* Fiber.join(child)))
          yield* Fiber.join(parent)
          yield* Fiber.join(sibling)
        }))
        assert.deepStrictEqual(texts(yield* c.list()), ["parent", "sibling"])
        // An interrupted savepoint: its write is gone, the parent's stays.
        const stuck = yield* Deferred.make<void>()
        yield* kit.transaction(Effect.gen(function*() {
          const child = yield* Effect.forkChild(kit.transaction(Effect.andThen(c.insert({ text: "interrupted" }), Effect.andThen(Deferred.succeed(stuck, undefined), Effect.never))))
          yield* Deferred.await(stuck)
          yield* Fiber.interrupt(child)
          yield* c.insert({ text: "after" })
        }))
        assert.deepStrictEqual(texts(yield* c.list()), ["after", "parent", "sibling"])
        // An interrupted outer transaction leaves nothing.
        const started = yield* Deferred.make<void>()
        const outer = yield* Effect.forkChild(kit.transaction(Effect.andThen(c.insert({ text: "never" }), Effect.andThen(Deferred.succeed(started, undefined), Effect.never))))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(outer)
        assert.deepStrictEqual(texts(yield* c.list()), ["after", "parent", "sibling"])
      }).pipe(Effect.scoped))

    it.effect("transactions: a fiber that outlives its transaction is refused, and nothing reaches the store", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        const go = yield* Deferred.make<void>()
        let escaped: Fiber.Fiber<Exit.Exit<Row<Note>, unknown>> | undefined
        yield* kit.transaction(Effect.gen(function*() {
          escaped = yield* Effect.forkChild(Effect.andThen(Deferred.await(go), Effect.exit(c.insert({ text: "late" }))))
          yield* c.insert({ text: "in time" })
        }))
        yield* Deferred.succeed(go, undefined)
        const exit = yield* Fiber.join(escaped!)
        assert.isTrue(Exit.isFailure(exit))
        assert.match((failureOf(exit) as StoreError).message, /already ended/)
        assert.deepStrictEqual(texts(yield* c.list()), ["in time"])
      }).pipe(Effect.scoped))

    it.effect("events: competing transactions are heard in change-log order; module events wait for the commit", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const seen: Array<string> = []
        const bus = makeEventBus({ observe: (e) => seen.push(e.seq !== undefined ? `${e.type}@${e.seq}` : e.type) })
        connectStoreToBus(store, bus)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        const events = bus.forModule("kit")
        const heard: Array<number> = []
        store.onCommit((changes) => heard.push(...changes.map((ch) => ch.seq)))
        yield* Effect.all([
          kit.transaction(Effect.forEach(Array.from({ length: 40 }, (_, i) => i), (i) => c.insert({ text: `a${i}` }), { discard: true })),
          kit.transaction(Effect.forEach(Array.from({ length: 40 }, (_, i) => i), (i) => c.insert({ text: `b${i}` }), { discard: true })),
          c.insert({ text: "single" })
        ], { concurrency: "unbounded" })
        assert.strictEqual(heard.length, 81)
        assert.deepStrictEqual(heard, [...heard].sort((x, y) => x - y))
        seen.length = 0
        // In a transaction: after the commit, in order with its changes.
        yield* kit.transaction(Effect.gen(function*() {
          yield* c.insert({ text: "stock" })
          yield* events.publish("stock.low", { item: "milk" })
          assert.strictEqual(seen.length, 0)
          yield* c.insert({ text: "more" })
        }))
        assert.deepStrictEqual(seen.map((s) => s.replace(/@\d+$/, "")), ["kit.notes.changed", "kit.stock.low", "kit.notes.changed"])
        // Rolled back: never published; a savepoint's events go with it.
        seen.length = 0
        yield* Effect.exit(kit.transaction(Effect.andThen(events.publish("outer.failed", {}), Effect.fail("no"))))
        yield* kit.transaction(Effect.gen(function*() {
          yield* Effect.exit(kit.transaction(Effect.andThen(events.publish("inner.dropped", {}), Effect.fail("no"))))
          yield* events.publish("outer.kept", {})
        }))
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Effect.forkChild(kit.transaction(Effect.andThen(events.publish("interrupted", {}), Effect.andThen(Deferred.succeed(started, undefined), Effect.never))))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(interrupted)
        assert.deepStrictEqual(seen, ["kit.outer.kept"])
        // Outside a transaction: at once. A subscriber may write in response (its own transaction, after the commit).
        const done = yield* Deferred.make<void>()
        yield* Effect.forkScoped(Stream.runForEach(bus.subscribe({ type: "kit.ping" }), () => Effect.andThen(c.insert({ text: "pong" }), Deferred.succeed(done, undefined))))
        yield* settle
        yield* kit.transaction(events.publish("ping", {}))
        yield* Deferred.await(done)
        assert.strictEqual((yield* c.search("pong")).length, 1)
      }).pipe(Effect.scoped))

    it.effect("undo: the last change of an actor in a collection and scope, insert, update and remove; not someone else's", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        const kitchen = turnOf()
        const study = turnOf({ deviceId: "study-001" })
        const row = yield* c.insert({ text: "rice 500" }).pipe(inTurn(kitchen))
        yield* c.update(row.id, (v) => ({ ...v, text: "rice 250" })).pipe(inTurn(kitchen))
        // Nothing of the study's to undo.
        assert.strictEqual(yield* c.undo().pipe(inTurn(study)), undefined)
        const u1 = yield* c.undo().pipe(inTurn(kitchen))
        assert.strictEqual(u1?.undid, "update")
        assert.strictEqual((yield* c.get(row.id))?.value.text, "rice 500")
        const u2 = yield* c.undo().pipe(inTurn(kitchen))
        assert.strictEqual(u2?.undid, "insert")
        assert.strictEqual(yield* c.get(row.id), undefined)
        assert.strictEqual(yield* c.undo().pipe(inTurn(kitchen)), undefined)
        // Undo a remove.
        const other = yield* c.insert({ text: "eggs" }).pipe(inTurn(kitchen))
        yield* c.remove(other.id).pipe(inTurn(kitchen))
        const u3 = yield* c.undo().pipe(inTurn(kitchen))
        assert.strictEqual(u3?.undid, "remove")
        assert.strictEqual((yield* c.get(other.id))?.value.text, "eggs")
        // Changed by someone else since: a conflict, nothing undone.
        const third = yield* c.insert({ text: "bread" }).pipe(inTurn(kitchen))
        yield* c.update(third.id, (v) => ({ ...v, text: "bread x2" })).pipe(inTurn(study))
        const conflict = yield* Effect.exit(c.undo().pipe(inTurn(kitchen)))
        assert.strictEqual(tagOf(failureOf(conflict)), "StoreConflict")
        assert.strictEqual((yield* c.get(third.id))?.value.text, "bread x2")
      }).pipe(Effect.scoped))

    it.effect("undo stays in its scope: one actor in two conversations; no person is ScopeUnknown, never someone's row", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const one = turnOf({ conversationId: "conv-1" })
        const two = turnOf({ conversationId: "conv-2" })
        yield* kit.collection(chat).insert({ text: "in one" }).pipe(inTurn(one))
        yield* kit.collection(chat).insert({ text: "in two" }).pipe(inTurn(two))
        const undone = yield* kit.collection(chat).undo().pipe(inTurn(one))
        assert.strictEqual(undone?.undid, "insert")
        assert.strictEqual((yield* kit.collection(chat).list().pipe(inTurn(one))).length, 0)
        assert.deepStrictEqual(texts(yield* kit.collection(chat).list().pipe(inTurn(two))), ["in two"])
        // The module itself wrote two people's rows; an undo without a person cannot choose one.
        yield* kit.collection(mine).insert({ text: "sam's" }, { scope: { kind: "person", id: "sam" } })
        yield* kit.collection(mine).insert({ text: "ann's" }, { scope: { kind: "person", id: "ann" } })
        const unknown = yield* Effect.exit(kit.collection(mine).undo())
        assert.strictEqual(tagOf(failureOf(unknown)), "ScopeUnknown")
        const forSam = yield* kit.collection(mine).undo({ scope: { kind: "person", id: "sam" } })
        assert.strictEqual(forSam?.undid, "insert")
        assert.strictEqual((yield* kit.collection(mine).list({ scope: { kind: "person", id: "ann" } })).length, 1)
      }).pipe(Effect.scoped))

    it.effect("history none: the log says that it changed, without content; no undo", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(forgettable)
        const row = yield* c.insert({ text: "the wifi is under the router" })
        yield* c.update(row.id, (v) => ({ ...v, text: "changed" }))
        const page = yield* store.changesSince(0, 10)
        assert.deepStrictEqual(page.changes.map((ch) => ch.op), ["insert", "update"])
        for (const ch of page.changes) assert.strictEqual(ch.payload, undefined)
        const undo = yield* Effect.exit(c.undo())
        assert.strictEqual((failureOf(undo) as StoreError).reason, "invalid")
      }).pipe(Effect.scoped))

    it.effect("erase removes the row, every earlier payload of it and its search entries; undo skips it", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        const keep = yield* c.insert({ text: "party hats" })
        const row = yield* c.insert({ text: "sam's surprise party on friday" })
        yield* c.update(row.id, (v) => ({ ...v, text: "sam's surprise party on saturday" }))
        assert.strictEqual((yield* c.search("surprise party")).length, 1)
        assert.isTrue(yield* c.erase(row.id))
        assert.strictEqual(yield* c.get(row.id), undefined)
        assert.strictEqual((yield* c.search("surprise")).length, 0)
        assert.deepStrictEqual((yield* c.search("party")).map((r) => r.id), [keep.id])
        const page = yield* store.changesSince(0, 10)
        const ofRow = page.changes.filter((ch) => ch.id === row.id)
        assert.deepStrictEqual(ofRow.map((ch) => ch.op), ["insert", "update", "erase"])
        for (const ch of ofRow) assert.strictEqual(ch.payload, undefined)
        assert.isTrue(JSON.stringify(page.changes).includes("party hats"))
        assert.isFalse(JSON.stringify(page.changes).includes("surprise"))
        // The erased row's purged history does not block undo of the earlier row; then nothing is left.
        assert.strictEqual((yield* c.undo())?.id, keep.id)
        assert.strictEqual(yield* c.undo(), undefined)
      }).pipe(Effect.scoped))

    it.effect("erase in another scope touches nothing of the row that belongs elsewhere", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(dev)
        const kitchen = turnOf()
        const study = turnOf({ deviceId: "study-001" })
        const row = yield* c.insert({ text: "kitchen secret" }).pipe(inTurn(kitchen))
        yield* c.update(row.id, (v) => ({ ...v, text: "kitchen secret, again" })).pipe(inTurn(kitchen))
        assert.isFalse(yield* c.erase(row.id).pipe(inTurn(study)))
        assert.strictEqual((yield* c.get(row.id).pipe(inTurn(kitchen)))?.value.text, "kitchen secret, again")
        assert.strictEqual((yield* c.search("secret").pipe(inTurn(kitchen))).length, 1)
        const ofRow = (yield* store.changesSince(0, 10)).changes.filter((ch) => ch.id === row.id)
        assert.isTrue(ofRow.every((ch) => ch.payload !== undefined))
        // Removed in its own scope earlier, the history there still goes with an erase there.
        assert.isTrue(yield* c.remove(row.id).pipe(inTurn(kitchen)))
        assert.isFalse(yield* c.erase(row.id).pipe(inTurn(kitchen)))
        assert.isFalse(JSON.stringify((yield* store.changesSince(0, 10)).changes).includes("kitchen secret"))
      }).pipe(Effect.scoped))

    it.effect("a conversation that ends takes its rows and their history; nothing of it can be undone; a sweep at start does the same", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(chat)
        const turn = turnOf()
        const removed = yield* c.insert({ text: "removed scratch" }).pipe(inTurn(turn))
        yield* c.remove(removed.id).pipe(inTurn(turn))
        yield* c.insert({ text: "live scratch" }).pipe(inTurn(turn))
        assert.strictEqual(yield* store.endConversation("conv-1"), 1)
        assert.strictEqual(yield* c.undo().pipe(inTurn(turn)), undefined)
        assert.strictEqual((yield* c.list().pipe(inTurn(turn))).length, 0)
        const log = (yield* store.changesSince(0, 20)).changes
        assert.isFalse(JSON.stringify(log).includes("scratch"))
        const erased = log.filter((ch) => ch.op === "erase")
        assert.strictEqual(erased.length, 1)
        assert.deepStrictEqual(erased[0]!.actor, { kind: "system", name: "conversation-ended" })
        // Rows of conversations a crash left behind.
        yield* c.insert({ text: "left behind" }).pipe(inTurn(turnOf({ conversationId: "conv-9" })))
        assert.strictEqual(yield* store.sweepConversations, 1)
        assert.strictEqual((yield* c.list().pipe(inTurn(turnOf({ conversationId: "conv-9" })))).length, 0)
      }).pipe(Effect.scoped))

    it.effect("search: every word begins a word of the row (no case, no accents), the most recently written first, the whole scope", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        const old = yield* c.insert({ text: "Old note about the boiler" })
        const butter = yield* c.insert({ text: "Buttermilk pancakes" })
        const milk = yield* c.insert({ text: "Milk and eggs" })
        const creme = yield* c.insert({ text: "Crème BRÛLÉE" })
        const shake = yield* c.insert({ text: "MILKSHAKE" })
        assert.deepStrictEqual((yield* c.search("milk")).map((r) => r.id), [shake.id, milk.id])
        assert.deepStrictEqual((yield* c.search("mil eg")).map((r) => r.id), [milk.id])
        assert.deepStrictEqual((yield* c.search("creme brulee")).map((r) => r.id), [creme.id])
        assert.deepStrictEqual((yield* c.search("BRÛ")).map((r) => r.id), [creme.id])
        assert.deepStrictEqual((yield* c.search("buttermilk")).map((r) => r.id), [butter.id])
        assert.deepStrictEqual((yield* c.search("termilk")).map((r) => r.id), [])
        // A write moves a row to the front.
        yield* c.update(milk.id, (v) => ({ ...v, text: "Milk, eggs and flour" }))
        assert.deepStrictEqual((yield* c.search("milk")).map((r) => r.id), [milk.id, shake.id])
        assert.deepStrictEqual((yield* c.search("milk", { limit: 1 })).map((r) => r.id), [milk.id])
        // Rows without search words do not crowd out an old match.
        yield* Effect.forEach(Array.from({ length: 2100 }, (_, i) => i), () => c.insert({ text: "" }), { discard: true })
        assert.deepStrictEqual((yield* c.search("boiler")).map((r) => r.id), [old.id])
        const badLimit = yield* Effect.exit(c.search("milk", { limit: 0 }))
        assert.strictEqual((failureOf(badLimit) as StoreError).reason, "invalid")
      }).pipe(Effect.scoped))

    it.effect("retention removes changes older than 90 days", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        yield* c.insert({ text: "old" })
        yield* c.insert({ text: "new" })
        const page = yield* store.changesSince(0, 10)
        const at = page.changes[0]!.at
        assert.strictEqual(yield* store.pruneChanges({ now: at + 89 * 86_400_000 }), 0)
        assert.strictEqual(yield* store.pruneChanges({ now: at + 91 * 86_400_000 }), 2)
        assert.strictEqual((yield* store.changesSince(0, 10)).changes.length, 0)
        // Numbers are never reused.
        yield* c.insert({ text: "after" })
        assert.strictEqual(yield* store.lastSeq, 3)
        assert.strictEqual((yield* store.changesSince(0, 10)).oldest, 3)
      }).pipe(Effect.scoped))

    it.effect("collection versions: rows are migrated at start (indexes and search follow); a newer version makes the module unavailable everywhere", () =>
      Effect.gen(function*() {
        const v1 = defineCollection({ name: "items", scope: "household", schema: Schema.Struct({ label: Schema.String }), indexes: ["label"], search: ["label"] })
        const v2 = defineCollection({
          name: "items",
          scope: "household",
          version: 2,
          schema: Schema.Struct({ text: Schema.String, qty: Schema.Finite }),
          indexes: ["text"],
          search: ["text"],
          migrate: { 1: (old: { label: string }) => ({ text: old.label.replace("Oat", "Rice"), qty: 1 }) },
          project: (row: Row<{ text: string; qty: number }>) => ({ text: row.value.text })
        })
        const store = yield* make()
        yield* store.prepare([{ id: "shop", storage: { collections: [v1] } }])
        const row = yield* store.forModule("shop").collection(v1).insert({ label: "Oat milk" })
        const before = store.forModule("shop").collection(v1)
        yield* store.prepare([{ id: "shop", storage: { collections: [v2] } }])
        assert.strictEqual(store.availability("shop"), undefined)
        const items = store.forModule("shop").collection(v2)
        assert.deepStrictEqual((yield* items.get(row.id))?.value, { text: "Rice milk", qty: 1 })
        assert.deepStrictEqual((yield* items.list({ where: { text: "Rice milk" } })).map((r) => r.id), [row.id])
        assert.deepStrictEqual((yield* items.search("rice")).map((r) => r.id), [row.id])
        assert.deepStrictEqual(yield* items.search("oat"), [])
        // The older module again: refused, with a reason; never opened and never written, also through a handle made before.
        yield* store.prepare([{ id: "shop", storage: { collections: [v1] } }])
        const verdict = store.availability("shop")
        assert.isDefined(verdict)
        assert.match(verdict!.reason, /newer version/)
        for (const attempt of [store.forModule("shop").collection(v1).insert({ label: "x" }), before.list(), store.forModule("shop").transaction(Effect.void)]) {
          const exit = yield* Effect.exit(attempt as Effect.Effect<unknown, unknown>)
          assert.strictEqual((failureOf(exit) as StoreError).reason, "unavailable")
        }
        // Pages never read it.
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "shop", collections: [v2], events: [] }] })
        assert.deepStrictEqual((yield* feed.snapshot({ id: "kitchen-01" })).parts.flat(), [])
      }).pipe(Effect.scoped))

    it.effect("a migration whose output breaks the size limit or the schema fails: nothing changes, the module is unavailable", () =>
      Effect.gen(function*() {
        const v1 = defineCollection({ name: "texts", scope: "household", schema: Schema.Struct({ body: Schema.String }) })
        const v2 = defineCollection({
          name: "texts",
          scope: "household",
          version: 2,
          schema: Schema.Struct({ body: Schema.String, copy: Schema.String }),
          migrate: { 1: (old: { body: string }) => ({ ...old, copy: old.body }) }
        })
        const store = yield* make()
        yield* store.prepare([{ id: "big", storage: { collections: [v1] } }])
        const row = yield* store.forModule("big").collection(v1).insert({ body: "x".repeat(Math.floor(MAX_VALUE_CHARS * 0.6)) })
        yield* store.prepare([{ id: "big", storage: { collections: [v2] } }])
        assert.match(store.availability("big")?.reason ?? "", /could not be upgraded/)
        // The previous version still reads the row as it was.
        yield* store.prepare([{ id: "big", storage: { collections: [v1] } }])
        assert.strictEqual(store.availability("big"), undefined)
        assert.strictEqual((yield* store.forModule("big").collection(v1).get(row.id))?.value.body.length, Math.floor(MAX_VALUE_CHARS * 0.6))
      }).pipe(Effect.scoped))

    it.effect("pages: only committed current rows through the projection; a cursor per page; hidden or erased rows never travel", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: KIT.storage.collections ?? [], events: [] }] })
        const kitchen = { id: "kitchen-01" }
        const study = { id: "study-001" }
        const kit = store.forModule("kit")
        const shownRows = kit.collection(shown)
        const k = (yield* feed.snapshot(kitchen)).cursor
        const st = (yield* feed.snapshot(study)).cursor
        const drain = (device: { id: string }, cursor: typeof k) =>
          Effect.gen(function*() {
            const out: Array<{ op: string; value?: unknown }> = []
            for (;;) {
              const r = yield* feed.catchUp(device, cursor)
              if (r.kind === "resync") return "resync" as const
              out.push(...r.events.map((e) => {
                const d = e.data as { op: string; value?: unknown }
                return d.op === "put" ? { op: d.op, value: d.value } : { op: d.op }
              }))
              if (!r.more) return out
            }
          })
        yield* kit.collection(notes).insert({ text: "never sent" })
        const forKitchen = yield* shownRows.insert({ text: "alarm: wake Sam", tag: "kitchen-01" })
        yield* shownRows.insert({ text: "for everyone" })
        assert.deepStrictEqual((yield* drain(kitchen, k)), [{ op: "put", value: { text: "alarm: wake Sam" } }, { op: "put", value: { text: "for everyone" } }])
        assert.deepStrictEqual((yield* drain(study, st)), [{ op: "put", value: { text: "for everyone" } }])
        // Moved to the study: the kitchen, which holds it, is told it is gone; the study gets today's value.
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "alarm: study", tag: "study-001" }))
        assert.deepStrictEqual((yield* drain(kitchen, k)), [{ op: "remove" }])
        assert.deepStrictEqual((yield* drain(study, st)), [{ op: "put", value: { text: "alarm: study" } }])
        // In one transaction: shown to the kitchen, then hidden from it, then erased. The kitchen hears nothing of it.
        yield* kit.transaction(Effect.gen(function*() {
          const secret = yield* shownRows.insert({ text: "secret for the kitchen", tag: "kitchen-01" })
          yield* shownRows.update(secret.id, (v) => ({ ...v, tag: "study-001" }))
          yield* shownRows.erase(secret.id)
        }))
        assert.deepStrictEqual((yield* drain(kitchen, k)), [])
        assert.deepStrictEqual((yield* drain(study, st)), [])
        // A page that fell behind gets only the value now, never the ones between.
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "v2" }))
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "v3" }))
        const late = yield* drain(study, st)
        assert.deepStrictEqual(late, [{ op: "put", value: { text: "v3" } }])
        // The snapshot is the rows now.
        const snapK = yield* feed.snapshot(kitchen)
        assert.deepStrictEqual(snapK.parts.flat().map((x) => x.collection), ["shown", "broken"])
        assert.deepStrictEqual(snapK.parts.flat()[0]!.rows.map((r) => r.value), [{ text: "for everyone" }])
        // A page behind a pruned log is told to take a fresh snapshot.
        yield* shownRows.insert({ text: "after the page left" })
        const last = (yield* store.changesSince(0, 1000)).changes.at(-1)!
        yield* store.pruneChanges({ now: last.at + 1, maxAgeMs: 0 })
        yield* shownRows.insert({ text: "after the prune" })
        assert.strictEqual(yield* drain(kitchen, k), "resync")
      }).pipe(Effect.scoped))

    it.effect("pages: a snapshot comes in parts that fit a frame, bounded in all; a failing projection hides only its own rows and is reported", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const problems: Array<FeedProblem> = []
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: KIT.storage.collections ?? [], events: [] }], report: (p) => problems.push(p) })
        const kit = store.forModule("kit")
        yield* kit.collection(broken).insert({ text: "fine" })
        yield* kit.collection(broken).insert({ text: "throws", tag: "bad" })
        yield* kit.collection(broken).insert({ text: "bigint", tag: "big" })
        const big = "y".repeat(Math.floor(MAX_VALUE_CHARS * 0.9))
        for (let i = 0; i < 70; i++) yield* kit.collection(shown).insert({ text: `${i} ${big}` })
        const snap = yield* feed.snapshot({ id: "kitchen-01" })
        for (const part of snap.parts) assert.isTrue(JSON.stringify(part).length < SNAPSHOT_PART_CHARS + MAX_VALUE_CHARS + 2000)
        const shownRows = snap.parts.flat().filter((x) => x.collection === "shown")
        const total = shownRows.reduce((n, x) => n + x.rows.length, 0)
        assert.isTrue(total > 10 && total < 70)
        assert.isTrue(shownRows.some((x) => x.truncated))
        assert.isTrue(snap.parts.length > 2)
        const brokenRows = snap.parts.flat().filter((x) => x.collection === "broken").flatMap((x) => x.rows.map((r) => r.value))
        assert.deepStrictEqual(brokenRows, [{ text: "fine" }])
        assert.deepStrictEqual(problems.map((p) => p.what), ["broken", "broken"])
      }).pipe(Effect.scoped))

    it.effect("module events reach pages only through a declared projection, which may fail on its own", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const problems: Array<FeedProblem> = []
        const ring = defineEventType({ type: "alarm.ringing", project: (e, device) => ((e.data as { device: string }).device === device.id ? { label: "Wake up" } : undefined) })
        const bad = defineEventType({ type: "alarm.bad", project: () => ({ n: 1n }) })
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: [], events: [ring, bad] }], report: (p) => problems.push(p) })
        const event: HouseholdEvent = { at: 1, module: "kit", type: "kit.alarm.ringing", scope: { kind: "household" as const }, data: { device: "kitchen-01" } }
        assert.deepStrictEqual(feed.live(event, { id: "kitchen-01" })?.data, { label: "Wake up" })
        assert.strictEqual(feed.live(event, { id: "study-001" }), undefined)
        assert.strictEqual(feed.live({ ...event, type: "kit.other" }, { id: "kitchen-01" }), undefined)
        assert.strictEqual(feed.live({ ...event, type: "kit.alarm.bad" }, { id: "kitchen-01" }), undefined)
        assert.strictEqual(problems.length, 1)
        // Person-scoped events are withheld from every page until Privacy.mayReveal exists.
        assert.strictEqual(feed.live({ ...event, scope: { kind: "person", id: "sam" } }, { id: "kitchen-01" }), undefined)
      }).pipe(Effect.scoped))

    it.effect("export: every collection, also one named like an object's own property", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        yield* store.forModule("kit").collection(constructorCollection).insert({ text: "built" })
        yield* store.forModule("kit").collection(notes).insert({ text: "note" })
        const out = yield* store.exportModule("kit")
        assert.isTrue(Object.hasOwn(out.collections, "constructor"))
        assert.strictEqual(out.collections["constructor"]!.length, 1)
        assert.strictEqual(out.collections["notes"]!.length, 1)
        assert.strictEqual(JSON.parse(JSON.stringify(out)).collections.constructor.length, 1)
      }).pipe(Effect.scoped))

    it.effect("a read-only store reads and refuses every write", () =>
      Effect.gen(function*() {
        const store = yield* make({ readOnly: true })
        yield* store.prepare([KIT])
        const c = store.forModule("kit").collection(notes)
        assert.deepStrictEqual(yield* c.list(), [])
        const exit = yield* Effect.exit(c.insert({ text: "x" }))
        assert.strictEqual((failureOf(exit) as StoreError).reason, "read-only")
      }).pipe(Effect.scoped))
  })

export type { Collection }
