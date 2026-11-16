# Assistants: several configured assistants, assigned to devices

Design written 2026-11-16 at the owner's request. Today there is one assistant, and its configuration is spread over the
global settings (language model, speech recognition, voice, modules), the front-end kind defaults and the device
overrides (activation, wake phrases, follow-up, conversation reset). This design makes the **assistant** a thing the
admin creates. Each assistant has its own prompt, language model, hearing, voice and modules. **Devices** say which
assistants answer on them and which phrase wakes each one.

The UI contract is the two owner-approved mock-ups, `docs/mockups/assistants/admin.html` and
`docs/mockups/assistants/voice.html`. Where they and the owner's brief disagree, the brief wins; §7.3 lists every
such difference. The design builds on three other pieces of work:

- **Voice sessions** (docs/VOICE-SESSIONS.md, merged as #5): a voice session per device.
- **Voice providers** (`docs/VOICE-PROVIDERS.md` in worktree `t3-5b95ea17`, server half built, not merged). It
  provides one voice reference `{ provider, voiceId }`, removes the voice router, retires the per-device voice and
  expects a per-assistant voice selection (its §7.1).
- **Voice nodes** (docs/VOICE-NODES.md on branch `t3/standalone-triggered-voice-service`, PR #4).

`docs/ARCHITECTURE.md` stays the contract. This design changes none of its service interfaces (`AudioInput`,
`AudioOutput`, `Stt`, `Llm`, `Tts`), and the `Conversation` API is unchanged too. It replaces `WakeGate`'s
configuration (§3.4), makes additive changes to `Trace` and adds trace marks (§3.7). ARCHITECTURE.md is updated by
WP-16.

Sections: 1 decisions · 2 data model · 3 run time · 4 existing concepts · 5 protocol · 6 migration · 7 UI map ·
8 build plan · 9 risks and open questions · Status.

## 1. Decisions

### 1.1 The owner's decisions (fixed)

| Topic | Decision |
|---|---|
| Assistant | A created configuration: name, purpose, Handles (for routing), on/off; behaviour (system prompt, tool rounds, new conversation after a quiet spell or never, start replying early, keep listening after a reply); language model (account, model, effort, thinking, limits); hearing (engine, model, language, turn timing, microphone processing); one voice (a voice reference); modules (on/off, which tools, optional own settings that override the shared ones field by field). It has **no wake phrase**. |
| Devices | Front-end kinds and devices are merged into **Devices** in the UI. Each device type (browser, voice node) has a defaults entry; a device follows it unless it has its own value. Each device or defaults entry holds an ordered list of assigned assistants. Each assignment has its own wake phrases and an optional "keep listening after a reply" (the device's value wins over the assistant's). "Answers without a phrase" is one of: nobody, one assigned assistant, or TypeSafe decides (with a fallback assistant or nobody, and a give-up time, default 400 ms). |
| Routing a sentence | A wake phrase wins: the whole sentence after it goes to that assistant. Otherwise, during an assistant's follow-up time, it stays with that assistant. Otherwise "Answers without a phrase" decides. TypeSafe is optional, hosted and per device: one Choice over the device's assistants, described by their Handles, plus a Noul for "does any fit". A timeout, an error or "none fits" goes to the fallback. With TypeSafe on, an assistant without a phrase still counts as reachable. |
| Recogniser | One per device; speech recognition always runs on the server. A device uses the Hearing settings of the assistant that answers without a phrase, else those of the first in its list (also with TypeSafe). The other assistants' Hearing settings are not used on that device, and the UI says so. |
| Conversations | One per assistant per device, each with its own history, id and idle clock. The reset time comes from the assistant, and "never" is allowed. |
| Shared settings | Home (location, time zone, language, units, date format); each module's shared settings; language-model accounts; speech models; voice providers and favourites; routing (TypeSafe key and model); limits. Module settings resolve assistant's own → shared → module default. |
| Voice page | The assistant's name, with a menu, in the top bar. Picking there changes who answers without a phrase on that device; an admin toggle per device allows it. The chat shows one conversation per assistant, with a switcher. The settings sheet loses Voice and Activation. Follow-up time is not shown for now. |
| Diagnostics | Each trace carries the assistant, the device, who chose the assistant (phrase, follow-up, default, or TypeSafe with its probability and time) and a snapshot of the latency-relevant configuration at that turn. |
| Latency | Everything that can add delay (the TypeSafe call, extra speech-model workers, per-assistant language-model instances and their warm-up, more voices) is measured through `TurnTrace` in its work package. No latency claims from reasoning. |

### 1.2 Engineering decisions (mine)

| Topic | Decision | Why | Rejected |
|---|---|---|---|
| Several conversations on one audio path | A **session dispatcher** per voice session: one recogniser stream, then the echo gate, then a **route gate**, then the dispatcher, then N unchanged `Conversation`s (one per assistant, made on first use), all sharing one `AudioOutput` through a lease (§3.3). | Leaves the 1700-line `Conversation` and its tested contract untouched; the utterance contract already defines everything the dispatcher needs (an empty `EndOfTurn` ends an utterance and starts nothing, ARCHITECTURE.md:84-86). | One `Conversation` with a history per agent: rewrites core's history, idle and routing state. |
| Moving an utterance to another assistant | The dispatcher sends `SpeechStarted` to the conversation that is speaking (for barge-in) at once. When the transcript shows the sentence is for another assistant, it closes the utterance there with an empty `EndOfTurn` and replays `SpeechStarted` plus the text to the target. | Barge-in keeps its speed (it acts on `SpeechStarted`, before any words), and routing waits for words. | Holding barge-in until routing is known: slower interruption. |
| One speaker | A per-session output lease: when one conversation starts `play`, a play still running for another fails with `AudioError("superseded")`. That turn is then committed like an interrupted one (the existing playback-failure rule, ARCHITECTURE.md:180). | Two replies can never sound at once, even with typed text racing speech. | Trusting the dispatcher's ordering alone. |
| Where the wake phrase is matched | `WakeGate` becomes `RouteGate` (pure, core). Its phrases carry their assistant, follow-up windows belong to an assistant, and every event it lets through is tagged with a tentative target. Phrases are matched and stripped in every mode. | One matcher (`matchWakePhrase`, WakeGate.ts:182) with one tester. In the new model "always" means "someone answers without a phrase", and a phrase can still pick another assistant. | A second matcher in the dispatcher. |
| "Start replying early" off | The dispatcher drops `EagerEndOfTurn` and `TurnResumed` before that assistant's conversation; for a Claude subscription assistant it also sets the agent's `speculate`. | No core option needed; the utterance contract allows an utterance without eager events. | A new `Conversation` option. |
| Shared resources | The single build of `EngineProviders` (Engine.ts:25-38) becomes a **resource pool** keyed by configuration: one language-model instance per distinct adapter configuration, one recogniser **worker** per distinct local model and language, one `Tts` per distinct voice reference. Assistants that use the same configuration share one. Resources are built for what is reachable, released 10 s after their last user. | The pool shares what can be shared, so a second assistant with the same settings costs nothing. | One full set of engines per assistant: wasteful, and two copies of one 0.5–1 GB model. |
| Per-assistant turn timing on one shared model | `stt-sherpa` shares a worker per (model, language, model directory, threads) across `make` calls. Turn timing, VAD threshold and gain become per-stream options, carried in the worker's per-session messages (the worker already keeps a VAD and gain control per session, ARCHITECTURE.md:207). The `Stt` interface is unchanged. | Two devices whose hearers differ only in end pause share one model in memory. | Adding an options argument to `Stt.transcribe`, which would change the contract. |
| What reloads | No global engine reload for assistant changes. A changed resource key builds the new resource first, then each conversation switches at its next turn start; the running turn finishes on the old one. A full reload remains only for model directories and thread counts. | Today any provider change stops every session's loop (Engine.ts:203-206); that becomes unacceptable when changing one assistant would interrupt all of them. | Keeping the global reload. |
| Changing a device's recogniser | It happens when the hearer's settings or the hearer itself change (an assignment change, or a pick on the voice page). The session's recogniser stream is replaced at the next moment no utterance is open (waiting at most 5 s), after the new resource is ready. | An utterance is never cut in half. | Restarting at once. |
| Device overrides granularity | Per **section key** of the device settings (assistants, withoutPhrase, matching, voicePage, interruptMode, audio, captions), not per field. | Matches the mock-up's "Own value · Reset" per section, and keeps an ordered assistant list one unit. `withoutPhrase` is its own key, so a voice-page pick does not copy the whole list. | Per-field overrides (today's `ProfileOverrides`, protocol/frontends.ts:222). |
| Module instances | A module runs while at least one switched-on assistant has it on. An assistant with its own module settings gets its own instance, shared with any assistant whose effective settings are equal. Only fields a module marks `overridable` can be per assistant; secrets and addresses never. | `ModuleHost` keeps one instance per module id today (ModuleHost.ts:50-64). Sharing by effective settings keeps the common case at one instance. | One instance per assistant always: duplicates caches and connections (Home Assistant's 60 s refresh). |
| Tool selection | Stored as the names of the tools switched **off** (`offTools`), applied as a per-turn filter on the registry by tool name (`toolModules`, ModuleHost.ts:57). | Tool indexes (the mock-up's `off: [2]`) break when a module's tools change; the filter costs one set lookup per tool per turn. | Separate registries per assistant. |
| Where entities live | `data/settings.json` version 4 gains `assistants` and `deviceTypes`; `devices` changes shape. Shared settings stay env-keyed flat sections; module shared settings stay under `modules`. Assistants hold no secrets. | Secrets keep their one path into the vault (flat keys and module secrets, unchanged). | Per-assistant secrets. |
| Environment values for per-assistant keys | A `.env` value of a key that became per-assistant (`SYSTEM_PROMPT`, `ANTHROPIC_MODEL`, `STT_SHERPA_MODEL`, …) applies to, and locks, that field on the **migrated** assistant only, and is offered under Settings from outside with "Move to settings". | An install started from `.env` behaves exactly as before, and "environment wins" stays true. | Ignoring the environment after migration (silent change), or applying it to every assistant (surprising). |
| Admin transport | Assistants and devices use WebSocket requests (`requestId`, answered with `result`) and whole-list pushes, as front ends do today. Each entity is saved whole, with a per-entity `rev` for conflict detection. | Other open admin pages must update live; the mock-up saves a whole draft per page. | An HTTP CRUD API under `/api/` (no push), or field patches (lost updates between two tabs). |
| TypeSafe timing | Asked at the utterance's first `EagerEndOfTurn` (else its `EndOfTurn`). The eager event is held until the answer or the give-up time; the decision is reused at `EndOfTurn` when the canonical text is the same (`sameUtterance`), and asked again otherwise. | With the default pauses (eager 250 ms, final 600 ms) up to about 350 ms of the call overlaps the silence the recogniser waits anyway. That is a hypothesis to measure (WP-14), not a claim. | Asking only at `EndOfTurn`: the whole round trip would be added. |
| TypeSafe client | The existing `makeJevClient` (packages/decide-typesafe/src/JevClient.ts:199), with a routing request (§3.6). No retries; the give-up time is its timeout. | One client, already tested and redacted. | The SDK (10 s default timeout and retries, docs/research/typesafe-jev.md:154). |
| Protocol | Version **7** for this work, which lands before the voice-node protocol; voice nodes rebase to 8 (§5.1). | Voice nodes' admin pages (Device defaults, Devices) are exactly what this redesign replaces; building them twice is waste. | Voice nodes first at 7. |
| Accounts | A fixed set of five accounts: `offline`, `anthropic`, `claude-subscription`, `openrouter`, `home-model`. One of each, set up in Shared settings. | Matches the mock-up (one card per account), and each adapter already reads one key or address. | User-created accounts (two Anthropic keys): no need stated. |

## 2. Data model

All schemas are Effect Schema in a new `packages/protocol/src/assistants.ts` (browser-safe: server, admin and voice
page share the bounds, as `frontends.ts` does today). Types are written as their schemas would read.

### 2.1 Ids and limits

```ts
AssistantId   = String, /^[a-z][a-z0-9-]{0,31}$/   // made from the name at creation ("jeff", "t3", "keuken-2"), never changed; never "typesafe" (device.pick's "whichever fits")
DeviceKind    = FrontendKindId                     // "web-voice" (Browsers); "voice-node" is added by voice nodes (§5.1)
DeviceId      = existing (protocol/frontends.ts:34)
ModuleId      = existing; ToolName = String ≤ 64; FieldKey = existing settings key

MAX_ASSISTANTS            = 16
MAX_ASSIGNMENTS           = 8      // assistants on one device or defaults entry
WAKE_PHRASES_MAX          = 12     // per assignment (unchanged constant, frontends.ts:91)
MAX_PHRASES_PER_DEVICE    = 32     // all assignments together
ASSISTANT_NAME_CHARS      = 32     // unique, case-insensitively, after trimming
PURPOSE_CHARS = 80, HANDLES_CHARS = 240, PROMPT_CHARS = 4000 (as SYSTEM_PROMPT today, sectionDefinitions.ts:264)
MAX_OFF_TOOLS             = 64     // per module choice
MAX_DEVICES               = 64     // unchanged
```

`MAX_ASSISTANTS` bounds the admin lists and the size of a TypeSafe Choice (well below its 255 options). Resources are
bounded by what is distinct, not by this number.

### 2.2 Assistant

```ts
LlmAccountId = Literals(["offline", "anthropic", "claude-subscription", "openrouter", "home-model"])
QuietSpell   = Union([Literal("never"), Int 1..1440])          // minutes without a committed turn

AssistantLlm = Struct({
  account: LlmAccountId,
  model: String 0..100,                 // empty only for "offline"
  effort: Literals(["low", "medium", "high"]),
  thinking: Literals(["off", "adaptive"]),
  maxTokens: Int 64..8192,              // was ANTHROPIC_MAX_TOKENS
  giveUpMs: Int 1000..60000,            // was ANTHROPIC_TIMEOUT_MS
  warmUp: Boolean,                      // was ANTHROPIC_WARM_UP
  useModules: Boolean,                  // claude-subscription only (the agent's `tools` setting)
  freshSessionAfterMinutes: Int 0..1440 // claude-subscription only (its `sessionIdleMinutes`); 0 = never
})

AssistantHearing = Struct({
  engine: Literals(["sherpa", "deepgram"]),
  model: String,                        // a stt-sherpa preset name (presets.ts:150-248); ignored for deepgram
  language: Literals(["auto", "en", "nl", "de", "fr", "es", "it", "pt"]),
  eagerSilenceMs: Int 50..2000, finalSilenceMs: Int 100..3000, minSpeechMs: Int 20..1000,  // final > eager
  agc: Boolean, agcMaxGainDb: Finite 0..40, vadThreshold: Finite 0.05..0.95,               // sherpa only
  deepgram: Struct({ eotThreshold: Finite 0.5..1, eagerEotThreshold: Finite 0..0.9, eotTimeoutMs: Int 500..10000 })
})

ModuleChoice = Struct({
  on: Boolean,
  offTools: Array(ToolName) ≤ 64,                          // tools of this module it may not use
  own: optionalKey(Record(FieldKey, SettingValue))         // own values of `overridable` fields only; absent = shared
})

Assistant = Struct({
  id: AssistantId,
  rev: NonNegativeInt,                  // +1 on every save; a save naming an older rev is refused `stale`
  name: String 1..32, purpose: String ≤ 80, handles: String ≤ 240,
  on: Boolean,
  prompt: String ≤ 4000,
  toolRounds: Int 0..10,
  followUpSeconds: Int 0..120,          // "Keep listening after a reply"; 0 = one answer per phrase
  newConversationAfter: QuietSpell,
  replyEarly: Boolean,                  // "Start replying before I finish speaking"
  confirmActions: Literal("off"),       // "Ask before acting": reserved, shown disabled (mock-up)
  llm: AssistantLlm,
  hearing: AssistantHearing,
  voice: VoiceRefSchema,                // voice-provider protocol/voices.ts:27
  modules: Record(ModuleId, ModuleChoice)   // a module missing here is off
})
```

Validation on save (errors refuse it, warnings ask "Save anyway", as sections do today):

- Errors: the bounds above; a duplicate name; `finalSilenceMs ≤ eagerSilenceMs`; `eagerEotThreshold > 0` and
  `≥ eotThreshold`; an `own` key that is not an `overridable` field of that module, or a value its field refuses; an
  `offTools` name the module does not have; a local voice or model that is not downloaded (as the voice-provider
  design refuses one).
- Warnings: an account that is not set up; a hosted voice provider without a key; Deepgram without a key; an empty
  Handles on an assistant that is on a TypeSafe device.

### 2.3 Devices, device types, assignments

```ts
Assignment = Struct({
  assistant: AssistantId,
  phrases: Array(WakePhrase) 0..12,             // WakePhrase as today (frontends.ts:96)
  followUpSeconds: optionalKey(Int 0..120)      // absent: the assistant's
})

WithoutPhrase = Union([
  Struct({ mode: Literal("nobody") }),
  Struct({ mode: Literal("assistant"), assistant: AssistantId }),
  Struct({ mode: Literal("typesafe"), fallback: NullOr(AssistantId), giveUpMs: Int 100..2000 })  // default 400
])

DeviceSettings = Struct({
  assistants: Array(Assignment) 0..8,           // ordered; the first is the hearer unless withoutPhrase names one
  withoutPhrase: WithoutPhrase,
  matching: WakeMatch,                          // "close" | "exact", unchanged
  voicePage: Struct({ pick: Boolean }),         // web-voice only: "Let people pick the assistant on the device"
  interruptMode: InterruptMode,                 // "instant" | "confirm" | "manual" (UI: instant / after a few words / stop only)
  audio: Struct({ echoCancellation: Boolean, noiseSuppression: Boolean, autoGainControl: Boolean,
                  speakAloud: Boolean,          // new: off = replies shown, never spoken
                  outputPath: OutputPath, prebufferMs: PrebufferMs }),   // the last two web-voice only (advanced)
  captions: Struct({ captions: Boolean, speakTyped: Boolean })          // web-voice only; speakTyped was `speakReplies`
})
DeviceOwn = Partial(DeviceSettings)             // each key present = own value; absent = follows the type defaults

DeviceRecord (stored) = { kind: DeviceKind, name: DeviceName, firstSeen, lastSeen, own: DeviceOwn }
DeviceType (code registry, replaces FRONTEND_KINDS, serve/frontends.ts:44) =
  { kind, title ("Browsers"), one ("browser"), many, description, keys: ReadonlyArray<keyof DeviceSettings>,
    builtIn: DeviceSettings }
```

Every assignment's assistant must exist, appear once in a list and be named by `withoutPhrase` or `fallback` only if
it is in the list. One phrase (after `wakeWords` normalisation) may belong to only one assignment on a device:
`duplicate_phrase` otherwise. A list whose assistants cannot be reached gets a warning: that is an assistant that is
not named by `withoutPhrase`, has no phrase, and the device has no TypeSafe.

### 2.4 Shared settings

These stay env-keyed flat sections (`sectionDefinitions.ts`), the existing machinery: `settings.update`, env lock,
vault for secrets.

| Page (mock-up) | Section and keys |
|---|---|
| Home | new section `home`: `HOME_LOCATION` (text ≤ 200), `HOME_TIME_ZONE` (IANA, empty = this machine's), `HOME_LANGUAGE` (BCP 47: en-GB, en-US, nl-NL, de-DE), `HOME_UNITS` (metric \| imperial), `HOME_DATE_FORMAT` (en-GB \| en-US \| nl-NL) |
| Modules | each module's settings in `modules[id].settings`, through `module.configure` (unchanged message) |
| Language model accounts | `anthropic`: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL · `claude-subscription`: the agent module's optIn, claudePath, proxy, debugLogs · `openrouter`: its module's key · `home-model`: its module's address and key |
| Routing | new section `routing`: `TYPESAFE_API_KEY` (secret), `TYPESAFE_MODEL` (default `jev-1.14.0`, shown pinned), `TYPESAFE_BASE_URL` (advanced) |
| Speech recognition models | DEEPGRAM_API_KEY, DEEPGRAM_MODEL; the Models list (unchanged jobs); STT_SHERPA_MODEL_DIR and THREADS (no field, full reload) |
| Voice providers | as docs/VOICE-PROVIDERS.md §6.1 (keys, favourites) |
| Limits | MAX_VOICE_SESSIONS (1..8), SESSION_DISCARD_MINUTES (1..1440): unchanged keys and bounds |
| Diagnostics | RECORD_HEARD_AUDIO, RECORD_HEARD_AUDIO_MAX_FILES: unchanged |

Home feeds every assistant's stable prompt (one line: location, time zone, language) and the module defaults it is
linked to (§2.6).

### 2.5 Storage

`data/settings.json` version 4. It is written atomically and carries one `revision`, as today
(serve/SettingsStore.ts:96-102):

```jsonc
{ "version": 4, "revision": 41,
  "assistant": { /* flat shared keys: HOME_*, ANTHROPIC_BASE_URL, MAX_VOICE_SESSIONS, … */ },
  "modules": { "weather": { "settings": { "defaultPlace": "", "units": "celsius" } } },   // `enabled` no longer read
  "assistants": { "order": ["jeff", "t3"], "byId": { "jeff": { /* Assistant */ } } },
  "deviceTypes": { "web-voice": { /* DeviceSettings, complete */ } },
  "devices": { "<deviceId>": { "kind": "web-voice", "name": "Desk · Firefox", "firstSeen": 0, "lastSeen": 0, "own": { "interruptMode": "instant" } } },
  "migration": { "from": 3, "at": 1794931200000, "notes": ["…"] } }
```

Secrets are where they are today: flat secrets (ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, TYPESAFE_API_KEY, the provider
keys) and module secrets live in the vault (or `secrets.json` before a vault exists). The assistant and device schemas
contain no secret field, and `own` can only hold `overridable` fields, which exclude `Setting.secret`. Favourites stay
in `data/voice-favourites.json`. Conversations stay in memory, as today.

### 2.6 Resolution rules

**Device settings** (per key of `DeviceSettings`):

1. the device's `own[key]`, if present;
2. else `deviceTypes[kind][key]` (the type defaults, admin-editable);
3. else `DeviceType.builtIn[key]`.

Keys that do not apply to the kind (`voicePage`, `captions`, browser audio fields on a node) are ignored.

**Answering a sentence on a device** (the route; §3.4 runs it):

1. A wake phrase at the start (`matchWakePhrase` over every assignment's phrases, longest wins) → its assistant, with
   the phrase removed. The phrase alone opens that assistant's armed window (`WAKE_ARMED_MS`, 8 s) and forwards
   nothing.
2. Else, an armed window that is open → its assistant.
3. Else, a follow-up window that is open → the assistant that last replied. Its length is the assignment's
   `followUpSeconds`, else the assistant's; 0 means no window.
4. Else `withoutPhrase`: `assistant` → that one; `typesafe` → TypeSafe's choice, else the fallback (§3.6); `nobody` →
   the utterance is dropped (asleep).
5. In steps 1–4, a switched-off assistant is treated as the answer and the utterance is dropped. A phrase of an off
   assistant therefore never reaches another assistant. TypeSafe never offers an off assistant; a fallback that is off
   means nobody.

**Typed text** (`text.send`): the `assistantId` it names (the voice page always names the conversation shown), else
step 3, else the `withoutPhrase` assistant, else the TypeSafe fallback, else the first in the list. Typed text never
calls TypeSafe.

**The device's recogniser** (its *hearer*):

1. `withoutPhrase.mode === "assistant"` → that assistant;
2. else the first assignment;
3. no assignment → no recogniser runs: the session processes no speech, and the voice page says "No assistant on this
   device".

Whether the hearer is switched on does not matter: switching an assistant off must not change how a device hears. The
hearing settings used are the hearer's `hearing`, resolved into a worker key (engine, model, language) and per-stream
options (timing, VAD, gain).

**Module settings for an assistant** (per field):

1. `assistant.modules[m].own[field]`, if present and the field is `overridable`;
2. else the shared `modules[m].settings[field]` (saved or environment, as today);
3. else the module default. For linked fields the default is computed from Home: Weather `defaultPlace` ← "" (the
   module uses `HOME_LOCATION`), Weather `units` ← `HOME_UNITS`, Clock `timeZone` ← `HOME_TIME_ZONE`, Clock `locale` ←
   `HOME_DATE_FORMAT`.

**A module runs** when at least one switched-on assistant has `on: true` for it and its required settings are set. One
instance runs per distinct set of effective settings.

**Follow-up**: the assignment's `followUpSeconds` if set, else `assistant.followUpSeconds`.

**When an assistant is switched off**: its assignments, phrases and conversations stay. It is never routed (rule 5);
it still provides hearing if it is a hearer. Its resources are released if nothing else uses them. Its module
instances stop if no other switched-on assistant needs them.

**When an assistant is deleted**: it is removed from every assignment list (type defaults and device own values).
`withoutPhrase` naming it becomes `nobody`. A TypeSafe `fallback` naming it becomes the first remaining assistant in
that list, or `null` (as the mock-up does). Its conversations end on every device (`endConversation` is called on its
agents), and the delete dialog names the affected devices. Deleting the last assistant is allowed; the Overview then
says nobody answers anywhere.

## 3. Run time

### 3.1 Today

Shared engines are built once per build: `EngineProviders = { llm, stt, tts, voice, maxToolRounds }` (voice-provider
version of serve/Engine.ts:25-38). Each session has one `Conversation` over them (SessionConversation.ts:138-171).
The system prompt and tools are read per turn from the global `SYSTEM_PROMPT` and the module host
(serveMode.ts:251-279). Any provider change is a global reload (Engine.ts:203-206).

### 3.2 Resource pool (replaces the single build)

```ts
// apps/assistant/src/serve/Resources.ts (new)
LlmKey  = account + model + effort + thinking + maxTokens + giveUpMs + warmUp (+ the account's address)
SttKey  = engine + (sherpa: model + language + modelDir + threads | deepgram: model)
TtsKey  = voiceKey(voice)

interface ResourcePool {
  /** Build what `wanted` names and is missing; release what it no longer names (10 s grace, then closed). */
  readonly reconcile: (wanted: Wanted) => Effect<void>
  readonly llm: (key: LlmKey) => Llm["Service"] | undefined        // ready instances only
  readonly stt: (key: SttKey) => Stt["Service"] | undefined
  readonly tts: (key: TtsKey) => Tts["Service"] | undefined
  readonly status: () => ReadonlyArray<ResourceInfo>               // EngineInfo + key, usedBy, state, problem
}
Wanted = from the effective settings:
  llm, tts: the switched-on assistants that are on at least one effective list (a type defaults entry counts)
  stt:      the hearer of every type defaults entry and of every known device
```

- Each resource is built in its own scope with the existing builders: `AnthropicLlm.layerConfig` and the
  offline LLM; `ttsLayerFor(ref)` (voice-provider `voiceSelection.ts:146`); `SherpaStt` / `DeepgramStt`. A
  `ConfigProvider` built from the key's values sits over the environment-and-saved provider, so the adapters stay
  unchanged.
- One build failing is a problem of that resource only: the assistants using it show it, and the others run. The
  engine status lists every resource with `usedBy`, replacing the per-stage list.
- `reconcile` runs at start (every wanted resource is built and warmed before the first turn: latency first), after
  every assistant, device or shared save, and after a vault unlock (which rebuilds failed resources, as today).
- A full reload (all resources rebuilt) remains for STT_SHERPA_MODEL_DIR, STT_SHERPA_THREADS, TTS model directory and
  threads, and the owner's Reload button.
- **Live versus rebuild**:
  - Live at the next turn start: prompt, tool rounds, follow-up, quiet spell, replying early, modules, tools, Handles,
    name, purpose, on/off, routing.
  - Changes that build a resource first, then switch at the next turn start: the LLM fields and the voice.
  - Hearing fields: a changed `SttKey` builds a worker, then the device's stream switches (§3.5). Changed per-stream
    options (timing, VAD, gain) restart the stream only, which costs no model load.
  - Shared account keys and addresses rebuild that account's instances.

`stt-sherpa` change: `makeWithWorker` keeps a process-wide registry of workers by (model, language, modelDir,
threads), with a reference count. `make(options)` reuses one, and each `transcribe` sends its timing, VAD and gain
options in the session-open message. The "no second model beside an orphan" rule (SherpaStt.ts:99-104, :249) stays
per worker key.

**Memory and start-up cost.** Each distinct local speech model is one worker holding the model; its download is
106–564 MB (stt-sherpa presets.ts:30-37), and the resident size is not measured (WP-0 measures it). A Kokoro voice
engine is about 400 MB and takes a few seconds to start (docs/VOICE-PROVIDERS.md §4.3); a Piper voice is one more
child process. Each hosted LLM instance is an HTTP client with its own keep-alive connection, warmed at start when
`warmUp` is on. WP-0 adds a measured `ramMb` and `loadMs` per preset. The UI uses them:

- Hearing tab and device page: "This device then hears with a second speech model: about N MB more memory, M s to
  load." This appears when the change makes a new `SttKey` wanted.
- Shared settings › Speech recognition models: the models in use and their total memory.
- Voice tab: the same for a local voice engine that is not yet running.

### 3.3 One voice session, several conversations

```
                         ┌─────────── per voice session (one device) ───────────┐
WebAudioInput ─▶ Stt(hearer) ─▶ EchoGate ─▶ RouteGate ─▶ Dispatcher ─┬─▶ Conversation(jeff)  ─▶ Tts(jeff's voice)  ─┐
                                   ▲             │       (TypeSafe)  ├─▶ Conversation(t3)    ─▶ Tts(t3's voice)    ─┼─▶ OutputLease ─▶ WebAudioOutput
                                   │             │                   └─▶ … made on first use                        ┘
                    clauses / audible window ◀───┴── replyStarted(assistant) / replyEnded(assistant)
```

- **`SessionConversation` per (session, assistant)** (SessionConversation.ts, mostly unchanged). Each has its own
  history, conversation id and idle clock (`idleResetMs` from `newConversationAfter`: "never" = absent), carried
  across resource switches as today across builds (:109-112). Its LLM is the pool's instance for the assistant's
  `LlmKey`, and its `Tts` the instance for its voice. A Claude subscription assistant uses `makeAgentConversation`
  with the subscription agents (§4.1). A conversation is made the first time something is routed to that assistant
  on that device, so an assistant nobody talks to costs nothing.
- **Dispatcher** (`serve/SessionDispatcher.ts`, new) owns the routing state of one session:
  - **Barge-in owner**: the conversation whose committed turn is running, else none. `SpeechStarted` goes to it at
    once (barge-in as today; the echo gate has already dropped the assistant's own voice), and the dispatcher opens
    an utterance with tentative target = owner.
  - At the first event with text (`Interim`, `EagerEndOfTurn`, `EndOfTurn`) carrying a decided target: if the target
    is the owner, keep forwarding. Otherwise send the owner an empty `EndOfTurn` (closes its utterance, discards its
    speculative turn, starts nothing: ARCHITECTURE.md:84-86) and an `Interrupt` if its turn still runs, then forward
    `SpeechStarted` and the event to the target.
  - A target that changes between eager and final is handled the same way, and costs that speculative turn.
  - Typed text and Stop go to the conversation the message names (Stop: the one playing).
  - Assistants with `replyEarly: false` get no `EagerEndOfTurn` or `TurnResumed`.
  - After a conversation's reply has played, it opens that assistant's follow-up window in the route gate.
- **OutputLease**: every conversation gets the same `AudioOutput` through a wrapper. A `play` that starts while
  another conversation's `play` runs makes the older one fail with `AudioError("superseded")`. The older turn is
  committed with the clauses heard. Each reply declares its own sample rate (`Conversation` plays at
  `tts.sampleRate`, Conversation.ts:1487; the browser gets it in `reply.start`, protocol/server.ts:134), so voices at
  22.05 and 24 kHz need no resampling.
- **Per session, as before**: echo gate (fed the clauses of whichever turn plays), state tracker, publisher (events
  tagged with the assistant), heard-audio tap (the recording names the assistant), turn numbering (one counter per
  session across its conversations).
- **Limits**: `MAX_VOICE_SESSIONS` still counts devices. `SESSION_DISCARD_MINUTES` forgets all of a device's
  conversations. The Claude subscription agent's `maxSessions` (agent-claude-code/src/agent.ts:66, default 4) becomes
  `MAX_VOICE_SESSIONS` × the number of switched-on Claude subscription assistants, still closing the least recently
  used.

### 3.4 Route gate (replaces WakeGate's configuration)

`packages/core/src/RouteGate.ts`, pure, built from `WakeGate.ts` (its matcher, hold/accept states and utterance
contract keeping):

```ts
RouteConfig = {
  phrases: ReadonlyArray<{ phrase: string; assistant: string }>,   // every assignment's, as configured
  match: WakeMatch,
  withoutPhrase: "nobody" | "assistant" | "decide",                // decide = TypeSafe (the dispatcher asks)
  defaultAssistant?: string,                                       // with "assistant"
  off: ReadonlySet<string>,                                        // switched-off assistants
  armedMs?: number                                                 // WAKE_ARMED_MS
}
RouteGate.filter(event, now) → { events, target?: RouteTarget, woke?, heard? }   // as WakeResult, plus target
RouteTarget = { assistant: string; by: "phrase" | "armed" | "follow-up" | "default"; phrase?: string }
            | { by: "decide" }                                     // the dispatcher must ask TypeSafe
            | { by: "dropped"; reason: "asleep" | "off" }
RouteGate.replyStarted(assistant, now) / replyEnded(assistant, followUpMs, now)
```

- With `withoutPhrase: "nobody"` it behaves as today's `wake-phrase` mode: utterances that start asleep are held until
  a phrase or dropped.
- With the other two modes it accepts every utterance, as today's `always` does, but still matches and strips a
  leading phrase and tags the target.
- `wake` and `wake.heard` gain the assistant.
- The "awake" state is per assistant: an open armed or follow-up window names one assistant.
- `wakeConfigFromProfile` (WakeGate.ts:69) is replaced by `routeConfigFrom(deviceSettings, assistants)`. The gate is
  reconfigured only when that part changes, which drops a held utterance, as today (VoiceSession.ts:354-362).
- The offline bench keeps its scenarios and gains two-assistant phrase scenarios.

**What this implies for hearing.** The gate sees a transcript, so the recogniser runs before the assistant is known.
That is why the hearer rule exists. A phrase must be recognisable by the hearer's model and language (for example
"Hé keuken" by an English-only Parakeet). The device page's phrase tester shows what the hearer actually heard.

### 3.5 Hearer changes

The session holds its recogniser stream. When its hearer's `SttKey` or per-stream options change:

1. If the key is new, wait for the pool to have the worker.
2. Wait until no utterance is open (at most 5 s), then close the old `transcribe` stream and open the new one on the
   same `WebAudioInput` stream.

A voice-page pick that changes the hearer follows the same path; the sheet's confirmation says "Used from the next
thing you say" either way.

### 3.6 TypeSafe routing

This runs only for utterances whose route gate target is `{ by: "decide" }`: no phrase, no open window, and the device
is set to TypeSafe.

```ts
// DecisionRequest (core Decision.ts:83-91), sent with makeJevClient({ timeoutMs: giveUpMs, model: TYPESAFE_MODEL })
state: { utterance: "<the eager or final transcript>",
         available_actions: { "<assistantId>": "<Handles, or name + purpose when empty>", … } }  // switched-on assistants of the device, list order
questions: {
  assistant: { type: "choice", instructions: "Which assistant is this sentence meant for?", options: <same ids → Handles>, role: { kind: "action" } },
  fits:      { type: "noul",   instructions: "Is the sentence meant for one of the available assistants?",           role: { kind: "fits" } } }
```

**Decision**: the assistant is chosen when `fits ≥ 0.5` and `probabilities[choice] ≥ 0.5`. Otherwise it is "none fits"
and the fallback answers (`null`: the utterance is dropped). A timeout, error or rejected key also goes to the
fallback. Both thresholds start at 0.5 as constants (`ROUTE_FITS_MIN`, `ROUTE_CHOICE_MIN`), to be tuned from the
traces. With one switched-on assistant, the Noul alone decides.

**Timing**: the call is made at the utterance's first `EagerEndOfTurn` (or at `EndOfTurn` if no eager event came). The
dispatcher holds that event, and the speculative turn starts after the answer. At `EndOfTurn` the decision is reused
when `sameUtterance` holds, and asked again (with a fresh give-up time) when the text changed. Interim captions are not
held. Docs claim about 100–150 ms per call; an independent benchmark measured a median of 247 ms and p95 of 347 ms
(docs/research/typesafe-jev.md:142-143). The default 400 ms give-up is therefore near the tail, which WP-14 measures.

Nothing else is sent: only the sentence and the Handles lines. TypeSafe option order biases the choice
(typesafe-jev.md:77), so the order is the device's list order; the risk is noted in §9.

### 3.7 Diagnostics

- `TurnTrace`'s `Trace` (TurnTrace.ts:23-45) gains `assistant?: string`, `route?: RouteInfo` and `config?: unknown`.
  Marks `routeSent` and `routeReceived` are added to `traceMarks` (:4).
- The per-conversation trace service (as VoiceSession.ts:118-127 makes one per session) fills them at the turn's
  start. The route comes from the dispatcher's record for the utterance that started the turn. The config snapshot
  is taken from the resource keys and assistant fields that conversation actually uses for that turn, not from the
  saved settings.
- `Publisher.traceInfo` (Publisher.ts:56-75) maps them into `TraceInfo` (§5.4). Today it drops `Trace.agent`; that
  field is dropped from `TraceInfo` for good, replaced by `assistant` and `route`.

## 4. What happens to existing concepts

### 4.1 Agents, router and intents (packages/core, agent-*, decide-typesafe, protocol/agents.ts)

- **`makeTriggerRouter`, `RoutingConfig` and its rules** (Routing.ts:19-77, :209): unused by the app (only
  core/testing.ts:221). Removed in WP-16. Device phrases replace trigger phrases, and the follow-up window replaces
  "sticky". The default rules' "hey jeff"/"hey jev" were the same phrases as the device defaults
  (frontends.ts:203).
- **`Router`, `AgentSet`, `makeAgentConversation`, `Agent`** stay as core's mechanism for an agent-backed
  conversation. The app keeps using them only for Claude subscription assistants, with the fixed
  `subscriptionRouter` (subscription.ts:59-65): the agent if running, else the offline stand-in with a notice.
- **`claude-subscription` agent module**: its shared settings (opt-in, program, proxy, debug logs) become the account.
  Its per-assistant settings (`model`, `systemPrompt` → the assistant's prompt, `speculate` → `replyEarly`, `tools` →
  `useModules`, `sessionIdleMinutes` → `freshSessionAfterMinutes`) move to the assistant. Claude Code sessions are
  already keyed by conversation id (ARCHITECTURE.md:142); WP-13 lets a session be opened with that conversation's
  assistant's model and options.
- **Jev intent agent** (`packages/agent-intent`) and **decision providers** (`decide-typesafe`): not wired by this
  design. `makeJevClient` is reused for routing. An intent-only assistant ("commands without a language model") would
  be a sixth account kind later (§9, question 3).
- **`llm-openai-compatible`**: becomes the `openrouter` and `home-model` accounts. Its agent modules
  (agent.ts:325, :334) provide the shared address and key; per-assistant models are Llm instances in the pool (WP-13).
- **`module-home-assistant`**: not in the app's catalog today (apps/assistant/src/modules.ts:125-130, and not a
  dependency). WP-12c adds it. Address and token are shared; `domains` (lights only today) is `overridable`.
- **`protocol/agents.ts`** additions that were never put in the unions (routing.set, turn.agent, TraceAgentFields, …)
  are deleted in WP-16, except `ModuleKind` (used by snapshot.ts:62).

### 4.2 Front-end kinds, profiles, device fields

| Today (protocol/frontends.ts:142-216) | Becomes |
|---|---|
| `FRONTEND_KINDS` kind registry, kind defaults (`frontends`) | `DeviceType` registry with `builtIn`; `deviceTypes` defaults |
| `activation` | `withoutPhrase` (always → the migrated assistant; wake-phrase → nobody) |
| `wakePhrases` | the phrases of the assignment |
| `wakeMatch` | `matching` |
| `followUpSeconds` | assistant `followUpSeconds`, per-assignment override |
| `voice` | retired (already by voice providers); the assistant's voice |
| `conversationIdleMinutes` | assistant `newConversationAfter` |
| `interruptMode` | `interruptMode` (device) |
| `echoCancellation`, `noiseSuppression`, `autoGainControl`, `outputPath`, `prebufferMs` | `audio.*` (device) |
| `speakReplies` | `captions.speakTyped`; new `audio.speakAloud` |
| `captions` | `captions.captions` |
| `DEVICE_EDITABLE_FIELDS` (voice, activation, followUpSeconds) and `device.update` | removed; `device.pick` (§5.3) |

`ProfileOverrides`, `ProfilePatch`, `effectiveProfile`, `DeviceProfile` and `DeviceProfileInfo` are replaced by
`DeviceOwn`, `DeviceSettings`, `effectiveDeviceSettings` and `DeviceSetup` (§5.3).

### 4.3 Global sections that become per assistant

| Section (sectionDefinitions.ts) | Keys | Becomes |
|---|---|---|
| `language-model` (:136) | LLM_PROVIDER, ANTHROPIC_MODEL, _MAX_TOKENS, _EFFORT, _THINKING, _TIMEOUT_MS, _WARM_UP | assistant `llm` |
| | ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL | shared, account `anthropic` |
| `llm-behaviour` (:257) | SYSTEM_PROMPT, MAX_TOOL_ROUNDS, CONVERSATION_IDLE_MINUTES | assistant `prompt`, `toolRounds`, `newConversationAfter` |
| | MAX_VOICE_SESSIONS, SESSION_DISCARD_MINUTES | shared, Limits |
| `stt-engine`, `stt-timing`, `stt-mic`, `stt-deepgram` (:318-490) | STT_PROVIDER, STT_SHERPA_MODEL, _LANGUAGE, the timing, VAD and gain keys, DEEPGRAM_EOT_* | assistant `hearing` |
| | DEEPGRAM_API_KEY, DEEPGRAM_MODEL | shared, Speech recognition models |
| voice-provider `voices` | ASSISTANT_VOICE | assistant `voice` |
| module enable switches | `modules[id].enabled` | assistant `modules[id].on` |

### 4.4 The env-keyed flat store

It stays for shared settings. Keys that became per-assistant are no longer read by the engines. Their saved values
are read once by the migration and then ignored (kept in the file, listed in `migration.notes`). Their environment
values apply to the migrated assistant (§1.2). `envSettings.ts` gets a target kind `assistant-field`, so "Move to
settings" writes the value into that assistant and comments out the line.

The CLI modes (`voice`, `text`, `say`, `bench --live`) use the first switched-on assistant, or `--assistant <id>`, with
the same resolution (`cliSettings.ts`).

## 5. Protocol

### 5.1 Version

`PROTOCOL_VERSION = 7` (`packages/protocol/src/constants.ts:48`, now 6; the voice-provider work keeps 6).

The voice-node design claims 7 for itself (docs/VOICE-NODES.md §2), but its code is at 5: it branches from #3
(93ed0fd), before voice sessions. **Order**: voice providers merge first (no bump), then this design's WP-2 (7). Voice
nodes then rebase onto 7 and take **8**. They add `voice-node` as a `DeviceType` (its `builtIn` follow-up 0 for the
assignment is what "one answer per phrase" means here), their node fields as `DeviceSettings` keys (`audio` input and
output and volume, cues, `micStreaming`), `hello.node`, `node.*` messages and pairing. Their "Device defaults" page and
reserved `agent` field are superseded by this design: the assistant list is that field.

The node client reads `PROTOCOL_VERSION` from `@pva/protocol`, so it follows the bump (VOICE-NODES.md §10).

### 5.2 Admin messages (client → server; all `admin_required` without an admin session)

```ts
AssistantCreate = { type: "assistant.create", requestId,
  assistant: Omit<Assistant, "id" | "rev">,             // the server makes the id from the name
  copyOf?: AssistantId,                                 // the wizard's "Start from"; the body still carries every field
  placements?: Array<{ target: DeviceTarget; phrase?: WakePhrase }>  // wizard step 6: appended to those lists
}  // → result { ok, assistantId } | invalid_settings (fieldErrors) | limit_reached
AssistantSave   = { type: "assistant.save", requestId, assistant: Assistant, saveAnyway?: boolean }
  // whole assistant; rev must equal the stored rev, else `stale` (the page reloads the entity)
AssistantDelete = { type: "assistant.delete", requestId, id: AssistantId, rev }
DeviceTarget    = { kind: "type", type: DeviceKind } | { kind: "device", id: DeviceId }
DeviceSave      = { type: "device.save", requestId, target: DeviceTarget, rev,
  name?: DeviceName,                                    // devices only
  settings: Partial<{ [K in keyof DeviceSettings]: DeviceSettings[K] | null }>,   // null = follow the type defaults (devices only)
  saveAnyway?: boolean }
// unchanged: device.forget, wake.test (deviceId), module.configure (shared module settings), settings.update
// (shared sections), job.*, engine.reload (now the full reload of §3.2)
```

New error codes: `stale`, `duplicate_phrase`, `unknown_assistant`, `limit_reached` (already used by the voice API).
`device.save` on a type checks all keys present; on a device only the keys that apply to its kind.

### 5.3 Voice connection messages (kept minimal)

A voice connection learns its device's setup, never another device's, and never a prompt, model, key or Handles.

```ts
// server → voice (replaces `device.profile`; also in `snapshot.device`)
DeviceSetup = { type: "device.setup", deviceId?,
  assistants: Array<{ id, name, purpose, on: boolean, phrases: string[] }>,   // list order
  withoutPhrase: { mode: "nobody" } | { mode: "assistant", assistant } | { mode: "typesafe", fallback: AssistantId | null },
  canPick: boolean,                     // voicePage.pick, and more than one assistant
  canAuto: boolean,                     // TypeSafe is set up (shows "Whichever fits" in the menu)
  interruptMode, audio: DeviceSettings["audio"], captions: DeviceSettings["captions"] }
// changed
TurnStart       += { assistantId }      // also assistant.text, reply.start: assistantId
Conversation    += { assistantId }      // conversation { id, reason, startedAt, assistantId }
Wake            += { assistantId }
Snapshot.conversations = Array<{ assistantId, id, startedAt, turns: number }>   // replaces snapshot.conversation
Snapshot.history       = the history of the answering assistant (the follow-up holder, else withoutPhrase's, else
                         the first); the others are fetched on demand:
ConversationHistory = { type: "conversation.history", requestId, assistantId, id, history: HistoryItem[] }

// voice → server
TextSend         += { assistantId? }    // the voice page always sends the conversation shown
ConversationNew  += { assistantId? }    // absent: the answering assistant
ConversationRead  = { type: "conversation.read", requestId, assistantId }      // → conversation.history
DevicePick        = { type: "device.pick", requestId, withoutPhrase: AssistantId | "" | "typesafe" }
  // refused `not_allowed` unless canPick (and "typesafe" unless canAuto); writes the device's own `withoutPhrase`
  // (it keeps fallback and giveUpMs from the effective value). Device-wide: every tab and every user of that device.
```

Removed: `device.update`, `device.profile`, `DeviceProfileInfo`.

### 5.4 Admin pushes and snapshot

```ts
Assistants   = { type: "assistants", assistants: AssistantInfo[] }    // whole list, order kept
AssistantInfo = Assistant & { usedOn: Array<{ target: DeviceTarget; hears: boolean; reach: "phrase" | "without-phrase" | "typesafe" | "unreachable" }>,
                              resources: { llm: ResourceState; voice: ResourceState }, problems: string[] }
DeviceTypes  = { type: "device.types", types: Array<{ kind, title, one, many, description, keys, settings: DeviceSettings, rev }> }   // replaces `frontends`
Devices      = { type: "devices", devices: DeviceInfo[] }    // DeviceInfo: own: DeviceOwn, settings (effective), hearer, rev; profile/overrides removed
SessionInfo += { answering?: AssistantId, conversations: Array<{ assistantId, conversationId, turns, lastTurnAt }> }   // conversationId/turns/lastTurnAt (sessions.ts:46-61) move inside
EngineStatus.engines → resources: Array<{ kind: "llm" | "stt" | "tts", key, label, location, usedBy: AssistantId[], state, problem?, ramMb? }>
TraceInfo   += {
  assistant?: { id, name },
  deviceId?, device?: string,           // `session` (the device name) stays for old pages
  route?: { by: "phrase" | "armed", phrase } | { by: "follow-up" | "default" | "typed" }
        | { by: "typesafe", outcome: "chosen" | "none-fits" | "timeout" | "error", probability?: number, fits?: number, ms: number, fallback: boolean },
  marks.routeSent?, marks.routeReceived?,
  config?: { llm: { account, model, effort, thinking, maxTokens }, hearing: { hearer: AssistantId, engine, model?, language?, eagerSilenceMs?, finalSilenceMs?, eotThreshold? },
             voice: VoiceKey, modules: number, tools: number, replyEarly: boolean, toolRounds: number } }
AdminSnapshot: + assistants, deviceTypes; − frontends
```

### 5.5 HTTP

No new endpoints. The voice-provider API (`/api/voices…`) changes as follows. `VoiceEntry.selected` becomes `usedBy:
AssistantId[]`, and `ProviderInfo.inUse` means "used by an assistant". `GET /api/voices/default` returns the first
assistant's voice with `source: "assistant"`, and `PUT /api/voices/default` answers `410 gone` with a message pointing
to the assistant's Voice tab. The picker component already takes only a key and `onChange` (VOICE-PROVIDERS.md §8), so
the Voice tab saves through `assistant.save`.

## 6. Migration

It runs at load when `settings.json` is version 3 (or 2/1, migrated to 3 first as today). The original is kept as
`settings.json.v3-backup`, and version 4 is written at once (the server is the only writer, holding the lock). The CLI
modes migrate in memory only. Voice providers must already be merged: the voice comes from their
`resolveAssistantVoice` (voiceSelection.ts:73).

1. **One assistant** `id: "assistant"`, `name: "Assistant"`, `purpose: ""`, `handles: ""`, `on: true`:
   - `prompt` ← SYSTEM_PROMPT; `toolRounds` ← MAX_TOOL_ROUNDS.
   - `followUpSeconds` ← the web-voice kind default `followUpSeconds`, else 8.
   - `newConversationAfter` ← the kind default `conversationIdleMinutes`, else CONVERSATION_IDLE_MINUTES (0 → "never").
   - `replyEarly` ← true, or, with LLM_PROVIDER=claude-subscription, the agent's `speculate`.
   - `llm` ← LLM_PROVIDER (fake → `offline`) and the ANTHROPIC_* fields. With claude-subscription, the agent's
     `model`, `tools` and `sessionIdleMinutes`, and its `systemPrompt` (when not empty) as `prompt`, with a note.
   - `hearing` ← STT_PROVIDER and the STT_* / DEEPGRAM_EOT_* values.
   - `voice` ← the resolved assistant voice.
   - `modules` ← every module that was enabled (stored, `enabledByDefault`, or `enabledWhenSet` satisfied) `on: true`,
     with no tools off and no own settings.
   - Values come from the effective settings (environment > saved > default).
2. **Browser defaults** (`deviceTypes["web-voice"]`) from the web-voice kind defaults over `DEFAULT_DEVICE_PROFILE`:
   - `assistants: [{ assistant: "assistant", phrases: wakePhrases }]`;
   - `withoutPhrase`: activation `always` → `{ mode: "assistant", assistant: "assistant" }`, `wake-phrase` →
     `{ mode: "nobody" }`;
   - `matching` ← wakeMatch, `interruptMode`, `audio.*`, `captions` ← their fields;
   - `audio.speakAloud: true`, `voicePage.pick: false` (one assistant: nothing to pick).
3. **Each device** record keeps id, kind, name and the seen times. Each override becomes an own value of its section:
   - activation → `withoutPhrase`;
   - wakePhrases → `assistants` (the same single assignment, with its phrases);
   - followUpSeconds → `assistants` with `followUpSeconds` on the assignment;
   - wakeMatch → `matching`;
   - interruptMode, and the audio and caption fields → their sections. An own audio or caption section is filled
     with the device's effective values, so nothing it inherited changes.
4. **Environment**: keys that became per-assistant and are set in the environment lock their field on `assistant`
   (§1.2).
5. The module `enabled` flags stay in the file, unread.

**Behaviour changes and losses**, recorded in `migration.notes` and logged once:

- A device's own `conversationIdleMinutes` is dropped: the reset time is now the assistant's. A device's own `voice`
  was already ignored by voice providers.
- In "always" activation a leading wake phrase is now stripped before the model sees it. Today the gate passes the
  sentence whole in that mode (WakeGate.ts:364-365); "Hey Jeff, what time is it?" now reaches the model as "What time
  is it?".
- A device's own value now covers a whole section (§1.2). One own audio field makes the whole audio section own,
  frozen at its migrated values; later changes to the browser defaults' other audio fields no longer reach that
  device.
- Saved values of the per-assistant keys and the module enable flags remain in the file but are no longer read.

Nothing else changes for a running install: the same model, recogniser, voice, phrases, follow-up, interrupting and
modules answer. With only one assistant, conversations behave exactly as one conversation per device did.

## 7. UI map

### 7.1 Admin (`docs/mockups/assistants/admin.html`)

| Screen | Data | Sends | Web components |
|---|---|---|---|
| Overview: checklist, "Who answers where" grid, voice sessions | `assistants` (usedOn), `devices`, `device.types`, `sessions` | – | OverviewPage reworked; grid new |
| Assistants › All assistants (summary strip) | `assistants` | – | new `AssistantsPage`; strip from `AssistantInfo` |
| Assistant › Basics (name, purpose, Handles, on, duplicate, delete) | `AssistantInfo` | `assistant.save`, `assistant.create` (copyOf), `assistant.delete` | new tabs page; save bar reused (`FieldRow`, draft machinery) |
| Assistant › Behaviour (prompt with "See the full prompt", tool rounds, follow-up, quiet spell, reply early, ask before acting disabled) | assistant, Home section, module instructions (from `module.changed`) | `assistant.save` | new; preset-select control new |
| Assistant › Language model (account cards, model, effort, thinking, limits, Claude subscription block) | assistant, account sections and agent modules (status, model lists) | `assistant.save` | new; radio cards reuse option tags |
| Assistant › Hearing (where used notice, engine, model, language, turn timing, microphone) | assistant, `devices` (hearer), `models`, resources (memory warning) | `assistant.save` | new; replaces the Speech pages |
| Assistant › Voice | assistant, `/api/voices` | `assistant.save` | `VoicePicker` reused as is |
| Assistant › Modules (switch, "n of m tools", own settings, field Reset) | assistant, modules (fields with `overridable`) | `assistant.save` | new; module field renderers reused |
| Assistant › Used on (read-only, "Add to a device…") | `AssistantInfo.usedOn` | `device.save` (from the dialog) | new |
| New assistant wizard (7 steps) | as above | `assistant.create` with `placements` | new |
| Devices › All devices (by type, defaults first) | `devices`, `device.types` | – | `DevicesPages` rewritten |
| Device / defaults page (Assistants here with order, phrases, follow-up override, Answers without a phrase, TypeSafe box, hearer mark and notices; Phrases + tester; On the voice page; Interrupting, Conversation (read-only), Audio, Captions; rename, forget) | `devices`, `device.types`, `assistants`, `wake.heard` | `device.save`, `device.forget`, `wake.test` | `ProfileForm` replaced by a sections form; phrase tester reused |
| Shared › Home, Routing, Limits | sections `home`, `routing`, `llm-behaviour` limits | `settings.update` | generic section pages reused |
| Shared › Modules ("Used by", own-value owners) | modules, `assistants` | `module.configure` | module pages reused, enable switch removed |
| Shared › Language model accounts | sections and agent modules | `settings.update`, `module.configure` | rearranged existing forms |
| Shared › Speech recognition models, Voice providers | `models`, jobs, `/api/voice-providers` | `job.*`, `model.delete`, `settings.update` | Models page and Voice providers page reused; "used by" added |
| Keys & vault, Recordings, Problems, Settings from outside, About | unchanged | unchanged | unchanged (Problems lists resource problems) |
| Diagnostics › Latency (assistant filter, device filter, median per assistant, Routing column, snapshot popover and detail, "changed since") | `trace`, `admin.snapshot.traces`, `assistants` | – | `latency.tsx` extended; columns grow from 7 to 10 |

Removed from the admin web: the Front ends category, `ProfileForm`'s activation and voice groups, the Language model,
Speech recognition and Voices top-level categories (their shared parts move to Shared settings), and the module
enable switches.

### 7.2 Voice page (`docs/mockups/assistants/voice.html`)

| Part | Data | Sends |
|---|---|---|
| Top bar: answering name, or "Auto" or "Jeff · T3"; menu with each assistant's reach, "Whichever fits", "Nobody" | `device.setup`, `turn.start.assistantId`, `wake` | `device.pick` |
| Stage state text ("Say “Hey T3” …", "Speaking · T3") | `device.setup`, state, `turn.start` | – |
| Chat: "Conversation with X" switcher, note on where typed text goes, New conversation with X | `snapshot.conversations`, `conversation.history`, `conversation` | `conversation.read`, `text.send { assistantId }`, `conversation.new { assistantId }` |
| Settings sheet: Assistant (radio list when `canPick`, else static), Microphone, Speaker, More, Admin link; no Voice, no Activation | `device.setup` | `device.pick` |

`VoiceSheet.tsx` loses the Voice and Activation groups. `MessageList.tsx` gets per-assistant conversations. `state.ts`
keeps `conversations` keyed by assistant.

### 7.3 Where this design differs from the mock-ups (the brief, or the code, wins)

1. **Home** has units and date format (brief). The mock-up moved them into Weather and Clock; here those module fields
   default from Home and stay overridable per assistant.
2. **Limits** keep the code's bounds: devices talking at once 1–8 (mock-up 16), forget after 1–1440 min, default 30
   (mock-up 0–1440, default 60). Raising them waits on WP-0's multi-session measurement.
3. **Offline stand-in** stays an account (the mock-up omits it). The default install and the migration need it.
4. **Illustrative content**: the modules T3 Code, Timers, Shopping list and Calendar, Clock's 12/24 h field, Home
   Assistant kinds beyond lights, and the speech-model names and sizes (Moonshine, "Nemotron 3.5") are illustrations,
   not part of this plan. The real lists come from the catalog and `presets.ts`.
5. **Ranges** follow the code where the mock-up differs: "Give up after" 1000–60000 ms (mock-up 30000); Deepgram
   confidences 0.5–1 and 0–0.9 with 0 = off. "Start a fresh Claude session after" uses the mock-up's 0 = never, up to
   1440.
6. **Microphone processing** (gain, VAD) applies to the local engine only; Deepgram assistants do not show it.
7. **Voice tab help** says "Applies from the next reply once the voice has loaded", not "after an engine reload":
   there is no global reload for it (§3.2).
8. **Tools** are stored by name, not index (§1.2).
9. **Open decision (b)** of the mock-up: a pick on the voice page is device-wide, for everyone using that device, and
   persists (the voice mock-up's sheet text and the brief agree).
10. **Open decision (a)** (one recogniser per device) is the owner's fixed decision 4.

## 8. Build plan

Each work package ends with `pnpm check` and `pnpm test` passing, plus the checks listed. "Opus" means the package is
open-ended or subtle; "Sonnet" means it is well defined. **Prerequisites**: voice providers merged to main (needed by
WP-3 onwards). PR #4 is not needed until WP-17.

| WP | Scope | Files | Depends on | Acceptance | Size | Model |
|---|---|---|---|---|---|---|
| **0** Baseline measurements | RSS and load time of every stt-sherpa preset and Piper/Kokoro engine; `bench --sessions 2` for turn-end delay with two talking sessions on one worker | `apps/assistant/src/bench`, `presets.ts` (`ramMb`, `loadMs`), a results table in this doc | – | numbers recorded with method and machine | S | Sonnet |
| **1** Route gate | `RouteGate.ts` from `WakeGate.ts`: targeted phrases, per-assistant armed and follow-up windows, three without-phrase modes, off set, tags | `packages/core/src/RouteGate.ts`, tests, bench scenarios | – | WakeGate's tests ported and passing; new tests: two assistants by phrase, follow-up to the replier, armed, off assistant drops, decide target; offline bench wake scenarios within 1 ms of before | M | Opus |
| **2** Schemas and resolution | §2 schemas, limits, `effectiveDeviceSettings`, `hearerOf`, `routeConfigFrom`, module-settings resolution, validation; protocol 7 messages of §5 (schemas only) and examples | `packages/protocol/src/assistants.ts`, `devices.ts`, `client.ts`, `server.ts`, `snapshot.ts`, `constants.ts`, `examples.ts` | – | schema round-trip tests; resolution tests for every rule in §2.6; examples decode | M | Sonnet |
| **3** Store v4 and migration | SettingsStore v4 (assistants, deviceTypes, devices), saves with per-entity `rev`, v3→v4 migration with backup and notes, env lock binding | `serve/SettingsStore.ts`, new `serve/migrateAssistants.ts`, `cliSettings.ts`, `envSettings.ts` | 2, voice providers | fixture tests: default install, always and wake-phrase kinds, device overrides, claude-subscription, env-locked keys; the read-only load sees one save; a v3 install starts and its first turn uses the same providers (serve test) | M | Opus |
| **4a** Session dispatcher | Dispatcher, output lease, lazy conversations per assistant, barge-in owner and the empty-EndOfTurn hand-over, `replyEarly` filtering | new `serve/SessionDispatcher.ts`, `serve/OutputLease.ts`; `SessionConversation.ts` | 1 | unit tests with scripted Stt and fake conversations: hand-over mid-speculation, barge-in into the other assistant, typed text racing speech, `superseded` commit; no two plays at once | M | Opus |
| **4b** Thin slice | Wire 3+4a into `VoiceSession`/`serveMode`: per-assistant prompt + Home line + module instructions, registry filtered by module and tool, follow-up, quiet spell; **LLM, recogniser and voice still the shared single build** (the first assistant's); traces carry assistant, route and device | `serve/VoiceSession.ts`, `serveMode.ts`, `Publisher.ts`, `core/TurnTrace.ts` (additive fields) | 3, 4a | scripted-client test: two assistants on one device differing in prompt and modules, "hey A …" and "hey B …" answered from separate histories, follow-up stays, phrase alone arms; `trace` carries `assistant` and `route`; offline bench overhead row within 1 ms median of before | M | Opus |
| **5** Server messages | §5.2–5.4 handlers, pushes, access (admin vs voice), `device.pick`, `conversation.read`, delete and off rules of §2.6 | `serve/SessionHub.ts`, new `serve/assistants.ts`, `serve/frontends.ts` → `serve/devices.ts` | 4b | scripted-client tests per message, `stale` and `duplicate_phrase`, a voice connection receives nothing of §5.4 | M | Sonnet |
| **6a** Admin: assistants | list, assistant tabs (Basics, Behaviour, Modules, Used on; Language model, Hearing and Voice with the fields WP-9/11 make live) | `apps/web/src/components/settings/pages/Assistants*`, `lib/state.ts`, mock server | 5 | Playwright against the mock: each tab saves; dirty marks; delete dialog names devices; screenshots | M | Sonnet |
| **6b** Admin: wizard | 7 steps, Start from, Where | same | 6a | Playwright: create blank and copy; placements land on devices | S | Sonnet |
| **7** Admin: devices and overview | devices list, device and defaults page (order, phrases, follow-up override, without-phrase, TypeSafe box, hearer notices, tester), Overview grid, Shared settings pages | `DevicesPages.tsx`, `OverviewPage.tsx`, new sections form; `ProfileForm` removed | 5 | Playwright: section own and reset, pick order changes the hearer mark, unreachable warning, tester lines | M | Sonnet |
| **8** Voice page | top-bar menu, sheet assistant group, chat switcher, typed text and new conversation per assistant | `apps/web/src/app/(voice)`, `VoiceSheet.tsx`, `MessageList.tsx`, `lib/client.ts` | 5 | Playwright: pick changes `withoutPhrase`; switcher reads another conversation without changing who answers | M | Sonnet |
| **9** Resource pool: language models | `Resources.ts` with reconcile, keys, grace, status; per-assistant LLM instances (offline, anthropic); live switch at turn start; Engine reduced to full reload and status | `serve/Resources.ts`, `serve/Engine.ts`, `serveMode.ts`, `providers.ts` | 4b | tests: two assistants with different models answer from their own instance; a model change does not interrupt another device's turn; **TurnTrace**: `llmFirstToken` per instance with and without `warmUp`, `bench --live` with two Anthropic instances vs one | L | Opus |
| **10** Per-assistant voice | one `Tts` per distinct voice in the pool; voice-provider API changes of §5.5 | `Resources.ts`, `serve/VoiceCatalog.ts`, `serve/api.ts`, `serve/AssistantVoice.ts` | 9 | two assistants with Piper and Kokoro speak in turn on one device; **TurnTrace** `ttsFirstAudio` per voice vs single-voice baseline; Kokoro memory recorded | S | Sonnet |
| **11** Per-device recogniser | shared sherpa workers by key with per-stream options; Deepgram per configuration; hearer switching (§3.5); memory warnings from WP-0 data | `packages/stt-sherpa/src/SherpaStt.ts`, `worker.mjs`, `Resources.ts`, `VoiceSession.ts` | 9, 0 | tests: two hearers on one model with different end pauses share one worker; a hearer switch waits for silence; orphan rule per key; **TurnTrace**: end-of-turn → `EagerEndOfTurn`/`EndOfTurn` timing with one vs two loaded models and two talking sessions (`bench --sessions 2`), RSS | L | Opus |
| **12a** Home and linked defaults | `home` section, Home line in prompts, linked module defaults | `sectionDefinitions.ts`, `modules-builtin` | 4b | resolution tests; prompt shows Home | S | Sonnet |
| **12b** Module overrides | `overridable` field flag, instances keyed by effective settings, run rule of §2.6 | `packages/core/src/ModuleHost.ts`, `ModuleDefinition.ts`, `Settings.ts`, `serveMode.ts` | 4b | host tests: two assistants with equal settings share an instance, own date format runs a second, secrets refused as own, grace on stop | L | Opus |
| **12c** Home Assistant in the app | add `module-home-assistant` to the catalog and dependencies | `apps/assistant/src/modules.ts`, `package.json` | 12b | module starts against the mock HA server in tests | S | Sonnet |
| **13a** Claude subscription per assistant | per-conversation model and options in agent-claude-code; account shared settings; `maxSessions` bound | `packages/agent-claude-code`, `subscription.ts` | 9 | two assistants on the account with different models open sessions with their models (fake SDK); **TurnTrace** first token with `freshSessionAfterMinutes` on vs off | M | Opus |
| **13b** OpenAI-compatible accounts | `openrouter` and `home-model` accounts as Llm instances in the pool | `packages/llm-openai-compatible`, `providers.ts`, `Resources.ts` | 9 | adapter tests against the local mock server; **TurnTrace** `llmFirstToken` home model live (owner's server) | M | Sonnet |
| **14** TypeSafe routing | `routing` section; dispatcher's decide path (§3.6) with eager timing, reuse, give-up, fallback; trace marks and route info | `serve/SessionDispatcher.ts`, `sectionDefinitions.ts`, `decide-typesafe` (routing request helper) | 4b, 5 | tests with a scripted decider: chosen, none fits, timeout, error, text changed between eager and final; **TurnTrace**: offline bench with simulated 150/250/400 ms decisions (end of turn → playback, eager on and off), then live `routeReceived − routeSent` over 50 real utterances; stays off by default until the owner has seen the numbers | M | Opus |
| **15** Diagnostics page | latency page columns, filters, medians, snapshot popover, "changed since" | `apps/web/src/components/settings/latency.tsx`, `DiagnosticsPages.tsx` | 4b, 14 (route fields) | Playwright against the mock with traces of all route kinds | S | Sonnet |
| **16** Clean-up and docs | remove `makeTriggerRouter`, `RoutingConfig` rules, unused `agents.ts` additions, `WakeGate` config, `FRONTEND_KINDS`, `device.update`; update ARCHITECTURE.md, FRONTENDS-AND-ACTIVATION.md, VOICE-SESSIONS.md, SETTINGS-UI.md, AGENTS-AND-INTENTS.md | core, protocol, docs | all above | no dead exports (`pnpm check`), docs name the new pieces | S | Sonnet |
| **17** Voice nodes rebase | PR #4 onto protocol 7: `voice-node` DeviceType, node keys, protocol 8 | branch `t3/standalone-triggered-voice-service` | 7, PR #4 | that branch's own plan | M | Opus |

**Parallel tracks** (separate worktrees):

- WP-0, WP-1 and WP-2 at once.
- After WP-4b: WP-5 and WP-9 and WP-12a/12b in parallel.
- After WP-5: WP-6, WP-7 and WP-8 in parallel, against the mock server.
- After WP-9: WP-10, WP-11, WP-13a and WP-13b in parallel.
- WP-14 after WP-5; WP-15 after WP-14.

The UI packages can expose fields whose server half lands later (Hearing before WP-11). Until then the server stores
those fields, and the page says "used from the next start" where they are not yet live.

### Baseline measurements (WP-0)

Measured 2026-11-16 on the development machine: AMD Ryzen 9 7945HX with Radeon Graphics, 16 cores, 16 logical
processors (`/proc/cpuinfo`), 31,789,676 kB = 30.3 GiB RAM (`/proc/meminfo`), Linux 7.0.0-43, Node 22.22.1, sherpa-onnx-node
2.0.1 (recognisers, Kokoro) and 1.13.8 (Piper).

**Method.** `apps/assistant/src/bench/baseline.ts` (`node --import tsx src/bench/baseline.ts --runs 5 --model-dir
<models>`). Each run is a fresh process that calls the real adapter's `make` (`stt-sherpa` or `tts-sherpa`), which
returns when the model is loaded and warmed up. *Added MB* = RSS of the process after minus before (`/proc/<pid>/statm`);
a recogniser is a worker thread of the process, a voice engine is a child process, so its whole RSS is added (it
includes the child's own Node runtime, about 40 MB). *Load ms* = wall-clock time of `make` (worker or child start,
sherpa import, model load, warm-up decodes). Five runs each; the table shows the minimum and the median. The model
files were already in the page cache (they had been read before), so a first start after boot is slower; no turn had
been decoded, and a recogniser's memory grows with the longest turn it decodes. Models that are not installed are not
measured and nothing was downloaded. `ramMb` (median) and `loadMs` (minimum) are recorded in
`packages/stt-sherpa/src/presets.ts`.

**Noise.** Other test suites ran on the machine during the measurements (load average 1.4–6 at the time). Memory was
stable (the five runs of a model differ by at most 4 %, usually under 2 %); load time had one slow outlier per model
(up to +300 ms), so use the minimum, not the mean.

| Item | Added MB min | Added MB median | Load ms min | Load ms median |
|---|---|---|---|---|
| stt `parakeet-v2` | 1024 | 1050 | 1609 | 1657 |
| stt `parakeet-ultra` | 1045 | 1067 | 1632 | 1643 |
| stt `whisper-turbo` | 1613 | 1640 | 2621 | 2671 |
| stt `hybrid-nemotron-parakeet` | 1668 | 1683 | 2443 | 2477 |
| stt `nemotron-560` | 940 | 948 | 1178 | 1207 |
| stt `nemotron-320` | 946 | 964 | 1240 | 1289 |
| stt `zipformer-en` | 166 | 167 | 1308 | 1375 |
| stt `fast-conformer-en` | 248 | 250 | 745 | 759 |
| voice Piper `en_US-lessac-medium` | 163 | 163 | 473 | 481 |
| voice Piper `nl_NL-pim-medium` | 169 | 169 | 722 | 730 |
| voice Kokoro `kokoro-af_heart` (one engine serves all Kokoro speakers) | 563 | 563 | 1099 | 1124 |

Not measured (not installed): none of the recogniser presets or the three voice engines above were missing. Other
Piper voices and Kokoro speakers were not measured (a Piper voice differs by model size; every Kokoro speaker shares
the one engine).

**Two talking sessions on one recogniser worker.** `bench --live --rounds 2 --sessions N` with `parakeet-v2`, the
Piper voice `en_US-lessac-medium`, the stand-in LLM (first token 250 ms, 60 tokens/s) and the five clips of
`bench-audio` (10 turns per session); sessions play the clips rotated by one, and their user audio ends at the same
moment. Three runs each, medians of the 10 turns per session, ms from the end of the user's audio:

| Sessions | EagerEndOfTurn | EndOfTurn | playback start |
|---|---|---|---|
| 1 | 397 / 406 / 427 | 660 / 651 / 680 | 704 / 716 / 730 |
| 2 (session 1) | 404 / 440 / 422 | 660 / 661 / 641 | 722 / 759 / 744 |
| 2 (session 2) | 479 / 424 / 425 | 661 / 650 / 652 | 789 / 768 / 772 |

With two sessions the end-of-turn time does not change, the eager time and the playback start grow by about 10–60 ms
(the other session's decode queues ahead of yours) and the spread between runs is of the same size, so this is an
indication, not a precise cost. Only one pair of simultaneous sessions was measured, with ~1 s clips; more sessions,
longer turns and a second loaded model are WP-11's measurement.

## 9. Risks and open questions

**Risks**

| Risk | Recommendation |
|---|---|
| Two local speech models can exhaust memory on the server (each possibly about 1 GB). | Show the measured cost before saving (§3.2). Leave every device on one hearer model unless the owner chooses otherwise; warn above 75 % of free memory at save. |
| Shared-worker decode queues: a talkative device delays another's turn ends (VOICE-NODES.md §6). | WP-0 and WP-11 measure it; per-model workers already separate different models. |
| TypeSafe adds a round trip of about 250 ms median to sentences without a phrase. | Ask at the eager point; default off; give-up 400 ms; per-turn Routing column; tune the thresholds from traces. |
| TypeSafe's choice order bias. | Keep list order (the owner controls it); later, ask twice with reversed order only if traces show bias. |
| A hearer switch from a voice-page pick loads a model while people talk. | The new worker is built before the switch; the sheet already says "from the next thing you say". |
| Each assistant on a Claude subscription device conversation opens a Claude Code process. | `maxSessions` bound (§3.3); measure process memory in WP-13a. |
| "Never" conversations still drop old turns at the fixed history limits (32 turns, 48 000 characters, ARCHITECTURE.md:142). | Say so in the help (the mock-up does); compaction is future work, not part of this. |
| Tools stored as "off" names: a module update's new side-effecting tool is on for every assistant using that module. | Modules mark new tools `defaultOff` when they change behaviour; the Modules tab shows "new" on tools added since the last save. |

**Open questions** (each with the recommended answer)

1. Should switching an assistant off also free its hearing role (another assistant's model takes over)? **No**:
   hearing follows the list as configured, so switching off never changes how a device hears.
2. Should a phrase of a switched-off assistant fall through to the default assistant? **No**: drop it, so a command
   meant for one assistant never reaches another.
3. Where does the Jev intent agent go? **Later, as a sixth account kind "Commands only (Jev)"**. Routing by TypeSafe
   here does not need it.
4. Should the voice page's pick be per visit rather than device-wide? **Device-wide**, as the mock-up's sheet text
   says; the admin toggle limits who can do it.
5. Raise devices talking at once to 16 as the mock-up shows? **Not before WP-0's** multi-session numbers.
6. Can typed text on a TypeSafe device be routed by TypeSafe? **No**: the voice page always names the conversation
   shown.

## Status

Design only; nothing built (2026-11-16).

### WP-4b thin slice: built 2026-11-16

The store (v4) and the dispatcher are wired into `VoiceSession` / `serveMode`. A device's effective settings
(`effectiveDeviceSettings`: own sections ← type defaults ← built-in; a session without a device uses the browser
defaults) give the route gate its config (`routeConfigFrom`), re-applied by `syncProfile` whenever the hub refreshes
profiles. Per session: one recogniser stream per build (its own `SessionLoop`), echo gate → route gate → dispatcher →
one `SessionConversation` per assistant (made on first use, fed through an inbox, its `speech` seam), all playing
through one `OutputLease` over the session's `WebAudio` output, one turn counter for all of them. Per assistant: prompt
+ the instructions of its modules + a registry of its tools (`ModuleSnapshot.parts`, new and additive; capability
modules only, agent and decision modules always pass; the snapshot's own registry is reused when nothing is left out),
follow-up (assignment, else assistant), quiet spell (`newConversationAfter`), `replyEarly` (dispatcher) and
`toolRounds` (read at each build). The language model, recogniser and voice stay the one shared build.

- Traces: `Trace` gains `assistant`, `deviceId`, `device`, `route`, `config` and marks `routeSent`/`routeReceived`;
  `Publisher.traceInfo` maps the first four into `TraceInfo` (the device's own `turn.end` carries no `device`,
  `deviceId` or `session`). `turn.start`, `assistant.text`, `reply.start` (audio-web, from the turn's trace),
  `wake` and `conversation` carry `assistantId`.
- Routes as traced: phrase, armed (with the phrase that armed it), follow-up, default, typed. Until WP-14 a `decide`
  utterance (TypeSafe device) is answered by the fallback and traced as `default`; a turn whose utterance reached its
  conversation only as the barge-in owner is traced as `follow-up`. `config` is not filled yet (the resources it
  describes arrive with WP-9).
- Home line: a seam in `serveMode` (`homeLine`, no line until WP-12a adds the `home` section).
- Typed text follows §2.6 (`typedTextTarget`); a device with no reachable assistant answers `bad_message`.
  `conversation.new` takes `assistantId`. Snapshot history and conversation are the answering assistant's (§5.3).
- Not yet: a device without assignments still runs its recogniser (everything is dropped by the gate) instead of none
  (WP-11); heard-audio recordings do not name the assistant; the dispatcher's books are not reset at a reload (an
  utterance left open is closed with an empty final at the next build's start, and inboxes are emptied).
- Tests: `serveAssistants.test.ts` (two assistants on one device: phrase, follow-up, armed, separate histories,
  prompts and tools, traces; typed text and `conversation.new` per assistant); `bench.test.ts` session-path
  scenario. Changed: `serveFrontends.test.ts` (`wake` carries `assistantId`; in `always` mode a leading phrase is
  stripped), `sessionHub.test.ts` (fake session's `sendText`/`stop`).
- Bench (offline, `pnpm start bench`, 3 runs before and after on this machine, load 0.1–4.8; median / worst ms):
  orchestration overhead 0.9 / 1.5, 0.8 / 1.5, 0.9 / 1.6 → 0.9 / 1.7, 0.9 / 1.5, 0.9 / 1.6. New rows, session path
  (route gate, dispatcher, inbox, lease): overhead 0.8 / 1.2, 0.8 / 1.1, 0.8 / 1.0; realistic eager on with three
  assistants 308 / 534, 307 / 533, 307 / 534 (direct route-gate row 307 / 535, 305 / 535, 307 / 534).
- Evidence: `docs/assistants-evidence/thin-slice-transcript.txt` (real server, local recogniser and voice, offline LLM).

### WP-5 server messages: built 2026-11-16

`serve/assistants.ts` (new) holds the handlers and the data of the pushes; `serve/devices.ts` (new) the pure device-type and device views of the v4 file; `SessionHub` does access and fan-out. `frontends.ts` is **not** replaced yet: it still serves the protocol 5 messages that stay until the UI packages (WP-6 to WP-8) drop them. Protocol is 7.

Messages (client → server): `assistant.create`, `assistant.save`, `assistant.delete`, `device.save` (admin only, `admin_required` otherwise); `device.pick`, `conversation.read` (voice connections only, `bad_message` from an admin connection or a page without a device). Server → client: `assistants`, `device.types` (admin connections only, never a voice connection), `device.setup` (the voice connection of that device only, sent when it changes), `conversation.history` (the requester only), `devices` (admin only, as before), `result` (with `assistantId` after `assistant.create`).

Deviations from §5:

- **Tag collisions.** `devices` and `result` are one tag each, extended compatibly: `devices` entries are `DeviceListInfo` (the protocol 5 `DeviceInfo` plus `own`, `settings`, `hearer`, `rev`), and `result.assistantId` is an optional field. No temporary tag exists. Clean-up (WP-16): drop `profile`/`overrides` from `DeviceListInfo`. The error codes are in the one `ErrorCode` list. `frontends`, `device.profile`, `device.update`, `frontend.update`, `device.admin.update` stay.
- `FieldError.key` accepts dotted paths (`hearing.finalSilenceMs`).
- `assistants`/`device.types` are pushed as whole lists after any successful assistant, device or protocol 5 front-end save (not after shared-settings saves).
- Validation errors are `invalid_settings` with `fieldErrors`; a "cannot be reached" warning asks for `saveAnyway`; `duplicate_phrase`, `unknown_assistant`, `limit_reached` are the code when validation finds that case. `assistant.save` on an unknown id is `unknown_assistant` before validation; a missing device or type is `unknown_device`.
- `usedOn[].hears` and `resources` in `assistants` are coarse: `resources` is the engine's state (`unused` when the assistant is off or on no device) until the resource pool (WP-9) lands.
- `canAuto` is "a decision provider module is running" until WP-14 adds the `routing` section.
- No module field is `overridable` yet (WP-12b), so any `own` value on a module choice is refused.
- Saving through the new messages refreshes live sessions' route configuration through `refreshProfiles` (no reload); LLM, recogniser and voice stay the shared build until WP-9/10/11.
- Deleting an assistant ends its conversations by `stop` plus `newConversation` on each live session that has one (the conversation of a deleted assistant is no longer reachable).
