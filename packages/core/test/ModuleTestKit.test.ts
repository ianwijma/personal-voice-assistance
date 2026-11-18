// The module test kit (docs/MODULES.md, "Testing"): a module in the real host as serve mode runs it, its turns
// admitted by the real gateway, stand-ins for the modules it uses, the core's people and privacy rules, and its
// lifecycle. The reference module's test (packages/module-contracts/test/kit) uses every handle on a real module.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ContributionKey, ServiceKey } from "../src/ModuleApi.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { People } from "../src/People.ts"
import { Privacy } from "../src/Privacy.ts"
import { CurrentTurn } from "../src/TurnContext.ts"
import { DEFAULT_TEST_START, expectOffByDefault, makeTestPeople, makeTestTurn, provide, startTestModule } from "../src/testing.ts"

interface Greeter {
  readonly greet: (name: string) => string
}
const Greeters = ServiceKey<Greeter>("greeter")
const Lines = ContributionKey<string>("test.lines")

/** A module that uses a service and contributions of others, and says who asks. */
const asker = defineModule({
  apiVersion: 2,
  id: "asker",
  name: "Asker",
  description: "Uses other modules.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.succeed({
      tools: [
        makeTool({
          name: "asker_who",
          description: "Who is asking, and what the greeter says.",
          parameters: Schema.Struct({}),
          speculative: true,
          execute: () =>
            Effect.gen(function*() {
              const turn = yield* CurrentTurn
              const greeter = ctx.host.service(Greeters)
              const lines = yield* ctx.host.contributions(Lines)
              const person = turn?.person === undefined ? undefined : ctx.host.service(People)?.get(turn.person.id)?.name
              return { device: turn?.deviceId, room: turn?.room, person, greeting: greeter?.greet(person ?? "you") ?? "the greeter is off", lines }
            })
        })
      ]
    })
})

describe("startTestModule", () => {
  it.effect("runs a tool as a turn of the household's device, with stand-ins for the modules it uses", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker, {
        provide: [provide("greeter", { services: [Greeters.of({ greet: (n) => `Hello ${n}` })], contributions: [Lines.of("from the greeter")] })]
      })
      assert.strictEqual(yield* kit.now, DEFAULT_TEST_START)
      const r = yield* kit.tool("asker_who", {})
      assert.deepStrictEqual(r.value, { device: "kitchen-display", room: "Kitchen", person: "Sam", greeting: "Hello Sam", lines: ["from the greeter"] })
      // On the public hall screen nobody is the default person.
      const hall = yield* kit.tool("asker_who", {}, { device: "hall-screen" })
      assert.deepStrictEqual(hall.value, { device: "hall-screen", room: "Hall", greeting: "Hello you", lines: ["from the greeter"] })
    }))

  it.effect("contributions follow the turn's assistant; a service is there whatever the assistant has on", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker, {
        provide: [provide("greeter", { services: [Greeters.of({ greet: () => "hi" })], contributions: [Lines.of("line")] })],
        household: {
          assistants: [{ id: "jeff" }, { id: "plain", modules: { greeter: false } }],
          devices: [{ id: "kitchen-display", name: "Kitchen", room: "Kitchen", assistants: ["jeff", "plain"] }]
        }
      })
      assert.deepStrictEqual(yield* kit.contributions(Lines, { assistant: "jeff" }), ["line"])
      assert.deepStrictEqual(yield* kit.contributions(Lines, { assistant: "plain" }), [])
      const plain = yield* kit.tool("asker_who", {}, { assistant: "plain" })
      assert.strictEqual((plain.value as { greeting: string }).greeting, "hi")
    }))

  it.effect("the gateway refuses what serve mode refuses: an unknown device, an assistant not on the device, a person who is not its default", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker, {
        household: { assistants: [{ id: "jeff" }, { id: "other" }], devices: [{ id: "kitchen-display", name: "Kitchen", assistants: ["jeff"], defaultPerson: "p-sam" }] }
      })
      const unknown = yield* kit.tool("asker_who", {}, makeTestTurn({ device: "nowhere-device" }))
      assert.match(unknown.content, /^Not run: .*not known/)
      const offDevice = yield* kit.tool("asker_who", {}, { assistant: "other" })
      assert.match(offDevice.content, /^Not run: .*not on the device/)
      const notDefault = yield* kit.tool("asker_who", {}, { person: "p-robin" })
      assert.match(notDefault.content, /^Not run: .*default person/)
    }))

  it.effect("stop, start and restart: tools withdrawn while it is off, a new start afterwards", () =>
    Effect.gen(function*() {
      let starts = 0
      const counted = defineModule({ apiVersion: 2, id: "counted", name: "Counted", description: "Counts its starts.", enabledByDefault: false, start: () => Effect.sync(() => (starts++, {})) })
      const kit = yield* startTestModule(counted)
      assert.strictEqual(starts, 1)
      assert.strictEqual(kit.info()?.state, "running")
      yield* kit.stop
      assert.strictEqual(kit.info()?.state, "disabled")
      yield* kit.restart
      assert.strictEqual(starts, 2)
      assert.strictEqual(kit.info()?.state, "running")
    }))

  it.effect("a stand-in that is switched off is absent: the consumer says the other module is off", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker, { household: { assistants: [{ id: "jeff" }] } })
      const r = yield* kit.tool("asker_who", {})
      assert.strictEqual((r.value as { greeting: string }).greeting, "the greeter is off")
    }))
})

describe("the household of a test", () => {
  it("Privacy follows the device's place and Members, as serve mode's rule does", () => {
    const h = makeTestPeople()
    assert.isTrue(h.privacy.mayReveal("p-sam", "kitchen-display"))
    assert.isFalse(h.privacy.mayReveal("p-robin", "kitchen-display"))
    assert.isTrue(h.privacy.mayReveal("p-sam", "robins-phone"))
    assert.isFalse(h.privacy.mayReveal("p-sam", "hall-screen"))
    h.setPrivacy("kitchen-display", "public")
    assert.isFalse(h.privacy.mayReveal("p-sam", "kitchen-display"))
    h.removePerson("p-robin")
    assert.isFalse(h.privacy.mayReveal("p-robin", "robins-phone"))
    assert.strictEqual(h.people.find("sam").kind, "found")
    assert.strictEqual(h.devices.get("hall-screen")?.place.privacy, "public")
  })

  it.effect("Privacy and People reach the module through host.service", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(asker)
      assert.isDefined(kit.service(Privacy))
      assert.strictEqual(kit.service(People)?.list().length, 2)
    }))
})

describe("expectOffByDefault", () => {
  it.effect("passes for modules that are off, and fails for one that is on", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault([asker])
      const on = defineModule({ id: "on", name: "On", description: "On by default.", start: () => Effect.succeed({}) })
      const exit = yield* Effect.exit(expectOffByDefault([on]))
      assert.isTrue(exit._tag === "Failure")
    }))
})
