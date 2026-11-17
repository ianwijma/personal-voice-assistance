import type { HouseholdChange, HouseholdCollectionRows, HouseholdEventInfo, HouseholdRow } from "@pva/protocol"
import { Effect } from "effect"
import type { EventType, HouseholdEvent } from "./EventBus.ts"
import type { ChangeRecord, Collection, HouseholdStore, Row, ScopeRef, StoreError, TargetDevice } from "./HouseholdStore.ts"
import { MAX_VALUE_CHARS } from "./HouseholdStore.ts"
import { mayRevealTo } from "./Privacy.ts"

/**
 * What voice pages receive of the household data (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4).
 *
 * Nothing is sent by default. A collection opts in with `project(row, device)` and an event type with
 * `project(event, device)`: what a page on that device may see, or `undefined` for nothing. Only **committed current
 * state** is ever projected, never a value from the change log or from an event:
 *
 * - **Snapshot** (`snapshot`) after every `welcome`, also after a reconnect: every visible row now, projected, in parts
 *   that each fit one text frame (`SNAPSHOT_PART_CHARS`), at most `SNAPSHOT_ROWS` rows per collection and
 *   `SNAPSHOT_MAX_CHARS` in all (`truncated` says when rows were left out). It comes with a cursor: the change number
 *   it is current to and the rows the page now holds.
 * - **Changes** (`catchUp`): the change log after the cursor, a page of `CATCH_UP_CHANGES` at a time, read from the
 *   store (not from the bus, which may drop), coalesced per row; for each row its current value through the
 *   projection: `put` when the page may see it, `remove` when it may not but the page holds it, nothing otherwise.
 *   When the log no longer has what the page missed (pruned), the answer is `resync`: send a fresh snapshot.
 * - **Module events** (`live`): an event type's projection, for the events a module publishes (they are not in the
 *   log, and are lost to a page that is not connected).
 *
 * A projection that throws, returns something that is not plain JSON or more than `MAX_VALUE_CHARS` of it, is
 * treated as "not visible" for that row or event (so a page loses the row rather than keeping a stale one) and
 * reported (`report`, a Health issue in serve mode). It affects only its own collection or event type.
 *
 * Before any projection, `mayRevealScopeTo` decides by scope (below).
 */

/**
 * THE one place where the scope of a row or event decides whether a voice page may see it at all. Household data goes
 * to every voice page, device data to that device only, person data where `Privacy.mayReveal` allows it
 * (docs/MODULES-PLAN.md §2 row 8: a `private` device, or a `shared` one whose default person is the owner), assistant
 * and conversation data to none (they belong to turns, not to screens).
 */
