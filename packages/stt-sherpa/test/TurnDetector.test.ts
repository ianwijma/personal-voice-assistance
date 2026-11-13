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

/**
 * Runs the script; each output is labelled with the frame (ms of audio) at which it happened.
 * `Commit` outputs are left out unless `commits` is set.
 */
const run = (script: ReadonlyArray<Step>, d = detector(), commits = false) => {
  const out: Array<[number, TurnOutput]> = []
  let ms = 0
  for (const step of script) {
    for (const input of Array.isArray(step) ? step : [step as TurnInput]) {
      if (input._tag === "Frame") ms += 20
      for (const output of d.step(input)) if (commits || output._tag !== "Commit") out.push([ms, output])
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

  it("Commit: when a turn ends, with the frame it ended at", () => {
    const out = run([speech(400), partial("yes"), silence(260), segment("Yes."), silence(400)], detector(), true)
    assert.deepStrictEqual(tags(out), ["SpeechStarted", "Interim(yes)", "Finalize", "EagerEndOfTurn(Yes.)", "EndOfTurn(Yes.)", "Commit"])
    assert.deepStrictEqual(out.at(-1), [400 + 600, { _tag: "Commit", frame: 1000 / 20 }])
  })
})

describe("TurnDetector, cumulative (whole-turn recognisers)", () => {
  const cumulative = (eager = 250, final = 600) =>
    new TurnDetector({ policy: fixedSilence(eager, final), minSpeechMs: 100, cumulative: true })

  it("normal turn without live words: SpeechStarted, Finalize, EagerEndOfTurn, EndOfTurn, Commit", () => {
    const out = run([silence(100), speech(600), silence(260), segment("Hello there."), silence(400)], cumulative(), true)
    assert.deepStrictEqual(tags(out), ["SpeechStarted", "Finalize", "EagerEndOfTurn(Hello there.)", "EndOfTurn(Hello there.)", "Commit"])
  })

  it("resumed: the second answer replaces the first (the whole turn was decoded again)", () => {
    const out = run([
      speech(400),
      silence(260),
      segment("Book a table"),
      silence(60),
      speech(400),
      silence(260),
      segment("Book a table for two."),
      silence(400)
    ], cumulative(), true)
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Finalize",
      "EagerEndOfTurn(Book a table)",
      "TurnResumed",
      "Finalize",
      "EagerEndOfTurn(Book a table for two.)",
      "EndOfTurn(Book a table for two.)",
      "Commit"
    ])
  })

  it("speech while the decode runs: its answer is held, the next pause decodes the whole turn again", () => {
    const out = run([
      speech(400),
      silence(260),
      speech(200), // the user goes on before the answer arrives
      segment("Turn on"),
      speech(200),
      silence(260),
      segment("Turn on the light."),
      silence(400)
    ], cumulative())
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Finalize",
      "Finalize",
      "EagerEndOfTurn(Turn on the light.)",
      "EndOfTurn(Turn on the light.)"
    ])
  })

  it("live words (hybrid) become Interims of the whole turn and never resume the turn", () => {
    const out = run([
      speech(300),
      partial("what"),
      speech(300),
      partial("what time"),
      silence(260),
      partial("what time is it"), // the streaming model catching up after the pause
      segment("What time is it?"),
      silence(400)
    ], cumulative())
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Interim(what)",
      "Interim(what time)",
      "Finalize",
      "Interim(what time is it)",
      "EagerEndOfTurn(What time is it?)",
      "EndOfTurn(What time is it?)"
    ])
  })

  it("a click shorter than minSpeechMs gets no text even if the model made some, and the turn is dropped", () => {
    const out = run([silence(100), speech(60), silence(260), segment("Yeah."), silence(600)], cumulative(), true)
    assert.deepStrictEqual(tags(out), ["Finalize", "Commit"])
  })

  it("an empty answer after a real onset: SpeechStarted (barge-in) but no turn, then Commit at the final threshold", () => {
    const out = run([speech(300), silence(260), segment(""), silence(400)], cumulative(), true)
    assert.deepStrictEqual(tags(out), ["SpeechStarted", "Finalize", "Commit"])
  })

  it("a slow decode (final threshold passes first): EndOfTurn when the answer arrives", () => {
    const out = run([speech(500), silence(700), segment("Hi there.")], cumulative(), true)
    assert.deepStrictEqual(tags(out), ["SpeechStarted", "Finalize", "EndOfTurn(Hi there.)", "Commit"])
  })

  it("an answer after resumption that equals the earlier eager text is sent again (the reply was cancelled)", () => {
    const out = run([speech(400), silence(260), segment("Stop."), speech(200), silence(260), segment("Stop."), silence(400)], cumulative())
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Finalize",
      "EagerEndOfTurn(Stop.)",
      "TurnResumed",
      "Finalize",
      "EagerEndOfTurn(Stop.)",
      "EndOfTurn(Stop.)"
    ])
  })

  it("end of audio: finalise, then EndOfTurn and Commit", () => {
    const d = cumulative()
    assert.deepStrictEqual(tags(run([speech(400), { _tag: "End" }], d)), ["SpeechStarted", "Finalize"])
    assert.deepStrictEqual(tags(run([segment("Goodbye.")], d, true)), ["EndOfTurn(Goodbye.)", "Commit"])
    assert.isTrue(d.settled)
  })

  it("a decode that answers after the final threshold, with the next sentence already started: two turns, not one", () => {
    const out = run([
      speech(500),
      silence(260), // Finalize
      silence(400), // final threshold passes while the (slow) decode runs
      speech(300), // the next sentence starts before the answer arrives
      segment("First sentence."),
      silence(260),
      segment("Second sentence."),
      silence(400)
    ], cumulative(), true)
    assert.deepStrictEqual(tags(out), [
      "SpeechStarted",
      "Finalize",
      "EndOfTurn(First sentence.)",
      "Commit",
      "SpeechStarted",
      "Finalize",
      "EagerEndOfTurn(Second sentence.)",
      "EndOfTurn(Second sentence.)",
      "Commit"
    ])
    // The first Commit names the frame where the turn ended, so the worker keeps the second sentence's audio.
    const commit = out.find(([, o]) => o._tag === "Commit")!
    assert.deepStrictEqual(commit[1], { _tag: "Commit", frame: (500 + 600) / 20 })
  })
})
