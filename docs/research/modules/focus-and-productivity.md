# Focus and productivity (focus sessions, time tracking, planning, task capture)

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
the store, scheduler, events, notifications and tool context in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) ("shared state
§n"), presentation and device places in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md) ("presentation
§n"), connections and risk classes in
[`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)
("module definition §n"). Outside facts were checked on 2026-11-18; several API pages did not render, so paths taken
from memory are marked **[unverified]**.

## 1. Summary

The study-desk side of the assistant, for someone who works from home:

- **Focus sessions** (pomodoro or a free length): "focus for 50 minutes" starts a countdown, sets do-not-disturb on
  the device and the person's phone, and switches a desk light scene through Home Assistant; it ends with a break cue.
- **Time tracking:** "start tracking the Acme project", "stop", "how long did I work on Acme this week", with Toggl
  Track, Clockify, Kimai or a local log; ActivityWatch as a read-only record of what was on screen.
- **Planning conversations:** a short morning plan ("what are my three things today?"), an end-of-day review, and
  stand-up notes ("what did I do yesterday?").
- **"What was I working on?"** from the session log, the running time entry, ActivityWatch and [T3 Code](t3-code.md)
  threads.
- **Task capture** into [lists](lists.md), or into Todoist, Linear, Jira or GitHub Issues.

Three module ids in one package: `focus`, `time-tracking` and `planning`. Task capture into outside trackers is a
provider set of `planning`, not a fourth module.

**Boundaries.** Personal and household to-dos belong to [lists](lists.md) (Todoist is already a list backend there,
lists §5). This module adds work trackers (Linear, Jira, GitHub) and the planning dialogue. Do-not-disturb is the
[notifications](notifications.md) `notifications_dnd` tool; focus calls it, it does not reimplement it. Lights go
through [smart-home](smart-home.md) scenes. Coding threads stay with [t3-code](t3-code.md). The agenda comes from
[calendar](calendar.md).

- **Priority: second wave.** Focus sessions are cheap once timers and DND exist, and they are a daily habit at a desk.
  Time tracking and capture to work trackers are second wave too, if the owner uses those tools. Planning
  conversations are later: they are mostly prompts over other modules' data.
- **Effort: M.** Focus S (built on timers, DND and scenes). Time tracking S per provider. Planning S–M (prompt and
  data assembly). Work-tracker capture S per provider plus confirmation.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Apple Focus, Android DND | System focus modes that silence notifications, shared across devices; HA's companion app exposes iOS Focus state as `binary_sensor.focus`, and Android DND can be set with the `command_dnd` notification command ([HA](https://companion.home-assistant.io/docs/notifications/notification-commands)) | Focus as one switch that reaches every device | iOS cannot be set from outside except via a Shortcuts automation ([Seaman](https://www.derekseaman.com/2026/06/home-assistant-notifications-that-run-apple-shortcuts-yes-really.html)) |
| Alexa, Google | Timers and routines; no focus sessions **[unverified]** | — | — |
| Toggl Track, Clockify | One running timer per user, projects and tags; Toggl API v9 quotas since 2025: Free 30 requests/hour, Starter 240, Premium 600 ([Toggl](https://support.toggl.com/api-webhook-limits)) | One running entry; stop by voice | Polling the API: the free quota is tiny |
| [Kimai](https://www.kimai.org/documentation/rest-api.html) | Self-hosted time tracking, Bearer API token, OpenAPI at `/api/doc` | Self-hosted option | Local times without a zone in POST bodies |
| [ActivityWatch](https://docs.activitywatch.net/en/latest/api.html) | Local tracker of window titles and AFK, REST on port 5600 under `/api/0` (buckets, events, query) | "What was I doing at 3?" from facts, not memory | It runs on the desktop and binds to localhost **[unverified default]** |
| [Super Productivity](https://super-productivity.com/integrations/) | Open-source tasks + timeboxing; optional local REST API on `127.0.0.1:3876` in the desktop app | Tasks with time estimates | Desktop-only API |
| Sunsama, Motion | Guided daily planning and shutdown rituals | A fixed short ritual: yesterday, today's three, blockers | Long coaching dialogues |

**Evidence on pomodoro is weak.** A 2023 study of 87 students found fixed breaks reduced fatigue early on but ended
with similar productivity to self-chosen breaks (Biwer et al., British Journal of Educational Psychology)
**[unverified: read via a summary]**. So the module offers fixed and free lengths and makes no productivity claims.

## 3. Example conversations

S = a screen helps; works headless. "P" = personal; on the person's devices.

| # | Situation | Exchange | Note |
|---|---|---|---|
| 1 | Focus | Study: "Focus for 50 minutes on the report." → "Focusing until 10:40. Do not disturb is on here and on your phone, desk light set to focus." | `timer` pinned in Orbit; DND here + phone; HA scene. |
| 2 | Break | 10:40: soft chime, "Fifty minutes done. Take ten?" → "Yes." → "Break until 10:50." At 10:50: "Break's over. Another round on the report?" | Follow-up window without the wake phrase. |
| 3 | Pomodoro | "Start a pomodoro." → "25 minutes, then 5. Round one of four." | Defaults from settings. |
| 4 | Interrupted | (Doorbell during focus) the hallway announces as usual; the study stays quiet; at the break: "While you were focusing: the doorbell at 10:12, and Anna's message." | `critical` still interrupts (§9). |
| 5 | Time tracking | "Start tracking Acme, client call." → "Tracking Acme: client call, in Toggl." … "Stop." → "Stopped: 42 minutes on Acme." | Fast path; one API call each. |
| 6 | Ambiguous | "Stop." during a focus session and a running time entry → "Stop the focus session, the Acme timer, or both?" | `assistant-controls` "stop" goes to what is ringing or playing first; nothing rings here, so it asks. |
| 7 | Report | "How much did I work on Acme this week?" → "Eleven hours twenty, most of it Tuesday and Wednesday." | S: a `chart` per day. |
| 8 | What was I doing | "What was I working on before lunch?" → "From 9 to 12: the report focus session, 42 minutes of Acme, and the T3 thread 'fix login redirect'. ActivityWatch shows mostly VS Code and the Acme Jira board." | Facts from four sources, no guessing. |
| 9 | Capture | "Make a Linear issue: login redirect loses the query string." → "Create a Linear issue in team Web, 'Login redirect loses the query string'? It'll be visible to the team." → "Yes." → "Created WEB-312." | Outward-facing: read back and confirmed. |
| 10 | Capture, personal | "Add 'renew passport' to my to-do." → "Added to your to-do list." | Goes to [lists](lists.md), not here. |
| 11 | Morning plan, S | "Let's plan today." → "You have meetings at 10 and 14:30. Yesterday you left the report half done and two Acme issues open. What are your three things today?" → "Report, Acme invoice, gym." → "Got it. I'll check in at five." | `planning_start`; the plan is stored. |
| 12 | Failure | "Start tracking Acme." (Toggl quota hit) → "Toggl isn't accepting requests for a while. I'm timing it here and will send it to Toggl later." | Local entry + outbox. |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `focus_start` | `minutes?`, `mode?: "free" \| "pomodoro"`, `label?`, `rounds?`, `dnd?: boolean`, `scene?: dynamic` | end time, what was silenced | W | changes data | < 50 ms local + HA ~150 ms | yes |
| `focus_control` | `move: "pause" \| "resume" \| "extend" \| "skip_break" \| "stop"`, `minutes?` | new state | W | changes data | < 20 ms | yes |
| `focus_status` | — | current session, round, time left, today's total | R | safe | < 10 ms | yes |
| `track_start` | `project?: dynamic`, `task?: text`, `tags?`, `billable?: boolean` | the running entry | W | changes data | 150–500 ms (provider) | yes |
| `track_stop` | — | duration, project | W | changes data | 150–500 ms | yes |
| `track_report` | `project?`, `range?: text`, `group?: "day" \| "project"` | totals and series | R | safe (personal) | < 20 ms cache; 0.3–1 s fresh | yes |
| `activity_recall` | `from?: text`, `to?: text` | sessions, time entries, top apps and titles (ActivityWatch), T3 threads touched | R | safe (personal) | 0.2–1 s | no |
| `planning_start` | `kind: "morning" \| "review" \| "standup"` | gathered facts for the dialogue (agenda, yesterday's plan and entries, open issues) | R | safe (personal) | 0.3–1.5 s (several modules) | no |
| `planning_save` | `kind`, `items: text[]`, `notes?` | the stored plan or review | W | changes data | < 20 ms | no |
| `task_capture` | `text`, `target?: dynamic` (a configured tracker and project, default from settings), `description?`, `labels?` | the created issue id and URL | W | outward-facing (visible to others), **confirm** | 0.4–1.5 s | no |

Latencies are estimates, to be confirmed with `TurnTrace`. General assistants get `focus_*`, `track_start`,
`track_stop` and `track_report`. `activity_recall`, `planning_*` and `task_capture` are for a work assistant (§12).

## 5. Integrate or build

| Part | Options | Recommendation |
|---|---|---|
| Focus session | Build on the [timers](timers-and-alarms.md) Scheduler job plus [notifications](notifications.md) DND and [smart-home](smart-home.md) scenes | Build; a focus session is a labelled timer series with side effects |
| Phone DND | Android: HA companion `command_dnd` (`priority_only`, `alarms_only`, `total_silence`, `off`; needs DND access granted, a Samsung One UI 9 issue reported in [a 2026 thread](https://community.home-assistant.io/t/cannot-set-phone-to-dnd-through-companion-app-with-command-dnd/339227)). iOS: an HA notification that triggers a Shortcuts automation to set a Focus | Through the HA connection; iOS path is a documented owner setup step |
| Time tracking | Toggl Track v9 (`https://api.track.toggl.com/api/v9`, Basic `<token>:api_token`; start `POST /workspaces/{wid}/time_entries` with `duration: -1`, stop `PATCH /workspaces/{wid}/time_entries/{id}/stop`, `GET /me/time_entries/current` **[paths unverified]**); [Clockify](https://docs.clockify.me/) (`https://api.clockify.me/api/v1`, `X-Api-Key`, regional prefixes such as `euc1`; free plan rate limit read as 30/hour **[odd; verify]**); Kimai (Bearer; `GET /api/timesheets/active`, `PATCH /api/timesheets/{id}/stop` **[unverified]**); local log | A `TimeTracker` interface; **local log first**, Toggl and Kimai first providers. Cache the running entry locally; never poll Toggl (30/hour on Free) |
| What was on screen | ActivityWatch REST (`/api/0/buckets`, `/api/0/query`) on the desktop | Optional; needs the desktop's port reachable from the server (bind on the LAN with a firewall rule, or an SSH tunnel), §11 |
| Work trackers | [Todoist API v1](https://developer.todoist.com/api/v1/) (REST v2 shut down; `POST /api/v1/tasks/quick` natural language **[path unverified]**); Linear GraphQL `issueCreate` at `https://api.linear.app/graphql` with a personal key (no `Bearer`) **[unverified]**; Jira Cloud `POST /rest/api/3/issue` with an ADF description **[unverified]**; GitHub `POST /repos/{owner}/{repo}/issues` with a fine-grained token ([docs](https://docs.github.com/en/rest/issues/issues#create-an-issue)) | `TaskSink` interface; GitHub first (the owner already uses it, [t3-code](t3-code.md) §15), Linear and Jira when asked. Todoist stays a [lists](lists.md) backend |
| Planning | A prompt plus `planning_start` that gathers facts from calendar, time tracking, lists and t3-code | Build; no outside tool (Sunsama and Motion have no useful open APIs **[unverified]**) |

## 6. Data

| Collection | Scope | Fields | Read by others |
|---|---|---|---|
| `focus_sessions` | person | `label`, `mode`, `startedAt`, `plannedMin`, `rounds`, `endedAt?`, `interruptions[]`, `sideEffects` (DND ids, scene before/after) | export `focus.active(person)` for ambient lines and notifications |
| `time_entries` | person | `project`, `task?`, `start`, `stop?`, `provider`, `remoteId?`, `outbox?` | `planning`, `briefing` |
| `projects` | person | name, aliases, provider ids, default billable | — |
| `plans` | person | `date`, `kind`, `items[]` with `done?`, `notes`, `createdAt` | `briefing` ("your three things today") |
| `task_targets` | person | tracker, project or repo, team, labels, default | — |

Ambient line (person's own devices only): `Focus: "report" until 10:40 (round 2 of 4). Tracking: Acme 0:42.`

## 7. Long-running work and events

| Job | When | Missed while down |
|---|---|---|
| `focus-end` / `break-end` | one-shot at the end time | fire late if within 10 min; else end silently and restore DND and scene |
| `dnd-restore` | with every session end, and at start for sessions that should have ended | always runs; DND must not stick |
| `track-outbox` | every 60 s while not empty, with backoff on 429 | resumes |
| `track-sync` | every 15 min (Toggl) or 5 min (Kimai), and on demand | run once |
| `planning-checkin` (opt-in) | the time the person set ("check in at five") | skip if more than 30 min late |

**Events:** `focus.started`, `focus.ended`, `focus.break`, `time.entry.started`, `time.entry.stopped`,
`planning.saved`. **Listens to:** `notification.held` (to list what was held during focus at the break),
`t3.thread.updated` for `activity_recall`, `calendar.event.soon` (offer to end focus five minutes before a meeting).

## 8. Presentation

- **Focus:** a pinned `timer` (label, round dots) in Orbit; a dim, calm stage during focus. The character does an
  idle "concentrating" pose if it has one, and stays still otherwise (no idle chatter during focus).
- **Break:** a `card` "Break · 10 min" with Skip and Another round.
- **Reports:** a `chart` of hours per day or project; `activity_recall` as a `list` of time blocks.
- **Plan:** a `list` checklist of today's three things, pinned on the person's desk screen; ticking calls
  `planning_save` directly.
- **Headless:** chimes for start, end and break (bundled), one sentence each.

## 9. Notifications and proactive behaviour

During focus on that device and the person's phone: `low` and `normal` are held and listed at the break; `high`
(alarms the person set, timers) still ring; `critical` (smoke, leak) always interrupts. This is the notification
service's DND (shared state §8.2) with a `reason: "focus"`. Proactive lines: session end and break end (`normal` on
the session's device), a meeting in five minutes during focus (`normal`, only if calendar is on), and the opt-in
planning check-in. No "you've been idle" nudges.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | quiet hours (shared) | shared |
| Module `focus` | default length, pomodoro lengths (25/5, long break 15 after 4), DND on start, chime pack | 50; 25/5/15; on; soft |
| Module `time-tracking` | provider, workspace, sync interval | local |
| Module `planning` | check-in time, stand-up template | off; yesterday / today / blockers |
| Assistant | modules on/off; a "Work" template | off for household assistants |
| Device | focus scene (HA scene id) for this room; whether this device follows the person's focus | none; yes for the desk device |
| Person | phone DND method (Android command or iOS Shortcut), projects, task targets, ActivityWatch URL | none |

**Connections:** `toggl` (API token), `clockify` (key), `kimai` (URL, token), `github` (fine-grained token with
Issues write on chosen repos), `linear` (personal key), `jira` (site, email, API token), the HA connection, and an
`activitywatch` URL. **First run:** pick the time tracker, import projects, set the desk scene, test phone DND.

## 11. Native tools and dependencies

| Need | Where | Missing |
|---|---|---|
| ActivityWatch (`aw-server` + watchers) | the person's desktop, reachable from the server | `activity_recall` leaves it out and says "ActivityWatch isn't reachable; this is from my own log." |
| Home Assistant with the companion app | LAN / phone | "I can't set do not disturb on your phone; only here." |
| Provider accounts | internet / LAN | local log; outbox |

## 12. Interaction with the rest of the system

- **Speech:** project names are custom words: fuzzy match against `projects` aliases like wake phrases; unknown
  project → "I don't know a project 'Akme'. Did you mean Acme?". Issue titles are echoed in full before creation.
- **"Stop" ambiguity** (example 6) goes through [assistant-controls](assistant-controls.md): ringing or playing first,
  then a question.
- **Fast path:** focus start, stop, status, track start and stop are typed actions.
- **Assistants:** a **Work** template (concise, no small talk; focus, time tracking, planning, task capture, calendar,
  t3-code) for the study device. Household assistants get only focus.
- **Other modules:** notifications (DND), smart-home (scenes), timers (Scheduler only), calendar (agenda), lists
  (personal to-dos), t3-code (threads for recall), [briefing](briefing.md) reads `plans` and yesterday's time totals.

## 13. Privacy and safety

- Time entries, plans and ActivityWatch window titles are person-scoped and can contain client names and secrets in
  titles. `activity_recall` is answered only on the person's own devices and never sent to the model in full: the
  tool summarises to top apps and titles, capped, with titles from private-browsing windows dropped.
- `task_capture` into a shared tracker is outward-facing (colleagues see it): always read back and confirmed, and
  `deny` on shared devices by default (module definition §B.5, the `message` class fits best).
- Focus sessions change other people's experience only through scenes in the person's own room.
- Guests and children: focus only.

## 14. Foundations needed

Scheduler, Notification service with DND and held items, Tool context with the person, Module store, smart-home
scenes, Connection, risk classes with confirmation (for `task_capture`), Presentation (`timer`, `chart`, `list`).

**A useful first version without most of them:** focus sessions as a local countdown with a chime and the HA scene,
on one device, plus `track_start`/`track_stop` against Toggl with settings fields for the token. No DND, no
notifications, no planning.

## 15. Open questions

1. **Which tools do you use for time and tasks at work:** Toggl, Clockify, Kimai, none? GitHub issues, Linear, Jira?
2. **Phone DND:** Android or iPhone? On iPhone, will you set up the Shortcuts automation?
3. **ActivityWatch:** do you run it, and may the server reach it on the LAN?
4. **Planning ritual:** do you want a morning plan and an evening review at all, and at which times?
5. **Disagreement with [timers](timers-and-alarms.md):** should a focus session appear in "what timers are running?"
   (it is a countdown), or stay separate? This document proposes separate, with its own ambient line.
6. **Disagreement with [lists](lists.md) §5:** lists treats Todoist as a whole-list backend. Work trackers (Linear,
   Jira, GitHub) are one-way capture here, never read back as a list. Is that split right?
