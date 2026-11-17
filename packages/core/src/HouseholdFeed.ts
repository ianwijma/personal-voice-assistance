import type { HouseholdChange, HouseholdCollectionRows, HouseholdEventInfo, HouseholdRow, HouseholdSnapshotMessage } from "@pva/protocol"
import { Effect } from "effect"
import type { EventType, HouseholdEvent } from "./EventBus.ts"
import { type Collection, type HouseholdStore, isStoreFailure, MAX_VALUE_CHARS, type Row, type ScopeRef, type TargetDevice } from "./HouseholdStore.ts"

/**
 * What voice pages receive of the household data (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4).
 *
 * Nothing is sent by default. A collection opts in with `project(row, device)` and an event type with
 * `project(event, device)`: what a page on that device may see, or `undefined` for nothing. **What reaches a page is
 * decided when its frame is built, and a frame is built in the same synchronous step that hands it to the socket**:
 * the row is read as it is committed at that moment and projected with the server's record of the device then. So a
 * row that was removed or moved away before its frame was built never travels, whatever happened earlier.
 *
 * - **Snapshot** (`snapshot`): after every `welcome` (a reconnect too), after a change to the page's device record,
 *   and when a page fell too far behind. A run of bounded steps (`SnapshotRun.step`), each reading at most
 *   `SNAPSHOT_PAGE_ROWS` rows of one collection and scope through an index and returning the frames to send at once.
 *   Every frame, envelopes included, has at most `SNAPSHOT_PART_CHARS` characters, and the whole snapshot at most
 *   `SNAPSHOT_MAX_CHARS` (both well under the protocol's frame limit of 1,048,576); at most `SNAPSHOT_ROWS` rows per
 *   collection and scope and `SNAPSHOT_READ_ROWS` rows read in all. A collection with nothing visible sends nothing;
 *   one left out or cut short is `truncated`. The last frame is `final`.
 * - **Changes** (`change`): a row a committed change touched, read now: `put` when the page may see it, `remove` when
 *   it may not but the page holds it (in the scope and at the rev the page was given, nothing of what replaced it),
 *   nothing otherwise.
 * - **Module events** (`live`): an event type's projection, now.
 *
 * A projection that throws, returns something that is not plain JSON or more than `MAX_VALUE_CHARS` of it, is treated
 * as "not visible" for that row or event (so a page loses the row rather than keeping a stale one) and reported
 * (`report`, a Health issue in serve mode). It affects only its own collection or event type.
 *
 * Before any projection, `mayRevealScopeTo` decides by scope (below).
 */

/**
 * THE one place where the scope of a row or event decides whether a voice page may see it at all. P5 replaces the
 * `person` branch with `Privacy.mayReveal` (docs/MODULES-PLAN.md §2 row 8); until then person-scoped data is never sent
 * to a page. Household data goes to every voice page, device data to that device's pages only, assistant and
 * conversation data to none (they belong to turns, not to screens). The device is the id the page claimed in `hello`:
 * device ids are not authenticated (docs/MODULES-PLAN.md §2 rows 5 and 7).
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

/** The most rows of one collection and scope in a snapshot. */
export const SNAPSHOT_ROWS = 500
/** The rows one snapshot step reads (one index read). */
export const SNAPSHOT_PAGE_ROWS = 20
/** The most rows a snapshot reads in all (visible or not). */
export const SNAPSHOT_READ_ROWS = 5000
/** The most characters of one `household.snapshot` message, envelopes included. */
export const SNAPSHOT_PART_CHARS = 256_000
/** The most characters of one whole snapshot, all its messages together. */
export const SNAPSHOT_MAX_CHARS = 900_000

/** A projection that failed (`report`). */
export interface FeedProblem {
  readonly module: string
  /** The collection or the event type. */
  readonly what: string
  readonly message: string
}

/** What a page holds: per row (`module/collection/id`), the scope and rev it was given. */
export interface FeedCursor {
  readonly visible: Map<string, { readonly scope: ScopeRef; readonly rev: number }>
}

/** A row a committed change touched: which one, and in which scope. */
export interface FeedChange {
  readonly module: string
  readonly collection: string
  readonly id: string
  readonly scope: ScopeRef
}

/** The key of a row in `FeedCursor.visible` and in a page's queue. */
export const feedRowKey = (module: string, collection: string, id: string) => `${module}/${collection}/${id}`

/** A snapshot being sent: `step()` until `done`, sending each step's frames at once. */
export interface SnapshotRun {
  readonly seq: number
  /** What the page holds once the snapshot is complete (filled as steps run). */
  readonly cursor: FeedCursor
  readonly step: () => { readonly frames: ReadonlyArray<typeof HouseholdSnapshotMessage.Type>; readonly done: boolean }
}

