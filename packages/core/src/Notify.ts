import {
  decideDelivery,
  type Delivery,
  type DeliveryDevice,
  type DeliveryInput,
  type DeviceOutputs,
  deviceOutputsFrom,
  MAX_NOTIFICATION_ACTIONS,
  MAX_NOTIFICATION_CARDS,
  MAX_NOTIFICATION_LABEL_CHARS,
  MAX_NOTIFICATION_TEXT_CHARS,
  MAX_NOTIFICATION_TITLE_CHARS,
  type NotDeliveredWhy,
  NOTIFICATION_ACTION_ID,
  STOP_ACTION
} from "@pva/protocol"
import { Effect, Schema } from "effect"
import { type CoreStorage, defineCollection, maxListRows } from "./HouseholdStore.ts"
import type { PartHandle } from "./ModuleRegistrations.ts"
import type { PartRunner } from "./Scheduler.ts"
import { NOT_ONE_LINE } from "./SettingsExtra.ts"
import type { ConnectionRef, TurnPerson } from "./TurnContext.ts"

/**
 * The notification service and speech outside a reply (docs/MODULES-PLAN.md §4 P9, first version; how to use it:
 * docs/NOTIFICATIONS.md). This file is the contract: the module-facing calls (`ctx.notify`, `ctx.speech`), their
 * bounds and the stored data. `NotifyEngine.ts` implements it on the household store and the scheduler, the same in
 * serve mode (SQLite) and in the module test kit (in memory). The one delivery decision, `decideDelivery`, lives in
 * `@pva/protocol` (so the web mock decides with the same function) and is re-exported here.
 *
 * - A **notification** is one row of the core owner `core.notify`: a title, an optional text, a priority (`normal` or
 *   `ring`; nothing above `ring`), an optional owner for the privacy rule, a target (the origin device or everywhere),
 *   an optional dedupe key, an expiry, and up to `MAX_NOTIFICATION_ACTIONS` actions beside the host's `stop`. It is
 *   delivered when it is sent; a module that wants it later schedules a job of its own and sends from its handler.
 * - **Delivery is reconciliation**: one function makes what each connection holds equal to what the open rows and the
 *   decision allow now.
 * - **Actions** reach a handler the owning module registered in its `shared` part (`notify.handle`), claimed on the
 *   row first, one at a time per notification; `stop` is the host's and wins.
 * - **Speech** (`ctx.speech.say`) is one announcement per device queue, after whatever is being spoken there.
 * - Maintenance (expiry, the end of do not disturb, stale claims, retention, a reconciliation of every device) runs
 *   when something is due (`due`, planned by `plan()`), with an hourly safety net (`hourly`).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Bounds

/** The owner of the service's collections in the household store. */
export const NOTIFY_OWNER = "core.notify" as const
/** Open notifications of one module at most; one more is refused `limit`. */
export const MAX_OPEN_PER_MODULE = 10
/** Open notifications of all modules together at most; one more is refused `limit` (and a page keeps every one). */
export const MAX_OPEN_TOTAL = MAX_NOTIFICATION_CARDS
/** A dedupe key: 1–64 letters, digits and `_ . : @ / -`. */
export const NOTIFY_KEY = /^[A-Za-z0-9_.:@/-]{1,64}$/
/** An action handler's name: lower case letters, digits and `_ . -`, starting with a letter, at most 64. */
export const NOTIFY_HANDLER_NAME = /^[a-z][a-z0-9_.-]{0,63}$/
/** How long a notification stays open when it says nothing, counted from its send: a ring 15 minutes, a normal one a day. */
export const DEFAULT_EXPIRY_MS = { normal: 24 * 3_600_000, ring: 15 * 60_000 } as const
/** The longest a notification may stay open: a ring 2 hours, a normal one 7 days. */
export const MAX_EXPIRY_MS = { normal: 7 * 24 * 3_600_000, ring: 2 * 3_600_000 } as const
/** Resolved notifications are removed this long after they were resolved (by the maintenance job). */
export const KEEP_RESOLVED_MS = 24 * 3_600_000
/** The longest do not disturb may be set for, with an end time: 7 days. */
export const MAX_DND_MS = 7 * 24 * 3_600_000
/** An action handler's time limit (as a typed action's, `ACTION_TIMEOUT_MS`). */
export const NOTIFY_ACTION_TIMEOUT_MS = 5_000
/**
 * A claim that no run in this process holds (after a restart, or a press that could not write its outcome) is released
 * by maintenance once it is this old by wall time (or dated in the future: the wall clock moved back). A claim a run in
 * this process holds is never released or replaced because wall time moved: that run ends by its own time limit.
 */
