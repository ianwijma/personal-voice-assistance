// Module API v2 in the module host (docs/MODULES-PLAN.md §4 P1): version 1 unchanged, the shared lifetime, `uses`,
// live services and contributions, the turn's action catalogue through the gateway, requestRestart, availability,
// health, templates and tool metadata.
import { assert, describe, it } from "@effect/vitest"
import type { HealthIssue, ModuleInfo } from "@pva/protocol"
import { Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { defineAction } from "../src/Actions.ts"
import { makeTool } from "../src/Module.ts"
import { ContributionKey, type ModuleHostApi, type RequirementCheck, ServiceKey } from "../src/ModuleApi.ts"
import { defineModule, type ModuleDefinition, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

interface ListsService {
  readonly address: string
}
const Lists = ServiceKey<ListsService>("test.lists")
const Sections = ContributionKey<string>("test.sections")

interface SharedProbe {
  sharedStarts: Array<Readonly<Record<string, unknown>>>
  sharedCloses: Array<string>
  instanceShared: Array<unknown>
}

/** A version 2 module: `format` per assistant (overridable), `address` shared; its shared part provides Lists. */
const listsModule = (probe: SharedProbe, options: { readonly id?: string; readonly slowAddress?: string; readonly uses?: ReadonlyArray<string> } = {}) =>
  defineModule({
    apiVersion: 2,
    id: options.id ?? "lists",
    name: options.id === undefined ? "Lists" : options.id.toUpperCase(),
    description: "Lists",
    ...(options.uses !== undefined ? { uses: options.uses } : {}),
    settings: {
      format: Setting.choice({ label: "Format", options: [{ value: "short", label: "Short" }, { value: "long", label: "Long" }], default: "short", overridable: true }),
      address: Setting.text({ label: "Address", default: "here" })
    },
    shared: ({ settings }) =>
      Effect.gen(function*() {
        probe.sharedStarts.push({ ...settings })
        if (settings.address === options.slowAddress) yield* Effect.sleep(1_000)
        const address = settings.address ?? ""
        yield* Effect.addFinalizer(() => Effect.sync(() => probe.sharedCloses.push(address)))
        return { value: { address }, services: [Lists.of({ address })], contributions: [Sections.of(`section@${address}`)] }
      }),
    start: ({ settings, shared }) =>
      Effect.sync(() => {
        probe.instanceShared.push(shared)
        return { instructions: `Lists in ${settings.format}.` }
      })
  })

const newProbe = (): SharedProbe => ({ sharedStarts: [], sharedCloses: [], instanceShared: [] })

const hostOf = (catalog: ReadonlyArray<ModuleDefinition<any>>, demand: { current: Map<string, ReadonlyArray<ModuleDemand>> }, extra: Partial<Parameters<typeof makeModuleHost>[0]> = {}) =>
  makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {}, demand: () => demand.current, ...extra })

