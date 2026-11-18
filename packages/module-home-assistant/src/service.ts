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
import { Effect, Latch, Queue, Stream } from "effect"
import type { CallLimits, HomeAssistantError as ClientError } from "./client.ts"
import type { Entity, House, Kind } from "./house.ts"
import { fromUpstream, type Secrets } from "./redact.ts"

/**
 * The `HomeAssistant` transport (`packages/module-contracts/src/homeAssistant.ts`), over the module's polled cache,
 * and the one checked path every service call takes, the module's own actions' included.
 *
 * **Polling** ("In this version the provider polls"): the shared part reads the house every 60 s (and when a question
 * asks for it now). Each kept read is a poll: `polled(house)` after a good one, `failed()` after a bad one.
 *
 * - **Exposed** = the entities of the kinds chosen in the module's shared `domains` setting (read at each poll with
 *   `settingsFor(undefined)`), plus every `person` entity. Scenes and scripts are not exposed: they are not a kind of
 *   `domains`, and a script is refused to every consumer anyway. The module's own tools never read a person.
 * - **`connection()`**: `unknown` until the first good poll; `connected` while polls succeed; `reconnecting` after one
 *   fails, with the cache as it was.
 * - **Changes**: after a good poll that follows a good poll, one `changed` or `removed` per entity that differs, in
 *   entity id order; after a good poll that follows `unknown` or `reconnecting`, a `connection` and one `snapshot`
 *   (`reconnected`), never changes. After a failed poll that follows a good one, a `connection` (`reconnecting`).
 *   Areas come only in snapshots (`areas()` always answers the newest).
 * - **A subscriber** has its own list of what it has not taken. When it holds more than `HA_LIMITS.queue` changes, the
 *   list is dropped and the next thing it takes is a `snapshot` (`overflow`) of the cache at that moment; nothing is
 *   added to the list until it has taken that snapshot (the snapshot covers it). Its stream ends when the consumer's
 *   scope closes or the part closes.
 * - **After the part closed**: every method throws `ModuleStopped` (`callService` dies with it; a stream already given
 *   ends).
 */

/** What a checked call may not do, or what went wrong: the contract's reason, a line for the log, the client's error. */
export interface CallProblem {
  readonly reason: HaCallError["reason"]
  readonly detail: string
  /** The client's error when Home Assistant was asked: the module's own actions word it more closely. */
  readonly cause?: ClientError
}

/** Who calls: a consumer of the transport, or the module's own actions (which may run the scenes and scripts the owner named). */
export type Caller = "consumer" | "own"

/** The kinds the transport exposes for a `domains` value (scenes and scripts never; people always). */
export const exposedKinds = (domains: ReadonlyArray<string> | undefined): ReadonlySet<Kind> => {
  const chosen = domains ?? ["light", "switch", "climate", "cover", "media_player", "sensor", "lock"]
  const kinds = new Set<Kind>(["person"])
  for (const d of chosen) if (d !== "scene" && d !== "person") kinds.add(d as Kind)
  return kinds
}

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
  readonly latch: Latch.Latch
  readonly end: () => void
}

export interface TransportDeps {
  /** The kinds exposed now (the shared `domains`, read at each poll). */
  readonly kinds: () => ReadonlySet<Kind>
  /** The client's service call. */
  readonly call: (domain: string, service: string, data: Readonly<Record<string, unknown>>, limits: CallLimits & { readonly returnResponse?: boolean }) => Effect.Effect<string, ClientError>
  /** The longest one request to Home Assistant may take (the module's `timeoutMs`). */
  readonly timeoutMs: number
  readonly secrets: Secrets
}

