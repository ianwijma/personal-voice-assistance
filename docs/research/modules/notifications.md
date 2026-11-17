# Notifications, announcements and intercom

Research write-up, 2026-11-17. Not an approved design. The **Notification service** itself (priorities, audience,
ring policy, quiet hours, inbox, `Announce`) is designed in
[`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md) §8 (cited as
"shared state §n"). This document does not redesign it. It covers two things on top: how other modules use the service,
and the user-facing module `notifications`. That module holds the announcements and intercom, the inbox by voice, DND,
phone channels and incoming notifications from outside. Stage rules are in
[`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md)
("presentation §n").

## 1. Summary

The module lets people say "tell everyone dinner is ready", "what did I miss?", "do not disturb until eight" and
"send that to my phone". It lets Home Assistant, n8n or Node-RED say "the washing machine is done" on the right
device. Every other module (timers, reminders, calendar, long tasks) sends through the same service, so quiet hours,
DND and targeting are decided in one place.

- **Priority: first wave**, split in two. The service and its inbox come with timers (they cannot ring without it).
  The user-facing module (announce, inbox, DND, one phone channel, inbound hooks) follows directly.
- **Effort: L overall.** The service is L (cross-device delivery, presence, ringing window, inbox). The module on top
  is M: announce and the inbox are S, phone channels are S each, inbound hooks are S–M, and two-way intercom is L and
  deferred.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa | Notifications queue behind a yellow ring until "what are my notifications?". DND holds them. Announcements go one way to every Echo. Drop In is live two-way audio ([overview](https://maketecheasier.com/smart-home/alexa-echo-lights-explained)). Third parties push through fixed-schema Proactive Events ([docs](https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api.html)). | The pending indicator and "what did I miss". Typed notification kinds. | "By the way" upsells ([Tom's Guide](https://www.tomsguide.com/how-to/by-the-way-did-you-know-alexas-annoying-suggestions-can-be-turned-off-heres-how)). |
| Google / Nest | "Broadcast" to all or to a room, and family members can reply ([help](https://support.google.com/assistant/answer/9071582)). Pending notifications on the Hub's ambient screen when someone is near. | Reply to a broadcast goes back to its sender. | — |
| HomePod Intercom | Announce to every HomePod and iPhone in the home or a room; reply from the iPhone (long-standing; not re-checked). | Phones as intercom endpoints. | — |
| Home Assistant | `assist_satellite.announce` with a pre-announce chime (`preannounce`, default on; `preannounce_media_id` for a custom sound) ([action](https://www.home-assistant.io/actions/assist_satellite.announce/)); `start_conversation` and `ask_question` listen for an answer. A busy satellite refuses a second announcement. Companion app push with action buttons and iOS critical alerts ([actionable](https://companion.home-assistant.io/docs/notifications/actionable-notifications/), [critical](https://companion.home-assistant.io/docs/notifications/critical-notifications)). | Chime before speech. Announce-then-listen. Phone buttons that call back. | `notify.notify` goes to "the first notify action found" (landscape-automation-platforms.md §13.2): always resolve an explicit target. |
| ntfy, Gotify, Apprise | Self-hosted push and fan-out (§5). | One HTTP call per message, no SDK. | — |

Research on proactive speech (shared state §2.3): a cue before speaking, never talk over people, batch low-value
items, let the person say "not now".

## 3. Example conversations

S = a screen helps; it works headless too.

1. Kitchen: "Hey Jeff, tell everyone dinner is ready." → kitchen: "Announced." Every other connected device in a
   shared room: chime, then "Announcement from the kitchen: dinner is ready." A device mid-reply waits for the end of
   the reply's clause.
2. Upstairs, within 30 s of the announcement, no wake phrase: "Five minutes!" → the kitchen hears: "Reply from the
   study: five minutes." The reply window is the follow-up window (shared state §8.6), opened on the target devices.
3. "Tell Sam to come downstairs." → only Sam's devices (default person = Sam), or the room where Sam was last active.
   With no people configured: "Which room should I tell?"
4. "What did I miss?" → "Three things: the washing machine finished at 14:10, your eggs timer went off while the
   kitchen speaker was offline, and your heat pump research is ready. Want the research?" Grouped, oldest first, marked
   read once heard. S: an inbox list.
5. "Do not disturb until eight." → "Quiet here until eight. Alarms you set will still ring." DND is per device unless
   the person says "everywhere".
6. Washing machine done: Home Assistant posts to the inbound hook (§7) → the utility-room node and the device where
   someone was last active get a chime and "The washing machine is done." In quiet hours it goes to the inbox only.
7. "Send that to my phone." (after a recipe was shown on the kitchen screen) → "Sent to your phone." This needs a phone
   channel. Without one: "I can't reach your phone yet; I can show a QR code here instead." S for the QR code.
8. Ambiguous: "Announce that the car is here." while two people are home and nobody is in a known room → it goes to
   all shared-room devices, which is the default for "announce" without a target. "Tell Ian the car is here" is
   targeted.
9. Failure: "Tell the bedroom the film starts in five minutes." while the bedroom node is offline → "The bedroom
   speaker is offline. Should I send it to Sam's phone instead?"
10. "Stop announcements in the bedroom after nine." → a device quiet-hours override. That is a settings change, so it
    is confirmed on the screen; on a headless device it is pointed to admin.

## 4. Tools

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `notifications_announce` | `text`, `to?: dynamic` (all, room, device, person; default all shared rooms), `reply?: boolean` (default true), `voice?: choice` (assistant voice / my recording) | "Announced to 4 devices; the bedroom is offline." | W | outward-facing | < 50 ms to queue | yes ("announce …", "tell everyone …") |
| `notifications_read` | `filter?: choice` (unread, today, all), `source?: dynamic` | grouped summary; marks read | R (marks read) | safe | < 20 ms | yes |
| `notifications_clear` | `which?: dynamic` or all | "Cleared." | W | changes data | < 20 ms | yes |
| `notifications_dnd` | `until?: text`, `for?: Param.duration`, `where?: choice` (here, everywhere, mine), `off?: boolean` | "Quiet here until eight." | W | changes data | < 20 ms | yes |
| `notifications_send_to_phone` | `what?: choice` (last shown / text), `text?`, `person?: dynamic` | "Sent to your phone." | W | outward-facing | 100–800 ms (provider) | no |
| `notifications_status` | — | DND state, unread count, phone reachable | R, speculative | safe | < 10 ms | yes |

The built-in host tool `notifications_read` from shared state §8.7 *is* this module's tool. Making it a module lets
the owner switch it off per assistant like any other.

**Module-facing API (no tools):** modules call `notify.send(NotificationRequest)` from their `ModuleContext` (shared
state §4.4, §8.1). Rules for module authors:

- Always set `source`, a `dedupeKey` when the same thing may be sent twice (sensor flapping, a recurring reminder),
  `kind` and `priority`.
- Use `audience` plus `origin` and leave `ring` at the kind's default unless there is a reason.
- Put the spoken text in `content.spoken` (one sentence, no markup) and the card text in `content.title`.
- Use `update` to change a ringing item ("+5 minutes") and `resolve` to stop it everywhere.
- Never call `Say` directly. Never decide quiet hours in the module.
- A scheduled `{ notify }` job (shared state §6.2) is preferred over a handler that calls `send`, because it fires
  while the module restarts.

## 5. Integrate or build: phone channels

Phones are a channel of a *person*, not registry devices (shared state §8.3). Each channel is an adapter package
(`notify-*`), because each is a provider API.

| Channel | How it works | Self-hosted? | iOS | Android | Buttons back to us | Critical / alarm | Setup cost |
|---|---|---|---|---|---|---|---|
| **HA companion app** (`notify.mobile_app_<device>`) | Through the Home Assistant connection: `POST /api/services/notify/mobile_app_<device>` with `data.actions`; a tap fires the HA event `mobile_app_notification_action` (`action`, `reply_text`) ([docs](https://companion.home-assistant.io/docs/notifications/actionable-notifications/)) | HA local; the push itself goes through HA's cloud push relay (**unverified detail**) | yes; ~10 actions; critical alerts with `push.sound.critical: 1` or `interruption-level: critical` ([docs](https://companion.home-assistant.io/docs/notifications/critical-notifications)) | yes; 3 actions; `channel: alarm_stream`, `priority: high`, `ttl: 0` | yes, via the HA websocket the module already holds | best of the four | none if HA and the app are already in use |
| **ntfy** | `POST https://<server>/<topic>` with headers `Title`, `Priority` 1–5, `Tags`, `Click`, `X-Actions` (`view`, `http`, `broadcast`, `copy`; at most three), `X-Delay` (10 s to 3 days) ([publish](https://docs.ntfy.sh/publish/)); access tokens `tk_…` | yes (Android fully) | needs `upstream-base-url` (ntfy.sh relays only the message id via APNs; without it delivery "can take hours") ([config](https://docs.ntfy.sh/config/), [known issues](https://docs.ntfy.sh/known-issues/)) | yes | `http` action button POSTs to our hook | priority 5 = long vibration and pop-over; no iOS critical alert | one container + app per phone |
| **Web Push** (VAPID) | The voice page installed as a Home Screen web app plus a service worker; payload encrypted, delivered by Apple, Google or Mozilla push services ([WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)) | no (vendor relay) | from 16.4, Home Screen apps only; **action buttons not shown on iOS** (OneSignal's [FAQ](https://documentation.onesignal.com/docs/faq-safari-web-push), [developer report](https://developer.apple.com/forums/thread/726793); no Apple statement found) | yes, with actions | Android yes; iOS opens the page | none | HTTPS (exists as an option), a service worker (none today, UI-AND-MODULES.md:1160), per-phone install |
| **Apprise API** | `POST /notify/{KEY}` (stateful, `tag` picks targets) or `POST /notify/` with `urls` (stateless); `type` info/success/warning/failure ([apprise-api](https://github.com/caronc/apprise-api)); image `caronc/apprise` | yes (sidecar) | through whatever target (Telegram, Signal, email, Pushover) | same | no (one-way) | depends on the target | one container + one URL per target |

**Recommendation.** Ship `notify-ha-mobile` first if the household runs Home Assistant with the companion app. It needs
no new service, gives buttons on both platforms and alarm-grade sound, and the HA module already holds the websocket for
the callbacks. **ntfy second**, for households without HA and as the fully self-hosted Android path. **Apprise** as an
optional one-way fan-out for Telegram or email. **Web Push last**: it needs a service worker, a Home Screen install and
HTTPS, and on iOS it has no buttons. This differs from shared state §8.7, which puts Web Push first; see open
question 1. All channels are off by default (local-first rule). A push carries the title, the spoken text and the
actions. A button calls back through the inbound hook endpoint with a one-use token per notification.

## 6. Data

The service's own `notifications` table is in shared state §8.7. This module adds, in the Module store:

| Collection | Scope | Fields |
|---|---|---|
| `dnd` | device and person | `until`, `setBy`, `reason`. Ended by a scheduler job |
| `phoneTargets` | person | channel (`ha-mobile`, `ntfy`, `webpush`, `apprise`), address (HA notify service name, ntfy topic, push subscription, Apprise tag), `criticalAllowed`, last success |
| `announcements` | household | text, from device or person, targets, deliveries per device (delivered / waited / offline), replies; kept 7 days |
| `hooks` | household | id, label, token hash, allowed source IPs (default LAN only), template, default priority and audience, rate limit, last call |

Exports: `notifications.unreadCount(person | device)` and `notifications.dnd(device)` for the ambient line and other
modules. Hook tokens live in the vault, not in the store.

## 7. Long-running work and events: incoming notifications from outside

Modules cannot contribute HTTP routes today (current-system.md §9, gap 21). Proposal: a **host endpoint**
`POST /hooks/<hookId>`, shared with [routines](routines-and-automations.md). Each hook is bound to one target: *notify*
(this module) or *run routine*. Auth is `Authorization: Bearer <token>`. It is LAN-only unless the owner allows more,
rate-limited (default 10 per minute), and the body is at most 8 KB of JSON.

```json
// POST /hooks/washer  (a notify hook)
{ "text": "The washing machine is done", "priority": "normal", "to": "room:utility", "dedupe": "washer-cycle",
  "actions": ["ok"] }
```

The hook's template decides what the caller may set. A strict hook fixes the priority and audience and takes only
`text`. Text from outside is **data**: it is spoken and shown as is, never put into a model prompt as instructions.
When it is recorded in a conversation, it is wrapped as `[Notification from hook "washer": …]`.

Examples:

- **Home Assistant:** an automation on the washer's power sensor (below 5 W for 3 minutes) calls a `rest_command` that
  POSTs to the hook. Alternatively the HA module subscribes to an HA event (`pva_notify`) over its websocket, which
  needs no token or route.
- **n8n:** an HTTP Request node, with Header Auth credentials holding the token.
- **Node-RED:** an `http request` node.
- **Apple Shortcuts / Tasker:** "Get Contents of URL" or an HTTP Request action ("I'm on my way" → kitchen).

**Scheduled work:** DND end jobs, inbox expiry (7 days), announcement reply windows (30 s), escalation timers.
**Events published:** `notification.sent`, `notification.ringing`, `notification.resolved`, `announcement.sent`,
`announcement.replied`, `dnd.changed`, `hook.received`. **Listens to:** `mobile_app_notification_action` (via the HA
module) and ntfy `http` callbacks, both mapped to `resolve`/`snooze`. **Restart:** the inbox and DND are persistent.
Ringing notifications are re-evaluated from their jobs (shared state §6). Pending announcements older than 2 minutes
are dropped, not played late: a late "dinner is ready" is noise.

## 8. Presentation

**Screens.**

- **Delivery.** An incoming notification is a `card`. It grows out of the character's focus rectangle while the chime
  plays (the Hold-up, then the Presenter layout, presentation §4.1), so the character delivers it. It holds the title,
  the source ("Home Assistant · 14:10") and up to four buttons. After 30 s unanswered it shrinks into a **badge** on
  the character's box: a small count docked in Orbit. This is the equivalent of Alexa's yellow ring.
- **Pending without a badge.** Characters with the optional `stage.content` extension can show pending items
  themselves: light characters with a slow, low pulse, figures with an occasional glance at the badge. There is no
  invented emotion (CHARACTERS.md §2.3).
- **Announcement.** A card with "From the kitchen" and the text, plus a "Reply" button that opens the mic in reply
  mode.
- **Inbox.** "What did I miss" shows a `list` with items ticked off as they are read aloud (the highlight rule,
  presentation §3.6.4).
- **DND.** A small moon on the top bar. A ringing alarm still takes the full stage.
- **Personal items.** Items marked `sensitivity: personal` show only the source ("Reminder for Ian") on `shared`
  devices.

**Headless nodes.**

- **Earcons by kind:** one soft chime for `normal`, a two-tone chime for announcements, a rising chime for `high`, and
  a repeating alert for `critical`. Cue files are cached on the node, like the wake cue (VOICE-NODES.md §4.4, on its
  branch).
- **Speech:** the line is spoken after the chime.
- **Missed items:** said once at the next wake ("Before that: …"), not on arrival, unless `high`.

## 9. Notifications and proactive behaviour

The priority table, quiet hours and escalation are shared state §8.2–8.3 and are not repeated here. Module-specific
rules:

- An announcement is `normal` for people who asked for it, so it plays immediately outside quiet hours. Inside quiet
  hours it goes only to devices not marked "bedroom" (proposal: a device `quietRoom` flag), unless the speaker says
  "everywhere, now".
- Incoming hooks default to `normal`. The owner may allow a hook to send `critical` (smoke or leak from HA). That is
  the only way outside data can bypass DND.
- Rate limits: at most one spoken notification per device per 20 s. Extra `normal` items within that window are
  batched ("two things: …"), and `low` items are never spoken unprompted.
- Phone: `high` items unacknowledged on every device after 60 s, or when the person is away (presence), go to the
  phone. `critical` always goes.

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | quiet hours (shared); default announce audience (shared rooms); reply window (30 s); hooks LAN-only | 22:00–07:00; shared rooms; 30 s; on |
| Module | inbox retention (7 d); batching window (20 s); earcon set; hooks list (`records` field, BUILT NOT WIRED today) | as stated |
| Assistant | module on/off; `offTools` (e.g. no `send_to_phone` for a guest assistant) | on |
| Device | DND switch; quiet-hours exception; `quietRoom` (bedroom); accepts announcements; volume for chimes | off; none; off; on; 60 % |
| Person | phone targets; hold vs phone in quiet hours; allow critical on the phone | none; hold; off |

**Secrets and connections:** the HA connection (for companion push), the ntfy server URL and token, Web Push VAPID
keys, the Apprise URL, and hook tokens, all in the vault. **First run:** nothing is needed for announcements and the
inbox. For a phone: choose a channel, run "Send test" (a field action, BUILT NOT WIRED today), and press the button on
the phone to prove the callback works.

## 11. Native tools and dependencies

None on the server for announce and the inbox. ntfy and Apprise are optional containers (`binwiederhier/ntfy`,
`caronc/apprise`) that the owner runs, declared as `requires: [{ service: "ntfy", optional: true }]` with a health probe
(module-definition-config-and-dependencies.md §C.3). When a phone channel is down: "I couldn't reach your phone; it's
in your inbox here." When no channel is set up: "I can't reach phones yet. You can set that up in the admin page under
Notifications."

## 12. Interaction with the rest of the system

- **Voice:** announce text is the transcript after "tell everyone" or "announce". It is spoken in the announcing
  assistant's voice by default. The original recording is an option: `HeardAudio` keeps the turn audio only when
  recordings are on, so playing someone's own voice needs a short-lived buffer of the turn instead (proposal). Names of
  rooms and people use the fuzzy matcher. A misheard room is a question, not a guess.
- **Output lease:** an announcement waits for the target device's current reply to reach a clause boundary (`high`)
  or its end (`normal`). It never interrupts the person who is speaking (the echo gate knows). On a device that is
  mid-turn, it is queued and played after that turn.
- **Interruption:** "stop" during an announcement stops it on that device only.
- **Agents:** every general assistant gets the module. A guest or children's assistant gets announce and read but not
  `send_to_phone` or DND everywhere. No template.
- **Intents:** "announce", "tell everyone", "what did I miss", "do not disturb" are typed actions with examples (fast
  path once Jev is wired).
- **Other modules:** timers, alarms, reminders, calendar, long tasks and routines all send through the service.
  Routines can use `notifications_announce` as a step and hooks as triggers. The briefing reads the unread count.

## 13. Privacy and safety

- Announcements are outward-facing: they speak in every room. The default audience is shared rooms, never bedrooms in
  quiet hours.
- A person's inbox is read only on that person's devices. On shared devices, "what did I miss" reads household items
  plus "and two personal items for Ian".
- Hooks are the main attack surface. They are LAN-only by default, use one token per hook (revocable), and have rate
  limits and size caps. Text is never treated as instructions. A hook cannot run tools: only a *routine* hook can, and
  only the owner-defined steps of that routine. The hook log in admin shows the caller IP and time.
- Phone payloads leave the house through vendor relays (HA's push relay, APNs, FCM, the ntfy.sh poll relay). Personal
  items are sent as "You have a reminder" unless the person allows full text on the lock screen.
- Children cannot announce during quiet hours and cannot send to adults' phones (household policy).

## 14. Foundations needed

Notification service (all of it), Event bus, Module store, Scheduler (DND end, expiry, escalation), Tool context
(origin and person), Device capabilities and place (room, privacy, `quietRoom`), Presentation (`card`, `list`, the
badge), Connection (HA, ntfy) and Requirements and health (the optional containers). Also new: the host hook endpoint,
shared with routines.

**A useful first version:** `notifications_announce` to all connected devices and to rooms, built on `Announce`, with a
chime; the inbox and `notifications_read`; per-device DND; one inbound `notify` hook. Phones, replies and escalation
come later. Announce alone needs only the `Announce` input and delivery by device in SessionHub (presentation §6.3),
not the store.

## 15. Open questions

1. **Which phone channel first?** This document proposes the HA companion app, then ntfy, with Web Push last. Shared
   state §8.7 proposes Web Push first and ntfy second. Which phones are in the house (iPhone, Android), and is the HA
   companion app already on them (presentation open question 6)?
2. **Is delivery through vendor relays acceptable** (HA push relay, APNs, FCM, ntfy.sh's id-only relay), or must
   phones stay fully local (then Android with self-hosted ntfy only)?
3. **Announce in whose voice:** the assistant's voice reading the transcript, or the speaker's own recorded voice, as
   Alexa and Google do?
4. **Replies to announcements without a wake phrase** for 30 s on every target device: acceptable, given that a TV
   could "reply"?
5. **Two-way intercom** (live audio between two devices, like Drop In): wanted at all? It is a large separate piece
   (WebRTC or server-relayed audio) and is left out here.
6. **Inbound hooks from outside the LAN** (a phone on mobile data): allow them behind the existing HTTPS option, or LAN
   and VPN only?
7. **Bedroom rule:** should announcements skip bedrooms in quiet hours automatically, which needs a `quietRoom` flag
   per device?
