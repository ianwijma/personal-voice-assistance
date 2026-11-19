import { Schema } from "effect"
import { type DeviceCapabilities, effectiveCapabilities } from "./capabilities.ts"
import { RequestId } from "./common.ts"
import type { DeviceSettings } from "./devices.ts"

/**
 * Presentations on the wire (docs/MODULES-PLAN.md §4 P10, first version; docs/PRESENTING.md). Additive within protocol
 * 11: a voice page that does not know these messages ignores them (`decodeServerMessage` answers `Unknown`), and the
 * server never needs an answer to them. A page shows presentations only after it declared the kinds it draws
 * (`hello.device.capabilities.present.kinds`); a page that declares none (every page before this one) is sent none.
 *
 * - `present.show` (server → one voice connection): hold this presentation (it did not hold it).
 * - `present.update` (server → one voice connection that holds it): its content or form changed; replace it.
 * - `present.dismiss` (server → every connection that holds it): take it down.
 * - `present.action` (voice page → server, a request): a tick on a checklist item or a press on a button. Answered
 *   with `result` (`say`: the sentence to show).
 *
 * Every text here passed the server's page boundary (`ModuleHost.pageText`) and is cut to the bounds below; a page
 * inserts none of it as markup. This file also holds the one decision (`decidePresentation`), a device's presentation
 * outputs (`devicePresentFrom`) and what a device shows of what applies to it (`selectPresentations`), so the server
 * and the web mock decide with the same functions.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Kinds and bounds

/** The kinds of the first version and the version of each the server sends. A page declares what it draws. */
export const PRESENT_KIND_VERSIONS = { card: 1, list: 1, timer: 1, image: 1, weather: 1 } as const
export type PresentKindName = keyof typeof PRESENT_KIND_VERSIONS
export const PRESENT_KIND_NAMES: ReadonlyArray<PresentKindName> = ["card", "list", "timer", "image", "weather"]

/** A card's or a list's title: one line. */
export const MAX_PRESENT_TITLE_CHARS = 60
/** A card's text. */
export const MAX_PRESENT_TEXT_CHARS = 300
/** Facts on a card, each a label and a value (one line each). */
export const MAX_PRESENT_FACTS = 6
export const MAX_FACT_LABEL_CHARS = 30
export const MAX_FACT_VALUE_CHARS = 60
/** Items of a list (one line each). */
export const MAX_LIST_ITEMS = 12
export const MAX_LIST_ITEM_CHARS = 80
/** A list item's id: what a tick names. */
export const LIST_ITEM_ID = /^[A-Za-z0-9_.:-]{1,40}$/
/** A timer's label: one line. */
export const MAX_TIMER_LABEL_CHARS = 40
/** A timer's end is at most this far ahead (and at most a minute in the past) when it is shown or updated. */
export const MAX_TIMER_AHEAD_MS = 24 * 3_600_000
/** An image's address (`https:` only, printable ASCII): the server fetches it, never the page. */
export const MAX_IMAGE_URL_CHARS = 2_000
export const MAX_IMAGE_ALT_CHARS = 200
/** An image's credit: one line (who made it, its licence). Required. */
export const MAX_IMAGE_CREDIT_CHARS = 120
export const MAX_IMAGE_CAPTION_CHARS = 200
/** Weather: the place (one line), a temperature ("12°", "54 °F") and a condition ("Light rain"), at most five days. */
export const MAX_WEATHER_PLACE_CHARS = 40
export const MAX_WEATHER_VALUE_CHARS = 12
export const MAX_WEATHER_CONDITION_CHARS = 40
export const MAX_WEATHER_DAYS = 5
export const MAX_WEATHER_DAY_LABEL_CHARS = 12
/** The closed set of weather symbols the page draws. */
export const WEATHER_ICONS = ["sun", "partly", "cloud", "rain", "snow", "storm", "fog", "wind", "night"] as const
export type WeatherIcon = (typeof WEATHER_ICONS)[number]
/** Buttons a module may add (a tick on a checklist item is not a button). */
export const MAX_PRESENT_BUTTONS = 3
export const MAX_PRESENT_LABEL_CHARS = 20
/** A button's id; `tick` is the host's (a checklist item ticked or unticked). */
export const PRESENT_ACTION_ID = /^[a-z][a-z0-9_]{0,31}$/
export const TICK_ACTION = "tick"
/** What the model hears instead when nothing can be shown: required on every presentation. */
export const MAX_SPOKEN_CHARS = 300
/** A presentation's id on the wire: what the server made. */
export const PRESENTATION_ID = /^[A-Za-z0-9_-]{1,64}$/
/** Pinned presentations a device shows at most (and that may be pinned for one device; `limit` past it). */
export const MAX_PINNED_PER_DEVICE = 8
/** The most a page is ever sent at once: its pinned ones and one transient. */
export const MAX_PRESENTATIONS_PER_PAGE = MAX_PINNED_PER_DEVICE + 1
/** A content hash as `/media/<hash>` names it (SHA-256, lower-case hex). */
export const MEDIA_HASH = /^[0-9a-f]{64}$/

