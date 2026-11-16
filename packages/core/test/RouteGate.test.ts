import { assert, describe, it } from "@effect/vitest"
import { routeConfigFrom, WAKE_ARMED_MS } from "@pva/protocol"
import type { SttEvent } from "../src/Domain.ts"
import { makeRouteGate, type RouteConfig, routeConfigFromWake, type RouteGate } from "../src/RouteGate.ts"
import type { WakeConfig } from "../src/WakeGate.ts"
import { eagerEndOfTurn, endOfTurn, interim, speechStarted, turnResumed } from "../src/testing.ts"

// ---------------------------------------------------------------------------
// WakeGate's tests, ported: one assistant ("jeff") configured the old way (`routeConfigFromWake`).

const PHRASES = ["hey jeff", "hey jev", "hey geoff"]
const wakeOf = (over: Partial<WakeConfig> = {}): WakeConfig => ({
  activation: "wake-phrase",
  phrases: PHRASES,
  match: "close",
  followUpMs: 8_000,
  ...over
})
const wake = (over: Partial<WakeConfig> = {}): RouteConfig => routeConfigFromWake(wakeOf(over), "jeff")

/** Feed events at `t`, `t+1`, …; returns everything forwarded. */
const feed = (gate: RouteGate, events: ReadonlyArray<SttEvent>, t = 0): Array<SttEvent> =>
  events.flatMap((e, i) => [...gate.filter(e, t + i).events])

const JEFF_PHRASE = { assistant: "jeff", by: "phrase", phrase: "hey jeff" } as const

describe("RouteGate (one assistant): always → withoutPhrase assistant", () => {
  it("passes events without a phrase unchanged, by identity, tagged with the default assistant", () => {
    const gate = makeRouteGate(wake({ activation: "always" }))
    const events = [speechStarted, interim("turn the lights"), eagerEndOfTurn("turn the lights"), turnResumed, endOfTurn("turn the lights on")]
    events.forEach((e, i) => {
      const r = gate.filter(e, i)
      assert.strictEqual(r.events.length, 1)
      assert.strictEqual(r.events[0], e)
      assert.deepStrictEqual(r.target, { assistant: "jeff", by: "default" })
    })
    assert.isTrue(gate.awake(0))
  })

  it("CHANGED: a leading phrase is removed in this mode too (WakeGate's always passed it on)", () => {
    const gate = makeRouteGate(wake({ activation: "always" }))
    const out = feed(gate, [speechStarted, interim("hey jeff lights"), eagerEndOfTurn("hey jeff lights"), turnResumed, endOfTurn("hey jeff lights on")])
    assert.deepStrictEqual(out, [speechStarted, interim("lights"), eagerEndOfTurn("lights"), turnResumed, endOfTurn("lights on")])
  })

  it("reports what it heard for the tester (CHANGED: and reports the phrase as woke)", () => {
    const gate = makeRouteGate(wake({ activation: "always" }))
    gate.filter(speechStarted, 0)
    const r = gate.filter(endOfTurn("Hey Jeff, lights"), 1)
    assert.deepStrictEqual(r.events, [endOfTurn("lights")])
    assert.deepStrictEqual(r.heard, { text: "Hey Jeff, lights", phrase: "hey jeff", assistant: "jeff", accepted: true })
    assert.deepStrictEqual(r.woke, { phrase: "hey jeff", assistant: "jeff", armed: false })
    assert.deepStrictEqual(r.target, JEFF_PHRASE)
  })

  it("CHANGED: the phrase alone closes the utterance with \"\" and arms (WakeGate's always forwarded it)", () => {
    const gate = makeRouteGate(wake({ activation: "always" }))
    const out = feed(gate, [speechStarted, interim("hey jeff"), endOfTurn("Hey Jeff.")])
    assert.deepStrictEqual(out, [speechStarted, endOfTurn("")])
    assert.deepStrictEqual(gate.window(5), { assistant: "jeff", by: "armed" })
  })
})

