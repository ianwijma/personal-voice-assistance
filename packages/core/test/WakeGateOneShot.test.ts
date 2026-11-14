import { assert, describe, it } from "@effect/vitest"
import { DEFAULT_DEVICE_PROFILE, WAKE_ARMED_MS } from "@pva/protocol"
import type { SttEvent } from "../src/Domain.ts"
import { makeWakeGate, type WakeConfig, wakeConfigFromProfile, type WakeGate, type WakeResult } from "../src/WakeGate.ts"
import { eagerEndOfTurn, endOfTurn, interim, speechStarted, turnResumed } from "../src/testing.ts"

const PHRASES = ["hey jeff", "hey jev"]
const oneShot = (over: Partial<WakeConfig> = {}): WakeConfig => ({
  activation: "one-shot",
  phrases: PHRASES,
  match: "close",
  followUpMs: 8_000, // must be ignored
  ...over
})

const utterance = (gate: WakeGate, text: string, t: number): { events: Array<SttEvent>; last: WakeResult } => {
  const events: Array<SttEvent> = []
  let last: WakeResult = { events: [] }
  let woke: WakeResult["woke"]
  for (const [i, e] of [speechStarted, interim(text), endOfTurn(text)].entries()) {
    last = gate.filter(e, t + i)
    events.push(...last.events)
    if (last.woke) woke = last.woke
  }
  return { events, last: { ...last, ...(woke ? { woke } : {}) } }
}
const texts = (events: ReadonlyArray<SttEvent>) =>
  events.filter((e) => e._tag === "EndOfTurn").map((e) => (e as { text: string }).text)

