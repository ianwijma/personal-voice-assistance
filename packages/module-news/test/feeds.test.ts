import { assert, describe, it } from "@effect/vitest"
import type { Row } from "@pva/core"
import { makeOfflineNet, startTestModule } from "@pva/core/testing"
import { Effect, Fiber } from "effect"
import { type Feed, feeds, HOST_GAP_MS, items, MAX_FEEDS, MAX_URL_CHARS, newsModule, PURGE_BATCHES, texts } from "../src/index.ts"
import { advanceIdle, ARS, BBC, GUARDIAN, idle, type Kit, NOS, NOW, NU, refreshed, rss, startNews, value, xml } from "./helpers.ts"

const NEW = "https://news.example.org/feed.xml"
const world = {
  [BBC]: xml(rss("BBC News", [{ title: "Storm hits the coast", link: "https://bbc.example/storm", ago: 5 }])),
  [GUARDIAN]: xml(rss("The Guardian", [])),
  [ARS]: xml(rss("Ars Technica", [{ title: "New chip is faster", link: "https://ars.example/chip", ago: 50 }])),
  [NEW]: xml(rss("Leiden Daily", [{ title: "Canal works start Monday", link: "https://leiden.example/canal", ago: 5 }, { title: "Market moves to the square", link: "https://leiden.example/market", ago: 20 }]))
}
const emptyFeed = (n: number) => ({ url: `https://f${n}.example/rss`, label: `F${n}`, topics: [], starter: false, lastFetchedAt: 0, lastOkAt: 0, lastItemAt: 0, failures: 0 })

/** Until `check` holds, in real time (a parse in a worker), the kit's clock not moved; fails after 10 s. */
const until = (kit: Kit, check: () => boolean | Effect.Effect<boolean, unknown>) =>
  Effect.gen(function*() {
    for (let i = 0; i < 400; i++) {
      yield* kit.advance(0)
      const now = check()
      if (typeof now === "boolean" ? now : yield* now) return
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))
    }
    return yield* Effect.die(new Error("not reached in 10 s"))
  })