export const mayRevealScopeTo = (scope: ScopeRef, device: TargetDevice): boolean => {
  switch (scope.kind) {
    case "household":
      return true
    case "device":
      return device.id !== undefined && scope.id === device.id
    case "person":
      return mayRevealTo(scope.id, { privacy: device.privacy ?? "shared", defaultPerson: device.defaultPerson ?? null })
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
/** The most characters of rows in one `household.snapshot` message (the protocol's frame limit is 1,048,576). */
export const SNAPSHOT_PART_CHARS = 256_000
/** The most characters of rows in one whole snapshot; collections past it are `truncated`. */
export const SNAPSHOT_MAX_CHARS = 4_000_000
/** The changes read per `catchUp` call. */
export const CATCH_UP_CHANGES = 50

/** A projection that failed (`report`). */
export interface FeedProblem {
  readonly module: string
  /** The collection or the event type. */
  readonly what: string
  readonly message: string
}

/** Where a page is: the change number it is current to, and the rows (`module/collection/id`) it holds. */
export interface FeedCursor {
  seq: number
  readonly visible: Set<string>
}

export type CatchUp =
  | { readonly kind: "changes"; readonly events: ReadonlyArray<HouseholdEventInfo>; readonly more: boolean }
  | { readonly kind: "resync" }

export interface Snapshot {
  readonly seq: number
  /** The rows in parts, each one `household.snapshot` message (`part` 0…, `final` on the last). */
  readonly parts: ReadonlyArray<ReadonlyArray<HouseholdCollectionRows>>
  readonly cursor: FeedCursor
}

export interface HouseholdFeed {
  /** Whether any collection or event type is sent to pages (nothing to do otherwise). */
  readonly active: boolean
  readonly snapshot: (device: TargetDevice) => Effect.Effect<Snapshot, StoreError>
  /** The changes after `cursor.seq` as `device` may see them now; advances the cursor. */
  readonly catchUp: (device: TargetDevice, cursor: FeedCursor) => Effect.Effect<CatchUp, StoreError>
  /** What `device` gets of a module event now, or `undefined`. Data changes are not delivered from the bus (`catchUp`). */
  readonly live: (event: HouseholdEvent, device: TargetDevice) => HouseholdEventInfo | undefined
}

type Projected = { readonly visible: true; readonly value: unknown; readonly chars: number } | { readonly visible: false; readonly problem?: string }

const HIDDEN: Projected = { visible: false }

/** Run a projection and make its result plain JSON of a bounded size, or say why it cannot be sent. */
const runProjection = <T>(project: ((x: T, device: TargetDevice) => unknown) | undefined, x: T, device: TargetDevice): Projected => {
  if (project === undefined) return HIDDEN
  let out: unknown
  try {
    out = project(x, device)
  } catch (e) {
    return { visible: false, problem: `the projection threw: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (out === undefined) return HIDDEN
  let text: string | undefined
  try {
    text = JSON.stringify(out)
  } catch (e) {
    return { visible: false, problem: `the projection's result is not JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (text === undefined) return { visible: false, problem: "the projection's result is not JSON" }
  if (text.length > MAX_VALUE_CHARS) return { visible: false, problem: `the projection's result has ${text.length} characters (at most ${MAX_VALUE_CHARS})` }
  return { visible: true, value: JSON.parse(text) as unknown, chars: text.length }
}

/** What `device` may see of `row` (`undefined`: nothing, also when the projection fails). Plain JSON. */
export const projectRow = (collection: Collection<any>, row: Row<unknown> | undefined, device: TargetDevice): unknown => {
  if (row === undefined || !mayRevealScopeTo(row.scope, device)) return undefined
  const p = runProjection(collection.project, row, device)
  return p.visible ? p.value : undefined
}

const rowKey = (module: string, collection: string, id: string) => `${module}/${collection}/${id}`

export const makeHouseholdFeed = (options: {
  readonly store: HouseholdStore
  readonly modules: ReadonlyArray<FeedModule>
  /** A failing projection (serve mode: a Health issue). */
  readonly report?: (problem: FeedProblem) => void
  /** The household's person ids now (Members), for the person-scoped rows of a snapshot. Absent: the device's default person only. */
  readonly people?: () => ReadonlyArray<string>
}): HouseholdFeed => {
  const { store } = options
  const collections = new Map<string, Collection<any>>()
  const eventTypes = new Map<string, EventType>()
  for (const m of options.modules) {
    for (const c of m.collections) if (c.project !== undefined) collections.set(`${m.moduleId}/${c.name}`, c)
    for (const e of m.events) if (e.project !== undefined) eventTypes.set(`${m.moduleId}.${e.type}`, e)
  }
  const sent = [...collections.entries()].map(([key, c]) => ({ moduleId: key.slice(0, key.indexOf("/")), collection: c }))
  /** A module whose data cannot be used here (newer, failed upgrade) is never read for pages. */
  const usable = (moduleId: string) => store.availability(moduleId) === undefined
  const report = (module: string, what: string, message: string) => {
    try {
      options.report?.({ module, what, message })
    } catch {
      // Reporting must not break delivery.
    }
  }

  const projectFor = (moduleId: string, collection: Collection<any>, row: Row<unknown> | undefined, device: TargetDevice): Projected => {
    if (row === undefined || !mayRevealScopeTo(row.scope, device)) return HIDDEN
    const p = runProjection(collection.project, row, device)
    if (!p.visible && p.problem !== undefined) report(moduleId, collection.name, `row ${row.id}: ${p.problem}`)
    return p
  }

  const live = (event: HouseholdEvent, device: TargetDevice): HouseholdEventInfo | undefined => {
    if (event.change !== undefined) return undefined
    const type = eventTypes.get(event.type)
    if (type === undefined || !usable(event.module) || !mayRevealScopeTo(event.scope, device)) return undefined
    const p = runProjection(type.project, event, device)
    if (!p.visible) {
      if (p.problem !== undefined) report(event.module, event.type, p.problem)
      return undefined
    }
    return { at: event.at, module: event.module, type: event.type, scope: event.scope, data: p.value }
  }

  const scopesOf = (collection: Collection<any>, device: TargetDevice): ReadonlyArray<ScopeRef> => {
    const scopes: ReadonlyArray<ScopeRef> = collection.scope === "household"
      ? [{ kind: "household" }]
      : collection.scope === "device" && device.id !== undefined
      ? [{ kind: "device", id: device.id }]
      : collection.scope === "person"
      // P5: one read per person the device may see, the device's default person first.
      ? [...new Set([...(device.defaultPerson !== undefined ? [device.defaultPerson] : []), ...(options.people?.() ?? [])])].map((id): ScopeRef => ({ kind: "person", id }))
      : []
    return scopes.filter((scope) => mayRevealScopeTo(scope, device))
  }

  const snapshot = (device: TargetDevice) =>
    Effect.gen(function*() {
      // The number first: a change committed while the rows are read comes again from `catchUp` (a `put` again is harmless).
      const seq = yield* store.lastSeq
      const cursor: FeedCursor = { seq, visible: new Set() }
      const parts: Array<Array<HouseholdCollectionRows>> = [[]]
      let partChars = 0
      let total = 0
      for (const { moduleId, collection } of sent) {
        if (!usable(moduleId)) continue
        const scopes = scopesOf(collection, device)
        if (scopes.length === 0) continue
        let chunk: { module: string; collection: string; rows: Array<HouseholdRow>; truncated: boolean } = { module: moduleId, collection: collection.name, rows: [], truncated: false }
        parts[parts.length - 1]!.push(chunk)
        for (const scope of scopes) {
          const read = yield* Effect.result(store.forModule(moduleId).collection(collection).list({ scope, limit: SNAPSHOT_ROWS }))
          if (read._tag === "Failure") {
            const e = read.failure
            if (e._tag !== "ScopeUnknown") report(moduleId, collection.name, `could not be read for a page: ${e.message}`)
            chunk.truncated = true
            continue
          }
          if (read.success.length >= SNAPSHOT_ROWS) chunk.truncated = true
          for (const row of read.success) {
            const p = projectFor(moduleId, collection, row, device)
            if (!p.visible) continue
            const out: HouseholdRow = { id: row.id, rev: row.rev, scope: row.scope, value: p.value, updatedAt: row.updatedAt }
            const chars = p.chars + 300
            if (total + chars > SNAPSHOT_MAX_CHARS) {
              chunk.truncated = true
              break
            }
            if (partChars + chars > SNAPSHOT_PART_CHARS && partChars > 0) {
              chunk = { module: moduleId, collection: collection.name, rows: [], truncated: chunk.truncated }
              parts.push([chunk])
              partChars = 0
              yield* Effect.yieldNow
            }
            chunk.rows.push(out)
            cursor.visible.add(rowKey(moduleId, collection.name, row.id))
            partChars += chars
            total += chars
          }
        }
        yield* Effect.yieldNow
      }
      return { seq, parts, cursor } satisfies Snapshot
    })

  const catchUp = (device: TargetDevice, cursor: FeedCursor) =>
    Effect.gen(function*() {
      const page = yield* store.changesSince(cursor.seq, CATCH_UP_CHANGES)
      if (page.changes.length === 0) return { kind: "changes", events: [], more: false } satisfies CatchUp
      // The page missed changes the log no longer has (pruned), or numbers it never saw (another database): resync.
      if (page.oldest > cursor.seq + 1 || page.changes[0]!.seq !== cursor.seq + 1) return { kind: "resync" } satisfies CatchUp
      // One entry per row, in the order of its last change.
      const rows = new Map<string, ChangeRecord>()
      for (const change of page.changes) {
        const key = rowKey(change.module, change.collection, change.id)
        rows.delete(key)
        rows.set(key, change)
      }
      const events: Array<HouseholdEventInfo> = []
      for (const [key, change] of rows) {
        const collection = collections.get(`${change.module}/${change.collection}`)
        if (collection === undefined || !usable(change.module)) continue
        const now = yield* Effect.result(store.forModule(change.module).collection(collection).get(change.id, { scope: change.scope }))
        if (now._tag === "Failure" && now.failure._tag !== "ScopeUnknown") report(change.module, collection.name, `row ${change.id} could not be read for a page: ${now.failure.message}`)
        const row = now._tag === "Success" ? now.success : undefined
        const p = projectFor(change.module, collection, row, device)
        const base = { seq: change.seq, at: change.at, module: change.module, type: `${change.module}.${change.collection}.changed` }
        if (p.visible) {
          cursor.visible.add(key)
          const data: HouseholdChange = { collection: collection.name, id: change.id, op: "put", rev: row!.rev, value: p.value }
          events.push({ ...base, scope: row!.scope, data })
        } else if (cursor.visible.delete(key)) {
          const data: HouseholdChange = { collection: collection.name, id: change.id, op: "remove", rev: change.rev }
          events.push({ ...base, scope: change.scope, data })
        }
      }
      cursor.seq = page.changes[page.changes.length - 1]!.seq
      return { kind: "changes", events, more: !page.complete } satisfies CatchUp
    })

  return { active: collections.size > 0 || eventTypes.size > 0, snapshot, catchUp, live }
}
