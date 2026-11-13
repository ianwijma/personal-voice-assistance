/**
 * The real server acceptance rule, driven from the web app's tests (sixth review, finding 4): one reply
 * replayed through `makeWebAudio` (`packages/audio-web`, the code the assistant runs) with Effect's
 * `TestClock`, so its 300 ms stop wait, 2 s stall watchdog, clamp to the samples sent and progress handling
 * are the server's own, not a hand-copied model of them.
 *
 * A timeline holds what crossed the wire for one reply, on one clock (ms; the hop between page and server
 * is taken as instant): audio the server sent (`frames`), the end of its audio (`end`), the moment the
 * server stopped the reply (`stop`: an interruption, so it sends `reply.stop` and waits), the page's
 * playback reports (`report`, the messages `playbackReport` produced), and the owner going away (`gone`).
 * Events at the same time run in that order: the server's own sends first, then its stop, then the page's
 * reports, then a departure (a closing page sends its count before its socket closes).
 */
import { CurrentTurnTrace, type Trace } from "@pva/core"
import { type AudioClientLink, makeWebAudio, type PlaybackReport } from "@pva/audio-web"
import type { ClientMessage, ServerMessage } from "@pva/protocol"
import { type Cause, Effect, Fiber, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"

export type ServerEvent =
  | { readonly at: number; readonly kind: "frames"; readonly samples: number }
  | { readonly at: number; readonly kind: "end" }
  | { readonly at: number; readonly kind: "stop" }
  | { readonly at: number; readonly kind: "report"; readonly message: ClientMessage }
  | { readonly at: number; readonly kind: "gone" }

export interface ServerOutcome {
  /** The count the reply's history uses: `PlaybackObserver.final` when the server called it, else the last `progress`. */
  readonly accepted: number
  /** Whether the server called `final` (the reply ended) within the timeline plus its stop wait. */
  readonly decided: boolean
  /** The last value passed to `progress`. */
  readonly progress: number
  /** Messages the server sent the page (reply.start, reply.end, reply.stop). */
  readonly sent: ReadonlyArray<ServerMessage["type"]>
}

const ORDER: Record<ServerEvent["kind"], number> = { frames: 0, end: 0, stop: 1, report: 2, gone: 3 }

const isReport = (m: ClientMessage): m is PlaybackReport =>
  m.type === "playback.started" || m.type === "playback.progress" || m.type === "playback.finished" || m.type === "playback.stopped"

/** Let every fiber that can run, run (the server's fibers react to a report or a clock step within a few yields). */
const settle = Effect.repeat(Effect.yieldNow, { times: 12 })

/**
 * Replay `events` (times relative to the server's `reply.start`, at 0) for one reply at `rate` Hz through the
 * real server, and return what it accepted. `turnId` must match the reports' turn id.
 */
export const replayOnServer = (turnId: number, rate: number, events: ReadonlyArray<ServerEvent>, stopWaitMs = 300): Promise<ServerOutcome> => {
  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || ORDER[a.e.kind] - ORDER[b.e.kind] || a.i - b.i).map((x) => x.e)
  const program = Effect.gen(function*() {
    const web = yield* makeWebAudio({ log: () => undefined })
    const sent: Array<ServerMessage["type"]> = []
    const link: AudioClientLink = { sendMessage: (m) => void sent.push(m.type), sendBinary: () => undefined }
    web.setOwner(link)
    const audio = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    let progress = 0
    let final: number | undefined
    const trace: Trace = { id: turnId, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
    const fiber = yield* web.output.play(Stream.fromQueue(audio), rate, {
      started: () => undefined,
      progress: (n) => void (progress = n),
      final: (n) => void (final = n)
    }).pipe(Effect.provideService(CurrentTurnTrace, trace), Effect.exit, Effect.forkChild)
    yield* settle
    let t = 0
    for (const event of sorted) {
      if (event.at > t) {
        yield* TestClock.adjust(event.at - t)
        yield* settle
        t = event.at
      }
      switch (event.kind) {
        case "frames":
          yield* Queue.offer(audio, new Uint8Array(event.samples * 2))
          break
        case "end":
          yield* Queue.end(audio)
          break
        case "stop":
          // Interrupting waits for the server's own stop wait, which needs the clock: do not block on it here.
          yield* Effect.forkChild(Fiber.interrupt(fiber))
          break
        case "report":
          if (isReport(event.message)) web.report(event.message, link)
          break
        case "gone":
          web.setOwner(undefined)
          break
      }
      yield* settle
    }
    yield* TestClock.adjust(stopWaitMs)
    yield* settle
    const decided = final !== undefined
    // Whatever is still open ends the way the server would end it (stall watchdog), so nothing is left running.
    yield* TestClock.adjust(10_000)
    yield* settle
    return { accepted: final ?? progress, decided, progress, sent } satisfies ServerOutcome
  })
  return Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestClock.layer())))
}
