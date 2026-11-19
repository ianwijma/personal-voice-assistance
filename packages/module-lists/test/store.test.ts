// What the lists module keeps and how: indexed values at their largest, reads past one store page, the daily
// clean-up job across a restart, invalid settings, and that lists are household data on every kind of device.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Lists, LISTS_LIMITS } from "@pva/module-contracts"
import { Effect } from "effect"
import { type Item, items, type ListRow, lists, listsModule, MAX_OPEN, undo, undoIdOf } from "../src/index.ts"

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)
const HOUR = 3_600_000
const DAY = 24 * HOUR

describe("storage", () => {
  it.effect("a row with every indexed field at its largest is stored, in each collection", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const store = kit.moduleStore()
      const list = "l".repeat(40)
      const largest: Item = {
        list,
        text: "\"".repeat(LISTS_LIMITS.textChars),
        quantity: { amount: LISTS_LIMITS.maxAmount, unit: "\\".repeat(LISTS_LIMITS.unitChars) },
        note: "\"".repeat(LISTS_LIMITS.noteChars),
        status: "removed",
        place: `${list}:removed`.padEnd(48, "x"),
        since: 8_640_000_000_000_000,
        match: `${"f".repeat(32)}:removed`,
        dedupeKey: `k:${"/".repeat(LISTS_LIMITS.keyChars - 2)}`
      }
      yield* store.collection(items).insert(largest)
      const listRow: ListRow = { name: "\"".repeat(40), kind: "generic", open: MAX_OPEN, done: 1_000_000_000, deletedAt: 8_640_000_000_000_000 }
      yield* store.collection(lists).insert(listRow, { id: list })
      yield* store.collection(undo).insert({ at: 8_640_000_000_000_000, op: "add", list, steps: [] }, { id: undoIdOf("c") })
      assert.strictEqual((yield* store.collection(items).list({})).length, 1)
      // Beside the two default lists, made at the start.
      assert.strictEqual((yield* store.collection(lists).list({})).length, 3)
      assert.strictEqual((yield* store.collection(undo).list({})).length, 1)
    }))

  it.effect("finds an item by a close name past one store page of a long list", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      for (let i = 0; i < 48; i += 12) yield* kit.action("add", { items: Array.from({ length: 12 }, (_, j) => `thing ${i + j}`).join(", ") })
      yield* kit.action("add", { items: "pineapple" })
      // 49 open items, three store pages and more: the last one, said a little wrong, is found by the scan.
      assert.strictEqual(said(yield* kit.action("complete", { item: "pinapple" })), "Ticked off pineapple on the shopping list.")
      assert.strictEqual(said(yield* kit.action("read", { from: 45 })), "From number 45 on the shopping list: thing 44, thing 45, thing 46 and thing 47.")
    }))

  it.effect("nothing it stores names a person, and nothing it says differs between a shared, a private and a public device", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, {
        household: {
          devices: [
            { id: "kitchen-display", name: "Kitchen display", privacy: "shared", defaultPerson: "p-sam" },
            { id: "robins-phone", name: "Robin's phone", privacy: "private", defaultPerson: "p-robin" },
            { id: "hall-screen", name: "Hall screen", privacy: "public", defaultPerson: null },
            { id: "porch-screen", name: "Porch screen", privacy: "public", defaultPerson: "p-alex" },
            { id: "living-room-speaker", name: "Living room", privacy: "shared", defaultPerson: null }
          ]
        }
      })
      yield* kit.action("add", { items: "milk" }, { device: "kitchen-display" })
      yield* kit.action("add", { items: "bread" }, { device: "robins-phone", conversationId: "conversation-robin" })
      yield* kit.action("add", { items: "tea" }, { device: "porch-screen", conversationId: "conversation-porch" })
      yield* kit.tool("lists_create", { name: "Gifts", items: "socks" }, { device: "hall-screen", conversationId: "conversation-hall" })
      for (const device of ["kitchen-display", "robins-phone", "hall-screen", "porch-screen", "living-room-speaker"]) {
        assert.strictEqual(said(yield* kit.action("read", {}, { device })), "The shopping list has 3 things: milk, bread and tea.", device)
        assert.strictEqual(said(yield* kit.action("read", { list: "gifts" }, { device })), "The Gifts list has one thing: socks.", device)
      }
      const rows = JSON.stringify([
        yield* kit.moduleStore().collection(items).list({}),
        yield* kit.moduleStore().collection(lists).list({}),
        yield* kit.moduleStore().collection(undo).list({})
      ].map((rs) => rs.map((r) => ({ id: r.id, value: r.value }))))
      // Needles that a random row id (hex and dashes) cannot hold by chance.
      for (const person of ["p-sam", "p-robin", "p-alex", "kitchen-display", "robins-phone", "porch-screen", "hall-screen", "conversation-1", "conversation-robin", "conversation-porch", "conversation-hall"]) {
        assert.notInclude(rows, person)
      }
    }))
})

