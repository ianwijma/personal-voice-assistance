# Storing data

How a module keeps data that outlives a turn, a conversation and an instance, and how it hears what changed
(docs/MODULES-PLAN.md §4 P4). The contract is `packages/core/src/HouseholdStore.ts` and `EventBus.ts`; both stores run
the engine in `StoreEngine.ts`; `@pva/store-sqlite` implements it on a file, `@pva/core/testing` in memory.

## In one paragraph

Serve mode keeps one SQLite file, `data/household.db`, through Node's built-in `node:sqlite` (WAL,
`synchronous = NORMAL`, `secure_delete = ON`, one connection, private to the user: `0600` in a `0700` directory). A
version 2 module declares **document collections** on its manifest (`storage`) and uses them through `ctx.store` in
`shared` and in `start`: `get`, `list`, `insert`, `update`, `remove`, and synchronous transactions. There is nothing
else: no SQL of its own, no full-text search, no change log, no undo. Every committed write is published on the event
bus (`ctx.events`) and reaches the voice pages that may see it. One backup a day goes to `data/backups/`.

**Every call is synchronous on the main thread**, which also frames the browsers' audio. So every read a turn can make
is bounded by construction, not by a timeout: a `list` is one index range read of at most `limit` rows (a shape no
index answers is refused), a `get` is one row, a write is one row, a transaction is one synchronous step. Backups and
the checkpoint after a removal run beside turns, on threads of their own ("Latency" has the numbers).

## Declaring data

```ts
import { defineCollection, defineModule, type Row } from "@pva/core"

const Timer = Schema.Struct({ label: Schema.optionalKey(Schema.String), dueAt: Schema.Finite, state: Schema.Literals(["running", "paused"]) })

export const timers = defineCollection({
  name: "timers",                 // /^[a-z][a-z0-9_]{0,39}$/, unique in the module
  scope: "household",             // household | person | assistant | device | conversation
  schema: Timer,                  // rows are stored in its JSON form (Schema.toCodecJson), which must be an object
  version: 2,                     // raise it when the shape changes (every row is migrated at start) ...
  migrate: { 1: (v1) => ({ ...v1, state: "running" }) },  // ... and say how version n becomes n + 1
  indexes: ["state"],             // fields `list` may filter or order on (one index each; see "Values")
  ambient: (rows: ReadonlyArray<Row<typeof Timer.Type>>, { now }) => [`Timers: ${rows.map(…).join(", ")}.`],
  ambientRows: 10,                // newest rows per scope the lines are made from (1–20)
  project: (row, device) => ({ label: row.value.label, dueAt: row.value.dueAt })  // what voice pages may see
})

export const timersModule = defineModule({
  apiVersion: 2, id: "timers", …,
  storage: { collections: [timers] },
  events: [defineEventType({ type: "timer.ringing", project: (e, device) => … })],                    // optional
  start: ({ store, events }) => …
})
```

