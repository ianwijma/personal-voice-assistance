# Modules: implementation plan for tiers 1 and 2

Written 2026-11-18 against `main` at `548f5d2`. It turns the research in
[`research/modules/`](research/modules/README.md) and
[`research/module-investigation/`](research/module-investigation/investigation.md) into work: a stack of preparation
PRs that build the shared foundations, then one PR per module for the 23 modules the
[ranking](research/modules/README.md#ranking) puts in tier 1 and tier 2.

This document is the brief every implementer and reviewer works from. Where it and a research document disagree, this
document wins; where it is silent, the research document's own recommendation applies.

## 1. Shape of the work

1. **Preparation stack** (§4): twelve PRs, each based on the one before it. They add what a module cannot build for
   itself: tool context, the module API, storage, scheduling, notifications, presentation, connections and so on.
2. **Module PRs** (§5): one PR per module, all based on the top of the preparation stack and written in parallel.
   A module PR changes only its own package (§3.2), so the 23 PRs do not conflict with each other.
3. **Review** (§6): every PR is reviewed by GPT-6.1 Sol and fixed by Opus or Sonnet until a review comes back clean,
   for at most five rounds, or ten when real problems are still being found.

Nothing is merged into `main` by this work. The owner merges.

## 2. Decisions this plan assumes

The research left these to the owner. The plan takes the recommendation recorded in
[investigation §11 and §12](research/module-investigation/investigation.md#11-disagreements-between-documents) in each
case, so that work can start. Each is cheap to change before the PR that builds it is merged.

| # | Question | Assumed answer |
|---|---|---|
| 1 | People | `Person` records live in a household settings section ("Members"). Each device has an optional default person. No voice identification. Data without a known person is household data. |
| 2 | Module boundaries | Rows g–n and 36–38 of investigation §11 are accepted: the announce tool lives in broadcast; feeds and watchers in news-and-feeds; `who_is_home` and presence events in presence-and-people; podcasts, cameras and energy are out of music and smart-home; the n8n and HA-script bridge is out of routines. |
| 3 | Rooms | A room is a free-text field on each device (`place.room`). The Home Assistant module maps rooms to HA areas by name, with aliases. |
| 4 | Speech without the wake phrase | Allowed for a closed set of control phrases ("stop", "never mind", "louder", "quieter", "repeat", "snooze", "five more minutes") while the device is audible or ringing. Per-device setting, default on. Everything else needs the wake phrase or an open follow-up window. |
| 5 | Risk | Classes `read / change / message / money / security`. Household default `{ read: allow, change: allow, message: confirm, money: deny, security: deny }`. Lower layers can only narrow. `money` and `security` also need a device marked trusted; no device is trusted by default. Core confirmation is switched on. |
| 6 | Storage | One SQLite file, `data/household.db`, through `node:sqlite`. Per-module tables and migrations inside it. |
| 7 | Recurrence | What a person says ("every second Tuesday") is stored as an RFC 5545 `RRULE`; system jobs use `Cron`. One recurrence helper for every module. |
| 8 | Names | `CurrentTurn` (not `CurrentTurnDevice`); timers carry `dueAt`; an event is named by the module that emits it (`kitchen.stock.low`, `presence.arrived`). |
| 9 | Presentation | Own `present.*` messages, not a field on `tool.end`. Tools are always offered; the server decides whether something can be shown and tells the model what happened. A tap on a checklist item calls the tool directly. |
| 10 | Phone push, voice nodes, deployment | Out of scope here (§7). |

## 3. Rules for every PR

### 3.1 Project rules

- Read `docs/ARCHITECTURE.md` first. The service interfaces in it are the contract; a PR that adds or changes one
  updates that document in the same PR.
- Effect is **v4** (`effect@4.1.4`). Its API differs from v3. Use `node_modules/effect/AGENTS.md` and
  `node_modules/effect/ai-docs/src/**` as the reference, not memory.
- Provider SDKs are imported only inside their adapter package.
- Existing modules, assistants, saved settings and characters keep working. New manifest fields are optional, new
  protocol messages are additive, and a change that needs a protocol version bump says so and migrates saved data.
- A latency claim needs `TurnTrace` numbers. Nothing new may run on the turn path without a stated budget: a context
  provider has 50 ms, and a store read on that path must be an indexed single-row or small-range read.
- `pnpm check` and `pnpm test` must pass. CI runs both on every PR push.
- Heavy commands are queued behind one machine-wide lock, because several agents share this machine:
  `flock /workspace/build-cache/ian/pva-heavy.lock <command>`, with `VITEST_MAX_WORKERS=4`. Run the tests of the
  packages you changed and `pnpm check`; leave the full suite to CI. Do not run Playwright unless the PR's brief asks.
- Texts the assistant speaks are written in English and Dutch where the research document gives both, and are chosen
  by `HOME_LANGUAGE`.

### 3.2 What a module PR may touch

- Its own package under `packages/module-<id>/` (source, tests, `package.json`).
- Its row in `docs/MODULES.md` and its own section there.
- Nothing else. The scaffold PR (§4, P11) has already created the package, registered it in the catalogue, added its
  dependencies to the lockfile and defined the contracts it shares with other modules.
- If a module needs something from the core that the preparation stack does not provide, the implementer stops and
  reports it instead of editing shared files. Three module PRs are allowed a wider reach and say so in §5:
  core-tools and local-info extend the existing `clock` and `weather` modules in `packages/modules-builtin/`,
  smart-home rewrites `packages/module-home-assistant/`, and calls-and-intercom adds the call audio relay to the
  protocol, the server and the voice page.

### 3.3 What a module's first version is

Each module document's §14 names "a useful first version". That, adjusted by §5 below, is the scope. The rest of the
document is not built now. Every module:

- declares `apiVersion: 2`, `requires` and `health` where it depends on something outside the process, and a `risk`
  on every tool that is not a plain read;
- gives every tool result a `spoken` line or a result the model can word in one or two sentences, and a presentation
  where the document's §8 names one for the first version;
- offers its fast-path commands as typed actions with `examples` (and phrase commands where §5 says so), so they can
  run without the language model;
- is tested against fakes of every outside service, with no network in tests;
- writes its section in `docs/MODULES.md`: what it does, its tools, settings, what it stores, what it needs, and what
  was left out.

### 3.4 Git

- Branch names: `t3/modules-NN-<slug>` for the preparation stack, `t3/module-<id>` for modules.
- Agents work in their own worktree on a detached `HEAD` and push with an explicit refspec
  (`git push origin HEAD:<branch>`), because a branch can be checked out in only one worktree.
- No force pushes. A lower PR's fixes reach the PRs above it by merge commits.
- A PR description says what was built, what was left out, how it was tested, and carries a screenshot where
  something is visible.

## 4. The preparation stack

Order is the order of the stack. "With" names PRs written at the same time; they are then restacked in this order by
merge. Sizes are rough. The design for each PR is the named research section, with the decisions of §2.

| PR | Branch | What it adds | Design | Written with |
|---|---|---|---|---|
| P0 | `t3/modules-00-plan` | This document | – | – |
| P1 | `t3/modules-01-module-api` | Module API v2 and tool context | [module-definition A.4, C.3–C.5](research/module-investigation/module-definition-config-and-dependencies.md#a4-manifest-shape-proposal), [shared-state §4.5](research/module-investigation/shared-state-jobs-and-notifications.md#45-turn-context-proposal) | P2 |
| P2 | `t3/modules-02-helpers` | Language and network helpers | below | P1 |
| P3 | `t3/modules-03-forms-routes` | Extended settings fields and module HTTP routes | [current-system §6.2, §9 gaps 19 and 21](research/module-investigation/current-system.md#62-settings-schema-drives-the-ui-implemented) | P4, P5 |
| P4 | `t3/modules-04-people-rooms` | People, rooms and device capabilities | [presentation §5](research/module-investigation/presentation-and-device-capabilities.md#5-device-capabilities), [shared-state §4.6](research/module-investigation/shared-state-jobs-and-notifications.md#46-identity-who-said-it) | P3, P5 |
| P5 | `t3/modules-05-store-bus` | Household store and event bus | [shared-state §4, §5, §7](research/module-investigation/shared-state-jobs-and-notifications.md#4-the-shared-data-layer) | P3, P4 |
| P6 | `t3/modules-06-scheduler` | Scheduler | [shared-state §6](research/module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) | P7, P10 |
| P7 | `t3/modules-07-phrase-commands` | Phrase commands and device control | [assistant-controls §5](research/modules/assistant-controls.md#5-integrate-or-build) | P6, P10 |
| P8 | `t3/modules-08-notifications` | Notification service, announce, ringing | [shared-state §8](research/module-investigation/shared-state-jobs-and-notifications.md#8-notifications) | P9 |
| P9 | `t3/modules-09-presentation` | Presentation | [presentation §3, §4, §6](research/module-investigation/presentation-and-device-capabilities.md#3-presentation-what-a-tool-returns) | P8 |
| P10 | `t3/modules-10-connections-risk` | Connections, risk policy, confirmation | [module-definition B.4, B.5](research/module-investigation/module-definition-config-and-dependencies.md#b4-connections-and-oauth-on-a-headless-server) | P6, P7 |
| P11 | `t3/modules-11-scaffold` | Module packages, shared contracts, test kit, `docs/MODULES.md` | §5 of this document | – |

### P1. Module API v2 and tool context

- `defineModule` gains optional `apiVersion`, `version`, `requires`, `platforms`, `health`, `templates`. A module
  without `apiVersion` is version 1 and sees no change. `MODULE_API = { current: 2, supports: [1, 2] }`.
- `ModuleContext` gains a `host` member for version 2 modules. The later PRs add `store`, `events`, `scheduler`,
  `notify`, `present`, `connections` beside it; P1 defines where they go and how a version 1 module is shielded.
- `CurrentTurn`: a `Context.Reference` provided around every tool call and action run, in the core tool loop and in
  the Claude Code bridge. Fields: turn id, conversation id, assistant id, device id and name, room, person, source
  (`voice` or `text`). P1 fills what serve mode knows today; P4 fills room and person. Absent in CLI modes and jobs.
- `host`: a read-only view for modules (module states, vault locked or not, engine summary, connected devices), an
  action catalogue (list and run another running module's actions, for routines), `requestRestart(reason)` so a module
  whose tool list changed at run time (MCP) can be started again, and the module **services** registry: a module
  provides a typed service under a key and another module looks it up, getting `undefined` when the provider is off.
- Requirements: the `Requirement` type, one tool registry in the app with probes, probing at start and on "Check
  again", a new module state `unavailable` with a reason and a fix, and one instructions line per unavailable module
  so the assistant says "music is not set up on this server" instead of improvising.
- Health: `health()` returning issues; an issue registry; `pnpm start doctor` with the core checks and every module's
  requirements and health; an admin Health page.
- Tool metadata: optional `risk`, `sensitivity` (`normal` or `personal`) and `latency` on tools and actions, inferred
  when absent (`speculative: true` means `read`, else `change`). P1 only carries them; P10 enforces them.
- Templates: plain data on the manifest; the new-assistant wizard offers them.
- Protocol: `ModuleState` gains `unavailable`; version bump.

### P2. Language and network helpers

Two new packages with no dependency on the rest of the stack, plus household settings several modules read.

- `packages/language` (`@pva/language`), English and Dutch:
  - parsing: time of day ("half acht" is 7:30, "half seven" is 6:30, "kwart voor zeven"), dates and date-times
    ("tomorrow at five", "next Friday" reported as ambiguous), durations (re-exporting core's), quantities with units
    (mass, volume, pieces, "about", "a handful") for lists and the kitchen;
  - speaking: numbers, amounts with units, durations, clock times, dates and relative days, lists ("a, b and two
    more"), so every module words these the same way;
  - recurrence: build and read an `RRULE` with `DTSTART` in the home time zone, and compute the next occurrence.
- `packages/net` (`@pva/net`): `safeFetch` (refuses private, loopback and link-local addresses after DNS resolution
  and on every redirect, size and time limits, an owner switch for LAN targets), a small cached JSON fetch with
  ETag support, and the outgoing `User-Agent` built from the household API contact.
- Home section: `currency`, cup size, API contact for `User-Agent` headers. `HOME_UNITS` exists.

### P3. Extended settings fields and module HTTP routes

- The field types `textList`, `records`, `combo`, `action` and `info` exist in core and in the protocol but do not
  reach module forms. P3 puts them on the wire form, renders them in admin, stores them, and wires `fieldActions`
  (the "Test" button) and `settingOptions`.
- Module HTTP routes: a module may contribute routes under `/api/modules/<id>/…` with a declared guard (admin
  session, bearer token from the vault, LAN only), a body limit and a rate limit. Used by inbound notification hooks
  and OAuth callbacks.

### P4. People, rooms and device capabilities

- `hello.device.capabilities` (`DeviceCapabilities`: display class and size, touch, renderable kinds, speaker,
  microphone) declared by the voice page, kept per device, updated live.
- Two device settings sections: `place` (room, privacy `private | shared | public`, always on, accepts from others,
  quiet room, kids, trusted, default person) and `capabilities` (overrides that can only remove).
- Household section "Members": `Person` records (id, name, aliases, pronunciation, adult or child, default devices).
- `CurrentTurn.room` and `.person` (`how: "device-default"`); a `People` service for modules.
- One line in the per-turn context: this device, its room and what it can do, and the other screens in the house.
- Admin: Members, and "What it can do" and the place fields on a device. Protocol bump for the new sections.

### P5. Household store and event bus

- `packages/store-sqlite` implementing a core `HouseholdStore` on `@effect/sql-sqlite-node`: WAL, one writer,
  migrations, a pre-migration backup, a daily backup with `backup()`, export per module.
- `ctx.store`: document collections (`defineCollection` with scope, schema, version, lazy migration, `ambient`
  lines) and module-owned SQL tables prefixed `m_<moduleId>__` with their own migrations, including FTS5.
- Scopes household, person, assistant, device, conversation, derived from `CurrentTurn` or given explicitly.
- A change log written in the same transaction as every write; undo of the last change by an actor.
- Event bus: one in-process `PubSub`; `ctx.events.publish` and `subscribe`; host events (turn ended, device
  connected or disconnected, module state changed); `household.event` and a snapshot to voice pages, filtered by
  audience, with replay from the change log on reconnect.
- Ambient facts: a host context provider that assembles collections' `ambient` lines within the 50 ms budget, capped
  at 600 characters, behind a household switch. Measured with `TurnTrace` on and off.

### P6. Scheduler

- `ctx.scheduler` as in shared-state §6.2: `schedule` (at, in, cron), `handle`, `pause`, `resume`, `reschedule`,
  `cancel`, `list`, `runTask`. A `jobs` table, one fiber sleeping until the earliest due time, a claim in a
  transaction, wall-clock due times, a re-check on clock jumps.
- Missed-while-down policies `fire-late`, `{ fireIfWithinMs }`, `skip`, `inbox`, and "run the last missed occurrence
  once" for recurring jobs.
- `{ notify }` jobs are accepted and stored in P6 and delivered once P8 exists; until then they log.
- Admin: a list of scheduled jobs with cancel.

### P7. Phrase commands and device control

The fast path the basics need: commands that run without the language model.

- A new module contribution, **phrase commands**: a closed set of phrases per language with optional typed slots
  (the existing `Param` kinds), a `when` (`after-wake`, `while-audible`, `while-ringing`, or a named window a module
  opens for some seconds on a device), and a handler that returns an optional spoken line or earcon.
- The matcher sits in the voice session after the route gate and before the dispatcher, reuses the wake-phrase
  matcher (`exact` or `close`), and sees recogniser events before the echo gate, so a single "stop" during playback
  is not dropped by the two-word rule. The false-stop rate from the assistant's own voice is measured before the
  window is on by default.
- Windows: modules open and close a named window on a device (`ringing`, `follow-up:<id>`, `call`). While a
  `phrase-only` window is open the device answers only to a wake phrase.
- Typed actions before the model: per assistant, an opt-in switch that tries the offline keyword decider over the
  assistant's actions and runs a confident, complete match without a model call. Off by default; the measurements
  that decide the default are part of the PR.
- Device control: `output.volume`, `mic.set` and `device.state` messages, a gain node on the reply output of the
  voice page, canned replies and earcons through `Say`, and a `DeviceControl` service for modules.

### P8. Notification service, announce, ringing

- `ctx.notify` as in shared-state §8.1: `send`, `update`, `resolve`, `inbox`. A `notifications` table.
- Priorities and what each may do, audiences, ring policies (`origin`, `origin-then-room`, `everywhere`), one
  decision per notification, dedupe keys, quiet hours and do-not-disturb in one table of effects, expiry.
- `Announce`: a conversation input that waits for the current clause or reply, plays a cue and a line, and can be
  recorded in the conversation. Delivery by device, not by session.
- Ringing: `notification.ring` and `notification.resolved` messages; the voice page loops a local cue, shows a card
  with Stop, Snooze and +5 minutes, and shows a badge for what was missed.
- The ringing window and the follow-up window, registered through P7's windows.
- Household settings: quiet hours. Admin: the inbox.

### P9. Presentation

- `packages/protocol/src/presentation.ts`: the kinds `text`, `card`, `facts`, `list` (bullets, numbered, checklist,
  pick), `table`, `image`, `gallery`, `timer`, `progress`, `weather`, `confirm`, `handoff`, each versioned, with
  `fallback`, `spoken`, `lifetime`, `sensitivity` and actions. `steps`, `map`, `chart` and `media` come later.
- `ToolOutput { forModel, present }`: the registry splits it and appends a note for the model ("shown on Kitchen
  tablet", "not shown: no display").
- The Presenter per session: capability-based degradation, the reveal rule (`reveal { turnId, clause }`), lifetimes,
  one transient at a time, pinned presentations restored on reconnect, `present.show / update / dismiss` and
  `present.action / dismissed / status`.
- `/media/<hash>`: the server fetches an image once through `safeFetch`, checks type and size, resizes with `sharp`,
  serves it with dimensions and a placeholder, and evicts it after a day.
- Built-in tools `show` and `show_on`, and the three stable instructions for the system prompt.
- The voice page: one renderer per kind, and the stage layouts that move and shrink the character's box. Every
  existing character keeps working unchanged (`docs/CHARACTERS.md`).

### P10. Connections, risk policy, confirmation

- Connection types (declared by modules) and connection records in settings, credentials in the vault, owned by the
  household or a person, with a status (`ok`, `locked`, `needs-reauth`) and a test call.
- Flows: authorization code with PKCE and a loopback redirect with "paste the address you ended on", the device
  authorization grant, a redirect to the server's own HTTPS name when there is one, and OAuth for an MCP resource
  server (discovery, dynamic client registration). Single-flight refresh; rotated refresh tokens saved at once.
- `ctx.connections`: resolve a connection for the turn (speaking person, device default person, household).
- Risk policy: the household ceiling, narrowed by assistant and device; `deny` leaves the tool out of the turn;
  `money` and `security` need a trusted device; `personal` results are withheld on shared and public devices.
- Confirmation switched on: `confirmActions` stops being the literal `"off"`; `confirm`-class tools ask through
  core's existing spoken confirmation and the `confirm` presentation.
- Admin: Connections, the risk policy, the trusted switch on a device.

### P11. Module scaffold

- One package per module in §5 with a `defineModule` stub that is off by default, registered in the catalogue, with
  the dependencies §5 names already in `package.json` and the lockfile.
- `packages/module-contracts` (`@pva/module-contracts`): the typed service keys and interfaces modules share (§5.2).
- A module test kit in `@pva/core/testing`: an in-memory store, a scheduler on a test clock, a notification
  recorder, a presentation recorder, a `CurrentTurn` builder, a fake connection.
- `docs/MODULES.md`: how to write a module against API v2, and one section per module to be filled by its PR.

## 5. The modules

### 5.1 One PR each

"Model" is who writes it: Opus for open-ended work, Sonnet where the first version is well defined. All are based on
P11. Wave B starts when the module it waits for is written.

| # | Module | Package (module ids) | First version | Left for later | Model |
|---|---|---|---|---|---|
| 1 | [assistant-controls](research/modules/assistant-controls.md) | `module-assistant-controls` | Phrase commands and tools for stop, never mind, repeat, new conversation, switch assistant, sleep and wake up, louder, quieter, set volume, mute the microphone. The "what stop stops" order: ringing, then the reply, then media. | `show_on` (it is in P9), hand-off, find my phone, speech rate | Opus |
| 2 | [timers-and-alarms](research/modules/timers-and-alarms.md) | `module-timers` (`timers`, `alarms`) | Named timers and alarms as household data: start, list, adjust, pause, resume, cancel; alarms once and repeating; ringing through P8 with stop, snooze and +5 minutes; the `timer` presentation pinned; ambient facts; HA's matching rules; phrase commands for set, ask and stop. | Phone, escalation, node-local copies, sunrise, music alarms | Opus |
| 3 | [core-tools](research/modules/core-tools.md) | `module-core-tools` (`calculator`, `knowledge`, `system`), and `clock` in `modules-builtin` | `calculate` with units and currency, the extended `current_time`, `lookup` (Wikipedia, Wikidata, Wiktionary), `random`, `system_status` on P1's host view. | `translate`, crypto, SPARQL | Sonnet |
| 4 | [web-search](research/modules/web-search.md) | `module-web-search` | `web_search` with SearXNG and Brave behind a `SearchProvider` interface, `read_page` on `safeFetch`, a usage counter and caps in the store, `search_sources` with a `list`. | `research`, more providers, provider-native search | Sonnet |
| 5 | [lists](research/modules/lists.md) | `module-lists` | Local store, the ten `lists_*` tools, a default shopping and to-do list, splitting on "and", quantities, duplicate merge, undo, the `Lists` service, the checklist presentation with direct ticks, phrase commands for add and read. | Chores, person lists, every outside provider, the outbox | Opus |
| 6 | [notifications](research/modules/notifications.md) | `module-notifications` | The spoken side of P8: `notifications_read` and dismiss, do-not-disturb by voice with an end time, "send a test", one inbound `notify` hook on P3's routes with a token and a rate limit. | Phone channels, escalation, hooks from outside the LAN | Sonnet |
| 7 | [kitchen](research/modules/kitchen.md) | `module-kitchen` | Slice 1 and the stored-recipe part of slice 2: the pantry ledger with approximate amounts and undo, product settings, low stock into the shopping list through `Lists`, recipes entered by voice or admin, `kitchen_what_can_i_make` with a time limit, scaling. | URL import, guided cooking, meal plan, Chef template with hands-free "next", outside providers, barcodes | Opus |
| 8 | [music](research/modules/music.md) | `module-music` | Route 1 only, over the `HomeAssistant` service: play (artist, album, playlist, radio through Music Assistant), pause, resume, next, previous, volume, what is playing, per room, with the room from `CurrentTurn`; phrase commands for transport. | Playback in the browser or on nodes, Spotify direct, ducking, the media guard, the `media` kind | Opus |
| 9 | [smart-home](research/modules/smart-home.md) | `module-home-assistant` (existing) | The WebSocket entity cache with registries and HA's exposure list; typed actions for lights, switches, scenes, scripts, climate, covers, lock status and lock; `media_player`; "here" from `CurrentTurn.room`; the `HomeAssistant` service for other modules; a connection instead of module secret fields, with the old fields still read. | Unlock and disarm until trusted devices are in use, watches, doorbell and leak notifications, cameras, energy, MCP long tail | Opus |
| 10 | [reminders](research/modules/reminders.md) | `module-reminders` | Time and repeating reminders, household and person scope, `RRULE` storage with one job for the next occurrence, delivery where set, done and snooze in the follow-up window, the `card` and `list` presentations, `reminders.upcoming`. | Presence and event reminders, "remind Sam", nag, CalDAV | Sonnet |
| 11 | [images-and-photos](research/modules/images-and-photos.md) | `module-images` | `image_find` over Wikipedia and Commons with credit, `gallery` with pick for ambiguous words, the three-part reply on a device without a screen. | Other sources, generation, Immich, photo frame, cameras | Sonnet |
| 12 | [calendar](research/modules/calendar.md) | `module-calendar` | The `CalendarProvider` registry with ICS and CalDAV providers, a cache refreshed by a job, `calendar_agenda`, `_next`, `_find`, `_free`, `_add` with undo, `calendar.window` for briefing, an ambient line. | Change and delete, reminders from events, Microsoft, HA calendars | Opus |
| 13 | [memory-and-notes](research/modules/memory-and-notes.md) | `module-memory` | `remember`, `recall`, `forget`, `note`, `read_notes` on the store with FTS5 (falling back to `LIKE`), household and person scope, pinned memories in the per-turn context within 800 characters, secrets withheld on shared devices. | Sync to Obsidian or Nextcloud, embeddings, audio | Sonnet |
| 14 | [google](research/modules/google.md) | `module-google` | The `google` connection type on P10's loopback-and-paste flow with the owner's own client id, read-only: `mail_overview`, `mail_search`, `mail_read`; the Google `CalendarProvider`; the `Mail` service for briefing. A hand-written fetch client. | Send, drafts, contacts, Drive, Tasks, the mail cache and sync job | Opus |
| 15 | [t3-code](research/modules/t3-code.md) | `module-t3-code` (wave B, after 22) | Read-only over T3's `/mcp` on the MCP module's client and P10's MCP OAuth: `t3_overview`, `t3_thread_status`, `t3_pull_requests`, `t3_projects`; a context line; the coding template. | Draft and send, stop, answer, watches, CI status | Sonnet |
| 16 | [broadcast](research/modules/broadcast.md) | `module-broadcast` | `broadcast_send` to everyone or a room in the assistant's voice with a chime, a 30-second reply window, `broadcast_chime`, the origin excluded, bedrooms skipped in quiet hours, a `card` on screens. | The speaker's own voice, voice messages, schedules, phones | Sonnet |
| 17 | [briefing](research/modules/briefing.md) | `module-briefing` | `briefing` on request from the `BriefingSection` registry (weather, calendar, news, bin day, reminders, mail), length control, the template join without the model, skip and more as phrase commands in a window, preferences. | Scheduled and presence briefings, cards pinned in the morning, "what did I miss" | Sonnet |
| 18 | [local-info](research/modules/local-info.md) | `module-local-info` (`bin-day`), and `weather` in `modules-builtin` | `weather_rain_soon`, `weather_forecast`, `weather_warnings` in the weather module with the `weather` presentation and a briefing section; a `bin-day` module reading an ICS URL with `bin_next`, a reminder the evening before, and a briefing section. | Travel, places, parcels, markets, sports | Sonnet |
| 19 | [presence-and-people](research/modules/presence-and-people.md) | `module-presence` | `presence_where` and `people_list` over HA `person` entities through the `HomeAssistant` service, `presence.arrived` and `presence.left` with a departure delay, who may ask about whom. `Person` records themselves are P4. | Rooms, voice identification, guest mode, the house guide | Sonnet |
| 20 | [news-and-feeds](research/modules/news-and-feeds.md) | `module-news` | Built-in feeds with a refresh job, starter lists, OPML import, `news_headlines`, `news_story`, `news_article`, `feed_subscribe`, `feed_unsubscribe`, `feed_list`, title cleaning for speech, the `News` service for briefing. | Reader providers, alerts, clustering beyond titles, watchers, the ticker | Sonnet |
| 21 | [routines-and-automations](research/modules/routines-and-automations.md) | `module-routines` | Routines and quick commands defined in settings (`records`), run by phrase after the wake phrase with no model; steps `say`, `wait` up to a minute, `call` an action of another module, `stop_if_failed`; derived risk; `routines_run`, `routines_list`; a "Good morning" template. | Time, event, hook and presence triggers, drafts by voice, history | Opus |
| 22 | [mcp-client](research/modules/mcp-client.md) | `module-mcp` (`mcp`) | HTTP servers with headers from the vault, both protocol revisions, an opt-in allowlist per tool with risk and timeout, read-only tools, results cut and marked untrusted, restart on a changed tool list, the `Mcp` client service for t3-code. | stdio, OAuth servers, tasks, `find_tool`, MCP Apps | Opus |
| 23 | [calls-and-intercom](research/modules/calls-and-intercom.md) | `module-calls`, plus protocol, server and voice page | Stage 1: an audio intercom between browser devices relayed by the server (frame kind 3), call by device or room name, ring 30 seconds, answer and decline by tap or phrase, hang up, the call state machine, do-not-disturb respected, a call overlay. | Video, groups, phones, drop-in, listen-in, voice nodes | Opus |

### 5.2 Contracts between modules

Defined in `@pva/module-contracts` by P11, implemented by the module in the middle column, and looked up through the
services registry. A consumer treats a missing service as "that module is off" and says so.

| Service | Provided by | Used by |
|---|---|---|
| `People` | core (P4) | every module with per-person data |
| `DeviceControl` | core (P7) | assistant-controls, broadcast, calls |
| `Lists` (`addItem` with a dedupe key, `completeByKey`, `removeByKey`, `find`) | lists | kitchen |
| `Timers` (`start` with a label and a device to ring on) | timers | kitchen later, routines |
| `HomeAssistant` (entity cache, `callService`, areas, people) | smart-home | music, presence |
| `CalendarProviders` (register a provider), `Calendar.window` | calendar | google, briefing |
| `BriefingSections` (register a section) | briefing | weather, calendar, news, bin-day, reminders, google |
| `News.latest` | news | briefing |
| `Mail.overview` | google | briefing |
| `Reminders.upcoming` | reminders | briefing |
| `Mcp` (connect to an HTTP MCP server, list and call tools) | mcp | t3-code |

Events follow §2 row 8. Other modules may subscribe; nothing may depend on an event for correctness.

## 6. Review

- Each PR is reviewed by GPT-6.1 Sol at high reasoning effort, with the PR's diff against its base and this
  document. A review covers the whole diff every round, not only the last fix, and ends with either "approve" or a
  numbered list of findings with file and line, each marked blocking or not.
- Findings are fixed by Opus (open-ended) or Sonnet (well defined) on the PR's branch. Fixers do not run tests
  locally; CI does.
- At most five rounds; up to ten when a round still finds real problems. A finding in round *n* that was already in
  the diff at round *n − 1* is recorded as a miss of the earlier review, so the reviewer is told to be exhaustive in
  one pass: every file in the diff is read, and the review says which files it read.
- Fixes to a lower PR are merged up through the stack.

## 7. Out of scope

- Deployment: the installer, the system unit, `systemd-creds` for the vault, a second backup location.
- Voice nodes (PR #4) and anything that needs one.
- Phone channels (ntfy, Web Push, the HA companion app).
- Wiring the Jev intent agent as an agent; P7's typed-actions-first switch is the smaller step.
- The second round's core pieces: images in tool results, capture mode, the reading session, a voice per language,
  module widgets and the dashboard, companion pairing, the kids policy.
- Tiers 3 to 5.