/** Every feed row, page by page. */
const allFeedRows = (kit: Kit) =>
  Effect.gen(function*() {
    const out: Array<Row<Feed>> = []
    let after: Row<Feed> | undefined
    for (;;) {
      const got = yield* kit.moduleStore().collection(feeds).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 14, ...(after !== undefined ? { after } : {}) })
      out.push(...got)
      if (got.length < 14) return out
      after = got.at(-1)
    }
  })

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
      assert.deepStrictEqual(value(yield* kit.tool("news_headlines", { source: "Leiden" })).stories.map((s: any) => s.title), ["Canal works start Monday", "Market moves to the square"])
      assert.strictEqual(value(yield* kit.tool("feed_list", { topic: "local" })).feeds[0].name, "Leiden Daily")
      const before = net.requests.length
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, "You already follow Leiden Daily.")
      assert.strictEqual(net.requests.length, before)
      const second = "https://other.example.org/rss"
      const named = yield* startNews({ [second]: xml(rss("Some Title", [{ title: "A story", link: "https://other.example.org/a" }])) })
      assert.strictEqual(value(yield* named.kit.tool("feed_subscribe", { url: second, name: "Mine" })).spoken, "Subscribed to Mine, with one story so far.")
    }))

  it.effect("says in Dutch what went wrong, in the household's language", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({ [NEW]: xml(rss("Leiden Daily", [{ title: "Een bericht", link: "https://leiden.example/a" }, { title: "Nog een", link: "https://leiden.example/b" }])) }, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, "Geabonneerd op Leiden Daily, met nu 2 berichten.")
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
      assert.strictEqual(yield* text("https://192.168.1.5/feed"), texts.en.refused)
      assert.strictEqual(yield* text("https://localhost/feed"), texts.en.refused)
      assert.strictEqual(yield* text("http://example.org:8080/feed"), texts.en.refused)
      assert.strictEqual(net.requests.filter((r) => r.url.includes("192.168") || r.url.includes("localhost")).length, 0)
      assert.strictEqual((yield* kit.moduleStore().collection(feeds).list({})).length, 3)
    }))

  // Finding 22.
  it.effect("an address longer than the store keeps, once it is written out, is refused before anything is fetched", () =>
    Effect.gen(function*() {
      const long = `https://news.example.org/${"é".repeat(60)}`
      assert.isBelow(long.length, MAX_URL_CHARS)
      const { kit, net } = yield* startNews({ [long]: xml(rss("x", [])) })
      const r = yield* kit.tool("feed_subscribe", { url: long })
      assert.isFalse(r.ok)
      assert.strictEqual(r.content, "That address is too long for me to keep: at most 300 characters.")
      assert.strictEqual(net.requests.length, 0)
    }))

  // Finding 9.
  it.effect("a feed with no entries can be subscribed to, and is healthy", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({ ...world, [NEW]: xml(rss("Quiet Times", [])) })
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, "Subscribed to Quiet Times. It has no stories yet.")
      assert.strictEqual(value(yield* kit.tool("feed_list", {})).feeds.find((f: any) => f.name === "Quiet Times").health, "ok")
    }))

  // Finding 10.
  it.effect("a feed with two entries of one identity subscribes, and the answer counts the items really saved", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({
        ...world,
        [NEW]: xml(rss("Twice", [{ guid: "same", title: "First version", link: "https://leiden.example/a", ago: 30 }, { guid: "same", title: "Second version", link: "https://leiden.example/a", ago: 10 }]))
      })
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, "Subscribed to Twice, with one story so far.")
      assert.deepStrictEqual(value(yield* kit.tool("news_headlines", { source: "Twice" })).stories.map((s: any) => s.title), ["Second version"])
    }))

  it.effect("a slow feed is given up on within its time limit", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({ [NEW]: xml(rss("x", [])) })
      const hang = (request: { readonly signal: AbortSignal }) => new Promise<never>((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)))
      const kit = yield* startTestModule(newsModule({ resolver: net.resolver, connector: hang as never }))
      const r = yield* kit.tool("feed_subscribe", { url: NEW })
      assert.isFalse(r.ok)
      assert.strictEqual(r.content, texts.en.slow)
    }), 20_000)

  it.effect("stops at the limit of feeds, and the feeds already kept are untouched", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      const store = kit.moduleStore().collection(feeds)
      for (let n = 0; n < MAX_FEEDS - 3; n++) yield* store.insert(emptyFeed(n))
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: NEW })).spoken, `You already follow ${MAX_FEEDS} feeds, which is the most I keep. Unsubscribe from one first.`)
      assert.strictEqual((yield* allFeedRows(kit)).length, MAX_FEEDS)
    }))

  // Finding 16.
  it.effect("subscriptions that overlap run one at a time: the limit holds, and each answer says what that call saved", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({ ...world, "https://one.example.org/feed": xml(rss("One", [])), "https://two.example.org/feed": xml(rss("Two", [])) })
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => (release = resolve))
      const kit = yield* startTestModule(newsModule({ resolver: net.resolver, connector: async (request) => (await gate, net.connector(request)) }))
      for (let n = 0; n < MAX_FEEDS - 4; n++) yield* kit.moduleStore().collection(feeds).insert(emptyFeed(n))
      // 59 feeds: two different ones at once.
      const both = Effect.all([kit.tool("feed_subscribe", { url: "https://one.example.org/feed" }), kit.tool("feed_subscribe", { url: "https://two.example.org/feed" })], { concurrency: 2 })
      const fiber = yield* Effect.forkChild(both)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 30)))
      release()
      const [one, two] = yield* Fiber.join(fiber)
      assert.deepStrictEqual([value(one).spoken, value(two).spoken], ["Subscribed to One. It has no stories yet.", `You already follow ${MAX_FEEDS} feeds, which is the most I keep. Unsubscribe from one first.`])
      assert.strictEqual((yield* allFeedRows(kit)).length, MAX_FEEDS)
      // The same address twice at once: one subscribes, the other is told it is already followed, with the saved name.
      yield* kit.tool("feed_unsubscribe", { name: "One" })
      yield* kit.tool("feed_unsubscribe", { name: "F0" })
      const same = yield* Effect.all([kit.tool("feed_subscribe", { url: NEW, name: "Mine" }), kit.tool("feed_subscribe", { url: NEW, name: "Theirs" })], { concurrency: 2 })
      assert.deepStrictEqual(same.map((r) => value(r).spoken), ["Subscribed to Mine, with 2 stories so far.", "You already follow Mine."])
      assert.strictEqual((yield* kit.moduleStore().collection(feeds).list({ where: { url: NEW } })).length, 1)
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

