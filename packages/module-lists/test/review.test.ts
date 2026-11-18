// What the review of the first version found (docs/modules/lists.md, "Review"), one test or more per finding: races
// with the daily clean-up and between devices, how quantities are read and merged, undo, matching, unknown and "my"
// lists, the list catalogue's bounds, paging, cut-short searches, the job's actor, and a store that is busy or fails.
// Competing writes are made through the store underneath the module (a test's own wrapper), between the module's read
// and its write, so each test sees what the module decides inside its transaction.
import { assert, describe, it } from "@effect/vitest"
import { isModuleStopped, type ModuleStore, type Row, StoreError, type StoreFailure } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Lists, ListsError, type ListsService } from "@pva/module-contracts"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { type Item, items, type ListRow, lists, listsModule, undo } from "../src/index.ts"
import { withStatus } from "../src/data.ts"

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)
const spoken = (r: { readonly value: unknown }) => (r.value as { readonly spoken?: string }).spoken ?? r.value
const HOUR = 3_600_000

/** What a test does between the module's reads and its writes, through the store underneath it. */
interface Hooks {
  afterList?: ((collection: string, query: any, rows: ReadonlyArray<Row<any>>, raw: ModuleStore) => Effect.Effect<void>) | undefined
  afterGet?: ((collection: string, id: string, raw: ModuleStore) => Effect.Effect<void>) | undefined
  beforeTransaction?: ((raw: ModuleStore) => Effect.Effect<void>) | undefined
  /** Every transaction fails with this, writing nothing (a busy store). */
  transactionFails?: StoreFailure | undefined
  /** A list row's update inside a transaction throws this: a failure after the item was written. */
  listUpdateThrows?: StoreFailure | undefined
}

const hookStore = (raw: ModuleStore, hooks: Hooks): ModuleStore => ({
  moduleId: raw.moduleId,
  readOnly: raw.readOnly,
  collection: (c) => {
    const h = raw.collection(c)
    return {
      ...h,
      list: (q) => Effect.tap(h.list(q), (rows) => hooks.afterList?.(c.name, q, rows, raw) ?? Effect.void),
      get: (id, o) => Effect.tap(h.get(id, o), () => hooks.afterGet?.(c.name, id, raw) ?? Effect.void)
    }
  },
  transaction: (f) =>
    Effect.suspend(() => {
      if (hooks.transactionFails !== undefined) return Effect.fail(hooks.transactionFails)
      const throwing = hooks.listUpdateThrows
      return Effect.andThen(
        hooks.beforeTransaction?.(raw) ?? Effect.void,
        raw.transaction((tx) =>
          f(throwing === undefined ? tx : {
            ...tx,
            collection: (c: any) => {
              const t = tx.collection(c)
              return c.name === "lists" ? { ...t, update: () => {
                throw throwing
              } } : t
            }
          } as typeof tx)
        )
      )
    })
})

/** The module with its store wrapped by the test's hooks. */
const hooked = (hooks: Hooks): typeof listsModule => ({ ...listsModule, shared: (ctx) => listsModule.shared!({ ...ctx, store: hookStore(ctx.store, hooks) }) })

/** A list's stored counts. */
const counts = (kit: { moduleStore: () => ModuleStore }, id: string) =>
  Effect.map(kit.moduleStore().collection(lists).get(id), (r) => (r === undefined ? undefined : { open: r.value.open, done: r.value.done }))

const allItems = (kit: { moduleStore: () => ModuleStore }) => kit.moduleStore().collection(items).list({ limit: 16 })

describe("finding 1: 'my list' goes on the household's list, and the answer says so", () => {
  it.effect("on the public hall screen, through the typed action and the model's tool, in English and Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const hall = { device: "hall-screen" }
      assert.strictEqual(said(yield* kit.action("add", { items: "call the plumber to my to-do list" }, hall)), "Added call the plumber to the household's to-do list, which everyone here can see.")
      const tool = yield* kit.tool("lists_add", { items: "milk", list: "my shopping list" }, hall)
      assert.strictEqual(tool.value, "Added milk to the household's shopping list, which everyone here can see.")
      // Without "my", the ordinary answer.
      assert.strictEqual(said(yield* kit.action("add", { items: "bread to the shopping list" }, hall)), "Added bread to the shopping list.")
      // Household rows, the same from every device.
      const rows = yield* allItems(kit)
      assert.sameMembers(rows.map((r) => `${r.value.list}:${r.value.text}`), ["todo:call the plumber", "shopping:milk", "shopping:bread"])
      assert.strictEqual(said(yield* kit.action("read", {}, { device: "robins-phone" })), "The shopping list has 2 things: milk and bread.")

      const nl = yield* startTestModule(listsModule, {
        household: {
          home: { HOME_LANGUAGE: "nl-NL" },
          devices: [{ id: "porch-screen", name: "Porch screen", privacy: "public", defaultPerson: "p-alex" }]
        }
      })
      assert.strictEqual(said(yield* nl.action("add", { items: "melk op mijn boodschappenlijst" }, { device: "porch-screen" })), "Melk op de boodschappenlijst van het huishouden gezet, die iedereen hier kan zien.")
      assert.strictEqual(spoken(yield* nl.tool("lists_add", { items: "loodgieter bellen", list: "mijn takenlijst" }, { device: "porch-screen" })), "Loodgieter bellen op de takenlijst van het huishouden gezet, die iedereen hier kan zien.")
    }))
})

