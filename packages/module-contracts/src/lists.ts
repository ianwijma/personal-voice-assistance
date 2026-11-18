import { ServiceKey } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * `Lists`: the lists module's service (docs/MODULES-PLAN.md §5.2; docs/research/modules/lists.md §4 "Service for other
 * modules"). Provided by `lists` (`packages/module-lists`), used by `kitchen` (low stock onto the shopping list).
 *
 * **What it is.** Other modules add, tick off and remove items on the household's lists without going through the
 * model. Four operations, all on **household** lists (person lists are later, so nothing here is personal, and a
 * consumer must not put personal content in an item: the item is shown on every screen that shows the list).
 *
 * **Keys.** A consumer that will come back to an item gives it a `dedupeKey`: `<its module id>:<its own id>`
 * ("kitchen:product:rice"), at most `LISTS_LIMITS.keyChars` of `[A-Za-z0-9_.:@/-]`, beginning with `source.module`
 * and a colon (anything else is `invalid`). A key names at most one item in the household:
 *
 * - `addItem` with a key whose item is **open** updates that item (text, quantity, note) where it is: `updated`;
 * - with a key whose item is **done**, reopens and updates it: `reopened`;
 * - with a key no item has, adds a new item: `added`;
 * - without a key, the lists module's own rule applies: an open item on that list with the same normalised text is
 *   merged (equal units add up, otherwise the words go into its note): `merged`; else `added`.
 *
 * So repeated low-stock checks of one product keep one item, and "add rice" said by a person later finds it.
 *
 * **Bounds.** `text` 1–`textChars` characters of one line (no control characters); `note` at most `noteChars`;
 * `quantity.amount` finite, above 0 and at most 1,000,000, `unit` at most `unitChars`, `said` at most `saidChars`; a list
 * name at most `nameChars`. A list holds at most `itemsPerList` open items; one more is `limit`.
 *
 * **Latency.** Each call is one store transaction of a few single-row reads and writes (well under 5 ms): fine on a
 * turn's path, and in a scheduled job.
 *
 * **When the lists module is off or stops**: `host.service(Lists)` is `undefined`; a call made while it stops may die
 * with `ModuleStopped`. Use `useService(host, Lists, "lists", …)` (`common.ts`), which makes both `ProviderOff`, and say
 * "The lists module is off." A consumer that adds to a list from a job and finds it off does not retry in a loop: the
 * next check (the next booking, the next run of its job) adds it again with the same key.
 *
 * **Events.** The lists module publishes `lists.item.completed` (with the item's `dedupeKey`) when an item is ticked.
 * A consumer may listen, but nothing may depend on an event for correctness (§5.2): it may be lost at a restart.
 */
export const LISTS_LIMITS = {
  textChars: 200,
  noteChars: 200,
  keyChars: 100,
  nameChars: 60,
  unitChars: 20,
  saidChars: 60,
  maxAmount: 1_000_000,
  itemsPerList: 500
} as const

/** Which list: the household's default shopping or to-do list, a list by its id, or by its name or an alias. */
export type ListRef =
  | { readonly kind: "shopping" | "todo" }
  | { readonly id: string }
  | { readonly name: string }

export interface ListInfo {
  readonly id: string
  /** As the household named it ("Shopping", "Boodschappen"). */
  readonly name: string
  readonly kind: "shopping" | "todo" | "generic"
  readonly openItems: number
}

/** An amount with a unit, as `@pva/language`'s `parseQuantity` reads it ("2 l", "a handful"). */
export interface ItemQuantity {
  readonly amount: number
  /** A unit id of `@pva/language` ("g", "l", "piece") or a word; absent: a count. */
  readonly unit?: string
  /** What was said, for speaking it back ("about a kilo"). */
  readonly said?: string
}

export interface ListItem {
  readonly id: string
  readonly listId: string
  readonly text: string
  readonly quantity?: ItemQuantity
  readonly note?: string
  readonly status: "open" | "done"
  readonly dedupeKey?: string
}

export interface AddItemRequest {
  readonly list: ListRef
  readonly text: string
  readonly quantity?: ItemQuantity
  readonly note?: string
  /** Who adds it: the consumer's module id, and its own reference ("product:rice"), kept with the item. */
  readonly source: { readonly module: string; readonly ref?: string }
  readonly dedupeKey?: string
}

export interface AddItemResult {
  readonly outcome: "added" | "merged" | "updated" | "reopened"
  readonly item: ListItem
  readonly list: ListInfo
}

/**
 * A refusal or failure. `message` is one sentence that can be spoken as it is ("There is no list called garden.");
 * never anything private.
 */
export class ListsError extends Data.TaggedError("ListsError")<{
  /**
   * `unknown_list`: no list by that reference. `invalid`: a request outside the bounds above. `limit`: the list is full.
   * `busy`: the store was busy; nothing was done, try again later. `failed`: anything else.
   */
  readonly reason: "unknown_list" | "invalid" | "limit" | "busy" | "failed"
  readonly message: string
}> {}

export interface ListsService {
  /** Add an item, or update, reopen or merge into the one the key (or the text) names (see above). */
  readonly addItem: (request: AddItemRequest) => Effect.Effect<AddItemResult, ListsError>
  /** Tick off the open item with this key. `undefined`: no open item has it (nothing changed). */
  readonly completeByKey: (dedupeKey: string) => Effect.Effect<ListItem | undefined, ListsError>
  /** Remove the item with this key, open or done, for good. `false`: no item has it. */
  readonly removeByKey: (dedupeKey: string) => Effect.Effect<boolean, ListsError>
  /** The list a reference names, with its count of open items; `undefined` when there is none. */
  readonly find: (list: ListRef) => Effect.Effect<ListInfo | undefined, ListsError>
}

export const Lists = ServiceKey<ListsService>("lists")
