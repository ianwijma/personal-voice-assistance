import type { HouseholdChange, HouseholdCollectionRef, HouseholdCollectionRows, HouseholdEventInfo, HouseholdRow, HouseholdSnapshotMessage } from "@pva/protocol"
import { Effect } from "effect"
import type { EventType, HouseholdEvent } from "./EventBus.ts"
import { type Collection, type HouseholdStore, isStoreFailure, MAX_VALUE_CHARS, maxListRows, type PageCursor, type Row, type ScopeKind, type ScopeRef, scopeKey, type TargetDevice } from "./HouseholdStore.ts"

/**
 * What voice pages receive of the household data (docs/STORING-DATA.md "Pages"; docs/MODULES-PLAN.md §4 P4).
 *
 * Nothing is sent by default. A collection opts in with `project(row, device)` and an event type with
 * `project(event, device)`: what a page on that device may see, or `undefined` for nothing. **What reaches a page is
 * decided when its frame is built, and a frame is built in the same synchronous step that hands it to the socket**:
 * the row is read as it is committed at that moment and projected with the server's record of the device then. So a
 * row that was removed or moved away before its frame was built never travels, whatever happened earlier.
 *
 * - **Snapshot** (`snapshot`): a run of bounded steps (`SnapshotRun.step`), each reading at most `SNAPSHOT_PAGE_ROWS`
 *   rows of one collection and scope through an index and returning the frames to send at once. Every frame has at
 *   most `SNAPSHOT_PART_CHARS` characters and the whole snapshot at most `SNAPSHOT_MAX_CHARS`, every frame counted
 *   whole as it is encoded (both under the protocol's frame limit of 1,048,576); at most `SNAPSHOT_ROWS` rows per
 *   collection and scope and `SNAPSHOT_READ_ROWS` rows read in all. The final frame names every collection whose
 *   visible rows were not all sent (`truncated`); room for naming all of them is kept from the start, so that list
 *   always fits.
 * - **Changes** (`change`): a row a committed change touched, read now: `put` when the page may see it; otherwise
 *   `remove` (the collection and the id, nothing else) when the page's device could have been shown one of the scopes
 *   the row was in, nothing otherwise. Nothing is remembered per page about the rows it holds: a page ignores the
 *   removal of an id it does not have.
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
/** The most characters of one `household.snapshot` message, everything in it included. */
export const SNAPSHOT_PART_CHARS = 256_000
/** The most characters of one whole snapshot, all its messages together, each counted whole. */
export const SNAPSHOT_MAX_CHARS = 900_000
/**
 * The most collections pages are sent (all modules together): the final frame must be able to name every one of them
 * as `truncated`. A declaration beyond it is not sent, and reported.
 */
export const MAX_FEED_COLLECTIONS = 1500
/** The most scopes a queued change remembers for its row; beyond, a removal goes to every page that sees the kind. */
export const MAX_CHANGE_SCOPES = 16

/** A projection that failed, or a declaration the feed cannot carry (`report`). */
export interface FeedProblem {
  readonly module: string
  /** The collection or the event type. */
  readonly what: string
  readonly message: string
}

/**
 * A row committed changes touched: which one, and the scopes it was in (those changes' scopes, so a page that could
 * see the row where it was is told it is gone); `"any"` when there were more than `MAX_CHANGE_SCOPES`.
 */
export interface FeedChange {
  readonly module: string
  readonly collection: string
  readonly id: string
  readonly scopes: ReadonlyArray<ScopeRef> | "any"
}

/** The key of a row in a page's queue. */
export const feedRowKey = (module: string, collection: string, id: string) => `${module}/${collection}/${id}`

/** Another change of the same row: its scopes added to those already queued. */
export const mergeScopes = (queued: FeedChange["scopes"], scope: ScopeRef): FeedChange["scopes"] => {
  if (queued === "any") return "any"
  if (queued.some((s) => scopeKey(s) === scopeKey(scope))) return queued
  return queued.length >= MAX_CHANGE_SCOPES ? "any" : [...queued, { ...scope }]
}

type SnapshotFrame = typeof HouseholdSnapshotMessage.Type

/** A snapshot being sent: `step()` until `done`, sending each step's frames at once. */
export interface SnapshotRun {
  readonly seq: number
  readonly step: () => { readonly frames: ReadonlyArray<SnapshotFrame>; readonly done: boolean }
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
  /** What `device` gets now of a row changes touched, or `undefined`. */
  readonly change: (change: FeedChange, device: TargetDevice) => HouseholdEventInfo | undefined
  /** What `device` gets of a module event now, or `undefined`. */
  readonly live: (event: HouseholdEvent, device: TargetDevice) => HouseholdEventInfo | undefined
}

