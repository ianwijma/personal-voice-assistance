# Voice sessions: one conversation per device, several devices at once

> **Changed 2026-11-16 (docs/VOICE-PROVIDERS.md):** the assistant speaks every reply with one voice
> (`ASSISTANT_VOICE`); the voice router, `[voice:NAME]` markers, `VOICES` and `DEFAULT_VOICE` are gone, and a device
> profile's `voice` no longer changes the voice (it falls back to `""`, the assistant's voice). Where this document
> describes per-device voices or the router, that is the design as it was.

Design written 2026-11-14 (lead session), at the owner's request. It changes three things:

1. **Several devices at once.** Every voice device (a browser today; satellites around the house later) gets its own
   **voice session**: its own microphone and speaker pipeline, its own state and its own conversation. Two people on
   two devices talk to the assistant at the same time without taking the audio from each other. Today the server
   has one audio owner for the whole house, and pressing Start on a second device takes the audio away from the first
   (docs/UI-AND-MODULES.md §2.3, "last claim wins"), and both devices share one conversation.
2. **One conversation per device, and new conversations.** The history belongs to the device's session. The page has
   **New conversation**, and a conversation that has been quiet for a while ends by itself, so the next thing said
   starts a fresh one instead of dragging the old one along.
3. **One Claude subscription for all sessions.** With `LLM_PROVIDER=claude-subscription`, every conversation is
   answered by the same login, each through its own Claude Code session, at the same time.

Status of each part is kept in the "Status" section at the end. Whoever builds a part updates it, and records there
anything that had to differ from this design, with the reason.

## 1. Decisions