describe("finding 2 and 16: the nightly clean-up decides inside its transaction, as the job", () => {
  it.effect("an item reopened, or a ticked-off one changed, between its read and its write stays, with its counts", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(hooked(hooks), { settings: { keepDoneShoppingHours: 1 } })
      yield* kit.action("add", { items: "milk and bread" })
      yield* kit.action("complete", { item: "milk and bread" })
      yield* kit.advance(2 * HOUR)
      const now = yield* kit.now
      hooks.afterList = (name, q, rows, raw) => {
        if (name !== "items" || q?.where?.place !== "shopping:done" || rows.length < 2) return Effect.void
        hooks.afterList = undefined
        // Someone reopens milk on a phone, and someone notes which bread, while the job is between read and write.
        return raw.transaction((tx) => {
          const milk = rows.find((r) => r.value.text === "milk")!
          const bread = rows.find((r) => r.value.text === "bread")!
          tx.collection(items).update(milk.id, (v) => withStatus(v, "open", now))
          tx.collection(lists).update("shopping", (v) => ({ ...v, open: v.open + 1, done: v.done - 1 }))
          tx.collection(items).update(bread.id, (v) => ({ ...v, note: "the brown one" }))
        }).pipe(Effect.orDie)
      }
      const job = (yield* kit.jobs).find((j) => j.handler === "tidy")!
      yield* kit.runJob(job.id)
      assert.isUndefined(hooks.afterList, "the hook ran")
      assert.sameMembers((yield* allItems(kit)).map((r) => `${r.value.text}:${r.value.status}`), ["milk:open", "bread:done"])
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 1, done: 1 })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has one thing: milk.")
      // The next night nothing changed it: bread goes, as the job, the list's counts too.
      yield* kit.runJob(job.id)
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 1, done: 0 })
      const listRow = yield* kit.moduleStore().collection(lists).get("shopping")
      assert.deepStrictEqual(listRow?.updatedBy, { kind: "job", jobId: job.id })
      const changes = kit.events.filter((e) => e.type === "lists.lists.changed" || e.type === "lists.items.changed")
      assert.deepStrictEqual(changes.at(-1)?.actor, { kind: "job", jobId: job.id })
      assert.isTrue(changes.some((e) => e.type === "lists.items.changed" && e.actor?.kind === "job"))
    }))
})

describe("finding 6: the clean-up keeps an undo entry replaced since it read it", () => {
  it.effect("an expired entry made new between the job's read and its delete is still there to undo", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(hooked(hooks))
      yield* kit.action("add", { items: "rice" })
      // 25 hours on (the 04:15 run in between found the entry 18 hours old and kept it).
      yield* kit.advance(25 * HOUR)
      const now = yield* kit.now
      hooks.afterList = (name, _q, rows, raw) => {
        if (name !== "undo" || rows.length === 0) return Effect.void
        hooks.afterList = undefined
        return raw.transaction((tx) => void tx.collection(undo).update(rows[0]!.id, (v) => ({ ...v, at: now }))).pipe(Effect.orDie)
      }
      yield* kit.runJob((yield* kit.jobs).find((j) => j.handler === "tidy")!.id)
      assert.isUndefined(hooks.afterList, "the hook ran")
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone: the shopping list is as it was.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list is empty.")
    }))
})

