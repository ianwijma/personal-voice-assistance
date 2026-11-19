// The single-fault sequences from the correctness review, at the store and Presenter boundaries.
import { assert, describe, it } from "@effect/vitest"
import { type ModulePresent, PresentError, StoreError, type StoreTx } from "@pva/core"
import { KIT_PAGE_CAPABILITIES, startTestModule } from "@pva/core/testing"
import { Lists } from "@pva/module-contracts"
import { Clock, Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import { CLOSE_MS, PIN_MS } from "../src/checklist.ts"
import { items, listPhrase, lists, pins } from "../src/data.ts"
import { listsModule } from "../src/index.ts"

vi.setConfig({ testTimeout: 30_000 })
type Kit = Effect.Success<ReturnType<typeof startTestModule>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wrap = (change: (ctx: any) => any) => ({ ...listsModule, shared: (ctx: any) => listsModule.shared!(change(ctx)) }) as typeof listsModule
const rows = (kit: Kit) => kit.moduleStore().collection(pins).list({})
const screen = (kit: Kit, device = "kitchen-display") =>
  (kit.present.shown(device)[0]?.content as { items?: ReadonlyArray<{ text: string }> } | undefined)?.items?.map((i) => i.text)
const end = (kit: Kit) => kit.present.engine.live().find((p) => p.module === "lists")?.expiresAt

// A transaction can commit even when its caller has been interrupted by an afterCommit callback.
const interruptCommit = (arm: { on: boolean }) => wrap((ctx) => ({ ...ctx, store: { ...ctx.store,
  transaction: (body: (tx: StoreTx) => unknown) => Effect.withFiber((fiber) => ctx.store.transaction((tx: StoreTx) => {
    const result = body(tx)
    if (arm.on) {
      arm.on = false
      tx.afterCommit(() => fiber.interruptUnsafe())
    }
    return result
  }))
} }))

describe("correctness review round 1", () => {
  it.effect("1: a phrase's whole item slot goes to shopping even when its suffix names another list", () => Effect.gen(function*() {
    const kit = yield* startTestModule(listsModule)
    yield* kit.tool("lists_create", { name: "oil" })
    assert.isTrue((yield* kit.phrases.say("add tuna in oil to the shopping list")).taken)
    assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Added tuna in oil to the shopping list.")
    assert.deepStrictEqual(yield* kit.action("read", { list: "oil" }), { ok: true, say: "The oil list is empty." })
    assert.deepStrictEqual(yield* kit.action("read", {}), { ok: true, say: "The shopping list has one thing: tuna in oil." })
  }))

  it.effect("2: interruption at a phrase's commit preserves its completed replay record", () => Effect.gen(function*() {
    const arm = { on: false }
    const kit = yield* startTestModule(interruptCommit(arm), { settings: { mergeDuplicates: false } })
    arm.on = true
    const who = { turnId: 991, source: "phrase" as const, device: "hall-screen" }
    yield* Fiber.await(yield* Effect.forkScoped(kit.action("add", { items: "milk" }, who)))
    assert.deepStrictEqual(yield* kit.action("add", { items: "milk" }, who), { ok: true, say: "Added milk to the shopping list." })
    assert.deepStrictEqual(yield* kit.action("read", {}), { ok: true, say: "The shopping list has one thing: milk." })
  }))

  it.effect("2: an interrupted phrase that never reached its transaction can retry", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    let arm = false
    const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, store: { ...ctx.store,
      collection: (c: { name: string }) => {
        const h = ctx.store.collection(c)
        return c.name !== "lists" ? h : { ...h, list: (...a: ReadonlyArray<unknown>) => Effect.suspend(() => {
          if (!arm) return h.list(...a)
          arm = false
          return Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)
        }) }
      }
    } })), { settings: { mergeDuplicates: false } })
    const who = { source: "phrase" as const, turnId: 992 }
    arm = true
    const pending = yield* Effect.forkScoped(kit.action("add", { items: "milk" }, who))
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(pending)
    assert.deepStrictEqual(yield* kit.action("add", { items: "milk" }, who), { ok: true, say: "Added milk to the shopping list." })
    assert.deepStrictEqual(yield* kit.action("read", {}), { ok: true, say: "The shopping list has one thing: milk." })
  }))

  it.effect("3: an accepted replacement interrupted before returning can be hidden with the same-key close", () => Effect.gen(function*() {
    const accepted = yield* Deferred.make<void>()
    let arm = false
    const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, present: { ...ctx.present,
      show: (...a: ReadonlyArray<unknown>) => ctx.present.show(...a).pipe(Effect.tap(() => Effect.gen(function*() {
        if (!arm) return
        arm = false
        yield* Deferred.succeed(accepted, undefined)
        yield* Effect.never
      })))
    } })))
    yield* kit.action("add", { items: "milk" })
    yield* kit.tool("lists_create", { name: "camping", items: "tent" })
    yield* kit.action("show", {})
    yield* kit.present.settle
    arm = true
    const pending = yield* Effect.forkScoped(kit.action("show", { list: "camping" }))
    yield* Deferred.await(accepted)
    yield* Fiber.interrupt(pending)
    yield* kit.action("hide", {})
    yield* kit.advance(CLOSE_MS)
    assert.isUndefined(screen(kit))
    assert.deepStrictEqual(yield* rows(kit), [])
  }))

  it.effect("3: a false dismiss result falls back to closing the current show under its key", () => Effect.gen(function*() {
    const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, present: { ...ctx.present,
      show: (...a: ReadonlyArray<unknown>) => ctx.present.show(...a).pipe(Effect.map((handle: { dismiss: unknown }) => ({ ...handle, dismiss: Effect.succeed(false) })))
    } })))
    yield* kit.action("add", { items: "milk" })
    yield* kit.action("show", {})
    yield* kit.present.settle
    yield* kit.action("hide", {})
    yield* kit.advance(CLOSE_MS)
    assert.isUndefined(screen(kit))
    assert.deepStrictEqual(yield* rows(kit), [])
  }))

  for (const operation of ["show", "hide"] as const) {
    it.effect(`4: a ${operation} interrupted at its intent commit is finished without another event`, () => Effect.gen(function*() {
      const arm = { on: false }
      const kit = yield* startTestModule(interruptCommit(arm))
      yield* kit.action("add", { items: "milk" })
      if (operation === "hide") yield* kit.action("show", {})
      yield* kit.present.settle
      arm.on = true
      yield* Fiber.await(yield* Effect.forkScoped(kit.action(operation, {})))
      yield* kit.advance(65_000)
      assert.deepStrictEqual(screen(kit), operation === "show" ? ["milk"] : undefined)
      assert.deepStrictEqual((yield* rows(kit)).map((r) => r.value.owed), operation === "show" ? [undefined] : [])
    }))
  }

  it.effect("4: a successful show returns while the worker's bookkeeping write is held", () => Effect.gen(function*() {
    const paused = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let arm = false
    const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx,
      present: { ...ctx.present, show: (...a: ReadonlyArray<unknown>) => ctx.present.show(...a).pipe(Effect.tap(() => Effect.sync(() => { arm = true }))) },
      store: { ...ctx.store, transaction: (body: (tx: StoreTx) => unknown) => Effect.suspend(() => {
        if (!arm) return ctx.store.transaction(body)
        arm = false
        return Effect.andThen(Deferred.succeed(paused, undefined), Effect.andThen(Deferred.await(release), ctx.store.transaction(body)))
      }) }
    })))
    const pending = yield* Effect.forkScoped(kit.action("show", {}))
    yield* Deferred.await(paused)
    yield* TestClock.adjust(5_001)
    const result = yield* Fiber.join(pending)
    // Always release our injected hold, including on an assertion failure.
    yield* Deferred.succeed(release, undefined)
    yield* kit.present.settle
    assert.deepStrictEqual(result, { ok: true, say: "Showing the shopping list on this screen." })
  }))

  it.effect("5: a committed edit wakes existing pins even if its caller is interrupted", () => Effect.gen(function*() {
    const arm = { on: false }
    const kit = yield* startTestModule(interruptCommit(arm))
    yield* kit.action("show", {})
    yield* kit.present.settle
    arm.on = true
    yield* Fiber.await(yield* Effect.forkScoped(kit.action("add", { items: "milk" }, { device: "hall-screen" })))
    yield* kit.advance(65_000)
    assert.deepStrictEqual(yield* kit.action("read", {}), { ok: true, say: "The shopping list has one thing: milk." })
    assert.deepStrictEqual(screen(kit), ["milk"])
  }))

  it.effect("6: deletion cancels existing pins even when undo precedes the worker's lookup", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let arm = false
    const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, store: { ...ctx.store,
      collection: (c: { name: string }) => {
        const h = ctx.store.collection(c)
        return c.name !== "pins" ? h : { ...h, list: (q: { where?: { list?: string } }) => h.list(q).pipe(Effect.tap(() => Effect.gen(function*() {
          if (!arm || q.where?.list === undefined) return
          arm = false
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }))) }
      }
    } })))
    yield* kit.tool("lists_create", { name: "camping", items: "tent" })
    yield* kit.action("show", { list: "camping" })
    yield* kit.present.settle
    arm = true
    yield* kit.tool("lists_delete", { list: "camping" })
    yield* Deferred.await(entered)
    yield* kit.action("undo", {})
    yield* Deferred.succeed(release, undefined)
    yield* kit.advance(65_000)
    assert.isUndefined(screen(kit))
    assert.deepStrictEqual(yield* rows(kit), [])
    yield* kit.restart
    yield* kit.action("show", { list: "camping" })
    yield* kit.present.settle
    assert.deepStrictEqual(screen(kit), ["tent"])
  }))

  it.effect("7: a refused replacement restores the previous pin and it can still be hidden by name", () => Effect.gen(function*() {
    let arm = false
    const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, present: { ...ctx.present,
      show: (...a: ReadonlyArray<unknown>) => Effect.suspend(() => {
        if (!arm) return ctx.present.show(...a)
        arm = false
        return Effect.fail(new PresentError({ reason: "busy", message: "injected refused replacement" }))
      })
    } })))
    yield* kit.action("add", { items: "milk" })
    yield* kit.tool("lists_create", { name: "camping", items: "tent" })
    yield* kit.action("show", {})
    yield* kit.present.settle
    arm = true
    assert.isFalse((yield* kit.action("show", { list: "camping" })).ok)
    yield* kit.advance(5_000)
    assert.deepStrictEqual(screen(kit), ["milk"])
    assert.deepStrictEqual(yield* kit.action("hide", { list: "shopping" }), { ok: true, say: "Closed the shopping list on this screen." })
    yield* kit.advance(CLOSE_MS)
    assert.isUndefined(screen(kit))
  }))

  for (const operation of ["show", "refresh", "restart"] as const) {
    it.effect(`8: ${operation} computes remaining lifetime after delayed reads and ends at the stored deadline`, () => Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let arm = false
      const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, store: { ...ctx.store,
        collection: (c: { name: string }) => {
          const h = ctx.store.collection(c)
          return c.name !== "pins" ? h : { ...h, get: (...a: ReadonlyArray<unknown>) => h.get(...a).pipe(Effect.tap(() => Effect.gen(function*() {
            if (!arm) return
            arm = false
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }))) }
        }
      } })))
      yield* kit.action("add", { items: "milk" })
      if (operation !== "show") yield* kit.action("show", {})
      yield* kit.present.settle
      arm = true
      const call = operation === "show" ? kit.action("show", {}) : operation === "restart" ? kit.restart : kit.action("add", { items: "eggs" })
      const pending = yield* Effect.forkScoped(call)
      yield* Deferred.await(entered)
      yield* TestClock.adjust(1_400)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(pending)
      yield* kit.present.settle
      const until = (yield* rows(kit))[0]!.value.until
      assert.strictEqual(end(kit), until)
      yield* kit.advance(until - (yield* Clock.currentTimeMillis))
      assert.isUndefined(screen(kit))
      assert.deepStrictEqual(yield* rows(kit), [])
    }))
  }

  it.effect("8: the deadline dismisses a handle whose host presentation is still live", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let arm = true
    const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, present: { ...ctx.present,
      show: (...a: ReadonlyArray<unknown>) => Effect.gen(function*() {
        // Simulate the host spending time inside show, after the module supplied the remaining lifetime.
        if (arm) {
          arm = false
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
        }
        return yield* ctx.present.show(...a)
      })
    } })))
    yield* kit.action("add", { items: "milk" })
    const pending = yield* Effect.forkScoped(kit.action("show", {}))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(1_400)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(pending)
    yield* kit.present.settle
    const until = (yield* rows(kit))[0]!.value.until
    assert.strictEqual(end(kit), until + 1_400)
    yield* kit.advance(until - (yield* Clock.currentTimeMillis))
    assert.isUndefined(screen(kit))
    assert.deepStrictEqual(yield* rows(kit), [])
  }))

  it.effect("9: an older failed lookup cannot postpone a newer deletion on another screen", () => Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let arm = false
    const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, store: { ...ctx.store,
      collection: (c: { name: string }) => {
        const h = ctx.store.collection(c)
        return c.name !== "pins" ? h : { ...h, list: (q: { where?: { list?: string } }) => Effect.suspend(() => {
          if (!arm || q.where?.list !== "shopping") return h.list(q)
          arm = false
          return Effect.gen(function*() {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return yield* Effect.fail(new StoreError({ reason: "busy", message: "injected old failed lookup" }))
          })
        }) }
      }
    } })))
    yield* kit.tool("lists_create", { name: "camping", items: "tent" })
    yield* kit.action("show", { list: "camping" }, { device: "hall-screen" })
    yield* kit.action("show", {})
    yield* kit.present.settle
    arm = true
    yield* kit.action("add", { items: "milk" })
    yield* Deferred.await(entered)
    yield* kit.tool("lists_delete", { list: "camping" })
    yield* Deferred.succeed(release, undefined)
    yield* kit.present.settle
    assert.isUndefined(screen(kit, "hall-screen"))
    assert.deepStrictEqual(screen(kit), ["milk"])
  }))

  it.effect("10: a tap attributes both the item and the count to its UI device", () => Effect.gen(function*() {
    const kit = yield* startTestModule(listsModule)
    yield* kit.action("add", { items: "milk" })
    yield* kit.action("show", {})
    yield* kit.present.settle
    const card = kit.present.shown()[0]!
    const id = (card.content as { items: ReadonlyArray<{ id: string }> }).items[0]!.id
    assert.deepStrictEqual(yield* kit.present.press(card.id, "tick", { item: id, done: true }), { ok: true, say: "Ticked off milk on the shopping list." })
    assert.deepStrictEqual((yield* kit.moduleStore().collection(items).get(id))!.updatedBy, { kind: "ui", deviceId: "kitchen-display" })
    assert.deepStrictEqual((yield* kit.moduleStore().collection(lists).get("shopping"))!.updatedBy, { kind: "ui", deviceId: "kitchen-display" })
  }))

  for (const language of ["en", "nl"] as const) {
    it.effect(`11: a screen full of other cards gets a truthful capacity refusal in ${language}`, () => Effect.gen(function*() {
      let present: ModulePresent | undefined
      const other = { apiVersion: 2 as const, id: "cards", name: "Cards", description: "Capacity fixture", enabledByDefault: true, settings: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        shared: (ctx: any) => Effect.sync(() => { present = ctx.present; return { value: undefined } }), start: () => Effect.succeed({}) }
      const kit = yield* startTestModule(listsModule, { others: [other], household: { home: { HOME_LANGUAGE: language === "nl" ? "nl-NL" : "en-GB" } } })
      for (let i = 0; i < 8; i++) yield* present!.show({ device: "kitchen-display" }, { kind: "card", title: `Card ${i}`, spoken: "Card" }, { key: `card${i}`, lifetime: "pinned" })
      const response = yield* kit.action("show", {})
      assert.isFalse(response.ok)
      assert.strictEqual("message" in response ? response.message : undefined, language === "en" ? "There isn't room to show this list right now; close something on a screen first." : "Er is nu geen ruimte om deze lijst te tonen; sluit eerst iets op een scherm.")
      assert.deepStrictEqual(yield* rows(kit), [])
    }))
  }
})

