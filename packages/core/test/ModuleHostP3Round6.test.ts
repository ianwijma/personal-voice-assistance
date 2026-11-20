// Review round 6 of PR 90 (core): the health check holds its secrets until its fiber has ended (6A-1); shutdown
// withdraws and signals everything before it waits for any cleanup (6A-3); the 48 KiB limit measures the form as it
// is sent (6A-4); the 8 KiB budget counts the whole array (6A-5); the generated Test quotes whole characters (6A-6);
// and one module's projection always fits one frame, what does not fit the snapshot following it (6A-2).
import { assert, describe, it } from "@effect/vitest"
import { type AdminSnapshot, decodeServerMessage, encodeServerMessage, MAX_TEXT_FRAME_BYTES, type ModuleInfo, type SettingsForm } from "@pva/protocol"
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { exampleAdminSnapshot, exampleWeatherModule } from "../../protocol/src/examples.ts"
import type { Agent } from "../src/Agent.ts"
import { makeTool } from "../src/Module.ts"
import { defineAgent } from "../src/ModuleContributions.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { ADMIN_MODULES_SHARE_BYTES, adminModules, MODULE_FRAME_MAX_BYTES, withinModuleFrame } from "../src/ModuleFrames.ts"
import { makeModuleHost, MODULE_FORM_BUDGET_BYTES, MODULE_FORM_MAX_BYTES, readOnlyPersistence, testAgent } from "../src/ModuleHost.ts"
import type { ModuleRoute } from "../src/ModuleRoutes.ts"
import { resolveSettings, Setting } from "../src/Settings.ts"

const utf8 = new TextEncoder()
const jsonBytes = (value: unknown) => utf8.encode(JSON.stringify(value)).length
const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))
const decodes = (text: string) => {
  const decoded = decodeServerMessage(text)
  assert.strictEqual(decoded._tag, "Ok", decoded._tag === "Invalid" ? decoded.reason : "")
}
const roundTrip = (info: ModuleInfo) => {
  const text = encodeServerMessage({ type: "module.changed", module: info })
  decodes(text)
  return text
}
/** The hub's send: the snapshot (within `ADMIN_MODULES_SHARE_BYTES`), then a frame for each light entry; `page` is what a page has after them. */
const adminSend = (modules: ReadonlyArray<ModuleInfo>) => {
  const { modules: sent, follow } = adminModules(modules.map(withinModuleFrame))
  const snapshot: AdminSnapshot = { ...exampleAdminSnapshot, modules: sent }
  const text = encodeServerMessage({ type: "admin.snapshot", snapshot })
  assert.isAtMost(text.length, MAX_TEXT_FRAME_BYTES)
  decodes(text)
  const page = new Map(sent.map((m) => [m.id, m]))
  for (const m of follow) {
    const frame = roundTrip(m)
    assert.isAtMost(utf8.encode(frame).length, MODULE_FRAME_MAX_BYTES)
    page.set(m.id, (JSON.parse(frame) as { module: ModuleInfo }).module)
  }
  return { sent, follow, page }
}
const items = <A = string>(n: number, f: (i: number) => A): Array<A> => Array.from({ length: n }, (_, i) => f(i))
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

