# Timers and alarms

Research write-up, 2026-11-17. Not an approved design. It builds on the shared foundations named in
[README.md](README.md). The details of the store, scheduler and notification service are in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) (cited below as
"shared state §n"), and the stage and device rules are in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md) ("presentation
§n"). What exists today is in [`current-system.md`](../module-investigation/current-system.md).

## 1. Summary

The module counts down named timers ("set a pasta timer for ten minutes") and rings one-off and recurring alarms
("wake me at 6:45 on weekdays"). A timer is household data, not device data: it is set on one device, rings where it
was set, and can be asked about, extended or stopped from any other device and by any assistant. Screens show it as a
countdown pinned beside the character. Setting, asking and stopping must work without the language model.

- **Priority: first wave.** Timers and alarms are in the top five uses of every smart speaker
  ([Voicebot 2020](https://voicebot.ai/2020/05/03/streaming-music-questions-weather-timers-and-alarms-remain-smart-speaker-killer-apps-third-party-voice-app-usage-not-growing/)).
  They are also what broke when Alexa+ and Gemini for Home put an LLM in the way (landscape-voice-assistants.md,
  Summary).
- **Effort: M for the module, L in practice.** The module code is small. But it is the first user of the Module store,
  the Scheduler, the Notification service's ringing state and the `timer` presentation kind. Whoever builds it builds
  the first slice of each of those.

The package is `packages/module-timers` with two module ids, `timers` and `alarms`, so an assistant can have one
without the other. They share the ringing helper and the duration and time parsing.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Home Assistant voice timers ([chapter 7](https://www.home-assistant.io/blog/2024/06/26/voice-chapter-7/), [timers.py](https://raw.githubusercontent.com/home-assistant/core/dev/homeassistant/components/intent/timers.py)) | Named timers bound to the satellite that set them. Start, cancel (one or all), pause, add or remove time, status. A command can be delayed ("lights off in 10 minutes"). Matching goes by name, then area, then duration, and ties break by the asking device. | The matching rules. Device-bound ringing. "Stop" without a wake word, which is active only while a timer rings ([chapter 8](https://home-assistant.io/blog/2024/12/19/voice-chapter-8-assist-in-the-home), [chapter 10](https://home-assistant.io/blog/2025/06/25/voice-chapter-10)). | Timers are kept in memory and lost on restart. They are not entities, so no dashboard can list them ([community complaint](https://community.home-assistant.io/t/wth-cant-we-see-timers-set-by-voice-within-ha/1031095)). A delayed command cannot be cancelled. |
| Alexa | Multiple named timers. Alarms with music. Ascending alarm volume in the app's alarm settings ([Amazon help](https://digprjsurvey.amazon.com/csad/help/node/GJVZBYD6AKDC84ST)). A routine can start when an alarm is dismissed. Timers can be listed from any Echo. | The ascending volume ramp. Alarm dismissed as an event that starts a routine. | The [August 2025 UK outage](https://www.theregister.com/2025/08/14/alexa_hits_snooze_on_basic/) left alarms ringing that nobody could cancel. "By the way" upsells after a timer. |
| Google / Nest | Stopping a timer from another room shipped in [2020](https://9to5google.com/2020/09/18/stop-google-assistant-alarm-timer-any-room/). The Nest Hub's sunrise alarm brightens the screen and plays a pre-alarm sound a few minutes early ([TechHive](https://www.techhive.com/article/3631069/how-to-set-a-sunrise-alarm-on-a-google-nest-hub-display.html)). Music alarms were [removed in 2024](https://techcrunch.com/2024/01/11/google-is-removing-17-underutilized-assistant-features/). | The sunrise ramp (screen, sound, lights). "Stop" from any room. | Gemini for Home: missed and slow timers ([Gadget Hacks](https://android.gadgethacks.com/news/gemini-for-home-timers-and-alarms-claims-vs-reality/)). |
| HomePod | Multiple named timers and alarms, which guests may use ([Apple](https://support.apple.com/guide/homepod/apd1841a8f81)). | Timers need no identity. | — |
| OVOS `ovos-skill-alerts` | Alarms, timers and reminders in one skill with its own storage. | — | Every skill reinvented persistence. Missed alerts were a known gap (shared state §2.1). |

**Take-aways:** timers are household data that rings on its origin device. They are deterministic and local, and
listing and stopping work from anywhere. They survive restarts. An alarm can be a gentle multi-sensory ramp, and its
dismissal is an event other things can follow.

## 3. Example conversations

S = a screen helps; it works headless as well. **S!** = needs a screen.

1. Kitchen node: "Hey Jeff, set a pasta timer for ten minutes." → "Pasta, ten minutes." (A spoken echo of label and
   length catches recognition mistakes such as "fifteen" heard as "fifty".) The study laptop gets a pinned chip, S.
2. Study laptop, another assistant: "How long is left on the pasta?" → "Six minutes and ten seconds." The answer comes
   from the ambient facts (shared state §7), so it works for an assistant without the module.
3. Study: "Add five minutes to it." → "Pasta timer: eleven minutes left." "It" resolves to the only running timer.
4. Kitchen, two timers running: "Cancel the timer." → "You have two: pasta with four minutes left, and eggs with one.
   Which one?" → "Eggs." → "Eggs timer cancelled." Ambiguity is a question, never a guess.
5. Kitchen, the pasta timer is ringing, no wake phrase: "Stop." → the cue stops and the assistant says nothing more.
   Or "Five more minutes." → "Pasta, five more minutes." This is handled by the ringing window (shared state §8.4).
6. Bedroom node, 23:10: "Wake me at seven." → "Alarm set for seven tomorrow morning." 7:00 at 23:10 means tomorrow;
   "seven" alone is never 19:00 at night.
7. Bedroom: "Set an alarm for quarter to seven on weekdays, gentle." → "Weekday alarm at 6:45, starting quietly." At
   6:45 the cue starts at 20 % volume and ramps over 3 minutes. On a screen the stage brightens (sunrise), S. If Home
   Assistant is on, the bedroom lights fade up too.
8. Ambiguous, Dutch: "Zet een wekker om half acht." → 7:30, not 8:30 ("half acht" is half *to* eight). The parser
   must know this, and the echo ("Wekker om half acht, dat is 7:30") makes a mistake audible.
9. Failure: the kitchen node lost Wi-Fi when the pasta was due. The server rings the other devices in the kitchen. If
   there are none, it rings where the owner was last active and says "Your pasta timer went off on the kitchen speaker,
   which is offline." If the node holds a synced copy (§7), it rings by itself and reports later.
10. Failure, no music: "Wake me with jazz at seven." with no music module on → "Alarm set for seven. I can't play music
    yet, so it will use the normal alarm sound."

## 4. Tools

All are typed actions (`defineAction`), so each is both a tool (`<moduleId>_<actionId>`) and an intent for the Jev
path. Latency is the module's own work on an indexed SQLite row plus a scheduler wake-up. It should be well under 20 ms
(to be confirmed with `TurnTrace`; the turn itself is longer).

| Tool | Parameters | Returns (`say`) | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `timers_start` | `duration: Param.duration`, `label?: text`, `ring_on?: dynamic` (device or room; default the asking device) | "Pasta, ten minutes." | W | changes data | < 20 ms | yes |
| `timers_status` | `which?: dynamic` (label, "all") | remaining time per matching timer | R, speculative | safe | < 10 ms | yes |
| `timers_cancel` | `which?: dynamic` or "all" | "Eggs timer cancelled." / the question | W | changes data | < 20 ms | yes |
| `timers_adjust` | `which?`, `delta: Param.duration` (may be negative) | new remaining time | W | changes data | < 20 ms | yes |
| `timers_pause` / `timers_resume` | `which?` | "Paused with 4:10 left." | W | changes data | < 20 ms | yes |
| `timers_stop_ringing` | `where?: dynamic` ("the kitchen") | "Stopped the kitchen timer." | W | changes data | < 20 ms | yes (from another device) |
| `alarms_set` | `time: text` (parsed locally), `days?: choice` (once, weekdays, weekends, daily, or named days), `label?`, `sound?: choice` (built-in tones, `music` when a music module is on), `ramp?: boolean`, `on?: dynamic` | "Weekday alarm at 6:45." | W | changes data | < 20 ms | yes |
| `alarms_list` | `range?: choice` (next, today, tomorrow, all) | "Next alarm: tomorrow 6:45, weekdays." | R, speculative | safe | < 10 ms | yes |
| `alarms_cancel` | `which: dynamic` (time or label), `scope?: choice` (just next / for good) | confirmation | W | changes data | < 20 ms | yes |
| `alarms_skip_next` | `which?` | "Tomorrow's 6:45 is skipped; it rings again Thursday." | W | changes data | < 20 ms | yes |
| `alarms_snooze` | `minutes?: number` (default from settings) | "Snoozed nine minutes." | W | changes data | < 20 ms | yes (also via the ringing window) |

The `dynamic` params are filled from live data (running timers, devices, rooms), as the Home Assistant module does
today for lights. A deferred command ("turn off the oven in ten minutes") is **not** a timer tool. It belongs to
[routines](routines-and-automations.md) (a scheduled step), because it runs another module's action later and needs its
own missed-run rule (shared state §6.1, `deferred command`).

## 5. Integrate or build

| Option | For | Against |
|---|---|---|
| **Build on the Scheduler and Module store** | Local, under our latency budget, aware of devices, survives restarts, visible everywhere | We own DST, clock jumps and missed policies (shared state §6.2 already designs them) |
| Home Assistant `timer` helper entities through the HA module | Visible in HA dashboards | Needs HA. Not bound to our devices. A network hop. HA itself did not use them for voice timers |
| HA voice timers | — | Bound to HA satellites, in memory, not reachable through the REST API |
| Effect workflow and `DurableClock` | Durable sleeps | Rejected in shared state §2.2: cluster machinery, and "list / add five minutes / pause" are awkward |
| Phone clock apps (Shortcuts "Create Alarm", Android alarm intents) | Ring on the phone | No way to list or stop them from our devices; only an optional "also on my phone" target |

**Recommendation: build.** Optional mirrors can come later, for example a read-only HA sensor "next alarm" pushed
through the HA connection for HA automations. Sounds are bundled CC0 or self-made cue files. Music alarms use the music
module when one exists (none today).

## 6. Data

Both collections are in the Module store, scope `household` (shared state §4.3). Every row has `rev` and `updatedBy`
as `Actor`.

```ts
// Proposal, collection "timers" (household)
{ label?: string                 // "pasta"; absent = "timer"
  durationMs: number             // as set, for "the ten-minute timer" matching and for the echo
  dueAt: number                  // epoch ms; meaningless while paused
  pausedRemainingMs?: number
  state: "running" | "paused" | "ringing" | "done" | "cancelled"
  originDevice: DeviceId; originRoom?: string; ringOn?: { device?: DeviceId; room?: string }
  jobId: string; notificationId?: string; createdBy: Actor }

// Proposal, collection "alarms" (household; forPerson lets "my alarms" filter without a person scope)
{ time: "06:45"; days: ReadonlyArray<0|1|2|3|4|5|6> | "once"; date?: "2026-11-18"
  label?: string; sound: CueId | { music: string }; ramp: { fromPct: number; seconds: number } | null
  device: DeviceId; forPerson?: PersonId; enabled: boolean; skipUntil?: number; snoozedUntil?: number; jobId: string }
```

Done and cancelled timers are deleted after 24 hours. The change log keeps their history (shared state §4.2). Exports
for other modules: `timers.active` (label, dueAt, state, origin) and `alarms.next` (time, label, device). Ambient lines
(shared state §7): `Timers: pasta 6:10 left (kitchen), eggs 0:50 left (kitchen). Next alarm: tomorrow 06:45 (bedroom).`

## 7. Long-running work and events

**Jobs** (Scheduler kinds from shared state §6.1):

| Job | `at` | `onDue` | Missed while down |
|---|---|---|---|
| timer | `{ at: dueAt }` | `{ notify: { kind: "timer", priority: "high", ring: "origin-then-room", dedupeKey: "timer:<id>" } }`. Data only, so it rings even while the module restarts | `fire-late`, saying how late: "Your pasta timer went off three minutes ago." |
| alarm | `{ cron: "45 6 * * 1-5", timeZone: HOME_TIME_ZONE }` or `{ at }` for once | a `handler` (it needs the ramp and the music lookup), falling back to `{ notify }` | `{ fireIfWithinMs: 15 min }`, otherwise inbox: "You missed your 6:45 alarm; the assistant was restarting." |
| snooze | `{ inMs }` | same as the alarm | `fire-late` |

Paused timers have their job paused (`remainingMs`). "Add five minutes" is `reschedule` plus `Notifications.update`
when the timer is already ringing.

**Events published:** `timers.started`, `timers.adjusted`, `timers.paused`, `timers.resumed`, `timers.ringing`,
`timers.finished` (stopped or expired), `timers.cancelled`, `alarms.set`, `alarms.ringing`, `alarms.snoozed`,
`alarms.dismissed`. Routines listen to `alarms.dismissed` ("after my alarm, read the briefing") and to
`timers.finished`. **Listens to:** `notification.resolved` for its own notifications (a Stop on any device or on a
phone ends the timer row), and device online/offline for the offline-device rule.

**Restart:** jobs fire at the same wall-clock time. Timers due during downtime fire at start, marked late. A clock jump
(a Pi without an RTC syncing NTP after boot) triggers a re-check. DST cannot shift a 07:00 alarm, because alarms are
recomputed from local time (shared state §6.2).

**Device offline when it fires:** the ring policy goes to the next step: other devices in the origin room, then the
device where the owner was last active, plus the phone for alarms (see [notifications](notifications.md)). For voice
nodes, pending alerts are pushed ahead of time (`alerts.sync`, shared state §8.5), so a node that cannot reach the
server still rings its local copy and reports "rang locally, stopped at 07:02" on reconnect. **Server down:** only the
node-local copies ring. Browsers do not get a copy: a background tab's timers are throttled, so a page cannot be relied
on to ring by itself.

## 8. Presentation

- **Running timer:** the `timer` kind (presentation §3.2) with `lifetime: pinned`, in the **Orbit** layout: a small ring
  docked beside the character's box with the remaining minutes in mono type. Several timers stack (at most three shown,
  then "+2"). The device counts down from `dueAt`; the server sends no ticks. Touch gives Pause, +1 min, Cancel.
- **On idle:** the **Ambient** layout. Timers and the next alarm within 12 hours grow to glanceable size while the
  character dozes small in a corner (presentation §4.4).
- **Ringing:** the timer comes to the centre and the character holds it up (**Hold-up**). The label reads "Pasta, done",
  with large Stop, +5 min and Snooze buttons (at least 56 px). Characters that read the optional `stage.content`
  extension get `alert: true`: figures look at the timer, then at the person, and light characters pulse with the cue.
  There is no invented emotion (CHARACTERS.md §2.3).
- **Wake-up alarm on a screen:** a sunrise ramp. The screen brightness and background warm up over the ramp time (a
  host-level overlay, so every character works), the character slowly takes its normal mode, and the time is large.
  This needs the Screen Wake Lock in a kiosk tab.
- **Headless node:** no display. It plays the cue loop with a different tone for timer and alarm, then one spoken line
  when the output is free: "Pasta timer is done." The ringing window opens. A missed item is said once at the next
  wake: "Before that: your eggs timer went off while I couldn't reach you."
- **Spoken numbers:** "six minutes and ten seconds" below ten minutes, "about 25 minutes" above, and an end time
  instead of a duration above an hour: "It ends at 14:40."

## 9. Notifications and proactive behaviour

| Event | Priority | Where | Quiet hours / DND |
|---|---|---|---|
| Timer due | `high` | `origin-then-room` | rings, because the person set it during that time; visual only on a screen with DND on |
| Alarm due | `high`, `requireAck` | its device, plus the phone after 2 minutes unacknowledged (proposal) | always rings: the alarm is the point |
| Ringing unacknowledged for 10 min | — | becomes `missed` in the inbox | — |
| Alarm in the next 12 h but the bedroom node is offline at 22:00 | `normal` | the owner's last device or phone: "Your 6:45 alarm is on the bedroom speaker, which is offline." | waits until quiet hours end only if the alarm is after them |

Escalation to every device stays off for timers by default (shared state §8.3). The module never speaks unprompted
for anything else.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | quiet hours (shared); "a timer may ring everywhere after N s" (off) | 22:00-07:00; off |
| Module `timers` | default cue; ring length before "missed" (10 min); echo style (label + length / short beep) | `chime-1`; 10 min; label + length |
| Module `alarms` | default tone; snooze minutes (9); ramp default (on, 20 % → 100 % over 180 s); phone escalation after N s (120) | as stated |
| Assistant | module on/off, `offTools` (exists) | on for every assistant |
| Device | volume floor for cues (a cue must be audible even when TTS volume is low); "alarms on this device" allowed | 60 %; on |
| Person | default alarm device ("my alarm" = bedroom node), snooze length | — |

No secrets and no connections. **First run:** none. Optionally the owner picks a room per device (presentation §5.3),
which gives "the kitchen timer" its meaning.

## 11. Native tools and dependencies

None on the server beyond the store. The cue files ship in the web bundle and with the node client. A browser
**cannot start audio until the page has had a user gesture**
([Chrome autoplay policy](https://developer.chrome.com/blog/autoplay)). A kiosk tab that has claimed the microphone
already has a running `AudioContext`, but a freshly reloaded tab may not. The page must report `audio: locked` in its
live state. The server then treats the device as visual-only for ringing, and the page shows "Tap to enable alarm
sounds".

Music alarms need a music module and a player on the device (`mpv` on a node; module-definition-config-and-dependencies.md
§C.1), which is not there today. Light ramps need the Home Assistant connection. When either is missing, the alarm still
rings with the built-in tone. When set, the assistant says: "I can't play music for alarms yet, so it will use the
normal alarm sound."

## 12. Interaction with the rest of the system

- **Speech recognition quirks:** "fifteen" and "fifty", "a minute and a half", "half an hour", "an hour and a quarter";
  in Dutch "kwartier", "anderhalf uur", "half acht" (7:30) and "kwart voor zeven". Core's `parseDuration`
  (`packages/core/src/ValueParsing.ts:619`) is the base. It needs a time-of-day parser too, with the Dutch "half"
  rule, and tests per language. The spoken echo is the safety net.
- **Fast path:** the actions carry `examples` in English and Dutch for the keyword decider and Jev. That path is BUILT,
  NOT WIRED (current-system.md §2.4, §3.3). Until it is wired, timers go through the model, so the first "set a timer"
  costs a full LLM round trip. Measure it with `TurnTrace` (`llmFirstToken`) on and off once Jev is wired. The ringing
  window never uses the model.
- **Fillers:** none needed. The action's `announce` ("Pasta, ten minutes.") can be synthesised during a speculative
  turn and plays the moment the turn commits.
- **Interruption:** a cue plays locally in a loop and does not take the output lease. The spoken line waits for the
  running reply to finish its clause (priority `high`, shared state §8.2). Barge-in during the spoken line stops the
  line, not the timer.
- **Assistants:** every assistant should have `timers` on. There is no assistant template. Alarms are worth switching
  off for a children's assistant. Wake routes: none needed; the ringing window is the exception to the wake phrase.
- **Other modules:** kitchen recipe steps start step timers through `timers_start` with the step text as label.
  [Reminders](reminders.md) owns "remind me in ten minutes to…" (a message for a person, not a countdown). The rule
  for the model's instructions: a task said with the time is a reminder, a bare duration is a timer.
  [Routines](routines-and-automations.md) listen to `alarms.dismissed`. Music and Home Assistant are optional alarm
  outputs.

## 13. Privacy and safety

- Timers are household data, visible on every screen. That is the owner's requirement. Labels are rarely personal; a
  label such as "pills" is shown as is.
- Alarms show the time and label on the screen of the device they ring on. Other screens show "Bedroom alarm 6:45"
  only when the household setting "show other rooms' alarms" is on (default off).
- Anyone may stop a ringing timer or alarm. A TV saying "stop" can at worst stop a ring (shared state §8.4). Cancelling
  a recurring alarm "for good" from a device other than the alarm's own asks for a repeat: "Cancel the weekday alarm
  for good? Say 'yes, cancel it'." That is a module-level question, because core confirmations are off.
- Children and guests: no restriction on timers. Alarms follow the person's policy once people exist.

## 14. Foundations needed

Module store (both collections), Scheduler (all jobs), Notification service (ringing, the ringing window, `Announce`,
inbox, quiet hours), Tool context (origin device and room), Event bus (`timers.*` to the screens), Presentation (the
`timer` kind, Orbit, Ambient, Hold-up) and Device capabilities (speaker, display, `audio: locked`).

**A useful first version without all of them:** Module store + Scheduler + Tool context, plus a minimal
`notification.ring { id, cue, title, until }` message to the origin device, with a local cue loop, a plain card and a
Stop button, and the spoken line through a recorded `Announce`. The ringing window can follow a week later. Leave out
the phone, escalation, `alerts.sync`, the sunrise ramp and music. Without the Module store and Scheduler there is no
useful version, because in-instance memory is split per instance and lost on every settings save
(current-system.md §1.3).

## 15. Open questions

1. **Ring where it was set, or follow the person?** The default here is origin, then its room, then the last active
   device. Should an unacknowledged timer widen to every device after a minute (shared state open question 3)?
2. **"Stop" and "five more minutes" without the wake phrase** while ringing: acceptable, including from a TV in the
   same room?
3. **Who owns an alarm:** a device ("the bedroom alarm") or a person ("my alarm", rings on their default device or
   phone)? The schema above supports both. Which should "my" mean by default?
4. **Phone escalation for alarms:** ring the phone too if nobody stops the bedroom alarm within two minutes?
5. **Node-local copies (`alerts.sync`):** worth building in the first node release, or accept that nothing rings while
   the server is down? Disagreement noted: landscape-automation-platforms.md §13.10 calls timers in device firmware a
   mistake. I agree for the *state*. A cached copy whose truth stays on the server is a different thing, and the
   2025 Alexa outage argues for it.
6. **Naming mismatch to settle:** presentation §3.3 calls the end time `endsAt`, and shared state §4.4 calls it
   `dueAt`. This document uses `dueAt` in data and would map it to `endsAt` in the presentation. Pick one.
7. **Fast path before Jev:** wire the Jev intent path first so that timers never wait on the model, or ship timers
   through the model first and measure?
8. **Gentle wake details:** default ramp length, and is a light fade-up through Home Assistant wanted?
