// Module API v2, review round 5 (p1-r5a): each test is the reviewer's sequence of events for one host finding the
// lead decided to fix, against the host as it is now.
import { assert, describe, it } from "@effect/vitest"
import { decodeServerMessage, encodeServerMessage, MAX_TEXT_FRAME_BYTES, type ModuleInfo } from "@pva/protocol"
import { exampleAdminSnapshot } from "@pva/protocol/examples"
import { Deferred, Effect, Fiber } from "effect"
import { makeIssueRegistry } from "../src/Issues.ts"
import { ServiceKey } from "../src/ModuleApi.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { type ModulePersistence, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"

const settle = Effect.repeat(Effect.yieldNow, { times: 50 })
const info = (host: { readonly modules: () => ReadonlyArray<ModuleInfo> }, id: string) => host.modules().find((m) => m.id === id)!

describe("a module on by its key keeps that across a stop and start (finding 1)", () => {
  it.effect("1: two saves with the vault locked, the second while the replacement starts: both stored on, and on again after a restart", () =>
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const entered = yield* Deferred.make<void>()
      const saves: Array<{ readonly place: unknown; readonly enabled: boolean }> = []
      const stored: Record<string, { enabled?: boolean; settings: Record<string, string> }> = {}
      let starts = 0
      const keyed = defineModule({
        id: "keyed",
        name: "Keyed",
        description: "",
        enabledByDefault: false,
        enabledWhenSet: "token",
        settings: { token: Setting.secret({ label: "Token" }), place: Setting.text({ label: "Place", default: "P1" }) },
        start: () =>
          Effect.gen(function*() {
            if (++starts === 2) {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(gate)
            }
            return {}
          })
      })
      const persistence: ModulePersistence = {
        initial: { modules: {}, secrets: { keyed: { token: "t" } } },
        save: (id, record) =>
          Effect.sync(() => {
            saves.push({ place: record.settings.place, enabled: record.enabled })
            stored[id] = { enabled: record.enabled, settings: record.settings as Record<string, string> }
          })
      }
      yield* Effect.scoped(Effect.gen(function*() {
        const host = yield* makeModuleHost({ catalog: [keyed], env: {}, persistence })
        yield* host.startEnabled
        assert.strictEqual(info(host, "keyed").state, "running")
        yield* host.setSecrets({})
        const first = yield* Effect.forkChild(host.configure("keyed", { values: { place: "P2" }, secrets: {} }))
        yield* Deferred.await(entered)
        const second = yield* Effect.forkChild(host.configure("keyed", { values: { place: "P3" }, secrets: {} }))
        yield* settle
        yield* Deferred.succeed(gate, undefined)
        assert.isTrue((yield* Fiber.join(first)).ok)
        assert.isTrue((yield* Fiber.join(second)).ok)
        assert.strictEqual(info(host, "keyed").state, "running")
        assert.isTrue(info(host, "keyed").enabled)
      }))
      assert.deepStrictEqual(saves, [{ place: "P2", enabled: true }, { place: "P3", enabled: true }])
      // The process starts again with the vault unlocked: the stored record has it on.
      const again = yield* makeModuleHost({ catalog: [keyed], env: {}, persistence: readOnlyPersistence({ modules: stored, secrets: { keyed: { token: "t" } } }) })
      yield* again.startEnabled
      assert.strictEqual(info(again, "keyed").state, "running")
      assert.isTrue(info(again, "keyed").enabled)
    }))
})

describe("settings that cannot be read stop what runs, even at the same fingerprint (finding 2)", () => {
  it.effect("2: a shared-only provider whose decoder starts throwing is withdrawn and down with its error; fixed, it starts and the failure is gone", () =>
    Effect.gen(function*() {
      const Live = ServiceKey<string>("r5.shared")
      const ordinary = Setting.text({ label: "Place", default: "Paris", overridable: true })
      const broken = { current: false }
      const provider = defineModule({
        apiVersion: 2,
        id: "provider",
        name: "Provider",
        description: "",
        settings: { place: { ...ordinary, decode: (raw: unknown) => {
          if (broken.current) throw new Error("decoder broke")
          return ordinary.decode(raw)
        } } },
        shared: () => Effect.succeed({ value: undefined, services: [Live.of("live")] }),
        start: () => Effect.succeed({})
      })
      const consumer = defineModule({ apiVersion: 2, id: "consumer", name: "Consumer", description: "", uses: ["provider"], start: () => Effect.succeed({}) })
      const host = yield* makeModuleHost({
        catalog: [provider, consumer],
        env: {},
        persistence: readOnlyPersistence({ modules: { provider: { settings: { place: "Paris" } } }, secrets: {} }),
        demand: () => new Map([["provider", []], ["consumer", [{ assistantId: "a" }]]])
      })
      yield* host.startEnabled
      assert.strictEqual(info(host, "provider").state, "running")
      assert.strictEqual(host.service(Live), "live")
      broken.current = true
      yield* host.refresh
      assert.strictEqual(info(host, "provider").state, "error")
      assert.match(info(host, "provider").error ?? "", /could not be read \(decoder broke\)/)
      assert.isUndefined(host.service(Live))
      assert.isTrue(host.issues.all().some((i) => i.module === "provider" && i.severity === "error"))
      broken.current = false
      yield* host.refresh
      assert.strictEqual(info(host, "provider").state, "running")
      assert.strictEqual(host.service(Live), "live")
      assert.isFalse(host.issues.all().some((i) => i.module === "provider"))
      assert.isTrue((yield* host.configure("provider", { values: { place: "Paris" }, secrets: {} })).ok)
    }))
})

