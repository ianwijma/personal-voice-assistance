import { assert, describe, it } from "@effect/vitest"
import { makeOfflineNet, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { feeds, items, MAX_FEEDS, newsModule, texts } from "../src/index.ts"
import { ARS, BBC, GUARDIAN, rss, startNews, xml } from "./helpers.ts"

const NEW = "https://news.example.org/feed.xml"
const world = {
  [BBC]: xml(rss("BBC News", [{ title: "Storm hits the coast", link: "https://bbc.example/storm", ago: 5 }])),
  [GUARDIAN]: xml(rss("The Guardian", [])),
  [ARS]: xml(rss("Ars Technica", [{ title: "New chip is faster", link: "https://ars.example/chip", ago: 50 }])),
  [NEW]: xml(rss("Leiden Daily", [{ title: "Canal works start Monday", link: "https://leiden.example/canal", ago: 5 }, { title: "Market moves to the square", link: "https://leiden.example/market", ago: 20 }]))
}
const value = (r: { readonly value: unknown }) => r.value as Record<string, any>

describe("@pva/module-news: feed_subscribe", () => {
  it.effect("subscribes after reading the feed once: its title or the given name, topics, its stories at once", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* startNews(world)
      const said = value(yield* kit.tool("feed_subscribe", { url: NEW, topics: ["Local", " local ", "news"] }))
      assert.strictEqual(said.spoken, "Subscribed to Leiden Daily, with 2 stories so far.")
      const row = (yield* kit.moduleStore().collection(feeds).list({ where: { url: NEW } }))[0]!
      assert.deepStrictEqual([row.value.label, row.value.topics, row.value.starter], ["Leiden Daily", ["local", "news"], false])
      assert.strictEqual(net.requests.at(-1)?.method, "GET")
      assert.strictEqual(net.requests.at(-1)?.headers["user-agent"], "personal-voice-assistance/1")
      // Its stories are there without waiting for the refresh job.
      assert.deepStrictEqual(value(yield* kit.tool("news_headlines", { source: "Leiden" })).stories.map((s: any) => s.title), ["Canal works start Monday", "Market moves to the square"])
      assert.strictEqual(value(yield* kit.tool("feed_list", { topic: "local" })).feeds[0].name, "Leiden Daily")
      // Again: it is known. Nothing is fetched a second time for it.
      const before = net.requests.length
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, "You already follow Leiden Daily.")
      assert.strictEqual(net.requests.length, before)
      // A name of the person's own.
      const second = "https://other.example.org/rss"
      const named = yield* startNews({ [second]: xml(rss("Some Title", [{ title: "A story", link: "https://other.example.org/a" }])) })
      assert.strictEqual(value(yield* named.kit.tool("feed_subscribe", { url: second, name: "Mine" })).spoken, "Subscribed to Mine, with 1 stories so far.")
    }))

  it.effect("says in Dutch what went wrong, in the household's language", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({ [NEW]: xml(rss("Leiden Daily", [{ title: "Een bericht", link: "https://leiden.example/a" }])) }, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, "Geabonneerd op Leiden Daily, met nu 1 berichten.")
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, "Je volgt Leiden Daily al.")
      const bad = yield* kit.tool("feed_subscribe", { url: "ftp://x.example/feed" })
      assert.isFalse(bad.ok)
      assert.strictEqual(bad.content, texts.nl.badurl)
    }))

  it.effect("refuses what is not an address of a feed, each with a sentence that says what to do", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* startNews({
        ...world,
        "https://page.example.org/": { headers: { "content-type": "text/html" }, body: "<html>a page</html>" },
        "https://rubbish.example.org/feed": xml("<<<not xml at all"),
        "https://down.example.org/feed": { status: 500, headers: { "content-type": "text/plain" }, body: "oops" },
        "https://big.example.org/feed": xml("x".repeat(1_100_000))
      })
      const text = function*(url: string) {
        const r = yield* kit.tool("feed_subscribe", { url })
        assert.isFalse(r.ok)
        return r.content
      }
      assert.strictEqual(yield* text("not a url"), texts.en.badurl)
      assert.strictEqual(yield* text("https://user:pw@x.example/feed"), texts.en.badurl)
      assert.strictEqual(yield* text("file:///etc/passwd"), texts.en.badurl)
      assert.strictEqual(yield* text("https://page.example.org/"), texts.en.notafeed)
      assert.strictEqual(yield* text("https://rubbish.example.org/feed"), texts.en.notafeed)
      assert.strictEqual(yield* text("https://down.example.org/feed"), texts.en.httpbad)
      assert.strictEqual(yield* text("https://big.example.org/feed"), texts.en.toolarge)
      assert.strictEqual(yield* text("https://nowhere.example.org/feed"), texts.en.unreachable)
      // An address on this network or a literal one is never fetched for a model's URL.
      assert.strictEqual(yield* text("https://192.168.1.5/feed"), texts.en.refused)
      assert.strictEqual(yield* text("https://localhost/feed"), texts.en.refused)
      assert.strictEqual(yield* text("http://example.org:8080/feed"), texts.en.refused)
      assert.strictEqual(net.requests.filter((r) => r.url.includes("192.168") || r.url.includes("localhost")).length, 0)
      assert.strictEqual((yield* kit.moduleStore().collection(feeds).list({})).length, 3)
    }))

  it.effect("a slow feed is given up on within its time limit", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({ [NEW]: xml(rss("x", [])) })
      // A server that never answers, until the request is aborted.
      const hang = (request: { readonly signal: AbortSignal }) => new Promise<never>((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)))
      const kit = yield* startTestModule(newsModule({ resolver: net.resolver, connector: hang as never }))
      // safeFetch's own time limit (6 s) runs on the real clock.
      const r = yield* kit.tool("feed_subscribe", { url: NEW })
      assert.isFalse(r.ok)
      assert.strictEqual(r.content, texts.en.slow)
    }), 20_000)

  it.effect("stops at the limit of feeds, and the feeds already kept are untouched", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      const store = kit.moduleStore().collection(feeds)
      for (let n = 0; n < MAX_FEEDS - 3; n++) yield* store.insert({ url: `https://f${n}.example/rss`, label: `F${n}`, topics: [], starter: false, lastFetchedAt: 0, lastOkAt: 0, lastItemAt: 0, failures: 0 })
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, `You already follow ${MAX_FEEDS} feeds, which is the most I keep. Unsubscribe from one first.`)
      assert.strictEqual((yield* store.list({ limit: 14 })).length, 14)
    }))

  it.effect("is a `change`, so it runs; a parameter the schema refuses never reaches the module", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      assert.isFalse((yield* kit.tool("feed_subscribe", { url: NEW, topics: ["a", "b", "c", "d", "e", "f"] })).ok)
      assert.isFalse((yield* kit.tool("feed_subscribe", { url: `${NEW}\nx` })).ok)
      assert.isFalse((yield* kit.tool("feed_subscribe", { url: NEW, name: "two\nlines" })).ok)
      assert.isFalse((yield* kit.tool("feed_subscribe", { url: "x".repeat(301) })).ok)
    }))
})

