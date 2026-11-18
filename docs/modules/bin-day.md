# Bin day (`bin-day`)

Which bin goes out next, from the collection calendar's ICS link.

- Package: `packages/module-local-info`
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 18 (wave A)
- Research: [docs/research/modules/local-info.md](../research/modules/local-info.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

This page belongs to the module's pull request, which touches its package and this file and nothing else
(docs/MODULES.md, "What a module pull request may touch").

## What it does

Tells the household which bin goes out next, from the link of the municipality's (or collector's) waste collection
calendar in ICS format. The module fetches the calendar once a night (03:00) and once soon after it starts, keeps the
coming collection days in the household store, and answers from that copy: "which bin goes out tomorrow?" costs a store
read, not a request. It reads all-day and timed events, repeating events (`RRULE`, `EXDATE`, cancelled events), and
works out which bin a title is (GFT/green, paper, plastic/PMD, general waste, glass, in Dutch and English; anything else is
kept as "another bin" with the calendar's own words). The owner may name bins in the settings ("a title containing
*kerstbomen* is *Christmas tree*"). The module is **off by default**.

It contributes one briefing section (`bin-day`): "Bin day tomorrow: the green bin (GFT)." in a morning or on-request
briefing for today and tomorrow, tomorrow only in an evening one, from the stored copy only (a briefing never waits for the
network). With no collection today or tomorrow the section says nothing.

**Privacy.** The module stores nothing personal: a collection calendar is the household's, so it has no owner, and every
kind of device (private, shared, public) is told the same. The calendar's titles are outside text: they reach the model only
as bin names in a result field, cut to one line of at most 60 characters. The calendar link is a plain text setting, not a
secret (some collectors put an address code in it): it is never put in a result, an error, a log line, a Health issue or a
stored row (the store keeps a 16-character hash of it to know which link a copy came from).

## Tools

| Tool / action | Risk | Parameters | Says (example) |
|---|---|---|---|
| `bin_next` (tool, `speculative`) | read | `type?`: a kind of bin in the person's words | "Tomorrow: the green bin (GFT). After that, Friday: the paper bin." |
| `bin-day.next` (typed action, not also a tool) | read | `type?`: one of GFT, paper, plastic (PMD), general waste, glass | "Morgen: de groene container (GFT). Daarna, overmorgen: de papiercontainer." |

Example phrases (the action's `examples`, so they run without the language model): "which bin goes out tomorrow", "when is
the paper collected", "what bin do I put out", "welke container moet er buiten", "wanneer wordt het gft opgehaald", "welke
bak moet er morgen aan de weg".

Behaviour: the answer is the first collection day and the one after it (one sentence each), or, with a kind, that kind's
next day. A kind the calendar does not have, an unknown name, no link, an unreachable or unreadable calendar each get their
own sentence (English and Dutch) that says what the person can do. If the saved copy is older than two days the question
refreshes it first, within three seconds; if that fails the last copy answers and says so ("I couldn't refresh the calendar,
so this is from my last copy.").

The settings page has a **Test** button that fetches and reads the saved link and says how many collection days it found.

## Settings

| Field | Kind | What |
|---|---|---|
| Calendar link (ICS) | text, at most 500 characters | `https://`, `http://` or `webcal://`; no user name or password in it; checked as typed (the answer never quotes the link) |
| Bin names | records (at most 12): *words in the calendar title*, *call it* | the owner's own names, read before the built-in words |
| Check the calendar link | button | the **Test** button above |

Health (`bin-day.no-calendar`, info: no link yet; `bin-day.bad-link`, warning: not a web address) looks at the settings
only: no network, no store. A failed nightly refresh shows as a Health issue through the scheduler (below).

## What it stores

Both collections are in the household scope, data version 1.

| Collection | `maxChars` | Indexes | What |
|---|---|---|---|
| `collections` | 300 | `day` | one row per bin per day coming up: `day` (the number 20261119), `kind` (gft, paper, plastic, rest, glass, other) and, for a name the owner gave or a title the module does not know, a `label` (one line, at most 60 characters). At most 500 rows. A list reads up to 83 rows; the module reads them 25 at a time in date order and never more than 600 (a turn's scan is bounded and the refresh keeps the table under 500 rows). |
| `feed` | 300 | none | one row, id `state`: which link and names the copy came from (a hash), when it was fetched and last tried, whether the last try worked, how many collection days it holds. |

A change of link or names makes the old copy unusable at once (it is judged by its hash) and the next refresh replaces it.

**Scheduled.** `refresh-daily`: a system job, cron `0 3 * * *`, handler `refresh` (idempotent, up to 30 s, the scheduler's
default retries). `refresh-start`: once, two seconds after the module starts with a link, only when the copy is older than six
hours. A refresh fetches through `safeFetch` (accepts calendar types, at most 256 KiB, 8 s), reads the calendar with
bounds (at most 2,000 events, 400 repeats of one event, 400 days ahead, at most 500 collection days kept; `ics.test.ts` measures a 256 KiB
calendar), writes the difference in steps of 50 changes, and writes the state row last. Before it writes it checks the module's
link and names are still the ones it fetched with. A fetch that fails fails the run: it is retried, then the scheduler shows
the Health issue until a refresh works; the old copy stays and keeps answering.

## What it needs

`requires: internet` (the calendar is fetched from the link) and a `health`. It uses no other module's service. It
**provides** a `BriefingSections` contribution (`bin-day`), which only the briefing module consumes. Outside service: the
owner's calendar link (any public address; an address on the home network is refused by `safeFetch`). The User-Agent is the
product token only, plus the owner's contact (Home › API contact) when the owner set one.

## What was left out

Left out because it waits for **wave B** (docs/MODULES.md: no notifications, phrase commands, presentations or module speech
yet): the reminder the evening before ("the paper bin goes out tomorrow") as a notification, a spoken announcement on a
device, and the ambient fact ("bin tomorrow: paper") on screens.

Left out for the first version, as the plan's row says: reading the schedule from a Home Assistant sensor
(`waste_collection_schedule`), a manual "every other Tuesday" rule, and the municipality scrapers. A calendar's exceptions
to a repeat (`RECURRENCE-ID`) are skipped and a repeat's own days are used, so a moved collection that the calendar writes
only as an exception shows on its old day. Times are read in the household's time zone (Home › Time zone, else this machine's).
