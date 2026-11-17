// The recogniser worker's logic (worker.mjs), with the models passed in: per-frame VAD, the streaming kind's
// segments (with checkpoints and boundary cuts), the whole-turn kind's audio and decode queue, and the message
// protocol (documented in worker.mjs). Plain JavaScript, no sherpa import, so the test stand-ins in test/ run
// exactly this code with fake recognisers and a fake VAD.
//
// Several voice sessions at once (docs/VOICE-SESSIONS.md §3): the models and the decode queue are shared, every
// session (`open` … `end`) has its own VAD, AGC, pre-roll, turn audio and segments. Whole-turn decodes of all
// sessions run one at a time in arrival order; a session's queued audio is bounded on its own, so one session's
// long turn never makes another's turn be dropped.
//
// What a model must provide (the subset of sherpa-onnx-node used):
//   online:  createStream() → stream { acceptWaveform({ sampleRate, samples }), inputFinished(), setOption(k, v) },
//            isReady(stream), decode(stream), getResult(stream).text
//   offline: createStream() → stream { acceptWaveform(...) }, decodeAsync(stream): Promise, getResult(stream).text
//   vad:     acceptWaveform(frame), isDetected(), isEmpty(), pop(), reset()
//   agc:     process(frame), reset(), gainDb()   (optional)
import { DecodeQueue } from "./decodeQueue.mjs"
import { TurnAudio } from "./turnAudio.mjs"

export const RATE = 16000
export const FRAME = 320 // 20 ms
export const FRAME_MS = 20

/**
 * Streaming segments: limits on the audio of the open segment kept for a boundary cut.
 * - A piece longer than `checkpointMs` is checkpointed at its next pause of `pauseMs`, and one of `hardCheckpointMs`
 *   regardless. A checkpoint fixes the recogniser's text so far (no boundary was requested, so nothing is decided
 *   early) and a fresh stream continues; a later cut replays only the piece it falls in, not the whole segment.
 * - A checkpoint at a pause joins cleanly. One forced in the middle of speech would split or drop the word it falls
 *   in (the fresh stream has no left context; measured with the real models, scripts/checkpoint-quality.ts), so
 *   the fresh stream starts `overlapMs` before the cut, and the two texts are joined where their words match
 *   (`reconcile`): the old piece's last, possibly cut, word gives way to the new piece's. Where no words match (the
 *   two streams heard the overlap differently), the new piece's words that began in the overlap are dropped, by
 *   their times where the model gives them, else by the overlap's share of the piece's audio: no worse than a plain
 *   cut, and the overlap's words are never repeated.
 * - Frames are kept for the last `keepMs` of the segment (whole pieces); older pieces keep only their text.
 * - Interim text (`partial`) is the recogniser's, as it is, including revisions to fewer words, with one exception:
 *   for the first `joinHoldMs` of audio after a forced checkpoint, while the new piece's words in the overlap
 *   settle and the join can briefly lose words, a text with fewer words than the last partial is held back. After
 *   that the current text is posted whatever its length. 640 ms is two of the streaming Zipformer's 320 ms decode
 *   chunks: the overlap is fed at once at the cut, so its words have settled by then; and it bounds how long a
 *   shorter correction can be withheld from the interrupt decision ("confirm" mode reads these partials).
 */
export const SEGMENT_LIMITS = { checkpointMs: 5_000, pauseMs: 200, hardCheckpointMs: 8_000, overlapMs: 2_000, keepMs: 30_000, joinHoldMs: 640 }

const wordKey = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "")

/**
 * Joins `prev` and `next`, where `next` was decoded from audio that starts before the end of `prev`'s: the longest
 * run of words (up to 5) that ends `prev` (or ends it but for its last word, which a cut may have truncated) and
 * appears near the start of `next` is where they join. A single matching word must have at least 4 letters (or be
 * followed by the word that `prev`'s truncated last word begins). With no match (`matched: false`), `prev` keeps the
 * overlap: the first `overlapWords` words of `next` (those that began in the overlap) are dropped.
 */