describe("RouteGate (one assistant): heard.accepted (the phrase tester's three outcomes)", () => {
  const heardOf = (gate: RouteGate, text: string, t: number) => {
    gate.filter(speechStarted, t)
    return gate.filter(endOfTurn(text), t + 1).heard
  }

  it("always: every line is accepted, with or without a phrase", () => {
    const gate = makeRouteGate(wake({ activation: "always" }))
    assert.deepStrictEqual(heardOf(gate, "What time is it?", 0), { text: "What time is it?", accepted: true })
    assert.deepStrictEqual(heardOf(gate, "Hey Jeff, lights", 10), { text: "Hey Jeff, lights", phrase: "hey jeff", assistant: "jeff", accepted: true })
  })

  it("wake phrase, asleep: a line without a phrase is ignored, the phrase alone is accepted (armed)", () => {
    const gate = makeRouteGate(wake())
    assert.deepStrictEqual(heardOf(gate, "So what did he say?", 0), { text: "So what did he say?", accepted: false })
    assert.deepStrictEqual(heardOf(gate, "Hey Jeff.", 10), { text: "Hey Jeff.", phrase: "hey jeff", assistant: "jeff", accepted: true })
  })

  it("wake phrase, armed window: the next line is accepted without a phrase", () => {
    const gate = makeRouteGate(wake({ followUpMs: 0 }))
    heardOf(gate, "Hey Jeff.", 0)
    assert.deepStrictEqual(heardOf(gate, "what time is it", 100), { text: "what time is it", accepted: true })
    assert.deepStrictEqual(heardOf(gate, "and tomorrow", 200), { text: "and tomorrow", accepted: false })
  })

  it("wake phrase, follow-up window after a reply: accepted without a phrase; after it closes, ignored", () => {
    const gate = makeRouteGate(wake({ followUpMs: 5_000 }))
    gate.replyStarted("jeff", 0)
    gate.replyEnded("jeff", 1_000)
    assert.deepStrictEqual(heardOf(gate, "and tomorrow?", 2_000), { text: "and tomorrow?", accepted: true })
    assert.deepStrictEqual(heardOf(gate, "never mind", 20_000), { text: "never mind", accepted: false })
  })
})

describe("RouteGate (one assistant): asleep", () => {
  it("an utterance without the phrase is dropped whole", () => {
    const gate = makeRouteGate(wake())
    assert.isFalse(gate.awake(0))
    assert.deepStrictEqual(gate.filter(speechStarted, 0), { events: [] })
    assert.deepStrictEqual(gate.filter(interim("so what did"), 1), { events: [] })
    assert.deepStrictEqual(gate.filter(eagerEndOfTurn("so what did he say"), 2), { events: [] })
    assert.deepStrictEqual(gate.filter(turnResumed, 3), { events: [] })
    assert.deepStrictEqual(gate.filter(endOfTurn("So what did he say then?"), 4), {
      events: [],
      target: { by: "dropped", reason: "asleep" },
      dropped: { text: "So what did he say then?" },
      heard: { text: "So what did he say then?", accepted: false }
    })
    gate.filter(speechStarted, 5)
    assert.deepStrictEqual(gate.filter(endOfTurn(""), 6), { events: [] })
  })

  it("a match releases the held SpeechStarted, then the event with the phrase removed", () => {
    const gate = makeRouteGate(wake())
    gate.filter(speechStarted, 0)
    const r = gate.filter(endOfTurn("Hey Jeff, what time is it?"), 1)
    assert.deepStrictEqual(r.events, [speechStarted, endOfTurn("what time is it?")])
    assert.deepStrictEqual(r.woke, { phrase: "hey jeff", assistant: "jeff", armed: false })
    assert.deepStrictEqual(r.heard, { text: "Hey Jeff, what time is it?", phrase: "hey jeff", assistant: "jeff", accepted: true })
    assert.deepStrictEqual(r.target, JEFF_PHRASE)
  })

  it("cumulative transcripts of one utterance: released on the first match, stripped each time, unchanged when no longer matching", () => {
    const gate = makeRouteGate(wake())
    assert.deepStrictEqual(feed(gate, [speechStarted, interim("hey"), interim("hey jeff")]), [])
    const released = gate.filter(interim("hey jeff turn"), 3)
    assert.deepStrictEqual(released.events, [speechStarted, interim("turn")])
    assert.deepStrictEqual(released.woke, { phrase: "hey jeff", assistant: "jeff", armed: false })
    const next = gate.filter(eagerEndOfTurn("hey jeff turn the lights on"), 4)
    assert.deepStrictEqual(next.events, [eagerEndOfTurn("turn the lights on")])
    assert.isUndefined(next.woke)
    assert.deepStrictEqual(gate.filter(turnResumed, 5).events, [turnResumed])
    // The recogniser revised the start: forwarded unchanged, still to the assistant the phrase picked.
    const revised = gate.filter(endOfTurn("A chef turn the lights on"), 6)
    assert.deepStrictEqual(revised.events, [endOfTurn("A chef turn the lights on")])
    assert.deepStrictEqual(revised.target, JEFF_PHRASE)
  })

  it("the phrase alone: nothing forwarded, the armed window opens, the next utterance needs no phrase", () => {
    const gate = makeRouteGate(wake({ followUpMs: 0 }))
    gate.filter(speechStarted, 0)
    assert.deepStrictEqual(gate.filter(interim("hey jeff"), 1), { events: [] })
    const r = gate.filter(endOfTurn("Hey Jeff."), 1_000)
    assert.deepStrictEqual(r.events, [])
    assert.deepStrictEqual(r.woke, { phrase: "hey jeff", assistant: "jeff", armed: true })
    assert.isTrue(gate.awake(1_000 + WAKE_ARMED_MS - 1))
    assert.isFalse(gate.awake(1_000 + WAKE_ARMED_MS))
    const start = gate.filter(speechStarted, 3_000)
    assert.deepStrictEqual(start, { events: [speechStarted], target: { assistant: "jeff", by: "armed" } })
    assert.deepStrictEqual(gate.filter(endOfTurn("what time is it"), 3_001).events, [endOfTurn("what time is it")])
    assert.isFalse(gate.awake(3_002))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("and tomorrow")], 3_005), [])
  })

  it("an utterance starting after the armed window is asleep again", () => {
    const gate = makeRouteGate(wake({ armedMs: 1_000 }))
    feed(gate, [speechStarted, endOfTurn("hey jeff")], 0)
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")], 1_001), [])
  })

  it("an eager transcript that is only the phrase stays held (the sentence may go on)", () => {
    const gate = makeRouteGate(wake())
    gate.filter(speechStarted, 0)
    assert.deepStrictEqual(gate.filter(eagerEndOfTurn("hey jeff"), 1), { events: [] })
    assert.deepStrictEqual(gate.filter(turnResumed, 2), { events: [] })
    assert.deepStrictEqual(gate.filter(endOfTurn("hey jeff lights off"), 3).events, [speechStarted, endOfTurn("lights off")])
  })

  it("a TurnResumed after a held eager transcript is swallowed; a match afterwards still releases", () => {
    const gate = makeRouteGate(wake())
    assert.deepStrictEqual(feed(gate, [speechStarted, eagerEndOfTurn("hey"), turnResumed]), [])
    assert.deepStrictEqual(feed(gate, [eagerEndOfTurn("hey jeff lights")], 3), [speechStarted, eagerEndOfTurn("lights")])
    assert.deepStrictEqual(feed(gate, [turnResumed, endOfTurn("hey jeff lights off")], 4), [turnResumed, endOfTurn("lights off")])
  })
})

