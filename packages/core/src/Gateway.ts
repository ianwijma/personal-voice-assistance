import { decideRisk, type RiskDecision, type RiskLanguage, riskOffered, type RiskPolicy, riskPolicyKey, riskReason, riskRefusalPrefix, riskSpoken, riskWithheld } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { ACTION_TIMEOUT_MS, ActionError, type ActionOutcome, actionToolName, actionValues, type RegisteredAction } from "./Actions.ts"
import { ToolError } from "./Errors.ts"
import { actionRunnerOf, registerConfirmedRunner, toolRunnerOf } from "./GatewayPrivate.ts"
import { declaredSensitivity, riskOf, type Sensitivity, sensitivityOf, type Tool, type ToolLatency, type ToolMetadata, toolMetadata, type ToolRisk, UNKNOWN_OWNER } from "./Module.ts"
import { isPresentResult } from "./Present.ts"
import {
  type ConnectionRef,
  CurrentJob,
  CurrentPrincipal,
  CurrentTurn,
  CurrentTurnCommit,
  LOCAL_PRINCIPAL,
  type Principal,
  type TurnContext,
  type TurnPerson
} from "./TurnContext.ts"
import { CurrentTurnTrace, type TraceCall } from "./TurnTrace.ts"

/**
 * The execution gateway (docs/MODULES-PLAN.md §4 P1): the one way a tool's `execute` or an action's `run` is reached.
 * A model's tool call (core's tool loop, through `ToolRegistry.run`), the Claude Code bridge (the same registry), the
 * intent agent (`ToolRegistry.runAction`), and a module's `host.actions.run` all come here; later a phrase command, a
 * tap on a presentation, a routine step and a notification action do too. Every tool and action the module host
 * publishes is sealed (`GatewayPrivate.ts`): its own `execute` / `run` refuses, and only this file runs the real one.
 * Sealing stops accidental direct calls; it is not a security boundary against code compiled into the process
 * (docs/MODULES-PLAN.md §3.5): such code can hand a sealed handle to another gateway, relabel it, or read what a
 * registrar receives.
 *
 * For every call it resolves **on whose behalf** it runs (`Principal`): the explicit one a caller passes (a
 * notification, P9), else the turn (`CurrentTurn`), else the job (`CurrentJob`), else the principal of the gateway
 * call this one is made from (`CurrentPrincipal`: a local or notification call's nested calls), else, only in the CLI
 * modes (`withoutPrincipal: "local"`), the local principal. In serve mode a call with none of them is refused, so is a
 * local one, and so is a principal whose parts are missing or do not belong together (`GatewayAccess.principalProblem`).
 * The admitted call then **runs as that principal**: `execute` and `run` see exactly its `CurrentTurn`, `CurrentJob`
 * and `CurrentPrincipal`, and so do the calls they make. Checks, in this order (the first refusal wins, nothing runs):
 *
 * 1. the principal (complete, consistent);
 * 2. the assistant has the module on (`GatewayAccess.moduleOn`);
 * 3. the tool is not in the assistant's `offTools` (`GatewayAccess.toolOff`);
 * 4. only then the module's risk function on the validated input (a generated action tool's input is turned into the
 *    action's values once; those are classified, admitted and run), within `RISK_BUDGET_MS`; one that throws,
 *    answers an undeclared class or is too slow refuses the call with a generic sentence (details to the log);
 * 5. the household's risk policy (`GatewayOptions.policy`, read now: serve mode's saved setting, the CLI modes' saved
 *    setting at their start, the test kit's household), decided by THE function `decideRisk` (`@pva/protocol`) from the
 *    policy, the classes the tool or action declares and the class of this input: `confirm` and `deny` refuse, each with
 *    its own sentence (the household's language), and every decision is recorded (the turn's `Trace.calls`, and
 *    `GatewayOptions.onDecision`);
 * 6. the later hook (`GatewayOptions.risk`), empty in this stack.
 *
 * After `execute` (a tool, for the model only): a result whose `sensitivity` is `personal` is passed through
 * `GatewayOptions.mayReveal` for the call's device; when it may not be revealed there the model gets a fixed sentence
 * (`riskWithheld`) and nothing of the result, and nothing of it is presented.
 *
 * Checks 2 and 3 apply to a turn's assistant and to a job made for an assistant; a local call and a notification's
 * action skip them. An action declared `confirm: true` is refused on every path here (confirmation is off in this
 * stack); only core's confirmed path (`GatewayPrivate.confirmedRunnerOf`, `Conversation`) runs one.
 *
 * A tool or action whose every declared class the policy refuses is left out of a turn's tool list and action catalogue
 * (`offers`, by `riskOffered` over the same `decideRisk`, read by `makeToolRegistry` whenever its list is read and by the
 * host's catalogue at each listing); a call that names it anyway, or a list read before a change that refuses it now, is
 * refused by check 5.
 *
 * A press on a presentation and an action on a notification run a handler the module registered, not a tool or action:
 * `handler` admits that run (the principal, then the policy on the handler's declared `risk`, inferred `change`).
 *
 * **Adding a check (later PRs):** fill the `risk` hook where the gateway is made (`makeExecutionGateway`, given to the
 * module host by serve mode as `ModuleHostOptions.gatewayHooks`); a new kind of check is one more optional hook in
 * `GatewayOptions`, placed in `runHooks`' order.
 */

