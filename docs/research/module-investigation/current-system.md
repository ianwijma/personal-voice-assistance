# Current system: what a module ecosystem would build on

Written 2026-11-17 against `main` at `70b15ec` (protocol version 8). Read-only investigation of the code and the design
documents; nothing was run. It is written for people designing new modules who will not read the code.

Every claim carries a status:

- **IMPLEMENTED**: in the code on `main` and reachable in the running app (serve mode).
- **BUILT, NOT WIRED**: code exists in a package on `main`, but the app does not use it.
- **DESIGNED-ONLY**: described in `docs/`, not in the code on `main` (sometimes on an unmerged branch, named).
- **ABSENT**: neither designed nor built.

File references are `path:line` from the repository root.

## 1. What a module is

### 1.1 The contract (IMPLEMENTED)

A module is a plain value made with `defineModule` (`packages/core/src/ModuleDefinition.ts:94`). The shape it produces
is `ModuleDefinition` (`packages/core/src/ModuleDefinition.ts:62`):

| Field | Meaning |
|---|---|
| `id` | Stable id, `/^[a-z][a-z0-9-]{0,39}$/`; persistence key and protocol id. Checked at definition time (`:104`). |
| `name`, `description` | Shown in the admin UI. |
| `settings` | A `SettingsSpec`: a record of `Setting.*` fields (§6.2). Drives the generated form. |
| `enabledByDefault` | Default `true` (agents and deciders default `false`). |
| `enabledWhenSet` | Name of a secret field; the module counts as on once that key is set in the environment or the vault. |
| `kind` | `capability` (default), `agent` or `decider` (`packages/protocol/src/agents.ts:18`): which admin tab shows it. |
| `start(ctx)` | `Effect<ModuleInstance, ModuleStartError, Scope>`. `ctx` = `{ settings, setStatus }` (`ModuleDefinition.ts:30`). |

`start` runs inside a `Scope` the host closes on disable or restart, so a module may open sockets, caches and
background fibers with `Effect.acquireRelease` / `Effect.forkScoped` (Home Assistant does: `packages/module-home-assistant/src/module.ts:199`).
`setStatus` publishes one line (`{ text, tone }`) to the admin module card. A failed start is a `ModuleStartError`
whose `message` is one sentence for the owner (`ModuleDefinition.ts:23`).

What `start` returns, `ModuleInstance` (`ModuleDefinition.ts:45`, extending `ModuleContributions`,
`packages/core/src/ModuleContributions.ts:31`):

| Contribution | Type | Status |
|---|---|---|
| `tools` | `Tool[]`: things the model can call (§2) | IMPLEMENTED |
| `context` | `ContextProvider[]` = `{ name, get: Effect<string> }`, run every turn, 50 ms budget, output goes to `LlmRequest.context` (not cached) | IMPLEMENTED |
| `instructions` | Stable text appended to the system prompt (part of the cached prefix) | IMPLEMENTED |
| `actions` | `ActionDefinition[]` for the typed-intent path; each also becomes a generated tool unless `offerAsTool: false` (§2.4) | IMPLEMENTED as tools; intent path BUILT, NOT WIRED |
| `agents` | One `Agent` for a module of kind `agent` (§3.2) | IMPLEMENTED for Claude subscription only |
| `deciders` | One `DecisionProvider` for kind `decider` | BUILT, NOT WIRED |
| `settingOptions` | Runtime options for `combo` fields | BUILT, NOT WIRED (the field type does not reach module forms, §6.2) |
| `info` | Values of read-only `info` fields (Home Assistant returns some, `module.ts:295`) | BUILT, NOT WIRED: the wire form has no `info` field type (§6.2) |
| `fieldActions` | Handlers for `action` (button) fields, returning `{ ok, text, tone }` (`ModuleContributions.ts:23`); host method `fieldAction` (`ModuleHost.ts:152`, generated "Test" for agents `:1052`) | BUILT, NOT WIRED: no client message reaches it (`module.action` was removed from the protocol) |

Nothing else can be contributed: no UI code, no HTTP routes, no protocol messages, no background triggers into the
conversation, no access to speech output, no storage service (ABSENT; the design defers them in
`docs/UI-AND-MODULES.md:450`).

### 1.2 Registration and loading (IMPLEMENTED)