describe("finding 3, 4, 7, 8: quantities", () => {
  it.effect("the same thing twice in one request is one item with the amounts added; with merging off, two", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      assert.strictEqual(said(yield* kit.action("add", { items: "two litres of milk and 500 ml of milk" })), "Added 2.5 litres of milk to the shopping list.")
      assert.strictEqual(said(yield* kit.action("add", { items: "eggs and eggs" })), "Added eggs to the shopping list.")
      assert.sameMembers((yield* allItems(kit)).map((r) => `${r.value.text}:${JSON.stringify(r.value.quantity ?? null)}`), ["milk:{\"amount\":2.5,\"unit\":\"l\"}", "eggs:null"])
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 2, done: 0 })
      // Another kind of unit in the same request: a second item of the same name, with its own amount.
      assert.strictEqual(said(yield* kit.action("add", { items: "1 kilo of flour and a bag of flour" })), "Added 1 kilogram of flour and a bag of flour to the shopping list.")
      const plain = yield* startTestModule(listsModule, { settings: { mergeDuplicates: false } })
      assert.strictEqual(said(yield* plain.action("add", { items: "milk and milk" })), "Added milk and milk to the shopping list.")
      assert.strictEqual(said(yield* plain.action("read", {})), "The shopping list has 2 things: milk and milk.")
    }))

  it.effect("a decimal comma, 'two and a half' and number conjunctions are one amount; ordinary 'and' still splits", () =>
    Effect.gen(function*() {
      const nl = yield* startTestModule(listsModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* nl.action("add", { items: "1,5 liter melk en brood" })
      yield* nl.action("add", { items: "twee en een halve kilo aardappelen" })
      assert.sameMembers((yield* allItems(nl)).map((r) => `${r.value.text}:${JSON.stringify(r.value.quantity ?? null)}`), [
        "melk:{\"amount\":1.5,\"unit\":\"l\"}",
        "brood:null",
        "aardappelen:{\"amount\":2.5,\"unit\":\"kg\"}"
      ])
      const en = yield* startTestModule(listsModule)
      assert.strictEqual(said(yield* en.action("add", { items: "two and a half litres of milk" })), "Added 2.5 litres of milk to the shopping list.")
      assert.strictEqual(said(yield* en.action("add", { items: "one hundred and twenty grams of flour, eggs and salt and pepper crisps" })), "Added 120 grams of flour, eggs and salt and pepper crisps to the shopping list.")
      assert.strictEqual(said(yield* en.action("add", { items: "3 lemons and bread" })), "Added 3 lemons and bread to the shopping list.")
    }))

  it.effect("an amount in another kind of unit is a second item, said and read back, never hidden in a note", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "a kilo of flour" })
      assert.strictEqual(said(yield* kit.action("add", { items: "a bag of flour" })), "Added a bag of flour to the shopping list.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: 1 kilogram of flour and a bag of flour.")
      // A later amount that converts goes to the item it can be added to.
      assert.strictEqual(said(yield* kit.action("add", { items: "500 grams of flour" })), "Added 1.5 kilograms of flour to the shopping list.")
      assert.isTrue((yield* allItems(kit)).every((r) => r.value.note === undefined))
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 2, done: 0 })
      // Undone: the bag goes, the kilo is a kilo again.
      yield* kit.action("add", { items: "a bag of flour" })
      yield* kit.action("undo", {})
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: 1.5 kilograms of flour and a bag of flour.")
    }))

  it.effect("a full note never turns an addition into 'already there'", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.asTurn(kit.service(Lists)!.addItem({ text: "flour", quantity: { amount: 1, unit: "kg" }, note: "n".repeat(200), dedupeKey: "kitchen:flour" }))
      assert.strictEqual(said(yield* kit.action("add", { items: "a bag of flour" })), "Added a bag of flour to the shopping list.")
      assert.strictEqual((yield* allItems(kit)).length, 2)
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 2, done: 0 })
    }))
})

describe("finding 5: undo of a reopening restores exactly what was there", () => {
  it.effect("no amount before: none after; an amount and a note before: both after; the counts back", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "milk" })
      yield* kit.action("complete", { item: "milk" })
      assert.strictEqual(said(yield* kit.action("add", { items: "3 litres of milk" })), "Added 3 litres of milk to the shopping list.")
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone: the shopping list is as it was.")
      const [milk] = yield* allItems(kit)
      assert.strictEqual(milk?.value.status, "done")
      assert.isUndefined(milk?.value.quantity)
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 0, done: 1 })

      const other = yield* startTestModule(listsModule)
      yield* other.asTurn(other.service(Lists)!.addItem({ text: "milk", quantity: { amount: 2, unit: "l" }, note: "barista" }))
      yield* other.action("complete", { item: "milk" })
      yield* other.action("add", { items: "3 litres of milk" })
      yield* other.action("undo", {})
      const [again] = yield* allItems(other)
      assert.strictEqual(again?.value.status, "done")
      assert.deepStrictEqual(again?.value.quantity, { amount: 2, unit: "l" })
      assert.strictEqual(again?.value.note, "barista")
      assert.deepStrictEqual(yield* counts(other, "shopping"), { open: 0, done: 1 })
    }))
})

