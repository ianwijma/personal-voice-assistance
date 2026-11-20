// Review round 5 of PR 90 (core): presses answered at the grace period whatever another instance's cleanup takes
// (5A-6), and the other host-side fixes of this round.
import { assert, describe, it } from "@effect/vitest"
import { type AdminSnapshot, decodeServerMessage, encodeServerMessage, type ModuleInfo } from "@pva/protocol"
import { Effect, Fiber, Schema } from "effect"
import { TestClock } from "effect/testing"
import { exampleAdminSnapshot } from "../../protocol/src/examples.ts"
import { makeTool } from "../src/Module.ts"
import { defineModule, type ModuleDefinition } from "../src/ModuleDefinition.ts"
import { ADMIN_MODULES_SHARE_BYTES, adminModules, withinModuleFrame } from "../src/ModuleFrames.ts"
import {
  MAX_LISTED_TOOL_DESCRIPTION,
  MAX_LISTED_TOOLS,
  type ModuleDemand,
  makeModuleHost,
  MODULE_FORM_MAX_BYTES,
  readOnlyPersistence
} from "../src/ModuleHost.ts"
import { resolveSettings, Setting } from "../src/Settings.ts"

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const roundTrip = (info: ModuleInfo) => {
  const text = encodeServerMessage({ type: "module.changed", module: info })
  const decoded = decodeServerMessage(text)
  assert.strictEqual(decoded._tag, "Ok", decoded._tag === "Invalid" ? decoded.reason : "")
  return text
}
/**
 * An admin snapshot of these modules as the hub assembles it (`adminModules` over `withinModuleFrame`), and the
 * `module.changed` frames that follow it, each encoded and decoded; `page` is what a page has after all of them.
 */
const snapshotRoundTrip = (modules: ReadonlyArray<ModuleInfo>) => {
  const { modules: sent, follow } = adminModules(modules.map(withinModuleFrame))
  const snapshot: AdminSnapshot = { ...exampleAdminSnapshot, modules: sent }
  const text = encodeServerMessage({ type: "admin.snapshot", snapshot })
  const decoded = decodeServerMessage(text)
  assert.strictEqual(decoded._tag, "Ok", decoded._tag === "Invalid" ? decoded.reason : "")
  const page = new Map(sent.map((m) => [m.id, m]))
  for (const m of follow) page.set(m.id, (JSON.parse(roundTrip(m)) as { module: ModuleInfo }).module)
  return { ...snapshot, follow, page }
}
const enabledAll = (catalog: ReadonlyArray<ModuleDefinition<any>>, settings: Record<string, Record<string, unknown>> = {}) =>
  readOnlyPersistence({ modules: Object.fromEntries(catalog.map((d) => [d.id, { enabled: true, ...(settings[d.id] !== undefined ? { settings: settings[d.id] } : {}) }])), secrets: {} })
/** `n` distinct items of `length` characters (the n-th starts with its number). */
const items = (n: number, length: number, tag = "") => Array.from({ length: n }, (_, i) => `${tag}${i} `.padEnd(length, "x"))

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