type Projected = { readonly visible: true; readonly value: unknown } | { readonly visible: false; readonly problem?: string }

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
  return { visible: true, value: JSON.parse(text) as unknown }
}

/** What `device` may see of `row` (`undefined`: nothing, also when the projection fails). Plain JSON. */
export const projectRow = (collection: Collection<any>, row: Row<unknown> | undefined, device: TargetDevice): unknown => {
  if (row === undefined || !mayRevealScopeTo(row.scope, device)) return undefined
  const p = runProjection(collection.project, row, device)
  return p.visible ? p.value : undefined
}

const chars = (x: unknown) => JSON.stringify(x).length

/** Whether a page on `device` could ever be shown a row of this scope kind (for a removal whose scopes are unknown). */
const kindVisibleTo = (kind: ScopeKind, device: TargetDevice) =>
  kind === "household" ? true : kind === "device" ? device.id !== undefined : false

export const makeHouseholdFeed = (options: {
  readonly store: HouseholdStore
  readonly modules: ReadonlyArray<FeedModule>
  /** A failing projection (serve mode: a Health issue). */
  readonly report?: (problem: FeedProblem) => void
}): HouseholdFeed => {
  const { store } = options
  const report = (module: string, what: string, message: string) => {
    try {
      options.report?.({ module, what, message })
    } catch {
      // Reporting must not break delivery.
    }
  }
  const collections = new Map<string, Collection<any>>()
  const eventTypes = new Map<string, EventType>()
  for (const m of options.modules) {
    for (const c of m.collections) {
      if (c.project === undefined) continue
      if (collections.size >= MAX_FEED_COLLECTIONS) {
        report(m.moduleId, c.name, `not sent to pages: pages are sent at most ${MAX_FEED_COLLECTIONS} collections`)
        continue
      }
      collections.set(`${m.moduleId}/${c.name}`, c)
    }
    for (const e of m.events) if (e.project !== undefined) eventTypes.set(`${m.moduleId}.${e.type}`, e)
  }
  const sent = [...collections.entries()].map(([key, c]) => ({ moduleId: key.slice(0, key.indexOf("/")), collection: c }))
  /** A module whose data cannot be used here (newer, failed upgrade) is never read for pages. */
  const usable = (moduleId: string) => store.availability(moduleId) === undefined

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
    // The work: one entry per collection and visible scope.
    const todo = sent.flatMap(({ moduleId, collection }) => scopesOf(collection, device).map((scope) => ({ moduleId, collection, scope })))
    /** The collections cut short so far (by `module/collection`), in the order found. */
    const truncated = new Map<string, HouseholdCollectionRef>()
    const refOf = (module: string, collection: string): HouseholdCollectionRef => ({ module, collection })
    const frameOf = (part: number, final: boolean, collections: ReadonlyArray<HouseholdCollectionRows>, cut: ReadonlyArray<HouseholdCollectionRef>): SnapshotFrame =>
      ({ type: "household.snapshot", seq, part, final, collections, truncated: cut })
    let part = 0
    // The final frame's cost when it names every collection this snapshot could cut short: kept free from the start.
    const allRefs = [...new Map(todo.map((t) => [`${t.moduleId}/${t.collection.name}`, refOf(t.moduleId, t.collection.name)])).values()]
    const finalReserve = chars(frameOf(999_999, true, [], allRefs))
    /** Characters of the frames already sent, each counted whole (as `encodeServerMessage` writes it). */
    let sentChars = 0
    let at = 0
    let after: PageCursor | undefined
    let rowsHere = 0
    let read = 0
    let finished = false
    const cut = (module: string, collection: string) => void truncated.set(`${module}/${collection}`, refOf(module, collection))

    const step = () => {
      if (finished) return { frames: [], done: true }
      const frames: Array<SnapshotFrame> = []
      let chunks: Array<{ module: string; collection: string; rows: Array<HouseholdRow> }> = []
      // Lengths are exact and kept as rows are added (JSON: "[" + items joined by "," + "]"), never estimated.
      const emptyLen = (n: number) => chars(frameOf(n, false, [], []))
      let frameLen = emptyLen(part)
      const flush = () => {
        if (chunks.length === 0) return
        const frame = frameOf(part++, false, chunks, [])
        sentChars += frameLen
        frames.push(frame)
        chunks = []
        frameLen = emptyLen(part)
      }
      /** Add one row: `false` when it does not fit the whole snapshot's bound (nothing is changed then). */
      const add = (module: string, collection: string, row: HouseholdRow): boolean => {
        const rowChars = chars(row)
        const last = chunks.at(-1)
        const same = last !== undefined && last.module === module && last.collection === collection
        const envelope = chars({ module, collection, rows: [] })
        const grow = same ? rowChars + (last.rows.length > 0 ? 1 : 0) : (chunks.length > 0 ? 1 : 0) + envelope + rowChars
        if (frameLen + grow <= SNAPSHOT_PART_CHARS) {
          if (sentChars + frameLen + grow + finalReserve > SNAPSHOT_MAX_CHARS) return false
          if (same) last.rows.push(row)
          else chunks.push({ module, collection, rows: [row] })
          frameLen += grow
          return true
        }
        // A new frame: this one is sent as it is (if it holds anything), the row starts the next with its envelope.
        const freshLen = emptyLen(chunks.length > 0 ? part + 1 : part) + envelope + rowChars
        const flushed = chunks.length > 0 ? frameLen : 0
        if (freshLen > SNAPSHOT_PART_CHARS || sentChars + flushed + freshLen + finalReserve > SNAPSHOT_MAX_CHARS) return false
        flush()
        chunks.push({ module, collection, rows: [row] })
        frameLen = freshLen
        return true
      }
      const finish = () => {
        flush()
        finished = true
        frames.push(frameOf(part++, true, [], [...truncated.values()]))
        return { frames, done: true }
      }
      const work = todo[at]
      if (work === undefined) return finish()
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
        // The reading budget is spent: every collection still to do may have rows; say so.
        for (let i = at; i < todo.length; i++) cut(todo[i]!.moduleId, todo[i]!.collection.name)
        at = todo.length
        return finish()
      }
      const reader = store.reader(moduleId, collection)
      // A page of at most what one list of the collection may read (`maxListRows`: rows of a large maxChars are fewer)
      // and what is left of the snapshot's reading budget; a page that budget cut short leaves the collection unfinished,
      // so the next step names it as cut.
      const want = Math.min(SNAPSHOT_PAGE_ROWS, SNAPSHOT_ROWS - rowsHere, SNAPSHOT_READ_ROWS - read, maxListRows(collection))
      let rows: ReadonlyArray<Row<unknown>> = []
      try {
        rows = reader === undefined ? [] : reader.page(scope, after, want)
      } catch (e) {
        report(moduleId, collection.name, `could not be read for a page: ${isStoreFailure(e) ? e.message : String(e)}`)
        cut(moduleId, collection.name)
        next()
        flush()
        return { frames, done: false }
      }
      read += Math.max(1, rows.length)
      for (const row of rows) {
        const p = projectFor(moduleId, collection, row, device)
        if (!p.visible) continue
        const out: HouseholdRow = { id: row.id, rev: row.rev, scope: row.scope, value: p.value, updatedAt: row.updatedAt }
        if (!add(moduleId, collection.name, out)) {
          // Full: this collection and every one after it may have rows left out.
          for (let i = at; i < todo.length; i++) cut(todo[i]!.moduleId, todo[i]!.collection.name)
          at = todo.length
          return finish()
        }
      }
      rowsHere += rows.length
      const last = rows.at(-1)
      if (rows.length < want || last === undefined) next()
      else if (rowsHere >= SNAPSHOT_ROWS) {
        cut(moduleId, collection.name)
        next()
      } else after = { updatedAt: last.updatedAt, createdAt: last.createdAt, id: last.id }
      flush()
      return { frames, done: false }
    }
    return { seq, step }
  }

  const change = (c: FeedChange, device: TargetDevice): HouseholdEventInfo | undefined => {
    const collection = collections.get(`${c.module}/${c.collection}`)
    if (collection === undefined || !usable(c.module)) return undefined
    const type = `${c.module}.${c.collection}.changed`
    const could = c.scopes === "any" ? kindVisibleTo(collection.scope, device) : c.scopes.some((s) => mayRevealScopeTo(s, device))
    if (!could) return undefined
    // The row now, in whichever of its scopes this page may see.
    let row: Row<unknown> | undefined
    const reader = store.reader(c.module, collection)
    const candidates = c.scopes === "any" ? scopesOf(collection, device) : c.scopes.filter((s) => mayRevealScopeTo(s, device))
    try {
      for (const scope of candidates) {
        row = reader?.get(c.id, scope)
        if (row !== undefined) break
      }
    } catch (e) {
      report(c.module, collection.name, `row ${c.id} could not be read for a page: ${isStoreFailure(e) ? e.message : String(e)}`)
      row = undefined
    }
    const p = projectFor(c.module, collection, row, device)
    if (p.visible && row !== undefined) {
      const data: HouseholdChange = { collection: collection.name, id: c.id, op: "put", rev: row.rev, value: p.value }
      return { seq: row.rev, at: row.updatedAt, module: c.module, type, scope: row.scope, data }
    }
    // Gone, or no longer for this page: the collection and the id only, in a scope this page may see anyway.
    const data: HouseholdChange = { collection: collection.name, id: c.id, op: "remove" }
    const scope: ScopeRef = candidates[0] ?? { kind: "household" }
    return { at: Date.now(), module: c.module, type, scope, data }
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
