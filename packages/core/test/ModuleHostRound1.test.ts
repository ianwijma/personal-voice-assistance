// Module API v2, review round 1 (docs/MODULES-PLAN.md §4 P1 "Two lifetimes"): replacement by generations, publication
// and rollback, interruption, demand through `uses`, availability, restarts, the intent path of an unavailable module,
// and the context members the revised plan adds (`settingsFor`, contributions inside a turn). Each test names the
// finding of p1-r1 it covers.
import { assert, describe, it } from "@effect/vitest"
import { encodeServerMessage, type HealthIssue, type ModuleInfo } from "@pva/protocol"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { defineAction, Param } from "../src/Actions.ts"
import type { AgentEvent, AgentTurnInput } from "../src/Agent.ts"
import { choiceAnswer, type DecisionAnswer, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { ALLOW, type GatewayCall, makeExecutionGateway } from "../src/Gateway.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { makeTool } from "../src/Module.ts"
import { ContributionKey, type ModuleHostApi, type RequirementCheck, ServiceKey } from "../src/ModuleApi.ts"
import { defineModule, type ModuleDefinition, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, type ModulePersistence, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))
const settle = Effect.repeat(Effect.yieldNow, { times: 50 })

interface Svc {
  readonly address: string
}
const Svc = ServiceKey<Svc>("r1.svc")
const Section = ContributionKey<string>("r1.section")

interface Probe {
  readonly log: Array<string>
}

/**
 * A version 2 module with a shared part: `address` is shared, `format` overridable. Its instance offers a tool whose
 * name is `tool_<address>`; an address of `fail` fails the shared start, `slow` makes it take 1 s, `bad:<format>` fails
 * the instance of that format, `slowi:<format>` makes that instance take 1 s.
 */
const provider = (probe: Probe, options: { readonly id?: string; readonly uses?: ReadonlyArray<string>; readonly toolName?: (address: string) => string } = {}) => {
  const id = options.id ?? "prov"
  return defineModule({
    apiVersion: 2,
    id,
    name: id.toUpperCase(),
    description: "provider",
    ...(options.uses !== undefined ? { uses: options.uses } : {}),
    settings: {
      address: Setting.text({ label: "Address", default: "a1" }),
      format: Setting.choice({ label: "Format", options: [{ value: "short", label: "Short" }, { value: "long", label: "Long" }], default: "short", overridable: true })
    },
    shared: ({ settings }) =>
      Effect.gen(function*() {
        const address = settings.address ?? ""
        probe.log.push(`${id}:shared+${address}`)
        if (address === "fail") return yield* new ModuleStartError({ message: "no such endpoint" })
        yield* Effect.addFinalizer(() => Effect.sync(() => probe.log.push(`${id}:shared-${address}`)))
        if (address === "slow") yield* Effect.sleep(1_000)
        return { value: { address }, services: [Svc.of({ address })], contributions: [Section.of(`${id}@${address}`)] }
      }),
    start: ({ settings, shared }) =>
      Effect.gen(function*() {
        const address = (shared as Svc).address
        probe.log.push(`${id}:start+${address}/${settings.format}`)
        if (settings.address.startsWith("bad:") && settings.address.slice(4) === settings.format) return yield* new ModuleStartError({ message: `bad ${settings.format}` })
        yield* Effect.addFinalizer(() => Effect.sync(() => probe.log.push(`${id}:stop-${address}/${settings.format}`)))
        if (settings.address.startsWith("slowi:") && settings.address.slice(6) === settings.format) yield* Effect.sleep(1_000)
        return {
          tools: [makeTool({ name: (options.toolName ?? ((a) => `${id}_${a.replace(/[^a-z0-9]/g, "")}`))(address), description: "", parameters: Schema.Struct({}), execute: () => Effect.succeed(address) })]
        }
      })
  })
}

const demandOf = (entries: Record<string, ReadonlyArray<ModuleDemand>>) => ({ current: new Map(Object.entries(entries)) as Map<string, ReadonlyArray<ModuleDemand>> })

const recording = (): ModulePersistence & { readonly saves: Array<unknown> } => {
  const saves: Array<unknown> = []
  return { initial: { modules: {}, secrets: {} }, save: (id, record) => Effect.sync(() => void saves.push({ id, ...record })), saves }
}

const hostOf = (
  catalog: ReadonlyArray<ModuleDefinition<any>>,
  demand: { current: Map<string, ReadonlyArray<ModuleDemand>> } | undefined,
  extra: Partial<Parameters<typeof makeModuleHost>[0]> = {}
) => makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {}, ...(demand !== undefined ? { demand: () => demand.current } : {}), ...extra })

const info = (host: { readonly modules: () => ReadonlyArray<ModuleInfo> }, id: string) => host.modules().find((m) => m.id === id)!

