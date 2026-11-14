import { assert, describe, it } from "@effect/vitest"
import { DEFAULT_DEVICE_PROFILE, WAKE_ARMED_MS } from "@pva/protocol"
import type { SttEvent } from "../src/Domain.ts"
import { matchWakePhrase, makeWakeGate, type WakeConfig, wakeConfigFromProfile, type WakeGate } from "../src/WakeGate.ts"
import { eagerEndOfTurn, endOfTurn, interim, speechStarted, turnResumed } from "../src/testing.ts"

const PHRASES = ["hey jeff", "hey jev", "hey geoff"]
const wake = (over: Partial<WakeConfig> = {}): WakeConfig => ({
  activation: "wake-phrase",
  phrases: PHRASES,
  match: "close",
  followUpMs: 8_000,
  ...over
})

/** Feed events at `t`, `t+1`, …; returns everything forwarded. */
const feed = (gate: WakeGate, events: ReadonlyArray<SttEvent>, t = 0): Array<SttEvent> =>
  events.flatMap((e, i) => [...gate.filter(e, t + i).events])

describe("matchWakePhrase", () => {
  it("exact and close", () => {
    assert.deepStrictEqual(matchWakePhrase("hey jeff what time is it", ["hey jeff"], "exact"), { phrase: "hey jeff", rest: "what time is it" })
    assert.isUndefined(matchWakePhrase("hey jeffs what time", ["hey jeff"], "exact"))
    assert.deepStrictEqual(matchWakePhrase("hey jeffs what time", ["hey jeff"], "close"), { phrase: "hey jeff", rest: "what time" })
    assert.deepStrictEqual(matchWakePhrase("hey geff", ["hey jeff"], "close"), { phrase: "hey jeff", rest: "" })
    // Short words must be equal even when close; "go" needs its own phrase.
    assert.isUndefined(matchWakePhrase("hey go", ["hey jeff"], "close"))
    // "hay jeff" fails word by word ("hay" is short) but is caught run together (below).
    assert.isUndefined(matchWakePhrase("hay jeff", ["hey jeff"], "exact"))
    assert.deepStrictEqual(matchWakePhrase("hey go, lights on", ["hey jeff", "hey go"], "close"), { phrase: "hey go", rest: "lights on" })
    // Two edits are too many.
    assert.isUndefined(matchWakePhrase("hey jeffrey", ["hey jeff"], "close"))
  })

  it("close: the phrase run together, within one edit of the first k words run together", () => {
    // What streaming recognisers made of "Hey Jeff" (docs/FRONTENDS-AND-ACTIVATION.md, Step 3).
    assert.deepStrictEqual(matchWakePhrase("heyjeff what time is it", PHRASES, "close"), { phrase: "hey jeff", rest: "what time is it" })
    assert.deepStrictEqual(matchWakePhrase("HAY JEFF WHAT TIME IS IT", PHRASES, "close"), { phrase: "hey jeff", rest: "WHAT TIME IS IT" })
    assert.deepStrictEqual(matchWakePhrase("hay jeff", PHRASES, "close"), { phrase: "hey jeff", rest: "" })
    assert.deepStrictEqual(matchWakePhrase("Ok, heyjeff, lights", PHRASES, "close"), { phrase: "hey jeff", rest: "lights" })
    // Split into more words than the phrase has (k = words + 1).
    assert.deepStrictEqual(matchWakePhrase("he y jeff lights", PHRASES, "close"), { phrase: "hey jeff", rest: "lights" })
    // `exact` is unchanged.
    assert.isUndefined(matchWakePhrase("heyjeff what time is it", PHRASES, "exact"))
    // "hey go": "heygo" is three edits from "heyjeff". "hey chef": "heychef" is more than one edit away too.
    assert.isUndefined(matchWakePhrase("hey go", PHRASES, "close"))
    assert.isUndefined(matchWakePhrase("hey chef", PHRASES, "close"))
    // A longer, different phrase does not match.
    assert.isUndefined(matchWakePhrase("hey jeffrey what time", PHRASES, "close"))
    assert.isUndefined(matchWakePhrase("heyjefferson", PHRASES, "close"))
    // Phrases under six letters run together are only matched word by word.
    assert.isUndefined(matchWakePhrase("heygo lights", ["hey go"], "close"))
    assert.deepStrictEqual(matchWakePhrase("hey go lights", ["hey go"], "close"), { phrase: "hey go", rest: "lights" })
  })

  it("the phrase must be at the start, after at most two filler words", () => {
    assert.deepStrictEqual(matchWakePhrase("Ok, hey Jeff, lights", PHRASES, "exact"), { phrase: "hey jeff", rest: "lights" })
    assert.deepStrictEqual(matchWakePhrase("uh well hey jeff lights", PHRASES, "exact"), { phrase: "hey jeff", rest: "lights" })
    assert.isUndefined(matchWakePhrase("uh um well hey jeff lights", PHRASES, "exact"))
    assert.isUndefined(matchWakePhrase("so I said hey jeff", PHRASES, "exact"))
    assert.isUndefined(matchWakePhrase("tell hey jeff", PHRASES, "exact"))
    assert.isUndefined(matchWakePhrase("", PHRASES, "exact"))
    assert.isUndefined(matchWakePhrase("hey", PHRASES, "close"))
  })

  it("the longest matching phrase wins", () => {
    const phrases = ["hey", "hey jeff", "hey jeff please"]
    assert.deepStrictEqual(matchWakePhrase("hey jeff please stop", phrases, "exact"), { phrase: "hey jeff please", rest: "stop" })
    assert.deepStrictEqual(matchWakePhrase("hey jeff stop", phrases, "exact"), { phrase: "hey jeff", rest: "stop" })
    assert.deepStrictEqual(matchWakePhrase("hey stop", phrases, "exact"), { phrase: "hey", rest: "stop" })
    // A filler that is also the start of a phrase: the longer phrase still wins.
    assert.deepStrictEqual(matchWakePhrase("ok jeff lights", ["jeff", "ok jeff"], "exact"), { phrase: "ok jeff", rest: "lights" })
  })

  it("punctuation, diacritics and case are ignored; rest keeps its casing", () => {
    assert.deepStrictEqual(matchWakePhrase("Hey, Jeff! What's the Time?", PHRASES, "exact"), { phrase: "hey jeff", rest: "What's the Time?" })
    assert.deepStrictEqual(matchWakePhrase("HÉ JÉFF — Allume la Lumière", ["he jeff"], "exact"), { phrase: "he jeff", rest: "Allume la Lumière" })
    assert.deepStrictEqual(matchWakePhrase("hé jeff", ["He Jeff"], "exact"), { phrase: "He Jeff", rest: "" })
    assert.deepStrictEqual(matchWakePhrase("Hey Jeff... ", PHRASES, "exact"), { phrase: "hey jeff", rest: "" })
    assert.deepStrictEqual(matchWakePhrase("hey jeff's list", PHRASES, "close"), { phrase: "hey jeff", rest: "list" })
  })
})

