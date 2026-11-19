# Lists (`lists`)

Shopping and to-do lists: add, read, tick off and remove items.

- Package: `packages/module-lists`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 5 (wave A)
- Research: [docs/research/modules/lists.md](../research/modules/lists.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

The household's lists, kept in the module's own collections in the household store: **the shopping list** and **the
to-do list**, which every household has (their rows are made when the module starts), and up to 28 **named lists**
("camping packing", "gift ideas"). Every list is household data: one list, the same from every device and every
assistant, and **lists are shared**: there are no personal lists in this version.

- **"My list".** "Put milk on my shopping list" is how people ask for the household's list, so it is not refused: the
  item goes on the household's list, and when the request named the list as the speaker's own ("my", "mijn") the
  answer says so in one clause: "Added milk to the household's shopping list, which everyone here can see." /
  "Melk op de boodschappenlijst van het huishouden gezet, die iedereen hier kan zien." That holds on the typed path
  ("… to my to-do list" in what was said) and through the model's tool (`list: "my shopping list"`), on every device.

- **Splitting.** "Add milk, eggs and two litres of oat milk" is three items: split on commas and "and" (Dutch "en"),
  except inside a few known names that hold "and" ("salt and pepper crisps", "mac and cheese", "zout en peper chips"),
  and never inside an amount: a decimal comma ("1,5 liter melk"), "two and a half litres", "one hundred and twenty
  grams", "twee en een halve kilo" are one amount, read before anything is split (a piece that is a number by itself
  is joined to the next when `@pva/language` reads one quantity across them). At most 12 items and 2,000 characters
  per request, and more than 36 pieces is refused before any parsing. Measured on the development machine (50 runs
  after warm-up, the split alone): 12 items that each join across "and", 1.8 ms median (2.2 ms most); the worst text
  within the bounds (36 pieces, every other one a number followed by six words), 3.4 ms median (5.3 ms most); an
  ordinary request, 0.05 ms.
- **Quantities.** Each item's amount is read by `@pva/language` (`parseQuantity`): "two litres of oat milk" is oat milk,
  2 l; "3 lemons" is lemons, a count of 3; "een pak melk" is melk, 1 pack. They are said back by `speakAmount`.
- **Merging.** An item said again is not added twice (setting): "add milk" with milk on the list says it is already
  there; an amount is added to the amount on the list ("500 grams of flour" and then "a kilo of flour" is 1.5 kg), also
  across units `@pva/language` converts, and also within one request ("two litres of milk and 500 ml of milk" is one
  item of 2.5 l); a ticked-off item said again is put back on the list. An amount that cannot be added to the one on
  the list (another kind of unit: "a bag of flour" beside "1 kg of flour") is never lost and never hidden: it is a
  second item of the same name with its own amount, said and read back as it is ("1 kilogram of flour and a bag of
  flour"), with the ordinary limits and counts. No amount is ever put in a note. With merging off, everything said is
  a new item, also the same thing twice in one request. "Eggs" and "egg" are the same item; "oat milk" and "milk" are
  not.
- **Ticking off and removing.** "I've got the bread" ticks it off: it stays readable as ticked off for a while (a day
  for shopping, a month for other lists; settings). "Take eggs off" removes it. Items are found by name: exactly
  (lower case, without articles and accents, singular), an **open item first** whatever else has that name (the index
  holds the status), then the most recently ticked-off one; else by the core's own name matching (sound, one edit
  away) over the list's open items (and its ticked-off ones, the newest first, for removing and changing). That scan
  is bounded (500 rows per status); when it stopped at its bound and found nothing, the answer never says "not on the
  list": "I couldn't look through everything on the shopping list for pinapple; say the exact name."
- **Undo.** "Undo" reverses the last change of the conversation (one level), within a day: an add (merges included),
  a tick, a removal, a clear, a change, a new list, a deleted list. It restores exactly what was there: status, amount
  and note, also their absence (a ticked-off milk without an amount, put back by "3 litres of milk", is ticked off
  without an amount again). What someone else changed since is left as it is, and the answer says so.
