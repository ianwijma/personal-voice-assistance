# Calls and intercom

Research write-up, 2026-11-18. Not an approved design. Code references are `main` at `70b15ec`. Shared foundations
are named as in [`README.md`](README.md) and linked, not redesigned. Claims marked **[unverified]** or **[from
memory]** were not confirmed in a primary source during this session.

## 1. Summary

Live, two-way audio (and video where both ends have a camera) between the household's own devices, and later with
phones and people outside the house: "call the kitchen", "video call the living room", "drop in on the study", a
room-to-room intercom, a baby-monitor listen-in, group calls, and the assistant as a participant that can take notes or
translate. This is the owner's idea: "a call module where you can call other devices on the network, maybe a video
call if the device has a camera; WebRTC should be able to support this."

**Boundaries.** One-way messages ("tell everyone dinner is ready", recorded voice messages, scheduled chimes) are
[broadcast](broadcast.md), built on the `Announce` of the [notifications](notifications.md) service; notifications §15
Q5 left two-way intercom out, and this document picks it up. Text messages to people are [messaging](messaging.md).
Who "Sam" or "Mum" is comes from [contacts](contacts.md). "Call for help" and its escalation are
[emergency-and-safety](emergency-and-safety.md), which may *use* a call. Stop, volume and mute stay with
[assistant-controls](assistant-controls.md); a call adds its own words ("hang up", "answer").

- **Priority: second wave** for stage 1 (audio intercom between house devices, relayed by our server), **later** for
  video, group calls, phones and the assistant as participant. Nothing else depends on it, and it needs the device
  capabilities, rooms and the ringing window first.
