import type { AgentKind, RiskDecision, RouteReason, TraceRoute } from "@pva/protocol"
import { Context, Effect, Layer } from "effect"

export const traceMarks = [
  "endOfTurn",
  "llmRequestSent",
  "llmFirstToken",
  /** Intent agents: decision request sent / answer received. */
  "decisionSent",
  "decisionReceived",
  "firstClause",
  "ttsFirstAudio",
  "playbackStart",
  /** Intent agents: the action's `run` started / ended. */
  "actionStarted",
  "actionFinished",
  /** Routing (docs/ASSISTANTS.md §3.6, §3.7): the TypeSafe routing request left / its answer arrived. */
  "routeSent",
  "routeReceived"
] as const
export type TraceMark = typeof traceMarks[number]

export type TurnOutcome = "completed" | "interrupted" | "discarded" | "failed"

/** One turn's timestamps (monotonic milliseconds). Mutated in place while the turn runs. */
export interface Trace {
  readonly id: number
  readonly mode: "voice" | "text"
  /** Started from an `EagerEndOfTurn`. */
  speculative: boolean
  readonly startedAt: number
  readonly marks: Partial<Record<TraceMark, number>>
  readonly tools: Array<{ readonly name: string; readonly ms: number }>
  /**
   * P8: what the risk policy decided for each call of the turn that reached the decision (the execution gateway adds
   * one entry per decision, on every path that runs inside the turn), in order. Absent until the first.
   */
  calls?: Array<TraceCall>
  /** Voices that spoke in this turn, in order of first use (filled by the voice router). */
  readonly voices: Array<string>
  /** The agent that answered (agent conversations; replaced when a fallback agent takes over). */
  agent?: TraceAgent
  outcome?: TurnOutcome
  endedAt?: number
  /**
   * Reported by an output that plays elsewhere (the browser): its output latency
   * (the sound is audible this much after `playbackStart`) and how long it
   * buffered before starting.
   */
  client?: { readonly outputLatencyMs: number; readonly startDelayMs: number }
  /** The voice session the turn belongs to (serve mode: the device's name), so the latency line tells sessions apart. */
  readonly session?: string
  /** The assistant that answers this turn (docs/ASSISTANTS.md §3.7; serve mode, one conversation per assistant). */
  readonly assistant?: { readonly id: string; readonly name: string }
  /** The device the turn was on: its id and name (serve mode). */
  readonly deviceId?: string
  readonly device?: string
  /** Who chose the assistant (phrase, armed, follow-up, default, typed, TypeSafe); set at the turn's start, updated at its end of turn. */
  route?: TraceRoute
  /** A snapshot of the latency-relevant configuration the turn used (protocol 7 `TraceConfig`), when known. */
  config?: unknown
}

/** One decision of the risk policy in a turn (`Trace.calls`). */
export interface TraceCall {
  /** The tool's name; an action's generated tool name; a handler's `<module>/<name>`. */
  readonly name: string
  readonly outcome: RiskDecision["outcome"]
  /** The class it was decided by (`unjudged`: its risk function failed). */
  readonly by: RiskDecision["by"]
  /** Allowed and run, but its `personal` result was withheld from the model (the asking device may not reveal it). */
  withheld?: boolean
}

export interface TraceAgent {
  readonly id: string
  readonly kind: AgentKind
  readonly routedBy: RouteReason
  /** The agent the turn was meant for (unavailable, failed or passed on). */
  readonly fallbackFrom?: string
}

/**
 * Per-turn latency tracing. Marking is a plain synchronous call (no Effect),
 * so it can sit on hot paths; only the first call for each mark counts.
 */
/**
 * The trace of the turn whose audio is being synthesised, if any. `Conversation`
 * provides it around `Tts.synthesize`, so a `Tts` implementation (the voice
 * router) can annotate the turn without any change to the `Tts` interface.
 */
