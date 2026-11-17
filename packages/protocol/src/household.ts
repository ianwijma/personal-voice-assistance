import { Schema } from "effect"
import { ModuleId, NonNegativeFinite, NonNegativeInt } from "./common.ts"

/**
 * Household data on the wire (docs/MODULES-PLAN.md §4 P4; docs/STORING-DATA.md). Additive within protocol 9: a page
 * that does not know these messages is never sent anything it needs; no web UI reads them yet (P10 is the first).
 *
 * The server sends a voice connection only what its audience may see (`mayRevealScopeTo` in core): household
 * scope to every voice connection, device scope to that device's connections, nothing of assistant or conversation
 * scope, and person scope not at all until `Privacy.mayReveal` exists (P5). Nothing is sent by default: a collection
 * or an event type opts in with a **projection** (row or event, target device) → what that device may see, or
 * nothing, applied the same way to the snapshot (after every hello) and to each change after its commit, always to
 * the row as it is committed when the frame is built, with the server's record of the device. Device ids are claimed by
 * the page, not authenticated: a page that names a device's id gets that device's rows (docs/MODULES-PLAN.md §2 rows 5
 * and 7).
 */

/** Where a row or an event belongs (`household` has no id). */
export const HouseholdScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("household") }),
  Schema.Struct({
    kind: Schema.Literals(["person", "assistant", "device", "conversation"]),
    id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,200}$/))
  })
])
export type HouseholdScope = typeof HouseholdScope.Type

/** One stored row, as a page sees it. `value` is what the collection's projection gave for that page's device. */
export const HouseholdRow = Schema.Struct({
  id: Schema.String,
  rev: NonNegativeInt,
  scope: HouseholdScope,
  value: Schema.Unknown,
  updatedAt: NonNegativeFinite
})
export type HouseholdRow = typeof HouseholdRow.Type

/**
 * Rows of one collection a page may see. A snapshot holds at most 500 rows per collection and scope and at most
 * 900,000 characters in all (every message at most 256,000); `truncated` when rows were left out. One collection's rows
 * may continue in the next part. A collection with no row the page may see is not in the snapshot.
 */
export const HouseholdCollectionRows = Schema.Struct({
  module: ModuleId,
  collection: Schema.String,
  rows: Schema.Array(HouseholdRow),
  truncated: Schema.Boolean
})
export type HouseholdCollectionRows = typeof HouseholdCollectionRows.Type

/**
 * A change to a row as one device sees it (`data` of a `<module>.<collection>.changed` event), after the collection's
 * projection for that device of the row **as it is committed when the message is built**: `put` with what the device
 * may see of it, or `remove` when the page holds the row and may no longer see it (or it is gone), with the scope and
 * `rev` the page was given. Nothing is sent for a row the page does not hold and may not see.
 */
export const HouseholdChange = Schema.Struct({
  collection: Schema.String,
  id: Schema.String,
  op: Schema.Literals(["put", "remove"]),
  rev: NonNegativeInt,
  value: Schema.optionalKey(Schema.Unknown)
})
export type HouseholdChange = typeof HouseholdChange.Type

/** One event of the household bus as a page sees it. `seq`: the row's `rev` (the store's counter), for data changes only. */
export const HouseholdEventInfo = Schema.Struct({
  seq: Schema.optionalKey(NonNegativeInt),
  at: NonNegativeFinite,
  module: Schema.String,
  /** The full name, namespaced by its module: `timers.timers.changed`, `kitchen.stock.low`. */
  type: Schema.String,
  scope: HouseholdScope,
  data: Schema.Unknown
})
export type HouseholdEventInfo = typeof HouseholdEventInfo.Type

/**
 * Sent to a voice connection after every `welcome` (a reconnect too: a page never keeps household rows across
 * connections), and again whenever the server cannot say what changed for it (it fell too far behind; its device's
 * record changed): every row it may see, read part by part. In parts that each fit one text frame: `part` 0, 1, …
 * with the same `seq` (the store's counter when it began), `final` on the last (which may hold no rows). On part 0 the
 * page drops what it held; it applies the rows when `final` arrives, then the `household.event`s that follow. Nothing
 * else of the household is sent to the page between part 0 and the final part.
 */
export const HouseholdSnapshotMessage = Schema.Struct({
  type: Schema.Literal("household.snapshot"),
  seq: NonNegativeInt,
  part: NonNegativeInt,
  final: Schema.Boolean,
  collections: Schema.Array(HouseholdCollectionRows)
})

/**
 * A data change of a collection sent to pages (after its commit, coalesced per row: a row is sent at the place of its
 * last change), or an event a module published for pages, in the order they were committed. Values are always the row
 * as committed when the message is built, through the projection.
 */
export const HouseholdEventMessage = Schema.Struct({
  type: Schema.Literal("household.event"),
  event: HouseholdEventInfo
})