export const makeTransport = (deps: TransportDeps) => {
  let connection: HaConnection = "unknown"
  let entities: ReadonlyArray<HaEntity> = []
  let byId = new Map<string, { readonly entity: HaEntity; readonly json: string }>()
  let areas: ReadonlyArray<HaArea> = []
  /** The house of the last good poll, for the module's own calls (which may act on what the assistant chose). */
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
      sub.pending.push(...changes)
      if (sub.pending.length > HA_LIMITS.queue) {
        sub.pending = []
        sub.overflowed = true
      }
      sub.latch.openUnsafe()
    }
  }

  /** A good poll: the cache follows it, and the subscribers learn what changed (or get a snapshot, see above). */
  const polled = (next: House) => {
    if (closed) return
    house = next
    const kinds = deps.kinds()
    const exposed = next.entities.filter((e) => kinds.has(e.kind)).map(toHaEntity)
    const nextById = new Map(exposed.map((e) => [e.entityId, { entity: e, json: JSON.stringify(e) }] as const))
    const before = byId
    const wasLive = connection === "connected"
    entities = exposed
    byId = nextById
    areas = next.areas.map((a) => ({ id: a.id, name: a.name, aliases: a.aliases }))
    connection = "connected"
    if (!wasLive) {
      push([{ _tag: "connection", connection: "connected" }, snapshot("reconnected")])
      return
    }
    const ids = [...new Set([...before.keys(), ...nextById.keys()])].sort()
    const changes: Array<HaChange> = []
    for (const id of ids) {
      const was = before.get(id)
      const now = nextById.get(id)
      if (now === undefined) changes.push({ _tag: "removed", entityId: id })
      else if (was === undefined || was.json !== now.json) changes.push({ _tag: "changed", entity: now.entity, previous: was?.entity })
    }
    push(changes)
  }

  /** A failed poll: the cache stays as it was. */
  const failed = () => {
    if (closed || connection !== "connected") return
    connection = "reconnecting"
    push([{ _tag: "connection", connection: "reconnecting" }])
  }

  const changes = (): Stream.Stream<HaChange> => {
    live()
    return Stream.callback<HaChange>((queue) =>
      Effect.gen(function*() {
        const latch = yield* Latch.make(false)
        const sub: Subscriber = { pending: [snapshot("subscribed")], overflowed: false, latch, end: () => void Queue.endUnsafe(queue) }
        if (closed) return yield* Queue.end(queue)
        subscribers.add(sub)
        yield* Effect.addFinalizer(() => Effect.sync(() => void subscribers.delete(sub)))
        // One item at a time into a buffer of one: what the consumer has not taken stays in `pending`, where an
        // overflow can replace it with a snapshot.
        while (true) {
          yield* latch.close
          if (sub.pending.length === 0 && !sub.overflowed) yield* latch.await
          let next: HaChange
          if (sub.overflowed) {
            sub.overflowed = false
            sub.pending = []
            next = snapshot("overflow")
          } else {
            const head = sub.pending.shift()
            if (head === undefined) continue
            next = head
          }
          if (!(yield* Queue.offer(queue, next))) return
        }
      }), { bufferSize: 1, strategy: "suspend" })
  }

  /**
   * The one checked path of every service call (the contract's "How a call names what it acts on"), before anything
   * reaches Home Assistant: the form, the bounds, the target keys in `data`, the refused domains (a script the owner
   * named is the module's own exception), the security covers, the connection, the exposure. Then one request within
   * `limitMs` (at most the contract's `callTimeoutMs`).
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
      const ownScene = (id: string) => caller === "own" && service === "turn_on" && (domain === "scene" || domain === "script") && house?.byId.get(id)?.runnable === true
      if (REFUSED_DOMAINS.includes(domain) && !ids.every(ownScene)) return refuse("refused", `the ${domain} domain is refused`)
      for (const id of ids) {
        const match = id.length <= HA_LIMITS.idChars ? ENTITY_ID.exec(id) : null
        if (match === null) return refuse("unknown_entity", "an entity id that is not Home Assistant's form")
        if (REFUSED_DOMAINS.includes(match[1]!) && !ownScene(id)) return refuse("refused", `an entity of the refused ${match[1]} domain`)
        if (house?.byId.get(id)?.security === true) return refuse("refused", "a garage door, a gate or a door")
      }
      if (connection !== "connected") return refuse("not_connected", `the last poll of Home Assistant ${connection === "unknown" ? "has not succeeded yet" : "failed"}`)
      for (const id of ids) {
        const known = caller === "consumer" ? byId.has(id) : house?.byId.has(id) === true && (house.byId.get(id)!.kind !== "person")
        if (!known) return refuse("unknown_entity", "an entity that is not exposed")
      }
      const returnResponse = call.returnResponse === true
      return deps.call(domain, service, { ...data, entity_id: [...ids] }, { timeoutMs: Math.min(limitMs, HA_LIMITS.callTimeoutMs), maxBytes: 256 * 1024, returnResponse }).pipe(
        Effect.mapError((e): CallProblem => ({
          reason: e.kind === "timeout" ? "timeout" : e.kind === "unreachable" ? "not_connected" : "failed",
          detail: fromUpstream(`${domain}.${service}: ${e.detail}`, deps.secrets),
          cause: e
        })),
        Effect.map((text): HaServiceResult => {
          if (!returnResponse) return {}
          let response: unknown
          try {
            response = (JSON.parse(text) as { readonly service_response?: unknown } | null)?.service_response
          } catch {
            return { responseCut: true }
          }
          if (response === undefined) return {}
          const json = JSON.stringify(response)
          return json === undefined || json.length > HA_LIMITS.responseChars ? { responseCut: true } : { response: JSON.parse(json) as Json }
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
      for (const sub of subscribers) sub.end()
      subscribers.clear()
    },
    subscriberCount: () => subscribers.size
  }
}

export type Transport = ReturnType<typeof makeTransport>