/** Which modules and tools an assistant has on (serve mode: its `modules` choices). */
export interface GatewayAccess {
  /** The assistant has the module on (modules that are not per assistant, agents and deciders, are always on). */
  readonly moduleOn: (assistantId: string, moduleId: string) => boolean
  /** The tool (an action's generated tool name for an action) is switched off for the assistant. */
  readonly toolOff: (assistantId: string, moduleId: string, toolName: string) => boolean
  /**
   * Serve mode's own check that a principal's parts belong together (the assistant exists, the device is known and has
   * that assistant, the connection is that device's): a reason refuses the call before any other check. Absent: only
   * completeness is checked.
   */
  readonly principalProblem?: (principal: Principal) => string | undefined
}

/** One call, as the checks see it. */
export interface GatewayCall {
  /** `handler`: a registered handler's run (a press on a presentation, an action on a notification). */
  readonly kind: "tool" | "action" | "handler"
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
  /** Core's confirmed path, after the owner's spoken yes (never a public caller's claim). */
  readonly confirmed: boolean
}

export type GatewayDecision = { readonly _tag: "Allow" } | { readonly _tag: "Refuse"; readonly reason: string }

/**
 * The `cause` of the `ToolError` / `ActionError` of a call the gateway did not admit. A refusal of the risk policy also
 * carries its decision and what the person hears (`spoken`, the household's language).
 */
export class GatewayRefused extends Schema.TaggedError<GatewayRefused>()("GatewayRefused", {
  reason: Schema.String,
  spoken: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Schema.Literals(["confirm", "deny"])),
  by: Schema.optionalKey(Schema.String)
}) {}

/** The sentence for the person of a refusal by the risk policy, or `undefined` (another refusal, or no refusal). */
export const spokenRefusal = (error: { readonly cause?: unknown }): string | undefined =>
  error.cause instanceof GatewayRefused ? error.cause.spoken : undefined

/** One decision of the risk policy, on any path (`GatewayOptions.onDecision`). */
export interface GatewayDecisionRecord extends TraceCall {
  readonly kind: GatewayCall["kind"]
  readonly moduleId: string | undefined
  /** On whose behalf the call was made. */
  readonly principal: Principal["_tag"]
  /** The turn's id, for a call of a turn. */
  readonly turnId?: number
}

/** Whether an error is the gateway's refusal (not a failure of the tool or action itself). */
export const isGatewayRefusal = (error: { readonly cause?: unknown }): boolean => error.cause instanceof GatewayRefused

export const ALLOW: GatewayDecision = { _tag: "Allow" }
export const refuse = (reason: string): GatewayDecision => ({ _tag: "Refuse", reason })

/** A check of the gateway after the access checks and the risk function. Must not fail; must be fast (it runs on every call). */
export type GatewayHook = (call: GatewayCall) => Effect.Effect<GatewayDecision>

export interface GatewayOptions {
  /** Absent: the access checks are skipped (tests, the CLI modes). */
  readonly access?: GatewayAccess
  /**
   * Check 5: the household's risk policy, read at every decision and every time a tool list is read (nothing keeps it:
   * a saved change applies to the next call and the next list). Must be a cheap synchronous read. Absent: nothing is
   * decided and every class is allowed (tests, hand-made registries).
   */
  readonly policy?: () => RiskPolicy
  /** The language of the refusal and withheld sentences (`HOME_LANGUAGE`). Absent: English. */
  readonly language?: () => RiskLanguage
  /**
   * `sensitivity`: may personal content of `owner` be revealed on the device `deviceId` (`Privacy.mayReveal`; no device:
   * no). Asked for a tool's `personal` result at the moment it would go back to the model. Absent: not asked (the CLI
   * modes, which have no devices; tests).
   */
  readonly mayReveal?: (owner: string, deviceId: string | undefined) => boolean
  /** Told every decision of the policy, on every path (the turn's trace gets those of a turn as well). Must not throw. */
  readonly onDecision?: (record: GatewayDecisionRecord) => void
  /** Check 6, a later hook (P8). */
  readonly risk?: GatewayHook
  /**
   * What a call with no explicit principal, no `CurrentTurn` and no `CurrentJob` is: `local` (the CLI modes: the
   * person at the terminal) or `refuse` (serve mode). Default: `local` without `access`, `refuse` with it.
   */
  readonly withoutPrincipal?: "local" | "refuse"
  /**
   * P10: the Presenter's split of a result (`PresentEngine.fromResult`): a tool's or action's `{ forModel, present }`
   * is handed to the Presenter (one synchronous enqueue) and the model gets `forModel` with a note of what the server
   * did. Absent (the CLI modes, hand-made registries): such a result still gives the model `forModel`, with the note
   * that nothing can be shown here.
   */
  readonly present?: (moduleId: string | undefined, principal: Principal, value: unknown) => Effect.Effect<unknown>
}

