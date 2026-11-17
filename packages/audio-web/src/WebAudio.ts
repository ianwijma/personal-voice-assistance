import { AudioError, AudioInput, AudioOutput, CurrentTurnTrace, type PlaybackObserver } from "@pva/core"
import { type ClientMessageOf, encodeReplyFrame, MAX_FRAME_PAYLOAD_BYTES, MIC_FRAME_SAMPLES, type ServerMessage } from "@pva/protocol"
import { Clock, Deferred, Effect, Queue, type Scope, Stream } from "effect"

/**
 * The browser as the assistant's microphone and speaker
 * (docs/UI-AND-MODULES.md §2.6, §4.2), over an abstract link to the audio
 * owner's connection, so it has no WebSocket dependency and is unit-testable.
 *
 * - `input.stream` is a continuous real-time 16 kHz stream: the owner's
 *   microphone frames while there is an owner with a live microphone (and the
 *   echo gate does not suppress it), otherwise a −75 dBFS noise floor in 20 ms
 *   chunks, so every STT adapter sees what it sees from a real microphone.
 * - `output.play` sends reply audio to the owner as fast as it is produced
 *   (never paced), then waits for the browser's playback reports, which it
 *   passes to `Conversation` through the `PlaybackObserver`.
 */

/** The audio owner's connection, as far as the audio is concerned. */
export interface AudioClientLink {
  readonly sendMessage: (message: ServerMessage) => void
  readonly sendBinary: (frame: Uint8Array) => void
}

export type PlaybackEvent =
  | { readonly _tag: "started"; readonly turnId: number }
  | { readonly _tag: "ended"; readonly turnId: number; readonly reason: "finished" | "stopped" | "failed" }

export type PlaybackReport = ClientMessageOf<"playback.started" | "playback.progress" | "playback.finished" | "playback.stopped">

export interface WebAudioOptions {
  /** No playback report for this long while waiting for the end of a reply: stop it and fail. Default 2000 ms. */
  readonly stallMs?: number
  /**
   * After an interruption, how long to wait for `playback.stopped`. Default 300 ms. A provisional count
   * (`exact: false`) does not end the wait: an exact one is awaited within the same deadline, and the
   * provisional count is used if none comes.
   */
  readonly stopWaitMs?: number
  /** Playback started / ended in the owner's browser (the state tracker and the echo gate listen). */
  readonly onPlayback?: (event: PlaybackEvent) => void
  /** The browser stopped reporting: the reply was stopped (`playback_timeout`). */
  readonly onStall?: (turnId: number) => void
  /** Rate-limited lines about playback reports that failed validation (a faulty or hostile page). */
  readonly log?: (line: string) => void
}

export interface WebAudio {
  readonly input: AudioInput["Service"]
  readonly output: AudioOutput["Service"]
  /** The audio owner changed (`undefined`: nobody owns the audio). A reply playing to the previous owner fails. */
  readonly setOwner: (link: AudioClientLink | undefined) => void
  /** A microphone frame from the owner (PCM s16le, 16 kHz; the header already removed). */
  readonly micFrame: (pcm: Uint8Array) => void
  /** The owner's microphone is on or off (`mic.state`). */
  readonly setMicLive: (live: boolean) => void
  /** Feed the noise floor instead of the microphone (manual interrupt mode while the assistant is audible). */
  readonly setSuppressed: (suppressed: boolean) => void
  /**
   * A playback report from `from` (default: the owner). Only the link the reply is playing to may report on it,
   * whether or not it still owns the audio: after a takeover the previous owner's answer to `reply.stop` is the
   * count of what it played. Reports for any other reply, or from any other link, are ignored.
   */
  readonly report: (message: PlaybackReport, from?: AudioClientLink) => void
  /** Whether microphone frames currently reach the recogniser. */
  readonly micRouted: () => boolean
  /** The reply currently being sent or played, if any. */
  readonly playingTurn: () => number | undefined
  /** Counters of the microphone path since start (for the "what the assistant hears" diagnostic). */
  readonly inputStats: () => InputStats
}

export interface InputStats {
  /** Microphone frames that reached the recogniser's queue. */
  readonly micFrames: number
  /** Frames (microphone or noise floor) dropped because the recogniser fell more than `queueFrames` behind. */
  readonly droppedFrames: number
  /** Noise-floor frames fed instead of the microphone (nobody owns the audio, the mic is off, or it is suppressed). */
  readonly noiseFrames: number
  /** Microphone frames that arrived while they were not routed (and so were thrown away). */
  readonly unroutedMicFrames: number
  /** Longest gap between two microphone frames while routed, in ms, since the previous `inputStats()` call. */
  readonly maxMicGapMs: number
}

