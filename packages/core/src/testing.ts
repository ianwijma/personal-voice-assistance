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
import { defaultRoutingConfig, makeTriggerRouter, type RoutingConfig } from "./TriggerRouter.ts"
import { makeToolRegistry, type ToolRegistry } from "./ToolRegistry.ts"
import { connectStoreToBus, type EventBusOptions, type HouseholdEvent, makeEventBus } from "./EventBus.ts"
import type { ModuleStorage } from "./HouseholdStore.ts"
import { makeMemoryHouseholdStore, type MemoryStoreOptions } from "./MemoryHouseholdStore.ts"
import type { HouseholdStore } from "./HouseholdStore.ts"
import { type IssueRegistry, makeIssueRegistry } from "./Issues.ts"
import { makeSchedulerEngine, type SchedulerEngineOptions } from "./SchedulerEngine.ts"
import { TestClock } from "effect/testing"
import { schedulerStorage } from "./SchedulerJobs.ts"
import { notifyStorage } from "./Notify.ts"
import { presentStorage } from "./Present.ts"

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

/**
 * A stream of `steps`, pausing (in clock time) at each `sleep`. A script of recogniser events
 * is made to follow the `SttEvent` contract, like a real recogniser: a `SpeechStarted` is sent
 * right before an `EagerEndOfTurn`, `TurnResumed` or `EndOfTurn` that would otherwise arrive with
 * no utterance open (none since the last `EndOfTurn`). `scriptedRaw` sends the steps as written.
 */
export const scripted = <A>(steps: ReadonlyArray<A | Sleep>): Stream.Stream<A> => play(withSpeechStarted(steps))

/** `scripted` without the `SttEvent` contract applied: the steps exactly as written (protocol-violation tests). */
export const scriptedRaw = <A>(steps: ReadonlyArray<A | Sleep>): Stream.Stream<A> => play(steps)

const tagOf = (u: unknown): string | undefined =>
  typeof u === "object" && u !== null && typeof (u as { _tag?: unknown })._tag === "string" ? (u as { _tag: string })._tag : undefined

/**
 * A stateful `withSpeechStarted` for fakes that emit events in several calls (a controllable
 * recogniser): each call returns its events with a `SpeechStarted` inserted where a recogniser that
 * keeps the `SttEvent` contract would have sent it, remembering whether an utterance is open.
 */
export const sttContractKeeper = () => {
  let open = false
  return <A>(steps: ReadonlyArray<A | Sleep>): Array<A | Sleep> => {
    const out: Array<A | Sleep> = []
    for (const step of steps) {
      const tag = tagOf(step)
      if (tag === "SpeechStarted") open = true
      else if ((tag === "EagerEndOfTurn" || tag === "TurnResumed" || tag === "EndOfTurn") && !open) {
        out.push(speechStarted as A)
        open = true
      }
      if (tag === "EndOfTurn") open = false
      out.push(step)
    }
    return out
  }
}

/** Insert `SpeechStarted` where a recogniser that keeps the contract would have sent it. */
export const withSpeechStarted = <A>(steps: ReadonlyArray<A | Sleep>): Array<A | Sleep> => sttContractKeeper()(steps)

const isSleep = (u: unknown): u is Sleep =>
  typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === "Sleep"

// ---------------------------------------------------------------------------
// Stt

export const speechStarted: SttEvent = { _tag: "SpeechStarted" }
export const turnResumed: SttEvent = { _tag: "TurnResumed" }
export const interim = (text: string): SttEvent => ({ _tag: "Interim", text })
export const eagerEndOfTurn = (text: string): SttEvent => ({ _tag: "EagerEndOfTurn", text })
export const endOfTurn = (text: string): SttEvent => ({ _tag: "EndOfTurn", text })

