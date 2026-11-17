import { Effect, Queue, Stream } from "effect"
import { type Actor, type CommittedChange, currentActor, HOUSEHOLD_SCOPE, type HouseholdStore, type ScopeRef, type TargetDevice } from "./HouseholdStore.ts"

/**
 * The household event bus (docs/MODULES-PLAN.md §4 P4; shared-state-jobs-and-notifications.md §5): one in-process bus
 * for data changes (published by the store after each commit, in change-log order), host events
 * (`host.turn.ended`, `host.device.connected`, `host.device.disconnected`, `host.module.state`) and events modules
 * publish (`<moduleId>.<type>`, docs/MODULES-PLAN.md §2 row 12).
 *
 * Publishing is synchronous and never waits: every subscriber has its own bounded queue (default 256 events), and a
 * subscriber that falls behind loses the newest events, counted and logged at most once per 10 s per subscriber. So a
 * slow subscriber never holds up a publisher, the turn path or the other subscribers. (Effect's `PubSub` shares one
 * capacity between its subscribers, so one slow subscriber would make every subscriber lose events or make the
 * publisher wait: the bus therefore fans out itself, one dropping queue per subscriber.)
 *
 * Nothing may depend on an event for correctness (docs/MODULES-PLAN.md §5.2): events are lost at a restart and by
 * a slow subscriber. Data is in the store.
 */

export interface HouseholdEvent {
  /** The change log's number, for data changes. */
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

export interface EventBus {
  /** Hand an event to every subscriber whose filter matches. Synchronous; never waits, never fails. */
  readonly publish: (event: HouseholdEvent) => void
  /**
   * The events matching `filter` from the moment the stream starts, until its consumer stops (the stream lives in the
   * caller's scope). `capacity`: this subscriber's queue (default 256); `name` appears in the drop warning.
   */
  readonly subscribe: (filter?: EventFilter, options?: { readonly capacity?: number; readonly name?: string }) => Stream.Stream<HouseholdEvent>
  /** Events published, events dropped for slow subscribers, and subscribers now. */
  readonly stats: () => { readonly published: number; readonly dropped: number; readonly subscribers: number }
  /** `ctx.events` of a module. */
  readonly forModule: (moduleId: string) => ModuleEvents
  /**
   * Publish every commit of `store` (its data changes, in change-log order), and hold the module events published
   * inside one of its transactions until that transaction commits (dropped if it rolls back). Returns the function
   * that undoes both. `connectStoreToBus` is this.
   */
  readonly connect: (store: HouseholdStore) => () => void
}

/** `ctx.events`: a module's own events (namespaced by its id) and every event on the bus. */
export interface ModuleEvents {
  /**
   * Publish `<moduleId>.<type>` (type: lower-case words with dots, dashes and underscores). Scope default household;
   * the actor is the turn's, else the module. Inside a transaction of the store the bus is connected to, it is held
   * until that transaction commits (after the data changes before it, before those after it) and dropped if it rolls
   * back. It is sent to voice pages only when the module declared the type with a projection (`defineEventType`).
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
  /** Without it the type is never sent to pages. `undefined`: not for this device. Return plain JSON. */
  readonly project?: (event: HouseholdEvent, device: TargetDevice) => unknown
}

const TYPE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/

export const defineEventType = (definition: { readonly type: string; readonly project?: EventType["project"] }): EventType => {
  if (!TYPE.test(definition.type) || definition.type.length > 80) throw new Error(`Event type "${definition.type}" must be lower-case words separated by dots`)
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
  dropped: number
  warnedAt: number
}

export interface EventBusOptions {
  /** A warning line (slow subscribers). Default: none. */
  readonly log?: (line: string) => void
  /** Clock for warnings (ms). Default `Date.now`. */
  readonly now?: () => number
  readonly defaultCapacity?: number
  /** Sees every event as it is published (tests: `makeRecordingEventBus`). */
  readonly observe?: (event: HouseholdEvent) => void
}

export const makeEventBus = (options: EventBusOptions = {}): EventBus => {
  const subscribers = new Set<Subscriber>()
  /** The store whose transactions hold module events back (`connect`). */
  let store: HouseholdStore | undefined
  const now = options.now ?? Date.now
  let published = 0
  let dropped = 0

  const publish = (event: HouseholdEvent) => {
    published++
    try {
      options.observe?.(event)
    } catch {
      // An observer must not break a publisher.
    }
    for (const s of subscribers) {
      if (!matchesFilter(event, s.filter)) continue
      if (Queue.offerUnsafe(s.queue, event)) continue
      s.dropped++
      dropped++
      const t = now()
      if (t - s.warnedAt >= 10_000) {
        s.warnedAt = t
        options.log?.(`Event bus: subscriber ${s.name} is too slow; ${s.dropped} event(s) dropped so far`)
      }
    }
  }

  const subscribe: EventBus["subscribe"] = (filter, opts) =>
    Stream.callback<HouseholdEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const s: Subscriber = { filter, queue, name: opts?.name ?? "anonymous", dropped: 0, warnedAt: -Infinity }
          subscribers.add(s)
          return s
        }),
        (s) => Effect.sync(() => subscribers.delete(s))
      ), { bufferSize: opts?.capacity ?? options.defaultCapacity ?? 256, strategy: "dropping" })

  const forModule = (moduleId: string): ModuleEvents => ({
    publish: (type, data, scope) =>
      Effect.gen(function*() {
        if (!TYPE.test(type) || type.length > 80) {
          yield* Effect.logWarning(`Module ${moduleId}: event type "${type}" is not lower-case words separated by dots; not published`)
          return
        }
        const actor = yield* currentActor(moduleId)
        const event: HouseholdEvent = { at: now(), module: moduleId, type: `${moduleId}.${type}`, scope: scope ?? HOUSEHOLD_SCOPE, actor, data }
        if (store === undefined) return publish(event)
        // Inside one of the store's transactions: after its commit, in order with its changes; never on a rollback.
        yield* store.afterCommit(() => publish(event)).pipe(
          Effect.catch((e) => Effect.logWarning(`Module ${moduleId}: event ${type} not published: ${e.message}`))
        )
      }),
    subscribe: (filter, opts) => subscribe(filter, { ...opts, name: `module ${moduleId}` })
  })

  const connect = (target: HouseholdStore) => {
    store = target
    const off = target.onCommit((changes) => {
      for (const change of changes) publish(changeEvent(change))
    })
    return () => {
      off()
      if (store === target) store = undefined
    }
  }

  return { publish, subscribe, stats: () => ({ published, dropped, subscribers: subscribers.size }), forModule, connect }
}

/** The bus event of a committed data change: `<module>.<collection>.changed`, after the commit, in change-log order. */
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

/** Publish every commit of `store` on `bus`, and hold module events back until their transaction commits (`EventBus.connect`). */
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