describe("replacement by generations (findings 1, 2, 5, 8, 9)", () => {
  it.effect("1: a configure whose new instance clashes with another module changes nothing: old service, old scope alive", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      const other = defineModule({ id: "other", name: "Other", description: "", start: () => Effect.succeed({ tools: [makeTool({ name: "taken", description: "", parameters: Schema.Struct({}), execute: () => Effect.void })] }) })
      const persistence = recording()
      const host = yield* hostOf([provider(probe, { toolName: (a) => (a === "clash" ? "taken" : `prov_${a}`) }), other], demandOf({ prov: [{ assistantId: "a" }] }), { persistence })
      yield* host.startEnabled
      const before = host.service(Svc)
      assert.deepStrictEqual(before, { address: "a1" })
      const result = yield* host.configure("prov", { values: { address: "clash" }, secrets: {} })
      assert.isFalse(result.ok)
      assert.match(result.ok ? "" : result.error.message, /already used by module Other/)
      assert.strictEqual(host.service(Svc), before, "the same service object: the new shared part was never published")
      assert.deepStrictEqual(host.contributions(Section), ["prov@a1"])
      yield* advance(20_000)
      assert.notInclude(probe.log, "prov:shared-a1", "the old shared scope is alive")
      assert.include(probe.log, "prov:shared-clash", "the candidate was closed")
      assert.deepStrictEqual(persistence.saves, [], "nothing saved")
      assert.deepStrictEqual(host.snapshot().registry.specs.map((s) => s.name).sort(), ["prov_a1", "taken"])
    }))

  it.effect("2: a Home default change with two instances: one generation; a failing second start leaves the old one serving", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      let address = "a1"
      const host = yield* hostOf([provider(probe)], demandOf({ prov: [{ assistantId: "a" }, { assistantId: "b", own: { format: "long" } }] }), {
        defaults: () => ({ address })
      })
      yield* host.startEnabled
      const before = host.service(Svc)
      address = "bad:long"
      yield* host.refresh
      assert.strictEqual(host.service(Svc), before, "the old generation serves")
      assert.deepStrictEqual(info(host, "prov").instances?.map((i) => i.state), ["running", "running"])
      assert.include(host.issues.all().map((i) => i.title), "PROV could not apply its new settings")
      yield* advance(20_000)
      assert.notInclude(probe.log, "prov:stop-a1/short", "no old instance was retired")
      assert.notInclude(probe.log, "prov:shared-a1")
    }))

  it.effect("2: a slow second start: nothing switches until both have started, then all at once; old generation retired together", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      let address = "a1"
      const host = yield* hostOf([provider(probe)], demandOf({ prov: [{ assistantId: "a" }, { assistantId: "b", own: { format: "long" } }] }), {
        defaults: () => ({ address })
      })
      yield* host.startEnabled
      address = "slowi:long"
      const fiber = yield* Effect.forkChild(host.refresh)
      yield* advance(500)
      assert.deepStrictEqual(host.service(Svc), { address: "a1" }, "during: the old shared part")
      assert.include(host.snapshot().registry.specs.map((s) => s.name), "prov_a1")
      yield* advance(600)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(host.service(Svc), { address: "slowi:long" }, "after: the new one")
      assert.deepStrictEqual(host.contributions(Section), ["prov@slowi:long"], "never both")
      const at = probe.log.length
      yield* advance(9_000)
      assert.strictEqual(probe.log.length, at, "the old generation serves its grace period")
      yield* advance(2_000)
      const closed = probe.log.slice(at)
      assert.sameMembers(closed, ["prov:stop-a1/short", "prov:stop-a1/long", "prov:shared-a1"])
      assert.strictEqual(closed.at(-1), "prov:shared-a1", "its instances close before its shared part")
      assert.isUndefined(host.issues.all().find((i) => i.id === "prov.restart"))
    }))

  it.effect("5: a provider used only through `uses` whose new shared part fails keeps its settings and service", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      const consumer = defineModule({ apiVersion: 2, id: "cons", name: "Cons", description: "", uses: ["prov"], start: () => Effect.succeed({}) })
      const persistence = recording()
      const host = yield* hostOf([consumer, provider(probe)], demandOf({ cons: [{ assistantId: "a" }], prov: [] }), { persistence })
      yield* host.startEnabled
      const before = host.service(Svc)
      assert.deepStrictEqual(before, { address: "a1" })
      const result = yield* host.configure("prov", { values: { address: "fail" }, secrets: {} })
      assert.isFalse(result.ok)
      assert.strictEqual(host.service(Svc), before)
      assert.deepStrictEqual(persistence.saves, [], "the failed settings were not saved")
      assert.strictEqual(info(host, "prov").settings.values.address, "a1")
      const ok = yield* host.configure("prov", { values: { address: "a2" }, secrets: {} })
      assert.isTrue(ok.ok)
      assert.deepStrictEqual(host.service(Svc), { address: "a2" })
      assert.strictEqual(persistence.saves.length, 1)
    }))

  it.effect("8: interrupting the start of a shared part closes it at once; the next start is clean", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      const host = yield* hostOf([provider(probe)], undefined, {
        persistence: readOnlyPersistence({ modules: { prov: { enabled: false, settings: { address: "slow" } } }, secrets: {} })
      })
      const fiber = yield* Effect.forkChild(host.enable("prov"))
      yield* advance(200)
      assert.include(probe.log, "prov:shared+slow")
      yield* Fiber.interrupt(fiber)
      assert.include(probe.log, "prov:shared-slow", "closed at the interruption, not at shutdown")
      assert.strictEqual(host.service(Svc), undefined)
      const again = yield* Effect.forkChild(host.enable("prov"))
      yield* advance(1_100)
      assert.isTrue((yield* Fiber.join(again)).ok)
      assert.deepStrictEqual(host.service(Svc), { address: "slow" })
      assert.strictEqual(info(host, "prov").state, "running")
    }))

  it.effect("8: interrupting an instance's start closes it at once; the (demanded) shared part stays published", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      const host = yield* hostOf([provider(probe)], undefined, {
        persistence: readOnlyPersistence({ modules: { prov: { enabled: false, settings: { address: "slowi:short" } } }, secrets: {} })
      })
      const fiber = yield* Effect.forkChild(host.enable("prov"))
      yield* advance(200)
      yield* Fiber.interrupt(fiber)
      assert.include(probe.log, "prov:stop-slowi:short/short", "the instance candidate was closed at the interruption")
      assert.notInclude(probe.log, "prov:shared-slowi:short", "the shared part was published (its switch is on) and serves")
      assert.notStrictEqual(info(host, "prov").state, "starting")
      const again = yield* Effect.forkChild(host.enable("prov"))
      yield* advance(1_100)
      assert.isTrue((yield* Fiber.join(again)).ok)
      assert.strictEqual(info(host, "prov").state, "running")
    }))

  it.effect("8: interrupting a new generation mid-start closes every candidate; the old one serves on", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      const host = yield* hostOf([provider(probe)], demandOf({ prov: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      const fiber = yield* Effect.forkChild(host.configure("prov", { values: { address: "slowi:short" }, secrets: {} }))
      yield* advance(200)
      yield* Fiber.interrupt(fiber)
      assert.include(probe.log, "prov:shared-slowi:short")
      assert.deepStrictEqual(host.service(Svc), { address: "a1" })
      assert.isTrue((yield* host.configure("prov", { values: { address: "a3" }, secrets: {} })).ok, "not left busy")
    }))

  it.effect("9: a direct instance that fails does not take the shared part a `uses` consumer needs", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      const consumer = defineModule({ apiVersion: 2, id: "cons", name: "Cons", description: "", uses: ["prov"], start: () => Effect.succeed({}) })
      const host = yield* hostOf([consumer, provider(probe)], demandOf({ cons: [{ assistantId: "a" }], prov: [{ assistantId: "x" }] }), {
        persistence: readOnlyPersistence({ modules: { prov: { settings: { address: "bad:short" } } }, secrets: {} })
      })
      yield* host.startEnabled
      assert.deepStrictEqual(host.service(Svc), { address: "bad:short" }, "the healthy shared part stays")
      assert.strictEqual(info(host, "prov").state, "error")
      assert.match(info(host, "prov").error ?? "", /bad short/)
    }))
})