describe("WakeGate one-shot: transitions (docs/VOICE-NODES.md §3.1)", () => {
  it("ASLEEP: an utterance without the phrase is dropped whole", () => {
    const g = makeWakeGate(oneShot())
    const r = utterance(g, "what time is it", 0)
    assert.deepStrictEqual(r.events, [])
    assert.isFalse(g.awake(10))
    assert.isFalse(g.taken(10))
  })

  it("ASLEEP → TAKEN: phrase + request is accepted with the phrase removed", () => {
    const g = makeWakeGate(oneShot())
    const r = utterance(g, "Hey Jeff, what time is it?", 0)
    assert.deepStrictEqual(r.events.map((e) => e._tag), ["SpeechStarted", "Interim", "EndOfTurn"])
    assert.deepStrictEqual(texts(r.events), ["what time is it?"])
    assert.deepStrictEqual(r.last.woke, { phrase: "hey jeff", armed: false })
    assert.isTrue(g.taken(3))
  })

  it("TAKEN → ASLEEP at replyEnded, with no follow-up window (followUpMs ignored)", () => {
    const g = makeWakeGate(oneShot({ followUpMs: 60_000 }))
    utterance(g, "hey jeff what time is it", 0)
    g.replyStarted(100)
    g.replyEnded(200)
    assert.isFalse(g.taken(200))
    assert.isFalse(g.awake(201))
    assert.deepStrictEqual(utterance(g, "and tomorrow", 300).events, [])
    // The same sequence in wake-phrase mode would have kept the device awake.
    const w = makeWakeGate(oneShot({ activation: "wake-phrase", followUpMs: 60_000 }))
    utterance(w, "hey jeff what time is it", 0)
    w.replyEnded(200)
    assert.isTrue(w.awake(300))
  })

  it("TAKEN: the device does not count as awake during the reply, whatever followUpMs says", () => {
    const g = makeWakeGate(oneShot({ followUpMs: 60_000 }))
    utterance(g, "hey jeff lights", 0)
    g.replyStarted(10)
    assert.isFalse(g.awake(20))
    assert.deepStrictEqual(utterance(g, "no wait", 30).events, [])
    assert.isTrue(g.taken(40))
  })

  it("TAKEN: a turn without a reply returns to ASLEEP through replyEnded alone (no replyStarted)", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff lights", 0)
    assert.isTrue(g.taken(5))
    g.replyEnded(6)
    assert.isFalse(g.taken(7))
    assert.isFalse(g.awake(7))
  })

  it("TAKEN is entered at the accepted EndOfTurn, not before", () => {
    const g = makeWakeGate(oneShot())
    g.filter(speechStarted, 0)
    g.filter(interim("hey jeff what"), 1)
    assert.isFalse(g.taken(2))
    g.filter(endOfTurn("hey jeff what time"), 3)
    assert.isTrue(g.taken(4))
  })

  it("a phrase + request during TAKEN is ordinary barge-in: released, accepted, still TAKEN", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff weather", 0)
    g.replyStarted(10)
    const r = utterance(g, "hey jev stop that and say hi", 20)
    assert.deepStrictEqual(r.events.map((e) => e._tag), ["SpeechStarted", "Interim", "EndOfTurn"])
    assert.deepStrictEqual(texts(r.events), ["stop that and say hi"])
    assert.isUndefined(r.last.woke?.duringReply)
    assert.isTrue(g.taken(30))
  })

  it("ASLEEP → ARMED: the phrase alone forwards nothing and arms", () => {
    const g = makeWakeGate(oneShot())
    const r = utterance(g, "hey jeff", 0)
    assert.deepStrictEqual(r.events, [])
    assert.deepStrictEqual(r.last.woke, { phrase: "hey jeff", armed: true })
    assert.isUndefined(r.last.woke?.duringReply)
    assert.isFalse(g.taken(3))
    assert.isTrue(g.awake(100))
  })

  it("ARMED → TAKEN: the next utterance, with no phrase, is accepted", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff", 0)
    const r = utterance(g, "what time is it", 1_000)
    assert.deepStrictEqual(texts(r.events), ["what time is it"])
    assert.isTrue(g.taken(1_010))
  })

  it("the armed window admits one utterance only", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff", 0)
    utterance(g, "first", 1_000)
    g.replyEnded(1_500)
    assert.deepStrictEqual(utterance(g, "second", 2_000).events, [])
  })

  it("ARMED → ASLEEP: silence after the phrase lapses after armedMs", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff", 0)
    assert.isTrue(g.awake(WAKE_ARMED_MS - 1))
    assert.isFalse(g.awake(WAKE_ARMED_MS + 5))
    assert.deepStrictEqual(utterance(g, "hello?", WAKE_ARMED_MS + 10).events, [])
    const short = makeWakeGate(oneShot({ armedMs: 500 }))
    utterance(short, "hey jeff", 0)
    assert.isFalse(short.awake(600))
  })

  it("an utterance that starts armed is accepted to its end even if the window closes meanwhile", () => {
    const g = makeWakeGate(oneShot({ armedMs: 1_000 }))
    utterance(g, "hey jeff", 0)
    const out: Array<SttEvent> = []
    out.push(...g.filter(speechStarted, 500).events)
    out.push(...g.filter(interim("what"), 900).events)
    out.push(...g.filter(endOfTurn("what time"), 5_000).events)
    assert.deepStrictEqual(out.map((e) => e._tag), ["SpeechStarted", "Interim", "EndOfTurn"])
  })
})

