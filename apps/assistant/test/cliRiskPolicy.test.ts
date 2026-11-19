// P8: the CLI modes read the household's saved risk policy and language (the settings they read: the environment, then
// the saved values) through serve mode's decoder, and decide every call with the same function.
import { assert, it } from "@effect/vitest"
import { defineModule, makeTool, readOnlyPersistence } from "@pva/core"
import { ConfigProvider, Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCliModules } from "../src/modules.ts"
import { makeRequirementChecker, type Prober } from "../src/requirements.ts"

const lamps = defineModule({
  id: "lamps",
  name: "Lamps",
  description: "",
  start: () =>
    Effect.succeed({
      tools: [
        makeTool({ name: "lamp", description: "", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.succeed("on") }),
        makeTool({ name: "pay", description: "", parameters: Schema.Struct({}), risk: "money", execute: () => Effect.succeed("paid") })
      ]
    })
})

const prober: Prober = async () => ({ kind: "ran", exitCode: 0, output: "" })
const checker = makeRequirementChecker({ dataDir: "/d", prober, distro: "debian", tools: new Map() })

it.effect("a saved Refuse for changes refuses the CLI's call, in the saved language; money stays refused whatever is saved", () =>
  Effect.gen(function*() {
    const modules = yield* startCliModules({ catalog: [lamps], persistence: readOnlyPersistence({ modules: { lamps: { enabled: true } }, secrets: {} }), checker })
    const setup = yield* modules.setup("base")
    assert.deepStrictEqual(setup.registry.specs.map((s) => s.name), [], "lamp (change: refused) and pay (money) are not offered")
    const lamp = yield* setup.registry.run({ id: "1", name: "lamp", input: {} })
    assert.strictEqual(lamp.content, "Niet uitgevoerd: het zou iets in huis veranderen, en dat staat dit huishouden niet toe.")
    const pay = yield* setup.registry.run({ id: "2", name: "pay", input: {} })
    assert.strictEqual(pay.content, "Niet uitgevoerd: het zou geld uitgeven, en dat doet deze assistent nooit.")
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ PVA_DATA_DIR: mkdtempSync(join(tmpdir(), "pva-cli-risk-")), RISK_CHANGE: "deny", RISK_MONEY: "allow", HOME_LANGUAGE: "nl-NL" }))))

it.effect("nothing saved: the default (changes run, messages and money refused), in English", () =>
  Effect.gen(function*() {
    const modules = yield* startCliModules({ catalog: [lamps], persistence: readOnlyPersistence({ modules: { lamps: { enabled: true } }, secrets: {} }), checker })
    const setup = yield* modules.setup("base")
    assert.deepStrictEqual(setup.registry.specs.map((s) => s.name), ["lamp"])
    assert.strictEqual((yield* setup.registry.run({ id: "1", name: "lamp", input: {} })).content, "on")
  }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ PVA_DATA_DIR: mkdtempSync(join(tmpdir(), "pva-cli-risk-")) }))))
