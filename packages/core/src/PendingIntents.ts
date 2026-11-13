import { Effect } from "effect"
import { actionToolName, checkedActionValues, type RegisteredAction } from "./Actions.ts"
import { type PendingIntent, pendingStillValid } from "./Decision.ts"
import type { ToolCall, ToolResult } from "./Domain.ts"
import { defaultIntentWords, type IntentWords, isConfirmation, isRefusal } from "./IntentWords.ts"
import type { ToolRegistry } from "./ToolRegistry.ts"
import { readUtterance } from "./Utterance.ts"

/**
 * The ONE pending question or confirmation of a conversation (docs/AGENTS-AND-INTENTS.md,
 * "Review fixes, sixth round"): either the intent agent's parameter question ("Which room?"),
 * or a confirmation of an action declared `confirm: true`, which core itself conducts
 * (`Conversation`), whichever agent proposed the action. The newest replaces the older: a
 * confirmation armed after a parameter question drops the question, and a parameter question
 * stored after a confirmation drops the confirmation (any committed turn that is not the answer
 * to a confirmation drops it anyway).
 */
export interface PendingEntry {
  readonly intent: PendingIntent
  /** When it was stored (trace clock) and when it lapses. For a confirmation: `armedAt` + the window. */
  readonly at: number
  readonly until: number
  /** The turn that asked (for a confirmation: the turn that proposed it). Only a LATER turn can answer it. */
  readonly turnId: number
  /**
   * Confirmations only: when the question had been presented (its audio finished, or the owner
   * interrupted it after its final clause had started; text delivered in text mode). A
   * confirmation is stored only once armed, so it is always set for one.
   */
  readonly armedAt?: number
  /** Confirmations only: the agent that proposed the action (history attribution). */
  readonly agentId?: string
}

export interface PendingIntents {
  /** The pending entry, if it has not lapsed by `now` (a lapsed one is dropped). */
  current(now: number): PendingEntry | undefined
  /** Replace it (`undefined` clears). */
  set(entry: PendingEntry | undefined): void
  /** Clear it only if it is still `seen` (a later question must not be dropped by an earlier turn). */
  clearIf(seen: PendingIntent): void
  /** Drop a pending confirmation (a committed turn that is not its answer); a parameter question stays. */
  dropConfirmation(): void
}

/** How long the intent agent's parameter question waits for its answer (its default `pendingMs`). */
export const PENDING_MS = 15_000
/** How long an ARMED confirmation waits for its answer (`confirmWindowMs` of the conversation options). */
export const CONFIRM_WINDOW_MS = 15_000

export const makePendingIntents = (): PendingIntents => {
  let entry: PendingEntry | undefined
  return {
    current: (now) => {
      if (entry !== undefined && now >= entry.until) entry = undefined
      return entry
    },
    set: (next) => {
      entry = next
    },
    clearIf: (seen) => {
      if (entry?.intent === seen) entry = undefined
    },
    dropConfirmation: () => {
      if (entry?.intent.awaiting.kind === "confirm") entry = undefined
    }
  }
}

/** Whether `entry` is a confirmation (core's), not the intent agent's parameter question. */
export const isConfirmationEntry = (entry: PendingEntry | undefined): entry is PendingEntry =>
  entry !== undefined && entry.intent.awaiting.kind === "confirm"

/**
 * How a committed turn answers an armed confirmation, by closed grammars only: a confirmation
 * (`isConfirmation`: "yes", "ja, doe maar", "go ahead"), a refusal (`isRefusal` over the canonical
 * text with no mark left: "no", "cancel", "never mind", "nee", "laat maar"), or anything else
 * (the confirmation is dropped and the turn is handled as a fresh request).
 */
export const confirmationAnswer = (text: string, words: IntentWords = defaultIntentWords): "yes" | "no" | "other" => {
  if (isConfirmation(text, words)) return "yes"
  const u = readUtterance(text)
  if (u.marks.length === 0 && isRefusal(u.words.map((w) => w.norm), words)) return "no"
  return "other"
}

/**
 * THE consumption operation (review round 6): used on every path that runs a `confirm: true`
 * action, immediately before execution and never earlier. The action may run only if:
 *
 * - `seen` is still the current entry (not lapsed at `now`, not replaced, not consumed);
 * - it is a confirmation and it is armed (its question was presented) at or before `now`;
 * - the consuming turn is later than the turn that proposed it;
 * - its window has not closed at `now` — the clock read at execution, never the time an eager
 *   transcript was interpreted;
 * - its action is still the very registration offered (`actions`: the current setup) and every
 *   dynamic value it holds is still offered (`pendingStillValid`).
 *
 * The entry is removed as it is consumed (used once). One that fails only because its action or
 * values are no longer offered is removed too. Returns the consumed entry, or undefined.
 */
export const consumeConfirmation = (
  store: PendingIntents,
  seen: PendingEntry,
  at: { readonly turnId: number; readonly now: number; readonly actions: ReadonlyArray<RegisteredAction> }
): PendingEntry | undefined => {
  if (store.current(at.now) !== seen) return undefined
  if (seen.intent.awaiting.kind !== "confirm") return undefined
  if (seen.armedAt === undefined || seen.armedAt > at.now) return undefined
  if (at.turnId <= seen.turnId) return undefined
  if (at.now >= seen.until) return undefined
  if (!pendingStillValid(seen.intent, at.actions)) {
    store.clearIf(seen.intent)
    return undefined
  }
  store.set(undefined)
  return seen
}

