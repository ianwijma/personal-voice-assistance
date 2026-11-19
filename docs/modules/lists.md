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

Nine are typed actions with English and Dutch `examples`, so the intent path runs them without the language model;
the model is offered each as the tool `lists_<id>`. Three are tools for the model only. Every one that changes
anything (the two that put a list on a screen and take it down included) is `change`; the two reads are plain reads
(`speculative`). All answer in one or two sentences, in the household's language. Two of the actions are also said as
phrase commands ("Phrase commands" below).

| Tool | Kind | Parameters | Example | Answer |
|---|---|---|---|---|
| `lists_add` | action `lists.add`, `change` | `items` (text, as said), `list?` (a list's name) | "put eggs, bread and two litres of oat milk on the list" | "Added eggs, bread and 2 litres of oat milk to the shopping list." |
| `lists_read` | action `lists.read`, read | `list?`, `show?` (`open`, `done`), `from?` (an item number, also for what was ticked off) | "what's on the shopping list" | "The shopping list has 9 things: milk, eggs, rice, bread, butter and 4 more." |
| `lists_complete` | action `lists.complete`, `change` | `item` (one or more, as said), `list?` | "I've got the bread" | "Ticked off bread on the shopping list." |
| `lists_remove` | action `lists.remove`, `change` | `item`, `list?` | "take eggs off the shopping list" | "Took eggs off the shopping list." |
| `lists_clear_done` | action `lists.clear_done`, `change` | `list?` | "clear the ticked-off items" | "Cleared 4 ticked-off things from the shopping list." |
| `lists_show` | action `lists.show`, `change` | `list?` | "show the shopping list" | "Showing the shopping list on this screen." |
| `lists_hide` | action `lists.hide`, `change` | `list?` | "close the shopping list" | "Closed the shopping list on this screen." |
| `lists_undo` | action `lists.undo`, `change` | none | "undo that" | "Undone: the shopping list is as it was." |
| `lists_overview` | action `lists.overview`, read | none | "which lists do we have" | "There are 3 lists: the shopping list with 9, the to-do list with 2 and the Camping list with 3." |
| `lists_update` | tool, `change` | `item`, `list?`, `rename?`, `amount?`, `unit?`, `clearAmount?`, `note?`, `reopen?` | "make it two" | "Changed it: 2 milk on the shopping list." |
| `lists_create` | tool, `change` | `name`, `kind?` (`shopping`, `todo`, `generic`), `items?` | "start a packing list for camping: tent, sleeping bags, torch" | "Made the camping list with tent, sleeping bags and torch." |
| `lists_delete` | tool, `change` | `list` | "delete the camping list" | "Deleted the Camping list. Say undo to bring it back today." |

Dutch: "zet melk op de boodschappenlijst" → "Melk op de boodschappenlijst gezet."; "toon de boodschappenlijst" →
"De boodschappenlijst staat op dit scherm."; "wat staat er op de lijst" →
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

## Phrase commands

Two actions can be said without the language model, after the wake phrase or in a follow-up window
([docs/PHRASES.md](../PHRASES.md)). Both are for **the household's shopping list only**: the words name it, so the
action's `list` is left out and it takes its own default. A phrase runs the existing action: the same parameters, the
same refusals and sentences, the same risk class. On a matched add phrase, the whole `items` slot is item text for
shopping: "tuna in oil" stays that item even if the household also has a list named "oil".

| Action | English | Dutch |
|---|---|---|
| `lists.add` (`items` is a text slot of at most 8 words) | "add {items} to the shopping list", "put {items} on the shopping list", "add to the shopping list {items}", "put on the shopping list {items}" | "zet {items} op de boodschappenlijst", "doe {items} op de boodschappenlijst", "voeg {items} toe aan de boodschappenlijst", "zet op de boodschappenlijst {items}" |
| `lists.read` (`show` and `from` take their defaults: the open items from the start) | "read the shopping list", "read me the shopping list", "what is on the shopping list", "what's on the shopping list", "what is on my shopping list" | "lees de boodschappenlijst voor", "lees de boodschappenlijst", "wat staat er op de boodschappenlijst", "wat staat er op mijn boodschappenlijst" |

"Add milk, eggs and bread to the shopping list" is three items on the shopping list and answers "Added milk, eggs and
bread to the shopping list."; "wat staat er op de boodschappenlijst" answers "Op de boodschappenlijst staan 3
dingen: melk, eieren en brood." Matching is exact on words (no filler: "please add milk to the shopping list" is not a
phrase, it goes on to the assistant as it did before), so more than eight words in the slot, another list ("to the
to-do list"), "my shopping list" in an add (which says the household's clause) and everything else go to the
assistant, whose tools take them as before.

- **Once per invocation.** A phrase turn has its own turn id, and `lists.add` run as a phrase command keeps its outcome
  by the invocation's identity (assistant, conversation, turn, device, the operation and what it was asked) in one
  bounded record in `shared` (256 finished ones; one still running is never forgotten): the same invocation twice
  (a replay) returns the first outcome and adds nothing more; the next phrase is a new invocation and acts as the
  action does (an item said again is merged, with merging off a second item). The bounded write and completion of
  that record are protected together: interruption at commit cannot make a replay add the item again. Interruption
  before reaching that write leaves the invocation free to retry. Spoken and typed calls are not kept.
- **A phrase that cannot be said by a device** (the slot would be longer than 8 words) is not taken; nothing is written.

## Checklists

"Show the shopping list" puts the list's **open items on the screen of the device that asked**, as a `list`
presentation in the `checklist` style, one tickable line per item (the item's text with its amount, one line of at most
80 characters; at most 12 items, the oldest first as read out; the title is the list's name, with "(+3 more)" when
more are open than are shown, so what is not shown is counted and never hidden). An item name that becomes empty
under those text rules is refused when added or renamed, including through `Lists.addItem`; an amount does not
stand in for a name:

- **When it is shown.** `lists_show` (or "show the shopping list", "toon de boodschappenlijst", "zet de takenlijst op
  het scherm", and the model's tool). It is **pinned**: it stays until closed or until the host ends it, 24 hours (its
  longest lifetime) after it was shown or its content last changed. It is shown only on the device that asked; the
  answer says "Showing the shopping list on this screen."
- **One checklist per device.** A device shows at most one: showing another list there replaces it in place (the same
  key, the same page), and the answer says so: "Showing the camping list on this screen, instead of the shopping list."
  ("De takenlijst staat nu op dit scherm, in plaats van de boodschappenlijst."). If the previous list's name is no
  longer available (for example after undoing its creation), the confirmation names only the new list. Showing the
  same list again just shows it again. So the module never has more checklists than the household has screens; the
  host's bound for one module (8 live presentations), or a screen already full of other modules' cards, can refuse a show. The answer is
  "There isn't room to show this list right now; close something on a screen first."
  ("Er is nu geen ruimte om deze lijst te tonen; sluit eerst iets op een scherm.").
- **A device that cannot show it** (no screen, a page that cannot draw a list) changes nothing about the answer: it
  says "This device can't show it." and then the read-out sentence of the list ("The shopping list has 3 things: …",
  which is also the presentation's spoken fallback). Its accepted presentation (including any earlier checklist
  replaced under its key) is dismissed; the handle and dismissal work stay in the pin until that succeeds, then the pin
  is removed. The worker saves dismissal work before closing the accepted handle; if that write fails it retains the
  handle and retries the write before dismissal, while the answer still gives the readout. A failed dismissal is retried
  by reconciliation and can also be closed with `lists_hide`. The spoken
  sentence is at most 300 characters: it uses whole item names, within `readItems`, and counts the items left out;
  the separate 80-character visual limit does not shorten speech. If no whole item fits, the sentence says how many were not read out. The model's tool says the same.
- **Privacy.** A list is household data, read out on shared, private and public devices alike, so its presentation is
  the household's (`sensitivity` is not personal) and is shown on every device that has a screen; the rule is the one
  that lets the same list be read out there. Nothing about a person is put on it.
- **The saved pin is the one state.** Each device with a checklist has one row in `pins`, found by its id
  (`pin.<device id>`, never by a scan): the list, the presentation's key, its fixed end (`until`), a hash of what was
  last shown, and the work still owed (show it, take it down, remove the row) with its attempts and next try. Every
  write of a pin is one transaction that records what is owed then. One function, `reconcile(device)`, reads the row and
  the list as they are and does what is owed; a worker of the `shared` part runs it, under the module's one permit,
  off the path of the call that asked. The row is written before the screen is touched (a first show, or a changed
  content with its new end, is recorded as owed first and cleared after the show), so an interruption or a restart
  leaves work that reconciliation finishes, and a checklist is never on a screen without a row. A show or hide asks
  the worker from its intent transaction's `afterCommit`, even if the caller is interrupted. Once the Presenter
  answers a show or a close, the request returns its sentence without waiting for bookkeeping: the worker clears a
  successful show's owed work, rolls back a refused show's intent, or removes a dismissed pin. Until rollback commits,
  requests use the previous pin and handle; a refused first show has no previous pin. Every worker dismissal is recorded
  as owed before the screen is touched. Committing a replacement also invalidates the old handle and any old dismissal
  marker.
- **When the list changes.** Every committed change of the module's lists (a voice add or tick, a tool,
  `lists_update`, undo, the `Lists` service, the daily clean-up, deleting the list) names the lists it wrote from the
  committing transaction's `afterCommit`, even if its caller has gone away; their
  pins are found through the `list` index, a page of 16 at a time until the end, and reconciled at once. A change that
  leaves what the screen holds as it is (title and items) sends nothing; a real change is shown again under the key
  with a new end, 24 hours from then. Deleting a list takes its checklists down; undoing the delete does not put them
  back. The deletion records a store revision cutoff on the list, kept by undo: pins that existed then stay
  cancelled, including when a refused replacement restores their row; a press on a cancelled pin changes no item.
  A later explicit show establishes a new pin without scanning pins on the deletion's turn.
