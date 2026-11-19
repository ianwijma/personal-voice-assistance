# Bin day (`bin-day`)

Which bin goes out next, from the collection calendar's ICS link.

- Package: `packages/module-local-info`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 18 (wave A)
- Research: [docs/research/modules/local-info.md](../research/modules/local-info.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch"); the reminder was added afterwards by the follow-up pull request.

## What it does

Tells the household which bin goes out next, from the link of the municipality's (or collector's) waste collection
calendar in ICS format. The module fetches the calendar once a night (03:00) and once soon after it starts, keeps a copy
of the **next 60 collections**, and answers from that copy: "which bin goes out tomorrow?" costs one store read, not a
request. It reads all-day and timed events, repeating events (`RRULE`, `EXDATE`), cancelled events, and moved
or cancelled instances of a repeat (`RECURRENCE-ID`, with `STATUS:CANCELLED`): a moved collection is announced on its new
day. It works out which bin a title is (GFT/green, paper, plastic/PMD, general waste, glass, in Dutch and English; anything
else is kept as "another bin" with the calendar's own words). The owner may name bins in the settings ("a title
containing *kerstbomen* is *Christmas tree*"). The module is **off by default**.

**Reading the calendar off the main thread.** Parsing and expanding the calendar is one task
(`src/readCalendar.task.ts`, the only file that imports `ical.js`) run through `offThread` with a time limit of 4 s, a
heap of 96 MB and an answer of at most 64 KiB. A repeating series is moved to the window by whole periods of its own
interval (a weekly round that began in 1990 costs no more than one that begins today); a series with `COUNT` is walked
from its start. The whole calendar has a work bound (at most 2,000 events and 20,000 steps of expansion). A calendar
over a limit, or one the reader does not finish in time, is a **failed refresh with its reason**, never an empty or a
shortened list. The task's input is the one flat record the helper takes (the text, today, the zone, and the owner's
names as a JSON text that the task checks); each of the helper's reasons is a failed refresh: `timeout` is "too slow",
`memory` and `too-large` "too large", `failed` and `exited` "unreadable", `busy` (more than 32 calls waiting) "busy",
which is not remembered (the next refresh or question simply tries again), and `input`, `nested` and `load` "internal"
(a bug of the module, never "not a calendar"); a calendar with a repeat every second, minute or hour (no collection calendar has one) has that event
left out as unreadable. Measured on the development machine (`binDay.test.ts` and `readCalendar.test.ts` print it): a
refresh of a 254 KiB calendar of 1,526 repeating events holds the main thread 2.7 to 2.9 ms at most; the reviewer's
hostile calendars (a 163-byte rule repeating every second, 1,600 daily series of 400) hold it 1.5 and 1.6 ms and end as
typed answers (unreadable, too large), and a rule `ical.js` never finishes is stopped at its limit with the main thread
held 2.1 ms at most. Before this, the parse ran on the main thread: the reviewer measured 4.6 s for the 1,600 series, and
the second-by-second rule did not end.

**Never a false "none".** An event the reader cannot read (no date, no title, a rule it does not expand) is counted:
the copy is marked as partly unreadable and every answer from it says "Part of the calendar couldn't be read, so this may
not be complete." A calendar none of whose events can be read is a failed refresh. When the copy holds only the next 60
of more collections, a bin not among them is "not in the next 60 collections", never "not coming".

