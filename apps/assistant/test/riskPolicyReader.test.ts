// P8, review round 1, H1 (findings 1 and 6): one canonical reader of the household's effective risk policy. The CLI
// start reads it as serve does (a padded environment value is trimmed; a saved value of the wrong type is the class's
// default), and serve's gateway hook reads a record published with every committed save, so a call after a save does no
// file-system work and waits for nothing; a caller interrupted right after the commit still leaves it fresh.
import { CurrentTurn, defineModule, makeExecutionGateway, makeTool, makeToolRegistry, readOnlyPersistence } from "@pva/core"
import { DEFAULT_RISK_POLICY } from "@pva/protocol"
import { ConfigProvider, Deferred, Effect, Fiber, Schema } from "effect"
import * as fs from "node:fs"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, existsSync: vi.fn(actual.existsSync), statSync: vi.fn(actual.statSync) }
})

const { makeSections } = await import("../src/serve/sections.ts")
const { effectiveRiskPolicy, serveLanguageReader, servePolicyReader } = await import("../src/serve/riskPolicy.ts")
const { startCliModules } = await import("../src/modules.ts")
const { withCliSettings } = await import("../src/cliSettings.ts")
const { makeRequirementChecker } = await import("../src/requirements.ts")
const { openStore } = await import("./support/store.ts")

const fsCalls = () => vi.mocked(fs.existsSync).mock.calls.length + vi.mocked(fs.statSync).mock.calls.length

const toolsModule = () => {
  const ran: Array<string> = []
  const definition = defineModule({
    id: "house",
    name: "House",
    description: "",
    start: () =>
      Effect.succeed({
        tools: [
          makeTool({ name: "lamp", description: "", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.sync(() => (ran.push("lamp"), "on")) }),
          makeTool({ name: "send", description: "", parameters: Schema.Struct({}), risk: "message", execute: () => Effect.sync(() => (ran.push("send"), "SENT")) }),
          makeTool({ name: "look", description: "", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.sync(() => (ran.push("look"), "seen")) })
        ]
      })
  })
  return { definition, ran }
}

const checker = (dir: string) => makeRequirementChecker({ dataDir: dir, prober: async () => ({ kind: "ran", exitCode: 0, output: "" }), distro: "debian", tools: new Map() })

describe("the canonical reader", () => {
  it("trims an environment value, reads a saved value of the wrong type or outside the choices as the class's default", () => {
    expect(effectiveRiskPolicy({ stored: {}, env: { RISK_CHANGE: " deny " } })).toEqual({ ...DEFAULT_RISK_POLICY, change: "deny" })
    expect(effectiveRiskPolicy({ stored: { RISK_MESSAGE: ["allow"], RISK_CHANGE: "sometimes", RISK_READ: 3 }, env: {} })).toEqual(DEFAULT_RISK_POLICY)
    expect(effectiveRiskPolicy({ stored: { RISK_MESSAGE: "allow" }, env: { RISK_MESSAGE: "nonsense" } })).toEqual(DEFAULT_RISK_POLICY)
    expect(effectiveRiskPolicy({ stored: { RISK_MONEY: "allow" }, env: { RISK_SECURITY: "allow" } })).toEqual(DEFAULT_RISK_POLICY)
    expect(effectiveRiskPolicy({ stored: { RISK_MESSAGE: "allow" }, env: { RISK_MESSAGE: "" } })).toEqual({ ...DEFAULT_RISK_POLICY, message: "allow" })
  })
})

describe("the CLI start reads the policy as serve does (finding 1)", () => {
  it("a padded environment value, through the real CLI start: the change is refused, as serve reads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-cli-"))
    const env = { PVA_DATA_DIR: dir, RISK_CHANGE: " deny " }
    const serve = makeSections(await Effect.runPromise(openStore(dir)), env)
    expect(serve.riskPolicy().change).toBe("deny")
    const { definition, ran } = toolsModule()
    const result = await Effect.runPromise(Effect.scoped(withCliSettings(
      Effect.gen(function*() {
        const cli = yield* startCliModules({ catalog: [definition], persistence: readOnlyPersistence({ modules: { house: { enabled: true } }, secrets: {} }), checker: checker(dir) })
        const setup = yield* cli.setup("base")
        return yield* setup.registry.run({ id: "1", name: "lamp", input: {} })
      }),
      { env, dataDir: dir, vaultPath: join(dir, "vault", "vault.enc") }
    )))
    expect(result.content).toBe("Not run: it would change something in the house, which this household does not allow.")
    expect(ran).toEqual([])
  })

  it("a malformed saved value, through the real CLI start: the class's default (message refused), as serve reads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-cli-"))
    const store = await Effect.runPromise(openStore(dir))
    await Effect.runPromise(store.saveAssistant(["RISK_MESSAGE"], { RISK_MESSAGE: "deny" }, {}))
    const file = join(dir, "settings.json")
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    parsed.assistant.RISK_MESSAGE = ["allow"]
    writeFileSync(file, JSON.stringify(parsed))
    const serve = makeSections(await Effect.runPromise(openStore(dir)), {})
    expect(serve.riskPolicy().message).toBe("confirm")
    const { definition, ran } = toolsModule()
    const run = (provider?: ConfigProvider.ConfigProvider) => {
      const body = Effect.gen(function*() {
        const cli = yield* startCliModules({ catalog: [definition], persistence: readOnlyPersistence({ modules: { house: { enabled: true } }, secrets: {} }), checker: checker(dir) })
        const setup = yield* cli.setup("base")
        return yield* setup.registry.run({ id: "1", name: "send", input: {} })
      })
      return Effect.runPromise(Effect.scoped(
        provider === undefined
          ? withCliSettings(body, { env: { PVA_DATA_DIR: dir }, dataDir: dir, vaultPath: join(dir, "vault", "vault.enc") })
          : Effect.provideService(body, ConfigProvider.ConfigProvider, provider)
      ))
    }
    const viaStart = await run()
    expect(viaStart.content).toBe("Not run: it would send a message in the owner's name, which needs the owner's confirmation, and this assistant cannot ask for it yet.")
    // The reviewer's form: the settings' own ConfigProvider handed to the CLI directly.
    const viaProvider = await run(ConfigProvider.orElse(ConfigProvider.fromEnvRecord({ PVA_DATA_DIR: dir }), serve.configProvider()))
    expect(viaProvider.content).toBe(viaStart.content)
    expect(ran).toEqual([])
  })
})

