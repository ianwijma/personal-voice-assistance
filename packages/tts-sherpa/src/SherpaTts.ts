/**
 * `Tts` on a local sherpa-onnx engine running in a child process (see `Engine.ts`).
 */
import { Tts, type TtsAudio, TtsError } from "@pva/core"
import { Cause, Effect, Queue, type Scope, Stream } from "effect"
import { Engine, type EngineOptions, type Job } from "./Engine.ts"
import { type JoinOptions, makeJoiner } from "./Pcm.ts"

/**
 * Starts the engine (model load happens here, at layer build) and stops it when
 * the scope closes. Returns the service, the engine (for measurements) and
 * `forSpeaker`: a service over the same engine that speaks with another speaker
 * of the loaded model (previews of the other Kokoro voices; never used for live
 * turns, whose jobs carry no speaker and so use the one the engine was started with).
 */
export const makeEngineTts = (
  engineOptions: EngineOptions,
  join: JoinOptions
): Effect.Effect<
  { readonly tts: Tts["Service"]; readonly engine: Engine; readonly forSpeaker: (speaker: number) => Tts["Service"] },
  TtsError,
  Scope.Scope
> =>
  Effect.gen(function*() {
    const engine = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const engine = new Engine(engineOptions)
          await engine.start()
          return engine
        },
        catch: (cause) => new TtsError({ message: `sherpa-onnx engine failed to start: ${(cause as Error).message}`, cause })
      }),
      (engine) => Effect.promise(() => engine.close())
    )
    const sampleRate = engine.sampleRate

    /**
     * Each clause becomes a job as soon as it arrives. The engine runs jobs in
     * order, one at a time, so results come back in clause order and the joiner
     * sees them in sequence. Interruption cancels this turn's jobs: queued ones
     * are dropped, the one in flight finishes in the child and its audio is
     * discarded, so nothing leaks into a later turn.
     */
    const synthesizeAs = (speaker: number | undefined) => (clauses: Stream.Stream<string>): Stream.Stream<TtsAudio, TtsError> =>
      Stream.callback<TtsAudio, TtsError>((queue) =>
        Effect.gen(function*() {
          const joiner = makeJoiner(sampleRate, join)
          const jobs = new Set<Job>()
          let next = 0
          /** The last clause that produced audio: the pause before the next clause's speech is counted as part of it. */
          let lastAudible: number | undefined
          let ended = false
          let settled = false

          const settle = () => {
            settled = true
            for (const job of jobs) engine.cancel(job)
            jobs.clear()
          }
          const finishIfDone = () => {
            if (ended && jobs.size === 0 && !settled) {
              settled = true
              Queue.endUnsafe(queue)
            }
          }

          yield* Effect.addFinalizer(() => Effect.sync(settle))

          yield* Stream.runForEach(clauses, (raw) =>
            Effect.sync(() => {
              const clause = next++
              const text = raw.trim()
              if (settled || text.length === 0) return // the index is used up, there is just no audio
              const job: Job = {
                text,
                ...(speaker !== undefined ? { speaker } : {}),
                onAudio: (samples) => {
                  jobs.delete(job)
                  if (settled) return
                  const joined = joiner(samples, text)
                  for (const audio of joined.pause) Queue.offerUnsafe(queue, { audio, clause: lastAudible ?? clause })
                  for (const audio of joined.speech) Queue.offerUnsafe(queue, { audio, clause })
                  if (joined.speech.length > 0) lastAudible = clause
                  finishIfDone()
                },
                onError: (message) => {
                  jobs.delete(job)
                  if (settled) return
                  settle()
                  Queue.failCauseUnsafe(queue, Cause.fail(new TtsError({ message })))
                }
              }
              jobs.add(job)
              engine.submit(job)
            })
          )
          ended = true
          finishIfDone()
        })
      )

    return {
      tts: Tts.of({ sampleRate, synthesize: synthesizeAs(undefined) }),
      engine,
      forSpeaker: (speaker) => Tts.of({ sampleRate, synthesize: synthesizeAs(speaker) })
    }
  })
