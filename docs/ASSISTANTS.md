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

**Typed text** (`text.send`): the `assistantId` it names if that assistant is assigned to this device (the voice page always names the
conversation shown; a name not assigned here is ignored), else
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
  on that device, so an assistant nobody talks to costs nothing. The kind (agents or one model) follows the pool's
  binding in use, not the saved account: when a published binding changes it, that one conversation's loop restarts
  with the other kind as on an engine rebuild (the turn in flight is dropped; history, id and idle clock are kept),
  and the agents the ended loop used are told that the conversation ended (`endConversation`).
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
State           += { holder?: AssistantId | null }   // who has the turn: the turn in flight or the utterance being
                                        // heard, else an open armed / follow-up window, else null (nobody); sent again
                                        // with the same state when only it changes. The page shows it, never guesses.
                                        // An accepted device.pick closes the windows (the picked one answers next).
Snapshot.conversations = Array<{ assistantId, id, startedAt, turns: number }>   // replaces snapshot.conversation
Snapshot.history       = the history of the answering assistant (the follow-up holder, else withoutPhrase's, else
                         the first); the others are fetched on demand:
Snapshot.answering     = that assistant (the page files `history` under it)
Snapshot.holder        = who has the turn now, as State.holder (may be an armed assistant whose history it is not)
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

### WP-9 resource pool, language models: built 2026-11-16

`serve/Resources.ts` holds the language models; the recogniser and the voice are still the engine's one shared build
(WP-10, WP-11), so `Engine.ts` is the full reload of those two plus the status, which gains `resources`.

- **Keys.** `llmKeyOf` = account + model + effort + thinking + maxTokens + giveUpMs + warmUp + the address with its
  user info and query removed. The instance's identity adds the full address and a stamp of the account's key (the
  first 16 hex digits of its SHA-256; never shown, never the key), so a changed key or address builds new instances.
  The offline accounts (`offline`, and `claude-subscription`'s stand-in) ignore the model fields: every assistant on
  them shares one instance.
- **Builders.** `providers.ts` `llmAccountLayers`: `offline` and the `claude-subscription` stand-in are the offline LLM;
  `anthropic` is `AnthropicLlm.make` over a `ConfigProvider` with the assistant's fields on top of the shared settings
  (so the key comes from the vault or the environment as before), with `awaitWarmUp` (new, additive option of
  `llm-anthropic`): the instance is ready only once its warm-up request has ended, so "ready" means "warm". `openrouter`
  and `home-model` have no layer yet: their resource is `failed` with "The … account is not available yet." (WP-13b
  adds them in `llmAccountLayers`). The Claude subscription agent itself is still the module's (WP-13a).
- **Wanted** = every switched-on assistant on at least one effective list (each device type's defaults and each
  known device's own list). `reconcile` runs at start (awaited by `ServeHandle.ready`, so every wanted instance is
  built and warm before the first turn), after every successful settings-store save (`save…`, `create…`, `delete…`,
  `import…`, which also covers WP-5's handlers), and after a vault lock or unlock (an unlock retries failed
  instances); a turn of an assistant that is not bound yet reconciles at once and waits for its instance.
- **Switching.** Each turn reads its assistant's instance once, at its start (`TurnSetup.llm`, the one additive seam
  in core, see ARCHITECTURE.md), and keeps it for every round of its tool loop. A changed configuration builds the
  new instance while the assistant stays bound to the old one; once the new one is ready the assistant is rebound,
  and its next turn start uses it. Nothing else is stopped: no engine reload, no other session or assistant touched.
- **Release.** An instance nobody is bound to or wants is `unused` and is closed 10 s later (`RESOURCE_GRACE_MS`),
  and not before the last stream running on it has ended; wanted again within the grace, it is kept. A failed or
  never-ready instance is dropped at once.
- **Failure.** A build failure is that resource's `state: "failed"` with its `problem` (a key that "is not set" while
  the vault is locked is reworded as the locked-keys message). Its assistants' turns fail with that problem (logged;
  the device gets `turn_failed`), every other assistant answers. A warm-up that fails (a wrong key) does not fail the
  build, as before: the first turn then fails.
- **Full reload.** The owner's reload (and the reloads for model directories and threads) also rebuilds every
  instance in use, in the background: each assistant switches when its new instance is ready, and the reload does
  not wait for it.
- **Status.** `EngineStatus.resources` lists every instance (`kind: "llm"`, key, label, location, `usedBy`, state,
  problem). While a changed instance is built both the old (still `usedBy` the assistant) and the new are listed. The
  `engines` list keeps one `llm` row for pages before WP-6: the first switched-on assistant's account and model.