describe("the daily clean-up", () => {
  it.effect("runs at 04:15, and after a restart removes old ticked-off items by the settings, removed items, deleted lists and undo entries", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { settings: { keepDoneShoppingHours: 12, keepDoneDays: 2 } })
      const job = (yield* kit.jobs).find((j) => j.handler === "tidy")
      assert.strictEqual(job?.cron, "15 4 * * *")
      yield* kit.action("add", { items: "milk, bread and eggs" })
      yield* kit.action("add", { items: "fix the tap and paint the door", list: "to do" })
      yield* kit.action("complete", { item: "milk" })
      yield* kit.action("complete", { item: "fix the tap" })
      yield* kit.action("remove", { item: "bread" })
      yield* kit.tool("lists_create", { name: "Camping", items: "tent, torch" }, { conversationId: "c-2" })
      yield* kit.tool("lists_delete", { list: "camping" }, { conversationId: "c-2" })
      yield* kit.restart
      // The first run (Thursday 04:15, 18 hours on): the ticked-off shopping is past 12 hours; the to-do, the removed
      // bread, the deleted list and the undo entries are not yet past their day.
      yield* kit.runJob(job!.id)
      const left = (yield* kit.moduleStore().collection(items).list({ limit: 16 })).map((r) => `${r.value.text}:${r.value.status}`)
      assert.sameMembers(left, ["eggs:open", "fix the tap:done", "paint the door:open", "bread:removed", "tent:open", "torch:open"])
      assert.strictEqual(said(yield* kit.action("read", { show: "done" })), "Nothing is ticked off on the shopping list.")
      // A day later: the removed bread, the deleted list with its items and the undo entries are gone; the to-do stays
      // until two days have passed.
      yield* kit.advance(DAY)
      const day2 = (yield* kit.moduleStore().collection(items).list({ limit: 16 })).map((r) => `${r.value.text}:${r.value.status}`)
      assert.sameMembers(day2, ["eggs:open", "fix the tap:done", "paint the door:open"])
      assert.deepStrictEqual((yield* kit.moduleStore().collection(lists).list({})).map((r) => r.id).toSorted(), ["shopping", "todo"])
      assert.deepStrictEqual(yield* kit.moduleStore().collection(undo).list({}), [])
      yield* kit.advance(DAY)
      assert.strictEqual(said(yield* kit.action("read", { list: "to do", show: "done" })), "Nothing is ticked off on the to-do list.")
      assert.strictEqual(said(yield* kit.action("overview", {})), "There are 2 lists: the shopping list with 1 and the to-do list with 1.")
      // Each run succeeded, and its removals are the job's.
      const runs = (yield* kit.jobs).find((j) => j.id === job!.id)
      assert.isUndefined(runs?.lastError)
      assert.isTrue(kit.events.some((e) => e.type === "lists.items.changed" && e.actor?.kind === "job"))
    }))

  it.effect("its undo entries, rows and lists survive a restart of the module", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "milk and honey" })
      yield* kit.restart
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: milk and honey.")
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone: the shopping list is as it was.")
      assert.isDefined(kit.service(Lists))
    }))
})

describe("settings", () => {
  it.effect("an invalid value is refused: the module does not run with it, and says so on its page", () =>
    Effect.gen(function*() {
      for (const bad of [{ readItems: 1 }, { readItems: 11 }, { keepDoneShoppingHours: 0 }, { keepDoneDays: 1.5 }, { splitItems: "sometimes" }, { mergeDuplicates: "yes" }]) {
        const kit = yield* startTestModule(listsModule, { settings: bad })
        assert.notStrictEqual(kit.info()?.state, "running", JSON.stringify(bad))
        assert.isFalse((yield* kit.action("read", {})).ok)
      }
      // A good value is taken, and a change applies at once.
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "a1, b2, c3, d4" })
      yield* kit.configure({ readItems: 3 })
      assert.strictEqual(kit.info()?.state, "running")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 4 things: a1, b2, c3 and 1 more.")
    }))
})