describe("a health check holds its secrets until its fiber has ended (6A-1)", () => {
  const OLD = "old-key-AAAA-1111"
  const NEW = "new-key-BBBB-2222"
  /** Sol's module: disabled, a secret, a definition-level Test that shows the last diagnostic the check cached. */
  const diagnostics = () => {
    const cache = { current: "nothing yet" }
    const mod = defineModule({
      id: "diag",
      name: "Diag",
      description: "Caches a diagnostic",
      settings: { key: Setting.secret({ label: "Key" }), test: Setting.action({ label: "Test", buttonLabel: "Test" }) },
      fieldActions: { test: () => Effect.sync(() => ({ ok: true, text: cache.current })) },
      // Never finishes; when interrupted, caches a diagnostic with the key it was given, then takes two seconds to
      // close its client (ordinary finite cleanup).
      health: ({ settings }) =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.andThen(Effect.sync(() => void (cache.current = `last diagnostic with ${settings?.key}`)), Effect.sleep(2_000)))),
      start: () => Effect.succeed({})
    })
    return { cache, mod }
  }
  const hostWith = (mod: ReturnType<typeof diagnostics>["mod"]) =>
    makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence({ modules: {}, secrets: { diag: { key: OLD } } }), env: {}, healthTimeoutMs: 100 })
  const pressed = (result: { readonly ok: boolean }) => (result as { readonly result?: { readonly text: string } }).result?.text ?? ""

  it.effect("a check left at its time limit with two seconds of cleanup, the key rotated meanwhile, Test pressed during the cleanup: the old key is still replaced; the answer did not wait", () =>
    Effect.gen(function*() {
      const { mod } = diagnostics()
      const host = yield* hostWith(mod)
      const check = yield* Effect.forkChild(host.checkHealth)
      yield* advance(150)
      // The answer is there at the time limit, while the check still cleans up.
      assert.isDefined(check.pollUnsafe(), "the health answer does not wait for the cleanup")
      assert.isTrue(host.issues.all().some((i) => i.id === "diag.health" && /did not finish/.test(i.title)))
      assert.isTrue((yield* host.configure("diag", { values: {}, secrets: { key: NEW } })).ok)
      yield* advance(500)
      const text = pressed(yield* host.fieldAction("diag", "test"))
      assert.include(text, "last diagnostic with")
      assert.notInclude(text, OLD)
      assert.include(text, "[secret]")
      // Once its fiber has ended, the old key is no longer looked for.
      yield* advance(2_000)
      assert.strictEqual(host.pageText("diag", OLD, 100), OLD)
    }))

  it.effect("a check whose caller is interrupted while it runs: held until its fiber has ended", () =>
    Effect.gen(function*() {
      const { mod } = diagnostics()
      const host = yield* hostWith(mod)
      const check = yield* Effect.forkChild(host.checkHealth)
      yield* advance(10)
      yield* Fiber.interrupt(check)
      assert.isTrue((yield* host.configure("diag", { values: {}, secrets: { key: NEW } })).ok)
      yield* advance(500)
      const text = pressed(yield* host.fieldAction("diag", "test"))
      assert.include(text, "last diagnostic with")
      assert.notInclude(text, OLD)
      yield* advance(2_000)
      assert.strictEqual(host.pageText("diag", OLD, 100), OLD)
    }))

  it.effect("a check interrupted before or as its fiber is admitted holds nothing afterwards", () =>
    Effect.gen(function*() {
      const { mod } = diagnostics()
      const host = yield* hostWith(mod)
      // Interrupted before it ran at all, and right after it started (as its fiber is forked).
      const before = yield* Effect.forkChild(host.checkHealth)
      yield* Fiber.interrupt(before)
      const admitted = yield* Effect.forkChild(host.checkHealth, { startImmediately: true })
      yield* Fiber.interrupt(admitted)
      assert.isTrue((yield* host.configure("diag", { values: {}, secrets: { key: NEW } })).ok)
      yield* advance(2_500)
      assert.strictEqual(host.pageText("diag", OLD, 100), OLD)
    }))
})

