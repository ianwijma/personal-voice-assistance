// The four fixes below the module scaffold (docs/MODULES-PLAN.md §4 P11, "Decided after the scaffold's first review"):
// the default risk policy enforced by the gateway, a tool without parameters sent as an object schema, bad tool names
// refused when a module starts, and a job's payload checked when it is scheduled (with the cron check exported).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, SchemaGetter } from "effect"
import { defineAction } from "../src/Actions.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule, type ModuleDefinition } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { defaultRiskPolicy } from "../src/RiskPolicy.ts"
import { isSchedulerCron } from "../src/SchedulerEngine.ts"
import { makeTestScheduler, startTestModule } from "../src/testing.ts"
import { makeToolRegistry, toolSpec } from "../src/ToolRegistry.ts"

describe("the risk policy (P1's default, enforced by the gateway)", () => {
  it("read and change are allowed; message needs confirmation; money and security are denied, each with its own sentence", () => {
    assert.deepStrictEqual(["read", "change"].map((r) => defaultRiskPolicy(r as never).outcome), ["allow", "allow"])
    const message = defaultRiskPolicy("message")
    const money = defaultRiskPolicy("money")
    const security = defaultRiskPolicy("security")
    assert.deepStrictEqual([message.outcome, money.outcome, security.outcome], ["confirm", "deny", "deny"])
    const reasons = [message, money, security].map((v) => (v.outcome === "allow" ? "" : v.reason))
    assert.strictEqual(new Set(reasons).size, 3)
    assert.match(reasons[0]!, /confirmation/)
    assert.match(reasons[1]!, /money/)
    assert.match(reasons[2]!, /lock/)
  })

  const ran: Array<string> = []
  const jobResults: Array<boolean> = []
  const door = defineModule({
    apiVersion: 2,
    id: "door",
    name: "Door",
    description: "A door with a lock.",
    enabledByDefault: false,
    shared: (ctx) =>
      Effect.gen(function*() {
        // A job that tries the lock through the gateway, as a routine step would.
        yield* ctx.scheduler.handle("try_unlock", {
          payload: Schema.Struct({}),
          run: () => Effect.map(ctx.host.actions.run({ moduleId: "door", actionId: "unlock", params: {} }), (r) => void jobResults.push(r.ok))
        }).pipe(Effect.orDie)
        return { value: undefined }
      }),
    start: () =>
      Effect.succeed({
        tools: [
          makeTool({ name: "door_status", description: "Whether the door is locked.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("locked") }),
          makeTool({
            name: "door_open",
            description: "Open the front door (security).",
            parameters: Schema.Struct({}),
            risk: "security",
            execute: () => Effect.sync(() => void ran.push("door_open"))
          }),
          makeTool({ name: "door_mail", description: "Mail the owner's friend.", parameters: Schema.Struct({}), risk: "message", execute: () => Effect.sync(() => void ran.push("door_mail")) }),
          makeTool({
            name: "door_cover",
            description: "Move a blind (change) or the garage door (security).",
            parameters: Schema.Struct({ garage: Schema.Boolean }),
            risk: { classes: ["change", "security"], of: (input: { readonly garage: boolean }) => (input.garage ? "security" : "change") },
            execute: ({ garage }) => Effect.sync(() => void ran.push(garage ? "garage" : "blind"))
          })
        ],
        actions: [
          defineAction({ id: "unlock", label: "Unlock", description: "Unlock the door (security).", examples: ["unlock the door"], params: {}, risk: "security", run: () => Effect.sync(() => void ran.push("unlock")) }),
          defineAction({ id: "ring", label: "Ring", description: "Ring the bell.", examples: ["ring the bell"], params: {}, risk: "change", run: () => Effect.sync(() => void ran.push("ring")) })
        ]
      })
  })

  it.effect("through the test kit: a security tool is not offered, and refused when called directly and as a typed action", () =>
    Effect.gen(function*() {
      ran.length = 0
      jobResults.length = 0
      const kit = yield* startTestModule(door)
      // Left out of the model's list: every class it can be is refused. A tool that can also be `change` stays.
      assert.deepStrictEqual(kit.toolNames(), ["door_status", "door_cover", "door_ring"])
      const direct = yield* kit.tool("door_open", {})
      assert.isFalse(direct.ok)
      assert.strictEqual(direct.content, "Not run: it would act on a lock, an alarm, a door or a gate, which this assistant never does.")
      const mail = yield* kit.tool("door_mail", {})
      assert.match(mail.content, /^Not run: it would send a message in the owner's name, which needs the owner's confirmation/)
      // Checked again with the validated input: the blind runs, the garage door does not.
      assert.isTrue((yield* kit.tool("door_cover", { garage: false })).ok)
      assert.match((yield* kit.tool("door_cover", { garage: true })).content, /^Not run: it would act on a lock/)
      const action = yield* kit.action("unlock")
      assert.isFalse(action.ok)
      const generated = yield* kit.tool("door_unlock", {})
      assert.match(generated.content, /^Not run: it would act on a lock/)
      assert.isTrue((yield* kit.action("ring")).ok)
      assert.deepStrictEqual(ran, ["blind", "ring"])
    }))

  it.effect("from a job, the action its handler runs is refused too", () =>
    Effect.gen(function*() {
      ran.length = 0
      jobResults.length = 0
      const scheduling: ModuleDefinition<any> = {
        ...door,
        shared: (ctx) =>
          Effect.gen(function*() {
            yield* door.shared!(ctx)
            yield* ctx.scheduler.schedule({ handler: "try_unlock", inMs: 60_000 }).pipe(Effect.orDie)
            return { value: undefined }
          })
      }
      const kit = yield* startTestModule(scheduling)
      yield* kit.advance(60_000)
      assert.deepStrictEqual(jobResults, [false])
      assert.deepStrictEqual(ran, [])
    }))

  it.effect("a registry without the policy (a hand-made one) offers every tool, as before", () =>
    Effect.gen(function*() {
      const registry = makeToolRegistry([{ name: "door", tools: [makeTool({ name: "door_open", description: "Open (security).", parameters: Schema.Struct({}), risk: "security", execute: () => Effect.succeed("open") })] }])
      assert.deepStrictEqual(registry.specs.map((s) => s.name), ["door_open"])
    }))
})

describe("a tool without parameters is sent as an object schema", () => {
  it("an empty struct, with or without annotations, is { type: object, properties: {} }; a struct with fields is as before", () => {
    const empty = makeTool({ name: "a", description: "A.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("") })
    const annotated = makeTool({ name: "b", description: "B.", parameters: Schema.Struct({}).annotate({ description: "Nothing" }), speculative: true, execute: () => Effect.succeed("") })
    const fields = makeTool({ name: "c", description: "C.", parameters: Schema.Struct({ x: Schema.String }), speculative: true, execute: () => Effect.succeed("") })
    assert.deepStrictEqual(toolSpec(empty).inputSchema, { type: "object", properties: {} })
    assert.deepStrictEqual(toolSpec(annotated).inputSchema, { type: "object", properties: {} })
    assert.strictEqual(toolSpec(fields).inputSchema.type, "object")
    assert.deepStrictEqual(Object.keys(toolSpec(fields).inputSchema.properties as object), ["x"])
  })

  it.effect("a generated action tool without parameters reaches the model as an object schema", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(defineModule({
        apiVersion: 2,
        id: "bell",
        name: "Bell",
        description: "A bell.",
        enabledByDefault: false,
        start: () => Effect.succeed({ actions: [defineAction({ id: "ring", label: "Ring", description: "Ring it.", examples: ["ring"], params: {}, risk: "change", run: () => Effect.void })] })
      }))
      const parts = kit.host.snapshot().assistantParts.get("jeff") ?? []
      const spec = makeToolRegistry(parts.map((p) => p.module), { gateway: kit.host.gateway }).specs.find((s) => s.name === "bell_ring")
      assert.deepStrictEqual(spec?.inputSchema, { type: "object", properties: {} })
    }))
})

describe("the host refuses tool names model providers refuse, when a module starts", () => {
  const startWith = (instance: { readonly tools?: ReadonlyArray<ReturnType<typeof makeTool>>; readonly actions?: ReadonlyArray<ReturnType<typeof defineAction>> }, id = "named") =>
    Effect.gen(function*() {
      const def = defineModule({ apiVersion: 2, id, name: "Named", description: "Names.", start: () => Effect.succeed(instance) })
      const host = yield* makeModuleHost({ catalog: [def], persistence: readOnlyPersistence({ modules: { [id]: { enabled: true } }, secrets: {} }), env: {} })
      yield* host.startEnabled
      return host.modules().find((m) => m.id === id)!
    })
  const tool = (name: string) => makeTool({ name, description: "A tool.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("") })

  it.effect("a name outside [A-Za-z0-9_-]{1,64}, a duplicate, and a generated action name over 64 characters fail the start, naming it", () =>
    Effect.gen(function*() {
      const bad = yield* startWith({ tools: [tool("bad name!")] })
      assert.strictEqual(bad.state, "error")
      assert.include(bad.error, '"bad name!"')
      const twice = yield* startWith({ tools: [tool("same"), tool("same")] })
      assert.include(twice.error, '"same" twice')
      const longId = "an_action_id_that_is_long_enough_xyz"
      const long = yield* startWith({ actions: [defineAction({ id: longId, label: "L", description: "Long.", examples: ["x"], params: {}, speculative: true, run: () => Effect.void })] }, "a-module-with-a-long-identifier-too")
      assert.strictEqual(long.state, "error")
      assert.include(long.error, `"${longId}"`)
      const fine = yield* startWith({ tools: [tool("fine_name-1")] })
      assert.strictEqual(fine.state, "running")
    }))
})

describe("the scheduler checks a payload when a job is scheduled", () => {
  it.effect("schedule, prepare and reschedule refuse a payload the published handler does not decode; an absent payload is {}", () =>
    Effect.gen(function*() {
      const { scheduler, advance } = yield* makeTestScheduler()
      const core = scheduler.forCore("core.test")
      const runs: Array<unknown> = []
      // A job scheduled before its handler is there is not checked then (it is when it runs, or rescheduled).
      const early = yield* core.schedule({ handler: "count", payload: { n: "three" }, inMs: 60_000 })
      yield* Effect.forkScoped(core.handle("count", { payload: Schema.Struct({ n: Schema.Finite }), run: (p) => Effect.sync(() => void runs.push(p)) }))
      yield* Effect.forkScoped(core.handle("empty", { payload: Schema.Struct({}), run: (p) => Effect.sync(() => void runs.push(p)) }))
      yield* Effect.yieldNow
      const scheduled = yield* Effect.flip(core.schedule({ handler: "count", payload: { n: "x" }, inMs: 1_000 }))
      assert.strictEqual(scheduled.reason, "invalid")
      assert.match(scheduled.message, /payload does not fit the handler "count"/)
      const prepared = yield* Effect.flip(core.prepare({ handler: "count", inMs: 1_000 }))
      assert.strictEqual(prepared.reason, "invalid")
      const rescheduled = yield* Effect.flip(core.reschedule(early.id, { inMs: 1_000 }))
      assert.strictEqual(rescheduled.reason, "invalid")
      // A payload that fits, and an absent one for a handler of Schema.Struct({}), run.
      yield* core.schedule({ handler: "count", payload: { n: 3 }, inMs: 1_000 })
      yield* core.schedule({ handler: "empty", inMs: 1_000 })
      yield* advance(1_000)
      assert.deepStrictEqual(runs, [{ n: 3 }, {}])
    }))

  it.effect("a decoder that throws is a refusal at schedule, prepare and reschedule; one that decodes asynchronously is decided when the job runs", () =>
    Effect.gen(function*() {
      const { scheduler, advance } = yield* makeTestScheduler()
      const core = scheduler.forCore("core.test")
      const runs: Array<unknown> = []
      const early = yield* core.schedule({ handler: "broken", payload: { n: "x" }, inMs: 60_000 })
      const broken = Schema.Struct({ n: Schema.String }).check(Schema.makeFilter(() => {
        throw new Error("decoder broke")
      }))
      const slow = Schema.Struct({}).pipe(Schema.decodeTo(Schema.Struct({}), {
        decode: SchemaGetter.transformEffect((x) => Effect.as(Effect.sleep(1), x)),
        encode: SchemaGetter.transform((x) => x)
      }))
      yield* Effect.forkScoped(core.handle("broken", { payload: broken, run: (p) => Effect.sync(() => void runs.push(p)) }))
      yield* Effect.forkScoped(core.handle("slow", { payload: slow, run: (p) => Effect.sync(() => void runs.push(p)) }))
      yield* Effect.yieldNow
      for (const refused of [
        yield* Effect.flip(core.schedule({ handler: "broken", payload: { n: "x" }, inMs: 1_000 })),
        yield* Effect.flip(core.prepare({ handler: "broken", payload: { n: "x" }, inMs: 1_000 })),
        yield* Effect.flip(core.reschedule(early.id, { inMs: 1_000 }))
      ]) {
        assert.strictEqual(refused.reason, "invalid")
        assert.match(refused.message, /decoder failed \(decoder broke\)/)
      }
      // The refused reschedule left the job as it was.
      assert.strictEqual((yield* core.get(early.id))?.dueAt, early.dueAt)
      // An asynchronous decoder is accepted when scheduled, and decoded when the job runs.
      const accepted = yield* core.schedule({ handler: "slow", inMs: 1_000 })
      yield* advance(1_001)
      yield* advance(10)
      assert.deepStrictEqual(runs, [{}])
      assert.strictEqual((yield* core.get(accepted.id))?.state, "done")
    }))

  it("the cron check is exported: what schedule accepts, and why it refuses", () => {
    assert.isUndefined(isSchedulerCron("0 4 * * *"))
    assert.isUndefined(isSchedulerCron("30 7 * * 1-5", "Europe/Amsterdam"))
    assert.match(isSchedulerCron("0 7 1 * *") ?? "", /day of month and month must be \*/)
    assert.match(isSchedulerCron("61 4 * * *") ?? "", /is not a cron schedule/)
    assert.match(isSchedulerCron("0 4 * * *", "Not/AZone") ?? "", /is not a cron schedule/)
    assert.match(isSchedulerCron(42) ?? "", /cron must be/)
  })
})