describe("RouteGate (one assistant): awake", () => {
  it("follow-up window: after a reply ends, utterances pass without the phrase until it closes", () => {
    const gate = makeRouteGate(wake({ followUpMs: 5_000 }))
    gate.replyStarted("jeff", 0)
    gate.replyEnded("jeff", 1_000)
    assert.isTrue(gate.awake(5_999))
    assert.isFalse(gate.awake(6_000))
    assert.deepStrictEqual(gate.filter(speechStarted, 2_000).target, { assistant: "jeff", by: "follow-up" })
    assert.deepStrictEqual(gate.filter(endOfTurn("and tomorrow?"), 2_001).events, [endOfTurn("and tomorrow?")])
    assert.isTrue(gate.awake(2_001 + 4_999))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("no")], 6_999), [speechStarted, endOfTurn("no")])
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")], 13_000), [])
  })

  it("a leading wake phrase is still removed while awake", () => {
    const gate = makeRouteGate(wake())
    gate.replyEnded("jeff", 0)
    const out = feed(gate, [speechStarted, interim("hey jeff and"), endOfTurn("Hey Jeff, and tomorrow?")], 10)
    assert.deepStrictEqual(out, [speechStarted, interim("and"), endOfTurn("and tomorrow?")])
  })

  it("an awake utterance that is only the phrase: empty partials are not forwarded, its end closes it and arms", () => {
    const gate = makeRouteGate(wake())
    gate.replyEnded("jeff", 0)
    const out: Array<SttEvent> = []
    out.push(...gate.filter(speechStarted, 10).events)
    out.push(...gate.filter(interim("hey jeff"), 11).events)
    out.push(...gate.filter(eagerEndOfTurn("hey jeff"), 12).events)
    out.push(...gate.filter(turnResumed, 13).events)
    const end = gate.filter(endOfTurn("hey jeff"), 20_000)
    out.push(...end.events)
    assert.deepStrictEqual(out, [speechStarted, endOfTurn("")])
    assert.deepStrictEqual(end.woke, { phrase: "hey jeff", assistant: "jeff", armed: true })
    assert.isTrue(gate.awake(20_001))
  })

  it("an utterance that starts awake is accepted to its end even if the window closes meanwhile", () => {
    const gate = makeRouteGate(wake({ followUpMs: 1_000 }))
    gate.replyEnded("jeff", 0)
    gate.filter(speechStarted, 999)
    assert.isFalse(gate.awake(5_000))
    assert.deepStrictEqual(gate.filter(interim("and the"), 5_000).events, [interim("and the")])
    assert.deepStrictEqual(gate.filter(endOfTurn("and the weather"), 6_000).events, [endOfTurn("and the weather")])
  })

  it("during a reply: awake when follow-up is above zero, else barge-in needs the phrase", () => {
    const withFollowUp = makeRouteGate(wake({ followUpMs: 3_000 }))
    withFollowUp.replyStarted("jeff", 0)
    assert.isTrue(withFollowUp.awake(60_000))
    assert.deepStrictEqual(withFollowUp.filter(speechStarted, 60_000).events, [speechStarted])

    const zero = makeRouteGate(wake({ followUpMs: 0 }))
    zero.replyStarted("jeff", 0)
    assert.isFalse(zero.awake(1))
    assert.deepStrictEqual(feed(zero, [speechStarted, interim("stop")], 1), [])
    assert.deepStrictEqual(zero.filter(interim("hey jeff stop"), 3).events, [speechStarted, interim("stop")])
  })

  it("follow-up 0: asleep again right after the reply", () => {
    const gate = makeRouteGate(wake({ followUpMs: 0 }))
    gate.replyStarted("jeff", 0)
    gate.replyEnded("jeff", 100)
    assert.isFalse(gate.awake(100))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("and tomorrow")], 101), [])
  })
})

