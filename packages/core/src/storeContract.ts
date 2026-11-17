/**
 * The contract every `HouseholdStore` passes (`@pva/core/store-contract`): the in-memory double
 * (`makeMemoryHouseholdStore`) and the SQLite store run the same tests, so a module tested on the double behaves the
 * same on the real store. Test-only: imports vitest.
 */
import { assert, describe, it } from "@effect/vitest"
import { encodeServerMessage, type HouseholdSnapshotMessage } from "@pva/protocol"
import { Cause, Deferred, Effect, Exit, Schema, type Scope, Stream } from "effect"
import { connectStoreToBus, defineEventType, type HouseholdEvent, makeEventBus } from "./EventBus.ts"
import { ambientLines } from "./HouseholdAmbient.ts"
import { type FeedChange, type FeedProblem, feedRowKey, makeHouseholdFeed, SNAPSHOT_MAX_CHARS, SNAPSHOT_PART_CHARS, type SnapshotRun } from "./HouseholdFeed.ts"
import {
  type Actor,
  type Collection,
  type CommittedChange,
  defineCollection,
  type HouseholdStore,
  MAX_VALUE_CHARS,
  type ModuleStorage,
  type Row,
  StoreError,
  type StoreTx
} from "./HouseholdStore.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

export const Note = Schema.Struct({ text: Schema.String, tag: Schema.optionalKey(Schema.String), n: Schema.optionalKey(Schema.Finite), done: Schema.optionalKey(Schema.Boolean) })
export type Note = typeof Note.Type

export const notes = defineCollection({ name: "notes", scope: "household", schema: Note, indexes: ["tag", "n", "done"] })
export const mine = defineCollection({ name: "mine", scope: "person", schema: Note })
export const dev = defineCollection({ name: "dev", scope: "device", schema: Note })
export const chat = defineCollection({ name: "chat", scope: "conversation", schema: Note })
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
/** Device-scoped and shown to its own device. */
export const shownDev = defineCollection({ name: "shown_dev", scope: "device", schema: Note, project: (row: Row<Note>) => ({ text: row.value.text }) })
/** Shown only to a device whose record has the name "Kitchen". */
export const byName = defineCollection({ name: "by_name", scope: "household", schema: Note, project: (row: Row<Note>, device) => (device.name === "Kitchen" ? row.value : undefined) })
/** Ambient lines: the texts of the rows, one line per collection. */
export const factsA = defineCollection({ name: "facts_a", scope: "household", schema: Note, ambientRows: 5, ambient: (rows) => `A: ${rows.map((r) => r.value.text).join(" ")}` })
export const factsB = defineCollection({ name: "facts_b", scope: "device", schema: Note, ambient: (rows) => `B: ${rows.map((r) => r.value.text).join(" ")}` })
/** Whatever the schema allows (the store still wants an object). */
export const anything = defineCollection({ name: "anything", scope: "household", schema: Schema.Unknown })
/** A collection whose name is also a property of every object. */
export const constructorCollection = defineCollection({ name: "constructor", scope: "household", schema: Note })

