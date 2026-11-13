/**
 * `GET {base}/models`: the model list for the settings screen's model picker,
 * and the reachability check an agent does at start (a wrong address is then a
 * start error on the card, not a failed spoken turn).
 */
import { Effect, Redacted, Schema } from "effect"
import { type ModelInfo, type Profile, type ProfileId, profiles } from "./profiles.ts"
import { errorText } from "./OpenAiCompatibleLlm.ts"

export class ModelListError extends Schema.TaggedError<ModelListError>()("ModelListError", {
  /** One sentence for the owner. */
  message: Schema.String,
  reason: Schema.Literals(["unreachable", "timeout", "unauthorized", "invalid"]),
  cause: Schema.optional(Schema.Defect())
}) {}

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

export const listModels = (options: ListModelsOptions): Effect.Effect<ReadonlyArray<ModelInfo>, ModelListError> => {
  const profile = typeof options.profile === "string" ? profiles[options.profile] : options.profile
  const timeoutMs = options.timeoutMs ?? 2_000
  const fetchFn = options.fetch ?? globalThis.fetch
  const where = `${profile.label} at ${options.baseUrl}`
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchFn(`${options.baseUrl}/models`, {
        headers: {
          authorization: `Bearer ${options.apiKey !== undefined ? Redacted.value(options.apiKey) : "none"}`,
          accept: "application/json"
        },
        signal
      })
      const text = await response.text()
      if (response.status === 401 || response.status === 403) {
        throw new ModelListError({ reason: "unauthorized", message: `${where} rejected the API key (${response.status}): ${errorText(text)}` })
      }
      if (!response.ok) {
        throw new ModelListError({ reason: "invalid", message: `${where} answered ${response.status} to the model list: ${errorText(text)}` })
      }
      let body: unknown
      try {
        body = JSON.parse(text)
      } catch {
        throw new ModelListError({ reason: "invalid", message: `${where} did not answer the model list with JSON (is this the right address?)` })
      }
      const models = parseModelList(profile, body)
      if (models === undefined) throw new ModelListError({ reason: "invalid", message: `${where} sent a model list in an unknown format` })
      return models
    },
    catch: (e) => {
      if (e instanceof ModelListError) return e
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e)
      return new ModelListError({ reason: "unreachable", message: `Could not reach ${where}: ${cause}`, cause: e })
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new ModelListError({ reason: "timeout", message: `${where} did not answer within ${timeoutMs} ms` }))
    })
  )
}
