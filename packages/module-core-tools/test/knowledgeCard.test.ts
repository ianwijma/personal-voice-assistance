// The knowledge module's card, through the real host and the kit's Presenter: what is shown where, in which words,
// its bounds, and that an answer that is not a summary takes the earlier card down.
import { assert, describe, it, vi } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { cardOf, makeKnowledge } from "../src/knowledge.ts"
import { netWith } from "./support.ts"

vi.setConfig({ testTimeout: 30_000 })

const nl = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }
const json = { "content-type": "application/json" }
const page = (title: string, extract: string) => ({ body: { type: "standard", title, extract, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.slice(0, 20))}` } } }, headers: json })
const search = (title: string) => ({ body: { query: { search: title === "" ? [] : [{ title }] } } })

const EIFFEL = "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is named after the engineer Gustave Eiffel. It was built from 1887 to 1889."
// The 59th and 60th units are the two halves of an emoji: a cut at the limit must not split them.
const EMOJI_TITLE = `${"a".repeat(58)}😀${"b".repeat(30)}`
const EMOJI_TEXT = `${"word ".repeat(55)}${"x".repeat(5)}😀😀😀 and ${"y".repeat(120)}.`

const fixtures = {
  "https://en.wikipedia.org/w/api.php": (request: { readonly url: URL }) => {
    const s = request.url.searchParams.get("srsearch")
    return search(s === "Eiffel Tower" ? "Eiffel Tower" : s === "Mercury" ? "Mercury" : s === "Emoji" ? "Emoji" : "")
  },
  "https://en.wikipedia.org/api/rest_v1/page/summary/Eiffel_Tower": page("Eiffel Tower", EIFFEL),
  "https://en.wikipedia.org/api/rest_v1/page/summary/Mercury": { body: { type: "disambiguation", title: "Mercury", extract: "Mercury may refer to:" }, headers: json },
  "https://en.wikipedia.org/api/rest_v1/page/summary/Emoji": page(EMOJI_TITLE, EMOJI_TEXT),
  "https://nl.wikipedia.org/w/api.php": (request: { readonly url: URL }) => search(request.url.searchParams.get("srsearch") === "de Eiffeltoren" ? "Eiffeltoren" : ""),
  "https://nl.wikipedia.org/api/rest_v1/page/summary/Eiffeltoren": { body: { type: "standard", title: "Eiffeltoren", extract: "De Eiffeltoren is een toren in Parijs. Hij werd gebouwd in 1889.", content_urls: { desktop: { page: "https://nl.wikipedia.org/wiki/Eiffeltoren" } } }, headers: json },
  "https://en.wiktionary.org/api/rest_v1/page/definition/house": { body: { en: [{ partOfSpeech: "Noun", language: "English", definitions: [{ definition: "A building for human habitation." }] }] } }
}

const household = {
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: null },
    { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-robin" },
    { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public" as const, defaultPerson: null },
    { id: "office-speaker", name: "Office speaker", room: "Office", privacy: "shared" as const, defaultPerson: null, capabilities: { v: 1 as const, speaker: { media: ["speech" as const] } } }
  ]
}
const start = () => startTestModule(makeKnowledge(netWith(fixtures).deps), { household })
let turn = 0
const asking = (device: string) => ({ device, turnId: ++turn }) as never

describe("knowledge: the card", () => {
  it.effect("a summary is a transient card with the title, the short text and the source; it is the same answer the model gets, and the same on a shared, a private and a public device", () =>
    Effect.gen(function*() {
      const k = yield* start()
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) {
        const r = yield* k.tool("lookup", { query: "Eiffel Tower" }, asking(device))
        // The tool's answer is what it was: no screen note, no change of shape.
        assert.deepStrictEqual(Object.keys(r.value as object).sort(), ["extract", "lang", "note", "source", "title", "url"])
        yield* k.present.settle
        const [card, ...more] = k.present.shown(device)
        assert.strictEqual(more.length, 0, device)
        assert.strictEqual(card?.lifetime, "transient", device)
        assert.deepStrictEqual(card?.content, { kind: "card", title: "Eiffel Tower", text: EIFFEL, facts: [{ label: "Source", value: "Wikipedia (en)" }] } as never, device)
      }
      // Nothing of it is on a device that is not the one that asked.
      assert.deepStrictEqual(k.present.shown("office-speaker"), [])
    }))

  it.effect("a device without a display is shown nothing and the answer is unchanged; the decision says why", () =>
    Effect.gen(function*() {
      const k = yield* start()
      const r = yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("office-speaker"))
      assert.isTrue(r.ok)
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown("office-speaker"), [])
      assert.isTrue(k.present.decisions.some((d) => d.deviceId === "office-speaker" && !d.decision.show))
    }))

  it.effect("the typed action shows the card too, in Dutch with Dutch words, and says the same sentence as before", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(makeKnowledge(netWith(fixtures).deps), { household: { ...household, ...nl.household } })
      const said = yield* k.action("lookup", { query: "de Eiffeltoren" }, asking("kitchen-display"))
      assert.deepStrictEqual(said, { ok: true, say: "Volgens Wikipedia: De Eiffeltoren is een toren in Parijs. Hij werd gebouwd in 1889." })
      yield* k.present.settle
      const [card] = k.present.shown("kitchen-display")
      assert.deepStrictEqual(card?.content, { kind: "card", title: "Eiffeltoren", text: "De Eiffeltoren is een toren in Parijs. Hij werd gebouwd in 1889.", facts: [{ label: "Bron", value: "Wikipedia (nl)" }] } as never)
      // What a device that shows nothing is told to say is the sentence the action says (the card's own `spoken`).
      assert.strictEqual(cardOf({ title: "Eiffeltoren", extract: "De Eiffeltoren is een toren in Parijs. Hij werd gebouwd in 1889.", source: "Wikipedia (nl)" }, "nl").spoken, (said as { say: string }).say)
    }))

  it.effect("what is not a summary shows no card and takes the earlier one down: a definition, an ambiguous name, nothing found", () =>
    Effect.gen(function*() {
      const k = yield* start()
      for (const next of [{ query: "house", kind: "define" }, { query: "Mercury" }, { query: "Nothing at all" }] as const) {
        yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
        yield* k.present.settle
        assert.strictEqual(k.present.shown("kitchen-display").length, 1)
        yield* k.tool("lookup", next, asking("kitchen-display"))
        yield* k.present.settle
        assert.deepStrictEqual(k.present.shown("kitchen-display"), [], JSON.stringify(next))
      }
      // A new summary replaces the old card: one at a time.
      yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
      yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
      yield* k.present.settle
      assert.strictEqual(k.present.shown("kitchen-display").length, 1)
    }))

  it.effect("the card ends by itself, and with the module", () =>
    Effect.gen(function*() {
      const k = yield* start()
      yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
      yield* k.present.settle
      assert.strictEqual(k.present.shown("kitchen-display").length, 1)
      yield* k.advance(31_000)
      assert.deepStrictEqual(k.present.shown("kitchen-display"), [])
      yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
      yield* k.present.settle
      yield* k.stop
      assert.deepStrictEqual(k.present.shown("kitchen-display"), [])
    }))

  it.effect("a title and a text cut at the limit never split an emoji, and the card is still valid", () =>
    Effect.gen(function*() {
      const k = yield* start()
      const r = yield* k.tool("lookup", { query: "Emoji" }, asking("kitchen-display"))
      assert.isTrue(r.ok)
      yield* k.present.settle
      const [card] = k.present.shown("kitchen-display")
      assert.isDefined(card, "an over-long title and text still make a card")
      const c = { ...(card!.content as { title: string; text: string }), spoken: cardOf({ title: EMOJI_TITLE, extract: EMOJI_TEXT, source: "Wikipedia (en)" }, "en").spoken }
      assert.isAtMost(c.title.length, 60)
      assert.isAtMost(c.text.length, 300)
      assert.isAtMost(c.spoken.length, 300)
      for (const t of [c.title, c.text, c.spoken]) assert.notMatch(t, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
      assert.isTrue(c.title.endsWith("…"))
    }))

  it.effect("showing costs the answer almost nothing", () =>
    Effect.gen(function*() {
      const k = yield* start()
      yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
      const t0 = performance.now()
      for (let i = 0; i < 20; i++) yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
      const per = (performance.now() - t0) / 20
      assert.isTrue(per < bound(25), `${per.toFixed(2)} ms per answer with its card`)
    }))
})