describe("RouteGate (one assistant): configure", () => {
  it("is live: always → wake-phrase and back", () => {
    const gate = makeRouteGate(wake({ activation: "always", followUpMs: 0 }))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")]), [speechStarted, endOfTurn("lights")])
    gate.configure(wake({ followUpMs: 0 }))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")], 10), [])
    gate.configure(wake({ activation: "always" }))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")], 20), [speechStarted, endOfTurn("lights")])
  })

  it("discards a held utterance: its tail is dropped even after a switch to always", () => {
    const gate = makeRouteGate(wake())
    feed(gate, [speechStarted, interim("so")])
    gate.configure(wake({ activation: "always" }))
    assert.deepStrictEqual(feed(gate, [interim("so then"), endOfTurn("so then")], 2), [])
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("next")], 10), [speechStarted, endOfTurn("next")])
  })

  it("an accepted utterance stays accepted across configure", () => {
    const gate = makeRouteGate(wake({ activation: "always" }))
    gate.filter(speechStarted, 0)
    gate.configure(wake())
    assert.deepStrictEqual(feed(gate, [interim("lights"), endOfTurn("lights on")], 1), [interim("lights"), endOfTurn("lights on")])
  })

  it("keeps an open window only while it is still open under the new lengths", () => {
    const gate = makeRouteGate(wake({ followUpMs: 10_000 }))
    gate.replyEnded("jeff", 0)
    gate.configure(wake({ followUpMs: 5_000 }))
    assert.isTrue(gate.awake(4_999))
    assert.isFalse(gate.awake(5_000))
    gate.configure(wake({ followUpMs: 0 }))
    assert.isFalse(gate.awake(1))
    const armed = makeRouteGate(wake())
    feed(armed, [speechStarted, endOfTurn("hey jeff")], 0)
    armed.configure(wake({ armedMs: 2_000 }))
    assert.isTrue(armed.awake(2_000))
    assert.isFalse(armed.awake(2_001))
  })

  it("routeConfigFromWake maps a WakeGate config", () => {
    assert.deepStrictEqual(routeConfigFromWake(wakeOf({ followUpMs: 3_000, armedMs: 500 }), "jeff"), {
      phrases: PHRASES.map((phrase) => ({ phrase, assistant: "jeff" })),
      match: "close",
      withoutPhrase: "nobody",
      defaultAssistant: "jeff",
      followUpMs: { jeff: 3_000 },
      off: new Set<string>(),
      armedMs: 500
    })
    assert.strictEqual(routeConfigFromWake(wakeOf({ activation: "always" }), "jeff").withoutPhrase, "assistant")
  })
})

// ---------------------------------------------------------------------------
// Several assistants.

