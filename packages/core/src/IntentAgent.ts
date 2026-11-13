import { Cause, Clock, Effect, Exit, Fiber, Stream } from "effect"
import { ACTION_TIMEOUT_MS, ActionError, type ActionOutcome, actionToolName, type RegisteredAction } from "./Actions.ts"
import type { AgentEvent, AgentTurnInput, IntentDecisionInfo } from "./Agent.ts"
import {
  buildDecisionPlan,
  DecisionError,
  type DecisionProvider,
  defaultIntentThresholds,
  type IntentOutcome,
  type IntentThresholds,
  interpretDecision,
  type ParamDetail,
  type PendingIntent,
  type ValueParser
} from "./Decision.ts"
import type { AgentImplementation } from "./ModuleContributions.ts"
import { parseValues } from "./ValueParsing.ts"

/**
 * The intent agent (docs/AGENTS-AND-INTENTS.md §3.4, §3.6): recognises which
 * of the running modules' actions an utterance asks for, with which values,
 * using ONE decision request, then runs the action as code and speaks a short
 * confirmation. No conversational model.
 *
 * Speculation: the decision runs during a speculative turn and an `announce`
 * text is spoken at once (synthesised early, played at promotion); the action
 * itself waits for `promoted` unless it is `speculative` (read-only). An action
 * that has started runs to completion even when the owner barges in (it is
 * detached from the turn, with the 5 s limit). The pending question or
 * confirmation is stored only when the turn is committed.
 *
 * Not for it → `Handoff` before any text: the conversational agent answers.
 */

export interface IntentAgentOptions {
  /**
   * Decision providers by id, in order of preference: the first one running in
   * the turn's snapshot answers. Default `["jev-typesafe", "keywords"]`.
   */
  readonly deciders?: ReadonlyArray<string>
  readonly thresholds?: IntentThresholds
  /** Numbers and durations found locally. Default: `parseValues` (English and Dutch). */
  readonly parse?: ValueParser
  /** No action fits: pass the turn on (default), or say `noMatchText`. */
  readonly onNoMatch?: "fallback" | "say"
  readonly noMatchText?: string
  /** Speak `announce` while the action runs (default), or only after it succeeded. */
  readonly speakBeforeDone?: boolean
  /** A question or confirmation waits this long for its answer. Default 15 000 ms. */
  readonly pendingMs?: number
  /** Longest a decision may take; no retries. Default 1200 ms. */
  readonly timeoutMs?: number
  /** Called when the decision provider in use changes ("TypeSafe key not set: using offline keyword matching"). */
  readonly onDeciderChange?: (provider: DecisionProvider | undefined, preferred: string) => void
}

export const INTENT_DEFAULT_DECIDERS = ["jev-typesafe", "keywords"] as const
export const CANCELLED_TEXT = "OK, I won't."

const text = (t: string): AgentEvent => ({ _tag: "TextDelta", text: t })
const FLUSH = text("\n")
const emit = (...events: ReadonlyArray<AgentEvent>): Stream.Stream<AgentEvent> => Stream.fromIterable(events)

