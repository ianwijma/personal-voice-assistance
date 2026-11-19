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
  MAX_LIVE_PER_MODULE,
  MAX_LIVE_TOTAL,
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
// The live bounds live in `@pva/protocol` (the web mock admits with the same ones).
export { MAX_LIVE_PER_MODULE, MAX_LIVE_TOTAL, MAX_PINNED_PER_DEVICE }
// What a module shows, its lifetimes and its checks live in `@pva/protocol` (the web mock runs the same ones).
export {
  type CardPresentation,
  IMAGE_URL,
  type ImagePresentation,
  type ListPresentation,
  PRESENT_DEFAULT_EXPIRY_MS,
  PRESENT_HANDLER_NAME,
  PRESENT_KEY,
  PRESENT_MAX_EXPIRY_MS,
  PRESENT_MIN_EXPIRY_MS,
  type PresentButtonSpec,
  type Presentation,
  presentationProblem,
  presentLifetime,
  type PresentSensitivity,
  type PresentTarget,
  type ShowOptions,
  showOptionsProblem,
  TIMER_GRACE_MS,
  type TimerPresentation,
  type WeatherPresentation
} from "@pva/protocol"
import { IMAGE_URL, PRESENT_HANDLER_NAME, PRESENT_KEY, type Presentation, type PresentTarget, type ShowOptions } from "@pva/protocol"

const PERSON_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/
/** A press handler's time limit. */
export const PRESENT_ACTION_TIMEOUT_MS = 5_000
/** The longest sentence a handler's answer may show, cut at the page boundary. */
export const MAX_PRESS_ANSWER_CHARS = 300
/** The longest note for the model. */
export const MAX_NOTE_CHARS = 600
/** The most of a presentation's `spoken` text a note carries (the whole note stays within `MAX_NOTE_CHARS`). */
export const MAX_NOTE_SPOKEN_CHARS = 300

// ---------------------------------------------------------------------------------------------------------------------
// What a module shows

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
  reason: Schema.Literals(["unavailable", "invalid", "limit", "busy", "failed", "uncommitted"]),
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
  /** This show's own id: a handle's `update` and `dismiss` act only on the show they were given for (a key shown again is another). */
  showId: IdText,
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
