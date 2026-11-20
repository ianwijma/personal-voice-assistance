# Landscape: automation platforms and household apps

Research for the module catalogue: what existing automation platforms ship as integrations, how they define one, how they
model triggers and shared state, what an LLM agent gets from them, and which self-hosted household apps we should
integrate with rather than rebuild. Researched 2026-11-17. Numbers are snapshots; each is dated where the source gives a
date. Anything not confirmed from a primary source is marked **[unverified]**.

Our current module contract, for reference: `AssistantModule { name, tools?, context? }` in
`packages/core/src/Module.ts`, plus declared actions (`defineAction`, typed `Param.*`, `speculative`, `confirm`,
`offerAsTool`) from `docs/AGENTS-AND-INTENTS.md` §3. Built-in modules today: `clock`, `weather`, `demo-home`,
`home-assistant` (lights only).

## Summary

- **The household use cases are the same everywhere, and they are small.** Across Home Assistant (HA) analytics, n8n
  node usage, Zapier's popular apps and IFTTT's top services, the things people actually wire up are: lists (shopping,
  to-do), calendars, timers, notifications to a phone, media and music, weather, presence, and "tell me when X
  happened". Business apps (Sheets, Gmail, Slack, HubSpot) dominate Zapier and n8n but have little household value
  beyond Google Calendar, Gmail and Telegram.
- **Home Assistant is the reference design for us, not n8n or Zapier.** It has typed entity domains (`todo`,
  `calendar`, `timer`, `notify`, `media_player`) that many providers implement behind one set of actions, a declarative
  `manifest.json`, an LLM API whose tool class mirrors MCP tool annotations, built-in voice intents for timers and lists,
  and an MCP server. 579,869 HA installs report integrations (snapshot 2026-11-15); `mcp_server` is on 48,995 of them
  and the MCP client on 41,662.
- **The strongest pattern to copy is "capability interface + provider adapters".** HA's `todo` entity is implemented by
  `local_todo`, Todoist, Google Tasks, CalDAV, Bring, Mealie and others; the LLM sees one `todo__get_items` tool and the
  `HassListAddItem` intent regardless of provider. We should define `Lists`, `Calendar`, `Timers`, `Notifier`,
  `MediaPlayer` capabilities once and let modules provide them, exactly as we already do for `Stt`/`Tts`.
- **Every platform separates credentials from the integration and tests them.** n8n credential types (with a `test`
  request and declarative `authenticate` injection), Activepieces `PieceAuth` with `validate`, Zapier `authentication`
  with a test call, Windmill typed resources referencing `$var:` secrets. One OAuth credential (Google) should serve
  several modules (Calendar, Tasks, Gmail).
- **Triggers come in four shapes everywhere:** schedule/cron, polling with de-duplication by a primary key, webhook with
  an enable/disable lifecycle, and a long-lived connection (websocket/MQTT). Polling is the latency trap: IFTTT polls
  roughly once an hour per applet.
- **Workflow platforms expose user-built workflows as tools.** HA scripts become `script__<name>` tools, n8n workflows
  become tools via the MCP Server Trigger, Make exposes "on-demand" scenarios, Windmill exposes scripts and flows. A
  "routines" module plus an MCP client module would give us the long tail without writing integrations.
- **For household apps: integrate, do not rebuild** Grocy, Mealie/Tandoor, Music Assistant, Jellyfin/Plex, Immich,
  Paperless-ngx, Nextcloud (via CalDAV/CardDAV) and ntfy/Apprise. **Build** local timers, alarms, reminders, a simple
  local list store, broadcast between our devices, and the kitchen helpers (step reader, conversions), because they are
  latency-critical, tied to our devices, or trivial.

## 1. Home Assistant

### 1.1 Popularity (HA analytics)

