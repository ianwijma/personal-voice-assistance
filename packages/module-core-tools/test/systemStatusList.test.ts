// The issues list of system-status, through the real host and the kit's Presenter: it shows what the answer said to the
// asking device and nothing more, and follows the answer.
import { assert, describe, it, vi } from "@effect/vitest"
import { Devices, type HostView, type ModuleContextV2 } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { cutFor } from "../src/screen.ts"
import { issuesList, systemStatusModule } from "../src/systemStatus.ts"

vi.setConfig({ testTimeout: 30_000 })

const SECRET_REASON = "token sk-live-4242 refused by 192.168.1.77 for robin@example.org"
const household = {
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: null },
    { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-robin" },
    { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public" as const, defaultPerson: null },
    { id: "office-speaker", name: "Office speaker", room: "Office", privacy: "shared" as const, defaultPerson: null, capabilities: { v: 1 as const, speaker: { media: ["speech" as const] } } }
  ]
}
const nl = { household: { ...household, home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }

/** The real module over a host whose view is a house in trouble while `state.trouble` is true (four modules, the vault, the engines). */
const state = { trouble: true }
const variable: typeof systemStatusModule = {
  ...systemStatusModule,
  start: (given) => {
    const ctx = given as unknown as ModuleContextV2<{}>
    return systemStatusModule.start({
      ...ctx,
      host: {
        ...ctx.host,
        view: (): HostView => ({
          ...ctx.host.view(),
          ...(state.trouble
            ? {
              vaultLocked: true,
              engine: { ready: false, state: "failed", voices: [] },
              modules: [
                { id: "weather", name: "Weather", kind: "capability", state: "error", unavailable: SECRET_REASON },
                { id: "lists", name: "Lists", kind: "capability", state: "unavailable", unavailable: SECRET_REASON },
                { id: "news", name: "News", kind: "capability", state: "error", unavailable: SECRET_REASON },
                { id: "music", name: "Music", kind: "capability", state: "error" }
              ]
            }
            : {})
        }),
        service: ((key: unknown) => ctx.host.service(key as never)) as typeof ctx.host.service
      }
    } as never)
  }
}
let turn = 0
const asking = (device: string) => ({ device, turnId: ++turn }) as never
const itemsOf = (shown: ReadonlyArray<{ readonly content: unknown }>) => (shown[0]?.content as { items: ReadonlyArray<{ text: string }> } | undefined)?.items.map((i) => i.text)

const SHARED_LINES = [
  "The key vault is locked.",
  "The speech engines are stopped with an error.",
  "Weather has stopped with an error.",
  "And 3 more."
]

describe("system-status: the issues list", () => {
  it.effect("a shared and a private device get the list the answer named; a public device and a device without a screen get none", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, { household })
      const answers: Record<string, string> = {}
      for (const device of ["kitchen-display", "robins-phone", "hall-screen", "office-speaker"]) {
        const r = yield* s.tool("system_status", {}, asking(device))
        answers[device] = JSON.stringify(r.value)
        yield* s.present.settle
      }
      for (const device of ["kitchen-display", "robins-phone"]) {
        const [list, ...more] = s.present.shown(device)
        assert.strictEqual(more.length, 0)
        assert.strictEqual(list?.lifetime, "transient")
        assert.deepStrictEqual(list?.content, { kind: "list", title: "Problems", style: "bullets", items: SHARED_LINES.map((text, i) => ({ id: i < 3 ? `p${i}` : "more", text, done: false })) } as never, device)
        // Only what the answer named: the same sentences, in the same order, and nothing of a device or a reason.
        const spoken = JSON.parse(answers[device]!).spoken as string
        for (const line of SHARED_LINES.filter((l) => l !== "The key vault is locked.")) assert.include(spoken, line)
        assert.include(spoken, "The key vault is locked")
        for (const word of [/sk-live/, /192\.168/, /robin@/, /refused/, /Kitchen|Hall screen|Robin/, /\d+ devices/]) assert.notMatch(JSON.stringify(list), word)
      }
      // A public device is told only whether things are fine: nothing is shown there, with the public screen a real candidate.
      assert.deepStrictEqual(s.present.shown("hall-screen"), [])
      assert.deepStrictEqual(JSON.parse(answers["hall-screen"]!), { spoken: "There is a problem. Check the settings page.", fine: false })
      // A device without a display changes nothing about the answer.
      assert.deepStrictEqual(s.present.shown("office-speaker"), [])
      assert.strictEqual(JSON.parse(answers["office-speaker"]!).spoken, JSON.parse(answers["kitchen-display"]!).spoken)
    }))

  it.effect("the typed action shows the same list, in Dutch with Dutch words", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, nl)
      const said = yield* s.action("status", {}, asking("kitchen-display"))
      yield* s.present.settle
      assert.strictEqual(said.ok, true)
      assert.deepStrictEqual(itemsOf(s.present.shown("kitchen-display")), [
        "De sleutelkluis is op slot.",
        "De spraakmotoren zijn gestopt met een fout.",
        "Weather is gestopt met een fout.",
        "En nog 3."
      ])
      assert.strictEqual((s.present.shown("kitchen-display")[0]?.content as { title: string }).title, "Problemen")
      // A public device: the action says one sentence and shows nothing.
      const hall = yield* s.action("status", {}, asking("hall-screen"))
      yield* s.present.settle
      assert.deepStrictEqual(hall, { ok: true, say: "Er is een probleem. Kijk op de instellingenpagina." })
      assert.deepStrictEqual(s.present.shown("hall-screen"), [])
    }))

  it.effect("the list follows the answer: a newer one replaces it, and an answer with no problem to show (fine, devices only) takes it down", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, { household })
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.tool("system_status", { about: "modules" }, asking("kitchen-display"))
      yield* s.present.settle
      assert.strictEqual(s.present.shown("kitchen-display").length, 1)
      // About the devices only, the answer names no problem: the list goes.
      yield* s.tool("system_status", { about: "devices" }, asking("kitchen-display"))
      yield* s.present.settle
      assert.deepStrictEqual(s.present.shown("kitchen-display"), [])
      // Back in trouble, then everything is fine: the list goes (also after an empty answer).
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.present.settle
      assert.strictEqual(s.present.shown("kitchen-display").length, 1)
      state.trouble = false
      const fine = yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.present.settle
      assert.strictEqual((fine.value as { fine: boolean }).fine, true)
      assert.deepStrictEqual(s.present.shown("kitchen-display"), [])
      // Another device's list is not touched by this device's answer.
      state.trouble = true
      yield* s.tool("system_status", {}, asking("robins-phone"))
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      state.trouble = false
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.present.settle
      assert.strictEqual(s.present.shown("robins-phone").length, 1)
      assert.deepStrictEqual(s.present.shown("kitchen-display"), [])
    }))

  it.effect("it ends by itself, and with the module (a restart forgets it)", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, { household })
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.present.settle
      yield* s.advance(31_000)
      assert.deepStrictEqual(s.present.shown("kitchen-display"), [])
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.present.settle
      assert.strictEqual(s.present.shown("kitchen-display").length, 1)
      yield* s.stop
      yield* s.advance(10_000)
      assert.deepStrictEqual(s.present.shown("kitchen-display"), [])
    }))

  it("the list is built from the view and the device's detail alone: a unit view of every case", () => {
    const view = (modules: ReadonlyArray<{ name: string; state: string }>) => ({ modules: modules.map((m, i) => ({ id: `m${i}`, kind: "capability", ...m })), devices: [], home: {} }) as unknown as HostView
    assert.isUndefined(issuesList(view([]), "en", "all", "shared"))
    assert.isUndefined(issuesList(view([{ name: "Weather", state: "error" }]), "en", "all", "none"))
    assert.isUndefined(issuesList(view([{ name: "Weather", state: "error" }]), "en", "devices", "private"))
    // The name of a module is cut for the screen at a code point, the list stays valid.
    const long = issuesList(view([{ name: `${"a".repeat(58)}😀${"b".repeat(40)}`, state: "error" }]), "en", "all", "shared")
    assert.strictEqual(long?.kind, "list")
    const items = (long as { items: ReadonlyArray<{ text: string }> }).items
    assert.isAtMost(items[0]!.text.length, 80)
    assert.match(items[0]!.text, /… has stopped with an error\.$/)
    assert.notMatch(items[0]!.text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    assert.isAtMost(long!.spoken.length, 300)
  })

  it("a text is cut at a code point inside its limit, never between the halves of an emoji", () => {
    for (let n = 3; n < 12; n++) {
      const text = `${"a".repeat(n - 2)}😀😀😀😀`
      const cut = cutFor(text, n)
      assert.isAtMost(cut.length, n)
      assert.notMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, `n=${n}`)
    }
    assert.strictEqual(cutFor("short", 10), "short")
  })

  it.effect("showing costs the answer almost nothing", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, { household })
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      const t0 = performance.now()
      for (let i = 0; i < 20; i++) yield* s.tool("system_status", {}, asking("kitchen-display"))
      const per = (performance.now() - t0) / 20
      assert.isTrue(per < bound(25), `${per.toFixed(2)} ms per answer with its list`)
    }))
})