describe("tool-triggered restarts run outside the turn (finding 3)", () => {
  it.effect("the new start and the fibers it forks see no CurrentTurn", () =>
    Effect.gen(function*() {
      const seen: Array<string> = []
      let api: ModuleHostApi | undefined
      const later = yield* Deferred.make<void>()
      const mod = defineModule({
        apiVersion: 2,
        id: "mcp",
        name: "MCP",
        description: "",
        start: ({ host }) =>
          Effect.gen(function*() {
            api = host
            seen.push(`start:${(yield* CurrentTurn)?.assistantId ?? "none"}`)
            yield* Effect.forkScoped(Effect.andThen(Deferred.await(later), Effect.flatMap(CurrentTurn, (t) => Effect.sync(() => seen.push(`job:${t?.assistantId ?? "none"}`)))))
            return {}
          })
      })
      const host = yield* hostOf([mod], demandOf({ mcp: [{ assistantId: "a" }, { assistantId: "b" }] }))
      yield* host.startEnabled
      const turnA: TurnContext = { turnId: 1, conversationId: "c", assistantId: "a", deviceId: "d1", source: "voice" }
      yield* Effect.provideService(api!.requestRestart("tool list changed"), CurrentTurn, turnA)
      yield* settle
      yield* Effect.provideService(Deferred.succeed(later, undefined), CurrentTurn, { ...turnA, assistantId: "b", deviceId: "d2" })
      yield* settle
      assert.deepStrictEqual(seen.filter((s) => s.startsWith("start")), ["start:none", "start:none"])
      assert.isTrue(seen.filter((s) => s.startsWith("job")).every((s) => s === "job:none"), seen.join(","))
    }))
})

