/**
 * In-memory fakes for tests. Each `make*` returns a `layer` and a `probe`: a
 * plain mutable object recording what happened, for assertions.
 * Delays use `Effect.sleep`, so they are driven by `TestClock` in tests.
 */
import { Clock, Effect, Exit, Layer, Stream } from "effect"
import type { LlmEvent, LlmRequest, StopReason, SttEvent } from "./Domain.ts"
import { LlmError } from "./Errors.ts"
import { AudioInput, AudioOutput, Llm, Stt, Tts, type TtsAudio } from "./Services.ts"
import { makeTurnTrace, TurnTrace } from "./TurnTrace.ts"

export interface Sleep {
  readonly _tag: "Sleep"
  readonly millis: number
}

export const sleep = (millis: number): Sleep => ({ _tag: "Sleep", millis })

/** Lifecycle counters, updated from stream finalizers. */
export interface StreamProbe {
  started: number
  completed: number
  interrupted: number
}

const newProbe = (): StreamProbe => ({ started: 0, completed: 0, interrupted: 0 })

const track = (probe: StreamProbe) => <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
  Stream.suspend(() => {
    probe.started++
    return stream.pipe(Stream.onExit((exit) => Effect.sync(() => record(probe, exit))))
  })

const record = (probe: StreamProbe, exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.hasInterrupts(exit)) probe.interrupted++
  else probe.completed++
}

const play = <A>(steps: ReadonlyArray<A | Sleep>): Stream.Stream<A> =>
  Stream.fromIterable(steps).pipe(
    Stream.mapEffect((step) =>
      isSleep(step) ? Effect.as(Effect.sleep(step.millis), undefined) : Effect.succeed(step)
    ),
    Stream.filter((a): a is A => a !== undefined)
  )

/** A stream of `steps`, pausing (in clock time) at each `sleep`. */
export const scripted = <A>(steps: ReadonlyArray<A | Sleep>): Stream.Stream<A> => play(steps)

const isSleep = (u: unknown): u is Sleep =>
  typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === "Sleep"

// ---------------------------------------------------------------------------
// Stt

export const speechStarted: SttEvent = { _tag: "SpeechStarted" }
export const turnResumed: SttEvent = { _tag: "TurnResumed" }
export const interim = (text: string): SttEvent => ({ _tag: "Interim", text })
export const eagerEndOfTurn = (text: string): SttEvent => ({ _tag: "EagerEndOfTurn", text })
export const endOfTurn = (text: string): SttEvent => ({ _tag: "EndOfTurn", text })

/** `Stt` that ignores its audio and emits `script` (with `sleep` steps between events). */
export const makeScriptedStt = (script: ReadonlyArray<SttEvent | Sleep>) => {
  const probe = newProbe()
  const layer = Layer.succeed(Stt, Stt.of({ transcribe: () => play(script).pipe(track(probe)) }))
  return { layer, probe }
}

// ---------------------------------------------------------------------------
// Llm

export const textDelta = (text: string): LlmEvent => ({ _tag: "TextDelta", text })
export const toolCall = (id: string, name: string, input: unknown): LlmEvent => ({ _tag: "ToolCall", id, name, input })
export const done = (stopReason: StopReason = "end"): LlmEvent => ({ _tag: "Done", stopReason })

export type LlmScript = ReadonlyArray<LlmEvent | Sleep>

/**
 * `Llm` answering request `n` with `responses[n]` (or `responses(request, n)`).
 * A missing final `Done` is added. Running out of responses is an `LlmError`.
 */
export const makeScriptedLlm = (
  responses: ReadonlyArray<LlmScript> | ((request: LlmRequest, index: number) => LlmScript)
) => {
  const probe = { ...newProbe(), requests: [] as Array<LlmRequest> }
  const layer = Layer.succeed(
    Llm,
    Llm.of({
      stream: (request) =>
        Stream.suspend(() => {
          const index = probe.requests.length
          probe.requests.push(request)
          const script = typeof responses === "function" ? responses(request, index) : responses[index]
          if (script === undefined) {
            return Stream.fail(new LlmError({ message: `ScriptedLlm: no response for request ${index}` }))
          }
          const hasDone = script.some((s) => !isSleep(s) && s._tag === "Done")
          const hasTool = script.some((s) => !isSleep(s) && s._tag === "ToolCall")
          return play(hasDone ? script : [...script, done(hasTool ? "tool_use" : "end")])
        }).pipe(track(probe))
    })
  )
  return { layer, probe }
}

// ---------------------------------------------------------------------------
// Tts

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The marker chunk `MarkerTts` produces for a clause. */
export const marker = (clause: string): Uint8Array => encoder.encode(`<${clause}>`)
export const markerText = (chunk: Uint8Array): string => decoder.decode(chunk)

/**
 * `Tts` that turns each clause into one marker chunk `<clause>` (tagged with the
 * clause index) after `delayMillis`, one clause after another. Input clauses are
 * read eagerly, like a real streaming provider: `probe.clauses` records each
 * clause with the clock time it arrived, even while an earlier one is still
 * being synthesised. `started`/`completed`/`interrupted` count `synthesize` calls.
 */
