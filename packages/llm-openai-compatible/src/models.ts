/**
 * `GET {base}/models`: the model list for the settings screen's model picker,
 * and the reachability check an agent does at start (a wrong address is then a
 * start error on the card, not a failed spoken turn).
 */
import { Effect, Redacted, Schema } from "effect"
import { type ModelInfo, type Profile, type ProfileId, profiles } from "./profiles.ts"
import { errorText } from "./OpenAiCompatibleLlm.ts"
import { addressSecrets, checkAddress, fromUpstream, sanitize, type Secrets, secretList } from "./redact.ts"

export class ModelListError extends Schema.TaggedError<ModelListError>()("ModelListError", {
  /** One sentence for the owner. */
  message: Schema.String,
  reason: Schema.Literals(["unreachable", "timeout", "unauthorized", "invalid"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** The only way a `ModelListError` is made: message and cause sanitised (see `redact.ts`). */
const modelListError = (secrets: Secrets, fields: ConstructorParameters<typeof ModelListError>[0]): ModelListError =>
  new ModelListError(sanitize(secrets, fields))

export interface ListModelsOptions {
  readonly profile: Profile | ProfileId
  readonly baseUrl: string
  readonly apiKey?: Redacted.Redacted<string> | undefined
  /** Default 2000 ms. */
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
}

const isRecord = (u: unknown): u is Readonly<Record<string, unknown>> => typeof u === "object" && u !== null && !Array.isArray(u)

/** Parse a `/models` body: `{ data: [...] }` (OpenAI shape) or `{ models: [...] }`; entries filtered by the profile. */
export const parseModelList = (profile: Profile, body: unknown): ReadonlyArray<ModelInfo> | undefined => {
  if (!isRecord(body)) return undefined
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : undefined
  if (list === undefined) return undefined
  const seen = new Set<string>()
  const models: Array<ModelInfo> = []
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const model = profile.parseModel(raw.id === undefined && typeof raw.model === "string" ? { ...raw, id: raw.model } : raw)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/** The rules for a configured base address: http(s), no user-info, no query (see `redact.ts`, `checkAddress`). */
export const ADDRESS_RULES = { protocols: ["http:", "https:"], query: false } as const

export const listModels = (options: ListModelsOptions): Effect.Effect<ReadonlyArray<ModelInfo>, ModelListError> => {
  // Filled before anything that can fail reads the options; a getter that throws leaves what is known.
  let secrets: Secrets = []
  const run = Effect.suspend(() => {
    secrets = secretList(options.apiKey !== undefined ? Redacted.value(options.apiKey) : undefined)
    secrets = secretList(secrets, addressSecrets(options.baseUrl))
    const profile = typeof options.profile === "string" ? profiles[options.profile] : options.profile
    const timeoutMs = options.timeoutMs ?? 2_000
    const fetchFn = options.fetch ?? globalThis.fetch
    const address = checkAddress(options.baseUrl, ADDRESS_RULES)
    if (!address.ok) {
      return Effect.fail(modelListError(secrets, { reason: "invalid", message: `The ${profile.label} address ${address.problem}` }))
    }
    // The credential-free form is the only one any message, or the request, uses.
    const base = address.display
    const where = `${profile.label} at ${base}`
    const authorization = `Bearer ${options.apiKey !== undefined ? Redacted.value(options.apiKey) : "none"}`
    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchFn(`${base}/models`, { headers: { authorization, accept: "application/json" }, signal })
        const text = await response.text()
        if (response.status === 401 || response.status === 403) {
          // Fixed text: the body of a 401 is where a gateway echoes the submitted key back.
          throw modelListError(secrets, { reason: "unauthorized", message: `${where} rejected the API key (${response.status})` })
        }
        if (!response.ok) {
          throw modelListError(secrets, { reason: "invalid", message: `${where} answered ${response.status} to the model list: ${errorText(text, secrets)}` })
        }
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          throw modelListError(secrets, { reason: "invalid", message: `${where} did not answer the model list with JSON (is this the right address?)` })
        }
        const models = parseModelList(profile, body)
        if (models === undefined) throw modelListError(secrets, { reason: "invalid", message: `${where} sent a model list in an unknown format` })
        return models
      },
      catch: (e) => {
        if (e instanceof ModelListError) return modelListError(secrets, { reason: e.reason, message: e.message, cause: e.cause })
        const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e
        return modelListError(secrets, { reason: "unreachable", message: `Could not reach ${where}: ${fromUpstream(cause, secrets)}`, cause: e })
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(modelListError(secrets, { reason: "timeout", message: `${where} did not answer within ${timeoutMs} ms` }))
      })
    )
  })
  // The last resort: anything unexpected (a defect, a getter that throws) leaves as a sanitised `ModelListError`.
  return run.pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(modelListError(secrets, { reason: "invalid", message: `The model list failed unexpectedly: ${fromUpstream(defect, secrets)}`, cause: defect }))
    ),
    Effect.mapError((e) => modelListError(secrets, { reason: e.reason, message: e.message, cause: e.cause }))
  )
}