describe("a generated action tool runs exactly the values it was admitted with (finding 4)", () => {
  it.effect("the dynamic options change between admission and run: run still gets the admitted value", () =>
    Effect.gen(function*() {
      let rooms = [{ value: "blind:kitchen", label: "Kitchen" }]
      const admitted: Array<unknown> = []
      const ran: Array<unknown> = []
      const mod = defineModule({
        id: "covers",
        name: "Covers",
        description: "",
        start: () =>
          Effect.succeed({
            actions: [
              defineAction({
                id: "open",
                label: "Open",
                description: "Open a cover",
                params: { target: Param.dynamic({ label: "Cover", options: () => rooms }) },
                risk: { classes: ["change", "security"], of: ({ target }) => (String(target).startsWith("garage") ? "security" : "change") },
                run: (values) => Effect.sync(() => void ran.push(values))
              })
            ]
          })
      })
      const host = yield* hostOf([mod], undefined, {
        gatewayHooks: {
          risk: (call: GatewayCall) =>
            Effect.gen(function*() {
              admitted.push({ input: call.input, risk: call.risk })
              // The options change while the policy decides.
              rooms = [{ value: "garage:door", label: "Kitchen" }]
              yield* Effect.yieldNow
              return ALLOW
            })
        }
      })
      yield* host.startEnabled
      const result = yield* host.snapshot().registry.run({ id: "c1", name: "covers_open", input: { target: "Kitchen" } })
      assert.isFalse(result.isError, result.content)
      assert.deepStrictEqual(admitted, [{ input: { target: "blind:kitchen" }, risk: "change" }], "the hook saw the resolved values")
      assert.deepStrictEqual(ran, [{ target: "blind:kitchen" }], "and run got exactly those")
    }))

  it.effect("a risk function that answers a class it did not declare is refused", () =>
    Effect.gen(function*() {
      const gateway = makeExecutionGateway()
      const tool = makeTool({ name: "t", description: "", parameters: Schema.Struct({}), risk: { classes: ["change"], of: () => "security" }, execute: () => Effect.succeed("ran") })
      const error = yield* Effect.flip(gateway.tool(undefined, tool, {}))
      assert.match(error.message, /^Not run: its risk was "security", which it does not declare/)
    }))
})

describe("shared settings and settingsFor (finding 7, plan item 1)", () => {
  const placeModule = (seen: Array<unknown>) =>
    defineModule({
      apiVersion: 2,
      id: "weather",
      name: "Weather",
      description: "",
      settings: {
        place: Setting.text({ label: "Place", overridable: true, check: (v) => (v.trim() === "" ? "Enter a place" : undefined) }),
        units: Setting.choice({ label: "Units", options: [{ value: "metric", label: "Metric" }, { value: "imperial", label: "Imperial" }], default: "metric" })
      },
      shared: ({ settings, settingsFor }) =>
        Effect.sync(() => {
          seen.push({ shared: settings, a: settingsFor("a"), b: settingsFor("b"), none: settingsFor(undefined) })
          return { value: undefined }
        }),
      start: () => Effect.succeed({})
    })

  it.effect("an overridable field with an invalid shared value does not stop the shared part; settingsFor gives each assistant its own", () =>
    Effect.gen(function*() {
      const seen: Array<unknown> = []
      // The shared value of the assistant-owned field is one the field refuses; every assistant has its own.
      const host = yield* hostOf([placeModule(seen)], demandOf({ weather: [{ assistantId: "a", own: { place: "Utrecht" } }, { assistantId: "b", own: { place: "Leeds" } }] }), {
        persistence: readOnlyPersistence({ modules: { weather: { settings: { place: " " } } }, secrets: {} })
      })
      yield* host.startEnabled
      assert.strictEqual(info(host, "weather").state, "running", JSON.stringify(info(host, "weather")))
      assert.deepStrictEqual(seen, [{
        shared: { units: "metric" },
        a: { place: "Utrecht", units: "metric" },
        b: { place: "Leeds", units: "metric" },
        none: undefined
      }])
    }))
})