export interface HouseholdFeed {
  /** Whether any collection or event type is sent to pages (nothing to do otherwise). */
  readonly active: boolean
  /** Whether `moduleType` (`<module>.<type>`) is a declared event type with a projection. */
  readonly sendsEvent: (moduleType: string) => boolean
  /** Whether a change to this collection can concern pages. */
  readonly sendsCollection: (module: string, collection: string) => boolean
  /** Start a snapshot for `device` (read when each step runs). */
  readonly snapshot: (device: TargetDevice) => SnapshotRun
  /** What `device` gets now of a row a change touched, or `undefined`; updates `cursor`. */
  readonly change: (change: FeedChange, device: TargetDevice, cursor: FeedCursor) => HouseholdEventInfo | undefined
  /** What `device` gets of a module event now, or `undefined`. */
  readonly live: (event: HouseholdEvent, device: TargetDevice) => HouseholdEventInfo | undefined
}

type Projected = { readonly visible: true; readonly value: unknown; readonly chars: number } | { readonly visible: false; readonly problem?: string }

const HIDDEN: Projected = { visible: false }

/** Run a projection and make its result plain JSON of a bounded size, or say why it cannot be sent. */
const runProjection = <T>(project: ((x: T, device: TargetDevice) => unknown) | undefined, x: T, device: TargetDevice): Projected => {
  if (project === undefined) return HIDDEN
  let out: unknown
  try {
    out = project(x, { ...device })
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

const chars = (x: unknown) => JSON.stringify(x).length

export const makeHouseholdFeed = (options: {
  readonly store: HouseholdStore
  readonly modules: ReadonlyArray<FeedModule>
  /** A failing projection (serve mode: a Health issue). */
  readonly report?: (problem: FeedProblem) => void
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
    if (event.change !== undefined || event.module === "host") return undefined
    const type = eventTypes.get(event.type)
    if (type === undefined || !usable(event.module) || !mayRevealScopeTo(event.scope, device)) return undefined
    const p = runProjection(type.project, event, device)
    if (!p.visible) {
      if (p.problem !== undefined) report(event.module, event.type, p.problem)
      return undefined
    }
    return { at: event.at, module: event.module, type: event.type, scope: event.scope, data: p.value }
  }

  /** The scopes of a collection a page on `device` may see. */
  const scopesOf = (collection: Collection<any>, device: TargetDevice): ReadonlyArray<ScopeRef> => {
    const scopes: ReadonlyArray<ScopeRef> = collection.scope === "household"
      ? [{ kind: "household" }]
      : collection.scope === "device" && device.id !== undefined
      ? [{ kind: "device", id: device.id }]
      : []
    return scopes.filter((scope) => mayRevealScopeTo(scope, device))
  }

  const snapshot = (device: TargetDevice): SnapshotRun => {
    const seq = lastSeqNow(store)
    const cursor: FeedCursor = { visible: new Map() }
    // The work: one entry per collection and visible scope.
    const todo = sent.flatMap(({ moduleId, collection }) => scopesOf(collection, device).map((scope) => ({ moduleId, collection, scope })))
    let at = 0
    let after: { updatedAt: number; id: string } | undefined
    let rowsHere = 0
    let read = 0
    /** Characters of the frames already sent (each counted whole, its envelope included). */
    let sentChars = 0
    let part = 0
    let finished = false
    const frameOverhead = chars({ type: "household.snapshot", seq, part: 999_999, final: false, collections: [] })

    const step = () => {
      if (finished) return { frames: [], done: true }
      const frames: Array<typeof HouseholdSnapshotMessage.Type> = []
      let chunks: Array<HouseholdCollectionRows> = []
      let frameChars = frameOverhead
      const flush = () => {
        if (chunks.length === 0) return
        frames.push({ type: "household.snapshot", seq, part: part++, final: false, collections: chunks })
        sentChars += frameChars
        chunks = []
        frameChars = frameOverhead
      }
      /** Add one chunk (or rows to the last chunk of the same collection); `false` when the snapshot is full. */
      const add = (module: string, collection: string, row: HouseholdRow | undefined, truncated: boolean): boolean => {
        const envelope = chars({ module, collection, rows: [], truncated: true }) + 1
        const rowChars = row === undefined ? 0 : chars(row) + 1
        let last = chunks.at(-1)
        const fresh = last === undefined || last.module !== module || last.collection !== collection
        const cost = rowChars + (fresh ? envelope : 0)
        // What is sent so far, this frame, this addition, and the final frame still to come stay within the bound.
        if (sentChars + frameChars + cost + frameOverhead > SNAPSHOT_MAX_CHARS) return false
        if (frameChars + cost > SNAPSHOT_PART_CHARS) {
          flush()
          last = undefined
        }
        if (last === undefined || last.module !== module || last.collection !== collection) {
          last = { module, collection, rows: [], truncated: false }
          chunks.push(last)
          frameChars += envelope
        }
        if (row !== undefined) (last.rows as Array<HouseholdRow>).push(row)
        if (truncated) chunks[chunks.length - 1] = { ...last, truncated: true }
        frameChars += rowChars
        return true
      }
      const markRestTruncated = () => {
        for (let i = at; i < todo.length; i++) if (!add(todo[i]!.moduleId, todo[i]!.collection.name, undefined, true)) break
        at = todo.length
      }
      const work = todo[at]
      if (work === undefined) {
        finished = true
        flush()
        frames.push({ type: "household.snapshot", seq, part: part++, final: true, collections: [] })
        return { frames, done: true }
      }
      const { moduleId, collection, scope } = work
      const next = () => {
        at++
        after = undefined
        rowsHere = 0
      }
      if (!usable(moduleId)) {
        next()
        return { frames, done: false }
      }
      if (read >= SNAPSHOT_READ_ROWS) {
        markRestTruncated()
        flush()
        return { frames, done: false }
      }
      const reader = store.reader(moduleId, collection)
      let rows: ReadonlyArray<Row<unknown>> = []
      try {
        rows = reader === undefined ? [] : reader.page(scope, after, Math.min(SNAPSHOT_PAGE_ROWS, SNAPSHOT_ROWS - rowsHere))
      } catch (e) {
        report(moduleId, collection.name, `could not be read for a page: ${isStoreFailure(e) ? e.message : String(e)}`)
        add(moduleId, collection.name, undefined, true)
        next()
        flush()
        return { frames, done: false }
      }
      read += Math.max(1, rows.length)
      for (const row of rows) {
        const p = projectFor(moduleId, collection, row, device)
        if (!p.visible) continue
        const out: HouseholdRow = { id: row.id, rev: row.rev, scope: row.scope, value: p.value, updatedAt: row.updatedAt }
        if (!add(moduleId, collection.name, out, false)) {
          // Full: this collection is cut short here, the rest is left out.
          add(moduleId, collection.name, undefined, true)
          markRestTruncated()
          flush()
          return { frames, done: false }
        }
        cursor.visible.set(feedRowKey(moduleId, collection.name, row.id), { scope: row.scope, rev: row.rev })
      }
      rowsHere += rows.length
      const last = rows.at(-1)
      if (rows.length < SNAPSHOT_PAGE_ROWS || last === undefined) next()
      else if (rowsHere >= SNAPSHOT_ROWS) {
        add(moduleId, collection.name, undefined, true)
        next()
      } else after = { updatedAt: last.updatedAt, id: last.id }
      flush()
      return { frames, done: false }
    }
    return { seq, cursor, step }
  }

  const change = (c: FeedChange, device: TargetDevice, cursor: FeedCursor): HouseholdEventInfo | undefined => {
    const key = feedRowKey(c.module, c.collection, c.id)
    const collection = collections.get(`${c.module}/${c.collection}`)
    if (collection === undefined) return undefined
    let row: Row<unknown> | undefined
    if (usable(c.module) && mayRevealScopeTo(c.scope, device)) {
      try {
        row = store.reader(c.module, collection)?.get(c.id, c.scope)
      } catch (e) {
        report(c.module, collection.name, `row ${c.id} could not be read for a page: ${isStoreFailure(e) ? e.message : String(e)}`)
      }
    }
    const p = projectFor(c.module, collection, row, device)
    const type = `${c.module}.${c.collection}.changed`
    if (p.visible && row !== undefined) {
      cursor.visible.set(key, { scope: row.scope, rev: row.rev })
      const data: HouseholdChange = { collection: collection.name, id: c.id, op: "put", rev: row.rev, value: p.value }
      return { seq: row.rev, at: row.updatedAt, module: c.module, type, scope: row.scope, data }
    }
    const held = cursor.visible.get(key)
    if (held === undefined) return undefined
    cursor.visible.delete(key)
    // The removal names what the page was given: its scope and rev, nothing of a row that may have replaced it.
    const data: HouseholdChange = { collection: collection.name, id: c.id, op: "remove", rev: held.rev }
    return { seq: held.rev, at: Date.now(), module: c.module, type, scope: held.scope, data }
  }

  return {
    active: collections.size > 0 || eventTypes.size > 0,
    sendsEvent: (moduleType) => eventTypes.has(moduleType),
    sendsCollection: (module, collection) => collections.has(`${module}/${collection}`),
    snapshot,
    change,
    live
  }
}

/** The store's counter now (`lastSeq` is a synchronous effect in both stores). */
const lastSeqNow = (store: HouseholdStore): number => {
  try {
    return Effect.runSync(store.lastSeq.pipe(Effect.orElseSucceed(() => 0)))
  } catch {
    return 0
  }
}
