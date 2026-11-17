# Assistant controls

Research write-up, 2026-11-17. Not an approved design. Code references are `main` at `70b15ec`. Shared foundations are
named as in [`README.md`](README.md) and linked, not redesigned. Claims about other products come from the landscape
documents' sources where linked; the rest is marked **[unverified]** (the web-search budget for this session was used
up, so nothing new was looked up for this document).

## 1. Summary

Control of the assistant and its devices by voice: stop, cancel, repeat, louder and quieter, mute the microphone, "what
can you do", switch assistant, new conversation, sleep, device status, "show that on the kitchen screen", find my
phone, and "are all modules working?". Most of these must work **without the language model**, in well under a second,
even when the model, the internet or TypeSafe is down. That is what users judge an assistant on first
([landscape-voice-assistants.md](../module-investigation/landscape-voice-assistants.md) §15.1, §15.4, §16.1).

- **Priority: first wave**, and the first piece of it (stop, cancel, repeat, new conversation, switch, sleep) before
  any other new module. Half of it is wiring for things the protocol already has.
- **Effort: M.** The control matcher and canned replies are S. Volume and voice-mute each need a small protocol
  addition (S each). `show_on`, hand-off and find-my-phone are M because they depend on Presentation and the
  Notification service.

It is two things in one package, `packages/module-assistant-controls`: a **host-level control path** (a closed phrase
set matched per device, before any agent; it cannot be switched off per assistant, because "stop" must always work)
and an ordinary **capability module** with the same operations as tools, so the model can use them when the phrasing is
free ("could you turn it down a bit while I'm on the phone").

## 2. What others do

