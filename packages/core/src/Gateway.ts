import { Effect, Schema } from "effect"
import { ActionError, type ActionOutcome, actionToolName, actionValues, type RegisteredAction, runActionForTool } from "./Actions.ts"
import { ToolError } from "./Errors.ts"
import { declaredSensitivity, riskOf, type Sensitivity, type Tool, type ToolLatency, type ToolMetadata, type ToolRisk } from "./Module.ts"
import {
  type ConnectionRef,
  CurrentJob,
  CurrentTurn,
  LOCAL_PRINCIPAL,
  type Principal,
  type TurnContext,
  type TurnPerson
} from "./TurnContext.ts"

/**
 * The execution gateway (docs/MODULES-PLAN.md §4 P1): the one way a tool's `execute` or an action's `run` is reached.
 * A model's tool call (core's tool loop, through `ToolRegistry.run`), the Claude Code bridge (the same registry),
 * the intent agent and a confirmed action (`ToolRegistry.runAction`), and a module's `host.actions.run` all come
 * here; later a phrase command, a tap on a presentation, a routine step and a notification action do too.
 *
 * For every call it resolves **on whose behalf** it runs (`Principal`): the explicit one a caller passes (a
 * notification, P9), else the turn (`CurrentTurn`), else the job (`CurrentJob`), else, only in the CLI modes
 * (`withoutPrincipal: "local"`), the local principal. In serve mode a call with none of them is refused: a missing
 * context never means "allowed". It then validates the input (a generated action tool's input is turned into the
 * values `run` receives **once**, and those exact values are admitted and run), works out the call's risk,
 * sensitivity and latency, and admits it or refuses it, checking in this order:
 *
 * 1. the assistant has the module on (`GatewayAccess.moduleOn`);
 * 2. the tool is not in the assistant's `offTools` (`GatewayAccess.toolOff`);
 * 3. the risk policy (`GatewayOptions.risk`, empty until P8).
 *
 * Checks 1 and 2 apply to a turn's assistant and to a job made for an assistant; a local call and a notification's
 * action skip them (a notification is admitted by the notification, whatever modules the device's assistant has on).
 * The risk hook always runs. The first refusal wins and nothing is run. There is no confirmation hook: confirmation
 * stays off in this stack (§2 row 6); an action's `confirm: true` behaves as it always has.
 *
 * **Adding a check (later PRs):** fill the `risk` hook where the gateway is made (`makeExecutionGateway`, given to the
 * module host by serve mode as `ModuleHostOptions.gatewayHooks`); a new kind of check is one more optional hook in
 * `GatewayOptions`, placed in `admit`'s order.
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
  /** On whose behalf it runs. */
  readonly principal: Principal
  /** The turn it belongs to (a `turn` principal); `undefined` otherwise. */
  readonly turn: TurnContext | undefined
  /** The assistant it runs for: the turn's, or the job's; `undefined` for a local call and a notification. */
  readonly assistantId: string | undefined
  readonly deviceId: string | undefined
  readonly person: TurnPerson | undefined
  /** The connection it came in on (a turn or a notification), when known. */
  readonly connection: ConnectionRef | undefined
  /** The module it belongs to; `undefined` for a tool of a hand-made registry. */
  readonly moduleId: string | undefined
  /** The tool's name; for an action, its generated tool's name (`<moduleId>_<actionId>`, as `offTools` names it). */
  readonly name: string
  readonly action?: RegisteredAction
  /** The validated tool input, or (an action, a generated action tool) the values its `run` receives. */
  readonly input: unknown
  readonly risk: ToolRisk
  /** Fixed, or `per-result` (`sensitivityOf` decides on the result). */
  readonly sensitivity: Sensitivity | "per-result"
  readonly latency: ToolLatency
  /** The owner already said yes (a confirmed action). */
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
  /**
   * What a call with no explicit principal, no `CurrentTurn` and no `CurrentJob` is: `local` (the CLI modes: the
   * person at the terminal) or `refuse` (serve mode). Default: `local` without `access`, `refuse` with it.
   */
  readonly withoutPrincipal?: "local" | "refuse"
}

/** How one call is made: the principal it runs for, when the caller names it (a notification's action, P9). */
export interface GatewayCallOptions {
  readonly principal?: Principal
}

