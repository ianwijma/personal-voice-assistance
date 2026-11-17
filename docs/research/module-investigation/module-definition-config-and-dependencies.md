# Modules: definition, configuration layers and native dependencies

Research and design options, 2026-11-17, against `main` at `70b15ec` (no code changed, nothing run). Sketches marked
PROPOSAL are for discussion; the contract is still docs/ARCHITECTURE.md "Extending the assistant" and
docs/UI-AND-MODULES.md §1. **A**: what a module is. **B**: where configuration lives. **C**: native tools and deployment
once the assistant moves to a server plus a few devices.

---

## 0. What exists today

**The module contract** (`packages/core/src/ModuleDefinition.ts`):

- `defineModule({ id, name, description, settings?, enabledByDefault?, enabledWhenSet?, kind?, start })`
  (`ModuleDefinition.ts:94-117`). The id must match `/^[a-z][a-z0-9-]{0,39}$/` (`:104`). `kind` is `capability`,
  `agent` or `decider` (`packages/protocol/src/agents.ts:18`).
- `start(context)` receives validated settings with secrets resolved, plus `setStatus` (`ModuleDefinition.ts:30-38`).
  It runs in a host-owned `Scope` and returns a `ModuleInstance` (`:45-60`).
- A `ModuleInstance` contributes `tools`, `context`, `instructions` (`:45-60`) and, through `ModuleContributions`
  (`ModuleContributions.ts:31-47`), `agents`, `actions` (typed intents: each one is also a tool unless it says
  otherwise), `deciders`, `settingOptions` (live choice lists), `info` (read-only fields) and `fieldActions` (a "Test"
  button). `defineAgent` and `defineDecider` are thin wrappers (`:93-148`).
- A `Tool` is `{ name, description, parameters: Schema, speculative?, execute }` (`packages/core/src/Module.ts:6`).
  An action adds `label`, `examples`, `params`, `speculative`, `confirm`, `say` (`packages/core/src/Actions.ts:153-180`).
  An action marked `confirm` is never run through the registry, only by core's confirmation flow (`Actions.ts:364-376`).
  Confirmations are switched off for now: `Assistant.confirmActions` is the single literal `"off"`
  (`packages/protocol/src/assistants.ts:120`).
- Settings use a closed set of field types: `text`, `secret`, `number`, `boolean`, `choice`, `multichoice`
  (`packages/core/src/Settings.ts:262`), plus `textList`, `records`, `combo`, `action`, `info`
  (`packages/core/src/SettingsExtra.ts`). A field can be `overridable` per assistant (`Settings.ts:55`), but never a
  secret (`Settings.ts:134-148`). It can be locked by an `env` name, and it can have a *linked default* computed from
  Home (`ModuleHostOptions.defaults`, `ModuleHost.ts:180`, fed from `HOME_*` in
  `apps/assistant/src/serve/serveMode.ts:299-314`).

**The host** (`packages/core/src/ModuleHost.ts:264`): it has a 10 s start limit, a 10 s grace period on retire, and a
50 ms budget per context provider (`:266-268`). It publishes an immutable snapshot that each turn reads once. It runs
modules on demand (`demand`, `:187`): one instance per distinct set of effective settings, shared by the assistants
whose settings are equal. Module states are `disabled | starting | running | stopping | error`
(`packages/protocol/src/snapshot.ts:32`), and there is no state for "cannot run here". `ModuleInfo`
(`snapshot.ts:58-92`) carries the state, the error, the status line, the tools, the form and the instances.

**The catalog is compiled in** (`apps/assistant/src/modules.ts:17-24`: clock, weather, home-assistant, the
claude-subscription agent); a module is one file plus one line (UI-AND-MODULES §1.8). Hot-loading, background
triggers, modules that speak, per-module permissions and auto-restart are deferred (§1.9); module UI is **data only**
(§1.1). Modules are workspace packages (`private`, `0.0.0`, `src/index.ts`, no build) on `@pva/core: workspace:*` and
`effect: catalog:`, pinned once because a duplicate copy breaks service identity (docs/ARCHITECTURE.md:11).

**Configuration** (docs/ASSISTANTS.md §2):

- **Bootstrap** values stay in `.env`: `PVA_VAULT_PASSWORD`, `PVA_DATA_DIR`, `SERVE_HOST`, `SERVE_PORT` and TLS
  (docs/SETTINGS-UI.md §0).
- **Shared** settings are flat env-keyed sections. They include the Home section `HOME_LOCATION`, `HOME_TIME_ZONE`,
  `HOME_LANGUAGE`, `HOME_UNITS`, `HOME_DATE_FORMAT` (`apps/assistant/src/serve/sectionDefinitions.ts:140-149`).
- **Module** shared settings are stored in `modules[id].settings`.
- **Assistant** settings: an assistant has an `llm`, `hearing`, `voice`, `look`, and
  `modules: Record<id, { on, offTools, own }>` (docs/ASSISTANTS.md §2.2).
- **Device** settings resolve as device `own`, then the device type's defaults, then the built-in values (§2.6).
  A device may override the voice and the look.
- There is **no user or household-member concept** anywhere.

Module field precedence is assistant `own`, then shared (environment over saved), then the linked default, then the
module default (§2.6). Secrets live in the vault: scrypt and AES-256-GCM, `~/.config/pva/vault.enc`
(`apps/assistant/src/serve/Vault.ts:115`). The vault is locked after every start unless `PVA_VAULT_PASSWORD` is set.

**"Optional installs from the UI"** today means **jobs** for speech-model downloads only. `ToolId` is
`stt-models | tts-models` (`packages/protocol/src/jobs.ts:12`). The downloader (`packages/core/src/download.ts`) checks
disk space, writes a `.part` file, checks `Content-Length` (`:207`), unpacks with `nice tar -xjf` (`:285`) and then
checks the expected files. It verifies **no checksum**. The allowlisted-installer design for Claude Code and Codex
(docs/SETTINGS-UI.md §5.1, fixed argv, no shell, admin only) is not built (piece P6).