describe("correctness review round 2", () => {
  for (const operation of ["refused replacement", "press", "press without undo"] as const) {
    it.effect(`1–2: deletion still cancels the old pin during ${operation}`, () => Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let pause = false
      let refuse = false
      const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx,
        present: { ...ctx.present, show: (...a: ReadonlyArray<unknown>) => Effect.suspend(() => {
          if (!refuse) return ctx.present.show(...a)
          refuse = false
          return Effect.fail(new PresentError({ reason: "busy", message: "one refused replacement" }))
        }) },
        store: { ...ctx.store, collection: (c: { name: string }) => {
          const h = ctx.store.collection(c)
          return c.name !== "pins" ? h : { ...h, list: (q: { where?: { list?: string } }) => h.list(q).pipe(Effect.tap(() => Effect.gen(function*() {
            if (!pause || q.where?.list === undefined) return
            pause = false
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }))) }
        } }
      })))
      yield* kit.tool("lists_create", { name: "camping", items: "tent" })
      yield* kit.action("show", { list: "camping" })
      yield* kit.present.settle
      const card = kit.present.shown()[0]!
      const id = (card.content as { items: ReadonlyArray<{ id: string }> }).items[0]!.id
      pause = true
      yield* kit.tool("lists_delete", { list: "camping" })
      yield* Deferred.await(entered)
      if (operation !== "press without undo") yield* kit.action("undo", {})
      if (operation === "refused replacement") {
        refuse = true
        assert.isFalse((yield* kit.action("show", {})).ok)
        // Rewriting the old row must not turn its cancelled intent into a newer live pin.
        assert.strictEqual((yield* rows(kit))[0]!.value.owed, "dismiss")
      } else {
        assert.deepStrictEqual(yield* kit.present.press(card.id, "tick", { item: id, done: true }), { ok: true, say: operation === "press without undo" ? "That isn't on the list any more." : "That list isn't shown here any more." })
      }
      assert.strictEqual((yield* kit.moduleStore().collection(items).get(id))!.value.status, "open")
      yield* Deferred.succeed(release, undefined)
      yield* kit.advance(65_000)
      assert.isUndefined(screen(kit))
      assert.deepStrictEqual(yield* rows(kit), [])
      if (operation !== "press without undo") {
        assert.deepStrictEqual(yield* kit.action("read", { list: "camping" }), { ok: true, say: "The camping list has one thing: tent." })
        // Restoring data never restores the old card, but an explicit show is new intent.
        yield* kit.action("show", { list: "camping" })
        yield* kit.present.settle
        assert.deepStrictEqual(screen(kit), ["tent"])
      }
    }))
  }

  for (const language of ["en", "nl"] as const) {
    it.effect(`3: the ${language} screenless fallback preserves a whole identifying item`, () => Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: { home: { HOME_LANGUAGE: language === "en" ? "en-GB" : "nl-NL" }, devices: [
        { id: "kitchen-display", name: "Kitchen" },
        { id: "office-speaker", name: "Speaker", capabilities: { v: 1, speaker: { media: ["speech"] } } }
      ] } })
      const item = "replacement water filter cartridge for the upstairs refrigerator model RF27"
      yield* kit.action("add", { items: item })
      const read = yield* kit.action("read", {})
      const fallback = yield* kit.action("show", {}, { device: "office-speaker" })
      assert.isTrue(read.ok && fallback.ok)
      if (!read.ok || !fallback.ok) return
      assert.include(fallback.say!, read.say!)
      assert.include(fallback.say!, item)
      assert.isAtMost(fallback.say!.length, 300)
      yield* kit.present.settle
      assert.deepStrictEqual(yield* rows(kit), [])
    }))

    it.effect(`3: the ${language} fallback counts an item whose full quantity and name cannot fit`, () => Effect.gen(function*() {
      let spoken = ""
      const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, present: { ...ctx.present,
        show: (...a: ReadonlyArray<unknown>) => Effect.suspend(() => {
          spoken = (a[1] as { spoken: string }).spoken
          return ctx.present.show(...a)
        })
      } })), { household: { home: { HOME_LANGUAGE: language === "en" ? "en-GB" : "nl-NL" } } })
      const name = "x".repeat(40)
      const text = "y".repeat(200)
      yield* kit.tool("lists_create", { name, items: text })
      const item = (yield* kit.moduleStore().collection(items).list({}))[0]!
      yield* kit.moduleStore().collection(items).update(item.id, (v) => ({ ...v, quantity: { amount: 0.000001234567, unit: "u".repeat(20) } }))
      assert.isTrue((yield* kit.action("show", { list: name })).ok)
      assert.isAtMost(spoken.length, 300)
      assert.include(spoken, language === "en" ? "1 not read out." : "1 niet voorgelezen.")
      assert.notInclude(spoken, "…")
    }))

    it.effect(`3: the ${language} spoken budget counts omitted whole items and keeps the visual limit`, () => Effect.gen(function*() {
      let spoken = ""
      const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, present: { ...ctx.present,
        show: (...a: ReadonlyArray<unknown>) => Effect.suspend(() => {
          spoken = (a[1] as { spoken: string }).spoken
          return ctx.present.show(...a)
        })
      } })), { household: { home: { HOME_LANGUAGE: language === "en" ? "en-GB" : "nl-NL" } }, settings: { readItems: 10 } })
      const named = Array.from({ length: 5 }, (_, n) => `${"x".repeat(108)} model RF2${n}`)
      for (const item of named) yield* kit.action("add", { items: item })
      yield* kit.action("show", {})
      yield* kit.present.settle
      assert.isAtMost(spoken.length, 300)
      assert.include(spoken, named[0]!)
      assert.include(spoken, language === "en" ? "and 3 more" : "en nog 3")
      assert.notInclude(spoken, "…")
      assert.isTrue(screen(kit)!.every((text) => text.length <= 80 && text.endsWith("…")))
    }))
  }

  for (const owed of [false, true]) {
    it.effect(`5: an expired ${owed ? "owed show" : "pin"} never shows an empty replacement after a delayed read`, () => Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let pause = false
      let shows = 0
      const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx,
        present: { ...ctx.present, show: (...a: ReadonlyArray<unknown>) => Effect.suspend(() => {
          shows++
          return ctx.present.show(...a)
        }) },
        store: { ...ctx.store, collection: (c: { name: string }) => {
          const h = ctx.store.collection(c)
          return c.name !== "pins" ? h : { ...h, get: (...a: ReadonlyArray<unknown>) => h.get(...a).pipe(Effect.tap(() => Effect.gen(function*() {
            if (!pause) return
            pause = false
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }))) }
        } }
      })))
      yield* kit.action("add", { items: "milk" })
      yield* kit.action("show", {})
      yield* kit.present.settle
      const pin = (yield* rows(kit))[0]!
      if (owed) yield* kit.moduleStore().collection(pins).update(pin.id, (v) => ({ ...v, owed: "show" as const }))
      yield* kit.advance(pin.value.until - (yield* Clock.currentTimeMillis) - 1_000)
      pause = true
      yield* kit.advance(1_000)
      yield* Deferred.await(entered)
      yield* kit.advance(500)
      assert.isUndefined(screen(kit))
      yield* Deferred.succeed(release, undefined)
      yield* kit.present.settle
      assert.strictEqual(shows, 1)
      assert.isUndefined(screen(kit))
      assert.deepStrictEqual(yield* rows(kit), [])
    }))
  }
})