export interface ExecutionGateway {
  /** The checks, in order, for one call. */
  readonly admit: (call: GatewayCall) => Effect.Effect<GatewayDecision>
  /**
   * Run a tool: validate `input` (its JSON form, as a model sends it) with the tool's schema, admit the call, run
   * `execute`. A generated action tool's input becomes the action's values once; those are admitted and run. Invalid
   * input and refusals are `ToolError`s ("Invalid input: …", "Not run: …").
   */
  readonly tool: (moduleId: string | undefined, tool: Tool, input: unknown, options?: GatewayCallOptions) => Effect.Effect<unknown, ToolError>
  /** Run an action with its values (what `run` receives): admit the call, run `run`. A refusal is an `ActionError`. */
  readonly action: (
    action: RegisteredAction,
    values: Readonly<Record<string, unknown>>,
    options?: GatewayCallOptions & { readonly confirmed?: boolean }
  ) => Effect.Effect<ActionOutcome | void, ActionError>
  /** The principal a call made now would run for, or why there is none (`host.actions.list` lists by it). */
  readonly principal: Effect.Effect<Principal | { readonly refused: string }>
}

const decoders = new WeakMap<Tool, (u: unknown) => Effect.Effect<unknown, Schema.SchemaError>>()

/**
 * The tool's input decoder (the JSON Schema sent to the model describes the canonical JSON form), made once per tool.
 * `makeToolRegistry` makes it when the registry is built, so no call compiles a schema.
 */
export const prepareTool = (tool: Tool) => {
  let decode = decoders.get(tool)
  if (decode === undefined) {
    decode = Schema.decodeUnknownEffect(Schema.toCodecJson(tool.parameters))
    decoders.set(tool, decode)
  }
  return decode
}

const NO_PRINCIPAL = "it has no turn, job or other principal to run for."

