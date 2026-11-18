import { ServiceKey } from "@pva/core"
import { Data, type Effect, type Stream } from "effect"
import type { Json, JsonObject } from "./common.ts"

/**
 * `HomeAssistant`: the smart-home module's connection to Home Assistant, as a **transport** (docs/MODULES-PLAN.md §2
 * row 18, §5.2; docs/research/modules/smart-home.md §5, §7). Provided by `home-assistant`
 * (`packages/module-home-assistant`, rewritten by its PR around one WebSocket in its `shared` part), used by `music`
 * (media players through Music Assistant) and `presence` (HA `person` entities).
 *
 * **A transport, not a domain service.** It carries what the owner exposed in Home Assistant (the Assist exposure list)
 * and nothing else. It is never offered to the model as a tool of its own. A consumer classifies and filters its own
 * tools (music's `music_play` is `change`), and each call it makes through `callService` must fit the call the gateway
 * admitted for it: music's "pause the kitchen" calls `media_player.media_pause` on the kitchen's player, nothing else.
 *
 * **What it refuses whoever asks** (`refused`), because `money` and `security` stay denied in this stack (§2 row 5)
 * and what a script does cannot be seen from outside it: any service of the domains `REFUSED_DOMAINS`, and any service on
 * a `cover` whose device class is `garage`, `gate` or `door`. It also refuses an entity or area the owner did not
 * expose (`unknown_entity`). Reading the state of any exposed entity, a lock's included, is allowed.
 *
 * **State.** `entities()`, `entity(id)`, `areas()` and `people()` answer at once from the module's cache (no network).
 * The cache is what Home Assistant said last; `connection()` says whether it is live:
 *
 * - `connected`: the socket is up and the cache follows Home Assistant;
 * - `reconnecting`: the socket dropped; the cache is as it was when it dropped (it may be stale);
 * - `unknown`: no state has arrived since the module started (the cache is empty).
 *
 * **Changes.** `changes` is a stream for the consumer to run in its own part's scope (`Effect.forkScoped` in `shared`).
 * Each run first gets a `snapshot` of the cache now (`reason: "subscribed"`), then one `changed` or `removed` per entity
 * change and a `connection` per change of the connection state. After a reconnect the stream sends a fresh `snapshot`
 * (`reason: "reconnected"`); when a consumer falls more than `HA_LIMITS.queue` changes behind, its queue is dropped and
 * it gets a `snapshot` (`reason: "overflow"`). **A snapshot is a state, not news**: a consumer compares it with what it
 * knew and must never read it as things having just happened (presence must not announce everyone as having just
 * arrived after a reconnect; music must not take a player that was already playing for one that just started).
 *
 * **Bounds.** At most `HA_LIMITS.entities` exposed entities and `HA_LIMITS.areas` areas are kept; an entity's
 * `attributes` as JSON at most `HA_LIMITS.attributeChars` (larger ones are left out and `attributesCut` is true); names
 * at most `HA_LIMITS.nameChars`. A call's `data` as JSON at most `HA_LIMITS.dataChars`, at most `HA_LIMITS.targets`
 * entity and area ids; a response at most `HA_LIMITS.responseChars` as JSON (cut: `responseCut`).
 *
 * **Time.** `callService` answers within `HA_LIMITS.callTimeoutMs` (`timeout` after that; the call may still have
 * happened in Home Assistant, so a consumer says "Home Assistant didn't answer in time", not that nothing happened).
 * A call while the socket is down is `not_connected` at once; it is never queued.
 *
 * **When smart-home is off or stops**: `host.service(HomeAssistant)` is `undefined`; a stream it gave ends; a call
 * made while it stops may die with `ModuleStopped`. `useService(host, HomeAssistant, "smart home", …)` makes it
 * `ProviderOff`. A consumer whose whole job is Home Assistant (music, presence) names `home-assistant` in `uses`, and
 * runs its `changes` again when the service is back (look it up again; it is a new provider after a restart).
 *
 * **Privacy.** HA's `person` states are where people are: household data in this stack (§5.1 row 19), shown on any
 * device that asks; a consumer that reports them follows its own document's privacy section.
 */
