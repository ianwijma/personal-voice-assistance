import { Effect, Schema } from "effect"
import { ActionError, type ActionOutcome, actionToolName, type RegisteredAction } from "./Actions.ts"
import { ToolError } from "./Errors.ts"
import { riskOf, type Tool, type ToolLatency, type ToolRisk, type ToolSensitivity } from "./Module.ts"
import { CurrentTurn, type TurnContext, type TurnPerson } from "./TurnContext.ts"

/**
 * The execution gateway (docs/MODULES-PLAN.md §4 P1): the one way a tool's `execute` or an action's `run` is reached.
 * A model's tool call (core's tool loop, through `ToolRegistry.run`), the Claude Code bridge (the same registry),
 * the intent agent and a confirmed action (`ToolRegistry.runAction`), and a module's `host.actions.run` all come
 * here; later a phrase command, a tap on a presentation and a routine step do too.
 *
 * For every call it resolves who is asking from `CurrentTurn` (assistant, device, person), validates the input, works
 * out the call's risk, sensitivity and latency, and admits it or refuses it, checking in this order:
 *
 * 1. the assistant has the module on (`GatewayAccess.moduleOn`);
 * 2. the tool is not in the assistant's `offTools` (`GatewayAccess.toolOff`);
 * 3. the risk policy (`GatewayOptions.risk`, empty until P8);
 * 4. confirmation (`GatewayOptions.confirmation`, empty until P8).
 *
 * The first refusal wins and nothing is run. A call outside a turn (or with a turn that names no assistant: the CLI
 * modes) skips checks 1 and 2; the hooks always run. **Adding a check (later PRs):** fill the `risk` or
 * `confirmation` hook where the gateway is made (`makeExecutionGateway`, given to the module host by serve mode); a
 * new kind of check is one more optional hook in `GatewayOptions`, placed in `admit`'s order.
 */

/** Which modules and tools an assistant has on (serve mode: its `modules` choices). */
export interface GatewayAccess {
  /** The assistant has the module on (modules that are not per assistant, agents and deciders, are always on). */
  readonly moduleOn: (assistantId: string, moduleId: string) => boolean
  /** The tool (an action's generated tool name for an action) is switched off for the assistant. */
  readonly toolOff: (assistantId: string, moduleId: string, toolName: string) => boolean
}

/** One call, as the checks see it. */
export interface GatewayCall {
  readonly kind: "tool" | "action"
  /** The turn it belongs to; `undefined` outside a turn. */
  readonly turn: TurnContext | undefined
  readonly assistantId: string | undefined
  readonly deviceId: string | undefined
  readonly person: TurnPerson | undefined
  /** The module it belongs to; `undefined` for a tool of a hand-made registry. */
  readonly moduleId: string | undefined
  /** The tool's name; for an action, its generated tool's name (`<moduleId>_<actionId>`, as `offTools` names it). */
  readonly name: string
  readonly action?: RegisteredAction
  /** The validated tool input, or the values an action's `run` receives. */
  readonly input: unknown
  readonly risk: ToolRisk
  readonly sensitivity: ToolSensitivity
  readonly latency: ToolLatency
  /** The owner already said yes (a confirmed action): the confirmation hook may let it through. */
  readonly confirmed: boolean
}

export type GatewayDecision = { readonly _tag: "Allow" } | { readonly _tag: "Refuse"; readonly reason: string }

/** The `cause` of the `ToolError` / `ActionError` of a call the gateway did not admit. */
export class GatewayRefused extends Schema.TaggedError<GatewayRefused>()("GatewayRefused", { reason: Schema.String }) {}

/** Whether an error is the gateway's refusal (not a failure of the tool or action itself). */
export const isGatewayRefusal = (error: { readonly cause?: unknown }): boolean => error.cause instanceof GatewayRefused

export const ALLOW: GatewayDecision = { _tag: "Allow" }
export const refuse = (reason: string): GatewayDecision => ({ _tag: "Refuse", reason })

/** A check of the gateway after the access checks. Must not fail; must be fast (it runs on every call). */
export type GatewayHook = (call: GatewayCall) => Effect.Effect<GatewayDecision>

export interface GatewayOptions {
  /** Absent: the access checks are skipped (tests, the CLI modes). */
  readonly access?: GatewayAccess
  /** Check 3, the risk policy (P8). */
  readonly risk?: GatewayHook
  /** Check 4, confirmation (P8). */
  readonly confirmation?: GatewayHook
}

