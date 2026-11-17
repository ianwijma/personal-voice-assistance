# Calendar

Research write-up, 2026-11-17. Nothing here is built. Shared foundations (Connection, Module manifest, Module store,
Scheduler, Event bus, Notification service, Tool context, Presentation, Device capabilities) are worked out in
[`../module-investigation/`](../module-investigation/) and linked, not redesigned. Claims marked **[unverified]** or
**[from memory]** were not confirmed in a primary source.

## 1. Summary

A provider-neutral calendar capability: "what's on today", "when is the dentist", "am I free Friday afternoon", "put
football practice on Wednesday at half past six", reminders before events, and the agenda part of the
[briefing](briefing.md). The tools are written once against a small `CalendarProvider` interface; providers are
CalDAV (Nextcloud, iCloud, Fastmail, Radicale), Google (through the [google](google.md) connection), Microsoft Graph,
read-only ICS links, and Home Assistant calendar entities.

- **Priority: first wave.** Calendar is in the top five of every comparable product
  ([landscape-voice-assistants §14](../module-investigation/landscape-voice-assistants.md),
  [landscape-automation §14](../module-investigation/landscape-automation-platforms.md)) and feeds the briefing.
- **Effort: M** for the core plus two providers (ICS and Google or CalDAV); **L** with all five. The hard parts are
  recurrence expansion, time zones, spoken dates, and household versus personal calendars, not the APIs.

## 2. What others do

