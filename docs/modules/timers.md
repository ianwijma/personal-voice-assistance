# Timers (`timers`)

Named countdown timers that ring on the device that set them.

- Package: `packages/module-timers` (with `alarms`)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 2 (wave B)
- Research: [docs/research/modules/timers-and-alarms.md](../research/modules/timers-and-alarms.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Countdown timers, as household data. "Set a pasta timer for ten minutes" on the kitchen display makes a timer that
**rings on that device**. Its **countdown shows on every screen of that device's room**. Anyone may ask about it,
change it or stop it, from any device and through any assistant that has the module on. Up to 50 run at once (the
`Timers` contract's bound; paused timers count).

### What a timer is at any moment

A timer is one row. It is in one of four states:

- **running**: counting down to its moment;
- **paused**: keeping what it had left;
- **done**: its moment came;
- **cancelled**.

Running and paused timers are listed and count toward the 50. Beside the state, the same row holds what is still
**owed** for the timer:

- a ring that is due and not sent yet;
- **at most one** ring of it still to be taken away (its previous card, or a ring that was cancelled);
- a countdown that **may be on a screen**: written in the row before it is shown, and kept until it is known to be
  gone. The countdown should match the state: shown while it runs, gone otherwise.

`nextAt` is the next moment anything happens for the row. The row has **exactly one scheduler job**, key `timer:<id>`,
planned for that moment in the same transaction as every write to the row.

That job, every action, every button and the hourly sweep do one thing: **reconcile** the row at that moment. First,
what is due without any outside call is written: a timer whose moment came becomes *done*, with its ring owed. That way
the owed work is recorded before it is tried. Then the ring is sent, old rings are taken away and the countdown is
matched. The outcome is written with the next plan.

Only the row's own job sends a ring. Its origin is the timer's device, so the ring goes there and nowhere else, whoever
made the change that led to it. The sweep (hourly, and once at start) plans the job again for any row that lost its
own: a job can fail for good after its retries while the store is busy.

### Ringing

- **When its moment comes**, the job sends a `ring` notification on the timer's device: "Pasta timer is done", "The 10
  minutes timer has ended.". The card has **Snooze** and **Five more minutes** beside the host's **Stop**.
- **One ring per timer at a time.** A timer never has two cards of its own open.
  - Before a new ring is sent (after Snooze, after Five more minutes, at the next moment), the previous card is resolved.
  - While that cannot be done, the new ring waits as owed and is tried again: it is not sent beside the old card.
  - The notification key is per ring (`timer:<id>:<ring number>`), so a later ring is never swallowed by an earlier card.
- **Snooze** makes the timer run again for the snooze setting's minutes, without a countdown. **Five more minutes**
  makes it run again for five minutes, with its countdown.
- **The buttons act only on the timer's current ring.** A press of any other card (an older one, or one whose sending
  could not be recorded yet) is answered "That ring has ended." and changes nothing. A press is done once per
  notification: run again for the same card, it reports the committed time still left and changes nothing.
- **Stop** is the host's: on the card, as the spoken "stop", or "stop" without the wake phrase while it rings (the
  ringing window). The button labels can also be said while it rings ("snooze", "five more minutes").
- A ring **stops by itself** after the ring setting's minutes.

### When the notification service refuses a ring

The module may have at most ten notifications open at once. A ring refused for that reason, or because the store is
busy, **stays owed** and is tried again every 30 seconds for as long as it would still be ringing (the ring setting).
While it waits, the timer is listed as "done and waiting to ring". A restart keeps it.

When a place comes free in time, it rings and says how late: "The 2 minutes timer ended two and a half minutes ago,
while I couldn't ring.". A timer due while the server or the module was down rings on restart if it is still inside
its delivery window, and says how late.

Before giving up at the delivery deadline, the module checks for an open notification under this ring's key. It records
that notification with its existing expiry if found; if the lookup fails, delivery stays owed. Otherwise the timer is
recorded as missed and the Health page says so. A module
has no other way to raise a Health issue, so a job of its own (`trouble`) fails on purpose. That job is written in the same
transaction that gives the ring up: if it cannot be written, the ring is not given up, and stays owed.

### Delivery is at least once

The order is: write the owed ring, send it under its key, write that it was sent. If the server fails between the send
and that last write, the next reconcile finds the ring still owed:

- if its notification is still open, the module only records it, even beyond the delivery window;
- if nobody stopped it, it rings once;
- if someone pressed **Stop in that moment, the ring can sound a second time.** A ring is never lost this way.

An open ring recovered after a lost outcome write remains available to voice cancellation. This also covers a refused
first send followed by a successful retry whose outcome write failed across the delivery deadline.

