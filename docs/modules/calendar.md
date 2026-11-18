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
every calendar on a schedule (every hour by default) through `safeFetch`, expands repeating events with `ical.js`
(RRULE, RDATE, EXDATE and moved or cancelled occurrences, VTIMEZONE and IANA zones), and keeps their occurrences from
yesterday to 62 days ahead in the household store. Every tool and action answers from that store, so nothing on a turn
waits for the network; a calendar that could not be read at the last refresh is answered from its last good read, and
the answer says so ("Family could not be read at the last refresh; this is what I had at ten o'clock.").

It contributes the calendar's section to the briefing (`BriefingSections`) and an ambient line ("Next on the household
calendar: Standup, today at 09:30") to the host's household facts, which are off until the owner switches them on
(`HOME_AMBIENT_FACTS`).

### Privacy

A household calendar's events are shown on every device. A member's calendar is personal: each of its events carries
the member as its owner, and is revealed only where `Privacy.mayReveal(owner, turn)` says yes **at the moment of
answering**, for the device that asked:

| device | a member's events |
|---|---|
| `private` | in full |
| `shared`, whose default person is the owner | in full |
| `shared`, another default person or none | **reduced**: "Robin is busy from two o'clock to three o'clock" (whose and when; no title, place or calendar name). An all-day event, which makes nobody busy, is only counted |
| `public`, or a device the server does not know | withheld, only counted ("2 personal events are not read out here.") |

This reduction is the one docs/MODULES-PLAN.md §2 row 8 describes ("Ian: busy 12:30 to 13:30"). Searching by words
(`calendar_find`, `calendar_next` with words, `when_is`) never looks at an event that is not shown in full: a match
would tell what it is called. "Me" with nobody known asking (a public screen, a shared device without a default person)
is a question ("Whose calendar?"), and on a public screen whose default person is known, "my calendar" is refused. A
calendar whose owner names nobody in Members (or two people) is not read at all. A row is used only while its calendar
is still configured with the same owner, so a change of the settings never shows an event under its old owner.

The briefing section reads the household's events and the asking person's own (when they may be revealed there) and
only counts everyone else's: a section holds one person's content at most.

Event titles and places come from outside: they are cut to one line (120 and 80 characters), descriptions, alarms and
attachments are never read, and every result that holds them says they are calendar text, not instructions.

## Tools

All plain reads of the store: `speculative`, risk `read`, no network. `who` is "me", "household", a member's name, or
absent for everyone's. A day is a phrase ("today", "Friday", "vrijdag", "next Friday" is asked back as a question,
never guessed) or `YYYY-MM-DD`.

| Tool | Parameters | Answers | Example |
|---|---|---|---|
| `calendar_agenda` | `day?`, `days?` (1–14), `who?` | the day's events (at most 12, then "more"), whose busy times where reduced, what is withheld, stale and cut | "What's on today?", "What do we have this weekend?" |
| `calendar_next` | `match?` (words of the title or place), `who?` | the next event, or the next one with those words that has not ended | "What's next?", "When is the dentist?" |
| `calendar_find` | `text`, `who?` | up to 10 events with those words, from now to the end of the cache | "When is swimming this month?" |
| `calendar_free` | `day?`, `from?`, `to?` (`HH:MM`, default 08:00–21:00), `minMinutes?` (default 30), `who?` | one sentence of free times; the household's events count as busy for "me" too; all-day and transparent events do not | "Am I free Friday afternoon?" |

Typed actions (for the intent path; not offered to the model, which has the tools), each answering `{ say }` with no
model:

| Action | Example phrases | Says |
|---|---|---|
| `calendar.today` | "what's on today", "wat staat er vandaag" | "Today: Standup at half past nine, Lunch with Marloes at half past twelve and Swimming lesson at four o'clock." |
| `calendar.tomorrow` | "what's on tomorrow", "wat staat er morgen" | "Tomorrow: Bins out, all day." |
| `calendar.next_event` | "when is my next appointment", "wat is mijn volgende afspraak" | "Next: Lunch with Marloes, today at half past twelve." |
| `calendar.when_is` | "when is the dentist", "wanneer is de tandarts" | "Next: Dentist, tomorrow at half past two." |

Every sentence is in English and Dutch (by `HOME_LANGUAGE`); times and dates by `@pva/language`. With no calendars
set up every tool and action says "No calendars are set up yet; …"; before the first good read, "The calendars have not
been read yet. Try again in a minute."