describe("demand through `uses` and order (finding 6, plan item 3)", () => {
  const consumerOf = (id: string, uses: ReadonlyArray<string>, log: Array<string>) =>
    defineModule({ apiVersion: 2, id, name: id, description: "", uses, start: () => Effect.sync(() => void log.push(`${id}:start`)).pipe(Effect.as({})) })

  it.effect("a consumer becoming unavailable withdraws a provider only it demanded; becoming available again starts it (a chain)", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      let missing = false
      const requirements: RequirementCheck = (rs) => rs.map((requirement) => (missing ? { requirement, state: "missing", detail: "gone is missing" } : { requirement, state: "met", detail: "ok" }))
      const top = defineModule({ apiVersion: 2, id: "top", name: "Top", description: "", uses: ["mid"], requires: [{ tool: "gone", why: "x" }], start: () => Effect.succeed({}) })
      const mid = provider({ log: [] }, { id: "mid", uses: ["prov"], toolName: () => "mid_tool" })
      // `mid` is a provider too; its own service key would clash with prov's, so give it none.
      const midNoService: ModuleDefinition<any> = { ...mid, shared: () => Effect.succeed({ value: { address: "m" } }) }
      const host = yield* hostOf([top, midNoService, provider(probe)], demandOf({ top: [{ assistantId: "a" }], mid: [], prov: [] }), { requirements })
      yield* host.startEnabled
      assert.deepStrictEqual(host.service(Svc), { address: "a1" }, "reached through top → mid → prov")
      missing = true
      yield* host.recheck
      assert.strictEqual(host.service(Svc), undefined, "withdrawn: nobody demands it")
      assert.strictEqual(info(host, "prov").state === "running", false)
      missing = false
      yield* host.recheck
      assert.deepStrictEqual(host.service(Svc), { address: "a1" }, "started again though its own availability never changed")
    }))

  it.effect("a module starts after the shared parts of the modules it uses", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      const host = yield* hostOf([consumerOf("cons", ["prov"], probe.log), provider(probe, { id: "prov" })], demandOf({ cons: [{ assistantId: "a" }], prov: [] }), {
        persistence: readOnlyPersistence({ modules: { prov: { settings: { address: "slow" } } }, secrets: {} })
      })
      const fiber = yield* Effect.forkChild(host.startEnabled)
      yield* advance(1_100)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(probe.log.filter((l) => l !== "prov:shared+slow"), ["cons:start"])
      assert.isBelow(probe.log.indexOf("prov:shared+slow"), probe.log.indexOf("cons:start"))
    }))

  it.effect("a cycle in `uses` is an error for every module in it, found when the catalogue is read", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const host = yield* hostOf([consumerOf("x", ["y"], log), consumerOf("y", ["x"], log), consumerOf("z", ["x"], log)], demandOf({ x: [{ assistantId: "a" }], y: [], z: [{ assistantId: "a" }] }))
      assert.strictEqual(info(host, "x").state, "error")
      assert.strictEqual(info(host, "y").state, "error")
      assert.match(info(host, "x").error ?? "", /cycle \(x → y → x\)|cycle \(y → x → y\)/)
      yield* host.startEnabled
      assert.deepStrictEqual(log, ["z:start"], "the cycle never starts; z (outside it) does not wait forever")
      assert.include(host.issues.all().map((i) => i.id), "x.uses")
    }))
})

describe("switching an unavailable module (finding 10)", () => {
  const missing: RequirementCheck = (rs) => rs.map((requirement) => ({ requirement, state: "missing", detail: "yt-dlp is missing" }))
  const music = defineModule({ id: "music", name: "Music", description: "", requires: [{ tool: "yt-dlp", why: "streams" }], start: () => Effect.succeed({}) })

  it.effect("with demand: on and off are announced, and the issue's severity follows", () =>
    Effect.gen(function*() {
      const demand = demandOf({ music: [] })
      const host = yield* hostOf([music], demand, { requirements: missing })
      const seen: Array<ModuleInfo> = []
      host.subscribe((i) => seen.push(i))
      yield* host.startEnabled
      assert.strictEqual(host.issues.all()[0]?.severity, "warning")
      demand.current = new Map([["music", [{ assistantId: "a" }]]])
      yield* host.refresh
      assert.isTrue(seen.at(-1)?.enabled, "announced on")
      assert.strictEqual(host.issues.all()[0]?.severity, "error")
      demand.current = new Map([["music", []]])
      yield* host.refresh
      assert.isFalse(seen.at(-1)?.enabled, "announced off")
      assert.strictEqual(host.issues.all()[0]?.severity, "warning")
    }))

  it.effect("without demand: enabling it publishes its instructions line and announces it", () =>
    Effect.gen(function*() {
      const host = yield* hostOf([{ ...music, enabledByDefault: false }], undefined, { requirements: missing })
      const seen: Array<ModuleInfo> = []
      host.subscribe((i) => seen.push(i))
      yield* host.startEnabled
      assert.deepStrictEqual(host.snapshot().instructions, [])
      yield* host.enable("music")
      assert.match(host.snapshot().instructions[0] ?? "", /^Music is not set up on this server/)
      assert.isTrue(seen.at(-1)?.enabled)
      assert.strictEqual(host.issues.all()[0]?.severity, "error")
    }))
})