What would close this is below the module: see "Missing below".

### Stop and a button pressed at the same moment

When Stop and Snooze or Five more minutes are pressed for the same ring at the same moment, the card follows whichever
the notification service recorded first. **The timer may still ring again once.** Saying "stop" or "cancel the timer"
again ends it. What would close this is below the module (see "Missing below").

### What a change does while it rings

- **More time** ("add two minutes"): the timer runs again for that long, and its ring is taken away.
- **Cancel** ("stop the timer", "cancel the pasta timer"): the ring is taken away.
- **Pause or resume** of a ringing timer: refused, with a pointer to "stop".

Cancel, more time, pause and a button all let go of the timer's current ring in one way. A ring whose sending could not
be recorded yet is first looked for among the open notifications by its key. It is taken away too, and only then is
the owed ring forgotten.

### Taking away and clean-up

Taking a ring away and taking a countdown off the screen are owed work in the row. Outside the combined-failure limits
below, they are cleared only when they succeeded, and tried again a minute later by the job, also for a timer that is paused or ended and also after a
restart. A ring is retried until it stops by itself; a countdown until it ends by itself, 10 minutes after its moment.
After a restart the countdown is taken down by showing its key again (a countdown ending now) and dismissing that.

The sentences say what is true:

- "Pasta timer cancelled." only when its ring is gone;
- otherwise "Pasta timer cancelled; its ring is still being stopped, and I keep trying.", or the same for the
  countdown;