| Topic | Decision |
|---|---|
| What a session is keyed by | The **device** (`hello.device.id`, shared by every tab of one browser, docs/FRONTENDS-AND-ACTIVATION.md §2). A voice hello without `device` gets a session of its own keyed by its `clientId`. Admin connections never have a session. |
| Ownership | Per session, not per server. Inside one device the rules of today stay (one tab owns the audio, the others observe, the last claim on *that device* wins, `resumeOwner`). A claim on another device never takes anything from this one. |
| What is shared | The engines (language model, the loaded speech-to-text model, the voices), the module host, settings, keys, jobs, models, admin. One engine reload rebuilds them for every session. |
| What is per session | `WebAudio` (input + output link), the recogniser stream, `EchoGate`, `WakeGate`, `StateTracker`, `Publisher`, the `Conversation` and its history, the typed-input queue, the "save what it hears" tap, the device's profile (voice, interrupt mode, activation). |
| Who receives what | A session's messages (`state`, `transcript`, `turn.*`, `assistant.*`, `tool.*`, `reply.*`, `result`, `wake`, `error` about its turns, `conversation`) go only to that device's connections. `engine.summary`, `module.changed` and the like stay broadcast. Admin connections get `sessions` (§4) and do not receive turn traffic unless they follow a session (phrase tester, §4). |
| Session lifetime | Created at the first `audio.claim` or typed message of a device (not at connect, so an idle open tab costs nothing). Its pipeline stops when the device has had no connection for `SESSION_DISCARD_MINUTES` (default **30**), and its conversation is then dropped. A device that comes back within that time keeps its conversation. |
| Limit | `MAX_VOICE_SESSIONS` (default **4**): a claim or typed message that would start one more first takes the place of the least recently active session whose device has no connection left (that session is discarded early; step 4). Only when every session's device is connected is it refused with error `sessions_full` ("The assistant is already talking on N devices"), and the page shows it. The connection limit goes from 8 to **24**. |
| New conversation | A voice request `conversation.new` (any connection of the device, not admin only; it touches only that device's own conversation). It stops the running turn (as Stop), drops the session's history, and gives the conversation a new id. Every connection of the device gets `conversation { id, reason: "new" }` and an empty history. The Claude subscription session of the old conversation is closed. |
| Auto new conversation | After `CONVERSATION_IDLE_MINUTES` (default **10**, `0` = never) without a committed turn, the next turn starts a new conversation first (`reason: "idle"`). Decided at the start of the turn, by the conversation itself, so a speculative turn and its promotion see the same history. Per device: a profile field `conversationIdleMinutes` (kind default from the assistant setting) so a kitchen device can forget quickly and a desk device slowly. |
| Saying it | "New conversation" / "start over" / "forget that" as a spoken command is **not** part of this design (it needs the intent path, which is not wired yet). The button and the idle timer are. |
| History storage | Stays in memory, as today. A new conversation drops the old history; there is no archive. A server restart starts every device fresh. |
| Claude subscription | One login, **one Claude Code session per conversation**, opened lazily at that conversation's first turn, closed on `conversation.new`, on discard, and after `sessionIdleMinutes`. Turns of different conversations run in parallel. At most `MAX_VOICE_SESSIONS` Claude sessions; when one more is needed, the least recently used one is closed (it primes from the history again if it comes back). |
| Turn ids and traces | Turn ids stay per conversation (they start at 1 and the protocol uses them per session). `TurnTrace` records carry `session` (the device name) so the latency line and `bench` tell sessions apart. |
| Latency | Nothing may get slower for one device alone (checked with `bench`, before and after, one session). For two at once, `bench --sessions 2` (§6) reports both sessions' traces with simultaneous turn ends; the numbers go under Status. Contention is expected in two places only: the speech-to-text worker (one decode at a time) and a local voice (one synthesis process, clause by clause). Whether those need a pool is decided from those numbers, not now. |

## 2. Shared engines, per-session pipelines

```
                  ┌──────────────── shared engines (Engine: build / reload) ────────────────┐
                  │ Llm · Stt model (one worker, many streams) · voices (Tts) · module host  │
                  └──────────────────────────────────────────────────────────────────────────┘
device A tabs ─▶ VoiceSession A: WebAudio ▶ stt.transcribe ▶ EchoGate ▶ WakeGate ▶ Conversation A ▶ Tts ▶ WebAudio ─▶ A's owner tab
device B tabs ─▶ VoiceSession B: WebAudio ▶ stt.transcribe ▶ EchoGate ▶ WakeGate ▶ Conversation B ▶ Tts ▶ WebAudio ─▶ B's owner tab
```

- **`Engine`** (`apps/assistant/src/serve/Engine.ts`) keeps building, reloading and reporting the providers, and stops
  owning a conversation. It exposes the built providers to sessions and tells them when they go away and come back.
  A reload stops every session's voice loop (running turns end `interrupted`), rebuilds, and restarts every session's
  loop with its own history (`initialHistory`), exactly as one conversation is carried over today.
- **`VoiceSessions`** (new, `serve/VoiceSessions.ts`): the map device → `VoiceSession`, creation on first use, the
  limit, discard after `SESSION_DISCARD_MINUTES`, and the list for admin (`sessions`).
- **`VoiceSession`** (new, `serve/VoiceSession.ts`): what `serveMode.ts` wires once today, wired per device: the
  `WebAudio`, echo gate, wake gate, state tracker, publisher, heard-audio tap, the typed-input admission
  (`maxPendingInputs`, Stop generations) that lives in `Engine` today, and the `Conversation` with its voice loop.
  Its device profile configures it directly (no more "the owner's profile"): echo-gate mode, wake config, default
  voice (the router per session, so two devices can use different default voices at the same time).
- **`SessionHub`** keeps connections, handshake, admin and request routing. Ownership moves into the session:
  `audio.claim` from a connection becomes "claim on my device's session". The hub routes a connection's binary frames
  and owner-only messages to its session, and a session's messages to the connections of its device.

## 3. Engines that must serve several sessions

| Engine | Today | Needed |
|---|---|---|
| Local speech-to-text (`stt-sherpa`) | One worker holds the model and **one** VAD; a second `transcribe` fails with "already transcribing" (`SherpaStt.ts`). | The worker keeps one model and gets one VAD + turn state **per session** (messages already carry `session`). Decodes stay in one queue in the worker (the model is shared); a turn end of one session may wait behind another's decode, which `bench --sessions 2` measures. `MAX_VOICE_SESSIONS` bounds the streams. Silero VAD state is small. |
| Deepgram | One socket per `transcribe`. | Unchanged: one socket per session (cost grows with sessions talking). |
| Local voices (`tts-sherpa`) | One child process per voice, one FIFO queue of clauses. | Unchanged at first: clauses of two replies interleave in the queue, each reply waits for at most the clause in flight before each of its own. Measured; a pool per voice is a later option. |
| Cartesia | Contexts per `synthesize`. | Unchanged. |
| Language model (Anthropic, OpenAI-compatible) | Stateless HTTP. | Unchanged; requests run in parallel. |
| Claude subscription (`agent-claude-code`) | One `ClaudeSession` with one catch-up position (`syncedThrough`). | Sessions keyed by conversation (§1), each with its own catch-up position. `AgentTurnInput` gains `conversationId`; an agent that keeps state across turns keys it by that. Login is checked once and shared. |

`Stt` and `Agent` contracts in docs/ARCHITECTURE.md are updated: `transcribe` may be called concurrently (each call is
its own stream), and `AgentTurnInput.conversationId` is new.

## 4. Protocol (version 6)

- Server `conversation { id, reason: "new" | "idle" | "resumed" }`, to the device's connections, after a new
  conversation started (its history is empty) and in the snapshot (`snapshot.conversation: { id, startedAt }`).
- Client `conversation.new` (request with result; voice connections). Error `not_running` when the engines are not
  running is not needed: it works without engines (it only drops the history).
- `snapshot.history` is the device's conversation. `snapshot.ownerPresent` and `session` messages are about the
  device's own session. `state` is the device's session's state.
- Error code `sessions_full` (for `audio.claim` and `text`).
- Admin: `sessions` (to admin connections, throttled like `devices`): `[{ deviceId, name, state, ownerPresent,
  conversationId, turns, lastTurnAt }]`; `admin.snapshot.sessions`. Devices list's "audio owner now" becomes "talking
  now" per device. The phrase tester gets `wake.test { on, deviceId? }`: the transcripts of that device's session
  (default: the most recently active one).
- Profile field `conversationIdleMinutes` (0–240, kind default from `CONVERSATION_IDLE_MINUTES`).

## 5. The UIs

- **Voice page**: a **New conversation** button (icon + label in the chat panel's header, and in the control dock's
  overflow on a phone). It asks nothing (nothing is lost that the owner wanted: they asked for it). The chat panel
  empties and shows a small divider "New conversation" (and "New conversation — it had been quiet for a while" for
  `idle`). `sessions_full` shows as the start error.
- **Admin**: Devices list shows per device whether it is talking now and its state; Overview shows the sessions.
  Settings: `CONVERSATION_IDLE_MINUTES`, `MAX_VOICE_SESSIONS`, `SESSION_DISCARD_MINUTES` in the conversation section;
  `conversationIdleMinutes` in the device profile form.

## 6. Build order

1. **Packages**: `stt-sherpa` many streams per worker (tests: two concurrent `transcribe` with their own turns, one
   session closing while the other runs, the worker crash fails both); `Conversation` new-conversation and idle
   reset (`newConversation()`, `idleResetMs`, `conversationId`, events) with tests; `AgentTurnInput.conversationId`;
   `agent-claude-code` sessions per conversation (tests with the fake SDK: two conversations in parallel, LRU close,
   close on new conversation); protocol 6 schemas, examples, tests.
2. **Server**: `Engine` split, `VoiceSessions` / `VoiceSession`, `SessionHub` routing per device, settings, admin
   `sessions`, traces with `session`; scripted-client tests: two devices talk at once and each hears only its own
   reply; a claim on device B leaves device A's owner alone; tabs of one device behave as today; `conversation.new`;
   idle reset; `sessions_full`; reload with two sessions keeps both histories. `bench --sessions N`.
3. **Web**: New conversation button and divider, `conversation` handling, `sessions_full`, admin sessions; mock server,
   unit and e2e tests.
4. **Integration**: `pnpm check`, `pnpm test`, e2e, then two real browsers on the running build with the local models;
   `bench` numbers (one session before/after, two sessions) under Status.

## Status

### Step 1, packages: built 2026-11-14

**`stt-sherpa`: one worker, many streams.** `recognizerCore.mjs` keeps the models and the decode queue shared and holds
every other piece of state per session (`openSession`): VAD, AGC, pre-roll ring, frame counters, the whole-turn audio
and its generation, streaming segments, hybrid live stream. Worker protocol: `open { session }` and `end { session }`
(the old `reset { session }` is kept as "end all, open this one"). `SherpaStt.transcribe` no longer refuses a second
call: each call opens its own session id and its own `TurnDetector`; closing one sends `end` for it only; a worker
crash or exit fails every open call (and every later one). VADs are pooled: the one loaded with the model serves the
first session, another is created only while more sessions are open at once than ever before, and an ended session's
VAD is reset and reused, so a single session runs exactly as before (one extra `Map` lookup per message). Tests:
`SherpaSttFake.test.ts` "several transcriptions at once" (two concurrent whole-turn and two streaming transcriptions
with their own turns; one closed after its first event while the other finishes, then a third starts; a crash fails
both) and `recognizerCore.test.ts` "several sessions on one model".

- *Differs:* the bound on queued decode audio (`DecodeQueue.maxQueuedSamples`) is per session, not for the whole
  queue: with one shared bound, one session's long turn could make another session's turn be dropped as "overload".
  Memory stays bounded by `MAX_VOICE_SESSIONS` × the old bound.

**`core` Conversation: new conversation and idle reset.** `newConversation(reason = "new"): Effect<string>`,
`conversationId: Effect<string>`, `lastTurnAt: Effect<number | undefined>`; options `idleResetMs?: number | (() =>
number | undefined)`, `initialConversationId?`, `initialLastTurnAt?`; event `ConversationStarted { conversationId,
reason: "new" | "idle" }`; `AgentTurnInput.conversationId: string` (required). Semantics in docs/ARCHITECTURE.md
(Conversation). Tests: `packages/core/test/NewConversation.test.ts`.

- *Added:* `Agent.endConversation?(conversationId): Effect<void>` (and `AgentImplementation.endConversation`).
  `Conversation` calls it on the agents of its current setup for the old id whenever it starts a new conversation (new
  or idle), so "the Claude subscription session of the old conversation is closed" happens wherever a conversation
  ends inside core; the server calls it itself when it discards a session (step 2).
- *Decided here:* a new conversation also drops the pending question or confirmation and the routing state (sticky
  and armed agent; `RoutingChanged` is emitted when that changes anything). A turn of a replaced conversation is
  never committed to the new one (also a `textTurn` that was not stopped). A canned `Say` does not trigger the idle
  reset, and a conversation with nothing committed is never reset (no event). The idle clock is `Clock` time of the
  last commit (epoch ms), which is also what `lastTurnAt` reports for admin `sessions`.
- The voice loop now reads its events merged with a control queue (`newConversation` is handled in order with the
  events). `bench` (offline, `pnpm start bench`), HEAD before vs after this step, end of turn → playback start,
  median / worst over 12 turns: orchestration overhead 1.0 / 3.3 → 1.0 / 1.7 ms; eager off 507 / 737 → 508 / 736 ms;
  eager on 307 / 534 → 306 / 535 ms; wake phrase eager off 508 / 735 → 508 / 736 ms, eager on 307 / 535 → 306 / 534 ms.
  The stt-sherpa change is not covered by the offline bench and was not measured live (no models in this checkout).

**`agent-claude-code`: a session per conversation.** One `Slot` per `conversationId` (session, catch-up position
`syncedThrough`), kept in least-recently-used order; opened at the conversation's first turn; the login is checked once
at start. The warm (provisional) session spawned at start is a *spare*: the first conversation that needs a session
takes it, so the first turn stays warm. `maxSessions` (option and module dep, default 4): when one more is needed the
least recently used one is closed, an idle one before one in a turn; it primes from the history (`primeBlock`) when
its conversation comes back. `endConversation(id)` closes that conversation's session and starts a warm spare in the
background for the next conversation (only while fewer than `maxSessions` are open). The idle timer closes each
conversation's session after `sessionIdleMinutes`. Turns of different conversations run in parallel. Tests
(`test/agent.test.ts`, "one session per conversation"): two conversations in parallel, catch-up per conversation, LRU
close and re-prime, explicit close with the warm replacement taken by the next conversation.

- *To measure (step 4):* an idle reset closes the old session at the start of the turn that triggered it, so that
  turn's new conversation takes the spare if there is one, else waits for a process start (≈ 0.3 s at start in the
  README's measurements). With harness agents the turn starts only at promotion, and the spare is spawned at the
  speculative turn's start, so most of that is hidden; not measured.

**`protocol`: version 6** (`src/sessions.ts`, `server.ts`, `client.ts`, `snapshot.ts`, `frontends.ts`, examples,
`test/sessions.test.ts`): `conversation { id, reason: "new" | "idle" | "resumed", startedAt }`, `conversation.new {
requestId }`, `snapshot.conversation: { id, startedAt }` (required), error code `sessions_full`, admin `sessions {
sessions: SessionInfo[] }` and `admin.snapshot.sessions` (required), `wake.test.deviceId?`, profile field
`conversationIdleMinutes` (whole minutes 0–240, built-in default 10 = `DEFAULT_CONVERSATION_IDLE_MINUTES`), defaults
`DEFAULT_MAX_VOICE_SESSIONS` (4) and `DEFAULT_SESSION_DISCARD_MINUTES` (30).

- *Differs:* `conversation` also carries `startedAt`, so it can replace `snapshot.conversation` without a new snapshot.
  `SessionInfo` is `{ key, deviceId?, name, state, ownerPresent, conversationId, turns, lastTurnAt | null }`: `key` (the
  device id, or the client id of a voice connection without a device) and an optional `deviceId`, because a session of
  a connection without a device has no device id.

**Minimal server and web changes for protocol 6 (steps 2 and 3 replace them):**

- Server: the one server-wide conversation keeps its id across engine reloads (`initialConversationId`,
  `initialLastTurnAt`) and is in `snapshot.conversation`. `conversation.new` works for real on today's single
  conversation (from a voice connection; stops the turn, empties the history, new id; every connection gets
  `conversation { reason: "new" }`; works without engines) with a scripted-client test in `serve.test.ts`.
  **Stubbed:** `admin.snapshot.sessions` is always `[]` and `sessions` is never sent; `sessions_full` is never sent;
  `wake.test.deviceId` is ignored; there is no `CONVERSATION_IDLE_MINUTES` setting, so `idleResetMs` is not passed and
  the profile field `conversationIdleMinutes` is stored and validated but has no effect.
- Web: a `conversation` message (`new`, `idle`) empties the chat; `sessions` is ignored; the profile form has a control
  for `conversationIdleMinutes` but the field is in no group, so it is not shown until the server applies it. The mock
  server sends `snapshot.conversation`, `sessions: []` and answers `conversation.new`. No button or divider yet.

Results: `pnpm check` passes; `pnpm test` 142 files passed, 9 skipped; 2786 tests passed, 26 skipped (live tests
without keys or models).

### Step 3, web (`apps/web`): built 2026-11-14

No `packages/*` or `apps/assistant` file was changed. Results are under "Results" at the end of this subsection.

**State** (`src/lib/state.ts`): `conversation` (from `snapshot.conversation`, replaced by `conversation`), `divider`
(`"new" | "idle"` after a new conversation began while the page was open), `staleTurns` and admin `sessions` (in the
admin part: emptied at logout, kept across a reconnect with a valid token). `conversation` with `new` / `idle` empties
the chat and the live transcript, sets the divider, clears the unread dot; `resumed` only changes the id. A reconnect
keeps the divider while the id is the same; a different, empty conversation (replaced while away) gets "New
conversation"; the first connect shows none. `sessions_full` as an `error` message makes no toast.

- *Added:* `staleTurns`. The turn that New conversation stops may send `turn.end` (or text) *after* `conversation`,
  and the reducer would make a ghost turn in the new chat (it creates views for unknown turn ids, for tabs that join
  mid-turn). Messages about the replaced conversation's turn ids are dropped until a `turn.start` with that id (ids
  start again at 1 per conversation). Errors about them still toast.

