# Module investigation: overview and suggested order of work

Read this first. It consolidates 62 research documents (7 foundation documents and 55 module documents) to choose work
from; with this overview and the modules README the set is 64 files. Nothing here is decided: the lead's positions are
recommendations, each marked **the owner's decision**.

## 1. What this is

- **Date:** 2026-11-17 for the first round (22 modules), 2026-11-18 for the second (33 more), against `main` at
  `70b15ec` (protocol 8); nothing was built or run. **Scope:** what a module is, which modules to add, what they need
  from the core (the *foundations*), how native tools are installed and checked, how results are shown, how state and
  notifications work across devices, and what to deploy first, now that the assistant is moving to a server.
- **Organisation:** seven foundation documents in this folder (one inventory of the code, three outward-looking
  landscape surveys, three designs for the shared pieces) and 55 module documents in [`../modules/`](../modules/README.md), each
  following the same 15-section template. Module documents use the foundation names listed in the
  [modules README](../modules/README.md#shared-foundations-the-module-documents-refer-to); the second round also asks for core pieces the first did not have
  ([section 6](#6-foundations), second table).
- **Conventions:** links point at the section with the detail. Waves and S/M/L/XL sizes are the module documents' own; S
  means "about a day" in [launchers §7](landscape-launchers-and-agent-tools.md#7-candidate-modules-for-us) but "a few days" in
  [voice §17](landscape-voice-assistants.md#17-candidate-modules-for-us), so compare sizes within one table.

**Reading guide.**

| Document | One line |
|---|---|
| [current-system.md](current-system.md) | What the code does today, each claim marked implemented, built-not-wired, designed-only or absent; 26 gaps |
| [landscape-voice-assistants.md](landscape-voice-assistants.md) | Alexa+, Gemini for Home, Siri, HA Assist, OVOS, Leon and others: what they offer, what broke, what people use |
| [landscape-automation-platforms.md](landscape-automation-platforms.md) | Home Assistant, n8n, Node-RED, Zapier and the self-hosted household apps: integrate or build |
| [landscape-launchers-and-agent-tools.md](landscape-launchers-and-agent-tools.md) | Raycast, Alfred, MCP, ChatGPT, Claude, OpenClaw: the core toolbox, web search prices, MCP as a client |
| [module-definition-config-and-dependencies.md](module-definition-config-and-dependencies.md) | Module manifest, configuration layers and precedence, connections and OAuth, risk classes, native tools, doctor, deployment |
| [shared-state-jobs-and-notifications.md](shared-state-jobs-and-notifications.md) | Module store (SQLite), scopes, tool context, people, scheduler, event bus, notification service, announce |
| [presentation-and-device-capabilities.md](presentation-and-device-capabilities.md) | Presentation kinds, the character sharing the stage, device capabilities, degradation, "send it to the kitchen screen" |
| [../modules/README.md](../modules/README.md) | Template, foundation names, and the module index grouped by theme |
| 55 module documents | One line, wave, effort and needs for each in [section 7](#7-module-catalogue), grouped into eight themes |

## 2. Short answers to the owner's questions

**What is a module?** The unit of packaging, switching on, configuration and health. It declares what it needs
(settings, secrets, connections, native tools, storage) and contributes tools, typed actions, context, instructions and,
newly, jobs, events, notifications, presentations and assistant templates. A tool is one function inside it. Detail in
section 3 and [module-definition A](module-definition-config-and-dependencies.md#a-what-a-module-is).

**Which modules and tools should we add?** First the deterministic basics that the LLM-era assistants broke: assistant
controls (a reliable "stop"), timers and alarms, lists, reminders, plus the keyless core tools and web search. Then the
owner's wish-list items: kitchen, Google, music, images (the kiwi), T3 Code, video, and from the second round calls,
news feeds and n8n. The full catalogue of 55 with waves is section 7; the order is section 8.

**What interaction and configuration do they need?** Every module document lists spoken examples, tools with risk and
fast-path columns, and settings by layer (household, module, assistant, device, person) in its §3, §4 and §10. Most need
the tool context (which device, room, person asked) and a fast path for the commands that must not wait on a model. See
[core-tools §10](../modules/core-tools.md#10-configuration) for a small example and [kitchen §10](../modules/kitchen.md#10-configuration) for a large one.

**What global configuration is needed?** A household layer with location (better: a list of saved places), time zone,
language, units, currency, members, rooms, quiet hours, default providers and a risk ceiling. Table in section 10;
layers in [module-definition B.1](module-definition-config-and-dependencies.md#b1-layers).

**How do we make sure native tools are installed, and what happens when they are missing?** Modules declare `requires`
(tool, where it must run, version, optional). The host probes at startup and per device; an unmet requirement makes the
module `unavailable` with a reason, a fix and one instructions line, so the assistant says "Music is not set up on this
server (yt-dlp is missing)" instead of failing in a turn. `pva doctor` runs the same checks from the CLI; an installer
script and Docker Compose satisfy them reproducibly; a few fast-moving tools can be managed binaries pinned by SHA-256
([C.2–C.6](module-definition-config-and-dependencies.md#c2-the-four-strategies)). Section 9 lists every tool.

**How is "an image of a kiwi" presented?** The image tool returns data in a closed catalogue of about 15 kinds (`image`
here). The server fetches the image once and serves it from `/media/`. The character "holds it up": the card grows out
of the character's box as the assistant says "here's a kiwi", then settles beside it. On a device without a screen the
assistant says it cannot show pictures here, describes the kiwi in one sentence and offers the nearest screen
([presentation §3.6](presentation-and-device-capabilities.md#36-speech-and-visuals-together), [§4.1](presentation-and-device-capabilities.md#41-layouts-host-level-every-character),
[images §8](../modules/images-and-photos.md#8-presentation)). The source order is a disagreement (section 11, f).

**How do long-running things like a timer work across devices and assistants?** A timer is a household row in the module
store plus a scheduler job at a wall-clock time, so it survives restarts and every device and assistant sees the same
timer. It rings where it was set (falling back to that room), and "stop" on any device resolves it everywhere.
Assistants without the timers module still see running timers through short "ambient facts" in the per-turn context
([shared-state §9](shared-state-jobs-and-notifications.md#9-two-worked-examples), [§7](shared-state-jobs-and-notifications.md#7-how-any-agent-sees-another-modules-state),
[timers §7](../modules/timers-and-alarms.md#7-long-running-work-and-events)).

**How is household data (to-do list, pantry, recipes) shared?** One SQLite file through a core store with scopes
(household, person, assistant, device, conversation) and a change log that feeds an event bus and lets screens update
live. Lists own the shopping list and offer a `Lists` service; kitchen books stock as a ledger of deltas; external apps
(Grocy, Mealie, Todoist, HA to-do) are providers behind the same tools ([shared-state §4](shared-state-jobs-and-notifications.md#4-the-shared-data-layer),
[lists §5](../modules/lists.md#5-integrate-or-build), [kitchen §5](../modules/kitchen.md#5-integrate-or-build)).

**How does a device tell the agent what it can and cannot do?** It declares hardware (display class, touch, speaker,
renderable kinds) in `hello`; the owner sets its place (room, private/shared/public, always-on) in admin; overrides can
only remove. The agent gets one line in the per-turn context, tools stay present, and the server decides at run time and
tells the model what happened (HA's timer pattern) ([presentation §5](presentation-and-device-capabilities.md#5-device-capabilities),
[§5.4](presentation-and-device-capabilities.md#54-how-the-capabilities-reach-the-agent)).

**How do notifications work?** One notification service with kinds, four priorities, an audience, a ring policy, quiet
hours and do-not-disturb, an inbox for what was missed, a wake-phrase-free "stop/snooze" while something rings, a
recorded `Announce` that waits for the reply to finish, and optional phone channels
([shared-state §8](shared-state-jobs-and-notifications.md#8-notifications), [notifications module](../modules/notifications.md#1-summary)). Which phone channel comes first is
disputed (section 11, c).

## 3. What a module is

**Today** a module is a plain value made with `defineModule`: an id, a name, a settings schema and a `start` function
that runs in a host-owned scope and returns tools, per-turn context, stable instructions and, for agent and decider
modules, an agent or decider ([current-system §1.1](current-system.md#11-the-contract-implemented)). Modules are compiled in: one file plus one
line in the catalogue ([§1.2](current-system.md#12-registration-and-loading-implemented)). A module cannot store data, schedule, speak unprompted, show
anything or declare a native dependency ([§9](current-system.md#9-gaps-a-module-ecosystem-would-need)).

**Proposed:** the new manifest fields are all optional, so old modules keep working: `apiVersion`, `version`,
`requires`, `platforms`, `connections`, `storage`, `templates`, `health` ([A.4](module-definition-config-and-dependencies.md#a4-manifest-shape-proposal)). New
services (store, scheduler, notifications, events) reach only `apiVersion >= 2` modules
([shared-state §4.4](shared-state-jobs-and-notifications.md#44-declaring-data-proposal)).

| Term | What it is | Who makes it | Today |
|---|---|---|---|
| Module | Packaging, switch, settings, health; contributes the rest | developer; owner switches it on per assistant | yes |
| Tool | One function the model can call, with a schema; always from a module | a module | yes |
| Action | Typed command for the intent path (Jev), also offered as a tool | a module | yes; intent path not wired |
| Connection | Authenticated link to one outside account, owned by the household or a person, shared by modules | owner, through a flow | no (HA URL and token are module fields) |
| Provider | Latency-critical pipeline adapter (`Llm`, `Stt`, `Tts`, audio), pooled and warmed | developer | yes; stays outside the module system |
| Agent | What answers a turn (`model`, `harness`, `intent`) | module of kind `agent` | yes |
| Assistant | Owner-configured persona: prompt, agent, voice, look, modules, policy. Data, not code | owner | yes |
| Assistant template | Suggested assistant a module ships ("Chef", "DJ"); the owner instantiates it | a module | no |
| Front end / device type | Protocol client that hears, plays or shows (`web-voice`, later `voice-node`) | developer | `web-voice` only |

Source: [A.1](module-definition-config-and-dependencies.md#a1-definitions-proposal). Wake phrases stay with device assignments
([A.2](module-definition-config-and-dependencies.md#a2-what-a-module-may-contribute)); foreign code comes through the MCP bridge
([A.5](module-definition-config-and-dependencies.md#a5-in-repo-versus-out-of-tree-modules)).

## 4. What exists today and the gaps

From [current-system.md](current-system.md):

- **Modules:** `clock`, `weather` (Open-Meteo), `home-assistant` (lights only) and the `claude-subscription` agent;
  `demo-home` and Jev are built, not wired ([§1.4](current-system.md#14-the-existing-modules-tool-by-tool-implemented-unless-stated)).
- **Tools** get only their input: no device, assistant, conversation or person. Results never reach a client; no
  streaming or background jobs ([§2](current-system.md#2-what-a-tool-is)).
- **Confirmation** is built but switched off, so no confirmed action can run ([§2.5](current-system.md#25-confirmation-of-actions)).
- **Devices** are browsers with no capability description and no room; voice nodes are on unmerged branches
  ([§4](current-system.md#4-devices-and-front-ends)).
- **Display:** character, captions, chat, tool chips; nothing lets a tool show anything
  ([§5.3](current-system.md#53-a-channel-for-tools-to-push-visual-content-absent)).
- **Configuration:** env, shared sections, module settings, assistant overrides, closed device settings; no person layer
  ([§6](current-system.md#6-configuration)).
- **Persistence:** JSON files only; no module store, scheduler, timers that survive a restart, proactive speech API or
  notifications ([§7](current-system.md#7-persistence-and-background-work)).
- **Deployment:** a systemd user service; no unit file, installer or packaging in the repository; model downloads are
  not checksummed ([§8](current-system.md#8-deployment), [module-definition §0](module-definition-config-and-dependencies.md#0-what-exists-today)).

The 26 gaps in [§9](current-system.md#9-gaps-a-module-ecosystem-would-need) map onto section 6: tool context (1), presentation (2, 3, 23), device
capabilities (4–6), notifications (7, 9), scheduler (8, 17, 22), store (10–12), requirements (13, 26), outside code (14,
15), confirmation (16), fast path (18), people (24).

## 5. What the landscape says

1. **What people use is short and stable:** music, quick questions, weather, timers and alarms, smart home; only 48 % of
   owners had ever used a third-party voice app in 2020 ([voice summary](landscape-voice-assistants.md#summary), [§13](landscape-voice-assistants.md#13-usage-data)).
   YouGov 2025: weather 59 %, music 51 %, quick answers 47 %, timers 40 %, smart home 19 %
   ([launchers summary](landscape-launchers-and-agent-tools.md#summary)). Automation platforms show the same household set
   ([automation summary](landscape-automation-platforms.md#summary)). Recipes are the one domain where LLMs clearly raised use
   ([voice §13](landscape-voice-assistants.md#13-usage-data)).
2. **The LLM rebuilds broke the basics.** Alexa+ and Gemini for Home: slow timers, lost lists, wrong rooms, 10–40 s
   silences, invented state, alarms that could not be stopped in an outage. Timers, alarms, lists and "stop" must be
   deterministic, fast and local ([voice §16](landscape-voice-assistants.md#16-mistakes-to-avoid)).
3. **Fast path first, model second** (HA "prefer local", OVOS pipeline, Google Quick Phrases)
   ([voice §15](landscape-voice-assistants.md#15-patterns-worth-copying), [automation §12](landscape-automation-platforms.md#12-patterns-worth-copying)).
4. **Household behaviour is where commercial assistants lead:** device-bound timers, broadcast, guest-safe personal
   results, pending-notification indicators; notifications wait, never upsell ([voice §15](landscape-voice-assistants.md#15-patterns-worth-copying)).
5. **Capability interface plus provider adapters** (HA's `todo` entity over many providers) and **credentials as
   separate, tested, shared objects** (n8n, Activepieces) ([automation §12](landscape-automation-platforms.md#12-patterns-worth-copying)).
6. **Integrate or build:** integrate Grocy, Mealie/Tandoor, Music Assistant, Jellyfin/Plex, Immich, Paperless-ngx,
   Nextcloud via CalDAV/CardDAV, ntfy and Apprise; build timers, alarms, reminders, a local list store, broadcast and
   kitchen helpers ([automation §11](landscape-automation-platforms.md#11-self-hosted-household-apps-integrate-or-build)). The kitchen module departs from this (section
   11, a).
7. **One rich tool beats many narrow ones,** and every tool call costs a model round trip (3.6 s to first text after one
   tool call on the subscription path, [agent-backends.md](../agent-backends.md)) ([launchers summary](landscape-launchers-and-agent-tools.md#summary)).
8. **MCP is the common plug** (stateless since 2026-07-28; tasks and MCP Apps as extensions). Be a client as one module
   kind, keep essentials native; watch tool-count bloat (selection degrades past 30–50 tools), latency and trust
   ([launchers §2.1](landscape-launchers-and-agent-tools.md#21-mcp), [§4](landscape-launchers-and-agent-tools.md#4-should-the-assistant-be-an-mcp-client)). HA's MCP server and client are on
   48,995 and 41,662 installs ([automation §1.1](landscape-automation-platforms.md#11-popularity-ha-analytics)).
9. **No open marketplace** (341 of 2,857 audited ClawHub skills were malicious,
   [launchers §6](landscape-launchers-and-agent-tools.md#6-mistakes-to-avoid)); **push over polling**, and every scheduled thing listable and cancellable
   ([automation §13](landscape-automation-platforms.md#13-mistakes-to-avoid)).

## 6. Foundations

Effort is the source's figure where one is cited; otherwise it is this overview's rough estimate (marked ~).

| Foundation | What it is | Effort | Detailed in |
|---|---|---|---|
| Tool context | `CurrentTurn`: device, room, assistant, conversation, person, source, provided around every tool and action | ~S | [shared-state §4.5](shared-state-jobs-and-notifications.md#45-turn-context-proposal) |
| Module store | One SQLite file (`node:sqlite` via `effect/sql`), scoped collections, change log, daily backup | ~M | [shared-state §4](shared-state-jobs-and-notifications.md#4-the-shared-data-layer) |
| Scheduler | Jobs table, one fiber, wall-clock due times, missed-while-down policy per kind | "small" ([§2.1](shared-state-jobs-and-notifications.md#21-shared-state-and-jobs)) | [shared-state §6](shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler) |
| Event bus | In-process `PubSub` from the change log; `household.*` messages with replay | ~S–M | [shared-state §5](shared-state-jobs-and-notifications.md#5-event-bus) |
| Notification service and announce | Priorities, audience, ring policy, quiet hours, inbox, ringing window, `Announce` | L; announce and inbox S ([notifications §1](../modules/notifications.md#1-summary)) | [shared-state §8](shared-state-jobs-and-notifications.md#8-notifications) |
| Presentation | ~15 kinds, Presenter, stage layouts, reveal timing, `/media/` proxy, `show`/`show_on` | ~L (first four kinds ~M) | [presentation §3–4](presentation-and-device-capabilities.md#3-presentation-what-a-tool-returns) |
| Device capabilities | Hardware in `hello`, place set in admin, remove-only overrides, context line | "small" for hello + line ([§7](presentation-and-device-capabilities.md#7-recommendations-in-one-place)) | [presentation §5–6](presentation-and-device-capabilities.md#5-device-capabilities) |
| Connections | Typed accounts in the vault, household or person owned, device-code and loopback-paste OAuth | ~M–L | [module-definition B.4](module-definition-config-and-dependencies.md#b4-connections-and-oauth-on-a-headless-server) |
| Requirements, health, doctor | `requires`, probes, `unavailable` state, spoken notice, Health page, `pva doctor` | ~M | [module-definition C.3–C.5](module-definition-config-and-dependencies.md#c3-requirement-declaration-and-probing-proposal) |
| Risk classes and confirmation | `read/change/message/money/security`, policy intersected over layers, confirmations switched on | ~M | [module-definition B.5](module-definition-config-and-dependencies.md#b5-risky-tools) |
| Fast path without the model | Typed actions run by Jev or a closed matcher (controls, timers, lights, lists) | matcher S ([controls §1](../modules/assistant-controls.md#1-summary)); Jev ~M | [assistant-controls §5](../modules/assistant-controls.md#5-integrate-or-build), [current-system §3.3](current-system.md#33-routing-and-hey-jev-implemented-in-a-changed-form) |
| People and rooms | `Person` records, device default person, room per device, voice ID only as a hint; presence-and-people proposes owning the records | ~S (voice ID later) | [shared-state §4.6](shared-state-jobs-and-notifications.md#46-identity-who-said-it), [presence §6](../modules/presence-and-people.md#6-data) |

**Core pieces the second round asks for.** None of these is in the first-round foundation documents. Each is proposed by
one module document and needed by the modules listed; no efforts are given unless the source states one.

| Core piece | What it is | Needed by | Detailed in |
|---|---|---|---|
| Images in tool results | `ToolResult.content` as text and image parts, mapped per LLM adapter; frames pruned after the follow-up window | vision (`look`), cameras-and-security (describe), translation (camera text), computer-control (screenshots), images | [vision §5.4](../modules/vision.md#54-how-the-current-adapters-would-carry-an-image) |
| Camera capability, indicator and HTTPS | structured `camera` (facing, permission, barcode, indicator) instead of a boolean, live `cameraOpen`, host-drawn indicator, LED on nodes; a secure context on every screen (DNS-01 domain, Tailscale name or local CA) | vision, translation, plants-and-pets, documents (scanning), calls (video); HTTPS also for cameras push-to-talk and dashboard Wake Lock | [vision §12](../modules/vision.md#12-interaction-with-the-rest-of-the-system), [§8](../modules/vision.md#8-presentation), [calls §5.5](../modules/calls-and-intercom.md#55-calling-from-outside-nat-turn-and-certificates) |
| Voice-session capture mode | recogniser events to a module sink, closed control phrases without the model, PCM to disk, recording badge on every screen in the room | dictation-and-transcription; t3-code dictate would reuse it | [dictation §5.4](../modules/dictation-and-transcription.md#54-long-form-capture-in-the-session) |
| Reading session | a speech path beside `Conversation` that outlives one reply, holds and yields the output lease, pauses on barge-in | read-aloud; documents, messaging and news read through it ([read-aloud Q4](../modules/read-aloud.md#15-open-questions)) | [read-aloud §5.4](../modules/read-aloud.md#54-long-form-speech-a-reading-session-new-core-piece) |
| Session modes in the route gate | wake-free windows with a closed grammar (game scores, workout "next", interpreter, reply windows), "phrase only" mode during calls and game-master turns | tabletop-and-games, health-and-fitness, translation, calls-and-intercom, broadcast | [tabletop §12](../modules/tabletop-and-games.md#12-interaction-with-the-rest-of-the-system), [calls §12](../modules/calls-and-intercom.md#12-interaction-with-the-rest-of-the-system) |
| Voice per language, language from STT, lexicon | `voices: Record<lang, VoiceRef>` on the assistant and a language tag per reply; the recogniser reports the detected language; a separate reading voice; one household pronunciation lexicon on every speech path, names as recogniser hot words | translation, learning, tabletop (voice per character), kids (narrator), read-aloud (`READING_VOICE`); lexicon: read-aloud, contacts, presence | [translation §12](../modules/translation.md#12-interaction-with-the-rest-of-the-system), [§5.2](../modules/translation.md#52-hearing-two-languages-on-one-device), [read-aloud §5.5](../modules/read-aloud.md#55-voice-cost-and-pronunciation) |
| Turn audio ring | the last 15 s of 16 kHz PCM kept in memory in the voice session, never on disk | broadcast (own-voice messages); presence (speaker ID on turn audio) | [broadcast §5](../modules/broadcast.md#5-integrate-or-build) |
| Call audio relay and signalling | frame kind 3 "call audio" with a call-leg id on the device connection; `call.offer/answer/ice` relayed over `/ws`; a `call` activation on voice nodes; `CallTrace` | calls-and-intercom (stages 1–2); emergency (responder call) | [calls §5.2](../modules/calls-and-intercom.md#52-transport-options), [§5.4](../modules/calls-and-intercom.md#54-headless-voice-nodes-as-call-endpoints) |
| Module HTTP routes and callback API | inbound hooks for module routes (current-system gap 21), and `/api/automation/v1` (`say`, `notify`, `present`, `ask`, `turn`) with scoped tokens | automation-platforms; news (changedetection.io), media-requests, homelab (Alertmanager), health (Apple Health), read-aloud (links from phones), emergency (acknowledgements) | [automation-platforms §4](../modules/automation-platforms.md#4-tools), [§13](../modules/automation-platforms.md#13-privacy-and-safety) |
| Module services | typed exports one module calls on another (`Contacts.resolve`, `Lists`, reminders, music's playback routes) | contacts, printers, trips, grocery (`Lists`), home-maintenance (reminders), podcasts (music) | [contacts §4](../modules/contacts.md#4-tools), [podcasts §5.2](../modules/podcasts-and-audiobooks.md#52-who-plays-and-who-keeps-the-position) |
| Widgets from modules | manifest `widgets` field, `dashboard.layout` and `widget.update` messages, a `dashboard` device section, `clock` and `agenda` kinds | dashboard; briefing, images (photo frame), news (ticker) | [dashboard §5.1](../modules/dashboard.md#51-the-widget-contract-proposal) |
| Presentation additions | `live` (camera WebRTC), Call layout, `bands` on `chart`, `breath` style, `reading` and `ticker` hints, split stage, `present.update` | cameras, calls, energy, health, read-aloud, news, translation, trips | [cameras §8](../modules/cameras-and-security.md#8-presentation), [calls §8](../modules/calls-and-intercom.md#8-presentation) |
| Companion agent pairing | a non-speaker device kind that dials out like a voice node, with a pairing code and capabilities and health in `hello` | computer-control (`pva-desk`), dictation (typing into the PC) | [computer-control §5](../modules/computer-control.md#5-integrate-or-build), [§11](../modules/computer-control.md#11-native-tools-and-dependencies) |
| Host-enforced kids policy | per-turn intersection of age-band tools, risk ceiling, forced settings, time windows, volume cap and an output check; a kids flag on the device place | kids; fun-and-ambient, media-requests, video, images, web-search | [kids §5.1](../modules/kids.md#51-policy-enforced-by-the-host) |
| Sensitivity and finer risk | a `personal` tag on reads enforced by Presenter and speech, separate from risk classes; per-target risk and `protected`; private passages only to a local model | finance, health, focus, network, homelab, documents | [finance §4](../modules/finance.md#4-tools), [homelab §13](../modules/homelab.md#13-privacy-and-safety), [documents §13](../modules/documents.md#13-privacy-and-safety) |
| Host-level emergency phrases | matched before routing and the echo gate, not switchable per assistant, exempt from confirmation; fixed sentences cached per language | emergency-and-safety | [emergency §12](../modules/emergency-and-safety.md#12-interaction-with-the-rest-of-the-system), [§13](../modules/emergency-and-safety.md#13-privacy-and-safety) |
| Shared local embedding model | one model (~300 MB) loaded once for search and clustering | documents, memory-and-notes, news-and-feeds | [documents §5.3](../modules/documents.md#53-question-answering-full-text-or-embeddings) |
| Speaker ID and guest mode | speaker embedding in the speech worker beside the transcript (`voiceId.ms` in `TurnTrace`); guest mode hiding personal content on chosen devices | presence-and-people; every module with personal content | [presence §5](../modules/presence-and-people.md#5-integrate-or-build), [§13](../modules/presence-and-people.md#13-privacy-and-safety) |

**Dependency matrix.** ● needed before the module's useful first version; ○ needed for the full version; blank: not
named. Taken from each module's §14 ("Foundations needed"); where a §14 does not separate first from later, its
foundations are marked ○. Rows follow the themes of section 7.

| Module | Tool ctx | Store | Sched | Bus | Notify | Present | Dev caps | Conn | Req/health | Risk | Fast path | People/rooms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [assistant-controls](../modules/assistant-controls.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | ○ | | ○ | | ● | ○ |
| [core-tools](../modules/core-tools.md#14-foundations-needed) | ○ | ○ | | | | ○ | | | ○ | | ○ | |
| [timers-and-alarms](../modules/timers-and-alarms.md#14-foundations-needed) | ● | ● | ● | ○ | ● | ● | ○ | | ○ | ○ | ○ | ○ |
| [reminders](../modules/reminders.md#14-foundations-needed) | ○ | ● | ● | ○ | ● | ○ | ○ | | | | ○ | ○ |
| [web-search](../modules/web-search.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | ○ | | ○ | | | |
| [translation](../modules/translation.md#14-foundations-needed) | ○ | ○ | | | | ○ | ○ | | | | | |
| [presence-and-people](../modules/presence-and-people.md#14-foundations-needed) | ○ | ○ | | ○ | | ○ | ○ | | | | | ● |
| [contacts](../modules/contacts.md#14-foundations-needed) | ○ | ○ | ○ | ○ | | | ○ | ○ | | | | ● |
| [lists](../modules/lists.md#14-foundations-needed) | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| [kitchen](../modules/kitchen.md#14-foundations-needed) | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| [grocery-shopping](../modules/grocery-shopping.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | | ○ | | ○ | | |
| [calendar](../modules/calendar.md#14-foundations-needed) | ● | ○ | ○ | | ○ | ○ | ○ | ● | | | ○ | ○ |
| [memory-and-notes](../modules/memory-and-notes.md#14-foundations-needed) | ○ | ● | ○ | | | ○ | ○ | ○ | | | ○ | ○ |
| [documents](../modules/documents.md#14-foundations-needed) | ● | ○ | ○ | | ○ | ○ | ● | ● | | | | |
| [home-maintenance](../modules/home-maintenance.md#14-foundations-needed) | | ○ | ○ | | | ○ | | ○ | | | | |
| [plants-and-pets](../modules/plants-and-pets.md#14-foundations-needed) | | ● | ○ | ○ | ○ | ○ | | | | | | |
| [finance](../modules/finance.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | ○ | ○ | | ○ | | ○ |
| [notifications](../modules/notifications.md#14-foundations-needed) | ○ | ● | ○ | ○ | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| [broadcast](../modules/broadcast.md#14-foundations-needed) | ○ | ○ | ○ | | ● | ○ | ● | | | | | ● |
| [calls-and-intercom](../modules/calls-and-intercom.md#14-foundations-needed) | ○ | ○ | | ○ | ● | ○ | ● | ○ | ○ | | | ● |
| [messaging](../modules/messaging.md#14-foundations-needed) | ● | ○ | ○ | | ○ | ○ | ○ | ● | ○ | ● | ○ | ○ |
| [emergency-and-safety](../modules/emergency-and-safety.md#14-foundations-needed) | ○ | ○ | ○ | | ● | | ○ | | ● | | ● | ● |
| [google](../modules/google.md#14-foundations-needed) | ● | ○ | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ | ○ |
| [briefing](../modules/briefing.md#14-foundations-needed) | ● | | ○ | ○ | ○ | ○ | ○ | | | | ○ | ○ |
| [news-and-feeds](../modules/news-and-feeds.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | | | | | | |
| [local-info](../modules/local-info.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | | | ○ | | ○ | ○ |
| [trips](../modules/trips.md#14-foundations-needed) | ○ | ○ | ○ | ○ | ○ | ○ | | ○ | | ○ | | ○ |
| [read-aloud](../modules/read-aloud.md#14-foundations-needed) | ● | ● | ○ | | | ○ | | | | | | |
| [dictation-and-transcription](../modules/dictation-and-transcription.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | ○ | ○ | ○ | | | ○ |
| [music](../modules/music.md#14-foundations-needed) | ● | ○ | ○ | ○ | | ○ | ○ | ○ | ○ | | ○ | ○ |
| [podcasts-and-audiobooks](../modules/podcasts-and-audiobooks.md#14-foundations-needed) | ● | ○ | ○ | ○ | | ○ | | ● | | | | |
| [video](../modules/video.md#14-foundations-needed) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | | | | ○ | ○ |
| [media-requests](../modules/media-requests.md#14-foundations-needed) | ○ | ○ | ○ | ○ | ○ | ○ | | ○ | ○ | | | ○ |
| [images-and-photos](../modules/images-and-photos.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ● | ● | ○ | | ○ | ○ | |
| [fun-and-ambient](../modules/fun-and-ambient.md#14-foundations-needed) | | ○ | ○ | | | ○ | ○ | | | | ○ | ○ |
| [tabletop-and-games](../modules/tabletop-and-games.md#14-foundations-needed) | ● | ● | | ○ | ○ | ○ | ○ | | | | ○ | |
| [kids](../modules/kids.md#14-foundations-needed) | ● | ● | ○ | | ○ | ○ | ● | | | ● | | ● |
| [learning](../modules/learning.md#14-foundations-needed) | ● | ● | ○ | | | ○ | | ○ | | | | ● |
| [health-and-fitness](../modules/health-and-fitness.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | ○ | ○ | | ○ | ○ | ○ |
| [focus-and-productivity](../modules/focus-and-productivity.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | | ○ | | ○ | | |
| [smart-home](../modules/smart-home.md#14-foundations-needed) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| [cameras-and-security](../modules/cameras-and-security.md#14-foundations-needed) | | | | ○ | ○ | ○ | ○ | ○ | | ○ | | |
| [energy-and-vehicle](../modules/energy-and-vehicle.md#14-foundations-needed) | | ○ | ○ | ○ | ○ | ○ | | | | | | |
| [network](../modules/network.md#14-foundations-needed) | | | ○ | | ○ | ○ | ○ | | | | ● | ○ |
| [printers](../modules/printers.md#14-foundations-needed) | | | ○ | | ○ | ○ | | | | ○ | | |
| [vision](../modules/vision.md#14-foundations-needed) | ○ | | | | | ○ | ○ | | ○ | | | |
| [dashboard](../modules/dashboard.md#14-foundations-needed) | | | ○ | ○ | ○ | ○ | ○ | | | | | |
| [routines-and-automations](../modules/routines-and-automations.md#14-foundations-needed) | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| [automation-platforms](../modules/automation-platforms.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | ○ | ○ | ○ | ○ | | |
| [mcp-client](../modules/mcp-client.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | | ○ | ○ | ○ | | |
| [browser-tasks](../modules/browser-tasks.md#14-foundations-needed) | ○ | ○ | ○ | | ○ | ○ | ○ | ○ | ○ | ○ | | |
| [computer-control](../modules/computer-control.md#14-foundations-needed) | ○ | | ○ | | | ○ | ○ | | | ○ | | |
| [t3-code](../modules/t3-code.md#14-foundations-needed) | ○ | ○ | ○ | ○ | ○ | ○ | | ○ | | ○ | ○ | |
| [dev-tools](../modules/dev-tools.md#14-foundations-needed) | ○ | | ○ | | ○ | ○ | | ○ | | ○ | | |
| [homelab](../modules/homelab.md#14-foundations-needed) | | ○ | ○ | | ○ | ○ | | | | ○ | | |

Lists, kitchen and memory can start on their own SQLite or JSON file before the shared store exists, but they need
storage either way. Routines, the MCP client, automation-platforms, homelab and contacts also want the `records`
settings field wired to module forms, which is built but not on the wire
([current-system §6.2](current-system.md#62-settings-schema-drives-the-ui-implemented)). First versions outside the twelve columns: read-aloud needs the
reading session (or chunk-per-turn), dictation capture mode, vision's `look` image results, computer-control companion
pairing, automation-platforms an HTTP route, podcasts music's routes, printers, trips and grocery `Lists`, presence,
cameras and energy smart-home's WebSocket cache.

## 7. Module catalogue

"Wish list" quotes the module document; "–" means the document does not say the owner asked for it. Grouped by theme, in
the same order as the matrix in section 6 and the [modules README](../modules/README.md#index).

| Module | What it does | Wish list | Wave | Effort | Needs first | Native tools, accounts, keys | Integrate or build |
|---|---|---|---|---|---|---|---|
| **Basics** | | | | | | | |
| [assistant-controls](../modules/assistant-controls.md) | stop, repeat, volume, mute, switch, show-on | – | first (the very first) | M | fast path | none on server; browser gain node; `wpctl`/`amixer` on nodes | build |
| [core-tools](../modules/core-tools.md) | calculator, time, Wikipedia, random | – | first | M (S pieces) | none | npm only; Wikimedia User-Agent contact | build on mathjs, Frankfurter, Wikipedia |
| [timers-and-alarms](../modules/timers-and-alarms.md) | timers and alarms everywhere | "visible on every screen" is the owner's requirement | first | M (L in practice) | store, scheduler, notify | none; cue files bundled | build |
| [reminders](../modules/reminders.md) | time, repeat, presence reminders | – | first | M (+M presence) | store, scheduler, notify | none; HA or phone automation for presence | build |
| [web-search](../modules/web-search.md) | search, read page, research | – | first | M (research L) | none | SearXNG, or a Brave/Tavily/Exa/Kagi/Perplexity key | build module, integrate providers |
| [translation](../modules/translation.md) | interpreter mode, camera text, subtitles, phrasebook | – | second (phrasebook, camera text earlier) | L (phrasebook S) | voice per language | multilingual recogniser, a voice per language; optional DeepL, TranslateGemma | the model; DeepL or TranslateGemma if `TurnTrace` favours them |
| **Household and people** | | | | | | | |
| [presence-and-people](../modules/presence-and-people.md) | `Person` records, home/away, rooms, speaker-ID hint, guest mode | – | first (records, home/away); rooms second; voice ID later | M (v1 S) | none for v1 | HA `person` entities; optional BLE proxies, speaker-embedding model | HA as presence engine, records ours |
| [contacts](../modules/contacts.md) | address book, aliases, relations, a resolver for other modules | – | second; first slice in Phase 4 | M (v1 S) | `Person` records | none; optional CardDAV, Google | build directory, integrate sources |
| [lists](../modules/lists.md) | shopping, to-do, chores | – | first | M | store | `tsdav`, `ical.js` bundled; optional HA, CalDAV, Todoist | build local store; providers |
| [kitchen](../modules/kitchen.md) | pantry, recipes, guided cooking, Chef | "top of the owner's wish list" | first (after timers, lists) | L | store, timers, lists | npm only; optional Grocy, Mealie, Tandoor | own store first, apps as providers |
| [grocery-shopping](../modules/grocery-shopping.md) | shopping list into a Picnic cart or order | – | later; only if the household orders online | M (L with ordering) | HA Picnic, `Lists` | Picnic account; HA Picnic integration | build matching, integrate Picnic; checkout in the app |
| [calendar](../modules/calendar.md) | agenda, add, reminders | – (Google asked for) | first | M (L all providers) | tool context, connection | none; CalDAV/ICS, Google, Microsoft accounts | build module, integrate backends |
| [memory-and-notes](../modules/memory-and-notes.md) | remember, notes, journal | – | first (after store) | M | store | `node:sqlite` FTS5; optional Obsidian, Nextcloud | build |
| [documents](../modules/documents.md) | answers from Paperless-ngx and folders, manuals, hand-off | – | second | M (QA L) | tool context, dev caps, connection | Paperless-ngx; optional embedding model, poppler, ocrmypdf | integrate Paperless, build folder index |
| [home-maintenance](../modules/home-maintenance.md) | appliances, warranties, schedules, where things are, manuals | – | second | M (v1 S) | none for v1 | `pdfjs-dist`; optional Homebox, RDW open data | build store, Homebox optional |
| [plants-and-pets](../modules/plants-and-pets.md) | care logs, HA pet and plant devices, plant ID | – | later; feeding log second | S–M | store | optional HA integrations, Pl@ntNet key | build log; HA, Pl@ntNet |
| [finance](../modules/finance.md) | budget questions from Actual/Firefly/YNAB, cash log; never moves money | – | later; only with a budget app | M (L full) | none for v1 | `@actual-app/api` in a worker; a budget app | integrate providers, no own ledger |
| **Communication** | | | | | | | |
| [notifications](../modules/notifications.md) | announce, inbox, DND, phone, hooks (announce: section 11 g) | – | first (split) | L | notify, store | optional ntfy, Apprise containers; HA app; VAPID keys | build; integrate phone channels |
| [broadcast](../modules/broadcast.md) | one-way messages, replies, chimes, voice messages, schedules | – | first (live); second (messages, schedules) | M (live S) | notify `Announce`, rooms | none; optional `ffmpeg` | build |
| [calls-and-intercom](../modules/calls-and-intercom.md) | two-way audio and video between devices, later phones | "a call module where you can call other devices on the network" | second (stage 1); video, groups, phones later | XL in four stages (stage 1 M) | dev caps, rooms, ringing window | HTTPS for video; optional LiveKit, TURN, SIP trunk, speakerphone on nodes | build relay, then WebRTC, then LiveKit |
| [messaging](../modules/messaging.md) | Telegram, mail, Signal, SMS | – | second | M (+S per channel) | confirmation, connection | `signal-cli` + JRE; Telegram bot; mailboxes | build module, integrate channels |
| [emergency-and-safety](../modules/emergency-and-safety.md) | "call for help" chain, check-ins, smoke/CO/leak relay, medical card | – | first (alarm relay); second (help, check-ins) | M (L with check-ins, SMS) | notify `critical`, phone channel, fast path, contacts | phone channel with critical delivery; optional SMS gateway phone; UPS | build policy, integrate channels |
| [google](../modules/google.md) | mail, contacts, Drive; calendar provider | "read emails and my calendars" | first (after Connection) | L | connection, tool context | own Google Cloud project and OAuth client | integrate REST |
| **Information and reading** | | | | | | | |
| [briefing](../modules/briefing.md) | morning and "what did I miss" digest | – | first on request, second scheduled | S (M full) | tool context | none; optional changedetection.io (feeds: section 11 i) | build |
| [news-and-feeds](../modules/news-and-feeds.md) | RSS, headlines, clustering, page watchers, keyword alerts | "an RSS module, or a news module" | first (feeds, headlines); second (alerts, clustering) | M (feeds S) | none | npm only; optional Miniflux/FreshRSS, changedetection.io | build feeds; readers optional |
| [local-info](../modules/local-info.md) | weather, travel, bin day, parcels | – | weather first; travel, bin second; parcels later | S each, travel and parcels M | none | optional OSRM/Photon/MOTIS; NS, 17TRACK keys | integrate open APIs |
| [trips](../modules/trips.md) | trips, flight status, packing, leave-by, holiday mode | – | second, after calendar, mail, travel | L (manual trip M) | `Lists` | optional `kitinerary-extractor`, flight API key | build trip store, integrate status APIs |
| [read-aloud](../modules/read-aloud.md) | articles, read-later, ebook chapters read for minutes with resume | – | second | L (v1 M) | reading session, tool context, store | npm only; optional Wallabag/Karakeep, OPDS, hosted voices | integrate read-later; build the session |
| [dictation-and-transcription](../modules/dictation-and-transcription.md) | long dictation, memos, meeting transcripts, room captions | – | second (dictation, memos); later meetings | M (meetings +L) | capture mode | existing sherpa presets; optional diarisation models, companion agent | build on sherpa presets |
| **Media and play** | | | | | | | |
| [music](../modules/music.md) | music, radio, podcasts per room (podcasts: section 11 j) | "a music module with a bunch of integrations" | first | L (v1 M) | tool context, HA `media_player` | Music Assistant; Spotify app and Premium; node players | integrate MA and Spotify |
| [podcasts-and-audiobooks](../modules/podcasts-and-audiobooks.md) | podcasts, audiobooks, resume position across devices | – | second | M | tool context, connection, music's routes | Audiobookshelf; optional MA, Podcast Index key, `mpv` | integrate ABS, Podcast Index |
| [video](../modules/video.md) | YouTube, Jellyfin, casting | "a Google Assistant with a screen" | second | M (L) | presentation | YouTube Data API key; HA TV integrations; opt-in yt-dlp + Deno | integrate |
| [media-requests](../modules/media-requests.md) | Seerr requests, *arr status, library, recommendations | – | later; second if the stack runs | M (parts S) | none | Seerr, *arr, Jellyfin/Plex, TMDB; optional Trakt | integrate, small own recommender |
| [images-and-photos](../modules/images-and-photos.md) | kiwi images, Immich, cameras, frame | "the owner's test case" | first (presentation pilot) | M | presentation, dev caps | `sharp`; Immich; OpenRouter key for generation | integrate |
| [fun-and-ambient](../modules/fun-and-ambient.md) | sleep sounds, games, kids' mode | – | later | S–M | none | `mpv` on nodes; Open Trivia DB | build, integrate trivia |
| [tabletop-and-games](../modules/tabletop-and-games.md) | scores, clocks, dice, rules lookup, game master | – | later (scores, dice S earlier) | M (L with GM, multi-room) | store, tool context | `pdfjs-dist`; optional BGG token; touch screen | build; rules from PDFs and SRD |
| **Family and wellbeing** | | | | | | | |
| [kids](../modules/kids.md) | age profiles, host-enforced policy, stories, routines, review | – | first if children use the devices, else skip | L | `Person` records, risk policy, store, kids flag | none; optional larger recogniser | build the policy in the host |
| [learning](../modules/learning.md) | language practice, flashcards, quizzes, homework help | – | second | M (L with Anki, pronunciation) | store, `Person` records | `ts-fsrs`; optional AnkiConnect, Azure Speech | own store with ts-fsrs |
| [health-and-fitness](../modules/health-and-fitness.md) | habits, medication, breathing; guided workouts, outside data | – | second; outside data later | L (`wellbeing` M) | none for v1 | npm only; optional Withings, Strava, HA | build; outside data read-only |
| [focus-and-productivity](../modules/focus-and-productivity.md) | focus sessions with DND, time tracking, planning, task capture | – | second (planning later) | M | none for v1 | optional ActivityWatch, Toggl/Kimai, HA companion app | build focus, integrate trackers |
| **Home, screens and devices** | | | | | | | |
| [smart-home](../modules/smart-home.md) | HA domains, rooms, locks, events | – | first | M (L all) | none for v1 | Home Assistant; optional Mosquitto, vision model | integrate HA |
| [cameras-and-security](../modules/cameras-and-security.md) | doorbell with picture, view and describe, visits, alarm arming | – | second | M (L live view, talk) | none for speech-only v1 | HA camera and alarm entities; optional Frigate, go2rtc, vision model | Frigate if present, HA fallback |
| [energy-and-vehicle](../modules/energy-and-vehicle.md) | solar, prices, cheapest window, appliances, car charging | – | second; price slice early on a dynamic contract | M (v1 S) | none for v1 | HA energy sensors, a price source; optional evcc | HA data, own planner |
| [network](../modules/network.md) | devices, guest Wi-Fi QR, pauses, DNS filter, "is the internet down" | – | second; outage and QR could be first | M | fast path | router API; optional Pi-hole/AdGuard, Tailscale, librespeed | build outage detector, adapters |
| [printers](../modules/printers.md) | paper, label and receipt printing, scanning, 3D printer status | – | later (paper); second for 3D | M | `Lists` | printer on the LAN; optional `brother_ql` sidecar, OctoPrint/Moonraker/Bambu | build, one adapter per interface |
| [vision](../modules/vision.md) | camera on request: what is this, read text, barcodes | – | second (barcodes maybe with kitchen) | M (L local model) | none on-device; image results for `look` | HTTPS, camera, vision-capable model; `tesseract.js` | build capture, integrate polyfill, Tesseract |
| [dashboard](../modules/dashboard.md) | ambient home screen of module widgets per device | – | second, after Presentation; fixed v1 with the pilot | L (fixed v1 M) | presentation, dev caps | kiosk browser; optional backlight control | own widgets, optional `ha.view` |
| **Automation, computers and code** | | | | | | | |
| [routines-and-automations](../modules/routines-and-automations.md) | step sequences, quick commands, bridge (bridge: section 11 m) | – | second | M (bridge S) | `records` field | none; optional HA, n8n, Node-RED | build small |
| [automation-platforms](../modules/automation-platforms.md) | n8n, Node-RED, HA scripts, Windmill as tools; callback API | n8n: "the owner named it" | second, with routines; callback `say` earlier | L (n8n + HA scripts M) | HTTP route, `records` field | npm only; n8n, Node-RED, Windmill optional | one generic adapter, own nodes |
| [mcp-client](../modules/mcp-client.md) | any MCP server's tools | – | second | L (read-only HTTP M) | `records` field | MCP SDK; optional `uv`, Docker/Podman | build client |
| [browser-tasks](../modules/browser-tasks.md) | background jobs in a server browser, commit gate, recipes | – | later (third wave) | L | Chromium, the adapter | Chromium headless shell (~281 MB), Stagehand, driver model account | integrate Stagehand on local Chromium |
| [computer-control](../modules/computer-control.md) | Raycast-style control of the owner's PC through `pva-desk` | – | second | L (Linux v1 M) | companion pairing | `pva-desk` and desktop tools on the PC | build own agent; HA desktop agent adapter |
| [t3-code](../modules/t3-code.md) | T3 Code threads by voice | "a real wish-list item" | second | M | connection (OAuth) | running T3 server; optional `t3` CLI, GitHub | integrate T3 `/mcp` |
| [dev-tools](../modules/dev-tools.md) | PRs, CI, deploys, Sentry, on-call, overnight digest | – | second | M | none | GitHub PAT; optional GitLab, Sentry, Vercel, Coolify | native on forge APIs; MCP for the long tail |
| [homelab](../modules/homelab.md) | Proxmox, Docker, systemd, monitors, UPS, updates | – | second | M (L all backends) | none (read-only, spoken) | Proxmox read token; optional socket proxy, NUT, Uptime Kuma | thin native module; MCP read-only |

**Candidates without a document of their own.** Named in the landscape surveys or module documents; one line each.
Documents, presence, cameras, translation, energy, browser jobs, kids' mode and GitHub now have documents.

| Candidate | What it would do | Named in |
|---|---|---|
| Chores as its own module | whose turn, rota; folded into lists today | [automation §14](landscape-automation-platforms.md#14-candidate-modules-for-us), [lists §5](../modules/lists.md#5-integrate-or-build) |
| Parcels and deliveries | track codes, "delivered"; a later slice of local-info | [launchers §7](landscape-launchers-and-agent-tools.md#7-candidate-modules-for-us), [local-info §1](../modules/local-info.md#1-summary) |
| Code runner | sandboxed JS (`quickjs-emscripten`) for hard maths | [launchers §3.14](landscape-launchers-and-agent-tools.md#314-code-execution) |
| Phone triggers | authenticated inbound webhook from Shortcuts/Tasker; partly notifications hooks and the automation callback API | [automation §10](landscape-automation-platforms.md#10-apple-shortcuts-and-tasker), [automation-platforms §4](../modules/automation-platforms.md#4-tools) |
| Commute | leave-time reminders for recurring trips; one-off leave-by is in trips | [calendar §7](../modules/calendar.md#7-long-running-work-and-events), [trips Q5](../modules/trips.md#15-open-questions) |
| Own MCP server | expose our tools to HA or Claude Desktop | [launchers §4](landscape-launchers-and-agent-tools.md#4-should-the-assistant-be-an-mcp-client) |
| Garden | irrigation and garden zones, only if there is real irrigation | [plants-and-pets Q5](../modules/plants-and-pets.md#15-open-questions) |

## 8. Suggested order of work

Phases follow the foundation documents' own build orders ([module-definition C.10](module-definition-config-and-dependencies.md#c10-recommendation-and-phases),
[shared-state §10](shared-state-jobs-and-notifications.md#10-suggested-build-order), [presentation §7 item 10](presentation-and-device-capabilities.md#7-recommendations-in-one-place)) merged with the
module waves. Each phase ends with something the owner can use. Placing the second-round modules is this overview's
suggestion, from each document's wave and §14.

| Phase | Work | At the end the owner can |
|---|---|---|
| 0. Deployment readiness | `pva doctor` with core checks; `deploy/install.sh` and a hardened system unit; SHA-256 on model downloads; `backup`/`restore`; vault password through `systemd-creds`; a certificate route for HTTPS on screen devices | move to the server reproducibly, check it, back it up and restore it |
| 1. Context and honesty | tool context; device capabilities in `hello` plus room and the context line; manifest `requires`/`health`, the `unavailable` state, Health page; assistant-controls matcher (stop, never mind, repeat, new conversation, switch, sleep) | say "stop" and be obeyed; hear "I can't show pictures on this speaker" and "music isn't set up" instead of improvisation |
| 2. Store, scheduler, ringing | module store with change log and backup; scheduler; minimal notification service (ring, ringing window, recorded `Announce`, inbox, quiet hours); `timer` card; live broadcast with chime and reply window; the emergency alarm relay in the house (`critical`, fixed text) | set a pasta timer in the kitchen, check and stop it from the study, survive a restart; time reminders; "dinner's ready" with replies; a smoke alarm spoken everywhere |
| 3. Presentation | Presenter with `image`, `card`, `list`, `text`, reveal rule, `/media/`, `show_on`; the fixed dashboard on `alwaysOn` screens | "show me a kiwi"; the shopping list or a weather card on a screen; "send it to the kitchen screen"; a clock-and-weather home screen |
| 4. Household data and people | `Person` records (presence-and-people) and device default person; HA home/away; contacts first slice; `household.*` events to screens; lists; memory-and-notes; kitchen slice 1 (pantry, low stock); news-and-feeds with briefing on request; home-maintenance and the pet feeding log on the store; wire the Jev fast path for timers, lists and lights | a shared shopping list that fills itself from the pantry; "remember the boiler code"; "is anyone home?"; a spoken morning briefing with the news |
| 5. Accounts and risk | connections with device-code and loopback-paste OAuth; risk classes and policy, with a `personal` sensitivity tag; confirmations switched on; first phone channel; emergency "call for help" with one tier of contacts; the kids policy if children use the devices | Google mail and calendar, Spotify per person, locks with confirmation on trusted devices, notifications and safety alerts on the phone |
| 6. Second-round core | images in tool results and the camera capability; module HTTP routes and the callback API; the reading session; capture mode; voice per language; the widget contract; companion pairing | "what is this?" with the camera; n8n flows that speak; an article read aloud with resume; a dictated long note; module widgets on the home screen |
| 7. Second wave | kitchen guided cooking and Chef; music on more routes; routines and automation-platforms; video; MCP client; T3 Code; local-info travel and bin day; broadcast voice messages; calls stage 1; podcasts; read-aloud; documents; translation; learning; cameras; energy; network; vision; dictation; dashboard editor; computer-control; dev-tools; homelab; focus; health; trips; Docker image and managed tools | the rest of the catalogue, by preference |
| 8. Later | browser-tasks; finance and grocery-shopping (only with a budget app or online orders); media-requests unless the stack runs; paper printers; plants beyond feeding; tabletop game master and party games; calls stages 2–4 | the long tail, where the household has the backing app |

**Alternative starting points** (pick one to run beside Phase 0):

- **Quick wins, no foundations:** core tools (calculator, time, Wikipedia), web search with SearXNG or Brave, weather
  extensions and bin day from ICS, smart-home v1 (WebSocket cache, more domains), assistant-controls v1; news feeds in a
  JSON file, the network outage detector and guest QR, homelab and dev-tools read-only, the energy price slice,
  on-device barcodes and text in vision. Each §14 says its first version needs no foundation
  ([core-tools](../modules/core-tools.md#14-foundations-needed), [web-search](../modules/web-search.md#14-foundations-needed), [local-info](../modules/local-info.md#14-foundations-needed),
  [smart-home](../modules/smart-home.md#14-foundations-needed), [assistant-controls](../modules/assistant-controls.md#14-foundations-needed), [news](../modules/news-and-feeds.md#14-foundations-needed),
  [network](../modules/network.md#14-foundations-needed), [homelab](../modules/homelab.md#14-foundations-needed), [dev-tools](../modules/dev-tools.md#14-foundations-needed),
  [energy](../modules/energy-and-vehicle.md#14-foundations-needed), [vision](../modules/vision.md#14-foundations-needed)).
- **The kitchen path:** store → scheduler → ringing → timers → lists → kitchen pantry slice → `steps` and `timer` kinds
  → guided cooking with the Chef template (needs manifest `templates`). Needs Phases 2 and part of 3 first
  ([kitchen §14](../modules/kitchen.md#14-foundations-needed)).
- **The screen path, starting with images:** device capabilities and the context line → Presenter with `image`, `card`,
  `list`, `text` → `/media/` with `sharp` → `image_find` (the kiwi) → `show_on` → Immich photos and the photo frame →
  video later. Needs Phase 1's capabilities and Phase 3 ([images §14](../modules/images-and-photos.md#14-foundations-needed),
  [presentation §7](presentation-and-device-capabilities.md#7-recommendations-in-one-place)).
- **The calls path:** broadcast (one-way, on `Announce`) → audio intercom relayed by the server over the existing audio
  path (stage 1, M; ringing window, rooms, `Person` records, a `call` activation on nodes) → video between browsers with
  WebRTC signalling on `/ws` (stage 2, M–L; HTTPS on every screen) → LiveKit for groups, phones and the assistant as
  participant (stage 3, L) → optional SIP bridge (stage 4). Stage 1 first: it reaches voice nodes without new native
  code and proves the state machine and privacy rules first ([calls §5.6](../modules/calls-and-intercom.md#56-recommendation-and-stages),
  [broadcast §14](../modules/broadcast.md#14-foundations-needed)).

## 9. Deployment and native dependencies

**Recommendation** ([module-definition C.10](module-definition-config-and-dependencies.md#c10-recommendation-and-phases)): one server plus thin clients; declared
requirements with health checks and the `unavailable` state as the contract in every deployment; a systemd installer
first and Docker Compose second as reproducible installs; managed, pinned and checksummed binaries only for the few
tools that need them (yt-dlp, ffmpeg-static); players on the playback device; no Nix. Measure the LAN hop after the move
with `TurnTrace` ([C.7](module-definition-config-and-dependencies.md#c7-topology)). Table sources: [current-system §8](current-system.md#8-deployment),
[C.1](module-definition-config-and-dependencies.md#c1-what-modules-will-need-and-where-it-must-run), each module's §11.

| Tool, service or account | Needed by | Runs on | Required? |
|---|---|---|---|
| Node ≥ 22.18, pnpm 10, `tar` + bzip2, `nice`, `flock` | everything; model unpacking; data-dir lock | server | required |
| `sherpa-onnx-node` addons and speech models (~800 MB, ~2.5 GB RAM) | local STT/TTS; dictation presets | server | required for local speech |
| Multilingual recogniser (1.0–1.6 GB); a voice per language; diarisation (pyannote 3.0, 3D-Speaker); speaker-embedding model | translation, learning, kids; dictation meetings; presence voice ID | server | optional per feature |
| `node:sqlite` (built in) via `@effect/sql-sqlite-node` | module store; memory, home-maintenance, tabletop FTS5 (falls back to `LIKE`) | server | required for store-based modules |
| Local embedding model (~300 MB, EmbeddingGemma or `multilingual-e5-small`) | documents, memory search, news clustering | server | optional |
| `systemd-creds` (optionally TPM) or Docker secrets | unattended vault unlock | server | recommended |
| HTTPS certificate (DNS-01 domain, Tailscale name or local CA) | calls video, vision, translation camera, cameras push-to-talk, dashboard Wake Lock | server | required for camera and video features |
| npm-only libraries (mathjs, chrono-node, `tsdav`, `ical.js`, readability, linkedom, turndown, pdfjs, `parse-ingredient`, `opening_hours`, `feedsmith`, `fflate`, `ts-fsrs`, `qrcode`, `libphonenumber-js`) | core-tools, lists, calendar, web-search, kitchen, local-info, briefing, news, podcasts, read-aloud, learning, network, contacts, home-maintenance, tabletop | server | bundled |
| `sharp` (libvips; libheif for HEIC) | images `/media/` proxy; cameras, vision | server | required for images |
| Home Assistant (optional Mosquitto) | smart-home; music via MA; video casting; presence (`person`); cameras and alarm entities; energy sensors; plants and pets; Picnic; HA companion push and phone DND | LAN | required for smart-home, presence, cameras, energy; optional elsewhere |
| Music Assistant; Spotify Premium + own developer app; Podcast Index key; Audiobookshelf; opodsync or Nextcloud gPodder Sync | music, podcasts (Audiobookshelf recommended) | LAN / internet | optional providers |
| Soloist or go-librespot; `mpv` | music on nodes, radio, sleep sounds, music alarms, podcasts route 4 | playback device (node) | optional |
| Widevine-capable browser; `hls.js`; kiosk browser (Fully Kiosk PLUS or Chromium kiosk) | Spotify in the page; Jellyfin video; dashboard | screen device | optional |
| Camera and permission; `barcode-detector` polyfill, `tesseract.js`; `rpicam-still` + LED on nodes | vision, translation camera text, plants ID, calls video | screen device / node | optional |
| Vision-capable model (hosted, `llama-server --mmproj`, Ollama or Frigate GenAI); Frigate 0.16+, go2rtc | vision `look`, camera descriptions, history, live view | hosted / LAN | model required for those tools |
| `ffmpeg` | music HLS radio; broadcast Opus storage; dictation | server | optional |
| `yt-dlp` + Deno | video transcripts, opt-in | server | optional |
| YouTube Data API key; Jellyfin or Plex; optional Gemini key; Seerr, Sonarr/Radarr, a download client, TMDB token, Trakt app | video, media-requests | internet / LAN | optional with probes |
| SearXNG, or a Brave / Tavily / Exa / Kagi / Perplexity key | web-search | LAN / internet | one required for web-search |
| Wikimedia User-Agent contact; Frankfurter; Open-Meteo | core-tools lookup and currency; images; weather; plant watering | internet | required for those tools |
| Nominatim/Photon, Overpass, OSRM, Transitous; NS, 17TRACK, finance and sports keys; `kitinerary-extractor`, Schiphol or AeroDataBox key | local-info, trips | internet or self-hosted | optional |
| Immich API key; OpenRouter key (or a GPU for local generation); Openverse, Pexels, Brave keys | images-and-photos | LAN / internet / server | optional |
| Google Cloud project with published OAuth client | google, calendar (Google), lists (Google Tasks), contacts | internet | required for Google |
| CalDAV/CardDAV server or ICS URLs; Microsoft account | calendar, lists, contacts, reminders later | LAN / internet | optional |
| Grocy, Mealie, Tandoor, KitchenOwl, Todoist, Donetick; Open Food Facts; barcode scanner; Picnic account (`picnic-api`) or HA Picnic integration | kitchen, lists, grocery-shopping (Picnic required) | LAN / internet / kitchen device | optional |
| Telegram bot; IMAP/SMTP; `signal-cli` + JRE 25; Matrix; SMS gateway phone | messaging; emergency (SMS, the only internet-independent path) | server / LAN / internet | optional per channel |
| ntfy, Apprise API containers; HA companion app; VAPID keys; a UPS for server, router and gateway phone | notifications phone channels; emergency (critical delivery required, UPS recommended) | LAN / phone / house | optional; one required for emergency |
| LiveKit with TURN or coturn; `@livekit/rtc-node`; Tailscale; SIP trunk with Asterisk or LiveKit SIP; USB speakerphone (AEC) on nodes | calls stages 3–4; node calls | LAN / internet / node | optional |
| changedetection.io; RSS feeds; Miniflux or FreshRSS; Kagi Kite, GDELT, Guardian key | news-and-feeds (briefing reads them) | LAN / internet | optional |
| Wallabag, Karakeep, Readeck or Readwise; Calibre-Web or Kavita; hosted TTS voices with a monthly cap | read-aloud | LAN / internet | optional |
| Paperless-ngx; poppler-utils; `ocrmypdf` + Tesseract; WebDAV; Obsidian REST plugin; Nextcloud | documents, printers scan; memory sync | LAN / server / desktop | optional |
| DeepL key; TranslateGemma; Azure Speech key; Anki with AnkiConnect; BGG token; Homebox; RDW open data; Pl@ntNet key; Bermuda or ESPresense BLE proxies | translation, learning, tabletop, home-maintenance, plants, vision, presence rooms | internet / LAN | optional |
| A price source (HA integration, ENTSO-E token or Nord Pool); evcc; remote-start appliances | energy-and-vehicle | internet / LAN | price source required for prices |
| `@actual-app/api` in a worker; Actual, Firefly III or YNAB; Splitwise or IHateMoney | finance | server / LAN / internet | a budget app required |
| Withings, Strava, Garmin, wger; ActivityWatch; Toggl or Kimai | health-and-fitness; focus-and-productivity | internet / LAN / desktop | optional |
| `pva-desk` companion agent with playerctl, wpctl, wl-clipboard, wtype, grim, xdg-open; macOS permissions | computer-control; dictation typing into the PC | owner's computer | required for those modules |
| Proxmox API token (`PVEAuditor`); docker-socket-proxy; SSH wrapper scripts; NUT; Uptime Kuma; trusted TLS | homelab | LAN | Proxmox token and TLS required |
| Router or controller API; Pi-hole or AdGuard; `tailscale` CLI; `librespeed-cli`; `CAP_NET_RAW`; NetAlertX, Speedtest Tracker | network | LAN / server | router API for device features |
| GitHub fine-grained PAT; GitLab, Sentry, Vercel, Coolify, Dokploy, PagerDuty tokens; `@kubernetes/client-node` | dev-tools | internet / LAN | GitHub PAT required |
| Printers on the LAN; `brother_ql` sidecar; OctoPrint, Moonraker, PrusaLink, Bambu Developer Mode; Obico | printers | LAN / server container | printer required |
| Chromium headless shell (~281 MB, apt libraries need root); Stagehand; driver model account; `bw`; Browserbase | browser-tasks | server / internet | Chromium and a model account required |
| MCP SDK; `npx`; `uv` or Python; Docker or Podman | mcp-client; automation-platforms reuses the transport | server | SDK required; rest optional |
| Running T3 Code server; `t3` CLI; GitHub connection | t3-code, dev-tools | wherever T3 runs | server required |
| n8n ≥ 1.121, Node-RED ≥ 3, Windmill, HA ≥ 2025.7 scripts | automation-platforms, routines | LAN | optional |

## 10. Configuration model

Seven layers: install, household, module, connection, assistant, device, member ([B.1](module-definition-config-and-dependencies.md#b1-layers)).
**Values:** the most specific wins, member > device > assistant > module shared (env > saved) > household linked default
> module default, and a field opts in per layer. **Permissions:** policies intersect, so a lower layer can only narrow;
nothing below the household widens ([B.3](module-definition-config-and-dependencies.md#b3-precedence-proposal)). An "Effective settings" view per device and
assistant explains where each value came from.

| Household setting | Exists today? | Read by |
|---|---|---|
| Location, or a list of saved places with one home | `HOME_LOCATION` | weather, local-info, core-tools, music (radio country), web-search, trips, media-requests (region) |
| Time zone | `HOME_TIME_ZONE` | clock, scheduler, timers and alarms, reminders, calendar, briefing, trips |
| Language and locale, plus other languages spoken and a glossary of names never translated | `HOME_LANGUAGE` (extras new) | core-tools, assistant-controls phrases, timers and reminders parsing, kitchen, calendar, web-search, news, translation, learning |
| Units (plus cup size), date format | `HOME_UNITS`, `HOME_DATE_FORMAT` | core-tools, kitchen, weather |
| Currency | new | core-tools, finance, energy, home-maintenance, trips, grocery |
| Members (`Person` records, a settings section owned by presence-and-people) | new | reminders, lists, memory, calendar, google, kitchen, music, messaging, notifications, smart-home, contacts, kids, learning, tabletop, finance, health, trips, media-requests |
| Rooms | new | smart-home, timers, notifications, music, video, presentation, broadcast, calls, dashboard, dictation |
| Quiet hours (proposal 22:00–07:00) | new | notifications, timers, reminders, lists, kitchen, smart-home, briefing, google, fun, broadcast, calls, energy, health, focus, homelab, dashboard (night mode), automation (`ask`) |
| Default providers (search, music order, default lists, family calendar, default TV per room, printers, budget, home airport) | new | web-search, music, lists, calendar, video, printers, finance, trips |
| Risk policy ceiling (`money: deny`, `security: deny`) | new | smart-home, messaging, routines, mcp-client, t3-code, fun (kids), cameras, grocery, browser-tasks (commit policy), computer-control, homelab |
| Kids' and safe-search policy, per age band | new | images, video, fun-and-ambient, web-search, kids, media-requests (certification ceiling) |
| Personal content on shared devices (numbers, spending totals, document facts, widgets on shared and public screens) | new | contacts, finance, documents, dashboard, network (guest password) |
| Hosted models for sensitive input (camera frames `local`/`hosted`/`ask`, screenshots, summaries, learners' voices, private passages) | new | vision, cameras, computer-control, dictation, learning, documents |
| Household pronunciation lexicon | new | read-aloud, contacts, every speech path |
| Household diets and allergies | new | kitchen, grocery (memory also holds allergies, section 11) |
| Ambient facts shared with every assistant | new | all modules with `ambient` lines |
| API contact for User-Agent headers | new | local-info, core-tools, images |
| Announce and broadcast: audience, voice, reply window, bedrooms (`quietRoom`) in quiet hours | new | notifications, broadcast, routines |
| Inbound hooks and callback API: on, LAN-only, maximum priority per token | new | notifications, automation-platforms, homelab, media-requests |
| Calls: on, drop-in rules, ring timeout, outside calls, TURN or Tailscale | new | calls-and-intercom |
| Emergency: act at once or ask, 112 text and number, safety policy table, who edits chains | new | emergency-and-safety, health (112 in medical answers) |
| Recording: allowed, announcement text, maximum minutes, audio retention | new | dictation, memory (voice-note audio) |
| Smaller ones: browser tasks on, local or hosted, allowed sites (browser-tasks); infrastructure announcements in shared rooms (network, homelab); guest mode defaults and who may ask where whom is (presence); MCP on, stdio, Docker, maximum tools (mcp-client); image generation and budget (images); tariff components (energy), streaming services owned (media-requests), news topics, hosted-voice character cap (read-aloud), children's model account (kids), document users and private types, pets and feeding times, seeded maintenance country | new | the module named |

Sources: [B.2](module-definition-config-and-dependencies.md#b2-where-each-example-belongs) and §10 of each module.

## 11. Disagreements between documents

Recommendations (a)–(n) are the lead's positions. From row 36 the recommendation follows the newer, more specific
document unless the row says otherwise. All are **the owner's decision**.

| # | Topic | One position | Other position | Recommendation |
|---|---|---|---|---|
| a | Kitchen backend | integrate Grocy for pantry, Mealie as default kitchen backend ([automation §11](landscape-automation-platforms.md#11-self-hosted-household-apps-integrate-or-build)) | own local store first, Mealie/Grocy/Tandoor as providers ([kitchen §5](../modules/kitchen.md#5-integrate-or-build)) | own store first: local-first and voice-specific handling |
| b | Recurrence format | `Cron` for recurring jobs ([shared-state §6](shared-state-jobs-and-notifications.md#6-jobs-and-the-scheduler)); used by alarms, routines, briefing, chores, local-info | RRULE, because cron cannot say "every second Tuesday" ([reminders §5](../modules/reminders.md#5-integrate-or-build)); home-maintenance and broadcast also need RRULE ([home-maintenance Q3](../modules/home-maintenance.md#15-open-questions)) | store user recurrence as RRULE (bin day and chores have the same need); one library for lists, calendar and reminders (`ical.js` vs `rrule` also differ) |
| c | Phone push order | Web Push first, then ntfy ([shared-state §8.7](shared-state-jobs-and-notifications.md#87-the-inbox-and-phone-push)) | HA companion app, ntfy, Apprise, Web Push last ([notifications §5](../modules/notifications.md#5-integrate-or-build-phone-channels)); ntfy default in [automation §11](landscape-automation-platforms.md#11-self-hosted-household-apps-integrate-or-build) | HA companion app where HA runs, then ntfy, Web Push last |
| d | Tapping a checklist item | a tap becomes a typed turn through the model ([presentation §4.3](presentation-and-device-capabilities.md#43-touch)) | the tap calls the tool directly ([lists §8](../modules/lists.md#8-presentation), [kitchen §15](../modules/kitchen.md#15-open-questions)) | call the tool directly; keep typed turns for `pick` choices |
| e | MCP packaging | each server becomes a module ([launchers §4](landscape-launchers-and-agent-tools.md#4-should-the-assistant-be-an-mcp-client)) | one `mcp` module holding many servers ([mcp-client §5.3](../modules/mcp-client.md#53-one-module-or-one-module-per-server), [module-definition A.5](module-definition-config-and-dependencies.md#a5-in-repo-versus-out-of-tree-modules)) | one module, many servers |
| f | Image source order | Openverse, Commons as fallback ([presentation §3.2](presentation-and-device-capabilities.md#32-catalogue-of-primitives-proposal), [§8 Q1](presentation-and-device-capabilities.md#8-open-questions-for-the-owner)) | Wikipedia lead image, then Commons, then Openverse ([images §5.1](../modules/images-and-photos.md#51-finding-a-picture-of-a-thing)) | Wikipedia, Commons, Openverse |
| g | Announce and broadcast | `notifications_announce` and replies in notifications ([notifications §4](../modules/notifications.md#4-tools)) | broadcast takes the tool and replies ([broadcast Q1](../modules/broadcast.md#15-open-questions)) | the announce/broadcast tool moves to broadcast; notifications keeps the service, inbox and rules |
| h | Who owns contacts | messaging owns the directory, google is a source (row 21; [messaging §5.2](../modules/messaging.md#52-contacts)); google has `contacts_find` | a contacts module with the resolver and per-contact rules ([contacts Q1](../modules/contacts.md#15-open-questions)); presence-and-people owns household members ([presence §6](../modules/presence-and-people.md#6-data)) | contacts owns people outside the house; messaging and calls consume it; presence-and-people owns household `Person` records |
| i | Feeds and watchers | feeds and watchers stay in briefing until a second consumer ([briefing Q7](../modules/briefing.md#15-open-questions)) | `news_*`, `feed_*`, `watch_*` and the feed store move ([news Q7](../modules/news-and-feeds.md#15-open-questions)) | the tools live in news-and-feeds; briefing only consumes `news.latest` |
| j | Podcasts | `podcast_play`, subscriptions and progress built in music ([music §4](../modules/music.md#4-tools)) | everything with a resume position ([podcasts Q6](../modules/podcasts-and-audiobooks.md#15-open-questions)) | anything with a resume position lives in podcasts-and-audiobooks and shares music's playback path |
| k | Presence | `who_is_home` and `home-assistant.presence.changed` in smart-home ([smart-home §4](../modules/smart-home.md#4-tools)) | moved, with one event name ([presence Q1](../modules/presence-and-people.md#15-open-questions)) | `who_is_home` and presence events move to presence-and-people; smart-home supplies the data |
| l | Risk of viewing a camera | "safe but personal" ([smart-home §4](../modules/smart-home.md#4-tools)); printers' 3D snapshot "read (camera: personal)" ([printers §4](../modules/printers.md#4-tools)) | `security` ([images §13](../modules/images-and-photos.md#13-privacy-and-safety), [B.5](module-definition-config-and-dependencies.md#b5-risky-tools), [cameras Q2](../modules/cameras-and-security.md#15-open-questions), with a doorbell exception) | `security`, not safe |
| m | Bridge to n8n, Node-RED, HA scripts | routines keeps `ha_script_<name>` and n8n via the MCP bridge ([routines §5](../modules/routines-and-automations.md#5-integrate-or-build-and-how-far-to-go)) | one automation module with discovery and a callback API ([automation-platforms Q1](../modules/automation-platforms.md#15-open-questions)) | automation-platforms takes the bridge; routines keeps owner-defined sequences and quick commands |
| n | The existing Proxmox MCP server | expose a read-only slice through mcp-client ([homelab Q5](../modules/homelab.md#15-open-questions)) | ~290 tools including `delete_vm`, never exposed as is ([homelab §5.3](../modules/homelab.md#53-native-tools-or-mcp-servers-through-the-mcp-client)) | not exposed to voice as is; homelab uses native read-only tools |
| 1 | One-word "stop" | timers, notifications, briefing and the ringing window assume it gets through ([shared-state §8.4](shared-state-jobs-and-notifications.md#84-acknowledging-and-snoozing-by-voice)) | the echo gate's two-word rule drops a single "stop" during playback (read in code, not tested) ([controls §5](../modules/assistant-controls.md#5-integrate-or-build)) | test it first; the control matcher sees recogniser events before the echo gate |
| 2 | Who owns "stop" | ringing window in the route gate, run by the notification service ([shared-state §8.4](shared-state-jobs-and-notifications.md#84-acknowledging-and-snoozing-by-voice)) | one control matcher after the route gate, ringing as step 1 ([controls, "What stop stops"](../modules/assistant-controls.md#what-stop-stops)) | one matcher in assistant-controls, reading ringing state from the service |
| 3 | Wake-free scope | only while something rings ([shared-state §11 Q4](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner)) | also while a reply is audible ([controls §5](../modules/assistant-controls.md#5-integrate-or-build)); but music's media guard requires the wake phrase while music plays ([music §12](../modules/music.md#12-interaction-with-the-rest-of-the-system)) | ringing and audible reply; exempt "stop" from the media guard |
| 4 | What "stop" does to the screen | "stop" with nothing speaking dismisses the top presentation ([presentation §3.6](presentation-and-device-capabilities.md#36-speech-and-visuals-together)) | stop never stops video ([video §8](../modules/video.md#8-presentation)); stop pauses media at step 3 ([controls](../modules/assistant-controls.md#what-stop-stops)) | follow the controls order; dismiss only with "close that" |
| 5 | Timer ringing scope | origin, then its room ([shared-state §8.3](shared-state-jobs-and-notifications.md#83-targets-fan-out-and-dedupe)) | adds the device where the owner was last active and the phone for alarms ([timers §7](../modules/timers-and-alarms.md#7-long-running-work-and-events)); music and video pause "in that room" | origin-then-room by default; the rest as opt-in escalation |
| 6 | Quiet hours | `high` visual-only on screens except alarms; `normal` to the inbox ([shared-state §8.2](shared-state-jobs-and-notifications.md#82-priority-and-what-each-may-do)) | timers ring audibly ([timers §9](../modules/timers-and-alarms.md#9-notifications-and-proactive-behaviour)); announcements play on non-bedroom devices ([notifications §9](../modules/notifications.md#9-notifications-and-proactive-behaviour)); reminders held until morning ([reminders §9](../modules/reminders.md#9-notifications-and-proactive-behaviour)) | let a timer the person just set ring; one table of quiet-hour effects in the service |
| 7 | Escalation to the phone | off for timers ([shared-state §8.3](shared-state-jobs-and-notifications.md#83-targets-fan-out-and-dedupe)) | any `high` after 60 s ([notifications §9](../modules/notifications.md#9-notifications-and-proactive-behaviour)); alarms after 120 s ([timers §10](../modules/timers-and-alarms.md#10-configuration)) | one household setting, off for timers, on for alarms |
| 8 | Announce timing | `Announce` waits for the turn to finish ([shared-state §8.6](shared-state-jobs-and-notifications.md#86-spoken-announcements-and-follow-up-conversations)) | `high` waits only for the current clause (same doc [§8.2](shared-state-jobs-and-notifications.md#82-priority-and-what-each-may-do)); modules follow §8.2 | follow §8.2 |
| 9 | Storage layout | `data/modules/<id>/` with JSON or SQLite per module ([C.9](module-definition-config-and-dependencies.md#c9-module-data-backups-and-upgrades)) | one `data/household.db` with change log ([shared-state §4.1](shared-state-jobs-and-notifications.md#41-engine)) | one household file; per-module tables and migrations inside it |
| 10 | Presentation transport | `display` field on `tool.end` ([A.2](module-definition-config-and-dependencies.md#a2-what-a-module-may-contribute), UI-AND-MODULES) | own `present.*` messages, because presentations outlive tool calls ([presentation §3.3](presentation-and-device-capabilities.md#33-payload-sketch-proposal)) | own messages |
| 11 | Tool context name | `CurrentTurn` ([shared-state §4.5](shared-state-jobs-and-notifications.md#45-turn-context-proposal)) | `CurrentTurnDevice` ([presentation §3.4](presentation-and-device-capabilities.md#34-where-the-payload-travels-on-the-server)) | one `CurrentTurn` |
| 12 | Tools on screenless devices | do not offer the image tool there ([launchers §3.13](landscape-launchers-and-agent-tools.md#313-images-search-and-generation)) | tools always present, server decides ([presentation §5.4](presentation-and-device-capabilities.md#54-how-the-capabilities-reach-the-agent)) | always present |
| 13 | Risk vocabulary | template: safe / changes data / outward-facing or costly ([README](../modules/README.md#template)); vision, dictation and dashboard §4 still use it | `read/change/message/money/security` ([B.5](module-definition-config-and-dependencies.md#b5-risky-tools)); routines "owner-declared"; camera viewing (row l); t3-code stop "changes" vs security; fun says `message` is denied by default, B.5 says confirm | B.5 classes everywhere; map the template's three onto them (see also row 50) |
| 14 | Confirmation while it is off | refuse the tool (smart-home, mcp-client) | confirm inside the module (messaging screen button, t3-code draft age) ([messaging §14](../modules/messaging.md#14-foundations-needed), [t3-code §13](../modules/t3-code.md#13-privacy-and-safety)) | switch core confirmation on in Phase 5; no module-made confirmations |
| 15 | Timer field | `endsAt` ([presentation §3.3](presentation-and-device-capabilities.md#33-payload-sketch-proposal)) | `dueAt` ([shared-state §4.4](shared-state-jobs-and-notifications.md#44-declaring-data-proposal)) | pick one ([timers Q6](../modules/timers-and-alarms.md#15-open-questions)) |
| 16 | Event names | `kitchen.stock.low`, `ha.doorbell.pressed`, `alarm.due` (kitchen, images, music, fun) | `pantry.stock.low` (shared-state), `home-assistant.doorbell` (smart-home), `alarms.ringing` (timers) | the emitting module's name wins |
| 17 | Kitchen to lists | the list subscribes to a stock-low event ([shared-state §5](shared-state-jobs-and-notifications.md#5-event-bus)); kitchen §14 also says so | direct `Lists.addItem` with a dedupe key ([kitchen §12](../modules/kitchen.md#12-interaction-with-the-rest-of-the-system), [lists Q3](../modules/lists.md#15-open-questions)) | direct call |
| 18 | Kitchen split | separate `kitchen` and `pantry` modules ([automation §14](landscape-automation-platforms.md#14-candidate-modules-for-us), [shared-state §9](shared-state-jobs-and-notifications.md#9-two-worked-examples)) | one kitchen module ([kitchen Q2](../modules/kitchen.md#15-open-questions)) | one module, three interfaces |
| 19 | Chores | integrate Donetick or Grocy chores ([automation §11](landscape-automation-platforms.md#11-self-hosted-household-apps-integrate-or-build)) | build in lists, apps optional ([lists §5](../modules/lists.md#5-integrate-or-build)) | build; it is small |
| 20 | Allergies | `kitchen_prefs` and household config ([kitchen §6](../modules/kitchen.md#6-data)) | pinned memories ([memory §6](../modules/memory-and-notes.md#6-data)) | one home: person preferences, read by both |
| 21 | Contacts | `contacts.resolve` export from google ([google §6](../modules/google.md#6-data)) | the same export from messaging's directory ([messaging §6](../modules/messaging.md#6-data)) | superseded by row h |
| 22 | Google bundle | `google` owns calendar and tasks tools ([automation §14](landscape-automation-platforms.md#14-candidate-modules-for-us)) | calendar and lists own the tools, Google is a provider ([google Q6](../modules/google.md#15-open-questions)); calendar puts Google second, google's v1 includes it | provider only |
| 23 | Home Assistant path | connect to HA's MCP `/api/mcp/assist` instead of per-domain adapters ([automation §1.5](landscape-automation-platforms.md#15-what-an-llm-agent-gets)) | typed actions for about ten domains, MCP opt-in ([smart-home §5](../modules/smart-home.md#5-integrate-or-build)); mcp-client lists `/api/mcp`; music needs `media_player`, not in smart-home §4 | typed actions plus opt-in MCP through the one MCP module; add `media_player` |
| 24 | Music routes | three routes, server streaming among them; librespot or spotifyd ([C.1](module-definition-config-and-dependencies.md#c1-what-modules-will-need-and-where-it-must-run)) | add "device plays a proxied URL", drop server streaming; prefer Soloist ([music §5.1](../modules/music.md#51-where-audio-comes-out-the-deciding-question)) | music's routes |
| 25 | "Louder" | speech volume ([controls §4](../modules/assistant-controls.md#4-tools)) | media volume while music plays ([music Q9](../modules/music.md#15-open-questions)) | media while media plays, else speech |
| 26 | MCP library | `@modelcontextprotocol/sdk` ([launchers §4](landscape-launchers-and-agent-tools.md#4-should-the-assistant-be-an-mcp-client)) | v2 `@modelcontextprotocol/client` ([mcp-client §5.1](../modules/mcp-client.md#51-the-client-library)); `effect/ai/McpClient` with own OAuth ([t3-code §5](../modules/t3-code.md#5-integrate-or-build)) | one library; t3-code on the MCP module's transport |
| 27 | Briefing | a routine template ([routines Q6](../modules/routines-and-automations.md#15-open-questions)); `feeds` its own module ([automation §14](landscape-automation-platforms.md#14-candidate-modules-for-us)) | own module with feeds inside ([briefing §15](../modules/briefing.md#15-open-questions)); "what did I miss" also in notifications | own module; feeds per row i; inbox reading stays in notifications |
| 28 | Deferred commands | timers hands "oven off in ten minutes" to routines ([timers §4](../modules/timers-and-alarms.md#4-tools)) | routines has no such tool; the scheduler has a `deferred command` kind ([shared-state §6.1](shared-state-jobs-and-notifications.md#61-kinds)), which energy also uses for appliance starts | a scheduler job created by the module that owns the action |
| 29 | Kids' policy layer | module or assistant setting ([web-search §10](../modules/web-search.md#10-configuration)) | household (images, video) or device policy ([fun §12](../modules/fun-and-ambient.md#12-interaction-with-the-rest-of-the-system)); no kids flag in `DevicePlace`; video speaks of private rooms, privacy is per device | household policy applied per device; add a kids flag to the place (kids asks for the same) |
| 30 | User-Agent contact | `knowledge` module setting ([core-tools §10](../modules/core-tools.md#10-configuration)) | household setting ([local-info §10](../modules/local-info.md#10-configuration)) | household |
| 31 | People naming | "Person records" (memory), "people records" (calendar, google), "person registry" and "household foundation" (lists) | `Person` ([shared-state §4.6](shared-state-jobs-and-notifications.md#46-identity-who-said-it)) | `Person` records (second-round documents now use it) |
| 32 | Home section | Home has location, time zone, language ([current-system §6.1](current-system.md#61-levels-implemented-unless-stated)) | also units and date format ([module-definition §0](module-definition-config-and-dependencies.md#0-what-exists-today)) | the code has all five (`apps/assistant/src/serve/sectionDefinitions.ts:146–183`); current-system is incomplete |
| 33 | Voice-node branch | `t3/voice-node-wp4`, `t3/add-headless-voice-node-client` ([current-system §4.4](current-system.md#44-voice-nodes-designed-only-on-main)) | `t3/standalone-triggered-voice-service` ([shared-state §1](shared-state-jobs-and-notifications.md#1-what-exists-today)) | all three branches exist locally; the owner should say which one is current (calls also cites `t3/voice-node-wp4`) |
| 34 | Module splits | separate `currency`, `dictionary`, `wikipedia`, `web-read`, `deep-research`, `places` ([launchers §7](landscape-launchers-and-agent-tools.md#7-candidate-modules-for-us)) | folded into core-tools, web-search and local-info travel | the module documents' grouping |
| 35 | Smaller ones | `calendar_move_event` (voice §17) vs folded into `calendar_change`; missed policy "run once" (core-tools) not in the scheduler's vocabulary; routines needs a `hook` actor; `video` kind and Theatre layout not in the catalogue; effort sizes differ (memory M vs S, timers L vs M, parcels M vs S) | — | settle when each is built |
| 36 | Kids' mode | a policy and an assistant template, not a module ([fun §12](../modules/fun-and-ambient.md#12-interaction-with-the-rest-of-the-system)) | its own module, taking fun's kids rows ([kids Q6](../modules/kids.md#15-open-questions)) | a kids module, with the policy enforced by the host ([kids §5.1](../modules/kids.md#51-policy-enforced-by-the-host)) |
| 37 | Camera tools | smart-home owns `camera_snapshot`, images presents it, vision calls it ([vision Q7](../modules/vision.md#15-open-questions)) | cameras-and-security takes camera, alarm and doorbell tools from smart-home and images ([cameras Q1](../modules/cameras-and-security.md#15-open-questions)) | cameras-and-security owns them; smart-home keeps the socket and locks; images and vision call it |
| 38 | Energy | `energy_now`, `energy_today`, `energySensors` in smart-home ([smart-home §4](../modules/smart-home.md#4-tools)) | moved to energy-and-vehicle; `climate_set` stays ([energy Q2](../modules/energy-and-vehicle.md#15-open-questions)) | move them |
| 39 | Leaks | moisture `critical` everywhere ([smart-home §7](../modules/smart-home.md#7-long-running-work-and-events)) | leaks `high` ([emergency Q6](../modules/emergency-and-safety.md#15-open-questions)) | no recommendation; one safety table in [emergency §9](../modules/emergency-and-safety.md#9-notifications-and-proactive-behaviour) either way |
| 40 | Who may send `critical` | inbound hooks may ([notifications §9](../modules/notifications.md#9-notifications-and-proactive-behaviour)) | only typed sensor classes and the help flow ([emergency Q7](../modules/emergency-and-safety.md#15-open-questions)); callback tokens capped at `normal` ([automation-platforms §10](../modules/automation-platforms.md#10-configuration)) | sensor classes and the help flow only |
| 41 | Help without confirmation | `message`-class tools confirm ([B.5](module-definition-config-and-dependencies.md#b5-risky-tools)) | `emergency_help` exempt, phrases host-level ([emergency §13](../modules/emergency-and-safety.md#13-privacy-and-safety)) | exempt, as emergency proposes |
| 42 | Intercom | one L item inside notifications ([notifications §1](../modules/notifications.md#1-summary)) | its own calls module ([calls Q8](../modules/calls-and-intercom.md#15-open-questions)) | own module |
| 43 | Embedding model | `multilingual-e5-small` ([memory §5.2](../modules/memory-and-notes.md#52-search)) | EmbeddingGemma-300M, shared with news ([documents §5.3](../modules/documents.md#53-question-answering-full-text-or-embeddings)) | one shared model, chosen by measurement |
| 44 | Pronunciation | `respelling` and `Contacts.pronunciation` ([contacts §5](../modules/contacts.md#5-integrate-or-build)) | a household lexicon on every speech path ([read-aloud §5.5](../modules/read-aloud.md#55-voice-cost-and-pronunciation)); the overlap is noted here, not in either document | one lexicon; contacts writes names into it |
| 45 | Long text | `read_page` capped at 6,000 characters for the model ([web-search §5.4](../modules/web-search.md#54-page-reading)) | reading must not go through the model ([read-aloud Q7](../modules/read-aloud.md#15-open-questions)) | one extractor with two outputs |
| 46 | Browser fallback for pages | keep Playwright out of `read_page` ([web-search §5.4](../modules/web-search.md#54-page-reading)) | render fallback ([launchers §3.2](landscape-launchers-and-agent-tools.md#32-reading-a-web-page), [browser-tasks Q3](../modules/browser-tasks.md#15-open-questions)) | fallback only where browser-tasks is installed |
| 47 | Translation | no tool, the model translates ([core-tools §5.6](../modules/core-tools.md#56-translation)) | a module for interpreter, camera text, subtitles ([translation Q4](../modules/translation.md#15-open-questions)) | one-offs stay with the model; the module for the rest |
| 48 | Game scores | `game_score` in fun-and-ambient ([fun §4](../modules/fun-and-ambient.md#4-tools)) | named-player scores in tabletop ([tabletop Q6](../modules/tabletop-and-games.md#15-open-questions)); quiz answers from the stored source, not an API key ([learning Q6](../modules/learning.md#15-open-questions)) | one score store in tabletop; fun keeps trivia |
| 49 | Pills and bills | "nag" reminders for pills ([reminders §6](../modules/reminders.md#6-data)); a task with a moment is a reminder ([reminders §12](../modules/reminders.md#12-interaction-with-the-rest-of-the-system)) | counted doses in health ([health Q6](../modules/health-and-fitness.md#15-open-questions)); bill dates in finance ([finance Q6](../modules/finance.md#15-open-questions)); pet medication stays with reminders | as health and finance propose |
| 50 | Second-round risk | `money` is "purchases, bookings"; one class per tool ([B.5](module-definition-config-and-dependencies.md#b5-risky-tools)) | bookings and forms as `message` ([browser-tasks §13](../modules/browser-tasks.md#13-privacy-and-safety)); per-target risk and `protected` ([homelab Q6](../modules/homelab.md#15-open-questions)); a `personal` tag ([finance Q7](../modules/finance.md#15-open-questions)) | bookings `money`; add the tag and per-target risk to the manifest |
| 51 | Leave-by | "when must I leave" in local-info `travel` ([local-info §1](../modules/local-info.md#1-summary)); leave-time reminders in calendar ([calendar §7](../modules/calendar.md#7-long-running-work-and-events)) | trips owns one-off leave-by ([trips Q5–Q6](../modules/trips.md#15-open-questions)) | trips for one-off trips, local-info for commutes; calendar events open |
| 52 | Shopping and tasks | whole-list backends (Bring!, KitchenOwl, Todoist) ([lists §5](../modules/lists.md#5-integrate-or-build)); does ticking an item in the shop book a purchase ([kitchen Q6](../modules/kitchen.md#15-open-questions)) | a Picnic cart is not a list backend, and is booked on delivery ([grocery Q5–Q6](../modules/grocery-shopping.md#15-open-questions)); work trackers are capture only ([focus Q6](../modules/focus-and-productivity.md#15-open-questions)) | as grocery and focus propose |
| 53 | What counts as a timer | a focus session is a countdown, so it could appear in "what timers are running?" | focus sessions and workout intervals stay apart from household timers, with their own ambient lines ([focus Q5](../modules/focus-and-productivity.md#15-open-questions), [health Q7](../modules/health-and-fitness.md#15-open-questions)) | apart |
| 54 | CI status | t3-code defers CI to later ([t3-code §5](../modules/t3-code.md#5-integrate-or-build)) | dev-tools owns `dev_checks`; `t3_ci_status` calls it ([dev-tools Q5](../modules/dev-tools.md#15-open-questions)) | dev-tools |
| 55 | MCP starter list | GitHub, Playwright and desktop MCP servers suggested ([mcp-client §5.4](../modules/mcp-client.md#54-a-vetted-starter-list)) | GitHub answered natively ([dev-tools Q6](../modules/dev-tools.md#15-open-questions)); Playwright read-only ([browser-tasks Q5](../modules/browser-tasks.md#15-open-questions)); desktop servers off ([computer-control Q8](../modules/computer-control.md#15-open-questions)); infrastructure only with a read-only switch ([homelab Q7](../modules/homelab.md#15-open-questions)); n8n polling in automation ([automation-platforms Q2](../modules/automation-platforms.md#15-open-questions)) | tighten the list as those documents ask |
| 56 | The `system` split | no `system` module ([controls Q9](../modules/assistant-controls.md#15-open-questions)); `system_status` probes the internet itself ([core-tools §5.5](../modules/core-tools.md#55-system-status)) | PC volume in computer-control ([Q7](../modules/computer-control.md#15-open-questions)); speed test and outage verdict in network ([network Q7–Q8](../modules/network.md#15-open-questions)) | as computer-control and network propose |
| 57 | Smaller ownership moves | video announces new Jellyfin episodes ([video §9](../modules/video.md#9-notifications-and-proactive-behaviour)); memory keeps voice-note audio in `recordings/` ([memory §6](../modules/memory-and-notes.md#6-data)); printers has `scan_to_paperless` ([printers Q6](../modules/printers.md#15-open-questions)) | media-requests notifies, video only plays ([media-requests Q3](../modules/media-requests.md#15-open-questions)); dictation owns recorded audio and its retention ([dictation Q7–Q8](../modules/dictation-and-transcription.md#15-open-questions)); Paperless belongs to documents ([documents §5.1](../modules/documents.md#51-paperless-ngx-the-main-provider)) | media-requests; dictation; documents owns Paperless and printers hands it the scan |
| 58 | The ambient state | idle with pinned items ([presentation §4.4](presentation-and-device-capabilities.md#44-pinned-widgets-and-the-ambient-stage)); briefing cards pinned, photo frame as its own mode ([briefing §8](../modules/briefing.md#8-presentation), [images §8](../modules/images-and-photos.md#8-presentation)) | the dashboard is the ambient state on `alwaysOn` devices; cards and frame become pages ([dashboard Q7–Q8](../modules/dashboard.md#15-open-questions)) | the dashboard on `alwaysOn` devices |
| 59 | Where things are | free facts in memory ([memory §6](../modules/memory-and-notes.md#6-data)) | structured locations in home-maintenance ([home-maintenance Q2](../modules/home-maintenance.md#15-open-questions)) | structured; whether memory hands such facts over is open |
| 60 | Presence event names | `presence.changed` ([reminders §7](../modules/reminders.md#7-long-running-work-and-events)) | `presence.arrived`/`left` ([presence Q1](../modules/presence-and-people.md#15-open-questions)); `presence.everyone_left`/`first_home` ([energy §7](../modules/energy-and-vehicle.md#7-long-running-work-and-events)) | presence-and-people's names (row 16) |
| 61 | Smaller ones | documents effort M vs L ([documents Q7](../modules/documents.md#15-open-questions)); home-maintenance tables use an `m_house__` prefix; `camera?: boolean` vs a structured camera ([vision Q8](../modules/vision.md#15-open-questions)); the `live` kind and Call layout beside video's `video` kind ([video Q1](../modules/video.md#15-open-questions)) | — | settle when each is built |

## 12. Open questions for the owner

**The seven that block the most work:**

1. **Who lives in the house, and is per-person data wanted now?** Is a default person per device enough until voice ID
   is tried; do `Person` records live in settings or the store? Blocks reminders, lists, memory, calendar, google,
   kitchen, music, messaging, notifications, presence, contacts, kids, learning, broadcast, calls, finance, health,
   trips, media-requests ([module-definition Q1–2](module-definition-config-and-dependencies.md#open-questions-for-the-owner),
   [shared-state Q2](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner), [presence Q7](../modules/presence-and-people.md#15-open-questions)).
2. **Second-round boundaries:** accept section 11 rows g–n and 36–38? Each changes the scope of a first-wave module
   (notifications, messaging, briefing, music, smart-home, routines, fun-and-ambient) before it is built
   ([broadcast Q1](../modules/broadcast.md#15-open-questions), [contacts Q1](../modules/contacts.md#15-open-questions), [presence Q1](../modules/presence-and-people.md#15-open-questions),
   [automation-platforms Q1](../modules/automation-platforms.md#15-open-questions)).
3. **Server target and vault:** Debian/Ubuntu x64 or arm64; RAM for Chromium beside the speech models; systemd script or
   Compose first; unattended vault unlock with a TPM-bound credential or manual unlock after each restart; a second
   place for backups. Blocks Phase 0 ([module-definition Q3, Q7](module-definition-config-and-dependencies.md#open-questions-for-the-owner),
   [shared-state Q12](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner), [browser-tasks Q7](../modules/browser-tasks.md#15-open-questions)).
4. **Rooms:** a room per device in our settings, or HA areas? Blocks smart-home "here", ringing, announcements, music,
   video, broadcast, calls, dashboard ([shared-state Q7](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner),
   [smart-home Q1](../modules/smart-home.md#15-open-questions)).
5. **Wake-free speech:** "stop" while something rings or a reply plays (also from a TV, past the echo gate's two-word
   rule), broadcast replies, "help" anywhere, game-window phrases. Blocks controls, timers, notifications, briefing,
   music, broadcast, emergency, tabletop ([controls Q1](../modules/assistant-controls.md#15-open-questions), [timers Q2](../modules/timers-and-alarms.md#15-open-questions),
   [shared-state Q4](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner), [broadcast Q4](../modules/broadcast.md#15-open-questions),
   [emergency Q3](../modules/emergency-and-safety.md#15-open-questions), [tabletop Q3](../modules/tabletop-and-games.md#15-open-questions)).
6. **Risk defaults and trusted devices:** `message: confirm`, `money: deny`, `security: deny`; which devices are
   trusted; when confirmations go on; a `personal` tag and per-target risk? Blocks locks, messaging, MCP, T3 Code,
   routines, cameras, grocery, finance, homelab, browser-tasks, computer-control
   ([module-definition Q6](module-definition-config-and-dependencies.md#open-questions-for-the-owner), [smart-home Q3](../modules/smart-home.md#15-open-questions),
   [mcp-client Q4](../modules/mcp-client.md#15-open-questions), [t3-code Q1](../modules/t3-code.md#15-open-questions), [finance Q7](../modules/finance.md#15-open-questions),
   [homelab Q6](../modules/homelab.md#15-open-questions), [grocery Q2](../modules/grocery-shopping.md#15-open-questions)).
7. **Cameras and images to the model:** a device camera in the house at all; frames, screenshots and camera pictures to
   a hosted model; image tool results in core now? Blocks vision, cameras, translation, computer-control, plants,
   documents scanning, images ([translation Q5](../modules/translation.md#15-open-questions), [vision Q1, Q9](../modules/vision.md#15-open-questions),
   [cameras Q4](../modules/cameras-and-security.md#15-open-questions), [computer-control Q4](../modules/computer-control.md#15-open-questions), [smart-home Q4](../modules/smart-home.md#15-open-questions),
   [images Q6–Q7](../modules/images-and-photos.md#15-open-questions)).

**Household and people.** Who may cancel whose timer and read whose reminders (shared-state Q11, reminders Q4); does an
alarm belong to a device or a person ([timers Q3](../modules/timers-and-alarms.md#15-open-questions)); chore rotation and points
([lists Q4](../modules/lists.md#15-open-questions)); meal plan per household or person ([kitchen Q10](../modules/kitchen.md#15-open-questions)); are there children
and how old, which decides kids' mode and its wave ([fun Q1](../modules/fun-and-ambient.md#15-open-questions), [kids Q1](../modules/kids.md#15-open-questions)), and the
homework default ([learning Q4](../modules/learning.md#15-open-questions)); which list, calendar and chat apps the family already uses
([lists Q1](../modules/lists.md#15-open-questions), [calendar Q1](../modules/calendar.md#15-open-questions), [messaging Q1](../modules/messaging.md#15-open-questions)); presence source,
voice ID and location sharing between adults and of children ([presence Q2–Q5](../modules/presence-and-people.md#15-open-questions)); contacts' source
of truth, who sees whose, relations taught by voice ([contacts Q2–Q3, Q5](../modules/contacts.md#15-open-questions)); who emergency is for, act
at once or ask ([emergency Q1–Q2](../modules/emergency-and-safety.md#15-open-questions)); medication by the assistant and a second person to escalate
to ([health Q1–Q2](../modules/health-and-fitness.md#15-open-questions)).

**Devices and rooms.** Ring only where set or widen after a minute ([shared-state Q3](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner),
[timers Q1](../modules/timers-and-alarms.md#15-open-questions)); node-local `alerts.sync` in the first node release
([timers Q5](../modules/timers-and-alarms.md#15-open-questions)); voice nodes with small displays or cameras planned
([presentation Q9](presentation-and-device-capabilities.md#8-open-questions-for-the-owner), [vision Q5](../modules/vision.md#15-open-questions)); should devices accept presentations
from others by default ([presentation Q4](presentation-and-device-capabilities.md#8-open-questions-for-the-owner)); what "sleep" means
([controls Q2](../modules/assistant-controls.md#15-open-questions)); media guard on every device ([music Q5](../modules/music.md#15-open-questions)); which screens are
dashboards, the kiosk app, OLED panels ([dashboard Q1, Q4–Q5](../modules/dashboard.md#15-open-questions)); drop-in and listen-in at all
([calls Q1](../modules/calls-and-intercom.md#15-open-questions)); bedrooms overridden by "everywhere, now" ([broadcast Q7](../modules/broadcast.md#15-open-questions)); which
router ([network Q1](../modules/network.md#15-open-questions)).

**Deployment.** One server, or a second that works alone ([shared-state Q1](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner)); may the UI
update yt-dlp to the latest signed release ([module-definition Q9](module-definition-config-and-dependencies.md#open-questions-for-the-owner)); stdio MCP servers
and Docker or Podman ([mcp-client Q2, Q5](../modules/mcp-client.md#15-open-questions)); where T3 Code runs after the move
([t3-code Q3](../modules/t3-code.md#15-open-questions)); self-hosting OSRM or MOTIS ([local-info Q6](../modules/local-info.md#15-open-questions)); the HTTPS certificate
route ([calls Q3](../modules/calls-and-intercom.md#15-open-questions)); LiveKit as a service ([calls Q4](../modules/calls-and-intercom.md#15-open-questions)); a 300 MB embedding
model ([documents Q4](../modules/documents.md#15-open-questions)); which languages, deciding the recogniser
([translation Q1](../modules/translation.md#15-open-questions), [learning Q2](../modules/learning.md#15-open-questions)); companion agent language and desktops
([computer-control Q1–Q2](../modules/computer-control.md#15-open-questions), [dictation Q5](../modules/dictation-and-transcription.md#15-open-questions)); is a server browser worth 300
MB and a model account ([browser-tasks Q1](../modules/browser-tasks.md#15-open-questions)).

**Accounts and providers.** Own Google and Spotify OAuth apps and a real domain with a DNS-01 certificate
([module-definition Q4](module-definition-config-and-dependencies.md#open-questions-for-the-owner), [google §5.2](../modules/google.md#52-the-oauth-reality-for-a-self-hosted-server)); Google scopes and
whether mail ever goes to the hosted model ([google Q2–Q4](../modules/google.md#15-open-questions)); Music Assistant as backbone or Spotify
direct, and the six-month Spotify re-sign-in ([music Q1, Q4](../modules/music.md#15-open-questions)); default search provider and monthly cap
([web-search Q1–Q2](../modules/web-search.md#15-open-questions)); which phones, and are Apple/Google push relays acceptable
([shared-state Q6](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner), [notifications Q1–Q2](../modules/notifications.md#15-open-questions)); a spare Android phone as
SMS gateway ([emergency Q4](../modules/emergency-and-safety.md#15-open-questions)); n8n or Node-RED in use ([routines Q2](../modules/routines-and-automations.md#15-open-questions),
[automation-platforms Q7](../modules/automation-platforms.md#15-open-questions)); bin-day ICS or HA `waste_collection_schedule`
([local-info Q7](../modules/local-info.md#15-open-questions)). Most second-round documents first ask which backing app runs (usually Q1; see
[section 7](#7-module-catalogue)): Grocy or Mealie, Audiobookshelf, a read-later service, Miniflux, Paperless-ngx, Frigate, evcc
and the energy contract, a budget app, online groceries, Seerr, forges, homelab backends, printers, Anki, work tools,
pets and sensors, flights.

**Privacy and risk.** Personal content on shared screens and speakers, and who marks it
([presentation Q5](presentation-and-device-capabilities.md#8-open-questions-for-the-owner), [calendar Q3](../modules/calendar.md#15-open-questions), [finance Q3](../modules/finance.md#15-open-questions),
[read-aloud Q5](../modules/read-aloud.md#15-open-questions), [news Q4](../modules/news-and-feeds.md#15-open-questions)); secrets in memory, and speaking them or the guest
Wi-Fi password ([memory Q3](../modules/memory-and-notes.md#15-open-questions), [presence Q6](../modules/presence-and-people.md#15-open-questions), [network Q6](../modules/network.md#15-open-questions));
voice unlock, disarm or garage ([smart-home Q3](../modules/smart-home.md#15-open-questions)); send messages as yourself or a household bot
([messaging Q2–Q3](../modules/messaging.md#15-open-questions)); inbound hooks from outside the LAN ([notifications Q6](../modules/notifications.md#15-open-questions),
[routines Q5](../modules/routines-and-automations.md#15-open-questions)); add calendar events without asking ([calendar Q2](../modules/calendar.md#15-open-questions)); automatic
memory saving ([memory Q2](../modules/memory-and-notes.md#15-open-questions)); documents to the hosted model ([documents Q2](../modules/documents.md#15-open-questions));
hosted summaries and retention of recordings ([dictation Q3–Q4](../modules/dictation-and-transcription.md#15-open-questions)); recording calls, the
assistant hearing them ([calls Q6–Q7](../modules/calls-and-intercom.md#15-open-questions)); interpreter transcripts kept
([translation Q6](../modules/translation.md#15-open-questions)); children's conversations kept for review, their model
([kids Q2–Q3](../modules/kids.md#15-open-questions)); restarts, typing and feeder dispensing by voice ([homelab Q2–Q3](../modules/homelab.md#15-open-questions),
[computer-control Q3](../modules/computer-control.md#15-open-questions), [plants Q3](../modules/plants-and-pets.md#15-open-questions)); the medical card on shared screens
([emergency Q5](../modules/emergency-and-safety.md#15-open-questions)).

**Presentation.** How playful the stage is, and whether tapping the character dismisses
([presentation Q2–Q3](presentation-and-device-capabilities.md#8-open-questions-for-the-owner)); a recipe on two screens in step or independent (Q7); MCP Apps ever
(Q8, [mcp-client Q8](../modules/mcp-client.md#15-open-questions)); new `video` kind and Theatre layout, with the Call layout and `live` kind
([video Q1](../modules/video.md#15-open-questions)); new `agenda` kind ([calendar Q4](../modules/calendar.md#15-open-questions)); timers before or after the first
presentation kinds ([presentation Q10](presentation-and-device-capabilities.md#8-open-questions-for-the-owner)); spoken or earcon confirmations
([controls Q3](../modules/assistant-controls.md#15-open-questions)); a `breath` style ([health Q5](../modules/health-and-fitness.md#15-open-questions)); a news ticker or a calm
stage ([news Q5](../modules/news-and-feeds.md#15-open-questions)); party games piloting `stage.content` and `reply.expression`
([tabletop Q5](../modules/tabletop-and-games.md#15-open-questions)); contact photos on a ringing card ([contacts Q7](../modules/contacts.md#15-open-questions)); stable
dashboard pages or rotation ([dashboard Q6](../modules/dashboard.md#15-open-questions)).

**Per module, first round.** Timers: wire Jev first or ship through the model and measure ([Q7](../modules/timers-and-alarms.md#15-open-questions)).
Reminders: hold in quiet hours or phone; nag by default ([Q3, Q7](../modules/reminders.md#15-open-questions)). Kitchen: hands-free "next", book
on "done", invented recipes, barcodes, Dutch data ([Q3–Q9](../modules/kitchen.md#15-open-questions)). Lists: split on "and", keep done items a
day ([Q6–Q7](../modules/lists.md#15-open-questions)). Memory: 200 tokens per turn, two-way sync, keep audio, embeddings
([Q4–Q8](../modules/memory-and-notes.md#15-open-questions)). Briefing: sections, length, schedule, feeds ([Q1–Q6](../modules/briefing.md#15-open-questions)). Core tools:
one module or three, cup size, crypto ([Q1–Q7](../modules/core-tools.md#15-open-questions)). Web search: provider-native search, research model
account, speculative paid searches ([Q3–Q5](../modules/web-search.md#15-open-questions)). Local info: NL location, Buienradar, MeteoAlarm,
parcels ([Q1–Q9](../modules/local-info.md#15-open-questions)). Images: generation at all, rights-unknown images, frame sources
([Q2–Q7](../modules/images-and-photos.md#15-open-questions)). Video: unofficial extractors, Gemini summaries, kids and YouTube, TVs that cannot be
turned on ([Q2–Q6](../modules/video.md#15-open-questions)). Music: route 3, Sendspin, ducking, characters on the beat
([Q2–Q8](../modules/music.md#15-open-questions)). Routines: step set, voice drafts, phrases bypassing agents, definitions in settings or store
([Q1, Q3–Q4, Q7](../modules/routines-and-automations.md#15-open-questions)). Notifications: own-voice announce (also [broadcast Q2](../modules/broadcast.md#15-open-questions)),
wake-free replies, intercom, bedroom flag ([Q3–Q7](../modules/notifications.md#15-open-questions)). Smart-home: admin user, Mosquitto, safety
sensors critical, without HA ([Q5–Q8](../modules/smart-home.md#15-open-questions)). MCP: strictness, Tool context to servers, tool ceiling
([Q3, Q6–Q7](../modules/mcp-client.md#15-open-questions)). T3 Code: approvals, workspace, read-back, push, GitHub, re-approval, dedicated module
([Q2, Q4–Q9](../modules/t3-code.md#15-open-questions)). Fun: sound library, idle context, Dutch trivia ([Q2–Q4](../modules/fun-and-ambient.md#15-open-questions)).
Providers in the module system ever ([module-definition Q10](module-definition-config-and-dependencies.md#open-questions-for-the-owner)); out-of-tree TypeScript
modules (Q8); long tasks re-run after a restart and announcements in history
([shared-state Q9–Q10](shared-state-jobs-and-notifications.md#11-open-questions-for-the-owner)).

**Per module, second round.** Broadcast: voice messages played on arrival, school-day calendar, audio on phones
([Q3, Q5–Q6](../modules/broadcast.md#15-open-questions)). Calls: relay first or WebRTC, SIP number ([Q2, Q5](../modules/calls-and-intercom.md#15-open-questions)). Contacts:
IPA as well as respellings, birthdays from contacts or calendar ([Q4, Q6](../modules/contacts.md#15-open-questions)). Emergency: monthly test
alert ([Q8](../modules/emergency-and-safety.md#15-open-questions)). News: starter outlets, Kagi Kite licence, paywalls
([Q2–Q3, Q6](../modules/news-and-feeds.md#15-open-questions)). Podcasts: gPodder sync, "continue" on a new device, route 3 in the bedroom,
overnight transcripts, per-show speed ([Q2–Q5, Q7](../modules/podcasts-and-audiobooks.md#15-open-questions)). Read-aloud: local or hosted reading voice,
ebooks at all, the reading session in core, the lexicon on replies ([Q2–Q4, Q6](../modules/read-aloud.md#15-open-questions)). Documents: fact
extraction and write-back, Paperless's own chat ([Q3, Q5–Q6](../modules/documents.md#15-open-questions)). Translation: interpreter engine by
`TurnTrace`, a `voices` map in core (shared with learning, tabletop) ([Q2–Q3](../modules/translation.md#15-open-questions)). Learning:
pronunciation, correction style ([Q3, Q5](../modules/learning.md#15-open-questions)). Kids: handed-back topics and parent alerts, rewards
([Q4–Q5](../modules/kids.md#15-open-questions)). Tabletop: which games, rulebook PDFs on the server, multi-room games
([Q1–Q2, Q4](../modules/tabletop-and-games.md#15-open-questions)). Cameras: push-to-talk or a sentence at the door, brands, Frigate faces
([Q5–Q7](../modules/cameras-and-security.md#15-open-questions)). Energy: remote starts, all-in price, anomaly alerts, home battery
([Q4–Q7](../modules/energy-and-vehicle.md#15-open-questions)). Home maintenance: inventory home, seeded Dutch tasks, manuals, insurance export
([Q1, Q4–Q6](../modules/home-maintenance.md#15-open-questions)). Plants and pets: "not fed" alerts, camera capture on the voice page, a garden
module ([Q2, Q4–Q5](../modules/plants-and-pets.md#15-open-questions)). Finance: Enable Banking, housemates' shared expenses, no tool ever moves
money ([Q2, Q4–Q5](../modules/finance.md#15-open-questions)). Health: wearables, Strava and the model ([Q3–Q4](../modules/health-and-fitness.md#15-open-questions)). Focus:
phone DND, ActivityWatch, morning plan and review ([Q2–Q4](../modules/focus-and-productivity.md#15-open-questions)). Trips: mail ingestion folder or
address, flight API cost, holiday mode ([Q2–Q4](../modules/trips.md#15-open-questions)). Grocery: the unofficial Picnic client, brand rule
([Q3–Q4](../modules/grocery-shopping.md#15-open-questions)). Computer control: where scripts live, power off as a verb
([Q5–Q6](../modules/computer-control.md#15-open-questions)). Homelab: alerts through our hook or the phone app, a pinned status board
([Q4, Q8](../modules/homelab.md#15-open-questions)). Network: pausing children's devices, new-device alerts, presence hint, fresh speed tests
([Q2–Q5](../modules/network.md#15-open-questions)). Dev tools: issues by voice, on-call, the digest, `dev_rerun`
([Q2–Q4, Q7](../modules/dev-tools.md#15-open-questions)). Printers: Bambu Developer Mode, label encoder, failure detection, pause from any room
([Q2–Q5](../modules/printers.md#15-open-questions)). Vision: local VLM, accessibility mode, homework help, oven camera
([Q2–Q4, Q6](../modules/vision.md#15-open-questions)). Dictation: meetings at all, wake phrases while recording, speaker enrolment
([Q1–Q2, Q6](../modules/dictation-and-transcription.md#15-open-questions)). Dashboard: an existing HA dashboard, presence sensors near screens
([Q2–Q3](../modules/dashboard.md#15-open-questions)). Automation: n8n via MCP or REST, input schemas, the HA custom integration, `/turn` at all,
questions in quiet hours ([Q3–Q6, Q8](../modules/automation-platforms.md#15-open-questions)). Browser tasks: commit after a spoken yes, hosted
browsers, the driver model ([Q2, Q4, Q6](../modules/browser-tasks.md#15-open-questions)). Media requests: Seerr's single webhook, per-person users,
Trakt, streaming titles, kids' requests ([Q2, Q4–Q7](../modules/media-requests.md#15-open-questions)).