describe("@pva/module-news: one host at a time", () => {
  // Finding 23.
  it.effect("two feeds on one host are asked one after the other, the second a gap later", () =>
    Effect.gen(function*() {
      const A = "https://shared.example.org/a.xml"
      const B = "https://shared.example.org/b.xml"
      const { kit, net } = yield* startNews({ [A]: xml(rss("A", [])), [B]: xml(rss("B", [])) })
      for (const name of ["Ars Technica", "BBC News", "The Guardian"]) yield* kit.tool("feed_unsubscribe", { name })
      yield* kit.tool("feed_subscribe", { url: A })
      yield* kit.tool("feed_subscribe", { url: B })
      const count = () => net.requests.filter((r) => r.url.startsWith("https://shared.example.org/")).length
      assert.strictEqual(count(), 2)
      // The next refresh that finds both due (at half past): one now, the other `HOST_GAP_MS` later.
      yield* advanceIdle(kit, 30 * 60_000 - 1)
      yield* kit.advance(1)
      // The first of the two has been read and written (its parse runs in real time); the other waits for the gap.
      yield* until(kit, () => allFeedRows(kit).pipe(Effect.map((rows) => rows.some((r) => r.value.lastFetchedAt === NOW + 30 * 60_000))))
      assert.strictEqual(count(), 3)
      yield* kit.advance(HOST_GAP_MS - 500)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 300)))
      yield* kit.advance(0)
      assert.strictEqual(count(), 3)
      yield* kit.advance(500)
      yield* until(kit, () => count() === 4)
      yield* idle(kit)
    }))

  it.effect("a site that answers Retry-After is not asked again before then, by the refresh or a subscription", () =>
    Effect.gen(function*() {
      const OTHER = "https://feeds.bbci.co.uk/news/world/rss.xml"
      const { kit, net } = yield* startNews({ ...world, [BBC]: { status: 429, headers: { "content-type": "text/plain", "retry-after": "3600" }, body: "slow down" }, [OTHER]: xml(rss("BBC World", [])) })
      yield* refreshed(kit)
      assert.strictEqual(value(yield* kit.tool("feed_list", {})).feeds.find((f: any) => f.name === "BBC News").health, "failing: wait")
      const r = yield* kit.tool("feed_subscribe", { url: OTHER })
      assert.isFalse(r.ok)
      assert.strictEqual(r.content, texts.en.wait)
      assert.strictEqual(net.requests.filter((q) => q.url === OTHER).length, 0)
      // An hour later the site may be asked again.
      yield* advanceIdle(kit, 61 * 60_000)
      assert.strictEqual(value(yield* kit.tool("feed_subscribe", { url: OTHER })).spoken, "Subscribed to BBC World. It has no stories yet.")
    }))
})

