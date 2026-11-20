import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import type { ModulePresent, Presentation } from "../../src/Present.ts"
import type { MediaOutcome } from "../../src/PresentEngine.ts"
import { presentFaultyStore, presentPrepared, presentWorld } from "../../src/presentContract.ts"
import { makeMemoryHouseholdStore } from "../../src/testing.ts"

const yields = Effect.repeat(Effect.yieldNow, { times: 100 })
const image = (url: string, caption = "Photo"): Presentation => ({ kind: "image", url, caption, alt: "Picture", credit: "Example", spoken: "A picture." })

describe("presentation round 4", () => {
  for (const release of ["before", "after"] as const) {
    it.effect(`a1: returning to an image URL ignores its retired busy outcome released ${release} the new completion`, () => Effect.gen(function*() {
      const f = presentFaultyStore(yield* presentPrepared(makeMemoryHouseholdStore()))
      const oldWrite = yield* Deferred.make<void>()
      const newImage = yield* Deferred.make<{ hash: string }>()
      const otherImage = yield* Deferred.make<{ hash: string }>()
      const urlA = "https://example.org/a", urlB = "https://example.org/b"
      const calls: Array<string> = []
      const w = yield* presentWorld(f.store, { media: (url) => Effect.suspend((): Effect.Effect<MediaOutcome> => {
        calls.push(url)
        if (calls.length === 1) {
          // The cache's ordinary busy refusal; its successful store write waits while the handle is updated.
          f.gate.wait = oldWrite
          return Effect.succeed({ refused: "busy" as const })
        }
        return Deferred.await(url === urlA ? newImage : otherImage)
      }) })
      const h = yield* w.board().show({ device: "kitchen-display" }, image(urlA), { lifetime: "pinned", key: "photo" })
      yield* yields
      assert.isUndefined(f.gate.wait, "the old outcome's transaction is waiting")
      yield* h.update(image(urlB))
      yield* yields
      yield* h.update(image(urlA))
      yield* yields
      assert.deepStrictEqual(calls, [urlA, urlB, urlA])
      // Same-URL caption changes keep the pending completion and do not start another download.
      yield* h.update(image(urlA, "Latest caption"))
      yield* yields
      if (release === "before") {
        yield* Deferred.succeed(oldWrite, undefined)
        yield* yields
        const content = (yield* w.rows)[0]!.value.content
        assert.strictEqual(content.kind, "image")
        if (content.kind === "image") assert.isUndefined(content.failed)
      }
      yield* Deferred.succeed(newImage, { hash: "a".repeat(64) })
      yield* yields
      yield* Deferred.succeed(oldWrite, undefined)
      yield* Deferred.succeed(otherImage, { hash: "b".repeat(64) })
      yield* w.settle
      yield* w.advance(61_000)
      yield* w.present.maintainNow
      yield* w.settle
      const content = (yield* w.rows)[0]!.value.content
      assert.strictEqual(content.kind, "image")
      if (content.kind === "image") {
        assert.strictEqual(content.hash, "a".repeat(64))
        assert.strictEqual(content.caption, "Latest caption")
        assert.isUndefined(content.failed)
      }
      const page = w.shownOn("kitchen-display")[0]!.content
      assert.strictEqual(page.kind, "image")
      if (page.kind === "image") assert.strictEqual(page.image.state, "ready")
      assert.deepStrictEqual(calls, [urlA, urlB, urlA])
      assert.strictEqual(f.faults.failed, 0)
    }))
  }

  it.effect("a2: a hello before close reconciliation restores a live pin and uses a fresh press principal", () => Effect.gen(function*() {
    let present: ModulePresent | undefined
    let presses = 0
    const kit = yield* startTestModule(defineModule({ apiVersion: 2, id: "board", name: "Board", description: "Reconnect",
      shared: (ctx) => Effect.gen(function*() {
        present = ctx.present
        yield* present.handle("answer", { run: () => Effect.sync(() => { presses++; return { say: "OK" } }) }).pipe(Effect.orDie)
        return { value: undefined }
      }), start: () => Effect.succeed({})
    }))
    const device = "kitchen-display"
    const h = yield* present!.show({ device }, { kind: "card", title: "Shopping", spoken: "Shopping", handler: "answer", buttons: [{ id: "go", label: "Go" }] }, { lifetime: "pinned" })
    yield* kit.present.settle
    const original = kit.turn({ device }).connection!
    const closing = yield* Effect.forkChild(kit.notify.disconnect(device), { startImmediately: true })
    assert.lengthOf(kit.present.shown(device), 0, "the disconnected page clears immediately")
    yield* kit.notify.connect(device)
    yield* Fiber.join(closing)
    yield* kit.present.settle
    assert.deepStrictEqual(kit.present.shown(device).map((p) => p.id), [h.id])
    const current = kit.turn({ device }).connection!
    assert.notStrictEqual(current.id, original.id)
    assert.isUndefined(kit.people.deviceOfConnection(original))
    assert.strictEqual(kit.people.deviceOfConnection(current), device)
    assert.isFalse((yield* kit.present.engine.press({ deviceId: device, connection: original, presentationId: h.id, revision: kit.present.shown(device)[0]!.revision, action: "go" })).ok)
    assert.isTrue((yield* kit.present.press(h.id, "go")).ok)
    assert.strictEqual(presses, 1)
    yield* kit.notify.disconnect(device)
    yield* kit.notify.connect(device)
    assert.notStrictEqual(kit.turn({ device }).connection!.id, current.id)
    assert.lengthOf(kit.present.shown(device), 1)
  }))
})
