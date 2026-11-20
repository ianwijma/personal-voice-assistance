# Shared state, jobs and notifications for modules

Research and design options, written 2026-11-17. Nothing here is built. Every interface below marked **Proposal** is
a sketch for discussion, not the contract; the contract stays docs/ARCHITECTURE.md until a design doc replaces a part
of it. Paths with line numbers point at `main` as of commit `70b15ec`; Effect paths are relative to
`node_modules/effect/src/` of the installed `effect@4.1.4`.

**A.** A timer set on one device must be visible to, and cancellable from, any device and any assistant; likewise
household data (to-do list, recipes, pantry, a self-filling shopping list). Modules need shared data and jobs that
outlive a turn, a conversation and a connection. **B.** Notifications: timers that ring, reminders, results,
announcements, and "what did I miss?".

## 0. Recommendations at a glance

| Decision | Recommendation | Section |
|---|---|---|
| Topology | One authoritative server, many thin devices (browsers, voice nodes). Keep the change log op-based so a second server stays possible, but do not build replication. | §3 |
| Store | One SQLite file `data/household.db` (WAL), through `effect/sql` + `@effect/sql-sqlite-node@4.1.4` (which uses Node's built-in `node:sqlite`, no native build), behind a core `HouseholdStore` service. | §4.1 |
| Data shape | Plain rows (document collections by default, module-owned SQL tables on request) plus one append-only change log. Event sourcing only inside modules whose domain is a ledger (pantry stock). | §4.2 |
| Scopes | `household`, `person`, `assistant`, `device`, `conversation`, declared per collection. | §4.3 |
| Turn context | A new `CurrentTurn` reference (device, assistant, conversation, person, source) provided around tool and action runs, like `CurrentTurnTrace` today. | §4.5 |
| Scheduler | Own small scheduler on SQLite tables, one fiber, wall-clock due times, an explicit missed-while-down policy per job kind. Effect `Cron` (stable) for recurrence. Not Effect workflow/cluster (unstable, heavy). | §6 |
| Event bus | In-process `PubSub` fed from the change log; a new `household.*` push to voice connections with replay from a sequence number. | §5 |
| Cross-agent reads | Module tools stay the main path; plus host-built "ambient facts" in `LlmRequest.context` (running timers, next alarm, unread count) for every assistant, whether or not it has the module. | §7 |
| Notifications | One `Notifications` service: priority, audience, ring policy (origin first, escalate), quiet hours, voice "stop/snooze" without a wake phrase while ringing, an inbox, delivery via device cue + spoken announcement + optional phone push (Web Push first, ntfy second). | §8 |
| Identity | Add household `Person` records; actor = device-default person until voice identification exists; never use voice identity for anything security relevant. | §4.6 |

## 1. What exists today

**Persistence.** Everything durable is JSON under `PVA_DATA_DIR` (default `<repo>/data`,
`apps/assistant/src/serve/SettingsStore.ts:160`): `settings.json` (module settings, assistants, device types,
devices), secrets in the vault, favourites files. Writes are atomic temp-file-then-rename
(`SettingsStore.ts:561-565`) and serialised; `serve` is the only writer, enforced by an advisory `flock` on
`data/writer.lock` (`apps/assistant/src/serve/DataDirLock.ts`). There is no database and no per-module data store:
a module gets only its validated settings and `setStatus` (`packages/core/src/ModuleDefinition.ts:30-38`).
"Conversations stay in memory, as today" (`docs/ASSISTANTS.md:238`).

**Jobs.** `apps/assistant/src/serve/jobs.ts` is long-running *admin* work (model downloads) with progress, log and
cancel, broadcast to every page (`serveMode.ts:1130`). It is in memory ("A server restart forgets them",
`jobs.ts:13`), at most two running, and its `ToolId` is a closed protocol allowlist
(`packages/protocol/src/jobs.ts:12`). It is not a scheduler; the proposal keeps it and adds a separate `Scheduler`.
**Push channels.** One WebSocket per tab/node. `SessionHub.broadcast` sends to every connection (admin-only types
filtered, `SessionHub.ts:86,156-171`) and `toSession` to one device's connections (`SessionHub.ts:88`). There is no
topic subscription and no replay after reconnect beyond the `welcome` snapshot.

**Speaking without being asked.** The conversation input `Say { text }` (`packages/core/src/ConversationEvents.ts:119`)
speaks a canned text; `SessionDispatcher.send(assistant, Say)` (`apps/assistant/src/serve/SessionDispatcher.ts:137-141`)
routes it to one assistant's conversation on one device. Today it interrupts the running turn
(`packages/core/src/Conversation.ts:1688-1691`) and a canned reply is not recorded in history
(`Conversation.ts:385,1028,1327`), so the assistant cannot later say what it announced. Nothing in the server calls it
yet. The design docs list notifications and background triggers as deferred
(`docs/UI-AND-MODULES.md:453`, `docs/AGENTS-AND-INTENTS.md:1868`).

**Tool context.** A tool is `execute(input)` (`packages/core/src/Module.ts:13`), an action `run(params)`
(`packages/core/src/Actions.ts:184`): neither knows which device, assistant, conversation or person a call came
from. The only per-turn ambient value is `CurrentTurnTrace`, a `Context.Reference` (`packages/core/src/TurnTrace.ts:76`)
provided around synthesis (`Conversation.ts:1450`). A module's `context` providers are read every turn with a 50 ms
budget (`packages/core/src/ModuleHost.ts:268`, wrapped at `:432`) and reach harness agents too (Claude Code receives
`input.context`, `packages/agent-claude-code/src/agent.ts:422`).

**Module instances.** In serve mode a module runs one instance per distinct set of effective settings
(`ModuleHost.ts:18-19`), so state kept in instance memory is split across instances and lost on every settings
change. Shared state has to live outside the instance.

**Devices, people, rooms.** Devices are recorded at hello (at most 64, `apps/assistant/src/serve/devices.ts:76`);
one device type `web-voice` (`packages/protocol/src/devices.ts:183`); voice nodes exist on the unmerged
`t3/standalone-triggered-voice-service` branch (docs/VOICE-NODES.md there). There is no person/user concept and no
room field. A voice session is discarded 30 minutes after its device's last connection
(`apps/assistant/src/serve/VoiceSessions.ts:13`). **Value parsing**: core already parses spoken durations and numbers locally (`packages/core/src/ValueParsing.ts:619`,
`NumberWords.ts`), useful for "ten minutes" and "about 250 grams".

## 2. Prior art

### 2.1 Shared state and jobs

**Home Assistant.** One in-memory state machine of entities (`entity_id`, state, attributes, `last_changed`, a
`context` with `user_id`/`parent_id`) plus an event bus where every state change is a `state_changed` event; history
goes to a recorder database (SQLite by default). Modules ("integrations") expose typed entity platforms such as the
[to-do list entity](https://developers.home-assistant.io/docs/core/entity/todo), whose capabilities are feature flags
(create, update, delete) and whose actions (`todo.add_item`) target an entity, area, floor or label
([action docs](https://www.home-assistant.io/actions/todo.add_item/)). Lesson: a *typed* shared surface (an entity
kind with a fixed schema) lets any agent and any UI work with any list, whoever implemented it.

**HA voice timers** ([Voice chapter 7](https://www.home-assistant.io/blog/2024/06/26/voice-chapter-7/)) are the
closest prior art to question A. In the [timer manager source](https://raw.githubusercontent.com/home-assistant/core/dev/homeassistant/components/intent/timers.py)
timers are keyed by id, each carrying the `device_id`, `area` and `floor` of the satellite that set it. Finish, pause
and update events go only to that device's handler. A request from another device finds a timer by name, then area,
then start duration, and breaks ties by the asking device, then its area, then its floor; still ambiguous is an error
("which timer?"). A timer may instead carry a conversation command that runs when it ends ("turn off the oven in 10
minutes"). Timers are in memory: they do not survive a restart, and they are not entities, so the UI cannot list them
([community complaint](https://community.home-assistant.io/t/wth-cant-we-see-timers-set-by-voice-within-ha/1031095);
a [third-party project](https://djelibeybi.github.io/voice-assistant-persistent-timers) exists only to make them
persistent). Lesson: copy the matching rules, fix persistence and visibility.

**Alexa and Google.** Timers historically belonged to the device that set them; both later allowed stopping a ringing
timer from another room ([Google, 2020](https://9to5google.com/2020/09/18/stop-google-assistant-alarm-timer-any-room/):
"stop the timer in the kitchen"; [Alexa](https://www.smarthomeassistent.de/alexa-timer-und-wecker-jetzt-auch-von-anderen-echo-geraeten-aus-beenden/)).
Amazon's Alexa Voice Service Alerts interface has the cloud send `SetAlert` to the device, which stores the alert and
rings it itself, so it rings even without a connection (from the AVS documentation as I know it; its old
[overview page](https://developer.amazon.com/docs/alexa-voice-service/alerts-overview.html) now returns 404, so this
is unverified today). Lesson: ring where set by default, stop from anywhere, and let a device that can hold its own
alerts do so.

**OpenVoiceOS.** Skills talk over an internal message bus ([bus service](https://openvoiceos.github.io/ovos-technical-manual/bus_service));
alarms, timers and reminders are one skill ([ovos-skill-alerts](https://pypi.org/project/ovos-skill-alerts/0.0.1a4))
with its own storage, and missed alerts were a known gap. Lesson: a bus without a shared store leaves every skill to
reinvent persistence. **Node-RED context** has three scopes (node, flow, global); its file store flushes every 30 s
and loses unflushed data on a hard kill ([docs](https://nodered.org/docs/api/context/store/localfilesystem)). Lesson:
scopes yes, write-behind caching no.

**Grocy** ([site](https://grocy.info/)). The pantry model to borrow: products with a stock unit, purchase and consume
units and per-product unit conversions; a minimum stock amount that drives "add missing products to the shopping
list"; stock held as entries (amount, best-before date, location) and changed only through logged transactions
(purchase, consume, inventory correction) that can be undone by transaction id; recipes whose ingredients are
checked against stock ("fulfillment"). The [API](https://raw.githubusercontent.com/grocy/grocy/master/grocy.openapi.json)
has `POST /stock/transactions/{id}/undo`, `POST /stock/shoppinglist/add-missing-products` and
`GET /recipes/fulfillment`. An option is to not build a pantry at all and write a Grocy adapter module (§9.2).

**Local-first sync.** For several authoritative replicas: CRDT databases such as
[cr-sqlite](https://github.com/vlcn-io/cr-sqlite) (a SQLite extension; maintenance pace unclear), document CRDTs
(Automerge, Yjs), or an event log with a sync server. Effect 4.1.4 ships one of the latter: `effect/eventlog`
(`eventlog/EventLog.ts`, `EventJournal.ts`, `SqlEventJournal.ts`, `EventLogServer*.ts`, with optional encryption),
`@stability unstable`. Only relevant if §3's option T3 is chosen. **Durable job runners for Node.** Redis- or Postgres-backed ones (BullMQ 6.7.7, pg-boss 12.38.2, Graphile Worker
0.18.0 on npm today) bring a server we do not run. SQLite-backed ones exist but are young and small
([Sidequest](https://docs.sidequestjs.com/), liteque, workmatic and others, see
[a survey](https://dev.to/iikareem/stop-over-engineering-your-nodejs-background-jobs-5dge)). None knows about
devices, quiet hours or "missed while down". A household scheduler is small (§6), so owning it is cheaper than
adapting one.

### 2.2 What Effect 4.1.4 really offers (checked in the installed package)

| Need | In `effect@4.1.4` | Stability | Fit |
|---|---|---|---|
| SQL client, migrations | `effect/sql` (`sql/SqlClient.ts`, `sql/Migrator.ts`, `SqlModel`, `SqlSchema`); docs `ai-docs/src/40_sql/10_basics.ts` | unstable | Good. Driver `@effect/sql-sqlite-node@4.1.4` (latest on npm, peer `effect ^4.1.4`) imports `DatabaseSync` and `backup` from `node:sqlite` (`SqliteClient.ts:36` in the tarball): no native module. Not installed yet. |
| `node:sqlite` itself | Node 22.22.1 on this machine: works, prints an `ExperimentalWarning`; unflagged since 22.13, stability 1.1 on the v22 line, release candidate from v25.7 ([docs](https://nodejs.org/api/sqlite.html)) | experimental | Acceptable; `backup()` is present (checked). |
| Key-value store | `persistence/KeyValueStore.ts` (`layerFileSystem` :451, `layerSql` :640) | unstable | Too weak for queries; fine for module blobs. |
| Durable queue | `persistence/PersistedQueue.ts` (`layerStoreSql` :2430, SQLite supported) | unstable | Possible base for the "long task" queue; not for timers (no list/pause/extend). |
| Durable workflows, sleeps | `workflow/Workflow.ts`, `DurableClock.ts`, `DurableDeferred.ts`; `WorkflowEngine.layerMemory` is explicitly not durable (`WorkflowEngine.ts:720-732`); durability comes from `cluster/ClusterWorkflowEngine.ts` | unstable | Heavy: needs the cluster stack. |
| Single-process cluster | `cluster/SingleRunner.ts` ("requires a SQL client because mailbox messages and replies are stored in SQL", :1-12), `ClusterCron.ts`, `DeliverAt.ts`; SQLite dialect handled in `SqlMessageStorage.ts` | unstable | Works on SQLite in principle, but sharding, entities and message storage to run timers is a lot of machinery to own, debug and upgrade. |
| Cron expressions | `Cron.ts` (`parse` with time zone :614, `next` :869, `sequence` :1213) | **stable** | Use for recurring jobs. |
| Pub/sub, reactive refs | `PubSub.ts`, `SubscriptionRef.ts`, `Schedule.ts` | **stable** | Use for the in-process bus. |
| Write → read invalidation | `reactivity/Reactivity.ts` (the SQLite driver uses it) | unstable | Optional; the change log does the same job explicitly. |

Conclusion: use `effect/sql` with the SQLite driver as a storage library, `Cron`/`PubSub` as stable building blocks,
and write the scheduler on top. Everything in `effect/sql` is marked unstable, so it sits behind our own
`HouseholdStore` interface and is pinned through the workspace catalog like `effect` itself. Workflow + `DurableClock`
on `ClusterWorkflowEngine` + `SingleRunner` would give durable sleeps, but it brings sharding and entity mailboxes into
a one-box server and models a timer as a sleeping workflow, which makes "list all timers", "add five minutes" and
"pause" awkward. Revisit if tasks grow into multi-step resumable work; `PersistedQueue` is the smaller step for that.

### 2.3 Notifications

- **Alexa**: notifications are queued and shown as a pulsing yellow ring until asked ("what are my notifications?",
  "dismiss all"); Do Not Disturb holds them back; announcements are one-way to every Echo; Drop In is a live call
  ([overview](https://maketecheasier.com/smart-home/alexa-echo-lights-explained)).
- **Google**: "broadcast" to all or to a room ("broadcast to the kitchen …"), replies go back to the sender
  ([help](https://support.google.com/assistant/answer/9071582)).
- **Home Assistant**: `assist_satellite.announce` (optional pre-announce chime, then a message) and
  `assist_satellite.start_conversation` (announce, then listen and run the pipeline on the answer); a satellite busy
  announcing refuses a second announcement (`SatelliteBusyError`), states `idle / listening / processing / responding`
  ([entity docs](https://contributors.home-assistant.io/core/entities/assist-satellite/),
  [action](https://www.home-assistant.io/actions/assist_satellite.start_conversation/)). Phone push through the
  companion app, with iOS critical alerts that sound through silent mode and Do Not Disturb
  ([docs](https://companion.home-assistant.io/docs/notifications/critical-notifications)).
- **Self-hosted phone push**: [ntfy](https://docs.ntfy.sh/) (HTTP publish, priorities 1-5, action buttons; Android
  fully self-hosted; iOS instant delivery needs a poll relay through ntfy.sh/APNs carrying only a message id,
  [known issues](https://docs.ntfy.sh/known-issues/)); Gotify (Android only); [Apprise](https://github.com/caronc/apprise)
  (a Python fan-out library, 130+ services: a sidecar, not a dependency). **Web Push** needs HTTPS and a service
  worker; on iOS only for a web app added to the Home Screen, from 16.4
  ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
  [Apple](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)).
  Payloads are end-to-end encrypted, but delivery goes through Apple's, Google's or Mozilla's push service: a hosted
  dependency, so optional under the local-first rule.
- **Interruption research**: people rate proactive speech positively when it is relevant and well-timed
  ([Reicherts et al., "May I Interrupt?", CUI 2021](https://discovery.ucl.ac.uk/10152524/1/Rogers_May%20I%20unterrupt%20-%20Proactive%20Voice%20Assistants%20-%20Accepted%20Version-Reicherts%20et%20al.pdf));
  timing at natural breakpoints matters (Cha et al., "Is Now a Good Time to Talk?", CHI 2019); users want permission
  and a cue before the assistant acts ([summary of Zargham et al.](https://arxiv.org/pdf/2505.09938)); and too many
  interruptions turn helpful into annoying ([Miksik et al.](https://arxiv.org/abs/1905.05851)). Practical rules: a
  cue before speech, never talk over the owner or another reply, batch low-value items into an inbox, let the person
  say "not now".

## 3. Topology

| Option | What it is | Implies |
|---|---|---|
| **T1** one server, thin devices (today) | Browsers and voice nodes stream audio; the server runs everything and holds all state | One SQLite file, one writer (`DataDirLock.ts` already enforces it), no conflicts between replicas. If the server is down, nothing rings: devices need a fallback for alerts (§8.5). |
| **T2** one server, "fat" nodes | Nodes run wake word / STT / TTS locally (docs/VOICE-NODES.md §8 on its branch) but no household state | Same as T1 for state. A node can cache its own pending alerts. |
| **T3** several authoritative servers | Each site/box has its own engines and data; shared data replicates | Multi-master sync (CRDT or event log), conflict rules per collection, and a rule for *who rings* a timer. Large ongoing cost. |
| **T4** primary + standby | A second box receives backups or a streamed copy, promoted by hand | Cheap resilience; no multi-writer. |

"Deploying to a server and a couple of other devices" reads as T1/T2. **Recommendation: T1 now (T2 when nodes get
local speech), T4 through the backup in §4.8.** Keep two properties so T3 stays possible without committing to it:
every change in the change log is an *operation* with a globally unique id (not only a new value), and
quantities change by deltas ("consume 250 g"), which commute.

## 4. The shared data layer

### 4.1 Engine

| Option | For | Against |
|---|---|---|
| JSON files per module (like `settings.json`) | No dependency; same pattern as today | Whole-file rewrites, no queries ("what can I make with what I have"), no transactions across files, no change log |
| **SQLite via `effect/sql` + `@effect/sql-sqlite-node` (node:sqlite)** | Transactions, indexes, migrations (`Migrator`), online backup, one file, no native build | `node:sqlite` experimental on Node 22 (warning); `effect/sql` unstable; synchronous calls run on the main thread |
| SQLite via `better-sqlite3` (13.2.0) | Mature, fast | Native module, rebuilt for the server's platform and every Node major |

**Recommendation: SQLite through `@effect/sql-sqlite-node`**, in a new package (`packages/store-sqlite`) that
implements a core `HouseholdStore` interface, so the driver can be swapped for `better-sqlite3` if `node:sqlite`
disappoints. WAL mode, `synchronous=NORMAL`, one connection, writes serialised. Because calls are synchronous on the
main thread, which also runs the turn detector and the web audio framing, every statement must be small (single-row
writes, indexed reads). The cost on a turn is to be measured with `TurnTrace` (the context-provider read happens
before `llmRequestSent`), not assumed.

### 4.2 Plain tables, a change log, ledgers where the domain is one

Event sourcing for everything (state = fold over events) gives audit, undo and sync, but every read model, migration
and fix becomes a replay problem. Plain tables are simple but lose "who changed what" and make undo and replication
hard. **Middle road:** rows are the truth; every write also appends one row to a `changes` table in the same
transaction (`seq`, op id, module, collection, scope, row id, op, new rev, actor, time, a small patch). The log feeds
the bus (§5), reconnect replay, "what did I change?", undo of the last change, and a future sync. Retain it by age
(proposal: 90 days) and keep ledger collections forever. A module whose domain *is* a ledger keeps it as its own table: the pantry's stock transactions (Grocy's `stock_log`)
are the record, and current stock is a cached sum that can be rebuilt.

### 4.3 Scopes

| Scope | Key | Examples | Who sees it |
|---|---|---|---|
| `household` | — | timers, to-do and shopping lists, pantry, recipes | every device and assistant |
| `person` | `PersonId` | "my reminders", a person's calendar token | devices where that person is present or the default person; admin |
| `assistant` | `AssistantId` | an assistant's notes or persona memory | that assistant's turns |
| `device` | `DeviceId` | the kitchen display's preferred list, a node's volume history | that device |
| `conversation` | conversation id | scratch state of a multi-turn flow | that conversation; deleted when it ends (`Agent.endConversation` already marks the moment) |

A collection declares its scope once; the store derives the scope id from `CurrentTurn` (§4.5), so a tool writes
"my reminder" without passing ids, and a background job writes with the scope stored on the job.

### 4.4 Declaring data (Proposal)

```ts
// Proposal, packages/core: given to `start` next to `settings` and `setStatus`.
interface ModuleContext<A> {
  readonly settings: A
  readonly setStatus: (status: StatusLine | undefined) => void
  readonly store: ModuleStore          // namespaced to this module id, shared by all its instances
  readonly scheduler: ModuleScheduler  // jobs owned by this module id (§6)
  readonly notify: Notifications       // §8
  readonly events: ModuleEvents        // publish own events, subscribe to others' (§5)
}

// Document collections: the default. Rows are JSON validated by a Schema; a version bump migrates on read and
// rewrites lazily, or eagerly in the module's `migrate`.
const Timers = defineCollection({
  name: "timers", scope: "household", version: 2,
  schema: Schema.Struct({ label: Schema.optionalKey(Schema.String), dueAt: Schema.Finite, durationMs: Schema.Finite,
                          pausedRemainingMs: Schema.optionalKey(Schema.Finite), originDevice: DeviceId,
                          createdBy: Actor }),
  migrate: { 1: (v1) => ({ ...v1, durationMs: v1.ms }) },       // N-1 -> N
  ambient: (rows, now) => rows.map((t) => `${t.label ?? "timer"}: ${fmtRemaining(t, now)}`)   // §7
})

interface ModuleStore {
  collection<A>(c: Collection<A>): {
    get(id: string, scope?: ScopeRef): Effect<Row<A> | undefined, StoreError>
    list(query?: { scope?: ScopeRef; where?: Partial<A>; limit?: number }): Effect<ReadonlyArray<Row<A>>, StoreError>
    insert(value: A, scope?: ScopeRef): Effect<Row<A>, StoreError>
    // Optimistic: fails with `Conflict` when the row's rev moved; `update` retries `f` on a fresh read up to 3 times.
    update(id: string, f: (a: A) => A, opts?: { expectRev?: number }): Effect<Row<A>, StoreError | Conflict | NotFound>
    remove(id: string, opts?: { expectRev?: number }): Effect<void, StoreError | Conflict>
  }
  // Module-owned SQL for modules that need joins (pantry, recipes): tables prefixed `m_<moduleId>__`, migrations
  // with effect/sql's Migrator keyed by module id; `sql` refuses statements outside the prefix.
  readonly sql?: ScopedSqlClient
  readonly transaction: <X, E, R>(work: Effect<X, E, R>) => Effect<X, E | StoreError, R>
}
type Row<A> = { id: string; rev: number; scope: ScopeRef; value: A; createdAt: number; updatedAt: number; updatedBy: Actor }
```

Other modules read a collection only through tools or the module's declared `exports` (a read-only view by name), not
by reaching into its tables: a module's schema stays its own to migrate.

### 4.5 Turn context (Proposal)

```ts
// Proposal, packages/core: provided by Conversation around every tool call and action run (as CurrentTurnTrace is
// provided around synthesis today) from a value serve mode adds to TurnSetup. Absent in CLI modes and in jobs.
export const CurrentTurn = Context.Reference<TurnContext | undefined>("@pva/core/CurrentTurn", { defaultValue: () => undefined })
interface TurnContext {
  readonly turnId: number; readonly conversationId: string
  readonly assistantId?: string; readonly deviceId?: string; readonly deviceName?: string; readonly room?: string
  readonly person?: { readonly id: PersonId; readonly how: "device-default" | "voice" | "chosen"; readonly confidence?: number }
  readonly source: "voice" | "text"
}
type Actor = { readonly kind: "turn"; readonly turn: TurnContext } | { readonly kind: "job"; readonly jobId: string }
          | { readonly kind: "admin" } | { readonly kind: "ui"; readonly deviceId: string }
```

Additive: existing tools ignore it. It is what makes "set a timer" ring in the right room and "my reminders" mean
someone.

### 4.6 Identity: who said it

Today the system knows the device, never the person. Options, cheapest first:

1. **Device-default person**: each device record gets an optional `person` (the study's laptop is Ian's) and a
   household default. Zero latency, wrong when someone else speaks.
2. **Chosen on a screen device**: the voice page shows who is using it.
3. **Voice identification**: a local speaker-embedding model compared with enrolled people. sherpa-onnx, already the
   recogniser here, ships speaker-embedding extractors (3D-Speaker, WeSpeaker models,
   [docs](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html)); running it on the turn's audio in
   the existing worker would add work per turn, to be measured before it is turned on.

**Recommendation:** add `Person` records (name, optional default devices, optional voice profile) and use option 1
now; treat voice identity as a hint with a confidence, used to pick *whose* list, never to authorise. Data without a
confident person goes to the household scope, and a person-scoped request without one asks ("whose reminder?") or
falls back to the device-default person.

### 4.7 Concurrency, conflicts, units

- One writer process and serialised writes mean no lost updates inside a transaction. Read-modify-write across a
  tool's await uses `rev`: `update` re-reads and re-applies `f` on conflict, so two devices adding to the shopping
  list both land.
- Quantities change by **delta operations**, not by setting a value: "I used 250 g" is `consume(rice, 250 g)`,
  so two people consuming at once both count, and the change log can undo exactly one.
- Stock never goes below zero silently: clamp, record `inventoryUncertain: true`, and say so ("I had only 200 g of
  rice; I've set it to zero").
- **Units**: store amounts as a decimal in the product's base unit (g, ml, piece), keep the words said
  (`"about 250 grams"`) and an `approx` flag; per-product conversions (a cup of rice = 185 g, a pack = 500 g) as
  Grocy does. Fuzzy words map to `approx` amounts ("a handful" uses the product's default portion or asks once and
  remembers), and "some" changes nothing but marks the stock uncertain. Show approximate stock as "about 750 g". Parse
  numbers and units locally with core's `ValueParsing` (extended with mass and volume units), not by the model, so the
  intent path can do it without an LLM.

### 4.8 Backup and export

- Daily online backup with `node:sqlite`'s `backup()` to `data/backups/household-<date>.db` (keep 14), plus on
  demand from admin; an optional second directory (a mounted share, a standby box: T4). Settings and the vault are
  backed up separately as today.
- Export per module as JSON (module-declared exporter; the store's generic dump otherwise), import into an empty
  collection. Admin page: "Download household data".
- A failed migration leaves the previous file: migrations run inside a transaction, after a pre-migration backup.

## 5. Event bus

**Proposal.** One in-process `PubSub<HouseholdEvent>` (stable `effect/PubSub`), fed by the store after each commit
(from the change log) and by modules and the scheduler for non-data events.

```ts
// Proposal
type HouseholdEvent = {
  readonly seq?: number                // from the change log; absent for ephemeral events
  readonly at: number; readonly module: string; readonly type: string   // "timer.started", "list.changed", "notification.ringing"
  readonly scope: ScopeRef; readonly actor: Actor; readonly data: unknown
}
interface ModuleEvents {
  publish(type: string, data: unknown, scope?: ScopeRef): Effect<void>     // namespaced: `<moduleId>.<type>`
  subscribe(filter: { module?: string; type?: string }): Stream<HouseholdEvent>   // runs in the module's scope
}
```

- Front ends: new server messages `household.snapshot` (in `welcome`: what this device may see, with the last
  `seq`) and `household.event`, sent per connection after an audience filter (household scope to every voice
  connection, device scope to that device, person scope to devices where that person is the default or present).
  A reconnecting client sends its last `seq` in `hello`; the server replays from the change log or sends a fresh
  snapshot. No countdown ticks over the wire: a timer carries `dueAt` and the client counts down.
- Modules: the shopping-list module subscribes to `pantry.stock.low`; an automation module could subscribe to
  `timer.finished`.
- Ephemeral events (ringing, acknowledged) are not logged as data changes but are recorded by the notification
  service's own table (§8.4).

## 6. Jobs and the scheduler

### 6.1 Kinds

| Kind | Example | Fires | Missed while the server was down |
|---|---|---|---|
| `timer` | "10 minutes" | once, `dueAt = setAt + duration` | ring at start, saying how late ("Your pasta timer went off 3 minutes ago") |
| `alarm` | "wake me at 7" | wall-clock time in `HOME_TIME_ZONE` | ring if less than 15 min late, otherwise inbox |
| `reminder` | "remind me to call mum at 5" | time, later also place or event | deliver late, marked late |
| `recurring` | "every Monday put out the bins", nightly backup | `Cron` + time zone | run the last missed occurrence once, not all of them |
| `task` | "research this and tell me when done" | starts now, runs in the background | the fiber died with the process: report "interrupted by a restart", re-run only if the task said it is idempotent |
| `deferred command` | "turn off the oven in 10 minutes" (HA's conversation-command timers) | once | ask before running late side effects; drop after a limit |

### 6.2 Design (Proposal)

```ts
// Proposal
interface ModuleScheduler {
  schedule(job: {
    kind: JobKind; key?: string                       // key: one live job per (module, key), e.g. "timer:pasta"
    at: { at: number } | { inMs: number } | { cron: string; timeZone?: string }
    scope: ScopeRef; origin?: { deviceId?: string; assistantId?: string; conversationId?: string; person?: PersonId }
    onDue:                                            // what happens when due
      | { notify: NotificationRequest }               // data only: rings even while the module restarts
      | { handler: string; payload: unknown }         // a handler the module registered with `handle`
    missed: "fire-late" | { fireIfWithinMs: number } | "skip" | "inbox"
  }): Effect<JobRow, SchedulerError>
  handle<P>(handler: string, payload: Schema.Codec<P>, run: (p: P, job: JobRow) => Effect<void, unknown>): Effect<void, never, Scope>
  pause(id: string): Effect<JobRow>; resume(id: string): Effect<JobRow>
  reschedule(id: string, at: number): Effect<JobRow>; cancel(id: string): Effect<void>
  list(filter?: { kind?: JobKind; scope?: ScopeRef }): Effect<ReadonlyArray<JobRow>>
  runTask<A>(task: { label: string; origin: JobRow["origin"]; work: Effect<A, unknown>; onDone: (a: A) => NotificationRequest }): Effect<JobRow>
}
```

- A `jobs` table (id, module, kind, key, state `scheduled | paused | running | done | cancelled | failed | missed`,
  `dueAt` epoch ms, `remainingMs` when paused, cron, scope, origin, onDue, missed policy, attempts). One fiber holds a
  single sleep until the earliest `dueAt` and is woken by any schedule change; a due job is claimed in a transaction
  (`scheduled → running`) so it fires once.
- **Wall clock, not monotonic**: due times are absolute epoch milliseconds, because they must survive a restart.
  The scheduler re-checks after every wake-up and on a clock jump of more than a few seconds (NTP correction after
  boot on a Pi without an RTC); alarms are recomputed from their wall-clock time in the home time zone, so a DST
  change does not shift "7:00".
- **Module not running**: `{ notify }` jobs fire without module code. `{ handler }` jobs wait while the module is off
  (state shown in admin), and a module that is removed has its jobs listed for the owner to cancel. With several
  instances (§1), the handler of the instance used by the job's origin assistant runs, else any running instance.
- **Tasks** are fibers forked in the scheduler's scope (not the turn's), so they outlive the turn and the conversation;
  at most N running (proposal: 2, like admin jobs), cancellable by voice ("stop the research") and from admin.
- Admin `Jobs` (`serve/jobs.ts`) stay what they are: downloads with byte progress.

## 7. How any agent sees another module's state

1. **Module tools and actions** stay the main path. Because state is in the shared store, the timers module's
   `timer_list` and `timer_cancel` answer the same on every device and for every assistant that has the module on.
   The matching rules follow HA: name, then the asking device, its room, then everything; ambiguity is a question,
   not a guess. Read tools are `speculative: true`.
2. **Ambient facts.** A host-built context provider (`household`) assembles each collection's `ambient` lines for the
   turn's device and person: running timers with remaining time, the next alarm within 12 h, unread notifications,
   a running task. It goes into `LlmRequest.context` (outside the cached prefix, docs/ARCHITECTURE.md "Context-provider
   output"), so "how long is left on the pasta?" works for an assistant without the timers module, and harness agents
   get it too. Cap it (proposal: 600 characters, oldest last), read only indexed rows within the 50 ms budget. It
   adds tokens to every turn; whether that changes `llmFirstToken` is to be measured with `TurnTrace` before it is on
   by default.
3. **Per-assistant visibility**: an assistant's module switches decide which *tools* it has; a new household setting
   decides whether ambient facts are shared with every assistant (default on) or only with assistants that have the
   module.

## 8. Notifications

### 8.1 The service (Proposal)

```ts
// Proposal, core interface; serve mode implements delivery.
interface Notifications {
  send(n: NotificationRequest): Effect<NotificationId, NotifyError>
  update(id: NotificationId, patch: { text?: string; until?: number }): Effect<void>   // "timer extended"
  resolve(id: NotificationId, how: "acknowledged" | "cancelled"): Effect<void>        // stops it everywhere
  inbox(filter: { deviceId?: string; person?: PersonId; unreadOnly?: boolean }): Effect<ReadonlyArray<NotificationRow>>
}
interface NotificationRequest {
  source: { module: string; jobId?: string }
  dedupeKey?: string                            // a second send with the same key updates instead of duplicating
  kind: "alert" | "timer" | "alarm" | "reminder" | "info" | "result" | "question"
  priority: "critical" | "high" | "normal" | "low"
  audience: { household: true } | { person: PersonId } | { devices: ReadonlyArray<DeviceId> } | { room: string }
  origin?: { deviceId?: string; assistantId?: string; conversationId?: string }
  ring?: "origin" | "origin-then-room" | "origin-then-everywhere" | "everywhere" | "none"   // default by kind, §8.3
  content: { title: string; spoken?: string; cue?: CueId; actions?: ReadonlyArray<"stop" | "snooze" | "extend" | "open"> }
  followUp?: { assistantId: string; record: boolean; listenSeconds?: number }   // start a conversation, §8.6
  expiresAt?: number; requireAck?: boolean
  channels?: ReadonlyArray<"device-audio" | "device-visual" | "phone">   // allowed; the router chooses
}
```

### 8.2 Priority and what each may do

| Priority | Examples | Speaks / rings | During a turn on that device | Quiet hours / DND | Phone |
|---|---|---|---|---|---|
| `critical` | smoke or leak from HA | cue + speech, repeats | interrupts | ignored | yes, iOS critical where available |
| `high` | timer, alarm the person set | cue, then speech | after the reply's current clause ends | rings visual-only on screens, audible only for alarms the person set | if no device acknowledged in N s |
| `normal` | reminder, "research is done" | cue + one spoken line | queued until the device is idle | inbox only | optional per person |
| `low` | "the bins go out tomorrow", stock low | none | — | — | no; inbox and screen badge |

**Quiet hours and DND**: household quiet hours (proposal 22:00-07:00 in `HOME_TIME_ZONE`), per-device DND (a switch on
the screen, or "do not disturb until eight", itself a scheduled job that ends DND), per-person quiet hours; effects as
in the table. An alarm the person set is the exception: it is the point of the alarm.

### 8.3 Targets, fan-out and dedupe

- **Targets**: the router resolves the audience with the device registry plus new device fields: `room`,
  capabilities (`speaker`, `screen`, `push`) from the device type, presence (connected; a turn within N minutes means
  someone is there), DND, and per-person default devices. A phone is a channel of a person, not a registry device.
- **Default ring policy by kind**: timer and alarm `origin-then-room` (like HA, Alexa, Google: it rings where it was
  set, and on the other devices in that room if the origin is offline); reminder to a person: the device where that
  person was last active, else their default devices, else the phone; critical: `everywhere`; result: `origin`,
  else inbox plus phone.
- **Escalation** (proposal): a `high` notification not acknowledged after 60 s may widen one step (room, then
  everywhere, then phone), per a household setting that defaults to off for timers.
- **One decision per notification**: a notification is delivered once per device; an acknowledgement on any device
  resolves it and every other device stops (`notification.resolved`). `dedupeKey` turns a repeat send (a sensor
  flapping) into an update.

### 8.4 Acknowledging and snoozing by voice

While a device is ringing, a **ringing window** in the route gate accepts a short closed set without the wake phrase:
"stop", "ok", "snooze", "five more minutes", "add five minutes", "what is it?" (Dutch equivalents too). It is matched
locally (core's wake-phrase matcher and `ValueParsing` for the minutes), handled by the notification service before
any agent, and answered with a short canned confirmation; anything else goes to the normal routing. This is how HA
satellites and Google stop timers; a TV saying "stop" can at worst stop a ring, which is harmless. From another
device: "stop the kitchen timer" goes through the timers module tools (§7). The notification row records every
state change (`pending → ringing → acknowledged | snoozed | expired | missed`), with device and actor.

### 8.5 How a firing timer behaves on each kind of device

- **Screen device (browser)**: the server sends `notification.ring { id, cue, title, dueAt, actions, until }`; the
  page plays a **local cue in a loop** (not server-streamed audio, so it does not compete with the output lease and
  keeps working while a reply plays elsewhere on the device), shows a card with Stop / Snooze / +5 min, and after
  the first cue the server speaks one line ("Pasta timer, ten minutes, is done") through the device's output when it
  is idle. Ringing stops after 10 minutes (proposal) and becomes "missed" in the inbox with a badge, Alexa's yellow
  ring. A tab without the audio (an observer) shows the card only.
- **Headless voice node**: the same message; the node plays its cached cue file in a loop (docs/VOICE-NODES.md §4.4 on
  its branch already has cues and volume), then the spoken line, and opens the ringing window. No screen, so missed
  items are announced at the next wake ("Before that: you missed one timer"), once, and kept in the inbox.
- **Offline device** (node lost Wi-Fi, laptop closed): the server sees no connection and applies the next step of
  the ring policy. For nodes, optionally (proposal) send pending alerts of that device in advance
  (`alerts.sync { id, dueAt, cue, title }`) so the node rings by itself if it cannot reach the server at the due time,
  as AVS devices store their alerts; on reconnect it reports "rang locally, acknowledged at …". With the server down
  (T1) this node-local copy is the only thing that still rings.

### 8.6 Spoken announcements and follow-up conversations

Two changes to how the server speaks on its own (today's `Say` interrupts and is not recorded, §1):
- **`Announce`** (proposal: a new `ConversationInput`): waits for the running turn to finish (unless `critical`),
  plays the cue then the text, and, when `record` is set, commits an assistant message such as
  `[Announced: pasta timer finished]` to that assistant's conversation on that device, so "what was that?" can be
  answered.
- **Follow-up**: after an announcement with `followUp`, the route gate opens that assistant's follow-up window on the
  device (it exists for replies already, docs/ASSISTANTS.md §3.4), so "yes, read it to me" needs no wake phrase. This
  is HA's `start_conversation`. A `task` result uses it: "Your research on heat pumps is ready. Shall I summarise
  it?" The result itself is stored (household or person scope), so it can be read later from any device ("read me
  the heat pump research").

### 8.7 The inbox and phone push

A `notifications` table holds every notification with its state and deliveries; missed, low and normal-in-quiet-hours
items stay unread until heard or dismissed, expiring after 7 days (proposal). A built-in tool `notifications_read`
(and an intent-path action) reads them for the device's person or household, oldest first, grouped ("two timers went
off while you were out, and your research is done"); hearing them marks them read. Ambient facts carry the unread
count, screen devices a badge, admin a full list.

**Phone push**: channels as adapter packages (they are provider SDKs or HTTP APIs): **Web Push** first (`notify-webpush`: VAPID keys
in the vault, subscriptions per person from the voice page installed as a Home Screen app; requires the existing HTTPS
setting; payloads encrypted, delivery via the browser vendor's push service), then **ntfy** (`notify-ntfy`: a URL and
topic per person; fully self-hosted on Android, iOS through ntfy.sh's id-only relay). Both optional and off by default,
per the local-first rule. Push carries title and actions; "Stop" on the phone calls back the server.

## 9. Two worked examples

**9.1 Timer across devices.**
1. Kitchen node: "hey Jeff, set a pasta timer for ten minutes". The timers action stores a household row
   `{ label: "pasta", dueAt, durationMs, originDevice: kitchen }` and schedules a `timer` job with
   `onDue: { notify: { kind: "timer", priority: "high", ring: "origin-then-room" } }`; `timer.started` puts a
   countdown chip on the study laptop.
2. Study, another assistant: "how long on the pasta?" Ambient facts already say "pasta: 6 min 10 s left". "Add five
   minutes": the timers tool finds the one pasta timer, reschedules the job, the chip updates.
3. Due: the kitchen node rings (local cue, loop), says "Pasta timer is done"; "stop" there resolves it everywhere.
   After a restart the job fires at the same wall-clock time, or at start, saying how late.

**9.2 Pantry and shopping list.**
- Own module (`pantry`, module-owned SQL): `products` (base unit, conversions, min stock, default portion),
  `stock_tx` (ledger: purchase/consume/correct, amount in base unit, `approx`, words said, actor, undo of), `stock`
  (cached per product), `recipes` + `recipe_items` (amount, unit, optional), and a shopping list that is a household
  to-do collection shared with the to-do module.
- "Add a kilo of rice" = purchase 1000 g; "I used about 250 grams" = consume 250 g `approx`; "undo that" = undo the
  last transaction by this actor.
- After each consume the module checks min stock and publishes `pantry.stock.low`; the shopping-list module (or the
  pantry itself) adds the item with a `dedupeKey` per product, and a `low` notification goes to the inbox.
- "What can I make in 15 minutes with what I have?": a tool returns recipes whose required items are in stock and
  whose time is at most 15, with what is short; the model words it. Recipe *suggestion* beyond stored recipes is the
  model's own knowledge plus the stock list, clearly labelled as such.
- **Alternative**: a `grocy` adapter module using Grocy's API for stock, shopping list and recipe fulfilment; the
  assistant then owns only voice parsing. Less to build, one more service to run.

## 10. Suggested build order

(1) `HouseholdStore`, `packages/store-sqlite`, change log, backup, `CurrentTurn`, `Person` and device `room`;
(2) scheduler and a `timers` module with HA's matching rules, plus ambient facts, measured on and off with `TurnTrace`;
(3) ringing on browsers and nodes, the ringing window, `Announce`, inbox, quiet hours; (4) `household.*` messages,
voice-page chips and cards, admin views; (5) a typed list collection (to-do, shopping), then pantry or Grocy;
(6) `task` jobs with follow-ups, Web Push, ntfy; (7) voice identification as a measured experiment.

## 11. Open questions for the owner

1. **Topology**: one server with thin (later fat) nodes, or do you plan a second server that must work on its own,
   for example at another address? That alone decides whether replication is in scope.
2. **People**: who lives in the house, and do you want per-person data ("my reminders") now, or household only? Is a
   default person per device good enough until voice identification is tried?
3. **Timer ringing**: ring only on the device that set it (falling back to its room when that device is offline),
   or widen to every device after a minute without an answer?
4. **"Stop" without the wake phrase** while something rings: acceptable?
5. **Quiet hours**: which hours, and should reminders and results wait for the morning or go to your phone?
6. **Phones**: iPhone, Android, or both? Is delivery through Apple's/Google's push relay acceptable (Web Push, ntfy on
   iOS), or must it stay fully local (then Android ntfy only)?
7. **Rooms**: add a room to each device, or reuse Home Assistant areas from the Home Assistant module?
8. **Pantry**: build our own, or run Grocy and talk to it? How precise must stock be (is "about" good enough)?
9. **Long tasks** interrupted by a restart: re-run automatically, or just tell you?
10. **Announcements in history**: should an announced timer or result become part of that device's conversation, so
    the assistant can refer to it?
11. **Who may do what**: may anyone cancel anyone's timer and read anyone's reminders, or should person-scoped data
    be private to that person's devices?
12. **Backups**: is a second directory or machine available for the daily household backup?
