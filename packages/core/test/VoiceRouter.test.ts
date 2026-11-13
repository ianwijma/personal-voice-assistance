import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Logger, Stream } from "effect"
import { TestClock } from "effect/testing"
import { chunkClauses } from "../src/ClauseChunker.ts"
import { makeResampler } from "../src/Resample.ts"
import type { TtsAudio } from "../src/Services.ts"
import { makeMarkerTts, makeToneTts, markerText, scripted, sleep } from "../src/testing.ts"
import { CurrentTurnTrace, makeTurnTrace } from "../src/TurnTrace.ts"
import { isUnfinishedMarker, parseVoiceMarker, stripVoiceMarkers, stripVoiceMarkersStream } from "../src/VoiceMarkers.ts"
import { makeVoiceRouter, voicePrompt } from "../src/VoiceRouter.ts"

const advance = (millis: number) =>
  Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const twoVoices = (options: { readonly delayMillis?: number } = {}) => {
  const standard = makeMarkerTts({ label: "std", ...options })
  const expressive = makeMarkerTts({ label: "exp", ...options })
  const router = makeVoiceRouter({
    defaultVoice: "standard",
    voices: [
      { name: "standard", description: "Everyday answers.", tts: standard.service },
      { name: "expressive", description: "Singing and stories.", tts: expressive.service }
    ]
  })
  return { standard, expressive, router }
}

const collect = (stream: Stream.Stream<TtsAudio, unknown>) =>
  Effect.map(Stream.runCollect(stream), (chunks) => chunks.map((c) => [markerText(c.audio), c.clause] as const))