export const CLAIM_RELEASE_MS = 3 * NOTIFY_ACTION_TIMEOUT_MS
/** The longest sentence a handler's answer may show (`ActionAnswer.say`), cut at the page boundary. */
export const MAX_ANSWER_CHARS = 300
/** The longest announcement, in UTF-16 units. */
export const MAX_SPEECH_CHARS = 300
/** Announcements on one device at most, waiting or being spoken; one more on it is not queued (`busy`). */
export const MAX_SPEECH_QUEUE = 8
/**
 * The service's two jobs under `core.notify` (D2b): `due`, one-shot, planned by `plan()` for the next thing that is due
 * (none when nothing is); and `hourly`, repeating, the safety net that does the full pass and plans again, so a lost
 * plan leaves nothing overdue for more than an hour. Each has a fixed key equal to its handler's name.
 */
export const DUE_HANDLER = "due"
export const HOURLY_HANDLER = "hourly"
export const HOURLY_CRON = "0 * * * *"
/** When a device's reconciliation failed (or do not disturb could not be read), the next maintenance is this soon. */
export const RETRY_AFTER_MS = 60_000
/**
 * What one maintenance run does at most, each in transactions of one page (12 rows) with a yield between: open rows
 * read for expiry and stale claims, resolved rows removed. More is planned for at once (the next run follows).
 */
export const MAINTENANCE_ROWS = 10 * 12

export {
  decideDelivery,
  type Delivery,
  type DeliveryDevice,
  type DeliveryInput,
  type DeviceOutputs,
  deviceOutputsFrom,
  MAX_NOTIFICATION_ACTIONS,
  MAX_NOTIFICATION_LABEL_CHARS,
  MAX_NOTIFICATION_TEXT_CHARS,
  MAX_NOTIFICATION_TITLE_CHARS,
  NOTIFICATION_ACTION_ID,
  STOP_ACTION
}

/**
 * Text a notification stores: no control character other than tab, line feed, carriage return, backspace and form
 * feed, and no lone surrogate, so each UTF-16 unit costs at most two characters of JSON (`StoredText` in
 * `@pva/module-contracts` is the same rule).
 */
export const NOTIFY_TEXT = /^[^\u0000-\u0007\u000b\u000e-\u001f\ud800-\udfff]*$/u

