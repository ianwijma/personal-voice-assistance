import { assert, describe, it } from "@effect/vitest"
import { CurrentTurnTrace, type PlaybackObserver, type Trace } from "@pva/core"
import { decodeReplyFrame, MAX_FRAME_PAYLOAD_BYTES, type ServerMessage } from "@pva/protocol"
import { Effect, Exit, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { type AudioClientLink, makeWebAudio, NOISE_FLOOR_AMPLITUDE, type PlaybackEvent } from "../src/WebAudio.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const fakeLink = () => {
  const messages: Array<ServerMessage> = []
  const frames: Array<{ turnId: number; bytes: number }> = []
  const link: AudioClientLink = {
    sendMessage: (m) => messages.push(m),
    sendBinary: (f) => {
      const decoded = decodeReplyFrame(f)
      if (!decoded.ok) throw new Error(decoded.error)
      frames.push({ turnId: decoded.frame.turnId, bytes: decoded.frame.pcm.length })
    }
  }
  return { link, messages, frames, types: () => messages.map((m) => m.type) }
}

const recordingObserver = () => {
  const calls: Array<string> = []
  const observer: PlaybackObserver = {
    started: () => calls.push("started"),
    progress: (n) => calls.push(`progress ${n}`)
  }
  return { observer, calls }
}

const trace = (id: number): Trace => ({ id, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] })
const pcm = (samples: number) => new Uint8Array(samples * 2)

describe("WebAudioInput", () => {
  it.effect("no owner: a real-time noise floor; owner with live mic: its frames; mic off or suppressed: noise again", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const got: Array<Uint8Array> = []
      yield* web.input.stream.pipe(Stream.runForEach((c) => Effect.sync(() => got.push(c))), Effect.forkChild)
      yield* advance(100)
      assert.strictEqual(got.length, 5, "one 20 ms frame per 20 ms")
      const samples = new Int16Array(got[0]!.buffer)
      assert.strictEqual(samples.length, 320)
      assert.isTrue(samples.every((s) => Math.abs(s) <= NOISE_FLOOR_AMPLITUDE) && samples.some((s) => s !== 0))

      const owner = fakeLink()
      web.setOwner(owner.link)
      web.micFrame(pcm(320).fill(7))
      assert.isFalse(web.micRouted(), "the microphone is not live yet")
      web.setMicLive(true)
      got.length = 0
      yield* advance(100)
      assert.strictEqual(got.length, 0, "no noise while the owner's microphone is routed, and the server invents no audio")
      const frame = pcm(320).fill(9)
      web.micFrame(frame)
      yield* Effect.yieldNow
      assert.deepStrictEqual(got, [frame])

      web.setSuppressed(true)
      web.micFrame(pcm(320).fill(9))
      yield* advance(40)
      assert.strictEqual(got.length, 3, "suppressed: frames are ignored and the noise floor resumes")
      web.setSuppressed(false)
      web.setOwner(undefined)
      got.length = 0
      yield* advance(40)
      assert.strictEqual(got.length, 2, "owner gone: noise floor")
    }).pipe(Effect.scoped))
})

