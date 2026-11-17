# Voice nodes: one-answer speaker-and-microphone boxes, added and managed under Devices

First design 2026-11-14. **Revised 2026-11-18** after main (288 commits: voice sessions, assistants and devices, voice
providers, looks and voices; protocol 8) was merged into this branch. The first half (WP-1 to WP-5) is built; its
Status entries are kept at the end, with notes on what the new main made wrong. The second half of the first design
(protocol 7, "Device defaults", a one-shot activation mode, WP-6 to WP-12) is replaced by §3 to §8 and the new build
plan in §14 (packages **N1 to N9**).

A **voice node** is a headless program (`apps/node`, built) on a Raspberry Pi, a VM or any Linux box with a microphone
and a speaker. It connects to the assistant server as one more **device** of a new device type, **Voice nodes**
(`voice-node`). It streams the microphone and plays the replies; the server keeps every engine. The owner says a wake
phrase, gets one answer, and the node is asleep again. It is added from admin › Devices with a one-time pairing code,
and is given assistants, wake phrases and everything else like any other device.

Whoever builds a package updates the Status section, and records there anything that had to differ from this design,
with the reason.

Read with: docs/ASSISTANTS.md (assistants, device types, the route gate), docs/VOICE-SESSIONS.md (one session per
device), docs/LOOKS-AND-VOICES.md (per-device look and voice), docs/ARCHITECTURE.md (the contract).

## 0. What changed since the first design

| First design (2026-11-14) | Now | Why |
|---|---|---|
| Kind `voice-node` in the protocol-5 front-end registry, profile fields per kind | A **device type** in `DEVICE_TYPES` (`packages/protocol/src/devices.ts`), with a defaults entry ("Every voice node") and sections | Main merged front-end kinds and devices into device types (ASSISTANTS.md §2.3) |
| New activation mode `one-shot` in `WakeGate` | **Follow-up 0** in the route gate: the voice-node type makes an assignment without its own follow-up use 0 instead of the assistant's | The server no longer uses `WakeGate`; it uses `RouteGate`, whose per-assistant follow-up window is exactly the thing one-shot removes (§4) |
| `conversationIdleMinutes: 2` for nodes, `newConversationOnWake` | The assistant's own quiet spell (`newConversationAfter`), one conversation per assistant per device | Conversations are per assistant now |
| `ONE_SHOT_INSTRUCTIONS` in the prompt | Dropped | Prompts are per assistant; the owner can write it into an assistant |
| Answer window for confirmation questions | Dropped | `Assistant.confirmActions` is the literal `"off"`; there are no confirmation questions |
| "Front ends" renamed "Device defaults"; node pages beside it | Nothing renamed. The Devices section lists types already; nodes appear in it as a second type | Main's Devices section is that page |
| `micStreaming: continuous \| on-keyword` | No field; nodes stream continuously | WP-5 was a no-go (Status) |
| Protocol 7 | Protocol **9** (8 is looks and voices) | ASSISTANTS.md §5.1 reserved 9 for nodes |
| Per-device `agent` (reserved) | Not needed | The assistant list on the device is that choice |

## 1. Goals and non-goals

**Goals**

- A box with a USB speakerphone (or a Pi with a microphone HAT and a speaker) becomes a voice assistant in a room,
  on the server's engines, with no speech model on the box.
- One answer per wake phrase, with defined behaviour for barge-in, silence after the phrase, several assistants and
  "Answers without a phrase".
- Added, configured, identified, tested and removed only from admin › Devices. On the box: a server URL, a device id,
  a credential and an optional TLS pin. Nothing else.
- Admin shows online / offline, last seen, version and whether it is up to date, platform, audio backend and devices,
  and the last error of every node.
- Latency no worse than a browser device on the same network, measured with `TurnTrace` (§11).
- Local first: the node talks only to the owner's server.

**Non-goals (this design)**