- **Not yet.** The Provider page's flat keys (`LLM_PROVIDER`, `ANTHROPIC_MODEL`, …) are no longer read by serve mode
  (§4.4): after migration only the assistant's `llm` (and the environment's locks) count, and changing a model in the
  UI waits for the assistant pages (WP-5/WP-6); the page still marks them "reload". The CLI modes still use the flat
  keys (§4.4's `--assistant` is not built). `TurnTrace`'s `config` snapshot is still not filled.
- **Tests.** `test/resources.test.ts` (sharing, a change with a turn in flight, grace, failure and retry, rebuild, keys,
  a key stamp change, the default builder), `test/serveResources.test.ts` (scripted client: two assistants answer from
  their own instances and share one when equal; a model change on Alpha while turns of Bravo on another device and of
  Alpha itself are in progress: both complete on their old instances, Alpha's next turns on either device use the new
  one, no engine reload; a failed instance in the status, `turn_failed`, the other assistant answers),
  `packages/core/test/TurnSetupLlm.test.ts` (a model published mid-turn applies from the next turn; absent = the
  conversation's), `llm-anthropic` warm-up tests (`awaitWarmUp`).
- **Bench.** `bench --live --llm-per-session` gives each session its own language-model instance (as two assistants
  with different settings), to compare with the shared one.
- **Measurements** (this machine, 2026-11-16, load 0.8–2.2). Offline bench (`pnpm start bench`), three runs each of
  82f2d02 (a detached worktree) and this package, alternated; end of turn → playback start, median / worst ms.
  Orchestration overhead: 1.1 / 1.9, 0.9 / 1.8, 1.0 / 2.2 → 0.9 / 3.4, 0.9 / 2.2, 0.9 / 1.5; session path overhead
  0.7 / 1.3, 1.2 / 2.0, 0.8 / 1.2 → 0.8 / 1.4, 0.9 / 1.4, 0.8 / 1.2; every realistic row unchanged within 2 ms
  (eager off 507–509 / 734–738, eager on 306–309 / 533–537). The offline bench builds `Conversation.layer`, not the
  setup path, so the setup path was measured apart: 3000 text turns through `Conversation.layerWithSetup` with an
  instant `Llm`, the first 500 dropped, `TurnTrace` `llmRequestSent` − turn start, median: 27, 27, 28 µs at 82f2d02;
  28, 27, 29 µs now without `TurnSetup.llm`; 22–24 µs with a fixed or a per-turn-changing `TurnSetup.llm` (run after
  the first mode in the same process, so warmer). No measurable cost.
- **Not measured (no Anthropic key on this machine).** `llmFirstToken` of a freshly built Anthropic instance with and
  without warm-up, and two Anthropic instances against one. With a key (`ANTHROPIC_API_KEY`, or the vault with
  `PVA_VAULT_PASSWORD`), each run a fresh process whose first row is a fresh instance:
  `LLM_PROVIDER=anthropic ANTHROPIC_WARM_UP=false pnpm start bench --live --rounds 3 bench-audio` against
  `ANTHROPIC_WARM_UP=true` (five runs each, compare the first row's "1st token"), and
  `LLM_PROVIDER=anthropic pnpm start bench --live --rounds 2 --sessions 2 bench-audio` against the same with
  `--llm-per-session`.

### WP-10 per-assistant voice: built 2026-11-16

`serve/Resources.ts` now also holds the voices; `Engine.ts` is the full reload of the recogniser only (plus the status).

- **Keys.** `TtsKey` = `voiceKey(assistant.voice)` (`provider:voiceId`); the instance's identity adds a stamp of the
  hosted provider's key (first 16 hex digits of its SHA-256, never shown), so a new Cartesia or ElevenLabs key builds
  a new instance. Two assistants with the same voice share one instance. The status lists every instance as
  `kind: "tts"` (key, label "Voice Piper …", location, `usedBy`, state, problem).
- **What shares an engine.** A voice on this machine runs on an engine (a child process holding the model).
  `defaultTtsBuilder` keeps one engine per `SherpaTts.engineSetup(preset)` plus the engine options (model directory,
  threads, speed, joining), counted by the voice instances on it and stopped with the last one: every Kokoro speaker
  shares one engine (one more speaker costs no memory and no load), a Piper voice is an engine of its own. A hosted
  voice (Cartesia, ElevenLabs) is that provider's layer over `configProvider()` with the voice id on top, as before.
  A failed engine start is not kept: the next instance that wants one starts a new engine.
- **How a turn picks its voice.** `TurnSetup.tts` (new, optional, additive; the exact analogue of `TurnSetup.llm`,
  ARCHITECTURE.md): read from the turn's plan when its body starts, for every clause of every round, and its
  `sampleRate` is the one the reply plays at (so 22.05 and 24 kHz voices need no resampling). A `Say` reads the setup
  when it starts, so a canned reply uses the assistant's voice. The serve setup waits for a voice that is still being
  built (its rate is read at play time) and tags the turn's trace (`Trace.voices`) from the pool's wrapper.
- **A changed voice** builds the new instance first; the assistant stays bound to the old one until the new one is
  ready, then its next turn start takes it. Turns speaking on the old voice, on any device, finish on it (the instance
  is not closed while a stream runs on it); nothing is reloaded and no other assistant or device is touched. The old
  voice is released after the 10 s grace period unless someone wants it again. A voice nobody is bound to or wants is
  `unused` and released the same way; a failed or never-ready one at once.
- **Failure.** A voice that cannot start (model files missing, key not set, locked vault) is a failed resource with its
  problem; its assistants' turns fail at the first synthesis with that problem (the device gets `turn_failed`, the
  text of the reply is not spoken), every other assistant speaks. A vault unlock and the owner's reload build failed
  voices again (`retryFailed`, `rebuild`).
- **Status and API (§5.5).** The engine list's `tts` rows and `voices` come from the voices in use (the Models page
  marks their presets in use). `VoiceEntry.selected` is now `usedBy: AssistantId[]` (every assistant, switched on or
  not), `ProviderInfo.inUse` means "an assistant uses a voice of it", `GET /api/voices/default` answers with the first
  switched-on assistant's voice (`source: "assistant"`, `locked: false`, `running` when its instance is ready,
  `reloadPending: false`), `PUT /api/voices/default` answers `410 gone` pointing to the assistant's Voice tab,
  `VoicesResponse.selected` stays (the same first voice). The preview of a voice the pool runs reuses its instance.
  `apps/web`: only `mock/server.ts` and `test/voicePicker.test.ts` changed (`selected` → `usedBy`) to compile.
- **Deviations.** (1) Voices share a reconcile call with the language models (`ReconcileOptions.voices`; the pool's
  generic `makeKind` serves both), not a separate method. (2) The `ASSISTANT_VOICE` setting and its Voices-page field
  still exist in the store and sections but nothing in serve mode reads them any more (the migration copied them into
  the assistant); the old Voice page of the web UI therefore no longer changes what is spoken until WP-6a. (3) A
  Kokoro engine runs one clause at a time, so two assistants speaking at the same moment on it take turns clause by
  clause (measured below); the doc's one-engine rule was kept. (4) `EngineProviders.tts`/`.voice` stay, optional, for
  tests that inject one voice (the pool then hands out instances that speak with it).
