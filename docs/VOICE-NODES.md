# Voice nodes: one-shot speaker-and-microphone boxes, managed from admin

Design written 2026-11-14 (design session), at the owner's request. Nothing is built yet. It adds:

1. **A voice node**: a small headless program (`apps/node`) installed on a Raspberry Pi, a VM or any Linux box with
   a microphone and a speaker. It connects to the assistant server as one more **device** with its own **voice
   session** (docs/VOICE-SESSIONS.md), sends the microphone and plays the replies. The server keeps every engine
   (speech recognition, language model, voices, modules).
2. **One-shot activation**, a new per-device activation mode: wake phrase → one question → one answer → asleep
   again. No follow-up window. Every new question needs the wake phrase.
3. **Enrolment and management from admin**: a node is added with a pairing code issued in admin, authenticates with
   its own credential, and gets *all* of its settings (wake phrase, voice, volume, audio devices, one-shot options)
   pushed from admin. Admin's Devices category becomes the place where browsers and nodes are listed and controlled.
4. **Installation and updates** for Debian / Raspberry Pi OS (arm64) and x86-64 VMs: one install command, a systemd
   unit, updates pulled from the server the node belongs to.

Status of each part goes in the "Status" section at the end. Whoever builds a part updates it, and records there
anything that had to differ from this design, with the reason.

This design sits **on top of** the voice-sessions work (docs/VOICE-SESSIONS.md, branch
`t3/multi-tab-assistant-sessions`, not merged when this was written). That work is taken as given: per-device
sessions, per-device conversations, New conversation / idle reset, protocol 6, many streams per sherpa worker, one
Claude Code session per conversation, `MAX_VOICE_SESSIONS`, admin `sessions`. A node is *just another device with its
own session*. §10 says exactly what depends on that branch and what can be built against `main` now.

## 1. Goals and non-goals

**Goals**

- A box with a USB speakerphone (or a Pi with a mic HAT and a speaker) becomes a voice assistant in a room, using the
  server's engines, with **no speech model on the box** in the default configuration.
- One-shot behaviour as a first-class, explicit activation mode, with defined behaviour for barge-in, confirmation
  questions, silence after the wake phrase, and conversation continuity.
- Nodes are configured only from admin. On the box: a server URL and a credential, nothing else.
- Adding, identifying, testing and removing a node are admin actions. Admin shows online / offline, last seen,
  version, platform, audio devices and the last error of every node.
- Latency is not worse than a browser device on the same network, measured with `TurnTrace` (§9).
- Local-first stays true: the node talks only to the owner's own server; nothing goes to a hosted service that the
  server does not already use.

**Non-goals (this design)**

- Speech recognition, synthesis or the language model on the node. (A later "fat node" is possible: §8.)
- Screens, LEDs, buttons or GPIO. The node gives feedback by sound only (cues). A button is a natural later addition
  (it would call the same "wake" path) and is left out.
- Acoustic echo cancellation in our code. We rely on hardware AEC (USB speakerphones) or PipeWire's echo-cancel
  module where available, and on the existing `EchoGate`.
- Wyoming / Home Assistant satellite compatibility (§8).
- Per-device agent choice. The owner listed "agent" among the per-node settings, but agents and intents are not
  wired into the app yet (docs/AGENTS-AND-INTENTS.md). §5.4 reserves the field; WP-12 builds it after that wiring.
- macOS / Windows nodes.
- Spoken "new conversation" commands (as in docs/VOICE-SESSIONS.md: needs the intent path).

## 2. Decisions

| Topic | Decision |
|---|---|
| What a node is | A thin client: `apps/node`, a Node 22 program that captures 16 kHz mono PCM, sends it over the **existing** WebSocket protocol as microphone frames, and plays reply frames. To the server it is a voice connection (`hello.frontend: "voice"`) of the new front-end kind **`voice-node`**, with its own device id, profile and voice session. No new transport. |
| Audio on the box | Child-process capture and playback, exactly the pattern of `packages/audio-pipewire` (`pw-record` / `pw-cat`): PipeWire where it runs (desktop boxes), **ALSA** (`arecord` / `aplay`) where it does not (Raspberry Pi OS Lite, minimal Debian VMs). New package `packages/audio-alsa` reuses `captureStream`, `playThrough` and `makeReframer` from `@pva/audio-pipewire`. |
| Playback reporting | The node is a "reports playback" output like the browser (`playback.started` / `progress` / `finished` / `stopped`), so `WebAudioOutput`, history-of-what-was-heard and the playback timeout work unchanged on the server. Counts are clock estimates clamped to samples written (§4.4). |
| Where the wake phrase is decided | **On the server, always**, by the existing `WakeGate` on the recogniser's transcript. It is the single source of truth for phrases, matching, one-shot state and the phrase tester. |
| Where the microphone is gated | Per node, setting `micStreaming`: **`continuous`** (default for the first release: the node streams all the time, as a browser does; zero new models) or **`on-keyword`** (later, after measurement: a small local keyword spotter on the node decides *when to stream*; the server still decides *whether it was the wake phrase*). Reasons and the measurements that decide the default: §6. |
| One-shot | New `Activation` member **`one-shot`** (for every kind, default for `voice-node`). Wake → one accepted utterance → one reply → asleep. No follow-up window; voice barge-in needs the phrase; the phrase alone during a reply stops the reply; a confirmation question opens a one-utterance answer window; silence after the phrase alone closes after the armed window. §3. |
| Conversation per wake | Default: **continue** the device's conversation; the `voice-node` kind's built-in `conversationIdleMinutes` is **2** (so "and tomorrow?" after a second "Hey Jev" works, but the room does not carry a conversation for long). Setting `newConversationOnWake` (default off) makes every wake start a fresh conversation. Open question 1. |
| Enrolment | Admin › Devices › **Add voice node** issues a one-time **pairing code** (8 characters, 10 minutes). The installer redeems it over HTTP(S) (`POST /node/pair`) and receives a device id and a **node credential** (32 random bytes). The server stores only its SHA-256 in the device record. §5. |
| Authentication | A `hello` with `device.kind: "voice-node"` must carry `node.credential`; a missing, wrong or revoked one closes the connection with the new close code **4403**. A `voice-node` device can only come into existence by pairing, never by `hello`. Browsers are unchanged (still no login on the voice front end). |
| On the box | `/etc/pva-node/node.json` (0600, owner `pva-node`): `{ server, deviceId, credential, tlsPin? }`. Everything else comes from the server: the profile (`device.profile`, already pushed live today) carries wake phrases, activation, voice, volume, audio devices and cues. |
| Distribution | The server serves the node: `/node/manifest.json`, `/node/pva-node.mjs` (one esbuild bundle of `apps/node` with its workspace dependencies), `/node/install.sh`. The installer puts a pinned Node 22 runtime under `/opt/pva-node`. The node updates itself from its server on every (re)connect when the bundle hash differs, so node and server never disagree on the protocol version. §7. |
| Admin | "Front ends" is renamed **Device defaults** (one page per kind: *Browser*, *Voice node*); **Devices** lists every device of every kind with online state, and gets node pages (status, Identify, Test speaker, Test microphone, Restart, Remove) and an **Add voice node** flow. Nothing else moves. §5.3. |
| Protocol | Version **7**, on top of the voice-sessions branch's 6: kind `voice-node`, `Activation` + `one-shot`, node profile fields, `hello.node`, `node.*` messages, `DeviceInfo.node`, close code 4403. §4. |

## 3. One-shot activation (`packages/core/src/WakeGate.ts`)

One-shot is a mode of the existing gate, not a new component. It is `wake-phrase` with four differences, all
decided in the pure gate or in the voice session that owns it.

### 3.1 States and transitions

```
             phrase + request                    reply ends / fails / is stopped
  ASLEEP ──────────────────────────▶ TAKEN ──────────────────────────────────────▶ ASLEEP
    │  ▲                               │  (reply in progress; utterances need the phrase)
    │  │ armedMs passes, nothing said  │
    │  │                               │ phrase alone while TAKEN → reply stopped, ARMED
    ▼  │                               ▼
   ARMED ── next utterance (any) ──▶ TAKEN
    ▲
    └──── confirmation question fully played (server calls answerWindow) ── from TAKEN/ASLEEP
```

- **ASLEEP**: as `wake-phrase` asleep today: utterances are held and matched; no match on `EndOfTurn` drops the
  utterance whole.
- **Phrase + request** ("Hey Jev, what time is it?"): accepted exactly as today (phrase removed). The gate enters
  **TAKEN**.
- **Phrase alone** ("Hey Jev", pause): opens the armed window (`armedMs`, default `WAKE_ARMED_MS` = 8 s), one
  utterance, as today. `woke: { phrase, armed: true }` → the node plays the wake cue.
- **TAKEN** (from an accepted non-empty `EndOfTurn` until `replyEnded`): **no follow-up window**. `followUpMs` is
  ignored in this mode. The device does not count as awake during the reply, so an utterance without the phrase is
  dropped (this is "barge-in still needs the phrase" of `followUpMs = 0` today, made explicit). An accepted utterance
  with an empty `EndOfTurn` (phrase only, after removal) does not enter TAKEN; it arms, as today.
- **`replyEnded(now)`** in TAKEN → ASLEEP immediately (in `wake-phrase` it would open the follow-up window).
- A **turn that produces no reply** (empty after removal, failed, or a `Say`-less tool turn) must still return the
  gate to ASLEEP. The server calls `replyEnded` on `TurnEnded` when no `reply.start` was sent for that turn (§3.3).

### 3.2 The four differences, precisely

