// Review round 2, finding 5: the CLI modes read the module set at every turn's start, through the same host and
// gateway as serve mode, so a restarted module's new tools and a module that became unavailable are what the next
// turn sees, and an old turn's tool is refused once its part has closed.
import { assert, it } from "@effect/vitest"
import { defineModule, makeTool, type ModuleHostApi, readOnlyPersistence } from "@pva/core"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { startCliModules } from "../src/modules.ts"
import { makeRequirementChecker, type Prober } from "../src/requirements.ts"

const settle = Effect.repeat(Effect.yieldNow, { times: 100 })

it.effect("a restart and a program that went missing reach the next CLI turn; a turn holding the old registry is refused after the grace period", () =>
  Effect.gen(function*() {
    const tools = { current: ["mcp_one"] }
    let host: ModuleHostApi | undefined
    const mcp = defineModule({
      apiVersion: 2,
      id: "mcp",
      name: "MCP",
      description: "",
      requires: [{ tool: "mpv", why: "Plays" }],
      start: (ctx) =>
        Effect.sync(() => {
          host = ctx.host
          return {
            instructions: "Use the MCP tools.",
            tools: tools.current.map((name) => makeTool({ name, description: "", parameters: Schema.Struct({}), execute: () => Effect.succeed(name) }))
          }
        })
    })
    const prober: Prober = async () => ({ kind: "ran", exitCode: 0, output: "mpv 0.36.0" })
    const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian" })
    const modules = yield* startCliModules({ catalog: [mcp], persistence: readOnlyPersistence(), checker })
    const first = yield* modules.setup("base")
    assert.deepStrictEqual(first.registry.specs.map((s) => s.name), ["mcp_one"])

    tools.current = ["mcp_one", "mcp_two"]
    yield* host!.requestRestart("the server's tool list changed")
    yield* settle
    const second = yield* modules.setup("base")
    assert.deepStrictEqual(second.registry.specs.map((s) => s.name), ["mcp_one", "mcp_two"], "the next turn has the new tools")

    // The first turn's registry still works during the grace period, and is refused once the old part has closed.
    assert.strictEqual((yield* first.registry.run({ id: "1", name: "mcp_one", input: {} })).content, "mcp_one")
    yield* TestClock.adjust(10_000)
    yield* settle
    const late = yield* first.registry.run({ id: "2", name: "mcp_one", input: {} })
    assert.isTrue(late.isError)
    assert.match(late.content, /replaced or stopped/)

    // A program it requires failed at run time: the next turn offers none of its tools, and says it is not set up.
    yield* host!.reportMissingProgram("mpv")
    yield* settle
    const third = yield* modules.setup("base")
    assert.deepStrictEqual(third.registry.specs, [])
    assert.match(third.system, /MCP is not set up on this server/)
    assert.strictEqual(modules.infos()[0]!.state, "unavailable")
  }).pipe(Effect.scoped))