describe("serve's record: published with the commit, read as a field (finding 6)", () => {
  it("a save between a turn's setup and its next tool call: the call does no file-system work and gets the new policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-serve-"))
    const sections = makeSections(await Effect.runPromise(openStore(dir)), {})
    const gateway = makeExecutionGateway({ policy: servePolicyReader(sections) })
    const lamp = makeTool({ name: "lamp", description: "", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.succeed("on") })
    const look = makeTool({ name: "look", description: "", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("seen") })
    // The turn's setup: its registry and its tool list.
    const registry = makeToolRegistry([{ name: "house", tools: [lamp, look] }], { gateway })
    expect(registry.specs.map((s) => s.name)).toEqual(["lamp", "look"])
    const turn = { turnId: 1, conversationId: "c", source: "voice" as const }
    const call = (name: string) => Effect.runPromise(registry.run({ id: name, name, input: {} }).pipe(Effect.provideService(CurrentTurn, turn)))
    // The owner saves Refuse for changes while the turn runs.
    expect((await Effect.runPromise(sections.update("risk", { values: { RISK_CHANGE: "deny" }, secrets: {} }))).result.ok).toBe(true)
    const before = fsCalls()
    expect((await call("look")).content).toBe("seen")
    expect((await call("lamp")).content).toBe("Not run: it would change something in the house, which this household does not allow.")
    void registry.specs
    expect(fsCalls() - before).toBe(0)
  })

  it("review round 2, the note: the first refusal right after a save, with serve's language hook too, does no file-system work and speaks the saved language", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-serve-"))
    const sections = makeSections(await Effect.runPromise(openStore(dir)), {})
    const gateway = makeExecutionGateway({ policy: servePolicyReader(sections), language: serveLanguageReader(sections) })
    const lamp = makeTool({ name: "lamp", description: "", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.succeed("on") })
    const registry = makeToolRegistry([{ name: "house", tools: [lamp] }], { gateway })
    const call = () => Effect.runPromise(registry.run({ id: "lamp", name: "lamp", input: {} }).pipe(Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "voice" as const })))
    expect((await call()).content).toBe("on")
    expect((await Effect.runPromise(sections.update("home", { values: { HOME_LANGUAGE: "nl-NL" }, secrets: {} }))).result.ok).toBe(true)
    expect((await Effect.runPromise(sections.update("risk", { values: { RISK_CHANGE: "deny" }, secrets: {} }))).result.ok).toBe(true)
    const before = fsCalls()
    expect((await call()).content).toBe("Niet uitgevoerd: het zou iets in huis veranderen, en dat staat dit huishouden niet toe.")
    expect(fsCalls() - before).toBe(0)
  })

  it("a caller interrupted right after the commit still leaves the record fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-serve-"))
    const store = await Effect.runPromise(openStore(dir))
    const committed = Deferred.makeUnsafe<void>()
    const watched = { ...store, saveAssistant: (...args: Parameters<typeof store.saveAssistant>) => Effect.tap(store.saveAssistant(...args), () => Deferred.succeed(committed, undefined)) }
    const sections = makeSections(watched, {})
    await Effect.runPromise(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(sections.update("risk", { values: { RISK_MESSAGE: "allow" }, secrets: {} }))
      yield* Deferred.await(committed)
      yield* Fiber.interrupt(fiber)
    }))
    expect(sections.riskPolicy()).toEqual({ ...DEFAULT_RISK_POLICY, message: "allow" })
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).assistant.RISK_MESSAGE).toBe("allow")
  })

  it("until anything is published the record holds the defaults; the environment's change is published by announceAll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-serve-"))
    const env: Record<string, string | undefined> = {}
    const sections = makeSections(await Effect.runPromise(openStore(dir)), env)
    expect(sections.riskPolicy()).toEqual(DEFAULT_RISK_POLICY)
    env.RISK_READ = "deny"
    expect(sections.riskPolicy().read).toBe("allow")
    sections.announceAll()
    expect(sections.riskPolicy().read).toBe("deny")
  })
})