describe("shutdown signals everything before it waits for any cleanup (6A-3)", () => {
  it.effect("a definition-level press with two seconds of cleanup beside a live module's instance press and route handler: both are answered at once, and nothing new is admitted meanwhile", () =>
    Effect.gen(function*() {
      const cleaned: Array<string> = []
      const slow = defineModule({
        id: "slow",
        name: "Slow",
        description: "A definition press with slow cleanup",
        settings: { go: Setting.action({ label: "Go", buttonLabel: "Go" }) },
        fieldActions: { go: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.andThen(Effect.sleep(2_000), Effect.sync(() => void cleaned.push("slow"))))) },
        start: () => Effect.succeed({})
      })
      const live = defineModule({
        apiVersion: 2,
        id: "live",
        name: "Live",
        description: "An instance press, a route and a tool",
        settings: { press: Setting.action({ label: "Press", buttonLabel: "Press" }) },
        shared: () =>
          Effect.succeed({
            value: undefined,
            routes: [{ method: "GET", path: "hook", public: true, handler: () => Effect.as(Effect.never, { status: 200 }) }] satisfies ReadonlyArray<ModuleRoute>
          }),
        start: () =>
          Effect.succeed({
            fieldActions: { press: () => Effect.as(Effect.never, { ok: true, text: "never" }) },
            tools: [makeTool({ name: "live_tool", description: "A tool", parameters: Schema.Struct({}), execute: () => Effect.succeed("ok") })]
          })
      })
      const scope = yield* Scope.make()
      const host = yield* makeModuleHost({
        catalog: [slow, live],
        persistence: readOnlyPersistence({ modules: { live: { enabled: true } }, secrets: {} }),
        env: {},
        graceMs: 5_000,
        stopTimeoutMs: 10_000,
        closeTimeoutMs: 10_000
      }).pipe(Scope.provide(scope))
      yield* host.startEnabled
      assert.strictEqual(host.routes().length, 1)
      assert.isTrue(host.snapshot().registry.specs.some((t) => t.name === "live_tool"))
      const definition = yield* Effect.forkChild(host.fieldAction("slow", "go"))
      const instance = yield* Effect.forkChild(host.fieldAction("live", "press"))
      // As the app's router runs a handler: in the shared part's scope, answered at the first of its result and
      // `stopped` (a handler the host interrupts is a shutdown answer too).
      const route = host.routes()[0]!
      const handler = yield* Effect.forkIn(Effect.suspend(() => route.route.handler({} as never)), route.scope)
      const answer = yield* Effect.forkChild(Effect.raceFirst(
        Effect.map(Fiber.await(handler), (exit) => (Exit.isSuccess(exit) ? "answered" as const : "stopped" as const)),
        Effect.as(route.stopped, "stopped" as const)
      ))
      yield* advance(10)
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
      yield* advance(100)
      // The definition press is still cleaning up (and the host waits for it), yet the others have their shutdown answer.
      assert.deepStrictEqual(cleaned, [])
      assert.isUndefined(closing.pollUnsafe())
      assert.deepStrictEqual(instance.pollUnsafe() === undefined ? "still waiting" : yield* Fiber.join(instance), { ok: false, code: "not_running", message: "Live is not running" })
      assert.strictEqual(answer.pollUnsafe() === undefined ? "still waiting" : yield* Fiber.join(answer), "stopped")
      // Nothing is admitted meanwhile: no route, no tool, no press.
      assert.deepStrictEqual(host.routes(), [])
      assert.isFalse(host.snapshot().registry.specs.some((t) => t.name === "live_tool"))
      assert.deepStrictEqual(yield* host.fieldAction("live", "press"), { ok: false, code: "not_running", message: "The assistant is stopping" })
      yield* advance(2_500)
      yield* Fiber.join(closing)
      assert.deepStrictEqual(cleaned, ["slow"])
      assert.isDefined(definition.pollUnsafe())
    }))
})