describe("version 1 modules", () => {
  it.effect("get exactly { settings, setStatus }, and their info carries no version 2 fields", () =>
    Effect.gen(function*() {
      const keys: Array<string> = []
      const v1 = defineModule({
        id: "old",
        name: "Old",
        description: "A module without apiVersion",
        start: (context) =>
          Effect.sync(() => {
            keys.push(...Object.keys(context))
            return {}
          })
      })
      const host = yield* makeModuleHost({ catalog: [v1], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      assert.deepStrictEqual(keys.sort(), ["setStatus", "settings"])
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "running")
      for (const key of ["unavailable", "version", "apiVersion", "templates"] as const) assert.isFalse(key in info, key)
    }))
})

describe("the shared part", () => {
  it.effect("runs once for several instances, without the overridable fields; every instance gets its value; stops when demand ends", () =>
    Effect.gen(function*() {
      const probe = newProbe()
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["lists", [{ assistantId: "a" }, { assistantId: "b", own: { format: "long" } }]]]) }
      const host = yield* hostOf([listsModule(probe)], demand)
      assert.strictEqual(host.service(Lists), undefined, "nothing before it is demanded")
      yield* host.startEnabled
      assert.strictEqual(host.modules()[0]!.instances?.length, 2, "two instances")
      assert.deepStrictEqual(probe.sharedStarts, [{ address: "here" }], "one shared part, without `format`")
      assert.strictEqual(probe.instanceShared.length, 2)
      assert.strictEqual(probe.instanceShared[0], probe.instanceShared[1], "the same value for both")
      assert.deepStrictEqual(host.service(Lists), { address: "here" })
      assert.deepStrictEqual(host.contributions(Sections), ["section@here"])

      demand.current = new Map([["lists", []]])
      yield* host.refresh
      assert.strictEqual(host.service(Lists), undefined, "withdrawn at once")
      assert.deepStrictEqual(host.contributions(Sections), [])
      assert.deepStrictEqual(probe.sharedCloses, [], "closed after the grace period")
      yield* advance(10_000)
      assert.deepStrictEqual(probe.sharedCloses, ["here"])
    }))

  it.effect("`uses` makes a module demanded: its shared part runs with no instance, and stops with the user", () =>
    Effect.gen(function*() {
      const probe = newProbe()
      const kitchen = defineModule({ apiVersion: 2, id: "kitchen", name: "Kitchen", description: "Uses lists", uses: ["lists"], start: () => Effect.succeed({}) })
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["kitchen", [{ assistantId: "a" }]], ["lists", []]]) }
      const host = yield* hostOf([kitchen, listsModule(probe)], demand)
      yield* host.startEnabled
      assert.deepStrictEqual(host.service(Lists), { address: "here" }, "provided though no assistant has lists on")
      assert.deepStrictEqual(host.modules()[1]!.instances, [], "no instance of lists")
      assert.strictEqual(probe.instanceShared.length, 0)

      demand.current = new Map([["kitchen", []], ["lists", []]])
      yield* host.refresh
      yield* advance(10_000)
      assert.strictEqual(host.service(Lists), undefined)
      assert.deepStrictEqual(probe.sharedCloses, ["here"])
    }))

  it.effect("service and contribution lookups before, during and after a restart of the provider", () =>
    Effect.gen(function*() {
      const probe = newProbe()
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["lists", [{ assistantId: "a" }]]]) }
      const host = yield* hostOf([listsModule(probe, { slowAddress: "there" })], demand)
      yield* host.startEnabled
      assert.deepStrictEqual(host.service(Lists), { address: "here" }, "before")
      const fiber = yield* Effect.forkChild(host.configure("lists", { values: { address: "there" }, secrets: {} }))
      yield* advance(500)
      assert.deepStrictEqual(host.service(Lists), { address: "here" }, "during: the old one serves")
      assert.deepStrictEqual(host.contributions(Sections), ["section@here"])
      yield* advance(600)
      const result = yield* Fiber.join(fiber)
      assert.isTrue(result.ok)
      assert.deepStrictEqual(host.service(Lists), { address: "there" }, "after")
      assert.deepStrictEqual(host.contributions(Sections), ["section@there"])
      assert.deepStrictEqual(probe.instanceShared.at(-1), { address: "there" }, "the instance was started again with the new value")
      yield* advance(10_000)
      assert.deepStrictEqual(probe.sharedCloses, ["here"], "the old shared part is closed after the grace period")
    }))

  it.effect("a second provider of a service is a start error for the second module", () =>
    Effect.gen(function*() {
      const first = newProbe()
      const second = newProbe()
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["lists", [{ assistantId: "a" }]], ["other", [{ assistantId: "a" }]]]) }
      const host = yield* hostOf([listsModule(first), listsModule(second, { id: "other" })], demand)
      yield* host.startEnabled
      const [lists, other] = host.modules()
      assert.strictEqual(lists!.state, "running")
      assert.strictEqual(other!.state, "error")
      assert.match(other!.error ?? "", /already provided by module Lists/)
      assert.deepStrictEqual(host.service(Lists), { address: "here" })
      assert.deepStrictEqual(second.sharedCloses, ["here"], "the refused shared part was closed")
    }))
})