Modules are compiled in. The catalog is one array, `moduleCatalog` (`apps/assistant/src/modules.ts:17`), in display
order (also the order of their instructions in the prompt): `clockModule`, `weatherModule()`, `homeAssistantModule()`,
`claudeSubscriptionAgent`. Adding a module = one file + one line there + a workspace dependency in
`apps/assistant/package.json`. There is no discovery, no npm-installed third-party module, no hot loading (ABSENT;
"Hot-loading module code from disk" is explicitly deferred, `docs/UI-AND-MODULES.md:450`).

### 1.3 Lifecycle and enable/disable (IMPLEMENTED)

The **module host** (`packages/core/src/ModuleHost.ts:264`, no Node dependency, persistence injected via
`ModulePersistence`, `:30`) owns lifecycles:

- `start` has 10 s (`:266`); a replaced or disabled instance keeps running 10 s of grace so tool calls in flight
  finish (`:267`); a context provider has 50 ms per turn or contributes nothing (`:268`).
- One operation per module at a time. A failed start is that module's `error` state (`ModuleInfo.state`:
  `disabled | starting | running | stopping | error`, `packages/protocol/src/snapshot.ts:32`). No automatic restart
  after a runtime failure (ABSENT, deferred).
- **Demand mode (serve):** a capability module runs while at least one switched-on assistant has it on. One
  **instance** per distinct set of effective settings (an assistant's own `overridable` values over the shared values
  over linked defaults), shared by every assistant whose settings are equal (`ModuleDemand`, `:94`). The module's own
  on/off switch is not read (`enable`/`disable` answer `not_allowed`). Agent and decider modules have no demand and
  follow their saved switch.
- The host publishes an immutable `ModuleSnapshot` (`:54`): the tool registry, instructions, tool → module map, agents,
  actions, deciders, and `assistantParts` (per assistant, the parts of the instances it uses). Each turn reads it once
  at turn start, so a turn never sees a half-applied change.
- CLI modes start the same catalog once, read-only (`apps/assistant/src/modules.ts:37`).

### 1.4 The existing modules, tool by tool (IMPLEMENTED unless stated)

| Module (catalog?) | Contribution | Name | Speculative | What it does |
|---|---|---|---|---|
| `clock` (yes) `packages/modules-builtin/src/clock.ts:108` | tool | `current_time` (`:42`) | yes | Time now, optionally in a named place |
| | context | clock (`:55`) | – | The local date and time, every turn |
| | action → tool `clock_time_now` | `time_now` (`:86`) | yes | "It's 14:32." / "In London it's …" |
| | settings | `timeZone` (overridable, env `CLOCK_TIME_ZONE`), `locale` (choice, overridable) | | Linked defaults from the Home section |
| `weather` (yes) `packages/modules-builtin/src/weather.ts:221` | tool | `weather` (`:137`) | yes | Open-Meteo geocode + forecast, returns a JSON object; own timeout |
| | action (not a tool) | `today` (`:179`) | yes | Spoken one-liner for the intent path |
| | settings | `defaultPlace` (overridable), `units` (overridable), `timeoutMs` (advanced) | | |
| `home-assistant` (yes, off by default) `packages/module-home-assistant/src/module.ts:123` | tool | `home_state` (`:279`) | yes | Areas and lights with on/off and brightness (live read) |
| | actions → tools `home-assistant_lights_on`, `_lights_off`, `_set_brightness`, `_lights_status` (`:237`–`:276`) | | only `lights_status` | REST `light.turn_on/off`; `target` is a `dynamic` param over a cached room/light list refreshed every 60 s in a scoped fiber |
| | settings | `baseUrl`, `token` (secret, required), `domains` (multichoice, overridable; only `light`), `aliases`, `timeoutMs` | | |
| | info | `server`, `lists` | | |
| `demo-home` (**not** in the catalog) `packages/modules-builtin/src/demoHome.ts:187` | tool `demo_home_state`, actions `lights_on/off`, `set_brightness`, `lights_status`, `all_off` (`confirm: true`) | | | In-memory pretend house; BUILT, NOT WIRED |
| `claude-subscription` (yes, kind `agent`) `packages/agent-claude-code` | one harness `Agent` | | | §3.2 |
| `jev` (kind `agent`, intent) `packages/agent-intent/src/jev.ts:15`, keyword decider `packages/agent-intent/src/keywords.ts` | | | | BUILT, NOT WIRED (not in the catalog, not an app dependency) |

## 2. What a tool is

### 2.1 Definition (IMPLEMENTED)