const two = (over: Partial<RouteConfig> = {}): RouteConfig => ({
  phrases: [
    { phrase: "hey jeff", assistant: "jeff" },
    { phrase: "hey jev", assistant: "jeff" },
    { phrase: "hey tee three", assistant: "t3" },
    { phrase: "hey keuken", assistant: "keuken" }
  ],
  match: "close",
  withoutPhrase: "nobody",
  followUpMs: { jeff: 5_000, t3: 5_000, keuken: 5_000 },
  off: new Set(),
  ...over
})

describe("RouteGate: two assistants reached by phrase", () => {
  it("asleep: each phrase releases the utterance to its own assistant, phrase removed", () => {
    const gate = makeRouteGate(two())
    gate.filter(speechStarted, 0)
    const a = gate.filter(endOfTurn("Hey Jeff, what time is it?"), 1)
    assert.deepStrictEqual(a.events, [speechStarted, endOfTurn("what time is it?")])
    assert.deepStrictEqual(a.target, JEFF_PHRASE)
    assert.deepStrictEqual(a.woke, { phrase: "hey jeff", assistant: "jeff", armed: false })

    gate.filter(speechStarted, 10_000)
    const b = gate.filter(endOfTurn("hey tee three, open the pull request"), 10_001)
    assert.deepStrictEqual(b.events, [speechStarted, endOfTurn("open the pull request")])
    assert.deepStrictEqual(b.target, { assistant: "t3", by: "phrase", phrase: "hey tee three" })
    assert.deepStrictEqual(b.heard, { text: "hey tee three, open the pull request", phrase: "hey tee three", assistant: "t3", accepted: true })
  })

  it("with a default assistant: a phrase picks another assistant for that sentence; the tentative target follows the text", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "assistant", defaultAssistant: "jeff", followUpMs: {} }))
    const start = gate.filter(speechStarted, 0)
    assert.deepStrictEqual(start, { events: [speechStarted], target: { assistant: "jeff", by: "default" } })
    const i = gate.filter(interim("hey tee three open"), 1)
    assert.deepStrictEqual(i.events, [interim("open")])
    assert.deepStrictEqual(i.target, { assistant: "t3", by: "phrase", phrase: "hey tee three" })
    const end = gate.filter(endOfTurn("hey tee three open it"), 2)
    assert.deepStrictEqual(end.events, [endOfTurn("open it")])
    assert.deepStrictEqual(end.target, { assistant: "t3", by: "phrase", phrase: "hey tee three" })
    // No phrase: the default again.
    assert.deepStrictEqual(feed(gate, [speechStarted], 10), [speechStarted])
    assert.deepStrictEqual(gate.filter(endOfTurn("lights"), 11).target, { assistant: "jeff", by: "default" })
  })

  it("decide mode: a phrase still wins over the decision", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "decide", fallback: "jeff" }))
    assert.deepStrictEqual(gate.filter(speechStarted, 0).target, { by: "decide", fallback: "jeff" })
    const r = gate.filter(endOfTurn("hey keuken timer ten minutes"), 1)
    assert.deepStrictEqual(r.events, [endOfTurn("timer ten minutes")])
    assert.deepStrictEqual(r.target, { assistant: "keuken", by: "phrase", phrase: "hey keuken" })
  })
})

describe("RouteGate: follow-up goes to the assistant that replied", () => {
  it("after t3 replies, a sentence without a phrase goes to t3, not to the default", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "assistant", defaultAssistant: "jeff" }))
    gate.replyStarted("t3", 0)
    assert.deepStrictEqual(gate.window(500), { assistant: "t3", by: "follow-up" })
    gate.replyEnded("t3", 1_000)
    const r = gate.filter(speechStarted, 2_000)
    assert.deepStrictEqual(r.target, { assistant: "t3", by: "follow-up" })
    assert.deepStrictEqual(gate.filter(endOfTurn("and merge it"), 2_001).target, { assistant: "t3", by: "follow-up" })
    // After the window (restarted by that sentence): the default.
    assert.deepStrictEqual(gate.filter(speechStarted, 7_002).target, { assistant: "jeff", by: "default" })
  })

  it("in nobody mode, the window admits t3 only; another assistant still needs its phrase", () => {
    const gate = makeRouteGate(two())
    gate.replyEnded("t3", 0)
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("and merge it")], 100), [speechStarted, endOfTurn("and merge it")])
    gate.filter(speechStarted, 200)
    const r = gate.filter(endOfTurn("hey jeff lights"), 201)
    assert.deepStrictEqual(r.events, [endOfTurn("lights")])
    assert.deepStrictEqual(r.target, JEFF_PHRASE)
    // jeff was answered last: the follow-up window is now jeff's.
    assert.deepStrictEqual(gate.window(300), { assistant: "jeff", by: "follow-up" })
  })

  it("the follow-up length is per assistant", () => {
    const gate = makeRouteGate(two({ followUpMs: { jeff: 0, t3: 5_000 } }))
    gate.replyEnded("jeff", 0)
    assert.isFalse(gate.awake(1))
    gate.replyEnded("t3", 10)
    assert.isTrue(gate.awake(11))
  })

  it("a reply starting for another assistant closes the earlier follow-up window", () => {
    const gate = makeRouteGate(two({ followUpMs: { jeff: 5_000, t3: 0 } }))
    gate.replyEnded("jeff", 0)
    gate.replyStarted("t3", 100)
    assert.isUndefined(gate.window(200))
  })
})

