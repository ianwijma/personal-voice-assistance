# Smart home (`home-assistant`)

Lights, switches, climate and covers through the owner's Home Assistant, and the `HomeAssistant` transport for other modules.

- Package: `packages/module-home-assistant` (existing; its pull request may change all of it)
- Plan: [docs/MODULES-PLAN.md](../MODULES-PLAN.md) §5.1 row 9 (wave A)
- Research: [docs/research/modules/smart-home.md](../research/modules/smart-home.md)
- How to write it: [docs/MODULES.md](../MODULES.md)

An existing module, rewritten by the smart-home pull request, which touches all of `packages/module-home-assistant/` and this page
(docs/MODULES.md, "What a module pull request may touch").

## What it does

The assistant sees and switches the house through the owner's Home Assistant: lights, switches (and fans and on/off
helpers), heating, and blinds, curtains, shades, shutters and awnings, by room, by name, everywhere, or **here** (the
room of the device that is asked, `CurrentTurn.room`, matched to a Home Assistant area by its name, id or the owner's
other names). It reads the state of everything it knows, locks, alarm panels, garage doors and other covers included.
**This version does nothing of the security kind, by construction**: it never changes a lock or an alarm panel, never
moves a cover that is not of a blind class, runs no script, and runs a scene only when everything the scene sets is
something it would change itself. So no action has a risk function: every changing action is plain `change`.

It is off by default (module API v2). **While it is off it contacts nothing, configured or not, its health check
included**; the Test button on its page is the owner's explicit way to try a connection then.

How it works:

- **One client and one cache for every assistant**, in the module's `shared` part. Every request goes through
  `@pva/net`'s `fetchOwnerConfiguredLan` (docs/MODULES.md §12): `GET /api/config` (the token, the version, the
  installation's temperature unit), and a JSON `POST` for each page of the house (`/api/template`, admin only) and for
  each service call. No redirect is followed (a redirect answer is a failure), loopback is reached only as the owner
  typed it (`http://localhost:8123` and `http://127.0.0.1:8123` work; the address reaches the helper as the owner wrote
  it, tidied only as text, so `http://127.1:8123`, `http://2130706433:8123` and `http://0x7f000001:8123` are refused,
  at the start, by the Test button and by health alike), the answer must be JSON or text, and each call has its own
  byte limit and time limit.
- **The house is read in pages** (see "How large a house"): at the start, then every minute in the background, off the
  turn path. Commands resolve their target from the cache; questions (`lights_status`, `climate_status`,
  `locks_status`, `home_state`) read the house again at once, at most 3 s. Reads do not wait for each other; a read
  that a newer one overtook answers with what was kept (the newer house, or the newer failure), never with its own
  older outcome. **One read, one result**: the configuration a read fetched (the temperature unit) stays that read's,
  and is kept together with its house and names under the one order check; a read that was overtaken, or whose house
  failed, changes nothing.
- **A refused token or a user who is not an administrator** is a start error (only the owner can fix it). An
  **unreachable, slow or garbled** Home Assistant is not: the module runs, its status line says so, every command
  answers "I couldn't reach Home Assistant.", and the next background read picks it up again.
- **What it offers follows the house**: an action is offered when the assistant uses its kind (`domains`) and the house
  has one it acts on; when the house gains a kind (a first thermostat), or a list of names outgrows what one choice
  list carries, the module starts again. A kind that disappears restarts nothing.
- **Every service call names its entities by id** (never an area), at most 50 per call, all in parallel, each within
  3 s, so an action keeps within its 5 s. The module's own actions and the `HomeAssistant` service's consumers take
  **one checked path** (`src/service.ts`).
- **A POST is sent once.** "Nothing was sent" only when the network helper says the connection failed before a byte
  left: then "I couldn't reach Home Assistant." An answer of 400, 401, 403 or 404 is a definite failure (Home Assistant
  refuses these before it acts). **Everything else after the request left** (any other status, such as a 500 after
  one entity changed and another failed; an answer of the wrong type or encoding, a redirect, one cut off or too large
  to read on a command; a time limit) is "I sent it to Home Assistant but couldn't confirm that it happened; it may or
  may not have.", and it is never sent again.
