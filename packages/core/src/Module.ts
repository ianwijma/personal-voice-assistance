import type { Effect, Schema } from "effect"
import type { ToolError } from "./Errors.ts"

/** Something the model can call. */
export interface Tool<I = any, R = never> {
  readonly name: string
  readonly description: string
  /** Validated input; also the source of the JSON Schema sent to the model. */
  readonly parameters: Schema.Codec<I, unknown>
  /** Safe to run before the turn is confirmed (read-only lookups). Default `false`. */
  readonly speculative?: boolean
  readonly execute: (input: I) => Effect.Effect<unknown, ToolError, R>
}

/** Facts sent with each turn as `LlmRequest.context` (not part of the cached system prompt). Must be fast: cached or local. */
export interface ContextProvider {
  readonly name: string
  readonly get: Effect.Effect<string>
}

/** A capability: a named bundle of tools and context providers. */
export interface AssistantModule {
  readonly name: string
  readonly tools?: ReadonlyArray<Tool>
  readonly context?: ReadonlyArray<ContextProvider>
}

/** Identity helper that infers `I` from the `parameters` schema. */
export const makeTool = <S extends Schema.Codec<any, unknown>>(tool: {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly speculative?: boolean
  readonly execute: (input: S["Type"]) => Effect.Effect<unknown, ToolError>
}): Tool<S["Type"]> => tool
