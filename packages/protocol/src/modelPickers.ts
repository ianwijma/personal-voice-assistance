import { Schema } from "effect"
import { HearingEngine, LlmAccountId } from "./assistants.ts"
import { NonNegativeFinite } from "./common.ts"
import { JobInfo } from "./jobs.ts"
import { LocalVoiceState, ProviderIdString } from "./voices.ts"

/**
 * The model pickers' HTTP API (docs/MODEL-PICKERS.md §4): the language models and the speech recognition models an
 * assistant can choose, per provider, with favourites and local downloads. It mirrors the voice picker's API
 * (`voices.ts`, docs/VOICE-PROVIDERS.md §5) so one picker component serves voices and models. Browser-safe; the server
 * encodes its answers with these schemas and the admin UI can decode them.
 */

/** Which picker: the language model (Language model tab) or the speech recognition model (Hearing tab). */
export const PickerKind = Schema.Literals(["llm", "stt"])
export type PickerKind = typeof PickerKind.Type

/** Longest model id (the bound of `AssistantLlm.model`). */
export const MAX_MODEL_ID_CHARS = 100

/**
 * A provider's own model id: 1–100 characters, no control characters, no white space at either end. Ids contain
 * `/`, `:`, `.` and `@` (`anthropic/claude-sonnet-4.5`, `llama3.1:8b`, `openai/gpt-oss-20b:free`).
 */
export const ModelIdString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_MODEL_ID_CHARS),
  Schema.isPattern(/^[^\s\u0000-\u001f\u007f](?:[^\u0000-\u001f\u007f]*[^\s\u0000-\u001f\u007f])?$/)
)

/** One model of one provider. Its key is `provider:modelId` (split at the first `:`). */
export const ModelRefSchema = Schema.Struct({ provider: ProviderIdString, modelId: ModelIdString })
export type ModelRefJson = typeof ModelRefSchema.Type

export const modelKey = (ref: { readonly provider: string; readonly modelId: string }): string => `${ref.provider}:${ref.modelId}`

/** `provider:modelId` → the reference, or `undefined` when either part is not well formed. */
export const parseModelKey = (key: string): ModelRefJson | undefined => {
  const at = key.indexOf(":")
  if (at <= 0) return undefined
  const ref = { provider: key.slice(0, at), modelId: key.slice(at + 1) }
  return Schema.is(ModelRefSchema)(ref) ? ref : undefined
}

/**
 * - `ready`: usable; its list is there (or was not needed).
 * - `needs_key`: a hosted account without its key (`reason`: `missing`, or `vault_locked` while the vault is locked).
 * - `needs_address`: the home model without a server address.
 * - `needs_setup`: the Claude subscription while its module does not run (switched off, not logged in, starting).
 * - `error`: set up, but the list could not be fetched (`message`); older or known models may still be listed, and a
 *   model can be typed (`customModel`).
 */
export const ModelProviderStatus = Schema.Literals(["ready", "needs_key", "needs_address", "needs_setup", "error"])
export type ModelProviderStatus = typeof ModelProviderStatus.Type

export const ModelProviderInfo = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  location: Schema.Literals(["local", "hosted"]),
  status: ModelProviderStatus,
  reason: Schema.optionalKey(Schema.Literals(["missing", "vault_locked"])),
  /** With every status but `ready`: one sentence for people (never a key, never a raw upstream body). */
  message: Schema.optionalKey(Schema.String),
  /** The settings field of its key ("OPENROUTER_API_KEY"). */
  keyField: Schema.optionalKey(Schema.String),
  /** The admin page that sets it up: "shared/accounts", "shared/speech". */
  settingsPath: Schema.String,
  /** The words of that page's link ("Shared settings › Language model accounts"). */
  settingsLabel: Schema.String,
  implication: Schema.optionalKey(Schema.String),
  modelCount: Schema.optionalKey(NonNegativeFinite),
  /**
   * Where the list comes from: `provider` (asked now or cached), `known` (the models this code names, because the
   * provider's list could not be fetched), `built-in` (fixed: the presets on this machine, the offline stand-in).
   */
  listSource: Schema.optionalKey(Schema.Literals(["provider", "known", "built-in"])),
  /** A model may be typed by name (a row "Use a model by name"); absent: only listed models. */
  customModel: Schema.optionalKey(Schema.Struct({ placeholder: Schema.String, help: Schema.String })),
  /** An assistant uses one of its models. */
  inUse: Schema.Boolean
})
export type ModelProviderInfo = typeof ModelProviderInfo.Type

/** A short fact under a row's name, also searched. */
export const ModelBadge = Schema.Struct({
  kind: Schema.Literals(["context", "price", "languages", "memory", "size", "tag"]),
  /** "200k context", "$0.15 / $0.60 per M", "English + Dutch", "1.1 GB memory". */
  label: Schema.String,
  /** A longer form for a tooltip. */
  title: Schema.optionalKey(Schema.String)
})
export type ModelBadge = typeof ModelBadge.Type

