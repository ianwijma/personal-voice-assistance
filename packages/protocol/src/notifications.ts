import { Schema } from "effect"
import { type DeviceCapabilities, effectiveCapabilities } from "./capabilities.ts"
import { RequestId } from "./common.ts"
import { type DeviceSettings, speakerAllowedFrom } from "./devices.ts"

/**
 * Notifications on the wire (docs/MODULES-PLAN.md §4 P9, first version; docs/NOTIFICATIONS.md). Additive within
 * protocol 11: a voice page that does not know these messages ignores them (`decodeServerMessage` answers `Unknown`),
 * and a server never needs an answer to them, so an older page keeps working beside a newer server.
 *
 * - `notification.ring` (server → one voice connection): show this card (when `show`) and loop the page's ring cue
 *   (when `sound`). Sent by the server's reconciliation only (`reconcile(device)`): whenever what the connection should
 *   hold differs from what it was sent (a new notification, do not disturb beginning or ending, a hello).
 * - `notification.resolved` (server → every connection that holds it): take it down and stop its cue.
 * - `notification.action` (voice page → server, a request): a press on one of the card's buttons. `stop` is the
 *   host's; another action runs the owning module's handler. The `result` says whether it ran; its `say` is the
 *   sentence to show.
 *
 * Every text here passed the server's page boundary (`ModuleHost.pageText`) and is cut to the bounds below. This file
 * also holds the one delivery decision (`decideDelivery`) and a device's effective outputs (`deviceOutputsFrom`), so
 * the server and the web mock decide with the same functions.
 */

/** The longest title, in UTF-16 units (one line). */
export const MAX_NOTIFICATION_TITLE_CHARS = 60
/** The longest text, in UTF-16 units. */
export const MAX_NOTIFICATION_TEXT_CHARS = 200
/** The most actions a module may add to a notification; the host's `stop` comes on top. */
export const MAX_NOTIFICATION_ACTIONS = 2
/** The longest button label, in UTF-16 units (one line). */
export const MAX_NOTIFICATION_LABEL_CHARS = 20
/** The most cards that can be open for a device at once (the service's total bound): a page keeps every one. */
export const MAX_NOTIFICATION_CARDS = 64
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

/** The service's own words on the page, in the household's language (the page writes none of its own). */
export const NotificationPageTexts = Schema.Struct({
  /** The region's accessible name ("Notifications"). */
  region: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  /** Shown on a ringing card while the page has no audio ("Start audio to hear it."). */
  startAudio: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))
})
export type NotificationPageTexts = typeof NotificationPageTexts.Type

/** What a voice connection holds of one notification. */
export const NotificationCard = Schema.Struct({
  id: NotificationId,
  title: Schema.String.check(Schema.isMaxLength(MAX_NOTIFICATION_TITLE_CHARS)),
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_NOTIFICATION_TEXT_CHARS))),
  priority: Schema.Literals(["normal", "ring"]),
  /** Draw the card (the device can show one). */
  show: Schema.Boolean,
  /** Loop the ring cue (a ring, the device may make sound, do not disturb is off). */
  sound: Schema.Boolean,
  /** `stop` first, then the module's (at most `MAX_NOTIFICATION_ACTIONS`). */
  actions: Schema.Array(NotificationButton).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NOTIFICATION_ACTIONS + 1)),
  /** Epoch ms it was sent. */
  sentAt: Schema.Finite,
  texts: NotificationPageTexts
})
export type NotificationCard = typeof NotificationCard.Type

/** Server → one voice connection: hold (or update) this notification. */
export const NotificationRingMessage = Schema.Struct({
  type: Schema.Literal("notification.ring"),
  notification: NotificationCard
})

/** Server → each connection that holds it: it is over (`outcome`: `stop`, an action id, `expired`, `resolved`, `withdrawn`). */
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

// ---------------------------------------------------------------------------------------------------------------------
// The one delivery decision

/** What a device can do with what is delivered, now. */
export interface DeviceOutputs {
  /** It may make sound (its effective speaker). */
  readonly speak: boolean
  /** It can show a card. */
  readonly show: boolean
}

/**
 * A device's effective outputs, from one place: the owner's overrides (`noSpeaker`, `noDisplay`, its own else its
 * type's) first, then what it declared; a page that never declared anything (an older build) speaks and shows unless
 * an override says not.
 */
export const deviceOutputsFrom = (settings: Pick<DeviceSettings, "capabilities">, declared: DeviceCapabilities | undefined): DeviceOutputs => ({
  speak: speakerAllowedFrom(settings, declared),
  show: !settings.capabilities.noDisplay && (declared === undefined || effectiveCapabilities(declared, settings.capabilities).display !== undefined)
})

/** What the decision knows about one device, read when it is delivered. */
export interface DeliveryDevice {
  /** A voice page of it is connected now. */
  readonly connected: boolean
  /** `DeviceOutputs.speak`. */
  readonly canSpeak: boolean
  /** `DeviceOutputs.show`. */
  readonly canShow: boolean
}

export interface DeliveryInput {
  readonly kind: "notification" | "announcement"
  /** An announcement is `normal`. */
  readonly priority: "normal" | "ring"
  /** It has an owner (personal content). */
  readonly personal: boolean
  /** `Privacy.mayReveal(owner, device)`, asked just now for this device (true for household content). */
  readonly mayReveal: boolean
  /** Do not disturb is on now (or could not be read yet: then it counts as on). */
  readonly dnd: boolean
  readonly device: DeliveryDevice
}

/** Why a device does not get it. */
export type NotDeliveredWhy = "offline" | "private" | "cannot-show" | "cannot-speak" | "dnd"

export type Delivery =
  | { readonly deliver: false; readonly why: NotDeliveredWhy }
  /** `show`: a card; `sound`: the ring cue (a notification) or the spoken line (an announcement). */
  | { readonly deliver: true; readonly show: boolean; readonly sound: boolean }

/**
 * THE decision, for a notification or an announcement and one device, at the moment of delivery. Pure; nothing
 * else decides whether, where or how something is delivered (docs/NOTIFICATIONS.md, "The delivery table"):
 *
 * 1. not connected → `offline`;
 * 2. personal and the privacy rule says no for this device → `private`;
 * 3. an announcement: do not disturb → `dnd`; a device that may not speak → `cannot-speak`; else spoken;
 * 4. a `normal` notification: a card, silent, where it can be shown (else `cannot-show`), whatever do not disturb says;
 * 5. a `ring`: a card where it can be shown, and the cue where the device may make sound and do not disturb is off;
 *    neither → `dnd` when only do not disturb kept the sound away, else `cannot-show`.
 */
export const decideDelivery = (input: DeliveryInput): Delivery => {
  const d = input.device
  if (!d.connected) return { deliver: false, why: "offline" }
  if (input.personal && !input.mayReveal) return { deliver: false, why: "private" }
  if (input.kind === "announcement") {
    if (input.dnd) return { deliver: false, why: "dnd" }
    if (!d.canSpeak) return { deliver: false, why: "cannot-speak" }
    return { deliver: true, show: false, sound: true }
  }
  if (input.priority === "normal") return d.canShow ? { deliver: true, show: true, sound: false } : { deliver: false, why: "cannot-show" }
  const sound = d.canSpeak && !input.dnd
  if (!d.canShow && !sound) return { deliver: false, why: d.canSpeak && input.dnd ? "dnd" : "cannot-show" }
  return { deliver: true, show: d.canShow, sound }
}