**Voice page:** `components/NewConversation.tsx`. In the chat panel's header: icon + "New conversation" (the label is
visually hidden at 360 px and below so the title fits; the accessible name stays). On a phone (below 640 px) the
control dock has a fourth round button **More** with a menu holding "New conversation" (Esc and clicking outside close
it, focus goes into it and back to More), and a toast "Started a new conversation." confirms it when the chat is
closed. Neither asks anything. They send `conversation.new` (`client.newConversation()`). The chat empties only on the
server's `conversation`, so every tab of the device shows the same. The divider (`MessageList`, polite live region):
"New conversation" or "New conversation — it had been quiet for a while". `sessions_full` (`lib/sessions.ts`
`sessionsFullText`): "The assistant is already talking on N devices. Try again when one of them is done." (N from the
server's message; "on another device … when it is done" for 1, "on other devices" without a number). On `audio.claim` the client closes
the microphone again and shows it as the start error card (with Try again); on typed text the composer shows it.
The observer banner says "Audio is on another tab" (another device no longer takes the audio).

**Admin:** the header line comes from `sessions`: "ready · no device is listening", "<state> on <device>" for one,
"talking on N devices (· M answering)" for several (it used to read `session.serverState`, which admin connections no
longer get). Devices list: "Talking now" + the session's state per device (`talking-now`, `session-state`; a server
that lists no sessions falls back to `audioOwner`). Device page: "talking now, <state>" and a Conversation row (turns,
last turn). Overview: a **Voice sessions** section (most recently active first: name, Talking now, state, turns, last
turn; "N talking · M of MAX" when a section carries `MAX_VOICE_SESSIONS`; a row opens the device's page). Profile form:
a **Conversation** group with `conversationIdleMinutes`, "Start a new conversation after [n] minutes quiet", help
"… 0 = never". The three assistant settings render through the generic settings screen (checked in the mock, where
they are on Language model › Conversations). Phrase tester: **Listen to** (shown when two or more sessions have a
device): "The device talking most recently" (default, no `deviceId`) or one device; switching while listening clears
the lines and sends `wake.test { on: true, deviceId }` again; the scope line names the device it follows.

**Mock** (`mock/server.ts`): one `VSession` per device (device id, or client id without one) with its own owner,
state, mic, history (each starts with the example history), conversation, reply, wake windows. A record exists from
the first connection (so the welcome has its conversation); it is *started* (counted, listed) at the first claim or
typed message. Turn traffic, `state`, `session`, `wake`, `conversation` go only to that device's connections; admin
gets `sessions` (on every change) and `admin.snapshot.sessions`, and no turn traffic. Last claim wins only within a
device. `conversation.new` per device (a stopped turn is never committed to the new conversation). Idle reset at the
start of a turn after the device's `conversationIdleMinutes`. `MAX_VOICE_SESSIONS` → `sessions_full` (`error` for a
claim, failed `result` for `text.send`). Discard after `SESSION_DISCARD_MINUTES` without a connection.
`wake.test.deviceId`. New endpoints `/mock/idle {deviceId?, now?}` and `/mock/max-sessions {n}`; `/mock/turn`, `/wake`,
`/state`, `/heard` take an optional `deviceId`; `/mock/log` lists `sessions`. A Conversations settings section
(`CONVERSATION_IDLE_MINUTES`, `MAX_VOICE_SESSIONS`, `SESSION_DISCARD_MINUTES`).

