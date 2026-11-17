import { Schema } from "effect"

const fields = { message: Schema.String, cause: Schema.optional(Schema.Defect()) }

export class AudioError extends Schema.TaggedError<AudioError>()("AudioError", fields) {}
export class SttError extends Schema.TaggedError<SttError>()("SttError", fields) {}
export class LlmError extends Schema.TaggedError<LlmError>()("LlmError", fields) {}
export class TtsError extends Schema.TaggedError<TtsError>()("TtsError", fields) {}
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", fields) {}

/**
 * Listing or previewing a provider's voices failed (docs/VOICE-PROVIDERS.md §7.2). `message` is for people and
 * never holds a credential (adapters build it through their `redact.ts`).
 */
export class VoiceCatalogError extends Schema.TaggedError<VoiceCatalogError>()("VoiceCatalogError", {
  reason: Schema.Literals(["unauthorized", "rate_limited", "unknown_voice", "not_installed", "unavailable", "invalid"]),
  message: Schema.String,
  /** With `rate_limited`, when the provider said. */
  retryAfterMs: Schema.optional(Schema.Finite),
  cause: Schema.optional(Schema.Defect())
}) {}