describe("wire safety (findings 13, 14)", () => {
  it("13: a template with a bad module id or a long suggested phrase is refused when defined", () => {
    const base = { id: "t", name: "T", description: "", start: () => Effect.succeed({}) }
    assert.throws(() => defineModule({ ...base, templates: [{ id: "a", name: "A", prompt: "", modules: ["bad id"] }] }), /"bad id" is not a module id/)
    assert.throws(() => defineModule({ ...base, templates: [{ id: "a", name: "A", prompt: "", suggestedPhrases: ["x".repeat(61)] }] }), /over 60 characters/)
  })

  it.effect("13: an accepted template encodes in the admin snapshot's module info", () =>
    Effect.gen(function*() {
      const mod = defineModule({ id: "dj", name: "DJ", description: "", templates: [{ id: "dj", name: "DJ", prompt: "Play.", modules: ["dj", "clock"], suggestedPhrases: ["hey dj"] }], start: () => Effect.succeed({}) })
      const host = yield* hostOf([mod], undefined)
      yield* host.startEnabled
      assert.doesNotThrow(() => encodeServerMessage({ type: "module.changed", module: host.modules()[0]! }))
    }))

  it.effect("14: a health issue with an over-long fix label and value, or an unknown severity, still encodes", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "noisy",
        name: "Noisy",
        description: "",
        health: () =>
          Effect.succeed([
            { id: "long", severity: "warning", title: "t", detail: "d", fix: { kind: "command", label: "l".repeat(250), value: "v".repeat(1500) } },
            { id: "odd", severity: "fatal" as HealthIssue["severity"], title: "t", detail: "d" }
          ]),
        start: () => Effect.succeed({})
      })
      const host = yield* hostOf([mod], undefined)
      yield* host.startEnabled
      yield* host.checkHealth
      const all = host.issues.all()
      assert.strictEqual(all.length, 2)
      assert.doesNotThrow(() => encodeServerMessage({ type: "health", health: { issues: [...all], checking: false } }))
      assert.strictEqual(all.find((i) => i.id === "noisy.long")?.fix?.label.length, 200)
      assert.strictEqual(all.find((i) => i.id === "noisy.long")?.fix?.value?.length, 1000)
      assert.match(all.find((i) => i.id.startsWith("noisy.malformed"))?.title ?? "", /cannot be shown/)
    }))
})

describe("a provider used only through `uses` (finding 15)", () => {
  it.effect("is running while its shared part runs, its health() is told so, and it stops with its last user", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      const runningSeen: Array<boolean> = []
      const consumer = defineModule({ apiVersion: 2, id: "cons", name: "Cons", description: "", uses: ["prov"], start: () => Effect.succeed({}) })
      const prov = { ...provider(probe), health: ({ running }: { readonly running: boolean }) => Effect.sync(() => (runningSeen.push(running), [])) } as ModuleDefinition<any>
      const demand = demandOf({ cons: [{ assistantId: "a" }], prov: [] })
      const host = yield* hostOf([consumer, prov], demand)
      yield* host.startEnabled
      assert.strictEqual(info(host, "prov").state, "running")
      assert.strictEqual(host.view().modules.find((m) => m.id === "prov")?.state, "running")
      yield* host.checkHealth
      demand.current = new Map([["cons", []], ["prov", []]])
      yield* host.refresh
      yield* advance(11_000)
      assert.strictEqual(info(host, "prov").state, "disabled")
      yield* host.checkHealth
      assert.deepStrictEqual(runningSeen, [true, false])
    }))
})

