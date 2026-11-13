import { Context, Effect, Layer } from "effect"

export const traceMarks = [
  "endOfTurn",
  "llmRequestSent",
  "llmFirstToken",
  "firstClause",
  "ttsFirstAudio",
  "playbackStart"
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
  /** Voices that spoke in this turn, in order of first use (filled by the voice router). */
  readonly voices: Array<string>
  outcome?: TurnOutcome
  endedAt?: number
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
  const parts = [`turn #${trace.id} ${trace.mode}${trace.speculative ? " (speculative)" : ""} ${trace.outcome ?? "running"}`]
  let prev: number | undefined
  for (const mark of traceMarks) {
    const t = trace.marks[mark]
    if (t === undefined || mark === "endOfTurn") continue
    parts.push(`${mark}=${ms(t - origin)}${prev !== undefined ? ` (+${ms(t - prev)})` : ""}`)
    prev = t
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