describe("WebAudioOutput.play", () => {
  it.effect("sends reply.start, frames at once (split over the payload limit), reply.end; returns after playback.finished", () =>
    Effect.gen(function*() {
      const events: Array<PlaybackEvent> = []
      const web = yield* makeWebAudio({ onPlayback: (e) => events.push(e) })
      const owner = fakeLink()
      web.setOwner(owner.link)
      const { calls, observer } = recordingObserver()
      const tr = trace(12)
      const big = pcm(MAX_FRAME_PAYLOAD_BYTES / 2 + 100)
      const fiber = yield* web.output.play(Stream.make(pcm(480), big), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, tr),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      assert.deepStrictEqual(owner.types(), ["reply.start", "reply.end"])
      assert.deepStrictEqual(owner.messages[0], { type: "reply.start", turnId: 12, sampleRate: 22_050 })
      assert.deepStrictEqual(owner.frames, [
        { turnId: 12, bytes: 960 },
        { turnId: 12, bytes: MAX_FRAME_PAYLOAD_BYTES },
        { turnId: 12, bytes: 200 }
      ])
      assert.strictEqual(web.playingTurn(), 12)
      web.report({ type: "playback.started", turnId: 12, outputLatencyMs: 21, startDelayMs: 3 })
      web.report({ type: "playback.progress", turnId: 99, playedSamples: 5, underruns: 0 }) // another reply: ignored
      web.report({ type: "playback.progress", turnId: 12, playedSamples: 1000, underruns: 0 })
      web.report({ type: "playback.finished", turnId: 12, playedSamples: 2000 })
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(calls, ["started", "progress 1000", "progress 2000"])
      assert.deepStrictEqual(tr.client, { outputLatencyMs: 21, startDelayMs: 3 })
      assert.deepStrictEqual(events, [{ _tag: "started", turnId: 12 }, { _tag: "ended", turnId: 12, reason: "finished" }])
      assert.strictEqual(web.playingTurn(), undefined)
    }).pipe(Effect.scoped))

  it.effect("protocol 7: reply.start names the turn's assistant when the trace has one, and omits assistantId otherwise", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const owner = fakeLink()
      web.setOwner(owner.link)
      const named: Trace = { ...trace(20), assistant: { id: "jarvis", name: "Jarvis" } }
      for (const tr of [named, trace(21)]) {
        const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050).pipe(
          Effect.provideService(CurrentTurnTrace, tr),
          Effect.forkChild
        )
        yield* Effect.yieldNow
        web.report({ type: "playback.finished", turnId: tr.id, playedSamples: 100 })
        yield* Fiber.join(fiber)
      }
      const starts = owner.messages.filter((m) => m.type === "reply.start")
      assert.deepStrictEqual(starts, [
        { type: "reply.start", turnId: 20, sampleRate: 22_050, assistantId: "jarvis" },
        { type: "reply.start", turnId: 21, sampleRate: 22_050 }
      ])
    }).pipe(Effect.scoped))

  it.effect("no owner: fails at once", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const exit = yield* Effect.exit(web.output.play(Stream.make(pcm(10)), 22_050))
      assert.isTrue(Exit.isFailure(exit))
    }).pipe(Effect.scoped))

  it.effect("interrupted: sends reply.stop, waits for playback.stopped, reports its count as final", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const owner = fakeLink()
      web.setOwner(owner.link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(3)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 3, outputLatencyMs: 0, startDelayMs: 0 })
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Effect.yieldNow
      assert.deepStrictEqual(owner.messages.at(-1), { type: "reply.stop", turnId: 3 })
      web.report({ type: "playback.stopped", turnId: 3, playedSamples: 40 })
      web.report({ type: "playback.stopped", turnId: 3, playedSamples: 50 }) // the first final count wins
      yield* Fiber.join(interrupting)
      assert.deepStrictEqual(calls, ["started", "progress 40", "progress 40"])
    }).pipe(Effect.scoped))

  it.effect("interrupted without an answer: gives up after 300 ms and keeps the last progress", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      web.setOwner(fakeLink().link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(4)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.progress", turnId: 4, playedSamples: 30, underruns: 0 })
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* advance(300)
      yield* Fiber.join(interrupting)
      assert.deepStrictEqual(calls, ["progress 30", "progress 30"])
    }).pipe(Effect.scoped))

  it.effect("stall: no report for 2 s after all audio was sent → reply.stop and a playback_timeout failure", () =>
    Effect.gen(function*() {
      const stalls: Array<number> = []
      const web = yield* makeWebAudio({ onStall: (id) => stalls.push(id) })
      const owner = fakeLink()
      web.setOwner(owner.link)
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050).pipe(
        Effect.provideService(CurrentTurnTrace, trace(5)),
        Effect.forkChild
      )
      yield* advance(1_500)
      web.report({ type: "playback.progress", turnId: 5, playedSamples: 50, underruns: 0 }) // resets the timer
      yield* advance(1_750)
      assert.strictEqual(stalls.length, 0)
      yield* advance(500)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(owner.messages.at(-1), { type: "reply.stop", turnId: 5 })
      assert.deepStrictEqual(stalls, [5])
    }).pipe(Effect.scoped))

  it.effect("takeover: no more audio to the old owner; its answer to reply.stop is the final count; nobody else may report", () =>
    Effect.gen(function*() {
      const events: Array<PlaybackEvent> = []
      const web = yield* makeWebAudio({ onPlayback: (e) => events.push(e) })
      const first = fakeLink()
      web.setOwner(first.link)
      const { calls, observer } = recordingObserver()
      const audio = Stream.make(pcm(100)).pipe(Stream.concat(Stream.fromEffect(Effect.as(Effect.sleep(50), pcm(100)))))
      const fiber = yield* web.output.play(audio, 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(8)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 8, outputLatencyMs: 0, startDelayMs: 0 }, first.link)
      web.report({ type: "playback.progress", turnId: 8, playedSamples: 20, underruns: 0 }, first.link)
      const second = fakeLink()
      web.setOwner(second.link)
      assert.deepStrictEqual(first.messages.at(-1), { type: "reply.stop", turnId: 8 })
      yield* advance(100)
      assert.strictEqual(first.frames.length, 1, "the audio produced after the takeover is not sent to the old owner")
      assert.strictEqual(second.frames.length, 0, "nor to the new one")
      // The new owner (or anyone else) cannot report on a reply it was not playing.
      web.report({ type: "playback.stopped", turnId: 8, playedSamples: 99 }, second.link)
      web.report({ type: "playback.stopped", turnId: 8, playedSamples: 98 })
      yield* Effect.yieldNow
      assert.isUndefined(fiber.pollUnsafe(), "still waiting for the old owner")
      // The old owner's answer is the count history gets.
      web.report({ type: "playback.stopped", turnId: 8, playedSamples: 70 }, first.link)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(calls, ["started", "progress 20", "progress 70", "progress 70"])
      assert.deepStrictEqual(events.map((e) => e._tag === "ended" ? e.reason : e._tag), ["started", "failed"])
    }).pipe(Effect.scoped))

  it.effect("takeover while interrupted: the interruption also waits (bounded) for the old owner's count", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const first = fakeLink()
      web.setOwner(first.link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(9)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 9, outputLatencyMs: 0, startDelayMs: 0 })
      // The hub interrupts the turn and moves the audio in the same instant (audio.claim).
      web.setOwner(fakeLink().link)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Effect.yieldNow
      web.report({ type: "playback.stopped", turnId: 9, playedSamples: 55 }, first.link)
      yield* Fiber.join(interrupting)
      assert.deepStrictEqual(calls.at(-1), "progress 55")
      assert.strictEqual(first.messages.filter((m) => m.type === "reply.stop").length, 1, "one reply.stop")
    }).pipe(Effect.scoped))

  it.effect("owner lost mid-reply (disconnect): fails; takeover also tells the old owner to stop", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const first = fakeLink()
      web.setOwner(first.link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(6)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.progress", turnId: 6, playedSamples: 20, underruns: 0 })
      const second = fakeLink()
      web.setOwner(second.link)
      // The old owner does not answer its reply.stop: the reply ends after the 300 ms wait with the last count.
      yield* advance(300)
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(first.messages.at(-1), { type: "reply.stop", turnId: 6 })
      assert.deepStrictEqual(second.messages, [], "the new owner gets nothing of the old reply")
      assert.deepStrictEqual(calls, ["progress 20", "progress 20"])

      const fiber2 = yield* web.output.play(Stream.make(pcm(100)), 22_050).pipe(
        Effect.provideService(CurrentTurnTrace, trace(7)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.setOwner(undefined)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber2)))
      assert.deepStrictEqual(second.types(), ["reply.start", "reply.end"], "a closed socket gets no reply.stop")
    }).pipe(Effect.scoped))

  it.effect("the browser stopping on its own (Stop pressed) does not end play: it waits for the interruption", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      web.setOwner(fakeLink().link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(8)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.stopped", turnId: 8, playedSamples: 10 })
      yield* advance(500)
      assert.isUndefined(fiber.pollUnsafe())
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(calls, ["progress 10", "progress 10"])
    }).pipe(Effect.scoped))

  it.effect("the reply's audio fails upstream mid-reply: reply.stop, waits for playback.stopped while still accepting it, final count reported", () =>
    Effect.gen(function*() {
      const events: Array<PlaybackEvent> = []
      const web = yield* makeWebAudio({ onPlayback: (e) => events.push(e) })
      const owner = fakeLink()
      web.setOwner(owner.link)
      const { calls, observer } = recordingObserver()
      const audio = Stream.concat(Stream.make(pcm(100)), Stream.fail(new Error("the speech engine crashed")))
      const fiber = yield* web.output.play(audio, 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(9)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 9, outputLatencyMs: 0, startDelayMs: 0 })
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      assert.deepStrictEqual(owner.messages.at(-1), { type: "reply.stop", turnId: 9 }, "the browser is told to stop the audio it buffered")
      assert.strictEqual(web.playingTurn(), 9, "the session stays active while the final report is awaited")
      assert.isUndefined(fiber.pollUnsafe())
      web.report({ type: "playback.stopped", turnId: 9, playedSamples: 60 })
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit), "play still fails (the turn is failed)")
      assert.deepStrictEqual(calls, ["started", "progress 60", "progress 60"])
      assert.isUndefined(web.playingTurn())
      assert.deepStrictEqual(events.at(-1), { _tag: "ended", turnId: 9, reason: "failed" })
    }).pipe(Effect.scoped))

  it.effect("upstream failure without an answer from the browser: gives up after 300 ms", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const owner = fakeLink()
      web.setOwner(owner.link)
      const fiber = yield* web.output.play(Stream.concat(Stream.make(pcm(100)), Stream.fail(new Error("boom"))), 22_050).pipe(
        Effect.provideService(CurrentTurnTrace, trace(10)),
        Effect.forkChild
      )
      yield* advance(299)
      assert.isUndefined(fiber.pollUnsafe())
      yield* advance(10)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)))
      assert.deepStrictEqual(owner.types(), ["reply.start", "reply.stop"])
    }).pipe(Effect.scoped))

  it.effect("a stall stops the reply once: no second reply.stop and no extra wait", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const owner = fakeLink()
      web.setOwner(owner.link)
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050).pipe(
        Effect.provideService(CurrentTurnTrace, trace(11)),
        Effect.forkChild
      )
      yield* advance(2_250)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)))
      assert.deepStrictEqual(owner.types(), ["reply.start", "reply.end", "reply.stop"])
    }).pipe(Effect.scoped))
})

