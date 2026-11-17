/**
 * The contract every `HouseholdStore` passes (`@pva/core/store-contract`): the in-memory double
 * (`makeMemoryHouseholdStore`) and the SQLite store run the same tests, so a module tested on the double behaves the
 * same on the real store. Each test names the rule of docs/STORING-DATA.md it checks. Test-only: imports vitest.
 */
import { assert, describe, it } from "@effect/vitest"
import { encodeServerMessage, type HouseholdChange, type HouseholdSnapshotMessage } from "@pva/protocol"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { connectStoreToBus, defineEventType, type HouseholdEvent, makeEventBus } from "./EventBus.ts"
import { ambientLines } from "./HouseholdAmbient.ts"
import { type FeedProblem, makeHouseholdFeed, MAX_FEED_COLLECTIONS, SNAPSHOT_MAX_CHARS, SNAPSHOT_PART_CHARS, SNAPSHOT_READ_ROWS, type SnapshotRun } from "./HouseholdFeed.ts"
import { makeHouseholdPage, type PageMessage } from "./HouseholdPage.ts"
import {
  type Actor,
  BULK_STEP_ROWS,
  type Collection,
  type CommittedChange,
  compareIndexed,
  DEFAULT_MAX_CHARS,
  defineCollection,
  type HouseholdStore,
  indexKeyOf,
  LIST_BUDGET_CHARS,
  type ListQuery,
  MAX_LIST_LIMIT,
  MAX_VALUE_CHARS,
  maxListRows,
  RESERVED_FIELDS,
  type ModuleStorage,
  type Row,
  StoreError,
  type StoreTx,
  type TxCollection
} from "./HouseholdStore.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

export const Note = Schema.Struct({ text: Schema.String, tag: Schema.optionalKey(Schema.String), n: Schema.optionalKey(Schema.Finite), done: Schema.optionalKey(Schema.Boolean) })
export type Note = typeof Note.Type

export const notes = defineCollection({ name: "notes", scope: "household", schema: Note, indexes: ["tag", "n", "done", ["tag", "n"]] })
export const mine = defineCollection({ name: "mine", scope: "person", schema: Note })
export const dev = defineCollection({ name: "dev", scope: "device", schema: Note })
export const chat = defineCollection({ name: "chat", scope: "conversation", schema: Note })
/** Shown on every page whose device is the row's `tag`; hidden elsewhere. */
export const shown = defineCollection({
  name: "shown",
  scope: "household",
  schema: Note,
  maxChars: MAX_VALUE_CHARS,
  project: (row: Row<Note>, device) => (row.value.tag === undefined || row.value.tag === device.id ? { text: row.value.text } : undefined)
})

/** Any JSON in its indexed field `k` (to check what an index accepts and how both stores order it). */
export const loose = defineCollection({
  name: "loose",
  scope: "household",
  schema: Schema.Struct({ k: Schema.optionalKey(Schema.Unknown), o: Schema.optionalKey(Schema.Unknown) }),
  indexes: ["k", ["k", "o"]]
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
export const anything = defineCollection({ name: "anything", scope: "household", schema: Schema.Unknown, maxChars: MAX_VALUE_CHARS })
/** A collection whose name is also a property of every object. */
export const constructorCollection = defineCollection({ name: "constructor", scope: "household", schema: Note })

export const KIT: { readonly id: string; readonly storage: ModuleStorage } = {
  id: "kit",
  storage: { collections: [notes, mine, dev, chat, shown, loose, broken, constructorCollection, anything, shownDev, byName] }
}

/** The scheduler's shape, as a core service declares it: jobs by due time is one index range (`["state", "dueAt"]`). */
export const Job = Schema.Struct({ module: Schema.String, state: Schema.Literals(["scheduled", "done"]), dueAt: Schema.Finite })
export const jobs = defineCollection({ name: "jobs", scope: "household", schema: Job, indexes: ["module", ["state", "dueAt"]] })
export const SCHEDULER = { owner: "core.scheduler", storage: { collections: [jobs] } } as const

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
    yield* store.prepare(modules, [SCHEDULER])
    return store
  })

const tagOf = (e: unknown) => (e as { _tag?: string } | undefined)?._tag
const texts = (rows: ReadonlyArray<Row<Note>>) => rows.map((r) => r.value.text).sort()
const settle = Effect.repeat(Effect.yieldNow, { times: 20 })

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: E } | undefined)?.error : undefined)
const reasonOf = <A, E>(exit: Exit.Exit<A, E>) => (failureOf(exit) as StoreError | undefined)?.reason

