# Timers (`timers`)

Named countdown timers that ring on the device that set them.

- Package: `packages/module-timers` (with `alarms`)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 2 (wave B)
- Research: [docs/research/modules/timers-and-alarms.md](../research/modules/timers-and-alarms.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Countdown timers, as household data: "set a pasta timer for ten minutes" on the kitchen display makes a timer that
**rings on that device**, whose **countdown shows on every screen of that device's room**, and that anyone may ask
about, change or stop from any device and through any assistant that has the module on. Up to 50 run at once (the
`Timers` contract's bound).

- **One row and one job per timer.** Each timer is a row of the module's `timers` collection with its due instant, and
  one scheduler job of its own (`ring`, key `timer:<id>`) for that instant, written in the same transaction as the row.
  The notification service sends now and never later, so the job is what makes it ring.
- **Ringing.** When the job runs it sends a `ring` notification (title "Pasta timer is done") on the timer's device
  (the job's origin), with two actions beside the host's **stop**: **Snooze** (it rings again after the snooze
  setting's minutes, without a countdown) and **Five more minutes** (it counts down five minutes again, with its
  countdown). Each is an action handler registered in the module's shared part, **idempotent by the notification's
  id**: the row remembers the notification it acted on, and a second run for the same notification (after a store
  failure) answers the same and changes nothing. Stop is the host's: on the card, as the spoken "stop" (also without
  the wake phrase while it rings: the ringing window), or the button labels said while it rings ("snooze", "five more
  minutes"). A ring stops by itself after the ring setting's minutes.
- **The countdown** is the `timer` presentation, **pinned** while the timer runs, shown with the target `{ room }` of
  the device that set it (or that device alone when it has no room) and the key `timer:<id>`: it is replaced in place
  when the time changes, and **dismissed** when the timer is paused, rings, is cancelled or is stopped. A countdown shown
  before a restart of the module is replaced by its key and then dismissed (the new part holds no handle to it). It is
  household data, so every screen of the room shows it whoever is its default person.
- **Which timer is meant**: by name ("the pasta timer", compared without case, accents, punctuation, a leading article
  and a trailing "timer"); with no name, the only one there is (running, paused, snoozed or ringing); otherwise a
  question that lists them: "There are 2 timers: pasta timer paused with 10 minutes left and eggs timer with 6 minutes
  left. Which one?" **Never the first of several.** A name nobody has: "I don't know a timer called eggs." Two running
  timers cannot have the same name: a second "pasta" is refused with what the first has left.
- **One change at a time.** Every read that answers and every change (each action, the `Timers` service, the ring job,
  the two action handlers) runs under one permit of the module's shared part, and reads its rows again inside it. A
  cancel said while the ring job is sending waits for it and then stops the ring it sent; a job that is no longer the
  row's (the row names another job id after an adjust, a pause, a cancel) does nothing.
- **How long is left** is said to the second under ten minutes ("6 minutes 10 seconds"), else to the minute ("a quarter
  of an hour"), through `@pva/language`'s `speakDuration`; a list names at most three ("and 47 more"), ringing ones
  first, then the soonest.
- **A timer due while the server or the module was down** rings as soon as the module runs again, however late, and
  its card says how late: "The 10 minutes timer ended 3 minutes ago, while I couldn't ring."
- **The `Timers` service** for other modules (routines; kitchen later), exactly as `packages/module-contracts/src/timers.ts`
  says: `start({ durationMs, label?, ringOn? })`, ringing on `ringOn.deviceId` or the call's device (the turn's, else
  the job's), with its bounds and errors (`invalid`, `no_device`, `unknown_device`, `limit`, `busy`, `failed`).
- **The ambient line** (the Home setting "Household facts in every reply", off by default): "Timers running (most
  recently changed): pasta timer with 6 minutes 10 seconds left, eggs timer paused with 4 minutes left, and 1 more."
  It is made from the rows the host reads (the ten most recently changed), names at most three running timers, and
  says nothing about timers it did not read (it never says "no timers"; with none among those rows it adds no line).
  It is one bounded index read of ten rows and a small function: within the host's 50 ms budget. Its words are
  English: it is context for the model, which answers in the household's language.

Everything is local: no outside service, no network.

## Tools

Six typed actions with English and Dutch `examples`, so the intent path runs them without the language model; the model
is offered each as the tool `timers_<id>`. The three things people say most are also **phrase commands** (after the
wake phrase, with no model call). Every one that changes something is `change`; `list` is a plain read
(`speculative`). Each answers with one sentence in the household's language.

| Tool | Parameters | Example | Answer |
|---|---|---|---|
| `timers_start` | `duration` (a duration), `name?` (text) | "set a pasta timer for eight minutes" | "Pasta timer, 8 minutes." / "Timer set for 10 minutes." |
| `timers_list` | `name?` | "how long is left on the pasta" | "Pasta timer: 6 minutes 10 seconds left." |
| `timers_adjust` | `amount` (a duration), `change?` (`add`, `remove`), `name?` | "add five minutes to the pasta timer" | "Pasta timer: 15 minutes left." |
| `timers_pause` | `name?` | "pause the timer" | "Pasta timer paused with 4 minutes 10 seconds left." |
| `timers_resume` | `name?` | "start the pasta timer again" | "Pasta timer runs again: 4 minutes 10 seconds left." |
| `timers_cancel` | `name?`, `all?` (yes/no) | "cancel the eggs timer" | "Eggs timer cancelled." / a ringing one: "Eggs timer stopped." |

**Phrase commands** (a name is a text slot of at most three words, resolved by the action with its own "I don't know a
timer called …" sentence):

| Action | English | Dutch |
|---|---|---|
| start | "set a timer for {duration}", "set a {name} timer for {duration}", "start a timer for {duration}", "timer for {duration}", "set the timer for {duration}" | "zet een timer op {duration}", "zet een timer van {duration}", "zet een timer voor {duration}", "timer van {duration}", "timer op {duration}", "zet een {name} timer op {duration}" |
| list | "how long is left", "how much time is left", "how long is left on the timer", "how long is left on the {name}", "how long is left on the {name} timer" | "hoe lang nog", "hoeveel tijd is er nog", "hoe lang duurt de timer nog", "hoe lang duurt de {name} nog", "hoe lang duurt de {name} timer nog", "hoeveel tijd heeft de {name} timer nog" |
| cancel | "cancel the timer", "cancel the {name} timer", "cancel timer", "stop the timer", "stop the {name} timer", "delete the timer" | "annuleer de timer", "annuleer de {name} timer", "annuleer de timer {name}", "stop de timer", "zet de timer uit", "zet de {name} timer uit" |

"Stop" alone while it rings is the host's (its essential control and the ringing window), not a phrase of this module.

- Adjusting: time taken off that would end it is refused with what it has ("That would end it now: pasta timer has only
  2 minutes left."); a ringing timer given more time runs again for that long ("Eggs timer runs again: 2 minutes.").
  A paused timer keeps what it has left; pausing or resuming a ringing one says to say stop.
- Refusals, in both languages: 50 timers already, a name that runs already, a name that is not one line of at most 60
  characters, a duration over 24 hours (the duration parameter refuses it first), no device to ring on (a routine step
  run without a turn), the store busy ("The timers are busy just now; try again in a moment.") or failing.
- Instructions (stable): a bare duration is a timer (`timers_start`); a task said with a time is a reminder; timers are
  the household's.

## Settings

| Field | Kind | Default | What it does |
|---|---|---|---|
| Snooze for (`snoozeMinutes`) | 1–30 minutes | 5 | How long a ringing timer waits after Snooze |
| Ring for (`ringMinutes`) | 1–120 minutes | 15 | How long it rings before it stops by itself (the notification's expiry) |

No secrets, no addresses. A value outside its bounds keeps the module from running, and its page says why.

## What it stores

One collection, `timers`, **household** scope, `maxChars` 1,300 (the worst legal row is about 1,200 characters of JSON;
one list reads at most 19 rows, the module asks for pages of 16). Indexes: `phase` (the active timers, oldest first, by
`createdAt`) and `[phase, endedAt]` (the clean-up). A row: the name (one line, at most 60), the duration it was set
for, `state` (`running`, `paused`, `rang`, `cancelled`), `phase` (`active`, `ended`), whether it is snoozed, its due
instant, what is left when paused, the device it rings on and that device's room, the id of its ring job, of its
ringing notification and of the notification whose snooze it already carried out, and when it ended.

- **Reads**: the active timers, at most 64 in pages of 16 (more than the 50 that may run, so a read that finds more says
  so: "More than … timers"), and the module's open notifications (at most 10, one page).
- **Kept**: an ended timer (rang or cancelled) a day; the daily job `cleanup` (cron `17 4 * * *`) removes older ones,
  oldest first, a page per transaction with a yield between, written as the job. Removed rows stay in the daily backups
  up to 14 days.
- **Nothing personal**: a timer names no person and has no owner (a label such as "pills" is shown as it is, as the
  research and the owner want); every device hears and sees the same. Nothing is projected to voice pages: what a
  screen shows is the countdown presentation.
- **Jobs**: one `ring` per running timer (at most 50, plus the few a snooze brings back), always with the timer's device
  as its origin (also when it is moved from another device); `cleanup` daily.

## What it needs

- `requires`: nothing outside the process; `uses`: nothing.
- Core services: the scheduler, the notification service (`ctx.notify`: ringing, action handlers), the Presenter
  (`ctx.present`: the countdown), `Devices` (the service's `unknown_device`).
- Provides the **`Timers`** service (`packages/module-contracts/src/timers.ts`). A label with a line break, an empty one
  or one over 60 characters is `invalid`; so is a second timer of a label that runs already (names must tell timers
  apart). See "Contract readings".

## How late it rings

Measured by `packages/module-timers/test/ringLatency.test.ts` (a latency test: CI runs it alone), through the kit's real
scheduler engine, notification service and page boundary on the in-memory store, ten timers due at the same instant
(the most rings the module may have open), five rounds, on the development machine:

| What | Number |
|---|---|
| on the scheduler's clock: the ring stored and sent, against the due instant | 0 ms for each of the ten (asserted) |
| real time from the scheduler calling the ring handler to the card leaving for the page (the lock, a row read, the send, the row's write, the countdown dismissed) | worst 1.4–1.6 ms (asserted under `bound(10)`) |
| real time from the first handler call to the last of the ten cards (the engine runs one job of a handler per pass) | worst 21–23 ms (asserted under `bound(60)`) |

In serve mode the engine's own wake-up comes on top: it sleeps until the earliest due time with the runtime's timer
(at most 10 s at a time, comparing the wall clock with the monotonic one), so a ring leaves the server within a few
milliseconds of its instant plus the module's share above. Not measured here: SQLite on a file (the store's own latency
tests give a `schedule` 0.3 ms median and a notification `send` 0.37 ms median) and the page's own ring cue.

## Contract readings

- **"At most 50 running timers"**: read as active timers (running, snoozed and paused), not counting one that rang. A
  snooze or "five more minutes" at the bound is refused on the card ("There are already 50 timers running…"), and the
  card stays.
- **A label that runs already** is not in the contract's list of errors; read conservatively as `invalid` (outside the
  bounds: two running timers of one name could not be told apart by voice), with the reason in `detail`.
- **Where it rings** when `ringOn` is absent inside a job: the job's device, as the contract says; the timer's countdown
  then shows on that device's room.

## What was left out

Left out because the preparation parts' first versions do not have it:

- **Ringing on the next device of the room, or where the owner was last active, when the device is offline**: the
  notification service has two targets only, `origin` and `everywhere` (docs/NOTIFICATIONS.md "Not now": "ring
  policies beyond the two targets"). A timer rings on its device; offline, its card waits there until the ring expires.
- **A ring that always sounds under do not disturb**, and escalation: do not disturb keeps every ring silent, and there
  is no priority above `ring` (docs/NOTIFICATIONS.md).
- **Updating a ringing card** ("add five minutes" while it rings is a new countdown, and the ring is resolved):
  there is no `update` of a notification (docs/NOTIFICATIONS.md "Not now").
- **The Orbit, Ambient and Hold-up stage layouts**, an alert for characters, Pause/+1/Cancel buttons on the countdown:
  the first version of presentations has the plain `timer` kind (docs/PRESENTING.md); buttons on it could be added
  with a press handler and are left for a later PR.
- **Events** (`timers.started`, `timers.finished`, …) for routines: nothing in this version listens to them, and no
  first version of a consumer needs them.
- **Node-local copies, the phone, sunrise and music**: out of the plan's row.

Left out because something is missing below (each with the smallest change that would provide it):

- **Dismissing a pinned presentation by its key** after a restart of the module: a part can only dismiss through a
  handle it got from `show`. The module replaces the countdown by its key (a countdown ending now) and dismisses that.
  Smallest change: `ctx.present.dismiss({ key })` for the module's own presentations (`Present.ts`, `PresentEngine.ts`).
- **More than 8 countdowns at once**: the Presenter keeps at most 8 live presentations per module
  (`MAX_LIVE_PER_MODULE`). A ninth running timer runs and rings, without a countdown. Smallest change: raise the
  per-module bound for `timer` presentations, or count a module's timers per device.
- **Matching by area and duration** (Home Assistant's rules after the name): with no name and several timers, the
  module asks; "the ten-minute timer" is not matched by its length. Nothing is missing below; left for a later
  version to keep "never the first" simple.
