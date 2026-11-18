import { ServiceKey } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * `Lists`: the lists module's service (docs/MODULES-PLAN.md §5.2; docs/research/modules/lists.md §4 "Service for other
 * modules"). Provided by `lists` (`packages/module-lists`), used by `kitchen`, which puts low stock on the shopping list.
 *
 * **What it is.** Four operations on **the household's shopping list**, and nothing else: no other list, no list
 * names, no person lists. Everything on it is household data, shown on every screen that shows the list, so a
 * consumer never puts personal content in an item.
 *
 * **Keys.** A consumer that comes back to an item gives it a `dedupeKey` that it chooses: its own module id, a colon,
 * and its own reference ("kitchen:product:rice"); 3 to `LISTS_LIMITS.keyChars` characters of `[A-Za-z0-9_.:@/-]`
 * with a colon after the first character. A key names at most one item on the list, for as long as that item exists
 * (open or done); the lists module keeps it unchanged.
 *
 * - `addItem` **with a key no item has** adds a new open item: `added`.
 * - `addItem` **with a key an item has** replaces that item's `text`, `quantity` and `note` with the request's, where
 *   the item is; an optional field absent from the request is cleared on the item. An open item stays open:
 *   `updated`. A done item is opened again: `reopened`.
 * - `addItem` **without a key** always adds a new open item (`added`), even when an item with the same text is on the
 *   list. The lists module's own merging of what people say ("rice" said twice) is its own business and is not part
 *   of this service.
 * - `completeByKey` ticks off the open item with that key (`undefined` when no open item has it, and then nothing
 *   changes); `removeByKey` removes the item with that key, open or done, for good (`false` when none has it);
 *   `find` answers the item with that key, open or done, or `undefined`.
 *
 * So repeated low-stock checks of one product keep one item, which kitchen can tick off or remove when stock is back.
 *
 * **Bounds.** Checked by the provider; a request outside them is `invalid` and changes nothing.
 *
 * - `text`: 1 to `LISTS_LIMITS.textChars` characters (UTF-16 units) of one line: no control characters, no lone
 *   surrogates, not only spaces.
 * - `note`: at most `LISTS_LIMITS.noteChars` of one line.
 * - `quantity.amount`: a finite number above 0 and at most `LISTS_LIMITS.maxAmount`; `quantity.unit`: 1 to
 *   `LISTS_LIMITS.unitChars` of one line (a unit id of `@pva/language`, "g", "l", "piece", or a word); absent: a count.
 * - At most `LISTS_LIMITS.openItems` open items on the list: an `added` or `reopened` that would make one more is
 *   `limit` and changes nothing; an `updated` item was open already and is never refused for this.
 *
 * **Ids.** `ListItem.id` is chosen by the lists module: a store row id (1 to 200 of `[A-Za-z0-9_.:-]`), the same for
 * the item's whole life, never reused. A consumer keeps its own key, not the id.
 *
 * **Errors.** `ListsError.reason` says what happened; the consumer words it in its own two-language texts.
 * `detail` is for the log only (English, never spoken, never anything private).
 *
 * **Latency.** Each call is one store transaction of a few single-row reads and writes: fine on a turn's path and in
 * a scheduled job.
 *
 * **When the lists module is off or stops**: `host.service(Lists)` is `undefined`; a call made while it stops may die
 * with `ModuleStopped`. `useService(host, Lists, …)` (`common.ts`) makes both `ProviderOff`. A consumer that adds from
 * a job and finds it off does not retry in a loop: its next check adds the item again with the same key.
 */
export const LISTS_LIMITS = {
  textChars: 200,
  noteChars: 200,
  keyChars: 100,
  unitChars: 20,
  maxAmount: 1_000_000,
  openItems: 500
} as const

/** The characters and shape of a dedupe key (see above). */
export const LIST_KEY_PATTERN = /^[A-Za-z0-9_.@/-][A-Za-z0-9_.:@/-]*:[A-Za-z0-9_.:@/-]+$/

/** An amount, with a unit or as a count. */
export interface ItemQuantity {
  readonly amount: number
  readonly unit?: string
}

export interface ListItem {
  readonly id: string
  readonly text: string
  readonly quantity?: ItemQuantity
  readonly note?: string
  readonly status: "open" | "done"
  readonly dedupeKey?: string
}

export interface AddItemRequest {
  readonly text: string
  readonly quantity?: ItemQuantity
  readonly note?: string
  readonly dedupeKey?: string
}

export interface AddItemResult {
  readonly outcome: "added" | "updated" | "reopened"
  readonly item: ListItem
}

/** A refusal or failure (see "Errors" above). */
export class ListsError extends Data.TaggedError("ListsError")<{
  /**
   * `invalid`: a request outside the bounds; nothing changed. `limit`: the list has `openItems` open items; nothing
   * changed. `busy`: the store was busy; nothing changed, try again later. `failed`: anything else.
   */
  readonly reason: "invalid" | "limit" | "busy" | "failed"
  readonly detail: string
}> {}

export interface ListsService {
  /** Add an item to the shopping list, or replace and perhaps reopen the one with the key (see above). */
  readonly addItem: (request: AddItemRequest) => Effect.Effect<AddItemResult, ListsError>
  /** Tick off the open item with this key. `undefined`: no open item has it (nothing changed). */
  readonly completeByKey: (dedupeKey: string) => Effect.Effect<ListItem | undefined, ListsError>
  /** Remove the item with this key, open or done, for good. `false`: no item has it. */
  readonly removeByKey: (dedupeKey: string) => Effect.Effect<boolean, ListsError>
  /** The item with this key, open or done; `undefined` when none has it. */
  readonly find: (dedupeKey: string) => Effect.Effect<ListItem | undefined, ListsError>
}

export const Lists = ServiceKey<ListsService>("lists")
