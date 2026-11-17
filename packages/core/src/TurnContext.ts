import { Context } from "effect"

/**
 * The turn a tool call or an action run belongs to (docs/research/module-investigation/shared-state-jobs-and-notifications.md
 * §4.5): who asked, where, in which conversation. `Conversation` provides it as `CurrentTurn` around every tool call
 * and action run of a turn and around the gathering of its context providers (core's tool loop, the intent agent, a
 * confirmed action, and the Claude Code bridge, which captures it at the turn's start), the way `CurrentTurnTrace` is
 * provided around synthesis. A tool reads it with
 * `yield* CurrentTurn`; outside a turn (CLI modes without a device, jobs, tests) it is `undefined`.
 *
 * Providing it is the only work it adds to a turn: one reference value per turn, built once at the turn's start.
 */

/** Who is speaking, as far as the server knows (docs/MODULES-PLAN.md P5 fills it; `undefined` until then). */
export interface TurnPerson {
  readonly id: string
  /** `device-default`: the device's default person; `voice`: identified by voice; `chosen`: the speaker said so. */
  readonly how: "device-default" | "voice" | "chosen"
  /** 0..1, for `voice`. */
  readonly confidence?: number
}

export interface TurnContext {
  /** The turn's id (`Trace.id`), unique within its voice session. */
  readonly turnId: number
  /** The conversation the turn belongs to (`AgentTurnInput.conversationId`). */
  readonly conversationId: string
  /** The assistant answering (serve mode). */
  readonly assistantId?: string
  /** The device the turn was spoken or typed on (serve mode). */
  readonly deviceId?: string
  readonly deviceName?: string
  /** The device's room (P5: `place.room`). */
  readonly room?: string
  /** Who is speaking (P5). */
  readonly person?: TurnPerson
  /** How it came: `voice` spoken, `text` typed, `touch` a tap on a presentation, `phrase` a phrase command, `routine` a routine step. */
  readonly source: TurnSource
}

/** Where a call came from (`TurnContext.source`). `Conversation` makes `voice` and `text`; later entry paths the others. */
export type TurnSource = "voice" | "text" | "touch" | "phrase" | "routine"

/**
 * The part of a `TurnContext` that is not the turn's own (who and where): what serve mode puts in
 * `TurnSetup.turnContext`, read at the turn's start with the rest of the setup. `Conversation` adds the turn id,
 * conversation id and source.
 */
export type TurnOrigin = Omit<TurnContext, "turnId" | "conversationId" | "source">

/** The current turn, provided around every tool call and action run; `undefined` outside a turn. */
export const CurrentTurn = Context.Reference<TurnContext | undefined>("@pva/core/CurrentTurn", {
  defaultValue: () => undefined
})

/** The context of one turn: its origin plus what `Conversation` knows. */
export const makeTurnContext = (
  turn: { readonly turnId: number; readonly conversationId: string; readonly source: TurnSource },
  origin: TurnOrigin
): TurnContext => ({ ...origin, ...turn })