It contributes one briefing section (`bin-day`): "Bin day tomorrow: the green bin (GFT)." in a morning or on-request
briefing for today and tomorrow, tomorrow only in an evening one, from the stored copy only (a briefing never waits for the
network), in the briefing's language and at its moment. With no collection today or tomorrow it says nothing, but only
from a copy that is less than two days old and complete through tomorrow; otherwise the section is unavailable (the
briefing words that), and a sentence from a copy older than two days says how old it is ("…, from my copy of the calendar
from 6 days ago."). With no copy at all the section is unavailable.

**The reminder the evening before.** With "Remind me the evening before" set to a time (every half hour from 16:00 to 22:00;
the default is off), the module sends a silent card to every screen at that time: "Bin day tomorrow. The paper bin goes
out tomorrow." (several bins: "The paper bin and the green bin (GFT) go out tomorrow."; Dutch: "Morgen is het afvaldag. De
papiercontainer gaat morgen aan de weg."). It is a **job of the module's own** (`remind-daily`, a daily job at that time in
the household's zone): the notification service never sends later, so the job looks at the stored copy and sends a
`normal` notification to `everywhere` (a job has no device of its own) at that moment. Exactly what it does:

- **Delivered at least once, and once when nothing fails.** The job sends under the key `bin-day:<date>` and then writes a
  receipt (one row, `reminded`: the collection, what the calendar said of it, and what became of the card). With the
  receipt written, running the job again for the same evening (a retry, a restart, the owner moving the time later, the
  person having stopped the card) sends nothing more. If the run fails **between the delivery and the receipt**, the retry
  finds no receipt: if the card with that key is still open, it only writes the receipt (the open card is not delivered
  again); if the card was dismissed meanwhile, it is delivered again, so after such a failure a dismissed reminder can
  appear a second time, and none is ever lost. The next collection is reminded the next time it is the evening before. An
  evening before a day with no collection says nothing.
- **Taken away when it stops being true.** After every refresh that committed a calendar, at start and in each daily run,
  the receipt is compared with the calendar as it is now: a reminder whose collection moved, was cancelled, has other bins
  or is past is resolved with `ctx.notify.resolve({ key })` (outcome `calendar-changed`) and the receipt says `withdrawn`.
  A day the copy cannot speak for (nothing there, and not complete through it) is not taken for cancelled. A withdrawal
  that fails stays `owed` in the receipt and is tried again by the next refresh, start or daily run. A collection that moved
  is reminded on its own evening.
- **Decided at the moment of sending.** Immediately before the notification is sent the job reads again the live settings
  (reminder off, another time, another link or names end the run), the clock and the zone (still the same evening, still
  inside the late rule, the copy still fresh enough) and whether its own job row is still the running one (a job called off
  or replaced while it ran is not interrupted: the link and names are in the job's payload, so a change replaces it). The
  expiry is computed from that instant.
- **Surviving an outage, within the late rule.** The job's late rule is three hours (`late: { withinMs }`): found up to
  three hours after its time it still runs and sends; found later, it is missed and nothing is sent. It is also only sent
  **the same evening**: found after midnight (a reminder at 22:00, found at 00:30), "tomorrow" would be another day, so
  nothing is sent. A restart does not replace the live job (that would lose an occurrence due while it was down).
- **Not from a copy too old to trust.** With no copy, or one older than two days, the job refreshes it first (up to 8 s,
  as the nightly refresh does). If that fails it **sends nothing** and does not fail: a reminder that cannot say what is
  known is worse than none, the failed nightly refresh is already a Health issue, and the next evening tries again. Nothing
  is sent that says "no bin": with no collection tomorrow in a copy it trusts, the job is silent. A copy that may be
  incomplete (events it could not read, or cut off before tomorrow) still reminds of the bins it knows and adds "The
  calendar may not be complete."
- **True until midnight.** The card ends when the next local date begins in the household's zone (`expiresInMs`, found with
  the zone's own dates, not by adding the remaining wall-clock hours: a zone whose offset changes before midnight, such as
  America/Nuuk on 28 March or America/Santiago on 4 April, has a day that is not 24 hours long); after that "tomorrow" is today. The names of the bins
  are the calendar's outside text: one line each, at most eight and "and N more", the whole text at most 200 characters.
- **Privacy.** The reminder is the household's (a collection calendar has no owner): every device that can show a card gets
  it, whatever its privacy (a device with no display is not given it; nothing rings, it is `normal`). The notification
  has no buttons, so there is no press handler.

**Privacy.** The module stores nothing personal: a collection calendar is the household's, so it has no owner, and every
kind of device (private, shared, public) is told the same. The calendar's titles are outside text: they reach the model only
as bin names, cut to one line of at most 60 characters, at most eight in an answer ("…and 52 more"), and the result says
they are data, not instructions. The calendar link is a plain text setting, not a secret (some collectors put an address
code in it): it is never put in a result, an error, a log line, a Health issue or a stored row (the copy keeps a
16-character hash of it to know which link it came from).

## Tools

| Tool / action | Risk | Parameters | Says (example) |
|---|---|---|---|
| `bin_next` (tool, `speculative`) | read | `type?`: a kind of bin in the person's words | "Tomorrow: the green bin (GFT). After that, Friday: the paper bin." |
| `bin-day.next` (typed action, not also a tool) | read | `type?`: one of GFT, paper, plastic (PMD), general waste, glass | "Morgen: de groene container (GFT). Daarna, overmorgen: de papiercontainer." |

Example phrases (the action's `examples`, so they run without the language model): "which bin goes out tomorrow", "when is
the paper collected", "what bin do I put out", "welke container moet er buiten", "wanneer wordt het gft opgehaald", "welke
bak moet er morgen aan de weg".

Behaviour: the answer is the first collection day and the one after it (one sentence each), or, with a kind, that kind's
next day. A kind the calendar does not have, an unknown name, no link, an unreachable, unreadable, too large or too slow
calendar each get their own sentence (English and Dutch) that says what the person can do. If the copy is older than two
days (or there is none) the question refreshes it first, within 3.5 s for fetching and reading together; if that fails the
last copy answers and says how old it is ("This is from my copy of the calendar from 2 days ago; I couldn't refresh it."),
and with no copy the person is told why. After a failed refresh a question does not try again for five minutes. Dates
are found in the household's time zone when the question is asked: a timed collection is kept as its instant, so a change
of Home › Time zone changes the answer at once, without a refresh.

The settings page has a **Test** button that fetches and reads the saved link (in a worker, as a refresh does) and says how
many collections it found, whether there are more than the module keeps, and how many events it could not read; it
writes nothing.

## Settings

| Field | Kind | What |
|---|---|---|
| Calendar link (ICS) | text, at most 500 characters | `https://`, `http://` or `webcal://`; no user name or password in it; checked as typed (the answer never quotes the link) |
| Bin names | records (at most 12): *words in the calendar title*, *call it* | the owner's own names, read before the built-in words |
| Remind me the evening before | choice: Don't remind me (default), or 16:00 to 22:00 in steps of half an hour | the reminder above; needs the calendar link |
| Check the calendar link | button | the **Test** button above |

Health (`bin-day.no-calendar`, info: no link yet; `bin-day.bad-link`, warning: not a web address) looks at the settings
only: no network, no store. A failed nightly refresh shows as a Health issue through the scheduler (below).

## What it stores

Two collections in the household scope, data version 1.

| Collection | `maxChars` | Indexes | What |
|---|---|---|---|
| `copy` | 13,000 | none | **one row**, id `copy`: the link and names it was read from (a 16-character hash), when it was read, whether the calendar had more collections than were kept (`cut`), how many events could not be read, and the next 60 collections (`entries`): a calendar date (`d`, 20261119) for an all-day collection or an instant (`t`, epoch ms) for a timed one, the kind (gft, paper, plastic, rest, glass, other) and, for a name the owner gave or a title the module does not know, a `label` (one line, at most 60 characters). It is read by id. |
| `reminded` | 300 | none | **one row**, id `last`: the receipt of the reminder last sent: the collection (`day`, 20261119), a 16-character hash of what the calendar said of it (`sig`) and its `state` (`sent`, `owed`, `withdrawn`). It is written by the daily job (as the job: its actor is the job's) after the delivery. |

The copy is replaced **in one write, only after a refresh produced a complete, valid list**: there is never a half-written
copy, a failed refresh (unreachable, unreadable, too large, too slow) leaves the last good copy exactly as it was, and a
first fetch that fails writes nothing. A change of link or names makes the copy not the copy of the new link at once (it
is judged by its hash), and the next refresh replaces it. Right before it writes, in the same transaction, a refresh
checks the module's link and names are still the ones it read, and never replaces a newer copy of the same link.

**Scheduled.** `remind-daily`: only while the reminder is set, cron `M H * * *` for the owner's time in the household's zone,
handler `remind` (idempotent, up to 30 s), late rule `{ withinMs: 3 hours }`, payload `{ source }` (the hash of the link
and names), no origin; it is replaced when the time, the link or the names change and called off when the setting goes back to off (a restart keeps the live one). `refresh-daily`: a system job, cron `0 3 * * *`, handler `refresh` (idempotent, up to 30 s, the scheduler's
default retries). `refresh-start`: once, two seconds after the module starts with a link, only when the copy is older than six
hours. A refresh fetches through `safeFetch` (accepts calendar types, at most 256 KiB, 8 s), reads the calendar off the
main thread (above), and writes the copy as the job (`{ kind: "job", jobId }`); a refresh on a question writes as that
turn. A refresh that fails fails the run with its reason ("The calendar refresh failed: unreachable"): it is retried,
then the job keeps its error and the scheduler shows the Health issue until a refresh works; the old copy stays and keeps
answering.

## What it needs

`requires: internet` (the calendar is fetched from the link) and a `health`. It uses no other module's service; the reminder
sends through the host's notification service (`ctx.notify.send`, target `everywhere`). It
**provides** a `BriefingSections` contribution (`bin-day`), which only the briefing module consumes. Outside service: the
owner's calendar link (any public address; an address on the home network is refused by `safeFetch`). The User-Agent is the
product token only, plus the owner's contact (Home › API contact) when the owner set one. `offThread` (`@pva/core`) and
`ical.js` (in the worker only).

## What was left out

Not now: a spoken announcement of the reminder on a device, the ambient fact ("bin tomorrow: paper") on screens, a reminder
a person can snooze (the card has no buttons), a reminder on the day of the collection or at another distance than the
evening before, and a corrected reminder after a calendar change (the old card is taken away; a moved collection is reminded
on its own evening).

Left out for the first version, as the plan's row says: reading the schedule from a Home Assistant sensor
(`waste_collection_schedule`), a manual "every other Tuesday" rule, and the municipality scrapers. A moved instance with
`RANGE=THISANDFUTURE` (it moves every later instance too) is not expanded: that series is counted as unreadable. The Test
button reads dates in this machine's time zone (a button gets the module's settings only, not Home). Times are read in
the household's time zone (Home › Time zone, else this machine's).

## Review

Round 1 of the review of the reminder (pull request #128) changed: the delivery guarantee (at least once, said above), the
withdrawal of a reminder that stopped being true, the decision at the moment of sending, the zone's own midnight and the
job as the actor of the receipt writes.

**Missing below** (what would make the reminder exactly once, and was not built here): the notification service remembering a
key for a while after its notification was resolved, or an atomic delivery-with-receipt. Today a notification key
deduplicates only an open notification, so a dismissed card can be delivered again after a failure between the delivery and
the receipt.