describe("WakeGate: always", () => {
  it("passes every event unchanged, by identity", () => {
    const gate = makeWakeGate(wake({ activation: "always" }))
    const events = [speechStarted, interim("hey jeff lights"), eagerEndOfTurn("hey jeff lights"), turnResumed, endOfTurn("hey jeff lights on")]
    events.forEach((e, i) => {
      const out = gate.filter(e, i).events
      assert.strictEqual(out.length, 1)
      assert.strictEqual(out[0], e)
    })
    assert.isTrue(gate.awake(0))
  })

  it("the default gate is always", () => {
    const gate = makeWakeGate()
    assert.strictEqual(gate.config().activation, "always")
    const e = interim("anything")
    assert.strictEqual(gate.filter(e, 0).events[0], e)
  })

  it("reports what it heard for the tester, without changing anything", () => {
    const gate = makeWakeGate(wake({ activation: "always" }))
    gate.filter(speechStarted, 0)
    const e = endOfTurn("Hey Jeff, lights")
    const r = gate.filter(e, 1)
    assert.strictEqual(r.events[0], e)
    assert.deepStrictEqual(r.heard, { text: "Hey Jeff, lights", phrase: "hey jeff", accepted: true })
    assert.isUndefined(r.woke)
  })
})

describe("WakeGate: heard.accepted (the phrase tester's three outcomes)", () => {
  const heardOf = (gate: WakeGate, text: string, t: number) => {
    gate.filter(speechStarted, t)
    return gate.filter(endOfTurn(text), t + 1).heard
  }

  it("always: every line is accepted, with or without a phrase", () => {
    const gate = makeWakeGate(wake({ activation: "always" }))
    assert.deepStrictEqual(heardOf(gate, "What time is it?", 0), { text: "What time is it?", accepted: true })
    assert.deepStrictEqual(heardOf(gate, "Hey Jeff, lights", 10), { text: "Hey Jeff, lights", phrase: "hey jeff", accepted: true })
  })

  it("wake phrase, asleep: a line without a phrase is ignored, the phrase alone is accepted (armed)", () => {
    const gate = makeWakeGate(wake())
    assert.deepStrictEqual(heardOf(gate, "So what did he say?", 0), { text: "So what did he say?", accepted: false })
    assert.deepStrictEqual(heardOf(gate, "Hey Jeff.", 10), { text: "Hey Jeff.", phrase: "hey jeff", accepted: true })
  })

  it("wake phrase, armed window: the next line is accepted without a phrase", () => {
    const gate = makeWakeGate(wake({ followUpMs: 0 }))
    heardOf(gate, "Hey Jeff.", 0)
    assert.deepStrictEqual(heardOf(gate, "what time is it", 100), { text: "what time is it", accepted: true })
    // The window admitted one utterance: the next is ignored again.
    assert.deepStrictEqual(heardOf(gate, "and tomorrow", 200), { text: "and tomorrow", accepted: false })
  })

  it("wake phrase, follow-up window after a reply: accepted without a phrase; after it closes, ignored", () => {
    const gate = makeWakeGate(wake({ followUpMs: 5_000 }))
    gate.replyStarted(0)
    gate.replyEnded(1_000)
    assert.deepStrictEqual(heardOf(gate, "and tomorrow?", 2_000), { text: "and tomorrow?", accepted: true })
    assert.deepStrictEqual(heardOf(gate, "never mind", 20_000), { text: "never mind", accepted: false })
  })
})