describe("VoiceRouter", () => {
  it.effect("no marker: every clause goes to the default voice, as one synthesis", () =>
    Effect.gen(function*() {
      const t = twoVoices()
      const out = yield* collect(t.router.synthesize(Stream.make("Hello there.", "How are you?")))
      assert.deepStrictEqual(out, [["<std:Hello there.>", 0], ["<std:How are you?>", 1]])
      assert.deepStrictEqual([t.standard.probe.started, t.expressive.probe.started], [1, 0])
      assert.strictEqual(t.router.sampleRate, 24_000)
    }))

  it.effect("a marker selects a voice and is stripped; it applies to the following clauses too", () =>
    Effect.gen(function*() {
      const t = twoVoices()
      const out = yield* collect(t.router.synthesize(Stream.make("[voice:expressive] Jingle bells,", "jingle all the way!")))
      assert.deepStrictEqual(out, [["<exp:Jingle bells,>", 0], ["<exp:jingle all the way!>", 1]])
      assert.deepStrictEqual(t.expressive.probe.clauses, ["Jingle bells,", "jingle all the way!"])
      assert.deepStrictEqual([t.standard.probe.started, t.expressive.probe.started], [0, 1])
    }))

  it.effect("switching mid-reply keeps order and clause indexes; a marker-only clause produces no audio", () =>
    Effect.gen(function*() {
      const t = twoVoices({ delayMillis: 100 })
      const fiber = yield* Effect.forkChild(collect(t.router.synthesize(Stream.make(
        "Sure.",
        "[voice:expressive]",
        "Ho ho ho!",
        "Merry Christmas.",
        "[voice:standard] Anything else?"
      ))))
      yield* advance(1_000)
      const out = yield* Fiber.join(fiber)
      assert.deepStrictEqual(out, [
        ["<std:Sure.>", 0],
        ["<exp:Ho ho ho!>", 2],
        ["<exp:Merry Christmas.>", 3],
        ["<std:Anything else?>", 4]
      ])
      // Three segments: standard, expressive (one continuous call for both clauses), standard.
      assert.deepStrictEqual([t.standard.probe.started, t.expressive.probe.started], [2, 1])
    }))

  it.effect("a later segment synthesises while an earlier one is still being delivered, but never overtakes it", () =>
    Effect.gen(function*() {
      const slow = makeMarkerTts({ label: "slow", delayMillis: 300 })
      const fast = makeMarkerTts({ label: "fast", delayMillis: 10 })
      const router = makeVoiceRouter({
        defaultVoice: "slow",
        voices: [{ name: "slow", description: "", tts: slow.service }, { name: "fast", description: "", tts: fast.service }]
      })
      const fiber = yield* Effect.forkChild(collect(router.synthesize(Stream.make("One.", "Two.", "[voice:fast] Three."))))
      yield* advance(50)
      // "Three." already reached the fast engine although "One." is still being synthesised.
      assert.deepStrictEqual(fast.probe.clauses, ["Three."])
      yield* advance(1_000)
      assert.deepStrictEqual(yield* Fiber.join(fiber), [["<slow:One.>", 0], ["<slow:Two.>", 1], ["<fast:Three.>", 2]])
    }))

  it.effect("an unknown voice falls back to the default with a warning", () =>
    Effect.gen(function*() {
      const t = twoVoices()
      const logs: Array<string> = []
      const out = yield* collect(t.router.synthesize(Stream.make("[voice:opera] La la la."))).pipe(
        Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))]))
      )
      assert.deepStrictEqual(out, [["<std:La la la.>", 0]])
      assert.isTrue(logs.some((l) => l.includes(`Unknown voice "opera"`)), logs.join("\n"))
    }))

  it.effect("interrupting the consumer cancels the active engine", () =>
    Effect.gen(function*() {
      const t = twoVoices({ delayMillis: 100 })
      const clauses = scripted(["Hi.", "[voice:expressive] La.", sleep(10_000), "Never."])
      const fiber = yield* Effect.forkChild(Stream.runDrain(t.router.synthesize(clauses)))
      yield* advance(150)
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual([t.expressive.probe.started, t.expressive.probe.interrupted], [1, 1])
      assert.strictEqual(t.standard.probe.started, 1)
      assert.strictEqual(t.standard.probe.started, t.standard.probe.completed + t.standard.probe.interrupted)
    }))

  it.effect("mixed sample rates come out at the default voice's rate with the right duration", () =>
    Effect.gen(function*() {
      const standard = makeToneTts({ sampleRate: 24_000, millisPerClause: 500 })
      const low = makeToneTts({ sampleRate: 16_000, millisPerClause: 500, chunks: 7 })
      const high = makeToneTts({ sampleRate: 44_100, millisPerClause: 500, chunks: 3 })
      const router = makeVoiceRouter({
        defaultVoice: "standard",
        voices: [
          { name: "standard", description: "", tts: standard.service },
          { name: "low", description: "", tts: low.service },
          { name: "high", description: "", tts: high.service }
        ]
      })
      const chunks = yield* Stream.runCollect(router.synthesize(Stream.make("A.", "[voice:low] B.", "[voice:high] C.")))
      const samplesOf = (clause: number) => chunks.filter((c) => c.clause === clause).reduce((n, c) => n + c.audio.length / 2, 0)
      assert.strictEqual(router.sampleRate, 24_000)
      assert.strictEqual(samplesOf(0), 12_000)
      // 500 ms at 24 kHz = 12000 samples, within a sample or two (the last input sample is held back).
      assert.approximately(samplesOf(1), 12_000, 3)
      assert.approximately(samplesOf(2), 12_000, 3)
      // A constant tone stays constant through the resampler.
      const values = chunks.filter((c) => c.clause === 1).flatMap((c) => [...new Int16Array(c.audio.slice().buffer)])
      assert.isTrue(values.slice(2).every((v) => v === 1000))
    }))

  it.effect("records the voices used in the current turn's trace, in order of first use", () =>
    Effect.gen(function*() {
      const t = twoVoices()
      const trace = makeTurnTrace().begin("voice")
      yield* Stream.runDrain(
        t.router.synthesize(Stream.make("Hi.", "[voice:expressive] La.", "[voice:standard] Bye.")).pipe(
          Stream.provideService(CurrentTurnTrace, trace)
        )
      )
      assert.deepStrictEqual(trace.voices, ["standard", "expressive"])
    }))

  it.effect("an unmarked reply's first clause reaches the engine and comes out at once", () =>
    Effect.gen(function*() {
      // Clauses arrive over time, as from the chunker; the engine answers after 150 ms.
      const plain = makeMarkerTts({ delayMillis: 150 })
      const t = twoVoices({ delayMillis: 150 })
      const timed = (stream: Stream.Stream<TtsAudio, unknown>) =>
        Stream.runCollect(Stream.mapEffect(stream, (c) => Effect.map(effectNow, (at) => [markerText(c.audio), at] as const)))
      const clauses = () => scripted([sleep(40), "Hello there.", sleep(500), "How are you?"])
      const a = yield* Effect.forkChild(timed(plain.service.synthesize(clauses())))
      const b = yield* Effect.forkChild(timed(t.router.synthesize(clauses())))
      yield* advance(2_000)
      const [direct, routed] = [yield* Fiber.join(a), yield* Fiber.join(b)]
      assert.deepStrictEqual(t.standard.probe.arrivals.map((x) => x.at), plain.probe.arrivals.map((x) => x.at))
      assert.deepStrictEqual(routed.map(([, at]) => at), direct.map(([, at]) => at))
      assert.deepStrictEqual(routed.map(([, at]) => at), [190, 690])
    }))
})

const effectNow = Effect.clockWith((clock) => Effect.succeed(clock.currentTimeMillisUnsafe()))