describe("correctness review round 3", () => {
  for (const path of ["initial", "refresh"] as const) {
    for (const close of ["retry", "hide", "no fault"] as const) {
      it.effect(`1: ${path} unsupported checklist retains dismissal work until ${close}`, () => Effect.gen(function*() {
        const kinds: Record<string, number> = { ...KIT_PAGE_CAPABILITIES.present!.kinds }
        const capabilities = { ...structuredClone(KIT_PAGE_CAPABILITIES), present: { ...KIT_PAGE_CAPABILITIES.present!, kinds } }
        const support = capabilities.present.kinds.list!
        let fail = false
        let faults = 0
        const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, present: { ...ctx.present,
          show: (...a: ReadonlyArray<unknown>) => ctx.present.show(...a).pipe(Effect.map((handle: { dismiss: Effect.Effect<boolean, PresentError> }) => ({ ...handle,
            dismiss: Effect.suspend(() => {
              if (!fail) return handle.dismiss
              fail = false
              faults++
              return Effect.fail(new PresentError({ reason: "busy", message: "one failed dismissal" }))
            })
          })))
        } })), { household: { devices: [{ id: "kitchen-display", name: "Kitchen", capabilities }] } })
        yield* kit.action("add", { items: "milk" })
        if (path === "refresh") {
          yield* kit.action("show", {})
          yield* kit.present.settle
        }
        delete capabilities.present.kinds.list
        fail = close !== "no fault"
        const answer = path === "initial" ? yield* kit.action("show", {}) : yield* kit.action("add", { items: "bread" })
        assert.isTrue(answer.ok)
        yield* kit.present.settle
        if (close !== "no fault") assert.strictEqual((yield* rows(kit))[0]!.value.owed, "dismiss")
        if (close === "hide") {
          const hidden = yield* kit.action("hide", {})
          assert.deepStrictEqual(hidden, { ok: true, say: "Closed what I showed on this screen." })
        }
        yield* kit.advance(65_000)
        assert.strictEqual(faults, close === "no fault" ? 0 : 1)
        assert.deepStrictEqual(yield* rows(kit), [])
        assert.strictEqual(kit.present.engine.live().length, 0)
        capabilities.present.kinds.list = support
        yield* kit.notify.disconnect("kitchen-display")
        yield* kit.notify.connect("kitchen-display")
        yield* kit.present.settle
        assert.isUndefined(screen(kit))
      }))
    }
  }

  for (const language of ["en", "nl"] as const) {
    for (const mark of ["\u200eeggs"] as const) {
      it.effect(`2: ${language} checklist and fallback keep an item sanitized from ${JSON.stringify(mark)}`, () => Effect.gen(function*() {
        const kinds: Record<string, number> = { ...KIT_PAGE_CAPABILITIES.present!.kinds }
        const capabilities = { ...structuredClone(KIT_PAGE_CAPABILITIES), present: { ...KIT_PAGE_CAPABILITIES.present!, kinds } }
        const kit = yield* startTestModule(listsModule, { household: {
          home: { HOME_LANGUAGE: language === "en" ? "en-GB" : "nl-NL" },
          devices: [{ id: "kitchen-display", name: "Kitchen", capabilities }]
        } })
        yield* kit.action("add", { items: "milk" })
        yield* kit.action("show", {})
        yield* kit.present.settle
        assert.isTrue((yield* kit.action("add", { items: mark })).ok)
        yield* kit.action("add", { items: "bread" })
        const item = (yield* kit.moduleStore().collection(items).list({})).find((r) => r.value.text === mark)!
        const label = "eggs"
        yield* kit.advance(65_000)
        assert.deepStrictEqual(screen(kit), ["milk", label, "bread"])
        assert.isTrue((yield* kit.action("show", {})).ok)
        yield* kit.present.settle
        const card = kit.present.shown()[0]!
        assert.include((card.content as { items: ReadonlyArray<{ id: string }> }).items.map((i) => i.id), item.id)
        delete capabilities.present.kinds.list
        const fallback = yield* kit.action("show", {})
        assert.isTrue(fallback.ok)
        if (fallback.ok) {
          assert.include(fallback.say!, label)
          assert.include(fallback.say!, language === "en" ? "3 things" : "3 dingen")
          assert.notInclude(fallback.say!, mark[0]!)
        }
        // Restore a screen and tick the item by its original item ID.
        capabilities.present.kinds.list = KIT_PAGE_CAPABILITIES.present!.kinds.list!
        yield* kit.action("show", {})
        yield* kit.present.settle
        yield* kit.present.press(kit.present.shown()[0]!.id, "tick", { item: item.id, done: true })
        yield* kit.present.settle
        assert.strictEqual((yield* kit.moduleStore().collection(items).get(item.id))!.value.status, "done")
        assert.deepStrictEqual(screen(kit), ["milk", "bread"])
        assert.strictEqual((yield* kit.moduleStore().collection(lists).get("shopping"))!.value.open, 2)
      }))
    }

    for (const undo of [true, false]) {
      it.effect(`3: ${language} replacement ${undo ? "omits a missing" : "keeps an existing"} list name`, () => Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let pause = false
        const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, store: { ...ctx.store,
          collection: (c: { name: string }) => {
            const h = ctx.store.collection(c)
            return c.name !== "pins" ? h : { ...h, list: (q: { where?: { list?: string } }) => h.list(q).pipe(Effect.tap(() => Effect.gen(function*() {
              if (!pause || q.where?.list === undefined) return
              pause = false
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }))) }
          }
        } })), { household: { home: { HOME_LANGUAGE: language === "en" ? "en-GB" : "nl-NL" } } })
        yield* kit.tool("lists_create", { name: "camping", items: "tent" })
        yield* kit.action("show", { list: "camping" })
        yield* kit.present.settle
        const id = (yield* rows(kit))[0]!.value.list
        if (undo) {
          pause = true
          yield* kit.action("undo", {})
          yield* Deferred.await(entered)
        }
        const shown = yield* kit.action("show", {})
        yield* Deferred.succeed(release, undefined)
        yield* kit.present.settle
        const ordinary = language === "en" ? "Showing the shopping list on this screen." : "De boodschappenlijst staat op dit scherm."
        const replaced = language === "en" ? "Showing the shopping list on this screen, instead of the camping list." : "De boodschappenlijst staat nu op dit scherm, in plaats van de lijst camping."
        assert.deepStrictEqual(shown, { ok: true, say: undo ? ordinary : replaced })
        if (shown.ok) assert.notInclude(shown.say!, id)
        assert.deepStrictEqual(screen(kit), [])
      }))
    }
  }
})