/** How one call is made: the principal it runs for, when the caller names it (a notification's action, P9). */
export interface GatewayCallOptions {
  readonly principal?: Principal
}

/** How one action call is made. */
export interface ActionCallOptions extends GatewayCallOptions {
  /**
   * Run once the call is admitted (the first admission), before `holdUntil`: the intent agent releases its
   * announcement then, so it is synthesised while the turn is still speculative and plays at promotion. Not run for a
   * call refused at that admission. A call refused at the second admission (after `holdUntil`) does not run, but its
   * announcement may already have been released (docs/ARCHITECTURE.md, "The execution gateway": a known limit).
   */
  readonly onAdmitted?: Effect.Effect<void>
  /**
   * Wait for this after admission (a speculative turn's promotion), then admit the same call again just before it
   * runs: a change of the assistant's choices meanwhile refuses it. A failure here refuses the call.
   */
  readonly holdUntil?: Effect.Effect<void, ActionError>
  /**
   * P7 (a phrase command's execution trace): told the admission's outcome once it is decided, before the action runs:
   * the class the call was judged as (absent when it was refused before its risk was judged) and the refusal, if any.
   * Must not throw (a throw is ignored). P10: told once more, `presented: true`, when the action's outcome carried a
   * presentation and it was handed to the Presenter.
   */
  readonly onDecision?: (decision: ActionDecisionNote) => void
}

/**
 * What an action call's observer is told (`ActionCallOptions.onDecision`): the class it was judged as, the refusal's
 * reason, and (P8) the risk policy's decision when one was taken (`outcome`, `by`; absent for a call refused before the
 * decision or with no policy).
 */
export interface ActionDecisionNote {
  readonly risk?: ToolRisk
  readonly refused?: string
  readonly presented?: true
  readonly outcome?: RiskDecision["outcome"]
  readonly by?: RiskDecision["by"]
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
  /**
   * Run an action with its values (what `run` receives): admit the call, run `run`. A refusal is an `ActionError`. An
   * action declared `confirm: true` is always refused here (confirmation is off in this stack; only core's own
   * confirmed path, after a spoken yes, runs one).
   */
  readonly action: (
    action: RegisteredAction,
    values: Readonly<Record<string, unknown>>,
    options?: ActionCallOptions
  ) => Effect.Effect<ActionOutcome | void, ActionError>
  /** The principal a call made now would run for, or why there is none (`host.actions.list` lists by it). */
  readonly principal: Effect.Effect<Principal | { readonly refused: string }>
  /**
   * Whether a tool or action is offered at all: the risk policy allows at least one class it declares (or infers).
   * One it refuses for every class is left out of tool lists and catalogues; its calls are refused anyway.
   */
  readonly offers: (meta: ToolMetadata & { readonly speculative?: boolean | undefined }) => boolean
  /**
   * What `offers` depends on now: a key that changes exactly when the policy's offers change (a tool list made for one
   * key fits as long as the key is the same). "" without a policy.
   */
  readonly offerKey: () => string
  /**
   * P8: admit a registered handler's run for the principal of now (a press on a presentation, an action on a
   * notification: the engines run it as that principal): the principal's checks, then the risk policy on the handler's
   * declared `risk` (inferred `change`) with `input`, recorded like every decision. `undefined`: admitted. A refusal of
   * the policy carries what the person hears (`spoken`).
   */
  readonly handler: (
    moduleId: string,
    name: string,
    meta: ToolMetadata & { readonly speculative?: boolean | undefined },
    input: unknown
  ) => Effect.Effect<{ readonly refused: string; readonly spoken?: string } | undefined>
}

const decoders = new WeakMap<Tool, (u: unknown) => Effect.Effect<unknown, Schema.SchemaError>>()

/** Tell an action call's observer the admission's outcome; an observer that throws changes nothing. */
const tellDecision = (options: ActionCallOptions, decision: ActionDecisionNote) => {
  try {
    options.onDecision?.(decision)
  } catch {
    // An observer must not change the call.
  }
}

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

/**
 * The time a tool's or action's risk function may take (`RiskByInput.of`). It is synchronous module code on the turn
 * path, so it cannot be interrupted: it must be pure and bounded (a lookup in its input, no I/O). One that takes
 * longer, throws, or answers a class it did not declare refuses the call; what went wrong goes to the log only.
 */
export const RISK_BUDGET_MS = 2

const CONFIRMATION_OFF = "this action needs the owner's spoken confirmation, which only the assistant can ask for."

/** An action declared `confirm: true` (refused on every public path: confirmation is off in this stack). */
const needsYes = (registered: RegisteredAction) => registered.definition.confirm !== undefined && registered.definition.confirm !== false

/**
 * The generated tool's result for an action that ran: its `say`, else its `announce`, else "ok"; with `present` (P10),
 * that and the presentation, for the Presenter's split.
 */
