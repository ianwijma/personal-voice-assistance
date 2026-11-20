// The knowledge module's card, through the real host and the kit's Presenter: what is shown where, in which words,
// its bounds, and that an answer that is not a summary takes the earlier card down.
import { assert, describe, it, vi } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { cardOf, makeKnowledge } from "../src/knowledge.ts"
import { counting, netWith, speculativeTurn } from "./support.ts"

vi.setConfig({ testTimeout: 30_000 })

const nl = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }
const json = { "content-type": "application/json" }
const page = (title: string, extract: string) => ({ body: { type: "standard", title, extract, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.slice(0, 20))}` } } }, headers: json })
const search = (title: string) => ({ body: { query: { search: title === "" ? [] : [{ title }] } } })

const EIFFEL = "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is named after the engineer Gustave Eiffel. It was built from 1887 to 1889."
// The 59th and 60th units are the two halves of an emoji: a cut at the limit must not split them.
const EMOJI_TITLE = `${"a".repeat(58)}😀${"b".repeat(30)}`
const EMOJI_TEXT = `${"word ".repeat(55)}${"x".repeat(5)}😀😀😀 and ${"y".repeat(120)}.`

// The extract's 299th and 300th units are the two halves of an emoji, and more text follows (the reviewer's case).
const BOUNDARY = `${"a".repeat(298)}😀${"b".repeat(40)}`
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const fixtures = {
  "https://en.wikipedia.org/w/api.php": (request: { readonly url: URL }) => {
    const s = request.url.searchParams.get("srsearch")
    return search(s === "Eiffel Tower" ? "Eiffel Tower" : s === "Mercury" ? "Mercury" : s === "Emoji" ? "Emoji" : s === "Boundary" ? "Boundary" : "")
  },
  "https://en.wikipedia.org/api/rest_v1/page/summary/Eiffel_Tower": page("Eiffel Tower", EIFFEL),
  "https://en.wikipedia.org/api/rest_v1/page/summary/Mercury": { body: { type: "disambiguation", title: "Mercury", extract: "Mercury may refer to:" }, headers: json },
  "https://en.wikipedia.org/api/rest_v1/page/summary/Emoji": page(EMOJI_TITLE, EMOJI_TEXT),
  "https://en.wikipedia.org/api/rest_v1/page/summary/Boundary": page("Boundary", BOUNDARY),
  "https://nl.wikipedia.org/w/api.php": (request: { readonly url: URL }) => search(request.url.searchParams.get("srsearch") === "de Eiffeltoren" ? "Eiffeltoren" : request.url.searchParams.get("srsearch") === "Boundary" ? "Boundary" : ""),
  "https://nl.wikipedia.org/api/rest_v1/page/summary/Boundary": page("Boundary", BOUNDARY),
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
        // The model gets the answer with the same fields as before, then the note of what the server decided.
        assert.deepStrictEqual(Object.keys(JSON.parse(r.content.replace(/\n\[Screen: [\s\S]*\]$/, ""))).sort(), ["extract", "lang", "note", "source", "title", "url"])
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

  it.effect("what is not a summary comes with no card; an earlier card is not taken down by it, only replaced by the next one or ended by its lifetime", () =>
    Effect.gen(function*() {
      const k = yield* start()
      yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
      yield* k.present.settle
      const [first] = k.present.shown("kitchen-display")
      for (const next of [{ query: "house", kind: "define" }, { query: "Mercury" }, { query: "Nothing at all" }] as const) {
        const r = yield* k.tool("lookup", next, asking("kitchen-display"))
        // The result carries no presentation: nothing in it asks to show anything.
        assert.notInclude(r.content, "[Screen")
        yield* k.present.settle
        assert.deepStrictEqual(k.present.shown("kitchen-display").map((c) => c.id), [first!.id], JSON.stringify(next))
      }
      // A new summary replaces it: one at a time.
      yield* k.tool("lookup", { query: "Boundary" }, asking("kitchen-display"))
      yield* k.present.settle
      const now = k.present.shown("kitchen-display")
      assert.strictEqual(now.length, 1)
      assert.notStrictEqual(now[0]!.id, first!.id)
    }))

  it.effect("the model's own calls all run: the same summary twice in one turn answers twice and shows its card", () =>
    Effect.gen(function*() {
      const counted = counting(makeKnowledge(netWith(fixtures).deps))
      const k = yield* startTestModule(counted.module, { household })
      const sameTurn = { device: "kitchen-display", turnId: 7 } as never
      const a = yield* k.tool("lookup", { query: "Eiffel Tower" }, sameTurn)
      const b = yield* k.tool("lookup", { query: "Eiffel Tower" }, sameTurn)
      assert.isTrue(a.ok && b.ok)
      // Two calls, two executions of the real tool (its network cache is its own business).
      assert.strictEqual(counted.executions("lookup"), 2)
      assert.strictEqual(a.content, b.content)
      assert.include(a.content, "[Screen")
      assert.include(b.content, "[Screen")
      yield* k.present.settle
      assert.strictEqual(k.present.shown("kitchen-display").length, 1)
    }))

  it.effect("a lookup in a turn that is discarded shows nothing and withdraws nothing; in a turn that is promoted it is shown once", () =>
    Effect.gen(function*() {
      const k = yield* start()
      yield* k.tool("lookup", { query: "Eiffel Tower" }, asking("kitchen-display"))
      yield* k.present.settle
      const [earlier] = k.present.shown("kitchen-display")
      // The turn is speculative, the tool runs and answers, and the turn is discarded: nothing reaches the screen.
      const discarded = speculativeTurn()
      const r = yield* discarded.within(k.tool("lookup", { query: "Boundary" }, asking("kitchen-display")))
      assert.isTrue(r.ok)
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown("kitchen-display").map((c) => c.id), [earlier!.id])
      // The same, promoted: shown once, replacing the earlier card.
      const promoted = speculativeTurn()
      yield* promoted.within(k.tool("lookup", { query: "Boundary" }, asking("kitchen-display")))
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown("kitchen-display").map((c) => c.id), [earlier!.id])
      yield* promoted.promote
      yield* k.present.settle
      const now = k.present.shown("kitchen-display")
      assert.strictEqual(now.length, 1)
      assert.notStrictEqual(now[0]!.id, earlier!.id)
      assert.strictEqual((now[0]!.content as { title: string }).title, "Boundary")
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
      yield* k.advance(10_000)
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

  it.effect("an extract with an emoji across the 300th unit is a valid card, in English and in Dutch (never a lone surrogate)", () =>
    Effect.gen(function*() {
      for (const home of [undefined, nl.household.home]) {
        const k = yield* startTestModule(makeKnowledge(netWith(fixtures).deps), { household: { ...household, ...(home === undefined ? {} : { home }) } })
        const r = yield* k.tool("lookup", { query: "Boundary" }, asking("kitchen-display"))
        assert.isTrue(r.ok)
        assert.include(r.content, "[Screen: Showing on")
        yield* k.present.settle
        const [card] = k.present.shown("kitchen-display")
        assert.isDefined(card, "the card is accepted")
        const c = card!.content as { title: string; text: string }
        assert.isAtMost(c.text.length, 300)
        assert.notMatch(c.text, LONE)
        assert.isTrue(c.text.startsWith("a".repeat(297)))
        // The action's spoken sentence and the card's fallback are cut the same way.
        const said = yield* k.action("lookup", { query: "Boundary" }, asking("kitchen-display"))
        assert.notMatch((said as { say: string }).say, LONE)
      }
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
