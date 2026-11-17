# Storing data

How a module keeps data that outlives a turn, a conversation and an instance, and how it hears what changed
(docs/MODULES-PLAN.md §4 P4; design: research/module-investigation/shared-state-jobs-and-notifications.md §4, §5, §7).
The contract is `packages/core/src/HouseholdStore.ts`, `StoreTransactions.ts` and `EventBus.ts`; `@pva/store-sqlite`
implements it.

## In one paragraph

Serve mode keeps one SQLite file, `data/household.db` (WAL, `synchronous = NORMAL`, `secure_delete = ON`, one
connection, private to the user: `0600` in a `0700` directory). A version 2 module declares its data on the manifest
(`storage`) and uses it through `ctx.store` in `shared` and in `start`. Every write appends one row to a change log in
the same transaction; the log feeds the event bus (`ctx.events`), undo and voice pages. Daily backups go to
`data/backups/`.

**Every call is synchronous SQLite on the main thread**, which also frames the browsers' audio. So the store bounds
every read a turn can make by construction, not by a timeout: a `list` is one index range read of at most `limit`
rows (a shape no index answers is refused), a `get` is one row, a `search` reads the newest matches of one scope.
Backups, exports and pruning run beside turns without holding the event loop ("Latency" has the numbers). Never wait
on the network inside a transaction: it holds the database's one connection, and every other call waits for it.

## Declaring data

```ts
import { defineCollection, defineModule, type Row } from "@pva/core"

const Timer = Schema.Struct({ label: Schema.optionalKey(Schema.String), dueAt: Schema.Finite, state: Schema.Literals(["running", "paused"]) })

export const timers = defineCollection({
  name: "timers",                 // /^[a-z][a-z0-9_]{0,39}$/, unique in the module
  scope: "household",             // household | person | assistant | device | conversation
  schema: Timer,                  // rows are stored in its JSON form (Schema.toCodecJson)
  version: 2,                     // raise it when the shape changes (every row is migrated at start) ...
  migrate: { 1: (v1) => ({ ...v1, state: "running" }) },  // ... and say how version n becomes n + 1
  indexes: ["state"],             // fields `list` may filter or order on (one index each; scalar values only)
  search: [],                     // string fields whose words `search` looks for
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
yield* t.list({ where: { state: "running" }, limit: 20 })                          // one index, see below
yield* t.search("pasta")                                                           // words that begin words of the `search` fields
yield* t.update(row.id, (v) => ({ ...v, dueAt: v.dueAt + 300_000 }))              // read, apply, write: one step
yield* t.remove(row.id)
yield* t.erase(row.id)                                                             // and every payload of it
yield* t.undo()                                                                    // the turn's actor's last change here, in this scope
yield* ctx.store.transaction(Effect.gen(function*() { … }))                        // all or nothing; events after the commit
```

- **Scopes.** The collection's scope is filled in from the turn (`CurrentTurn`): `person` from the turn's person,
  `device` from its device, `assistant`, `conversation`. A call outside a turn (jobs, `shared` code) passes
  `{ scope: { kind: "device", id } }`; a scope of the wrong kind is `invalid`. A person-scoped call with no known person
  fails with `ScopeUnknown` (its `message` says so): turn it into a question ("Whose reminder is this?"). It is never
  written to the household instead. Until P5 adds the device's default person, no turn has a person. Rows of a
  conversation are erased when that conversation ends. Every call works on its scope only: a row of the same id in
  another scope is invisible to it, and is never changed, erased or undone by it.
- **Lists.** Each shape is one index, read in its own order up to `limit` (default 100, at most 1000): no `where`,
  ordered by `updatedAt` (the default, newest first), `createdAt` or a declared index; or `where` on **one** declared
  index, ordered by `updatedAt` or by that field. Other shapes (two filter fields, a filter with another order) are
  `invalid`: store a combined field (`"list:done"`) and index that. Ties are broken by `updatedAt`, then by id, in the
  same direction.
- **Indexed fields hold scalars**: strings, finite numbers, `true` / `false`, `null` or nothing; a write with a list or
  an object in one is `invalid`. Both stores order them the same way: missing and `null` first, then numbers
  (`false` = 0, `true` = 1), then strings by code point; a filter `true` also matches `1`.
