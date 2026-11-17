import { Schema } from "effect"
import { ModuleId, NonNegativeFinite, NonNegativeInt } from "./common.ts"

/**
 * Household data on the wire (docs/MODULES-PLAN.md §4 P4; docs/STORING-DATA.md). Additive within protocol 9: a page
 * that does not know these messages is never sent anything it needs; no web UI reads them yet (P10 is the first).
 *
 * The server sends a voice connection only what its audience may see (`SessionHub`, `householdAudience`): household
 * scope to every voice connection, device scope to that device's connections, nothing of assistant or conversation
 * scope, and person scope not at all until `Privacy.mayReveal` exists (P5). Only collections a module opted in
 * (`defineCollection({ frontEnds: true })`) and events a module published with `frontEnds: true` are sent.
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

/** One stored row, as a page sees it. `value` is the collection's JSON form. */
export const HouseholdRow = Schema.Struct({
  id: Schema.String,
  rev: NonNegativeInt,
  scope: HouseholdScope,
  value: Schema.Unknown,
  updatedAt: NonNegativeFinite
})
export type HouseholdRow = typeof HouseholdRow.Type

/** The rows of one collection a page may see (at most 500 per collection; `truncated` when there were more). */
export const HouseholdCollectionRows = Schema.Struct({
  module: ModuleId,
  collection: Schema.String,
  rows: Schema.Array(HouseholdRow),
  truncated: Schema.Boolean
})
export type HouseholdCollectionRows = typeof HouseholdCollectionRows.Type

/**
 * A change to a row (`data` of a `<module>.<collection>.changed` event): what happened and, for an insert or an
 * update, the new value. `remove` and `erase` carry no value.
 */
export const HouseholdChange = Schema.Struct({
  collection: Schema.String,
  id: Schema.String,
  op: Schema.Literals(["insert", "update", "remove", "erase"]),
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
 * Sent to a voice connection right after `welcome` (and instead of a replay that cannot be given): the rows it may
 * see of every collection sent to pages, and the change log's last number (`seq`), which the page sends back in
 * `hello.household.seq` when it reconnects.
 */
export const HouseholdSnapshotMessage = Schema.Struct({
  type: Schema.Literal("household.snapshot"),
  seq: NonNegativeInt,
  collections: Schema.Array(HouseholdCollectionRows)
})

/**
 * A data change of a collection sent to pages, or an event a module published for pages, after its commit; also
 * the replay after a reconnect (each change after `hello.household.seq`, in order). Values are the current ones.
 */
export const HouseholdEventMessage = Schema.Struct({
  type: Schema.Literal("household.event"),
  event: HouseholdEventInfo
})

/** What a reconnecting page says it has seen (`hello.household`). */
export const HouseholdHello = Schema.Struct({
  /** The last `seq` it applied (from `household.snapshot` or a `household.event`). */
  seq: NonNegativeInt
})
export type HouseholdHello = typeof HouseholdHello.Type