export const makeMarkerTts = (
  options: { readonly delayMillis?: number; readonly sampleRate?: number; readonly label?: string } = {}
) => {
  const probe = { ...newProbe(), clauses: [] as Array<string>, arrivals: [] as Array<{ readonly text: string; readonly at: number }> }
  const delay = options.delayMillis ?? 0
  const label = options.label === undefined ? "" : `${options.label}:`
  const service = Tts.of({
    sampleRate: options.sampleRate ?? 24_000,
    synthesize: (clauses) =>
      clauses.pipe(
        Stream.tap((clause) =>
          Effect.flatMap(Clock.currentTimeMillis, (at) =>
            Effect.sync(() => {
              probe.clauses.push(clause)
              probe.arrivals.push({ text: clause, at })
            }))
        ),
        Stream.zipWithIndex,
        Stream.buffer({ capacity: "unbounded" }),
        Stream.mapEffect(([clause, index]) =>
          Effect.as(delay > 0 ? Effect.sleep(delay) : Effect.void, {
            audio: label === "" ? marker(clause) : marker(`${label}${clause}`),
            clause: index
          } satisfies TtsAudio)
        ),
        track(probe)
      )
  })
  return { layer: Layer.succeed(Tts, service), service, probe }
}

/**
 * `Tts` producing `millisPerClause` of a constant-amplitude tone per clause at
 * `sampleRate`, in `chunks` chunks, after `delayMillis`. For sample-rate and
 * duration tests.
 */
export const makeToneTts = (
  options: { readonly sampleRate: number; readonly millisPerClause?: number; readonly chunks?: number; readonly delayMillis?: number }
) => {
  const probe = { ...newProbe(), clauses: [] as Array<string> }
  const samples = Math.round((options.sampleRate * (options.millisPerClause ?? 100)) / 1000)
  const chunks = options.chunks ?? 4
  const service = Tts.of({
    sampleRate: options.sampleRate,
    synthesize: (clauses) =>
      clauses.pipe(
        Stream.tap((clause) => Effect.sync(() => probe.clauses.push(clause))),
        Stream.zipWithIndex,
        Stream.flatMap(([, index]) =>
          Stream.fromIterable(Array.from({ length: chunks }, (_, c) => {
            const n = Math.floor((samples * (c + 1)) / chunks) - Math.floor((samples * c) / chunks)
            return { audio: new Uint8Array(new Int16Array(n).fill(1000).buffer), clause: index } satisfies TtsAudio
          })).pipe(Stream.tap(() => (options.delayMillis ?? 0) > 0 ? Effect.sleep(options.delayMillis!) : Effect.void))
        ),
        track(probe)
      )
  })
  return { layer: Layer.succeed(Tts, service), service, probe }
}

// ---------------------------------------------------------------------------
// Audio

/** `AudioOutput` that records each chunk and takes `chunkMillis` of (test) time to "play" it. */
export const makeRecordingAudioOutput = (options: { readonly chunkMillis?: number } = {}) => {
  const chunkMillis = options.chunkMillis ?? 100
  const probe = {
    ...newProbe(),
    /** Every chunk that started playing, with the clock time it started. */
    chunks: [] as Array<{ readonly text: string; readonly at: number }>,
    sampleRates: [] as Array<number>
  }
  const layer = Layer.succeed(
    AudioOutput,
    AudioOutput.of({
      play: (audio, sampleRate) =>
        Effect.suspend(() => {
          probe.started++
          probe.sampleRates.push(sampleRate)
          return audio.pipe(
            Stream.runForEach((chunk) =>
              Effect.flatMap(Clock.currentTimeMillis, (at) => {
                probe.chunks.push({ text: markerText(chunk), at })
                return Effect.sleep(chunkMillis)
              })
            )
          )
        }).pipe(Effect.onExit((exit) => Effect.sync(() => record(probe, exit))))
    })
  )
  return { layer, probe }
}

/** `AudioInput` emitting `chunks`, one every `intervalMillis`. */
export const makeScriptedAudioInput = (
  chunks: ReadonlyArray<Uint8Array>,
  options: { readonly intervalMillis?: number } = {}
) => {
  const probe = newProbe()
  const interval = options.intervalMillis ?? 20
  const layer = Layer.succeed(
    AudioInput,
    AudioInput.of({
      stream: Stream.fromIterable(chunks).pipe(
        Stream.mapEffect((chunk) => Effect.as(Effect.sleep(interval), chunk)),
        track(probe)
      )
    })
  )
  return { layer, probe }
}

/** `TurnTrace` driven by the Effect `Clock` (so `TestClock` controls it). */
export const testTurnTraceLayer = Layer.effect(
  TurnTrace,
  Effect.clockWith((clock) => Effect.succeed(makeTurnTrace({ now: () => clock.currentTimeMillisUnsafe() })))
)
