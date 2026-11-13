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
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      assert.deepStrictEqual(first.messages.at(-1), { type: "reply.stop", turnId: 6 })
      assert.deepStrictEqual(second.messages, [], "the new owner gets nothing of the old reply")
      assert.deepStrictEqual(calls, ["progress 20"])

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
})