describe("WakeGate one-shot: the phrase alone during a reply (§3.2 #2)", () => {
  it("reports duringReply, leaves TAKEN and arms; the next utterance is accepted without the phrase", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff weather", 0)
    g.replyStarted(10)
    const r = utterance(g, "hey jeff", 100)
    assert.deepStrictEqual(r.events, [])
    assert.deepStrictEqual(r.last.woke, { phrase: "hey jeff", armed: true, duringReply: true })
    assert.isFalse(g.taken(110))
    assert.isTrue(g.awake(120))
    // The session interrupts and the reply ends.
    g.replyEnded(130)
    const next = utterance(g, "what's the weather instead", 1_000)
    assert.deepStrictEqual(texts(next.events), ["what's the weather instead"])
    assert.isTrue(g.taken(1_010))
  })

  it("an eager transcript that is only the phrase stays held; the end of turn decides", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff weather", 0)
    g.replyStarted(5)
    assert.deepStrictEqual(g.filter(speechStarted, 10).events, [])
    assert.deepStrictEqual(g.filter(eagerEndOfTurn("hey jeff"), 11).events, [])
    assert.deepStrictEqual(g.filter(turnResumed, 12).events, [])
    const r = g.filter(endOfTurn("hey jeff"), 13)
    assert.deepStrictEqual(r.events, [])
    assert.deepStrictEqual(r.woke, { phrase: "hey jeff", armed: true, duringReply: true })
  })

  it("the phrase alone when not TAKEN has no duringReply, in one-shot and wake-phrase", () => {
    for (const activation of ["one-shot", "wake-phrase"] as const) {
      const g = makeWakeGate(oneShot({ activation }))
      g.replyStarted(0)
      const r = utterance(g, "hey jeff", 5)
      assert.deepStrictEqual(r.last.woke, { phrase: "hey jeff", armed: true })
    }
  })

  it("an accepted utterance that is only the phrase (armed, then the phrase) while TAKEN also reports duringReply", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff weather", 0)
    g.answerWindow(10, 15_000) // an answer window is open while TAKEN
    const r = utterance(g, "hey jeff", 20)
    assert.deepStrictEqual(r.events.map((e) => e._tag), ["SpeechStarted", "EndOfTurn"])
    assert.deepStrictEqual(texts(r.events), [""])
    assert.deepStrictEqual(r.last.woke, { phrase: "hey jeff", armed: true, duringReply: true })
  })
})

describe("WakeGate one-shot: answer window (§3.2 #3)", () => {
  it("admits exactly one utterance without a phrase, reports nothing by itself", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff delete everything", 0)
    g.replyStarted(10)
    g.replyEnded(500) // the question was played; the turn is over
    g.answerWindow(500, 15_000)
    assert.isTrue(g.awake(600))
    const yes = utterance(g, "yes", 1_000)
    assert.deepStrictEqual(texts(yes.events), ["yes"])
    assert.isUndefined(yes.last.woke)
    assert.isTrue(g.taken(1_010)) // the answer is a request: a reply is owed
    g.replyEnded(2_000)
    assert.deepStrictEqual(utterance(g, "and more", 3_000).events, [])
  })

  it("works from TAKEN too (the window opens before replyEnded)", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff delete everything", 0)
    g.answerWindow(100, 15_000)
    assert.isTrue(g.taken(110))
    const yes = utterance(g, "yes", 200)
    assert.deepStrictEqual(texts(yes.events), ["yes"])
  })

  it("lapses after ms", () => {
    const g = makeWakeGate(oneShot())
    g.answerWindow(0, 1_000)
    assert.isTrue(g.awake(999))
    assert.isFalse(g.awake(1_000))
    assert.deepStrictEqual(utterance(g, "yes", 2_000).events, [])
  })

  it("an utterance that starts inside the window is accepted to its end", () => {
    const g = makeWakeGate(oneShot())
    g.answerWindow(0, 1_000)
    const out: Array<SttEvent> = []
    out.push(...g.filter(speechStarted, 900).events)
    out.push(...g.filter(endOfTurn("yes please"), 3_000).events)
    assert.deepStrictEqual(out.map((e) => e._tag), ["SpeechStarted", "EndOfTurn"])
  })

  it("is ignored outside one-shot", () => {
    for (const activation of ["wake-phrase", "always"] as const) {
      const g = makeWakeGate(oneShot({ activation }))
      g.answerWindow(0, 5_000)
      g.configure(oneShot({ activation: "wake-phrase" }))
      assert.isFalse(g.awake(10))
    }
  })

  it("leaving one-shot clears TAKEN and the answer window", () => {
    const g = makeWakeGate(oneShot())
    utterance(g, "hey jeff lights", 0)
    g.answerWindow(5, 15_000)
    g.configure(oneShot({ activation: "wake-phrase" }))
    assert.isFalse(g.taken(10))
    assert.isFalse(g.awake(10))
    g.configure(oneShot())
    assert.isFalse(g.taken(11))
    assert.isFalse(g.awake(11))
  })
})

