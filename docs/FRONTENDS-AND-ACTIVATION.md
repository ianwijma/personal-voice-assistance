# Front ends, admin and activation

> **Changed 2026-11-16 (docs/ASSISTANTS.md, protocol 7).** Assistants are things the admin creates, and devices say which
> assistants answer on them. What this document still describes as it is: the two front ends, the admin password and
> sessions, role-shaped data, device identity, wake-phrase matching and the utterance contract, the phrase tester. What
> was replaced:
>
> | Protocol 5 / 6 | Now |
> |---|---|
> | front-end kinds (`FRONTEND_KINDS`, the Front ends page) | device types (`DEVICE_TYPES`; Devices › Every browser) with their defaults |
> | device profile (`DeviceProfile`, overrides, `effectiveProfile`) | device settings in sections (`DeviceSettings`, `own`, `effectiveDeviceSettings`) |
> | `device.profile`, `device.update`, `frontend.update`, `device.admin.update`, `frontends`, `snapshot.device` | `device.setup`, `device.pick` (voice); `device.save`, `device.types`, `assistants` (admin) |
> | `activation` `always` / `wake-phrase`, one phrase list, one follow-up time | the device's `withoutPhrase` (`nobody`, one assistant, TypeSafe decides) and per assignment phrases and follow-up |
> | `WakeGate` in the session | `RouteGate` and the session dispatcher (`WakeGate` stays in core for the offline bench and the voice-node branch) |
> | `snapshot.conversation` | `snapshot.conversations`, one per assistant |
>
> The version 3 profile types stay in `@pva/protocol` only for the settings migration. Sections 2 to 5 below say what was
> built in protocol 5; each says what replaced it. The "Status" section is the build log of protocol 5.

> **Changed 2026-11-16 (docs/VOICE-PROVIDERS.md):** the assistant speaks every reply with one voice
> (`ASSISTANT_VOICE`); the voice router, `[voice:NAME]` markers, `VOICES` and `DEFAULT_VOICE` are gone, and a device
> profile's `voice` no longer changes the voice (it falls back to `""`, the assistant's voice). Where this document
> describes per-device voices or the router, that is the design as it was.

Design written 2026-11-14 (lead session). It changes three things:

1. The web UI splits into two front ends: a simple **voice** front end and a password-protected **admin** front end.
2. The server knows **front-end kinds** and **devices**. Admin sets defaults per kind and overrides per device.
3. **Activation**: a device either reacts to everything it hears (`always`, today's behaviour) or only after a
   **wake phrase** ("hey Jeff"). The assistant still listens all the time; it just does not react.

Status of each part is kept in the "Status" section at the end. Whoever builds a part updates it, and records there
anything that had to differ from this design, with the reason.

## 1. Decisions

| Topic | Decision |
|---|---|
| Two front ends | One Next project (`apps/web`), two statically exported routes: `/` (voice) and `/admin/` (admin). Each route has its own entry component and bundle. Shared code (connection, store, protocol client, field renderers, UI primitives) stays in `apps/web/src/lib` and `src/components/ui`. No new workspace package until a third front end needs one. |
| Admin password | `PVA_ADMIN_PASSWORD` in `.env` (bootstrap variable: read once at start, removed from `process.env` and redacted from the env view, exactly like `PVA_VAULT_PASSWORD`). At least 8 characters. **Unset = the admin front end is disabled** and says so ("Set `PVA_ADMIN_PASSWORD` in `.env` and restart"); nothing can be configured from a browser then. |
| What admin means | A connection is admin after `admin.login` with that password (or a valid session token, below). **Every** change to server settings, modules, the vault, jobs, models, `.env` moves, front-end defaults and devices needs an admin connection. The old rule "typing the vault password makes a page admin" and "no vault = everyone is admin" both go away. |
| Vault | Unchanged as the encrypted key store. It still needs its own password to unlock (`PVA_VAULT_PASSWORD` for unattended start, or typed in the admin UI by an admin). Admin login does not unlock it. |
| Admin session | Login returns a random session token (32 bytes, base64url). The admin page keeps it in `sessionStorage` and sends it in `hello`, so a reload or reconnect stays logged in. The server keeps tokens in memory only: they end at logout, after 12 h, after 30 min without an admin action, and at restart. Wrong passwords use the same back-off as vault unlock attempts. Comparison is constant-time (`crypto.timingSafeEqual` over SHA-256 digests). |
| What a non-admin connection receives | A voice connection gets what it needs to run a conversation and nothing else: state, role, history, engine state reduced to "ready / not ready" plus the enabled voices, its device setup (protocol 7; a device profile in protocol 5). No settings sections, modules, env list, models, jobs, vault info, traces. Admin data is sent only after login. |
| Configuration | All of it lives in the admin front end: the existing two-level settings screen moves there whole. Protocol 5 added the categories **Front ends** and **Devices**; protocol 7 replaced them with **Assistants**, **Devices** and **Shared settings** (docs/ASSISTANTS.md §7.1). |
| Voice front end settings | One small sheet: Assistant (who answers on this device, when the admin allows picking), Microphone, Speaker, and one collapsed "More" group at most (protocol 5 had Voice and Activation here; the voice is the assistant's and activation is the device's `withoutPhrase`). Everything else that used to be per-browser (`interruptMode`, audio processing, captions, output path, prebuffer) is a device setting, with defaults per device type and own sections per device, edited in admin. Microphone and speaker ids stay in the browser (hardware ids mean nothing elsewhere). |
| Activation | Server-side, on the recogniser's transcript: a pure gate in `packages/core` (`WakeGate` in protocol 5, `RouteGate` since protocol 7: phrases carry their assistant), placed after the `EchoGate` and before the conversations. No extra model, no extra latency, any phrase in any language, several phrases per device. |

## 2. Device types, devices, settings (protocol 5: kinds, devices, profiles; replaced by docs/ASSISTANTS.md §2.3)

A **device type** is a kind of client. Today there is one: `web-voice` ("Browsers"). The near future adds apps on machines
with a microphone and a speaker plugged in (the voice nodes, docs/VOICE-NODES.md on its branch). Types are a code registry
(`DEVICE_TYPES`, `packages/protocol/src/devices.ts`; protocol 5 had `FRONTEND_KINDS` in `serve/frontends.ts`): kind id,
title, which setting sections apply, and the built-in defaults. Adding a type is one entry.

A **device** is one installed front end: a browser on a phone, a satellite box. It has a stable `deviceId` (random, kept in
`localStorage` by the browser; distinct from the per-tab `clientId`), a kind, and a name (default: derived from the user
agent, e.g. "iPhone · Safari"; renameable in admin). The server records a device the first time it says hello
(`DeviceRegistry`, `serve/devices.ts`): `{ kind, name, firstSeen, lastSeen, own, rev }`. Admin can rename and forget devices.
At most 64 devices are kept (least recently seen dropped first; devices with own settings are dropped last).

A device's **settings** are the sections of `DeviceSettings`: `assistants` (the ordered assistants that answer here, each
with its wake phrases and an optional follow-up time), `withoutPhrase`, `matching`, `voicePage`, `interruptMode`, `audio`,
`captions`, `look`, `voice`, and since protocol 11 `place` (room, privacy, always on, accepts from others, quiet room, default
person) and `capabilities` (what the owner takes away from what the device declares in `hello.device.capabilities`;
docs/ARCHITECTURE.md, "People, rooms and device capabilities"). Effective settings = built-in defaults ← the type's defaults (admin: Devices › Every browser) ← the device's own
sections (admin: Devices › the device; each section "Own value · Reset"). They are stored in `data/settings.json` version 5
(`deviceTypes`, `devices`). Protocol 5's `DeviceProfile` (activation, one phrase list, follow-up, voice, interrupt mode,
audio, captions) was that, flat and per field; its stored form is read only by the version 3 migration.

The server sends each voice connection its device's setup (`device.setup`, also `snapshot.setup`: the assistants with their
phrases, who answers without a phrase, `canPick`, `canAuto`, interrupt mode, audio and captions) and again whenever it
changes, so a change in admin reaches a running device live. A voice connection never learns another device's setup, or a
prompt, model, key or Handles. A device may change only who answers without a phrase, and only when its settings allow it
(`device.pick`); everything else is admin only.

What the server does with a device's settings:

- `assistants`, `withoutPhrase`, `matching` → the `RouteGate` (§3). A device with no assistant runs no recogniser.
- the hearer (the assistant that answers without a phrase, else the first in the list) → which recogniser the device uses.
- `interruptMode` → the `EchoGate`.

The rest is applied by the browser.

## 3. Wake phrases (`packages/core/src/WakeGate.ts`; since protocol 7 `RouteGate.ts`)

> Since protocol 7 the session runs `RouteGate` (docs/ASSISTANTS.md §3.4), built from the gate below: the same matcher
> (`matchWakePhrase`) and utterance contract, with phrases that carry their assistant, armed and follow-up windows per
> assistant, three without-phrase modes, and a phrase that is matched and removed in every mode (`always` used to pass it
> on). The text below describes `WakeGate`, which stays in core for the offline bench and the voice-node branch, and the
> matching rules both share.

Pure and synchronous like `EchoGate`; time is passed in. It filters the `SttEvent` stream and must keep the
utterance contract of docs/ARCHITECTURE.md (every forwarded utterance begins with `SpeechStarted` and ends with
exactly one `EndOfTurn`; a dropped utterance forwards nothing at all).

```ts
makeWakeGate(config?: WakeConfig): WakeGate
WakeConfig = { activation, phrases, match, followUpMs, armedMs? }   // armedMs default 8000
WakeGate = {
  configure(config: WakeConfig): void          // live; resets held state, keeps an open window only if still valid
  replyEnded(now: number): void                // a spoken reply finished or was stopped: opens the follow-up window
  replyStarted(now: number): void              // while the assistant is replying the window stays open
  awake(now: number): boolean                  // reacting without a phrase right now (window open, or mode always)
  filter(event: SttEvent, now: number): WakeResult
}
WakeResult = { events: ReadonlyArray<SttEvent>; dropped?: { text: string }; woke?: { phrase: string; armed: boolean } }
matchWakePhrase(text, phrases, match): { phrase: string; rest: string } | undefined     // exported, tested on its own
```

Behaviour in `wake-phrase` mode:

