import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema, Scope } from "effect"
import { defineModule, fromAssistantModule, ModuleStartError } from "../src/ModuleDefinition.ts"
import { makeTool } from "../src/Module.ts"
import {
  applicableOwnValues,
  applySettingsPatch,
  checkOwnValues,
  isVisible,
  overridableKeys,
  resolveSettings,
  runSettingsChecks,
  Setting,
  type SettingsOf,
  type SettingsSources
} from "../src/Settings.ts"

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

describe("visibleWhen", () => {
  const provider = {
    PROVIDER: Setting.choice({ label: "Provider", options: [{ value: "local", label: "Local" }, { value: "hosted", label: "Hosted" }], default: "local" }),
    KEY: Setting.secret({ label: "Key", required: true, visibleWhen: { key: "PROVIDER", in: ["hosted"] } }),
    MODEL: Setting.number({ label: "Model size", default: 2, min: 1, max: 4, visibleWhen: { key: "PROVIDER", in: ["local"] } })
  }

  it("is part of the field description", () => {
    const { form } = resolveSettings(provider, sources())
    assert.deepStrictEqual(form.fields.find((f) => f.key === "KEY")?.visibleWhen, { key: "PROVIDER", in: ["hosted"] })
    assert.strictEqual(form.fields.find((f) => f.key === "PROVIDER")?.visibleWhen, undefined)
  })

  it("a hidden field is not validated: its saved problems and a missing required secret are not reported", () => {
    const local = resolveSettings(provider, sources({ stored: { PROVIDER: "local" } }))
    assert.deepStrictEqual(local.form.errors, [], "the key is hidden while the provider is local")
    assert.notStrictEqual(local.value, undefined)
    const hosted = resolveSettings(provider, sources({ stored: { PROVIDER: "hosted", MODEL: 99 } }))
    assert.deepStrictEqual(hosted.form.errors.map((e) => e.key), ["KEY"], "the bad model size is hidden; the key is not")
    assert.strictEqual(hosted.form.values.MODEL, 2, "an invalid hidden value shows as its default")
  })

  it("can depend on a field of another section (context)", () => {
    const page = { DETAIL: Setting.text({ label: "Detail", default: "", check: (v) => (v === "bad" ? "Bad" : undefined), visibleWhen: { key: "OTHER", in: [true] } }) }
    assert.strictEqual(resolveSettings(page, sources({ stored: { DETAIL: "bad" }, context: () => false })).form.errors.length, 0)
    assert.strictEqual(resolveSettings(page, sources({ stored: { DETAIL: "bad" }, context: () => true })).form.errors.length, 1)
    assert.strictEqual(isVisible(page.DETAIL, {}, undefined), false, "an unknown key never matches")
  })

  it("a patch judges visibility on the values after the patch, and ignores hidden fields", () => {
    // Choosing hosted in the same patch shows the key, so the key is validated and saved.
    const shown = applySettingsPatch(provider, sources(), { values: { PROVIDER: "hosted" }, secrets: { KEY: "k" } })
    assert.deepStrictEqual(shown, { ok: true, stored: { PROVIDER: "hosted" }, secrets: { KEY: "k" } })
    // A value for a hidden field is neither validated nor saved; the saved value stays.
    const hidden = applySettingsPatch(provider, sources({ stored: { PROVIDER: "hosted", MODEL: 3 } }), { values: { MODEL: 99 }, secrets: {} })
    assert.deepStrictEqual(hidden, { ok: true, stored: { PROVIDER: "hosted", MODEL: 3 }, secrets: {} })
  })
})

describe("field source", () => {
  it("says where each value comes from: default, saved, .env or the process environment", () => {
    const { form } = resolveSettings(spec, sources({
      stored: { place: "Paris" },
      secrets: { token: "t" },
      env: { WEATHER_UNITS: "fahrenheit" },
      envOrigin: (name) => (name === "WEATHER_UNITS" ? "env-file" : "env-process")
    }))
    const source = Object.fromEntries(form.fields.map((f) => [f.key, f.source]))
    assert.deepStrictEqual(source, { place: "saved", units: "env-file", timeoutMs: "default", verbose: "default", domains: "default", token: "saved" })
    assert.deepStrictEqual(form.fields.find((f) => f.key === "units")?.locked, { reason: "Set by WEATHER_UNITS in .env" })
    const processEnv = resolveSettings(spec, sources({ env: { HA_TOKEN: "x" } })).form.fields.find((f) => f.key === "token")
    assert.strictEqual(processEnv?.source, "env-process")
  })

  it("a lock from a .env file names the file and the line (for Move to settings)", () => {
    const { form } = resolveSettings(spec, sources({
      env: { WEATHER_UNITS: "fahrenheit", HA_TOKEN: "x" },
      envOrigin: () => "env-file",
      envLocation: (name) => (name === "WEATHER_UNITS" ? { file: "/home/me/.env", line: 4 } : undefined)
    }))
    assert.deepStrictEqual(form.fields.find((f) => f.key === "units")?.locked, {
      reason: "Set by WEATHER_UNITS in /home/me/.env, line 4",
      file: "/home/me/.env",
      line: 4
    })
    assert.deepStrictEqual(form.fields.find((f) => f.key === "token")?.locked, { reason: "Set by HA_TOKEN in .env" })
  })

  it("applySettingsPatch with includeHidden saves a field whose visibleWhen does not hold", () => {
    const hidden = { mode: Setting.choice({ label: "Mode", default: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }), extra: Setting.text({ label: "Extra", default: "", visibleWhen: { key: "mode", in: ["b"] } }) }
    const base = { stored: {}, secrets: {}, env: {} }
    const skipped = applySettingsPatch(hidden, base, { values: { extra: "x" }, secrets: {} })
    assert.deepStrictEqual(skipped, { ok: true, stored: {}, secrets: {} })
    const saved = applySettingsPatch(hidden, base, { values: { extra: "x" }, secrets: {} }, { includeHidden: true })
    assert.deepStrictEqual(saved, { ok: true, stored: { extra: "x" }, secrets: {} })
  })
})