**Native dependencies today, all implicit:**

| Dependency | Needed by | Where declared | What happens when it is missing |
|---|---|---|---|
| Node ≥ 22.18, pnpm 10 | everything | `package.json` `engines`, README:33 | install fails |
| `tar` with bzip2, `nice` | model downloads (`download.ts:285`) | README:33 | the job fails; there is no up-front check |
| `flock` (util-linux) | serve mode's single-writer lock (`apps/assistant/src/serve/DataDirLock.ts:16-24`) | comment only | serve refuses to start, saying so |
| `pw-record`, `pw-cat` | CLI voice mode (`packages/audio-pipewire/src/Process.ts:45`) | README:33 | the voice mode fails at spawn |
| `sherpa-onnx-node` 1.x and 2.x native addons | local STT/TTS | npm `optionalDependencies` per platform (lockfile has `linux-x64`, `linux-arm64`, darwin, win) | the provider layer fails to build; it is reported per startup stage |
| Claude Code binary | claude-subscription agent | bundled per platform by `@anthropic-ai/claude-agent-sdk-linux-*` (lockfile:686-704) | the agent start fails |
| Speech model files | local STT/TTS | preset tables; Settings › Models | refused on save with the download size |

**Deployment today** is a systemd user service on one desktop (owner's notes). The repo ships no unit file, installer,
Dockerfile or Nix file. The unmerged voice-node branch (`t3/voice-node-wp4`, docs/VOICE-NODES.md §7) has the
nearest prior art in-house. Its installer pins a Node runtime per arch by SHA-256 in a server-served manifest and runs
a hardened system unit. The node self-updates a hash-checked bundle with rollback, and the installer refuses armv7.

---

## A. What a module is

### A.1 Definitions (proposal)

| Term | Definition | Today | Who creates it |
|---|---|---|---|
| **Module** | The unit of packaging, enabling, configuration and health. It declares *what it needs* (settings, secrets, connections, native requirements, storage) and contributes *capabilities* while running. | `ModuleDefinition` | a developer; the owner switches it on per assistant |
| **Tool** | One function the model can call, with a schema. It is always contributed by a module. | `Tool` | a module |
| **Action** | A typed command for the intent path (Jev), also offered as a tool. It carries `speculative`, `confirm` and `say`. | `ActionDefinition` | a module |
| **Integration / connection** | An authenticated link to one external service account (a Home Assistant instance, a Google account, a Spotify account). It has a credential *type* and any number of *instances*. Several modules may use one connection, and a connection may belong to the household or to one person. | not a concept: HA's URL and token are fields of one module | the owner, in the UI, through the connection's flow |
| **Provider** | An adapter that implements a pipeline interface in core (`Llm`, `Stt`, `Tts`, `TtsVoices`, `AudioInput/Output`). It is latency-critical, pooled by `Resources.ts`, and chosen per assistant. | `packages/{llm,stt,tts,audio}-*`, `providers.ts` | a developer |
| **Agent** | The thing that answers a turn (`model`, `harness`, `intent`). | `Agent`, `defineAgent` | a module of kind `agent` |
| **Assistant** | An owner-configured persona: name, prompt, agent account, voice, look, which modules it has on, and policy. It is stored data, not code. | `Assistant` (ASSISTANTS.md §2.2) | the owner |
| **Assistant template** | A suggested assistant that a module ships ("Chef": prompt, purpose, handles, modules on, a suggested voice). The owner instantiates it; it never appears by itself. | not a concept | a module; the owner instantiates it |
| **Front end / device type** | A client of the protocol that hears and/or plays audio and shows UI (`web-voice`, the coming `voice-node`). | `DEVICE_TYPES` | a developer |

Three decisions follow from this table.

1. **Providers stay out of the module system for now.** They are pooled, warmed at startup and measured per turn. A
   module restarts on any save, and merging the two lifecycles would put the module host on the hot path. If a third
   party ever ships a provider, do it the VS Code way: the module *registers* it, and the pool keeps the lifecycle.
2. **Connections become first-class.** This is the biggest gap. n8n separates nodes from credentials for this reason,
   and so does Home Assistant (config entries and application credentials). One Google login serves calendar, mail
   and contacts; "my Spotify" and "your Spotify" are two instances of one connection type. Section B.4 covers the
   storage and the OAuth flow.
3. **A module may ship personas, but only as templates.** A kitchen module contributes a `chef` template with its own
   prompt and modules list. The new-assistant wizard (already in the Assistants UI) offers it. This keeps assistants
   as owner data, keeps migrations simple, and stops a module update from silently changing a persona.

### A.2 What a module may contribute

| Contribution | Status | Notes |
|---|---|---|
| tools, actions, context, instructions | **exists** | unchanged |
| agents, deciders | **exists** | unchanged |
| settings schema, secrets | **exists** | the closed field set stays: no module markup in the browser |
| status line, live options, info fields, test buttons | **exists** | |
| **requirements** (native tools, platform, network, where they run) | new, §C | static, readable without `start` |
| **health checks** | new, §C.5 | a cheap `check()` that returns issues with fix actions, like HA Repairs |
| **connections** it defines or uses | new, §B.4 | credential types with flows; the module names the type it needs |
| **storage** (a data directory, a schema version, migrations) | new, §C.9 | per module under `data/modules/<id>/` |
| **background jobs / schedules** | new, deferred today (§1.9) | needs a host service: "run every N minutes" and "at time T". Output is a status or a notification |
| **event subscriptions** | new, small | read-only events (turn ended, device came online, conversation started) through a host-provided stream. No access to audio |
| **notifications** ("speak on device X") | new, needs a policy | the first time a module can make the assistant *talk*. It goes through quiet hours and the device's policy (§B) |
| **presentation** | partly deferred (§1.9) | keep the deferred closed set of display kinds (`facts`, `list`, `image`) on `tool.end`. No components |
| **assistant templates** | new | see A.1 |
| **wake routes** | **not** a contribution | phrases belong to device assignments (ASSISTANTS.md §2.3). A template may *suggest* a phrase, and the owner accepts it |
| **intents** | exists as actions | `examples` already feed Jev and the offline decider |
| **admin pages** | data only | an extra settings page built from the existing field types plus `records`. No custom UI |

### A.3 Prior art

| System | Static manifest | What it contributes | Credentials | Native dependencies | Host API version |
|---|---|---|---|---|---|
| [Home Assistant integration](https://contributors.home-assistant.io/core/integrations/manifest/) | `manifest.json`: `domain`, `requirements`, `dependencies`, `config_flow`, `iot_class`, `version` (required for custom integrations) | platforms (entities), services, config/options flows, diagnostics, repairs, system health | config entries; `application_credentials` for OAuth, with My Home Assistant as the redirect | pip `requirements` (exact pins) installed before load; a failed install means the integration does not load. Anything else needs an [add-on, now called an app](https://contributors.home-assistant.io/apps/reference/configuration/) (a multi-arch container managed by Supervisor, with an `arch` list and an options `schema`) | HA core version; `homeassistant` minimum in HACS |
| [OVOS skill](https://openvoiceos.github.io/ovos-technical-manual/401-skill_structure/) | Python package plus an entry point; `settingsmeta` for the UI | intents (Padatious/Adapt), dialogs, GUI pages | skill settings | pip only; [runtime requirements](https://openvoiceos.github.io/ovos-technical-manual/410-skill_runtime_requirements/) cover *network/internet/GUI before load* and fallbacks | `ovos-workshop` version |
| [n8n community node](https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/) | `package.json` `n8n` key lists nodes and credentials | nodes (a declarative or programmatic `INodeType`) | **credential types** are separate classes (`ICredentialType` with `authenticate` and a `test` request), with OAuth2 by extending `oAuth2Api` | verified community nodes must have [**no runtime dependencies**](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/) and, since 2026-05-01, npm provenance | `n8nNodesApiVersion` |
| [Raycast extension](https://developers.raycast.com/information/manifest) | `package.json`: commands, preferences (a `password` type), tools for AI | commands, AI tools | preferences and the OAuth PKCE helper | none (a JS sandbox) | `@raycast/api` version |
| [VS Code extension](https://code.visualstudio.com/api/references/contribution-points) | `package.json` `contributes` and `activationEvents` | commands, configuration, views, languages and more, all declarative | `SecretStorage` API | [platform-specific VSIX](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) (`vsce --target`); `extensionDependencies` | `engines.vscode` semver |
| [MCP server](https://modelcontextprotocol.io/specification/2026-07-28/changelog) | none required: capabilities come at runtime (`tools`, `resources`, `prompts`). The 2026-07-28 revision is stateless (no `initialize`; `server/discover`). `server.json` exists for the registry | tools, resources, prompts | [OAuth 2.1 with PKCE](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) on HTTP; environment variables for stdio; URL-mode elicitation for third-party OAuth | its own process, any language | protocol revision date |
| [Obsidian plugin](https://docs.obsidian.md/Reference/Manifest) | `manifest.json`: `id`, `version`, `minAppVersion`, `isDesktopOnly` | anything, through the API | plugin data | `isDesktopOnly` gates Node or Electron APIs | `minAppVersion` |
| [Claude Code plugin](https://code.claude.com/docs/en/plugins-reference) | `.claude-plugin/plugin.json` (optional; only `name` is required) | commands, agents (personas), skills, hooks, MCP servers, `bin/` added to `PATH` | `userConfig` fields marked `sensitive` go to the OS keychain; `${CLAUDE_PLUGIN_DATA}` survives updates | MCP servers and `bin/` bring their own | plugin `version`, marketplace entry |

What to take from this:

- **Static manifest, code for behaviour.** VS Code, HA and Obsidian can list, gate and explain a module without
  running it. This repo already has that in practice, because `defineModule` is a plain object read before `start`.
  New fields (requirements, connections, storage) should stay plain data on that object.
- **Credentials are a separate type** (n8n, HA application credentials, VS Code `SecretStorage`), and **personas ship
  next to tools** (Claude Code plugins bundle agents; OVOS bundles dialogs), which supports assistant templates.
- **A declared host-API range** (`engines.vscode`, `minAppVersion`). The module can then be refused with a reason
  instead of crashing.
- **Out-of-process for untrusted or foreign code** (MCP, HA add-ons). In-process plugins (VS Code, Obsidian, HA custom
  integrations) are trusted by installation. Node has no in-process sandbox worth relying on.

### A.4 Manifest shape (proposal)

Every new field is optional, and its absence means today's behaviour. `apiVersion` absent means 1.

```ts
// PROPOSAL, not code. Additive to ModuleDefinition.ts:94-117.
defineModule({
  apiVersion: 2,                          // module API this was written against; the host supports a range
  id: "music", name: "Music", description: "Plays music on the device you talk to.",
  version: "0.3.0",                       // the module's own version: shown in the UI, keys storage migrations
  kind: "capability",

  settings: { /* unchanged Setting.* fields */ },

  connections: [                          // NEW: connection types it uses (defined here or in another module)
    { type: "spotify", scope: "per-user", required: false,
      scopes: ["user-modify-playback-state", "user-read-playback-state"] }
  ],

  requires: [                             // NEW: read without starting; see §C
    { tool: "mpv", where: "playback-device", version: ">=0.35", optional: true,
      why: "Plays radio streams on the device itself" },
    { tool: "yt-dlp", where: "server", managed: "yt-dlp", why: "Resolves stream URLs" },
    { network: "internet" }
  ],
  platforms: { os: ["linux"], arch: ["x64", "arm64"] },

  storage: { version: 2, migrate: (from, dir) => Effect.void },  // NEW: data/modules/music/, migrated on upgrade
  templates: [{ id: "dj", name: "DJ", prompt: "…", modules: ["music"], suggestedPhrases: ["hey dj"] }],  // NEW

  health: (ctx) => Effect.succeed([]),    // NEW: cheap; returns Issue[] (§C.5); also run by `pva doctor`

  start: ({ settings, setStatus, connections, storage, schedule, events, notify }) => …
  // NEW context members are optional services the host passes only to apiVersion >= 2 modules
})
```

Compatibility:

- **Old modules keep working unchanged.** The host treats a missing `apiVersion` as 1 and passes the same
  `ModuleContext` as today. New context members are added fields, so a v1 module never sees a difference.
- **`requires` and `platforms` are evaluated before `start`.** A module that fails them gets a new state,
  **`unavailable`**, with a reason and fix actions. It is distinct from `error`, where it tried to start and failed.
  `ModuleState` (`snapshot.ts:32`) gains one literal. That is a protocol bump (today version 8,
  `packages/protocol/src/constants.ts:66`), and old pages map an unknown state to `error`.
- **The host declares `MODULE_API = { current: 2, supports: [1, 2] }`.** A module outside that range is
  `unavailable`, with "Written for module API 3; this assistant supports 1–2. Update the assistant."

### A.5 In-repo versus out-of-tree modules

| Option | How | Pros | Cons |
|---|---|---|---|
| **Workspace packages only** (today) | `packages/module-*`, plus one catalog line | one lockfile, one `effect`, typechecked by `pnpm check`, reviewed | every module is a change to this repo |
| **Local modules directory** | `PVA_MODULES_DIR=/var/lib/pva/modules`: each entry is a package with `"pva": { "module": "./src/index.ts", "apiVersion": 2 }`, installed with `pnpm add` into a second workspace that *shares* `effect` and `@pva/core` as peer dependencies | the owner's own modules live outside the repo; upgrades are independent | a duplicate `effect` breaks service identity, so peer dependencies must be enforced; tsx loads TypeScript at runtime; no sandbox |
| **MCP bridge module** | one built-in module, `mcp`, whose settings list MCP servers (stdio command or HTTP URL). Their tools become tools of that module, namespaced, with per-tool switches through the existing `offTools` | any language; out of process; a large existing ecosystem; crashes are isolated | no actions or intents (no `examples` or `say`), extra latency per call, no trustworthy speculative flag (MCP tool annotations such as `readOnlyHint` are hints from the server, so treat every tool as non-speculative and `change` risk unless the owner marks it), stdio servers are still native dependencies |
| **Marketplace** | a registry plus signed packages | discovery | wrong scale for a personal assistant, and a large security surface |

**Recommendation.** Keep workspace packages as the only in-process path through phase 3. Add the **MCP bridge** as the
way to use third-party or foreign code, because it isolates processes and needs no change to the module API. Add the
local modules directory only when the owner has a module he does not want in this repo. Make it trusted-only, enforce
peer dependencies, and have the host refuse to load a module that brings its own `effect`. Detect that by comparing the
resolved `effect` path or a symbol.

**Versioning.** There are two numbers. The first is **`apiVersion`**, an integer for the module-facing API in
`@pva/core`. Raise it only for a breaking change, and support the previous one for at least one release with a
logged deprecation. The second is the module's own **`version`** (semver), used for display and storage migrations.
Workspace modules may keep `0.0.0` until something external depends on them.

---

## B. Configuration layers

### B.1 Layers

| Layer | Scope | Holds | Exists today |
|---|---|---|---|
| **Install** | one server process | data directory, address and TLS, vault path and password source, the managed-tools directory, the arch | `.env` bootstrap |
| **Household** | everyone, every device | location, time zone, language and locale, units, **currency**, **members**, **rooms**, **quiet hours**, default search provider, the household policy ceiling | Home section (location, time zone, language, units, date format) |
| **Module (shared)** | one module | its settings; the household-owned connection it uses | `modules[id].settings` |
| **Connection** | one account | credentials (in the vault), owner (household or a member), granted scopes, health | — |
| **Assistant** | one persona | prompt, agent, voice, look, modules on with own values and `offTools`, the assistant's policy | `Assistant` |
| **Device** | one device | room, assignments, phrases, voice and look override, audio, **default member**, **device policy** (restrict only), quiet-hours exception | `DeviceSettings` and `own` |
| **Member (user)** | one person | name, how they are recognised (device default, typed choice, later voice), their own connections (Spotify, calendar), preferences (units, news sources) | — |

### B.2 Where each example belongs

| Item | Layer | Reason |
|---|---|---|
| Location, time zone, locale, units, currency | Household (linked defaults into modules, as today) | a module may override for an assistant ("weather for my parents' town") |
| Household members | Household (the list), Member (the details) | |
| Rooms | Household (the list); Device picks a room | "lights in here" becomes the device's room, which feeds the HA module's area lookup |
| Quiet hours | Household default; a Device may opt out (the bedroom node mutes earlier) | they gate *notifications* and spoken volume, never answers to a direct question |
| Default search provider | Household, overridable per assistant (an `overridable` field of a `search` module) | |
| API keys (Anthropic, Deepgram, …) | Install/shared sections in the vault (as today) | not per user |
| OAuth accounts | Connection; owned by the household (a shared Google calendar) or a member (my Spotify) | |
| Which modules an assistant may use | Assistant (`modules[id].on`, `offTools`; exists) | |
| Per-device overrides | Device (`own`; exists for voice and look) | extend to room, default member, policy |
| Risky-tool policy | Household ceiling, then Assistant, then Device; **most restrictive wins** | §B.5 |
| "My Spotify versus yours" | a Member's connection, chosen by the current speaker | §B.4 |

### B.3 Precedence (proposal)

There are two different rules, because a preference and a permission must not combine the same way.

**Values** (what to do): the most specific layer wins. Per field:

```
member preference (if the field is member-overridable and a member is known)
  > device own (if device-overridable)
  > assistant own (overridable; exists)
  > module shared: environment > saved (exists)
  > household linked default (exists for Home)
  > module default
```

An environment value keeps locking only the *shared* layer, as today. An assistant's own value already wins over it
(docs/ARCHITECTURE.md:251). A field opts in per layer: `overridable: true` becomes
`overridable: ["assistant", "device", "member"]`, and `true` is read as `["assistant"]` for compatibility.

**Permissions** (what is allowed): the policy at each layer is intersected, so a lower layer can only narrow. The
household sets a ceiling ("purchases: never"). An assistant can narrow ("this persona never sends mail"). A device can
narrow ("the hallway node: no door unlocking"). Nothing below the household can widen. This is how the existing
`offTools` already works: it can only remove tools.

**Settings UI.** Every field already shows its `source` (`FieldSource`). Extend that to name the layer the value came
from ("from Household", "this assistant's own", "this device's own"), with **Reset to inherited**. Add one read-only
**Effective settings** view per device × assistant. It answers "why did the kitchen node answer in Fahrenheit?". It is
built from the same resolution functions as the turn's configuration snapshot (`TraceInfo.config`, ASSISTANTS.md
§3.7), so the view and the runtime cannot disagree.

### B.4 Connections and OAuth on a headless server

**Storage.** A connection record is `{ id, type, owner: "household" | memberId, label, scopes, createdAt, status }`
in `settings.json`. Its credential lives in the vault under `connections[id]`: the refresh token, or the token, or the
key. Access tokens stay in memory only. A refresh runs single-flight per connection. When the provider rotates the
refresh token (Spotify can return a new one), the new token is written to the vault at once.

**The locked-vault problem.** The vault locks on every restart unless `PVA_VAULT_PASSWORD` is set, and an unattended
server restarts. Options:

- (a) Accept it: connections are `locked` until the owner unlocks.
- (b) Pass the password with systemd's encrypted credentials ([`systemd-creds encrypt`](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html), `LoadCredentialEncrypted=`,
  optionally bound to the TPM). It is then neither in the environment nor in a file the process user can read
  casually.
- (c) Use Docker secrets in the container path.

Recommendation: (b) for the systemd install and (c) for Compose. The current env-variable path remains as a fallback.

**Flows**, in order of preference for a server the owner reaches from a phone:

1. **Device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)).** The server asks for a code, and the admin page shows the URL and code;
   the owner approves on any device. Nothing needs to reach the server. This is the cleanest flow, as the Codex design
   noted (docs/SETTINGS-UI.md §5.3). [Microsoft supports it](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).
   [Google supports it](https://developers.google.com/identity/protocols/oauth2/limited-input-device) only for
   `openid`, `email`, `profile`, `drive.file`, `drive.appdata` and YouTube scopes, so no Gmail and no Calendar.
   [Spotify does not support it](https://developer.spotify.com/documentation/web-api/concepts/authorization).
2. **Authorization code + PKCE with a loopback redirect** (`http://127.0.0.1:<port>/callback`). It works when the
   browser runs on the server. From a phone, the redirect fails to load, and the admin page then offers a fallback:
   paste the address the browser ended on. The server extracts `code` and `state` and finishes the exchange (rclone
   and gcloud use this). [Spotify](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri) accepts loopback IP literals
   (`127.0.0.1`, `[::1]`) over plain HTTP. It rejects `localhost` (since 2025) and plain-HTTP LAN addresses. Google's
   [out-of-band copy-the-code flow](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration)
   is gone, and loopback is its replacement.
3. **A redirect to the server's own HTTPS name** (`https://assistant.example.net:8787/oauth/callback`, with a DNS-01
   certificate, which the README already suggests for phones). It works with every provider that allows a
   user-registered HTTPS redirect. [Google refuses](https://developers.google.com/identity/protocols/oauth2/web-server) raw private IPs and
   `.local` hosts (the TLD must be on the public suffix list), so the name must be a real domain.
4. **A hosted redirect relay** (Home Assistant's [`my.home-assistant.io/redirect/oauth`](https://contributors.home-assistant.io/core/integrations/oauth2/)). This is not available to us, and it would put
   a third party in the loop.

**Client IDs.** The owner registers his own OAuth app per provider ("bring your own client ID", the Home Assistant
`application_credentials` model). This avoids app verification, but it has consequences. A Google app left in
*Testing* status [issues refresh tokens that expire after 7 days](https://developers.google.com/identity/protocols/oauth2). The owner should set the app to *In production*: with
unverified sensitive scopes, Google then shows an "unverified app" warning but the tokens do not expire. Spotify apps in
development mode are limited to an allowlist of users, which is fine for a household.

**Per-user resolution.** A tool that needs a `per-user` connection resolves it, in order, from:

1. the member speaking, when that is known;
2. the device's default member;
3. a household-owned connection of that type;
4. otherwise it fails with "Whose Spotify? Say 'as Ian' or set a default member for this device."

Identification is the hard part. Speaker recognition is not reliable enough to authorise anything, so a member
identity *selects* an account but never *grants* a permission (§B.5).

### B.5 Risky tools

The current flags are `speculative` (read-only, safe to run early) and `confirm` (core asks), and confirmations are off.
Proposal: every tool and action declares a **risk class**, and policy maps each class to an outcome.

```ts
// PROPOSAL
risk: "read" | "change" | "message" | "money" | "security"
// read: lookups. change: lights, music, timers. message: send mail or chat as the owner.
// money: purchases, bookings. security: locks, alarms, garage, cameras.
Policy = Record<Risk, "allow" | "confirm" | "deny">
// Household default: { read: allow, change: allow, message: confirm, money: deny, security: deny }
```

- The effective policy is the most restrictive of household, assistant and device. `deny` means the tool is left out
  of that turn's registry, so the model never sees it.
- `confirm` uses core's existing spoken confirmation (AGENTS-AND-INTENTS §3.2). It must be switched on first, because
  today it is the single literal `"off"`. Core already words the question itself and never takes it from the module.
- `security` and `money` also need the **device** to be trusted. A device flag `allowRisky: false` is the default for
  every device except the ones the owner marks. That way an open window, a TV or a visitor at the front door cannot
  unlock anything.
- A missing `risk` is inferred: `speculative: true` means `read`, and anything else means `change`. Existing modules
  keep their behaviour.

---

## C. Native dependencies and deployment

### C.1 What modules will need, and where it must run

| Tool | Typical module | Must run on | Comment |
|---|---|---|---|
| ffmpeg | music, radio, recordings | the server (transcode) or the playback device | static builds exist for x64 and arm64 |
| yt-dlp | media lookup | the server | needs frequent updates (site changes), so it conflicts with strict pinning |
| mpv | local playback | **the device with the speaker** | |
| playerctl | control a desktop player | the desktop that runs the player | MPRIS over D-Bus; desktop only |
| librespot or spotifyd | a Spotify Connect target | **the device with the speaker** | then the server only uses the Spotify Web API. [librespot](https://github.com/librespot-org/librespot/releases) is maintained (v0.8.0, 10 November). Password login is gone since v0.5, so it uses OAuth or zeroconf. It needs Premium |
| a headless browser | web automation | the server | Playwright downloads pinned builds itself |
| sqlite | module storage | the server | the [`node:sqlite`](https://nodejs.org/api/sqlite.html) built-in (unflagged since Node 22.13; release candidate since 25.7), so no native dependency |
| python | a module wrapping a Python library | the server | prefer an MCP server or a container over pip on the host |
| GPU libraries | faster local models | the server | driver-dependent: container toolkit or host |
| model files | speech, wake word | the server; wake-word models on the node | already handled by jobs |

**Key point: playback is a device concern.** In serve mode the server never touches a sound card; browsers and nodes
play the PCM it sends. Music has three routes:

1. **An external player**: Spotify Connect, a Home Assistant `media_player`, Chromecast. The module calls an API, needs
   no native tool, and works with the browser device too. *Start here.*
2. **The server streams media to the device** over the existing reply channel. Today that channel is mono s16 PCM at
   the voice's rate, so music would need a new stereo or compressed media channel and mixing (ducking during a reply).
   That is a large protocol change.
3. **A player on the device.** The voice node runs `mpv` or `librespot` and the server commands it. This requires
   **device capabilities**: the node already reports `platform` in `hello` (VOICE-NODES §4.2). It would also report
   `capabilities: { players: ["mpv@0.37", "librespot@0.6"] }`, and the music module's requirement
   `where: "playback-device"` is checked per device. The installer or the self-update fetches the pinned player for
   the node's arch.

### C.2 The four strategies

| | (1) Strict image | (2) Declared + health + disabled with reason | (3) Self-installing, managed binaries | (4) Container or Nix packaging |
|---|---|---|---|---|
| How | one supported installer or image with every tool; the start fails or the module is refused | modules declare `requires`; the host probes them; an unmet requirement makes the module `unavailable` with a reason, a fix and a spoken line | pinned binaries (URL and SHA-256 per arch, in the source tree) downloaded into `data/tools/` from the admin UI as a job | Dockerfile or Compose, or a Nix flake, building the whole system |
| Owner effort | lowest once it works | low: clear messages | lowest per module | low (Compose), high (Nix) |
| Works on any distro | only the supported one | yes | for tools with static builds | yes |
| Multi-arch | build each | yes | needs per-arch pins | buildx; Nix supports both |
| Security | best: reviewed at build time | neutral | downloads at runtime: needs pins, checksums, and no `latest` | good: image digests, Nix hashes |
| Updates | rebuild | the owner's package manager | per tool, from the UI | rebuild or pull; `nix flake update` |
| Failure mode | a hard stop | graceful | a download fails or upstream moves | image size, GPU and audio passthrough |
| Fits a personal project | too rigid alone | **required in every case** | good for 3–5 tools | **good as the reference install** |

These are not alternatives. **(2) is the contract in every deployment**: even in a perfect image, a tool can be
missing, broken or the wrong version, and the module must say so instead of failing inside a turn. (4) is the
reproducible way to satisfy (2) on the server. (3) covers the few tools that change faster than the image, or that a
bare-metal owner does not want to install by hand.

### C.3 Requirement declaration and probing (proposal)

```ts
// PROPOSAL
type Requirement =
  | { tool: ToolId; where: "server" | "playback-device" | "listening-device"; version?: string /* semver range */;
      optional?: boolean; managed?: ManagedToolId; why: string }
  | { network: "lan" | "internet" }
  | { memoryMb: number } | { diskMb: number } | { gpu: "cuda" | "vulkan" }

// One registry in the app, not in modules: how to find and check each tool.
const tools: Record<ToolId, { probe: { argv: string[]; version: RegExp }; packages: { debian: string; arch: string;
  nix: string }; managed?: ManagedToolId }> = {
  ffmpeg: { probe: { argv: ["ffmpeg", "-version"], version: /^ffmpeg version n?(\d+\.\d+)/ },
            packages: { debian: "ffmpeg", arch: "ffmpeg", nix: "ffmpeg" }, managed: "ffmpeg-static" },
  …
}
```

- **The probe** resolves on a fixed `PATH` plus `data/tools/bin` first, runs the version argv with no shell and a 5 s
  timeout, and caches the result. It runs at startup (cheap and concurrent, never on the turn path), on **Check
  again**, and whenever a spawn fails with `ENOENT` or `EACCES`, which marks the tool missing at once.
- **Lazy versus startup.** Server-side requirements are probed at startup, so the module is `unavailable` before
  anyone asks. Device-side requirements are judged when the device connects (from its reported capabilities) and
  again per turn from the device the turn runs on. A module can run while one device lacks the player: that device
  gets "music isn't set up on this speaker".
- **Fix actions** come from the registry: the package-manager command for the detected distro (shown, never run as
  root by the server), **Install managed copy** when one exists, or "rebuild the image with …".

### C.4 The spoken explanation

An `unavailable` module contributes no tools, so the model would improvise. Options: (a) one instructions line per
unavailable module the assistant has on ("Music is not set up on this server (yt-dlp is missing). If asked, say so; the
owner can fix it in Settings › Health"), which changes the cached prefix only when availability changes; or (b) a stub
tool that returns the reason. Recommend (a): no tool round, a one-sentence answer. For the intent path (Jev), a module's
actions stay *known* to the decider while it is unavailable, and core answers with a canned line, so "play jazz" does
not fall through to some other action.

### C.5 `pva doctor` and the health page

- **`pnpm start doctor`** is a new CLI mode next to the ones in `apps/assistant/src/main.ts:270-287`. It reads the
  saved settings read-only, like the other CLI modes. It runs the core checks: Node version, `tar` and bzip2, `flock`,
  `nice`, disk space in the data, model and tool directories, the model files of every assistant, vault state, port
  free, TLS files readable, clock sync. It then runs every module's `requires` and `health()`. It prints one line per
  issue with its fix, and exits non-zero on an error. This is the [Homebrew](https://docs.brew.sh/Manpage) and [Flutter](https://docs.flutter.dev/reference/flutter-cli) `doctor` pattern, and it is
  what an installer and CI run after install.
- **Admin › Diagnostics › Health** shows the same issues live, grouped by module and device, each with a fix button
  (a job). The model is Home Assistant's [Repairs](https://contributors.home-assistant.io/core/integrations/repairs/): an *issue registry* with `severity`, `is_fixable`, a fix flow, and
  "ignore". [System Health](https://contributors.home-assistant.io/core/integrations/system-health/) adds a per-module info panel (version, connection status, last error).
  Proposed shape: `Issue = { id, module?, device?, severity, title, detail, fix?: { kind: "job" | "link" | "command", label } }`.

### C.6 Managed binaries (option 3) and download security

- **Pinned table in the source tree**: `{ id, version, assets: { "linux-x64": { url, sha256 }, "linux-arm64": … } }`.
  This is the same pattern as the voice-node runtime manifest. A bump is a code change that gets reviewed. The UI
  never accepts a URL.
- **Download.** Reuse `@pva/core/download` (disk check, `.part`, stall timeout). **Add SHA-256 verification.** It is
  missing today, even for the speech models (`download.ts:207` checks only the length). Install into
  `data/tools/<id>/<version>/`, then switch the `data/tools/bin/<id>` symlink atomically. Keep the previous version
  for rollback.
- **Fast movers (yt-dlp).** Allow "update to latest" only when upstream publishes checksums *and* a signature the code
  can verify. yt-dlp [publishes `SHA2-256SUMS` and a GPG signature](https://github.com/yt-dlp/yt-dlp/blob/master/README.md) for it. Otherwise stay pinned and bump in code.
- **Not managed:** anything that needs root or shared libraries (mpv, librespot builds against ALSA or PulseAudio,
  GPU stacks). These come from the distro, the image, or the node installer.
- **Prior art.** [Playwright](https://playwright.dev/docs/browsers) downloads browsers into `PLAYWRIGHT_BROWSERS_PATH` with `--with-deps` for the OS
  libraries. npm `optionalDependencies` with `os`/`cpu`/`libc` per-platform packages are how `sherpa-onnx-node`,
  esbuild and sharp ship native code. This repo already relies on that pattern, so it is the preferred route for
  anything available on npm. [`youtube-dl-exec`](https://github.com/microlinkhq/youtube-dl-exec) downloads the *latest* yt-dlp at postinstall, which is the
  anti-pattern: it is unpinned and unverified. [mise's `mise.lock`](https://mise.jdx.dev/dev-tools/mise-lock.html) is the closest model for the pinned table: per
  platform it stores a URL and a checksum. Its [aqua backend](https://mise.jdx.dev/dev-tools/backends/aqua.html) also verifies GitHub attestations, cosign and SLSA
  provenance where upstream publishes them.

### C.7 Topology

| | One server + thin clients | Several full installs |
|---|---|---|
| Model and module setup | once | per box |
| Settings, vault, connections | one place | duplicated, and no sync exists |
| Native tools | the server, plus players on nodes | everywhere |
| Latency | one LAN hop for audio (measured per turn by `TurnTrace`) | none |
| Fits the current design | yes: sessions per device, a resource pool, voice nodes | no: `DataDirLock` assumes one writer per data dir |

**Recommendation: one server plus thin clients.** Browsers and voice nodes need no module dependencies except players
(C.1 route 3). A second full install only makes sense as a separate household. The LAN hop must be checked with
`TurnTrace` numbers after the move, not assumed.

### C.8 Reproducible install path

1. **systemd installer script** (`deploy/install.sh`), the first target. It runs on Debian 13 or Ubuntu 24.04, on
   x64 and arm64. It installs a pinned Node runtime by SHA-256 (as the voice node does) and the apt packages from the
   tool registry. It creates a `pva` system user and installs `/etc/systemd/system/pva.service` with hardening
   (`ProtectSystem=strict`, `ReadWritePaths=` the data, vault and tool directories, `NoNewPrivileges`). The vault
   password comes in through `LoadCredentialEncrypted=`. The script then runs `pnpm install --frozen-lockfile`,
   downloads the models, and finishes with `doctor`. The user unit used today keeps working for desktop use.
2. **Docker Compose** with one multi-arch image (`linux/amd64`, `linux/arm64`, buildx). It is based on Node 22 slim
   plus `tar bzip2 util-linux ffmpeg`. It has volumes for `data/`, `models/`, the vault directory and the Claude Code
   config directory (the subscription login lives there, docs/SETTINGS-UI.md §5.2). It is pinned by digest, and the
   vault password is a Docker secret. Audio passthrough is not needed in serve mode. GPU passthrough is optional (the
   NVIDIA container toolkit).
3. **Nix flake**: only if the owner already uses Nix. `sherpa-onnx-node`'s prebuilt `.node` files and the Claude Code
   binary would need `autoPatchelf` or `nix-ld`, which is real work for little gain here.

### C.9 Module data, backups and upgrades

- Module storage goes under `data/modules/<id>/`. It holds JSON files or a `node:sqlite` database. A
  `storage.version` is kept in `data/modules/<id>/.version`.
- **On upgrade**, before `start`: if the stored version is lower, copy the directory to `.v<old>-backup` (the pattern
  `settings.json` already uses for its v1 and v3 migrations), run `migrate(from, dir)`, and write the new version. A
  failed migration restores the backup and marks the module `error`. If the stored version is *higher* (a downgrade),
  the module is `unavailable` and the data is not touched.
- **`pnpm start backup <file>`** writes `data/` (settings, module data, favourites, without `recordings/` unless
  asked) plus the vault file, which stays encrypted, into one archive. It takes the writer lock so the snapshot is
  consistent. `restore` is the reverse, done while stopped. Models and managed tools are excluded because they can be
  downloaded again.

### C.10 Recommendation and phases

**Recommendation.** Make (2) the contract: declared requirements, health checks, `unavailable` with a reason and a
spoken line. Ship the systemd installer first and Docker Compose second as the reproducible server paths. Use (3) only
for the few tools that need it (yt-dlp, ffmpeg-static), always pinned and checksummed. Put players on the playback
device, through device capabilities. Do not make (1) a hard rule, and skip Nix unless the owner already lives in it.

| Phase | Content | Needed for |
|---|---|---|
| **0, before the server move** | `doctor` mode with the core checks; `deploy/install.sh` + system unit; SHA-256 for model downloads; `backup`/`restore`; the TPM or credential path for the vault password | the move itself |
| **1** | `apiVersion`, `version`, `requires`, `platforms`, `health` on `defineModule`; the `unavailable` state (protocol bump); the tool registry; the Health page; the spoken notice | the first module with a native dependency |
| **2** | household members, rooms, quiet hours, currency; the connections layer with the device-code and loopback-paste flows; risk classes and policy; confirmations switched on | Google or Spotify, purchases, locks |
| **3** | Docker image (multi-arch); managed tools directory with yt-dlp and ffmpeg; module storage and migrations; background jobs and notifications | media modules, reminders |
| **4** | voice-node capabilities and on-device players; assistant templates; MCP bridge; the local modules directory if wanted | music on nodes, third-party tools |

---

## Open questions for the owner

1. **Who are the users?** Is it you alone, or household members with their own accounts? Members (B.1) and per-user
   connections (B.4) are phase 2 only if the answer is "several".
2. **Identification.** Is "device default member + say 'as Ian'" acceptable, or do you want voice-based speaker
   recognition (selection only, never authorisation)?
3. **Vault on the server.** Is it fine to unlock it unattended with a TPM-bound systemd credential, or should the
   server wait for you to unlock after every restart?
4. **OAuth client IDs.** Will you register your own Google and Spotify apps (bring your own client ID)? Do you have,
   or want, a real domain with a DNS-01 certificate for the server, so that redirects work from a phone?
5. **Music route.** Is an external player (Spotify Connect, HA `media_player`) enough at first, or must the voice node
   itself play music (librespot or mpv on the node)?
6. **Risk defaults.** Are `message: confirm`, `money: deny` and `security: deny` right? Which devices count as
   trusted?
7. **Install target.** Is the server Debian/Ubuntu on x64, or an arm64 box? Systemd script first, or Docker Compose
   first?
8. **Third-party code.** Is the MCP bridge enough for outside tools, or do you want out-of-tree TypeScript modules as
   well?
9. **Fast-moving tools.** May the UI update yt-dlp to the latest *signed* release, or should every version bump be a
   code change?
10. **Providers as modules.** Do you ever expect someone else to ship an STT or TTS provider? If not, providers stay
    outside the module system for good.

## Sources and verification

The links are inline where each claim is made. They were checked on 2026-11-17. Home Assistant's developer docs
moved to `contributors.home-assistant.io` (the old `developers.` URLs redirect there).

Not verified: VS Code's `SecretStorage` page (it did not load), n8n's official OAuth2 credential reference (only
community examples), OVOS `settingsmeta` (in the Mycroft and Neon docs, not the current OVOS manual), where HA
installs pip packages, how My Home Assistant forwards the code on a LAN, whether `ffmpeg-static` checks checksums,
and the year of librespot 0.8.0.

Further references:
[npm `os`/`cpu`/`libc`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json),
[esbuild](https://esbuild.github.io/getting-started/), [sharp](https://sharp.pixelplumbing.com/install/),
[Nix flakes](https://nix.dev/concepts/flakes.html),
[npm provenance](https://docs.npmjs.com/generating-provenance-statements),
[cosign](https://docs.sigstore.dev/cosign/verifying/verify/), [SLSA v1.2](https://slsa.dev/spec/v1.2/),
[MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation),
[MCP registry](https://modelcontextprotocol.io/registry/about),
[Claude Code marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
[HA options flow](https://contributors.home-assistant.io/core/integrations/options-flow/).
