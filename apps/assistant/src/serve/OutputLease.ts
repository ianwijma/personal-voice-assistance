import { AudioError, AudioOutput, type PlaybackObserver } from "@pva/core"
import { Cause, Effect, Exit, Fiber, Semaphore, type Stream } from "effect"

/**
 * One speaker for several conversations (docs/ASSISTANTS.md §1.2 "One speaker", §3.3 "OutputLease"): every
 * conversation of a voice session plays through `lease.output(assistant)`, and all of them share one `AudioOutput`.
 * A `play` that starts while another `play` runs makes the older one fail with `AudioError("superseded")`; the
 * conversation that owned it then commits its turn like one whose playback failed (only the clauses heard,
 * docs/ARCHITECTURE.md "A turn whose playback fails"). Two replies never sound at once, whatever order the
 * conversations act in (typed text racing speech, a hand-over that lost a race with a promotion).
 *
 * How:
 * - Plays start one at a time (a one-permit semaphore around "supersede the running play, then start this one").
 * - Superseding interrupts the older play's underlying `play` and WAITS for that interruption to complete (the
 *   output silences the speaker and reports its final count, `PlaybackObserver.final`, before it completes), and
 *   only then starts the new play. So the underlying output never has two plays running, even for an instant.
 * - The underlying `play` runs on its own fiber so the older play's wrapper can tell "superseded" (fail with
 *   `AudioError`) from its own conversation interrupting it (barge-in, Stop: interrupted as usual).
 * - Each reply keeps its own sample rate (passed through unchanged); `reportsPlayback` is the shared output's.
 *
 * Latency: with no play running, a new play waits for nothing (the semaphore is free). When it supersedes one, it
 * waits for the older play's interruption: for the browser output that is the `reply.stop` round trip, at most
 * 300 ms (docs/ARCHITECTURE.md, audio-web). Not measured yet.
 */

/** The `AudioError` message of a play another play replaced. */
export const SUPERSEDED = "superseded"

export const isSuperseded = (error: unknown): boolean => error instanceof AudioError && error.message === SUPERSEDED

/** How one play through the lease ended. */
export type LeasePlayEnd = "completed" | "superseded" | "interrupted" | "failed"

export interface OutputLeaseOptions {
  /** A play of `holder` started on the shared output (its underlying `play` was called). */
  readonly onStart?: (holder: string) => void
  /** That play ended (after its underlying `play` returned or its interruption completed). */
  readonly onEnd?: (holder: string, how: LeasePlayEnd) => void
}

export interface OutputLease {
  /** The output `holder` (an assistant's conversation) plays through. One per holder; cheap to make. */
  readonly output: (holder: string) => AudioOutput["Service"]
  /**
   * P9 (announcements): play only if nothing plays now and `gate()` answers "go", both decided under the lease's lock
   * in the same step as the play starts, so it never takes the speaker from a reply. Otherwise nothing starts and the
   * answer is `{ notStarted }`: "busy" (something plays) or what the gate said. A play that starts later (a reply)
   * supersedes this one as usual (it fails `AudioError("superseded")`).
   */
  readonly playIfFree: <E>(holder: string, audio: Stream.Stream<Uint8Array, E>, sampleRate: number, gate: () => string) => Effect.Effect<"played" | { readonly notStarted: string }, E | AudioError>
  /** Who plays now, if anyone. */
  readonly holder: () => string | undefined
}

interface Play {
  readonly holder: string
  readonly fiber: Fiber.Fiber<void, unknown>
  /** Set by the play that replaced this one, before it interrupts `fiber`. */
  superseded: boolean
  /** `onEnd` was called. */
  ended: boolean
}

