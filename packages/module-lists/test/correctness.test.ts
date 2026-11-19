// The single-fault sequences from the correctness review, at the store and Presenter boundaries.
import { assert, describe, it } from "@effect/vitest"
import { type ModulePresent, PresentError, StoreError, type StoreTx } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Clock, Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import { CLOSE_MS, PIN_MS } from "../src/checklist.ts"
import { items, lists, pins } from "../src/data.ts"
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