describe("RouteGate: armed by the phrase alone", () => {
  it("\"hey tee three\" alone arms t3; the next sentence goes to t3 even with jeff as the default", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "assistant", defaultAssistant: "jeff", followUpMs: {} }))
    const out = feed(gate, [speechStarted, interim("hey tee three"), endOfTurn("Hey tee three.")])
    assert.deepStrictEqual(out, [speechStarted, endOfTurn("")])
    assert.deepStrictEqual(gate.window(10), { assistant: "t3", by: "armed" })
    assert.deepStrictEqual(gate.filter(speechStarted, 100).target, { assistant: "t3", by: "armed" })
    assert.deepStrictEqual(gate.filter(endOfTurn("open the pull request"), 101).target, { assistant: "t3", by: "armed" })
    // One utterance only.
    assert.deepStrictEqual(gate.filter(speechStarted, 200).target, { assistant: "jeff", by: "default" })
  })

  it("asleep: the phrase alone forwards nothing and reports the assistant it armed", () => {
    const gate = makeRouteGate(two())
    gate.filter(speechStarted, 0)
    const r = gate.filter(endOfTurn("hey keuken"), 1)
    assert.deepStrictEqual(r, {
      events: [],
      target: { assistant: "keuken", by: "phrase", phrase: "hey keuken" },
      woke: { phrase: "hey keuken", assistant: "keuken", armed: true },
      heard: { text: "hey keuken", phrase: "hey keuken", assistant: "keuken", accepted: true }
    })
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("ten minutes")], 1_000), [speechStarted, endOfTurn("ten minutes")])
  })

  it("an armed assistant removed from the device by configure does not answer the next sentence", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "assistant", defaultAssistant: "jeff" }))
    feed(gate, [speechStarted, endOfTurn("hey tee three")], 0)
    assert.deepStrictEqual(gate.window(10), { assistant: "t3", by: "armed" })
    const withoutT3 = two({ withoutPhrase: "assistant", defaultAssistant: "jeff" })
    gate.configure({
      ...withoutT3,
      phrases: withoutT3.phrases.filter((p) => p.assistant !== "t3"),
      followUpMs: { jeff: 5_000, keuken: 5_000 }
    })
    assert.isUndefined(gate.window(20))
    assert.deepStrictEqual(gate.filter(speechStarted, 100).target, { assistant: "jeff", by: "default" })
  })

  it("an armed window survives configure while its assistant is still on the device", () => {
    const gate = makeRouteGate(two())
    feed(gate, [speechStarted, endOfTurn("hey tee three")], 0)
    gate.configure(two({ match: "exact" }))
    assert.deepStrictEqual(gate.filter(speechStarted, 100).target, { assistant: "t3", by: "armed" })
  })

  it("an armed window beats an open follow-up window of another assistant", () => {
    const gate = makeRouteGate(two())
    gate.replyEnded("jeff", 0)
    feed(gate, [speechStarted, endOfTurn("hey tee three")], 10)
    assert.deepStrictEqual(gate.filter(speechStarted, 100).target, { assistant: "t3", by: "armed" })
  })
})

