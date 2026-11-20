# Cameras and security

Research write-up, 2026-11-18. Not an approved design. It uses the shared foundations named in [README.md](README.md):
module definition ([`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md)),
shared state ([`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md))
and presentation ([`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md)),
cited as "module definition §n", "shared state §n" and "presentation §n".

## 1. Summary

The module brings the house's cameras, doorbell and alarm to voice and to the stage: "who is at the door" answered
from a snapshot, a doorbell press announced with a picture on the screens, live view, a spoken message to the
visitor, "did anyone come by today" from the event history, and arming the alarm. Disarming stays out of voice by
default.

**Boundary.** [smart-home](smart-home.md) sketches `camera_snapshot`, `alarm_arm` / `alarm_disarm` and the doorbell
event (smart-home §4, §7). [images-and-photos](images-and-photos.md) §5.4 sketches the camera snapshot as an image.
This module takes those tools over and works them out. It reads HA through smart-home's socket, talks to Frigate and
go2rtc directly, and hands pictures to the Presentation `/media/` proxy. Locks stay in smart-home.

- **Priority: second wave.** It needs Presentation (`image`), the Notification service and image input to models,
  none of which exist (current-system §5.3, §2.2). The doorbell announcement is the part people use daily.
- **Effort: M** for snapshots, doorbell announce, event history and arming. **L** with live WebRTC view and two-way
  talk, because they put a second media path next to our own audio on the device.

**Recommendation:** Frigate as the event and history source when it runs, HA camera entities otherwise. Descriptions
come from Frigate's own GenAI with a local model, or from a local vision model we call. A hosted model is opt-in per
camera.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| **Echo Show / Nest Hub** | "Show the front door" opens the feed; doorbell press shows it on every display and announces; Ring and Nest describe events with an AI line ("a person delivered a package", hosted). | One phrase for live view; picture with the chime. | Cloud-only video and descriptions. |
| **Frigate** ([0.16 notes](https://github.com/blakeblackshear/frigate/discussions/19536), [0.17 release](https://github.com/blakeblackshear/frigate/releases/tag/v0.17.0)) | Local NVR with object detection. 0.16 added face recognition (a face library, sub-labels on tracked people) and licence plates. 0.17 added GenAI review summaries with a title, description and a `normal` / `suspicious` / `dangerous` classification, custom viewer roles per camera, and local audio transcription with sherpa-onnx. 0.18 is in release candidates ([rc1](https://newreleases.io/project/github/blakeblackshear/frigate/release/v0.18.0-rc1)). | Review items as the unit of history; the classification as a priority hint; known faces as sub-labels. | Re-implementing detection. |
| **go2rtc** ([README](https://github.com/AlexxIT/go2rtc)) | Restreams RTSP, ONVIF and vendor protocols to WebRTC, MSE and HLS. Two-way audio for Tapo, ONVIF backchannel and RTSP sources, used in the browser over WebRTC. Bundled in Frigate and in HA. | WebRTC live view at sub-second latency; the backchannel. | — |
| **HA camera, `event` and `alarm_control_panel`** | `GET /api/camera_proxy/<entity_id>` JPEG; doorbells as `event` entities with `event_type` such as `ring` (from memory); alarm actions `alarm_arm_away`, `alarm_arm_home`, `alarm_arm_night`, `alarm_arm_vacation`, `alarm_disarm`, with `code_arm_required` defaulting to true ([entity docs](https://developers.home-assistant.io/docs/core/entity/alarm-control-panel)). | The alarm entity as the one interface over Verisure, Ajax, Risco and the `manual` panel. | Arming without a code fails on some panels ([forum](https://community.home-assistant.io/t/alarm-broken-since-v-2024-6-1/737961)); we must pass through the error. |
| **Doorbell two-way audio in HA** | Reolink doorbells need the RTSP stream for the backchannel; Amcrest AD410 stops firing the button while a backchannel is open unless other streams add `#backchannel=0` ([Reolink thread](https://community.home-assistant.io/t/2-way-audio-w-reolink-poe-doorbell/649469), [AD410 thread](https://community.home-assistant.io/t/full-duplex-two-way-audio-for-the-amcrest-ad410-without-breaking-the-doorbell-button-add-on-hold-to-talk-card/1020955)). | Push-to-talk, not open mic. | A talk session that breaks the doorbell button. |

## 3. Example conversations

1. **Doorbell, needs a screen for the picture.** Kitchen iPad chimes, shows the porch snapshot: "Someone's at the
   front door." "Who is it?" → "A man in a PostNL jacket holding a parcel." (Frigate's description, or our vision call.)
2. **Message to the visitor.** "Tell him to leave it by the shed." → "Saying that at the door." The doorbell speaker
   plays our TTS: "Please leave it by the shed, thank you." Outward-facing (§4).
3. **Live view, needs a screen.** "Show me the driveway." → live WebRTC view for 60 s in Presenter, the character
   small beside it. "Close that." ends it.
4. **History.** "Did anyone come by today?" → "Two people at the front door: a courier at 11:20 and someone at 15:05
   who rang and left after a minute. Want to see them?" → "Yes." → a `gallery` of the two snapshots.
5. **Known face.** "Who was at the door at three?" → "Frigate thinks it was Oma Ria, at 15:05." Only on private
   devices, and the word "thinks" stays.
6. **Arming.** Leaving: "Arm the alarm, we're going out." → "Armed away. The back window is open; it's bypassed."
   (the panel's own report).
7. **Disarm refused.** "Disarm the alarm." → "I don't disarm the alarm by voice. Use the keypad or the app."
8. **Ambiguous.** "Show the camera." with four cameras and a device in the kitchen → "Which one: front door,
   driveway, garden or the kitchen?" A device in the hallway defaults to the front door (owner mapping).
9. **Failure.** "Who's at the door?" with the vision model down → "I can show you the door, but I can't describe it
   right now." The picture is still shown.
10. **Headless speaker.** Doorbell press on the study node: "Someone's at the front door." "Who?" → the description
    only; "show me" → "I can't show pictures here. It's on the kitchen screen."

## 4. Tools

Risk classes from module definition §B.5, where `security` covers cameras, alarms and locks.

| Tool / action | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `camera_show` | `camera` (dynamic: names, aliases, `door`, rooms), `live?` (default true on WebRTC-capable screens), `seconds?` (default 60) | `image` or a live view presentation; `[shown …]` note for the model | R | `security` (viewing), per device | snapshot 0.3–0.8 s; live first frame ~0.5–1.5 s (unverified) | yes |
| `camera_describe` | `camera`, `question?` ("is there a parcel?") | One or two sentences; the picture shown where there is a screen | R | `security`; plus a model-privacy check (§13) | Frigate description when ready: <50 ms; own call 2–6 s local (unverified) | no (needs a vision model) |
| `door_events` | `since?` (default today), `camera?`, `label?` (`person`, `car`, `package`), `known?` | Count and short lines per review item; offer to show | R | `security` | 50–300 ms (Frigate API) | yes for "did anyone come by today" |
| `door_events_show` | `ids` or `last?` | `gallery` of snapshots | R | `security` | <1 s | no |
| `door_say` | `text` (≤ 140 chars), `camera?` (default the doorbell) | "Said at the door." | W | outward-facing (`message`): speaks to someone outside | TTS + push 1–2 s | yes for owner-defined quick messages ("we're coming") |
| `door_talk` | `camera?` | Opens push-to-talk on this screen device | W | `message` | 1–2 s setup | no |
| `alarm_status` | — | State (`disarmed`, `armed_home`, `armed_away`, `armed_night`, `armed_vacation`, `pending`, `triggered`) and open sensors | R | safe (`read`) | <5 ms cached | yes |
| `alarm_arm` | `mode` (`away`, `home`, `night`, `vacation`) | The panel's answer, including bypassed zones | W | `change` (makes things safer) | ~300 ms–2 s (cloud panels such as Verisure slower, unverified) | yes |
| `alarm_disarm` | — (no code by voice) | — | W | `security`, `deny` by default | — | no |

`camera_snapshot` in smart-home §4 and images §4 becomes `camera_show` with `live: false`.

## 5. Integrate or build

| Source | How | For | Against |
|---|---|---|---|
| **Frigate** HTTP API and MQTT | `GET /api/<camera>/latest.jpg`, `GET /api/events?cameras=&labels=&after=&limit=`, `GET /api/events/<id>/snapshot.jpg`, `GET /api/review?after=&severity=alert`; MQTT `frigate/reviews` and `frigate/tracked_object_update` for GenAI descriptions (paths from memory, check against the [API docs](https://docs.frigate.video/integrations/api)) | History, labels, faces, descriptions, all local | One more service; API changes between versions; since 0.16 the viewer role cannot use the HTTP API, so we need an admin or a custom role |
| **HA camera entities** | `camera_proxy`, `event` entities, the `frigate` HACS integration's entities | Works with any camera HA knows; one Connection | No history beyond state changes; no labels |
| **go2rtc** | WebRTC signalling on `/api/webrtc?src=<stream>` (from memory); backchannel through the same peer | Live view, two-way audio | Another port on the LAN for media; needs a secure context for the mic |
| **Vision model** | Frigate GenAI (provider set in Frigate's `genai` config) with Ollama and a local vision model (Qwen2.5-VL, Gemma 3, LLaVA: candidates, not tested); or our own call with the snapshot as image input | Local descriptions | A GPU or a slow CPU; image tool results are a core gap (images §14) |

**Recommendation.** Frigate when present for history and descriptions (it already runs the models and keeps the
review items); HA entities as the fallback and for the alarm. Live view through go2rtc's WebRTC in the voice page,
built as one presentation kind, not module code in the browser.

**Two-way talk options.** (a) **Speak our TTS at the door** (`door_say`): the server renders TTS and plays it into the
backchannel (go2rtc can push an audio source to a two-way stream; exact API unverified). No mic hand-off, works from
headless nodes. (b) **Push-to-talk on a screen**: the page opens a WebRTC peer to go2rtc with a mic track while our own
capture is paused (`audio.release`, then re-claim), so the assistant does not transcribe the conversation at the door.
**(a) first**; (b) only if wanted, because it is L and screen-only.

## 6. Data

| What | Scope | Store | Shape |
|---|---|---|---|
| Camera list and mapping | household | module settings | `{ id, name, aliases[], source: frigate \| ha, haEntity?, frigateCamera?, go2rtcStream?, area?, isDoorbell, describe: off \| local \| hosted, showOn: device ids }` |
| Door visits (our own summary) | household | Module store `visits`, 14 days | `{ at, camera, frigateReviewId?, labels[], description?, knownFace?, rang: bool, answered: bool, snapshotHash }` |
| Snapshots | household | `/media/` cache (Presentation), 24 h; visit thumbnails 14 days | JPEG, resized with `sharp` |
| Quick messages | household | settings records | `{ phrase: "we're coming", text: "We're coming, one moment." }` |

Frigate stays the system of record for video. We keep only what voice needs: a short visit log with one thumbnail.
**Exports:** `visits.today` (briefing: "two visitors today"), `alarm.state` (ambient line, off by default).

## 7. Long-running work and events

- **Listens:** `home-assistant.doorbell` (smart-home §7) or the doorbell `event` entity; Frigate `frigate/reviews`
  with `severity: alert` on the door camera; `alarm_control_panel` state changes; `presence.everyone_left`
  ([presence-and-people](presence-and-people.md) §7) to offer "Everyone's out. Arm the alarm?" (owner option).
- **On a doorbell press:** fetch the snapshot at once (do not wait for Frigate's description), notify, then update the
  notification with the description when `tracked_object_update` arrives (`present.update`). Dedupe two presses
  within 30 s.
- **Emits:** `cameras.doorbell` (`{ camera, snapshot, at }`), `cameras.visit`, `cameras.alarm.changed`,
  `cameras.alarm.triggered`.
- **Restart:** no jobs of its own. Visits are rebuilt from Frigate's review API for the day if missed.

## 8. Presentation

| Situation | Kind (presentation §3.2) | Layout | Without a screen |
|---|---|---|---|
| Doorbell | `image` with `sensitivity: "personal"`, lifetime `glance` (60 s), buttons "Talk", "Say we're coming", "Dismiss" | Hold-up, then Presenter | "Someone's at the front door," then the description if asked |
| Live view | proposed new kind `live` (WebRTC element with a server-issued, short-lived stream token), max 5 minutes | Presenter; the character small | "I can't show video here." + nearest screen offer |
| History | `gallery` of visit thumbnails with times | Presenter | Spoken list, top three |
| Alarm | `facts` (state, open sensors) | Presenter | One sentence |
| Triggered alarm | `card`, red, full stage | Takes the stage | Spoken, `critical` |

The `live` kind is new (presentation §3.2 has none for video; video.md proposes a `video` kind for media). It is the
only part of this module that needs new client code, and it must be generic (a WebRTC stream URL from our server),
never a camera address on the device.

## 9. Notifications and proactive behaviour

| Event | Priority | Audience | Quiet hours |
|---|---|---|---|
| Doorbell press | `high` | screens in `shared` rooms plus the entry device; speakers say one line | visual only on screens (shared state §8.2) |
| Person at the door, no press, Frigate alert | `low` by default; `normal` if the owner turns it on | inbox; screens near the door | inbox |
| Frigate review classified `dangerous` | `high` to adults' phones and private screens | — | phones only |
| Alarm triggered | `critical` | everywhere plus phones | ignored |
| Alarm armed or disarmed by someone else | `low` | inbox | — |

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | risk ceiling: `security` `deny` (module definition §B.5); hosted vision allowed at all | deny; no |
| Module | Frigate URL and credentials (Connection); go2rtc URL; cameras (records, §6); doorbell camera; describe mode per camera; quick messages; visit retention (14 days); "offer to arm when everyone leaves" | — ; off |
| Assistant | module on/off; `offTools` (`door_say`, `alarm_arm`) | off on children's assistants |
| Device | `allowRisky` (needed for any camera view); cameras shown here; doorbell pictures here; privacy | off; none; on for `shared` screens; — |
| Person | receive `dangerous` alerts on the phone | adults on |

**First run.** (1) Connect HA (exists) and optionally Frigate. (2) Import cameras, name them, mark the doorbell. (3)
Pick which screens may show cameras. (4) Choose describe mode per camera. (5) Pick the alarm panel; arming only.

## 11. Native tools and dependencies

| Need | Where | When missing |
|---|---|---|
| HA camera / `event` / `alarm_control_panel` entities | LAN | "There's no camera set up for the front door." |
| Frigate 0.16+ (optional) | LAN | History and labels fall back to HA state: "I only know the doorbell rang at 11:20." |
| go2rtc (in Frigate or HA, or standalone) | LAN | Live view off: "I can show a snapshot, not live video." |
| Local vision model (Ollama or Frigate GenAI) | a GPU box or the server | "I can show you, but I can't describe camera pictures." |
| `sharp` | server | needed by Presentation anyway |
| HTTPS on the voice page | screens | needed for push-to-talk only; already needed for the mic |

## 12. Interaction with the rest of the system

- **Voice.** Camera names are short and fixed: "voordeur", "oprit", "tuin" as aliases. "The door" maps to the
  doorbell camera. "Who's there?" within 2 minutes of a press means the door, without naming it.
- **Fillers.** `camera_describe` without a ready Frigate description says "Let me look" first.
- **Interruption.** A barge-in during `door_say` does not stop audio already pushed to the doorbell.
- **Character.** During live view the character is small and attentive, not speaking. On a press, a short
  "turn to the door" activity (designed-only extension).
- **Other modules.** Presence (known people home), notifications (delivery), images (the shared `image` kind and
  `/media/`), briefing (visits today), smart-home (locks: "unlock the door for the courier" stays refused).

## 13. Privacy and safety

- **Disarm by voice: never by default.** A speaker cannot tell a resident from a TV or a visitor shouting through the
  letterbox. Arming is allowed because it makes the house safer. Disarm needs the household ceiling raised, a trusted
  device and core confirmations, which are off today (current-system §2.5).
- **No codes by voice** (smart-home §13). The panel's code is a vault secret used only for arming when
  `code_arm_required` is set.
- **Camera views are `security`**: only on devices with `allowRisky`, never on `public` devices. The doorbell picture
  on shared kitchen screens is a deliberate owner exception, limited to the doorbell camera.
- **Dutch rules.** The Autoriteit Persoonsgegevens' main rule is that you may in principle film only your own
  property, not the public road or neighbours, with a debated exception for the unavoidable part of the road, and
  footage should be kept briefly or not at all ([summary of AP guidance](https://id.nl/zekerheid-en-gemak/alarm-en-beveiliging/alarm-beveiliging/slimme-deurbel-en-privacy-dit-zijn-de-regels),
  AP text itself not checked). The EU Court held in *Ryneš* (C-212/13, 2014, from memory) that a home camera covering
  the street is not purely household processing, so the GDPR applies. Short retention (14 days for thumbnails) and no
  hosted processing by default follow from that.
- **Hosted vision models.** A visitor's face sent to a US model provider is a transfer of someone else's personal
  data. Off by default; opt-in per camera, never for indoor cameras, and never for known-face matching.
- **Indoor cameras** are excluded from voice by default: no describe, no history, view only on private devices.

## 14. Foundations needed

Presentation (`image`, `gallery`, `facts`, new `live`), `/media/`, image input to models (core gap), Notification
service (`high`, `critical`, `present.update`), Event bus, Device capabilities with `allowRisky` and privacy, risk
classes, Connection (Frigate), smart-home's socket.

**First version without most of them:** a doorbell press spoken on every device ("someone's at the front door"),
`alarm_status` and `alarm_arm`, and `door_events` read from Frigate as speech only. No pictures. Effort S.

## 15. Open questions

1. **Ownership.** This document takes `camera_snapshot`, `alarm_arm` / `alarm_disarm` and the doorbell event out of
   smart-home §4 and §7. Agree, with smart-home keeping locks and the socket?
2. **Risk class of viewing.** Smart-home §4 calls `camera_snapshot` safe but personal; images §13 and module
   definition §B.5 call cameras `security`. I side with `security` for viewing and propose the doorbell picture on
   shared screens as an explicit exception. Agree?
3. **Do you run Frigate**, and on what hardware (a Coral, an Intel iGPU, a GPU that could also run a vision model)?
4. **Hosted vision** for the front door only, or local only, or no descriptions at all (smart-home Q4, images Q6)?
5. **Two-way talk:** is "say a sentence at the door" enough, or do you want real push-to-talk on screens (L)?
6. **Which doorbell and alarm** do you have (Reolink, Ring, Nest; Verisure, Ajax)? Cloud-only ones change the
   latency and reliability story.
7. **Known faces:** use Frigate's face recognition in answers ("Oma Ria was at the door") at all?
