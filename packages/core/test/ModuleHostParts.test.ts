import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { makeTool } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, type ModulePersistence } from "../src/ModuleHost.ts"

const persistence: ModulePersistence = { initial: { modules: {}, secrets: {} }, save: () => Effect.void }

const moduleWith = (id: string, options: { readonly tool?: string; readonly instructions?: string; readonly context?: string; readonly on?: boolean }) =>
  defineModule({
    id,
    name: id.toUpperCase(),
    description: "A test module",
    enabledByDefault: options.on ?? true,
    start: () =>
      Effect.succeed({
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        tools: options.tool === undefined ? [] : [makeTool({
          name: options.tool,
          description: "tool",
          parameters: Schema.Struct({}),
          execute: () => Effect.succeed(`${id} ran`)
        })],
        context: options.context === undefined ? [] : [{ name: `${id}-ctx`, get: Effect.succeed(options.context) }]
      })
  })

describe("ModuleHost snapshot.parts (one entry per running module)", () => {
  it.effect("lists the running modules in registry order, with each one's tools, context and trimmed instructions", () =>
    Effect.gen(function*() {
      const host = yield* makeModuleHost({
        catalog: [
          moduleWith("alpha", { tool: "a_tool", instructions: "  Be brief.  ", context: "alpha context" }),
          moduleWith("off", { tool: "off_tool", on: false }),
          moduleWith("bravo", { tool: "b_tool" })
        ],
        persistence,
        env: {}
      })
      yield* host.startEnabled
      const snap = host.snapshot()
      assert.deepStrictEqual(snap.parts.map((p) => p.moduleId), ["alpha", "bravo"])
      const [alpha, bravo] = snap.parts
      assert.strictEqual(alpha!.module.name, "alpha", "the part's module is named by the module id")
      assert.deepStrictEqual((alpha!.module.tools ?? []).map((t) => t.name), ["a_tool"])
      assert.strictEqual(alpha!.instructions, "Be brief.", "instructions are trimmed")
      assert.strictEqual(bravo!.instructions, "", "no instructions: the empty string")
      assert.deepStrictEqual((bravo!.module.tools ?? []).map((t) => t.name), ["b_tool"])
      // The snapshot-wide views are the parts put together.
      assert.deepStrictEqual(snap.registry.specs.map((s) => s.name), ["a_tool", "b_tool"])
      assert.deepStrictEqual(snap.instructions, ["Be brief."], "a module without instructions adds none")
    }).pipe(Effect.scoped))

  it.effect("no module running: no parts", () =>
    Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [moduleWith("idle", { tool: "t", on: false })], persistence, env: {} })
      yield* host.startEnabled
      assert.deepStrictEqual(host.snapshot().parts, [])
    }).pipe(Effect.scoped))

  it.effect("disabling a module removes its part from the next snapshot, and a held snapshot keeps it", () =>
    Effect.gen(function*() {
      const host = yield* makeModuleHost({
        catalog: [moduleWith("alpha", { tool: "a_tool" }), moduleWith("bravo", { tool: "b_tool" })],
        persistence,
        env: {}
      })
      yield* host.startEnabled
      const held = host.snapshot()
      yield* host.disable("alpha")
      assert.deepStrictEqual(host.snapshot().parts.map((p) => p.moduleId), ["bravo"])
      assert.deepStrictEqual(held.parts.map((p) => p.moduleId), ["alpha", "bravo"])
    }).pipe(Effect.scoped))
})
