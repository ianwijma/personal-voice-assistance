import { Effect, Queue, Stream } from "effect"
import {
  type Actor,
  type CommittedChange,
  currentActor,
  HOUSEHOLD_SCOPE,
  type HouseholdStore,
  type ModuleEventRecord,
  SAFE_ID,
  type ScopeRef,
  type TargetDevice
} from "./HouseholdStore.ts"
import { EVENT_TYPE, RESERVED_MODULE_IDS } from "./StoreEngine.ts"

/**
 * The household event bus (docs/MODULES-PLAN.md §4 P4): one in-process bus for data changes (released by the store
 * after each commit, in order), host events (`host.turn.ended`, `host.device.connected`, `host.device.disconnected`,
 * `host.module.state`) and events modules publish (`<moduleId>.<type>`, docs/MODULES-PLAN.md §2 row 12). The `host.`
 * namespace is the host's: no module can have the id `host`, and a module's `publish` always prefixes its own id.
 *
 * Publishing is synchronous and never waits: every subscriber has its own bounded queue (default 256 events, 1 to
 * `MAX_SUBSCRIBER_CAPACITY`: any other `capacity` is brought into that range, so no option makes a queue unbounded or
 * hands events over synchronously), and a subscriber that falls behind loses the newest events, counted and logged at
 * most once per 10 s per subscriber. **No subscriber code ever runs on a publisher's stack** (nor on a committing
 * transaction's): an event is handed to the subscriber's fiber through the queue's scheduler, and a subscription that
 * ends (its gate says so) is taken out of the fan-out at once and its stream completed in a microtask, after the
 * publisher returned. So a slow subscriber never holds up a publisher, the turn path or the other subscribers, and a
 * failing logger or clock does not either.
 *
 * Nothing may depend on an event for correctness (docs/MODULES-PLAN.md §5.2): events are lost at a restart and by
 * a slow subscriber. Data is in the store.
 */

export interface HouseholdEvent {
  /** The store counter's number, for data changes. */
  readonly seq?: number
  readonly at: number
  /** The module that emitted it, or `host`. */
  readonly module: string
  /** The full name: `<module>.<type>` (`timers.timers.changed`, `kitchen.stock.low`, `host.turn.ended`). */
  readonly type: string
  readonly scope: ScopeRef
  readonly actor?: Actor
  readonly data: unknown
  /** A data change (`<module>.<collection>.changed`): the committed change with its decoded rows. */
  readonly change?: CommittedChange
}

/** Which events a subscriber wants: by module, by exact type, or by type prefix (`"timers."`). Empty: all. */
export interface EventFilter {
  readonly module?: string
  readonly type?: string
  readonly prefix?: string
}

/**
 * Whether a subscription may receive events now: `live` (deliver), `waiting` (not yet: drop), `ended` (end the stream).
 * A module's `shared` part subscribes with the gate of its generation: waiting until it is published, ended once it is
 * replaced or retired.
 */
export type SubscriptionGate = () => "live" | "waiting" | "ended"

/** The largest queue a subscriber may ask for. */
export const MAX_SUBSCRIBER_CAPACITY = 4096
/** The queue a subscriber gets when it asks for none. */
export const DEFAULT_SUBSCRIBER_CAPACITY = 256

/** A queue size from an option: a whole number from 1 to `MAX_SUBSCRIBER_CAPACITY` (anything else is brought into it). */
export const subscriberCapacity = (asked: number | undefined, fallback = DEFAULT_SUBSCRIBER_CAPACITY): number =>
  typeof asked === "number" && Number.isFinite(asked) ? Math.min(MAX_SUBSCRIBER_CAPACITY, Math.max(1, Math.floor(asked))) : fallback

export interface SubscribeOptions {
  /** This subscriber's queue: 1 to `MAX_SUBSCRIBER_CAPACITY` (default 256). */
  readonly capacity?: number
  readonly name?: string
  readonly gate?: SubscriptionGate
}

