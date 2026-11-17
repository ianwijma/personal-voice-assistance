import type { AgentKind, RouteReason, TraceRoute } from "@pva/protocol"
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

/**
 * The most entries a trace's own list (`Trace.events`) holds; later ones are dropped (the turn goes on). Below the
 * protocol's 200 for the published time line, so the entries `traceTimeline` adds (marks, start, end) always fit.
 */
export const MAX_TRACE_EVENTS = 180
/** The most entries the published time line has (protocol `TraceInfo.timeline`). */
export const MAX_TIMELINE_ENTRIES = 200

/**
 * One entry of the time line (monotonic milliseconds, `at` absolute). Names are the protocol's `TRACE_EVENT_NAMES`
 * (docs/ARCHITECTURE.md, Latency tracing); `ms` makes it a span that began at `at`.
 */
export interface TraceEventRecord {
  readonly name: string
  readonly at: number
  readonly ms?: number
  readonly detail?: string
}

/** One turn's timestamps (monotonic milliseconds). Mutated in place while the turn runs. */
export interface Trace {
  readonly id: number
  readonly mode: "voice" | "text"
  /** Started from an `EagerEndOfTurn`. */
  speculative: boolean
  readonly startedAt: number
  readonly marks: Partial<Record<TraceMark, number>>
  /** Tool calls (and actions) that ran, with how long each took (their start is a `tool`/`action` entry of `events`). */
  readonly tools: Array<{ readonly name: string; readonly ms: number }>
  /**
   * The time line beyond the marks: entries that are not "first time only" (per-round language-model events, tool and
   * action spans, hearing and voice events; created when the first is added), in the order they were added (not sorted). `traceTimeline` joins them
   * with the marks.
   */
  events?: Array<TraceEventRecord>
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
  /**
   * Append a time-line entry (synchronous, no Effect; dropped after `MAX_TRACE_EVENTS`). `at` defaults to now;
   * give it for something that happened earlier (a hearing event, a tool's start).
   */
  event(trace: Trace, name: string, options?: { readonly at?: number; readonly ms?: number; readonly detail?: string }): void
  /** Record outcome, log one line with the deltas, keep it in the recent list. */
  finish(trace: Trace, outcome: TurnOutcome): Effect.Effect<void>
  readonly now: () => number
  readonly recent: Effect.Effect<ReadonlyArray<Trace>>
}>()("@pva/core/TurnTrace") {
  static readonly layer = (options: { readonly keep?: number; readonly now?: () => number } = {}) =>
    Layer.sync(TurnTrace, () => makeTurnTrace(options))
}

/** Append an entry to `trace.events` (what `TurnTrace.event` does, for code that has the time already). */
export const addTraceEvent = (trace: Trace, name: string, at: number, ms?: number, detail?: string): void => {
  const events = trace.events ??= []
  if (events.length >= MAX_TRACE_EVENTS) return
  events.push(ms === undefined ? (detail === undefined ? { name, at } : { name, at, detail }) : detail === undefined ? { name, at, ms } : { name, at, ms, detail })
}

/** The marks that appear on the time line under their own name (the others are covered by spans). */
const markNames: ReadonlyArray<TraceMark> = traceMarks.filter((m) =>
  m !== "actionStarted" && m !== "actionFinished" && m !== "routeSent" && m !== "routeReceived"
)

/**
 * A trace's whole time line, absolute and sorted by `at`: the entries of `events`, the marks (unless an event of the
 * same name is there: per-round entries replace the first-only mark), `turnStarted`, the `routing` span (from
 * `routeSent`/`routeReceived`), `audible` (playback start plus the client's output latency) and `turnEnded` (detail:
 * the outcome). Not for hot paths (it allocates): the publisher calls it when a turn ends.
 */
export const traceTimeline = (trace: Trace): Array<TraceEventRecord> => {
  const out: Array<TraceEventRecord> = [{ name: "turnStarted", at: trace.startedAt }]
  if (trace.events !== undefined) out.push(...trace.events)
  const has = new Set(out.map((e) => e.name))
  for (const m of markNames) {
    const t = trace.marks[m]
    if (t !== undefined && !has.has(m)) out.push({ name: m, at: t })
  }
  const sent = trace.marks.routeSent
  if (sent !== undefined && !has.has("routing")) {
    const got = trace.marks.routeReceived
    out.push(got === undefined ? { name: "routing", at: sent } : { name: "routing", at: sent, ms: Math.max(0, got - sent) })
  }
  const start = trace.marks.playbackStart
  if (trace.client !== undefined && start !== undefined) out.push({ name: "audible", at: start + trace.client.outputLatencyMs })
  if (trace.endedAt !== undefined) out.push({ name: "turnEnded", at: trace.endedAt, ...(trace.outcome !== undefined ? { detail: trace.outcome } : {}) })
  // Stable: entries with the same time keep the order they were added in (the mark order for marks).
  return out.filter((e) => Number.isFinite(e.at)).map((e, i) => [e, i] as const).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([e]) => e)
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
    event: (trace, name, opts) => addTraceEvent(trace, name, opts?.at ?? now(), opts?.ms, opts?.detail),
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
