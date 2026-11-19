# Reminders (`reminders`)

Reminders at a time or repeating, for the household or for one person.

- Package: `packages/module-reminders`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 10 (wave B)
- Research: [docs/research/modules/reminders.md](../research/modules/reminders.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

A reminder is words and a moment, set by voice: "remind me to call mum in ten minutes", "remind me every Monday at seven
to put the bins out", "remind the house at six to tidy up". It is **time only**: one moment, or a repeat (the
`@pva/language` recurrence phrases: "every weekday at 7 am", "every second Tuesday at nine", "on the first of every
month at ten"). Anything that is not clear is a question, never a guess ("At what time?", "Say the day and the time.").

- **Whose.** For the person asking (the asking device's default person; `scope: me`, the default when a person is
  known) or for the household (`scope: household`). A personal reminder has an owner and is delivered, read, listed,
  changed and cancelled only where `Privacy.mayReveal(owner, device)` allows it at that moment (see "Privacy").
- **When it is due**, a notification on **the device it was set on** (`target: origin`; a device that is gone, or none
  known, means everywhere, never nowhere) with the host's `stop` and two actions, `done` and `snooze`; and the same two
  as a card on that screen. A due reminder found late says so ("late: due …"). Do not disturb keeps the ring silent and
  the card listed, as for every notification.
- **Priority: `ring`, and why.** The person asked for this moment, so it rings until it is answered or 30 minutes have
  passed, instead of being a silent card nobody sees. The setting "How a reminder arrives" can make it a silent `normal`
  card (a day) for a household that finds a ring too much. Nothing is sent above `ring`.
- **Repeating.** The rule is kept in the reminder's own row (`RRULE`, the `DTSTART` line and the zone, the household's),
  with **one job for the next occurrence**, planned again by its handler, always after now: an occurrence missed during
  an outage or a restart is skipped, never planned in the past. Found late, an occurrence is still delivered up to six
  hours late (and says so); past that the moment has passed, it is not delivered, and the series goes on. A delivery that
  fails on a repeat is tried again 30 seconds later by a job of its own, so a failure never costs the series. A series
  with an end (a count or an until) delivers its last occurrence and then lapses.
- **Done and snooze** are the same four ways: the notification's buttons, the card's buttons, the typed actions and the
  tools. Done on a one-off finishes it; on a repeating one it is done for this time only (the series goes on: cancel
  ends it). Snooze puts the reminder off by the setting's minutes (or a said duration) with a job of its own.

### What it says about priority and expiry

Every reminder is `ring` unless the setting says otherwise; its notification expires after 30 minutes (a `normal` card
after a day) and is resolved by done, snooze, cancel or a change. A one-off that was delivered and never answered
stays in the list as "was due …" and lapses seven days later.

## Tools

The model gets these (the words of a reminder are found by what was said, never by an id: one match is acted on, more
than one asks, none says so).

| Tool | Risk | What it does | Example |
|---|---|---|---|
| `reminders_set` `{ text, when, scope? }` | change | Sets a reminder: one moment or a repeat; answers with the moment in words. A personal one with nobody known asks whose and writes nothing; a text with a code or password next to digits is refused. | "remind me to call mum at five" |
| `reminders_list` `{}` | read, speculative | The open reminders, soonest first: the household's and the asking person's own; at most five with "and N more"; says what the answer covers and when the read was cut. On a device that can show it, also a `list` presentation (twelve at most). | "what are my reminders?" |
| `reminders_change` `{ which, text?, when? }` | change | New words, a new time (one moment or a repeat), or both, for the one reminder `which` finds. A new time replaces its job in the same transaction as the row, and takes down a ring or card that was up. | "move the dentist to Friday at ten" |
| `reminders_cancel` `{ which }` | change | Cancels one reminder (a repeating one for good). It is marked and removed by the daily clean-up, not on the turn. | "cancel the bins reminder" |
| `reminders_done` `{ which? }` | change | Marks a reminder done: the one `which` finds, or the one ringing or waiting on this device. | "I've called mum" |

