// The phrase command and the presentation of the news (docs/PHRASES.md, docs/PRESENTING.md), through the real host: what
// is said, what each device of the household is shown, what takes it down, and a repeat of one invocation.
import { assert, describe, it } from "@effect/vitest"
import { PRESENT_OWNER, presentations } from "@pva/core"
import type { StartTestModuleOptions } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { feeds, items, SCAN_ITEMS, texts } from "../src/index.ts"
import { cutCodePoints, oneLine } from "../src/text.ts"
import { ARS, BBC, GUARDIAN, idle, refreshed, rss, startNews, xml, type Kit } from "./helpers.ts"

vi.setConfig({ testTimeout: 30_000 })

const world = {
  [BBC]: xml(rss("BBC News", [
    { title: "Storm hits the coast", link: "https://bbc.example/storm", ago: 30 },
    { title: "Chancellor announces housing plan", link: "https://bbc.example/housing", ago: 90 }
  ])),
  [GUARDIAN]: xml(rss("The Guardian", [{ title: "Rail strike called off", link: "https://guardian.example/rail", ago: 20 }])),
  [ARS]: xml(rss("Ars Technica", [{ title: "New chip is faster", link: "https://ars.example/chip", ago: 200 }]))
}
const down = { status: 500, headers: { "content-type": "text/plain" }, body: "oops" }

const SAID = "The news: Rail strike called off, says The Guardian. Storm hits the coast, says BBC News. Chancellor announces housing plan, says BBC News."

/** The default household and an office speaker with no display. */
const household: NonNullable<StartTestModuleOptions["household"]> = {
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
    { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
    { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null },
    { id: "office-speaker", name: "Office speaker", room: "Office", privacy: "shared", defaultPerson: null, capabilities: { v: 1, speaker: { media: ["speech"] } } }
  ]
}

const lists = (kit: Kit, device: string) => kit.present.shown(device).filter((p) => p.content.kind === "list")
const itemsOf = (kit: Kit, device: string): ReadonlyArray<string> => {
  const [p] = lists(kit, device)
  return p?.content.kind === "list" ? p.content.items.map((i) => i.text) : []
}
/** What the model is told to say where a presentation is not shown (`spoken`), of every presentation stored now. */
const spokenOf = (kit: Kit) => Effect.map(kit.store.forCore(PRESENT_OWNER).collection(presentations).list({}), (rows) => rows.map((r) => r.value.spoken))
const phraseSaid = (kit: Kit) => kit.phrases.spoken.map((s) => s.text)

describe("@pva/module-news: the phrase command", () => {
  it.effect("\"what's the news\" runs news.top without the model, in English, with the same sentences as the action", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      for (const phrase of ["What's the news?", "what is the news", "Give me the headlines."]) {
        const said = yield* kit.phrases.say(phrase, { device: "kitchen-display" })
        assert.isTrue(said.taken && said.by === "command", phrase)
      }
      assert.deepStrictEqual(phraseSaid(kit), [SAID, SAID, SAID])
      // The action itself (the typed path) says the very same.
      assert.strictEqual(((yield* kit.action("top")) as { say: string }).say, SAID)
    }))

  it.effect("Dutch phrases in a Dutch household, with its own sentences", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({}, { household: { ...household, home: { HOME_LANGUAGE: "nl-NL" } } })
      // Nothing fetched yet: the action's own sentence, reached through the phrase.
      for (const phrase of ["Wat is het nieuws?", "geef me de koppen", "wat zijn de nieuwskoppen"]) {
        const said = yield* kit.phrases.say(phrase, { device: "kitchen-display" })
        assert.isTrue(said.taken && said.by === "command", phrase)
      }
      assert.deepStrictEqual(phraseSaid(kit), [texts.nl.notyet, texts.nl.notyet, texts.nl.notyet])
      // And the English ones are not Dutch phrases.
      assert.deepStrictEqual(yield* kit.phrases.say("what's the news"), { taken: false })
    }))

  it.effect("near misses are not taken: they go on to the assistant", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      for (const phrase of ["what's the news today", "the news", "news", "what's the sports news", "what is news", "tell me the headlines", "what's the new"]) {
        assert.deepStrictEqual(yield* kit.phrases.say(phrase, { device: "kitchen-display" }), { taken: false }, phrase)
      }
      assert.deepStrictEqual(kit.phrases.spoken, [])
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("the action's refusals are reached through the phrase: no feeds, feeds that could not be reached, not fetched yet", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({ [BBC]: down, [GUARDIAN]: down, [ARS]: down }, { household })
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      assert.deepStrictEqual(phraseSaid(kit), [texts.en.notyet])
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      assert.strictEqual(phraseSaid(kit).at(-1), texts.en.downAll)
      for (const name of ["Ars Technica", "BBC News", "The Guardian"]) yield* kit.tool("feed_unsubscribe", { name })
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      assert.strictEqual(phraseSaid(kit).at(-1), texts.en.nofeeds)
      // None of those showed anything.
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))
})

