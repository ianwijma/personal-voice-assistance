# Lists (shopping, to-do, named lists, chores)

Research write-up, 2026-11-17. Not an approved design. It builds on the shared foundations named in
[README.md](README.md): store, scheduler, events and notifications in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) ("shared state
§n"), presentation and device rules in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md) ("presentation
§n"), manifest and connections in
[`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)
("module definition §n"). What exists today is in [`current-system.md`](../module-investigation/current-system.md).
Provider facts were checked on 2026-11-17 against each project's OpenAPI document or source; anything not checked is
marked **[unverified]**.

## 1. Summary

The household's lists: the **shopping list**, **to-do lists** (household and personal), any **named list** ("packing
list for camping", "gift ideas for Sam"), and **chores** with recurrence and assignment ("whose turn is it to do the
bins?"). Lists are household data: one list, seen and changed from every device and by every assistant, shown as a
live checklist on screens. A local store is the default. Todoist, Google Tasks, CalDAV VTODO, Home Assistant to-do
entities and the kitchen apps' shopping lists (Mealie, Grocy, KitchenOwl, Tandoor) are optional backends per list. The
module also offers a typed `Lists` service so other modules ([kitchen](kitchen.md) first) add items without going
through the model.

- **Priority: first wave.** Lists are on every assistant (landscape-voice-assistants §17: "very high (shopping)"), are
  among the most installed things in Home Assistant (`shopping_list` and `local_todo`, landscape-automation §11), and
  are what broke when Alexa+ and Gemini for Home put an LLM in front of them (landscape-voice-assistants §16). The
  kitchen module depends on this one.
- **Effort: M.** The local store with tools and intents is S. Chores are S–M (recurrence and rotation). Each provider
  is S–M; Home Assistant is the cheapest first provider because one adapter reaches every to-do integration HA has.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa | Shopping and to-do lists synced to the app; historically third-party list sync (AnyList, Todoist) (landscape-voice-assistants §1); that list-skill path was later ended **[unverified: date and scope]** | One default shopping list, reachable from every Echo | Lists locked inside one vendor's app |
| Google / Nest | Lists in Google Keep; third-party list sync (AnyList, Any.do, Bring) shut down in June 2023; the Keep link broke for many users in August 2026 (landscape-voice-assistants §2) | — | Platform churn deleting what people relied on: we own the store |
| Home Assistant | `shopping_list`, `local_todo` and the [`todo` entity](https://contributors.home-assistant.io/core/entities/todo/) domain: items `uid`, `summary`, `status` (`needs_action`, `completed`), `due`, `description`; features `CREATE_TODO_ITEM`, `UPDATE_TODO_ITEM`, `DELETE_TODO_ITEM`, `MOVE_TODO_ITEM`, `SET_DUE_DATE_ON_ITEM`, `SET_DUE_DATETIME_ON_ITEM`, `SET_DESCRIPTION_ON_ITEM`; actions `todo.add_item`, `update_item`, `remove_item`, `get_items`, `remove_completed_items`; built-in voice intents for adding to lists | A **typed list surface with feature flags**, so any agent and any UI works with any backend (shared state §2.1). Intents first, LLM second. | Item quantity is part of the text; no categories; no chores model |
| Bring! | Shared shopping list with an item catalogue, icons, a "specification" per item ("2 l"), sections per shop, recent items | Item + specification split; category sorting; re-adding a recent item in one tap | No public API (HA's integration uses an unofficial one **[unverified]**) |
| Todoist | Natural-language due strings with recurrence ("every monday"), assignees in shared projects, sections | Recurrence written as speech; assignment | Hosted only |
| Grocy chores | `period_type` `manually` / `hourly` / `daily` / `weekly` / `monthly` with `period_days`, `rollover`, and `assignment_type` `no-assignment` / `who-least-did-first` / `random` / `in-alphabetical-order`; `POST /chores/{choreId}/execute` with `done_by`, `skipped`; undo per execution | The assignment modes and "skipped" as its own outcome | — |
| [Donetick](https://github.com/donetick/donetick) (2.8k stars, active) | Chores with rotation; a REST API plus an "eAPI" for long-lived tokens, webhooks, and an HA integration that creates a to-do list per user (README) | Per-person chore views | — |

**Take-aways:** one typed list capability with per-backend feature flags; shopping items have a name, a quantity and a
category; a task without a moment is a list item and a task with a moment is a reminder ([reminders](reminders.md)
§12); chores are recurring list items with an assignee and a log of who did them.

## 3. Example conversations

S = a screen helps, and it also works headless. **S!** = needs a screen.

| # | Situation | Exchange | Note |
|---|---|---|---|
| 1 | Add, several items | "Add milk, eggs and two litres of oat milk to the shopping list." → "Added milk, eggs and two litres of oat milk." | Split locally; "two litres" becomes the quantity. |
| 2 | Ambiguous split | "Put salt and pepper crisps on the list." → "Added salt and pepper crisps." | The catalogue knows the compound name, so it is not split into three items. Unknown compounds are split, and the echo lets the person say "no, one item". |
| 3 | Read, headless | "What's on the shopping list?" → "Nine things: milk, eggs, rice, and six more. Shall I go on, or put it on the kitchen screen?" | S: the checklist, grouped by category. |
| 4 | Complete | "I've got the bread." / "Take bread off the list." → "Bread's off the list." | "Got" completes (kept for a day, shown ticked); "take off" removes. |
| 5 | Duplicate | (milk is already on the list) "Add milk." → "Milk is already on the list." "Make it two." → "Two milk." | Duplicates merge (§6). |
| 6 | Personal to-do, ambiguous person | Kitchen device, no default person: "Add 'call the plumber' to my to-do list." → "Whose list: Ian's or Anna's, or the household's?" | "My" needs a person (shared state §4.6). On Ian's phone it goes straight to Ian's list. |
| 7 | Named list | "Start a packing list for camping: tent, sleeping bags, torch." → "New list 'Camping packing' with three items." | Generic list, household scope. |
| 8 | Chore status | "Whose turn is it to do the bins?" → "Sam's, tonight. Anna did them last week." | From the chore rotation and log. |
| 9 | Chore done | "I did the bins." (device default person Sam) → "Thanks, Sam. Next time is Anna's, Monday." | Logs `done_by`, computes the next due date and assignee. |
| 10 | Failure, provider down | (shopping list backed by Todoist) "Add coffee." → "Coffee's on the list. Todoist isn't answering, so I'll send it there as soon as it's back." | Local first, then outbox (§5). |
| 11 | Live across devices, S | Anna ticks items on her phone in the shop; the kitchen tablet's pinned list ticks along. Ian at home: "Add butter." → it appears on her phone a moment later. | `present.update` on every copy (presentation §6.3). |
| 12 | From another module | Kitchen books "I used the last of the rice." → the list shows "Rice, 1 kg (pantry: out)". Saying "add rice" later → "Rice is already on the list." | `Lists.addItem` with a `dedupeKey` (§12). |

## 4. Tools

All writes are typed actions, so each is a tool `<moduleId>_<action>` and an intent for the Jev path. The module has
two ids in one package, `lists` and `chores`, like `timers`/`alarms` ([timers](timers-and-alarms.md) §1). Latency on the
local store is a few indexed SQLite statements, expected under 20 ms; on a provider, a read comes from the local cache
(< 10 ms) and a write is optimistic locally, then one HTTP call (Todoist, Google, HA: 100–400 ms) in the background.
All are estimates, to be confirmed with `TurnTrace`.

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `lists_add` | `items: Param.text` (split locally into items with quantity), `list?: Param.dynamic` (names and aliases; default the shopping list for grocery words, else the household to-do), `note?`, `for?: dynamic` (person), `due?: text` | items added, merged or already present; the list's name | W | changes data | < 20 ms | **yes** |
| `lists_read` | `list?`, `show?: "open" \| "done" \| "all"`, `limit?: number`, `group?: boolean` (by category) | items in order, count, who added recent ones | R | safe | < 10 ms | yes (top 3 + "and N more") |
| `lists_complete` | `item: dynamic` (open items of the list), `list?` | ticked item | W | changes data | < 20 ms | yes |
| `lists_update` | `item`, `rename?`, `quantity?`, `note?`, `reopen?: boolean` | the item | W | changes data | < 20 ms | yes ("make it two") |
| `lists_remove` | `item`, `list?` | removed item | W | changes data | < 20 ms | yes |
| `lists_clear_done` | `list?` | count removed | W | changes data | < 20 ms | yes |
| `lists_overview` | — | lists with open counts, chores due today | R | safe | < 10 ms | yes |
| `lists_create` | `name`, `kind?: "shopping" \| "todo" \| "generic"`, `scope?: "household" \| "person"`, `items?` | the list | W | changes data | < 20 ms | yes |
| `lists_delete` | `list` | soft-deleted list (restorable for 30 days) | W | changes data | < 20 ms | no (model only) |
| `lists_undo` | — | the last change by this actor, reversed | W | changes data | < 20 ms | yes |
| `chores_status` | `chore?: dynamic`, `person?: dynamic`, `when?: "today" \| "week" \| "overdue"` | chores with assignee, due, last done by | R | safe | < 10 ms | yes ("whose turn…") |
| `chores_done` | `chore`, `by?: person` (default the device person), `skipped?: boolean` | next due and next assignee | W | changes data | < 20 ms | yes |
| `chores_add` | `name`, `every: text` ("every Monday", "every 3 days after done"), `assign?: people[]`, `mode?: "fixed" \| "rotate" \| "least-done-first"`, `starts?` | the chore with its next due date | W | changes data | < 20 ms | no |
| `chores_change` | `chore`, `every?`, `assign?`, `mode?`, `pause_until?` | the chore | W | changes data | < 20 ms | no |
| `chores_remove` | `chore` | removed chore | W | changes data | < 20 ms | no |

General assistants get `lists_add`, `lists_read`, `lists_complete`, `lists_remove`, `lists_overview`, `chores_status`
and `chores_done`; the rest stay for an assistant the owner chooses (or every assistant, at the cost of prompt
tokens, which is to be measured). Ambient facts carry `Shopping: 9 items. Chores today: bins (Sam).` (shared state §7).

**Service for other modules (Proposal).** Modules never go through the model to add an item:

```ts
// PROPOSAL — exported by the lists module, used by kitchen, reminders, routines
interface Lists {
  addItem(req: { list: { kind: "shopping" } | { id: string } | { name: string }; text: string
                 quantity?: { amount: number; unit?: string; said?: string }; note?: string
                 source: { module: string; ref?: string }; dedupeKey?: string }): Effect<ListItem, ListsError>
  completeByKey(dedupeKey: string): Effect<void, ListsError>
  removeByKey(dedupeKey: string): Effect<void, ListsError>
  find(list: { kind: "shopping" | "todo" } | { name: string }): Effect<ListInfo | undefined>
}
```

A second `addItem` with the same `dedupeKey` updates the open item instead of adding one (the notification service
uses the same rule, shared state §8.3); a completed one is reopened.

## 5. Integrate or build

**Recommendation: build the local store as the default, and treat each provider as the backend of a whole list, not as
a sync partner.** A list has exactly one backend (`local`, or one provider list); there is no two-way merge between our
store and a provider. Provider lists are cached locally for sub-10 ms reads and for screens, refreshed by push where the
provider has it, else by polling. Writes are applied to the cache at once and sent to the provider; a failure goes to an
outbox that is replayed in order (adds commute, completes are idempotent, renames are last-writer-wins). On refresh the
provider wins, except for operations still in the outbox. First provider: Home Assistant; then CalDAV, Todoist and
Google Tasks; the kitchen apps when the [kitchen](kitchen.md) module uses them.

Each backend implements one `ListBackend` interface with feature flags borrowed from HA (`create`, `update`, `delete`,
`move`, `dueDate`, `dueDateTime`, `description`, `quantity`, `assignee`, `recurrence`, `push`). Tools refuse what a
backend cannot do, in words: "Google Tasks can't hold a time of day, so I've set it for Friday without a time."

| Backend | API (verified unless marked) | Flags it can set | Freshness | Notes |
|---|---|---|---|---|
| **Local** (Module store) | `m_lists__*` tables (§6) | all | instant | The default. Holds quantity and category, which providers often lack. |
| **Home Assistant `todo`** | Through the existing `home-assistant` module's URL and token (later its Connection): `POST /api/services/todo/add_item` (`entity_id`, `item`, `due_date` or `due_datetime`, `description`), `todo.update_item` (`item`, `rename`, `status`), `todo.remove_item`, `todo.remove_completed_items`; reads via `todo.get_items` with a service response **[REST `?return_response` form unverified]**; live updates over the WebSocket API with `todo/item/subscribe`, plus `todo/item/list` and `todo/item/move` (in [`todo/__init__.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/todo/__init__.py)) | per entity, from its `supported_features` | push | One adapter reaches `local_todo`, `shopping_list`, Bring, Todoist, Google Tasks, CalDAV, Mealie, Donetick and more. Costs one hop through HA. |
| **CalDAV VTODO** (Nextcloud Tasks, Radicale, Baïkal, Fastmail) | `tsdav` 2.5.1 (npm): `fetchCalendars` (filter components `VTODO`), `fetchCalendarObjects`, `createCalendarObject`, `updateCalendarObject` with the ETag; parse with `ical.js` 2.2.1. VTODO ([RFC 5545](https://www.rfc-editor.org/rfc/rfc5545)) `SUMMARY`, `STATUS` (`NEEDS-ACTION`, `COMPLETED`, `IN-PROCESS`, `CANCELLED`), `DUE`, `COMPLETED`, `PRIORITY`, `CATEGORIES`, `RELATED-TO`, `RRULE` | due, description, categories, recurrence | poll with `sync-collection` (RFC 6578) or the CTag, every 60 s | Standard, self-hosted, covers chores' recurrence via `RRULE`. iCloud Reminders are no longer reachable over CalDAV since Apple's 2019 upgrade **[unverified]**. |
| **Todoist** | API v1 at `https://api.todoist.com/api/v1/` with `Authorization: Bearer`: `GET /tasks?project_id=`, `POST /tasks` (`content`, `description`, `project_id`, `section_id`, `labels`, `priority`, `assignee_id`, `due_string`, `due_lang`, `deadline_date`), `POST /tasks/{task_id}/close`, `/reopen`, `DELETE /tasks/{task_id}`, `GET /projects`, `GET /tasks/filter` ([OpenAPI](https://developer.todoist.com/openapi.json)); personal token or OAuth scope `data:read_write`; new OAuth apps get access tokens that expire after an hour plus refresh tokens ([docs](https://developer.todoist.com/api/v1/)) | due, recurrence (`due_string: "every monday"`), assignee (shared projects), description | poll 60 s; webhooks need an inbound route (current-system §9 gap 21) | Hosted: optional under the local-first rule. |
| **Google Tasks** | Through the `google` Connection ([google](google.md)), scope `https://www.googleapis.com/auth/tasks`: `GET https://tasks.googleapis.com/tasks/v1/users/@me/lists`, `GET/POST /tasks/v1/lists/{tasklist}/tasks`, `PATCH …/tasks/{task}` (`status: "completed"`), `DELETE`, `POST …/tasks/{task}/move`, `POST /tasks/v1/lists/{tasklist}/clear` | due **date only** (the API discards the time of day), notes; **no recurrence** in the API ([reference](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)) | poll 60 s | Personal lists of a member; not for chores. |
| **Mealie shopping lists** | `GET /api/households/shopping/lists`, `GET /api/households/shopping/items` (`queryFilter` on `shoppingListId`), `POST /api/households/shopping/items` (`shoppingListId`, `note`, `quantity`, `unitId`, `foodId`, `checked`), `PUT/DELETE /api/households/shopping/items/{item_id}`, `POST …/lists/{item_id}/recipe/{recipe_id}`; `extras` holds our id (Mealie v3.31.0) | quantity, unit, food | poll; event notifications exist | With the kitchen on Mealie. |
| **Grocy shopping list** | `GET/POST /objects/shopping_list` (free text in `note`, or `product_id` + `amount`), `POST /stock/shoppinglist/add-product`, `/remove-product`, `/clear`; `GET /system/db-changed-time` for cheap polling (Grocy v4.7.1) | quantity (per product) | poll | Also the chores backend: `GET /chores`, `POST /chores/{choreId}/execute`. |
| **KitchenOwl** | `GET /api/household/{id}/shoppinglist`, `GET /api/shoppinglist/{id}/items`, `POST /api/shoppinglist/{id}/add-item-by-name` (`name`, `description`), `DELETE /api/shoppinglist/{id}/item`; long-lived token from `POST /api/auth/llt`; Socket.IO event `shoppinglist_item:add` (v0.8.1 source) | description | push (Socket.IO) | Good family phone app for shopping. |
| **Tandoor shopping** | `GET/POST /api/shopping-list-entry/` (`food`, `unit`, `amount`, `checked`), `PATCH /api/shopping-list-entry/{id}/`, `POST /api/shopping-list-entry/bulk/` (Tandoor 2.7.3) | quantity, unit | poll | Needs a Tandoor `food` per entry. |
| Donetick, Vikunja, Microsoft To Do, Bring | Donetick REST/eAPI and webhooks **[endpoints unverified]**; Vikunja REST with `tk_` tokens **[unverified]**; Microsoft Graph `/me/todo/lists/{id}/tasks` **[from memory]**; Bring only through HA | — | — | Later, or through Home Assistant. |

**Chores: build, with Grocy or Donetick as optional backends.** A chore is small (a recurrence, an assignment mode, a
log). Owning it keeps "whose turn" on the fast path and lets chores ride the shared Scheduler and Notification service.
Todoist (`due_string` recurrence plus `assignee_id`) and CalDAV (`RRULE`) can back a chore list where the household
already lives there, but neither knows rotation, so rotation stays ours and only the next instance is written out.

## 6. Data

Module-owned SQL (shared state §4.4), **household** scope unless stated.

| Table | Key fields | Notes |
|---|---|---|
| `m_lists__lists` | `id`, `name`, `aliases[]` ("boodschappen", "groceries"), `kind` (`shopping`, `todo`, `generic`, `chores`), `scope` (`household` or `person` + `person_id`), `backend` (`{ provider: "local" }` or `{ provider, connection_id, remote_id }`), `default_for?` (`shopping`, `todo`), `sort` (`manual`, `category`, `due`), `deleted_at?` | One default shopping list and one household to-do list exist from the start. |
| `m_lists__items` | `id`, `list_id`, `text`, `norm` (lower case, singular, for matching), `quantity?` (`amount`, `unit`, `said`), `note?`, `category?`, `status` (`open`, `done`), `due?`, `assignee?`, `position`, `source?` (`{ module, ref }`), `dedupe_key?`, `remote_id?`, `etag?`, `created_by`, `done_by?`, `done_at?` | `created_by`/`done_by` are `Actor`s (shared state §4.5). |
| `m_lists__catalogue` | `norm`, `display`, `category`, `uses`, `last_used`, `compound` (do not split) | Seeded with about 300 common grocery words in English and Dutch; learns from use. Gives categories and "recent items". |
| `m_lists__chores` | `id`, `list_id`, `name`, `recurrence` (`{ kind: "fixed", cron, tz }` via Effect `Cron`, or `{ kind: "after-done", days }`), `assignment` (`{ mode: "fixed" \| "rotate" \| "least-done-first", people[], next }`), `due_at`, `paused_until?`, `remote_ref?` | `after-done` is Grocy's floating schedule. |
| `m_lists__chore_log` | `chore_id`, `at`, `done_by`, `skipped`, `undone?` | Kept forever (small); feeds "Anna did them last week" and least-done-first. |
| `m_lists__outbox` | `op_id`, `list_id`, `op`, `payload`, `attempts`, `next_try_at` | Only for provider-backed lists. |
| `pinned_list` (collection, **device** scope) | `list_id`, `show_on_ambient` | Which list a kitchen display keeps pinned. |

**Merging and normalising.** "Two litres of oat milk" is parsed locally (extended `ValueParsing`, as in
[kitchen](kitchen.md) §6) into text "oat milk" and quantity 2 l. An add whose `norm` matches an open item on the same
list merges: equal units add up ("milk" + "milk" = "2 milk"); otherwise the new words go into the note. A match on a
done item reopens it. Matching tolerates plurals and the catalogue's aliases.

**Exports** (read-only views, shared state §4.4): `lists.shopping` (open items), `lists.counts`, `chores.today` (for a
briefing module).

## 7. Long-running work and events

| Job (Scheduler, shared state §6) | When | Does | Missed while down |
|---|---|---|---|
| `chore-due` | one per chore at `due_at` (`reminder` kind) | marks it due, emits `chores.due`, notifies per §9 | fire late, marked overdue |
| `chores-digest` | daily, default 07:30 (`recurring`) | one line per person: today's chores | run once if before noon, else skip |
| `provider-refresh` | every 60 s per polled list; push lists reconnect with backoff | refreshes the cache, emits `lists.item.*` for remote changes | resumes |
| `outbox-replay` | every 30 s while not empty, with backoff | replays provider writes in order | resumes |
| `done-cleanup` | nightly | removes shopping items done more than 24 h ago and to-dos done more than 30 days ago (settings) | run once |

**Publishes:** `lists.item.added`, `lists.item.changed`, `lists.item.completed`, `lists.item.removed` (each with list,
item, actor, `source` and `dedupeKey`), `lists.list.created`, `lists.list.deleted`, `chores.due`, `chores.done`,
`chores.overdue`. The [kitchen](kitchen.md) listens to `lists.item.completed` for its own items. **Listens to:** provider
push (HA WebSocket, KitchenOwl Socket.IO) and person-registry changes (rotations drop a removed person). **Restart:**
lists, the log and the outbox are in SQLite; chore jobs fire at their wall-clock time or late as overdue; push
subscriptions reconnect and do one full refresh.

## 8. Presentation

| Moment | Kind (presentation §3.2) | Layout (presentation §4.1) | Lifetime |
|---|---|---|---|
| "What's on the shopping list?" | `list`, `style: "checklist"`, grouped by category when `sort: category`, `secondary` = quantity and note | Presenter | task while the conversation is on it |
| Pinned shopping list on a kitchen display | the same `list` | Ambient (glanceable when idle) | pinned |
| List of lists | `list` with counts, `pick: true` | Presenter | glance |
| Chores this week | `table` (chore, who, when), or `list` on a compact display | Presenter | glance |
| A single add | none: the spoken echo is enough; a pinned list updates in place | — | — |

The checklist is server-owned state: every copy on every device gets `present.update` when an item changes, wherever
it changed (another device, a provider push, the kitchen module), as presentation §6.3 says for "a checklist's ticks".
**A tick on a checklist row should call `lists_complete` directly**, as a `PresentationAction` with `do: "tool"`
(presentation §3.3), not become a typed turn through the model (presentation §4.3): ticking ten items in a shop must
not cost ten model turns. The character glances at the ticked row (`stage.content.attention`) and otherwise stays out
of the way. On a phone in the shop, the voice page shows the same list; ticks made without a connection should queue in
the page and replay on reconnect (a new, small client feature). **Without a screen:** read the count, the top three and
"and N more"; offer the next three or the best screen (presentation §6.2); read grouped by category when asked "read it
by aisle".

## 9. Notifications and proactive behaviour

| What | Priority (shared state §8.2) | Where | Example |
|---|---|---|---|
| Chore due today | `normal`, in the morning digest or at `due_at` for timed chores | the assignee's default devices, else their phone | "Sam, the bins go out tonight." |
| Chore overdue by a day | `low` | inbox, badge | "The plants weren't watered yesterday." |
| Items added by someone else or by a module | none spoken; the pinned list updates; kitchen batches its own `low` note | — | — |
| Provider unreachable for more than 15 minutes | `low` to admin | admin inbox | "Todoist hasn't answered since 14:05; 3 changes are waiting." |

Never during quiet hours, never nagging: a chore is announced at most once a day. "Remind me to buy milk when I'm at
the supermarket" stays a list item with the honest answer from [reminders](reminders.md) §12.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | members (for "my" lists and chores), the default shopping and to-do list, list aliases, quiet hours (shared) | from the household foundation; "Shopping", "To do" |
| Module (`lists`) | backend per list (local or a provider list), split on "and" (`catalogue-aware` \| `always` \| `never`), merge duplicates, category sorting, done cleanup (24 h shopping, 30 days to-do) | local, `catalogue-aware`, on, on |
| Module (`chores`) | digest time, overdue notice, rotation fairness (`least-done-first` counts skips or not) | 07:30, on, skips count as done |
| Assistant | which tools (`offTools`), may write to person lists other than the device person's | general set above; no |
| Device | pinned list and `show_on_ambient`, default person (shared state §4.6) | none |
| Person | own to-do list backend (their Todoist, Google Tasks or CalDAV), chore notifications on devices or phone | household to-do list, devices |
| Connections (module definition §B.4) | `home-assistant` (today the HA module's URL and token), `caldav` (URL, user, app password), `todoist` (personal token or OAuth), `google` (from [google](google.md)), `mealie`, `grocy`, `kitchenowl`, `tandoor` (shared with [kitchen](kitchen.md)), `donetick` | none |

**First-run setup:** the module creates the shopping list and the household to-do list, local; the owner can point
either at a provider list (Admin › Modules › Lists › "Use an existing list", which lists HA to-do entities, CalDAV
calendars with VTODO, Todoist projects, …). Chores start empty; the owner adds the first few by voice or in admin, with
the household members as the rotation.

## 11. Native tools and dependencies

| Dependency | Where | Needed for | When missing, the assistant says |
|---|---|---|---|
| Module store (SQLite) | server | everything | module `unavailable`: "Lists aren't set up yet." |
| `tsdav`, `ical.js` (npm, pure JS) | server, inside a `lists-caldav` adapter package | CalDAV | — (bundled) |
| A provider service or account | LAN or internet | that list | Write: "Coffee's on the list. Todoist isn't answering, so I'll send it there as soon as it's back." Read: "Here's the list as of five minutes ago; Home Assistant isn't answering." |
| Internet | server | Todoist, Google Tasks | as above |

No provider SDK is used; adapters speak HTTP with `fetch`, and each lives in its own package per the repository rule
(provider code only inside its adapter). `rrule` 2.8.1 was last published in 2023, so `RRULE` handling should use
`ical.js`'s recurrence support **[ical.js recurrence API not checked]**.

## 12. Interaction with the rest of the system

| Topic | Behaviour |
|---|---|
| Splitting and echo | Items are split on "and" and commas unless the catalogue knows the compound ("salt and pepper crisps", "mac and cheese"). The echo repeats the items as stored, so "flower" for "flour" or a split mistake is heard; "no, one item" or "undo" fixes it. |
| Quantities and Dutch | Quantities parse locally ("two litres", "een pak", "twee"). Dutch phrasing: "zet melk op de boodschappenlijst", "haal brood van de lijst", "wat staat er op de lijst". List names and aliases are matched like wake phrases. |
| Intent path | `lists_add`, `lists_read`, `lists_complete`, `chores_status` and `chores_done` carry `examples` and run on Jev without a model; this is the module where a deterministic path matters most (landscape-voice-assistants §16, first mistake). |
| Which list | Grocery words or "the list" in a kitchen context → the default shopping list; "my to-do" → the device person's list; a named list wins when named. Bare "add X" on any device → shopping list if X is in the grocery catalogue, else the household to-do, and the reply names the list. |
| Fillers | None; everything is local or cached. |
| Agents and assistants | No template of its own. Every general assistant gets the general set; Chef ([kitchen](kitchen.md)) gets the shopping list; a children's assistant gets add and read on the shopping list and its own chores, but no delete. |
| Other modules | [kitchen](kitchen.md) adds low-stock items through `Lists.addItem` with `dedupeKey: "kitchen:product:<id>"` and listens to completions. [reminders](reminders.md) hands over tasks without a moment. [google](google.md) provides Google Tasks. A briefing reads `chores.today` and the shopping count. `home-assistant` is the first provider. |

## 13. Privacy and safety

| Concern | Rule |
|---|---|
| Personal lists | Person-scoped lists are read aloud and shown only on that person's devices and in admin; shared screens show household lists only. On a device without a default person, "my list" asks whose. |
| Destructive actions without confirmation | Core confirmation is off (current-system §2.5). "Clear the list" removes only done items; "delete the camping list" is a soft delete restorable for 30 days; every change has `lists_undo` and is in the change log (shared state §4.2). |
| Guests and children | Anyone may add to the shopping list and tick items; deleting lists and changing chores is for adults' assistants only (a per-assistant `offTools` choice). A child can mark only their own chores done. |
| Provider tokens | In the vault, per Connection; a member's Todoist or Google account is that member's connection and only their person lists use it. |
| Who did it | `created_by` and `done_by` are shown in admin and on screens ("added by Anna"); a chore rotation is not a surveillance tool, so the log is not read out unprompted. |

## 14. Foundations needed

| Foundation | Used for |
|---|---|
| Module store | lists, items, catalogue, chores, log, outbox |
| Tool context | "my" lists, `created_by`/`done_by`, the device's pinned list |
| Event bus | live updates to screens, `lists.item.completed` for kitchen, `chores.due` |
| Scheduler | chore due times, digest, polling, outbox, cleanup |
| Presentation, Device capabilities | the `list` checklist with `present.update` and direct tick actions; pinned lists on kitchen displays |
| Notification service | chores due and overdue |
| Connection, Module manifest | provider accounts; a way to export the `Lists` service to other modules (today `exports` are read-only views, shared state §4.4) |

**A useful first version without most of them:** the local store on a SQLite file under `data/modules/lists/`, the
`lists_*` tools and intents, one default shopping list and one to-do list, spoken answers only, and the Home Assistant
provider through the existing HA module's URL and token. Chores, live screens and person lists come with the
foundations.

## 15. Open questions

1. **Which list apps does the household already use?** If the family lives in Bring, Todoist or Google Tasks on their
   phones, those lists should be the backend (via HA or directly) and our store only a cache; otherwise the local store
   plus the voice page on phones is simpler and fully local.
2. **Checklist ticks: direct or through the model?** This document proposes direct tool actions for checklist rows,
   which **differs from presentation §4.3** (taps become typed turns). Is a tick that bypasses the model acceptable?
3. **How kitchen adds items: direct service call or event?** Shared state §5 has the shopping list *subscribe* to
   `pantry.stock.low`. This document **disagrees**: the kitchen calls `Lists.addItem` with a `dedupeKey`, because only
   the kitchen knows the amount, the package size and when to withdraw the item, and the lists module stays generic.
   That needs a module-to-module service, which the manifest does not define yet.
4. **Chores: who lives in the house, and how should turns rotate** (fixed, in order, least-done-first)? Do skips count?
   Are points or rewards wanted (Donetick has them), or just "whose turn"?
5. **Personal to-do lists now, or household lists only** until people and device-default persons exist?
6. **Done items:** keep ticked shopping items visible for a day (Bring style) or remove at once?
7. **Splitting on "and":** catalogue-aware splitting (recommended) or always one item per utterance?
8. **Hosted providers** (Todoist, Google Tasks) are optional under the local-first rule; is a cached copy of a hosted
   list on our server acceptable, and should outbox writes be retried indefinitely or dropped after a day?