`Tool` (`packages/core/src/Module.ts:6`):

```ts
interface Tool<I = any, R = never> {
  name: string; description: string
  parameters: Schema.Codec<I, unknown>    // Effect Schema; also the source of the JSON Schema sent to the model
  speculative?: boolean                   // safe before the turn is committed (read-only); default false
  execute: (input: I) => Effect<unknown, ToolError, R>
  action?: RegisteredAction               // set on generated action tools
}
```

`makeTool` (`Module.ts:32`) infers `I`. Tool names must be unique across all running modules (the registry throws on a
duplicate, `packages/core/src/ToolRegistry.ts:49`). **`execute` receives only its decoded input**: no assistant id,
device id, session, conversation id, speaking channel or display channel (ABSENT; §9).

### 2.2 How a call runs and what comes back (IMPLEMENTED)

`makeToolRegistry` (`ToolRegistry.ts:44`) converts `parameters` with `Schema.toJsonSchemaDocument` (`:24`), decodes
model input with `Schema.toCodecJson(parameters)`, runs `execute`, and **never fails**: unknown tool, invalid input, a
`ToolError` or a defect become `{ isError: true, content: <message> }` for the model. A successful value is encoded as
a string: a string as is, `undefined` as `"ok"`, anything else `JSON.stringify` (`:38`). The result shape is
`ToolResult = { id, name, content: string, isError }` (docs/ARCHITECTURE.md, `packages/core/src/Domain.ts`).

The tool loop is in core (`Conversation`): calls of one response run concurrently, results are appended, the model is
called again, capped by the assistant's `toolRounds` (0–10, default 5). Text said before a tool call is flushed to the
voice first ("let me check" is heard while the tool runs). A speculative turn pauses at the first non-speculative tool
until the turn is committed. Results enter the bounded history (one item cut at 8 000 characters).

To the front end: `tool.start` (tool name, `moduleId`, input truncated to about 2 KB) and `tool.end` (`ok`, `ms`,
`error`) (`packages/protocol/src/server.ts:115`, `:128`). **The result content is not sent to any client.** The voice
page shows a chip per call (`apps/web/src/components/ToolChip.tsx`).

### 2.3 Streaming and long-running work

- No progress events, partial results or streaming from a tool (ABSENT). A tool returns one value.
- Core imposes no timeout on a plain tool; each tool times itself out (weather: `timeoutMs`). A generated action tool
  has the action's 5 s limit (`ACTION_TIMEOUT_MS`, `packages/core/src/Actions.ts:222`).
- Barge-in interrupts the turn fiber and therefore a running tool; a disabled module's instance gets 10 s grace.
- No "start a job and report back later" (ABSENT). Server **jobs** exist only for model downloads (§6.4).

### 2.4 Actions (the typed-intent shape)

`ActionDefinition` (`Actions.ts:153`): `id`, `label`, `description` (for a decision model), `examples`, `params` from a
closed set (`Param.choice | dynamic | number | duration | boolean | text`, `:133`), `speculative`, `confirm`,
`offerAsTool` (default true), `announce(params)` (spoken while it runs), `run(params) → { say? }`. `actionTool`
(`:355`) turns each into a tool named `<moduleId>_<actionId>` whose result is the action's `say`, else its
`announce`, else `"ok"`. This conversion is IMPLEMENTED and is how Home Assistant's lights reach Claude today. The
intent path that runs actions without a model (Jev) is BUILT, NOT WIRED.

### 2.5 Confirmation of actions

Core conducts confirmation itself for `confirm: true` actions (the question is worded by core, never by the module).
It is **switched off**: `confirmActions` is `"off"` by default (`packages/core/src/Conversation.ts:563`) and the
assistant field is fixed to the literal `"off"` (`packages/protocol/src/assistants.ts`, `AssistantBody.confirmActions`).
With it off, a `confirm: true` action is refused before anything is asked, and its generated tool fails with "Not run:
this action needs the owner's confirmation" (`Actions.ts:378`). So today: **no module can have a confirmed
side-effecting action**; plain tools and non-confirm actions run without asking. Status: confirmation logic BUILT,
disabled; the reasons are at the start of the actions section of docs/AGENTS-AND-INTENTS.md.

### 2.6 How tools reach each backend

