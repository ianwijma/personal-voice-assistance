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
import { addressSecrets, checkAddress, clip, fromUpstream, safeSeconds, sanitize, type Secrets, secretList } from "./redact.ts"

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

/**
 * The answer in the core's shape, or a description of what is wrong with it.
 * The description quotes the answer (schema diagnostics include the values), so
 * it is redacted before it is shortened.
 */
export const fromBody = (body: unknown, secrets: Secrets = []): DecisionResponse | string => {
  const result = decodeResponse(body)
  if (result._tag === "Failure") return clip(String(result.failure), secrets, 300)
  const raw = (body as { readonly answers: Readonly<Record<string, unknown>> }).answers
  const answers: Record<string, DecisionResponse["answers"][string]> = {}
  for (const [name, answer] of Object.entries(result.success.answers)) {
    if (answer.type === "choice") {
      const choice = decodeChoice(raw[name])
      if (choice._tag === "Failure") return clip(`answer "${name}": ${String(choice.failure)}`, secrets, 300)
      answers[name] = { type: "choice", choice: choice.success.choice, probabilities: choice.success.probabilities }
    } else if (answer.type === "noul") {
      const noul = decodeNoul(raw[name])
      if (noul._tag === "Failure") return clip(`answer "${name}": ${String(noul.failure)}`, secrets, 300)
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
    this.name = "KeyRejected"
    this.status = status
  }
}

/**
 * True when the error means the key is missing or was refused (not a passing service failure).
 * By name: `decisionError` replaces every cause by a sanitised copy, which keeps the name.
 */
export const isKeyRejected = (error: DecisionErrorType): boolean => error.cause instanceof Error && error.cause.name === "KeyRejected"

/** The only way a `DecisionError` is made here: message and cause sanitised (see `redact.ts`). */
export const decisionError = (secrets: Secrets, fields: ConstructorParameters<typeof DecisionError>[0]): DecisionError =>
  new DecisionError(sanitize(secrets, fields))

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** `{ detail: string | object | [{ loc, msg }] }` → text. The body is redacted as a whole first (`fromUpstream`). */
export const detailText = (body: string, secrets: ReadonlyArray<string | undefined> = []): string => {
  const safe = fromUpstream(body, secrets)
  let text = safe.trim()
  try {
    const json: unknown = JSON.parse(safe)
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
  return clip(text.trim(), secrets, 300) // redacted before shortening: half a key is still a leak
}

const statusError = (status: number, body: string, retryAfterHeader: string | null, secrets: Secrets): DecisionError => {
  if (status === 401 || status === 403) {
    // Fixed text: the body of a 401 is where a gateway echoes the submitted key back.
    const message = `TypeSafe rejected the API key (${status})`
    return decisionError(secrets, { reason: "unavailable", message, cause: new KeyRejected(status, message) })
  }
  const detail = detailText(body, secrets)
  const suffix = detail.length > 0 ? `: ${detail}` : ""
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return decisionError(secrets, { reason: "rejected", message: `TypeSafe refused the request (${status})${suffix}` })
  }
  // Shown only as a number: the header is upstream text like any other.
  const retryAfter = safeSeconds(retryAfterHeader)
  const what = status === 429
    ? `TypeSafe is rate limiting (429${retryAfter !== undefined ? `, retry after ${retryAfter} s` : ""})`
    : status === 529
    ? "TypeSafe is overloaded (529)"
    : `TypeSafe answered ${status}`
  return decisionError(secrets, { reason: "unavailable", message: `${what}${suffix}` })
}

// ---------------------------------------------------------------------------
// Client

export interface JevClient {
  /** One decision; at most `timeoutMs`; interruptible (aborts the request). */
  readonly decide: (request: DecisionRequest) => Effect.Effect<DecisionResponse, DecisionError>
  /** Milliseconds of the last successful decision, for the status line. */
  readonly lastMs: () => number | undefined
}

/** The rules for the base address: http(s), no user-info, no query (see `redact.ts`, `checkAddress`). */
export const ADDRESS_RULES = { protocols: ["https:", "http:"], query: false } as const

export const makeJevClient = (options: JevClientOptions): JevClient => {
  // Read and checked once, inside the boundary: a getter that throws or an address that is refused
  // makes every decision fail with a sanitised error; constructing the client never throws.
  let secrets: Secrets = []
  let setup: { readonly baseUrl: string; readonly model: string; readonly timeoutMs: number; readonly fetchFn: typeof globalThis.fetch; readonly apiKey: string } | DecisionError
  try {
    secrets = secretList(Redacted.value(options.apiKey))
    const configured = options.baseUrl ?? defaults.baseUrl
    secrets = secretList(secrets, addressSecrets(configured))
    const address = checkAddress(configured, ADDRESS_RULES)
    setup = address.ok
      ? {
        // The credential-free form is the only one any message, or the request, uses.
        baseUrl: address.display,
        model: options.model ?? defaults.model,
        timeoutMs: options.timeoutMs ?? defaults.timeoutMs,
        fetchFn: options.fetch ?? globalThis.fetch,
        apiKey: Redacted.value(options.apiKey)
      }
      : decisionError(secrets, { reason: "unavailable", message: `The TypeSafe address ${address.problem}` })
  } catch (e) {
    setup = decisionError(secrets, { reason: "unavailable", message: `The TypeSafe settings could not be read: ${fromUpstream(e, secrets)}`, cause: e })
  }
  let keyRejected: DecisionError | undefined
  let last: number | undefined

  const attempt = (request: DecisionRequest): Effect.Effect<DecisionResponse, DecisionError> =>
    Effect.suspend(() => {
      if (setup instanceof DecisionError) return Effect.fail(setup)
      if (keyRejected !== undefined) return Effect.fail(keyRejected)
      const { baseUrl, model, timeoutMs, fetchFn, apiKey } = setup
      const started = performance.now()
      return Effect.tryPromise({
        try: async (signal) => {
          // Inside the boundary: serialising can throw (a value with a throwing `toJSON`).
          const body = JSON.stringify(toBody(request, model))
          const response = await fetchFn(`${baseUrl}/v1/systemone`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              accept: "application/json"
            },
            body,
            signal
          })
          const text = await response.text()
          if (!response.ok) throw statusError(response.status, text, response.headers.get("retry-after"), secrets)
          let json: unknown
          try {
            json = JSON.parse(text)
          } catch {
            throw decisionError(secrets, { reason: "invalid", message: "TypeSafe answered with something that is not JSON" })
          }
          const decoded = fromBody(json, secrets)
          if (typeof decoded === "string") {
            throw decisionError(secrets, { reason: "invalid", message: `TypeSafe's answer does not have the documented shape: ${decoded}` })
          }
          return decoded
        },
        catch: (e) => {
          if (e instanceof DecisionError) return decisionError(secrets, { reason: e.reason, message: e.message, cause: e.cause })
          const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e
          return decisionError(secrets, { reason: "unavailable", message: `Could not reach TypeSafe at ${baseUrl}: ${fromUpstream(cause, secrets)}`, cause: e })
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(decisionError(secrets, { reason: "timeout", message: `TypeSafe did not answer within ${timeoutMs} ms` }))
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

  // The last resort: anything unexpected (a defect) leaves as a sanitised `DecisionError`.
  const decide = (request: DecisionRequest): Effect.Effect<DecisionResponse, DecisionError> =>
    attempt(request).pipe(
      Effect.catchDefect((defect) =>
        Effect.fail(decisionError(secrets, { reason: "unavailable", message: `The TypeSafe decision failed unexpectedly: ${fromUpstream(defect, secrets)}`, cause: defect }))
      ),
      Effect.mapError((e) => decisionError(secrets, { reason: e.reason, message: e.message, cause: e.cause }))
    )

  return { decide, lastMs: () => last }
}

/** The smallest useful request: checks the key and measures the round trip at start. */
export const pingRequest: DecisionRequest = {
  state: { utterance: "turn on the light", available_actions: { lights_on: "Turn lights on" } },
  questions: {
    fits: { type: "noul", instructions: "Does the utterance ask the assistant to do one of the available_actions?", role: { kind: "fits" } }
  }
}