const line = (max: number) => Schema.String.check(Schema.isMaxLength(max))
export const PresentationId = Schema.String.check(Schema.isPattern(PRESENTATION_ID))

export const PresentButton = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(PRESENT_ACTION_ID)),
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PRESENT_LABEL_CHARS))
})
export type PresentButton = typeof PresentButton.Type

export const CardContent = Schema.Struct({
  kind: Schema.Literal("card"),
  title: line(MAX_PRESENT_TITLE_CHARS),
  text: Schema.optionalKey(line(MAX_PRESENT_TEXT_CHARS)),
  facts: Schema.Array(Schema.Struct({ label: line(MAX_FACT_LABEL_CHARS), value: line(MAX_FACT_VALUE_CHARS) })).check(Schema.isMaxLength(MAX_PRESENT_FACTS))
})

export const ListContent = Schema.Struct({
  kind: Schema.Literal("list"),
  title: line(MAX_PRESENT_TITLE_CHARS),
  style: Schema.Literals(["bullets", "checklist"]),
  items: Schema.Array(Schema.Struct({
    id: Schema.String.check(Schema.isPattern(LIST_ITEM_ID)),
    text: line(MAX_LIST_ITEM_CHARS),
    done: Schema.Boolean
  })).check(Schema.isMaxLength(MAX_LIST_ITEMS))
})

export const TimerContent = Schema.Struct({
  kind: Schema.Literal("timer"),
  label: line(MAX_TIMER_LABEL_CHARS),
  /** The server's epoch ms when it ends; the page counts down from it, corrected for its own clock (`serverNow`). */
  endsAt: Schema.Finite
})

/** An image as a page gets it: `/media/<hash>` once the server has it, else loading or failed (shown without it). */
export const ImageState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("loading") }),
  Schema.Struct({ state: Schema.Literal("ready"), hash: Schema.String.check(Schema.isPattern(MEDIA_HASH)) }),
  Schema.Struct({ state: Schema.Literal("failed") })
])
export type ImageState = typeof ImageState.Type

export const ImageContent = Schema.Struct({
  kind: Schema.Literal("image"),
  alt: line(MAX_IMAGE_ALT_CHARS),
  credit: line(MAX_IMAGE_CREDIT_CHARS),
  caption: Schema.optionalKey(line(MAX_IMAGE_CAPTION_CHARS)),
  image: ImageState
})

const Icon = Schema.Literals(WEATHER_ICONS)
export const WeatherContent = Schema.Struct({
  kind: Schema.Literal("weather"),
  place: line(MAX_WEATHER_PLACE_CHARS),
  now: Schema.Struct({ temperature: line(MAX_WEATHER_VALUE_CHARS), condition: line(MAX_WEATHER_CONDITION_CHARS), icon: Icon }),
  days: Schema.Array(Schema.Struct({
    label: line(MAX_WEATHER_DAY_LABEL_CHARS),
    high: line(MAX_WEATHER_VALUE_CHARS),
    low: line(MAX_WEATHER_VALUE_CHARS),
    icon: Icon
  })).check(Schema.isMaxLength(MAX_WEATHER_DAYS))
})

export const PresentContent = Schema.Union([CardContent, ListContent, TimerContent, ImageContent, WeatherContent])
export type PresentContent = typeof PresentContent.Type

/** The host's own words on the stage, in the household's language (the page writes none of its own). */
export const PresentPageTexts = Schema.Struct({
  /** The stage region's accessible name ("On screen"). */
  region: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  /** While an image is fetched. */
  loading: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  /** An image that could not be fetched or was refused. */
  imageMissing: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  /** A timer at zero. */
  timerDone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  /** Before a credit ("Image:"). */
  credit: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  /** Weather: the day's high and low ("High", "Low"). */
  high: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  low: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20))
})
export type PresentPageTexts = typeof PresentPageTexts.Type

/** What a voice connection holds of one presentation. */
export const PresentationWire = Schema.Struct({
  id: PresentationId,
  /** `pinned` stays until it is dismissed or ends (restored after a reconnect); `transient`: one at a time, briefly. */
  lifetime: Schema.Literals(["transient", "pinned"]),
  /** Epoch ms it was shown (the server's clock). */
  shownAt: Schema.Finite,
  /** The server's clock (epoch ms) when this message was made: a countdown corrects the page's clock by it. */
  serverNow: Schema.Finite,
  /** The kind's version (`PRESENT_KIND_VERSIONS`). */
  v: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  content: PresentContent,
  buttons: Schema.Array(PresentButton).check(Schema.isMaxLength(MAX_PRESENT_BUTTONS)),
  /** Ticks and buttons may be pressed here (the decision, and a handler named). */
  interactive: Schema.Boolean,
  texts: PresentPageTexts
})
export type PresentationWire = typeof PresentationWire.Type

