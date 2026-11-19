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
month at ten"). Anything that is not clear is a question, never a guess: "At what time?" for "tomorrow" and for a repeat
without a clock time ("every Monday"), "Say the day and the time." for something that could mean two moments.

- **Whose.** For the person asking (the asking device's default person; `scope: me`, the default when a person is
  known) or for the household (`scope: household`). A personal reminder has an owner and is delivered, read, listed,
  changed and cancelled only where `Privacy.mayReveal(owner, device)` allows it at that moment (see "Privacy").
- **When it is due**, a notification on **the device it was set on** with the host's `stop` and two actions, `done` and
  `snooze`, and the same two as a card on that screen. A reminder found late says so ("late: due …"). Do not disturb
  keeps the ring silent and the card listed, as for every notification. A reminder set from a turn without a device
  (none known) is sent everywhere, each device decided by the notification service as always.
- **Priority: `ring`, and why.** The person asked for this moment, so it rings until it is answered or 30 minutes have
  passed, instead of being a silent card nobody sees. The setting "How a reminder arrives" can make it a silent `normal`
  card (a day). Nothing is sent above `ring`.

## The state of a reminder

Each reminder is one row, and everything it will still do is written in that row:

1. **Its series**: the next time it is due (for a repeat, the rule with its start and zone, kept in the row). A one-off
   has one time; a repeat always has its next one; a series with an end (a count or an until) has none after its last.
2. **A delivery under way**, at most one: the time it was due, how many tries have been made, when to try again.
3. **A ring nobody has answered yet**, at most one: which time it was for, when it was delivered, and, if someone
   snoozed it, until when.
4. **Clean-up still owed**: a notification or card that should have gone but has not yet (see "When taking it down
   fails").
5. **The next moment anything happens for it** (the soonest of the four above). The module keeps **exactly one
   scheduled job per reminder**, for that moment, written in the same step as every change of the row.

When that job runs, and whenever a tool, a button or the daily clean-up touches the reminder, one function looks at the
row and does what is owed **now**, in this order: what is due moves from the series to "a delivery under way" and the
series moves on to its next time **in the same write** (so a failed delivery never costs the series); the delivery is
tried; on success it becomes the ring (an older ring of the same reminder is taken down); a snooze that has come
rings the same time again; a reminder with no series, no delivery under way and no ring is finished. Run twice, late,
or after the reminder changed, it does only what the row says is owed at that moment. A delivery that fails needs no
extra job: the reminder's one job is moved to the next try.

### The late rules

- **A one-off** is delivered however late it is found (after the server or the module was off), and says so.
- **A repeat**: an occurrence (or the end of a snooze) found more than **six hours** late is not delivered: the moment
  has passed, the series goes on with its next time after now. The rule is applied on every try, from the
  occurrence's own time, so a delivery that kept failing through an outage is not delivered days late. Occurrences
  missed during an outage are skipped, never planned in the past. The last occurrence of a series with an end follows
  the same rule.

### Tries

A delivery is tried at most **five** times: at once, then 30 s, 1, 2 and 4 minutes later. Each try is written before it is
made. After the fifth it is given up, the row records why, and a **Health issue** says that a reminder due at that time
could not be delivered (without its words). At the module's limit of 200 scheduled jobs that issue cannot be added (the
module raises it as a job that fails; "Missing below"); the row still records it, and the series goes on either way.

### At least once

Delivery is **at least once**. The order is: write the try, send the notification under a key made of the reminder and
the time it is for, write the ring. If the server fails between the send and the last write, the next try finds the
delivery still under way and sends again under the same key: if that notification is still open, nothing rings again
and only the ring is written; if it was stopped or answered in that moment, **it rings a second time**. So in that rare
case a reminder that was already stopped can ring once more; it can never ring zero times. (What would close this:
"Missing below".)

### Answering, and a ring nobody answers

- **Done and snooze** are the same four ways: the notification's buttons, the card's buttons, the typed actions and the
  tools. **Done on a one-off** finishes it (also before it is due). **Done on a repeat that is ringing** answers that ring;
  the series goes on. **Done on a repeat that is not ringing skips its next time** ("Done: I'll skip the one today at
  eight. The next one is tomorrow at eight."); the series goes on after it. Cancel ends a repeat for good.
- **Snooze** takes the notification and card down and rings the same time again after the setting's minutes (or a said
  duration). The same button pressed again (the service may run a handler twice) does not push it further.
