// checkModule (docs/MODULES.md, "Testing: checkModule"): every rule fails on a module that breaks it, naming the rule
// and the place, and stays quiet on one that keeps it. The reference module that keeps them all is in
// packages/module-contracts/test/kit.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema, SchemaGetter } from "effect"
import { defineAction, Param } from "../src/Actions.ts"
import { defineCollection } from "../src/HouseholdStore.ts"
import { ServiceKey } from "../src/ModuleApi.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { Setting } from "../src/Settings.ts"
import {
  checkModule,
  collectionWorst,
  makeTestHousehold,
  type ModuleProblem,
  moduleProblems,
  provide,
  STORED_TEXT_PATTERN_SOURCE,
  stubService,
  worstJsonChars
} from "../src/testing.ts"

const rules = (problems: ReadonlyArray<ModuleProblem>) => problems.map((p) => `${p.rule} ${p.where}`)
const ok = defineModule({ apiVersion: 2, id: "fine", name: "Fine", description: "Keeps every rule.", enabledByDefault: false, start: () => Effect.succeed({}) })

describe("checkModule", () => {
  it.effect("a module that keeps the rules passes", () => checkModule(ok))

  it.effect("api-version and off-by-default", () =>
    Effect.gen(function*() {
      const v1 = defineModule({ id: "old", name: "Old", description: "A version 1 module.", start: () => Effect.succeed({}) })
      assert.deepStrictEqual(rules(yield* moduleProblems(v1)), ["api-version definition", "off-by-default definition"])
      assert.deepStrictEqual(rules(yield* moduleProblems(v1, { onByDefault: true })), ["api-version definition"])
    }))

  it.effect("the form: a settings form over its budget does not start", () =>
    Effect.gen(function*() {
      const settings = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, Setting.text({ label: `Field ${i}`, description: "x".repeat(400) })]))
      const big = defineModule({ apiVersion: 2, id: "big", name: "Big", description: "Too large a form.", enabledByDefault: false, settings, start: () => Effect.succeed({}) })
      const problems = yield* moduleProblems(big)
      assert.deepStrictEqual(problems.map((p) => p.rule), ["form"])
      assert.match(problems[0]!.message, /larger than the 8192 bytes/)
    }))

  it.effect("start: a module that fails to start with the given settings", () =>
    Effect.gen(function*() {
      const failing = defineModule({
        apiVersion: 2,
        id: "failing",
        name: "Failing",
        description: "Needs an address.",
        enabledByDefault: false,
        settings: { url: Setting.text({ label: "Address" }) },
        start: ({ settings }) => (settings.url === "" ? Effect.die(new Error("no address")) : Effect.succeed({}))
      })
      assert.deepStrictEqual(rules(yield* moduleProblems(failing)), ["start start"])
      assert.deepStrictEqual(rules(yield* moduleProblems(failing, { settings: { url: "http://hub.lan" } })), [])
    }))

  it.effect("risk, risk-said, tool-name, tool-description, tool-parameters and action-examples", () =>
    Effect.gen(function*() {
      const tools = defineModule({
        apiVersion: 2,
        id: "tools",
        name: "Tools",
        description: "Tools that break the rules.",
        enabledByDefault: false,
        start: () =>
          Effect.succeed({
            tools: [
              makeTool({ name: "reads", description: "A plain read.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("ok") }),
              makeTool({ name: "writes", description: "Changes something.", parameters: Schema.Struct({ x: Schema.String }), execute: () => Effect.succeed("ok") }),
              makeTool({ name: "opens_door", description: "Opens the door.", parameters: Schema.Struct({}), risk: "security", execute: () => Effect.succeed("ok") }),
              makeTool({ name: "blank", description: "", parameters: Schema.String, risk: "change", execute: () => Effect.succeed("ok") }),
              makeTool({ name: "params", description: "Odd parameter.", parameters: Schema.Struct({ "a b": Schema.String }), risk: "change", execute: () => Effect.succeed("ok") }),
              makeTool({ name: "wordy", description: "x".repeat(1_025), parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("ok") }),
              // No parameters, with an annotation: sent as an object schema, so it keeps the rule.
              makeTool({ name: "bare", description: "Nothing to give.", parameters: Schema.Struct({}).annotate({ description: "none" }), speculative: true, execute: () => Effect.succeed("ok") })
            ],
            actions: [
              defineAction({ id: "silent", label: "Silent", description: "No examples.", params: {}, risk: "change", run: () => Effect.void }),
              // A generated action tool is checked like a tool: its parameter names and its description (label first).
              defineAction({ id: "odd", label: "Odd", description: "An odd parameter.", examples: ["odd"], params: { "bad name": Param.text({ label: "x", after: ["about"] }) }, risk: "change", run: () => Effect.void }),
              defineAction({ id: "long_text", label: "Long", description: "y".repeat(1_020), examples: ["long"], params: {}, risk: "change", run: () => Effect.void })
            ]
          })
      })
      assert.deepStrictEqual(rules(yield* moduleProblems(tools)).sort(), [
        "action-examples action silent",
        "risk tool writes",
        "risk-said tool opens_door",
        "tool-description tool blank",
        "tool-parameters tool blank",
        "tool-parameters tool params",
        "tool-description tool wordy",
        "tool-parameters action odd",
        "tool-description action long_text"
      ].sort())
    }))

  it.effect("tool-name: the host refuses a bad name, a name used twice and a generated name over 64 characters, so the start fails naming it", () =>
    Effect.gen(function*() {
      const named = (id: string, instance: Parameters<typeof Effect.succeed>[0]) =>
        defineModule({ apiVersion: 2, id, name: "Named", description: "Names.", enabledByDefault: false, start: () => Effect.succeed(instance as never) })
      const bad = yield* moduleProblems(named("bad", { tools: [makeTool({ name: "bad name!", description: "Bad.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("") })] }))
      assert.deepStrictEqual(rules(bad), ["start start"])
      assert.include(bad[0]!.message, '"bad name!"')
      const long = yield* moduleProblems(named("a-module-with-a-rather-long-identifier", {
        actions: [defineAction({ id: "an_action_with_a_long_id_too", label: "L", description: "d", examples: ["x"], params: {}, speculative: true, run: () => Effect.void })]
      }))
      assert.deepStrictEqual(rules(long), ["start start"])
      assert.include(long[0]!.message, '"an_action_with_a_long_id_too"')
    }))

  it.effect("every instance is checked: a second assistant's own settings that make a bad tool are found", () =>
    Effect.gen(function*() {
      const split = defineModule({
        apiVersion: 2,
        id: "split",
        name: "Split",
        description: "Depends on a per-assistant setting.",
        enabledByDefault: false,
        settings: { odd: Setting.boolean({ label: "Odd", default: false, overridable: true }) },
        start: (ctx) =>
          Effect.succeed({
            tools: [makeTool({ name: "split_read", description: ctx.settings.odd ? "" : "Reads.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("") })]
          })
      })
      const problems = yield* moduleProblems(split, {
        household: { assistants: [{ id: "jeff" }, { id: "odd", modules: { split: { own: { odd: true } } } }] }
      })
      assert.deepStrictEqual(rules(problems), ["tool-description tool split_read"])
    }))

  it.effect("stored-value: unbounded fields and a worst value over maxChars", () =>
    Effect.gen(function*() {
      const free = defineCollection({ name: "free", scope: "household", schema: Schema.Struct({ text: Schema.String }) })
      const tight = defineCollection({ name: "tight", scope: "household", maxChars: 100, schema: Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(50)) }) })
      const store = defineModule({ apiVersion: 2, id: "store", name: "Store", description: "Collections.", enabledByDefault: false, storage: { collections: [free, tight] }, start: () => Effect.succeed({}) })
      const problems = yield* moduleProblems(store)
      assert.deepStrictEqual(rules(problems), ["stored-value collection free", "stored-value collection tight"])
      assert.match(problems[0]!.message, /text \(a string without a maximum length\)/)
      assert.match(problems[1]!.message, /takes 311 characters of JSON, over its maxChars of 100/)
    }))

  it.effect("collection: a declaration the store's own check refuses; indexed values are not judged (the store does that at write)", () =>
    Effect.gen(function*() {
      const good = defineCollection({ name: "good", scope: "household", maxChars: 2_000, indexes: ["tag"], schema: Schema.Struct({ tag: Schema.String.check(Schema.isMaxLength(50)) }) })
      // Made by hand, past defineCollection: an index on a row's own field.
      const handMade = { ...good, name: "hand", indexes: ["createdAt"], fields: ["createdAt"] } as typeof good
      const declared = defineModule({ apiVersion: 2, id: "declared", name: "Declared", description: "Collections.", enabledByDefault: false, storage: { collections: [handMade] }, start: () => Effect.succeed({}) })
      const problems = yield* moduleProblems(declared)
      assert.deepStrictEqual(rules(problems), ["collection collection hand"])
      assert.match(problems[0]!.message, /store refuses its declaration: .*"createdAt" is a row's own field/)
      // Indexes the old analysis judged wrongly, both ways, are left to the store: a module's tests write the rows.
      const free = defineCollection({
        name: "free",
        scope: "household",
        maxChars: 2_000,
        indexes: ["tag", "empty", "gone"],
        schema: Schema.Struct({ tag: Schema.String.check(Schema.isMaxLength(50), Schema.isPattern(/^[a-z]*$/)), empty: Schema.String.check(Schema.isMaxLength(0)) })
      })
      const fine = defineModule({ apiVersion: 2, id: "fine2", name: "Fine", description: "Collections.", enabledByDefault: false, storage: { collections: [free] }, start: () => Effect.succeed({}) })
      assert.deepStrictEqual(rules(yield* moduleProblems(fine)), [])
      // The store itself refuses an illegal indexed value when it is written.
      const household = yield* makeTestHousehold([fine])
      const handle = household.store.forModule("fine2").collection(free)
      yield* handle.insert({ tag: "a".repeat(50), empty: "" })
      assert.isTrue(Exit.isFailure(yield* Effect.exit(handle.insert({ tag: "a\u0000b", empty: "" }))))
    }))

  it.effect("stored-value: the longest number is 25 characters of JSON, and a collection sized for it stores it", () =>
    Effect.gen(function*() {
      const longest = -0.0000010000000000000002
      assert.strictEqual(JSON.stringify({ n: longest }).length, 31)
      const sized = defineCollection({ name: "sized", scope: "household", maxChars: 31, schema: Schema.Struct({ n: Schema.Finite }) })
      const small = defineCollection({ name: "small", scope: "household", maxChars: 30, schema: Schema.Struct({ n: Schema.Finite }) })
      const m = defineModule({ apiVersion: 2, id: "nums", name: "Nums", description: "Numbers.", enabledByDefault: false, storage: { collections: [sized, small] }, start: () => Effect.succeed({}) })
      assert.deepStrictEqual(rules(yield* moduleProblems(m)), ["stored-value collection small"])
      const household = yield* makeTestHousehold([m])
      yield* household.store.forModule("nums").collection(sized).insert({ n: longest })
      assert.isTrue(Exit.isFailure(yield* Effect.exit(household.store.forModule("nums").collection(small).insert({ n: longest }))))
    }))

  it("the worst value counts JSON's escapes: 6 a character for a plain string, 2 for StoredText", () => {
    const plain = worstJsonChars({ schema: { type: "object", properties: { t: { type: "string", maxLength: 10 } } } })
    assert.deepStrictEqual(plain, { chars: 2 + 4 + 62 })
    const stored = worstJsonChars({ schema: { type: "object", properties: { t: { type: "string", maxLength: 10, pattern: STORED_TEXT_PATTERN_SOURCE } } } })
    assert.deepStrictEqual(stored, { chars: 2 + 4 + 22 })
    // Optional fields count as present; a list counts its maximum; a number its longest text; literals their longest.
    const c = defineCollection({
      name: "c",
      scope: "household",
      schema: Schema.Struct({ a: Schema.optionalKey(Schema.Finite), b: Schema.Array(Schema.Boolean).check(Schema.isMaxLength(3)), c: Schema.Literals(["x", "long"]) })
    })
    const worst = collectionWorst(c)
    assert.deepStrictEqual(worst, { chars: JSON.stringify({ a: -0.0000010000000000000002, b: [false, false, false], c: "long" }).length })
  })

  it.effect("scheduler-shared, and scheduler-refused: what the real engine refused while it started, in the engine's words", () =>
    Effect.gen(function*() {
      const jobs = defineModule({
        apiVersion: 2,
        id: "jobs",
        name: "Jobs",
        description: "Jobs that break the rules.",
        enabledByDefault: false,
        shared: (ctx) =>
          Effect.gen(function*() {
            yield* ctx.scheduler.handle("tick", { payload: Schema.Struct({ n: Schema.Finite }), run: () => Effect.void }).pipe(Effect.orDie)
            // Each refusal caught, as a careless module might: the engine refused it, so the check reports it.
            yield* ctx.scheduler.schedule({ handler: "tick", key: "monthly", payload: { n: 1 }, cron: "0 7 1 * *" }).pipe(Effect.ignore)
            yield* ctx.scheduler.schedule({ handler: "tick", key: "zoned", payload: { n: 1 }, cron: "0 4 * * *", timeZone: "Not/AZone" }).pipe(Effect.ignore)
            yield* ctx.scheduler.schedule({ handler: "tick", key: "bare", inMs: 1000 }).pipe(Effect.ignore)
            return { value: undefined }
          }),
        start: (ctx) => Effect.as(ctx.scheduler.handle("in_instance", { payload: Schema.Struct({}), run: () => Effect.void }).pipe(Effect.orDie), {})
      })
      const problems = yield* moduleProblems(jobs)
      assert.deepStrictEqual(rules(problems), ["scheduler-refused a schedule", "scheduler-refused a schedule", "scheduler-refused a schedule", "scheduler-shared handler in_instance"])
      const said = problems.filter((p) => p.rule === "scheduler-refused").map((p) => p.message)
      assert.match(said[0]!, /^refused \(invalid\): .*day of month and month must be \*/)
      assert.match(said[1]!, /^refused \(invalid\): .*Not\/AZone/)
      assert.match(said[2]!, /^refused \(invalid\): the payload does not fit the handler "tick"/)
    }))

  it.effect("scheduler-refused: another module's refusals are not this module's, and an asynchronous payload decoder is no problem", () =>
    Effect.gen(function*() {
      const other = defineModule({
        apiVersion: 2,
        id: "other",
        name: "Other",
        description: "Has a refusal of its own.",
        enabledByDefault: false,
        shared: (ctx) => Effect.as(Effect.ignore(ctx.scheduler.schedule({ handler: "nothing", inMs: 1_000 })), { value: undefined }),
        start: () => Effect.succeed({})
      })
      const slow = Schema.Struct({}).pipe(Schema.decodeTo(Schema.Struct({}), {
        decode: SchemaGetter.transformEffect((x) => Effect.as(Effect.sleep(1), x)),
        encode: SchemaGetter.transform((x) => x)
      }))
      const mine = defineModule({
        apiVersion: 2,
        id: "mine",
        name: "Mine",
        description: "Has its tick.",
        enabledByDefault: false,
        shared: (ctx) =>
          Effect.gen(function*() {
            yield* ctx.scheduler.handle("tick", { payload: slow, run: () => Effect.void }).pipe(Effect.orDie)
            yield* ctx.scheduler.schedule({ handler: "tick", inMs: 1_000 }).pipe(Effect.orDie)
            return { value: undefined }
          }),
        start: () => Effect.succeed({})
      })
      assert.deepStrictEqual(rules(yield* moduleProblems(mine, { others: [other] })), [])
    }))

  it.effect("an unprogrammed stub call its start catches fails the check", () =>
    Effect.gen(function*() {
      interface Greeter {
        readonly greet: (name: string) => string
      }
      const Greeters = ServiceKey<Greeter>("greeter")
      const greeter = stubService<Greeter>("greeter")
      const eager = defineModule({
        apiVersion: 2,
        id: "eager",
        name: "Eager",
        description: "Greets as it starts.",
        enabledByDefault: false,
        start: (ctx) =>
          Effect.sync(() => {
            try {
              ctx.host.service(Greeters)?.greet("x")
            } catch {
              // Swallowed: the kit still fails the test.
            }
            return {}
          })
      })
      const exit = yield* Effect.exit(checkModule(eager, { provide: [provide("greeter", { services: [Greeters.of(greeter.service)] })] }))
      assert.include(String(Exit.isFailure(exit) ? exit.cause : "passed"), "without a programmed answer")
    }))

  it.effect("secret: a secret's value in a tool description, and one shown on the admin page", () =>
    Effect.gen(function*() {
      const leaky = defineModule({
        apiVersion: 2,
        id: "leaky",
        name: "Leaky",
        description: "Leaks its key.",
        enabledByDefault: false,
        settings: { key: Setting.secret({ label: "Key" }) },
        start: (ctx) =>
          Effect.sync(() => {
            ctx.setStatus({ tone: "ok", text: `Signed in with ${ctx.settings.key}` })
            return { tools: [makeTool({ name: "leak", description: `Uses ${ctx.settings.key}.`, parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("") })] }
          })
      })
      assert.deepStrictEqual(rules(yield* moduleProblems(leaky)).sort(), ["secret status line, error, form or Health issue", "secret tool leak"])
    }))

  it.effect("health: required with the network; a health check that fails", () =>
    Effect.gen(function*() {
      const net = defineModule({ apiVersion: 2, id: "net", name: "Net", description: "Online.", enabledByDefault: false, requires: [{ network: "internet" }], start: () => Effect.succeed({}) })
      assert.deepStrictEqual(rules(yield* moduleProblems(net)), ["health definition"])
      const failing = defineModule({
        apiVersion: 2,
        id: "sick",
        name: "Sick",
        description: "Its health check throws.",
        enabledByDefault: false,
        health: () => Effect.die(new Error("boom")),
        start: () => Effect.succeed({})
      })
      assert.deepStrictEqual(rules(yield* moduleProblems(failing)), ["health health()"])
      // One that never answers is a problem too, not a test that hangs.
      const silent = defineModule({ apiVersion: 2, id: "silent", name: "Silent", description: "Never answers.", enabledByDefault: false, health: () => Effect.never, start: () => Effect.succeed({}) })
      assert.deepStrictEqual(rules(yield* moduleProblems(silent)), ["health health()"])
      const stuck = defineModule({ apiVersion: 2, id: "stuck", name: "Stuck", description: "Never starts.", enabledByDefault: false, start: () => Effect.never })
      assert.deepStrictEqual(rules(yield* moduleProblems(stuck)), ["start start"])
    }))

  it.effect("texts: both languages, same keys and placeholders, one line each", () =>
    Effect.gen(function*() {
      const texts = { en: { a: "Hello {name}.", b: "Only English.", c: "", d: "{name}, hello {name}.", e: "Two\u2028lines." }, nl: { a: "Hallo {naam}.", c: "Leeg.", d: "Hallo {name}.", e: "Twee regels." } }
      // "d" uses the same name a different number of times: `say` fills each, so it keeps the rule. "e" holds a line
      // separator, which the core's one-line rule refuses.
      assert.deepStrictEqual(rules(yield* moduleProblems(ok, { texts })), ['texts text "a"', 'texts text "b"', 'texts text "c"', 'texts text "e"'])
    }))

  it.effect("the failure names every rule and place", () =>
    Effect.gen(function*() {
      const v1 = defineModule({ id: "old", name: "Old", description: "A version 1 module.", start: () => Effect.succeed({}) })
      const error = yield* Effect.flip(checkModule(v1))
      assert.match(error.message, /Module old breaks 2 rules/)
      assert.match(error.message, /\[api-version\] definition: /)
      assert.match(error.message, /\[off-by-default\] definition: /)
    }))
})