describe("the enabling key is read without decoding the other settings (finding 3)", () => {
  it.effect("3: on by its key at start, another field's decoder throws: wanted and down with its settings error, not off", () =>
    Effect.gen(function*() {
      const ordinary = Setting.text({ label: "Place", default: "Paris" })
      const implicit = defineModule({
        id: "implicit",
        name: "Implicit",
        description: "",
        enabledByDefault: false,
        enabledWhenSet: "token",
        settings: { token: Setting.secret({ label: "Token" }), place: { ...ordinary, decode: () => {
          throw new Error("decoder broke")
        } } },
        start: () => Effect.succeed({})
      })
      const host = yield* makeModuleHost({
        catalog: [implicit],
        env: {},
        persistence: readOnlyPersistence({ modules: { implicit: { settings: { place: "Paris" } } }, secrets: { implicit: { token: "r5-implicit-token" } } })
      })
      yield* host.startEnabled
      const m = info(host, "implicit")
      assert.isTrue(m.enabled)
      assert.strictEqual(m.state, "error")
      assert.match(m.error ?? "", /could not be read \(decoder broke\)/)
      assert.isTrue(host.issues.all().some((i) => i.module === "implicit" && i.severity === "error"))
    }))
})

describe("a module's health issues are bounded by the registry alone (finding 4)", () => {
  const healthOf = (id: string, issues: ReadonlyArray<{ readonly severity: "error" | "warning" | "info"; readonly title: string }>) =>
    defineModule({
      id,
      name: id,
      description: "",
      health: () => Effect.succeed(issues.map((x, i) => ({ id: `i${i}`, detail: "", ...x }))),
      start: () => Effect.succeed({})
    })

  it.effect("4: twenty warnings then an error: the error is kept, first", () =>
    Effect.gen(function*() {
      const m = healthOf("m", [...Array.from({ length: 20 }, (_, i) => ({ severity: "warning" as const, title: `warning ${i}` })), { severity: "error", title: "the error" }])
      const host = yield* makeModuleHost({ catalog: [m], env: {}, persistence: readOnlyPersistence() })
      yield* host.startEnabled
      yield* host.checkHealth
      const all = host.issues.all()
      assert.strictEqual(all[0]!.title, "the error")
      assert.strictEqual(all.length, 21)
      assert.isFalse(all.some((i) => /more issues/.test(i.title)))
    }))

  it.effect("4: six modules each over the bound: the true number left out is said", () =>
    Effect.gen(function*() {
      const catalog = Array.from({ length: 6 }, (_, k) => healthOf(`m${k}`, Array.from({ length: 150 }, (_, i) => ({ severity: "error" as const, title: `error ${k}.${i}` }))))
      const host = yield* makeModuleHost({ catalog, env: {}, persistence: readOnlyPersistence() })
      yield* host.startEnabled
      yield* host.checkHealth
      const all = host.issues.all()
      assert.strictEqual(all.length, 100)
      assert.strictEqual(all.filter((i) => i.severity === "error").length, 99)
      assert.strictEqual(all.at(-1)!.title, `And ${6 * 150 - 99} more issues`)
    }))
})

// Review round 5 (p1-r5c finding 2): no schema change; the producer's template budget (128 KiB) is what keeps the admin
// snapshot inside a frame. The largest snapshot it can emit for templates, with a full Health payload, round-trips.
describe("the producer's template budget keeps the admin snapshot inside a frame (p1-r5c finding 2)", () => {
  it.effect("templates at every field maximum from many modules, all escaped, plus a full Health: encodes and decodes", () =>
    Effect.gen(function*() {
      const nul = (n: number) => "\u0000".repeat(n)
      const id = (k: number) => `m${String(k).padStart(2, "0")}-${"x".repeat(36)}`
      const catalog = Array.from({ length: 12 }, (_, k) =>
        defineModule({
          id: id(k),
          name: `Module ${k}`,
          description: "",
          templates: Array.from({ length: 8 }, (_, t) => ({
            id: `t${t}-${"y".repeat(37)}`,
            name: nul(32),
            prompt: nul(4000),
            purpose: nul(80),
            handles: nul(240),
            modules: Array.from({ length: 32 }, (_, j) => id((k + j) % 12)),
            suggestedPhrases: Array.from({ length: 8 }, () => nul(60))
          })),
          start: () => Effect.succeed({})
        }))
      const host = yield* makeModuleHost({ catalog, env: {}, persistence: readOnlyPersistence() })
      const modules = host.modules()
      const templates = modules.flatMap((m) => m.templates ?? [])
      const templateBytes = templates.reduce((n, t) => n + new TextEncoder().encode(JSON.stringify(t)).length, 0)
      // The budget is filled: what is offered is as large as the producer allows, and more was left out.
      assert.isAtMost(templateBytes, 128 * 1024)
      assert.isAbove(templateBytes, 128 * 1024 - 40 * 1024)
      assert.isBelow(templates.length, 12 * 8)
      const registry = makeIssueRegistry()
      registry.set("s", Array.from({ length: 150 }, (_, i) => ({
        id: `i${i}`,
        severity: "error" as const,
        title: nul(200),
        device: nul(200),
        detail: nul(2000),
        fix: { kind: "command" as const, label: nul(200), value: nul(1000) }
      })))
      const health = { issues: [...registry.all()], checking: false, checkedAt: 1 }
      const text = encodeServerMessage({ type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, modules: [...exampleAdminSnapshot.modules, ...modules], health } })
      assert.isAtMost(text.length, MAX_TEXT_FRAME_BYTES)
      assert.strictEqual(decodeServerMessage(text)._tag, "Ok")
    }))
})