describe("@pva/module-news: the list of headlines on a screen", () => {
  it.effect("the headlines that were read out, a title and its source a line, on the shared, the private and the public device alike; nothing on a device without a screen", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      const expected = ["Rail strike called off – The Guardian", "Storm hits the coast – BBC News", "Chancellor announces housing plan – BBC News"]
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) {
        yield* kit.phrases.say("what's the news", { device })
        yield* kit.present.settle
        assert.deepStrictEqual(itemsOf(kit, device), expected, device)
        const [p] = lists(kit, device)
        assert.strictEqual(p?.lifetime, "transient")
        assert.deepStrictEqual(p?.buttons ?? [], [])
      }
      // The speaker: the answer is the same, nothing is shown, and the decision says why.
      const said = yield* kit.phrases.say("what's the news", { device: "office-speaker" })
      assert.isTrue(said.taken)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "office-speaker" && !d.decision.show))
      assert.deepStrictEqual(phraseSaid(kit), [SAID, SAID, SAID, SAID])
      // Only one device's list each: the public screen's is not on the phone.
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
    }))

  it.effect("the action run for a device without a screen says the same, and shows nothing", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      const r = (yield* kit.action("top", {}, { device: "office-speaker" })) as { ok: boolean; say: string }
      assert.deepStrictEqual(r, { ok: true, say: SAID })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
    }))

  it.effect("the notes are lines of the list: that the read was cut, and that feeds could not be reached; and the spoken fallback carries them", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({ ...world, [GUARDIAN]: down }, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.deepStrictEqual(itemsOf(kit, "kitchen-display"), [
        "Storm hits the coast – BBC News",
        "Chancellor announces housing plan – BBC News",
        "New chip is faster – Ars Technica",
        "1 of 3 feeds not reached."
      ])
      const [spoken] = yield* spokenOf(kit)
      assert.isTrue(spoken!.endsWith("1 of your 3 news feeds could not be reached just now."))
      assert.isAtMost(spoken!.length, 300)
    }))

  it.effect("a read that was cut short says so on the screen, as the answer does", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      const store = kit.moduleStore()
      const now = yield* kit.now
      const bbc = (yield* store.collection(feeds).list({ where: { url: BBC } }))[0]!
      yield* store.transaction((tx) => {
        for (let n = 0; n < SCAN_ITEMS + 20; n++) tx.collection(items).insert({ feedId: bbc.id, title: `Bulk story number ${n.toString(36)}x${"q".repeat(3)}`, summary: "", url: `https://bbc.example/b${n}`, published: now - 60_000 - n })
      })
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      const lines = itemsOf(kit, "kitchen-display")
      assert.strictEqual(lines.at(-1), "Older stories were not read.")
      assert.isTrue(phraseSaid(kit).at(-1)!.includes("I read the newest 280 stories; there are older ones I didn't read."))
      const [spoken] = yield* spokenOf(kit)
      assert.isTrue(spoken!.includes("there are older ones I didn't read."))
      assert.isAtMost(spoken!.length, 300)
    }))

  it.effect("long titles and sources, markup and emoji: every line is one plain line of at most 80 characters, a cut never splits an emoji, and the spoken fallback fits", () =>
    Effect.gen(function*() {
      const long = `${"Rainfall record broken across the whole of the northern provinces ".repeat(3)}😀😀😀`
      const source = `${"The Very Long Named Regional Broadcasting Company ".repeat(1)}<b>of 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀</b>`
      const { kit } = yield* startNews(
        { [BBC]: xml(rss("BBC News", [{ title: long, link: "https://bbc.example/a", ago: 5 }, { title: `Second story ${"😀".repeat(40)}`, link: "https://bbc.example/b", ago: 6 }])) },
        { household }
      )
      yield* refreshed(kit)
      yield* kit.tool("feed_unsubscribe", { name: "Ars Technica" })
      yield* kit.tool("feed_unsubscribe", { name: "The Guardian" })
      // The household's own name for the feed (stored text) may hold anything: the screen still gets one plain line.
      const store = kit.moduleStore()
      const row = (yield* store.collection(feeds).list({ where: { url: BBC } }))[0]!
      yield* store.transaction((tx) => void tx.collection(feeds).update(row.id, (v) => ({ ...v, label: source.slice(0, 60) })))
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      const shown = itemsOf(kit, "kitchen-display")
      assert.strictEqual(shown.length, 2)
      for (const l of shown) {
        assert.isAtMost(Array.from(l).length, 80)
        assert.notMatch(l, /[<>\n\t]/)
        assert.notMatch(l, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
      }
      const [spoken] = yield* spokenOf(kit)
      assert.isAtMost(spoken!.length, 300)
      assert.isAbove(spoken!.length, 0)
      assert.isTrue(spoken!.startsWith("The news:") || spoken!.includes("says"))
    }))

  it("the cut is at a code point boundary and the line is plain text", () => {
    const emoji = "😀".repeat(100)
    const cut = cutCodePoints(emoji, 80)
    assert.strictEqual(Array.from(cut).length, 80)
    assert.notMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])/)
    assert.strictEqual(cutCodePoints("short", 80), "short")
    assert.strictEqual(oneLine("a <b>x</b>\n\tb\u202e c"), "a b x /b b c")
    assert.notMatch(oneLine("<script>alert(1)</script> news\u2028here"), /[<>\u2028]/)
  })
})