export interface EventBus {
  /** Hand an event to every subscriber whose filter matches. Synchronous; never waits, never fails. */
  readonly publish: (event: HouseholdEvent) => void
  /**
   * The events matching `filter` from the moment the stream starts, until its consumer stops (the stream lives in the
   * caller's scope). `capacity`: this subscriber's queue (default 256, 1 to `MAX_SUBSCRIBER_CAPACITY`); `name` appears
   * in the drop warning.
   */
  readonly subscribe: (filter?: EventFilter, options?: SubscribeOptions) => Stream.Stream<HouseholdEvent>
  /** Events published, events dropped for slow subscribers, and subscribers now. */
  readonly stats: () => { readonly published: number; readonly dropped: number; readonly subscribers: number }
  /** `ctx.events` of a module; `gate` for a `shared` part's generation. */
  readonly forModule: (moduleId: string, options?: { readonly gate?: SubscriptionGate }) => ModuleEvents
  /**
   * Publish what `store` releases after each commit (its data changes and module events, in order), and send module
   * events through it (`HouseholdStore.publish`), so they wait for the commit of a running transaction. Returns the
   * function that undoes it. `connectStoreToBus` is this.
   */
  readonly connect: (store: HouseholdStore) => () => void
}

/** `ctx.events`: a module's own events (namespaced by its id) and every event on the bus. */
export interface ModuleEvents {
  /**
   * Publish `<moduleId>.<type>` (type: lower-case words with dots, dashes and underscores, at most 80 characters; an
   * invalid one is logged and not published). Scope default household; the actor is the turn's, else the module.
   * Inside a running transaction of the store the bus is connected to it waits for the commit (use `tx.publish` there).
   * It is sent to voice pages only when the module declared the type with a projection (`defineEventType`).
   */
  readonly publish: (type: string, data: unknown, scope?: ScopeRef) => Effect.Effect<void>
  /** As `EventBus.subscribe`: a stream that lives in the caller's scope (fork it in `shared`'s scope). */
  readonly subscribe: (filter?: EventFilter, options?: { readonly capacity?: number }) => Stream.Stream<HouseholdEvent>
}

/** An event type a module declares (`defineModule({ events })`), with what a voice page on `device` may see of it. */
export interface EventType {
  readonly _tag: "EventType"
  /** Without the module prefix: `stock.low`. */
  readonly type: string
  /**
   * Without it the type is never sent to pages. Called when the event's frame is built for a page, with the server's
   * record of its device. `undefined`: not for this device. Return plain JSON.
   */
  readonly project?: (event: HouseholdEvent, device: TargetDevice) => unknown
}

export const defineEventType = (definition: { readonly type: string; readonly project?: EventType["project"] }): EventType => {
  if (!EVENT_TYPE.test(definition.type) || definition.type.length > 80) throw new Error(`Event type "${definition.type}" must be lower-case words separated by dots`)
  return { _tag: "EventType", type: definition.type, ...(definition.project !== undefined ? { project: definition.project } : {}) }
}

export const matchesFilter = (event: HouseholdEvent, filter: EventFilter | undefined): boolean =>
  filter === undefined ||
  ((filter.module === undefined || filter.module === event.module) &&
    (filter.type === undefined || filter.type === event.type) &&
    (filter.prefix === undefined || event.type.startsWith(filter.prefix)))

interface Subscriber {
  readonly filter: EventFilter | undefined
  readonly queue: Queue.Queue<HouseholdEvent, any>
  readonly name: string
  readonly gate: SubscriptionGate | undefined
  dropped: number
  warnedAt: number
}

export interface EventBusOptions {
  /** A warning line (slow subscribers). Default: none. */
  readonly log?: (line: string) => void
  /** Clock for warnings (ms). Default `Date.now`. */
  readonly now?: () => number
  /** The queue of a subscriber that asks for none (1 to `MAX_SUBSCRIBER_CAPACITY`; default 256). */
  readonly defaultCapacity?: number
  /** Sees every event as it is published (tests: `makeRecordingEventBus`). */
  readonly observe?: (event: HouseholdEvent) => void
}

/** A module event as the bus carries it. */
export const moduleEvent = (e: ModuleEventRecord): HouseholdEvent => ({ at: e.at, module: e.module, type: e.type, scope: e.scope, actor: e.actor, data: e.data })