describe("RouteGate: a switched-off assistant", () => {
  const off = (over: Partial<RouteConfig> = {}) => two({ off: new Set(["t3"]), ...over })

  it("asleep: its phrase drops the utterance; it never releases, and never arms", () => {
    const gate = makeRouteGate(off())
    assert.deepStrictEqual(feed(gate, [speechStarted, interim("hey tee three open"), eagerEndOfTurn("hey tee three open it")]), [])
    const r = gate.filter(endOfTurn("hey tee three open it"), 3)
    assert.deepStrictEqual(r, {
      events: [],
      target: { by: "dropped", reason: "off", assistant: "t3" },
      dropped: { text: "hey tee three open it" },
      heard: { text: "hey tee three open it", phrase: "hey tee three", assistant: "t3", accepted: false }
    })
    feed(gate, [speechStarted, endOfTurn("hey tee three")], 10)
    assert.isFalse(gate.awake(20))
  })

  it("with a default assistant: its phrase does not fall through to the default; the utterance closes empty", () => {
    const gate = makeRouteGate(off({ withoutPhrase: "assistant", defaultAssistant: "jeff" }))
    const out: Array<SttEvent> = []
    out.push(...gate.filter(speechStarted, 0).events)
    const i = gate.filter(interim("hey tee three open"), 1)
    assert.deepStrictEqual(i, { events: [], target: { by: "dropped", reason: "off", assistant: "t3" } })
    out.push(...gate.filter(eagerEndOfTurn("hey tee three open it"), 2).events)
    out.push(...gate.filter(turnResumed, 3).events)
    const end = gate.filter(endOfTurn("hey tee three open it"), 4)
    out.push(...end.events)
    assert.deepStrictEqual(out, [speechStarted, endOfTurn("")])
    assert.deepStrictEqual(end.target, { by: "dropped", reason: "off", assistant: "t3" })
    assert.isFalse(end.heard!.accepted)
    // Nothing opened a window for anyone.
    assert.isUndefined(gate.window(10))
  })

  it("an off default assistant means nobody answers without a phrase; another assistant's phrase still works", () => {
    const gate = makeRouteGate(off({ withoutPhrase: "assistant", defaultAssistant: "t3" }))
    assert.isFalse(gate.awake(0))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")]), [])
    gate.filter(speechStarted, 10)
    assert.deepStrictEqual(gate.filter(endOfTurn("lights"), 11).target, { by: "dropped", reason: "off", assistant: "t3" })
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("hey jeff lights")], 20), [speechStarted, endOfTurn("lights")])
  })

  it("its open follow-up window drops sentences without a phrase", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "assistant", defaultAssistant: "jeff" }))
    gate.replyEnded("t3", 0)
    gate.configure(off({ withoutPhrase: "assistant", defaultAssistant: "jeff" }))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("and merge it")], 100), [])
  })

  it("switched off during an accepted utterance: the rest is not forwarded, the utterance closes empty", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "assistant", defaultAssistant: "t3" }))
    assert.deepStrictEqual(feed(gate, [speechStarted, interim("open")]), [speechStarted, interim("open")])
    gate.configure(off({ withoutPhrase: "assistant", defaultAssistant: "t3" }))
    assert.deepStrictEqual(feed(gate, [interim("open the"), endOfTurn("open the pull request")], 2), [endOfTurn("")])
  })
})

describe("RouteGate: decide (TypeSafe)", () => {
  it("an utterance without a phrase or window is accepted with a pending decision and the fallback", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "decide", fallback: "jeff" }))
    assert.isTrue(gate.awake(0))
    const out = [speechStarted, interim("timer"), eagerEndOfTurn("timer ten minutes"), endOfTurn("timer ten minutes")].map((e, i) => gate.filter(e, i))
    for (const r of out) assert.deepStrictEqual(r.target, { by: "decide", fallback: "jeff" })
    assert.deepStrictEqual(out.flatMap((r) => r.events), [speechStarted, interim("timer"), eagerEndOfTurn("timer ten minutes"), endOfTurn("timer ten minutes")])
    // The gate does not learn the decision: no follow-up window until a reply ends.
    assert.isUndefined(gate.window(10))
  })

  it("no fallback, or an off fallback, is null", () => {
    assert.deepStrictEqual(makeRouteGate(two({ withoutPhrase: "decide" })).filter(speechStarted, 0).target, { by: "decide", fallback: null })
    assert.deepStrictEqual(
      makeRouteGate(two({ withoutPhrase: "decide", fallback: "t3", off: new Set(["t3"]) })).filter(speechStarted, 0).target,
      { by: "decide", fallback: null }
    )
  })

  it("an open window wins over the decision", () => {
    const gate = makeRouteGate(two({ withoutPhrase: "decide", fallback: "jeff" }))
    gate.replyEnded("keuken", 0)
    assert.deepStrictEqual(gate.filter(speechStarted, 100).target, { assistant: "keuken", by: "follow-up" })
  })
})

