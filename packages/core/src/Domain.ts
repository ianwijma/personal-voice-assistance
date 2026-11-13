/** Events produced by `Stt`, including turn detection. */
export type SttEvent =
  | { readonly _tag: "SpeechStarted" }
  | { readonly _tag: "Interim"; readonly text: string }
  | { readonly _tag: "EagerEndOfTurn"; readonly text: string }
  | { readonly _tag: "TurnResumed" }
  | { readonly _tag: "EndOfTurn"; readonly text: string }

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface ToolResult {
  readonly id: string
  readonly name: string
  /** Text returned to the model (JSON for structured results). */
  readonly content: string
  readonly isError: boolean
}

/**
 * Conversation history. Tool results get their own role; adapters map them to
 * whatever the provider expects (for Anthropic: a user message with
 * `tool_result` blocks).
 */
export type Message =
  | { readonly role: "user"; readonly content: string }
  | {
    readonly role: "assistant"
    readonly content: string
    readonly toolCalls?: ReadonlyArray<ToolCall>
    /** The user barged in; `content` is only what was actually played. */
    readonly interrupted?: boolean
    /** The agent that said it (absent in single-model conversations and history from before agents). */
    readonly agentId?: string
  }
  | { readonly role: "tool"; readonly results: ReadonlyArray<ToolResult> }

export interface ToolSpec {
  readonly name: string
  readonly description: string
  /** JSON Schema (draft 2020-12) of the tool input. */
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface LlmRequest {
  /** Stable instructions. Identical across turns so adapters can cache it. */
  readonly system: string
  /**
   * Per-turn facts from context providers (current time, ...). Changes between
   * turns, so adapters must place it after any cached prefix.
   */
  readonly context?: string
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<ToolSpec>
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "other"

export type LlmEvent =
  | { readonly _tag: "TextDelta"; readonly text: string }
  | { readonly _tag: "ToolCall"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly _tag: "Done"; readonly stopReason: StopReason }
