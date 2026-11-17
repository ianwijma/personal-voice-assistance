/**
 * The Anthropic API's model list (`GET /v1/models`, through the SDK's `models.list`) for the admin's model picker
 * (docs/MODEL-PICKERS.md §3). Never on a turn's path: the picker asks for it on demand, and the server caches it.
 *
 * The field names are the SDK's (`@anthropic-ai/sdk` 1.8, `resources/models.d.ts`): `id`, `display_name`,
 * `max_input_tokens`, `max_tokens`, `lifecycle`, `created_at`. They were not checked against the live API from this
 * machine (no key here); the tests run the SDK against a local server that answers in that shape.
 *
 * `knownModels` are the models this code already names (the default model, the settings' descriptions): the picker
 * offers them when there is no list (the call failed). Nothing else is invented.
 */
import Anthropic from "@anthropic-ai/sdk"
import { Config, Effect, Redacted, Schema } from "effect"
import { createHash } from "node:crypto"
import { addressSecrets, checkAddress, fromUpstream, safeId, sanitize, type Secrets, secretList } from "./redact.ts"

export interface AnthropicModel {
  readonly id: string
  /** `display_name` ("Claude Haiku 5.5"). */
  readonly label: string
  readonly contextTokens?: number
  readonly maxOutputTokens?: number
  /** `deprecated`: still callable, closed to new adopters. Retired models are not listed (the API's default). */
  readonly lifecycle?: "active" | "deprecated"
  /** Epoch ms of `created_at` (the release), when it is a real date. */
  readonly releasedAt?: number
}

/** The models the code names (llm-anthropic's default, the settings' descriptions, agent-claude-code's `MODELS`). */
export const knownModels: ReadonlyArray<AnthropicModel> = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" }
]

/** At most this many models are read (pages of 100). */
export const MAX_LISTED_MODELS = 1000

export class AnthropicModelListError extends Schema.TaggedError<AnthropicModelListError>()("AnthropicModelListError", {
  /** One sentence for the owner, without any credential. */
  message: Schema.String,
  reason: Schema.Literals(["unauthorized", "rate_limited", "unreachable", "timeout", "invalid"]),
  retryAfterMs: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect())
}) {}

const listError = (secrets: Secrets, fields: ConstructorParameters<typeof AnthropicModelListError>[0]) =>
  new AnthropicModelListError(sanitize(secrets, fields))

export interface ListModelsOptions {
  readonly apiKey: Redacted.Redacted<string>
  /** Default `DEFAULT_BASE_URL`. */
  readonly baseURL?: string
  /** For the whole list (every page). Default 10 000 ms. */
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
}

const ADDRESS_RULES = { protocols: ["http:", "https:"], query: false } as const
/** `index.ts`'s `DEFAULT_BASE_URL` (repeated: that file exports this one). */
const DEFAULT_BASE_URL = "https://api.anthropic.com"

const toModel = (m: Anthropic.ModelInfo): AnthropicModel | undefined => {
  if (typeof m.id !== "string" || m.id.length === 0 || m.id.length > 100) return undefined
  if (m.lifecycle === "retired") return undefined
  const released = typeof m.created_at === "string" ? Date.parse(m.created_at) : Number.NaN
  return {
    id: m.id,
    label: typeof m.display_name === "string" && m.display_name.trim() !== "" ? m.display_name.trim() : m.id,
    ...(typeof m.max_input_tokens === "number" && m.max_input_tokens > 0 ? { contextTokens: m.max_input_tokens } : {}),
    ...(typeof m.max_tokens === "number" && m.max_tokens > 0 ? { maxOutputTokens: m.max_tokens } : {}),
    ...(m.lifecycle === "active" || m.lifecycle === "deprecated" ? { lifecycle: m.lifecycle } : {}),
    // The API may give the epoch for an unknown date.
    ...(Number.isFinite(released) && released > 0 ? { releasedAt: released } : {})
  }
}

