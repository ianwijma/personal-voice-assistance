# Scheduling

How a module has its own code called at a time: once, later, or on a repeating schedule (docs/MODULES-PLAN.md §4 P6).
The contract is `packages/core/src/Scheduler.ts`; the engine is `SchedulerEngine.ts`, its data `SchedulerJobs.ts`. Every
promise on this page has a case in `@pva/core/scheduler-contract`, which runs on the in-memory store and on SQLite (in
memory and on a file).

## In one paragraph

The scheduler does one thing: **it calls a handler of your module at a time, once.** You register handlers with
`ctx.scheduler.handle(name, …)` while your module starts, and schedule jobs for them with `ctx.scheduler.schedule(…)`:
at a time, after a delay, or on a `cron` schedule. A job is one row in the household store; it survives restarts. When
it is due and its handler is published, the scheduler claims it, runs the handler with the job's origin as its
principal, and records the outcome: `done`, the next occurrence of a repeating job, a retry (idempotent handlers only),
or `failed` (a Health issue). There is no pause and resume (cancel and schedule again), no background task (a fiber in
your own scope, with its progress in your own collection) and no notification job (P9's notification service has a
handler of its own).

## Handlers

```ts
shared: (ctx) =>
  Effect.gen(function*() {
    yield* ctx.scheduler.handle("ring", {
      payload: Schema.Struct({ timerId: Schema.String }),   // decodes the stored payload (its JSON form)
      idempotent: false,                                    // default false
      retries: 3,                                           // idempotent handlers only; default 3, at most 10
      timeoutMs: 60_000,                                    // default 60 s, 100 ms to 10 min; covers decoding the payload
      run: (payload, due) => ring(payload.timerId, due)     // due: { jobId, key?, dueAt, lateMs, attempt }
    })
    return { value: undefined }
  })
```

- A handler is a **registration of the part that made it** (`shared` or an instance's `start`): it is published with
  your module in the host's one step and withdrawn with it. Call `handle` during `shared` or `start`; afterwards it
  fails `state`. Two handlers of one module with the same name refuse the module's start, so a module that runs
  several instances registers its handlers in `shared`.
- A job runs only while its handler is published. While your module is off, stopped, failing or starting, its jobs
  stay `scheduled`, however late; they run when the handler is published again, subject to their `late` rule.
- Names: lower case letters, digits and `_ . -`, starting with a letter, at most 64.

## Scheduling

```ts
const job = yield* ctx.scheduler.schedule({
  handler: "ring",
  payload: { timerId: row.id },            // JSON, at most 1,000 characters (stored as JSON.stringify gives it)
  inMs: 10 * 60_000,                       // or at: epochMs, or (system jobs) cron: "0 7 * * 1-5" with an optional timeZone
  key: `timer:${row.id}`,                  // optional: one live job per key
  late: { withinMs: 15 * 60_000 },         // optional, default "run"
  origin: { deviceId, assistantId }        // optional, default: the turn's (or, in a handler, its job's)
})
```

- **When**: exactly one of `at` (epoch ms, 0 to 8.64e15; a time in the past is due now), `inMs` (0 or more) or `cron`.
- **`cron` is for system jobs** (refreshing a cache every 15 minutes, a nightly clean-up): Effect's `Cron` with
  minute, hour and day-of-week fields (and an optional seconds field first), at most 100 characters; **the day-of-month
  and month fields must be `*`**. Anything else (`0 7 1 * *`, `0 0 29 2 *`) is refused with `invalid`, before it is
  parsed: schedule a one-off job (`at`) and schedule the next one from its handler (a module that repeats by an
  `RRULE` keeps the rule itself and does exactly this). An expression that does not parse and a zone that is not
  known are `invalid` too, never a defect. Planning an accepted expression (`Cron.next`, inside `schedule`) is under
  a millisecond ("Latency"). `isSchedulerCron(expr, timeZone?)` (`@pva/core`) makes the same checks and answers why an
  expression would be refused, or `undefined`.
- **Payload**: JSON of at most 1,000 characters (as `JSON.stringify` writes it, escapes included); anything else is
  `invalid`. An absent payload is `{}`. Keep larger data in your own collection and schedule its id. When the handler
  is published (or registered by the start being published) at the moment of `schedule`, `prepare` or `reschedule`,
  the payload is checked against its schema there, and one that does not decode is `invalid` (P11), as is one whose
  decoder throws. Only a schema that cannot decide synchronously (it decodes asynchronously) is accepted unchecked. It
  is decoded by the handler's schema again when the job runs; a payload that does not decode then (a job scheduled
  before its handler appeared, a schema that decodes asynchronously) fails the job, and it is not retried.
