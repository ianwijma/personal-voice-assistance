// Piece A: agents, deciders and actions as module contributions (docs/AGENTS-AND-INTENTS.md §1.6, §3.2).
import { defaultGateway } from "../src/Gateway.ts"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { actionTool, defineAction, Param, registerActions, resolveOption } from "../src/Actions.ts"
import { choiceAnswer, makeScriptedDecider } from "../src/Decision.ts"
import { makeTool } from "../src/Module.ts"
import { defineAgent, defineDecider } from "../src/ModuleContributions.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"

const switched: Array<string> = []
const rooms = [{ value: "area:living_room", label: "Living room", aliases: ["lounge", "woonkamer"] }, { value: "area:kitchen", label: "Kitchen" }]
const lightsOn = defineAction({
  id: "lights_on",
  label: "Turn lights on",
  description: "Switch on the lights in a room.",
  params: { target: Param.dynamic({ label: "Room or light", options: () => rooms }) },
  announce: ({ target }) => `${target} on.`,
  run: ({ target }) => Effect.sync(() => void switched.push(target))
})
const setBrightness = defineAction({
  id: "set_brightness",
  label: "Set brightness",
  description: "Dim the lights.",
  params: {
    target: Param.dynamic({ label: "Room or light", options: () => rooms }),
    level: Param.number({ label: "Level", min: 0, max: 100, unit: "percent", integer: true })
  },
  run: ({ level, target }) => Effect.succeed({ say: `${target} at ${level} percent.` })
})
const hidden = defineAction({ id: "today", label: "Weather today", description: "d", params: {}, speculative: true, offerAsTool: false, run: () => Effect.void })

const home = defineModule({
  id: "demo-home",
  name: "Demo home",
  description: "d",
  start: () => Effect.succeed({ actions: [lightsOn, setBrightness, hidden] })
})

describe("actionTool", () => {
  const [registered] = registerActions("demo-home", [lightsOn])
  const tool = actionTool(registered!)

  it("names the tool after module and action; the dynamic parameter is a plain string in the schema", () => {
    assert.strictEqual(tool.name, "demo-home_lights_on")
    assert.strictEqual(tool.speculative, false)
    const json = Schema.toJsonSchemaDocument(tool.parameters).schema as { properties: Record<string, { type: string }>; required: Array<string> }
    assert.strictEqual(json.properties.target!.type, "string")
    assert.deepStrictEqual(json.required, ["target"])
  })

  it.effect("resolves a spoken name against the current options and runs the action (through the gateway only)", () =>
    Effect.gen(function*() {
      switched.length = 0
      // Called directly, the generated tool refuses: only the execution gateway runs an action.
      const direct = yield* Effect.flip(tool.execute({ target: "the living room" }))
      assert.match(direct.message, /only through the execution gateway/)
      assert.deepStrictEqual(switched, [])
      assert.strictEqual(yield* defaultGateway.tool("demo-home", tool, { target: "the living room" }), "area:living_room on.")
      assert.strictEqual(yield* defaultGateway.tool("demo-home", tool, { target: "Woonkamer" }), "area:living_room on.")
      assert.deepStrictEqual(switched, ["area:living_room", "area:living_room"])
      const error = yield* Effect.flip(defaultGateway.tool("demo-home", tool, { target: "garage" }))
      assert.strictEqual(error.message, "Unknown room or light \"garage\". Valid names: Living room, Kitchen")
    }))

  it.effect("checks number ranges", () =>
    Effect.gen(function*() {
      const t = actionTool(registerActions("demo-home", [setBrightness])[0]!)
      assert.strictEqual(yield* defaultGateway.tool("demo-home", t, { target: "kitchen", level: 40 }), "area:kitchen at 40 percent.")
      const error = yield* Effect.flip(defaultGateway.tool("demo-home", t, { target: "kitchen", level: 140 }))
      assert.match(error.message, /from 0 to 100/)
    }))

  it("resolveOption: exact, alias, then phonetic", () => {
    assert.strictEqual(resolveOption(rooms, "lounge")?.value, "area:living_room")
    assert.strictEqual(resolveOption(rooms, "kitchin")?.value, "area:kitchen")
    assert.strictEqual(resolveOption(rooms, "bathroom"), undefined)
  })
})

describe("module host snapshot", () => {
  const agent = defineAgent({
    id: "jev",
    name: "Jev",
    description: "d",
    kind: "intent",
    enabledByDefault: true,
    start: () => Effect.succeed({ turn: () => Stream.make({ _tag: "TextDelta" as const, text: "Hello there, nice to meet you." }) })
  })
  const decider = defineDecider({
    id: "keywords",
    name: "Offline keywords",
    description: "d",
    enabledByDefault: true,
    start: () => {
      const scripted = makeScriptedDecider(() => ({ answers: { action: choiceAnswer({ "test.lights_on": 0.9, "test.time_now": 0.1 }) } }))
      return Effect.succeed({ location: "local" as const, decide: scripted.decide })
    }
  })

  it.effect("collects agents, deciders and actions; actions become tools unless they opt out", () =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [home, agent, decider], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      const snapshot = host.snapshot()
      assert.deepStrictEqual([...snapshot.agents.keys()], ["jev"])
      assert.strictEqual(snapshot.agents.get("jev")!.kind, "intent")
      assert.deepStrictEqual([...snapshot.deciders.keys()], ["keywords"])
      assert.deepStrictEqual(snapshot.actions.map((a) => a.id), ["demo-home.lights_on", "demo-home.set_brightness", "demo-home.today"])
      assert.deepStrictEqual(snapshot.registry.specs.map((s) => s.name), ["demo-home_lights_on", "demo-home_set_brightness"])
      assert.strictEqual(snapshot.toolModules.get("demo-home_lights_on"), "demo-home")
      const info = host.modules().find((m) => m.id === "demo-home")!
      assert.deepStrictEqual(info.tools.map((t) => t.name), ["demo-home_lights_on", "demo-home_set_brightness"])
      assert.strictEqual(agent.kind, "agent")
    })))

  it.effect("a generated tool name that clashes with another module's tool fails the start", () =>
    Effect.scoped(Effect.gen(function*() {
      const squatter = defineModule({
        id: "squatter",
        name: "Squatter",
        description: "d",
        start: () => Effect.succeed({ tools: [makeTool({ name: "demo-home_lights_on", description: "x", parameters: Schema.Struct({}), execute: () => Effect.void })] })
      })
      const host = yield* makeModuleHost({ catalog: [squatter, home], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      const info = host.modules().find((m) => m.id === "demo-home")!
      assert.strictEqual(info.state, "error")
      assert.strictEqual(info.error, "Tool name \"demo-home_lights_on\" is already used by module Squatter")
    })))

  it.effect("the generated Test button runs an agent turn and a decider request", () =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog: [home, agent, decider], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      const agentTest = yield* host.fieldAction("jev", "test")
      assert.isTrue(agentTest.ok)
      if (agentTest.ok) assert.match(agentTest.result.text, /^First text after \d+ ms, done after \d+ ms: 'Hello there, nice to meet you.'$/)
      const deciderTest = yield* host.fieldAction("keywords", "test")
      if (deciderTest.ok) assert.match(deciderTest.result.text, /^Answered in \d+ ms: action test.lights_on \(90 %\)/)
      else assert.fail("decider test failed")
      const missing = yield* host.fieldAction("demo-home", "test")
      assert.deepStrictEqual(missing.ok ? undefined : missing.code, "unknown_action")
    })))
})