**Tests.** Unit: `test/sessions.test.ts` (15: conversation new / idle / resumed, divider, late messages of the
replaced turn, reconnect cases, `sessions_full` without a toast, admin sessions and logout, the words). E2E:
`e2e/sessions.spec.ts` (10: New conversation in the header with a second tab of the device following; two devices
(browser contexts) talking at once with separate conversations and owners, New conversation on one leaving the other;
the idle divider; one device too many for Start and for typing; the phone's More menu and Esc; no More on desktop;
admin Devices / device page / Overview / header with two devices and live state; the tester following one device; the
profile field and the server section). Changed: `devices.spec` ("Talking now" instead of "Audio owner now"); the
screenshot script's observer shots use another tab of the same context (another context is another device now).

- *Differs / for step 2 to know:* the web reads `sessions_full` for a claim as an `error` message (the claim has no
  request id) and for `text.send` as the failed `result`. Admin no longer gets `state` or turn messages, so admin ›
  Diagnostics › Latency fills from `admin.snapshot.traces` only (it used to grow live from `turn.end`); a live trace
  push to admin would need a protocol addition (not made).

### Step 2, server: built 2026-11-14

**Engine split** (`serve/Engine.ts`): the engine builds, reloads and reports the shared providers and owns no
conversation. A voice session attaches its loop (`Engine.attach(loop)`); every attached loop is started on each build
(`BuiltEngines`: the providers and the build's output rate) and interrupted when the build ends (reload, failure,
stop) before the providers close. A loop that fails (not an interruption) ends the build: `failed`, stage
speech-to-text, as a dead recogniser did before. `Engine.voices()` reports the enabled voices and `DEFAULT_VOICE`.

