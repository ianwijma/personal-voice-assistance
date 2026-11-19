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
  /**
   * The connection (browser tab) the request came in on, opaque: several tabs can share a device id. Serve mode sets
   * it for voice turns (the tab that owns the device's audio when the turn starts) and typed turns (the tab that sent
   * the text). Compare with `===`; never shown or stored.
   */
  readonly connection?: ConnectionRef
}

/** An opaque reference to one connection of the server (serve mode makes one per WebSocket client). */
export interface ConnectionRef {
  readonly _tag: "ConnectionRef"
  /** For logs only: the connection's client id. */
  readonly id: string
}

export const makeConnectionRef = (id: string): ConnectionRef => ({ _tag: "ConnectionRef", id })

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

/**
 * Where a job's call comes from (P6's scheduler provides it as `CurrentJob` around a job's work): the job, the module
 * that owns it, and, when the job acts for someone, the assistant, device and person it was made for.
 */
export interface JobOrigin {
  readonly jobId: string
  readonly moduleId: string
  readonly assistantId?: string
  readonly deviceId?: string
  readonly person?: TurnPerson
}

/** The job a call runs for, outside a turn; `undefined` otherwise. Nothing in P1 provides it. */
export const CurrentJob = Context.Reference<JobOrigin | undefined>("@pva/core/CurrentJob", {
  defaultValue: () => undefined
})

/**
 * Where an action on a notification comes from (P9): the notification, and the device and connection it was taken
 * on. Nothing produces it yet; the gateway admits such a call by the notification (`Principal`).
 */
export interface NotificationOrigin {
  readonly notificationId: string
  readonly deviceId: string
  readonly connection?: ConnectionRef
  readonly person?: TurnPerson
}

/**
 * Where a press on a presentation comes from (P10): the presentation, and the device and connection it was pressed on.
 * The gateway admits such a call by the presentation (`Principal`), like a notification's action.
 */
export interface PresentationOrigin {
  readonly presentationId: string
  readonly deviceId: string
  readonly connection?: ConnectionRef
  readonly person?: TurnPerson
}

/**
 * On whose behalf a tool or action runs: the execution gateway's admission takes one (docs/MODULES-PLAN.md §4 P1).
 *
 * - `turn`: a turn (assistant, device, person, connection), from `CurrentTurn`.
 * - `job`: a job, from `CurrentJob` (P6).
 * - `local`: the person at the terminal (the CLI modes, which have no assistants); explicit, never assumed in serve mode.
 * - `notification`: an action on a notification (P9), admitted by the notification whatever modules the device's
 *   assistant has on. Passed explicitly; nothing produces it yet.
 * - `presentation`: a press on a presentation (P10: a tick or a button), admitted by the presentation like a
 *   notification's action. Passed explicitly by the Presenter.
 */
export type Principal =
  | { readonly _tag: "turn"; readonly turn: TurnContext }
  | { readonly _tag: "job"; readonly job: JobOrigin }
  | { readonly _tag: "local" }
  | { readonly _tag: "notification"; readonly notification: NotificationOrigin }
  | { readonly _tag: "presentation"; readonly presentation: PresentationOrigin }

/** The local principal of the CLI modes. */
export const LOCAL_PRINCIPAL: Principal = { _tag: "local" }

/**
 * The principal a call runs for, as the execution gateway admitted it: provided (with the matching `CurrentTurn` and
 * `CurrentJob`) around every `execute` and `run` it admits, so code inside it, and the calls it makes in turn
 * (`host.actions.run`, a service), act for exactly that principal, a local or notification one included. Outside a
 * gateway call it is `undefined`. Read by the gateway after `CurrentTurn` and `CurrentJob`.
 */
export const CurrentPrincipal = Context.Reference<Principal | undefined>("@pva/core/CurrentPrincipal", {
  defaultValue: () => undefined
})

/** The context of one turn: its origin plus what `Conversation` knows. */
export const makeTurnContext = (
  turn: { readonly turnId: number; readonly conversationId: string; readonly source: TurnSource },
  origin: TurnOrigin
): TurnContext => ({ ...origin, ...turn })
