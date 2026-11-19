// The saved pin is the one state of a checklist (docs/modules/lists.md "Checklists"): one per device, found by its id,
// what is owed recorded in the row, reconciled by one function. Each case is a reproduction of review round 1
// (reports/modules/follow-lists-r1.md, findings 1 to 7), through the real host, Presenter and store of the test kit.
import { assert, describe, it } from "@effect/vitest"
import { type KnownDevice, PresentError, StoreError, type StoreTx } from "@pva/core"
import { startTestModule, type TestDevice } from "@pva/core/testing"
import { Clock, Deferred, Effect, Fiber } from "effect"
import { vi } from "vitest"
import { MEMBERS_MS, PIN_MS, retryIn } from "../src/checklist.ts"
import { pins } from "../src/data.ts"
import { listsModule } from "../src/index.ts"

vi.setConfig({ testTimeout: 30_000 })
const HOUR_MS = 3_600_000

const DEVICES: ReadonlyArray<TestDevice> = [
  { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
  { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
  { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null }
]
const HOUSEHOLD = { devices: DEVICES }

type Kit = Effect.Success<ReturnType<typeof startTestModule>>

/** The item texts a device's checklist holds (`undefined`: it holds none). */
const textsOn = (kit: Kit, device: string) =>
  (kit.present.shown(device)[0]?.content as { readonly items?: ReadonlyArray<{ readonly text: string }> } | undefined)?.items?.map((i) => i.text)
const pinRows = (kit: Kit) => kit.moduleStore().collection(pins).list({})
/** Take a device out of the household (as the admin's removal does): the kit's `Devices` and the Presenter read this list. */
const removeDevice = (kit: Kit, id: string) => {
  const devices = (kit as unknown as { readonly people: { readonly devices: { list: () => ReadonlyArray<KnownDevice> } } }).people.devices
  const all = devices.list
  devices.list = () => all().filter((d) => d.id !== id)
}

/** The lists module with its `shared` context changed by `wrap` (the fault injections below; loosely typed on purpose). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withShared = (wrap: (ctx: any) => any, after: (value: unknown) => void = () => {}) =>
  ({
    ...listsModule,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shared: (ctx: any) => listsModule.shared!(wrap(ctx)).pipe(Effect.tap((r) => Effect.sync(() => after(r.value))))
  }) as typeof listsModule

/** When the host ends a device's checklist (its live presentation's `expiresAt`). */
const endOn = (kit: Kit, device: string) =>
  kit.present.engine.live().find((p) => p.module === "lists" && "device" in p.target && p.target.device === device)?.expiresAt

/** The module with its pin removals refused while `refuse.on` (inside the transaction, as a busy store would). */
const refusingRemovals = (refuse: { on: boolean }) =>
  withShared((ctx) => ({
    ...ctx,
    store: {
      ...ctx.store,
      transaction: (body: (tx: StoreTx) => unknown) =>
        ctx.store.transaction((tx: StoreTx) =>
          body({
            ...tx,
            collection: (c) => {
              const h = tx.collection(c)
              return c.name !== "pins" ? h : {
                ...h,
                remove: (...args: Parameters<typeof h.remove>) => {
                  if (refuse.on) throw new StoreError({ reason: "busy", message: "injected busy pin removal" })
                  return h.remove(...args)
                }
              }
            }
          })
        )
    }
  }))

/** The module whose next `present.show` is refused `busy` once per `fail.count`. */
const refusingShows = (fail: { count: number }) =>
  withShared((ctx) => ({
    ...ctx,
    present: {
      ...ctx.present,
      show: (...args: ReadonlyArray<unknown>) =>
        Effect.suspend(() => {
          if (fail.count > 0) {
            fail.count--
            return Effect.fail(new PresentError({ reason: "busy", message: "injected busy show" }))
          }
          return ctx.present.show(...args)
        })
    }
  }))

describe("one pin per device, found by its id (finding 1)", () => {
  it.effect("removals that fail leave at most one row per device, which says 'remove me' and is removed by its next try; hide answers stay true", () =>
    Effect.gen(function*() {
      const refuse = { on: false }
      const kit = yield* startTestModule(refusingRemovals(refuse), { household: HOUSEHOLD })
      const names = Array.from({ length: 17 }, (_, i) => `packing ${String.fromCharCode(97 + i)}`)
      for (const name of names) yield* kit.tool("lists_create", { name })
      yield* kit.action("add", { items: "milk" })
      // Another device's checklist, which no amount of work on the kitchen display may hide from its own close.
      yield* kit.action("show", {}, { device: "hall-screen" })
      for (const name of names) {
        yield* kit.action("show", { list: name }, { device: "kitchen-display" })
        refuse.on = true
        const hidden = yield* kit.action("hide", { list: name }, { device: "kitchen-display" })
        // Taken down (the row's removal is owed, not the close): the answer says what happened.
        assert.deepStrictEqual(hidden, { ok: true, say: `Closed the ${name} list on this screen.` }, name)
        // One row per device, however many removals failed; the kitchen display's says it is to be removed.
        const rows = yield* pinRows(kit)
        assert.deepStrictEqual(rows.map((r) => [r.value.device, r.value.owed]).sort(), [["hall-screen", undefined], ["kitchen-display", "remove"]], name)
        assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
        refuse.on = false
      }
      // Its next try removes it, without a new change.
      const left = (yield* pinRows(kit)).find((r) => r.value.device === "kitchen-display")!.value
      yield* kit.advance(left.next! - (yield* Clock.currentTimeMillis))
      assert.deepStrictEqual((yield* pinRows(kit)).map((r) => r.value.device), ["hall-screen"])
      // The other device's pin was never out of reach: it follows its list and closes by name.
      yield* kit.action("add", { items: "eggs" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOn(kit, "hall-screen"), ["milk", "eggs"])
      assert.deepStrictEqual(yield* kit.action("hide", { list: "groceries" }, { device: "kitchen-display" }), { ok: true, say: "The shopping list isn't on this screen." })
      assert.deepStrictEqual(yield* kit.action("hide", { list: "groceries" }, { device: "hall-screen" }), { ok: true, say: "Closed the shopping list on this screen." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
      assert.deepStrictEqual(yield* kit.action("hide", {}, { device: "hall-screen" }), { ok: true, say: "I'm not showing any list on this screen." })
    }))
})

describe("a removed device (finding 2)", () => {
  it.effect("its checklist is dismissed and its pin removed at the next change of its list, freeing the host's slot", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      removeDevice(kit, "kitchen-display")
      yield* kit.action("add", { items: "milk" }, { device: "hall-screen" })
      yield* kit.present.settle
      assert.deepStrictEqual(yield* pinRows(kit), [])
      assert.deepStrictEqual(kit.present.engine.live().filter((p) => p.module === "lists"), [])
    }))

  it.effect("without any change it is found within a minute; eight screens' worth of slots come back and a new screen can show again", () =>
    Effect.gen(function*() {
      const screens: ReadonlyArray<TestDevice> = Array.from({ length: 9 }, (_, i) => ({ id: `screen-${i + 1}`, name: `Screen ${i + 1}`, room: `Room ${i + 1}`, privacy: "shared" }))
      const kit = yield* startTestModule(listsModule, { household: { devices: screens } })
      for (const screen of screens.slice(0, 8)) yield* kit.action("show", {}, { device: screen.id })
      yield* kit.present.settle
      assert.isFalse((yield* kit.action("show", {}, { device: "screen-9" })).ok)
      removeDevice(kit, "screen-1")
      yield* kit.advance(MEMBERS_MS)
      assert.strictEqual((yield* pinRows(kit)).length, 7)
      assert.strictEqual(kit.present.engine.live().filter((p) => p.module === "lists").length, 7)
      assert.deepStrictEqual(yield* kit.action("show", {}, { device: "screen-9" }), { ok: true, say: "Showing the shopping list on this screen." })
    }))
})

describe("an offline device (finding 3)", () => {
  it.effect("a change while its page is disconnected keeps the pin, and the page gets the checklist back, up to date, when it reconnects", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("add", { items: "milk" })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.notify.disconnect("kitchen-display")
      yield* kit.action("add", { items: "eggs" }, { device: "hall-screen" })
      yield* kit.present.settle
      const rows = yield* pinRows(kit)
      assert.strictEqual(rows.length, 1)
      assert.isUndefined(rows[0]!.value.owed)
      yield* kit.notify.connect("kitchen-display")
      yield* kit.present.settle
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), ["milk", "eggs"])
    }))
})

