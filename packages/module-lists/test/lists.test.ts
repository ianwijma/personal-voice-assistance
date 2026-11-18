// The lists module's tools and typed actions, through the real host and gateway (the test kit): every one on its
// ordinary path and on its refusals, in English and Dutch.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { items, listsModule, MAX_PER_REQUEST } from "../src/index.ts"

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)
const spoken = (r: { readonly value: unknown }) => (r.value as { readonly spoken?: string }).spoken ?? r.value

describe("lists_add", () => {
  it.effect("splits on commas and 'and', reads amounts, keeps the order said, and names the list", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const r = yield* kit.action("add", { items: "milk, eggs and two litres of oat milk" })
      assert.deepStrictEqual(r, { ok: true, say: "Added milk, eggs and 2 litres of oat milk to the shopping list." })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 3 things: milk, eggs and 2 litres of oat milk.")
      const rows = yield* kit.moduleStore().collection(items).list({})
      const oat = rows.find((x) => x.value.text === "oat milk")
      assert.deepStrictEqual(oat?.value.quantity, { amount: 2, unit: "l" })
      // A count has no unit.
      yield* kit.action("add", { items: "3 lemons" })
      const lemons = (yield* kit.moduleStore().collection(items).list({})).find((x) => x.value.text === "lemons")
      assert.deepStrictEqual(lemons?.value.quantity, { amount: 3 })
    }))

  it.effect("keeps a known name with 'and' whole, and the settings change how it splits", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      assert.strictEqual(said(yield* kit.action("add", { items: "salt and pepper crisps and bread" })), "Added salt and pepper crisps and bread to the shopping list.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: salt and pepper crisps and bread.")
      const always = yield* startTestModule(listsModule, { settings: { splitItems: "always" } })
      yield* always.action("add", { items: "salt and pepper crisps" })
      assert.strictEqual(said(yield* always.action("read", {})), "The shopping list has 2 things: salt and pepper crisps.")
      const never = yield* startTestModule(listsModule, { settings: { splitItems: "never" } })
      yield* never.action("add", { items: "fish, chips and peas" })
      assert.strictEqual(said(yield* never.action("read", {})), "The shopping list has one thing: fish, chips and peas.")
    }))

  it.effect("takes the list from the rest of the sentence on the typed path, and the to-do list by name", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      assert.strictEqual(said(yield* kit.action("add", { items: "call the plumber to the to-do list" })), "Added call the plumber to the to-do list.")
      assert.strictEqual(said(yield* kit.action("add", { items: "rice on the list" })), "Added rice to the shopping list.")
      assert.strictEqual(said(yield* kit.action("add", { items: "bleach", list: "to do" })), "Added bleach to the to-do list.")
      // The model's tool takes the same values.
      const tool = yield* kit.tool("lists_add", { items: "tea", list: "groceries" })
      assert.strictEqual(tool.value, "Added tea to the shopping list.")
      // A list name the household does not have is refused before the module runs, with the lists there are.
      const unknown = yield* kit.tool("lists_add", { items: "tent", list: "camping" })
      assert.isFalse(unknown.ok)
      assert.include(unknown.content, "Unknown list \"camping\"")
    }))

  it.effect("merges an item said again: nothing twice, amounts added, a ticked-off one put back", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "milk and 500 grams of flour" })
      assert.strictEqual(said(yield* kit.action("add", { items: "Milk" })), "The shopping list already has Milk.")
      assert.strictEqual(said(yield* kit.action("add", { items: "1 kilo of flour and eggs" })), "Added 1.5 kilograms of flour and eggs to the shopping list.")
      assert.strictEqual(said(yield* kit.action("add", { items: "two milk" })), "Added 2 milk to the shopping list.")
      assert.strictEqual(said(yield* kit.action("add", { items: "a bag of flour" })), "Added 1.5 kilograms of flour to the shopping list.")
      const flour = (yield* kit.moduleStore().collection(items).list({})).find((x) => x.value.text === "flour")
      assert.strictEqual(flour?.value.note, "a bag of flour")
      // Ticked off, then said again: back on the list, not a second item.
      yield* kit.action("complete", { item: "eggs" })
      assert.strictEqual(said(yield* kit.action("add", { items: "egg" })), "Added eggs to the shopping list.")
      const open = (yield* kit.moduleStore().collection(items).list({})).filter((x) => x.value.status === "open").map((x) => x.value.text)
      assert.sameMembers(open, ["milk", "flour", "eggs"])
      // With merging off, an item said again is a second item.
      const plain = yield* startTestModule(listsModule, { settings: { mergeDuplicates: false } })
      yield* plain.action("add", { items: "milk" })
      yield* plain.action("add", { items: "milk" })
      assert.strictEqual(said(yield* plain.action("read", {})), "The shopping list has 2 things: milk and milk.")
    }))

  it.effect("refuses too many items at once, too long a text, and nothing said, writing nothing", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const many = Array.from({ length: MAX_PER_REQUEST + 1 }, (_, i) => `thing ${i}`).join(", ")
      assert.deepStrictEqual(yield* kit.action("add", { items: many }), { ok: false, code: "failed", message: `That's more than ${MAX_PER_REQUEST} things at once; say them in parts.` })
      assert.strictEqual(said(yield* kit.action("add", { items: "x".repeat(201) })), "That's too long for a list item; say it shorter.")
      assert.strictEqual(said(yield* kit.action("add", { items: "y".repeat(2_001) })), "That's too long for a list item; say it shorter.")
      assert.strictEqual(said(yield* kit.action("add", { items: " , and " })), "What should go on the list?")
      assert.strictEqual(said(yield* kit.action("add", { items: "bad\u0007bell" })), "That's too long for a list item; say it shorter.")
      assert.deepStrictEqual(yield* kit.moduleStore().collection(items).list({}), [])
    }))
})

