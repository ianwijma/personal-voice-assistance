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
 * the row as it is now.
 */

/** Where a row or an event belongs (`household` has no id). */
export const HouseholdScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("household") }),
  Schema.Struct({
    kind: Schema.Literals(["person", "assistant", "device", "conversation"]),
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
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
 * Rows of one collection a page may see. A snapshot holds at most 500 rows per collection and about 4 million
 * characters in all; `truncated` when rows were left out. One collection's rows may continue in the next part.
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
 * projection for that device of the row **as it is now** (committed): `put` with what the device may see of it, or
 * `remove` when the page holds the row and may no longer see it (or it is gone). Nothing is sent for a row the page
 * does not hold and may not see.
 */
export const HouseholdChange = Schema.Struct({
  collection: Schema.String,
  id: Schema.String,
  op: Schema.Literals(["put", "remove"]),
  rev: NonNegativeInt,
  value: Schema.optionalKey(Schema.Unknown)
})
export type HouseholdChange = typeof HouseholdChange.Type

/** One event of the household bus as a page sees it. `seq`: the change log's number, for data changes only. */
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
 * connections), and again whenever the server cannot say what changed for it (it fell behind a pruned change log;
 * its device's place changed): every row it may see now, current to change number `seq`. In parts that each fit one
 * text frame: `part` 0, 1, … with the same `seq`, `final` on the last. On part 0 the page drops what it held; it
 * applies the rows when `final` arrives, then the `household.event`s that follow (each with a higher `seq`).
 */
export const HouseholdSnapshotMessage = Schema.Struct({
  type: Schema.Literal("household.snapshot"),
  seq: NonNegativeInt,
  part: NonNegativeInt,
  final: Schema.Boolean,
  collections: Schema.Array(HouseholdCollectionRows)
})

/**
 * A data change of a collection sent to pages (after its commit, in change-log order, coalesced per row), or an
 * event a module published for pages. Values are always the current row through the projection, never an older
 * payload from the change log.
 */
export const HouseholdEventMessage = Schema.Struct({
  type: Schema.Literal("household.event"),
  event: HouseholdEventInfo
})
