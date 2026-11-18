import { Schema } from "effect"
import { RequestId } from "./common.ts"

/**
 * Notifications on the wire (docs/MODULES-PLAN.md §4 P9, first version; docs/NOTIFICATIONS.md). Additive within
 * protocol 11: a voice page that does not know these messages ignores them (`decodeServerMessage` answers `Unknown`),
 * and a server never needs an answer to them, so an older page keeps working beside a newer server.
 *
 * - `notification.ring` (server → the voice connections of one device): show this notification's card, and loop the
 *   page's ring cue while it is not `silent`. Sent when it is delivered, again to a connection that says hello while it
 *   is open, and again when what the card shows changes (do not disturb began or ended: `silent`).
 * - `notification.resolved` (server → every connection it was sent to): take the card down and stop the cue.
 * - `notification.action` (voice page → server, a request): a press on one of the card's buttons. `stop` is the
 *   host's and always works; another action runs the owning module's handler. The `result` says whether it ran; its
 *   `say` is the sentence to show (the module's, or "I can't do that right now").
 *
 * Every text here passed the server's page boundary (`ModuleHost.pageText`) and is cut to the bounds below.
 */

/** The longest title, in UTF-16 units (one line). */
export const MAX_NOTIFICATION_TITLE_CHARS = 60
/** The longest text, in UTF-16 units. */
export const MAX_NOTIFICATION_TEXT_CHARS = 200
/** The most actions a module may add to a notification; the host's `stop` comes on top. */
export const MAX_NOTIFICATION_ACTIONS = 2
/** The longest button label, in UTF-16 units (one line). */
export const MAX_NOTIFICATION_LABEL_CHARS = 20
/** An action id: lower case letters, digits and `_`, starting with a letter, at most 32 (`stop` is the host's). */
export const NOTIFICATION_ACTION_ID = /^[a-z][a-z0-9_]{0,31}$/
/** The host's action: silence and resolve. It is on every card, first. */
export const STOP_ACTION = "stop"
/** A notification's id on the wire: what the server made (1–64 of `[A-Za-z0-9_-]`). */
export const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/

export const NotificationId = Schema.String.check(Schema.isPattern(NOTIFICATION_ID))
export const NotificationActionId = Schema.String.check(Schema.isPattern(NOTIFICATION_ACTION_ID))

/** One button: its id and its label in the household's language. */
export const NotificationButton = Schema.Struct({
  id: NotificationActionId,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTIFICATION_LABEL_CHARS))
})
export type NotificationButton = typeof NotificationButton.Type

/** What a voice page shows of one notification. */
export const NotificationCard = Schema.Struct({
  id: NotificationId,
  title: Schema.String.check(Schema.isMaxLength(MAX_NOTIFICATION_TITLE_CHARS)),
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_NOTIFICATION_TEXT_CHARS))),
  priority: Schema.Literals(["normal", "ring"]),
  /** No cue: a `normal` notification, a `ring` under do not disturb, or a device that may not make sound. */
  silent: Schema.Boolean,
  /** `stop` first, then the module's (at most `MAX_NOTIFICATION_ACTIONS`). */
  actions: Schema.Array(NotificationButton).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTIFICATION_ACTIONS + 1)),
  /** Epoch ms it was delivered (sent, or due when it was sent for later). */
  sentAt: Schema.Finite
})
export type NotificationCard = typeof NotificationCard.Type

/** Server → a device's voice connections: show (or update) this card. */
export const NotificationRingMessage = Schema.Struct({
  type: Schema.Literal("notification.ring"),
  notification: NotificationCard
})

/** Server → the connections it rang on: the notification is over (`outcome`: `stop`, an action id, `expired`, `resolved`). */
export const NotificationResolvedMessage = Schema.Struct({
  type: Schema.Literal("notification.resolved"),
  id: NotificationId,
  outcome: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40)))
})

/** Voice page → server, a request: a press on a card's button. Answered with `result` (`say`: what to show). */
export const NotificationAction = Schema.Struct({
  type: Schema.Literal("notification.action"),
  requestId: RequestId,
  id: NotificationId,
  actionId: NotificationActionId
})