- **Search.** `search(text)` finds the rows of the scope in which every word of `text` (at most 8) **begins** a word of
  the `search` fields, without case or accents: "milk" finds "Milk" and "milkshake", not "buttermilk"; "creme" finds
  "Crème". Words are runs of letters and digits (`searchTokens`). The most recently written rows come first; default
  20 results, at most 200. The in-memory store gives exactly the same answers.
- **Updates** read, apply your function and write as one step (nothing can come between them), so concurrent updates
  all land. `f` runs inside the store's transaction: keep it a plain function of the value. `expectRev` makes a row at
  another rev a `StoreConflict` (an edit a person made on a screen from an older read). Changes to amounts are still
  best written as deltas ("used 250 g").
- **Rev** is the change-log number of the row's last write: it changes on every write and is never used twice in a
  household, also not when a row is removed and inserted again with the same id, so an `expectRev` from before a
  removal never matches the new row.
- **Errors**: `StoreError` (`unavailable`, `read-only`, `invalid`, `refused`, `failed`), `StoreConflict`,
  `StoreNotFound`, `ScopeUnknown`. A module whose data is `unavailable` (see "Versions") gets `unavailable` from every
  call, also through a handle it got earlier.
- **Actor.** Every change records who made it (`Actor`: a turn with its device and person, a job, the admin, a tap on
  a device, the module itself). "The same actor" for undo is the person when known, else the device, else the
  conversation (`actorKey`). Pass `{ actor }` from jobs and taps.
- **Undo** reverses the last change of the actor in that collection **and scope** (the turn's, or `{ scope }`; a
  person-scoped collection with no person is `ScopeUnknown`) that is not undone yet and still has its values (insert →
  removed, update → previous value, remove → restored). A row someone else changed since is a `StoreConflict`;
  nothing is undone. An erased row's changes are skipped: the change before them is undone instead.

## Transactions

`ctx.store.transaction(work)` (and `HouseholdStore.transaction`, which core services use) is one SQLite transaction;
a transaction inside one is a savepoint. Both stores follow the same model (`packages/core/src/StoreTransactions.ts`):

1. **One transaction at a time.** It holds the store from its begin until its events are out; a call outside any
   transaction waits for it and never sees its uncommitted state.
2. **One savepoint at a time inside it.** While a savepoint is open nothing else of its transaction runs (a fiber of
   the parent waits), so rolling it back takes back only its own work, never a sibling's or the parent's. Concurrent
   work inside one transaction therefore runs one step at a time.
3. **A fiber that outlives its transaction** (forked inside it) fails with `StoreError` ("already ended") instead of
   writing outside it.
4. **Events after the commit, in change-log order.** The data changes and the module events (`ctx.events.publish`)
   of a transaction are published after it commits, in the order they happened, before any later transaction's; a
   savepoint that rolls back drops its events, and an interrupted transaction rolls back.

Do not wait inside a savepoint for a fiber that uses the outer transaction: it waits for the savepoint (rule 2).

## Module SQL

For joins (pantry, recipes): tables of your own, named with your prefix (`ctx.store.sql.prefix`;
`ctx.store.sql.table("items")` gives the name): `m_<moduleId>__` with each dash an underscore (`m_home_assistant__…`);
an id with a double or a trailing dash (`a--b`) is spelled in hex (`mx_612d2d62__`), so no module's prefix ever
starts another's. Migrations are an array; `migrations[n]` brings the schema from version `n` to `n + 1`: a string of
`;`-separated statements, or an effect on the guarded `sql`. Never edit a released migration; add one. At run time:
`sql.query(text, params)` and `sql.run(text, params)`, one statement, `?` placeholders. Record a write in the change
log with `ctx.store.logChange({ table, id, op })` when other modules or "what changed" should see it.