- **Key**: one live (`scheduled` or `running`) job per module and key. Scheduling the same key again replaces the live
  one, which becomes `cancelled` (and its Health issue, if it had one, goes); a finished job of that key, a `failed` one
  too, is not touched. Keys: 1–100 letters, digits and `_ . : @ / -`.
- **Origin**: the assistant, device and person of the turn that scheduled it (`CurrentTurn`), or, from inside a
  handler, of that handler's job (`CurrentJob`), unless you give one. The handler runs with it as its principal. Its
  ids are 1–64 letters, digits and `_ . : -` (every assistant, device and person id is).
- **Limit**: at most 200 live jobs per module; one more fails `limit` (a replaced key does not count twice; a job that
  finished or was cancelled frees its place).
- Unknown fields, a bad handler name, key or origin id are `invalid`.
- `schedule` is one synchronous store transaction: it is fine on a turn's path ("Latency").

### Inside your own transaction

A job written together with your own rows commits or rolls back with them. Prepare it first (it is checked, and its id,
time and origin are decided, outside the transaction), then write it inside with the transaction's handle:

```ts
const job = yield* ctx.scheduler.prepare({ handler: "ring", payload: { timerId }, inMs: 600_000, key: `timer:${timerId}` })
yield* ctx.store.transaction((tx) => {
  tx.collection(timers).insert({ dueAt: job.dueAt, jobId: job.id, state: "running" }, { id: timerId })
  job.writeIn(tx)                           // synchronous; the job is part of this transaction
})
```

`writeIn` is a plain synchronous call: nothing returns an Effect from the transaction function. A refusal is thrown as a
store failure, so left uncaught it rolls everything back: `StoreError` `invalid` at the 200-job limit, for a prepared
job written already, and for a handle used outside its function. Every refusal is decided **before the job's first
write**, so you may catch one inside the function and commit the rest: nothing of the job was written. Write a
prepared job once, from the part that prepared it: once that part has closed (your module stopped or restarted), its
`writeIn` dies with `ModuleStopped` before writing anything, even inside a transaction of the module's next part.

**Do not catch any other failure of `writeIn` and go on with the same transaction.** Such a failure is the store's own
(a full disk), thrown in the middle of the job's writes (its counter, the key's old job, the new job). The store has no
way for joined code to make your transaction fail whatever you catch, so committing after catching it could keep half
of a replacement. Let it roll the transaction back. (If it happens anyway, the counter of your live jobs is at worst
too high; the maintenance pass recounts it.)

## When it is due

1. **Claim**: in one transaction the job becomes `running`, its attempt count goes up by one, and the claim's revision
   is kept.
2. **Run**: the handler runs in a fiber of its own, never on a turn's path, as a **call in flight of your module** (like
   a tool call: it gets the grace period when your module stops), with the job's origin as its principal (`CurrentJob`
   is `{ jobId, moduleId, assistantId?, deviceId?, person? }`), admitted by the execution gateway first. Serve mode
   checks that principal as it checks a turn's: a person no longer in Members, a device that is gone, an assistant
   that does not exist refuses the run, and the job fails with that reason (`Not run: …`). Tools and actions it calls
   through `host.actions.run` are checked for that principal too. The time limit (`timeoutMs`) covers decoding the
   payload and the handler.
