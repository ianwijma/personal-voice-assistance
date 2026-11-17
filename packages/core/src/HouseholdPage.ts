import type { HouseholdEventMessage, HouseholdGapMessage, HouseholdSnapshotMessage } from "@pva/protocol"
import { moduleEvent, type HouseholdEvent } from "./EventBus.ts"
import { type FeedChange, feedRowKey, type HouseholdFeed, mergeScopes, type SnapshotRun } from "./HouseholdFeed.ts"
import type { Released, TargetDevice } from "./HouseholdStore.ts"

/**
 * What one voice page is sent of the household, as a small synchronous state machine (docs/STORING-DATA.md "Pages"):
 * **one ordered queue per page for everything it is sent**, with one bound. Serve mode's push (`HouseholdPush`) feeds
 * it from the store's commit listener (`offer`) and drains it from the page's fiber (`step`), a bounded step at a time;
 * the property test drives it directly.
 *
 * The queue holds, in order: a pending `household.gap`, a snapshot (its parts are built a step at a time when it is at
 * the head), the rows commits touched (coalesced: a row is queued once, at the place of its last change, with every
 * scope it was in), and the module events of a type with a projection. Every frame is built when `step` takes its
 * entry, from the committed state and the server's record of the device at that moment.
 *
 * - Nothing queued after a snapshot is sent before its final part; nothing committed after it began is missed.
 * - A fresh snapshot for a changed device record (`refresh`) replaces what is queued for rows (it shows them as they
 *   are) and keeps every module event that was accepted, sent after it in order.
 * - When more than `maxQueued` entries would wait, counting room for a snapshot when none is queued (so a `refresh`
 *   keeps every accepted event within the bound), the queue overflows as a whole: everything is dropped, and the page
 *   gets `household.gap` (`overflow`) and a fresh snapshot. `restart` (sending failed) does the same with `restart`.
 *   **Nothing is ever dropped without that signal.**
 */

/**
 * The most entries a page may have waiting (a snapshot and a gap count one each; room for a snapshot is kept when none
 * is queued) before its queue overflows (a `household.gap` and a fresh snapshot).
 */
export const MAX_QUEUED = 2000

export type PageMessage = typeof HouseholdSnapshotMessage.Type | typeof HouseholdEventMessage.Type | typeof HouseholdGapMessage.Type

type Entry =
  | { readonly _tag: "gap"; readonly reason: "overflow" | "restart" }
  | { readonly _tag: "snapshot" }
  | { readonly _tag: "row"; readonly change: FeedChange }
  | { readonly _tag: "event"; readonly event: HouseholdEvent }

export interface HouseholdPage {
  /** What a commit released, in order (rows of collections and events of types that are sent to pages). */
  readonly offer: (released: ReadonlyArray<Released>) => void
  /** The device's record changed: a fresh snapshot; module events already queued are kept and sent after it. */
  readonly refresh: () => void
  /** Sending failed and starts again: everything queued is lost; the page gets `household.gap` and a fresh snapshot. */
  readonly restart: () => void
  /** Whether a `step` has something to do. */
  readonly pending: () => boolean
  /** One bounded step: the messages to send now, built now. */
  readonly step: () => ReadonlyArray<PageMessage>
  /** Entries waiting (the snapshot and a gap count one each). */
  readonly size: () => number
  /** The device record the current (or last) snapshot was made with. */
  readonly snapshotDevice: () => TargetDevice | undefined
}

export const makeHouseholdPage = (options: {
  readonly feed: HouseholdFeed
  /** The server's record of the page's device, now. */
  readonly device: () => TargetDevice
  readonly maxQueued?: number
}): HouseholdPage => {
  const { feed } = options
  const max = Math.max(1, options.maxQueued ?? MAX_QUEUED)
  let queue = new Map<string, Entry>([["snapshot", { _tag: "snapshot" }]])
  let run: SnapshotRun | undefined
  let madeWith: TargetDevice | undefined
  let events = 0

  /** Drop everything; the page is told, then gets a fresh snapshot. */
  const lose = (reason: "overflow" | "restart") => {
    queue = new Map<string, Entry>([["gap", { _tag: "gap", reason }], ["snapshot", { _tag: "snapshot" }]])
    run = undefined
  }

  const offer = (released: ReadonlyArray<Released>) => {
    for (const item of released) {
      if (item._tag === "change") {
        const c = item.change
        if (!feed.sendsCollection(c.module, c.collection)) continue
        const key = `row:${feedRowKey(c.module, c.collection, c.id)}`
        const queued = queue.get(key)
        const scopes = queued?._tag === "row" ? mergeScopes(queued.change.scopes, c.scope) : [{ ...c.scope }]
        queue.delete(key)
        queue.set(key, { _tag: "row", change: { module: c.module, collection: c.collection, id: c.id, scopes } })
      } else if (feed.sendsEvent(item.event.type)) {
        queue.set(`event:${events++}`, { _tag: "event", event: moduleEvent(item.event) })
      }
      // Room for the snapshot a `refresh` adds is kept, so the bound holds across it.
      if (queue.size + (queue.has("snapshot") ? 0 : 1) > max) return lose("overflow")
    }
  }

  const refresh = () => {
    const next = new Map<string, Entry>()
    const gap = queue.get("gap")
    if (gap !== undefined) next.set("gap", gap)
    next.set("snapshot", { _tag: "snapshot" })
    for (const [key, entry] of queue) if (entry._tag === "event") next.set(key, entry)
    queue = next
    run = undefined
  }

  const step = (): ReadonlyArray<PageMessage> => {
    const first = queue.entries().next()
    if (first.done === true) return []
    const [key, entry] = first.value
    switch (entry._tag) {
      case "gap":
        queue.delete(key)
        return [{ type: "household.gap", reason: entry.reason }]
      case "snapshot": {
        if (run === undefined) {
          madeWith = options.device()
          run = feed.snapshot(madeWith)
        }
        const r = run.step()
        if (r.done) {
          queue.delete(key)
          run = undefined
        }
        return r.frames
      }
      case "row": {
        queue.delete(key)
        const event = feed.change(entry.change, options.device())
        return event === undefined ? [] : [{ type: "household.event", event }]
      }
      case "event": {
        queue.delete(key)
        const event = feed.live(entry.event, options.device())
        return event === undefined ? [] : [{ type: "household.event", event }]
      }
    }
  }

  return {
    offer,
    refresh,
    restart: () => lose("restart"),
    pending: () => queue.size > 0,
    step,
    size: () => queue.size,
    snapshotDevice: () => madeWith
  }
}