- A ring nobody answers stays as "was due …" in the list. Its notification expires after 30 minutes (a `normal` card after
  a day). **A week after it was delivered**, the daily clean-up ends it: a one-off is then finished (lapsed); a repeat
  goes on.

### Changing a reminder while it rings

- **New words while it rings**: its notification and card are taken down and it is sent again at once with the new words,
  for the same time: **it rings again**. Snoozed, it keeps its snooze and rings with the new words then.
- **A new time** ends the ring (notification and card go) and any delivery under way; the reminder waits for its new
  time (or its new repeat).
- The confirmation is built from the reminder as written: a text change during a snooze says the snooze's time.

### When taking it down fails

Finishing, cancelling, answering, snoozing or changing a reminder takes its notification down and dismisses its card.
The tool or button tries that once, at once. If it fails, the reminder keeps **clean-up owed**, its job comes back a few
seconds later (5 s, then doubling) and tries again, at most five times; then it is given up with a Health issue (the
notification and card still end by themselves when they expire). The answer is true either way: "Cancelled: call mum."
only when the ring is gone; otherwise "Cancelled: call mum. Its ring is still being taken down; I'll keep trying." Saying
cancel or done again on such a reminder finishes the clean-up instead of answering that nothing matches.

### What it says about priority and expiry

Every reminder is `ring` unless the setting says otherwise; its notification expires after 30 minutes (a `normal` card
after a day). The card on the screen is transient (5 minutes; a newer transient presentation on that screen ends it).

## Tools

The model gets these (the words of a reminder are found by what was said, never by an id: one match is acted on, more
than one asks, none says so).

| Tool | Risk | What it does | Example |
|---|---|---|---|
| `reminders_set` `{ text, when, scope? }` | change | Sets a reminder: one moment or a repeat; answers with the moment in words. A personal one with nobody known asks whose and writes nothing; a text that holds a secret is refused (below). | "remind me to call mum at five" |
| `reminders_list` `{}` | read, speculative | The open reminders, soonest first by the moment each next speaks (a snoozed one by its snooze; one waiting for an answer first, as "was due …"): the household's and the asking person's own; at most five with "and N more"; says what the answer covers and when the read was cut. On a device that can show it, also a `list` (twelve at most), and `screen` says what the screen did. | "what are my reminders?" |
| `reminders_change` `{ which, text?, when? }` | change | New words, a new time (one moment or a repeat), or both, for the one reminder `which` finds (see "Changing a reminder while it rings"). | "move the dentist to Friday at ten" |
| `reminders_cancel` `{ which }` | change | Cancels one reminder (a repeating one for good); its ring and card go. It is marked and removed by the daily clean-up, not on the turn. | "cancel the bins reminder" |
| `reminders_done` `{ which? }` | change | Marks a reminder done: the one `which` finds, or the one ringing on this device (see "Answering"). | "I've called mum" |

**Which one.** When a read was cut (more than 204 open reminders, below), a match on part of the words is not taken as the
only one: the answer asks for the exact words and changes nothing. Exact words still work.

**Secrets.** A reminder must not hold a secret. Refused on set, change and `remind_in`, without repeating the words and
without storing anything: a credential word (password, passcode, PIN, code, door code, …; wachtwoord, pincode, deurcode,
…) followed by "is", ":" or "=" and a value, whatever the value looks like ("my password is violet-badger", "PIN: 1234");
a credential word followed by mostly digits ("door code 12 34"); a credential word anywhere with four digits in a row.
"Change my password" is an ordinary reminder. A false refusal of an innocent text ("the barcode is on the box") is the
price of that rule.

Typed actions (the intent agent runs them from their examples and phrases, without the model; the generated tools of
`remind_in` and `ringing_snooze` are also offered to the model, that of `ringing_done` is not, since `reminders_done` is):

