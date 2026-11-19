// Finding 1: the main thread is never held long. Parsing a feed and reading an article run in worker threads
// (`offThread`); a headline request reads the cache in bounded pages with a yield between them. Each is measured with a
// 1 ms heartbeat on the main thread at the largest input the module takes, and the longest stop must stay under 10 ms
// (three times that on CI: the store's latency tests' `bound`).
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { ARTICLE_CHARS, ARTICLE_MAX_BYTES, CUT_MARKER, FEED_MAX_BYTES, feeds, items, MAX_ENTRIES, MAX_FEEDS, SCAN_ITEMS, texts } from "../src/index.ts"
import { advanceIdle, ARS, BBC, GUARDIAN, type Kit, NOW, refreshed, rss, startNews, value, xml } from "./helpers.ts"

/** Starts a 1 ms heartbeat; `stop` answers the longest gap between two beats, in ms. */
const heartbeat = () =>
  Effect.sync(() => {
    let last = performance.now()
    let longest = 0
    const timer = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 1)
    return {
      stop: Effect.promise(() => new Promise<number>((resolve) => setTimeout(() => {
        clearInterval(timer)
        resolve(longest)
      }, 5)))
    }
  })

/** The longest main-thread stop while `effect` runs, and its result. */
const measured = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    // A first beat before the work, so the start of the measure is not the start of the timer.
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
    const beat = yield* heartbeat()
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 3)))
    const result = yield* effect
    return { result, longest: yield* beat.stop }
  })

const quiet = { [BBC]: xml(rss("BBC News", [])), [GUARDIAN]: xml(rss("The Guardian", [])), [ARS]: xml(rss("Ars Technica", [])) }
const BIG = "https://big.example.org/feed.xml"
const item = (n: number) =>
  `<item><guid isPermaLink="false">story-${n}</guid><title>Canal works ${n} ${"and the ring road ".repeat(6)}</title><link>https://big.example.org/${n}</link><description>&lt;p&gt;Public works begin on ${n}. ${"Traffic is diverted. ".repeat(8)}&lt;/p&gt;</description><pubDate>${new Date(NOW - (5_000 - n) * 10_000).toUTCString()}</pubDate></item>`

/** A legal feed of just under the size limit: thousands of entries, oldest first. */
const bigFeed = (): string => {
  const head = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Big Feed</title><link>https://big.example.org/</link>`
  const parts: Array<string> = [head]
  let size = head.length + 20
  for (let n = 0; size + item(n).length < FEED_MAX_BYTES - 1_000; n++) {
    parts.push(item(n))
    size += item(n).length
  }
  return `${parts.join("")}</channel></rss>`
}

const paragraph = "<p>The council said that canal works start on Monday and continue for several weeks. Traffic will be diverted along the ring road.</p>"
const bigArticle = (): string => {
  const shell = (body: string) => `<!doctype html><html><head><title>Canal works</title></head><body><article><h1>Canal works</h1>${body}</article></body></html>`
  return shell(paragraph.repeat(Math.floor((ARTICLE_MAX_BYTES - 1_000) / paragraph.length)))
}

/** The largest cache: sixty feeds with a full answer each (MAX_ENTRIES), titles at their longest and all different. */
const fillCache = (kit: Kit) =>
  Effect.gen(function*() {
    const store = kit.moduleStore()
    const now = yield* kit.now
    const ids: Array<string> = []
    yield* store.transaction((tx) => {
      for (let f = 0; f < MAX_FEEDS - 3; f++) ids.push(tx.collection(feeds).insert({ url: `https://f${f}.example.org/rss`, label: `Feed ${f}`, topics: ["general"], starter: false, lastFetchedAt: now, lastOkAt: now, lastItemAt: now, failures: 0 }).id)
    })
    yield* store.transaction((tx) => {
      for (const [f, feedId] of ids.entries()) {
        for (let n = 0; n < MAX_ENTRIES; n++) {
          const title = `${f}-${n} ${"word ".repeat(40)}`.slice(0, 159)
          tx.collection(items).insert({ feedId, title, summary: "s".repeat(240), url: `https://f${f}.example.org/${n}`, published: now - (f * MAX_ENTRIES + n) * 1_000 })
        }
      }
    })
    return ids
  })

