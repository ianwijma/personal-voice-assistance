import { defaultGateway } from "./Gateway.ts"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Stream } from "effect"
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
import { defaultIntentWords, type IntentWords } from "./IntentWords.ts"
import type { AgentImplementation } from "./ModuleContributions.ts"
import { makePendingIntents, needsConfirmation, type PendingIntents } from "./PendingIntents.ts"
import { parseValues } from "./ValueParsing.ts"

/**
 * The intent agent (docs/AGENTS-AND-INTENTS.md §3.4, §3.6): recognises which
 * of the running modules' actions an utterance asks for, with which values,
 * using ONE decision request, then runs the action as code and speaks a short
 * confirmation. No conversational model.
 *
 * Speculation: the decision runs during a speculative turn; the action waits
 * for `promoted` unless it is `speculative` (read-only), and its `announce`
 * text is released only once the gateway's admission just before the action
 * runs has passed (after promotion, for one that waits), so a refusal at that
 * admission never leaves a success sentence. An action that has started runs
 * to completion even when the owner barges in (it is detached from the turn):
 * waiting for promotion is bounded by `pendingMs`, the action itself by the
 * 5 s limit from the moment it starts. A pending parameter question is
 * stored only when the turn is committed. An action declared `confirm: true` is
 * never run here: the agent emits `ConfirmAction` and core asks and conducts the
 * confirmation (review round 6).
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
  /** A parameter question waits this long for its answer. Default 15 000 ms. (A confirmation is core's: `confirmWindowMs` of the conversation.) */
  readonly pendingMs?: number
  /** Longest a decision may take; no retries. Default 1200 ms. */
  readonly timeoutMs?: number
  /**
   * The words of core's safeguard (bounded yes for a confirmation, negation veto
   * for actions with side effects). Default: English and Dutch (`defaultIntentWords`).
   */
  readonly words?: IntentWords
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
  const lists = options.words ?? defaultIntentWords
  // The conversation's shared pending entry when it gives one (`AgentTurnInput.pendingIntents`), else this agent's own.
  const own = makePendingIntents()
  // For the status line only: the store of the latest turn. Every turn uses its own (`input.pendingIntents`).
  let lastStore: PendingIntents = own
  let storeNow = 0
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
      // This turn's store, captured before anything can overlap another turn of this agent.
      const store = input.pendingIntents ?? own
      lastStore = store
      storeNow = startedAt
      // Only this agent's own parameter questions: a pending confirmation is core's (review round 6),
      // answered before routing, never by an agent.
      const stored = store.current(startedAt)
      const entry = stored?.intent.awaiting.kind === "param" ? stored : undefined
      // The module behind a pending action may have been disabled or reconfigured since it asked.
      // (Its values are checked by the plan, against the same snapshot of option lists it uses.)
      if (entry !== undefined && !input.actions.includes(entry.intent.action)) store.clearIf(entry.intent)
      const pending = entry !== undefined && input.actions.includes(entry.intent.action) ? entry.intent : undefined

      if (input.actions.length === 0 && pending === undefined) return emit({ _tag: "Handoff", reason: "no actions" })

      const decider = choose(input.deciders)
      const decision = (info: Omit<IntentDecisionInfo, "decider" | "params"> & { readonly params?: ReadonlyArray<ParamDetail> }): AgentEvent => ({
        _tag: "Decision",
        decision: { decider: decider?.id ?? "none", params: [], ...info }
      })
      if (decider === undefined) {
        // Before the Handoff: Conversation stops reading this stream at a Handoff, so nothing after it would run.
        yield* dropOnPromotion(input, store, pending)
        return emit(decision({ outcome: "error", ms: 0, reason: "No decision provider is running" }), { _tag: "Handoff", reason: "no decider" })
      }

      const plan = buildDecisionPlan({ utterance: input.text, actions: input.actions, pending, parse, words: lists })
      for (const failed of plan.unavailable) yield* Effect.logWarning(`Intent agent: ${failed.message}`)
      // Every action's module failed to list its values and nothing is pending: a plain hand-off, no request.
      if (plan.actions.length === 0 && plan.pending === undefined) {
        yield* dropOnPromotion(input, store, pending)
        return emit(decision({ outcome: "fallback", ms: 0, reason: "no actions available" }), { _tag: "Handoff", reason: "no actions" })
      }
      input.mark("decisionSent")
      const exit = yield* Effect.suspend(() => decider.decide(plan.request)).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new DecisionError({ message: `${decider.name} did not answer within ${timeoutMs} ms`, reason: "timeout" }))
        }),
        Effect.exit
      )
      input.mark("decisionReceived")
      const ms = (yield* now) - startedAt
      if (Exit.isFailure(exit)) {
        yield* dropOnPromotion(input, store, pending)
        const error = Cause.findErrorOption(exit.cause)
        const reason = error._tag === "Some" ? error.value.message : `${decider.name} failed`
        if (error._tag === "None") yield* Effect.logWarning(`Decision provider ${decider.id} crashed`, exit.cause)
        return emit(decision({ outcome: "error", ms, reason }), { _tag: "Handoff", reason: "decider_error" })
      }

      const outcome = interpretDecision(plan, exit.value, thresholds, lists)
      return outcomeEvents(input, store, outcome, decision, ms, startedAt, pending)
    }))

  /**
   * A turn handed on (fallback, decider error): the pending question is not asked
   * twice, but a discarded speculative turn must leave it alone. The `Handoff`
   * ends this agent's stream before promotion and the fallback agent must not
   * wait, so the clearing waits for promotion on its own fiber, bounded by
   * `pendingMs` (a discarded turn is never promoted; the question would have
   * expired by then anyway), and clears only the question this turn saw.
   */
  const dropOnPromotion = (input: AgentTurnInput, shared: PendingIntents, seen: PendingIntent | undefined): Effect.Effect<void> => {
    if (seen === undefined) return Effect.void
    const clear = Effect.sync(() => shared.clearIf(seen))
    if (!input.speculative) return clear
    return Effect.asVoid(Effect.forkDetach(input.promoted.pipe(Effect.andThen(clear), Effect.timeoutOption(pendingMs))))
  }

  /** Store (or clear) the pending intent once the turn is committed. */
  const commitPending = (input: AgentTurnInput, shared: PendingIntents, next: PendingIntent | undefined, at: number) => {
    return Stream.fromEffectDrain(Effect.andThen(input.promoted, Effect.sync(() => {
      shared.set(next === undefined ? undefined : { intent: next, at, until: at + pendingMs, turnId: input.turnId })
    })))
  }

  const actionRef = (action: RegisteredAction) => ({ id: action.id, label: action.definition.label, moduleId: action.moduleId })

  const outcomeEvents = (
    input: AgentTurnInput,
    store: PendingIntents,
    outcome: IntentOutcome,
    decision: (info: Omit<IntentDecisionInfo, "decider" | "params"> & { readonly params?: ReadonlyArray<ParamDetail> }) => AgentEvent,
    ms: number,
    at: number,
    pending: PendingIntent | undefined
  ): Stream.Stream<AgentEvent> => {
    switch (outcome._tag) {
      case "Fallback": {
        const info = decision({ outcome: "fallback", ms, reason: outcome.reason, ...(outcome.probability !== undefined ? { probability: outcome.probability } : {}) })
        if (outcome.reason === "no_match" && options.onNoMatch === "say") {
          return emit(info, text(options.noMatchText ?? "I can't do that."), FLUSH).pipe(Stream.concat(commitPending(input, store, undefined, at)))
        }
        // The conversational agent takes the turn; a pending question is not asked twice (once this turn is committed).
        // The drop is set up before the Handoff: Conversation reads nothing after it.
        return Stream.fromEffectDrain(dropOnPromotion(input, store, pending)).pipe(Stream.concat(emit(info, { _tag: "Handoff", reason: outcome.reason })))
      }
      case "Cancelled":
        return emit(decision({ outcome: "cancelled", ms, action: actionRef(outcome.action) }), text(CANCELLED_TEXT), FLUSH).pipe(
          Stream.concat(commitPending(input, store, undefined, at))
        )
      case "Confirm":
        // Core asks and conducts the confirmation (review round 6): this agent proposes and stops.
        // A parameter question this turn answered is not asked again (dropped once committed).
        return Stream.fromEffectDrain(dropOnPromotion(input, store, pending)).pipe(Stream.concat(emit(
          decision({ outcome: "confirm", ms, action: actionRef(outcome.pending.action), params: outcome.details, probability: outcome.pending.probability }),
          { _tag: "ConfirmAction", action: outcome.pending.action, params: outcome.pending.params }
        )))
      case "Ask":
        return emit(
          decision({
            outcome: "ask",
            ms,
            action: actionRef(outcome.pending.action),
            params: outcome.details,
            probability: outcome.pending.probability
          }),
          text(outcome.question),
          FLUSH
        ).pipe(
          Stream.concat(commitPending(input, store, outcome.pending, at)),
          Stream.concat(emit({ _tag: "ExpectReply" }))
        )
      case "Act":
        // Never runs an action declared `confirm: true` (only core's consumption does): propose it instead.
        if (needsConfirmation(outcome.action)) {
          return Stream.fromEffectDrain(dropOnPromotion(input, store, pending)).pipe(Stream.concat(emit(
            decision({ outcome: "confirm", ms, action: actionRef(outcome.action), params: outcome.details, probability: outcome.probability }),
            { _tag: "ConfirmAction", action: outcome.action, params: outcome.params }
          )))
        }
        return act(input, store, outcome, decision({ outcome: "act", ms, action: actionRef(outcome.action), params: outcome.details, probability: outcome.probability }), at)
    }
  }

  /**
   * Run the action through the execution gateway, and say its announcement only once the gateway's admission just
   * before it runs has passed: a refused action is never announced. A speculative (read) action runs at once; any
   * other is admitted at once, held until the turn is committed (at most `pendingMs`) and admitted again just before
   * it runs; its announcement follows that second admission. A turn that is discarded first never runs it. The
   * action gets `ACTION_TIMEOUT_MS` from the moment it starts.
   */
  const act = (input: AgentTurnInput, store: PendingIntents, outcome: Extract<IntentOutcome, { _tag: "Act" }>, decided: AgentEvent, at: number): Stream.Stream<AgentEvent> =>
    Stream.unwrap(Effect.gen(function*() {
      const { action, params } = outcome
      const def = action.definition
      const announce = ((): string | undefined => {
        try {
          return def.announce?.(params as never)
        } catch {
          return undefined // module code: a broken announcement must not end the turn; the action still runs
        }
      })()
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
      const speculative = def.speculative === true
      const admitted = Deferred.makeUnsafe<boolean>()
      const dropped = Deferred.makeUnsafe<void>()
      const started = Deferred.makeUnsafe<void>()
      // `actionStarted` and the action's time are from the moment it runs (after promotion and the second admission
      // for one that was held).
      let start = yield* now
      const starting = Effect.flatMap(now, (at) =>
        Effect.sync(() => {
          start = at
          input.mark("actionStarted")
          Deferred.doneUnsafe(started, Effect.void)
        }))
      // Waiting for promotion and running are bounded separately: at most `pendingMs` for the first, and
      // `ACTION_TIMEOUT_MS` for the action from the moment it starts.
      const holdUntil = speculative ? undefined : Effect.raceFirst(
        input.promoted,
        Effect.flatMap(Deferred.await(dropped), () => Effect.fail(new ActionError({ message: "Not run: the turn was not committed." })))
      ).pipe(Effect.timeoutOrElse({ duration: pendingMs, orElse: () => Effect.fail(new ActionError({ message: "Not run: the turn was not committed in time." })) }))
      const onAdmitted = Effect.andThen(Deferred.succeed(admitted, true), starting)
      const limit = Effect.andThen(Deferred.await(started), Effect.sleep(ACTION_TIMEOUT_MS)).pipe(
        Effect.andThen(Effect.fail(new ActionError({ message: `${def.label} did not finish within ${ACTION_TIMEOUT_MS / 1000} seconds.` })))
      )
      const runAction = input.tools.runAction ?? defaultGateway.action
      // Detached: once it runs, an action finishes even if the turn is interrupted (half a light switch is worse).
      // Through the execution gateway (the module and the action must be on for the turn's assistant).
      const fiber = yield* Effect.forkDetach(Effect.raceFirst(runAction(action, params, { onAdmitted, ...(holdUntil !== undefined ? { holdUntil } : {}) }), limit).pipe(
        Effect.ensuring(Deferred.succeed(admitted, false))
      ))
      const finished = Effect.gen(function*() {
        const exit = yield* Fiber.await(fiber)
        const ms = (yield* now) - start
        input.mark("actionFinished")
        input.trace.tools.push({ name: actionToolName(action.moduleId, def.id), ms })
        return { exit, ms }
      })
      return Stream.fromIterable<AgentEvent>([decided]).pipe(
        // The announcement waits for the admission just before the action runs (and is left out if it refuses).
        Stream.concat(Stream.unwrap(Effect.map(Deferred.await(admitted), (ok) => Stream.fromIterable(ok && early ? sentence(announce!) : [])))),
        Stream.concat(speculative ? Stream.empty : commitPending(input, store, undefined, at)),
        Stream.concat(emit({ _tag: "ActionStarted", callId, actionId: action.id, label: def.label, params })),
        Stream.concat(Stream.unwrap(Effect.map(finished, ({ exit, ms }): Stream.Stream<AgentEvent> => {
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
        Stream.concat(speculative ? commitPending(input, store, undefined, at) : Stream.empty),
        // A turn whose stream ends before it was committed (discarded, interrupted) never runs a held action.
        Stream.ensuring(Effect.sync(() => void Deferred.doneUnsafe(dropped, Effect.void)))
      )
    }))

  return { speculate: true, turn, pending: () => lastStore.current(storeNow)?.intent }
}
