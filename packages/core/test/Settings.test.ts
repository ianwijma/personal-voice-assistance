import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema, Scope } from "effect"
import { defineModule, fromAssistantModule, ModuleStartError } from "../src/ModuleDefinition.ts"
import { makeTool } from "../src/Module.ts"
import { applySettingsPatch, resolveSettings, Setting, type SettingsOf, type SettingsSources } from "../src/Settings.ts"

const spec = {
  place: Setting.text({ label: "Home location", default: "", env: "WEATHER_DEFAULT_PLACE" }),
  units: Setting.choice({
    label: "Units",
    options: [{ value: "celsius", label: "Celsius" }, { value: "fahrenheit", label: "Fahrenheit" }],
    default: "celsius",
    env: "WEATHER_UNITS"
  }),
  timeoutMs: Setting.number({ label: "Timeout", default: 3000, integer: true, min: 500, max: 10_000, unit: "ms", advanced: true }),
  verbose: Setting.boolean({ label: "Verbose", default: false }),
  domains: Setting.multichoice({
    label: "Domains",
    options: [{ value: "light", label: "Lights" }, { value: "sensor", label: "Sensors" }, { value: "lock", label: "Locks" }],
    default: ["light"]
  }),
  token: Setting.secret({ label: "Token", env: "HA_TOKEN", required: true })
}

// Compile-time check of the inferred settings type.
type Settings = SettingsOf<typeof spec>
const typed: Settings = { place: "x", units: "fahrenheit", timeoutMs: 1, verbose: true, domains: ["lock"], token: undefined }
void typed

const sources = (over: Partial<SettingsSources> = {}): SettingsSources => ({ stored: {}, secrets: {}, env: {}, ...over })

describe("resolveSettings", () => {
  it("uses defaults and describes every field for the UI", () => {
    const { form, value } = resolveSettings(spec, sources({ secrets: { token: "t" } }))
    assert.deepStrictEqual(value, { place: "", units: "celsius", timeoutMs: 3000, verbose: false, domains: ["light"], token: "t" })
    assert.deepStrictEqual(form.fields.map((f) => [f.key, f.type]), [
      ["place", "text"],
      ["units", "choice"],
      ["timeoutMs", "number"],
      ["verbose", "boolean"],
      ["domains", "multichoice"],
      ["token", "secret"]
    ])
    assert.deepStrictEqual(form.secrets, { token: { set: true, source: "store" } })
    assert.strictEqual("token" in form.values, false, "secret values never reach the form")
    assert.deepStrictEqual(form.errors, [])
  })

  it("prefers the environment over saved values and locks the field", () => {
    const { form, value } = resolveSettings(spec, sources({
      stored: { place: "Paris", units: "celsius" },
      secrets: { token: "saved" },
      env: { WEATHER_UNITS: "fahrenheit", HA_TOKEN: "from-env", WEATHER_DEFAULT_PLACE: "" }
    }))
    assert.strictEqual(value?.units, "fahrenheit")
    assert.strictEqual(value?.place, "Paris", "an empty environment variable does not count")
    assert.strictEqual(value?.token, "from-env")
    assert.deepStrictEqual(form.fields.find((f) => f.key === "units")?.locked, { reason: "Set by WEATHER_UNITS in the environment" })
    assert.strictEqual(form.fields.find((f) => f.key === "place")?.locked, undefined)
    assert.deepStrictEqual(form.secrets.token, { set: true, source: "env" })
  })

  it("reports invalid saved values, invalid environment values and missing required secrets", () => {
    const { form, value } = resolveSettings(spec, sources({ stored: { timeoutMs: 50 }, env: { WEATHER_UNITS: "kelvin" } }))
    assert.strictEqual(value, undefined)
    assert.deepStrictEqual(form.errors.map((e) => e.key), ["units", "timeoutMs", "token"])
    assert.strictEqual(form.values.timeoutMs, 3000, "the form shows the default next to the error")
  })

  it("parses environment text for every kind", () => {
    const { value } = resolveSettings(
      {
        n: Setting.number({ label: "n", default: 1, env: "N" }),
        b: Setting.boolean({ label: "b", default: false, env: "B" }),
        m: Setting.multichoice({ label: "m", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: [], env: "M" })
      },
      sources({ env: { N: "42", B: "yes", M: "b, a" } })
    )
    assert.deepStrictEqual(value, { n: 42, b: true, m: ["a", "b"] })
  })
})

