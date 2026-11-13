import { assert, describe, it } from "@effect/vitest"
import { fixedSilence, TurnDetector, type TurnInput, type TurnOutput } from "../src/TurnDetector.ts"

// Scripted input: `speech(ms)` / `silence(ms)` expand to 20 ms frames.
type Step = TurnInput | ReadonlyArray<TurnInput>
const frames = (speech: boolean, ms: number): Array<TurnInput> => {
  if (ms % 20 !== 0) throw new Error(`${ms} ms is not a whole number of frames`)
  return Array.from({ length: ms / 20 }, () => ({ _tag: "Frame", speech }))
}
const speech = (ms: number) => frames(true, ms)
const silence = (ms: number) => frames(false, ms)
const partial = (text: string): TurnInput => ({ _tag: "Partial", text })
const segment = (text: string): TurnInput => ({ _tag: "Segment", text })

const detector = () => new TurnDetector({ policy: fixedSilence(250, 600), minSpeechMs: 100 })

/** Runs the script; each output is labelled with the frame (ms of audio) at which it happened. */
const run = (script: ReadonlyArray<Step>, d = detector()) => {
  const out: Array<[number, TurnOutput]> = []
  let ms = 0
  for (const step of script) {
    for (const input of Array.isArray(step) ? step : [step as TurnInput]) {
      if (input._tag === "Frame") ms += 20
      for (const output of d.step(input)) out.push([ms, output])
    }
  }
  return out
}
const tags = (out: ReadonlyArray<[number, TurnOutput]>) =>
  out.map(([, o]) => ("text" in o ? `${o._tag}(${o.text})` : o._tag))

describe("TurnDetector", () => {
  it("normal turn: SpeechStarted, Interim, Finalize at the eager threshold, EagerEndOfTurn, EndOfTurn", () => {
    const out = run([silence(200), speech(400), partial("hello"), speech(300), partial("hello there"), silence(260)])
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Interim(hello)",
      "Interim(hello there)",
      "Finalize"
    ])
    assert.strictEqual(out[0]![0], 300) // 100 ms of speech after the 200 ms of silence
    // 250 ms is reached on the 13th silent frame (260 ms); `frame` counts frames from the start.
    assert.deepStrictEqual(out[3], [1160, { _tag: "Finalize", frame: 1160 / 20 }])

    const d = detector()
    run([silence(200), speech(700), partial("hello there"), silence(260)], d)
    assert.deepStrictEqual(tags(run([segment("Hello there."), silence(400)], d)), [
      "EagerEndOfTurn(Hello there.)",
      "EndOfTurn(Hello there.)"
    ])
  })

  it("EndOfTurn comes at the final threshold, counted from the last speech frame", () => {
    const d = detector()
    run([speech(500), partial("yes"), silence(260), segment("Yes.")], d)
    const out = run([silence(320), silence(20)], d)
    assert.deepStrictEqual(out, [[340, { _tag: "EndOfTurn", text: "Yes." }]]) // 250 + 340 = 590 → the frame at 600
  })

  it("a pause shorter than the eager threshold changes nothing", () => {
    const out = run([speech(400), partial("one"), silence(200), speech(400), partial("one two"), silence(240)])
    assert.deepStrictEqual(tags(out), ["SpeechStarted", "Interim(one)", "Interim(one two)"])
  })

  it("eager, then resumed, then final: TurnResumed and a new eager with both segments", () => {
    const d = detector()
    const out = run([
      speech(400),
      partial("book a table"),
      silence(260),
      segment("Book a table"),
      silence(60),
      speech(120),
      partial("for two"),
      speech(300),
      silence(260),
      segment("for two."),
      silence(400)
    ], d)
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Interim(book a table)",
      "Finalize",
      "EagerEndOfTurn(Book a table)",
      "TurnResumed",
      "Interim(Book a table for two)",
      "Finalize",
      "EagerEndOfTurn(Book a table for two.)",
      "EndOfTurn(Book a table for two.)"
    ])
  })

  it("a noise blip after an eager end of turn neither resumes nor repeats the eager event", () => {
    const out = run([speech(400), partial("stop"), silence(260), segment("Stop."), silence(100), speech(40), silence(260), segment(""), silence(400)])
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Interim(stop)",
      "Finalize",
      "EagerEndOfTurn(Stop.)",
      "Finalize",
      "EndOfTurn(Stop.)"
    ])
  })

  it("speech after the decision point cancels the finalise and the segment continues", () => {
    const out = run([
      speech(400),
      partial("turn on"),
      silence(260),
      speech(100),
      { _tag: "SegmentCancelled" },
      partial("turn on the light"),
      silence(260),
      segment("Turn on the light."),
      silence(400)
    ])
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Interim(turn on)",
      "Finalize",
      "Interim(turn on the light)",
      "Finalize",
      "EagerEndOfTurn(Turn on the light.)",
      "EndOfTurn(Turn on the light.)"
    ])
  })

  it("noise with no words: SpeechStarted (barge-in) but no turn events", () => {
    const out = run([speech(300), silence(260), segment(""), silence(600)])
    assert.deepStrictEqual(tags(out), ["SpeechStarted", "Finalize"])
  })

  it("a click shorter than minSpeechMs does not send SpeechStarted", () => {
    const out = run([silence(100), speech(60), silence(260), segment(""), silence(600)])
    assert.deepStrictEqual(tags(out), ["Finalize"])
  })

  it("barge-in: SpeechStarted after exactly minSpeechMs of continuous speech", () => {
    const out = run([silence(500), speech(80), silence(20), speech(200)])
    assert.deepStrictEqual(out, [[500 + 80 + 20 + 100, { _tag: "SpeechStarted" }]])
  })

  it("the final threshold reached while finalising commits when the segment arrives, without an eager event", () => {
    const d = new TurnDetector({ policy: fixedSilence(250, 300), minSpeechMs: 100 })
    const out = run([speech(400), partial("hi"), silence(400), segment("Hi.")], d)
    assert.deepStrictEqual(tags(out), ["SpeechStarted", "Interim(hi)", "Finalize", "EndOfTurn(Hi.)"])
  })

  it("end of audio finalises the open segment and commits", () => {
    const d = detector()
    const out = run([speech(400), partial("goodbye"), { _tag: "End" }], d)
    assert.deepStrictEqual(tags(out), ["SpeechStarted", "Interim(goodbye)", "Finalize"])
    assert.isFalse(d.settled)
    assert.deepStrictEqual(tags(run([segment("Goodbye.")], d)), ["EndOfTurn(Goodbye.)"])
    assert.isTrue(d.settled)
  })

  it("the policy sees the transcript", () => {
    // A stand-in for a semantic detector: a finished sentence ends the turn sooner.
    const policy = {
      eagerSilenceMs: () => 200,
      finalSilenceMs: (text: string) => (/[.?!]$/.test(text) ? 300 : 1000)
    }
    const d = new TurnDetector({ policy, minSpeechMs: 100 })
    const out = run([speech(400), partial("what time is it"), silence(200), segment("What time is it?"), silence(100)], d)
    assert.deepStrictEqual(tags(out).at(-1), "EndOfTurn(What time is it?)")
  })
})
