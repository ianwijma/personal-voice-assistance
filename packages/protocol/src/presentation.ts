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
 * - `present.close` (voice page → server, a request; additive within protocol 12): the viewer closed it on the page
 *   (its close button, or Escape). Sent only for a presentation the server marked `closable`, so an older server, which
 *   never marks one, is never sent it. The Presenter dismisses it as a module's dismissal does: every connection that
 *   holds it is sent `present.dismiss`. Answered with `result` (`say` only on a refusal: the page shows it again).
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
/** Live presentations of all modules together at most; one more is refused `limit` (the server and the web mock). */
export const MAX_LIVE_TOTAL = 32
/** Live presentations of one module at most (transient and pinned); one more is refused `limit`. */
export const MAX_LIVE_PER_MODULE = 8
/** The most a page is ever sent at once: its pinned ones and one transient. */
export const MAX_PRESENTATIONS_PER_PAGE = MAX_PINNED_PER_DEVICE + 1
/** A content hash as the server's image cache keeps it (SHA-256, lower-case hex). Never sent to a page. */
export const MEDIA_HASH = /^[0-9a-f]{64}$/
/**
 * An image address of one page: `/media/<token>`, a random token the server made for that connection and that image,
 * served only while that connection is open and holds a presentation with that image.
 */
export const MEDIA_TOKEN = /^[A-Za-z0-9_-]{32}$/

const line = (max: number) => Schema.String.check(Schema.isMaxLength(max))
export const PresentationRevision = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_:-]{1,96}$/))
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

/** An image as a page gets it: `/media/<token>` (this page's own address) once the server has it, else loading or failed. */
export const ImageState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("loading") }),
  Schema.Struct({ state: Schema.Literal("ready"), token: Schema.String.check(Schema.isPattern(MEDIA_TOKEN)) }),
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
  /** A press without a server answer (optional for older servers). */
  failed: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60))),
  /** The close button's accessible name ("Close"); sent with every `closable` presentation (absent from older servers). */
  close: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(30))),
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
  /** The displayed showing and content revision; echoed by every press. */
  revision: PresentationRevision,
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
  /**
   * The viewer may close it here (`present.close`): the decision lets it be pressed on this device (a touch screen or a
   * pointer), whether or not it has a handler. Optional, additive within protocol 12: an older server never sends it,
   * so a newer page shows no close button there and never sends `present.close` to a server that does not know it;
   * an older page ignores the key.
   */
  closable: Schema.optionalKey(Schema.Boolean),
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
  /** The displayed showing and content revision; echoed by every press. */
  revision: PresentationRevision,
  action: Schema.String.check(Schema.isPattern(PRESENT_ACTION_ID)),
  item: Schema.optionalKey(Schema.String.check(Schema.isPattern(LIST_ITEM_ID))),
  done: Schema.optionalKey(Schema.Boolean)
})

/**
 * Voice page → server, a request (additive within protocol 12): the viewer closed this presentation on the page. Only
 * for one the server marked `closable` for this connection; `revision` is the displayed one (its show must still be the
 * current show of the id: a keyed replacement the page has not drawn yet is not closed unseen).
 */