| Backend | How tools arrive | Status |
|---|---|---|
| `llm-anthropic` | `LlmRequest.tools` → Anthropic `tools` with `input_schema`; cache breakpoint covers tools + system (`packages/llm-anthropic/src/index.ts:117`, `:144`) | IMPLEMENTED |
| `llm-openai-compatible` (OpenRouter, home model server) | `{ type: "function", function: { name, description, parameters } }` (`packages/llm-openai-compatible/src/OpenAiCompatibleLlm.ts:135`) | IMPLEMENTED |
| Model agents in general | `makeModelAgent` (`packages/core/src/ModelAgent.ts:39`): one model call per round, core runs the loop | IMPLEMENTED |
| `agent-claude-code` (Claude subscription) | The assistant's tools become an in-process MCP server named `assistant` (`packages/agent-claude-code/src/sdk.ts:48`, `:80`); Claude Code sees `mcp__assistant__<name>`; all built-in Claude Code tools are disabled (`tools: []`, `disallowedTools`, `permissionMode: "dontAsk"`, `packages/agent-claude-code/src/options.ts:150`); a non-speculative call waits for promotion (`agent.ts:443`); the harness runs its own loop and reports tool activity back | IMPLEMENTED |
| `agent-intent` (Jev) | Reads `AgentTurnInput.actions`, not tools | BUILT, NOT WIRED |
| `decide-typesafe` | Not a tool consumer: a hosted classifier (`https://api.typesafe.ai`, `packages/decide-typesafe/src/JevClient.ts:49`) used to pick an assistant (§3.3) and, in the design, Jev's decider | routing IMPLEMENTED; decider BUILT, NOT WIRED |

## 3. Assistants, agents and routing

### 3.1 Assistants (IMPLEMENTED)

An **assistant** is a stored persona (`Assistant`, `packages/protocol/src/assistants.ts:131`; body `:107`), at most 16:
`name`, `purpose`, `handles` (what it is for, used by TypeSafe routing), `on`, `prompt` (≤ 4000 chars),
`toolRounds`, `followUpSeconds`, `newConversationAfter`, `replyEarly`, `confirmActions` (always `"off"`), `llm`
(account `offline | anthropic | claude-subscription | openrouter | home-model` + model options), `hearing`
(recogniser), `voice` (one `provider:voiceId`), `look` (§5.2), and `modules`.

Module assignment is per assistant: `modules: Record<moduleId, ModuleChoice>` where `ModuleChoice = { on, offTools[],
own? }` (`assistants.ts:97`). A module missing from the record is off. `offTools` removes individual tools; `own`
holds the assistant's values for `overridable` fields. At turn start serve mode builds that assistant's registry and
instructions from `snapshot.assistantParts`, filtered by `on` and `offTools` (`apps/assistant/src/serve/serveMode.ts:435`).
Agent and decider modules are not filtered per assistant.

### 3.2 Agents

`Agent` (`packages/core/src/Agent.ts:160`) = `{ id, name, kind: model | harness | intent, speculate,
firstEventTimeoutMs, systemPrompt?, turn(input) → Stream<AgentEvent>, endConversation? }`. `AgentTurnInput` (`:33`)
carries text, history, conversation id, system prompt, context, the tool registry, actions, deciders, `promoted`, trace
hooks. `AgentEvent` (`:109`): `TextDelta`, `ToolStarted/Finished`, `Decision`, `ActionStarted/Finished`, `ExpectReply`,
`Handoff`, `ConfirmAction`. Declared with `defineAgent` (`ModuleContributions.ts:93`).