describe("WebAudioInput: bounds", () => {
  it.effect("the microphone queue is bounded in bytes: huge frames from a runaway owner keep at most ~3 s of audio", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const owner = fakeLink()
      web.setOwner(owner.link)
      web.setMicLive(true)
      // Nobody consumes yet: 100 frames of 8 s each (256 000 bytes) arrive; the queue keeps ~3 s of them.
      for (let i = 0; i < 100; i++) web.micFrame(pcm(128_000))
      const got: Array<Uint8Array> = []
      yield* web.input.stream.pipe(Stream.runForEach((c) => Effect.sync(() => got.push(c))), Effect.forkChild)
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      // The first consumer takes what was queued before it (a voice session's first frames), at most the cap.
      const before = got.reduce((n, c) => n + c.length, 0)
      assert.isAtMost(before, 96_000, `bytes queued before the consumer: ${before}`)
      // Feed again while it runs.
      for (let i = 0; i < 400; i++) web.micFrame(pcm(320))
      for (let i = 0; i < 100; i++) web.micFrame(pcm(128_000))
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      const bytes = got.reduce((n, c) => n + c.length, 0) - before
      // Everything above was offered without a yield, so what the consumer got is what the queue held at once.
      assert.isAtMost(bytes, 96_000, `bytes queued: ${bytes}`)
      assert.isTrue(web.inputStats().droppedFrames > 0)
    }).pipe(Effect.scoped))

  it.effect("one frame larger than the cap (the largest valid one, 262 144 bytes) keeps only its newest 96 000 bytes", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      web.setOwner(fakeLink().link)
      web.setMicLive(true)
      const got: Array<Uint8Array> = []
      yield* web.input.stream.pipe(Stream.runForEach((c) => Effect.sync(() => got.push(c))), Effect.forkChild)
      yield* Effect.yieldNow
      // Each sample holds its own index, so the test can see which part of the frame was kept.
      const samples = new Int16Array(MAX_FRAME_PAYLOAD_BYTES / 2).map((_, i) => i % 32_000)
      const frame = new Uint8Array(samples.buffer)
      web.micFrame(pcm(320))
      web.micFrame(frame)
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      assert.deepStrictEqual(got.map((c) => c.length), [96_000], "the small frame before it was dropped too: the cap is for the whole queue")
      assert.deepStrictEqual([...got[0]!], [...frame.subarray(frame.length - 96_000)])
      assert.isTrue(web.inputStats().droppedFrames >= 2)
    }).pipe(Effect.scoped))
})

