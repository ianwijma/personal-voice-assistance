// The worker's logic (src/recognizerCore.mjs) driven directly with fake models (fakeModels.mjs): what a stalled
// native decode can make it hold, and what streaming segments keep.
import { assert, describe, it } from "@effect/vitest"
import { makeRecognizerCore, reconcile } from "../src/recognizerCore.mjs"
import { fakeOffline, fakeOnline, fakeVad } from "./fakeModels.mjs"

const FRAME_BYTES = 640
/** `ms` of 16 kHz s16 audio at `amplitude` (0 = silence), as one transferred buffer. */
const pcm = (ms: number, amplitude: number) => new Int16Array((ms / 20) * 320).fill(amplitude).buffer

const offlineConfig = { kind: "offline", prerollMs: 400, agc: false, offline: { maxTurnMs: 30_000, interimMs: 0 } }

const offlineCore = (options: { maxQueuedDecodeMs?: number; decodeMs?: number } = {}) => {
  const posted: Array<any> = []
  const model = fakeOffline({ text: "words", ...(options.decodeMs !== undefined ? { decodeMs: options.decodeMs } : {}) })
  const core = makeRecognizerCore({
    config: offlineConfig,
    offline: model,
    vad: fakeVad(),
    post: (m: any) => posted.push(m),
    ...(options.maxQueuedDecodeMs !== undefined ? { maxQueuedDecodeMs: options.maxQueuedDecodeMs } : {})
  })
  core.onMessage({ type: "reset", session: 1 })
  const audio = (ms: number, amplitude = 8000) => {
    for (let t = 0; t < ms; t += 1000) core.onMessage({ type: "audio", session: 1, buffer: pcm(Math.min(1000, ms - t), amplitude) })
  }
  return { core, posted, model, audio }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("recognizerCore, whole-turn: a native decode that never returns", () => {
  it("continuous speech keeps at most the bound of queued audio; the turn is dropped and the owner told", async () => {
    const { audio, core, model, posted } = offlineCore()
    model.hang.on = true
    // Five 35 s pieces of continuous speech (the reviewer's case: four already held ~9 MB), then more.
    audio(6 * 35_000)
    await tick()
    const { queuedSamples, pendingDecodes } = core.inspect()
    // Bound: two of the longest pieces (2 × 35 s) of queued audio, besides the running decode.
    assert.isAtMost(queuedSamples, 2 * 35 * 16_000)
    assert.isAtMost(pendingDecodes, 3)
    assert.strictEqual(model.calls.started, 1, "only the first piece reached the decoder")
    const overloads = posted.filter((m) => m.type === "overload")
    assert.strictEqual(overloads.length, 1, "told once per turn")
    assert.include(overloads[0].message, "this turn was dropped")
    // Its final answer comes at once, with no text, without a decode.
    core.onMessage({ type: "finalize", session: 1, frame: 1_000_000, through: true })
    assert.deepStrictEqual(posted.filter((m) => m.type === "segment").map((m) => m.text), [""])
    assert.strictEqual(model.calls.started, 1)
  })

  it("overload after a finalise was queued: that finalise is answered once (empty), the next utterance and end of input still work", async () => {
    // The reviewer's case: a long piece's decode stalls; at a pause the detector's finalise queues behind it; speech
    // goes on until a piece no longer fits. The queued finalise must be answered, exactly once, with no text.
    const { audio, core, model, posted } = offlineCore({ maxQueuedDecodeMs: 40_000 })
    model.hang.on = true
    audio(35_000) // the first piece is cut at 35 s: its decode starts and never returns
    await tick()
    assert.strictEqual(model.calls.started, 1)
    audio(400, 0) // a pause
    core.onMessage({ type: "finalize", session: 1, frame: 35_000 / 20 + 20 }) // queued behind the stalled decode
    assert.deepStrictEqual(posted.filter((m) => m.type === "segment"), [], "not answered yet: it waits for the decoder")
    audio(80_000) // speech goes on: the next piece no longer fits; the turn is dropped
    assert.strictEqual(posted.filter((m) => m.type === "overload").length, 1)
    const answers = () => posted.filter((m) => m.type === "segment")
    assert.deepStrictEqual(answers().map((m) => m.text), [""], "the dropped finalise is answered at once, with no text")
    // The stalled decode returns at last: it neither answers again nor brings the dropped turn's text back.
    model.hang.on = false
    model.hang.release?.()
    await new Promise((r) => setTimeout(r, 20))
    assert.strictEqual(answers().length, 1, "exactly once")
    // The detector commits the dropped turn; the next utterance decodes normally ...
    core.onMessage({ type: "commit", session: 1, frame: 1_000_000 })
    audio(500, 0)
    audio(2_000, 9000)
    audio(800, 0)
    core.onMessage({ type: "finalize", session: 1, frame: 1_000_000_000, through: true })
    await new Promise((r) => setTimeout(r, 20))
    assert.strictEqual(answers().length, 2)
    assert.include(answers()[1].text, "words")
    // ... and end of input completes its handshake.
    core.onMessage({ type: "flush", session: 1 })
    assert.isTrue(posted.some((m) => m.type === "flushed"))
  })

  it("without the bound the same input holds every piece (the test fails if the bound is removed)", async () => {
    const { audio, core, model } = offlineCore({ maxQueuedDecodeMs: Number.POSITIVE_INFINITY })
    model.hang.on = true
    audio(6 * 35_000)
    await tick()
    assert.isAbove(core.inspect().queuedSamples, 4 * 30 * 16_000)
  })

  it("a reset (new session) or a committed turn drops queued decodes before they reach the decoder", async () => {
    const { audio, core, model, posted } = offlineCore({ decodeMs: 30 })
    audio(3 * 35_000) // three pieces: the first runs, the others wait
    await tick()
    assert.strictEqual(model.calls.started, 1)
    core.onMessage({ type: "commit", session: 1, frame: 1_000_000 })
    // A finalise queued behind the running decode for an already-ended turn: answered without decoding.
    core.onMessage({ type: "reset", session: 2 })
    await new Promise((r) => setTimeout(r, 100))
    assert.strictEqual(model.calls.started, 1, "no stale piece was decoded")
    assert.strictEqual(core.inspect().pendingDecodes, 0)
    assert.deepStrictEqual(posted.filter((m) => m.type === "error"), [])
  })

  it("close answers once the running decode settles, without running the queued ones", async () => {
    const { audio, core, model, posted } = offlineCore({ decodeMs: 50 })
    audio(3 * 35_000)
    core.onMessage({ type: "close" })
    await new Promise((r) => setTimeout(r, 150))
    assert.isTrue(posted.some((m) => m.type === "closed"))
    assert.strictEqual(model.calls.started, 1)
  })

  it("a stalled decoder never stops the frames: VAD decisions keep flowing", async () => {
    const { audio, model, posted } = offlineCore()
    model.hang.on = true
    audio(80_000)
    const frames = posted.filter((m) => m.type === "frames").reduce((n, m) => n + m.speech.length, 0)
    assert.strictEqual(frames, 80_000 / 20)
  })
})

describe("recognizerCore, several sessions on one model", () => {
  const twoSessions = (options: { decodeMs?: number; maxQueuedDecodeMs?: number } = {}) => {
    const posted: Array<any> = []
    const model = fakeOffline({ decodeMs: options.decodeMs ?? 10 })
    let vads = 0
    const core = makeRecognizerCore({
      config: offlineConfig,
      offline: model,
      vad: fakeVad(),
      makeVad: () => {
        vads++
        return fakeVad()
      },
      post: (m: any) => posted.push(m),
      ...(options.maxQueuedDecodeMs !== undefined ? { maxQueuedDecodeMs: options.maxQueuedDecodeMs } : {})
    })
    core.onMessage({ type: "open", session: 1 })
    core.onMessage({ type: "open", session: 2 })
    const audio = (session: number, ms: number, amplitude = 8000) => {
      for (let t = 0; t < ms; t += 1000) core.onMessage({ type: "audio", session, buffer: pcm(Math.min(1000, ms - t), amplitude) })
    }
    return { core, posted, model, audio, vads: () => vads }
  }

  it("each session has its own VAD and turn audio; decodes of both are answered to their own session", async () => {
    const { audio, core, posted, vads } = twoSessions()
    assert.strictEqual(vads(), 1, "the startup VAD serves the first session; one more for the second")
    assert.strictEqual(core.inspect().sessions, 2)
    audio(1, 500, 0)
    audio(2, 500, 0)
    audio(1, 600, 9000) // "w9"
    audio(2, 600, 5000) // "w5"
    audio(1, 600, 0)
    audio(2, 600, 0)
    core.onMessage({ type: "finalize", session: 1, frame: 1_000_000, through: true })
    core.onMessage({ type: "finalize", session: 2, frame: 1_000_000, through: true })
    await new Promise((r) => setTimeout(r, 60))
    const segments = posted.filter((m) => m.type === "segment").map((m) => [m.session, m.text])
    assert.deepStrictEqual(segments, [[1, "w9"], [2, "w5"]])
    // Each session's VAD decisions are its own.
    const speech = (session: number) => posted.filter((m) => m.type === "frames" && m.session === session).flatMap((m) => m.speech)
    assert.strictEqual(speech(1).filter((x: number) => x === 1).length, 30)
    assert.strictEqual(speech(2).filter((x: number) => x === 1).length, 30)
  })

  it("ending one session drops only its queued decodes; the other's are still decoded", async () => {
    const { audio, core, model, posted } = twoSessions({ decodeMs: 30 })
    audio(1, 3 * 35_000) // three long pieces of session 1: the first runs, two wait
    audio(2, 600, 5000)
    audio(2, 600, 0)
    core.onMessage({ type: "finalize", session: 2, frame: 1_000_000, through: true }) // queued behind them
    core.onMessage({ type: "end", session: 1 })
    assert.strictEqual(core.inspect().sessions, 1)
    await new Promise((r) => setTimeout(r, 150))
    assert.strictEqual(model.calls.started, 2, "session 1's running piece, then session 2's finalise; nothing else")
    assert.deepStrictEqual(posted.filter((m) => m.type === "segment").map((m) => [m.session, m.text]), [[2, "w5"]])
    // A message for the ended session is ignored.
    core.onMessage({ type: "flush", session: 1 })
    assert.isFalse(posted.some((m) => m.type === "flushed" && m.session === 1))
  })

  it("the bound on queued audio is per session: one session's backlog never drops another's turn", async () => {
    const { audio, core, model, posted } = twoSessions({ maxQueuedDecodeMs: 40_000 })
    model.hang.on = true
    audio(1, 3 * 35_000) // session 1 overflows its own bound
    assert.strictEqual(posted.filter((m) => m.type === "overload" && m.session === 1).length, 1)
    audio(2, 600, 5000)
    audio(2, 600, 0)
    core.onMessage({ type: "finalize", session: 2, frame: 1_000_000, through: true })
    assert.isFalse(posted.some((m) => m.type === "overload" && m.session === 2))
    model.hang.on = false
    model.hang.release?.()
    await new Promise((r) => setTimeout(r, 60))
    assert.deepStrictEqual(posted.filter((m) => m.type === "segment" && m.session === 2).map((m) => m.text), ["w5"])
  })

  it("a VAD is reused after its session ends", () => {
    const { core, vads } = twoSessions()
    core.onMessage({ type: "end", session: 2 })
    core.onMessage({ type: "open", session: 3 })
    assert.strictEqual(vads(), 1)
    core.onMessage({ type: "open", session: 4 })
    assert.strictEqual(vads(), 2)
  })
})

describe("recognizerCore, per-stream options (docs/ASSISTANTS.md §3.2)", () => {
  it("each session's VAD threshold and gain options are its own; detectors and gain controls are reused per option set", () => {
    const vadsMade: Array<number> = []
    const agcsMade: Array<string> = []
    const posted: Array<any> = []
    const config = { ...offlineConfig, vad: { threshold: 0.5 }, agc: {} }
    const core = makeRecognizerCore({
      config,
      offline: fakeOffline({ text: "x" }),
      vad: fakeVad(),
      makeVad: (threshold: number) => {
        vadsMade.push(threshold)
        return fakeVad()
      },
      makeAgc: (options: unknown) => {
        agcsMade.push(JSON.stringify(options))
        return { process: () => {}, reset: () => {}, gainDb: () => 0 }
      },
      post: (m: any) => posted.push(m)
    })
    // The startup VAD (threshold 0.5) serves the first session with the default.
    core.onMessage({ type: "open", session: 1, options: { vadThreshold: 0.5, agc: false, prerollMs: 400 } })
    core.onMessage({ type: "open", session: 2, options: { vadThreshold: 0.7, agc: { maxGainDb: 12 }, prerollMs: 200 } })
    core.onMessage({ type: "open", session: 3, options: { vadThreshold: 0.7, agc: { maxGainDb: 30 }, prerollMs: 400 } })
    assert.deepStrictEqual(vadsMade, [0.7, 0.7])
    assert.deepStrictEqual(agcsMade, [JSON.stringify({ maxGainDb: 12 }), JSON.stringify({ maxGainDb: 30 })])
    // Ended sessions give theirs back for the next session with the same options.
    core.onMessage({ type: "end", session: 2 })
    core.onMessage({ type: "open", session: 4, options: { vadThreshold: 0.7, agc: { maxGainDb: 12 }, prerollMs: 400 } })
    assert.deepStrictEqual(vadsMade, [0.7, 0.7])
    assert.strictEqual(agcsMade.length, 2)
    // No options: the worker's configuration (the protocol before per-stream options).
    core.onMessage({ type: "end", session: 1 })
    core.onMessage({ type: "open", session: 5 })
    assert.deepStrictEqual(vadsMade, [0.7, 0.7], "the startup VAD again")
    assert.strictEqual(agcsMade.at(-1), JSON.stringify({}))
    assert.strictEqual(core.inspect().sessions, 3)
    assert.deepStrictEqual(posted.filter((m) => m.type === "error"), [])
  })
})

const streamingConfig = { kind: "streaming", prerollMs: 400, agc: false, streaming: { tailPaddingMs: 0 } }

const streamingCore = (limits?: Record<string, number>) => {
  const posted: Array<any> = []
  const online = fakeOnline()
  const core = makeRecognizerCore({ config: streamingConfig, online, vad: fakeVad(), post: (m: any) => posted.push(m), ...(limits ? { segmentLimits: limits } : {}) })
  core.onMessage({ type: "reset", session: 1 })
  let frame = 0
  const audio = (ms: number, amplitude: number) => {
    core.onMessage({ type: "audio", session: 1, buffer: pcm(ms, amplitude) })
    frame += ms / 20
    return frame
  }
  return { core, posted, online, audio, frame: () => frame }
}

describe("recognizerCore, streaming: long segments and boundary cuts", () => {
  it("a segment far past the retention limit keeps at most `keepMs` of frames, at any length", () => {
    const { audio, core } = streamingCore()
    // Five minutes of talking with short pauses (never a finalise).
    for (let i = 0; i < 300; i++) {
      audio(800, 8000 + (i % 5) * 1000)
      audio(200, 0)
    }
    assert.isAtMost(core.inspect().retainedStreamingFrames, 30_000 / 20)
    assert.isAbove(core.inspect().stats.checkpoints, 10)
  })

  it("the reviewer's case: a 45 s segment, a boundary, the next sentence already fed: cut exactly, the rest is the next turn's", () => {
    const { audio, core, posted } = streamingCore()
    for (let i = 0; i < 45; i++) {
      audio(800, 8000)
      audio(200, 0)
    }
    audio(800, 7000)
    const boundary = audio(700, 0) // the turn ends here...
    audio(600, 5000) // ...but the next sentence is processed before the finalise arrives
    core.onMessage({ type: "finalize", session: 1, frame: boundary, through: true })
    const first = posted.filter((m) => m.type === "segment").at(-1)
    assert.notInclude(first.text, "w5", "nothing of the next sentence in this turn")
    assert.include(first.text, "w7")
    assert.strictEqual(core.inspect().stats.uncutBoundaries, 0)
    audio(700, 0)
    core.onMessage({ type: "finalize", session: 1, frame: 1_000_000 })
    assert.strictEqual(posted.filter((m) => m.type === "segment").at(-1).text, "w5", "the next sentence is its own turn")
  })

  it("a cut replays only the piece it falls in, not the whole segment", () => {
    const { audio, core, posted } = streamingCore()
    for (let i = 0; i < 30; i++) {
      audio(800, 8000)
      audio(200, 0)
    }
    const boundary = audio(700, 0)
    audio(400, 5000)
    core.onMessage({ type: "finalize", session: 1, frame: boundary, through: true })
    assert.isAtMost(core.inspect().stats.replayedFrames, (8_000 + 1_000) / 20, "at most one piece (≤ the 8 s hard checkpoint) was decoded again")
    // All the native work the cut causes: that piece, plus the frames after the boundary fed again to start the
    // next segment (400 ms of speech here, with its pre-roll: as many frames as the worker was past the boundary).
    const { refedFrames, replayedFrames } = core.inspect().stats
    assert.isAtMost(refedFrames, (400 + 400) / 20)
    assert.isAtMost(replayedFrames + refedFrames, (8_000 + 1_000 + 800) / 20)
    assert.notInclude(posted.filter((m) => m.type === "segment").at(-1).text, "w5")
  })

  it("a boundary inside audio no longer kept is never applied silently: the owner gets a warning", () => {
    const { audio, core, posted } = streamingCore({ checkpointMs: 1_000, pauseMs: 100, hardCheckpointMs: 2_000, keepMs: 2_000 })
    audio(800, 9000)
    const early = audio(200, 0)
    for (let i = 0; i < 10; i++) {
      audio(800, 8000)
      audio(200, 0)
    }
    core.onMessage({ type: "finalize", session: 1, frame: early, through: true })
    assert.strictEqual(core.inspect().stats.uncutBoundaries, 1)
    assert.isTrue(posted.some((m) => m.type === "warning"))
  })
})

describe("recognizerCore, streaming: a checkpoint forced in the middle of speech", () => {
  it("reconcile joins two overlapping texts where their words match; a truncated last word gives way", () => {
    assert.deepStrictEqual(reconcile("to be finally a ble", "a blessed soul in heaven"), { text: "to be finally a blessed soul in heaven", matched: true })
    assert.deepStrictEqual(reconcile("the squalid quarter of", "squalid quarter of the brothels"), { text: "the squalid quarter of the brothels", matched: true })
    assert.deepStrictEqual(reconcile("Here and there,", "and there the squalid"), { text: "Here and there the squalid", matched: true })
    // A single short word is no evidence: concatenated, reported unmatched.
    assert.deepStrictEqual(reconcile("over the", "the hill"), { text: "over the the hill", matched: false })
  })

  it("continuous speech with no pause: the text is the same as decoding it whole, and the overlap is counted", () => {
    // 20 s of speech whose "word" changes every 100 ms (amplitudes cycle through 30 values), never a pause.
    const speak = (core: ReturnType<typeof streamingCore>) => {
      for (let i = 0; i < 200; i++) core.audio(100, 3000 + (i % 30) * 500)
      core.audio(700, 0)
      core.core.onMessage({ type: "finalize", session: 1, frame: 1_000_000 })
      return core.posted.filter((m) => m.type === "segment").at(-1).text as string
    }
    const whole = speak(streamingCore({ checkpointMs: 1e9, hardCheckpointMs: 1e9 }))
    const cut = streamingCore()
    assert.strictEqual(speak(cut), whole)
    const { checkpoints, overlapFrames, unmatchedJoins } = cut.core.inspect().stats as any
    assert.isAtLeast(checkpoints, 2)
    assert.strictEqual(overlapFrames, checkpoints * 2_000 / 20)
    assert.strictEqual(unmatchedJoins, 0)
    // Without the overlap the fake's words around each cut would be split differently; the join is plain.
    const plain = streamingCore({ overlapMs: 0 })
    assert.isString(speak(plain))
  })
})

describe("recognizerCore, streaming: joins where the overlap was transcribed differently (fifth review)", () => {
  /**
   * An online recogniser whose text is scripted per stream: `script(stream, framesFed)` gives the words, each with
   * the time (s, from the stream's start) it begins at, or no times (a model whose results carry none).
   */
  const scripted = (script: (stream: number, fed: number) => ReadonlyArray<readonly [string, number]>, withTimes = true) => {
    let streams = 0
    return {
      createStream: () => ({ id: streams++, fed: 0, pending: false, acceptWaveform(this: any, { samples }: { samples: Float32Array }) {
        this.fed += samples.length / 320
        this.pending = true
      }, inputFinished() {}, setOption() {} }),
      isReady: (s: any) => s.pending,
      decode: (s: any) => void (s.pending = false),
      getResult: (s: any) => {
        const words = script(s.id, Math.round(s.fed))
        const text = words.map(([w]) => w).join(" ")
        return withTimes ? { text, tokens: words.map(([w]) => `▁${w}`), timestamps: words.map(([, t]) => t) } : { text }
      }
    }
  }
  /** Speech for 1.5 s, one forced checkpoint at 1 s with a 200 ms (10-frame) overlap, then a pause and the finalise. */
  const run = (online: unknown, speechMs = 1_500, limits: Record<string, number> = {}) => {
    const posted: Array<any> = []
    const core = makeRecognizerCore({
      config: streamingConfig,
      online,
      vad: fakeVad(),
      post: (m: any) => posted.push(m),
      segmentLimits: { checkpointMs: 1e9, hardCheckpointMs: 1_000, overlapMs: 200, ...limits }
    })
    core.onMessage({ type: "reset", session: 1 })
    for (let t = 0; t < speechMs; t += 20) core.onMessage({ type: "audio", session: 1, buffer: pcm(20, 8000) })
    core.onMessage({ type: "audio", session: 1, buffer: pcm(300, 0) })
    core.onMessage({ type: "finalize", session: 1, frame: 1_000_000 })
    assert.strictEqual(core.inspect().stats.checkpoints, 1)
    return {
      core,
      partials: posted.filter((m) => m.type === "partial").map((m) => m.text as string),
      final: posted.filter((m) => m.type === "segment").at(-1).text as string
    }
  }
  // The first stream heard "one two three four" (its last 200 ms: "four"); the second, fed from 200 ms before the cut,
  // hears that overlap as "for" (no word in common), then "five six".
  const first: ReadonlyArray<readonly [string, number]> = [["one", 0.1], ["two", 0.3], ["three", 0.6], ["four", 0.85]]
  const second = (fed: number): ReadonlyArray<readonly [string, number]> =>
    [["for", 0.05], ...(fed > 20 ? [["five", 0.3] as const] : []), ...(fed > 30 ? [["six", 0.5] as const] : [])]

  it("no matching words: the second piece's words in the overlap are dropped (by their times), never repeated", () => {
    const r = run(scripted((stream, fed) => (stream === 0 ? first : second(fed))))
    assert.strictEqual(r.final, "one two three four five six", "not 'one two three four for five six'")
    assert.strictEqual(r.core.inspect().stats.unmatchedJoins, 1)
  })

  it("no matching words and no word times: the overlap's share of the second piece's words is dropped", () => {
    const r = run(scripted((stream, fed) => (stream === 0 ? first : second(fed)), false))
    assert.strictEqual(r.final, "one two three four five six")
  })

  it("reconcile without a match keeps the first text's words for the overlap", () => {
    assert.deepStrictEqual(reconcile("over the", "the hill", 1), { text: "over the hill", matched: false })
    assert.deepStrictEqual(reconcile("over the", "a bridge", 0), { text: "over the a bridge", matched: false })
  })

  it("just after a join, a later partial that establishes a match (fewer words) is held back (within joinHoldMs)", () => {
    // The second stream first hears the overlap as "for fore" (one word after the overlap by its time: no match,
    // one extra word), then revises it to "four" (a match: one word fewer), then goes on.
    const revising = (fed: number): ReadonlyArray<readonly [string, number]> =>
      fed <= 15 ? [["for", 0.05], ["fore", 0.22]] : fed <= 25 ? [["four", 0.05]] : [["four", 0.05], ["five", 0.3], ["six", 0.5]]
    const r = run(scripted((stream, fed) => (stream === 0 ? first : revising(fed))))
    const counts = r.partials.map((p) => p.split(" ").length)
    for (let i = 1; i < counts.length; i++) assert.isAtLeast(counts[i]!, counts[i - 1]!, `partials: ${JSON.stringify(r.partials)}`)
    const longer = r.partials.indexOf("one two three four fore")
    assert.isAtLeast(longer, 0)
    assert.notInclude(r.partials.slice(longer), "one two three four", "the shorter text is not shown after the longer one")
    assert.strictEqual(r.partials.at(-1), "one two three four five six")
    assert.strictEqual(r.final, "one two three four five six")
  })

  it("the hold across a join is bounded: a shorter text that stays is posted once joinHoldMs of audio passed the cut", () => {
    // As above, but the join keeps the shorter text until 25 frames were fed (15 past the cut); hold: 10 frames.
    const revising = (fed: number): ReadonlyArray<readonly [string, number]> =>
      fed <= 15 ? [["for", 0.05], ["fore", 0.22]] : fed <= 25 ? [["four", 0.05]] : [["four", 0.05], ["five", 0.3], ["six", 0.5]]
    const r = run(scripted((stream, fed) => (stream === 0 ? first : revising(fed))), 1_500, { joinHoldMs: 200 })
    const longer = r.partials.indexOf("one two three four fore")
    const shorter = r.partials.indexOf("one two three four", longer)
    assert.isAtLeast(longer, 0, JSON.stringify(r.partials))
    assert.isAbove(shorter, longer, `the correction is posted after the hold: ${JSON.stringify(r.partials)}`)
    assert.strictEqual(r.partials.at(-1), "one two three four five six")
  })
})

describe("recognizerCore: shorter corrections reach the interim text (sixth review)", () => {
  const eight = "you could also try the other one too"
  const corrected = "please stop now"

  it("streaming, within one piece: a revision to fewer words is posted at once, not only at the end", () => {
    let streams = 0
    const online = {
      createStream: () => ({ id: streams++, fed: 0, pending: false, acceptWaveform(this: any, { samples }: { samples: Float32Array }) {
        this.fed += samples.length / 320
        this.pending = true
      }, inputFinished() {}, setOption() {} }),
      isReady: (s: any) => s.pending,
      decode: (s: any) => void (s.pending = false),
      getResult: (s: any) => ({ text: s.fed <= 30 ? eight : corrected })
    }
    const posted: Array<any> = []
    const core = makeRecognizerCore({ config: streamingConfig, online, vad: fakeVad(), post: (m: any) => posted.push(m) })
    core.onMessage({ type: "reset", session: 1 })
    for (let t = 0; t < 1_500; t += 20) core.onMessage({ type: "audio", session: 1, buffer: pcm(20, 8000) })
    const partials = posted.filter((m) => m.type === "partial").map((m) => m.text)
    assert.deepStrictEqual(partials, [eight, corrected], "the correction is interim text before the utterance ends")
    assert.strictEqual(core.inspect().stats.checkpoints, 0, "one piece: no join involved")
    core.onMessage({ type: "audio", session: 1, buffer: pcm(300, 0) })
    core.onMessage({ type: "finalize", session: 1, frame: 1_000_000 })
    assert.strictEqual(posted.filter((m) => m.type === "segment").at(-1).text, corrected)
  })

  it("whole-turn interim decodes: a revision to fewer words is posted unchanged", async () => {
    let decodes = 0
    const offline = {
      createStream: () => ({ acceptWaveform() {} }),
      decodeAsync: async () => void decodes++,
      getResult: () => ({ text: decodes <= 1 ? eight : corrected })
    }
    const posted: Array<any> = []
    const core = makeRecognizerCore({
      config: { kind: "offline", prerollMs: 400, agc: false, offline: { maxTurnMs: 30_000, interimMs: 200 } },
      offline,
      vad: fakeVad(),
      post: (m: any) => posted.push(m)
    })
    core.onMessage({ type: "reset", session: 1 })
    for (let t = 0; t < 1_000; t += 20) {
      core.onMessage({ type: "audio", session: 1, buffer: pcm(20, 8000) })
      await tick()
    }
    const partials = posted.filter((m) => m.type === "partial").map((m) => m.text)
    assert.deepStrictEqual(partials, [eight, corrected])
  })
})