describe("correctness review round 4", () => {
  for (const path of ["initial", "refresh"] as const) for (const fault of [false, true]) {
    it.effect(`1: ${path} unsupported checklist closes with ${fault ? "one failed pin write" : "no fault"}`, () => Effect.gen(function*() {
      const kinds: Record<string, number> = { ...KIT_PAGE_CAPABILITIES.present!.kinds }
      const capabilities = { ...structuredClone(KIT_PAGE_CAPABILITIES), present: { ...KIT_PAGE_CAPABILITIES.present!, kinds } }
      const support = kinds.list!
      let accepted = false
      let faults = 0
      let dismissals = 0
      const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx,
        present: { ...ctx.present, show: (...a: ReadonlyArray<unknown>) => ctx.present.show(...a).pipe(Effect.map((h: { outcome: { devices: ReadonlyArray<{ why?: string }> }; dismiss: Effect.Effect<boolean, PresentError> }) => {
          if (h.outcome.devices.some((d) => d.why === "cannot-show-kind")) accepted = true
          return { ...h, dismiss: Effect.suspend(() => { dismissals++; return h.dismiss }) }
        })) },
        store: { ...ctx.store, transaction: (body: (tx: StoreTx) => unknown) => Effect.suspend(() => {
          if (fault && accepted && faults === 0) {
            faults++
            return Effect.fail(new StoreError({ reason: "busy", message: "one failed write after unsupported acceptance" }))
          }
          return ctx.store.transaction(body)
        }) }
      })), { household: { devices: [{ id: "kitchen-display", name: "Kitchen", capabilities }] } })
      yield* kit.action("add", { items: "milk" })
      if (path === "refresh") yield* kit.action("show", {})
      yield* kit.present.settle
      delete kinds.list
      const answer = path === "initial" ? yield* kit.action("show", {}) : yield* kit.action("add", { items: "bread" })
      yield* kit.present.settle
      kinds.list = support
      yield* kit.notify.disconnect("kitchen-display")
      yield* kit.notify.connect("kitchen-display")
      yield* kit.advance(65_000)
      assert.isTrue(answer.ok)
      if (path === "initial" && answer.ok) assert.strictEqual(answer.say, "This device can't show it. The shopping list has one thing: milk.")
      assert.strictEqual(faults, Number(fault))
      assert.isAtLeast(dismissals, 1)
      assert.deepStrictEqual(yield* rows(kit), [])
      assert.isUndefined(screen(kit))
      assert.strictEqual(kit.present.engine.live().length, 0)
    }))
  }

  for (const language of ["en", "nl"] as const) {
    for (const text of ["\u200e", "\u200f", "\u200eeggs"] as const) for (const path of ["add", "create", "service", "rename"] as const) {
      it.effect(`2: ${language} ${path} refuses an empty sanitized name ${JSON.stringify(text)}`, () => Effect.gen(function*() {
        const kit = yield* startTestModule(listsModule, { household: { home: { HOME_LANGUAGE: language } } })
        const valid = text.endsWith("eggs")
        if (path === "rename") {
          yield* kit.action("add", { items: "milk" })
          assert.strictEqual((yield* kit.tool("lists_update", { item: "milk", rename: text })).ok, valid)
          assert.deepStrictEqual((yield* kit.moduleStore().collection(items).list({})).map((r) => r.value.text), [valid ? text : "milk"])
          return
        }
        if (path === "service") {
          const result = yield* Effect.result(kit.service(Lists)!.addItem({ text, quantity: { amount: 2 } }))
          assert.strictEqual(result._tag, valid ? "Success" : "Failure")
          if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "invalid")
        } else if (path === "add") {
          assert.strictEqual((yield* kit.action("add", { items: text })).ok, valid)
        } else {
          const made = yield* kit.tool("lists_create", { name: "camping", items: text })
          assert.isTrue(made.ok)
          assert.strictEqual((yield* kit.moduleStore().collection(lists).list({})).some((r) => r.value.name === "camping"), valid)
        }
        assert.strictEqual((yield* kit.moduleStore().collection(items).list({})).length, valid ? 1 : 0)
      }))
    }

    it(`3: ${language} missing list phrase never uses its id`, () => {
      assert.strictEqual(listPhrase("616fd3a2-b0f3-4a44-b794-2396a5a8fb08", undefined, language), language === "en" ? "the list" : "de lijst")
    })

    for (const undo of [false, true]) {
      it.effect(`3: ${language} deferred hide ${undo ? "says the list is gone" : "keeps its list name"}`, () => Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let pause = false
        let refuse = false
        let faults = 0
        const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx,
          present: { ...ctx.present, show: (...a: ReadonlyArray<unknown>) => ctx.present.show(...a).pipe(Effect.map((h: { dismiss: Effect.Effect<boolean, PresentError> }) => ({ ...h, dismiss: Effect.suspend(() => {
            if (!refuse) return h.dismiss
            refuse = false
            faults++
            return Effect.fail(new PresentError({ reason: "busy", message: "one busy dismissal" }))
          }) }))) },
          store: { ...ctx.store, collection: (c: { name: string }) => {
            const h = ctx.store.collection(c)
            return c.name !== "pins" ? h : { ...h, list: (q: { where?: { list?: string } }) => h.list(q).pipe(Effect.tap(() => Effect.gen(function*() {
              if (!pause || q.where?.list === undefined) return
              pause = false
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }))) }
          } }
        })), { household: { home: { HOME_LANGUAGE: language } } })
        yield* kit.tool("lists_create", { name: "camping", items: "tent" })
        yield* kit.action("show", { list: "camping" })
        yield* kit.present.settle
        const id = (yield* rows(kit))[0]!.value.list
        if (undo) { pause = true; yield* kit.action("undo", {}); yield* Deferred.await(entered) }
        refuse = true
        const hidden = yield* kit.action("hide", {})
        yield* Deferred.succeed(release, undefined)
        yield* kit.advance(65_000)
        assert.strictEqual(faults, 1)
        assert.deepStrictEqual(hidden, { ok: true, say: undo
          ? language === "en" ? "That list is gone." : "Die lijst bestaat niet meer."
          : language === "en" ? "I'll take the camping list off this screen as soon as I can." : "Ik haal de lijst camping van dit scherm zodra dat kan." })
        if (hidden.ok) assert.notInclude(hidden.say!, id)
        assert.deepStrictEqual(yield* rows(kit), [])
        assert.isUndefined(screen(kit))
      }))

      it.effect(`3: ${language} closing card ${undo ? "says the list is gone" : "keeps its list name"}`, () => Effect.gen(function*() {
        const calls: Array<{ title: string; spoken: string; items: ReadonlyArray<unknown> }> = []
        const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx, present: { ...ctx.present,
          show: (...a: ReadonlyArray<unknown>) => { calls.push(a[1] as typeof calls[number]); return ctx.present.show(...a) }
        } })), { household: { home: { HOME_LANGUAGE: language } } })
        yield* kit.tool("lists_create", { name: "camping", items: "tent" })
        yield* kit.action("show", { list: "camping" })
        yield* kit.present.settle
        const pin = (yield* rows(kit))[0]!.value
        yield* kit.advance(pin.until - (yield* Clock.currentTimeMillis) - 2_000)
        yield* kit.restart
        yield* kit.present.settle
        yield* kit.action(undo ? "undo" : "hide", {})
        yield* kit.present.settle
        const closing = calls.at(-1)!
        assert.deepStrictEqual(closing.items, [])
        assert.strictEqual(closing.title, undo ? language === "en" ? "List" : "Lijst" : "camping")
        assert.strictEqual(closing.spoken, undo
          ? language === "en" ? "That list is gone." : "Die lijst bestaat niet meer."
          : language === "en" ? "The camping list isn't shown any more." : "De lijst camping wordt niet meer getoond.")
        assert.notInclude(closing.title + closing.spoken, pin.list)
        yield* kit.advance(CLOSE_MS)
        assert.isUndefined(screen(kit))
        assert.deepStrictEqual(yield* rows(kit), [])
      }))
    }
  }
})


