// Review round 4 of PR 90 (P3 forms): a field's default goes through its own decoder, and a module's described form
// is checked once against the wire's schema and a size budget; what the running instance adds is trimmed to it.
import { assert, describe, it } from "@effect/vitest"
import { decodeServerMessage, encodeServerMessage, MAX_TEXT_FRAME_BYTES, ModuleInfo, type SettingField } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { exampleAdminSnapshot } from "../../protocol/src/examples.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, MODULE_FORM_BUDGET_BYTES, readOnlyPersistence } from "../src/ModuleHost.ts"
import { Setting } from "../src/Settings.ts"

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const roundTrip = (info: ModuleInfo) => {
  const text = encodeServerMessage({ type: "module.changed", module: info })
  const decoded = decodeServerMessage(text)
  assert.strictEqual(decoded._tag, "Ok", decoded._tag === "Invalid" ? decoded.reason : "")
  return text
}

describe("a field's default goes through its own decoder (4a-9)", () => {
  it("a default the field refuses is a declaration error; the decoded default is kept in defaultValue and the description", () => {
    assert.throws(
      () => Setting.combo({ label: "Room", default: "outside", allowCustom: false, options: [{ value: "inside", label: "Inside" }] }),
      /A combo's default: must be a value the field accepts \(Must be one of: inside\)/
    )
    assert.throws(() => Setting.combo({ label: "Model", default: "  " }), /A combo's default/)
    const trimmed = Setting.combo({ label: "Model", default: " haiku " })
    assert.strictEqual(trimmed.defaultValue, "haiku")
    assert.strictEqual((trimmed.describe("m") as { readonly default: string }).default, "haiku")
    const list = Setting.textList({ label: "Names", default: [" A ", "a"] })
    assert.deepStrictEqual(list.defaultValue, ["A"])
    assert.deepStrictEqual((list.describe("n") as { readonly default: ReadonlyArray<string> }).default, ["A"])
    // 800 empty strings decode to an empty list: that is the default kept, not the raw 800 (over the wire's 200).
    const empties = Setting.textList({ label: "Names", default: Array.from({ length: 800 }, () => "") })
    assert.deepStrictEqual(empties.defaultValue, [])
    assert.deepStrictEqual((empties.describe("n") as { readonly default: ReadonlyArray<string> }).default, [])
    const rooms = Setting.records({
      label: "Rooms",
      itemLabel: "room",
      titleKey: "name",
      item: { name: Setting.text({ label: "Name", default: "" }), aliases: Setting.textList({ label: "Aliases" }) },
      default: [{ name: "Kitchen", aliases: [" cook ", "Cook"] }]
    })
    assert.deepStrictEqual(rooms.defaultValue, [{ name: "Kitchen", aliases: ["cook"] }])
    assert.deepStrictEqual((rooms.describe("r") as { readonly default: unknown }).default, [{ name: "Kitchen", aliases: ["cook"] }])
  })

  it.effect("start-up, shared resolution and reset to default all see the decoded default; the form encodes", () =>
    Effect.gen(function*() {
      const seen: { shared: Array<unknown>; start: Array<unknown> } = { shared: [], start: [] }
      const mod = defineModule({
        apiVersion: 2,
        id: "names",
        name: "Names",
        description: "Lists names",
        settings: {
          names: Setting.textList({ label: "Names", default: [" A ", "a"] }),
          blank: Setting.textList({ label: "Blank", default: Array.from({ length: 800 }, () => "") })
        },
        shared: ({ settings }) => Effect.sync(() => void seen.shared.push(settings.names)).pipe(Effect.as({ value: undefined })),
        start: ({ settings }) => Effect.sync(() => void seen.start.push([settings.names, settings.blank])).pipe(Effect.as({}))
      })
      const host = yield* makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence({ modules: { names: { enabled: true } }, secrets: {} }), env: {} })
      yield* host.startEnabled
      assert.deepStrictEqual(seen.shared, [["A"]])
      assert.deepStrictEqual(seen.start, [[["A"], []]])
      assert.isTrue((yield* host.configure("names", { values: { names: ["B"] }, secrets: {} })).ok)
      assert.isTrue((yield* host.configure("names", { values: { names: null }, secrets: {} })).ok)
      assert.deepStrictEqual(seen.start.map((s) => (s as Array<unknown>)[0]), [["A"], ["B"], ["A"]])
      const info = host.modules()[0]!
      assert.deepStrictEqual(info.settings.values.names, ["A"])
      assert.deepStrictEqual(info.settings.values.blank, [])
      assert.deepStrictEqual(info.settings.fields.map((f) => (f as { readonly default?: unknown }).default), [["A"], []])
      roundTrip(info)
    }))
})