describe("a retry belongs to its pin (finding 4)", () => {
  it.effect("one failed show is tried again on its own, while a deletion of another list reaches its screen at once", () =>
    Effect.gen(function*() {
      const fail = { count: 0 }
      const kit = yield* startTestModule(refusingShows(fail), { household: HOUSEHOLD })
      yield* kit.tool("lists_create", { name: "camping", items: "tent" })
      yield* kit.action("show", { list: "camping" }, { device: "hall-screen" })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      fail.count = 1
      yield* kit.action("add", { items: "milk" })
      yield* kit.present.settle
      assert.strictEqual(fail.count, 0)
      // What is owed is in the row: the show, its attempts and its next try.
      const owed = (yield* pinRows(kit)).find((r) => r.value.device === "kitchen-display")!.value
      assert.deepStrictEqual([owed.owed, owed.attempts, owed.next], ["show", 1, (yield* Clock.currentTimeMillis) + retryIn(1)])
      yield* kit.tool("lists_delete", { list: "camping" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), [])
      // The failed one's own try, a few seconds later.
      yield* kit.advance(retryIn(1))
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), ["milk"])
      assert.isUndefined((yield* pinRows(kit)).find((r) => r.value.device === "kitchen-display")!.value.owed)
    }))
})

describe("a tick answers what was committed (finding 5)", () => {
  it.effect("a store that is busy right after the tick's commit changes nothing about the answer; the screen follows later", () =>
    Effect.gen(function*() {
      const busy = { on: false }
      let engine: { setStatus: (...args: Array<never>) => Effect.Effect<unknown, unknown> } | undefined
      const observed = withShared((ctx) => ({
        ...ctx,
        store: {
          ...ctx.store,
          collection: (c: { readonly name: string }) => {
            const h = ctx.store.collection(c)
            if (c.name !== "pins") return h
            const fail = <A, E>(read: Effect.Effect<A, E>): Effect.Effect<A, E | StoreError> => Effect.suspend((): Effect.Effect<A, E | StoreError> => (busy.on ? Effect.fail(new StoreError({ reason: "busy", message: "injected busy pin read" })) : read))
            return { ...h, get: (...a: ReadonlyArray<unknown>) => fail(h.get(...a)), list: (...a: ReadonlyArray<unknown>) => fail(h.list(...a)) }
          }
        }
      }), (value) => void (engine = value as never))
      const kit = yield* startTestModule(observed, { household: HOUSEHOLD })
      yield* kit.action("add", { items: "milk and eggs" })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      const shown = kit.present.shown("kitchen-display")[0]!
      const egg = (shown.content as { readonly items: ReadonlyArray<{ readonly id: string; readonly text: string }> }).items.find((i) => i.text === "eggs")!
      const setStatus = engine!.setStatus
      engine!.setStatus = (...args) => setStatus(...args).pipe(Effect.tap(() => Effect.sync(() => void (busy.on = true))))
      const r = yield* kit.present.press(shown.id, "tick", { device: "kitchen-display", item: egg.id, done: true })
      assert.deepStrictEqual(r, { ok: true, say: "Ticked off eggs on the shopping list." })
      busy.on = false
      assert.deepStrictEqual(yield* kit.action("read", { show: "done" }), { ok: true, say: "Ticked off on the shopping list: eggs." })
      yield* kit.advance(retryIn(1))
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), ["milk"])
      // A status write that fails is still refused as before: nothing was committed.
      engine!.setStatus = () => Effect.fail(new StoreError({ reason: "busy", message: "injected busy write" }))
      const milk = (kit.present.shown("kitchen-display")[0]!.content as { readonly items: ReadonlyArray<{ readonly id: string }> }).items[0]!
      const refused = yield* kit.present.press(kit.present.shown("kitchen-display")[0]!.id, "tick", { device: "kitchen-display", item: milk.id, done: true })
      assert.deepStrictEqual(refused, { ok: true, say: "The lists are busy just now; try again in a moment." })
    }))
})