A collection the module does not list in `storage.collections` is refused at run time (`StoreError` `invalid`), so the
store always knows every version it must judge. The module id `host` is reserved (the host's event namespace).

## Using it: `ctx.store`

```ts
const t = ctx.store.collection(timers)
const row = yield* t.insert({ dueAt: Date.now() + 600_000, state: "running" })     // Row<A>: id, rev, scope, value, createdAt, updatedAt, updatedBy
yield* t.get(row.id)                                                               // Row | undefined
yield* t.list({ where: { state: "running" }, limit: 20 })                          // one index, see below
yield* t.update(row.id, (v) => ({ ...v, dueAt: v.dueAt + 300_000 }), { expectRev: row.rev })
yield* t.remove(row.id)
yield* ctx.store.transaction((tx) => {                                             // one synchronous step, see below
  const running = tx.collection(timers).list({ where: { state: "running" } })
  for (const r of running) tx.collection(timers).update(r.id, (v) => ({ ...v, state: "paused" }))
  tx.publish("timers.paused", { n: running.length })
  return running.length
})
```

- **Scopes.** The collection's scope is filled in from the turn (`CurrentTurn`): `person` from the turn's person,
  `device` from its device, `assistant`, `conversation`. A call outside a turn (jobs, `shared` code) passes
  `{ scope: { kind: "device", id } }`; a scope of the wrong kind is `invalid`. A person-scoped call with no known person
  fails with `ScopeUnknown` (its `message` says so): turn it into a question ("Whose reminder is this?"). It is never
  written to the household instead. Until P5 adds the device's default person, no turn has a person. Rows of a
  conversation are removed when that conversation ends. Every call works on its scope only: a row of the same id in
  another scope is invisible to it, and is never changed or removed by it.
- **Ids.** Row ids and scope ids are 1–200 letters, digits and `_ . : -` (device ids, assistant ids, UUIDs, person ids
  fit); anything else is `invalid`, also a turn's id that does not fit. An id is stored and compared the same way in
  SQLite and in the in-memory store.
- **Lists.** Each shape is one index, read in its own order up to `limit` (default 100, at most 1000): no `where`,
  ordered by `updatedAt` (the default, newest first), `createdAt` or a declared index; or `where` on **one** declared
  index, ordered by `updatedAt` or by that field. Other shapes (two filter fields, a filter with another order) are
  `invalid`: store a combined field (`"list:done"`) and index that. Ties are broken by `updatedAt`, then by id, in the
  same direction.
- **No search, no undo.** To find text, `list` a bounded set (newest first, or by an index) and match in your code. A
  module that offers "undo" keeps what it needs to reverse its own last operation (in a collection of its own).
- **Updates** read, apply your function and write as one step (nothing can come between them), so concurrent updates
  all land. `f` is a plain synchronous function of the value; it gets a copy (changing it in place changes nothing
  else). `expectRev` makes a row at another rev a `StoreConflict` (an edit a person made on a screen from an older
  read). Changes to amounts are still best written as deltas ("used 250 g").
- **Rev** is a number from the store's one counter, taken by the row's last write: it changes on every write and is
  never used twice in a household, also not when a row is removed and inserted again with the same id, so an
  `expectRev` from before a removal never matches the new row.
- **Copies.** The store keeps its own copy of everything it is given (the value, the scope, the actor) and gives out
  fresh ones: changing an object after a call, or a row a call returned, changes nothing stored.
- **Errors**: `StoreError` (`unavailable`, `read-only`, `invalid`, `failed`), `StoreConflict`, `StoreNotFound`,
  `ScopeUnknown` (together `StoreFailure`). A module whose data is `unavailable` (see "Versions") gets `unavailable`
  from every call, also through a handle it got earlier.
- **Actor.** Every row records who changed it last (`updatedBy`: a turn with its device and person, a job, the admin, a
  tap on a device, the module itself). Pass `{ actor }` from jobs and taps.

### Values

A row's value is a **JSON object** (its schema's JSON form): a schema that allows a string, a number, `null` or a list
as the whole value is refused at write (`invalid`). At most 64,000 characters of JSON.

An **indexed field** holds a string (well-formed Unicode without NUL, at most 500 characters), a finite number or
`true` / `false`, or is missing; anything else there (`null`, a list, an object, a lone surrogate) is refused at write,
and the same values are the only filters `list` accepts. Both stores order them the same way: missing first, then
numbers (`false` = 0, `true` = 1) by value, then strings by code point; a filter `true` also matches `1`. These are
exactly the values for which SQLite's `json_extract` and the in-memory store agree, which a randomised comparison of the
two checks (`packages/store-sqlite/test/parity.test.ts`).

## Transactions