// ---------------------------------------------------------------------------
// The utterance contract as a property (ported from WakeGate, with several assistants, modes and an off set).

const rng = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff
  return seed / 0x8000_0000
}

const TEXTS = [
  "hey jeff",
  "Hey Jeff, what time is it?",
  "hey geoff lights",
  "ok hey jev",
  "so what",
  "what time",
  "hey",
  "hey jeffs turn it off",
  "the weather",
  "uh um well hey jeff no",
  "hey tee three",
  "hey tee three merge it",
  "hey keuken timer"
]

describe("RouteGate: the utterance contract (property)", () => {
  it("every forwarded utterance is SpeechStarted … exactly one EndOfTurn; a dropped utterance forwards nothing", () => {
    let forwarded = 0
    let dropped = 0
    const assistants = ["jeff", "t3", "keuken"]
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed)
      const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(r() * xs.length)]!
      const configs: Array<RouteConfig> = [
        wake(),
        wake({ followUpMs: 0 }),
        wake({ activation: "always" }),
        wake({ match: "exact", armedMs: 500 }),
        wake({ followUpMs: 1_500 }),
        two(),
        two({ withoutPhrase: "assistant", defaultAssistant: "jeff", off: new Set(["t3"]) }),
        two({ withoutPhrase: "decide", fallback: "t3", followUpMs: { jeff: 0, t3: 2_000 } }),
        two({ withoutPhrase: "assistant", defaultAssistant: "keuken", off: new Set(["keuken"]) })
      ]
      const gate = makeRouteGate(pick(configs))
      let now = 0
      const step = () => (now += Math.floor(r() * 2_000))
      for (let u = 0; u < 12; u++) {
        if (r() < 0.3) gate.replyStarted(pick(assistants), step())
        if (r() < 0.3) gate.replyEnded(pick(assistants), step())
        const input: Array<SttEvent> = [speechStarted]
        const parts = Math.floor(r() * 5)
        let eagerOpen = false
        for (let p = 0; p < parts; p++) {
          const x = r()
          if (x < 0.5) input.push(interim(pick(TEXTS)))
          else if (x < 0.8) {
            input.push(eagerEndOfTurn(pick(TEXTS)))
            eagerOpen = true
          } else if (eagerOpen) {
            input.push(turnResumed)
            eagerOpen = false
          }
        }
        input.push(endOfTurn(r() < 0.1 ? "" : pick(TEXTS)))
        const out: Array<SttEvent> = []
        for (const e of input) {
          if (r() < 0.1) gate.configure(pick(configs))
          if (r() < 0.05) gate.replyEnded(pick(assistants), now)
          const result = gate.filter(e, step())
          if (result.events.length > 0) assert.isDefined(result.target)
          out.push(...result.events)
        }
        const context = `seed ${seed}, utterance ${u}: ${JSON.stringify(input)} → ${JSON.stringify(out)}`
        if (out.length === 0) {
          dropped++
          continue
        }
        forwarded++
        assert.strictEqual(out[0]!._tag, "SpeechStarted", context)
        assert.strictEqual(out.at(-1)!._tag, "EndOfTurn", context)
        assert.strictEqual(out.filter((e) => e._tag === "EndOfTurn").length, 1, context)
        assert.strictEqual(out.filter((e) => e._tag === "SpeechStarted").length, 1, context)
        let eager = false
        for (const e of out) {
          if (e._tag === "EagerEndOfTurn") {
            assert.isTrue(e.text.trim().length > 0, context)
            eager = true
          }
          if (e._tag === "TurnResumed") {
            assert.isTrue(eager, context)
            eager = false
          }
        }
      }
    }
    assert.isAbove(forwarded, 1_000)
    assert.isAbove(dropped, 500)
  })
})

describe("the protocol's route config", () => {
  it("is accepted by the gate as it is", () => {
    const config = routeConfigFrom(
      {
        assistants: [
          { assistant: "jeff", phrases: ["hey jeff"] },
          { assistant: "t3", phrases: ["hey t3"], followUpSeconds: 20 }
        ],
        withoutPhrase: { mode: "typesafe", fallback: "jeff", giveUpMs: 400 },
        matching: "close"
      },
      [
        { id: "jeff", on: true, followUpSeconds: 8 },
        { id: "t3", on: true, followUpSeconds: 0 }
      ]
    )
    const gate = makeRouteGate(config)
    assert.deepStrictEqual(gate.config().followUpMs, { jeff: 8000, t3: 20_000 })
    assert.strictEqual(gate.config().fallback, "jeff")
  })
})
