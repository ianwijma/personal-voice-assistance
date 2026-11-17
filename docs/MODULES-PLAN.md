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
2. **Module PRs** (§5): one PR per module, all based on the top of the preparation stack. Twenty-one are written
   in parallel and change only their own package (§3.2), so they do not conflict with each other. Two wait: T3 Code
   for the MCP client it uses, and calls-and-intercom, which changes shared files and is written last.
3. **Review** (§6): every PR is reviewed by GPT-6.1 Sol and fixed by Opus or Sonnet until a review comes back clean,
   for at most five rounds, or ten when real problems are still being found.

Nothing is merged into `main` by this work. The owner merges.

## 2. Decisions this plan assumes

The research left these to the owner. Unless a row says "override", the plan takes the recommendation recorded in
[investigation §11 and §12](research/module-investigation/investigation.md#11-disagreements-between-documents), so
that work can start. Each is cheap to change before the PR that builds it is merged.

| # | Question | Assumed answer |
|---|---|---|
| 1 | People | `Person` records live in a household settings section ("Members"), owned by the core (P5), not by the presence module (override of row h, so that every module can rely on them). A device's `place.defaultPerson` is the one authoritative link between a device and a person. No voice identification. Data without a known person is household data. |
| 2 | Module boundaries | Rows g, i–n and 36–38 of investigation §11 are accepted: the announce tool lives in broadcast; feeds and watchers in news-and-feeds; `who_is_home` and presence events in presence-and-people; podcasts, cameras and energy are out of music and smart-home; the n8n and HA-script bridge is out of routines. `system_status` is a tool of a small `system-status` module in the core-tools package (row 56 is about computer volume and speed tests, which stay out). |
| 3 | Rooms | A room is a free-text field on each device (`place.room`). The Home Assistant module maps rooms to HA areas by name, with aliases. |
| 4 | Speech without the wake phrase | A closed set of control phrases may be spoken without the wake phrase in two situations, each a per-device setting. **While ringing** ("stop", "snooze", "five more minutes"): on by default. A false match stops or postpones a ring, and a postponed ring rings again; P9 measures how often the ring's own spoken line triggers it and reports it. **While the assistant is audible** ("stop", "never mind", "louder", "quieter", "repeat"): built, off by default, and switched on per device by the owner; P7 measures the false-stop rate from the assistant's own voice and reports it. It cannot be switched on for a device in manual interrupt mode, where the microphone is closed while a reply plays. Everything else needs the wake phrase or an open window (§4, P7). |
| 5 | Risk | Classes `read / change / message / money / security`. Household default `{ read: allow, change: allow, message: confirm, money: deny, security: deny }`. Lower layers can only narrow. **`money` and `security` stay denied everywhere in this stack**: a device id is claimed by the page, not authenticated (`SessionHub.ts`, `hello`), so no device can be trusted with them until devices have credentials. Unlocking, disarming and purchases are therefore not built. `message` means something sent to people outside the house or in the owner's name on an outside channel (mail, chat, a phone call). Speaking, ringing or calling on the house's own devices is `change`, and is governed by the delivery policy of P9 (override of the broadcast and calls documents, which class it as outward-facing). |
| 6 | Confirmation | Stays switched off in this stack, as it is today: an operation whose outcome is `confirm` is refused with a sentence that says so. Core's confirmation has five known defects (`docs/AGENTS-AND-INTENTS.md` §3.2) and only covers declared actions asked for in a model turn, not tools, phrase commands, taps or routine steps. No first version in §5 needs it: nothing here sends a message outside the house. Repairing and extending it is out of scope (§7). Two things the research wanted confirmed are handled without it: a repeating calendar event cannot be added by voice in this stack, and cancelling or changing a repeating alarm requires the request to say "only the next one" or "all of them", which the tool asks for like any other missing detail. |
| 7 | Whose device | A device's default person selects whose data a turn means. It never grants access. Because device ids are not authenticated, anything a person would not want read by anyone on the home network does not belong in this stack: memory stores no secrets, and mail is read only by assistants the owner puts on devices they choose. |
| 8 | Personal content | Two levels on a result, a presentation, a notification or a spoken line: `household` (default) and `personal`, which names its owner (a person id). `personal` content is spoken and shown on a `private` device, and on a `shared` device whose default person is the owner; on any other `shared` device the module reduces it ("Ian: busy 12:30 to 13:30") or it is withheld; on a `public` device it is withheld. `personal` content with no known owner is treated as someone else's. One helper decides, `Privacy.mayReveal(owner, device)`, about the device that would speak or show it, which is not always the device that asked. Modules use it before they return a result to the model, and the Presenter, the speech service and the notification router use it per target device. This is stricter on shared screens than some module documents propose (override). |
| 9 | Children | Not supported yet. There is no kids flag on a device and no adult/child field on a person, so nothing suggests protections that do not exist. Web search defaults to moderate safe search. Image search in this version uses Wikipedia and Commons, which have no such filter; its section in `docs/MODULES.md` says so. The kids policy is out of scope (§7). |
| 10 | Storage | One SQLite file, `data/household.db`, through `node:sqlite`, holding each module's document collections. Modules do not write SQL (§4, P4). |
| 11 | Recurrence | What a person says ("every second Tuesday") is stored as an RFC 5545 `RRULE`; system jobs use `Cron`. One recurrence helper for every module. |
| 12 | Names | `CurrentTurn` (not `CurrentTurnDevice`); timers carry `dueAt`; an event is named by the module that emits it (`kitchen.stock.low`, `presence.arrived`). |
| 13 | Presentation | Own `present.*` messages, not a field on `tool.end`. Tools are always offered; the server decides whether something can be shown and tells the model what happened. A tap on a checklist item calls the tool directly, through the same gateway as every other call (§4, P1). |
| 14 | Spoken English | British conventions: "half seven" is 7:30. Dutch "half zeven" is 6:30. |
| 15 | Diets and allergies | One home: a `diet` part on each `Person` and on the household (allergies, diets, dislikes), read and written through the `People` service. Kitchen filters on it; memory's instructions send "Sam is allergic to nuts" there. |
| 16 | `critical` notifications | Nothing in this stack may send one. The priority exists in the service; hooks, modules and routes are capped at `high`, and a hook token at `normal` unless the owner raises it to `high`. |
| 17 | Essential controls | "Stop", "never mind", "repeat", "louder" and "quieter" belong to the host (P7), work for every assistant on every device, and cannot be switched off per assistant. The assistant-controls module adds the tools and the other commands. No module may register those phrases. |
| 18 | Services between modules | A service call runs on behalf of the tool, command or job that made it, which the gateway already admitted; the service does not ask again. So a service offers only what any caller may do: reads and `change`-class operations on household data. Whether an assistant has the providing module on decides its tools and its contributions, not whether another module may call its service. Two services are transports, not domain services: `HomeAssistant` (`callService`) and `Mcp` (a client). For those the consuming module classifies and filters its own tools, each call it makes must fit the call the gateway admitted, and the transport is never offered to the model as a tool of its own. |
| 19 | Phone push, voice nodes, deployment | Out of scope here (§7). |

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
- `pnpm check` and `pnpm test` must pass. CI runs both on every PR push and is the gate.
- Several agents share one machine, so heavy commands are queued behind one lock:
  `flock /workspace/build-cache/ian/pva-heavy.lock <command>`, with `VITEST_MAX_WORKERS=4`.
  - An **implementer** runs the tests of the packages they changed and `pnpm check`, and the whole suite at most once
    before opening the PR.
  - A **fixer** in a review round runs `pnpm check` and the tests of the files they touched; nothing more.
  - Nobody runs Playwright unless their brief asks. The lead runs it once on the top of the stack.
- Texts the assistant speaks are written in English and Dutch where the research document gives both, and are chosen
  by `HOME_LANGUAGE`.

### 3.2 What a module PR may touch

- Its own package under `packages/module-<id>/` (source, tests, `package.json`).
- Its own section in `docs/MODULES.md`.
- `pnpm-lock.yaml`, only when it adds a dependency the scaffold did not foresee; the PR description names it. The
  lead resolves lockfile conflicts between module PRs with `pnpm install` when restacking.
- Nothing else. The scaffold PR (§4, P11) has already created the package, registered it in the catalogue, added
  the dependencies of Appendix A and defined the contracts it shares with other modules.
- If a module needs something from the core that the preparation stack does not provide, the implementer stops and
  reports it instead of editing shared files.
- Four module PRs have a wider reach, limited to the files named here:
  - core-tools: `packages/modules-builtin/src/clock.ts` and new files beside it;
  - local-info: `packages/modules-builtin/src/weather.ts` and new files beside it (the package's `package.json` and
    `index.ts` are prepared by P11, so the two PRs do not meet);
  - smart-home: all of `packages/module-home-assistant/`;
  - calls-and-intercom: the call audio relay in the protocol, the server and the voice page (§5.1, row 23).

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

Nested configuration (the steps of a routine, the tool policy of an MCP server) is authored as JSON in a text field
that the module validates with a schema and explains on error. `records` fields are flat. Nobody builds a nested
editor in this stack.

### 3.4 Git

- Branch names: `t3/modules-NN-<slug>` for the preparation stack, `t3/module-<id>` for modules.
- Agents work in their own worktree on a detached `HEAD` and push with an explicit refspec
  (`git push origin HEAD:refs/heads/<branch>`), because a branch can be checked out in only one worktree.
- No force pushes. A lower PR's fixes reach the PRs above it by merge commits.
- A PR description says what was built, what was left out, how it was tested, and carries a screenshot where
  something is visible.

## 4. The preparation stack

The order of the table is the order of the stack and of the work. Two PRs in the same **slot** are written at the
same time, because they mostly touch different parts of the code; where they meet (the module context, the
protocol index, serve mode's wiring) each keeps its edits small and local, and the lead has the second merged onto
the first by an agent that runs the checks on the result. Every other PR
starts from the finished one below it. The design for each PR is the named research section, with the decisions of §2
and the additions below.

| PR | Slot | Branch | What it adds | Design |
|---|---|---|---|---|
| P0 | – | `t3/modules-00-plan` | This document | – |
| P1 | 1 | `t3/modules-01-module-api` | Module API v2, tool context, the execution gateway | [module-definition A.4, C.3–C.5](research/module-investigation/module-definition-config-and-dependencies.md#a4-manifest-shape-proposal), [shared-state §4.5](research/module-investigation/shared-state-jobs-and-notifications.md#45-turn-context-proposal) |
| P2 | 1 | `t3/modules-02-helpers` | Language and network helpers | below |
| P3 | 2 | `t3/modules-03-forms-routes` | Extended settings fields and module HTTP routes | [current-system §6.2, §9 gaps 19 and 21](research/module-investigation/current-system.md#62-settings-schema-drives-the-ui-implemented) |
| P4 | 2 | `t3/modules-04-store-bus` | Household store and event bus (server only) | [shared-state §4, §5, §7](research/module-investigation/shared-state-jobs-and-notifications.md#4-the-shared-data-layer) |
| P5 | 3 | `t3/modules-05-people-rooms` | People, rooms and device capabilities | [presentation §5](research/module-investigation/presentation-and-device-capabilities.md#5-device-capabilities), [shared-state §4.6](research/module-investigation/shared-state-jobs-and-notifications.md#46-identity-who-said-it) |
| P6 | 3 | `t3/modules-06-scheduler` | Scheduler | [shared-state §6](research/module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) |
| P7 | 4 | `t3/modules-07-phrase-commands` | Phrase commands, windows, session and device control | [assistant-controls §5](research/modules/assistant-controls.md#5-integrate-or-build) |
| P8 | 4 | `t3/modules-08-connections-risk` | Connections and risk policy | [module-definition B.4, B.5](research/module-investigation/module-definition-config-and-dependencies.md#b4-connections-and-oauth-on-a-headless-server) |
| P9 | 5 | `t3/modules-09-notifications` | Notification service, speech sequences, ringing | [shared-state §8](research/module-investigation/shared-state-jobs-and-notifications.md#8-notifications) |
| P10 | 6 | `t3/modules-10-presentation` | Presentation | [presentation §3, §4, §6](research/module-investigation/presentation-and-device-capabilities.md#3-presentation-what-a-tool-returns) |
| P11 | 7 | `t3/modules-11-scaffold` | Module packages, shared contracts, test kit, `docs/MODULES.md` | §5 and Appendix A |

Service keys and interfaces that the core provides or calls (`People`, `Privacy`, `SessionControl`,
`DeviceControl`, `Playback`) are defined in `@pva/core` by the PR that implements or first uses them. Keys that a module provides are defined in
`@pva/module-contracts` by P11.

### P1. Module API v2, tool context, the execution gateway

- `defineModule` gains optional `apiVersion`, `version`, `requires`, `platforms`, `health`, `templates`, `uses` and
  `shared`. A module without `apiVersion` is version 1 and sees no change.
  `MODULE_API = { current: 2, supports: [1, 2] }`.
- **Two lifetimes.** Today a module runs one instance per distinct set of effective settings. That stays for `start`
  (tools, actions, context, instructions). Version 2 adds an optional `shared(ctx)` part that runs **once per
  module**, with the module's shared settings only, while the module is demanded: at least one switched-on assistant
  has it on, or a demanded module names it in `uses`. Sockets, caches, job handlers, event subscriptions, services
  and contributions belong there. Each instance receives what `shared` returned.
  - *Settings.* Shared code that acts for a caller asks for that caller's settings:
    `ctx.settingsFor(assistantId)` gives the module's effective settings for an assistant (its own values over the
    shared ones), and the shared values when there is no assistant. A weather briefing section therefore uses the
    asking assistant's place and units.
  - *Replacement.* A change to a shared setting starts a new generation: the new shared part and every instance
    start, then the snapshot switches to them at once, then the old generation is retired. If the new generation
    fails to start, the old one keeps serving and the Health page says why. The old shared part's handlers, routes,
    subscriptions, services and contributions are withdrawn at the switch, never live beside the new ones; the old
    scope itself closes after the existing grace period for calls in flight. `requestRestart` from an instance
    restarts that instance; from the shared part it starts a new generation.
  - *Order.* A module starts after the shared parts of the modules in its `uses` have started or failed. A cycle in
    `uses` is an error for every module in it, found when the catalogue is read. A consumer never keeps a service
    it looked up at start: it looks it up at each use, so a provider that fails, restarts or comes back later is
    seen without restarting the consumer.
  - *CLI modes* have no assistants: every module whose saved switch is on is demanded and runs one instance, and
    calls are admitted for an explicit local principal. On a serve-mode path a call with no `CurrentTurn` and no
    job origin is refused; a missing context never means "allowed".
- **Services.** `shared` may return typed services under `ServiceKey<T>` values. `host.service(key)` is a live
  lookup that returns `undefined` while no demanded module provides the key; a consumer then says that the other
  module is off. A second provider of a key is a start error for the second module. §2 row 18 says what a service
  may offer.
- **Contributions.** `shared` may return values under `ContributionKey<T>` (a briefing section, a calendar
  provider). The host collects them; `host.contributions(key)` is the live list, and inside a turn it holds only the
  contributions of modules the turn's assistant has on. Nothing registers itself with another module, so start
  order and restarts cannot lose a registration.
- `ModuleContext` gains a `host` member for version 2 modules. The later PRs add `store`, `events`, `scheduler`,
  `speech`, `notify`, `present`, `connections` beside it; P1 defines where they go, in both `shared` and `start`.
- `CurrentTurn`: a `Context.Reference` provided around every tool call, every action run **and the gathering of
  context providers**, in the core tool loop and in the Claude Code bridge. Fields: turn id, conversation id,
  assistant id, device id and name, room, person, source (`voice`, `text`, `touch`, `phrase`, `routine`) and an
  opaque reference to the connection the request came in on (several tabs can share a device id). P1 fills what
  serve mode knows today; P5 fills room and person. Absent in CLI modes; a job carries its own origin.
- **One execution gateway.** Every way of running a tool or an action goes through one function in the core: a
  model's tool call, the Claude Code bridge, the intent agent, a phrase command, a tap on a presentation, a routine
  step, a notification action. The gateway resolves the assistant, device and person of the call, and checks, in
  this order: the assistant has the module on; the tool is not in its `offTools`; the risk policy (added by P8). A
  caller cannot reach a module's `execute` any other way. One kind of call is admitted differently: an action on a
  notification (P9) is admitted by the notification, for anyone at a device where it is ringing or shown, whatever
  modules that device's assistant has on; the risk policy still applies. `host.actions` gives a module the **turn's** action
  catalogue (the calling assistant's), and runs an action through the gateway.
- Tool metadata: optional `risk`, `sensitivity` and `latency`, on tools and actions. `risk` is a class, or a
  function from the validated input to a class together with a declared list of the classes it can return (a cover
  tool declares `change` and `security`: a blind is `change`, a garage door is `security`). Inferred when absent:
  `speculative: true` means `read`, otherwise `change`. `sensitivity` is `household`, or `personal` with the owner
  (§2 row 8), fixed or decided per result. P1 carries them through the gateway; P8 enforces them. An action's
  existing `confirm: true` keeps meaning what it means today.
- `host` also gives a read-only view (module states, vault locked or not, engine summary, connected devices, the
  Home section's values) and `requestRestart(reason)`, so a module whose tool list changed at run time is started
  again.
- Requirements: the `Requirement` type, one tool registry in the app with probes, probing at start and on "Check
  again", a new module state `unavailable` with a reason and a fix, and one instructions line per unavailable module
  so the assistant says "music is not set up on this server" instead of improvising.
- Health: `health()` returning issues; an issue registry; `pnpm start doctor` with the core checks and every module's
  requirements and health; an admin Health page.
- Templates: plain data on the manifest; the new-assistant wizard offers them.
- Protocol: `ModuleState` gains `unavailable`; version bump.

### P2. Language and network helpers

Two new packages with no dependency on the rest of the stack, plus household settings several modules read.

- `packages/language` (`@pva/language`), English (British conventions) and Dutch:
  - parsing: time of day (English "half seven" is 7:30; Dutch "half zeven" is 6:30, "kwart voor zeven"), dates and
    date-times ("tomorrow at five", "next Friday" reported as ambiguous), durations (re-exporting core's),
    quantities with units (mass, volume, pieces, "about", "a handful") for lists and the kitchen. A phrase the
    parser cannot place is reported as not understood or ambiguous, never guessed: this feeds alarms and calendar
    writes;
  - speaking: numbers, amounts with units, durations, clock times, dates and relative days, lists ("a, b and two
    more"), so every module words these the same way;
  - recurrence: build and read an `RRULE` with `DTSTART` in the home time zone, and compute the next occurrence.
- `packages/net` (`@pva/net`):
  - `safeFetch`, the complete guard of [web-search §13](research/modules/web-search.md#13-privacy-and-safety): only
    `http` and `https`, no credentials in the URL, the host resolved by us and every address class that is not public
    refused, the connection made to the address that was checked (so DNS rebinding cannot swap it), the same checks
    on every redirect, limits on size and time. LAN targets are a separate, explicit option for endpoints the owner
    configured, never for a URL a model chose;
  - a small cached JSON fetch with ETag support;
  - the outgoing `User-Agent` built from the household API contact.
- Home section: `currency`, cup size, API contact for `User-Agent` headers. `HOME_UNITS` exists.

### P3. Extended settings fields and module HTTP routes

- The field types `textList`, `records`, `combo`, `action` and `info` exist in core and in the protocol but do not
  reach module forms. P3 puts them on the wire form, renders them in admin, stores them, and wires `fieldActions`
  (the "Test" button) and `settingOptions`. `records` stay flat (§3.3).
- Module HTTP routes: a module's `shared` part may contribute routes under `/api/modules/<id>/…`. A route declares
  its guards, and **all** declared guards must pass: an admin session, a bearer token from the vault (revocable, one
  per caller), LAN only. It also declares a body limit and a rate limit. Used by inbound notification hooks and
  OAuth callbacks.

### P4. Household store and event bus

Server only: no voice-page work. P10 is the first consumer on a screen. The store is deliberately small: two review
rounds on a larger design (module-owned SQL behind a hand-written guard, a change log with undo, full-text search,
restore and export commands, nested transactions) found dozens of problems in exactly those parts, and no first
version in §5 needs them.

- `packages/store-sqlite` implementing a core `HouseholdStore` on the built-in `node:sqlite`: one file
  `data/household.db`, WAL, one connection for turns, files private to the user.
- `ctx.store`: **document collections** and nothing else for modules. `defineCollection` with a name, a scope, a
  schema whose values are objects, a version with a migration of the whole collection when it changes, declared
  indexes on scalar fields, optional `ambient` lines and an optional projection for voice pages. Operations: `get`,
  `list` (one equality filter on an indexed field, an order, a limit), `insert`, `update` with a revision check,
  `remove`. No module-owned SQL, no full-text search, no generic undo. A module that needs to find text matches in
  code over a bounded `list`; a module that offers "undo" keeps what it needs to reverse its own last operation.
- **Transactions are synchronous and flat.** `store.transaction(tx => …)` runs a function with no awaits against a
  handle with the same operations; begin, the function and commit happen in one uninterrupted step, so there is no
  interleaving, no nesting and nothing to interrupt. A call to `transaction` inside one joins it. Core services
  (the scheduler, notifications) get their own tables through `store.core(owner)` and take part in the same
  transaction through the same handle.
- `remove` really removes: the row is deleted with `secure_delete`, the write-ahead log is checkpointed soon after,
  and there is no history that still holds the content. Daily backups keep it until they rotate out, and the
  documentation says how long.
- Scopes household, person, assistant, device, conversation, derived from `CurrentTurn` or given explicitly, with
  scope ids restricted to a safe alphabet. A person-scoped call with no person is a typed error.
- A stored schema version per module and per collection. A database written by a newer version of a module is
  refused for that module (`unavailable`, with the reason), never opened and rewritten by older code. Migration runs
  in one transaction after a backup.
- A daily backup on a separate connection, kept 14 days. Restoring is a documented manual step with the server
  stopped; `doctor` checks that the database opens and that a recent backup exists.
- Event bus: one in-process bus; `ctx.events.publish` and `subscribe`; host events (turn ended, device connected or
  disconnected, module state changed). Events about a store change, and events published inside a transaction, are
  released after it commits, in order.
- To voice pages: `household.event` and a snapshot, defined in the protocol. Nothing is sent by default. A
  collection or an event type opts in by giving a **projection**: a function from the row or event and the target
  device to what that device may see, or nothing. The same projection is applied to snapshots and live events; a
  page that connects, or that may have missed something, gets a fresh snapshot. This is how an alarm's label can be
  shown on the device it will ring on and left out elsewhere. A row a device could see and no longer can is sent to
  it as a removal, and a change to a device's place or default person gives it a fresh snapshot. Person-scoped rows
  are also passed through `Privacy.mayReveal` once P5 exists. A page that claims a device's id receives that
  device's rows: device ids are not authenticated (§2 rows 5 and 7).
- Ambient facts: a host context provider that assembles collections' `ambient` lines within the 50 ms budget, capped
  at 600 characters, behind a household switch that is off until the owner has measured, with `bench --live
  --ambient`, what the added context costs their model's first token.

### P5. People, rooms and device capabilities

- `hello.device.capabilities` (`DeviceCapabilities`: display class and size, touch, renderable kinds, speaker,
  microphone) declared by the voice page, kept per device, updated live.
- Two device settings sections: `place` (room, privacy `private | shared | public`, always on, accepts from others,
  quiet room, default person) and `capabilities` (overrides that can only remove). No trusted flag and no kids flag
  (§2 rows 5 and 9).
- Household section "Members": `Person` records (id, name, aliases, pronunciation, `diet`), edited with P3's
  `records` and text-list fields, and a household `diet` default.
- `CurrentTurn.room` and `.person` (`how: "device-default"`).
- Services: `People` (list, find by spoken name, diet read and write) and `Privacy.mayReveal` (§2 row 8).
- One line in the per-turn context: this device, its room and what it can do, and the other screens in the house.
- Admin: Members, and "What it can do" and the place fields on a device. Protocol bump for the new sections.

### P6. Scheduler

- `ctx.scheduler` as in shared-state §6.2: `schedule` (at, in, cron), `handle`, `pause`, `resume`, `reschedule`,
  `cancel`, `list`, `runTask`. A `jobs` table, one fiber sleeping until the earliest due time, wall-clock due times,
  a re-check on clock jumps. Handlers are registered in a module's `shared` part.
- Missed-while-down policies `fire-late`, `{ fireIfWithinMs }`, `skip`, `inbox`, and "run the last missed occurrence
  once" for recurring jobs.
- Exactly-once as far as one process can give it. Every occurrence has a stable key (job id and due time). A due
  job is claimed in a transaction (P4's synchronous kind; scheduling from a module's transaction uses its handle). A handler declares whether it is idempotent. Only an idempotent handler is ever
  run again for the same occurrence, whether it failed (retried with back-off up to a declared limit) or was found
  `running` at start; any other handler that fails or was interrupted is marked failed and reported on the Health
  page. A `{ notify }` job is delivered again under the same notification id, which the notification service
  dedupes. Completing or failing an occurrence and scheduling the next one of a recurring job happen in one
  transaction, so a recurring job always moves on.
- `{ notify }` jobs are accepted and stored in P6 and delivered once P9 exists; until then they log.
- Admin: a list of scheduled jobs with cancel.

### P7. Phrase commands, windows, session and device control

The fast path the basics need: commands that run without the language model.

- **Phrase commands.** A closed set of phrases per language with optional typed slots (the existing `Param`
  kinds), a `when`, and a handler that runs through the execution gateway and returns at once with an optional
  spoken line or earcon; anything longer it starts in the module's shared scope. `when` is `after-wake` (the
  utterance after a wake phrase, or inside an assistant's follow-up window, matches the phrase) or the name of a
  window. There are two sources:
  - the **host's essential controls** (§2 row 17): "stop", "never mind", "repeat", "louder", "quieter", in the
    `audible` window and `after-wake`. They exist for every assistant on every device, whatever modules it has.
    "Stop" is one operation, the same with and without the wake phrase. It stops the first of these that exists on
    the device: a ringing notification (every one ringing there, through P9); a reply being prepared or spoken, or
    a speech sequence; media that the `Playback` service says is playing in the room. "Louder" and "quieter" change the media volume while media plays in the room, otherwise the reply volume;
  - **modules**: `after-wake` commands from an instance, valid for the assistants that use that instance; window
    commands from the shared part, valid in the windows that module opened.
- **Windows.** A window belongs to one device and has an owner (the host or a module), a kind, an id and an
  expiry. The host opens `audible` (a reply is playing or just ended) and, in P9, `ringing`. A module opens windows
  of its own for some seconds. A window has one of three kinds:
  - `phrases`: its phrase commands are accepted without the wake phrase;
  - `capture`: the next utterance's text is handed to the owner instead of an agent. It starts listening only when
    the announcement that opened it has finished playing, ends at the first utterance, at "never mind" or at its
    expiry, and one device holds one capture at a time (a newer one replaces an older one, whose owner is told);
  - a **guard**: while it is open the device answers only to a wake phrase. It comes in two strengths. A `media`
    guard (music playing in the room) still admits the host's `ringing` controls, so a timer can be stopped without
    the wake phrase, and still lets a capture listen. A `call` guard (a connected call) admits nothing but the
    call's own phrases and the wake phrase: ringing controls need the wake phrase, and no capture listens on that
    device, so that the voice at the other end cannot act here; a capture that would open is refused and its owner
    is told the device is busy. With both open, the `call` guard rules.
- **How one utterance is routed**, the same in every interrupt mode, decided by the host so that exactly one
  consumer takes it:
  1. an utterance that starts with a wake phrase leaves every window and goes to step 5;
  2. if a `phrases` window is open on the device and the utterance matches one of its commands, that command takes
     it. Open windows are tried in this order: `ringing`, module windows by most recently opened, `audible`; within
     a window the longest phrase wins. A guard limits which windows are tried, as said above;
  3. otherwise, if a `capture` window is listening and no `call` guard is open, its owner takes the utterance, even
     on a device whose normal route is "nobody";
  4. otherwise, if a guard is open, the utterance is dropped;
  5. otherwise the route gate decides as today, and an `after-wake` command of the answering assistant takes the
     utterance if it matches, before the dispatcher.
- **One decision per utterance.** Steps 2 and 3 work on recogniser events before the echo gate, so a single word is
  not lost to its two-word rule; step 5 works after the route gate. An utterance is taken or not taken once, and
  the decision covers all of its events (speech start, interim, eager, final, resumed). What is guaranteed for a
  taken utterance: it is never promoted to a turn, nothing of it enters the conversation history, and no tool that
  is not speculative runs for it. What is not: its first events are forwarded as today, before anyone can know it
  is a command, so the start of speech may interrupt a reply (in instant interrupt mode) and a speculative model
  call may start and be thrown away. Interrupting is what "stop" wants; after "louder", "quieter" or another
  command that was not meant to end the reply, the host repeats the interrupted reply. An utterance that is not
  taken goes through the gates exactly as today, with no delay added; the PR shows that with `TurnTrace`.
- **Conflicts.** The host's phrases are reserved. Two commands with the same phrase in one assistant's `after-wake`
  set, or in one window, do not stop a module from starting: both are left out for that assistant or window, and
  the Health page names them. Admin warns when a routine phrase is close to a wake phrase or a host phrase.
- **Session control** (`SessionControl` service): stop the reply being spoken, cancel a pending interaction, repeat
  the last reply, start a new conversation, switch the answering assistant (with the existing `canPick` and
  assignment checks), put the device to sleep and wake it, read these states. Sleep and a temporary switch are kept
  per device in memory and reset at a restart.
- **Device control** (`DeviceControl` service): reply volume, microphone mute and device state, through new
  `output.volume`, `mic.set` and `device.state` messages and a gain node on the reply output of the voice page;
  earcons and canned replies. A microphone the person muted is never opened by a window.
- The `Playback` service key is defined here, for the host's "stop" and volume; the music module provides it.
- **Typed actions before the model.** Per assistant, an opt-in switch that tries the offline keyword decider over
  the assistant's actions and runs a confident, complete match without a model call, through the gateway. Off by
  default; the measurements that would justify another default are part of the PR.
- The wake-free settings of §2 row 4, with the measurement of false stops reported in the PR. In manual interrupt
  mode the microphone is closed while a reply plays, in the page and on the server; the "while audible" setting is
  shown as unavailable there, with the reason.

### P8. Connections and risk policy

- Connection types (declared by modules) and connection records in settings, credentials in the vault, owned by the
  household or a person, with a status (`ok`, `locked`, `needs-reauth`) and a test call.
- Flows: authorization code with PKCE and a loopback redirect with "paste the address you ended on", the device
  authorization grant, a redirect to the server's own HTTPS name when there is one, and OAuth for an MCP resource
  server (discovery, dynamic client registration). Single-flight refresh; rotated refresh tokens saved at once.
- `ctx.connections`: resolve a connection for the turn (the turn's person, then a household connection), and give a
  module a token provider it can hand to its own client.
- Risk policy in the gateway: the household ceiling, narrowed by assistant and device. Outcomes are `allow`,
  `confirm` and `deny`. A tool whose every declared class is denied or needs confirmation is left out of the turn's
  tool list; every call is checked again at execution with its validated input, on every entry path. `deny` and
  `confirm` both refuse (§2 rows 5 and 6), each with its own sentence for the model and for speech, and the trace
  records which. A routine is refused as a whole when it is saved or run if any step would be refused.
- `sensitivity` enforced where the gateway can: a `personal` result is passed through `Privacy.mayReveal` for the
  asking device before it goes back to the model.
- Admin: Connections, and the risk policy for the household, an assistant and a device.

### P9. Notification service, speech sequences, ringing

- **One delivery policy** for everything the house says or shows that nobody on that device just asked for. A
  notification and a spoken sequence both pass through it, per target device: do not disturb, quiet hours, quiet
  rooms, whether the device accepts things from other devices, the priority caps of §2 row 16, and
  `Privacy.mayReveal`. A reply or a spoken line on the device that just asked skips the parts about disturbing
  (do not disturb, quiet hours, acceptance); `Privacy.mayReveal` is checked for everything that is spoken or
  shown, at the moment it is delivered, a repeated reply included.
- `ctx.notify` as in shared-state §8.1: `send`, `update`, `resolve`, `inbox`. A `notifications` table. Priorities
  and what each may do, audiences, ring policies (`origin`, `origin-then-room`, `everywhere`), one decision per
  notification, dedupe keys, expiry.
- **Do not disturb** as part of the service: per device and for the house, with an end time kept by the scheduler;
  `notify.dnd` to read, set and clear it; a `dnd.changed` event; the state in `device.state`. Quiet hours as a
  household setting. One table says what each priority does under each.
- **Actions on a notification.** A request names its actions (`stop`, `snooze`, `extend`, `answer`, `decline`,
  `open`, or a custom id) and an action handler name. The owning module registers that handler in its `shared` part,
  like a scheduler handler, and a notification that is waiting for an answer keeps that shared part demanded. A
  press, a ringing-window phrase or a call to `resolve` all arrive there through the gateway with the notification
  id and the actor, so the module updates its own timer or reminder and its job; the service only records the
  outcome. While the handler cannot be reached (its module is restarting or failed), `stop` still silences and
  resolves the notification, and any other action answers "I can't do that right now" and leaves it as it was.
- **Speech sequences** (`ctx.speech`): a bounded, cancellable sequence of spoken segments on a device, outside a
  model reply. A request names its origin, a priority and a sensitivity, and goes through the delivery policy when
  its target is not the device that asked.
  - `enqueue` returns a handle at once. The sequence takes the output lease after whatever is playing: it waits
    for the current reply to end (a `high` one for the current clause), and never talks over one.
  - A tool or an action called inside a model turn must not wait for a sequence: the reply it belongs to is what
    the sequence is waiting for. Speech that is the answer to a turn is returned as the result (`say`), as today.
    Code that runs outside a turn (a phrase command's started work, a job, a routine run) may wait for each
    segment to finish, which is how a routine keeps its steps in order.
  - It can play a cue first, reports which segment is playing, can skip to the next segment or stop, is stopped by
    the host's "stop", and can be recorded in the conversation as `[Announced: …]`.
  - `Announce` is a one-segment sequence. Delivery is by device, not by session.
- Ringing: `notification.ring` and `notification.resolved` messages; the voice page loops a local cue, shows a
  plain card with the notification's actions, and shows a badge for what was missed. The `ringing` window (not
  matched against the device's own spoken line while that plays) and a follow-up window after an announcement,
  through P7. The measurement of §2 row 4.
- Admin: the inbox.

### P10. Presentation

- `packages/protocol/src/presentation.ts`: the kinds `text`, `card`, `facts`, `list` (bullets, numbered, checklist,
  pick), `table`, `image`, `gallery`, `timer`, `progress`, `weather`, `confirm`, `handoff`, each versioned, with
  `fallback`, `spoken`, `lifetime`, `sensitivity` and actions. `steps`, `map`, `chart` and `media` come later.
- Three ways in, one Presenter:
  - a tool or an action returns `{ forModel, present }` (an action's outcome gains `present` beside `say`); the
    gateway splits it;
  - `ctx.present` for everything that is not a call ending: `show(target, presentation)` returning a handle with a
    stable key, `update`, `dismiss`, where the target is a device, a room, or "wherever this is already shown". A
    timer's countdown, a ticked item and a job's progress are updated this way from `shared` code and jobs;
  - the built-in `show` and `show_on` tools.
- The note for the model says what the server did, not what the eye saw: "sent to Kitchen tablet", "not sent: no
  display here; Kitchen tablet can show it". A device reports `present.status`; a failed load is put in the next
  turn's context. The turn never waits for that report.
- The Presenter per device: capability-based degradation, `Privacy.mayReveal` for the device that would show it,
  the reveal rule
  (`reveal { turnId, clause }`), lifetimes, one transient at a time, pinned presentations restored on reconnect,
  `present.show / update / dismiss` and `present.action / dismissed / status`. A `present.action` of kind `tool`
  runs through the execution gateway with source `touch`.
- `/media/<hash>`: the server fetches an image once through `safeFetch`, checks type and size, resizes with `sharp`,
  serves it with dimensions and a placeholder, and evicts it after a day.
- P9's ring card and badge move into the presentation stage. The `confirm` kind is defined and drawn, and is
  used only for a tap that is itself the confirmation of something shown on that screen ("Clear the list?").
- The three stable instructions for the system prompt.
- The voice page: one renderer per kind, and the stage layouts that move and shrink the character's box. Every
  existing character keeps working unchanged (`docs/CHARACTERS.md`).

### P11. Module scaffold

- One package per module in §5 with a `defineModule` stub that is off by default, registered in the catalogue, with
  the dependencies of Appendix A in `package.json` and the lockfile. `packages/modules-builtin` gets its new
  dependencies and exports for the clock and weather extensions.
- `packages/module-contracts` (`@pva/module-contracts`): the service and contribution keys modules share (§5.2),
  with their interfaces written out and documented.
- A module test kit in `@pva/core/testing`: an in-memory store, a scheduler on a test clock, recorders for
  notifications, speech and presentations, a `CurrentTurn` builder, a fake connection, a fake `host` with services
  and contributions, and a helper that runs a tool or a phrase command through the real gateway.
- `docs/MODULES.md`: how to write a module against API v2, and one section per module to be filled by its PR.

## 5. The modules

### 5.1 One PR each

"Model" is who writes it: Opus for open-ended work, Sonnet where the first version is well defined. All are based on
P11. Wave B starts when the module it waits for is written. Where a first version is larger than the research
document's own, the row says why.

| # | Module | Package (module ids) | First version | Left for later | Model |
|---|---|---|---|---|---|
| 1 | [assistant-controls](research/modules/assistant-controls.md) | `module-assistant-controls` | The host already has stop, never mind, repeat, louder and quieter (P7). This module adds the same operations as tools, for free phrasing, and phrase commands and tools for new conversation, switch assistant, sleep and wake up, set the volume to a level, and mute the microphone, on `SessionControl` and `DeviceControl`. | `show_on` (it is in P10), hand-off, find my phone, speech rate | Sonnet |
| 2 | [timers-and-alarms](research/modules/timers-and-alarms.md) | `module-timers` (`timers`, `alarms`) | Named timers and alarms as household data: start, list, adjust, pause, resume, cancel; alarms once and repeating, where cancelling or changing a repeating one must say "only the next" or "all"; ringing through P9 with stop, snooze and +5 minutes as notification actions; the `timer` presentation pinned and updated through `ctx.present`; timers shown on every screen, an alarm's label only on the device it rings on, through P4's projections; ambient facts; HA's matching rules; phrase commands for set, ask and stop. | Phone, escalation, node-local copies, sunrise, music alarms | Opus |
| 3 | [core-tools](research/modules/core-tools.md) | `module-core-tools` (`calculator`, `knowledge`, `system-status`), and `clock.ts` in `modules-builtin` | `calculate` with units and currency, evaluated with real bounds (a restricted set of operations with limits on size and depth, or a worker that is stopped at a deadline: a length limit alone does not bound a synchronous evaluator on the audio thread), the extended `current_time`, `lookup` (Wikipedia, Wikidata, Wiktionary), `random`, `system_status` on P1's host view. | `translate`, crypto, SPARQL | Sonnet |
| 4 | [web-search](research/modules/web-search.md) | `module-web-search` | `web_search` with SearXNG and Brave behind a `SearchProvider` interface, `read_page` on `safeFetch`, a usage counter and caps in the store, moderate safe search. | `research`, `search_sources`, more providers, provider-native search | Sonnet |
| 5 | [lists](research/modules/lists.md) | `module-lists` | Local store, the ten `lists_*` tools, a default shopping and to-do list, splitting on "and", quantities, duplicate merge, undo, the `Lists` service, the checklist presentation with direct ticks, phrase commands for add and read. | Chores, person lists, every outside provider (the HA provider of the document's first version too: smart-home is being rewritten beside it), the outbox | Opus |
| 6 | [notifications](research/modules/notifications.md) | `module-notifications` | The spoken side of P9: `notifications_read` and dismiss, do-not-disturb by voice with an end time on `notify.dnd`, "send a test", one inbound `notify` hook on P3's routes that needs both its token and the LAN, capped at `normal`. | Phone channels, escalation, hooks from outside the LAN | Sonnet |
| 7 | [kitchen](research/modules/kitchen.md) | `module-kitchen` | Slice 1: the pantry ledger (a collection of bookings; current stock is their sum) with approximate amounts and undo by a reversing booking, product settings, low stock into the shopping list through `Lists`. Plus, beyond the document's first version, stored recipes entered by voice and `kitchen_what_can_i_make` with a time limit and the household's diets: it is the owner's own example of what the kitchen is for, and it needs nothing slice 1 does not have. | URL import, scaling, guided cooking, meal plan, the Chef template with hands-free "next", outside providers, barcodes | Opus |
| 8 | [music](research/modules/music.md) | `module-music` | Route 1 only, over the `HomeAssistant` service: play (artist, album, playlist, radio through Music Assistant), pause, resume, next, previous, volume, what is playing, per room, with the room from `CurrentTurn`; phrase commands for transport; the `Playback` service; the `media` guard on the devices of a room while its player plays, so that lyrics are not taken for requests ("hey Jeff, stop" still pauses it); a room with a player starts guarded until the first state from Home Assistant shows it is not playing, and while the state is unknown later the guard stays as it was. | Playback in the browser or on nodes, Spotify direct, ducking, the `media` kind | Opus |
| 9 | [smart-home](research/modules/smart-home.md) | `module-home-assistant` (existing) | The WebSocket entity cache with registries and HA's exposure list, in the module's `shared` part; typed actions for lights, switches, climate and covers; reading any exposed entity's state, a lock's included, is `read`; changing a lock, a garage door, a gate or an alarm panel is `security` and so refused; scenes and scripts only those the owner ticks one by one in the module's settings, because what a script does cannot be seen from outside it; `media_player`; "here" from `CurrentTurn.room`; the `HomeAssistant` service; a connection instead of module secret fields, with the old fields still read. | Locking, unlocking and disarming, watches, doorbell and leak notifications, cameras, energy, the MCP long tail | Opus |
| 10 | [reminders](research/modules/reminders.md) | `module-reminders` | Time and repeating reminders, household and person scope, `RRULE` storage with one job for the next occurrence, delivery where set, done and snooze as notification actions and follow-up phrases, the `card` and `list` presentations, a briefing section. | Presence and event reminders, "remind Sam", nag, CalDAV | Sonnet |
| 11 | [images-and-photos](research/modules/images-and-photos.md) | `module-images` | `image_find` over Wikipedia and Commons with credit, `gallery` with pick for ambiguous words (the document's kiwi case needs it), the three-part reply on a device without a screen. | Other sources, generation, Immich, photo frame, cameras | Sonnet |
| 12 | [calendar](research/modules/calendar.md) | `module-calendar` | `CalendarProvider` contributions with ICS and CalDAV providers of its own, a cache refreshed by a job, `calendar_agenda`, `_next`, `_find`, `_free`, `_add` with undo for single events (a repeating event is refused, §2 row 6), personal events reduced on shared devices (§2 row 8), a briefing section, an ambient line. | Change and delete, reminders from events, Microsoft, HA calendars | Opus |
| 13 | [memory-and-notes](research/modules/memory-and-notes.md) | `module-memory` | `remember`, `recall`, `forget`, `note`, `read_notes` on the store; `recall` matches words in code over the newest 2,000 entries and says so when there are more. Household and person scope, `forget` removes the row for good, pinned memories in the per-turn context within 800 characters and measured, a refusal for codes and passwords. | Secrets, full-text search over everything, sync to Obsidian or Nextcloud, embeddings, audio | Sonnet |
| 14 | [google](research/modules/google.md) | `module-google` | The `google` connection type on P8's loopback-and-paste flow with the owner's own client id, read-only: `mail_overview`, `mail_search`, `mail_read`, all `personal`; a Google `CalendarProvider` contribution; a mail briefing section. A hand-written fetch client. | Send, drafts, contacts, Drive, Tasks, the mail cache and sync job | Opus |
| 15 | [t3-code](research/modules/t3-code.md) | `module-t3-code` (wave B, after 22) | Read-only over T3's `/mcp`: its own connection type on P8's MCP OAuth flow, the `Mcp` service's client with that connection's token provider, `t3_overview`, `t3_thread_status`, `t3_pull_requests`, `t3_projects`; a context line; the coding template. T3's upstream tools are never offered to the model directly. | Draft and send, stop, answer, watches, CI status | Sonnet |
| 16 | [broadcast](research/modules/broadcast.md) | `module-broadcast` | `broadcast_send` to everyone or a room in the assistant's voice with a chime, through `ctx.speech` and so through the delivery policy (do not disturb, quiet rooms in quiet hours, devices that accept nothing from others); a 30-second `capture` window on each target for a reply, routed back to the sender (not on a device that is in a call); `broadcast_chime`; the origin excluded; a `card` on screens. | The speaker's own voice, voice messages, schedules, phones | Sonnet |
| 17 | [briefing](research/modules/briefing.md) | `module-briefing` | `briefing` on request from the `BriefingSection` contributions of the modules the assistant has on, with a length; as a tool it returns the sections for the model to word, and as a typed action or phrase command it returns a template join as its spoken result, with no model; preferences. The section contract is in the first version, beyond the document's, because five other module PRs are written against it at the same time. | Skip and more, scheduled and presence briefings, cards pinned in the morning, "what did I miss" | Sonnet |
| 18 | [local-info](research/modules/local-info.md) | `module-local-info` (`bin-day`), and `weather.ts` in `modules-builtin` | `weather_rain_soon`, `weather_forecast`, `weather_warnings` in the weather module with the `weather` presentation and a briefing section; a `bin-day` module reading an ICS URL with `bin_next` and a briefing section. | Bin reminders, travel, places, parcels, markets, sports | Sonnet |
| 19 | [presence-and-people](research/modules/presence-and-people.md) | `module-presence` | `presence_where` and `people_list` over HA `person` entities through the `HomeAssistant` service, a link from a `Person` to an HA person as a module setting, `presence.arrived` and `presence.left` with a departure delay. `Person` records themselves are P5. | Rooms, voice identification, guest mode, the house guide, who may ask about whom | Sonnet |
| 20 | [news-and-feeds](research/modules/news-and-feeds.md) | `module-news` | Built-in feeds with a refresh job, starter lists, `news_headlines`, `news_story`, `news_article`, title cleaning for speech, a briefing section; and `feed_subscribe`, `feed_unsubscribe`, `feed_list`, which the document puts in the first wave: without them the owner cannot change the starter list by voice. | OPML import, reader providers, alerts, clustering beyond titles, watchers, the ticker | Sonnet |
| 21 | [routines-and-automations](research/modules/routines-and-automations.md) | `module-routines` | Routines and quick commands defined in settings (steps as validated JSON), started by phrase after the wake phrase with no model, or by `routines_run`; either way the run is started and continues in the module's shared scope, one step after the other. Steps: `say` (a `ctx.speech` segment the run waits for), `call` an action from the starting assistant's catalogue, `stop_if_failed`. Every step runs through the gateway and is checked on its own, and a routine with a step that would be refused is refused as a whole, so a routine can do nothing the assistant could not. `routines_list`; a "Good morning" template. | `wait`, steps that need confirmation, time, event, hook and presence triggers, drafts by voice, history | Opus |
| 22 | [mcp-client](research/modules/mcp-client.md) | `module-mcp` (`mcp`) | HTTP servers with headers from the vault, both protocol revisions, an opt-in allowlist per tool with risk and timeout (as validated JSON), read-only tools, results cut and marked untrusted, restart on a changed tool list; at most ten MCP tools per assistant across all servers, more being a configuration error that names them (the research's loading on demand above ten comes with `find_tool`); the `Mcp` service: an authenticated, reusable HTTP client that another module can open with its own URL and token provider. | stdio, a settings page for OAuth servers, tasks, `find_tool`, MCP Apps | Opus |
| 23 | [calls-and-intercom](research/modules/calls-and-intercom.md) | `module-calls`, plus protocol, server and voice page | Stage 1: an audio intercom between browser devices relayed by the server (frame kind 3), call by device or room name, ring 30 seconds through P9 with `answer` and `decline` actions, hang up, the call state machine, do-not-disturb respected, the `call` guard during the call, a call overlay. The caller's leg is bound to the connection the call was started from, the other leg to the connection that answered, each the owner of its device's audio: every action and audio frame is checked against that binding, call audio is never sent to other tabs of the same device, and a takeover or a disconnect ends the leg. Written last, alone, because it changes shared files. | Video, groups, phones, drop-in, listen-in, voice nodes | Opus |

### 5.2 Contracts between modules

Services and contributions (§4, P1). The core ones are defined where they are implemented; the others in
`@pva/module-contracts` by P11. A consumer treats a missing service as "that module is off" and says so; a module
that needs a provider to run at all names it in `uses`.

| Contract | Kind | Provided by | Used by |
|---|---|---|---|
| `People`, `Privacy` | service | core (P5) | every module with per-person data |
| `SessionControl`, `DeviceControl` | service | core (P7) | assistant-controls, broadcast, calls |
| `Lists` (`addItem` with a dedupe key, `completeByKey`, `removeByKey`, `find`) | service | lists | kitchen |
| `Timers` (`start` with a label and a device to ring on) | service | timers | routines; kitchen later |
| `HomeAssistant`: a transport (§2 row 18). The current state of every exposed entity, a stream of changes, the connection's state (connected, reconnecting, unknown), areas, people, `callService`. After a reconnect it gives a fresh snapshot and consumers must not read that as things having just happened. | service | smart-home | music, presence |
| `Playback` (what plays in a room, pause, resume, volume); the key is defined by P7 | service | music | the host's "stop" and volume (P7) |
| `Mcp`: a transport (§2 row 18). Open a client to an HTTP MCP server with a token provider; list and call tools. | service | mcp | t3-code |
| `CalendarProvider` | contribution | calendar (ICS, CalDAV), google | calendar |
| `BriefingSection` (its `gather` gets the asking turn and uses `settingsFor` and `Privacy.mayReveal`) | contribution | weather, bin-day, calendar, news, reminders, google | briefing |

Events follow §2 row 12. Other modules may subscribe; nothing may depend on an event for correctness.

## 6. Review

- Each PR is reviewed by GPT-6.1 Sol at high reasoning effort, with the PR's diff against its base and this
  document. A review covers the whole diff every round, not only the last fix, and ends with either "approve" or a
  numbered list of findings with file and line, each marked blocking or not.
- Findings are fixed by Opus (open-ended) or Sonnet (well defined) on the PR's branch, with the checks of §3.1.
- At most five rounds; up to ten when a round still finds real problems. A finding in round *n* that was already in
  the diff at round *n − 1* is recorded as a miss of the earlier review, so the reviewer is told to be exhaustive in
  one pass: every file in the diff is read, and the review says which files it read.
- A PR that still has blocking findings when the rounds run out is not approved: its description says so and lists
  them, and the owner is told. Work above it continues only where those findings do not touch a contract it uses.
- Fixes to a lower PR are merged up through the stack.

## 7. Out of scope

- Deployment: the installer, the system unit, `systemd-creds` for the vault, a second backup location.
- Voice nodes (PR #4) and anything that needs one.
- Phone channels (ntfy, Web Push, the HA companion app).
- Authenticated devices, and with them trusted devices, `money` and `security` actions, and stored secrets.
- The kids policy and anything that presents itself as safe for children.
- A filler line for slow tools; text said before a tool call is already spoken while the tool runs.
- Confirmation: repairing core's spoken confirmation and extending it beyond declared actions (§2 row 6), and
  with it everything of class `message`: sending mail, messages to people outside the house.
- Wiring the Jev intent agent as an agent; P7's typed-actions-first switch is the smaller step.
- The second round's core pieces: images in tool results, capture of long dictation, the reading session, a voice
  per language, module widgets and the dashboard, companion pairing.
- Tiers 3 to 5.

## Appendix A. Dependencies P11 installs

Libraries each first version needs beyond the workspace's own packages, taken from each module document's §11. P11
pins them in the workspace catalogue. Versions are the latest that pass `pnpm check` on the day P11 is written.

| Package | Libraries |
|---|---|
| `language` (P2) | none: its grammars and its recurrence arithmetic are its own |
| `net` (P2) | none: Node's own modules and its own address classifier |
| `store-sqlite` (P4) | none: Node's built-in `node:sqlite` |
| core, for presentation (P10) | `sharp` |
| `modules-builtin` (clock, weather) | `date-holidays`, `suncalc` |
| `module-core-tools` | `mathjs`, `nspell`, `dictionary-en`, `dictionary-nl` |
| `module-web-search` | `@mozilla/readability`, `linkedom`, `turndown`, `pdfjs-dist` |
| `module-news` | `feedsmith`, `@mozilla/readability`, `linkedom` |
| `module-calendar` | `tsdav`, `ical.js` (events from outside are expanded with it, not with `@pva/language`) |
| `module-local-info` | `ical.js` |
| `module-kitchen`, `module-lists` | `fuse.js` |
| `module-mcp` | `@modelcontextprotocol/client` (or the single SDK package if version 2 is not published under that name) |
| all others | none |