In the app: every assistant except `claude-subscription` ones runs a plain `Conversation` with its `Llm` from the
resource pool (core's tool loop). `claude-subscription` assistants run `makeAgentConversation` with the one running
Claude Code agent module, falling back to the offline stand-in with a spoken notice
(`apps/assistant/src/subscription.ts:45`, `apps/assistant/src/serve/SessionConversation.ts:199`). Multiple agents
per assistant, sticky agents and hand-off between agents: BUILT in core, NOT WIRED (docs/AGENTS-AND-INTENTS.md header
note).

### 3.3 Routing and "hey Jev" (IMPLEMENTED in a changed form)

The original trigger-phrase router (`makeTriggerRouter`) is now only a test fixture. What runs: per device, the
**RouteGate** (`packages/core/src/RouteGate.ts`) picks the assistant for each utterance: a wake phrase at the start
(each device assignment has phrases; matched `exact` or `close`, longest wins, phrase removed), a follow-up window after
a reply, otherwise the device's `withoutPhrase` (`nobody` = asleep, a fixed assistant, or `decide` = ask TypeSafe to
choose among the device's assistants by their `handles`, give-up time 100–2000 ms, default 400). "Hey Jev" today is
simply a wake phrase bound to an assistant; Jev the intent agent (typed actions without an LLM) is BUILT, NOT WIRED.

## 4. Devices and front ends

### 4.1 Device model (IMPLEMENTED)

- A **device** is recorded at `hello` (`DeviceHello = { id, kind, name }`, `packages/protocol/src/frontends.ts:245`):
  id from the browser's `localStorage`, kind, a name suggested from the user agent. Stored as `DeviceRecord = { kind,
  name, firstSeen, lastSeen, own }` (`packages/protocol/src/devices.ts:130`), at most 64.
- **Device types** are a code registry: `DEVICE_TYPES = [web-voice]` (`devices.ts:183`). Effective settings = built-in
  ← type defaults ← the device's own sections.
- **Device settings** are a closed set (`DeviceSettings`, `devices.ts:68`): `assistants` (ordered assignments with
  phrases and follow-up), `withoutPhrase`, `matching`, `voicePage`, `interruptMode`, `audio` (echo cancellation, noise
  suppression, AGC, `speakAloud`, output path, prebuffer), `captions`, `look`, `voice`. **No module settings per
  device**, and no per-device tool switches (ABSENT).
- What else the server knows: open connections per device (`DeviceInfo.connections`), and when a tab claims audio,
  `AudioClientInfo` (sample rate, base/output latency, echo cancellation, output path; `packages/protocol/src/client.ts`).
- **Capability description** (has a display? speaker? mic? screen size? location/room?): ABSENT. Every device is
  assumed to be a browser with a screen, mic and speaker. There is no room/location field on a device.

### 4.2 Voice/admin split (IMPLEMENTED)

One server, one port: the voice front end at `/`, the admin front end at `/admin/` (`hello.frontend`). Admin needs
`PVA_ADMIN_PASSWORD` (≥ 8 chars; unset = admin disabled) → `admin.login` → in-memory token (12 h, 30 min idle). Every
change to the server is admin only. The voice page has no login. Admin-only messages (`sessions`, `trace`, …) never go
to voice connections.

### 4.3 Sessions per device (IMPLEMENTED)

Each device gets a **voice session** at its first `audio.claim` or `text.send` (`apps/assistant/src/serve/VoiceSessions.ts`),
at most `MAX_VOICE_SESSIONS` (default 4), discarded with its conversation after `SESSION_DISCARD_MINUTES` (default 30)
without a connection. One tab of the device owns the audio; others observe. Per session: its own recogniser stream,
echo gate, route gate, dispatcher, and one `SessionConversation` per assistant used on it (own history and
conversation id), all behind one `OutputLease` so two replies never play at once. A session's messages go only to its
device's tabs. Conversations are in memory only and do not survive a server restart (ABSENT persistence).

### 4.4 Voice nodes (DESIGNED-ONLY on `main`)

Headless boxes (Pi/VM with mic and speaker, one-shot activation, pairing codes, node credentials, ALSA backend,
self-update) are designed in `docs/VOICE-NODES.md`, which exists only on the unmerged branches `t3/voice-node-wp4` and
`t3/add-headless-voice-node-client` (with an `apps/node` client). On `main`: only `web-voice` exists; the design
explicitly excludes screens, LEDs and buttons on nodes.

## 5. What can be shown on a display

### 5.1 The voice page (IMPLEMENTED)

The voice page (`apps/web/src/app/page.tsx` → `components/voice/VoiceApp.tsx`) shows the **stage** (a character),
a status line, captions, a chat panel with user/assistant text and **tool chips** (name, first string input value,
running/ok/error), a composer for typed text, and New conversation. Assistant text is plain text (no markdown/HTML
rendering found in `apps/web/src`).

### 5.2 Characters and looks (IMPLEMENTED)

A **character** draws the assistant's presence on a canvas from a `Frame` (mode idle/listening/hearing/thinking/
speaking plus extra modes, voice features computed in the browser, theme, options, pointer)
(`apps/web/src/characters/contract.ts`, contract version 1). 19 character files in `apps/web/src/characters/library/`,
baseline `sine-lines`. A **look** = `{ character, version?, options? }` (`packages/protocol/src/looks.ts:32`), set per
assistant and overridable per device (`DeviceLook`, `:42`). Characters never receive server data beyond the mode.
`FrameExtensions` (`contract.ts:226`) is empty; the foreseen extensions (`turn.activity` from tool events,
`reply.expression` from the model, `speech.words`, …) are DESIGNED-ONLY (docs/CHARACTERS.md §5.2). "New displays"
(LED matrix, small screen on a node) as new renderers: DESIGNED-ONLY (§5.4).

### 5.3 A channel for tools to push visual content: ABSENT

No protocol message, tool result field or UI component lets a tool or module show an image, card, list, timer, map or
anything else. `tool.end` carries no result. The intended path is written down but not built: "a tool result may carry
an optional `display` value from a small closed set of data kinds (`facts`, `list`, `image` URL), sent as an optional
field on `tool.end` and rendered by one generic component per kind. Still no module code in the browser."
(`docs/UI-AND-MODULES.md:452`, DESIGNED-ONLY, one paragraph). Useful fact for designers: the web client counts and
drops unknown server message types without error (`apps/web/src/lib/connection.ts:203`), so additive messages are safe.

### 5.4 Protocol messages (IMPLEMENTED, protocol 8, `packages/protocol/src/constants.ts:66`)

JSON text frames validated with Effect Schema on `/ws`; binary frames carry PCM with an 8-byte header (mic 16 kHz in,
reply audio out).

| Direction | Messages |
|---|---|
| Server → client (`server.ts`) | `welcome`, `session`, `state`, `transcript`, `turn.start`, `assistant.text`, `assistant.playing`, `tool.start`, `tool.end`, `turn.end`, `reply.start`, `reply.end`, `reply.stop`, `module.changed`, `section.changed`, `engine`, `engine.summary`, `vault`, `env`, `job`, `models`, `result`, `admin.state`, `admin.snapshot`, `devices`, `wake`, `wake.heard`, `conversation`, `conversation.history`, `sessions`, `trace`, `device.setup`, `assistants`, `device.types`, `error`, `pong` |
| Client → server (`client.ts`) | `hello`, `audio.claim`, `audio.release`, `audio.config`, `mic.state`, `playback.started/progress/finished/stopped`, `interrupt`, `text.send`, `conversation.new`, `conversation.read`, `module.enable/disable/configure`, `settings.update`, `settings.moveFromEnv`, `engine.reload`, `vault.setup/unlock/lock/changePassword`, `job.start`, `job.cancel`, `model.delete`, `admin.login/logout`, `assistant.create/save/delete`, `device.save`, `device.pick`, `device.forget`, `wake.test`, `ping` |
| HTTP `/api/` (admin bearer token) | voice catalog, previews (WAV), voice and model favourites, model catalogs (`apps/assistant/src/serve/api.ts`) |

Nothing in either direction is module-defined.

## 6. Configuration

### 6.1 Levels (IMPLEMENTED unless stated)

| Level | Where | What |
|---|---|---|
| Startup environment | `.env` / process env, shown with origin in the env view | `SERVE_HOST` (127.0.0.1), `SERVE_PORT` (8787), `SERVE_TLS_CERT/KEY`, `PVA_DATA_DIR`, `PVA_VAULT_PATH`, `PVA_VAULT_PASSWORD`, `PVA_ADMIN_PASSWORD` (`apps/assistant/src/serve/serveMode.ts:1444`) |
| Shared sections | `apps/assistant/src/serve/sectionDefinitions.ts` | `home` (`HOME_LOCATION`, `HOME_TIME_ZONE`, `HOME_LANGUAGE`, `:139`; feeds every prompt's Home line and modules' linked defaults), `routing` (TypeSafe), LLM accounts, recogniser and voice providers, recordings, limits |
| Per module (shared) | module `settings`, saved per module | environment > saved > default; an env value locks the field |
| Per assistant | `Assistant.modules[id].own` for `overridable` fields | wins over env and saved for that assistant; secrets can never be overridable |
| Per device | closed `DeviceSettings` set (§4.1) | no module fields (ABSENT) |
| Per user | — | ABSENT: one owner, no user model |

### 6.2 Settings schema drives the UI (IMPLEMENTED)

Field constructors: `Setting.text | secret | number | boolean | choice | multichoice` (`packages/core/src/Settings.ts:262`),
with `label`, `description`, `placeholder`, `env`, `default`, `check`, `required`, `advanced`, `overridable`,
`visibleWhen`, option `tags`/`implication`, `apply` ("live" or reload). The host describes them as a `SettingsForm`
in `ModuleInfo.settings` (`packages/protocol/src/snapshot.ts:59`) and the admin renders them generically
(`apps/web/src/ui/fieldRenderers.ts`); no module code runs in the browser. Cross-field checks: `runSettingsChecks`.
Extended field types `textList`, `records`, `combo`, `action`, `info` exist in core (`packages/core/src/SettingsExtra.ts:252`)
and protocol (`SettingFieldV2`, `packages/protocol/src/agents.ts:53`) but the module form schema on the wire is the
six-type `SettingsForm`; they are BUILT, NOT WIRED for module cards (the demo home's `rooms`/`lights` records fields
wait on this, `demoHome.ts:10`).

### 6.3 Secrets and the vault (IMPLEMENTED)

Module secret fields are stored in the encrypted vault (`apps/assistant/src/serve/Vault.ts`; default
`~/.config/pva/vault.enc`, scrypt N=2^17 + AES-256-GCM, `node:crypto` only), else `data/secrets.json` (0600) before a
vault exists. The vault is locked after every start; unlocked from admin or by `PVA_VAULT_PASSWORD`. Unlocking calls
`setSecrets` on the host, which restarts modules that failed for want of a key. A module sees its secrets only as
resolved `settings` values in `start`. Secrets are never sent to clients.

### 6.4 Optional installs from the UI

- **Speech model downloads**: IMPLEMENTED as server **jobs** with progress, log tail and cancel, admin only
  (`apps/assistant/src/serve/jobs.ts:54`, `models.ts`). Job tools are a closed set: `ToolId = "stt-models" | "tts-models"`,
  action `download` only (`packages/protocol/src/jobs.ts:12`). Shared downloader `@pva/core/download` (disk check,
  `.part`, stall timeout, `nice -n 10 tar -xjf`, file check).
- **General installers and logins** (allowlisted tools, `claude auth login` from the UI, tool cards with
  `checking | missing | installed` state): DESIGNED-ONLY (docs/SETTINGS-UI.md §5, lines 176, 701, 731).
- **Module dependency checks** (a module declaring it needs a binary, a model, a network service): ABSENT. A module
  can only check in `start` and fail with a `ModuleStartError` message.

## 7. Persistence and background work

### 7.1 Storage (IMPLEMENTED, files only)

All under `PVA_DATA_DIR` (`data/`): `settings.json` (version 4: module settings, shared sections, assistants, device
types, devices; atomic writes), `secrets.json` or the vault, `transaction.json` (two-file commit journal),
`writer.lock` + `writer.holder` (one writer, `flock`), `voice-favourites.json`, `model-favourites-<kind>.json`,
`recordings/*.wav` (opt-in "save what the assistant hears", `apps/assistant/src/serve/HeardAudio.ts:141`). No database,
no SQLite (none found in any package). **No storage API for modules**: a module has only its settings (written by the
owner) and in-memory state that dies with its instance (ABSENT: module data store, per-user/per-device data).

### 7.2 Background work

| Capability | Status |
|---|---|
| Module background fibers in its scope (polling, refresh) | IMPLEMENTED (Home Assistant's 60 s refresh) |
| A scheduler (cron, one-shot timers, "remind me at 5") | ABSENT; deferred in docs/UI-AND-MODULES.md:450 |
| Timers/alarms that survive restart | ABSENT |
| Proactive speech (assistant speaks unprompted) | ABSENT for modules. Core has a `Say` input (speak a canned text, nothing recorded; `packages/core/src/ConversationEvents.ts:119`) reachable through `SessionDispatcher.send` (`apps/assistant/src/serve/SessionDispatcher.ts:140`), but no protocol message, module API or trigger uses it |
| Notifications (push, toast from a module, cross-device announce) | ABSENT (the web `Toasts` component exists, but nothing lets a module raise one) |
| Cross-device state | Implicit only: one process; a module instance shared by assistants with equal settings shares its memory across all devices. No shared state service, no device-to-device messaging, no "which device is the owner near" |
| Conversation persistence across restarts | ABSENT (kept across engine reloads only) |

## 8. Deployment

- Runs as `pnpm serve` (builds the static web UI, then `pnpm start serve`) or `pnpm start <mode>` for the CLI modes
  (`voice`, `text`, `bench`, `say`, `transcribe`, `compare-models`). No build step for the server (`tsx`).
- On the owner's machine it has been run as a systemd **user** service; no unit file, installer or packaging is in the
  repository (ABSENT in repo). HTTPS needs `SERVE_TLS_CERT`/`SERVE_TLS_KEY` (browsers allow the mic only on https or
  localhost; the server warns, `serveMode.ts:1507`).
- Native dependencies today:

| Dependency | Needed for | When missing |
|---|---|---|
| Node ≥ 22.18, pnpm 10 | everything | — |
| `sherpa-onnx-node` 2.0.1 (+ 1.13.8 aliased for Piper) npm native addons | local STT/TTS (`packages/stt-sherpa/package.json:20`, `packages/tts-sherpa/package.json:19`) | build fails per startup stage, reported in admin Overview |
| Model files under `models/` (~800 MB default) | local STT/TTS | stage error naming the download command; downloadable from admin |
| `tar` with bzip2, `nice` | model unpacking | job fails |
| `flock` (util-linux) | data-directory writer lock | serve refuses to start with a clear message (`apps/assistant/src/serve/DataDirLock.ts:164`) |
| PipeWire `pw-record`/`pw-cat` | CLI `voice` mode only (`packages/audio-pipewire`) | serve mode does not need it |
| Claude Code binary | Claude subscription agent | bundled with `@anthropic-ai/claude-agent-sdk`; login done by the owner in a terminal |
| ~2.5 GB free RAM | default local models | a save that would exceed 75 % of free memory asks "Save anyway" |

## 9. Gaps a module ecosystem would need

Each line: what is missing, and its status.

1. Tool invocation context (assistant id, device id, session/conversation id, language, room) passed to `execute` — ABSENT.
2. Display channel: a tool or module pushing cards, lists, images, timers to a device — DESIGNED-ONLY (one paragraph, `docs/UI-AND-MODULES.md:452`).
3. Tool results visible to clients at all (`tool.end` has no content) — ABSENT.
4. Device capability description (screen, size, speaker, mic, LEDs, room/location) and negotiation — ABSENT.
5. Device types beyond `web-voice` (headless node, display-only panel) — DESIGNED-ONLY (voice nodes on unmerged branches).
6. Per-device module settings or per-device tool switches — ABSENT.
7. Proactive speech API for modules (announce on a device, all devices, or "where the owner is") — ABSENT (core `Say` exists, unexposed).
8. Scheduler / timers / reminders that fire turns or speech, surviving restarts — ABSENT (deferred).
9. Notifications to the owner (push, toast, badge) — ABSENT.
10. Module data store (key-value or documents, per module, per assistant, per device) — ABSENT; only owner-edited settings and in-memory state.
11. Shared data between modules (e.g. a "rooms" registry several modules read) — ABSENT (Home section has location/time zone/language only).
12. Conversation and history persistence across restarts — ABSENT.
13. Dependency declaration and checks for modules (binaries, models, services, Python, network) with install from the UI — ABSENT; general installer framework DESIGNED-ONLY (docs/SETTINGS-UI.md §5); model downloads IMPLEMENTED.
14. Third-party / out-of-tree module loading, discovery, versioning, hot reload — ABSENT (compiled-in catalog).
15. Module permissions and sandboxing (network, filesystem, which assistants) beyond `speculative` and per-assistant on/off — ABSENT.
16. Confirmation of side-effecting actions — BUILT but switched off (`confirmActions: "off"`); no confirmed action can run.
17. Long-running tools: progress events, streaming partial results, background jobs that report back into the conversation — ABSENT.
18. Typed-intent path (Jev agent, deciders) running module actions without an LLM — BUILT, NOT WIRED.
19. Extended settings field types in module forms (`records`, `textList`, `combo`, `action`, `info`) — BUILT, NOT WIRED on the wire form.
20. Module-contributed UI (admin pages, voice-page widgets) — ABSENT by decision ("no module code in the browser").
21. Module-contributed HTTP routes or webhooks (for inbound events from services) — ABSENT.
22. Inbound event triggers (a doorbell, a calendar alert starting a turn) — ABSENT.
23. Character extensions fed by server data (`turn.activity`, `reply.expression`) — DESIGNED-ONLY (docs/CHARACTERS.md §5.2).
24. Users / identities (who is speaking, per-person data) — ABSENT.
25. Automatic restart of a module after a runtime failure — ABSENT (deferred).
26. Deployment packaging (systemd unit, installer) in the repository — ABSENT.
