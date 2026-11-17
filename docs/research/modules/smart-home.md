# Smart home

Research write-up, 2026-11-17. Not an approved design. It extends the existing `packages/module-home-assistant` and
builds on the shared foundations named in [README.md](README.md): the Module manifest, Connection and Requirements and
health ([`module-definition-config-and-dependencies.md`](../module-investigation/module-definition-config-and-dependencies.md),
"module definition §n"), the Module store, Scheduler, Event bus, Notification service and Tool context
([`shared-state-jobs-and-notifications.md`](../module-investigation/shared-state-jobs-and-notifications.md), "shared state
§n"), and Presentation and Device capabilities
([`presentation-and-device-capabilities.md`](../module-investigation/presentation-and-device-capabilities.md),
"presentation §n"). What exists today is in [`current-system.md`](../module-investigation/current-system.md).

## 1. Summary

The module lets every assistant see and control the house through Home Assistant (HA): lights, switches, scenes,
climate, covers, locks and alarms, presence, cameras, the doorbell and energy. "Turn off the lights" means the lights
of the room the speaking device is in. Things that happen in the house (the doorbell, a leak, the washing machine
finishing) become notifications on the right devices.

- **Priority: first wave.** Smart-home control is a top-five voice use in every survey
  (landscape-voice-assistants.md §13), and the module already exists and works for lights.
- **Effort: M for control, L for everything.** More domains, a WebSocket state cache and HA's exposure list are M.
  "This room", incoming events, cameras and exposing our devices to HA each wait on a foundation that does not exist
  yet (§14).

**Recommendation: a hybrid.** Keep hand-written, typed actions for the common commands, which must run on the fast path
without the language model. Read the list of entities and HA's own "exposed to Assist" setting over one WebSocket.
Reach the long tail (vacuums, scripts, odd domains) through HA's MCP server at `/api/mcp/assist`, using the MCP bridge
(module definition §A.5), once that bridge exists. Do not build Matter or Zigbee control ourselves (§5).

## 2. What others do

| System | What it does | Copy | Avoid |
|---|---|---|---|
| **Our module today** (`packages/module-home-assistant/src/module.ts`) | REST only (`client.ts:9`). It makes three calls: `GET /api/config` at start, then one admin-only `POST /api/template` that returns every area and light (`home.ts:17`), refreshed every 60 s in a scoped fiber (`module.ts:199`), then `POST /api/services/light/turn_on\|turn_off`. It has one tool, `home_state` (`:278`), and four actions turned into tools: `home-assistant_lights_on`, `_lights_off`, `_set_brightness` and `_lights_status` (`:236`–`:276`). The target is a `Param.dynamic` over areas, lights and "all" (`home.ts:143`). Owner aliases are text lines (`home.ts:81`). The `domains` setting has only `light` (`module.ts:55`). The token must belong to an admin (`:53`). | Secret redaction everywhere (`redact.ts`), spoken error sentences (`client.ts:29`), a cache refreshed off the turn path. | Polling every minute. No push. No idea which room the speaker is in. Every exposed and unexposed light is reachable. |
| **HA Assist** ([built-in sentences](https://www.home-assistant.io/voice_control/builtin_sentences/)) | Built-in intents: `HassTurnOn/Off`, `HassLightSet`, `HassClimateSetTemperature`, `HassSetPosition`, `HassGetState` and more. A satellite has an area, so "the lights" means its area. Since 2025.10 a beep replaces the spoken confirmation when the action stayed in the satellite's own area ([chapter 11](https://www.home-assistant.io/blog/2025/10/22/voice-chapter-11)). | Area of the device as the default target. The beep. The intent list as a checklist of our typed actions. | Rigid sentence matching outside English (landscape-voice-assistants.md §4(f)). |
| **HA exposure** ([exposing entities](https://www.home-assistant.io/voice_control/voice_remote_expose_devices/)) | Each entity is exposed to voice assistants or not. The docs give keeping locks and garage doors from accidental control as the reason. | Use HA's exposure list as our allowlist too, so the owner decides it in one place. | — |
| **HA LLM API** ([docs](https://contributors.home-assistant.io/core/internals/llm-api/), [`helpers/llm.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/helpers/llm.py)) | Two APIs: **Assist** (exposed entities only, no admin actions) and **Home Assistant** (everything, admin only). Intents become tools named `<domain>__<Intent>`. Every exposed script becomes a tool `script__<name>` whose parameters are the script's `fields`. Tool annotations default to the worst case (`destructive=True`, `open_world=True`). The tool context carries the asking `device_id`, and intent tools fill `preferred_area_id` and `preferred_floor_id` from that device's area. Those two slots are removed from the schema the model sees (read in `llm.py`). | Annotations with worst-case defaults. Scripts as tools. | The `device_id` comes from HA's own device registry. An outside client cannot supply it, so "this room" is lost over MCP (§5). |
| **HA MCP server** ([mcp_server](https://www.home-assistant.io/integrations/mcp_server/)) | It serves every LLM API over HTTP. `/api/mcp/assist` gives Device control only, and `/api/mcp` gives the configured set, with switches for "expose all AI tools", "require admin" (default on) and "read-only". It supports tools and prompts, plus one resource, `homeassistant://assist/context-snapshot`, which is the output of `GetLiveContext`. It has no notifications. Auth is OAuth 2.0 with PKCE. | A complete, maintained tool set for the long tail. | No push. One more HTTP hop per call. Some 15–25 tool definitions in the cached prefix (count unverified). |
| **Alexa / Google** | Device capability interfaces (PowerController, ThermostatController) mapped onto language. Locks and garage doors ask for a PIN by voice ([HA community on the Google secure-devices PIN](https://community.home-assistant.io/t/google-assistant-ha-covers-voice-and-security/151761)). | A spoken PIN as one way to confirm a security action, if confirmations come back. | Wrong-room actions after the LLM migrations (landscape-voice-assistants.md §16.6). |

## 3. Example conversations

1. Kitchen speaker, no screen. "Hey Jeff, lights off." → (a short cue, no words) → the kitchen lights go off. The
   device's room is Kitchen, which maps to the HA area `kitchen`, and the action ran in that area (HA's beep rule).
2. Living-room iPad. "Make it twenty-one degrees in here." → "Living room heating set to 21. It's 18.5 now." A
   `facts` card shows current, target and mode (needs a screen for the card only).
3. **Ambiguous.** A hallway node with no room set. "Open the blinds." → "Which blinds: the living room or the bedroom?"
   → "Living room." → "Living room blinds opening." It asks, never guesses (landscape-voice-assistants.md §16.6).
4. **Refused by policy.** Kitchen speaker. "Unlock the front door." → "I don't unlock doors by voice from this speaker.
   The front door is locked; you can open it from the Home Assistant app." The `security` class is `deny` here (§13).
5. **Failure.** HA is restarting. "Turn on the office light." → "Home Assistant is restarting, so I couldn't switch
   the office light. Try again in a minute." The sentence comes from `client.ts:183`.
6. Study laptop. "Is anyone home?" → "Anna is home. Ian left at ten past eight." This comes from `person.*` states and
   is personal (§13).
7. **Proactive, needs a screen for the image.** The doorbell is pressed. The kitchen iPad chimes, shows the porch
   camera snapshot and says "Someone's at the front door." "Who is it?" → "A courier with a parcel, wearing a yellow
   jacket." That description costs a vision-model call (§11).
8. Kitchen speaker. "Tell me when the washing machine is done." → "I'll tell you when it's finished." Forty minutes
   later, on the same speaker: "The washing machine is done."
9. Living-room iPad. "How much solar did we make today?" → "14.2 kilowatt-hours, about a third more than yesterday." A
   `chart` shows the day (needs a screen for the chart only).
10. "Movie time." → "Movie scene on." This activates `scene.movie_time` through an owner alias.

## 4. Tools

Action tools keep today's naming, `home-assistant_<actionId>` (`Actions.ts:355`). The risk column gives the README
class and, in brackets, the class from module definition §B.5: safe = `read`; changes data = `change`;
outward-facing or costly = `message`, `money` or `security`. Latencies are estimates for HA on the LAN: about 50–150 ms
per service call (docs/AGENTS-AND-INTENTS.md:1489, an *estimate*) and under 5 ms for a cached read. Both are to be
measured with `TurnTrace`.

| Tool / action | Parameters | Returns | R/W | Risk | Latency | Fast path |
|---|---|---|---|---|---|---|
| `home_state` (exists, extended) | `area?`, `domain?` (`light`, `switch`, `climate`, `cover`, `lock`, `sensor`, …) | Compact states of exposed entities, grouped by area | read | safe (`read`) | <5 ms cached | – (model tool) |
| `lights_on` / `lights_off` / `set_brightness` / `lights_status` (exist) | `target` (dynamic: `here`, an area, a light, `all`), `level` | `say` | write / read | changes data (`change`) | ~100 ms | yes |
| `switch_on` / `switch_off` | `target` (switch, fan, `input_boolean`, or an area) | `say` | write | changes data | ~100 ms | yes |
| `scene_activate` | `scene` (dynamic over exposed `scene.*`) | `say` | write | changes data | ~150 ms | yes |
| `script_run` | `script` (dynamic over exposed `script.*`), `fields?` | `say` or the script's response | write | changes data, unless the owner marks the script `security` | varies | yes, without fields |
| `climate_set` | `target` (`here`, an area or a climate entity), `temperature?`, `mode?` (`heat`, `cool`, `off`, `auto`), `preset?` | `say` with the current temperature | write | changes data | ~150 ms | yes |
| `cover_set` | `target`, `action` (`open`, `close`, `stop`) or `position` 0–100 | `say` | write | changes data; **security** for `device_class` garage, door or gate | ~150 ms | yes |
| `lock_status` | `target?` | `say`: which locks are locked or open | read | safe | <5 ms | yes |
| `lock_lock` | `target` | `say` | write | changes data (makes things safer) | ~300 ms | yes |
| `lock_unlock` | `target`, `code?` (never spoken back, never logged) | `say` | write | outward-facing (`security`) | ~300 ms | yes, but only if policy allows |
| `alarm_arm` / `alarm_disarm` | `mode` (`away`, `home`, `night`), `code?` | `say` | write | arm: changes data; disarm: `security` | ~300 ms | yes |
| `who_is_home` | – | People home, and others with their zone and since when | read | safe, but personal (§13) | <5 ms | yes |
| `camera_snapshot` | `camera` (dynamic), `describe?` (boolean) | `image` presentation; with `describe`, one sentence from a vision model | read | safe, but personal | 0.3–0.8 s; plus 2–5 s to describe (unverified) | no |
| `energy_now` / `energy_today` | `kind?` (`use`, `solar`, `grid`, `gas`) | `facts` or `chart`, plus one sentence | read | safe | 50–300 ms | yes, for `energy_now` |
| `home_history` | `entity`, `since` | A summary of state changes ("the back door opened 3 times today") | read | safe | 100–500 ms | no |
| `home_watch` | `entity` or a phrase ("the washing machine"), `until` (`off`, `below 5 W for 3 min`, `state X`), `message?` | "I'll tell you" with a watch id | write | changes data (module data) | <50 ms | no |
| `home_watch_list` / `home_watch_cancel` | `id?` | Active watches / `say` | read / write | safe / changes data | <5 ms | yes |

Matching rules for every `target`, after HA's timer matching (shared state §7): an explicit name first, then
`here` (the area of the asking device), then the whole house only for `all`. Two or more matches lead to a question.
`here` is the default when the utterance names no room.

## 5. Integrate or build

| Option | For | Against |
|---|---|---|
| **A. Hand-written typed actions over REST and WebSocket** (extend today's module) | Runs without a model (Jev). Our matching, room logic and risk classes. One socket for state and events. | One adapter per domain. HA changes need code changes. |
| **B. HA's MCP server `/api/mcp/assist` through the MCP bridge** (module definition §A.5) | Every intent and every exposed script with no code. HA does the entity matching. The owner's exposure is respected. | No `device_id`, so no "this room" unless the model passes the area as text. MCP tools are non-speculative and `change` by default in our bridge, so reads wait for promotion. No events. An extra hop. More tools in the cached prefix. OAuth 2.0 with PKCE. Whether a long-lived token also works as the bearer is unverified. |
| **C. `POST /api/conversation/process`**: hand the text to HA's own agent | HA's local intent matcher, all languages HA has | Two pipelines answering in two styles. Whether a `device_id` can be passed for the area is unverified. Latency of HA's agent. |
| **D. Our own Matter, Zigbee or MQTT control, no HA** | Works for people without HA | See below. Large, and duplicates HA. |

**Recommendation: A for the fast path and the ten domains in §4, plus B as an opt-in long tail.** B stays off by
default and is offered to the model only when the owner switches it on for an assistant. The two must not both offer
"turn on": with B on, the module's own instructions tell the model to use the typed actions for lights, switches,
climate, covers, scenes and locks, and the bridge's `offTools` hides `HassTurnOn`, `HassTurnOff`, `HassLightSet` and
the lock intents. This agrees with the implication in landscape-automation-platforms.md §1.5, but goes further on the
typed side (Open question 2).

**Moving from polling to the WebSocket API** ([docs](https://contributors.home-assistant.io/core/internals/websocket-api/)).
One socket per instance: `auth` with the token, then:

- `subscribe_entities` for the state cache. It sends compressed diffs (`a` added, `c` changed, `r` removed) and only
  states the user may read.
- `config/entity_registry/list_for_display` and the area and floor registries for names and aliases. Area aliases are
  not readable from templates today (`home.ts:13`). That the WebSocket area list carries `aliases` is from memory,
  unverified.
- `homeassistant/expose_entity/list` for what the owner exposed to Assist.
- `call_service` (`domain`, `service`, `target`, `service_data`) replaces the REST call on the same socket.
- `subscribe_trigger` (admin) lets HA evaluate the owner's event rules and the `home_watch` conditions, including
  "for 3 minutes" (§7).

REST stays for `GET /api/camera_proxy/<entity_id>` (the JPEG), `GET /api/history/period/<ts>` and the start check.

**Without Home Assistant: not worth it now.**

- **Matter.** The Python Matter server is archived; v8.1.2 was the last release, and it was
  [rewritten as matter.js](https://github.com/home-assistant-libs/python-matter-server). The
  [OHF Matter.js server](https://github.com/matter-js/matterjs-server) is an npm package (`npx matter-server`) with a
  WebSocket API on `localhost:5580/ws` and a `@matter-server/ws-client` package. Using it means doing commissioning,
  fabrics and a Thread border router ourselves. That is L to XL, and it rebuilds what HA's Matter integration does.
- **Zigbee2MQTT.** It is the cheapest direct route: `zigbee2mqtt/bridge/devices` and `bridge/groups` are retained JSON
  lists, and `zigbee2mqtt/<friendly_name>/set` takes `{"state":"ON","brightness":255}`
  ([topics](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html)). It needs an MQTT client inside an
  adapter package and an MQTT broker. Rooms would come from our own room list. It is S–M for lights and switches only.
- **Plain MQTT** devices (Tasmota, ESPHome in MQTT mode) have no common schema except HA's discovery format.

**Verdict:** design the actions against a small `HomeControl` interface (lights, switches, scenes, climate, covers,
locks, read state), which is the "capability interface plus provider adapters" pattern
(landscape-automation-platforms.md §12.3). Ship only the HA provider. Add a Zigbee2MQTT provider only if a household
without HA asks for it. Skip Matter.

## 6. Data

| What | Scope | Store | Shape | Readable by others |
|---|---|---|---|---|
| State and registry cache | – | memory, per instance | entities `{ id, name, aliases, area, domain, device_class, state, attrs, exposed }`; areas `{ id, name, aliases, floor }` | through `home_state` and the exports below |
| Device room → HA area | device | settings (device `place.room` from presentation §5.3) plus a module mapping field | `{ room: "Kitchen" } → area_id "kitchen"`, matched by name or alias, overridable | the Notification service, for room targeting |
| Watches (`home_watch`) | household or person | Module store collection `watches` | `{ entity, trigger (HA trigger JSON), message, audience, oneShot, createdBy, originDevice, expiresAt }` | – |
| Event rules (owner-defined) | household | module settings, a `records` field (BUILT, NOT WIRED today) | `{ name, trigger, priority, audience, spoken, camera? }` | – |
| Presence log | household | none: HA keeps history | – | – |

Exports (read-only views, shared state §4.4): `presence` (who is home), `areas` (HA areas with aliases, for room
matching in other modules), and a `doorbell` event (§7). The ambient facts line (shared state §7) may carry at most
"front door unlocked" and "2 people home". Both are off by default, because they add tokens to every turn.

## 7. Long-running work and events

- **The socket is a scoped fiber** in the module's scope, like today's refresh (`module.ts:199`). It reconnects with
  backoff, and the status line shows "connected" or "reconnecting since 14:02". After a reconnect it reloads the cache
  in full and re-subscribes every trigger. A drop never reaches a turn: actions fall back to REST.
- **Event rules → Notification service.** Each owner rule and each watch is registered with `subscribe_trigger`. On a
  match the module calls `notify.send` with a `dedupeKey` per rule (shared state §8.1). Defaults by kind: doorbell
  `high`, ring `origin-then-everywhere`, audience devices with a screen first; leak, smoke or CO `critical`,
  `everywhere`; appliance done `normal` to the device of the watch's origin; "door left open for 10 minutes" `normal`,
  the room or everywhere.
- **Events it emits** on the Event bus: `home-assistant.doorbell`, `home-assistant.presence.changed` (person arrived
  or left), `home-assistant.watch.fired`. A briefing or reminders module can listen ("remind me when I get home").
- **Events it listens to:** `notification.resolved`, so a doorbell notification acknowledged on one device stops
  everywhere.
- **Restart.** Watches live in the Module store and are re-subscribed at start. A condition met while the server was
  down is missed. It is not replayed, and the watch says so at the next turn on its origin device ("I lost track of the
  washing machine while I was restarting"). A one-shot watch expires after 24 h.
- **Delayed commands** ("turn off the heating in an hour") become Scheduler `deferred command` jobs (shared state
  §6.1), listed and cancellable, unlike HA's uncancellable delayed commands (landscape-voice-assistants.md §4).

## 8. Presentation

| Situation | Kind (presentation §3.2) | Layout | Without a screen |
|---|---|---|---|
| "What's on in here?" | `list` of entities with state | Presenter | The top three, then "and 4 more" |
| Climate change or question | `facts` (now, target, mode, humidity) | Presenter | One sentence |
| Doorbell or camera | `image` (via the server's `/media/` proxy, never a camera URL on the device), with `sensitivity: "personal"` | Hold-up, then Presenter | The description, if asked for; otherwise "someone's at the front door" |
| Energy today | `chart` (line, kWh per hour) with a `facts` fallback | Presenter | The trend in one sentence |
| A watch running | `progress` (indeterminate) pinned, labelled "Washing machine" | Orbit | – |
| A confirmation (when confirmations exist) | `confirm` | Hold-up | The spoken question |

The character presents. Confirmations of plain control commands get no visual and, in the device's own room, no words
either: one cue, as HA's chapter 11 does.

## 9. Notifications and proactive behaviour

It may speak unprompted only for (a) rules the owner wrote, (b) watches someone asked for, and (c) safety events from
`binary_sensor` entities with `device_class` `smoke`, `carbon_monoxide`, `moisture` or `gas`, which are on by default
as `critical`. There are no hints such as "the light in the attic is on". Hints are the "by the way" mistake
(landscape-voice-assistants.md §16.4). The only exception is a `low` inbox item, and only if the owner turns it on.
Quiet hours apply (shared state §8.2) except for `critical`. The doorbell is `high`, so during quiet hours it shows on
screens without sound unless the owner changes it.

## 10. Configuration

| Layer | Setting | Notes |
|---|---|---|
| Household | rooms list (module definition §B.1), quiet hours, the risk ceiling (`security: deny`) | When HA is connected, HA areas are offered as the room list (Open question 1) |
| Module (shared) | `baseUrl`, `token` (secret, exists), `domains` (multichoice, exists, extended to the §4 domains), `aliases` (exists), `timeoutMs` (exists), `useExposure` (default on: only entities exposed to Assist), `eventRules` (records), `mcpLongTail` (off), `energySensors` (power, solar, grid entities), `doorbell` (event entity plus camera) | |
| Assistant | `domains` (overridable, exists), `offTools`, its own risk narrowing | A children's assistant without `lock_*` and `alarm_*` |
| Device | room (`place.room`), `allowRisky` (module definition §B.5; off by default), privacy (`private`, `shared`, `public`) | The front-door node is `public` and is never allowed to unlock |
| Person | the HA `person` entity that is them | Lets "am I home?" and "my car" resolve |

**Connection.** HA should become a Connection (module definition §B.4), because music, notify and presence modules will
share it. The token stays in the vault.

**First run.** (1) Create an HA user for the assistant. Admin is still needed for `subscribe_trigger` and templates.
(2) Create a long-lived token, then paste the address and the token. (3) The module lists areas; map each of our
devices to one. (4) Review what is exposed to Assist in HA. (5) Pick the doorbell and energy sensors, or skip them.

## 11. Native tools and dependencies

| Need | Where | When missing |
|---|---|---|
| A Home Assistant instance on the LAN, the `network: "lan"` requirement | server → HA | Module `error` at start (today); after that, each action says "I can't reach Home Assistant right now, so I couldn't switch the lights." |
| A WebSocket client | server | Node 22 has a global `WebSocket` (stable since Node 22.4, from memory, unverified), so no package is needed |
| A vision-capable model, for `describe` | the assistant's LLM, or a separate model setting | "I can show you the camera, but I can't describe pictures with this assistant's model." |
| An MQTT broker (Mosquitto), only to expose our devices to HA | the owner's LAN | That feature is `unavailable` with "Exposing devices to Home Assistant needs an MQTT broker." |

**Exposing our own devices to HA** (honest feasibility):

- **MQTT discovery: feasible, M.** HA's MQTT discovery supports `notify`, `sensor`, `binary_sensor`, `button`,
  `select`, `event` and more, but **not `media_player` and not `assist_satellite`**
  ([MQTT platforms](https://www.home-assistant.io/integrations/mqtt/)). Each of our devices could publish
  `homeassistant/notify/pva_kitchen/config` (HA automations then "announce on the kitchen speaker"), a `sensor` for
  idle, listening or speaking, a `binary_sensor` "recently used" as a presence hint, and a `button` for stop.
- **Our own MCP server for HA's MCP client: feasible, S–M after module definition §A.5's server direction.** HA's
  [`mcp` integration](https://www.home-assistant.io/integrations/mcp/) speaks Streamable HTTP (with an SSE fallback),
  supports only tools, refreshes the list every 30 minutes, and gives the tools to HA's conversation agents, not to
  automations (unverified, as the docs only describe agents).
- **A custom HA integration (Python, HACS) with real `media_player` or `assist_satellite` entities: L.** It lives in a
  second repository, and HA changes break it. Skip.

**Recommendation:** MQTT `notify` plus a state `sensor` first, if the owner runs Mosquitto.

## 12. Interaction with the rest of the system

- **Voice.** Entity names are proper nouns that speech recognition mangles ("Hue Go" → "who go"; Dutch room names
  inside English sentences). Feed area and entity names and aliases into the recogniser's hot words where the provider
  supports it (docs/research/stt-quality.md). Numbers: "twenty-one and a half", "half" → 50 %, "a bit warmer" → +1 °C
  (owner-settable step), parsed by core's `ValueParsing`, not the model.
- **Fillers.** Every control action is under 300 ms, so none is needed. `camera_snapshot` with `describe` gets a
  lead-in ("let me look").
- **Interruption.** Barge-in interrupts the turn, but a service call already sent is not undone. The action's `say`
  is still committed to the history, so "did it turn off?" gets a true answer.
- **Fast path.** The actions' `examples` feed Jev and the keyword decider (BUILT, NOT WIRED). Lights, switches,
  scenes, climate and covers are the strongest case for wiring Jev, because Alexa+ and Gemini made exactly these slow
  (landscape-voice-assistants.md §16.1).
- **Character.** For a cue-only confirmation the character gives a small nod or flash (an `ack` activity, a
  `turn.activity` extension, docs/CHARACTERS.md §5.2, DESIGNED-ONLY).
- **Assistants.** No template: smart home belongs on every household assistant ("Jeff", "Keuken"). It stays off on
  the coding assistant ("T3"). A children's assistant gets `domains` without locks, alarms and cameras.
- **Other modules.** The timers module rings with an HA light flash if asked (later). The notification service uses
  `presence`. Music uses the same Connection for `media_player`. `briefing` reads `energy_today` and `lock_status`.

## 13. Privacy and safety

- **Risk policy.** Household default (module definition §B.5): `read: allow`, `change: allow`, `security: deny`.
  `security` covers `lock_unlock`, `lock.open`, `alarm_disarm`, and `cover_set` on garage, door and gate covers.
  Turning these on needs both the household ceiling and a device with `allowRisky`. Even then it means `confirm`,
  which today is the literal `"off"`, so core refuses the action ("Not run: this action needs the owner's
  confirmation", `Actions.ts:378`). That is the right behaviour until confirmations return.
- **Codes.** An alarm or lock `code` is never taken by voice by default: a TV can say it, and anyone in the room hears
  it (landscape-launchers-and-agent-tools.md §6.9). If the owner wants a spoken PIN, it is its own setting, compared in
  the server, never sent to the model, and redacted from transcripts and traces.
- **Exposure.** `useExposure` on means the assistant can never see more than HA's Assist exposure. The admin token
  could see everything, so the module filters, not HA. That is a code-level guarantee to test.
- **Personal data.** Presence, cameras and history are `personal`. On `shared` and `public` devices they are not shown
  (presentation §6.1 rule 4). Presence is answered at room level ("someone is home") on a `public` device, and the
  front-door node never says who is out.
- **Guests and children.** Lights, scenes and climate are allowed. Locks, alarms, cameras and presence are not. With
  no identity (shared state §4.6) this is a per-device and per-assistant setting, not per person.
- **Camera images to a hosted model** leave the house. Describing is off by default and opt-in per camera
  (Open question 4).

## 14. Foundations needed

| Foundation | For |
|---|---|
| Tool context (`CurrentTurn.deviceId`, `room`) | `here`, which is the single most valuable change |
| Device capabilities and `DevicePlace.room` / privacy | mapping devices to areas, and the personal-content rules |
| Risk classes and confirmations switched on (module definition §B.5) | ever allowing `security` actions |
| Event bus and Notification service | the doorbell, leaks, watches |
| Module store | watches |
| Scheduler | delayed commands |
| Presentation (`image`, `facts`, `chart`, `list`) and the `/media/` proxy | cameras and energy on screens |
| Connection | sharing HA with music and notify |
| Requirements and health | "HA reachable", "token is admin", "MQTT broker present" checks |

**A useful first version without any of them:** the WebSocket cache and `call_service`, the extra domains and actions
in §4 (`switch_*`, `scene_activate`, `script_run`, `climate_set`, `cover_set` for non-security covers, `lock_status`,
`lock_lock`, `who_is_home`), the exposure filter, and HA entity aliases. Rooms must be named ("kitchen lights off").
`lock_unlock` and `alarm_disarm` are defined with `confirm: true`, so they are refused, and the refusal is honest.
Effort: M.

## 15. Open questions

1. **Room list.** Should HA areas *be* the household room list when HA is connected, with each device picking one?
   Or should we keep our own list and map it to areas? (Shared state open question 7.) Default here: HA areas, and our
   own list only without HA.
2. **Typed actions or MCP.** landscape-automation-platforms.md §1.5 suggests connecting to `/api/mcp/assist` "instead
   of hand-writing one adapter per HA domain". I disagree for the common domains: MCP loses the device's area, cannot
   run on the fast path, and costs prefix tokens. Is the hybrid in §5 acceptable, with MCP opt-in for the long tail?
3. **Security by voice at all.** Should unlock, disarm and garage open ever be possible by voice, and only on which
   trusted devices? Or should they stay app-only for good?
4. **Cameras.** May snapshots go to a hosted vision model when you ask "who is at the door"? Or should they be
   described only by a local model (none is planned), or never?
5. **Admin token.** The module needs an HA admin user for templates and `subscribe_trigger`, which can see and do
   everything. Is a dedicated HA admin user "Voice assistant" acceptable, filtered by exposure on our side? Or should
   we drop the features that need admin?
6. **Exposing our devices to HA.** Do you run Mosquitto, and do you want HA automations to speak on our devices
   (MQTT `notify`)? Or is our own rule list (§7) enough?
7. **Proactive defaults.** Should leak, smoke and CO be on as `critical` by default, and should the doorbell ring on
   every screen or only near the door?
8. **Households without HA.** Is "use Home Assistant" an acceptable answer, with a Zigbee2MQTT provider only on
   request and no Matter?
