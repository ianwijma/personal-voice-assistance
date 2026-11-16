import { assert, describe, it } from "@effect/vitest"
import type { SttEvent } from "../src/Domain.ts"
import { makeRouteGate, type RouteConfig, type RouteGate } from "../src/RouteGate.ts"
import { eagerEndOfTurn, endOfTurn, interim, speechStarted, turnResumed } from "../src/testing.ts"

// Edge cases of the route gate that RouteGate.test.ts does not pin down.

const config = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  phrases: [
    { phrase: "hey tee", assistant: "short" },
    { phrase: "hey tee three", assistant: "t3" },
    { phrase: "hey jeff", assistant: "jeff" }
  ],
  match: "exact",
  withoutPhrase: "nobody",
  followUpMs: { jeff: 5_000, t3: 5_000, short: 5_000 },
  off: new Set(),
  ...over
})

const feed = (gate: RouteGate, events: ReadonlyArray<SttEvent>, t = 0): Array<SttEvent> =>
  events.flatMap((e, i) => [...gate.filter(e, t + i).events])

describe("RouteGate: no default assistant", () => {
  it("withoutPhrase assistant without a defaultAssistant behaves as nobody", () => {
    const gate = makeRouteGate(config({ withoutPhrase: "assistant" }))
    assert.isFalse(gate.awake(0))
    gate.filter(speechStarted, 0)
    const r = gate.filter(endOfTurn("what time is it"), 1)
    assert.deepStrictEqual(r.events, [])
    assert.deepStrictEqual(r.target, { by: "dropped", reason: "asleep" })
    assert.deepStrictEqual(r.dropped, { text: "what time is it" })
  })

  it("a phrase still reaches its assistant", () => {
    const gate = makeRouteGate(config({ withoutPhrase: "assistant" }))
    const out = feed(gate, [speechStarted, endOfTurn("hey jeff lights on")])
    assert.deepStrictEqual(out, [speechStarted, endOfTurn("lights on")])
  })
})

describe("RouteGate: which phrase wins", () => {
  it("the longest matching phrase wins over a shorter one of another assistant", () => {
    const gate = makeRouteGate(config())
    gate.filter(speechStarted, 0)
    const r = gate.filter(endOfTurn("hey tee three open it"), 1)
    assert.deepStrictEqual(r.events, [speechStarted, endOfTurn("open it")])
    assert.deepStrictEqual(r.target, { assistant: "t3", by: "phrase", phrase: "hey tee three" })
  })

  it("the shorter phrase answers when only it matches", () => {
    const gate = makeRouteGate(config())
    gate.filter(speechStarted, 0)
    const r = gate.filter(endOfTurn("hey tee open it"), 1)
    assert.deepStrictEqual(r.events, [speechStarted, endOfTurn("open it")])
    assert.deepStrictEqual(r.target, { assistant: "short", by: "phrase", phrase: "hey tee" })
  })
})

describe("RouteGate: follow-up opened by an answered utterance", () => {
  it("a phrase that releases a held utterance opens that assistant's follow-up window", () => {
    const gate = makeRouteGate(config())
    feed(gate, [speechStarted, endOfTurn("hey jeff what time is it")], 0)
    assert.deepStrictEqual(gate.window(100), { assistant: "jeff", by: "follow-up" })
    const start = gate.filter(speechStarted, 100)
    assert.deepStrictEqual(start.target, { assistant: "jeff", by: "follow-up" })
    // The window ends with the assistant's own length (5 s after the utterance ended at t=1).
    assert.isUndefined(gate.window(1 + 5_000))
  })

  it("an accepted utterance with a phrase opens the window of the assistant the phrase named", () => {
    const gate = makeRouteGate(config({ withoutPhrase: "assistant", defaultAssistant: "jeff" }))
    feed(gate, [speechStarted, endOfTurn("hey tee three open it")], 0)
    assert.deepStrictEqual(gate.window(10), { assistant: "t3", by: "follow-up" })
  })

  it("a phrase alone opens no follow-up window, only the armed one", () => {
    const gate = makeRouteGate(config())
    feed(gate, [speechStarted, endOfTurn("hey jeff")], 0)
    assert.deepStrictEqual(gate.window(10), { assistant: "jeff", by: "armed" })
    gate.filter(speechStarted, 20)
    gate.filter(endOfTurn("hello"), 21)
    // The armed window was spent and the answered utterance opened the follow-up.
    assert.deepStrictEqual(gate.window(22), { assistant: "jeff", by: "follow-up" })
  })

  it("a decide target opens no window: the gate does not learn the decision", () => {
    const gate = makeRouteGate(config({ withoutPhrase: "decide", fallback: "jeff" }))
    const r = feed(gate, [speechStarted, endOfTurn("turn on the lights")], 0)
    assert.deepStrictEqual(r, [speechStarted, endOfTurn("turn on the lights")])
    assert.isUndefined(gate.window(10))
    // The window opens when the dispatcher reports the reply.
    gate.replyEnded("jeff", 20)
    assert.deepStrictEqual(gate.window(21), { assistant: "jeff", by: "follow-up" })
  })

  it("an utterance that is blank after the phrase is removed does not open a follow-up", () => {
    const gate = makeRouteGate(config({ withoutPhrase: "assistant", defaultAssistant: "jeff", followUpMs: { jeff: 0, t3: 5_000 } }))
    feed(gate, [speechStarted, endOfTurn("hey tee three")], 0)
    // Only the armed window, not a follow-up.
    assert.deepStrictEqual(gate.window(10), { assistant: "t3", by: "armed" })
    gate.filter(speechStarted, 20)
    gate.filter(endOfTurn("   "), 21)
    assert.isUndefined(gate.window(22))
  })
})