describe("lists_read and lists_overview", () => {
  it.effect("reads the first few with 'and N more', goes on from an item number past one store page, and says what was ticked off", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      // 40 items: more than two store pages (16 rows each).
      for (let i = 0; i < 40; i += 10) yield* kit.action("add", { items: Array.from({ length: 10 }, (_, j) => `item ${i + j}`).join(", ") })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 40 things: item 0, item 1, item 2, item 3, item 4 and 35 more.")
      assert.strictEqual(said(yield* kit.action("read", { from: 34 })), "From number 34 on the shopping list: item 33, item 34, item 35, item 36, item 37 and 2 more.")
      assert.strictEqual(said(yield* kit.action("read", { from: 39 })), "From number 39 on the shopping list: item 38 and item 39.")
      assert.strictEqual(said(yield* kit.action("read", { from: 41 })), "The shopping list has only 40 things.")
      assert.strictEqual(said(yield* kit.action("read", { show: "done" })), "Nothing is ticked off on the shopping list.")
      yield* kit.action("complete", { item: "item 7 and item 8" })
      assert.strictEqual(said(yield* kit.action("read", { show: "done" })), "Ticked off on the shopping list: item 8 and item 7.")
      assert.strictEqual(said(yield* kit.action("read", { list: "to-do list" })), "The to-do list is empty.")
    }))

  it.effect("an assistant's own number of items read out wins over the shared one", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: { assistants: [{ id: "jeff", modules: { lists: { own: { readItems: 2 } } } }] } })
      yield* kit.action("add", { items: "a1, b2, c3" })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 3 things: a1, b2 and 1 more.")
    }))

  it.effect("names the lists with their open counts", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      assert.strictEqual(said(yield* kit.action("overview", {})), "There are 2 lists: the shopping list with 0 and the to-do list with 0.")
      yield* kit.action("add", { items: "milk" })
      yield* kit.tool("lists_create", { name: "Gift ideas", items: "socks" })
      assert.strictEqual(said(yield* kit.action("overview", {})), "There are 3 lists: the shopping list with 1, the to-do list with 0 and the Gift ideas list with 1.")
    }))
})

