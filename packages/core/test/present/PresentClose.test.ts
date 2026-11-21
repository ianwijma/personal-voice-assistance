// Closing on the page (docs/PRESENTING.md "Closing on the page"): `present.close` from a voice page that holds the show
// and may press it there dismisses the presentation through the Presenter's own dismissal: out of the index, every
// connection that holds it is sent `present.dismiss` (other tabs, other devices of a room target), the row is marked
// ended, a reconnect does not bring it back, and the module's handle answers as for any dismissed presentation.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { makeConnectionRef } from "../../src/index.ts"
import { presentPrepared, presentWorld, SCREEN } from "../../src/presentContract.ts"
import { makeMemoryHouseholdStore } from "../../src/testing.ts"

const card = (title: string) => ({ kind: "card" as const, title, spoken: `${title}.` })
const world = (o?: Parameters<typeof presentWorld>[1]) =>
  Effect.gen(function*() {
    const w = yield* presentWorld(yield* presentPrepared(makeMemoryHouseholdStore()), o)
    yield* w.settle
    return w
  })
type World = Effect.Success<ReturnType<typeof world>>

/** As the hub passes it: the device, the connection it came on, the revision that page displays. */
const closeOn = (w: World, deviceId: string, id: string, o: { readonly tab?: ReturnType<World["firstTab"]>; readonly revision?: string } = {}) => {
  const tab = o.tab ?? w.firstTab(deviceId)
  return Effect.tap(
    w.present.close({ presentationId: id, revision: o.revision ?? w.holds(tab).get(id)?.revision ?? "missing", deviceId, ...(tab !== undefined ? { connection: makeConnectionRef(tab.id) } : {}) }),
    () => w.settle
  )
}