export const reconcile = (prev, next, overlapWords = 0) => {
  const P = prev.split(/\s+/).filter(Boolean)
  const N = next.split(/\s+/).filter(Boolean)
  const p = P.map(wordKey)
  const n = N.map(wordKey)
  for (let k = Math.min(5, P.length, N.length); k >= 1; k--) {
    for (const d of [0, 1]) {
      const from = P.length - d - k
      if (from < 0) continue
      for (let j = 0; j + k <= N.length && j <= 12; j++) {
        let same = true
        for (let i = 0; i < k && same; i++) same = p[from + i] === n[j + i] && p[from + i] !== ""
        // One short word alone is evidence only when the truncated word after it begins the next text's word there.
        const truncated = d === 1 && p[P.length - 1] !== "" && (n[j + k] ?? "").startsWith(p[P.length - 1])
        if (same && k === 1 && p[from].length < 4 && !truncated) continue
        if (same) return { text: [...P.slice(0, from), ...N.slice(j)].join(" "), matched: true }
      }
    }
  }
  return { text: [...P, ...N.slice(Math.max(0, overlapWords))].join(" "), matched: false }
}

/**
 * How many words of a result began in the first `leadFrames` of the `fedFrames` its stream was fed: by the result's
 * token times where it has them (a token starting with a space or "▁" starts a word, as does the first), else (no
 * times, or tokens that do not line up with the words) by the lead's share of the audio.
 */
export const wordsInLead = (result, leadFrames, fedFrames) => {
  if (!(leadFrames > 0)) return 0
  const words = (result?.text ?? "").split(/\s+/).filter(Boolean)
  const { tokens, timestamps } = result ?? {}
  if (Array.isArray(tokens) && Array.isArray(timestamps) && tokens.length === timestamps.length && tokens.length > 0) {
    const leadSeconds = (leadFrames * FRAME_MS) / 1000
    let starts = 0
    let inLead = 0
    tokens.forEach((token, i) => {
      if (i > 0 && !/^[\s\u2581]/.test(String(token))) return
      starts++
      if (timestamps[i] < leadSeconds) inLead++
    })
    if (starts === words.length) return inLead
  }
  return fedFrames > 0 ? Math.round(words.length * Math.min(1, leadFrames / fedFrames)) : 0
}

/**
 * @param {{
 *   config: any,
 *   online?: any,
 *   offline?: any,
 *   vad?: any,
 *   makeVad?: () => any,
 *   agc?: any,
 *   makeAgc?: () => any,
 *   post: (message: any) => void,
 *   collect?: () => void,
 *   segmentLimits?: Partial<typeof SEGMENT_LIMITS>,
 *   maxQueuedDecodeMs?: number,
 *   onCheckpoint?: (text: string) => void
 * }} deps
 */