- **One at a time.** Every operation that reads and then writes (each tool, action and service call, each step of
  the nightly clean-up, making and deleting a list, undo) and every read that says a count with items runs under one
  permit of the module's shared part, so no two interleave and "has one thing: rice" never names two. What decides
  outside the transaction it writes in also checks again inside it: the clean-up (each row's rev, status and age, and
  an undo entry's rev and age), and making a list (its name and both limits).
- **The `Lists` service** for other modules (the kitchen first): four operations on the shopping list by the caller's
  key (`packages/module-contracts/src/lists.ts`).

Everything is local: no outside service, no network.

## Tools

Seven are typed actions with English and Dutch `examples`, so the intent path runs them without the language model;
the model is offered each as the tool `lists_<id>`. Three are tools for the model only. Every one that changes
anything is `change`; the two reads are plain reads (`speculative`). All answer in one or two sentences, in the
household's language.

| Tool | Kind | Parameters | Example | Answer |
|---|---|---|---|---|
| `lists_add` | action `lists.add`, `change` | `items` (text, as said), `list?` (a list's name) | "put eggs, bread and two litres of oat milk on the list" | "Added eggs, bread and 2 litres of oat milk to the shopping list." |
| `lists_read` | action `lists.read`, read | `list?`, `show?` (`open`, `done`), `from?` (an item number, also for what was ticked off) | "what's on the shopping list" | "The shopping list has 9 things: milk, eggs, rice, bread, butter and 4 more." |
| `lists_complete` | action `lists.complete`, `change` | `item` (one or more, as said), `list?` | "I've got the bread" | "Ticked off bread on the shopping list." |
| `lists_remove` | action `lists.remove`, `change` | `item`, `list?` | "take eggs off the shopping list" | "Took eggs off the shopping list." |
| `lists_clear_done` | action `lists.clear_done`, `change` | `list?` | "clear the ticked-off items" | "Cleared 4 ticked-off things from the shopping list." |
| `lists_undo` | action `lists.undo`, `change` | none | "undo that" | "Undone: the shopping list is as it was." |
| `lists_overview` | action `lists.overview`, read | none | "which lists do we have" | "There are 3 lists: the shopping list with 9, the to-do list with 2 and the Camping list with 3." |
| `lists_update` | tool, `change` | `item`, `list?`, `rename?`, `amount?`, `unit?`, `clearAmount?`, `note?`, `reopen?` | "make it two" | "Changed it: 2 milk on the shopping list." |
| `lists_create` | tool, `change` | `name`, `kind?` (`shopping`, `todo`, `generic`), `items?` | "start a packing list for camping: tent, sleeping bags, torch" | "Made the camping list with tent, sleeping bags and torch." |
| `lists_delete` | tool, `change` | `list` | "delete the camping list" | "Deleted the Camping list. Say undo to bring it back today." |

Dutch: "zet melk op de boodschappenlijst" → "Melk op de boodschappenlijst gezet."; "wat staat er op de lijst" →
"Op de boodschappenlijst staan 3 dingen: …"; "maak dat ongedaan" → "Ongedaan gemaakt: …".

- **Which list.** No list named: the shopping list (and the answer names it, so a mistake is heard). The default lists
  answer to their names in both languages ("groceries", "the list", "boodschappen", "to do", "takenlijst"); a named
  list to its name. On the typed path the rest of the sentence names it ("milk *to the to-do list*", "brood *van de
  lijst*"); "my" or "mijn" before it is the household's list (above). A list said the way a list is named that the
  household does not have ("tent *to the camping list*", "tent *op de kampeerlijst*") is refused in the household's
  language with the lists there are, and nothing is written to another list; "to" inside an item ("remember to write
  the shopping list") is not a list. Ticking off or removing without a list looks for the item on every list, the
  default ones first.
- **Refusals**, each in both languages and saying what to do: a list that is full ("… has 500 things on it. Tick some
  off first."), more than 12 items at once, an item too long, a list name in use or one of the default lists' names,
  30 lists already, the default lists cannot be deleted, an item not on the list, nothing to undo, a list that changed
  since, a search cut short ("say the exact name"), a busy store ("try again in a moment"). A list name the household
  does not have in the `list` parameter is refused by the host before the module runs, with the names there are (that
  sentence is the host's, in English; see "What was left out").
- The **instructions** sent while it is on (stable text): lists are the household's and seen everywhere; there are no
  personal lists yet, and "my shopping list" is the household's, which `lists_add` says in its answer; one `lists_add`
  call per request; `lists_undo` reverses the last change.

## Settings

| Field | Kind | Default | What it does |
|---|---|---|---|
| Split what is said (`splitItems`) | choice: `known`, `always`, `never` | `known` | On commas and "and" but not inside the known names; always; or one item per request |
| Merge items said again (`mergeDuplicates`) | on/off | on | Off: an item said again is a second item |
| Keep ticked-off shopping for (`keepDoneShoppingHours`) | 1–720 hours | 24 | Then the daily clean-up removes them (shopping lists) |
| Keep other ticked-off items for (`keepDoneDays`) | 1–365 days | 30 | The same for to-do and named lists |
| Items read out at once (`readItems`) | 2–10, **overridable** per assistant | 5 | How many items "what's on the list" names before "and N more" |

No secrets, no addresses.

## What it stores

Three household-scoped collections (`storage.version` 2: version 1 kept the hash alone in an item's `match`; the
upgrade adds the status to it). **Nothing in them is about one person**: no person id, no
device id, no conversation id (the undo row's id is a hash of the conversation id). Lists are shared household data
by design, read out on shared, private and public devices alike; the store's own change record (`updatedBy`) is the
store's, not read by the module.

| Collection | `maxChars` (worst legal value) | Indexes | A list reads | Kept |
|---|---|---|---|---|
| `lists`: one row per list (name, kind, open and ticked-off counts, `deletedAt`); the two default lists' rows made at the start | 200 (167) | none | all lists in one read (at most 50) | until deleted, then a day for undo |
| `items`: one row per item (list, text, quantity, note, status `open`/`done`/`removed`, `place` = list and status, `since`, `match` = a hash of the list and normalised text with the status, `dedupeKey`) | 1,500 (1,466) | `[place, since]`, `[match, since]`, `dedupeKey` | 16 rows: every list read pages with `after` | open: until ticked off or removed; ticked off: by the settings; removed: a day for undo |
| `undo`: the last change of each conversation (the items it changed with the rev it left them at and their status before, the amounts and notes a merge changed, an item's text before a change) | 16,000 (14,758) | `at` | 1 row (undo reads its row by id) | a day |

- **Counts.** A list's open and ticked-off counts are on its row, changed in the same transaction as every item, so
  "9 things", "is full" and the overview are one row read, never a count over the store.
- **Bounds on a turn.** Reading "the first five" reads five rows; `from` reads at most `from - 1 + readItems` (≤ 510)
  rows page by page, for open and for ticked-off items. Finding an item by name is one indexed read of the open ones
  by `match` (and one of the ticked-off ones); a close name then scans at most 500 rows per status (32 reads of 16),
  and says so when it was cut short. An add is at most two indexed reads per item (≤ 12) inside its transaction.
- **Bounds.** 500 open items per list (the contract's bound, for every list), 30 lists (50 rows with the two default
  lists and deleted ones waiting for their undo window; both limits and the name are decided inside the transaction
  that makes a list), 12 items per request, item text and note 200 characters of one line, a quantity above 0 and at
  most 1,000,000, a unit 20 characters, a list name 40.
- **Removed is removed** a day later (undo needs it until then), for good; the daily backups keep a row up to 14 days.

**The daily clean-up** (`tidy`, cron `15 4 * * *`, the household's time zone, idempotent, default late rule: a run
found late runs once): ticked-off items past the settings, removed items and deleted lists (with all their items)
past the undo window, and undo entries past it. In steps of one page per transaction with a yield between, at most
400 steps a run; what is left is done the next night. Each step runs under the module's permit and decides again
inside its transaction on the rows as they are then: an item reopened, changed or put back since it was read, and
an undo entry replaced since, stay. Every write it makes is the job's (`actor`), the lists' counts included.

## What it needs

- `requires`: nothing (no network, no program). No `health` check: there is nothing outside the process to check.
- `uses`: nothing.
- **Provides** the `Lists` service (`packages/module-contracts/src/lists.ts`), implemented as its documentation says:
  `addItem` (added, updated in place, reopened; without a key always added), `completeByKey`, `removeByKey` (for
  good), `find`; bounds checked (`invalid`), 500 open items (`limit`), a busy store (`busy`), anything else
  (`failed`); each call one transaction, one at a time with the module's own changes. A handle kept after the module
  stopped dies with the host's `ModuleStopped` and writes nothing. It records no undo entry: the consumer's own
  changes are its business.
- Consumes nothing; no contributions, no events of its own (the store's `lists.items.changed` and
  `lists.lists.changed` events are published as for every collection).

## What was left out

**Waits for wave B** (they need P7, P9 or P10, which do not exist yet):

- The **checklist presentation** with direct ticks (research §8): `present.*`, a tick calling `lists_complete` as a
  presentation action, the pinned list on a kitchen display, live updates on every copy.
- **Phrase commands** for add and read (P7). The typed actions with examples are there and run without the model on
  the intent path; the phrase commands come with P7.

**Later, as the plan's row says** (not in this first version): chores, **person lists** ("my to-do list": until they
exist, it is the household's to-do list, and the answer says that everyone here can see it), every outside
provider (Home Assistant to-do, CalDAV, Todoist, Google Tasks, the kitchen apps) and the outbox, the grocery
catalogue with categories and "recent items" (a dozen known compound names stand in for it in splitting), list
aliases set by the owner, ambient facts ("Shopping: 9 items"), events of its own (`lists.item.completed`), a 30-day
restore of deleted lists (they can be brought back with undo for a day).

**Missing below** (reported, not worked around):

- A `dynamic` action parameter that names no option is refused by the core (`Actions.ts`, `toParamValue`) with an
  English sentence of its own ("Unknown list "camping". Valid names: …") before the module runs, also in a Dutch
  household. The smallest change: let a `DynamicParam` take an `unknown` text (a function of the language and the
  name said), or pass the name through to `run` when the param says so, so the module can word it. Where the module
  sees the name itself (the rest of the sentence on the typed path), it refuses in the household's language.
- The list choices hold each list twice, once as the speaker's own ("my shopping list", value `<id>~mine`), because
  the host resolves a `dynamic` parameter before `run` and passes only the value: there is no other way for the
  module to see that "my" was said in `list`. The host's English "Valid names" sentence above lists those names too.

**Contract readings** (`packages/module-contracts/src/lists.ts`):

- "Removes the item … for good" (`removeByKey`): the row is removed at once. An item a *person* removes by voice is
  kept for a day as `removed` so undo can bring it back; while it is, it is not "an item" for the service (`find`
  and `completeByKey` do not see it), and an `addItem` with its key removes it for good and adds a new item
  (`added`, a new id), so a key never names two items. Its undo then leaves it gone.
- "Replaces that item's text, quantity and note … where the item is": an `updated` or `reopened` item keeps its
  place in the list's order unless it was reopened (a reopened item goes to the end, like a new one).
- The 500 open items bound is the shopping list's in the contract; the module keeps the same bound for every list.
