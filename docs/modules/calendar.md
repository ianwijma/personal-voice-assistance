# Calendar (`calendar`)

Calendars from ICS links: what is on, what is next, finding an event and free time, answered from a cache that a
scheduled job keeps. Read-only: this version reads ICS addresses and nothing else (CalDAV, and with it adding events,
is later).

- Package: `packages/module-calendar`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 12 (wave A, ICS only)
- Research: [docs/research/modules/calendar.md](../research/modules/calendar.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

The owner lists calendars on the module's page: a name ("Family", "School", "Sam's work"), an ICS address (or one of
three private links kept in the key vault), and whose calendar it is (the household's, or a member's). A job reads
every calendar on a schedule (every hour by default) through `safeFetch`, and reads the file **off the main thread**
(`offThread`, a fresh worker per calendar with a real time limit): `ical.js` parses it and expands its repeating events
(RRULE, RDATE also as periods, EXDATE, moved and cancelled instances also by a range, the file's VTIMEZONEs, and IANA
zones a TZID names without one). It keeps the occurrences from yesterday to 62 days ahead in the household store.
Every tool and action answers from that store, so nothing on a turn waits for the network.

**Nothing is guessed.** An event whose zone cannot be resolved, whose times cannot be read, that uses a rule the module
does not apply (`EXRULE`) or that the library cannot expand is left out and counted, and the calendar is marked as read
only in part: every answer then says so ("Family could be read only in part: 1 events could not be read."). A file
that is not a well-formed calendar (cut off, components not closed) or that is over a limit is a failed refresh: the
last good read stays and answers say since when ("Family could not be refreshed since today at ten o'clock; this is
what I had then.").

In particular, before the library sees an event:

- **Every schedule value is checked** for its exact syntax and real ranges (`DTSTART`, `DTEND`, `RECURRENCE-ID`, each
  `EXDATE` and `RDATE` value, a rule's `UNTIL`; month, the day of that month and year, hour 0 to 23, minute and second 0
  to 59, a leap second read as 59). A bad start, end or recurrence id leaves the event out; a bad exclusion, extra date
  or `UNTIL` leaves the series out (guessing which instance was meant would be worse). `DUE` belongs to tasks, which
  are not read.
- **A `VTIMEZONE` counts only when it can be used**: at least one observance with a start and both offsets. Otherwise
  its name is tried as an IANA zone, and failing that the event is left out.
- **A rule's implicit day is made explicit**: a `YEARLY` rule without `BYMONTHDAY`, `BYDAY`, `BYYEARDAY` or `BYWEEKNO`
  gets its start's month (unless `BYMONTH` is given) and day, a `MONTHLY` one without `BYMONTHDAY` or `BYDAY` its
  start's day, so a day a month or year does not have (29 February, the 31st) is skipped, not moved to the next day.
- **An override that cannot be read still takes out the instance it replaces** (counted once); one whose recurrence id
  cannot be read, or that changes a range, takes out its whole series.

A recurring local time that does not exist on the day the clocks go forward (a daily 02:30 in Amsterdam on the last
Sunday of March) is read an hour later that day and counts toward `COUNT`, as Google, Apple and Outlook show it.

**A refresh is published whole.** Each good read is written as a new generation of the calendar's rows and then, in
one transaction, made the calendar's current one, with what it was read from (a fingerprint of the address, the owner,
the household's zone). Answers read only rows of each calendar's current generation, and only while that provenance
still equals the settings; a calendar whose address or owner changed is "not read yet" until it is read again. Older
generations are removed afterwards, a page per transaction.

It contributes the calendar's section to the briefing (`BriefingSections`). Nothing of the calendars goes into the
prompt: there is no ambient line (see "What was left out").

### Privacy

A household calendar's events are shown on every device. A member's calendar is personal: each of its events carries
the member as its owner, and is revealed only where `Privacy.mayReveal(owner, turn)` says yes **at the moment of
answering**: who may hear what is looked up after the answer's last read, for the asking turn, and never held across a
wait (a member removed while an answer reads is neither revealed nor reduced).

| device | a member's events |
|---|---|
| `private` | in full |
| `shared`, whose default person is the owner | in full |
| `shared`, another default person or none | **reduced** when the event blocks time: "Robin is busy from two o'clock to three o'clock" (whose and when; no title, place or calendar name). An all-day event, or one marked as not blocking time (`TRANSP:TRANSPARENT`), is only counted |
| `public`, or a device the server does not know | withheld, only counted ("2 personal events are not read out here.") |

This reduction is the one docs/MODULES-PLAN.md §2 row 8 describes ("Ian: busy 12:30 to 13:30"). Searching by words
(`calendar_find`, `calendar_next` with words, `when_is`) never looks at an event that is not shown in full: a match
would tell what it is called; where some calendar cannot be searched it says "Personal calendars are not searched
here." without a count. "Me" with nobody known asking (a public screen, a shared device without a default person) is a
question ("Whose calendar?"), and on a public screen whose default person is known, "my calendar" is refused. A
calendar whose owner names nobody in Members (or two people) is not read at all. Calendars that cannot be shown on the
device are not named in what an answer says about coverage either ("1 personal calendars has not been read yet").

The briefing section is the asking person's (the contract in `packages/module-contracts/src/briefing.ts`): the
household's events and the asking person's own, when they may be revealed there; the asking person's events that may
not (a public screen whose default person is known) are only counted. Other members' events are not gathered at all.

Event titles and places come from outside: they are cut to one line (120 and 80 characters), descriptions, alarms and
attachments are never read, and every result that holds them says they are calendar text, not instructions. Text that
holds a private link the calendar was read from, or a secret part of it, plainly, escaped, percent-encoded or in
other case, is dropped before anything is cut, kept or hashed; an event whose UID holds it is left out; an `ETag`
that holds it is not kept (the next refresh then asks unconditionally; `Last-Modified` is not read). The secret parts
are the link with and without its scheme, its path and query, its file name and that name's stem
(`long-secret-123456789` of `…/long-secret-123456789.ics`) and each query value from 8 characters, and each other
path component from 12 (so a word of a provider's path such as `calendar` is not one).

## Tools

All plain reads of the store: `speculative`, risk `read`, no network. `who` is "me", "household", a member's name, or
absent for everyone's. A day is a phrase ("today", "Friday", "vrijdag", "next Friday" is asked back as a question,
never guessed) or `YYYY-MM-DD`.

| Tool | Parameters | Answers | Example |
|---|---|---|---|
| `calendar_agenda` | `day?`, `days?` (1–14), `who?` | the day's events (at most 12, then "more"), whose busy times where reduced (at most 6, then "moreBusy") | "What's on today?", "What do we have this weekend?" |
| `calendar_next` | `match?` (words of the title or place), `who?` | the next event, or the next one with those words that has not ended | "What's next?", "When is the dentist?" |
| `calendar_find` | `text`, `who?` | up to 10 events with those words, from now to the end of the cache, and how many more | "When is swimming this month?" |
| `calendar_free` | `day?`, `from?`, `to?` (`HH:MM`, default 08:00–21:00), `minMinutes?` (default 30), `who?` | one sentence of free times; the household's events count as busy for "me" too; all-day and transparent events do not | "Am I free Friday afternoon?" |

An event is one occurrence of one event: identified by its calendar, its UID and its recurrence id, never by its text
(two events of one title and time are two). An event of several days is given with its real start and end on every
day it covers (`from: "today at eleven o'clock", until: "Friday at two o'clock"`; an all-day one with its first and
last day), and is listed once in an agenda of several days. One that goes on after the last day kept says so
(`continuesAfter`).

**What every answer says beside its events** (one function, `coverage` in `src/read.ts`, for every tool, action and
the briefing): a calendar that could not be refreshed and since when (`stale`), one read only in part and how many
events could not be read (`incomplete`), one that has not been read (`notRead`), a scan cut short (`cut`), personal
events withheld (`withheld`, a count, never a title), and an event going on after the last day kept (`continues`).
A total it says is one it counted: "and 196 more".

Typed actions (for the intent path; not offered to the model, which has the tools), each answering `{ say }` with no
model:

| Action | Example phrases | Says |
|---|---|---|
| `calendar.today` | "what's on today", "wat staat er vandaag" | "Today: Standup at half past nine, Lunch with Marloes at half past twelve and Swimming lesson at four o'clock." |
| `calendar.tomorrow` | "what's on tomorrow", "wat staat er morgen" | "Tomorrow: Bins out, all day." |
| `calendar.next_event` | "what's next on the calendar", "wat staat er hierna in de agenda" | "Next: Lunch with Marloes, today at half past twelve." |
| `calendar.my_next` | "when is my next appointment", "wat is mijn volgende afspraak" | the asking person's own next event ("Next: Gym, today at seven o'clock."); with nobody known asking, "Whose calendar?" |
| `calendar.when_is` | "when is the dentist", "wanneer is de tandarts" | "Next: Dentist, tomorrow at half past two." |

Every sentence is in English and Dutch (by `HOME_LANGUAGE`); times, dates, numbers and lists by `@pva/language`. With
no calendars set up every tool and action says "No calendars are set up yet; …"; before the first good read of the
calendars an answer covers, "The calendars have not been read yet. Try again in a minute."; a store read that fails,
"The calendar could not be read just now."

**Bounds on a turn**: a day is one indexed range read page by page, at most 200 rows (more: "There are more events
than I read"); a search reads at most 1,000 rows in start order, and "next" at most 1,000 over the days ahead (today's
read from the rows that have not ended), every row read counting; each says when it stopped short instead of answering
"nothing", and "next" never names an event from a day it read only in part: it says up to which day it found
nothing ("I found nothing called opera up to Sunday the third of January 2027; after that there are too many events
for me to look through."), or, when it could not read even today whole, "There are too many events around now for me
to tell which comes next; ask me what is on today instead." Each answer reads the calendars' states before and after
its rows, and reads again when a refresh published meanwhile. Between pages, and before each day it reads, a turn gives
the event loop a real turn (a macrotask); who may hear what is then decided in one synchronous step after the last
read.

## Settings

| Field | Kind | Default |
|---|---|---|
| Calendars | records (at most 10): **Name** (one line, 40, unique), **Address from** (the address below, or private link 1–3), **ICS address** (`https://`, `http://` or `webcal://`, no user name or password in it), **Whose calendar** (empty for the household's, or a member's name or id) | none |
| Private link 1, 2, 3 | secret (key vault): an ICS address that is itself a secret (a private Google or iCloud link); never shown, stored, logged or spoken | unset |
| Read the calendars every | 15 minutes, 30 minutes, hour, 3 hours | hour |

Refused when saved: two calendars of one name, a calendar without an address (and no private link chosen), an address
that is not `http(s)` or `webcal`, a name that is empty or not one line.

**Health**: "No calendars are set up" (info) with none; "<name> has no private link" (warning) for a calendar that reads
a private link that is not set. A calendar that cannot be read fails the repeating refresh job, whose Health issue names
it and why ("Could not read: Family (unreachable)") until a refresh succeeds; the run at each start does not fail.

## What it stores

Data version 1 (the first released version). Everything is a cache of the calendars; nothing in it was typed by a
person.

| Collection | Scope | `maxChars` (rows a list reads) | Indexes | What |
|---|---|---|---|---|
| `occurrences` | household | 1,250 (20) | `[day, start]`, `[day, end]`, `start`, `batch` | One occurrence on one local day it touches (`day` is `YYYYMMDD` in the household's zone; an event of several days has a row for every day of the window it covers): its calendar's name, its generation (`batch`), its identity (`key`, a hash of its UID and recurrence id), start and end, all-day, title, place, owner (absent for a household calendar), busy, and whether it goes on after the last day kept |
| `sources` | household | 1,600 (15) | — | One row per calendar: when it was last tried and last read, why it failed (`unreachable`, `refused`, `too-large`, `status`, `not-calendar`, `too-many`, `too-slow`, `busy`, `failed`, `owner`, `no-link`, `store`; never a URL or the server's words), its current generation and what it was read from (a fingerprint of the address, the owner, the zone), how many events could not be read, its row count, its last day, the server's `ETag` for a conditional request on the same day, and a generation being written or old ones still to remove |

Row ids are hashes (`ev-…`, `src-…`) of the calendar's name, its generation, the event's identity and the day: no title
or address shows in them. The private links are never stored. What is stored instead, in the `sources` row's `link`,
is a fingerprint, so a changed address is noticed: the first 16 hex digits (64 bits) of SHA-256 over
`pva-calendar-link`, a NUL and the address. It cannot be turned back into the address, and it is only compared with
the fingerprint of the address the settings have now; no tool, action, Health issue or log line holds it (like every
committed row, the state row's change goes on the server's in-process bus, which sends nothing to voice pages). Removed rows are gone for good, but the daily backups keep them up to 14 days.

**Jobs**: the handler `refresh` (idempotent, one retry, at most 5 minutes) runs as the repeating job `refresh` (cron
`7 * * * *` by default: `*/15`, `*/30` or `7 */3` by the setting, in the household's zone) and once at every start
(`refresh-start`, so a change of the settings is read at once). One refresh runs at a time. A refresh cut short (a
restart, a store failure) leaves the current generation as it was; the next one removes what it had written.

**Bounds of a refresh** (none of it on a turn): a calendar is at most 1 MiB and 15 seconds, `GET` only, the calendar
content types only (never HTML), public addresses on ports 80 and 443 only (`safeFetch`). It is read in a worker
(`src/ics.task.ts`) with 5 seconds of real time and 256 MB. Its input is one flat record (the file, the window, the
zone, the forbidden texts as one JSON string, the limits as plain fields); its answer is **one string of JSON lines**
(at most 4 MiB, `src/answer.ts`), which the main thread reads 200 lines at a time with a real yield between batches,
checking every line: an answer with a line it cannot read fails the whole refresh, and nothing of it is written. A call
the helper refuses because too many are waiting is `busy` (tried again at the next refresh); any other refusal of the
helper is `failed`. A file over 5,000 events, 3,000
occurrences or 6,000 rows is a failed refresh (`too-many`), as is one that takes longer (`too-slow`: a rule the library
never finishes, `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`, ends there). Within the file, each kept line is at most 8,000
characters (a schedule line over it leaves its event out), a time zone definition at most 1,000 lines and 40 of them,
a series at most 200,000 steps (more: the event is left out and counted). Rows are written 25 per transaction and
removed 20 per transaction, with a yield between them. **Measured** (development machine, `CALENDAR_BENCH=1`): on
SQLite (`test/latency.test.ts`), a refresh writing 2,900 rows and removing 2,900 from a 1 MiB file holds the main
thread at most 2.8 to 5.2 ms, and one of the largest answer a calendar may give (2,898 occurrences of the longest
two-byte titles and places, about 2 MiB as counted) 2.4 to 3.0 ms; reading 3,000 lines of the longest kind (2.16 MiB
as counted) 1.2 to 2.2 ms; in the test kit, the reviewer's 1 MiB file of 6,000 events 3.8 to 4.2 ms, a file of 5,001
events 2.3 to 2.9 ms, the impossible rule 2.2 to 2.6 ms; the tests fail above 10 ms (30 ms on CI). The worker's own start-up
(docs/MODULES.md §15) is paid on its thread, once per calendar per refresh.

## What it needs

- `requires`: `{ network: "internet" }` (the ICS addresses), with a `health` check.
- `uses`: nothing. Consumes the core's `People`, `Privacy` and `Devices` (looked up at each answer, after its reads).
- Provides the contribution `BriefingSections` (id `calendar`); no service.
- Libraries: `ical.js` (loaded only in the reading worker), `@pva/net`, `@pva/language`; `offThread` from `@pva/core`.
- The provider interface for calendar sources (`CalendarProvider` in `src/provider.ts`) is the module's own: this
  version has the ICS provider only. It is not a shared contract: no other module provides a calendar in this wave.

## What was left out

**For wave B** (needs P7, P9 or P10, which do not exist yet):

- Reminders before events (the research's reminder planner): notifications, P9.
- The agenda as a list or a week table on screens, the created-event card: presentations, P10.
- Phrase commands for "what's on today": P7. The typed actions above serve the intent path meanwhile.
- "And after that?" continuing a read agenda: conversation state of the reading session.

**Left out of this version** (the lead's ICS-only scope and the plan's row, and the review's fix round):

- **The ambient line** ("Next on the household calendar: …" in the host's household facts): cut in the review's fix
  round. It was a second copy of personal content whose privacy went stale when a calendar's owner changed; nothing of
  the calendars goes into the prompt.
- **`calendar_add` with undo**: an ICS link is read-only, so there is no calendar to add to; writing needs CalDAV (or
  Google), which needs HTTP methods other than `GET` and `HEAD` (docs/MODULES.md §12). Adding a repeating event stays
  refused by the plan (§2 row 6).
- **CalDAV** and the Google provider: later, as providers of `CalendarProvider`.
- Change and delete, Microsoft and Home Assistant calendars: the plan's "left for later".
- Calendars on the home network (a Nextcloud or Radicale on the LAN): `safeFetch` refuses private addresses, and the
  lead's scope reads ICS through `safeFetch`. Reading an address the owner typed with `fetchOwnerConfiguredLan` would
  allow it.
- Windows time zone names without a VTIMEZONE (some Outlook files): not IANA names, so their events are left out and
  counted rather than guessed.
- The research's other settings: a "Family" calendar, the week's first day, default event length and reminder, a
  per-device "show personal events" switch, per-person default calendars.
- A "Test" button on the page; event descriptions; attendees (they are `message` risk).