- Speech recognition, synthesis or the language model on the node.
- Screens, LEDs, buttons, GPIO. Feedback is by sound (cues).
- Acoustic echo cancellation in our code (hardware AEC or PipeWire echo-cancel; the server's `EchoGate`).
- A local keyword spotter (WP-5: no-go; reopen only with M4 on a Pi, see Status).
- Wyoming / Home Assistant satellites; macOS / Windows nodes; `armv7l`.
- Anything from the module research beyond the capability declaration (§13).

## 2. Decisions

| Topic | Decision |
|---|---|
| What a node is | A thin client (`apps/node`, built): 16 kHz mono PCM up over the existing `/ws` protocol as microphone frames, reply frames down, playback reports back. To the server it is a voice connection (`hello.frontend: "voice"`) of device type `voice-node`, with its own voice session and conversations. |
| Device model | A second entry in `DEVICE_TYPES`. Its sections: `assistants`, `withoutPhrase`, `matching`, `voice`, `interruptMode`, and two new ones, `sound` (volume, cues) and `soundDevices` (input, output). No `look`, `voicePage`, `captions`, `audio` (those are the browser's). §3. |
| One answer per phrase | The voice-node type's `followUpUnset: 0`: an assignment on a node without its own "keep listening" value uses 0, not the assistant's. Everything else is the route gate as it is. A per-device value still wins, so a node can be given follow-up on purpose. §4. |
| WP-2's one-shot gate | Not used. Removed again (N7). |
| Wake phrases | The same default phrases as other devices: at the first pairing, an unsaved "Every voice node" is seeded with the browsers' assistants and phrases, without follow-up values, with "Answers without a phrase: nobody". §3.4. |
| Where the phrase is decided | On the server, by the route gate, on the hearer's recogniser. The node streams continuously. |
| Pairing | Admin issues a one-time code (8 Crockford base32 characters, 10 minutes). The installer redeems it with `POST /node/pair` and gets a device id and a 32-byte credential. The server stores its SHA-256 only. §6.1. |
| Authentication | A `hello` for a paired node's id, or with `kind: "voice-node"`, must carry `hello.node.credential` matching that record, else close **4403**. A node device exists only by pairing, never by `hello`. A browser cannot take a node's id. |
| Removal | Remove (`device.forget`) deletes the record and its credential hash and closes the node with 4403. |
| Settings on the node | Pushed in `device.setup` (`sound`, `soundDevices`), applied live. |
| Status from the node | `node.status` (backend, device lists, what is open, missing tools, last error); kept in memory and shown on the node page. |
| Commands | Identify, Test speaker, Test microphone (levels), Restart, Update now: `node.command.send` (admin) → `node.command` (node). |
| Capabilities | The node declares `hello.device.capabilities` `{ v: 1, speaker, microphone }`, no `display`; the server keeps the last one per device and admin shows it. Nothing else reads it yet (§13). |
| Distribution | The server serves `apps/node/dist` (built by `pnpm --filter @pva/node bundle`, which `pnpm serve` now runs) under `/node/`. The node updates itself from its server, so node and server never disagree on the protocol. §6.3. |
| Transport | `ws://` allowed, with a warning badge in admin; `wss://` with a public certificate, or a self-signed one pinned by SPKI SHA-256. |
| Protocol | Version **9**. §5. |

## 3. A voice node in the Devices model

### 3.1 What is extended, what is added

Extended (existing structures, all in `packages/protocol/src/devices.ts` unless said):

| Structure | Change |
|---|---|
| `DeviceSettingsKey` (closed set) | `+ "sound"`, `+ "soundDevices"`; `DEVICE_SETTINGS_KEYS` follows. The reason for the bump (as `look` / `voice` took 8). |
| `DeviceSettings`, `DeviceOwn`, `DeviceSettingsPatch` | `sound: NodeSound`, `soundDevices: NodeSoundDevices` (required in `DeviceSettings`, optional in the other two, `NullOr` in the patch). |
| `BUILT_IN_WEB_VOICE_SETTINGS` | Gains `sound: { volume: 80, cues: true }`, `soundDevices: { input: "", output: "" }` (not in the browser's `keys`, so ignored, like `voicePage` on a node). |
| `DeviceTypeDefinition` | `+ followUpUnset?: number` (seconds; absent = the assistant's own, today's rule). |
| `DEVICE_TYPES` | `[WEB_VOICE_DEVICE_TYPE, VOICE_NODE_DEVICE_TYPE]`. |
| `DeviceTypeInfo` | `+ followUpUnset?: Int` (optional, so admin can say "Off: one answer per phrase (voice nodes)" as the inherited value). |
| `effectiveFollowUpSeconds(assignment, assistant, type?)`, `followUpMsFor(…, type?)`, `routeConfigFrom(settings, assistants, type?)` | `assignment.followUpSeconds ?? type?.followUpUnset ?? assistant.followUpSeconds`. |
| `validateDeviceSettings(settings, known, { assistants, type? })` | Warning `answers_everything` when `type.kind === "voice-node"` and `withoutPhrase.mode !== "nobody"` (§4.3). |
| `DeviceSetup`, `deviceSetupFrom(…, { keys? })` | `+ sound?`, `+ soundDevices?`: present when the device's type has those keys. |
| `DeviceListInfo` | `+ node?: NodeInfo`, `+ capabilities?: DeviceCapabilities` (§5.3). |
| `DeviceHello` (`frontends.ts`) | `+ capabilities?: DeviceCapabilities`. |
| `Hello` (`client.ts`) | `+ node?: NodeHello`. |
| `Result` (`server.ts`) | `+ pairing?: NodePairing`. |
| `CloseCode` (`constants.ts`) | `+ unauthorized: 4403`. |
| Server `StoredDevice` (`apps/assistant/src/serve/SettingsStore.ts`) | `+ node?: StoredNode`, `+ capabilities?: DeviceCapabilities`. Server-only: the credential digest never enters `@pva/protocol` or a push. |

Added:

- `packages/protocol/src/nodes.ts`: `VOICE_NODE_KIND`, `NodeSound`, `NodeSoundDevices`, `NodeCredential`, `NodePlatform`,
  `NodeHello`, `AudioDeviceInfo`, `NodeStatus`, `NodeLevel`, `NodeCommandName`, `NodeCommand`, `NodeCommandSend`,
  `NodePairCreate`, `NodePairCancel`, `NodePaired`, `NodeMeter`, `NodePairing`, `NodeInfo`, `NodePairRequest`,
  `NodePairAnswer`, `NodeManifest` (moved from `apps/node/src/update.ts`, unchanged, so the server can read it).
- `packages/protocol/src/capabilities.ts`: `DeviceCapabilities` (the v1 subset of §13).
- `VOICE_NODE_DEVICE_TYPE` and `BUILT_IN_VOICE_NODE_SETTINGS` in `devices.ts`.
- Server: `serve/nodes.ts` (pairing, credentials, node info, commands), `serve/nodeDist.ts` (the files and the pair route).
- Web: `devices/AddNodeDialog.tsx`, `devices/NodeSections.tsx`.

The settings file stays **version 4**: `node` and `capabilities` on a device record are optional keys. A downgrade to a
server without them drops them on the next save (nodes must then be paired again); recorded as a risk.

### 3.2 The type

```ts
export const BUILT_IN_VOICE_NODE_SETTINGS: DeviceSettings = {
  assistants: [],                                   // seeded at the first pairing (§3.4)
  withoutPhrase: { mode: "nobody" },
  matching: "close",
  voicePage: { pick: false },                       // not in keys: ignored
  interruptMode: "confirm",
  audio: BUILT_IN_WEB_VOICE_SETTINGS.audio,         // not in keys: ignored
  captions: BUILT_IN_WEB_VOICE_SETTINGS.captions,   // not in keys: ignored
  look: FOLLOW_ASSISTANT,                           // not in keys: ignored (no display)
  voice: FOLLOW_ASSISTANT,
  sound: { volume: 80, cues: true },
  soundDevices: { input: "", output: "" }           // "" = the backend's default device
}

export const VOICE_NODE_DEVICE_TYPE: DeviceTypeDefinition = {
  kind: "voice-node",
  title: "Voice nodes",
  one: "voice node",
  many: "voice nodes",
  description: "A small box with a microphone and a speaker. It answers one question per wake phrase.",
  keys: ["assistants", "withoutPhrase", "matching", "voice", "interruptMode", "sound", "soundDevices"],
  builtIn: BUILT_IN_VOICE_NODE_SETTINGS,
  followUpUnset: 0
}

NodeSound        = { volume: Int 0..100, cues: Boolean }
NodeSoundDevices = { input: String ≤ 200, output: String ≤ 200 }   // ALSA "plughw:CARD=…,DEV=0" or a PipeWire node.name
```

Device ids from the box are card names, not indexes, so a type-level value ("every node uses `plughw:CARD=Speaker`")
is meaningful for identical speakerphones. A value the node does not find falls back to the default device and is
reported in `node.status.lastError`.

### 3.3 The per-device record and what admin sees

```ts
// apps/assistant/src/serve/SettingsStore.ts (server only)
StoredNode = {
  credentialSha256: string          // 64 hex
  pairedAt: number                  // epoch ms
  version?: string                  // last hello.node.version, written when it changes
  platform?: NodePlatform           // last hello.node.platform, written when it changes
}
StoredDevice += { node?: StoredNode, capabilities?: DeviceCapabilities }
```

| Admin shows | From |
|---|---|
| Online | `connections > 0` (exists) |
| Last seen | `lastSeen` (exists) |
| Version | `NodeInfo.version` (stored, so an offline node shows it too) |
| Up to date | `NodeInfo.upToDate` = `hello.node.bundleSha256 === manifest.bundle.sha256`; absent when the node runs from source or no bundle is built |
| Platform, model | `NodeInfo.platform` |
| Backend, device lists, opened devices, missing tools, last error | `NodeInfo.status` (memory, last `node.status`, kept after disconnect until restart) |
| Transport | `NodeInfo.transport`: `ws` / `wss` as the server sees it |
| What it can do | `DeviceListInfo.capabilities` |

The registry (`apps/assistant/src/serve/devices.ts`) changes in three places: `seen` never **creates** a `voice-node`
record (pairing does) and writes `node.version` / `platform` / `capabilities` with the `lastSeen` save when they
changed; `capped` never evicts a record that has `node`; `forget` of a node is followed by closing its connections with
4403 (the hub), not by registering it again.

### 3.4 Seeding "Every voice node"

At the first `node.pair.create` while the store has no `deviceTypes["voice-node"]` (never saved), the server saves
the voice-node type defaults as: the browsers' effective `assistants` with every `followUpSeconds` removed, the
browsers' `matching`, `withoutPhrase: { mode: "nobody" }`, everything else built-in. This is how "nodes get the same
default trigger phrases as other devices" holds in the assistants model, where phrases live on assignments. Done
once; afterwards the type is the owner's. If the browsers have no assistant, nothing is seeded and the Add dialog says
"Nobody answers on voice nodes yet" with a link to Every voice node.

## 4. One answer per phrase

### 4.1 The mapping

The route gate (`packages/core/src/RouteGate.ts`) already decides per utterance which assistant it is for: a phrase,
else an open armed window, else an open follow-up window, else "Answers without a phrase". With every assignment's
follow-up at 0 and "Answers without a phrase: nobody", a device is asleep except for a phrase and the armed window
after a phrase said alone. That *is* "one answer, then asleep". The route gate is not changed for the first release.

The voice-node type supplies the 0 (`followUpUnset`), so it holds for every assignment, also one added later from the
assistant wizard's "Where" step or an assistant's "Add to a device…", without the UI having to write it. The owner can
still give one assistant on one node a follow-up (the assignment's own value wins); the node then behaves like a
browser for that assistant.

`VoiceSession` passes its device's type to `routeConfigFrom` (`deviceTypeOf(kind)`), and `wakeChanged` uses the same
config, so the state shown (`asleep`) and the lapse cue follow.

### 4.2 Behaviour, case by case

| Situation | What happens on a node | Mechanism (exists unless marked) |
|---|---|---|
| "Hey Jev, what time is it?" | Answered; after the reply, asleep. | Phrase route; follow-up 0 opens no window. |
| "Hey Jev" … pause … "what time is it?" | Wake cue, then the next utterance starting within 8 s is answered. | Armed window (`WAKE_ARMED_MS`); `wake { armed: true }` → node plays the cue. |
| "Hey Jev" and then nothing | After 8 s a lapse cue (falling tones). | `state: asleep` after `wake { armed: true }` with no `turn.start` between (node, built). |
| Speech without a phrase after the answer | Ignored; never stored, never in history. | Held utterance dropped at its `EndOfTurn`. |
| Speech without a phrase during a reply | Ignored; the reply goes on. | Follow-up 0: a reply in progress does not count as a window. |
| "Hey Jev, <words>" during a reply | The reply stops; the words are the next question. | Held utterance released at the match: its `SpeechStarted` reaches the dispatcher, which interrupts the turn (barge-in). |
| "Hey Jev" alone during a reply | **First release**: the reply goes on and Jev is armed; the next utterance within 8 s stops it and is answered. **N6**: the reply stops at once. | N6 adds one rule to `VoiceSession`: a `woke` with `armed: true` while a reply of this device plays → `Interrupt` (as Stop). |
| Two assistants on the node ("Hey Jev…", "Hey Kim…") | Each phrase reaches its assistant; each has its own conversation on this node; both answer once per phrase. | Assignments; one conversation per assistant per device. |
| Which recogniser hears the room | The hearer's (the first assignment, or the without-phrase assistant). | `hearerOf`; one recogniser per device. |
| "Answers without a phrase" set to one assistant or TypeSafe | Allowed, with a "Save anyway" warning `answers_everything`: "This node hears the whole room all the time. With this setting, {name} answers the TV and every conversation." | Existing warnings flow (`saveAnyway`). |
| The model asks a question back | The owner answers with the phrase ("Hey Jev, the kitchen"), or gives that assistant a follow-up on this node. | — |
| Confirmation questions | None exist: `confirmActions` is the literal `"off"` (ASSISTANTS.md §2.2). Whoever designs them must give follow-up-0 devices an answer window. | Out of scope. |
| Conversation continuity | "Hey Jev, the weather?" … "Hey Jev, and tomorrow?" continues while the assistant's quiet spell (`newConversationAfter`) has not passed. | Per assistant; no node setting. |
| Interrupt mode | `confirm` by default: the echo gate drops the node's own words. `manual` replaces the mic by silence while audible (no voice barge-in). | `interruptMode` section. |

### 4.3 WP-2's gate

Main never touched `packages/core/src/WakeGate.ts`, so WP-2 is intact, but nothing in serve mode uses `WakeGate` any
more (`RouteGate` uses only its matcher `matchWakePhrase`; the offline bench uses `makeWakeGate` for its older
scenarios). Of WP-2, **nothing is used**: TAKEN is the route gate with follow-up 0; `answerWindow` has no caller
(no confirmations); `woke.duringReply` becomes N6's rule in `VoiceSession` (the session knows a reply plays; the gate
does not need to). **N7** reverts WP-2's commit `c2e6b3b` (the only change to `WakeGate.ts` since #3) and deletes
`packages/core/test/WakeGateOneShot.test.ts`. ASSISTANTS.md §4.1 kept `WakeGate` and the version 3 profile types partly "because the voice-node design builds its one-shot mode on them";
that reason is gone, and their removal is left to that design's clean-up.

### 4.4 The turn detector

A pause longer than the hearer's `finalSilenceMs` in the middle of a question cuts it in two, and the second half is
dropped (it needs the phrase). On a browser the follow-up window hides this; on a node it does not. Measured (M6), not
argued. If it is common, the fix is the node's assistant's hearing (`finalSilenceMs` per assistant exists), or a
short follow-up on that assignment.

## 5. Protocol 9

### 5.1 Version paragraph (`constants.ts`)

> 9: voice nodes (docs/VOICE-NODES.md §5). Device type `voice-node`; `DeviceSettingsKey` gains `sound` and
> `soundDevices` (a closed set; required in `DeviceSettings`), `DeviceTypeDefinition`/`DeviceTypeInfo.followUpUnset`;
> `hello.node` (required for a node), `hello.device.capabilities`; client `node.status`, `node.level` (node only),
> `node.command.send`, `node.pair.create`, `node.pair.cancel` (admin); server `node.command` (to the node),
> `node.paired`, `node.meter` (admin only); `result.pairing`; `devices` entries carry `node` and `capabilities`;
> `device.setup` carries `sound` and `soundDevices` for a node; close code 4403 (`unauthorized`). HTTP: `/node/*`
> (not part of the WebSocket protocol, but its schemas are here).

### 5.2 Hello

```ts
Hello.node?: NodeHello                 // required when the device is a node (kind voice-node, or a paired id)
NodeHello = {
  credential: NodeCredential           // 43 base64url characters (32 bytes)
  version: String ≤ 64                 // "<package version>+<10-char git sha>[.dirty][.<label>]", or "dev"
  bundleSha256?: Hex64                 // the running release; absent when run from source
  platform: NodePlatform
}
NodePlatform = { os: "linux", arch: "arm64" | "x64" | "arm", hostname: String ≤ 64, model?: String ≤ 120 }
DeviceHello.capabilities?: DeviceCapabilities
```

A node's hello: `{ type: "hello", protocol: 9, clientId: "node-<uuid per process>", resumeOwner: true, frontend:
"voice", device: { id, kind: "voice-node", name: <hostname>, capabilities: { v: 1, speaker: { media: ["speech"] },
microphone: {} } }, node: { … } }`. The name in `hello` is ignored for a node (the record's name wins).

After `welcome` the node sends `audio.claim { audio: { contextSampleRate: 16000, outputPath: "direct" } }` and
`mic.state { live: true }`, then mic frames (as built). It gets `snapshot.setup` in `welcome` and `device.setup` on
every change, which carry `sound` and `soundDevices` (§5.4).

### 5.3 New messages and fields

| Direction | `type` | Schema | Rules |
|---|---|---|---|
| node → server | `node.status` | `{ backend: "pipewire" \| "alsa" \| "file", inputs: AudioDeviceInfo[] ≤ 64, outputs: AudioDeviceInfo[] ≤ 64, input?: { opened: String ≤ 200, sampleRate: Int }, output?: { opened: String ≤ 200 }, missingTools?: String[] ≤ 8, lastError?: { message: String ≤ 500, at: Number } }` | After `welcome`, on any change (hot-plug, a device that fails to open, a missing `arecord`), at most once a second. From a connection that is not a node: `bad_message` (once). |
| node → server | `node.level` | `{ rmsDbfs: Number, peakDbfs: Number }` | 5 a second, only while a `test-mic` runs; otherwise dropped. |
| server → node | `node.command` | `{ command: NodeCommandName, durationMs?: Int }` | `NodeCommandName = "identify" \| "test-speaker" \| "test-mic" \| "restart" \| "update"`. |
| admin → server | `node.command.send` | `{ requestId, id: DeviceId, command: NodeCommandName, durationMs?: Int 100..30000 }` | Admin only. `unknown_device` when the id is not a node or has no connection. `result { ok }` when sent. |
| admin → server | `node.pair.create` | `{ requestId, name?: DeviceName, replace?: DeviceId }` | Admin only. `replace`: pair again into an existing node record (keeps its settings; the old credential stops working when the code is redeemed). → `result { ok, pairing }`. |
| admin → server | `node.pair.cancel` | `{ requestId, code: String }` | Admin only. |
| server → admin | `node.paired` | `{ code, deviceId, name }` | `ADMIN_ONLY`. The code was redeemed. |
| server → admin | `node.meter` | `{ deviceId, rmsDbfs, peakDbfs }` | `ADMIN_ONLY`. Relayed `node.level` during a `test-mic`. |

```ts
AudioDeviceInfo = { id: String ≤ 200, name: String ≤ 120, isDefault: Boolean }
NodePairing = {
  code: String                     // 8 Crockford characters, no dash ("K7QM2XHP"); the page shows "K7QM-2XHP"
  expiresAt: Number                // epoch ms
  replace?: DeviceId
  tls: Boolean                     // the server itself serves https/wss
  tlsPin?: String                  // "sha256:<64 hex>" of SERVE_TLS_CERT's SPKI; present when tls
  loopbackOnly: Boolean            // SERVE_HOST is a loopback address: nodes cannot reach it
  bundle: { version: String, sha256: Hex64 } | null   // null: apps/node/dist is not built
}
NodeInfo = {
  pairedAt: Number
  version?: String, bundleSha256?: Hex64, upToDate?: Boolean
  platform?: NodePlatform
  status?: Omit<NodeStatus, "type">
  transport?: "ws" | "wss"
}
DeviceListInfo += { node?: NodeInfo, capabilities?: DeviceCapabilities }
DeviceTypeInfo += { followUpUnset?: Int }
DeviceSetup    += { sound?: NodeSound, soundDevices?: NodeSoundDevices }
Result         += { pairing?: NodePairing }
CloseCode.unauthorized = 4403   // a node hello without a valid credential; an unpaired id posing as a node;
                                // a browser hello naming a paired node's id; a node removed while connected
```

No new `ErrorCode` members. Every new message gets an example in `examples.ts` and a round-trip test.

### 5.4 Pushed settings and their effect on the node

| Setting | Section | Node does |
|---|---|---|
| Volume | `sound.volume` | Software gain `g = (volume / 100)²` on reply frames and cues (built: `volumeGain`). |
| Cues | `sound.cues` | Wake and lapse cues on / off (identify always plays). |
| Input device | `soundDevices.input` | Reopens the capture (`""` = default); a failure → default + `lastError`. |
| Output device | `soundDevices.output` | Used from the next reply or cue; a failure → default + `lastError`. |
| Voice, interrupt mode, assistants, phrases | as on any device | Server side; nothing on the node. |

### 5.5 HTTP: `/node/*`

| Route | Answer |
|---|---|
| `GET`/`HEAD /node/manifest.json` | The manifest, byte for byte, `Cache-Control: no-store`. |
| `GET /node/pva-node.mjs`, `/node/pva-node-boot.mjs` | The files, byte for byte, `Cache-Control: no-cache`, `ETag: "<sha256>"`. |
| `GET /node/install.sh` | The built installer, `text/plain; charset=utf-8`, `no-store`. |
| `POST /node/pair` | `NodePairRequest = { code: 8 Crockford upper case, hostname: String ≤ 64, platform: NodePlatform, version: String ≤ 64 }`, JSON, at most 4 KiB. `200 NodePairAnswer = { deviceId, credential, name }`; `403 { error: "bad_code" \| "expired" }`; `429 { error: "rate_limited", retryAfterMs }`; `503 { error: "admin_disabled" \| "unavailable" }`; `400 { error: "bad_request" }`; a request with an `Origin` header → `403 { error: "bad_origin" }` (browsers never pair). |
| anything else under `/node/`, or `dist/` not built | `404 { error: "not_built" }` for the four files, plain 404 otherwise. |

The host check (`SERVE_ALLOWED_HOSTS`) runs first, as for every request.

## 6. Server

### 6.1 Pairing and credentials (`serve/nodes.ts`)

- **Codes**: `node.pair.create` makes 40 random bits as 8 Crockford base32 characters, valid 10 minutes, single use,
  at most 3 outstanding (a fourth cancels the oldest), in memory only (a restart cancels them). It seeds the type
  (§3.4) before answering. `PVA_ADMIN_PASSWORD` unset → there is no admin, so no code can be made.
- **Redeem** (`POST /node/pair`): normalised code looked up; expired → `expired`; unknown → `bad_code`. Wrong codes back
  off **per remote address** like admin logins (5 in a row → 30 s, doubling, at most 10 min) and **in total** (50 wrong
  in 10 minutes → every redeem refused `rate_limited` until the oldest code expires). On success: 32 random bytes as
  base64url (the credential), a device id `vn-` + 16 base64url characters, a record
  `{ kind: "voice-node", name, firstSeen: now, lastSeen: now, own: {}, rev: 0, node: { credentialSha256, pairedAt:
  now, version, platform } }` (name: the admin's, else the hostname, made unique with " 2", " 3"), saved with
  `saveDeviceRecords`, then `node.paired` to admins and `devices` pushed. With `replace`: the existing record keeps
  everything but gets the new `credentialSha256` and `pairedAt`, and its open connections are closed with 4403. A save
  refused because the settings are `blocked()` → `503 unavailable`.
- **Credential check** (in `SessionHub.hello`, before `welcome`): if `message.device` names an id whose record has
  `node`, or `kind === "voice-node"`: `sha256(hello.node.credential)` compared with `crypto.timingSafeEqual` to that
  record's digest; no record, no `node`, a mismatch, or a missing `hello.node` → close 4403 without a `welcome`. On
  success `client.device = { id, kind: "voice-node", name: <record name> }` and the node's memory info is updated
  (`version`, `bundleSha256`, `platform`, `transport`, `upToDate`).
- **Remove**: `device.forget` on a node deletes the record (and so the digest), closes its connections with 4403 and
  pushes `devices`. No re-registration.
- `node.status`, `node.level` from a connection that is not an authenticated node: `bad_message`, once.
- **Commands**: `node.command.send` → `node.command` to that device's connections. `test-mic` opens a relay window
  for `durationMs + 1 s` in which `node.level` becomes `node.meter` to admin connections; outside it levels are dropped.
- `devices` is pushed on `node.status` changes through the existing 1 s throttle (`devicesChanged(true)`).
- `device.save` validation passes the target's type to `validateDeviceSettings` (the `answers_everything` warning).
- `VoiceSession` gets the device's type for `routeConfigFrom` (§4.1).

### 6.2 TLS and the server URL

- The **SPKI pin** is computed once at start from `SERVE_TLS_CERT`:
  `sha256(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }))` → `sha256:<hex>`. It is what the
  node checks (WP-4: `peerKeySha256`) and what curl's `--pinnedpubkey sha256//<base64>` checks. With TLS from a
  reverse proxy the server does not know the certificate: `tls: false`, and the dialog offers a pin field (§7.3).
- The **server URL** nodes use is chosen in the Add dialog, prefilled with admin's `location.origin`. No new server
  setting: the only case it would help (admin opened through an SSH tunnel on `localhost`) is covered by the dialog
  asking for the address. `loopbackOnly` makes the dialog say that nodes cannot reach a server listening on
  127.0.0.1 and how to change `SERVE_HOST`.

### 6.3 Serving the node (`serve/nodeDist.ts`, `http.ts`)

- `PVA_NODE_DIR` (environment only, like `PVA_WEB_DIR`), default `<repo>/apps/node/dist`, resolved in `ServeConfig`.
- `makeNodeDist(dir)` returns
  `{ manifest(): NodeManifest | undefined; handle(req, res, redeem): void }`. The manifest is read and validated
  (`NodeManifest` from `@pva/protocol`) at start and again when its `mtime` changes (one `stat` per request); each
  artifact's size and SHA-256 are checked at load; any mismatch → the four files answer 404 `not_built` and a warning
  is logged (a rebuild in progress heals at the next load).
- `http.ts` gets an option `node?: (req, res) => void`, called for paths under `/node/` after the host check, like
  `api`. `serveMode.ts` passes `(req, res) => dist.handle(req, res, nodes.redeem)` with
  `redeem: (body: NodePairRequest, remoteAddress: string) => Effect<{ status: number; json: unknown }>` from `nodes.ts`.
- `upToDate` and `pairing.bundle` come from `dist.manifest()`.
- **The bundle for the running service**: the root `serve` script becomes
  `pnpm --silent --filter @pva/web build && (pnpm --silent --filter @pva/node bundle || echo "voice node bundle not built: /node/* answers 404") && pnpm --silent --filter @pva/assistant start serve`.
  A bundle failure never stops the assistant. A service whose unit runs `pnpm start serve` directly must add the
  bundle step (README, §11 checklist). The bundle is reproducible (same commit, same hash), so a restart without a code
  change does not make nodes update; a dirty checkout gives a `.dirty` version, and nodes do update to it.
- WP-4's list "WP-7 must serve / implement" maps as follows: 1 (four files byte for byte, `no-store`, 404) → §5.5;
  2 (`POST /node/pair` with the normalised code and the three answers) → §5.5 plus `429` and `400`, which the node
  must now print (N3); 3 (`--server` in the command, `-k --pinnedpubkey`) → §7.3; 4 (the SPKI pin) → §6.2;
  5 (`upToDate`) → §3.3; 6 (build the bundle for `pnpm serve`) → above.

## 7. Admin

All in `apps/web`. The patterns are the existing Devices pages: `DevicesPage` lists each type with its defaults row
first, `DevicePage` / `DeviceEditor` shows the sections the type has (`has(key)`), with "Own value · Reset" per section.

### 7.1 Devices list (`components/settings/pages/DevicesPages.tsx`)

- The "Voice nodes" section appears by itself (it iterates `deviceTypes`). Changes: the empty-state text per type
  (nodes: "No voice nodes yet. Add one: you get a command to run on the box."), and an **Add voice node** button in the
  voice-node section header and in its empty state.
- A node row adds: *Offline since …* (from `lastSeen`) when not connected; a chip **Update pending** when
  `node.upToDate === false`; a chip **Unencrypted** (`ws`) when `node.transport === "ws"`; the last error in warn
  colour when `status.lastError` is newer than the connection.
- `LookVoiceLine` shows only the voice part for types without the `look` key.

### 7.2 The node page (`DeviceEditor` + `devices/NodeSections.tsx`)

For `device.kind === "voice-node"`, in this order:

1. **Status** (read only): online / offline since, version (and "Update pending"), platform and model, audio backend,
   opened input and output, missing tools (with "install `alsa-utils` on the box"), transport, last error, and "What it
   can do: speaks, listens; no screen" from `capabilities`.
2. **Actions**: Identify, Test speaker, Restart, Update now (only when `upToDate === false`). Each sends
   `node.command.send`; disabled while offline.
3. The existing sections the type has: **Assistants** (with the phrase tester, which already listens to this device's
   session: it is the microphone test for the first install), **Answers without a phrase**, **Matching**, **Voice**,
   **Interrupt mode**. In Assistants, an assignment without its own follow-up shows "Off: one answer per phrase (voice
   nodes)" as what it follows, from `deviceTypes[].followUpUnset`.
4. **Sound** (`sound`): volume slider 0–100 with a Test button (sends `test-speaker`, 1 s), Cues toggle.
5. **Sound devices** (`soundDevices`): two selects from `status.inputs` / `status.outputs`, plus "System default"; a
   stored id not in the list stays selected and reads "(not connected)". Disabled with "Connect the node to choose" when
   it has never sent a status.
6. **Remove voice node** (the existing `Forget`, other words): alertdialog "The node disconnects and must be paired
   again to come back."

Hidden for nodes because the type lacks the key: Look (and with it every character preview), On the voice page,
Captions, the browser's Audio group. The Assistant › Look tab's list of devices that fix a look leaves out types
without `look` (`assistants/LookTab.tsx`). Nodes have no voice page, so no visualiser anywhere.

"Every voice node" (the type defaults page) shows sections 3–5 without Status, Actions and Remove.

### 7.3 Add voice node (`devices/AddNodeDialog.tsx`)

There is no device-add wizard on main (devices appear by connecting; the assistant wizard's "Where" step places an
assistant on devices and will list nodes by itself). Nodes need a step-by-step dialog because they cannot connect
before they are paired:

1. **Name and address**: name (optional, placeholder "the box's host name"), "Server address the node uses"
   (prefilled `location.origin`; a warning when it is `localhost` / 127.0.0.1, and when `pairing.loopbackOnly`), and a
   note for `http:`: "The node's sound and its key travel unencrypted on your network." → **Get code**
   (`node.pair.create`).
2. **Code**: the code large (`K7QM-2XHP`), a countdown to `expiresAt`, the install command with a copy button, and
   "Waiting for the node…". The command:
   - `http`: `curl -fsSL <url>/node/install.sh | sudo sh -s -- --server <url> --code <CODE>`
   - `https` with `pairing.tlsPin`: `curl -fsSL -k --pinnedpubkey 'sha256//<base64 of the digest>' <url>/node/install.sh | sudo sh -s -- --server <url> --tls-pin sha256:<hex> --code <CODE>`
   - `https` without a pin (public certificate, or a proxy): no `-k`, no pin; a "Self-signed certificate behind a
     proxy? Paste its pin" field adds both.
   - `bundle === null`: no command; "The node program is not built on this server. Run `pnpm --filter @pva/node bundle`
     on the server (or restart it with `pnpm serve`), then try again."
   Cancel → `node.pair.cancel`. Expiry → "The code expired" with **New code**.
3. **Paired** (on `node.paired` for this code): "<name> is paired." **Open its page** (navigates to the device) and
   **Add another**. If nobody answers on voice nodes (seeding found no assistant), "Choose who answers" instead.

The node page's **Pair again** (in N8) opens the same dialog with `replace: <id>`.

### 7.4 Client state (`lib/client.ts`, `lib/store.ts`, `lib/state.ts`, `lib/devices.ts`)

Requests `nodePairCreate`, `nodePairCancel`, `nodeCommand`; reducer cases for `node.paired` (wakes the dialog) and
`node.meter` (N8); `DeviceListInfo.node` and `capabilities` read through. The mock server (`apps/web/mock/server.ts`,
new `mock/nodes.ts`) answers pairing, redeems the code itself after 2 s, and serves three nodes (online up to date,
online "Update pending" on `ws`, offline with a last error).

## 8. Node client (`apps/node`)

Built (WP-3, WP-4): CLI, config, connection with backoff, session, playback with reports, volume, cues, ALSA and
PipeWire backends, device listing, bundle, installer, units, boot guard, self-update and rollback, `pair`. Changes:

- **Protocol 9.** `VOICE_NODE_KIND`, `CloseCode.unauthorized`, `AudioDeviceInfo`, `NodeManifest` from `@pva/protocol`
  (the local copies go). `helloFor` adds `node: { credential, version: NODE_VERSION, bundleSha256?, platform }` and
  `device.capabilities`. A config without a credential cannot connect any more (§8, `configure`).
- **The failing test.** `"claims again after sessions_full (protocol 6 error)"` in `apps/node/test/node.test.ts` fails
  because `sessions_full` is now a decodable `error` code: the node handles it in `onMessage` (`case "error"` with
  `error.code === "sessions_full"` → `retryClaimLater`); `isSessionsFull` and `onUndecodable`'s use of it go. The test
  sends it as a decoded message.
- **Per-device sessions.** The node is its own device with its own session: the protocol-5 rule "do not fight a
  browser that took the audio" now only meets another connection *with the same device id* (a copied `node.json`).
  Keep not fighting it, and log "another connection of this node took the audio: is node.json on two boxes?".
- **Pairing against the real server.** `pair.ts` prints a sentence for the new `429 rate_limited` ("too many wrong
  codes: try again in N s") and `400`. `configure` and install.sh's `--no-pair` are removed (a protocol 9 server refuses
  an unpaired node). Development against a real server pairs first (`pva-node pair --server … --code …`).
- **TLS pin on the WebSocket.** With `tlsPin`, the socket opens with `rejectUnauthorized: false` and, on `open`, before
  `hello` is sent, the peer key's SHA-256 (`peerKeySha256`) is compared with the pin; a mismatch closes the socket,
  sets `lastError` ("the server's certificate does not match the pin") and retries with the normal backoff. The
  credential is never sent before the pin matched. Without a pin, normal certificate checks.
- **Pushed settings.** `snapshot.setup` / `device.setup` → `NodeSettings` (`sound.volume`, `sound.cues`) and the
  audio options (`soundDevices`): input reopened on change; output used from the next play.
- **`node.status`**: after `welcome`, on a device-list change (polled every 5 s with the built listers), on an open
  failure, on a missing tool, throttled to once a second.
- **`node.command`**: `identify` (`identifySound`), `test-speaker` (`testTone`, `durationMs` default 1000, ≤ 5000, at
  the current volume and output; never over a reply), `test-mic` (`node.level` 5 per second for `durationMs`, default
  10 000, ≤ 30 000), `restart` (exit 0; systemd restarts), `update` (`updates.check` now; exit 0 when switched).
- **4403**: the 10-minute retry (built). Log "this node was removed from the assistant or paired again elsewhere;
  pair it again".

Installation, runtime, files, users, units, self-update and rollback are as built and recorded in WP-4's Status
entry; that entry is the reference (paths, modes, the boot guard `ExecStart`, what counts as a failed start).

## 9. Where the trigger is detected

Always on the server, on a continuous stream. WP-5 measured the sherpa-onnx keyword spotter on x86: cheap (1.1 % of a
core) but it misses 21 % of synthetic wakes at its best setting and fires 352 ms after the phrase, which fails the
bar. Consequences that remain: every node streams 32 KB/s all the time, and the server decodes every utterance in the
room on the hearer's recogniser, whose decodes are serialised across sessions on one worker; a talkative room can
delay other devices' turn ends. That is M2, run before a third node is added.

## 10. Alternatives considered and rejected

- **A one-shot activation mode** (the first design, WP-2). The route gate with follow-up 0 behaves the same for the
  cases that exist; a second mode would need its own path through `VoiceSession`, the state tracker and the admin UI.
- **The add-node UI writing `followUpSeconds: 0` on each assignment.** Breaks for assignments made elsewhere (the
  assistant wizard, "Add to a device…"), and shows a stored 0 as the owner's own choice.
- **A node-only "one answer" switch section.** Duplicates the per-assignment follow-up that already exists.
- **Audio device ids outside the settings** (a node-only message). Loses own value · reset and type-level values.
- **A `NODE_SERVER_URL` setting.** The dialog's prefilled address covers it.
- **Speech on the node**, **a Chromium kiosk**, **a separate node protocol**, **Wyoming**, **node-side wake detection
  only**, **the vault for credentials**, **admin password on nodes**, **TV-style pairing**, **Python**, **git + pnpm on
  the box**, **a .deb**: as in the first design; nothing in the new main changes those reasons.

## 11. Measurements and the real-hardware checklist

No latency claim is made from reasoning. These are recorded under Status with the commands that produced them.

| Id | What | How | Decides |
|---|---|---|---|
| M1 | Node CPU and memory | Pi 4 / Pi 5 (and one x86 VM): `pidstat -u -r -p <node>,<arecord>,<aplay> 1` for 10 min idle and during 20 turns; median and p95 CPU %, max RSS | that a Pi 4 is enough |
| M2 | Server cost of always-streaming rooms | Two sessions on a test server: A replays 30 min of TV audio through a node (`--input-wav`), B the bench WAVs; `TurnTrace` of B (`endOfTurn → llmRequestSent`, `→ playbackStart`) with and without A; sherpa worker CPU | how many nodes one server takes; whether the spotter question comes back |
| M3 | Wake cue delay | End of "Hey Jev" (known in the WAV) to the node's first write of the cue; median / p95 over ≥ 20 | whether the cue feels late |
| M5 | Node against browser, end to end | Same server, same WAVs: a browser device (the e2e-real fake mic) and a node (`--input-wav`, real player on a box with a sound card); `TurnTrace` `endOfTurn → playbackStart` and `audible=`, median / worst over ≥ 12 turns | the "not worse than a browser" goal |
| M6 | Questions cut in two | ≥ 2 weeks of real use with "Save what the assistant hears" on for a node: share of accepted utterances followed within 3 s by a dropped one | §4.4 |

Dropped: M4 (the spotter; reopen with `packages/kws-sherpa/scripts/pi-m4.sh`) and M7 (the bench one-shot row: the route
gate has no new code path, so there is nothing new to measure).

**Checklist for the owner (real box and sound card).** Each line is a yes/no with what to note.

1. Server: `pnpm serve` (or the unit's own command plus `pnpm --filter @pva/node bundle`); `curl -k
   https://192.168.1.67:8787/node/manifest.json` returns JSON. `SERVE_HOST` is not loopback.
2. Box: Raspberry Pi OS Lite arm64 (or Debian 13 x64), `sudo apt install alsa-utils curl`. Note the model.
3. Admin › Devices › Voice nodes › Add voice node: code and command shown, the pin present for the self-signed
   certificate.
4. Run the command on the box: note the install time and `du -sh /opt/pva-node`. The dialog says "paired"; the node
   shows online with the right version, platform and model, backend ALSA, and both device lists.
5. Identify: three rising tones from the box's speaker. Test speaker: a 1 s tone; the volume slider changes it.
6. The phrase tester on the node page: speak "hey jeff, what time is it" across the room; the line shows the phrase.
7. Say "Hey Jeff, what time is it?" from 1 m and 3 m: one answer; then speak without the phrase: nothing happens.
8. "Hey Jeff" alone: wake cue; then the question within 8 s: answered. "Hey Jeff" alone and silence: lapse cue.
9. During a long answer: "Hey Jeff, stop" interrupts. Note whether the node's own voice ever triggers anything
   (no AEC hardware: say which device).
10. Choose another output device in Sound devices: the next answer plays there. Unplug the USB device: `lastError`
    appears; plug it back: it recovers (note how).
11. `sudo reboot` the box: online again within a minute, no admin action. Restart the server: the node reconnects.
12. Restart from admin; Update now after a server-side change (`git commit --allow-empty` and `pnpm serve`): the node
    updates and confirms (journal: `journalctl -u pva-node`).
13. Remove in admin: the node stops (journal says removed). Install again with a new code: it comes back as a new
    device.
14. M1 on the box, M5 with the bench WAVs, the latency lines from `journalctl -u pva-node` (the node prints each
    `turn.end` trace).

## 12. Risks

- **Echo without AEC.** The mic hears the reply; the server decodes it (M2). The echo gate and "phrase needed" keep it
  from acting, but a reply that says a wake phrase stops itself. Recommend AEC speakerphones.
- **Decode contention** with several streaming rooms (M2).
- **Questions cut in two** (§4.4, M6).
- **Session limit.** Every connected node holds a voice session for as long as it is connected (it claims at once).
  `MAX_VOICE_SESSIONS` (default 4, at most 8) counts nodes and browsers together, and the Claude subscription's
  session bound is `MAX_VOICE_SESSIONS` × its assistants. Open question 2.
- **Downgrade drops pairing** (optional record keys, §3.1).
- **Plain `ws://`** exposes the credential and room audio on the LAN (badge, open question 1).
- **A copied `node.json`** puts two boxes on one device: they share a session and the last claim wins. Admin cannot
  see it except as connections > 1; the node logs it.
- **Self-update** could brick a node with a bad bundle: hash check, previous release kept, rollback after three failed
  starts, the server only serves what it runs (built and tested, WP-4).
- **Clock-estimated playback counts** (built, WP-3): history may mark a clause as heard ~50 ms early.
- **ALSA device names** per box; mitigated by card names, the lists in admin and "System default".
- **The voice front end still has no login**: a node credential protects nodes, not the server.

## 13. Out of scope, from the module research

The module research (worktree `t3-aa37ec40`, `docs/research/module-investigation/`, in progress) bears on nodes in
these places. Taken now:

- **Capability declaration** (`presentation-and-device-capabilities.md` §5.2–5.3, option C1 for hardware): the node
  declares `hello.device.capabilities`, the server stores the last one per device and admin shows it. Only the subset
  a node needs is defined now, with the research's shapes, so later fields are additive:

  ```ts
  DeviceCapabilities = {
    v: 1
    speaker?: { media: ReadonlyArray<"speech" | "audio" | "video"> }   // node: ["speech"]
    microphone?: { farField?: boolean }                                 // node: {} (it cannot know)
    // absent display = no screen (the research's "absent = cannot" rule); `display`, `present`, `openUrl`,
    // `notify`, `characters` are added by the presentation work as optional fields
  }
  ```

Not taken, with pointers:

- Capabilities reaching the agent (a per-turn context line, a Presenter that refuses `show` on a node): §5.4 and §6
  there. Admin overrides that can only remove, and `place` (room, privacy): §5.3 there.
- Timers and notifications ringing on a node (`notification.ring`, a cue looping on the node, "stop" without a phrase
  while ringing, alerts synced to the node for offline ringing): `shared-state-jobs-and-notifications.md` §8.5–8.6.
  The node's generated cues and the route gate's follow-up window are the hooks; nothing here is built for it.
- Native tool requirements and probing (`module-definition-config-and-dependencies.md` §C.3–C.5): the installer
  already refuses to continue without `arecord`/`aplay` (or `pw-record`/`pw-cat`), and the node reports
  `missingTools` in `node.status`; a general requirement registry and `pva doctor` are that design's.
- One server plus thin clients (§C.7 there) is this design's topology already.

## 14. Build plan

Packages own disjoint files. **N1 first** (the shared contract); then N2b, N2, N3, N4 in parallel in separate
checkouts (N2 merges after N2b). Agents run only the narrow test files named, plus `pnpm check`, both behind the
machine's one lock (the lead names the lockfile in each brief: `flock <lockfile> …`, `VITEST_MAX_WORKERS=4`); the
lead runs `pnpm test` and the web e2e on the combined branch. CI runs `pnpm check` and `pnpm test` on every push.

**Between N1 and N2 the branch must not be deployed**: N1 registers the `voice-node` type before the server checks
credentials.

| Pkg | What | Label | Depends on | First install |
|---|---|---|---|---|
| N1 | Protocol 9 | well-defined | — | **required** |
| N2b | Serving `/node/*`, `pnpm serve` bundles | well-defined | N1 | **required** |
| N2 | Server: pairing, credentials, node info, commands, follow-up rule, seeding | open-ended | N1, N2b | **required** |
| N3 | Node client on protocol 9 | well-defined | N1 | **required** |
| N4 | Admin: Voice nodes in Devices, Add voice node, node page | open-ended | N1 | **required** |
| N5 | First real install, measurements, docs | open-ended | N1–N4 | **is** the first install |
| N6 | Phrase alone stops the reply | well-defined | N2 | later |
| N7 | Remove WP-2's one-shot mode | well-defined | — | later |
| N8 | Admin: Test microphone meter, Pair again | well-defined | N4, N2 | later |
| N9 | Session limit for nodes (after open question 2) | well-defined | N2 | later |

**N1 Protocol 9** — well-defined
- Scope: §3.1–3.2 and §5: `nodes.ts`, `capabilities.ts`, the `devices.ts` changes and helpers with the `type`
  argument, `VOICE_NODE_DEVICE_TYPE`, `Hello.node`, `DeviceHello.capabilities`, the client and server message unions,
  `Result.pairing`, `CloseCode.unauthorized`, `PROTOCOL_VERSION = 9` with its paragraph, examples. Mechanical edits
  only elsewhere so that `pnpm check` passes: every `DeviceSettings` literal gains `sound` / `soundDevices` (`grep -rln speakTyped apps`: today
  `apps/assistant/src/serve/migrateAssistants.ts`, `apps/web/mock/assistants.ts` and test fixtures); `ADMIN_ONLY` in `SessionHub.ts` gains `node.paired`, `node.meter` (the one
  line); exhaustive `switch`es over the new message types get a `// N2:` / `// N4:` placeholder that ignores them.
  `apps/node/src/update.ts` keeps its `Manifest` until N3 switches (the protocol copy is identical).
- Owns: `packages/protocol/**`; the mechanical lines above (each later owned by N2 / N3 / N4).
- Acceptance: `packages/protocol/test/nodes.test.ts` (new: every example round-trips; `followUpUnset` resolution; the
  `answers_everything` warning; `deviceSetupFrom` includes `sound` only for nodes; `NodeManifest` decodes a real
  `apps/node/dist/manifest.json` sample), `packages/protocol/test/assistants.test.ts`,
  `packages/protocol/test/assistantsEdges.test.ts`, `packages/protocol/test/looksAndVoices.test.ts`,
  `apps/assistant/test/devices.test.ts`; `pnpm check`.

**N2b Serving the node** — well-defined
- Scope: §6.3: `PVA_NODE_DIR`, `makeNodeDist` (manifest load and reload, artifact checks, the four routes, `POST
  /node/pair` parsing and limits with an injected `redeem`), `http.ts`'s `node` option, the root `serve` script.
- Owns: `apps/assistant/src/serve/nodeDist.ts` (new), `apps/assistant/src/serve/http.ts`,
  `apps/assistant/test/nodeDist.test.ts` (new), `apps/assistant/test/http.test.ts`, root `package.json` (`serve` line).
- Acceptance: `nodeDist.test.ts` with a fixture `dist/` (files byte for byte and headers; 404 when missing; mismatch →
  404 and a log; reload after a rewrite; host check; pair body limits, `Origin` refused, `redeem` called with the
  remote address); `http.test.ts`; `pnpm check`.

**N2 Server: pairing and nodes** — open-ended
- Scope: §3.3–3.4, §4.1, §6.1–6.2: `nodes.ts` (codes, back-off per address and in total, redeem and replace,
  credential check, memory node info, command and meter relay, SPKI pin), hello verification and 4403, `node.*`
  message handling, `device.forget` revoking, registry changes, `StoredNode`, seeding, `followUpUnset` into
  `VoiceSession`, `answers_everything` in `device.save`, `serveMode.ts` wiring (dist, pin, redeem).
- Owns: `apps/assistant/src/serve/{nodes.ts (new), SessionHub.ts, devices.ts, SettingsStore.ts, assistants.ts,
  VoiceSession.ts, VoiceSessions.ts, serveMode.ts}`, `apps/assistant/test/{serveNodes.test.ts (new),
  nodePairing.test.ts (new)}` and the existing tests of those files that need changing.
- Acceptance (scripted clients, injected providers): `nodePairing.test.ts` (success, expired, wrong, reused, three
  outstanding, back-off per address and in total, `admin_disabled`, `replace` keeps settings and closes the old
  connection, seeding once and only when unsaved); `serveNodes.test.ts` (node hello without / wrong / revoked
  credential → 4403; unpaired id as node → 4403; a browser hello with a node's id → 4403; forget closes the node with
  4403 and does not re-register; `seen` never creates a node, `capped` never evicts one; `node.status` → `devices` to
  admin only, throttled; commands reach only that node; `test-mic` levels reach admin only and stop after the window;
  `device.setup` to the node carries `sound`; a node assignment without follow-up gets no window while a browser's
  does; phrase + request answered, a later sentence without phrase dropped); `apps/assistant/test/deviceRegistry.test.ts`,
  `sessionHub.test.ts`, `serveAssistantMessages.test.ts`; `pnpm check`.

**N3 Node client on protocol 9** — well-defined
- Scope: §8 entirely; the README of `apps/node`.
- Owns: `apps/node/**` except `apps/node/scripts/measure/**`.
- Acceptance: `apps/node/test/node.test.ts` (the `sessions_full` test fixed; hello carries `node` and
  `capabilities`; `device.setup` volume and cues applied; input reopened on `soundDevices` change; each command;
  `node.level` only during `test-mic`; `node.status` after welcome and on change, throttled; 4403 retry),
  `apps/node/test/pair.test.ts` (429, 400), `apps/node/test/update.test.ts` (manifest from `@pva/protocol`; a wss
  fixture: pin match sends hello, mismatch never sends it), `apps/node/test/install.test.ts` (no `--no-pair`);
  `shellcheck -s sh apps/node/install/install.sh`; `pnpm check`.

**N4 Admin: voice nodes** — open-ended
- Scope: §7.1–7.4 without the Test microphone meter and Pair again.
- Owns: `apps/web/**` (including `mock/`, `e2e/`, `test/`), `docs/nodes-evidence/**` (new).
- Acceptance: `apps/web/test/devices.test.ts` and a new `apps/web/test/nodes.test.ts` (reducer: `devices` with
  `node`, `node.paired`; install command for http, https with pin, https without; code formatting; sections by type
  keys); `apps/web/e2e/nodes.spec.ts` (new, on the mock: add a node → code → paired → its page; actions send
  `node.command.send`; sound devices from status; no Look / Captions / On the voice page on a node or on Every voice
  node; the `answers_everything` warning and Save anyway; remove with confirmation; no horizontal scroll at 320 px);
  `pnpm --filter @pva/web check`.
- Screenshots (light and dark; desktop and 320 px phone), into `docs/nodes-evidence/`: `devices-with-nodes` (the
  Voice nodes section with Every voice node, an online node, one with Update pending and Unencrypted, one offline with
  an error), `add-node-address` (and its loopback warning), `add-node-code` (pinned https command, countdown,
  waiting), `add-node-not-built`, `add-node-paired`, `node-page-status` (Status and Actions), `node-page-assistants`
  (follow-up "Off: one answer per phrase (voice nodes)"), `node-page-sound` (Sound and Sound devices with one "(not
  connected)"), `every-voice-node` (the defaults page without browser sections), `node-answers-everything` (the
  warning), `node-remove` (the alertdialog).

**N5 First real install, measurements, docs** — open-ended (lead with the owner)
- Scope: the §11 checklist on a real Pi and the owner's server, M1, M3, M5 at once, M2 before a third node, M6 started;
  README "Voice nodes" (install, audio, TLS, the `pnpm serve` bundle step, troubleshooting); docs/ARCHITECTURE.md (a
  node is a device of type `voice-node`; `/node/*`; follow-up 0); this document's Status.
- Owns: `README.md`, `docs/ARCHITECTURE.md`, `docs/VOICE-NODES.md`, `apps/node/scripts/measure/**` (new).
- Acceptance: the checklist answered and the numbers under Status with their commands; the lead's `pnpm test` and web
  e2e on the combined branch.

**N6 Phrase alone stops the reply** — well-defined, later
- Scope: §4.2: in `VoiceSession`, a route result with `woke.armed === true` while a reply of this session plays (or a
  committed turn is in flight) → the same stop as the Stop button, then the armed window as now. Applies to every
  device type (on a device with follow-up the barge-in already does it).
- Owns: `apps/assistant/src/serve/VoiceSession.ts`, `apps/assistant/test/servePhraseStops.test.ts` (new).
- Acceptance: that test (stops within the stop deadline, arms, the next utterance answered; a phrase alone while
  idle unchanged); `apps/assistant/test/serveNodes.test.ts`; `pnpm check`.

**N7 Remove WP-2's one-shot mode** — well-defined, later (any time)
- Scope: §4.3.
- Owns: `packages/core/src/WakeGate.ts`, `packages/core/test/WakeGateOneShot.test.ts` (deleted).
- Acceptance: `packages/core/test/WakeGate.test.ts`, `packages/core/test/RouteGate.test.ts`; `pnpm check`.

**N8 Admin: Test microphone and Pair again** — well-defined, later
- Scope: §7.2's Test microphone (a level meter from `node.meter`, 10 s, with "speak now") and §7.3's Pair again.
- Owns: `apps/web/src/components/settings/pages/devices/NodeTests.tsx` (new), its mount line in `NodeSections.tsx`,
  `apps/web/e2e/nodeTests.spec.ts` (new), the `node.meter` reducer case.
- Acceptance: `nodeTests.spec.ts` on the mock; screenshots `node-test-mic` (meter moving) and `node-pair-again`.

**N9 Session limit for nodes** — well-defined, later
- Scope: open question 2's answer: `MAX_VOICE_SESSIONS` upper bound (`sectionDefinitions.ts`) and the Add dialog's
  warning when a new node would reach the limit.
- Owns: `apps/assistant/src/serve/sectionDefinitions.ts`, one block in `AddNodeDialog.tsx` (after N4).
- Acceptance: `apps/assistant/test/sections.test.ts` (or the test that holds the bound); `pnpm check`.

```
N1 ─┬─ N2b ── N2 ──┬── N6, N9
    ├─ N3 ─────────┤
    └─ N4 ─────────┴── N5 (first real install)      N8 after N4 + N2       N7 any time
```

## 15. Open questions for the owner

Each has a recommended default; work proceeds on it until he says otherwise.

1. **Plain `ws://` for nodes on the home network?** Recommended: **allowed with the Unencrypted badge**. His server
   already serves https with a self-signed certificate, so his nodes will use `wss` with a pin by default.
2. **How many devices may talk at once?** Every node holds a session all the time; today the default is 4 and the
   maximum 8, nodes and browsers together. Recommended: **raise the maximum to 16, keep the default at 4, and have
   the Add dialog warn when a new node would reach it** (N9). He sets the number in Settings.
3. **"Hey Jev" alone during a reply: stop the reply at once?** Recommended: **yes, on every device** (N6), after the
   first install. Until then the next sentence stops it.
4. **Seed "Every voice node" from the browsers' assistants at the first pairing?** Recommended: **yes** (§3.4); the
   alternative is that a new node answers nobody until he assigns someone.

## Status

### Status after the merge of main (2026-11-18, design revision; nothing re-run)

Checked by reading the code at `cee5e5a`, not by running anything:

- **WP-2 is intact and unused.** Main never changed `WakeGate.ts`; serve mode routes with `RouteGate`. N7 removes it.
- **apps/node: one failing test**, `"claims again after sessions_full (protocol 6 error)"`: `sessions_full` is a
  decodable `error` code now, so the raw-text sniff (`isSessionsFull` in `onUndecodable`) never sees it. N3 fixes it.
- **Against main today a node connects as no device.** `SessionHub.hello` ignores a `device` whose kind is unknown,
  so the node gets a session keyed by its per-process `clientId` and the browser type's defaults. Good enough for
  `--input-wav` runs; not a deployment (no admin entry, no pairing).
- WP-3's protocol-5 seams named `device.profile`, `frontend.update`, `Activation`, `followUpSeconds` in a profile,
  `conversationIdleMinutes`, `micStreaming`: all gone or superseded (§0). The node's settings now come from
  `device.setup`.
- WP-4's `configure` / `--no-pair` ("servers without pairing") stop working once the server checks credentials; N3
  removes them.
- WP-4's "WP-7 must serve / implement" list maps to §6.3.

### N3 Node client on protocol 9 (2026-11-18, branch `t3/8c04f2a6`)

Built against the fake server in `apps/node/test/support` (real codecs and examples); not run against the N2 server.

- `hello.node`, `device.capabilities`, `VOICE_NODE_KIND`, `CloseCode.unauthorized`, `AudioDeviceInfo`, `NodeManifest`
  from `@pva/protocol`; the local stand-ins are gone. `NodeConfig.credential` is required (a config without it is
  not a config), so `--server` / `--device-id` runs, `configure` and install.sh's `--no-pair` / `--device-id` are
  gone; the installer pairs again over a `node.json` that has no `"credential"` (a pre-protocol-9 install).
- `sessions_full` is handled as a decoded `error` in `Session.onMessage`; `isSessionsFull` is gone.
- Pushed `sound` / `soundDevices` applied (`applySetup` in `node.ts`); the input is reopened by interrupting the capture
  fiber and starting it on the new `AudioInput` (`buildAudio` in `audio.ts` makes the services for a device choice);
  the output and cue output are read per play (`ReplyPlayer` takes getters). A chosen input that yields no frame, or
  an output whose player fails, falls back to `""` and is reported as `node.status.lastError`.
- `node.status` (`status.ts`): after `welcome`, device lists polled every 5 s, throttled to 1 s, deduplicated.
  `node.command`: identify, test-speaker, test-mic (`node.level` every 200 ms for the window), restart (exit 0),
  update. 4403: the 10-minute retry with the "pair it again" line.
- TLS pin on the WebSocket: `rejectUnauthorized: false` with a pin, the peer key checked at `open` before `hello`.
- Differences from §8: `restart` and `update` are `NodeExit` values (`Restarted`, `Updated`), so `main.ts` exits with
  their code as it does for a self-update. The pin mismatch sets `lastError` on the reporter, but nothing can send it
  until a connection has a `welcome`; it is cleared at the next `welcome`.
- Not verified: a real server, real ALSA / PipeWire hardware, arm64, `shellcheck` (not installed here; `sh -n` passes).

### WP-1 ALSA backend and audio device listing (2026-11-14, branch `t3/alsa-audio-device-listing`)

Built: `packages/audio-alsa` (`arecord` / `aplay` on audio-pipewire's capture and playback helpers) and
`packages/audio-pipewire/src/devices.ts` (`pw-dump` parser, `AudioDeviceInfo`). Plugged into the node by WP-4
(below). Not verified with a real sound card.

### WP-2 One-shot in the wake gate (2026-11-14, branch `t3/one-shot-wake-gate`)

Built: the `one-shot` activation in `packages/core/src/WakeGate.ts` (TAKEN, `answerWindow`, `woke.duringReply`,
`taken()`) and `packages/core/test/WakeGateOneShot.test.ts`. Superseded by §4 (follow-up 0 in the route gate);
removed by N7.

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

**WP-5 (keyword-spotter spike), 2026-11-14: no-go for `on-keyword` for now; `continuous` stays.**
Details, commands and every number are in `packages/kws-sherpa/FINDINGS.md`. **All numbers are x86 (Ryzen 9
7945HX), not a Pi.**

The §11 risks are cleared:
- `sherpa-onnx-node` 2.0.1 exports `KeywordSpotter`.
- `sherpa-onnx-linux-arm64@2.0.1` ships aarch64 binaries that need glibc ≥ 2.17. This was checked by inspecting
  the files, not by running them.
- Keywords must be model tokens. A TypeScript encoder (the English model's `bpe.model` is a SentencePiece *unigram*
  model) matches the reference `sentencepiece` on 52 / 52 phrases.
- Changing phrases means rebuilding the spotter, which takes about 340 ms.

Cost is small: RTF 0.011, 1.1 % of one core, about 77 MB RSS.

Accuracy fails §6, on 336 synthetic wakes (Kokoro, 28 voices):
- The best setting (gigaspeech model, boost 2, threshold 0.05) misses **21 %** of them, and **14 %** of clean "hey
  jeff" spoken alone.
- The fire comes **352 ms** (p50) / 552 ms (p95) after the phrase ends.
- There were 0 false fires in 0.66 h of real speech, and 2.1 % of near-miss sentences fired, mostly "Hey Jess".

The decision can be reopened only by M4 on a Pi 4 with ≥ 50 of the owner's own wakes and ≥ 3 h of TV audio
(`packages/kws-sherpa/scripts/pi-m4.sh`), which nobody has run yet.

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