```ts
const n = yield* ctx.store.transaction((tx) => {
  const t = tx.collection(timers)                 // the same operations, as plain synchronous calls
  const row = t.insert({ … })
  t.update(other.id, (v) => …, { expectRev: other.rev })
  tx.publish("timer.started", { id: row.id })     // released after the commit, in order with the changes
  tx.afterCommit(() => …)                         // likewise
  tx.onRollback(() => …)                          // runs (newest first) if the transaction rolls back instead
  return 1
})
```

A transaction is **one synchronous step**: the store begins it, runs your function, and commits it (or rolls it back
when the function throws) without ever yielding. The function cannot await; it does not need to, and nothing else (no
other fiber, no timer, no socket) runs while it does, so there is nothing to lock, nest or interrupt.

1. **All or nothing.** A store failure your function throws and does not catch (`StoreConflict`, …) rolls back and is
   the transaction's failure; anything else it throws rolls back and is a defect. A failure it catches is just a
   failed call: the transaction goes on and commits the rest.
2. **Flat.** A `transaction` started while one runs (only possible from inside the function, by running an effect
   synchronously there) joins it: one commit, one rollback.
3. **Events after the commit, in order.** The data changes, the module events (`tx.publish`, and `ctx.events.publish`
   run from inside the function) and the `afterCommit` callbacks of a transaction are a list on it, released after the
   commit in the order it made them, before anything a later transaction releases. A transaction that throws releases
   nothing.
4. **SQLite cannot disagree.** After a failed statement the store asks SQLite whether its transaction is still open;
   one that SQLite ended itself (the disk is full) fails from then on, and nothing of it is kept. A core service's
   statement may not begin or end a transaction.
5. **A handle is for its function only.** Using `tx` after the function returned is refused.

Keep a transaction small: it holds the event loop while it runs (a one-row write takes about a millisecond).

**Core services** (the scheduler, notifications) keep their own tables in the same file: `store.core("scheduler")`
gives `query`, `run` (each its own transaction) and `migrate([...])` (each migration one or more `;`-separated
statements, run in one transaction with its version, after a backup); trusted code, plain parameterised SQL, tables
`core_<owner>__*`. Inside a module's transaction they take part through its handle: `tx.core("scheduler").run(…)` is
part of that transaction, so a module's write and the scheduler's job commit together or not at all. The host has
`HouseholdStore.transaction((tx) => …)` with `tx.forModule(id)` and `tx.core(owner)`. The in-memory store has no core
SQL (`tx.core` throws `unavailable`); a core service's in-memory state follows a transaction with `tx.onRollback`
and `tx.afterCommit`.

## Versions, upgrades and downgrades

Before any module is made, serve mode judges every module's data (`HouseholdStore.prepare`): the stored version of each
collection of each module (`pva_versions`).

- **Older data**: when a collection's version rose, **every row is migrated at start**, before the module runs:
  decoded at its stored version, migrated, and stored through the same checks as a write (an object, the 64,000
  character limit, indexable fields), in one transaction per module, after a backup of the file
  (`household-<date>-before-<module>.db`). A failure leaves the data as it was and the module `unavailable`, with the
  reason. A collection of more than 20,000 rows (`MAX_MIGRATION_ROWS`) is not migrated (the module is `unavailable`):
  that keeps the stop at start bounded (about half a second, "Latency"). The collection's indexes always match its
  declaration (an index the module no longer declares is dropped).
