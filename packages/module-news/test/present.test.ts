// The phrase command and the presentation of the news (docs/PHRASES.md, docs/PRESENTING.md), through the real host: what
// is said, what each device of the household is shown, what takes it down, and a repeat of one invocation.
import { assert, describe, it } from "@effect/vitest"
import { PRESENT_OWNER, presentations } from "@pva/core"
import type { StartTestModuleOptions } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { feeds, items, SCAN_ITEMS, texts } from "../src/index.ts"
import { cutCodePoints, oneLine } from "../src/text.ts"
import { ARS, BBC, GUARDIAN, NOS, NOW, NU, refreshed, rss, startNews, value, xml, type Kit } from "./helpers.ts"

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

  it.effect("a source name with characters outside the basic plane: kept as it is, cut inside 80 UTF-16 units at a code point boundary, and the list is shown", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({ [BBC]: xml(rss("BBC News", [{ title: "First ordinary headline", link: "https://bbc.example/a", ago: 5 }, { title: "Second ordinary headline", link: "https://bbc.example/b", ago: 6 }])) }, { household })
      yield* refreshed(kit)
      yield* kit.tool("feed_unsubscribe", { name: "Ars Technica" })
      yield* kit.tool("feed_unsubscribe", { name: "The Guardian" })
      const store = kit.moduleStore()
      const row = (yield* store.collection(feeds).list({ where: { url: BBC } }))[0]!
      const rename = (name: string) => store.transaction((tx) => void tx.collection(feeds).update(row.id, (v) => ({ ...v, label: name })))
      // The whole name fits: kept, in every privacy class of device.
      yield* rename("𠮷野家")
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) {
        yield* kit.phrases.say("what's the news", { device })
        yield* kit.present.settle
        assert.deepStrictEqual(itemsOf(kit, device), ["First ordinary headline – 𠮷野家", "Second ordinary headline – 𠮷野家"], device)
      }
      // A name whose 24th unit falls inside a pair: the cut is before the pair, the line is a valid, bounded list.
      yield* rename(`${"A".repeat(22)}𠮷野家`)
      yield* kit.advance(31_000)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      const shown = itemsOf(kit, "kitchen-display")
      assert.deepStrictEqual(shown, [`First ordinary headline – ${"A".repeat(22)}…`, `Second ordinary headline – ${"A".repeat(22)}…`])
      for (const l of shown) {
        assert.isAtMost(l.length, 80)
        assert.notMatch(l, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
      }
      // A name of pairs that crosses the 24-unit cut exactly.
      yield* rename("😀".repeat(30))
      yield* kit.advance(31_000)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      const emoji = itemsOf(kit, "kitchen-display")
      assert.strictEqual(emoji[0], `First ordinary headline – ${"😀".repeat(11)}…`)
      for (const l of emoji) assert.isAtMost(l.length, 80)
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
    }))

  it("the cut counts UTF-16 units, at a code point boundary, and the line is plain text; valid pairs stay, lone surrogates go", () => {
    const emoji = "😀".repeat(100)
    const cut = cutCodePoints(emoji, 80)
    assert.isAtMost(cut.length, 80)
    assert.strictEqual(cut, `${"😀".repeat(39)}…`)
    assert.strictEqual(cutCodePoints("short", 80), "short")
    assert.strictEqual(oneLine("𠮷野家"), "𠮷野家")
    assert.strictEqual(oneLine("😀"), "😀")
    assert.strictEqual(oneLine("a\ud800b\udc00c"), "a b c")
    assert.strictEqual(oneLine("a <b>x</b>\n\tb\u202e c"), "a b x /b b c")
    assert.notMatch(oneLine("<script>alert(1)</script> news\u2028here"), /[<>\u2028]/)
  })
})

