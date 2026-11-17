# Scheduling: timers, alarms, reminders and background tasks

How a module makes something happen later (docs/MODULES-PLAN.md §4 P6; design: research/module-investigation/
shared-state-jobs-and-notifications.md §6). The contract is in `packages/core/src/Scheduler.ts`; the summary is in
[ARCHITECTURE.md](ARCHITECTURE.md), section "Scheduler".

A version 2 module gets `ctx.scheduler` in `shared` and in `start`. Everything it sees is its own: another module's
jobs are not found.

## 1. A job

```ts
const job = yield* ctx.scheduler.schedule({
  kind: "timer",                       // timer | alarm | reminder | recurring | deferred (tasks use runTask)
  key: `timer:${row.id}`,              // optional: one live job per key; scheduling it again replaces the old one
  label: "Pasta",                      // the admin list shows it
  when: { at: row.value.dueAt },       // or { inMs: 600_000 }, or { cron: "45 6 * * 1-5", timeZone? }
  onDue: { notify: { kind: "timer", priority: "high", ring: "origin-then-room", dedupeKey: `timer:${row.id}`,
                     content: { title: "Pasta timer", spoken: "Your pasta timer is done." } } },
  missed: "fire-late"                  // what to do when it is found late; below
})
```

- **Origin and scope.** `origin` (device, assistant, conversation, person) is taken from `CurrentTurn` when the call
  does not give one, so a job scheduled by a tool knows where it was asked. `scope` defaults to the household.
- **Due times** are wall-clock epoch milliseconds and survive a restart. A `cron` job is computed in its `timeZone`,
  or in `HOME_TIME_ZONE` (read at each computation, so a change of home zone moves it), and a daylight-saving change
  does not move "7:00". Use `cron` for system jobs ("every 15 minutes"); what a person says ("every second Tuesday")
  is an `RRULE` (§4).
- **One transaction.** Call `schedule` inside `ctx.store.transaction(...)` and the job commits or rolls back with your
  own rows: a timer row and its job are never apart.
