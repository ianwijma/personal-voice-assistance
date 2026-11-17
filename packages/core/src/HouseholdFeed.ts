import type { HouseholdChange, HouseholdCollectionRows, HouseholdEventInfo, HouseholdRow } from "@pva/protocol"
import { Effect } from "effect"
import type { EventType, HouseholdEvent } from "./EventBus.ts"
import type { ChangeRecord, Collection, HouseholdStore, Row, ScopeRef, StoreError, TargetDevice } from "./HouseholdStore.ts"
import { decodeStored } from "./HouseholdStore.ts"

/**
 * What voice pages receive of the household data (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4).
 *
 * Nothing is sent by default. A collection opts in with `project(row, device)` and an event type with
 * `project(event, device)`: what a page on that device may see, or `undefined` for nothing. The same function decides
 * the three paths, always applied to the row **as it is now**:
 *
 * - the snapshot after `welcome`: every visible row, projected;
 * - a live change: `put` with the projected row when it is visible now, `remove` when it is gone or hidden now but the
 *   device could see the value it replaced, nothing otherwise;
 * - the replay after a reconnect: the same rule per row changed since the page's `seq`, with "the value it replaced"
 *   being the value before the first change the page missed. Older payloads in the change log only decide whether to
 *   send a `remove`; their content is never sent. When that earlier value is not in the log (`history: "none"`, an
 *   erased row) or the gap is too long or pruned, the page gets a fresh snapshot instead.
 *
 * Before any projection, `mayRevealScopeTo` decides by scope (below).
 */

/**
 * THE one place where the scope of a row or event decides whether a voice page may see it at all. P5 replaces the
 * `person` branch with `Privacy.mayReveal` (docs/MODULES-PLAN.md §2 row 8); until then person-scoped data is never sent
 * to a page. Household data goes to every voice page, device data to that device only, assistant and conversation
 * data to none (they belong to turns, not to screens).
 */
export const mayRevealScopeTo = (scope: ScopeRef, device: TargetDevice): boolean => {
  switch (scope.kind) {
    case "household":
      return true
    case "device":
      return device.id !== undefined && scope.id === device.id
    case "person":
      return false // P5: Privacy.mayReveal(person, device)
    case "assistant":
    case "conversation":
      return false
  }
}

/** A module's declarations the feed reads. */
export interface FeedModule {
  readonly moduleId: string
  readonly collections: ReadonlyArray<Collection<any>>
  readonly events: ReadonlyArray<EventType>
}

/** The most rows of one collection in a snapshot. */
export const SNAPSHOT_ROWS = 500
/** The most changes a replay walks; a longer gap gets a snapshot. */
export const REPLAY_CHANGES = 1000

export type ProjectedChange = { readonly op: "put"; readonly value: unknown } | { readonly op: "remove" }

const safeProject = <T>(project: ((x: T, device: TargetDevice) => unknown) | undefined, x: T, device: TargetDevice): unknown => {
  if (project === undefined) return undefined
  try {
    return project(x, device)
  } catch {
    return undefined
  }
}

/** What `device` may see of `row` (`undefined`: nothing). */
export const projectRow = (collection: Collection<any>, row: Row<unknown> | undefined, device: TargetDevice): unknown =>
  row === undefined || !mayRevealScopeTo(row.scope, device) ? undefined : safeProject(collection.project, row, device)

/** The rule shared by live changes and the replay: from the value the device had (`before`) to the row now. */
export const projectChange = (
  collection: Collection<any>,
  before: Row<unknown> | undefined,
  now: Row<unknown> | undefined,
  device: TargetDevice
): ProjectedChange | undefined => {
  const value = projectRow(collection, now, device)
  if (value !== undefined) return { op: "put", value }
  return projectRow(collection, before, device) !== undefined ? { op: "remove" } : undefined
}

export type Replay =
  | { readonly kind: "events"; readonly events: ReadonlyArray<HouseholdEventInfo> }
  | { readonly kind: "snapshot"; readonly seq: number; readonly collections: ReadonlyArray<HouseholdCollectionRows> }

export interface HouseholdFeed {
  /** Whether any collection or event type is sent to pages (nothing to do otherwise). */
  readonly active: boolean
  readonly snapshot: (device: TargetDevice) => Effect.Effect<{ readonly seq: number; readonly collections: ReadonlyArray<HouseholdCollectionRows> }, StoreError>
  /** What `device` gets of a bus event now, or `undefined`. Synchronous (the hub calls it per connection). */
  readonly live: (event: HouseholdEvent, device: TargetDevice) => HouseholdEventInfo | undefined
  /** After a reconnect with the page's last `seq`. */
  readonly replay: (device: TargetDevice, seq: number) => Effect.Effect<Replay, StoreError>
}