- **Effort: XL in total, delivered in four stages** (§5.6): stage 1 audio intercom over the existing audio path **M**;
  stage 2 browser-to-browser WebRTC video **M–L**; stage 3 a self-hosted SFU (LiveKit) for groups, outside callers,
  voice nodes as WebRTC peers and the assistant in the call **L**; stage 4 a SIP bridge to the phone network **L**,
  optional.

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| Alexa Calling and Drop In | Echo-to-Echo calls; Drop In is opt-in per contact and per device and connects without answering; "Drop In on Home" lists devices that accept it ([TechRadar](https://www.techradar.com/how-to/what-is-alexa-drop-in-and-how-to-use-it-on-an-amazon-echo), [Pocket-lint](https://www.pocket-lint.com/how-to-set-up-and-use-drop-in-on-amazon-echo-devices/)). On an Echo Show the video first shows frosted glass for about 10 s so the callee can decline or go audio-only (2017 report, [Verge mirror](https://thevergetoday.pages.dev/circuitbreaker/2017/5/9/15593378/everything-you-might-have-missed-amazon-echo-show); current behaviour **[unverified]**). Approved contacts see a "recently active" indicator ([Tom's Guide](https://www.tomsguide.com/us/change-this-one-alexa-setting-now,review-5782.html)). | Drop In as a per-device, per-caller permission; a grace period with blurred video; DND blocks calls. | Presence leaks ("recently active") to people outside the house; a TechCrunch-reported privacy scare around unannounced video ([TechCrunch](https://techcrunch.com/2017/06/28/amazon-disputes-claims-that-echo-shows-drop-in-feature-is-a-security-risk/)). |
| Apple Intercom, Google Broadcast | One-way, not calls (see [broadcast](broadcast.md#2-what-others-do)). | — | — |
| Home Assistant VoIP | A SIP endpoint for Assist only: an analogue phone behind a Grandstream HT801 talks to the voice pipeline ([integration](https://www.home-assistant.io/integrations/voip), [project](https://www.home-assistant.io/voice_control/worlds-most-private-voice-assistant/)); making the phone *ring* from HA is a reported gap ([forum](https://community.home-assistant.io/t/how-to-make-grandstream-ht802-ring-via-home-assistant/766987)). | An old phone as one more "device". | It is not a phone system; do not build on it for person-to-person calls. |
| Element Call / MatrixRTC | Matrix calls over a LiveKit SFU, with `lk-jwt-service` exchanging a Matrix OpenID token for a LiveKit JWT ([repo](https://github.com/element-hq/lk-jwt-service), [setup notes](https://sspaeth.de/2024/11/sfu/)). Self-hosting reports show moving paths and versions. | Our own token service in front of LiveKit is the same pattern. | Depending on Matrix for calls inside the house. |
| Zoom web SDK | Gates its echo handling on "Chrome-wide AEC" (Chrome ≥ 111 desktop), which lets the browser's canceller see non-WebRTC output ([Zoom dev forum](https://devforum.zoom.us/t/issupportchromewideaec-sniffs-browser-name-version-breaking-echo-cancellation-on-microsoft-edge/145288)). | Evidence for how a call and our Web Audio replies can share one microphone (§12). | — |

## 3. Example conversations

S = needs a screen; V = needs a camera on both ends.

1. Study laptop: "Hey Jeff, call the kitchen." → "Calling the kitchen." Kitchen tablet: ring cue, card "Study is
   calling" with Answer / Decline. In the kitchen, no wake phrase while it rings: "Answer." → both hear each other.
   Later, study: "Hey Jeff, hang up." → a short cue on both ends. (S optional.)
2. "Video call the living room." (S, V) → the living-room tablet rings; on answer, the remote video fills the stage
   and the character moves to a corner. The callee can say "audio only" before or during the call.
3. Drop-in. Kitchen: "Drop in on the study." → the study device plays a two-tone cue, says "The kitchen is dropping
   in", shows a red "Live: kitchen" banner, and the audio opens after 3 s. Allowed only because the study allows drop-in
   from household devices (§13).
4. "Intercom the kids' room: time to get up." → one-way, so it goes to [broadcast](broadcast.md), not a call.
5. Ambiguous: "Call Sam." with Sam having a phone link and a bedroom tablet → "Sam's room or Sam's phone?" With no
   people configured: "I don't know who Sam is. You can add people in the admin page."
6. Declined: "Call the bedroom." → the bedroom has do-not-disturb → "The bedroom is on do not disturb until seven. Shall
   I leave a voice message instead?" (offers [broadcast](broadcast.md) voice messages).
7. Failure: "Call the garage." → the garage node is offline → "The garage speaker is offline, so I couldn't call it."
8. Baby monitor: "Listen to the nursery." → refused unless the nursery device has listen-in turned on by the owner
   for this device or person; then "Listening to the nursery. Say 'stop listening' to end." The nursery device shows
   or plays its listen-in indicator (§13).
9. Group: "Call the kitchen and the study." (stage 3) → one room, three devices; "add the living room" joins a fourth.
10. Outside (stage 3): "Send Oma a call link." → a one-use link via [messaging](messaging.md); she taps it and calls.
11. Assistant in the call (stage 3): "Hey Jeff, take notes on this call." → "I'm listening and taking notes; everyone
    on the call will hear that." Afterwards: "Here are the three things you agreed …" (stored via
    [memory-and-notes](memory-and-notes.md)).

## 4. Tools

Risk classes are the template's three, with the [module-definition B.5](../module-investigation/module-definition-config-and-dependencies.md#b5-risky-tools)
class in brackets. Latencies are targets, to be measured with `TurnTrace` and a new call trace (§12).

| Tool | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `call_start` | `target: dynamic` (device, room, person, contact), `video?: boolean`, `mode?: "ring" \| "drop_in"` | call id, who is being rung, or why not (DND, offline, not allowed) | W | outward-facing (`message`) inside the house; `money` for phone numbers | < 300 ms to ringing | yes ("call the kitchen") |
| `call_answer` | `audioOnly?: boolean` | connected | W | safe | < 200 ms to audio | yes, wake-free while ringing |
| `call_decline` | `reason?: "busy" \| "dnd"` | declined; offers a voice message to the caller | W | safe | < 100 ms | yes, wake-free while ringing |
| `call_hang_up` | — | ended, duration | W | safe | < 100 ms | yes (with wake phrase during a call) |
| `call_status` | — | active calls on this device and in the house, participants, duration | R, speculative | safe | < 10 ms | yes |
| `call_mute` | `what?: "mic" \| "camera"`, `off?: boolean` | muted state | W | safe | < 100 ms | yes |
| `call_add` | `target: dynamic` | joined (stage 3) | W | outward-facing | < 500 ms | yes |
| `listen_in_start` | `target: dynamic`, `minutes?: number` (default 30) | listening, or refused with the reason | W | outward-facing (`security`: covert listening) | < 300 ms | yes, but only where allowed |
| `listen_in_stop` | — | stopped | W | safe | < 100 ms | yes |
| `call_link_create` | `person: dynamic`, `validMinutes?: number` (default 60), `video?: boolean` | a one-use URL, sent through messaging or shown as QR | W | outward-facing (`message`) | < 100 ms + channel | no |
| `call_assist` | `task: "notes" \| "translate"`, `language?` | the assistant joins as a participant and announces itself | W | outward-facing (audio of others to the model) | 1–2 s | no |

Ringing, accepting and declining are not only tools: the ringing state is a Notification of kind `question` with
`requireAck`, so its wake-free "answer / decline" runs through the notification service's ringing window
([shared-state §8.4](../module-investigation/shared-state-jobs-and-notifications.md#84-acknowledging-and-snoozing-by-voice))
and the control matcher of [assistant-controls](assistant-controls.md#5-integrate-or-build), never through a model.

## 5. Integrate or build

### 5.1 What exists to build on

Browser devices already capture the microphone with `echoCancellation`, `noiseSuppression` and `autoGainControl` on
(`apps/web/src/lib/audio/VoiceAudio.ts:64`), resample to 16 kHz s16le in a worklet, and send 20 ms binary frames
over `/ws`. Replies come back as binary frames played by a worklet player, either straight to `ctx.destination` or
through a `MediaStreamAudioDestinationNode` and an `<audio>` element (the "output path", `VoiceAudio.ts:545`). Frames
have an 8-byte header with a kind byte: 1 = mic, 2 = reply (`packages/protocol/src/frames.ts:4`). The page ignores
unknown server messages ([current-system §5.3](../module-investigation/current-system.md#53-a-channel-for-tools-to-push-visual-content-absent)),
so new `call.*` messages are additive. Voice nodes (designed on unmerged branches) speak the same WebSocket protocol
with `arecord`/`aplay` child processes, one-shot activation, and rely on hardware AEC
([VOICE-NODES §2, §7.2 on `t3/voice-node-wp4`]). Browsers allow the microphone, and so the camera, only in a secure
context: HTTPS or `localhost` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/navigator/mediaDevices.getUserMedia));
the server warns about this today (`apps/assistant/src/serve/serveMode.ts:1507`). Nodes are not browsers and work over
`ws://`.

### 5.2 Transport options

| Option | How | For | Against |
|---|---|---|---|
| **A. Relay through our server on the existing audio path** | Device A's mic frames (kind 1) are forwarded by the server to device B as a new frame kind 3 "call audio" with a call-leg id in the u32 field; B plays it in a second worklet queue | Works today for browsers *and* voice nodes with no new library; no NAT, STUN or TURN; the server can mix, record (only if asked), and let the assistant listen (notes); DND and permissions enforced in one place | Audio only; 16 kHz mono (wideband, fine for speech); TCP; latency = capture 20 ms + WS + server + player prebuffer, estimated 80–200 ms on a LAN **[unverified, measure]**; the server carries every stream (16 kHz s16 = 256 kbit/s per direction, trivial on a LAN) |
| **B. Browser-to-browser WebRTC, our server as signalling** | `RTCPeerConnection` on both pages; `call.offer`, `call.answer`, `call.ice` relayed over `/ws`; Opus audio, VP8/H.264 video, peer to peer on the LAN | Video; Opus with jitter buffer and FEC; the browser treats remote WebRTC audio as the echo-cancellation reference ([browser-audio §3](../browser-audio.md)); no media on the server | Browsers only; mesh beyond three or four participants is heavy (each sends N−1 video streams); needs TURN from outside; the assistant cannot hear the call |
| **C. A self-hosted SFU** | Each participant publishes once to the SFU and subscribes to the others | Groups, outside callers, server-side participants (the assistant, a voice node proxied by the server), recording on request | One more service to run, upgrade and secure; ports to open |
| **D. SIP / PBX** | Asterisk or FreePBX with WebRTC endpoints (`chan_pjsip`, WSS) and a SIP trunk; JsSIP or SIP.js in the page **[from memory]** | Real phone numbers in and out | Large, separate system; trunk costs; emergency-number obligations (§13) |

### 5.3 Which SFU, if one is needed

| SFU | Shape | License | Fit |
|---|---|---|---|
| **LiveKit** | Go server built on Pion, one binary or container, built-in TURN, client SDKs for the browser and `@livekit/rtc-node` for Node ([LiveKit server](https://pkg.go.dev/github.com/livekit/livekit-server@v1.13.3), [rtc-node](https://npmjs.com/package/@livekit/rtc-node)); `agents-js` adds programs as full participants ([docs](https://docs.livekit.io/agents)); a SIP service exists **[from memory]** | Apache 2.0 (server and rtc-node) | **Best fit**: it covers groups, outside callers, nodes (rtc-node in a Node 22 program), the assistant as a participant and a later SIP bridge with one system |
| mediasoup | C++ media workers driven from a Node library; we write signalling and rooms ourselves | ISC | Good if we want the SFU *inside* our server process; more code for us ([forasoft comparison](https://www.forasoft.com/learn/video-streaming/articles-streaming/sfu-comparison-mediasoup-janus-livekit-jitsi-pion)) |
| Janus | C gateway with plugins (VideoRoom, AudioBridge with server-side mixing, SIP) | GPLv3, commercial licence available | AudioBridge and SIP plugins are attractive; GPL and a C service to operate |
| Own Pion sidecar | A small Go program | MIT (Pion) | Only for one narrow job, such as a node's WebRTC endpoint |

**When an SFU is needed:** more than three participants with video; any caller outside the LAN; a server-side
participant (assistant, recorder, voice node via the server); phone bridging. **When it is not:** two house browsers
in a call (B) or audio between any devices (A).

### 5.4 Headless voice nodes as call endpoints

| Option | What runs on the node | Verdict |
|---|---|---|
| Relay over the existing socket (A) | Nothing new: the node already streams mic frames and plays frames; it needs a "call" activation that keeps the mic open and plays kind-3 frames | **Stage 1.** Zero new dependencies. |
| `@livekit/rtc-node` on the node | The node joins the LiveKit room itself | Stage 3 option; native prebuilt binaries per platform, arm64 Linux support **[unverified]**; adds Opus and a jitter buffer on a Pi |
| Server as the node's proxy participant | The node keeps its WebSocket; the server publishes its audio into the LiveKit room with rtc-node and plays the room's mix back as kind-3 frames | **Stage 3 default.** Keeps the node thin, as VOICE-NODES intends |
| `node-datachannel` (libdatachannel bindings, media tracks since 0.2) or `werift` (pure TypeScript ICE/DTLS/SRTP, needs a separate Opus codec such as `@discordjs/opus`) | A peer connection inside Node | Possible for B without an SFU ([werift](https://www.Github.com/shinyoshiaki/werift-webrtc), [node-datachannel](https://cdn.jsdelivr.net/npm/node-datachannel@0.32.2/README.md)); maturity of media paths **[unverified]** |
| GStreamer `webrtcbin`, or a Pion sidecar | A native pipeline beside the node program | Most capable on a Pi (hardware codecs), heaviest to install; skip unless nodes get cameras |

### 5.5 Calling from outside, NAT, TURN and certificates

- **On the LAN** no STUN or TURN is needed: host candidates connect. Chrome hides local addresses behind mDNS
  `.local` candidates unless the page holds a getUserMedia permission **[from memory]**; our pages do, and mDNS works
  on most home LANs anyway.
- **From outside**, three routes: (1) **Tailscale** on the phone and the server: every device has a tailnet address,
  host candidates work, and `tailscale cert` gives a publicly trusted `*.ts.net` certificate (Let's Encrypt via
  DNS-01, 90 days, MagicDNS required) that also solves the secure-context problem
  ([Tailscale](https://tailscale.com/kb/1153/tailscale-cert)). (2) **coturn** with `use-auth-secret` and
  `static-auth-secret`, issuing short-lived `timestamp:username` credentials signed with HMAC
  ([man page](https://man.archlinux.org/man/coturn.1.en)); needs a public port (3478, plus a relay range) and a
  reachable address. (3) **LiveKit's built-in TURN** behind the same domain. Recommendation: Tailscale first (no open
  ports, the owner may already use it), coturn or LiveKit TURN only for guests who will not install anything.
- **Certificates for house devices.** A wall tablet opening `http://192.168.1.20:8787` gets no microphone and no
  camera. Options: a real domain with a DNS-01 certificate (the module-definition document's open question 4), the
  Tailscale name, or a local CA installed on each tablet. Chrome's `--unsafely-treat-insecure-origin-as-secure` flag is
  unsupported and has stopped working for some users ([Chromium security-dev](https://groups.google.com/a/chromium.org/g/security-dev/c/QSj4QT5xKXM)): not a plan.
- **Camera permission** is a second prompt per origin; kiosk browsers must be set to grant it. Our page asks for the
  camera only when a video call is answered or placed, never at start.

### 5.6 Recommendation and stages

| Stage | What | Effort | Needs |
|---|---|---|---|
| 1 | **Audio intercom relayed by the server** (A): ring, answer, decline, hang up, drop-in with rules, DND, browser and node endpoints, no video | **M** | ringing window, device rooms, people (for "call Sam"), a `call` activation on nodes |
| 2 | **Video between browsers** (B): WebRTC P2P with `call.*` signalling on `/ws`, camera opt-in per device, video on the stage; audio-only calls may stay on A | **M–L** | HTTPS on every screen device |
| 3 | **LiveKit**: groups, call links for phones (`livekit-client` in a tiny page), nodes via the server proxy, assistant participant (notes, translation), Tailscale or TURN | **L** | a LiveKit container, our token endpoint, the Connection for its API key |
| 4 | **SIP bridge** (LiveKit SIP or Asterisk) to call real numbers | **L**, optional | a trunk, money, the §13 limits |

Stage 1 first because it is the only one that reaches voice nodes without new native code, and it proves the call
state machine, the ringing window and the privacy rules before any media stack is added. Measure its latency; if
mouth-to-ear on the LAN stays under ~250 ms it may remain the audio path even after stage 2 **[target, unverified]**.

## 6. Data

| What | Scope | Shape | Readable by |
|---|---|---|---|
| Call permissions | device (callee side) | `{ acceptCalls: bool, dropIn: "nobody" \| "household" \| list of devices/people, listenIn: { allowedFrom: [...], indicator: "light" \| "tone" \| "both" }, video: bool, autoAnswer: bool }` | this module, admin |
| Calls (log) | household | `{ id, from, to[], kind: "call" \| "drop_in" \| "listen_in", media: "audio" \| "video", startedAt, answeredAt?, endedAt?, endedBy, assistantJoined? }`; kept 30 days, never audio | admin, [briefing](briefing.md) ("missed call from the kitchen") |
| Missed calls | person or device | a Notification (inbox), not a separate table | notifications |
| Call links | household | `{ tokenHash, person, expiresAt, usedAt?, video }`; token in the vault | this module |
| Notes from a call | person | stored by [memory-and-notes](memory-and-notes.md), with the participants named | memory |

No call audio or video is stored. A recording, if ever offered, is a separate opt-in with an announcement to every
participant (open question 6).

## 7. Long-running work and events

| Part | Detail |
|---|---|
| State machine | one per call in the server: `ringing → connected → ended`, plus `declined`, `missed` (ring timeout 30 s), `failed`; drop-in skips `ringing` after a 3 s warning; listen-in auto-ends after its minutes |
| Scheduler jobs | ring timeout, listen-in end, call-link expiry |
| Events emitted ([Event bus](../module-investigation/shared-state-jobs-and-notifications.md#5-event-bus)) | `calls.ringing`, `calls.connected`, `calls.ended`, `calls.missed`, `calls.listen_in.started` / `.ended`; music and video pause in the rooms of a connected call; timers still ring (mixed in, the call ducked) |
| Listens to | device disconnect (ends that leg), `dnd.changed`, `notification.resolved` (answered from another tab) |
| Restart | calls end, nothing resumes; pages say "the call ended because the assistant restarted"; the log row is closed at the next start with `endedBy: "restart"` |

## 8. Presentation

| Situation | Screen | Headless node |
|---|---|---|
| Ringing | a `card` "Study is calling" with Answer, Audio only, Decline, held up by the character (Hold-up, [presentation §4.1](../module-investigation/presentation-and-device-capabilities.md#41-layouts-host-level-every-character)) | ring cue on repeat, then "The study is calling. Say answer or decline." |
| Audio call | character centred in Orbit with a docked badge "Kitchen · 2:14" and a mute button; mode stays `idle`, so every existing character works unchanged ([CHARACTERS.md](../../CHARACTERS.md)) | call audio only |
| Video call | a new host-level layout, **Call**: remote video fills the stage, self-view in a corner, the character perched small (Companion-like, ~35 %) so it is still visibly there for "hey Jeff, hang up"; needs a `call` or `video` kind, which [video Q1](video.md#15-open-questions) also asks for (one decision for both) | — |
| Drop-in, listen-in (callee) | a full-width red "Live: kitchen" bar that cannot be hidden, character in `listening` the whole time | a soft tone every 30 s |

## 9. Notifications and proactive behaviour

- Ringing is a Notification: kind `question`, priority `high`, `audience: { devices }`, `requireAck`, `ring: "origin"`
  (the callee device only), so quiet hours and DND apply as for any `high` item
  ([shared-state §8.2](../module-investigation/shared-state-jobs-and-notifications.md#82-priority-and-what-each-may-do)):
  in quiet hours a call rings visually only, unless the caller is an owner-listed "may ring at night" person.
- A missed call is an inbox item on the callee ("Missed call from the kitchen at 18:05"). Nothing else is proactive:
  no "would you like to call Oma? It's her birthday".

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | calls on; who may drop in on whom (household devices only); ring timeout (30 s); calls in quiet hours visual-only; outside calls on/off; TURN or Tailscale | on; nobody; 30 s; on; off; none |
| Module | LiveKit URL and API key/secret (a Connection, stage 3); coturn shared secret; call-link lifetime (60 min); allow the assistant as participant | — ; — ; 60 min; off |
| Assistant | module on/off, `offTools` (a guest assistant: no `listen_in_*`, no `call_link_create`) | on, without listen-in |
| Device | accept calls; drop-in from (nobody / household / list); listen-in allowed from (list) and indicator; camera allowed; auto-answer (for a kitchen tablet); "call" activation on nodes | on; nobody; nobody; off; off; on |
| Person | reachable by call link; may ring at night; preferred device for "call Sam" | off; off; last active |

**First run:** nothing for stage 1 beyond rooms and device names. Stage 2: HTTPS on every screen device and a camera
test per device ("Test camera" field action, BUILT NOT WIRED today). Stage 3: start the LiveKit container, paste its
key and secret, choose Tailscale or TURN.

## 11. Native tools and dependencies

| Dependency | Where | When missing |
|---|---|---|
| nothing new for stage 1 | — | — |
| HTTPS certificate (domain, Tailscale or local CA) | server | "Video calls need this screen to open the assistant over https. The admin page explains how." |
| Camera and its permission | screen device | "This device has no camera, so it's audio only." |
| LiveKit server (`livekit/livekit-server` container), its TURN or coturn | LAN host | "Group calls and calls from outside aren't set up." |
| `@livekit/rtc-node` (native) | server; optionally nodes | stage 3 node calls fall back to relay A |
| AEC hardware (USB speakerphone) | voice node | calls work, but the other side hears an echo; admin warns |
| SIP trunk, Asterisk or LiveKit SIP | server / provider | "I can't call phone numbers." |

## 12. Interaction with the rest of the system

- **One microphone, two users.** The page has one getUserMedia track with AEC on. During a call the same track feeds
  both the call (a `track.clone()` added to the peer connection, or the existing frames forwarded in relay A) and the
  assistant's recogniser, so "hey Jeff, hang up" still works. A second getUserMedia with other constraints must not be
  opened. Echo: remote WebRTC audio is the reference browsers cancel best; our Web Audio reply output is cancelled
  only where the browser references it (Chrome-wide AEC from about Chrome 111 on desktop per Zoom, Safari and Firefox
  reportedly yes; Android Chrome **[unverified]**), so the assistant's own speech may leak into the call. In relay A
  the call audio is Web Audio too; the existing "Test echo" plan in [browser-audio §3](../browser-audio.md) applies.
- **Routing during a call.** A device in a call switches its route gate to "phrase only": no `withoutPhrase`
  assistant, no TypeSafe `decide`, no follow-up windows. Otherwise every sentence said to Oma would become a turn. The
  recogniser keeps running to hear the wake phrase; call transcripts are not kept, not logged and not shown as
  captions (except when the assistant was asked to take notes).
- **Wake phrase from the other end.** The remote voice is played out of the local speaker; AEC removes most of it, and
  the echo gate's comparison with played words does not cover call audio. Proposal: during a call, accept the wake
  phrase only when local speech energy dominates the call output in that window; measure false triggers.
- **The assistant during a call** replies on the local device only, ducking the call audio by about 12 dB. In stage 3
  the assistant can be mixed into the call on request ("tell everyone on the call the weather") via `call_assist`.
- **Voice nodes** get a third activation next to one-shot: `call`, entered by the server, leaving the mic open and
  playing kind-3 frames until hang-up; "hey Jeff, hang up" is accepted in it.
- **Fast path:** "answer", "decline", "hang up", "mute", "stop listening" are typed actions in the control matcher;
  "call the kitchen" resolves the target locally (device names, rooms, [contacts](contacts.md)) and needs no model.
- **Agents and assistants:** no template; every household assistant gets the module without listen-in.
- **Other modules:** [contacts](contacts.md) resolves "Sam" and "Mum"; [messaging](messaging.md) sends call links;
  [broadcast](broadcast.md) takes one-way phrasings and declined-call voice messages;
  [emergency-and-safety](emergency-and-safety.md) may open a drop-in to the person who asked for help;
  [music](music.md) and [video](video.md) pause; [timers-and-alarms](timers-and-alarms.md) ring through.
- **Measurement:** a `CallTrace` with ring time, ICE time, first remote audio, and mouth-to-ear estimates from a
  click test, so latency claims follow the repository rule.

## 13. Privacy and safety

- **Drop-in and listen-in are surveillance features.** Off by default everywhere. Enabled per callee device, by the
  owner in admin, listing who may do it. The callee always gets an unmissable indicator (bar, `listening` character,
  tone on nodes) and a 3 s warning before audio flows; there is no silent mode. A bedroom device cannot be dropped in
  on in quiet hours.
- **Baby monitor and consent.** Listening to a child's room by the parents is the intended case. Listening to adults,
  guests or a carer is not: Dutch law makes intentionally listening in on a conversation in a dwelling with a technical
  device a crime unless an exception applies (Sr art. 139a, [text](https://omgevingsweb.nl/wetgeving/wetboek-van-strafrecht/tweede-boek-misdrijven/titel-v-misdrijven-tegen-de-openbare-orde/artikel-139a/));
  the exceptions and how they apply to a visible, owner-installed device are a legal question, not settled here
  **[unverified, not legal advice]**. Hence the indicator, the per-device opt-in and the log of every listen-in.
- **Video** is opt-in per device; camera off is the default answer state ("audio only" first on drop-in).
- **Outside callers** come only through one-use links for known people, never an open room URL. The LiveKit token is
  scoped to one room and expires.
- **The assistant as participant** announces itself, is visible in the participant list, and its notes say who was
  on the call. Audio of other people goes to the language model only in this mode (local STT first; the transcript,
  not the audio, reaches the hosted model).
- **Not an emergency phone.** Even with a SIP trunk, 112 calls over our system are not promised (location, power,
  reliability); see [emergency-and-safety §13](emergency-and-safety.md#13-privacy-and-safety).
- **Children:** a kids' assistant may call household devices, not outside links.

## 14. Foundations needed

[Device capabilities](../module-investigation/presentation-and-device-capabilities.md#5-device-capabilities)
(`camera`, `speaker`, room, privacy) for targets, video and indicators; the
[Notification service](../module-investigation/shared-state-jobs-and-notifications.md#8-notifications) ringing
window and DND for wake-free answer and decline; [Tool context](../module-investigation/shared-state-jobs-and-notifications.md#45-turn-context-proposal);
`Person` records and [contacts](contacts.md) for "call Sam"; [Presentation](../module-investigation/presentation-and-device-capabilities.md)
(ringing card, Call layout); [Event bus](../module-investigation/shared-state-jobs-and-notifications.md#5-event-bus)
and [Module store](../module-investigation/shared-state-jobs-and-notifications.md#4-the-shared-data-layer) (pausing
music, permissions, log); Connection and Requirements and health (LiveKit, TURN); a voice-node `call` activation.
Without them: device and room names only, answer by tapping, an overlay instead of a card, in-memory state.

**A useful first version:** stage 1 between browser devices, by device or room name, tap or voice to answer, hang-up
by voice with the wake phrase, no drop-in, no listen-in. Then nodes, then drop-in with indicators.

## 15. Open questions

1. **Drop-in and listen-in at all?** Which devices, from whom, and is a baby-monitor mode wanted? Who in the house
   must agree?
2. **Stage 1 relay first, or go straight to WebRTC?** Relay reaches nodes and is small; WebRTC gives video and better
   echo handling on browsers. My recommendation is relay first; the alternative skips a path that may be thrown away.
3. **Certificates:** a real domain with DNS-01, the Tailscale name, or a local CA on each tablet? Video calls need one.
4. **LiveKit as a required service** for groups and outside calls, or stay LAN-only and two-party for good?
5. **Phones:** are call links via messaging enough, or is a SIP number wanted (cost, provider)?
6. **Recording calls:** never, or opt-in with an announcement?
7. **The assistant in a call:** should it ever hear other people's audio (notes, translation), and may that
   transcript reach the hosted model?
8. **Disagreement with [notifications](notifications.md#1-summary):** it sizes two-way intercom as one L item inside
   the notifications module. I put it in its own module because it has its own media stack, state machine and privacy
   rules, and only borrows the ringing window.