export interface ExecutionGateway {
  /** The checks, in order, for one call. */
  readonly admit: (call: GatewayCall) => Effect.Effect<GatewayDecision>
  /**
   * Run a tool: validate `input` (its JSON form, as a model sends it) with the tool's schema, admit the call, run
   * `execute`. Invalid input and refusals are `ToolError`s ("Invalid input: …", "Not run: …").
   */
  readonly tool: (moduleId: string | undefined, tool: Tool, input: unknown) => Effect.Effect<unknown, ToolError>
  /** Run an action with its values (what `run` receives): admit the call, run `run`. A refusal is an `ActionError`. */
  readonly action: (
    action: RegisteredAction,
    values: Readonly<Record<string, unknown>>,
    options?: { readonly confirmed?: boolean }
  ) => Effect.Effect<ActionOutcome | void, ActionError>
}

const decoders = new WeakMap<Tool, (u: unknown) => Effect.Effect<unknown, Schema.SchemaError>>()
/** The tool's input decoder (the JSON Schema sent to the model describes the canonical JSON form), made once per tool. */
const decoderOf = (tool: Tool) => {
  let decode = decoders.get(tool)
  if (decode === undefined) {
    decode = Schema.decodeUnknownEffect(Schema.toCodecJson(tool.parameters))
    decoders.set(tool, decode)
  }
  return decode
}

export const makeExecutionGateway = (options: GatewayOptions = {}): ExecutionGateway => {
  const admit = (call: GatewayCall): Effect.Effect<GatewayDecision> =>
    Effect.suspend(() => {
      const access = options.access
      if (access !== undefined && call.assistantId !== undefined && call.moduleId !== undefined) {
        if (!access.moduleOn(call.assistantId, call.moduleId)) return Effect.succeed(refuse(`the ${call.moduleId} module is not on for this assistant.`))
        if (access.toolOff(call.assistantId, call.moduleId, call.name)) return Effect.succeed(refuse(`${call.name} is switched off for this assistant.`))
      }
      const hooks = [options.risk, options.confirmation].filter((h): h is GatewayHook => h !== undefined)
      if (hooks.length === 0) return Effect.succeed(ALLOW)
      return Effect.gen(function*() {
        for (const hook of hooks) {
          const decision = yield* hook(call)
          if (decision._tag !== "Allow") return decision
        }
        return ALLOW
      })
    })

  /** The call with its turn and metadata resolved; a risk function that throws is a refusal (`Left`). */
  const callOf = (
    base: Pick<GatewayCall, "kind" | "moduleId" | "name" | "input" | "confirmed"> & { readonly action?: RegisteredAction },
    meta: { readonly risk?: unknown; readonly sensitivity?: ToolSensitivity; readonly latency?: ToolLatency; readonly speculative?: boolean | undefined },
    turn: TurnContext | undefined
  ): GatewayCall | string => {
    let risk: ToolRisk
    try {
      risk = riskOf(meta as Parameters<typeof riskOf>[0], base.input)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return {
      ...base,
      turn,
      assistantId: turn?.assistantId,
      deviceId: turn?.deviceId,
      person: turn?.person,
      risk,
      sensitivity: meta.sensitivity ?? "household",
      latency: meta.latency ?? "quick"
    }
  }

  const tool: ExecutionGateway["tool"] = (moduleId, t, raw) =>
    Effect.gen(function*() {
      const input = yield* decoderOf(t)(raw).pipe(Effect.mapError((error) => new ToolError({ message: `Invalid input: ${error.message}` })))
      const turn = yield* CurrentTurn
      const call = callOf({ kind: "tool", moduleId, name: t.name, input, confirmed: false, ...(t.action !== undefined ? { action: t.action } : {}) }, t, turn)
      if (typeof call === "string") return yield* new ToolError({ message: `Not run: ${call}`, cause: new GatewayRefused({ reason: call }) })
      const decision = yield* admit(call)
      if (decision._tag === "Refuse") return yield* new ToolError({ message: `Not run: ${decision.reason}`, cause: new GatewayRefused({ reason: decision.reason }) })
      // Suspended: a tool that throws while building its effect is a defect, as before.
      return yield* Effect.suspend(() => t.execute(input))
    })

  const action: ExecutionGateway["action"] = (registered, values, actionOptions = {}) =>
    Effect.gen(function*() {
      const def = registered.definition
      const turn = yield* CurrentTurn
      const call = callOf(
        {
          kind: "action",
          moduleId: registered.moduleId,
          name: actionToolName(registered.moduleId, def.id),
          input: values,
          confirmed: actionOptions.confirmed === true,
          action: registered
        },
        def,
        turn
      )
      if (typeof call === "string") return yield* new ActionError({ message: `Not run: ${call}`, cause: new GatewayRefused({ reason: call }) })
      const decision = yield* admit(call)
      if (decision._tag === "Refuse") return yield* new ActionError({ message: `Not run: ${decision.reason}`, cause: new GatewayRefused({ reason: decision.reason }) })
      return yield* Effect.suspend(() => def.run(values as never))
    })

  return { admit, tool, action }
}

/** The gateway of a registry made without one (tests, hand-made registries): no access checks, no hooks. */
export const defaultGateway: ExecutionGateway = makeExecutionGateway()