describe("@pva/module-news: what a phrase may say", () => {
  const long = (k: number, len: number) => `Story ${k} ${"with a rather long headline about the northern provinces ".repeat(3)}`.slice(0, len).trim()
  const fixtures = (a: string, b: string, len: number) => ({
    [a]: xml(rss("A", [1, 2, 3, 4, 5].map((k) => ({ title: long(k, len), link: `https://a.example/${k}`, ago: 5 + k })))),
    [b]: down
  })
  const bulk = (kit: Kit, source: string) =>
    Effect.gen(function*() {
      const store = kit.moduleStore()
      const now = yield* kit.now
      const feed = (yield* store.collection(feeds).list({ where: { url: source } }))[0]!
      yield* store.transaction((tx) => {
        for (let n = 0; n < SCAN_ITEMS + 20; n++) tx.collection(items).insert({ feedId: feed.id, title: `Bulk story number ${n.toString(36)}x${"q".repeat(3)}`, summary: "", url: `https://a.example/b${n}`, published: now - 3_600_000 - n })
      })
    })

  // 80 characters: a whole headline fits beside the notes; 150 (the reviewer's boundary): not even one does, so its title is shortened.
  for (const len of [80, 150]) {
    for (const [lang, source, other, says, phrase, more] of [
      ["en", BBC, GUARDIAN, "says BBC News.", "what's the news", /There (is one|are \w+) more; ask me for the headlines\.$/],
      ["nl", NOS, NU, "meldt NOS.", "wat is het nieuws", /Er (is er nog één|zijn er nog \w+); vraag me om de koppen\.$/]
    ] as const) {
      it.effect(`${lang}, ${len}-character headlines, a cut read and a feed down: the phrase answer fits 300 characters with the notes and the rest, and the list and "the second one" are exactly what was said`, () =>
        Effect.gen(function*() {
          const { kit } = yield* startNews(fixtures(source, other, len), { household: { ...household, home: { HOME_LANGUAGE: lang === "nl" ? "nl-NL" : "en-GB" } }, settings: { headlines: 5 } })
          yield* refreshed(kit)
          yield* bulk(kit, source)
          const outcome = yield* kit.phrases.say(phrase, { device: "kitchen-display" })
          yield* kit.present.settle
          assert.isTrue(outcome.taken)
          const spoken = phraseSaid(kit).at(-1)!
          assert.isAtMost(spoken.length, 300)
          const told = (spoken.match(/Story \d /g) ?? []).map((m) => Number(m.slice(6, 7)))
          assert.isAbove(told.length, 0)
          assert.isBelow(told.length, 5)
          assert.deepStrictEqual(told, [1, 2, 3, 4, 5].slice(0, told.length))
          if (len === 80) {
            // Whole headlines: each one said is complete, with its source.
            for (const k of told) assert.include(spoken, `${long(k, len)}, ${lang === "nl" ? "meldt" : "says"} ${lang === "nl" ? "NOS" : "BBC News"}.`)
            assert.strictEqual(spoken.split(says).length - 1, told.length)
          }
          // The honest notes, and the closing sentence about the rest.
          assert.include(spoken, lang === "nl" ? "Ik heb de nieuwste" : "I read the newest")
          assert.match(spoken, lang === "nl" ? /van je \w+ nieuwsfeeds kon ik nu niet bereiken\./ : /of your \w+ news feeds could not be reached just now\./)
          assert.match(spoken, more)
          // The list shows exactly what was said, and its notes.
          const lines = itemsOf(kit, "kitchen-display")
          assert.strictEqual(lines.length, told.length + 2)
          for (const [i, k] of told.entries()) assert.isTrue(lines[i]!.startsWith(`Story ${k} `))
          // What "the second one" means is what was said: a story past the spoken ones was never listed.
          assert.strictEqual(value(yield* kit.tool("news_story", { ref: told.length })).title.slice(0, 8), `Story ${told.length} `)
          const past = value(yield* kit.tool("news_story", { ref: told.length + 1 })).spoken as string
          assert.strictEqual(past, told.length === 1 ? texts[lang].badrefOne : texts[lang].badref.replace("{count}", lang === "nl" ? ["", "één", "twee", "drie", "vier"][told.length]! : ["", "one", "two", "three", "four"][told.length]!))
        }))
    }
  }

  it.effect("outside a phrase turn the action answers as before, in full, with every selected headline", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(fixtures(BBC, GUARDIAN, 150), { household, settings: { headlines: 5 } })
      yield* refreshed(kit)
      const said = ((yield* kit.action("top")) as { say: string }).say
      assert.isAbove(said.length, 600)
      for (const k of [1, 2, 3, 4, 5]) assert.include(said, `Story ${k} `)
      assert.notMatch(said, /ask me for the headlines/)
    }))
})

