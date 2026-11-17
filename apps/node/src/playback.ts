/**
 * Reply playback on the node, reported like a browser does (docs/VOICE-NODES.md §4.4): the node is a
 * "reports playback" output, so the server's `WebAudioOutput`, interrupted history and playback timeout work
 * unchanged.
 *
 * - `reply.start` starts one `AudioOutput.play` (for the device backends a player process per reply, as
 *   audio-pipewire does). Reply frames go into an unbounded in-memory queue: the server sends a reply as fast as it
 *   is synthesised and a reply is bounded by the server's limits, so nothing is ever dropped.
 * - Each frame is scaled by the volume gain `g = (volume / 100)²` on an `Int16Array`, clipped; no per-sample Effects.
 * - `playback.started` when the first chunk is handed to the player; `playback.progress` every 250 ms with a
 *   clock estimate clamped to what was written (`PlaybackClock`); `playback.finished { written }` when `play` returns
 *   after the player drained; `playback.stopped { estimate, exact: true }` once the player is killed on `reply.stop`
 *   (or when playback failed). The node's count is its final word, so it is always `exact`.
 * - A cue never plays over a reply (it is skipped), a reply start cuts a cue short, and cues are never reported.
 * - Losing the connection stops the reply without a report: the server has already failed the turn (owner lost),
 *   and audio it believes unheard should not go on playing.
 */
import { type ClientMessage, pcmSamples } from "@pva/protocol"
import type { AudioOutput } from "@pva/core"
import { type Cause, Effect, Fiber, Queue, Stream } from "effect"

/**
 * When the written audio has been heard, estimated from a clock (the player gives no count back).
 *
 * Audio is assumed to play in real time from the first write, `latencyMs` after it is written. When the written
 * audio has all been played before the next write arrives (an underrun: the server's audio came slower than real
 * time), playback is taken to restart at that write, so the idle time is not counted as played. The estimate never
 * exceeds the samples written and never decreases.
 */
export class PlaybackClock {
  written = 0
  underruns = 0
  private runStartMs: number | undefined
  private runStartSamples = 0
  private highest = 0

  readonly sampleRate: number
  readonly latencyMs: number

  constructor(sampleRate: number, latencyMs: number) {
    this.sampleRate = sampleRate
    this.latencyMs = latencyMs
  }

  /** `samples` were handed to the player at `nowMs`. */
  write(samples: number, nowMs: number): void {
    if (this.runStartMs === undefined) {
      this.runStartMs = nowMs
    } else if (this.estimate(nowMs) >= this.written) {
      this.underruns += 1
      this.runStartSamples = this.written
      this.runStartMs = nowMs
    }
    this.written += samples
  }

  private estimate(nowMs: number): number {
    if (this.runStartMs === undefined) return 0
    const elapsed = Math.max(0, nowMs - this.runStartMs - this.latencyMs)
    return Math.min(this.written, this.runStartSamples + Math.round((elapsed * this.sampleRate) / 1000))
  }

  /** Samples heard by `nowMs`: non-decreasing, at most `written`. */
  played(nowMs: number): number {
    this.highest = Math.max(this.highest, this.estimate(nowMs))
    return this.highest
  }
}

/** `(volume / 100)²`, volume clamped to 0..100: 0 is silent, 50 ≈ −12 dB, 100 is unchanged. */
export const volumeGain = (volume: number): number => {
  const v = Math.min(100, Math.max(0, volume)) / 100
  return v * v
}

/** Scale s16le PCM by `gain` (clipped) into a new buffer; `gain === 1` returns the input as is. */
export const applyGain = (pcm: Uint8Array, gain: number): Uint8Array => {
  if (gain === 1) return pcm
  const input = pcmSamples(pcm)
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.round(input[i]! * gain)
    output[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s
  }
  return new Uint8Array(output.buffer)
}

export interface ReplyPlayerOptions {
  /** The output now in use: read at each reply and cue, so a changed `soundDevices.output` applies from the next play. */
  readonly output: () => AudioOutput["Service"]
  readonly cueOutput: () => AudioOutput["Service"]
  /** A reply or cue could not be played (the device failed to open or the player died). */
  readonly onPlayFailed?: (cause: string) => void
  /** Reported as `playback.started.outputLatencyMs` and used by the clock. */
  readonly outputLatencyMs: number
  /** 0..100, read at each frame (so a profile change applies within a reply). */
  readonly volume: () => number
  /** Playback reports go here (dropped by the caller while disconnected). */
  readonly send: (message: ClientMessage) => void
  /** Runs a fiber with the node's services; the caller owns their lifetime. */
  readonly fork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>
  readonly now?: () => number
  readonly progressMs?: number
  readonly log?: (line: string) => void
}

interface Reply {
  readonly turnId: number
  readonly sampleRate: number
  readonly queue: Queue.Queue<Uint8Array, Cause.Done>
  readonly clock: PlaybackClock
  firstFrameAt: number | undefined
  /** Set once a final report (finished / stopped) was sent, or must not be sent. */
  settled: boolean
  fiber: Fiber.Fiber<void, unknown> | undefined
}

