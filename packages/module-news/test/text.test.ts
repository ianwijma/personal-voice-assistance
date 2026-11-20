// The cleaning of text from outside, and the feed parse task itself (called here directly, as a pure function; the
// module runs it in a worker thread).
import { assert, describe, it } from "@effect/vitest"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import parse, { type ParseOutput } from "../src/parseFeed.task.ts"
import { cleanArticle, cleanSummary, cleanTitle, CUT_MARKER, decodeEntities, stripMarkup, titleKey } from "../src/text.ts"

const NOW = Date.UTC(2026, 10, 18, 9)
const BASE = "https://news.example.org/feed"
const entries = (text: string) => {
  const out: ParseOutput = parse({ text, base: BASE, now: NOW, maxEntries: 25 })
  assert.isTrue(out.ok, "parsed")
  return out.ok ? out.entries : []
}
const channel = (body: string, ns = "") => `<rss version="2.0"${ns}><channel><title>Probe</title><link>https://news.example.org/</link>${body}</channel></rss>`
const date = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toUTCString()

describe("titles cleaned for speech", () => {
  it("takes out markup, entities, emoji, links and labels", () => {
    assert.strictEqual(cleanTitle("LIVE: Kabinet &amp; co <b>akkoord</b> 🔥"), "Kabinet & co akkoord")
    assert.strictEqual(cleanTitle("VIDEO | Ajax wint van PSV"), "Ajax wint van PSV")
    assert.strictEqual(cleanTitle("BREAKING NEWS: Storm hits coast https://t.co/abc"), "Storm hits coast")
    assert.strictEqual(cleanTitle("LIVE | VIDEO: Rain all day"), "Rain all day")
    assert.strictEqual(cleanTitle("Wow &#x1F600; so &#233;lan &#0;"), "Wow so élan")
  })
  it("keeps a short capital subject, and a word before a colon", () => {
    assert.strictEqual(cleanTitle("NASA: Moon landing delayed"), "NASA: Moon landing delayed")
    assert.strictEqual(cleanTitle("Kabinet: nieuw plan"), "Kabinet: nieuw plan")
  })
  it("does not shout, and cuts a long title at a word", () => {
    assert.strictEqual(cleanTitle("THE CABINET AGREES A NEW HOUSING PLAN"), "The cabinet agrees a new housing plan")
    const long = cleanTitle(`${"word ".repeat(100)}end`, 60)
    assert.isAtMost(long.length, 60)
    assert.isTrue(long.endsWith("…"))
  })
  it("is one line without control or bidirectional characters", () => {
    assert.strictEqual(cleanTitle("a\nb c‮d\u0000e"), "a b c d e")
    assert.strictEqual(cleanTitle(""), "")
  })
  // Finding 19: a title that cleans to nothing is empty (the reader says a neutral fallback), never the raw text.
  it("a title that is only an address, a label or emoji cleans to nothing, never back to what was taken out", () => {
    assert.strictEqual(cleanTitle("https://news.example.org/story"), "")
    assert.strictEqual(cleanTitle("www.example.org/story"), "")
    assert.strictEqual(cleanTitle("LIVE:"), "")
    assert.strictEqual(cleanTitle("BREAKING NEWS"), "")
    assert.strictEqual(cleanTitle("🔥🔥 🎉"), "")
    assert.strictEqual(cleanTitle("<b></b> &nbsp; …"), "")
  })
  it("summaries lose markup and links and are cut", () => {
    assert.strictEqual(cleanSummary("<p>Hello <a href='x'>world</a> https://x.example/y now</p>"), "Hello world now")
    assert.isAtMost(cleanSummary("x ".repeat(500), 100).length, 100)
    assert.strictEqual(stripMarkup("<script>alert(1)</script>safe"), "safe")
    assert.strictEqual(decodeEntities("&unknown; &amp;amp;"), "&unknown; &amp;")
  })
  // Finding 18: markup escaped once, twice or more never comes back as markup, and nothing is left that looks like it.
  it("nested escaped markup is plain text after cleaning, however deep the escaping", () => {
    assert.strictEqual(cleanTitle("&amp;lt;b&amp;gt;Hello&amp;lt;/b&amp;gt;"), "Hello")
    assert.strictEqual(cleanTitle("&lt;script&gt;alert(1)&lt;/script&gt;Hello"), "Hello")
    assert.strictEqual(cleanSummary("&amp;amp;lt;img src=x onerror=alert(1)&amp;amp;gt;Plain"), "Plain")
    for (const s of [cleanSummary("&amp;amp;amp;amp;lt;b&amp;amp;amp;amp;gt;Deep"), cleanTitle("a &lt; b &gt; c"), cleanSummary("<<<<>>>> x < y"), cleanSummary("&#60;i&#62;x&#60;/i&#62;")]) assert.notMatch(s, /[<>]|&[a-z#0-9]+;/i)
    // A text full of brackets is still cleaned in one pass of each rule (no quadratic tag search).
    const brackets = "<".repeat(40_000)
    const start = performance.now()
    assert.strictEqual(stripMarkup(brackets), "")
    assert.isBelow(performance.now() - start, bound(200))
  })
  it("an address made of entities is taken out after decoding", () => {
    assert.strictEqual(cleanSummary("Read https&#58;//evil.example/x now"), "Read now")
  })
})

describe("articles cleaned and bounded", () => {
  // Finding 7: the text is bounded by the module's limit (not by an earlier cut of the input), with a marker.
  it("keeps text past 3,600 characters, cuts at the limit with a marker, and counts the whole article's words", () => {
    const words = Array.from({ length: 2_400 }, (_, i) => `w${i}`)
    const read = cleanArticle(words.join(" "), 6_000)
    assert.isTrue(read.cut)
    assert.isAtMost(read.text.length, 6_000)
    assert.isAbove(read.text.length, 5_900)
    assert.isTrue(read.text.endsWith(CUT_MARKER))
    assert.include(read.text, "w1000 ")
    assert.strictEqual(read.words, 2_400)
    const short = cleanArticle("A short article.", 6_000)
    assert.deepStrictEqual(short, { text: "A short article.", cut: false, words: 3 })
  })
})

describe("titles as stories compare them", () => {
  it("equal titles have one key; others do not", () => {
    assert.strictEqual(titleKey("Storm hits the coast!"), titleKey("storm hits  the coast"))
    assert.strictEqual(titleKey("Élan vital"), titleKey("elan vital"))
    assert.notStrictEqual(titleKey("Storm hits the coast"), titleKey("Storm hits coast"))
    assert.strictEqual(titleKey(""), "")
  })
})

describe("the feed parse task", () => {
  // Finding 8.
  it("uses Atom content, JSON Feed content_html and content_text, and RSS content:encoded when there is no summary", () => {
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>urn:probe</id><updated>2026-11-18T08:00:00Z</updated><entry><id>urn:item</id><title>Atom story</title><link href="/story"/><updated>2026-11-18T08:00:00Z</updated><content type="html">&lt;p&gt;The atom story summary.&lt;/p&gt;</content></entry></feed>`
    assert.deepStrictEqual(entries(atom).map((e) => [e.title, e.summary, e.url]), [["Atom story", "The atom story summary.", "https://news.example.org/story"]])
    const json = (item: object) => JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "JSON", items: [{ id: "1", url: "https://news.example.org/a", title: "JSON story", date_published: "2026-11-18T08:00:00Z", ...item }] })
    assert.strictEqual(entries(json({ content_html: "<p>The JSON <b>html</b> summary.</p>" }))[0]!.summary, "The JSON html summary.")
    assert.strictEqual(entries(json({ content_text: "The JSON text summary." }))[0]!.summary, "The JSON text summary.")
    const encoded = channel(`<item><title>RSS story</title><link>https://news.example.org/r</link><content:encoded><![CDATA[<p>The full <i>story</i>.</p>]]></content:encoded></item>`, ` xmlns:content="http://purl.org/rss/1.0/modules/content/"`)
    assert.strictEqual(entries(encoded)[0]!.summary, "The full story.")
  })
  // Finding 9.
  it("an RSS or Atom feed with no entries parses as an empty feed, not as \"not a feed\"", () => {
    assert.deepStrictEqual(parse({ text: channel(""), base: BASE, now: NOW, maxEntries: 25 }), { ok: true, title: "Probe", entries: [] })
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title><id>urn:e</id><updated>2026-11-18T08:00:00Z</updated></feed>`
    assert.deepStrictEqual(parse({ text: atom, base: BASE, now: NOW, maxEntries: 25 }), { ok: true, title: "Empty", entries: [] })
    assert.deepStrictEqual(parse({ text: "<<<not xml", base: BASE, now: NOW, maxEntries: 25 }), { ok: false })
    assert.deepStrictEqual(parse({ text: "<html><body>a page</body></html>", base: BASE, now: NOW, maxEntries: 25 }), { ok: false })
  })
  // Finding 10.
  it("two entries with one identity are one item, and identities that share a long beginning stay apart", () => {
    const item = (guid: string, title: string, ago: number) => `<item><guid isPermaLink="false">${guid}</guid><title>${title}</title><link>https://news.example.org/${encodeURIComponent(title)}</link><pubDate>${date(ago)}</pubDate></item>`
    const twice = entries(channel(item("same", "Older version", 30) + item("same", "Newer version", 10)))
    assert.deepStrictEqual(twice.map((e) => e.title), ["Newer version"])
    const prefix = "x".repeat(400)
    const apart = entries(channel(item(`${prefix}-one`, "One", 10) + item(`${prefix}-two`, "Two", 20)))
    assert.deepStrictEqual(apart.map((e) => e.title), ["One", "Two"])
    assert.notStrictEqual(apart[0]!.key, apart[1]!.key)
    assert.match(apart[0]!.key, /^[0-9a-f]{64}$/)
  })
  // Finding 11.
  it("the newest entries are chosen across the whole feed, whatever its order", () => {
    const items = Array.from({ length: 100 }, (_, i) => `<item><guid>${i}</guid><title>Story ${i}</title><link>https://news.example.org/${i}</link><pubDate>${date(100 - i)}</pubDate></item>`)
    const ascending = entries(channel(items.join("")))
    assert.strictEqual(ascending.length, 25)
    assert.deepStrictEqual(ascending.slice(0, 3).map((e) => e.title), ["Story 99", "Story 98", "Story 97"])
    // Shuffled the same way every run.
    const shuffled = items.map((x, i) => [((i * 37) % 101), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x)
    assert.deepStrictEqual(entries(channel(shuffled.join(""))).map((e) => e.title), ascending.map((e) => e.title))
  })
  // Finding 12.
  it("an entry without a link of its own has no article address: never the feed's own address", () => {
    const [none] = entries(channel(`<item><guid isPermaLink="false">x</guid><title>Story without link</title></item>`))
    assert.strictEqual(none!.title, "Story without link")
    assert.isUndefined(none!.url)
    const [perma] = entries(channel(`<item><guid isPermaLink="true">https://news.example.org/perma</guid><title>Permalink</title></item>`))
    assert.strictEqual(perma!.url, "https://news.example.org/perma")
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><id>urn:a</id><updated>2026-11-18T08:00:00Z</updated><entry><id>urn:1</id><title>Only other links</title><link rel="self" href="/self"/><link rel="enclosure" href="/a.mp3"/><updated>2026-11-18T08:00:00Z</updated></entry></feed>`
    assert.isUndefined(entries(atom)[0]!.url)
  })
  it("a title that cleans to nothing is kept empty when the entry has a summary, and the entry goes when it has neither", () => {
    const got = entries(channel(`<item><guid>a</guid><title>https://news.example.org/story</title><description>The text of it.</description></item><item><guid>b</guid><title>🔥</title></item>`))
    assert.deepStrictEqual(got.map((e) => [e.title, e.summary]), [["", "The text of it."]])
  })
})