describe("press stop across instances (5A-6)", () => {
  it.effect("two instances, the first with a two-second finaliser: the second instance's press is answered not_running right after the grace period", () =>
    Effect.gen(function*() {
      const closes: Array<string> = []
      const presser = defineModule({
        id: "presser",
        name: "Presser",
        description: "Two instances",
        settings: {
          format: Setting.choice({ label: "Format", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "a", overridable: true }),
          place: Setting.text({ label: "Place", default: "here" }),
          go: Setting.action({ label: "Go", buttonLabel: "Go" })
        },
        start: ({ settings }) =>
          Effect.gen(function*() {
            // The own-value instance (first in the run) takes two seconds to clean up (its first run only, so the
            // test's own shutdown is quick).
            const slow = settings.format === "b" && !closes.includes("b")
            if (settings.format === "b") yield* Effect.addFinalizer(() => Effect.andThen(Effect.sleep(slow ? 2_000 : 0), Effect.sync(() => closes.push("b"))))
            else yield* Effect.addFinalizer(() => Effect.sync(() => closes.push("a")))
            return { fieldActions: { go: () => Effect.as(Effect.never, { ok: true, text: "never" }) } }
          })
      })
      const demand: Array<ModuleDemand> = [{ assistantId: "own", own: { format: "b" } }, { assistantId: "plain" }]
      const host = yield* makeModuleHost({
        catalog: [presser],
        persistence: readOnlyPersistence({ modules: { presser: { settings: {} } }, secrets: {} }),
        env: {},
        demand: () => new Map([["presser", demand]]),
        graceMs: 100,
        stopTimeoutMs: 5_000
      })
      yield* host.startEnabled
      assert.deepStrictEqual(host.modules()[0]!.instances?.map((i) => i.own), [["format"], []])
      // The button belongs to the main (no-own) instance, the second in the run.
      const press = yield* Effect.forkChild(host.fieldAction("presser", "go"))
      yield* advance(10)
      assert.isUndefined(press.pollUnsafe())
      // A shared setting changes: the module restarts.
      const saved = yield* Effect.forkChild(host.configure("presser", { values: { place: "there" }, secrets: {} }))
      yield* advance(50)
      assert.isUndefined(press.pollUnsafe(), "still in the grace period")
      yield* advance(60)
      assert.deepStrictEqual(press.pollUnsafe() === undefined ? "still waiting" : yield* Fiber.join(press), { ok: false, code: "not_running", message: "Presser is not running" })
      assert.deepStrictEqual(closes, [], "the first instance is still cleaning up")
      yield* advance(2_100)
      assert.deepStrictEqual(closes, ["b", "a"])
      assert.isTrue((yield* Fiber.join(saved)).ok)
    }))
})

describe("the complete form has a limit (5A-2)", () => {
  /** Sol's forty text lists: each list's JSON under its own limit, the descriptions far under theirs. */
  const fortyLists = () => {
    const settings: Record<string, ReturnType<typeof Setting.textList>> = {}
    for (let i = 0; i < 40; i++) settings[`l${i}`] = Setting.textList({ label: `List ${i}`, maxItems: 80, itemMaxLength: 400 })
    return defineModule({ id: "lists", name: "Lists", description: "Forty lists", settings, start: () => Effect.succeed({}) })
  }
  const fortyValues = () => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`l${i}`, items(80, i === 7 ? 399 : 396, `${i}-`)]))

  it.effect("forty full text lists: a save from the admin page is refused, naming the largest field", () =>
    Effect.gen(function*() {
      const mod = fortyLists()
      const host = yield* makeModuleHost({ catalog: [mod], persistence: enabledAll([mod]), env: {} })
      yield* host.startEnabled
      // Each list on its own is a value the field accepts.
      assert.strictEqual(resolveSettings(mod.settings, { stored: fortyValues(), secrets: {}, env: {} }).form.errors.length, 0)
      const result = yield* host.configure("lists", { values: fortyValues(), secrets: {} })
      assert.isFalse(result.ok)
      const error = result.ok ? undefined : result.error
      assert.strictEqual(error?.code, "invalid_settings")
      const fieldErrors = (error as { readonly fieldErrors?: ReadonlyArray<{ readonly key: string | null; readonly message: string }> }).fieldErrors ?? []
      assert.strictEqual(fieldErrors.length, 1)
      assert.strictEqual(fieldErrors[0]!.key, "l7")
      assert.match(fieldErrors[0]!.message, /^Too large to save: .* more than the 48 KiB .* The largest is "List 7"; make it smaller\.$/)
      // Nothing changed: it still runs with its saved (empty) settings, and its form still goes.
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "running")
      assert.strictEqual(info.settings.fields.length, 40)
      roundTrip(info)
    }))

  it.effect("the same values in the settings file: no form, a bounded error naming the largest field, the module down like any with invalid settings; module.changed and the snapshot encode and decode", () =>
    Effect.gen(function*() {
      const mod = fortyLists()
      const saved = fortyValues()
      const saves: Array<string> = []
      const persistence = { ...enabledAll([mod], { lists: saved }), save: (id: string) => Effect.sync(() => void saves.push(id)) }
      const host = yield* makeModuleHost({ catalog: [mod], persistence, env: {} })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "error")
      assert.deepStrictEqual(info.settings.fields, [])
      assert.deepStrictEqual(info.settings.values, {})
      assert.strictEqual(info.settings.errors.length, 1)
      assert.match(info.settings.errors[0]!.message, /^Lists's settings are too large for the admin page \(\d+ KiB; at most 48 KiB\)\. The largest is "List 7": reduce it in the settings file\.$/)
      assert.match(info.error ?? "", /^The settings are not valid: Lists's settings are too large/)
      assert.isBelow(roundTrip(info).length, 4_096)
      snapshotRoundTrip(host.modules())
      // The saved values are not cut or rewritten.
      assert.deepStrictEqual(saves, [])
    }))

  it.effect("forty modules each just under the limit: the snapshot decodes, the modules it has no room for are light entries whose complete projections follow, and no form is withheld", () =>
    Effect.gen(function*() {
      const catalog = Array.from({ length: 40 }, (_, m) =>
        defineModule({
          id: `m${m}`,
          name: `Module ${m}`,
          description: "Nearly full",
          settings: {
            a: Setting.textList({ label: "A", maxItems: 80, itemMaxLength: 400 }),
            b: Setting.textList({ label: "B", maxItems: 80, itemMaxLength: 400 })
          },
          start: () => Effect.succeed({})
        }))
      const saved = Object.fromEntries(catalog.map((d, m) => [d.id, { a: items(60, 390, "a"), b: items(60, 390 - ((m * 7) % 20), "b") }]))
      const host = yield* makeModuleHost({ catalog, persistence: enabledAll(catalog, saved), env: {} })
      yield* host.startEnabled
      const infos = host.modules()
      for (const info of infos) {
        assert.strictEqual(info.state, "running", info.error)
        assert.isAtMost(jsonBytes(info.settings), MODULE_FORM_MAX_BYTES)
        assert.isAbove(jsonBytes(info.settings), MODULE_FORM_MAX_BYTES - 4 * 1024, "just under the limit")
        roundTrip(info)
      }
      const sent = snapshotRoundTrip(infos)
      const light = sent.modules.filter((m) => m.details === "follow")
      assert.isAbove(light.length, 0)
      // A light entry: identity, switch and state only; its complete projection follows, in catalogue order.
      for (const m of light) {
        assert.deepStrictEqual([m.settings.fields, m.settings.values, m.tools], [[], {}, []])
        assert.strictEqual(m.state, "running")
      }
      assert.deepStrictEqual(sent.follow.map((m) => m.id), light.map((m) => m.id))
      assert.isAtMost(jsonBytes(sent.modules), ADMIN_MODULES_SHARE_BYTES)
      // Nothing is withheld: after the frames that follow, the page has every module's complete form.
      for (const info of infos) assert.deepStrictEqual(sent.page.get(info.id), info)
    }))
})