/** What choosing the row sets on the assistant (a partial of its `llm` or `hearing`; nothing else). */
export const ModelApply = Schema.Union([
  Schema.Struct({ llm: Schema.Struct({ account: LlmAccountId, model: Schema.String }) }),
  Schema.Struct({ hearing: Schema.Struct({ engine: HearingEngine, model: Schema.optionalKey(Schema.String) }) })
])
export type ModelApply = typeof ModelApply.Type

const AssistantIdString = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/))

export const ModelEntry = Schema.Struct({
  model: ModelRefSchema,
  key: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  badges: Schema.Array(ModelBadge),
  /** Search words besides name, description and badges (the id, aliases). */
  tags: Schema.Array(Schema.String),
  apply: ModelApply,
  /** Language models: what the list says (absent when the provider does not say). */
  llm: Schema.optionalKey(Schema.Struct({
    contextTokens: Schema.optionalKey(NonNegativeFinite),
    maxOutputTokens: Schema.optionalKey(NonNegativeFinite),
    /** US dollars per million tokens. */
    pricing: Schema.optionalKey(Schema.Struct({ inputPerMTok: NonNegativeFinite, outputPerMTok: NonNegativeFinite })),
    deprecated: Schema.optionalKey(Schema.Boolean),
    releasedAt: Schema.optionalKey(NonNegativeFinite)
  })),
  /** Recogniser models. */
  stt: Schema.optionalKey(Schema.Struct({
    /** BCP 47 codes the model is documented to understand (may be a subset: see `languagesLabel`). */
    languages: Schema.Array(Schema.String),
    languagesLabel: Schema.String,
    /** The Hearing tab's language setting applies to it. */
    takesLanguage: Schema.Boolean,
    /** Words appear while you talk. */
    liveWords: Schema.Boolean,
    recommended: Schema.Boolean
  })),
  /** A model on this machine. */
  local: Schema.optionalKey(Schema.Struct({
    state: LocalVoiceState,
    sizeMb: NonNegativeFinite,
    diskMb: NonNegativeFinite,
    /** Measured memory the loaded model adds (stt-sherpa's `ramMb`). */
    ramMb: Schema.optionalKey(NonNegativeFinite),
    loadMs: Schema.optionalKey(NonNegativeFinite),
    job: Schema.optionalKey(JobInfo)
  })),
  /** false: an assistant uses it, but its provider's list does not have it (typed, or gone). */
  listed: Schema.Boolean,
  /** Choosing it now is accepted by an assistant save without an error (a local model must be downloaded). */
  selectable: Schema.Boolean,
  usedBy: Schema.Array(AssistantIdString),
  favourite: Schema.Boolean
})
export type ModelEntry = typeof ModelEntry.Type

export const ProviderModels = Schema.Struct({
  provider: ModelProviderInfo,
  models: Schema.Array(ModelEntry),
  fetchedAt: Schema.optionalKey(NonNegativeFinite),
  stale: Schema.Boolean,
  truncated: Schema.Boolean,
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String }))
})
export type ProviderModels = typeof ProviderModels.Type

/** `GET /api/models/{kind}` */
export const ModelsResponse = Schema.Struct({ kind: PickerKind, providers: Schema.Array(ProviderModels) })
export type ModelsResponse = typeof ModelsResponse.Type

/** `GET /api/models/{kind}/providers` */
export const ModelProvidersResponse = Schema.Struct({ kind: PickerKind, providers: Schema.Array(ModelProviderInfo) })
export type ModelProvidersResponse = typeof ModelProvidersResponse.Type

export const ModelFavourite = Schema.Struct({
  model: ModelRefSchema,
  key: Schema.String,
  name: Schema.String,
  addedAt: NonNegativeFinite
})
export type ModelFavourite = typeof ModelFavourite.Type

/** `GET /api/models/{kind}/favourites`, `DELETE /api/models/{kind}/favourites/{key}` */
export const ModelFavouritesResponse = Schema.Struct({ favourites: Schema.Array(ModelFavourite) })
export type ModelFavouritesResponse = typeof ModelFavouritesResponse.Type

/** `PUT /api/models/{kind}/favourites/{key}` (the request is `FavouriteRequest`, as for voices). */
export const ModelFavouriteResponse = Schema.Struct({ favourite: ModelFavourite, favourites: Schema.Array(ModelFavourite) })
export type ModelFavouriteResponse = typeof ModelFavouriteResponse.Type

/** `POST /api/models/stt/download`, `POST /api/models/stt/download/cancel` */
export const ModelRequest = Schema.Struct({ model: ModelRefSchema })
export type ModelRequest = typeof ModelRequest.Type