/**
 * `playback.stopped { exact: false }`: the page's best count, sent before its player confirmed. The server keeps
 * waiting within the same 300 ms deadline (from the stop request) for an exact report from the same link and reply,
 * and takes the provisional count only if none comes.
 */
describe("WebAudioOutput.play: provisional final counts", () => {
  type Mode = "interrupted" | "takeover"

  /** A reply to turn 20 that played 20 samples, then is stopped: by an interruption, or by another tab taking the audio. */
  const stopping = (mode: Mode) =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const first = fakeLink()
      web.setOwner(first.link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(20)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 20, outputLatencyMs: 0, startDelayMs: 0 }, first.link)
      web.report({ type: "playback.progress", turnId: 20, playedSamples: 20, underruns: 0 }, first.link)
      const second = fakeLink()
      let ending: Fiber.Fiber<unknown, unknown>
      if (mode === "interrupted") {
        ending = yield* Effect.forkChild(Fiber.interrupt(fiber))
      } else {
        web.setOwner(second.link)
        ending = fiber
      }
      yield* Effect.yieldNow
      assert.deepStrictEqual(first.messages.at(-1), { type: "reply.stop", turnId: 20 })
      const stopped = (playedSamples: number, exact?: boolean, from: AudioClientLink = first.link) =>
        web.report({ type: "playback.stopped", turnId: 20, playedSamples, ...(exact === undefined ? {} : { exact }) }, from)
      return {
        web,
        calls,
        second,
        stopped,
        /** Whether the reply has ended (its final count is reported). */
        ended: () => ending.pollUnsafe() !== undefined,
        settle: Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), Fiber.await(ending)),
        /** The counts reported after the reply's own 20, in order. */
        finals: () => calls.slice(calls.indexOf("progress 20") + 1)
      }
    })

  for (const mode of ["interrupted", "takeover"] as const) {
    describe(mode, () => {
      for (const [name, exactCount] of [["lower", 60], ["equal", 80], ["higher", 95]] as const) {
        it.effect(`provisional then exact within the deadline (${name}): the exact count is final, at once`, () =>
          Effect.gen(function*() {
            const s = yield* stopping(mode)
            s.stopped(80, false)
            yield* advance(100)
            assert.isFalse(s.ended(), "a provisional count does not end the wait")
            assert.deepStrictEqual(s.finals(), [], "nor is it reported")
            s.stopped(exactCount, true)
            yield* Effect.repeat(Effect.yieldNow, { times: 50 })
            assert.isTrue(s.ended(), "an exact report ends the wait at once (100 ms into the 300)")
            yield* s.settle
            assert.deepStrictEqual(s.finals(), [`progress ${exactCount}`, `progress ${exactCount}`])
            assert.isUndefined(s.web.playingTurn())
          }).pipe(Effect.scoped))
      }

      it.effect("provisional then exact without the field (an older page's answer): exact, used", () =>
        Effect.gen(function*() {
          const s = yield* stopping(mode)
          s.stopped(80, false)
          s.stopped(70)
          yield* s.settle
          assert.deepStrictEqual(s.finals(), ["progress 70", "progress 70"])
        }).pipe(Effect.scoped))

      it.effect("provisional then nothing: the provisional count is final when the deadline passes (not the last progress)", () =>
        Effect.gen(function*() {
          const s = yield* stopping(mode)
          yield* advance(200)
          s.stopped(80, false)
          yield* advance(99)
          assert.isFalse(s.ended(), "still waiting at 299 ms")
          yield* advance(1)
          yield* s.settle
          assert.deepStrictEqual(s.finals(), ["progress 80", "progress 80"])
          s.stopped(60, true) // too late: the reply is finalised
          assert.deepStrictEqual(s.finals(), ["progress 80", "progress 80"])
        }).pipe(Effect.scoped))

      it.effect("the deadline is not extended by a provisional count: an exact one after 300 ms is ignored", () =>
        Effect.gen(function*() {
          const s = yield* stopping(mode)
          yield* advance(250)
          s.stopped(80, false)
          yield* advance(50)
          yield* s.settle
          assert.deepStrictEqual(s.finals(), ["progress 80", "progress 80"], "ended at 300 ms from the stop request")
        }).pipe(Effect.scoped))

      it.effect("provisional then a second provisional: the second is ignored; the wait goes on for an exact one", () =>
        Effect.gen(function*() {
          const s = yield* stopping(mode)
          s.stopped(80, false)
          s.stopped(90, false)
          yield* advance(100)
          assert.isFalse(s.ended())
          yield* advance(200)
          yield* s.settle
          assert.deepStrictEqual(s.finals(), ["progress 80", "progress 80"], "the first provisional count, at the deadline")
        }).pipe(Effect.scoped))

      it.effect("two provisional counts, then an exact one: the exact one is used", () =>
        Effect.gen(function*() {
          const s = yield* stopping(mode)
          s.stopped(80, false)
          s.stopped(90, false)
          yield* advance(100)
          s.stopped(85, true)
          yield* s.settle
          assert.deepStrictEqual(s.finals(), ["progress 85", "progress 85"])
        }).pipe(Effect.scoped))

      it.effect("exact first: final at once; a later report of either kind is ignored", () =>
        Effect.gen(function*() {
          const s = yield* stopping(mode)
          s.stopped(70, true)
          s.stopped(90, false)
          s.stopped(95, true)
          yield* Effect.repeat(Effect.yieldNow, { times: 50 })
          assert.isTrue(s.ended())
          yield* s.settle
          assert.deepStrictEqual(s.finals(), ["progress 70", "progress 70"])
        }).pipe(Effect.scoped))

      it.effect("reports from another link or for another reply never count, provisional or exact", () =>
        Effect.gen(function*() {
          const s = yield* stopping(mode)
          const stranger = fakeLink()
          s.stopped(99, false, s.second.link)
          s.stopped(98, true, s.second.link)
          s.stopped(97, false, stranger.link)
          s.web.report({ type: "playback.stopped", turnId: 21, playedSamples: 96, exact: false }, s.second.link)
          s.web.report({ type: "playback.stopped", turnId: 21, playedSamples: 96 })
          yield* advance(100)
          assert.isFalse(s.ended())
          s.stopped(80, false)
          s.stopped(94, true, stranger.link)
          yield* advance(200)
          yield* s.settle
          assert.deepStrictEqual(s.finals(), ["progress 80", "progress 80"])
        }).pipe(Effect.scoped))
    })
  }

  it.effect("no stop requested yet (Stop pressed on the page): a provisional count waits for the interruption, whose answer is used", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const owner = fakeLink()
      web.setOwner(owner.link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(22)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.stopped", turnId: 22, playedSamples: 30, exact: false })
      yield* advance(500)
      assert.isUndefined(fiber.pollUnsafe())
      assert.deepStrictEqual(calls, [])
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* Effect.yieldNow
      assert.deepStrictEqual(owner.messages.at(-1), { type: "reply.stop", turnId: 22 }, "the count is not final yet: ask again")
      web.report({ type: "playback.stopped", turnId: 22, playedSamples: 28, exact: true })
      yield* Fiber.join(interrupting)
      assert.deepStrictEqual(calls, ["progress 28", "progress 28"])
    }).pipe(Effect.scoped))

  it.effect("a provisional count (page closing) followed by the socket closing is used, not the last progress", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      web.setOwner(fakeLink().link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(23)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.progress", turnId: 23, playedSamples: 20, underruns: 0 })
      web.report({ type: "playback.stopped", turnId: 23, playedSamples: 45, exact: false })
      web.setOwner(undefined)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)))
      assert.deepStrictEqual(calls, ["progress 20", "progress 45"])
    }).pipe(Effect.scoped))

  it.effect("a provisional count and then silence while all audio was sent: the stall still fires, and the count is kept", () =>
    Effect.gen(function*() {
      const stalls: Array<number> = []
      const web = yield* makeWebAudio({ onStall: (id) => stalls.push(id) })
      web.setOwner(fakeLink().link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(24)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.stopped", turnId: 24, playedSamples: 33, exact: false })
      yield* advance(2_250)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)))
      assert.deepStrictEqual(stalls, [24])
      assert.deepStrictEqual(calls, ["progress 33"])
    }).pipe(Effect.scoped))
})

