// The sources of a search as a presentation returned with its result, through the real host, the real Presenter, the real gateway
// and (for speculation) the real Conversation: which device shows them and which does not (shared, private, public and a device
// without a screen), that the answer is unchanged, that a newer one replaces it while an empty or failed answer leaves it to its
// lifetime, that another module's card is never touched, the text bounds (an emoji at a cut, markup, every address form), a
// speculative turn that is discarded (nothing shown, nothing withdrawn) and one that is promoted (shown once), and the cost.
import { assert, describe, it, vi } from "@effect/vitest"
import { Conversation, defineModule, makeTool } from "@pva/core"
import {
  checkModule,
  eagerEndOfTurn,
  endOfTurn,
  makeMarkerTts,
  makeOfflineNet,
  makeRecordingAudioOutput,
  makeScriptedLlm,
  type OfflineResponse,
  scripted,
  sleep,
  startTestModule,
  type TestDevice,
  testTurnTraceLayer,
  textDelta,
  toolCall
} from "@pva/core/testing"
import { speakNumber } from "@pva/language"
import type { Connector } from "@pva/net"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { cutText, sourceLine, sourcesList, spokenSources, webSearchModule } from "../src/index.ts"

vi.setConfig({ testTimeout: 30_000 })

const SEARX = "http://searx.lan:8080"
const settings = { provider: "searxng", searxngUrl: SEARX }

type Item = { readonly title: string; readonly url: string; readonly content: string }

/** A SearXNG whose answer follows the query: "none" finds nothing, "broken" is not JSON, else the items of `by[query]`. */
const searx = (by: Readonly<Record<string, ReadonlyArray<Item>>>) => {
  const net = makeOfflineNet({
    [`${SEARX}/search`]: (({ url }: { url: URL }) => {
      const q = url.searchParams.get("q") ?? ""
      if (q === "broken") return { body: "not json at all" }
      return { body: { results: by[q] ?? [] } }
    }) as unknown as OfflineResponse
  }, { lan: { "searx.lan": "192.168.1.5" } })
  return { resolver: net.resolver, connector: net.connector as unknown as Connector }
}

const items = (n: number, tag = "a"): ReadonlyArray<Item> =>
  Array.from({ length: n }, (_, i) => ({ title: `Story ${tag}${i + 1}`, url: `https://news${i + 1}.example.com/${tag}/long/path?token=SECRET${i}`, content: `About ${tag}${i + 1}` }))

const ANSWERS = { first: items(3, "a"), second: items(2, "b") }

const household: { devices: ReadonlyArray<TestDevice> } = {
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
    { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
    { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null },
    // A public screen whose default person is Robin: the search is Robin's, the screen is public. A real candidate for the privacy rule.
    { id: "lobby-screen", name: "Lobby screen", room: "Lobby", privacy: "public", defaultPerson: "p-robin" },
    { id: "office-speaker", name: "Office speaker", room: "Office", capabilities: { v: 1, speaker: { media: ["speech"] } } }
  ]
}

const start = (by: Readonly<Record<string, ReadonlyArray<Item>>> = ANSWERS, extra: Record<string, unknown> = {}) =>
  startTestModule(webSearchModule(searx(by)), { settings, household: { ...household, ...extra } })

let turn = 100
const ask = (kit: Effect.Success<ReturnType<typeof start>>, query: string, device: string, person?: string | null) =>
  kit.tool("web_search", { query }, { device, turnId: ++turn, ...(person !== undefined ? { person } : {}) })

const listOf = (kit: Effect.Success<ReturnType<typeof start>>, device: string) => {
  const [one, ...rest] = kit.present.shown(device)
  assert.isUndefined(rest[0], "one presentation at most")
  return one
}

/** The model's content without the "[Screen: …]" line the host adds: the answer exactly as the tool returned it. */
const answerOf = (r: { readonly content: string }): unknown => JSON.parse(r.content.slice(0, r.content.lastIndexOf("\n[Screen: ")))

const texts = (p: ReturnType<typeof listOf>) => (p?.content.kind === "list" ? p.content.items.map((i) => i.text) : [])

