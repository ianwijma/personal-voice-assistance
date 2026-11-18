import { ModuleStopped } from "@pva/core"
import {
  HA_LIMITS,
  type HaArea,
  type HaChange,
  type HaConnection,
  type HaEntity,
  type HaPerson,
  type HaServiceCall,
  type HaServiceResult,
  HomeAssistantError as HaCallError,
  type HomeAssistantService,
  type Json,
  type JsonObject,
  REFUSED_DOMAINS,
  TARGET_DATA_KEYS
} from "@pva/module-contracts"
import { Cause, Effect, Latch, Stream } from "effect"
import type { CallLimits, HomeAssistantError as ClientError } from "./client.ts"
import type { Entity, House } from "./house.ts"
import { fromUpstream, type Secrets } from "./redact.ts"

/**
 * The `HomeAssistant` transport (`packages/module-contracts/src/homeAssistant.ts`), over the module's polled cache,
 * and the one checked path every service call takes, the module's own actions' included.
 *
 * **Polling** ("In this version the provider polls"): the shared part reads the house every 60 s (and when a question
 * asks for it now). Each kept read is a poll: `polled(read)` after a good one, `failed()` after a bad one.
 *
 * - **Exposed** = people, and the entities of the kinds chosen in the module's shared `domains` setting (read first,
 *   so the module's other kinds never use the provider's room). Scenes and scripts are never exposed.
 * - **`connection()`**: `unknown` until the first good poll; `connected` while polls succeed; `reconnecting` after one
 *   fails, with the cache as it was.
 * - **Changes**: after a good poll that follows a good poll, one `changed` or `removed` per entity that differs, in
 *   entity id order; after a good poll that follows `unknown` or `reconnecting`, a `connection` and one `snapshot`
 *   (`reconnected`), never changes. After a failed poll that follows a good one, a `connection` (`reconnecting`).
 * - **A subscriber** pulls: nothing is made for it before it asks for the next item, so nothing is buffered outside its
 *   own list of what it has not taken. When that list holds more than `HA_LIMITS.queue` changes it is dropped, and
 *   the next item the subscriber takes is a `snapshot` (`overflow`) of the cache at that moment; nothing is added to
 *   the list until it has taken it. Its stream ends when the consumer's scope closes or the part closes.
 * - **After the part closed**: every method throws `ModuleStopped` (`callService` dies with it; a stream ends).
 */

/** What a checked call may not do, or what went wrong: the contract's reason, a line for the log, the client's error. */
export interface CallProblem {
  readonly reason: HaCallError["reason"]
  readonly detail: string
  /** The client's error when Home Assistant was asked: the module's own actions word it more closely. */
  readonly cause?: ClientError
  /** The request was sent (or may have been): whether it happened is not known. */
  readonly unconfirmed?: boolean
}

/** Who calls: a consumer of the transport, or the module's own actions (which may run the scenes the owner named). */
export type Caller = "consumer" | "own"

const ID_PART = /^[a-z0-9_]+$/
const ENTITY_ID = /^([a-z0-9_]+)\.[a-z0-9_]+$/

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** Whether `json` holds one of the target keys, at any depth (it is at most `dataChars` long, so the walk is bounded). */
const namesTarget = (json: unknown): boolean => {
  if (Array.isArray(json)) return json.some(namesTarget)
  if (!isRecord(json)) return false
  return Object.entries(json).some(([k, v]) => TARGET_DATA_KEYS.includes(k) || namesTarget(v))
}