| Action | Phrases (after the wake phrase) | What it does |
|---|---|---|
| `reminders.remind_in` `{ delay, text }` | "remind me in {delay} to {text}"; "herinner me over {delay} om {text}" | Sets a reminder a said duration from now (1 minute to a year), for the asking person (the household's when nobody is known), words as the one text slot at the end (at most eight words). The same confirmation and refusals as `reminders_set`. |
| `reminders.ringing_done` | "reminder done", "mark the reminder as done", "that reminder is done"; "herinnering klaar", "markeer de herinnering als klaar", "die herinnering is klaar" | The reminder that rang on this device is done. None waiting, or more than one: it says so (and "reminders_done" with words is how to say which). |
| `reminders.ringing_snooze` `{ for? }` | "snooze the reminder", "snooze the reminder for {for}"; "stel de herinnering uit", "stel de herinnering {for} uit" | Puts the reminder that rang here off for a said duration (1 minute to a day), else the setting's. |

While a reminder rings, the labels of its buttons ("Done", "Snooze"; "Klaar", "Uitstellen") are also accepted without the
wake phrase (the host's ringing window). A reminder's own words are free text, so no phrase has the text as a slot;
"done" on its own is not a phrase of this module, because another module's "done" could meet it.

**The list on a screen follows the reminders.** The module keeps the list it showed on each device; when a reminder on it
changes (cancelled, done, changed, delivered), the list is shown again from the rows as they are now, with privacy asked
again for that device, or dismissed when nothing on it is left. An empty or withheld-only answer on that device
dismisses it. It is transient (2 minutes; a newer transient presentation there ends it).

The briefing section `reminders` (a `BriefingSection` contribution) says what is coming **today** for the asking person:
the household's reminders and, only where `Privacy.mayReveal` allows it on the asking device now, their own. Personal
ones it may not tell are only counted (`withheld`), within the same day as the visible ones; on a public device the
personal content is never named. One sentence of at most 300 characters, built from whole items: three at most, else
two and "and N more" when three do not fit ("You have four reminders today: A at five, B at six and two more."). It
reads at most 204 open reminders; when that read was cut, every answer says so: "You have at least …; there may be
more.", or "I couldn't read all the reminders; there may be some today." when none of today's were among them.

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
| `state` | `open` (a series, a delivery under way or a ring is left), `done`, `cancelled`, `lapsed` |
| `dueAt` | the next time not yet handed to delivery; absent once a one-off was handed over or a series ended |
| `owed` | a delivery under way: `{ at, from, attempts, tryAt }` (`from`: what the late rule counts from) |
| `ring` | a delivered time not yet answered: `{ at, deliveredAt, snoozeUntil? }` |
| `stop` | clean-up owed: `{ notes, card, attempts, tryAt }` (the times whose notifications are to go, the card) |
| `nextAt` | the next moment anything happens for it; its one job is planned for it |
| `deviceId`, `assistantId`, `setBy` | where it is delivered, the assistant that heard it, whose turn set it |
| `rrule`, `dtstart`, `timeZone` | a repeat's rule, its start line and the household's zone |
| `handled` | the notification or card whose snooze was handled last |
| `dropped` | the last time given up, and why (late, failed, superseded, unanswered) |
| `endedAt` | when it finished |

`maxChars` 2,000 (the worst legal row is computed by `checkModule`; one list reads 12 rows). Indexes `[state, nextAt]`
(open reminders by their next moment: every list, every match, the briefing; finished ones with clean-up owed) and
`[state, endedAt]` (the clean-up, oldest first). Every read on a turn is bounded: at most 17 pages of 12 (204 rows)
per answer, with a yield between pages, and **says when there were more** ("I read the first 204 open reminders; there
are more", "I found none in the first 204 …"); a failed read is a failure ("I couldn't read the reminders."), never an
empty list.

**Jobs** (the module's own, at most 200 live in all): `reminder:<id>`, one per open reminder (payload `{ id }`, for the
row's next moment, runs however late, idempotent, five retries after a store failure); `problem:<id>`, a job that fails
at once to raise a Health issue (above); and `tidy`, daily at 04:00. A reminder waiting only for an answer has no job.
The clean-up looks at every open reminder, a page of 12 at a time with a yield between (at most 100 pages), and ends rings
unanswered for a week; then it removes finished rows older than the setting, oldest first, a page per transaction with
a yield between, skipping (and reading past) rows whose clean-up is still owed, until it reaches the cutoff. A job's
write carries the job as its actor; a button's write names the device it was pressed on (`{ kind: "ui", deviceId }`).
Notifications use the key `rem:<id>:<time>` (one open per reminder and time), cards `due:<id>`.

**Concurrency.** A tool, a job and a press change reminders one at a time (one semaphore in the module's shared part),
and every write also passes `expectRev` from the row it read. Two presses of done at once finish a reminder once; two
snoozes at once leave one snooze and one job.

**Removal.** A cancelled reminder is marked and removed after the kept days; the daily backups keep a removed row up to
14 days.

## Privacy

- Personal content is **an owner on the row**, and it is revealed only through `Privacy.mayReveal(owner, device)` for the
  asking device **at the moment of answering**, after the last read; nothing is cached or decided when a reminder is
  stored. The delivery passes the owner to the notification service and the card carries `sensitivity: personal`, so
  each device is decided again when it would ring or show: a shared device whose default person changed since the
  reminder was set gets neither. A list on a screen asks again for that device every time it is shown again.
- Reading and matching look at the household's reminders and the **asking person's own** only; another person's are not
  read, not counted, not matched. Without a known person only the household's are read, and the answer says so. The
  person's own that the asking device may not be told are counted anonymously ("2 personal reminders are not read out
  here") and cannot be changed or cancelled there, which is said.
- A confirmation is revealing too: where the privacy rule says no for the asking device (a public screen whose default
  person is the owner), the confirmation says "only for you" without the words, and that **this device does not ring
  with your personal reminders**: a personal reminder rings only on the device it was set on, and only where it may be
  revealed there.
- A personal reminder with nobody known asking asks whose and writes nothing; it is never stored as the household's.
- The tool results and the card name no one else's reminder; the answers of a button never contain the words; a Health
  issue never contains them.

## What it needs

- `requires`: nothing outside the process (no network, no program), so no `health`; `uses`: nothing.
- Services used: the notification service (`ctx.notify`), the Presenter (`ctx.present`), the scheduler, the store,
  and the core `Privacy`. Provides one contribution, the `reminders` `BriefingSection`.
- Off by default; with it off nothing changes for anyone, no job runs, and no phrase is in any set.

## What happens when the device it was set on is removed

The reminder's job runs as that device (its origin). Serve mode refuses a job whose device is no longer known before the
module runs: the job fails ("Not run: the device … is not known."), which shows in Health, and nothing rings anywhere.
The reminder must be set again from another device (and cancelled, or it stays in the list). It is never sent to other
devices instead, which would widen where a personal reminder goes.

## What was left out

- **Presence and event reminders** ("when I get home", "an hour before the dentist"), **"remind Sam"** (a reminder for
  another person), **nagging** (repeat until done) and **CalDAV**: not in the first version, as the plan's row says.
- **A phrase for a clock time or a repeat** ("remind me at five to call mum", "every Monday"): neither is a number, a
  duration, a fixed choice or text a phrase can read without guessing, so they go to the model (`reminders_set`). The
  phrase that exists is the duration one ("remind me in ten minutes to …").
- **Ticking a reminder off in the list** (a checklist with direct ticks): the list is bulleted; done is by notification,
  card, action or tool.
- **Quiet hours and a phone channel**: not in the notification service's first version (docs/NOTIFICATIONS.md "Not
  now"); a do-not-disturb ring is a silent card.
- **An ambient line** ("next reminder in 2 hours") and **published events**: not part of this row.
- **A history of done reminders**: finished rows are kept the setting's days only so the clean-up is not on a turn's
  path; no tool reads them.
- **More than ten rings at once**: the notification service allows ten open notifications per module; an eleventh
  delivery fails, is tried five times as above, and is then given up visibly (a Health issue). Not built: a queue that
  waits for room.
- **Deduplicating "set" called twice with the same words**: two calls make two reminders.

## Missing below

- **Delivery exactly once across a crash**: the notification service forgets a key as soon as its notification is
  resolved. If it remembered a key (module, key) for a while after the notification was resolved (say a day, the
  retention of resolved rows), a send under that key could answer "already delivered" and the second ring above
  would not happen.
- **A Health issue raised by a module's own code**: a module can only make one by a job that fails; at the job limit
  that job cannot be added. A call such as `ctx.issues.raise(id, …)` / `clear(id)` would remove the extra job.
- **A fault-injecting store in the test kit**: the tests wrap the module's handles themselves.
- **SQLite latency for this package**: the latency test runs on the kit's in-memory store (no store injection in
  `startTestModule`, no SQLite dependency here).
