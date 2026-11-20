import { ServiceKey } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * `Timers`: the timers module's service (docs/MODULES-PLAN.md §5.2; docs/research/modules/timers-and-alarms.md §4, §12).
 * Provided by `timers` (`packages/module-timers`, wave B), used by `routines` (a step that starts a timer) and later
 * `kitchen` (a recipe step's timer).
 *
 * **What it is.** One operation: start a named countdown that rings on one device, exactly as if the person had said
 * "set a pasta timer for ten minutes" there. The timer is household data like every timer: listed, adjusted, paused
 * and cancelled by voice afterwards, and shown on every screen (its label is never personal). It rings through the
 * notification service (P9) like any other timer.
 *
 * **Where it rings.** `ringOn.deviceId` when given; otherwise the device of the call it runs for: the turn's
 * (`CurrentTurn.deviceId`), else the job's (`CurrentJob.deviceId`). No device at all is `no_device`; a device the server
 * does not know is `unknown_device`. A consumer never picks a device the person did not ask for: it passes the turn's
 * own, or one the person named and the consumer resolved with `Devices`.
 *
 * **Bounds.** Checked by the provider; a request outside them is `invalid` and starts nothing.
 *
 * - `durationMs`: a whole number from `minMs` (one second) to `maxMs` (a day).
 * - `label`: 1 to `labelChars` characters (UTF-16 units) of one line ("Rice, step 4"); absent: "timer".
 * - `ringOn.deviceId`: a device id as the server gives it (8 to 64 of `[A-Za-z0-9_-]`).
 * - At most `running` running timers in the household; one more is `limit`.
 *
 * **Ids.** `TimerInfo.id` is chosen by the timers module: a store row id (1 to 200 of `[A-Za-z0-9_.:-]`), the same for
 * the timer's whole life, never reused.
 *
 * **Errors.** `TimersError.reason` says what happened; the consumer words it in its own two languages. `detail` is
 * for the log only.
 *
 * **Latency.** One store transaction and one scheduled job (a few milliseconds): fine on a turn's path.
 *
 * **When the timers module is off or stops**: `host.service(Timers)` is `undefined`, and a call made while it stops may
 * die with `ModuleStopped`; `useService(host, Timers, …)` makes both `ProviderOff`. A routine step reports it as its
 * failure; nothing is retried.
 */
export const TIMERS_LIMITS = { minMs: 1_000, maxMs: 86_400_000, labelChars: 60, running: 50 } as const

export interface StartTimerRequest {
  readonly durationMs: number
  readonly label?: string
  /** Where it rings; absent: the device of the call (see above). */
  readonly ringOn?: { readonly deviceId: string }
}

export interface TimerInfo {
  readonly id: string
  readonly label: string
  readonly durationMs: number
  /** Epoch ms. */
  readonly dueAt: number
  readonly ringOn: { readonly deviceId: string }
}

/** A refusal or failure (see "Errors" above). */
export class TimersError extends Data.TaggedError("TimersError")<{
  /**
   * `invalid`: outside the bounds. `no_device`: the call has no device and none was given. `unknown_device`: the server
   * does not know that device. `limit`: too many running timers. `busy`: the store was busy; nothing was done.
   * `failed`: anything else.
   */
  readonly reason: "invalid" | "no_device" | "unknown_device" | "limit" | "busy" | "failed"
  readonly detail: string
}> {}

export interface TimersService {
  /** Start a timer; it is running when this returns. */
  readonly start: (request: StartTimerRequest) => Effect.Effect<TimerInfo, TimersError>
}

export const Timers = ServiceKey<TimersService>("timers")