- **Tests.** `test/resourcesVoices.test.ts` (keys and sharing, a change with a stream in flight, grace and re-want,
  failure and retry, key stamp and rebuild, engine sharing with a counted fake engine, a failing engine start),
  `test/serveVoicesPerAssistant.test.ts` (scripted client: two assistants with different voices speak in turn on one
  device with their own voice and rate, the trace's `voices`; equal voices share one; a change on Alpha while Bravo's
  turn and Alpha's own turn are held mid-reply, both complete on their old voices and Alpha's next turns on either
  device use the new one, no engine reload; a failing voice in the status, `turn_failed`, the other assistant speaks),
  `packages/core/test/TurnSetupTts.test.ts` (per-turn voice and rate, a voice published between turns, a `Say`, absent =
  the loop's), the voice API tests of `serveVoices.test.ts`.
- **Measurements** (2026-11-16, same machine and software as WP-0). `src/bench/voices.ts` (new): the real
  `defaultTtsBuilder` and the real engines in the pool, one assistant per voice, each with its own `Conversation`
  (`TurnSetup.tts`), an instant stand-in language model, spoken text turns (the same 3-sentence reply for every voice)
  and an output that takes everything at once; the figure is `ttsFirstAudio − firstClause` from `TurnTrace` (the
  engine's time to first audio for the first clause, "Good morning."), median over 11 turns (the first turn of a voice
  dropped). Command: `node --import tsx src/bench/voices.ts --voices piper,kokoro --mode sequential --turns 12
  --model-dir <models>`; each run is a fresh process; `sequential` alternates the voices one turn at a time,
  `concurrent` starts every assistant's turn at the same moment. **Machine load was not quiet**: other work ran on the
  machine (load average 2 at the start, 9–14 for the second table; 16 logical processors), so use the comparison within
  a table, not the absolute figures.
  - First pass, one run per row group of 3, load rising 1.8 → 11 over the pass (so later rows ran under more load):
    Piper alone 22.6 / 22.3 / 22.7 ms, Kokoro alone 185.6 / 182.4 / 187.1 ms, Piper+Kokoro 26.0 / 26.5 / 27.1 (Piper) and
    195.8 / 197.3 / 203.3 (Kokoro), Piper+Kokoro concurrent 34.8 / 35.1 / 29.4 and 239.4 / 237.0 / 222.8, Piper+Dutch+Kokoro
    25.5–28.0, 36.9–39.4 (Dutch) and 183.5–200.7.
  - Second pass, alternating the configurations in each of 5 rounds to cancel drift (load 8.7–14), median of the 5 run
    medians (each in brackets): Piper alone **22.9** ms [38.9, 23.4, 22.7, 22.9, 22.2]; Piper with Kokoro loaded
    **28.1** [28.4, 28.1, 28.1, 27.0, 26.6] (+5 ms); Kokoro alone **190.2** [178.7, 204.0, 190.2, 199.7, 189.7]; Kokoro
    with Piper loaded **197.3** [195.7, 209.8, 185.7, 203.5, 197.3] (+7 ms). With both loaded and turns alternating, a
    voice is about 5 ms (Piper, +20 %) and 7–10 ms (Kokoro, +4 %) slower than alone; I did not isolate the cause (an
    idle engine process between turns is the likely one) and the Kokoro difference is inside its run-to-run spread.
  - Both speaking at once (`concurrent`, separate engines): Piper 29–35 ms, Kokoro 223–239 ms, i.e. +7–12 ms and
    +35–50 ms over the sequential figures. Two Kokoro speakers on the one shared engine: sequential 182–199 ms (heart)
    and 193–213 ms (bella), the same as one speaker; **concurrent: the first speaker 179–192 ms, the second 1159–1276 ms**,
    because the engine synthesises one clause at a time and the second assistant's first clause waits behind the
    first's whole reply (about 1.1 s). Two assistants on Kokoro that talk at the same moment therefore queue; two
    Kokoro engines would avoid it for about 560 MB more.
  - **Memory** (added MB = this process's RSS after the load minus before, plus the engine child processes' RSS, as
    WP-0): Piper alone 162, Kokoro alone 563 (WP-0: 163 and 563); Piper + Kokoro 724–727 (sum of WP-0: 726); Piper + Dutch
    Piper + Kokoro 888–893 (WP-0: 163 + 169 + 563 = 895); Kokoro heart + bella (one engine) **563–565**, i.e. a second
    Kokoro speaker costs nothing. Load time with the voices loaded in parallel: Piper 0.50 s, Kokoro 1.1–1.2 s, both
    1.1–1.4 s.
- **Not verified.** The web admin pages (WP-6a) do not save a voice yet, so a voice change was exercised through the
  settings store, not a browser. Hosted voices (Cartesia, ElevenLabs) were tested with fake builders only: no keys on
  this machine, so `ttsFirstAudio` of a hosted voice is not measured. The preview that starts a second Kokoro engine for
  a speaker the pool does not run (the pool's engine is not shared with previews) is unchanged. `ramMb` in the status is
  not filled for voices.

### WP-6b wizard and WP-7 devices, overview, shared settings: built 2026-11-16

`apps/web` only (and its mock server). Paths: `#settings/assistants/new/<1..7>` (the wizard), `#settings/devices` (list),
`#settings/devices/<deviceId>` and `#settings/devices/type-<kind>` (a device, a type's defaults), `#settings/overview`
(grid), `#settings/shared/<home|modules|accounts|routing|speech|providers|limits>`.

- **Wizard** (`NewAssistantWizard.tsx`): the mock-up's seven steps (Start, Language model, Hearing, Voice, Modules, Where,
  Check); it reuses the assistant tabs' fields through a local `AssistantDraft` (`useWizardDraft`). Nothing is sent before
  "Create assistant": `assistant.create` with `copyOf` and `placements`. A refusal goes back to the step that owns the
  field. The step is the third path part, so the settings screen's "Leave without saving?" guard covers it.
- **Devices**: `DevicesPages.tsx` (list, device page, defaults page), `devices/AssignSection.tsx`, `lib/devices.ts` (a
  draft of edits over what is saved: per section "Own value · Reset"; the list and "Answers without a phrase" are one
  section made of two keys). Saves are `device.save`; a `warnings` outcome opens a "Save anyway?" dialog. TypeSafe is
  listed and disabled ("which is not set up") while no decision module runs: the admin reads the server's `canAuto` as
  "a module of kind `decider` is running" (the same rule the server uses), since `canAuto` is only sent to voice pages.
- **Overview**: "Who answers where" grid (a list on a phone); the checklist names the assistants and accounts.
- **Shared settings**: the tree regroups the server's `agents`, `speech`, `voices` and `modules` pages by key
  (`settingsTree.ts`: `ASSISTANT_OWNED_KEYS`, `SHARED_PAGES`). The keys that moved onto the assistant are not shown; what
  remains (Anthropic key and address, Deepgram key, voice provider keys, the two limits, the modules, the model lists) is
  on Language model accounts, Speech recognition models, Voice providers, Limits and Modules. Home and Routing appear when
  the server sends a `home` or `routing` section (Routing also when a decision module exists).
- **Removed**: Front ends, `ProfileForm`, the old device page and the Language model, Speech recognition and Voices
  categories. The module switches stay on the Modules page (the server still reads them until WP-12b).
- **Not built**: Add as phrase on the tester's ignored lines (a heard phrase belongs to an assistant: pick on the device
  page), the memory warning on the hearing notice (needs WP-11 data), per-module "own values" markers on Modules.

### WP-11 per-device recogniser: built 2026-11-16

`serve/Resources.ts` now also holds the recognisers; `Engine.ts` holds no provider any more: it is the full reload
(the owner's Reload button) and the status. Every device hears with its hearer's model and hearing settings.

- **Keys.** `SttKey` = `sttKeyOf(sttSpecOf(hearing, shared))`: stt-sherpa `sherpa|<preset>|<language>|<model dir>|<threads>`,
  the language only for a preset that takes one (Whisper, Nemotron; `-` for Parakeet, Zipformer, the hybrid), the
  model directory and threads from the shared `STT_SHERPA_MODEL_DIR` / `STT_SHERPA_THREADS`; Deepgram
  `deepgram|<DEEPGRAM_MODEL>|<address>`, the instance's identity adding a stamp of `DEEPGRAM_API_KEY` (as WP-9/10).
  **Per stream** (not in the key, `SttStreamSpec`): `eagerSilenceMs`, `finalSilenceMs`, `minSpeechMs`,
  `vadThreshold`, `agc`, `agcMaxGainDb` (stt-sherpa) and `eotThreshold`, `eagerEotThreshold`, `eotTimeoutMs`
  (Deepgram). Two hearers that differ only there share one instance.
- **Places, not assistants.** Recognisers are bound per hearing *place*: `device:<id>` for every known device, and
  `type:<kind>` for each device type's defaults (also used by a session whose device is not recorded). Each place
  wants its hearer's hearing (`hearerOf`: the `withoutPhrase` assistant, else the first assignment; switched on or
  not, §2.6); a place with no assistant wants nothing, and its session runs **no recogniser** (the voice page's
  `device.setup` lists no assistant). The status lists each recogniser once (`kind: "stt"`), `usedBy` = the hearers,
  with `ramMb` from WP-0's table for a local model.
- **stt-sherpa.** A process-wide registry of workers by `workerKey` (model, model directory, threads, the language when
  the preset takes one, per-model tuning, and in tests the stand-in script): `make(options)` and the new
  `acquire(options)` → `Recogniser { forStream(streamOptions) }` reuse the loaded worker of the key, counted, stopped
  with the last user. The worker's `open` message carries the session's `{ vadThreshold, agc, prerollMs }`; the worker
  keeps idle VADs per threshold and AGCs per option set, so a second session with the same options costs nothing,
  and the startup VAD still serves the first session with the default threshold. Turn timing stays on the main
  thread (one `TurnDetector` per stream). A worker that dies is dropped from the registry (the next caller loads a
  new one) and tells its users (`onFailure`). **Orphan rule per key**: a worker that did not answer `close` within
  15 s is left behind under its key; no new worker of that key loads beside it (`check`, `acquire` refuse; the pool's
  builder waits for it to go, the resource staying `starting` and the device on its old recogniser), while other
  models still load. `orphans(key?)`, `whenNoOrphans(key?)`, `workers()` are the diagnostics.
- **Deepgram.** One instance per configuration (`SttKey` plus the key stamp); each stream is its own Flux connection,
  as before, with that hearer's confidences (`DeepgramStt.make` per stream: cheap, nothing is opened until
  `transcribe`). A missing key is the resource's problem (the locked-vault wording when the vault is locked).
