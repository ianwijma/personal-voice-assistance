// `host.credentials` (docs/MODULES.md): a module's own secrets, per-module namespace, limits, locked and unavailable,
// and the test kit's in-memory store.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { makeMemoryCredentialStore, type ModuleCredentials } from "../src/ModuleCredentials.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { startTestModule } from "../src/testing.ts"

const probe = (id: string, sink: { credentials?: ModuleCredentials }) =>
  defineModule({
    apiVersion: 2,
    id,
    name: id,
    description: "Keeps credentials",
    shared: ({ host }) => Effect.sync(() => {
      sink.credentials = host.credentials
      return { value: undefined }
    }),
    start: () => Effect.succeed({})
  })

const reasonOf = <A>(e: Effect.Effect<A, { readonly reason: string }>) =>
  Effect.map(Effect.exit(e), (x) => (Exit.isFailure(x) ? JSON.stringify(x.cause).match(/"reason":"([a-z]+)"/)?.[1] : "ok"))

describe("host.credentials in the test kit", () => {
  it.effect("keeps a value in memory, per module, and the kit exposes the store", () =>
    Effect.gen(function*() {
      const store = makeMemoryCredentialStore()
      const one: { credentials?: ModuleCredentials } = {}
      const two: { credentials?: ModuleCredentials } = {}
      const kit1 = yield* startTestModule(probe("alpha", one), { credentials: store })
      yield* startTestModule(probe("beta", two), { credentials: store })
      assert.strictEqual(kit1.credentials, store)
      assert.isUndefined(yield* one.credentials!.get("token"))
      yield* one.credentials!.set("token", "s3cret")
      assert.strictEqual(yield* one.credentials!.get("token"), "s3cret")
      assert.isUndefined(yield* two.credentials!.get("token"))
      assert.deepStrictEqual(store.dump(), { "alpha/token": "s3cret" })
      assert.isTrue(yield* one.credentials!.clear("token"))
      assert.isFalse(yield* one.credentials!.clear("token"))
    }))

  it.effect("judges the name and the size of the value, and the count of names", () =>
    Effect.gen(function*() {
      const sink: { credentials?: ModuleCredentials } = {}
      yield* startTestModule(probe("alpha", sink))
      const c = sink.credentials!
      assert.strictEqual(yield* reasonOf(c.set("Bad", "x")), "invalid")
      assert.strictEqual(yield* reasonOf(c.get("1abc")), "invalid")
      assert.strictEqual(yield* reasonOf(c.set("a".repeat(33), "x")), "invalid")
      assert.strictEqual(yield* reasonOf(c.set("ok", "x".repeat(4097))), "invalid")
      assert.strictEqual(yield* reasonOf(c.set("ok", "x".repeat(4096))), "ok")
      for (let i = 1; i < 8; i++) yield* c.set(`n${i}`, "v")
      assert.strictEqual(yield* reasonOf(c.set("n9", "v")), "limit")
      assert.strictEqual(yield* reasonOf(c.set("n1", "again")), "ok")
    }))

  it.effect("a locked store fails get with `locked`, which is not the same as unset", () =>
    Effect.gen(function*() {
      const store = makeMemoryCredentialStore()
      const sink: { credentials?: ModuleCredentials } = {}
      yield* startTestModule(probe("alpha", sink), { credentials: store })
      yield* sink.credentials!.set("token", "s3cret")
      store.lock()
      assert.strictEqual(yield* reasonOf(sink.credentials!.get("token")), "locked")
      assert.strictEqual(yield* reasonOf(sink.credentials!.get("missing")), "locked")
      store.unlock()
      assert.strictEqual(yield* sink.credentials!.get("token"), "s3cret")
      assert.isUndefined(yield* sink.credentials!.get("missing"))
    }))
})