1. **No follow-up window**: as above.
2. **Phrase alone during a reply stops the reply.** In TAKEN, a matched utterance that is only the phrase reports
   `woke: { phrase, armed: true, duringReply: true }` (new optional field). The voice session then sends
   `Interrupt` to the conversation (same path as the Stop button) and the gate opens the armed window, so "Hey Jev"
   (pause) "what's the weather instead?" works. A phrase **with** a request during a reply is ordinary barge-in: the
   held `SpeechStarted` is released at the match and `Conversation`'s barge-in interrupts the turn, as in
   `wake-phrase` mode today. Neither needs the `EchoGate` to cooperate in `confirm` mode (the phrase is not the
   assistant's own words); in `manual` mode the mic is replaced by the noise floor while audible, so voice barge-in
   is impossible, as today.
3. **Answer window for a confirmation question.** New method `answerWindow(now: number, ms: number): void`: opens a
   window that admits exactly one utterance without a phrase, like the armed window, and reports nothing by itself.
   The voice session calls it when the conversation has armed a confirmation question and its audio has been
   played to its end (the same condition core uses; docs/ARCHITECTURE.md, review round 7), with `ms` = the
   conversation's `confirmWindowMs` (default 15 s), and sends `wake { phrase: "", armed: true }` so the node plays
   the cue. Since `confirmActions` is `off` by default, this path is dormant until the owner switches confirmations
   on. Clarifying questions by the model are **not** given a window: on a one-shot device the model is told not to
   ask them (§3.3), and if it does, the owner answers with the phrase ("Hey Jev, the kitchen").
4. **Silence after the wake phrase**: the armed window lapses after `armedMs` with nothing said → ASLEEP. The server's
   `StateTracker` already returns to `asleep` by timer (`wakeChanged`). The node plays the *lapse cue* (a short
   falling tone) when it sees `state: asleep` after a `wake { armed: true }` with no `turn.start` in between (§4.4),
   if `cues` is on. No server change.

Interface additions (core, additive; the existing `wake-phrase` and `always` behaviour stays bit-for-bit):

```ts
WakeConfig.activation: Activation            // protocol 7 adds "one-shot"; until then core declares
                                             // type WakeActivation = Activation | "one-shot" locally (WP-2)
WakeGate.answerWindow(now: number, ms: number): void
WakeResult.woke?: { phrase: string; armed: boolean; duringReply?: true }
WakeGate.taken(now: number): boolean         // for the session: a reply is owed or playing in one-shot mode
```

`wakeConfigFromProfile(profile)` maps `activation: "one-shot"` through unchanged and ignores `followUpSeconds` for it.

### 3.3 What the voice session does (server, `VoiceSession`)

- On `woke.duringReply` → `Interrupt` on the session's conversation.
- On a confirmation question played to its end, one-shot only → `answerWindow` + `wake { phrase: "", armed: true }`.
- On `TurnEnded` for a turn that sent no `reply.start` → `replyEnded(now)`.
- `newConversationOnWake: true` → on the first `woke` that accepts an utterance from ASLEEP or ARMED (not
  `duringReply`, not the answer window), enqueue `newConversation("new")` on the session's control queue **before**
  forwarding the released events. The voice loop handles the control queue in order with the events
  (docs/VOICE-SESSIONS.md, Status step 1), so a speculative turn started on the same eager transcript already sees
  the empty history.
- **Prompt**: a one-shot session's turns get a fixed instruction appended to the system prompt
  (`ONE_SHOT_INSTRUCTIONS`): *"This device hears one request per wake phrase. Give one complete answer. Do not ask
  the owner a question back: choose the most likely meaning and say in a few words what you assumed."* It is constant
  per activation mode, so each mode keeps its own cached prefix (two prefixes in total, not one per device). Check:
  `llmFirstToken` from the second turn on is unchanged against a non-one-shot device (§9, M5).

### 3.4 Interaction with the turn detector

One-shot has a sharp edge: the turn detector decides when "the one question" is over. If the owner pauses longer
than the end-of-turn silence (600 ms by default) mid-question, the rest is a second utterance and is dropped
(needs the phrase). This is measured, not argued (§9, M6: the share of real node questions cut in two, from
`HeardAudio` recordings). If it is common, the fix is a per-device end-of-turn silence (a profile field feeding the
session's recogniser stream), not a follow-up window; it is left out until the numbers say so.

## 4. Protocol (version 7)

Built on protocol 6 (docs/VOICE-SESSIONS.md §4). The builder writes the exact schemas in `packages/protocol` and
lists them under Status. Required shape:

### 4.1 Kinds, activation, profile (`frontends.ts`)

- `VOICE_NODE_KIND = "voice-node"`.
- `Activation`: `["always", "wake-phrase", "one-shot"]` (a new member of a closed set: the reason for the bump).
- New profile fields (in `DeviceProfile`, `ProfileField`, `ProfileOverrides`, `ProfilePatch`,
  `DEFAULT_DEVICE_PROFILE`):

  | Field | Type | Built-in default | Applied by |
  |---|---|---|---|
  | `newConversationOnWake` | boolean | `false` | server (§3.3) |
  | `audioInput` | string ≤ 200, `""` = the backend's default | `""` | node |
  | `audioOutput` | string ≤ 200, `""` = default | `""` | node |
  | `outputVolume` | int 0..100 | `80` | node (software gain, §4.4) |
  | `cues` | boolean | `true` | node (wake, lapse and identify sounds) |
  | `micStreaming` | `"continuous" \| "on-keyword"` | `"continuous"` | node (§6) |
  | `agent` (reserved, WP-12) | — | — | not in protocol 7 |

- **Per-kind built-in defaults.** `FrontendKind` gains `builtIn: ProfileOverrides`; effective profile becomes
  `DEFAULT_DEVICE_PROFILE ← kind.builtIn ← kind defaults (admin) ← device overrides`. `effectiveProfile` takes the
  extra layer. `voice-node` built-in: `{ activation: "one-shot", conversationIdleMinutes: 2 }`. `web-voice`: `{}`.
- **Per-device-only fields**: `PER_DEVICE_FIELDS = ["audioInput", "audioOutput"]`. A `frontend.update` naming them is
  refused (`invalid_settings`): hardware ids mean nothing on another box (the rule docs/FRONTENDS-AND-ACTIVATION.md
  §1 already applies to browser microphone ids).
- **Editable by the device itself**: none for `voice-node` (it has no UI). `DeviceProfileInfo.editable` is `[]` for a
  node.
- `voice-node` kind's `fields` (form order): `activation, wakePhrases, wakeMatch, followUpSeconds,
  newConversationOnWake, conversationIdleMinutes, voice, interruptMode, audioInput, audioOutput, outputVolume, cues,
  micStreaming`. `followUpSeconds` is shown only when `activation` is `wake-phrase` (the form already supports
  `visibleWhen`-style hiding for profile groups; if not, the form hides it by activation).
  `web-voice`'s `fields` stay as they are, plus nothing; `one-shot` is selectable for browsers too.

### 4.2 Hello and node identity

```ts
Hello.node?: NodeHello                          // required when device.kind === "voice-node"
NodeHello = {
  credential: NodeCredential                    // 43 base64url characters (32 bytes), like AdminToken
  version: string                               // the bundle's version: "<package version>+<git short sha>", ≤ 64
  bundleSha256: string                          // hex, 64: what the node runs (the server compares with its own)
  platform: { os: "linux"; arch: "arm64" | "x64" | "arm"; hostname: string ≤ 64; model?: string ≤ 120 }
}
CloseCode.unauthorized = 4403                    // voice-node hello without a valid credential, or revoked
```

A node's `hello` is `{ type: "hello", protocol: 7, clientId: <random per process>, resumeOwner: true, frontend:
"voice", device: { id, kind: "voice-node", name }, node: {...} }`. The server:

- verifies the credential against the device record (SHA-256 digests, `crypto.timingSafeEqual`), else closes 4403;
- refuses `device.kind: "voice-node"` for any device id it did not pair (4403), so a browser cannot pose as a node;
- does **not** take the name from `hello` for a paired node (the admin-set name wins; the paired name was set at
  pairing);
- records `version`, `bundleSha256`, `platform` in memory for `DeviceInfo.node` (§4.3).

After `welcome` the node sends `audio.claim` (with `audio: { contextSampleRate: <capture rate>, outputPath:
"direct" }`; the browser-only optional fields are omitted) and, in `continuous` mode, `mic.state { live: true }`
followed by mic frames. Everything else (session, ownership per device, `sessions_full`) is the voice-sessions
behaviour.

### 4.3 Node status and commands

| Direction | Schema | `type` | What |
|---|---|---|---|
| client (node) | `NodeStatus` | `node.status` | `{ backend: "pipewire" \| "alsa" \| "file", inputs: AudioDeviceInfo[], outputs: AudioDeviceInfo[], streaming: "continuous" \| "on-keyword" \| "off", kws?: { state: "loading" \| "ready" \| "failed", model: string, error?: string }, input?: { opened: string, sampleRate: number }, output?: { opened: string }, lastError?: { message: string ≤ 500, at: number } }`. Sent after `welcome`, on any change (hot-plug, a device that failed to open), at most once per second. Node connections only. |
| client (node) | `NodeLevel` | `node.level` | `{ rmsDbfs: number, peakDbfs: number }`, 5 per second, only while a `test-mic` command runs. |
| server → node | `NodeCommand` | `node.command` | `{ command: "identify" \| "test-speaker" \| "test-mic" \| "restart" \| "update", durationMs?: number }`. |
| client (admin) | `NodeCommandRequest` | `node.command.send` | `{ requestId, id: DeviceId, command, durationMs? }`, admin only; `unknown_device` for an unknown or offline node (`ErrorInfo` says which). |
| client (admin) | `NodePairCreate` | `node.pair.create` | `{ requestId, name?: DeviceName }`, admin only. `result.pairing: { code, expiresAt, serverUrl }`. |
| client (admin) | `NodePairCancel` | `node.pair.cancel` | `{ requestId, code }`, admin only. |
| server (admin) | `NodePaired` | `node.paired` | `{ code, deviceId, name }`: the code was redeemed. `ADMIN_ONLY`. |
| server (admin) | `NodeLevelReport` | `node.level` | `{ deviceId, rmsDbfs, peakDbfs }` relayed to admin connections during `test-mic`. `ADMIN_ONLY`. |

```ts
AudioDeviceInfo = { id: string ≤ 200; name: string ≤ 120; isDefault: boolean }
DeviceInfo.node?: {                              // present for voice-node devices
  version?: string; bundleSha256?: string; upToDate?: boolean   // last connection's; upToDate vs the server's bundle
  platform?: NodeHello["platform"]
  status?: Omit<NodeStatus, "type">               // last received, kept in memory while online and after
  pairedAt: number
  transport?: "ws" | "wss"                        // of the current / last connection
}
```

- `identify`: the node plays the identify sound (three rising tones, ~1.2 s) at the current volume, regardless of
  `cues`. `test-speaker`: a 1 kHz tone at −20 dBFS for `durationMs` (default 1000, ≤ 5000) at the current volume and
  output device. `test-mic`: the node sends `node.level` for `durationMs` (default 10 000, ≤ 30 000). `restart`: the
  node exits with code 0 (systemd restarts it). `update`: the node fetches the manifest now (§7.3).
- `node.status`, `node.level` from a non-node connection: `bad_message`.
- `devices` (admin) is sent on `node.status` changes under the existing 1 s throttle.

### 4.4 Playback, cues and volume on the node

The server sends replies exactly as to a browser: `reply.start { turnId, sampleRate }`, reply frames, `reply.end`,
or `reply.stop`. The node:

- on `reply.start`: spawns the player at `sampleRate` (pw-cat / aplay) with the profile's `audioOutput`;
- writes each frame's PCM, scaled by the volume gain `g = (outputVolume / 100)²` (0 = silent; 50 ≈ −12 dB) on an
  `Int16Array` view, clipped; no per-sample Effects;
- reports `playback.started { turnId, outputLatencyMs, startDelayMs }` when the first chunk was written to the
  player: `outputLatencyMs` = the requested player latency (default 20 ms; `PIPEWIRE_PLAYBACK_LATENCY_MS` /
  the ALSA buffer time), `startDelayMs` = first frame received → first write. This makes `TurnTrace`'s `audible=`
  available for nodes, as for browsers;
- reports `playback.progress` every 250 ms with `playedSamples = min(written, round((now − startedAt − latency) ×
  rate))`, never decreasing, and `underruns` = the times the estimate caught up with `written` before `reply.end`;
- on `reply.end`, when the player exits after draining: `playback.finished { playedSamples: written }`;
- on `reply.stop` (or interruption by the node itself): SIGKILL the player, `playback.stopped { playedSamples:
  <estimate>, exact: true }` (the estimate is the node's best and final count);
- buffers reply frames that arrive faster than the player drains them in memory (a reply is bounded by the
  server's limits), never drops them.

Cues are generated on the node (no assets): **wake** = the web's two tones (660 → 990 Hz, 180 ms, raised-cosine,
−20 dBFS) on `wake { armed: true }`; **lapse** = 990 → 660 Hz on the lapse condition of §3.2(4); **identify** as
above. All at `outputVolume`, all skipped when `cues` is off (except identify). A cue never plays over a reply and is
never reported to the server (it is not a reply).

## 5. Enrolment, security, management

### 5.1 Pairing

1. Admin › Devices › **Add voice node** → optional name → `node.pair.create`. The server makes a code: 8 characters
   of Crockford base32 (40 bits), shown as `K7QM-2XHP`, single use, valid **10 minutes**, at most 3 outstanding
   (the oldest is cancelled). Kept in memory only (a restart cancels it).
2. Admin shows the install command, built from `serverUrl` (§5.2):
   `curl -fsSL http://assistant.lan:8787/node/install.sh | sudo sh -s -- --code K7QM-2XHP`
   (the installer also asks for the code interactively when `--code` is absent, so it need not be on the command
   line), a copy button, the countdown, and waits for `node.paired`.
3. The installer (§7) posts `POST /node/pair` with `{ code, hostname, platform, version }`:
   - `200 { deviceId, credential, name }`: the server created the device record (kind `voice-node`, name = the
     admin's name or the hostname, `node: { credentialSha256, pairedAt }`), saved it, and sent `node.paired`;
   - `403 { error: "bad_code" | "expired" }`, with the admin-login back-off **per remote address** (5 wrong → 30 s,
     doubling);
   - `503 { error: "admin_disabled" }` when `PVA_ADMIN_PASSWORD` is unset (no admin, no pairing).
4. The installer writes `/etc/pva-node/node.json` and starts the service; the node connects and appears online.

**Re-pair** (a reinstalled box, a lost file): Add voice node again; a new device. The old record is removed with
Remove. (A "replace credential of this device" button keeps the device's settings; nice, not needed for the first
release: WP-9 may add it if cheap.)

**Remove** = revoke + forget: `device.forget` on a `voice-node` deletes the record with its credential hash; an
open connection of it is closed with 4403. The node logs "this node was removed from the assistant; pair it again"
and retries only every 10 minutes (so a mistaken removal heals by re-pairing, without the box hammering the server).

### 5.2 Transport and the server URL

- Nodes are not browsers: no secure-context requirement, `ws://` works. The server must listen where the node can
  reach it (`SERVE_HOST=0.0.0.0` or a LAN address, a reverse proxy, or Tailscale), and a host *name* must be in
  `SERVE_ALLOWED_HOSTS` (the existing DNS-rebinding check applies to `/node/*` and `/ws` alike; IP addresses always
  pass).
- **`NODE_SERVER_URL`** (new assistant setting, section "Devices", default empty): the URL nodes use. Empty → admin's
  own `location.origin` when it is not a loopback address; when admin is opened through `localhost` (the SSH-tunnel
  route of the README) and the setting is empty, the Add dialog says so and asks for the URL instead of showing a
  command that cannot work. The dialog also warns when the server listens only on loopback.
- **TLS**: with `SERVE_TLS_CERT` / a proxy, the node uses `wss://` and `https://`. For a self-signed certificate the
  installer takes `--tls-pin sha256:<hex>` (shown by admin, computed by the server from its own certificate) and the
  node pins it (`tlsPin` in `node.json`); with a publicly trusted or locally installed CA no pin is needed. Over plain
  `ws://` the credential, the pairing code and the room audio are readable by anyone on the LAN; admin shows nodes on
  plain `ws` with a warning badge. Whether to require TLS is open question 2.

### 5.3 Admin information architecture

Today's categories: Overview, Front ends, Devices, Language model, Speech recognition, Voices, Modules, Keys & vault,
Diagnostics, About. The change is deliberately small:

| Today | After | Notes |
|---|---|---|
| Front ends | **Device defaults** | Label only; the category id `frontends` and deep links stay. Kind titles become *Browser* (was "Voice assistant in a browser") and *Voice node*. Each kind page is the profile form with that kind's `fields`. The phrase tester stays here and gets a "Listen to" choice that includes nodes (the voice-sessions branch adds `wake.test.deviceId`). |
| Devices | **Devices** | One list for every kind: name, kind, status (*Online · talking* / *Online · asleep* / *Online · not listening* / *Offline since …*), activation summary, version (nodes; *update pending* when `upToDate` is false), a ws warning badge. Online first, then by last seen. Header button **Add voice node**. |
| Devices › device | Devices › device | Browser devices: as today. Node devices add: a **Status** group (online, version, platform and model, audio backend, opened input / output, streaming mode, keyword spotter state, transport, micFramesLost of its session, last error), an **Actions** row (Identify, Test speaker, Test microphone with a live level meter, Restart, Update now), the profile form with an **Audio** group (input and output as selects from `status.inputs` / `outputs` plus "System default", volume slider with "Test", cues), and **Remove** (alertdialog: "The node disconnects and must be paired again."). |
| Overview | Overview | Its Voice sessions section (voice-sessions branch) shows nodes like any device. Plus a line "N voice nodes · M online" linking to Devices. |
| — | — | No new top-level category for agents now (WP-12). |

"General admin panel" is therefore mostly naming and the Devices category; the settings screen already holds the
whole server's configuration. The admin header's "Voice assistant" link stays (it opens the browser voice page).

### 5.4 Reserved: per-device agent

When agents are wired into the app, a profile field `agent: string` (`""` = the default routing) is added to both
kinds, and the session sends `SetActiveAgent` (already a `ConversationInput`) on session start and on change. Not in
protocol 7.

## 6. Where the trigger is detected

The phrase is always *decided* on the server (§2). The question is whether the node streams the microphone
continuously or only after a local keyword spotter (KWS) fires.

| | `continuous` (server-only) | `on-keyword` (node KWS pre-gate + server verification) |
|---|---|---|
| What runs on the node | capture + WebSocket | capture + KWS model (sherpa-onnx keyword spotter, a ~3 M-parameter zipformer) + a 2 s pre-roll ring |
| What leaves the box | all room audio, to the owner's own server, all the time | ~2 s of pre-roll + the request, only after the spotter fires (and during armed/answer windows) |
| Bandwidth | 32 KB/s per node (16 kHz × 2 bytes), ~2.8 GB/day: nothing on a LAN; noticeable on a metered or poor Wi-Fi link | near zero when idle |
| Node CPU (Pi 4/5) | expected tiny: two child processes and a socket. **Measure** (M1). | the spotter on every 20 ms frame. **Measure** (M4); unknown until measured on a Pi 4 |
| Server CPU | VAD on the stream all the time (cheap) **and a whole-turn decode of every utterance in the room** (TV, conversation) on the shared sherpa worker, whose decodes are serialised across sessions: a talkative room delays turn ends of *other* devices. **Measure** (M2). | VAD on the noise floor; decodes only after a spotter fire |
| Wake latency | none added for "Hey Jev, <request>" in one breath (decided on the eager transcript, docs/FRONTENDS-AND-ACTIVATION.md Status bench). The **cue** after the phrase alone comes only after end-of-turn silence (600 ms) + a decode. **Measure** (M3). | the cue could come ~0.1–0.3 s after the keyword (a claim to be measured, M4); the request itself is unchanged as long as the pre-roll covers it (M5) |
| Phrases | any phrase, any language, `close` matching, the phrase tester, "Add as phrase" | the spotter needs the phrase as model tokens (BPE for the English model): a tokenisation step on the node, and its own misses / false fires, which the server cannot see |
| Privacy | the room's speech is decoded on the server; ignored utterances are already never stored (`HeardAudio.discard`, captions and history skip them) | the room's speech never leaves the box unless the spotter fires |
| Code | none new on the detection path | a new package, a model download on the node, tokenisation, pre-roll |

**Decision.** Ship `continuous` first and make it the default: it reuses everything that exists, needs no model on
the Pi, and keeps one matcher. Build `on-keyword` as WP-5 / WP-10 in parallel, as an opt-in per node, and switch the
`voice-node` built-in default to `on-keyword` only if M2 shows that always-streaming rooms delay other devices'
turns noticeably, or the owner prefers the privacy property (open question 3), **and** M4 shows the spotter misses
fewer than 1 in 20 of the owner's recorded wake phrases with under 1 false fire per hour of TV audio on a Pi 4.

**Two-stage in `on-keyword`.** On a spotter fire the node sends `mic.state { live: true }`, the pre-roll (the last
2 s, as 20 ms frames, in one burst), then live frames. The server's gate verifies the phrase in the transcript as
in `continuous` mode, so a false fire costs one decode and nothing else. The node keeps streaming while the session
is awake: until it receives `state` `thinking`/`speaking` for a committed turn, or `asleep`; and it starts streaming
again on any `wake { armed: true }` (the answer window) for `armedMs`. During a reply the spotter keeps running, so
"Hey Jev" over the reply reaches the server and stops it (§3.2). The burst fits `audio-web`'s 3 s input queue (150
frames) with room to spare; M5 checks that nothing is dropped (`inputStats().droppedFrames`).

## 7. Installation, runtime, updates

### 7.1 What is installed

| Path | What | Owner / mode |
|---|---|---|
| `/opt/pva-node/runtime/node-v22.x.y-linux-<arch>/` | a pinned Node 22 runtime (Debian 13 ships Node 20, Raspberry Pi OS bookworm Node 18; the repo needs ≥ 22.18) | root, 0755 |
| `/opt/pva-node/releases/<sha256>/pva-node.mjs` | the bundle; `current` → symlink to the running one; the previous one kept for rollback | `pva-node`, 0755 (the node updates itself) |
| `/etc/pva-node/node.json` | `{ server, deviceId, credential, tlsPin? }` | `pva-node`, 0600 |
| `/var/lib/pva-node/` | the KWS model when `on-keyword` is used (downloaded from the server's `/node/models/…`, §7.3), the update lock | `pva-node`, 0700 |
| `/etc/systemd/system/pva-node.service` | the unit | root, 0644 |

A system user `pva-node` (no login shell, home `/var/lib/pva-node`), member of `audio`.

### 7.2 Audio prerequisites and backends

- **ALSA** (default on headless boxes: Raspberry Pi OS Lite, minimal Debian / VMs): needs `alsa-utils`. A system
  service as `pva-node` (group `audio`). Devices are addressed by **card name**, never index
  (`plughw:CARD=Speaker,DEV=0`; indexes change with USB order); `plughw` gives resampling to 16 kHz. Device lists for
  admin from `arecord -L` / `aplay -L` (filtered to `plughw:` and `default`).
- **PipeWire** (desktop boxes, or when echo-cancel is wanted): needs `pipewire-bin` (`pw-record`, `pw-cat`) and a
  running user session. PipeWire runs per user, so the unit is a **user** unit of the named desktop user
  (`--user <name>`, `loginctl enable-linger <name>`), installed to `~<name>/.config/systemd/user/pva-node.service`.
  Device lists from `pw-dump` (sources and sinks: `node.name` as id, `node.description` as name).
- `--audio auto` (default): PipeWire if `--user` is given and that user's `pipewire.service` is active, else ALSA.
- **Hardware**: a USB speakerphone with built-in echo cancellation (the conference kind) is the recommended device for
  both a Pi and a VM (USB passthrough): no AEC in our code is needed, and barge-in by phrase works over the reply.
  Without AEC, one-shot still works (barge-in needs the phrase; `EchoGate` `confirm` drops the assistant's own words),
  at the cost of the server decoding the reply it hears (M2 covers it).
- Architectures: `arm64` and `x64` supported and tested; `armv7l` (32-bit Raspberry Pi OS) is refused by the
  installer for now (untested; the KWS binaries may not exist for it).

### 7.3 The server serves the node

- `pnpm --filter @pva/node bundle` (esbuild, ESM, platform node, target node22) writes `apps/node/dist/pva-node.mjs`
  and `apps/node/dist/manifest.json`. `pnpm serve` runs it next to the web build. This is a *distribution* artefact:
  development and tests still run `apps/node/src` with `tsx`, as the rest of the repo (no build step at dev time). The
  bundle includes `effect`, `@pva/protocol`, `@pva/core` (only the parts the node imports), `@pva/audio-pipewire`,
  `@pva/audio-alsa`; native modules (the KWS's `sherpa-onnx-node`) are **not** bundled: when `on-keyword` is on, the
  node installs its pinned npm tarball into `/var/lib/pva-node/kws/` (fetched through the server, which caches it),
  with the model.
- HTTP routes (in `http.ts`, same host checks and headers as the rest): `GET /node/manifest.json` → `{ protocol,
  version, bundle: { path, sha256, bytes }, runtime: { version, "linux-arm64": { url, sha256 }, "linux-x64": { url,
  sha256 } } }`; `GET /node/pva-node.mjs`; `GET /node/install.sh` (static; takes the server URL from its own
  `--server` argument or from the URL it was fetched from, which the admin command passes); `POST /node/pair` (§5.1).
  Missing `apps/node/dist` → `/node/*` answers 404 and admin's Add dialog says "Build the node bundle: `pnpm --filter
  @pva/node bundle`".
- **Runtime download**: the installer fetches Node from `nodejs.org` and checks it against the SHA-256 the manifest
  pins (the server's source tree pins the version and hashes; a bump is a code change). A box without internet gets
  the runtime with `--runtime <tarball>`.
- **Updates**: on every connect (and on `node.command update`), before `hello`, the node fetches the manifest. If
  `bundle.sha256` differs from its own, it downloads the bundle, checks the hash, writes
  `releases/<sha>/pva-node.mjs`, switches `current` atomically (rename of a new symlink), and exits 0; systemd
  restarts it on the new bundle. If the new bundle fails to reach `welcome` three starts in a row, the node switches
  back to the previous release and reports `lastError`. A 4400 (protocol mismatch) triggers the same check. Since the
  bundle is built from the server's own checkout, a node always ends up on the server's protocol version, and no
  separate release channel exists. The runtime (root-owned) is not replaced by the node itself (see the unit notes
  below).
- **Unit** (system variant):

  ```ini
  [Unit]
  Description=Personal voice assistant node
  After=network-online.target sound.target
  Wants=network-online.target

  [Service]
  User=pva-node
  SupplementaryGroups=audio
  ExecStart=/opt/pva-node/runtime/current/bin/node /opt/pva-node/releases/current/pva-node.mjs --config /etc/pva-node/node.json
  Restart=always
  RestartSec=2
  # hardening that does not break ALSA
  NoNewPrivileges=yes
  ProtectSystem=strict
  ReadWritePaths=/var/lib/pva-node /opt/pva-node/releases
  ProtectHome=yes
  PrivateTmp=yes

  [Install]
  WantedBy=multi-user.target
  ```

  Self-update writes to `/opt/pva-node/releases`, which is why that directory (unlike the runtime) belongs to
  `pva-node`. A runtime update is therefore done by the installer (`install.sh --upgrade-runtime`), not by the node;
  the node only reports in `lastError` that the manifest pins a newer runtime. The builder records the final
  ownership under Status.
- **Uninstall**: `install.sh --uninstall` stops and removes the unit, `/opt/pva-node`, `/etc/pva-node`,
  `/var/lib/pva-node` and the user. Removing the device in admin is separate (and also works when the box is gone).

### 7.4 The node program (`apps/node`)

```
apps/node/src/
  main.ts          CLI: run (default), pair --code (used by install.sh), status, devices (list audio devices), test-tone
  config.ts        node.json read/write (0600), schema-validated
  connection.ts    WebSocket client (Node 22 global WebSocket; wss with optional pin via a custom https agent where
                   needed), hello, welcome, reconnect with backoff 0.5 s → 30 s with jitter, forever; 4403 → 10 min
  session.ts       the device side of the protocol: audio.claim, mic.state, mic frames (seq per protocol), reply
                   playback with reports (§4.4), cues, state tracking for the lapse cue and on-keyword streaming,
                   node.status, node.command, node.level
  audio.ts         backend choice (pipewire | alsa | file), device listing, opening by profile ids, reopen on change
  update.ts        manifest check, download, atomic switch, rollback (owned by WP-4)
  kws.ts           (WP-10) the on-keyword gate on top of packages/kws-sherpa
```

Development and test flags: `--input-wav <file|dir>` (via `@pva/audio-file`, paced in real time) and `--output-wav
<dir>`, so a node runs on a machine without a sound card (this one) and `bench`-style runs replay the bench WAVs
through a real node to a real server. The node prints the `turn.end.trace` it receives as a latency line, so node
numbers come from the same `TurnTrace`.

## 8. Alternatives considered and rejected

- **Speech on the node** (STT and TTS on the box, only text to the server). A Pi cannot run Parakeet at useful speed
  and the owner does not want a ~1 GB model on each box; it duplicates engines, model downloads and settings per box.
  It remains possible later as a different `micStreaming`-like option, because the server protocol already accepts
  typed turns; not designed here.
- **Chromium kiosk on the box** opening the voice page. Works today as a stopgap, but needs TLS (secure context),
  autoplay and microphone-permission workarounds, ~300 MB of RAM on a Pi, a display server, and no supervision. The
  browser device's profile also carries fields that mean nothing headless.
- **A separate node protocol** (gRPC, raw TCP, MQTT). Our WebSocket protocol already carries everything needed:
  mic frames, reply frames, playback reports for exact interrupted history, profiles pushed live, barge-in. A second
  protocol would duplicate the session wiring.
- **Wyoming / Home Assistant satellite compatibility** (run `wyoming-satellite` on the box). Its satellite protocol
  has no playback-progress reporting, so interrupted-history accuracy and the playback timeout would be lost, and the
  wake/one-shot logic would live in a third place. A Wyoming bridge on the server is possible later if the owner wants
  existing satellites; not now.
- **Node-side wake detection only** (no server verification). Two matchers with different behaviour, the phrase
  tester could not show what the node decided, and a false fire would start a turn.
- **One-shot as "wake-phrase with follow-up 0"**, no new mode. Close, but it gives no "phrase alone stops the reply",
  no answer window for confirmations, no prompt instruction, and the UI could not say "one-shot" plainly; the owner
  asked for it as the defining behaviour.
- **Node credential in the vault.** The vault is locked after every start; nodes must connect unattended. Only a
  SHA-256 is stored, in `settings.json`, like any token digest.
- **Nodes log in with the admin password.** Every box would then hold full admin rights.
- **TV-style pairing** (the node shows a code that admin types). The node has no display; the installer runs in a
  shell anyway, so an admin-issued code is simpler.
- **Python node** (the openWakeWord ecosystem). A second language and runtime; the protocol schemas could not be
  shared.
- **Install from git + pnpm on the box.** Needs repository access, pnpm and ~100 MB of dev dependencies per box,
  and leaves version skew to the owner. Serving the bundle from the server avoids all three.
- **A `.deb` package.** Cleaner for Debian, but needs a build and an apt repository, and does not solve updates
  better than the server-pulled bundle. Possible later.

## 9. Measurements (what must be measured, and how)

No latency claim in this design is made from reasoning. These are the numbers the work packages must produce, under
Status, before a default is changed or a claim is written down.

| Id | What | How | Decides |
|---|---|---|---|
| M1 | Node CPU and memory, `continuous` | Pi 4 and Pi 5 (and one x86 VM), node idle and during 20 turns: `pidstat -u -r -p <node, pw-record/arecord, pw-cat/aplay> 1` for 10 min; median and p95 CPU %, max RSS | that a Pi 4 is enough (target set by the owner; recorded, not assumed) |
| M2 | Server cost of always-streaming rooms | Two sessions on the real server with the local models: session A replays 30 min of TV/podcast audio through a node (`--input-wav`), session B replays the bench WAVs with turn ends; `TurnTrace` of B (`endOfTurn → llmRequestSent`, `→ playbackStart`) with and without A; stt-sherpa worker CPU (`pidstat`) and decodes per hour of A (a counter per session in the worker's stats) | the `micStreaming` default (§6) |
| M3 | Wake cue delay, server-side detection | Node logs the time of receiving `wake { armed: true }`; the phrase-alone WAVs have a known end of speech; report median / p95 from end of phrase to cue start (cue start = the node's first write of the cue) | whether `on-keyword` is worth it for the cue alone |
| M4 | Keyword spotter on the node | Pi 4: CPU % (`pidstat`), RTF per 20 ms frame; misses on ≥ 50 recorded wakes of the owner (from `data/recordings`, re-recorded on the node's mic); false fires per hour on ≥ 3 h of TV/podcast audio; fire delay after the keyword's end | `on-keyword` as default (§6 thresholds) |
| M5 | Node vs browser end-to-end | Same server, same WAVs: a browser device (headless Chromium with a fake mic, as the e2e-real suite) and a node (`--input-wav`, real player on a box with a sound card): `TurnTrace` `endOfTurn → playbackStart` and `audible=`, median / worst over ≥ 12 turns; plus `continuous` vs `on-keyword` on the node; plus `llmFirstToken` one-shot vs not | the "not worse than a browser" goal; the pre-roll; the one-shot prompt's cache |
| M6 | Questions cut in two | Over ≥ 2 weeks of real use with "Save what the assistant hears" on for a node: share of accepted utterances followed within 3 s by a dropped one | whether a per-device end-of-turn silence is needed (§3.4) |
| M7 | `bench` one-shot | Offline `pnpm start bench` with a one-shot scenario (phrase + request, phrase alone then request, phrase over a reply) next to the existing `always` and `wake-phrase` rows | that one-shot costs nothing measurable on the existing path |

## 10. Dependency on the voice-sessions branch

The voice-sessions work (worktree `t3-df5e7db3`, branch `t3/multi-tab-assistant-sessions`) modifies, among others:
everything under `packages/protocol/src` except `admin.ts`, `agents.ts`, `codec.ts`, `env.ts`, `frames.ts`, `jobs.ts`,
`settings.ts`, `vault.ts`; `apps/assistant/src/serve/{Engine,HeardAudio,Publisher,SessionHub,frontends,
sectionDefinitions,serveMode}.ts` and new `{SessionConversation,VoiceSession,VoiceSessions}.ts`;
`apps/assistant/src/bench/offline.ts`; `packages/audio-web/src/WebAudio.ts`; `packages/core/src/{Agent,Conversation,
ConversationEvents,ModuleContributions,ModuleHost,TurnTrace}.ts`; `packages/stt-sherpa/**`;
`packages/agent-claude-code/**`; most of `apps/web/src`; `docs/ARCHITECTURE.md`, `docs/UI-AND-MODULES.md`.

It does **not** touch: `packages/core/src/WakeGate.ts`, `packages/audio-pipewire`, `packages/audio-file`,
`apps/assistant/src/serve/{http,SettingsStore,AdminSessions}.ts`, and creates nothing under `apps/node` or the new
packages here.

**Needs the branch landed** (it provides: a session per device, so a node does not take the audio from a browser;
profile → session wiring; `conversationIdleMinutes`; per-session wake gates; the session's control queue for
`newConversation`; `sessions` in admin): the protocol 7 work, all server wiring, the admin web work, and the node's
protocol-7 features.

**Can start now on `main`**, touching none of the files above: the ALSA backend and device listing, the one-shot
gate in core, the node client skeleton against protocol 5 (it reads `PROTOCOL_VERSION` from `@pva/protocol`, so it
follows the bump), the packaging and installer, and the keyword-spotter spike. Without the branch, a node on `main`
works as a device of an unknown kind (the server treats it "like no device": kind defaults, shared audio owner); that
is good enough to exercise capture, playback reports and reconnects against a real server.

**Constraint on the branch's limits**: every connected node holds a voice session for as long as it is connected
(it claims at connect). `MAX_VOICE_SESSIONS` (default 4, at most 8 in that branch) therefore counts nodes plus
browsers. Open question 4.

## 11. Risks

- **Echo without AEC.** The mic hears the reply; the server decodes it (CPU, M2). One-shot's "phrase needed during a
  reply" and `EchoGate` keep it from acting, but a reply that itself contains a wake phrase ("say 'hey Jev' to…")
  would stop itself. Mitigation: recommend AEC hardware; the `ONE_SHOT_INSTRUCTIONS` could ask the model not to say
  the phrase (left out until seen).
- **Shared decode queue contention** with several always-streaming rooms (M2). Mitigation: `on-keyword`.
- **One-shot cuts a slow question in two** (§3.4, M6).
- **Clock-estimated playback counts** drift from what was audible by the player's real buffering (pipe + device
  buffer, tens of ms). History may mark a clause as heard that was cut 50 ms before it began. Acceptable; the
  estimate is clamped to what was written.
- **Self-update** could brick a node with a bad bundle. Mitigation: hash check, keep the previous release, automatic
  rollback after three failed starts, and the server only serves what it runs itself.
- **Version skew during an update**: a node on the old bundle meets a new server with 4400; it updates first, so the
  window is one reconnect.
- **ALSA device names** differ per box and change with USB ports for identical devices. Mitigation: card names, the
  device list in admin, and "System default" as the default.
- **PipeWire as a user service** needs lingering and a known user; the installer's `auto` may pick wrongly. The
  status in admin shows the backend; the installer takes `--audio`.
- **Plain `ws://` on the LAN** exposes the credential and room audio (§5.2, open question 2).
- **sherpa-onnx keyword spotter in Node on arm64** (WP-5 must verify): that `sherpa-onnx-node` 2.x exposes the
  keyword spotter, ships `linux-arm64` binaries, and how keywords are given (the English model expects BPE tokens; if
  plain text is not accepted, a TypeScript encoder from the model's `tokens.txt` / `bpe.vocab` must match the
  reference `text2token` on the phrase set). If any of this fails, `on-keyword` is dropped and `continuous` stays.
- **The voice front end still has no login**: a node credential secures nodes, not the server. Anyone who can reach
  the port can still be a browser device. Unchanged by this design, but nodes make listening beyond loopback common,
  so the README's warning must be repeated in the Add dialog.
- **Session limit** (§10, open question 4).

## 12. Build plan

Work packages own disjoint files, so packages without a dependency between them can run in parallel. Every package
ends with `pnpm check` and `pnpm test` passing and its Status entry written. Order: what can start on `main` today
first.

### Can start now (against `main`)

**WP-1 ALSA backend and audio device listing** — *clear*
- Scope: `arecord` / `aplay` capture and playback with the same contract and tests as audio-pipewire (16 kHz s16le
  mono capture, per-call player, SIGKILL on interrupt, stall timeout, sliding 3 s buffer); device listing for both
  backends (`arecord -L` / `aplay -L` parsed to `AudioDeviceInfo`; `pw-dump` JSON to sources and sinks).
- Owns: `packages/audio-alsa/**` (new); `packages/audio-pipewire/src/devices.ts` (new) and its export line in
  `packages/audio-pipewire/src/index.ts`; `packages/audio-pipewire/test/devices.test.ts`.
- Depends on: nothing. Branch: independent.
- Acceptance: unit tests with stand-in commands (as audio-pipewire's) for capture framing, playback drain, interrupt,
  stall; parser tests on recorded `arecord -L`, `aplay -L` and `pw-dump` outputs (check in samples from a Pi and a
  Debian VM); `pnpm check`, `pnpm test`.

**WP-2 One-shot in the wake gate** — *clear*
- Scope: §3.1–3.2 in `WakeGate`: the `one-shot` activation (local `WakeActivation` type until protocol 7),
  TAKEN state, `answerWindow`, `woke.duringReply`, `taken()`, `wakeConfigFromProfile` mapping; header comment.
- Owns: `packages/core/src/WakeGate.ts`, `packages/core/test/WakeGate.test.ts` (and a new
  `packages/core/test/WakeGateOneShot.test.ts` if preferred).
- Depends on: nothing. Branch: independent (file untouched there); the type alias is replaced in WP-6.
- Acceptance: tests for each transition of §3.1, phrase alone during TAKEN (`duringReply`), answer window admits one
  utterance and lapses, no follow-up after `replyEnded`, `followUpMs` ignored; the existing seeded property test of
  the utterance contract extended to `one-shot` (400 runs); every existing `always` / `wake-phrase` test unchanged;
  `pnpm check`, `pnpm test`.

**WP-3 Node client skeleton (`apps/node`)** — *ambiguous*
- Scope: §7.4 without `update.ts` and `kws.ts`: config, connection and reconnect, hello (protocol 5 now: `device`
  with kind `voice-node`, no `node` field until WP-10), `audio.claim`, mic streaming with sequence numbers, reply
  playback with reports and volume (§4.4), cues, `--input-wav` / `--output-wav`, latency line from
  `turn.end.trace`, CLI `run`, `devices`, `test-tone`. `package.json` with a `bundle` script that runs WP-4's
  `scripts/bundle.mjs`.
- Owns: `apps/node/package.json`, `apps/node/tsconfig.json`, `apps/node/src/**` except `update.ts` and `kws.ts`,
  `apps/node/test/**` except `update.test.ts`, `apps/node/README.md`; the root `tsconfig.json` reference line for
  `apps/node` (a one-line change; nothing in the branch's list).
- Depends on: WP-1 for the ALSA backend (can start on PipeWire and `audio-file`, add ALSA when WP-1 lands). Branch:
  independent.
- Acceptance: tests against a scripted fake server in `apps/node/test` (handshake, claim, mic frames and sequence,
  reply playback reports: started / progress monotonic and clamped / finished / stopped on `reply.stop` within
  300 ms, reconnect with backoff, `sessions_full` retry); a manual run against the real server on `main` with
  `--input-wav` replaying `bench-audio` and `--output-wav`, with the `TurnTrace` lines recorded under Status (not a
  claim, a first data point); `pnpm check`, `pnpm test`.
- Judgement needed: playback count estimation per backend; how much of the reply to buffer; reconnect while a reply
  plays.

**WP-4 Packaging, installer, updates** — *ambiguous*
- Scope: §7.1–7.3 on the node side: `scripts/bundle.mjs` (esbuild → `dist/pva-node.mjs` + `manifest.json`, runtime
  pins), `install.sh` (arch check, runtime download and hash check, user, files, unit, `--audio auto|alsa|pipewire`,
  `--user`, `--code` or prompt, `--tls-pin`, `--runtime`, `--upgrade-runtime`, `--uninstall`), both unit templates, `update.ts` (manifest
  check, download, atomic switch, rollback after three failed starts).
- Owns: `apps/node/scripts/**`, `apps/node/install/**` (install.sh, unit templates), `apps/node/src/update.ts`,
  `apps/node/test/update.test.ts`. Adds `esbuild` to `apps/node` devDependencies (through WP-3's `package.json`:
  coordinate, or WP-3 adds it).
- Depends on: WP-3 (the program to bundle). Branch: independent (the server routes are WP-7).
- Acceptance: `update.test.ts` (hash mismatch refused, atomic switch, rollback after three failures, 4400 triggers a
  check) with a local HTTP fixture; `shellcheck install.sh`; a real install on a Raspberry Pi OS Lite arm64 box and a
  Debian 13 x86-64 VM (serving the bundle from a static file server until WP-7), recorded under Status: install time,
  disk used, the service surviving a reboot and a server restart; `pnpm check`, `pnpm test`.

**WP-5 Keyword-spotter spike (`packages/kws-sherpa`)** — *ambiguous*
- Scope: verify the risks of §11 (sherpa-onnx-node keyword spotter API, linux-arm64 binaries, keyword tokenisation);
  if they hold, a small `KeywordSpotter` service (`detect(frames): Stream<{ phrase, at }>`, phrases settable live,
  threshold), the model download preset, and a measurement script for M4.
- Owns: `packages/kws-sherpa/**` (new).
- Depends on: nothing. Branch: independent.
- Acceptance: M4 numbers on a Pi 4 under Status, and a go / no-go written there; if go: unit tests with a recorded
  WAV that contains the phrase and one that does not; `pnpm check`, `pnpm test` (the live model test opt-in, as for
  the other sherpa packages).

### After the voice-sessions branch has landed on `main`

**WP-6 Protocol 7** — *clear*
- Scope: §4.1–4.3 schemas, `PROTOCOL_VERSION = 7` with its changelog paragraph, examples for every new message,
  `effectiveProfile` with the per-kind built-in layer, `PER_DEVICE_FIELDS`, `VOICE_NODE_KIND`, close code 4403; replace
  WP-2's local `WakeActivation` with `Activation`.
- Owns: `packages/protocol/**`; the one alias line in `packages/core/src/WakeGate.ts` (after WP-2 is merged).
- Depends on: the branch; WP-2 merged.
- Acceptance: round-trip tests of every example, `frontends.test.ts` for the new layer and fields and the refusal of
  per-device fields at kind level; minimal mechanical edits in `apps/assistant` and `apps/web` so `pnpm check` and
  `pnpm test` pass, each marked `TODO(nodes)` with what WP-7 / WP-9 do (as protocol 5 did).

**WP-7 Server: nodes, pairing, auth, distribution** — *ambiguous*
- Scope: §5.1, §5.2, §4.2–4.3 server side, §7.3 routes: `nodes.ts` (pairing codes, back-off per address, credential
  check, node info and status per device, command relay, `node.level` relay), `/node/*` routes, hello verification
  and 4403, the `voice-node` kind with built-in defaults and fields, `SettingsStore` version 4 (`DeviceRecord.node`),
  `device.forget` revoking, `NODE_SERVER_URL` setting, `ADMIN_ONLY` additions.
- Owns: `apps/assistant/src/serve/{nodes.ts (new), http.ts, SessionHub.ts, frontends.ts, SettingsStore.ts,
  sectionDefinitions.ts}`, `apps/assistant/test/{serveNodes.test.ts (new), httpNodes.test.ts (new)}`, and the existing
  tests of those files.
- Depends on: WP-6. WP-4 for a bundle to serve (tests use a fixture).
- Acceptance (scripted client): pairing success, expired, wrong, reused, back-off, `admin_disabled`; a `voice-node`
  hello without / with a wrong / with a revoked credential → 4403; an unpaired device id posing as a node → 4403;
  forget closes a connected node; `node.status` → `devices` to admin, throttled; commands reach only that node;
  `test-mic` levels reach admin only; `/node/manifest.json`, bundle and install script served with the host check;
  settings v3 → v4 read and write; `pnpm check`, `pnpm test`.

**WP-8 Server: one-shot wiring in the voice session** — *ambiguous*
- Scope: §3.3: `duringReply` → Interrupt; answer window after a played confirmation question; `replyEnded` for turns
  without a reply; `newConversationOnWake` through the control queue; `ONE_SHOT_INSTRUCTIONS`; the bench one-shot
  scenario (M7).
- Owns: `apps/assistant/src/serve/{VoiceSession.ts, SessionConversation.ts}`, `apps/assistant/src/bench/offline.ts`,
  `apps/assistant/test/{serveOneShot.test.ts (new), bench.test.ts}`.
- Depends on: WP-2, WP-6, the branch.
- Acceptance (scripted client, injected providers): phrase + request → one reply → an utterance without the phrase is
  ignored (no turn, no history); phrase alone during a reply stops it within the stop deadline and arms; phrase +
  request during a reply replaces it; answer window with `confirmActions` on; lapse returns to `asleep`;
  `newConversationOnWake` empties history before the turn (including a promoted speculative turn); the one-shot
  instruction is in the request; M7 bench numbers before / after under Status; `pnpm check`, `pnpm test`.

**WP-9 Admin web: devices for every kind** — *ambiguous*
- Scope: §5.3: rename to Device defaults and the kind titles, the Devices list for every kind, node device pages
  (status, actions, audio group with device selects and volume, remove), Add voice node dialog (code, command,
  countdown, `node.paired`, URL and loopback warnings, missing-bundle notice), the tester's "Listen to" including
  nodes; mock server support for nodes.
- Owns: `apps/web/**`.
- Depends on: WP-6 (schemas); WP-7 for the real-server check (the mock is enough to build).
- Acceptance: unit tests for the reducer (`DeviceInfo.node`, `node.paired`, `node.level`) and the forms; e2e on the
  mock: add a node (dialog → code → paired), node page actions send `node.command.send`, audio selects from status,
  per-device fields absent from Device defaults, remove with confirmation, no horizontal scroll at 320 px; screenshots
  regenerated; `pnpm --filter @pva/web check`, `pnpm check`, `pnpm test`, `pnpm --filter @pva/web e2e`.

**WP-10 Node: protocol 7 features and on-keyword streaming** — *ambiguous*
- Scope: `hello.node` with the credential, `pair --code` CLI (used by install.sh), 4403 handling, `node.status` and
  hot-plug, `node.command` (identify, tests, restart, update), `node.level`, opening the profile's audio devices and
  reopening on change; if WP-5 said go: `kws.ts` with pre-roll and the streaming rules of §6.
- Owns: `apps/node/src/**` except `update.ts`, `apps/node/test/**` except `update.test.ts` (the same files as WP-3,
  taken over after WP-3 is merged; the two never run at once).
- Depends on: WP-3, WP-6; WP-7 for the real-server check; WP-5 for `on-keyword`.
- Acceptance: fake-server tests for each message and command, credential refusal and the 10 min retry, device reopen
  on profile change, on-keyword: nothing sent before a fire, pre-roll then live, stop on `thinking` / `asleep`,
  restart on `wake armed`; `pnpm check`, `pnpm test`.

**WP-11 Integration and measurements** — *ambiguous*
- Scope: real server (its own port and data directory; never the owner's service on 8787) with a Pi 4 / Pi 5 node and
  an x86 VM node; measurements M1–M5 (M6 starts here, reported later); README section "Voice nodes" (install, audio,
  TLS, troubleshooting); docs/ARCHITECTURE.md (a node is a device; the `voice-node` kind; one-shot in the WakeGate
  paragraph; `/node/*`); this document's Status; decide the `micStreaming` default with M2 / M4.
- Owns: `README.md`, `docs/ARCHITECTURE.md`, `docs/VOICE-NODES.md` (Status), measurement scripts under
  `apps/node/scripts/measure/` (coordinate with WP-4, which owns `scripts/`: put them in WP-4 or agree a sub-folder).
- Depends on: WP-1 … WP-10 (WP-5 / on-keyword optional).
- Acceptance: the numbers under Status with the commands that produced them; `pnpm check`, `pnpm test`, web e2e.

**WP-12 Per-device agent** — *ambiguous*, later
- Scope: §5.4. Owns: whatever the agent wiring leaves; designed then.
- Depends on: agents and intents wired into the app (docs/AGENTS-AND-INTENTS.md), WP-6.

```
now:    WP-1 ─┐
        WP-2 ─┼──────────────┐
        WP-3 ─┴─ WP-4        │          WP-5 (spike)
                  │          │            │
branch lands ───▶ WP-6 ──┬── WP-7 ──┬──── WP-10
                         ├── WP-8   │
                         └── WP-9 ──┘
                                    └──── WP-11 (needs all)        WP-12 (after agents are wired)
```

## 13. Open questions for the owner

Each has a recommended default; work proceeds on it until he says otherwise.

1. **Each wake: a fresh conversation, or continue?** Recommended: **continue**, with nodes forgetting after 2 quiet
   minutes (`conversationIdleMinutes: 2` for the Voice node kind), so "Hey Jev, what's the weather" … "Hey Jev, and
   tomorrow?" works. "New conversation on each wake" is a per-node switch.
2. **Plain `ws://` on the home network, or TLS required for nodes?** Recommended: **allowed, with a warning badge in
   admin**, TLS recommended in the Add dialog (a pin makes a self-signed certificate easy). Requiring TLS blocks
   nodes until a certificate is set up.
3. **Is "room audio never leaves the box until the wake phrase" a requirement?** Recommended: **no for the first
   release** (the server is his own machine, ignored speech is never stored), so nodes stream continuously and need
   no model; on-keyword becomes the default only if the measurements say so or he answers yes.
4. **Session limit.** Every connected node permanently uses one of the `MAX_VOICE_SESSIONS` voice sessions (default
   4, at most 8). Recommended: **count nodes as sessions, raise the upper bound to 16**, and have the Add voice node
   dialog warn when the limit would be reached.
5. **Wake phrases for nodes.** Recommended: the same built-in phrases as browsers ("hey jeff", "hey jev", "hey
   geoff"), editable per kind in Device defaults and per node.

## Status

Nothing built yet. Each work package adds its entry here: what was built, where, differences from this design and
why, the commands run and their results, and the measurements of §9 it produced.

### WP-3 Node client skeleton (2026-11-14, branch `t3/add-headless-voice-node-client`)

**Built**: `apps/node` (`@pva/node`), protocol 5. `main.ts` (CLI `run`, `devices`, `test-tone`), `config.ts`,
`connection.ts`, `session.ts`, `playback.ts`, `audio.ts`, `tones.ts`, `node.ts` (`runNode`: one capture and one reply
player per process, a fresh `Session` per connection), `README.md`. The node uses the core audio contract
(`AudioInput` / `AudioOutput`) plus a small `NodeAudioInfo` service (backend names, player latency, cue output);
PipeWire through `@pva/audio-pipewire` (`captureCommand` / `playbackCommand` / `captureStream` / `playThrough`), files
through `@pva/audio-file`; input and output are chosen separately.

**Seams left** (each a named place, marked `TODO(...)` or "WP-n seam" in the code):
- WP-1: `alsaLayers` in `audio.ts` (fails with a clear message until `@pva/audio-alsa` exists) and `listDevices`
  (only "System default" until the `arecord -L` / `aplay -L` / `pw-dump` parsers land); `AudioDeviceInfo` declared
  locally.
- WP-4: `bundle` script runs `scripts/bundle.mjs` (not there yet; esbuild not added as a dependency); `onOutdated` in
  `runNode` for the 4400 → update check.
- WP-6: `VOICE_NODE_KIND` (node.ts) and `UNAUTHORIZED_CLOSE_CODE = 4403` (connection.ts) declared locally;
  `isSessionsFull` (session.ts) sniffs the raw text because protocol 5's `ErrorCode` lacks `sessions_full`.
- WP-10: `helloFor` (add `hello.node`), `NodeSettings` (volume and cues from the profile instead of `--volume` /
  `--no-cues`), `inputDevice` / `outputDevice` in `NodeAudioOptions` (profile `audioInput` / `audioOutput`),
  `writeConfig` (for `pair --code`), `identifySound` / `testTone` (for `node.command`), `tlsPin` read but unused.

**Differs from the design, and why**:
- `ws` instead of Node 22's global `WebSocket` (§7.4): same `bufferedAmount` behaviour, and it takes an agent /
  `checkServerIdentity`, which the `tlsPin` of WP-10 needs. Pure JavaScript, bundles fine.
- Progress estimate (§4.4): the formula `min(written, (now − startedAt − latency) × rate)` counts the idle time of an
  underrun as played. `PlaybackClock` restarts the estimate at the write that follows an underrun (counted in
  `underruns`), still clamped to `written` and non-decreasing.
- Shared owner on protocol 5: the node does not claim back when a browser takes the audio (`taken_over`); it claims
  again only once `ownerPresent` is false, so the two do not fight. With voice sessions this case goes away.
- A lost connection stops the playing reply without a report (the server has already failed the turn on owner loss).
- The capture starts when the node first owns the audio and then runs for the life of the process; with
  `--input-wav`, audio replayed while the server is unreachable is lost (seen in the restart run below).
- With `--output-wav`, cues go to their own `cue-NNN.wav` series so `reply-NNN.wav` stays one file per reply.
- The root `tsconfig.json` needed no change: it already includes `apps/*/src` and `apps/*/test`.

**Tests** (`apps/node/test`, 25): a scripted server on a real `ws` socket speaking the `@pva/protocol` codecs —
hello / claim / `mic.state`; no frames before ownership, then sequence 0…n; owner taken and given back (claim again,
sequence from 0); reply reports started → progress (monotonic, ≤ written) → finished with every sample; volume;
`reply.stop` answered with `playback.stopped { exact: true }` in under 300 ms and the player interrupted; reply stopped
on connection loss, next reply after reconnect; wake and lapse cues; the latency line; backoff 40 → 80 → 160 → 200 →
200 ms (base and cap shortened) and reset after a welcome; `sessions_full` → claim again; 4403 → the 10-minute retry.
Plus units for the clock, gain, backoff (0.5 s → 30 s, equal jitter), close codes, config (0600), URL, tones and
`--input-wav`. `pnpm check` and `pnpm test` pass (2779 tests).

**Manual run on main (first data points, not claims)**: a real server on port 8799 with its own data directory
(`LLM_PROVIDER=fake`, local Parakeet v2 STT, Piper), this machine (no sound card: PipeWire with only the null sink).
1. `pnpm --filter @pva/node start --server http://127.0.0.1:8799 --input-wav bench-audio --input-gap-ms 9000
   --output-wav <dir>`: all five bench WAVs answered, five `reply-NNN.wav` written. Node latency lines:

   ```
   turn #1 voice (speculative) completed llmRequestSent=-171ms llmFirstToken=-171ms (+1ms) firstClause=-154ms (+17ms) ttsFirstAudio=-31ms (+123ms) playbackStart=15ms (+46ms) audible=15ms (+0ms output latency, start delay 3ms) voices: standard total=1915ms
   turn #2 voice (speculative) completed llmRequestSent=-137ms llmFirstToken=-131ms (+6ms) firstClause=-71ms (+60ms) ttsFirstAudio=-1ms (+70ms) playbackStart=2ms (+3ms) audible=2ms (+0ms output latency, start delay 0ms) tools: current_time 5ms voices: standard total=5828ms
   turn #3 voice (speculative) completed llmRequestSent=-101ms llmFirstToken=-101ms (+0ms) firstClause=-86ms (+15ms) ttsFirstAudio=-32ms (+54ms) playbackStart=5ms (+37ms) audible=5ms (+0ms output latency, start delay 0ms) voices: standard total=2973ms
   turn #4 voice completed llmRequestSent=11ms llmFirstToken=11ms (+0ms) firstClause=26ms (+15ms) ttsFirstAudio=109ms (+83ms) playbackStart=110ms (+2ms) audible=110ms (+0ms output latency, start delay 1ms) voices: standard total=2745ms
   turn #5 voice (speculative) completed llmRequestSent=-192ms llmFirstToken=-192ms (+0ms) firstClause=-178ms (+15ms) ttsFirstAudio=-136ms (+42ms) playbackStart=2ms (+137ms) audible=2ms (+0ms output latency, start delay 0ms) voices: standard total=1956ms
   ```
2. The same with real `pw-cat` playback into the null sink (bench WAVs 01 and 03): `playbackStart=12ms … audible=32ms
   (+20ms output latency)` and `playbackStart=9ms … audible=29ms`.
3. Server stopped and restarted under a running node: `1001` → refused at 0.5, 0.6, 1.8, 3.9 s → reconnected, and
   the next WAV was answered (`turn #1 … completed`).

**Not verified**: a real microphone and speaker (no sound card here), ALSA, a Raspberry Pi, CPU (M1).

### WP-4 Packaging, installer, updates (2026-11-14, branch `t3/voice-node-wp4`)

Built on the merge of WP-1, WP-2 and WP-3. **Integration first** (own commit): the merged tree needed no lockfile or
link fixes; `pnpm check` passed and the one test failure seen (`audio-pipewire` "a consumer that falls behind…", a
load-sensitive timing test unchanged since PR #1) passes alone; it failed in 2 of 7 full `pnpm test` runs on this
machine during this work, and is left alone here (not this package's file). WP-1 is plugged into WP-3's
seams in `apps/node/src/audio.ts`: `alsaLayers` runs `@pva/audio-alsa`'s `arecord` / `aplay` (an empty profile device is
ALSA's `default`), `listDevices` returns `pw-dump` sources / sinks or the `default` + `plughw:` PCMs, and the node's
`--audio` gained **`auto`** (its new default): PipeWire when this process's PipeWire socket (`$PIPEWIRE_RUNTIME_DIR` or
`$XDG_RUNTIME_DIR` + `pipewire-0`) exists and `pw-record` / `pw-cat` are installed, else ALSA — so the system unit (no
session) always gets ALSA. `test/audio.test.ts` runs stand-in `arecord` / `aplay` / `pw-dump` from `PATH` and checks the
exact command lines.

**Built** (all in `apps/node`):
- `scripts/bundle.mjs` (`pnpm --filter @pva/node bundle`): esbuild (catalog `esbuild 0.28.2`, ESM, node22) →
  `dist/pva-node.mjs` (1.6 MiB, 1301 inputs), `dist/pva-node-boot.mjs` (5 KiB), `dist/install.sh` (the source with the
  runtime pins and both unit templates filled in), `dist/manifest.json`. The bundle contains only what the source
  determines (`version` = `<package version>+<10-char git sha>[.dirty][.<--label>]`, no timestamp), so the same commit
  gives the same hash (tested) and nodes do not update for nothing. The build runs the bundle (`version`) to read its
  protocol and check its hash. `scripts/runtime.json` pins **Node 22.23.5** (`.tar.gz`, nodejs.org SHA256SUMS);
  `scripts/pin-runtime.mjs <22.x.y>` rewrites it (reproduced the committed file exactly). `scripts/serve-dist.mjs`:
  a stand-in for WP-7's routes (serves `dist/` under `/node/`, proxies everything else including `/ws`).
- **Manifest, format 1** (`Manifest` in `src/update.ts` is the contract): `{ format: 1, protocol, version, builtAt?,
  bundle: { path, sha256, bytes }, boot: { path, sha256, bytes }, installer?: { path, sha256, bytes }, runtime: { version,
  "linux-arm64": { url, sha256 }, "linux-x64": { url, sha256 } } }`; `path`s are relative to the manifest URL.
- `install/install.sh` (POSIX sh; `shellcheck -s sh` 0.11.0 clean on the source and the built copy; `-o all` adds only
  style notes): arch check (arm64, x64; `armv6l`/`armv7l` refused), root and systemd checks, runtime download and
  SHA-256 check against the built-in pin (or `--runtime <tarball>`, still checked), `include/` and `share/` dropped
  (−65 MB), system user `pva-node` in `audio`, the files and modes of §7.1, the boot guard and release checked against
  the manifest (length and hash), pairing with `--code` (or a prompt on `/dev/tty`), `--no-pair [--device-id] [--name]`
  for servers without pairing, `--tls-pin`, `--audio auto|alsa|pipewire`, `--user` (PipeWire user unit with lingering),
  `--upgrade-runtime`, `--uninstall`, and `--root <dir>` (stage into a directory, system changes only recorded in
  `actions.log`: how the tests run it). Re-running keeps what is right and remembers server / audio / user in
  `/etc/pva-node/install.env` (never sourced). Any hash or length mismatch stops it before anything changes; downloads
  are never run by a shell (the JSON manifest is parsed by the installed Node and every value is validated).
- `install/pva-node.service` (system) and `install/pva-node-user.service` (user).
- `src/update.ts` (manifest check before every connection attempt and right after a 4400; download capped at
  `bundle.bytes` and 32 MiB; switch; exit 0), `src/releases.ts` (release dirs, `state.json`, start counting, rollback,
  pruning; plain `node:fs`), `src/boot.ts` (the boot guard), `src/pair.ts` + CLI `pair`, `configure`, `version`; hooks
  in `runNode` (`updates`: check, `welcomed`, probation; returns `Updated` / `FailedStart`).

**Final ownership** (§7.1): `/opt/pva-node`, `runtime/`, `pva-node-boot.mjs`, `/etc/pva-node/`, `install.env`: root
(0755 / 0644); `releases/` (with `current`, `previous`, `state.json`): the node's user; `/etc/pva-node/node.json`: the
node's user, 0600; `/var/lib/pva-node`: the node's user, 0700. The node's user is `pva-node` (system unit) or the
`--user` (user unit).

**Differs from the design, and why**:
- **Boot guard.** The unit runs `node /opt/pva-node/pva-node-boot.mjs run --config … --audio <alsa|pipewire>`, not the
  bundle directly (§7.3's `ExecStart`). With the design's line a new bundle that crashes while loading (a syntax error,
  a bad import) can never count its own failed starts, and systemd would restart it for ever: exactly the brick of §11.
  The guard (root-owned, installed by install.sh, not self-updated, no imports beyond `node:`) counts each start of a
  pending release *before* loading it, rolls back after three, then loads `releases/current/pva-node.mjs` in-process
  with the same arguments. The node logs when the server's boot guard differs ("run install.sh again").
- **What counts as a failed start**: every process start of a pending release (counted by the guard), and a running
  pending release exits 1 when the server refused it (close 4400, 1002, 1003, 1007, 1008, or no `welcome` within the
  timeout). An unreachable or restarting server, 1001 / 1006 and 4403 do not count (else a server outage or a removed
  node would roll back a good release and mark it bad). A rolled-back release is put in `state.bad` and never switched
  to again; installing with install.sh clears that.
- **`tlsPin` is the SHA-256 of the certificate's public key (DER SubjectPublicKeyInfo)**, written `sha256:<hex>`: it
  survives renewal with the same key and is what curl's `--pinnedpubkey sha256//<base64>` checks, which install.sh
  uses (`-k` only skips the CA check; the pin is enforced — verified against a self-signed server: match passes,
  mismatch fails with curl error 90). Node's `getPeerCertificate().pubkey` is *not* SPKI for EC keys (it is the bare
  point), so the node hashes the key taken from the certificate (`peerKeySha256`). The node checks the pin when the
  response arrives (public files only); `pair` sends the code only after the pin matched.
- `state.json` lives in `releases/`, next to the links it describes; no update lock (one node process per box, and the
  installer stops the service before it touches releases).
- `pair` / `configure` / `version` and `src/pair.ts` are WP-10's per §7.4 but the installer needs them now; WP-10
  takes them over (the pairing request is §5.1's, see the WP-7 list below).
- `StartLimitIntervalSec=0` (systemd would otherwise give up after 5 quick restarts) and a few more hardening options
  (`ProtectKernel*`, `ProtectControlGroups`, `RestrictSUIDSGID`, `LockPersonality`); they do not affect ALSA.
- The runtime is the `.tar.gz` (gzip is always present; `xz-utils` is not on every minimal image). The manifest repeats
  the runtime pins; install.sh refuses a manifest whose runtime version differs from its own ("download install.sh
  again"), since both are built together.
- The root `pnpm serve` script does not run the bundle yet: that changes how the owner's running service starts, and
  serving is WP-7's; WP-7 adds `pnpm --filter @pva/node bundle` there (or builds on demand).
- After a rollback the orphaned release directories stay until the next confirmed release prunes them (a few MiB).

**WP-7 must serve / implement** (tested here against `scripts/serve-dist.mjs` and test fixtures):
1. `GET /node/manifest.json`, `/node/pva-node.mjs`, `/node/pva-node-boot.mjs`, `/node/install.sh`: the four files of
   `apps/node/dist` byte for byte (the node and installer check length and SHA-256 against the manifest), with the
   usual host check; `Cache-Control: no-store` at least for the manifest; anything else under `/node/` and a missing
   `dist/` → 404. Serve only those names (manifest paths are plain file names; the installer rejects anything else).
2. `POST /node/pair`, request `{ code, hostname, platform: { os, arch, hostname, model? }, version }` with `code`
   already normalised (8 Crockford characters, upper case, no dash, `O`→`0`, `I`/`L`→`1`); answers `200 { deviceId,
   credential, name? }`, `403 { error: "bad_code" | "expired" }`, `503 { error: "admin_disabled" }` (the node prints a
   sentence for each; 404 says "update the assistant").
3. Admin's install command must pass `--server <url>` (a script read from a pipe cannot know where it came from):
   `curl -fsSL <url>/node/install.sh | sudo sh -s -- --server <url> --code K7QM-2XHP`; with a self-signed certificate
   also `--tls-pin sha256:<hex>`, and the `curl` of the command itself needs `-k --pinnedpubkey sha256//<base64 of the
   same digest>`.
4. The pin admin shows: SHA-256 of the server certificate's DER SPKI (`new X509Certificate(pem).publicKey.export({ type:
   "spki", format: "der" })`), as `sha256:<64 hex>`.
5. `DeviceInfo.node.upToDate` = `hello.node.bundleSha256 === manifest.bundle.sha256`; `version` / `bundleSha256` come from
   `pva-node version` / `detectInstall` (WP-10 puts them in `hello.node`).
6. Build the bundle for `pnpm serve` (see above).

**Tests**: `test/update.test.ts` (28): bad hash refused with nothing written, atomic switch (relative symlink renamed
over, no temporaries left), the last confirmed release stays the rollback target across two unconfirmed updates, start
counting and rollback after three, confirmation and pruning, give-up without a previous, stale pending, damaged state;
the updater against a local HTTP fixture (up to date, switch, hash mismatch, over-long body, bad release skipped,
unreachable server, bad manifest, runtime hint once, confirmation) and an HTTPS fixture with a self-signed EC
certificate (pin match, mismatch, no pin); `runNode`: a check before the hello (a new release exits without
connecting), confirmation at welcome, **4400 triggers a check**, failed start on probation, no failed start while the
server is away; the boot guard as a real process (arguments passed through; a bundle that cannot load fails three
starts and is rolled back on the fourth). `test/install.test.ts` (14): builds the real `dist/`, checks the manifest
against the files and reproducibility, then staged installs against a fixture server with a stand-in runtime tarball:
fresh install (files, modes, unit, recorded actions), the staged release running through the guard, idempotent re-run
(only the manifest fetched), pairing (code normalised, wrong code), bundle hash mismatch (fail closed, release
unchanged), runtime hash mismatch, stale installer, armv7 / bad URL / PipeWire without user refused, user unit,
`--upgrade-runtime`, `--uninstall`, a re-run keeping `previous`. `pnpm check` passes; `pnpm test` passes (2882 tests, 29 skipped), apart from that flaky `audio-pipewire` test.

**Real runs on this machine (x86-64, no sound card; the owner's service on 8787 untouched)**:
1. Assistant on port 8799 with its own data directory (`LLM_PROVIDER=fake`, local Parakeet v2 STT, Piper),
   `serve-dist.mjs` on 8798. `curl -fsSL http://127.0.0.1:8798/node/install.sh | sh -s -- --root <dir> --server
   http://127.0.0.1:8798 --no-pair …` downloaded the real Node 22.23.5 x64 tarball (hash matched the pin) and staged
   in 1.4 s; 140 MB under `/opt/pva-node` after dropping headers (205 MB before). The arm64 tarball was downloaded and
   its hash matched its pin too (not run: no arm64 here, no emulation).
2. The staged release run through the boot guard (a shell loop standing in for `Restart=always`, `--input-wav
   bench-audio --output-wav`): all five bench WAVs answered, `reply-001…005.wav` written. Latency lines (fake LLM;
   first data point, not a claim): `turn #1 … ttsFirstAudio=-190ms playbackStart=4ms`, `turn #2 … playbackStart=3ms`,
   `#3 3ms`, `#4 2ms`, `#5 2ms` (all speculative).
3. **Self-update**: build B (`--label b`) put in place, connection dropped → on reconnect `the server has …b
   (a8fe465ec191); downloading it` → `switched … restarting` (29 ms later) → exit 0 → `pva-node-boot: new release
   a8fe465ec191, start 1` → `release a8fe465ec191 confirmed` 16 ms after start → the next WAV answered on B.
4. **Rollback**: a release C that throws at load served with a correct manifest → switched, then `failed to load` on
   starts 1–3 (exit 1), on start 4 `did not reach the server's welcome in 3 starts; rolled back to a8fe465ec191`; B
   then logged `the server's bundle faf9c5c2ec58 … was rolled back on this node before; staying on a8fe465ec191` and
   answered five more WAVs (turns 8–12); `state.json` held `bad: [C]` and the `lastError`.
5. **systemd** (a throwaway privileged Debian 13 container with systemd as PID 1, files served inside it by busybox
   httpd because the host firewall drops container→host traffic, so no assistant there): `curl | sh` as root installed
   in 4.9 s including the runtime download; `pva-node` (uid 996, groups `pva-node audio`) created, modes and owners as
   above, unit enabled and active as `User=pva-node`; with `ProtectSystem=strict` the node **self-updated** (wrote
   `releases/`, exit 0, systemd restart counter 1, the guard counted start 1, release pending since no server
   welcomed it); survived a container restart (active after boot); a re-run without arguments downloaded nothing and
   kept `node.json`; `--uninstall` removed the unit, the three directories and the user. Container and image removed.

**Not verified**: a Raspberry Pi or any arm64 box (the arm64 runtime hash only); a Debian 13 *VM* (a container stood
in) and reboot of a real machine; the service against a real server through systemd (the container could not reach
the assistant; the real-server runs went through the shell supervisor instead); ALSA with a real sound card (the
container has none: the node idles without owning audio); the PipeWire `--user` variant against a real user session
(only staged); `--tls-pin` through install.sh end to end (curl's pin check and the node's were each verified
separately); real pairing (WP-7 does not exist; tested against a fixture). WP-4's acceptance asks for real installs on
a Raspberry Pi OS Lite arm64 box and a Debian 13 x86-64 VM with install time, disk, reboot and server restart under
Status: those remain open for WP-11 or a follow-up with the hardware.
