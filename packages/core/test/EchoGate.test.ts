import { assert, describe, it } from "@effect/vitest"
import { ECHO_TAIL_MS, makeEchoGate } from "../src/EchoGate.ts"
import { endOfTurn, interim, speechStarted, turnResumed } from "../src/testing.ts"

const playing = (mode: "instant" | "confirm" | "manual") => {
  const gate = makeEchoGate(mode)
  gate.playbackStarted(0)
  gate.clausePlayed("[voice:standard] It's sunny in Paris, eighteen degrees.", 0)
  gate.clausePlayed("Light wind from the west.", 500)
  return gate
}

describe("EchoGate", () => {
  it("outside the audible window every mode passes everything", () => {
    for (const mode of ["instant", "confirm", "manual"] as const) {
      const gate = makeEchoGate(mode)
      assert.deepStrictEqual(gate.filter(speechStarted, 0).events, [speechStarted])
      assert.deepStrictEqual(gate.filter(interim("sunny in paris"), 0).events, [interim("sunny in paris")])
    }
  })

  it("instant: speech during playback passes (barge-in at SpeechStarted)", () => {
    const gate = playing("instant")
    assert.deepStrictEqual(gate.filter(speechStarted, 600).events, [speechStarted])
  })

  it("confirm: echo of a played clause is dropped, including its end of turn", () => {
    const gate = playing("confirm")
    assert.deepStrictEqual(gate.filter(speechStarted, 600), { events: [], dropped: false })
    assert.deepStrictEqual(gate.filter(interim("sunny in paris eighteen"), 700), { events: [], dropped: true })
    assert.deepStrictEqual(gate.filter(endOfTurn("It's sunny in Paris, eighteen degrees."), 900), { events: [], dropped: true })
  })

  it("confirm: a different sentence releases the held SpeechStarted, then the interim", () => {
    const gate = playing("confirm")
    gate.filter(speechStarted, 600)
    assert.deepStrictEqual(gate.filter(interim("what about tomorrow"), 800).events, [speechStarted, interim("what about tomorrow")])
    // Released once: later events pass on their own.
    assert.deepStrictEqual(gate.filter(endOfTurn("What about tomorrow?"), 1_000).events, [endOfTurn("What about tomorrow?")])
  })

  it("confirm: one-word 'stop' does not interrupt (the known cost)", () => {
    const gate = playing("confirm")
    gate.filter(speechStarted, 600)
    assert.deepStrictEqual(gate.filter(interim("stop"), 700), { events: [], dropped: true })
    assert.deepStrictEqual(gate.filter(endOfTurn("Stop."), 900), { events: [], dropped: true })
  })

  it("confirm: a held SpeechStarted is dropped when the window closes; TurnResumed passes", () => {
    const gate = playing("confirm")
    gate.filter(speechStarted, 600)
    gate.playbackEnded(1_000)
    assert.isTrue(gate.audible(1_000 + ECHO_TAIL_MS - 1))
    assert.isFalse(gate.audible(1_000 + ECHO_TAIL_MS))
    assert.deepStrictEqual(gate.filter(turnResumed, 1_100).events, [turnResumed])
    assert.deepStrictEqual(gate.filter(interim("new words here"), 1_000 + ECHO_TAIL_MS).events, [interim("new words here")])
  })

  it("manual: everything is dropped while audible", () => {
    const gate = playing("manual")
    assert.deepStrictEqual(gate.filter(speechStarted, 600), { events: [], dropped: true })
    assert.deepStrictEqual(gate.filter(endOfTurn("please stop talking now"), 700), { events: [], dropped: true })
  })

  it("played words are forgotten after 5 s", () => {
    const gate = makeEchoGate("confirm")
    gate.playbackStarted(0)
    gate.clausePlayed("sunny in paris", 0)
    gate.filter(speechStarted, 6_000)
    assert.deepStrictEqual(gate.filter(interim("sunny in paris"), 6_000).events, [speechStarted, interim("sunny in paris")])
  })
})