- **Asleep** (no window open). `SpeechStarted` is held, not forwarded: ordinary talk in the room must not barge in
  on a reply or start anything. `Interim`, `EagerEndOfTurn` and `EndOfTurn` texts are matched against the phrases.
  - No match on `EndOfTurn`: the whole utterance is dropped (`dropped: { text }`, for the admin tester only).
    No match on `EagerEndOfTurn` / `Interim`: held back, nothing forwarded yet; a later `TurnResumed` is swallowed too.
  - Match: the held `SpeechStarted` is released first, then the event with the phrase **removed** from its text
    ("Hey Jeff, what time is it?" → "what time is it?"), and `woke` is reported. The utterance is now *accepted*:
    every later event of it is forwarded with the same prefix removed (transcripts of whole-turn models are
    cumulative, so the phrase is stripped again each time; if a later transcript of the same utterance no longer
    matches, it is forwarded unchanged rather than dropped, since `Conversation` already saw its `SpeechStarted`).
  - The phrase alone ("Hey Jeff", then a pause): nothing is left to forward. On its `EndOfTurn` the gate forwards
    nothing (the held `SpeechStarted` is discarded) and opens the **armed window** (`armedMs`): the next utterance
    that starts inside it is accepted without a phrase. `woke: { armed: true }` lets the UI show "Listening…" and
    play a short cue. An `EagerEndOfTurn` that is only the phrase stays held (the user may continue the sentence).
- **Awake** (armed window, or follow-up window after a reply, or a reply is in progress): everything passes
  unchanged, except that a leading wake phrase is still removed. An utterance that *starts* while awake is accepted
  to its end even if the window closes meanwhile. Each accepted utterance and each reply keeps the device awake;
  the follow-up window (`followUpMs`) starts when the reply ends (`replyEnded`). `followUpMs = 0`: asleep again
  right after the reply, but barge-in still needs the phrase.
- While the assistant is replying and the device is in wake mode, interrupting by voice needs the phrase unless
  the follow-up setting is above zero (then the device counts as awake during the reply, so the echo gate's
  interrupt mode decides as today).
- Mode `always`: every event passes unchanged (not even phrase removal), so today's behaviour is bit-for-bit kept.

Matching (`matchWakePhrase`): both sides are normalised (lower case, Unicode letters and digits only, diacritics
removed, whitespace collapsed) and compared word by word. The phrase must be at the **start** of the utterance,
after at most two filler words from a small closed list ("ok", "okay", "uh", "um", "so", "and", "well"). `exact`:
words equal. `close`: a word of four or more letters may differ by one edit (Levenshtein 1), shorter words must be
equal ("hey jeff" accepts "hey jeffs", "hey geff"; it does not accept "hey go": that needs its own phrase, which
is why several phrases are supported). `close` also compares run together, for phrases of 6 or more letters
without spaces: the utterance's first k words after the fillers (k from 1 to the phrase's word count + 1) joined
without spaces may be one edit (Levenshtein 1) from the phrase joined without spaces, so "heyjeff" and "hay jeff"
(heard from streaming recognisers) match "hey jeff", while "hey go", "hey chef" and "hey jeffrey" do not; `rest`
is what follows those k words. The longest matching phrase wins. `rest` is the original text after the
matched words, with leading punctuation and spaces removed, original casing kept.

Not gated: typed text, `Say`, the Stop button. Dropped utterances never reach `Conversation`, the history, the
captions or any agent; their text goes only to admin connections that opened the tester (§5), and is never stored.

Relation to "hey Jev" intent routing (docs/AGENTS-AND-INTENTS.md): that is routing *inside* an accepted turn and is
not wired into the app yet. The wake gate removes the phrase it matched; when routing is wired, a trigger phrase
that should also route must not be consumed. Left as an open point there; nothing here depends on it.

Latency: the gate is a synchronous function on events that already exist; with whole-turn models the decision is
made on the eager transcript, the same moment a speculative turn starts today. Verify with `bench` (offline) that
the `TurnTrace` numbers in `always` mode are unchanged, and report the wake-mode numbers next to them.

## 4. Protocol (version 5; the current version is 7, docs/ASSISTANTS.md §5)

The builder of the protocol part writes the exact schemas in `packages/protocol` and lists them here under Status.
Required shape:

- `hello` gains `frontend: "voice" | "admin"`, `device?: { id, kind, name }` (voice), `adminToken?` (admin).
- `welcome`'s snapshot becomes role-shaped: the voice part (§1 table) for everyone; the admin part
  (sections, modules, env, models, jobs, vault, traces, `frontends`, `devices`) only on an admin connection, sent
  as its own message (`admin.snapshot`) after login, so logging in needs no reconnect.
- Admin: `admin.login { password }` → result with `{ token, expiresAt }`; `admin.logout`; server `admin.state`
  (`{ enabled, loggedIn, retryAfterMs? }`, where `enabled: false` means no `PVA_ADMIN_PASSWORD`). New error code
  `admin_required` for any admin-only request from a non-admin connection.