describe("lists_complete, lists_remove and lists_clear_done", () => {
  it.effect("ticks off by name, plural or close, on the list it is on, and says what is not on it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "bread, tomatoes and milk" })
      yield* kit.action("add", { items: "call the plumber", list: "to do" })
      assert.strictEqual(said(yield* kit.action("complete", { item: "the bread" })), "Ticked off bread on the shopping list.")
      assert.strictEqual(said(yield* kit.action("complete", { item: "tomato and cheese" })), "Ticked off tomatoes on the shopping list. Not on the shopping list: cheese.")
      assert.strictEqual(said(yield* kit.action("complete", { item: "call the plumber" })), "Ticked off call the plumber on the to-do list.")
      assert.strictEqual(said(yield* kit.action("complete", { item: "mlik" })), "Ticked off milk on the shopping list.")
      assert.strictEqual(said(yield* kit.action("complete", { item: "caviar" })), "Not on the shopping list: caviar.")
      assert.strictEqual(said(yield* kit.action("complete", { item: "milk off the list" })), "Not on the shopping list: milk.")
    }))

  it.effect("removes open or ticked-off items, and clears what is ticked off in steps", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "eggs, rice and butter" })
      yield* kit.action("complete", { item: "butter" })
      assert.strictEqual(said(yield* kit.action("remove", { item: "eggs and butter" })), "Took eggs and butter off the shopping list.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has one thing: rice.")
      assert.strictEqual(said(yield* kit.action("remove", { item: "eggs" })), "Not on the shopping list: eggs.")
      // 45 ticked off: a clear takes 40 and says there are more.
      for (let i = 0; i < 45; i += 9) yield* kit.action("add", { items: Array.from({ length: 9 }, (_, j) => `t${i + j}`).join(", "), list: "to do" })
      for (let i = 0; i < 45; i += 9) yield* kit.action("complete", { item: Array.from({ length: 9 }, (_, j) => `t${i + j}`).join(", "), list: "to do" })
      assert.strictEqual(said(yield* kit.action("clear_done", { list: "to do" })), "Cleared 40 ticked-off things from the to-do list; there are more, so say it again.")
      assert.strictEqual(said(yield* kit.action("clear_done", { list: "to do" })), "Cleared 5 ticked-off things from the to-do list.")
      assert.strictEqual(said(yield* kit.action("clear_done", { list: "to do" })), "Nothing is ticked off on the to-do list.")
    }))
})

describe("lists_update", () => {
  it.effect("renames, sets and clears an amount and a note, puts a ticked-off item back, and says when there is nothing to change", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "milk" })
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "milk", amount: 2 })), "Changed it: 2 milk on the shopping list.")
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "milk", unit: "l" })), "Changed it: 2 litres of milk on the shopping list.")
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "milk", rename: "oat milk", note: "the barista one" })), "Changed it: 2 litres of oat milk (the barista one) on the shopping list.")
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "oat milk", clearAmount: true, note: "" })), "Changed it: oat milk on the shopping list.")
      yield* kit.action("complete", { item: "oat milk" })
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "oat milk", reopen: true })), "Changed it: oat milk on the shopping list.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has one thing: oat milk.")
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "oat milk" })), "What should I change about it? A name, an amount, a note, or put it back on the list.")
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "cheese", amount: 1 })), "Not on the shopping list: cheese.")
      assert.strictEqual(spoken(yield* kit.tool("lists_update", { item: "cheese", list: "camping" })), "There's no list called camping. The lists are the shopping list and the to-do list.")
      // The schema refuses an amount out of bounds and a note with a line break before the module runs.
      assert.isFalse((yield* kit.tool("lists_update", { item: "oat milk", amount: 0 })).ok)
      assert.isFalse((yield* kit.tool("lists_update", { item: "oat milk", note: "a\nb" })).ok)
    }))
})

