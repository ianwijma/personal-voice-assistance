/**
 * TypeSafe's Jev as a `DecisionProvider` (docs/AGENTS-AND-INTENTS.md §3.7,
 * docs/research/typesafe-jev.md).
 *
 * One `POST {baseUrl}/v1/systemone` per utterance, plain `fetch`, no SDK: the
 * SDK's defaults (10 s per attempt, two retries with backoff, `jev-latest`) are
 * wrong for a spoken turn, it is pre-1.0 with breaking minors, and the API is a
 * single JSON round trip. No retries here at all: a retry doubles the latency of
 * a turn whose answer is already late, and the intent agent hands the turn to
 * the conversational agent instead.
 *
 * Request: `{ model, state, questions }`; each question's `options` become
 * Jev's `criteria` and the `role` (for local deciders) is removed. Response:
 * `answers[name]` is `{ type: "choice", choice, probabilities }` or
 * `{ type: "noul", noul }`, validated with a Schema; other answer types are
 * ignored (a missing answer counts as probability 0).
 *
 * Every shape here comes from TypeSafe's documentation and OpenAPI file: no
 * authenticated request has been made yet.
 *
 * Errors (`DecisionError.reason`), which the caller treats differently from a
 * successful answer that says "no action fits" (low `fits`):
 * - `timeout`: no answer within `timeoutMs`; the request is aborted.
 * - `unavailable`: the service failed (network, 429, 529, 5xx), or the key was
 *   rejected (401/403; `isKeyRejected(error)` tells these apart). After a
 *   rejection every later call fails at once, without a request, until the
 *   module restarts with new settings.
 * - `rejected`: the request was refused as invalid (400, 413, 415, 422); the body is logged.
 * - `invalid`: a 200 whose body does not have the documented shape.
 */
import type { DecisionError as DecisionErrorType, DecisionQuestion, DecisionRequest, DecisionResponse } from "@pva/core"
import { DecisionError } from "@pva/core"
import { Effect, Redacted, Schema } from "effect"

export interface JevClientOptions {
  readonly apiKey: Redacted.Redacted<string>
  /** Default `https://api.typesafe.ai`. Any server speaking `/v1/systemone` works (Ollama with Nimble: untested). */
  readonly baseUrl?: string
  /** Pinned: thresholds are version-specific and `jev-latest` moves. */
  readonly model?: string
  /** Whole round trip, from sending to the parsed answer. */
  readonly timeoutMs?: number
  /** For tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

export const defaults = {
  baseUrl: "https://api.typesafe.ai",
  model: "jev-1.14.0",
  timeoutMs: 1_000
} as const

// ---------------------------------------------------------------------------
// Request

type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string }

const toJevQuestion = (q: DecisionQuestion): JevQuestion =>
  q.type === "choice"
    ? { type: "choice", instructions: q.instructions, criteria: { ...q.options } }
    : { type: "noul", instructions: q.instructions }

/** The System One request body: options → criteria, roles removed. */
export const toBody = (request: DecisionRequest, model: string) => {
  const questions: Record<string, JevQuestion> = {}
  for (const [name, q] of Object.entries(request.questions)) questions[name] = toJevQuestion(q)
  return { model, state: request.state, questions }
}

// ---------------------------------------------------------------------------
// Response

const Probability = Schema.Number.check(Schema.isFinite())

const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Probability)
})
const NoulAnswer = Schema.Struct({ type: Schema.Literal("noul"), noul: Probability })
const ResponseBody = Schema.Struct({
  model: Schema.optional(Schema.String),
  /** Each answer is checked by its `type` below; `score` and `box` answers are never asked for and are ignored. */
  answers: Schema.Record(Schema.String, Schema.Struct({ type: Schema.String }))
})

const decodeResponse = Schema.decodeUnknownResult(ResponseBody)
const decodeChoice = Schema.decodeUnknownResult(ChoiceAnswer)
const decodeNoul = Schema.decodeUnknownResult(NoulAnswer)

/** The answer in the core's shape, or a description of what is wrong with it. */
export const fromBody = (body: unknown): DecisionResponse | string => {
  const result = decodeResponse(body)
  if (result._tag === "Failure") return String(result.failure).slice(0, 300)
  const raw = (body as { readonly answers: Readonly<Record<string, unknown>> }).answers
  const answers: Record<string, DecisionResponse["answers"][string]> = {}
  for (const [name, answer] of Object.entries(result.success.answers)) {
    if (answer.type === "choice") {
      const choice = decodeChoice(raw[name])
      if (choice._tag === "Failure") return `answer "${name}": ${String(choice.failure).slice(0, 250)}`
      answers[name] = { type: "choice", choice: choice.success.choice, probabilities: choice.success.probabilities }
    } else if (answer.type === "noul") {
      const noul = decodeNoul(raw[name])
      if (noul._tag === "Failure") return `answer "${name}": ${String(noul.failure).slice(0, 250)}`
      answers[name] = { type: "noul", value: noul.success.noul }
    }
  }
  return result.success.model !== undefined ? { answers, model: result.success.model } : { answers }
}