describe("RouteGate: events outside an utterance", () => {
  it("without a SpeechStarted first, an event is passed unchanged while someone answers", () => {
    const gate = makeRouteGate(config({ withoutPhrase: "assistant", defaultAssistant: "jeff" }))
    const i = gate.filter(interim("hello"), 0)
    assert.deepStrictEqual(i, { events: [interim("hello")], target: { assistant: "jeff", by: "default" } })
    const e = gate.filter(endOfTurn("hello there"), 1)
    assert.deepStrictEqual(e.events, [endOfTurn("hello there")])
    assert.deepStrictEqual(e.target, { assistant: "jeff", by: "default" })
    assert.deepStrictEqual(e.heard, { text: "hello there", accepted: true })
  })

  it("without a SpeechStarted first, an event is dropped while nobody answers", () => {
    const gate = makeRouteGate(config())
    assert.deepStrictEqual(gate.filter(interim("hello"), 0), { events: [] })
    assert.deepStrictEqual(gate.filter(endOfTurn("hello there"), 1), { events: [] })
  })

  it("a stray event does not consume the armed window", () => {
    const gate = makeRouteGate(config())
    feed(gate, [speechStarted, endOfTurn("hey jeff")], 0)
    gate.filter(interim("stray"), 10)
    assert.deepStrictEqual(gate.window(11), { assistant: "jeff", by: "armed" })
  })

  it("a repeated SpeechStarted inside an accepted utterance is passed on with the same target", () => {
    const gate = makeRouteGate(config({ withoutPhrase: "assistant", defaultAssistant: "jeff" }))
    gate.filter(speechStarted, 0)
    const again = gate.filter(speechStarted, 1)
    assert.deepStrictEqual(again, { events: [speechStarted], target: { assistant: "jeff", by: "default" } })
    assert.deepStrictEqual(gate.filter(endOfTurn("hi"), 2).events, [endOfTurn("hi")])
  })
})

describe("RouteGate: held utterances", () => {
  it("a held utterance with no text at all closes silently", () => {
    const gate = makeRouteGate(config())
    gate.filter(speechStarted, 0)
    assert.deepStrictEqual(gate.filter(endOfTurn("  "), 1), { events: [] })
    // The gate is back to idle: the next utterance is judged afresh.
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("hey jeff hi")], 10), [speechStarted, endOfTurn("hi")])
  })

  it("an eager end of turn that already carries the phrase and words releases the utterance", () => {
    const gate = makeRouteGate(config())
    gate.filter(speechStarted, 0)
    const r = gate.filter(eagerEndOfTurn("hey jeff lights"), 1)
    assert.deepStrictEqual(r.events, [speechStarted, eagerEndOfTurn("lights")])
    assert.deepStrictEqual(r.woke, { phrase: "hey jeff", assistant: "jeff", armed: false })
    // Its resumption is passed on, because the eager transcript was forwarded.
    assert.deepStrictEqual(gate.filter(turnResumed, 2).events, [turnResumed])
  })

  it("woke is reported once per utterance, not on every transcript", () => {
    const gate = makeRouteGate(config())
    gate.filter(speechStarted, 0)
    assert.isDefined(gate.filter(interim("hey jeff lights"), 1).woke)
    assert.isUndefined(gate.filter(interim("hey jeff lights on"), 2).woke)
    assert.isUndefined(gate.filter(endOfTurn("hey jeff lights on please"), 3).woke)
  })
})

describe("RouteGate: replying", () => {
  it("replyEnded for an assistant with no follow-up length opens nothing", () => {
    const gate = makeRouteGate(config({ followUpMs: {} }))
    gate.replyEnded("jeff", 0)
    assert.isUndefined(gate.window(1))
    assert.isFalse(gate.awake(1))
  })

  it("a reply in progress keeps the window open past the follow-up length", () => {
    const gate = makeRouteGate(config())
    gate.replyStarted("jeff", 0)
    assert.deepStrictEqual(gate.window(60_000), { assistant: "jeff", by: "follow-up" })
    gate.replyEnded("jeff", 60_000)
    assert.deepStrictEqual(gate.window(60_000 + 4_999), { assistant: "jeff", by: "follow-up" })
    assert.isUndefined(gate.window(60_000 + 5_000))
  })

  it("replyEnded of an assistant that is not the one replying leaves the reply in progress", () => {
    const gate = makeRouteGate(config())
    gate.replyStarted("jeff", 0)
    gate.replyEnded("t3", 1)
    // jeff is still speaking, so its window stays open regardless of time.
    assert.deepStrictEqual(gate.window(1_000_000), { assistant: "jeff", by: "follow-up" })
  })
})
