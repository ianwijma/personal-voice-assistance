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
  /** After an interruption, how long to wait for `playback.stopped`. Default 300 ms. */
  readonly stopWaitMs?: number
  /** Playback started / ended in the owner's browser (the state tracker and the echo gate listen). */
  readonly onPlayback?: (event: PlaybackEvent) => void
  /** The browser stopped reporting: the reply was stopped (`playback_timeout`). */
  readonly onStall?: (turnId: number) => void
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
  /** A playback report from the owner. Reports for any reply other than the one playing are ignored. */
  readonly report: (message: PlaybackReport) => void
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

interface Session {
  readonly turnId: number
  readonly link: AudioClientLink
  readonly observer: PlaybackObserver | undefined
  readonly trace: { client?: { readonly outputLatencyMs: number; readonly startDelayMs: number } } | undefined
  played: number
  started: boolean
  /** All audio was sent (`reply.end`); waiting for the browser. */
  sent: boolean
  /** Final count received (finished or stopped); later reports are ignored. */
  final: "finished" | "stopped" | undefined
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

    const routed = () => owner !== undefined && micLive && !suppressed

    // Three seconds of audio; if the consumer falls behind, the oldest is dropped (a growing queue is latency).
    // The consumer normally keeps up within a frame; the room is for a burst (a throttled tab or a Wi-Fi stall
    // delivering a second of frames at once), which with one second of room lost speech. Drops are counted.
    const QUEUE_FRAMES = 150
    const frames = yield* Queue.sliding<Uint8Array>(QUEUE_FRAMES)
    const stats = { micFrames: 0, droppedFrames: 0, noiseFrames: 0, unroutedMicFrames: 0, maxMicGapMs: 0 }
    let lastMicAt = 0
    const offer = (frame: Uint8Array) => {
      if (Queue.sizeUnsafe(frames) >= QUEUE_FRAMES) stats.droppedFrames++
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

    const input = AudioInput.of({
      // A new consumer (after an engine reload) starts from now, not from stale frames.
      stream: Stream.unwrap(Effect.as(Queue.clear(frames), Stream.fromQueue(frames)))
    })

    const finish = (session: Session, kind: "finished" | "stopped", playedSamples: number) => {
      if (session.final !== undefined) return
      session.final = kind
      session.played = Math.max(session.played, playedSamples)
      session.lastReportAt = now()
      session.observer?.progress(session.played)
      Deferred.doneUnsafe(session.done, Effect.void)
    }

    const report = (message: PlaybackReport) => {
      const session = active
      if (session === undefined || message.turnId !== session.turnId) return
      switch (message.type) {
        case "playback.started": {
          if (session.started) return
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
          session.lastReportAt = now()
          if (message.playedSamples > session.played) {
            session.played = message.playedSamples
            session.observer?.progress(session.played)
          }
          return
        }
        case "playback.finished":
          return finish(session, "finished", message.playedSamples)
        case "playback.stopped":
          return finish(session, "stopped", message.playedSamples)
      }
    }

    const sendAudio = (session: Session, chunk: Uint8Array) => {
      if (owner !== session.link) return
      const usable = chunk.length - (chunk.length % 2)
      for (let offset = 0; offset < usable; offset += MAX_FRAME_PAYLOAD_BYTES) {
        session.link.sendBinary(encodeReplyFrame(session.turnId, chunk.subarray(offset, Math.min(usable, offset + MAX_FRAME_PAYLOAD_BYTES))))
      }
    }

    /** Fails when the browser stops reporting while the server waits for it. */
    const watchStall = (session: Session) =>
      Effect.gen(function*() {
        while (true) {
          yield* Effect.sleep(Math.min(250, stallMs))
          const waiting = session.sent || session.final === "stopped"
          if (waiting && now() - session.lastReportAt >= stallMs) {
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
          played: 0,
          started: false,
          sent: false,
          final: undefined,
          lastReportAt: now(),
          done: yield* Deferred.make<void>(),
          lost: yield* Deferred.make<void>()
        }
        active = session
        link.sendMessage({ type: "reply.start", turnId, sampleRate: Math.round(sampleRate) })

        const body = Effect.gen(function*() {
          yield* Stream.runForEach(audio, (chunk) => Effect.sync(() => sendAudio(session, chunk)))
          if (owner === link) link.sendMessage({ type: "reply.end", turnId })
          session.sent = true
          session.lastReportAt = now()
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

        const stopOnInterrupt = Effect.suspend(() => {
          if (session.final !== undefined || owner !== link) return Effect.void
          link.sendMessage({ type: "reply.stop", turnId })
          return Deferred.await(session.done).pipe(Effect.timeoutOrElse({ duration: stopWaitMs, orElse: () => Effect.void }))
        }).pipe(Effect.andThen(Effect.sync(() => observer?.progress(session.played))))

        yield* Effect.raceFirst(body, Effect.raceFirst(lostOwner, watchStall(session))).pipe(
          Effect.onInterrupt(() => stopOnInterrupt),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (active === session) active = undefined
              if (session.started) {
                const reason = exit._tag === "Success" || session.final === "finished"
                  ? "finished"
                  : session.final === "stopped" || exit._tag === "Failure" && isInterruptOnly(exit.cause)
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
        // Taken over: the previous owner stops playing at once.
        if (link !== undefined && previous !== undefined) previous.sendMessage({ type: "reply.stop", turnId: session.turnId })
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
