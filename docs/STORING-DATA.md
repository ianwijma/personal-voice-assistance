# Storing data

How a module keeps data that outlives a turn, a conversation and an instance, and how it hears what changed
(docs/MODULES-PLAN.md §4 P4). The contract is `packages/core/src/HouseholdStore.ts` and `EventBus.ts`; both stores run
the engine in `StoreEngine.ts`; `@pva/store-sqlite` implements it on a file, `@pva/core/testing` in memory.

## In one paragraph

Serve mode keeps one SQLite file, `data/household.db`, through Node's built-in `node:sqlite` (WAL,
`synchronous = NORMAL`, `secure_delete = ON`, one connection, private to the user: `0600` in a `0700` directory). A
version 2 module declares a data version and **document collections** on its manifest (`storage`) and uses them through
`ctx.store` in `shared` and in `start`: `get`, `list`, `insert`, `update`, `remove`, and synchronous transactions.
There is nothing else, and no SQL anywhere in the interface: the core services (the scheduler, notifications) keep
their data in the same collections, under an owner of their own. Every committed write is published on the event bus
(`ctx.events`) and reaches the voice pages that may see it. One backup a day goes to `data/backups/`.

**Every call is synchronous on the main thread**, which also frames the browsers' audio. So nothing unbounded runs
there, by construction, not by a timeout: a `list` is one index range read of at most 100 rows (a shape no index
answers is refused) of values of at most 16,000 characters, a `get` is one row, a write is one row, a transaction is one
synchronous step; the main connection never checkpoints and never waits for a lock. Backups, checkpoints and the
removal of an ended conversation run beside turns, on threads of their own or in bounded steps ("Latency" has the
numbers).

## Declaring data

```ts
import { defineCollection, defineModule, type Row } from "@pva/core"

const Timer = Schema.Struct({ label: Schema.optionalKey(Schema.String), dueAt: Schema.Finite, state: Schema.Literals(["running", "paused"]) })

export const timers = defineCollection({
  name: "timers",                 // /^[a-z][a-z0-9_]{0,39}$/, unique in the module
  scope: "household",             // household | person | assistant | device | conversation; never changes
  schema: Timer,                  // rows are stored in its JSON form (Schema.toCodecJson), which must be an object
  migrate: { 1: (v1) => ({ ...v1, state: "running" }) },  // how a value of data version 1 becomes version 2
  indexes: ["state", ["state", "dueAt"]],  // what `list` may filter or order on (see "Lists" and "Values")
  ambient: (rows: ReadonlyArray<Row<typeof Timer.Type>>, { now }) => [`Timers: ${rows.map(…).join(", ")}.`],
  ambientRows: 10,                // newest rows per scope the lines are made from (1–20)
  project: (row, device) => ({ label: row.value.label, dueAt: row.value.dueAt })  // what voice pages may see
})

export const timersModule = defineModule({
  apiVersion: 2, id: "timers", …,
  storage: { version: 2, collections: [timers] },   // one data version for all the module's collections
  events: [defineEventType({ type: "timer.ringing", project: (e, device) => … })],                    // optional
  start: ({ store, events }) => …
})
```

A collection the module does not list in `storage.collections` is refused at run time (`StoreError` `invalid`), and so
is another declaration of a listed name whose shape differs (a handle kept from before, or one defined elsewhere):
every operation uses the declaration the store was prepared with. The module ids `host` and `core` are reserved (the
host's and the core services' namespaces).

**Core services** declare collections the same way and pass them to `prepare` under an owner `core.<name>`
(`store.prepare(modules, [{ owner: "core.scheduler", storage: { collections: [jobs] } }])`); no module id can be such
an owner (module ids have no dot). They reach them through `HouseholdStore.forCore("core.scheduler")`, which only the
host has, and the host's transaction spans a module's collections and a core service's
(`store.transaction((tx) => { tx.forModule(id)…; tx.forCore("core.scheduler")… })`). A module's `ctx.store` and its
`tx` are built for that module and have no method that names another owner.

## Using it: `ctx.store`