describe("closing a presentation on the page", () => {
  it.effect("marks it closable where it may be pressed, with the close button's name, also without a handler", () =>
    Effect.gen(function*() {
      const w = yield* world()
      const h = yield* w.board().show({ device: "kitchen-display" }, card("Bins out"), { lifetime: "pinned" })
      yield* w.settle
      const shown = w.holds(w.firstTab("kitchen-display")).get(h.id)!
      assert.strictEqual(shown.closable, true)
      assert.strictEqual(shown.interactive, false, "no handler: nothing else to press")
      assert.strictEqual(shown.texts.close, "Close")
    }))

  it.effect("dismisses it for every page that holds it (both tabs, every screen of the room) and for good", () =>
    Effect.gen(function*() {
      const w = yield* world()
      const second = yield* w.open("kitchen-display")
      const h = yield* w.board().show({ room: "Kitchen" }, card("Dinner"), { lifetime: "pinned" })
      yield* w.settle
      assert.isTrue(w.holds(second).has(h.id))
      assert.isTrue(w.holds(w.firstTab("kitchen-tablet")).has(h.id))
      const answer = yield* closeOn(w, "kitchen-display", h.id)
      assert.deepStrictEqual(answer, { ok: true })
      for (const tab of [w.firstTab("kitchen-display"), second, w.firstTab("kitchen-tablet")]) {
        assert.isFalse(w.holds(tab).has(h.id))
        assert.deepStrictEqual(tab!.messages.at(-1), { type: "present.dismiss", id: h.id })
      }
      assert.isUndefined(w.present.live().find((p) => p.id === h.id))
      assert.isTrue((yield* w.rows).find((r) => r.id === h.id)?.value.ended === true, "the row is marked ended")
      // A page that reconnects is not given it again; the module's handle answers as for a dismissed presentation.
      const again = yield* w.open("kitchen-display")
      assert.isFalse(w.holds(again).has(h.id))
      assert.isUndefined(yield* h.update(card("Dinner, later")))
      assert.isFalse(yield* h.dismiss)
      // Maintenance removes the row as for a module's dismissal.
      yield* w.advance(11_000)
      yield* w.present.maintainNow
      assert.isUndefined((yield* w.rows).find((r) => r.id === h.id))
    }))

  it.effect("is refused for a page that does not hold it: another device, an unknown id", () =>
    Effect.gen(function*() {
      const w = yield* world()
      const h = yield* w.board().show({ device: "kitchen-display" }, card("Mine"), { lifetime: "pinned" })
      yield* w.settle
      const other = yield* closeOn(w, "hall-screen", h.id, { revision: w.holds(w.firstTab("kitchen-display")).get(h.id)!.revision })
      assert.deepStrictEqual(other, { ok: false, say: "I can't do that right now.", code: "unknown" })
      const unknown = yield* closeOn(w, "kitchen-display", "p-none", { revision: "s:1" })
      assert.isFalse(unknown.ok)
      assert.isTrue(w.holds(w.firstTab("kitchen-display")).has(h.id))
      assert.isDefined(w.present.live().find((p) => p.id === h.id))
    }))

  it.effect("is refused where nothing may be pressed (a display without touch or a pointer), which is not offered a close", () =>
    Effect.gen(function*() {
      const w = yield* world({ outputs: new Map([["kitchen-display", { ...SCREEN, touch: false }]]) })
      const h = yield* w.board().show({ device: "kitchen-display" }, card("Look only"), { lifetime: "pinned" })
      yield* w.settle
      assert.strictEqual(w.holds(w.firstTab("kitchen-display")).get(h.id)!.closable, false)
      const answer = yield* closeOn(w, "kitchen-display", h.id)
      assert.isFalse(answer.ok)
      assert.isTrue(w.holds(w.firstTab("kitchen-display")).has(h.id))
    }))

  it.effect("does not close a keyed replacement the page has not drawn: refused with 'changed', the new content stays", () =>
    Effect.gen(function*() {
      const w = yield* world()
      const first = yield* w.board().show({ device: "kitchen-display" }, card("Old"), { lifetime: "pinned", key: "k" })
      yield* w.settle
      const seen = w.holds(w.firstTab("kitchen-display")).get(first.id)!.revision
      const second = yield* w.board().show({ device: "kitchen-display" }, card("New"), { lifetime: "pinned", key: "k" })
      yield* w.settle
      assert.strictEqual(second.id, first.id, "a key has one id")
      const answer = yield* closeOn(w, "kitchen-display", first.id, { revision: seen })
      assert.deepStrictEqual(answer, { ok: false, say: "That changed just now.", code: "unknown" })
      const held = w.holds(w.firstTab("kitchen-display")).get(first.id)!
      assert.strictEqual(held.content.kind === "card" ? held.content.title : "", "New")
      // A content update of the same show is not a new show: closing with the earlier revision of it works.
      const before = held.revision
      assert.isDefined(yield* second.update(card("Newer")))
      yield* w.settle
      assert.notStrictEqual(w.holds(w.firstTab("kitchen-display")).get(first.id)!.revision, before)
      assert.deepStrictEqual(yield* closeOn(w, "kitchen-display", first.id, { revision: before }), { ok: true })
      assert.isFalse(w.holds(w.firstTab("kitchen-display")).has(first.id))
    }))

  it.effect("one that has ended meanwhile: the page was sent its dismissal first, so the refusal brings nothing back", () =>
    Effect.gen(function*() {
      const w = yield* world()
      const h = yield* w.board().show({ device: "kitchen-display" }, card("Brief"), { lifetime: "transient", expiresInMs: 3_000 })
      yield* w.settle
      const tab = w.firstTab("kitchen-display")!
      const revision = w.holds(tab).get(h.id)!.revision
      yield* TestClock.adjust(3_000)
      yield* w.settle
      // Its end reached the page before the close could (one socket, in order); the close is answered as not held.
      assert.deepStrictEqual(tab.messages.at(-1), { type: "present.dismiss", id: h.id })
      const answer = yield* closeOn(w, "kitchen-display", h.id, { revision })
      assert.isFalse(answer.ok)
      assert.deepStrictEqual(tab.messages.at(-1), { type: "present.dismiss", id: h.id }, "nothing is sent again")
    }))

  it.effect("a tool's presentation (way 1) closes the same way and a newer show of its key is shown again", () =>
    Effect.gen(function*() {
      const w = yield* world()
      yield* w.toolOn("kitchen-display", { forModel: "OK", present: card("From a tool"), show: { lifetime: "pinned", key: "tool" } })
      yield* w.settle
      const [shown] = w.shownOn("kitchen-display")
      assert.isDefined(shown)
      assert.isTrue((yield* closeOn(w, "kitchen-display", shown!.id)).ok)
      assert.deepStrictEqual(w.shownOn("kitchen-display"), [])
      yield* w.toolOn("kitchen-display", { forModel: "OK", present: card("Again"), show: { lifetime: "pinned", key: "tool" } })
      yield* w.settle
      assert.deepStrictEqual(w.shownOn("kitchen-display").map((p) => p.content.kind === "card" ? p.content.title : ""), ["Again"])
    }))
})