export const makeExecutionGateway = (options: GatewayOptions = {}): ExecutionGateway => {
  const access = options.access
  const withoutPrincipal = options.withoutPrincipal ?? (access === undefined ? "local" : "refuse")
  // Made once: nothing is allocated per call for the checks.
  const hooks: ReadonlyArray<GatewayHook> = [options.risk].filter((h): h is GatewayHook => h !== undefined)
  type Resolved = Principal | { readonly refused: string }
  const noPrincipal: Effect.Effect<Resolved> = Effect.succeed({ refused: NO_PRINCIPAL })
  const local: Effect.Effect<Resolved> = Effect.succeed(LOCAL_PRINCIPAL)

  const principalNow: Effect.Effect<Resolved> = Effect.flatMap(CurrentTurn, (turn): Effect.Effect<Resolved> => {
    if (turn !== undefined) return Effect.succeed({ _tag: "turn", turn })
    return Effect.flatMap(CurrentJob, (job): Effect.Effect<Resolved> => {
      if (job !== undefined) return Effect.succeed({ _tag: "job", job })
      return withoutPrincipal === "local" ? local : noPrincipal
    })
  })

  const admit = (call: GatewayCall): Effect.Effect<GatewayDecision> =>
    Effect.suspend(() => {
      if (access !== undefined && call.assistantId !== undefined && call.moduleId !== undefined) {
        if (!access.moduleOn(call.assistantId, call.moduleId)) return Effect.succeed(refuse(`the ${call.moduleId} module is not on for this assistant.`))
        if (access.toolOff(call.assistantId, call.moduleId, call.name)) return Effect.succeed(refuse(`${call.name} is switched off for this assistant.`))
      }
      if (hooks.length === 0) return Effect.succeed(ALLOW)
      return Effect.gen(function*() {
        for (const hook of hooks) {
          const decision = yield* hook(call)
          if (decision._tag !== "Allow") return decision
        }
        return ALLOW
      })
    })

  /** The call with its principal and metadata resolved; a risk function that throws is a refusal (a string). */
  const callOf = (
    base: Pick<GatewayCall, "kind" | "moduleId" | "name" | "input" | "confirmed"> & { readonly action?: RegisteredAction },
    meta: ToolMetadata & { readonly speculative?: boolean | undefined },
    principal: Principal
  ): GatewayCall | string => {
    let risk: ToolRisk
    try {
      risk = riskOf(meta, base.input)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    const turn = principal._tag === "turn" ? principal.turn : undefined
    const job = principal._tag === "job" ? principal.job : undefined
    const notification = principal._tag === "notification" ? principal.notification : undefined
    return {
      ...base,
      principal,
      turn,
      // A notification's action is admitted by the notification: no assistant's choices apply to it.
      assistantId: turn?.assistantId ?? job?.assistantId,
      deviceId: turn?.deviceId ?? job?.deviceId ?? notification?.deviceId,
      person: turn?.person ?? job?.person ?? notification?.person,
      connection: turn?.connection ?? notification?.connection,
      risk,
      sensitivity: declaredSensitivity(meta),
      latency: meta.latency ?? "quick"
    }
  }

  const resolve = (explicit: Principal | undefined): Effect.Effect<Resolved> => (explicit !== undefined ? Effect.succeed(explicit) : principalNow)

  const tool: ExecutionGateway["tool"] = (moduleId, t, raw, callOptions = {}) =>
    Effect.gen(function*() {
      const input = yield* prepareTool(t)(raw).pipe(Effect.mapError((error) => new ToolError({ message: `Invalid input: ${error.message}` })))
      const principal = yield* resolve(callOptions.principal)
      if ("refused" in principal) return yield* new ToolError({ message: `Not run: ${principal.refused}`, cause: new GatewayRefused({ reason: principal.refused }) })
      const registered = t.action
      if (registered !== undefined) {
        // A generated action tool: its input becomes the action's values ONCE (a dynamic name resolved against the
        // options of now, a duration parsed); the checks see those values and `run` receives exactly them.
        const def = registered.definition
        if (def.confirm !== undefined && def.confirm !== false) {
          return yield* new ToolError({ message: "Not run: this action needs the owner's confirmation, which only the assistant can ask for." })
        }
        let values: Record<string, unknown>
        try {
          values = actionValues(registered, input as Readonly<Record<string, unknown>>)
        } catch (error) {
          return yield* (error instanceof ToolError ? error : new ToolError({ message: String(error) }))
        }
        const call = callOf({ kind: "tool", moduleId, name: t.name, input: values, confirmed: false, action: registered }, def, principal)
        if (typeof call === "string") return yield* new ToolError({ message: `Not run: ${call}`, cause: new GatewayRefused({ reason: call }) })
        const decision = yield* admit(call)
        if (decision._tag === "Refuse") return yield* new ToolError({ message: `Not run: ${decision.reason}`, cause: new GatewayRefused({ reason: decision.reason }) })
        return yield* runActionForTool(registered, values)
      }
      const call = callOf({ kind: "tool", moduleId, name: t.name, input, confirmed: false }, t, principal)
      if (typeof call === "string") return yield* new ToolError({ message: `Not run: ${call}`, cause: new GatewayRefused({ reason: call }) })
      const decision = yield* admit(call)
      if (decision._tag === "Refuse") return yield* new ToolError({ message: `Not run: ${decision.reason}`, cause: new GatewayRefused({ reason: decision.reason }) })
      // Suspended: a tool that throws while building its effect is a defect, as before.
      return yield* Effect.suspend(() => t.execute(input))
    })

  const action: ExecutionGateway["action"] = (registered, values, actionOptions = {}) =>
    Effect.gen(function*() {
      const def = registered.definition
      const principal = yield* resolve(actionOptions.principal)
      if ("refused" in principal) return yield* new ActionError({ message: `Not run: ${principal.refused}`, cause: new GatewayRefused({ reason: principal.refused }) })
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
        principal
      )
      if (typeof call === "string") return yield* new ActionError({ message: `Not run: ${call}`, cause: new GatewayRefused({ reason: call }) })
      const decision = yield* admit(call)
      if (decision._tag === "Refuse") return yield* new ActionError({ message: `Not run: ${decision.reason}`, cause: new GatewayRefused({ reason: decision.reason }) })
      return yield* Effect.suspend(() => def.run(values as never))
    })

  return { admit, tool, action, principal: principalNow }
}

/** The gateway of a registry made without one (tests, hand-made registries): no access checks, no hooks, local. */
export const defaultGateway: ExecutionGateway = makeExecutionGateway()