Typed actions (the intent agent runs them from their examples and phrases, without the model; the generated tools of
`remind_in` and `ringing_snooze` are also offered to the model, that of `ringing_done` is not, since `reminders_done` is):

| Action | Phrases (after the wake phrase) | What it does |
|---|---|---|
| `reminders.remind_in` `{ delay, text }` | "remind me in {delay} to {text}"; "herinner me over {delay} om {text}" | Sets a reminder a said duration from now (1 minute to a year), for the asking person (the household's when nobody is known), words as the one text slot at the end (at most eight words). The same confirmation and refusals as `reminders_set`. |
| `reminders.ringing_done` | "reminder done", "mark the reminder as done", "that reminder is done"; "herinnering klaar", "markeer de herinnering als klaar", "die herinnering is klaar" | The reminder that rang on this device is done. None waiting, or more than one: it says so (and "reminders_done" with words is how to say which). |
| `reminders.ringing_snooze` `{ for? }` | "snooze the reminder", "snooze the reminder for {for}"; "stel de herinnering uit", "stel de herinnering {for} uit" | Puts the reminder that rang here off for a said duration (1 minute to a day), else the setting's. |

While a reminder rings, the labels of its buttons ("Done", "Snooze"; "Klaar", "Uitstellen") are also accepted without the
wake phrase (the host's ringing window). A reminder's own words are free text, so no phrase has the text as a slot;
"done" on its own is not a phrase of this module (it is a button's label while ringing), because another module's
"done" could meet it.

The briefing section `reminders` (a `BriefingSection` contribution) says what is coming **today** for the asking person:
the household's reminders and, only where `Privacy.mayReveal` allows it on the asking device now, their own. Personal
ones it may not tell are only counted (`withheld`); on a public device the personal content is never named. It reads
the store within the briefing's budget (a bounded scan of at most 204 open reminders) and says when there may be more.

## Settings

| Setting | Default | |
|---|---|---|
| Snooze for | 10 minutes (1–240) | How long a snooze puts a reminder off when no duration is said. |
| How a reminder arrives | rings until answered | Or a silent card. |
| Keep finished reminders | 7 days (1–90) | Days a finished, cancelled or lapsed reminder is kept before the daily clean-up removes it. |

All three are shared (no assistant owns its own value). The household's language and time zone come from the Home
section (`HOME_LANGUAGE`, `HOME_TIME_ZONE`, empty meaning this machine's).

## What it stores

One collection, `reminders` (scope household; rows carry their owner), `storage.version` 1.

| Field | |
|---|---|
| `text` | one line, at most 160 characters |
| `whose`, `owner` | `household`, or `personal` with the owner's Members id |
| `state` | `open` (waiting, or delivered and not yet answered), `done`, `cancelled`, `lapsed` |
| `dueAt` | the next moment (epoch ms; a repeat: its next occurrence) |
| `deviceId`, `assistantId`, `setBy` | where it is delivered, the assistant that heard it, whose turn set it |
| `rrule`, `dtstart`, `timeZone` | a repeat's rule, its start line and the household's zone |
| `notifiedFor` | a one-off's moment that was delivered |
| `snoozeAt` | a snooze, or the retry of a failed delivery on a repeat (the time its job is for) |
| `handled` | the notification or card whose snooze was handled last (pressing it again does not push it further) |
| `endedAt` | when it finished |

`maxChars` 2,000 (the worst legal row is computed by `checkModule`; one list reads 12 rows). Indexes `[state, dueAt]`
(open reminders soonest first: every list, every match, the briefing) and `[state, endedAt]` (the clean-up, oldest
first). Every read is bounded: at most 17 pages of 12 (204 rows) per answer, with a yield between pages, and **says when
there were more** ("I read the first 204 open reminders; there are more", "I found none in the first 204 …"); a failed
read is a failure ("I couldn't read the reminders."), never an empty list.

**Jobs** (the module's own, at most 200 live in all): `due:<id>` (one per open reminder, payload `{ id, at }`, runs
however late, idempotent, five retries), `snooze:<id>` (a snooze or the retry of a failed repeat delivery), and `tidy`,
daily at 04:00, which lapses what was delivered a week ago and never answered and removes finished rows older than the
setting, oldest first in batches of 12, each its own transaction, with a yield between. A job's write carries the job as
its actor. Every handler checks the row again before it delivers or writes: a reminder changed, cancelled or finished
while a job waited, or while it runs, is not delivered (a call-off waits for the running job, then takes down what it
delivered). Notifications use the key `rem:<id>` (one open per reminder), cards `due:<id>`.

**Concurrency.** A tool, a job and a press change reminders one at a time (one semaphore in the module's shared part),
and every update also passes `expectRev` from the row it read. Two presses of done at once finish a reminder once; two
snoozes at once leave one snooze job.

**Removal.** A cancelled reminder is marked and removed after the kept days; the daily backups keep a removed row up to
14 days.

## Privacy

- Personal content is **an owner on the row**, and it is revealed only through `Privacy.mayReveal(owner, device)` for the
  asking device **at the moment of answering**, after the last read; nothing is cached or decided when a reminder is
  stored. The delivery itself passes the owner to the notification service and the card carries `sensitivity:
  personal`, so each device is decided again when it would ring or show (a device that may not reveal it gets neither).
- Reading and matching look at the household's reminders and the **asking person's own** only; another person's are not
  read, not counted, not matched. Without a known person only the household's are read, and the answer says so ("the
  household's reminders only; I can't tell who is asking"). The person's own that the asking device may not be told are
  counted anonymously ("2 personal reminders are not read out here") and cannot be changed or cancelled there, which is
  said.
- A confirmation is revealing too: where the privacy rule says no for the asking device (a public screen whose default
  person is the owner), the confirmation says "only for you" without the words.
- A personal reminder with nobody known asking asks whose and writes nothing; it is never stored as the household's.
- The tool results and the card name no one else's reminder; the answers of a button never contain the words.

## What it needs

- `requires`: nothing outside the process (no network, no program), so no `health`; `uses`: nothing.
- Services used: the notification service (`ctx.notify`), the Presenter (`ctx.present`), the scheduler, the store,
  and the core `Privacy`. Provides one contribution, the `reminders` `BriefingSection`.
- Off by default; with it off nothing changes for anyone, no job exists, and no phrase is in any set.

## What was left out

- **Presence and event reminders** ("when I get home", "an hour before the dentist"), **"remind Sam"** (a reminder for
  another person), **nagging** (repeat until done) and **CalDAV**: not in the first version, as the plan's row says.
- **A phrase for a clock time or a repeat** ("remind me at five to call mum", "every Monday"): a clock time must be
  read with the household's day-part guess ("five" is 17:00), and a repeat is a phrase of its own with its own grammar;
  neither is a number, a duration, a fixed choice or text a phrase can read without guessing, so they go to the model
  (`reminders_set`). The phrase that exists is the duration one ("remind me in ten minutes to …"), where the words are the
  one text slot at the end.
- **Ticking a reminder off in the list** (a checklist with direct ticks): the list is bulleted, because a tick would have
  to resolve a reminder by id under the privacy rule on a page; done is by notification, card, action or tool.
- **Quiet hours and a phone channel** (the research's held-until-morning and phone delivery): not in the notification
  service's first version (docs/NOTIFICATIONS.md "Not now"); a do-not-disturb ring is a silent card.
- **An ambient line** ("next reminder in 2 hours") and **published events**: not part of this row.
- **A history of done reminders** ("what did I do last week"): finished rows are kept the setting's days only so the
  clean-up is not on a turn's path; no tool reads them.
- **More than ten rings at once**: the notification service allows ten open notifications per module; the eleventh send
  fails, a one-off is retried five times with back-off and then fails visibly (a failed job, a Health issue), a repeat
  is retried after 30 seconds by its snooze job with the same limits. Not built: a queue that waits for room.
- **Deduplicating "set" called twice with the same words**: two calls make two reminders.