describe("the sources of a search on the asking device", () => {
  it.effect("shows a title and the site per source on the shared, private and public screens, and on none without one; the answer is the same", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) {
        const answer = yield* ask(kit, "first", device)
        assert.isTrue(answer.ok)
        // The answer is what it was: no screen note, the results as the tool returns them.
        const value = answerOf(answer) as { results: Array<{ n: number; title: string; site: string; url: string }>; provider: string }
        assert.strictEqual(value.provider, "searxng")
        assert.deepStrictEqual(value.results.map((r) => r.site), ["news1.example.com", "news2.example.com", "news3.example.com"])
        yield* kit.present.settle
        const shown = listOf(kit, device)
        assert.strictEqual(shown?.content.kind, "list", device)
        assert.deepStrictEqual(texts(shown), ["Story a1 — news1.example.com", "Story a2 — news2.example.com", "Story a3 — news3.example.com"], device)
        // Never an address beyond the site's name, and it is transient.
        assert.notInclude(JSON.stringify(shown), "https://")
        assert.notInclude(JSON.stringify(shown), "SECRET")
        assert.strictEqual(shown?.lifetime, "transient")
      }
      // Each device shows its own, nothing of another's.
      assert.strictEqual(kit.present.shown("lobby-screen").length, 0)
      // A device without a screen: nothing shown, the answer the same, the decision says why.
      const quiet = yield* ask(kit, "first", "office-speaker")
      assert.isTrue(quiet.ok)
      assert.strictEqual((answerOf(quiet) as { results: Array<unknown> }).results.length, 3)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "office-speaker" && !d.decision.show && d.decision.why === "no-display"))
    }))

  it.effect("a person's search is that person's: a public screen that would show it does not (the answer is still given); nobody identified, it is the household's", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      // Robin is the lobby screen's default person and the screen is public: the privacy rule says no for it, asked at the moment of showing.
      const answer = yield* ask(kit, "first", "lobby-screen")
      assert.isTrue(answer.ok)
      assert.strictEqual((answerOf(answer) as { results: Array<unknown> }).results.length, 3)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("lobby-screen"), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "lobby-screen" && !d.decision.show && d.decision.why === "private"))
      // The same search by nobody (person null) on that screen: the household's own, as the spoken answer is.
      yield* ask(kit, "first", "lobby-screen", null)
      yield* kit.present.settle
      assert.strictEqual(listOf(kit, "lobby-screen")?.content.kind, "list")
      // On a private phone the person's own list is shown, and it is owned by her.
      yield* ask(kit, "first", "robins-phone")
      yield* kit.present.settle
      assert.strictEqual(listOf(kit, "robins-phone")?.content.kind, "list")
      assert.isTrue(kit.present.engine.live().some((p) => p.owner === "p-robin" && p.target && "device" in p.target && p.target.device === "robins-phone"))
    }))

  it.effect("the list is a snapshot: a newer answer replaces it, an empty or failed answer leaves it to its lifetime, and nothing is withdrawn", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* ask(kit, "first", "kitchen-display")
      yield* kit.present.settle
      assert.strictEqual(texts(listOf(kit, "kitchen-display")).length, 3)
      yield* ask(kit, "second", "kitchen-display")
      yield* kit.present.settle
      assert.deepStrictEqual(texts(listOf(kit, "kitchen-display")), ["Story b1 — news1.example.com", "Story b2 — news2.example.com"])
      // An empty answer and a failed search do not touch the screen (the module holds no handle); the list ends by its lifetime.
      const none = yield* ask(kit, "nothing here", "kitchen-display")
      assert.deepStrictEqual(none.value, { spoken: "I found nothing for that. Try different words." })
      assert.isFalse((yield* ask(kit, "broken", "kitchen-display")).ok)
      yield* kit.present.settle
      assert.deepStrictEqual(texts(listOf(kit, "kitchen-display")), ["Story b1 — news1.example.com", "Story b2 — news2.example.com"])
      yield* kit.advance(31_000)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // A restart takes a transient list down with the module; the next search shows again.
      yield* ask(kit, "first", "kitchen-display")
      yield* kit.present.settle
      yield* kit.restart
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      yield* ask(kit, "second", "kitchen-display")
      yield* kit.present.settle
      assert.strictEqual(texts(listOf(kit, "kitchen-display")).length, 2)
    }))

  it.effect("another module's card is never touched: a pinned card stays through every kind of answer; the answer carries the same content wherever it is refused", () =>
    Effect.gen(function*() {
      const cards = defineModule({
        apiVersion: 2,
        id: "cards",
        name: "Cards",
        description: "Pins a card.",
        enabledByDefault: false,
        start: () =>
          Effect.succeed({
            tools: [makeTool({
              name: "cards_pin",
              description: "Pin a card.",
              parameters: Schema.Struct({}),
              speculative: true,
              execute: () => Effect.succeed({ forModel: "ok", present: { kind: "card" as const, title: "Pinned card", spoken: "Pinned." }, show: { lifetime: "pinned" as const } })
            })]
          })
      })
      const kit = yield* startTestModule(webSearchModule(searx(ANSWERS)), { settings, household, others: [cards] })
      yield* kit.tool("cards_pin", {}, { device: "kitchen-display", turnId: ++turn })
      yield* kit.present.settle
      const pinned = () => kit.present.shown("kitchen-display").filter((p) => p.lifetime === "pinned").map((p) => (p.content.kind === "card" ? p.content.title : ""))
      assert.deepStrictEqual(pinned(), ["Pinned card"])
      for (const query of ["first", "nothing here", "broken", "second"]) {
        yield* ask(kit, query, "kitchen-display")
        yield* kit.present.settle
        assert.deepStrictEqual(pinned(), ["Pinned card"], query)
      }
      // A refused list (no screen, a private refusal) leaves the model the answer, exactly: the same content as where it is shown.
      const shown = yield* ask(kit, "first", "hall-screen")
      const noScreen = yield* ask(kit, "first", "office-speaker")
      const refused = yield* ask(kit, "first", "lobby-screen")
      for (const r of [noScreen, refused]) {
        assert.isTrue(r.ok)
        assert.deepStrictEqual(answerOf(r), answerOf(shown))
        assert.match(r.content, /\n\[Screen: Not showing it: /)
      }
    }))

  const converse = (kit: Effect.Success<ReturnType<typeof start>>, events: ReadonlyArray<ReturnType<typeof eagerEndOfTurn> | ReturnType<typeof endOfTurn> | ReturnType<typeof sleep>>) =>
    Effect.gen(function*() {
      const setup = { system: "s", registry: kit.host.snapshot().registry, turnContext: { assistantId: "jeff", deviceId: "kitchen-display" } }
      const model = makeScriptedLlm((request) => {
        const last = request.messages[request.messages.length - 1]
        if (last?.role === "user" && last.content === "search first") return [toolCall("c1", "web_search", { query: "first" })]
        return [textDelta("Done.")]
      })
      const layer = Conversation.layerWithSetup({ setup: Effect.succeed(setup) }).pipe(
        Layer.provideMerge(Layer.mergeAll(model.layer, testTurnTraceLayer)),
        Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 100 }).layer))
      )
      yield* Effect.gen(function*() {
        const c = yield* Conversation
        const fiber = yield* Effect.forkChild(c.voice(scripted(events as never)))
        for (let i = 0; i < 40; i++) {
          yield* Effect.repeat(Effect.yieldNow, { times: 50 })
          yield* TestClock.adjust(250)
        }
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(layer))
      yield* kit.present.settle
      return model
    })
  // The tool is speculative (no paid provider): the search starts on the eager transcript; the turn is then discarded or promoted.
  const DISCARDED = [eagerEndOfTurn("search first"), sleep(2_000), endOfTurn("search something else"), sleep(2_000)]
  const PROMOTED = [eagerEndOfTurn("search first"), sleep(2_000), endOfTurn("search first"), sleep(2_000)]

  it.effect("a speculative turn that is discarded shows nothing and withdraws nothing", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      assert.isTrue(kit.host.snapshot().registry.isSpeculative("web_search"))
      // Something already on the display, which a newer transient would end.
      yield* ask(kit, "second", "kitchen-display")
      yield* kit.present.settle
      const before = texts(listOf(kit, "kitchen-display"))
      assert.strictEqual(before.length, 2)
      const model = yield* converse(kit, DISCARDED)
      assert.isAtLeast(model.probe.requests.length, 2, "the search ran while the turn was speculative")
      assert.deepStrictEqual(texts(listOf(kit, "kitchen-display")), before)
    }))

  it.effect("a promoted speculative turn shows the list once", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* converse(kit, PROMOTED)
      assert.deepStrictEqual(texts(listOf(kit, "kitchen-display")), ["Story a1 — news1.example.com", "Story a2 — news2.example.com", "Story a3 — news3.example.com"])
      const shows = kit.present.messages.filter((m) => m.message.type === "present.show" && m.deviceId === "kitchen-display")
      assert.strictEqual(shows.length, 1)
    }))

  it.effect("text from the web stays text: markup, an address as a title, and an emoji at the cut give a valid list", () =>
    Effect.gen(function*() {
      const emoji = `${"x".repeat(58)}😀yyy`
      const by = {
        hostile: [
          { title: "<script>alert(1)</script>Breaking &lt;b&gt;news&lt;/b&gt;", url: "https://one.example.com/a", content: "s" },
          { title: "https://two.example.com/secret/path?token=abc", url: "https://two.example.com/a", content: "s" },
          { title: emoji, url: "https://three.example.com/a", content: "s" },
          { title: "😀".repeat(50), url: "https://four.example.com/a", content: "s" },
          { title: "Plain", url: "https://www.five.example.com/a", content: "s" }
        ] as ReadonlyArray<Item>
      }
      const kit = yield* start(by)
      const answer = yield* kit.tool("web_search", { query: "hostile", count: 5 }, { device: "kitchen-display", turnId: ++turn })
      assert.isTrue(answer.ok)
      yield* kit.present.settle
      const shown = listOf(kit, "kitchen-display")
      // All five are on screen: a presentation that was not valid would not be shown at all.
      const lines = texts(shown)
      assert.strictEqual(lines.length, 5)
      for (const line of lines) {
        assert.isAtMost(line.length, 80)
        assert.notMatch(line, /[<>]/)
        assert.notMatch(line, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
        assert.notInclude(line, "http")
        assert.notInclude(line, "secret")
      }
      assert.strictEqual(lines[0], "alert(1) Breaking news — one.example.com")
      assert.strictEqual(lines[1], "two.example.com")
      assert.strictEqual(lines[4], "Plain — five.example.com")
    }))

  it.effect("nothing but a site's name from an address-like title: path, query, fragment, mail, IPv6 and scheme forms never reach the presentation", () =>
    Effect.gen(function*() {
      const titles = [
        "news.example.org/secret/path",
        "news.example.org?token=screen-only-secret",
        "news.example.org#private-section",
        "[2001:db8::1]/private/path",
        "mailto:person@example.org",
        "tel:+31612345678",
        "Read more at www.example.org now",
        "person@example.org wrote this"
      ]
      // The tool returns at most five; ask twice with the titles in two lots so every form is covered.
      for (const lot of [titles.slice(0, 5), titles.slice(5)]) {
        const lotBy = { addresses: lot.map((title, i) => ({ title, url: `https://addr${i + 1}.example.com/a`, content: "s" })) as ReadonlyArray<Item> }
        const lotKit = yield* start(lotBy)
        const answer = yield* lotKit.tool("web_search", { query: "addresses", count: 5 }, { device: "kitchen-display", turnId: ++turn })
        assert.isTrue(answer.ok)
        yield* lotKit.present.settle
        const lines = texts(listOf(lotKit, "kitchen-display"))
        assert.strictEqual(lines.length, lot.length)
        const all = JSON.stringify(lotKit.present.shown("kitchen-display"))
        for (const leak of ["secret", "token", "private", "person", "example.org", "+316", "2001", "www.", "mailto", "tel:"]) assert.notInclude(all, leak, leak)
        // Each such title is the returned site's name alone.
        for (const [i, line] of lines.entries()) assert.strictEqual(line, `addr${i + 1}.example.com`)
      }
    }))

  it.effect("the list costs the answer little: a search with its list against one with nothing to show, and no call holds the thread long", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const median = (xs: Array<number>) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!
      const timed = (device: string, query: string) =>
        Effect.gen(function*() {
          const t0 = performance.now()
          const a = yield* ask(kit, query, device)
          const took = performance.now() - t0
          assert.isTrue(a.ok)
          return took
        })
      for (let i = 0; i < 5; i++) {
        yield* timed("kitchen-display", "first")
        yield* timed("office-speaker", "first")
      }
      const withList: Array<number> = []
      const without: Array<number> = []
      for (let i = 0; i < 40; i++) {
        withList.push(yield* timed("kitchen-display", i % 2 === 0 ? "second" : "first"))
        without.push(yield* timed("office-speaker", i % 2 === 0 ? "second" : "first"))
      }
      yield* kit.present.settle
      // The same work with a screen costs the answer one synchronous write: the extra stays inside the store's allowance, and the
      // slowest single answer (no timer can fire inside one) too.
      assert.isBelow(median(withList) - median(without), bound(2), `median ${median(withList).toFixed(2)} ms with, ${median(without).toFixed(2)} ms without`)
      assert.isBelow(Math.max(...withList), bound(10), `the slowest answer with a list took ${Math.max(...withList).toFixed(1)} ms`)
    }))

  it.effect("is accepted by the host and conformant", () =>
    Effect.gen(function*() {
      yield* checkModule(webSearchModule())
    }))
})