export const makeRecognizerCore = (deps) => {
  const { config, online, offline, post } = deps
  const collect = deps.collect ?? (() => {})
  const limits = { ...SEGMENT_LIMITS, ...deps.segmentLimits }
  const language = config.streaming?.language

  const newOnlineStream = () => {
    const s = online.createStream()
    if (language && config.kind === "streaming") s.setOption("language", language)
    if (config.kind === "hybrid") s.setOption("language", "en")
    return s
  }

  const decodeReady = (stream) => {
    while (online.isReady(stream)) online.decode(stream)
  }

  /**
   * Native decode work on this thread caused by cuts, for measurements and tests: `replayedFrames` (the piece the
   * boundary falls in, decoded again up to it) and `refedFrames` (the frames after the boundary, already decoded
   * once in the old stream, fed again to start the next segment; `cutMs` is the time of both).
   */
  const stats = {
    replayedFrames: 0,
    replayMs: 0,
    refedFrames: 0,
    cutMs: 0,
    checkpoints: 0,
    uncutBoundaries: 0,
    /** Frames decoded twice by forced checkpoints' overlaps, and joins where no matching words were found. */
    overlapFrames: 0,
    unmatchedJoins: 0
  }

  /** `close` received: no new work. */
  let closing = false
  // Queued (not yet running) audio is bounded: by default two of the longest pieces `TurnAudio` returns.
  const maxQueuedSamples = Math.round(
    ((deps.maxQueuedDecodeMs ?? (config.offline ? 2 * (config.offline.maxTurnMs + 5_000) : 0)) / 1000) * RATE
  )
  const queue = new DecodeQueue({
    maxQueuedSamples,
    onError: (forSession, error) => post({ type: "error", session: forSession, message: String(error?.stack ?? error) })
  })

  // Interim text for whole-turn models (no streaming model): while the user is speaking, the turn so far is
  // decoded again every `interimMs` of new audio, so live words appear and the "say a few words" barge-in
  // (which needs words) works. Bounded so it rarely delays the end-of-turn decode: only while the VAD says
  // speech right now (the eager point is then >= 260 ms away), only when no other decode is queued, and only
  // for the first `interimMaxMs` of a turn (a decode of 10 s of audio takes about 0.25 s with Parakeet).
  const interimFrames = config.offline?.interimMs > 0 && !config.streaming ? Math.round(config.offline.interimMs / FRAME_MS) : 0
  const interimMaxFrames = Math.round((config.offline?.interimMaxMs ?? 10_000) / FRAME_MS)

  const decodeOffline = async (samples) => {
    const s = offline.createStream()
    s.acceptWaveform({ sampleRate: RATE, samples })
    await offline.decodeAsync(s)
    return offline.getResult(s).text.trim()
  }

  /**
   * One voice session's state (its own VAD, AGC, turn audio, segments, pre-roll): everything but the models and the
   * decode queue, which all sessions share.
   */
  const openSession = (session, vad, agc, prerollMs) => {
    // ---- Session state ----

    /** Set once the session has ended: its results are dropped, its queued decodes never run. */
    let ended = false
    let frameIndex = 0
    let lastSpeechFrame = -1
    const frame = new Float32Array(FRAME)
    let fill = 0
    let carry = -1 // low byte of a sample split across two chunks
    // Recent frames (after the AGC), fed to the recogniser when speech starts (covers the VAD's onset lag).
    const prerollFrames = Math.max(1, Math.round(prerollMs / FRAME_MS))
    const ring = Array.from({ length: prerollFrames }, () => ({ frame: new Float32Array(FRAME), index: -1, speech: false }))
    let ringPos = 0
    let ringCount = 0
    let speechFlags = []

    /** The pre-roll ring, oldest first (ends with the current frame). */
    const preroll = () => {
      const out = []
      for (let k = ringCount; k > 0; k--) out.push(ring[(ringPos - k + ring.length) % ring.length])
      return out
    }

    const flushFrames = () => {
      if (speechFlags.length === 0) return
      post({ type: "frames", session, speech: speechFlags })
      speechFlags = []
    }

    // ---- Streaming kind: one segment at a time, a fresh stream per piece ----
    //
    // A segment runs from a VAD onset (with pre-roll) until it is finalised. It is a list of pieces: checkpointed
    // ones (text fixed, frames kept while recent) and the open one (a live stream and its frames). A `through`
    // finalise cuts the segment at the turn's end when frames of the next sentence were already fed (input in a
    // burst, or this thread behind): the pieces before the boundary give their text, the piece the boundary falls
    // in is decoded again up to it, and the frames after it start the next segment.

    const streamingPadding = config.streaming ? new Float32Array(Math.round(config.streaming.tailPaddingMs * RATE / 1000)) : undefined
    const checkpointFrames = Math.round(limits.checkpointMs / FRAME_MS)
    const pauseFrames = Math.max(1, Math.round(limits.pauseMs / FRAME_MS))
    const hardFrames = Math.round(limits.hardCheckpointMs / FRAME_MS)
    const overlapFrames = Math.round(limits.overlapMs / FRAME_MS)
    const keepFrames = Math.round(limits.keepMs / FRAME_MS)
    const joinHoldFrames = Math.round(limits.joinHoldMs / FRAME_MS)
    let feeding = false
    let segStream = null
    /** The open piece's frames: { samples, index, speech } (copies). */
    let openFrames = []
    /**
     * Checkpointed pieces of the open segment: { text, frames | null (dropped), last, overlapped, overlapWords }.
     * `overlapped`: its stream began with the end of the piece before it (a forced checkpoint), so its text starts
     * with those words; `overlapWords` of them began in that lead (dropped if the join finds no matching words).
     */
    let pieces = []
    /** The open piece's stream began with the end of the piece before it: `openLead` frames of it. */
    let openOverlapped = false
    let openLead = 0
    let keptFrames = 0
    let silentRun = 0
    let partial = ""
    /** Words of the last partial posted for this segment (a shorter one is held back only just after a join, `joinHoldMs`). */
    let partialWords = 0

    /** `list`: { text, overlapped } in order; an overlapped piece is reconciled with the text before it. */
    const joinPieces = (list, count = false) => {
      let out = ""
      for (const piece of list) {
        const text = (piece.text ?? "").trim()
        if (!text) continue
        if (!out) out = text
        else if (!piece.overlapped) out = `${out} ${text}`
        else {
          const joined = reconcile(out, text, piece.overlapWords ?? 0)
          if (count && !joined.matched) stats.unmatchedJoins++
          out = joined.text
        }
      }
      return out
    }
    /** The open piece's current result, as a piece for `joinPieces`. */
    const openText = (result) => ({
      text: result?.text ?? "",
      overlapped: openOverlapped,
      overlapWords: openOverlapped ? wordsInLead(result, openLead, openLead + openFrames.length) : 0
    })

    /** The stream's final result ({ text, and tokens and timestamps where the model gives them }). */
    const finishStream = (stream) => {
      stream.acceptWaveform({ sampleRate: RATE, samples: streamingPadding })
      stream.inputFinished()
      decodeReady(stream)
      return online.getResult(stream)
    }

    const dropOldFrames = () => {
      for (const p of pieces) {
        if (keptFrames <= keepFrames) return
        if (p.frames === null) continue
        keptFrames -= p.frames.length
        p.frames = null
      }
    }

    /** `forced`: in the middle of speech (no pause): the next stream starts `overlapMs` before the cut. */
    const checkpoint = (forced) => {
      const closed = openFrames
      const result = segStream === null ? { text: "" } : finishStream(segStream)
      const { text, overlapWords } = openText(result)
      pieces.push({ text, frames: closed, last: closed.at(-1)?.index ?? frameIndex, overlapped: openOverlapped, overlapWords })
      stats.checkpoints++
      deps.onCheckpoint?.(text) // measurements (scripts/checkpoint-quality.ts)
      segStream = null
      openFrames = []
      silentRun = 0
      openOverlapped = false
      openLead = 0
      if (forced && overlapFrames > 0 && closed.length > 0) {
        // Left context for the next piece; these frames stay the closed piece's (a cut never replays them twice).
        segStream = newOnlineStream()
        const lead = closed.slice(-overlapFrames)
        for (const f of lead) segStream.acceptWaveform({ sampleRate: RATE, samples: f.samples })
        stats.overlapFrames += lead.length
        openOverlapped = true
        openLead = lead.length
      }
      dropOldFrames()
    }

    /** One frame of the open segment (live, or replayed after a cut). */
    const feedSegmentFrame = (samples, index, speech) => {
      openFrames.push({ samples: samples.slice(), index, speech })
      keptFrames++
      segStream ??= newOnlineStream()
      segStream.acceptWaveform({ sampleRate: RATE, samples })
      if (online.isReady(segStream)) {
        decodeReady(segStream)
        const text = joinPieces([...pieces, openText(online.getResult(segStream))])
        const words = text.split(/\s+/).filter(Boolean).length
        // As the recogniser has it, also when shorter (a revision), except just after a join (`joinHoldMs`): the
        // overlapped piece's words in the lead are still settling, and a text that briefly lost words to the join
        // is held back, for at most `joinHoldFrames` of audio past the cut; then whatever the current text is goes.
        const settlingJoin = openOverlapped && openFrames.length < joinHoldFrames
        if (text !== partial && (words >= partialWords || !settlingJoin)) {
          partial = text
          partialWords = words
          flushFrames() // keep partials in order with the frames they came from
          post({ type: "partial", session, text })
        }
      }
      silentRun = speech ? 0 : silentRun + 1
      if (openFrames.length >= checkpointFrames && silentRun >= pauseFrames) checkpoint(false)
      else if (openFrames.length >= hardFrames) checkpoint(true)
      dropOldFrames()
    }

    const streamingFrame = (speech) => {
      if (feeding) feedSegmentFrame(frame, frameIndex, speech)
      else if (speech) {
        feeding = true
        for (const p of preroll()) feedSegmentFrame(p.frame, p.index, p.speech)
      }
    }

    /** Decodes `frames` in a fresh stream (a cut): its text. */
    const replay = (frames) => {
      const started = performance.now()
      const cut = newOnlineStream()
      for (const f of frames) cut.acceptWaveform({ sampleRate: RATE, samples: f.samples })
      const text = finishStream(cut).text
      stats.replayedFrames += frames.length
      stats.replayMs += performance.now() - started
      return text
    }

    /** `through`: the frame the turn ended at; frames after it are not this segment's. */
    const streamingFinalize = (through) => {
      const start = performance.now()
      let text = ""
      let rest = []
      if (feeding) {
        const open = { text: undefined, frames: openFrames, last: openFrames.at(-1)?.index ?? frameIndex, overlapped: openOverlapped }
        const all = [...pieces, open]
        const at = through === undefined ? -1 : all.findIndex((p) => p.last > through)
        if (at < 0) {
          text = joinPieces([...pieces, openText(segStream === null ? { text: "" } : finishStream(segStream))], true)
        } else {
          const piece = all[at]
          const texts = all.slice(0, at).map((p) => ({ text: p.text, overlapped: p.overlapped, overlapWords: p.overlapWords }))
          if (piece.frames === null) {
            // Its audio is no longer kept (cannot happen while the boundary lags the audio by less than `keepMs`):
            // its text goes with this turn, and the owner is told the boundary could not be honoured.
            stats.uncutBoundaries++
            texts.push({ text: piece.text, overlapped: piece.overlapped, overlapWords: piece.overlapWords })
            post({ type: "warning", session, message: `turn boundary at frame ${through} fell in audio no longer kept; the turn may end late` })
          } else {
            // Decoded again without its lead: joined to the piece before it as is.
            texts.push({ text: replay(piece.frames.filter((f) => f.index <= through)), overlapped: false })
            rest.push(...piece.frames.filter((f) => f.index > through))
          }
          for (const p of all.slice(at + 1)) if (p.frames !== null) rest.push(...p.frames)
          text = joinPieces(texts, true)
        }
        // A fresh stream per segment: `reset()` loses accuracy in sherpa-onnx 2.0.1 (stt-quality.md §1.3), and
        // nothing of this segment can leak into the next one.
        segStream = null
        feeding = false
        partial = ""
        partialWords = 0
        openFrames = []
        pieces = []
        openOverlapped = false
        openLead = 0
        keptFrames = 0
        silentRun = 0
      }
      post({ type: "segment", session, text, ms: performance.now() - start, cumulative: false })
      // The frames after the cut are the next turn's: a new segment from their first speech frame, with its pre-roll.
      const first = rest.findIndex((f) => f.speech)
      if (first >= 0) {
        feeding = true
        const again = rest.slice(Math.max(0, first - prerollFrames))
        stats.refedFrames += again.length
        for (const f of again) feedSegmentFrame(f.samples, f.index, f.speech)
      }
      if (through !== undefined) stats.cutMs += performance.now() - start
      collect()
    }

    // ---- Offline kind: whole-turn decoding ----

    const turn = config.offline
      ? new TurnAudio({ frameSamples: FRAME, maxFrames: Math.round(config.offline.maxTurnMs / FRAME_MS), prerollFrames })
      : undefined
    /** Texts of the pieces of an over-long turn decoded so far. */
    let prefix = []
    /** Bumped when a turn ends or the session resets: results of older decodes are dropped, queued ones never run. */
    let generation = 0
    /**
     * The current turn's audio could not all be queued (decoding is far behind: a native decode that does not
     * return, or a machine far too slow): the turn is dropped; it ends with no text, and nothing more of it is queued.
     */
    let turnLost = false
    /**
     * Removes the current turn's queued decodes. A dropped finalise is answered now, once, with no text (the detector
     * waits for it); pieces and interim decodes need no answer.
     */
    const dropTurnJobs = () => {
      const dropped = queue.dropWhere((job) => job.gen === generation)
      return { ...dropped, answer: () => {
        for (const job of dropped.jobs) if (job.kind === "finalize") job.skip()
      } }
    }

    const loseTurn = (why) => {
      if (turnLost) return
      turnLost = true
      prefix = []
      const dropped = dropTurnJobs()
      post({
        type: "overload",
        session,
        message: `${why}: speech recognition is ${Math.round(queue.queuedMs(RATE) + dropped.ms)} ms of audio behind; ` +
          "this turn was dropped"
      })
      dropped.answer()
    }

    // Interim text state (see `interimFrames`).
    let interimAt = 0
    let interimText = ""

    /**
     * Queues a decode of the current session and generation; false if it would exceed the bound. `kind`: "piece" (part
     * of a long turn), "interim", or "finalize" (the detector waits for its answer: it is answered exactly once, by
     * `run` or `skip`, and `skip` also when it is dropped).
     */
    const enqueue = (kind, samples, run, skip = () => {}) => {
      if (closing) return true
      const gen = generation
      const forSession = session
      return queue.add({
        kind,
        gen,
        session: forSession,
        samples: samples.length,
        stale: () => closing || ended || gen !== generation,
        run: () => run(gen, forSession),
        skip
      })
    }

    // Hybrid: live words of the whole turn from an online stream per turn.
    let live = null
    let liveText = ""
    let liveMuted = false

    const feedLive = (samples) => {
      live ??= newOnlineStream()
      live.acceptWaveform({ sampleRate: RATE, samples })
      if (!online.isReady(live)) return
      decodeReady(live)
      const text = online.getResult(live).text.trim()
      if (text !== liveText) {
        liveText = text
        if (liveMuted) return
        flushFrames()
        post({ type: "partial", session, text })
      }
    }

    const dropLive = () => {
      live = null
      liveText = ""
      liveMuted = false
    }

    const offlineFrame = (speech) => {
      const wasCollecting = turn.collecting
      const piece = turn.push(frame, frameIndex, speech, preroll)
      if (piece && !turnLost) {
        const queued = enqueue("piece", piece, async (gen) => {
          const text = await decodeOffline(piece)
          // Not for a turn dropped meanwhile (its finalise was answered with no text).
          if (gen === generation && !turnLost && text) prefix.push(text)
        })
        if (!queued) loseTurn("A long turn's audio could not be queued")
      }
      if (interimFrames > 0 && speech && turn.collecting && queue.pending === 0 && prefix.length === 0 && !turnLost &&
        turn.length - interimAt >= interimFrames && turn.length <= interimMaxFrames) {
        interimAt = turn.length
        const audio = turn.audio()
        enqueue("interim", audio, async (gen, forSession) => {
          const text = await decodeOffline(audio)
          if (gen !== generation || ended || turnLost || !text || text === interimText) return
          interimText = text
          flushFrames() // in order with the frames it came from
          post({ type: "partial", session: forSession, text })
        })
      }
      if (online && turn.collecting) {
        if (speech) liveMuted = false
        if (!wasCollecting) for (const p of preroll()) feedLive(p.frame)
        else feedLive(frame)
      }
      // Safety net: a turn that is never committed (a lost message) does not grow for ever.
      if (turn.collecting && frameIndex - lastSpeechFrame > 15_000 / FRAME_MS) {
        dropTurnJobs().answer() // a finalise still queued (behind a stalled decode) is answered, not left waiting
        turn.clear()
        prefix = []
        generation++
        turnLost = false
        dropLive()
      }
    }

    const offlineFinalize = (through) => {
      const audio = through === undefined ? turn.audio() : turn.audioThrough(through)
      const requested = performance.now()
      if (online) liveMuted = true // the live text may still catch up with the last words: not a resumption
      const gainDb = agc?.gainDb()
      const answer = (forSession, text, started) =>
        post({
          type: "segment",
          session: forSession,
          text,
          cumulative: true,
          ms: performance.now() - requested,
          decodeMs: performance.now() - started,
          audioMs: (audio.length / RATE) * 1000,
          ...(gainDb !== undefined ? { gainDb } : {})
        })
      // The detector waits for this answer, so it always gets one (without a decode when the turn was dropped).
      const forSession = session
      if (turnLost) return answer(forSession, "", performance.now())
      const queued = enqueue("finalize", audio, async (gen) => {
        const started = performance.now()
        const text = audio.length > 0 ? await decodeOffline(audio) : ""
        if (ended) return
        // A turn dropped while this decode ran ends with no text, like one dropped before it began.
        answer(forSession, gen === generation && !turnLost ? [...prefix, text].filter(Boolean).join(" ") : "", started)
      }, () => {
        // Never decoded: the turn ended or the session was reset first. Same session: still answer.
        if (!closing && !ended) answer(forSession, "", performance.now())
      })
      if (!queued) {
        loseTurn("A turn's final decode could not be queued")
        answer(forSession, "", performance.now())
      }
    }

    const offlineCommit = (atFrame) => {
      generation++
      prefix = []
      turnLost = false
      interimAt = 0
      interimText = ""
      turn.commit(atFrame)
      if (online) {
        dropLive()
        if (turn.collecting) feedLive(turn.audio()) // a new turn already started
      }
    }

    // ---- Frames ----

    const processFrame = () => {
      agc?.process(frame)
      vad.acceptWaveform(frame)
      const speech = vad.isDetected()
      while (!vad.isEmpty()) vad.pop() // only the detection flag is used; drop buffered segments
      frameIndex++
      if (speech) lastSpeechFrame = frameIndex
      speechFlags.push(speech ? 1 : 0)
      const slot = ring[ringPos]
      slot.frame.set(frame)
      slot.index = frameIndex
      slot.speech = speech
      ringPos = (ringPos + 1) % ring.length
      ringCount = Math.min(ringCount + 1, ring.length)
      if (turn) offlineFrame(speech)
      else streamingFrame(speech)
    }

    const pushSample = (lo, hi) => {
      frame[fill++] = (((hi << 8) | lo) << 16 >> 16) / 32768
      if (fill === FRAME) {
        fill = 0
        processFrame()
      }
    }

    const onAudio = (buffer) => {
      const bytes = new Uint8Array(buffer)
      let i = 0
      if (carry >= 0 && bytes.length > 0) {
        pushSample(carry, bytes[0])
        carry = -1
        i = 1
      }
      for (; i + 1 < bytes.length; i += 2) pushSample(bytes[i], bytes[i + 1])
      if (i < bytes.length) carry = bytes[i]
      flushFrames()
    }

    const onFinalize = (atFrame, through) => {
      if (!through && lastSpeechFrame > atFrame) return post({ type: "cancelled", session })
      if (turn) offlineFinalize(through ? atFrame : undefined)
      else streamingFinalize(through ? atFrame : undefined)
    }

    const onCommit = (atFrame) => {
      if (turn) offlineCommit(atFrame)
      collect()
    }

    /** The session is over: its queued decodes are dropped (the one running finishes, its answer is dropped). */
    const end = () => {
      ended = true
      queue.dropWhere((job) => job.session === session)
      turn?.clear()
      segStream = null
      openFrames = []
      pieces = []
      dropLive()
    }

    const onFlush = () => {
      flushFrames()
      post({ type: "flushed", session })
    }

    return {
      onAudio,
      onFinalize,
      onCommit,
      onFlush,
      end,
      vad,
      agc,
      inspect: () => ({ retainedStreamingFrames: keptFrames, pieces: pieces.length })
    }
  }

  // ---- Sessions ----
  //
  // Each voice session has its own VAD and AGC, made with that session's options (`open`'s `options`: VAD
  // threshold, gain control, pre-roll; docs/ASSISTANTS.md §3.2: per stream, so two hearers on one model with
  // different microphone settings share the worker). VADs and AGCs are reused per set of options: a session that
  // ends gives its VAD back (reset), so the one loaded at startup serves the first session with the default
  // threshold as before, and a new one is created only while more sessions with those options are open at once
  // than ever before. At most IDLE_VADS_MAX detectors wait idle (any thresholds): giving back one more drops the
  // longest idle, so thresholds saved one after another do not keep a detector each (its native memory goes with
  // its wrapper, at the next collection).

  /** Open sessions by id. */
  const sessions = new Map()
  const defaultThreshold = config.vad?.threshold
  /** Idle VADs, longest idle first, with their threshold; idle AGCs by their options. */
  const IDLE_VADS_MAX = 4
  /** @type {Array<{ key: string, vad: any }>} */
  const idleVads = []
  const idleAgcs = new Map()
  const idle = (pool, key) => {
    let list = pool.get(key)
    if (!list) {
      list = []
      pool.set(key, list)
    }
    return list
  }
  const giveBackVad = (threshold, vad) => {
    idleVads.push({ key: String(threshold), vad })
    if (idleVads.length > IDLE_VADS_MAX) idleVads.shift()
  }
  if (deps.vad) giveBackVad(defaultThreshold, deps.vad)
  if (deps.agc) idle(idleAgcs, JSON.stringify(config.agc ?? {})).push(deps.agc)
  const takeVad = (threshold) => {
    let i = idleVads.length - 1
    while (i >= 0 && idleVads[i].key !== String(threshold)) i--
    const vad = i >= 0 ? idleVads.splice(i, 1)[0].vad : deps.makeVad?.(threshold)
    if (!vad) throw new Error("No voice-activity detector for another session (makeVad not given)")
    return vad
  }
  const takeAgc = (options) => idle(idleAgcs, JSON.stringify(options)).pop() ?? deps.makeAgc?.(options)

  /** A session's options: what `open` says, else the worker's configuration (the protocol before per-stream options). */
  const sessionOptions = (options) => {
    const threshold = typeof options?.vadThreshold === "number" ? options.vadThreshold : defaultThreshold
    const agc = options === undefined || !("agc" in options) ? config.agc : options.agc
    const prerollMs = typeof options?.prerollMs === "number" ? options.prerollMs : config.prerollMs
    return { threshold, agc: agc === false || agc === undefined || agc === null ? false : agc, prerollMs }
  }

  const endSession = (id) => {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    s.state.end()
    s.state.vad.reset()
    giveBackVad(s.threshold, s.state.vad)
    if (s.state.agc) {
      s.state.agc.reset()
      idle(idleAgcs, JSON.stringify(s.agc)).push(s.state.agc)
    }
  }

  const openSessionById = (id, options) => {
    endSession(id)
    const o = sessionOptions(options)
    const vad = takeVad(o.threshold)
    vad.reset()
    const agc = o.agc === false ? undefined : takeAgc(o.agc)
    agc?.reset()
    sessions.set(id, { state: openSession(id, vad, agc, o.prerollMs), threshold: o.threshold, agc: o.agc })
  }

  const onMessage = (message) => {
    try {
      if (message.type === "close") {
        closing = true
        for (const id of [...sessions.keys()]) endSession(id) // later audio and requests are ignored
        queue.dropWhere(() => true)
        queue.idle().then(() => post({ type: "closed" }))
        return
      }
      if (closing) return
      if (message.type === "open") return openSessionById(message.session, message.options)
      if (message.type === "end") return endSession(message.session)
      if (message.type === "reset") {
        // One session at a time (the protocol before several sessions): every other session ends.
        for (const id of [...sessions.keys()]) endSession(id)
        if (message.session > 0) openSessionById(message.session, message.options)
        return
      }
      const s = sessions.get(message.session)?.state
      if (!s) return
      if (message.type === "audio") s.onAudio(message.buffer)
      else if (message.type === "finalize") s.onFinalize(message.frame, message.through === true)
      else if (message.type === "commit") s.onCommit(message.frame)
      else if (message.type === "flush") s.onFlush()
    } catch (error) {
      post({ type: "error", session: message?.session ?? 0, message: String(error?.stack ?? error) })
    }
  }

  return {
    onMessage,
    /** For tests and measurements (frames and pieces summed over the open sessions). */
    inspect: () => {
      let retainedStreamingFrames = 0
      let pieces = 0
      for (const s of sessions.values()) {
        const i = s.state.inspect()
        retainedStreamingFrames += i.retainedStreamingFrames
        pieces += i.pieces
      }
      return {
        queuedSamples: queue.queuedSamples,
        pendingDecodes: queue.pending,
        retainedStreamingFrames,
        pieces,
        sessions: sessions.size,
        idleVads: idleVads.length,
        stats: { ...stats }
      }
    }
  }
}