- **When something fails.** A step that fails (the host busy, the store busy) leaves its work owed in the row with a
  later try for that pin alone (5 s, 20 s, 80 s, 320 s, then every 10 minutes). A new change of the pin's list asks
  for another try at once. After a failed read, the next change to any checklist can reach its screen up to five
  seconds late. A checklist that was taken down while its row could not be removed leaves the row saying so, and
  the next try removes it: rows never pile up. A refused show followed by a module restart before its rollback commits
  can still show the recorded intent; it then follows the ordinary close and expiry rules.
- **When a device is offline.** A change while the device's page is disconnected is still a success: the host keeps
  the pinned presentation, updated, and gives it back when the page reconnects (docs/PRESENTING.md); the pin stays.
  Showing a list on a device that is offline at that moment keeps the pin too, and answers "I can't show it here right
  now." with the read-out sentence.
- **When a device is removed.** A pinned device that is no longer one of the household's known devices
  (`host.view().devices`; an empty list means "not known yet", never "removed") is found at the next change of its list
  or within a minute (the host sends modules no signal for it): its checklist is dismissed with this run's handle (or
  by the closing workaround below) and its pin removed, which frees its place in the host's bound.
- **Closing.** `lists_hide` ("close the shopping list", "haal de lijst van het scherm") takes this device's checklist
  down; with a list named, only when that is the list shown ("The shopping list isn't on this screen." otherwise);
  without one, whatever list it is ("Closed what I showed on this screen."). The list itself is not changed. The close is
  first recorded in the row, then done; if the host is busy it is tried again until done, and the answer says "I'll
  take the shopping list off this screen as soon as I can." A handle that no longer closes the current card also leaves
  the fallback close to the worker and answers with that sentence. A close is a close until the checklist's actual end, also
  in its last seconds. If the list is gone (for example its creation was undone), the answer says "That list is gone."
  / "Die lijst bestaat niet meer."; a closing card uses a generic localized title and the same sentence when the list's row
  is absent, while a deleted list retained for undo keeps its name and says "The camping list isn't shown any more."
  / "De lijst camping wordt niet meer getoond." A list's internal
  id is never used as its display name or spoken name.
