import type { ToolLatency, ToolRisk, ToolSensitivity } from "@pva/protocol"
import type { Effect, Schema } from "effect"
import type { RegisteredAction } from "./Actions.ts"
import type { ToolError } from "./Errors.ts"

export type { ToolLatency, ToolRisk, ToolSensitivity }

/**
 * What a tool or an action may do and how it behaves (docs/MODULES-PLAN.md §2 row 5, module-definition §B.5). All
 * optional; a missing value is inferred (`toolMetadata`): `risk` is `read` for a speculative tool and `change` for
 * any other, `sensitivity` is `normal`, `latency` is `quick`. Module API v2 carries and shows them; a risk policy
 * (P10) enforces them.
 */
export interface ToolMetadata {
  /** `read` lookups, `change` lights/music/timers, `message` as the owner, `money` purchases, `security` locks and alarms. */
  readonly risk?: ToolRisk
  /** `personal`: the result is about a person (mail, calendar, memories). */
  readonly sensitivity?: ToolSensitivity
  /** `instant` < 50 ms, `quick` < 1 s, `slow` seconds, `background` it starts work that reports later. */
  readonly latency?: ToolLatency
}

/** The metadata of a tool or action with every inferred value filled in. */
export const toolMetadata = (
  tool: ToolMetadata & { readonly speculative?: boolean | undefined }
): { readonly risk: ToolRisk; readonly sensitivity: ToolSensitivity; readonly latency: ToolLatency } => ({
  risk: tool.risk ?? (tool.speculative === true ? "read" : "change"),
  sensitivity: tool.sensitivity ?? "normal",
  latency: tool.latency ?? "quick"
})

/** Something the model can call. */
export interface Tool<I = any, R = never> extends ToolMetadata {
  readonly name: string
  readonly description: string
  /** Validated input; also the source of the JSON Schema sent to the model. */
  readonly parameters: Schema.Codec<I, unknown>
  /** Safe to run before the turn is confirmed (read-only lookups). Default `false`. */
  readonly speculative?: boolean
  /** Read the turn it runs in with `yield* CurrentTurn` (`TurnContext.ts`); `undefined` outside a turn. */
  readonly execute: (input: I) => Effect.Effect<unknown, ToolError, R>
  /** The action this tool was generated for (`actionTool`), so core can apply the action's confirmation rule. */
  readonly action?: RegisteredAction
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
export const makeTool = <S extends Schema.Codec<any, unknown>>(tool: ToolMetadata & {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly speculative?: boolean
  readonly execute: (input: S["Type"]) => Effect.Effect<unknown, ToolError>
}): Tool<S["Type"]> => tool