/** Server → one voice connection: hold this presentation. */
export const PresentShowMessage = Schema.Struct({ type: Schema.Literal("present.show"), presentation: PresentationWire })
/** Server → a voice connection that holds it: replace it. */
export const PresentUpdateMessage = Schema.Struct({ type: Schema.Literal("present.update"), presentation: PresentationWire })
/** Server → every connection that holds it: take it down. */
export const PresentDismissMessage = Schema.Struct({ type: Schema.Literal("present.dismiss"), id: PresentationId })

/** Voice page → server, a request: a tick (`action: "tick"`, `item`, `done`) or a button (`action`: its id). */
export const PresentAction = Schema.Struct({
  type: Schema.Literal("present.action"),
  requestId: RequestId,
  id: PresentationId,
  action: Schema.String.check(Schema.isPattern(PRESENT_ACTION_ID)),
  item: Schema.optionalKey(Schema.String.check(Schema.isPattern(LIST_ITEM_ID))),
  done: Schema.optionalKey(Schema.Boolean)
})

// ---------------------------------------------------------------------------------------------------------------------
// The one decision

/** What a device can do with a presentation, now. */
export interface DevicePresentOutputs {
  /** It has a display (declared, and not taken away by the owner). */
  readonly display: boolean
  /** The kinds it draws (declared, minus those the owner excluded), kind → highest version. */
  readonly kinds: Readonly<Record<string, number>>
  /** Something can be pressed on it (a touch screen or a pointer). */
  readonly touch: boolean
}

/**
 * A device's presentation outputs, from one place: what it declared, minus the owner's overrides (`noDisplay`,
 * `excludeKinds`, its own else its type's) through `effectiveCapabilities`. A page that never declared anything (an
 * older build, which does not know presentations) has none.
 */
export const devicePresentFrom = (settings: Pick<DeviceSettings, "capabilities">, declared: DeviceCapabilities | undefined): DevicePresentOutputs => {
  const caps = effectiveCapabilities(declared, settings.capabilities)
  const display = caps.display !== undefined
  return { display, kinds: display ? caps.present?.kinds ?? {} : {}, touch: display && caps.display!.touch !== "none" }
}

export interface PresentDecisionInput {
  readonly kind: PresentKindName
  /** It has an owner (personal content). */
  readonly personal: boolean
  /** `Privacy.mayReveal(owner, device)`, asked just now for this device (true for household content). */
  readonly mayReveal: boolean
  readonly device: { readonly connected: boolean } & DevicePresentOutputs
}

export type NotShownWhy = "offline" | "private" | "no-display" | "cannot-show-kind"

export type PresentDecision =
  | { readonly show: false; readonly why: NotShownWhy }
  /** `interactive`: its ticks and buttons may be pressed here. */
  | { readonly show: true; readonly interactive: boolean }

/**
 * THE decision for one presentation and one device, at the moment of showing. Pure; nothing else decides whether a
 * device shows a presentation or in what form (docs/PRESENTING.md, "The decision"):
 *
 * 1. not connected → `offline`;
 * 2. personal and the privacy rule says no for this device → `private`;
 * 3. no display → `no-display`;
 * 4. the page does not draw this kind at this version (or the owner excluded it) → `cannot-show-kind`;
 * 5. shown; pressable where the device has touch or a pointer.
 */
export const decidePresentation = (input: PresentDecisionInput): PresentDecision => {
  const d = input.device
  if (!d.connected) return { show: false, why: "offline" }
  if (input.personal && !input.mayReveal) return { show: false, why: "private" }
  if (!d.display) return { show: false, why: "no-display" }
  const version = d.kinds[input.kind]
  if (typeof version !== "number" || version < PRESENT_KIND_VERSIONS[input.kind]) return { show: false, why: "cannot-show-kind" }
  return { show: true, interactive: d.touch }
}

/** One presentation that applies to a device, with its decision there now. */
export interface PresentCandidate {
  readonly id: string
  readonly lifetime: "transient" | "pinned"
  readonly shownAt: number
  readonly decision: PresentDecision
}

/**
 * What a device shows of the presentations that apply to it now: its pinned ones the decision allows, oldest first, at
 * most `MAX_PINNED_PER_DEVICE`, and the newest transient the decision allows (one at a time). Pure; the server's
 * reconciliation and the web mock both use it. Ties by id, so the answer never depends on the input's order.
 */
export const selectPresentations = (candidates: ReadonlyArray<PresentCandidate>): ReadonlyArray<PresentCandidate & { readonly decision: { readonly show: true; readonly interactive: boolean } }> => {
  type Shown = PresentCandidate & { readonly decision: { readonly show: true; readonly interactive: boolean } }
  const allowed = candidates.filter((c): c is Shown => c.decision.show)
  const order = (a: PresentCandidate, b: PresentCandidate) => a.shownAt - b.shownAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const pinned = allowed.filter((c) => c.lifetime === "pinned").sort(order).slice(0, MAX_PINNED_PER_DEVICE)
  const transient = allowed.filter((c) => c.lifetime === "transient").sort(order).at(-1)
  return transient === undefined ? pinned : [...pinned, transient]
}