describe("@pva/module-news: the list is a snapshot of the answer", () => {
  it.effect("it is returned with the answer; the tools never touch a screen: unsubscribing a feed and the model's own headlines leave it until its lifetime ends", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      const [first] = lists(kit, "kitchen-display")
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      const sent = kit.present.messages.length
      // The model reads headlines of its own, and a feed whose stories are on the list is unsubscribed: nothing is sent to a screen.
      yield* kit.tool("news_headlines", { topic: "tech" }, { device: "kitchen-display", turnId: 20 })
      yield* kit.tool("feed_unsubscribe", { name: "The Guardian" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.messages.length, sent)
      assert.deepStrictEqual(lists(kit, "kitchen-display").map((p) => p.id), [first!.id])
      // It ends by its 30 seconds.
      yield* kit.advance(31_000)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("a later answer replaces the list on that device; an empty answer shows nothing new and leaves the earlier list to its lifetime", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      const store = kit.moduleStore()
      yield* store.transaction((tx) => {
        for (const r of tx.collection(items).list({})) tx.collection(items).remove(r.id)
      }).pipe(Effect.orDie)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.notStrictEqual(phraseSaid(kit).at(-1), SAID)
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      yield* kit.advance(31_000)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("it is transient: it does not come back after a restart of the module", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
      yield* kit.restart
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("a page that lost its connection shows nothing; a list still within its lifetime comes back when the page reconnects, before any new question, and not after it ended", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      const [first] = lists(kit, "kitchen-display")
      yield* kit.notify.disconnect("kitchen-display")
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      yield* kit.notify.connect("kitchen-display")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), [first!.id])
      yield* kit.notify.disconnect("kitchen-display")
      yield* kit.advance(31_000)
      yield* kit.notify.connect("kitchen-display")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
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
      // The list ended; the same invocation arrives again: the same words, nothing shown.
      yield* kit.advance(31_000)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      const again = (yield* kit.action("top", {}, as)) as { say: string }
      yield* kit.present.settle
      assert.deepStrictEqual(again, first)
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
      // A model call (voice) twice with one turn id runs both times.
      yield* kit.advance(31_000)
      yield* kit.action("top", {}, { device: "kitchen-display", source: "voice", turnId: 9 })
      yield* kit.present.settle
      yield* kit.advance(31_000)
      yield* kit.action("top", {}, { device: "kitchen-display", source: "voice", turnId: 9 })
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
    }))

  it.effect("the memory of invocations is bounded: past 64 the oldest is forgotten and acts again", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world, { household })
      yield* refreshed(kit)
      const as = (turnId: number) => ({ device: "kitchen-display", source: "phrase" as const, turnId })
      yield* kit.action("top", {}, as(1))
      for (let i = 2; i <= 70; i++) yield* kit.action("top", {}, as(i))
      yield* kit.advance(31_000)
      yield* kit.present.settle
      // A repeat of the last one is still remembered: nothing is shown again.
      yield* kit.action("top", {}, as(70))
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // The first was forgotten: it runs again.
      yield* kit.action("top", {}, as(1))
      yield* kit.present.settle
      assert.strictEqual(lists(kit, "kitchen-display").length, 1)
    }))

  it.effect("one record for the module: invocations of another assistant (other settings) push the oldest out, and each runs with its own settings", () =>
    Effect.gen(function*() {
      const two = {
        ...household,
        assistants: [{ id: "jeff", modules: { news: { own: { headlines: 1 } } } }, { id: "astra", modules: { news: { own: { headlines: 3 } } } }],
        devices: household.devices!.map((d) => ({ ...d, assistants: [d.id === "hall-screen" ? "astra" : "jeff"] }))
      }
      const { kit } = yield* startNews(world, { household: two })
      yield* refreshed(kit)
      const jeff = { device: "kitchen-display", assistant: "jeff", source: "phrase" as const, turnId: 1 }
      const first = (yield* kit.action("top", {}, jeff)) as { say: string }
      assert.strictEqual(first.say, "The news: Rail strike called off, says The Guardian.")
      for (let i = 2; i <= 65; i++) {
        const r = (yield* kit.action("top", {}, { device: "hall-screen", assistant: "astra", source: "phrase" as const, turnId: i })) as { say: string }
        assert.strictEqual(r.say, SAID)
      }
      // Something newer arrives; the first invocation, forgotten, runs again with its own settings and says it.
      yield* kit.moduleStore().transaction((tx) => void tx.collection(items).insert({ feedId: (tx.collection(feeds).list({ where: { url: GUARDIAN } })[0]!).id, title: "Breaking newer headline", summary: "", published: NOW }))
      const again = (yield* kit.action("top", {}, jeff)) as { say: string }
      assert.strictEqual(again.say, "The news: Breaking newer headline, says The Guardian.")
    }))
})
