/**
 * WP-14 measurements (docs/ASSISTANTS.md §3.6, §8): what TypeSafe routing costs a turn.
 *
 * - Offline (`bench --typesafe`): the offline bench's session path (route gate → dispatcher → `Conversation`) on a
 *   TypeSafe device, the decision simulated (it answers "jeff" after a fixed time), against the same device answering
 *   without a decider. The headline is the recogniser's `EndOfTurn` → playback start: the conversation's own
 *   `endOfTurn` mark comes after a decision held at the final, so the trace's PLAYBACK column would hide the cost.
 * - Live (`bench --typesafe-live`): real requests to TypeSafe with the owner's key (`TYPESAFE_API_KEY`, environment or
 *   vault), `routeReceived − routeSent` per request, its percentiles, and the choice made for each utterance.
 */
import { DecisionError } from "@pva/core"
import { defaults as jevDefaults, makeJevClient, readRouting, type RouteCandidate, routingRequest } from "@pva/decide-typesafe"
import { Effect, Redacted } from "effect"
import { makeTypesafeDecide, type RoutingService } from "../serve/routing.ts"
import type { DecideRoute } from "../serve/SessionDispatcher.ts"
import type { OfflineScenario, SimulatedDelays } from "./offline.ts"

/** Three assistants as a TypeSafe device would list them (the bench's conversation is Jeff's). */
export const benchCandidates: ReadonlyArray<RouteCandidate> = [
  { id: "jeff", name: "Jeff", purpose: "Everything else", handles: "General questions, conversation, explanations, the time, reminders of what we talked about." },
  { id: "keuken", name: "Keuken", purpose: "Kitchen", handles: "Kitchen timers, recipes, cooking times, groceries and what to eat." },
  { id: "t3", name: "T3", purpose: "Coding", handles: "Programming, software projects, pull requests, code reviews and the computer." }
]

/** A routing service that answers after `ms` with Jeff, sure and fitting (as a fast, confident TypeSafe would). */
export const simulatedRouting = (ms: number, choice = "jeff"): RoutingService => ({
  ready: () => true,
  decide: () =>
    Effect.sleep(ms).pipe(Effect.as({
      answers: {
        assistant: {
          type: "choice" as const,
          choice,
          probabilities: Object.fromEntries(benchCandidates.map((c) => [c.id, c.id === choice ? 0.9 : 0.05]))
        },
        fits: { type: "noul" as const, value: 0.9 }
      }
    }))
})

/**
 * The dispatcher's `decide` with a simulated decision of `ms`. The give-up time is set well above it (2 s), so the
 * simulated answer is always used and the measured cost is the decision's own; with the default 400 ms give-up a
 * decision of 400 ms or more costs at most 400 ms.
 */
export const simulatedDecide = (ms: number): DecideRoute =>
  makeTypesafeDecide({
    routing: () => simulatedRouting(ms),
    candidates: () => benchCandidates,
    giveUpMs: () => 2_000,
    now: () => performance.now()
  })

/** The offline TypeSafe scenarios: no decider, then 150, 250 and 400 ms decisions; eager end of turn off and on. */
export const typesafeScenarios = (delays: SimulatedDelays): ReadonlyArray<OfflineScenario> =>
  [false, true].flatMap((eager) =>
    [undefined, 150, 250, 400].map((decideMs): OfflineScenario => ({
      name: `${decideMs === undefined ? "no decider (answers without a phrase)" : `TypeSafe device, simulated decision ${decideMs} ms`}, ` +
        `eager ${eager ? `ON (EagerEndOfTurn ${delays.eagerLeadMs} ms before EndOfTurn)` : "OFF"}, session path`,
      delays,
      eager,
      dispatch: true,
      queued: true,
      ...(decideMs !== undefined ? { decideMs } : {})
    }))
  )

// ---------------------------------------------------------------------------
// Live

/** 50 sentences without a wake phrase, English and Dutch, for the three bench assistants. */
export const liveUtterances: ReadonlyArray<string> = [
  "what time is it", "set a timer for ten minutes", "how long do I boil an egg", "tell me a joke", "what did we talk about yesterday",
  "review my pull request", "what is the capital of peru", "add milk to the shopping list", "why does my build fail", "how are you today",
  "zet een timer van tien minuten", "hoe lang moet pasta koken", "wat is de hoofdstad van frankrijk", "vertel eens een mop", "welke dag is het vandaag",
  "explain how a heat pump works", "what should we eat tonight", "open the project in my editor", "remind me what you said about octopuses", "convert two cups to millilitres",
  "is there a test for the parser", "what is the weather like", "how many grams in an ounce", "write a commit message for this change", "who wrote pride and prejudice",
  "start the oven timer", "the tests are red again", "good morning", "how do I make pancakes", "what is a closure in javascript",
  "hoeveel gram suiker in een cake", "kun je de code even nakijken", "wat hebben we net besproken", "stop the kitchen timer", "summarise the last conversation",
  "merge the branch when the checks pass", "how hot should the oven be for bread", "what is two hundred times twelve", "rename this function", "thank you",
  "how long until the rice is done", "is it going to rain tomorrow", "deploy the new version", "what is a good wine with fish", "spell necessary",
  "lees het recept nog eens voor", "hoe laat is het", "run the linter", "tell me something interesting", "never mind"
]

export interface LiveOptions {
  readonly apiKey: string
  readonly baseUrl?: string | undefined
  readonly model?: string | undefined
  /** Utterances sent (from `liveUtterances`, repeated if more). Default 50. */
  readonly count?: number
  /** Pause between requests; Node's fetch closes an idle connection after about 4 s. Default 1000 ms. */
  readonly gapMs?: number
  /** Each request's time limit. Default 2000 ms (well above the 400 ms give-up, to see the tail). */
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
}