describe("the admin page's list of tools is bounded (5A-3)", () => {
  const toolModule = (n: number, descriptionLength: number) =>
    defineModule({
      id: "toolbox",
      name: "Toolbox",
      description: "Many tools",
      settings: {},
      start: () =>
        Effect.succeed({
          tools: Array.from({ length: n }, (_, i) =>
            makeTool({ name: `tool_${i}`, description: `${i} `.padEnd(descriptionLength, "d"), parameters: Schema.Struct({}), execute: () => Effect.succeed("ok") }))
        })
    })

  it.effect("seventeen tools with 65,536-character descriptions: module.changed and the snapshot round-trip; the model's catalogue is unchanged", () =>
    Effect.gen(function*() {
      const mod = toolModule(17, 65_536)
      const host = yield* makeModuleHost({ catalog: [mod], persistence: enabledAll([mod]), env: {} })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.state, "running")
      assert.strictEqual(info.tools.length, 17)
      for (const t of info.tools) assert.isAtMost(t.description.length, MAX_LISTED_TOOL_DESCRIPTION)
      assert.isUndefined(info.toolsLeft)
      roundTrip(info)
      snapshotRoundTrip(host.modules())
      // The model still sees the whole description.
      const described = host.snapshot().registry.specs.find((t) => t.name === "tool_3")
      assert.strictEqual(described?.description.length, 65_536)
    }))

  it.effect("more than a hundred tools: a hundred are listed, and the rest are counted", () =>
    Effect.gen(function*() {
      const mod = toolModule(150, 40)
      const host = yield* makeModuleHost({ catalog: [mod], persistence: enabledAll([mod]), env: {} })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.strictEqual(info.tools.length, MAX_LISTED_TOOLS)
      assert.strictEqual(info.toolsLeft, 50)
      roundTrip(info)
    }))

  it.effect("the listed tools count toward the module's limit: beside a nearly full form, fewer are listed", () =>
    Effect.gen(function*() {
      const mod = defineModule({
        id: "toolbox",
        name: "Toolbox",
        description: "Many tools",
        settings: { a: Setting.textList({ label: "A", maxItems: 80, itemMaxLength: 400 }), b: Setting.textList({ label: "B", maxItems: 80, itemMaxLength: 400 }) },
        start: () =>
          Effect.succeed({
            tools: Array.from({ length: 100 }, (_, i) => makeTool({ name: `tool_${i}`, description: "d".repeat(1_000), parameters: Schema.Struct({}), execute: () => Effect.succeed("ok") }))
          })
      })
      const host = yield* makeModuleHost({ catalog: [mod], persistence: enabledAll([mod], { toolbox: { a: items(60, 390, "a"), b: items(50, 390, "b") } }), env: {} })
      yield* host.startEnabled
      const info = host.modules()[0]!
      assert.isBelow(info.tools.length, 100)
      assert.strictEqual(info.tools.length + (info.toolsLeft ?? 0), 100)
      assert.isAtMost(jsonBytes(info.settings) + jsonBytes(info.tools), MODULE_FORM_MAX_BYTES)
    }))
})

