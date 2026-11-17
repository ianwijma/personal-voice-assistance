/**
 * The contract every `HouseholdStore` passes (`@pva/core/store-contract`): the in-memory double
 * (`makeMemoryHouseholdStore`) and the SQLite store run the same tests, so a module tested on the double behaves the
 * same on the real store. Test-only: imports vitest.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema, type Scope } from "effect"
import { connectStoreToBus, defineEventType, makeEventBus } from "./EventBus.ts"
import { makeHouseholdFeed } from "./HouseholdFeed.ts"
import {
  type Actor,
  type Collection,
  defineCollection,
  type HouseholdStore,
  type ModuleStorage,
  type Row,
  StoreError
} from "./HouseholdStore.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

export const Note = Schema.Struct({ text: Schema.String, tag: Schema.optionalKey(Schema.String), n: Schema.optionalKey(Schema.Finite), done: Schema.optionalKey(Schema.Boolean) })
export type Note = typeof Note.Type

export const notes = defineCollection({ name: "notes", scope: "household", schema: Note, indexes: ["tag", "n", "done"], search: ["text"] })
export const mine = defineCollection({ name: "mine", scope: "person", schema: Note })
export const dev = defineCollection({ name: "dev", scope: "device", schema: Note })
export const chat = defineCollection({ name: "chat", scope: "conversation", schema: Note })
export const forgettable = defineCollection({ name: "forgettable", scope: "household", schema: Note, history: "none", search: ["text"] })
/** Shown on every page whose device is the row's `tag`; hidden elsewhere. */
export const shown = defineCollection({
  name: "shown",
  scope: "household",
  schema: Note,
  project: (row: Row<Note>, device) => (row.value.tag === undefined || row.value.tag === device.id ? { text: row.value.text } : undefined)
})

export const KIT: { readonly id: string; readonly storage: ModuleStorage } = {
  id: "kit",
  storage: { collections: [notes, mine, dev, chat, forgettable, shown] }
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

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: E } | undefined)?.error : undefined)