export const KIT: { readonly id: string; readonly storage: ModuleStorage } = {
  id: "kit",
  storage: { collections: [notes, mine, dev, chat, shown, loose, broken, constructorCollection, anything, shownDev, byName] }
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
      }).pipe(Effect.scoped))

    it.effect("values are objects; indexed fields hold a well-formed string, a finite number or a boolean, ordered the same in both stores", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(loose)
        // Anything else in an indexed field is refused at write: lists, objects, null, NaN-like, malformed or long strings.
        for (const k of [["a"], { x: 1 }, null, "\ud800", "a\udc00", "a\u0000b", "x".repeat(501)]) {
          const exit = yield* Effect.exit(c.insert({ k }))
          assert.strictEqual((failureOf(exit) as StoreError).reason, "invalid", JSON.stringify(k))
        }
        // A value whose JSON form is not an object is refused, whatever the schema allows.
        for (const v of ["text", 5, null, [1, 2]]) {
          const exit = yield* Effect.exit(store.forModule("kit").collection(anything).insert(v))
          assert.strictEqual((failureOf(exit) as StoreError).reason, "invalid", JSON.stringify(v))
        }
        const values: ReadonlyArray<readonly [string, unknown]> = [
          ["v01", "😀"],
          ["v02", ""],
          ["v03", "é"],
          ["v04", "a"],
          ["v05", "B"],
          ["v06", 10],
          ["v07", 2],
          ["v08", true],
          ["v09", false],
          ["v11", undefined],
          ["v12", 1],
          ["v13", "\uffff"],
          ["v14", -0.5]
        ]
        for (const [id, k] of values) yield* c.insert(k === undefined ? {} : { k }, { id })
        const asc = (yield* c.list({ orderBy: { field: "k" } })).map((r) => r.id)
        // Missing first, then numbers (false = 0, true = 1; ties by time, then id), then strings by code point.
        assert.deepStrictEqual(asc, ["v11", "v14", "v09", "v08", "v12", "v07", "v06", "v02", "v05", "v04", "v03", "v13", "v01"])
        const desc = (yield* c.list({ orderBy: { field: "k", direction: "desc" } })).map((r) => r.id)
        assert.deepStrictEqual(desc, [...asc].reverse())
        assert.deepStrictEqual((yield* c.list({ where: { k: true } })).map((r) => r.id).sort(), ["v08", "v12"])
        assert.deepStrictEqual((yield* c.list({ where: { k: "" } })).map((r) => r.id), ["v02"])
        assert.deepStrictEqual((yield* c.list({ where: { k: "😀" } })).map((r) => r.id), ["v01"])
        for (const bad of [null, "\ud800", ["a"]]) {
          const exit = yield* Effect.exit(c.list({ where: { k: bad as never } }))
          assert.strictEqual((failureOf(exit) as StoreError).reason, "invalid")
        }
      }).pipe(Effect.scoped))

    it.effect("updates: read, apply and write as one step; rev comes from one counter, never used again (also after a removal)", () =>
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
        // Concurrent updates all land (each is one synchronous step).
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

    it.effect("a transaction is one step: all of it commits or none; a throw releases nothing and runs the rollback hooks; listeners hear commits only, in order", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const heard: Array<string> = []
        store.onCommit((released) => heard.push(...released.map((r) => (r._tag === "change" ? `${r.change.op}:${r.change.seq}` : r.event.type))))
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        const row = yield* c.insert({ text: "a" })
        yield* c.update(row.id, (v) => ({ ...v, text: "b" }))
        yield* c.remove(row.id)
        assert.strictEqual(yield* c.remove(row.id), false)
        assert.deepStrictEqual(heard, ["insert:1", "update:2", "remove:3"])
        // A transaction that throws part-way: no row, no number taken, nothing heard, its hooks run newest first.
        const undone: Array<string> = []
        const ran: Array<string> = []
        const failed = yield* Effect.exit(kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "x" })
          tx.publish("stock.low", {})
          tx.afterCommit(() => ran.push("after"))
          tx.onRollback(() => undone.push("first"))
          tx.collection(dev).insert({ text: "y" }, { scope: { kind: "device", id: "kitchen-01" } })
          tx.onRollback(() => undone.push("second"))
          throw new Error("boom")
        }))
        assert.isTrue(Exit.isFailure(failed) && Cause.hasDies(failed.cause))
        assert.deepStrictEqual(undone, ["second", "first"])
        assert.deepStrictEqual(ran, [])
        assert.strictEqual((yield* c.list()).length, 0)
        assert.strictEqual(yield* store.lastSeq, 3)
        assert.strictEqual(heard.length, 3)
        // A store failure left uncaught is the transaction's failure; caught, the transaction goes on and commits.
        const conflict = yield* Effect.exit(kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "p" }, { id: "p" })
          tx.collection(notes).insert({ text: "again" }, { id: "p" })
        }))
        assert.strictEqual(tagOf(failureOf(conflict)), "StoreConflict")
        assert.strictEqual((yield* c.list()).length, 0)
        const kept = yield* kit.transaction((tx) => {
          const n = tx.collection(notes)
          n.insert({ text: "p" }, { id: "p" })
          try {
            n.insert({ text: "again" }, { id: "p" })
          } catch (e) {
            assert.strictEqual(tagOf(e), "StoreConflict")
          }
          n.insert({ text: "q" }, { id: "q" })
          tx.publish("stock.low", { n: 1 })
          tx.afterCommit(() => ran.push("after"))
          return n.list().length
        })
        assert.strictEqual(kept, 2)
        // Released after the commit, in the order the transaction made them, as one batch.
        assert.deepStrictEqual(heard.slice(3), ["insert:4", "insert:5", "kit.stock.low"])
        assert.deepStrictEqual(ran, ["after"])
        assert.strictEqual(yield* store.lastSeq, 5)
        // A handle kept after its transaction ended is refused.
        let kept2: StoreTx | undefined
        yield* kit.transaction((tx) => {
          kept2 = tx
        })
        assert.throws(() => kept2!.collection(notes).insert({ text: "late" }))
        assert.throws(() => kept2!.publish("late", {}))
        assert.strictEqual((yield* c.list()).length, 2)
      }).pipe(Effect.scoped))

    it.effect("nothing runs between a transaction's begin and its commit; a transaction started inside one joins it; the host's spans modules", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        // Twenty transactions at once, five rows each: every transaction's numbers are consecutive (no interleaving).
        const revs = yield* Effect.all(
          Array.from({ length: 20 }, (_, t) =>
            kit.transaction((tx) => Array.from({ length: 5 }, (_, i) => tx.collection(notes).insert({ text: `${t}.${i}` }).rev))),
          { concurrency: "unbounded" }
        )
        for (const r of revs) for (let i = 1; i < r.length; i++) assert.strictEqual(r[i], r[0]! + i)
        // Joined: the inner transaction (and a plain write) is part of the outer one, and goes with its rollback.
        const exit = yield* Effect.exit(kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "outer" }, { id: "outer" })
          Effect.runSync(kit.transaction((inner) => inner.collection(notes).insert({ text: "inner" }, { id: "inner" })))
          Effect.runSync(c.insert({ text: "plain" }, { id: "plain" }))
          assert.strictEqual(tx.collection(notes).list({ limit: 1000 }).filter((r) => ["outer", "inner", "plain"].includes(r.id)).length, 3)
          throw new Error("no")
        }))
        assert.isTrue(Exit.isFailure(exit))
        for (const id of ["outer", "inner", "plain"]) assert.strictEqual(yield* c.get(id), undefined)
        // The host's transaction: two modules' rows commit together.
        yield* store.prepare([KIT, { id: "other", storage: { collections: [notes] } }])
        yield* store.transaction((tx) => {
          tx.forModule("kit").collection(notes).insert({ text: "k" }, { id: "k" })
          tx.forModule("other").collection(notes).insert({ text: "o" }, { id: "o" })
        })
        assert.isDefined(yield* c.get("k"))
        assert.isDefined(yield* store.forModule("other").collection(notes).get("o"))
        // In-memory state of a core service follows the transaction with onRollback (the scheduler's table).
        const table = new Map<string, number>()
        const write = (tx: { onRollback: (f: () => void) => void }, k: string, v: number) => {
          const before = table.get(k)
          table.set(k, v)
          tx.onRollback(() => (before === undefined ? table.delete(k) : table.set(k, before)))
        }
        yield* store.transaction((tx) => write(tx, "a", 1))
        yield* Effect.exit(store.transaction((tx) => {
          write(tx, "a", 2)
          write(tx, "b", 1)
          throw new Error("no")
        }))
        assert.deepStrictEqual([...table], [["a", 1]])
      }).pipe(Effect.scoped))

    it.effect("events: module events published inside a transaction wait for its commit, in order with its changes; dropped on rollback", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const seen: Array<string> = []
        const bus = makeEventBus({ observe: (e) => seen.push(e.type) })
        connectStoreToBus(store, bus)
        const kit = store.forModule("kit")
        const events = bus.forModule("kit")
        yield* kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "a" })
          tx.publish("stock.low", { n: 1 })
          // `ctx.events.publish` from inside the function (it can only be run synchronously there) waits too.
          Effect.runSync(events.publish("stock.empty", {}))
          tx.collection(notes).insert({ text: "b" })
          assert.deepStrictEqual(seen, [])
        })
        assert.deepStrictEqual(seen, ["kit.notes.changed", "kit.stock.low", "kit.stock.empty", "kit.notes.changed"])
        seen.length = 0
        yield* Effect.exit(kit.transaction((tx) => {
          tx.publish("outer.failed", {})
          throw new Error("no")
        }))
        yield* events.publish("outside", {})
        assert.deepStrictEqual(seen, ["kit.outside"])
        // An invalid type or scope inside a transaction is refused (the transaction fails); outside, it is not published.
        const bad = yield* Effect.exit(kit.transaction((tx) => tx.publish("Not A Type", {})))
        assert.strictEqual((failureOf(bad) as StoreError).reason, "invalid")
        const badScope = yield* Effect.exit(kit.transaction((tx) => tx.publish("ok", {}, { kind: "device", id: "a\u0000b" })))
        assert.strictEqual((failureOf(badScope) as StoreError).reason, "invalid")
        yield* events.publish("Bad Type", {})
        assert.deepStrictEqual(seen, ["kit.outside"])
        // A subscriber that writes back works (it runs after the commit, outside the transaction).
        const done = yield* Deferred.make<void>()
        yield* Effect.forkScoped(Stream.runForEach(bus.subscribe({ type: "kit.ping" }), () => Effect.andThen(kit.collection(notes).insert({ text: "pong" }), Deferred.succeed(done, undefined))))
        yield* settle
        yield* kit.transaction((tx) => tx.publish("ping", {}))
        yield* Deferred.await(done)
        assert.strictEqual((yield* kit.collection(notes).list()).filter((r) => r.value.text === "pong").length, 1)
      }).pipe(Effect.scoped))

    it.effect("remove really removes: the row is gone from get and list, its event carries what it removed, another scope's row of the id is untouched", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const removed: Array<CommittedChange> = []
        store.onCommit((released) => removed.push(...released.flatMap((r) => (r._tag === "change" && r.change.op === "remove" ? [r.change] : []))))
        const c = store.forModule("kit").collection(dev)
        const kitchen = turnOf()
        const study = turnOf({ deviceId: "study-001" })
        const k = yield* c.insert({ text: "kitchen secret" }, { id: "x" }).pipe(inTurn(kitchen))
        yield* c.insert({ text: "study note" }, { id: "y" }).pipe(inTurn(study))
        // In another scope: not found, nothing changes.
        assert.isFalse(yield* c.remove("x").pipe(inTurn(study)))
        assert.strictEqual((yield* c.get("x").pipe(inTurn(kitchen)))?.value.text, "kitchen secret")
        assert.isTrue(yield* c.remove("x", { expectRev: k.rev }).pipe(inTurn(kitchen)))
        assert.strictEqual(yield* c.get("x").pipe(inTurn(kitchen)), undefined)
        assert.deepStrictEqual((yield* c.list().pipe(inTurn(kitchen))).length, 0)
        assert.strictEqual(removed.length, 1)
        assert.deepStrictEqual(removed[0]!.scope, { kind: "device", id: "kitchen-01" })
        assert.strictEqual((removed[0]!.before?.value as Note).text, "kitchen secret")
        // The id is free again, in any scope; the new row has a new rev.
        const again = yield* c.insert({ text: "study's x" }, { id: "x" }).pipe(inTurn(study))
        assert.isTrue(again.rev > k.rev)
        assert.strictEqual(yield* c.get("x").pipe(inTurn(kitchen)), undefined)
      }).pipe(Effect.scoped))

    it.effect("ids and scopes come from a safe alphabet; the store keeps its own copies of what it is given and gives out copies", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const d = kit.collection(dev)
        for (const id of ["A\u0000B", "kitchen\ud800", "with space", "", "x".repeat(201), "ü"]) {
          const exit = yield* Effect.exit(d.insert({ text: "s" }, { scope: { kind: "device", id } }))
          assert.strictEqual((failureOf(exit) as StoreError).reason, "invalid", JSON.stringify(id))
          const read = yield* Effect.exit(d.get("x", { scope: { kind: "device", id } }))
          assert.strictEqual((failureOf(read) as StoreError).reason, "invalid")
        }
        for (const id of ["a\u0000", "a/b", "", "x".repeat(201)]) {
          const exit = yield* Effect.exit(kit.collection(notes).insert({ text: "s" }, { id }))
          assert.strictEqual((failureOf(exit) as StoreError).reason, "invalid", JSON.stringify(id))
        }
        // A turn whose device id is outside the alphabet: refused, not stored under a mangled id.
        const odd = yield* Effect.exit(d.insert({ text: "s" }).pipe(inTurn(turnOf({ deviceId: "a b" }))))
        assert.strictEqual((failureOf(odd) as StoreError).reason, "invalid")
        // What the caller keeps is not what the store keeps.
        const scope = { kind: "device" as const, id: "kitchen-01" }
        const value: { text: string; tag?: string } = { text: "mine" }
        const row = yield* d.insert(value, { scope, id: "copy" })
        ;(scope as { id: string }).id = "study-001"
        value.text = "changed outside"
        ;(row.value as { text: string }).text = "changed in the row"
        ;(row.scope as { id: string }).id = "study-001"
        const back = yield* d.get("copy", { scope: { kind: "device", id: "kitchen-01" } })
        assert.strictEqual(back?.value.text, "mine")
        assert.strictEqual(yield* d.get("copy", { scope: { kind: "device", id: "study-001" } }), undefined)
        // An update function that changes its argument in place does not change the row it replaces (the event's `before`).
        const befores: Array<unknown> = []
        store.onCommit((released) => befores.push(...released.flatMap((r) => (r._tag === "change" && r.change.before !== undefined ? [r.change.before.value] : []))))
        yield* d.update("copy", (v) => {
          ;(v as { text: string }).text = "after"
          return v
        }, { scope: { kind: "device", id: "kitchen-01" } })
        assert.deepStrictEqual(befores, [{ text: "mine" }])
        assert.strictEqual((yield* d.get("copy", { scope: { kind: "device", id: "kitchen-01" } }))?.value.text, "after")
      }).pipe(Effect.scoped))

    it.effect("a conversation that ends takes its rows; a sweep at start does the same", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(chat)
        const turn = turnOf()
        const removed = yield* c.insert({ text: "removed scratch" }).pipe(inTurn(turn))
        yield* c.remove(removed.id).pipe(inTurn(turn))
        yield* c.insert({ text: "live scratch" }).pipe(inTurn(turn))
        const heard: Array<CommittedChange> = []
        store.onCommit((released) => heard.push(...released.flatMap((r) => (r._tag === "change" ? [r.change] : []))))
        assert.strictEqual(yield* store.endConversation("conv-1"), 1)
        assert.strictEqual((yield* c.list().pipe(inTurn(turn))).length, 0)
        assert.deepStrictEqual(heard.map((ch) => [ch.op, ch.actor]), [["remove", { kind: "system", name: "conversation-ended" }]])
        // Rows of conversations a crash left behind.
        yield* c.insert({ text: "left behind" }).pipe(inTurn(turnOf({ conversationId: "conv-9" })))
        assert.strictEqual(yield* store.sweepConversations, 1)
        assert.strictEqual((yield* c.list().pipe(inTurn(turnOf({ conversationId: "conv-9" })))).length, 0)
      }).pipe(Effect.scoped))

    it.effect("the sweep of ended conversations leaves the rows of a module whose data is not usable here untouched", () =>
      Effect.gen(function*() {
        const v1 = defineCollection({ name: "scratch", scope: "conversation", schema: Note })
        const v2 = defineCollection({ name: "scratch", scope: "conversation", schema: Note, version: 2, migrate: { 1: (v: Note) => v } })
        const store = yield* make()
        yield* store.prepare([{ id: "later", storage: { collections: [v2] } }])
        yield* store.forModule("later").collection(v2).insert({ text: "kept for the newer module" }).pipe(inTurn(turnOf()))
        // An older build of the module: its data is newer than it knows, so nothing of it is touched.
        yield* store.prepare([{ id: "later", storage: { collections: [v1] } }])
        assert.isDefined(store.availability("later"))
        assert.strictEqual(yield* store.sweepConversations, 0)
        assert.strictEqual(yield* store.endConversation("conv-1"), 0)
        yield* store.prepare([{ id: "later", storage: { collections: [v2] } }])
        assert.deepStrictEqual(texts(yield* store.forModule("later").collection(v2).list().pipe(inTurn(turnOf()))), ["kept for the newer module"])
      }).pipe(Effect.scoped))

    it.effect("collection versions: rows are migrated at start in one transaction (indexes follow); a newer version makes the module unavailable everywhere", () =>
      Effect.gen(function*() {
        const v1 = defineCollection({ name: "items", scope: "household", schema: Schema.Struct({ label: Schema.String }), indexes: ["label"] })
        const v2 = defineCollection({
          name: "items",
          scope: "household",
          version: 2,
          schema: Schema.Struct({ text: Schema.String, qty: Schema.Finite }),
          indexes: ["text"],
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
        // The older module again: refused, with a reason; never opened and never written, also through a handle made before.
        yield* store.prepare([{ id: "shop", storage: { collections: [v1] } }])
        const verdict = store.availability("shop")
        assert.isDefined(verdict)
        assert.match(verdict!.reason, /newer version/)
        for (const attempt of [store.forModule("shop").collection(v1).insert({ label: "x" }), before.list(), store.forModule("shop").transaction(() => undefined)]) {
          const exit = yield* Effect.exit(attempt as Effect.Effect<unknown, unknown>)
          assert.strictEqual((failureOf(exit) as StoreError).reason, "unavailable")
        }
        assert.strictEqual(store.reader("shop", v1), undefined)
        // Pages never read it.
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "shop", collections: [v2], events: [] }] })
        assert.deepStrictEqual(allFrames(feed.snapshot({ id: "kitchen-01" })).flatMap((f) => f.collections), [])
        yield* store.prepare([{ id: "shop", storage: { collections: [v2] } }])
        assert.strictEqual(store.availability("shop"), undefined)
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
        yield* store.forModule("big").collection(v1).insert({ body: "small" }, { id: "a" })
        const row = yield* store.forModule("big").collection(v1).insert({ body: "x".repeat(Math.floor(MAX_VALUE_CHARS * 0.6)) }, { id: "b" })
        yield* store.prepare([{ id: "big", storage: { collections: [v2] } }])
        assert.match(store.availability("big")?.reason ?? "", /could not be upgraded/)
        // The previous version still reads both rows as they were: the first row's migration was rolled back too.
        yield* store.prepare([{ id: "big", storage: { collections: [v1] } }])
        assert.strictEqual(store.availability("big"), undefined)
        assert.strictEqual((yield* store.forModule("big").collection(v1).get(row.id))?.value.body.length, Math.floor(MAX_VALUE_CHARS * 0.6))
        assert.deepStrictEqual((yield* store.forModule("big").collection(v1).get("a"))?.value, { body: "small" })
      }).pipe(Effect.scoped))

    it.effect("module ids: the host's namespace and an id two modules share are refused for stored data", () =>
      Effect.gen(function*() {
        const store = yield* make()
        yield* store.prepare([
          { id: "host", storage: { collections: [notes] } },
          { id: "twice", storage: { collections: [notes] } },
          { id: "twice", storage: { collections: [notes] } },
          { id: "Bad_Id", storage: { collections: [notes] } }
        ])
        for (const id of ["host", "twice", "Bad_Id"]) {
          assert.isDefined(store.availability(id), id)
          const exit = yield* Effect.exit(store.forModule(id).collection(notes).insert({ text: "x" }))
          assert.strictEqual((failureOf(exit) as StoreError).reason, "unavailable")
        }
      }).pipe(Effect.scoped))

    it.effect("pages: what a page gets is decided when its frame is built, from the committed row and the device then", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: KIT.storage.collections ?? [], events: [] }] })
        const kitchen = { id: "kitchen-01" }
        const study = { id: "study-001" }
        const kit = store.forModule("kit")
        const shownRows = kit.collection(shown)
        const ks = feed.snapshot(kitchen)
        allFrames(ks)
        const ss = feed.snapshot(study)
        allFrames(ss)
        const k = ks.cursor
        const st = ss.cursor
        // What each page has pending, as `HouseholdPush` keeps it: the rows changes touched, coalesced.
        const pending = new Map<object, Map<string, FeedChange>>([[k, new Map()], [st, new Map()]])
        store.onCommit((released) => {
          for (const p of pending.values()) {
            for (const r of released) {
              if (r._tag !== "change") continue
              const key = feedRowKey(r.change.module, r.change.collection, r.change.id)
              p.delete(key)
              p.set(key, { module: r.change.module, collection: r.change.collection, id: r.change.id, scope: r.change.scope })
            }
          }
        })
        const drain = (device: { id: string }, cursor: typeof k) => {
          const mine = pending.get(cursor)!
          const out = [...mine.values()].flatMap((c) => {
            const e = feed.change(c, device, cursor)
            if (e === undefined) return []
            const d = e.data as { op: string; value?: unknown }
            return [d.op === "put" ? { op: d.op, value: d.value } : { op: d.op }]
          })
          mine.clear()
          return out
        }
        yield* kit.collection(notes).insert({ text: "never sent" })
        const forKitchen = yield* shownRows.insert({ text: "alarm: wake Sam", tag: "kitchen-01" })
        yield* shownRows.insert({ text: "for everyone" })
        assert.deepStrictEqual(drain(kitchen, k), [{ op: "put", value: { text: "alarm: wake Sam" } }, { op: "put", value: { text: "for everyone" } }])
        assert.deepStrictEqual(drain(study, st), [{ op: "put", value: { text: "for everyone" } }])
        // Moved to the study: the kitchen, which holds it, is told it is gone; the study gets today's value.
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "alarm: study", tag: "study-001" }))
        assert.deepStrictEqual(drain(kitchen, k), [{ op: "remove" }])
        assert.deepStrictEqual(drain(study, st), [{ op: "put", value: { text: "alarm: study" } }])
        // Shown to the kitchen, then hidden from it, then removed, before the kitchen's frame was built: nothing.
        const secret = yield* shownRows.insert({ text: "secret for the kitchen", tag: "kitchen-01" })
        yield* shownRows.update(secret.id, (v) => ({ ...v, tag: "study-001" }))
        yield* shownRows.remove(secret.id)
        assert.deepStrictEqual(drain(kitchen, k), [])
        assert.deepStrictEqual(drain(study, st), [])
        // A page that fell behind gets only the value now, never the ones between.
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "v2" }))
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "v3" }))
        assert.deepStrictEqual(drain(study, st), [{ op: "put", value: { text: "v3" } }])
        // The snapshot is the rows now.
        const snapK = allFrames(feed.snapshot(kitchen)).flatMap((f) => f.collections)
        assert.deepStrictEqual(snapK.map((x) => x.collection), ["shown"])
        assert.deepStrictEqual(snapK[0]!.rows.map((r) => r.value), [{ text: "for everyone" }])
        // The device record decides: a projection by name sees the name it is given now.
        const named = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: [byName], events: [] }] })
        yield* kit.collection(byName).insert({ text: "for Kitchen" })
        assert.strictEqual(allFrames(named.snapshot({ id: "kitchen-01", name: "Kitchen" })).flatMap((f) => f.collections).length, 1)
        assert.strictEqual(allFrames(named.snapshot({ id: "kitchen-01", name: "Guest" })).flatMap((f) => f.collections).length, 0)
      }).pipe(Effect.scoped))

    it.effect("pages: a removal names only what the page was given, never a row of another scope that took the id", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: [shownDev], events: [] }] })
        const c = store.forModule("kit").collection(shownDev)
        const a = { id: "kitchen-01" }
        yield* c.insert({ text: "A's" }, { id: "x", scope: { kind: "device", id: "kitchen-01" } })
        const run = feed.snapshot(a)
        const frames = allFrames(run)
        assert.strictEqual(frames.flatMap((f) => f.collections).flatMap((x) => x.rows).length, 1)
        const given = run.cursor.visible.get(feedRowKey("kit", "shown_dev", "x"))!
        // Removed in A's scope, then recreated in B's before A's page catches up.
        yield* c.remove("x", { scope: { kind: "device", id: "kitchen-01" } })
        yield* c.insert({ text: "B's secret" }, { id: "x", scope: { kind: "device", id: "study-001" } })
        const e = feed.change({ module: "kit", collection: "shown_dev", id: "x", scope: { kind: "device", id: "study-001" } }, a, run.cursor)
        assert.deepStrictEqual(e?.scope, { kind: "device", id: "kitchen-01" })
        assert.deepStrictEqual(e?.data, { collection: "shown_dev", id: "x", op: "remove", rev: given.rev })
        assert.isFalse(JSON.stringify(e).includes("study-001"))
        // A page that never held it gets nothing.
        assert.strictEqual(feed.change({ module: "kit", collection: "shown_dev", id: "x", scope: { kind: "device", id: "study-001" } }, a, run.cursor), undefined)
      }).pipe(Effect.scoped))

    it.effect("pages: every snapshot frame fits its limit with its envelopes, and the whole snapshot is bounded, also with many collections", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const problems: Array<FeedProblem> = []
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: KIT.storage.collections ?? [], events: [] }], report: (p) => problems.push(p) })
        const kit = store.forModule("kit")
        yield* kit.collection(broken).insert({ text: "fine" })
        yield* kit.collection(broken).insert({ text: "throws", tag: "bad" })
        yield* kit.collection(broken).insert({ text: "bigint", tag: "big" })
        // A failing projection hides only its own row and is reported.
        const brokenRows = allFrames(feed.snapshot({ id: "kitchen-01" })).flatMap((f) => f.collections).filter((x) => x.collection === "broken").flatMap((x) => x.rows.map((r) => r.value))
        assert.deepStrictEqual(brokenRows, [{ text: "fine" }])
        assert.deepStrictEqual(problems.map((p) => p.what), ["broken", "broken"])
        const big = "y".repeat(Math.floor(MAX_VALUE_CHARS * 0.9))
        for (let i = 0; i < 70; i++) yield* kit.collection(shown).insert({ text: `${i} ${big}` })
        const frames = allFrames(feed.snapshot({ id: "kitchen-01" }))
        for (const f of frames) assert.isAtMost(encodeServerMessage(f).length, SNAPSHOT_PART_CHARS)
        assert.isAtMost(frames.reduce((n, f) => n + encodeServerMessage(f).length, 0), SNAPSHOT_MAX_CHARS)
        assert.isTrue(frames.at(-1)!.final)
        assert.isTrue(frames.slice(0, -1).every((f) => !f.final))
        assert.deepStrictEqual(frames.map((f) => f.part), frames.map((_, i) => i))
        const shownRows = frames.flatMap((f) => f.collections).filter((x) => x.collection === "shown")
        const total = shownRows.reduce((n, x) => n + x.rows.length, 0)
        assert.isTrue(total > 5 && total < 70)
        assert.isTrue(shownRows.some((x) => x.truncated))
        // Collections after the budget ran out are named as cut short, as far as the budget allows.
        assert.isTrue(frames.flatMap((f) => f.collections).filter((x) => x.collection === "broken").every((x) => x.truncated))
        // Thousands of declared collections, most with nothing visible: every frame and the whole stay bounded, and
        // the reading stops at its budget.
        const many = Array.from({ length: 3000 }, (_, i) => defineCollection({ name: `c${i}`, scope: "household", schema: Note, project: (row: Row<Note>) => (row.value.tag === "show" ? { t: row.value.text } : undefined) }))
        yield* store.prepare([{ id: "wide", storage: { collections: many.slice(0, 64) } }])
        const wideFeed = makeHouseholdFeed({ store, modules: Array.from({ length: 47 }, (_, m) => ({ moduleId: m === 0 ? "wide" : `wide${m}`, collections: many.slice(m * 64, m * 64 + 64), events: [] })) })
        for (let i = 0; i < 64; i++) yield* store.forModule("wide").collection(many[i]!).insert({ text: `${i}`, tag: i % 2 === 0 ? "show" : "hide" })
        const wide = allFrames(wideFeed.snapshot({ id: "kitchen-01" }))
        for (const f of wide) assert.isAtMost(encodeServerMessage(f).length, SNAPSHOT_PART_CHARS)
        assert.strictEqual(wide.flatMap((f) => f.collections).flatMap((x) => x.rows).length, 32)
        // Many small visible rows in many collections: hundreds of frames, and still the whole is within the bound.
        yield* store.forModule("wide").transaction((tx) => {
          for (let i = 0; i < 64; i++) for (let r = 0; r < 70; r++) tx.collection(many[i]!).insert({ text: `${i}.${r} ${"w".repeat(300)}`, tag: "show" })
        })
        const full = allFrames(wideFeed.snapshot({ id: "kitchen-01" }))
        assert.isAbove(full.length, 50)
        for (const f of full) assert.isAtMost(encodeServerMessage(f).length, SNAPSHOT_PART_CHARS)
        assert.isAtMost(full.reduce((n, f) => n + encodeServerMessage(f).length, 0), SNAPSHOT_MAX_CHARS)
        assert.isTrue(full.flatMap((f) => f.collections).some((x) => x.truncated))
      }).pipe(Effect.scoped))

    it.effect("module events reach pages only through a declared projection, which may fail on its own; host events never", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const problems: Array<FeedProblem> = []
        const ring = defineEventType({ type: "alarm.ringing", project: (e, device) => ((e.data as { device: string }).device === device.id ? { label: "Wake up" } : undefined) })
        const bad = defineEventType({ type: "alarm.bad", project: () => ({ n: 1n }) })
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: [], events: [ring, bad] }], report: (p) => problems.push(p) })
        const event: HouseholdEvent = { at: 1, module: "kit", type: "kit.alarm.ringing", scope: { kind: "household" as const }, data: { device: "kitchen-01" } }
        assert.isTrue(feed.sendsEvent("kit.alarm.ringing"))
        assert.isFalse(feed.sendsEvent("kit.other"))
        assert.deepStrictEqual(feed.live(event, { id: "kitchen-01" })?.data, { label: "Wake up" })
        assert.strictEqual(feed.live(event, { id: "study-001" }), undefined)
        assert.strictEqual(feed.live({ ...event, type: "kit.other" }, { id: "kitchen-01" }), undefined)
        assert.strictEqual(feed.live({ ...event, type: "kit.alarm.bad" }, { id: "kitchen-01" }), undefined)
        assert.strictEqual(problems.length, 1)
        // Person-scoped events are withheld from every page until Privacy.mayReveal exists.
        assert.strictEqual(feed.live({ ...event, scope: { kind: "person", id: "sam" } }, { id: "kitchen-01" }), undefined)
        assert.strictEqual(feed.live({ ...event, module: "host", type: "host.turn.ended" }, { id: "kitchen-01" }), undefined)
      }).pipe(Effect.scoped))

    it.effect("ambient facts: bounded reads of the turn's scopes, whole lines up to 600 characters, nothing past the time budget", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make, [{ id: "facts", storage: { collections: [factsA, factsB] } }])
        for (let i = 0; i < 30; i++) yield* store.forModule("facts").collection(factsA).insert({ text: `a${i}` }, { id: `a${String(i).padStart(2, "0")}` })
        yield* store.forModule("facts").collection(factsB).insert({ text: "b" }).pipe(inTurn(turnOf()))
        const lines = (clock?: () => number, mode: "all" | "off" = "all") =>
          ambientLines({ store, modules: [{ moduleId: "facts", collections: [factsA, factsB] }], mode: () => mode, ...(clock !== undefined ? { clock } : {}) }).pipe(inTurn(turnOf()))
        const all = yield* lines()
        // At most `ambientRows` rows per scope, newest first; then the next collection.
        assert.strictEqual(all, "A: a29 a28 a27 a26 a25\nB: b")
        assert.strictEqual(yield* lines(undefined, "off"), "")
        // The budget is spent after the first collection: the second is not read.
        let t = 0
        assert.strictEqual(yield* lines(() => (t += 30)), "A: a29 a28 a27 a26 a25")
      }).pipe(Effect.scoped))

    it.effect("a read-only store reads and refuses every write", () =>
      Effect.gen(function*() {
        const store = yield* make({ readOnly: true })
        yield* store.prepare([KIT])
        const c = store.forModule("kit").collection(notes)
        assert.deepStrictEqual(yield* c.list(), [])
        const exit = yield* Effect.exit(c.insert({ text: "x" }))
        assert.strictEqual((failureOf(exit) as StoreError).reason, "read-only")
        const tx = yield* Effect.exit(store.forModule("kit").transaction((t) => t.collection(notes).insert({ text: "x" })))
        assert.strictEqual((failureOf(tx) as StoreError).reason, "read-only")
      }).pipe(Effect.scoped))
  })

/** Every frame of a snapshot, its steps run one after the other. */
export const allFrames = (run: SnapshotRun) => {
  const frames: Array<typeof HouseholdSnapshotMessage.Type> = []
  for (let i = 0; i < 100_000; i++) {
    const r = run.step()
    frames.push(...r.frames)
    if (r.done) return frames
  }
  throw new Error("the snapshot did not end")
}

export type { Collection }