- **Then**: `pause(id)` (a one-off job keeps its `remainingMs`), `resume(id)`, `reschedule(id, when)` ("add five
  minutes": `{ at: job.dueAt + 300_000 }`; a job that already fired is scheduled again), `cancel(id)`, `list(filter)`,
  `get(id)`. Errors are a `SchedulerError` with a `reason` you can word: `not_found`, `state` ("only a scheduled job can
  be paused"), `invalid`, `conflict`, `unavailable`, `failed`.
- **On the turn path** a `schedule` is at most two single-row writes (the key's old job, the new one).

## 2. What happens when it is due

`{ notify: NotificationRequest }` is data only: it fires even while your module is restarting or switched off. The
scheduler fills in `source`, hands it to the notification delivery with the occurrence key as its id
(`<jobId>@<dueAt>`), and records the delivery on the job (`delivered`). Until the notification service (P9) exists, the
delivery writes a log line. A failed delivery is retried with back-off, under the same id.

`{ handler: "ring", payload }` runs code your module registered. Register handlers in **`shared`**, once:

```ts
shared: (ctx) => Effect.gen(function*() {
  yield* ctx.scheduler.handle("ring", Schema.Struct({ alarmId: Schema.String }), (p, due) =>
    Effect.gen(function*() {
      // due.lateByMs, due.inbox, due.attempt, due.occurrenceKey, due.skipped
    }), { timeoutMs: 30_000 })
  return { value: undefined }
})
```

- The payload is stored as JSON and decoded with the handler's schema when the job fires; a payload that does not
  decode fails the occurrence without a retry.
- A handler is registered until the scope of the `shared` part closes. A new generation of the shared part (its shared
  settings changed) registers the same name again; from then on only the new handler runs, and nothing fires twice.
- A handler has a time limit (default 60 s). It runs in a fiber of its own, never on the engine's.

### Running it once

Every occurrence is claimed before it runs, so it starts once. What happens after a failure, or when the server
stopped while it ran, depends on `idempotent`:

| | failed | found `running` at start (the server stopped) |
|---|---|---|
| `{ notify }` | retried, same id (P9 dedupes) | delivered again, same id |
| handler, `idempotent: true` | retried after 5 s, 10 s, 20 s … up to `retryLimit` (default 3) | run again (`due.attempt` > 1) |
| handler, not idempotent | `failed`, a Health issue | `failed` ("interrupted by a restart"), a Health issue |

A **recurring** job always moves on: a failed occurrence is recorded (`lastError`, a Health issue until one succeeds)
and the next one is scheduled in the same write.

### Missed while the server was down

A job found more than a minute after its due time (`ON_TIME_MS`) is judged by its `missed` policy:

- `fire-late`: fire it; `due.lateByMs` (and the delivery's `lateByMs`) say how late: "Your pasta timer went off three
  minutes ago."
- `{ fireIfWithinMs: 900_000 }`: fire it if it is at most that late, else `missed`; with `otherwise: "inbox"`, deliver
  it to the inbox instead ("You missed your 6:45 alarm").
- `skip`: do not fire it (a one-off job ends `missed`).
- `inbox`: deliver it to the inbox, do not ring (`info.inbox` / `due.inbox` is true); the job ends `missed`.
- A recurring job that missed several occurrences runs only the last one, once (`due.skipped` says how many were
  left out), then moves on.

## 3. When your module is not running

- `{ notify }` jobs fire anyway.
- A `{ handler }` job that is due while its handler is not registered **waits**: it is shown as waiting on the admin
  page and on the Health page, and fires as soon as the handler is registered again, judged by its missed policy (so an
  alarm with `{ fireIfWithinMs: 15 min }` that waited longer is missed).
- **Jobs do not keep your module running.** A module's `shared` part runs only while it is demanded: an assistant that
  is switched on has it on, or a demanded module names it in `uses`. If the owner switches your module off on every
  assistant, its handler jobs wait until it is switched on again. So:
  - make anything that must happen even then a `{ notify }` job (a timer's ring, a reminder);
  - use a handler only where the module's own code is needed (an alarm's ramp and music lookup), and choose a missed
    policy that is right when it runs late;
  - when your module stops being used, cancel the jobs that no longer make sense, or let them wait.
- A module that is removed from the catalogue keeps its jobs: they are listed on the admin page (and the Health page)
  for the owner to cancel; their notifications still fire.

## 4. A reminder that repeats (`RRULE`)

What a person says is stored as an `RRULE` with its `DTSTART` in the home time zone (`@pva/language`). Do not turn it
into a cron: schedule **one job for the next occurrence**, and the next one when it fires.

```ts
import { nextOccurrence } from "@pva/language"

const scheduleNext = (reminder: Row<Reminder>, after: number) =>
  Effect.gen(function*() {
    const at = nextOccurrence({ rrule: reminder.value.rrule, dtstart: reminder.value.dtstart, timeZone: reminder.value.timeZone }, after)
    if (at === undefined) return // the rule has ended
    yield* ctx.scheduler.schedule({
      kind: "reminder",
      key: `reminder:${reminder.id}`,               // replaces the previous occurrence's job
      when: { at },
      onDue: { handler: "remind", payload: { id: reminder.id } },
      missed: "fire-late",
      idempotent: true
    })
  })

// in shared:
yield* ctx.scheduler.handle("remind", Schema.Struct({ id: Schema.String }), (p, due) =>
  ctx.store.transaction(Effect.gen(function*() {
    const reminder = yield* ctx.store.collection(reminders).get(p.id)
    if (reminder === undefined) return
    // deliver it (P9: ctx.notify.send with dedupeKey `reminder:${p.id}@${due.dueAt}`), then plan the next one,
    // from now, so occurrences missed while the server was down are not delivered one by one:
    yield* scheduleNext(reminder, Math.max(due.dueAt, yield* Clock.currentTimeMillis))
  })))
```

Because the handler is idempotent and the next job is scheduled with the same key in the same transaction, a retry or a
restart cannot plan two next occurrences, and a reminder always moves on. (A `{ notify }` job would ring without module
code, but then nothing would plan the next occurrence while the module is off; for a repeating reminder the handler
is the right choice.)

## 5. Background tasks

```ts
const job = yield* ctx.scheduler.runTask({
  label: `Research ${topic}`,
  work: research(topic),                          // Effect<A, E>: outlives the turn and the conversation
  result: (a) => ({ words: a.summary.length }),   // recorded on the row (JSON, at most 4000 characters)
  onDone: (a) => ({ kind: "result", priority: "normal", content: { title: "Your research is ready", spoken: a.summary } })
})
```

At most two tasks run at once; the rest queue (`scheduled`). `cancel(job.id)` interrupts one ("stop the research").
A task found running or queued at start was interrupted by a restart: it is marked `failed` with that reason (the
closure is gone, so `onFailed` is not called); tell the person on your next turn if it matters.

## 6. Modes, admin and Health

- **Serve mode** runs the scheduler on `data/household.db` (`core_scheduler__jobs`). Finished jobs are kept 7 days.
- **The CLI modes** (`text`, `voice`, `bench`, `doctor`) do not run it: the store is read-only there. `handle` succeeds
  (your shared part starts), every other call fails `unavailable`; say "timers run only on the server".
- **Admin** › Diagnostics › Scheduled jobs lists every job (module, kind, label or key, due time, state, origin) and
  cancels one, or dismisses a failed one (`GET /api/scheduler/jobs`, `POST /api/scheduler/jobs/<id>/cancel`).
- **Health** shows failed jobs, recurring jobs whose last run failed, jobs waiting for their module, and jobs of
  removed modules; `pnpm start doctor` prints the same and a count line.

## 7. Testing

```ts
import { makeTestScheduler, makeTestHousehold } from "@pva/core/testing"
import { TestClock } from "effect/testing"

it.effect("rings after ten minutes", () => Effect.gen(function*() {
  const { store, household } = yield* makeTestHousehold([timersModule])
  const { scheduler, deliveries } = yield* makeTestScheduler({ store })
  const host = yield* makeModuleHost({ catalog: [timersModule], persistence, env: {}, household, scheduler })
  // … start a timer through the module's tool …
  yield* TestClock.adjust("10 minutes")
  assert.strictEqual(deliveries[0]?.request.content.title, "Pasta timer")
}))
```

`makeTestScheduler` is the real engine on the in-memory store, so transactions roll back together and the semantics
are serve mode's; it runs on the test clock. A restart is a second `makeTestScheduler({ store, table })` on the same
`table` after closing the first one's scope. `@pva/core/scheduler-contract` holds the tests both implementations pass.