describe("applySettingsPatch", () => {
  it("applies changes and resets with null", () => {
    const result = applySettingsPatch(spec, sources({ stored: { place: "Paris", verbose: true } }), {
      values: { place: "Rome", verbose: null, domains: ["sensor", "light", "sensor"] },
      secrets: { token: "abc" }
    })
    assert.deepStrictEqual(result, { ok: true, stored: { place: "Rome", domains: ["light", "sensor"] }, secrets: { token: "abc" } })
  })

  it("is all or nothing, and names every bad field", () => {
    const result = applySettingsPatch(spec, sources({ env: { WEATHER_UNITS: "celsius" } }), {
      values: { place: 3, units: "fahrenheit", nope: "x", token: "x" },
      secrets: { place: "x", token: "" }
    })
    assert.strictEqual(result.ok, false)
    if (result.ok) return
    assert.deepStrictEqual(result.errors.map((e) => e.key), ["place", "units", null, "token", "place", "token"])
  })

  it("drops saved keys the spec no longer has", () => {
    const result = applySettingsPatch(spec, sources({ stored: { old: 1, place: "x" }, secrets: { oldKey: "s" } }), {
      values: {},
      secrets: {}
    })
    assert.deepStrictEqual(result, { ok: true, stored: { place: "x" }, secrets: {} })
  })
})

describe("defineModule", () => {
  it.effect("starts a module in a scope with typed settings", () =>
    Effect.gen(function*() {
      let closed = false
      const statuses: Array<string | undefined> = []
      const echo = defineModule({
        id: "echo",
        name: "Echo",
        description: "Repeats.",
        settings: { prefix: Setting.text({ label: "Prefix", default: ">" }) },
        start: ({ settings, setStatus }) =>
          Effect.gen(function*() {
            yield* Effect.addFinalizer(() => Effect.sync(() => (closed = true)))
            setStatus({ text: `prefix ${settings.prefix}`, tone: "ok" })
            return {
              tools: [makeTool({
                name: "echo",
                description: "Echo",
                parameters: Schema.Struct({ text: Schema.String }),
                execute: ({ text }) => Effect.succeed(`${settings.prefix}${text}`)
              })]
            }
          })
      })
      assert.strictEqual(echo.enabledByDefault, true)
      const resolved = resolveSettings(echo.settings, sources({ stored: { prefix: "#" } }))
      assert.isDefined(resolved.value)
      const scope = yield* Scope.make()
      const instance = yield* echo.start({ settings: resolved.value!, setStatus: (s) => statuses.push(s?.text) }).pipe(
        Scope.provide(scope)
      )
      const result = yield* instance.tools![0]!.execute({ text: "hi" })
      assert.strictEqual(result, "#hi")
      assert.deepStrictEqual(statuses, ["prefix #"])
      yield* Scope.close(scope, Exit.void)
      assert.isTrue(closed)
    }))

  it.effect("reports start failures as ModuleStartError", () =>
    Effect.gen(function*() {
      const broken = defineModule({
        id: "broken",
        name: "Broken",
        description: "Never starts.",
        start: () => Effect.fail(new ModuleStartError({ message: "Token rejected (HTTP 401)" }))
      })
      const exit = yield* Effect.exit(Effect.scoped(broken.start({ settings: {}, setStatus: () => {} })))
      assert.isTrue(Exit.isFailure(exit))
    }))

  it("rejects ids that cannot be persistence keys", () => {
    assert.throws(() => defineModule({ id: "Home Assistant", name: "x", description: "x", start: () => Effect.succeed({}) }))
  })

  it.effect("wraps a legacy AssistantModule", () =>
    Effect.gen(function*() {
      const legacy = fromAssistantModule({ id: "legacy", name: "Legacy", description: "Old shape." }, {
        name: "legacy",
        context: [{ name: "Fact", get: Effect.succeed("fact") }]
      })
      const instance = yield* Effect.scoped(legacy.start({ settings: {}, setStatus: () => {} }))
      assert.strictEqual(instance.context?.length, 1)
      assert.strictEqual(instance.tools, undefined)
    }))
})