- Profiles (protocol 5; removed in protocol 7): server `device.profile { profile, editable: [...] }`; client
  `device.update { patch }`; admin `frontend.update { kind, patch }`, `device.admin.update { id, name?, patch? }`; server
  `frontends`. Their replacements: server `device.setup`; voice `device.pick`; admin `device.save { target, rev, settings }`
  (a `null` section removes a device's own value), `assistant.create` / `assistant.save` / `assistant.delete`; server
  `assistants`, `device.types`. Still there: admin `device.forget { id }` and server `devices` (now with `own`, `settings`,
  `hearer`, `rev`).
- Activation: `AssistantState` gains `asleep` (owner present, wake mode, no window open). Server `wake`
  `{ phrase, armed }` to all connections when a phrase is heard. Admin tester: `wake.test { on }` and server
  `wake.heard { text, matched?: phrase, at }` to connections that switched it on (5 min limit, then off).
- `audio.claim` / `audio.config` lose `interruptMode` (it comes from the device's settings).
- A voice connection no longer needs `vault.*`, `settings.*`, `module.*`, `job.*`, `model.*`: all admin only.

## 5. The two UIs

**Voice (`/`)**: the stage (visualiser, state label, captions), the control dock (start/stop, mute, stop reply, chat),
the chat panel, and a settings sheet. New state `asleep`: the state label reads *Say "Hey Jeff"* (first phrase of the
device's phrases), the visualiser is calm; on `wake` it shows "Listening…" and plays a short soft cue (WebAudio, two tones,
under 200 ms, generated, no asset; skipped when the phrase and the request came in one sentence and a reply follows).
Settings sheet (protocol 7): **Assistant** (who answers on this device; a radio list when the device allows picking),
**Microphone**, **Speaker**, link "Admin" (opens `/admin/`). Protocol 5 had **Voice** and **Activation** groups here; the
voice is the assistant's and activation is the device's `withoutPhrase` (docs/ASSISTANTS.md §7.2). Removed from this front end: the whole settings shell, latency readout, keys,
diagnostics, shortcuts for them.

**Admin (`/admin/`)**: login screen (password, error, back-off countdown, the disabled explanation), then the existing
two-level settings screen as the page itself (not a dialog over the voice stage), with a header showing the assistant
state, "Log out" and a link back to the voice front end. Categories, in order, in protocol 5: Overview, **Front ends**, **Devices**,
Language model, Speech recognition, Voices, Modules, Keys & vault, Diagnostics, About; in protocol 7: Overview, **Assistants**,
**Devices**, **Shared settings**, Keys & vault, Diagnostics, About (docs/ASSISTANTS.md §7.1). No audio is ever claimed by the
admin page.

- **Front ends › Voice assistant in a browser** (protocol 7: **Devices › Every browser**, the same page as a device's with "Own value · Reset" per section): the kind's default profile, as one page with groups *Activation*
  (mode, phrases as an editable list with add/remove, match strictness, follow-up), *Voice*, *Interrupting*,
  *Audio processing*, *Display*, *Advanced*. A **phrase tester** sits under the phrase list: "Listen" shows what the
  recogniser heard from the current audio owner, live, each line marked matched (with the phrase) or ignored, and an
  **Add as phrase** button on ignored lines: this is how a mishearing ("hey go") becomes an accepted phrase (not built in protocol 7: a heard phrase belongs to an assistant, which is picked on the device page).
- **Devices**: a list (name, kind, last seen, "this is the audio owner now", how it activates); a device page with
  rename, forget, and the same profile form where each field shows "Default (…)" or an override with "Reset".
- **Keys & vault** keeps the vault parts of the old Edit access page; the "admin access" part is replaced by the login.
- "This device" pages of the old settings screen are gone (their fields are in the profile).

## 6. Build order

1. **Foundations**: `WakeGate` + tests in core; protocol 5 schemas, examples and tests.
2. **Server** (`apps/assistant`): admin password and sessions, role-shaped snapshots, front-end and device store,
   wake gate and per-device voice wiring, `/admin` served, tester, tests with the scripted client.
   **Web** (`apps/web`), in parallel: the two routes, the voice sheet, the admin shell and new pages, mock server,
   unit tests, e2e and screenshot scripts for both front ends.
3. **Integration**: build, run the real server against both pages, `pnpm check`, `pnpm test`, e2e.
4. **UI review rounds** until both front ends score at least 8 overall.

## Status (the build log of protocol 5; names are as built then, protocol 7 replaced the ones in the table at the top)

### Step 1, foundations: built (2026-11-14)

`pnpm check` passes; `pnpm test`: 135 files passed, 9 skipped; 2604 tests passed, 26 skipped.

**`WakeGate`**: `packages/core/src/WakeGate.ts`, exported from `@pva/core`; tests in `packages/core/test/WakeGate.test.ts`
(26 tests, including a seeded property test of the utterance contract over 400 random runs with `configure`,
`replyStarted` and `replyEnded` calls mixed in). Exports: `makeWakeGate(config?)` (default: `WAKE_ALWAYS`),
`matchWakePhrase`, `wakeConfigFromProfile(profile)`, `WakeConfig`, `WakeGate`, `WakeResult`, `WAKE_FILLERS`,
`WAKE_MAX_FILLERS`. Its config shape and constants come from `@pva/protocol` (`Activation`, `WakeMatch`,
`WAKE_ARMED_MS`, `CLOSE_MATCH_MIN_LETTERS`, and the normaliser `wakeWords`, which the `WakePhrase` schema uses too,
so a phrase the schema accepts is a phrase the matcher can match). Not wired into serve mode (step 2).

**Protocol 5**: `PROTOCOL_VERSION = 5` with a changelog paragraph in `packages/protocol/src/constants.ts`. New
files `packages/protocol/src/frontends.ts` (profiles, kinds, devices, defaults, bounds, `wakeWords`,
`applyProfilePatch`, `effectiveProfile`, `patchFields`) and `packages/protocol/src/admin.ts` (token, session,
`AdminState`, session limits), both exported from the index. Examples for every message in `examples.ts`, plus
`exampleEngineStatus`, `exampleAdminSnapshot`, `exampleProfile`, `exampleFrontend`, `exampleDevice`,
`exampleLoginResult`, `exampleAdminHello`. Tests: `packages/protocol/test/frontends.test.ts` (and the round-trip
tests cover the new examples).

Shared types and constants (`frontends.ts`): `FrontendRole` (`voice | admin`), `FrontendKindId`, `WEB_VOICE_KIND`
(`"web-voice"`), `DeviceId` (8..64 URL-safe characters), `DeviceName` (1..60, not blank), `MAX_DEVICES` (64),
`Activation`, `WakeMatch`, `WakePhrase` (1..6 words, ≤ 60 characters), `WakePhrases` (1..12), `FollowUpSeconds`
(whole seconds 0..60), `PrebufferMs` (20..500), `ProfileVoice` (≤ 64), `DeviceProfile`, `ProfileField`,
`PROFILE_FIELDS`, `DEVICE_EDITABLE_FIELDS` (`voice`, `activation`, `followUpSeconds`), `DEFAULT_DEVICE_PROFILE`
(`always`, `["hey jeff", "hey jev", "hey geoff"]`, `close`, 8 s, voice `""`, `confirm`, captions and speak replies on,
all audio processing on, `direct`, 60 ms: the old browser defaults), `ProfileOverrides` (stored),
`ProfilePatch` (`null` removes), `DeviceHello`, `DeviceProfileInfo` (`{ deviceId?, profile, editable }`),
`FrontendKindInfo` (`{ id, title, description, fields, defaults, profile }`), `DeviceInfo` (`{ id, kind, name,
firstSeen, lastSeen, overrides, profile, connections, audioOwner }`), `WAKE_ARMED_MS` (8000), `WAKE_TEST_MAX_MS`
(300 000). Admin (`admin.ts`): `AdminToken` (43 base64url characters), `AdminSession` (`{ token, expiresAt }`),
`AdminState` (`{ enabled, loggedIn, retryAfterMs?, expiresAt?, endReason? }`), `MIN_ADMIN_PASSWORD_CHARS` (8),
`ADMIN_SESSION_MAX_MS` (12 h), `ADMIN_SESSION_IDLE_MS` (30 min). Snapshot (`snapshot.ts`): `Snapshot` is the voice
part `{ state, role, ownerPresent, engine: EngineSummary, history, device?: DeviceProfileInfo, admin: AdminState }`;
`AdminSnapshot` is `{ engine: EngineStatus, modules, sections, traces, vault, env?, models, jobs, frontends,
devices }`; `EngineSummary` `{ ready, voices: VoiceChoice[] }` with `VoiceChoice` `{ name, description, isDefault }`
and the helper `engineSummary(status)`.

New and changed messages (schema constant → `type`):

| Direction | Schema | `type` | What |
|---|---|---|---|
| client | `Hello` (changed) | `hello` | + `frontend` (required), `device?: DeviceHello`, `adminToken?` |
| client | `AudioClaim`, `AudioConfig` (changed) | `audio.claim`, `audio.config` | `interruptMode` removed |
| client | `AdminLogin` | `admin.login` | `{ requestId, password }` |
| client | `AdminLogout` | `admin.logout` | `{ requestId }` |
| client | `DeviceUpdate` | `device.update` | `{ requestId, patch: ProfilePatch }`, own device, editable fields only |
| client | `FrontendUpdate` | `frontend.update` | `{ requestId, kind, patch }`, admin |
| client | `DeviceAdminUpdate` | `device.admin.update` | `{ requestId, id, name?, patch? }`, admin |
| client | `DeviceForget` | `device.forget` | `{ requestId, id }`, admin |
| client | `WakeTest` | `wake.test` | `{ requestId, on }`, admin |
| server | `Welcome` (changed) | `welcome` | `snapshot` is the voice part only |
| server | `Result` (changed) | `result` | + `admin?: AdminSession` (successful `admin.login` only) |
| server | `EngineSummaryMessage` | `engine.summary` | `{ engine: EngineSummary }`, everyone |
| server | `AdminStateMessage` | `admin.state` | `{ admin: AdminState }`, the connection concerned |
| server | `AdminSnapshotMessage` | `admin.snapshot` | `{ snapshot: AdminSnapshot }`, admin only |
| server | `DeviceProfileMessage` | `device.profile` | `{ deviceId?, profile, editable }`, the device's connections |
| server | `Frontends` | `frontends` | `{ frontends: FrontendKindInfo[] }`, admin only |
| server | `Devices` | `devices` | `{ devices: DeviceInfo[] }`, admin only |
| server | `Wake` | `wake` | `{ phrase, armed }`, everyone |
| server | `WakeHeard` | `wake.heard` | `{ text, matched?, at }` (protocol 7 adds `source?: { deviceId?, assistantId? }`, where it was heard: docs/ASSISTANTS.md §5), admin connections with the tester on |
| common | `AssistantState` | — | + `asleep` |
| common | `ErrorCode` | — | + `admin_required`, + `unknown_device`; `locked` now means "the keys are locked" only |

Admin only by rule (doc comments say so; schemas unchanged): `module.*`, `settings.update`, `settings.moveFromEnv`,
`engine.reload`, `vault.*`, `job.*`, `model.delete` from the client; `module.changed`, `section.changed`, `engine`,
`vault`, `env`, `job`, `models` from the server.

Differences from the design, and choices it left open:

- **`engine.summary`** is a new message (the design reduces the voice snapshot's engine to "ready / not ready plus
  the enabled voices" but named no message for later changes). `engine` (full status) becomes admin only.
- **`unknown_device`** is a new error code for `frontend.update`, `device.admin.update` and `device.forget` naming a
  kind or device the server does not know.
- **`AdminState`** carries `expiresAt?` and `endReason?` besides `{ enabled, loggedIn, retryAfterMs? }`, and is also
  in the voice snapshot (`snapshot.admin`), so a page knows at `welcome` whether admin is enabled and whether its
  token was accepted. `admin.state` wraps it as `{ admin }`, like `vault` does.
- **`VaultInfo.admin`** is kept (removing it would rewrite the settings screen now); since protocol 5 it means
  "this connection is admin" and equals `AdminState.loggedIn`. The server sets it so.
- **`ModuleInfo.protected` / `SettingsSection.protected`** are kept as information (secret, provider choice, agent);
  every change is admin only now.
- **`turn.end.trace`** stays on every connection (it is that turn's own latency); only the trace list moved to
  `admin.snapshot`.
- **`device.profile`** carries `deviceId?` (absent for a voice `hello` without `device`, which gets the `web-voice`
  defaults with nothing editable). `device.update` from such a connection is `bad_message`; a patch naming a
  non-editable field is refused whole with `admin_required`.
- **Tester off after 5 min**: no message; the page counts `WAKE_TEST_MAX_MS` itself from its last `wake.test { on:
  true }` (the doc comment says so).
- **`followUpSeconds`** is whole seconds (`Int`, 0..60).
- **`WakeResult.heard`** (addition): every non-blank `EndOfTurn`, in every mode, with the phrase it matched: the data
  for `wake.heard` (`dropped` alone cannot show the matched lines).
- **Gate details** (recorded in `WakeGate.ts`'s header): in an accepted utterance an `Interim` / `EagerEndOfTurn`
  that is only the phrase is not forwarded (an `EagerEndOfTurn` is never empty by contract) and the `TurnResumed`
  answering a swallowed eager is swallowed too; its `EndOfTurn` is forwarded as `""` (the utterance must close) and
  arms the window like the phrase alone. `configure` while an utterance is held drops that utterance to its
  `EndOfTurn` in every mode (a switch to `always` must not forward a tail whose `SpeechStarted` was never sent).
  Windows are stored as start times and measured with the current config, which is what "keeps an open window only
  if still valid" means. An accepted, non-empty `EndOfTurn` also starts the follow-up window (so the device stays
  awake while the reply is prepared). The armed window admits one utterance. Apostrophes are removed inside words
  ("Jeff's" → "jeffs"); other non-letters separate words. "Longest phrase" = most words, then most characters.

`TODO(frontends)` spots (minimal mechanical edits made so check and test pass; each says what the next agent does):

- Server (`apps/assistant`): `src/serve/SessionHub.ts` — `HubOptions.interruptMode` (transitional; take the mode
  from the owner's profile), `ownerMode`, `snapshot()` (device, admin state), `adminSnapshot()` (sent to every
  connection after `welcome` today; real `frontends` / `devices`), `audio.claim` (refuse admin connections),
  `audio.config`; `src/serve/serveMode.ts` — `ServeOptions.interruptMode` (transitional), `engine` /
  `engine.summary` broadcast; `test/support/scriptedClient.ts` — `MergedWelcome`, `hello()` (send `device`, test
  admin hellos), `claim(mode)` ignores its mode; `test/support/serveHarness.ts` — `interruptMode: "instant"`;
  `test/serveVault.test.ts` — vault read from `admin.snapshot`.
- Web (`apps/web`): `src/lib/connection.ts` — `hello` (send `device` / `frontend: "admin"` + `adminToken`);
  `src/lib/client.ts` — five `audio.claim` / `audio.config` sends without the mode; `src/lib/state.ts` — `welcome`
  (voice part), `admin.snapshot` handler, no-op handlers for `engine.summary`, `admin.state`, `device.profile`,
  `frontends`, `devices`, `wake`, `wake.heard`, and `asleep` shown as idle in `visualState`; `src/lib/prefs.ts` —
  profile fields still kept per browser; `mock/server.ts` — welcome + `admin.snapshot` to everyone, no mock admin;
  tests `test/state.test.ts`, `test/vault.test.ts`, `test/downloads.test.ts`, `test/settingsTree.test.ts`,
  `test/review5.test.ts` (finding 2 now only checks that no mode is sent); e2e `e2e/options.spec.ts`,
  `e2e-real/bargein.ts`, `e2e-real/manual.real.ts` assert the removed `interruptMode` and will fail until moved to
  the profile (e2e is not part of `pnpm test`; not run).

Not done in step 1: no `TurnTrace` numbers (the gate is not wired; `bench` comparison belongs to step 2).

### Step 2, server (`apps/assistant`): built (2026-11-14)

`tsc -p tsconfig.json` and `tsc -p packages/protocol/tsconfig.json` pass; `pnpm vitest run apps/assistant packages`:
118 files (109 passed, 9 skipped), 2313 tests (2287 passed, 26 skipped). In two earlier full runs
`packages/audio-pipewire` "a consumer that falls behind…" failed once each: a timing test that fails only under
full-suite load and passes alone; nothing here touches that package. `pnpm --filter @pva/web check` passed at the time
of writing (the web agent was mid-work). No `packages/protocol` schema was changed.

**Where it is**

- `src/serve/AdminSessions.ts` (new): `PVA_ADMIN_PASSWORD` (unset or < 8 characters = disabled, one warning at
  start saying how to enable it), `login` (constant-time compare over SHA-256 digests), tokens of 32 random bytes
  (base64url), kept in memory by their SHA-256, 12 h maximum, 30 min idle (`touch` on each admin request), `logout`,
  `onEnd(token, "logout" | "expired" | "idle")` (a timer per session, so pages are told when a session ends by
  itself). Back-off: the vault's constants, now exported from `Vault.ts` (5 wrong in a row → 30 s, doubling, ≤ 1 h).
- `serveMode.ts`: reads `PVA_ADMIN_PASSWORD` once, deletes it from `process.env`, redacts it from the env view,
  exactly like `PVA_VAULT_PASSWORD`; `envSettings.ts` classifies it `bootstrap`; `.env.example` and the README
  configuration table / "Keys & access" describe it. `ServeOptions.adminPassword` (default `env.PVA_ADMIN_PASSWORD`),
  `adminIdleMs`, `adminMaxMs`, `adminNow` (tests). `ServeOptions.interruptMode` and `HubOptions.interruptMode` /
  `adminIdleMs` are gone.
- `src/serve/SessionHub.ts` (rewritten around the old one): admin = a valid session on the connection, from
  `admin.login` or `hello.adminToken` (admin front ends only). Every admin-only request (`allowed`) is answered
  `admin_required` otherwise; the vault requests too (unlock = admin connection + vault password; typing the vault
  password grants nothing; `vault.lock` no longer ends admin). `broadcast` filters by type: `ADMIN_ONLY` (exported:
  `module.changed`, `section.changed`, `engine`, `vault`, `env`, `job`, `models`, `admin.snapshot`, `frontends`,
  `devices`, `wake.heard`) goes to admin connections only, so every broadcast from `Publisher`, `serveMode`, jobs,
  models and the module host has its audience by construction. Admin connections never own the audio (`audio.claim`
  → `not_owner` error, `resumeOwner` ignored). `ownerProfile()`, `refreshProfiles()`, `wakeHeard()` are new.
- `src/serve/frontends.ts` (new): `FRONTEND_KINDS` (`web-voice`; a satellite is one more entry, the comment shows
  it), `makeFrontends`: effective profile (built-in ← kind ← device, `voice` checked against the enabled voices of
  the engine status, falling back to `""`), patch checks (fields of the kind → `invalid_settings` with
  `fieldErrors`; an unknown voice → `invalid_settings` on `voice`; the device's own patch outside
  `DEVICE_EDITABLE_FIELDS` → `admin_required`), `seen` (first hello records `{ kind, name, firstSeen, lastSeen,
  overrides }`), `left`, `updateOwn`, `updateKind`, `updateDevice`, `forget`, the 64-device cap.
- `SettingsStore.ts`: version 3 adds `frontends` and `devices` (`DeviceRecord` schema there); `saveFrontends(what,
  change)` uses the same `persist` (atomic writes, journal, revision rules).
- `StateTracker.ts`: `asleep` (between hearing and listening), `options.asleep`, and `wakeChanged(recheckInMs)`
  timers so the state returns to `asleep` when a window closes with nobody speaking.
- `HeardAudio.ts`: `discard()`. `http.ts`: `/admin` (below). `test/support/drive.ts`: admin password option.
- Wiring in `serveMode.ts`: Stt → `EchoGate` → `WakeGate` → `Conversation`. Only events that passed both gates
  move the state, become `transcript`, or reach the conversation; `heard.event(EndOfTurn)` (the recording's
  transcript) is called after the gates and replaced by `heard.discard()` when the wake gate dropped the utterance,
  so ignored talk is never written to `data/recordings/` either. The gate is configured in `onOwnerProfile` (no
  owner = `WAKE_ALWAYS`; reconfigured only when its part of the profile changed, since `configure` drops a held
  utterance), told `replyStarted` / `replyEnded` at playback start / end. `woke` → `wake` to everyone; `heard` →
  `hub.wakeHeard` (admin pages with the tester on). The echo gate's mode is the owner's `interruptMode` (set in the
  hub's `syncOwnerProfile`). `Engine`'s `defaultVoice()` hook returns the owner's `voice` when it is an enabled
  voice, else `DEFAULT_VOICE`. `engine.summary` is sent only when it changed, and a change re-checks every profile
  (a voice that was disabled falls back to `""` live).

**Messages per audience** (what the scripted-client tests assert): a voice connection receives only `welcome`,
`session`, `state`, `transcript`, `turn.*`, `assistant.*`, `tool.*`, `reply.*` (owner), `result`, `error`,
`engine.summary`, `admin.state`, `device.profile`, `wake`, `pong`. Its `welcome.snapshot` has exactly `state, role,
ownerPresent, engine (summary), history, device, admin`. Admin connections get `admin.snapshot` right after a
successful login (after `result` and `admin.state`) or right after `welcome` for a valid token, then the
`ADMIN_ONLY` messages, until the session ends (each connection of the session gets `admin.state` with `endReason`).

**Choices and differences from the design**

- `admin.login` from a voice connection (`hello.frontend: "voice"`) is refused `bad_message` ("log in on the admin
  page"), and `hello.adminToken` on a voice connection is ignored: admin data never reaches a page that may own the
  audio. A second login on one connection ends that connection's previous session.
- Logout ends the session for every connection that used its token (the protocol comment says so); another login is
  another session and is not affected.
- `device.update` from a device whose first record is still being saved creates the record with the change (no
  `unknown_device` race right after hello). A device of a kind the registry does not know is treated like no device.
- `lastSeen`: kept in memory on every hello and disconnect, written at the first hello and when the stored value is
  over 10 minutes old (and with any other save), so reconnects do not write `settings.json` every time. `DeviceInfo`
  shows `lastSeen` = now while connected.
- The 64-device cap never drops a connected device; among the rest, devices without overrides go first, oldest
  `lastSeen` first.
- Front-end saves are refused while the settings are blocked ("may come from two saves"): a device registering must
  not count as the owner's word that the files belong together (a save unblocks them). The device then simply stays
  unrecorded until the settings are saved once.
- A version-2 `settings.json` is read as version 3 in memory and written as version 3 at its next save; it is not
  rewritten at load and gets no backup (nothing is lost). An older assistant reading a version-3 file would set it
  aside as unreadable (downgrades are not supported).
- `devices` to admin pages: immediately on a real change, at most once per second for `lastSeen` / connections /
  audio-owner changes (`devicesThrottleMs`).
- The state `asleep` needs a live microphone (owner present, mic on, wake mode, gate asleep); a muted owner is
  `idle` as before.
- The tester switches itself off on the server too, `WAKE_TEST_MAX_MS` after the last `on: true`, and when the
  connection stops being admin.

**`/admin` URL layout** (as the web agent asked above): `out/index.html` at `/`; `out/admin/index.html` at `/admin/`
(and `/admin/index.html`); `/admin` and `/admin?…` get **308** to `/admin/` (query kept) when `admin/index.html`
exists and there is no `admin` file or `admin.html`. If an export without `trailingSlash` is served instead,
`out/admin.html` is served at `/admin` and `/admin/`. Every one of these responses has the same headers as `/` (COOP,
COEP, CORP, `nosniff`, `no-cache`). Tests: `test/http.test.ts` "the admin front end at /admin/".

**Bench** (`pnpm start bench`, offline, 3 rounds × 4 turns, ms from `EndOfTurn` to playback start, `TurnTrace`
marks). "Before" was run on this checkout before any server edit; "after" with the wake gate in front of
`Conversation` (the bench now runs every scenario through `makeWakeGate`, as serve mode does; `always` unless noted;
the wake scenarios prefix every utterance with "Hey Jeff, " and the gate removes it).

| Scenario | before: median / worst | after: median / worst |
|---|---|---|
| orchestration overhead, all delays 0 | 1.1 / 3.0 | 1.1 / 3.5 |
| realistic, eager OFF | 507 / 737 | 509 / 736 |
| realistic, eager ON | 306 / 536 | 307 / 535 |
| realistic, eager OFF, wake phrase | — | 508 / 736 |
| realistic, eager ON, wake phrase | — | 308 / 533 |

The differences are within run-to-run noise (the zero-delay worst case varies by a few ms between runs). Wake mode
costs nothing measurable: with whole-turn models the decision is made on the eager transcript, as designed.

**Tests** (new): `test/serveFrontends.test.ts` (19: login disabled / success / wrong / back-off with an injected
clock / token resume / refused token / logout everywhere / idle / expiry; `admin_required` for 17 request families
from a voice page and from a logged-out admin page; a voice page's raw messages after admin changes of every kind;
admin data stopping at logout; device registration, own editable fields, live push to two tabs of one device,
kind defaults and overrides live, rename, reset with `null`, forget while connected, unknown kind / device;
interrupt mode from the profile, also behaviourally (manual: no barge-in); per-device voice; wake mode: ignored talk
(no turn, no caption, no history, no LLM request, tester only), phrase + request, follow-up window, back to `asleep`,
phrase alone arms, the tester on / off, `always` unchanged, ignored talk not recorded), `test/frontends.test.ts`
(5: store version 3 and dropping bad entries, effective profile and voice fallback, `lastSeen` writes, the cap,
the device's own patch), `stateTracker.test.ts` (asleep), `envSettings.test.ts` (`PVA_ADMIN_PASSWORD` is bootstrap,
redacted, not movable), `http.test.ts` (3 for `/admin`). Existing serve tests moved to the split snapshot
(`client.admin(password)` returns `{ welcome, snapshot, token }`; `MergedWelcome` is gone; `claim()` takes no mode;
the harness writes `frontends: { "web-voice": { interruptMode: "instant" } }` into a fresh data directory, which is
what `claim("instant")` used to do; `TEST_ADMIN_PASSWORD`).

**Not verified / for the integration step**

- Never run against the real web pages: the integration step must check the voice page and the admin page against
  this server (login, reload with the token, logout, a device's sheet, the phrase tester, `asleep` / `wake` on the
  stage, `/admin` redirect in a real browser), and the e2e suites.
- Not run with the real recognisers in wake mode (only the scripted `Stt`); a real whole-turn model's eager
  transcripts and the `close` matching against real mishearings are untested here.
- The user's running service (port 8787) was not touched; it has no `PVA_ADMIN_PASSWORD` yet, so after this lands
  its admin page will say admin is disabled until the password is set in `.env` and the service restarted.
- `wake` is sent to every connection (as the protocol says), including admin pages.

### Step 2, web (`apps/web`): built (2026-11-14)

`pnpm --filter @pva/web check` passes; `pnpm --filter @pva/web test`: 29 files, 363 tests passed;
`E2E_MOCK_PORT=8797 pnpm --filter @pva/web e2e`: 71 passed (69 on the static export, 2 on `next dev`);
`pnpm --filter @pva/web screenshots`: 15 passed, 60 PNGs. No `packages/protocol` file was changed; nothing outside
`apps/web` was edited except this section.

**URL layout:** `next.config.ts` sets `trailingSlash: true`: `out/index.html` (voice, `/`) and `out/admin/index.html`
(admin, `/admin/`); assets under `/_next/...`. `/admin` redirects to `/admin/` (Next in dev; `scripts/serve-static.mjs`
answers 308 like the server above). Hash deep links (`/admin/#settings/<category>/<page>`) are client-side.

**Two routes, two bundles.** `src/app/page.tsx` renders only `components/voice/VoiceApp.tsx`;
`src/app/admin/page.tsx` renders only `components/admin/AdminApp.tsx`. The old registry is split:
`ui/voiceRegistry.ts` (stage overlays) and `ui/adminRegistry.ts` (settings pages), so the voice bundle never imports
the settings screen (checked: none of its strings are in the voice page's scripts). `node scripts/bundle-sizes.mjs`
after a build:

| Page | JavaScript it loads | Only this page |
|---|---|---|
| voice `/` | 870.5 kB (271.6 kB gzip), 8 scripts | 41.8 kB (12.9 kB gzip) |
| admin `/admin/` | 941.1 kB (289.3 kB gzip), 8 scripts | 112.4 kB (30.6 kB gzip) |

The shared ~829 kB are React, Next's runtime, Effect (connection) and the protocol schemas. (Next 16's build output
no longer prints per-route sizes; the script reads each exported page's `<script src>` tags.)

**Shared client** (`src/lib`): `createAssistantClient({ frontend })`. `connection.ts` takes an `identity()` read on
every connect: the voice page sends `frontend: "voice"` and `device` (`lib/device.ts`: a stable `pva.deviceId` in
`localStorage`, name from the user agent such as "iPhone · Safari", kind `web-voice`); the admin page sends
`frontend: "admin"` and `adminToken` from `sessionStorage` (`pva.adminToken`, written from the `admin.login` result,
removed on logout, on `admin.state { loggedIn: false }` and on a refused token in `welcome`). `state.ts`: `summary`
(`engine.summary`), `device` + `profileOverlay` (optimistic `device.update`, replaced by any `device.profile`;
`profileOf(s)` is the effective profile), `admin` / `adminSeq` / `adminReady`, `frontends`, `devices`, `woke`,
`heard`; `admin.state` with `loggedIn: false` empties the whole admin part; a reconnect with a valid token keeps it
until the new `admin.snapshot`. `visualState` has `asleep` (and shows `listening` while `woke`). `prefs.ts` keeps only
microphone, speaker, the start hint and the echo-test result; the moved fields in old storage are dropped. The
client applies profile changes live (`applyProfile`): processing → re-opens the microphone, then `audio.config`;
output path, prebuffer, interrupt mode (the microphone gate in manual mode); captions and speak replies are read
where used. `audio/cue.ts`: the wake cue (660 Hz then 990 Hz, 180 ms, raised-cosine edges, peak −20 dBFS), played
through the player under a local id (never reported), only on `wake` with `armed: true`, when this tab owns the
audio, the microphone is on, `speakReplies` is on, and no reply or echo test plays.

**Voice front end** (`components/voice/`, `TopBar`, `StateLabel`, `EngineBanner`): stage, dock, chat stay. Removed:
the settings screen, latency readout (top bar and per-message), keys, diagnostics, "Speak replies" switch in the
composer (a profile field now), the `O` shortcut. `VoiceSheet.tsx` (gear, or `S`): a side sheet from 640 px, a
bottom sheet below, focus-trapped, Esc closes and returns focus: **Voice** (radio list: "Assistant default" + the
enabled voices with descriptions; empty states for "not ready" and "none switched on"), **Activation** (Always
listening / Wake phrase; the phrases read-only as chips with "changed in admin"; "Keep listening after a reply" as a
select, shown in wake mode), **Microphone**, **Speaker**, one collapsed **More** (the echo test and a "Copy report" of
the audio numbers: both can only come from this device), and an **Admin** link. Asleep: label *Say "Hey Jeff"*
(first phrase, capitalised), the line in your colour at 42 % breathing slowly; after `wake` (armed) "Listening…". The
label is one fixed-height line (`aria-live="polite"`), so the change is announced without layout shift.
`EngineBanner`: "The assistant is not ready yet" + "See why in admin" (a voice page only knows `ready`).

**Admin front end** (`components/admin/`): `LoginScreen.tsx` (password, "That password is not right.", back-off
countdown from `retryAfterMs` restarted by every `admin.state`, the disabled explanation with `PVA_ADMIN_PASSWORD=…`
and "restart", why a session ended for each `endReason`, connecting / outdated states, a link back to the voice
page). `AdminShell.tsx` (the old `SettingsShell` as the page: no dialog, no close; hash ↔ path; list + page from
1024 px, drill-down below; focus moves to the level's heading; "Leave without saving?") with `AdminHeader.tsx`
(assistant state with the audio owner's device name, "Voice assistant" link, "Log out"; icon-only with labels on a
phone, 44 px targets). Categories: Overview, Front ends, Devices, Language model, Speech recognition, Voices, Modules,
Keys & vault, Diagnostics, About (`lib/settingsTree.ts`; client pages can be `perItem`: one page per front-end kind,
one unlisted page per device that goes back to the list). New pages: `pages/FrontendPage.tsx` + `ProfileForm.tsx`
(groups Activation / Voice / Interrupting / Audio processing / Display / Advanced; draft + sticky Save / Cancel;
"Changed · Reset" against the built-in value) + `PhraseList` (add with Enter, remove, the last one cannot go;
checks: empty, > 6 words, > 60 characters, duplicate after normalising, > 12) + `PhraseTester.tsx` (Listen / Stop,
"Listening to <device> · stops in m:ss", lines newest first marked "Matched <phrase>" or "Ignored" with "Add as
phrase", off on unmount and after 5 min); `pages/DevicesPages.tsx` (list: name, "Audio owner now", activation
summary, own-settings count, kind and last seen; empty state; device page: kind, status, first seen, rename, the same
form with "Default (…)" on inherited fields and "Override · Reset" (sent as `null`), Forget with an alertdialog).
"This device" pages are gone. Keys & vault › Vault keeps only the vault (`KeysPanel`: setup / unlock / unlocked; no
"get edit access"); a protected page is read-only only while the keys are locked, with an inline vault unlock
(`data-testid="keys-locked"`); padlocks mark protected pages only while the keys are locked. The admin page never
calls `startAudio` (it returns at once for `frontend: "admin"`) and never asks for the microphone (e2e-checked).

**Mock** (`mock/server.ts`): protocol 5 as the server above describes it: password `admin password`, tokens, role
filtering (`ADMIN_ONLY`), `admin_required`, `engine.summary` on change, devices from `hello.device`, kind defaults and
overrides with live `device.profile`, `frontends` / `devices`, `wake.test` / `wake.heard`, `asleep` with armed and
follow-up windows. Scenarios `wake`, `devices`, `admin-disabled`, `admin-backoff`; endpoints `/mock/admin/end`,
`/mock/wake`, `/mock/heard`, `/mock/state`, `/mock/defaults`. A reset is a restart (sessions end → `endReason:
"token"` on reconnect).

**Tests.** Unit: `test/frontends.test.ts` (device id and name, the protocol-5 reducer, asleep / woke, admin part
emptied, reconnect with a token, the profile form's patch / inherit / phrase checks / "Add as phrase", the tree's
Front ends and Devices, the cue), a hello-identity test in `connection.test.ts`, profile-driven microphone tests in
`review5` / `audioLifecycle`, prefs dropping moved fields. E2E: the old settings specs run under `/admin/` behind
`loginAdmin` / `gotoAdmin`; new `admin.spec.ts` (login, wrong password, back-off countdown, disabled, logout / idle /
expired / restarted token, reload keeps the login, no `getUserMedia` and no `audio.*` from admin, header),
`wake.spec.ts` (device id, the sheet → `device.update`, asleep → "Listening…" without layout shift, cue never
reported), `frontends.spec.ts` (groups, phrase list validation, Save sends only changes, a running voice page goes
asleep live, Reset → `null`, the tester with Add as phrase, tester off on leaving, number validation and Cancel),
`devices.spec.ts` (empty state, list with owner, rename, override / Reset → `null`, forget with confirmation, an
override reaching the device live), `layout.spec.ts` (keyboard, 44 px sheet targets, no horizontal scroll at 320 px
on both front ends), `vault.spec.ts` (rewritten for the login), `dev-smoke` (admin route and the `/admin` redirect in
`next dev`).

**Screenshots:** `E2E_MOCK_PORT=8797 pnpm --filter @pva/web screenshots` (builds, then `e2e/screenshots.shots.ts`
writes `apps/web/screenshots/`). 60 files: `voice-desktop-01…16`, `voice-desktop-light-01…03`, `voice-phone-01…08`,
`voice-phone-light-01`, `admin-desktop-01…18` (+ `14b`), `admin-desktop-light-01…03`, `admin-phone-01…09`,
`admin-phone-light-01`. All old PNGs were deleted, including `real-*.png` (old layout); `e2e-real/screenshots.shots.ts`
now writes `real-voice-*` / `real-admin-*` (not run here).

**Differences from the design, and choices it left open**

- The sheet's shortcut is `S` ("Settings"); `O` is gone with the settings screen. The shortcut list says so.
- "More" holds the echo test and the audio report: both measure this device's microphone and speaker and cannot be
  shown anywhere else (no protocol message carries them). The echo-test result now says to set Interrupting in admin.
- The composer's "Speak replies" switch and the per-message latency in the chat are removed (a profile field; admin
  Diagnostics has latency).
- The kind page marks overrides of the built-in profile as "Changed · Reset" (reset sends `null`); a value set equal
  to the built-in one is still saved as an explicit default.
- Deep-link ids kept for compatibility: `#settings/keys/access` is the Vault page (titled "Vault"). Test ids of
  per-item pages: `page-frontends-frontend`, `page-devices-device`.
- "Add as phrase" adds the heard line's first words, as many as the longest phrase has ("Hey go, what's the time?" →
  "hey go"), to the draft (saved with Save), rather than the whole utterance.
- The mock backs off after 3 wrong passwords (the server: 5); the UI only reads `retryAfterMs`.
- `e2e-real` (not run): `bargein.ts` and `manual.real.ts` set the interrupt mode with `setFrontendDefaults` (an admin
  connection logging in with `PVA_ADMIN_PASSWORD="e2e admin password"`, which `startAssistant` now sets) and check
  it in `welcome.snapshot.device.profile`; `serverHistory` sends a protocol-5 hello.

**Protocol gaps found by the web agent** (built against what exists; none blocks this step)

- `EngineSummary` has only `ready`: the voice page cannot tell "starting" from "failed" (or "keys locked"), so its
  banner says "not ready yet … starting, or something needs fixing" and links to admin. A `state` field
  (`starting | ready | reloading | failed`) without details would let it say which.
- No message carries a device's own measurements to admin (echo-test result, playback underruns), so admin chooses
  a device's Interrupting without seeing whether its echo test passed. A later `device.report` could add it.

**Not verified / for the integration step**

- Never run against the real server: login (and the 5-try back-off), reload with the token, logout from two tabs,
  `endReason` for idle / expired, a refused token after a restart, `device.profile` live from admin, `asleep` / `wake`
  with a real recogniser, the phrase tester's lines, the cue on real speakers, `/admin` (308) in a browser, the
  e2e-real suites and `screenshots:real` (to regenerate `real-*.png`).
- The real server answers `invalid_settings` for a voice that is not enabled (the mock falls back to `""`): the
  sheet then reverts and shows the message as a toast; check that path.
- The real server refuses `audio.claim` from admin with `not_owner`; the admin page never sends one, but check that
  an admin tab and a voice tab in one browser do not disturb each other's `clientId` (both use the per-tab
  `pva.clientId` in `sessionStorage`).
- iOS Safari, Firefox and real phones (safe areas, the bottom sheet with the keyboard open) were not tried.

### Step 3, integration: done (2026-11-14)

The real server (`pnpm start serve`, `LLM_PROVIDER=fake`, local parakeet-v2 + Piper, `PVA_ADMIN_PASSWORD` set, its
own port, throwaway `PVA_DATA_DIR` / `PVA_VAULT_PATH`) ran against both built pages in headless Chromium, with a fake
microphone playing WAVs. The owner's service on 8787 was not touched. `models/` and `bench-audio/` were linked
read-only from the main checkout. The real-browser tests use ports 8789–8803 (never 8787).

**What was run (final results)**

- `pnpm check`: passes. `pnpm test`: 141 files passed, 6 skipped; 2666 tests passed, 10 skipped (more run than before:
  the linked models let the model tests run).
- `pnpm --filter @pva/web e2e:real`: **23 passed** (4.9 min). 11 existing tests (2 brought up to date) and 12 new.
- `E2E_MOCK_PORT=8797 pnpm --filter @pva/web e2e`: 71 passed. `… screenshots`: 15 passed (mock PNGs regenerated: the
  engine banner text changed). `screenshots:real`: 2 passed, `real-voice-*` and `real-admin-*` (desktop and phone) written.

**New real-browser specs** (`apps/web/e2e-real/`)

- `admin.real.ts`: `/admin?x=1` → 308 `/admin/?x=1` (COOP header kept), the browser lands on the login; wrong password;
  five in a row → `retryAfterMs` 30000, "Try again in 30 s" countdown, the right password refused by the server during
  the back-off (from another connection), accepted after it; reload stays logged in; a second tab of the same session
  (token copied) with the tester on, Log out in the first tab → both on the login, no error; after a server restart the
  login says "restarted", logging in again works; `admin_required` answers to a logged-out admin page and a voice
  page, never shown as an error.
- `profiles.real.ts`: the voice page's device in Devices (name "… · Chrome", connected, audio owner, always listening);
  admin and voice tab of one browser have different client ids and admin sends no `audio.*`; a kind default
  (captions off) and a device override (captions on, then wake phrase) reach the open voice page live, Reset sends
  `null`; the sheet's voice / activation / follow-up become the device's overrides in admin (live, "3 own settings"),
  and a typed reply then uses the chosen voice (`trace.voices = ["natural"]`); a voice that is not enabled (a stale
  list): `invalid_settings`, the sheet goes back to "Assistant default", toast `"expressive" is not an enabled voice`.
- `wake.real.ts` (real speech, `spoken()` sentences synthesised by `say`): asleep, an unrelated sentence gives no
  `transcript`, no caption, no "hearing", no turn; "Hey Jeff, what time is it?" → `wake { phrase: "hey jeff", armed:
  false }`, `turn.start.userText = "what time is it?"`; the admin tester shows the unrelated line "Ignored" and the
  request "Matched Hey Jeff"; follow-up (listening) then asleep; **Add as phrase** on the ignored line adds "i think",
  Save, and on the audio's next loop the same sentence wakes the assistant and is answered as "the tomatoes in the
  garden need more water." (Kokoro voice:) "Hey Jeff." alone → `wake { armed: true }`, "Listening…", the next sentence
  answered; an unrelated sentence inside the 8 s follow-up window answered without the phrase; after the window
  asleep with *Say "Hey Jeff"*. Plus the latency runs below.

**Fixed**

- `apps/web/src/components/settings/PhraseTester.tsx`: on unmount it sent `wake.test { on: false }` on a socket that
  was no longer admin (after a restart or logout), answered `admin_required`; now sent only while logged in.
- `packages/protocol/src/snapshot.ts`: `EngineSummary.state` (`starting | ready | reloading | failed`, new
  `EngineState`), additive within version 5 (changelog in `constants.ts`); server and mock get it via `engineSummary()`.
- `apps/web/src/components/EngineBanner.tsx`: says "starting" / "reloading its engines" / "could not start" (no spinner
  when failed), `data-state`; `lib/state.ts` `emptySummary.state = "starting"`.
- `apps/web/e2e-real/voice.real.ts`: the latency readout and "This device" tab are gone from the voice page: now the
  sheet's audio report ("1 replies played"), admin › Diagnostics › Latency, and echo cancellation switched off in
  admin › Front ends re-opening the voice page's microphone with it off (asked `false`, reported `false`).
- `apps/web/e2e-real/session.real.ts`: the module test runs on admin pages (two logins) with a voice page typing;
  also checks the voice page never received module data.
- `apps/web/e2e-real/screenshots.shots.ts`: on a phone it now backs out of the drill-down before opening Front ends.
- `apps/web/e2e-real/fixtures.ts`: `spoken(text, { voice, speed })` (synthesised with `say`, resampled with
  `makeResampler`, cached in `.fixtures/say/`), WAVs of any rate, `loginAdmin`, `alerts`.
- Tests updated for `state`: `packages/protocol/test/frontends.test.ts`, `apps/assistant/test/serve.test.ts`,
  `apps/web/e2e/connection.spec.ts`, `apps/web/e2e/vault.spec.ts`.

No server bug was found: every server path above behaved as the server agent described.

**What the recognisers heard for "Hey Jeff"** (synthesised: Piper lessac, Kokoro af_heart, Piper at speed 1.25; 16 kHz)

| Model | "Hey Jeff, what time is it?" | "Hey Jeff." |
|---|---|---|
| parakeet-v2 (default), parakeet-ultra | "Hey Jeff, what time is it?" (all three voices) | "Hey Jeff." (all three) |
| whisper-turbo | "Hey Jeff, what time is it?" / "Hey Jeff what time is it?" | "Hey Jeff!" / "Hey Jeff" |
| nemotron-560 / -320 (streaming) | "Hey Jeff, what time is it", once "Hey, Jeff, …"; Piper speed 1: **"PGF, what time is it"** | Kokoro "Hey Jeff"; Piper: nothing recognised |
| zipformer-en (streaming) | **"HEEDIF …"**, **"HAYJAH …"**, "HEY JEFF WHAT TIME IS IT" | **"HAY JEFF"**, "HEY JEFF" |
| fast-conformer-en (streaming) | "hey jeff what time is it", **"heyjeff what time is it"** | "hey jeff" |

These are with 1 s of silence before the speech. Without it the streaming models drop the first word ("Jeff, what time
is it", "What time is it"). That happens only when audio starts at sample 0 (the `compare-models` input), not in the
browser. In the browser (parakeet-v2) the tester showed "Hey Jeff, what time is it?" verbatim. `close` matching
caught none of the mishearings in bold: "hay" has 3 letters (must be equal), "heyjeff" is one word, "PGF" / "HEEDIF" /
"HAYJAH" are further away. With the default model nothing needed catching. With a streaming model the phrase tester's
Add as phrase is the remedy (shown working above). A run-together form ("heyjeff") could be matched cheaply by
also comparing with spaces removed (open point for `matchWakePhrase`).

**Latency** (`TurnTrace` lines from the real run, `wake.real.ts`, ms from `EndOfTurn`; same Piper audio, the wake run
with "Hey Jeff, " in front, follow-up 0 so each turn passes the asleep gate; fake LLM with the clock tool)

```
always  turn #1 voice (speculative) completed llmRequestSent=-260ms llmFirstToken=-258ms firstClause=-195ms ttsFirstAudio=-126ms playbackStart=30ms audible=82ms (+52ms output latency)
always  turn #2 voice (speculative) completed llmRequestSent=-273ms llmFirstToken=-271ms firstClause=-209ms ttsFirstAudio=-143ms playbackStart=27ms audible=68ms (+41ms output latency)
always  turn #3 voice (speculative) completed llmRequestSent=-277ms llmFirstToken=-276ms firstClause=-215ms ttsFirstAudio=-154ms playbackStart=26ms audible=54ms (+28ms output latency)
wake    turn #1 voice (speculative) completed llmRequestSent=-246ms llmFirstToken=-244ms firstClause=-183ms ttsFirstAudio=-111ms playbackStart=29ms audible=78ms (+49ms output latency)
wake    turn #2 voice (speculative) completed llmRequestSent=-251ms llmFirstToken=-242ms firstClause=-182ms ttsFirstAudio=-124ms playbackStart=25ms audible=60ms (+35ms output latency)
wake    turn #3 voice (speculative) completed llmRequestSent=-258ms llmFirstToken=-258ms firstClause=-197ms ttsFirstAudio=-143ms playbackStart=23ms audible=52ms (+29ms output latency)
```

playbackStart: always 26–30 ms, wake 23–29 ms; audible: always 54–82 ms, wake 52–78 ms. Both modes start the turn
speculatively on the eager transcript, as designed. In wake mode the request starts about 15 ms later relative to
`EndOfTurn` (llmRequestSent −246…−258 vs −260…−277). That gap is too small to reach playback, where the numbers
overlap. An earlier run of the same specs gave the same picture (always 25–28 / 55–96, wake 24–30 / 65–87).

**Open points / not verified**

- The echo-test result still does not reach admin (no protocol message carries it; left as is, a later
  `device.report`).
- `endReason` `idle` / `expired` in a real browser: the server has no setting to shorten 30 min / 12 h outside tests
  (covered by the server tests with an injected clock, and the mock e2e).
- A voice switched off in admin while a device uses it, in a real browser (the e2e assistant takes `VOICES` from the
  environment, which locks the field). The server tests cover the live fallback.
- The wake cue on real speakers, iOS Safari, Firefox and real phones. Real human voices and room noise: only
  synthesised speech was used.
- `matchWakePhrase` did not match a run-together phrase ("heyjeff") or a 3-letter variant ("hay jeff"); fixed in review
  round 1 (below).
- The owner's service has no `PVA_ADMIN_PASSWORD` yet. After this lands its admin page says admin is switched off until
  the password is set in `.env` and the service restarted.

### Review round 1 fixes (2026-11-14)

`pnpm check` passes; `pnpm test`: 142 files passed, 6 skipped; 2727 tests passed, 10 skipped (one earlier full run had
the timing test `audio-pipewire` "a consumer that falls behind…" fail under load; it passes alone and in the rerun;
not touched here). `E2E_MOCK_PORT=8797 pnpm --filter @pva/web e2e`: 75 passed. `pnpm --filter @pva/web e2e:real`:
23 passed. `… screenshots`: 16 passed, 68 mock PNGs regenerated and looked at.

Two reviewers scored voice 7.6 / 7.5 and admin 7.5 / 7.3. Fixed, in `apps/web` unless named:

- **Contrast**: `globals.css` light theme now defines `ok`, `warn` (both were the dark values, ~1.8:1), and darker
  `voice`, `you`, `danger`, `ink-faint`; dark `ink-faint` is lighter. Every text token is ≥ 4.5:1 on `bg`, `surface`
  and `surface-2` in both themes, plus the tinted pairs used (voice on voice-soft, you on you-soft, danger on
  danger/10). `src/lib/contrast.ts` (oklch → sRGB → WCAG) and `test/contrast.test.ts` compute it from the CSS.
  The interrupted part of a reply and switched-off voices no longer use opacity on text.
- **Touch targets**: switches keep their 24 × 40 track with a 44 × 48 hit area (`::before`); segmented controls 44 px
  on phones; small buttons get a 44 px hit area on phones; the shared footer, sheet/dialog close, composer send,
  toast dismiss, "Try again", phrase tester buttons and Reset are 44 px on phones.
- **Voice**: "End session" is in the top bar at every width (44 px on a phone). The top bar shows only the dot plus
  exceptional states (connecting, "reconnecting · attempt N", not ready, audio on another device); outdated and audio
  errors leave it to the stage. The label says "Page out of date"; the server's "out of date" error toast is dropped
  when the page goes outdated (`local/connection`). Start text is true for local and hosted recognisers. Tool chips
  lose their timings; "Speaking" loses the voice name. The `?` dialog is now **Help**: a "Keyboard shortcuts" switch
  (`prefs.shortcuts`, `localStorage`, default on; off = only Esc) above the list, and the audio report (moved out of
  the sheet; the sheet's More has the echo test and a button into Help). The start hint drops the phrase once woken,
  says what to tap on touch devices (`pointer: coarse`) and omits `M` when shortcuts are off. "press Try again",
  "1 reply played", capitalised voice names, the echo test's "(admin: Interrupting)" in words. The chat sheet's
  composer has `max(12px, env(safe-area-inset-bottom))` and the sheet rides above the keyboard (`useKeyboardInset`,
  shared with the admin footer). The composer and all text inputs show the mint focus ring. Only asleep, woke, mic
  off, connection lost and errors are announced (a separate polite region); the visible label is not live.
- **Line position**: the line moved up when the content under it was taller than the stage (the error card): the
  visualiser box, a flex item, shrank (240 → 234 px here, 19 px in `voice-desktop-13`). It is `shrink-0` now; the stage
  also has `overflow-anchor: none`. e2e checks the label does not move between not-started and the audio error. The
  screenshot also ends the first tab's session first, so the denied page is not an observer.
- **Admin forms**: one footer component (`settings/FormFooter.tsx`) for server pages and device profiles (40 px Save,
  same note style); while save warnings show it offers only "Save anyway" and "Go back" (`dismissWarnings`). One
  `ChangedMarker` (amber "Changed"/"Override" + Reset) everywhere. The RELOAD chip became a small reload icon with
  hidden text; the per-field reload note is gone; the footer says it; the provider page's description no longer
  repeats it (`apps/assistant/src/serve/sectionDefinitions.ts` and the mock). Switches show On/Off text.
- **Front ends page**: in Always listening mode phrases / tester / matching / follow-up are folded into one closed
  group; the activation help describes the selected mode. The phrase tester says "Testing <device> with its saved
  settings", notes when that device has its own wake settings (link to its page) and when the page has unsaved
  changes; the countdown is not live; start, stop, expiry and each heard line with its result go through one polite
  region; the button reads `Add "hey go"`.
- **Claude subscription card**: steps marked check / spinner / number (next) / dash (waiting) in square markers; the
  opt-in and module switch are folded under "Do the steps one by one" until the one action is not enough (shown when
  it is in use, to switch it off); the module switch reads "Claude subscription module: on/off".
- **Wording / navigation**: "edit access" texts replaced (Move to settings, downloads, .env overrides); latency table
  "early start" column, no backticks, no overflow past the column; header line "Assistant listening on …" with a
  visible prefix, on its own line below 1024 px; the back label no longer truncates early and the root is "Admin";
  device rows wrap "3 own settings"; nav hover is a faint tint, the current row has an amber edge; nav dots have
  hidden text and a visible legend; "Keys are unlocked" has an open padlock; the back-off shows one message.
- **`packages/core/src/WakeGate.ts`**: `close` also matches run together (see §3); tests for "heyjeff …", "HAY JEFF
  …", "hay jeff", a split "he y jeff", and negatives "hey go", "hey chef", "hey jeffrey", "heyjefferson", and short
  phrases ("heygo" for "hey go" does not match: under 6 letters). Note: by the rule "they jeff" would match.

New screenshots: `voice-desktop-17-help`, `voice-phone-09-listening-end-session`, `voice-desktop-light-04-microphone-error`,
`admin-desktop-08b-tester-unsaved-changes`, `admin-desktop-light-04-tester-matched`, `-05-saved`, `-06-speech-warnings`,
`-07-login-backoff`.

### Review round 2 fixes (2026-11-14)

Round 2 scored voice 8.0 / 7.9 and admin 7.7 / 7.9; below 8 were voice feedback, accessibility and responsiveness, and
admin clarity, feedback, accessibility and consistency. Fixed, in `apps/web` unless named:

**Voice**

- **Sheet refusals in the sheet**: `client.updateDevice(patch, { toast: false })`; the sheet shows a refused voice,
  activation or follow-up change under its control (`sheet-error`, `role="alert"`, "Not changed: …", Dismiss), kept
  until dismissed or a later change of that field succeeds. A chosen voice says "Used from the next reply." (polite).
  Toasts are `fixed` at z 70, outside every inert part, so they are above every sheet and dialog on both front ends.
  The mock now refuses a voice that is not enabled (`invalid_settings`), as the server does.
- **One modal at a time**: while the sheet, Help, or the chat as a sheet (below 1024 px) is open, global shortcuts other
  than Esc do nothing (`useShortcuts`), the top bar and stage are `inert` (and the chat behind the sheet or Help);
  opening the sheet closes Help and the other way round (`local/ui`); focus returns to the opener even across that
  hand-over (`ui/Panel.tsx`). The state announcer moved out of the stage so it still speaks behind a modal.
- **Start hint**: shown once for 7 s; the remembered pref no longer restarts or cancels its timer. Muted: "Tap the
  microphone to unmute." / "Press M or the microphone to unmute." In wake mode it starts at "…then ask." (the label
  says the phrase). "Reconnecting · attempt N" is only under the line; the top bar keeps its pulsing dot (and drops
  "audio on another device", which the stage says).
- **Small phones**: the stage's top padding and the visualiser's height scale with the height (`stage-pad`,
  `stage-vis` in `globals.css`; unchanged at 390 × 844, 1280 × 800 and taller), a `short:` variant (max-height 600 px)
  tightens margins, captions and the observer and error cards; the privacy text is one line ("Only text goes to the
  language model") with the rest behind a disclosure; "or type instead" is hidden on short screens. `layout.spec.ts`
  asserts that the label, captions and everything under them end above the dock at 320 × 568, 360 × 640, 375 × 667 and
  667 × 375 in not started, listening (with the hint), muted, observer, speaking (captions) and microphone error.
- **Chat**: traps focus and has `aria-modal` only below 1024 px; from 1024 px Tab leaves it for mute and stop.
  Visually hidden `h1` "Voice assistant".
- **Observer**: "Listening on another device" in the neutral colour.

**Both**

- **Selection indicators**: the selected segment has a 2 px ink-muted inset edge and medium weight; the switch's
  checked track edge is full mint; the voice sheet's radios are drawn (ink-faint ring, thick mint ring when chosen, the
  chosen row tinted); choice rows have an ink-muted edge; checkboxes an ink-faint edge. `test/contrast.test.ts` checks
  every one of these against its neighbours at 3:1 in both themes (WCAG 1.4.11).
- **44 px on phones**: every 40 px button (`Button` md is 44 px below 640 px), phrase Remove, the confirmation dialogs'
  buttons, the admin header's two links (`min-w-11`).

**Admin**

- **Tester outcomes** (`packages/core/src/WakeGate.ts`, `packages/protocol/src/server.ts`): `WakeResult.heard.accepted`
  (true when the utterance was taken: always listening, an armed or follow-up window, a phrase; false only when it was
  dropped) and an optional `wake.heard.accepted`, additive within protocol 5 (noted in `constants.ts`). Set in core,
  passed by `SessionHub.wakeHeard` / `serveMode.ts` and the mock (`/mock/heard` takes `accepted`, `null` leaves it out).
  The tester shows "Matched <phrase>", "Accepted without a phrase" (mint, no Add; renamed in round 3) or "Ignored" (with Add); a message
  without the field says "No phrase matched". Tests: core (`heard.accepted` in all modes and windows),
  `serveFrontends.test.ts` (ignored, matched, follow-up, always), the reducer, `frontends.spec.ts`.
- **Two markers** (`FieldMarkers` in `FormFooter.tsx`, on server pages and profile forms): amber "Unsaved" while the
  draft differs from what is saved; an outlined "Custom" (server settings, front-end defaults) or "Override" (device
  page) for a saved value that differs from what it inherits. Reset's name and tooltip say what it returns to ("Reset
  Wake phrases to the built-in default (3 phrases)", "… to the default for this kind (8 s)"). A device page shows
  "Default (…)" next to "Unsaved" after a reset.
- **Nav marks**: a filled dot (unsaved), a hollow ring (to set up), "!", a key and a padlock, each with a title and
  hidden text; the legend lists every mark that is shown.
- **Focus**: on a wide screen a navigation focuses the page column's visible title (`h2`, the global focus ring when it
  came from the keyboard), so the next Tab is the page's first control; the header has no hidden title there (its
  "Admin" is the `h1`). "Skip to settings" is the first focusable element (to the title; on a phone to the content).
- **Login back-off**: the countdown is no longer a live region; a polite region says "…try again in 30 seconds" once and
  "You can try the password again now" once.
- **Wording**: profile help says "these devices" on the kind page and "this device" on a device page (Voice, Speak
  replies). A field named like its group (Activation, Voice, Interrupting) keeps its label only for assistive
  technology.
- **Latency**: seven columns (turn with "early" under it, 1st token, tts audio, playback, audible, outcome with the
  voice under it, tools) fit the page column at 1280 px; narrower, the table scrolls in a focusable, labelled region
  that fades at the edge with more.
- **Phones**: the header's status wraps as one line of text; device rows put last seen before the kind and keep
  `“hey jeff” +2` together; the voice link has an open icon and the word "Voice".
- **Claude subscription card**: while the chosen option is not saved, the footer's Save and Save and reload are
  disabled and the note says to use "Use Claude subscription" above.

Screenshots: 98 mock PNGs, new `voice-small-{320x568,360x640,375x667,667x375}-01…06`,
`voice-desktop-18-settings-sheet-error`, `-19-settings-sheet-voice-chosen`, `admin-desktop-19-unsaved-and-custom`,
`-20-nav-legend`, `admin-phone-320-01-devices`, `-02-front-end`; the tester shots show all three outcomes.
New e2e: `adminA11y.spec.ts` (focus, skip link, legend, latency at 1280 px, 320 px header), the small-screen,
modal, chat and sheet-error tests in `layout.spec.ts`. `e2e-real`: the stale-voice test expects the sheet's message;
`restart.real.ts` reads reconnecting from the label.

### Review round 3 fixes (2026-11-14)

Round 3 scored voice 8.3 / 8.1 and admin 8.0 / 7.8; the weak criteria were accessibility and responsiveness (both),
admin clarity and admin feedback. Fixed, in `apps/web` unless named (numbers are the review's items):

1. **Dialog focus** (`components/ui/Panel.tsx`): the initial target is used only when it is enabled and visible, else
   the first enabled control, else the dialog itself (`tabIndex=-1`, set by the helper). A modal dialog handles Esc and
   Tab on the document, so both work when focus has dropped to `<body>`; with nothing enabled Tab stays on the
   container; a `MutationObserver` brings focus back when the focused control becomes disabled (the Forget dialog while
   submitting). `inertBackground` makes everything outside the dialog `inert` (siblings along its path to `<body>`,
   except `data-keep-active`: the toasts); used by the Forget and Leave dialogs. Unit test `test/dialog.test.tsx`.
2. **Start / End** (`voice/useSessionFocus.ts`, `StateLabel.tsx`): after Start focus goes to the microphone button,
   after End session to Start (only when focus was lost; it retries for half a second because the stage swaps its
   notices). The announcer says "Listening" once after Start and "Session ended" once after End; any other state
   replaces them, so later returns to plain listening say nothing.
3. **Login**: the password input is `readOnly` while busy (not `disabled`), and focus is set before `select()`.
4. **Long phrases**: the voice label is a grid box whose height comes from an invisible copy of the asleep label
   (`state-label-box`), so it wraps to as many lines as the phrase needs and nothing under it moves between states.
   Devices list: the phrase wraps with only its last word and "+2" kept together (`device-phrase`); phrase editor shows
   phrases whole. Mock scenario `long-phrase` ("hello my personal voice assistant please" as the default, a third
   device with it among three).
5. **Admin phones**: on a page the full title is the page's own `h2` (wrapping; it is the focus target), the header
   keeps titles only for the two list levels. Device rows: facts on one wrapping line, `·` separators only from 640 px
   (pseudo-elements, so none is left at a line end), the kind dropped on a phone.
6. **Markers for hidden labels**: a field named like its group renders the group heading on the markers' row
   (`FieldShell` `heading`), so Unsaved / Custom / Override and Reset sit on the heading's row.
7. **Tester**: "Accepted without a phrase" (outcome `accepted`, was `answered`); idle "Ready to test <device> …",
   "Testing …" only while listening; the own-settings note also covers `followUpSeconds`.
8. **Override** shows whenever the device has an explicit saved value, with "(same as the default now)" for assistive
   technology when it equals the default. The kind page's "Custom" is unchanged (differs from the built-in default).
9. **Visible legend**: `MarkerLegend` under the intro of every page that can show the marks (server pages with
   fields, kind and device pages); chips are 11 px.
10. **Nav marks**: one padlock ("Locked: unlock the keys to change"); the legend sits outside the scrolling list, at
    the bottom of the nav column, so it never clips.
11. **Subscription card**: while the choice waits for the card's button the footer shows only Cancel and the note
    (`hideSave`).
12. **Log out** with unsaved changes holds `settingsLeave: "close"` and shows the "Leave without saving?" dialog
    ("Discard and log out" / "Stay").
13. **44 px**: "or type instead", the Advanced and folded-wake `summary` rows. Tool chips with no input are plain `div`s
    (not focusable); with input they are buttons, 44 px on a phone.
14. **Sheet refusal**: "Not changed: Expressive is switched off in admin." (mapped on the client from
    `invalid_settings`; the server text is unchanged).
15. **Toasts** shift 200 px left with the stage while the chat popover is open (1024–1439 px).
16. **Engines failed**: Start is disabled and muted with "Not available until the assistant can start."; the top bar
    has no visible "not ready" (a visually hidden word remains).

Tests: `e2e/round3.spec.ts` (new, 21 tests), `test/dialog.test.tsx`; updated `settings.spec.ts` (no Save beside the
card), `vault.spec.ts` (one padlock), `frontends.spec.ts`, `devices.spec.ts`, `layout.spec.ts`, `screenshots.shots.ts`.
New screenshots: `voice-long-phrase-{320x568,390x844}-01-asleep`, `admin-phone-320-03-long-phrase-devices`,
`-04-full-title`, `-05-long-phrase-editor`, `admin-desktop-07b-tester-ready`.

### Review round 4 fixes (2026-11-14)

Five findings, fixed in `apps/web`:

1. **Device rename is unsaved work**: `DevicePage` holds the rename draft's dirty flag and passes it to `ProfileForm`
   (`extraDirty`), which counts it in `settingsDirty` (leave check on navigation, back, close and Log out). The Name
   label shows the "Unsaved" marker; the footer note says "Unsaved name" when the name is the only edit (Cancel stays
   for the form's own drafts). A device whose kind is unknown (no form) registers the flag itself.
2. **Failed Log out**: "Discard and log out" no longer clears `settingsDirty`; the dirty flag stays until logging out
   has worked and the session ends. On failure the draft is still shown, the guard still asks, and the error is a
   toast. The mock has `POST /mock/logout-fails {"on"}` (and `mock.logoutFails`) for the test.
3. **Phrase tester Add**: after Add focus moves to the line's "Added" status (focusable, `tabIndex=-1`); success and
   refusal are announced through the tester's polite region ("Added “…” as a wake phrase. Save to keep it." /
   "Not added: …"). The status is derived from the form: in the draft only = "Added “…”, not saved yet", also in the
   saved list = "Saved “…”", removed again = the Add control returns. A refusal shows its text next to the control,
   which stays for a retry. `ProfileForm.afterPhrases` now also gets `{ draft, saved }` phrase lists.
4. **16 px on phones**: `inputClass` and the chat textarea are `text-base` (16 px) and keep 14 / 15 px from `sm`
   (640 px) up; zoom is not disabled. `e2e/round4.spec.ts` checks every visible input, textarea and select (login,
   front-end page with the phrase editor, device page, a number page, the voice sheet, the chat) at 320 and 390 px, with
   no horizontal overflow.
5. **Tester note**: "<device> overrides follow-up time; its activation, phrases and matching use these defaults."
   (`ownSettingsNote`: names the overridden fields; only when all four are overridden does it say the defaults do not
   decide what the device accepts).

Tests: new `e2e/round4.spec.ts`; updated `frontends.spec.ts` (Add wording and announcement order).