- **Newer data** (written by a newer version of the module): the module is `unavailable` ("written by a newer version
  of this module; update the module. The data is kept as it is.") and its data is never written by the older code: its
  collections and its transactions all fail `unavailable`, and pages never read it. `pnpm start doctor` names it too.
- **A newer core schema** (`pva_meta.schema` above what this assistant knows): serve mode does not start, and says to
  update the assistant or restore a backup this version made. The file is read read-only first, so it is never
  changed (not even switched to WAL).
- A module id the store cannot key (not `/^[a-z][a-z0-9-]{0,39}$/`, `host`, or one two modules share) is
  `unavailable` for stored data.

## Removing: what `remove` guarantees

A row is its current value; there is no history of it. When `remove(id)` returns `true` it has committed that the row
is gone (nothing of it can be read or sent to a page) and `secure_delete` has overwritten the freed space of the pages
it changed. Right after the commit, on a worker thread with a connection of its own, the store checkpoints the
write-ahead log into the file and empties it (`wal_checkpoint(TRUNCATE)`), so the old page images leave
`household.db-wal`. A reader that still holds an older snapshot (a running backup, a command-line mode beside the
server) blocks that: the store never waits for it on the event loop; it tries again (after 1 s, doubling, at most a
minute) until a checkpoint that started after the removal completes; after 10 minutes it is a Health issue
(`removalPendingSince`). A conversation that ends has its rows removed the same way (`endConversation`), and serve
mode removes at start the rows of conversations a previous run left behind (conversations do not outlive a process).

What `remove` cannot reach: **backups**. A removed item stays in the daily backups made before it until they rotate
out after 14 days ("What is kept how long"), in a second backup directory (`HOUSEHOLD_BACKUP_COPY_DIR`) until the
store prunes it there, and in whatever a disk or file system keeps of overwritten blocks. Say so where a person asks to
forget something.

## The event bus: `ctx.events`

```ts
yield* ctx.events.publish("stock.low", { productId }, scope?)                 // published as "kitchen.stock.low"
yield* Effect.forkScoped(Stream.runForEach(ctx.events.subscribe({ prefix: "lists." }), (e) => …))   // in shared's scope
```

On the bus: every committed data change (`<module>.<collection>.changed`, with `change`: the decoded row and the row it
replaced or removed), module events, and the host's `host.turn.ended`, `host.device.connected`,
`host.device.disconnected`, `host.module.state`. A module always publishes under its own id, and no module may have the
id `host`. Module events go through the store (`HouseholdStore.publish`): one published while a transaction runs waits
for its commit and is dropped if it rolls back ("Transactions", rule 3); otherwise it is published at once. Publishing
never waits; each subscriber has its own queue of 256 events and a slow one loses the newest events (counted, logged at
most once per 10 s; a logger or clock that fails stops nothing). In `shared`, a subscription receives events only while
that shared part is the published one: not while a new one is still starting, and nothing once it was replaced or
retired (it ends then). Events are lost at a restart: nothing may depend on one for correctness.

## Pages

Nothing is sent to voice pages by default. A collection opts in with `project(row, device)`, an event type with
`project(event, device)`: what that page may see, or `undefined`. `device` is the **server's record** of the page's
device (its saved name; P5 adds the room and the default person), never what the page said in its `hello`.

**What reaches a page is decided when its frame is built, and a frame is built in the same synchronous step that hands
it to the socket**: the row is read as it is committed at that moment and projected with the device's record then. A
row that was removed, or moved away from the page, before its frame was built never travels.

- After every `welcome` (a reconnect too: a page never keeps household rows across connections) the server sends
  `household.snapshot`, a step at a time: each step reads at most 20 rows of one collection and scope through an index,
  projects them and sends the frames at once. Every message, envelopes included, has at most 256,000 characters and
  the whole snapshot at most 900,000 (both under the protocol's frame limit of 1,048,576); at most the newest 500 rows
  per collection and scope, and 5,000 rows read in all. A collection with nothing the page may see is not in it; one
  cut short or left out is `truncated`. `part` 0, 1, …; the last part is `final` (it may hold no rows). The page drops
  what it held on part 0 and applies the rows on the final one.
- From the moment a snapshot begins, each page has a queue, filled from the store's commit listener (not from the bus,
  so nothing is lost to a slow page) in commit order: the rows commits touched, coalesced (a row is queued once, at
  the place of its last change), and the module events of a type with a projection. **Nothing of the queue is sent
  before the snapshot's final part**, and nothing committed after the snapshot began is missed. Then the queue, one
  entry at a time: for a row, `put` with its projection now when the page may see it, `remove` when the page holds it
  and may not see it any more (or it is gone), nothing otherwise; a removal names only what the page was given (its
  scope and rev), never anything of a row that took the id since.
- A page with more than 2,000 entries waiting gets a fresh snapshot instead (the module events in its queue are then
  lost to it, as to a page that was not connected). A saved change to a device's record (its name; P5: its place and
  default person) gives that device's pages a fresh snapshot.
