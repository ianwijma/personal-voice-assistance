# Storing data

How a module keeps data that outlives a turn, a conversation and an instance, and how it hears what changed
(docs/MODULES-PLAN.md §4 P4; design: research/module-investigation/shared-state-jobs-and-notifications.md §4, §5, §7).
The contract is `packages/core/src/HouseholdStore.ts` and `EventBus.ts`; `@pva/store-sqlite` implements it.

## In one paragraph

Serve mode keeps one SQLite file, `data/household.db` (WAL, `synchronous = NORMAL`, `secure_delete = ON`, one
connection, writes serialised). A version 2 module declares its data on the manifest (`storage`) and uses it through
`ctx.store` in `shared` and in `start`. Every write appends one row to a change log in the same transaction; the log
feeds the event bus (`ctx.events`), undo, voice pages and their replay after a reconnect. Daily backups go to
`data/backups/`.

**Every call is synchronous SQLite on the main thread**, which also frames the browsers' audio. Keep each statement
small: single-row writes, reads through declared indexes, small limits. Never wait on the network inside a
transaction: it holds the database's one connection, and every other read waits for it. On a turn's path (a tool, a
context provider) a read must be an indexed single row or a small range.

## Declaring data

```ts
import { defineCollection, defineModule, type Row } from "@pva/core"

const Timer = Schema.Struct({ label: Schema.optionalKey(Schema.String), dueAt: Schema.Finite, state: Schema.Literals(["running", "paused"]) })

export const timers = defineCollection({
  name: "timers",                 // /^[a-z][a-z0-9_]{0,39}$/, unique in the module
  scope: "household",             // household | person | assistant | device | conversation
  schema: Timer,                  // rows are stored in its JSON form (Schema.toCodecJson)
  version: 2,                     // raise it when the shape changes ...
  migrate: { 1: (v1) => ({ ...v1, state: "running" }) },  // ... and say how version n becomes n + 1
  indexes: ["state"],             // fields `list` may filter or order on (one index each)
  search: [],                     // string fields `search` looks in
  history: "full",                // "none" for content a person may ask to forget (no payloads kept, no undo)
  ambient: (rows: ReadonlyArray<Row<typeof Timer.Type>>, { now }) => [`Timers: ${rows.map(…).join(", ")}.`],
  project: (row, device) => ({ label: row.value.label, dueAt: row.value.dueAt })  // what voice pages may see
})

export const timersModule = defineModule({
  apiVersion: 2, id: "timers", …,
  storage: {
    collections: [timers],
    sql: { migrations: ["CREATE TABLE m_timers__log (id TEXT PRIMARY KEY, at INTEGER NOT NULL)"] }  // optional
  },
  events: [defineEventType({ type: "timer.ringing", project: (e, device) => … })],                    // optional
  start: ({ store, events }) => …
})
```

A collection the module does not list in `storage.collections` is refused at run time (`StoreError` `invalid`), so the
store always knows every version it must judge.

## Using it: `ctx.store`

```ts
const t = ctx.store.collection(timers)
const row = yield* t.insert({ dueAt: Date.now() + 600_000, state: "running" })     // Row<A>: id, rev, scope, value, createdAt, updatedAt, updatedBy
yield* t.get(row.id)                                                               // Row | undefined
yield* t.list({ where: { state: "running" }, orderBy: { field: "createdAt" }, limit: 20 })
yield* t.search("pasta")                                                           // words in the `search` fields
yield* t.update(row.id, (v) => ({ ...v, dueAt: v.dueAt + 300_000 }))              // optimistic, see below
yield* t.remove(row.id)
yield* t.erase(row.id)                                                             // and every earlier payload of it
yield* t.undo()                                                                    // the turn's actor's last change here
yield* ctx.store.transaction(Effect.gen(function*() { … }))                        // all or nothing; events after the commit
```

- **Scopes.** The collection's scope is filled in from the turn (`CurrentTurn`): `person` from the turn's person,
  `device` from its device, `assistant`, `conversation`. A call outside a turn (jobs, `shared` code) passes
  `{ scope: { kind: "device", id } }`; a scope of the wrong kind is `invalid`. A person-scoped call with no known person
  fails with `ScopeUnknown` (its `message` says so): turn it into a question ("Whose reminder is this?"). It is never
  written to the household instead. Until P5 adds the device's default person, no turn has a person. Rows of a
  conversation are deleted when that conversation ends.