export interface ReplyPlayer {
  readonly start: (turnId: number, sampleRate: number) => void
  readonly frame: (turnId: number, pcm: Uint8Array) => void
  readonly end: (turnId: number) => void
  /** `reply.stop`: silence now, then answer `playback.stopped`. Resolves once the answer was sent. */
  readonly stop: (turnId: number) => Promise<void>
  /** The connection is gone: silence now, report nothing. */
  readonly lost: () => void
  /** Play a cue unless a reply is playing. */
  readonly cue: (samples: Int16Array, sampleRate: number) => void
  /** The turn whose reply is playing, if any. */
  readonly playing: () => number | undefined
}

export const PROGRESS_MS = 250

export const makeReplyPlayer = (options: ReplyPlayerOptions): ReplyPlayer => {
  const now = options.now ?? (() => performance.now())
  const progressMs = options.progressMs ?? PROGRESS_MS
  const log = options.log ?? (() => {})
  let current: Reply | undefined
  let cueFiber: Fiber.Fiber<void, unknown> | undefined

  const stopCue = () => {
    if (cueFiber !== undefined) options.fork(Fiber.interrupt(cueFiber))
    cueFiber = undefined
  }

  const report = (reply: Reply, message: ClientMessage) => {
    if (!reply.settled) options.send(message)
  }

  const finalStopped = (reply: Reply) => {
    if (reply.settled) return
    reply.settled = true
    options.send({ type: "playback.stopped", turnId: reply.turnId, playedSamples: reply.clock.played(now()), exact: true })
  }

  const run = (reply: Reply) => {
    let started = false
    const onWrite = (chunk: Uint8Array) =>
      Effect.sync(() => {
        const t = now()
        reply.clock.write(chunk.length >> 1, t)
        if (started) return
        started = true
        report(reply, {
          type: "playback.started",
          turnId: reply.turnId,
          outputLatencyMs: options.outputLatencyMs,
          startDelayMs: Math.max(0, t - (reply.firstFrameAt ?? t))
        })
      })
    const progress = Effect.gen(function*() {
      while (true) {
        yield* Effect.sleep(progressMs)
        if (!started) continue
        report(reply, { type: "playback.progress", turnId: reply.turnId, playedSamples: reply.clock.played(now()), underruns: reply.clock.underruns })
      }
    })
    const audio = Stream.fromQueue(reply.queue).pipe(Stream.tap(onWrite))
    return Effect.scoped(Effect.gen(function*() {
      yield* Effect.forkScoped(progress)
      yield* options.output().play(audio, reply.sampleRate)
    })).pipe(
      Effect.matchCause({
        onSuccess: () => {
          if (reply.settled) return
          reply.settled = true
          options.send({ type: "playback.finished", turnId: reply.turnId, playedSamples: reply.clock.written })
        },
        onFailure: (cause) => {
          log(`reply ${reply.turnId}: playback failed: ${String(cause)}`)
          options.onPlayFailed?.(String(cause))
          finalStopped(reply)
        }
      }),
      Effect.ensuring(Effect.sync(() => {
        if (current === reply) current = undefined
      }))
    )
  }

  /** Interrupt a reply's player; `answer` = send `playback.stopped` afterwards. */
  const halt = (reply: Reply, answer: boolean): Promise<void> => {
    if (!answer) reply.settled = true
    const fiber = reply.fiber
    if (current === reply) current = undefined
    if (fiber === undefined) {
      if (answer) finalStopped(reply)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      // The interruption completes once the player is killed (audio-pipewire waits for the process to be gone).
      options.fork(Fiber.interrupt(fiber).pipe(Effect.ensuring(Effect.sync(() => {
        if (answer) finalStopped(reply)
        resolve()
      }))))
    })
  }

  return {
    start: (turnId, sampleRate) => {
      stopCue()
      if (current !== undefined) void halt(current, true)
      const reply: Reply = {
        turnId,
        sampleRate,
        queue: Effect.runSync(Queue.unbounded<Uint8Array, Cause.Done>()),
        clock: new PlaybackClock(sampleRate, options.outputLatencyMs),
        firstFrameAt: undefined,
        settled: false,
        fiber: undefined
      }
      current = reply
      reply.fiber = options.fork(run(reply))
    },
    frame: (turnId, pcm) => {
      const reply = current
      if (reply === undefined || reply.turnId !== turnId) return
      reply.firstFrameAt ??= now()
      Queue.offerUnsafe(reply.queue, applyGain(pcm, volumeGain(options.volume())))
    },
    end: (turnId) => {
      if (current?.turnId === turnId) Queue.endUnsafe(current.queue)
    },
    stop: (turnId) => current?.turnId === turnId ? halt(current, true) : Promise.resolve(),
    lost: () => {
      stopCue()
      if (current !== undefined) void halt(current, false)
    },
    cue: (samples, sampleRate) => {
      if (current !== undefined) return
      stopCue()
      const scaled = applyGain(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), volumeGain(options.volume()))
      const fiber = options.fork(options.cueOutput().play(Stream.make(scaled), sampleRate).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log(`cue failed: ${String(cause)}`)
            options.onPlayFailed?.(String(cause))
          })
        )
      ))
      cueFiber = fiber
      fiber.addObserver(() => {
        if (cueFiber === fiber) cueFiber = undefined
      })
    },
    playing: () => current?.turnId
  }
}
