# Broadcast

Research write-up, 2026-11-18. Not an approved design. Code references are `main` at `70b15ec`. Shared foundations
are named as in [`README.md`](README.md) and linked, not redesigned. Claims marked **[unverified]** or **[from
memory]** were not confirmed in a primary source during this session.

## 1. Summary

One-way messages across the house as a module of its own: "tell everyone dinner is ready", "tell the kids' room it's
bedtime", "tell the kitchen I'm coming" (a reply), "leave a message for Sam" (a recorded voice message played when Sam
is next around), "every school day at 8:05, say it's time to leave" (a scheduled broadcast, Google's Family Bell), a
dinner-bell chime with no words, and the same message on family phones.

**Boundaries.** The **Notification service** owns delivery: priorities, quiet hours, DND, the output lease, the
`Announce` input, the follow-up window and phone channels
([shared-state §8](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications)). This module is a
user of it, like timers. It takes over the user-facing announce tool that [notifications](notifications.md#4-tools)
lists as `notifications_announce`; notifications keeps the inbox, DND, phone channels and inbound hooks (see open
question 1). Two-way live audio is [calls-and-intercom](calls-and-intercom.md). Text to a person's chat app is
[messaging](messaging.md). "Sam" and "Mum" are resolved by [contacts](contacts.md).

- **Priority: first wave** for live broadcast with replies and chimes (it is Phase 2's "dinner's ready" in the
  [overview](../module-investigation/investigation.md#8-suggested-order-of-work)); **second wave** for voice messages
  left for a person, scheduled broadcasts and phones.
- **Effort: M.** Live broadcast is S on top of `Announce`; the speaker's own voice is S–M (a turn audio buffer);
  voice messages are M (storage, presence, playback rules); scheduled broadcasts are S on the Scheduler; phones are S
  per channel already built by notifications.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa Announcements | "Alexa, announce …" to every Echo; a spoken announcement plays **in your recorded voice**, a typed one in Alexa's voice ([Amazon developer docs](https://developer.amazon.com/docs/acm/announcements-acm.html), [GearBrain](https://www.gearbrain.com/how-to-use-alexa-announcements-2556765795.html)). | The recorded voice by default; the assistant voice for typed or scheduled text. | No reply path. |
| Google Broadcast | To all speakers or one room, and to Family Group phones; recipients reply by voice or a reply button ([Yahoo/BGR](https://news.yahoo.com/google-just-announced-exciting-google-160632318.html), [Android Police](https://www.androidpolice.com/2021/05/06/google-assistant-broadcasts-just-got-way-more-powerful/?amp)). Users report broadcasts switching between their own voice and the assistant's ([PiunikaWeb](https://piunikaweb.com/2023/10/26/google-aware-nest-broadcast-message-is-not-using-your-voice)). | Replies routed to the sender; phones as recipients. | Changing the voice silently: the household should know which they get. |
| Google Family Bell | Scheduled announcements of up to 80 characters with repeat days and chosen devices; "stop" without the wake word; speakers and displays only ([Digital Trends](https://www.digitaltrends.com/?p=2693682), [Google blog](https://blog.google/products/assistant/plan-perfect-weekend-new-google-assistant-features)). | Exactly the scheduled-broadcast shape, including "stop" while it plays. | — |
| Home Assistant | `assist_satellite.announce` with a pre-announce chime (`preannounce`, `preannounce_media_id`) ([action](https://www.home-assistant.io/actions/assist_satellite.announce/)). | Chime before speech; a custom chime per kind. | — |
| Alexa / Echo voice messages | Leaving a message for a contact via the Alexa app **[from memory]**; nothing household-scoped that plays on arrival. | — | — |

## 3. Example conversations

S = a screen helps; everything also works on a speaker.

1. Kitchen: "Hey Jeff, tell everyone dinner is ready." → kitchen: a short cue ("sent"). Every other shared-room device:
   two-tone chime, then the kitchen speaker's own recorded words "Dinner is ready!", preceded on a screen by a card
   "From the kitchen". A device mid-reply plays it at the end of the reply.
2. Reply, no wake phrase, within 30 s, upstairs: "Coming in five!" → the kitchen hears "From the study: coming in
   five!" (the reply window is the follow-up window of shared-state §8.6).
3. Room target: "Tell the kids' room it's lights out." → only the devices whose room is "Kids' room".
4. Person target: "Tell Sam the car is here." → the device where Sam was last active in the last 10 minutes; else the
   rooms of Sam's default devices; with nobody known: "Where is Sam? The living room or upstairs?"
5. Reply to a specific earlier broadcast: "Tell the kitchen I'm coming." → a new broadcast to the kitchen, marked as a
   reply if the kitchen broadcast within the last 5 minutes.
6. Voice message: "Leave a message for Sam." → "Go ahead." → "The plumber comes Thursday at nine, please be home."
   → "Saved for Sam." Hours later Sam says "hey Jeff, good morning" on the bedroom tablet → before the answer: "Sam,
   you have a message from Ian, left yesterday at 18:20." (plays it) "Want to reply?"
7. Scheduled: "Every school day at 8:05, tell the hallway it's time to leave for school." → "Every weekday at 8:05 in
   the hallway: 'It's time to leave for school.' Skips school holidays only if you give me a holiday calendar." S: a
   list of scheduled broadcasts with on/off switches.
8. Chime only: "Ring the dinner bell." → the dinner-bell chime on all shared-room devices, no words.
9. Phones: "Tell everyone dinner is ready, phones too." → speakers as in 1; each household member's phone gets a push
   "Dinner is ready (from the kitchen)" through their channel; replies from a phone come back as text and are spoken
   in the kitchen in the assistant's voice.
10. Failure: "Tell the garage I'm leaving." → the garage node is offline → "The garage speaker is offline. Should I send
    it to Ian's phone instead?"
11. Ambiguous: "Announce that the film starts." with no target and two people in different rooms → all shared rooms,
    the default for "announce" without a target; never bedrooms in quiet hours.

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `broadcast_send` | `text`, `to?: dynamic` (everyone, room, device, person; default shared rooms), `voice?: "mine" \| "assistant"` (default per household), `phones?: boolean`, `reply?: boolean` (default true) | "Sent to 4 devices; the garage is offline." | W | outward-facing (inside the house) | < 50 ms to queue; first audio < 500 ms on idle targets **[target]** | yes ("tell everyone …", "announce …", "tell the kitchen …") |
| `broadcast_chime` | `chime: dynamic` (dinner bell, doorbell-style, gentle, …), `to?: dynamic` | "Rung." | W | outward-facing | < 50 ms | yes |
| `voice_message_leave` | `for: dynamic` (person), `text?` (else records the next utterance), `expires?: duration` (default 7 d) | "Saved for Sam." | W | changes data | < 100 ms | yes |
| `voice_message_play` | `which?: "next" \| "all" \| id`, `from?: dynamic` | plays; marks heard | R (marks heard) | safe; personal | < 200 ms to audio | yes ("any messages for me?") |
| `voice_message_list` | `for?: dynamic` | count and senders per person | R, speculative | safe | < 10 ms | yes |
| `voice_message_delete` | `id?` or `all heard` | "Deleted." | W | changes data | < 20 ms | yes |
| `broadcast_schedule` | `text` or `chime`, `rule` (RRULE, from "every school day at 8:05"), `to`, `voice?` (assistant; recorded only if recorded now), `until?` | the schedule read back | W | changes data | < 50 ms | no (the model parses the rule; the result is read back) |
| `broadcast_schedule_list` / `_cancel` / `_pause` | `id?` | list / "Cancelled." | R / W | safe / changes data | < 20 ms | yes |
| `broadcast_last` | — | what was last broadcast here, from whom, when ("what was that?") | R, speculative | safe | < 10 ms | yes |

Replies are not a tool: the follow-up window on each target makes the next utterance a reply, routed by the module to
the origin as a new broadcast with `inReplyTo`.

## 5. Integrate or build

**Build.** Nothing to integrate: every piece is our own delivery. Options for the parts that have a choice:

| Question | Options | Recommendation |
|---|---|---|
| Whose voice | (a) the assistant's TTS reads the transcript; (b) the speaker's recorded audio, cut from the turn | (b) for live broadcasts said by voice, as Alexa does: the recogniser can mishear and the household recognises the person; (a) for typed, scheduled, phone-originated and replies-from-phones. A setting per household. |
| Getting the audio of (b) | `HeardAudio` keeps turn audio only when "save what the assistant hears" is on (`apps/assistant/src/serve/HeardAudio.ts:141`) | A short **turn audio ring** in the voice session: the last 15 s of 16 kHz PCM, always in memory, never on disk; the module asks for the segment from the end of "tell everyone" to the end of the turn, using recogniser word timestamps where the provider gives them, else the whole utterance after the trigger words **[timestamps per provider unverified]** |
| Trimming the trigger words | cut by timestamp; or play the whole utterance ("Hey Jeff, tell everyone dinner is ready") | cut when timestamps exist, otherwise fall back to (a) TTS rather than play the wake phrase to the house |
| Voice message storage | WAV 16 kHz mono (~32 KB/s, ~1 MB per 30 s) in the module's media folder; Opus via `ffmpeg` | WAV; no native dependency; capped at 60 s per message and 50 MB per household |
| "Next present" | (a) next turn by that person (device-default person or voice-ID hint); (b) HA presence arrival; (c) next interaction on any device in their default rooms | (a) first, (b) when [smart-home](smart-home.md) presence exists; never on a `public` device |
| Scheduled rules | `Cron` or RRULE ([investigation §11 b](../module-investigation/investigation.md#11-disagreements-between-documents)) | RRULE, as reminders and bin day; "school day" needs an optional holiday calendar from [calendar](calendar.md) |
| Chimes | generated on the device like the wake cue; bundled short files | bundled OGG/WAV cues cached on devices, the same set the notification earcons use, plus a "dinner bell" and "gong" |

## 6. Data

| What | Scope | Shape | Readable by |
|---|---|---|---|
| Broadcast log | household | `{ id, from: { device, person? }, to, text, voice, audioRef?, at, deliveries: { device, state: delivered \| waited \| offline \| dnd }[], inReplyTo? }`; audio deleted after 10 min, row kept 7 days | this module, [briefing](briefing.md) ("two broadcasts while you were out") |
| Voice messages | person (recipient) | `{ id, for, from, audioPath, transcript, leftAt, expiresAt, heardAt?, heardOn? }` | the recipient's devices; the sender sees "heard" |
| Scheduled broadcasts | household | `{ id, rule (RRULE), tz, content: text \| chime \| audioRef, to, voice, paused, skipCalendar?, createdBy }` | admin |
| Chime set | module settings | ids, labels, files | notifications (shared earcons) |

Exports: `broadcast.unheardFor(person)` (count) for the ambient line and the briefing.

## 7. Long-running work and events

- **Scheduler:** one recurring job per scheduled broadcast, kind `notify` (shared-state §6.2), so it fires even while
  the module restarts. Missed while down: dropped, never played late (a 08:05 "time to leave" at 09:30 is wrong),
  logged as missed. Voice-message expiry jobs. Reply windows (30 s).
- **Events emitted:** `broadcast.sent`, `broadcast.replied`, `voicemessage.left`, `voicemessage.heard`.
- **Listens to:** `turn.started` with a person (to offer waiting voice messages), `home-assistant.presence.changed`
  (arrival), `dnd.changed`.
- **Restart:** live broadcasts not yet played are dropped after 2 minutes (as notifications §7 decides); voice
  messages and schedules persist.

## 8. Presentation

- **Receiving (screen):** a `card` "From the kitchen" with the transcript (even when the recorded voice plays, so it
  is readable later), a Reply button that opens the mic in reply mode, and the sender's look's colour as an accent.
  The card comes out of the character (Hold-up, then Presenter,
  [presentation §4.1](../module-investigation/presentation-and-device-capabilities.md#41-layouts-host-level-every-character));
  while the recorded voice plays, the character stays in `idle` with the card held up, because it is not the
  assistant speaking. For assistant-voiced broadcasts the character uses `speaking` as usual.
- **Voice messages waiting:** a small envelope badge with a count on devices of that person (Orbit layout); on
  `shared` devices only "Message for Sam", never the transcript.
- **Scheduled broadcasts:** a `list` with times, rooms and switches.
- **Speaker only:** chime, then the audio; "From the study:" spoken in the assistant voice before a recorded message so
  the listener knows who it is.

## 9. Notifications and proactive behaviour

- A live broadcast is `normal` priority: plays now outside quiet hours on idle devices, waits for the end of a running
  reply ([shared-state §8.2](../module-investigation/shared-state-jobs-and-notifications.md#82-priority-and-what-each-may-do)).
  In quiet hours: only devices not marked as a bedroom (`quietRoom`), unless the speaker says "everywhere, now".
- A scheduled broadcast is `normal` with `dedupeKey` per occurrence; stop without the wake word while it plays.
- A voice message is offered once at the recipient's next turn, before the answer, briefly; then it waits until asked.
  It is never played on arrival in a room unless the recipient turned that on.
- Phones: only when asked ("phones too") or when a person target has no reachable house device for 2 minutes.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | default audience (shared rooms); voice for live broadcasts (mine / assistant); reply window (30 s); bedrooms in quiet hours (skip); voice message limits (60 s, 7 days, 50 MB) | as stated |
| Module | chime set; scheduled broadcasts (records); holiday calendar for "school days" | bundled; none; none |
| Assistant | module on/off; a kids' assistant: broadcast to the household, no schedules | on |
| Device | accepts broadcasts; is a bedroom (`quietRoom`); chime volume (from assistant-controls); may play voice messages (off on `public`) | on; off; 60 %; on except public |
| Person | receive voice messages on arrival (off); phones for "phones too"; hear broadcasts in own voice or assistant voice | off; their notification channel; household default |

**First run:** none for live broadcasts beyond room names. Voice messages need `Person` records. Phones need a
notification phone channel.

## 11. Native tools and dependencies

None on the server for v1 (WAV, bundled chimes). Optional `ffmpeg` for Opus storage (later). Voice nodes cache chime
files like the wake cue. When a target has no speaker: skipped and counted ("the hallway screen has no speaker").
When phones are asked for and no channel exists: "I can't reach phones yet; I've told the speakers."

## 12. Interaction with the rest of the system

- **Voice.** Trigger words: "tell everyone", "announce", "tell the <room>", "tell <person>", "broadcast", Dutch "zeg
  tegen iedereen", "omroepen". Room and person names go through the same fuzzy matcher as smart-home targets; a misheard
  room is a question. Dictated text is kept verbatim; the model may not rephrase it.
- **Fast path.** "Tell everyone …", "ring the dinner bell" and "any messages for me" are typed actions matched without
  the model: the target is resolved locally and the remainder is the text. The model is needed only for schedule
  rules.
- **Output lease.** A recorded broadcast plays through the same lease as replies, so two never overlap on a device.
  "Stop" during it stops it on that device only.
- **Character.** Recorded voice = not the assistant: `idle` with the card; assistant voice = `speaking`.
- **Agents and assistants.** No template. Every household assistant gets it.
- **Other modules.** Builds on `notify.send` and `Announce`; [calls-and-intercom](calls-and-intercom.md) hands over
  one-way phrasings and offers a voice message when a call is declined; [messaging](messaging.md) offers "announce on
  the speakers instead" when a channel fails; [routines-and-automations](routines-and-automations.md) can use
  `broadcast_send` and `broadcast_chime` as steps; [reminders](reminders.md) for another person may deliver through
  voice messages; [briefing](briefing.md) reads unheard counts; [emergency-and-safety](emergency-and-safety.md) uses
  the notification service directly at `critical`, not this module.

## 13. Privacy and safety

- A recorded voice is personal data: kept 10 minutes for live broadcasts, until heard or expired for messages, never
  sent to a hosted model (the transcript is local STT).
- Voice messages play only to the recipient's resolved person or on their devices; on `shared` devices with an
  uncertain person, "There's a message for Sam" and Sam says "play it" (a device-default or chosen person). No voice
  ID authorisation.
- Children cannot broadcast in quiet hours, cannot schedule, and cannot send to phones (household policy).
- Guests: a guest assistant may broadcast to shared rooms only.
- A TV saying "tell everyone …" without the wake phrase cannot trigger it: broadcast needs the wake phrase or an open
  follow-up window like any turn.
- Scheduled broadcasts are listed and cancellable from any device and admin (no hidden recurring speech).

## 14. Foundations needed

[Notification service](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications) with `Announce`
and the follow-up window; [Tool context](../module-investigation/shared-state-jobs-and-notifications.md#45-turn-context-proposal)
(origin device, person); [Device capabilities](../module-investigation/presentation-and-device-capabilities.md#5-device-capabilities)
(room, privacy, `quietRoom`, speaker); [Module store](../module-investigation/shared-state-jobs-and-notifications.md#4-the-shared-data-layer)
(messages, schedules); [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler);
[Presentation](../module-investigation/presentation-and-device-capabilities.md) (`card`, `list`); `Person` records; new:
the turn audio ring in the voice session.

**A useful first version (S):** `broadcast_send` to everyone or a room, assistant voice, chime first, a 30 s reply
window, and `broadcast_chime`; delivery by device in SessionHub with `Announce`. No store needed.

## 15. Open questions

1. **Where does the announce tool live?** [notifications §4](notifications.md#4-tools) defines `notifications_announce`
   and replies inside the notifications module. I propose moving them here, leaving notifications with the inbox, DND,
   phones and hooks. Alternatively this module shrinks to voice messages and schedules only.
2. **Whose voice by default** for live broadcasts: the speaker's recording (Alexa) or the assistant reading the
   transcript? (Same as [notifications Q3](notifications.md#15-open-questions).)
3. **Voice messages on arrival:** play automatically when the person is detected, or only offer at their next turn?
4. **Replies without the wake phrase** for 30 s on every target, including a TV room?
5. **School days:** is a holiday calendar available (school ICS feed), or should "school day" mean Monday to Friday?
6. **Phones:** should a broadcast to phones carry the audio clip (ntfy attachments, Telegram voice notes) or only text?
7. **Quiet hours:** may an adult override bedrooms with "everywhere, now"?
