# Emergency and safety

Research write-up, 2026-11-18. Not an approved design. Code references are `main` at `70b15ec`. Shared foundations
are named as in [`README.md`](README.md) and linked, not redesigned. Claims marked **[unverified]** or **[from
memory]** were not confirmed in a primary source during this session. Nothing here is legal or medical advice.

## 1. Summary

"Hey Jeff, call for help": alerting the right people, in order, until one of them answers; daily check-ins for an
elderly or solo person that escalate when nobody responds; relaying smoke, CO, gas and water-leak alarms from Home
Assistant to every device and phone; and a spoken medical-information card. It also defines what the assistant must
never promise: it is **not** an emergency-services device, not a certified social alarm and not a medical device, and
it says so in setup and, briefly, when help is asked for.

**Boundaries.** Delivery, priorities and phone channels are the **Notification service** and the
[notifications](notifications.md) module (critical pushes via the HA companion app, ntfy, SMS through
[messaging](messaging.md)'s gateway). Sensor events come from [smart-home](smart-home.md#9-notifications-and-proactive-behaviour),
which already marks smoke, CO, moisture and gas as `critical`; this module owns the household-wide *policy* for them
(everyone, every phone, repeat until acknowledged, fixed wording). Who to alert comes from [contacts](contacts.md)
(emergency contacts, `RELATED;TYPE=emergency` on import). A responder talking back uses
[calls-and-intercom](calls-and-intercom.md). Saying "stop" stays in [assistant-controls](assistant-controls.md).

- **Priority: second wave** for "call for help", escalation and check-ins (they need a working phone channel and
  contacts first); the **alarm relay is first wave**, delivered with smart-home's event rules and the notification
  service, because it is a small policy on top of them.
- **Effort: M**, or **L** with check-ins, the SMS path and the self-test. The help flow and chain are M; the alarm
  policy S; the medical card S; check-ins M; the offline path (fast path plus SMS gateway) S–M on top of their
  modules.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa Emergency Assist | US-only subscription, $5.99 a month, "Alexa, call for help" connects to a 24/7 Urgent Response agent who can dispatch services, plus emergency contacts notified ([Tom's Guide](https://www.tomsguide.com/news/alexa-emergency-assist-what-it-is-how-much-it-costs-and-how-it-could-save-your-life), [TechCrunch](https://techcrunch.com/2023/09/20/users-can-access-emergency-services-with-alexa/)). | "Call for help" as the phrase; contacts notified in parallel. | Implying a staffed service where there is none. We have no agent and must say so. |
| Alexa Together / Care Hub | Remote caregiving: activity feed, alerts on no activity, $19.99 a month; no longer available per Amazon's note dated 21 May 2025, users pointed to Emergency Assist ([Amazon](https://www.aboutamazon.com/md/news/devices/alexa-together-is-helping-bridge-the-miles-between-families)). | Inactivity alerts as a check-in signal. | Building a caregiving product that a vendor could not sustain; keep ours small and household-run. |
| Social alarms (EN 50134 series) | Certified systems for people at risk: 24 h alarm triggering, transmission, an alarm receiving centre, two-way speech ([EN 50134-1 sample](https://cdn.standards.iteh.ai/samples/2488/f955e7cde0b14b6c88af20678d6aa4a5/SIST-EN-50134-1-2003-EN-.pdf)); Part 7's guidelines do not cover informal arrangements between an individual and family ([DIN EN 50134-7](https://6sku3uaup9f9.din.de/en/standard/din-en-50134-7/276569443)). | Escalation, acknowledgement, regular tests. | Claiming to be one. Ours is exactly the "informal arrangement with family". |
| HA companion app | iOS critical alerts (`push.sound.critical: 1`) and Android `channel: alarm_stream` that sound through silent mode ([critical notifications](https://companion.home-assistant.io/docs/notifications/critical-notifications)). | The phone path for `critical`. | — |
| Home Assistant smoke automations | State triggers on `binary_sensor` smoke entities; users report detectors sounding while HA sent nothing, and cloud-only detectors failing offline ([forum](https://community.home-assistant.io/t/automation-mysteriously-failed-to-trigger-on-smoke-detector-sensor-on-state/349934), [guide](https://joinhomeshift.com/home-assistant-smoke-detector/)). | Treat our relay as an *extra* channel. | Ever presenting it as the alarm. |

## 3. Example conversations

1. Oma lives alone with a kitchen node. "Hey Jeff, help!" → "I'm alerting Ian and Sam now. Say 'cancel' if you're
   alright." (no question first when the household chose "act at once", §10) → Ian's phone: critical alert "Oma asked
   for help (kitchen, 14:32)" with buttons "I'm on my way" / "Call her". Sam: an SMS. → Ian taps "I'm on my way" →
   the node: "Ian is on his way." → Ian, from the car, taps "Call her": a call opens to the kitchen node, which answers
   automatically because an emergency is active (§13).
2. Nobody answers: after 2 minutes the chain goes to the next tier (the neighbour, by SMS) and repeats tier 1. The node
   says once a minute: "I've alerted Ian, Sam and Mr Jansen. Nobody has answered yet." After the last tier: "Nobody has
   answered. If you need an ambulance, call 112 on your phone, or press your alarm button."
3. False start: "Hey Jeff, help me with the crossword." → no emergency: the matcher requires "help" alone or with
   "call for help", "I need help", "I've fallen", "emergency" (§5.3); everything else goes to the assistant.
4. Cancel: "Cancel, I'm fine." → "Okay, I've told Ian and Sam you're alright." (an all-clear goes to everyone already
   alerted; cancelling never silently withdraws an alert)
5. Check-in, morning: 09:00 on Oma's node: "Good morning, Oma. Just checking in: how are you?" → "Fine, thank you." →
   "Good. Have a nice day." Silence: at 09:15 again, louder. Still silence, and no movement in HA since 07:00 → Ian:
   "Oma hasn't answered her 09:00 check-in and there's been no movement since 7. Tap to drop in on the kitchen." (`high`)
6. Smoke at 03:10: every device, including bedrooms in quiet hours, plays the alarm cue and says "Smoke detected in the
   kitchen. Leave the house now." Every phone gets a critical alert. Screens go full red with the sensor name. "Stop" on
   one device silences that device for 5 minutes; the alarm stays active until the sensor clears or someone taps
   "Handled" on a phone.
7. Water leak at 02:00 under the washing machine: `high`, not `critical` (§9): screens and phones, no speech in
   bedrooms; the utility-room node speaks.
8. Medical card: a paramedic in the hallway: "Hey Jeff, read Oma's medical information." → "Oma, born 1946. Allergies:
   penicillin. Takes metoprolol and apixaban, a blood thinner. Conditions: atrial fibrillation. GP: Dr. de Vries,
   oh-three-oh … Emergency contact: Ian, oh-six …" (read verbatim from the card; on a screen, the card in large type)
9. Failure, internet down: "Hey Jeff, help!" → (the language model is unreachable; the matcher handles it) "The
   internet is down. I'm sending a text message to Ian and Sam through the house phone, and announcing it on every
   speaker." (SMS gateway on the LAN, §11)
10. Honesty: "Hey Jeff, call an ambulance." → "I can't call emergency services. Call 112 on a phone. Shall I alert Ian
    and Sam as well?" (fixed text, never generated)

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `emergency_help` | `who?: dynamic` (person in need; default device person), `reason?: text` ("fallen") | the alert id, who is being alerted on which channel | W | outward-facing (`message`), exempt from confirmation (§13) | < 300 ms to first push sent | **yes**, works without the model |
| `emergency_cancel` | `id?` | "Told everyone you're alright." | W | outward-facing | < 300 ms | **yes** |
| `emergency_status` | — | active alerts, who acknowledged, next tier and when | R, speculative | safe | < 10 ms | **yes** |
| `safety_alarms_status` | — | active safety alarms with sensor, room and since | R, speculative | safe | < 10 ms (HA cache) | **yes** ("is anything alarming?") |
| `medical_card_read` | `person?: dynamic`, `fields?` | the card text, verbatim | R | safe, sensitive | < 20 ms | **yes**, never through the model |
| `checkin_set` | `person`, `rule` (RRULE, "every day at 9"), `window?` (15 min), `alsoActivity?: boolean` | the check-in read back | W | changes data | < 50 ms | no |
| `checkin_list` / `checkin_pause` / `checkin_cancel` | `id?`, `until?` ("I'm away until Sunday") | list / "Paused until Sunday." | R / W | safe / changes data | < 20 ms | yes |
| `emergency_test` | `tier?` | runs a test alert marked TEST to the chain; reports who acknowledged | W | outward-facing | seconds | no |

"Check-in answered" is not a tool: any utterance on the person's devices during the window counts, matched locally.

## 5. Integrate or build

### 5.1 Build the policy, integrate the channels

There is nothing to buy that fits a self-hosted household and is not a certified, staffed service (which is a
different product the household can also have). Build: the help flow, the escalation chain, check-ins, the alarm
policy and the card. Integrate: phone channels from [notifications](notifications.md#5-integrate-or-build-phone-channels)
(HA companion app critical alerts first, ntfy priority 5 second), SMS and chat from [messaging](messaging.md#51-channels)
(SMS Gateway for Android in local-server mode on a spare phone, Telegram, Signal), calls from
[calls-and-intercom](calls-and-intercom.md), sensors from [smart-home](smart-home.md).

### 5.2 The escalation chain

| Tier | Who | Channels, in parallel | Wait for acknowledgement |
|---|---|---|---|
| 0 | the house | `critical` announce on every device of the person's home, full-screen card | — |
| 1 | primary contacts (e.g. Ian, Sam) | phone critical push with buttons; SMS; chat message | 2 min |
| 2 | secondary (neighbour) | SMS; chat | 3 min, while tier 1 is re-sent |
| 3 | everyone in the chain again, plus the spoken 112 advice on the device | all | repeats every 5 min for 30 min |

An acknowledgement is a button press ("I'm on my way", "I'm calling"), an SMS reply containing "ok", "coming" or
"onderweg" from a known number, or a chat reply. It is spoken on the device at once. The alert ends only by cancel on
the device, "resolved" by an acknowledger, or 30 minutes after the last tier (then it stays in everyone's inbox).

### 5.3 Triggering without false alarms

- **Phrases (closed list, matched before routing, like "stop")**: "help", "help me", "call for help", "I need help",
  "I've fallen", "emergency", Dutch "help", "hulp", "ik ben gevallen", "bel hulp". "Help" followed by other words
  ("help me with …") is not a trigger.
- **Wake phrase:** required by default. Per device the owner may allow wake-free "help" (Oma's node), accepting TV
  false triggers; then a 10 s countdown with "say cancel" is mandatory before tier 1.
- **Confirmation or act at once:** household setting; default "act at once with cancel", because a person who fell may
  not manage a second sentence. Cancelling sends an all-clear (example 4).
- **Other triggers** as events: a Zigbee or Z-Wave panic button through HA, a fall or no-motion sensor (mmWave), a
  missed check-in. Each maps to `emergency_help` with a `reason`.

### 5.4 Check-ins

A Scheduler job per check-in (RRULE). At the time: a spoken prompt on the person's devices and a `progress` card. Any
answer, any turn, or (if `alsoActivity`) any HA motion/door event in their home since a set hour counts as OK. A
second prompt after the window; then a `high` alert to tier 1 with "drop in" offered (not a full emergency unless the
household chooses that). "I'm away until Sunday" pauses it.

## 6. Data

| What | Scope | Shape |
|---|---|---|
| Emergency profile | person | `{ person, chain: { tier, contactIds[], channels[], waitSeconds }[], mode: "act" \| "ask", wakeFree: deviceIds[], home: rooms/devices }` |
| Medical card | person | `{ born?, allergies[], medications[], conditions[], gp?, notes?, updatedAt, updatedBy }`, stored encrypted (vault-derived key) **[proposal]** |
| Alerts | household | `{ id, kind: help \| checkin \| safety \| test, person?, reason?, startedAt, tiers: { at, sent: { contact, channel, ok }[] }[], acks: { contact, how, at }[], endedAt?, endedBy }`; kept 1 year |
| Check-ins | person | `{ id, rule, window, alsoActivity, pausedUntil?, lastOkAt }` |
| Safety policy | household | per sensor class: priority, wording, rooms, phones, repeat interval, local silence minutes |

## 7. Long-running work and events

- **Jobs:** tier timers per alert (Scheduler, so a restart mid-alert resumes the chain), check-in times and windows,
  a monthly `emergency_test` reminder to the owner, re-announce every 60 s on the device during an alert.
- **Events emitted:** `emergency.started`, `emergency.acknowledged`, `emergency.ended`, `checkin.missed`,
  `safety.alarm.started` / `.cleared`.
- **Listens to:** smart-home's safety events, HA button events, `notification.resolved` and phone callbacks (HA
  `mobile_app_notification_action`, ntfy `http` actions), messaging inbound (SMS replies).
- **Restart:** an active alert is reloaded from the store and its tier timers continue; on start the device says "I
  restarted during an alert; Ian has acknowledged." If the server was down at a check-in time, the check-in runs at
  start if within its window, else it is reported as "missed while I was offline" to tier 1 (`normal`, not an alarm).

## 8. Presentation

- **Help active (screen):** full-screen `card` in high contrast: "Help is on the way" or "Alerting Ian and Sam",
  each contact with status (sent / delivered / acknowledged), a large Cancel button, and the medical card below for
  responders. The character is small at the top; no playful motion (reduced-motion choreography).
- **Safety alarm:** full-screen red card with the sensor and room; overrides any layout, video or call.
- **Check-in:** a `card` "Good morning, Oma" with a big "I'm fine" button.
- **Headless:** the alarm cue (the `critical` earcon of notifications §8), fixed spoken lines, status every 60 s.
  Spoken text in this module is a fixed set per language, synthesised and cached in advance, so it plays even when
  speech synthesis is slow.

## 9. Notifications and proactive behaviour

| Event | Priority | Where | Quiet hours / DND |
|---|---|---|---|
| Help requested | `critical` | person's home devices + chain phones | ignored |
| Smoke, CO, gas | `critical` | every device, every household phone | ignored |
| Water leak | `high` (disagreement with smart-home, Q6) | screens, phones, the room's speaker | visual only in bedrooms |
| Check-in missed | `high` | tier 1 phones | phones ring through for the chain |
| Test | `normal`, marked TEST | chain | respected |

Safety alarms repeat every 60 s until cleared or handled; "stop" silences one device for 5 minutes, never all.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | module on; act at once or ask first; 112 advice text and country number; who may edit chains and cards (adults); safety policy table | off until set up; act with cancel; 112; adults; §9 |
| Module | phone channel order for `critical`; SMS gateway as offline fallback; monthly self-test reminder | HA app, ntfy, SMS; on; on |
| Assistant | none: emergency phrases work on every assistant and cannot be switched off per assistant once the module is on | — |
| Device | wake-free "help"; belongs to whose home; may show the medical card | off; household; private devices |
| Person | chain, medical card, check-ins, acknowledgement phone | none |

**First run:** a setup page that (1) shows the limits (§13) and requires the owner to tick that they read them, (2)
builds the chain from contacts, (3) sends a TEST alert and waits for every tier to acknowledge, and (4) offers the
medical card. The module stays off until the test passed.

## 11. Native tools and dependencies

| Need | Where | Without it |
|---|---|---|
| A phone channel with critical delivery (HA companion app) or high priority (ntfy) | phones, HA | "Emergency alerts can't reach phones; set up a phone channel first." (setup refuses) |
| SMS Gateway for Android on a spare phone with a SIM, local-server mode on the LAN ([docs](https://docs.sms-gate.app/)) | LAN | no internet-independent path; the setup page says so |
| Home Assistant and its safety sensors | LAN | the alarm relay is `unavailable` |
| UPS for the server, router and gateway phone | house | none of this works in a power cut |

**Behaviour when parts are down:**

| Down | What still works |
|---|---|
| Language model / internet | Everything in this module: the phrase matcher, local STT and TTS, cached fixed sentences, announcements on the LAN, SMS through the gateway phone (cellular), HA locally. Phone pushes through vendor relays (HA's relay, APNs, FCM, ntfy upstream) may fail; the SMS goes regardless. |
| Home Assistant | help and check-ins; no sensors, no HA app pushes (ntfy and SMS instead). |
| Our server | nothing of ours. A panic button and smoke alarms must also work through HA automations or on their own (§13). |
| A device's Wi-Fi | that device cannot ask for help; check-in misses are reported. |

## 12. Interaction with the rest of the system

- **Fast path is the design, not an optimisation.** Help, cancel, status, the medical card and safety status are
  typed actions matched before routing, run without a model, with fixed wording. The model may *offer* them in
  conversation ("shall I alert Ian?") but never words an alert or reads the medical card.
- **Voice:** the matcher gets recogniser events before the echo gate, like "stop" (one word, possibly during
  playback; [assistant-controls §5](assistant-controls.md#5-integrate-or-build)). Distressed, slurred or quiet speech
  recognises badly: keep the phrase list short, accept `close` matches, and never require a second sentence.
- **Calls:** during an active alert an acknowledger may open a call to the person's devices that auto-answers
  ([calls-and-intercom §13](calls-and-intercom.md#13-privacy-and-safety)), with the live indicator.
- **Other output:** a safety alarm stops music and video, interrupts replies and calls (`critical` interrupts,
  shared-state §8.2). Timers keep their own ringing after the alarm clears.
- **Agents and assistants:** emergency phrases are host-level once the module is on, like "stop". No template; a
  "carer" persona would be a misleading promise.
- **Other modules:** [contacts](contacts.md) (chain), [notifications](notifications.md) (delivery),
  [messaging](messaging.md) (SMS, chat), [smart-home](smart-home.md) (sensors, buttons, presence for check-ins),
  [briefing](briefing.md) (yesterday's check-ins and alerts for the caregiver), [reminders](reminders.md)
  (medication reminders are reminders, not this module).

## 13. Privacy and safety

**What must never be promised, said in setup and in fixed sentences:**

- It **cannot call 112** or any emergency number, and no future SIP bridge changes that by default: VoIP calls to
  112 raise location, callback and power questions that a household server cannot answer **[unverified for NL VoIP
  rules]**. The fixed advice is "call 112 on a phone".
- It is **not a social alarm** (EN 50134) and has no receiving centre; it relies on family answering their phones.
- It is **not a smoke alarm** and does not replace detectors on every floor (required in Dutch homes since 1 July 2022
  **[from memory]**); it relays what HA reports, and HA can miss events.
- It is **not a medical device**; the card is what the family typed in, dated, and read as written.
- Delivery is **best effort**: pushes go through vendor relays, SMS through one phone, everything through one server.

**Other rules:**

- `emergency_help` is exempt from core confirmation and from per-device `allowRisky`: anyone in the house, including a
  guest or a child, may ask for help. False alarms are cheap compared with a missed one; the all-clear is easy.
- The medical card is sensitive health data: stored encrypted, never sent to the hosted model, read only on request,
  shown on screens only during an active alert or on `private` devices, edited only by the person or an adult they
  chose. Every read is logged.
- Check-ins and activity-based checks are monitoring of a person: only with that person's consent, recorded in
  setup, and pausable by them by voice.
- Auto-answer of a responder's call happens only during an active alert the person raised (or a missed check-in, if
  they allowed it), always with the live indicator.
- Alerts carry the person's name, the device and time; the reason only if spoken ("fallen"); never transcripts.

## 14. Foundations needed

[Notification service](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications) with
`critical`, phone channels and acknowledgement callbacks; [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler)
(tiers, check-ins); [Module store](../module-investigation/shared-state-jobs-and-notifications.md#4-the-shared-data-layer);
the fast-path control matcher ([assistant-controls](assistant-controls.md#5-integrate-or-build)); people and
[contacts](contacts.md); [Tool context](../module-investigation/shared-state-jobs-and-notifications.md#45-turn-context-proposal);
[Device capabilities](../module-investigation/presentation-and-device-capabilities.md#5-device-capabilities) (whose
home, privacy); [Requirements and health](../module-investigation/module-definition-config-and-dependencies.md#c3-requirement-declaration-and-probing-proposal)
(the channel and gateway checks the setup test uses); vault-backed encryption for the card.

**A useful first version:** the safety-alarm policy on smart-home's events (critical everywhere, fixed text, phone
via the HA companion app), plus `emergency_help` with one tier of contacts on one phone channel, act-with-cancel, the
setup test and the limits page. Check-ins, SMS fallback and the medical card follow.

## 15. Open questions

1. **Who is this for?** Is there an elderly or solo person who would use it, or is it mainly the alarm relay? That
   decides whether check-ins are built at all.
2. **Act at once or ask first** after "help"? Asking reduces false alarms; acting helps someone who cannot answer.
3. **Wake-free "help"** on any device, accepting TV false alarms?
4. **An internet-independent path:** is a spare Android phone with a SIM as SMS gateway acceptable to keep plugged in?
5. **Medical card:** wanted, and may it be shown to anyone during an alert (a paramedic) on shared screens?
6. **Disagreement with [smart-home §7](smart-home.md#7-long-running-work-and-events):** it makes moisture (leak)
   `critical` everywhere by default. I propose `high` for leaks (screens, phones, no speech in bedrooms at night),
   keeping `critical` for smoke, CO and gas.
7. **Disagreement with [notifications §9](notifications.md#9-notifications-and-proactive-behaviour):** it lets the owner
   allow an inbound hook to send `critical`. For safety alarms I would allow `critical` only from smart-home's typed
   sensor classes and this module's help flow, not from free-text hooks.
8. **Monthly self-test:** acceptable to send a TEST alert to the chain every month?
