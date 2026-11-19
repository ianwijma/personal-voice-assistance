// P8: the CLI modes read the household's saved risk policy and language (the settings they read: the environment, then
// the saved values) through serve mode's decoder, and decide every call with the same function.
import { assert, it } from "@effect/vitest"
import { CurrentTurnTrace, defineModule, makeTool, makeTurnTrace, readOnlyPersistence, ToolError } from "@pva/core"
import { ConfigProvider, Effect, Schema } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it as test, expect } from "vitest"
import { withCliSettings } from "../src/cliSettings.ts"
import { makeSections } from "../src/serve/sections.ts"
import { openStore } from "./support/store.ts"
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

it.effect("CLI per-result failures keep the typed sentence and withhold crash text without a device hook", () =>
  Effect.gen(function*() {
    const dir = mkdtempSync(join(tmpdir(), "pva-cli-risk-"))
    const definition = defineModule({ id: "house", name: "House", description: "", start: () => Effect.succeed({ tools: [
      makeTool({ name: "look", description: "", risk: "read", sensitivity: () => ({ kind: "household" }), parameters: Schema.Struct({ crash: Schema.Boolean }), execute: ({ crash }) => crash ? Effect.die(new Error("private-marker-42")) : Effect.fail(new ToolError({ message: "Try again later" })) })
    ] }) })
    const trace = makeTurnTrace().begin("text")
    const results = yield* withCliSettings(Effect.gen(function*() {
      const cli = yield* startCliModules({ catalog: [definition], persistence: readOnlyPersistence({ modules: { house: { enabled: true } }, secrets: {} }), checker })
      const setup = yield* cli.setup("base")
      return yield* Effect.forEach([false, true], (crash) => setup.registry.run({ id: "x", name: "look", input: { crash } }))
    }).pipe(Effect.provideService(CurrentTurnTrace, trace)), { env: { PVA_DATA_DIR: dir }, dataDir: dir, vaultPath: join(dir, "vault.enc") })
    assert.deepStrictEqual(trace.calls?.map((c) => [c.outcome, c.by, c.withheld === true]), [["allow", "read", false], ["allow", "read", true]])
    assert.deepStrictEqual(results.map((r) => [r.content, r.isError]), [["Try again later", true], ["Withheld: the result is personal to someone, and this device may not reveal it. Say that it cannot be shared here.", true]])
  }))

test.each([
  { envLanguage: " nl-NL ", storedLanguage: undefined, language: "nl" },
  { envLanguage: undefined, storedLanguage: ["nl-NL"], language: "en" },
  { envLanguage: "nl-INVALID", storedLanguage: undefined, language: "en" },
  { envLanguage: "nl-NL", storedLanguage: undefined, language: "nl" }
])("CLI refusal language matches Home for $envLanguage / $storedLanguage", async ({ envLanguage, storedLanguage, language }) => {
  const dir = mkdtempSync(join(tmpdir(), "pva-cli-risk-"))
  const store = await Effect.runPromise(openStore(dir))
  await Effect.runPromise(store.saveAssistant(["RISK_MESSAGE"], { RISK_MESSAGE: "deny" }, {}))
  const path = join(dir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8"))
  file.assistant.HOME_LANGUAGE = storedLanguage
  writeFileSync(path, JSON.stringify(file))
  const env = { PVA_DATA_DIR: dir, ...(envLanguage === undefined ? {} : { HOME_LANGUAGE: envLanguage }) }
  const serve = makeSections(await Effect.runPromise(openStore(dir)), env)
  expect(serve.riskLanguage()).toBe(language)
  const result = await Effect.runPromise(Effect.scoped(withCliSettings(Effect.gen(function*() {
    const definition = defineModule({ id: "house", name: "House", description: "", start: () => Effect.succeed({ tools: [makeTool({ name: "send", description: "", risk: "message", parameters: Schema.Struct({}), execute: () => Effect.succeed("sent") })] }) })
    const cli = yield* startCliModules({ catalog: [definition], persistence: readOnlyPersistence({ modules: { house: { enabled: true } }, secrets: {} }), checker })
    return yield* (yield* cli.setup("base")).registry.run({ id: "x", name: "send", input: {} })
  }), { env, dataDir: dir, vaultPath: join(dir, "vault.enc") })))
  expect(result.isError).toBe(true)
  expect(result.content).toBe(language === "nl"
    ? "Niet uitgevoerd: het zou een bericht sturen namens de eigenaar, en dat staat dit huishouden niet toe."
    : "Not run: it would send a message in the owner's name, which this household does not allow.")
})