/** An entity as the contract shows it: the attributes the module reads, under Home Assistant's own names. */
export const toHaEntity = (e: Entity): HaEntity => {
  const attributes: Record<string, Json> = {}
  if (e.kind !== "person") {
    if (e.deviceClass !== undefined) attributes.device_class = e.deviceClass
    if (e.currentTemperature !== undefined) attributes.current_temperature = e.currentTemperature
    if (e.targetTemperature !== undefined) attributes.temperature = e.targetTemperature
    if (e.hvacModes.length > 0) attributes.hvac_modes = [...e.hvacModes]
    if (e.position !== undefined) attributes.current_position = e.position
    if (e.supportedFeatures !== undefined) attributes.supported_features = e.supportedFeatures
    if (e.unit !== undefined) attributes.unit_of_measurement = e.unit
    if (e.mediaTitle !== undefined) attributes.media_title = e.mediaTitle
    if (e.mediaArtist !== undefined) attributes.media_artist = e.mediaArtist
    if (e.volumeLevel !== undefined) attributes.volume_level = e.volumeLevel
    if (e.brightnessPct !== undefined) attributes.brightness_pct = e.brightnessPct
  }
  const cut = JSON.stringify(attributes).length > HA_LIMITS.attributeChars
  return {
    entityId: e.entityId,
    domain: e.domain,
    name: e.name,
    aliases: e.aliases,
    ...(e.areaId !== undefined ? { areaId: e.areaId } : {}),
    ...(e.deviceClass !== undefined ? { deviceClass: e.deviceClass } : {}),
    state: e.state,
    attributes: cut ? {} : attributes,
    attributesCut: cut,
    lastChanged: e.lastChanged
  }
}

interface Subscriber {
  pending: Array<HaChange>
  overflowed: boolean
  ended: boolean
  readonly latch: Latch.Latch
}

export interface TransportDeps {
  /** The client's service call. */
  readonly call: (domain: string, service: string, data: Readonly<Record<string, unknown>>, limits: CallLimits & { readonly returnResponse?: boolean }) => Effect.Effect<string | undefined, ClientError>
  /** The longest one request to Home Assistant may take (the module's `timeoutMs`). */
  readonly timeoutMs: number
  readonly secrets: Secrets
}

/** A poll as the transport takes it: the house, and what of it is exposed, each entity with its JSON. */
export interface Polled {
  readonly house: House
  readonly exposed: ReadonlyArray<{ readonly entity: HaEntity; readonly json: string }>
}

