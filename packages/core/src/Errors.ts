import { Schema } from "effect"

const fields = { message: Schema.String, cause: Schema.optional(Schema.Defect()) }

export class AudioError extends Schema.TaggedError<AudioError>()("AudioError", fields) {}
export class SttError extends Schema.TaggedError<SttError>()("SttError", fields) {}
export class LlmError extends Schema.TaggedError<LlmError>()("LlmError", fields) {}
export class TtsError extends Schema.TaggedError<TtsError>()("TtsError", fields) {}
export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", fields) {}