export const makeOutputLease = (shared: AudioOutput["Service"], options: OutputLeaseOptions = {}): OutputLease => {
  const lock = Semaphore.makeUnsafe(1)
  let current: Play | undefined

  const notify = (f: () => void) => {
    try {
      f()
    } catch {
      // A throwing subscriber must not break playback.
    }
  }

  /** The underlying play has ended: no longer current, and `onEnd` (once, so a superseded play ends before the next starts). */
  const ended = (play: Play, exit: Exit.Exit<void, unknown>) => {
    if (current === play) current = undefined
    if (play.ended) return
    play.ended = true
    const how: LeasePlayEnd = Exit.isSuccess(exit)
      ? "completed"
      : Cause.hasInterruptsOnly(exit.cause)
      ? play.superseded ? "superseded" : "interrupted"
      : "failed"
    notify(() => options.onEnd?.(play.holder, how))
  }

  /** Under the lock: stop whatever plays (and wait until it has stopped), then start `start` as the current play. */
  const begin = (holder: string, start: Effect.Effect<void, unknown>): Effect.Effect<Play> =>
    lock.withPermits(1)(Effect.gen(function*() {
      while (current !== undefined) {
        const previous = current
        previous.superseded = true
        yield* Fiber.interrupt(previous.fiber)
        ended(previous, yield* Fiber.await(previous.fiber))
      }
      const fiber = yield* Effect.forkDetach(Effect.interruptible(start))
      const play: Play = { holder, fiber, superseded: false, ended: false }
      current = play
      notify(() => options.onStart?.(holder))
      return play
    }))

  const output = (holder: string): AudioOutput["Service"] =>
    AudioOutput.of({
      ...(shared.reportsPlayback !== undefined ? { reportsPlayback: shared.reportsPlayback } : {}),
      play: <E>(audio: Stream.Stream<Uint8Array, E>, sampleRate: number, observer?: PlaybackObserver) =>
        Effect.acquireUseRelease(
          begin(holder, observer === undefined ? shared.play(audio, sampleRate) : shared.play(audio, sampleRate, observer)),
          (play) =>
            Effect.flatMap(Fiber.await(play.fiber), (exit): Effect.Effect<void, E | AudioError> => {
              if (Exit.isSuccess(exit)) return Effect.void
              if (play.superseded && Cause.hasInterruptsOnly(exit.cause)) {
                return Effect.fail(new AudioError({ message: SUPERSEDED }))
              }
              return Effect.failCause(exit.cause as Cause.Cause<E | AudioError>)
            }),
          // Interrupted itself (barge-in, Stop) or done: make sure the underlying play has ended before returning.
          (play) =>
            Effect.gen(function*() {
              yield* Fiber.interrupt(play.fiber)
              ended(play, yield* Fiber.await(play.fiber))
            })
        )
    })

  /** Under the lock: start `start` only if nothing plays and the gate says go. */
  const beginIfFree = (holder: string, start: Effect.Effect<void, unknown>, gate: () => string): Effect.Effect<Play | { readonly notStarted: string }> =>
    lock.withPermits(1)(Effect.gen(function*() {
      if (current !== undefined) return { notStarted: "busy" }
      const answer = gate()
      if (answer !== "go") return { notStarted: answer }
      const fiber = yield* Effect.forkDetach(Effect.interruptible(start))
      const play: Play = { holder, fiber, superseded: false, ended: false }
      current = play
      notify(() => options.onStart?.(holder))
      return play
    }))

  const playIfFree = <E>(holder: string, audio: Stream.Stream<Uint8Array, E>, sampleRate: number, gate: () => string): Effect.Effect<"played" | { readonly notStarted: string }, E | AudioError> =>
    Effect.acquireUseRelease(
      beginIfFree(holder, shared.play(audio, sampleRate), gate),
      (play): Effect.Effect<"played" | { readonly notStarted: string }, E | AudioError> =>
        "notStarted" in play
          ? Effect.succeed(play)
          : Effect.flatMap(Fiber.await(play.fiber), (exit) => {
            if (Exit.isSuccess(exit)) return Effect.succeed("played" as const)
            if (play.superseded && Cause.hasInterruptsOnly(exit.cause)) return Effect.fail(new AudioError({ message: SUPERSEDED }))
            return Effect.failCause(exit.cause as Cause.Cause<E | AudioError>)
          }),
      (play) =>
        "notStarted" in play ? Effect.void : Effect.gen(function*() {
          yield* Fiber.interrupt(play.fiber)
          ended(play, yield* Fiber.await(play.fiber))
        })
    )

  return { output, playIfFree, holder: () => current?.holder }
}