/** `Stt` that ignores its audio and emits `script` (with `sleep` steps between events), following the `SttEvent` contract (`withSpeechStarted`). */
export const makeScriptedStt = (script: ReadonlyArray<SttEvent | Sleep>) => {
  const probe = newProbe()
  const layer = Layer.succeed(Stt, Stt.of({ transcribe: () => play(withSpeechStarted(script)).pipe(track(probe)) }))
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

// The trigger-phrase router, as a fixture for agent tests (see TriggerRouter.ts).
export * from "./TriggerRouter.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Household store and event bus (docs/STORING-DATA.md "Testing a module")

export { makeMemoryHouseholdStore, type MemoryStoreOptions }

/** An event bus that also records every event published on it (by the store, the host or modules), in order. */
export const makeRecordingEventBus = (options: EventBusOptions = {}) => {
  const events: Array<HouseholdEvent> = []
  const bus = makeEventBus({
    ...options,
    observe: (event) => {
      events.push(event)
      options.observe?.(event)
    }
  })
  return { bus, events }
}

/**
 * A household for a module test: an in-memory store prepared for `modules` (their `storage`), a recording bus fed
 * from the store's commits, and what to give the module host (`ModuleHostOptions.household`).
 */
export const makeTestHousehold = (
  modules: ReadonlyArray<{ readonly id: string; readonly storage?: ModuleStorage }>,
  options: MemoryStoreOptions = {}
) =>
  Effect.gen(function*() {
    const store = makeMemoryHouseholdStore(options)
    // P6: the scheduler's collections (core.scheduler) are prepared with the modules', as in serve mode.
    yield* store.prepare(modules.map((m) => ({ id: m.id, storage: m.storage })), [schedulerStorage, notifyStorage, presentStorage])
    const recording = makeRecordingEventBus()
    connectStoreToBus(store, recording.bus)
    return { store, bus: recording.bus, events: recording.events, household: { store, events: recording.bus } }
  })

// ---------------------------------------------------------------------------------------------------------------------
// Scheduler (docs/SCHEDULING.md "Testing a module")

/** An in-memory household store (`makeMemoryHouseholdStore`). */
export type MemoryHouseholdStore = ReturnType<typeof makeMemoryHouseholdStore>

/**
 * A scheduler for tests: the real engine (`makeSchedulerEngine`) on a household store prepared for `modules` and the
 * scheduler (`makeTestHousehold`; or the `store` given, which must have been prepared with `schedulerStorage`). It runs
 * on the Effect clock: in `it.effect` that is the test clock; `advance(ms)` moves it and lets the engine run. Give
 * `scheduler` to the module host as `ModuleHostOptions.scheduler`, and `household` as its household.
 *
 * A restart is a second scheduler on the same store after the first one's scope has closed: rows it left `running`
 * are recovered by the rule in docs/SCHEDULING.md once their handler is published again.
 */
export const makeTestScheduler = (
  options: {
    /** The modules whose collections the store is prepared for (and whose names the admin list shows). */
    readonly modules?: ReadonlyArray<{ readonly id: string; readonly name?: string; readonly storage?: ModuleStorage }>
    readonly store?: HouseholdStore
    /** `HOME_TIME_ZONE` (default: the server's). */
    readonly timeZone?: string | (() => string | undefined)
    readonly issues?: IssueRegistry
  } & Omit<SchedulerEngineOptions, "store" | "timeZone" | "issues" | "modules"> = {}
) =>
  Effect.gen(function*() {
    const { issues: given, modules, store: givenStore, timeZone, ...rest } = options
    const names = (modules ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
    const made = givenStore === undefined ? yield* makeTestHousehold(modules ?? []) : undefined
    const store = givenStore ?? made!.store
    const issues = given ?? makeIssueRegistry()
    const scheduler = yield* makeSchedulerEngine({
      ...rest,
      store,
      issues,
      modules: () => names,
      timeZone: typeof timeZone === "function" ? timeZone : () => timeZone
    })
    /** Move the test clock by `ms` and let the engine run until it waits again. */
    const advance = (ms: number) => Effect.andThen(Effect.andThen(scheduler.settled, TestClock.adjust(ms)), scheduler.settled)
    return { scheduler, store, issues, advance, household: made?.household }
  })

// ---------------------------------------------------------------------------------------------------------------------
// The module test kit (docs/MODULES.md "Testing"): a module in the real host, its conformance check, a network
// without a network.

export * from "./ModuleTestKit.ts"
export * from "./ModuleCheck.ts"
export * from "./OfflineNet.ts"
export { offThreadWorkers } from "./OffThread.ts"
export * from "./ModuleStubs.ts"