describe("a module's settings code that throws is that field's error (5A-4)", () => {
  it.effect("a records check that throws for its saved value, beside a healthy module: the healthy one starts, the faulty one is down with its error, and the snapshot has a form for it", () =>
    Effect.gen(function*() {
      const faulty = defineModule({
        id: "faulty",
        name: "Faulty",
        description: "Its check throws",
        settings: {
          rooms: Setting.records({
            label: "Rooms",
            itemLabel: "room",
            titleKey: "name",
            item: { name: Setting.text({ label: "Name" }) },
            check: (list) => {
              if (list.length > 0) throw new Error("ordinary validation fault")
              return undefined
            }
          })
        },
        start: () => Effect.succeed({})
      })
      const healthy = defineModule({ id: "healthy", name: "Healthy", description: "Fine", settings: {}, start: () => Effect.succeed({}) })
      const host = yield* makeModuleHost({ catalog: [faulty, healthy], persistence: enabledAll([faulty, healthy], { faulty: { rooms: [{ name: "Kitchen" }] } }), env: {} })
      yield* host.startEnabled
      const infos = host.modules()
      const bad = infos.find((m) => m.id === "faulty")!
      assert.strictEqual(infos.find((m) => m.id === "healthy")!.state, "running")
      assert.strictEqual(bad.state, "error")
      assert.match(bad.error ?? "", /^The settings are not valid: .*Faulty: its settings could not be read \(.*ordinary validation fault\)/)
      // The form stays, with the error on the field, so the owner can repair it on the page.
      assert.deepStrictEqual(bad.settings.fields.map((f) => f.key), ["rooms"])
      assert.deepStrictEqual(bad.settings.errors.map((e) => e.key), ["rooms"])
      roundTrip(bad)
      snapshotRoundTrip(infos)
      // A save with another throwing value is a field error too, not an exception.
      const saved = yield* host.configure("faulty", { values: { rooms: [{ name: "Hall" }] }, secrets: {} })
      assert.isFalse(saved.ok)
      // A press's draft through the same seam.
      assert.isTrue((yield* host.configure("faulty", { values: { rooms: [] }, secrets: {} })).ok)
      assert.strictEqual(host.modules().find((m) => m.id === "faulty")!.state, "running")
    }))

  it.effect("a nested item decoder that throws, and an assistant's own value whose check throws, are field errors", () =>
    Effect.gen(function*() {
      const throwing = Setting.text({ label: "Name", check: (v) => {
        if (v === "boom") throw new Error("item fault")
        return undefined
      } })
      const mod = defineModule({
        id: "nested",
        name: "Nested",
        description: "Nested check",
        settings: {
          rooms: Setting.records({ label: "Rooms", itemLabel: "room", titleKey: "name", item: { name: throwing } }),
          tag: Setting.text({ label: "Tag", overridable: true, check: (v) => {
            if (v === "boom") throw new Error("own fault")
            return undefined
          } })
        },
        start: () => Effect.succeed({})
      })
      const other = defineModule({ id: "other", name: "Other", description: "Fine", settings: {}, start: () => Effect.succeed({}) })
      const host = yield* makeModuleHost({ catalog: [mod, other], persistence: enabledAll([mod, other], { nested: { rooms: [{ name: "boom" }] } }), env: {} })
      yield* host.startEnabled
      const info = host.modules().find((m) => m.id === "nested")!
      assert.strictEqual(info.state, "error")
      assert.deepStrictEqual(info.settings.errors.map((e) => e.key), ["rooms"])
      assert.strictEqual(host.modules().find((m) => m.id === "other")!.state, "running")
      const own = host.checkOwn("nested", { tag: "boom" })
      assert.deepStrictEqual(own.map((e) => e.key), ["tag"])
      assert.match(own[0]!.message, /own fault/)
    }))
})