export const CurrentTurnTrace = Context.Reference<Trace | undefined>("@pva/core/CurrentTurnTrace", {
  defaultValue: () => undefined
})

export class TurnTrace extends Context.Service<TurnTrace, {
  begin(mode: Trace["mode"], speculative?: boolean): Trace
  mark(trace: Trace, mark: TraceMark): void
  /** Record outcome, log one line with the deltas, keep it in the recent list. */
  finish(trace: Trace, outcome: TurnOutcome): Effect.Effect<void>
  readonly now: () => number
  readonly recent: Effect.Effect<ReadonlyArray<Trace>>
}>()("@pva/core/TurnTrace") {
  static readonly layer = (options: { readonly keep?: number; readonly now?: () => number } = {}) =>
    Layer.sync(TurnTrace, () => makeTurnTrace(options))
}

const ms = (n: number) => `${Math.round(n)}ms`

/** `endOfTurn→X` deltas; for a promoted speculative turn some are negative (work done early). */
export const formatTrace = (trace: Trace): string => {
  const origin = trace.marks.endOfTurn ?? trace.startedAt
  const parts = [
    `${trace.session !== undefined ? `[${trace.session}] ` : ""}turn #${trace.id} ${trace.mode}${trace.speculative ? " (speculative)" : ""} ${trace.outcome ?? "running"}`
  ]
  if (trace.assistant !== undefined) {
    parts.push(`assistant=${trace.assistant.id}${trace.route !== undefined ? `(${trace.route.by}${"phrase" in trace.route ? ` "${trace.route.phrase}"` : ""})` : ""}`)
  }
  if (trace.agent !== undefined) {
    parts.push(`agent=${trace.agent.id}(${trace.agent.routedBy}${trace.agent.fallbackFrom !== undefined ? `, instead of ${trace.agent.fallbackFrom}` : ""})`)
  }
  let prev: number | undefined
  for (const mark of traceMarks) {
    const t = trace.marks[mark]
    if (t === undefined || mark === "endOfTurn") continue
    parts.push(`${mark}=${ms(t - origin)}${prev !== undefined ? ` (+${ms(t - prev)})` : ""}`)
    prev = t
  }
  const start = trace.marks.playbackStart
  if (trace.client !== undefined && start !== undefined) {
    parts.push(`audible=${ms(start + trace.client.outputLatencyMs - origin)} (+${ms(trace.client.outputLatencyMs)} output latency)`)
  }
  if (trace.tools.length > 0) parts.push(`tools: ${trace.tools.map((t) => `${t.name} ${ms(t.ms)}`).join(", ")}`)
  if (trace.calls !== undefined && trace.calls.length > 0) {
    parts.push(`risk: ${trace.calls.map((c) => `${c.name} ${c.outcome}(${c.by})${c.withheld === true ? " withheld" : ""}`).join(", ")}`)
  }
  if (trace.voices.length > 0) parts.push(`voices: ${trace.voices.join(", ")}`)
  if (trace.endedAt !== undefined) parts.push(`total=${ms(trace.endedAt - origin)}`)
  return parts.join(" ")
}

export const makeTurnTrace = (options: { readonly keep?: number; readonly now?: () => number } = {}): TurnTrace["Service"] => {
  const keep = options.keep ?? 50
  const now = options.now ?? (() => performance.now())
  const recent: Array<Trace> = []
  let nextId = 1
  return TurnTrace.of({
    now,
    begin: (mode, speculative = false) => ({ id: nextId++, mode, speculative, startedAt: now(), marks: {}, tools: [], voices: [] }),
    mark: (trace, mark) => {
      if (trace.marks[mark] === undefined) trace.marks[mark] = now()
    },
    finish: (trace, outcome) =>
      Effect.suspend(() => {
        trace.outcome = outcome
        trace.endedAt = now()
        recent.push(trace)
        if (recent.length > keep) recent.shift()
        return Effect.logInfo(formatTrace(trace))
      }),
    recent: Effect.sync(() => recent.slice())
  })
}