export const makeTransport = (deps: TransportDeps) => {
  const secrets = deps.secrets.filter((s): s is string => typeof s === "string" && s.length > 0)
  let connection: HaConnection = "unknown"
  let entities: ReadonlyArray<HaEntity> = []
  let byId = new Map<string, { readonly entity: HaEntity; readonly json: string }>()
  let areas: ReadonlyArray<HaArea> = []
  /** The house of the last good poll, for the checks of a call and the module's own calls. */
  let house: House | undefined
  let closed = false
  const subscribers = new Set<Subscriber>()

  const stopped = () => new ModuleStopped({ message: "The Home Assistant module has stopped." })
  const live = () => {
    if (closed) throw stopped()
  }

  const snapshot = (reason: "subscribed" | "reconnected" | "overflow"): HaChange => ({ _tag: "snapshot", reason, connection, entities, areas })

  const push = (changes: ReadonlyArray<HaChange>) => {
    if (changes.length === 0) return
    for (const sub of subscribers) {
      // Behind already: the snapshot it will take covers these.
      if (sub.overflowed) continue
      for (const c of changes) sub.pending.push(c)
      if (sub.pending.length > HA_LIMITS.queue) {
        sub.pending = []
        sub.overflowed = true
      }
      sub.latch.openUnsafe()
    }
  }

  /** A good poll: the cache follows it in one step, and the subscribers learn what changed (or get a snapshot). */
  const polled = (next: Polled) => {
    if (closed) return
    house = next.house
    const nextById = new Map(next.exposed.map((x) => [x.entity.entityId, x] as const))
    const before = byId
    const wasLive = connection === "connected"
    entities = next.exposed.map((x) => x.entity)
    byId = nextById
    areas = next.house.areas.map((a) => ({ id: a.id, name: a.name, aliases: a.aliases }))
    connection = "connected"
    if (!wasLive) {
      push([{ _tag: "connection", connection: "connected" }, snapshot("reconnected")])
      return
    }
    // Both lists are in id order: one merge.
    const changes: Array<HaChange> = []
    const was = [...before.keys()]
    const now = next.exposed
    let i = 0
    let j = 0
    while (i < was.length || j < now.length) {
      const a = was[i]
      const b = now[j]?.entity.entityId
      if (b === undefined || (a !== undefined && a < b)) {
        changes.push({ _tag: "removed", entityId: a! })
        i++
      } else if (a === undefined || b < a) {
        changes.push({ _tag: "changed", entity: now[j]!.entity, previous: undefined })
        j++
      } else {
        const old = before.get(a)!
        if (old.json !== now[j]!.json) changes.push({ _tag: "changed", entity: now[j]!.entity, previous: old.entity })
        i++
        j++
      }
    }
    push(changes)
  }

  /** A failed poll: the cache stays as it was. */
  const failed = () => {
    if (closed || connection !== "connected") return
    connection = "reconnecting"
    push([{ _tag: "connection", connection: "reconnecting" }])
  }

  /** The next item a subscriber takes, made when it asks: the overflow snapshot of the cache now, or its oldest change. */
  const next = (sub: Subscriber): Effect.Effect<readonly [HaChange], Cause.Done> =>
    Effect.gen(function*() {
      while (true) {
        if (sub.ended || closed) return yield* Cause.done()
        if (sub.overflowed) {
          sub.overflowed = false
          sub.pending = []
          return [snapshot("overflow")] as const
        }
        const head = sub.pending.shift()
        if (head !== undefined) return [head] as const
        yield* sub.latch.close
        if (sub.pending.length === 0 && !sub.overflowed && !sub.ended && !closed) yield* sub.latch.await
      }
    })

  const changes = (): Stream.Stream<HaChange> => {
    live()
    return Stream.unwrap(Effect.gen(function*() {
      const sub: Subscriber = { pending: [], overflowed: false, ended: false, latch: yield* Latch.make(false) }
      if (closed) return Stream.empty
      sub.pending.push(snapshot("subscribed"))
      subscribers.add(sub)
      yield* Effect.addFinalizer(() => Effect.sync(() => void subscribers.delete(sub)))
      return Stream.fromPull(Effect.succeed(next(sub)))
    }))
  }

  /** Whether any text of `json` holds a configured secret. */
  const holdsSecret = (json: string) => secrets.some((s) => json.includes(s))

  /**
   * The one checked path of every service call (the contract's "How a call names what it acts on"), before anything
   * reaches Home Assistant: the form, the bounds, the target keys in `data`, the refused domains, covers that are not
   * of a blind class, the connection, the exposure (the module's own: a runnable scene). Then one request within
   * `limitMs` (at most the contract's `callTimeoutMs`), never retried.
   */
  const checked = (call: HaServiceCall, caller: Caller, limitMs: number): Effect.Effect<HaServiceResult, CallProblem> =>
    Effect.suspend((): Effect.Effect<HaServiceResult, CallProblem> => {
      const refuse = (reason: CallProblem["reason"], detail: string) => Effect.fail({ reason, detail })
      if (!isRecord(call)) return refuse("invalid", "the call is not an object")
      const { domain, service } = call
      if (typeof domain !== "string" || domain.length > HA_LIMITS.idChars || !ID_PART.test(domain)) return refuse("invalid", "the domain is not of the form a-z0-9_")
      if (typeof service !== "string" || service.length > HA_LIMITS.idChars || !ID_PART.test(service)) return refuse("invalid", "the service is not of the form a-z0-9_")
      const target: unknown = call.target
      if (!isRecord(target) || Object.keys(target).some((k) => k !== "entityIds")) return refuse("refused", "a call names its entities by target.entityIds only")
      const ids: unknown = target.entityIds
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === "string")) return refuse("refused", "target.entityIds is not a list of entity ids")
      if (ids.length > HA_LIMITS.targets) return refuse("invalid", `more than ${HA_LIMITS.targets} entities in one call`)
      let data: JsonObject = {}
      if (call.data !== undefined) {
        if (!isRecord(call.data)) return refuse("invalid", "data is not an object")
        let text: string | undefined
        try {
          text = JSON.stringify(call.data)
        } catch {
          return refuse("invalid", "data is not JSON")
        }
        if (text === undefined || text.length > HA_LIMITS.dataChars) return refuse("invalid", `data is longer than ${HA_LIMITS.dataChars} characters as JSON`)
        data = JSON.parse(text) as JsonObject
        if (namesTarget(data)) return refuse("refused", "data names a target itself")
      }
      if (REFUSED_DOMAINS.includes(domain)) return refuse("refused", `the ${domain} domain is refused`)
      for (const id of ids) {
        const match = id.length <= HA_LIMITS.idChars ? ENTITY_ID.exec(id) : null
        if (match === null) return refuse("unknown_entity", "an entity id that is not Home Assistant's form")
        if (REFUSED_DOMAINS.includes(match[1]!)) return refuse("refused", `an entity of the refused ${match[1]} domain`)
        // A cover is moved only when it is known to be a blind, curtain, shade, shutter or awning: a garage door, a gate,
        // a door, a cover of a class this module does not know and a cover without a class are all refused.
        if (match[1] === "cover") {
          const e = house?.byId.get(id)
          if (e !== undefined && !e.blind) return refuse("refused", "a cover that is not of a blind class (a garage door, a gate, a door, or no class)")
        }
        // A scene runs only for the module's own action, when every entity it sets is one this module changes itself.
        if (match[1] === "scene" && caller === "own" && house?.byId.get(id)?.runnable !== true) return refuse("refused", "a scene that sets something this module does not change")
      }
      if (connection !== "connected") return refuse("not_connected", `the last poll of Home Assistant ${connection === "unknown" ? "has not succeeded yet" : "failed"}`)
      for (const id of ids) {
        const own = house?.byId.get(id)
        const known = caller === "consumer"
          ? byId.has(id) && (!id.startsWith("cover.") || own?.blind === true)
          : own !== undefined && own.kind !== "person" && (own.kind !== "cover" || own.blind)
        if (!known) return refuse("unknown_entity", "an entity that is not exposed")
      }
      const returnResponse = call.returnResponse === true
      return deps.call(domain, service, { ...data, entity_id: [...ids] }, { timeoutMs: Math.min(limitMs, HA_LIMITS.callTimeoutMs), maxBytes: 256 * 1024, returnResponse }).pipe(
        Effect.mapError((e): CallProblem => {
          // Home Assistant answered with an error: it says so. Anything else (no answer, a broken connection, an answer
          // that could not be read) after the request was sent: it may or may not have happened, and is never retried.
          const answered = e.kind === "http" || e.kind === "unauthorized" || e.kind === "forbidden"
          return {
            reason: answered ? "failed" : "timeout",
            detail: fromUpstream(`${domain}.${service}: ${answered ? "" : "no confirmed answer (it may or may not have happened): "}${e.detail}`, deps.secrets),
            cause: e,
            ...(answered ? {} : { unconfirmed: true })
          }
        }),
        Effect.map((text): HaServiceResult => {
          if (!returnResponse) return {}
          // Home Assistant said it was done, with an answer too large to read: the call happened, its answer is cut.
          if (text === undefined) return { responseCut: true }
          let response: unknown
          try {
            response = (JSON.parse(text) as { readonly service_response?: unknown } | null)?.service_response
          } catch {
            return { responseCut: true }
          }
          if (response === undefined) return {}
          const json = JSON.stringify(response)
          // An answer that holds a configured secret is never handed on, nor rewritten: it is cut.
          return json === undefined || json.length > HA_LIMITS.responseChars || holdsSecret(json) ? { responseCut: true } : { response: JSON.parse(json) as Json }
        })
      )
    })

  const service: HomeAssistantService = {
    connection: () => {
      live()
      return connection
    },
    entities: () => {
      live()
      return entities
    },
    entity: (entityId) => {
      live()
      return byId.get(entityId)?.entity
    },
    areas: () => {
      live()
      return areas
    },
    people: () => {
      live()
      return entities.filter((e) => e.domain === "person").map((e): HaPerson => ({ entityId: e.entityId, name: e.name, state: e.state, since: e.lastChanged }))
    },
    changes,
    callService: (call) =>
      Effect.suspend(() => {
        if (closed) return Effect.die(stopped())
        return checked(call, "consumer", deps.timeoutMs).pipe(
          Effect.mapError((p) => new HaCallError({ reason: p.reason, detail: p.detail })),
          Effect.catchDefect((d) => Effect.fail(new HaCallError({ reason: "failed", detail: fromUpstream(d, deps.secrets) })))
        )
      })
  }

  return {
    service,
    polled,
    failed,
    checked,
    /** The part closed: every stream ends, every method answers `ModuleStopped`. */
    close: () => {
      closed = true
      for (const sub of subscribers) {
        sub.ended = true
        sub.latch.openUnsafe()
      }
      subscribers.clear()
    },
    subscriberCount: () => subscribers.size
  }
}

export type Transport = ReturnType<typeof makeTransport>
