import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { ToolError } from "../src/Errors.ts"
import { type AssistantModule, makeTool } from "../src/Module.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"

const add = makeTool({
  name: "add",
  description: "Add two numbers",
  parameters: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
  speculative: true,
  execute: ({ a, b }) => Effect.succeed({ sum: a + b })
})

const fail = makeTool({
  name: "fail",
  description: "Always fails",
  parameters: Schema.Struct({}),
  execute: () => Effect.fail(new ToolError({ message: "nope" }))
})

const crash = makeTool({
  name: "crash",
  description: "Dies",
  parameters: Schema.Struct({}),
  execute: () => Effect.die("boom")
})

const math: AssistantModule = {
  name: "math",
  tools: [add, fail, crash],
  context: [{ name: "Math", get: Effect.succeed("Numbers are fun.") }]
}
const other: AssistantModule = { name: "other", context: [{ name: "Other", get: Effect.succeed("x") }] }

describe("ToolRegistry", () => {
  const registry = makeToolRegistry([math, other])

  it("derives tool specs with JSON Schema from the parameter schema", () => {
    const spec = registry.specs.find((s) => s.name === "add")!
    assert.strictEqual(spec.description, "Add two numbers")
    assert.strictEqual(spec.inputSchema.type, "object")
    assert.deepStrictEqual(spec.inputSchema.required, ["a", "b"])
    assert.deepStrictEqual((spec.inputSchema.properties as any).a, { type: "number" })
    assert.strictEqual(registry.specs.length, 3)
  })

  it("knows which tools are speculative (default false)", () => {
    assert.isTrue(registry.isSpeculative("add"))
    assert.isFalse(registry.isSpeculative("fail"))
    assert.isFalse(registry.isSpeculative("missing"))
  })

  it.effect("decodes input and runs the tool", () =>
    Effect.gen(function*() {
      const result = yield* registry.run({ id: "1", name: "add", input: { a: 2, b: 3 } })
      assert.deepStrictEqual(result, { id: "1", name: "add", content: "{\"sum\":5}", isError: false })
    }))

  it.effect("schema decoding failures become error results for the model", () =>
    Effect.gen(function*() {
      const result = yield* registry.run({ id: "2", name: "add", input: { a: "two" } })
      assert.isTrue(result.isError)
      assert.match(result.content, /^Invalid input/)
    }))

  it.effect("tool failures, defects and unknown tools become error results", () =>
    Effect.gen(function*() {
      const failed = yield* registry.run({ id: "3", name: "fail", input: {} })
      assert.deepStrictEqual(failed, { id: "3", name: "fail", content: "nope", isError: true })
      const crashed = yield* registry.run({ id: "4", name: "crash", input: {} })
      assert.isTrue(crashed.isError)
      const unknown = yield* registry.run({ id: "5", name: "nothing", input: {} })
      assert.isTrue(unknown.isError)
    }))

  it.effect("gathers context-provider output for the system prompt", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* registry.context, "## Math\nNumbers are fun.\n\n## Other\nx")
      assert.strictEqual(yield* makeToolRegistry([]).context, "")
    }))

  it("rejects duplicate tool names", () => {
    assert.throws(() => makeToolRegistry([math, { name: "again", tools: [add] }]), /Duplicate tool/)
  })
})

describe("ToolRegistry: review finding 11", () => {
  const throwsSync = makeTool({
    name: "throws",
    description: "Throws while building its effect",
    parameters: Schema.Struct({}),
    execute: () => {
      throw new Error("built badly")
    }
  })
  const blocks = makeTool({ name: "blocks", description: "Never finishes", parameters: Schema.Struct({}), execute: () => Effect.never })
  const registry = makeToolRegistry([{ name: "bad", tools: [throwsSync, blocks] }])

  it.effect("a tool that throws before returning its effect becomes an error result", () =>
    Effect.gen(function*() {
      const result = yield* registry.run({ id: "1", name: "throws", input: {} })
      assert.isTrue(result.isError)
      assert.match(result.content, /built badly/)
    }))

  it.effect("interruption stays interruption (not an error result)", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(registry.run({ id: "2", name: "blocks", input: {} }))
      yield* Effect.yieldNow
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
    }))
})