const runForTool = (registered: RegisteredAction, values: Readonly<Record<string, unknown>>): Effect.Effect<ActionOutcome | void, ToolError> => {
  const def = registered.definition
  return Effect.suspend(() => actionRunnerOf(registered)(values)).pipe(
    Effect.timeoutOrElse({
      duration: ACTION_TIMEOUT_MS,
      orElse: () => Effect.fail(new ActionError({ message: `${def.label} did not finish within ${ACTION_TIMEOUT_MS / 1000} s` }))
    }),
    Effect.mapError((error) => new ToolError({ message: error.message, cause: error }))
  )
}

/**
 * The generated tool's result for an action's outcome (P8, review round 1 H2: made only after the outcome itself was
 * judged by its sensitivity): its `say`, else its `announce`, else "ok"; with `present`, that and the presentation.
 */
const formatForTool = (registered: RegisteredAction, values: Readonly<Record<string, unknown>>, outcome: ActionOutcome | void): unknown => {
  const def = registered.definition
  const said = outcome?.say ?? def.announce?.(values as never) ?? "ok"
  return outcome?.present === undefined ? said : { forModel: said, present: outcome.present, ...(outcome.show !== undefined ? { show: outcome.show } : {}) }
}

/** A result that asks to show something, without a Presenter here: `forModel`, and the note that nothing is shown. */
const NO_SCREEN = "Not shown: nothing can be shown here; say it instead."
const screenless = (value: unknown): unknown => {
  if (!isPresentResult(value)) return value
  const text = typeof value.forModel === "string" ? value.forModel : value.forModel === undefined ? "ok" : JSON.stringify(value.forModel)
  return `${text}\n[Screen: ${NO_SCREEN}]`
}

/** Why a call is not admitted: the reason for the model, its prefix, and (a refusal of the policy) its decision. */
interface Refusal {
  readonly reason: string
  readonly prefix: string
  readonly decision?: RiskDecision
  readonly spoken?: string
}

const NOT_RUN = "Not run: "