/** Why `text` is not a title or a label (one line, bounded, not blank), or `undefined`. */
export const lineProblem = (text: unknown, max: number, what: string): string | undefined => {
  if (typeof text !== "string" || text.trim() === "") return `${what} must be text`
  if (text.length > max) return `${what} is at most ${max} characters`
  if (NOT_ONE_LINE.test(text) || !NOTIFY_TEXT.test(text)) return `${what} must be one line`
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// What a module sends

export type NotifyPriority = "normal" | "ring"
/** `origin`: the device of the turn, job or press the call runs for; `everywhere`: every known device. */
export type NotifyTarget = "origin" | "everywhere"

/** A button beside the host's `stop`: an id (`NOTIFICATION_ACTION_ID`, not `stop`) and its label (one line). */
export interface NotifyAction {
  readonly id: string
  readonly label: string
}

export interface NotifyRequest {
  /** One line, at most `MAX_NOTIFICATION_TITLE_CHARS`. */
  readonly title: string
  /** At most `MAX_NOTIFICATION_TEXT_CHARS`. */
  readonly text?: string
  /** Default `normal`. `ring` loops the page's cue until it is resolved; nothing may send above it. */
  readonly priority?: NotifyPriority
  /** Personal content: whose (a Members id). Absent: the household's. Checked by `Privacy.mayReveal` at delivery. */
  readonly owner?: string
  /** Default `origin`. */
  readonly target?: NotifyTarget
  /** One open notification per module and key: sending it again while one is open answers that one (`deduped`). */
  readonly key?: string
  /** It is resolved as `expired` this long after it is sent. Default and maximum per priority. */
  readonly expiresInMs?: number
  /** At most `MAX_NOTIFICATION_ACTIONS`, with `handler`. */
  readonly actions?: ReadonlyArray<NotifyAction>
  /** The name of this module's action handler (`notify.handle`), required with `actions`. */
  readonly handler?: string
}

export type NotificationState = "open" | "resolved"

/** A notification as `send`, `list` and the test kit see it (a view: not a cursor for `list` unless `list` returned it). */
export interface Notification {
  readonly id: string
  readonly module: string
  readonly state: NotificationState
  readonly key?: string
  readonly title: string
  readonly text?: string
  readonly priority: NotifyPriority
  readonly owner?: string
  readonly target: NotifyTarget
  /** The origin device (target `origin`). */
  readonly deviceId?: string
  readonly actions: ReadonlyArray<NotifyAction>
  readonly handler?: string
  readonly sentAt: number
  readonly expiresAt: number
  /** `stop`, an action id, `expired`, or what `resolve` said (default `resolved`). */
  readonly outcome?: string
  readonly resolvedAt?: number
  /** A device id (a press), `module` (`resolve`) or `expiry`. */
  readonly resolvedBy?: string
}

export interface SendResult {
  readonly notification: Notification
  /** An open notification with the same key was there: it is answered, and nothing new was sent. */
  readonly deduped: boolean
}

/** `list`: the module's open notifications, oldest first, a page at a time (`after`: a notification `list` returned). */
export interface NotifyListQuery {
  readonly after?: Notification
  /** Default and at most `MAX_NOTIFY_PAGE`. */
  readonly limit?: number
}

/** Do not disturb, for the house. While it is on nothing rings and nothing is announced. */
export interface DndState {
  readonly on: boolean
  /** When it ends by itself (maintenance planned for that time). Absent: until it is cleared. */
  readonly until?: number
}

/** A press of an action of a notification of the module, as its handler receives it. */
export interface ActionPress {
  readonly notificationId: string
  readonly actionId: string
  readonly key?: string
  /** The device it was pressed (or said) on. */
  readonly deviceId: string
}

/** What a handler answers: the sentence to show or say (else "Done."), and whether the notification stays open. */
export interface ActionAnswer {
  readonly say?: string
  /** Default false: the notification is resolved with the action as its outcome once the handler succeeded. */
  readonly keepOpen?: boolean
}

export interface NotifyActionHandler {
  /**
   * Runs in the module's part as a call in flight (the grace period when it stops), with the press's notification
   * principal (`CurrentPrincipal`), admitted by the execution gateway first, within `NOTIFY_ACTION_TIMEOUT_MS`, after
   * the press has claimed the notification. A failure leaves the notification as it was. **Idempotent by notification
   * id**: after a store failure on the outcome's write, the same press may be made again and the handler runs again.
   */
  readonly run: (press: ActionPress) => Effect.Effect<ActionAnswer | void, unknown>
}

/**
 * Why a call failed. `unavailable`: no notification service here (the CLI modes); `invalid`: the request is wrong
 * (a bound, an unknown handler, `origin` without a device to deliver to); `limit`: `MAX_OPEN_PER_MODULE` or
 * `MAX_OPEN_TOTAL` open notifications already; `busy`: the store was busy, try again; `failed`: the store said no.
 */
export class NotifyError extends Schema.TaggedError<NotifyError>()("NotifyError", {
  reason: Schema.Literals(["unavailable", "invalid", "limit", "busy", "failed"]),
  message: Schema.String
}) {}

/** `ctx.notify` of a version 2 module. Every call dies with `ModuleStopped` once the part it was given to has closed. */
export interface ModuleNotify {
  /** Store it and deliver it now (one synchronous transaction and an enqueue: the cost of a call on a turn). */
  readonly send: (request: NotifyRequest) => Effect.Effect<SendResult, NotifyError>
  /** Resolve one of this module's open notifications (by id or key). False: none such, or it had ended. */
  readonly resolve: (target: string | { readonly key: string }, outcome?: string) => Effect.Effect<boolean, NotifyError>
  /** This module's open notifications, oldest first (`NotifyListQuery`). */
  readonly list: (query?: NotifyListQuery) => Effect.Effect<ReadonlyArray<Notification>, NotifyError>
  /** Register the action handler `name` during `shared` (a registration of the part: published and withdrawn with the module). */
  readonly handle: (name: string, handler: NotifyActionHandler) => Effect.Effect<void, NotifyError>
  /** Do not disturb, for the house. */
  readonly dnd: {
    readonly get: Effect.Effect<DndState, NotifyError>
    /** On, until it is cleared or until `until` (at most `MAX_DND_MS` ahead). */
    readonly set: (options?: { readonly until?: number }) => Effect.Effect<DndState, NotifyError>
    readonly clear: Effect.Effect<DndState, NotifyError>
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Speech outside a reply

/** Where an announcement is spoken: one device, a room's devices (by `place.room`), or every known device. */
export type SpeechTarget = { readonly device: string } | { readonly room: string } | "everywhere"

export interface SpeechOptions {
  /** A short chime first, made by the server and played with the announcement. Default false. */
  readonly cue?: boolean
  /** Personal content: whose (a Members id), checked by `Privacy.mayReveal` for each device when it is about to speak. */
  readonly owner?: string
}

/** Why one device does not get it, from `decideDelivery` (or `busy`: its queue was full). */
export type NotDelivered = NotDeliveredWhy | "busy"

export interface SpeechDelivery {
  readonly deviceId: string
  readonly queued: boolean
  readonly why?: NotDelivered
}

/** How it ended on one device: spoken to its end, stopped (or cut by a reply), not spoken (`why`), or the audio failed. */
export interface SpeechDeviceOutcome {
  readonly deviceId: string
  readonly outcome: "spoken" | "stopped" | "skipped" | "failed"
  readonly why?: NotDelivered | string
}

export interface SpeechHandle {
  readonly id: string
  /** What was decided when it was asked for, per device of the target. */
  readonly deliveries: ReadonlyArray<SpeechDelivery>
  /**
   * The outcome on every device, once each has spoken it, stopped it or skipped it. Outside a turn only: inside a
   * model turn (a tool, an action) it fails `in-turn` at once, because the reply it belongs to is what it waits for.
   */
  readonly done: Effect.Effect<ReadonlyArray<SpeechDeviceOutcome>, SpeechError>
  /** Stop it everywhere, in one step: taken out of every queue, and silenced where it is being spoken. */
  readonly stop: Effect.Effect<void>
}

/**
 * `unavailable`: no speech here (the CLI modes); `invalid`: an empty or too long text, an unknown device; `no-device`:
 * the target names no known device (a room nobody is in); `in-turn`: `done` was awaited inside a turn.
 */
export class SpeechError extends Schema.TaggedError<SpeechError>()("SpeechError", {
  reason: Schema.Literals(["unavailable", "invalid", "no-device", "in-turn"]),
  message: Schema.String
}) {}

/** `ctx.speech` of a version 2 module. */
export interface ModuleSpeech {
  /** One announcement, queued on each device of the target that may speak it now (an enqueue: the cost on a turn). */
  readonly say: (target: SpeechTarget, text: string, options?: SpeechOptions) => Effect.Effect<SpeechHandle, SpeechError>
}

// ---------------------------------------------------------------------------------------------------------------------
// Stored data (`core.notify`)

const ModuleIdText = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_.-]{1,64}$/))
const IdText = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_.:-]{1,64}$/))
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(NOTIFY_TEXT))
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))