describe("WakeGate: asleep", () => {
  it("an utterance without the phrase is dropped whole", () => {
    const gate = makeWakeGate(wake())
    assert.isFalse(gate.awake(0))
    assert.deepStrictEqual(gate.filter(speechStarted, 0), { events: [] })
    assert.deepStrictEqual(gate.filter(interim("so what did"), 1), { events: [] })
    assert.deepStrictEqual(gate.filter(eagerEndOfTurn("so what did he say"), 2), { events: [] })
    assert.deepStrictEqual(gate.filter(turnResumed, 3), { events: [] })
    assert.deepStrictEqual(gate.filter(endOfTurn("So what did he say then?"), 4), {
      events: [],
      dropped: { text: "So what did he say then?" },
      heard: { text: "So what did he say then?", accepted: false }
    })
    // An empty end of turn ends a held utterance silently.
    gate.filter(speechStarted, 5)
    assert.deepStrictEqual(gate.filter(endOfTurn(""), 6), { events: [] })
  })

  it("a match releases the held SpeechStarted, then the event with the phrase removed", () => {
    const gate = makeWakeGate(wake())
    gate.filter(speechStarted, 0)
    const r = gate.filter(endOfTurn("Hey Jeff, what time is it?"), 1)
    assert.deepStrictEqual(r.events, [speechStarted, endOfTurn("what time is it?")])
    assert.deepStrictEqual(r.woke, { phrase: "hey jeff", armed: false })
    assert.deepStrictEqual(r.heard, { text: "Hey Jeff, what time is it?", phrase: "hey jeff", accepted: true })
  })

  it("cumulative transcripts of one utterance: released on the first match, stripped each time, unchanged when no longer matching", () => {
    const gate = makeWakeGate(wake())
    assert.deepStrictEqual(feed(gate, [speechStarted, interim("hey"), interim("hey jeff")]), [])
    const released = gate.filter(interim("hey jeff turn"), 3)
    assert.deepStrictEqual(released.events, [speechStarted, interim("turn")])
    assert.deepStrictEqual(released.woke, { phrase: "hey jeff", armed: false })
    const next = gate.filter(eagerEndOfTurn("hey jeff turn the lights on"), 4)
    assert.deepStrictEqual(next.events, [eagerEndOfTurn("turn the lights on")])
    assert.isUndefined(next.woke) // reported once per utterance
    assert.deepStrictEqual(gate.filter(turnResumed, 5).events, [turnResumed])
    // The recogniser revised the start: forwarded unchanged rather than dropped.
    assert.deepStrictEqual(gate.filter(endOfTurn("A chef turn the lights on"), 6).events, [endOfTurn("A chef turn the lights on")])
  })

  it("the phrase alone: nothing forwarded, the armed window opens, the next utterance needs no phrase", () => {
    const gate = makeWakeGate(wake({ followUpMs: 0 }))
    gate.filter(speechStarted, 0)
    assert.deepStrictEqual(gate.filter(interim("hey jeff"), 1), { events: [] })
    const r = gate.filter(endOfTurn("Hey Jeff."), 1_000)
    assert.deepStrictEqual(r.events, [])
    assert.deepStrictEqual(r.woke, { phrase: "hey jeff", armed: true })
    assert.isTrue(gate.awake(1_000 + WAKE_ARMED_MS - 1))
    assert.isFalse(gate.awake(1_000 + WAKE_ARMED_MS))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("what time is it")], 3_000), [speechStarted, endOfTurn("what time is it")])
    // The armed window admits one utterance.
    assert.isFalse(gate.awake(3_002))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("and tomorrow")], 3_005), [])
  })

  it("an utterance starting after the armed window is asleep again", () => {
    const gate = makeWakeGate(wake({ armedMs: 1_000 }))
    feed(gate, [speechStarted, endOfTurn("hey jeff")], 0)
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")], 1_001), [])
  })

  it("an eager transcript that is only the phrase stays held (the sentence may go on)", () => {
    const gate = makeWakeGate(wake())
    gate.filter(speechStarted, 0)
    assert.deepStrictEqual(gate.filter(eagerEndOfTurn("hey jeff"), 1), { events: [] })
    assert.deepStrictEqual(gate.filter(turnResumed, 2), { events: [] })
    assert.deepStrictEqual(gate.filter(endOfTurn("hey jeff lights off"), 3).events, [speechStarted, endOfTurn("lights off")])
  })

  it("a TurnResumed after a held eager transcript is swallowed; a match afterwards still releases", () => {
    const gate = makeWakeGate(wake())
    assert.deepStrictEqual(feed(gate, [speechStarted, eagerEndOfTurn("hey"), turnResumed]), [])
    assert.deepStrictEqual(feed(gate, [eagerEndOfTurn("hey jeff lights")], 3), [speechStarted, eagerEndOfTurn("lights")])
    assert.deepStrictEqual(feed(gate, [turnResumed, endOfTurn("hey jeff lights off")], 4), [turnResumed, endOfTurn("lights off")])
  })
})