describe("lists_create and lists_delete", () => {
  it.effect("makes a named list with items, refuses a name in use, and keeps to the most lists", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      assert.strictEqual(spoken(yield* kit.tool("lists_create", { name: "Camping packing list", items: "tent, sleeping bags and a torch" })), "Made the Camping packing list with tent, sleeping bags and torch.")
      assert.strictEqual(spoken(yield* kit.tool("lists_create", { name: "camping packing" })), "There's already a list called camping packing.")
      assert.strictEqual(spoken(yield* kit.tool("lists_create", { name: "Groceries" })), "There's already a list called Groceries.")
      assert.isFalse((yield* kit.tool("lists_create", { name: "   " })).ok)
      assert.strictEqual(said(yield* kit.action("read", { list: "camping packing" })), "The Camping packing list has 3 things: tent, sleeping bags and torch.")
      for (let i = 1; i < 28; i++) assert.match(String(spoken(yield* kit.tool("lists_create", { name: `List ${i}` }))), /^Made /)
      assert.strictEqual(spoken(yield* kit.tool("lists_create", { name: "One too many" })), "There are 30 lists already; delete one first.")
    }))

  it.effect("deletes a named list, hides it, brings it back with undo; the default lists cannot be deleted", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.tool("lists_create", { name: "Camping", items: "tent" })
      assert.strictEqual(spoken(yield* kit.tool("lists_delete", { list: "camping" })), "Deleted the Camping list. Say undo to bring it back today.")
      assert.strictEqual(said(yield* kit.action("overview", {})), "There are 2 lists: the shopping list with 0 and the to-do list with 0.")
      assert.isFalse((yield* kit.tool("lists_read", { list: "camping" })).ok)
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone: the Camping list is back.")
      assert.strictEqual(said(yield* kit.action("read", { list: "camping" })), "The Camping list has one thing: tent.")
      assert.strictEqual(spoken(yield* kit.tool("lists_delete", { list: "shopping list" })), "The shopping list can't be deleted; you can clear what's ticked off on it instead.")
      assert.strictEqual(spoken(yield* kit.tool("lists_delete", { list: "nowhere" })), "There's no list called nowhere. The lists are the shopping list, the to-do list and the Camping list.")
    }))
})

describe("lists_undo", () => {
  it.effect("undoes the conversation's last change, one level, and only its own", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const other = { device: "robins-phone", conversationId: "conversation-2" }
      yield* kit.action("add", { items: "milk and bread" })
      yield* kit.action("add", { items: "tea" }, other)
      // An add undone: what it added is gone, what another conversation added stays.
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone: the shopping list is as it was.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has one thing: tea.")
      assert.strictEqual(said(yield* kit.action("undo", {})), "There's nothing to undo.")
      // A merge undone puts the amount back.
      yield* kit.action("add", { items: "2 litres of milk" })
      yield* kit.action("add", { items: "1 litre of milk" })
      yield* kit.action("undo", {})
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: tea and 2 litres of milk.")
      // A tick and a removal undone.
      yield* kit.action("complete", { item: "tea" })
      yield* kit.action("undo", {})
      yield* kit.action("remove", { item: "milk" })
      yield* kit.action("undo", {})
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: tea and 2 litres of milk.")
      // A rename undone.
      yield* kit.tool("lists_update", { item: "tea", rename: "green tea", note: "loose" })
      yield* kit.action("undo", {})
      const tea = (yield* kit.moduleStore().collection(items).list({})).find((x) => x.value.text === "tea")
      assert.isDefined(tea)
      assert.isUndefined(tea?.value.note)
      // The other conversation's change is its own to undo.
      yield* kit.action("add", { items: "jam" }, other)
      assert.strictEqual(said(yield* kit.action("undo", {})), "There's nothing to undo.")
      assert.strictEqual(said(yield* kit.action("undo", {}, other)), "Undone: the shopping list is as it was.")
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: tea and 2 litres of milk.")
    }))

  it.effect("leaves what changed since, undoes a new list only while nobody changed it, and forgets after a day", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      const other = { device: "robins-phone", conversationId: "conversation-2" }
      yield* kit.action("add", { items: "milk and eggs" })
      yield* kit.action("complete", { item: "eggs" }, other)
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone, except what changed on the shopping list since then.")
      assert.strictEqual(said(yield* kit.action("read", { show: "done" })), "Ticked off on the shopping list: eggs.")
      yield* kit.tool("lists_create", { name: "Party", items: "balloons" })
      yield* kit.action("add", { items: "cake", list: "party" }, other)
      assert.strictEqual(said(yield* kit.action("undo", {})), "The Party list has changed since then, so I left it as it is.")
      yield* kit.tool("lists_create", { name: "Garden" })
      assert.strictEqual(said(yield* kit.action("undo", {})), "Undone: the Garden list is gone again.")
      assert.strictEqual(said(yield* kit.action("overview", {})), "There are 3 lists: the shopping list with 0, the to-do list with 0 and the Party list with 2.")
      yield* kit.action("add", { items: "rice" })
      yield* kit.advance(25 * 3_600_000)
      assert.strictEqual(said(yield* kit.action("undo", {})), "There's nothing to undo.")
    }))
})