/** Amplitude of the noise floor: uniform ±10 of 32768, about −75 dBFS RMS (as the file backend). */
export const NOISE_FLOOR_AMPLITUDE = 10
const FRAME_MS = 20
const INVALID_LOG_MS = 10_000

interface Session {
  readonly turnId: number
  readonly link: AudioClientLink
  readonly observer: PlaybackObserver | undefined
  readonly trace: { client?: { readonly outputLatencyMs: number; readonly startDelayMs: number } } | undefined
  /**
   * Samples sent to `link` for this reply (16-bit mono at the rate announced in `reply.start`, the unit the page
   * counts in). Every reported count is clamped to it. Audio is sent in order and, once one chunk was not sent
   * (`cut`), never again for this reply, so the samples sent are a prefix of the audio pulled from the
   * conversation: a count up to `transmitted` never reaches a clause whose audio was not sent.
   */
  transmitted: number
  /** A chunk was not sent (the link no longer owns the audio): nothing more is sent for this reply. */
  cut: boolean
  /** The highest valid count reported so far: what `progress` reports (non-decreasing). */
  played: number
  /**
   * The count the reply's final report committed (finished, exact stop, or the provisional count made final), as
   * the page sent it after validation and clamping: unlike `played` it may be lower than an earlier progress count.
   * Passed to `PlaybackObserver.final` when the reply ends.
   */
  committed: number | undefined
  /** `PlaybackObserver.final` was called (at most once per reply). */
  finalReported: boolean
  started: boolean
  /** All audio was sent (`reply.end`); waiting for the browser. */
  sent: boolean
  /** Final count received (finished or stopped); later reports are ignored. */
  final: "finished" | "stopped" | undefined
  /**
   * The first `playback.stopped` with `exact: false`: the page's best count, sent before its player confirmed.
   * Not final: an exact report replaces it (lower or higher); it becomes final when the stop's wait runs out,
   * or when the reply ends any other way first (owner gone, stall). Later provisional reports are ignored.
   */
  provisional: number | undefined
  /** The stall watchdog already sent `reply.stop` and gave up on the browser. */
  stalled: boolean
  /** Another tab took the audio: this link was sent `reply.stop` and may still report its final count. */
  takenOver: boolean
  lastReportAt: number
  readonly done: Deferred.Deferred<void>
  readonly lost: Deferred.Deferred<void>
}

