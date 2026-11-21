// `page.thirdPartyEmbeds` (docs/MODULES.md): validated like the other manifest fields, and read live from the host.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"

const embedder = defineModule({
  apiVersion: 2,
  id: "player",
  name: "Player",
  description: "Loads a third-party player",
  enabledByDefault: false,
  page: { thirdPartyEmbeds: true },
  start: () => Effect.succeed({})
})
const plain = defineModule({ apiVersion: 2, id: "plain", name: "Plain", description: "Nothing", enabledByDefault: false, start: () => Effect.succeed({}) })

describe("module manifest: page", () => {
  it("is accepted from apiVersion 2 and kept on the definition", () => {
    assert.deepStrictEqual(embedder.page, { thirdPartyEmbeds: true })
    assert.isUndefined(plain.page)
  })

  it("is refused for version 1, with an unknown field or a wrong type", () => {
    const make = (page: unknown, apiVersion = 2) => () =>
      defineModule({ apiVersion, id: "bad", name: "Bad", description: "x", page: page as never, start: () => Effect.succeed({}) } as never)
    assert.throws(make({ thirdPartyEmbeds: true }, 1), /page needs apiVersion 2/)
    assert.throws(make({ other: true }), /unknown field "other"/)
    assert.throws(make({ thirdPartyEmbeds: "yes" }), /must be true or false/)
    assert.throws(make(null), /page must be an object/)
    assert.doesNotThrow(make({}))
  })
})

describe("host.thirdPartyEmbeds", () => {
  it.effect("is true only while a module that declares it is enabled", () =>
    Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [embedder, plain], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      assert.isFalse(host.thirdPartyEmbeds())
      yield* host.enable("plain")
      assert.isFalse(host.thirdPartyEmbeds())
      yield* host.enable("player")
      assert.isTrue(host.thirdPartyEmbeds())
      yield* host.disable("player")
      assert.isFalse(host.thirdPartyEmbeds())
    }).pipe(Effect.scoped))
})