/** The account's models, newest first (the API's order). Interrupting it aborts the request. */
export const listModels = (options: ListModelsOptions): Effect.Effect<ReadonlyArray<AnthropicModel>, AnthropicModelListError> => {
  let secrets: Secrets = []
  const run = Effect.suspend(() => {
    secrets = secretList(Redacted.value(options.apiKey))
    const configured = options.baseURL === undefined || options.baseURL.trim() === "" ? DEFAULT_BASE_URL : options.baseURL
    secrets = secretList(secrets, addressSecrets(configured), addressSecrets(process.env.ANTHROPIC_BASE_URL))
    const address = checkAddress(configured, ADDRESS_RULES)
    if (!address.ok) return Effect.fail(listError(secrets, { reason: "invalid", message: `The Anthropic address ${address.problem}` }))
    const timeoutMs = options.timeoutMs ?? 10_000
    return Effect.tryPromise({
      try: async (signal) => {
        const client = new Anthropic({
          apiKey: Redacted.value(options.apiKey),
          baseURL: address.display,
          timeout: timeoutMs,
          maxRetries: 0,
          // The SDK's own log lines are not wanted here (a failure is reported by the error).
          logLevel: "off",
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {})
        })
        const out: Array<AnthropicModel> = []
        const seen = new Set<string>()
        for await (const m of client.models.list({ limit: 100 }, { signal })) {
          const model = toModel(m)
          if (model === undefined || seen.has(model.id)) continue
          seen.add(model.id)
          out.push(model)
          if (out.length >= MAX_LISTED_MODELS) break
        }
        return out
      },
      catch: (e) => toListError(secrets, e)
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(listError(secrets, { reason: "timeout", message: `Anthropic did not answer the model list within ${timeoutMs} ms` }))
      })
    )
  })
  return run.pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(listError(secrets, { reason: "invalid", message: `The Anthropic model list failed unexpectedly: ${fromUpstream(defect, secrets)}` }))
    )
  )
}

const toListError = (secrets: Secrets, e: unknown): AnthropicModelListError => {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return listError(secrets, { reason: "timeout", message: "Anthropic did not answer the model list in time" })
  if (e instanceof Anthropic.APIConnectionError) {
    const cause = e.cause instanceof Error ? e.cause : e
    return listError(secrets, { reason: "unreachable", message: `Could not reach Anthropic: ${fromUpstream(cause, secrets)}` })
  }
  if (e instanceof Anthropic.APIError) {
    const id = safeId(e.requestID, secrets)
    const requestId = id !== undefined ? ` (request-id ${id})` : ""
    // Fixed text for a refused key: the body of a 401 is where a gateway echoes the key.
    if (e.status === 401 || e.status === 403) return listError(secrets, { reason: "unauthorized", message: `Anthropic rejected the API key (${e.status})${requestId}` })
    if (e.status === 429) {
      const after = Number((e.headers as Headers | undefined)?.get("retry-after"))
      return listError(secrets, {
        reason: "rate_limited",
        message: `Anthropic is rate limiting the model list${requestId}`,
        ...(Number.isFinite(after) && after > 0 ? { retryAfterMs: Math.min(after, 3600) * 1000 } : {})
      })
    }
    return listError(secrets, { reason: "invalid", message: `Anthropic answered ${e.status ?? "an error"} to the model list${requestId}` })
  }
  if (e instanceof SyntaxError) return listError(secrets, { reason: "invalid", message: "Anthropic sent a model list that is not JSON" })
  return listError(secrets, { reason: "unreachable", message: `The Anthropic model list failed: ${fromUpstream(e, secrets)}` })
}

/**
 * The model list's source from the settings (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`), for the picker.
 * `identity` changes with the key or the address (a hash: neither can be read back from it).
 */
export type AnthropicModelSource =
  | { readonly state: "not_set_up"; readonly message: string }
  | {
    readonly state: "ready"
    readonly identity: string
    readonly list: (options: { readonly timeoutMs: number; readonly fetch?: typeof globalThis.fetch }) => Effect.Effect<ReadonlyArray<AnthropicModel>, AnthropicModelListError>
  }

export const modelSource: Effect.Effect<AnthropicModelSource, Config.ConfigError> = Effect.gen(function*() {
  const key = yield* Config.Redacted("ANTHROPIC_API_KEY").pipe(Config.option)
  const baseURL = (yield* Config.String("ANTHROPIC_BASE_URL").pipe(Config.withDefault(DEFAULT_BASE_URL))).trim() || DEFAULT_BASE_URL
  if (key._tag === "None" || Redacted.value(key.value).trim() === "") {
    return { state: "not_set_up", message: "Anthropic API is not set up: add its API key in Shared settings › Language model accounts." } as const
  }
  const apiKey = Redacted.make(Redacted.value(key.value).trim())
  const identity = createHash("sha256").update(`anthropic\u0000${baseURL}\u0000${Redacted.value(apiKey)}`).digest("hex").slice(0, 16)
  return {
    state: "ready",
    identity,
    list: (options) => listModels({ apiKey, baseURL, timeoutMs: options.timeoutMs, ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) })
  } as const
})
