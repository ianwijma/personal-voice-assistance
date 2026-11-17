import { Schema } from "effect"
import { NonNegativeFinite } from "./common.ts"
import { DeviceUser } from "./deviceUsers.ts"
import { JobInfo } from "./jobs.ts"

/**
 * The voice picker's HTTP API (docs/VOICE-PROVIDERS.md §5): providers, their voices, previews, local downloads,
 * favourites and the assistant's voice. Browser-safe; the server encodes its answers with these schemas and the
 * admin UI can decode them.
 */

export const API_PREFIX = "/api/"
/** Longest preview text, characters (after trimming). */
export const MAX_PREVIEW_CHARS = 300
/** Longest preview audio, seconds. */
export const MAX_PREVIEW_SECONDS = 30
/** At most this many favourites. */
export const MAX_FAVOURITES = 200
/** Longest favourite name. */
export const MAX_FAVOURITE_NAME_CHARS = 100
/** Largest request body, bytes. */
export const MAX_API_BODY_BYTES = 4096

export const ProviderIdString = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/))
export const VoiceIdString = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))

/** An assistant id (the pattern of `AssistantId`, repeated here: `assistants.ts` imports this file). */
const AssistantIdString = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/))

/** One voice of one provider. */
export const VoiceRefSchema = Schema.Struct({ provider: ProviderIdString, voiceId: VoiceIdString })
export type VoiceRefJson = typeof VoiceRefSchema.Type

export const ProviderStatus = Schema.Literals(["ready", "needs_key", "error"])
export type ProviderStatus = typeof ProviderStatus.Type

export const ProviderInfo = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  location: Schema.Literals(["local", "hosted"]),
  status: ProviderStatus,
  reason: Schema.optionalKey(Schema.Literals(["missing", "vault_locked"])),
  message: Schema.optionalKey(Schema.String),
  keyField: Schema.optionalKey(Schema.String),
  settingsPath: Schema.String,
  implication: Schema.optionalKey(Schema.String),
  voiceCount: Schema.optionalKey(NonNegativeFinite),
  /** An assistant speaks with a voice of this provider. */
  inUse: Schema.Boolean
})
export type ProviderInfo = typeof ProviderInfo.Type

export const LocalVoiceState = Schema.Literals(["installed", "not_installed", "downloading"])
export type LocalVoiceState = typeof LocalVoiceState.Type

export const VoiceEntry = Schema.Struct({
  voice: VoiceRefSchema,
  key: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String),
  gender: Schema.optionalKey(Schema.Literals(["female", "male", "neutral"])),
  tags: Schema.Array(Schema.String),
  local: Schema.optionalKey(Schema.Struct({
    state: LocalVoiceState,
    sizeMb: NonNegativeFinite,
    diskMb: NonNegativeFinite,
    job: Schema.optionalKey(JobInfo)
  })),
  previewable: Schema.Boolean,
  /** Protocol 7: the assistants that speak with this voice (replaces `selected`). */
  usedBy: Schema.Array(AssistantIdString),
  /**
   * Additive: the devices (and device types' defaults) that speak with this voice as their own (`voice: { from:
   * "device" }`), from their effective settings. `usedBy` stays the assistants. Absent from an older server.
   */
  usedByDevices: Schema.optionalKey(Schema.Array(DeviceUser)),
  favourite: Schema.Boolean
})
export type VoiceEntry = typeof VoiceEntry.Type

export const ApiErrorInfo = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryAfterMs: Schema.optionalKey(NonNegativeFinite),
  fieldErrors: Schema.optionalKey(Schema.Array(Schema.Struct({ key: Schema.String, message: Schema.String })))
})
export type ApiErrorInfo = typeof ApiErrorInfo.Type

/** The body of every non-2xx JSON answer. */
export const ApiErrorBody = Schema.Struct({ error: ApiErrorInfo })
export type ApiErrorBody = typeof ApiErrorBody.Type