- **Optimistic updates.** `update` reads, applies your function, and writes only if the row's `rev` has not moved; on
  a conflict it applies the function again to a fresh read, three attempts in all, then fails with `StoreConflict`.
  `expectRev` makes a moved rev a conflict at once (an edit a person made on a screen from an older read). Changes to
  amounts should be deltas ("used 250 g"), not new totals, so two at once both count.
- **Errors**: `StoreError` (`unavailable`, `read-only`, `invalid`, `refused`, `failed`), `StoreConflict`,
  `StoreNotFound`, `ScopeUnknown`.
- **Actor.** Every change records who made it (`Actor`: a turn with its device and person, a job, the admin, a tap on
  a device, the module itself). "The same actor" for undo is the person when known, else the device, else the
  conversation (`actorKey`). Pass `{ actor }` from jobs and taps.
- **Undo** reverses the last change of the actor in that collection that is not undone yet (insert → removed, update
  → previous value, remove → restored). A row someone else changed since is a `StoreConflict`; nothing is undone.

## Module SQL

For joins (pantry, recipes): tables of your own, named `m_<moduleId>__…` (dashes become underscores:
`m_home_assistant__…`; `ctx.store.sql.table("items")` gives the name). Migrations are an array; `migrations[n]` brings
the schema from version `n` to `n + 1`: a string of `;`-separated statements, or an effect on the guarded `sql`. Never
edit a released migration; add one. At run time: `sql.query(text, params)` and `sql.run(text, params)`, one statement,
`?` placeholders. Record a write in the change log with `ctx.store.logChange({ table, id, op })` when other modules or
"what changed" should see it.