describe("restarts keep their settings (findings 16, 23)", () => {
  const keyed = (starts: Array<string>, fail: { current: boolean }) =>
    defineModule({
      apiVersion: 2,
      id: "keyed",
      name: "Keyed",
      description: "",
      settings: { token: Setting.secret({ label: "Token", required: true }), region: Setting.text({ label: "Region", default: "eu" }) },
      start: ({ host, settings }) =>
        Effect.gen(function*() {
          if (fail.current) return yield* new ModuleStartError({ message: "the server said no" })
          starts.push(settings.token ?? "")
          restartOf = host.requestRestart
          return {}
        })
    })
  let restartOf: ((reason: string) => Effect.Effect<void>) | undefined

  it.effect("16: after the vault locked, a requested restart starts it again with the key it runs with", () =>
    Effect.gen(function*() {
      const starts: Array<string> = []
      const host = yield* hostOf([keyed(starts, { current: false })], undefined, { persistence: readOnlyPersistence({ modules: {}, secrets: { keyed: { token: "s3cret" } } }) })
      yield* host.startEnabled
      yield* host.setSecrets({})
      yield* restartOf!("tools changed")
      yield* settle
      assert.deepStrictEqual(starts, ["s3cret", "s3cret"])
      assert.strictEqual(info(host, "keyed").state, "running")
    }))

  it.effect("23: a failed restart's warning goes when a configure succeeds, and when the module is switched off", () =>
    Effect.gen(function*() {
      const starts: Array<string> = []
      const fail = { current: false }
      const host = yield* hostOf([keyed(starts, fail)], undefined, { persistence: readOnlyPersistence({ modules: {}, secrets: { keyed: { token: "t" } } }) })
      yield* host.startEnabled
      const restartWarning = () => host.issues.all().some((i) => i.id === "keyed.restart")
      fail.current = true
      yield* restartOf!("x")
      yield* settle
      assert.isTrue(restartWarning())
      fail.current = false
      assert.isTrue((yield* host.configure("keyed", { values: { region: "us" }, secrets: {} })).ok)
      assert.isFalse(restartWarning(), "cleared by the successful configure")
      fail.current = true
      yield* restartOf!("y")
      yield* settle
      assert.isTrue(restartWarning())
      yield* host.disable("keyed")
      assert.isFalse(restartWarning(), "cleared when it stops")
    }))

  it.effect("plan item 2: requestRestart from the shared part starts a new generation (shared and instances), switched at once", () =>
    Effect.gen(function*() {
      const probe: Probe = { log: [] }
      let sharedApi: ModuleHostApi | undefined
      const base = provider(probe)
      const mod: ModuleDefinition<any> = {
        ...base,
        shared: (ctx) =>
          Effect.tap(base.shared!(ctx), () =>
            Effect.sync(() => {
              sharedApi = ctx.host
            }))
      }
      const host = yield* hostOf([mod], demandOf({ prov: [{ assistantId: "a" }] }))
      yield* host.startEnabled
      const before = host.service(Svc)
      yield* sharedApi!.requestRestart("reconnect")
      yield* settle
      assert.notStrictEqual(host.service(Svc), before, "a new shared part")
      assert.deepStrictEqual(probe.log.filter((l) => l.startsWith("prov:start")), ["prov:start+a1/short", "prov:start+a1/short"])
      yield* advance(11_000)
      assert.includeMembers(probe.log, ["prov:shared-a1", "prov:stop-a1/short"])
    }))
})