// ---------------------------------------------------------------------------
// Errors

/** The cause of a `DecisionError` caused by a missing or rejected key. */
export class KeyRejected extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** True when the error means the key is missing or was refused (not a passing service failure). */
export const isKeyRejected = (error: DecisionErrorType): boolean => error.cause instanceof KeyRejected

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** `{ detail: string | object | [{ loc, msg }] }` → text. */
export const detailText = (body: string): string => {
  let text = body.trim()
  try {
    const json: unknown = JSON.parse(body)
    if (isRecord(json)) {
      const detail = json.detail
      if (typeof detail === "string") text = detail
      else if (Array.isArray(detail)) {
        text = detail
          .map((d) => (isRecord(d) ? `${Array.isArray(d.loc) ? d.loc.join(".") + ": " : ""}${String(d.msg ?? JSON.stringify(d))}` : String(d)))
          .join("; ")
      } else if (detail !== undefined) text = JSON.stringify(detail)
      else if (isRecord(json.error) && typeof json.error.message === "string") text = json.error.message
    }
  } catch {
    // keep the text
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

const statusError = (status: number, body: string, retryAfter: string | null): DecisionError => {
  const detail = detailText(body)
  const suffix = detail.length > 0 ? `: ${detail}` : ""
  if (status === 401 || status === 403) {
    const message = `TypeSafe rejected the API key (${status})${suffix}`
    return new DecisionError({ reason: "unavailable", message, cause: new KeyRejected(status, message) })
  }
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return new DecisionError({ reason: "rejected", message: `TypeSafe refused the request (${status})${suffix}` })
  }
  const what = status === 429
    ? `TypeSafe is rate limiting (429${retryAfter !== null ? `, retry after ${retryAfter} s` : ""})`
    : status === 529
    ? "TypeSafe is overloaded (529)"
    : `TypeSafe answered ${status}`
  return new DecisionError({ reason: "unavailable", message: `${what}${suffix}` })
}

// ---------------------------------------------------------------------------
// Client

export interface JevClient {
  /** One decision; at most `timeoutMs`; interruptible (aborts the request). */
  readonly decide: (request: DecisionRequest) => Effect.Effect<DecisionResponse, DecisionError>
  /** Milliseconds of the last successful decision, for the status line. */
  readonly lastMs: () => number | undefined
}

export const makeJevClient = (options: JevClientOptions): JevClient => {
  const baseUrl = (options.baseUrl ?? defaults.baseUrl).trim().replace(/\/+$/, "")
  const model = options.model ?? defaults.model
  const timeoutMs = options.timeoutMs ?? defaults.timeoutMs
  const fetchFn = options.fetch ?? globalThis.fetch
  let keyRejected: DecisionError | undefined
  let last: number | undefined

  const decide = (request: DecisionRequest): Effect.Effect<DecisionResponse, DecisionError> =>
    Effect.suspend(() => {
      if (keyRejected !== undefined) return Effect.fail(keyRejected)
      const started = performance.now()
      const body = JSON.stringify(toBody(request, model))
      return Effect.tryPromise({
        try: async (signal) => {
          const response = await fetchFn(`${baseUrl}/v1/systemone`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${Redacted.value(options.apiKey)}`,
              "content-type": "application/json",
              accept: "application/json"
            },
            body,
            signal
          })
          const text = await response.text()
          if (!response.ok) throw statusError(response.status, text, response.headers.get("retry-after"))
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {
            throw new DecisionError({ reason: "invalid", message: "TypeSafe answered with something that is not JSON" })
          }
          const decoded = fromBody(json)
          if (typeof decoded === "string") {
            throw new DecisionError({ reason: "invalid", message: `TypeSafe's answer does not have the documented shape: ${decoded}` })
          }
          return decoded
        },
        catch: (e) => {
          if (e instanceof DecisionError) return e
          const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e)
          return new DecisionError({ reason: "unavailable", message: `Could not reach TypeSafe at ${baseUrl}: ${cause}`, cause: e })
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new DecisionError({ reason: "timeout", message: `TypeSafe did not answer within ${timeoutMs} ms` }))
        }),
        Effect.tap(() => Effect.sync(() => (last = Math.round(performance.now() - started)))),
        Effect.tapError((error) =>
          Effect.suspend(() => {
            if (isKeyRejected(error)) keyRejected = error
            return error.reason === "rejected" ? Effect.logWarning(error.message) : Effect.void
          })
        )
      )
    })

  return { decide, lastMs: () => last }
}

/** The smallest useful request: checks the key and measures the round trip at start. */
export const pingRequest: DecisionRequest = {
  state: { utterance: "turn on the light", available_actions: { lights_on: "Turn lights on" } },
  questions: {
    fits: { type: "noul", instructions: "Does the utterance ask the assistant to do one of the available_actions?", role: { kind: "fits" } }
  }
}