| Who | What | Copy | Avoid |
|---|---|---|---|
| Google Assistant | Quick Phrases: "stop" and a few others without the wake word while something rings or plays (landscape-voice-assistants.md §15.4) | Wake-word-free stop, limited to while something is audible | — |
| Home Assistant Assist | `HassNevermind` (cancel an accidental wake), `HassSetVolume`, `HassSetVolumeRelative`, `HassMediaPause`; "stop" without wake word while a timer rings ([built-in intents](https://contributors.home-assistant.io/core/internals/built-in-intents/)); a beep instead of a spoken confirmation when the action happened in the satellite's room ([chapter 11](https://www.home-assistant.io/blog/2025/10/22/voice-chapter-11)) | Intent names as a checklist; non-verbal confirmation | Several satellites acting on one wake word ([forum](https://community.home-assistant.io/t/vpe-multiple-satellites-which-wins-on-wake-word-does-not-work-well/1019767)) |
| Alexa / Echo | "Stop", "volume five", "louder"; a physical mic-off button that turns the ring red **[unverified detail: hardware disconnect]**; "what can you do" lists suggestions | Volume 0–10 as words; a visible, trustworthy mute | "By the way" upsells after a command ([Tom's Guide](https://www.tomsguide.com/how-to/by-the-way-did-you-know-alexas-annoying-suggestions-can-be-turned-off-heres-how)); discovery that stops after week one (landscape-voice-assistants.md §1(f)) |
| Alexa+ / Gemini for Home | The basics routed through an LLM: 10–40 s silences, wrong-room actions ([Spyglass](https://spyglass.org/broken-alexa-plus.md), [PiunikaWeb](https://piunikaweb.com/2026/04/21/gemini-google-home-good-bad-ugly-early-user-reports/)) | — | Exactly this. Controls never wait for a model. |
| Google surfaces | `NewSurface` moved a conversation to the phone with a notification ([surface capabilities](https://developers.google.com/assistant/df-asdk/surface-capabilities)) | "Send it to my phone" as a first-class hand-off | — |
| Find my phone (Alexa, Google, HA companion app) | Rings the phone even on silent through a critical or alarm-channel push **[unverified detail]** | Use the HA companion app's critical notification where it exists | Ringing a phone that is not the speaker's |

## 3. Example conversations

1. Stop while it speaks, no wake word. *"…and the third option is a heat pump with—"* "Stop." — (silence; the
   character returns to idle; nothing else said).
2. Repeat. "Hey Jeff, say that again." — the last reply is spoken again, word for word, with no model call.
3. Volume. "Louder." (during a reply) — volume up one step, the reply continues. "Hey Jeff, volume four." — a short
   chime at the new level.
4. Never mind. "Hey Jeff… never mind." — a short descending earcon; no reply, the follow-up window closes.
5. Switch assistant. "Hey Jeff, let me talk to Keuken." — "Keuken here." Later utterances without a phrase go to
   Keuken on this device until "switch back" or the device's default returns after idle.
6. Sleep. "Go to sleep until seven." — "Sleeping until seven. Say 'hey Jeff' if you need me." (The wake phrase still
   works; nothing answers without it.)
7. Mute. "Hey Jeff, mute the microphone." — "Microphone off. Tap the mic to turn it back on." The page shows the
   muted state. (Needs a screen or a button to undo; on a headless node this is refused, §13.)
8. What can you do (screen shows a list grouped by module). "What can you do here?" — "Here I can set timers, tell
   you the weather, run the lights in the kitchen, and look things up. The screen shows the rest."
9. Hand-off (needs a screen on the target). "Show that on the kitchen screen." — "On the kitchen tablet." Ambiguous:
   "Put it on the screen." — "The kitchen tablet or the living-room TV?"
10. Health, failure. "Are all modules working?" — "Mostly. Home Assistant isn't answering since 9:12, so lights won't
    work. Everything else is fine."
11. Find my phone, failure. "Find my phone." — "I can't ring phones yet: no phone is connected. You can add the Home
    Assistant app or ntfy in Settings."

## 4. Tools

Every row is both a typed **action** (`controls_<id>`, `examples` in English and Dutch, run by the control path or the
typed-intent path) and a **tool** for the model. Latencies are targets from end of speech to effect, to be measured
with `TurnTrace` before any claim.

| Tool | Parameters | Returns | R/W | Risk class | Latency | Fast path |
|---|---|---|---|---|---|---|
| `controls_stop` | `what?: "auto" \| "speech" \| "ringing" \| "media" \| "all"` | What was stopped, or nothing | W | safe | < 150 ms | **yes**, also without wake word while audible |
| `controls_cancel` | — | Dropped: the pending confirmation, parameter question, draft, or the open wake window | W | safe | < 150 ms | **yes** |
| `controls_repeat` | `which?: "last" \| "previous"` | Re-speaks the last assistant message via `Say` | R | safe | < 300 ms to first audio (cached TTS **[unverified]**) | **yes** |
| `controls_volume` | `set?: 0–10`, `step?: "up" \| "down"`, `amount?: 1–5`, `device?: dynamic` (default here) | New level | W | changes data (device) | < 150 ms | **yes** |
| `controls_mic_off` | `device?: dynamic` (default here) | Muted; how to undo | W | changes data | < 150 ms | **yes** |
| `controls_help` | `topic?: dynamic` (module names) | Spoken summary of what this assistant on this device can do; `list` on a screen | R | safe | < 50 ms (built from the snapshot) | **yes** |
| `controls_switch` | `assistant: dynamic` (the device's assistants), `until?: "idle" \| "changed"` | Who answers now | W | changes data (device) | < 150 ms | **yes** |
| `controls_new_conversation` | `assistant?: dynamic` | Done | W | changes data | < 150 ms | **yes** |
| `controls_sleep` | `until?: Param.duration \| time`, `off?: boolean` | Sleeping until … | W | changes data | < 150 ms | **yes** |
| `controls_device_status` | `device?: dynamic` | This device's name, room, who answers, mic, volume, connection, sleep/DND state | R | safe | < 50 ms | **yes** |
| `show_on` | `target: text` ("kitchen screen", "my phone", "all screens"), `what?: "last" \| text` | Shown where, or candidates | W | changes data (personal content checked) | < 300 ms | no (target resolution is the server's; the model words the reply) |
| `controls_handoff` | `what?: "last" \| url` | QR code and short link on this screen | W | safe | < 100 ms | yes |
| `controls_find_phone` | `person?: dynamic` (default: device's person) | Ringing which phone, via which channel | W | **outward-facing** | 0.2–1 s (push provider) | **yes** |
| (`system_status`, owned by [core-tools.md](core-tools.md)) | `about?` | Worst issue first | R | safe | < 50 ms | **yes**, as the typed action "are all modules working" |

Not here on purpose: DND and "send to my phone" belong to [notifications.md](notifications.md)
(`notifications_dnd`, `notifications_send_to_phone`); this module's hand-off calls that service rather than owning a
phone channel. Speed of speech ("slower") needs a TTS rate the providers may not share **[unverified]**: left for later.

### What "stop" stops

One word, many meanings. The control path resolves `controls_stop { what: "auto" }` in this order, on **the device that
heard it** (Tool context), and stops only the first that applies:

1. something ringing on this device → resolve it (the Notification service's ringing window, shared state §8.4);
2. a reply playing or being prepared → `SessionDispatcher.stop` (`apps/assistant/src/serve/SessionDispatcher.ts:147`),
   which is what the Stop button's `interrupt` message does today;
3. media playing on this device (a future music module) → pause;
4. a pending confirmation or draft → cancel it;
5. nothing → a soft earcon, no words.

"Stop the timer" and "stop the music" are not `controls_stop`: the action's own words win (core's `IntentWords` already
treats "stop" in "Stop the timer" as the action's verb, not a veto, `packages/core/src/IntentWords.ts:187`).

## 5. Integrate or build

**Build.** There is nothing to integrate: these act on our own sessions, route gate and pages.

| Option | For | Against |
|---|---|---|
| **A. A control matcher in the session pipeline**, between `RouteGate.filter` and `SessionDispatcher.dispatch` | Works for every assistant and agent kind (model, Claude subscription, Jev), and with no model at all; latency is a string match; the only way "stop" can pass the echo gate (below) | A second matcher next to wake phrases; a closed list per language |
| B. Wire the Jev intent agent (BUILT, NOT WIRED) and give it these actions | One typed path for everything | Runs *after* routing, per assistant: an assistant on Claude subscription would still go to the harness; it does not help while asleep or for an utterance the echo gate dropped |
| C. Tools only, the model decides | No new code path | One model round trip (≈ 1–3 s, docs/research/agent-backends.md §1) for "stop"; fails when the model is down |

**Recommendation: A for the closed set, C for free phrasing, and B later as the general typed path.** The matcher reuses
the wake-phrase matcher (`exact` / `close`, `packages/core/src/WakeGate.ts`) and core's `ValueParsing`/`NumberWords` for
"volume four", "until seven", "vijf minuten". It runs on the final transcript (`EndOfTurn`) and, for "stop" only, on
the eager transcript, so it cuts in before the turn finishes.

**One finding from the code that changes the design.** In the default interrupt mode `confirm`
(`packages/protocol/src/devices.ts:166`), the echo gate lets speech through during playback only when the last words
heard are **at least two words** (`ECHO_MIN_WORDS = 2`, `packages/core/src/EchoGate.ts:31`) and mostly not in what was
just played. A single "stop" or "louder" is therefore dropped as echo (read in the code, not tested). The control
matcher must get the recogniser's events *before* the echo gate rejects them: a one-word control word that does not
occur in the last played words passes as a control, not as an utterance. Measure false stops from the assistant's own
voice before turning it on by default.

**Without the wake word.** Allowed for: `stop`, `cancel` / "never mind", `louder` / `quieter`, `repeat`, and only while
the device is audible (reply playing plus the echo tail) or ringing. Everything else needs the wake phrase or an open
follow-up window, exactly as routing works today (`packages/core/src/RouteGate.ts`, steps 1–4).

**Canned replies.** Spoken confirmations are a short fixed set per language ("Sleeping until seven.", "Microphone
off."), synthesised once per assistant voice and cached, played through `Say` (no history entry,
`packages/core/src/ConversationEvents.ts:119`). Where the effect is obvious (stop, louder, never mind) an earcon replaces
words, as HA does for same-room actions.

## 6. Data

| What | Scope ([Module store](../module-investigation/shared-state-jobs-and-notifications.md) §4.3) | Schema | Read by others |
|---|---|---|---|
| Volume per device | device | `{ level: 0–10, announceLevel?: 0–10 }` | Notification service (chime volume), music |
| Sleep | device | `{ until?: epoch ms, setBy: Actor }`; ended by a Scheduler job | route gate, ambient facts |
| Temporary assistant switch | device | `{ assistantId, until: "idle" \| "changed", previous }` | route gate |
| Phrase lists | module settings | per language: `{ id: "stop", phrases: ["stop", "hou op", "ophouden"] }` | — |
| Last reply, last presentation | conversation (already in history and in the Presenter's last-few list) | — | — |

Volume and sleep could instead be device *settings* (admin-edited sections). They are runtime state that people change
by voice many times a day, so they belong in the store, with the device settings holding only defaults.

## 7. Long-running work and events

- **Jobs** ([Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) §6): "sleep until seven" schedules
  a one-shot job that clears the sleep row; "switch to Keuken for an hour" the same. Missed while down: apply at start
  (the sleep simply ends).
- **Find my phone** is a Notification with `priority: "critical"`, `audience: { person }`, `channels: ["phone"]`,
  `requireAck: true`, repeating until acknowledged or 2 minutes pass.
- **Events** ([Event bus](../module-investigation/shared-state-jobs-and-notifications.md) §5): `controls.volume.changed`,
  `controls.sleep.changed`, `controls.assistant.switched`, `controls.mic.muted`. Listens to `turn.ended` (for the
  "until idle" switch) and device connect/disconnect (status).
- **Restart.** Volume and sleep survive in the store; a temporary switch is dropped (the default answerer returns).

## 8. Presentation

- `controls_help` → `list` grouped by module (from module `description` and action `examples`), with a few "try
  saying" lines; tapping one is a typed turn.
- `controls_device_status` → `facts` (device, room, answering assistant, mic, volume, connection quality from
  `AudioClientInfo`).
- `controls_volume` → a transient level bar (`progress` with a value, `glance` lifetime).
- `controls_handoff` → `handoff` (QR plus short link; the device draws the code).
- `show_on` → the target gets `present.show` with `origin` "from Kitchen speaker"; the target's character glances, the
  speaking device says one line ([Presentation](../module-investigation/presentation-and-device-capabilities.md) §6.3).
- Mic muted and sleeping are states, not presentations: a muted mic icon on the dock, a moon for sleep; the character
  stays in idle (no new character mode is needed; CHARACTERS.md keeps `Frame` modes fixed).
- `system_status` → `list` of issues, worst first (core-tools).

**Without a screen** everything is spoken or an earcon; `controls_help` speaks three categories and offers to put the
rest on a screen; `controls_handoff` offers `notifications_send_to_phone` instead.

## 9. Notifications and proactive behaviour

Almost none. Proactive speech from this module is limited to:

| What | Priority | Where |
|---|---|---|
| "Awake again" at the end of a timed sleep | none (silent; the moon goes away) | — |
| Find my phone | critical, phone only | the person's phone |
| A module turns unhealthy | low, inbox (owned by core-tools' health notice) | admin and owner devices |

It never says "did you know you can …". Tips appear only when asked ("what can you do").

## 10. Configuration

| Layer | Setting | Default |
|---|---|---|
| Household | Languages for control phrases (from `HOME_LANGUAGE`), find-my-phone channel per person | EN + the home language |
| Module (shared) | Phrase lists per control (`textList`, BUILT, NOT WIRED today), spoken or earcon per control, volume step (1 of 10), sleep without `until` lasts (8 h) | built-in lists; earcons for stop/louder/quieter/never mind |
| Assistant | none (controls are the same for every assistant); the module's tools switchable per assistant as usual | on for all |
| Device | stop without wake word (off / while audible / while audible or ringing), default volume, allow voice mute (on for devices with a screen or button), may switch assistant (existing `voicePage.pick` / `canPick`), accepts `show_on` from others (`acceptsFromOthers`, presentation §5.2) | while audible or ringing; 7; on/off by type; existing; on |
| Person | their phone channel for find-my-phone | none |

First run: nothing; it works out of the box with English and the home language. The owner may edit phrase lists and
turn wake-word-free stop off for a device near a TV.

## 11. Native tools and dependencies

| Need | Where | Missing |
|---|---|---|
| Output gain | the browser (a `GainNode` on the reply output; **ABSENT** today: no volume message exists) | `controls_volume` answers "I can't change the volume on this device yet; use the device's own volume." |
| Real microphone off | the browser (stop the capture track) or the node (ALSA capture off) | refused, with the reason |
| Mixer on a voice node | the node: `wpctl set-volume` (PipeWire) or `amixer` (ALSA) **[unverified on the unmerged node client]** | volume step stays server-side gain only |
| Phone push | HA companion app (via `module-home-assistant`), ntfy or Web Push (notifications.md) | "I can't ring phones yet …" |
| Health data | the host's issue registry ([Requirements and health](../module-investigation/module-definition-config-and-dependencies.md) §C.5) | `system_status` assembles from the snapshot |

No binaries on the server.

## 12. Interaction with the rest of the system

- **Protocol.** Already there: `interrupt` (Stop), `conversation.new`, `device.pick` (`""` = nobody, an assistant id,
  `"typesafe"`; refused unless `canPick`), `mic.state` (client → server only), `Say` reachable through
  `SessionDispatcher.send` (`apps/assistant/src/serve/SessionDispatcher.ts:138`). Missing (additive server → client
  messages, ignored by old pages): `output.volume { level }`, `mic.set { live: false }`, `device.state { sleeping,
  muted, volume }`. Volume as a persisted device value is new state; whether it is a `DeviceSettingsKey` (protocol bump,
  docs/LOOKS-AND-VOICES.md) or store data is open question 4.
- **Speech recognition.** Short commands are the hardest case for a recogniser: one word, often during playback. The
  closed list is matched with `close` matching and Dutch equivalents ("stop", "hou op", "harder", "zachter", "laat
  maar", "nog een keer"). Numbers from `NumberWords` ("volume vier"). A false "stop" from the TV costs a cut-off reply,
  which is cheap; a false "mute" is expensive, so mute needs the wake phrase.
- **Interruption.** Stop is already instant on the page (it silences the player before the server hears about it,
  `Interrupt` doc comment). Voice stop adds the recogniser's latency; measure `SpeechStarted` → playback stopped with
  `TurnTrace`.
- **Character.** Stop returns it to idle at once. "Never mind" closes the listening state without a reply. Volume and
  mute do not move it.
- **Agents and assistants.** Controls are not an agent and ship no assistant template. They apply on the device, for
  whichever assistant is answering: "stop" during Keuken's reply stops Keuken. `controls_switch` uses the device's
  assignments, never an assistant the device does not have. "New conversation" maps to `conversation.new` for the
  answering assistant.
- **Intents and wake routes.** The control matcher runs after the wake phrase is removed ("hey Jeff, stop" → stop), and
  without one only in the audible or ringing window. It never routes to TypeSafe: a control is decided before routing.
- **Other modules.** `show_on` and `controls_handoff` are the Presentation foundation's cross-device tools; `t3-code`,
  `local-info` and others rely on them for "put it on the screen". DND is `notifications_dnd`; "sleep" here is a
  different thing (stop *listening* without a phrase; DND stops *speaking unprompted*). Health is `system_status` from
  core-tools.

## 13. Privacy and safety

- **Mute must be real.** Voice can turn the microphone off, never on (it cannot hear). On a headless node without a
  button, voice mute is refused ("I'd have no way to hear you turn it back on"). Muted means no frames leave the device,
  not "the server ignores them".
- **Show on another screen.** `personal` presentations are not sent to `shared` or `public` devices (presentation §6.1
  rule 4); `show_on` answers "that's personal; I can send it to your phone instead".
- **Switch assistant.** Only among the device's own assignments, and only where `canPick` is on, so a guest at the
  hallway node cannot switch to the coding assistant.
- **Find my phone** rings only the speaker's phone (device's default person), or the household's phones when no person
  is known. Never someone else's phone by name without a known person (open question 6).
- **Health** hides module error text on `public` devices ("something is wrong with Home Assistant; details in admin").
- **Wake-word-free stop near a TV** can be switched off per device.
- **Children.** Nothing here is risky; all controls stay available.

## 14. Foundations needed

| Foundation | Needed for | First version without it |
|---|---|---|
| [Tool context](../module-investigation/shared-state-jobs-and-notifications.md) (§4.5) | the tool path knowing which device said it | the control path runs inside the session, which already knows its device |
| [Device capabilities](../module-investigation/presentation-and-device-capabilities.md) (§5) | mute allowed?, help on screen or spoken, show_on targets | every device is a browser with a screen (true today) |
| [Presentation](../module-investigation/presentation-and-device-capabilities.md) | help list, status facts, `show_on`, `handoff` | spoken only; `show_on` absent |
| [Module store](../module-investigation/shared-state-jobs-and-notifications.md) | volume, sleep, switch | in-memory per session (lost on restart) |
| [Scheduler](../module-investigation/shared-state-jobs-and-notifications.md) | sleep until, switch for an hour | `until` refused ("say 'wake up' when you need me") |
| [Notification service](../module-investigation/shared-state-jobs-and-notifications.md) | ringing-window stop, find my phone | stop covers replies only; no find-my-phone |
| [Requirements and health](../module-investigation/module-definition-config-and-dependencies.md) | "are all modules working" | module states from the snapshot (`running`, `error`) |

**A useful first version (S):** the control matcher with stop, never mind, repeat, new conversation, switch assistant
and sleep (`device.pick ""`), all on existing messages; the echo-gate exception for one-word controls; earcons. Then
volume and voice mute (two small messages). Then help and device status. `show_on`, hand-off and find my phone come with
their foundations.

## 15. Open questions

1. **Wake-word-free "stop"**: during replies only, also while ringing (the timers document asks the same), or also for
   media? Should one-word controls bypass the echo gate's two-word rule, accepting some false stops from the
   assistant's own voice?
2. **"Sleep" means what?** "Nobody answers without the phrase" (`device.pick ""`, my proposal), the microphone off, or
   DND? Users will say "go to sleep" meaning any of the three.
3. **Spoken or earcon** confirmations by default for stop, louder, quieter and never mind?
4. **Volume storage**: a persisted device value in the store (my proposal), or a new device settings section (protocol
   bump, edited in admin too)? And one level per device, or separate levels for replies and announcements?
5. **Switch assistant**: until the conversation goes idle (my default), until switched back, or for one utterance only?
6. **Find my phone**: which channel do you have on the phone (HA companion app, ntfy, none)? May one person ring another
   person's phone?
7. **Host feature or module?** I propose the control path is always on (not per assistant) with the tool half as a
   normal module. Is that acceptable, or should every part be switchable?
8. **Languages**: English and Dutch phrase lists by default?
9. **Disagreement**: the landscape document's candidate `system` module (landscape-launchers-and-agent-tools.md §7) (speedtest, device volume) overlaps this one and
   core-tools. I put device controls here, health in core-tools' `system_status`, and leave speedtest out.