**Bounds on a turn**: a day is one indexed range read page by page, at most 200 rows (more: "There are more events
than I read"); a search reads at most 1,000 rows in start order, and "next" at most 1,000 over the days ahead, each
saying when it stopped short instead of answering "nothing".

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

Data version 1. Everything is a cache of the calendars; nothing in it was typed by a person.

| Collection | Scope | `maxChars` (rows a list reads) | Indexes | What |
|---|---|---|---|---|
| `occurrences` | household | 1,100 (22) | `[day, start]`, `[source, day]`, `start` | One occurrence on one local day it touches (`day` is `YYYYMMDD` in the household's zone; an event of several days has a row for each, at most 14): its calendar's name, start and end, all-day, title, place, owner (absent for a household calendar), busy. At most 3,000 rows per calendar (the earliest are kept). Rows ended before yesterday, of calendars no longer configured, or whose owner is no longer their calendar's are removed at each refresh. Read with pages of 20 |
| `sources` | household | 700 (35) | — | One row per calendar: when it was last tried and last read, why it failed (`unreachable`, `refused`, `too-large`, `status`, `not-calendar`, `owner`, `no-link`; never a URL or the server's words), its row count, whether it was cut, and the server's `ETag` for a conditional request on the same day |
| `upcoming` | household | 1,600 (15) | — | One row (`next`): the household calendars' next six events, for the ambient line |
| `upcoming_personal` | person | 1,600 (15) | — | One row per member with personal events (`next-<person id>`, in their scope): their next six, for the ambient line, which the host reads only where that person's things may be revealed |

Row ids are hashes (`ev-…`, `src-…`) of the calendar's name, the event's UID and its times: no title or address shows
in them. The private links are never stored: only the calendar's name is. Removed rows are gone for good, but the daily
backups keep them up to 14 days.

**Jobs**: the handler `refresh` (idempotent, one retry, at most 5 minutes) runs as the repeating job `refresh` (cron
`7 * * * *` by default: `*/15`, `*/30` or `7 */3` by the setting, in the household's zone) and once at every start
(`refresh-start`, so a change of the settings is read at once). One refresh runs at a time.

**Bounds of a refresh** (none of it on a turn): a calendar is at most 1 MiB and 15 seconds, `GET` only, the calendar
content types only (never HTML), public addresses on ports 80 and 443 only (`safeFetch`). It is cut into its events
with one line scan that keeps only the properties used (each line at most 8,000 characters, titles and places 1,000
before they are cut further), then parsed ten events at a time and expanded at most 20,000 steps per repeating event and
200,000 per calendar, with a yield to the event loop between steps; series repeating every minute or second are
skipped, at most 5,000 events and 3,000 occurrences are kept. Rows are written 50 per transaction with a yield between
them. Measured with `packages/module-calendar/test/ics.test.ts` ("never holds the event loop"; `CALENDAR_BENCH=1`
prints it): a 1 MiB file of 6,000 events, 600 of them repeating, takes about a second in all and holds the event loop at
most about 10 to 20 ms at a time on the development machine (the test fails above 100 ms).

## What it needs

- `requires`: `{ network: "internet" }` (the ICS addresses), with a `health` check.
- `uses`: nothing. Consumes the core's `People`, `Privacy` and `Devices` (looked up at each use).
- Provides the contribution `BriefingSections` (id `calendar`); no service.
- Libraries: `ical.js` (loaded on the first refresh, not when the app starts), `@pva/net`, `@pva/language`.
- The provider interface for calendar sources (`CalendarProvider` in `src/provider.ts`) is the module's own: this
  version has the ICS provider only. It is not a shared contract: no other module provides a calendar in this wave.

## What was left out

**For wave B** (needs P7, P9 or P10, which do not exist yet):

- Reminders before events (the research's reminder planner): notifications, P9.
- The agenda as a list or a week table on screens, the created-event card: presentations, P10.
- Phrase commands for "what's on today": P7. The typed actions above serve the intent path meanwhile.
- "And after that?" continuing a read agenda: conversation state of the reading session.

**Left out of this version** (the lead's ICS-only scope and the plan's row):

- **`calendar_add` with undo**: an ICS link is read-only, so there is no calendar to add to; writing needs CalDAV (or
  Google), which needs HTTP methods other than `GET` and `HEAD` (docs/MODULES.md §12). Adding a repeating event stays
  refused by the plan (§2 row 6).
- **CalDAV** and the Google provider: later, as providers of `CalendarProvider`.
- Change and delete, Microsoft and Home Assistant calendars: the plan's "left for later".
- Calendars on the home network (a Nextcloud or Radicale on the LAN): `safeFetch` refuses private addresses, and the
  lead's scope reads ICS through `safeFetch`. Reading an address the owner typed with `fetchOwnerConfiguredLan` would
  allow it.
- The research's other settings: a "Family" calendar, the week's first day, default event length and reminder, a
  per-device "show personal events" switch, per-person default calendars.
- A "Test" button on the page; event descriptions; attendees (they are `message` risk).