3. **Outcome**: written in a second transaction, only if the job is still at the claim's revision:
   - success: a one-off job is `done`; a repeating one is `scheduled` for its next occurrence;
   - a failure, a defect, the time limit, or the handler interrupting itself: an idempotent handler is retried with
     back-off (5 s, 10 s, 20 s, …) up to its `retries`; otherwise (or after the last retry) a one-off job is `failed`
     and a repeating one moves on to its next occurrence; either way the failure is a Health issue (below). The text
     it failed with passes your module's page boundary in full (a secret in it is replaced, wherever it is), and is
     then kept as one well-formed line of at most 200 characters as JSON (`lastError`).
   - If the job was **rescheduled or cancelled while it ran**, the outcome is dropped, nothing else.
   - If the outcome **cannot be written** (the store is busy or failing), it is tried again a few times with back-off;
     then the row is left `running` and the recovery rule below decides.

A **repeating job always moves on** to its next occurrence, whatever happened to this one.

### When a run is cut short: the recovery rule

A run interrupted because **its module stopped** (after the grace period) or **the server is shutting down** is not a
failure of the handler: its row stays `running`. So does a run whose outcome could not be written, and one in a process
that crashed. Such a row (running, with no run alive in this process) is treated as a run that failed without telling,
when its handler is published again (so also when the server starts) and by the scheduler's maintenance pass:

- an idempotent handler's job is run again, within its retry limit;
- any other one-off job becomes `failed` (a Health issue), and its handler is not called again for it;
- a repeating job moves on to its next occurrence either way.

So a handler that must not run twice for one occurrence does not declare `idempotent`; one that may (it checks what it
already did) declares it and is retried. Nothing else interrupts a run: interrupted for any other reason (it
interrupted itself), it has failed.

## Late jobs

`late` says what to do with a job found after its time (the server was down, the module was off):

- `"run"` (the default): run it once, however late. The handler is told how late (`due.lateMs`).
- `{ withinMs }`: run it only if it is at most that late; later, the job becomes `missed` and the handler is not
  called (a repeating job is planned for its next occurrence instead). `{ withinMs: 0 }` runs only a job found on time.

There is no grace beyond what the job says. A **repeating job that is late** runs once, for the latest occurrence at or
before now (`due.dueAt`), and continues from the first occurrence after now, however late it is (a minute or a week);
`withinMs` is applied to that latest occurrence. A retry is late by how long after its occurrence it runs.

## Cancel, reschedule, get, list

```ts
yield* ctx.scheduler.cancel(job.id)                    // true when it was live or failed; cancel({ key: "timer:pasta" }): the key's live job
yield* ctx.scheduler.reschedule(job.id, { inMs: 300_000 })   // or { at }; the job, or undefined when there is none
yield* ctx.scheduler.get(job.id)                       // JobRow | undefined (live or finished, until removed)
yield* ctx.scheduler.list()                            // your live jobs by due time, 10 a page; { key } for one key's
```

- **cancel** makes a live job `cancelled`, or dismisses a `failed` one by its id (its Health issue goes). `cancel({ key })`
  finds the key's live job only: a failed one is dismissed by its id. A running handler is **not interrupted**: what it
  then reports is ignored, and it is not run again. Any other finished job answers `false`.
- **reschedule** gives a live job a new due time: it is `scheduled` again with attempt 0 (a repeating one continues
  from its cron after that occurrence). For a running job, the outcome of the present run is ignored. A finished job
  fails `state`; schedule a new one.
- **list** returns your **live** jobs only, by due time, a page at a time (at most and by default `MAX_JOB_PAGE`, 10:
  what one list of the `jobs` collection may read): pass the last row of a page as `after` to read on; `after` must be
  a row `list` returned for the same query. `get` finds finished jobs too.
- A module sees and changes only its own jobs.
- Every call stops with `ModuleStopped` once the part it was given to has closed, like `ctx.store`.

## Time zones

A cron job with a `timeZone` is computed in it. One without uses the household's zone (`HOME_TIME_ZONE`, else the
server's) **each time its next occurrence is planned**: nothing moves an occurrence that is already planned, so a change
of the household's zone takes effect from the occurrence after it. The admin page shows each job's next time. Effect's
`Cron` resolves the daylight-saving gap forward and the repeated hour to its earlier time.

## Health and the admin page