describe("WakeGate one-shot: other behaviour", () => {
  it("taken() is false in always and wake-phrase", () => {
    for (const activation of ["always", "wake-phrase"] as const) {
      const g = makeWakeGate(oneShot({ activation }))
      utterance(g, "hey jeff lights", 0)
      assert.isFalse(g.taken(5))
    }
  })

  it("a phrase accepted at the eager transcript releases the held start; one EndOfTurn closes it", () => {
    const g = makeWakeGate(oneShot())
    g.filter(speechStarted, 0)
    const r = g.filter(eagerEndOfTurn("hey jeff what time"), 1)
    assert.deepStrictEqual(r.events.map((e) => e._tag), ["SpeechStarted", "EagerEndOfTurn"])
    const end = g.filter(endOfTurn("hey jeff what time is it"), 2)
    assert.deepStrictEqual(texts(end.events), ["what time is it"])
    assert.isTrue(g.taken(3))
  })

  it("heard reports accepted lines and ignored ones", () => {
    const g = makeWakeGate(oneShot())
    assert.deepStrictEqual(utterance(g, "chatter", 0).last.heard, { text: "chatter", accepted: false })
    assert.deepStrictEqual(utterance(g, "hey jeff", 10).last.heard, { text: "hey jeff", phrase: "hey jeff", accepted: true })
  })

  it("wakeConfigFromProfile maps one-shot through; followUpSeconds is carried but ignored by the gate", () => {
    const profile = { ...DEFAULT_DEVICE_PROFILE, activation: "one-shot", followUpSeconds: 30 } as unknown as typeof DEFAULT_DEVICE_PROFILE
    const cfg = wakeConfigFromProfile(profile)
    assert.strictEqual(cfg.activation, "one-shot")
    const g = makeWakeGate(cfg)
    utterance(g, `${cfg.phrases[0]} lights`, 0)
    g.replyEnded(10)
    assert.isFalse(g.awake(11))
  })
})

// Contract property, extended to one-shot: random contract-keeping input with random reply, answer-window and
// configure calls in between; seeded.
const rng = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff
  return seed / 0x8000_0000
}
const TEXTS = ["hey jeff", "Hey Jeff, what time is it?", "hey jev lights", "ok hey jev", "so what", "what time", "hey", "the weather", "yes"]

describe("WakeGate one-shot: the utterance contract (property)", () => {
  it("every forwarded utterance is SpeechStarted … exactly one EndOfTurn; a dropped one forwards nothing", () => {
    let forwarded = 0
    let dropped = 0
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed)
      const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(r() * xs.length)]!
      const configs: Array<WakeConfig> = [
        oneShot(),
        oneShot({ followUpMs: 0, armedMs: 500 }),
        oneShot({ match: "exact" }),
        oneShot({ activation: "wake-phrase" }),
        oneShot({ activation: "always" })
      ]
      const gate = makeWakeGate(pick(configs.slice(0, 3)))
      let now = 0
      const step = () => (now += Math.floor(r() * 2_000))
      for (let u = 0; u < 12; u++) {
        if (r() < 0.3) gate.replyStarted(step())
        if (r() < 0.3) gate.replyEnded(step())
        if (r() < 0.2) gate.answerWindow(step(), Math.floor(r() * 3_000))
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
    assert.isAbove(forwarded, 500)
    assert.isAbove(dropped, 500)
  })
})