describe("voicePrompt", () => {
  it("lists every voice, the default and the marker syntax; stable across calls", () => {
    const voices = [{ name: "standard", description: "Everyday answers." }, { name: "expressive", description: "Singing." }]
    const text = voicePrompt(voices, "standard")
    assert.include(text, "[voice:expressive]")
    assert.include(text, "- [voice:standard] (default): Everyday answers.")
    assert.include(text, "- [voice:expressive]: Singing.")
    assert.strictEqual(text, voicePrompt(voices, "standard"))
  })

  it("is empty for a single voice, and the router then just strips markers", () =>
    Effect.runPromise(Effect.gen(function*() {
      const only = makeMarkerTts()
      const router = makeVoiceRouter({ defaultVoice: "solo", voices: [{ name: "solo", description: "x", tts: only.service }] })
      assert.strictEqual(router.prompt, "")
      assert.strictEqual(voicePrompt([{ name: "solo", description: "x" }], "solo"), "")
      const out = yield* collect(router.synthesize(Stream.make("[voice:solo] Hi.", "[voice:other] There.")))
      assert.deepStrictEqual(out.map(([text]) => text), ["<Hi.>", "<There.>"])
    })))
})

describe("voice markers", () => {
  it("parse, strip and detect unfinished markers", () => {
    assert.deepStrictEqual(parseVoiceMarker("[voice:Expressive] Hi."), { voice: "expressive", text: "Hi." })
    assert.deepStrictEqual(parseVoiceMarker("  [voice: expressive ]Hi."), { voice: "expressive", text: "Hi." })
    assert.deepStrictEqual(parseVoiceMarker("Hi [voice:x] there."), { voice: undefined, text: "Hi there." })
    assert.deepStrictEqual(parseVoiceMarker("[note] Hi."), { voice: undefined, text: "[note] Hi." })
    assert.strictEqual(stripVoiceMarkers("[voice:a] One. [voice:b] Two."), "One. Two.")
    assert.isTrue(isUnfinishedMarker("[voi"))
    assert.isTrue(isUnfinishedMarker(" [voice: expr"))
    assert.isFalse(isUnfinishedMarker("[voice:a]"))
    assert.isFalse(isUnfinishedMarker("[note"))
    assert.isFalse(isUnfinishedMarker("Hello"))
  })

  it.effect("the stream stripper handles markers split across deltas and leaves other text alone", () =>
    Effect.gen(function*() {
      const run = (deltas: Array<string>) => Effect.map(Stream.runCollect(stripVoiceMarkersStream(Stream.fromIterable(deltas))), (o) => o.join(""))
      assert.strictEqual(yield* run(["[vo", "ice:exp", "ressive]", " Jingle", " bells."]), "Jingle bells.")
      assert.strictEqual(yield* run(["Sure. [voice:", "b] Ho."]), "Sure. Ho.")
      assert.strictEqual(yield* run(["A [list] of ", "[things]"]), "A [list] of [things]")
      assert.strictEqual(yield* run(["Ends with [vo"]), "Ends with [vo")
    }))
})

describe("chunker and markers", () => {
  const run = (deltas: ReadonlyArray<string>) => Stream.runCollect(Stream.fromIterable(deltas).pipe(chunkClauses()))

  it.effect("keeps a marker in one piece, even with a space after the colon", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* run(["[voice:", " expressive] Ho", " ho ho! Merry Christmas."]), [
        "[voice: expressive] Ho ho ho!",
        "Merry Christmas."
      ])
      assert.deepStrictEqual(yield* run(["Sure. [voice:exp", "ressive] La la. Done."]), ["Sure.", "[voice:expressive] La la.", "Done."])
    }))

  it.effect("the marker does not count towards the first clause's comma minimum", () =>
    Effect.gen(function*() {
      // Without a marker, "Oh, " is too short (minimum 12) to end the first clause; the marker does not change that.
      assert.deepStrictEqual(yield* run(["Oh, hello there, friend."]), ["Oh, hello there,", "friend."])
      assert.deepStrictEqual(yield* run(["[voice:expressive] Oh, hello there, friend."]), [
        "[voice:expressive] Oh, hello there,",
        "friend."
      ])
    }))

  it("resampler: identity when rates match, seamless across chunk boundaries", () => {
    const same = makeResampler(24_000, 24_000)
    const chunk = new Uint8Array([1, 2, 3, 4])
    assert.strictEqual(same(chunk), chunk)
    // A ramp split into odd-sized, odd-byte chunks resamples like the whole ramp.
    const ramp = new Int16Array(Array.from({ length: 1000 }, (_, i) => i * 10))
    const bytes = new Uint8Array(ramp.buffer)
    const whole = makeResampler(16_000, 24_000)(bytes)
    const r = makeResampler(16_000, 24_000)
    const parts = [r(bytes.subarray(0, 333)), r(bytes.subarray(333, 1001)), r(bytes.subarray(1001))]
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) {
      joined.set(p, o)
      o += p.length
    }
    assert.deepStrictEqual([...new Int16Array(joined.buffer)], [...new Int16Array(whole.slice().buffer)])
  })
})