- **Hearer switching (§3.5).** A settings save, a `device.pick`, a vault change and the reload reconcile the pool. A
  place whose spec changes keeps its old binding while a new key builds (the device goes on hearing with the old
  model); once the new instance is ready the place is rebound (changed stream options rebind at once, no load), and
  the pool's `onRebind` tells every session. The session's recogniser loop reads its `hearing()`: when the bound
  instance or the stream options differ from the stream it runs, it waits until no utterance is open
  (`SpeechStarted` … `EndOfTurn` of the recogniser's own events), at most `HEARER_SWITCH_WAIT_MS` = 5 s, then closes
  the old `transcribe` and opens the new one on the same `WebAudioInput`; an utterance still open after 5 s is closed
  with an empty `EndOfTurn` (it starts nothing). The released instance goes 10 s after its last user (the grace
  period), unless it is wanted again within it.
- **Failure.** A recogniser that fails to load (model files missing, no key) or whose worker dies is a `failed`
  resource with its problem; its places' streams fail with it. That device hears nothing and its tabs get one
  `error` (`engine_failed`, "Speech recognition stopped: …") per engine build; typed text is still answered; every
  other device hears. The hearer's `AssistantInfo.problems` gains `Hearing (<label>): <problem>`. A vault unlock and
  the owner's reload build failed recognisers again. A recogniser stream that fails no longer stops the engines.
- **Memory (WP-0 data).** `ResourceInfo.ramMb` for each local recogniser. While more than one local model is loaded,
  each hearer on one gets the line `Hears with <model> (about N MB of memory); K local speech models are loaded
  together, about T MB.` in its `problems`. §9's warning at save: an `assistant.save` or `device.save` whose new
  local models (keys not loaded now) need more than 75 % of the free memory (`os.freemem`) is refused
  `invalid_settings` with a warning ("This loads another speech model: about N MB more memory and M s to load, more
  than 75 % of the F MB free on this machine.") until `saveAnyway`. The Hearing tab's "about N MB more, M s to load"
  sentence (§3.2) is the UI's (WP-6a/7), from `ramMb`/the presets.
- **Engine.** `defaultProviderBuilder` builds nothing but the tool-rounds fallback; `EngineProviders.stt` is optional
  (tests that inject one recogniser: the pool then hands every place a stream of it). The reload's preflight is now
  serve mode's: the model files of every local recogniser in use exist (`ServeOptions.checkModelsBeforeReload`,
  default with the real builders), else the running engines are kept. `defaultPreflight` is gone. The status's `stt`
  rows come from the pool's recognisers in use (the Models page's "in use").
- **Deviations.** (1) Bound per place, not per assistant (the hearer rule is per device). (2) The language is in the
  key only for a preset that takes one (the doc's key always had it), so two hearers on Parakeet with different
  languages share a worker. (3) Deepgram's key adds the address. (4) `STT_SHERPA_MODEL_DIR` and `STT_SHERPA_THREADS`
  are part of the key, so a change to them builds the new recogniser and switches at silence without a full reload
  (§3.2 kept a full reload for them; the Reload button still rebuilds everything). (5) The full reload's rebuild of a
  working local recogniser reuses its loaded worker (the registry) instead of loading a second copy of the model; a
  dead one is loaded again. (6) Every type defaults place and every known device is wanted (as §3.2 says), so the
  browser defaults' hearer is loaded at start before any device connects, and a known device that is offline keeps
  its own hearer's model loaded. (7) Speech shorter than `minSpeechMs` at the switch moment (no `SpeechStarted` yet)
  can be cut. (8) Serve mode reads only the shared speech settings (`STT_SHERPA_MODEL_DIR`, `STT_SHERPA_THREADS`,
  `DEEPGRAM_MODEL`, `DEEPGRAM_URL`, `DEEPGRAM_API_KEY`); the flat per-assistant keys are no longer read by any engine
  (the store still mirrors a saved flat key into the migrated assistant, WP-3), and the old Speech pages still mark
  their fields "reload". (9) The CLI modes (`voice`, `transcribe`, `bench --live`) still use the flat keys.
- **Tests.** `packages/stt-sherpa/test/recognizerCore.test.ts` (per-session VAD threshold, AGC options and pre-roll,
  reuse per option set), `SherpaSttFake.test.ts` (two hearers on one model with different end pauses share one worker
  and each gets its own end of turn; two models, two workers, stopped with their last user; the key; a dead worker
  is not reused; the orphan rule per key: refused for its key, another key loads beside it, gone → loads again),
  `apps/assistant/test/resourcesRecognisers.test.ts` (sharing and own stream options, two models, a change built
  first while the place keeps the old one and the old one released after the grace, stream options rebind with no
  load, re-want within the grace, a failed load is that resource's problem and a retry builds it, a worker that dies
  marks it failed and a retry builds a new one, keys; the default builder on the stand-in worker: one worker for two
  places, each its own end of turn, a second model a second worker, both stopped), `serveRecognisers.test.ts`
  (scripted client: devices with different hearers on their own model, hearers on one model sharing one instance with
  their own end pause, the old instance released, no reload; a hearer switch loads first and waits for silence, the
  open utterance reaching its conversation whole; an utterance that does not end is closed after the wait; a device
  with no assistants runs no recogniser until one is assigned; a model that fails: the device is told, typed text
  works, the other device hears, the failed resource and Bravo's problem, back on a working model; the save-time
  memory warning and `saveAnyway`), `providers.test.ts` (the new bench flags), `serve.test.ts` (the reload preflight
  through `checkModelsBeforeReload`).
- **Bench.** `bench --live --stt-models A,B,…` gives session `i` the `i`-th local model (round robin) through
  `SherpaStt.make` (equal models share a worker, as in the pool); `--load-model X` loads one more model and keeps it
  idle. `src/bench/baseline.ts together A,B,… [--runs N]` loads the listed recognisers one after the other into one
  fresh process, each with its own end pause, and prints the RSS added after each and the workers loaded.
- **Measurements** (2026-11-16, the WP-0 machine: AMD Ryzen 9 7945HX, 16 logical processors, 30.3 GiB, Linux
  7.0.0-43, Node 22.22.1, sherpa-onnx-node 2.0.1; other work ran on the machine, load average 0.8–3.5 during the
  latency runs and 2.1–2.9 during the memory runs).
  - **Method, latency.** `bench --live --rounds 2 bench-audio` (the five WP-0 clips, 10 turns per session), the stand-in
    LLM (first token 250 ms, 60 tokens/s), the Piper voice `en_US-lessac-medium`; every run a fresh process; four
    configurations alternated in each of 3 rounds to cancel drift (c1, c2, c3, c4, c1, …): **c1** one session on
    `parakeet-v2` (`--stt-models parakeet-v2`, one model loaded); **c2** the same plus `--load-model parakeet-ultra`
    (two models loaded, one talking); **c3** `--sessions 2 --stt-models parakeet-v2` (two talking sessions on one
    worker); **c4** `--sessions 2 --stt-models parakeet-v2,parakeet-ultra` (two talking sessions, one worker each;
    Ultra is the same size and decoder as v2, so the two workers do equal work). Sessions' user audio ends at the
    same moment. Figures: median of the 10 turns of a run, ms from the end of the user's audio to `EagerEndOfTurn`
    (eager) and to the turn's `endOfTurn` mark (eot), and to `playbackStart` (play) for context; three runs each, and
    the median of the three. Every turn was recognised correctly in every run.

    | Configuration | eager (3 runs) → median | eot (3 runs) → median | play (3 runs) → median |
    |---|---|---|---|
    | c1 one model, one session | 404 / 396 / 418 → **404** | 661 / 650 / 661 → **661** | 718 / 720 / 724 → 720 |
    | c2 two models loaded, one session | 402 / 416 / 400 → **402** | 650 / 660 / 650 → **650** | 718 / 718 / 696 → 718 |
    | c3 two sessions, same model: session 1 | 434 / 500 / 434 → **434** | 660 / 660 / 650 → **660** | 758 / 836 / 758 → 758 |
    | c3 two sessions, same model: session 2 | 424 / 419 / 448 → **424** | 660 / 660 / 660 → **660** | 782 / 738 / 781 → 781 |
    | c4 two sessions, two models: session 1 (v2) | 449 / 450 / 461 → **450** | 660 / 661 / 660 → **660** | 764 / 766 / 774 → 766 |
    | c4 two sessions, two models: session 2 (Ultra) | 449 / 424 / 436 → **436** | 660 / 640 / 641 → **641** | 762 / 727 / 746 → 746 |

    Reading: a second model loaded but idle changes nothing measurable (c2 vs c1: within 2–11 ms, inside the run
    spread). Two talking sessions delay the eager point by 20–45 ms over one session whether they share a worker (c3)
    or have one each (c4); the end of turn does not move (640–661 ms in every configuration, the 600 ms final
    silence plus detection). On this 16-thread machine, separate workers did not remove the queueing seen on one
    shared worker (c4's eager is not better than c3's); the decodes of two workers compete for the CPU instead of
    waiting in one queue. The numbers match WP-0's (one session eager 397–427, eot 651–680; two sessions eager
    404–479). Only one pair of sessions and ~1 s clips were measured.
  - **Method, memory.** `node --import tsx src/bench/baseline.ts together <presets> --runs 5`: in one fresh process,
    the listed recognisers loaded one after the other through `SherpaStt.make`, each with its own end pause (so as
    two hearers of the pool); added MB = RSS after minus before (`/proc/self/statm`), five runs, min / median; no
    turn decoded.

    | Loaded | workers | added MB min / median | WP-0 (sum of single loads, median) |
    |---|---|---|---|
    | `parakeet-v2` | 1 | 1028 / 1053 | 1050 |
    | `parakeet-v2` twice (two hearers, different end pauses) | 1 | 1023 / 1037 (the second adds 0 MB, load 0 ms) | – |
    | `parakeet-v2` + `parakeet-ultra` | 2 | 1964 / 1991 | 1050 + 1067 = 2117 |
    | `parakeet-v2` + `nemotron-560` | 2 | 1955 / 1964 | 1050 + 948 = 1998 |

    A second hearer on a loaded model costs nothing; a second model costs about its WP-0 figure less 35–125 MB (the
    native runtime both workers share is counted once). Load time of the second model: Ultra 1.59 s, Nemotron 1.27 s
    (medians), about their WP-0 `loadMs`.
  - **Not measured.** Deepgram (no key on this machine); more than two sessions or models; resident memory after
    long turns (a recogniser grows with the longest turn it decodes, WP-0); the hearer switch's own cost in a live
    serve run (a switch is a stream close and open on a loaded worker; its correctness is tested, its time is not
    traced); the web pages (the Hearing tab's memory sentence is WP-6a/7's).