describe("WakeGate: awake", () => {
  it("follow-up window: after a reply ends, utterances pass without the phrase until it closes", () => {
    const gate = makeWakeGate(wake({ followUpMs: 5_000 }))
    gate.replyStarted(0)
    gate.replyEnded(1_000)
    assert.isTrue(gate.awake(5_999))
    assert.isFalse(gate.awake(6_000))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("and tomorrow?")], 2_000), [speechStarted, endOfTurn("and tomorrow?")])
    // An accepted utterance keeps the device awake (the window restarts at its end).
    assert.isTrue(gate.awake(2_001 + 4_999))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("no")], 6_999), [speechStarted, endOfTurn("no")])
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")], 13_000), [])
  })

  it("a leading wake phrase is still removed while awake", () => {
    const gate = makeWakeGate(wake())
    gate.replyEnded(0)
    const out = feed(gate, [speechStarted, interim("hey jeff and"), endOfTurn("Hey Jeff, and tomorrow?")], 10)
    assert.deepStrictEqual(out, [speechStarted, interim("and"), endOfTurn("and tomorrow?")])
  })

  it("an awake utterance that is only the phrase: empty partials are not forwarded, its end closes it and arms", () => {
    const gate = makeWakeGate(wake())
    gate.replyEnded(0)
    const out: Array<SttEvent> = []
    out.push(...gate.filter(speechStarted, 10).events)
    out.push(...gate.filter(interim("hey jeff"), 11).events)
    out.push(...gate.filter(eagerEndOfTurn("hey jeff"), 12).events)
    out.push(...gate.filter(turnResumed, 13).events)
    const end = gate.filter(endOfTurn("hey jeff"), 20_000)
    out.push(...end.events)
    assert.deepStrictEqual(out, [speechStarted, endOfTurn("")])
    assert.deepStrictEqual(end.woke, { phrase: "hey jeff", armed: true })
    assert.isTrue(gate.awake(20_001))
  })

  it("an utterance that starts awake is accepted to its end even if the window closes meanwhile", () => {
    const gate = makeWakeGate(wake({ followUpMs: 1_000 }))
    gate.replyEnded(0)
    gate.filter(speechStarted, 999)
    assert.isFalse(gate.awake(5_000))
    assert.deepStrictEqual(gate.filter(interim("and the"), 5_000).events, [interim("and the")])
    assert.deepStrictEqual(gate.filter(endOfTurn("and the weather"), 6_000).events, [endOfTurn("and the weather")])
  })

  it("during a reply: awake when follow-up is above zero, else barge-in needs the phrase", () => {
    const withFollowUp = makeWakeGate(wake({ followUpMs: 3_000 }))
    withFollowUp.replyStarted(0)
    assert.isTrue(withFollowUp.awake(60_000))
    assert.deepStrictEqual(withFollowUp.filter(speechStarted, 60_000).events, [speechStarted])

    const zero = makeWakeGate(wake({ followUpMs: 0 }))
    zero.replyStarted(0)
    assert.isFalse(zero.awake(1))
    assert.deepStrictEqual(feed(zero, [speechStarted, interim("stop")], 1), [])
    assert.deepStrictEqual(zero.filter(interim("hey jeff stop"), 3).events, [speechStarted, interim("stop")])
  })

  it("follow-up 0: asleep again right after the reply", () => {
    const gate = makeWakeGate(wake({ followUpMs: 0 }))
    gate.replyStarted(0)
    gate.replyEnded(100)
    assert.isFalse(gate.awake(100))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("and tomorrow")], 101), [])
  })
})