describe("the turn's action catalogue", () => {
  const ran: Array<TurnContext | undefined> = []
  const lights = defineModule({
    apiVersion: 2,
    id: "lights",
    name: "Lights",
    description: "Lights",
    start: () =>
      Effect.succeed({
        actions: [
          defineAction({
            id: "on",
            label: "Lights on",
            description: "Switch the lights on",
            params: {},
            run: () =>
              Effect.gen(function*() {
                ran.push(yield* CurrentTurn)
                return { say: "On." }
              })
          }),
          defineAction({ id: "off", label: "Lights off", description: "Switch them off", params: {}, risk: "change", run: () => Effect.succeed({ say: "Off." }) })
        ]
      })
  })
  const turnOf = (assistantId: string): TurnContext => ({ turnId: 3, conversationId: "c-1", assistantId, source: "routine" })

  it.effect("lists the calling assistant's actions and runs them through the gateway, which refuses what it has off", () =>
    Effect.gen(function*() {
      ran.length = 0
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["lights", [{ assistantId: "a" }]]]) }
      const host = yield* hostOf([lights], demand, {
        access: { moduleOn: (assistant) => assistant === "a", toolOff: (assistant, _m, tool) => assistant === "a" && tool === "lights_off" }
      })
      yield* host.startEnabled
      const asA = <A>(e: Effect.Effect<A>) => Effect.provideService(e, CurrentTurn, turnOf("a"))
      assert.deepStrictEqual((yield* asA(host.actions.list)).map((a) => a.id), ["lights.on"], "off is switched off for a")
      assert.deepStrictEqual((yield* host.actions.list).map((a) => a.id), ["lights.on", "lights.off"], "no turn: every running module's")
      assert.deepStrictEqual(yield* asA(host.actions.run({ moduleId: "lights", actionId: "on", params: {} })), { ok: true, say: "On." })
      assert.strictEqual(ran[0]?.source, "routine", "the action sees the caller's turn")
      const off = yield* asA(host.actions.run({ moduleId: "lights", actionId: "off", params: {} }))
      assert.deepStrictEqual(off, { ok: false, code: "refused", message: "Not run: lights_off is switched off for this assistant." })
      const asB = yield* Effect.provideService(host.actions.run({ moduleId: "lights", actionId: "on", params: {} }), CurrentTurn, turnOf("b"))
      assert.strictEqual(asB.ok, false)
      assert.strictEqual(ran.length, 1, "nothing ran for b")
      const unknown = yield* host.actions.run({ moduleId: "lights", actionId: "dim", params: {} })
      assert.deepStrictEqual(unknown, { ok: false, code: "unknown_action", message: "Lights has no action \"dim\"" })
    }))
})

describe("requestRestart", () => {
  it.effect("starts the instance again, so a changed tool list is in the next snapshot", () =>
    Effect.gen(function*() {
      let names = ["first"]
      let captured: ModuleHostApi | undefined
      const mcp = defineModule({
        apiVersion: 2,
        id: "mcp",
        name: "MCP",
        description: "Tools from elsewhere",
        start: ({ host }) =>
          Effect.sync(() => {
            captured = host
            return { tools: names.map((name) => makeTool({ name, description: name, parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed(name) })) }
          })
      })
      const host = yield* makeModuleHost({ catalog: [mcp], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name), ["first"])
      names = ["first", "second"]
      yield* captured!.requestRestart("the server's tool list changed")
      yield* captured!.requestRestart("asked twice")
      yield* advance(0)
      assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name), ["first", "second"])
    }))
})

