import type { ToolLatency, ToolRisk, ToolSensitivity } from "@pva/protocol"
import type { Effect, Schema } from "effect"
import type { RegisteredAction } from "./Actions.ts"
import type { ToolError } from "./Errors.ts"

export type { ToolLatency, ToolRisk, ToolSensitivity }

/**
 * A risk class that depends on the validated input, with every class it can return (`classes`, non-empty). The list
 * is what the wire carries (`ToolInfo.risks`) and what a policy (P8) uses to leave a tool out of a list; a call whose
 * `of` returns a class outside it is refused.
 */
export interface RiskByInput<I = any> {
  readonly classes: ReadonlyArray<ToolRisk>
  readonly of: (input: I) => ToolRisk
}

/**
 * Whose a result is (docs/MODULES-PLAN.md §2 row 8): the household's, or one person's (`owner`: a person id, or
 * `"unknown"`, which is treated as someone else's).
 */
export type Sensitivity = { readonly kind: "household" } | { readonly kind: "personal"; readonly owner: string }

/** The owner of personal content that names nobody. */
export const UNKNOWN_OWNER = "unknown"

/**
 * What a tool or an action may do and how it behaves (docs/MODULES-PLAN.md §2 row 5, module-definition §B.5). All
 * optional; a missing value is inferred: `risk` is `read` for a speculative tool and `change` for any other,
 * `sensitivity` is `household`, `latency` is `quick`. The execution gateway resolves them for every call
 * (`Gateway.ts`) and carries them to its hooks; a risk policy (P8) enforces them.
 */
export interface ToolMetadata<I = any> {
  /**
   * `read` lookups, `change` lights/music/timers, `message` as the owner, `money` purchases, `security` locks and
   * alarms. A class, or (`RiskByInput`) a function of the validated input together with the classes it can return
   * (a cover tool declares `change` and `security`: a blind is `change`, a garage door `security`). A function that
   * throws, or returns a class it did not declare, makes the call refused.
   */
  readonly risk?: ToolRisk | RiskByInput<I>
  /**
   * Whose the result is. `household` (default); `personal` (owner unknown) or a `Sensitivity` naming the owner; or a
   * function deciding it per result (`sensitivityOf`).
   */
  readonly sensitivity?: "household" | "personal" | Sensitivity | ((result: unknown) => Sensitivity)
  /** `instant` < 50 ms, `quick` < 1 s, `slow` seconds, `background` it starts work that reports later. */
  readonly latency?: ToolLatency
}

const inferredRisk = (tool: { readonly speculative?: boolean | undefined }): ToolRisk => (tool.speculative === true ? "read" : "change")

/**
 * The metadata of a tool or action as it can be shown without an input: `risk` is the fixed class (`undefined` when
 * it depends on the input), `risks` every class a call can have, `sensitivity` its wire form (`per-result` for a
 * function).
 */
export const toolMetadata = (
  tool: ToolMetadata & { readonly speculative?: boolean | undefined }
): {
  readonly risk: ToolRisk | undefined
  readonly risks: ReadonlyArray<ToolRisk>
  readonly sensitivity: ToolSensitivity
  readonly latency: ToolLatency
} => {
  const risk = tool.risk
  const fixed = risk === undefined ? inferredRisk(tool) : typeof risk === "string" ? risk : undefined
  const s = tool.sensitivity
  return {
    risk: fixed,
    risks: fixed !== undefined ? [fixed] : [...new Set((risk as RiskByInput).classes)],
    sensitivity: s === undefined || s === "household" ? "household" : typeof s === "function" ? "per-result" : s === "personal" || s.kind === "personal" ? "personal" : "household",
    latency: tool.latency ?? "quick"
  }
}

/**
 * Why a tool's or action's metadata cannot be used (checked when a module starts), or `undefined`: a risk function
 * must come with a non-empty list of valid classes.
 */
export const metadataProblem = (name: string, tool: ToolMetadata): string | undefined => {
  const risk = tool.risk as unknown
  if (risk === undefined || typeof risk === "string") return undefined
  if (typeof risk === "function") return `${name}: a risk that depends on the input must declare the classes it can return ({ classes, of })`
  const r = risk as Partial<RiskByInput>
  if (typeof r.of !== "function" || !Array.isArray(r.classes) || r.classes.length === 0) return `${name}: risk needs a non-empty \`classes\` list and an \`of\` function`
  const bad = r.classes.find((c) => !RISK_CLASSES.includes(c))
  return bad === undefined ? undefined : `${name}: "${String(bad)}" is not a risk class`
}

const RISK_CLASSES: ReadonlyArray<ToolRisk> = ["read", "change", "message", "money", "security"]

/**
 * The risk class of one call: the declared class, the function's answer for this input, or the inferred class.
 * Throws what the function throws, and when it returns a class it did not declare.
 */
export const riskOf = <I>(tool: ToolMetadata<I> & { readonly speculative?: boolean | undefined }, input: I): ToolRisk => {
  const risk = tool.risk
  if (risk === undefined) return inferredRisk(tool)
  if (typeof risk === "string") return risk
  const answer = risk.of(input)
  if (!risk.classes.includes(answer)) throw new Error(`its risk was "${String(answer)}", which it does not declare (${risk.classes.join(", ")})`)
  return answer
}

/** The declared sensitivity before a call: fixed, or `per-result` (decided by `sensitivityOf` on the result). */
export const declaredSensitivity = (tool: ToolMetadata): Sensitivity | "per-result" => {
  const s = tool.sensitivity
  if (s === undefined || s === "household") return { kind: "household" }
  if (s === "personal") return { kind: "personal", owner: UNKNOWN_OWNER }
  if (typeof s === "function") return "per-result"
  return s
}

/**
 * The sensitivity of one result: the fixed one, or what the tool's function says about it. A function that throws or
 * answers nonsense makes the result `personal` with an unknown owner (the strictest).
 */
export const sensitivityOf = (tool: ToolMetadata, result: unknown): Sensitivity => {
  const declared = declaredSensitivity(tool)
  if (declared !== "per-result") return declared
  try {
    const s = (tool.sensitivity as (result: unknown) => Sensitivity)(result)
    if (s?.kind === "household") return s
    if (s?.kind === "personal" && typeof s.owner === "string" && s.owner.length > 0) return s
  } catch {
    // The strictest below.
  }
  return { kind: "personal", owner: UNKNOWN_OWNER }
}

/** Something the model can call. */
export interface Tool<I = any, R = never> extends ToolMetadata<I> {
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
  /**
   * Actions for intent agents that are not offered as tools (`offerAsTool: false`, and the stand-ins of an
   * unavailable module's declared actions). The actions of generated action tools are found through `tools`.
   */
  readonly intentActions?: ReadonlyArray<RegisteredAction>
}

/** Identity helper that infers `I` from the `parameters` schema. */
export const makeTool = <S extends Schema.Codec<any, unknown>>(tool: ToolMetadata<S["Type"]> & {
  readonly name: string
  readonly description: string
  readonly parameters: S
  readonly speculative?: boolean
  readonly execute: (input: S["Type"]) => Effect.Effect<unknown, ToolError>
}): Tool<S["Type"]> => tool