describe("WebAudioOutput.play: reported counts are bounded by the audio sent (fifth review)", () => {
  /** A reply to turn 30 of 100 samples, sent; the page has started playing it. */
  const sent100 = (more: Stream.Stream<Uint8Array> = Stream.empty) =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const web = yield* makeWebAudio({ log: (line) => logs.push(line) })
      const first = fakeLink()
      web.setOwner(first.link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.concat(Stream.make(pcm(100)), more), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(30)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 30, outputLatencyMs: 0, startDelayMs: 0 }, first.link)
      return { web, first, calls, fiber, logs }
    })

  it.effect("a provisional count beyond the audio sent, made final by the deadline: clamped to 100", () =>
    Effect.gen(function*() {
      const s = yield* sent100(Stream.never)
      s.web.report({ type: "playback.stopped", turnId: 30, playedSamples: 1_000_000, exact: false }, s.first.link)
      const ending = yield* Effect.forkChild(Fiber.interrupt(s.fiber))
      yield* advance(300)
      yield* Fiber.await(ending)
      assert.deepStrictEqual(s.calls, ["started", "progress 100", "progress 100"])
      assert.strictEqual(s.logs.length, 1, "logged once")
    }).pipe(Effect.scoped))

  it.effect("an exact stop, a finish and progress beyond the audio sent: clamped to 100", () =>
    Effect.gen(function*() {
      const s = yield* sent100()
      s.web.report({ type: "playback.progress", turnId: 30, playedSamples: 1_000_000, underruns: 0 }, s.first.link)
      assert.deepStrictEqual(s.calls, ["started", "progress 100"])
      s.web.report({ type: "playback.finished", turnId: 30, playedSamples: 1_000_000 }, s.first.link)
      yield* Fiber.join(s.fiber)
      assert.deepStrictEqual(s.calls, ["started", "progress 100", "progress 100"])

      const t = yield* sent100(Stream.never)
      const ending = yield* Effect.forkChild(Fiber.interrupt(t.fiber))
      yield* Effect.yieldNow
      t.web.report({ type: "playback.stopped", turnId: 30, playedSamples: 1_000_000, exact: true }, t.first.link)
      yield* Fiber.await(ending)
      assert.deepStrictEqual(t.calls, ["started", "progress 100", "progress 100"])
    }).pipe(Effect.scoped))

  it.effect("takeover: audio pulled after the cut is not counted; the old owner's inflated count is clamped to what it was sent", () =>
    Effect.gen(function*() {
      let web: import("../src/WebAudio.ts").WebAudio | undefined
      const second = fakeLink()
      // The second chunk is pulled after another tab took the audio (in the same instant), and is not sent.
      const more = Stream.fromEffect(Effect.sync(() => {
        web!.setOwner(second.link)
        return pcm(200)
      }))
      const s = yield* sent100(more)
      web = s.web
      yield* Effect.repeat(Effect.yieldNow, { times: 10 })
      assert.strictEqual(s.first.frames.reduce((n, f) => n + f.bytes, 0), 200, "100 samples sent")
      s.web.report({ type: "playback.stopped", turnId: 30, playedSamples: 1_000_000 }, s.first.link)
      yield* advance(300)
      yield* Fiber.await(s.fiber)
      assert.deepStrictEqual(s.calls.slice(-1), ["progress 100"])
      assert.deepStrictEqual(second.frames, [])
    }).pipe(Effect.scoped))

  it.effect("malformed counts: fractions round down, negative or not finite are ignored; a decrease is ignored; started before any audio is ignored", () =>
    Effect.gen(function*() {
      const s = yield* sent100()
      s.web.report({ type: "playback.progress", turnId: 30, playedSamples: 50.7, underruns: 0 }, s.first.link)
      s.web.report({ type: "playback.progress", turnId: 30, playedSamples: -5, underruns: 0 }, s.first.link)
      s.web.report({ type: "playback.progress", turnId: 30, playedSamples: Number.NaN, underruns: 0 }, s.first.link)
      s.web.report({ type: "playback.progress", turnId: 30, playedSamples: 40, underruns: 0 }, s.first.link)
      assert.deepStrictEqual(s.calls, ["started", "progress 50"])
      s.web.report({ type: "playback.finished", turnId: 30, playedSamples: Number.POSITIVE_INFINITY }, s.first.link)
      s.web.report({ type: "playback.finished", turnId: 30, playedSamples: 90 }, s.first.link)
      yield* Fiber.join(s.fiber)
      assert.deepStrictEqual(s.calls, ["started", "progress 50", "progress 90"])
      assert.strictEqual(s.logs.length, 1, "one log line for the burst (rate-limited)")
      assert.match(s.logs[0]!, /playback report/)

      // A page that says it started before it was sent any audio.
      const web = yield* makeWebAudio()
      const link = fakeLink()
      web.setOwner(link.link)
      const r = recordingObserver()
      const fiber = yield* web.output.play(Stream.never, 22_050, r.observer).pipe(Effect.provideService(CurrentTurnTrace, trace(31)), Effect.forkChild)
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 31, outputLatencyMs: 0, startDelayMs: 0 }, link.link)
      assert.deepStrictEqual(r.calls, [])
      const ending = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* advance(300)
      yield* Fiber.await(ending)
    }).pipe(Effect.scoped))
})