describe("@pva/module-news: the main thread is never held long", () => {
  it.effect("subscribing to a feed of 1 MB: parsed in a worker, the newest entries kept, the main thread held under 10 ms", () =>
    Effect.gen(function*() {
      const body = bigFeed()
      assert.isAbove(body.length, FEED_MAX_BYTES - 2_000)
      const SMALL = "https://small.example.org/feed.xml"
      const { kit } = yield* startNews({ ...quiet, [BIG]: xml(body), [SMALL]: xml(rss("Small", [{ title: "A story", link: "https://small.example.org/a" }])) })
      // Warm, as a running server is: the first call loads the worker module and the code paths once.
      yield* kit.tool("feed_subscribe", { url: SMALL })
      const { result, longest } = yield* measured(kit.tool("feed_subscribe", { url: BIG }))
      console.log(`news latency: subscribe to a ${body.length}-byte feed, longest main-thread stop ${longest.toFixed(2)} ms`)
      assert.strictEqual(value(result).spoken, `Subscribed to Big Feed, with ${MAX_ENTRIES} stories so far.`)
      // The newest of the whole feed (it is oldest first), not of its first entries.
      const newest = value(yield* kit.tool("news_headlines", { source: "Big", max: 1 })).stories[0].title as string
      assert.match(newest, /^Canal works \d+ /)
      assert.isAbove(Number(newest.split(" ")[2]), 1_000)
      assert.isBelow(longest, bound(10))
    }))

  it.effect("reading an article of 600 KB: parsed in a worker, its text bounded and marked as cut, the main thread held under 10 ms", () =>
    Effect.gen(function*() {
      const page = bigArticle()
      assert.isAbove(page.length, ARTICLE_MAX_BYTES - 2_000)
      const { kit } = yield* startNews({
        ...quiet,
        [BBC]: xml(rss("BBC News", [{ title: "Canal works", link: "https://news.example.org/a", ago: 5 }])),
        "https://news.example.org/a": { headers: { "content-type": "text/html; charset=utf-8" }, body: page }
      })
      yield* refreshed(kit)
      yield* kit.tool("news_headlines", {})
      const { result, longest } = yield* measured(kit.tool("news_article", { ref: 1 }))
      console.log(`news latency: an article of ${page.length} bytes, longest main-thread stop ${longest.toFixed(2)} ms`)
      const a = value(result)
      assert.isAtMost(a.text.length, ARTICLE_CHARS)
      assert.isTrue(a.text.endsWith(CUT_MARKER))
      assert.isAbove(a.words, 20_000)
      assert.isBelow(longest, bound(10))
    }))

  it.effect("a headline request over the largest cache: every feed full, the newest read in bounded pages, the main thread held under 10 ms", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(quiet)
      yield* refreshed(kit)
      const ids = yield* fillCache(kit)
      // Warm: the first list of a collection.
      yield* kit.tool("news_headlines", {})
      const { result, longest } = yield* measured(kit.tool("news_headlines", { max: 5 }))
      console.log(`news latency: headlines over ${ids.length * MAX_ENTRIES} cached items, longest main-thread stop ${longest.toFixed(2)} ms`)
      const h = value(result)
      assert.strictEqual(h.stories.length, 5)
      assert.strictEqual(h.cut, texts.en.cut.replace("{count}", String(SCAN_ITEMS)))
      assert.isBelow(longest, bound(10))
    }))

  it.effect("the phrase \"what's the news\" over the largest cache: the answer and its list on the screen, the main thread held under 10 ms", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(quiet, { settings: { headlines: 5 } })
      yield* refreshed(kit)
      const ids = yield* fillCache(kit)
      // Warm: the first list of a collection, the first presentation.
      yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
      yield* kit.present.settle
      const { result, longest } = yield* measured(Effect.gen(function*() {
        const said = yield* kit.phrases.say("what's the news", { device: "kitchen-display" })
        yield* kit.present.settle
        return said
      }))
      console.log(`news latency: the phrase with its list over ${ids.length * MAX_ENTRIES} cached items, longest main-thread stop ${longest.toFixed(2)} ms`)
      assert.isTrue(result.taken)
      const [shown] = kit.present.shown("kitchen-display")
      assert.strictEqual(shown?.content.kind === "list" ? shown.content.items.length : 0, 6)
      assert.isBelow(longest, bound(10))
    }))

  it.effect("a feed whose parse goes past its limits fails with a sentence, and a refreshed one is marked as failing", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews({ ...quiet, [BIG]: xml(bigFeed()) }, {}, { feedParse: { timeoutMs: 1 } })
      const r = yield* kit.tool("feed_subscribe", { url: BIG })
      assert.deepStrictEqual([r.ok, r.content], [false, texts.en.heavy])
      const small = yield* startNews({ ...quiet, [BBC]: xml(rss("BBC News", [{ title: "A story", link: "https://bbc.example/a" }])) }, {}, { feedParse: { maxResultBytes: 100 } })
      yield* advanceIdle(small.kit, 5_000)
      assert.strictEqual(value(yield* small.kit.tool("feed_list", {})).feeds.find((f: any) => f.name === "BBC News").health, "failing: limit")
    }))
})