Source: [analytics.home-assistant.io](https://analytics.home-assistant.io/integrations), raw data from
`https://analytics.home-assistant.io/data.json`, last updated 2026-11-15. 734,040 active installs, 579,869 of them
report integrations. Averages per install: 30 integrations, 14 automations, 6 add-ons, 2 users, 411 entities.

Caveat: several top entries are created automatically at onboarding (`met`, `radio_browser`, `google_translate`,
`shopping_list`, `sun`, the core helpers), so their counts measure defaults, not choice. Entity-platform domains such as
`light` or `calendar` show only YAML-configured platforms and are meaningless as a ranking.

Top integrations by install count (core, excluding pure infrastructure such as `frontend`, `http`, `logger`):

| # | Integration | Installs | Note |
|---|---|---|---|
| 1–6 | sun, person, automation, script, scene | 567k–578k | default config |
| 8 | google_translate (TTS) | 538,821 | onboarding default |
| 10 | mobile_app | 498,842 | the companion app: phones as sensors and notification targets |
| 12 | met (weather) | 484,318 | onboarding default |
| 13 | radio_browser | 481,980 | onboarding default |
| 15 | shopping_list | 445,712 | onboarding default |
| 16 | cast | 295,925 | first strong opt-in signal |
| 18 | mqtt | 279,959 | |
| 20 | matter | 242,716 | |
| 27 | tuya | 171,035 | |
| 31 | esphome | 159,137 | includes voice satellites |
| 33 | shelly | 147,348 | |
| 34 | zha (Zigbee) | 146,656 | |
| 35 | energy | 141,241 | |
| 50 | sonos | 94,187 | |
| 52 | hue | 91,678 | |
| 53 | timer (helper) | 87,557 | |
| 66 | music_assistant | 64,529 | |
| 71 | wyoming (local voice) | 56,003 | |
| 75 | local_calendar | 52,279 | |
| 80 | mcp_server | 48,995 | HA as MCP server |
| 85 | notify | 46,370 | |
| 87 | schedule | 46,032 | |
| 88 | local_todo | 44,860 | |
| 90 | google (Calendar) | 43,906 | |
| 92 | mcp (client) | 41,662 | HA calling external MCP tools |
| 96 | google_generative_ai_conversation | 37,808 | |
| 103 | spotify | 33,179 | |
| 113 | alexa_devices | 29,339 | |
| 118 | telegram_bot | 27,912 | |

Household-relevant long tail (same snapshot): openai_conversation 23,986; plex 19,946; google_drive 16,016; ollama
13,935; caldav 13,874; remote_calendar 11,365; waze_travel_time 11,016; jellyfin 8,982; anthropic 8,507; bring 7,587;
kodi 7,021; immich 3,764; mealie 3,565; google_mail 3,081; google_tasks 2,843; todoist 2,811; nextcloud 2,619; ntfy
2,065; paperless_ngx 1,956.

Custom integrations (HACS, [custom_integrations.json](https://analytics.home-assistant.io/custom_integrations.json)):
hacs 186,237; alexa_media 31,022; frigate 30,595; **waste_collection_schedule 27,453** (bin-day reminders, a strong
household signal); alarmo 27,429; **ha_mcp_tools 23,637**; scheduler 23,454; adaptive_lighting 17,923; battery_notes
15,438; grocy 815. Add-ons ([addons.json](https://analytics.home-assistant.io/addons.json)): file editor 276,765;
mosquitto 246,891; matter server 243,869; ESPHome 130,152; zigbee2mqtt 112,179; Music Assistant 65,118; Node-RED 54,545;
piper 41,645; whisper 35,500; openwakeword 22,970; a community **HA MCP add-on 19,719**.

Reading: MCP is already mainstream in the HA world (core server + client + two community MCP projects together exceed
100k installs). Music Assistant is the music answer. Lists, calendars and timers are used by a large minority.

### 1.2 How an integration is defined

A folder named after the `domain` with a `manifest.json`
([manifest docs](https://contributors.home-assistant.io/core/integrations/manifest/)). Example from the docs:

```json
{ "domain": "airgradient", "name": "AirGradient", "codeowners": ["@airgradienthq", "@joostlek"],
  "config_flow": true, "documentation": "https://www.home-assistant.io/integrations/airgradient",
  "integration_type": "device", "iot_class": "local_polling", "quality_scale": "platinum",
  "requirements": ["airgradient==0.10.0"], "zeroconf": ["_airgradient._tcp.local."] }
```

Keys that matter for us:

- `domain`: stable id, must never change because config entries, entity ids and automations depend on it.
- `requirements`: exact-pinned pip packages installed before load; if installation fails the integration does not load.
  `dependencies` (must load first) and `after_dependencies` (load first if configured).
- `iot_class`: `local_polling`, `local_push`, `cloud_polling`, `cloud_push`, `assumed_state`, `calculated`. It tells the
  user, before installing, whether it needs the internet and whether state is live.
- `integration_type`: `device`, `hub`, `service`, `helper`, `entity`, `hardware`, `system`, `virtual`.
- `config_flow: true` means UI setup; `single_config_entry` forbids a second instance.
- `quality_scale`: bronze/silver/gold/platinum, a checklist-based maturity tier.
- Discovery matchers: `zeroconf`, `ssdp`, `dhcp`, `usb`, `bluetooth`, `homekit`, `mqtt`. HA proposes the integration
  when a matching device appears on the network.
- Custom integrations must add `version` and `issue_tracker`.

Credentials live in the config entry created by the config flow (stored in `.storage`, not encrypted at rest
**[unverified: HA stores config entries as plain JSON as far as I know]**). OAuth goes through the shared
`application_credentials` mechanism, so one Google client id serves several Google integrations **[unverified detail]**.

### 1.3 Triggers, automations, scripts, blueprints

- Automations are trigger → condition → action documents; triggers include state change, time, time pattern, sun,
  zone, event, webhook, MQTT, template, calendar event, conversation sentence.
- Scripts are action sequences with typed `fields`, started on demand. They have no trigger.
- [Blueprints](https://www.home-assistant.io/docs/blueprint/) are parameterised automations or scripts: a `blueprint:`
  header with `name`, `domain` (automation/script/template), `source_url` and `input:` items each carrying a
  `selector` (entity of domain X, number, time ...), referenced in the body with `!input`. Shared through a forum
  exchange. Automations created from a blueprint pick up blueprint changes on reload.
- Integrations push state into the state machine (`local_push`) or are polled by a `DataUpdateCoordinator`
  **[unverified name, from memory]** on an interval.

### 1.4 Shared state: entities

Everything is an entity `domain.object_id` with a state string plus attributes, in one state machine with an event bus.
Typed domains come with standard actions, which is what lets many providers look the same:

- **To-do** ([todo](https://www.home-assistant.io/integrations/todo/)): state = number of open items; actions
  `todo.get_items`, `add_item`, `update_item`, `remove_item`, `remove_completed_items`. Providers include `local_todo`,
  `shopping_list`, Todoist, Google Tasks, CalDAV, Bring, Mealie, and custom Grocy.
- **Calendar**: events with start/end/summary; providers `local_calendar`, Google, CalDAV, `remote_calendar` (ICS URL).
  Calendar events can trigger automations.
- **Timer helper**: an entity with start/pause/cancel/finish. Separately, **Assist voice timers** (since
  [Voice Chapter 7, June 2024](https://home-assistant.io/blog/2024/06/26/voice-chapter-7)) are not entities: each timer
  belongs to the satellite that started it, and the satellite must support timer events. Community reports say a
  timer on the Voice Preview Edition cannot be started from an automation **[unverified, forum report]**.
- **Notify** ([notify](https://www.home-assistant.io/integrations/notify/)): newer notify entities (state = time of last
  message) targeted with `notify.send_message`; legacy `notify.<service>`; `notify.notify` goes to "the first notify
  action found", which the docs warn may not be what you expect. The mobile app is the usual target.
- `person` and `zone` give presence; `media_player` gives playback; `weather` gives forecasts.

### 1.5 What an LLM agent gets

The [LLM API](https://contributors.home-assistant.io/core/internals/llm-api/) is a set of tools plus a prompt that
explains them. Two built-in APIs: **Assist** ("Device control", only entities the user exposed to voice assistants, no
admin actions) and **Home Assistant** (registries, logs, automations, config; admin only). Integrations contribute tools
through an `llm.py` platform with `async_get_tools(hass, llm_context, api_id)`, called per request so tools can depend
on the device or assistant.

The `llm.Tool` class: `name` (must be prefixed `<domain>__`, e.g. `my_integration__coffee_count`; unprefixed names are
deprecated), `integration`, `description` (written for the model), `title`, `parameters` (a `probatio` schema, HA's
schema library, see [helpers/llm.py](https://github.com/home-assistant/core/blob/dev/homeassistant/helpers/llm.py)),
and `annotations` matching MCP tool annotations: `read_only` (default false), `destructive` (default true),
`idempotent` (default false), `open_world` (default true). The defaults assume the worst. `async_call` gets a
`ToolInput` and an `LLMContext` (`platform`, `context`, `language`, `assistant`, `device_id`) and returns
`llm.ToolResult(data=...)`; errors are raised or returned with `error=True`.

Tools in the current `dev` branch (from the `llm.py` files in `homeassistant/components/*/llm.py`):
`homeassistant__GetLiveContext`, `homeassistant__render_template`, `homeassistant__search_actions`,
`homeassistant__call_action`, `calendar__get_events`, `todo__get_items`, `history__get_history`, `llm__GetDateTime`,
`media_player__search_media`, `media_player__play_media`, `assist_satellite__broadcast`, intent tools named
`<domain>__<IntentType>`, and **one tool per exposed script** (`script__<name>`, parameters from the script's `fields`).

Built-in intents ([intents.yaml](https://github.com/home-assistant/intents/blob/main/intents.yaml)) are a ready
checklist for our typed actions: `HassTurnOn/Off`, `HassGetState`, `HassLightSet`, `HassClimateSetTemperature`,
`HassSetPosition`, `HassBroadcast`, `HassGetCurrentDate/Time`, `HassGetWeather`, `HassShoppingListAddItem`,
`HassListAddItem/CompleteItem/RemoveItem`, media (`HassMediaPause/Unpause/Next/Previous`, `HassSetVolume(Relative)`,
mute, `HassMediaSearchAndPlay`), timers (`HassStartTimer`, `HassCancelTimer`, `HassCancelAllTimers`,
`HassIncrease/DecreaseTimer`, `HassPause/UnpauseTimer`, `HassTimerStatus`), vacuum, lawn mower, fan.

**MCP server** ([mcp_server](https://www.home-assistant.io/integrations/mcp_server/)): every registered LLM API is served
over Streamable HTTP at `/api/mcp/<api id>` (Assist at `/api/mcp/assist`); `/api/mcp` serves the configured set. Auth is
MCP OAuth 2.0 with PKCE (no client secret). Options: expose all AI tools, require admin (default on), read-only.
Supports tools, prompts, and one resource (`homeassistant://assist/context-snapshot`, Device control only); no sampling
or notifications. Cloud agents need HA reachable from the internet.

Implication for our `home-assistant` module: instead of hand-writing one adapter per HA domain, we can connect to
`/api/mcp/assist` (exposed entities only, the user's own exposure settings) and get intents, `GetLiveContext`, todo,
calendar, media and scripts in one go. We would keep hand-written typed actions only for latency-critical paths (lights)
where our typed-intent path beats an LLM round trip.

## 2. n8n

Fair-code workflow tool, 210k GitHub stars, very active. Strong AI agent support; the de facto self-hosted Zapier.

### 2.1 Popularity

[n8n-stats](https://n8n-stats.gui.do/nodes) (third-party; "estimated deployments" weighted by template insertions,
updated 2026-11-16): Sticky Note ~13.0M, HTTP Request ~4.3M, Edit Fields ~3.4M, Code ~2.1M, **Google Sheets ~1.9M**,
**AI Agent ~1.8M**, **OpenAI Chat Model ~1.7M**, If ~1.4M, **Telegram ~952k**, Wait ~908k. App nodes after that: Google
Drive ~614k, Gmail ~563k, WhatsApp Business Cloud ~332k, Telegram Trigger ~240k, Airtable ~162k, Facebook Graph ~145k,
Slack ~125k, Google Docs ~99k, Notion ~88k, Google Calendar ~78k, Postgres ~71k, X ~71k, GitHub ~56k.

A vendor analysis of 4,650 workflows ([community post](https://community.n8n.io/t/i-analyzed-193-000-workflow-events-and-4-650-n8n-workflows-from-synta-here-is-what-people-actually-build-versus-what-they-think-they-want/281705),
unverifiable): top nodes Code, HTTP Request, IF, Set, Webhook; 75% of workflows have no AI node; the most common pair is
Webhook + HTTP Request.

Reading: the generic HTTP and Code nodes beat every app integration. Telegram is the household chat channel of choice
in n8n land. For us this argues for a generic "call a webhook / HTTP tool" module early.

### 2.2 How a node is defined

A community node is an npm package with keyword `n8n-community-node-package` and an `n8n` section listing compiled files
([n8n-nodes-starter](https://github.com/n8n-io/n8n-nodes-starter)):

```json
"n8n": { "n8nNodesApiVersion": 1, "strict": true,
  "credentials": ["dist/credentials/GithubIssuesApi.credentials.js", "dist/credentials/GithubIssuesOAuth2Api.credentials.js"],
  "nodes": ["dist/nodes/GithubIssues/GithubIssues.node.js"] },
"peerDependencies": { "n8n-workflow": "*" }
```

- A node class implements `INodeType` with a `description: INodeTypeDescription` (display name, name, icon, version,
  inputs/outputs, `credentials`, `properties`). **Declarative style** describes HTTP calls with `routing` in properties,
  so no code runs; **programmatic style** implements `execute()`.
- **Credentials are separate types** ([credentials files](https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/)):
  `ICredentialType` with `name`, `displayName`, `properties` (the form fields), `authenticate` (declarative injection,
  e.g. header `Authorization: '=Bearer {{$credentials.authToken}}'`) and `test` (a request n8n sends to validate). OAuth2
  credentials extend `oAuth2Api` **[unverified on this page]**. Stored encrypted with an instance key.
- [Verification rules](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/) for
  verified community nodes: no runtime dependencies, no environment variable access, no file system access.

### 2.3 Triggers and long-running work

Trigger nodes are of three kinds **[from memory of n8n's node API, not re-verified]**: polling (`polling: true`, a
`poll()` method on an interval, with static data to remember the last seen id), webhook (`webhook()` plus
`webhookMethods` `checkExists` / `create` / `delete`, so n8n registers and removes the remote webhook when a workflow is
activated or deactivated), and generic `trigger()` for long-lived connections (MQTT, IMAP) returning a close function.
Schedule Trigger covers cron. The Wait node pauses an execution until a time or a webhook resume call.

### 2.4 Shared state

Per-workflow "static data" persisted with the workflow, plus whatever external store you call (Redis, Postgres, Data
Tables) **[unverified naming]**. No household state model at all; n8n is pipes, not a home.

### 2.5 What an LLM agent gets

- The [AI Agent node](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/):
  since 1.82 every agent is a Tools Agent. Tools are attached as sub-nodes; most app nodes can be used as tools, with
  parameters filled by the model through
  [`$fromAI()`](https://docs.n8n.io/advanced-ai/examples/using-the-fromai-function) expressions (name, description,
  type, default).
- [Human-in-the-loop for tools](https://docs.n8n.io/advanced-ai/human-in-the-loop-tools): connect a tool to a review
  step and the run pauses until a person approves; unconnected tools run directly.
- [MCP Server Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/): turns a
  workflow into an MCP server (SSE and Streamable HTTP, no stdio; auth none/bearer/header/n8n OAuth2). Workflows are
  exposed with the "Call n8n Workflow Tool" node. Caveats: with several webhook replicas all `/mcp*` traffic must go to
  one replica, and proxies must not buffer. Users report that every `$fromAI()` parameter becomes required in the MCP
  schema ([community thread](https://community.n8n.io/t/allow-mcp-tools-to-treat-fromai-parameters-as-optional-schema-currently-fails-when-omitted/217337)).
- An MCP Client Tool node lets the agent call external MCP servers **[unverified exact node name]**.

## 3. Node-RED

Flow-based, Apache-2.0, 23.9k stars, OpenJS Foundation. Widely used inside HA (the add-on is on 54,545 HA installs,
the companion custom integration on 17,762).

### 3.1 Popularity

The flow library's sort-by-downloads page renders client-side and could not be read. npm monthly downloads
(2026-10-18 to 2026-11-16, [npm downloads API](https://api.npmjs.org/downloads/point/last-month/node-red-dashboard)) are
heavily polluted by mirrors and CI (dozens of obscure packages sit at a suspiciously uniform ~55–60k). The credible
leaders: `node-red-dashboard` 195,878 (deprecated) and its successor `@flowfuse/node-red-dashboard` 151,435;
`node-red-node-email` 96,852; `node-red-node-openweathermap` ~61k; `node-red-contrib-modbus` 32,797;
`node-red-contrib-home-assistant-websocket` 17,202; `node-red-node-serialport` 16,354; `node-red-contrib-influxdb`
13,573; `node-red-contrib-cron-plus` 12,964; `node-red-node-ping` 10,805; `node-red-contrib-telegrambot` 10,166. Treat
this as a rough ordering only.

Reading: dashboards (a screen), email, weather, HA, scheduling, Telegram. Same household set again.

### 3.2 How a node is defined

An npm package whose `package.json` has a `node-red` section
([packaging](https://nodered.org/docs/creating-nodes/packaging)): `"node-red": { "version": ">=2.0.0", "nodes": {
"sample": "sample/sample.js" } }`, keyword `node-red`, normal npm `dependencies`, example flows in `examples/`. New
packages should be scoped. Each node is a JS file (runtime) plus an HTML file (editor form, help text, defaults).
Credentials are declared per node type as a `credentials` map and stored in a separate encrypted
`flows_cred.json` **[from memory]**; shared settings use "config nodes" (e.g. one HA server config used by every HA
node).

### 3.3 Triggers

No formal trigger concept: any node may emit messages whenever it wants (inject node with interval or cron, an MQTT in
node holding a connection, an HTTP in node). Long-running work is just a node with open handles that cleans up on its
`close` event.

### 3.4 Shared state

[Context](https://nodered.org/docs/user-guide/context) at three scopes: node, flow (one tab), global; subflows reach the
parent with `$parent.`. Default store is memory (lost on restart); `localfilesystem` persists, caching and flushing every
30 seconds; several named stores can coexist and custom store plugins are allowed. This is a clean model for module
state: private (node), shared within a feature (flow), household-wide (global), each with an explicit persistence choice.

### 3.5 LLM

Nothing built in to match n8n; community nodes for OpenAI/Ollama and MCP exist with small usage, plus FlowFuse's
assistant for writing flows. Not a model for agent tooling.

## 4. Zapier

### 4.1 Popularity

[zapier.com/apps](https://zapier.com/apps) "Popular apps" (no numbers, order as shown 2026-11-17): Google Sheets, Gmail,
Slack, Google Calendar, Google Drive, HubSpot, Facebook Lead Ads, Google Forms, Notion, Mailchimp, Stripe,
LeadConnector, Microsoft Outlook, Calendly, Typeform, Airtable, Trello, Salesforce, Google Docs, Jotform, Gravity
Forms, monday.com. 9,000+ apps per current docs. Household relevance: Google Calendar, Gmail, Outlook, Notion, Trello.

### 4.2 How an app is defined

Platform CLI ([overview](https://docs.zapier.com/platform/build-cli/overview)): `index.js` exports one object with
`authentication`, `beforeRequest`/`afterResponse` middleware, `resources`, `triggers`, `searches`, `creates`. Triggers
return arrays, searches return arrays with the best match first, creates return one object. Auth types: `basic`,
`digest`, `custom` (API key), `session` (exchange for a token), `oauth1`, `oauth2` (PKCE supported). Every operation
declares `inputFields` (can be dynamic), `outputFields` and a `sample`. `bundle.authData` carries credentials,
`bundle.inputData` the user's values.

The search/create split is worth noting: a separate, side-effect-free "find" operation per resource is what lets Zapier
offer "find or create".

### 4.3 Triggers

Polling `perform` returning recent items; Zapier de-duplicates by the field marked `primary: true`. REST hooks
(`performSubscribe` / `performUnsubscribe` / `perform`, plus `performList` for sample data) for push **[method names from
memory; the overview page does not document them]**.

### 4.4 LLM

[Zapier MCP](https://docs.zapier.com/mcp/overview/how-tools-work), Streamable HTTP only. Two modes. **Agentic mode**
exposes 16 static meta-tools instead of thousands of action tools: `discover_zapier_actions`, `enable_zapier_action`,
`inspect_zapier_actions`, `disable_zapier_action`, `auto_provision_mcp`, `execute_zapier_read_action`,
`execute_zapier_write_action`, connection tools, and Markdown "skills" the agent loads on demand. **Managed mode**
exposes each configured action as its own tool and lets the owner lock field values. Reads and writes go through
separate execute tools, which is a cheap way to apply a confirmation policy.

## 5. IFTTT

[Service API](https://ifttt.com/docs/api_reference): a service implements HTTP endpoints for **triggers** (IFTTT polls
about once an hour per applet, returning the 50 latest events; a Realtime API lets the service hint that new data
exists), **actions** (POST with `actionFields`), and **queries** (read-only lookups with cursor paging). Trigger and
action fields can have dynamic options and validation. Auth is OAuth2 with non-expiring tokens. Applets add filter code
(JavaScript) between trigger and action **[not covered by the page read]**.

Popularity: IFTTT says RSS Feed was its most-used service in 2025, with Weather Underground, Webhooks and Google
Calendar also heavily used ([top services of 2025](https://ifttt.com/explore/top-services-of-2025); ranking taken from
the search snippet, the page body did not render the list **[unverified]**). The most-used applet shown there is a
7:00 AM Weather Underground forecast with 801k users. A morning briefing is the single most popular household
automation in that ecosystem.

## 6. Make

[Module types](https://developers.make.com/custom-apps-documentation/app-components/modules): action (one response),
search (lists), polling trigger, instant trigger (webhook), universal (raw API call), responder (reply to a webhook).
Custom apps declare connections (credentials), webhooks and RPCs (calls that fill dynamic dropdowns) in Make's JSON/IML
configuration **[connections and RPCs not re-verified]**. LLM side: Make's hosted MCP server exposes scenarios set to
"on demand" as tools, with parameter descriptions and structured output; "toolboxes" choose a subset
([Make blog](https://www.make.com/en/blog/model-context-protocol-mcp-server)). No public per-app popularity data found.

## 7. Activepieces

MIT community edition, 25.6k stars, TypeScript. About 280+ pieces, ~60% community-contributed, each published to npm
([repo](https://github.com/activepieces/activepieces)). The most agent-oriented integration format of the lot.

- A piece is `createPiece({ displayName, auth, actions, triggers, ... })`; actions and triggers are `createAction` /
  `createTrigger` with typed `props` **[createPiece fields from memory]**.
- [Auth](https://www.activepieces.com/docs/build-pieces/piece-reference/authentication): `PieceAuth.SecretText`,
  `BasicAuth`, `CustomAuth` (several props, e.g. base URL + token), `OAuth2` (authorization code and client
  credentials), each with an optional `validate` returning `{ valid, error }`.
- [Triggers](https://www.activepieces.com/docs/build-pieces/piece-reference/triggers/overview): `TriggerStrategy.POLLING`,
  `WEBHOOK`, `APP_WEBHOOK`; `onEnable` (failure blocks publishing) and `onDisable` (failure is logged and ignored);
  `run` returns an array, each item starting a run; a key-value `store` for state between runs (`_lastFetchedDate`).
- [AI metadata](https://www.activepieces.com/docs/build-pieces/piece-reference/ai-metadata): every action is also an MCP
  tool. `aiMetadata.description` (agent-facing text, separate from the UI label, feeds tool search) and
  `aiMetadata.idempotent`; `audience: 'human' | 'ai' | 'both'` decides where an action is listed. The docs stress that
  `audience` is a discovery filter, not a permission.

## 8. Huginn

Ruby, MIT, 50.6k stars, still committed to (last push 2026-11-09) ([repo](https://github.com/huginn/huginn)). "A hackable
IFTTT on your own server": agents create and consume events in a directed graph; examples are website scraping with
change alerts, RSS/IMAP/MQTT/webhook watchers, weather alerts, digests to email/Telegram. Agents run on a schedule or on
received events, keep per-agent `memory`, use a per-user credentials store, and new agent types ship as gems
(`huginn_agent`) **[scheduling, memory and credentials from memory of the wiki]**. Lesson: the watcher-and-digest
pattern ("tell me when this page changes", "send me a digest") is a durable household use case that does not need an
LLM to run, only to set up.

## 9. Windmill

AGPL/commercial, 18.6k stars. Scripts (TS, Python, Go, Bash...) and flows, each with an auto-generated input schema from
the function signature. [Resource types](https://www.windmill.dev/docs/core_concepts/resources_and_types) are JSON
Schemas (200+ on the Hub; "the resource type is the integration"); a script takes a typed resource parameter, and
resources reference secrets as `$var:<NAME>` so secrets stay out of resource history. Schedules (cron) and triggers
(webhook, HTTP route, Kafka, etc.) attach to any runnable. The [Windmill MCP](https://www.windmill.dev/docs/core_concepts/mcp)
server exposes workspace scripts and flows as individual tools, scoped by folder.

The lesson is "function signature is the schema": the same as our `Schema.Codec` parameters.

## 10. Apple Shortcuts and Tasker

These are not integration platforms for us; they are **the phone side**. Both can run on a personal-automation trigger
and call an HTTP endpoint.

- **Shortcuts**: apps expose actions via the App Intents framework, with `AppShortcutsProvider` registering Siri phrases
  ([Apple docs](https://developer.apple.com/documentation/appintents/app-shortcuts)); on iOS 26 App Intents also feed
  Apple Intelligence, Spotlight and widgets. Personal automations fire on time of day, arriving/leaving a place, NFC
  tag, CarPlay, Focus, Wi-Fi, battery level and app open **[trigger list from memory]**; "Get Contents of URL" can POST
  to our server.
- **Tasker**: profiles (contexts: time, location, app, Wi-Fi, NFC...) start tasks; HTTP Request action; plugin
  ecosystem (AutoApps, a TaskerHA plugin); since 6.5 an AI generator that writes tasks and profiles from a description
  ([Taskerpedia, third-party](https://www.taskerpedia.dedyn.io/features/ai-generator)).

What this means for us: a small authenticated inbound endpoint ("say this on the kitchen device", "I'm leaving work")
lets every phone become a trigger without a native app. HA's `mobile_app` (498,842 installs, second-highest real opt-in)
shows how much value phones-as-sensors carry.

## 11. Self-hosted household apps: integrate or build

GitHub stars and last push from the GitHub API on 2026-11-17.

| App | What it holds | API | Stars / activity | Verdict |
|---|---|---|---|---|
| **Grocy** | Stock with best-before dates, shopping list from minimum stock, recipes with "can I make this", meal plan, chores, tasks, batteries, equipment, barcodes via Open Food Facts ([grocy.info](https://grocy.info/)) | REST, Swagger UI at `/api`; API key header `GROCY-API-KEY` **[header name unverified]** | 9.7k, active | **Integrate**. Pantry tracking is a whole product; rebuilding it is pointless. Only worth it for households that already maintain stock (data entry is the real cost). Several community MCP servers exist ([grocy-mcp](https://pypi.org/project/grocy-mcp/0.2.0/)). |
| **Mealie** | Recipes (URL import), meal plans, shopping lists, households | OpenAPI at `/docs`, long-lived API tokens, uniform paging and a SQL-like `queryFilter`, `extras` key/values for syncing, event subscriptions/webhooks ([API usage](https://mealie.io/documentation/getting-started/api-usage/)) | 13.9k, active | **Integrate** as the default kitchen backend. Also an HA integration (3,565 installs) that exposes its lists as `todo` entities. |
| **Tandoor** | Recipes, meal plan, shopping, cook log | drf-spectacular OpenAPI 3 served at `/openapi/`, API tokens from Settings ([per community MCP servers](https://github.com/Cliftonz/tandoor-recipe-mcp)) **[not from official docs]** | 8.7k, active | **Integrate** as an alternative recipe provider behind the same capability as Mealie. |
| **KitchenOwl** | Shared shopping list, recipes, meal planner, expenses | Docs list an API reference and an MCP server reference ([docs](https://docs.kitchenowl.org/latest/)); details not readable **[unverified]** | 3.9k, active | **Integrate** as a list provider if the household uses it; low priority. |
| **Vikunja** | Projects and tasks, due dates, labels | REST with API tokens (`tk_...`), several community MCP servers ([example](https://github.com/aimbitgmbh/vikunja-mcp)); CalDAV **[unverified]** | 6.1k, active | **Integrate** as a to-do provider. |
| **Todoist** (hosted) | Tasks | REST API, OAuth/tokens **[not re-verified]** | — | **Integrate** behind the to-do capability; HA covers it too (2,811 installs). |
| **Donetick** | Chores with rotation and points | REST **[unverified]** | 2.8k, active | **Integrate** if chores become a module; else Grocy chores. |
| **Music Assistant** | One library over Spotify, Tidal, YouTube Music, Plex, Jellyfin, local files; players on Sonos, Cast, AirPlay, Snapcast, groups ([MA](https://www.music-assistant.io/integration/)) | HA actions `play_media`, `play_announcement`, `search`, `get_library`, `get_queue`, `transfer_queue`; own websocket API **[unverified]**; HA 2025.6 added a built-in search-and-play intent ([voice](https://www.music-assistant.io/integration/voice/)) | 3.3k, active; 64,529 HA installs | **Integrate, never build.** Multi-provider playback and grouping is years of work. Use it through HA first, directly later. |
| **Jellyfin / Plex** | Video and music libraries, resume points | Jellyfin: REST with OpenAPI, API keys; Plex: `X-Plex-Token` **[both from memory]** | Jellyfin 59.5k | **Integrate** for "what's new", "resume", "play on TV"; music via Music Assistant instead. |
| **Immich** | Photos, faces, CLIP smart search, memories | OpenAPI, API keys with scoped permissions, a smart-search endpoint **[from memory; docs page did not render]** | 119k, very active | **Integrate**, for devices with a screen only ("show photos of the kids at the beach"). |
| **Paperless-ngx** | Scanned documents, OCR text, tags, correspondents, custom fields | REST `/api/` with token auth; v3 dropped API versions below 9 (HTTP 406), per [paperless-mcp](https://mcpservers.org/servers/baruchiro/paperless-mcp) | 48.2k, active | **Integrate read-only** ("when does the car insurance renew?"). Sensitive: owner-only, never on shared devices by default. |
| **Nextcloud** | Files, calendar, contacts, notes, Deck, Talk, Cookbook | Standards (CalDAV, CardDAV, WebDAV) plus OCS APIs; its [Context Agent](https://docs.nextcloud.com/server/33/admin_manual/ai/app_context_agent.html) app exposes an MCP server; a community [server](https://pypi.org/project/nextcloud-mcp-server) claims 110+ tools | 37.5k | **Integrate through the standards** (CalDAV for calendars and VTODO tasks, CardDAV for contacts). That also covers iCloud, Fastmail, Radicale. |
| **ntfy** | Push to phones | Plain HTTP PUT/POST to a topic; headers `Title`, `Priority` 1–5, `Tags`, `Click`, `Attach`, `Delay` (scheduled delivery), up to three action buttons (`view`, `http`, `broadcast`, `copy`), JSON publish, access tokens ([publish](https://docs.ntfy.sh/publish/)) | 35.6k | **Integrate** as the default "reach my phone" channel; no SDK needed. Action buttons with `http` can call back into us (acknowledge a reminder). |
| **Gotify** | Push to Android | REST with app tokens **[from memory]** | 16.2k | **Integrate** only through Apprise. |
| **Apprise** | One URL scheme per service for 100+ notification targets (Telegram `tgram://`, Discord, Slack, email, SMS...), tags, attachments ([repo](https://github.com/caronc/apprise)) | Python library/CLI, plus the separate Apprise API HTTP server | 17.8k | **Integrate via the Apprise API container** (we are Node, and provider SDKs stay in adapters anyway). Gives breadth for free. |

Build, not integrate:

- **Timers, alarms, reminders.** They must start, cancel and ring with no network, on the device that set them, within
  our latency budget. HA itself did not reuse its timer helper for voice timers; it built device-bound voice timers.
- **A simple local list store.** `shopping_list` and `local_todo` together are on a large share of HA installs; most
  households need one or two plain lists, not a task manager. External list apps become alternative providers.
- **Broadcast/intercom between our own devices** (HA has `assist_satellite__broadcast`; we own the devices).
- **Kitchen helpers**: reading recipe steps one at a time with "next"/"repeat", unit and temperature conversion,
  scaling. These are presentation logic on top of whichever recipe app holds the data.

## 12. Patterns worth copying

1. **Declarative module manifest.** Copy HA's keys, adapted: stable `id` (never renamed), `name`, `version`,
   `requires` (other modules), adapter package and its pinned SDK (our "SDK only inside its adapter" rule is the
   `requirements` equivalent), `connectivity` (local/cloud × poll/push, from `iot_class`), `kind` (device / hub /
   service / helper), `singleInstance`, `quality` tier, `discovery` matchers (mDNS service type, e.g.
   `_home-assistant._tcp`) so the settings UI can suggest a module when it finds the service. Showing "cloud" vs "local"
   before install fits the local-first rule.
2. **Credentials as their own typed objects, shared across modules, with a test.** n8n credential types and
   Activepieces `PieceAuth`: a form schema, an injection rule (header/query/basic), and a `test`/`validate` call run at
   save time with a readable error. One Google OAuth credential serves Calendar, Tasks and Gmail modules. Secrets live
   in our vault and are referenced by id (Windmill's `$var:` reference), never copied into module settings.
3. **Capability interfaces with many providers.** HA's typed entity domains are the main lesson. Define `Lists`
   (get/add/complete/remove items, list of lists), `Calendar` (events in range, create), `Timers`, `Notifier`
   (targets, send with priority and actions), `MediaPlayer` (search, play, pause, volume, transfer). Modules provide
   them; the tools and typed actions are written once against the capability, so "add milk to the shopping list" works
   the same on the local store, Mealie, Grocy or HA.
4. **Tool annotations that drive policy.** HA copies MCP's `read_only`, `destructive`, `idempotent`, `open_world` with
   worst-case defaults. We have `speculative` (≈ read-only) and `confirm`; adding `destructive` and `idempotent` lets core
   decide confirmation and retry without each module re-deciding. Zapier's split into separate read and write execute
   tools is the same idea.
5. **Namespaced tool names from day one**: `<module>__<tool>` (HA had to deprecate unprefixed names later).
6. **Agent-facing description separate from the UI label** (Activepieces `aiMetadata.description`, HA's "write the
   description for the model"), and a per-action `audience` (owner UI only / agent only / both).
7. **Four trigger strategies with lifecycle hooks.** `schedule` (cron), `poll` (interval + de-duplicate by a declared
   primary key, Zapier `primary: true`), `webhook` (`onEnable` registers, `onDisable` unregisters; failing enable blocks
   activation, failing disable is logged, as Activepieces does), `stream` (a scoped long-lived connection, n8n
   `trigger()` / Node-RED close handler). Each trigger gets a small persistent key-value store for its cursor.
8. **Scoped state with explicit persistence** (Node-RED node/flow/global context with memory vs file stores): module
   private state, household-shared state (lists, timers, presence), each declaring whether it survives a restart.
9. **User-authored routines become tools.** HA exposes each script as `script__<name>` with its `fields` as parameters;
   n8n, Make and Windmill do the same with workflows. A routine defined in our settings UI ("bedtime": lights off, set
   alarm, read tomorrow's first event) should appear as one typed action/tool.
10. **Exposure control per assistant and device.** HA's "exposed to Assist" list plus admin-only APIs and a read-only
    switch. Our per-device and per-assistant profiles should decide which modules and which entities a voice can reach.
11. **A live context snapshot instead of dumping state.** HA's `GetLiveContext` tool and MCP resource; we already have
    `ContextProvider`, which should stay short and cached.
12. **Intents first, LLM second.** HA's built-in intents (timers, lists, media, weather, state) answer locally and the
    LLM handles the rest; our typed-intent path is the same design. HA's intent list in §1.5 is a good checklist for our
    first typed actions.
13. **Device-bound timers and announcements**: a timer belongs to the device that started it and rings there (HA voice
    timers). Matches our per-device voice sessions.
14. **Human approval as a wiring choice** (n8n connects only the risky tools to a review step). Our `confirm` is the
    same; a phone approval via an ntfy `http` action button is a natural extension for headless devices.

## 13. Mistakes to avoid

1. **Hourly polling.** IFTTT's ~1 hour trigger cadence makes "tell me when the washer finishes" useless. Prefer push
   (webhook, websocket, MQTT); when polling, make the interval per trigger and visible.
2. **Ambiguous targets.** HA's `notify.notify` sends to "the first notify action found". Every notify, play or broadcast
   tool should require or resolve an explicit target, defaulting to the device the request came from.
3. **One "call any action" tool on a voice path.** HA's `homeassistant__call_action` and `render_template` are admin-only
   for a reason. Keep voice tools narrow and typed; offer the generic escape hatch only to owner sessions.
4. **Schema drift between the tool and the API.** n8n users hit "all `$fromAI` parameters become required" over MCP and
   types reverting on edit. Generate the tool schema from one source (our `Schema.Codec`) and test optional fields.
5. **Unpinned upstream APIs.** Paperless-ngx v3 dropped API versions below 9 and old clients got HTTP 406. Adapters
   should send an explicit API version and the settings test should report version mismatches.
6. **Arbitrary in-process plugins.** Node-RED and HA custom integrations run any npm/pip code in the main process with
   full access. n8n's verified-node rules (no runtime dependencies, no env, no file system) show the opposite stance.
   Our modules are in-repo packages for now; if third-party modules come, they need the n8n-style constraints or a
   separate process.
7. **Splitting the ecosystem on a rewrite.** Node-RED's dashboard v1 is deprecated but still the most downloaded node,
   ahead of its successor. Version module manifests and settings from the start and ship migrations, so a module rewrite
   does not strand users.
8. **Tool catalogues that cost round trips.** Zapier's agentic-mode meta-tools (discover → enable → execute) are fine for
   a chat agent and bad for a sub-second voice reply. Keep each assistant's tool set small and fixed per turn.
9. **Requiring internet exposure for local control.** HA's MCP server needs a public URL for cloud agents. Our hosted LLM
   calls out; our modules should call local services from the server, never ask the owner to expose them.
10. **Putting timers in the device firmware.** Voice PE timers cannot be started by automations (forum report). Keep
    timer state on the server, rendered and rung by the device.
11. **Trusting popularity data naively.** HA's top entries are onboarding defaults; npm counts for Node-RED nodes are
    polluted by mirrors; n8n's top node is a sticky note. Rank by opt-in signals.
12. **YAML-first configuration.** HA spent years migrating integrations from YAML to config flows. We already have a
    settings UI; every module setting should be UI-editable from its first version.

## 14. Candidate modules for us

Effort: S = a few days, M = one to two weeks, L = more. "Via HA" means the first provider can be our `home-assistant`
module (or HA's MCP endpoint), with direct adapters later.

| Module | Tools / actions it would hold | Idea comes from | Household value | Effort | Integrate or build |
|---|---|---|---|---|---|
| `timers` | start/cancel/pause/resume/add time/status, named timers, per device, ring + spoken label | HA timer intents, voice timers | Very high (kitchen) | M | Build |
| `alarms` | set/list/cancel alarm, repeat on weekdays, snooze, wake with radio | HA `schedule`, Shortcuts | High | M | Build (on `timers`) |
| `reminders` | remind at time / in duration, list, cancel; deliver on device or phone; later "when I get home" | HA community reminder blueprints, Shortcuts location triggers | Very high | M | Build, deliver via `notify` |
| `lists` | add/remove/complete/read items, several named lists, "what's on the shopping list" | HA `shopping_list`, `local_todo`, `todo` entity | Very high | S local, M per provider | Build local store; integrate Mealie, Grocy, Bring, Todoist, Vikunja, CalDAV VTODO, HA `todo` as providers |
| `calendar` | today/next events, events in range, add event, who is busy | HA `calendar__get_events`, Google Calendar top on Zapier/n8n/IFTTT | Very high | M | Integrate: CalDAV, Google, ICS URL, HA calendar |
| `briefing` | morning summary: weather, first events, bin day, reminders, commute | IFTTT's top applet (7 AM forecast, 801k users), Huginn digests | High | S (composes others) | Build |
| `notify` | send to a person's phone with priority and buttons, acknowledge | HA `notify`/`mobile_app`, ntfy, Apprise, Telegram (n8n #9) | High | S | Integrate ntfy + Apprise API |
| `broadcast` | announce to one, several or all of our devices; intercom | HA `assist_satellite__broadcast`, `HassBroadcast` | High (families) | S–M | Build |
| `smart-home` (extend `home-assistant`) | switches, climate, covers, fans, scenes, locks (confirm), vacuum, live context; connect to `/api/mcp/assist` | HA LLM API and MCP server | High where HA exists | M | Integrate HA |
| `routines` | owner-defined sequences exposed as one action each, with parameters | HA scripts-as-tools, n8n/Make/Windmill workflows-as-tools | High | M | Build |
| `music` | search and play (artist/album/playlist/radio), pause, skip, volume, play on room/group, what's playing | Music Assistant (64,529 HA installs), `HassMediaSearchAndPlay`, Spotify | High | M | Integrate Music Assistant (via HA first) |
| `radio` | play station by name/genre, favourites | `radio_browser` (onboarding default, 481,980 installs), Node-RED/HA usage | Medium | S | Integrate radio-browser.info directory |
| `kitchen` | find recipe, what's for dinner (meal plan), read steps one by one, scale, convert units, add ingredients to `lists` | Mealie, Tandoor, Grocy recipes | High | M | Integrate Mealie/Tandoor for data; build step reader and conversions |
| `pantry` | what's in stock, what expires soon, consume, can I make X | Grocy | Medium (only if stock is kept) | M | Integrate Grocy |
| `chores` | whose turn, mark done, overdue chores | Grocy chores, Donetick | Medium | S–M | Integrate, or build a tiny rota |
| `bin-day` | next collection per waste type, context line for the evening before | `waste_collection_schedule` (27,453 custom installs) | Medium-high | S | Integrate an ICS feed or via HA |
| `weather` (extend) | forecast by day/hour, rain alert, severe weather warnings | `met` default, Weather Underground on IFTTT, NINA in HA | High | S | Already built; add providers |
| `commute` | travel time to work/school, next departures, delays | `waze_travel_time` (11,016), HA travel-time integrations | Medium | M | Integrate a public transport / routing API **[provider choice open]** |
| `presence` | who is home, where is X (zone level), last arrival | HA `person`/`zone`, `mobile_app` | Medium | S via HA | Integrate HA |
| `phone-triggers` | inbound authenticated webhook: speak/announce/run routine on a device; phone events from Shortcuts/Tasker | Shortcuts "Get Contents of URL", Tasker HTTP Request, n8n Webhook (top-5 node) | High (glue) | S | Build |
| `automation-bridge` | call n8n/Node-RED/Windmill/Make workflows and any MCP server as tools; HTTP tool with templated request | n8n MCP Server Trigger, HA MCP client (41,662), HTTP Request node (#2 n8n) | High for tinkerers | M | Build MCP client + webhook tool |
| `tv-media` | what's new, resume show, play on TV, pause | Jellyfin, Plex, Kodi, `cast` (295,925) | Medium | M | Integrate Jellyfin/Plex, cast via HA |
| `photos` | show photos of person/place/date on a screen device, slideshow, "on this day" | Immich (119k stars) | Medium, screen only | M | Integrate Immich |
| `documents` | find a document, read a field (renewal date, amount) | Paperless-ngx | Medium | M | Integrate read-only, owner only |
| `google` bundle | Calendar, Tasks, Gmail (unread summary), Contacts, Drive search on one OAuth credential | Top apps on Zapier and n8n | Medium-high | L | Integrate |
| `messages` | send a message to a family member or group (Telegram, Signal, WhatsApp) | Telegram (n8n #9, HA 27,912), WhatsApp (n8n) | Medium | M | Integrate Telegram first |
| `feeds` | news headlines, RSS digest, "has this page changed" watcher | IFTTT RSS (top 2025, snippet), Huginn website agents | Medium | S–M | Build small RSS reader; integrate Huginn optionally |
| `energy` | current use, solar production today, cheapest hours | HA `energy` (141,241), `forecast_solar` (69,251), Tibber/Nordpool | Medium | S via HA | Integrate HA |
| `notes-memory` | remember household facts ("spare key is in the blue box"), recall, forget | Nextcloud Notes, general assistant use | Medium-high | S | Build local |

Suggested first wave, by value over effort: `timers` + `alarms`, `lists` (local store), `reminders` + `notify` (ntfy),
`calendar` (CalDAV + Google), `briefing`, `music` (Music Assistant via HA), and the `smart-home` extension through HA's
MCP endpoint. Second wave: `routines`, `phone-triggers`, `automation-bridge`, `kitchen`, `broadcast`, `bin-day`.