export const makeIntentAgent = (options: IntentAgentOptions = {}): AgentImplementation & {
  /** The stored pending question or confirmation (for tests and the status line). */
  readonly pending: () => PendingIntent | undefined
} => {
  const preference = options.deciders ?? INTENT_DEFAULT_DECIDERS
  const thresholds = options.thresholds ?? defaultIntentThresholds
  const parse = options.parse ?? parseValues
  const pendingMs = options.pendingMs ?? 15_000
  const timeoutMs = options.timeoutMs ?? 1_200
  const speakBeforeDone = options.speakBeforeDone ?? true
  let stored: { readonly intent: PendingIntent; readonly at: number } | undefined
  let lastDecider: string | undefined = "(none yet)"
  let calls = 0

  const choose = (deciders: ReadonlyMap<string, DecisionProvider>): DecisionProvider | undefined => {
    let chosen: DecisionProvider | undefined
    for (const id of preference) {
      chosen = deciders.get(id)
      if (chosen !== undefined) break
    }
    if (chosen?.id !== lastDecider) {
      lastDecider = chosen?.id
      options.onDeciderChange?.(chosen, preference[0] ?? "")
    }
    return chosen
  }

  const turn = (input: AgentTurnInput): Stream.Stream<AgentEvent> =>
    Stream.unwrap(Effect.gen(function*() {
      const now = input.now === undefined ? Clock.currentTimeMillis : Effect.sync(input.now)
      const startedAt = yield* now
      if (stored !== undefined && startedAt - stored.at >= pendingMs) stored = undefined
      const pending = stored?.intent

      if (input.actions.length === 0 && pending === undefined) return emit({ _tag: "Handoff", reason: "no actions" })

      const decider = choose(input.deciders)
      const decision = (info: Omit<IntentDecisionInfo, "decider" | "params"> & { readonly params?: ReadonlyArray<ParamDetail> }): AgentEvent => ({
        _tag: "Decision",
        decision: { decider: decider?.id ?? "none", params: [], ...info }
      })
      if (decider === undefined) {
        stored = undefined
        return emit(decision({ outcome: "error", ms: 0, reason: "No decision provider is running" }), { _tag: "Handoff", reason: "no decider" })
      }

      const plan = buildDecisionPlan({ utterance: input.text, actions: input.actions, pending, parse })
      input.mark("decisionSent")
      const exit = yield* decider.decide(plan.request).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new DecisionError({ message: `${decider.name} did not answer within ${timeoutMs} ms`, reason: "timeout" }))
        }),
        Effect.exit
      )
      input.mark("decisionReceived")
      const ms = (yield* now) - startedAt
      if (Exit.isFailure(exit)) {
        stored = undefined
        const error = Cause.findErrorOption(exit.cause)
        const reason = error._tag === "Some" ? error.value.message : `${decider.name} failed`
        if (error._tag === "None") yield* Effect.logWarning(`Decision provider ${decider.id} crashed`, exit.cause)
        return emit(decision({ outcome: "error", ms, reason }), { _tag: "Handoff", reason: "decider_error" })
      }

      const outcome = interpretDecision(plan, exit.value, thresholds)
      return outcomeEvents(input, outcome, decision, ms, startedAt)
    }))

  /** Store (or clear) the pending intent once the turn is committed. */
  const commitPending = (input: AgentTurnInput, next: PendingIntent | undefined, at: number) =>
    Stream.fromEffectDrain(Effect.andThen(input.promoted, Effect.sync(() => {
      stored = next === undefined ? undefined : { intent: next, at }
    })))

  const actionRef = (action: RegisteredAction) => ({ id: action.id, label: action.definition.label, moduleId: action.moduleId })

  const outcomeEvents = (
    input: AgentTurnInput,
    outcome: IntentOutcome,
    decision: (info: Omit<IntentDecisionInfo, "decider" | "params"> & { readonly params?: ReadonlyArray<ParamDetail> }) => AgentEvent,
    ms: number,
    at: number
  ): Stream.Stream<AgentEvent> => {
    switch (outcome._tag) {
      case "Fallback": {
        // The conversational agent takes the turn; a pending question is not asked twice.
        stored = undefined
        const info = decision({ outcome: "fallback", ms, reason: outcome.reason, ...(outcome.probability !== undefined ? { probability: outcome.probability } : {}) })
        if (outcome.reason === "no_match" && options.onNoMatch === "say") {
          return emit(info, text(options.noMatchText ?? "I can't do that."), FLUSH)
        }
        return emit(info, { _tag: "Handoff", reason: outcome.reason })
      }
      case "Cancelled":
        return emit(decision({ outcome: "cancelled", ms, action: actionRef(outcome.action) }), text(CANCELLED_TEXT), FLUSH).pipe(
          Stream.concat(commitPending(input, undefined, at))
        )
      case "Ask":
      case "Confirm":
        return emit(
          decision({
            outcome: outcome._tag === "Ask" ? "ask" : "confirm",
            ms,
            action: actionRef(outcome.pending.action),
            params: outcome.details,
            probability: outcome.pending.probability
          }),
          text(outcome.question),
          FLUSH
        ).pipe(
          Stream.concat(commitPending(input, outcome.pending, at)),
          Stream.concat(emit({ _tag: "ExpectReply" }))
        )
      case "Act":
        return act(input, outcome, decision({ outcome: "act", ms, action: actionRef(outcome.action), params: outcome.details, probability: outcome.probability }), at)
    }
  }

  const act = (input: AgentTurnInput, outcome: Extract<IntentOutcome, { _tag: "Act" }>, decided: AgentEvent, at: number): Stream.Stream<AgentEvent> =>
    Stream.suspend(() => {
      const { action, params } = outcome
      const def = action.definition
      const announce = def.announce?.(params as never)
      const early = speakBeforeDone && announce !== undefined && announce.length > 0
      let spoke = false
      const sentence = (t: string): ReadonlyArray<AgentEvent> => {
        if (t.length === 0) return []
        const out = [text(spoke ? ` ${t}` : t), FLUSH]
        spoke = true
        return out
      }
      const callId = `action-${input.turnId}-${++calls}`
      const now = input.now === undefined ? Clock.currentTimeMillis : Effect.sync(input.now)

      const run = Effect.gen(function*() {
        input.mark("actionStarted")
        const start = yield* now
        // Detached: once started, an action finishes even if the turn is interrupted (half a light switch is worse).
        const fiber = yield* Effect.forkDetach(def.run(params as never).pipe(
          Effect.timeoutOrElse({
            duration: ACTION_TIMEOUT_MS,
            orElse: () => Effect.fail(new ActionError({ message: `${def.label} did not finish within ${ACTION_TIMEOUT_MS / 1000} seconds.` }))
          })
        ))
        const exit = yield* Fiber.await(fiber)
        const ms = (yield* now) - start
        input.mark("actionFinished")
        input.trace.tools.push({ name: actionToolName(action.moduleId, def.id), ms })
        return { exit, ms }
      })

      const head: ReadonlyArray<AgentEvent> = [decided, ...(early ? sentence(announce) : [])]
      return Stream.fromIterable(head).pipe(
        Stream.concat(def.speculative === true ? Stream.empty : commitPending(input, undefined, at)),
        Stream.concat(emit({ _tag: "ActionStarted", callId, actionId: action.id, label: def.label, params })),
        Stream.concat(Stream.unwrap(Effect.map(run, ({ exit, ms }): Stream.Stream<AgentEvent> => {
          if (Exit.isSuccess(exit)) {
            const say = (exit.value as ActionOutcome | undefined)?.say
            return Stream.fromIterable<AgentEvent>([
              { _tag: "ActionFinished", callId, ok: true, ms },
              ...(!early && announce !== undefined ? sentence(announce) : []),
              ...(say !== undefined ? sentence(say) : [])
            ])
          }
          const error = Cause.findErrorOption(exit.cause)
          const message = error._tag === "Some" ? error.value.message : "Something went wrong."
          return Stream.fromIterable<AgentEvent>([
            { _tag: "ActionFinished", callId, ok: false, ms, error: message },
            ...sentence(`Sorry, ${message.length > 0 ? message : "that failed."}`)
          ])
        }))),
        Stream.concat(def.speculative === true ? commitPending(input, undefined, at) : Stream.empty)
      )
    })

  return { speculate: true, turn, pending: () => stored?.intent }
}
