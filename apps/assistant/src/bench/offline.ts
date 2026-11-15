/**
 * Offline benchmark: scripted turns through the real `Conversation` with
 * in-process stand-ins (from `@pva/core/testing`) for STT, LLM, TTS and the
 * speaker, each with a configurable simulated delay. No keys, no network.
 */
import {
  Conversation,
  type LlmRequest,
  makeWakeGate,
  type SttEvent,
  ToolRegistry,
  type Trace,
  Tts,
  WAKE_ALWAYS,
  type WakeConfig,
  withTraceVoice
} from "@pva/core"
import {
  done,
  eagerEndOfTurn,
  endOfTurn,
  type LlmScript,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeScriptedLlm,
  scripted,
  sleep,
  type Sleep,
  speechStarted,
  textDelta,
  toolCall,
  turnResumed
} from "@pva/core/testing"
import { makeClock } from "@pva/modules-builtin"
import { Deferred, Effect, Layer, Queue, Stream } from "effect"
import type { BenchRow } from "./report.ts"
import { observedTurnTraceLayer } from "../startup.ts"

export interface SimulatedDelays {
  /** Request sent → first text token. */
  readonly llmFirstTokenMs: number
  /** Streaming speed after the first token; 0 = all tokens at once. */
  readonly llmTokensPerSecond: number
  /** Clause received → its audio (the stand-in synthesises clauses one after another). */
  readonly ttsFirstAudioMs: number
  /** How long "playing" one clause takes. Does not affect the end-of-turn → playback interval. */
  readonly playbackMsPerClause: number
  /** How long before `EndOfTurn` the `EagerEndOfTurn` arrives (eager mode only). */
  readonly eagerLeadMs: number
}

export const zeroDelays: SimulatedDelays = {
  llmFirstTokenMs: 0,
  llmTokensPerSecond: 0,
  ttsFirstAudioMs: 0,
  playbackMsPerClause: 0,
  eagerLeadMs: 0
}

export interface OfflineScenario {
  readonly name: string
  readonly delays: SimulatedDelays
  /** Emit `EagerEndOfTurn` (speculative turns) or only `EndOfTurn`. */
  readonly eager: boolean
  /**
   * The wake gate in front of `Conversation`, as in serve mode (default: `always`, the gate passing everything).
   * In `wake-phrase` mode every utterance starts with `wakePrefix` ("Hey Jeff, …"), which the gate removes.
   */
  readonly wake?: WakeConfig
  readonly wakePrefix?: string
}

interface ScriptedTurn {
  readonly user: string
  /** Eager mode: a premature eager end of turn on this prefix, then `TurnResumed` (the user kept talking). */
  readonly falseStart?: string
  /** The assistant first calls the clock tool, then says `reply`. */
  readonly tool?: boolean
  readonly reply: string
}

const script: ReadonlyArray<ScriptedTurn> = [
  { user: "Hello there.", reply: "Hi! What can I do for you today?" },
  { user: "What time is it?", tool: true, reply: "It is a quarter to twelve." },
  {
    user: "Tell me something interesting about octopuses.",
    reply: "Octopuses have three hearts and blue blood. Two of the hearts pump blood through the gills, " +
      "and the third pumps it to the rest of the body."
  },
  { user: "Remind me what we talked about.", falseStart: "Remind me", reply: "We talked about the time and about octopuses." }
]

/** The LLM stand-in: looks the user's words up in the script. */
const respond = (delays: SimulatedDelays) => (request: LlmRequest): LlmScript => {
  const pause = (ms: number): Array<Sleep> => (ms > 0 ? [sleep(ms)] : [])
  const words = (text: string): LlmScript => {
    const gap = delays.llmTokensPerSecond > 0 ? 1000 / delays.llmTokensPerSecond : 0
    const tokens = text.split(/(?<= )/)
    return [...pause(delays.llmFirstTokenMs), ...tokens.flatMap((t, i) => [...(i > 0 ? pause(gap) : []), textDelta(t)]), done()]
  }
  const messages = request.messages
  const lastUser = messages.findLast((m) => m.role === "user")
  const turn = script.find((t) => lastUser?.role === "user" && t.user === lastUser.content)
  if (turn === undefined) return words("Sorry, I did not catch that.")
  if (turn.tool === true && messages.at(-1)?.role !== "tool") {
    return [...pause(delays.llmFirstTokenMs), toolCall(`call_${messages.length}`, "current_time", { timeZone: "UTC" }), done("tool_use")]
  }
  return words(turn.reply)
}

