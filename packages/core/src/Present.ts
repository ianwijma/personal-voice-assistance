import {
  LIST_ITEM_ID,
  MAX_FACT_LABEL_CHARS,
  MAX_FACT_VALUE_CHARS,
  MAX_IMAGE_ALT_CHARS,
  MAX_IMAGE_CAPTION_CHARS,
  MAX_IMAGE_CREDIT_CHARS,
  MAX_IMAGE_URL_CHARS,
  MAX_LIST_ITEM_CHARS,
  MAX_LIST_ITEMS,
  MAX_PINNED_PER_DEVICE,
  MAX_PRESENT_BUTTONS,
  MAX_PRESENT_FACTS,
  MAX_PRESENT_LABEL_CHARS,
  MAX_PRESENT_TEXT_CHARS,
  MAX_PRESENT_TITLE_CHARS,
  MAX_SPOKEN_CHARS,
  MAX_TIMER_AHEAD_MS,
  MAX_TIMER_LABEL_CHARS,
  MAX_WEATHER_CONDITION_CHARS,
  MAX_WEATHER_DAY_LABEL_CHARS,
  MAX_WEATHER_DAYS,
  MAX_WEATHER_PLACE_CHARS,
  MAX_WEATHER_VALUE_CHARS,
  MEDIA_HASH,
  type NotShownWhy,
  PRESENT_ACTION_ID,
  type PresentKindName,
  TICK_ACTION,
  WEATHER_ICONS,
  type WeatherIcon
} from "@pva/protocol"
import { Effect, Schema } from "effect"
import { type CoreStorage, defineCollection, maxListRows } from "./HouseholdStore.ts"
import type { PartHandle } from "./ModuleRegistrations.ts"
import { NOTIFY_TEXT } from "./Notify.ts"
import type { PartRunner } from "./Scheduler.ts"
import { NOT_ONE_LINE } from "./SettingsExtra.ts"
import type { ConnectionRef, TurnPerson } from "./TurnContext.ts"

/**
 * Presentation, first version (docs/MODULES-PLAN.md §4 P10; how to use it: docs/PRESENTING.md). This file is the
 * contract: what a module may show, the two ways in, the bounds and the stored data. `PresentEngine.ts` implements it on
 * the household store, the same in serve mode (SQLite) and in the module test kit (in memory). The one decision
 * (`decidePresentation`) and what a device shows of what applies to it (`selectPresentations`) live in `@pva/protocol`,
 * so the web mock decides with the same functions.
 *
 * - **Two ways in**: a tool or an action returns `{ forModel, present }` (the gateway hands `present` to the Presenter
 *   in one synchronous enqueue and gives the model `forModel` with a note of what the server did), or a module calls
 *   `ctx.present.show(target, presentation, options?)`, which answers a handle with `update` and `dismiss`.
 * - **Lifetimes**: `transient` (default; a device shows one at a time: the newest) and `pinned` (several per device,
 *   restored after a reconnect). Every presentation ends by itself (`expiresInMs`, bounded per lifetime).
 * - **Ownership**: a presentation belongs to the module part that made it. A transient one is withdrawn when that part
 *   stops; a pinned one is stored and stays until it is dismissed or ends (a module that starts again replaces it by
 *   showing the same `key`).
 * - **Showing is reconciliation**: one function makes what each voice connection holds equal to what should be shown
 *   there now, and it is the only sender of `present.show`, `present.update` and `present.dismiss`.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Bounds

/** The owner of the service's collection in the household store. */
export const PRESENT_OWNER = "core.present" as const
/** Live presentations of all modules together at most; one more is refused `limit`. */
export const MAX_LIVE_TOTAL = 32
/** Live presentations of one module at most (transient and pinned); one more is refused `limit`. */
export const MAX_LIVE_PER_MODULE = 8
export { MAX_PINNED_PER_DEVICE }
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
/** A press handler's time limit. */
export const PRESENT_ACTION_TIMEOUT_MS = 5_000
/** The longest sentence a handler's answer may show, cut at the page boundary. */
export const MAX_PRESS_ANSWER_CHARS = 300
/** The longest note for the model. */
export const MAX_NOTE_CHARS = 400