- **How fresh things are.** This version polls: the cache is what Home Assistant said at the last read, at most about
  a minute old. A change in the house reaches a subscriber of the service at the next poll.

## How large a house

The supported house is **2,000 entities** (people, devices and sensors of the kinds the module reads; scenes apart).
It is read in pages, in this order: the areas (pages of their own, at most 200 a page), the people, the kinds the
service exposes (the shared `domains`), the module's other kinds, then every scene the owner named (pages after the
last one seen, until each was examined, none twice). Each text is cut by Home Assistant in the template itself: a name
or media title at 80 characters plus the longest configured secret form (so a secret that starts inside the 80 is seen
whole; the module then cuts to 80), a state at 256; a device class over 32 characters or a unit over 16 is left out,
HVAC and colour modes are filtered to Home Assistant's own, a number is kept only when it is plain, and control
characters become spaces.

**Page sizes, from Home Assistant's own limit.** Home Assistant renders at most 262,144 characters of template output
(more is HTTP 400 "Template output exceeded maximum size"). The worst legal row, every text at its cut and every
character of it escaped to two, every number at Python's longest, counted as Python's `json.dumps` writes it (an upper
bound of Home Assistant's `to_json`), is **1,754 + 6 × keep** characters for an entity (`keep` = 80 + the longest
secret form + 1), **281 + 2 × keep** for an area, and an entity row plus **101 × 607** for a scene (its members, each
an id of 256 and a class of 32). A page asks for (262,144 − 1,024) ÷ the worst row rows, at most 200: with a token of 24
characters (keep 113) that is 107 entities, 4 scenes and 200 areas a page; with no secret, 116 entities. The
arithmetic is in `src/house.ts` (`worstRow`) and `test/house.test.ts` renders the worst legal page and checks it.
Home Assistant's exact "exceeded maximum size" answer is still recognised and the page asked again in eighths; no other
400 is. The reader takes at most 1 MiB + 64 KiB of one answer (the limit at four bytes a character); the worst such
page parses in at most 1.0 ms. The names of each target are indexed fifty at a time, with a real yield between steps,
together with every key a request is looked up by (exact, sound-alike, one edit away, each run of words), and the new
house, its names and its configuration are published in one step.

Measured on the development machine (Node 22), with the shared bound of the latency tests (`test/latency.test.ts`;
10 ms, three times that on CI):

- a poll of the largest supported house (2,000 entities, two polls in a row, the second changing every one) holds the
  main thread **3.5–4.0 ms at most** (16.2 ms before the names were indexed in steps);
- resolving the five-word request "turn on the kitchen lights" among 2,000 lights with names of 80 characters holds it
  **0.8–0.9 ms** through the action and **1.4–1.5 ms** through the tool, the whole call included; the lookup itself
  takes at most 0.09 ms (it was 91–100 ms when every request passed over all the names).