describe("finding 9: matching by name finds an open item first", () => {
  it.effect("32 ticked-off items of the same name, older and newer, do not hide the open one, for adding or removing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const lists_ = kit.service(Lists)!
      const call = <A>(f: (s: ListsService) => Effect.Effect<A, ListsError>) => kit.asTurn(f(lists_))
      // 16 ticked off before it and 16 after, a second apart: a page of 16 in either order holds no open one.
      const done = (i: number) =>
        Effect.gen(function*() {
          yield* call((s) => s.addItem({ text: "milk", dedupeKey: `k:done${i}` }))
          yield* call((s) => s.completeByKey(`k:done${i}`))
          yield* kit.advance(1_000)
        })
      for (let i = 0; i < 16; i++) yield* done(i)
      yield* call((s) => s.addItem({ text: "milk", dedupeKey: "k:old" }))
      yield* kit.advance(1_000)
      for (let i = 16; i < 32; i++) yield* done(i)
      assert.strictEqual(said(yield* kit.action("add", { items: "milk" })), "The shopping list already has milk.")
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 1, done: 32 })
      assert.strictEqual(said(yield* kit.action("remove", { item: "milk" })), "Took milk off the shopping list.")
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 0, done: 32 })
      assert.isUndefined(yield* call((s) => s.find("k:old")))
    }))
})

describe("finding 10: a list that does not exist", () => {
  it.effect("is refused in the household's language with the lists there are, and nothing is written", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      assert.strictEqual(said(yield* kit.action("add", { items: "tent to the camping list" })), "There's no list called camping. The lists are the shopping list and the to-do list.")
      assert.strictEqual(said(yield* kit.action("complete", { item: "tent off the camping list" })), "There's no list called camping. The lists are the shopping list and the to-do list.")
      // "to" inside an item is not a list.
      assert.strictEqual(said(yield* kit.action("add", { items: "remember to write the shopping list" })), "Added remember to write the shopping list to the shopping list.")
      const nl = yield* startTestModule(listsModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(said(yield* nl.action("add", { items: "tent op de kampeerlijst" })), "Er is geen lijst die kampeerlijst heet. De lijsten zijn de boodschappenlijst en de takenlijst.")
      assert.deepStrictEqual(yield* allItems(nl), [])
      assert.strictEqual((yield* allItems(kit)).length, 1)
    }))
})

describe("finding 11: the default lists exist from the start and count toward the bound", () => {
  it.effect("their rows are there at once; deleted lists waiting for undo never push a live list out of the catalogue", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      assert.sameMembers((yield* kit.moduleStore().collection(lists).list({})).map((r) => r.id), ["shopping", "todo"])
      for (let i = 0; i < 28; i++) yield* kit.tool("lists_create", { name: `Old ${i}` }, { conversationId: `c-${i}` })
      for (let i = 0; i < 22; i++) yield* kit.tool("lists_delete", { list: `Old ${i}` }, { conversationId: `d-${i}` })
      const made: Array<unknown> = []
      for (let i = 0; i < 22; i++) made.push(spoken(yield* kit.tool("lists_create", { name: `New ${i}` }, { conversationId: `e-${i}` })))
      // 2 + 28 + 20 rows: the last two are refused.
      assert.deepStrictEqual(made.slice(-2), ["There are 30 lists already; delete one first.", "There are 30 lists already; delete one first."])
      assert.strictEqual((yield* kit.moduleStore().collection(lists).list({ limit: 100 })).length, 50)
      yield* kit.action("add", { items: "milk" })
      yield* kit.action("add", { items: "call the plumber", list: "to do" })
      assert.match(String(said(yield* kit.action("overview", {}))), /^There are 28 lists: /)
      assert.strictEqual(said(yield* kit.action("read", { list: "Old 27" })), "The Old 27 list is empty.")
      assert.strictEqual(said(yield* kit.action("read", { list: "New 19" })), "The New 19 list is empty.")
    }))
})

