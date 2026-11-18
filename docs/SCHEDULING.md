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
  payload: { timerId: row.id },            // JSON, at most 2,000 characters (stored as JSON.stringify gives it)
  inMs: 10 * 60_000,                       // or at: epochMs, or cron: "0 7 * * 1-5" with an optional timeZone
  key: `timer:${row.id}`,                  // optional: one live job per key
  late: { withinMs: 15 * 60_000 },         // optional, default "run"
  origin: { deviceId, assistantId }        // optional, default: the turn's (or, in a handler, its job's)
})
```

- **When**: exactly one of `at` (epoch ms; a time in the past is due now), `inMs` (0 or more) or `cron` (Effect's
  `Cron`, five or six fields, at most 120 characters). An expression that does not parse, a zone that is not known,
  and an expression that never fires (`0 0 31 2 *`) are refused with `invalid`, never a defect.
- **Payload**: JSON of at most 2,000 characters; anything else is `invalid`. Keep larger data in your own collection
  and schedule its id. It is decoded by the handler's schema when the job runs; a payload that does not decode fails
  the job, and it is not retried.
- **Key**: one live (`scheduled` or `running`) job per module and key. Scheduling the same key again replaces the live
  one, which becomes `cancelled`. Keys: 1–200 letters, digits and `_ . : @ / -`.
- **Origin**: the assistant, device and person of the turn that scheduled it (`CurrentTurn`), or, from inside a
  handler, of that handler's job (`CurrentJob`), unless you give one. The handler runs with it as its principal.
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
store failure, so left uncaught it rolls everything back: `StoreError` `invalid` at the 200-job limit, and for a handle
used outside its function. Catch it inside the function to commit the rest. Write a prepared job once.

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
     and a repeating one moves on to its next occurrence; either way the failure is a Health issue (below).
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
yield* ctx.scheduler.cancel(job.id)                    // or cancel({ key: "timer:pasta" }); true when it was live or failed
yield* ctx.scheduler.reschedule(job.id, { inMs: 300_000 })   // or { at }; the job, or undefined when there is none
yield* ctx.scheduler.get(job.id)                       // JobRow | undefined (live or finished, until removed)
yield* ctx.scheduler.list({ limit: 20 })               // your live jobs by due time; { key } for one key's
```

- **cancel** makes a live job `cancelled`, or dismisses a `failed` one (its Health issue goes). A running handler is
  **not interrupted**: what it then reports is ignored, and it is not run again. A finished job answers `false`.
- **reschedule** gives a live job a new due time: it is `scheduled` again with attempt 0 (a repeating one continues
  from its cron after that occurrence). For a running job, the outcome of the present run is ignored. A finished job
  fails `state`; schedule a new one.
- **list** returns your **live** jobs by due time, a page at a time (at most 24, default 20): pass the last row of a
  page as `after` to read on; `after` must be a row `list` returned for the same query. `get` finds finished jobs too.
- A module sees and changes only its own jobs.
- Every call stops with `ModuleStopped` once the part it was given to has closed, like `ctx.store`.

## Time zones

A cron job with a `timeZone` is computed in it. One without uses the household's zone (`HOME_TIME_ZONE`, else the
server's) **each time its next occurrence is planned**: nothing moves an occurrence that is already planned, so a change
of the household's zone takes effect from the occurrence after it. The admin page shows each job's next time. Effect's
`Cron` resolves the daylight-saving gap forward and the repeated hour to its earlier time.

## Health and the admin page

- A **failed job** is a Health issue (warning) until it is cancelled or removed with the finished rows; a repeating job
  whose last occurrence failed is one until an occurrence succeeds. At most the 48 newest are listed, and one more issue
  says when there are more. The reason a handler gave passes the page boundary first.
- **Diagnostics › Scheduled jobs** lists every job a page at a time (`GET /api/scheduler/jobs?cursor=…`): live jobs by
  due time, then the finished ones of the last seven days, newest first; "Load more" reads the next page. Payloads are
  never shown. "Cancel" works on live and failed jobs; cancelling a running job does not interrupt it.
- `pnpm start doctor` lists the failed jobs, read-only from the database.
- **Finished rows** (`done`, `failed`, `cancelled`, `missed`) are removed seven days after they finished, also when
  nothing is due, at most 200 a pass in steps of 10 (a backlog drains a pass a second).

## How it is stored

One collection, `jobs`, of the core owner `core.scheduler` (no module can name it), prepared with the modules'
collections in serve mode, the CLI modes and `makeTestHousehold`, plus a counter per module (`job_counts`) for the
200-job limit. `maxChars` is 5,000: the largest legal row (a payload of 2,000, a key of 200, three origin ids of 200, a
cron of 120, a last error of 300, every other field at its longest) is about 4,400 characters, so one list reads at most
`floor(120,000 / 5,000)` = **24 rows** (`MAX_JOB_PAGE`). Every read that sweeps (the recovery rule, retention, the Health
issues, the admin list, `list`) reads page by page with `after` and never assumes one page was all. The indexes:

| Index | Field present | Used by |
|---|---|---|
| `[ready, at]` | `ready = "<module>/<handler>"` while `scheduled` | the loop: per published handler, its earliest job |
| `liveKey` | `"<module>/<key>"` while live | one live job per key |
| `[liveModule, at]` | the module, while live | `list` |
| `[list, at]` | `"live"` / `"finished"` | the admin list, retention |
| `[state, at]` | always | the recovery rule (`running` rows) |
| `issue` | `true` while it is a Health issue | the Health issues |

`at` is the due time while live and the finishing time once finished. The index fields are derived from the row's own
fields on every write (`withIndexes`), so they cannot disagree with it.

**The loop** is one fiber. It sleeps until the earliest due time among jobs whose handler is published (one indexed
read per published handler) or until its maintenance pass is due (every 10 minutes: retention, the recovery rule, the
Health issues), and is woken by a schedule, a reschedule, a cancel, a handler being published, a run ending, and a jump
of the wall clock (it sleeps at most 10 s at a time and compares the wall clock with the monotonic one). A job whose
handler is not published is never read by it. At most 32 runs at once.

## Core services

A core service (P9's notifications) schedules with the same engine under its own owner `core.<name>`:
`engine.forCore("core.notifications")` has the same calls as `ctx.scheduler`, and its `handle` registers a handler for
the scope it runs in (the server's life), outside any module. Withdrawing it (the scope closes) interrupts its runs, and
the recovery rule applies when it is registered again.

## Latency

`packages/store-sqlite/test/schedulerLatency.test.ts`, SQLite on a file, at the limits (1,000 jobs with 2,000-character
payloads, keys and origin ids of 200, 50 published handlers over five owners of 200 jobs each), on the development
machine (shared with other agents):

| What | Main thread held |
|---|---|
| `schedule` (the only part on a turn's path: one synchronous transaction) | median 0.30 ms, worst 2.6 ms of 950 |
| `schedule` replacing the live job of its key | worst 0.9 ms |
| one loop pass, nothing due (50 indexed reads, yielding between handlers) | longest stop 1.7 ms (4.7 ms wall for the pass) |
| a pass claiming 40 due jobs | longest stop 2.2 ms |
| a retention step (10 finished rows of the largest size) | worst 1.8 ms; longest stop over a pass of 200 rows, the recovery rule and the issues 4.0 ms |

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