- A projection that throws or returns something that is not plain JSON (a `BigInt`, a cycle) or more than 64,000
  characters of it hides that row (a page that held it is told `remove`) and is a Health issue of the module; it
  affects nothing else.

Before any projection one function decides by scope (`mayRevealScopeTo` in `HouseholdFeed.ts`): household to every
voice page, device to that device's pages, nothing of assistant, conversation or (until `Privacy.mayReveal`, P5)
person scope. A module whose data is `unavailable` is never read for pages.

**Device ids are not authenticated** (docs/MODULES-PLAN.md §2 rows 5 and 7): a page says which device it is in its
`hello`, and a page that claims a device's id receives that device's rows and what projections give that device. Keep
anything a person would not want read by anyone on the home network out of device scope and out of projections.

## Ambient facts

Collections with `ambient` contribute lines to one host context provider, `Household`, in every turn's context: rows
of the household, the turn's device, person, assistant and conversation (the newest `ambientRows`, default 10, at most
20, per scope; each one bounded index read, synchronous). It returns within its budget by doing bounded work only: it
checks the time before each collection and stops reading once 50 ms have passed (so the stretch is the budget plus one
bounded read and one call at most), and stops at 600 characters (whole lines, catalog order). Behind the Home setting
"Household facts in every reply" (`HOME_AMBIENT_FACTS`: `off`, the default, `all`, `module-on`). Keep lines short and
computed from the rows alone.

**It is off by default** until its cost is measured on the owner's own language model: the extra context lengthens a
hosted model's prefill, which only a `TurnTrace` of real turns shows (`llmFirstToken`). To measure it:

1. With the server's data in place (`data/household.db`, holding the rows the ambient lines come from), run the live
   benchmark twice with the same WAV files and the same `LLM_PROVIDER`:
   `pnpm start bench --live --rounds 5 turns/` and `pnpm start bench --live --rounds 5 --ambient turns/`. `--ambient`
   adds the `Household` provider (as `all` would) to every turn; both runs read the database read-only, also beside a
   running server.
2. Compare the `llmFirstToken` and `playbackStart` medians and worst cases of the two tables. The local cost of
   building the lines alone is measured in `packages/store-sqlite/test/ambientLatency.test.ts` (it does not include
   the model).
3. Switch it on in Settings › Home when the difference is acceptable.

## CLI modes

`pnpm start text`, `voice`, `bench`, … open `household.db` read-only (beside a running server), so version 2 modules
read their data and every write fails with `read-only` ("changes are made by the server"). Without a file (a warning
says so when a module keeps data), or with one that cannot be opened here, they get an empty read-only store. Ambient
facts are serve mode only (and `bench --live --ambient`). A command-line mode that keeps a read open holds an older
snapshot, which delays the checkpoint after a removal until it lets go.

## Durability

`synchronous = NORMAL` in WAL mode: a commit is safe against the assistant crashing, but a power loss or an operating
system crash can lose the last transactions committed before it (those whose log was not yet synced). A module must
not treat a committed write as surviving a power cut (an alarm set a second before one may be gone). The daily backup
is the recovery point for a damaged file.

## Backups