/**
 * One notification's stored value, with the index fields derived from it on every write (`withIndexes` in the
 * engine), so they never disagree with it:
 *
 * | field | value | present | index | read by |
 * |---|---|---|---|---|
 * | `dedupe` | `"<module>|<key>"` | open, with a key | `dedupe` | `send` and `resolve` with a key |
 * | `liveModule` | the module | open | `[liveModule, sentAt]` | `list` |
 * | `state`, `sentAt` | | always | `[state, sentAt]` | reconciliation, the maintenance job's sweep, the recount |
 * | `state`, `finishedAt` | | resolved | `[state, finishedAt]` | retention, oldest first |
 *
 * `claim` is a module action under way (the action, the device, when): one at a time per notification.
 */
export const StoredNotification = Schema.Struct({
  module: ModuleIdText,
  state: Schema.Literals(["open", "resolved"]),
  key: Schema.optionalKey(Schema.String.check(Schema.isPattern(NOTIFY_KEY))),
  title: Text(MAX_NOTIFICATION_TITLE_CHARS),
  text: Schema.optionalKey(Text(MAX_NOTIFICATION_TEXT_CHARS)),
  priority: Schema.Literals(["normal", "ring"]),
  owner: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/))),
  target: Schema.Literals(["origin", "everywhere"]),
  deviceId: Schema.optionalKey(IdText),
  actions: Schema.Array(Schema.Struct({ id: Schema.String.check(Schema.isPattern(NOTIFICATION_ACTION_ID)), label: Text(MAX_NOTIFICATION_LABEL_CHARS) })).check(
    Schema.isMaxLength(MAX_NOTIFICATION_ACTIONS)
  ),
  handler: Schema.optionalKey(Schema.String.check(Schema.isPattern(NOTIFY_HANDLER_NAME))),
  sentAt: Time,
  expiresAt: Time,
  claim: Schema.optionalKey(Schema.Struct({ action: Schema.String.check(Schema.isPattern(NOTIFICATION_ACTION_ID)), by: IdText, at: Time })),
  outcome: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,40}$/))),
  finishedAt: Schema.optionalKey(Time),
  resolvedBy: Schema.optionalKey(IdText),
  // Index fields (derived).
  dedupe: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(130))),
  liveModule: Schema.optionalKey(ModuleIdText)
})
export type StoredNotification = typeof StoredNotification.Type