describe("the text of the list as units", () => {
  it("cutText never splits a pair and keeps its cut inside the limit", () => {
    for (let max = 1; max < 12; max++) {
      const cut = cutText("a😀b😀c😀d😀e😀f", max)
      assert.isAtMost(cut.length, max)
      assert.notMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, `max ${max}`)
    }
    assert.strictEqual(cutText("short", 10), "short")
    assert.strictEqual(cutText("a😀", 3), "a😀")
  })

  it("an item is a title and the site within 80, the site alone for an empty title or an address", () => {
    assert.strictEqual(sourceLine({ title: "Big news", site: "nos.nl" }), "Big news — nos.nl")
    assert.strictEqual(sourceLine({ title: "", site: "nos.nl" }), "nos.nl")
    assert.strictEqual(sourceLine({ title: "www.nos.nl/nieuws", site: "nos.nl" }), "nos.nl")
    const long = sourceLine({ title: "t".repeat(100), site: "s".repeat(60) })
    assert.isAtMost(long.length, 80)
    // The site's name is whole; the title gives way to it.
    assert.isTrue(long.endsWith(" — " + "s".repeat(60)))
  })

  it("the spoken fallback names whole site names inside its bound and counts the rest, in both languages", () => {
    // At most five, as the tool returns, of real size (the module keeps a site name to 60 characters).
    const sites = Array.from({ length: 5 }, (_, i) => `${String.fromCharCode(97 + i).repeat(48)}.example.org`)
    for (const lang of ["en", "nl"] as const) {
      const spoken = spokenSources(sites, lang)
      assert.isAtMost(spoken.length, 300)
      const named = sites.filter((site) => spoken.includes(site))
      // Whole names, the first ones in order; none is cut; the others are only counted.
      assert.deepStrictEqual(named, sites.slice(0, named.length))
      assert.isBelow(named.length, 5)
      assert.isAbove(named.length, 0)
      assert.notMatch(spoken, /…/)
      const rest = speakNumber(5 - named.length, lang)
      assert.include(spoken, lang === "en" ? ` and ${rest} more.` : ` en nog ${rest}.`)
    }
    // A name that cannot fit by itself is counted, never cut.
    assert.strictEqual(spokenSources(["x".repeat(400)], "en"), `Number of sources: ${speakNumber(1, "en")}.`)
    assert.strictEqual(spokenSources(["nos.nl", "bbc.com"], "en"), "The sources are: nos.nl, bbc.com.")
    assert.strictEqual(spokenSources(["nos.nl", "bbc.com"], "nl"), "De bronnen zijn: nos.nl, bbc.com.")
  })

  it("the list has a title in each language, ids s1…, and an owner only when given", () => {
    const en = sourcesList([{ title: "A", site: "a.example" }], "en")
    assert.strictEqual(en?.title, "Sources")
    assert.deepStrictEqual(en?.items, [{ id: "s1", text: "A — a.example" }])
    assert.isUndefined(en?.sensitivity)
    assert.strictEqual(sourcesList([{ title: "A", site: "a.example" }], "nl", "p-robin")?.title, "Bronnen")
    assert.deepStrictEqual(sourcesList([{ title: "A", site: "a.example" }], "nl", "p-robin")?.sensitivity, { personal: "p-robin" })
    assert.isUndefined(sourcesList([], "en"))
  })
})

describe("the list in Dutch", () => {
  it.effect("is titled in the household's language", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(webSearchModule(searx(ANSWERS)), { settings, household: { ...household, home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* ask(kit, "first", "kitchen-display")
      yield* kit.present.settle
      const shown = listOf(kit, "kitchen-display")
      assert.strictEqual(shown?.content.kind === "list" ? shown.content.title : "", "Bronnen")
    }))
})