export const HA_LIMITS = {
  entities: 5_000,
  areas: 500,
  attributeChars: 4_000,
  nameChars: 200,
  dataChars: 4_000,
  targets: 50,
  responseChars: 16_000,
  queue: 1_000,
  callTimeoutMs: 5_000
} as const

/** Domains whose services the transport refuses for every caller (see above). */
export const REFUSED_DOMAINS: ReadonlyArray<string> = [
  "lock",
  "alarm_control_panel",
  "script",
  "automation",
  "shell_command",
  "rest_command",
  "python_script",
  "hassio",
  "homeassistant",
  "notify"
]

/** Cover device classes that are `security` (a garage door is, a blind is not). */
export const SECURITY_COVER_CLASSES: ReadonlyArray<string> = ["garage", "gate", "door"]

export interface HaEntity {
  /** "media_player.kitchen". */
  readonly entityId: string
  /** "media_player". */
  readonly domain: string
  readonly name: string
  /** The entity's aliases in Home Assistant (for matching what people say). */
  readonly aliases: ReadonlyArray<string>
  /** Its area (its own, else its device's); absent: none. */
  readonly areaId?: string
  readonly deviceClass?: string
  /** HA's state text ("on", "playing", "home", "unavailable"). */
  readonly state: string
  readonly attributes: JsonObject
  /** The attributes were longer than `attributeChars` as JSON and are left out. */
  readonly attributesCut: boolean
  /** Epoch ms of the last state change. */
  readonly lastChanged: number
}

export interface HaArea {
  readonly id: string
  readonly name: string
  readonly aliases: ReadonlyArray<string>
}

/** A Home Assistant `person` entity, as presence reads it. */
export interface HaPerson {
  /** "person.sam". */
  readonly entityId: string
  readonly name: string
  /** "home", "not_home", a zone name, or "unknown". */
  readonly state: string
  /** Epoch ms of the last state change. */
  readonly since: number
}

export type HaConnection = "connected" | "reconnecting" | "unknown"

export type HaChange =
  | {
    readonly _tag: "snapshot"
    readonly reason: "subscribed" | "reconnected" | "overflow"
    readonly connection: HaConnection
    readonly entities: ReadonlyArray<HaEntity>
    readonly areas: ReadonlyArray<HaArea>
    readonly people: ReadonlyArray<HaPerson>
  }
  | { readonly _tag: "changed"; readonly entity: HaEntity; readonly previous: HaEntity | undefined }
  | { readonly _tag: "removed"; readonly entityId: string }
  | { readonly _tag: "connection"; readonly connection: HaConnection }

export interface HaServiceCall {
  /** "media_player", "music_assistant": lower case letters, digits and `_`. */
  readonly domain: string
  /** "media_pause", "play_media". */
  readonly service: string
  readonly target?: { readonly entityIds?: ReadonlyArray<string>; readonly areaIds?: ReadonlyArray<string> }
  readonly data?: JsonObject
  /** Ask for the service's response (`return_response`); only for services that give one. */
  readonly returnResponse?: boolean
}

export interface HaServiceResult {
  readonly response?: Json
  readonly responseCut?: boolean
}

/** A refusal or failure; `message` is one sentence that can be spoken ("Home Assistant isn't connected."). */
export class HomeAssistantError extends Data.TaggedError("HomeAssistantError")<{
  /**
   * `not_connected`: the socket is down. `refused`: a domain or cover the transport refuses. `unknown_entity`: not an
   * exposed entity or a known area. `invalid`: a call outside the bounds. `timeout`: no answer in time (it may have
   * happened). `failed`: Home Assistant answered with an error.
   */
  readonly reason: "not_connected" | "refused" | "unknown_entity" | "invalid" | "timeout" | "failed"
  readonly message: string
}> {}

export interface HomeAssistantService {
  readonly connection: () => HaConnection
  /** Every exposed entity, from the cache. */
  readonly entities: () => ReadonlyArray<HaEntity>
  readonly entity: (entityId: string) => HaEntity | undefined
  readonly areas: () => ReadonlyArray<HaArea>
  readonly people: () => ReadonlyArray<HaPerson>
  /** See "Changes" above. */
  readonly changes: Stream.Stream<HaChange>
  readonly callService: (call: HaServiceCall) => Effect.Effect<HaServiceResult, HomeAssistantError>
}

export const HomeAssistant = ServiceKey<HomeAssistantService>("home-assistant")