| Product | Calendar behaviour | Copy | Avoid |
|---|---|---|---|
| Alexa / Echo Show | Family calendar with one colour per member, full-screen agenda, "add an event" with slot-filling questions | Colour per person on screen; a "Family" calendar as a first-class target | Long slot-filling dialogues ("what time?" "how long?") when the model can fill defaults |
| Google / Gemini for Home | Personal calendar via Voice Match; "what's my day like" | Per-person answers by who is speaking | Invented calendar entries ([landscape-voice-assistants §2(f)](../module-investigation/landscape-voice-assistants.md)) |
| Siri / HomePod | Personal Requests read the calendar of a recognised voice | Guests get nothing personal | — |
| Home Assistant | `calendar` entities from many integrations; action `calendar.get_events` with a response; `calendar.create_event` only where the integration supports it; triggers on event `start`/`end` with an `offset`, but calendars are read **every 15 minutes** ([HA calendar](https://www.home-assistant.io/integrations/calendar/)) | Event triggers with an offset; "only some calendars are writable" stated per calendar | 15-minute polling as the only source of reminders |
| Claude voice | "Push my meeting by 30 minutes" | Edit by intent | — |
| Raycast, Gemini Workspace, OpenClaw `gog` | `agenda(day)`, `next_event`, `add_event` ([landscape-launchers §7](../module-investigation/landscape-launchers-and-agent-tools.md)) | A small, fixed tool set | — |

## 3. Example conversations

1. "Hey Jeff, what's on today?" → "Three things. Standup at nine thirty, lunch with Marloes at half past twelve, and
   Mila's swimming lesson at four, that's on the family calendar." (screen: agenda `list`)
2. "Am I free Friday afternoon?" → "Friday after twelve you have nothing until the dinner at seven."
3. "Put the dentist on Thursday at half past two." → "Dentist, Thursday 20 November, 14:30 to 15:00, on your
   calendar." → "Make it an hour." → "Done, until half past three."
4. **Household target.** "Add football practice every Wednesday at half six to the family calendar." → "Football
   practice, Wednesdays from 26 November, 18:30 to 19:30, on Family. Repeats weekly without an end. Okay?" → "Yes."
5. **Ambiguous date.** "Move the meeting with Tom to next Friday." → "Do you mean this Friday the 21st or the 28th?"
   (said on a Monday; "next Friday" is ambiguous in English and in Dutch "volgende week vrijdag" is not)
6. **Dutch time.** "Zet de kapper op zaterdag half elf." → "Kapper, zaterdag 22 november, 10:30." ("half elf" is
   10:30, not 11:30: parsed locally, §12)
7. **Who.** On the kitchen speaker: "What's on tomorrow?" → "For the family: bins out, and Sanne's parents visit at
   two. For yourself, say 'my calendar'." (household calendar on a shared device, §13)
8. **Failure.** "What's on today?" → "I couldn't reach your Nextcloud calendar. From what I had at 7:50: standup at
   nine thirty and lunch at twelve thirty." (stale cache, stated as such)
9. **Reminder.** (unprompted, at 15:30 on the device where Ian was last active) "Mila's swimming lesson in 30
   minutes. Leave by quarter to four."
10. **Show it.** "Show me next week." → agenda for 7 days on the study screen; on a speaker: "Next week is busy on
    Tuesday and Thursday; want me to put it on the kitchen screen?" (**screen**)

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `calendar_agenda` | `from` (date or phrase resolved by the tool), `to?`, `who?: "me" \| "household" \| person name`, `calendars?` | events: id, calendar label, owner, title, start, end, all-day, location, recurring flag; plus `stale: boolean`, `asOf` | read | safe | 10–30 ms from the synced cache; 300–1500 ms live | yes ("what's on today/tomorrow") |
| `calendar_next` | `who?`, `match?` (text: "dentist") | the next matching event, or none | read | safe | 10–30 ms | yes ("when is my next appointment") |
| `calendar_find` | `text`, `from?`, `to?` (default ±90 days) | up to 10 events | read | safe | 20–50 ms | no |
| `calendar_free` | `from`, `to`, `who?`, `minMinutes?` | free intervals | read | safe | 20–50 ms | no |
| `calendar_add` | `title`, `start`, `end?` or `durationMin?` (default 30, all-day for date-only), `calendar?` (label or "family"), `location?`, `repeat?` (RRULE subset: daily, weekly on days, monthly, until/count), `alertMin?` | created event, resolved calendar, the spoken read-back | write | changes data | 300–1200 ms | yes, via the typed action with `ValueParsing` |
| `calendar_change` | `eventId` (from a previous result), `start?`, `end?`, `shiftMin?`, `title?`, `scope?: "this" \| "following" \| "all"` | updated event | write | changes data | 300–1200 ms | no |
| `calendar_delete` | `eventId`, `scope?` | ok | write | changes data (confirm) | 300–1000 ms | no |
| `calendar_undo` | — | reverts the last write by this conversation | write | changes data | 300–1000 ms | yes ("undo that") |

Notes:

- Read tools are `speculative: true` and answer from the cache, so "what's on today" is ready before the turn is
  committed. A live refresh runs in the background when the cache is older than 5 minutes.
- Dates are passed as **phrases or ISO values**; the tool resolves phrases with the household time zone and locale,
  so the model cannot get "next Friday" or "half elf" wrong silently, and the result echoes the resolved date.
- `calendar_add` and `calendar_change` are `change` risk, allowed without confirmation (like lights), because the
  read-back plus `calendar_undo` is cheaper than a question. Recurring additions and every delete ask, which needs core
  confirmation switched on; until then `calendar_delete` and recurring `calendar_add` refuse with "do that on the
  screen" and offer a `confirm` card.
- Invitations to other people (attendees) are `message` risk: they send mail. Left out of version 1.

## 5. Integrate or build

Build the module and the cache; integrate every backend.

| Provider | Protocol and library | Auth | Write | Notes |
|---|---|---|---|---|
| **CalDAV** (Nextcloud `https://<host>/remote.php/dav/`, iCloud `https://caldav.icloud.com`, Fastmail `https://caldav.fastmail.com/dav/` **[from memory]**, Radicale, Baïkal) | [`tsdav`](https://tsdav.vercel.app/) (`createDAVClient`, `fetchCalendars`, `fetchCalendarObjects({ timeRange: { start, end }, expand })`, `createCalendarObject`, `updateCalendarObject`, sync via `syncCollection`/ctag); `ical.js` to parse and write VEVENT | Basic auth with an app-specific password (iCloud and Fastmail require one); Nextcloud app password | yes | The most general option; also covers VTODO for the lists module ([landscape-automation §11](../module-investigation/landscape-automation-platforms.md)). Some servers do not implement `expand`; expand recurrence locally with `ical.js` (RRULE, EXDATE, RECURRENCE-ID overrides) |
| **Google** | Calendar API v3: `GET /calendar/v3/users/me/calendarList`, `GET /calendars/{id}/events?timeMin&timeMax&singleEvents=true&orderBy=startTime`, incremental `syncToken`, `POST /calendars/{id}/events`, `PATCH`, `POST /freeBusy` | The [google](google.md) **Connection**; scopes `calendar.events.readonly` + `calendar.calendarlist.readonly`, or `calendar.events` to write ([scopes](https://developers.google.com/workspace/calendar/api/auth)) | yes | `singleEvents=true` makes Google expand recurrence; appointment schedules are not exposed by the API ([gog README](https://cdn.jsdelivr.net/gh/steipete/gogcli@main/README.md)) |
| **Microsoft** (Outlook.com, Microsoft 365) | Graph: `GET /me/calendars`, `GET /me/calendarView?startDateTime&endDateTime` (expands recurrence), `/me/calendarView/delta`, `POST /me/events` | **Connection** type `microsoft`; delegated `Calendars.Read` or `Calendars.ReadWrite` + `offline_access`; the device-code flow **is** supported ([Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)), so setup is "go to microsoft.com/devicelogin and enter ABCD-EFGH" | yes | Refresh tokens last 90 days by default ([Microsoft refresh tokens](https://learn.microsoft.com/en-ca/entra/identity-platform/refresh-tokens)); whether each refresh restarts that window is described inconsistently **[unverified]**, so the daily token keeper applies here too |
| **ICS link** (school, sports club, bin collection, public holidays, a shared iCloud "public calendar" link) | `fetch` with `If-None-Match`/`If-Modified-Since`, parse with `ical.js` or `node-ical` | none, or a secret URL (stored as a secret) | no | Poll every 30–60 min; the cheapest way to get the household's external calendars in |
| **Home Assistant** | action `calendar.get_events` (with response) over the existing HA connection, or REST `GET /api/calendars/<entity_id>?start=&end=` **[from memory]**; `calendar.create_event` where the HA integration supports it | the existing HA module's token | partly | Reuses whatever HA already aggregates (local calendar, waste collection, Google via HA). Write support differs per integration |

**Recommendation:** ship ICS and CalDAV first (local-first, no OAuth, covers Nextcloud and iCloud), Google second
(the owner asked for it, after the Connection exists), HA calendars third (nearly free once the HA module exposes
actions with responses), Microsoft only if someone in the house uses it. Use `tsdav` and `ical.js` inside a
`packages/calendar-caldav` adapter; Google and Microsoft are plain `fetch` adapters on their connections.

## 6. Data

| What | Scope | Shape | Readable by |
|---|---|---|---|
| Calendar sources | household (list) | `{ id, provider, connectionId?, url?, remoteId, label, colour, owner: "household" \| personId, writable, include: boolean, defaultFor?: personId \| "household" }` | admin; this module |
| Event cache | person or household, by the source's owner | `{ sourceId, uid, recurrenceId?, title, start, end, allDay, tz, location, status, etag, updatedAt }`, expanded occurrences for −7 to +60 days | this module; an export `calendar.window(from, to, who)` for [briefing](briefing.md) and the ambient facts |
| Sync state | per source | ctag / syncToken / deltaLink, `lastOkAt`, `lastError` | this module |
| Write journal | conversation | last writes for `calendar_undo`: provider id, etag before, the previous body | this module |
| Reminder state | person | which event occurrences have been announced (dedupe key `uid@start`) | this module |

Stored in the **Module store** ([shared-state §4](../module-investigation/shared-state-jobs-and-notifications.md)).
Times stored as UTC instants plus the original `TZID`; all-day events as dates, never as midnight instants.

## 7. Long-running work and events

- **Sync job** per source (**Scheduler**, `recurring`): CalDAV ctag check every 5 min (a cheap PROPFIND), Google
  `syncToken` every 5 min, Graph `delta` every 5 min, ICS every 30–60 min, HA every 5 min. Missed while down: run once
  at start. A failing source keeps its last cache and marks it `stale`.
- **Reminder planner**: after each sync, for occurrences in the next 24 h with an alert (the event's own VALARM or
  the person's default, e.g. 15 min), schedule one `reminder` job with `dedupeKey = uid@start`, `onDue: { notify }`,
  and `missed: { fireIfWithinMs: 10 min }`. A moved event reschedules its job; a deleted one cancels it.
- **Leave-time reminders** (later): when an event has a location and a commute module exists, the planner asks it for
  travel time and schedules "leave by" instead of a fixed offset.
- **Events emitted:** `calendar.changed` (source, window), `calendar.event.soon` (for screens to highlight the next
  event), `calendar.source.status`. Listens to `google.connection.status` to mark Google sources `locked`.
- Restart: cache and jobs survive in SQLite; sync resumes from the stored tokens.

## 8. Presentation

| Situation | Screen | Speaker only |
|---|---|---|
| Agenda for a day | `list` with `secondary` = time and calendar label, colour per person; the next event highlighted. A dedicated `agenda` kind (days as columns on large screens) is a candidate addition to the catalogue ([presentation §3.2](../module-investigation/presentation-and-device-capabilities.md)), see open question 4 | Up to four events, times spoken "half past twelve" style, "and two more in the evening" |
| A week | `table` (day × events) on `standard`/`large` displays, `list` grouped by day on `compact` | One sentence per busy day, skip empty ones |
| Created event | `card` with title, date, time, calendar, and actions Undo / Change time | The read-back sentence |
| Pinned (ambient) | On an `alwaysOn` kitchen display, the next three household events as a pinned widget | — |

Personal events carry `sensitivity: "personal"`; on a shared screen the household calendar is shown, personal
events become "Ian: busy 12:30–13:30" unless the device's default person matches.

## 9. Notifications and proactive behaviour

- **Event reminders**: `normal` priority, audience the event's owner (a person, or household for family events),
  ring policy "where that person was last active, else default devices, else phone"
  ([shared-state §8.3](../module-investigation/shared-state-jobs-and-notifications.md)). One spoken line, no cue loop.
- During quiet hours: inbox and phone only. Family events (school pickup) can be marked `high` per source.
- **Morning**: nothing by itself; the [briefing](briefing.md) reads the day.
- **Never**: "you have no events today" unprompted.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | Family calendar (which source is "family") | none |
| Household | Week starts on | Monday (from locale) |
| Module | Sources (records: provider, URL or connection, label, colour, owner, writable, include) | — |
| Module | Sync intervals; cache window (−7 / +60 days) | 5 min; as stated |
| Module | Default event length; default reminder | 30 min; 15 min |
| Assistant | Which tools (a kids' assistant: `calendar_agenda` household only) | all read tools |
| Device | Show personal events on this screen | off on `shared`, on on `private` |
| Person | Default calendar for "my calendar"; default reminder; spoken time style (12/24 h) | first writable owned source; household |

Secrets: CalDAV app passwords and ICS secret URLs in the vault; Google and Microsoft through a **Connection**.

**First-run setup:** add a source (pick provider → URL and app password, or choose a linked account), the module
lists the calendars found, the owner ticks which to include, sets the owner and colour of each, and marks one as
Family. A "Test" button shows "Nextcloud: 4 calendars, 132 events in the next 60 days".

## 11. Native tools and dependencies

None beyond Node and network access to the calendar servers. Declared requirements: `{ network: "lan" }` for
Nextcloud/HA, `{ network: "internet" }` for iCloud, Google, Microsoft, Fastmail, per source.

| Missing | Behaviour and spoken line |
|---|---|
| No sources | module `unavailable`: "No calendars are set up yet; the owner can add one in the admin page." |
| Source unreachable | answer from cache with `stale`: "I couldn't reach your Nextcloud; from what I had at 7:50, …" |
| Read-only source as target | "The school calendar is read-only. Shall I put it on yours instead?" |
| Google connection `needs-reauth` | "Your Google calendar link has expired; it needs renewing in the admin page." |

## 12. Interaction with the rest of the system

- **Dates and times in speech.** Parse locally, not by the model, so the typed-intent path can add events and the
  result is checkable. [`chrono-node`](https://github.com/wanasit/chrono) handles English phrases and has a Dutch
  parser **[coverage unverified]**; core's `ValueParsing` should own the quirks: Dutch "half elf" = 10:30, "kwart
  over zeven" = 19:15 or 07:15 by context, "half zeven 's avonds"; English "half six" (British, = 18:30), "a quarter to
  four"; "next Friday" (ambiguous → ask when it could mean two dates), "this weekend", "the 3rd" (speech recognisers
  often write "the third" or "3"). Times without am/pm default to the next sensible occurrence (07:00–21:00 band).
  Always echo the resolved weekday and date in the reply.
- **Names in titles.** Keep the recogniser's words; the read-back lets the person correct "Marloes" spelled "Marlous".
- **Fillers.** Cache reads need none. A write says "putting it in" before the provider call.
- **Interruption.** Barge-in during an agenda read stops it; "and after that?" continues from the next event (the
  last spoken index is in conversation state).
- **Character.** Nothing special; a planned `turn.activity` extension could show a "calendar" glyph while writing.
- **Assistants.** A "Family organiser" template (calendar, lists, reminders; household-first wording; suggested
  phrase "hey planner"). Every general assistant gets the read tools.
- **Typed intents.** Actions `calendar_today`, `calendar_tomorrow`, `calendar_next`, `calendar_add` with examples in
  English and Dutch ("wat staat er vandaag", "zet ... in de agenda").
- **Other modules.** Feeds [briefing](briefing.md) through `calendar.window`; provides the "next event in 2 h" line
  to the host's ambient facts (≤ 1 line, within the 50 ms context budget); uses commute for leave times; the lists
  module can share the CalDAV adapter for VTODO.

## 13. Privacy and safety

- Each source has an owner. Household sources are readable on every device; personal sources only for the resolved
  person ([module-definition §B.4](../module-investigation/module-definition-config-and-dependencies.md)): speaking
  person, then device default person. On a shared device without a known person, personal events are summarised as
  "busy" or left out, and the reply says so (example 7).
- Event descriptions and locations from invitations are untrusted text (they can contain instructions); tool results
  present them as data and truncate descriptions to 200 characters.
- Children: a kids' assistant sees the family calendar only. Guests: family calendar on request, nothing personal.
- Deletion and recurring changes ask (§4). Undo covers the rest.

## 14. Foundations needed

Hard: **Tool context** (whose calendar, which device's time zone). For Google and Microsoft: **Connection**.
Soft: **Module store** (cache), **Scheduler** (sync, reminders), **Notification service** (reminders),
**Presentation** (agenda list), **Device capabilities** (`privacy`, display class), people records.

**Useful first version without them:** ICS and CalDAV sources as module settings (`records` field, or a `textList` of
URLs until records reach module forms), live queries with an in-memory cache refreshed by a scoped fiber every
5 minutes (like the HA module's refresh), read tools plus `calendar_add`, one owner, no reminders. That covers "what's
on today" and the briefing's agenda part in a few days.

## 15. Open questions

1. Which calendars does the household actually use today (Google, iCloud, Nextcloud, school ICS links)? This sets the
   provider order.
2. Should adding an event ask "okay?" first, or add it and offer undo (the recommendation)? The same choice for moving.
3. On shared devices, show personal events as "busy", hide them, or show them in full?
4. Add an `agenda` kind to the presentation catalogue, or make do with `list` and `table`?
5. Reminders: use the event's own alarms only, or a default per person for every event (risk: too many announcements)?
6. Does the briefing count as the morning reminder, so that 07:00–09:00 events get no separate reminder?
7. **Disagreement with [landscape-voice-assistants §17](../module-investigation/landscape-voice-assistants.md):** it lists
   `calendar_move_event` as a separate tool; this document folds moves into `calendar_change` with `shiftMin`, to keep
   the tool count small.
