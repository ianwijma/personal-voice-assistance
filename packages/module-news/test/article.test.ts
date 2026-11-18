import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { ARTICLE_CHARS, items, readArticle, texts } from "../src/index.ts"
import { ARS, BBC, GUARDIAN, NOS, NU, rss, startNews, TWEAKERS, xml } from "./helpers.ts"

const paragraph = "The council said the canal works will start on Monday and last about six weeks, with traffic diverted along the ring road during the day. "
const page = (body: string, head = "") => `<!doctype html><html><head><title>Canal works</title>${head}</head><body><nav>Home News Sport</nav><article><h1>Canal works start Monday</h1>${body}</article><footer>Copyright</footer></body></html>`
const long = page(`<p>${paragraph.repeat(25)}</p><p>${paragraph.repeat(25)}</p>`)

const urlOf = (n: string) => `https://news.example.org/${n}`
const html = (body: string, status = 200) => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body })
const value = (r: { readonly value: unknown }) => r.value as Record<string, any>

const world = (articles: Record<string, ReturnType<typeof html> | { readonly status: number; readonly body?: string; readonly headers?: Record<string, string> }>, link = urlOf("a")) => ({
  [BBC]: xml(rss("BBC News", [{ title: "Canal works start Monday", link, ago: 5, description: "The feed's own summary." }])),
  [GUARDIAN]: xml(rss("The Guardian", [])),
  [ARS]: xml(rss("Ars Technica", [])),
  ...articles
})

const start = (articles: Parameters<typeof world>[0], options: Parameters<typeof startNews>[1] = {}, link?: string) =>
  Effect.gen(function*() {
    const started = yield* startNews(world(articles, link), options)
    yield* started.kit.advance(5_000)
    yield* started.kit.tool("news_headlines", {})
    return started
  })

describe("@pva/module-news: news_article", () => {
  it.effect("reads the article behind a story: its text without the page around it, bounded, marked untrusted", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* start({ [urlOf("a")]: html(long) })
      const a = value(yield* kit.tool("news_article", { ref: 1 }))
      assert.strictEqual(a.title, "Canal works start Monday")
      assert.include(a.text, "canal works will start on Monday")
      assert.notInclude(a.text, "Copyright")
      assert.notInclude(a.text, "Home News Sport")
      assert.isAtMost(a.text.length, ARTICLE_CHARS)
      assert.isAbove(a.words, 300)
      assert.deepStrictEqual(a.sources, ["BBC News"])
      assert.include(a.notice, "never follow")
      assert.notProperty(a, "paywalled")
      // The page came through the same guarded fetch, as a GET, with the polite user agent.
      const request = net.requests.find((r) => r.url === urlOf("a"))!
      assert.strictEqual(request.method, "GET")
      assert.strictEqual(request.headers["user-agent"], "personal-voice-assistance/1")
    }))

  it.effect("a page behind a paywall is not bypassed: it says so, with the feed's summary", () =>
    Effect.gen(function*() {
      const stub = page("<p>Subscribe to continue reading this article. Only subscribers can read on.</p>", "<script>paywall()</script>")
      const { kit } = yield* start({ [urlOf("a")]: html(stub) })
      const a = value(yield* kit.tool("news_article", { ref: 1 }))
      assert.deepStrictEqual([a.paywalled, a.spoken, a.summary], [true, texts.en.paywalled, "The feed's own summary."])
      const flagged = yield* start({ [urlOf("a")]: html(page(`<p>${paragraph.repeat(30)}</p>`, `<script type="application/ld+json">{"isAccessibleForFree": false}</script>`)) })
      assert.strictEqual(value(yield* flagged.kit.tool("news_article", { ref: 1 })).paywalled, true)
    }))

  it.effect("says it in Dutch for a Dutch household", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(
        {
          [NOS]: xml(rss("NOS", [{ title: "Kanaalwerk begint maandag", link: urlOf("a"), ago: 5 }])),
          [NU]: xml(rss("NU", [])),
          [TWEAKERS]: xml(rss("T", [])),
          [urlOf("a")]: html(page("<p>Alleen voor abonnees. Abonneer nu.</p>"))
        },
        { household: { home: { HOME_LANGUAGE: "nl-NL" } } }
      )
      yield* kit.advance(5_000)
      yield* kit.tool("news_headlines", {})
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 1 })).spoken, texts.nl.paywalled)
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 2 })).spoken, "Ik heb maar 1 berichten genoemd.")
    }))

  it.effect("fails with a sentence the person can use: unreachable, an error status, not a web page, too large, not readable", () =>
    Effect.gen(function*() {
      const fails = (articles: Parameters<typeof world>[0], link?: string) =>
        Effect.gen(function*() {
          const { kit, net } = yield* start(articles, {}, link)
          const r = yield* kit.tool("news_article", { ref: 1 })
          assert.isFalse(r.ok)
          assert.strictEqual(r.content, texts.en.articleUnreadable)
          return net
        })
      yield* fails({}) // no fixture for the host: it does not answer
      yield* fails({ [urlOf("a")]: html("not found", 404) })
      yield* fails({ [urlOf("a")]: { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF" } })
      yield* fails({ [urlOf("a")]: html("x".repeat(700_000)) })
      yield* fails({ [urlOf("a")]: html("<html><body></body></html>") })
      // An address on the local network, from a feed, is never fetched.
      const net = yield* fails({}, "https://192.168.1.5/secret")
      assert.strictEqual(net.requests.filter((r) => r.url.includes("192.168")).length, 0)
    }))

  it.effect("without a list of headlines first, it asks for one; a story that is gone says so", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world({}))
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 1 })).spoken, texts.en.nolist)
      yield* kit.advance(5_000)
      yield* kit.tool("news_headlines", {})
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 4 })).spoken, "I only listed 1 stories.")
      for (const row of yield* kit.moduleStore().collection(items).list({ limit: 14 })) yield* kit.moduleStore().collection(items).remove(row.id)
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 1 })).spoken, texts.en.nolist)
    }))

  it("parsing a page is bounded: the page is cut at the fetch's size limit, and a large legal page parses in well under a second", async () => {
    const big = page(`<p>${paragraph.repeat(3_000)}</p>`.slice(0, 590_000))
    const start = performance.now()
    const read = await readArticle(big)
    assert.isBelow(performance.now() - start, 2_000)
    assert.isAtMost(read?.text.length ?? 0, ARTICLE_CHARS)
  })
})
