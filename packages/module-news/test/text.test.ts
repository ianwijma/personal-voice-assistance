import { assert, describe, it } from "@effect/vitest"
import { cleanSummary, cleanTitle, clusterByTitle, decodeEntities, sameStory, stripMarkup, tokens } from "../src/text.ts"

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
  it("is one line without control or bidirectional characters, and never empty for a non-empty title", () => {
    assert.strictEqual(cleanTitle("a\nb c‮d\u0000e"), "a b c d e")
    assert.strictEqual(cleanTitle("LIVE:"), "LIVE:")
    assert.strictEqual(cleanTitle(""), "")
  })
  it("summaries lose markup and links and are cut", () => {
    assert.strictEqual(cleanSummary("<p>Hello <a href='x'>world</a> https://x.example/y now</p>"), "Hello world now")
    assert.isAtMost(cleanSummary("x ".repeat(500), 100).length, 100)
    assert.strictEqual(stripMarkup("<script>alert(1)</script>safe"), "safe")
    assert.strictEqual(decodeEntities("&unknown; &amp;amp;"), "&unknown; &amp;")
  })
})

describe("the same story from several outlets", () => {
  it("joins reworded titles and keeps different ones apart", () => {
    assert.isTrue(sameStory(tokens("Kabinet akkoord over woningplan"), tokens("Kabinet bereikt akkoord woningplan")))
    assert.isFalse(sameStory(tokens("Kabinet akkoord over woningplan"), tokens("Ajax verliest van PSV")))
    assert.isFalse(sameStory(tokens(""), tokens("")))
    assert.isTrue(sameStory(tokens("Storm!"), tokens("storm")))
    assert.isFalse(sameStory(tokens("Storm hits"), tokens("Storm warning")))
  })
  it("clusters in order, the first of a story leads it", () => {
    const stories = clusterByTitle([{ title: "Storm hits the coast" }, { title: "Ajax lose to PSV" }, { title: "Storm hits coast tonight" }])
    assert.deepStrictEqual(stories.map((s) => s.map((i) => i.title)), [["Storm hits the coast", "Storm hits coast tonight"], ["Ajax lose to PSV"]])
  })
  it("is bounded: a scan's worth of items clusters in well under a second", () => {
    const many = Array.from({ length: 280 }, (_, i) => ({ title: `story number ${i} about topic${i % 40} and thing${i}` }))
    const start = performance.now()
    clusterByTitle(many)
    assert.isBelow(performance.now() - start, 500)
  })
})