**`serve/SessionConversation.ts`**: what the engine held per conversation, now per session: the `Conversation` and its
voice loop on the shared engines, the history, conversation id and idle clock carried across builds
(`initialHistory`, `initialConversationId`, `initialLastTurnAt`), the typed-input admission (`maxPendingInputs`,
Stop generations), and a voice router per session (its default voice: the profile's when enabled, else
`DEFAULT_VOICE`; output rate fixed per build). `end` detaches, waits for the loop, and calls `endConversation` on the
agents of the running build (a discarded session closes its Claude Code session).

**`serve/VoiceSession.ts`**: one device's `WebAudio`, echo gate, wake gate, state tracker, publisher, heard-audio tap
and session conversation, configured from its device profile live (`syncProfile`: interrupt mode, wake config;
default voice and `conversationIdleMinutes` → `idleResetMs` read at use). Its traces use a per-session `TurnTrace`
(turn ids from 1 per session, `Trace.session` = the device name; the shared service logs and keeps them, and the
latency line starts with `[device name]`).

**`serve/VoiceSessions.ts`**: device → session; created at the first `audio.claim`, `text.send` or `resumeOwner`
hello of a device; `MAX_VOICE_SESSIONS` → `sessions_full`; discarded after `SESSION_DISCARD_MINUTES` without a
connection (loop stopped, agents told, audio closed, ownership forgotten); a device without a session keeps a reserved
conversation id (so `conversation.new` works before anything was said and its first turn uses that id); the recent
traces of every session for `admin.snapshot.traces`.

**`SessionHub`**: a voice connection's session key is `hello.device.id`, else its `clientId`. Ownership per session
(one owner tab per device, last claim on that device wins, `resumeOwner` within the device, micFramesLost per
session). `toSession` sends a session's messages to its device's connections only; `broadcast` stays for shared
ones; admin gets `sessions` (throttled like `devices`) and `admin.snapshot.sessions`; snapshots are the device's
(`history`, `state`, `ownerPresent`, `conversation`); `conversation.new` is per device; `wake.test.deviceId` (unknown
device: `unknown_device`; absent: the most recently active session). Connection limit 8 → 24.

**Settings** (section `llm-behaviour`, Agents → Behaviour, live, no reload): `CONVERSATION_IDLE_MINUTES` (default 10,
0..240, 0 = never; it is the built-in default of the profile field `conversationIdleMinutes`, under the kind defaults:
`Frontends` option `conversationIdleMinutes`), `MAX_VOICE_SESSIONS` (default 4, 1..8, advanced),
`SESSION_DISCARD_MINUTES` (default 30, 1..1440, advanced).

**HeardAudio**: one recorder per session; files `<time>-<device-name-slug>-<n>.wav/.json`, `.json` has
`device: { key, name }`, the log line says "Heard on <device> (…)".

**`bench --sessions N`** (`bench/offline.ts` `runOfflineSessions`): N scripted sessions, each its own `Conversation`,
the TTS stand-in behind one shared voice router, every turn end simultaneous (a barrier per turn), one table per
session.

**Claude subscription**: every session's conversation uses the one running `claude-subscription` agent (read from the
module host per turn); `subscription.ts` needed no change: `makeSubscriptionAgents` is stateless per setup and the
agent keys its sessions by `AgentTurnInput.conversationId`. `subscription.test.ts` now also runs two devices' turns at
once through the fake SDK: two Claude Code sessions, each with only its own conversation.

Tests: `test/serveSessions.test.ts` (scripted client, real server, injected providers): two devices talk at once and
each hears only its own reply and sees only its own transcript/history; a claim on B leaves A's owner alone and tabs of
one device take over within it; `conversation.new` on A leaves B; `conversation.new` before a session exists; idle
reset (`ServeOptions.minuteMs` shortens a minute); `sessions_full` for claim and text; discard after the timeout and
resume within it; engine reload with two sessions keeps both histories and ids; admin `sessions`; the phrase tester
following a device. `engine.test.ts`: reload restarts every attached loop with its own history; a failed loop stops the
engines; the typed-input admission tests now run on a session conversation. `heardAudio.test.ts`: the device in
names and metadata. `bench.test.ts`: simultaneous turn ends with two sessions.