- **A restart** keeps the pins and the screens (the host keeps pinned presentations). When the module starts it
  reconciles every pin (a page of 16 at a time): what changed while it was stopped is shown, and an unchanged checklist
  is shown again with **what remains of its end**, so this run has its handle; a restart never moves the end. With less
  than the host's minimum (3 seconds) left, it is left to end. Without a handle (one that could not be taken again),
  a checklist is closed by showing it empty under the same key, which the host ends three seconds later.
- **When it ends.** At its end the host takes it down by itself, and the worker removes the pin then (it is due at
  `until`). Remaining lifetime is computed immediately before every call to the Presenter, including refreshes and
  restarts. At the fixed end the worker dismisses a still-live handle before removing its row; it never shows an
  empty replacement then, and an owed show whose end has passed is dropped. Before that moment the pin is never
  treated as ended.
- **A tick** on an item is the press handler `lists` (registered in `shared`). It completes that item by its id through
  the same engine call as `lists_complete` (so under the one-at-a-time rule) and answers what it committed: "Ticked off
  eggs on the shopping list." The item and its list's count are attributed to the UI device (`actor: { kind: "ui", deviceId }`). Bringing the screens up to date is owed work of the pins (the commit names the list); a
  failure there never changes the answer. When the status write itself fails, the answer is "The lists are busy just
  now; try again in a moment." and nothing changed. It is idempotent by the item: an item that is already ticked off (by
  another device, or a second press) is not ticked again and the answer says "Already ticked off: eggs."; an item that
  is gone says so (and the screen is brought up to date). Each line carries a signature of its item's id, name and amount;
  if the name or amount changed before the tap, nothing is ticked, the answer asks for another tap, and the worker refreshes
  the checklist. Editing another item does not invalidate the tap. A press records no undo entry (a press has no conversation).
  A tick can only tick off: the checklist shows open items, and an untick answers "Here I can only tick things off." A
  device that does not hold the checklist, and a module that is stopped, are refused by the host ("I can't do that
  right now.") before any of this runs.

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

Four household-scoped collections (`storage.version` 3: version 2 added the status to an item's `match` and the
`pins` collection; version 3 adds optional `pinsCancelledThrough` to lists, preserving all existing values). **Nothing in the first
three is about one person**: no person id, no device id, no conversation id (the undo row's id is a hash of the
conversation id). A pin holds a device's id (the household's own screen, also in its row id) and no person and no item. Lists are shared household data
by design, read out on shared, private and public devices alike; the store's own change record (`updatedBy`) is the
store's, not read by the module.