/** One line, bounded, not blank, of storable text; or why not. */
const lineProblem = (text: unknown, max: number, what: string, optional = false): string | undefined => {
  if (text === undefined && optional) return undefined
  if (typeof text !== "string" || text.trim() === "") return `${what} must be text`
  if (text.length > max) return `${what} is at most ${max} characters`
  if (NOT_ONE_LINE.test(text) || !NOTIFY_TEXT.test(text)) return `${what} must be one line`
  return undefined
}
/** Storable text (line breaks allowed), bounded; or why not. */
const textProblem = (text: unknown, max: number, what: string): string | undefined => {
  if (text === undefined) return undefined
  if (typeof text !== "string" || text.length > max || !NOTIFY_TEXT.test(text)) return `${what} is at most ${max} characters, without control characters`
  return undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// What a module shows

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

/** What a tool or an action returns to show something: the model gets `forModel` and a note of what the server did. */
export interface PresentResult {
  readonly forModel: unknown
  readonly present: Presentation
  readonly show?: ShowOptions
}

/** Whether a tool's or an action's result asks to show something (`{ forModel, present }`, nothing else). */
export const isPresentResult = (value: unknown): value is PresentResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.includes("present") && keys.includes("forModel") && keys.every((k) => k === "present" || k === "forModel" || k === "show")
}

/** What was decided for one device of the target when it was shown (or updated). */
export interface ShownOn {
  readonly deviceId: string
  readonly shown: boolean
  readonly why?: NotShownWhy
}

/** What `show` and `update` did: per device of the target, and the note for the model ("shown on …", "not shown: …"). */
export interface ShowOutcome {
  readonly devices: ReadonlyArray<ShownOn>
  readonly note: string
}

export interface PresentHandle {
  readonly id: string
  readonly key?: string
  /** What was decided when it was shown. */
  readonly outcome: ShowOutcome
  /** Replace its content (the same kind and sensitivity; its target, lifetime, key and end stay). False: it had ended. */
  readonly update: (presentation: Presentation) => Effect.Effect<ShowOutcome | undefined, PresentError>
  /** Take it down everywhere. False: it had ended already. */
  readonly dismiss: Effect.Effect<boolean, PresentError>
}

/** A press on a presentation of the module, as its handler receives it. */
export interface PresentPress {
  readonly presentationId: string
  readonly key?: string
  /** The device it was pressed on. */
  readonly deviceId: string
  /** `tick` (a checklist item: `item`, `done`) or a button's id. */
  readonly action: string
  readonly item?: string
  readonly done?: boolean
}

/** What a handler answers: the sentence to show by the presentation (else "Done."). */
export interface PresentAnswer {
  readonly say?: string
}

export interface PresentPressHandler {
  /**
   * Runs in the module's part as a call in flight, with the press's principal (`CurrentPrincipal` `presentation`),
   * admitted by the execution gateway first, within `PRESENT_ACTION_TIMEOUT_MS`, after the press claimed the
   * presentation (one press at a time per presentation). It changes what is shown through the handle or by showing the
   * same key again; the press itself changes nothing on the page.
   */
  readonly run: (press: PresentPress) => Effect.Effect<PresentAnswer | void, unknown>
}

/**
 * `unavailable`: no presentation here (the CLI modes); `invalid`: a bound, an unknown handler, a target with no device;
 * `limit`: `MAX_LIVE_TOTAL`, `MAX_LIVE_PER_MODULE` or `MAX_PINNED_PER_DEVICE`; `busy`: the store was busy, try again;
 * `failed`: the store said no.
 */
