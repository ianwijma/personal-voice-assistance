// docs/MODULES.md "Presenting" and docs/PRESENTING.md quote this file: a module that shows a checklist from a tool's
// result (pinned, by its key), whose ticks reach a press handler registered in `shared`, which keeps the list in the
// module's store and shows it again; and its test through the kit (what was shown where, a tick, a page that does not
// hold it, a device that leaves and comes back, the module stopped).
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, defineModule, makeTool, type Presentation } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Effect, Schema } from "effect"
import { defineTexts, homeLanguage, say } from "../../src/index.ts"

// #region present-module
const errandTexts = defineTexts({
  en: { title: "Errands", spoken: "Your errands: {list}.", ticked: "Ticked off.", unticked: "Back on the list.", none: "nothing" },
  nl: { title: "Boodschappen", spoken: "Je boodschappen: {list}.", ticked: "Afgevinkt.", unticked: "Weer op de lijst.", none: "niets" }
})

const Errand = Schema.Struct({ id: Schema.String, text: Schema.String, done: Schema.Boolean })
const errands = defineCollection({ name: "errands", scope: "household", schema: Schema.Struct({ items: Schema.Array(Errand) }), maxChars: 4_000 })
const START = [{ id: "bread", text: "Bread", done: false }, { id: "stamps", text: "Stamps", done: false }]

export const errandsModule = defineModule({
  apiVersion: 2,
  id: "errands",
  name: "Errands",
  description: "Shows the household's errands as a checklist.",
  enabledByDefault: false,
  storage: { version: 1, collections: [errands] },
  shared: (ctx) =>
    Effect.gen(function*() {
      const list = ctx.store.collection(errands)
      // A press handler is registered in `shared`, like a job handler: published and withdrawn with the module. A tick
      // arrives as the press (which device, which item, ticked or not); the module changes its own data and shows the
      // list again by its key, which replaces it in place on every page that holds it.
      yield* ctx.present.handle("errands", {
        run: (press) =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            const row = yield* list.get("list")
            const items = (row?.value.items ?? START).map((i) => (i.id === press.item ? { ...i, done: press.done === true } : i))
            yield* row === undefined ? list.insert({ items }, { id: "list" }) : list.update("list", () => ({ items }))
            yield* ctx.present.show({ device: press.deviceId }, errandList(lang, items), { lifetime: "pinned", key: "errands" })
            return { say: say(errandTexts, lang, press.done === true ? "ticked" : "unticked") }
          })
      }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: (ctx) =>
    Effect.succeed({
      tools: [makeTool({
        name: "errands_show",
        description: "Show the household's errands on this device's screen.",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () =>
          Effect.gen(function*() {
            const lang = homeLanguage(ctx.host.view())
            const row = yield* ctx.store.collection(errands).get("list").pipe(Effect.orElseSucceed(() => undefined))
            const items = row?.value.items ?? START
            // The model gets `forModel` and a note of what the server did; the list goes to the Presenter in one enqueue.
            return { forModel: { open: items.filter((i) => !i.done).map((i) => i.text) }, present: errandList(lang, items), show: { lifetime: "pinned" as const, key: "errands" } }
          })
      })]
    })
})

/** The checklist; `spoken` is what the model says where nothing can be shown. */
const errandList = (lang: "en" | "nl", items: ReadonlyArray<typeof Errand.Type>): Presentation => {
  const open = items.filter((i) => !i.done).map((i) => i.text)
  return {
    kind: "list",
    title: say(errandTexts, lang, "title"),
    style: "checklist",
    items,
    spoken: say(errandTexts, lang, "spoken", { list: open.length === 0 ? say(errandTexts, lang, "none") : open.join(", ") }),
    handler: "errands"
  }
}
// #endregion present-module

describe("the errands (docs/MODULES.md, docs/PRESENTING.md)", () => {
  it.effect("shows the checklist on the device that asked; a tick from its page reaches the module, which shows it again", () =>
    Effect.gen(function*() {
      // #region present-test
      const kit = yield* startTestModule(errandsModule)
      const shown = yield* kit.tool("errands_show", {}, { device: "kitchen-display" })
      // The model gets what the tool returned for it, and the note of what the server did.
      assert.strictEqual(shown.content, "{\"open\":[\"Bread\",\"Stamps\"]}\n[Screen: Shown on \"Kitchen display\".]")
      yield* kit.present.settle
      const [list] = kit.present.shown("kitchen-display")
      assert.strictEqual(list?.content.kind, "list")
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
      // A tick, as the kitchen page's checkbox: the handler runs as the press and shows the list again by its key.
      assert.deepStrictEqual(yield* kit.present.press(list!.id, "tick", { device: "kitchen-display", item: "bread", done: true }), { ok: true, say: "Ticked off." })
      const [again] = kit.present.shown("kitchen-display")
      assert.strictEqual(again?.id, list!.id)
      assert.deepStrictEqual(again?.content.kind === "list" ? again.content.items.map((i) => i.done) : [], [true, false])
      // From a page that does not hold it: refused, nothing changes.
      assert.deepStrictEqual(yield* kit.present.press(list!.id, "tick", { device: "hall-screen", item: "stamps", done: true }), { ok: false, say: "I can't do that right now.", code: "unknown" })
      // It is pinned: a page that goes and comes back gets it again.
      yield* kit.notify.disconnect("kitchen-display")
      yield* kit.notify.connect("kitchen-display")
      assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), [list!.id])
      // Every decision is recorded: where it showed, and why not.
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "kitchen-display" && d.decision.show))
      // #endregion present-test
    }))

  it.effect("while the module is stopped, its pinned list stays and a tick answers \"I can't do that right now\"", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(errandsModule)
      yield* kit.tool("errands_show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      const [list] = kit.present.shown("kitchen-display")
      yield* kit.stop
      assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), [list!.id])
      assert.deepStrictEqual(yield* kit.present.press(list!.id, "tick", { device: "kitchen-display", item: "bread", done: true }), { ok: false, say: "I can't do that right now.", code: "not_running" })
    }))

  it.effect("a device without a display is shown nothing, and the note says so", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(errandsModule, {
        household: { devices: [{ id: "office-speaker", name: "Office speaker", room: "Office", capabilities: { v: 1, speaker: { media: ["speech"] } } }] }
      })
      const shown = yield* kit.tool("errands_show", {}, { device: "office-speaker" })
      assert.match(shown.content, /\[Screen: Not shown: "Office speaker" has no display; say it instead\.\]$/)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
    }))
})