The guard refuses names outside your prefix in any quoting or case (`"pva_docs"`, `[PVA_DOCS]`), names starting with
`sqlite_`, `pragma_`, `pva_` (the store's own), `core_` (core services) or another module's `m_…__`, an existing object
outside your prefix, several statements in one call, `ATTACH`, `PRAGMA`, `VACUUM`, transaction statements, temporary
objects, `dbstat`, `load_extension`, and schema statements outside migrations. After each migration the store also
checks that nothing outside your prefix appeared. `sql.fts5` says whether the build has FTS5
(`CREATE VIRTUAL TABLE m_x__fts USING fts5(…)`); Node 22's bundled SQLite has it. Without it, use `LIKE`. Collections'
`search` uses the store's own FTS5 index, or scans the newest 2,000 rows of the scope when there is none.

The in-memory test store has no module SQL: a module with `storage.sql` is `unavailable` there. Test it on
`makeSqliteStore({ filename: ":memory:" })` from `@pva/store-sqlite`.

## Versions, upgrades and downgrades

Before any module is made, serve mode judges every module's data (`HouseholdStore.prepare`): the stored version of
each collection and of its SQL (`pva_versions`).

- **Older data**: collection rows are migrated when read (and rewritten then, without a new rev); SQL migrations run
  in one transaction per module, after a backup of the file (`data/backups/household-<date>-before-<module>.db`). A
  failed migration rolls back: the file is as it was, the module is `unavailable` with the reason, the backup stays.
- **Newer data** (written by a newer version of the module): the module is `unavailable` ("written by a newer version
  of this module; update the module. The data is kept as it is.") and its data is never opened by the older code.
- **A newer core schema** (`pva_meta.schema` above what this assistant knows): serve mode does not start, and says to
  update the assistant or restore a backup made by this version.

## Change log, retention and forgetting

Each write appends to `pva_changes`: a sequence number, a globally unique operation id, module, collection, scope, row
id, operation, the new rev, the actor, the time, and (for `history: "full"`) the value before and after. Changes older
than 90 days are removed by the daily maintenance (in batches of 500).

`history: "none"` keeps only that a change happened. `erase(id)` removes the row, the payloads of every earlier change
of it, and its search entries; `secure_delete` overwrites the freed pages and a WAL checkpoint after the commit
removes the old page images, so the text is gone from `household.db` and its WAL. **Backups keep it**: an erased item
stays in the daily backups until they rotate out (14 days), and in a second backup directory as long as that keeps
them. Say so where a person asks to forget something.

Core services keep their tables in the same file (`HouseholdStore.core("scheduler")`: tables `core_scheduler__*`,
migrated with `migrate([...])`), and their statements join the transaction they run in, so a module's write and the
scheduler's job commit together.

## The event bus: `ctx.events`

```ts
yield* ctx.events.publish("stock.low", { productId }, scope?)                 // published as "kitchen.stock.low"
yield* Effect.forkScoped(Stream.runForEach(ctx.events.subscribe({ prefix: "lists." }), (e) => …))   // in shared's scope
```

On the bus: every committed data change (`<module>.<collection>.changed`, with `change`: the decoded row and the value
it replaced), module events, and the host's `host.turn.ended`, `host.device.connected`, `host.device.disconnected`,
`host.module.state`. Publishing never waits; each subscriber has its own queue of 256 events and a slow one loses the
newest events (counted, logged at most once per 10 s). Events are lost at a restart: nothing may depend on one for
correctness.

## Pages

Nothing is sent to voice pages by default. A collection opts in with `project(row, device)`, an event type with
`project(event, device)` (`device`: `{ id, name }`; P5 adds the room and the default person): what that page may see,
or `undefined`. The server sends `household.snapshot` after `welcome`, then `household.event` for each change after its
commit: `put` with the projected row when the page may see it now, `remove` when it is gone or hidden now but the page
could see the value it replaced, nothing otherwise. A reconnecting page sends `hello.household.seq`; the replay
follows the same rule per changed row, always with today's row through today's projection (never an older payload).
When the log cannot say what the page had (a long or pruned gap, `history: "none"`, an erased row) it gets a fresh
snapshot. Before any projection one function decides by scope (`mayRevealScopeTo` in `HouseholdFeed.ts`): household
to every voice page, device to that device, nothing of assistant, conversation or (until `Privacy.mayReveal`, P5)
person scope.

## Ambient facts

Collections with `ambient` contribute lines to one host context provider, `Household`, in every turn's context: rows
of the household, the turn's device, person, assistant and conversation (the newest `ambientRows`, default 20, per
scope). 50 ms budget, at most 600 characters (whole lines, catalog order), behind the Home setting "Household facts in
every reply" (`HOME_AMBIENT_FACTS`: `all`, `module-on`, `off`). Keep lines short and computed from the rows alone.

## CLI modes

`pnpm start text`, `voice`, `bench`, … open `household.db` read-only (beside a running server), so version 2 modules
read their data and every write fails with `read-only` ("changes are made by the server"). Without a file, or with
one that cannot be opened here, they get an empty read-only store. Ambient facts are serve mode only.

## Backup and restore

- The server makes `data/backups/household-<date>.db` once a day (an online backup, `node:sqlite`'s `backup()`), keeps
  14, and copies each to `HOUSEHOLD_BACKUP_COPY_DIR` when set. Settings and the vault are backed up separately.
- On demand: `pnpm start household backup` (works while the server runs).
- Export one module's data as JSON: `pnpm start household export <module id> [file]`.
- `pnpm start doctor` checks that the database opens, passes SQLite's quick check, is not from a newer version, and
  that the last backup is less than 48 hours old.

### Restore

1. Stop the server (`systemctl --user stop pva` or Ctrl+C).
2. `pnpm start household restore data/backups/household-2026-11-17.db`. It refuses while the server runs (the writer
   lock), checks the backup with SQLite, moves the current `household.db` (and its `-wal`, `-shm`) aside as
   `household.db.before-restore-<time>`, and puts the backup in its place.
3. Start the server. Pages reconnect with a number from the newer file and get a fresh snapshot.

By hand: with the server stopped, move `household.db`, `household.db-wal` and `household.db-shm` away and copy the
backup to `data/household.db`.

## Testing a module

`@pva/core/testing` has `makeMemoryHouseholdStore()` (the same semantics: scopes, rev, change log, undo, erase,
transactions, events after commit, version refusal) and `makeRecordingEventBus()`; `makeTestHousehold([module])`
prepares a store for the module and returns `household` for `makeModuleHost({ household })`. Both stores pass the
same contract (`@pva/core/store-contract`).