export const makeWebAudio = (options: WebAudioOptions = {}): Effect.Effect<WebAudio, never, Scope.Scope> =>
  Effect.gen(function*() {
    const clock = yield* Effect.clockWith(Effect.succeed)
    const now = () => clock.currentTimeMillisUnsafe()
    const stallMs = options.stallMs ?? 2_000
    const stopWaitMs = options.stopWaitMs ?? 300
    const notify = (event: PlaybackEvent) => {
      try {
        options.onPlayback?.(event)
      } catch {
        // listeners must not break playback
      }
    }

    let owner: AudioClientLink | undefined
    let micLive = false
    let suppressed = false
    let active: Session | undefined
    let fallbackTurnId = 0x8000_0000

    /**
     * Playback reports that failed validation: logged at the first, then at most one line per `INVALID_LOG_MS`
     * with the number since the previous line.
     */
    let invalidReports = 0
    let invalidLoggedAt: number | undefined
    const invalid = (session: Session, message: PlaybackReport, why: string) => {
      invalidReports++
      const at = now()
      if (invalidLoggedAt !== undefined && at - invalidLoggedAt < INVALID_LOG_MS) return
      invalidLoggedAt = at
      const count = invalidReports
      invalidReports = 0
      try {
        options.log?.(
          `Ignored or corrected ${count} playback report${count === 1 ? "" : "s"} from the page (latest: ${message.type} for turn ` +
            `${session.turnId}, ${why}); a page should never send these`
        )
      } catch {
        // listeners must not break playback
      }
    }

    /**
     * A reported count, validated: rounded down; `undefined` (ignored) when negative or not a finite number;
     * clamped to the samples sent to the reporting link for this reply.
     */
    const counted = (session: Session, message: PlaybackReport & { readonly playedSamples: number }): number | undefined => {
      const raw = message.playedSamples
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        invalid(session, message, `count ${String(raw)}`)
        return undefined
      }
      const whole = Math.floor(raw)
      if (whole > session.transmitted) {
        invalid(session, message, `count ${raw} beyond the ${session.transmitted} samples sent`)
        return session.transmitted
      }
      if (whole !== raw) invalid(session, message, `count ${raw} not a whole number`)
      return whole
    }

    const routed = () => owner !== undefined && micLive && !suppressed

    // Three seconds of audio; if the consumer falls behind, the oldest is dropped (a growing queue is latency).
    // The consumer normally keeps up within a frame; the room is for a burst (a throttled tab or a Wi-Fi stall
    // delivering a second of frames at once), which with one second of room lost speech. Drops are counted.
    // Bounded in bytes too: frames of any even length are accepted (up to 256 KiB each), so a count alone
    // would let one client park ~37 MiB and minutes of audio here.
    const QUEUE_FRAMES = 150
    const QUEUE_BYTES = QUEUE_FRAMES * MIC_FRAME_SAMPLES * 2
    const frames = yield* Queue.unbounded<Uint8Array>()
    let queuedBytes = 0
    const stats = { micFrames: 0, droppedFrames: 0, noiseFrames: 0, unroutedMicFrames: 0, maxMicGapMs: 0 }
    let lastMicAt = 0
    const offer = (input: Uint8Array) => {
      // A single frame larger than the whole queue keeps only its newest three seconds (sample-aligned:
      // QUEUE_BYTES is even, and so is every accepted frame).
      const frame = input.length > QUEUE_BYTES ? input.subarray(input.length - QUEUE_BYTES) : input
      if (frame !== input) stats.droppedFrames++
      while (Queue.sizeUnsafe(frames) > 0 && (Queue.sizeUnsafe(frames) >= QUEUE_FRAMES || queuedBytes + frame.length > QUEUE_BYTES)) {
        const oldest = Queue.takeUnsafe(frames)
        if (oldest === undefined || oldest._tag !== "Success") break
        queuedBytes -= oldest.value.length
        stats.droppedFrames++
      }
      queuedBytes += frame.length
      Queue.offerUnsafe(frames, frame)
    }

    // Noise floor: one frame every 20 ms, scheduled against a start time so it does not drift.
    let noise = 0x2545f491
    const noiseFrame = () => {
      const samples = new Int16Array(MIC_FRAME_SAMPLES)
      for (let i = 0; i < samples.length; i++) {
        noise ^= noise << 13
        noise ^= noise >>> 17
        noise ^= noise << 5
        samples[i] = ((noise >>> 0) % (2 * NOISE_FLOOR_AMPLITUDE + 1)) - NOISE_FLOOR_AMPLITUDE
      }
      return new Uint8Array(samples.buffer)
    }
    yield* Effect.gen(function*() {
      let start = yield* Clock.currentTimeMillis
      let tick = 0
      while (true) {
        tick++
        const current = yield* Clock.currentTimeMillis
        let due = start + tick * FRAME_MS
        if (current - due > 1_000) {
          // The process was suspended: restart the schedule rather than burst.
          start = current
          tick = 1
          due = start + FRAME_MS
        }
        if (due > current) yield* Effect.sleep(due - current)
        if (!routed()) {
          stats.noiseFrames++
          offer(noiseFrame())
        }
      }
    }).pipe(Effect.forkScoped)

    let consumers = 0
    const input = AudioInput.of({
      // A later consumer (after an engine reload) starts from now, not from stale frames. The first one takes what
      // arrived before it (a voice session is created at the claim: the owner's first frames may come first).
      stream: Stream.unwrap(Effect.as(
        Effect.suspend(() =>
          consumers++ === 0 ? Effect.void : Effect.andThen(Queue.clear(frames), Effect.sync(() => void (queuedBytes = 0)))
        ),
        Stream.fromQueue(frames).pipe(Stream.tap((frame) => Effect.sync(() => void (queuedBytes -= frame.length))))
      ))
    })

    const finish = (session: Session, kind: "finished" | "stopped", playedSamples: number) => {
      if (session.final !== undefined) return
      session.final = kind
      session.committed = playedSamples
      session.played = Math.max(session.played, playedSamples)
      session.lastReportAt = now()
      session.observer?.progress(session.played)
      Deferred.doneUnsafe(session.done, Effect.void)
    }

    /**
     * The reply ended (any way): the authoritative count, once: the committed final count, else the last valid
     * progress count. After the last `progress`, before `play` returns or its interruption completes.
     */
    const reportFinal = (session: Session) => {
      if (session.finalReported) return
      session.finalReported = true
      try {
        session.observer?.final?.(session.committed ?? session.played)
      } catch {
        // the observer must not break playback's own cleanup
      }
    }

    /** No exact count came in time: the provisional one is final (better than the last progress report). */
    const commitProvisional = (session: Session) => {
      if (session.final === undefined && session.provisional !== undefined) finish(session, "stopped", session.provisional)
    }

    const report = (message: PlaybackReport, from: AudioClientLink | undefined = owner) => {
      const session = active
      if (session === undefined || message.turnId !== session.turnId || from !== session.link) return
      switch (message.type) {
        case "playback.started": {
          if (session.started) return
          // Nothing was sent yet: nothing can have started playing (the first clause would count as heard).
          if (session.transmitted === 0) return invalid(session, message, "before any audio was sent")
          session.started = true
          session.lastReportAt = now()
          if (session.trace !== undefined) {
            session.trace.client = { outputLatencyMs: message.outputLatencyMs, startDelayMs: message.startDelayMs }
          }
          // The state goes to "speaking" before the first clause is reported as playing.
          notify({ _tag: "started", turnId: session.turnId })
          session.observer?.started()
          return
        }
        case "playback.progress": {
          if (session.final !== undefined) return
          const played = counted(session, message)
          if (played === undefined) return
          session.lastReportAt = now()
          // Non-decreasing within a reply: a decrease is ignored, not applied.
          if (played < session.played) return invalid(session, message, `progress went back from ${session.played} to ${played}`)
          if (played > session.played) {
            session.played = played
            session.observer?.progress(session.played)
          }
          return
        }
        case "playback.finished": {
          // The page finishes when its player drains after `reply.end`, and `sent` is set right after `reply.end`
          // was sent, so a legitimate finish always finds it set. One before it is a faulty page, or an underrun
          // taken for the end: ignoring it keeps the reply open, so the audio still to come is accounted for.
          if (session.final !== undefined) return
          if (!session.sent) return invalid(session, message, "before the reply's end was sent")
          const played = counted(session, message)
          return played === undefined ? undefined : finish(session, "finished", played)
        }
        case "playback.stopped": {
          const played = counted(session, message)
          if (played === undefined) return
          if (message.exact === false) {
            if (session.final !== undefined || session.provisional !== undefined) return
            session.provisional = played
            session.lastReportAt = now()
            return
          }
          return finish(session, "stopped", played)
        }
      }
    }

    const sendAudio = (session: Session, chunk: Uint8Array) => {
      if (session.cut || owner !== session.link) {
        session.cut = true
        return
      }
      const usable = chunk.length - (chunk.length % 2)
      for (let offset = 0; offset < usable; offset += MAX_FRAME_PAYLOAD_BYTES) {
        session.link.sendBinary(encodeReplyFrame(session.turnId, chunk.subarray(offset, Math.min(usable, offset + MAX_FRAME_PAYLOAD_BYTES))))
      }
      session.transmitted += usable >> 1
    }

    /** Fails when the browser stops reporting while the server waits for it. */
    const watchStall = (session: Session) =>
      Effect.gen(function*() {
        while (true) {
          yield* Effect.sleep(Math.min(250, stallMs))
          const waiting = session.sent || session.final === "stopped" || session.provisional !== undefined
          if (waiting && now() - session.lastReportAt >= stallMs) {
            session.stalled = true
            if (owner === session.link) session.link.sendMessage({ type: "reply.stop", turnId: session.turnId })
            options.onStall?.(session.turnId)
            return yield* new AudioError({ message: "playback_timeout: the browser stopped reporting playback; the reply was stopped" })
          }
        }
      })

    const play = <E>(audio: Stream.Stream<Uint8Array, E>, sampleRate: number, observer?: PlaybackObserver) =>
      Effect.gen(function*() {
        const link = owner
        if (link === undefined) return yield* new AudioError({ message: "no audio client: nobody has pressed Start" })
        const trace = yield* CurrentTurnTrace
        const turnId = trace?.id ?? fallbackTurnId++
        const session: Session = {
          turnId,
          link,
          observer,
          trace,
          transmitted: 0,
          cut: false,
          played: 0,
          committed: undefined,
          finalReported: false,
          started: false,
          sent: false,
          final: undefined,
          provisional: undefined,
          stalled: false,
          takenOver: false,
          lastReportAt: now(),
          done: yield* Deferred.make<void>(),
          lost: yield* Deferred.make<void>()
        }
        active = session
        link.sendMessage({
          type: "reply.start",
          turnId,
          sampleRate: Math.round(sampleRate),
          // Protocol 7: whose voice this is (the turn's assistant, when the conversation's trace names one).
          ...(trace?.assistant !== undefined ? { assistantId: trace.assistant.id } : {})
        })

        const body = Effect.gen(function*() {
          yield* Stream.runForEach(audio, (chunk) => Effect.sync(() => sendAudio(session, chunk)))
          // `sent` first: a page's `playback.finished` answers `reply.end`, and must find it set however soon it comes.
          session.sent = true
          session.lastReportAt = now()
          if (owner === link) link.sendMessage({ type: "reply.end", turnId })
          yield* Deferred.await(session.done)
          if (session.final === "stopped") {
            // The browser stopped on its own (the user pressed Stop): the interruption is on its way.
            return yield* Effect.never
          }
        })

        const lostOwner = Effect.andThen(
          Deferred.await(session.lost),
          Effect.fail(new AudioError({ message: "audio client disconnected" }))
        )

        /**
         * Any end other than success (interrupted, or the audio failed upstream) while the browser may still be
         * playing: tell it to stop, wait (bounded) for its final count while the session still accepts it, and
         * report that count, so history holds what was heard and no audio plays after the turn is over.
         * Not after a stall (already stopped; the browser is not answering) or once the owner is gone. After a
         * takeover the previous owner was already sent `reply.stop` (by `setOwner`); its answer is awaited the same way.
         * A provisional count (`exact: false`) does not end the wait; it is used when the wait ends without an
         * exact one, and also when the wait is skipped (stall, owner gone) after one arrived.
         */
        let stoppedAfterFailure = false
        const stopAndReport = (interrupted: boolean) =>
          Effect.suspend(() => {
            if (session.final !== undefined || session.stalled || (owner !== link && !session.takenOver)) {
              commitProvisional(session)
              return interrupted ? Effect.sync(() => observer?.progress(session.played)) : Effect.void
            }
            stoppedAfterFailure = !interrupted || session.takenOver
            if (!session.takenOver) link.sendMessage({ type: "reply.stop", turnId })
            return Deferred.await(session.done).pipe(
              Effect.timeoutOrElse({ duration: stopWaitMs, orElse: () => Effect.sync(() => commitProvisional(session)) }),
              Effect.andThen(Effect.sync(() => observer?.progress(session.played)))
            )
          })

        yield* Effect.raceFirst(body, Effect.raceFirst(lostOwner, watchStall(session))).pipe(
          Effect.onExit((exit) => (exit._tag === "Success" ? Effect.void : stopAndReport(isInterruptOnly(exit.cause)))),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              reportFinal(session)
              if (active === session) active = undefined
              if (session.started) {
                const reason = exit._tag === "Success" || session.final === "finished"
                  ? "finished"
                  : !stoppedAfterFailure && (session.final === "stopped" || exit._tag === "Failure" && isInterruptOnly(exit.cause))
                  ? "stopped"
                  : "failed"
                notify({ _tag: "ended", turnId, reason })
              }
            })
          )
        )
      })

    const setOwner = (link: AudioClientLink | undefined) => {
      if (link === owner) return
      const previous = owner
      owner = link
      const session = active
      if (session !== undefined && session.link === previous) {
        // Taken over: the previous owner stops playing at once (no more audio goes to it), and the reply ends
        // after its final count (bounded by `stopWaitMs`), so history holds what it played.
        if (link !== undefined && previous !== undefined && session.final === undefined && !session.stalled) {
          session.takenOver = true
          previous.sendMessage({ type: "reply.stop", turnId: session.turnId })
        }
        Deferred.doneUnsafe(session.lost, Effect.void)
      }
    }

    return {
      input,
      output: AudioOutput.of({ reportsPlayback: true, play }),
      setOwner,
      micFrame: (pcm) => {
        if (pcm.length === 0) return
        if (!routed()) {
          stats.unroutedMicFrames++
          return
        }
        const at = now()
        if (lastMicAt > 0) stats.maxMicGapMs = Math.max(stats.maxMicGapMs, at - lastMicAt)
        lastMicAt = at
        stats.micFrames++
        offer(pcm)
      },
      setMicLive: (live) => {
        micLive = live
        lastMicAt = 0
      },
      setSuppressed: (value) => {
        suppressed = value
      },
      report,
      micRouted: routed,
      playingTurn: () => active?.turnId,
      inputStats: () => {
        const snapshot = { ...stats }
        stats.maxMicGapMs = 0
        return snapshot
      }
    } satisfies WebAudio
  })

const isInterruptOnly = (cause: { readonly reasons: ReadonlyArray<{ readonly _tag: string }> }) =>
  cause.reasons.length > 0 && cause.reasons.every((r) => r._tag === "Interrupt")
