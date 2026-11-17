// Review round 4 of PR 90 (P3 in the module host): the boundary's matcher cache cannot collide, host diagnostics are
// matched whole before they are shortened, and a redacted route path stays within the wire's bound.
import { assert, describe, it } from "@effect/vitest"
import { ModuleInfo } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import type { ModuleRoute } from "../src/ModuleRoutes.ts"
import { makePageBoundary, REDACTED } from "../src/PageBoundary.ts"
import { Setting } from "../src/Settings.ts"

const ok: ModuleRoute["handler"] = () => Effect.succeed({ status: 200 })

describe("the boundary's matcher cache (4a-1)", () => {
  it("a list of current values that joins like another one still gets its own matcher", () => {
    let current: ReadonlyArray<string> = ["needle\u0000needle", "needle\u0000needle"]
    const b = makePageBoundary({ current: () => current })
    // Warm the cache with the first list.
    assert.strictEqual(b.redact("m", "a needle b"), "a needle b")
    // Joined with NUL these two lists are the same text; the second makes "needle" a current secret.
    current = ["needle", "needle", "needle", "needle"]
    assert.strictEqual(b.redact("m", "a needle b"), `a ${REDACTED} b`)
  })

  it.effect("through the host: a disabled module's two secret fields whose values collide when joined", () =>
    Effect.gen(function*() {
      const settings = { one: Setting.secret({ label: "One" }), two: Setting.secret({ label: "Two" }) }
      const mod = defineModule({ id: "pair", name: "Pair", description: "Two keys", settings, start: () => Effect.succeed({}) })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { pair: { enabled: false } }, secrets: { pair: { one: "needle\u0000needle" } } }),
        env: {}
      })
      assert.strictEqual(host.pageText("pair", "a needle b", 100), "a needle b")
      // Saved (wanted and shown) the lists the host reports are duplicates, as the review describes; nothing is
      // given to module code, so no holder changes.
      assert.isTrue((yield* host.configure("pair", { values: {}, secrets: { one: "needle", two: "needle" } })).ok)
      assert.strictEqual(host.pageText("pair", "a needle b", 100), `a ${REDACTED} b`)
    }))
})

describe("host diagnostics are matched whole before they are shortened (4a-4)", () => {
  const SECRET = "prefix-part\nsuffix-part"
  const key = { key: Setting.secret({ label: "Key", required: true }) }

  it.effect("a start that crashes with a multi-line secret in its message", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "crash",
        name: "Crash",
        description: "Throws its key",
        settings: key,
        start: ({ settings }) =>
          Effect.sync(() => {
            throw new Error(String(settings.key))
          })
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { crash: { enabled: true } }, secrets: { crash: { key: SECRET } } }),
        env: {}
      })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "error")
      assert.strictEqual(info.error, `The module crashed while starting: Error: ${REDACTED}`)
      const everything = JSON.stringify([host.modules(), host.issues.all()])
      assert.notInclude(everything, "prefix-part")
      assert.notInclude(everything, "suffix-part")
    }))

  it.effect("a health check that fails with a multi-line secret in its message", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "sick",
        name: "Sick",
        description: "Fails its health check with its key",
        settings: key,
        health: ({ settings }) =>
          Effect.sync(() => {
            throw new Error(String(settings.key))
          }),
        start: () => Effect.succeed({})
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { sick: { enabled: true } }, secrets: { sick: { key: SECRET } } }),
        env: {}
      })
      yield* host.startEnabled
      yield* host.checkHealth
      const issue = host.issues.all().find((i) => i.id === "sick.health")
      assert.strictEqual(issue?.detail, `Error: ${REDACTED}`)
      assert.notInclude(JSON.stringify(host.issues.all()), "prefix-part")
    }))

  it("a text-list item that is too long is not quoted in the error", () => {
    const list = Setting.textList({ label: "Names", itemMaxLength: 10 })
    const decoded = list.decode(["fine", "a-secret-pasted-here"])
    assert.isFalse(decoded.ok)
    assert.strictEqual(decoded.ok ? "" : decoded.error, "Item 2 is longer than 10 characters")
  })
})

describe("a redacted route path stays within the wire's bound (4a-7)", () => {
  it.effect("a short secret repeated in a long path: the shown path is bounded and the projection encodes", () =>
    Effect.gen(function*() {
      const segment = "ab".repeat(30)
      const path = `${segment}/${segment}/${segment}`
      const mod = defineModule({
        apiVersion: 2,
        id: "long",
        name: "Long",
        description: "A long path",
        settings: { key: Setting.secret({ label: "Key" }) },
        shared: () => Effect.succeed({ value: undefined, routes: [{ method: "GET", path, public: true, handler: ok }] }),
        start: () => Effect.succeed({})
      })
      const host = yield* makeModuleHost({
        catalog: [mod],
        persistence: readOnlyPersistence({ modules: { long: { enabled: true } }, secrets: { long: { key: "a" } } }),
        env: {}
      })
      yield* host.startEnabled
      const info = host.modules()[0]!
      const shown = info.routes![0]!.path
      assert.isAtMost(shown.length, 300)
      assert.isTrue(shown.startsWith(`/api/modules/long/${REDACTED}b${REDACTED}b`))
      assert.notMatch(shown.slice("/api/modules/long/".length).replaceAll(REDACTED, ""), /a/)
      // The module's update encodes (it did not: the expanded path was 829 characters).
      assert.isTrue(Schema.is(ModuleInfo)(info))
      Schema.encodeUnknownSync(ModuleInfo)(info)
      assert.isAtMost(host.routeView("long", host.routes()[0]!.route).path.length, 300)
      // The live path is unchanged.
      assert.strictEqual(host.routes()[0]!.route.path, path)
    }))
})