export class PresentError extends Schema.TaggedError<PresentError>()("PresentError", {
  reason: Schema.Literals(["unavailable", "invalid", "limit", "busy", "failed"]),
  message: Schema.String
}) {}

/** `ctx.present` of a version 2 module. Every call (a handle's too) dies with `ModuleStopped` once the part has closed. */
export interface ModulePresent {
  /** Show it now on the target (one synchronous transaction and an enqueue). */
  readonly show: (target: PresentTarget, presentation: Presentation, options?: ShowOptions) => Effect.Effect<PresentHandle, PresentError>
  /** Register the press handler `name` during `shared` (a registration of the part: published and withdrawn with the module). */
  readonly handle: (name: string, handler: PresentPressHandler) => Effect.Effect<void, PresentError>
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
  if (typeof v.spoken !== "string" || v.spoken.trim() === "" || v.spoken.length > MAX_SPOKEN_CHARS || !NOTIFY_TEXT.test(v.spoken)) {
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

// ---------------------------------------------------------------------------------------------------------------------
// Stored data (`core.present`)

const ModuleIdText = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_.-]{1,64}$/))
const IdText = Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_.:-]{1,64}$/))
const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max), Schema.isPattern(NOTIFY_TEXT))
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
const IconText = Schema.Literals(WEATHER_ICONS)

/** The content as stored: the kind's fields, an image with its address and, once fetched, its hash (or why not). */
export const StoredContent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("card"),
    title: Text(MAX_PRESENT_TITLE_CHARS),
    text: Schema.optionalKey(Text(MAX_PRESENT_TEXT_CHARS)),
    facts: Schema.Array(Schema.Struct({ label: Text(MAX_FACT_LABEL_CHARS), value: Text(MAX_FACT_VALUE_CHARS) })).check(Schema.isMaxLength(MAX_PRESENT_FACTS))
  }),
  Schema.Struct({
    kind: Schema.Literal("list"),
    title: Text(MAX_PRESENT_TITLE_CHARS),
    style: Schema.Literals(["bullets", "checklist"]),
    items: Schema.Array(Schema.Struct({ id: Schema.String.check(Schema.isPattern(LIST_ITEM_ID)), text: Text(MAX_LIST_ITEM_CHARS), done: Schema.Boolean })).check(
      Schema.isMaxLength(MAX_LIST_ITEMS)
    )
  }),
  Schema.Struct({ kind: Schema.Literal("timer"), label: Text(MAX_TIMER_LABEL_CHARS), endsAt: Time }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    url: Schema.String.check(Schema.isMaxLength(MAX_IMAGE_URL_CHARS), Schema.isPattern(IMAGE_URL)),
    alt: Text(MAX_IMAGE_ALT_CHARS),
    credit: Text(MAX_IMAGE_CREDIT_CHARS),
    caption: Schema.optionalKey(Text(MAX_IMAGE_CAPTION_CHARS)),
    hash: Schema.optionalKey(Schema.String.check(Schema.isPattern(MEDIA_HASH))),
    failed: Schema.optionalKey(Schema.Literals(["type", "size", "busy", "full", "fetch", "blocked", "unavailable"]))
  }),
  Schema.Struct({
    kind: Schema.Literal("weather"),
    place: Text(MAX_WEATHER_PLACE_CHARS),
    now: Schema.Struct({ temperature: Text(MAX_WEATHER_VALUE_CHARS), condition: Text(MAX_WEATHER_CONDITION_CHARS), icon: IconText }),
    days: Schema.Array(Schema.Struct({ label: Text(MAX_WEATHER_DAY_LABEL_CHARS), high: Text(MAX_WEATHER_VALUE_CHARS), low: Text(MAX_WEATHER_VALUE_CHARS), icon: IconText })).check(
      Schema.isMaxLength(MAX_WEATHER_DAYS)
    )
  })
])
export type StoredContent = typeof StoredContent.Type