export const ProviderVoices = Schema.Struct({
  provider: ProviderInfo,
  voices: Schema.Array(VoiceEntry),
  fetchedAt: Schema.optionalKey(NonNegativeFinite),
  stale: Schema.Boolean,
  truncated: Schema.Boolean,
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String }))
})
export type ProviderVoices = typeof ProviderVoices.Type

/** `GET /api/voice-providers` */
export const ProvidersResponse = Schema.Struct({ providers: Schema.Array(ProviderInfo) })
export type ProvidersResponse = typeof ProvidersResponse.Type

/** `GET /api/voices` */
export const VoicesResponse = Schema.Struct({ providers: Schema.Array(ProviderVoices), selected: Schema.String })
export type VoicesResponse = typeof VoicesResponse.Type

/** `POST /api/voices/preview` (answer: `audio/wav`). */
export const PreviewRequest = Schema.Struct({
  voice: VoiceRefSchema,
  text: Schema.String.check(Schema.isMaxLength(MAX_PREVIEW_CHARS * 4))
})
export type PreviewRequest = typeof PreviewRequest.Type

/** `POST /api/voices/download`, `POST /api/voices/download/cancel` */
export const VoiceRequest = Schema.Struct({ voice: VoiceRefSchema })
export type VoiceRequest = typeof VoiceRequest.Type

/** `POST /api/voices/download` (202), `GET /api/jobs/{id}` */
export const JobResponse = Schema.Struct({ job: JobInfo })
export type JobResponse = typeof JobResponse.Type

/** `POST /api/voices/download/cancel` */
export const CancelResponse = Schema.Struct({ cancelled: Schema.Literal(true), job: JobInfo })
export type CancelResponse = typeof CancelResponse.Type

export const Favourite = Schema.Struct({
  voice: VoiceRefSchema,
  key: Schema.String,
  name: Schema.String,
  addedAt: NonNegativeFinite
})
export type Favourite = typeof Favourite.Type

/** `GET /api/voices/favourites`, `DELETE /api/voices/favourites/{key}` */
export const FavouritesResponse = Schema.Struct({ favourites: Schema.Array(Favourite) })
export type FavouritesResponse = typeof FavouritesResponse.Type

/** `PUT /api/voices/favourites/{key}` */
export const FavouriteRequest = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_FAVOURITE_NAME_CHARS)))
})
export type FavouriteRequest = typeof FavouriteRequest.Type
export const FavouriteResponse = Schema.Struct({ favourite: Favourite, favourites: Schema.Array(Favourite) })
export type FavouriteResponse = typeof FavouriteResponse.Type

export const DefaultVoice = Schema.Struct({
  voice: VoiceRefSchema,
  key: Schema.String,
  name: Schema.optionalKey(Schema.String),
  /** `assistant` (protocol 7): the first assistant's voice; `PUT /api/voices/default` is gone (the assistant's Voice tab saves it). */
  source: Schema.Literals(["saved", "environment", "migrated", "default", "assistant"]),
  locked: Schema.Boolean,
  running: Schema.optionalKey(Schema.String),
  reloadPending: Schema.Boolean,
  notes: Schema.Array(Schema.String)
})
export type DefaultVoice = typeof DefaultVoice.Type

/** `GET /api/voices/default` */
export const DefaultVoiceResponse = Schema.Struct({ default: DefaultVoice })
export type DefaultVoiceResponse = typeof DefaultVoiceResponse.Type

/** `PUT /api/voices/default` */
export const DefaultVoiceRequest = Schema.Struct({ voice: VoiceRefSchema, reload: Schema.optionalKey(Schema.Boolean) })
export type DefaultVoiceRequest = typeof DefaultVoiceRequest.Type
export const DefaultVoiceSaved = Schema.Struct({
  default: DefaultVoice,
  reload: Schema.optionalKey(Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true) }),
    Schema.Struct({ ok: Schema.Literal(false), code: Schema.String, message: Schema.String })
  ]))
})
export type DefaultVoiceSaved = typeof DefaultVoiceSaved.Type
