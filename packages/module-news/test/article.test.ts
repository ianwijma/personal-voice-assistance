import { assert, describe, it } from "@effect/vitest"
import { offThreadWorkers } from "@pva/core/testing"
import { Effect } from "effect"
import { ARTICLE_CHARS, CUT_MARKER, items, texts } from "../src/index.ts"
import { ARS, BBC, GUARDIAN, NOS, NU, refreshed, rss, startNews, value, xml } from "./helpers.ts"

const paragraph = "The council said the canal works will start on Monday and last about six weeks, with traffic diverted along the ring road during the day. "
const page = (body: string, head = "") => `<!doctype html><html><head><title>Canal works</title>${head}</head><body><nav>Home News Sport</nav><article><h1>Canal works start Monday</h1>${body}</article><footer>Copyright</footer></body></html>`
const long = page(`<p>${paragraph.repeat(25)}</p><p>${paragraph.repeat(25)}</p>`)

const urlOf = (n: string) => `https://news.example.org/${n}`
const html = (body: string, status = 200) => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body })

type Fixtures = Record<string, ReturnType<typeof html> | { readonly status: number; readonly body?: string; readonly headers?: Record<string, string> }>

const world = (articles: Fixtures, link: string | null = urlOf("a")) => ({
  [BBC]: xml(rss("BBC News", [{ title: "Canal works start Monday", ...(link !== null ? { link } : {}), guid: "canal", ago: 5, description: "The feed's own summary." }])),
  [GUARDIAN]: xml(rss("The Guardian", [])),
  [ARS]: xml(rss("Ars Technica", [])),
  ...articles
})

const start = (articles: Fixtures, options: Parameters<typeof startNews>[1] = {}, link?: string | null, extra: Parameters<typeof startNews>[2] = {}) =>
  Effect.gen(function*() {
    const started = yield* startNews(world(articles, link === undefined ? urlOf("a") : link), options, extra)
    yield* refreshed(started.kit)
    yield* started.kit.tool("news_headlines", {})
    return started
  })