describe("correctness review round 5", () => {
  for (const language of ["en", "nl"] as const) for (const supported of [true, false]) {
    it.effect(`1: ${language} ${supported ? "supported" : "unsupported"} show answers while post-acceptance bookkeeping is held`, () => Effect.gen(function*() {
      const kinds: Record<string, number> = { ...KIT_PAGE_CAPABILITIES.present!.kinds }
      const capabilities = { ...structuredClone(KIT_PAGE_CAPABILITIES), present: { ...KIT_PAGE_CAPABILITIES.present!, kinds } }
      if (!supported) delete kinds.list
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let accepted = false
      let holds = 0
      let dismissals = 0
      const kit = yield* startTestModule(wrap((ctx) => ({ ...ctx,
        present: { ...ctx.present, show: (...a: ReadonlyArray<unknown>) => ctx.present.show(...a).pipe(Effect.map((handle: { dismiss: Effect.Effect<boolean, PresentError> }) => {
          accepted = true
          return { ...handle, dismiss: Effect.suspend(() => { dismissals++; return handle.dismiss }) }
        })) },
        store: { ...ctx.store, transaction: (body: (tx: StoreTx) => unknown) => Effect.suspend(() => {
          if (!accepted || holds > 0) return ctx.store.transaction(body)
          holds++
          return Effect.andThen(Deferred.succeed(entered, undefined), Effect.andThen(Deferred.await(release), ctx.store.transaction(body)))
        }) }
      })), { household: { home: { HOME_LANGUAGE: language }, devices: [{ id: "kitchen-display", name: "Kitchen", capabilities }] } })
      yield* kit.action("add", { items: "milk" })
      const pending = yield* Effect.forkScoped(kit.action("show", {}))
      yield* Deferred.await(entered)
      yield* TestClock.adjust(5_001)
      const answer = yield* Fiber.join(pending)
      yield* Deferred.succeed(release, undefined)
      yield* kit.advance(65_000)
      assert.strictEqual(holds, 1)
      assert.deepStrictEqual(answer, { ok: true, say: supported
        ? language === "en" ? "Showing the shopping list on this screen." : "De boodschappenlijst staat op dit scherm."
        : language === "en" ? "This device can't show it. The shopping list has one thing: milk." : "Dit apparaat kan het niet tonen. Op de boodschappenlijst staat één ding: milk." })
      assert.strictEqual(dismissals, supported ? 0 : 1)
      assert.strictEqual((yield* rows(kit)).length, supported ? 1 : 0)
      assert.strictEqual(kit.present.engine.live().length, supported ? 1 : 0)
    }))
  }
})