/** What the STT stand-in emits for one turn. */
const sttEvents = (turn: ScriptedTurn, scenario: OfflineScenario): Array<SttEvent | Sleep> => {
  const prefix = scenario.wake?.activation === "wake-phrase" ? scenario.wakePrefix ?? "" : ""
  if (prefix !== "") {
    turn = { ...turn, user: `${prefix}${turn.user}`, ...(turn.falseStart !== undefined ? { falseStart: `${prefix}${turn.falseStart}` } : {}) }
  }
  const lead = scenario.delays.eagerLeadMs
  if (!scenario.eager) return [speechStarted, endOfTurn(turn.user)]
  const falseStart = turn.falseStart === undefined
    ? []
    : [eagerEndOfTurn(turn.falseStart), sleep(Math.max(lead, 1)), turnResumed, sleep(300)]
  return [speechStarted, ...falseStart, eagerEndOfTurn(turn.user), ...(lead > 0 ? [sleep(lead)] : []), endOfTurn(turn.user)]
}

/** All sessions reach turn `k` before any of them speaks it: simultaneous turn ends. */
const makeBarrier = (parties: number) => {
  const turns = new Map<number, { arrived: number; open: Deferred.Deferred<void> }>()
  return (k: number) =>
    Effect.suspend(() => {
      let entry = turns.get(k)
      if (entry === undefined) {
        entry = { arrived: 0, open: Deferred.makeUnsafe<void>() }
        turns.set(k, entry)
      }
      entry.arrived++
      return entry.arrived >= parties ? Deferred.succeed(entry.open, undefined) : Deferred.await(entry.open)
    })
}

/** One session: the script `rounds` times (after a warm-up round) through its own `Conversation`. */
const runSession = (
  scenario: OfflineScenario,
  rounds: number,
  tts: Tts["Service"],
  barrier: ((k: number) => Effect.Effect<void>) | undefined,
  label: string
) =>
  Effect.gen(function*() {
    const finished = yield* Queue.unbounded<Trace>()
    const onFinish = (trace: Trace) => trace.outcome === "discarded" ? Effect.void : Queue.offer(finished, trace)
    const layer = Conversation.layer({ systemPrompt: "Benchmark.", bargeIn: true }).pipe(
      Layer.provideMerge(Layer.mergeAll(
        makeScriptedLlm(respond(scenario.delays)).layer,
        ToolRegistry.layer([makeClock()]),
        observedTurnTraceLayer(onFinish),
        Layer.succeed(Tts, tts),
        makeRecordingAudioOutput({ chunkMillis: scenario.delays.playbackMsPerClause }).layer
      ))
    )
    const turns = Array.from({ length: rounds + 1 }, (_, round) => script.map((turn) => ({ round, turn }))).flat()
    // Serve mode's wake gate, on the events as they arrive (time passed in, as there).
    const wake = makeWakeGate(scenario.wake ?? WAKE_ALWAYS)
    const gated = (events: Stream.Stream<SttEvent>) =>
      events.pipe(Stream.flatMap((event) => Stream.fromIterable(wake.filter(event, performance.now()).events)))
    const rows: Array<BenchRow> = []
    const events = Stream.fromIterable(turns.map((t, k) => ({ ...t, k }))).pipe(
      Stream.flatMap(({ round, turn, k }) =>
        Stream.fromEffectDrain(barrier === undefined ? Effect.void : barrier(k)).pipe(
          Stream.concat(gated(scripted(sttEvents(turn, scenario)))),
          Stream.concat(Stream.fromEffectDrain(Effect.gen(function*() {
            const trace = yield* Queue.take(finished)
            if (round > 0) rows.push({ label: `${label}${round}.${script.indexOf(turn) + 1} ${turn.user.slice(0, 24)}`, trace })
          })))
        ), { concurrency: 1 })
    )
    yield* Effect.gen(function*() {
      const conversation = yield* Conversation
      yield* conversation.voice(events)
    }).pipe(Effect.provide(layer))
    return rows
  })

/** Tagged with its voice in the trace, as in the app. */
const benchTts = (scenario: OfflineScenario) =>
  withTraceVoice(makeMarkerTts({ delayMillis: scenario.delays.ttsFirstAudioMs }).service, "bench")

/**
 * Run the script `rounds` times in one conversation (after one unreported
 * warm-up round, so JIT compilation is not measured) and return the committed
 * turns. Each turn waits for the previous reply to finish playing.
 */
export const runOffline = (scenario: OfflineScenario, rounds: number) => runSession(scenario, rounds, benchTts(scenario), undefined, "")

/**
 * `bench --sessions N`: N sessions at once, as serve mode runs several devices: each its own `Conversation`, the
 * voice (TTS stand-in) shared, and every turn's end simultaneous in all sessions (each session
 * waits for the others before speaking its next turn). Rows per session.
 */
export const runOfflineSessions = (scenario: OfflineScenario, rounds: number, sessions: number) =>
  Effect.gen(function*() {
    const tts = benchTts(scenario)
    const barrier = makeBarrier(sessions)
    return yield* Effect.forEach(
      Array.from({ length: sessions }, (_, i) => i),
      (i) => runSession(scenario, rounds, tts, barrier, `s${i + 1} `),
      { concurrency: "unbounded" }
    )
  })