describe("WebAudioOutput.play: the authoritative final count (sixth review)", () => {
  /** An observer with `final`: records every call, so "exactly once, after the last progress" is checkable. */
  const finalObserver = () => {
    const calls: Array<string> = []
    const observer: PlaybackObserver = {
      started: () => calls.push("started"),
      progress: (n) => calls.push(`progress ${n}`),
      final: (n) => calls.push(`final ${n}`)
    }
    const finals = () => calls.filter((c) => c.startsWith("final"))
    /** `final` was called once, as the last call, with `count`. */
    const once = (count: number) => {
      assert.deepStrictEqual(finals(), [`final ${count}`], calls.join(", "))
      assert.strictEqual(calls.at(-1), `final ${count}`, "after the last progress")
    }
    return { observer, calls, once }
  }

  /** A reply to turn 40: 100 samples sent at once, then `more`; started, progress 80. */
  const playing = (more: Stream.Stream<Uint8Array, Error> = Stream.empty, options: Parameters<typeof makeWebAudio>[0] = {}) =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const web = yield* makeWebAudio({ log: (line) => logs.push(line), ...options })
      const first = fakeLink()
      web.setOwner(first.link)
      const o = finalObserver()
      const fiber = yield* web.output.play(Stream.concat(Stream.make(pcm(100)), more), 22_050, o.observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(40)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 40, outputLatencyMs: 0, startDelayMs: 0 }, first.link)
      web.report({ type: "playback.progress", turnId: 40, playedSamples: 80, underruns: 0 }, first.link)
      const stopped = (playedSamples: number, exact?: boolean, from: AudioClientLink = first.link) =>
        web.report({ type: "playback.stopped", turnId: 40, playedSamples, ...(exact === undefined ? {} : { exact }) }, from)
      return { web, first, fiber, logs, stopped, ...o }
    })

  it.effect("the reviewer's case: progress 80, then an exact stop of 60: progress stays monotonic, final is 60", () =>
    Effect.gen(function*() {
      const s = yield* playing(Stream.never)
      const ending = yield* Effect.forkChild(Fiber.interrupt(s.fiber))
      yield* Effect.yieldNow
      s.stopped(60, true)
      yield* Fiber.await(ending)
      assert.isTrue(s.calls.filter((c) => c.startsWith("progress")).every((c) => c === "progress 80"), s.calls.join(", "))
      s.once(60)
    }).pipe(Effect.scoped))

  it.effect("finished: final is the page's count (also when it is below the last progress)", () =>
    Effect.gen(function*() {
      const s = yield* playing()
      s.web.report({ type: "playback.finished", turnId: 40, playedSamples: 100 }, s.first.link)
      yield* Fiber.join(s.fiber)
      s.once(100)

      const t = yield* playing()
      t.web.report({ type: "playback.finished", turnId: 40, playedSamples: 70 }, t.first.link)
      yield* Fiber.join(t.fiber)
      t.once(70)
    }).pipe(Effect.scoped))

  it.effect("stopped by the page on its own (Stop pressed), then interrupted: final once, the page's count", () =>
    Effect.gen(function*() {
      const s = yield* playing()
      s.stopped(65)
      yield* advance(100)
      assert.deepStrictEqual(s.calls.filter((c) => c.startsWith("final")), [], "not before play ends")
      yield* Fiber.interrupt(s.fiber)
      s.once(65)
    }).pipe(Effect.scoped))

  it.effect("provisional then exact (lower): final is the exact count", () =>
    Effect.gen(function*() {
      const s = yield* playing(Stream.never)
      const ending = yield* Effect.forkChild(Fiber.interrupt(s.fiber))
      yield* Effect.yieldNow
      s.stopped(90, false)
      yield* advance(50)
      s.stopped(55, true)
      yield* Fiber.await(ending)
      s.once(55)
    }).pipe(Effect.scoped))

  it.effect("provisional then the deadline: final is the provisional count, even below the last progress", () =>
    Effect.gen(function*() {
      const s = yield* playing(Stream.never)
      const ending = yield* Effect.forkChild(Fiber.interrupt(s.fiber))
      yield* Effect.yieldNow
      s.stopped(50, false)
      yield* advance(300)
      yield* Fiber.await(ending)
      s.once(50)
    }).pipe(Effect.scoped))

  it.effect("interrupted without any answer: final is the last progress", () =>
    Effect.gen(function*() {
      const s = yield* playing(Stream.never)
      const ending = yield* Effect.forkChild(Fiber.interrupt(s.fiber))
      yield* advance(300)
      yield* Fiber.await(ending)
      s.once(80)
    }).pipe(Effect.scoped))

  it.effect("takeover: final is the old owner's exact count, lower than its progress", () =>
    Effect.gen(function*() {
      const s = yield* playing(Stream.never)
      s.web.setOwner(fakeLink().link)
      yield* Effect.yieldNow
      s.stopped(62, true)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(s.fiber)))
      s.once(62)
    }).pipe(Effect.scoped))

  it.effect("upstream failure: final is the page's answer to reply.stop", () =>
    Effect.gen(function*() {
      const s = yield* playing(Stream.fail(new Error("the speech engine crashed")))
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      s.stopped(58, true)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(s.fiber)))
      s.once(58)
    }).pipe(Effect.scoped))

  it.effect("stall: final is the last valid count (the provisional one when there is one)", () =>
    Effect.gen(function*() {
      const s = yield* playing()
      yield* advance(2_250)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(s.fiber)))
      s.once(80)

      const t = yield* playing()
      t.stopped(45, false)
      yield* advance(2_250)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(t.fiber)))
      t.once(45)
    }).pipe(Effect.scoped))

  it.effect("owner lost (socket closed): final is the last progress, or the provisional count", () =>
    Effect.gen(function*() {
      const s = yield* playing(Stream.never)
      s.web.setOwner(undefined)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(s.fiber)))
      s.once(80)

      const t = yield* playing(Stream.never)
      t.stopped(30, false)
      t.web.setOwner(undefined)
      assert.isTrue(Exit.isFailure(yield* Fiber.await(t.fiber)))
      t.once(30)
    }).pipe(Effect.scoped))

  it.effect("an observer without `final` (older conversations) still works", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      const link = fakeLink()
      web.setOwner(link.link)
      const { calls, observer } = recordingObserver()
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(41)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.finished", turnId: 41, playedSamples: 100 }, link.link)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(calls, ["progress 100"])
    }).pipe(Effect.scoped))
})