- A **failed job** is a Health issue (warning) until it is cancelled by its id (on the Scheduled jobs page, or
  `cancel(job.id)`) or removed with the finished rows seven days on. A repeating job whose occurrence failed stays live
  and is one until an occurrence **succeeds** (a missed one does not clear it), until it is cancelled, or until
  scheduling its key again replaces it. The 48 newest failures (by failure time) are listed; when there are more, one
  more issue says so and points to the Scheduled jobs page, without a number (reading 49 rows by the index is enough to
  know). The issues are read again after every change of a job with an issue; a read that fails is tried again after
  the loop's back-off (5 s), not left until maintenance. The reason a handler gave passed the page boundary before it
  was stored, and passes it again when it is shown.
- **Diagnostics › Scheduled jobs** lists every job a page at a time (`GET /api/scheduler/jobs?cursor=…`, at most 20 a
  page, read as two lists of 10 with a pause between): live jobs by due time, then the finished ones (kept seven days),
  newest first; "Load more" reads the next page. Payloads are never shown. "Cancel" works on live and failed jobs;
  cancelling a running job does not interrupt it.
- **The list is not a snapshot.** Each page continues after the place of the last job of the page before. A job that
  changes in between can be missed (a live job not yet read that is rescheduled to before that place) or come twice
  (a live job already read that finishes meanwhile reappears among the finished ones, in a later page or in the same
  answer; the page shows it once, as it came first). The cursor is a random token of the running server, kept for its
  newest 256 pages (shared by every admin page): an older one, an empty one, or one from before a restart, is answered
  400 and the page reads the list again from the top. Refresh, and the reload after a cancel, start a new reading at
  once: the old reading's cursor is not used again, "Load more" waits until the new first page has arrived, and a
  "Load more" still on its way is dropped.
- `pnpm start doctor` lists the failed jobs, read-only from the database.
- **Finished rows** (`done`, `failed`, `cancelled`, `missed`) are removed seven days after they finished, by the
  maintenance pass (every 10 minutes, also when nothing is due), so a row can stay up to that much longer: at most 200
  a pass in transactions of 10 (a backlog drains a pass a second).

## How it is stored

One collection, `jobs`, of the core owner `core.scheduler` (no module can name it), prepared with the modules'
collections in serve mode, the CLI modes and `makeTestHousehold`, plus a counter per module (`job_counts`) for the
200-job limit. **`maxChars` is 2,500**: the worst legal row (a live repeating job retried after an earlier failure,
with a payload of 1,000, a key of 100, three origin ids of 64, a cron of 100, a zone of 48, a failure text of 200, all
of them with the costliest characters JSON has, and every number at its longest) is just under it; the contract builds
it. So one list reads at most `maxListRows(jobs)` = **10 rows** (`MAX_JOB_PAGE`, from the store's budget of 25,000
characters). Every read that sweeps (the loop, the recovery rule, retention, the recount, the Health issues, the admin
list, `list`) reads page by page with `after` and never assumes one page was all. The indexes:

| Index | Field present | Used by |
|---|---|---|
| `[ready, at]` | `ready = "<module>/<handler>"` while `scheduled` | the loop: per published handler, its earliest job |
| `liveKey` | `"<module>/<key>"` while live | one live job per key |
| `[liveModule, at]` | the module, while live | `list` |
| `liveModule` | the same | the recount of a module's live jobs (by `createdAt`, an order nothing changes) |
| `[list, at]` | `"live"` / `"finished"` | the admin list, retention |
| `[state, at]` | always | the recovery rule (`running` rows) |
| `[issue, failedAt]` | `true` while it is a Health issue | the Health issues, newest failure first |

`at` is the due time while live and the finishing time once finished. The index fields are derived from the row's own
fields on every write (`withIndexes`), so they cannot disagree with it.