describe("the 48 KiB limit measures the form as it is sent (6A-4)", () => {
  it.effect("Sol's agent: two text lists whose values fit only without the generated Test button: the save is refused, naming the largest field", () =>
    Effect.gen(function*() {
      const agent = defineAgent({
        id: "talker",
        name: "Talker",
        description: "Talks",
        kind: "model",
        settings: {
          first: Setting.textList({ label: "First", maxItems: 80, itemMaxLength: 400 }),
          second: Setting.textList({ label: "Second", maxItems: 80, itemMaxLength: 400 })
        },
        start: () => Effect.succeed({ turn: () => Stream.make({ _tag: "TextDelta" as const, text: "hi" }) })
      })
      const values = { first: items(80, (i) => `${i}-${"a".repeat(397)}`), second: items(45, (i) => `${i}-${"b".repeat(359)}`) }
      // Without the generated Test the values' form is within the limit (the old check let it through).
      const form = resolveSettings(agent.settings, { stored: values, secrets: {}, env: {} }).form
      assert.strictEqual(form.errors.length, 0)
      assert.isAtMost(jsonBytes(form), MODULE_FORM_MAX_BYTES)
      const host = yield* makeModuleHost({ catalog: [agent], persistence: readOnlyPersistence(), env: {} })
      const result = yield* host.configure("talker", { values, secrets: {} })
      assert.isFalse(result.ok)
      const fieldErrors = (result.ok ? [] : (result.error as { readonly fieldErrors?: ReadonlyArray<{ readonly key: string | null; readonly message: string }> }).fieldErrors) ?? []
      assert.strictEqual(fieldErrors[0]?.key, "first")
      assert.match(fieldErrors[0]!.message, /^Too large to save: .*The largest is "First"; make it smaller\.$/)
      // The form the page has stays within the limit.
      const info = host.modules()[0]!
      assert.isAtMost(jsonBytes(info.settings), MODULE_FORM_MAX_BYTES)
      roundTrip(info)
    }))

  it.effect("Sol's saved form whose errors expand past the limit once the boundary replaces a secret: sent within the limit, the messages cut and the values whole", () =>
    Effect.gen(function*() {
      const settings: Record<string, ReturnType<typeof Setting.text> | ReturnType<typeof Setting.textList> | ReturnType<typeof Setting.secret>> = {
        payload: Setting.textList({ label: "Payload", maxItems: 80, itemMaxLength: 400 }),
        key: Setting.secret({ label: "Key" })
      }
      for (let i = 0; i < 12; i++) settings[`t${i}`] = Setting.text({ label: `Text ${i}`, default: "", check: (v) => (v === "bad" ? "x-".repeat(200) : undefined) })
      const mod = defineModule({ id: "expands", name: "Expands", description: "", settings, start: () => Effect.succeed({}) })
      const payload = items(80, (i) => `${i}-${"p".repeat(397)}`)
      const stored: Record<string, unknown> = { payload, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i}`, "bad"])) }
      // As saved, the form is well within the limit (it was admitted).
      const raw = resolveSettings(mod.settings, { stored, secrets: { key: "x" }, env: {} }).form
      assert.isBelow(jsonBytes(raw), MODULE_FORM_MAX_BYTES - 8 * 1024)
      const host = yield* makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence({ modules: { expands: { settings: stored } }, secrets: { expands: { key: "x" } } }), env: {} })
      const info = host.modules()[0]!
      assert.isAtMost(jsonBytes(info.settings), MODULE_FORM_MAX_BYTES)
      // The values are whole; the errors are there, matched first and then cut.
      assert.deepStrictEqual(info.settings.values["payload"], payload)
      assert.strictEqual(info.settings.fields.length, 14)
      const errors = info.settings.errors.filter((e) => e.key?.startsWith("t") === true)
      assert.strictEqual(errors.length, 12)
      for (const e of errors) {
        assert.include(e.message, "[secret]")
        assert.notInclude(e.message, "x-")
        assert.isBelow(e.message.length, 2_000)
      }
      roundTrip(info)
    }))
})

describe("the 8 KiB budget counts the whole described array (6A-5)", () => {
  const declared = (second: number) =>
    defineModule({
      id: "described",
      name: "Described",
      description: "",
      settings: { one: Setting.text({ label: "One", description: "a".repeat(3900) }), two: Setting.text({ label: "Two", description: "b".repeat(second) }) },
      start: () => Effect.succeed({})
    })
  const fieldsBytes = (mod: ReturnType<typeof declared>) => jsonBytes(resolveSettings(mod.settings, { stored: {}, secrets: {}, env: {} }).form.fields)

  it.effect("8,193 bytes is refused, 8,192 is not", () =>
    Effect.gen(function*() {
      const over = declared(4048)
      const exact = declared(4047)
      assert.strictEqual(fieldsBytes(over), MODULE_FORM_BUDGET_BYTES + 1)
      assert.strictEqual(fieldsBytes(exact), MODULE_FORM_BUDGET_BYTES)
      const refused = yield* makeModuleHost({ catalog: [over], persistence: readOnlyPersistence(), env: {} })
      assert.isTrue(refused.issues.all().some((i) => i.id === "described.form" && /larger than the 8192 bytes .* from the field "two" on/.test(i.detail)))
      assert.deepStrictEqual(refused.modules()[0]!.settings.fields, [])
      const accepted = yield* makeModuleHost({ catalog: [exact], persistence: readOnlyPersistence(), env: {} })
      assert.isFalse(accepted.issues.all().some((i) => i.id === "described.form"))
      assert.strictEqual(accepted.modules()[0]!.settings.fields.length, 2)
    }))
})

describe("the generated agent Test quotes whole characters (6A-6)", () => {
  it.effect("an answer of seventy emoji is quoted short without half a character", () =>
    Effect.gen(function*() {
      const agent = { id: "emoji", turn: () => Stream.make({ _tag: "TextDelta" as const, text: "🙂".repeat(70) }) } as unknown as Agent
      const result = yield* testAgent(agent)
      assert.isTrue(result.ok)
      assert.include(result.text, `'${"🙂".repeat(58)}...'`)
      assert.notMatch(result.text, loneSurrogate)
    }))
})

describe("one module's projection always fits one frame; what does not fit the snapshot follows it (6A-2)", () => {
  /** Sol's route: index `i`, a 194-character path and a 500-character description. */
  const solRoute = (i: number): ModuleRoute => ({
    method: "GET",
    path: `r${String(i).padStart(2, "0")}-${"p".repeat(60)}/${"q".repeat(64)}/${"r".repeat(64)}`,
    description: "d".repeat(500),
    guards: ["admin"],
    handler: () => Effect.succeed({ status: 200 })
  })

  it.effect("Sol's forty modules with 32 long routes each: the snapshot and every frame after it decode, and the page ends with every module's routes", () =>
    Effect.gen(function*() {
      const catalog = Array.from({ length: 40 }, (_, m) =>
        defineModule({
          apiVersion: 2,
          id: `web${m}`,
          name: `Web ${m}`,
          description: "Routes",
          shared: () => Effect.succeed({ value: undefined, routes: Array.from({ length: 32 }, (_, i) => solRoute(i)) }),
          start: () => Effect.succeed({})
        }))
      const host = yield* makeModuleHost({ catalog, persistence: readOnlyPersistence({ modules: Object.fromEntries(catalog.map((d) => [d.id, { enabled: true }])), secrets: {} }), env: {} })
      yield* host.startEnabled
      const infos = host.modules()
      for (const info of infos) assert.strictEqual(info.routes?.length, 32, info.error)
      // Together far more than one frame (Sol: 1,122,553 characters).
      assert.isAbove(jsonBytes(infos), MAX_TEXT_FRAME_BYTES)
      const { sent, follow, page } = adminSend(infos)
      assert.isAbove(follow.length, 0)
      assert.isAtMost(jsonBytes(sent), ADMIN_MODULES_SHARE_BYTES)
      for (const info of infos) assert.deepStrictEqual(page.get(info.id)?.routes, info.routes)
    }))

  it("a single module at every per-kind maximum at once: shortened in order (routes, tools, instance texts) to one frame that decodes; its form kept", () => {
    const esc = (n: number) => "\u0001".repeat(n)
    const fields: SettingsForm["fields"] = [{ type: "textList", key: "list", label: "List", apply: "live", default: [], maxItems: 200, itemMaxLength: 500, source: "saved" }]
    const settings: SettingsForm = { fields, values: { list: items(120, (i) => `${i} `.padEnd(395, "x")) }, secrets: {}, errors: [] }
    assert.isAbove(jsonBytes(settings), MODULE_FORM_MAX_BYTES - 2 * 1024)
    const tool = (i: number) => ({ ...exampleWeatherModule.tools[0]!, name: `tool_${i}`, description: esc(300) })
    const route = (i: number) => ({
      method: "GET" as const,
      path: `/api/modules/max/${String(i).padStart(2, "0")}${"p".repeat(280)}`,
      guards: ["admin" as const],
      public: false,
      bodyLimitBytes: 0,
      ratePerMinute: { perAddress: 60, total: 600 },
      description: esc(500)
    })
    const template = (t: number) => ({
      id: `max.t${t}`,
      name: "T",
      prompt: esc(1_800),
      purpose: esc(80),
      handles: esc(240),
      modules: ["max"],
      suggestedPhrases: items(8, () => esc(60))
    })
    const templates = items(8, (t) => template(t))
    assert.isAtMost(jsonBytes(templates), 128 * 1024)
    const max: ModuleInfo = {
      ...exampleWeatherModule,
      id: "max",
      name: "Max",
      error: esc(2_000),
      settings,
      tools: items(100, tool),
      routes: items(32, route),
      templates,
      instances: items(16, (i) => ({ assistants: [`assistant-${i}`], own: [], state: "error" as const, error: esc(2_000) }))
    }
    roundTrip(max)
    assert.isAbove(utf8.encode(encodeServerMessage({ type: "module.changed", module: max })).length, 2 * MODULE_FRAME_MAX_BYTES)
    const fitted = withinModuleFrame(max)
    const frame = roundTrip(fitted)
    assert.isAtMost(utf8.encode(frame).length, MODULE_FRAME_MAX_BYTES)
    assert.isUndefined(fitted.routes)
    assert.strictEqual(fitted.tools.length + (fitted.toolsLeft ?? 0), 100)
    assert.isBelow(fitted.tools.length, 100)
    for (const i of fitted.instances ?? []) assert.isAtMost(i.error!.length, 200)
    assert.deepStrictEqual(fitted.settings, settings)
    assert.deepStrictEqual(fitted.templates, templates)
    // In a snapshot too: the page ends with what that frame carries.
    const { page } = adminSend([max, exampleWeatherModule])
    assert.deepStrictEqual(page.get("max"), JSON.parse(frame).module)
  })

  it("beyond the per-kind bounds (sixty-four instances), the form goes last, replaced by the error naming its largest field", () => {
    const esc = (n: number) => "\u0001".repeat(n)
    const settings: SettingsForm = {
      fields: [{ type: "textList", key: "list", label: "List", apply: "live", default: [], maxItems: 200, itemMaxLength: 500, source: "saved" }],
      values: { list: items(120, (i) => `${i} `.padEnd(395, "x")) },
      secrets: {},
      errors: []
    }
    const many: ModuleInfo = {
      ...exampleWeatherModule,
      id: "many",
      name: "Many",
      settings,
      tools: [],
      instances: items(64, (i) => ({ assistants: [`assistant-${i}-${esc(400)}`], own: [], state: "error" as const, error: esc(2_000) }))
    }
    const fitted = withinModuleFrame(many)
    assert.isAtMost(utf8.encode(roundTrip(fitted)).length, MODULE_FRAME_MAX_BYTES)
    assert.deepStrictEqual(fitted.settings.fields, [])
    assert.match(fitted.settings.errors[0]!.message, /^Many's settings are not shown: .*The largest field is "List": reduce it in the settings file\.$/)
  })
})