describe("finding 12: a list's name and the limits are decided inside the transaction that makes it", () => {
  it.effect("a list of the same name made in between is not made twice; nor is the 31st list", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(hooked(hooks))
      const insertList = (name: string) => (raw: ModuleStore) => {
        hooks.beforeTransaction = undefined
        return raw.transaction((tx) => void tx.collection(lists).insert({ name, kind: "generic", open: 0, done: 0 } satisfies ListRow)).pipe(Effect.orDie)
      }
      hooks.beforeTransaction = insertList("Camping")
      assert.strictEqual(spoken(yield* kit.tool("lists_create", { name: "Camping" })), "There's already a list called Camping.")
      assert.strictEqual((yield* kit.moduleStore().collection(lists).list({})).filter((r) => r.value.name === "Camping").length, 1)
      for (let i = 0; i < 26; i++) yield* kit.tool("lists_create", { name: `List ${i}` })
      hooks.beforeTransaction = insertList("Intruder")
      assert.strictEqual(spoken(yield* kit.tool("lists_create", { name: "Last" })), "There are 30 lists already; delete one first.")
      const live = (yield* kit.moduleStore().collection(lists).list({ limit: 100 })).filter((r) => r.value.deletedAt === undefined)
      assert.strictEqual(live.length, 30)
    }))
})

describe("finding 13: a read takes its count and items from one state", () => {
  it.effect("an add from another device during a read waits for it", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(hooked(hooks))
      yield* kit.action("add", { items: "rice" })
      const reached = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      hooks.afterGet = (name, id) => {
        if (name !== "lists" || id !== "shopping") return Effect.void
        hooks.afterGet = undefined
        return Effect.andThen(Deferred.succeed(reached, undefined), Deferred.await(release))
      }
      const reading = yield* Effect.forkChild(kit.action("read", {}))
      yield* Deferred.await(reached)
      const adding = yield* Effect.forkChild(kit.action("add", { items: "milk" }, { device: "robins-phone", conversationId: "c-2" }))
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      assert.strictEqual(said(yield* Fiber.join(reading)), "The shopping list has one thing: rice.")
      assert.strictEqual(said(yield* Fiber.join(adding)), "Added milk to the shopping list.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: rice and milk.")
    }))
})

describe("finding 14: paging what was ticked off", () => {
  it.effect("honours `from` and says what is left", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "item 0, item 1, item 2, item 3, item 4, item 5, item 6" })
      for (let i = 0; i < 7; i++) {
        yield* kit.action("complete", { item: `item ${i}` })
        yield* kit.advance(1_000)
      }
      assert.strictEqual(said(yield* kit.action("read", { show: "done" })), "Ticked off on the shopping list: item 6, item 5, item 4, item 3, item 2 and 2 more.")
      assert.strictEqual(said(yield* kit.action("read", { show: "done", from: 6 })), "Ticked off on the shopping list, from number 6: item 1 and item 0.")
      assert.strictEqual(said(yield* kit.action("read", { show: "done", from: 3 })), "Ticked off on the shopping list, from number 3: item 4, item 3, item 2, item 1 and item 0.")
      assert.strictEqual(said(yield* kit.action("read", { show: "done", from: 8 })), "The shopping list has only 7 ticked-off things.")
    }))
})

describe("finding 15: a search cut short", () => {
  it.effect("never says 'not on the list': it says it could not look through everything", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const service = kit.service(Lists)!
      yield* kit.asTurn(service.addItem({ text: "pineapple", dedupeKey: "k:pineapple" }))
      yield* kit.asTurn(service.completeByKey("k:pineapple"))
      yield* kit.advance(1_000)
      for (let i = 0; i < 500; i++) {
        yield* kit.asTurn(service.addItem({ text: `task ${i}`, dedupeKey: `k:${i}` }))
        yield* kit.asTurn(service.completeByKey(`k:${i}`))
      }
      assert.strictEqual(said(yield* kit.action("remove", { item: "pinapple" })), "I couldn't look through everything on the shopping list for pinapple; say the exact name.")
      // Its exact name is found, however many there are.
      assert.strictEqual(said(yield* kit.action("remove", { item: "pineapple" })), "Took pineapple off the shopping list.")
    }))
})