export const makeExecutionGateway = (options: GatewayOptions = {}): ExecutionGateway => {
  const access = options.access
  const policyNow = options.policy
  const languageNow = (): RiskLanguage => {
    try {
      return options.language?.() === "nl" ? "nl" : "en"
    } catch {
      return "en"
    }
  }
  const mayReveal = options.mayReveal
  const onDecision = options.onDecision
  const withoutPrincipal = options.withoutPrincipal ?? (access === undefined ? "local" : "refuse")
  // Made once: nothing is allocated per call for the checks.
  const hooks: ReadonlyArray<GatewayHook> = [options.risk].filter((h): h is GatewayHook => h !== undefined)
  type Resolved = Principal | { readonly refused: string }
  const noPrincipal: Effect.Effect<Resolved> = Effect.succeed({ refused: NO_PRINCIPAL })
  const local: Effect.Effect<Resolved> = Effect.succeed(LOCAL_PRINCIPAL)
  /** P10: a result that asks to show something goes to the Presenter (or, without one, loses its presentation). */
  const presentHook = options.present
  const split = (moduleId: string | undefined, principal: Principal, value: unknown): Effect.Effect<unknown> =>
    !isPresentResult(value) ? Effect.succeed(value) : presentHook === undefined ? Effect.succeed(screenless(value)) : presentHook(moduleId, principal, value)

  const principalNow: Effect.Effect<Resolved> = Effect.flatMap(CurrentTurn, (turn): Effect.Effect<Resolved> => {
    if (turn !== undefined) return Effect.succeed({ _tag: "turn", turn })
    return Effect.flatMap(CurrentJob, (job): Effect.Effect<Resolved> => {
      if (job !== undefined) return Effect.succeed({ _tag: "job", job })
      return Effect.flatMap(CurrentPrincipal, (outer): Effect.Effect<Resolved> => {
        // A call made from inside a local or notification call runs for it (a turn or job one is read above).
        if (outer !== undefined && (outer._tag === "local" || outer._tag === "notification" || outer._tag === "presentation")) return Effect.succeed(outer)
        return withoutPrincipal === "local" ? local : noPrincipal
      })
    })
  })

  /**
   * Serve mode (with `access`): a principal with missing or mismatched parts is refused, never admitted by a more
   * permissive rule. A turn names its assistant and device; a job or a notification names what it belongs to; then
   * `GatewayAccess.principalProblem` checks that the parts belong together (the assistant and device exist, the device
   * has that assistant, the connection is the device's, the person is the device's).
   */
  const incompletePrincipal = (p: Principal): string | undefined => {
    if (access === undefined) return undefined
    const blank = (s: string | undefined) => s === undefined || s.trim() === ""
    // The local principal is the person at the terminal of a CLI mode: never in serve mode, not even when named.
    if (p._tag === "local") return "there is no local principal here."
    if (p._tag === "turn") {
      if (blank(p.turn.assistantId)) return "the turn names no assistant."
      if (blank(p.turn.deviceId)) return "the turn names no device."
    } else if (p._tag === "job") {
      if (blank(p.job.jobId) || blank(p.job.moduleId)) return "the job names no job or module."
    } else if (p._tag === "notification") {
      if (blank(p.notification.notificationId) || blank(p.notification.deviceId)) return "the notification names no notification or device."
    } else if (p._tag === "presentation") {
      if (blank(p.presentation.presentationId) || blank(p.presentation.deviceId)) return "the press names no presentation or device."
    }
    return access.principalProblem?.(p)
  }

  /** Checks 0–2: the principal, the assistant has the module on, the tool is not switched off. No module code runs. */
  const accessProblem = (call: Omit<GatewayCall, "risk">): string | undefined => {
    if (access === undefined) return undefined
    if (call.assistantId !== undefined && call.moduleId === undefined) return `${call.name} belongs to no module, so the assistant's choices cannot be checked.`
    const problem = incompletePrincipal(call.principal)
    if (problem !== undefined) return problem
    if (call.assistantId !== undefined && call.moduleId !== undefined) {
      if (!access.moduleOn(call.assistantId, call.moduleId)) return `the ${call.moduleId} module is not on for this assistant.`
      if (access.toolOff(call.assistantId, call.moduleId, call.name)) return `${call.name} is switched off for this assistant.`
    }
    return undefined
  }

  /** Check 3 and later: the hooks, in order, on the classified call. */
  const runHooks = (call: GatewayCall): Effect.Effect<GatewayDecision> =>
    hooks.length === 0 ? Effect.succeed(ALLOW) : Effect.gen(function*() {
      for (const hook of hooks) {
        const decision = yield* hook(call)
        if (decision._tag !== "Allow") return decision
      }
      return ALLOW
    })

  /**
   * Check 5: THE decision on the policy of now, recorded (the turn's trace, `onDecision`). `undefined` without a policy
   * (nothing decided, nothing recorded). The record is returned, so a withheld result can be noted on it.
   */
  const decide = (
    call: Omit<GatewayCall, "risk">,
    declared: ReadonlyArray<ToolRisk>,
    risk: ToolRisk | undefined
  ): Effect.Effect<{ readonly decision: RiskDecision; readonly record: GatewayDecisionRecord } | undefined> => {
    if (policyNow === undefined) return Effect.succeed(undefined)
    return Effect.map(CurrentTurnTrace, (trace) => {
      const decision = decideRisk(policyNow(), declared, risk)
      const record: GatewayDecisionRecord = {
        kind: call.kind,
        moduleId: call.moduleId,
        name: call.name,
        principal: call.principal._tag,
        ...(call.turn !== undefined ? { turnId: call.turn.turnId } : {}),
        outcome: decision.outcome,
        by: decision.by
      }
      // The turn's trace holds the decisions of its own calls only (a job's call inside a turn's fiber is not the turn's).
      if (trace !== undefined && (call.turn === undefined ? call.principal._tag === "local" : call.turn.turnId === trace.id)) {
        ;(trace.calls ??= []).push(record)
      }
      try {
        onDecision?.(record)
      } catch {
        // A recorder that throws is the app's defect; the decision stands.
      }
      return { decision, record }
    })
  }

  const refusalOf = (decision: RiskDecision): Refusal | undefined => {
    if (decision.outcome === "allow") return undefined
    const language = languageNow()
    return { reason: riskReason(language, decision)!, prefix: riskRefusalPrefix(language), decision, spoken: riskSpoken(language, decision)! }
  }

  const admit = (call: GatewayCall): Effect.Effect<GatewayDecision> =>
    Effect.suspend(() => {
      const problem = accessProblem(call)
      if (problem !== undefined) return Effect.succeed(refuse(problem))
      return Effect.flatMap(decide(call, [call.risk], call.risk), (decided) => {
        const refusal = decided === undefined ? undefined : refusalOf(decided.decision)
        return refusal !== undefined ? Effect.succeed(refuse(refusal.reason)) : runHooks(call)
      })
    })

  /** The call with its principal resolved (its risk not yet). */
  const callOf = (
    base: Pick<GatewayCall, "kind" | "moduleId" | "name" | "input" | "confirmed"> & { readonly action?: RegisteredAction },
    meta: ToolMetadata,
    principal: Principal
  ): Omit<GatewayCall, "risk"> => {
    const turn = principal._tag === "turn" ? principal.turn : undefined
    const job = principal._tag === "job" ? principal.job : undefined
    const notification = principal._tag === "notification" ? principal.notification : principal._tag === "presentation" ? principal.presentation : undefined
    return {
      ...base,
      principal,
      turn,
      // A notification's action (and a press on a presentation) is admitted by what was pressed: no assistant's choices apply to it.
      assistantId: turn?.assistantId ?? job?.assistantId,
      deviceId: turn?.deviceId ?? job?.deviceId ?? notification?.deviceId,
      person: turn?.person ?? job?.person ?? notification?.person,
      connection: turn?.connection ?? notification?.connection,
      sensitivity: declaredSensitivity(meta),
      latency: meta.latency ?? "quick"
    }
  }

  /**
   * Admit a call: the access checks, then (only if they pass) the module's risk function on the call's input, within
   * `RISK_BUDGET_MS`, then the hooks. A refusal is its reason; a risk function that fails is refused generically and
   * logged.
   */
  const admitCall = (
    call: Omit<GatewayCall, "risk">,
    meta: ToolMetadata & { readonly speculative?: boolean | undefined }
  ): Effect.Effect<{ readonly refusal: Refusal | undefined; readonly record: GatewayDecisionRecord | undefined; readonly risk?: ToolRisk }> =>
    Effect.suspend((): Effect.Effect<{ readonly refusal: Refusal | undefined; readonly record: GatewayDecisionRecord | undefined; readonly risk?: ToolRisk }> => {
      const problem = accessProblem(call)
      // Refused before the decision: nothing is recorded for it.
      if (problem !== undefined) return Effect.succeed({ refusal: { reason: problem, prefix: NOT_RUN }, record: undefined })
      let risk: ToolRisk | undefined
      let failure: string | undefined
      // Only a risk function of the input (module code) has the budget. A fixed or inferred risk is the host's own
      // lookup: timing it measured whatever else held the thread (a collection, another process on a busy machine)
      // and refused an ordinary call as unjudged.
      const judgedByModule = typeof meta.risk === "object"
      const started = performance.now()
      try {
        risk = riskOf(meta, call.input)
      } catch {
        // A bounded category only: what the module threw (or answered) may hold anything, so it is not logged.
        failure = "its risk function threw or answered a class it does not declare"
      }
      const ms = performance.now() - started
      if (failure === undefined && judgedByModule && ms > RISK_BUDGET_MS) failure = `its risk function took ${ms.toFixed(1)} ms (at most ${RISK_BUDGET_MS} ms)`
      let declared: ReadonlyArray<ToolRisk>
      try {
        declared = toolMetadata(meta).risks
      } catch {
        declared = []
      }
      if (failure !== undefined || risk === undefined) {
        // Not judged: the policy decides `deny` (`unjudged`) and it is recorded; without a policy the call is refused
        // all the same, with the generic sentence. What went wrong goes to the log only.
        const unjudged: RiskDecision = { outcome: "deny", by: "unjudged" }
        return Effect.andThen(
          Effect.logWarning(`Execution gateway: ${call.name} (module ${call.moduleId ?? "none"}) refused: ${failure}`),
          Effect.map(decide(call, declared, undefined), (decided) => ({ refusal: refusalOf(decided?.decision ?? unjudged), record: decided?.record }))
        )
      }
      const judged = risk
      return Effect.flatMap(decide(call, declared, judged), (decided) => {
        const refusal = decided === undefined ? undefined : refusalOf(decided.decision)
        if (refusal !== undefined) return Effect.succeed({ refusal, record: decided?.record, risk: judged })
        return Effect.map(runHooks({ ...call, risk: judged }), (decision) => ({
          refusal: decision._tag === "Allow" ? undefined : { reason: decision.reason, prefix: NOT_RUN },
          record: decided?.record,
          risk: judged
        }))
      })
    })

  /**
   * `sensitivity`, at the moment a tool's result would go back to the model: a `personal` result (fixed, or decided on
   * this result) is revealed only where `mayReveal` allows it for the call's device. Otherwise the model gets the fixed
   * sentence, and the decision's record says so.
   */
  /** May personal content of `owner` go to the call's device? An unknown owner is never anyone's (H4). */
  const mayRevealOwner = (owner: string, call: Omit<GatewayCall, "risk">): boolean => {
    if (mayReveal === undefined) return true
    if (owner === UNKNOWN_OWNER) return false
    try {
      return mayReveal(owner, call.deviceId) === true
    } catch {
      return false
    }
  }
  const markWithheld = (record: GatewayDecisionRecord | undefined) => {
    if (record !== undefined) (record as { withheld?: boolean }).withheld = true
  }

  /** Whether the executor's own result `value` may go back to the model (it is marked withheld otherwise). */
  const mayRevealResult = (meta: ToolMetadata, call: Omit<GatewayCall, "risk">, record: GatewayDecisionRecord | undefined, value: unknown): boolean => {
    if (mayReveal === undefined) return true
    const sensitivity = sensitivityOf(meta, value)
    if (sensitivity.kind === "household" || mayRevealOwner(sensitivity.owner, call)) return true
    markWithheld(record)
    return false
  }

  /**
   * H3' (after review 2): whether an admitted executor's failure may go back to the model. A fixed household sensitivity:
   * yes. A fixed personal one: where its result could be shown. Decided per result: a typed failure (`ToolError`,
   * `ActionError`) is the module's own sentence and goes back as it is (its author keeps personal content out of it), a
   * defect (a crash) cannot be asked about, so no.
   */
  const mayRevealFailure = (meta: ToolMetadata, call: Omit<GatewayCall, "risk">, record: GatewayDecisionRecord | undefined, typed: boolean): boolean => {
    const declared = declaredSensitivity(meta)
    const ok = declared === "per-result" ? typed : declared.kind === "household" || mayRevealOwner(declared.owner, call)
    if (!ok) markWithheld(record)
    return ok
  }

  /**
   * `run` (an admitted executor) with its failure and its defect under the reveal decision (H3): one that may not be
   * revealed is replaced by the fixed withheld sentence as a failure (`isError` kept), never its text. An interruption
   * passes through.
   */
  const guardedRun = <A>(meta: ToolMetadata, call: Omit<GatewayCall, "risk">, record: GatewayDecisionRecord | undefined, run: Effect.Effect<A, ToolError>): Effect.Effect<A, ToolError> =>
    mayReveal === undefined && declaredSensitivity(meta) !== "per-result" ? run : run.pipe(
      Effect.catch((error) => (mayRevealFailure(meta, call, record, true) ? Effect.fail(error) : Effect.fail(new ToolError({ message: riskWithheld(languageNow()) })))),
      Effect.catchDefect((defect) => (mayRevealFailure(meta, call, record, false) ? Effect.die(defect) : Effect.fail(new ToolError({ message: riskWithheld(languageNow()) }))))
    )

  /** What an action call's observer is told about an admission. */
  const decisionNote = (a: { readonly refusal: Refusal | undefined; readonly record: GatewayDecisionRecord | undefined; readonly risk?: ToolRisk }): ActionDecisionNote => ({
    ...(a.risk !== undefined ? { risk: a.risk } : {}),
    ...(a.refusal !== undefined ? { refused: a.refusal.reason } : {}),
    ...(a.record !== undefined ? { outcome: a.record.outcome, by: a.record.by } : {})
  })

  const resolve = (explicit: Principal | undefined): Effect.Effect<Resolved> => (explicit !== undefined ? Effect.succeed(explicit) : principalNow)

  const causeOf = (r: Refusal) =>
    new GatewayRefused({
      reason: r.reason,
      ...(r.spoken !== undefined ? { spoken: r.spoken } : {}),
      ...(r.decision !== undefined && r.decision.outcome !== "allow" ? { outcome: r.decision.outcome, by: r.decision.by } : {})
    })
  const refusedTool = (r: Refusal | string) => {
    const refusal = typeof r === "string" ? { reason: r, prefix: NOT_RUN } : r
    return new ToolError({ message: `${refusal.prefix}${refusal.reason}`, cause: causeOf(refusal) })
  }
  const refusedAction = (r: Refusal | string) => {
    const refusal = typeof r === "string" ? { reason: r, prefix: NOT_RUN } : r
    return new ActionError({ message: `${refusal.prefix}${refusal.reason}`, cause: causeOf(refusal) })
  }

  const tool: ExecutionGateway["tool"] = (moduleId, t, raw, callOptions = {}) =>
    Effect.gen(function*() {
      const input = yield* prepareTool(t)(raw).pipe(Effect.mapError((error) => new ToolError({ message: `Invalid input: ${error.message}` })))
      const principal = yield* resolve(callOptions.principal)
      if ("refused" in principal) return yield* refusedTool(principal.refused)
      const registered = t.action
      if (registered !== undefined) {
        // A generated action tool: its input becomes the action's values ONCE (a dynamic name resolved against the
        // options of now, a duration parsed); the checks see those values and `run` receives exactly them.
        const def = registered.definition
        if (needsYes(registered)) return yield* refusedTool(CONFIRMATION_OFF)
        let values: Record<string, unknown>
        try {
          values = actionValues(registered, input as Readonly<Record<string, unknown>>)
        } catch (error) {
          return yield* (error instanceof ToolError ? error : new ToolError({ message: String(error) }))
        }
        const call = callOf({ kind: "tool", moduleId, name: t.name, input: values, confirmed: false, action: registered }, def, principal)
        const admitted = yield* admitCall(call, def)
        if (admitted.refusal !== undefined) return yield* refusedTool(admitted.refusal)
        // H2: the action's own outcome is judged by its sensitivity first; only an admitted one is formatted and shown.
        const record = admitted.record
        const formatted = yield* guardedRun(def, call, record, Effect.gen(function*() {
          const outcome = yield* asPrincipal(principal, runForTool(registered, values))
          if (!mayRevealResult(def, call, record, outcome)) return { withheld: true as const }
          return { value: formatForTool(registered, values, outcome) }
        }))
        if ("withheld" in formatted) return riskWithheld(languageNow())
        return yield* split(moduleId, principal, formatted.value)
      }
      const call = callOf({ kind: "tool", moduleId, name: t.name, input, confirmed: false }, t, principal)
      const admitted = yield* admitCall(call, t)
      if (admitted.refusal !== undefined) return yield* refusedTool(admitted.refusal)
      // Suspended: a tool that throws while building its effect is a defect, as before.
      const value = yield* guardedRun(t, call, admitted.record, asPrincipal(principal, Effect.suspend(() => toolRunnerOf(t)(input))))
      if (!mayRevealResult(t, call, admitted.record, value)) return riskWithheld(languageNow())
      return yield* split(moduleId, principal, value)
    })

  const runAction = (
    registered: RegisteredAction,
    values: Readonly<Record<string, unknown>>,
    actionOptions: ActionCallOptions,
    confirmed: boolean
  ): Effect.Effect<ActionOutcome | void, ActionError> =>
    Effect.gen(function*() {
      const def = registered.definition
      const principal = yield* resolve(actionOptions.principal)
      if ("refused" in principal) {
        tellDecision(actionOptions, { refused: principal.refused })
        return yield* refusedAction(principal.refused)
      }
      if (!confirmed && needsYes(registered)) {
        tellDecision(actionOptions, { refused: CONFIRMATION_OFF })
        return yield* refusedAction(CONFIRMATION_OFF)
      }
      const call = callOf(
        { kind: "action", moduleId: registered.moduleId, name: actionToolName(registered.moduleId, def.id), input: values, confirmed, action: registered },
        def,
        principal
      )
      const first = yield* admitCall(call, def)
      tellDecision(actionOptions, decisionNote(first))
      if (first.refusal !== undefined) return yield* refusedAction(first.refusal)
      if (actionOptions.onAdmitted !== undefined) yield* actionOptions.onAdmitted
      if (actionOptions.holdUntil !== undefined) {
        yield* actionOptions.holdUntil
        // Decided again on the policy of now, just before it runs (a change saved meanwhile refuses it).
        const again = yield* admitCall(call, def)
        if (again.refusal !== undefined) {
          tellDecision(actionOptions, decisionNote(again))
          return yield* refusedAction(again.refusal)
        }
      }
      const outcome = yield* asPrincipal(principal, Effect.suspend(() => actionRunnerOf(registered)(values)))
      // P10: an outcome's presentation goes to the Presenter (the intent agent speaks `say`; the note is for a model).
      if (outcome?.present === undefined) return outcome
      yield* split(registered.moduleId, principal, { forModel: outcome.say ?? "", present: outcome.present, ...(outcome.show !== undefined ? { show: outcome.show } : {}) })
      tellDecision(actionOptions, { presented: true })
      const { present: _p, show: _s, ...rest } = outcome
      return rest
    })

  const action: ExecutionGateway["action"] = (registered, values, actionOptions = {}) => runAction(registered, values, actionOptions, false)

  // The principal a call made now would run for: refused (serve mode) when it has missing parts, as `admit` would.
  const principal: Effect.Effect<Resolved> = Effect.map(principalNow, (p): Resolved => {
    if ("refused" in p) return p
    const problem = incompletePrincipal(p)
    return problem === undefined ? p : { refused: problem }
  })

  const offers: ExecutionGateway["offers"] = (meta) => {
    if (policyNow === undefined) return true
    try {
      return riskOffered(policyNow(), toolMetadata(meta).risks)
    } catch {
      return false
    }
  }

  const offerKey = (): string => (policyNow === undefined ? "" : riskPolicyKey(policyNow()))

  const handler: ExecutionGateway["handler"] = (moduleId, name, meta, input) =>
    Effect.gen(function*() {
      const p = yield* principal
      if ("refused" in p) return { refused: p.refused }
      const call = callOf({ kind: "handler", moduleId, name: `${moduleId}/${name}`, input, confirmed: false }, meta, p)
      const admitted = yield* admitCall(call, meta)
      if (admitted.refusal === undefined) return undefined
      return { refused: admitted.refusal.reason, ...(admitted.refusal.spoken !== undefined ? { spoken: admitted.refusal.spoken } : {}) }
    })

  const gateway: ExecutionGateway = { admit, tool, action, principal, offers, offerKey, handler }
  // Core's confirmed path (`Conversation`, after a consumed spoken yes): reachable from inside core only.
  registerConfirmedRunner(gateway, (registered, values) => runAction(registered, values, {}, true))
  return gateway
}

/**
 * Run `effect` as `principal`: exactly its turn or job (an ambient one of someone else is replaced, cleared for a local
 * or notification call) and the principal itself, for the calls it makes in turn. The ambient turn's commit state
 * (`CurrentTurnCommit`, R8) is kept only for a turn principal.
 */
export const asPrincipal = <A, E, R>(principal: Principal, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  (principal._tag === "turn" ? effect : Effect.provideService(effect, CurrentTurnCommit, undefined)).pipe(
    Effect.provideService(CurrentTurn, principal._tag === "turn" ? principal.turn : undefined),
    Effect.provideService(CurrentJob, principal._tag === "job" ? principal.job : undefined),
    Effect.provideService(CurrentPrincipal, principal)
  )

/** The gateway of a registry made without one (tests, hand-made registries): no access checks, no hooks, local. */
export const defaultGateway: ExecutionGateway = makeExecutionGateway()