- **Not verified.** A hearer switch through the real admin UI (WP-6a/7 do not save hearing yet); exercised through the
  settings store and the WebSocket messages in tests. `serveLocal.test.ts` (real zipformer-en, now run in this
  worktree because the local models are present) failed once in about eight runs with "HOLLO CAN YOU HEAR ME"
  (a recognition variance; one stream was opened per run, no switch happened).

### WP-12a Home and linked defaults: built 2026-11-16

- **Section `home`** (`sectionDefinitions.ts` `homeSection`, group `modules`, page `home`, order 5; the admin's Shared
  settings › Home picks it up by id): `HOME_LOCATION` (text ≤ 200), `HOME_TIME_ZONE` (IANA, checked with `Intl`; empty
  = this machine's), `HOME_LANGUAGE` (en-GB, en-US, nl-NL, de-DE; default en-GB), `HOME_UNITS` (metric | imperial;
  default metric), `HOME_DATE_FORMAT` (en-GB | en-US | nl-NL; default en-GB, §7.3). Live (no reload). Environment
  variables of the same names lock them, as every flat key.
- **Home line** (`homeLineOf`, protocol `assistants.ts`, pure so the admin's "See the full prompt" can show it): in
  every assistant's stable prompt, after its own prompt and before the module instructions, through the WP-4b seam
  (`homeLine` in `serveMode`): `Home: <location>; time zone <zone>; language <language>.` The location is left out
  when empty; the zone is the machine's when Home names none. Unchanged while Home is unchanged (cached prefix).
- **Linked defaults** (`linkedModuleDefaults`, now with `location`; `ModuleHostOptions.defaults`): Weather
  `defaultPlace` ← `HOME_LOCATION`, `units` ← `HOME_UNITS` (imperial → fahrenheit), Clock `timeZone` ←
  `HOME_TIME_ZONE`, `locale` ← `HOME_DATE_FORMAT`. A linked default replaces the field's own default only (saved value
  and environment win; an assistant's own value wins over all); a default the field refuses is ignored. The module's
  form shows it as the field's `default` and value (`source: "default"`). A Home save refreshes the module host
  (`onSectionSaved`, after the section's values are in effect), which restarts only the instances whose settings it
  moved.
- **Deviations.** (1) Weather's `defaultPlace` default is `HOME_LOCATION` itself (§2.6 said "" with the module
  reading `HOME_LOCATION`): the module stays independent of the app, and the form shows the place used. (2) The Home
  line is always there (with the machine's zone and the default language when Home is not set), so every prompt
  gained one line once. (3) The CLI modes do not apply Home (no Home line, no linked defaults: `startCliModules` is
  unchanged).

### WP-12b module overrides: built 2026-11-16

- **Flag.** `Setting.*({ overridable: true })` (not offered on `Setting.secret`; addresses are simply not marked).
  The field description carries `overridable: true` (protocol `SettingField`, optional). Marked: Clock `timeZone`,
  `locale`; Weather `defaultPlace`, `units`; Home Assistant `domains`. Not marked: Weather `timeoutMs`, Home Assistant
  `baseUrl` (address), `aliases`, `timeoutMs`, every secret, every agent or decision module field.
- **Resolution** (`resolveSettings` sources `own` and `defaults`): per field, the assistant's own value (overridable
  fields only) > environment > saved > linked default > the field's default. `applicableOwnValues`, `overridableKeys`,
  `checkOwnValues` (core `Settings.ts`).
- **Instances** (`ModuleHost`, `ModuleHostOptions.demand`). Serve mode gives the host, for every capability module,
  the switched-on assistants that have it on with their `own` values (`moduleDemand`); agent and decision modules have
  no demand and keep their own switch, as do all modules in the CLI modes (no `demand`: one instance, exactly the old
  behaviour, the old tests unchanged). An instance's key is the JSON of the effective non-secret values (own applied);
  assistants with equal keys share one instance. A module with demand:
  - runs while its list is not empty (its saved `enabled` is not read; `module.enable`/`module.disable` answer
    `not_allowed`, "switched on and off per assistant");
  - starts its instances at `startEnabled` and at every `refresh`: serve calls `refresh` after every settings-store
    save (assistant, device, section, module saves all pass `notifyAfterSaves`), after a Home save and after the
    store is unblocked. New keys start (concurrently, each on its own: one failing is that instance's `error`, the
    others run); an instance whose key no longer appears keeps serving until the new ones have settled, then leaves the
    snapshot and is closed after the 10 s grace period (tool calls in flight finish). A key that is wanted again while
    it is still leaving is kept; one already retired starts anew. A refresh that finds the module busy (a configure)
    runs when that operation ends;
  - `configure` (the shared settings) restarts only the instances whose key changes (all of them when the patch sets a
    secret), all or nothing: if one cannot start, nothing changes and nothing is saved. Saving the same values restarts
    nothing (before, a configure always restarted the one instance). `setSecrets` (vault) keeps running instances and
    retries the ones in `error`.
- **Per assistant.** `ModuleSnapshot.assistantParts`: for each assistant with demand, the parts of the instances it
  uses (catalog order, plus every module without demand). The part object is shared between assistants on one
  instance and with `parts` (the shared-settings instance is the one in `registry`, `parts`, `instructions`, `agents`,
  `actions`). Serve's `modulesFor` takes the assistant's parts (else `parts`), then filters by its module switches and
  `offTools` as before, so each assistant's tool registry, context providers and module instructions come from its own
  instance. `toolModules` covers every instance's tools.
- **`assistant.save` / `assistant.create`**: `own` values are checked by the module's fields (`ModuleHost.checkOwn`,
  passed to `makeAssistants` as `checkOwn`): a secret ("A secret is shared: it cannot be set per assistant"), a field
  that is not overridable ("This setting is shared: …"), an unknown field, or a value the field refuses is
  `invalid_settings` with `fieldErrors` keyed `modules.<moduleId>.own.<field>`. Checked whether or not the module runs.