describe("a module's form is checked once against the wire and a budget (4a-8, 4a-10)", () => {
  it("the constructors' option limits are the wire's (at most six tags)", () => {
    const tags = ["local", "hosted", "needs-key", "not-downloaded", "slow-start", "experimental"] as const
    Setting.combo({ label: "Ok", default: "a", options: [{ value: "a", label: "A", tags: [...tags] }] })
    assert.throws(() => Setting.combo({ label: "Bad", default: "a", options: [{ value: "a", label: "A", tags: [...tags, "local"] }] }), /at most 6 tags/)
  })

  it.effect("an item field the wire refuses (a 201-character placeholder in a record, with an empty default): the module does not start, its error names the field, and its update still encodes", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "rooms",
        name: "Rooms",
        description: "Records",
        settings: {
          rooms: Setting.records({
            label: "Rooms",
            itemLabel: "room",
            titleKey: "name",
            item: { name: Setting.text({ label: "Name", default: "okay", placeholder: "x".repeat(201) }) }
          })
        },
        start: () => Effect.succeed({})
      })
      const host = yield* makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence({ modules: { rooms: { enabled: true } }, secrets: {} }), env: {} })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "error")
      assert.match(info.error ?? "", /^Its settings field "rooms" cannot be sent to the admin page: .*placeholder/)
      assert.deepStrictEqual(info.settings.fields, [])
      assert.isTrue(host.issues.all().some((i) => i.id === "rooms.form" && i.severity === "error"))
      roundTrip(info)
    }))

  it.effect("many individually valid fields over the budget (40 combos of 60 long options): the module does not start, naming the field where it went over", () =>
    Effect.gen(function*() {
      const settings: Record<string, ReturnType<typeof Setting.combo>> = {}
      for (let i = 0; i < 40; i++) {
        settings[`c${i}`] = Setting.combo({
          label: `Combo ${i}`,
          default: "o0",
          options: Array.from({ length: 60 }, (_, j) => ({ value: `o${j}`, label: "l".repeat(200), description: "d".repeat(300) }))
        })
      }
      const mod = defineModule({ id: "huge", name: "Huge", description: "Too much", settings, start: () => Effect.succeed({}) })
      const host = yield* makeModuleHost({ catalog: [mod], persistence: readOnlyPersistence({ modules: { huge: { enabled: true } }, secrets: {} }), env: {} })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "error")
      assert.strictEqual(info.error, `Its settings form is larger than the ${MODULE_FORM_BUDGET_BYTES} bytes a module's form may take, from the field "c0" on. Fix the module.`)
      const text = roundTrip(info)
      assert.isBelow(text.length, 4_096)
    }))

  it.effect("40 modules at their budget, with the instance adding 200 suggestions and a long info value each, fit one admin snapshot with room to spare", () =>
    Effect.gen(function*() {
      const catalog = Array.from({ length: 40 }, (_, m) => {
        const settings: Record<string, ReturnType<typeof Setting.text> | ReturnType<typeof Setting.combo> | ReturnType<typeof Setting.info>> = {}
        // Individually valid static fields that take most of the budget.
        for (let i = 0; i < 6; i++) settings[`t${i}`] = Setting.text({ label: `Text ${i}`, description: "x".repeat(900), default: "" })
        settings.model = Setting.combo({ label: "Model", default: "a", options: [{ value: "a", label: "A" }] })
        settings.state = Setting.info({ label: "State" })
        return defineModule({
          id: `m${m}`,
          name: `Module ${m}`,
          description: "At its budget",
          settings,
          start: () =>
            Effect.succeed({
              info: () => ({ state: "s".repeat(1000) }),
              settingOptions: () => ({ model: Array.from({ length: 200 }, (_, j) => ({ value: `model-${j}`, label: `${"L".repeat(150)} ${j}` })) })
            })
        })
      })
      const host = yield* makeModuleHost({
        catalog,
        persistence: readOnlyPersistence({ modules: Object.fromEntries(catalog.map((d) => [d.id, { enabled: true }])), secrets: {} }),
        env: {}
      })
      yield* host.startEnabled
      const infos = host.modules()
      for (const info of infos) {
        assert.strictEqual(info.state, "running")
        const fields = info.settings.fields
        const model = fields.find((f) => f.key === "model") as Extract<SettingField, { readonly type: "combo" }>
        // Trimmed to the budget, and it says so.
        assert.isBelow(model.options.length, 201)
        assert.match(model.optionsNote ?? "", /^\d+ suggestions from Module \d+ and \d+ more$/)
        assert.isAtMost(jsonBytes(fields) + jsonBytes(info.settings.values.state), MODULE_FORM_BUDGET_BYTES)
        assert.isTrue(Schema.is(ModuleInfo)(info))
        roundTrip(info)
      }
      const snapshot = encodeServerMessage({ type: "admin.snapshot", snapshot: { ...exampleAdminSnapshot, modules: infos } })
      assert.isBelow(snapshot.length, MAX_TEXT_FRAME_BYTES / 2)
      assert.strictEqual(decodeServerMessage(snapshot)._tag, "Ok")
    }))
})