describe("finding 17: a store that is busy or fails, and a service kept after the module stopped", () => {
  it.effect("busy: the busy sentence; a failure after the item write: the plain one; items, counts and undo unchanged", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(hooked(hooks))
      yield* kit.action("add", { items: "milk" })
      const before = JSON.stringify([yield* allItems(kit), yield* kit.moduleStore().collection(undo).list({})].map((rs) => rs.map((r) => [r.id, r.rev, r.value])))
      hooks.transactionFails = new StoreError({ reason: "busy", message: "test: busy" })
      assert.deepStrictEqual(yield* kit.action("add", { items: "eggs" }), { ok: false, code: "failed", message: "The lists are busy just now; try again in a moment." })
      assert.deepStrictEqual(yield* kit.action("complete", { item: "milk" }), { ok: false, code: "failed", message: "The lists are busy just now; try again in a moment." })
      const service = kit.service(Lists)!
      assert.strictEqual((yield* Effect.flip(kit.asTurn(service.addItem({ text: "Rice" })))).reason, "busy")
      hooks.transactionFails = undefined
      hooks.listUpdateThrows = new StoreError({ reason: "failed", message: "test: failed" })
      assert.deepStrictEqual(yield* kit.action("add", { items: "eggs" }), { ok: false, code: "failed", message: "I couldn't change the list just now." })
      assert.deepStrictEqual(yield* kit.action("complete", { item: "milk" }), { ok: false, code: "failed", message: "I couldn't change the list just now." })
      assert.strictEqual((yield* Effect.flip(kit.asTurn(service.addItem({ text: "Rice" })))).reason, "failed")
      hooks.listUpdateThrows = undefined
      const after = JSON.stringify([yield* allItems(kit), yield* kit.moduleStore().collection(undo).list({})].map((rs) => rs.map((r) => [r.id, r.rev, r.value])))
      assert.strictEqual(after, before)
      assert.deepStrictEqual(yield* counts(kit, "shopping"), { open: 1, done: 0 })
      // The undo entry is still the first add's.
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone: the shopping list is as it was.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list is empty.")
    }))

  it.effect("busy in Dutch", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(hooked(hooks), { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      hooks.transactionFails = new StoreError({ reason: "busy", message: "test: busy" })
      assert.strictEqual(said(yield* kit.action("add", { items: "melk" })), "De lijsten zijn nu even bezet; probeer het zo nog eens.")
      hooks.transactionFails = undefined
      hooks.listUpdateThrows = new StoreError({ reason: "failed", message: "test: failed" })
      assert.strictEqual(said(yield* kit.action("add", { items: "melk" })), "Ik kon de lijst nu niet aanpassen.")
    }))

  it.effect("a service handle kept after the module stopped dies with ModuleStopped and writes nothing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const kept = kit.service(Lists)!
      yield* kit.stop
      for (const call of [kept.addItem({ text: "Rice", dedupeKey: "kitchen:rice" }), kept.completeByKey("kitchen:rice"), kept.removeByKey("kitchen:rice"), kept.find("kitchen:rice")]) {
        const exit = yield* Effect.exit(kit.asTurn(call as Effect.Effect<unknown, ListsError>))
        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) assert.isTrue(isModuleStopped(Cause.squash(exit.cause)), String(Cause.squash(exit.cause)))
      }
      yield* kit.start
      assert.deepStrictEqual(yield* allItems(kit), [])
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list is empty.")
    }))

  it.effect("in Dutch: lists_update, lists_remove and deleting a named list, with their refusals", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* kit.action("add", { items: "melk en eieren" })
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "melk", amount: 2, unit: "l" })), "Aangepast: 2 liter melk op de boodschappenlijst.")
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "kaas", amount: 1 })), "Niet op de boodschappenlijst: kaas.")
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "melk" })), "Wat moet ik eraan veranderen? Een naam, een hoeveelheid, een notitie, of het weer op de lijst zetten.")
      assert.strictEqual(said(yield* kit.action("remove", { item: "eieren van de boodschappenlijst" })), "Eieren van de boodschappenlijst gehaald.")
      assert.strictEqual(said(yield* kit.action("remove", { item: "kaas" })), "Niet op de boodschappenlijst: kaas.")
      yield* kit.tool("lists_create", { name: "kamperen", items: "tent" })
      assert.strictEqual(spoken(yield* kit.tool("lists_delete", { list: "kamperen" })), "De lijst kamperen verwijderd. Zeg ongedaan maken om hem vandaag terug te halen.")
      assert.strictEqual(spoken(yield* kit.tool("lists_delete", { list: "nergens" })), "Er is geen lijst die nergens heet. De lijsten zijn de boodschappenlijst en de takenlijst.")
      assert.strictEqual(said(yield* kit.action("undo", {})), "Ongedaan gemaakt: de lijst kamperen is terug.")
      assert.strictEqual(said(yield* kit.action("read", { list: "kamperen" })), "Op de lijst kamperen staat één ding: tent.")
    }))
})