**The loop** is one fiber. It sleeps until the earliest due time among jobs whose handler is published (one indexed
read per published handler) or until its maintenance pass is due (every 10 minutes: retention, the recovery rule, the
Health issues, and the recount of each module's live jobs: a counter that disagrees with the rows is set to what they
say), and is woken by a schedule, a reschedule, a cancel, a handler being published, a run ending, and a jump of the
wall clock (it sleeps at most 10 s at a time and compares the wall clock with the monotonic one). A job whose handler
is not published is never read by it. At most 32 runs at once, shared fairly: **a pass is one round**. It reads the
published handlers as they are when it starts and takes at most one due job of each (starting at the handler after the
one whose job it started last), up to the cap, then ends. When it claimed a job (or found one missed), the next pass
starts at once; otherwise the loop sleeps until the next due time or a wake (at the cap, a run that ends wakes it). So a
handler with many due jobs cannot keep another's waiting, and a job that becomes due, a handler published meanwhile,
maintenance and the Health issues are all considered again before any handler gets a second job.

## Core services

A core service (P9's notifications) schedules with the same engine under its own owner `core.<name>`:
`engine.forCore("core.notifications")` has the same calls as `ctx.scheduler`, and its `handle` registers a handler for
the scope it runs in (the server's life), outside any module. Withdrawing it (the scope closes) interrupts its runs, and
so does closing the engine (every run, a core handler's too, is in the engine's run scope); the recovery rule applies
when it is registered again.

## Latency

`packages/store-sqlite/test/schedulerLatency.test.ts`, SQLite on a file, at the limits: 1,000 jobs (five owners of 200,
50 published handlers) with payloads of 1,000 JSON characters made of escapes, keys of 100 and origin ids of 64;
retention rows of 2,134 characters: failed jobs with the payload, key, ids, cron, zone and failure text at their longest
(not quite the largest finished row: a cancelled retry also keeps its occurrence time).
The development machine (16-thread AMD Ryzen 9 7945HX laptop, shared with other agents), worst of three runs, after
50 calls to warm up. Two kinds of number:

- **longest stop**: the longest gap between ticks of a 1 ms timer over the whole window. Whatever the scheduler does
  synchronously in that window holds the main thread at most this long, so this is the bound on its blocked time (the
  test asserts it under 15 ms, three times that on CI); it also includes garbage collection and the machine's other
  work.
- **wall**: around one call or transaction. It includes waits that do not block: a transaction that finds the write
  lock taken (the store's checkpoint worker) waits on timers and tries again.

| What | Longest stop | Wall |
|---|---|---|
| `schedule` (the only part on a turn's path), 950 calls | 3.5 ms | median 0.30 ms, worst 0.74 ms a call |
| `schedule` replacing the live job of its key, 30 calls | 1.7 ms | worst 0.97 ms |
| Cron planning (`Cron.next` and `Cron.prev`; 8 accepted expressions, weekly ones among them, in 4 zones with DST, from 5 dates at the changes) | (synchronous) | worst 0.80 ms; `schedule` with a cron, worst 1.2 ms |
| one loop pass, nothing due (50 indexed reads, yielding between handlers), 20 passes | 1.7 ms | 4.4 ms a pass |
| 40 due jobs of 20 handlers: two passes of 20 (one job per handler a pass) | 2.1 ms | worst 29 ms a pass (it yields between claims) |
| retention of 400 rows in transactions of 10, with the recovery rule, the recount and the Health issues | 2.6 ms | worst 1.5 ms a transaction |

A refused date expression (`0 0 31 2 *`) costs 0.5 ms: it is refused before it is parsed.

## Testing a module

`makeTestScheduler({ modules })` (`@pva/core/testing`) is the real engine on an in-memory store prepared for your
module and the scheduler, on the Effect clock (in `it.effect`, the test clock). Give `scheduler` to the module host as
`ModuleHostOptions.scheduler` (and `household` as its household); `advance(ms)` moves the clock and lets the engine run:

```ts
const { advance, household, scheduler } = yield* makeTestScheduler({ modules: [timersModule] })
const host = yield* makeModuleHost({ catalog: [timersModule], persistence: readOnlyPersistence(), env: {}, household, scheduler })
yield* host.startEnabled
// … a tool schedules a job …
yield* advance(10 * 60_000)
```

A restart is a second engine on the same store after the first one's scope has closed.
