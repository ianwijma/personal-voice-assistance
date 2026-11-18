import { ServiceKey } from "@pva/core"
import { Data, type Effect, type Stream } from "effect"
import type { Json, JsonObject } from "./common.ts"

/**
 * `HomeAssistant`: the smart-home module's connection to Home Assistant, as a **transport** (docs/MODULES-PLAN.md §2
 * row 18, §5.2; docs/research/modules/smart-home.md §5, §7). Provided by `home-assistant`
 * (`packages/module-home-assistant`), used by `music` (media players through Music Assistant) and `presence` (HA
 * `person` entities).
 *
 * **In this version the provider polls.** The network helpers offer no WebSocket yet, so the provider reads Home
 * Assistant over its REST interface on an interval (about a minute) and keeps a cache. Everything below holds with
 * these two readings: "exposed" means the entities of the kinds the owner chose in the module's settings, plus the
 * `person` entities (for `presence` only: the provider's own tools never read them); and "the socket" means the
 * provider's last poll: `connected` while polls succeed, `reconnecting` after one failed, and a change reaches a
 * subscriber at the next poll, so up to an interval late. A consumer must not assume anything faster.
 *
 * **A transport, not a domain service.** It carries what the owner exposed in Home Assistant (the Assist exposure list)
 * and nothing else. It is never offered to the model as a tool of its own. A consumer classifies and filters its own
 * tools (music's `music_play` is `change`), and each call it makes through `callService` must fit the call the gateway
 * admitted for it: music's "pause the kitchen" calls `media_player.media_pause` on the kitchen's player, nothing else.
 *
 * **How a call names what it acts on: entity ids only**, in this version. `target.entityIds` lists 1 to
 * `HA_LIMITS.targets` exposed entity ids; nothing else selects an entity. The provider refuses (`refused`), before
 * anything reaches Home Assistant:
 *
 * - a call without `target.entityIds`, or with any other target key (areas, devices, floors, labels): an area could
 *   hold a lock, so "everything in the garage" is never a way to reach one;
 * - `data` that names a target itself (`entity_id`, `area_id`, `device_id`, `floor_id`, `label_id`, at any depth);
 * - any service of the domains `REFUSED_DOMAINS`, and any service on an entity of such a domain;
 * - any service on a `cover` whose device class is in `SECURITY_COVER_CLASSES` (a garage door, a gate, a door):
 *   `money` and `security` stay denied in this stack (§2 row 5), and a script's effect cannot be seen from outside it.
 *
 * An entity id that is not exposed is `unknown_entity`. Reading the state of any exposed entity, a lock's included,
 * is allowed.
 *
 * **Which services a call may name: an allow-list.** The provider admits only a fixed table of ordinary services: on,
 * off and toggle for lights, switches, fans and on/off helpers (a light's brightness only where it can be dimmed);
 * open, close, stop and set position for covers of a blind class (a cover of any other class, or of none, is refused);
 * set temperature and set HVAC mode for thermostats; the playback, seek, volume, mute, source, shuffle, repeat,
 * play-media and browse-media services of media players; and `scene.turn_on` for a scene whose every entity the
 * provider would change itself. Each is admitted only on entities of the service's own domain, with only its listed
 * data fields as plain values. Any other service (any integration's own: `zwave_js.*`, `mqtt.*`, `homeassistant.*`,
 * `script.*`, …), field or target is `refused` before anything is sent: a refuse-list cannot be complete, because an
 * integration's service can reach a lock through an ordinary sensor of the same device. The provider's page
 * (docs/modules/home-assistant.md, "The services a call may name") lists the table.
 *
 * **State.** `entities()`, `entity(id)`, `areas()` and `people()` answer at once from the module's cache (no network).
 * The cache is what Home Assistant said last; `connection()` says whether it is live:
 *
 * - `connected`: the socket is up and the cache follows Home Assistant;
 * - `reconnecting`: the socket dropped; the cache is as it was when it dropped (it may be stale);
 * - `unknown`: no state has arrived since the module started (the cache is empty).
 *
 * `people()` is the `person` entities of `entities()` in another shape: the two always agree, and a change of a person
 * entity comes on `changes()` as a `changed` of that entity.
 *
 * **Changes.** `changes()` makes a stream for the consumer to run in its own part's scope (`Effect.forkScoped` in
 * `shared`). Each run first gets a `snapshot` of the cache now (`reason: "subscribed"`), then one `changed` or
 * `removed` per entity change and a `connection` per change of the connection state. After a reconnect it sends a
 * fresh `snapshot` (`reason: "reconnected"`). **The first successful load is a reconnect too**: a consumer that
 * subscribed while the cache was empty (`unknown`, an empty `subscribed` snapshot) gets the first loaded state as one
 * `snapshot` with `reason: "reconnected"`, before any `changed` or `removed`; filling the cache sends no `changed`
 * per entity (no `previous: undefined` for everything Home Assistant already had). Every provider does the same, so a
 * consumer has one path: every snapshot replaces what it knew. When a consumer falls more than `HA_LIMITS.queue` changes behind, the
 * changes it has not taken are dropped and the next thing it gets is a `snapshot` (`reason: "overflow"`) of the cache
 * at that moment, followed by the changes after it. **A snapshot is a state, not news**: a consumer compares it with
 * what it knew and never reads it as things having just happened (presence must not announce everyone as having just
 * arrived after a reconnect; music must not take a player that was already playing for one that just started).
 *
 * **Bounds and ids.** Home Assistant chooses every id here; they are stable for as long as the owner does not rename
 * the entity or area in Home Assistant. The provider never cuts an id: an entity or area whose id is longer than
 * `idChars` or not of the form below is left out of the cache (and so is not exposed).
 *
 * - `entityId`: `<domain>.<object id>`, lower case letters, digits and `_`, at most `HA_LIMITS.idChars`; `domain` is
 *   its first part; `areaId` lower case letters, digits and `_`, at most `idChars`.
 * - `name`, area `name`, each alias: one line, cut to `HA_LIMITS.nameChars`; at most `HA_LIMITS.aliases` aliases (the
 *   rest left out).
 * - `state`: HA's state text, at most `HA_LIMITS.stateChars` (HA's own limit); `deviceClass` at most `idChars`.
 * - `attributes` as JSON at most `HA_LIMITS.attributeChars`; a larger set is left out (`{}`, `attributesCut: true`).
 * - At most `HA_LIMITS.entities` entities and `HA_LIMITS.areas` areas are kept (the rest left out, by id order).
 * - A call: `domain` and `service` lower case letters, digits and `_`, at most `idChars` each; `data` as JSON at most
 *   `HA_LIMITS.dataChars`; otherwise `invalid`. A response at most `HA_LIMITS.responseChars` as JSON (larger:
 *   left out and `responseCut: true`).
 *
 * **Time.** `callService` answers within `HA_LIMITS.callTimeoutMs` (`timeout` after that; the call may still have
 * happened in Home Assistant, so a consumer says "Home Assistant didn't answer in time", not that nothing happened).
 * A call while the socket is down is `not_connected` at once; it is never queued.
 *
 * **Errors.** `HomeAssistantError.reason` is for the consumer to word in its own two languages; `detail` for the log
 * only (never a token).
 *
 * **When smart-home is off or stops**: `host.service(HomeAssistant)` is `undefined`; a stream it gave ends; a call
 * made while it stops may die with `ModuleStopped`. `useService(host, HomeAssistant, …)` makes it `ProviderOff`. A
 * consumer whose whole job is Home Assistant (music, presence) names `home-assistant` in `uses`, and runs `changes()`
 * again when the service is back (look it up again: it is a new provider after a restart).
 *
 * **Privacy.** Where a person is (a `person` entity's state, a phone's zone, anything that follows one person) is
 * **personal** data of that person, not household data, whatever device asks. The transport hands it to its consumer
 * as it is; the consumer (presence) maps each HA person to a member of the household (its own setting) and passes
 * what it would say through `Privacy.mayReveal(member, turn)` at the moment of saying it. An HA person mapped to no
 * member, or to someone who is no longer a member, is revealed nowhere.
 */