describe("availability", () => {
  const plain = (id: string, extra: Partial<Parameters<typeof defineModule>[0]> = {}) =>
    defineModule({ id, name: id.toUpperCase(), description: id, start: () => Effect.succeed({ instructions: `${id} works.` }), ...extra } as Parameters<typeof defineModule>[0])

  it.effect("an unsupported apiVersion or another platform is unavailable, never started", () =>
    Effect.gen(function*() {
      let starts = 0
      const future = defineModule({ apiVersion: 3, id: "future", name: "Future", description: "", start: () => Effect.sync(() => (starts++, {})) })
      const linuxOnly = defineModule({ id: "linux", name: "Linux", description: "", platforms: { os: ["linux"] }, start: () => Effect.sync(() => (starts++, {})) })
      const host = yield* makeModuleHost({ catalog: [future, linuxOnly], persistence: readOnlyPersistence(), env: {}, platform: { os: "darwin", arch: "arm64" } })
      yield* host.startEnabled
      const [a, b] = host.modules()
      assert.strictEqual(a!.state, "unavailable")
      assert.match(a!.unavailable!.reason, /Written for module API 3; this assistant supports 1–2/)
      assert.strictEqual(b!.state, "unavailable")
      assert.strictEqual(b!.unavailable!.reason, "Runs on linux; this server runs darwin.")
      assert.strictEqual(starts, 0)
    }))

  it.effect("a missing requirement: unavailable with its fix, one instructions line for the assistants that have it on, and Check again starts it", () =>
    Effect.gen(function*() {
      let installed = false
      const requirements: RequirementCheck = (rs) =>
        rs.map((requirement) =>
          installed
            ? { requirement, state: "met", detail: "yt-dlp 2025.01.15" }
            : { requirement, state: "missing", detail: "yt-dlp is missing", fix: { kind: "command", label: "Install yt-dlp", value: "sudo apt install yt-dlp" } }
        )
      const music = plain("music", { requires: [{ tool: "yt-dlp", why: "Resolves stream URLs" }] })
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["music", [{ assistantId: "a" }]]]) }
      const host = yield* hostOf([music], demand, { requirements })
      yield* host.startEnabled
      const info: ModuleInfo = host.modules()[0]!
      assert.strictEqual(info.state, "unavailable")
      assert.deepStrictEqual(info.unavailable, { reason: "yt-dlp is missing", fix: { kind: "command", label: "Install yt-dlp", value: "sudo apt install yt-dlp" } })
      const parts = host.snapshot().assistantParts.get("a")!
      assert.strictEqual(parts.length, 1)
      assert.isTrue(parts[0]!.unavailable)
      assert.strictEqual(parts[0]!.module.tools?.length, 0)
      assert.match(parts[0]!.instructions, /^MUSIC is not set up on this server \(yt-dlp is missing\)\. If you are asked for anything it does, say so in one sentence/)
      const issue = host.issues.all().find((i) => i.id === "music.requires.yt-dlp")
      assert.deepStrictEqual(issue?.severity, "error")
      assert.strictEqual(issue?.detail, "MUSIC needs it: Resolves stream URLs.")

      installed = true
      yield* host.recheck
      assert.strictEqual(host.modules()[0]!.state, "running")
      assert.deepStrictEqual(host.snapshot().assistantParts.get("a")!.map((p) => p.instructions), ["music works."])
      assert.isUndefined(host.issues.all().find((i) => i.module === "music"))
    }))
})

describe("health", () => {
  it.effect("health() issues are kept with the module's id; a slow check is a warning of its own", () =>
    Effect.gen(function*() {
      const ok = defineModule({
        id: "good",
        name: "Good",
        description: "",
        health: ({ running, settings }) =>
          Effect.succeed<ReadonlyArray<HealthIssue>>([{ id: "token", severity: "warning", title: `token ${running ? "running" : "idle"} ${settings === undefined ? "invalid" : "valid"}`, detail: "" }]),
        start: () => Effect.succeed({})
      })
      const slow = defineModule({ id: "slow", name: "Slow", description: "", health: () => Effect.as(Effect.sleep(10_000), []), start: () => Effect.succeed({}) })
      const host = yield* makeModuleHost({ catalog: [ok, slow], persistence: readOnlyPersistence(), env: {}, healthTimeoutMs: 100 })
      yield* host.startEnabled
      const fiber = yield* Effect.forkChild(host.checkHealth)
      yield* advance(200)
      yield* Fiber.join(fiber)
      const issues = host.issues.all()
      assert.deepStrictEqual(issues.find((i) => i.module === "good"), { id: "good.token", module: "good", severity: "warning", title: "token running valid", detail: "" })
      assert.strictEqual(issues.find((i) => i.module === "slow")?.title, "Slow's health check did not finish")
    }))
})