describe("@pva/module-news: feed_unsubscribe, feed_list and the actions", () => {
  it.effect("unsubscribes by name, by part of the name and by address, and its stories go with it", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* kit.advance(5_000)
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "bbc news" })).spoken, "Unsubscribed from BBC News.")
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "guard" })).spoken, "Unsubscribed from The Guardian.")
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: ARS })).spoken, "Unsubscribed from Ars Technica.")
      assert.deepStrictEqual(yield* kit.moduleStore().collection(items).list({}), [])
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "BBC" })).spoken, texts.en.nofeeds)
    }))

  it.effect("a name that is not followed lists what is; a name that fits two asks which; no name asks which feed", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "Reuters" })).spoken, "You don't follow a feed called Reuters. You follow Ars Technica, BBC News and The Guardian.")
      yield* kit.tool("feed_subscribe", { url: NEW, name: "BBC Local" })
      assert.match(value(yield* kit.tool("feed_unsubscribe", { name: "BBC" })).spoken, /^Which one: .*BBC.*\?$/)
      assert.match(value(yield* kit.tool("feed_unsubscribe", { name: "  " })).spoken, /^Which feed\? You follow /)
      assert.strictEqual((yield* kit.moduleStore().collection(feeds).list({ limit: 14 })).length, 4)
    }))

  it.effect("more items than one list page are all taken down with the feed", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* kit.advance(5_000)
      const f = (yield* kit.moduleStore().collection(feeds).list({ where: { url: BBC } }))[0]!
      const now = yield* kit.now
      for (let n = 0; n < 45; n++) yield* kit.moduleStore().collection(items).insert({ feedId: f.id, title: `Old ${n}`, summary: "", url: `https://bbc.example/${n}`, published: now - n })
      yield* kit.tool("feed_unsubscribe", { name: "BBC News" })
      const left = yield* kit.moduleStore().collection(items).list({ where: { feedId: f.id }, orderBy: { field: "published", direction: "asc" }, limit: 14 })
      assert.strictEqual(left.length, 0)
    }))

  it.effect("feed_list reports health and the newest story's age, and says when there are none or none on a topic", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* kit.advance(5_000)
      const list = value(yield* kit.tool("feed_list", {}))
      assert.deepStrictEqual(list.feeds.find((f: any) => f.name === "BBC News"), { name: "BBC News", topics: ["general"], health: "ok", newestItemMinutesAgo: 5 })
      assert.strictEqual(value(yield* kit.tool("feed_list", { topic: "cooking" })).spoken, "Nothing about cooking in your feeds right now.")
    }))

  it.effect("the typed actions run without the model: the news, which feeds, and unsubscribe from a name", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      assert.deepStrictEqual(yield* kit.action("top"), { ok: true, say: texts.en.notyet })
      yield* kit.advance(5_000)
      const top = (yield* kit.action("top")) as { ok: boolean; say: string }
      assert.strictEqual(top.say, "The news: Storm hits the coast, says BBC News. New chip is faster, says Ars Technica.")
      // What it said is the last list: "tell me more about the second one".
      assert.strictEqual(value(yield* kit.tool("news_story", { ref: 2 })).title, "New chip is faster")
      assert.strictEqual(((yield* kit.action("feeds")) as { say: string }).say, "Ars Technica, BBC News and The Guardian.")
      assert.strictEqual(((yield* kit.action("unsubscribe", { name: "Ars Technica" })) as { say: string }).say, "Unsubscribed from Ars Technica.")
      assert.strictEqual(((yield* kit.action("unsubscribe", { name: "Ars Technica" })) as { say: string }).say.startsWith("You don't follow"), true)
    }))

  it.effect("the typed actions speak Dutch for a Dutch household", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({}, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(((yield* kit.action("top")) as { say: string }).say, texts.nl.notyet)
      assert.strictEqual(((yield* kit.action("feeds")) as { say: string }).say, "NOS, NU.nl en Tweakers.")
      assert.strictEqual(((yield* kit.action("unsubscribe", { name: "NOS" })) as { say: string }).say, "Abonnement op NOS opgezegd.")
    }))
})