describe("runSettingsChecks", () => {
  const values: Record<string, unknown> = { EAGER: 300, FINAL: 200, PROVIDER: "hosted" }
  const view = { value: (key: string) => values[key], secretSet: (key: string) => key === "SET" }
  it("splits errors from warnings; warnings never become errors", () => {
    const result = runSettingsChecks([
      (v) => (Number(v.value("FINAL")) <= Number(v.value("EAGER")) ? [{ level: "error", key: "FINAL", message: "Must be longer" }] : []),
      (v) => (v.value("PROVIDER") === "hosted" && !v.secretSet("KEY") ? [{ level: "warning", key: "PROVIDER", message: "No key" }] : []),
      () => {
        throw new Error("a broken check is skipped")
      }
    ], view)
    assert.deepStrictEqual(result, { errors: [{ key: "FINAL", message: "Must be longer" }], warnings: [{ key: "PROVIDER", message: "No key" }] })
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

describe("own values and linked defaults (docs/ASSISTANTS.md §2.6)", () => {
  const spec = {
    units: Setting.choice({ label: "Units", env: "UNITS", options: [{ value: "c", label: "C" }, { value: "f", label: "F" }], default: "c", overridable: true }),
    place: Setting.text({ label: "Place", overridable: true }),
    url: Setting.text({ label: "Address", default: "http://x" }),
    key: Setting.secret({ label: "Key" })
  }
  const base: SettingsSources = { stored: {}, secrets: {}, env: {} }

  it("per field: own (overridable only) > environment > saved > linked default > default", () => {
    const resolved = resolveSettings(spec, { ...base, stored: { place: "Saved" }, env: { UNITS: "c" }, defaults: { place: "Home", url: "http://home" }, own: { units: "f", url: "http://mine", key: "x" } })
    assert.deepStrictEqual(resolved.value, { units: "f", place: "Saved", url: "http://home", key: undefined })
    assert.deepStrictEqual(resolveSettings(spec, { ...base, defaults: { place: "Home" } }).value?.place, "Home")
    // A linked default the field refuses is ignored; the form shows the linked default as the field's default.
    assert.deepStrictEqual(resolveSettings(spec, { ...base, defaults: { units: "kelvin" } }).value?.units, "c")
    const field = resolveSettings(spec, { ...base, defaults: { place: "Home" } }).form.fields.find((f) => f.key === "place")!
    assert.deepStrictEqual(["default" in field ? field.default : undefined, field.source], ["Home", "default"])
    // An own value the field refuses is an error of that resolution.
    assert.strictEqual(resolveSettings(spec, { ...base, own: { units: "kelvin" } }).value, undefined)
  })

  it("the flag reaches the field description, never on a secret; helpers", () => {
    const form = resolveSettings(spec, base).form
    assert.deepStrictEqual(form.fields.map((f) => [f.key, f.overridable]), [["units", true], ["place", true], ["url", undefined], ["key", undefined]])
    assert.deepStrictEqual(overridableKeys(spec), ["units", "place"])
    assert.deepStrictEqual(applicableOwnValues(spec, { units: "f", url: "u", key: "k", other: 1 }), { units: "f" })
    assert.deepStrictEqual(checkOwnValues(spec, { units: "f", place: "x" }), [])
    assert.deepStrictEqual(checkOwnValues(spec, { url: "u", key: "k", units: 3 }).map((e) => e.key), ["url", "key", "units"])
  })

  it("a patch judges visibility against the linked defaults", () => {
    const shown = { ...spec, extra: Setting.text({ label: "Extra", visibleWhen: { key: "place", in: ["Home"] } }) }
    const patched = applySettingsPatch(shown, { ...base, defaults: { place: "Home" } }, { values: { extra: "yes" }, secrets: {} })
    assert.isTrue(patched.ok && patched.stored.extra === "yes")
  })
})