describe("@pva/module-news: feed_unsubscribe, feed_list and the actions", () => {
  it.effect("unsubscribes by name, by part of the name and by address, and its stories go with it", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* refreshed(kit)
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "bbc news" })).spoken, "Unsubscribed from BBC News.")
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "guard" })).spoken, "Unsubscribed from The Guardian.")
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: ARS })).spoken, "Unsubscribed from Ars Technica.")
      yield* idle(kit)
      assert.deepStrictEqual(yield* kit.moduleStore().collection(items).list({}), [])
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "BBC" })).spoken, texts.en.nofeeds)
    }))

  it.effect("a name that is not followed lists what is; a name that fits two asks which; no name asks which feed", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "Reuters" })).spoken, "You don't follow a feed called Reuters. You follow Ars Technica, BBC News and The Guardian.")
      yield* kit.tool("feed_subscribe", { url: NEW, name: "BBC Local" })
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "BBC" })).spoken, "Which one: BBC Local and BBC News?")
      assert.match(value(yield* kit.tool("feed_unsubscribe", { name: "  " })).spoken, /^Which feed\? You follow /)
      assert.strictEqual((yield* kit.moduleStore().collection(feeds).list({ limit: 14 })).length, 4)
    }))

  // Finding 5.
  it.effect("unsubscribing takes the feed out of every read at once, and a job removes all its items, in steps, across a restart", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* refreshed(kit)
      const f = (yield* kit.moduleStore().collection(feeds).list({ where: { url: BBC } }))[0]!
      const now = yield* kit.now
      const many = PURGE_BATCHES * 14 * 2 + 30
      yield* kit.moduleStore().transaction((tx) => {
        for (let n = 0; n < many; n++) tx.collection(items).insert({ feedId: f.id, title: `Bulk ${n}`, summary: "", url: `https://bbc.example/${n}`, published: now - 1_000 - n })
      })
      yield* kit.tool("news_headlines", { source: "BBC" })
      assert.strictEqual(value(yield* kit.tool("feed_unsubscribe", { name: "BBC News" })).spoken, "Unsubscribed from BBC News.")
      // At once: no headline, story or reference of it, although its items are still being removed.
      assert.strictEqual(value(yield* kit.tool("news_story", { ref: 1 })).spoken, texts.en.gone)
      assert.isFalse(((value(yield* kit.tool("news_headlines", {})).stories ?? []) as Array<any>).some((s) => s.source === "BBC News"))
      assert.strictEqual(value(yield* kit.tool("news_headlines", { source: "BBC" })).spoken, "You don't follow a feed called BBC.")
      const left = () => kit.moduleStore().collection(items).list({ where: { feedId: f.id }, orderBy: { field: "published", direction: "asc" }, limit: 14 }).pipe(Effect.map((r) => r.length))
      assert.strictEqual(yield* left(), 14)
      // The first run removes its share and plans the next; a restart in between does not lose the work.
      yield* kit.advance(0)
      yield* idle(kit)
      assert.isDefined((yield* kit.jobs).find((j) => j.key === `purge:${f.id}` && j.state === "scheduled"))
      yield* kit.restart
      yield* advanceIdle(kit, 5_000)
      assert.strictEqual(yield* left(), 0)
      assert.isUndefined((yield* kit.jobs).find((j) => j.key === `purge:${f.id}` && j.state === "scheduled"))
    }), 30_000)

  it.effect("feed_list reports health and the newest story's age, and says when there are none or none on a topic", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* refreshed(kit)
      const list = value(yield* kit.tool("feed_list", {}))
      assert.deepStrictEqual(list.feeds.find((f: any) => f.name === "BBC News"), { name: "BBC News", topics: ["general"], health: "ok", newestItemMinutesAgo: 5 })
      assert.strictEqual(value(yield* kit.tool("feed_list", { topic: "cooking" })).spoken, "Nothing about cooking in your feeds right now.")
    }))

  it.effect("the typed actions run without the model: the news, which feeds, and unsubscribe from a name", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      assert.deepStrictEqual(yield* kit.action("top"), { ok: true, say: texts.en.notyet })
      yield* refreshed(kit)
      const top = (yield* kit.action("top")) as { ok: boolean; say: string }
      assert.strictEqual(top.say, "The news: Storm hits the coast, says BBC News. New chip is faster, says Ars Technica.")
      assert.strictEqual(value(yield* kit.tool("news_story", { ref: 2 })).title, "New chip is faster")
      assert.strictEqual(((yield* kit.action("feeds")) as { say: string }).say, "You follow Ars Technica, BBC News and The Guardian.")
      assert.strictEqual(((yield* kit.action("unsubscribe", { name: "Ars Technica" })) as { say: string }).say, "Unsubscribed from Ars Technica.")
      assert.isTrue(((yield* kit.action("unsubscribe", { name: "Ars Technica" })) as { say: string }).say.startsWith("You don't follow"))
    }))

  it.effect("the typed actions speak Dutch for a Dutch household", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({ [NOS]: xml(rss("NOS", [])), [NU]: xml(rss("NU", [])) }, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(((yield* kit.action("top")) as { say: string }).say, texts.nl.notyet)
      assert.strictEqual(((yield* kit.action("feeds")) as { say: string }).say, "Je volgt NOS en NU.nl.")
      assert.strictEqual(((yield* kit.action("unsubscribe", { name: "NOS" })) as { say: string }).say, "Abonnement op NOS opgezegd.")
    }))
})