| Collection | `maxChars` (worst legal value) | Indexes | A list reads | Kept |
|---|---|---|---|---|
| `lists`: one row per list (name, kind, open and ticked-off counts, `deletedAt`, the optional deletion cutoff `pinsCancelledThrough`); the two default lists' rows made at the start | 240 (207) | none | all lists in one read (at most 50) | until deleted, then a day for undo |
| `items`: one row per item (list, text, quantity, note, status `open`/`done`/`removed`, `place` = list and status, `since`, `match` = a hash of the list and normalised text with the status, `dedupeKey`) | 1,500 (1,466) | `[place, since]`, `[match, since]`, `dedupeKey` | 16 rows: every list read pages with `after` | open: until ticked off or removed; ticked off: by the settings; removed: a day for undo |
| `pins`: the checklist of one device: at most one row per household device, id `pin.<device id>` (list, device id, the presentation's key (a hash of the device id), its end, a hash of what was last shown, the work owed with its attempts and next try) | 540 (528) | `list` | a device's pin by id; a list's pins (and at a start all) 16 at a time until the end | until the checklist is closed, its list is deleted, its device is removed or it ended |
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

**Not now** (the checklist and the two phrase commands are described above):

- **Live copies on every screen at once** beyond what pinning gives: a checklist is shown on the screens that asked for
  it (a room or "everywhere" is not a target), up to the host's bounds.
- **Phrase commands for other lists** (the to-do list, named lists, "my shopping list"), for ticking off, removing and
  the other actions: they run through the model or the typed intent path as before.
- Notifications (a list that changed, a reminder to shop); a checklist of ticked-off items; unticking.

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
- **No dismissal by key, and no signal for a removed device.** A pinned presentation can be dismissed only through
  the handle of the show that made it; after a restart the module takes a handle again by showing the unchanged
  checklist with what remains of its end, and where it cannot (less than three seconds left, or a device that is no
  longer the household's) it closes one by showing it empty under the same key (the host ends it three seconds later;
  a removed device is refused, so its presentation ends at its own end). The smallest change: `ctx.present.dismissKey(key)`.
  A device removed by the admin reaches modules only through `host.view()`, read here at each change and once a minute;
  the smallest change: a host event when the household's devices change.
- A press carries no invocation id, so a tick is idempotent by the item's state, not by the press.

**Contract readings** (`packages/module-contracts/src/lists.ts`):

- "Removes the item … for good" (`removeByKey`): the row is removed at once. An item a *person* removes by voice is
  kept for a day as `removed` so undo can bring it back; while it is, it is not "an item" for the service (`find`
  and `completeByKey` do not see it), and an `addItem` with its key removes it for good and adds a new item
  (`added`, a new id), so a key never names two items. Its undo then leaves it gone.
- "Replaces that item's text, quantity and note … where the item is": an `updated` or `reopened` item keeps its
  place in the list's order unless it was reopened (a reopened item goes to the end, like a new one).
- The 500 open items bound is the shopping list's in the contract; the module keeps the same bound for every list.