/**
 * The most characters of a row's JSON: the worst legal row (every free text at its bound with the costliest
 * characters, two actions, a claim, every optional field) is under 2,000; the contract's "the worst legal row fits"
 * builds it. So one `list` reads at most `maxListRows(notifications)` = 12 rows (`MAX_NOTIFY_PAGE`).
 */
export const NOTIFY_MAX_CHARS = 2_000

export const notifications = defineCollection({
  name: "notifications",
  scope: "household",
  schema: StoredNotification,
  maxChars: NOTIFY_MAX_CHARS,
  indexes: ["dedupe", ["liveModule", "sentAt"], ["state", "sentAt"], ["state", "finishedAt"]]
})

/** The page of `list`, and of every sweep of the engine. */
export const MAX_NOTIFY_PAGE = maxListRows(notifications)

/** Open notifications: `total`, and one row per module (`m:<module>`), so each limit is one read. */
export const NotifyCount = Schema.Struct({ live: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })) })
export const notifyCounts = defineCollection({ name: "notify_counts", scope: "household", schema: NotifyCount, maxChars: 100 })

/** Do not disturb (one row, `house`). */
export const StoredDnd = Schema.Struct({ on: Schema.Boolean, until: Schema.optionalKey(Time), setAt: Time })
export const notifyDnd = defineCollection({ name: "notify_dnd", scope: "household", schema: StoredDnd, maxChars: 200 })

/** The service's data, prepared with the modules' (and the scheduler's) in serve mode, the CLI modes and the test kit. */
export const notifyStorage: CoreStorage = { owner: NOTIFY_OWNER, storage: { version: 1, collections: [notifications, notifyCounts, notifyDnd] } }

// ---------------------------------------------------------------------------------------------------------------------
// The module host's side

/** What a version 2 part gets: its `ctx.notify` and `ctx.speech` (`ModuleHostOptions.notify`, made in `servicesFor`). */
export interface NotifyHook {
  readonly forPart: (part: PartHandle, runner: PartRunner) => { readonly notify: ModuleNotify; readonly speech: ModuleSpeech }
}

/** A notification ringing on a device (what P7's `ringing` window and "stop" read). */
export interface RingingNotification {
  readonly id: string
  readonly module: string
  readonly title: string
  readonly actions: ReadonlyArray<NotifyAction>
}

/** Where a press comes from (a page's button; later P7's ringing phrases; the kit). */
export interface PressRequest {
  readonly notificationId: string
  readonly actionId: string
  readonly deviceId: string
  /** The connection it came on: it must hold the notification. Absent (P7, the kit): one of the device's must. */
  readonly connection?: ConnectionRef
  readonly person?: TurnPerson
}

/** What a press came to: `ok` when it ran (or `stop` resolved it); `say`: the sentence to show, in the household's language. */
export interface PressAnswer {
  readonly ok: boolean
  readonly say: string
  /**
   * Why it did not run: `not_running` (its handler is not published), `unknown` (no such notification or action here,
   * or not held by that connection), `busy` (another action of it is under way), `failed` (a store or handler failure).
   */
  readonly code?: "not_running" | "unknown" | "busy" | "failed"
}

/** The module-facing calls of a mode without the service (the CLI modes): `handle` succeeds, everything else is `unavailable`. */
export const closedModuleNotify = (reason: string): { readonly notify: ModuleNotify; readonly speech: ModuleSpeech } => {
  const failed = Effect.fail(new NotifyError({ reason: "unavailable", message: reason }))
  return {
    notify: {
      send: () => failed,
      resolve: () => failed,
      list: () => failed,
      handle: () => Effect.void,
      dnd: { get: failed, set: () => failed, clear: failed }
    },
    speech: { say: () => Effect.fail(new SpeechError({ reason: "unavailable", message: reason })) }
  }
}