The guard reads your SQL with SQLite's own tokenizer rules and **refuses what it does not fully understand** (a `$` or
`#` parameter, an unterminated comment, a character SQLite would not accept); what it accepts reaches SQLite exactly
as you wrote it. It refuses names outside your prefix in any quoting or case (`"pva_docs"`, `[PVA_DOCS]`,
`'pva_docs'`), names starting with `sqlite_`, `pragma_`, `pva_` (the store's own) or `core_` (core services) or in
another module's namespace (`m_…__…`, `mx_…`), an existing object outside your prefix, several statements in one call,
`ATTACH`, `PRAGMA`, `VACUUM`, `COMMIT`, `SAVEPOINT`, `RELEASE`, `ROLLBACK` (also `RAISE(ROLLBACK, …)` and
`OR ROLLBACK`, which would end the store's transaction), `BEGIN` outside a trigger, temporary objects,
`load_extension`, the build's virtual tables other than `json_each` and `json_tree` (`dbstat`, `fts5vocab`, …), and
schema statements outside migrations. Pass values as `?` parameters: a string literal that looks like another
table's name is refused too. After each migration the store also checks that nothing outside your prefix appeared.
`sql.fts5` says whether the build has FTS5 (`CREATE VIRTUAL TABLE m_x__fts USING fts5(…)`); Node 22's bundled SQLite
has it, and the store needs it for collections' `search`.

The in-memory test store has no module SQL: a module with `storage.sql` is `unavailable` there. Test it on
`makeSqliteStore({ filename: ":memory:" })` from `@pva/store-sqlite`.

## Versions, upgrades and downgrades

Before any module is made, serve mode judges every module's data (`HouseholdStore.prepare`): the stored version of
each collection and of its SQL (`pva_versions`).

- **Older data**: when a collection's version rose, **every row is migrated at start**, before the module runs:
  decoded at its stored version, migrated, and stored through the same checks as a write (the schema, the
  64,000-character limit, scalar indexed fields), with its search words and its indexes; pending SQL migrations run
  too. All of it in one transaction per module, after a backup of the file
  (`data/backups/household-<date>-before-<module>.db`), also when only a collection changed. A failure (one row is
  enough) rolls back: the file is as it was, the module is `unavailable` with the reason, the backup stays. A
  collection's indexes always match its declaration (an index the module no longer declares is dropped).
- **Newer data** (written by a newer version of the module): the module is `unavailable` ("written by a newer version
  of this module; update the module. The data is kept as it is.") and its data is never opened by the older code: its
  collections, its SQL and its transactions all fail `unavailable`, and pages never read it.
- **A newer core schema** (`pva_meta.schema` above what this assistant knows): serve mode does not start, and says to
  update the assistant or restore a backup made by this version. The file is read read-only to find that out, so it
  is not changed at all (not even switched to WAL).

## Change log, retention and forgetting

Each write appends to `pva_changes`: a sequence number (also the row's new rev), a globally unique operation id,
module, collection, scope, row id, operation, the actor, the time, and (for `history: "full"`) the value before and
after. Changes older than 90 days are removed by the daily maintenance (100 per transaction, a yield between them).
`history: "none"` keeps only that a change happened.

### Forgetting: what `erase` guarantees

When `erase(id)` returns `true` it has committed that:

- the row is gone, its search words are gone, and every change of it **in its scope** has lost its values (the log
  keeps that a change happened and by whom, without content); nothing of it can be read, searched, undone or sent to a
  page, and the bus event of the erase carries no content;
- `secure_delete` has overwritten the freed space of the pages it changed.

Right after the commit, in the background, the store checkpoints the write-ahead log into the file and empties it
(`wal_checkpoint(TRUNCATE)`), so the old page images leave `household.db-wal` and the overwritten pages reach
`household.db`. A reader that still holds an older snapshot (a running backup or export, a command-line mode beside
the server) blocks that: the store never waits for it on the event loop; it tries again (after 1 s, doubling, at most
a minute) until the checkpoint completes. `SqliteHouseholdStore.erasePendingSince()` says whether one is pending; after
10 minutes it is a Health issue. A conversation that ends is erased the same way (`endConversation`), and serve mode
erases at start the rows of conversations a previous run left behind (conversations do not outlive a process).

What `erase` cannot reach: **backups**. An erased item stays in the backups made before it until they are removed
(see "What is kept how long": 14 days at most), in a second backup directory (`HOUSEHOLD_BACKUP_COPY_DIR`) as long as
that keeps copies the store has not pruned, and in whatever a disk or file system keeps of overwritten blocks. Say so
where a person asks to forget something.

Core services keep their tables in the same file (`HouseholdStore.core("scheduler")`: tables `core_scheduler__*`,
migrated with `migrate([...])`), and their statements join the transaction they run in, so a module's write and the
scheduler's job commit together.

## The event bus: `ctx.events`

```ts
yield* ctx.events.publish("stock.low", { productId }, scope?)                 // published as "kitchen.stock.low"
yield* Effect.forkScoped(Stream.runForEach(ctx.events.subscribe({ prefix: "lists." }), (e) => …))   // in shared's scope
```

On the bus: every committed data change (`<module>.<collection>.changed`, with `change`: the decoded row and the value
it replaced; an erase carries neither), module events, and the host's `host.turn.ended`, `host.device.connected`,
`host.device.disconnected`, `host.module.state`. A module event published inside a transaction waits for its commit
and is dropped if it rolls back ("Transactions", rule 4). Publishing never waits; each subscriber has its own queue of
256 events and a slow one loses the newest events (counted, logged at most once per 10 s). Events are lost at a
restart: nothing may depend on one for correctness.

## Pages

Nothing is sent to voice pages by default. A collection opts in with `project(row, device)`, an event type with
`project(event, device)` (`device`: `{ id, name }`; P5 adds the room and the default person): what that page may see,
or `undefined`. Only **committed current rows** are ever projected, never a value from the change log or from an
event.

- After every `welcome` (a reconnect too: a page never keeps household rows across connections) the server sends
  `household.snapshot`: the rows the page may see now, in parts that each fit one text frame (`part` 0, 1, …, `final`
  on the last; the page drops what it held on part 0 and applies the rows on the final one), at most the newest 500
  rows read per collection and scope and about 4 million characters in all (`truncated` when rows were left out),
  current to change number `seq`.
- Then, after each commit, the changes after that number, read from the change log (not from the bus, so nothing is
  lost to a slow page), coalesced per row: `put` with the row's projection now when the page may see it, `remove`
  when the page holds the row and may not see it any more (or it is gone), nothing otherwise. A row shown and hidden
  again within one transaction never reaches a page that may not see it. A page the log can no longer bring up to
  date (pruned past it) gets a fresh snapshot.
- A projection that throws or returns something that is not plain JSON (a `BigInt`, a cycle) or more than 64,000
  characters of it hides that row (a page that held it is told `remove`) and is a Health issue of the module; it
  affects nothing else.

Before any projection one function decides by scope (`mayRevealScopeTo` in `HouseholdFeed.ts`): household to every
voice page, device to that device, nothing of assistant, conversation or (until `Privacy.mayReveal`, P5) person scope.
A module whose data is `unavailable` is never read for pages. Module events (not data) come from the bus: a page that
is not connected misses them.

## Ambient facts

Collections with `ambient` contribute lines to one host context provider, `Household`, in every turn's context: rows
of the household, the turn's device, person, assistant and conversation (the newest `ambientRows`, default 20, per
scope; each one bounded index read). At most 600 characters (whole lines, catalog order) and a 50 ms budget (a timeout
cannot stop a synchronous read, which is why every read is bounded instead), behind the Home setting "Household facts
in every reply" (`HOME_AMBIENT_FACTS`: `off`, the default, `all`, `module-on`). Keep lines short and computed from the
rows alone.

**It is off by default** until its cost is measured on the owner's own language model: the extra context lengthens a
hosted model's prefill, which only a `TurnTrace` of real turns shows (`llmFirstToken`). To measure it:

1. With the server's data in place (`data/household.db`, holding the rows the ambient lines come from), run the live
   benchmark twice with the same WAV files and the same `LLM_PROVIDER`:
   `pnpm start bench --live --rounds 5 turns/` and `pnpm start bench --live --rounds 5 --ambient turns/`. `--ambient`
   adds the `Household` provider (as `all` would) to every turn; both runs read the database read-only, also beside a
   running server.
2. Compare the `llmFirstToken` and `playbackStart` medians and worst cases of the two tables. The local cost of
   building the lines alone is measured in `packages/store-sqlite/test/ambientLatency.test.ts` (about 0.35 ms per turn
   with zero-delay fakes; it does not include the model).
3. Switch it on in Settings › Home when the difference is acceptable.

## CLI modes

`pnpm start text`, `voice`, `bench`, … open `household.db` read-only (beside a running server), so version 2 modules
read their data and every write fails with `read-only` ("changes are made by the server"). Without a file, or with
one that cannot be opened here, they get an empty read-only store. Ambient facts are serve mode only (and
`bench --live --ambient`). A command-line mode that keeps a read open holds an older snapshot, which delays the
checkpoint after an erase until it lets go.

## Backup and restore

- The server makes `data/backups/household-<date>.db` once a day, and copies each to `HOUSEHOLD_BACKUP_COPY_DIR` when
  set. A backup is SQLite's online backup made through a **connection of its own**, in one step on a worker thread,
  so turns are never held up by it ("Latency"). It is written to a temporary file of its own
  (`….part-<pid>-<random>`), synced and published with one `rename`, so two backups at once (the server and
  `pnpm start household backup`) never meet. A backup is one self-contained file (no log beside it). Every file and
  directory the store makes is private to the user (`0600`, `0700`), whatever the umask.
- On demand: `pnpm start household backup` (works while the server runs).
- Export one module's data as JSON: `pnpm start household export <module id> [file]`: every row of its collections
  and SQL tables (no limit), the content of its full-text tables, from one consistent snapshot read through a
  connection of its own, 500 rows at a time; `omitted` names a full-text index whose content lives in another table
  (that table is exported) or that has none.
- `pnpm start doctor` checks that the database opens, passes SQLite's quick check, is not from a newer version, and
  that the last backup is less than 48 hours old. The Health page in serve mode shows the backup checks and a pending
  erase at every check ("Check again" too; they read only file times); the quick check reads the whole file, so it is
  the doctor's alone.

### What is kept how long

| What | Where | Removed |
|---|---|---|
| Daily backups | `data/backups/household-<date>.db`, and the second directory | beyond the newest 14, and when older than 14 days (the newest one is always kept) |
| Backups before an upgrade | `data/backups/household-<date>-before-<module>.db` | when older than 14 days |
| The database a restore set aside | `data/household.db.before-restore-<time>` | when older than 14 days |
| Change-log rows (with the values of `history: "full"`) | `pva_changes` | after 90 days |

The server prunes them once a day and after every backup. So 14 days after an erase, the erased item is in no file
the store manages (if the server ran meanwhile).

### Restore

1. Stop the server (`systemctl --user stop pva` or Ctrl+C).
2. `pnpm start household restore data/backups/household-2026-11-17.db`. It takes the writer lock (so it refuses while
   the server runs), then: refuses the live database itself as the source; checks the source as SQLite reads it, with
   its write-ahead log (quick check, household data, a schema this version knows); copies it, log included, to a new
   file beside `household.db` and checks the copy; copies the current database, log included, aside as
   `household.db.before-restore-<time>`; folds the current log into the current file; and only then puts the copy in
   place with one `rename`. A failure before that leaves everything as it was. Interrupted (Ctrl+C), it still runs to
   its end before the lock is released, so a server cannot open the database in between.
3. Start the server. Pages reconnect and get a fresh snapshot.

By hand: with the server stopped, keep the old `household.db`, `household.db-wal` and `household.db-shm` somewhere,
delete them, and copy the backup (one self-contained file) to `data/household.db`.

## Latency

`packages/store-sqlite/test/latency.test.ts` on 100,000 rows of about 1 KB (one collection with two indexes and
search words, and 100,000 change-log rows), on the development machine (shared with other agents), the worst of 30
calls each:

| Call | Worst |
|---|---|
| `list` newest 20 (the ambient read) / oldest 20 / `where` on one index / ordered by an index | 2.3 / 0.8 / 1.5 / 1.6 ms |
| `get` | 0.4 ms |
| `search` a common word / a rare word / a two-letter prefix | 4.3 / 1.0 / 2.4 ms |

The longest stop of the event loop (a 1 ms timer) while the work ran, with a turn's read every 2 ms beside it:

| Work | Longest stop |
|---|---|
| a backup (own connection, one step on a worker thread) | 4.9 ms |
| an export of the module (own connection, 500 rows at a time) | 10 ms |
| pruning 100,000 change-log rows (100 per transaction) | 3.3 ms |
| an erase and its checkpoint | 2.3 ms |

The migration of a large collection at start (one transaction, before the server serves) and the doctor's quick
check read a whole collection or file; neither is on a turn's path.

## Testing a module

`@pva/core/testing` has `makeMemoryHouseholdStore()` and `makeRecordingEventBus()`; `makeTestHousehold([module])`
prepares a store for the module and returns `household` for `makeModuleHost({ household })`. The in-memory store runs
the same collection code and the same transaction model as the SQLite store and answers lists and searches the same
way (scalar indexes in one order, the same words), so a module tested on it is not surprised by the real store; both
pass the same contract (`@pva/core/store-contract`: scopes, rev, the change log, undo, erase, transactions with
savepoints, interruption and escaped fibers, events in order, migrations, pages). Its `onRollback(undo)` lets an
in-memory table of a test (the scheduler's) join its transactions.