describe("templates and tool metadata", () => {
  it.effect("templates are listed with module-prefixed ids; risk is inferred, declared, or left out when it depends on the input", () =>
    Effect.gen(function*() {
      const garage = defineModule({
        apiVersion: 2,
        id: "garage",
        name: "Garage",
        description: "",
        version: "0.3.0",
        templates: [{ id: "keeper", name: "Keeper", prompt: "You keep the garage.", suggestedPhrases: ["hey keeper"] }],
        start: () =>
          Effect.succeed({
            tools: [
              makeTool({ name: "look", description: "", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.void }),
              makeTool({ name: "move", description: "", parameters: Schema.Struct({}), execute: () => Effect.void }),
              makeTool({ name: "send", description: "", parameters: Schema.Struct({}), risk: "message", sensitivity: "personal", latency: "slow", execute: () => Effect.void }),
              makeTool({
                name: "door",
                description: "",
                parameters: Schema.Struct({ which: Schema.String }),
                risk: ({ which }) => (which === "garage" ? "security" : "change"),
                execute: () => Effect.void
              })
            ]
          })
      })
      const host = yield* makeModuleHost({ catalog: [garage], persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.version, "0.3.0")
      assert.strictEqual(info.apiVersion, 2)
      assert.deepStrictEqual(info.templates, [{ id: "garage.keeper", name: "Keeper", prompt: "You keep the garage.", modules: ["garage"], suggestedPhrases: ["hey keeper"] }])
      assert.deepStrictEqual(info.tools.map((t) => [t.name, t.risk, t.sensitivity, t.latency]), [
        ["look", "read", "household", "quick"],
        ["move", "change", "household", "quick"],
        ["send", "message", "personal", "slow"],
        ["door", undefined, "household", "quick"]
      ])
    }))

  it("defineModule refuses a bad template id, a duplicate, and shared without apiVersion 2", () => {
    const base = { id: "t", name: "T", description: "", start: () => Effect.succeed({}) }
    assert.throws(() => defineModule({ ...base, templates: [{ id: "Bad Id", name: "x", prompt: "" }] }), /template id/)
    assert.throws(() => defineModule({ ...base, templates: [{ id: "a", name: "x", prompt: "" }, { id: "a", name: "y", prompt: "" }] }), /declared twice/)
    assert.throws(() => defineModule({ ...base, shared: () => Effect.succeed({ value: 1 }) }), /shared needs apiVersion 2/)
    assert.throws(() => defineModule({ ...base, apiVersion: 2, uses: ["t"] }), /uses names "t"/)
  })
})

// The module start error type is used by modules that fail; kept imported for the shared part's failure path below.
describe("a shared part that fails", () => {
  it.effect("makes the module's instances fail with its message", () =>
    Effect.gen(function*() {
      const broken = defineModule({
        apiVersion: 2,
        id: "broken",
        name: "Broken",
        description: "",
        shared: () => Effect.fail(new ModuleStartError({ message: "The socket did not open" })),
        start: () => Effect.succeed({})
      })
      const demand = { current: new Map<string, ReadonlyArray<ModuleDemand>>([["broken", [{ assistantId: "a" }]]]) }
      const host = yield* hostOf([broken], demand)
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "error")
      assert.strictEqual(info.error, "The socket did not open")
      assert.strictEqual(host.issues.all().find((i) => i.id === "broken.start")?.severity, "error")
    }))
})