```ts
const t = ctx.store.collection(timers)
const row = yield* t.insert({ dueAt: Date.now() + 600_000, state: "running" })     // Row<A>: id, rev, scope, value, createdAt, updatedAt, updatedBy
yield* t.get(row.id)                                                               // Row | undefined
yield* t.list({ where: { state: "running" }, orderBy: { field: "dueAt" } })        // one index, see below
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
  written to the household instead. Until P5 adds the device's default person, no turn has a person. Every call works
  on its scope only: a row of the same id in another scope is invisible to it, and is never changed or removed by it.
- **Ids.** Row ids and scope ids are 1–200 letters, digits and `_ . : -` (device ids, assistant ids, UUIDs, person ids
  fit); anything else is `invalid`, also a turn's id that does not fit. An id is stored and compared the same way in
  SQLite and in the in-memory store. The id of a row of a projected collection can reach every page that could see
  its scope (in a removal, "Pages"): do not put anything private in it.
- **Lists.** Each shape is one index range, read in its own order, of at most `limit` rows (default 20, at most 100;
  more is `invalid`: page through with an order and a filter). The shapes, and only these:
  - no `where`: ordered by `updatedAt` (the default, newest first), `createdAt` (newest first by default), or a field
    declared as an index of its own (ascending by default);
  - `where` on **one** field declared as an index of its own: ordered by `updatedAt` (default, newest first),
    `createdAt`, or that field itself (both then by `createdAt`);
  - `where` on field `f` ordered by another field `g`: only with the pair `[f, g]` declared in `indexes`
    (`["state", "dueAt"]`: "scheduled jobs by due time" is one range), ascending by default.

  Anything else (two filter fields, an order no index has) is `invalid`: store a combined field (`"list:done"`) and
  index that. Ties are broken by `createdAt`, then by id, in the same direction.
- **No search, no undo.** To find text, `list` a bounded set (newest first, or by an index) and match in your code. A
  module that offers "undo" keeps what it needs to reverse its own last operation (in a collection of its own).
- **Updates** read, apply your function and write as one step (nothing can come between them), so concurrent updates
  all land. `f` is a plain synchronous function of the value; it gets a copy (changing it in place changes nothing
  else), and must return the new value (a promise is `invalid`). `expectRev` makes a row at another rev a
  `StoreConflict` (an edit a person made on a screen from an older read). Changes to amounts are still best written as
  deltas ("used 250 g").
- **Rev** is a number from the store's one counter, taken by the row's last write: it changes on every write and is
  never used twice in a household, also not when a row is removed and inserted again with the same id, so an
  `expectRev` from before a removal never matches the new row.
- **Copies.** The store keeps its own copy of everything it is given (the value, the scope, the actor) and gives out
  fresh ones: changing an object after a call, or a row a call returned, changes nothing stored.
- **Errors**: `StoreError` (`unavailable`, `read-only`, `invalid`, `busy`, `failed`), `StoreConflict`, `StoreNotFound`,
  `ScopeUnknown` (together `StoreFailure`). A module whose data is `unavailable` (see "Versions") gets `unavailable`
  from every call, also through a handle it got earlier. `busy`: another connection held the database's write lock
  longer than the store waits (about 50 ms, on a timer, never on the event loop); nothing was done; try again.
- **Actor.** Every row records who changed it last (`updatedBy`: a turn with its device and person, a job, the admin, a
  tap on a device, the module itself). Pass `{ actor }` from jobs and taps.

### Values

A row's value is a **JSON object** (its schema's JSON form): a schema that allows a string, a number, `null` or a list
as the whole value is refused at write (`invalid`). At most 16,000 characters of JSON (with the 100-row limit this
bounds the worst legal `list`; "Latency").

An **indexed field** holds a string (well-formed Unicode without NUL, at most 500 characters), a finite number or
`true` / `false`, or is missing; anything else there (`null`, a list, an object, a lone surrogate, `NaN`) is refused at
write, and the same values are the only filters `list` accepts. These are exactly the values that survive SQLite
unchanged: the value of every indexed field is kept in a column of its own, bound from JavaScript (strings as UTF-8
text, numbers as 8-byte reals, `true` / `false` as 1 / 0), and SQLite never parses it out of the row's JSON (its JSON
number parser is not exact: `58.00995086` would come back as `58.009950860000004`, `1000000000000000100` as an integer
no JavaScript number equals). `-0` is stored as `0`. Both stores order them the same way: missing first, then numbers
(`false` = 0, `true` = 1) by value, then strings by code point; a filter `true` also matches `1`. A randomised
comparison of the two stores checks this (`packages/store-sqlite/test/parity.test.ts`).

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
when the function throws) without ever yielding. Only the store begins and ends it (there is no SQL to do it with), and
nothing else (no other fiber, no timer, no socket) runs while it does, so there is nothing to lock, nest or interrupt.

1. **Synchronous or it fails.** A function that returns a promise (an `async` function), an Effect, a generator or a
   function is refused: everything it did is rolled back and the transaction fails with `StoreError` `invalid`
   ("transactions cannot await"); the type already refuses promises and Effects. Do the asynchronous work before the
   transaction or after it (`tx.afterCommit`).
2. **All or nothing.** A store failure your function throws and does not catch (`StoreConflict`, …) rolls back and is
   the transaction's failure; anything else it throws rolls back and is a defect. A failure it catches is just a
   failed call: the transaction goes on and commits the rest.
3. **Flat.** A `transaction` started while one runs (only possible from inside the function, by running an effect
   synchronously there) joins it: one commit, one rollback. A joined function that returns a promise dooms the whole
   transaction, also when its caller catches that.
4. **Events after the commit, in order.** The data changes, the module events (`tx.publish`, and `ctx.events.publish`
   run from inside the function) and the `afterCommit` callbacks of a transaction are a list on it, released after the
   commit in the order it made them, before anything a later transaction releases. A transaction that rolls back
   releases nothing and runs its `onRollback` hooks. A hook that throws stops no other.
5. **SQLite cannot disagree.** After a failed statement and before the commit the store asks SQLite whether its
   transaction is still open: one that SQLite ended itself (the disk is full) fails whole, also when your function
   caught the error, with a `StoreError`; so does a `COMMIT` that fails. The rollback hooks run either way.
6. **A handle is for its function only.** `tx` and every collection got from it are valid while the function runs;
   any use afterwards (after it returned, from a hook, in a later transaction) is refused with `invalid`.

Keep a transaction small: it holds the event loop while it runs (a one-row write takes under a millisecond).

## Versions, upgrades and downgrades

Each owner (a module, a core service) has **one data version** for all its collections (`storage.version`, default 1),
stored with its id; each collection's scope and shape (a canonical description of its schema's JSON form, its scope
and its indexes) are stored with it. Before any module is made, serve mode judges every owner's data
(`HouseholdStore.prepare`):

- **Older data**: when the version rose, every collection of the module is brought to it **at start**, before the
  module runs, in one transaction, after a backup of the file (`household-<date>-before-<module>.db`, copied to the
  second directory too): every row of a collection whose shape changed or that has a migration between the versions
  is decoded at its stored version, migrated (`migrate[n]` for each version `n` passed), and stored through the same
  checks as a write (an object, the 16,000 character limit, indexable fields, the new schema), and the indexes follow
  the declaration. A failure rolls all of it back and leaves the module `unavailable`, with the row and the reason. At
  most 20,000 rows are migrated (`MAX_MIGRATION_ROWS`; more makes the module `unavailable`): that keeps the stop at
  start bounded (about 0.6 s, "Latency").
- **The same version, another shape**: refused. Changing a collection's schema or indexes needs a higher version (and
  a migration where the values change); the module is `unavailable` until then and nothing is changed. Adding or
  changing an index is such a change, so its migration checks the indexed fields of every row.
- **A collection's scope never changes**, also not with a new version (refused the same way): declare a new collection
  and move the rows in your own code.
- **Newer data** (written by a newer version of the module): the module is `unavailable` ("written by a newer version
  of this module; update the module. The data is kept as it is.") and nothing of its data is read, migrated or deleted
  by the older code: its collections and its transactions all fail `unavailable`, its conversation rows are not
  removed, and pages never read it. This holds also when the older code does not declare some of the newer
  collections. `pnpm start doctor` names it too.
- **Data no declaration names any more** (a collection the module dropped, a module that left the catalog) is never
  deleted by the store: it stays, unreachable, and `doctor` lists it (`HouseholdStore.undeclared()`). Declared again
  with a later version, it is migrated like any other.
- **Read-only** (the CLI modes): an owner is usable only when its stored version, every collection's shape and the
  indexes in the file match what the code declares; otherwise it is `unavailable` there too ("the server makes the
  upgrade when it starts"). A collection the server never prepared reads as empty.
- **A newer core schema** (`pva_meta.schema` above what this assistant knows): serve mode does not start, and says to
  update the assistant or restore a backup this version made. The file is read read-only first, so it is never
  changed (not even switched to WAL).
- A module id the store cannot key (not `/^[a-z][a-z0-9-]{0,39}$/`, `host`, `core`, or one two modules share) is
  `unavailable` for stored data.

## Removing: what `remove` guarantees

A row is its current value; there is no history of it. When `remove(id)` returns `true` it has committed that the row
is gone (nothing of it can be read or sent to a page) and `secure_delete` has overwritten the freed space of the pages
it changed. Right after the commit, the store's checkpointer (a worker thread with a connection of its own) copies the
write-ahead log into the file and empties it (`wal_checkpoint(TRUNCATE)`), so the old page images leave
`household.db-wal`. A reader that still holds an older snapshot (a running backup, a command-line mode beside the
server) blocks that: the store never waits for it on the event loop; it tries again (after 1 s, doubling, at most a
minute) until a checkpoint that started after the removal completes; after 10 minutes it is a Health issue
(`removalPendingSince`). Every start makes such a checkpoint before serving, which also completes a removal whose
checkpoint was still waiting when the previous process stopped.

A conversation that ends has its rows hidden at once and removed in bounded steps off the turn's path
(`endConversation`: 100 rows per step, each its own transaction, yielding between them), and serve mode removes at
start, the same way, the rows of conversations a previous run left behind (conversations do not outlive a process).

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
id `host` or `core`. Module events go through the store (`HouseholdStore.publish`): one published while a transaction
runs waits for its commit and is dropped if it rolls back ("Transactions", rule 4); otherwise it is published at once.

Publishing never waits and **never runs a subscriber's code on the publisher's stack** (or on the stack of the commit
that released the event): each subscriber has its own bounded queue (default 256 events; `capacity` is brought into 1
to 4,096, so no option makes it unbounded or hands events over synchronously), events reach the subscriber's fiber
through the queue's scheduler, and a subscription that ends (a `shared` part replaced) leaves the fan-out at once and
its stream ends in a microtask. A slow subscriber loses the newest events (counted, logged at most once per 10 s; a
logger or clock that fails stops nothing). In `shared`, a subscription receives events only while that shared part is
the published one: not while a new one is still starting, and nothing once it was replaced or retired (it ends then).
Events are lost at a restart: nothing may depend on one for correctness.

## Pages

Nothing is sent to voice pages by default. A collection opts in with `project(row, device)`, an event type with
`project(event, device)`: what that page may see, or `undefined`. `device` is the **server's record** of the page's
device (its saved name; P5 adds the room and the default person), never what the page said in its `hello`.

**What reaches a page is decided when its frame is built, and a frame is built in the same synchronous step that hands
it to the socket**: the row is read as it is committed at that moment and projected with the device's record then. A
row that was removed, or moved away from the page, before its frame was built never travels.

Each page has **one queue for everything it is sent** (`HouseholdPage` in core), with one bound (2,000 entries), filled
from the store's commit listener (not from the bus, so nothing is lost to a slow page) and drained by the page's
fiber a bounded step at a time:

- After every `welcome` (a reconnect too: a page never keeps household rows across connections) the queue starts with
  a snapshot, sent as `household.snapshot` parts: each step reads at most 20 rows of one collection and scope through
  an index, projects them and sends the frames at once. Every message has at most 256,000 characters and the whole
  snapshot at most 900,000, every message counted whole as it is encoded (both under the protocol's frame limit of
  1,048,576); at most the newest 500 rows per collection and scope, and 5,000 rows read in all. A collection with
  nothing the page may see is in no part. The final part (`final`, it holds no rows) names in `truncated` every
  collection whose visible rows were not all sent (room for naming all of them is kept from the start, so the list
  always fits): a collection named there may have rows missing; one not named is complete; "no rows" and "rows left
  out" are never confused. The page drops what it held on part 0 and applies the rows on the final one.
- After the snapshot, in commit order: the rows commits touched, coalesced (a row is queued once, at the place of its
  last change, with every scope it was in), and the module events of a type with a projection. **Nothing queued is
  sent before the snapshot's final part**, and nothing committed after it began is missed. For a row: `put` with its
  projection now when the page may see it; otherwise `remove`, with the collection and the id only, when the page's
  device could have been shown one of the row's scopes (a page that does not hold the id ignores it); nothing
  otherwise. Nothing is remembered per page about the rows it holds.
- A saved change to a device's record (its name; P5: its place and default person) gives that device's pages a fresh
  snapshot; the module events already queued are kept and follow it, in order, projected with the new record.
- **Every loss is signalled, once, the same way**: when more than 2,000 entries wait (the page fell too far behind) or
  sending to it failed and starts again, everything queued is dropped and the page gets `household.gap` (`overflow`,
  `restart`) and then a fresh snapshot. Module events between the message before the gap and that snapshot may be
  missing; without a `household.gap`, nothing was.
- A projection that throws or returns something that is not plain JSON (a `BigInt`, a cycle) or more than 16,000
  characters of it hides that row (a page that held it is told `remove`) and is a Health issue of the module; it
  affects nothing else. At most 1,500 projected collections are sent to pages (beyond is reported and not sent).

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
read their data and every write fails with `read-only` ("changes are made by the server"); an owner whose stored
data does not match the code exactly (version, shapes, indexes) is `unavailable` there. Without a file (a warning
says so when a module keeps data), or with one that cannot be opened here, they get an empty read-only store. They
make no backups. Ambient facts are serve mode only (and `bench --live --ambient`). A command-line mode that keeps a
read open holds an older snapshot, which delays the checkpoints (the log grows; past 64 MB it is a Health issue) and
the one after a removal until it lets go.

## Durability

`synchronous = NORMAL` in WAL mode: a commit is safe against the assistant crashing, but a power loss or an operating
system crash can lose the last transactions committed before it (those whose log was not yet synced). A module must
not treat a committed write as surviving a power cut (an alarm set a second before one may be gone). The daily backup
is the recovery point for a damaged file.

## Backups

- **Only the serving process makes backups** (it holds the data directory's writer lock, and inside it backups run
  one at a time). The server makes `data/backups/household-<date>.db` once a day (the first a minute after start) and
  before an upgrade (`household-<date>-before-<owner>.db`, which does not count as the day's backup), and copies each to
  `HOUSEHOLD_BACKUP_COPY_DIR` when set (a copy that failed is a Health issue and is tried again every hour). A backup
  is SQLite's online backup made through a **connection of its own**, in one step on SQLite's worker thread, so turns
  are never held up by it ("Latency"). Each is written to a temporary file of its own (`….part-<pid>-<random>`), made
  one self-contained file (no log beside it), synced and published with one `rename`.
- Every file and directory the store makes is private to the user (`0600`, `0700`), whatever the umask. A data or
  backup directory that already exists and others may write to is narrowed to `0700` when it is the user's; when it is
  not, it is an error on the Health page (another local user could replace the data there), and the store still
  starts. A backup that stays and is readable by others (an older one, one copied in by hand) is narrowed when the
  store prunes.
- `pnpm start doctor` checks that the database opens, passes SQLite's quick check, is not from a newer version, that
  every module's data in it is usable (judged read-only against the catalog), which stored collections nothing declares
  any more, that the directories are private, and that the last backup is less than 48 hours old. The Health page in
  serve mode shows the backup checks, backups that could not be checked or removed, a copy that failed, a directory
  others may write to, a log that keeps growing and a pending removal checkpoint at every check ("Check again" too;
  they read only file times and the store's state); the quick check reads the whole file, so it is the doctor's alone.

### What is kept how long

| What | Where | Removed |
|---|---|---|
| Daily backups | `data/backups/household-<date>.db`, and the second directory | once older than 14 days (by the end of the day in the name or the file time, whichever is older) |
| Backups before an upgrade | `data/backups/household-<date>-before-<owner>.db`, and the second directory | the same |

The server prunes once a day and after every backup, without exception (also when it means no backup is left: the
Health page then says there is none). A directory that cannot be listed, a backup that cannot be checked or removed
(permissions, a read-only share) is reported, on the Health page too, and never counted as done. So 14 days after a
removal, the removed item is in no file the store manages, as long as the server ran and pruning succeeded.

### Restoring a backup

1. Stop the server (`systemctl --user stop pva` or Ctrl+C).
2. Move `data/household.db`, `data/household.db-wal` and `data/household.db-shm` somewhere else (keep them until the
   restored data is known to be right).
3. Copy the backup (one self-contained file) to `data/household.db` and make it private: `chmod 600 data/household.db`.
4. Start the server. Pages reconnect and get a fresh snapshot.

## Latency

`packages/store-sqlite/test/latency.test.ts` on 100,000 rows of about 1 KB (one collection with two indexes and a
pair), on the development machine (shared with other agents), the worst of 30 calls each:

| Call | Worst |
|---|---|
| `list` newest 20 (the ambient read) | 1.2 ms |
| `list` of 100 rows (the most a list returns): newest / oldest / `where` / ordered by an index / `where` ordered by a pair | 1.9 / 2.1 / 1.7 / 1.9 / 1.9 ms |
| **the worst legal `list`: 100 rows of 16,000 characters** | **2.3 ms** (bound: 10 ms) |
| `get` | 0.3 ms |
| `update` of one row (its own transaction) | 0.8 ms |
| a one-row write right after a reader let go of a log that grew while it held an old snapshot | 0.3 ms (the main connection makes no checkpoint) |
| one snapshot step for a page (20 rows of about 1 KB, projected, frames built) | 1.1 ms |

The longest stop of the event loop (a 1 ms timer) while the work ran, with a turn's read every 2 ms beside it:

| Work | Longest stop |
|---|---|
| a backup (own connection, one step on SQLite's worker thread) | 4.9 ms |
| a removal and the truncating checkpoint after it (worker thread), after a reader let the log grow | 1.4 ms |
| ending a conversation of 3,000 rows of about 1 KB (steps of 100) | 5.3 ms |
| migrating 20,000 rows of about 1 KB at start (one transaction; before the server serves) | 642 ms |

The doctor's quick check reads the whole file; it is not on a turn's path.

## Testing a module

`@pva/core/testing` has `makeMemoryHouseholdStore()` and `makeRecordingEventBus()`; `makeTestHousehold([module])`
prepares a store for the module and returns `household` for `makeModuleHost({ household })`. The in-memory store runs
the same engine as the SQLite store (collections, transactions, events, `prepare`) and answers lists in the same order,
so a module tested on it is not surprised by the real store. Both pass the same contract (`@pva/core/store-contract`:
one test per rule of this page), and a randomised test applies tens of thousands of random operations and transactions
to both (with hooks, asynchronous results, kept handles, pair indexes, redeclarations, a core service's collections,
conversations and the numbers SQLite's parser would change) and compares every answer, every released event, every
hook and every row (`packages/store-sqlite/test/parity.test.ts`). A core service is tested the same way: declare its
collections, `prepare(modules, [{ owner: "core.<name>", storage }])`, and use `forCore`.