export const PresentClose = Schema.Struct({
  type: Schema.Literal("present.close"),
  requestId: RequestId,
  id: PresentationId,
  revision: PresentationRevision
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

// ---------------------------------------------------------------------------------------------------------------------
// What a module shows, and its checks (the server and the web mock run the same ones)

/** Line breaks, control characters and bidirectional overrides: never in a one-line value (the core's `NOT_ONE_LINE`). */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u
/**
 * Storable text: no control character other than tab, line feed, carriage return, backspace and form feed, and no lone
 * surrogate (the core's `NOTIFY_TEXT`), so each UTF-16 unit costs at most two characters of JSON.
 */
export const PRESENT_TEXT = /^[^\u0000-\u0007\u000b\u000e-\u001f\u007f-\u009f\ud800-\udfff]*$/u

/** A transient presentation stays this long when the module says nothing, at least `PRESENT_MIN_EXPIRY_MS`, at most 5 minutes. */
export const PRESENT_DEFAULT_EXPIRY_MS = { transient: 30_000, pinned: 4 * 3_600_000 } as const
export const PRESENT_MAX_EXPIRY_MS = { transient: 5 * 60_000, pinned: 24 * 3_600_000 } as const
export const PRESENT_MIN_EXPIRY_MS = 3_000
/** A pinned timer that says nothing stays until this long after it ends. */
export const TIMER_GRACE_MS = 10 * 60_000
/** A key: one presentation per module and key (showing it again replaces it). */
export const PRESENT_KEY = /^[A-Za-z0-9_.:@/-]{1,64}$/
/** A press handler's name (`present.handle`). */
export const PRESENT_HANDLER_NAME = /^[a-z][a-z0-9_.-]{0,63}$/

/** One line, bounded, not blank, of storable text; or why not. */
const lineProblem = (text: unknown, max: number, what: string, optional = false): string | undefined => {
  if (text === undefined && optional) return undefined
  if (typeof text !== "string" || text.trim() === "") return `${what} must be text`
  if (text.length > max) return `${what} is at most ${max} characters`
  if (NOT_ONE_LINE.test(text) || !PRESENT_TEXT.test(text)) return `${what} must be one line`
  return undefined
}
/** Storable text (line breaks allowed), bounded; or why not. */
const textProblem = (text: unknown, max: number, what: string): string | undefined => {
  if (text === undefined) return undefined
  if (typeof text !== "string" || text.length > max || !PRESENT_TEXT.test(text)) return `${what} is at most ${max} characters, without control characters`
  return undefined
}

/** Whose it is: the household's (default), or one person's (a Members id), decided by `Privacy.mayReveal` per device. */
export type PresentSensitivity = "household" | { readonly personal: string }

export interface PresentButtonSpec {
  /** `PRESENT_ACTION_ID`, not `tick`. */
  readonly id: string
  /** One line, at most `MAX_PRESENT_LABEL_CHARS`. */
  readonly label: string
}

interface Common {
  /** What the model says instead where nothing is shown: one or two sentences, at most `MAX_SPOKEN_CHARS`. Required. */
  readonly spoken: string
  /** Default `household`. */
  readonly sensitivity?: PresentSensitivity
  /** At most `MAX_PRESENT_BUTTONS`, with `handler`. */
  readonly buttons?: ReadonlyArray<PresentButtonSpec>
  /** The module's press handler (`present.handle`, registered in `shared`): buttons and ticks reach it. */
  readonly handler?: string
}

export interface CardPresentation extends Common {
  readonly kind: "card"
  readonly title: string
  readonly text?: string
  readonly facts?: ReadonlyArray<{ readonly label: string; readonly value: string }>
}

export interface ListPresentation extends Common {
  readonly kind: "list"
  readonly title: string
  /** Default `bullets`. A checklist's ticks are pressable when a handler is named. */
  readonly style?: "bullets" | "checklist"
  readonly items: ReadonlyArray<{ readonly id: string; readonly text: string; readonly done?: boolean }>
}

export interface TimerPresentation extends Common {
  readonly kind: "timer"
  readonly label: string
  /** Epoch ms (the server's clock) it ends: from a minute ago to `MAX_TIMER_AHEAD_MS` ahead. */
  readonly endsAt: number
}

export interface ImagePresentation extends Common {
  readonly kind: "image"
  /** `https:`, printable ASCII, at most `MAX_IMAGE_URL_CHARS`: fetched once by the server (`/media/<hash>`), never by the page. */
  readonly url: string
  readonly alt: string
  /** Who made it, its licence: one line, required. */
  readonly credit: string
  readonly caption?: string
}

export interface WeatherPresentation extends Common {
  readonly kind: "weather"
  readonly place: string
  readonly now: { readonly temperature: string; readonly condition: string; readonly icon: WeatherIcon }
  readonly days?: ReadonlyArray<{ readonly label: string; readonly high: string; readonly low: string; readonly icon: WeatherIcon }>
}

export type Presentation = CardPresentation | ListPresentation | TimerPresentation | ImagePresentation | WeatherPresentation

/** `origin`: the device of the turn, job or press the call runs for; a device; or a room's devices (by `place.room`). */
export type PresentTarget = "origin" | { readonly device: string } | { readonly room: string }

export interface ShowOptions {
  /** Default `transient`, a timer `pinned`. */
  readonly lifetime?: "transient" | "pinned"
  /** It ends this long after it is shown. Default and bounds per lifetime (`PRESENT_DEFAULT_EXPIRY_MS`, `PRESENT_MAX_EXPIRY_MS`). */
  readonly expiresInMs?: number
  /** One presentation per module and key: showing the same key again replaces the earlier one (its target, content and lifetime). */
  readonly key?: string
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation (pure)

const PERSON_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
/** An image address the server may fetch: `https:`, printable ASCII without quotes, backslashes or spaces. */
export const IMAGE_URL = /^https:\/\/[\x21\x23-\x5b\x5d-\x7e]+$/

/** The fields a presentation of each kind may have (anything else is refused). */
const FIELDS: Readonly<Record<PresentKindName, ReadonlyArray<string>>> = {
  card: ["title", "text", "facts"],
  list: ["title", "style", "items"],
  timer: ["label", "endsAt"],
  image: ["url", "alt", "credit", "caption"],
  weather: ["place", "now", "days"]
}
const COMMON = ["kind", "spoken", "sensitivity", "buttons", "handler"]

/** Why `p` is not a presentation within the bounds (`now`: the server's clock, for a timer), or `undefined`. */
export const presentationProblem = (p: unknown, now: number): string | undefined => {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return "a presentation is an object"
  const v = p as Record<string, unknown>
  const kind = v.kind
  if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) return "kind is card, list, timer, image or weather"
  const fields = FIELDS[kind as PresentKindName]
  const extra = Object.keys(v).find((k) => !COMMON.includes(k) && !fields.includes(k))
  if (extra !== undefined) return `a ${kind} has no field ${extra}`
  if (typeof v.spoken !== "string" || v.spoken.trim() === "" || v.spoken.length > MAX_SPOKEN_CHARS || !PRESENT_TEXT.test(v.spoken)) {
    return `spoken (what is said where nothing is shown) is 1 to ${MAX_SPOKEN_CHARS} characters, without control characters`
  }
  const s = v.sensitivity
  if (s !== undefined && s !== "household") {
    if (typeof s !== "object" || s === null || Object.keys(s).join() !== "personal" || typeof (s as { personal?: unknown }).personal !== "string" || !PERSON_ID.test((s as { personal: string }).personal)) {
      return "sensitivity is household or { personal: <a Members id> }"
    }
  }
  const buttons = v.buttons ?? []
  if (!Array.isArray(buttons) || buttons.length > MAX_PRESENT_BUTTONS) return `at most ${MAX_PRESENT_BUTTONS} buttons`
  const ids = new Set<string>()
  for (const b of buttons as ReadonlyArray<unknown>) {
    const bb = b as { id?: unknown; label?: unknown } | null
    if (typeof bb !== "object" || bb === null || typeof bb.id !== "string" || !PRESENT_ACTION_ID.test(bb.id)) return `a button id must match ${PRESENT_ACTION_ID}`
    if (bb.id === TICK_ACTION) return "tick is the host's action on a checklist item"
    if (ids.has(bb.id)) return `the button ${bb.id} is named twice`
    ids.add(bb.id)
    const wrong = lineProblem(bb.label, MAX_PRESENT_LABEL_CHARS, `the label of ${bb.id}`)
    if (wrong !== undefined) return wrong
  }
  if (v.handler !== undefined && (typeof v.handler !== "string" || !PRESENT_HANDLER_NAME.test(v.handler))) return `handler must match ${PRESENT_HANDLER_NAME}`
  if (buttons.length > 0 && v.handler === undefined) return "buttons need a handler (present.handle)"
  switch (kind as PresentKindName) {
    case "card": {
      const t = lineProblem(v.title, MAX_PRESENT_TITLE_CHARS, "title") ?? textProblem(v.text, MAX_PRESENT_TEXT_CHARS, "text")
      if (t !== undefined) return t
      const facts = v.facts ?? []
      if (!Array.isArray(facts) || facts.length > MAX_PRESENT_FACTS) return `at most ${MAX_PRESENT_FACTS} facts`
      for (const f of facts as ReadonlyArray<{ label?: unknown; value?: unknown } | null>) {
        if (typeof f !== "object" || f === null) return "a fact is { label, value }"
        const w = lineProblem(f.label, MAX_FACT_LABEL_CHARS, "a fact's label") ?? lineProblem(f.value, MAX_FACT_VALUE_CHARS, "a fact's value")
        if (w !== undefined) return w
      }
      return undefined
    }
    case "list": {
      const t = lineProblem(v.title, MAX_PRESENT_TITLE_CHARS, "title")
      if (t !== undefined) return t
      if (v.style !== undefined && v.style !== "bullets" && v.style !== "checklist") return "style is bullets or checklist"
      if (!Array.isArray(v.items) || v.items.length > MAX_LIST_ITEMS) return `items is a list of at most ${MAX_LIST_ITEMS}`
      const seen = new Set<string>()
      for (const i of v.items as ReadonlyArray<{ id?: unknown; text?: unknown; done?: unknown } | null>) {
        if (typeof i !== "object" || i === null || typeof i.id !== "string" || !LIST_ITEM_ID.test(i.id)) return `an item's id must match ${LIST_ITEM_ID}`
        if (seen.has(i.id)) return `the item ${i.id} is named twice`
        seen.add(i.id)
        const w = lineProblem(i.text, MAX_LIST_ITEM_CHARS, "an item")
        if (w !== undefined) return w
        if (i.done !== undefined && typeof i.done !== "boolean") return "an item's done is true or false"
      }
      return undefined
    }
    case "timer": {
      const t = lineProblem(v.label, MAX_TIMER_LABEL_CHARS, "label")
      if (t !== undefined) return t
      if (typeof v.endsAt !== "number" || !Number.isInteger(v.endsAt) || v.endsAt < now - 60_000 || v.endsAt > now + MAX_TIMER_AHEAD_MS) {
        return `endsAt is a whole epoch ms from a minute ago to ${MAX_TIMER_AHEAD_MS / 3_600_000} hours ahead`
      }
      return undefined
    }
    case "image": {
      if (typeof v.url !== "string" || v.url.length > MAX_IMAGE_URL_CHARS || !IMAGE_URL.test(v.url)) return `url is an https address of at most ${MAX_IMAGE_URL_CHARS} printable characters`
      return lineProblem(v.alt, MAX_IMAGE_ALT_CHARS, "alt") ?? lineProblem(v.credit, MAX_IMAGE_CREDIT_CHARS, "credit") ?? lineProblem(v.caption, MAX_IMAGE_CAPTION_CHARS, "caption", true)
    }
    case "weather": {
      const t = lineProblem(v.place, MAX_WEATHER_PLACE_CHARS, "place")
      if (t !== undefined) return t
      const icon = (x: unknown) => typeof x === "string" && (WEATHER_ICONS as ReadonlyArray<string>).includes(x)
      const n = v.now as { temperature?: unknown; condition?: unknown; icon?: unknown } | null
      if (typeof n !== "object" || n === null || Object.keys(n).some((k) => !["temperature", "condition", "icon"].includes(k))) return "now is { temperature, condition, icon }"
      const w = lineProblem(n.temperature, MAX_WEATHER_VALUE_CHARS, "the temperature") ?? lineProblem(n.condition, MAX_WEATHER_CONDITION_CHARS, "the condition")
      if (w !== undefined) return w
      if (!icon(n.icon)) return `icon is one of ${WEATHER_ICONS.join(", ")}`
      const days = v.days ?? []
      if (!Array.isArray(days) || days.length > MAX_WEATHER_DAYS) return `at most ${MAX_WEATHER_DAYS} days`
      for (const d of days as ReadonlyArray<{ label?: unknown; high?: unknown; low?: unknown; icon?: unknown } | null>) {
        if (typeof d !== "object" || d === null || Object.keys(d).some((k) => !["label", "high", "low", "icon"].includes(k))) return "a day is { label, high, low, icon }"
        const dw = lineProblem(d.label, MAX_WEATHER_DAY_LABEL_CHARS, "a day's label") ?? lineProblem(d.high, MAX_WEATHER_VALUE_CHARS, "a day's high") ?? lineProblem(d.low, MAX_WEATHER_VALUE_CHARS, "a day's low")
        if (dw !== undefined) return dw
        if (!icon(d.icon)) return `icon is one of ${WEATHER_ICONS.join(", ")}`
      }
      return undefined
    }
  }
}

/** Why `o` are not show options within the bounds, or `undefined`. */
export const showOptionsProblem = (o: unknown, kind: PresentKindName | undefined): string | undefined => {
  if (o === undefined) return undefined
  if (typeof o !== "object" || o === null) return "options are an object"
  const v = o as Record<string, unknown>
  const extra = Object.keys(v).find((k) => !["lifetime", "expiresInMs", "key"].includes(k))
  if (extra !== undefined) return `unknown option ${extra}`
  if (v.lifetime !== undefined && v.lifetime !== "transient" && v.lifetime !== "pinned") return "lifetime is transient or pinned"
  const lifetime = (v.lifetime as "transient" | "pinned" | undefined) ?? (kind === "timer" ? "pinned" : "transient")
  if (v.expiresInMs !== undefined) {
    const max = PRESENT_MAX_EXPIRY_MS[lifetime]
    if (typeof v.expiresInMs !== "number" || !Number.isInteger(v.expiresInMs) || v.expiresInMs < PRESENT_MIN_EXPIRY_MS || v.expiresInMs > max) {
      return `expiresInMs is a whole number of ms from ${PRESENT_MIN_EXPIRY_MS} to ${max} for a ${lifetime} presentation`
    }
  }
  if (v.key !== undefined && (typeof v.key !== "string" || !PRESENT_KEY.test(v.key))) return `key must match ${PRESENT_KEY}`
  return undefined
}


/**
 * The lifetime and end of a presentation shown now with these (valid) options: a timer is pinned unless it says
 * otherwise; a pinned timer that names no `expiresInMs` stays until `TIMER_GRACE_MS` after it ends (at least the minimum,
 * at most the pinned maximum); otherwise the option, else the lifetime's default.
 */
export const presentLifetime = (presentation: Pick<Presentation, "kind"> & { readonly endsAt?: number }, o: ShowOptions | undefined, now: number): { readonly lifetime: "transient" | "pinned"; readonly expiresAt: number } => {
  const lifetime = o?.lifetime ?? (presentation.kind === "timer" ? "pinned" : "transient")
  if (presentation.kind === "timer" && lifetime === "pinned" && o?.expiresInMs === undefined && typeof presentation.endsAt === "number") {
    return { lifetime, expiresAt: Math.min(now + PRESENT_MAX_EXPIRY_MS.pinned, Math.max(now + PRESENT_MIN_EXPIRY_MS, presentation.endsAt + TIMER_GRACE_MS)) }
  }
  return { lifetime, expiresAt: now + (o?.expiresInMs ?? PRESENT_DEFAULT_EXPIRY_MS[lifetime]) }
}

/** A valid presentation's content as a page is sent it (its texts not yet through a page boundary), with an image's state. */
export const presentWireContent = (p: Presentation, image: ImageState = { state: "loading" }): PresentContent => {
  switch (p.kind) {
    case "card":
      return { kind: "card", title: p.title, ...(p.text !== undefined && p.text !== "" ? { text: p.text } : {}), facts: (p.facts ?? []).map((f) => ({ label: f.label, value: f.value })) }
    case "list":
      return { kind: "list", title: p.title, style: p.style ?? "bullets", items: p.items.map((i) => ({ id: i.id, text: i.text, done: i.done === true })) }
    case "timer":
      return { kind: "timer", label: p.label, endsAt: p.endsAt }
    case "image":
      return { kind: "image", alt: p.alt, credit: p.credit, ...(p.caption !== undefined && p.caption !== "" ? { caption: p.caption } : {}), image }
    case "weather":
      return { kind: "weather", place: p.place, now: { ...p.now }, days: (p.days ?? []).map((d) => ({ ...d })) }
  }
}