Existing tests whose assumptions changed (kept their intent): in `serve.test.ts` every tab of a test is the same
device by default (they test tabs of one device); tests that typed from an admin connection now type on a voice page
(`serve.test.ts`, `serveVault.test.ts`, `subscription.test.ts`); the echo-gate mode test reads the device's session's
gate; the wake-phrase tests' observer and late tabs are the owner's device; `sessionHub.test.ts` and `http.test.ts`
fakes follow the new interfaces; `controlledStt` (test harness) has one event stream per `transcribe` call
(`emitTo(i)`; `emit` with none open yet goes to the next one opened).

- *Differs / decided here:*
  - Admin connections cannot type (`text.send` from admin is `bad_message`): admin has no session, as §1 says. The
    admin page's own chat, if it has one, must go (step 3).
  - The device's own tabs get `turn.end.trace` without `session` (it is the admin-set device name, and the voice
    page must not receive admin data); admin's `admin.snapshot.traces` carry it (`TraceInfo.session`, new optional
    field in protocol 6). Admin pages no longer receive `turn.*` (no turn traffic to admin): their latency view only
    updates from `admin.snapshot.traces` until step 3 decides otherwise.
  - `audio-web`: the first consumer of a `WebAudio` input now takes the frames queued before it (bounded as before);
    only a later consumer (after a reload) starts from now. A session is created at the claim, so the owner's first
    frames can arrive before its recogniser stream is open; clearing them lost the start of the first utterance.
  - Sessions are created synchronously in the hub handler with `Effect.runForkWith(services)` + `pollUnsafe`, not
    `runSync`: fibers forked under `runSync` (the input's noise floor) never ran again.
  - A `resumeOwner` hello on a device without a session opens one (as a claim); `sessions_full` then leaves the tab an
    observer with an `error`.
  - `conversation.new` without engines and without a live conversation does not close the old conversation's Claude
    session (no agents to reach then); the agent's own idle timer closes it.
  - `MAX_VOICE_SESSIONS` lowered below the sessions that exist refuses only new ones.
- *Bench* (offline, `pnpm start bench`; end of turn → playback start, median / worst over 12 turns; this
  machine, other work running). One session, before → after this step: orchestration overhead 1.0 / 3.2 → 1.0 / 1.7
  ms; eager off 508 / 736 → 508 / 736 ms; eager on 307 / 535 → 306 / 534 ms; wake phrase eager off 508 / 735 → 508 /
  735 ms, eager on 306 / 534 → 307 / 535 ms. `bench --sessions 2` (simultaneous turn ends, shared voice router),
  session 1 / session 2: overhead 1.5 / 4.2 and 1.4 / 4.1 ms; eager off 509 / 736 both; eager on 308 / 534 both; wake
  eager off 508 / 736 both; wake eager on 307 / 535 and 308 / 535 ms. Two sessions cost ≈ 0.5 ms of orchestration per
  turn and nothing visible on the realistic scenarios. The offline bench runs the real `Conversation` with in-process
  stand-ins; it does not exercise the shared stt-sherpa worker or a local voice process (the contention points of §1),
  which step 4 measures live with the models.
- *For step 3 (web):* the settings are in section `llm-behaviour`; `conversationIdleMinutes` can now be shown (its
  kind default follows `CONVERSATION_IDLE_MINUTES`); `sessions` / `admin.snapshot.sessions` are sent for real;
  `TraceInfo.session` is optional and only in admin traces; an admin page gets no `turn.*`, `state` or `transcript`
  any more; `sessions_full` comes as an `error` after `audio.claim` and as a `result` error for `text.send`;
  `wake.test.deviceId` works (`unknown_device` for an unknown id).

Results (step 3): `pnpm --filter @pva/web check` passes; `pnpm --filter @pva/web test` 32 files, 477 tests passed;
`E2E_MOCK_PORT=8817 pnpm --filter @pva/web e2e` 123 passed, 1 failed: `chat.spec` "replies that arrive while the chat
is closed…" pressed `c` before the page had loaded while root `pnpm test` ran at the same time; it passed in the
first full run and 3 of 3 times when rerun alone (an existing race in that test, not in this change). Screenshots: 26
passed, 8 new PNGs (`voice-desktop-20…23`, `voice-phone-10…12`, `admin-desktop-06b-overview-sessions`), the rest
regenerated. Root `pnpm check` passes; root `pnpm test`: 2 failures, both in `apps/assistant` (`serveVault.test.ts`,
`subscription.test.ts`, step 2 in progress), 2811 passed.

### Step 4, integration: done 2026-11-14

`models/` and `bench-audio/` are symlinks to the main checkout's (read-only use). Real server: `LLM_PROVIDER=fake`,
the default local recogniser (parakeet-v2, whole-turn, 8 decode threads) and the default voice (Piper lessac, one
process). This machine has 16 cores and is shared: other worktrees' test runs pushed the load to 13–40 during the
first bench runs, which made those numbers useless (a 3-session staggered run showed worst cases of 3.7 s). Every
number below is from a run that started at a 1-minute load average under 3 (`/proc/loadavg` recorded before and
after each run).

**`bench --live --sessions N [--stagger MS]`** (`bench/live.ts` `runLiveSessions`; `runLive` is the one-session
case). N sessions, each its own `Conversation`, `TurnTrace` and output directory (`<out>/s<i>`), on the shared real
providers: one `Stt` (`transcribe` once per session, so the one sherpa worker with one stream per session), one LLM,
one voice router over the real voices. Session `i` plays the WAVs rotated by `i` (different sentences at once). Each
turn starts when every session has had its previous reply (a barrier); the shorter files of a turn get leading
silence so the user audio of every session ends at the same moment (to the 20 ms frame), plus `i × MS` with
`--stagger`. Tests: `bench.test.ts` (rotation, simultaneous ends within 30 ms, stagger 300 ms → gap 260–340 ms,
per-session output folders), `providers.test.ts` (argument parsing).

**Latency** (`pnpm start bench --live --rounds 4 --sessions N [--stagger 300] bench-audio`: 5 WAVs × 4 rounds = 20
turns per session; fake LLM 1st token 250 ms, 60 tok/s). Milliseconds from the end of the session's user audio.
"STT" = `EndOfTurn` (the final transcript; it includes the recogniser's end-of-turn silence, about 600 ms), "first
audio" = `ttsFirstAudio`, "playback" = `playbackStart` (file output, so ≈ first audio). Median / worst.

| Run | Session | STT final | first TTS audio | playback start | turns without eager start |
|---|---|---|---|---|---|
| 1 session (run 1) | – | 650 / 701 | 718 / 998 | 718 / 999 | 0 of 20 |
| 1 session (run 2) | – | 660 / 703 | 706 / 1061 | 706 / 1061 | 0 of 20 |
| 2, simultaneous | s1 | 660 / 701 | 754 / 1139 | 754 / 1139 | 0 of 40 |
| | s2 | 660 / 701 | 762 / 1018 | 762 / 1018 | |
| 3, simultaneous | s1 | 661 / 701 | 847 / 1233 | 847 / 1234 | 0 of 60 |
| | s2 | 660 / 721 | 821 / 1139 | 821 / 1139 | |
| | s3 | 660 / 701 | 802 / 1092 | 802 / 1092 | |
| 2, 300 ms apart | s1 | 641 / 701 | 704 / 998 | 704 / 999 | 0 of 40 |
| | s2 | 662 / 701 | 720 / 1059 | 720 / 1059 | |
| 3, 300 ms apart | s1 | 661 / 720 | 726 / 1109 | 726 / 1110 | 0 of 60 |
| | s2 | 673 / 701 | 738 / 1026 | 738 / 1026 | |
| | s3 | 660 / 700 | 720 / 1076 | 720 / 1076 | |

The worst case of every run is the Tokyo turn (a tool call: two LLM rounds). The other runs at the same low load
(2 and 3 simultaneous, a few minutes earlier) gave 771 / 783 and 838 / 876 / 851 median first audio, with 4 of 40
and 6 of 60 turns that lost their eager start.

**Where the time goes.** A second session at the same moment adds **≈ 40–55 ms** median to end of turn → first
audio (≈ 718 → 754–762), a third ≈ 85–130 ms over one session. Staggered by 300 ms, sessions cost nothing
measurable. Neither crosses the ~150 ms bar for two sessions, so nothing was built. From the traces:

- **Speech-to-text, eager decode (the cause).** The speculative turn starts at `EagerEndOfTurn`, which waits for a
  whole-turn decode in the one worker's one decode queue. Median eager point after the end of the audio: 1 session
  405 ms, 2 at once 424–439, 3 at once 469–473: each session whose decode is ahead adds ≈ 30 ms (one Parakeet decode
  of a 2–3 s turn on 8 threads). The fake LLM's first token is 250 ms after the speculative start, so `1st token`
  moves by the same amount (676 → 705–724 → 756–797) and with it first audio. With one session the eager lead
  (eager + 250 ≈ 655 ms) only just hides the LLM behind the final threshold (≈ 650 ms), so every ms of eager delay
  shows. When the eager answer arrives after the final threshold the turn is not speculative at all and the LLM
  starts at `EndOfTurn` (+250 ms): this happened in 4 of 40 / 6 of 60 turns in one pair of runs and 0 in the other.
  Under heavy outside load it was 12 of 60, and the stt-sherpa test "hybrid: … the answer from Parakeet" failed once
  in a full `pnpm test` for the same reason (passes alone, 3 of 3).
- **Speech-to-text, final transcript: no contention.** Median `EndOfTurn` 650–673 ms in every run, worst ≤ 721 ms
  (the final usually needs no new decode: the eager answer's segments are final).
- **Local voice: no contention.** First clause sent → first audio is 24–28 ms median in every run (one session
  24–25), worst ≤ 84 ms at low load. The replies are short, so the one Piper process rarely has two clauses waiting.

**Proposed (not built), in this order if more devices are used at once:**

1. *Decode order in the worker* (no memory): put end-of-turn decodes (eager and final) ahead of queued interim
   decodes of other sessions, and skip interim decodes while any session's end-of-turn decode is waiting. It cannot
   make three simultaneous eager decodes parallel, but removes interim work from their path. Cheap; measure with
   `--sessions 3`.
2. *A second STT worker* with the same model, sessions assigned to the less busy worker: eager decodes of two
   sessions then run in parallel (each on fewer threads, e.g. 2 × 4 on this 16-core machine; fewer threads make each
   decode slower: the preset notes 13.9 s of audio in 345 ms on 8 threads against 459 ms, not measured here). **Memory: ≈ 1.1 GB RSS per worker** for parakeet-v2 (`transcribe`
   peaks at 1.38 GB RSS against 0.27 GB for `text` mode without the model). Only worth it if three or more devices
   often finish speaking within ~100 ms of each other.
3. A TTS process pool per voice is not needed on these numbers (≈ 80 MB model on disk, one more process per voice).

**Admin latency live again (protocol 6, added before release).** Server message `trace { key, deviceId?, trace }`
(`packages/protocol/src/server.ts` `TraceMessage`; example in `serverExamples.trace`; changelog in `constants.ts`),
in `ADMIN_ONLY`: sent to admin connections for every finished (not discarded) turn of every session, with
`trace.session` = the device's name, from the same place that keeps `admin.snapshot.traces` (`serveMode.ts`
`onTrace`). Web: reducer `trace` appends (turn ids repeat across sessions, so it does not replace by id); the
latency page shows the device's name under the turn number (`trace-device`, truncated with a title); rows keyed by
position. Mock: sends `trace` at every turn end and keeps `session` in its admin traces. Tests: protocol
`sessions.test.ts` (round trip, `deviceId` optional, bad key / device / missing trace refused); server
`serveSessions.test.ts` (two devices' three turns reach admin with key, device and name; voice pages never get
`trace`; the later admin snapshot has the same three); web `test/sessions.test.ts` (appended with repeated ids, no
unread); mock e2e `sessions.spec.ts` "Diagnostics › Latency grows live …". docs/ARCHITECTURE.md (SessionHub) and
docs/UI-AND-MODULES.md (voice sessions) updated.

**Test hook `PVA_TEST_MINUTE_MS`** (`serveMode.ts`, tests only, logged as a warning when set): what one minute of
`conversationIdleMinutes` and `SESSION_DISCARD_MINUTES` is, passed to the existing `ServeOptions.minuteMs`. The
product minimum (whole minutes) is unchanged.

**Real browsers** (`apps/web/e2e-real/sessions.real.ts`, port 8805): two headless Chromium *processes* (Chromium's
fake microphone file is per process), Mac and Windows user agents, each fed its own WAV (question 1 / question 3,
padded so the speech ends at the same moment), against the real server with the local models; minute = 3 s. One
test, in order: admin logged in on Diagnostics › Latency; Start on both at once; each page gets exactly its own
`turn.start` (A "Hello, can you hear me?", B "…octopuses."), its own reply text, one `reply.start`, and reports
`playback.started` once and `playback.finished`; nothing of the other device's turn arrives (no transcript, reply
text or audio); chat and server history (a probe hello with the device id) hold only the device's own turn; admin's
latency table grows to two rows live, named "Mac · Chrome" and "Windows · Chrome"; a second tab of B presses Start:
B's first tab becomes the observer, A's tab is never told `taken_over` and stays owner; admin Devices shows both
"Talking now", Overview two sessions, both talking; New conversation on A empties A's chat (divider `new`) and A's
history, B's chat and history unchanged; with the kind default `conversationIdleMinutes: 1`, a typed turn on A,
4.5 s quiet, the next typed turn starts with `conversation { reason: "idle" }`, the idle divider and a history of
just that turn; nothing of it reaches B.

- *Found by it:* B's second tab's fake microphone starts its file again, so B says its question a second time about
  5 s after its first turn, after the quiet time had become 3 s: B reset itself (`idle`) right before that turn,
  which is correct. The spec now checks that B never gets A's `new` and that every reset on B comes right before a
  turn of B's own.

**Fixed**

- *A departed device held its place for 30 minutes* (found by the full real-browser run: `session.real.ts`'s module
  test, the fifth browser context of that file, got `sessions_full` with nobody else connected; the four earlier
  tests' devices had closed, but their sessions wait `SESSION_DISCARD_MINUTES`). A guest's phone that opened the page
  once would do the same in the house. `VoiceSessions.open` now, at the limit, discards the least recently active
  session whose device has no connection (logged "discarded early") and starts the new one; `sessions_full` only when
  every session's device is connected. *Differs from §1 "Limit"* (updated there): a device that left loses its
  conversation before `SESSION_DISCARD_MINUTES` when another device needs the place, rather than the present device
  being refused. Test: `serveSessions.test.ts` "at the limit, a device that is here takes the place of the least
  recently active one that left" (the least recent one goes, the other keeps its history, a full house of connected
  devices still refuses). The mock does the same.
- *Real-browser specs out of date since steps 2–3* (not run since): `fixtures.ts` `serverHistory(url, page)` now
  probes as the page's device (a probe without a device has an empty session of its own, so `bargein.ts` and three
  `session.real.ts` tests read `undefined`); `profiles.real.ts` reads `talking-now` ("Talking now") instead of the
  removed `audio-owner`; `wake.real.ts` checked "no `hearing` before the first `listening`", but at the wake the
  state now goes from `asleep` straight to `hearing` in the same tick (the `wake` message and `state hearing` arrive
  together; nothing of the ignored sentence showed): it now checks no `hearing` before the `wake` message.