describe("WakeGate: configure", () => {
  it("is live: always → wake-phrase and back", () => {
    const gate = makeWakeGate(wake({ activation: "always" }))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")]), [speechStarted, endOfTurn("lights")])
    gate.configure(wake())
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")], 10), [])
    gate.configure(wake({ activation: "always" }))
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("lights")], 20), [speechStarted, endOfTurn("lights")])
  })

  it("discards a held utterance: its tail is dropped even after a switch to always", () => {
    const gate = makeWakeGate(wake())
    feed(gate, [speechStarted, interim("so")])
    gate.configure(wake({ activation: "always" }))
    assert.deepStrictEqual(feed(gate, [interim("so then"), endOfTurn("so then")], 2), [])
    assert.deepStrictEqual(feed(gate, [speechStarted, endOfTurn("next")], 10), [speechStarted, endOfTurn("next")])
  })

  it("an accepted utterance stays accepted across configure", () => {
    const gate = makeWakeGate(wake({ activation: "always" }))
    gate.filter(speechStarted, 0)
    gate.configure(wake())
    assert.deepStrictEqual(feed(gate, [interim("lights"), endOfTurn("lights on")], 1), [interim("lights"), endOfTurn("lights on")])
  })

  it("keeps an open window only while it is still open under the new lengths", () => {
    const gate = makeWakeGate(wake({ followUpMs: 10_000 }))
    gate.replyEnded(0)
    gate.configure(wake({ followUpMs: 5_000 }))
    assert.isTrue(gate.awake(4_999))
    assert.isFalse(gate.awake(5_000))
    gate.configure(wake({ followUpMs: 0 }))
    assert.isFalse(gate.awake(1))
    const armed = makeWakeGate(wake())
    feed(armed, [speechStarted, endOfTurn("hey jeff")], 0)
    armed.configure(wake({ armedMs: 2_000 }))
    assert.isTrue(armed.awake(2_000))
    assert.isFalse(armed.awake(2_001))
  })

  it("takes its config from a device profile", () => {
    assert.deepStrictEqual(wakeConfigFromProfile({ ...DEFAULT_DEVICE_PROFILE, activation: "wake-phrase", followUpSeconds: 3 }), {
      activation: "wake-phrase",
      phrases: DEFAULT_DEVICE_PROFILE.wakePhrases,
      match: DEFAULT_DEVICE_PROFILE.wakeMatch,
      followUpMs: 3_000
    })
  })
})

// ---------------------------------------------------------------------------
// The utterance contract as a property: random contract-keeping input, random reply and configure calls in
// between, seeded so a failure reproduces.

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
  "uh um well hey jeff no"
]

describe("WakeGate: the utterance contract (property)", () => {
  it("every forwarded utterance is SpeechStarted … exactly one EndOfTurn; a dropped utterance forwards nothing", () => {
    let forwarded = 0
    let dropped = 0
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed)
      const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(r() * xs.length)]!
      const configs: Array<WakeConfig> = [
        wake(),
        wake({ followUpMs: 0 }),
        wake({ activation: "always" }),
        wake({ match: "exact", armedMs: 500 }),
        wake({ followUpMs: 1_500 })
      ]
      const gate = makeWakeGate(pick(configs))
      let now = 0
      const step = () => (now += Math.floor(r() * 2_000))
      for (let u = 0; u < 12; u++) {
        if (r() < 0.3) gate.replyStarted(step())
        if (r() < 0.3) gate.replyEnded(step())
        // The utterance, as a contract-keeping recogniser sends it.
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
          if (r() < 0.05) gate.replyEnded(now)
          out.push(...gate.filter(e, step()).events)
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
        // EagerEndOfTurn is never empty; a TurnResumed follows a forwarded EagerEndOfTurn.
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
    // Both outcomes are exercised a lot.
    assert.isAbove(forwarded, 1_000)
    assert.isAbove(dropped, 500)
  })
})