describe("@pva/module-news: what is on a screen follows the data", () => {
  it.effect("a feed that is unsubscribed takes its headlines off every screen that shows them, and only those", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.phrases.say("what's the news", { device: "hall-screen" })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      assert.strictEqual(lists(kit, "hall-screen").length, 1)
      // Ars Technica's story is the fourth, not one of the three told: leaving it changes nothing on the screens.
      yield* kit.tool("feed_unsubscribe", { name: "Ars Technica" })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      assert.strictEqual(lists(kit, "hall-screen").length, 1)
      // The Guardian's is one of them: both screens lose their list at once.
      yield* kit.tool("feed_unsubscribe", { name: "The Guardian" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
    }))

  it.effect("a feed whose stories are not on the screen leaves it alone", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(
        { ...world, [ARS]: xml(rss("Ars Technica", [{ title: "Old chip story", link: "https://ars.example/old", ago: 600 }])) },
        { household, settings: { headlines: 2 } }
      )
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(itemsOf(kit, "kitchen-display").length, 2)
      yield* kit.tool("feed_unsubscribe", { name: "Ars Technica" })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      yield* kit.tool("feed_unsubscribe", { name: "The Guardian" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("a later answer replaces the list on the device; the model's own headlines and an empty answer take it down", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      const first = lists(kit, "kitchen-display")
      assert.strictEqual(first.length, 1)
      // Asked again: still one list on that screen.
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      // The model's own list replaces the conversation's last list: what the screen shows is not it any more.
      yield* kit.tool("news_headlines", { topic: "tech" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // Shown again, then the news is gone: three days on there is nothing new, and the screen is cleared by the empty answer.
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      // The stories are gone from the cache (the clean-up took them): the next answer finds nothing, says so, and the screen it
      // left on is cleared by that empty answer, not left showing what is no longer there.
      const store = kit.moduleStore()
      yield* store.transaction((tx) => {
        for (const r of tx.collection(items).list({})) tx.collection(items).remove(r.id)
      }).pipe(Effect.orDie)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.notStrictEqual(phraseSaid(kit).at(-1), SAID)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("it is transient: it ends by itself, and it does not come back after a restart of the module", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      yield* kit.restart
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // After the restart a new question shows it again.
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      yield* kit.advance(31_000)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("a page that lost its connection shows nothing, and the next answer shows it again", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.notify.disconnect("kitchen-display")
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      yield* kit.notify.connect("kitchen-display")
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
    }))
})

describe("@pva/module-news: the same invocation twice acts once", () => {
  it.effect("a repeat of one phrase invocation gets its first outcome and shows nothing again; a new invocation acts again", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      const as = { device: "kitchen-display", source: "phrase" as const, turnId: 701 }
      const first = (yield* kit.action("top", {}, as)) as { say: string }
      yield* kit.present.settle
      assert.strictEqual(first.say, SAID)
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      // The screen's list is taken down (another turn's tool), then the same invocation arrives again.
      yield* kit.tool("news_headlines", { topic: "tech" }, { device: "kitchen-display", turnId: 702 })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      const messages = kit.present.messages.length
      const again = (yield* kit.action("top", {}, as)) as { say: string }
      yield* kit.present.settle
      assert.deepStrictEqual(again, first)
      assert.strictEqual(kit.present.messages.length, messages)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // Another invocation (its own turn) acts: it says and shows again.
      const next = (yield* kit.action("top", {}, { ...as, turnId: 703 })) as { say: string }
      yield* kit.present.settle
      assert.strictEqual(next.say, SAID)
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      // Another device with the same turn id is another invocation.
      yield* kit.action("top", {}, { ...as, device: "hall-screen" })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "hall-screen").length, 1)
    }))

  it.effect("the memory of invocations is bounded: past 64 the oldest is forgotten and acts again", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      const as = (turnId: number) => ({ device: "kitchen-display", source: "phrase" as const, turnId })
      yield* kit.action("top", {}, as(1))
      for (let i = 2; i <= 70; i++) yield* kit.action("top", {}, as(i))
      yield* kit.present.settle
      // A repeat of the last one is still remembered: nothing is shown again.
      yield* kit.tool("news_headlines", { topic: "tech" }, { device: "kitchen-display", turnId: 900 })
      yield* kit.present.settle
      yield* kit.action("top", {}, as(70))
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // The first was forgotten: it runs again.
      yield* kit.action("top", {}, as(1))
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
    }))
})
