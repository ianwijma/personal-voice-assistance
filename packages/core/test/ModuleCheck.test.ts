// checkModule (docs/MODULES.md, "Testing: checkModule"): every rule fails on a module that breaks it, naming the rule
// and the place, and stays quiet on one that keeps it. The reference module that keeps them all is in
// packages/module-contracts/test/kit.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { defineAction } from "../src/Actions.ts"
import { defineCollection } from "../src/HouseholdStore.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { Setting } from "../src/Settings.ts"
import { checkModule, collectionWorst, type ModuleProblem, moduleProblems, STORED_TEXT_PATTERN_SOURCE, worstJsonChars } from "../src/testing.ts"

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
              makeTool({ name: "bad name!", description: "", parameters: Schema.String, risk: "change", execute: () => Effect.succeed("ok") }),
              makeTool({ name: "params", description: "Odd parameter.", parameters: Schema.Struct({ "a b": Schema.String }), risk: "change", execute: () => Effect.succeed("ok") })
            ],
            actions: [
              defineAction({ id: "silent", label: "Silent", description: "No examples.", params: {}, risk: "change", run: () => Effect.void })
            ]
          })
      })
      assert.deepStrictEqual(rules(yield* moduleProblems(tools)).sort(), [
        "action-examples action silent",
        "risk tool writes",
        "risk-said tool opens_door",
        "tool-description tool bad name!",
        "tool-name tool bad name!",
        "tool-parameters tool bad name!",
        "tool-parameters tool params"
      ].sort())
      const long = defineModule({
        apiVersion: 2,
        id: "a-module-with-a-rather-long-identifier",
        name: "Long",
        description: "Long names.",
        enabledByDefault: false,
        start: () => Effect.succeed({ actions: [defineAction({ id: "an_action_with_a_long_id_too", label: "L", description: "d", examples: ["x"], params: {}, speculative: true, run: () => Effect.void })] })
      })
      assert.deepStrictEqual(rules(yield* moduleProblems(long)), ["tool-name action an_action_with_a_long_id_too"])
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
    assert.deepStrictEqual(worst, { chars: JSON.stringify({ a: -1.7976931348623157e308, b: [false, false, false], c: "long" }).length })
    // The real worst value fits exactly.
    const value = { a: -1.7976931348623157e308, b: [false, false, false], c: "long" }
    assert.isAtMost(JSON.stringify(value).length, "chars" in worst ? worst.chars : 0)
  })

  it.effect("scheduler-shared, cron and job-payload", () =>
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
            yield* ctx.scheduler.schedule({ handler: "tick", key: "monthly", cron: "0 7 1 * *" }).pipe(Effect.ignore)
            yield* ctx.scheduler.schedule({ handler: "tick", key: "bare", inMs: 1000 }).pipe(Effect.orDie)
            return { value: undefined }
          }),
        start: (ctx) => Effect.as(ctx.scheduler.handle("in_instance", { payload: Schema.Struct({}), run: () => Effect.void }).pipe(Effect.orDie), {})
      })
      assert.deepStrictEqual(rules(yield* moduleProblems(jobs)).sort(), ['cron cron "0 7 1 * *"', "job-payload job of tick", "scheduler-shared handler in_instance"].sort())
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
    }))

  it.effect("texts: both languages, same keys and placeholders, one line each", () =>
    Effect.gen(function*() {
      const texts = { en: { a: "Hello {name}.", b: "Only English.", c: "" }, nl: { a: "Hallo {naam}.", c: "Leeg." } }
      assert.deepStrictEqual(rules(yield* moduleProblems(ok, { texts })), ['texts text "a"', 'texts text "b"', 'texts text "c"'])
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
