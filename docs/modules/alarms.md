# Alarms (`alarms`)

One-off and repeating alarms that ring on the device they were set for.

- Package: `packages/module-timers` (with `timers`)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 2 (wave B)
- Research: [docs/research/modules/timers-and-alarms.md](../research/modules/timers-and-alarms.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Alarms that ring on the device they were set on: once ("wake me at seven", "tomorrow at 6:30") or repeating ("every
weekday at quarter to seven", "elke werkdag om half zeven"). Up to 50 at once. A separate module from `timers`, so an
assistant can have one without the other.

- **When.** What the person said is read by `@pva/language`, never guessed: first as a recurrence (`parseRecurrence`,
  also with the time first: "6:30 every day"), else as one moment (`parseDateTime`). A time said without morning or
  evening falls **between 05:00 and 16:59**: "seven" is 07:00 and "two" 14:00, never 19:00 or 02:00 (the parser's
  default band would read "6:45" as 18:45). "8 pm" is 20:00. An ambiguous moment ("next Friday at 7") or a rule with no
  time ("every Monday") is a question; a moment that has passed, or more than a year ahead, is refused. The answer says
  the day and the time with its part of the day, so a mistake is heard: "Alarm set for tomorrow at seven o'clock in the
  morning." / "Alarm set every weekday; the first one is tomorrow at quarter to seven in the morning."
- **One job for the next occurrence.** A repeating alarm keeps its `RRULE`, `DTSTART` and zone in its row and has one
  scheduler job (`ring`, key `alarm:<id>`), for its next occurrence; the ring plans the one after, written with the row
  in one transaction, **always after now**. The job always runs (`late: "run"`), so a series is never lost to an outage:
  an occurrence found more than **15 minutes** late is not rung, a silent card on its device says it was missed ("The
  alarm for today at seven o'clock in the morning could not ring: I wasn't running then."), and the next one is
  planned after now, never in the past. One found up to 15 minutes late rings, saying how late. A once alarm ends after
  it rang.
- **Ringing**: a `ring` notification on the alarm's device (the job's origin), titled with its name there ("Pills
  alarm"), with **Snooze** (the snooze setting's minutes, 9 by default) and **Five more minutes** beside the host's
  **stop**. Both are action handlers in the shared part, **idempotent by the notification's id** (the row remembers the
  notification whose snooze it carried out); they ring the same alarm again through a job of their own (`again`)
  without moving the series. Stop is the host's (the card, "stop", also without the wake phrase while it rings).
- **An alarm's name is shown and spoken only on the device it rings on.** On every other device an alarm is its time,
  its repetition and its device: "One alarm: tomorrow at quarter to seven in the morning on Robin's phone, every
  weekday." Its name is not even matched there ("cancel the pills alarm" on the kitchen display: "I don't know an alarm
  called pills here."), since finding it would tell that the name exists; its time is ("cancel the quarter to seven
  alarm"). The ring goes only to its own device. The decision is made when answering, for the device that asks.
- **Only the next, or all.** Cancelling or changing a repeating alarm must say which: without it, the answer is the
  question "That alarm repeats every weekday. Only the next one, or all of them?" and nothing changes (docs/MODULES-PLAN.md
  §2 row 6). "Only the next" skips that occurrence ("… is skipped; the next one is Friday at quarter to seven in the
  morning."); changing only the next makes a one-off alarm of the same name on that day at the new time and skips the
  occurrence, in one transaction; "all" ends the series, or moves every occurrence to the new time (the next one is the
  first of the changed series after now).
- **Which alarm**: by name (on its own device), or by its time ("6:45"), or the only one there is; otherwise a question
  that lists them. Never the first of several.
- **One change at a time**: every action, the two jobs and the action handler run under one permit of the module's
  shared part and read their rows again inside it; a job that is no longer the row's does nothing.

Everything is local: no outside service, no network.

## Tools

Four typed actions with English and Dutch `examples` (the intent path runs them without the model; the model is offered
each as `alarms_<id>`). No phrase commands: the plan gives phrases to the timers only (set, ask and cancel a timer).
`set`, `cancel` and `change` are `change`; `list` is a plain read.

| Tool | Parameters | Example | Answer |
|---|---|---|---|
| `alarms_set` | `when` (text, as said), `name?` | "wake me at seven" | "Alarm set for tomorrow at seven o'clock in the morning." |
| `alarms_list` | none | "which alarms are set" | "2 alarms: tomorrow at quarter to seven in the morning, every weekday and tomorrow at nine o'clock in the morning." |
| `alarms_cancel` | `which?` (a name or a time), `scope?` (`next`, `all`) | "cancel tomorrow's alarm only" | "The alarm for tomorrow at quarter to seven in the morning is skipped; the next one is Friday at quarter to seven in the morning." |
| `alarms_change` | `to` (text), `which?`, `scope?` | "move the weekday alarm to 7:15, all of them" | "The alarm now rings every weekday; the next one is tomorrow at quarter past seven in the morning." |

Dutch: "zet een wekker om half acht" → "Wekker gezet voor morgen om half acht 's ochtends."; a repeating one without a
scope → "Die wekker herhaalt elke werkdag. Alleen de volgende, of allemaal?".

- Refusals and questions, in both languages: when exactly, which time (ambiguous), what time (none said), passed, more
  than a year ahead, a name that is not one line of at most 60 characters, 50 alarms already, no device (a routine step
  without a turn), a new time not understood, the store busy or failing.
- Instructions (stable): alarms ring on the device they are set on; pass a scope only when the person said "only the
  next" or "all".

## Settings

| Field | Kind | Default | What it does |
|---|---|---|---|
| Snooze for (`snoozeMinutes`) | 1–30 minutes | 9 | How long a ringing alarm waits after Snooze |
| Ring for (`ringMinutes`) | 1–120 minutes | 15 | How long it rings before it stops by itself |

No secrets, no addresses. A value outside its bounds keeps the module from running.

## What it stores

One collection, `alarms`, **household** scope, `maxChars` 1,900 (the worst legal row is about 1,750 characters of JSON;
one list reads at most 13 rows, the module asks for pages of 12). Indexes: `[phase, next]` (the set alarms in the order
they ring) and `[phase, endedAt]` (the clean-up). A row: its name, the device it rings on, `phase` (`set`, `ended`), the
next time it rings, the recurrence (`rrule`, `dtstart`, `timeZone`) of a repeating one, the ids of its ring job, of a
snooze's job, of its ringing notification and of the notification whose snooze it carried out, and when it ended.

- **Reads**: the set alarms, at most 60 in pages of 12 (more than the 50 that may be set, so a read that finds more
  says so).
- **Kept**: an ended alarm a day (one whose snooze is still to ring stays until it rang); the daily job `cleanup`
  (cron `23 4 * * *`) removes older ones in pages, written as the job.
- **Personal content**: none with an owner. An alarm belongs to a device, not a person; its **name** is the part that
  is treated as private to that device (above). Rows are never projected to voice pages, so a page that claims a device
  id gets nothing of them; the ringing card goes only to the alarm's device.
- **Jobs**: one `ring` per set alarm, one `again` per pending snooze, both with the alarm's device as their origin
  (also when changed from another device); `cleanup` daily.

## What it needs

- `requires`: nothing outside the process; `uses`: nothing.
- Core services: the scheduler, the notification service, `Devices` (device names in answers).
- `@pva/language`: `parseRecurrence`, `parseDateTime`, `parseTimeOfDay`, `nextOccurrence`, `formatDtstart`,
  `describeRRule`, `speakMoment`, `speakTime`.

## What was left out

Left out because the preparation parts' first versions do not have it:

- **An alarm that always sounds under do not disturb**, the phone two minutes later, and escalation: do not disturb
  keeps every ring silent and there is no priority above `ring` (docs/NOTIFICATIONS.md); phones are out of scope.
- **Ringing elsewhere when its device is offline**, and a warning the evening before: two targets only
  (docs/NOTIFICATIONS.md "Not now").
- **Showing other rooms' alarms on screens** ("show other rooms' alarms", off in the research): no presentation is made
  for alarms in this version; the ringing card is the notification's.
- **A gentle ramp, sunrise on the screen, light fades, music alarms, node-local copies**: out of the plan's row (and
  the page has no ramp or brightness control).
- **"My alarm" as a person's**: alarms belong to devices; a person-owned alarm ringing on their default device is a
  later version.
- **Events** (`alarms.dismissed` for routines): no consumer in this version.

Left out because something is missing below: nothing. (The timers page names what the Presenter lacks.)

## Contract readings

- **The research's "cancel for good from another device asks for a repeat"**: core confirmations are off
  (docs/MODULES-PLAN.md §2 row 6); the module asks "only the next one, or all of them?" whenever the scope was not said,
  on every device, which is the plan's reading.
- **"Times are said"**: an alarm's time and repetition are told on every device (they are household data); only its
  name stays on its device.