**Results** (final runs, after the fixes, one after the other at a load average of 0.4–2.9). `pnpm check` passes.
`pnpm test`: 147 files passed, 6 skipped; **2838 tests passed**, 10 skipped, 0 failed. `E2E_MOCK_PORT=8817 pnpm
--filter @pva/web e2e`: **125 passed** (the known `chat.spec` unread-dot flake did not occur in either run).
`pnpm --filter @pva/web e2e:real`: **24 passed** (5.3 min; 23 existing + `sessions.real.ts`). The new spec passed in both full
runs and alone (its first run alone failed on the B-resets-itself check described above).

An earlier full `pnpm test` (before the fixes, other worktrees' tests running) had 2 failures, both timing under
load and both passing alone: `audio-pipewire` "a consumer that falls behind…" (known, see the frontends doc) and
stt-sherpa "hybrid: … the answer from Parakeet" (the eager decode came after the final threshold, the mechanism
measured above; 3 of 3 alone). The first full `e2e:real` run had the 7 failures fixed above (6 stale specs and the
place held by departed devices).

**Open**

- Contention fixes 1–2 above: not built; decide from `bench --live --sessions 3` on the owner's machine.
- The bench's fake LLM (250 ms to its first token) leaves almost no eager lead, so the eager-decode delay shows fully
  in first audio; with the Claude subscription or a hosted model the comparison is the same mechanism but was not
  measured here (no key).
- Not tried with real browsers: `sessions_full` (the mock e2e and server tests cover it), a Claude subscription
  conversation per device, `SESSION_DISCARD_MINUTES` expiry (server test with `minuteMs`), and different default
  voices per device at the same time.