export const HA_LIMITS = {
  entities: 5_000,
  areas: 500,
  idChars: 255,
  nameChars: 200,
  aliases: 20,
  stateChars: 255,
  attributeChars: 4_000,
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

/** Keys of a call's `data` that name a target; a call whose `data` holds one, at any depth, is refused. */
export const TARGET_DATA_KEYS: ReadonlyArray<string> = ["entity_id", "area_id", "device_id", "floor_id", "label_id"]

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

/** A Home Assistant `person` entity, as presence reads it (personal: see "Privacy" above). */
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
  }
  | { readonly _tag: "changed"; readonly entity: HaEntity; readonly previous: HaEntity | undefined }
  | { readonly _tag: "removed"; readonly entityId: string }
  | { readonly _tag: "connection"; readonly connection: HaConnection }

export interface HaServiceCall {
  /** "media_player", "music_assistant". */
  readonly domain: string
  /** "media_pause", "play_media". */
  readonly service: string
  /** The entities it acts on (see "How a call names what it acts on"). */
  readonly target: { readonly entityIds: ReadonlyArray<string> }
  readonly data?: JsonObject
  /** Ask for the service's response (`return_response`); only for services that give one. */
  readonly returnResponse?: boolean
}

export interface HaServiceResult {
  readonly response?: Json
  readonly responseCut?: boolean
}

/** A refusal or failure (see "Errors" above). */
export class HomeAssistantError extends Data.TaggedError("HomeAssistantError")<{
  /**
   * `not_connected`: the socket is down. `refused`: a target form, domain, entity or cover the transport refuses.
   * `unknown_entity`: not an exposed entity. `invalid`: a call outside the bounds. `timeout`: no answer in time (it may
   * have happened). `failed`: Home Assistant answered with an error.
   */
  readonly reason: "not_connected" | "refused" | "unknown_entity" | "invalid" | "timeout" | "failed"
  readonly detail: string
}> {}

export interface HomeAssistantService {
  readonly connection: () => HaConnection
  /** Every exposed entity, from the cache. */
  readonly entities: () => ReadonlyArray<HaEntity>
  readonly entity: (entityId: string) => HaEntity | undefined
  readonly areas: () => ReadonlyArray<HaArea>
  /** The `person` entities of `entities()` (see "State"). */
  readonly people: () => ReadonlyArray<HaPerson>
  /** A new stream of the cache's changes (see "Changes"). */
  readonly changes: () => Stream.Stream<HaChange>
  readonly callService: (call: HaServiceCall) => Effect.Effect<HaServiceResult, HomeAssistantError>
}

export const HomeAssistant = ServiceKey<HomeAssistantService>("home-assistant")