- **cancelling again finishes the clean-up**: such a timer can be cancelled again by its name ("cancel the pasta
  timer"), or as the only one, or by "cancel all timers", and the clean-up is tried at once ("Pasta timer is stopped
  now."). Lists of running timers do not show it.

The countdown is recorded in the row as "may be on a screen" before it is shown. So a countdown whose showing could
not be recorded (the store failed just after) is still known, and taken away by a cancel, also after a restart, subject
to the combined-failure limits below. A countdown that cannot be shown after three tries is left out (the timer still runs and rings); typically that is the
Presenter's bound of 8 per module. An old countdown that could not be replaced after a change is taken down instead,
subject to those same limits.

Two combined-failure limits remain: if a countdown show succeeds but its outcome write fails and a retry after restart
is refused, cancellation can forget the still-visible countdown; if dismissal keeps failing across a restart, a
cleanup replacement can outlive the stored cleanup deadline and cancellation can report success while it stays visible,
but both presentations end by their own lifetime (the original due time plus ten minutes, or ten minutes after the
cleanup replacement was shown).

### Which timer is meant

- **By name**: "the pasta timer", compared without case, accents, punctuation, a leading article and a trailing
  "timer"; when that leaves no words (such as "A"), the supplied label is matched exactly, ignoring case.
- **With no name**: the only one there is (running, paused, snoozed, ringing or waiting to ring).
- **Otherwise a question** that lists them: "There are 2 timers: eggs timer with 6 minutes left and pasta timer paused
  with 10 minutes left. Which one?". **Never the first of several.**
- A name nobody has: "I don't know a timer called eggs.".
- Two running timers cannot have the same name.

### One change at a time

Every read that answers and every change runs under one permit of the module's shared part, and reads its row again
inside it. A cancel said while the ring job is sending waits for it, and then stops the ring it sent.

### Other behaviour

- **How long is left** is said to the second under ten minutes ("6 minutes 10 seconds"), else to the minute ("a
  quarter of an hour"). A list names at most three ("and 47 more"): ringing ones first, then the soonest.
- **The `Timers` service** for other modules (routines; kitchen later) works exactly as
  `packages/module-contracts/src/timers.ts` says:
  - `start({ durationMs, label?, ringOn? })` rings on `ringOn.deviceId`, else on the call's device (the turn's, else
    the job's);
  - it has the contract's bounds and errors (`invalid`, `no_device`, `unknown_device`, `limit`, `busy`, `failed`);
  - **a start that was committed is a success**: what happens to the countdown afterwards is owed work, never an
    error, and `busy` and `failed` mean nothing was started (the voice start the same);
  - a call made under a job is written as that job.
- **The ambient line** comes with the Home setting "Household facts in every reply", which is off by default:
  - it reads like "Timers running (most recently changed): pasta timer with 6 minutes 10 seconds left, eggs timer
    paused with 4 minutes left, and 1 more.";
  - it is made from the ten most recently changed rows the host reads, names at most three running timers, and says
    nothing about timers it did not read;
  - it is in English: it is context for the model.

Everything is local: no outside service, no network.

## Tools

There are six typed actions, each with English and Dutch `examples`; the intent path can run them directly. The model is offered each as the tool `timers_<id>`.

The three things people say most are also **phrase commands** (after the wake phrase, with no model call). Every action
that changes something is `change`; `list` is a plain read. Each answers with one sentence in the household's language.

| Tool | Parameters | Example | Answer |
|---|---|---|---|
| `timers_start` | `duration` (a duration), `name?` (text), `inlineName?` (the complete named timer clause) | "set a pasta timer for eight minutes" | "Pasta timer, 8 minutes." / "Timer set for 10 minutes." |
| `timers_list` | `name?` | "how long is left on the pasta" | "Pasta timer: 6 minutes 10 seconds left." |
| `timers_adjust` | `amount` (a duration), `change` (`add`, `remove`), `name?` | "add five minutes to the pasta timer" | "Pasta timer: a quarter of an hour left." |
| `timers_pause` | `name` | "pause the timer" | "Pasta timer paused with 4 minutes 10 seconds left." |
| `timers_resume` | `name` | "start the pasta timer again" | "Pasta timer runs again: 4 minutes 10 seconds left." |
| `timers_cancel` | `name?`, `all?` (yes/no), `bulk?` (explicit all-timers target) | "cancel the eggs timer" | "Eggs timer cancelled." / a ringing one: "Eggs timer stopped." |

The typed path preserves names after “my”, “our”, “the”, “mijn”, “onze”, “de”, and explicit naming words.
These named requests never fall back to a different sole timer. Pause and resume require a target; if the typed
path cannot extract it, they ask. Structured calls can use `name: "timer"` for an unqualified timer target.
Cancellation requires the literal bulk target after “all” or “alle” (`bulk: "timers"` in a structured call);
an uncertain `all: true` alone asks for a target. A name and an explicit bulk target together also ask. Adjustment requires its direction; “take a minute off” means
subtraction, and an unresolved direction asks instead of adding by default. Structured adjustment calls supply
`change: "add"` or `change: "remove"`.

Named “set” and “start” phrases preserve the entire name. If the typed fallback reads the same words as both a
named timer clause and its duration, core hands the complete request to the conversational agent without creating
an unnamed or partly named timer.

The direct path understands the phrase table below, targets after an article, possessive or explicit naming word,
and additions/subtractions with a duration and direction. A captured start clause must contain a complete name (if
present), timer noun and matching duration; unknown text asks instead of starting an unnamed timer. Bare named
adjustments/cancellations and other wording can be handed to the assistant's model when extraction cannot resolve
them. Any repetition word anywhere in a prospective timer name (including “repeating”, “recurring”, “every”,
“daily”, “weekly”, “monthly” and their Dutch forms) refuses the request: the answer says timers do not repeat and
suggests a repeating alarm; no timer is created. This also covers named requests such as “repeating tea timer”
and “terugkerende thee timer”. Actions receive declared
parameters, not the utterance, so they cannot inspect words extraction never supplied.

**Phrase commands.** Start and list names take at most three words; cancel names take at most 64 words, subject to
the stored name limit of 60 characters. The action resolves each name with its own "I don't know a timer called …" sentence.

| Action | English | Dutch |
|---|---|---|
| start | "set a timer for {duration}", "set a {name} timer for {duration}", "start a timer for {duration}", "start a {name} timer for {duration}", "timer for {duration}", "set the timer for {duration}" | "zet een timer op {duration}", "zet een timer van {duration}", "zet een timer voor {duration}", "timer van {duration}", "timer op {duration}", "zet een {name} timer op {duration}" |
| list | "how long is left", "how much time is left", "how long is left on the timer", "how long is left on the {name}", "how long is left on the {name} timer" | "hoe lang nog", "hoeveel tijd is er nog", "hoe lang duurt de timer nog", "hoe lang duurt de {name} nog", "hoe lang duurt de {name} timer nog", "hoeveel tijd heeft de {name} timer nog" |
| cancel | "cancel the timer", "cancel the {name} timer", "cancel timer", "stop the timer", "stop the {name} timer", "delete the timer" | "annuleer de timer", "annuleer de {name} timer", "annuleer de timer {name}", "stop de timer", "zet de timer uit", "zet de {name} timer uit" |

"Stop" alone while it rings is the host's (its essential control and the ringing window), not a phrase of this module.

- **Adjusting**: time taken off that would end it is refused, with what it has ("That would end it now: pasta timer has
  only 2 minutes left."). Once an adjustment and its job are committed, the answer confirms it; a later countdown
  failure is retried by reconciliation and never asks the person to apply the same adjustment again.
- **Refusals**, in both languages:
  - 50 timers already;
  - a name that runs already;
  - a name that is not one line of at most 60 characters;
  - a duration over 24 hours (the duration parameter refuses it first);
  - no device to ring on (a routine step run without a turn);
  - the store busy ("The timers are busy just now; try again in a moment.") or failing.
- **Instructions** (stable): a bare duration is a timer (`timers_start`); a task said with a time is a reminder; timers
  are the household's.

## Settings

| Field | Kind | Default | What it does |
|---|---|---|---|
| Snooze for (`snoozeMinutes`) | 1–30 minutes | 5 | How long a ringing timer waits after Snooze |
| Ring for (`ringMinutes`) | 1–120 minutes | 15 | How long it rings before it stops by itself, and how long a refused ring is tried again |

No secrets, no addresses. A value outside its bounds keeps the module from running.

## What it stores

**One collection, `timers`**, household scope.

- `maxChars` is 1,900: the worst legal row fits it (`checkModule` computes it), so one list reads at most 13 rows. The
  module asks for pages of 12.
- **Indexes**:
  - `phase`: the active timers, by `createdAt`;
  - `[phase, endedAt]`: the clean-up;
  - `[pending, nextAt]`: the rows with something to come, in order.
- **A row**:
  - the name (one line, at most 60) and the duration it was set for;
  - the device it rings on and that device's room;
  - its state, its moment or what it has left;
  - the ring number;
  - the owed ring (occurrence, tries, next try);
  - the last ring (its notification, when it was sent, when it stops, the press already done for it);
  - at most one ring to take away;
  - the countdown that may be on a screen (and whether it is known to be shown), with its retries;
  - `pending` and `nextAt`, and when it ended.

**Reads**:

- the active timers: at most 64, in pages of 12, so a read that finds more than 50 says so;
- the rows with something to come: at most 200;
- the module's open notifications: at most 10, one page.

**How long rows stay**: a timer that ended, with nothing owed, is kept a day. The hourly job `sweep` (cron `17 * * * *`,
and once at start) removes older ones, oldest first, a page per transaction with a yield between, written as the job.
Removed rows stay in the daily backups up to 14 days.

**Nothing personal**: a timer names no person and has no owner. A label such as "pills" is shown as it is, as the
research and the owner want, and every device hears and sees the same. Rows are not projected to voice pages; the
countdown presentation is what screens show.

**Jobs**:

- one `due` per row with something to come (at most the 50 running, plus the few that are ringing, waiting or
  cleaning up), always with the timer's device as its origin;
- `sweep`, hourly and once at start;
- `trouble`, a one-off that fails on purpose when a ring was missed.

## What it needs

- `requires`: nothing outside the process; `uses`: nothing.
- **Core services**:
  - the scheduler;
  - the notification service (`ctx.notify`: ringing, action handlers);
  - the Presenter (`ctx.present`: the countdown);
  - `Devices` (the service's `unknown_device` and the device's room).
- **Provides the `Timers` service** (`packages/module-contracts/src/timers.ts`). These are `invalid`:
  - a label with a line break, an empty one, or one over 60 characters;
  - a second timer of a label that is already running (names must tell timers apart).

## How long a ring takes to leave the server

This is measured by `packages/module-timers/test/ringLatency.test.ts`, a latency test that CI runs alone. It runs
through the kit's real scheduler engine, notification service and page connection on the in-memory store: ten timers
due at the same instant (the most rings the module may have open), five rounds, on the development machine, in real
time.

| What exactly | Worst of 10 × 5 |
|---|---|
| from the row's `due` handler being entered to the `notification.ring` message being handed to the device's page connection | 4.2–4.5 ms (asserted under `bound(10)`) |
| from that handler being entered to its completion (the ring recorded in the row, the countdown taken down, the next plan written) | 3.0–3.3 ms (asserted under `bound(15)`) |
| from the first handler entered to the tenth message (the engine runs one job of a handler per pass, and the module one row at a time) | 26–27 ms (asserted under `bound(80)`) |

A check that the measurement sees the work: with 5 ms of busy work added inside each send, the first number becomes
7.1–7.2 ms (asserted at least 5 ms).

**Not measured here: the scheduler waking at the due instant.** The kit's clock is a test clock, so the time between a
timer's moment and its handler being entered is not real time in this test. In serve mode the engine sleeps until the
earliest due time on the runtime's timer (at most 10 s at a time, comparing the wall clock with the monotonic one).
SQLite on a file is not measured here either; the store's own latency tests give a `schedule` a 0.3 ms median and a
notification `send` a 0.37 ms median.

The cancel-all check in `packages/module-timers/test/bulkCancelLatency.test.ts` samples a real 1 ms heartbeat while
cancelling 190 expired timers (batches of 50, 50, 50 and 40, expired a minute apart), four rounds on the in-memory store. It
asserts the longest gap stays below `bound(10)` ms, including the one atomic batch write and the keyed job
cancellations. The heartbeat must also advance during the pending-row scan. Page reads, preparation and cleanup
yield in batches so audio can keep running between them.

## Contract readings

- **"At most 50 running timers"** is read as active timers: running, snoozed and paused, not counting one that rang. A
  snooze or "five more minutes" at the bound is refused on the card, and the card stays.
- **A label that is already running** is `invalid`, with the reason in `detail`. This was decided after review 1.

## Missing below

These are below the module. The notification service and the Presenter are not changed in this pull request.

- **"Send once."** The notification service forgets a key as soon as its notification is resolved. So a ring whose
  sending was not recorded can sound again after a Stop (delivery at least once, above).
  - Smallest change: remember a module's key for a while (the ring time) after its notification was resolved, and
    answer a send under it with that notification.
- **The end of a notification, as seen by its action handler.** When Stop and a button are pressed for the same ring at
  the same moment, the timer may ring again once (above).
  - Smallest change: tell the handler that its notification was ended before its outcome was recorded (or fail that
    outcome). The module would then not keep its follow-up.
- **Dismissing a pinned presentation by its key.** After a restart the module replaces the countdown by its key and
  dismisses that.
  - Smallest change: `ctx.present.dismiss({ key })` for the module's own presentations.
- **More than 8 countdowns at once.** The Presenter keeps at most 8 live presentations per module
  (`MAX_LIVE_PER_MODULE`). A ninth running timer runs and rings without a countdown.
  - Smallest change: a per-module bound for `timer` presentations, or counting them per device.
- **A Health issue raised by a module at run time.** A module's `health` sees only its settings, so a missed ring is
  reported through a job that fails on purpose.
  - Smallest change: `ctx.host.reportIssue(id, issue)` / `clearIssue(id)` for the module's own issues.

## What was left out

Left out because the preparation parts' first versions do not have it:

- **Ringing on another device of the room, or where the owner was last active, when the device is offline.** The
  notification service has two targets only, `origin` and `everywhere` (docs/NOTIFICATIONS.md "Not now": "ring
  policies beyond the two targets"). Offline, a timer's card waits on its device until the ring stops.
- **A ring that always sounds under do not disturb, and escalation.** Do not disturb keeps every ring silent, and there
  is no priority above `ring` (docs/NOTIFICATIONS.md).
- **Updating a ringing card.** There is no `update` of a notification (docs/NOTIFICATIONS.md "Not now"). More time while
  it rings is a new countdown, and the ring is taken away.
- **The Orbit, Ambient and Hold-up stage layouts, an alert for characters, and buttons on the countdown.** The first
  version of presentations has the plain `timer` kind (docs/PRESENTING.md). Buttons on the countdown could be added
  with a press handler.
- **A queue beyond the owed ring when ten rings are open.** Each timer keeps its own owed ring and retries it; nothing
  orders them.
- **Events** (`timers.started`, `timers.finished`, …) for routines: no consumer in this version.
- **Node-local copies, the phone, sunrise and music**: out of the plan's row.
- **Matching by area and duration** (Home Assistant's rules after the name): with no name and several timers, the
  module asks.

## Review

Review round 1 found 14 blocking problems. Seven of them came from one cause: the ring, its retry, the snooze, the next
occurrence and the countdown each had their own job, marker or cached handle, and these disagreed after a failure.

The module now keeps one row state with one job, reconciled by one function. On top of that:

- presses act only on the current ring;
- notification keys are per ring;
- clean-up is owed work;
- writes carry who made them (a button's device, a job);
- the tests run the old handler itself, measure the latency at the page boundary, and cover the `Timers` service's own
  failures.

`packages/module-timers/test/review1.test.ts` has one test or more per finding.

Review round 2 (the deciding review) found 13 blocking problems, mostly where two features met a failure at the same
moment. Two of those meeting points were removed instead of patched:

- alarms are no longer changed (see the alarms page);
- the check a press made after its write, and the take-back that hung on it, are gone: the Stop limit is stated above
  instead.

The rest were fixed where they were:

- a timer has one ring at a time: the previous card is resolved before a new one is sent;
- one function lets go of the current ring and first looks for a sent but unrecorded card by its key;
- cancelling again finishes owed clean-up;
- a committed start is a success;
- a countdown is recorded before it is shown;
- the Health report of a missed ring is written in the transaction that gives the ring up.

`packages/module-timers/test/review2.test.ts` has one test or more per finding.