export const makeEventBus = (options: EventBusOptions = {}): EventBus => {
  const subscribers = new Set<Subscriber>()
  /** The store whose transactions hold module events back (`connect`). */
  let store: HouseholdStore | undefined
  const safely = <A>(f: () => A, fallback: A): A => {
    try {
      return f()
    } catch {
      return fallback
    }
  }
  const now = () => safely(options.now ?? Date.now, 0)
  const defaultCapacity = subscriberCapacity(options.defaultCapacity)
  let published = 0
  let dropped = 0

  const publish = (event: HouseholdEvent) => {
    published++
    safely(() => options.observe?.(event), undefined)
    for (const s of subscribers) {
      if (!matchesFilter(event, s.filter)) continue
      const gate = s.gate === undefined ? "live" : safely(s.gate, "ended" as const)
      if (gate === "waiting") continue
      if (gate === "ended") {
        // Out of the fan-out now; the stream ends after this publisher returned (ending it here would resume its
        // consumer, and run its finalizers, on this stack).
        subscribers.delete(s)
        queueMicrotask(() => Queue.endUnsafe(s.queue))
        continue
      }
      if (Queue.offerUnsafe(s.queue, event)) continue
      s.dropped++
      dropped++
      const t = now()
      if (t - s.warnedAt >= 10_000) {
        s.warnedAt = t
        safely(() => options.log?.(`Event bus: subscriber ${s.name} is too slow; ${s.dropped} event(s) dropped so far`), undefined)
      }
    }
  }

  const subscribe: EventBus["subscribe"] = (filter, opts) =>
    Stream.callback<HouseholdEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const s: Subscriber = { filter, queue, name: opts?.name ?? "anonymous", gate: opts?.gate, dropped: 0, warnedAt: -Infinity }
          subscribers.add(s)
          return s
        }),
        (s) => Effect.sync(() => subscribers.delete(s))
      ), { bufferSize: subscriberCapacity(opts?.capacity, defaultCapacity), strategy: "dropping" })

  const forModule: EventBus["forModule"] = (moduleId, moduleOptions) => ({
    publish: (type, data, scope) =>
      Effect.gen(function*() {
        if (RESERVED_MODULE_IDS.has(moduleId)) {
          yield* Effect.logWarning(`Module ${moduleId}: "${moduleId}." is the host's event namespace; not published`)
          return
        }
        if (!EVENT_TYPE.test(type) || type.length > 80) {
          yield* Effect.logWarning(`Module ${moduleId}: event type "${type}" is not lower-case words separated by dots; not published`)
          return
        }
        if (scope !== undefined && scope.kind !== "household" && !SAFE_ID.test(scope.id)) {
          yield* Effect.logWarning(`Module ${moduleId}: event ${type} has a scope id outside the safe alphabet; not published`)
          return
        }
        const actor = yield* currentActor(moduleId)
        const event: ModuleEventRecord = { at: now(), module: moduleId, type: `${moduleId}.${type}`, scope: scope === undefined ? HOUSEHOLD_SCOPE : { ...scope }, actor, data }
        // Through the store: after the commit of a running transaction, in order with its changes; at once otherwise.
        if (store === undefined) publish(moduleEvent(event))
        else store.publish(event)
      }),
    subscribe: (filter, opts) =>
      subscribe(filter, { ...opts, name: `module ${moduleId}`, ...(moduleOptions?.gate !== undefined ? { gate: moduleOptions.gate } : {}) })
  })

  const connect = (target: HouseholdStore) => {
    store = target
    const off = target.onCommit((released) => {
      for (const item of released) publish(item._tag === "change" ? changeEvent(item.change) : moduleEvent(item.event))
    })
    return () => {
      off()
      if (store === target) store = undefined
    }
  }

  return { publish, subscribe, stats: () => ({ published, dropped, subscribers: subscribers.size }), forModule, connect }
}

/** The bus event of a committed data change: `<module>.<collection>.changed`, after the commit, in order. */
export const changeEvent = (change: CommittedChange): HouseholdEvent => ({
  seq: change.seq,
  at: change.at,
  module: change.module,
  type: `${change.module}.${change.collection}.changed`,
  scope: change.scope,
  actor: change.actor,
  data: { collection: change.collection, id: change.id, op: change.op, rev: change.rev },
  change
})

/** Publish every commit of `store` on `bus`, and send module events through the store (`EventBus.connect`). */
export const connectStoreToBus = (store: HouseholdStore, bus: EventBus): (() => void) => bus.connect(store)

/** A host event (`host.<type>`). */
export const hostEvent = (type: "turn.ended" | "device.connected" | "device.disconnected" | "module.state", data: unknown, scope: ScopeRef = HOUSEHOLD_SCOPE): HouseholdEvent => ({
  at: Date.now(),
  module: "host",
  type: `host.${type}`,
  scope,
  actor: { kind: "system", name: "host" },
  data
})