describe("every module with a catalogue error gets the empty form (5A-5)", () => {
  it.effect("a cycle member whose form the wire refuses: the empty form, and its update encodes", () =>
    Effect.gen(function*() {
      const x = defineModule({
        apiVersion: 2,
        id: "x",
        name: "X",
        description: "",
        uses: ["y"],
        settings: {
          rooms: Setting.records({ label: "Rooms", itemLabel: "room", titleKey: "name", item: { name: Setting.text({ label: "Name", default: "okay", placeholder: "x".repeat(201) }) } })
        },
        start: () => Effect.succeed({})
      })
      const y = defineModule({ apiVersion: 2, id: "y", name: "Y", description: "", uses: ["x"], start: () => Effect.succeed({}) })
      const host = yield* makeModuleHost({ catalog: [x, y], persistence: enabledAll([x, y]), env: {} })
      const info = host.modules().find((m) => m.id === "x")!
      assert.strictEqual(info.state, "error")
      assert.match(info.error ?? "", /cycle/)
      assert.deepStrictEqual(info.settings, { fields: [], values: {}, secrets: {}, errors: [] })
      roundTrip(info)
      snapshotRoundTrip(host.modules())
    }))
})

describe("text is cut at whole characters (5A-7)", () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  it.effect("an info value of emoji trimmed to the room the form leaves, at every odd and even cut, keeps every character whole", () =>
    Effect.gen(function*() {
      let cut = 0
      // Descriptions of growing length leave less and less room, a byte at a time: odd and even cuts alike.
      for (let pad = 0; pad < 400; pad += 7) {
        const mod = defineModule({
          id: "emoji",
          name: "Emoji",
          description: "Info",
          settings: {
            ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`t${i}`, Setting.text({ label: `T${i}`, description: "x".repeat(900), default: "" })])),
            pad: Setting.text({ label: "Pad", description: "p".repeat(300 + pad), default: "" }),
            state: Setting.info({ label: "State" })
          },
          start: () => Effect.succeed({ info: () => ({ state: "🙂".repeat(450) }) })
        })
        const host = yield* makeModuleHost({ catalog: [mod], persistence: enabledAll([mod]), env: {} })
        yield* host.startEnabled
        const info = host.modules()[0]!
        if (info.state !== "running") continue
        const shown = String(info.settings.values.state)
        if (!/… \(and \d+ more characters\)$/.test(shown)) continue
        cut++
        assert.notMatch(shown, lone, `pad ${pad}`)
      }
      assert.isAtLeast(cut, 20, "enough cuts were tried")
    }))

  it.effect("an info value longer than the boundary's limit is cut at a whole character too", () =>
    Effect.gen(function*() {
      const mod = defineModule({ id: "emoji", name: "Emoji", description: "Info", settings: { state: Setting.info({ label: "State" }) }, start: () => Effect.succeed({ info: () => ({ state: "🙂".repeat(501) }) }) })
      const host = yield* makeModuleHost({ catalog: [mod], persistence: enabledAll([mod]), env: {} })
      yield* host.startEnabled
      const shown = String(host.modules()[0]!.settings.values.state)
      assert.isTrue(shown.endsWith("…"))
      assert.notMatch(shown, lone)
    }))
})
