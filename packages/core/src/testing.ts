/**
 * In-memory fakes for tests. Each `make*` returns a `layer` and a `probe`: a
 * plain mutable object recording what happened, for assertions.
 * Delays use `Effect.sleep`, so they are driven by `TestClock` in tests.
 */
import { type Cause, Clock, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import { type Agent, type AgentEvent, AgentError, type AgentTurnInput } from "./Agent.ts"
import type { AgentSet, AgentTurnSetup, PlaybackObserver } from "./ConversationEvents.ts"
import type { LlmEvent, LlmRequest, StopReason, SttEvent } from "./Domain.ts"
import { AudioError, LlmError } from "./Errors.ts"
import { AudioInput, AudioOutput, Llm, Stt, Tts, type TtsAudio } from "./Services.ts"
import { makeTurnTrace, TurnTrace } from "./TurnTrace.ts"
import { defaultRoutingConfig, makeTriggerRouter, type RoutingConfig } from "./Routing.ts"
import { makeToolRegistry, type ToolRegistry } from "./ToolRegistry.ts"

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
// Agents

export const agentText = (text: string): AgentEvent => ({ _tag: "TextDelta", text })
export const handoff = (reason = "no match"): AgentEvent => ({ _tag: "Handoff", reason })
export const expectReply: AgentEvent = { _tag: "ExpectReply" }
/** A script step that fails the agent's stream. */
export const agentFails = (reason: AgentError["reason"] = "failed", message = "scripted failure"): AgentError =>
  new AgentError({ message, reason })

export type AgentScript = ReadonlyArray<AgentEvent | Sleep | AgentError>

/**
 * An `Agent` answering turn `n` with `responses[n]` (or `responses(input, n)`).
 * An `AgentError` step fails the stream there. Running out of responses fails
 * with `AgentError("failed")`. `probe.inputs` records every `AgentTurnInput`.
 */
export const makeScriptedAgent = (
  options: {
    readonly id: string
    readonly name?: string
    readonly kind?: Agent["kind"]
    readonly speculate?: boolean
    readonly firstEventTimeoutMs?: number
    readonly systemPrompt?: string
  },
  responses: ReadonlyArray<AgentScript> | ((input: AgentTurnInput, index: number) => AgentScript)
) => {
  const probe = { ...newProbe(), inputs: [] as Array<AgentTurnInput>, calledAt: [] as Array<number> }
  const kind = options.kind ?? "model"
  const agent: Agent = {
    id: options.id,
    name: options.name ?? options.id,
    kind,
    speculate: options.speculate ?? kind !== "harness",
    firstEventTimeoutMs: options.firstEventTimeoutMs ?? 5_000,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    turn: (input) =>
      Stream.unwrap(Effect.gen(function*() {
        const index = probe.inputs.length
        probe.inputs.push(input)
        probe.calledAt.push(yield* Clock.currentTimeMillis)
        const script = typeof responses === "function" ? responses(input, index) : responses[index]
        if (script === undefined) return Stream.fail(new AgentError({ message: `ScriptedAgent ${options.id}: no response for turn ${index}`, reason: "failed" }))
        return Stream.fromIterable(script).pipe(
          Stream.mapEffect((step): Effect.Effect<AgentEvent | undefined, AgentError> =>
            isSleep(step) ? Effect.as(Effect.sleep(step.millis), undefined)
            : step instanceof AgentError ? Effect.fail(step)
            : Effect.succeed(step)
          ),
          Stream.filter((e): e is AgentEvent => e !== undefined)
        )
      })).pipe(track(probe))
  }
  return { agent, probe }
}

/**
 * A per-turn setup for `Conversation.layerWithAgents` with a trigger router over
 * `routing` (default rules unless given) and the given running agents.
 */
export const makeAgentSetup = (options: {
  readonly agents: ReadonlyArray<Agent>
  readonly routing?: Partial<RoutingConfig>
  readonly system?: string
  readonly registry?: ToolRegistry["Service"]
  readonly names?: ReadonlyMap<string, string>
  readonly extra?: Partial<AgentSet>
}): AgentTurnSetup => {
  const routing: RoutingConfig = { ...defaultRoutingConfig, ...options.routing }
  return {
    system: options.system ?? "sys",
    registry: options.registry ?? makeToolRegistry([]),
    agents: {
      router: makeTriggerRouter(routing),
      agents: new Map(options.agents.map((a) => [a.id, a])),
      defaultAgent: routing.defaultAgent,
      fallbackAgent: routing.fallbackAgent,
      armedMs: routing.armedMs,
      ...(options.names !== undefined ? { names: options.names } : {}),
      ...options.extra
    }
  }
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

/**
 * `AudioOutput` with `reportsPlayback: true`, like the browser: it pulls the
 * whole stream as fast as it is produced (as if sending it), then "plays" it
 * chunk by chunk, handing each chunk to the device (reporting `progress`) and
 * taking `chunkMillis` per chunk. `started` is reported `startDelayMillis`
 * after the first chunk arrived. `failAfterChunks` fails `play` (like a lost
 * browser) after that many chunks were handed over.
 */
export const makeReportingAudioOutput = (
  options: { readonly chunkMillis?: number; readonly startDelayMillis?: number; readonly failAfterChunks?: number } = {}
) => {
  const chunkMillis = options.chunkMillis ?? 100
  const probe = {
    ...newProbe(),
    /** Chunks pulled from the stream (sent), in order. */
    pulled: [] as Array<string>,
    /** Chunks handed to the "device", with the clock time. */
    chunks: [] as Array<{ readonly text: string; readonly at: number }>,
    reports: [] as Array<{ readonly kind: "started" | "progress"; readonly samples: number; readonly at: number }>
  }
  const layer = Layer.succeed(
    AudioOutput,
    AudioOutput.of({
      reportsPlayback: true,
      play: <E>(audio: Stream.Stream<Uint8Array, E>, _sampleRate: number, observer?: PlaybackObserver) =>
        Effect.gen(function*() {
          probe.started++
          const queue = yield* Queue.unbounded<Uint8Array, E | Cause.Done>()
          const reader = yield* audio.pipe(
            Stream.tap((chunk) => Effect.sync(() => probe.pulled.push(markerText(chunk)))),
            Stream.runIntoQueue(queue),
            Effect.forkChild
          )
          let played = 0
          let handed = 0
          yield* Stream.fromQueue(queue).pipe(Stream.runForEach((chunk) =>
            Effect.gen(function*() {
              if (handed === 0) {
                if ((options.startDelayMillis ?? 0) > 0) yield* Effect.sleep(options.startDelayMillis!)
                observer?.started()
                probe.reports.push({ kind: "started", samples: 0, at: yield* Clock.currentTimeMillis })
              }
              if (options.failAfterChunks !== undefined && handed >= options.failAfterChunks) {
                return yield* new AudioError({ message: "audio client disconnected" })
              }
              handed++
              played += chunk.length >> 1
              const at = yield* Clock.currentTimeMillis
              probe.chunks.push({ text: markerText(chunk), at })
              observer?.progress(played)
              probe.reports.push({ kind: "progress", samples: played, at })
              yield* Effect.sleep(chunkMillis)
            })
          ))
          yield* Fiber.join(reader)
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
