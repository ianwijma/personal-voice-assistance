# Health and fitness (habits, medication, wellbeing sessions, workouts, activity data)

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
the store, scheduler, events, notifications and tool context in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) ("shared state
§n"), presentation and device places in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md) ("presentation
§n"), connections and risk classes in
[`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)
("module definition §n"). Outside facts were checked on 2026-11-18. Anything not confirmed is marked **[unverified]**.

## 1. Summary

Two modules in one package, `wellbeing` and `fitness`, like `timers`/`alarms`:

- **`wellbeing`:** habit streaks ("did I stretch today?"), hydration ("log a glass of water"), a **medication schedule**
  with a spoken confirmation per dose and a missed-dose escalation, a mood and symptom journal with a score, and
  **breathing and meditation sessions** led by voice.
- **`fitness`:** **guided interval and strength workouts** with spoken cues and on-screen timers, a workout log, and
  read-only summaries from Strava, Garmin, Withings, Apple Health exports, Health Connect via Home Assistant, and HA
  sensors (steps, weight, sleep).

**This module gives no medical advice.** It records, reminds and summarises. It does not diagnose, interpret
symptoms, suggest doses, or say whether a missed dose should be taken (§13). Health data is special-category personal
data under the GDPR ([Art. 9](https://gdpr-info.eu/art-9-gdpr/)) and is person-scoped everywhere.

**Boundaries.** Plain "remind me to take my pills at eight" stays a [reminder](reminders.md). The medication schedule
here adds a dose log, a stock count and escalation. Free-text journal entries stay in
[memory-and-notes](memory-and-notes.md); this module stores only scored entries (mood 1–5, a symptom with a
severity). Workout intervals use their own session engine and render as `timer`/`steps`; they are not household
[timers](timers-and-alarms.md), because a workout would create dozens. Sleep sounds stay in
[fun-and-ambient](fun-and-ambient.md).

- **Priority: second wave** for habits, hydration, medication and breathing (all local, high daily value); **second
  wave** for guided workouts (they test the Presentation `steps`/`timer` kinds and on-device cue timing); **later**
  for outside data, where APIs are shifting (Fitbit's Web API was shut down on 2026-11-02, §5).
- **Effort: L overall.** `wellbeing` M (medication escalation and privacy are the work). Guided workouts M. Each data
  source S–M.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa | Medication reminders with "did you take it?" and Alexa Together caregiver alerts for missed activity **[unverified: Alexa Together was wound down in 2024]** | The confirmation question; a caregiver contact | A paid caregiver service that disappears |
| Apple Health / Medications (iOS 16+) | Medication list with schedules, "taken/skipped" log, interaction warnings, follow-up reminders **[from memory]** | Taken / skipped as two outcomes; a follow-up after 30 min | Drug interaction advice is a medical-device feature; not for us |
| Google Fit / Fitbit | Daily goals and streaks; Fitbit Web API and OAuth turned off on 2026-11-02, replaced by the Google Health API with restricted scopes that need a security review ([Google](https://developers.google.com/health/about)) | — | Building on a platform that is moving under us |
| Headspace, Calm | Voice-led breathing and meditation with timed pauses | Silence is part of the session; short spoken cues | Long scripted talk |
| Peloton, Fitbod, Seven | Interval and strength workouts with countdowns, "3, 2, 1", next exercise preview, rest timers | Preview the next exercise during rest; big countdown on screen | Music licensing; subscriptions |
| [wger](https://wger.readthedocs.io/en/stable/api/api.html) | Self-hosted workout manager: exercises, routines, logs, weight, nutrition; REST at `/api/v2/` with JWT | Exercise database (names, muscles, images) and a routine model | — |
| [Habitica](https://github.com/HabitRPG/habitica/wiki/API-Usage-Guidelines) | Habits and dailies with streaks; `x-api-user`/`x-api-key` | Habit vs daily distinction | Gamification for the household by default |
| Home Assistant | [Withings](https://www.home-assistant.io/integrations/withings/) (webhook, sleep, weight), Garmin via HACS ([`cyberjunky/home-assistant-garmin_connect`](https://github.com/cyberjunky/home-assistant-garmin_connect)), Oura via a custom integration, Health Connect data via the companion app ([forum](https://community.home-assistant.io/t/health-and-fitness-data-into-home-assistant-ha-companion-app-and-health-connect/905477)) | HA as the aggregator for sensors the household already has | Health data in HA's history is readable by every HA user |

**Take-aways:** the valuable parts are local and simple (a dose log with a follow-up, a streak, a timed session). The
outside data APIs are fragile and partly closed, so they come last and read through aggregators where possible.

## 3. Example conversations

S = a screen helps; works headless too. **S!** = needs a screen. "P" = personal: only on the person's devices.

| # | Situation | Exchange | Note |
|---|---|---|---|
| 1 | Dose due, P | 08:00, Ian's bedroom node: "Ian, time for your morning medication." → "Taken." → "Logged at 08:02. Twelve tablets left; I'll remind you to reorder at five." | The medicine name is spoken only on `private` devices (§13). |
| 2 | Missed dose | No answer by 08:30 → repeat on the device and phone. By 09:30 → "Ian, you haven't confirmed your morning medication." By 10:00, if set up → a phone notification to Anna: "Ian hasn't confirmed his morning medication." | Escalation ladder (§9), only with Ian's consent. |
| 3 | Advice refused | "I forgot my pill yesterday, should I take two today?" → "I can't advise on doses. The leaflet or your pharmacist can tell you; I've logged yesterday's as missed." | Medical-advice limit. |
| 4 | Habit | "I did my stretching." → "Stretching done. That's six days in a row." "How's my water today?" → "Five glasses of eight." | Fast path. |
| 5 | Breathing, S | "Let's do two minutes of box breathing." → "Breathe in, two, three, four… hold… out… hold…" with a growing and shrinking circle | Cues are timed on the device (§12). |
| 6 | Interval workout, S | "Start a 20-minute HIIT." → "Eight rounds: 40 seconds work, 20 rest. First: jumping jacks. Three, two, one, go." … "Rest. Next: squats." "Pause." → "Paused." "Skip this one." → "Skipping lunges. Next: push-ups." | `steps` + `timer`; "pause/next/skip" without the wake phrase during the session. |
| 7 | Strength log | "Log three sets of eight squats at sixty kilos." → "Logged: squats, 3 × 8 at 60 kg. Last time was 55." | |
| 8 | Data summary, P | "How did I sleep?" → "Seven hours ten, in bed at 23:40. That's from Withings, last night." "How far did I run this week?" → "Two runs, 14.2 km on Strava." | Source and time said. |
| 9 | Symptom journal, P | "Log a headache, about a four out of ten, since lunch." → "Logged a headache, 4 of 10, from about 13:00." "Have I had many this month?" → "Three, all in the afternoon." | Counts only; no interpretation. |
| 10 | Ambiguous | "Remind me about my vitamins." → "A daily vitamin at a fixed time, logged like your medication, or just a one-off reminder?" | Medication schedule vs reminder. |
| 11 | Failure | "How many steps today?" (Garmin login broken) → "I can't reach Garmin right now; the last count was 6,200 at 14:00." | |
| 12 | Shared device | Kitchen: "What medication does Ian take?" → "I only talk about Ian's health on his own devices." | §13. |

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `habit_done` | `habit: dynamic`, `amount?: number` (glasses), `when?: text` | streak, today's progress | W | changes data | < 20 ms | yes |
| `habit_status` | `habit?`, `range?: "today" \| "week" \| "month"` | progress, streaks | R | safe (personal) | < 10 ms | yes |
| `habit_set` | `name`, `target?: text` ("8 glasses a day", "3 times a week"), `remind?: text` | the habit | W | changes data | < 20 ms | no |
| `meds_taken` | `which?: dynamic` (default the dose just announced), `at?: text`, `skipped?: boolean`, `reason?` | log row, stock left | W | changes data | < 20 ms | yes |
| `meds_status` | `range?: "today" \| "week"` | doses taken, missed, next due | R | safe (personal) | < 10 ms | yes |
| `meds_schedule_set` | `name`, `dose_text: text` (as on the label), `times: text`, `stock?: number`, `refill_at?: number`, `escalate_to?: person` | read-back of the schedule | W | changes data, **confirm** | < 20 ms | no |
| `mood_log` / `symptom_log` | `score: 1–5` or `symptom: text`, `severity?: 0–10`, `since?: text`, `note?` | log row | W | changes data | < 20 ms | yes |
| `journal_trends` | `kind: "mood" \| "symptom"`, `range` | counts and averages, no interpretation | R | safe (personal) | < 20 ms | no |
| `session_start` | `kind: "box" \| "4-7-8" \| "coherent" \| "body-scan" \| "silent"`, `minutes` | a session plan sent to the device | W (session) | safe | < 20 ms | yes |
| `workout_start` | `plan?: dynamic` (saved or wger routine), `kind?: "hiit" \| "tabata" \| "strength" \| "stretch"`, `minutes?`, `level?` | the plan; shows `steps` + `timer` | W (session) | safe | < 30 ms | yes |
| `workout_control` | `move: "pause" \| "resume" \| "next" \| "skip" \| "repeat" \| "stop" \| "longer_rest"` | new state | W (session) | safe | < 10 ms | **yes, must** |
| `workout_log` | `exercise: dynamic`, `sets?`, `reps?`, `weight?`, `distance?`, `duration?` | log row, previous best | W | changes data | < 20 ms | yes |
| `fitness_summary` | `metric: "steps" \| "distance" \| "activities" \| "weight" \| "resting_hr"`, `range` | value, source, as-of time | R | safe (personal) | < 20 ms (cache) | yes |
| `sleep_summary` | `night?: text` | duration, bed and wake time, source | R | safe (personal) | < 20 ms (cache) | yes |

Latencies are estimates for the local store and caches; to be confirmed with `TurnTrace`. General assistants get
`habit_done`, `habit_status`, `meds_taken`, `meds_status`, `session_start` and `fitness_summary`. A **Coach** template
(§12) gets the workout tools.

## 5. Integrate or build

**Build** habits, medication, journal scores, sessions and the workout engine: all local, small, and voice-specific.
Use **wger** optionally as the exercise library and routine store. **Integrate** outside data read-only:

| Source | Access (checked 2026-11-18) | Verdict |
|---|---|---|
| [Strava API v3](https://developers.strava.com/docs/rate-limits/) | OAuth, `activity:read_all`; 200 requests/15 min and 2,000/day; new apps are "Single Player Mode" (own data only); webhooks via `POST /api/v3/push_subscriptions` ([docs](https://developers.strava.com/docs/webhooks/)). Terms restrict showing data to anyone but the athlete, and reports disagree on whether passing data to an AI model is allowed ([TechRepublic](https://techrepublic.com/article/news-strava-api-scraping-crackdown), [Terra](https://tryterra.co/blog/strava-api-changes-2026)) **[unverified: current wording]** | Read the [API agreement](https://www.strava.com/legal/api) before building; a summary spoken by an LLM may be out of terms |
| Garmin | Connect Developer Program has a Personal track with a personal API key, pull-only, activity and health ([Garmin](https://developer.garmin.com/gc-developer-program/overview/)). The unofficial `garth` library is deprecated after an auth change ([docs](https://garth.readthedocs.io/)) | Personal track first; HA's Garmin HACS integration as fallback |
| Fitbit | Web API and OAuth turned off 2026-11-02 (HTTP 410); successor Google Health API v4 with restricted scopes needing a review ([Google](https://developers.google.com/health/about)) | Skip direct; read via Health Connect on the phone if needed |
| [Withings](https://developer.withings.com/llms.md) | Free Public API app, OAuth2, `Measure v2 Getmeas` (`user.metrics`), `Sleep v2 Getsummary` (`user.activity`), notifications. EU company, EU cloud | Good first direct source (scales, sleep mats) |
| Apple Health | No server API. [Health Auto Export](https://github.com/Lybron/health-auto-export/wiki) (paid automations) POSTs JSON to a REST endpoint; or the manual `export.xml` | An inbound hook endpoint of ours (notifications module hooks) |
| Android Health Connect | On-device only; forwarded by the HA companion app ([forum](https://community.home-assistant.io/t/health-and-fitness-data-into-home-assistant-ha-companion-app-and-health-connect/905477)) | Read via HA |
| Home Assistant sensors | Steps, weight, sleep from the integrations above | First provider: one adapter, many sources |
| [Open Wearables](https://openwearables.io/wearable-api) | MIT, self-hosted aggregator (FastAPI, Postgres, Redis) for Garmin, Oura, Polar, Apple Health, Withings, Strava, Google Health | Worth a look if several wearables are in use; vendor-written docs |
| [Nightscout](https://npmjs.com/package/nightscout) | Glucose, REST `/api/v1/entries.json` with `api-secret` | Only if someone in the household uses it; read-only, never alerts of ours (their app alerts) |

**Recommendation:** build `wellbeing` and the workout engine first; then a `HealthSource` interface with **Home
Assistant sensors** first, Withings second, Strava (if its terms allow) and Garmin Personal third, Apple Health via an
inbound hook. No direct Fitbit or Google Health.

## 6. Data

All collections are **person** scope (shared state §4.3), never household.

| Collection | Fields |
|---|---|
| `habits` | `name`, `aliases[]`, `target` (`{ count, per: "day" \| "week" }`), `unit?` ("glass"), `remindRrule?`, `createdAt` |
| `habit_log` (ledger) | `habitId`, `amount`, `at`, `actor`, `undoes?` |
| `medications` | `name`, `doseText` (as on the label, never computed), `times` (RRULE per dose), `stock?`, `refillAt?`, `escalation` (`{ repeatMin, phoneAfterMin, personAfterMin?, personId? }`), `spokenLabel` ("morning medication") |
| `dose_log` (ledger) | `medicationId`, `scheduledAt`, `state` (`taken`, `skipped`, `missed`), `confirmedAt?`, `deviceId`, `actor` |
| `journal_scores` | `kind` (`mood`, `symptom`), `score` or `symptom` + `severity`, `since?`, `note?`, `at` |
| `workouts` / `workout_log` | plans (`steps[]` with `exercise`, `workSec`, `restSec`, `reps?`) and log rows |
| `health_cache` | per source and metric: daily values, last sync, source status |

Exports: `wellbeing.dueToday(person)` for [briefing](briefing.md) ("two doses today"), and no ambient line on shared
devices. Retention: logs kept until the person deletes them; export as CSV and JSON from the person's admin page.

## 7. Long-running work and events

| Job | When | Missed while down |
|---|---|---|
| `dose-due` per scheduled dose | one-shot at each dose time, next scheduled on resolution (RRULE, as in reminders §5) | fire late with "a bit late"; never more than one per dose |
| `dose-escalate` | at each step of the ladder until taken or skipped | continue the ladder from the current time |
| `refill-check` | after each `meds_taken` and daily | run once |
| `habit-remind` (opt-in) | per habit RRULE | skip if late |
| `source-sync` | Withings and Strava on webhooks; Garmin Personal every 30 min; HA via the event stream | run once at start |
| `session` / `workout` | no server jobs; the device runs the cue schedule (§12) | a session in progress at a restart ends; the device says "the session ended early" |

**Events:** `wellbeing.dose.due`, `wellbeing.dose.taken`, `wellbeing.dose.missed`, `wellbeing.habit.done`,
`fitness.workout.finished`. **Listens to:** `notification.resolved` (a "Taken" button on the phone), HA state changes
for configured sensors.

## 8. Presentation

- **Dose due:** a `confirm`-style card with Taken and Skip; the character holds it up (presentation §4.1).
- **Breathing:** a dedicated animation is not in the kind catalogue. Proposal: `progress` with a `breath` style
  (inhale, hold, exhale, hold durations), rendered as a growing and shrinking circle; on characters that support
  `stage.content` (presentation §4.2) the character itself breathes. This is a catalogue extension and needs the
  owner's approval (§15).
- **Workout:** `steps` (current exercise, next preview, round 3 of 8) with a large `timer`, in the Companion layout.
- **Summaries:** `chart` (weekly steps, weight trend) and `facts` (sleep: duration, in bed, up).
- **Headless:** all of the above by voice. Countdown cues ("three, two, one") and the interval tones are bundled audio
  files played by the device, not TTS (§12).

## 9. Notifications and proactive behaviour

| Case | Priority | Where | Quiet hours |
|---|---|---|---|
| Dose due | `normal`, `requireAck` | the device where the person was last active, else their default devices, else the phone | a dose scheduled in quiet hours rings: the person chose that time |
| Not confirmed after 30 min (default) | `normal`, repeated | same, plus the phone | as above |
| Not confirmed after 2 h | `high` to the person's phone; optional `normal` to a chosen second person ("Anna") | phone | yes, if the person set it up |
| Refill due | `low` | inbox and phone | — |
| Habit reminder (opt-in) | `low` | person's devices | inbox |

The second-person step is off by default, needs the patient's own consent in their settings, and says only "hasn't
confirmed his morning medication", never the medicine. There are no unprompted health comments ("you slept badly").

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | quiet hours; emergency number spoken in the medical-limit answer | shared; 112 |
| Module `wellbeing` | escalation ladder defaults (30 min, 2 h); refill threshold; habit presets (water 8 glasses) | as stated |
| Module `fitness` | sources and their connections; cue sound pack; rest defaults; wger URL and token | none |
| Assistant | module on/off; Coach template | on for general assistants (wellbeing), off (fitness) |
| Device | "announce medication here" (bedroom node); `privacy` decides if medicine names are said | off; from presentation §5 |
| Person | medications, habits, escalation person (with consent), sources, which devices may speak health data | none |

**Connections:** `withings` (OAuth2), `strava` (OAuth), `garmin` (personal API key), `wger` (token), the HA
connection. Apple Health needs a per-person inbound hook token. **First run:** per person, add medications by typing
on a screen (names are badly recognised by speech), set dose times, choose the escalation, pick sources.

## 11. Native tools and dependencies

None on the server beyond npm. Cue audio files are bundled with the front end and the voice node. Missing source:
"Garmin isn't connected; I can only tell you about workouts you logged with me." Missing screen for a workout: the
workout runs by voice only ("I'll call out each exercise").

## 12. Interaction with the rest of the system

- **Cue timing.** A server round trip plus TTS per cue would drift and lag (an estimate; to be measured with
  `TurnTrace`). Proposal: the server sends the whole session plan (`[{ atMs, cue, say? }]`) once, the device plays
  pre-rendered TTS clips and bundled tones on its own clock, and reports progress back. This needs a new protocol
  message (`session.plan`), which is a contract change to raise in `docs/ARCHITECTURE.md` terms.
- **Follow-up without the wake phrase** during a workout or session ("pause", "next", "stop"), like cooking
  ([kitchen](kitchen.md) §12), with barge-in handled by assistant-controls.
- **Speech:** medicine names are entered on screen, not by voice. Numbers: "drie keer acht" (3 × 8), "zestig kilo".
- **Assistants:** a **Coach** template (upbeat, short sentences, fitness tools, wellbeing read tools) and a calm
  **Breathe** persona for sessions are suggestions. The medical-limit instruction is in the module's stable
  instructions, not the persona, so every assistant gets it.
- **Other modules:** [reminders](reminders.md) for plain one-off reminders; [memory-and-notes](memory-and-notes.md)
  for free-text journal entries; [smart-home](smart-home.md) to dim lights for a session (owner routine);
  [briefing](briefing.md) reads `dueToday`; [calendar](calendar.md) not used.

## 13. Privacy and safety

- **Medical-advice limit**, enforced in the instructions and in tool results: the module records and summarises. It
  never interprets symptoms or numbers, never suggests doses or catching up, never changes a schedule except by the
  person's explicit, read-back confirmation (`meds_schedule_set` is `confirm`). Questions about health get a
  referral: the leaflet, the pharmacist, the GP; in the Netherlands [Thuisarts.nl](https://www.thuisarts.nl/) for
  general information; 112 in an emergency. Escalation is a convenience, not a safety system, and the setup screen
  says so.
- **Sensitivity:** all data is person-scoped special-category data. On `shared` and `public` devices the module says
  only the neutral label ("your morning medication") and nothing about symptoms, weight or sleep. Voice identity never
  unlocks health data.
- **Children:** a parent may set a child's medication; the child's prompts use the neutral label.
- **Guests:** no access.
- **Outside data:** sources are read-only; nothing is written back to Strava, Garmin or Withings. Sending health
  summaries to the hosted language model is a disclosure; the person opts in per source.

## 14. Foundations needed

Module store (person scope), Scheduler, Notification service with `requireAck`, escalation and phone channel, Tool
context with the person, `Person` records, Device capabilities with `privacy`, Presentation (`steps`, `timer`,
`chart`, `facts`, `confirm`), Connection, risk classes with confirmation, a fast path for session controls.

**A useful first version without most of them:** habits and hydration plus breathing sessions on one device, stored
in a JSON file, no notifications; then medication once the scheduler and ringing from the timers first version exist.

## 15. Open questions

1. **Medication by the assistant at all?** It is the most useful and the most risky part. Is a convenience reminder
   with a log acceptable to you, knowing it is not a medical device?
2. **Second-person escalation:** do you want it, and to whom?
3. **Which wearables and scales does the household use?** This decides whether HA sensors are enough.
4. **Strava terms:** if they forbid passing data to an LLM, should Strava be skipped or summarised without the model?
5. **Breathing animation:** extend the Presentation catalogue with a `breath` style, or keep `progress`?
6. **Disagreement with [reminders](reminders.md) §6 and §15 question 7:** reminders proposes "nag" reminders for pills.
   This document proposes that anything taken on a schedule with a count lives here, and reminders keeps nagging only
   for ordinary tasks. Agree?
7. **Disagreement with [timers](timers-and-alarms.md):** workout intervals are not household timers. Should "how long
   left?" on another device still see the workout through an ambient fact?
