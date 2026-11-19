# Alarms (`alarms`)

One-off and repeating alarms that ring on the device they were set for.

- Package: `packages/module-timers` (with `timers`)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 2 (wave B)
- Research: [docs/research/modules/timers-and-alarms.md](../research/modules/timers-and-alarms.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Alarms that ring on the device they were set on, either once ("wake me at seven", "tomorrow at 6:30") or repeating
("every weekday at quarter to seven", "elke werkdag om half zeven"). Up to 50 at once.

**An alarm is not changed.** To move one, it is cancelled and set again (`alarms_cancel`, then `alarms_set`). The tool
descriptions and the instructions say so, so the model does exactly that.

It is a separate module from `timers`, so an assistant can have one without the other.

### When

What the person said is read by `@pva/language`, never guessed:

- first as a recurrence (`parseRecurrence`), also with the time first ("6:30 every day");
- else as one moment (`parseDateTime`).

**A time said without morning or evening falls between 05:00 and 16:59.** "seven" is 07:00 and "two" is 14:00, never
19:00 or 02:00; "8 pm" is 20:00.

Some requests are a question or a refusal instead:

- an ambiguous moment ("next Friday at 7") is a question;
- a rule with no time ("every Monday") is a question;
- a moment that has passed, or one beyond the same local date and time next year, is refused (29 February clamps to
  28 February when needed).

The answer says the day and the time with its part of the day, so a mistake is heard: "Alarm set for tomorrow at seven
o'clock in the morning.", or "Alarm set every weekday; the first one is tomorrow at quarter to seven in the morning.".

The zone is the Home section's, trimmed and made canonical by one function; spaces around it are accepted, as the Home
section accepts them. It is stored with each alarm.

### What an alarm is at any moment

An alarm is one row. It holds:

- the device it rings on;
- its name, if any;
- for a repeating alarm, its recurrence (`RRULE`, `DTSTART`);
- **its next occurrence not yet handed to delivery** (`next`), kept as the **nominal local date and time**, with the
  instant derived from them.

Keeping the nominal date and time matters: in Nuuk, "every Saturday at 11:30 pm" falls in the spring gap on 28 March
2026, and its instant is Sunday 00:30. It is still Saturday's 23:30 alarm: it is said, matched and skipped as that.

The same row holds what is owed for the alarm:

- **a ring that is due and not sent yet** (`owed`: the occurrence, the tries, the next try);
- **the last ring** (`ring`: its notification, the nominal date and time of the occurrence it is for, and, after Snooze
  or Five more minutes, the instant it rings again);
- **at most one ring still to be taken away.**

An alarm is **set** while something is still to ring: an occurrence, an owed ring or a snooze. Otherwise it has
**ended**. `nextAt` is the next moment anything happens for the row, and the row has **exactly one scheduler job** (key
`alarm:<id>`), planned for that moment in the same transaction as every write.

That job, every action, every button and the hourly sweep **reconcile** the row:

- **An occurrence that is due becomes owed, and the series moves on in the same write**, whatever then becomes of the
  delivery. A busy notification service can delay a ring; it never loses the series.
- A snooze that is due becomes the next owed ring, unless a newer series occurrence is already due; the latest due
  instant wins.
- The owed ring is sent.
- Old rings are taken away.

Only the row's own job sends; its origin is the alarm's device. The sweep plans the job again for any row that lost its
own.

### The late rule

A ring that cannot be sent within **15 minutes** of its time is not rung. The server may have been down, or the
notification service may have refused it all that time (it allows ten open notifications per module). Until then it is
tried again every 30 seconds.

Instead of the ring, a **silent card on its device** says it was missed. It names no cause, since the module does not
know it, and it is worded from the day it is told: "The alarm for Wednesday the eighteenth of November 2026 at ten oh
one in the morning could not ring." ("De wekker voor … kon niet afgaan.").

If even that card cannot be sent, the Health page says so: a job of the module (`trouble`) fails on purpose. That job
is written in the same transaction that gives the ring up; if neither the card nor the job can be made, the ring is not
given up and stays owed.

After an outage of several occurrences, the latest one is the one counted (missed or rung). The next one is always
planned after now, never in the past. A ring up to 15 minutes late rings, and says how late.

### Ringing

- A `ring` notification on the alarm's device, titled with its name there ("Pills alarm"), with **Snooze** (the snooze
  setting's minutes, 9 by default) and **Five more minutes** beside the host's **Stop**.
- **One ring per alarm at a time.** Before a new ring is sent (a snooze, Five more minutes, the next occurrence), the
  previous card is resolved. While that cannot be done, the new ring waits as owed and is tried again; it is never
  sent beside the old card. The notification key is per occurrence (`alarm:<id>:<number>`).
- **Snooze and Five more minutes** set the row's ring to ring again; the series is not moved.
- **The buttons act only on the alarm's current ring.** A press of any other card is answered "That ring has ended."
  and changes nothing. A press is done once per notification; replaying it reports the committed time still left,
  even when a different button was pressed. Reactivating a one-off obeys the 50-set limit and keeps its card on refusal.
- **Stop** is the host's: the card, "stop", and "stop" without the wake phrase while it rings.

**Delivery is at least once.** The order is: write the owed ring, send it under its key, write that it was sent. If the
server fails between the send and that last write, the next reconcile within the delivery window records the ring when
its card is still open.
If **Stop was pressed in that moment, it sends it again: a ring can sound a second time, and it is never lost.** A cancel
in that moment finds the card by its key and takes it away.

If a delivery is first refused, a later send succeeds but its outcome write fails, and recovery happens beyond the
delivery window, a missed card can appear while the ring card is still open and voice cancel cannot find it; the
host's Stop still ends the ring card, or it expires after the ring setting's minutes.

**Stop and a button pressed at the same moment.** When Stop and Snooze or Five more minutes are pressed for the same
ring at the same moment, the card follows whichever the notification service recorded first. **The alarm may still
ring again once**; saying "stop" or "cancel the alarm" again ends it. "Missing below" on the timers page says what
would close both limits.

### An alarm's name is shown and spoken only on the device it rings on

On every other device an alarm is its time, its repetition and its device: "One alarm: tomorrow at quarter to seven
in the morning on Robin's phone, every weekday.".

Its name is not even matched there: "cancel the pills alarm" on the kitchen display answers "I don't know an alarm
called pills here.", since finding it would tell that the name exists. Its time is matched ("cancel the quarter to
seven alarm").

The ring goes only to its own device. The decision is made when answering, for the device that asks.

### Snoozed and ringing alarms

A snoozed alarm is part of its row: it is listed with its nominal time and when it rings again ("One alarm: tea today
at ten oh one in the morning, ringing again today at ten past ten in the morning."), and a ringing one is listed as
ringing. Either can be cancelled by voice, also after a
restart: "The snoozed alarm is cancelled.". Ringing, waiting and withdrawing one-offs keep their nominal time in the
list and selection question, including on other devices; their labels stay on their own device.

- From any device it can be cancelled by its time: the time it was set for, also when it rang late or next to a
  daylight-saving change.
- On its own device it can also be cancelled by its name.

### Only the next, or all

Cancelling a repeating alarm must say which. Without it the answer is the question "That alarm repeats every weekday.
Only the next one, or all of them?", and nothing changes (docs/MODULES-PLAN.md §2 row 6).

- **"Only the next"** skips that occurrence ("… is skipped; the next one is Friday at quarter to seven in the
  morning."). When a snooze is still to ring, that snooze is the next ring: "The snoozed alarm is cancelled; the next
  one is tomorrow at …". An owed snooze is still matched by its snooze time, and cancelling again while its withdrawal
  is unfinished finishes that withdrawal before skipping a later series occurrence.
- **"All"** ends the series.

### Clean-up

Taking a ring away is owed work in the row. It is cleared only when it succeeded, and tried again a minute later by the
job, also after a restart, until the ring stops by itself. The sentence is true:

- "The alarm is cancelled; its ring is still being stopped, and I keep trying." while that is so;
- **cancelling again finishes it**: "The alarm's ring is stopped now.". Such an alarm can be cancelled again as the
  only one, by its time from any device, or by its name on its own device. Lists of alarms do not show it.

Cancelling, and a new occurrence that replaces an owed ring, let go of the alarm's ring in one way. A ring whose sending
could not be recorded yet is first looked for among the open notifications by its key, and taken away; only then is
the owed ring forgotten.

### Which alarm

- by name, on its own device;
- or by its time ("6:45": its next occurrence, its snooze, or the time its owed or ringing occurrence was set for);
- or the only one there is;
- otherwise a question that lists them. Never the first of several.

### One change at a time

Every action, the jobs and the action handler run under one permit of the module's shared part and read their row again
inside it.

Everything is local: no outside service, no network.

## Tools

There are three typed actions, each with English and Dutch `examples`. The intent path runs them without the model, and
the model is offered each as `alarms_<id>`. There are no phrase commands: the plan gives phrases to the timers only.
`set` and `cancel` are `change`; `list` is a plain read. **Moving an alarm is `alarms_cancel` followed by
`alarms_set`.**

| Tool | Parameters | Example | Answer |
|---|---|---|---|
| `alarms_set` | `when` (text, as said), `name?` | "wake me at seven" | "Alarm set for tomorrow at seven o'clock in the morning." |
| `alarms_list` | none | "which alarms are set" | "2 alarms: tomorrow at quarter to seven in the morning, every weekday and tomorrow at nine o'clock in the morning." |
| `alarms_cancel` | `which?` (a name or a time), `scope?` (`next`, `all`) | "cancel tomorrow's alarm only" | "The alarm for tomorrow at quarter to seven in the morning is skipped; the next one is Friday at quarter to seven in the morning." |

Dutch: "zet een wekker om half acht" answers "Wekker gezet voor morgen om half acht 's ochtends.". A repeating one
without a scope answers "Die wekker herhaalt elke werkdag. Alleen de volgende, of allemaal?".

- **Refusals and questions**, in both languages:
  - when exactly;
  - which time (ambiguous);
  - what time (none said);
  - passed;
  - more than a year ahead;
  - a name that is not one line of at most 60 characters;
  - 50 alarms already;
  - no device (a routine step without a turn);
  - the store busy or failing.
- **Instructions** (stable): alarms ring on the device they are set on; an alarm is not changed (to move one, cancel it
  and set it again); pass a scope only when the person said "only the next" or "all".

## Settings

| Field | Kind | Default | What it does |
|---|---|---|---|
| Snooze for (`snoozeMinutes`) | 1–30 minutes | 9 | How long a ringing alarm waits after Snooze |
| Ring for (`ringMinutes`) | 1–120 minutes | 15 | How long it rings before it stops by itself |

No secrets, no addresses. A value outside its bounds keeps the module from running.

## What it stores

**One collection, `alarms`**, household scope.

- `maxChars` is 2,300: the worst legal row fits it (`checkModule` computes it), so one list reads at most 10 rows. The
  module asks for pages of 10.
- **Indexes**: `phase`, `[phase, endedAt]` and `[pending, nextAt]`.
- **A row**:
  - its name and the device it rings on;
  - its zone;
  - the recurrence;
  - `next` (nominal date, nominal time, instant);
  - the occurrence count;
  - the owed ring;
  - the last ring (with the nominal date and time of its occurrence) and its snooze;
  - at most one ring to take away;
  - `phase`, `pending`, `nextAt`, and when it ended.

**Reads**:

- the set alarms: at most 60 in pages of 10, so a read that finds more than 50 says so;
- the rows with something to come: at most 200;
- the open notifications: at most 10.

**How long rows stay**: an ended alarm with nothing owed is kept a day. The hourly `sweep` (cron `23 * * * *`, and once
at start) removes older ones in pages, written as the job.

**Personal content**: none with an owner. An alarm belongs to a device, not a person; its **name** is the part treated
as private to that device (above). Rows are never projected to voice pages, so a page that claims a device id gets
nothing of them; the ringing card goes only to the alarm's device.

**Jobs**:

- one `due` per row with something to come, with the alarm's device as its origin (also when it is cancelled or skipped
  from another device);
- `sweep`, hourly and once at start;
- `trouble`, a one-off that fails on purpose when even a missed card could not be sent.

## What it needs

- `requires`: nothing outside the process; `uses`: nothing.
- **Core services**: the scheduler, the notification service, `Devices` (device names in answers).
- **`@pva/language`**: `parseRecurrence`, `parseDateTime`, `parseTimeOfDay`, `nextOccurrence`,
  `parseDtstart`, `describeRRule`, `speakMoment`, `speakTime`, `normalizeTimeZone`.

## What was left out

Left out because the preparation parts' first versions do not have it:

- **An alarm that always sounds under do not disturb, the phone two minutes later, and escalation.** Do not disturb
  keeps every ring silent, and there is no priority above `ring` (docs/NOTIFICATIONS.md). Phones are out of scope.
- **Ringing elsewhere when its device is offline, and a warning the evening before.** The notification service has two
  targets only (docs/NOTIFICATIONS.md "Not now").
- **Showing other rooms' alarms on screens**: no presentation is made for alarms in this version.
- **A gentle ramp, sunrise on the screen, light fades, music alarms, node-local copies**: out of the plan's row.
- **"My alarm" as a person's**: alarms belong to devices.
- **A queue beyond the owed ring when ten rings are open.**
- **Events** (`alarms.dismissed` for routines): no consumer in this version.

Missing below the module ("send once", the end of a notification as seen by its action handler, a Health issue raised
at run time): see the timers page, "Missing below".

## Contract readings

- **The research's "cancel for good from another device asks for a repeat"**: core confirmations are off
  (docs/MODULES-PLAN.md §2 row 6). The module asks "only the next one, or all of them?" whenever the scope was not said,
  on every device, which is the plan's reading.
- **Times are said everywhere**: an alarm's time and repetition are household data; only its name stays on its device.

## Review

Review round 1's findings for alarms:

- a series lost when a ring was refused (1);
- a ring sent but not recorded (2);
- a press whose outcome was lost (3);
- Stop during a press (4; its check was replaced by a stated limit in round 2);
- a ring withdrawal that failed (5);
- snoozed alarms missing from list and cancel (7);
- the nominal date lost in a gap (8);
- a zone with spaces (9);
- the missed day worded wrongly (10);
- who made a button's write (11);
- the old handler's test (12).

These are fixed by the same one-row, one-job design as the timers. Each has its test in
`packages/module-timers/test/review1.test.ts`.

Review round 2 (the deciding review) found 13 blocking problems; for alarms:

- **Changing alarms is cut** (an alarm is cancelled and set again). Three findings went with it: a change of "only the
  next" that could commit half, a superseded owed occurrence that still rang, and a snooze that "only the next"
  missed.
- **The check a press made after its write is gone**, and the Stop limit is stated instead (above).
- **One ring per alarm at a time.** The previous card is resolved before a new one is sent.
- **One way to let go of an owed or ringing occurrence.** It first looks for a sent but unrecorded card by its key.
- **A ring remembers the time it was set for**, and is cancelled by that time.
- **Cancelling again finishes owed clean-up.**
- **The Health report is written with the giving-up.**
- **The missed card names no cause.**

Each has its test in `packages/module-timers/test/review2.test.ts`; the cut is pinned in `alarms.test.ts`.