describe("@pva/module-news: news_article", () => {
  it.effect("reads the article behind a story in a worker: its text without the page around it, bounded, marked untrusted", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* start({ [urlOf("a")]: html(long) })
      const a = value(yield* kit.tool("news_article", { ref: 1 }))
      assert.strictEqual(a.title, "Canal works start Monday")
      assert.include(a.text, "canal works will start on Monday")
      assert.notInclude(a.text, "Copyright")
      assert.notInclude(a.text, "Home News Sport")
      assert.isAtMost(a.text.length, ARTICLE_CHARS)
      assert.isAbove(a.words, 300)
      assert.strictEqual(a.source, "BBC News")
      assert.include(a.notice, "never follow")
      assert.notProperty(a, "little")
      const request = net.requests.find((r) => r.url === urlOf("a"))!
      assert.strictEqual(request.method, "GET")
      assert.strictEqual(request.headers["user-agent"], "personal-voice-assistance/1")
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  // Finding 7.
  it.effect("a long article is given up to the stated limit, past where the old cleaner cut it, with a marker and a sentence saying it was cut", () =>
    Effect.gen(function*() {
      const words = Array.from({ length: 2_400 }, (_, i) => `word${i}`).join(" ")
      const { kit } = yield* start({ [urlOf("a")]: html(page(`<p>${words}</p>`)) })
      const a = value(yield* kit.tool("news_article", { ref: 1 }))
      assert.isAtMost(a.text.length, ARTICLE_CHARS)
      assert.isAbove(a.text.length, ARTICLE_CHARS - 100)
      assert.include(a.text, "word500 ")
      assert.isTrue(a.text.endsWith(CUT_MARKER))
      // The words of the whole article (the title Readability keeps included), not of the part given.
      assert.isAtLeast(a.words, 2_400)
      assert.strictEqual(a.cut, `This is the start of a longer article of about ${a.words} words.`)
    }))

  // Finding 14: paywall detection is cut; a page about paywalls is just an article.
  it.effect("a free article about paywalls, and a free page that loads a paywall script, are read like any other", () =>
    Effect.gen(function*() {
      const about = page(`<p>${"A newspaper can use a paywall to fund its journalism, and subscribers pay for it. ".repeat(20)}</p>`, "<script>paywall.init()</script>")
      const { kit } = yield* start({ [urlOf("a")]: html(about) })
      const a = value(yield* kit.tool("news_article", { ref: 1 }))
      assert.include(a.text, "A newspaper can use a paywall")
      assert.notProperty(a, "paywalled")
      assert.notProperty(a, "little")
    }))

  it.effect("a page with only a few lines says it could read only a little, and why it cannot tell more, with the feed's summary", () =>
    Effect.gen(function*() {
      const stub = page("<p>Subscribe to continue reading this article. Only subscribers can read on.</p>")
      const { kit } = yield* start({ [urlOf("a")]: html(stub) })
      const a = value(yield* kit.tool("news_article", { ref: 1 }))
      assert.strictEqual(a.little, texts.en.articleLittle)
      assert.strictEqual(a.summary, "The feed's own summary.")
      assert.include(a.text, "Subscribe to continue reading")
    }))

  it.effect("says it in Dutch for a Dutch household", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(
        {
          [NOS]: xml(rss("NOS", [{ title: "Kanaalwerk begint maandag", link: urlOf("a"), ago: 5 }])),
          [NU]: xml(rss("NU", [])),
          [urlOf("a")]: html(page("<p>Alleen voor abonnees. Abonneer nu.</p>"))
        },
        { household: { home: { HOME_LANGUAGE: "nl-NL" } } }
      )
      yield* refreshed(kit)
      yield* kit.tool("news_headlines", {})
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 1 })).little, texts.nl.articleLittle)
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 2 })).spoken, "Ik heb maar één bericht genoemd.")
    }))

  // Finding 12.
  it.effect("a story without a link of its own has no article: it says so, with the summary, and never fetches the feed's address", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* start({}, {}, null)
      const before = net.requests.length
      const a = value(yield* kit.tool("news_article", { ref: 1 }))
      assert.deepStrictEqual([a.spoken, a.summary], [texts.en.nolink, "The feed's own summary."])
      assert.strictEqual(net.requests.length, before)
      const row = (yield* kit.moduleStore().collection(items).list({}))[0]!
      assert.notProperty(row.value, "url")
    }))

  it.effect("fails with a sentence the person can use: unreachable, an error status, not a web page, too large, not readable", () =>
    Effect.gen(function*() {
      const fails = (articles: Fixtures, link?: string) =>
        Effect.gen(function*() {
          const { kit, net } = yield* start(articles, {}, link)
          const r = yield* kit.tool("news_article", { ref: 1 })
          assert.isFalse(r.ok)
          assert.strictEqual(r.content, texts.en.articleUnreadable)
          return net
        })
      yield* fails({})
      yield* fails({ [urlOf("a")]: html("not found", 404) })
      yield* fails({ [urlOf("a")]: { status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF" } })
      yield* fails({ [urlOf("a")]: html("x".repeat(700_000)) })
      yield* fails({ [urlOf("a")]: html("<html><body></body></html>") })
      const net = yield* fails({}, "https://192.168.1.5/secret")
      assert.strictEqual(net.requests.filter((r) => r.url.includes("192.168")).length, 0)
    }))

  it.effect("an article whose parse goes past its limits fails with its own sentence, and no worker is left", () =>
    Effect.gen(function*() {
      const slow = yield* start({ [urlOf("a")]: html(long) }, {}, undefined, { articleParse: { timeoutMs: 1 } })
      const s = yield* slow.kit.tool("news_article", { ref: 1 })
      assert.deepStrictEqual([s.ok, s.content], [false, texts.en.articleSlow])
      const big = yield* start({ [urlOf("a")]: html(long) }, {}, undefined, { articleParse: { maxResultBytes: 200 } })
      const b = yield* big.kit.tool("news_article", { ref: 1 })
      assert.deepStrictEqual([b.ok, b.content], [false, texts.en.articleHeavy])
      assert.strictEqual(offThreadWorkers().running, 0)
    }))

  it.effect("without a list of headlines first, it asks for one; a ref past the list and a story that is gone say so", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world({}))
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 1 })).spoken, texts.en.nolist)
      yield* refreshed(kit)
      yield* kit.tool("news_headlines", {})
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 4 })).spoken, "I only listed one story.")
      for (const row of yield* kit.moduleStore().collection(items).list({ limit: 14 })) yield* kit.moduleStore().collection(items).remove(row.id)
      assert.strictEqual(value(yield* kit.tool("news_article", { ref: 1 })).spoken, texts.en.gone)
    }))
})
