# Presence and people

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
the Module manifest, Connection and Requirements and health
([`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md),
"module definition §n"), the Module store, Event bus, Notification service and Tool context
([`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md), "shared state
§n"), and Presentation and Device capabilities
([`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md),
"presentation §n"). What exists today is in [`current-system.md`](../module-investigation/current-system.md).

## 1. Summary

The module knows who lives in the house, who is home, which room they are in, and, as a hint, who is speaking. It
owns the `Person` records that shared state §4.6 proposes, turns several presence sources into one answer per person,
emits arrival and departure events for other modules (reminders, briefing, notifications, energy), and runs a guest
mode with a house guide.

**Boundary with [smart-home](smart-home.md).** Smart-home keeps the one Home Assistant (HA) WebSocket and its state
cache. This module reads `person.*`, `device_tracker.*` and room sensors through smart-home's `presence` and `areas`
exports and takes over the `who_is_home` tool (smart-home §4) and the `home-assistant.presence.changed` event
(smart-home §7), which become `presence_where` and `presence.*` here (Open question 1).

- **Priority: first wave for `Person` records and home/away presence, second wave for rooms, later for voice ID.**
  Person records block nine module documents (investigation §12 Q1). Home/away from HA is a few days of work and
  unblocks presence reminders.
- **Effort: M** overall. Records plus HA home/away are S. Room-level presence is S on top of HA, but its value depends
  on hardware the owner may not have. Speaker identification is M: enrolment, a per-turn embedding, and the
  measurements that decide whether it is turned on at all.

**Recommendation:** HA is the presence engine. Person records live in our household settings and link to HA `person`
entities. Speaker identification uses `sherpa-onnx-node`, which is already a dependency, and is only ever a hint for
*whose* data, never an authorisation.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| **Home Assistant `person`** ([docs](https://www.home-assistant.io/integrations/person/)) | A person combines several `device_tracker`s. Stationary trackers (router, Bluetooth) beat GPS when they say `home`, and GPS wins when away (from memory, unverified wording). State is a zone name, `home` or `not_home`. | Combining sources per person with a precedence rule. | Zone-only presence: HA's `person` has no room. |
| **HA companion app** | GPS, Wi-Fi SSID, and a BLE transmitter the phone can broadcast for room trackers ([companion docs](https://companion.home-assistant.io/)) | The phone as the one device everyone carries. | Battery drain from high-accuracy GPS. |
| **OwnTracks** ([HA integration](https://www.home-assistant.io/integrations/owntracks/)) | Phone app that posts location over MQTT or HTTP, region enter/leave events, no Google services needed. | Self-hosted location with regions. | Another app to keep running on every phone. |
| **Bermuda BLE** ([wiki](https://github.com/agittins/bermuda/wiki)) | HACS integration: ESPHome Bluetooth proxies assigned to HA areas give an `area` sensor per tracked phone, watch or tag. Supports rotating phone addresses through HA's Private BLE Device (IRK). Full trilateration is still pending. Users report it easier than ESPresense ([zorruno](https://zorruno.com/2024/replacing-espresense-with-bermuda-for-ble-tracking/), [Derek Seaman](https://www.derekseaman.com/2025/12/home-assistant-track-whos-in-each-room-with-esphome-bermuda-ble.html)). | Room per person from cheap ESP32s that may already be BT proxies. | Room-edge flapping: needs a hold time. |
| **ESPresense** ([espresense.com](https://espresense.com/)) | Dedicated ESP32 firmware per room, publishes distances over MQTT. | — | Harder to set up than Bermuda by user reports; needs MQTT. |
| **mmWave sensors** | Everything Presence Lite (LD2450, ESPHome, up to 3 targets and about 4 zones drawn in HA, [ESPHome devices](https://devices.esphome.io/devices/everything-presence-lite)); Aqara FP2 (Wi-Fi, zones set in the Aqara app, [review](https://computingforgeeks.com/best-mmwave-presence-sensor/)). | "Someone is in the kitchen", reliable even when sitting still. | They detect *a* person, never *which* person. |
| **Alexa Voice ID, Google Voice Match, Apple Personal Requests** | Enrolled voices pick whose calendar and music; Google and Apple fall back to non-personal answers for unknown voices (landscape-voice-assistants.md). | Personal results only for a recognised voice; guests get household answers. | Voice as a purchase or unlock factor. |
| **HA Assist** | No speaker identification; community projects (Speaker-ID, a verification proxy against TV noise, VoiceBM) add it outside core ([forum](https://community.home-assistant.io/t/speaker-recognition-in-voice-assistant/654276), [proxy](https://community.home-assistant.io/t/i-built-a-speaker-verification-proxy-that-filters-out-tv-noise-from-voice-commands/986233)). Maturity unverified. | Verification to reject a TV, not only to name a person. | — |
| **Google guest mode / Airbnb house manuals** | Guest mode stops personal results and history; house manuals hold Wi-Fi, rules and check-out steps. | A guest switch and a structured guide. | — |

## 3. Example conversations

1. Kitchen speaker. "Hey Jeff, is Sam home?" → "Sam is home, in the living room since ten past four." Room from
   Bermuda; without room sensors: "Sam is home since ten past four."
2. "Waar is Anna?" → "Anna is bij haar werk, sinds half negen." The HA zone name is spoken as the owner named it.
3. **Ambiguous.** "Where is Sem?" with Sam and Sem both in the house → "Sam or Sem?" Names are matched with the wake
   phrase matcher; two close matches lead to a question.
4. **Personal, refused.** Front-door node (`public`): "Where's Ian?" → "I don't say where people are from this
   speaker." On a `public` device only "someone is home" is allowed (smart-home §13).
5. **Voice hint.** Ian on the hallway speaker, which has no default person: "What's on my list?" → voice match 0.81
   for Ian → "Your to-do list, Ian: call the plumber and renew the passport." A low score asks instead: "Whose list:
   Ian's or Anna's?"
6. **Voice never unlocks.** "It's me, Ian, unlock the door." → refused by the smart-home risk policy whatever the
   voice score. Voice ID does not appear in any `security` decision (§13).
7. **Enrolment, needs a screen.** "Learn my voice." → "Read the five sentences on the screen, Anna." → after about
   30 s: "Done. I'll use it to pick your lists and reminders. Say 'forget my voice' any time."
8. **Guest mode, needs a screen for the QR code.** "We have guests, turn on guest mode." → "Guest mode is on until
   tomorrow noon. Personal things are hidden." Guest: "What's the Wi-Fi?" → "The guest network is Kwakkel-Gast. The
   code is on the screen." A Wi-Fi QR code appears.
9. **Failure.** HA is down. "Is anyone home?" → "I can't reach Home Assistant, so I don't know who's home. The last I
   heard, at 14:02, Anna was home."
10. **Arrival, proactive.** Sam comes home; the hallway screen shows "Welcome home, Sam" and the reminders module
    delivers "Sam, a reminder from Ian: feed the cat" on the first device in the room Sam is seen in.

## 4. Tools

Risk classes as in module definition §B.5. Latencies are estimates, to be measured with `TurnTrace`.

| Tool / action | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `presence_where` | `person?` (dynamic over household people; omitted = everyone) | Per person: `home`/zone, room if known, since when, source | R | safe (`read`), personal | <5 ms from cache | yes ("is X home", "waar is X") |
| `presence_who_is_here` | `room?` (default: the asking device's room) | People in that room, plus "someone" for unnamed mmWave presence | R | safe, personal | <5 ms | yes |
| `people_list` | — | Household members and active guests | R | safe | <5 ms | yes |
| `voice_enrol` | `person` (default: the device person), `restart?` | Starts a 5-phrase enrolment on this device; a `steps` presentation | W | changes data | 30 s session | no |
| `voice_forget` | `person` | Deletes that person's voice profile | W | changes data | <20 ms | yes |
| `whoami` | — | "I think you're Anna (fairly sure)" with how it was decided | R | safe | <5 ms | yes |
| `guest_mode` | `on` (boolean), `until?` (time phrase), `devices?` (default: shared and public devices) | State and end time | W | changes data | <20 ms | yes |
| `house_guide` | `topic?` (`wifi`, `rules`, `bins`, `checkout`, `heating`, free text) | The guide entry; `wifi` adds a QR `handoff` | R | safe; the Wi-Fi password is shown, never spoken unless the owner allows it | <10 ms | yes for `wifi` |
| `presence_history` | `person`, `since` | Arrivals and departures ("Sam left at 08:10, back at 15:40") | R | safe, personal | 100–500 ms (HA history) | no |

The model gets `presence_where`, `presence_who_is_here`, `house_guide` and `whoami` on general assistants. Enrolment
and guest mode are typed actions so they run without the model.

## 5. Integrate or build

| Part | Options | Recommendation |
|---|---|---|
| Person records | (a) our household settings; (b) HA `person` as the source | **(a)**, linked to an HA `person` by id. People exist without HA and carry fields HA lacks (default devices, voice profile, child flag). |
| Home/away | HA `person` (companion app, router, OwnTracks behind it); our own phone hook from Shortcuts/Tasker (reminders §7); "recently talked to a device" | **HA first**, phone hook second, device activity only as a "seen" hint. Do not build GPS handling. |
| Room | Bermuda `sensor.<tracker>_area`; ESPresense over MQTT; mmWave zones as anonymous occupancy; "last device that heard this person" | **Bermuda via HA** for named people, mmWave for anonymous occupancy, last-device as fallback. Room state needs a 30–60 s hold so a person in a doorway does not bounce. |
| Speaker ID | (a) `sherpa-onnx-node` `SpeakerEmbeddingExtractor` + `SpeakerEmbeddingManager` (in `sherpa-onnx-node@2.0.1`, read in `speaker-identification.js`); (b) Picovoice Eagle ([product](https://picovoice.ai/products/voice/speaker-recognition/)), commercial, key needed; (c) a Wyoming or HTTP speaker-ID service | **(a)**: already installed, local, the same worker as the recogniser. |

**Speaker ID in detail.** The manager offers `add({ name, v })`, `addMulti({ name, v: [...] })`, `search({ v,
threshold })` which returns a name or the empty string, and `verify({ name, v, threshold })`. `search` returns no
score, so the module keeps the enrolled vectors itself and computes the cosine similarity to report a confidence; the
manager is a convenience. Models are published under the sherpa-onnx release tag `speaker-recongition-models`
([docs](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html)): 3D-Speaker ERes2Net and CAM++,
WeSpeaker ResNet, NeMo TitaNet (names and sizes from memory, roughly 7–30 MB, unverified).

**Accuracy is good on paper and worse in a kitchen.** ERes2NetV2 reports an equal error rate of 0.61 % on full
VoxCeleb1-O trials, 0.98 % on 3 s and 1.48 % on 2 s ([paper](https://arxiv.org/pdf/2406.02167)). "Lights off" is
under a second, the 3D-Speaker paper notes that far-field and multi-device speech is clearly harder
([toolkit paper](https://arxiv.org/pdf/2403.19971)), and children's voices change. For a household of two to five
people this is closed-set identification, which is easier than verification against strangers, but our numbers must
come from enrolled household members on our own microphones, logged per turn (§12).

**Spoofing.** Speaker embeddings do not detect replay or cloned voices. A recording of Ian, or a cloned voice from a
podcast, scores as Ian. None of the searched sources covered anti-spoofing for these models. This is why voice is
never a key (§13).

## 6. Data

| What | Scope | Where | Shape |
|---|---|---|---|
| `Person` | household | household settings (new section), editable in admin | `{ id, name, aliases[] ("Sammie"), pronunciation?, kind: adult \| child, haPersonId?, haTrackers[]?, defaultDevices[], phoneChannel?, language? }` |
| Voice profile | person | Module store, `voice_profiles` | `{ model: "3dspeaker-eres2net-base", dim, vectors: Float32[] x 5–20, enrolledAt, lastUpdatedAt, threshold? }`; no audio is kept |
| Presence state | household, memory | in memory, rebuilt from HA at start | `{ person, home, zone, room?, since, source, confidence }` |
| Presence log | household | none: HA history holds it | — |
| Guest mode | household | Module store, `guest_mode` | `{ on, until, devices[], setBy }` |
| House guide | household | module settings, `records` field | `{ topic, title, body, spoken?, showOnly?, guestVisible }`; Wi-Fi SSID and password in the vault |
| Last voice match per turn | conversation | trace only | `{ turnId, person?, score, runnerUp, ms }` |

**Exports** (shared state §4.4): `people` (id, name, kind), `presence.now` (per person home/room), `presence.room(room)`
(who is in a room), `guest.active`. The Tool context's `person` field (shared state §4.5) is filled here:
`device-default`, `voice` with `confidence`, or `chosen` on a screen.

## 7. Long-running work and events

- **Subscriptions.** Through smart-home's socket: `person.*`, the configured `device_tracker.*`, Bermuda area sensors
  and mmWave occupancy `binary_sensor`s. No polling.
- **Events emitted** (the emitting module's name wins, investigation §11 #16): `presence.arrived` and `presence.left`
  (`{ person, zone, at }`), `presence.room` (`{ person, room, at }`, after the hold time), `presence.everyone_left`,
  `presence.first_home`, `guest.started`, `guest.ended`. Reminders (which listen for `presence.changed` today,
  reminders §7), briefing ("welcome home" digest), energy ("everyone left: the heating goes to eco") and
  notifications (where a person is) consume them.
- **Debounce.** Departure fires after 3 minutes away (owner setting), so a walk to the car does not announce a
  departure. Arrival fires at once.
- **Jobs.** `guest_mode` ends with a Scheduler job at `until`. Voice profiles may be refreshed by a background job
  that adds high-confidence turn embeddings (off by default; Open question 4).
- **Restart.** State is rebuilt from HA's current states. No arrival events are emitted for people who were home
  before the restart, so a restart never fires a burst of "welcome home".

## 8. Presentation

| Situation | Kind | Without a screen |
|---|---|---|
| "Who's home?" | `list` of people with a small zone or room line and "since" | One sentence per person, at most four |
| Enrolment | `steps`: five phrases, a level meter, a tick per phrase | Spoken prompts ("say: the quick brown fox…"); works headless but slower |
| Wi-Fi for guests | `handoff` with the QR code `WIFI:T:WPA;S:<ssid>;P:<password>;;` (the ZXing format phone cameras read) and the SSID as text | "The network is Kwakkel-Gast. The password is on the card by the door," unless speaking it is allowed |
| House guide | `card` per topic; `list` of topics | The `spoken` text |
| Arrival greeting | `text` "Welcome home, Sam" with lifetime `glance` on the entry screen | Nothing (no spoken greeting by default) |

The character can turn toward the person when voice ID names them (a `turn.activity` extension, docs/CHARACTERS.md
§5.2, designed only). No new character contract is needed.

## 9. Notifications and proactive behaviour

Nothing is spoken by this module unprompted by default. It feeds other modules' notifications with *where* a person is:
the Notification service's "device where the person was last active" (shared state §8.3) is improved by room presence.
Optional, owner-enabled: "everyone left and the front door is unlocked" as `high` to adults' phones (with smart-home's
`lock_status`), and a `low` inbox line when a child arrives home from school ("Sam got home at 15:40").

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | members (new section); guest mode defaults (duration 24 h, devices `shared` + `public`); who may ask where whom is | adults may ask about everyone; children about nobody |
| Module | presence sources (`ha`, `phone-hook`, `device-activity`); departure delay (3 min); room hold (45 s); voice ID on/off; model; threshold (proposed cosine 0.6, to be tuned); minimum speech length for a match (1.0 s); house guide records | `ha`; off |
| Assistant | module on/off; `offTools` | on for household assistants |
| Device | default person; "use voice ID here"; privacy (`private`, `shared`, `public`, presentation §5.2); entry device (for greetings) | none; on; — ; off |
| Person | HA `person` link; share location with the household (`exact`, `home-only`, `none`); voice profile | `home-only` |

**First run.** (1) Add people with names and aliases (and how they are pronounced, for recognisers). (2) Link each to
an HA `person`, if HA is connected. (3) Give personal devices a default person. (4) Optionally enrol voices. (5) Write
the guest Wi-Fi and house guide.

## 11. Native tools and dependencies

| Need | Where | When missing |
|---|---|---|
| HA with `person` entities (companion app or router trackers) | LAN | "I can't tell who's home without Home Assistant. I only know who talked to me last." |
| Bermuda or ESPresense plus BLE proxies or ESP32s | LAN, per room | Room answers fall back to "home"; the module's status line says "no room sensors". |
| Speaker embedding model (one ONNX file, unpacked like the speech models) | server, in the speech worker | Voice ID is `unavailable`: "I can't recognise voices; I'll go by the device." |
| Audio of the turn | server: the browser and voice nodes already stream 16 kHz PCM to the server | — |

## 12. Interaction with the rest of the system

- **Where voice ID runs.** In the existing speech worker, on the utterance's PCM after the end of speech, in parallel
  with the final transcript. It must not delay the turn: if the embedding is not ready when routing needs it, the turn
  uses the device-default person. Extra cost per turn is unknown; record `voiceId.ms` and the score in `TurnTrace`
  before turning it on by default.
- **Hot words.** People's names and aliases are fed to the recogniser's hot words where the provider supports it.
  Dutch names inside English speech ("Sem", "Joëlle") are the common failure.
- **TV rejection.** A side benefit: a turn whose best score is below every enrolled person on a device that has
  `voice ID: required` could be dropped, which is the community verification-proxy idea. Off by default; it would
  silence guests.
- **Other modules.** Reminders (`when: arrive_home`, `in_room`), lists and memory (whose "my"), calendar and google
  (whose account), music (whose Spotify), notifications (where to ring), briefing ("welcome home" digest), energy
  (away mode), cameras (known faces from Frigate are a different, camera-side identity; do not merge them in v1).
- **Assistants.** No template. Every household assistant gets the read tools; children's assistants get only
  `whoami` and `house_guide`.

## 13. Privacy and safety

- **Voice is a hint, never a key** (shared state §4.6). It picks whose list or reminders. It never satisfies a
  `money`, `message` or `security` confirmation and never unlocks a private reminder.
- **Location is personal.** Exact zones are given only to adults in the household and only when the person shares
  `exact`; `home-only` people are "home" or "out". Nothing is said on `public` devices, and guests hear only "someone
  is home" or nothing.
- **Voice profiles are biometric data** under the GDPR (Article 9 special category when used to identify). Consent per
  person, enrolment by the person themselves, "forget my voice" always available, vectors only (no audio), excluded
  from any export to outside services. Children are enrolled only by an adult.
- **Guest mode** hides personal content (calendar, reminders, memories, mail, presence), disables `voice_enrol`,
  and keeps the house guide. It ends automatically. The Wi-Fi password is shown, not spoken, by default.

## 14. Foundations needed

| Foundation | For |
|---|---|
| People and rooms (this module provides `Person` records) | everything |
| Tool context (`person`, `room`, `deviceId`) | "my", "here", voice hint |
| Device capabilities and `DevicePlace` | privacy, rooms, entry device |
| Event bus | `presence.*` events |
| Module store | voice profiles, guest mode |
| Presentation (`list`, `card`, `handoff`, `steps`) | who's home, the QR code, enrolment |
| smart-home's WebSocket cache and exports | HA presence |

**A useful first version without most of them:** `Person` records in settings, the device-default person, and
`presence_where` / `people_list` over the HA `person` entities read by the existing HA module's REST client. Effort S.

## 15. Open questions

1. **Ownership of presence.** Smart-home §4 lists `who_is_home` and §7 emits `home-assistant.presence.changed`; this
   document moves both here, with smart-home keeping only the socket. Agree? Reminders §7 also listens to
   `presence.changed`, so one name has to be chosen (proposed: `presence.arrived` / `presence.left`).
2. **Your presence source.** Do you run the HA companion app on every phone, or OwnTracks, or neither? Do you have,
   or want, Bluetooth proxies or mmWave sensors per room?
3. **Voice ID at all**, and where: only to pick whose data on shared speakers, or also to reject the TV?
4. **Adaptive profiles.** May high-confidence turns update a voice profile automatically (better accuracy, but a
   wrong match teaches the wrong voice)?
5. **Location sharing defaults** between adults: `exact` or `home-only`? And may adults ask where a child is?
6. **Speaking the guest Wi-Fi password:** allowed, or QR and printed card only?
7. **Person records in settings or in the store?** This document puts them in household settings (editable in admin,
   backed up with settings). Shared state §4.6 leaves it open.
