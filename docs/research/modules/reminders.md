# Reminders

Research write-up, 2026-11-17. Not an approved design. It uses the shared foundations named in [README.md](README.md).
The store, scheduler, notification and identity designs are in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) (cited as
"shared state §n"). Delivery is described in [notifications.md](notifications.md), and the countdown cousin in
[timers-and-alarms.md](timers-and-alarms.md).

## 1. Summary

A reminder is a message for a person, delivered at a moment: a time ("at five"), a repeat ("every Monday evening"), a
place or presence ("when I get home", "next time I'm in the kitchen") or another person ("remind Sam to feed the cat").
It is delivered through the Notification service on the right device or phone, and closed by voice with "done" or
"snooze".

- **Priority: first wave**, directly after timers. Reminders reuse the same Scheduler and delivery. Without them, the
  notification service has only timers to deliver.
- **Effort: M** for time-based and recurring reminders, given the foundations. **Plus M** for presence and person
  targeting, because those need `Person` records, a presence source and delivery rules per person.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa | Time and recurring reminders. Location reminders since 2018 ("remind me to … when I get home"), using the phone's location; spoken on arrival by an Echo, or a push through the Alexa app when no Echo is near ([Engadget](https://www.engadget.com/2018/12/10/alexa-location-specific-reminders-and-routines/)). Person-targeted reminders on newer Echo Show use Visual ID ([Tom's Guide](https://www.tomsguide.com/ai/alexa-just-got-a-major-upgrade-for-the-holidays-here-are-the-new-shopping-and-home-features-im-most-excited-about)). | "Spoken if a device is near, else the phone." | Notifications wait behind a yellow ring until asked, which is fine for low priority but wrong for a reminder the person asked for at a time. |
| Google Assistant | **Assignable reminders** (2019): "remind Tim to take out the bins at 7", only for members of the family group; recipients can block them; "what are my reminders for Tim?" ([Engadget](https://www.engadget.com/2019/08/15/google-assistant-assignable-reminders/), [Android Police](https://www.androidpolice.com/2019/09/07/how-to-use-assignable-reminders-on-google-assistant/)). Location reminders with addresses. Current status under Gemini for Home: **unverified**. | Person targeting limited to household members. The recipient can opt out. "Reminders I gave to Tim." | — |
| Siri / Apple Reminders | Time, location (arrive/leave), "when messaging someone". HomePod reminders work only through the owner's iPhone with Personal Requests ([Apple](https://support.apple.com/guide/homepod/apd1841a8f81)). | The trigger set (time, arrive, leave). | Personal data only through the phone, so a shared speaker without voice match cannot remind you. |
| Home Assistant | No reminder entity. People use the `local_calendar` or `todo` entities with due dates plus blueprints that announce them. | — | Every household writes its own automation. |
| CalDAV / RFC 5545 | `VTODO` with `DUE` and a `VALARM` (trigger relative or absolute), recurrence as `RRULE` ([RFC 5545 §3.6.2, §3.6.6, §3.8.5.3](https://www.rfc-editor.org/rfc/rfc5545)). | The recurrence rule as the storage format, which keeps a later CalDAV sync possible. | — |

**Take-aways:** a reminder is personal by default, delivered where the person is, and on the phone when nobody is near
a device. Person targeting is limited to household members, who may opt out. Recurrence needs more than cron.

## 3. Example conversations

S = a screen helps; it works headless too.

1. "Hey Jeff, remind me to call mum at five." → "I'll remind you at five to call mum." At 17:00 on the device where Ian
   was last active, after a chime: "Ian, a reminder: call mum." → "Done." → "Ticked off."
2. "Remind me every Monday evening to put the bins out." → "Every Monday at 19:00: put the bins out." "Evening" maps
   to a household setting (19:00). The echo states the time chosen.
3. At delivery: "Snooze it for an hour." → "I'll remind you again at 20:00." Or "Remind me tomorrow instead." →
   "Tomorrow at 19:00."
4. "When I get home, remind me to water the plants." → "I'll remind you when you get home." This needs a presence
   source. Without one: "I can't tell when you get home yet. I could remind you at six instead?"
5. Ian: "Remind Sam to feed the cat at four." → "I'll remind Sam at four to feed the cat." At 16:00 on Sam's device or
   phone: "Sam, Ian asked me to remind you: feed the cat." The setter is always named.
6. Ambiguous: "Remind me about the dentist." → "When should I remind you?" With a calendar module on: "Your dentist
   appointment is Thursday at 10. Remind you an hour before?"
7. Ambiguous: "Remind me to buy milk." No time or place → "Want me to add milk to the shopping list instead, or remind
   you at a time?" A reminder without a moment is a list item (§12).
8. "What reminders do I have today?" → "Two: call mum at five, and bins at seven." S: a list on screen.
9. Failure, a shared speaker in the hallway: "What are Ian's reminders?" asked with no known person → "I can only read
   reminders on Ian's own devices." This is the person-scope rule (§13).
10. Failure, missed: the server was down at 17:00. At start: "Ian, a reminder from 17:00, a bit late: call mum."

## 4. Tools

Typed actions, offered as tools. The model resolves fuzzy times ("after lunch on Thursday") into an ISO time from the
clock context. The fast path parses only common forms locally (in N minutes/hours, at HH:MM, tomorrow at, tonight,
every weekday, Dutch equivalents).

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `reminders_add` | `text`, `at?: text` (time phrase or ISO), `in?: Param.duration`, `repeat?: text` ("every Monday", RRULE), `when?: choice` (`arrive_home`, `leave_home`, `next_seen`, `in_room`), `room?: dynamic`, `for?: dynamic` (person), `before_event?: text` (calendar event id) | echo with the resolved time | W | changes data (outward-facing when `for` is someone else) | < 20 ms | yes for time and duration forms |
| `reminders_list` | `for?: dynamic`, `range?: choice` (today, tomorrow, week, all), `set_by_me?: boolean` | grouped list | R, speculative | safe | < 10 ms | yes |
| `reminders_done` | `which?: dynamic` (default: the one just delivered) | "Ticked off." | W | changes data | < 20 ms | yes |
| `reminders_snooze` | `which?`, `for?: Param.duration` or `until?: text` | new time | W | changes data | < 20 ms | yes |
| `reminders_edit` | `which: dynamic`, `text?`, `at?`, `repeat?` | echo | W | changes data | < 20 ms | no (needs the model to understand the change) |
| `reminders_cancel` | `which: dynamic`, `series?: boolean` | confirmation | W | changes data | < 20 ms | yes |

`which` matches by text words, then time, then most recently delivered, as in timers (shared state §7). Ambiguity is a
question.

## 5. Integrate or build

| Option | For | Against |
|---|---|---|
| **Build on the Module store + Scheduler** | Local. Same delivery path as timers. Presence and person rules are ours | Recurrence and time parsing are ours to get right |
| CalDAV `VTODO` + `VALARM` (Nextcloud, Radicale, Fastmail) | Reminders appear in phone apps (DAVx⁵, Thunderbird) | Alarm delivery is by the client app, not by us; a sync layer with conflicts. iCloud Reminders upgraded since iOS 13 are not reachable over CalDAV (**unverified**) |
| Todoist / Vikunja | Existing apps with due dates and reminders | Hosted, or another service; delivery is theirs |
| HA `todo` / `local_calendar` | Visible in HA | No alarms of its own; needs HA |
| Apple Reminders via Shortcuts | Native on iPhone | Only through a phone automation posting to us; no read-back |

**Recommendation: build** the store and delivery. Store recurrence as an RFC 5545 `RRULE` string with a `DTSTART` in
the home time zone. Compute the next occurrence with a small RRULE library: the npm [`rrule`](https://github.com/jkbrzt/rrule)
package (maintenance pace **unverified**; a narrow own implementation of `FREQ/INTERVAL/BYDAY/BYMONTHDAY/COUNT/UNTIL`
is the fallback). Schedule only that single next occurrence as a one-shot job. Offer **CalDAV VTODO export/sync as a
second-wave provider**, so reminders can show up in phone apps without us becoming a task manager.

## 6. Data

Collection `reminders` in the Module store, scope **person** (shared state §4.3), except household reminders ("remind
everyone…"), which use scope `household`.

```ts
// Proposal
{ text: string                                    // "call mum", as said, minus "remind me to"
  for: PersonId | "household"
  setBy: Actor                                    // person and device it came from
  trigger:
    | { kind: "time"; at: number }                // epoch ms
    | { kind: "recurring"; rrule: string; dtstart: string; tz: string; next: number }
    | { kind: "presence"; event: "arrive_home" | "leave_home" | "next_seen" | "in_room"; room?: string; notBefore?: number; expiresAt: number }
    | { kind: "event"; calendarEventId: string; offsetMs: number }
  state: "pending" | "delivering" | "delivered" | "snoozed" | "done" | "cancelled" | "expired"
  nag?: { everyMs: number; maxTimes: number }     // "keep reminding me until I say done" (pills)
  jobId?: string; notificationId?: string; lastDeliveredAt?: number; doneAt?: number }
```

Done reminders are kept 30 days for "what did I do last week?", then removed. Exports: `reminders.upcoming(person,
range)` for the briefing module ("you have two reminders today") and for calendar views. Ambient line: `Reminders today
(Ian): call mum 17:00, bins 19:00.` It appears only on devices where Ian is the device-default person (§13).

## 7. Long-running work and events

| Trigger kind | Job | Missed while down |
|---|---|---|
| time | one `reminder` job, `{ notify }` with `dedupeKey: "reminder:<id>"` | `fire-late`, marked late |
| recurring | one job for the next occurrence; on delivery the module computes and schedules the next one | deliver the last missed occurrence once, not all of them (shared state §6.1) |
| presence | no time job; a subscription to presence events plus an expiry job (default 7 days: "Your reminder to water the plants expired; you didn't come home within a week") | presence is evaluated on start against current state, so it does not fire twice |
| event | a job at `event.start + offset`, re-planned when the calendar module publishes `calendar.event.changed` | `fire-late` while the event is still in the future |

**Presence sources**, in order of trust: (1) the Home Assistant `person` entity going to `home`, through the HA
connection's event stream (the module holds a websocket today, `packages/module-home-assistant/src/module.ts:199`); (2)
an inbound phone hook from an Apple Shortcuts or Tasker *Arrive/Leave* automation (iOS 17 can run location
automations without a tap, [Cassinelli](https://matthewcassinelli.com/automations-run-immediately-shortcuts-notifications/);
see [routines](routines-and-automations.md)); (3) `next_seen`: the next turn on a device whose default person is the
target. (3) is cheap and works today, but it means "next time you talk to me here", not "home".

**Events published:** `reminders.created`, `reminders.delivered`, `reminders.done`, `reminders.snoozed`,
`reminders.expired`. **Listens to:** `presence.changed` (a new event that the HA module or the inbound hooks would
publish), `notification.resolved` (done or snooze from a phone button), `calendar.event.changed`.

## 8. Presentation

- **Screen at delivery:** a `card` (title = text, subtitle "Reminder · set by Ian, 09:12") with Done, Snooze 1 h and
  Tomorrow buttons. The character holds it up (Hold-up, presentation §4.1) while the line is spoken, then it settles
  into the inbox badge if not answered.
- **"What reminders do I have":** a `list` (checklist style; ticking an item is `reminders_done`), with the top three
  spoken, then "and two more".
- **Ambient:** the next reminder within 2 hours as a small line next to the timers, only on the person's own devices.
- **Headless:** a soft two-note chime (distinct from timer and alarm cues), then "Ian, a reminder: call mum." The
  follow-up window opens for "done", "snooze", "later", "tomorrow" without the wake phrase (shared state §8.6).

## 9. Notifications and proactive behaviour

| Case | Priority | Audience and ring | Quiet hours |
|---|---|---|---|
| Time reminder for a person | `normal`, `requireAck` | the device where the person was last active within 15 min, else their default devices, else their phone | held until quiet hours end, or to the phone if the person chose that |
| "Remind me at 6 am" said explicitly inside quiet hours | `high` | as above | delivered: the person asked for that moment |
| Presence reminder | `normal` | the device in the room where the person was just seen (first turn after arrival), or announced on the hallway/entry device if marked, plus the phone | held |
| Nag reminder (pills) | `normal`, repeats every `nag.everyMs` until done, at most `maxTimes` | as above, phone from the second repeat | held, then resumes |
| Household reminder ("remind everyone at 18:00 to tidy up") | `normal` | `household`, as an announcement on every shared-room device | held |
| Missed and never acknowledged | `low` | inbox | — |

Unprompted speech beyond these is not allowed. In particular there is no "you have no reminders today".

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | quiet hours; times for "morning / afternoon / evening / tonight" (09:00 / 14:00 / 19:00 / 20:00); who may target whom | shared; as stated; adults → anyone, children → nobody |
| Module | snooze default (10 min, 1 h for "later"); presence expiry (7 days); done-retention (30 days); CalDAV sync connection (later) | as stated |
| Assistant | module on/off (exists) | on for general assistants |
| Device | the default person; "announce presence reminders here" (the hallway node) | none; off |
| Person | delivery: devices / phone / both; hold during quiet hours or send to phone; accept reminders from others (on) | devices then phone; hold; on |

Connections: optional Home Assistant (presence), later a CalDAV account. **First-run setup:** create household people
(name, default devices), and optionally link each person to an HA `person` entity. Without people, every reminder is
household-scoped and delivered on the device that set it.

## 11. Native tools and dependencies

None. The presence source is the HA connection or a phone automation. When none is configured, a presence reminder is
refused with an offer: "I can't tell when you get home yet. I can remind you at a time instead, or the next time you
talk to me here." Phone delivery needs a phone channel (notifications.md §5). Without one, "the phone" falls back to
the inbox.

## 12. Interaction with the rest of the system

- **Speech:** names of people ("Sam", "Sem", "Saskia") are matched against household people with the same fuzzy
  matcher as wake phrases. An unknown name is a question: "I don't know a Sem. Who do you mean?" Times: "at half
  five" is 17:30 in British English and 16:30 in Dutch ("half vijf"). The parser follows `HOME_LANGUAGE` and the echo
  says the clock time.
- **Timer vs reminder vs list vs calendar** (stable instruction text for the model):
  - a bare duration is a timer;
  - a task with a moment (time, repeat, place, event) is a reminder;
  - a task without a moment is a list item (the lists module);
  - something with a start and an end, which others should see as busy, is a calendar event.
  "Remind me to buy milk when I'm at the supermarket" has a place we cannot detect, so it becomes a list item plus the
  answer "I've put milk on the shopping list; I can't tell when you're at the shop."
- **Calendar:** the calendar module delivers its own event alarms through notifications. Reminders anchor to an event
  only when the person asks ("an hour before the dentist"). The anchor survives the event moving.
- **Briefing:** reads `reminders.upcoming` for the morning summary.
- **Character:** the Hold-up at delivery. No other choreography.
- **Agents:** general assistants get the module. A children's assistant gets `reminders_add` for themselves only (the
  household "who may target whom" rule, enforced in the tool, not in the prompt). No template.
- **Fillers:** none; the tools are local.

## 13. Privacy and safety

- Reminders are **person-scoped**. They are read aloud or listed only on devices whose default person is that person,
  or after the person is chosen on a screen (shared state §4.6). On a shared device a reminder is *delivered* with the
  name ("Ian, a reminder…"), which is the point. The text can be marked private ("remind me privately to…"). A private
  reminder goes to the person's phone only, and shared devices say "Ian, you have a private reminder on your phone."
- **Person-targeted reminders are outward-facing**: they make the assistant speak to someone else in someone's name.
  The setter is always named. Recipients can switch off "accept reminders from others". Children cannot target adults
  by default. Guests (no known person) can set only device-scoped reminders, which are delivered on that device.
- Voice identity, when it exists, selects whose reminders are read but never unlocks private ones (shared state §4.6).

## 14. Foundations needed

Module store (person scope), Scheduler, Notification service (person audience, requireAck, follow-up window), Tool
context with the person, Event bus (presence, calendar), `Person` records and the device-default person, Presentation
(`card`, `list`), Device capabilities.

**A useful first version without all of them:** time and recurring reminders, household scope only, delivered on the
device that set them (`ring: "origin"`), with done and snooze in the follow-up window. That needs only the store,
scheduler, tool context and the minimal ring/announce path from the timers first version. People, presence, phones and
CalDAV come after.

## 15. Open questions

1. **Who lives in the house**, and do you want per-person reminders now? Is a default person per device good enough
   until voice identification is tried (shared state open question 2)?
2. **Presence source:** is Home Assistant with the companion app's location your source of truth for "home", or should
   phone automations post arrive/leave to the assistant directly?
3. **Quiet hours:** hold reminders until morning, or send them to the phone (shared state open question 5)?
4. **Person targeting rules:** may anyone remind anyone? May children? Should the recipient be told who set it every
   time (proposed: yes)?
5. **Recurrence format:** this document stores RRULE and schedules one occurrence at a time. Shared state §2.2 and §6.2
   propose Effect `Cron` for recurring jobs, but cron cannot express "every second Tuesday" or "the last Friday of the
   month". Proposal: keep `Cron` for system jobs and alarms, and RRULE for reminders. Agree?
6. **CalDAV:** do you want reminders to appear in a phone's task app (Nextcloud or another CalDAV server), or are the
   assistant's own screens and pushes enough?
7. **Nagging:** should medication-style reminders repeat until "done" by default, or only when asked ("keep reminding
   me")?