/** The action a confirmation is about, if any: `confirm` declared and not `false`. */
export const needsConfirmation = (action: RegisteredAction): boolean =>
  action.definition.confirm !== undefined && action.definition.confirm !== false

/** What the proposing tool wrapper needs to know about the turn calling it. */
export interface ProposalContext {
  /** The actions this turn offers (a tool name not found in the registry's own lookup is looked up here). */
  readonly actions: ReadonlyArray<RegisteredAction>
  /**
   * Record THE proposal of this turn: `true` when recorded, `false` when one was already made (the
   * call is refused), or the reason the proposal is REFUSED (round 7: its confirmation question
   * cannot state the values; nothing is asked and the owner is told it could not be confirmed).
   */
  readonly propose: (action: RegisteredAction, values: Readonly<Record<string, unknown>>, call: ToolCall) => boolean | string
  /** A proposal was made (or refused) in this turn: every further call is refused. */
  readonly proposed: () => boolean
}

const refused = (call: ToolCall, content: string): ToolResult => ({ id: call.id, name: call.name, content, isError: true })

/** The result a model gets for a call that proposed a `confirm: true` action. */
export const PROPOSED_RESULT =
  "Not run yet: this action needs the owner's confirmation, and the assistant is now asking the owner to confirm it. " +
  "Do not ask them yourself and do not say or do anything further this turn. You will see in the conversation whether they confirmed and what happened."

/**
 * The reason a proposal is refused when the conversation's `confirmActions` is "off" (after the
 * final review: the confirmation mechanism is not relied on yet). `ProposalContext.propose`
 * returns this very string; history's outcome note carries it.
 */
export const CONFIRMATIONS_OFF_REASON =
  "this action requires confirmation by the owner, and confirmations are switched off in this assistant's settings."

/** The result a model gets for a call of a `confirm: true` action while confirmations are switched off. */
export const CONFIRMATIONS_OFF_RESULT =
  "Not run: this action requires confirmation by the owner, and confirmations are switched off in this assistant's settings, so it cannot be run. " +
  "The assistant has told the owner. Do not try again and say nothing further this turn."

/**
 * The turn's tool registry with core's confirmation rule for actions declared `confirm: true`
 * (review round 6; replaces round 5's "call again after a yes"):
 *
 * - a call of such an action's generated tool with complete, valid values does not run it: it
 *   PROPOSES the action (`ctx.propose`: the action, the values, the call), and the result tells the
 *   model that the assistant is now asking the owner, that it must not ask or say anything further,
 *   and that it will see the outcome in the history. `Conversation` then ends the agent's stream for
 *   the turn and speaks the action's own confirmation question itself;
 * - values it cannot use are refused as an error (nothing is proposed);
 * - once a proposal was made in the turn, EVERY further call (any tool) is refused;
 * - while confirmations are switched off, `ctx.propose` refuses with `CONFIRMATIONS_OFF_REASON`
 *   and the call is answered with `CONFIRMATIONS_OFF_RESULT` (nothing proposed, nothing run).
 *
 * There is no second call: a later call to the same tool is a new proposal. Model and harness agents
 * both call tools through `AgentTurnInput.tools`, so both get this. The generated tool itself refuses
 * to run a `confirm: true` action (`actionTool`), so no unwrapped registry can run one either.
 */
export const proposingTools = (tools: ToolRegistry["Service"], ctx: ProposalContext): ToolRegistry["Service"] => {
  const byName = new Map<string, RegisteredAction>()
  for (const a of ctx.actions) if (needsConfirmation(a)) byName.set(actionToolName(a.moduleId, a.definition.id), a)
  const actionOf = (name: string): RegisteredAction | undefined => {
    const own = tools.actionFor?.(name)
    if (own !== undefined) return needsConfirmation(own) ? own : undefined
    return byName.get(name)
  }
  const run = (call: ToolCall): Effect.Effect<ToolResult> =>
    Effect.suspend(() => {
      if (ctx.proposed()) {
        return Effect.succeed(refused(call, "Not run: the assistant is asking the owner to confirm another action; nothing else runs this turn. Say nothing further."))
      }
      const action = actionOf(call.name)
      if (action === undefined) return tools.run(call)
      const input = (typeof call.input === "object" && call.input !== null ? call.input : {}) as Readonly<Record<string, unknown>>
      let values: Record<string, unknown>
      try {
        values = checkedActionValues(action, input)
      } catch (error) {
        return Effect.succeed(refused(call, `Not run: ${error instanceof Error ? error.message : String(error)}`))
      }
      const proposed = ctx.propose(action, values, call)
      if (proposed === CONFIRMATIONS_OFF_REASON) return Effect.succeed(refused(call, CONFIRMATIONS_OFF_RESULT))
      if (typeof proposed === "string") {
        return Effect.succeed(refused(
          call,
          `Not run and not asked: the assistant cannot ask the owner to confirm this, because ${proposed} ` +
            "The assistant has told the owner it could not be confirmed. Say nothing further this turn."
        ))
      }
      if (!proposed) {
        return Effect.succeed(refused(call, "Not run: the assistant is asking the owner to confirm another action; nothing else runs this turn. Say nothing further."))
      }
      return Effect.succeed({ id: call.id, name: call.name, content: PROPOSED_RESULT, isError: false })
    })
  return { ...tools, run }
}