describe("the end stays where it was put (finding 6)", () => {
  it.effect("a restart six hours in reacquires the checklist with what remains: the stored end and the host's end do not move, and it ends then", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      const until = (yield* pinRows(kit))[0]!.value.until
      const ends = endOn(kit, "kitchen-display")
      yield* kit.advance(6 * 3_600_000)
      yield* kit.restart
      yield* kit.present.settle
      assert.strictEqual((yield* pinRows(kit))[0]!.value.until, until)
      assert.strictEqual(endOn(kit, "kitchen-display"), ends)
      // Restarted again with less than the host's minimum left: left to end, not shown again for longer.
      yield* kit.advance(until - 2_000 - (yield* Clock.currentTimeMillis))
      yield* kit.restart
      yield* kit.present.settle
      assert.strictEqual(endOn(kit, "kitchen-display"), ends)
      yield* kit.advance(3_000)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.deepStrictEqual(yield* pinRows(kit), [])
    }))
})

describe("a live pin until its actual end (finding 7)", () => {
  it.effect("in its last seconds it still follows its list (with a new end), closes on request and goes when its list is deleted", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("add", { items: "milk" })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.advance(PIN_MS - 2_000)
      yield* kit.action("add", { items: "eggs" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), ["milk", "eggs"])
      const now = yield* Clock.currentTimeMillis
      assert.strictEqual((yield* pinRows(kit))[0]!.value.until, now + PIN_MS)
      // Two seconds before its (new) end: a close is a close.
      yield* kit.advance(PIN_MS - 2_000)
      assert.deepStrictEqual(yield* kit.action("hide", {}, { device: "kitchen-display" }), { ok: true, say: "Closed what I showed on this screen." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // And a deletion in the last seconds takes it down.
      yield* kit.tool("lists_create", { name: "camping", items: "tent" })
      yield* kit.action("show", { list: "camping" }, { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.advance(PIN_MS - 2_000)
      yield* kit.tool("lists_delete", { list: "camping" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.deepStrictEqual(yield* pinRows(kit), [])
    }))
})

// Review round 2 (reports/modules/follow-lists-r2.md): the row is written before the screen is touched, and a new
// signal is never erased by an older lookup.
describe("review round 2", () => {
  it.effect("a first show is owed before it is shown: interrupted right after the host accepted it, a restart finishes it and the checklist follows its list and closes", () =>
    Effect.gen(function*() {
      const accepted = yield* Deferred.make<void>()
      let interruptNext = true
      const kit = yield* startTestModule(withShared((ctx) => ({
        ...ctx,
        present: {
          ...ctx.present,
          show: (...args: ReadonlyArray<unknown>) =>
            ctx.present.show(...args).pipe(Effect.tap(() =>
              Effect.gen(function*() {
                if (!interruptNext) return
                interruptNext = false
                yield* Deferred.succeed(accepted, undefined)
                yield* Effect.never
              })
            ))
        }
      })), { household: HOUSEHOLD })
      yield* kit.action("add", { items: "milk" })
      const pending = yield* Effect.forkScoped(kit.action("show", {}, { device: "kitchen-display" }))
      yield* Deferred.await(accepted)
      yield* Fiber.interrupt(pending)
      yield* kit.present.settle
      // On the screen, and a row that says a show is owed.
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), ["milk"])
      assert.deepStrictEqual((yield* pinRows(kit)).map((r) => [r.value.device, r.value.owed]), [["kitchen-display", "show"]])
      yield* kit.restart
      yield* kit.present.settle
      assert.deepStrictEqual((yield* pinRows(kit)).map((r) => [r.value.device, r.value.owed]), [["kitchen-display", undefined]])
      yield* kit.action("add", { items: "eggs" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), ["milk", "eggs"])
      assert.deepStrictEqual(yield* kit.action("hide", {}, { device: "kitchen-display" }), { ok: true, say: "Closed what I showed on this screen." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("a new change signal is not erased by a lookup of pins that was already under way", () =>
    Effect.gen(function*() {
      const readDone = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let pauseNext = false
      const kit = yield* startTestModule(withShared((ctx) => ({
        ...ctx,
        store: {
          ...ctx.store,
          collection: (c: { readonly name: string }) => {
            const inner = ctx.store.collection(c)
            if (c.name !== "pins") return inner
            return {
              ...inner,
              list: (query: { readonly where?: { readonly list?: string } }) =>
                inner.list(query).pipe(Effect.flatMap((rows: ReadonlyArray<unknown>) =>
                  Effect.gen(function*() {
                    if (pauseNext && query.where?.list === "shopping" && rows.length === 0) {
                      pauseNext = false
                      yield* Deferred.succeed(readDone, undefined)
                      yield* Deferred.await(release)
                    }
                    return rows
                  })
                ))
            }
          }
        }
      })), { household: HOUSEHOLD })
      yield* kit.present.settle
      pauseNext = true
      yield* kit.action("add", { items: "milk" }, { device: "hall-screen" })
      yield* Deferred.await(readDone)
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.action("add", { items: "eggs" }, { device: "hall-screen" })
      yield* Deferred.succeed(release, undefined)
      yield* kit.present.settle
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), ["milk", "eggs"])
    }))

  it.effect("a changed content is recorded before it is shown: a failed write after the show does not renew the end at the retry", () =>
    Effect.gen(function*() {
      const refuse = { on: false }
      const kit = yield* startTestModule(withShared((ctx) => ({
        ...ctx,
        store: {
          ...ctx.store,
          transaction: (body: (tx: StoreTx) => unknown) =>
            ctx.store.transaction((tx: StoreTx) =>
              body({
                ...tx,
                collection: (c) => {
                  const h = tx.collection(c)
                  return c.name !== "pins" ? h : {
                    ...h,
                    // Only the write that clears the owed work (the one after the show) is refused.
                    update: (id: string, f: (v: any) => any, ...rest: Array<any>) => {
                      const cur = h.get(id)
                      if (refuse.on && cur !== undefined && f(cur.value).owed === undefined) {
                        refuse.on = false
                        throw new StoreError({ reason: "busy", message: "injected write after the show" })
                      }
                      return (h.update as any)(id, f, ...rest)
                    }
                  }
                }
              })
            )
        }
      })), { household: HOUSEHOLD })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.advance(HOUR_MS)
      refuse.on = true
      yield* kit.action("add", { items: "milk" })
      yield* kit.present.settle
      const changedAt = yield* Clock.currentTimeMillis
      assert.deepStrictEqual(textsOn(kit, "kitchen-display"), ["milk"])
      assert.strictEqual(endOn(kit, "kitchen-display"), changedAt + PIN_MS)
      assert.strictEqual((yield* pinRows(kit))[0]!.value.until, changedAt + PIN_MS)
      yield* kit.advance(retryIn(1))
      yield* kit.present.settle
      // The retry is the same content: the end did not move, and the owed show is cleared.
      assert.strictEqual(endOn(kit, "kitchen-display"), changedAt + PIN_MS)
      const row = (yield* pinRows(kit))[0]!.value
      assert.strictEqual(row.until, changedAt + PIN_MS)
      assert.strictEqual(row.owed, undefined)
    }))
})