describe("an unavailable module's actions on the intent path (finding 17)", () => {
  const noul = (value: number): DecisionAnswer => ({ type: "noul", value })
  const wants = (action: string) => (request: DecisionRequest) => {
    const options = Object.keys((request.questions.action as { options: Record<string, unknown> } | undefined)?.options ?? {})
    const probabilities: Record<string, number> = {}
    for (const o of options) probabilities[o] = o === action ? 0.94 : 0.06 / Math.max(1, options.length - 1)
    return { answers: { action: choiceAnswer(probabilities), fits: noul(0.95), compound: noul(0.03) } }
  }
  const turn = (actions: AgentTurnInput["actions"], tools: AgentTurnInput["tools"]): AgentTurnInput => ({
    turnId: 1,
    conversationId: "c1",
    text: "Play some jazz.",
    utterance: "Hey Jev, play some jazz.",
    source: "voice",
    spoken: true,
    routedBy: "trigger",
    history: [],
    system: "",
    context: undefined,
    tools,
    actions,
    deciders: new Map([["scripted", makeScriptedDecider(wants("music.play"))]]),
    promoted: Effect.void,
    speculative: false,
    mark: () => {},
    trace: { id: 1, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] },
    maxToolRounds: 5
  })
  const spokenOf = (events: ReadonlyArray<AgentEvent>) => events.flatMap((e) => (e._tag === "TextDelta" && e.text !== "\n" ? [e.text] : [])).join("")
  const music = defineModule({
    id: "music",
    name: "Music",
    description: "",
    requires: [{ tool: "yt-dlp", why: "streams" }],
    declaredActions: [{ id: "play", label: "Play music", description: "Play music", examples: ["play some jazz"] }],
    start: () =>
      Effect.succeed({ actions: [defineAction({ id: "play", label: "Play music", description: "Play music", examples: ["play some jazz"], params: {}, run: () => Effect.succeed({ say: "Playing." }) })] })
  })
  const lights = defineModule({
    id: "lights",
    name: "Lights",
    description: "",
    start: () => Effect.succeed({ actions: [defineAction({ id: "on", label: "Lights on", description: "Lights on", params: {}, run: () => Effect.succeed({ say: "Lights on." }) })] })
  })
  const asA: TurnContext = { turnId: 1, conversationId: "c1", assistantId: "a", deviceId: "d", source: "voice" }

  const runTurn = (host: { readonly snapshot: () => import("../src/ModuleHost.ts").ModuleSnapshot; readonly gateway: import("../src/Gateway.ts").ExecutionGateway }) =>
    Effect.gen(function*() {
      const parts = host.snapshot().assistantParts.get("a") ?? []
      const registry = makeToolRegistry(parts.map((p) => p.module), { gateway: host.gateway })
      const events = yield* Stream.runCollect(makeIntentAgent({ deciders: ["scripted"] }).turn(turn(registry.actions ?? [], registry))).pipe(
        Effect.map((c) => Array.from(c)),
        Effect.provideService(CurrentTurn, asA)
      )
      return spokenOf(events)
    })

  it.effect("unavailable from the start: 'play jazz' is the music module's, answered with its not-set-up line", () =>
    Effect.gen(function*() {
      const missing: RequirementCheck = (rs) => rs.map((requirement) => ({ requirement, state: "missing", detail: "yt-dlp is missing" }))
      const host = yield* hostOf([music, lights], demandOf({ music: [{ assistantId: "a" }], lights: [{ assistantId: "a" }] }), {
        requirements: missing,
        access: { moduleOn: () => true, toolOff: () => false }
      })
      yield* host.startEnabled
      assert.strictEqual(yield* runTurn(host), "Music is not set up on this server (yt-dlp is missing).")
      const listed = yield* Effect.provideService(host.actions.list, CurrentTurn, asA)
      assert.includeMembers(listed.map((a) => a.id), ["music.play", "lights.on"])
      const run = yield* Effect.provideService(host.actions.run({ moduleId: "music", actionId: "play", params: {} }), CurrentTurn, asA)
      assert.deepStrictEqual(run, { ok: false, code: "unavailable", message: "Music is not set up on this server (yt-dlp is missing)." })
    }))

  it.effect("available, then unavailable after Check again: the action stays known and says why", () =>
    Effect.gen(function*() {
      let gone = false
      const requirements: RequirementCheck = (rs) => rs.map((requirement) => (gone ? { requirement, state: "missing", detail: "yt-dlp is missing" } : { requirement, state: "met", detail: "yt-dlp 2025.1.1" }))
      const host = yield* hostOf([music, lights], demandOf({ music: [{ assistantId: "a" }], lights: [{ assistantId: "a" }] }), {
        requirements,
        access: { moduleOn: () => true, toolOff: () => false }
      })
      yield* host.startEnabled
      assert.strictEqual(yield* runTurn(host), "Playing.")
      gone = true
      yield* host.recheck
      assert.strictEqual(yield* runTurn(host), "Music is not set up on this server (yt-dlp is missing).")
    }))
})

describe("contributions inside a turn (plan item 4)", () => {
  it.effect("hold only those of modules the turn's assistant has on; outside a turn all; services are not filtered", () =>
    Effect.gen(function*() {
      const host = yield* hostOf([provider({ log: [] })], demandOf({ prov: [{ assistantId: "a" }] }), {
        access: { moduleOn: (assistant, moduleId) => !(assistant === "b" && moduleId === "prov"), toolOff: () => false }
      })
      yield* host.startEnabled
      const inTurn = (assistantId: string) =>
        Effect.provideService(Effect.sync(() => [host.contributions(Section), host.service(Svc)]), CurrentTurn, { turnId: 1, conversationId: "c", assistantId, source: "voice" })
      assert.deepStrictEqual(yield* inTurn("a"), [["prov@a1"], { address: "a1" }])
      assert.deepStrictEqual(yield* inTurn("b"), [[], { address: "a1" }])
      assert.deepStrictEqual(host.contributions(Section), ["prov@a1"])
    }))
})

describe("the vault changes while an operation runs (beyond the list)", () => {
  it.effect("a lock during a configure is applied after it, not overwritten by its commit", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "keyed2",
        name: "Keyed",
        description: "",
        settings: { token: Setting.secret({ label: "Token" }), region: Setting.text({ label: "Region", default: "eu" }) },
        start: ({ settings }) => Effect.as(settings.region === "slow" ? Effect.sleep(1_000) : Effect.void, {})
      })
      const host = yield* hostOf([mod], undefined, { persistence: readOnlyPersistence({ modules: {}, secrets: { keyed2: { token: "t" } } }) })
      yield* host.startEnabled
      const fiber = yield* Effect.forkChild(host.configure("keyed2", { values: { region: "slow" }, secrets: {} }))
      yield* advance(200)
      yield* host.setSecrets({})
      yield* advance(1_000)
      assert.isTrue((yield* Fiber.join(fiber)).ok)
      yield* settle
      assert.isFalse(info(host, "keyed2").settings.secrets.token?.set, "the lock reported meanwhile stands")
      assert.strictEqual(info(host, "keyed2").settings.values.region, "slow")
    }))
})