describe("WebAudioOutput.play: playback.finished before reply.end (sixth review)", () => {
  it.effect("a finish while audio is still being produced is ignored (logged); the reply goes on and its real finish counts", () =>
    Effect.gen(function*() {
      const logs: Array<string> = []
      const web = yield* makeWebAudio({ log: (line) => logs.push(line) })
      const link = fakeLink()
      web.setOwner(link.link)
      const calls: Array<string> = []
      const observer: PlaybackObserver = {
        started: () => calls.push("started"),
        progress: (n) => calls.push(`progress ${n}`),
        final: (n) => calls.push(`final ${n}`)
      }
      // 100 samples, a pause in production, then 100 more.
      const audio = Stream.make(pcm(100)).pipe(Stream.concat(Stream.fromEffect(Effect.as(Effect.sleep(500), pcm(100)))))
      const fiber = yield* web.output.play(audio, 22_050, observer).pipe(
        Effect.provideService(CurrentTurnTrace, trace(42)),
        Effect.forkChild
      )
      yield* Effect.yieldNow
      web.report({ type: "playback.started", turnId: 42, outputLatencyMs: 0, startDelayMs: 0 }, link.link)
      web.report({ type: "playback.finished", turnId: 42, playedSamples: 100 }, link.link)
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      assert.isUndefined(fiber.pollUnsafe(), "play does not return on a finish before reply.end")
      assert.strictEqual(web.playingTurn(), 42, "the session stays open")
      assert.strictEqual(logs.length, 1)
      assert.match(logs[0]!, /before the reply's end/)
      yield* advance(500)
      assert.deepStrictEqual(link.types(), ["reply.start", "reply.end"])
      web.report({ type: "playback.progress", turnId: 42, playedSamples: 150, underruns: 0 }, link.link)
      web.report({ type: "playback.finished", turnId: 42, playedSamples: 200 }, link.link)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(calls, ["started", "progress 150", "progress 200", "final 200"])
    }).pipe(Effect.scoped))

  it.effect("the legitimate order is unaffected: the finish that follows reply.end at once is accepted", () =>
    Effect.gen(function*() {
      const web = yield* makeWebAudio()
      // A page that answers reply.end in the same instant (the earliest a finish can arrive).
      let web2: typeof web | undefined
      const messages: Array<ServerMessage> = []
      const link: AudioClientLink = {
        sendMessage: (m) => {
          messages.push(m)
          if (m.type === "reply.end") web2!.report({ type: "playback.finished", turnId: m.turnId, playedSamples: 100 }, link)
        },
        sendBinary: () => {}
      }
      web2 = web
      web.setOwner(link)
      const fiber = yield* web.output.play(Stream.make(pcm(100)), 22_050).pipe(
        Effect.provideService(CurrentTurnTrace, trace(43)),
        Effect.forkChild
      )
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)))
    }).pipe(Effect.scoped))
})