/** Every row of a collection in one scope, paged (no single page may take more than `maxListRows(c)`). */
export const allRows = <A>(store: HouseholdStore, owner: string, c: Collection<A>, scope?: { readonly kind: "device"; readonly id: string }) =>
  Effect.sync(() => {
    const reader = store.reader(owner, c)
    if (reader === undefined) return [] as ReadonlyArray<Row<A>>
    const out: Array<Row<A>> = []
    let after: { updatedAt: number; createdAt: number; id: string } | undefined
    for (;;) {
      const page = reader.page(scope ?? { kind: "household" }, after, maxListRows(c))
      out.push(...page)
      if (page.length < maxListRows(c)) return out
      const last = page.at(-1)!
      after = { updatedAt: last.updatedAt, createdAt: last.createdAt, id: last.id }
    }
  })

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
        assert.strictEqual(reasonOf(bad), "invalid")
        const undeclared = defineCollection({ name: "other", scope: "household", schema: Note })
        const refused = yield* Effect.exit(store.forModule("kit").collection(undeclared).list())
        assert.strictEqual(reasonOf(refused), "invalid")
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
        const ann = turnOf({ person: { id: "ann", how: "device-default" } })
        assert.strictEqual(yield* kit.collection(mine).get(row.id).pipe(inTurn(ann)), undefined)
        assert.strictEqual((yield* kit.collection(mine).list().pipe(inTurn(ann))).length, 0)
        assert.strictEqual((yield* kit.collection(mine).get(row.id, { scope: { kind: "person", id: "sam" } }))?.value.text, "sam's")
        const noTurn = yield* Effect.exit(kit.collection(dev).list())
        assert.strictEqual(tagOf(failureOf(noTurn)), "ScopeUnknown")
        const wrong = yield* Effect.exit(kit.collection(mine).list({ scope: { kind: "device", id: "kitchen-01" } }))
        assert.strictEqual(reasonOf(wrong), "invalid")
        const d = yield* kit.collection(dev).insert({ text: "pinned list" }).pipe(inTurn(turnOf()))
        assert.deepStrictEqual(d.scope, { kind: "device", id: "kitchen-01" })
        assert.strictEqual(yield* kit.collection(dev).get(d.id).pipe(inTurn(turnOf({ deviceId: "study-001" }))), undefined)
        yield* kit.collection(chat).insert({ text: "scratch" }).pipe(inTurn(turnOf()))
        yield* kit.collection(chat).insert({ text: "other" }).pipe(inTurn(turnOf({ conversationId: "conv-2" })))
        assert.strictEqual(yield* store.endConversation("conv-1"), 1)
        assert.strictEqual((yield* kit.collection(chat).list().pipe(inTurn(turnOf()))).length, 0)
        assert.strictEqual((yield* kit.collection(chat).list().pipe(inTurn(turnOf({ conversationId: "conv-2" })))).length, 1)
      }).pipe(Effect.scoped))

    it.effect("list: one indexed filter, an order an index answers, a limit of at most maxListRows; ties by createdAt then id; other shapes are refused", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        for (const [i, tag] of ["a", "b", "a", "a", "b"].entries()) yield* c.insert({ text: `t${i}`, tag, n: 10 - i, done: i % 2 === 0 }, { id: `r${i}` })
        assert.strictEqual((yield* c.list({ where: { tag: "a" } })).length, 3)
        assert.strictEqual((yield* c.list({ where: { done: false } })).length, 2)
        assert.strictEqual((yield* c.list({ where: { done: 0 as unknown as boolean } })).length, 2)
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "n" }, limit: 2 })).map((r) => r.value.n), [6, 7])
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "n", direction: "desc" }, limit: 2 })).map((r) => r.value.n), [10, 9])
        // Filtered and ordered by the same field: by createdAt (all equal here), then id.
        assert.deepStrictEqual((yield* c.list({ where: { tag: "a" }, orderBy: { field: "tag" } })).map((r) => r.id), ["r0", "r2", "r3"])
        // Filtered on one field, ordered by another: only through the declared pair ["tag", "n"]; one index range.
        assert.deepStrictEqual((yield* c.list({ where: { tag: "a" }, orderBy: { field: "n" } })).map((r) => r.value.n), [7, 8, 10])
        assert.deepStrictEqual((yield* c.list({ where: { tag: "a" }, orderBy: { field: "n", direction: "desc" }, limit: 2 })).map((r) => r.value.n), [10, 8])
        // Newest first by default (equal times: createdAt, then id, the same direction).
        assert.deepStrictEqual((yield* c.list()).map((r) => r.id), ["r4", "r3", "r2", "r1", "r0"])
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "createdAt", direction: "asc" } })).map((r) => r.id), ["r0", "r1", "r2", "r3", "r4"])
        for (const query of [
          { where: { text: "t1" } as never },
          { where: { tag: "a", done: true } },
          { where: { done: true }, orderBy: { field: "n" as const } },
          { where: { n: 7 }, orderBy: { field: "tag" as const } },
          { orderBy: { field: "text" as never } },
          { limit: maxListRows(notes) + 1 },
          { limit: 0 },
          { limit: 1.5 }
        ]) {
          const exit = yield* Effect.exit(c.list(query))
          assert.strictEqual(reasonOf(exit), "invalid", JSON.stringify(query))
        }
        assert.strictEqual((yield* c.list({ limit: maxListRows(notes) })).length, 5)
      }).pipe(Effect.scoped))

    it.effect("ties are broken by createdAt, then id, in every order (equal update times, unequal creation times)", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        // Created at different times, all updated at one moment (the clock does not move during a transaction).
        yield* c.insert({ text: "z", tag: "t", n: 1 }, { id: "z" })
        yield* TestClock.adjust(5)
        yield* c.insert({ text: "a", tag: "t", n: 1 }, { id: "a" })
        yield* TestClock.adjust(5)
        yield* store.forModule("kit").transaction((tx) => {
          for (const id of ["a", "z"]) tx.collection(notes).update(id, (v) => ({ ...v, text: `${v.text}!` }))
        })
        // updatedAt equal: z (created first) before a ascending, after it descending; id would say the opposite.
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "updatedAt", direction: "asc" } })).map((r) => r.id), ["z", "a"])
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "updatedAt", direction: "desc" } })).map((r) => r.id), ["a", "z"])
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "n" } })).map((r) => r.id), ["z", "a"])
        assert.deepStrictEqual((yield* c.list({ where: { tag: "t" }, orderBy: { field: "n" } })).map((r) => r.id), ["z", "a"])
        assert.deepStrictEqual((yield* c.list({ where: { tag: "t" } })).map((r) => r.id), ["a", "z"])
        assert.deepStrictEqual((yield* c.list({ where: { tag: "t" }, orderBy: { field: "createdAt", direction: "asc" } })).map((r) => r.id), ["z", "a"])
      }).pipe(Effect.scoped))

    it.effect("values are objects of at most MAX_VALUE_CHARS; indexed fields hold exactly the values that survive SQLite unchanged, ordered the same in both stores", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(loose)
        for (const k of [["a"], { x: 1 }, null, "\ud800", "a\udc00", "a\u0000b", "x".repeat(501)]) {
          const exit = yield* Effect.exit(c.insert({ k }))
          assert.strictEqual(reasonOf(exit), "invalid", JSON.stringify(k))
        }
        for (const v of ["text", 5, null, [1, 2]]) {
          const exit = yield* Effect.exit(store.forModule("kit").collection(anything).insert(v))
          assert.strictEqual(reasonOf(exit), "invalid", JSON.stringify(v))
        }
        const tooBig = yield* Effect.exit(store.forModule("kit").collection(anything).insert({ s: "x".repeat(MAX_VALUE_CHARS) }))
        assert.strictEqual(reasonOf(tooBig), "invalid")
        assert.isDefined(yield* store.forModule("kit").collection(anything).insert({ s: "x".repeat(MAX_VALUE_CHARS - 10) }))
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
          ["v13", "￿"],
          ["v14", -0.5]
        ]
        for (const [id, k] of values) yield* c.insert(k === undefined ? {} : { k }, { id })
        const asc = (yield* c.list({ orderBy: { field: "k" } })).map((r) => r.id)
        assert.deepStrictEqual(asc, ["v11", "v14", "v09", "v08", "v12", "v07", "v06", "v02", "v05", "v04", "v03", "v13", "v01"])
        const desc = (yield* c.list({ orderBy: { field: "k", direction: "desc" } })).map((r) => r.id)
        assert.deepStrictEqual(desc, [...asc].reverse())
        assert.deepStrictEqual((yield* c.list({ where: { k: true } })).map((r) => r.id).sort(), ["v08", "v12"])
        assert.deepStrictEqual((yield* c.list({ where: { k: "" } })).map((r) => r.id), ["v02"])
        assert.deepStrictEqual((yield* c.list({ where: { k: "😀" } })).map((r) => r.id), ["v01"])
        for (const bad of [null, "\ud800", ["a"], Number.NaN, Number.POSITIVE_INFINITY]) {
          const exit = yield* Effect.exit(c.list({ where: { k: bad as never } }))
          assert.strictEqual(reasonOf(exit), "invalid")
        }
        // Numbers SQLite's own JSON parser would change (58.00995086 → 58.009950860000004) or that are not exact
        // integers: each is found by itself, and only by itself; -0 is stored as 0.
        const exact = [58.00995086, 5.82e-11, 3.202449336086709e+291, 1000000000000000100, 1000000000000000300, 1e21, 2 ** 53, 2 ** 53 + 2, -1e-7, 123456789.125, Number.MAX_VALUE, Number.MIN_VALUE]
        for (const [i, k] of exact.entries()) yield* c.insert({ k, o: i }, { id: `e${i}` })
        for (const [i, k] of exact.entries()) assert.deepStrictEqual((yield* c.list({ where: { k } })).map((r) => r.id), [`e${i}`], String(k))
        yield* c.insert({ k: -0 }, { id: "zero" })
        // (`false` is 0 too.)
        assert.deepStrictEqual((yield* c.list({ where: { k: 0 } })).map((r) => r.id).sort(), ["v09", "zero"])
        assert.deepStrictEqual((yield* c.list({ where: { k: -0 } })).map((r) => r.id).sort(), ["v09", "zero"])
        assert.isTrue(Object.is((yield* c.get("zero"))!.value.k, 0))
        // Order of the exact numbers agrees with JavaScript's.
        const ordered = (yield* c.list({ orderBy: { field: "k" }, limit: maxListRows(loose) })).filter((r) => r.id.startsWith("e")).map((r) => r.value.k as number)
        assert.deepStrictEqual(ordered, [...exact].sort((a, b) => a - b))
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
        yield* Effect.forEach(Array.from({ length: 8 }, () => 0), () => c.update(row.id, (v) => ({ ...v, n: (v.n ?? 0) + 1 })), { concurrency: "unbounded", discard: true })
        assert.strictEqual((yield* c.get(row.id))?.value.n, 9)
        // An update function that returns a promise is refused; nothing changes.
        const asyncUpdate = yield* Effect.exit(c.update(row.id, (async (v: Note) => v) as unknown as (v: Note) => Note))
        assert.strictEqual(reasonOf(asyncUpdate), "invalid")
        assert.strictEqual((yield* c.get(row.id))?.value.n, 9)
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
        assert.deepStrictEqual(heard.slice(3), ["insert:4", "insert:5", "kit.stock.low"])
        assert.deepStrictEqual(ran, ["after"])
        assert.strictEqual(yield* store.lastSeq, 5)
        // A throwing hook stops neither the other hooks nor the commit's release.
        const order: Array<string> = []
        yield* kit.transaction((tx) => {
          tx.afterCommit(() => {
            order.push("one")
            throw new Error("hook bug")
          })
          tx.afterCommit(() => order.push("two"))
        })
        assert.deepStrictEqual(order, ["one", "two"])
      }).pipe(Effect.scoped))

    it.effect("a transaction function is synchronous or the transaction fails: a promise, an Effect, a generator or a function rolls everything back with a typed error", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        const heard: Array<unknown> = []
        store.onCommit((r) => heard.push(...r))
        const undone: Array<string> = []
        const returns: ReadonlyArray<readonly [string, (tx: StoreTx) => unknown]> = [
          ["async", async (tx) => {
            tx.collection(notes).insert({ text: "before the await" }, { id: "a1" })
            await Promise.resolve()
            tx.collection(notes).insert({ text: "after the await" }, { id: "a2" })
          }],
          ["thenable", (tx) => {
            tx.collection(notes).insert({ text: "t" }, { id: "t1" })
            return { then: () => undefined }
          }],
          ["effect", (tx) => {
            tx.collection(notes).insert({ text: "e" }, { id: "e1" })
            return Effect.sync(() => tx.collection(notes).insert({ text: "never" }))
          }],
          ["generator", function*(tx: StoreTx) {
            tx.collection(notes).insert({ text: "g" }, { id: "g1" })
            yield 1
          }],
          ["function", (tx) => {
            tx.onRollback(() => undone.push("function"))
            return () => undefined
          }]
        ]
        for (const [what, f] of returns) {
          const exit = yield* Effect.exit(kit.transaction(f as (tx: StoreTx) => never))
          const error = failureOf(exit) as StoreError | undefined
          assert.strictEqual(error?.reason, "invalid", what)
          assert.match(error?.message ?? "", /cannot await/, what)
        }
        // Let the async function's continuation run: it finds its handle dead.
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 5)))
        assert.deepStrictEqual(yield* c.list(), [])
        assert.deepStrictEqual(heard, [])
        assert.deepStrictEqual(undone, ["function"])
        // Joined: a nested transaction whose function returns a promise dooms the outer one, also when it is caught.
        const joined = yield* Effect.exit(kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "outer" }, { id: "outer" })
          try {
            Effect.runSync(kit.transaction((async () => undefined) as never))
          } catch {
            // The module catches it and carries on: the transaction still cannot commit.
          }
          return 1
        }))
        assert.strictEqual(reasonOf(joined), "invalid")
        assert.strictEqual(yield* c.get("outer"), undefined)
        // The host's transaction follows the same rule.
        const host = yield* Effect.exit(store.transaction((async (tx: { forModule: (id: string) => StoreTx }) => {
          tx.forModule("kit").collection(notes).insert({ text: "host" }, { id: "host" })
        }) as never))
        assert.strictEqual(reasonOf(host), "invalid")
        assert.strictEqual(yield* c.get("host"), undefined)
      }).pipe(Effect.scoped))

    it.effect("a handle is valid only while its function runs: kept, it is refused afterwards, in a later transaction too, and from a hook", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        let kept: StoreTx | undefined
        let keptCollection: TxCollection<Note> | undefined
        let keptHost: { forModule: (id: string) => StoreTx } | undefined
        yield* kit.transaction((tx) => {
          kept = tx
          keptCollection = tx.collection(notes)
        })
        yield* store.transaction((tx) => {
          keptHost = tx
        })
        const uses: ReadonlyArray<readonly [string, () => unknown]> = [
          ["insert", () => kept!.collection(notes).insert({ text: "late" })],
          ["collection insert", () => keptCollection!.insert({ text: "late" })],
          ["collection list", () => keptCollection!.list()],
          ["collection get", () => keptCollection!.get("x")],
          ["publish", () => kept!.publish("late", {})],
          ["afterCommit", () => kept!.afterCommit(() => undefined)],
          ["onRollback", () => kept!.onRollback(() => undefined)],
          ["host forModule", () => keptHost!.forModule("kit")]
        ]
        // Outside any transaction, and inside a later one (which the kept handle must not join).
        for (const [what, use] of uses) {
          assert.strictEqual(tagOf(captureThrow(use)), "StoreError", what)
          assert.strictEqual((captureThrow(use) as StoreError).reason, "invalid", what)
          const inner = yield* Effect.exit(kit.transaction(() => {
            const e = captureThrow(use)
            assert.strictEqual((e as StoreError | undefined)?.reason, "invalid", `${what} in a later transaction`)
            return 1
          }))
          assert.isTrue(Exit.isSuccess(inner), what)
        }
        // From a hook: an after-commit callback or a rollback hook cannot use the transaction that ended.
        const fromHooks: Array<unknown> = []
        yield* kit.transaction((tx) => {
          const n = tx.collection(notes)
          tx.afterCommit(() => fromHooks.push(captureThrow(() => n.insert({ text: "from a hook" }))))
        })
        yield* Effect.exit(kit.transaction((tx) => {
          const n = tx.collection(notes)
          tx.onRollback(() => fromHooks.push(captureThrow(() => n.insert({ text: "from a rollback hook" }))))
          throw new Error("no")
        }))
        assert.deepStrictEqual(fromHooks.map((e) => (e as StoreError).reason), ["invalid", "invalid"])
        // A nested (joined) function's handle dies when it returns; the outer one's lives on.
        yield* kit.transaction((outer) => {
          let inner: StoreTx | undefined
          Effect.runSync(kit.transaction((tx) => {
            inner = tx
          }))
          assert.strictEqual((captureThrow(() => inner!.collection(notes).insert({ text: "x" })) as StoreError).reason, "invalid")
          outer.collection(notes).insert({ text: "outer lives" }, { id: "lives" })
        })
        assert.deepStrictEqual((yield* c.list()).map((r) => r.id), ["lives"])
      }).pipe(Effect.scoped))

    it.effect("nothing runs between a transaction's begin and its commit; a transaction started inside one joins it; the host's spans owners", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        const revs = yield* Effect.all(
          Array.from({ length: 20 }, (_, t) =>
            kit.transaction((tx) => Array.from({ length: 5 }, (_, i) => tx.collection(notes).insert({ text: `${t}.${i}` }).rev))),
          { concurrency: "unbounded" }
        )
        for (const r of revs) for (let i = 1; i < r.length; i++) assert.strictEqual(r[i], r[0]! + i)
        const exit = yield* Effect.exit(kit.transaction((tx) => {
          tx.collection(notes).insert({ text: "outer" }, { id: "outer" })
          Effect.runSync(kit.transaction((inner) => inner.collection(notes).insert({ text: "inner" }, { id: "inner" })))
          Effect.runSync(c.insert({ text: "plain" }, { id: "plain" }))
          assert.strictEqual(tx.collection(notes).list({ limit: maxListRows(notes) }).filter((r) => ["outer", "inner", "plain"].includes(r.id)).length, 3)
          throw new Error("no")
        }))
        assert.isTrue(Exit.isFailure(exit))
        for (const id of ["outer", "inner", "plain"]) assert.strictEqual(yield* c.get(id), undefined)
        yield* store.prepare([KIT, { id: "other", storage: { collections: [notes] } }], [SCHEDULER])
        // The host's transaction: two modules' rows and a core service's job commit together, or not at all.
        yield* store.transaction((tx) => {
          tx.forModule("kit").collection(notes).insert({ text: "k" }, { id: "k" })
          tx.forModule("other").collection(notes).insert({ text: "o" }, { id: "o" })
          tx.forCore("core.scheduler").collection(jobs).insert({ module: "kit", state: "scheduled", dueAt: 5 }, { id: "j" })
        })
        assert.isDefined(yield* c.get("k"))
        assert.isDefined(yield* store.forModule("other").collection(notes).get("o"))
        assert.isDefined(yield* store.forCore("core.scheduler").collection(jobs).get("j"))
        const undone = yield* Effect.exit(store.transaction((tx) => {
          tx.forModule("kit").collection(notes).insert({ text: "k2" }, { id: "k2" })
          tx.forCore("core.scheduler").collection(jobs).insert({ module: "kit", state: "scheduled", dueAt: 6 }, { id: "j2" })
          throw new Error("no")
        }))
        assert.isTrue(Exit.isFailure(undone))
        assert.strictEqual(yield* c.get("k2"), undefined)
        assert.strictEqual(yield* store.forCore("core.scheduler").collection(jobs).get("j2"), undefined)
      }).pipe(Effect.scoped))

    it.effect("no SQL anywhere: core services use document collections under a reserved owner, reached through a host-only handle; a module reaches only its own collections", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make, [KIT, { id: "other", storage: { collections: [notes] } }])
        const kit = store.forModule("kit")
        // Nothing on any handle takes SQL or names another owner.
        let txKeys: Array<string> = []
        yield* kit.transaction((tx) => {
          txKeys = Object.keys(tx).sort()
        })
        assert.deepStrictEqual(txKeys, ["afterCommit", "collection", "onRollback", "publish"])
        assert.deepStrictEqual(Object.keys(kit).sort(), ["collection", "moduleId", "readOnly", "transaction"])
        assert.isFalse("core" in store)
        let hostKeys: Array<string> = []
        yield* store.transaction((tx) => {
          hostKeys = Object.keys(tx).sort()
        })
        assert.deepStrictEqual(hostKeys, ["afterCommit", "forCore", "forModule", "onRollback"])
        // A module's handle reaches its own rows of a collection name another module also uses, never theirs.
        yield* store.forModule("other").collection(notes).insert({ text: "other's" }, { id: "x" })
        assert.strictEqual(yield* kit.collection(notes).get("x"), undefined)
        assert.strictEqual((yield* kit.collection(notes).list()).length, 0)
        // A core service's collection given to a module's handle is not that module's: refused.
        yield* store.forCore("core.scheduler").collection(jobs).insert({ module: "kit", state: "scheduled", dueAt: 1 }, { id: "j" })
        const reach = yield* Effect.exit(kit.collection(jobs).list())
        assert.strictEqual(reasonOf(reach), "invalid")
        const inTx = yield* Effect.exit(kit.transaction((tx) => tx.collection(jobs).list()))
        assert.strictEqual(reasonOf(inTx), "invalid")
        // A core owner is not a module id, and no module id is a core owner; `core` itself is reserved.
        assert.strictEqual(reasonOf(yield* Effect.exit(store.forModule("core.scheduler").collection(jobs).list())), "invalid")
        assert.strictEqual(reasonOf(yield* Effect.exit(store.forCore("kit" as never).collection(notes).list())), "invalid")
        // A module that claims a core owner's id is ignored: the core service's data and verdict are untouched.
        yield* store.prepare([{ id: "core", storage: { collections: [notes] } }, { id: "core.scheduler", storage: { collections: [jobs] } }], [])
        assert.isDefined(store.availability("core"))
        assert.strictEqual(store.availability("core.scheduler"), undefined)
        assert.isDefined(yield* store.forCore("core.scheduler").collection(jobs).get("j"))
        yield* store.prepare([KIT], [SCHEDULER])
        // Scheduled jobs by due time: one indexed range read (`where` state, ordered by dueAt through the pair index).
        const s = store.forCore("core.scheduler").collection(jobs)
        for (const [id, dueAt, state] of [["b", 30, "scheduled"], ["c", 20, "done"], ["d", 10, "scheduled"]] as const) yield* s.insert({ module: "kit", state, dueAt }, { id })
        assert.deepStrictEqual((yield* s.list({ where: { state: "scheduled" }, orderBy: { field: "dueAt" } })).map((r) => r.id), ["j", "d", "b"])
        // Core events are namespaced by the owner, like a module's.
        const heard: Array<string> = []
        store.onCommit((r) => heard.push(...r.flatMap((x) => (x._tag === "event" ? [x.event.type] : []))))
        yield* store.forCore("core.scheduler").transaction((tx) => tx.publish("job.due", {}))
        assert.deepStrictEqual(heard, ["core.scheduler.job.due"])
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
        const bad = yield* Effect.exit(kit.transaction((tx) => tx.publish("Not A Type", {})))
        assert.strictEqual(reasonOf(bad), "invalid")
        const badScope = yield* Effect.exit(kit.transaction((tx) => tx.publish("ok", {}, { kind: "device", id: "a\u0000b" })))
        assert.strictEqual(reasonOf(badScope), "invalid")
        yield* events.publish("Bad Type", {})
        assert.deepStrictEqual(seen, ["kit.outside"])
        const done = yield* Deferred.make<void>()
        yield* Effect.forkScoped(Stream.runForEach(bus.subscribe({ type: "kit.ping" }), () => Effect.andThen(kit.collection(notes).insert({ text: "pong" }), Deferred.succeed(done, undefined))))
        yield* settle
        yield* kit.transaction((tx) => tx.publish("ping", {}))
        yield* Deferred.await(done)
        assert.strictEqual((yield* kit.collection(notes).list()).filter((r) => r.value.text === "pong").length, 1)
      }).pipe(Effect.scoped))

    it.effect("the bus runs no subscriber code on a committer's stack: not to deliver, not to end a subscription, whatever its capacity option", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const bus = makeEventBus()
        connectStoreToBus(store, bus)
        const kit = store.forModule("kit")
        const log: Array<string> = []
        let committing = false
        let gate: "live" | "ended" = "live"
        for (const capacity of [0, Number.NaN, Number.POSITIVE_INFINITY, -1, 1]) {
          yield* Effect.forkScoped(Stream.runForEach(bus.subscribe({ prefix: "kit." }, { capacity }), () => Effect.sync(() => log.push(committing ? `on the stack (${capacity})` : "after"))))
        }
        // A gated subscription whose stream has a finalizer that writes to the store.
        yield* Effect.forkScoped(
          Stream.runForEach(bus.subscribe({ prefix: "kit." }, { gate: () => gate }), () => Effect.sync(() => log.push(committing ? "gated on the stack" : "gated after"))).pipe(
            Effect.ensuring(Effect.sync(() => {
              log.push(committing ? "finalizer on the stack" : "finalizer after")
              Effect.runSync(Effect.ignore(kit.collection(notes).insert({ text: "from a finalizer" })))
            }))
          )
        )
        yield* settle
        committing = true
        Effect.runSync(kit.transaction((tx) => tx.publish("ping", {})))
        committing = false
        yield* settle
        assert.isFalse(log.some((l) => l.includes("on the stack")), log.join(", "))
        assert.strictEqual(log.filter((l) => l === "after").length, 5)
        gate = "ended"
        committing = true
        Effect.runSync(kit.transaction((tx) => tx.publish("ping", {})))
        committing = false
        yield* settle
        assert.isFalse(log.some((l) => l.includes("on the stack")), log.join(", "))
        assert.include(log, "finalizer after")
        assert.strictEqual(bus.stats().subscribers, 5)
        // A subscriber that never reads loses events beyond its queue (no option makes the queue unbounded).
        const stalled = bus.subscribe({ prefix: "kit." }, { capacity: Number.POSITIVE_INFINITY })
        const pull = yield* Effect.forkScoped(Stream.runForEach(stalled, () => Effect.never))
        yield* settle
        const before = bus.stats().dropped
        for (let i = 0; i < 5000; i++) Effect.runSync(kit.transaction((tx) => tx.publish("flood", {})))
        assert.isAbove(bus.stats().dropped - before, 0)
        yield* Fiber.interrupt(pull)
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
        assert.isFalse(yield* c.remove("x").pipe(inTurn(study)))
        assert.strictEqual((yield* c.get("x").pipe(inTurn(kitchen)))?.value.text, "kitchen secret")
        assert.isTrue(yield* c.remove("x", { expectRev: k.rev }).pipe(inTurn(kitchen)))
        assert.strictEqual(yield* c.get("x").pipe(inTurn(kitchen)), undefined)
        assert.deepStrictEqual((yield* c.list().pipe(inTurn(kitchen))).length, 0)
        assert.strictEqual(removed.length, 1)
        assert.deepStrictEqual(removed[0]!.scope, { kind: "device", id: "kitchen-01" })
        assert.strictEqual((removed[0]!.before?.value as Note).text, "kitchen secret")
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
          assert.strictEqual(reasonOf(exit), "invalid", JSON.stringify(id))
          const read = yield* Effect.exit(d.get("x", { scope: { kind: "device", id } }))
          assert.strictEqual(reasonOf(read), "invalid")
        }
        for (const id of ["a\u0000", "a/b", "", "x".repeat(201)]) {
          const exit = yield* Effect.exit(kit.collection(notes).insert({ text: "s" }, { id }))
          assert.strictEqual(reasonOf(exit), "invalid", JSON.stringify(id))
        }
        const odd = yield* Effect.exit(d.insert({ text: "s" }).pipe(inTurn(turnOf({ deviceId: "a b" }))))
        assert.strictEqual(reasonOf(odd), "invalid")
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
        const befores: Array<unknown> = []
        store.onCommit((released) => befores.push(...released.flatMap((r) => (r._tag === "change" && r.change.before !== undefined ? [r.change.before.value] : []))))
        yield* d.update("copy", (v) => {
          ;(v as { text: string }).text = "after"
          return v
        }, { scope: { kind: "device", id: "kitchen-01" } })
        assert.deepStrictEqual(befores, [{ text: "mine" }])
        assert.strictEqual((yield* d.get("copy", { scope: { kind: "device", id: "kitchen-01" } }))?.value.text, "after")
      }).pipe(Effect.scoped))

    it.effect("an ended conversation's rows are hidden at once and removed in bounded steps, one transaction each; a sweep at start does the same", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(chat)
        const turn = turnOf()
        const removed = yield* c.insert({ text: "removed scratch" }).pipe(inTurn(turn))
        yield* c.remove(removed.id).pipe(inTurn(turn))
        const rest = Math.max(1, Math.floor(BULK_STEP_ROWS / 2))
        const n = BULK_STEP_ROWS * 2 + rest
        yield* store.forModule("kit").transaction((tx) => {
          for (let i = 0; i < n; i++) tx.collection(chat).insert({ text: `live scratch ${i}` })
        }).pipe(inTurn(turn))
        yield* c.insert({ text: "another conversation" }).pipe(inTurn(turnOf({ conversationId: "conv-2" })))
        const batches: Array<number> = []
        store.onCommit((released) => batches.push(released.filter((r) => r._tag === "change" && r.change.op === "remove").length))
        const ending = yield* Effect.forkChild(store.endConversation("conv-1"))
        yield* Effect.yieldNow
        // Hidden from the moment it ends; a write to it is refused.
        assert.strictEqual((yield* c.list().pipe(inTurn(turn))).length, 0)
        assert.strictEqual(reasonOf(yield* Effect.exit(c.insert({ text: "late" }).pipe(inTurn(turn)))), "invalid")
        assert.strictEqual(yield* Fiber.join(ending), n)
        // In steps of at most BULK_STEP_ROWS, each its own commit.
        assert.deepStrictEqual(batches, [BULK_STEP_ROWS, BULK_STEP_ROWS, rest])
        assert.strictEqual((yield* c.list().pipe(inTurn(turnOf({ conversationId: "conv-2" })))).length, 1)
        yield* c.insert({ text: "left behind" }).pipe(inTurn(turnOf({ conversationId: "conv-9" })))
        assert.strictEqual(yield* store.sweepConversations, 2)
        assert.strictEqual((yield* c.list().pipe(inTurn(turnOf({ conversationId: "conv-9" })))).length, 0)
        // After it ended, the conversation's scope can be used again (a new conversation never reuses an id).
        assert.isDefined(yield* c.insert({ text: "again" }).pipe(inTurn(turn)))
      }).pipe(Effect.scoped))

    it.effect("one data version per module: newer stored data makes it unavailable, and nothing of it is read, migrated or deleted, also by a declaration that omits a collection", () =>
      Effect.gen(function*() {
        const keep = defineCollection({ name: "keep", scope: "household", schema: Note, indexes: ["tag"] })
        const scratch = defineCollection({ name: "scratch", scope: "conversation", schema: Note, indexes: ["tag"] })
        const store = yield* make()
        yield* store.prepare([{ id: "later", storage: { version: 2, collections: [keep, scratch] } }])
        yield* store.forModule("later").collection(scratch).insert({ text: "kept for the newer module", tag: "t" }).pipe(inTurn(turnOf()))
        yield* store.forModule("later").collection(keep).insert({ text: "kept", tag: "t" })
        // An older build of the module, which does not even declare `scratch`: its data is newer than it knows.
        yield* store.prepare([{ id: "later", storage: { version: 1, collections: [keep] } }])
        assert.match(store.availability("later")?.reason ?? "", /newer version/)
        assert.strictEqual(yield* store.sweepConversations, 0)
        assert.strictEqual(yield* store.endConversation("conv-1"), 0)
        assert.strictEqual(reasonOf(yield* Effect.exit(store.forModule("later").collection(keep).list())), "unavailable")
        assert.strictEqual(store.reader("later", keep), undefined)
        // The newer build again: every row and index as it was.
        yield* store.prepare([{ id: "later", storage: { version: 2, collections: [keep, scratch] } }])
        assert.strictEqual(store.availability("later"), undefined)
        assert.deepStrictEqual(texts(yield* store.forModule("later").collection(scratch).list({ where: { tag: "t" } }).pipe(inTurn(turnOf()))), ["kept for the newer module"])
        assert.deepStrictEqual(texts(yield* store.forModule("later").collection(keep).list({ where: { tag: "t" } })), ["kept"])
      }).pipe(Effect.scoped))

    it.effect("older data: every collection is migrated in one transaction; every row is checked against the new schema and indexes; a failure rolls everything back and says which row", () =>
      Effect.gen(function*() {
        const Item1 = Schema.Struct({ label: Schema.String })
        const items1 = defineCollection({ name: "items", scope: "household", schema: Item1, indexes: ["label"] })
        const tags1 = defineCollection({ name: "tags", scope: "household", schema: Schema.Struct({ k: Schema.optionalKey(Schema.Unknown) }) })
        const Item2 = Schema.Struct({ text: Schema.String, qty: Schema.Finite })
        const items2 = defineCollection({
          name: "items",
          scope: "household",
          schema: Item2,
          indexes: ["text", ["text", "qty"]],
          migrate: { 1: (old: { label: string }) => ({ text: old.label.replace("Oat", "Rice"), qty: 1 }) },
          project: (row: Row<{ text: string; qty: number }>) => ({ text: row.value.text })
        })
        // Version 2 indexes `k`, which one stored row holds as a list: that row cannot be indexed.
        const tags2 = defineCollection({ name: "tags", scope: "household", schema: Schema.Struct({ k: Schema.optionalKey(Schema.Unknown) }), indexes: ["k"] })
        const store = yield* make()
        yield* store.prepare([{ id: "shop", storage: { collections: [items1, tags1] } }])
        const row = yield* store.forModule("shop").collection(items1).insert({ label: "Oat milk" })
        yield* store.forModule("shop").collection(tags1).insert({ k: "fine" }, { id: "fine" })
        yield* store.forModule("shop").collection(tags1).insert({ k: [2] }, { id: "listy" })
        yield* store.prepare([{ id: "shop", storage: { version: 2, collections: [items2, tags2] } }])
        const reason = store.availability("shop")?.reason ?? ""
        assert.match(reason, /could not be upgraded/)
        assert.match(reason, /listy/)
        // Nothing changed: version 1 reads both collections as they were (items was not migrated either).
        yield* store.prepare([{ id: "shop", storage: { collections: [items1, tags1] } }])
        assert.strictEqual(store.availability("shop"), undefined)
        assert.deepStrictEqual((yield* store.forModule("shop").collection(items1).get(row.id))?.value, { label: "Oat milk" })
        yield* store.forModule("shop").collection(tags1).update("listy", () => ({ k: 2 }))
        // Now the upgrade goes through: both collections, their indexes follow.
        yield* store.prepare([{ id: "shop", storage: { version: 2, collections: [items2, tags2] } }])
        assert.strictEqual(store.availability("shop"), undefined)
        const items = store.forModule("shop").collection(items2)
        assert.deepStrictEqual((yield* items.get(row.id))?.value, { text: "Rice milk", qty: 1 })
        assert.deepStrictEqual((yield* items.list({ where: { text: "Rice milk" } })).map((r) => r.id), [row.id])
        assert.deepStrictEqual((yield* items.list({ where: { text: "Rice milk" }, orderBy: { field: "qty" } })).map((r) => r.id), [row.id])
        assert.deepStrictEqual((yield* store.forModule("shop").collection(tags2).list({ where: { k: 2 } })).map((r) => r.id), ["listy"])
        // The older module again: refused, with a reason; never opened and never written, also through a handle made before.
        const before = store.forModule("shop").collection(items1)
        yield* store.prepare([{ id: "shop", storage: { collections: [items1, tags1] } }])
        assert.match(store.availability("shop")?.reason ?? "", /newer version/)
        for (const attempt of [store.forModule("shop").collection(items1).insert({ label: "x" }), before.list(), store.forModule("shop").transaction(() => undefined)]) {
          assert.strictEqual(reasonOf(yield* Effect.exit(attempt as Effect.Effect<unknown, unknown>)), "unavailable")
        }
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "shop", collections: [items2], events: [] }] })
        assert.deepStrictEqual(allFrames(feed.snapshot({ id: "kitchen-01" })).flatMap((f) => f.collections), [])
      }).pipe(Effect.scoped))

    it.effect("a migration whose output breaks the size limit or the schema fails: nothing changes, the module is unavailable", () =>
      Effect.gen(function*() {
        const v1 = defineCollection({ name: "texts", scope: "household", schema: Schema.Struct({ body: Schema.String }), maxChars: MAX_VALUE_CHARS })
        const v2 = defineCollection({
          name: "texts",
          scope: "household",
          maxChars: MAX_VALUE_CHARS,
          schema: Schema.Struct({ body: Schema.String, copy: Schema.String }),
          migrate: { 1: (old: { body: string }) => ({ ...old, copy: old.body }) }
        })
        const store = yield* make()
        yield* store.prepare([{ id: "big", storage: { collections: [v1] } }])
        yield* store.forModule("big").collection(v1).insert({ body: "small" }, { id: "a" })
        const row = yield* store.forModule("big").collection(v1).insert({ body: "x".repeat(Math.floor(MAX_VALUE_CHARS * 0.6)) }, { id: "b" })
        yield* store.prepare([{ id: "big", storage: { version: 2, collections: [v2] } }])
        assert.match(store.availability("big")?.reason ?? "", /could not be upgraded/)
        yield* store.prepare([{ id: "big", storage: { collections: [v1] } }])
        assert.strictEqual(store.availability("big"), undefined)
        assert.strictEqual((yield* store.forModule("big").collection(v1).get(row.id))?.value.body.length, Math.floor(MAX_VALUE_CHARS * 0.6))
        assert.deepStrictEqual((yield* store.forModule("big").collection(v1).get("a"))?.value, { body: "small" })
      }).pipe(Effect.scoped))

    it.effect("shapes: the same version with another schema, scope or indexes is refused; a scope never changes, even with a new version; the comparison is on the shape, not the object", () =>
      Effect.gen(function*() {
        const base = { name: "items", scope: "household" as const, schema: Note }
        const v1 = defineCollection({ ...base, indexes: ["tag"] })
        const store = yield* make()
        yield* store.prepare([{ id: "shop", storage: { collections: [v1] } }])
        yield* store.forModule("shop").collection(v1).insert({ text: "a", tag: "t" }, { id: "a" })
        // Another object with the same shape is the same declaration.
        const same = defineCollection({ ...base, indexes: ["tag"] })
        yield* store.prepare([{ id: "shop", storage: { collections: [same] } }])
        assert.strictEqual(store.availability("shop"), undefined)
        assert.deepStrictEqual((yield* store.forModule("shop").collection(v1).list({ where: { tag: "t" } })).map((r) => r.id), ["a"])
        // A different shape at the same version: refused, nothing touched.
        for (const changed of [
          defineCollection({ ...base, indexes: ["tag", "n"] }),
          defineCollection({ ...base, indexes: [] }),
          defineCollection({ ...base, schema: Schema.Struct({ text: Schema.String, extra: Schema.optionalKey(Schema.String) }), indexes: ["tag"] }),
          defineCollection({ ...base, scope: "device", indexes: ["tag"] })
        ]) {
          yield* store.prepare([{ id: "shop", storage: { collections: [changed] } }])
          assert.match(store.availability("shop")?.reason ?? "", /shape|scope/, JSON.stringify(changed.indexes))
          yield* store.prepare([{ id: "shop", storage: { collections: [v1] } }])
          assert.deepStrictEqual((yield* store.forModule("shop").collection(v1).list({ where: { tag: "t" } })).map((r) => r.id), ["a"])
        }
        // A scope change with a new version is refused too: declare a new collection instead.
        const moved = defineCollection({ ...base, scope: "device", indexes: ["tag"] })
        yield* store.prepare([{ id: "shop", storage: { version: 2, collections: [moved] } }])
        assert.match(store.availability("shop")?.reason ?? "", /scope/)
        yield* store.prepare([{ id: "shop", storage: { collections: [v1] } }])
        assert.strictEqual(store.availability("shop"), undefined)
        // A handle of another declaration of the name (defined apart, or kept from before) is refused, not used with
        // its own scope or indexes.
        const otherScope = defineCollection({ ...base, scope: "device" })
        assert.strictEqual(reasonOf(yield* Effect.exit(store.forModule("shop").collection(otherScope).insert({ text: "x" }, { scope: { kind: "device", id: "kitchen-01" } }))), "invalid")
        const unindexed = defineCollection({ ...base })
        assert.strictEqual(reasonOf(yield* Effect.exit(store.forModule("shop").collection(unindexed).insert({ text: "x" }))), "invalid")
        const retained = store.forModule("shop").collection(v1)
        const v2 = defineCollection({ ...base, indexes: ["tag", "n"] })
        yield* store.prepare([{ id: "shop", storage: { version: 2, collections: [v2] } }])
        assert.strictEqual(store.availability("shop"), undefined)
        assert.strictEqual(reasonOf(yield* Effect.exit(retained.insert({ text: "through the old handle", n: [1] as never }))), "invalid")
        assert.deepStrictEqual((yield* store.forModule("shop").collection(v2).list({ where: { n: 1 } })), [])
      }).pipe(Effect.scoped))

    it.effect("data of a collection no declaration names any more is kept, unreachable, and listed; declared again it is there", () =>
      Effect.gen(function*() {
        const a = defineCollection({ name: "a", scope: "household", schema: Note })
        const b = defineCollection({ name: "b", scope: "household", schema: Note })
        const talk = defineCollection({ name: "talk", scope: "conversation", schema: Note })
        const store = yield* make()
        yield* store.prepare([{ id: "m", storage: { collections: [a, b, talk] } }])
        yield* store.forModule("m").collection(b).insert({ text: "in b" }, { id: "x" })
        yield* store.forModule("m").collection(talk).insert({ text: "said" }, { id: "t" }).pipe(inTurn(turnOf()))
        yield* store.prepare([{ id: "m", storage: { version: 2, collections: [a] } }])
        assert.strictEqual(store.availability("m"), undefined)
        assert.deepStrictEqual(store.undeclared(), [{ owner: "m", collection: "b", version: 1 }, { owner: "m", collection: "talk", version: 1 }])
        assert.strictEqual(reasonOf(yield* Effect.exit(store.forModule("m").collection(b).list())), "invalid")
        // Not even an ended conversation's rows of a collection no one declares are removed.
        assert.strictEqual(yield* store.sweepConversations, 0)
        assert.strictEqual(yield* store.endConversation("conv-1"), 0)
        yield* store.prepare([{ id: "m", storage: { version: 3, collections: [a, b, talk] } }])
        assert.deepStrictEqual(store.undeclared(), [])
        assert.strictEqual((yield* store.forModule("m").collection(b).get("x"))?.value.text, "in b")
        assert.strictEqual((yield* store.forModule("m").collection(talk).get("t", { scope: { kind: "conversation", id: "conv-1" } }))?.value.text, "said")
      }).pipe(Effect.scoped))

    it.effect("module ids: the host's and the core services' namespaces and an id two modules share are refused for stored data", () =>
      Effect.gen(function*() {
        const store = yield* make()
        yield* store.prepare([
          { id: "host", storage: { collections: [notes] } },
          { id: "core", storage: { collections: [notes] } },
          { id: "twice", storage: { collections: [notes] } },
          { id: "twice", storage: { collections: [notes] } },
          { id: "Bad_Id", storage: { collections: [notes] } }
        ], [{ owner: "core.twice" as const, storage: {} }, { owner: "core.twice" as const, storage: {} }])
        for (const id of ["host", "core", "twice", "Bad_Id", "core.twice"]) assert.isDefined(store.availability(id), id)
        for (const id of ["host", "twice"]) {
          const exit = yield* Effect.exit(store.forModule(id).collection(notes).insert({ text: "x" }))
          assert.strictEqual(reasonOf(exit), "unavailable")
        }
      }).pipe(Effect.scoped))

    it.effect("pages: what a page gets is decided when its frame is built; a removal names only the collection and the id, to every page that could have been shown the row's scope", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const modules = [{ moduleId: "kit", collections: KIT.storage.collections ?? [], events: [] }]
        const feed = makeHouseholdFeed({ store, modules })
        const kit = store.forModule("kit")
        const shownRows = kit.collection(shown)
        const pageOf = (id: string) => {
          const page = makeHouseholdPage({ feed, device: () => ({ id }) })
          store.onCommit((r) => page.offer(r))
          const drain = () => {
            const out: Array<PageMessage> = []
            while (page.pending()) out.push(...page.step())
            return out.flatMap((m) => (m.type === "household.event" ? [m.event.data as HouseholdChange] : []))
          }
          drain()
          return drain
        }
        const kitchen = pageOf("kitchen-01")
        const study = pageOf("study-001")
        const ops = (xs: ReadonlyArray<HouseholdChange>) => xs.map((x) => (x.op === "put" ? { op: x.op, value: x.value } : { op: x.op, id: x.id }))
        yield* kit.collection(notes).insert({ text: "never sent" })
        const forKitchen = yield* shownRows.insert({ text: "alarm: wake Sam", tag: "kitchen-01" })
        yield* shownRows.insert({ text: "for everyone" })
        assert.deepStrictEqual(ops(kitchen()), [{ op: "put", value: { text: "alarm: wake Sam" } }, { op: "put", value: { text: "for everyone" } }])
        // The study could have been shown the household row: it is told it is not for it (it ignores an id it lacks).
        assert.deepStrictEqual(ops(study()), [{ op: "remove", id: forKitchen.id }, { op: "put", value: { text: "for everyone" } }])
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "alarm: study", tag: "study-001" }))
        assert.deepStrictEqual(ops(kitchen()), [{ op: "remove", id: forKitchen.id }])
        assert.deepStrictEqual(ops(study()), [{ op: "put", value: { text: "alarm: study" } }])
        // Shown to the kitchen, then hidden from it, then removed, before the kitchen's frame was built: never sent.
        const secret = yield* shownRows.insert({ text: "secret for the kitchen", tag: "kitchen-01" })
        yield* shownRows.update(secret.id, (v) => ({ ...v, tag: "study-001" }))
        yield* shownRows.remove(secret.id)
        const k = kitchen()
        assert.isFalse(JSON.stringify(k).includes("secret"))
        assert.deepStrictEqual(k.map((x) => (x as { rev?: number; value?: unknown }).value), [undefined])
        assert.deepStrictEqual(Object.keys(k[0]!).sort(), ["collection", "id", "op"])
        study()
        // A page that fell behind gets only the value now, never the ones between.
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "v2" }))
        yield* shownRows.update(forKitchen.id, (v) => ({ ...v, text: "v3" }))
        assert.deepStrictEqual(ops(study()), [{ op: "put", value: { text: "v3" } }])
        // Removed in one device's scope and recreated in another's with the same id, coalesced: the first device is
        // told the id is gone, in its own scope, and nothing of the other device's row.
        const devRows = kit.collection(shownDev)
        yield* devRows.insert({ text: "A's" }, { id: "x", scope: { kind: "device", id: "kitchen-01" } })
        kitchen()
        yield* devRows.remove("x", { scope: { kind: "device", id: "kitchen-01" } })
        yield* devRows.insert({ text: "B's secret" }, { id: "x", scope: { kind: "device", id: "study-001" } })
        const gone = kitchen()
        assert.deepStrictEqual(ops(gone), [{ op: "remove", id: "x" }])
        assert.isFalse(JSON.stringify(gone).includes("study-001") || JSON.stringify(gone).includes("secret"))
        assert.deepStrictEqual(ops(study()), [{ op: "put", value: { text: "B's secret" } }])
        // The snapshot is the rows now; the device record decides.
        const snapK = allFrames(feed.snapshot({ id: "kitchen-01" })).flatMap((f) => f.collections)
        assert.deepStrictEqual(snapK.map((x) => x.collection), ["shown"])
        assert.deepStrictEqual(snapK[0]!.rows.map((r) => r.value), [{ text: "for everyone" }])
        const named = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: [byName], events: [] }] })
        yield* kit.collection(byName).insert({ text: "for Kitchen" })
        assert.strictEqual(allFrames(named.snapshot({ id: "kitchen-01", name: "Kitchen" })).flatMap((f) => f.collections).length, 1)
        assert.strictEqual(allFrames(named.snapshot({ id: "kitchen-01", name: "Guest" })).flatMap((f) => f.collections).length, 0)
      }).pipe(Effect.scoped))

    it.effect("pages: one queue per page; a fresh snapshot keeps accepted module events and sends them after it, in order; an overflow drops everything and says so", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const ping = defineEventType({ type: "ping", project: (e, device) => ({ n: (e.data as { n: number }).n, to: device.name ?? null }) })
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: [shown], events: [ping] }] })
        const kit = store.forModule("kit")
        yield* kit.transaction((tx) => {
          for (let i = 0; i < 60; i++) tx.collection(shown).insert({ text: `n${i}` })
        })
        let name = "Kitchen"
        const page = makeHouseholdPage({ feed, device: () => ({ id: "kitchen-01", name }), maxQueued: 20 })
        store.onCommit((r) => page.offer(r))
        const sent: Array<PageMessage> = []
        // Part of the snapshot, then an event and a change, then the device is renamed before anything is drained.
        sent.push(...page.step())
        yield* kit.transaction((tx) => {
          tx.publish("ping", { n: 1 })
          tx.collection(shown).insert({ text: "during" })
        })
        name = "Guest"
        page.refresh()
        while (page.pending()) sent.push(...page.step())
        const kinds = sent.map((m) => (m.type === "household.snapshot" ? `s${m.part}${m.final ? "!" : ""}` : m.type === "household.event" ? m.event.type : m.type))
        const restart = kinds.lastIndexOf("s0")
        assert.isAbove(restart, 0)
        const final = kinds.indexOf(kinds.find((k, i) => i > restart && k.endsWith("!"))!)
        // The event follows the new snapshot's final part, projected with the new record.
        assert.deepStrictEqual(kinds.slice(final + 1), ["kit.ping"])
        assert.deepStrictEqual((sent.at(-1) as { event: { data: unknown } }).event.data, { n: 1, to: "Guest" })
        // More waiting than the bound: everything goes, the page is told (household.gap), then a fresh snapshot.
        for (let i = 0; i < 30; i++) Effect.runSync(kit.transaction((tx) => tx.publish("ping", { n: i })))
        const after: Array<PageMessage> = []
        while (page.pending()) after.push(...page.step())
        assert.deepStrictEqual(after[0], { type: "household.gap", reason: "overflow" })
        assert.strictEqual(after[1]?.type, "household.snapshot")
        // What was accepted after the overflow is sent after the fresh snapshot, in order; nothing from before it.
        const finalAt = after.findIndex((m) => m.type === "household.snapshot" && m.final)
        const delivered = after.flatMap((m, i) => (m.type === "household.event" ? [{ i, n: (m.event.data as { n: number }).n }] : []))
        assert.isTrue(delivered.every((d) => d.i > finalAt))
        // (The bound keeps room for a snapshot: the 20th waiting entry overflows when no snapshot is queued.)
        assert.deepStrictEqual(delivered.map((d) => d.n), [20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
        assert.strictEqual(page.size(), 0)
      }).pipe(Effect.scoped))

    it.effect("pages: every snapshot frame fits its limit, the whole snapshot fits its bound counted as sent, and a collection cut short is named; no rows and rows left out differ", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const problems: Array<FeedProblem> = []
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: KIT.storage.collections ?? [], events: [] }], report: (p) => problems.push(p) })
        const kit = store.forModule("kit")
        yield* kit.collection(broken).insert({ text: "fine" })
        yield* kit.collection(broken).insert({ text: "throws", tag: "bad" })
        yield* kit.collection(broken).insert({ text: "bigint", tag: "big" })
        const brokenRows = allFrames(feed.snapshot({ id: "kitchen-01" })).flatMap((f) => f.collections).filter((x) => x.collection === "broken").flatMap((x) => x.rows.map((r) => r.value))
        assert.deepStrictEqual(brokenRows, [{ text: "fine" }])
        assert.deepStrictEqual(problems.map((p) => p.what), ["broken", "broken"])
        // Rows near the value limit until the whole snapshot's bound cuts it short.
        const big = "y".repeat(MAX_VALUE_CHARS - 100)
        for (let i = 0; i < 70; i++) yield* kit.collection(shown).insert({ text: `${i} ${big}` })
        const frames = allFrames(feed.snapshot({ id: "kitchen-01" }))
        const sizes = frames.map((f) => encodeServerMessage(f).length)
        for (const n of sizes) assert.isAtMost(n, SNAPSHOT_PART_CHARS)
        assert.isAtMost(sizes.reduce((a, b) => a + b, 0), SNAPSHOT_MAX_CHARS)
        assert.isTrue(frames.at(-1)!.final)
        assert.isTrue(frames.slice(0, -1).every((f) => !f.final && f.truncated.length === 0))
        assert.deepStrictEqual(frames.map((f) => f.part), frames.map((_, i) => i))
        const shownRows = frames.flatMap((f) => f.collections).filter((x) => x.collection === "shown")
        const total = shownRows.reduce((n, x) => n + x.rows.length, 0)
        assert.isTrue(total > 5 && total < 70)
        const cut = frames.at(-1)!.truncated.map((t) => t.collection)
        assert.include(cut, "shown")
        // A collection left out entirely after the budget ran out is named too; one with nothing visible is not.
        assert.include(cut, "broken")
        assert.notInclude(cut, "notes")
        // Many collections, each with one row near the limit: the final part names every one that did not fit, so no
        // visible collection is silently absent.
        const many = Array.from({ length: 128 }, (_, i) => defineCollection({ name: `c${i}`, scope: "household", schema: Note, maxChars: MAX_VALUE_CHARS, project: (row: Row<Note>) => ({ t: row.value.text }) }))
        const wideModules = Array.from({ length: 2 }, (_, m) => ({ id: `wide${m}`, storage: { collections: many.slice(m * 64, m * 64 + 64) } }))
        yield* store.prepare(wideModules)
        for (const [m, w] of wideModules.entries()) {
          for (const c of w.storage.collections) yield* store.forModule(`wide${m}`).collection(c).insert({ text: "z".repeat(MAX_VALUE_CHARS - 200) })
        }
        const wideFeed = makeHouseholdFeed({ store, modules: wideModules.map((w) => ({ moduleId: w.id, collections: w.storage.collections, events: [] })) })
        const wide = allFrames(wideFeed.snapshot({ id: "kitchen-01" }))
        const wideSizes = wide.map((f) => encodeServerMessage(f).length)
        for (const n of wideSizes) assert.isAtMost(n, SNAPSHOT_PART_CHARS)
        assert.isAtMost(wideSizes.reduce((a, b) => a + b, 0), SNAPSHOT_MAX_CHARS)
        const withRows = new Set(wide.flatMap((f) => f.collections).map((x) => `${x.module}/${x.collection}`))
        const named = new Set(wide.at(-1)!.truncated.map((t) => `${t.module}/${t.collection}`))
        for (const [m, w] of wideModules.entries()) {
          for (const c of w.storage.collections) assert.isTrue(withRows.has(`wide${m}/${c.name}`) || named.has(`wide${m}/${c.name}`), `wide${m}/${c.name} is neither sent nor named`)
        }
        assert.isAbove(named.size, 0)
        // Rows of many sizes near the frame and value limits, forcing frame splits: every message counted whole as it is
        // encoded, each within its limit and the total within the bound, and close to it (the boundary is reached).
        const lengths = Array.from({ length: 90 }, (_, i) => [MAX_VALUE_CHARS - 100, MAX_VALUE_CHARS - 100, 9000, MAX_VALUE_CHARS - 100, 3100, 14000, 1901][i % 7]!)
        const huge = defineCollection({ name: "huge", scope: "household", schema: Schema.Struct({ s: Schema.String, n: Schema.Finite }), project: (row: Row<{ s: string; n: number }>) => ({ s: "q".repeat(row.value.n) }) })
        yield* store.prepare([{ id: "huge", storage: { collections: [huge] } }])
        for (const [i, n] of lengths.entries()) yield* store.forModule("huge").collection(huge).insert({ s: "q", n }, { id: `h${String(i).padStart(2, "0")}` })
        const hugeFeed = makeHouseholdFeed({ store, modules: [{ moduleId: "huge", collections: [huge], events: [] }] })
        const hugeFrames = allFrames(hugeFeed.snapshot({}))
        const hugeSizes = hugeFrames.map((f) => encodeServerMessage(f).length)
        for (const n of hugeSizes) assert.isAtMost(n, SNAPSHOT_PART_CHARS)
        const hugeTotal = hugeSizes.reduce((a, b) => a + b, 0)
        assert.isAtMost(hugeTotal, SNAPSHOT_MAX_CHARS)
        assert.isAbove(hugeTotal, SNAPSHOT_MAX_CHARS - MAX_VALUE_CHARS - 1000)
        assert.deepStrictEqual(hugeFrames.at(-1)!.truncated, [{ module: "huge", collection: "huge" }])
        // More projected collections than a final part can name: the rest are not sent, and reported.
        const tooMany: Array<FeedProblem> = []
        const crowd = Array.from({ length: MAX_FEED_COLLECTIONS + 1 }, (_, i) => defineCollection({ name: `x${i}`, scope: "household", schema: Note, project: () => ({}) }))
        makeHouseholdFeed({ store, modules: [{ moduleId: "crowd", collections: crowd, events: [] }], report: (p) => tooMany.push(p) })
        assert.strictEqual(tooMany.length, 1)
      }).pipe(Effect.scoped))

    it.effect("pages: a snapshot reads at most SNAPSHOT_READ_ROWS rows in all, a page shortened by that budget included, and the collection it cut is named", () =>
      Effect.gen(function*() {
        const tiny = Array.from({ length: 11 }, (_, i) => defineCollection({ name: `t${i}`, scope: "household", schema: Note, project: () => ({}) }))
        const store = yield* make()
        yield* store.prepare([{ id: "many", storage: { collections: tiny } }])
        // 499 rows, then nine of SNAPSHOT_ROWS (500): 4,999 read before the last collection, which has more than a page.
        const counts = [499, ...Array.from({ length: 9 }, () => 500), 40]
        for (const [i, c] of tiny.entries()) {
          yield* store.forModule("many").transaction((tx) => {
            for (let k = 0; k < counts[i]!; k++) tx.collection(c).insert({ text: "x" })
          })
        }
        let read = 0
        const counting: HouseholdStore = {
          ...store,
          reader: (owner, c) => {
            const r = store.reader(owner, c)
            return r === undefined ? undefined : {
              ...r,
              page: (scope, after, limit) => {
                const rows = r.page(scope, after, limit)
                read += rows.length
                return rows
              }
            }
          }
        }
        const feed = makeHouseholdFeed({ store: counting, modules: [{ moduleId: "many", collections: tiny, events: [] }] })
        const frames = allFrames(feed.snapshot({ id: "kitchen-01" }))
        assert.strictEqual(read, SNAPSHOT_READ_ROWS)
        assert.include(frames.at(-1)!.truncated.map((t) => t.collection), "t10")
        assert.notInclude(frames.at(-1)!.truncated.map((t) => t.collection), "t0")
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
        assert.strictEqual(yield* lines(), "A: a29 a28 a27 a26 a25\nB: b")
        assert.strictEqual(yield* lines(undefined, "off"), "")
        let t = 0
        assert.strictEqual(yield* lines(() => (t += 30)), "A: a29 a28 a27 a26 a25")
      }).pipe(Effect.scoped))

    it.effect("a read never migrates: every row is at its collection's version, so an upgrade with no rewrite leaves get and list agreeing with what is stored", () =>
      Effect.gen(function*() {
        const Count = Schema.Struct({ n: Schema.Finite })
        const v1 = defineCollection({ name: "counts", scope: "household", schema: Count, indexes: ["n"] })
        const v3 = defineCollection({ name: "counts", scope: "household", schema: Count, indexes: ["n"], migrate: { 1: (old: { n: number }) => ({ ...old, n: 2 }) } })
        const store = yield* make()
        yield* store.prepare([{ id: "m", storage: { collections: [v1] } }])
        yield* store.forModule("m").collection(v1).insert({ n: 1 }, { id: "x" })
        // Version 2: the same shape, nothing to migrate. Version 3 adds a migration from 1, which no row is at any more.
        yield* store.prepare([{ id: "m", storage: { version: 2, collections: [v1] } }])
        yield* store.prepare([{ id: "m", storage: { version: 3, collections: [v3] } }])
        assert.strictEqual(store.availability("m"), undefined)
        const c = store.forModule("m").collection(v3)
        assert.strictEqual((yield* c.get("x"))?.value.n, 1)
        assert.deepStrictEqual((yield* c.list({ where: { n: 1 } })).map((r) => r.id), ["x"])
        assert.deepStrictEqual(yield* c.list({ where: { n: 2 } }), [])
        assert.deepStrictEqual(store.reader("m", v3)?.page({ kind: "household" }, undefined, 10).map((r) => r.value), [{ n: 1 }])
      }).pipe(Effect.scoped))

    it.effect("maxChars: a value's limit, enforced at write; a list asks for at most min(100, LIST_BUDGET_CHARS / maxChars) rows; a change of it is a change of shape", () =>
      Effect.gen(function*() {
        for (const maxChars of [0, MAX_VALUE_CHARS + 1, 1.5]) {
          assert.throws(() => defineCollection({ name: "x", scope: "household", schema: Note, maxChars }), /maxChars/)
        }
        const small = defineCollection({ name: "small", scope: "household", schema: Note })
        const wide = defineCollection({ name: "wide", scope: "household", schema: Note, maxChars: MAX_VALUE_CHARS })
        assert.strictEqual(small.maxChars, DEFAULT_MAX_CHARS)
        assert.strictEqual(maxListRows(small), Math.min(MAX_LIST_LIMIT, Math.floor(LIST_BUDGET_CHARS / DEFAULT_MAX_CHARS)))
        assert.strictEqual(maxListRows(defineCollection({ name: "x", scope: "household", schema: Note, maxChars: 1 })), MAX_LIST_LIMIT)
        assert.isBelow(maxListRows(wide), MAX_LIST_LIMIT)
        assert.throws(() => defineCollection({ name: "x", scope: "household", schema: Note, maxChars: MAX_VALUE_CHARS, ambientRows: maxListRows(wide) + 1 }), /ambientRows/)
        const store = yield* make()
        yield* store.prepare([{ id: "m", storage: { collections: [small, wide] } }])
        const s = store.forModule("m").collection(small)
        const w = store.forModule("m").collection(wide)
        // {"text":"…"} is 11 characters around the text.
        assert.strictEqual(reasonOf(yield* Effect.exit(s.insert({ text: "x".repeat(DEFAULT_MAX_CHARS - 10) }))), "invalid")
        yield* s.insert({ text: "x".repeat(DEFAULT_MAX_CHARS - 11) }, { id: "fits" })
        yield* w.insert({ text: "x".repeat(15_000 - 11) }, { id: "long" })
        const most = maxListRows(wide)
        for (let i = 0; i < most + 3; i++) yield* w.insert({ text: `w${i}` })
        assert.strictEqual(reasonOf(yield* Effect.exit(w.list({ limit: most + 1 }))), "invalid")
        assert.strictEqual((yield* w.list({ limit: most })).length, most)
        // Without a limit: the default, or the most when that is smaller.
        assert.strictEqual((yield* w.list()).length, Math.min(20, most))
        assert.strictEqual(store.reader("m", wide)!.page({ kind: "household" }, undefined, MAX_LIST_LIMIT).length, most)
        // Another maxChars at the same version: refused. A smaller one with a longer row stored: the upgrade fails.
        const shrunk = defineCollection({ name: "wide", scope: "household", schema: Note, maxChars: 1000 })
        yield* store.prepare([{ id: "m", storage: { collections: [small, shrunk] } }])
        assert.match(store.availability("m")?.reason ?? "", /shape/)
        yield* store.prepare([{ id: "m", storage: { version: 2, collections: [small, shrunk] } }])
        assert.match(store.availability("m")?.reason ?? "", /could not be upgraded.*long/)
        yield* store.prepare([{ id: "m", storage: { version: 2, collections: [small, defineCollection({ name: "wide", scope: "household", schema: Note, maxChars: 15_500 })] } }])
        assert.strictEqual(store.availability("m"), undefined)
      }).pipe(Effect.scoped))

    it.effect("list continues `after` the last row of the previous page: 300 rows read completely, in order, in every legal order; an after of another query or collection is invalid", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        // Missing fields (indexed as missing), equal keys, equal and unequal times.
        for (let t = 0; t < 30; t++) {
          yield* kit.transaction((tx) => {
            for (let i = 0; i < 10; i++) {
              const k = t * 10 + i
              tx.collection(notes).insert({
                text: `r${k}`,
                ...(k % 4 === 3 ? {} : { tag: ["a", "b", "c"][k % 3]! }),
                ...(k % 5 === 4 ? {} : { n: k % 7 }),
                ...(k % 6 === 5 ? {} : { done: k % 2 === 0 })
              }, { id: `r${String((k * 37) % 300).padStart(3, "0")}` })
            }
          })
          yield* TestClock.adjust(t % 3 === 0 ? 0 : 1)
        }
        yield* kit.transaction((tx) => {
          for (let k = 0; k < 300; k += 7) tx.collection(notes).update(`r${String(k).padStart(3, "0")}`, (v) => ({ ...v, text: `${v.text}+` }))
        })
        const all = yield* allRows(store, "kit", notes)
        assert.strictEqual(all.length, 300)
        type Q = ListQuery<Note>
        const fieldKey = (r: Row<Note>, f: string): ReadonlyArray<unknown> =>
          f === "updatedAt" ? [r.updatedAt, r.createdAt, r.id] : f === "createdAt" ? [r.createdAt, r.id] : [indexKeyOf((r.value as unknown as Record<string, never>)[f]), r.createdAt, r.id]
        const expected = (q: Q) => {
          const where = Object.entries(q.where ?? {})[0]
          const f = q.orderBy?.field ?? "updatedAt"
          const desc = (q.orderBy?.direction ?? (f === "updatedAt" || f === "createdAt" ? "desc" : "asc")) === "desc"
          return all
            .filter((r) => where === undefined || indexKeyOf((r.value as unknown as Record<string, never>)[where[0]]) === indexKeyOf(where[1] as never))
            .sort((a, b) => {
              const ka = fieldKey(a, f)
              const kb = fieldKey(b, f)
              let x = 0
              for (let i = 0; i < ka.length && x === 0; i++) x = compareIndexed(ka[i], kb[i])
              return desc ? -x : x
            })
            .map((r) => r.id)
        }
        const queries: Array<Q> = []
        for (const direction of ["asc", "desc"] as const) {
          for (const field of ["updatedAt", "createdAt", "tag", "n", "done"] as const) queries.push({ orderBy: { field, direction } })
          for (const field of ["updatedAt", "createdAt", "tag", "n"] as const) queries.push({ where: { tag: "a" }, orderBy: { field, direction } })
          for (const field of ["updatedAt", "createdAt", "n"] as const) queries.push({ where: { n: 3 }, orderBy: { field, direction } })
          queries.push({ where: { done: true }, orderBy: { field: "createdAt", direction } })
        }
        queries.push({}, { where: { tag: "b" } })
        for (const q of queries) {
          for (const limit of [7, maxListRows(notes)]) {
            const got: Array<string> = []
            let after: Row<Note> | undefined
            for (let pages = 0; pages < 100; pages++) {
              const page = yield* c.list({ ...q, limit, ...(after !== undefined ? { after } : {}) })
              got.push(...page.map((r) => r.id))
              if (page.length < limit) break
              after = page.at(-1)
            }
            assert.deepStrictEqual(got, expected(q), `${JSON.stringify(q)} by ${limit}`)
          }
        }
        // In a transaction too.
        const firstTwo = yield* kit.transaction((tx) => {
          const n = tx.collection(notes)
          const one = n.list({ limit: 1 })
          return [...one, ...n.list({ limit: 1, after: one[0]! })].map((r) => r.id)
        })
        assert.deepStrictEqual(firstTwo, expected({}).slice(0, 2))
        // A row of another query, of another collection, or a copy: invalid.
        const plain = (yield* c.list({ limit: 1 }))[0]!
        assert.strictEqual(reasonOf(yield* Effect.exit(c.list({ where: { tag: "a" }, after: plain }))), "invalid")
        assert.strictEqual(reasonOf(yield* Effect.exit(c.list({ orderBy: { field: "createdAt" }, after: plain }))), "invalid")
        assert.strictEqual(reasonOf(yield* Effect.exit(c.list({ after: { ...plain } }))), "invalid")
        const other = kit.collection(constructorCollection)
        yield* other.insert({ text: "o" })
        const otherRow = (yield* other.list())[0]!
        assert.strictEqual(reasonOf(yield* Effect.exit(c.list({ after: otherRow }))), "invalid")
      }).pipe(Effect.scoped))

    it.effect("hooks, updaters and migrations that return a promise: never awaited, and a rejection is observed (no unhandled rejection)", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        const unhandled: Array<unknown> = []
        const onUnhandled = (e: unknown) => void unhandled.push(e)
        process.on("unhandledRejection", onUnhandled)
        try {
          const row = yield* c.insert({ text: "a" })
          yield* kit.transaction((tx) => tx.afterCommit(async () => {
            throw new Error("after-commit hook failed")
          }))
          yield* store.afterCommit(async () => {
            throw new Error("host hook failed")
          })
          yield* Effect.exit(kit.transaction((tx) => {
            tx.onRollback(async () => {
              throw new Error("rollback hook failed")
            })
            throw new Error("roll back")
          }))
          const updated = yield* Effect.exit(c.update(row.id, (async () => {
            throw new Error("updater failed")
          }) as unknown as (v: Note) => Note))
          assert.strictEqual(reasonOf(updated), "invalid")
          assert.strictEqual((yield* c.get(row.id))?.value.text, "a")
          const v1 = defineCollection({ name: "later", scope: "household", schema: Note })
          const v2 = defineCollection({
            name: "later",
            scope: "household",
            schema: Note,
            migrate: { 1: async () => Promise.reject(new Error("migration failed")) }
          })
          yield* store.prepare([{ id: "mig", storage: { collections: [v1] } }])
          yield* store.forModule("mig").collection(v1).insert({ text: "x" })
          yield* store.prepare([{ id: "mig", storage: { version: 2, collections: [v2] } }])
          assert.match(store.availability("mig")?.reason ?? "", /could not be upgraded/)
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)))
        } finally {
          process.off("unhandledRejection", onUnhandled)
        }
        assert.deepStrictEqual(unhandled, [])
      }).pipe(Effect.scoped))

    it.effect("no storage at all is an empty declaration at version 1: newer stored data makes the module unavailable, and nothing is written for it", () =>
      Effect.gen(function*() {
        const a = defineCollection({ name: "a", scope: "household", schema: Note })
        const store = yield* make()
        yield* store.prepare([{ id: "m", storage: { version: 2, collections: [a] } }])
        yield* store.forModule("m").collection(a).insert({ text: "kept" }, { id: "k" })
        yield* store.prepare([{ id: "m", storage: undefined }, { id: "plain", storage: undefined }])
        assert.match(store.availability("m")?.reason ?? "", /newer version/)
        assert.strictEqual(reasonOf(yield* Effect.exit(store.forModule("m").transaction(() => 1))), "unavailable")
        assert.strictEqual(store.availability("plain"), undefined)
        assert.deepStrictEqual(store.undeclared().map((u) => u.owner), ["m"])
        yield* store.prepare([{ id: "m", storage: { version: 2, collections: [a] } }])
        assert.strictEqual((yield* store.forModule("m").collection(a).get("k"))?.value.text, "kept")
      }).pipe(Effect.scoped))

    it.effect("a row's own names (updatedAt, createdAt, id, rev, scope) cannot be indexed: refused where the collection is defined", () =>
      Effect.sync(() => {
        const Schedule = Schema.Struct({ state: Schema.String, updatedAt: Schema.Finite })
        assert.deepStrictEqual([...RESERVED_FIELDS].sort(), ["createdAt", "id", "rev", "scope", "updatedAt"])
        for (const field of RESERVED_FIELDS) {
          for (const indexes of [[field], [["state", field] as const], [[field, "state"] as const]]) {
            assert.throws(() => defineCollection({ name: "x", scope: "household", schema: Schedule, indexes }), /row's own field/, `${JSON.stringify(indexes)}`)
          }
        }
      }))

    it.effect("ids: get, update, remove and insert validate a row id the same way (invalid), through every handle", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const kit = store.forModule("kit")
        const c = kit.collection(notes)
        for (const id of ["bad/id", "", "x".repeat(201), "a\ud800", "a\u0000"]) {
          assert.strictEqual(reasonOf(yield* Effect.exit(c.get(id))), "invalid", `get ${JSON.stringify(id)}`)
          assert.strictEqual(reasonOf(yield* Effect.exit(c.update(id, (v) => v))), "invalid", `update ${JSON.stringify(id)}`)
          assert.strictEqual(reasonOf(yield* Effect.exit(c.remove(id))), "invalid", `remove ${JSON.stringify(id)}`)
          assert.strictEqual(reasonOf(yield* Effect.exit(c.insert({ text: "x" }, { id }))), "invalid", `insert ${JSON.stringify(id)}`)
          const inTx = yield* kit.transaction((tx) => [
            captureThrow(() => tx.collection(notes).get(id)),
            captureThrow(() => tx.collection(notes).update(id, (v) => v)),
            captureThrow(() => tx.collection(notes).remove(id))
          ].map((e) => (e as StoreError | undefined)?.reason))
          assert.deepStrictEqual(inTx, ["invalid", "invalid", "invalid"])
          assert.strictEqual((captureThrow(() => store.reader("kit", notes)!.get(id, { kind: "household" })) as StoreError | undefined)?.reason, "invalid")
        }
      }).pipe(Effect.scoped))

    it.effect("an actor is checked before it is stored: a known kind with its fields, a finite turn id", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        for (const actor of [
          { kind: "turn", turnId: Number.NaN, conversationId: "c", source: "voice" },
          { kind: "turn", turnId: Number.POSITIVE_INFINITY, conversationId: "c", source: "voice" },
          { kind: "turn", turnId: 1, source: "voice" },
          { kind: "turn", turnId: 1, conversationId: "c", source: "voice", personId: 5 },
          { kind: "job" },
          { kind: "ui", deviceId: 3 },
          { kind: "nobody" },
          { kind: "admin", extra: "x" },
          null,
          "admin"
        ]) {
          assert.strictEqual(reasonOf(yield* Effect.exit(c.insert({ text: "x" }, { actor: actor as never }))), "invalid", JSON.stringify(actor))
        }
        const row = yield* c.insert({ text: "x" }, { actor: { kind: "job", jobId: "j1" } })
        assert.deepStrictEqual(row.updatedBy, { kind: "job", jobId: "j1" })
        const turn = yield* c.insert({ text: "y" }, { actor: { kind: "turn", turnId: 7, conversationId: "c", source: "voice", personId: "sam" } })
        assert.deepStrictEqual(turn.updatedBy, { kind: "turn", turnId: 7, conversationId: "c", source: "voice", personId: "sam" })
      }).pipe(Effect.scoped))

    it.effect("a read-only store reads, refuses every write and makes no backup; a collection the server never prepared reads as empty", () =>
      Effect.gen(function*() {
        const store = yield* make({ readOnly: true })
        yield* store.prepare([KIT], [SCHEDULER])
        const c = store.forModule("kit").collection(notes)
        assert.deepStrictEqual(yield* c.list(), [])
        assert.deepStrictEqual(yield* c.list({ where: { tag: "a" }, orderBy: { field: "n" } }), [])
        assert.strictEqual(yield* c.get("x"), undefined)
        assert.strictEqual(reasonOf(yield* Effect.exit(c.insert({ text: "x" }))), "read-only")
        const tx = yield* Effect.exit(store.forModule("kit").transaction((t) => t.collection(notes).insert({ text: "x" })))
        assert.strictEqual(reasonOf(tx), "read-only")
        assert.strictEqual(reasonOf(yield* Effect.exit(store.backup())), "unavailable")
        assert.strictEqual(yield* store.endConversation("conv-1"), 0)
      }).pipe(Effect.scoped))
  })

/** What a call threw (or `undefined`). */
const captureThrow = (f: () => unknown): unknown => {
  try {
    f()
    return undefined
  } catch (e) {
    return e
  }
}

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