export const makeHouseholdFeed = (options: { readonly store: HouseholdStore; readonly modules: ReadonlyArray<FeedModule> }): HouseholdFeed => {
  const { store } = options
  const collections = new Map<string, Collection<any>>()
  const eventTypes = new Map<string, EventType>()
  for (const m of options.modules) {
    for (const c of m.collections) if (c.project !== undefined) collections.set(`${m.moduleId}/${c.name}`, c)
    for (const e of m.events) if (e.project !== undefined) eventTypes.set(`${m.moduleId}.${e.type}`, e)
  }
  const sent = [...collections.entries()].map(([key, c]) => ({ moduleId: key.slice(0, key.indexOf("/")), collection: c }))

  const changeInfo = (
    meta: { readonly seq: number; readonly at: number; readonly module: string; readonly collection: string; readonly id: string; readonly rev: number; readonly scope: ScopeRef },
    projected: ProjectedChange
  ): HouseholdEventInfo => {
    const data: HouseholdChange = {
      collection: meta.collection,
      id: meta.id,
      op: projected.op,
      rev: meta.rev,
      ...(projected.op === "put" ? { value: projected.value } : {})
    }
    return { seq: meta.seq, at: meta.at, module: meta.module, type: `${meta.module}.${meta.collection}.changed`, scope: meta.scope, data }
  }

  const live = (event: HouseholdEvent, device: TargetDevice): HouseholdEventInfo | undefined => {
    const change = event.change
    if (change !== undefined) {
      const collection = collections.get(`${change.module}/${change.collection}`)
      if (collection === undefined) return undefined
      const projected = projectChange(collection, change.before, change.row, device)
      return projected === undefined ? undefined : changeInfo(change, projected)
    }
    const type = eventTypes.get(event.type)
    if (type === undefined || !mayRevealScopeTo(event.scope, device)) return undefined
    const data = safeProject(type.project, event, device)
    return data === undefined ? undefined : { at: event.at, module: event.module, type: event.type, scope: event.scope, data }
  }

  const snapshot = (device: TargetDevice) =>
    Effect.gen(function*() {
      // The number first: a change committed while the rows are read is also sent live (a `put` again is harmless).
      const seq = yield* store.lastSeq
      const out: Array<HouseholdCollectionRows> = []
      for (const { moduleId, collection } of sent) {
        const scope: ScopeRef | undefined = collection.scope === "household"
          ? { kind: "household" }
          : collection.scope === "device" && device.id !== undefined ? { kind: "device", id: device.id } : undefined
        if (scope === undefined || !mayRevealScopeTo(scope, device)) continue
        const rows = yield* store.forModule(moduleId).collection(collection).list({ scope, limit: SNAPSHOT_ROWS }).pipe(
          Effect.catchTag("ScopeUnknown", () => Effect.succeed([] as ReadonlyArray<Row<unknown>>))
        )
        const visible: Array<HouseholdRow> = []
        for (const row of rows) {
          const value = projectRow(collection, row, device)
          if (value !== undefined) visible.push({ id: row.id, rev: row.rev, scope: row.scope, value, updatedAt: row.updatedAt })
        }
        out.push({ module: moduleId, collection: collection.name, rows: visible, truncated: rows.length >= SNAPSHOT_ROWS })
      }
      return { seq, collections: out }
    })

  /** The value a row had before `first` (the first change the page missed), or "unknown" when the log cannot say. */
  const beforeOf = (collection: Collection<any>, first: ChangeRecord): Effect.Effect<Row<unknown> | undefined | "unknown"> => {
    if (first.op === "insert") return Effect.succeed(undefined)
    const before = first.payload?.before
    if (first.payload === undefined || before === undefined) return Effect.succeed("unknown")
    return decodeStored(collection, first.payload.v, before, first.id).pipe(
      Effect.map((d): Row<unknown> => ({ id: first.id, rev: first.rev - 1, scope: first.scope, value: d.value, createdAt: 0, updatedAt: first.at, updatedBy: first.actor })),
      Effect.orElseSucceed(() => "unknown" as const)
    )
  }

  const replay = (device: TargetDevice, seq: number) =>
    Effect.gen(function*() {
      const fresh = Effect.map(snapshot(device), (s): Replay => ({ kind: "snapshot", ...s }))
      const last = yield* store.lastSeq
      if (seq > last) return yield* fresh // a restored or replaced database: the page's numbers mean nothing here
      if (seq === last) return { kind: "events", events: [] } satisfies Replay
      const page = yield* store.changesSince(seq, REPLAY_CHANGES)
      // Too long a gap, or changes the page missed were pruned (numbers have no holes otherwise).
      if (!page.complete || page.oldest > seq + 1) return yield* fresh
      // One entry per row, in the order of its last change.
      const rows = new Map<string, { first: ChangeRecord; last: ChangeRecord; collection: Collection<any> }>()
      for (const change of page.changes) {
        const collection = collections.get(`${change.module}/${change.collection}`)
        if (collection === undefined) continue
        const key = `${change.module}/${change.collection}/${change.id}`
        const at = rows.get(key)
        if (at === undefined) rows.set(key, { first: change, last: change, collection })
        else {
          rows.delete(key)
          rows.set(key, { ...at, last: change })
        }
      }
      const events: Array<HouseholdEventInfo> = []
      for (const { first, last: lastChange, collection } of rows.values()) {
        const now = yield* store.forModule(lastChange.module).collection(collection).get(lastChange.id, { scope: lastChange.scope }).pipe(
          Effect.catchTag("ScopeUnknown", () => Effect.succeed(undefined))
        )
        const nowValue = projectRow(collection, now, device)
        if (nowValue !== undefined) {
          events.push(changeInfo({ ...lastChange, rev: now!.rev, scope: now!.scope }, { op: "put", value: nowValue }))
          continue
        }
        const before = yield* beforeOf(collection, first)
        if (before === "unknown") return yield* fresh
        if (projectRow(collection, before, device) !== undefined) events.push(changeInfo(lastChange, { op: "remove" }))
      }
      return { kind: "events", events } satisfies Replay
    })

  return { active: collections.size > 0 || eventTypes.size > 0, snapshot, live, replay }
}