describe("in Dutch", () => {
  it.effect("speaks Dutch in a Dutch household, its refusals too, and knows the Dutch list names", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(said(yield* kit.action("add", { items: "melk, eieren en twee liter havermelk op de boodschappenlijst" })), "Melk, eieren en 2 liter havermelk op de boodschappenlijst gezet.")
      assert.strictEqual(said(yield* kit.action("add", { items: "melk" })), "Op de boodschappenlijst stond al: melk.")
      assert.strictEqual(said(yield* kit.action("read", {})), "Op de boodschappenlijst staan 3 dingen: melk, eieren en 2 liter havermelk.")
      assert.strictEqual(said(yield* kit.action("complete", { item: "melk en kaas" })), "Melk afgevinkt op de boodschappenlijst. Niet op de boodschappenlijst: kaas.")
      assert.strictEqual(said(yield* kit.action("add", { items: "loodgieter bellen", list: "takenlijst" })), "Loodgieter bellen op de takenlijst gezet.")
      assert.strictEqual(said(yield* kit.action("undo", {})), "Ongedaan gemaakt: de takenlijst is weer zoals het was.")
      assert.strictEqual(said(yield* kit.action("undo", {})), "Er is niets om ongedaan te maken.")
      assert.strictEqual(said(yield* kit.action("overview", {})), "Er zijn 2 lijsten: de boodschappenlijst met 2 en de takenlijst met 0.")
      assert.strictEqual(spoken(yield* kit.tool("lists_create", { name: "kamperen" })), "De lijst kamperen gemaakt.")
      assert.strictEqual(spoken(yield* kit.tool("lists_delete", { list: "boodschappen" })), "De boodschappenlijst kan niet worden verwijderd; je kunt wel wat erop is afgevinkt weghalen.")
      assert.strictEqual(said(yield* kit.action("add", { items: Array.from({ length: 13 }, (_, i) => `ding ${i}`).join(", ") })), "Dat zijn meer dan 12 dingen tegelijk; zeg ze in delen.")
      assert.strictEqual(said(yield* kit.action("clear_done", {})), "1 afgevinkte dingen van de boodschappenlijst gehaald.")
    }))
})

describe("the gateway", () => {
  it.effect("refuses a tool or action the assistant switched off, and nothing changes", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: { assistants: [{ id: "jeff", modules: { lists: { offTools: ["lists_add", "lists_delete"] } } }] } })
      assert.notInclude(kit.toolNames(), "lists_add")
      const refused = yield* kit.action("add", { items: "milk" })
      assert.isFalse(refused.ok)
      const asTool = yield* kit.tool("lists_add", { items: "milk" })
      assert.match(asTool.content, /^Not run: lists_add is switched off/)
      assert.deepStrictEqual(yield* kit.moduleStore().collection(items).list({}), [])
    }))

  it.effect("is off for an assistant that does not have it on, and its rows outlive a stop", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule)
      yield* kit.action("add", { items: "milk" })
      yield* kit.stop
      assert.notInclude(kit.toolNames(), "lists_read")
      assert.isFalse((yield* kit.action("read", {})).ok)
      yield* kit.start
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has one thing: milk.")
    }))
})
