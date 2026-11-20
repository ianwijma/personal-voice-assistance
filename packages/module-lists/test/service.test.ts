// The `Lists` service as `packages/module-contracts/src/lists.ts` describes it, against its own text: keys, outcomes,
// bounds, the open-item limit, and how it meets what people say to the lists module.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { type AddItemRequest, Lists, LISTS_LIMITS, ListsError, type ListsService } from "@pva/module-contracts"
import { Effect } from "effect"
import { items, listsModule, MAX_OPEN } from "../src/index.ts"

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)

/** The module started, and its service as a consumer's tool would call it (inside a turn of the kitchen display). */
const withService = Effect.gen(function*() {
  const kit = yield* startTestModule(listsModule)
  const service = kit.service(Lists)
  assert.isDefined(service)
  const call = <A>(f: (s: ListsService) => Effect.Effect<A, ListsError>) => kit.asTurn(f(service!))
  return { kit, call }
})

describe("the Lists service", () => {
  it.effect("a key names one item: added, then updated in place, ticked off, reopened, found and removed for good", () =>
    Effect.gen(function*() {
      const { kit, call } = yield* withService
      const added = yield* call((s) => s.addItem({ text: "Rice", quantity: { amount: 1, unit: "kg" }, note: "pantry: out", dedupeKey: "kitchen:product:rice" }))
      assert.strictEqual(added.outcome, "added")
      assert.deepStrictEqual({ ...added.item, id: "" }, { id: "", text: "Rice", quantity: { amount: 1, unit: "kg" }, note: "pantry: out", status: "open", dedupeKey: "kitchen:product:rice" })
      // The same key again replaces text, quantity and note; the absent note is cleared; the id stays.
      const updated = yield* call((s) => s.addItem({ text: "Basmati rice", quantity: { amount: 2, unit: "kg" }, dedupeKey: "kitchen:product:rice" }))
      assert.strictEqual(updated.outcome, "updated")
      assert.strictEqual(updated.item.id, added.item.id)
      assert.deepStrictEqual(updated.item.quantity, { amount: 2, unit: "kg" })
      assert.isUndefined(updated.item.note)
      const done = yield* call((s) => s.completeByKey("kitchen:product:rice"))
      assert.strictEqual(done?.status, "done")
      assert.isUndefined(yield* call((s) => s.completeByKey("kitchen:product:rice")))
      const reopened = yield* call((s) => s.addItem({ text: "Basmati rice", dedupeKey: "kitchen:product:rice" }))
      assert.strictEqual(reopened.outcome, "reopened")
      assert.strictEqual(reopened.item.id, added.item.id)
      assert.isUndefined(reopened.item.quantity)
      assert.strictEqual((yield* call((s) => s.find("kitchen:product:rice")))?.status, "open")
      assert.isTrue(yield* call((s) => s.removeByKey("kitchen:product:rice")))
      assert.isFalse(yield* call((s) => s.removeByKey("kitchen:product:rice")))
      assert.isUndefined(yield* call((s) => s.find("kitchen:product:rice")))
      // Removed for good: no row is left, and the list's count is back to nothing.
      assert.deepStrictEqual(yield* kit.moduleStore().collection(items).list({}), [])
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list is empty.")
    }))

  it.effect("without a key it always adds, even beside the same text; what people say merges into it", () =>
    Effect.gen(function*() {
      const { kit, call } = yield* withService
      yield* call((s) => s.addItem({ text: "Rice" }))
      const second = yield* call((s) => s.addItem({ text: "Rice" }))
      assert.strictEqual(second.outcome, "added")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: Rice and Rice.")
      // Research example 12: the kitchen's item is on the list, and "add rice" says so.
      const kitchen = yield* withService
      yield* kitchen.call((s) => s.addItem({ text: "Rice", quantity: { amount: 1, unit: "kg" }, dedupeKey: "kitchen:product:rice" }))
      assert.strictEqual(said(yield* kitchen.kit.action("add", { items: "rice" })), "The shopping list already has rice.")
      // A person ticks it off by voice: the key's item is done, and the next add with the key reopens it.
      yield* kitchen.kit.action("complete", { item: "rice" })
      assert.strictEqual((yield* kitchen.call((s) => s.find("kitchen:product:rice")))?.status, "done")
      assert.strictEqual((yield* kitchen.call((s) => s.addItem({ text: "Rice", dedupeKey: "kitchen:product:rice" }))).outcome, "reopened")
    }))

  it.effect("an item a person took off gives its key up: the next add is a new item, and undo leaves it", () =>
    Effect.gen(function*() {
      const { kit, call } = yield* withService
      const first = yield* call((s) => s.addItem({ text: "Oats", dedupeKey: "kitchen:product:oats" }))
      yield* kit.action("remove", { item: "oats" })
      assert.isUndefined(yield* call((s) => s.find("kitchen:product:oats")))
      assert.isUndefined(yield* call((s) => s.completeByKey("kitchen:product:oats")))
      const again = yield* call((s) => s.addItem({ text: "Oats", dedupeKey: "kitchen:product:oats" }))
      assert.strictEqual(again.outcome, "added")
      assert.notStrictEqual(again.item.id, first.item.id)
      // The removal's undo cannot bring the old item back: the key has one item, the new one.
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone, except what changed on the shopping list since then.")
      const rows = (yield* kit.moduleStore().collection(items).list({})).filter((r) => r.value.dedupeKey === "kitchen:product:oats")
      assert.deepStrictEqual(rows.map((r) => [r.id, r.value.status]), [[again.item.id, "open"]])
    }))

  it.effect("refuses a request outside the bounds as invalid, and changes nothing", () =>
    Effect.gen(function*() {
      const { kit, call } = yield* withService
      const bad: ReadonlyArray<AddItemRequest> = [
        { text: "" },
        { text: "   " },
        { text: "two\nlines" },
        { text: "x".repeat(LISTS_LIMITS.textChars + 1) },
        { text: "Rice", note: "n".repeat(LISTS_LIMITS.noteChars + 1) },
        { text: "Rice", note: "a\tb" },
        { text: "Rice", quantity: { amount: 0 } },
        { text: "Rice", quantity: { amount: -1 } },
        { text: "Rice", quantity: { amount: Number.NaN } },
        { text: "Rice", quantity: { amount: LISTS_LIMITS.maxAmount + 1 } },
        { text: "Rice", quantity: { amount: 1, unit: "" } },
        { text: "Rice", quantity: { amount: 1, unit: "u".repeat(LISTS_LIMITS.unitChars + 1) } },
        { text: "Rice", dedupeKey: "ab" },
        { text: "Rice", dedupeKey: "nocolon" },
        { text: "Rice", dedupeKey: ":leading" },
        { text: "Rice", dedupeKey: "kitchen:with space" },
        { text: "Rice", dedupeKey: `kitchen:${"k".repeat(LISTS_LIMITS.keyChars)}` }
      ]
      for (const request of bad) {
        const e = yield* Effect.flip(call((s) => s.addItem(request)))
        assert.strictEqual(e.reason, "invalid", JSON.stringify(request))
      }
      for (const key of ["ab", "nocolon", "x y:z"]) {
        assert.strictEqual((yield* Effect.flip(call((s) => s.completeByKey(key)))).reason, "invalid")
        assert.strictEqual((yield* Effect.flip(call((s) => s.removeByKey(key)))).reason, "invalid")
        assert.strictEqual((yield* Effect.flip(call((s) => s.find(key)))).reason, "invalid")
      }
      // The largest legal request is taken.
      const largest = yield* call((s) =>
        s.addItem({ text: "x".repeat(LISTS_LIMITS.textChars), note: "n".repeat(LISTS_LIMITS.noteChars), quantity: { amount: LISTS_LIMITS.maxAmount, unit: "u".repeat(LISTS_LIMITS.unitChars) }, dedupeKey: `k:${"k".repeat(LISTS_LIMITS.keyChars - 2)}` })
      )
      assert.strictEqual(largest.outcome, "added")
      assert.strictEqual((yield* kit.moduleStore().collection(items).list({})).length, 1)
    }))

  it.effect(`at ${MAX_OPEN} open items an add or a reopen is limit, an update of an open item is not, and people's adds are refused too`, () =>
    Effect.gen(function*() {
      const { kit, call } = yield* withService
      yield* call((s) => s.addItem({ text: "Keyed", dedupeKey: "kitchen:keyed" }))
      yield* call((s) => s.addItem({ text: "Done one", dedupeKey: "kitchen:done" }))
      yield* call((s) => s.completeByKey("kitchen:done"))
      for (let i = 0; i < MAX_OPEN - 1; i++) yield* call((s) => s.addItem({ text: `Item ${i}` }))
      const full = yield* Effect.flip(call((s) => s.addItem({ text: "One more" })))
      assert.instanceOf(full, ListsError)
      assert.strictEqual(full.reason, "limit")
      assert.strictEqual((yield* Effect.flip(call((s) => s.addItem({ text: "Done one", dedupeKey: "kitchen:done" })))).reason, "limit")
      assert.strictEqual((yield* call((s) => s.addItem({ text: "Keyed, changed", dedupeKey: "kitchen:keyed" }))).outcome, "updated")
      assert.strictEqual(said(yield* kit.action("add", { items: "cheese" })), `The shopping list is full: it has ${MAX_OPEN} things on it. Tick some off first.`)
      assert.strictEqual(said(yield* kit.action("read", {})), `The shopping list has ${MAX_OPEN} things: Keyed, changed, Item 0, Item 1, Item 2, Item 3 and ${MAX_OPEN - 5} more.`)
      // Ticking one off makes room.
      yield* call((s) => s.completeByKey("kitchen:keyed"))
      assert.strictEqual((yield* call((s) => s.addItem({ text: "One more" }))).outcome, "added")
    }))

  it.effect("is published while the module runs and gone while it is off", () =>
    Effect.gen(function*() {
      const { kit } = yield* withService
      yield* kit.stop
      assert.isUndefined(kit.service(Lists))
      yield* kit.start
      assert.isDefined(kit.service(Lists))
    }))
})