- **Admin data for the Modules tab** (`ModuleInfo`, `module.changed` and `admin.snapshot.modules`, admin connections
  only): `settings.fields[].overridable: true` on the fields an assistant may own; `instances` (present for a module
  with demand): `[{ assistants: AssistantId[], own: FieldKey[] /* the fields these assistants own */, state, error?,
  status? }]`; `enabled` = at least one switched-on assistant has it on; `state` = `error` while one instance fails
  (`error` names its assistants: "… (for bravo)"), `starting` while one starts, else `running`; `tools` = the union of
  the running instances' tools; `settings.values` and each field's `default` include the linked defaults. The web
  page can enable "own settings" for the fields with `overridable` and save them as `modules[id].own` through
  `assistant.save`.
- **Deviations.** (1) A module whose wanted settings are invalid (e.g. Home Assistant without a token) does not run,
  but shows an instance in `error` with the settings message instead of being silently absent (§2.6 "required settings
  are set"). (2) The module's own switch is refused for capabilities rather than kept as a second switch; the admin's
  Modules page still shows it (apps/web not changed: the switch now gets `not_allowed`). (3) Own values win over the
  environment too (rule 1 of §2.6 as written). (4) Agents, decision providers and actions come from the
  shared-settings instance only (none of them is per assistant). (5) `ModuleSnapshot.assistantParts` and
  `ModuleInfo.instances` are additive; ARCHITECTURE.md describes the contract.
- **Tests.** `packages/core/test/ModuleHostInstances.test.ts` (equal settings share one instance and one part; an
  own date format runs a second and each assistant's tool answers in its own; the run rule and `not_allowed`; secrets,
  shared fields and bad values refused by `checkOwn` and ignored at run time; grace on stop with a call in flight;
  a shared change restarts only the affected instances, same values none, a secret all, a failing start nothing;
  one instance failing leaves the other running; linked defaults and their refresh; a replaced instance serves
  until its replacement runs; a module without demand), `packages/core/test/Settings.test.ts` (precedence, flag,
  helpers), `packages/modules-builtin/test/instances.test.ts` (Clock with an own `nl-NL` answers "vrijdag 13 november
  2026" to that assistant and "Friday, 13 November 2026" to the other, tool and context; Weather looks up Home's place in
  Home's units, an own unit wins, a saved place wins over Home), `packages/protocol/test/assistants.test.ts`
  (`homeLineOf`, `linkedModuleDefaults` with a location), `apps/assistant/test/serveModules.test.ts` (scripted client:
  the Home line in the system prompt the model receives for both assistants, Weather and Clock follow a Home save, two
  clock instances with each assistant's context in its own date format; `assistant.save` accepts an own time zone and
  refuses a secret, a shared field and a bad value, back to one shared instance). Changed: `serve.test.ts` (sections
  list starts with `home`; a capability's `module.disable` is `not_allowed`), `serveVault.test.ts` (`home` is not
  protected).

### WP-12c Home Assistant in the app: built 2026-11-16

- `@pva/module-home-assistant` is a dependency of `apps/assistant` and in `moduleCatalog` after Weather. It is a
  capability: it runs for the assistants that switch it on, with the shared address and token (the token in the vault
  as every module secret) and an assistant's own `domains` if any. It talks plain HTTP (`fetch`): no provider SDK.
  Migration: an install whose saved `enabled` was not on (the module was off by default) gets it off on the migrated
  assistant.
- **Test** (`serveModules.test.ts`, against the package's fake Home Assistant server on 127.0.0.1): wanted by Alpha
  but without a token it is one instance in `error`; `module.configure` with the server's address and token starts it
  (`/api/config` called with the token, which never reaches an admin message); Alpha's request carries `home_state`,
  `home-assistant_lights_on`, `…_lights_off`, `…_lights_status` (its `offTools` removed `…_set_brightness`) and the
  module's instructions, Bravo's none; `home_state` answers from the server.

### WP-12 measurements (2026-11-16, the WP-0 machine)

- **Offline bench** (`pnpm start bench`, three runs before the change — the branch's base commit — and three after,
  end of turn → playback start, median / worst ms; machine load 7–16 before, 4.6–0.5 after). Orchestration overhead
  1.5 / 2.8, 1.3 / 1.9, 1.0 / 1.9 → 1.0 / 2.2, 0.9 / 3.4, 0.9 / 1.5; session path 3.2 / 14, 0.7 / 1.3, 0.7 / 1.4 →
  0.7 / 1.4, 0.7 / 1.1, 0.8 / 1.2; realistic rows eager off 508–526 / 735–763 → 507–509 / 734–736, eager on 307–316 /
  534–554 → 306–307 / 534–537. The offline bench builds its tools directly (`makeClock`), not through the module
  host, so it shows that the turn path is unchanged, not the module path.
- **Module path in serve** (a temporary scripted-client measurement, not committed): 400 typed turns alternating two
  assistants with Clock and Weather on, the instant stand-in LLM, `TurnTrace` `llmRequestSent` − turn start (the
  setup: prompt with the Home line, the assistant's parts, registry, context providers), the first 100 turns dropped,
  0.1 ms resolution; three runs per configuration, the code before and after run in the same worktree minutes apart
  (load 5–8). Before: median 0.4, p90 0.5, mean 0.435–0.439 ms (equal settings) and 0.439–0.459 (Bravo with an own
  date format, which the old code ignored). After: median 0.4, p90 0.5–0.6, mean 0.434–0.503 (one Clock instance) and
  median 0.4, p90 0.5, mean 0.453–0.469 (two Clock instances). No measurable cost per turn.
- **Memory of a second instance** (one process, `node --expose-gc`, 200 more instances each with an own value,
  heap used after a double GC minus before, divided by 200; three runs): Clock **12.6 KB** per instance, Weather
  **7.8 KB** (all three runs equal to 0.1 KB); RSS grew 5.6–9.1 MB (Clock) and 5.2–6.3 MB (Weather) for 200, i.e.
  under 50 KB each. A second Home Assistant instance was not measured (it holds its house model and a 60 s refresh
  timer and makes its own requests; its size depends on the house).
- **Not verified.** The web pages (no "own settings" control yet; the Modules page's switch now answers
  `not_allowed` for a capability); a real Home Assistant (only the fake server); the CLI modes with Home (not applied).

### WP-14 TypeSafe routing: built 2026-11-16

A sentence the route gate leaves to `decide` (a device set to "TypeSafe decides", no phrase, no open armed or
follow-up window) is routed by TypeSafe. **Off by default**: nothing is sent until the owner switches the routing
section on and adds a key, and only from devices set to TypeSafe.

- **Settings.** New shared section `routing` (`sectionDefinitions.ts`; group `agents`, page `routing`, protected, live):
  `TYPESAFE_ROUTING` (switch, default off), `TYPESAFE_API_KEY` (secret, vault), `TYPESAFE_MODEL` (default
  `jev-1.14.0`), `TYPESAFE_BASE_URL` (advanced, default `https://api.typesafe.ai`, the adapter's address check). A
  warning when it is on without a key. The `jev-typesafe` decision module (not in the app's catalog) is unchanged.
- **`canAuto`** (voice pages' `device.setup`, `device.pick "typesafe"`) is now "the routing section is on, has a key and
  a valid address" (`routing.ts` `routingReady`). It is re-sent after a save of the section and after a vault change.
  The admin's device page reads the same from the section's values (`DevicesPages.tsx` `useCanAuto`; the old
  decision-module rule only for a server without the section, as the mock server still is).
- **Not set up** (off or no key) on a TypeSafe device: nobody answers a sentence without a phrase (what the device page
  and the mock-up say), no request. Before WP-14 the fallback answered it.
- **Request** (`packages/decide-typesafe/src/routing.ts` `routingRequest`, sent with `makeJevClient`, whose `decide`
  gains a per-call `timeoutMs`): exactly §3.6. `state = { utterance, available_actions: { id: Handles, or "Name:
  purpose" (or the name) when Handles is empty } }` over the device's switched-on assistants in list order
  (`typesafeCandidates`); questions `assistant` (Choice, the same options) and `fits` (Noul); with one candidate only
  `fits`. On the wire the options are the Choice's `criteria` and the roles are dropped (as for the intent decider).
- **Decision** (`readRouting`): chosen when `fits ≥ ROUTE_FITS_MIN` (0.5) and the chosen option's probability
  `≥ ROUTE_CHOICE_MIN` (0.5); a missing answer is 0; a choice that is not a candidate is none fits.
- **Timing** (`serve/routing.ts` `makeTypesafeDecide`, the dispatcher's `decide`): asked at the first non-blank
  `EagerEndOfTurn`, else at `EndOfTurn`; the event (and everything after it, the recogniser's events queue meanwhile)
  waits for the answer or the give-up time (`withoutPhrase.giveUpMs`, default 400), after which the call is
  interrupted and its request aborted (a late answer is never read). At the final the decision is reused when
  `sameUtterance` holds, else asked again with a fresh give-up time. A later eager event with changed text is asked
  again too (§3.6 names only the first eager; the re-ask overlaps the pause, and the final can then reuse it). No
  retries. A phrase, an armed or follow-up window, and typed text never ask (they are not `decide` targets).
- **Fallback**: none fits, the give-up time, or an error (key rejected, network, refused, bad answer; logged once per
  distinct message) → the fallback (`null`: dropped). No switched-on candidate → the fallback without a request.
- **Traces**: `route = { by: "typesafe", outcome: "chosen" | "none-fits" | "timeout" | "error", probability?, fits,
  ms, fallback }` and marks `routeSent`, `routeReceived` (absent after a timeout), relative to the conversation's end
  of turn like the other marks. A decision held at the final therefore shows a negative `routeSent`: the
  conversation's `endOfTurn` mark comes after it. `TraceRoute.fits` is now a number (it was an integer, a WP-2 slip).
- **Warnings** (§2.2): `validateDeviceSettings(…, { assistants })` warns `no_handles` for each switched-on assistant
  with empty Handles on a TypeSafe device (a new warning asks "Save anyway" on `device.save`); `assistant.save` of a
  switched-on assistant whose Handles becomes empty while it is on a TypeSafe device asks the same.
- **Tests.** `apps/assistant/test/typesafeRouting.test.ts` (scripted routing service under the test clock, real route
  gate and dispatcher: chosen with the eager event held until the answer and the final reusing it; none fits by the
  Noul and by a weak choice; timeout at the give-up time with the call interrupted and the late answer unused; error;
  text changed between eager and final asked again; phrase and follow-up never ask and are not delayed; fallback
  nobody drops; not set up sends nothing; one candidate; typed text). `serveTypesafe.test.ts` (real server, the real
  adapter over HTTP to a local fake `/v1/systemone`: wire body and bearer key, chosen / none fits / phrase / typed text,
  traces and marks, off by default then switched on live with `device.setup` following, a slow server traced as a
  timeout, the Handles warnings). `packages/decide-typesafe/test/routing.test.ts` (request and reading; HTTP body,
  per-call time limit aborting the request, 401 / 529 / malformed answer). `benchTypesafe.test.ts`. Changed:
  `serveAssistantMessages.test.ts` (`canAuto` from the section), `serve.test.ts` and `serveVault.test.ts` (the new
  section in the lists).
- **Measurement, offline** (`pnpm start bench --typesafe`; `src/bench/typesafe.ts`). The offline bench's session path
  (route gate → dispatcher → `Conversation`, output lease), realistic stand-ins (LLM first token 250 ms + 60 tok/s, TTS
  first audio 150 ms), a TypeSafe device with three candidates whose simulated decision answers Jeff after 150, 250
  or 400 ms (give-up set to 2 s so the simulated answer is always used), against the same path with the device
  answering without a phrase and no decider. The recogniser's events reach the dispatcher through a queue, as in serve
  mode. Figure: **recogniser `EndOfTurn` → playback start** (`EOT->PLAY`; the trace's own end of turn is the
  conversation's, after the decision), median of 12 turns per run (3 rounds of the 4 scripted turns, after a warm-up
  round). No follow-up window opens in the bench, so every turn is decided. This machine (WP-0's), 3 runs, load
  1.3–11; the eager lead is the bench's default 200 ms, plus one run with 350 ms (the real defaults, eager 250 /
  final 600):

  | Decision | eager OFF (3 runs) → median | eager ON, lead 200 (3 runs) → median | eager ON, lead 350 (1 run) |
  |---|---|---|---|
  | none (no decider) | 508 / 508 / 524 → **508** | 308 / 307 / 307 → **307** | 158 |
  | 150 ms | 659 / 659 / 663 → **659** (+151) | 460 / 459 / 459 → **459** (+152) | 309 (+151) |
  | 250 ms | 759 / 760 / 759 → **759** (+251) | 558 / 558 / 558 → **558** (+251) | 408 (+250) |
  | 400 ms | 910 / 909 / 909 → **909** (+401) | 709 / 715 / 708 → **709** (+402) | 558 (+400) |

  Worst turns (the tool turn) move by the same amounts (740 → 888 / 987 / 1138 eager off). **Reading: the decision's
  whole time is added to playback, with eager on as with eager off.** §1.2's hypothesis (the call overlaps the pause
  before the final) holds only for the final: it is not held longer when the decision is shorter than the eager lead.
  But the speculative turn, which produces the reply, starts only after the answer, so it is late by the same amount.
  Eager on with a 250 ms decision beats eager off without TypeSafe (508) only with the 350 ms lead (408; 558 with the
  200 ms lead). A way to hide it (not built, a design change for the owner): start the speculative turn at once for a
  tentative assistant (the fallback, or the last one chosen) while TypeSafe is asked, and hand over only when it
  chooses another.
- **Live: not measured** (no TypeSafe key on this machine; no request was made to api.typesafe.ai). With the owner's
  key: `TYPESAFE_API_KEY=… pnpm start bench --typesafe-live` (or a key in the vault: `PVA_VAULT_PASSWORD=… pnpm start
  bench --typesafe-live`; options `--count N` (default 50), `--gap-ms MS` (default 1000), `--timeout-ms MS` (default
  2000)). It sends 50 English and Dutch sentences, one after another, over the three bench assistants and prints each
  `routeReceived − routeSent`, the outcome and choice, p50/p90/p95/p99/max with and without the first (connection
  set-up) request, how many fit in the 400 ms give-up, and the choices. Checked against a local fake server only.
- **Unverified.** Every request and response shape is from TypeSafe's documentation (docs/research/typesafe-jev.md
  §2.2, §2.3), never sent to the real service: the body (`model`, `state` as an object, Choice `criteria`, Noul),
  the bearer header, the answer (`answers.assistant.choice`/`probabilities`, `answers.fits.noul`), the error codes,
  whether the thresholds suit our sentences (Dutch included) and the option-order bias. The 0.5 thresholds are
  starting points, to be tuned from traces.
- **Not built.** The web voice page and Diagnostics' Routing column (WP-8, WP-15) are other packages; the mock server
  has no `routing` section. No warm-up request keeps the TypeSafe connection open (Node closes an idle one after about
  4 s, `packages/decide-typesafe/test/live.test.ts`), so a first sentence after a pause also pays the connection set-up; the live
  bench's `--gap-ms 6000` shows what that costs.

### WP-15 and the web halves of WP-12 and WP-14: built 2026-11-16

`apps/web` only (and its mock server). Mock-up: `docs/mockups/assistants/admin.html`; where §7.3 differs, §7.3 wins.

- **Assistant › Modules, own settings** (`assistants/tabs.tsx`): for a module with `overridable` fields (a secret never
  is), "Uses the shared settings: <values> · Open" and "Use own settings for this assistant". With own settings each
  overridable field shows "Same as shared" or "Own value · Reset" (Reset removes the key from `modules[id].own`, so the
  assistant follows the shared value again; "Use the shared settings" drops `own`), and the other fields are named as
  staying shared. Saved with the assistant through `assistant.save`; a refusal (`modules.<id>.own.<field>`) is shown on
  its field, whose input is `aria-invalid`, and clears when the field is edited. The wizard shows modules `compact`
  (switch and shared values only).
- **Shared settings › Modules** (`ServerPage.tsx` `ModuleBlock`, `ModuleHeader.tsx` `ModuleInstances`): a capability
  module (one with `ModuleInfo.instances`) has no switch. "Used by: Jeff, Keuken · T3 has its own date format" (assistants
  switched on with the module on; an own value equal to the shared one counts as shared), then each instance: state,
  "Shared settings" or "Own <fields>", its assistants, status, and its error (the server's "(for bravo)" text). A module
  nobody has on says "Not running". Agents and decision modules, and a server without `instances`, keep `ModuleHeader`
  and its switch.
- **Home** renders from its section (five fields; units and date format are here, §7.3 item 1). **Routing** renders
  from the `routing` section (switch, key through the vault flow, model, address under Advanced) under a header of
  `RoutingIntro`: "TypeSafe", Hosted and Needs key chips, the state ("On", "Key set, switched off", "Needs a key", "Not
  set up"), the section's description and "Used by:" the devices set to TypeSafe. The device page's TypeSafe option
  follows the section through `useCanAuto` (switch on and key set): verified against the mock.
- **Diagnostics › Latency** (`latency.tsx`, `DiagnosticsPages.tsx`): ten columns (Turn, Assistant, Device, Routing, 1st
  token, TTS audio, Playback, Audible, Outcome, Tools; the page is wide, 1000 px, and scrolls sideways on a phone). Routing
  is TypeSafe's time with its outcome under it (chosen, none fits, timed out, error); other routes leave it empty.
  Filters by assistant (segmented), device and route (selects); with "All assistants" a median per assistant of the audible
  time, with one assistant its median and worst. Hovering or focusing an assistant's name shows a popover of what it was
  set to at that turn (language model, hearing, voice, modules and tools, chosen by), and opening a row shows the same plus
  "Open <assistant>". "Changed since this turn: …" lists what differs between the snapshot (`TraceInfo.config`) and the
  assistant now: language model fields, voice, reply early, tool rounds, module and tool counts, and hearing through the
  assistant that hears on that device now (a different hearer reads "hearing Keuken's → Jeff's"). A turn without `config`
  says "Configuration: not recorded" and cannot show a change.
- **Mock server**: sections `home` and `routing` (`/mock/typesafe` now switches the section, and a save of it updates
  `canAuto`); overridable fields (Clock time zone and date format, Weather place and units, Home Assistant domains);
  capability modules follow the assistants (`instances` by effective values, `module.enable`/`disable` refused
  `not_allowed`, own values checked per field, `POST /mock/module-error` injects an instance failure); T3's Clock has an
  own date format; scenario `latency` seeds thirteen turns of every route kind with snapshots (`mock/traces.ts`), and live
  turns carry assistant, device, route and a snapshot of the assistant as it is.
- **Tests**: `apps/web/e2e/adminFinish.spec.ts` (own value set, refused, reset; modules page; Home; Routing flipping the
  device page's option; latency columns, filters, popover, changed since, a live turn) and `apps/web/test/latency.test.ts`.
  Changed: the module tests of `options.spec.ts` and `vault.spec.ts` (no capability switch), `settings.spec.ts` (Home and
  Routing in the navigation), `assistants.spec.ts` (Home Assistant now runs: 4 tools for Jeff). Screenshots 58 to 67,
  light 18 and 19, phone 23 to 25; 16, 17, 37, 38 and 49 regenerated.
- **Not done / not verified**: `e2e-real` (real server) was not updated or run; its module test still clicks a
  capability's switch. The real server fills `config` in another change: the counts of modules and tools in "changed
  since" are the web's own (`toolCount`) and may differ from the server's until both are checked together.