export const householdStoreContract = (name: string, make: MakeStore) =>
  describe(`HouseholdStore contract: ${name}`, () => {
    it.effect("insert, get and list in the household scope; rev and actor", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        const row = yield* c.insert({ text: "milk", tag: "shop" }).pipe(inTurn(turnOf({ person: { id: "sam", how: "device-default" } })))
        assert.strictEqual(row.rev, 1)
        assert.deepStrictEqual(row.scope, { kind: "household" })
        assert.strictEqual(row.updatedBy.kind, "turn")
        assert.strictEqual((row.updatedBy as Extract<Actor, { kind: "turn" }>).personId, "sam")
        const got = yield* c.get(row.id)
        assert.deepStrictEqual(got?.value, { text: "milk", tag: "shop" })
        assert.strictEqual((yield* c.list()).length, 1)
        // An id in use is a conflict; a bad id is invalid; a value that does not match the schema is invalid.
        const again = yield* Effect.exit(c.insert({ text: "x" }, { id: row.id }))
        assert.strictEqual((failureOf(again) as { _tag: string })._tag, "StoreConflict")
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
        assert.strictEqual((failureOf(noTurn) as { _tag: string })._tag, "ScopeUnknown")
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

    it.effect("list filters on declared indexes, orders and limits", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        for (const [i, tag] of ["a", "b", "a", "a", "b"].entries()) yield* c.insert({ text: `t${i}`, tag, n: 10 - i, done: i % 2 === 0 })
        assert.strictEqual((yield* c.list({ where: { tag: "a" } })).length, 3)
        assert.strictEqual((yield* c.list({ where: { tag: "a", done: true } })).length, 2)
        assert.strictEqual((yield* c.list({ where: { done: false } })).length, 2)
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "n" }, limit: 2 })).map((r) => r.value.n), [6, 7])
        assert.deepStrictEqual((yield* c.list({ orderBy: { field: "n", direction: "desc" }, limit: 2 })).map((r) => r.value.n), [10, 9])
        const unindexed = yield* Effect.exit(c.list({ where: { text: "t1" } as never }))
        assert.strictEqual((failureOf(unindexed) as StoreError).reason, "invalid")
        const found = yield* c.search("T3")
        assert.deepStrictEqual(found.map((r) => r.value.text), ["t3"])
      }).pipe(Effect.scoped))

    it.effect("optimistic updates: rev moves, expectRev conflicts, concurrent updates all land or conflict", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        const row = yield* c.insert({ text: "counter", n: 0 })
        const next = yield* c.update(row.id, (v) => ({ ...v, n: (v.n ?? 0) + 1 }))
        assert.strictEqual(next.rev, 2)
        const stale = yield* Effect.exit(c.update(row.id, (v) => v, { expectRev: 1 }))
        assert.strictEqual((failureOf(stale) as { _tag: string })._tag, "StoreConflict")
        const missing = yield* Effect.exit(c.update("nope", (v) => v))
        assert.strictEqual((failureOf(missing) as { _tag: string })._tag, "StoreNotFound")
        const exits = yield* Effect.forEach(
          Array.from({ length: 8 }, () => 0),
          () => Effect.exit(c.update(row.id, (v) => ({ ...v, n: (v.n ?? 0) + 1 }))),
          { concurrency: "unbounded" }
        )
        const ok = exits.filter(Exit.isSuccess).length
        for (const e of exits) if (Exit.isFailure(e)) assert.strictEqual((failureOf(e) as { _tag: string })._tag, "StoreConflict")
        const final = yield* c.get(row.id)
        assert.strictEqual(final?.value.n, 1 + ok)
        assert.strictEqual(final?.rev, 2 + ok)
        assert.isTrue(ok >= 1)
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
        const texts = (yield* c.list({ limit: 10 })).map((r) => r.value.text).sort()
        assert.deepStrictEqual(texts, ["kept", "p", "q"])
        assert.deepStrictEqual(heard.slice(5), ["insert:6"])
      }).pipe(Effect.scoped))

    it.effect("undo: the last change of an actor in a collection, insert, update and remove; not someone else's", () =>
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
        assert.strictEqual((failureOf(conflict) as { _tag: string })._tag, "StoreConflict")
        assert.strictEqual((yield* c.get(third.id))?.value.text, "bread x2")
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

    it.effect("erase removes the row, every earlier payload of it and its search entries", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const c = store.forModule("kit").collection(notes)
        const row = yield* c.insert({ text: "sam's surprise party on friday" })
        yield* c.update(row.id, (v) => ({ ...v, text: "sam's surprise party on saturday" }))
        const keep = yield* c.insert({ text: "party hats" })
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
        // Nothing to undo of it.
        assert.strictEqual((yield* c.undo())?.id, keep.id)
        assert.strictEqual(yield* c.undo(), undefined)
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

    it.effect("collection versions: lazy migration on read; data from a newer version makes the module unavailable", () =>
      Effect.gen(function*() {
        const v1 = defineCollection({ name: "items", scope: "household", schema: Schema.Struct({ label: Schema.String }) })
        const v2 = defineCollection({
          name: "items",
          scope: "household",
          version: 2,
          schema: Schema.Struct({ label: Schema.String, qty: Schema.Finite }),
          migrate: { 1: (old: { label: string }) => ({ ...old, qty: 1 }) }
        })
        const store = yield* make()
        yield* store.prepare([{ id: "shop", storage: { collections: [v1] } }])
        const row = yield* store.forModule("shop").collection(v1).insert({ label: "milk" })
        yield* store.prepare([{ id: "shop", storage: { collections: [v2] } }])
        assert.strictEqual(store.availability("shop"), undefined)
        const read = yield* store.forModule("shop").collection(v2).get(row.id)
        assert.deepStrictEqual(read?.value, { label: "milk", qty: 1 })
        // The older module again: refused, with a reason; never opened and rewritten.
        yield* store.prepare([{ id: "shop", storage: { collections: [v1] } }])
        const verdict = store.availability("shop")
        assert.isDefined(verdict)
        assert.match(verdict!.reason, /newer version/)
      }).pipe(Effect.scoped))

    it.effect("pages: a collection without a projection is never sent; a projection shows a row to one device and hides it from another on every path", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const bus = makeEventBus()
        connectStoreToBus(store, bus)
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: KIT.storage.collections ?? [], events: [] }] })
        const kitchen = { id: "kitchen-01" }
        const study = { id: "study-001" }
        const kit = store.forModule("kit")
        const live: Array<{ device: string; type: string; data: unknown }> = []
        store.onCommit((changes) => {
          for (const ch of changes) {
            for (const d of [kitchen, study]) {
              const info = feed.live({ seq: ch.seq, at: ch.at, module: ch.module, type: `${ch.module}.${ch.collection}.changed`, scope: ch.scope, data: null, change: ch }, d)
              if (info !== undefined) live.push({ device: d.id, type: info.type, data: info.data })
            }
          }
        })
        const before = yield* store.lastSeq
        yield* kit.collection(notes).insert({ text: "never sent" })
        const forKitchen = yield* kit.collection(shown).insert({ text: "alarm: wake Sam", tag: "kitchen-01" })
        yield* kit.collection(shown).insert({ text: "for everyone" })
        // Live: the kitchen sees both, the study only the shared one; nothing of `notes`.
        assert.deepStrictEqual(live.filter((l) => l.device === "kitchen-01").length, 2)
        assert.deepStrictEqual(live.filter((l) => l.device === "study-001").map((l) => (l.data as { value: unknown }).value), [{ text: "for everyone" }])
        assert.isFalse(live.some((l) => l.type === "kit.notes.changed"))
        // Snapshot.
        const snapK = yield* feed.snapshot(kitchen)
        const snapS = yield* feed.snapshot(study)
        assert.deepStrictEqual(snapK.collections.map((x) => x.collection), ["shown"])
        assert.strictEqual(snapK.collections[0]!.rows.length, 2)
        assert.deepStrictEqual(snapS.collections[0]!.rows.map((r) => r.value), [{ text: "for everyone" }])
        // Replay from before the writes.
        const replayK = yield* feed.replay(kitchen, before)
        const replayS = yield* feed.replay(study, before)
        assert.strictEqual(replayK.kind, "events")
        assert.strictEqual(replayK.kind === "events" ? replayK.events.length : -1, 2)
        assert.deepStrictEqual(replayS.kind === "events" ? replayS.events.map((e) => (e.data as { value: unknown }).value) : [], [{ text: "for everyone" }])
        // The row moves to the study: the kitchen is told it is gone (it could see it), the study gets it; a replay
        // gives the same, with today's value only.
        const mid = yield* store.lastSeq
        live.length = 0
        yield* kit.collection(shown).update(forKitchen.id, (v) => ({ ...v, text: "alarm: study", tag: "study-001" }))
        assert.deepStrictEqual(live.map((l) => [l.device, (l.data as { op: string }).op]), [["kitchen-01", "remove"], ["study-001", "put"]])
        const again = yield* feed.replay(kitchen, mid)
        assert.deepStrictEqual(again.kind === "events" ? again.events.map((e) => (e.data as { op: string }).op) : [], ["remove"])
        const fromStart = yield* feed.replay(kitchen, before)
        assert.isFalse(JSON.stringify(fromStart).includes("wake Sam"))
        assert.isFalse(JSON.stringify(fromStart).includes("alarm: study"))
        // A page from a newer database (its seq is ahead) gets a snapshot.
        const ahead = yield* feed.replay(kitchen, 10_000)
        assert.strictEqual(ahead.kind, "snapshot")
      }).pipe(Effect.scoped))

    it.effect("module events reach pages only through a declared projection", () =>
      Effect.gen(function*() {
        const store = yield* prepared(make)
        const ring = defineEventType({ type: "alarm.ringing", project: (e, device) => ((e.data as { device: string }).device === device.id ? { label: "Wake up" } : undefined) })
        const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "kit", collections: [], events: [ring] }] })
        const event = { at: 1, module: "kit", type: "kit.alarm.ringing", scope: { kind: "household" as const }, data: { device: "kitchen-01" } }
        assert.deepStrictEqual(feed.live(event, { id: "kitchen-01" })?.data, { label: "Wake up" })
        assert.strictEqual(feed.live(event, { id: "study-001" }), undefined)
        assert.strictEqual(feed.live({ ...event, type: "kit.other" }, { id: "kitchen-01" }), undefined)
        // Person-scoped events are withheld from every page until Privacy.mayReveal exists.
        assert.strictEqual(feed.live({ ...event, scope: { kind: "person", id: "sam" } }, { id: "kitchen-01" }), undefined)
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