- The server makes `data/backups/household-<date>.db` once a day (the first a minute after start), and copies each to
  `HOUSEHOLD_BACKUP_COPY_DIR` when set. A backup is SQLite's online backup made through a **connection of its own**, in
  one step on SQLite's worker thread, so turns are never held up by it ("Latency"). One backup at a time, also across
  processes: a backup waits while another holds `data/backups/.backup.lock` (the server's daily one and `pnpm start
  household backup`; a lock left by a process that died is taken over). Each is written to a temporary file of its own (`….part-<pid>-<random>`), made
  one self-contained file (no log beside it), synced and published with one `rename`. Every file and directory the
  store makes is private to the user (`0600`, `0700`), whatever the umask; a backup that stays and is readable by
  others (an older one, one copied in by hand) is narrowed when the store prunes.
- On demand: `pnpm start household backup` (works while the server runs).
- `pnpm start doctor` checks that the database opens, passes SQLite's quick check, is not from a newer version, that no
  module's data in it is newer than that module (judged read-only against the catalog), and that the last backup is
  less than 48 hours old. The Health page in serve mode shows the backup checks, backups that could not be removed and
  a pending removal checkpoint at every check ("Check again" too; they read only file times and the store's state); the
  quick check reads the whole file, so it is the doctor's alone.

### What is kept how long

| What | Where | Removed |
|---|---|---|
| Daily backups | `data/backups/household-<date>.db`, and the second directory | after 14 days (by the date in the name or the file time, whichever is older), and beyond the newest 14 |
| Backups before an upgrade | `data/backups/household-<date>-before-<module>.db` | after 14 days |

The server prunes once a day and after every backup, without exception (also when it means no backup is left: the
Health page then says there is none). A backup that could not be removed (permissions, a read-only share) is reported,
on the Health page too, never counted as removed. So 14 days after a removal, the removed item is in no file the store
manages, as long as the server ran and pruning succeeded.

### Restoring a backup

1. Stop the server (`systemctl --user stop pva` or Ctrl+C).
2. Move `data/household.db`, `data/household.db-wal` and `data/household.db-shm` somewhere else (keep them until the
   restored data is known to be right).
3. Copy the backup (one self-contained file) to `data/household.db` and make it private: `chmod 600 data/household.db`.
4. Start the server. Pages reconnect and get a fresh snapshot.

## Latency

`packages/store-sqlite/test/latency.test.ts` on 100,000 rows of about 1 KB (one collection with two indexes), on the
development machine (shared with other agents), the worst of 30 calls each:

| Call | Worst |
|---|---|
| `list` newest 20 (the ambient read) / oldest 20 / `where` on one index / ordered by an index | 2.7 / 0.6 / 0.7 / 0.6 ms |
| `get` | 0.4 ms |
| `update` of one row (its own transaction) | 1.1 ms |
| one snapshot step for a page (20 rows of about 1 KB, projected, frames built) | 1.1 ms |

The longest stop of the event loop (a 1 ms timer) while the work ran, with a turn's read every 2 ms beside it:

| Work | Longest stop |
|---|---|
| a backup (own connection, one step on SQLite's worker thread) | 3.7 ms |
| a removal and the checkpoint after it (worker thread), after a reader let the log grow by 2,000 updates | 12.6 ms |
| migrating 20,000 rows of about 1 KB at start (one transaction; before the server serves) | 512 ms |

The doctor's quick check reads the whole file; it is not on a turn's path.

## Testing a module

`@pva/core/testing` has `makeMemoryHouseholdStore()` and `makeRecordingEventBus()`; `makeTestHousehold([module])`
prepares a store for the module and returns `household` for `makeModuleHost({ household })`. The in-memory store runs
the same engine as the SQLite store (collections, transactions, events, `prepare`) and answers lists in the same order,
so a module tested on it is not surprised by the real store. Both pass the same contract (`@pva/core/store-contract`:
scopes, ids, values, rev, removal, transactions, events in order, migrations, pages, ambient facts), and a randomised
test applies thousands of random operations and transactions to both and compares every answer, every released event
and every row (`packages/store-sqlite/test/parity.test.ts`). Its core SQL is unavailable; a test of a core service on
the in-memory store uses `tx.onRollback` for that service's own state, or `makeSqliteStore({ filename: ":memory:" })`.