**A house with more is incomplete**, and every answer that depends on the whole list says so: "all the lights" is
refused with a question for a room ("Your house has more devices than I can read, so I can't reach all the lights.
Which room do you mean?"), a room's lights are "the lights I know of in Kitchen", `lights_status`, `locks_status` and
`home_state` say there may be more, the status line says "incomplete", and nothing states a total it did not count.
**It never says "none"** for a room or the whole house where the kind was read in part: "I couldn't read every device
in your house, so I can't tell whether there are lights in Kitchen.", for the status questions and the commands alike;
a room asked for by name still stays that room.

## Tools

Every action is also a tool for the model (`home-assistant_<id>`), and runs without the model from its examples.
Targets are a room, a device's name or id, "all …", or nothing (here). Risk: `change` unless said otherwise.

| Action / tool | Parameters | Example | Says |
|---|---|---|---|
| `lights_on` | `target` | "turn on the kitchen lights", "licht aan" | "I've turned on the lights in Kitchen." |
| `lights_off` | `target` | "lights off", "doe het licht uit in de keuken" | "I've turned off the lights in Kitchen." |
| `set_brightness` | `target`, `level` 0–100 | "dim the living room to 30 percent" | "I've set the lights in Living room to 30 percent." |
| `lights_status` (read) | – | "which lights are on" | "Ceiling and Kitchen light are on." / "None of the lights I could read is on. 2 lights could not be read." |
| `switches_on` / `switches_off` | `target` (switch, fan, `input_boolean`) | "turn on the coffee machine", "zet de ventilator uit" | "I've turned on Coffee machine." |
| `climate_set` | `target`, `temperature` (5–35 °C, or 41–95 °F in an imperial household) | "make it 21 degrees in here" | "I've set the heating in Living room to 21 degrees; it's 18.5 degrees now." |
| `climate_mode` | `target`, `mode` (heat, cool, automatic, off) | "turn the heating off" | "I've set the heating in Living room to off." |
| `climate_status` (read) | `room` (default here; the whole house only when the device has no room that is an area) | "how warm is it in here" | "Kitchen temperature is 21.3 degrees." / "There's no temperature reading in Hall." |
| `covers_open` / `covers_close` / `covers_stop` | `target` (blinds only) | "close the blinds", "doe de zonwering dicht" | "I'm closing the blinds in Living room." |
| `cover_position` | `target`, `position` 0–100 | "set the blinds to half" | "I'm setting Living room blinds to 30 percent open." |
| `scene_activate` | `scene` (the ones the owner named) | "movie time", "zet filmavond aan" | "I've started Movie time." / "I don't start Unlock house: it sets something I don't change by voice, …" |
| `locks_status` (read) | – | "is the front door locked" | "Alarm is disarmed, Garage door is closed and Front door is locked." |
| `home_state` (tool, read) | `area?` (a name or "here"), `kind?` | – | At most 8 devices with their state and how many more, marked as outside content |

**Covers.** Only covers whose Home Assistant class is `awning`, `blind`, `curtain`, `shade` or `shutter` are moved.
Every other cover (a garage door, a gate, a door, a window, a damper, a class this module does not know, and a cover
**without** a class) is left out of the targets, of "here", of "all blinds" and of the rooms, and the service refuses it
by id. A speaker in the garage asked to "open it" hears "There are no blinds in Garage that I may use." These covers
are still read (`locks_status`, `home_state`, the service's state). The form's "Rooms and devices" line says how many
covers have no class. **To give a blind its class** in Home Assistant: Settings → Devices & services → Entities, open
the cover, its settings (the gear), and choose Blind, Curtain, Shade, Shutter or Awning under "Show as".

**Scenes** run only when the owner named them under "Other names" by their id (`scene.movie_time: movie time`) **and**
Home Assistant's own state of the scene lists the entities it sets **and** every one is a light, one of the five cover
classes, a thermostat or a media player. A scene with no list, or with anything else in it (a lock, an alarm panel, a
garage door, a gate, a switch), is not offered and is refused by name or id with the reason. **Scripts are not run**:
what a script does cannot be seen from outside it (see "What was left out").

**A switch does whatever is wired to it.** The module cannot see what a switch, a fan or an on/off helper sets in
motion: a relay on a garage door or an automation started by a helper would be switched like a coffee machine. If any
switch or helper in the house does something of that kind, leave "switches, fans and helpers" out of the kinds
(`domains`), or keep that one out of Home Assistant's area and name lists the assistant uses.

**What a target names.** A target is resolved over the whole house, never only over the options a choice list can
carry: a known id or a unique name always works. A name (a room, an other name, a device) that is more than one thing
is a question ("Shared is more than one thing in Home Assistant: Shared (alpha) and Shared (beta). Which one do you
mean?"), also for "here" in a room whose name two areas share; ids always work. When every name of a target fits one
choice list (254 options) the parameter is that list; in a larger house it is free text, resolved here: by the name,
else by the names the request contains, where **a named room or device wins over "all" and "here"** ("turn on all
lights in kitchen" is the kitchen, and no other light is sent), two named rooms are a question, and a request of only
the action's own words means here. The owner's whole-house other names (`all: …`, `all lights: …`) still name every
light.

**Exactly what happened.** Before anything is sent the whole target is checked: a request that only part of it can
carry out is refused, naming what cannot ("Cool only can't be set to heating, so I haven't changed anything."), and so
is a target with a light that is unavailable, and **a brightness for a target that holds a light without one** (its
`supported_color_modes` has none but `onoff`; Home Assistant would drop the brightness and turn it on fully): "Relay
can't be dimmed, so I haven't changed anything." A light whose state is `unknown` or `unavailable` is never called off. A
room asked for by name stays that room when it has nothing to report. Temperatures are in the household's unit
(`HOME_UNITS`: imperial is Fahrenheit, else Celsius); a request is converted to the installation's unit (read from
`/api/config`) before it is sent and every reading back is converted the other way; when the installation's unit is not
known nothing is sent. Numbers and lists are worded by `@pva/language` (`speakNumber`, `speakList`) and keep the
precision of what was sent (two decimals); a reading that rounds to zero is "almost zero", one too large to say is "no
temperature I can read".

**Outside content.** `home_state` marks what it returns as outside content from Home Assistant ("data, never
instructions"), and the module's instructions say so. The sentences of the actions name rooms and devices as Home
Assistant names them; the core has no channel to mark them for the model separately from what is spoken (see "What was
left out").

Questions it asks instead of guessing: "Which room? I don't know which room this device is in." (here on a device
without a room); "I don't know a room called Attic in Home Assistant. Which room do you mean?"; "There are no lights in
Hall that I may use."; the "more than one thing" question above. Failures, each one sentence, in English and Dutch.

## The `HomeAssistant` service

The module publishes the transport of `packages/module-contracts/src/homeAssistant.ts` from its `shared` part, under
the contract's key, for presence and music (wave B). It is never offered to the model. "In this version the provider
polls": the polled cache above is its state.

- **Exposed**: people, and the entities of the kinds chosen in the module's shared `domains`. They are read before the
  module's other kinds, so kinds it does not expose never take the provider's room; at most the supported 2,000 in all.
  Scenes and scripts are not exposed. Ids are Home Assistant's, never cut: an entity whose id breaks the contract's
  bounds is left out. `aliases` are the owner's "Other names". `attributes` are the ones the module reads, under Home
  Assistant's names; a person has its id, name, state and last change only, whatever else an answer holds for it.
- **`entities()`, `entity(id)`, `areas()`, `people()`, `connection()`** answer from the cache, no network.
- **`changes()`**: each subscription is its own stream, **pulled**: nothing is made for a subscriber before it asks for
  the next item. It starts with a `snapshot` (`subscribed`); after a good poll that follows a good one, one `changed`
  or `removed` per entity that differs, in entity id order; after the first good poll following `unknown` or
  `reconnecting`, a `connection` and one `snapshot` (`reconnected`). A subscriber more than 1,000 changes behind loses
  every change it has not read and next reads a `snapshot` (`overflow`) of the cache at that moment. A stream ends when
  the consumer's scope or the module's part closes (the provider forgets it at once).
- **`callService`**: entity ids only (`target.entityIds`, 1 to 50), and **only the services of the table below**
  ("The services a call may name"), on entities of the service's own domain that are exposed (a scene: one that passes
  the scene rule), with only that service's data fields, each a plain value in its range. Anything else is `refused`
  before anything is sent: every integration's own services (`zwave_js.invoke_cc_api`, `mqtt.publish`,
  `homeassistant.*`, `script.*`, `automation.*`, `shell_command.*`, `rest_command.*`, `notify.*`, …), a field not in
  the table (an entity, device, area, floor or label id among them), a nested value, a target of another domain, any
  cover that is not of a blind class, a brightness for a light without one. `unknown_entity` for an id that is not
  exposed; `invalid` for a value out of its range or a required field missing. `not_connected` at once while the last
  poll failed, and when the request was not sent (the connection failed before a byte left); `failed` for an answer of
  400, 401, 403 or 404; `timeout` for everything else after the request left (it may or may not have happened; never
  sent again). With `returnResponse` (only `media_player.browse_media`): at most 16,000 characters of JSON, else
  `responseCut`; a successful answer too large to read at all is `responseCut` too, and so is one any of whose decoded
  keys or strings holds a configured secret in any of its forms.
- **When the module stops**: the service is gone, every stream ends, and the old object's methods throw
  `ModuleStopped`. After a start it is a new object.

### The services a call may name

The one table (`src/services.ts`), for a consumer's calls and the module's own actions alike. The target entities must
be of the domain given; data may hold only the fields listed, each a plain value.

| Service | Targets | Data fields |
|---|---|---|
| `light.turn_on` | lights | `brightness_pct` 0–100 (only lights that can be dimmed) |
| `light.turn_off`, `light.toggle` | lights | – |
| `switch.turn_on`, `switch.turn_off`, `switch.toggle` | switches | – |
| `fan.turn_on`, `fan.turn_off`, `fan.toggle` | fans | – |
| `input_boolean.turn_on`, `input_boolean.turn_off`, `input_boolean.toggle` | on/off helpers | – |
| `cover.open_cover`, `cover.close_cover`, `cover.stop_cover` | covers of a blind class | – |
| `cover.set_cover_position` | covers of a blind class | `position` 0–100, whole, required |
| `climate.set_temperature` | thermostats | `temperature` −100–1,000 (the installation's unit), required |
| `climate.set_hvac_mode` | thermostats | `hvac_mode` one of `off`, `heat`, `cool`, `heat_cool`, `auto`, `dry`, `fan_only`, required |
| `media_player.media_play`, `media_pause`, `media_play_pause`, `media_stop`, `media_next_track`, `media_previous_track`, `volume_up`, `volume_down` | media players | – |
| `media_player.media_seek` | media players | `seek_position` 0–86,400 s, required |
| `media_player.volume_set` | media players | `volume_level` 0–1, required |
| `media_player.volume_mute` | media players | `is_volume_muted` true or false, required |
| `media_player.select_source` | media players | `source` text of at most 200, required |
| `media_player.shuffle_set` | media players | `shuffle` true or false, required |
| `media_player.repeat_set` | media players | `repeat` `off`, `all` or `one`, required |
| `media_player.play_media` | media players | `media_content_id` text of at most 2,000 and `media_content_type` text of at most 100, required; `enqueue` `play`, `next`, `add` or `replace`; `announce` true or false |
| `media_player.browse_media` (with `returnResponse`) | media players | `media_content_id` text of at most 2,000; `media_content_type` text of at most 100 |
| `scene.turn_on` | scenes that pass the scene rule | – |

## Settings

The fields, their keys and their order are the ones an owner already has; saved values keep working.

| Key | Kind | Default | Notes |
|---|---|---|---|
| `baseUrl` | text, env `HOME_ASSISTANT_URL` | empty (start error) | http(s) only; an address with a user name, a password or a query is refused without repeating it; `http://localhost:8123` works |
| `token` | secret, env `HOME_ASSISTANT_TOKEN`, required | | a long-lived token of an administrator (the template API is admin only) |
| `domains` | multichoice, **overridable** | every kind | lights; switches, fans and helpers; heating; blinds (other covers only read); media players (only read); temperature, humidity, door and window sensors (only read); locks and alarm panels (only read). An assistant may use fewer. An old saved value (`["light"]`) is still valid |
| `aliases` | text | empty | "Other names": one line per room, device or scene (`Living room: lounge, woonkamer`); `all: …` and `all lights: …` name every light. A scene is offered only with a line under its own id. A line under a script's id is still valid and is ignored (the form says so) |
| `timeoutMs` | number, advanced | 2000 | 300–10,000 ms per request; a command waits at most 3 s, a start request at most 4 s |
| `server`, `lists` | info | | where it is connected; what it read: counts, covers without a class, scenes that can and cannot be started, scripts ignored, incomplete, entities left out |
| `test` | button | | the config and one read of the house, with the address in the form (saved or not) |

## What it stores

Nothing in the household store: no collection, no job. The cache of the house is in memory and is read again at each
start. The template reads only the kinds above, no script, `device_tracker`, `zone` or camera, and only sensors of a
named class. A sensor without a class is never read, because Home Assistant's companion app makes classless sensors
that say where a phone is.

**Nothing that holds a configured secret is kept.** The configured token and the secret parts of the address are
looked for in every form a successful answer could carry them in: as written, percent-encoded, base64 and base64url
(padded or not). They are compared with decoded text (every key and string, after the JSON is read, so an escaped
quote in the answer is no disguise). After a successful read, an entity or an area any of whose texts (name, state,
attributes, a media title) holds one is left out whole and counted in the form, and a configuration whose location
name or version holds one is not shown; nothing is rewritten in place and no generic pattern is applied to names
("Basic Bedroom" stays). Home Assistant cuts each name at 80 plus the longest form, so a form that starts inside what
is kept is always seen whole. A service answer any of whose decoded keys or strings holds one is cut (`responseCut`).

**People are read for other modules only.** Each `person` entity is read with its id, name, state and last change,
nothing else, kept in memory, and handed to the `HomeAssistant` service's consumers as the contract says. The module's
own tools and actions never read, mention or count a person.

## What it needs

- `requires: [{ network: "lan" }]`: the owner's Home Assistant on the network, with an administrator's long-lived
  token. `@pva/net` (`fetchOwnerConfiguredLan`, GET and JSON POST).
- `health`: while it runs, no address, no token, `GET /api/config` unreachable, the token refused, the user not an
  administrator. Nothing, and no request, while it is off.
- `uses`: none. Provides: the `HomeAssistant` service (above). Consumes: no service.

## What was left out

**Cut from this version, and what brings them back:**

- **Scripts**: no script action, no script tool, no script through the service. What a script does cannot be seen
  from outside it, so a script could do something of the security kind. A saved "Other names" line under a script's id
  stays valid and is ignored. They come with the risk policy in admin (wave B), where the owner can allow one.
- **Changing security devices** (locks, alarm panels, garage doors, gates, doors, and covers without a blind class):
  only read. They come with the risk policy in admin and authenticated devices.

**Later (the network helpers have no WebSocket yet; this version polls):** the WebSocket entity cache, with Home
Assistant's registries, its area and entity aliases and its list of what is exposed to Assist. Until then every device
of a chosen kind is used, by the module's actions and by the service's consumers: the owner narrows it with `domains`.

**Missing below the module** (reported, not built here): the core gives an action's generated tool no way to mark Home
Assistant's names as outside content for the model apart from the sentence that is spoken (`ActionOutcome` is `say`
only); `@pva/net`'s `NetTooLarge` does not say the status of an answer it did not read, so a service answer too large
to read is taken as Home Assistant's success (its error answers are short).

**A connection instead of the module's secret fields**: connections are deferred (P8). **Hiding single entities and
choosing scenes from a list**: a new settings field would change the form the app's serve test pins; scenes are chosen
through "Other names".

**Left out for wave B** (phrase commands, presentations, notifications and a module's own speech do not exist yet):
the short cue instead of words for a command in the device's own room; a `facts` card for climate and a `list` of what
is on in a room; doorbell, leak and smoke notifications.

**Left for later by the plan:** locking, unlocking, arming and disarming; watches; cameras; energy; delayed commands;
media player control (music's, over the `HomeAssistant` service); the MCP long tail.