/**
 * One live presentation. Rows exist only while it is live: its end removes the row, and so does the stop of the part
 * that made a transient one. Dismissing it, or a newer transient that takes its device, marks the row `ended` in the
 * caller's transaction (an update: no removal, so no log checkpoint on a turn's path), and the service removes ended
 * rows ten seconds later, off every caller's path; an ended row is never shown and is removed at start. `part` is the
 * part's id in this process (transient rows left by an earlier process are removed when the service starts).
 */
export const StoredPresentation = Schema.Struct({
  module: ModuleIdText,
  key: Schema.optionalKey(Schema.String.check(Schema.isPattern(PRESENT_KEY))),
  part: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  lifetime: Schema.Literals(["transient", "pinned"]),
  target: Schema.Union([Schema.Struct({ device: IdText }), Schema.Struct({ room: Text(80) })]),
  owner: Schema.optionalKey(Schema.String.check(Schema.isPattern(PERSON_ID))),
  content: StoredContent,
  spoken: Text(MAX_SPOKEN_CHARS),
  buttons: Schema.Array(Schema.Struct({ id: Schema.String.check(Schema.isPattern(PRESENT_ACTION_ID)), label: Text(MAX_PRESENT_LABEL_CHARS) })).check(
    Schema.isMaxLength(MAX_PRESENT_BUTTONS)
  ),
  handler: Schema.optionalKey(Schema.String.check(Schema.isPattern(PRESENT_HANDLER_NAME))),
  shownAt: Time,
  expiresAt: Time,
  ended: Schema.optionalKey(Schema.Literal(true))
})
export type StoredPresentation = typeof StoredPresentation.Type

/**
 * The most characters of a row's JSON: the worst legal row (a list of twelve items, every text at its bound with the
 * costliest characters, three buttons, a key, an owner and a room) fits; the contract's "the worst legal row fits"
 * builds it. So one `list` reads at most `maxListRows(presentations)` rows (`PRESENT_PAGE`).
 */
export const PRESENT_MAX_CHARS = 5_000

export const presentations = defineCollection({
  name: "presentations",
  scope: "household",
  schema: StoredPresentation,
  maxChars: PRESENT_MAX_CHARS
})

/** One page of the service's reads. */
export const PRESENT_PAGE = maxListRows(presentations)

/** The service's data, prepared with the modules' in serve mode, the CLI modes and the test kit. */
export const presentStorage: CoreStorage = { owner: PRESENT_OWNER, storage: { version: 1, collections: [presentations] } }

// ---------------------------------------------------------------------------------------------------------------------
// The module host's side

/** What a version 2 part gets: its `ctx.present` (`ModuleHostOptions.present`, made in `servicesFor`). */
export interface PresentHook {
  readonly forPart: (part: PartHandle, runner: PartRunner) => ModulePresent
}

/** Where a press comes from (a page's tick or button; the kit). */
export interface PresentPressRequest {
  readonly presentationId: string
  readonly action: string
  readonly item?: string
  readonly done?: boolean
  readonly deviceId: string
  /** The connection it came on: it must hold the presentation. Absent (the kit's helpers): one of the device's must. */
  readonly connection?: ConnectionRef
  readonly person?: TurnPerson
}

/** What a press came to: `ok` when the handler ran; `say`: the sentence to show, in the household's language. */
export interface PresentPressAnswer {
  readonly ok: boolean
  readonly say: string
  /** `not_running` (its handler is not published), `unknown` (not held there, ended, not pressable), `busy`, `failed`. */
  readonly code?: "not_running" | "unknown" | "busy" | "failed"
}

/** The module-facing calls of a mode without the service (the CLI modes): `handle` succeeds, `show` is `unavailable`. */
export const closedModulePresent = (reason: string): ModulePresent => ({
  show: () => Effect.fail(new PresentError({ reason: "unavailable", message: reason })),
  handle: () => Effect.void
})
