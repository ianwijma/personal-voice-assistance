// The issues list of system-status, through the real host and the kit's Presenter: it shows what the answer said to the
// asking device and nothing more, and follows the answer.
import { assert, describe, it, vi } from "@effect/vitest"
import { type HostView, type ModuleContextV2 } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { cutFor } from "../src/screen.ts"
import { issuesList, systemStatusModule } from "../src/systemStatus.ts"

vi.setConfig({ testTimeout: 30_000 })

const SECRET_REASON = "token sk-live-4242 refused by 192.168.1.77 for robin@example.org"
const household = {
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: "p-sam" },
    { id: "porch-display", name: "Porch display", room: "Porch", privacy: "shared" as const, defaultPerson: null },
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
const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const SHARED_LINES = [
  "The key vault is locked.",
  "The speech engines are stopped with an error.",
  "Weather has stopped with an error.",
  "And 3 more."
]
const TITLE = "Problems as just answered"

describe("system-status: the issues list", () => {
  it.effect("a known asker on a shared or private device gets the list, as theirs; a public device, a device without a known person and a device without a screen get none", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, { household })
      const answers: Record<string, string> = {}
      for (const device of ["kitchen-display", "robins-phone", "hall-screen", "porch-display", "office-speaker"]) {
        const r = yield* s.tool("system_status", {}, asking(device))
        answers[device] = r.content
        yield* s.present.settle
      }
      for (const device of ["kitchen-display", "robins-phone"]) {
        const [list, ...more] = s.present.shown(device)
        assert.strictEqual(more.length, 0)
        assert.strictEqual(list?.lifetime, "transient")
        assert.deepStrictEqual(list?.content, { kind: "list", title: TITLE, style: "bullets", items: SHARED_LINES.map((text, i) => ({ id: i < 3 ? `p${i}` : "more", text, done: false })) } as never, device)
        assert.include(answers[device]!, "The key vault is locked, so modules")
        for (const word of [/sk-live/, /192\.168/, /robin@/, /refused/, /Kitchen|Hall screen|Robin/, /\d+ devices/]) assert.notMatch(JSON.stringify(list), word)
      }
      // The list is the asker's own: the Presenter decides it again for every device, at every moment.
      assert.deepStrictEqual(s.present.engine.live().map((p) => p.owner).sort(), ["p-robin", "p-sam"])
      // A shared device with nobody known is told the details but is shown no list (it could not be kept to them).
      assert.include(answers["porch-display"]!, "Weather has stopped with an error")
      assert.deepStrictEqual(s.present.shown("porch-display"), [])
      assert.notInclude(answers["porch-display"]!, "[Screen")
      // A public device is told only whether things are fine: nothing is shown there.
      assert.deepStrictEqual(s.present.shown("hall-screen"), [])
      assert.deepStrictEqual(JSON.parse(answers["hall-screen"]!), { spoken: "There is a problem. Check the settings page.", fine: false })
      // A device without a display: the same answer as a shared device, nothing shown.
      assert.deepStrictEqual(s.present.shown("office-speaker"), [])
    }))

  it.effect("a person's list is not in front of a device that is public: a public screen with a default person asks and is shown nothing, and a reconnect brings nothing back", () =>
    Effect.gen(function*() {
      state.trouble = true
      const lobby = { id: "lobby-screen", name: "Lobby screen", room: "Hall", privacy: "public" as const, defaultPerson: "p-sam" }
      const s = yield* startTestModule(variable, { household: { devices: [...household.devices, lobby] } })
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.tool("system_status", {}, asking("lobby-screen"))
      yield* s.present.settle
      assert.strictEqual(s.present.shown("kitchen-display").length, 1)
      assert.deepStrictEqual(s.present.shown("lobby-screen"), [])
      for (const device of ["kitchen-display", "lobby-screen"]) {
        yield* s.notify.disconnect(device)
        yield* s.notify.connect(device)
      }
      yield* s.present.settle
      assert.deepStrictEqual(s.present.shown("lobby-screen"), [])
      assert.isTrue(s.present.decisions.every((d) => d.deviceId !== "lobby-screen" || !d.decision.show))
    }))

  it.effect("the typed action returns the same list, in Dutch with Dutch words, and says what it said before", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, nl)
      const said = yield* s.action("status", {}, asking("kitchen-display"))
      yield* s.present.settle
      assert.strictEqual(said.ok, true)
      assert.strictEqual((said as { say: string }).say.startsWith("De sleutelkluis is op slot, dus modules die"), true)
      assert.deepStrictEqual(itemsOf(s.present.shown("kitchen-display")), ["De sleutelkluis is op slot.", "De spraakmotoren zijn gestopt met een fout.", "Weather is gestopt met een fout.", "En nog 3."])
      assert.strictEqual((s.present.shown("kitchen-display")[0]?.content as { title: string }).title, "Problemen zoals net gemeld")
      // A public device: the action says one sentence and shows nothing.
      const hall = yield* s.action("status", {}, asking("hall-screen"))
      yield* s.present.settle
      assert.deepStrictEqual(hall, { ok: true, say: "Er is een probleem. Kijk op de instellingenpagina." })
      assert.deepStrictEqual(s.present.shown("hall-screen"), [])
    }))

  it.effect("the list is a snapshot of the answer: a house that recovers, or an answer with nothing to show, does not change it; the next list replaces it and its lifetime ends it", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, { household })
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.present.settle
      const [first] = s.present.shown("kitchen-display")
      state.trouble = false
      const fine = yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.tool("system_status", { about: "devices" }, asking("kitchen-display"))
      yield* s.present.settle
      assert.notInclude(fine.content, "[Screen")
      // Nothing took it down, and nothing updated it: it is what was answered.
      const [still] = s.present.shown("kitchen-display")
      assert.deepStrictEqual(still, first)
      state.trouble = true
      yield* s.tool("system_status", { about: "modules" }, asking("kitchen-display"))
      yield* s.present.settle
      const now = s.present.shown("kitchen-display")
      assert.strictEqual(now.length, 1)
      assert.notStrictEqual(now[0]!.id, first!.id)
      yield* s.advance(31_000)
      assert.deepStrictEqual(s.present.shown("kitchen-display"), [])
    }))

  it.effect("the model's own calls all run: the same question twice in one turn answers twice, each with its list", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, { household })
      const sameTurn = { device: "kitchen-display", turnId: 9 } as never
      const a = yield* s.tool("system_status", {}, sameTurn)
      const b = yield* s.tool("system_status", {}, sameTurn)
      assert.strictEqual(a.content, b.content)
      assert.include(a.content, "[Screen: Showing on")
      assert.include(b.content, "[Screen: Showing on")
    }))

  it.effect("a stopped module's list is withdrawn with it", () =>
    Effect.gen(function*() {
      state.trouble = true
      const s = yield* startTestModule(variable, { household })
      yield* s.tool("system_status", {}, asking("kitchen-display"))
      yield* s.present.settle
      assert.strictEqual(s.present.shown("kitchen-display").length, 1)
      yield* s.stop
      yield* s.advance(10_000)
      assert.deepStrictEqual(s.present.shown("kitchen-display"), [])
    }))

  it("the list is built from the view, the device's detail and the asker alone: a unit view of every case", () => {
    const view = (modules: ReadonlyArray<{ name: string; state: string }>) => ({ modules: modules.map((m, i) => ({ id: `m${i}`, kind: "capability", ...m })), devices: [], home: {} }) as unknown as HostView
    const bad = [{ name: "Weather", state: "error" }]
    assert.isUndefined(issuesList(view([]), "en", "all", "shared", "p-sam"))
    assert.isUndefined(issuesList(view(bad), "en", "all", "none", "p-sam"))
    assert.isUndefined(issuesList(view(bad), "en", "devices", "private", "p-sam"))
    assert.isUndefined(issuesList(view(bad), "en", "all", "shared", undefined))
    assert.isUndefined(issuesList(view(bad), "en", "all", "shared", "Not A Member Id"))
    assert.deepStrictEqual((issuesList(view(bad), "en", "all", "shared", "p-sam") as { sensitivity: unknown }).sensitivity, { personal: "p-sam" })
    // The name of a module is cut for the screen at a code point; the list stays valid.
    const long = issuesList(view([{ name: `${"a".repeat(58)}😀${"b".repeat(40)}`, state: "error" }]), "en", "all", "shared", "p-sam")
    const items = (long as { items: ReadonlyArray<{ text: string }> }).items
    assert.isAtMost(items[0]!.text.length, 80)
    assert.match(items[0]!.text, /… has stopped with an error\.$/)
    assert.notMatch(items[0]!.text, lone)
    assert.isAtMost(long!.spoken.length, 300)
  })

  it("a text is cut at a code point inside its limit, never between the halves of an emoji", () => {
    for (let n = 3; n < 12; n++) {
      const cut = cutFor(`${"a".repeat(n - 2)}😀😀😀😀`, n)
      assert.isAtMost(cut.length, n)
      assert.notMatch(cut, lone, `n=${n}`)
    }
    assert.strictEqual(cutFor("short", 10), "short")
  })

  it.effect("returning the list costs the answer almost nothing", () =>
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