export interface LiveRow {
  readonly utterance: string
  /** `routeReceived − routeSent`, ms. */
  readonly ms: number
  readonly outcome: "chosen" | "none-fits" | "timeout" | "error"
  readonly assistant?: string
  readonly probability?: number
  readonly fits?: number
  readonly error?: string
}

/** The value at fraction `q` of the sorted values (nearest rank). */
export const percentile = (values: ReadonlyArray<number>, q: number): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

/** Sends `count` real routing requests, one after another, and returns one row per request. */
export const runTypesafeLive = (options: LiveOptions): Effect.Effect<ReadonlyArray<LiveRow>> =>
  Effect.gen(function*() {
    const client = makeJevClient({
      apiKey: Redacted.make(options.apiKey),
      baseUrl: options.baseUrl ?? jevDefaults.baseUrl,
      model: options.model ?? jevDefaults.model,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
    })
    const count = options.count ?? 50
    const timeoutMs = options.timeoutMs ?? 2_000
    const rows: Array<LiveRow> = []
    for (let i = 0; i < count; i++) {
      if (i > 0 && (options.gapMs ?? 1_000) > 0) yield* Effect.sleep(options.gapMs ?? 1_000)
      const utterance = liveUtterances[i % liveUtterances.length]!
      const sent = performance.now()
      const result = yield* Effect.result(client.decide(routingRequest(utterance, benchCandidates), { timeoutMs }))
      const ms = Math.round((performance.now() - sent) * 10) / 10
      if (result._tag === "Failure") {
        const e: DecisionError = result.failure
        rows.push({ utterance, ms, outcome: e.reason === "timeout" ? "timeout" : "error", error: e.message })
        continue
      }
      const reading = readRouting(result.success, benchCandidates)
      rows.push({
        utterance,
        ms,
        outcome: reading.outcome,
        ...(reading.outcome === "chosen" ? { assistant: reading.assistant } : reading.best !== undefined ? { assistant: `(${reading.best})` } : {}),
        ...(reading.probability !== undefined ? { probability: reading.probability } : {}),
        fits: reading.fits
      })
    }
    return rows
  })

const f = (n: number | undefined) => (n === undefined ? "-" : n.toFixed(n < 10 ? 2 : 0))

/** The table and the percentiles (the first request apart: it opens the connection). */
export const formatLive = (rows: ReadonlyArray<LiveRow>, title: string): string => {
  const lines = [`== ${title}`, "#   ms      outcome    assistant  p     fits  utterance"]
  rows.forEach((r, i) => {
    lines.push(
      `${String(i + 1).padEnd(3)} ${String(r.ms).padStart(6)}  ${r.outcome.padEnd(9)}  ${(r.assistant ?? "-").padEnd(9)}  ${f(r.probability).padStart(4)}  ${f(r.fits).padStart(4)}  ${r.utterance}${
        r.error !== undefined ? `  [${r.error}]` : ""
      }`
    )
  })
  const answered = rows.filter((r) => r.outcome === "chosen" || r.outcome === "none-fits")
  const warm = answered.slice(rows[0] !== undefined && answered[0] === rows[0] ? 1 : 0).map((r) => r.ms)
  const all = answered.map((r) => r.ms)
  const stats = (v: ReadonlyArray<number>) =>
    `n=${v.length} p50 ${f(percentile(v, 0.5))} · p90 ${f(percentile(v, 0.9))} · p95 ${f(percentile(v, 0.95))} · p99 ${f(percentile(v, 0.99))} · max ${f(v.length === 0 ? undefined : Math.max(...v))} ms`
  const by = (o: LiveRow["outcome"]) => rows.filter((r) => r.outcome === o).length
  const chosen = new Map<string, number>()
  for (const r of rows) if (r.outcome === "chosen") chosen.set(r.assistant!, (chosen.get(r.assistant!) ?? 0) + 1)
  lines.push(
    "",
    `routeReceived - routeSent, answered requests: ${stats(all)}`,
    `the same without the first request (connection set-up): ${stats(warm)}`,
    `within the default 400 ms give-up: ${answered.filter((r) => r.ms <= 400).length} of ${rows.length}`,
    `outcomes: chosen ${by("chosen")}, none fits ${by("none-fits")}, timeout ${by("timeout")}, error ${by("error")}; chosen: ${
      [...chosen].map(([a, n]) => `${a} ${n}`).join(", ") || "none"
    }`,
    ""
  )
  return lines.join("\n")
}

/** `bench --typesafe-live [--count N] [--gap-ms MS] [--timeout-ms MS]`: the options, or a problem. */
export const parseTypesafeLiveArgs = (args: ReadonlyArray<string>): { count: number; gapMs: number; timeoutMs: number } | string => {
  const out = { count: 50, gapMs: 1_000, timeoutMs: 2_000 }
  for (let i = 0; i < args.length; i += 2) {
    const n = Number(args[i + 1])
    const flag = args[i]
    if (!Number.isInteger(n) || n < 0) return `${flag} needs a whole number`
    if (flag === "--count" && n >= 1 && n <= 500) out.count = n
    else if (flag === "--gap-ms" && n <= 60_000) out.gapMs = n
    else if (flag === "--timeout-ms" && n >= 100 && n <= 10_000) out.timeoutMs = n
    else return `Unknown or out-of-range option ${flag}`
  }
  return out
}
